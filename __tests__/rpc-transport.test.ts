import { afterEach, beforeEach, describe, expect, jest, mock, test } from 'bun:test';
import { EventEmitter } from 'node:events';
import type { ChildProcess } from 'node:child_process';
import { RpcTransport } from '../src/rpc/transport.ts';
import { PiRpcClient } from '../src/pi-rpc-client.ts';

class FakeChild extends EventEmitter {
  stdout = new EventEmitter();
  stderr = new EventEmitter();
  writes: string[] = [];
  killed = false;
  stdin = Object.assign(new EventEmitter(), {
    writable: true,
    write: mock((line: string, callback?: (error?: Error) => void) => { this.writes.push(line); callback?.(); return true; }),
  });
  kill = mock((_signal?: string) => { this.killed = true; return true; });
  record(value: unknown) { this.stdout.emit('data', Buffer.from(JSON.stringify(value) + '\n')); }
  reply(index = 0, data: unknown = {}) {
    const request = JSON.parse(this.writes[index]);
    this.record({ type: 'response', command: request.type, id: request.id, success: true, data });
  }
}
const fixtures: { transport: RpcTransport; children: FakeChild[] }[] = [];
function fixture() {
  const children: FakeChild[] = [];
  const spawn = mock(() => { const child = new FakeChild(); children.push(child); return child as unknown as ChildProcess; });
  const options = { command: '/fake/pi', args: ['--verbose'], cwd: '/workspace', env: { PATH: '/fake/bin' },
    requestTimeoutMs: 50, shutdownTimeoutMs: 10 };
  const transport = new RpcTransport(options, spawn);
  fixtures.push({ transport, children });
  transport.start();
  return { transport, children, spawn, options };
}
beforeEach(() => jest.useFakeTimers());
afterEach(() => {
  for (const { transport, children } of fixtures.splice(0)) {
    transport.dispose();
    for (const child of children) child.emit('exit', 0, null);
  }
  jest.useRealTimers();
});

describe('RPC process ownership', () => {
  test('passes explicit launch context; PiRpcClient owns RPC argument construction', () => {
    const { transport, spawn, options } = fixture();
    expect(spawn).toHaveBeenCalledWith('/fake/pi', ['--verbose'], {
      cwd: '/workspace', env: { PATH: '/fake/bin' }, stdio: ['pipe', 'pipe', 'pipe'],
    });
    const second = new RpcTransport(options, spawn);
    const client = new PiRpcClient(options, second);
    client.start('/sessions/one.jsonl');
    expect(spawn.mock.calls.at(-1)?.[1]).toEqual(['--mode', 'rpc', '--session', '/sessions/one.jsonl', '--verbose']);
    second.emit('exit', 0, null, '');
    client.dispose();
    expect(transport.isRunning).toBe(true);
  });

  test('shutdown timer targets the old child even after a new child starts', async () => {
    const { transport, children } = fixture();
    const stopped = transport.stop();
    const old = children[0];
    expect(old.killed).toBe(true); // A successfully sent SIGTERM does not mean the process exited.
    transport.start();
    jest.advanceTimersByTime(10);
    expect(old.kill.mock.calls).toEqual([['SIGTERM'], ['SIGKILL']]);
    expect(children[1].kill).not.toHaveBeenCalled();
    old.emit('exit', null, 'SIGKILL');
    await stopped;
    expect(transport.isRunning).toBe(true);
  });

  test('old exit/output cannot clear the replacement or resolve its requests', async () => {
    const { transport, children } = fixture();
    const exited = mock(() => {});
    transport.on('exit', exited);
    const stopped = transport.stop();
    transport.start();
    const pending = transport.request({ type: 'get_state', id: 'new-request' });
    children[0].record({ type: 'response', command: 'get_state', id: 'new-request', success: true, data: 'stale' });
    children[0].emit('exit', 1, null);
    await stopped;
    expect(exited).not.toHaveBeenCalled();
    expect(transport.isRunning).toBe(true);
    children[1].reply(0, 'fresh');
    expect((await pending).data).toBe('fresh');
  });

  test('stop rejects pending requests and waits for exit; graceful exit cancels escalation', async () => {
    const { transport, children } = fixture();
    const request = transport.request({ type: 'get_state' });
    const rejected = request.catch(error => error);
    let finished = false;
    const stopped = transport.stop().then(() => { finished = true; });
    expect((await rejected).message).toContain('stopped');
    expect(finished).toBe(false);
    children[0].emit('exit', 0, null);
    await stopped;
    jest.advanceTimersByTime(100);
    expect(children[0].kill.mock.calls).toEqual([['SIGTERM']]);
  });

  test('spawn failure rejects requests, surfaces a non-special error event, and permits retry', async () => {
    const { transport, children } = fixture();
    const error = mock(() => {});
    transport.on('transportError', error);
    const pending = transport.request({ type: 'get_state' });
    children[0].emit('error', new Error('ENOENT'));
    await expect(pending).rejects.toThrow('ENOENT');
    expect(error).toHaveBeenCalledTimes(1);
    expect(transport.isRunning).toBe(false);
    transport.start();
    expect(transport.isRunning).toBe(true);
  });

  test('stdin errors reject pending requests instead of leaving them until timeout', async () => {
    const { transport, children } = fixture();
    const pending = transport.request({ type: 'get_state' });
    expect(() => children[0].stdin.emit('error', new Error('EPIPE'))).not.toThrow();
    await expect(pending).rejects.toThrow('EPIPE');
  });

  test('extension UI replies preserve cancellation/confirmation/value precedence without pending RPCs', () => {
    const { transport, children, options } = fixture();
    const client = new PiRpcClient(options, transport);
    client.sendExtensionUiResponse('cancel', 'ignored', false, true);
    client.sendExtensionUiResponse('confirm', 'ignored', false);
    client.sendExtensionUiResponse('input', 'typed text');
    expect(children[0].writes.map(line => JSON.parse(line))).toEqual([
      { type: 'extension_ui_response', id: 'cancel', cancelled: true },
      { type: 'extension_ui_response', id: 'confirm', confirmed: false },
      { type: 'extension_ui_response', id: 'input', value: 'typed text' },
    ]);
    client.dispose();
  });

  test('disposed transport cannot restart and emits no further records', () => {
    const { transport, children } = fixture();
    const record = mock(() => {});
    transport.on('record', record);
    transport.dispose(); transport.dispose();
    children[0].record({ type: 'agent_start' });
    expect(record).not.toHaveBeenCalled();
    expect(() => transport.start()).toThrow('disposed');
    expect(transport.listenerCount('record')).toBe(0);
  });
});

