import * as vscode from 'vscode';
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';
import { spawn } from 'child_process';
import { MARKDOWN_EXTENSIONS, isMarkdownPath, resolveClipboardCandidates } from './openPath';
import { assetsFolderName, sanitizeImageFileName, dedupeFileName, relativeAssetPath, isImageFileName } from './imageAssets';
import { ApplyingTracker } from './applyingTracker';
import { openFullDiff, resolveBaseForDocument } from './diffViewer';
import { assessWrite } from './saveGuard';
import { inlineImagesAsDataUris } from './exportInline';

const CHROME_PATHS: Record<NodeJS.Platform, string[]> = {
  darwin: [
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
    '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
    '/Applications/Arc.app/Contents/MacOS/Arc',
  ],
  linux: [
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    '/usr/bin/microsoft-edge',
    '/usr/bin/brave-browser',
  ],
  win32: [
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\BraveSoftware\\Brave-Browser\\Application\\brave.exe',
  ],
  aix: [], freebsd: [], openbsd: [], sunos: [], android: [], haiku: [], cygwin: [], netbsd: [],
};

function findChromiumBinary(): string | null {
  const candidates = CHROME_PATHS[os.platform()] ?? [];
  for (const p of candidates) {
    try {
      fs.accessSync(p, fs.constants.X_OK);
      return p;
    } catch { /* try next */ }
  }
  return null;
}

function renderHtmlToPdf(chromePath: string, htmlPath: string, pdfPath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    // A throwaway, unique --user-data-dir is essential: modern Chrome maps
    // --headless to "new headless", which otherwise shares the user's default
    // profile. If Chrome is already running (the common case), that profile is
    // locked and the headless launch fails to render — the classic "export PDF
    // does nothing" bug. A private profile dir sidesteps the lock entirely.
    const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), 'md-editor-plus-chrome-'));
    const proc = spawn(chromePath, [
      '--headless',
      `--user-data-dir=${profileDir}`,
      '--disable-gpu',
      '--no-sandbox',
      '--no-pdf-header-footer',
      '--virtual-time-budget=2000',
      `--print-to-pdf=${pdfPath}`,
      `file://${htmlPath}`,
    ], { stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    proc.stderr?.on('data', (d) => { stderr += d.toString(); });
    const cleanup = () => { try { fs.rmSync(profileDir, { recursive: true, force: true }); } catch { /* ignore */ } };
    proc.on('error', (err) => { cleanup(); reject(err); });
    proc.on('close', (code) => {
      cleanup();
      if (code === 0) resolve();
      else reject(new Error(`Chrome exited with code ${code}: ${stderr.slice(0, 400)}`));
    });
  });
}

