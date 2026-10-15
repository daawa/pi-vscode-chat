import { mock } from 'bun:test';
import { EventEmitter } from 'node:events';
import type * as vscode from 'vscode';
import type { PiRpcClient } from '../src/pi-rpc-client.ts';

export const readFile = mock(async (_uri: unknown) => Buffer.from('new content'));
export const writeFile = mock(async (_uri: unknown, _content: Uint8Array) => {});
export const deleteFile = mock(async (_uri: unknown) => {});
export const stat = mock(async (_uri: unknown) => ({ type: 1, size: 100 }));
export const showOpenDialog = mock(async (_options: unknown): Promise<any> => undefined);
export const showQuickPick = mock(async (_items: any[], _options: unknown): Promise<any> => undefined);
export const showErrorMessage = mock(async (_message: string) => undefined);
export const executeCommand = mock(async (_command: string, ..._args: unknown[]) => undefined);
export const openTextDocument = mock(async (uri: vscode.Uri) => ({ uri }));
export const showTextDocument = mock(async (_document: unknown, _options: vscode.TextDocumentShowOptions) => undefined);
export const documentClosed = new EventEmitter();
export const contentProviders = new Set<unknown>();
export const commandHandlers = new Map<string, (...args: any[]) => unknown>();
class Disposable {
  constructor(private action = () => {}) {}
  dispose() { const action = this.action; this.action = () => {}; action(); }
}
export const parseUri = (value: string): any => {
  const url = new URL(value);
  return {
    scheme: url.protocol.slice(0, -1), path: decodeURIComponent(url.pathname),
    fsPath: decodeURIComponent(url.pathname), toString: () => value,
    with: (change: { scheme?: string; query?: string }) => parseUri(`${change.scheme || url.protocol.slice(0, -1)}://${url.host}${url.pathname}?${change.query || ''}`),
  };
};
mock.module('vscode', () => ({
  workspace: {
    workspaceFolders: [{ uri: parseUri('file:///workspace') }], textDocuments: [],
    fs: { readFile, writeFile, delete: deleteFile, stat },
    openTextDocument,
    registerTextDocumentContentProvider: (_scheme: string, provider: unknown) => {
      contentProviders.add(provider);
      return new Disposable(() => { contentProviders.delete(provider); });
    },
    onDidCloseTextDocument: (listener: (...args: any[]) => void) => {
      documentClosed.on('close', listener);
      return new Disposable(() => { documentClosed.off('close', listener); });
    },
  },
  Uri: {
    file: (filePath: string) => parseUri(`file://${filePath}`), parse: parseUri,
    joinPath: (uri: { toString(): string }, ...segments: string[]) => parseUri(`${uri.toString()}/${segments.join('/')}`),
  },
  FileType: { File: 1 }, Disposable,
  Range: class {
    start: { line: number; character: number };
    end: { line: number; character: number };
    constructor(startLine: number, startCharacter: number, endLine: number, endCharacter: number) {
      this.start = { line: startLine, character: startCharacter };
      this.end = { line: endLine, character: endCharacter };
    }
  },
  window: { showQuickPick, showOpenDialog, showErrorMessage, showTextDocument,
    showWarningMessage: showErrorMessage, showInformationMessage: showErrorMessage },
  commands: {
    executeCommand,
    registerCommand: (name: string, fn: (...args: any[]) => unknown) => {
      commandHandlers.set(name, fn);
      return new Disposable(() => { commandHandlers.delete(name); });
    },
    registerTextEditorCommand: () => new Disposable(),
  },
  EventEmitter: class {
    private emitter = new EventEmitter();
    event = (listener: (value: unknown) => void) => {
      this.emitter.on('change', listener);
      return new Disposable(() => { this.emitter.off('change', listener); });
    };
    fire(value: unknown) { this.emitter.emit('change', value); }
    dispose() { this.emitter.removeAllListeners(); }
  },
}));

export const { ChatSidebarProvider } = await import('../src/chat-sidebar-provider.ts');
export const { EditManager } = await import('../src/edit-manager.ts');
const disposables: { dispose(): void }[] = [];