describe('JSONL framing and requests', () => {
  test('handles split UTF-8, CRLF, blank lines and multiple records', () => {
    const { transport, children } = fixture();
    const records: unknown[] = [];
    transport.on('record', record => records.push(record));
    const data = Buffer.from('\r\n' + JSON.stringify({ type: 'text_delta', text: '你好 🌍' }) + '\r\n{"type":"agent_end"}\n');
    for (const byte of data) children[0].stdout.emit('data', Buffer.from([byte]));
    expect(records).toEqual([{ type: 'text_delta', text: '你好 🌍' }, { type: 'agent_end' }]);
  });

  test('new process starts with a fresh buffer and decoder', async () => {
    const { transport, children } = fixture();
    const records: unknown[] = [];
    transport.on('record', record => records.push(record));
    children[0].stdout.emit('data', Buffer.concat([Buffer.from('{"partial":"'), Buffer.from([0xf0, 0x9f])]));
    const stopped = transport.stop();
    children[0].emit('exit', 0, null);
    await stopped;
    transport.start();
    children[1].record({ type: 'agent_start' });
    expect(records).toEqual([{ type: 'agent_start' }]);
  });

  test('stops draining an old batch when an event listener replaces the process', () => {
    const { transport, children } = fixture();
    const records: unknown[] = [];
    transport.on('record', record => { records.push(record); void transport.stop(); transport.start(); });
    children[0].stdout.emit('data', Buffer.from('{"type":"first"}\n{"type":"stale"}\n'));
    expect(records).toEqual([{ type: 'first' }]);
  });

  test('correlates out-of-order responses and rejects duplicate outstanding IDs', async () => {
    const { transport, children } = fixture();
    const first = transport.request({ type: 'get_state', id: 'one' });
    const second = transport.request({ type: 'get_commands' });
    await expect(transport.request({ type: 'get_state', id: 'one' })).rejects.toThrow('Duplicate');
    children[0].reply(1, 'second'); children[0].reply(0, 'first');
    expect((await first).data).toBe('first');
    expect((await second).data).toBe('second');
  });

  test('timeouts release IDs, and unknown response IDs are ignored', async () => {
    const { transport, children } = fixture();
    const pending = transport.request({ type: 'get_state', id: 'one' });
    const rejected = pending.catch(error => error);
    jest.advanceTimersByTime(50);
    expect((await rejected).message).toContain('timed out');
    children[0].record({ type: 'response', command: 'get_state', id: 'unknown', success: true });
    const next = transport.request({ type: 'get_state', id: 'one' });
    children[0].reply(1);
    expect((await next).success).toBe(true);
  });

  test('rejects malformed/mismatched responses without resolving the wrong command', async () => {
    const { transport, children } = fixture();
    const pending = transport.request({ type: 'get_state', id: 'one' });
    children[0].record({ type: 'response', command: 'new_session', id: 'one', success: true });
    await expect(pending).rejects.toThrow('Invalid RPC response');
  });

  test('malformed JSON is redacted; subsequent records are still processed', () => {
    const { transport, children } = fixture();
    const errors: Error[] = []; const records: unknown[] = [];
    transport.on('transportError', error => errors.push(error));
    transport.on('record', record => records.push(record));
    children[0].stdout.emit('data', Buffer.from('PRIVATE_IMAGE_INVALID_JSON\n{"type":"agent_start"}\n'));
    expect(errors.map(error => error.message)).toEqual(['Invalid JSON record from pi']);
    expect(records).toEqual([{ type: 'agent_start' }]);
  });

  test('a listener failure is not reported as a JSON parse failure', () => {
    const { transport, children } = fixture();
    const error = mock(() => {});
    transport.on('transportError', error);
    transport.on('record', () => { throw new Error('listener failed'); });
    expect(() => children[0].record({ type: 'agent_start' })).toThrow('listener failed');
    expect(error).not.toHaveBeenCalled();
  });

  test('real child completes a JSONL round trip and shuts down cleanly', async () => {
    jest.useRealTimers();
    const program = `require('node:readline').createInterface({input: process.stdin}).on('line', line => {
      const request = JSON.parse(line);
      process.stdout.write(JSON.stringify({type:'response', command:request.type, id:request.id, success:true, data:{text:'你好 🌍'}})+'\\n');
    });`;
    const transport = new RpcTransport({ command: process.execPath, args: ['-e', program], requestTimeoutMs: 2000, shutdownTimeoutMs: 100 });
    try {
      transport.start();
      expect((await transport.request({ type: 'get_state' })).data).toEqual({ text: '你好 🌍' });
      await transport.stop();
      expect(transport.isRunning).toBe(false);
    } finally { transport.dispose(); }
  });
});
