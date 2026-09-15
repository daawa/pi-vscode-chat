import { afterEach, describe, expect, mock, test } from 'bun:test';
import { EventEmitter } from 'node:events';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PNG } from './image-fixtures.ts';

const readFile = mock(async (_uri: unknown) => Buffer.from('new content'));
const writeFile = mock(async (_uri: unknown, _content: Uint8Array) => {});
const deleteFile = mock(async (_uri: unknown) => {});
const stat = mock(async (_uri: unknown) => ({ type: 1, size: 100 }));
const showOpenDialog = mock(async (_options: unknown): Promise<any> => undefined);
const parseUri = (value: string) => {
  const url = new URL(value);
  return { scheme: url.protocol.slice(0, -1), path: decodeURIComponent(url.pathname),
    fsPath: decodeURIComponent(url.pathname), toString: () => value };
};
const showQuickPick = mock(async (_items: any[], _options: unknown): Promise<any> => undefined);
mock.module('vscode', () => ({
  workspace: {
    workspaceFolders: [{ uri: { fsPath: '/workspace' } }],
    textDocuments: [],
    fs: { readFile, writeFile, delete: deleteFile, stat },
    registerTextDocumentContentProvider: () => {},
  },
  Uri: { file: (fsPath: string) => ({ fsPath }), parse: parseUri },
  FileType: { File: 1 },
  window: { showQuickPick, showOpenDialog },
  EventEmitter: class {
    private emitter = new EventEmitter();
    event = (listener: (value: any) => void) => { this.emitter.on('change', listener); };
    fire(value: any) { this.emitter.emit('change', value); }
  },
}));

const { ChatSidebarProvider } = await import('../src/chatSidebarProvider.ts');
const { EditManager } = await import('../src/editManager.ts');

function createProvider(historyLoaded = true, editManager?: InstanceType<typeof EditManager>) {
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
  const edits = editManager ?? {
    onDidChange: () => {},
    recordEdit: mock(async (_path: string, _content: string, diff: string) => ({ diff })),
    snapshotFile: mock(async () => 'old content'),
    snapshotWorkspace: mock(async () => {}),
    getPendingEdits: () => [],
    clear: mock(() => {}),
  };
  const messages: any[] = [];
  const workspaceState = { get: mock((_key: string): any => undefined), update: mock(async (_key: string, _value: any) => {}) };
  const provider = new ChatSidebarProvider({} as any, pi as any, edits as any, workspaceState as any);
  // Most bridge tests start after startup session history loading has completed.
  (provider as any).historyLoading = !historyLoaded;
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
  stat.mockReset();
  stat.mockImplementation(async () => ({ type: 1, size: 100 }));
  showOpenDialog.mockReset();
  showOpenDialog.mockImplementation(async () => undefined);
  writeFile.mockClear();
  deleteFile.mockClear();
  showQuickPick.mockReset();
  showQuickPick.mockImplementation(async () => undefined);
});

