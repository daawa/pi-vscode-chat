import { afterEach, describe, expect, mock, test } from 'bun:test';
import { createProvider, EditManager, resetHostFixture } from './host-fixture.ts';
afterEach(resetHostFixture);

describe('session identity', () => {
  test.each([
    { sessionId: 'session-1', sessionName: 'Named session' },
    { sessionId: 'session-2' },
  ])('forwards live session metadata: %j', async (state) => {
    const { provider, pi, messages } = await createProvider();
    pi.getState.mockResolvedValue(state);
    await provider.session.sendState();
    expect(messages[0]).toMatchObject({ type: 'init', ...state });
    expect(messages[0].sessionName).toBe(state.sessionName);
  });

  test.each([false, true])('/name refreshes after completion while streaming=%s', async (streaming) => {
    const { provider, pi, edits, messages } = await createProvider();
    let renamed = false;
    pi.getState.mockImplementation(async () => ({
      sessionId: 'session-1', sessionName: renamed ? 'Normalized name' : 'Old name',
      isStreaming: streaming,
    }));
    pi.prompt.mockImplementation(async () => { renamed = true; return { success: true }; });
    await provider.handleMessage({ type: 'prompt', text: '/name new name', streaming });
    expect(pi.prompt).toHaveBeenCalledWith('/name new name', undefined, undefined);
    expect(edits.snapshotWorkspace).not.toHaveBeenCalled();
    expect(messages.filter(m => m.type === 'init')).toEqual([
      expect.objectContaining({ sessionId: 'session-1', sessionName: 'Normalized name', state: streaming ? 'streaming' : 'idle' }),
    ]);
  });

  test('runCommand also refreshes session state after the extension command', async () => {
    const { provider, pi, messages } = await createProvider();
    pi.prompt.mockImplementation(async () => {
      pi.getState.mockResolvedValue({ sessionId: 'session-1', sessionName: 'Renamed' });
      return { success: true };
    });
    await provider.handleMessage({ type: 'runCommand', command: '/name Renamed' });
    expect(messages[0]).toMatchObject({ type: 'init', sessionName: 'Renamed' });
  });

  test.each(['newSession', 'resumeSession'])('%s replaces the previous identity', async (type) => {
    const { provider, pi, messages } = await createProvider();
    pi.getState.mockResolvedValue({ sessionId: 'old', sessionName: 'Old name' });
    await provider.session.sendState();
    pi.getState.mockResolvedValue({ sessionId: 'new' });
    await provider.handleMessage({ type, filePath: '/session.jsonl' });
    await Promise.resolve();
    const state = messages.filter(m => m.type === 'init').at(-1);
    expect(state.sessionId).toBe('new');
    expect(state.sessionName).toBeUndefined();
  });

  test('an older state request cannot overwrite a rename', async () => {
    const { provider, pi, messages } = await createProvider();
    let release!: (value: any) => void;
    pi.getState.mockImplementationOnce(() => new Promise(resolve => { release = resolve; }));
    const pending = provider.session.sendState();
    pi.getState.mockResolvedValue({ sessionId: 'session-1', sessionName: 'New name' });
    await provider.session.sendState();
    release({ sessionId: 'session-1', sessionName: 'Old name' });
    await pending;
    expect(messages).toHaveLength(1);
    expect(messages[0].sessionName).toBe('New name');
  });


});

describe('session history loading', () => {
  test('reopening the webview restores review controls for retained snapshots', async () => {
    const manager = new EditManager();
    await manager.snapshotFile('/workspace/example.txt');
    const record = await manager.recordEdit('/workspace/example.txt', 'changed');
    const { provider, messages } = await createProvider(true, manager);
    await provider.session.loadHistory();
    expect(messages.find(m => m.type === 'editRecorded')?.editId).toBe(record.id);
    expect(messages.find(m => m.type === 'editsSummary')?.pending).toHaveLength(1);
    expect(messages.findIndex(m => m.type === 'loadHistory')).toBeLessThan(messages.findIndex(m => m.type === 'editRecorded'));
  });

  test('a superseded startup history load does not overwrite the new session', async () => {
    const { provider, pi, messages } = await createProvider();
    let release!: (value: any[]) => void;
    pi.getMessages = mock(() => new Promise<any[]>((resolve) => { release = resolve; }));

    const pending = provider.session.loadHistory();
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
    const { provider, pi, messages } = await createProvider(false);
    let release!: (value: any[]) => void;
    pi.getMessages = mock(() => new Promise<any[]>((resolve) => { release = resolve; }));
    await provider.handleMessage({ type: 'prompt', text: 'Too early' });
    const pending = provider.handleMessage({ type: 'ready' });
    await provider.handleMessage({ type: 'prompt', text: 'Still loading' });
    await provider.handleMessage({ type: 'runCommand', command: '/name Too early' });
    expect(pi.prompt).not.toHaveBeenCalled();
    expect(messages.some(m => m.type === 'userMessage')).toBe(false);

    release(history);
    await pending;
    expect(messages.filter(m => ['loadHistory', 'historyLoading'].includes(m.type))).toEqual([
      { type: 'historyLoading', loading: true },
      { type: 'loadHistory', messages: history },
      { type: 'historyLoading', loading: false },
    ]);
    await provider.handleMessage({ type: 'prompt', text: '/name Ready' });
    expect(pi.prompt).toHaveBeenCalledTimes(1);
  });

  test('failed history reports an error before unlocking without posting empty history', async () => {
    const { provider, pi, messages } = await createProvider(false);
    pi.getMessages = mock(async () => { throw new Error('RPC unavailable'); });
    await provider.session.loadHistory();
    expect(messages).toEqual([
      { type: 'historyLoading', loading: true },
      expect.objectContaining({ type: 'error', message: expect.stringContaining('RPC unavailable') }),
      { type: 'historyLoading', loading: false },
    ]);
    await provider.handleMessage({ type: 'runCommand', command: '/name Retry' });
    expect(pi.prompt).toHaveBeenCalledTimes(1);
  });

  test('an obsolete history request cannot unlock a newer load', async () => {
    const { provider, pi, messages } = await createProvider();
    const releases: ((value: any[]) => void)[] = [];
    pi.getMessages = mock(() => new Promise<any[]>(resolve => releases.push(resolve)));
    const oldLoad = provider.session.loadHistory();
    const newLoad = provider.session.loadHistory();
    releases[0]([]);
    await oldLoad;
    expect(provider.session.loading).toBe(true);
    expect(messages.some(m => m.type === 'loadHistory' || m.loading === false)).toBe(false);
    releases[1]([]);
    await newLoad;
    expect(provider.session.loading).toBe(false);
  });

  test('RPC history failures are not mistaken for an empty session', async () => {
    const { PiRpcClient } = await import('../src/pi-rpc-client.ts');
    const client = new PiRpcClient({ command: 'pi' });
    client.send = mock(async () => ({ type: 'response', command: 'get_messages', success: false, error: 'pi not running' }));
    await expect(client.getMessages()).rejects.toThrow('pi not running');
    client.send = mock(async () => ({ type: 'response', command: 'get_messages', success: true, data: { messages: [] } }));
    expect(await client.getMessages()).toEqual([]);
  });
});
