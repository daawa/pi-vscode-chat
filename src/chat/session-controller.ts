import type * as vscode from 'vscode';
import type { PiRpcClient } from '../pi-rpc-client.ts';
import type { EditManager } from '../edit-manager.ts';
import type { EditRecord } from '../edit-types.ts';
import type { PostMessage, PromptImage } from '../webview-types.ts';
import { validatePromptImages } from '../image-attachments.ts';
import { responseDisposition } from '../rpc-types.ts';
import { LAST_SESSION_FILE_STATE_KEY } from '../configuration.ts';

/** Owns all prompt/history/session guards; no lifecycle flags live in the view. */
export class SessionController implements vscode.Disposable {
  private isStreaming = false;
  private stateRequestId = 0;
  private statsRequestId = 0;
  private historyRequestId = 0;
  private historyLoading = true;
  private promptPending = false;
  private transitioning = false;
  private transition?: Promise<void>;
  private disposed = false;
  private epoch = 0;
  private thinkingLevels: string[] | null = null;
  private thinkingLevelsModel: string | null = null;

  constructor(
    private readonly pi: PiRpcClient,
    private readonly edits: EditManager,
    private readonly workspaceState: vscode.Memento,
    private readonly postMessage: PostMessage,
    private readonly resetTools: () => void,
    private readonly onEditChanged: (record: EditRecord) => void,
  ) {}

  get loading(): boolean { return this.historyLoading; }
  get submitting(): boolean { return this.promptPending; }

  dispose(): void {
    this.disposed = true;
    this.epoch++;
    this.stateRequestId++;
    this.statsRequestId++;
    this.historyRequestId++;
  }

  async ready(): Promise<void> {
    // A recreated view must not fetch old history in the middle of a session switch.
    while (this.transition) await this.transition;
    if (this.disposed) return;
    void this.sendCommands();
    void this.sendStats();
    const history = this.loadHistory(); // Invalidate old requests before issuing state refresh.
    void this.sendState();
    await history;
  }

  async newSession(): Promise<void> { await this.changeSession(); }
  async resumeSession(filePath: string): Promise<void> { await this.changeSession(filePath); }

  private changeSession(filePath?: string): Promise<void> {
    if (this.disposed || this.promptPending || this.transitioning || this.transition) return Promise.resolve();
    this.transition = this.performSessionChange(filePath).finally(() => { this.transition = undefined; });
    return this.transition;
  }

  private async performSessionChange(filePath?: string): Promise<void> {
    this.transitioning = true;
    const wasLoading = this.historyLoading;
    let requestId = this.invalidateHistory();
    // Fence old stats even when the operation is later cancelled.
    this.epoch++;
    try {
      if (filePath && !this.pi.isRunning) {
        await this.pi.stop(); // Drain a previous shutdown before starting a replacement.
        if (this.disposed) return;
        this.pi.start(filePath);
      } else {
        const result = filePath ? await this.pi.switchSession(filePath) : await this.pi.newSession();
        if (this.disposed) return;
        if (result.cancelled) {
          // Cancellation is not failure and must never trigger a restart or clear the draft/Undo.
          if (wasLoading) await this.loadHistory();
          void this.sendState();
          void this.sendStats();
          return;
        }
      }
      requestId = this.invalidateHistory();
      this.epoch++; // Also fence requests initiated while the change itself was in flight.
      this.edits.clear();
      this.resetTools();
      this.isStreaming = false;
      this.postMessage({ type: filePath ? 'clearComposer' : 'sessionCleared' });
      if (filePath) await this.loadHistory();
      void this.sendState();
      void this.sendStats();
    } catch (error) {
      if (!this.disposed) {
        this.postMessage({ type: 'error', message: `Failed to change session: ${String(error)}` });
        if (wasLoading) await this.loadHistory();
        void this.sendState();
        void this.sendStats();
      }
    } finally {
      this.transitioning = false;
      if (!this.disposed && requestId === this.historyRequestId) this.setHistoryLoading(false);
    }
  }

