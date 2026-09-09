import { afterEach, describe, expect, mock, test } from 'bun:test';
import { EventEmitter } from 'node:events';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

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

function createProvider(hydrated = true) {
  const pi = Object.assign(new EventEmitter(), {
    getState: mock(async (): Promise<any> => null),
    getSessionStats: async () => null,
    getCommands: async () => [],
    prompt: mock(async (..._args: any[]) => ({ success: true })),
    newSession: mock(async () => true),
    switchSession: mock(async (_path: string) => true),
    getMessages: async () => [],
    isRunning: true,
  });
  const edits = {
    onDidChange: () => {},
    recordEdit: mock(async () => {}),
    snapshotWorkspace: mock(async () => {}),
    clear: mock(() => {}),
  };
  const messages: any[] = [];
  const workspaceState = { get: mock((_key: string): any => undefined), update: mock(async (_key: string, _value: any) => {}) };
  const provider = new ChatSidebarProvider({} as any, pi as any, edits as any, workspaceState as any);
  // Most bridge tests start after startup hydration has completed.
  (provider as any).historyLoading = !hydrated;
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

describe('session identity', () => {
  test.each([
    { sessionId: 'session-1', sessionName: 'Named session' },
    { sessionId: 'session-2' },
  ])('forwards live session metadata: %j', async (state) => {
    const { provider, pi, messages } = createProvider();
    pi.getState.mockResolvedValue(state);
    await provider.sendState();
    expect(messages[0]).toMatchObject({ type: 'init', ...state });
    expect(messages[0].sessionName).toBe(state.sessionName);
  });

  test.each([false, true])('/name refreshes after completion while streaming=%s', async (streaming) => {
    const { provider, pi, edits, messages } = createProvider();
    provider.isStreaming = streaming;
    let renamed = false;
    pi.getState.mockImplementation(async () => ({
      sessionId: 'session-1', sessionName: renamed ? 'Normalized name' : 'Old name',
      isStreaming: streaming,
    }));
    pi.prompt.mockImplementation(async () => { renamed = true; return { success: true }; });
    await provider.handleWebviewMessage({ type: 'prompt', text: '/name new name', streaming });
    expect(pi.prompt).toHaveBeenCalledWith('/name new name', undefined, undefined);
    expect(edits.snapshotWorkspace).not.toHaveBeenCalled();
    expect(messages.filter(m => m.type === 'init')).toEqual([
      expect.objectContaining({ sessionId: 'session-1', sessionName: 'Normalized name', state: streaming ? 'streaming' : 'idle' }),
    ]);
  });

  test('runCommand also refreshes session state after the extension command', async () => {
    const { provider, pi, messages } = createProvider();
    pi.prompt.mockImplementation(async () => {
      pi.getState.mockResolvedValue({ sessionId: 'session-1', sessionName: 'Renamed' });
      return { success: true };
    });
    await provider.handleWebviewMessage({ type: 'runCommand', command: '/name Renamed' });
    expect(messages[0]).toMatchObject({ type: 'init', sessionName: 'Renamed' });
  });

  test.each(['newSession', 'resumeSession'])('%s replaces the previous identity', async (type) => {
    const { provider, pi, messages } = createProvider();
    pi.getState.mockResolvedValue({ sessionId: 'old', sessionName: 'Old name' });
    await provider.sendState();
    pi.getState.mockResolvedValue({ sessionId: 'new' });
    await provider.handleWebviewMessage({ type, filePath: '/session.jsonl' });
    await Promise.resolve();
    const state = messages.filter(m => m.type === 'init').at(-1);
    expect(state.sessionId).toBe('new');
    expect(state.sessionName).toBeUndefined();
  });

  test('an older state request cannot overwrite a rename', async () => {
    const { provider, pi, messages } = createProvider();
    let release!: (value: any) => void;
    pi.getState.mockImplementationOnce(() => new Promise(resolve => { release = resolve; }));
    const pending = provider.sendState();
    pi.getState.mockResolvedValue({ sessionId: 'session-1', sessionName: 'New name' });
    await provider.sendState();
    release({ sessionId: 'session-1', sessionName: 'Old name' });
    await pending;
    expect(messages).toHaveLength(1);
    expect(messages[0].sessionName).toBe('New name');
  });

  test('history uses the latest session_info name, including renames after messages', () => {
    const { provider } = createProvider();
    const dir = mkdtempSync(join(tmpdir(), 'pi-chat-session-'));
    const file = join(dir, 'session.jsonl');
    try {
      const entries = [
        { type: 'session', id: 'session-1' },
        { type: 'message', message: { role: 'user', content: 'First prompt' } },
        { type: 'session_info', name: 'Old name' },
        { type: 'session_info', name: 'Latest name' },
      ];
      writeFileSync(file, entries.map(e => JSON.stringify(e)).join('\n') + '\n{partial');
      expect(provider.getSessionTitle(file)).toBe('Latest name');
      writeFileSync(file, [...entries, { type: 'session_info', name: '' }].map(e => JSON.stringify(e)).join('\n'));
      expect(provider.getSessionTitle(file)).toBe('First prompt');
      writeFileSync(file, JSON.stringify({ type: 'session_info', name: 'Named before first prompt' }));
      expect(provider.getSessionTitle(file)).toBe('Named before first prompt');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('history hydration', () => {
  test('a superseded startup history load does not overwrite the new session', async () => {
    const { provider, pi, messages } = createProvider();
    let release!: (value: any[]) => void;
    pi.getMessages = mock(() => new Promise<any[]>((resolve) => { release = resolve; }));

    const pending = provider.loadHistory();
    // Session changes while the startup load is still in flight.
    void provider.newSession();
    await Promise.resolve();
    release([{ role: 'user', content: 'stale' }]);
    await pending;

    expect(messages.filter((m: any) => m.type === 'loadHistory')).toHaveLength(0);
  });

  test.each([
    { history: [] },
    { history: [{ role: 'user', content: 'Previous conversation' }] },
  ])('startup gates prompts until history is published: %j', async ({ history }) => {
    const { provider, pi, messages } = createProvider(false);
    let release!: (value: any[]) => void;
    pi.getMessages = mock(() => new Promise<any[]>((resolve) => { release = resolve; }));
    await provider.handleWebviewMessage({ type: 'prompt', text: 'Too early' });
    const pending = provider.handleWebviewMessage({ type: 'ready' });
    await provider.handleWebviewMessage({ type: 'prompt', text: 'Still loading' });
    await provider.handleWebviewMessage({ type: 'runCommand', command: '/name Too early' });
    expect(pi.prompt).not.toHaveBeenCalled();
    expect(messages.some(m => m.type === 'userMessage')).toBe(false);

    release(history);
    await pending;
    expect(messages.filter(m => ['loadHistory', 'historyLoading'].includes(m.type))).toEqual([
      { type: 'historyLoading', loading: true },
      { type: 'loadHistory', messages: history },
      { type: 'historyLoading', loading: false },
    ]);
    await provider.handleWebviewMessage({ type: 'prompt', text: '/name Ready' });
    expect(pi.prompt).toHaveBeenCalledTimes(1);
  });

  test('failed history reports an error before unlocking without posting empty history', async () => {
    const { provider, pi, messages } = createProvider(false);
    pi.getMessages = mock(async () => { throw new Error('RPC unavailable'); });
    await provider.loadHistory();
    expect(messages).toEqual([
      { type: 'historyLoading', loading: true },
      expect.objectContaining({ type: 'error', message: expect.stringContaining('RPC unavailable') }),
      { type: 'historyLoading', loading: false },
    ]);
    await provider.handleWebviewMessage({ type: 'runCommand', command: '/name Retry' });
    expect(pi.prompt).toHaveBeenCalledTimes(1);
  });

  test('an obsolete history request cannot unlock a newer load', async () => {
    const { provider, pi, messages } = createProvider();
    const releases: ((value: any[]) => void)[] = [];
    pi.getMessages = mock(() => new Promise<any[]>(resolve => releases.push(resolve)));
    const oldLoad = provider.loadHistory();
    const newLoad = provider.loadHistory();
    releases[0]([]);
    await oldLoad;
    expect(provider.historyLoading).toBe(true);
    expect(messages.some(m => m.type === 'loadHistory' || m.loading === false)).toBe(false);
    releases[1]([]);
    await newLoad;
    expect(provider.historyLoading).toBe(false);
  });

  test('RPC history failures are not mistaken for an empty session', async () => {
    const { PiRpcClient } = await import('../src/piRpcClient.ts');
    const client = new PiRpcClient('pi', []);
    client.send = mock(async () => ({ type: 'response', command: 'get_messages', success: false, error: 'pi not running' }));
    await expect(client.getMessages()).rejects.toThrow('pi not running');
    client.send = mock(async () => ({ type: 'response', command: 'get_messages', success: true, data: { messages: [] } }));
    expect(await client.getMessages()).toEqual([]);
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