// Rewrite document-relative <img> sources in exported HTML to self-contained
// data: URIs by reading the bytes from disk (relative to the document's folder).
// Keeps HTML/PDF exports portable — webview-resource URIs would 404 outside VS Code.
function inlineExportImages(document: vscode.TextDocument, html: string): Promise<string> {
  return inlineImagesAsDataUris(html, async (relPath) => {
    if (/^(?:https?:|data:|\/\/)/i.test(relPath)) return null;
    if (!document.uri.scheme.startsWith('file')) return null;
    try {
      const clean = relPath.replace(/^\.\//, '');
      const docDir = vscode.Uri.joinPath(document.uri, '..');
      return await vscode.workspace.fs.readFile(vscode.Uri.joinPath(docDir, clean));
    } catch {
      return null;
    }
  });
}

export class MdEditorPlusProvider implements vscode.CustomTextEditorProvider {
  private static readonly viewType = 'md-editor-plus-lifeos.editor';
  // Per-document echo suppression. Must NOT be a single shared flag: with
  // multiple editors open, one document's applyEdit completing would otherwise
  // clear suppression for another still mid-apply, leaking an echo update.
  private readonly _applying = new ApplyingTracker();

  constructor(
    private readonly _extensionUri: vscode.Uri,
    private readonly _context: vscode.ExtensionContext,
  ) {}

  public static register(context: vscode.ExtensionContext): vscode.Disposable {
    const provider = new MdEditorPlusProvider(context.extensionUri, context);
    return vscode.window.registerCustomEditorProvider(
      MdEditorPlusProvider.viewType,
      provider,
      {
        webviewOptions: { retainContextWhenHidden: true },
        supportsMultipleEditorsPerDocument: false,
      }
    );
  }

  async resolveCustomTextEditor(
    document: vscode.TextDocument,
    webviewPanel: vscode.WebviewPanel,
    _token: vscode.CancellationToken
  ): Promise<void> {
    // Snapshot of the file's content when this editor opened — the fallback base
    // for the full diff viewer (c24) when the file isn't git-tracked.
    const openSnapshot = document.getText();
    const docDir = vscode.Uri.joinPath(document.uri, '..');
    const wsFolder = vscode.workspace.getWorkspaceFolder(document.uri);
    const localResourceRoots: vscode.Uri[] = [
      vscode.Uri.joinPath(this._extensionUri, 'dist'),
      docDir,
    ];
    if (wsFolder) localResourceRoots.push(wsFolder.uri);

    webviewPanel.webview.options = {
      enableScripts: true,
      localResourceRoots,
    };

    webviewPanel.webview.html = this._getHtml(webviewPanel.webview, document);

    const mediaBaseUri = webviewPanel.webview.asWebviewUri(docDir).toString().replace(/\/?$/, '/');

    const AUTO_SAVE_MS = 1000;
    let autoSaveTimer: ReturnType<typeof setTimeout> | null = null;
    let conflictPaused = false;
    let pendingFlash = false;

    const postSaveState = (state: 'saving' | 'saved' | 'failed', flash = false): void => {
      void webviewPanel.webview.postMessage({ type: 'saveState', state, flash });
    };

    const cancelAutoSave = (): void => {
      if (autoSaveTimer) { clearTimeout(autoSaveTimer); autoSaveTimer = null; }
    };

    // Re-assert the (untouched) document content into the webview after the save
    // guard refuses a catastrophic write, so the webview, host, and disk all
    // reconverge on the good content instead of silently diverging. Tagged as a
    // 'refresh' so the webview's sync guard re-renders it unconditionally.
    const resyncWebview = (): void => {
      void webviewPanel.webview.postMessage({
        type: 'update',
        markdown: document.getText(),
        source: 'refresh',
      });
    };

    // Writes the (already-applied, in-memory) document to disk. Gated on conflict:
    // while a conflict banner is up the webview suppresses edits AND pauses us, so
    // we never overwrite an external change with the user's un-reconciled version.
    // The 'saved' message is emitted by onDidSaveTextDocument (single source of
    // truth) so it can't race a duplicate; pendingFlash carries the Cmd+S pulse.
    const saveToDisk = async (flash = false): Promise<void> => {
      if (conflictPaused) return;
      // No disk write needed — emit 'saved' directly (onDidSaveTextDocument won't fire).
      // This is also exactly where the "Saved but not on disk" lie surfaces: if the
      // webview believes it has edits but the document is clean, those edits never
      // reached the host (Gap A) or were reverted (Gap B). Log it so a live repro
      // can confirm the document really was clean when we reported "saved".
      if (!document.isDirty) {
        console.warn('[md-editor-plus] saveToDisk: document NOT dirty → reporting "saved" with no write', {
          uri: document.uri.toString(),
          docChars: document.getText().length,
          flash,
        });
        postSaveState('saved', flash); return;
      }
      postSaveState('saving');
      // The single post-save 'saved' is emitted by onDidSaveTextDocument; hand it the flash.
      pendingFlash = flash;
      try {
        const ok = await document.save();
        if (!ok) { pendingFlash = false; postSaveState('failed'); return; }
        void sendDiffBase();
      } catch (err) {
        pendingFlash = false;
        console.error('[md-editor-plus] save failed', err);
        postSaveState('failed');
      }
    };

    const scheduleAutoSave = (): void => {
      cancelAutoSave();
      autoSaveTimer = setTimeout(() => { autoSaveTimer = null; void saveToDisk(); }, AUTO_SAVE_MS);
    };

    const sendInit = () => {
      const cfg = vscode.workspace.getConfiguration('mdEditorPlusLifeos');
      webviewPanel.webview.postMessage({
        type: 'init',
        markdown: document.getText(),
        mediaBaseUri,
        documentPath: vscode.workspace.asRelativePath(document.uri),
        workspaceName: vscode.workspace.getWorkspaceFolder(document.uri)?.name ?? null,
        defaults: {
          font:                cfg.get<string>('font', 'sans'),
          textSize:            cfg.get<string>('textSize', 'm'),
          pageWidth:           cfg.get<number>('pageWidth', 800),
          fullWidth:           cfg.get<boolean>('fullWidth', false),
          sourceFullWidth:     cfg.get<boolean>('sourceFullWidth', false),
          shortenCodeSnippets: cfg.get<boolean>('shortenCodeSnippets', false),
          smartTypography:     cfg.get<boolean>('smartTypography', true),
          outlineVisible:      cfg.get<boolean>('outlineVisible', false),
          structureMapVisible: cfg.get<boolean>('structureMapVisible', false),
          frontmatterVisible:  cfg.get<boolean>('frontmatterVisible', true),
          sourceWordWrap:      cfg.get<boolean>('sourceWordWrap', false),
        },
      });
      void sendDiffBase();
    };

    const sendDiffBase = async (): Promise<void> => {
      try {
        const base = await resolveBaseForDocument(document, openSnapshot);
        void webviewPanel.webview.postMessage({ type: 'diffBase', content: base.content, label: base.label });
      } catch {
        // base unavailable (no git, etc.) — the diff map simply shows nothing
      }
    };

    const openMarkdownInEditor = async (uri: vscode.Uri): Promise<void> => {
      if (!isMarkdownPath(uri.fsPath)) {
        await vscode.window.showErrorMessage("MD Editor Plus — Life OS: that doesn't look like a markdown file.");
        return;
      }
      await vscode.commands.executeCommand('vscode.openWith', uri, 'md-editor-plus-lifeos.editor');
    };

    const onDocChange = vscode.workspace.onDidChangeTextDocument((e) => {
      if (e.document.uri.toString() !== document.uri.toString()) return;
      if (this._applying.isApplying(document.uri.toString())) return;
      const text = document.getText();
      // Diagnostic for the empty-on-open data-loss bug: capture WHEN an empty
      // 'update' is about to be pushed to the webview, and what change caused it.
      // The webview-side guard now refuses to apply such an update over content;
      // this log lets us confirm the trigger (host edit vs external change).
      if (text.trim() === '') {
        console.warn('[md-editor-plus] onDidChangeTextDocument → posting EMPTY update', {
          uri: document.uri.toString(),
          isDirty: document.isDirty,
          changes: e.contentChanges.map((c) => ({
            insertedChars: c.text.length,
            removedRange: `${c.range.start.line}:${c.range.start.character}-${c.range.end.line}:${c.range.end.character}`,
          })),
          reason: e.reason,
        });
      }
      webviewPanel.webview.postMessage({
        type: 'update',
        markdown: text,
      });
    });

    const onDocSave = vscode.workspace.onDidSaveTextDocument((doc) => {
      if (doc.uri.toString() !== document.uri.toString()) return;
      // Sole emitter of the post-save 'saved'. Also covers saves triggered outside
      // this provider (native VS Code save, etc.), which correctly carry no flash.
      postSaveState('saved', pendingFlash);
      pendingFlash = false;
    });

    webviewPanel.webview.onDidReceiveMessage(async (msg: {
      type: string;
      markdown?: string;
      paused?: boolean;
      defaults?: {
        font?: string;
        textSize?: string;
        pageWidth?: number;
        fullWidth?: boolean;
        sourceFullWidth?: boolean;
        shortenCodeSnippets?: boolean;
        smartTypography?: boolean;
      };
    }) => {
      // Webview signals it has registered its message listener. Only now is it
      // safe to send 'init' — posting it earlier races the webview's load and
      // VS Code silently drops messages to a not-yet-listening webview, which
      // leaves the page blank. Fires once per webview load (and on reload).
      if (msg.type === 'ready') {
        sendInit();
        return;
      }
      if (msg.type === 'openFullDiff') {
        const m = msg as unknown as { baseContent?: string; baseLabel?: string; markdown?: string };
        // Pass the webview's live markdown straight into the diff's current side.
        // Do NOT flush it into the document first — that marked the file "modified"
        // even when nothing was edited (c56). The diff is a read-only preview; it
        // never needs to mutate the underlying document.
        await openFullDiff(
          this._context,
          document,
          { baseContent: m.baseContent, baseLabel: m.baseLabel, currentMarkdown: m.markdown },
          openSnapshot,
        );
        return;
      }
      if (msg.type === 'edit' && msg.markdown !== undefined) {
        const applied = await this._applyEdit(document, msg.markdown);
        if (!applied) { resyncWebview(); return; }
        scheduleAutoSave();
        return;
      }
      if (msg.type === 'save') {
        if (msg.markdown !== undefined) {
          const applied = await this._applyEdit(document, msg.markdown);
          if (!applied) { resyncWebview(); cancelAutoSave(); postSaveState('saved', true); return; }
        }
        cancelAutoSave();
        await saveToDisk(true);
        return;
      }
      if (msg.type === 'conflictPause') {
        conflictPaused = Boolean(msg.paused);
        if (conflictPaused) cancelAutoSave();
        return;
      }
      if (msg.type === 'saveDefaults' && msg.defaults) {
        const cfg = vscode.workspace.getConfiguration('mdEditorPlusLifeos');
        const target = vscode.ConfigurationTarget.Global;
        const d = msg.defaults;
        await Promise.all([
          cfg.update('font',                d.font,                target),
          cfg.update('textSize',            d.textSize,            target),
          cfg.update('pageWidth',           d.pageWidth,           target),
          cfg.update('fullWidth',           d.fullWidth,           target),
          cfg.update('sourceFullWidth',     d.sourceFullWidth,     target),
          cfg.update('shortenCodeSnippets', d.shortenCodeSnippets, target),
          cfg.update('smartTypography',     d.smartTypography,     target),
        ]);
        await vscode.window.showInformationMessage('MD Editor Plus — Life OS: current view saved as default');
      }
      if (msg.type === 'resetDefaults') {
        const cfg = vscode.workspace.getConfiguration('mdEditorPlusLifeos');
        const keys = ['font','textSize','pageWidth','fullWidth','sourceFullWidth','shortenCodeSnippets','smartTypography'];
        for (const k of keys) {
          // Clear at all scopes so the package.json defaults take over.
          await cfg.update(k, undefined, vscode.ConfigurationTarget.Global).then(() => {}, () => {});
          await cfg.update(k, undefined, vscode.ConfigurationTarget.Workspace).then(() => {}, () => {});
          await cfg.update(k, undefined, vscode.ConfigurationTarget.WorkspaceFolder).then(() => {}, () => {});
        }
        await vscode.window.showInformationMessage('MD Editor Plus — Life OS: defaults reset');
      }
      if (msg.type === 'openInFinder') {
        await vscode.commands.executeCommand('revealFileInOS', document.uri);
      }
      if (msg.type === 'openInVscodeEditor') {
        await vscode.commands.executeCommand('vscode.openWith', document.uri, 'default');
      }
      if (msg.type === 'openFromClipboard') {
        const raw = (await vscode.env.clipboard.readText()).trim();
        if (!raw) {
          await vscode.window.showErrorMessage('MD Editor Plus — Life OS: clipboard is empty.');
          return;
        }
        const docFolder = path.dirname(document.uri.fsPath);
        const ws = vscode.workspace.getWorkspaceFolder(document.uri);
        const candidates = resolveClipboardCandidates(raw, docFolder, ws?.uri.fsPath);
        let found: vscode.Uri | null = null;
        for (const c of candidates) {
          const uri = vscode.Uri.file(c);
          try {
            await vscode.workspace.fs.stat(uri);
            found = uri;
            break;
          } catch { /* try next candidate */ }
        }
        if (!found) {
          await vscode.window.showErrorMessage(`MD Editor Plus — Life OS: no file found at ${raw}`);
          return;
        }
        await openMarkdownInEditor(found);
        return;
      }
      if (msg.type === 'browseMarkdown') {
        const exts = MARKDOWN_EXTENSIONS.map((e) => e.replace(/^\./, ''));
        const files = await vscode.workspace.findFiles(
          `**/*.{${exts.join(',')}}`,
          '{**/node_modules/**,**/.git/**,**/dist/**}',
        );
        const BROWSE = '$(folder-opened) Browse on disk…';
        type Item = vscode.QuickPickItem & { uri?: vscode.Uri };
        const items: Item[] = [
          { label: BROWSE, alwaysShow: true },
          ...files
            .slice()
            .sort((a, b) => a.fsPath.localeCompare(b.fsPath))
            .map((uri) => ({
              label: path.basename(uri.fsPath),
              detail: vscode.workspace.asRelativePath(uri),
              uri,
            })),
        ];
        const pick = await vscode.window.showQuickPick(items, {
          title: 'Open Markdown File',
          placeHolder: 'Pick a markdown file, or browse on disk…',
          matchOnDetail: true,
        });
        if (!pick) return;
        if (!pick.uri) {
          const chosen = await vscode.window.showOpenDialog({
            canSelectFiles: true,
            canSelectFolders: false,
            canSelectMany: false,
            filters: { Markdown: exts },
            title: 'Open Markdown File',
            openLabel: 'Open',
          });
          if (chosen && chosen[0]) await openMarkdownInEditor(chosen[0]);
          return;
        }
        if (pick.uri) await openMarkdownInEditor(pick.uri);
        return;
      }
      if (msg.type === 'openExternal') {
        const url = (msg as unknown as { url?: unknown }).url;
        if (typeof url === 'string') {
          try { await vscode.env.openExternal(vscode.Uri.parse(url)); } catch { /* ignore */ }
        }
      }
      if (msg.type === 'copyContent') {
        await vscode.env.clipboard.writeText(document.getText());
        await vscode.window.showInformationMessage('Page content copied to clipboard');
      }
      if (msg.type === 'copyFilePath') {
        await vscode.env.clipboard.writeText(document.uri.fsPath);
        await vscode.window.showInformationMessage('File path copied to clipboard');
      }
      if (msg.type === 'copyText') {
        const { text, toast } = msg as unknown as { text?: unknown; toast?: unknown };
        if (typeof text !== 'string') return;
        await vscode.env.clipboard.writeText(text);
        const note = typeof toast === 'string' && toast.length > 0 ? toast : 'Copied to clipboard';
        await vscode.window.showInformationMessage(note);
        return;
      }
      if (msg.type === 'toast') {
        const note = (msg as unknown as { text?: unknown }).text;
        if (typeof note !== 'string' || note.length === 0) return;
        await vscode.window.showInformationMessage(note);
        return;
      }
      if (msg.type === 'installSkill') {
        const m = msg as unknown as { scope?: unknown; skillMd?: unknown };
        const skillMd = m.skillMd;
        if (typeof skillMd !== 'string') return;
        const scope = m.scope === 'global' ? 'global' : 'project';
        let baseDir: vscode.Uri;
        if (scope === 'global') {
          baseDir = vscode.Uri.file(path.join(os.homedir(), '.claude', 'skills'));
        } else {
          const ws = vscode.workspace.getWorkspaceFolder(document.uri);
          if (!ws) {
            await vscode.window.showErrorMessage('MD Editor Plus — Life OS: no workspace folder for a project skill. Use Global or Download.');
            return;
          }
          baseDir = vscode.Uri.joinPath(ws.uri, '.claude', 'skills');
        }
        const skillDir = vscode.Uri.joinPath(baseDir, 'md-editor-blocks');
        const target = vscode.Uri.joinPath(skillDir, 'SKILL.md');
        try {
          await vscode.workspace.fs.stat(target);
          const overwrite = 'Overwrite';
          const choice = await vscode.window.showWarningMessage(
            `A blocks skill already exists at ${target.fsPath}. Replace it?`,
            { modal: true },
            overwrite,
          );
          if (choice !== overwrite) return;
        } catch { /* doesn't exist — proceed */ }
        try {
          await vscode.workspace.fs.createDirectory(skillDir);
          await vscode.workspace.fs.writeFile(target, Buffer.from(skillMd, 'utf8'));
        } catch (err) {
          await vscode.window.showErrorMessage(`MD Editor Plus — Life OS: skill install failed — ${(err as Error).message}`);
          return;
        }
        const reveal = 'Reveal';
        const choice = await vscode.window.showInformationMessage(
          `Blocks skill installed → ${target.fsPath}`,
          reveal,
        );
        if (choice === reveal) {
          await vscode.commands.executeCommand('revealFileInOS', target);
        }
        return;
      }
      if (msg.type === 'downloadSkill') {
        const skillMd = (msg as unknown as { skillMd?: unknown }).skillMd;
        if (typeof skillMd !== 'string') return;
        const dir = vscode.Uri.joinPath(document.uri, '..');
        const defaultUri = vscode.Uri.joinPath(dir, 'SKILL.md');
        const target = await vscode.window.showSaveDialog({
          defaultUri,
          filters: { Markdown: ['md'] },
          saveLabel: 'Save skill',
          title: 'Download blocks skill (place it in a md-editor-blocks/ folder in your skills dir)',
        });
        if (!target) return;
        try {
          await vscode.workspace.fs.writeFile(target, Buffer.from(skillMd, 'utf8'));
        } catch (err) {
          await vscode.window.showErrorMessage(`MD Editor Plus — Life OS: save failed — ${(err as Error).message}`);
          return;
        }
        await vscode.window.showInformationMessage(`Saved ${path.basename(target.fsPath)}`);
        return;
      }
      if (msg.type === 'saveOutlineVisible') {
        const value = (msg as unknown as { value?: unknown }).value;
        if (typeof value !== 'boolean') return;
        const cfg = vscode.workspace.getConfiguration('mdEditorPlusLifeos');
        await cfg.update('outlineVisible', value, vscode.ConfigurationTarget.Global);
        return;
      }
      if (msg.type === 'saveStructureMapVisible') {
        const value = (msg as unknown as { value?: unknown }).value;
        if (typeof value !== 'boolean') return;
        const cfg = vscode.workspace.getConfiguration('mdEditorPlusLifeos');
        await cfg.update('structureMapVisible', value, vscode.ConfigurationTarget.Global);
        return;
      }
      if (msg.type === 'saveFrontmatterVisible') {
        const value = (msg as unknown as { value?: unknown }).value;
        if (typeof value !== 'boolean') return;
        const cfg = vscode.workspace.getConfiguration('mdEditorPlusLifeos');
        await cfg.update('frontmatterVisible', value, vscode.ConfigurationTarget.Global);
        return;
      }
      if (msg.type === 'saveSourceWordWrap') {
        const value = (msg as unknown as { value?: unknown }).value;
        if (typeof value !== 'boolean') return;
        const cfg = vscode.workspace.getConfiguration('mdEditorPlusLifeos');
        await cfg.update('sourceWordWrap', value, vscode.ConfigurationTarget.Global);
        return;
      }
      if (msg.type === 'refresh') {
        // Re-send the current TextDocument content to the webview. The file
        // watcher already keeps the TextDocument in sync with disk for clean
        // docs; this forces a resync if the webview suspects it has drifted.
        webviewPanel.webview.postMessage({
          type: 'update',
          markdown: document.getText(),
          source: 'refresh',
        });
        return;
      }
      if (msg.type === 'exportPdf') {
        const rawHtml = (msg as unknown as { html?: unknown }).html;
        const fname = (msg as unknown as { filename?: unknown }).filename;
        if (typeof rawHtml !== 'string' || !rawHtml) return;
        const html = await inlineExportImages(document, rawHtml);
        const base = (typeof fname === 'string' ? fname : 'document.md')
          .replace(/\.[^.]+$/, '')
          .replace(/[^a-zA-Z0-9_.\-]+/g, '_') || 'document';
        const docDir = vscode.Uri.joinPath(document.uri, '..');

        const chromePath = findChromiumBinary();
        if (chromePath) {
          // Direct headless PDF — one click, no print dialog.
          const target = await vscode.window.showSaveDialog({
            defaultUri: vscode.Uri.joinPath(docDir, `${base}.pdf`),
            filters: { 'PDF': ['pdf'] },
            saveLabel: 'Export',
            title: 'Export as PDF',
          });
          if (!target) return;
          const tmpHtml = path.join(os.tmpdir(), `md-editor-plus-${Date.now()}-${base}.html`);
          try {
            fs.writeFileSync(tmpHtml, html, 'utf8');
            await renderHtmlToPdf(chromePath, tmpHtml, target.fsPath);
          } catch (err) {
            await vscode.window.showErrorMessage(`MD Editor Plus — Life OS: PDF export failed — ${(err as Error).message}`);
            return;
          } finally {
            try { fs.unlinkSync(tmpHtml); } catch { /* ignore */ }
          }
          const open = 'Open';
          const choice = await vscode.window.showInformationMessage(
            `Exported to ${target.fsPath.split(/[\\/]/).pop()}`,
            open,
          );
          if (choice === open) await vscode.env.openExternal(target);
          return;
        }

        // Fallback: open in default browser with an auto-print script so the
        // system print dialog appears immediately.
        const autoPrintHtml = html.replace(
          '</body>',
          `<script>window.addEventListener('load', () => setTimeout(window.print, 250));</script></body>`,
        );
        const tmpPath = path.join(os.tmpdir(), `md-editor-plus-${Date.now()}-${base}.html`);
        const tmpUri = vscode.Uri.file(tmpPath);
        try {
          await vscode.workspace.fs.writeFile(tmpUri, Buffer.from(autoPrintHtml, 'utf8'));
        } catch (err) {
          await vscode.window.showErrorMessage(`MD Editor Plus — Life OS: PDF export failed — ${(err as Error).message}`);
          return;
        }
        await vscode.env.openExternal(tmpUri);
        await vscode.window.showInformationMessage(
          'No Chromium browser found for direct export — opened in your browser. Pick "Save as PDF" in the print dialog.',
        );
      }
      if (msg.type === 'exportHtml') {
        const rawHtml = (msg as unknown as { html?: unknown }).html;
        if (typeof rawHtml !== 'string' || !rawHtml) return;
        const html = await inlineExportImages(document, rawHtml);
        const base = (document.uri.path.split('/').pop() ?? 'document.md').replace(/\.[^.]+$/, '');
        const dir = vscode.Uri.joinPath(document.uri, '..');
        const defaultUri = vscode.Uri.joinPath(dir, `${base}.html`);
        const target = await vscode.window.showSaveDialog({
          defaultUri,
          filters: { 'HTML': ['html', 'htm'] },
          saveLabel: 'Export',
          title: 'Export as HTML',
        });
        if (!target) return;
        try {
          await vscode.workspace.fs.writeFile(target, Buffer.from(html, 'utf8'));
        } catch (err) {
          await vscode.window.showErrorMessage(`MD Editor Plus — Life OS: export failed — ${(err as Error).message}`);
          return;
        }
        const open = 'Open';
        const choice = await vscode.window.showInformationMessage(
          `Exported to ${target.fsPath.split('/').pop()}`,
          open,
        );
        if (choice === open) {
          await vscode.env.openExternal(target);
        }
      }
      if (msg.type === 'duplicate') {
        const dir = vscode.Uri.joinPath(document.uri, '..');
        const base = document.uri.path.split('/').pop() ?? 'document.md';
        const name = base.replace(/(\.md)$/i, '') + ' copy.md';
        const newUri = vscode.Uri.joinPath(dir, name);
        await vscode.workspace.fs.writeFile(newUri, Buffer.from(document.getText(), 'utf8'));
        await vscode.commands.executeCommand('vscode.openWith', newUri, 'md-editor-plus-lifeos.editor');
      }
      if (msg.type === 'saveImage') {
        const m = msg as unknown as { requestId?: unknown; name?: unknown; bytesBase64?: unknown };
        const requestId = typeof m.requestId === 'string' ? m.requestId : '';
        const reply = (extra: Record<string, unknown>) =>
          void webviewPanel.webview.postMessage({ type: 'imageSaved', requestId, ...extra });
        if (!requestId || typeof m.name !== 'string' || typeof m.bytesBase64 !== 'string') {
          reply({ error: 'bad saveImage request' });
          return;
        }
        if (!document.uri.scheme.startsWith('file')) {
          reply({ error: 'cannot save images for an unsaved document — save the file first' });
          return;
        }
        // Node's Buffer.from(..,'base64') silently truncates invalid input, which would
        // write a corrupt file. Reject anything that isn't well-formed base64.
        if (!/^[A-Za-z0-9+/]*={0,2}$/.test(m.bytesBase64) || m.bytesBase64.length % 4 !== 0) {
          reply({ error: 'invalid image data' });
          return;
        }
        try {
          const docDir = vscode.Uri.joinPath(document.uri, '..');
          const folderName = assetsFolderName(path.basename(document.uri.fsPath));
          const folderUri = vscode.Uri.joinPath(docDir, folderName);
          await vscode.workspace.fs.createDirectory(folderUri);
          let existing: string[] = [];
          try {
            existing = (await vscode.workspace.fs.readDirectory(folderUri)).map(([n]) => n);
          } catch { /* empty/new folder */ }
          const finalName = dedupeFileName(sanitizeImageFileName(m.name), existing);
          const fileUri = vscode.Uri.joinPath(folderUri, finalName);
          await vscode.workspace.fs.writeFile(fileUri, Buffer.from(m.bytesBase64, 'base64'));
          reply({ relPath: relativeAssetPath(folderName, finalName) });
        } catch (err) {
          reply({ error: (err as Error).message });
        }
        return;
      }
      if (msg.type === 'revealImage') {
        const m = msg as unknown as { requestId?: unknown; relPath?: unknown };
        const requestId = typeof m.requestId === 'string' ? m.requestId : '';
        const reply = (extra: Record<string, unknown>) =>
          void webviewPanel.webview.postMessage({ type: 'imageRevealed', requestId, ...extra });
        if (!requestId || typeof m.relPath !== 'string') {
          reply({ error: 'bad revealImage request' });
          return;
        }
        if (!document.uri.scheme.startsWith('file')) {
          reply({ error: 'save the file first' });
          return;
        }
        try {
          const clean = m.relPath.replace(/^\.\//, '');
          const docDir = vscode.Uri.joinPath(document.uri, '..');
          const target = vscode.Uri.joinPath(docDir, clean);
          await vscode.commands.executeCommand('revealFileInOS', target);
          reply({ ok: true });
        } catch (err) {
          reply({ error: (err as Error).message });
        }
        return;
      }
      if (msg.type === 'copyImagePath') {
        const m = msg as unknown as { requestId?: unknown; relPath?: unknown };
        const requestId = typeof m.requestId === 'string' ? m.requestId : '';
        const reply = (extra: Record<string, unknown>) =>
          void webviewPanel.webview.postMessage({ type: 'imagePathCopied', requestId, ...extra });
        if (!requestId || typeof m.relPath !== 'string') {
          reply({ error: 'bad copyImagePath request' });
          return;
        }
        if (!document.uri.scheme.startsWith('file')) {
          reply({ error: 'save the file first' });
          return;
        }
        try {
          const clean = m.relPath.replace(/^\.\//, '');
          const docDir = vscode.Uri.joinPath(document.uri, '..');
          const target = vscode.Uri.joinPath(docDir, clean);
          await vscode.env.clipboard.writeText(target.fsPath);
          void vscode.window.showInformationMessage('Copied image path');
          reply({ ok: true });
        } catch (err) {
          reply({ error: (err as Error).message });
        }
        return;
      }
      if (msg.type === 'readImageBytes') {
        // The webview can't fetch() local resources (CSP default-src 'none'),
        // so it asks the extension to read the asset bytes for compress/size.
        const m = msg as unknown as { requestId?: unknown; relPath?: unknown };
        const requestId = typeof m.requestId === 'string' ? m.requestId : '';
        const reply = (extra: Record<string, unknown>) =>
          void webviewPanel.webview.postMessage({ type: 'imageBytesRead', requestId, ...extra });
        if (!requestId || typeof m.relPath !== 'string') {
          reply({ error: 'bad readImageBytes request' });
          return;
        }
        if (/^(?:https?:|data:)/i.test(m.relPath)) {
          reply({ error: 'not a local image' });
          return;
        }
        if (!document.uri.scheme.startsWith('file')) {
          reply({ error: 'save the file first' });
          return;
        }
        try {
          const clean = m.relPath.replace(/^\.\//, '');
          const docDir = vscode.Uri.joinPath(document.uri, '..');
          const target = vscode.Uri.joinPath(docDir, clean);
          const data = await vscode.workspace.fs.readFile(target);
          reply({ bytesBase64: Buffer.from(data).toString('base64') });
        } catch (err) {
          reply({ error: (err as Error).message });
        }
        return;
      }
      if (msg.type === 'pickProjectImage') {
        const m = msg as unknown as { requestId?: unknown };
        const requestId = typeof m.requestId === 'string' ? m.requestId : '';
        const reply = (extra: Record<string, unknown>) =>
          void webviewPanel.webview.postMessage({ type: 'projectImagePicked', requestId, ...extra });
        if (!requestId) { reply({ error: 'bad pickProjectImage request' }); return; }
        try {
          const ws = vscode.workspace.getWorkspaceFolder(document.uri);
          const docDir = vscode.Uri.joinPath(document.uri, '..');
          const picked = await vscode.window.showOpenDialog({
            canSelectFiles: true,
            canSelectFolders: false,
            canSelectMany: false,
            defaultUri: ws?.uri ?? docDir,
            filters: { Images: ['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp', 'avif', 'ico'] },
            title: 'Pick an image from your project',
            openLabel: 'Insert image',
          });
          if (!picked || !picked[0]) { reply({ canceled: true }); return; }
          const docFolder = path.dirname(document.uri.fsPath);
          let rel = path.relative(docFolder, picked[0].fsPath).split(path.sep).join('/');
          if (!rel.startsWith('.')) rel = `./${rel}`;
          reply({ relPath: rel });
        } catch (err) {
          reply({ error: (err as Error).message });
        }
        return;
      }
      if (msg.type === 'embedImageFromClipboard') {
        const m = msg as unknown as { requestId?: unknown };
        const requestId = typeof m.requestId === 'string' ? m.requestId : '';
        const reply = (extra: Record<string, unknown>) =>
          void webviewPanel.webview.postMessage({ type: 'clipboardImageResolved', requestId, ...extra });
        if (!requestId) { reply({ error: 'bad embedImageFromClipboard request' }); return; }
        try {
          const raw = (await vscode.env.clipboard.readText()).trim();
          if (!raw) { reply({ error: 'Clipboard is empty.' }); return; }
          // A web or data URL is used directly as the image source.
          if (/^(https?:|data:image\/)/i.test(raw)) { reply({ src: raw }); return; }
          // Otherwise treat the clipboard text as a path to a file in the project.
          const docFolder = path.dirname(document.uri.fsPath);
          const ws = vscode.workspace.getWorkspaceFolder(document.uri);
          const candidates = resolveClipboardCandidates(raw, docFolder, ws?.uri.fsPath);
          let found: string | null = null;
          for (const c of candidates) {
            try { await vscode.workspace.fs.stat(vscode.Uri.file(c)); found = c; break; } catch { /* next */ }
          }
          if (!found) { reply({ error: `No image found for “${raw}”.` }); return; }
          if (!isImageFileName(found)) { reply({ error: 'That file is not an image.' }); return; }
          let rel = path.relative(docFolder, found).split(path.sep).join('/');
          if (!rel.startsWith('.')) rel = `./${rel}`;
          reply({ src: rel });
        } catch (err) {
          reply({ error: (err as Error).message });
        }
        return;
      }
    });

    webviewPanel.onDidDispose(() => {
      cancelAutoSave();
      onDocChange.dispose();
      onDocSave.dispose();
      // Safety net for the close path: if the webview flushed a final edit into
      // the document but the 1s auto-save hadn't fired yet, persist it now.
      if (document.isDirty && !conflictPaused) { void document.save(); }
    });

    // 'init' is sent in response to the webview's 'ready' handshake above —
    // not here — so it can't arrive before the webview is listening.
  }

  // Returns true if the edit was applied, false if it was REFUSED by the
  // save guard (a catastrophic, never-legitimate wipe — see saveGuard.ts).
  // Callers must re-sync the webview from the untouched document when refused.
  private async _applyEdit(document: vscode.TextDocument, markdown: string): Promise<boolean> {
    const prev = document.getText();
    const assessment = assessWrite(prev, markdown);
    if (assessment.verdict === 'wipe') {
      // c37/c48 last line of defense: do NOT write this to disk. The on-disk
      // file (and the in-memory document) stay as they are; the caller re-asserts
      // the good content back into the webview so nothing diverges.
      console.error('[md-editor-plus] save guard REFUSED a catastrophic write', {
        uri: document.uri.toString(),
        reason: assessment.reason,
        prevChars: prev.length,
        nextChars: markdown.length,
        stack: new Error().stack,
      });
      return false;
    }
    const edit = new vscode.WorkspaceEdit();
    edit.replace(
      document.uri,
      new vscode.Range(0, 0, document.lineCount, 0),
      markdown
    );
    const key = document.uri.toString();
    // try/finally so a failed applyEdit can't leave the document stuck in the
    // "applying" state, which would silently swallow all future echo checks.
    this._applying.begin(key);
    try {
      await vscode.workspace.applyEdit(edit);
    } finally {
      this._applying.end(key);
    }
    return true;
  }

  private _getHtml(webview: vscode.Webview, document: vscode.TextDocument): string {
    const fileNameRaw = document.uri.path.split('/').pop() ?? 'untitled.md';
    const fileName = fileNameRaw.replace(/[&<>"']/g, c => (
      c === '&' ? '&amp;' :
      c === '<' ? '&lt;' :
      c === '>' ? '&gt;' :
      c === '"' ? '&quot;' :
      '&#39;'
    ));
    const scriptUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this._extensionUri, 'dist', 'webview.js')
    );
    const nonce = this._nonce();

    const iEye  = `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" fill="currentColor" viewBox="0 0 256 256"><path d="M251,123.13c-.37-.81-9.13-20.26-28.48-39.61C196.63,57.67,164,44,128,44S59.37,57.67,33.51,83.52C14.16,102.87,5.4,122.32,5,123.13a12.08,12.08,0,0,0,0,9.75c.37.82,9.13,20.26,28.49,39.61C59.37,198.34,92,212,128,212s68.63-13.66,94.48-39.51c19.36-19.35,28.12-38.79,28.49-39.61A12.08,12.08,0,0,0,251,123.13Zm-46.06,33C183.47,177.27,157.59,188,128,188s-55.47-10.73-76.91-31.88A130.36,130.36,0,0,1,29.52,128,130.45,130.45,0,0,1,51.09,99.89C72.54,78.73,98.41,68,128,68s55.46,10.73,76.91,31.89A130.36,130.36,0,0,1,226.48,128,130.45,130.45,0,0,1,204.91,156.12ZM128,84a44,44,0,1,0,44,44A44.05,44.05,0,0,0,128,84Zm0,64a20,20,0,1,1,20-20A20,20,0,0,1,128,148Z"/></svg>`;
    const iCode = `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" fill="currentColor" viewBox="0 0 256 256"><path d="M96,73,34.06,128,96,183A12,12,0,1,1,80,201L8,137A12,12,0,0,1,8,119L80,55A12,12,0,0,1,96,73ZM248,119,176,55A12,12,0,1,0,160,73l61.91,55L160,183A12,12,0,1,0,176,201l72-64A12,12,0,0,0,248,119Z"/></svg>`;
    const iAuto = `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" fill="currentColor" viewBox="0 0 256 256"><path d="M128,20A108,108,0,1,0,236,128,108.12,108.12,0,0,0,128,20Zm12,24.87a83.53,83.53,0,0,1,24,7.25V203.88a83.53,83.53,0,0,1-24,7.25ZM44,128a84.12,84.12,0,0,1,72-83.13V211.13A84.12,84.12,0,0,1,44,128Zm144,58.71V69.29a83.81,83.81,0,0,1,0,117.42Z"/></svg>`;
    const iAa = `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" fill="currentColor" viewBox="0 0 256 256"><path d="M90.86,50.89a12,12,0,0,0-21.72,0l-64,136a12,12,0,0,0,21.71,10.22L42.44,164h75.12l15.58,33.11a12,12,0,0,0,21.72-10.22ZM53.74,140,80,84.18,106.27,140ZM200,84c-13.85,0-24.77,3.86-32.45,11.48a12,12,0,1,0,16.9,17c3-3,8.26-4.52,15.55-4.52,11,0,20,7.18,20,16v4.39A47.28,47.28,0,0,0,200,124c-24.26,0-44,17.94-44,40s19.74,40,44,40a47.18,47.18,0,0,0,22-5.38A12,12,0,0,0,244,192V124C244,101.94,224.26,84,200,84Zm0,96c-11,0-20-7.18-20-16s9-16,20-16,20,7.18,20,16S211,180,200,180Z"/></svg>`;
    const iFolder = `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" fill="currentColor" viewBox="0 0 256 256"><path d="M228,104a12,12,0,0,1-24,0V69l-59.51,59.51a12,12,0,0,1-17-17L187,52H152a12,12,0,0,1,0-24h64a12,12,0,0,1,12,12Zm-44,24a12,12,0,0,0-12,12v64H52V84h64a12,12,0,0,0,0-24H48A20,20,0,0,0,28,80V208a20,20,0,0,0,20,20H176a20,20,0,0,0,20-20V140A12,12,0,0,0,184,128Z"/></svg>`;
    const iDownload = `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" fill="currentColor" viewBox="0 0 256 256"><path d="M228,144v64a12,12,0,0,1-12,12H40a12,12,0,0,1-12-12V144a12,12,0,0,1,24,0v52H204V144a12,12,0,0,1,24,0Zm-108.49,8.49a12,12,0,0,0,17,0l40-40a12,12,0,0,0-17-17L140,115V32a12,12,0,0,0-24,0v83L96.49,95.51a12,12,0,0,0-17,17Z"/></svg>`;
    const iOutline = `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" fill="none" stroke="currentColor" stroke-width="22" stroke-linecap="round" viewBox="0 0 256 256"><line x1="40" y1="64" x2="60" y2="64"/><line x1="100" y1="64" x2="216" y2="64"/><line x1="80" y1="128" x2="100" y2="128"/><line x1="140" y1="128" x2="216" y2="128"/><line x1="80" y1="192" x2="100" y2="192"/><line x1="140" y1="192" x2="216" y2="192"/></svg>`;
    const iVscode = `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" fill="currentColor" viewBox="0 0 100 100"><path fill-rule="evenodd" clip-rule="evenodd" d="M70.9119 99.3171C72.4869 99.9307 74.2828 99.8914 75.8725 99.1264L96.4608 89.2197C98.6242 88.1787 100 85.9892 100 83.5872V16.4133C100 14.0113 98.6243 11.8218 96.4609 10.7808L75.8725 0.873756C73.7862 -0.130129 71.3446 0.11576 69.5135 1.44695C69.252 1.63711 69.0028 1.84943 68.769 2.08341L29.3551 38.0415L12.1872 25.0096C10.589 23.7965 8.35363 23.8959 6.86933 25.2461L1.36303 30.2549C-0.452552 31.9064 -0.454633 34.7627 1.35853 36.417L16.2471 50.0001L1.35853 63.5832C-0.454633 65.2374 -0.452552 68.0938 1.36303 69.7453L6.86933 74.7541C8.35363 76.1043 10.589 76.2037 12.1872 74.9905L29.3551 61.9587L68.769 97.9167C69.3925 98.5406 70.1246 99.0104 70.9119 99.3171ZM75.0152 27.2989L45.1091 50.0001L75.0152 72.7012V27.2989Z"/></svg>`;
    const iFrontmatter = `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" fill="none" stroke="currentColor" stroke-width="20" stroke-linecap="round" stroke-linejoin="round" viewBox="0 0 256 256"><rect x="32" y="48" width="192" height="64" rx="14"/><line x1="64" y1="80" x2="104" y2="80"/><line x1="128" y1="80" x2="192" y2="80"/><line x1="32" y1="160" x2="224" y2="160"/><line x1="32" y1="208" x2="160" y2="208"/></svg>`;
    const iStructureMap = `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" fill="none" stroke="currentColor" stroke-width="20" stroke-linecap="round" viewBox="0 0 256 256"><line x1="176" y1="52" x2="216" y2="52"/><line x1="176" y1="100" x2="204" y2="100"/><line x1="176" y1="148" x2="216" y2="148"/><line x1="176" y1="196" x2="204" y2="196"/><rect x="40" y="84" width="80" height="88" rx="10" fill="currentColor" fill-opacity="0.18" stroke-width="16"/></svg>`;
    const iRefresh = `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" fill="currentColor" viewBox="0 0 256 256"><path d="M244,56v48a12,12,0,0,1-12,12H184a12,12,0,1,1,0-24H201.1l-19-17.38c-.13-.12-.26-.24-.38-.37A76,76,0,1,0,127,204h1a75.53,75.53,0,0,0,52.15-20.72,12,12,0,0,1,16.49,17.45A99.45,99.45,0,0,1,128,228h-1.37A100,100,0,1,1,198.51,57.06L220,76.72V56a12,12,0,0,1,24,0Z"/></svg>`;
    const iLock = `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" fill="currentColor" viewBox="0 0 256 256"><path d="M208,76H180V56A52,52,0,0,0,76,56V76H48A20,20,0,0,0,28,96V208a20,20,0,0,0,20,20H208a20,20,0,0,0,20-20V96A20,20,0,0,0,208,76ZM100,56a28,28,0,0,1,56,0V76H100ZM204,204H52V100H204Z"/></svg>`;
    const iSearch = `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" fill="currentColor" viewBox="0 0 256 256"><path d="M232.49,215.51,185,168a92.12,92.12,0,1,0-17,17l47.53,47.54a12,12,0,0,0,17-17ZM44,112a68,68,0,1,1,68,68A68.07,68.07,0,0,1,44,112Z"/></svg>`;
    const iSparkle = `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" fill="currentColor" viewBox="0 0 256 256"><path d="M199,125.31l-49.88-18.39L130.69,57a19.92,19.92,0,0,0-37.38,0L74.92,106.92,25,125.31a19.92,19.92,0,0,0,0,37.38l49.88,18.39L93.31,231a19.92,19.92,0,0,0,37.38,0l18.39-49.88L199,162.69a19.92,19.92,0,0,0,0-37.38Zm-63.38,35.16a12,12,0,0,0-7.11,7.11L112,212.28l-16.47-44.7a12,12,0,0,0-7.11-7.11L43.72,144l44.7-16.47a12,12,0,0,0,7.11-7.11L112,75.72l16.47,44.7a12,12,0,0,0,7.11,7.11L180.28,144ZM140,40a12,12,0,0,1,12-12h12V16a12,12,0,0,1,24,0V28h12a12,12,0,0,1,0,24H188V64a12,12,0,0,1-24,0V52H152A12,12,0,0,1,140,40ZM252,88a12,12,0,0,1-12,12h-4v4a12,12,0,0,1-24,0v-4h-4a12,12,0,0,1,0-24h4V72a12,12,0,0,1,24,0v4h4A12,12,0,0,1,252,88Z"/></svg>`;
    const iPdf = `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" fill="currentColor" viewBox="0 0 256 256"><path d="M48,28A20,20,0,0,0,28,48V208a20,20,0,0,0,20,20H208a20,20,0,0,0,20-20V96a12,12,0,0,0-3.51-8.49l-56-56A12,12,0,0,0,160,28Zm4,24h96V96a12,12,0,0,0,12,12h44V204H52ZM168,57l27,27H168ZM112,160v8h8a12,12,0,0,1,0,24h-8v8a12,12,0,0,1-24,0V148a12,12,0,0,1,12-12h20a12,12,0,0,1,0,24Zm68,12a40,40,0,0,1-40,40h-4a12,12,0,0,1-12-12V148a12,12,0,0,1,12-12h4A40,40,0,0,1,180,176Zm-24-4a16,16,0,0,0-8-13.86V178a16,16,0,0,0,8-6Z"/></svg>`;
    const iArrowsH = `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" fill="currentColor" viewBox="0 0 256 256"><path d="M240.49,136.49l-32,32a12,12,0,0,1-17-17L203,140H53l11.52,11.51a12,12,0,0,1-17,17l-32-32a12,12,0,0,1,0-17l32-32a12,12,0,1,1,17,17L53,116H203l-11.52-11.51a12,12,0,0,1,17-17l32,32A12,12,0,0,1,240.49,136.49Z"/></svg>`;
    const iSliders = `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" fill="currentColor" viewBox="0 0 256 256"><path d="M40,92H70.06a36,36,0,0,0,67.88,0H216a12,12,0,0,0,0-24H137.94a36,36,0,0,0-67.88,0H40a12,12,0,0,0,0,24Zm64-24A12,12,0,1,1,92,80,12,12,0,0,1,104,68Zm112,96H201.94a36,36,0,0,0-67.88,0H40a12,12,0,0,0,0,24h94.06a36,36,0,0,0,67.88,0H216a12,12,0,0,0,0-24Zm-48,24a12,12,0,1,1,12-12A12,12,0,0,1,168,188Z"/></svg>`;
    const iPageWidth = `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" fill="none" stroke="currentColor" stroke-width="22" stroke-linecap="round" stroke-linejoin="round" viewBox="0 0 256 256"><line x1="36" y1="48" x2="36" y2="208"/><line x1="220" y1="48" x2="220" y2="208"/><line x1="80" y1="128" x2="176" y2="128"/><polyline points="102,108 80,128 102,148"/><polyline points="154,108 176,128 154,148"/></svg>`;
    const iCopy = `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" fill="currentColor" viewBox="0 0 256 256"><path d="M216,28H88A12,12,0,0,0,76,40V76H40A12,12,0,0,0,28,88V216a12,12,0,0,0,12,12H168a12,12,0,0,0,12-12V180h36a12,12,0,0,0,12-12V40A12,12,0,0,0,216,28ZM156,204H52V100H156Zm48-48H180V88a12,12,0,0,0-12-12H100V52H204Z"/></svg>`;
    const iDuplicate = `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" fill="currentColor" viewBox="0 0 256 256"><path d="M180,72H36A20,20,0,0,0,16,92V204a20,20,0,0,0,20,20H180a20,20,0,0,0,20-20V92A20,20,0,0,0,180,72Zm-4,128H40V96H176ZM240,52V176a12,12,0,0,1-24,0V56H64a12,12,0,0,1,0-24H220A20,20,0,0,1,240,52Z"/></svg>`;
    const iDots = `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" fill="currentColor" viewBox="0 0 256 256"><path d="M156,128a28,28,0,1,1-28-28A28,28,0,0,1,156,128ZM48,100a28,28,0,1,0,28,28A28,28,0,0,0,48,100Zm160,0a28,28,0,1,0,28,28A28,28,0,0,0,208,100Z"/></svg>`;
    const iLink = `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" fill="currentColor" viewBox="0 0 256 256"><path d="M117.18,188.74a12,12,0,0,1,0,17l-5.12,5.12A58.26,58.26,0,0,1,70.6,228h0A58.62,58.62,0,0,1,29.14,127.92L63.89,93.17a58.64,58.64,0,0,1,98.56,28.11,12,12,0,1,1-23.37,5.44,34.65,34.65,0,0,0-58.22-16.58L46.11,144.89A34.62,34.62,0,0,0,70.57,204h0a34.41,34.41,0,0,0,24.49-10.14l5.11-5.12A12,12,0,0,1,117.18,188.74ZM226.83,45.17a58.65,58.65,0,0,0-82.93,0l-5.11,5.11a12,12,0,0,0,17,17l5.12-5.12a34.63,34.63,0,1,1,49,49L175.1,145.86A34.39,34.39,0,0,1,150.61,156h0a34.63,34.63,0,0,1-33.69-26.72,12,12,0,0,0-23.38,5.44A58.64,58.64,0,0,0,150.56,180h.05a58.28,58.28,0,0,0,41.47-17.17l34.75-34.75a58.62,58.62,0,0,0,0-82.91Z"/></svg>`;
    const iAppLogo = `<svg xmlns="http://www.w3.org/2000/svg" height="22" viewBox="0 0 136 112" fill="none"><rect width="136" height="112" rx="15" fill="white"/><path fill-rule="evenodd" clip-rule="evenodd" d="M92.8551 9.16156L15.2656 12.417C10.8752 12.7966 9.34784 15.6655 9.34784 19.1038V78.7631C9.34784 81.4412 10.2989 83.7328 12.5934 86.7954L25.3858 103.429C27.4876 106.107 29.3985 106.682 33.4112 106.491L119.777 103.429C125.121 103.049 126.652 100.56 126.652 96.355V29.2378C126.652 27.0643 125.794 26.4378 123.266 24.5829L105.461 12.0295C101.258 8.97371 99.5399 8.5872 92.8551 9.16058V9.16156ZM34.8402 27.3751C29.6798 27.7223 28.5094 27.8009 25.5786 25.4179L18.1276 19.4913C17.3703 18.7242 17.7509 17.7672 19.6589 17.5764L95.1437 14.5177C99.537 14.1342 101.825 15.6655 103.543 17.003L112.515 23.504C112.899 23.6977 113.853 24.8415 112.705 24.8415L35.509 27.3298L34.8402 27.3751ZM28.8241 95.0175V38.0402C28.8241 35.5519 29.5883 34.4041 31.876 34.2114L117.098 31.3425C119.203 31.1527 120.154 32.4903 120.154 34.9746V91.5722C120.154 94.0605 119.771 96.1652 116.335 96.355L33.7849 99.0331C30.3496 99.2229 28.8251 98.0791 28.8251 95.0175H28.8241Z" fill="black"/><path d="M35.8799 89.8194V85.739L40.7432 84.7229V48.7065L35.8799 48.0301V47.3043C35.8799 45.4349 37.3945 43.8665 39.2628 43.8013L56.0897 43.2137L66.3819 70.7292L76.2676 44.262C76.6669 43.193 77.6768 42.4599 78.8043 42.4205L91.0074 41.9943V43.0579C91.0074 44.8188 89.7407 46.3683 88.0067 46.7287L86.1139 47.1222V83.1385L91.0074 83.8139V85.1802C91.0074 86.6792 89.793 87.9368 88.2949 87.9891L74.1477 88.4831V84.4027L79.3131 83.376V52.5062L79.162 52.4812L65.6941 87.3879L61.2537 87.543L47.8015 54.6033L47.6504 54.6388L47.8015 72.3561V84.4764L52.1312 85.1715V87.4425C52.1312 88.4418 51.3216 89.2802 50.3229 89.3151L47.3625 89.4185L35.8799 89.8194Z" fill="black"/><path d="M109.09 71.7366L115.401 71.5163C116.18 71.4893 116.594 72.3958 116.077 72.9975L104.333 86.6654C103.974 87.0839 103.341 87.1059 102.981 86.7127L91.237 73.865C90.7199 73.2993 91.1338 72.3637 91.9133 72.3365L98.2142 72.1164V42.1496L109.09 41.7698V71.7366Z" fill="black"/></svg>`;
    const iOpen = `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" fill="currentColor" viewBox="0 0 256 256"><path d="M245,110.64A16,16,0,0,0,232,104H216V88a16,16,0,0,0-16-16H130.67L102.94,51.2a16.14,16.14,0,0,0-9.6-3.2H40A16,16,0,0,0,24,64V208h0a8,8,0,0,0,8,8H211.1a8,8,0,0,0,7.59-5.47l28.49-85.47A16.05,16.05,0,0,0,245,110.64ZM93.34,64,123.2,86.4A8,8,0,0,0,128,88h72v16H69.77a16,16,0,0,0-15.18,10.94L40,158.7V64Zm112,136H43.1l26.67-80H232Z"/></svg>`;

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy"
    content="default-src 'none';
             style-src ${webview.cspSource} 'unsafe-inline';
             script-src 'nonce-${nonce}';
             img-src ${webview.cspSource} data: https:;">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>MD Editor Plus</title>
</head>
<body>
  <div id="toolbar">
    <span class="toolbar-logo" data-tip="MD Editor Plus">${iAppLogo}</span>
    <div class="segmented" id="view-seg">
      <button class="seg-btn active" data-view="preview" data-tip="Notion view — rich rendering">${iEye}<span class="seg-label">Preview</span></button>
      <button class="seg-btn" data-view="source" data-tip="Source view — raw markdown">${iCode}<span class="seg-label">Code</span><span class="fm-badge hidden" id="fm-badge" aria-hidden="true"></span></button>
    </div>
    <button class="toolbar-icon" id="open-vscode-btn" data-tip="Open in VS Code text editor">${iVscode}</button>
    <button class="toolbar-icon" id="outline-btn" data-tip="Outline (⌘⇧O)">${iOutline}</button>
    <button class="toolbar-icon" id="structure-map-btn" data-tip="Structure map">${iStructureMap}</button>
    <button class="toolbar-icon" id="frontmatter-btn" data-tip="Show/hide frontmatter fields" hidden>${iFrontmatter}</button>
    <span class="toolbar-filename" id="toolbar-filename" title="${fileName}">${fileName}</span>
    <span class="save-indicator" id="save-indicator" aria-live="polite"></span>
    <button class="readonly-pill" id="readonly-pill" hidden data-tip="Read-only — click to enable editing">${iLock}<span>Read only</span></button>
    <span class="toolbar-spacer"></span>
    <button class="toolbar-icon" id="diff-btn" data-tip="View changes (diff)">${iArrowsH}</button>
    <button class="toolbar-icon" id="refresh-btn" data-tip="Reload from disk">${iRefresh}</button>
    <button class="toolbar-icon" id="settings-btn" data-tip="Display settings">${iAa}</button>
    <button class="toolbar-icon" id="actions-btn" data-tip="More actions">${iDots}</button>
  </div>
  <div class="settings-panel hidden" id="settings-panel">
    <div class="settings-section">
      <div class="settings-label">Page width</div>
      <div class="settings-row" id="page-width-row" data-tip="Maximum content width in pixels">
        <span class="settings-row-icon">${iPageWidth}</span>
        <span class="settings-row-label">Page width:</span>
        <span class="width-pill" id="width-value">800</span>
      </div>
      <div class="settings-custom-slider" id="custom-slider-row">
        <div class="slider-wrap">
          <div class="slider-stops" aria-hidden="true">
            <span class="slider-stop" style="left:0%" data-stop="600" data-tip="600 px — Narrow"></span>
            <span class="slider-stop" style="left:25%" data-stop="800" data-tip="800 px — Default"></span>
            <span class="slider-stop" style="left:50%" data-stop="1000" data-tip="1000 px — Comfortable"></span>
            <span class="slider-stop" style="left:75%" data-stop="1200" data-tip="1200 px — Wide"></span>
            <span class="slider-stop" style="left:100%" data-stop="1400" data-tip="1400 px — Extra wide"></span>
          </div>
          <input type="range" min="600" max="1400" value="800" step="1" class="width-slider" id="width-slider" data-tip="Drag to set page width. Snaps to dots near them." />
        </div>
      </div>
      <div class="settings-row" data-tip="Use the entire window width (overrides the slider)">
        <span class="settings-row-icon">${iArrowsH}</span>
        <span class="settings-row-label">Full width</span>
        <button class="toggle-switch" id="full-width-toggle" role="switch" aria-checked="false"></button>
      </div>
    </div>
    <div class="settings-section">
      <div class="settings-label">Text size</div>
      <div class="segmented full-width" id="text-seg">
        <button class="seg-btn" data-text="s" data-tip-html="<span class='tip-title'>Small</span><span class='tip-preview' style='font-size:14px'>The quick brown fox</span>"><span style="font-size:14px">S</span></button>
        <button class="seg-btn active" data-text="m" data-tip-html="<span class='tip-title'>Medium (default)</span><span class='tip-preview' style='font-size:16px'>The quick brown fox</span>"><span style="font-size:16px">M</span></button>
        <button class="seg-btn" data-text="l" data-tip-html="<span class='tip-title'>Large</span><span class='tip-preview' style='font-size:18px'>The quick brown fox</span>"><span style="font-size:18px">L</span></button>
        <button class="seg-btn" data-text="xl" data-tip-html="<span class='tip-title'>Extra large</span><span class='tip-preview' style='font-size:20px'>The quick brown fox</span>"><span style="font-size:20px">XL</span></button>
      </div>
    </div>
    <div class="settings-section">
      <div class="settings-label">Font</div>
      <div class="segmented full-width" id="font-seg">
        <button class="seg-btn active" data-font="sans" data-tip-html="<span class='tip-title'>Sans-serif</span><span class='tip-preview' style=&quot;font-family:ui-sans-serif,Inter,sans-serif&quot;>The quick brown fox</span>"><span style="font-family:ui-sans-serif,'Inter',sans-serif;font-weight:600">Aa</span> Sans</button>
        <button class="seg-btn" data-font="serif" data-tip-html="<span class='tip-title'>Serif</span><span class='tip-preview' style=&quot;font-family:ui-serif,Georgia,serif&quot;>The quick brown fox</span>"><span style="font-family:ui-serif,'Georgia',serif;font-weight:700">Aa</span> Serif</button>
        <button class="seg-btn" data-font="mono" data-tip-html="<span class='tip-title'>Monospace</span><span class='tip-preview' style=&quot;font-family:ui-monospace,JetBrains Mono,monospace&quot;>The quick brown fox</span>"><span style="font-family:ui-monospace,'JetBrains Mono',monospace;font-weight:600">Aa</span> Mono</button>
      </div>
    </div>
    <div class="settings-divider"></div>
    <div class="settings-section">
      <div class="settings-label">Code &amp; diagrams</div>
      <div class="settings-row" data-tip="Render the source view at full window width — leaves the rendered view alone">
        <span class="settings-row-icon">${iArrowsH}</span>
        <span class="settings-row-label">Full width: Only in Code view</span>
        <button class="toggle-switch" id="source-full-width-toggle" role="switch" aria-checked="false"></button>
      </div>
      <div class="settings-row" data-tip="Wrap long lines in Code view instead of horizontal scrolling">
        <span class="settings-row-icon">${iCode}</span>
        <span class="settings-row-label">Word wrap: Only in Code view</span>
        <button class="toggle-switch" id="source-word-wrap-toggle" role="switch" aria-checked="false"></button>
      </div>
      <div class="settings-row" data-tip="Long code snippets collapse to a preview with a Show more button">
        <span class="settings-row-icon">${iCode}</span>
        <span class="settings-row-label">Shorten Code Snippets</span>
        <button class="toggle-switch" id="shorten-snippets-toggle" role="switch" aria-checked="false"></button>
      </div>
    </div>
    <div class="settings-divider"></div>
    <div class="settings-section">
      <div class="settings-label">Editing</div>
      <div class="settings-row" data-tip="Replace typed sequences like -&gt; with → and -- with — as you type (never inside code)">
        <span class="settings-row-icon">${iArrowsH}</span>
        <span class="settings-row-label">Smart typography</span>
        <button class="toggle-switch" id="smart-typography-toggle" role="switch" aria-checked="false"></button>
      </div>
    </div>
    <div class="settings-divider"></div>
    <div class="settings-defaults-row">
      <button class="settings-defaults-btn primary" id="save-defaults-btn" data-tip="Persist the current view as your default for every Markdown file">Save view as default</button>
      <button class="settings-defaults-btn link" id="reset-defaults-btn" data-tip="Clear saved defaults and restore the built-in ones">Reset</button>
    </div>
  </div>
  <div class="actions-panel hidden" id="actions-panel-filename" data-anchor="filename">
    <button class="settings-action act-copy" data-tip="Copy the entire markdown to clipboard">${iCopy}<span class="settings-action-label">Copy page content</span></button>
    <button class="settings-action act-copy-path" data-tip="Copy the absolute file path to clipboard">${iLink}<span class="settings-action-label">Copy file path</span></button>
    <button class="settings-action act-duplicate" data-tip="Save a copy of this file in the same folder">${iDuplicate}<span class="settings-action-label">Duplicate</span></button>
    <button class="settings-action act-finder" data-tip="Reveal this file in your OS file browser">${iFolder}<span class="settings-action-label">Open in Finder</span></button>
    <button class="settings-action act-export-menu" data-submenu="export">${iDownload}<span class="settings-action-label">Export</span><span class="settings-action-caret">›</span></button>
    <button class="settings-action act-blocks-skill" data-tip="Generate a Claude skill that teaches your AI this app's block grammar">${iDownload}<span class="settings-action-label">Create blocks skill…</span></button>
  </div>
  <div class="actions-panel hidden" id="actions-panel-dots" data-anchor="dots">
    <button class="settings-action act-find" data-tip="Find text in this document (⌘F / Ctrl+F)">${iSearch}<span class="settings-action-label">Find in page</span></button>
    <div class="actions-sep"></div>
    <div class="settings-action readonly-row" id="readonly-row" data-tip="Lock this file — blocks typing and structural edits (never persists; reopen to edit)">${iLock}<span class="settings-action-label">Read only</span><button class="toggle-switch" id="readonly-toggle" role="switch" aria-checked="false" tabindex="-1"></button></div>
    <div class="actions-sep"></div>
    <button class="settings-action act-copy" data-tip="Copy the entire markdown to clipboard">${iCopy}<span class="settings-action-label">Copy page content</span></button>
    <button class="settings-action act-copy-path" data-tip="Copy the absolute file path to clipboard">${iLink}<span class="settings-action-label">Copy file path</span></button>
    <button class="settings-action act-refresh" data-tip="Reload the file from disk — discards unsaved in-editor changes">${iRefresh}<span class="settings-action-label">Reload from disk</span></button>
    <button class="settings-action act-duplicate" data-tip="Save a copy of this file in the same folder">${iDuplicate}<span class="settings-action-label">Duplicate</span></button>
    <button class="settings-action act-finder" data-tip="Reveal this file in your OS file browser">${iFolder}<span class="settings-action-label">Open in Finder</span></button>
    <button class="settings-action act-open-menu" data-submenu="open" data-tip="Open another markdown file in MD Editor Plus">${iOpen}<span class="settings-action-label">Open</span><span class="settings-action-caret">›</span></button>
    <div class="actions-sep"></div>
    <div class="actions-group-label">Export &amp; tools</div>
    <button class="settings-action act-export-menu" data-submenu="export">${iDownload}<span class="settings-action-label">Export</span><span class="settings-action-caret">›</span></button>
    <button class="settings-action act-blocks-skill" data-tip="Generate a Claude skill that teaches your AI this app's block grammar">${iSparkle}<span class="settings-action-label">Create blocks skill…</span></button>
  </div>
  <div class="outline-panel hidden" id="outline-panel"></div>
  <div class="structure-map" id="structure-map" aria-hidden="true"></div>
  <div class="actions-submenu hidden" id="actions-submenu-export" role="menu">
    <button class="settings-action act-export-html" data-tip="Save the rendered view as a standalone HTML file">${iDownload}<span class="settings-action-label">Export to HTML</span></button>
    <button class="settings-action act-export-pdf" data-tip="Render to PDF — uses headless Chrome/Edge if installed, otherwise opens the system print dialog">${iPdf}<span class="settings-action-label">Export to PDF</span></button>
  </div>
  <div class="actions-submenu hidden" id="actions-submenu-open" role="menu">
    <button class="settings-action act-open-clipboard" data-tip="Read a file path from the clipboard and open that markdown file">${iLink}<span class="settings-action-label">From clipboard path</span></button>
    <button class="settings-action act-browse-markdown" data-tip="Pick a markdown file from this workspace, or browse anywhere on disk">${iFolder}<span class="settings-action-label">Browse files…</span></button>
  </div>
  <div id="frontmatter-row" class="frontmatter-row" hidden></div>
  <div id="editor"></div>
  <div id="source-view">
    <div id="source-editor"></div>
  </div>
  <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
  }

  private _nonce(): string {
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    return Array.from({ length: 32 }, () =>
      chars[Math.floor(Math.random() * chars.length)]
    ).join('');
  }
}