  private rejectWhileBusy(submissionId?: string): boolean {
    if (!this.disposed && !this.historyLoading && !this.promptPending && !this.transitioning) return false;
    if (!this.disposed && submissionId) this.postMessage({ type: 'promptResult', submissionId, success: false,
      error: 'Wait for session loading or the current submission to finish.' });
    return true;
  }

  async runCommand(command: string): Promise<void> {
    if (this.rejectWhileBusy()) return;
    this.promptPending = true;
    try {
      const result = await this.pi.prompt(command);
      if (!result.success) throw new Error(result.error || 'Failed to run command');
      await this.sendState();
    } catch (error) {
      if (!this.disposed) this.postMessage({ type: 'error', message: String(error) });
    } finally { this.promptPending = false; }
  }

  async submit(text: string, images?: PromptImage[], streaming?: boolean, submissionId?: string, behavior: 'steer' | 'followUp' = 'steer'): Promise<void> {
    if (this.rejectWhileBusy(submissionId)) return;
    this.promptPending = true;
    let started = false;
    try {
      if (typeof text !== 'string') throw new Error('Invalid prompt text.');
      images = validatePromptImages(images);
      if (!text.trim() && !images?.length) throw new Error('Enter a message or attach an image.');
      const isCommand = text.startsWith('/');
      if (images?.length) {
        const current = await this.pi.getState();
        if (!current?.model?.input?.includes('image')) throw new Error('Select a model that supports images before sending attachments.');
        streaming = !!current.isStreaming;
        if (isCommand) {
          const command = text.split(/\s/, 1)[0].slice(1);
          const commands = await this.pi.getCommands();
          if (commands.some(c => c.name === command && c.source === 'extension')) {
            throw new Error('Extension commands do not receive image attachments. Send the images as a regular prompt instead.');
          }
        }
      }
      if (this.disposed) return;
      // The webview's streaming flag can be stale; the controller's event-driven
      // view is authoritative. An explicit followUp request keeps its behavior
      // even if the flags disagree, so the draft is never silently downgraded.
      const streamingNow = streaming || this.isStreaming;
      const wantsFollowUp = behavior === 'followUp' && (!isCommand || !!images?.length);
      // Echo before streamed output, but remove this bubble if Pi rejects preflight.
      this.postMessage({ type: 'userMessage', text, images, queued: (!!streaming || wantsFollowUp) && !isCommand, submissionId });
      if (!streamingNow && !isCommand) {
        started = true;
        this.setStreaming(true);
        await this.edits.snapshotWorkspace();
      }
      if (this.disposed) return;
      const result = await this.pi.prompt(
        text, images,
        wantsFollowUp ? 'followUp' : streamingNow && (!isCommand || !!images?.length) ? 'steer' : undefined,
      );
      if (this.disposed) return;
      if (!result.success) throw new Error(result.error || 'Failed to send prompt to pi');
      const disposition = responseDisposition(result);
      if (disposition === 'handled' && (streaming || wantsFollowUp) && !isCommand && submissionId) {
        // An extension/input handler consumed the prompt: no run, no queue entry.
        // Drop the optimistic queued bubble and keep the draft for re-editing.
        this.postMessage({ type: 'promptHandled', submissionId });
      } else {
        // queued:true tells the webview the prompt really entered pi's queue, so its
        // bubble can be reconciled later; anything else settles the bubble at once.
        if (submissionId) this.postMessage({ type: 'promptResult', submissionId, success: true, queued: disposition === 'queued' });
        // "handled" for an idle prompt or command: no agent run starts, so no
        // agent_end or agent_settled will ever arrive for it. init(idle) unlocks
        // the composer; the handler may have done session-visible work.
        if (disposition === 'handled') {
          if (started) {
            started = false;
            this.setStreaming(false);
          }
          void this.sendStats();
        }
      }
      if (isCommand) await this.sendState();
    } catch (err) {
      if (this.disposed) return;
      const error = String(err);
      if (submissionId) this.postMessage({ type: 'promptResult', submissionId, success: false, error });
      else this.postMessage({ type: 'error', message: error });
      if (started) this.setStreaming(false);
    } finally {
      this.promptPending = false;
    }
  }

  setStreaming(streaming: boolean): void {
    if (this.disposed) return;
    this.isStreaming = streaming;
    void this.sendState();
  }

