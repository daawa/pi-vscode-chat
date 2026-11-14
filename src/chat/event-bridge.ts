import * as vscode from 'vscode';
import * as path from 'node:path';
import type { PiRpcClient } from '../pi-rpc-client.ts';
import type { EditManager } from '../edit-manager.ts';
import type { SessionController } from './session-controller.ts';
import type { PostMessage } from '../webview-types.ts';
import type { EditRecord } from '../edit-types.ts';
import type { RpcEvent, ExtensionUiRequest, ToolArgs, ToolExecStartEvent, ToolExecEndEvent, MessageUpdateEvent } from '../rpc-types.ts';

export class EventBridge implements vscode.Disposable {
  private toolCalls = new Map<string, { args: ToolArgs; snapshot?: Promise<unknown> }>();
  private disposed = false;
  private epoch = 0;
  /** True once pi has emitted agent_settled: current protocol, rely on it exclusively. */
  private settledSeen = false;
  /** True while the UI shows an unsettled run; guards against double agentEnd. */
  private runSettled = true;
  /** Fallback settle timer for pi builds that never emit agent_settled. */
  private settleTimer?: ReturnType<typeof setTimeout>;
  /** Coalesces bursty state-refresh events into one RPC round trip. */
  private refreshTimer?: ReturnType<typeof setTimeout>;
  private readonly editSubscription: vscode.Disposable;
  private readonly onEvent = (event: RpcEvent) => { void this.handle(event).catch(this.onError); };
  private readonly onError = (error: unknown) => {
    if (!this.disposed) this.postMessage({ type: 'error', message: `Pi: ${error instanceof Error ? error.message : String(error)}` });
  };
  private readonly onExit = (code: number | null, _signal: string | null, stderr?: string) => {
    this.reset();
    this.session.setStreaming(false);
    this.postMessage({ type: 'agentEnd' });
    this.postMessage({ type: 'error', message: `pi process exited (code=${code}${stderr ? `: ${stderr}` : ''}). The next message restarts pi.` });
  };

  constructor(
    private readonly pi: PiRpcClient,
    private readonly edits: EditManager,
    private readonly session: SessionController,
    private readonly postMessage: PostMessage,
  ) {
    pi.on('event', this.onEvent);
    pi.on('exit', this.onExit);
    pi.on('transportError', this.onError);
    this.editSubscription = edits.onDidChange(record => this.onEditChanged(record));
  }

  reset(): void {
    this.epoch++;
    this.toolCalls.clear();
    this.clearSettleTimer();
    this.runSettled = true;
  }
  dispose(): void {
    this.disposed = true;
    this.reset();
    this.clearRefreshTimer();
    this.pi.off('event', this.onEvent);
    this.pi.off('exit', this.onExit);
    this.pi.off('transportError', this.onError);
    this.editSubscription.dispose();
  }