export function createView(messages: any[]) {
  const inbound = new EventEmitter();
  const visibility = new EventEmitter();
  const closed = new EventEmitter();
  const subscribe = (emitter: EventEmitter, listener: (...args: any[]) => void) => {
    emitter.on('event', listener);
    return new Disposable(() => { emitter.off('event', listener); });
  };
  return {
    inbound, visibility, closed, visible: true,
    webview: { options: {}, html: '', cspSource: 'vscode-webview:',
      asWebviewUri: (uri: unknown) => uri,
      postMessage: (message: unknown) => { messages.push(message); return Promise.resolve(true); },
      onDidReceiveMessage: (listener: (...args: any[]) => void) => subscribe(inbound, listener),
    },
    onDidChangeVisibility: (listener: () => void) => subscribe(visibility, listener),
    onDidDispose: (listener: () => void) => subscribe(closed, listener),
  };
}

export async function createProvider(historyLoaded = true, editManager?: InstanceType<typeof EditManager>) {
  const pi = Object.assign(new EventEmitter(), {
    getState: mock(async (): Promise<any> => null), getSessionStats: mock(async (): Promise<any> => null),
    getCommands: mock(async (): Promise<any[]> => []),
    prompt: mock(async (..._args: any[]) => ({ success: true })),
    newSession: mock(async () => ({ cancelled: false })), switchSession: mock(async (_path: string) => ({ cancelled: false })),
    getMessages: mock(async (): Promise<any[]> => []), isRunning: true,
    start: mock((_path?: string) => {}), stop: mock(async () => {}),
    getModels: mock(async (): Promise<any[]> => []), setModel: mock(async (_provider: string, _modelId: string) => true),
  });
  const edits = editManager ?? {
    onDidChange: () => new Disposable(), recordEdit: mock(async (_path: string, _content: string) => ({ diff: 'computed patch' })),
    snapshotFile: mock(async () => 'old content'), snapshotWorkspace: mock(async () => {}),
    getPendingEdits: () => [], clear: mock(() => {}),
  };
  const messages: any[] = [];
  const workspaceState = { get: mock((_key: string): any => undefined), update: mock(async (_key: string, _value: any) => {}) };
  const provider = new ChatSidebarProvider(parseUri('file:///extension'), pi as unknown as PiRpcClient,
    edits as InstanceType<typeof EditManager>, workspaceState as unknown as vscode.Memento,
    { command: 'pi', cwd: '/workspace', env: { PI_CODING_AGENT_DIR: '/__pi-chat-test-agent__' } });
  const view = createView(messages);
  provider.resolveWebviewView(view as unknown as vscode.WebviewView);
  disposables.push(provider);
  if (editManager) disposables.push(editManager);
  if (historyLoaded) { await provider.session.loadHistory(); messages.length = 0; }
  return { pi, edits, messages, provider, workspaceState, view };
}

export function toolEnd(isError: boolean) {
  return { type: 'tool_execution_end' as const, toolCallId: 'edit-1', toolName: 'edit', args: { path: 'example.txt' }, isError,
    result: { content: [{ type: 'text', text: isError ? 'Edit failed' : 'Edited file' }],
      details: { diff: '--- a/example.txt\n+++ b/example.txt\n@@ -1 +1 @@\n-old\n+new' } } };
}

export function resetHostFixture(): void {
  for (const disposable of disposables.splice(0)) disposable.dispose();
  readFile.mockReset(); readFile.mockImplementation(async () => Buffer.from('new content'));
  stat.mockReset(); stat.mockImplementation(async () => ({ type: 1, size: 100 }));
  showOpenDialog.mockReset(); showOpenDialog.mockImplementation(async () => undefined);
  showQuickPick.mockReset(); showQuickPick.mockImplementation(async () => undefined);
  writeFile.mockClear(); deleteFile.mockClear(); showErrorMessage.mockClear(); executeCommand.mockReset();
  executeCommand.mockImplementation(async () => undefined);
  openTextDocument.mockReset(); openTextDocument.mockImplementation(async uri => ({ uri }));
  showTextDocument.mockReset(); showTextDocument.mockImplementation(async () => undefined);
}
