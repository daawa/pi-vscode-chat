import * as vscode from 'vscode';
import { PiRpcClient } from './pi-rpc-client.ts';
import { ChatSidebarProvider } from './chat-sidebar-provider.ts';
import { EditManager } from './edit-manager.ts';
import { registerCommands } from './commands.ts';
import { LAST_SESSION_FILE_STATE_KEY, readLaunchOptions } from './configuration.ts';
import { exists, findExecutable } from './setup/dependencies.ts';
import { runDependencyCheck, runInstall } from './setup/setup-actions.ts';

let running: { pi: PiRpcClient; dispose: () => void } | undefined;

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  running?.dispose();
  const options = readLaunchOptions();
  const edits = new EditManager();
  const pi = new PiRpcClient(options);
  const sidebar = new ChatSidebarProvider(context.extensionUri, pi, edits, context.workspaceState, options);
  let disposed = false;
  const subscriptions: vscode.Disposable[] = [edits, pi, sidebar];
  const instance = {
    pi,
    dispose: () => {
      if (disposed) return;
      disposed = true;
      for (const subscription of subscriptions.splice(0).reverse()) subscription.dispose();
      if (running === instance) running = undefined;
    },
  };
  running = instance;
  context.subscriptions.push(instance);
  subscriptions.push(
    vscode.window.registerWebviewViewProvider('piChat.sidebar', sidebar, { webviewOptions: { retainContextWhenHidden: true } }),
    registerCommands(context, pi, edits, sidebar),
    vscode.workspace.onDidChangeConfiguration(async event => {
      if (!['piPath', 'adapterArgs', 'extraEnv'].some(key => event.affectsConfiguration(`piChat.${key}`))) return;
      const choice = await vscode.window.showInformationMessage('Pi Chat settings changed. Reload window to apply?', 'Reload');
      if (!disposed && choice === 'Reload') await vscode.commands.executeCommand('workbench.action.reloadWindow');
    }),
  );

  const status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
  status.text = '$(comment-discussion) Pi';
  status.tooltip = 'Open Pi Chat';
  status.command = 'workbench.view.extension.pi-chat';
  status.color = '#4D6BFE';
  status.show();
  subscriptions.push(status);

  try {
    const executable = await findExecutable(options.command, options.env?.PATH);
    if (disposed) return;
    if (!executable) {
      const action = await vscode.window.showWarningMessage(
        'Pi Chat: pi binary not found. Install dependencies to get started.', 'Install Dependencies', 'Check Dependencies',
      );
      if (disposed) return;
      if (action === 'Install Dependencies') await runInstall(context);
      else if (action === 'Check Dependencies') await runDependencyCheck(context);
      return;
    }
    const previous = context.workspaceState.get<string>(LAST_SESSION_FILE_STATE_KEY);
    const session = previous && await exists(previous) ? previous : undefined;
    if (!disposed) pi.start(session);
  } catch (error) {
    if (!disposed) await vscode.window.showErrorMessage(`Pi Chat: Failed to start pi process: ${String(error)}`);
  }
}

export async function deactivate(): Promise<void> {
  const instance = running;
  instance?.dispose();
  await instance?.pi.stop();
}
