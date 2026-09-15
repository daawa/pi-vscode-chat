// ── RPC Message Types ──

export type RpcCommand = { id?: string } & (
  | { type: 'prompt'; message: string; images?: RpcImage[]; streamingBehavior?: 'steer' | 'followUp' }
  | { type: 'steer'; message: string; images?: RpcImage[] }
  | { type: 'abort' | 'get_available_models' | 'get_state' | 'get_messages' | 'get_commands' | 'get_session_stats' }
  | { type: 'set_model'; provider: string; modelId: string }
  | { type: 'set_thinking_level'; level: ThinkingLevel }
  | { type: 'new_session'; parentSession?: string }
  | { type: 'switch_session'; sessionPath: string }
);

export type ToolArgs = Record<string, unknown>;
export interface ContentBlock {
  type: string;
  text?: string;
  thinking?: string;
  data?: string;
  mimeType?: string;
  id?: string;
  name?: string;
  arguments?: ToolArgs;
}
export interface AgentMessage {
  role: string;
  content?: string | ContentBlock[];
  toolCallId?: string;
  toolName?: string;
  isError?: boolean;
  details?: Record<string, unknown>;
  summary?: string;
}
export interface ModelInfo {
  id: string;
  provider: string;
  name?: string;
  input: ('text' | 'image')[];
  reasoning?: boolean;
  contextWindow?: number;
  cost?: { input: number; output: number };
}
export interface RpcState {
  model?: ModelInfo | null;
  isStreaming: boolean;
  isCompacting?: boolean;
  thinkingLevel?: ThinkingLevel;
  sessionFile?: string;
  sessionId?: string;
  sessionName?: string;
}
export interface SessionChangeResult { cancelled: boolean }


export type ThinkingLevel = 'off' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max';

export interface RpcImage {
  type: 'image';
  data: string;
  mimeType: string;
}

export interface RpcResponse {
  type: 'response';
  command: string;
  success: boolean;
  error?: string;
  data?: unknown;
  id?: string;
}

// ── RPC Events (from pi stdout) ──

export type RpcEvent =
  | AgentStartEvent
  | AgentEndEvent
  | TurnStartEvent
  | TurnEndEvent
  | MessageStartEvent
  | MessageUpdateEvent
  | MessageEndEvent
  | ToolExecStartEvent
  | ToolExecUpdateEvent
  | ToolExecEndEvent
  | QueueUpdateEvent
  | CompactionStartEvent
  | CompactionEndEvent
  | AutoRetryStartEvent
  | AutoRetryEndEvent
  | ExtensionUiRequest
  | ExtensionErrorEvent;

export interface AutoRetryStartEvent {
  type: 'auto_retry_start';
  attempt: number;
  maxAttempts: number;
  delayMs: number;
  errorMessage?: string;
}
export interface AutoRetryEndEvent {
  type: 'auto_retry_end';
  success: boolean;
  attempt: number;
  finalError?: string;
}

// ── pi command metadata (get_commands) ──

export interface PiCommandInfo {
  name: string;
  description?: string;
  source: 'extension' | 'prompt' | 'skill';
  location?: 'user' | 'project' | 'path';
  path?: string;
}

// ── Session stats (get_session_stats) ──

export interface SessionStats {
  sessionFile?: string;
  sessionId?: string;
  userMessages: number;
  assistantMessages: number;
  toolCalls: number;
  totalMessages: number;
  tokens?: { input: number; output: number; cacheRead: number; cacheWrite: number; total: number };
  cost?: number;
  contextUsage?: { tokens: number | null; contextWindow: number; percent: number | null };
}

export interface AgentStartEvent { type: 'agent_start' }
export interface AgentEndEvent { type: 'agent_end'; messages: AgentMessage[] }
export interface TurnStartEvent { type: 'turn_start'; turnIndex?: number; timestamp?: number }
export interface TurnEndEvent { type: 'turn_end'; message?: AgentMessage; toolResults?: AgentMessage[]; turnIndex?: number }
export interface MessageStartEvent { type: 'message_start'; message: AgentMessage }
export interface MessageUpdateEvent {
  type: 'message_update';
  message?: AgentMessage;
  assistantMessageEvent: AssistantMessageEvent;
}
export interface MessageEndEvent { type: 'message_end'; message: AgentMessage }
export interface ToolExecStartEvent {
  type: 'tool_execution_start';
  toolCallId: string;
  toolName: string;
  args: ToolArgs;
}
export interface ToolExecUpdateEvent {
  type: 'tool_execution_update';
  toolCallId: string;
  toolName: string;
  args: ToolArgs;
  partialResult: { content?: ContentBlock[]; details?: Record<string, unknown> };
}
export interface ToolExecEndEvent {
  type: 'tool_execution_end';
  toolCallId: string;
  toolName: string;
  result?: { content?: ContentBlock[]; details?: Record<string, unknown> };
  isError: boolean;
}
export interface ExtensionErrorEvent { type: 'extension_error'; extensionPath?: string; event?: string; error?: string }

export interface QueueUpdateEvent {
  type: 'queue_update';
  steering: string[];
  followUp: string[];
}
export interface CompactionStartEvent { type: 'compaction_start'; reason: string }
export interface CompactionEndEvent {
  type: 'compaction_end';
  reason: string;
  result?: unknown;
  aborted: boolean;
}

export type AssistantMessageEvent =
  | { type: 'start' }
  | { type: 'text_start'; contentIndex: number }
  | { type: 'text_delta'; contentIndex: number; delta: string }
  | { type: 'text_end'; contentIndex: number; content: string }
  | { type: 'thinking_start'; contentIndex: number }
  | { type: 'thinking_delta'; contentIndex: number; delta: string }
  | { type: 'thinking_end'; contentIndex: number; thinking: string }
  | { type: 'toolcall_start'; contentIndex: number }
  | { type: 'toolcall_delta'; contentIndex: number; delta: string }
  | { type: 'toolcall_end'; contentIndex: number; toolCall: ContentBlock }
  | { type: 'done'; reason: string }
  | { type: 'error'; reason: string };

// ── Extension UI Request (pi → extension) ──

export type ExtensionUiRequest =
  | { type: 'extension_ui_request'; id: string; method: 'select'; title: string; options: string[]; timeout?: number }
  | { type: 'extension_ui_request'; id: string; method: 'confirm'; title: string; message: string; timeout?: number }
  | { type: 'extension_ui_request'; id: string; method: 'input'; title: string; placeholder?: string }
  | { type: 'extension_ui_request'; id: string; method: 'editor'; title: string; prefill?: string }
  | { type: 'extension_ui_request'; id: string; method: 'notify'; message: string; notifyType?: 'info' | 'warning' | 'error' }
  | { type: 'extension_ui_request'; id: string; method: 'setStatus'; statusKey: string; statusText?: string }
  | { type: 'extension_ui_request'; id: string; method: 'setWidget'; widgetKey: string; widgetLines?: string[]; widgetPlacement?: string }
  | { type: 'extension_ui_request'; id: string; method: 'setTitle'; title: string }
  | { type: 'extension_ui_request'; id: string; method: 'set_editor_text'; text: string };
