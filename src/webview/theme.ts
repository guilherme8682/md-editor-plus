/** VS Code owns the palette. No editor theme, OS preference or stored override. */
export type Resolved = 'light' | 'dark';
const subscribers = new Set<(resolved: Resolved) => void>();
let observer: MutationObserver | undefined;
let lastPalette = '';
let resolved: Resolved = 'light';

export function currentResolvedTheme(): Resolved { return resolved; }
export function subscribeThemeChanges(cb: (theme: Resolved) => void): () => void {
  subscribers.add(cb);
  return () => subscribers.delete(cb);
}

/** Mermaid requires concrete hex colors, rather than CSS variable expressions. */
function hexColor(value: string): string | undefined {
  const v = value.trim();
  if (/^#[\da-f]{6}$/i.test(v)) return v;
  if (/^#[\da-f]{3}$/i.test(v)) return '#' + [...v.slice(1)].map(c => c + c).join('');
  const rgb = v.match(/^rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)/i);
  const srgb = v.match(/^color\(srgb\s+([\d.]+)\s+([\d.]+)\s+([\d.]+)/i);
  const channels = rgb ? rgb.slice(1, 4).map(Number)
    : srgb ? srgb.slice(1, 4).map(n => Number(n) * 255) : undefined;
  return channels ? '#' + channels.map(n => Math.max(0, Math.min(255, Math.round(n))).toString(16).padStart(2, '0')).join('') : undefined;
}

export function readHostPalette() {
  const style = getComputedStyle(document.body);
  const color = (keys: string[], fallback: string): string => {
    for (const key of keys) {
      const value = hexColor(style.getPropertyValue(key));
      if (value) return value;
    }
    return fallback;
  };
  const background = color(['--vscode-editor-background'], hexColor(style.backgroundColor) ?? '#ffffff');
  const foreground = color(['--vscode-editor-foreground', '--vscode-foreground'], hexColor(style.color) ?? '#000000');
  return {
    background, foreground,
    surface: background,
    border: color(['--vscode-widget-border', '--vscode-input-border', '--vscode-panel-border'], foreground),
    accent: color(['--vscode-focusBorder', '--vscode-textLink-foreground'], foreground),
    muted: color(['--vscode-descriptionForeground'], foreground),
  };
}

export function initTheme(): void {
  if (observer) return;
  const update = (): void => {
    const palette = readHostPalette();
    const key = JSON.stringify(palette);
    if (key === lastPalette) return;
    lastPalette = key;
    const [r, g, b] = [1, 3, 5].map(i => parseInt(palette.background.slice(i, i + 2), 16));
    resolved = (r * 299 + g * 587 + b * 114) / 1000 < 128 ? 'dark' : 'light';
    document.documentElement.style.colorScheme = resolved;
    for (const cb of subscribers) cb(resolved);
  };
  update();
  observer = new MutationObserver(update);
  const options = { attributes: true, attributeFilter: ['class', 'style', 'data-vscode-theme-id'] };
  observer.observe(document.body, options);
  observer.observe(document.documentElement, options);
}

/** Preserve the current host palette when HTML leaves the VS Code webview. */
export function snapshotHostTheme(): string {
  const style = getComputedStyle(document.body);
  const declarations: string[] = [];
  for (let i = 0; i < style.length; i++) {
    const name = style.item(i);
    if (!/^--vscode-[\w-]+$/.test(name)) continue;
    const value = style.getPropertyValue(name).replace(/[<>]/g, c => c === '<' ? '\\3c ' : '\\3e ');
    declarations.push(`${name}:${value};`);
  }
  return `body {${declarations.join('')}}`;
}
