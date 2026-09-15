import * as vscode from 'vscode';
import type { PiRpcClient } from './pi-rpc-client.ts';
import type { EditManager } from './edit-manager.ts';
import type { ChatSidebarProvider } from './chat-sidebar-provider.ts';
import { configureProvider, manageSkills, runDependencyCheck, runInstall } from './setup/setup-actions.ts';

export function registerCommands(
  context: vscode.ExtensionContext, pi: PiRpcClient, edits: EditManager, sidebar: ChatSidebarProvider,
): vscode.Disposable {
  let disposed = false;
  const timers = new Set<ReturnType<typeof setTimeout>>();
  const reportError = (error: unknown) => {
    if (!disposed) void vscode.window.showErrorMessage(`Pi Chat: ${String(error)}`);
  };
  const command = (name: string, run: (...args: unknown[]) => unknown) => vscode.commands.registerCommand(name,
    (...args: unknown[]) => Promise.resolve().then(() => { if (!disposed) return run(...args); }).catch(reportError));
  const subscriptions = [
    command('piChat.configureProvider', configureProvider),
    command('piChat.checkDependencies', () => runDependencyCheck(context)),
    command('piChat.installDependencies', () => runInstall(context)),
    command('piChat.manageSkills', () => manageSkills(context)),
    command('piChat.newSession', () => sidebar.newSession()),
    command('piChat.selectModel', () => sidebar.selectModel(true)),
    command('piChat.acceptEdit', id => { if (typeof id === 'string') edits.acceptEdit(id); }),
    command('piChat.rejectEdit', id => { if (typeof id === 'string') return edits.revertEdit(id); }),
    command('piChat.abort', () => pi.abort()),
    vscode.commands.registerTextEditorCommand('piChat.sendSelection', editor => {
      const selection = editor.selection;
      const text = editor.document.getText(selection);
      if (!text) { void vscode.window.showInformationMessage('No text selected'); return; }
      const file = vscode.workspace.asRelativePath(editor.document.uri);
      const prompt = `\`${file}:${selection.start.line + 1}-${selection.end.line + 1}\`\n\`\`\`${editor.document.languageId}\n${text}\n\`\`\`\n`;
      void Promise.resolve(vscode.commands.executeCommand('workbench.view.extension.pi-chat')).then(() => {
        if (disposed) return;
        const timer = setTimeout(() => { timers.delete(timer); if (!disposed) sidebar.insertPrompt(prompt); }, 150);
        timers.add(timer);
      }).catch(reportError);
    }),
  ];
  return new vscode.Disposable(() => {
    disposed = true;
    for (const timer of timers) clearTimeout(timer);
    timers.clear();
    for (const subscription of subscriptions) subscription.dispose();
  });
}
