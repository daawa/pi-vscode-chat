// ── RPC Message Types ──

export type RpcCommand = { id?: string } & (
  // Prompting
  | { type: 'prompt'; message: string; images?: RpcImage[]; streamingBehavior?: 'steer' | 'followUp' }
  | { type: 'steer'; message: string; images?: RpcImage[] }
  | { type: 'follow_up'; message: string; images?: RpcImage[] }
  | { type: 'abort' }
  | { type: 'clear_queue' }
  | { type: 'new_session'; parentSession?: string }
  // State
  | { type: 'get_state' }
  // Model
  | { type: 'set_model'; provider: string; modelId: string }
  | { type: 'cycle_model' }
  | { type: 'get_available_models' }
  // Thinking
  | { type: 'set_thinking_level'; level: ThinkingLevel }
  | { type: 'cycle_thinking_level' }
  | { type: 'get_available_thinking_levels' }
  // Queue modes
  | { type: 'set_steering_mode'; mode: 'all' | 'one-at-a-time' }
  | { type: 'set_follow_up_mode'; mode: 'all' | 'one-at-a-time' }
  // Compaction
  | { type: 'compact'; customInstructions?: string }
  | { type: 'set_auto_compaction'; enabled: boolean }
  // Retry
  | { type: 'set_auto_retry'; enabled: boolean }
  | { type: 'abort_retry' }
  // Bash
  | { type: 'bash'; command: string; excludeFromContext?: boolean }
  | { type: 'abort_bash' }
  // Session
  | { type: 'get_session_stats' }
  | { type: 'export_html'; outputPath?: string }
  | { type: 'switch_session'; sessionPath: string }
  | { type: 'fork'; entryId: string }
  | { type: 'clone' }
  | { type: 'get_fork_messages' }
  | { type: 'get_entries'; since?: string }
  | { type: 'get_tree' }
  | { type: 'get_last_assistant_text' }
  | { type: 'set_session_name'; name: string }
  // Messages
  | { type: 'get_messages' }
  // Commands (available for invocation via prompt)
  | { type: 'get_commands' }
);

/** What happened to a submitted prompt: an extension/input handler consumed it
 * ("handled"), it was queued during an active run ("queued"), or a run started ("started"). */
export type PromptDisposition = 'started' | 'queued' | 'handled';
/** What happened to a steer/follow_up: consumed by a handler or queued. */
export type QueuedInputDisposition = 'queued' | 'handled';

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
  steeringMode?: 'all' | 'one-at-a-time';
  followUpMode?: 'all' | 'one-at-a-time';
  autoCompactionEnabled?: boolean;
  messageCount?: number;
  pendingMessageCount?: number;
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

/** Extract a typed disposition from a prompt/steer/follow_up response. */
export function responseDisposition(response: RpcResponse): PromptDisposition | QueuedInputDisposition | undefined {
  const data = response.success && typeof response.data === 'object' && response.data !== null ? response.data as Record<string, unknown> : undefined;
  const disposition = data?.disposition;
  if (disposition === 'started' || disposition === 'queued' || disposition === 'handled') return disposition;
  return undefined;
}

// ── RPC Events (from pi stdout) ──

export type RpcEvent =
  | AgentStartEvent
  | AgentEndEvent
  | AgentSettledEvent
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
  | SummarizationRetryScheduledEvent
  | SummarizationRetryAttemptStartEvent
  | SummarizationRetryFinishedEvent
  | SessionInfoChangedEvent
  | ThinkingLevelChangedEvent
  | EntryAppendedEvent
  | BashExecutionUpdateEvent
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

/** Source metadata for the resource owning a slash command. */
export interface SourceInfo {
  path: string;
  source: string;
  scope: string;
  origin: string;
}

export interface PiCommandInfo {
  name: string;
  description?: string;
  source: 'extension' | 'prompt' | 'skill';
  sourceInfo?: SourceInfo;
  /** Deprecated: older pi versions sent top-level location/path instead of sourceInfo. */
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
  toolResults?: number;
  totalMessages: number;
  tokens?: { input: number; output: number; cacheRead: number; cacheWrite: number; total: number };
  cost?: number;
  contextUsage?: { tokens: number | null; contextWindow: number; percent: number | null };
}

export interface AgentStartEvent { type: 'agent_start' }
export interface AgentEndEvent {
  type: 'agent_end';
  messages: AgentMessage[];
  /** True when an automatic retry will start another low-level run. */
  willRetry?: boolean;
}
/** Pi has no remaining automatic work (retries, compaction recovery, queued input) for the run. */
export interface AgentSettledEvent { type: 'agent_settled'; aborted: boolean }
export interface TurnStartEvent { type: 'turn_start'; turnIndex?: number; timestamp?: number }
export interface TurnEndEvent { type: 'turn_end'; message?: AgentMessage; toolResults?: AgentMessage[]; turnIndex?: number }
export interface MessageStartEvent { type: 'message_start'; message: AgentMessage }
export interface MessageUpdateEvent {
  type: 'message_update';
  /** Deprecated: current pi omits the cumulative message on the wire; deltas build it. */
  message?: AgentMessage;
  /** Latest cumulative provider-reported usage for the assistant response. */
  usage?: Record<string, unknown>;
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
export interface CompactionStartEvent { type: 'compaction_start'; reason: 'manual' | 'threshold' | 'overflow' | string }
export interface CompactionEndEvent {
  type: 'compaction_end';
  reason: string;
  result?: unknown;
  aborted: boolean;
  /** True when successful overflow recovery will retry the prompt. */
  willRetry?: boolean;
  /** Present when compaction failed without being aborted. */
  errorMessage?: string;
}

export interface SummarizationRetryScheduledEvent {
  type: 'summarization_retry_scheduled';
  attempt: number;
  maxAttempts: number;
  delayMs: number;
  errorMessage?: string;
}
export interface SummarizationRetryAttemptStartEvent {
  type: 'summarization_retry_attempt_start';
  source: 'compaction' | 'branchSummary';
  reason?: 'manual' | 'threshold' | 'overflow' | string;
}
export interface SummarizationRetryFinishedEvent { type: 'summarization_retry_finished' }

/** The session display name changed; an absent name means it was cleared. */
export interface SessionInfoChangedEvent { type: 'session_info_changed'; name?: string }
export interface ThinkingLevelChangedEvent { type: 'thinking_level_changed'; level: ThinkingLevel }
/** An extension appended a custom session entry through pi.appendEntry(). */
export interface EntryAppendedEvent { type: 'entry_appended'; entry: unknown }
/** Output chunk from a direct RPC bash command; id matches the originating command. */
export interface BashExecutionUpdateEvent { type: 'bash_execution_update'; id?: string; delta: string }

export type AssistantMessageEvent =
  | { type: 'start' }
  | { type: 'text_start'; contentIndex: number }
  | { type: 'text_delta'; contentIndex: number; delta: string }
  | { type: 'text_end'; contentIndex: number; content: string }
  | { type: 'thinking_start'; contentIndex: number }
  | { type: 'thinking_delta'; contentIndex: number; delta: string }
  | { type: 'thinking_end'; contentIndex: number; content: string; /** Deprecated field name from older pi. */ thinking?: string }
  | { type: 'toolcall_start'; contentIndex: number; id?: string; toolName?: string }
  | { type: 'toolcall_delta'; contentIndex: number; delta: string }
  | { type: 'toolcall_end'; contentIndex: number; toolCall: ContentBlock }
  | { type: 'done'; reason: string; message?: AgentMessage }
  | { type: 'error'; reason: string; error?: AgentMessage };

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
