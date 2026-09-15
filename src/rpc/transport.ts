import { spawn, type ChildProcess, type SpawnOptions } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { StringDecoder } from 'node:string_decoder';
import type { RpcCommand, RpcResponse } from '../rpc-types.ts';
import { isRecord } from '../value-guards.ts';

export interface TransportOptions {
  command: string;
  args?: string[];
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  requestTimeoutMs?: number;
  shutdownTimeoutMs?: number;
}
export type SpawnProcess = (command: string, args: string[], options: SpawnOptions) => ChildProcess;
interface PendingRequest { command: string; resolve: (response: RpcResponse) => void; reject: (error: Error) => void }
interface Connection {
  child: ChildProcess;
  buffer: string;
  decoder: StringDecoder;
  stderr: string;
  pending: Map<string, PendingRequest>;
  exited: boolean;
  stopping: boolean;
  shutdownTimer?: ReturnType<typeof setTimeout>;
  done: Promise<void>;
  resolveDone: () => void;
}
type TransportEvents = {
  record: [record: unknown];
  exit: [code: number | null, signal: NodeJS.Signals | null, stderr: string];
  transportError: [error: Error];
};

/** Node-only JSONL transport. Every process owns its parser, requests and timers. */
export class RpcTransport extends EventEmitter<TransportEvents> {
  private current?: Connection;
  private connections = new Set<Connection>();
  private requestId = 0;
  private disposed = false;

  constructor(private readonly options: TransportOptions, private readonly spawnProcess: SpawnProcess = spawn) {
    super();
  }

  get isRunning(): boolean { return !!this.current && !this.current.stopping && !this.current.exited; }

  start(args: string[] = this.options.args || []): void {
    if (this.disposed) throw new Error('RPC transport is disposed');
    if (this.current) return;
    const child = this.spawnProcess(this.options.command, args, {
      cwd: this.options.cwd, env: this.options.env, stdio: ['pipe', 'pipe', 'pipe'],
    });
    let resolveDone!: () => void;
    const connection: Connection = {
      child, buffer: '', decoder: new StringDecoder('utf8'), stderr: '', pending: new Map(),
      exited: false, stopping: false, done: new Promise(resolve => { resolveDone = resolve; }), resolveDone,
    };
    this.current = connection;
    this.connections.add(connection);

    child.stdout?.on('data', (chunk: Buffer | string) => {
      if (this.current !== connection || connection.stopping) return;
      connection.buffer += typeof chunk === 'string' ? chunk : connection.decoder.write(chunk);
      this.processLines(connection);
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      if (this.current === connection) connection.stderr = chunk.toString().trim().slice(-4000);
    });
    child.stdin?.on('error', (error: Error) => {
      this.rejectPending(connection, error);
      if (this.current === connection && !connection.stopping) this.emit('transportError', error);
    });
    child.once('exit', (code, signal) => {
      const active = this.current === connection;
      this.finish(connection, new Error(`pi process exited (code=${code}): ${connection.stderr || 'Unknown error'}`));
      if (active) this.emit('exit', code, signal, connection.stderr);
    });
    child.once('error', (error: Error) => {
      const active = this.current === connection;
      this.finish(connection, error); // Spawn failures need not emit 'exit'.
      if (active) this.emit('transportError', error); // Not EventEmitter's special unhandled 'error' event.
    });
  }

  async stop(): Promise<void> {
    for (const connection of this.connections) this.stopConnection(connection);
    await Promise.all([...this.connections].map(connection => connection.done));
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    void this.stop();
    this.removeAllListeners();
  }

  request(command: RpcCommand): Promise<RpcResponse> {
    const connection = this.current;
    if (!connection || !this.isRunning) return Promise.reject(new Error('pi not running'));
    const id = command.id || `req-${++this.requestId}`;
    if (connection.pending.has(id)) return Promise.reject(new Error(`Duplicate RPC request id: ${id}`));
    const line = JSON.stringify({ ...command, id }) + '\n';
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        connection.pending.delete(id);
        reject(new Error(`RPC command ${command.type} timed out`));
      }, this.options.requestTimeoutMs ?? 60000);
      const pending = {
        command: command.type,
        resolve: (response: RpcResponse) => { clearTimeout(timeout); resolve(response); },
        reject: (error: Error) => { clearTimeout(timeout); reject(error); },
      };
      connection.pending.set(id, pending);
      try {
        if (!connection.child.stdin?.writable) throw new Error('pi stdin is not writable');
        connection.child.stdin.write(line, error => {
          if (!error) return;
          connection.pending.delete(id);
          pending.reject(error);
        });
      } catch (error) {
        connection.pending.delete(id);
        pending.reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  notify(value: unknown): void {
    const connection = this.current;
    if (!connection || !this.isRunning) return;
    try {
      connection.child.stdin?.write(JSON.stringify(value) + '\n', error => {
        if (error && this.current === connection) this.emit('transportError', error);
      });
    } catch (error) {
      this.emit('transportError', error instanceof Error ? error : new Error(String(error)));
    }
  }

  private stopConnection(connection: Connection): void {
    if (connection.stopping || connection.exited) return;
    connection.stopping = true;
    if (this.current === connection) this.current = undefined;
    this.rejectPending(connection, new Error('pi process stopped'));
    // Capture this exact child. child.killed only means a signal was sent, not that it exited.
    connection.shutdownTimer = setTimeout(() => {
      if (!connection.exited) connection.child.kill('SIGKILL');
    }, this.options.shutdownTimeoutMs ?? 3000);
    connection.shutdownTimer.unref?.();
    connection.child.kill('SIGTERM');
  }

  private finish(connection: Connection, error: Error): void {
    if (connection.exited) return;
    connection.exited = true;
    clearTimeout(connection.shutdownTimer);
    this.rejectPending(connection, error);
    connection.buffer = '';
    if (this.current === connection) this.current = undefined;
    this.connections.delete(connection);
    connection.resolveDone();
  }

  private rejectPending(connection: Connection, error: Error): void {
    for (const request of connection.pending.values()) request.reject(error);
    connection.pending.clear();
  }

  private processLines(connection: Connection): void {
    while (this.current === connection && !connection.stopping) {
      const end = connection.buffer.indexOf('\n');
      if (end < 0) return;
      let line = connection.buffer.slice(0, end);
      connection.buffer = connection.buffer.slice(end + 1);
      if (line.endsWith('\r')) line = line.slice(0, -1);
      if (!line) continue;
      let value: unknown;
      try { value = JSON.parse(line); }
      catch {
        // Never log the record or parser error: it can contain private image data.
        this.emit('transportError', new Error('Invalid JSON record from pi'));
        continue;
      }
      if (isRecord(value) && value.type === 'response') {
        if (typeof value.id !== 'string') continue;
        const pending = connection.pending.get(value.id);
        if (!pending) continue;
        connection.pending.delete(value.id);
        if (value.command !== pending.command || typeof value.success !== 'boolean') pending.reject(new Error('Invalid RPC response'));
        else pending.resolve(value as unknown as RpcResponse);
      } else {
        // Do not conflate an event-listener exception with a JSON parsing failure.
        this.emit('record', value);
      }
    }
  }
}