  async sendState(): Promise<void> {
    if (this.disposed) return;
    const requestId = ++this.stateRequestId;
    const state = await this.pi.getState().catch(() => null);
    if (this.disposed || requestId !== this.stateRequestId) return;
    if (state?.sessionFile) {
      void Promise.resolve(this.workspaceState.update(LAST_SESSION_FILE_STATE_KEY, state.sessionFile)).catch(console.warn);
    }
    // Thinking levels are model-scoped; refetch only when the model changes.
    // The cache key is committed only after a completed fetch, so a failed or
    // superseded request is retried on the next refresh instead of being lost.
    const modelKey = state?.model ? `${state.model.provider}/${state.model.id}` : null;
    if (modelKey !== this.thinkingLevelsModel) {
      // null from the client means the command failed or is unsupported (older pi);
      // don't commit, so the next refresh retries instead of falling back forever.
      let levels: string[] | null = modelKey ? null : [];
      if (modelKey) {
        try { levels = await this.pi.getAvailableThinkingLevels(); } catch { levels = null; }
      }
      if (this.disposed || requestId !== this.stateRequestId) return;
      if (levels !== null) {
        this.thinkingLevelsModel = modelKey;
        this.thinkingLevels = levels;
      }
    }
    // Only send levels proven to belong to the current model; otherwise the
    // webview falls back to its default list.
    const currentLevels = this.thinkingLevelsModel === modelKey ? this.thinkingLevels : null;
    this.postMessage({
      type: 'init',
      model: state?.model ? `${state.model.provider}/${state.model.id}` : 'unknown',
      modelReasoning: !!state?.model?.reasoning,
      modelSupportsImages: !!state?.model?.input?.includes('image'),
      thinkingLevel: state?.thinkingLevel || 'off',
      ...(currentLevels?.length ? { thinkingLevels: currentLevels } : {}),
      state: this.isStreaming || state?.isStreaming ? 'streaming' : 'idle',
      sessionName: state?.sessionName,
      sessionId: state?.sessionId,
    });
  }

  async sendCommands(): Promise<void> {
    if (this.disposed) return;
    const epoch = this.epoch;
    const commands = await this.pi.getCommands().catch(() => []);
    if (!this.disposed && epoch === this.epoch) this.postMessage({ type: 'commands', commands });
  }

  async sendStats(): Promise<void> {
    if (this.disposed) return;
    const epoch = this.epoch;
    const requestId = ++this.statsRequestId;
    const stats = await this.pi.getSessionStats().catch(() => null);
    if (!this.disposed && epoch === this.epoch && requestId === this.statsRequestId) this.postMessage({ type: 'stats', stats });
  }

  private setHistoryLoading(loading: boolean): void {
    this.historyLoading = loading;
    this.postMessage({ type: 'historyLoading', loading });
  }

  private invalidateHistory(): number {
    this.stateRequestId++;
    this.setHistoryLoading(true);
    return ++this.historyRequestId;
  }

  async loadHistory(): Promise<void> {
    if (this.disposed) return;
    const requestId = this.invalidateHistory();
    try {
      // On startup the webview can post 'ready' before the pi process is up.
      for (let i = 0; i < 10 && !this.pi.isRunning && !this.disposed && requestId === this.historyRequestId; i++) {
        await new Promise((r) => setTimeout(r, 100));
      }
      if (this.disposed || requestId !== this.historyRequestId) return;
      const messages = await this.pi.getMessages();
      if (this.disposed || requestId !== this.historyRequestId) return;
      this.postMessage({ type: 'loadHistory', messages });
      // The webview can be recreated while its in-memory Undo snapshots survive.
      for (const record of this.edits.getPendingEdits()) this.onEditChanged(record);
    } catch (err) {
      if (this.disposed || requestId !== this.historyRequestId) return;
      this.postMessage({ type: 'error', message: `Failed to load session history: ${String(err)}. Reload the window to retry.` });
    } finally {
      // An obsolete request must not unlock a newer session's composer.
      if (!this.disposed && requestId === this.historyRequestId) this.setHistoryLoading(false);
    }
  }
}
