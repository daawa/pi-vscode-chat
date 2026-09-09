import { afterEach, describe, expect, mock, test } from 'bun:test';
import { EventEmitter } from 'node:events';

const readFile = mock(async (_uri: unknown) => Buffer.from('new content'));
const showQuickPick = mock(async (_items: any[], _options: unknown): Promise<any> => undefined);
mock.module('vscode', () => ({
  workspace: {
    workspaceFolders: [{ uri: { fsPath: '/workspace' } }],
    fs: { readFile },
    registerTextDocumentContentProvider: () => {},
  },
  Uri: { file: (fsPath: string) => ({ fsPath }) },
  window: { showQuickPick },
}));

const { ChatSidebarProvider } = await import('../src/chatSidebarProvider.ts');

function createProvider() {
  const pi = Object.assign(new EventEmitter(), {
    getState: async () => null,
    getSessionStats: async () => null,
  });
  const edits = {
    onDidChange: () => {},
    recordEdit: mock(async () => {}),
  };
  const messages: any[] = [];
  const provider = new ChatSidebarProvider({} as any, pi as any, edits as any);
  // Exercise the real bridge without launching an extension host or Pi process.
  (provider as any)._view = {
    webview: { postMessage: (message: any) => messages.push(message) },
  };
  return { pi, edits, messages, provider: provider as any };
}

function toolEnd(isError: boolean) {
  return {
    type: 'tool_execution_end',
    toolCallId: 'edit-1',
    toolName: 'edit',
    args: { path: 'example.txt' },
    isError,
    result: {
      content: [{ type: 'text', text: isError ? 'Edit failed' : 'Edited file' }],
      details: { diff: '--- a/example.txt\n+++ b/example.txt\n@@ -1 +1 @@\n-old\n+new' },
    },
  };
}

afterEach(() => {
  readFile.mockReset();
  readFile.mockImplementation(async () => Buffer.from('new content'));
  showQuickPick.mockReset();
  showQuickPick.mockImplementation(async () => undefined);
});

describe('tool completion bridge', () => {
  test('process exit settles tools before displaying the error banner', async () => {
    const { pi, messages } = createProvider();
    pi.emit('exit', 1, null, 'crashed');
    expect(messages.map(m => m.type)).toEqual(['agentEnd', 'error']);
    expect(messages[1].message).toContain('crashed');
    // Allow the asynchronously requested idle state to arrive as well.
    await Promise.resolve();
    await Promise.resolve();
    expect(messages.find(m => m.type === 'init')?.state).toBe('idle');
  });

  test('failed tools publish their outcome without edit/diff work', async () => {
    const { provider, edits, messages } = createProvider();
    await provider.handleToolEnd(toolEnd(true));
    expect(messages).toEqual([{
      type: 'toolEnd', messageId: 'current', toolCallId: 'edit-1',
      toolName: 'edit', isError: true, output: 'Edit failed',
    }]);
    expect(readFile).not.toHaveBeenCalled();
    expect(edits.recordEdit).not.toHaveBeenCalled();
  });

  test('completion precedes agentEnd even when file processing is delayed', async () => {
    let release!: (content: Buffer) => void;
    const fileRead = new Promise<Buffer>(resolve => { release = resolve; });
    readFile.mockImplementation(() => fileRead);
    const { provider, pi, messages } = createProvider();

    const pending = provider.handleToolEnd(toolEnd(false));
    expect(messages.map(m => m.type)).toEqual(['toolEnd']);
    expect(messages[0].isError).toBe(false);

    pi.emit('event', { type: 'agent_end', messages: [] });
    expect(messages.slice(0, 2).map(m => m.type)).toEqual(['toolEnd', 'agentEnd']);
    expect(messages.some(m => m.type === 'toolDiff')).toBe(false);

    release(Buffer.from('new content'));
    await pending;
    expect(messages.filter(m => m.type === 'toolEnd')).toHaveLength(1);
    expect(messages.find(m => m.type === 'toolDiff')).toMatchObject({
      toolCallId: 'edit-1', filePath: 'example.txt', fileContent: 'new content',
    });
  });

  test('edit bookkeeping failure cannot change an already-published outcome', async () => {
    const { provider, edits, messages } = createProvider();
    edits.recordEdit.mockImplementation(async () => { throw new Error('snapshot unavailable'); });
    await provider.handleToolEnd(toolEnd(false));
    expect(messages[0]).toMatchObject({ type: 'toolEnd', isError: false });
    expect(messages.filter(m => m.type === 'toolEnd')).toHaveLength(1);
    expect(messages[1].type).toBe('toolDiff');
  });
});

describe('chat style picker', () => {
  test.each(['default', 'custom'])('selects the %s stylesheet', async (style) => {
    const { provider, messages } = createProvider();
    showQuickPick.mockImplementation(async items => items.find(item => item.style === style));
    await provider.handleWebviewMessage({ type: 'selectStyle', currentStyle: 'custom' });
    expect(showQuickPick.mock.calls[0][0]).toEqual([
      { label: 'Default', detail: 'Uses VS Code theme colors.', style: 'default', description: undefined },
      { label: 'Custom', detail: 'Tinted tool results and light blue code blocks.', style: 'custom', description: 'Current' },
    ]);
    expect(messages).toEqual([{ type: 'styleSelected', style }]);
  });

  test('cancelling the picker leaves the current style unchanged', async () => {
    const { provider, messages } = createProvider();
    await provider.handleWebviewMessage({ type: 'selectStyle', currentStyle: 'default' });
    expect(showQuickPick).toHaveBeenCalledTimes(1);
    expect(messages).toEqual([]);
  });
});
