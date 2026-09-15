import { afterEach, describe, expect, mock, test } from 'bun:test';
import { createProvider, EditManager, readFile, resetHostFixture, toolEnd } from './host-fixture.ts';
import { PiRpcClient } from '../src/pi-rpc-client.ts';
afterEach(resetHostFixture);

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

describe('session transitions', () => {
  test.each(['newSession', 'resumeSession'] as const)('%s cancellation preserves history, draft, tools and Undo', async type => {
    const manager = new EditManager();
    await manager.snapshotFile('/workspace/file.txt');
    const edit = await manager.recordEdit('/workspace/file.txt', 'modified');
    const { provider, pi, messages } = await createProvider(true, manager);
    pi.newSession.mockResolvedValue({ cancelled: true });
    pi.switchSession.mockResolvedValue({ cancelled: true });
    await provider.handleMessage(type === 'newSession' ? { type } : { type, filePath: '/new.jsonl' });
    expect(messages.some(message => ['clearComposer', 'sessionCleared', 'loadHistory', 'error'].includes(message.type))).toBe(false);
    expect(manager.getPendingEdits()[0].id).toBe(edit.id);
    expect(pi.stop).not.toHaveBeenCalled();
    expect(pi.start).not.toHaveBeenCalled();
    expect(provider.session.loading).toBe(false);
    await provider.handleMessage({ type: 'prompt', text: 'Draft retry', submissionId: 'retry' });
    expect(messages.find(message => message.type === 'promptResult')).toMatchObject({ submissionId: 'retry', success: true });
  });

  test('failed switch reports the failure without an implicit restart or clearing the composer', async () => {
    const { provider, pi, edits, messages } = await createProvider();
    pi.switchSession.mockRejectedValue(new Error('Session unavailable'));
    await provider.session.resumeSession('/missing.jsonl');
    expect(messages.find(message => message.type === 'error').message).toContain('Session unavailable');
    expect(messages.some(message => message.type === 'clearComposer')).toBe(false);
    expect(edits.clear).not.toHaveBeenCalled();
    expect(pi.start).not.toHaveBeenCalled();
    expect(pi.stop).not.toHaveBeenCalled();
    expect(provider.session.loading).toBe(false);
  });

  test('only one session change runs at a time; prompts and commands stay gated', async () => {
    const { provider, pi, messages } = await createProvider();
    const change = deferred<{ cancelled: boolean }>();
    pi.newSession.mockImplementation(() => change.promise);
    const pending = provider.newSession();
    await provider.newSession();
    await provider.session.resumeSession('/other.jsonl');
    await provider.handleMessage({ type: 'prompt', text: 'Wait', submissionId: 'blocked' });
    await provider.handleMessage({ type: 'runCommand', command: '/name Wait' });
    expect(pi.newSession).toHaveBeenCalledTimes(1);
    expect(pi.switchSession).not.toHaveBeenCalled();
    expect(pi.prompt).not.toHaveBeenCalled();
    expect(messages.find(message => message.type === 'promptResult')).toMatchObject({ success: false });
    change.resolve({ cancelled: true });
    await pending;
    expect(provider.session.loading).toBe(false);
  });

  test('an in-flight extension command cannot race a session switch', async () => {
    const { provider, pi } = await createProvider();
    const command = deferred<{ success: boolean }>();
    pi.prompt.mockImplementation(() => command.promise);
    const pending = provider.session.runCommand('/name Name');
    await provider.newSession();
    expect(pi.newSession).not.toHaveBeenCalled();
    command.resolve({ success: true });
    await pending;
    expect(provider.session.submitting).toBe(false);
  });

  test('cancel during startup reloads current history instead of publishing the superseded request', async () => {
    const { provider, pi, messages } = await createProvider(false);
    const old = deferred<any[]>();
    pi.getMessages.mockImplementationOnce(() => old.promise);
    const loading = provider.session.loadHistory();
    pi.getMessages.mockResolvedValue([{ role: 'user', content: 'Current' }]);
    pi.newSession.mockResolvedValue({ cancelled: true });
    await provider.newSession();
    old.resolve([{ role: 'user', content: 'Stale' }]);
    await loading;
    expect(messages.filter(message => message.type === 'loadHistory')).toEqual([
      { type: 'loadHistory', messages: [{ role: 'user', content: 'Current' }] },
    ]);
    expect(provider.session.loading).toBe(false);
    expect(messages.some(message => message.type === 'init')).toBe(true);
  });

  test('ready during a switch waits until the target session is authoritative', async () => {
    const { provider, pi, messages } = await createProvider();
    pi.getMessages.mockClear();
    const change = deferred<{ cancelled: boolean }>();
    pi.switchSession.mockImplementation(() => change.promise);
    const pending = provider.session.resumeSession('/target.jsonl');
    const ready = provider.session.ready();
    expect(pi.getMessages).not.toHaveBeenCalled();
    pi.getMessages.mockResolvedValue([{ role: 'user', content: 'Target' }]);
    change.resolve({ cancelled: false });
    await Promise.all([pending, ready]);
    const histories = messages.filter(message => message.type === 'loadHistory');
    expect(histories.length).toBeGreaterThan(0);
    expect(histories.every(message => message.messages[0].content === 'Target')).toBe(true);
    expect(provider.session.loading).toBe(false);
  });

  test('offline resume waits for shutdown before starting a replacement', async () => {
    const { provider, pi } = await createProvider();
    pi.isRunning = false;
    const shutdown = deferred<void>();
    pi.stop.mockImplementation(() => shutdown.promise);
    pi.start.mockImplementation(() => { pi.isRunning = true; });
    const pending = provider.session.resumeSession('/target.jsonl');
    expect(pi.start).not.toHaveBeenCalled();
    shutdown.resolve();
    await pending;
    expect(pi.stop).toHaveBeenCalledTimes(1);
    expect(pi.start).toHaveBeenCalledWith('/target.jsonl');
  });

  test('dispose during offline shutdown cannot restart the process', async () => {
    const { provider, pi } = await createProvider();
    pi.isRunning = false;
    const shutdown = deferred<void>();
    pi.stop.mockImplementation(() => shutdown.promise);
    const pending = provider.session.resumeSession('/target.jsonl');
    provider.dispose();
    shutdown.resolve();
    await pending;
    expect(pi.start).not.toHaveBeenCalled();
  });
});

