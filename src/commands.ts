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
    command('piChat.abort', () => sidebar.abort()),
    command('piChat.compact', async () => {
      const instructions = await vscode.window.showInputBox({
        prompt: 'Optional compaction instructions (empty for default)',
        placeHolder: 'e.g. Focus on code changes',
      });
      if (instructions === undefined) return; // cancelled
      // Progress streams via compaction_start/end events (status chip); a failed or
      // user-aborted compaction is a warning, not an extension error.
      if (!await pi.compact(instructions.trim() || undefined)) {
        void vscode.window.showWarningMessage('Pi Chat: compaction did not complete (aborted or failed).');
        return;
      }
      void vscode.window.showInformationMessage('Pi Chat: conversation compacted.');
    }),
    command('piChat.renameSession', async () => {
      const state = await pi.getState().catch(() => null);
      const name = await vscode.window.showInputBox({
        prompt: 'Display name for the current session',
        value: state?.sessionName || '',
      });
      if (name === undefined) return; // cancelled
      if (!await pi.setSessionName(name.trim())) throw new Error('Failed to rename session');
      await sidebar.session.sendState();
    }),
    command('piChat.exportHtml', async () => {
      const path = await pi.exportHtml();
      if (!path) throw new Error('Failed to export session');
      const open = 'Open file';
      const choice = await vscode.window.showInformationMessage(`Pi Chat: session exported to ${path}`, open);
      if (choice === open) await vscode.commands.executeCommand('vscode.open', vscode.Uri.file(path));
    }),
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
