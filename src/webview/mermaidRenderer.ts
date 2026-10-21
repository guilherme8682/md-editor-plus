// Single owner of the mermaid library + theming + render queue + cache.
//
// Imported statically (not dynamically) because the webview's CSP disallows
// loading scripts at runtime without a nonce. esbuild bundles mermaid into the
// main webview bundle; the cost is a larger bundle, but cold open of a file
// with no mermaid blocks still pays nothing at runtime beyond the initial
// parse — and the cache avoids re-rendering on theme flips.

import mermaid from 'mermaid';
import { readHostPalette, subscribeThemeChanges } from './theme';


export type RenderOk     = { ok: true;  svg: string };
export type RenderErr    = { ok: false; message: string; line?: number };
export type RenderResult = RenderOk | RenderErr;

interface ThemeVarSet {
  background:       string;
  primaryColor:     string;
  primaryTextColor: string;
  primaryBorderColor: string;
  secondaryColor:   string;
  tertiaryColor:    string;
  lineColor:        string;
  textColor:        string;
  mainBkg:          string;
  clusterBkg:       string;
  noteBkgColor:     string;
  noteTextColor:    string;
}

/** Diagram fills, labels and edges inherit the central editor's current palette. */
export function getDiagramThemeVariables(): ThemeVarSet {
  const p = readHostPalette();
  return {
    background: p.background,
    primaryColor: p.surface,
    primaryTextColor: p.foreground,
    primaryBorderColor: p.accent,
    secondaryColor: p.surface,
    tertiaryColor: p.background,
    lineColor: p.foreground,
    textColor: p.foreground,
    mainBkg: p.surface,
    clusterBkg: p.background,
    noteBkgColor: p.surface,
    noteTextColor: p.foreground,
  };
}

let initializedPalette = '';
const _cache = new Map<string, string>();
const MAX_CACHE = 64;

function initMermaid(palette: ThemeVarSet): void {
  mermaid.initialize({
    startOnLoad: false,
    securityLevel: 'strict',
    theme: 'base',
    themeVariables: palette,
    fontFamily: getComputedStyle(document.body).getPropertyValue('--vscode-font-family') || 'system-ui, sans-serif',
  });
  initializedPalette = JSON.stringify(palette);
}

function dispatchThemeChange(): void {
  _cache.clear();
  initializedPalette = '';
  document.dispatchEvent(new CustomEvent('mermaid-theme-changed'));
}

// One-time wiring: any time the editor theme flips, broadcast to blocks.
let _themeSubscribed = false;
function ensureThemeSubscription(): void {
  if (_themeSubscribed) return;
  _themeSubscribed = true;
  subscribeThemeChanges(() => dispatchThemeChange());
}

// Serialize renders — mermaid uses global state and can race.
let _queue: Promise<unknown> = Promise.resolve();
function enqueue<T>(fn: () => Promise<T>): Promise<T> {
  const next = _queue.then(fn, fn);
  _queue = next.catch(() => undefined);
  return next as Promise<T>;
}

// Mermaid throws an Error subclass with a `.message` like
//   "Parse error on line 3:\n  Process --x Done??\n          ^\n..."
// We pluck the line number out for the error placeholder UX.
function extractLine(err: unknown): number | undefined {
  const msg = err instanceof Error ? err.message : String(err);
  const m = msg.match(/(?:Parse error on line|on line)\s+(\d+)/i)
         ?? msg.match(/line\s+(\d+)/i);
  if (!m) return undefined;
  const n = parseInt(m[1], 10);
  return Number.isFinite(n) ? n : undefined;
}

function cleanMessage(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);
  // Mermaid messages are multi-line with the offending text + carets. The
  // first line is the human-readable bit; rest is debug.
  const first = msg.split('\n').find(l => l.trim().length > 0) ?? 'Parse error';
  return first.trim();
}

let _idCounter = 0;
function nextId(): string {
  _idCounter += 1;
  return `mmd-${Date.now().toString(36)}-${_idCounter}`;
}

/** Cheap stable hash for source strings. Used as part of the cache key. */
function hash(s: string): string {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36);
}

export function renderMermaid(source: string): Promise<RenderResult> {
  ensureThemeSubscription();
  const palette = getDiagramThemeVariables();
  const paletteKey = JSON.stringify(palette);
  const cacheKey = `${paletteKey}::${hash(source)}`;
  const cached = _cache.get(cacheKey);
  if (cached) return Promise.resolve({ ok: true, svg: cached });

  return enqueue(async () => {
    if (initializedPalette !== paletteKey) initMermaid(palette);
    try {
      const { svg } = await mermaid.render(nextId(), source);
      // LRU-ish: evict the oldest entry if we hit capacity.
      if (_cache.size >= MAX_CACHE) {
        const first = _cache.keys().next().value;
        if (first !== undefined) _cache.delete(first);
      }
      _cache.set(cacheKey, svg);
      return { ok: true, svg } as RenderOk;
    } catch (err) {
      return { ok: false, message: cleanMessage(err), line: extractLine(err) } as RenderErr;
    }
  });
}

/** Attempt to detect the diagram kind (flowchart, sequenceDiagram, ...) from the source's first non-empty line. */
export function detectDiagramKind(source: string): string {
  const first = source.split('\n').map(l => l.trim()).find(l => l.length > 0) ?? '';
  const m = first.match(/^([a-zA-Z]+)/);
  return m ? m[1] : 'mermaid';
}
