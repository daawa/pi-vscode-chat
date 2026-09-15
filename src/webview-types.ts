import type { AgentMessage, ExtensionUiRequest, PiCommandInfo, SessionStats, ThinkingLevel } from './rpc-types.ts';

export interface SessionInfo { id: string; title: string; filePath: string; date: string; mtime: number }
export type PostMessage = (message: WebviewOutMessage) => void;

// ── Webview Messages (extension ↔ webview) ──

export type ChatStyle = 'default' | 'custom';

export interface PromptImage {
  data: string;
  mime: string;
  name?: string;
}
export type FileAttachment = { id: string; type: 'file'; name: string; path: string };
export type ImageAttachment = PromptImage & { id: string; type: 'image'; name: string };
export type Attachment = FileAttachment | ImageAttachment;

export type WebviewMessage =
  | { type: 'prompt'; text: string; images?: PromptImage[]; streaming?: boolean; submissionId?: string }
  | { type: 'abort' }
  | { type: 'revertEdit'; editId: string }
  | { type: 'acceptEdit'; editId: string }
  | { type: 'revertAllEdits' }
  | { type: 'acceptAllEdits' }
  | { type: 'showDiff'; editId: string }
  | { type: 'openFile'; path: string; line?: number; column?: number }
  | { type: 'selectModel' }
  | { type: 'configureProvider' }
  | { type: 'selectStyle'; currentStyle: ChatStyle }
  | { type: 'setThinkingLevel'; level: ThinkingLevel }
  | { type: 'newSession' }
  | { type: 'reloadExtensions' }
  | { type: 'ready' }
  | { type: 'runCommand'; command: string }
  | { type: 'searchFile'; query: string }
  | { type: 'selectFileToAttach'; requestId: string }
  | { type: 'attachFiles'; requestId: string; uris: string[] }
  | { type: 'getSessions' }
  | { type: 'resumeSession'; filePath: string }
  | { type: 'extensionUiResponse'; id: string; value?: string; confirmed?: boolean; cancelled?: boolean };

export type WebviewOutMessage =
  | { type: 'init'; model: string; modelReasoning: boolean; modelSupportsImages: boolean; thinkingLevel: string; state: 'idle' | 'streaming'; sessionName?: string; sessionId?: string }
  | { type: 'commands'; commands: PiCommandInfo[] }
  | { type: 'styleSelected'; style: ChatStyle }
  | { type: 'stats'; stats: SessionStats | null }
  | { type: 'attachmentsSelected'; requestId: string; attachments: Attachment[]; errors: string[] }
  | { type: 'promptResult'; submissionId: string; success: boolean; error?: string }
  | { type: 'clearComposer' }
  | { type: 'loadHistory'; messages: AgentMessage[] }
  | { type: 'historyLoading'; loading: boolean }
  | { type: 'sessionsList'; sessions: SessionInfo[] }
  | { type: 'agentStart' }
  | { type: 'agentEnd' }
  | { type: 'textDelta'; messageId: string; delta: string }
  | { type: 'thinkingDelta'; messageId: string; blockIndex: number; delta: string }
  | { type: 'thinkingEnd'; messageId: string; blockIndex: number; content: string }
  | { type: 'toolStart'; messageId: string; toolCallId: string; toolName: string; args: string }
  | { type: 'toolUpdate'; toolCallId: string; output: string }
  | { type: 'toolEnd'; messageId: string; toolCallId: string; toolName: string; isError: boolean; output?: string }
  | { type: 'toolDiff'; toolCallId: string; diff: string; filePath: string; fileContent?: string }
  | { type: 'userMessage'; text: string; images?: PromptImage[]; files?: string[]; queued?: boolean; submissionId?: string }
  | { type: 'fileResults'; query: string; results: { label: string; path: string }[] }
  | { type: 'setInputText'; text: string; append?: boolean }
  | { type: 'editRecorded'; filePath: string; editId: string; diff: string }
  | { type: 'editReverted'; filePath: string; editId: string }
  | { type: 'editAccepted'; filePath: string; editId: string }
  | { type: 'editsSummary'; pending: { editId: string; filePath: string }[] }
  | { type: 'queueUpdate'; steering: string[]; followUp: string[] }
  | { type: 'retryStatus'; text: string | null }
  | { type: 'compactionStatus'; text: string | null }
  | { type: 'sessionCleared' }
  | { type: 'extensionUiRequest'; id: string; method: string; data: ExtensionUiRequest }
  | { type: 'stateChange'; state: 'idle' | 'streaming' }
  | { type: 'error'; message: string };
