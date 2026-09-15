import * as vscode from 'vscode';
import type { PiRpcClient } from './pi-rpc-client.ts';
import type { EditManager } from './edit-manager.ts';
import type { WebviewMessage, WebviewOutMessage } from './webview-types.ts';
import { SessionController } from './chat/session-controller.ts';
import { EventBridge } from './chat/event-bridge.ts';
import { FileAttachments } from './services/file-attachments.ts';
import { SessionRepository } from './services/session-repository.ts';
import { ModelService } from './services/model-service.ts';
import { EditorService } from './services/editor-service.ts';
import { getAgentDirectory, getSessionDirectory } from './configuration.ts';
import { getHtml } from './webview/html.ts';
import { selectStyle } from './webview/style-picker.ts';
import type { TransportOptions } from './rpc/transport.ts';
import { isRecord } from './value-guards.ts';

/** Webview ownership and command routing only; controllers own conversation state. */
export class ChatSidebarProvider implements vscode.WebviewViewProvider, vscode.Disposable {
  private view?: vscode.WebviewView;
  private viewSubscriptions: vscode.Disposable[] = [];
  private disposed = false;
  private readonly files: FileAttachments;
  private readonly repository: SessionRepository;
  private readonly models: ModelService;
  private readonly editor: EditorService;
  readonly session: SessionController;
  readonly events: EventBridge;

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly pi: PiRpcClient,
    private readonly edits: EditManager,
    workspaceState: vscode.Memento,
    options: TransportOptions = { command: 'pi', cwd: vscode.workspace.workspaceFolders?.[0]?.uri.fsPath },
  ) {
    const post = (message: WebviewOutMessage) => this.postMessage(message);
    this.session = new SessionController(pi, edits, workspaceState, post,
      () => this.events.reset(), record => this.events.onEditChanged(record));
    this.events = new EventBridge(pi, edits, this.session, post);
    this.files = new FileAttachments(post);
    this.repository = new SessionRepository(getSessionDirectory(options));
    this.models = new ModelService(pi, getAgentDirectory(options.env, options.cwd), () => this.session.sendState());
    this.editor = new EditorService(edits);
  }

  resolveWebviewView(view: vscode.WebviewView): void {
    if (this.disposed) return;
    this.releaseView();
    this.view = view;
    view.webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(this.extensionUri, 'media')],
    };
    view.webview.html = getHtml(view.webview, this.extensionUri);
    this.viewSubscriptions.push(
      view.webview.onDidReceiveMessage((message: unknown) => {
        if (isRecord(message) && typeof message.type === 'string') void this.handleMessage(message as WebviewMessage);
      }),
      view.onDidChangeVisibility(() => { if (view.visible) void this.session.sendState(); }),
      view.onDidDispose(() => this.releaseView()),
    );
  }

  insertPrompt(text: string): void { this.postMessage({ type: 'setInputText', text, append: true }); }
  newSession(): Promise<void> { return this.session.newSession(); }
  selectModel(notify = false): Promise<void> { return this.models.selectModel(notify); }

  /** Shared typed entry point for UI commands; all asynchronous failures are observed. */
  async handleMessage(message: WebviewMessage): Promise<void> {
    if (this.disposed) return;
    try {
      switch (message.type) {
        case 'prompt':
          await this.session.submit(message.text, message.images, message.streaming, message.submissionId);
          break;
        case 'runCommand': await this.session.runCommand(message.command); break;
        case 'ready': await this.session.ready(); break;
        case 'abort': await this.pi.abort(); break;
        case 'newSession': await this.newSession(); break;
        case 'resumeSession': await this.session.resumeSession(message.filePath); break;
        case 'getSessions': this.postMessage({ type: 'sessionsList', sessions: await this.repository.list() }); break;
        case 'selectModel': await this.selectModel(); break;
        case 'configureProvider': await vscode.commands.executeCommand('piChat.configureProvider'); break;
        case 'selectStyle': await selectStyle(message.currentStyle, output => this.postMessage(output)); break;
        case 'setThinkingLevel':
          if (!['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'].includes(message.level)) throw new Error('Invalid thinking level');
          if (!await this.pi.setThinkingLevel(message.level)) throw new Error('Failed to change thinking level');
          await this.session.sendState();
          break;
        case 'reloadExtensions':
          await vscode.window.showInformationMessage('Restart pi process to reload extensions: reload the VS Code window.');
          break;
        case 'extensionUiResponse': this.pi.sendExtensionUiResponse(message.id, message.value, message.confirmed, message.cancelled); break;
        case 'revertEdit': await this.edits.revertEdit(message.editId); break;
        case 'acceptEdit': this.edits.acceptEdit(message.editId); break;
        case 'revertAllEdits':
          for (const record of this.edits.getPendingEdits()) await this.edits.revertEdit(record.id);
          break;
        case 'acceptAllEdits':
          for (const record of this.edits.getPendingEdits()) this.edits.acceptEdit(record.id);
          break;
        case 'showDiff': await this.editor.showDiff(message.editId); break;
        case 'openFile': await this.editor.openFile(message.path, message.line, message.column); break;
        case 'searchFile': await this.files.searchFiles(message.query); break;
        case 'selectFileToAttach': await this.files.selectFiles(message.requestId); break;
        case 'attachFiles': await this.files.attachFiles(message.requestId, message.uris); break;
      }
    } catch (error) { this.postMessage({ type: 'error', message: String(error) }); }
  }

  private postMessage(message: WebviewOutMessage): void {
    if (!this.disposed && this.view) {
      void Promise.resolve(this.view.webview.postMessage(message)).catch(error => console.warn('[pi] webview message failed:', error));
    }
  }

  private releaseView(): void {
    this.view = undefined;
    for (const subscription of this.viewSubscriptions.splice(0)) subscription.dispose();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.releaseView();
    this.events.dispose();
    this.session.dispose();
    this.editor.dispose();
    this.repository.dispose();
  }
}