describe('tool completion bridge', () => {
  test('Pi start args and arg-less completion produce working Diff / Keep / Undo', async () => {
    const manager = new EditManager();
    const { provider, messages } = createProvider(true, manager);
    readFile.mockResolvedValueOnce(Buffer.from('old content'));
    provider.handleToolStart({ toolCallId: 'edit-1', toolName: 'edit', args: { path: 'example.txt' } });
    const { args, ...end } = toolEnd(false);
    await provider.handleToolEnd(end);
    const record = manager.getPendingEdits()[0];
    expect(record.originalContent).toBe('old content');
    expect(record.newContent).toBe('new content');
    expect(record.diff).toContain('-old content');
    expect(record.diff).toContain('+new content');
    expect(messages.find(m => m.type === 'editRecorded')).toMatchObject({ editId: record.id });
    expect(messages.find(m => m.type === 'toolDiff')?.diff).toBe(record.diff);
    await provider.handleWebviewMessage({ type: 'revertEdit', editId: record.id });
    expect(writeFile.mock.calls[0][1].toString()).toBe('old content');
    expect(manager.getPendingEdits()).toHaveLength(0);
    expect(messages.some(m => m.type === 'editReverted')).toBe(true);
  });

  test('write without a Pi diff generates a patch; Undo removes a newly created file', async () => {
    const manager = new EditManager();
    const { provider, messages } = createProvider(true, manager);
    readFile.mockRejectedValueOnce(Object.assign(new Error('missing'), { code: 'FileNotFound' }));
    provider.handleToolStart({ toolCallId: 'write-1', toolName: 'write', args: { file_path: 'new.txt' } });
    await provider.handleToolEnd({ toolCallId: 'write-1', toolName: 'write', isError: false, result: {} });
    const record = manager.getPendingEdits()[0];
    expect(record.originalExists).toBe(false);
    expect(messages.find(m => m.type === 'toolDiff')?.diff).toContain('+new content');
    await manager.revertEdit(record.id);
    expect(deleteFile).toHaveBeenCalledWith({ fsPath: '/workspace/new.txt' });
  });

  test('repeated edits share a baseline until Keep, then capture a fresh baseline', async () => {
    const manager = new EditManager();
    readFile.mockResolvedValueOnce(Buffer.from('original'));
    await manager.snapshotFile('/workspace/example.txt');
    const first = await manager.recordEdit('/workspace/example.txt', 'second', '');
    await manager.snapshotWorkspace();
    await manager.snapshotFile('/workspace/example.txt');
    const second = await manager.recordEdit('/workspace/example.txt', 'third', '');
    expect(second.id).toBe(first.id);
    expect(second.originalContent).toBe('original');
    expect(manager.getPendingEdits()).toHaveLength(1);
    manager.acceptEdit(second.id);
    readFile.mockResolvedValueOnce(Buffer.from('third'));
    await manager.snapshotFile('/workspace/example.txt');
    const next = await manager.recordEdit('/workspace/example.txt', 'fourth', '');
    expect(next.id).not.toBe(first.id);
    expect(next.originalContent).toBe('third');
  });

  test('never takes an Undo snapshot after completion', async () => {
    const manager = new EditManager();
    await expect(manager.recordEdit('/workspace/example.txt', 'changed', '')).rejects.toThrow('Cannot snapshot');
    expect(readFile).not.toHaveBeenCalled();
  });

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

describe('session history loading', () => {
  test('reopening the webview restores review controls for retained snapshots', async () => {
    const manager = new EditManager();
    await manager.snapshotFile('/workspace/example.txt');
    const record = await manager.recordEdit('/workspace/example.txt', 'changed', '');
    const { provider, messages } = createProvider(true, manager);
    await provider.loadHistory();
    expect(messages.find(m => m.type === 'editRecorded')?.editId).toBe(record.id);
    expect(messages.find(m => m.type === 'editsSummary')?.pending).toHaveLength(1);
    expect(messages.findIndex(m => m.type === 'loadHistory')).toBeLessThan(messages.findIndex(m => m.type === 'editRecorded'));
  });

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

describe('image input bridge', () => {
  const images = [{ data: PNG, mime: 'image/png', name: 'screenshot.png' }];

  test.each([false, true])('image-only prompt and authoritative streaming=%s', async (streaming) => {
    const { provider, pi, messages } = createProvider();
    pi.getState.mockResolvedValue({ model: { input: ['text', 'image'] }, isStreaming: streaming });
    await provider.handleWebviewMessage({ type: 'prompt', submissionId: 'send-1', text: '', images, streaming: !streaming });
    expect(pi.prompt).toHaveBeenCalledWith('', images, streaming ? 'steer' : undefined);
    expect(messages.find(m => m.type === 'userMessage')).toMatchObject({ text: '', images, queued: streaming, submissionId: 'send-1' });
    expect(messages.find(m => m.type === 'promptResult')).toEqual({ type: 'promptResult', submissionId: 'send-1', success: true });
  });

  test('exposes image capability in live model state', async () => {
    const { provider, pi, messages } = createProvider();
    pi.getState.mockResolvedValue({ model: { input: ['text', 'image'] } });
    await provider.sendState();
    expect(messages[0].modelSupportsImages).toBe(true);
    pi.getState.mockResolvedValue({ model: { input: ['text'] } });
    await provider.sendState();
    expect(messages[1].modelSupportsImages).toBe(false);
  });

  test.each([
    { images, model: { input: ['text'] }, error: 'supports images' },
    { images: [{ data: PNG, mime: 'image/jpeg' }], model: { input: ['image'] }, error: 'MIME' },
    { images: [{ data: 'data:image/png;base64,' + PNG, mime: 'image/png' }], model: { input: ['image'] }, error: 'base64' },
  ])('invalid/unsupported input is rejected before echoing: %j', async ({ images, model, error }) => {
    const { provider, pi, edits, messages } = createProvider();
    pi.getState.mockResolvedValue({ model });
    await provider.handleWebviewMessage({ type: 'prompt', submissionId: 'bad', text: '', images });
    expect(pi.prompt).not.toHaveBeenCalled();
    expect(edits.snapshotWorkspace).not.toHaveBeenCalled();
    expect(messages.some(m => m.type === 'userMessage')).toBe(false);
    expect(messages.find(m => m.type === 'promptResult')).toMatchObject({ success: false, error: expect.stringContaining(error) });
  });

  test('RPC rejection acknowledges failure, then allows retry', async () => {
    const { provider, pi, messages } = createProvider();
    pi.prompt.mockResolvedValueOnce({ success: false, error: 'Authentication required' } as any);
    await provider.handleWebviewMessage({ type: 'prompt', submissionId: 'bad', text: 'Describe this' });
    expect(messages.find(m => m.type === 'promptResult')).toMatchObject({ success: false, error: expect.stringContaining('Authentication required') });
    expect(provider.promptPending).toBe(false);
    await provider.handleWebviewMessage({ type: 'prompt', submissionId: 'retry', text: 'Describe this' });
    expect(messages.filter(m => m.type === 'promptResult').at(-1)).toMatchObject({ submissionId: 'retry', success: true });
  });

  test('loading and in-flight submissions reject IPC with a correlated acknowledgment', async () => {
    const { provider, pi, messages } = createProvider(false);
    await provider.handleWebviewMessage({ type: 'prompt', submissionId: 'loading', text: 'Draft' });
    expect(messages[0]).toMatchObject({ type: 'promptResult', submissionId: 'loading', success: false });
    provider.historyLoading = false;
    let release!: (value: any) => void;
    pi.prompt.mockImplementationOnce(() => new Promise(resolve => { release = resolve; }));
    const pending = provider.handleWebviewMessage({ type: 'prompt', submissionId: 'one', text: 'First' });
    await Promise.resolve();
    await provider.handleWebviewMessage({ type: 'prompt', submissionId: 'two', text: 'Duplicate' });
    await provider.newSession();
    expect(pi.newSession).not.toHaveBeenCalled();
    expect(pi.prompt).toHaveBeenCalledTimes(1);
    expect(messages.find(m => m.submissionId === 'two')).toMatchObject({ success: false });
    release({ success: true });
    await pending;
  });

  test('rejects image-consuming extension commands but allows prompt templates', async () => {
    const { provider, pi, messages } = createProvider();
    pi.getState.mockResolvedValue({ model: { input: ['image'] } });
    pi.getCommands = async () => [{ name: 'name', source: 'extension' }, { name: 'review', source: 'prompt' }] as any;
    await provider.handleWebviewMessage({ type: 'prompt', submissionId: 'cmd', text: '/name x', images });
    expect(pi.prompt).not.toHaveBeenCalled();
    expect(messages.find(m => m.type === 'promptResult').error).toContain('Extension commands');
    await provider.handleWebviewMessage({ type: 'prompt', submissionId: 'template', text: '/review', images });
    expect(pi.prompt).toHaveBeenCalledWith('/review', images, undefined);
  });

  test('picker reads image bytes via workspace.fs and preserves ordinary file references', async () => {
    const { provider, messages } = createProvider();
    showOpenDialog.mockResolvedValue([parseUri('file:///workspace/a%20b.png'), parseUri('file:///workspace/code.ts')]);
    readFile.mockResolvedValue(Buffer.from(PNG, 'base64'));
    await provider.handleWebviewMessage({ type: 'selectFileToAttach', requestId: 'pick' });
    expect(readFile).toHaveBeenCalledTimes(1);
    expect(messages[0]).toMatchObject({ type: 'attachmentsSelected', requestId: 'pick', errors: [], attachments: [
      { id: 'file:///workspace/a%20b.png', type: 'image', name: 'a b.png', data: PNG, mime: 'image/png' },
      { type: 'file', name: 'code.ts', path: '/workspace/code.ts' },
    ] });
  });

  test('remote URI authority survives attachment ingestion; duplicates are read once', async () => {
    const { provider, messages } = createProvider();
    const uri = 'vscode-remote://ssh-remote+host/workspace/screenshot.png';
    readFile.mockResolvedValue(Buffer.from(PNG, 'base64'));
    await provider.handleWebviewMessage({ type: 'attachFiles', requestId: 'drop', uris: [uri, uri] });
    expect(readFile).toHaveBeenCalledTimes(1);
    expect((readFile.mock.calls[0][0] as any).toString()).toBe(uri);
    expect(messages[0].attachments[0]).toMatchObject({ id: uri, type: 'image', data: PNG });
  });

  test('cancelled picker always completes the read lifecycle', async () => {
    const { provider, messages } = createProvider();
    await provider.handleWebviewMessage({ type: 'selectFileToAttach', requestId: 'cancel' });
    expect(messages[0]).toEqual({ type: 'attachmentsSelected', requestId: 'cancel', attachments: [], errors: [] });
  });

  test('oversized, unreadable, and unsupported images report errors without payloads', async () => {
    const { provider, messages } = createProvider();
    stat.mockResolvedValueOnce({ type: 1, size: 5 * 1024 * 1024 });
    readFile.mockRejectedValueOnce(new Error('Permission denied'));
    readFile.mockResolvedValueOnce(Buffer.from('<svg width="1" height="1"></svg>'));
    await provider.handleWebviewMessage({ type: 'attachFiles', requestId: 'bad-files', uris: [
      'file:///large.png', 'file:///private.png', 'file:///vector.svg', 'https://example.com/image.png',
    ] });
    expect(messages[0].attachments).toEqual([]);
    expect(messages[0].errors).toHaveLength(4);
    expect(readFile).toHaveBeenCalledTimes(2);
  });

  test('RPC serializes images for prompts and steering without UI metadata or data URL prefixes', async () => {
    const { PiRpcClient } = await import('../src/piRpcClient.ts');
    const client = new PiRpcClient('pi', []);
    client.send = mock(async () => ({ type: 'response', command: 'prompt', success: true }));
    await client.prompt('', images, 'steer');
    expect(client.send).toHaveBeenCalledWith({ type: 'prompt', message: '', streamingBehavior: 'steer',
      images: [{ type: 'image', data: PNG, mimeType: 'image/png' }] });
    await client.steer('Look here', images);
    expect(client.send).toHaveBeenLastCalledWith({ type: 'steer', message: 'Look here',
      images: [{ type: 'image', data: PNG, mimeType: 'image/png' }] });
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
