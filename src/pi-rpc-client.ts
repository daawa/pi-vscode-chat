import { EventEmitter } from 'node:events';
import { RpcTransport, type TransportOptions } from './rpc/transport.ts';
import { isRecord } from './value-guards.ts';
import type {
  RpcCommand, RpcResponse, RpcEvent, PiCommandInfo, SessionStats, RpcState,
  ModelInfo, AgentMessage, SessionChangeResult, ThinkingLevel,
} from './rpc-types.ts';
import type { PromptImage } from './webview-types.ts';

type ClientEvents = {
  event: [event: RpcEvent];
  exit: [code: number | null, signal: NodeJS.Signals | null, stderr: string];
  transportError: [error: Error];
};

/** Typed pi operations; process ownership and JSONL framing live in RpcTransport. */
export class PiRpcClient extends EventEmitter<ClientEvents> {
  private readonly onRecord = (record: unknown) => {
    if (!isRecord(record) || typeof record.type !== 'string') return;
    // The child is the protocol boundary. Unknown/new event kinds are ignored by the bridge.
    this.emit('event', record as unknown as RpcEvent);
  };
  private readonly onExit = (code: number | null, signal: NodeJS.Signals | null, stderr: string) => {
    this.emit('exit', code, signal, stderr);
  };
  private readonly onError = (error: Error) => { this.emit('transportError', error); };

  constructor(private readonly options: TransportOptions = { command: 'pi' }, private readonly transport = new RpcTransport(options)) {
    super();
    transport.on('record', this.onRecord);
    transport.on('exit', this.onExit);
    transport.on('transportError', this.onError);
  }

  get isRunning(): boolean { return this.transport.isRunning; }
  start(sessionPath?: string): void {
    this.transport.start(['--mode', 'rpc', ...(sessionPath ? ['--session', sessionPath] : []), ...(this.options.args || [])]);
  }
  stop(): Promise<void> { return this.transport.stop(); }
  send(command: RpcCommand): Promise<RpcResponse> { return this.transport.request(command); }

  dispose(): void {
    this.transport.off('record', this.onRecord);
    this.transport.off('exit', this.onExit);
    this.transport.off('transportError', this.onError);
    this.transport.dispose();
    this.removeAllListeners();
  }

  prompt(text: string, images?: PromptImage[], streamingBehavior?: 'steer' | 'followUp'): Promise<RpcResponse> {
    return this.send({
      type: 'prompt', message: text,
      ...(images?.length ? { images: images.map(({ data, mime }) => ({ type: 'image' as const, data, mimeType: mime })) } : {}),
      ...(streamingBehavior ? { streamingBehavior } : {}),
    });
  }

  async steer(text: string, images?: PromptImage[]): Promise<boolean> {
    const response = await this.send({ type: 'steer', message: text,
      ...(images?.length ? { images: images.map(({ data, mime }) => ({ type: 'image' as const, data, mimeType: mime })) } : {}),
    });
    return response.success;
  }

  async abort(): Promise<void> { await this.send({ type: 'abort' }); }

  async getModels(): Promise<ModelInfo[]> {
    const data = responseData(await this.send({ type: 'get_available_models' }));
    return Array.isArray(data?.models) ? data.models.filter(isModelInfo) : [];
  }

  async getState(): Promise<RpcState | null> {
    const data = responseData(await this.send({ type: 'get_state' }));
    if (!data) return null;
    if (typeof data.isStreaming !== 'boolean' || (data.model != null && !isModelInfo(data.model))) {
      throw new Error('Invalid get_state response');
    }
    return data as unknown as RpcState;
  }

  async getMessages(): Promise<AgentMessage[]> {
    const response = await this.send({ type: 'get_messages' });
    const data = responseData(response);
    if (!response.success) throw new Error(response.error || 'Failed to load session history');
    if (!Array.isArray(data?.messages) || !data.messages.every(message => isRecord(message) && typeof message.role === 'string')) {
      throw new Error('Invalid get_messages response');
    }
    return data.messages as AgentMessage[];
  }

  async getCommands(): Promise<PiCommandInfo[]> {
    const data = responseData(await this.send({ type: 'get_commands' }));
    if (!Array.isArray(data?.commands)) return [];
    return data.commands.filter((command): command is PiCommandInfo => isRecord(command)
      && typeof command.name === 'string' && ['extension', 'prompt', 'skill'].includes(String(command.source)));
  }

  async getSessionStats(): Promise<SessionStats | null> {
    const data = responseData(await this.send({ type: 'get_session_stats' }));
    if (!data) return null;
    if (!['userMessages', 'assistantMessages', 'toolCalls', 'totalMessages'].every(key => typeof data[key] === 'number')) {
      throw new Error('Invalid get_session_stats response');
    }
    return data as unknown as SessionStats;
  }

  async setModel(provider: string, modelId: string): Promise<boolean> {
    return (await this.send({ type: 'set_model', provider, modelId })).success;
  }
  async setThinkingLevel(level: ThinkingLevel): Promise<boolean> {
    return (await this.send({ type: 'set_thinking_level', level })).success;
  }
  async newSession(): Promise<SessionChangeResult> {
    return sessionChangeResult(await this.send({ type: 'new_session' }));
  }
  async switchSession(sessionPath: string): Promise<SessionChangeResult> {
    return sessionChangeResult(await this.send({ type: 'switch_session', sessionPath }));
  }
  sendExtensionUiResponse(id: string, value?: string, confirmed?: boolean, cancelled?: boolean): void {
    const result = cancelled ? { cancelled: true } : confirmed !== undefined ? { confirmed } : value !== undefined ? { value } : {};
    this.transport.notify({ type: 'extension_ui_response', id, ...result });
  }
}

function responseData(response: RpcResponse): Record<string, unknown> | undefined {
  return response.success && isRecord(response.data) ? response.data : undefined;
}
function sessionChangeResult(response: RpcResponse): SessionChangeResult {
  if (!response.success) throw new Error(response.error || `${response.command} failed`);
  const data = responseData(response);
  if (typeof data?.cancelled !== 'boolean') throw new Error(`Invalid ${response.command} response`);
  return { cancelled: data.cancelled };
}
function isModelInfo(value: unknown): value is ModelInfo {
  return isRecord(value) && typeof value.id === 'string' && typeof value.provider === 'string'
    && Array.isArray(value.input) && value.input.every(input => input === 'text' || input === 'image');
}