describe('late asynchronous work', () => {
  test('a previous session tool completion cannot create edits or diffs in the new session', async () => {
    const { provider, edits, messages } = await createProvider();
    const content = deferred<Buffer>();
    readFile.mockImplementation(() => content.promise);
    const pending = provider.events.handleToolEnd(toolEnd(false));
    await Promise.resolve(); // Begin the post-tool filesystem read.
    await provider.newSession();
    content.resolve(Buffer.from('late file contents'));
    await pending;
    expect(edits.recordEdit).not.toHaveBeenCalled();
    expect(messages.some(message => message.type === 'toolDiff')).toBe(false);
    expect(messages.filter(message => message.type === 'toolEnd')).toHaveLength(1);
  });

  test('clearing EditManager invalidates a record awaiting its snapshot', async () => {
    const manager = new EditManager();
    const content = deferred<Buffer>();
    readFile.mockImplementation(() => content.promise);
    const snapshot = manager.snapshotFile('/workspace/file.txt');
    const pending = manager.recordEdit('/workspace/file.txt', 'new').catch(error => error);
    manager.clear();
    content.resolve(Buffer.from('old'));
    await snapshot;
    expect((await pending).message).toContain('Session changed');
    expect(manager.getPendingEdits()).toEqual([]);
    manager.dispose();
  });

  test('disposed state/history/stats requests cannot post or persist stale metadata', async () => {
    const { provider, pi, messages, workspaceState } = await createProvider();
    const state = deferred<any>(); const history = deferred<any[]>(); const stats = deferred<any>();
    pi.getState.mockImplementation(() => state.promise);
    pi.getMessages.mockImplementation(() => history.promise);
    pi.getSessionStats.mockImplementation(() => stats.promise);
    const requests = [provider.session.loadHistory(), provider.session.sendState(), provider.session.sendStats()];
    provider.dispose(); messages.length = 0;
    state.resolve({ sessionFile: '/stale.jsonl' }); history.resolve([]); stats.resolve({ cost: 1 });
    await Promise.all(requests);
    expect(messages).toEqual([]);
    expect(workspaceState.update).not.toHaveBeenCalled();
  });

  test('an old stats request cannot overwrite stats for a new session', async () => {
    const { provider, pi, messages } = await createProvider();
    const stats = deferred<any>();
    pi.getSessionStats.mockImplementationOnce(() => stats.promise);
    const pending = provider.session.sendStats();
    pi.getSessionStats.mockResolvedValue({ cost: 2 });
    await provider.newSession();
    stats.resolve({ cost: 1 }); await pending;
    expect(messages.filter(message => message.type === 'stats')).toEqual([{ type: 'stats', stats: { cost: 2 } }]);
  });
});

describe('typed session RPC outcomes', () => {
  test.each(['new_session', 'switch_session'] as const)('%s distinguishes cancellation, acceptance and errors', async command => {
    const client = new PiRpcClient();
    const invoke = () => command === 'new_session' ? client.newSession() : client.switchSession('/target.jsonl');
    for (const cancelled of [true, false]) {
      client.send = mock(async () => ({ type: 'response', command, success: true, data: { cancelled } }));
      expect(await invoke()).toEqual({ cancelled });
    }
    client.send = mock(async () => ({ type: 'response', command, success: false, error: 'Denied' }));
    await expect(invoke()).rejects.toThrow('Denied');
    client.send = mock(async () => ({ type: 'response', command, success: true, data: {} }));
    await expect(invoke()).rejects.toThrow('Invalid');
    client.dispose();
  });
});