  async handle(event: RpcEvent): Promise<void> {
    if (this.disposed) return;
    switch (event.type) {
      case 'agent_start':
        this.clearSettleTimer();
        this.runSettled = false;
        this.session.setStreaming(true);
        this.postMessage({ type: 'agentStart' });
        this.edits.snapshotWorkspace().catch(() => {});
        break;

      case 'agent_end':
        // agent_end closes one low-level run, but retries, overflow recovery,
        // compaction, or queued steering/follow-up can start another. Once pi has
        // proven it emits agent_settled, that event is the sole idle marker; older
        // pi builds fall back to a short grace period after the last agent_end.
        if (event.willRetry || this.settledSeen) break;
        this.scheduleSettle();
        break;

      case 'agent_settled':
        this.settledSeen = true;
        this.clearSettleTimer();
        this.settleRun();
        break;

      case 'turn_start':
        // Turn boundaries let the webview split the assistant bubble when a steer
        // was interleaved, so the steered reply renders below the user message.
        this.postMessage({ type: 'turnStart' });
        break;

      case 'message_update':
        this.handleMessageUpdate(event);
        break;

      case 'tool_execution_start':
        this.handleToolStart(event);
        break;

      case 'tool_execution_update': {
        const partial = event.partialResult;
        const outputText = (partial?.content || [])
          .map((c) => c.text || '')
          .join('');
        if (outputText) {
          this.postMessage({ type: 'toolUpdate', toolCallId: event.toolCallId, output: outputText });
        }
        break;
      }

      case 'tool_execution_end':
        await this.handleToolEnd(event);
        break;

      case 'queue_update':
        this.postMessage({ type: 'queueUpdate', steering: event.steering || [], followUp: event.followUp || [] });
        break;

      case 'auto_retry_start':
        this.postMessage({
          type: 'retryStatus',
          text: `Transient error — retrying (${event.attempt}/${event.maxAttempts}) in ${Math.round(event.delayMs / 1000)}s…`,
        });
        break;

      case 'auto_retry_end':
        this.postMessage({ type: 'retryStatus', text: null });
        if (!event.success && event.finalError) {
          this.postMessage({ type: 'error', message: event.finalError });
        }
        break;

      case 'summarization_retry_scheduled':
        this.postMessage({
          type: 'retryStatus',
          text: `Summarization failed — retrying (${event.attempt}/${event.maxAttempts}) in ${Math.round(event.delayMs / 1000)}s…`,
        });
        break;

      case 'summarization_retry_finished':
        this.postMessage({ type: 'retryStatus', text: null });
        break;

      case 'compaction_start':
        this.postMessage({ type: 'compactionStatus', text: 'Compacting conversation context…' });
        break;

      case 'compaction_end':
        this.postMessage({ type: 'compactionStatus', text: null });
        if (!event.aborted && event.errorMessage) {
          this.postMessage({ type: 'error', message: `Compaction failed: ${event.errorMessage}` });
        }
        void this.session.sendStats();
        break;

      case 'thinking_level_changed':
      case 'session_info_changed':
      case 'entry_appended':
        // Bursty metadata events coalesce into a single state+stats refresh.
        this.scheduleRefresh();
        break;

      case 'extension_ui_request':
        this.handleExtensionUi(event);
        break;

      case 'extension_error':
        this.postMessage({ type: 'error', message: event.error || 'Extension error' });
        break;
    }
  }

  private settleRun(): void {
    if (this.runSettled) return;
    this.runSettled = true;
    this.session.setStreaming(false);
    this.postMessage({ type: 'agentEnd' });
    void this.session.sendStats();
  }

  private scheduleSettle(): void {
    if (this.settleTimer || this.disposed) return;
    this.settleTimer = setTimeout(() => {
      this.settleTimer = undefined;
      this.settleRun();
    }, 250);
    this.settleTimer.unref?.();
  }

  private clearSettleTimer(): void {
    if (!this.settleTimer) return;
    clearTimeout(this.settleTimer);
    this.settleTimer = undefined;
  }

  private scheduleRefresh(): void {
    if (this.refreshTimer || this.disposed) return;
    this.refreshTimer = setTimeout(() => {
      this.refreshTimer = undefined;
      if (this.disposed) return;
      void this.session.sendState();
      void this.session.sendStats();
    }, 100);
    this.refreshTimer.unref?.();
  }

  private clearRefreshTimer(): void {
    if (!this.refreshTimer) return;
    clearTimeout(this.refreshTimer);
    this.refreshTimer = undefined;
  }

  private handleMessageUpdate(event: MessageUpdateEvent): void {
    const msgEvent = event.assistantMessageEvent;
    if (!msgEvent) return;

    switch (msgEvent.type) {
      case 'text_delta':
        this.postMessage({ type: 'textDelta', messageId: 'current', delta: msgEvent.delta });
        break;
      case 'thinking_delta':
        this.postMessage({
          type: 'thinkingDelta',
          messageId: 'current',
          blockIndex: msgEvent.contentIndex ?? 0,
          delta: msgEvent.delta,
        });
        break;
      case 'thinking_end':
        // Current pi names the authoritative field "content"; older pi sent "thinking".
        this.postMessage({
          type: 'thinkingEnd',
          messageId: 'current',
          blockIndex: msgEvent.contentIndex ?? 0,
          content: msgEvent.content ?? msgEvent.thinking,
        });
        break;
    }
  }

