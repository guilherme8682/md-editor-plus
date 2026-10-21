/** @jest-environment jsdom */
import mermaid from 'mermaid';
import { getDiagramThemeVariables, renderMermaid } from '../../src/webview/mermaidRenderer';
import { initTheme, subscribeThemeChanges } from '../../src/webview/theme';

jest.mock('mermaid', () => ({
  __esModule: true,
  default: { initialize: jest.fn(), render: jest.fn(async () => ({ svg: '<svg />' })) },
}));

function setPalette(background: string, foreground: string): void {
  document.body.style.setProperty('--vscode-editor-background', background);
  document.body.style.setProperty('--vscode-editor-foreground', foreground);
  document.body.style.setProperty('--vscode-editorWidget-background', background);
  // A hybrid theme deliberately has a different sidebar palette.
  document.body.style.setProperty('--vscode-sideBar-background', '#d9d6cb');
  document.body.style.setProperty('--vscode-sideBar-foreground', '#211f1e');
}

beforeEach(() => { jest.clearAllMocks(); });

describe('host palette integration', () => {
  it('uses the central editor colors, even with a light sidebar', () => {
    setPalette('#211f1e', '#e5e2d8');
    const vars = getDiagramThemeVariables();
    expect(vars.background).toBe('#211f1e');
    expect(vars.primaryTextColor).toBe('#e5e2d8');
    expect(vars.primaryColor).toBe('#211f1e');
  });

  it('invalidates cached diagrams when colors change within the same dark mode', async () => {
    setPalette('#171717', '#eeeeee');
    await renderMermaid('flowchart LR\nA-->B');
    await renderMermaid('flowchart LR\nA-->B');
    expect(mermaid.render).toHaveBeenCalledTimes(1);
    setPalette('#282828', '#dddddd');
    await renderMermaid('flowchart LR\nA-->B');
    expect(mermaid.render).toHaveBeenCalledTimes(2);
    expect(mermaid.initialize).toHaveBeenLastCalledWith(expect.objectContaining({
      themeVariables: expect.objectContaining({ background: '#282828', textColor: '#dddddd' }),
    }));
  });

  it('notifies open diagrams when VS Code changes palette without changing theme mode', async () => {
    setPalette('#191919', '#fafafa');
    initTheme();
    const onChange = jest.fn();
    const unsubscribe = subscribeThemeChanges(onChange);
    setPalette('#303030', '#ededed');
    await Promise.resolve();
    expect(onChange).toHaveBeenCalledWith('dark');
    unsubscribe();
  });
});