  handleToolStart(event: ToolExecStartEvent): void {
    if (this.disposed) return;
    const args = event.args ?? {};
    const filePath = toolPath(args);
    const call: { args: ToolArgs; snapshot?: Promise<unknown> } = { args };
    if (['edit', 'write', 'multi-edit'].includes(event.toolName) && filePath) {
      const absPath = path.resolve(vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || '', filePath);
      call.snapshot = this.edits.snapshotFile(absPath).catch(err => {
        console.warn('[pi] could not snapshot edit:', err);
      });
    }
    this.toolCalls.set(event.toolCallId, call);
    this.postMessage({
      type: 'toolStart',
      messageId: 'current',
      toolCallId: event.toolCallId,
      toolName: event.toolName,
      args: JSON.stringify(event.args ?? {}, null, 2),
    });
  }

  async handleToolEnd(event: ToolExecEndEvent & { args?: ToolArgs }): Promise<void> {
    if (this.disposed) return;
    const epoch = this.epoch;
    // Pi only supplies args on start/update, not tool_execution_end.
    const call = this.toolCalls.get(event.toolCallId);
    this.toolCalls.delete(event.toolCallId);
    const outputText = (event.result?.content || [])
      .map((c) => c.text || '')
      .join('');

    // Publish the outcome before any async edit/diff work. agent_end can arrive
    // while that work is pending and must not mark a completed tool interrupted.
    this.postMessage({
      type: 'toolEnd',
      messageId: 'current',
      toolCallId: event.toolCallId,
      toolName: event.toolName,
      isError: event.isError,
      output: outputText.slice(0, 20000),
    });

    const diff = event.result?.details?.diff || event.result?.details?.patch;

    // If this was an edit-like tool, record it for accept/revert
    const editTools = new Set(['edit', 'write', 'multi-edit']);
    const args = call?.args ?? event.args;
    const relFilePath = toolPath(args);

    let computedDiff = typeof diff === 'string' ? diff : '';
    let fileContent = '';
    if (editTools.has(event.toolName) && !event.isError && relFilePath) {
      const absPath = path.isAbsolute(relFilePath)
        ? relFilePath
        : path.join(vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || '', relFilePath);
      try {
        await call?.snapshot;
        if (this.disposed || epoch !== this.epoch) return;
        const uri = vscode.Uri.file(absPath);
        const newContent = Buffer.from(await vscode.workspace.fs.readFile(uri)).toString('utf8');
        if (this.disposed || epoch !== this.epoch) return;
        fileContent = newContent;
        const record = await this.edits.recordEdit(absPath, newContent);
        computedDiff = record.diff;
      } catch (err) {
        console.warn('[pi] could not record edit:', err);
      }
    }

    if (this.disposed || epoch !== this.epoch) return;
    if (computedDiff && relFilePath && !event.isError) {
      this.postMessage({
        type: 'toolDiff',
        toolCallId: event.toolCallId,
        diff: computedDiff,
        fileContent,
        filePath: relFilePath,
      });
    }
  }

  private handleExtensionUi(request: ExtensionUiRequest): void {
    // Notifications map cleanly onto native VS Code notifications
    if (request.method === 'notify') {
      const fn = request.notifyType === 'error'
        ? vscode.window.showErrorMessage
        : request.notifyType === 'warning'
          ? vscode.window.showWarningMessage
          : vscode.window.showInformationMessage;
      fn(`Pi: ${request.message}`);
      return;
    }
    if (request.method === 'set_editor_text') {
      this.postMessage({ type: 'setInputText', text: request.text || '' });
      return;
    }
    if (request.method === 'setTitle') return; // no terminal title in a webview

    this.postMessage({
      type: 'extensionUiRequest',
      id: request.id,
      method: request.method,
      data: request,
    });
  }

  onEditChanged(record: EditRecord): void {
    if (this.disposed) return;
    if (record.status === 'pending') {
      this.postMessage({
        type: 'editRecorded',
        filePath: record.filePath,
        editId: record.id,
        diff: record.diff,
      });
    } else if (record.status === 'reverted') {
      this.postMessage({ type: 'editReverted', filePath: record.filePath, editId: record.id });
    } else if (record.status === 'accepted') {
      this.postMessage({ type: 'editAccepted', filePath: record.filePath, editId: record.id });
    }
    this.postMessage({
      type: 'editsSummary',
      pending: this.edits.getPendingEdits().map(e => ({ editId: e.id, filePath: e.filePath })),
    });
  }
}

function toolPath(args?: ToolArgs): string | undefined {
  const value = args?.path || args?.file_path || args?.filePath;
  return typeof value === 'string' && value ? value : undefined;
}
