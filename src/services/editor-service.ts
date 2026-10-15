import * as vscode from 'vscode';
import * as path from 'node:path';
import { homedir } from 'node:os';
import type { EditManager } from '../edit-manager.ts';

/** Owns native editor navigation and the lifetime of original-content diff documents. */
export class EditorService implements vscode.TextDocumentContentProvider, vscode.Disposable {
  private contents = new Map<string, string>();
  private subscriptions: vscode.Disposable[];
  constructor(private readonly edits: EditManager) {
    this.subscriptions = [
      vscode.workspace.registerTextDocumentContentProvider('pi-original', this),
      vscode.workspace.onDidCloseTextDocument(document => {
        if (document.uri.scheme === 'pi-original') this.contents.delete(document.uri.toString());
      }),
    ];
  }

  provideTextDocumentContent(uri: vscode.Uri): string { return this.contents.get(uri.toString()) ?? ''; }

  async showDiff(editId: string): Promise<void> {
    const record = this.edits.getEdit(editId);
    if (!record) return;
    const uri = vscode.Uri.file(record.filePath);
    const originalUri = uri.with({ scheme: 'pi-original', query: editId });
    this.contents.set(originalUri.toString(), record.originalContent);
    try {
      await vscode.commands.executeCommand('vscode.diff', originalUri, uri, `${path.basename(record.filePath)} (Pi changes)`);
    } catch (error) {
      this.contents.delete(originalUri.toString());
      throw error;
    }
  }

  async openFile(filePath: string, line?: number, column?: number): Promise<void> {
    // Node path/URI APIs do not perform shell-style home expansion.
    if (filePath.startsWith('~/')) filePath = path.join(homedir(), filePath.slice(2));
    if (!path.isAbsolute(filePath)) {
      const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
      if (!root) return;
      filePath = path.join(root, filePath);
    }
    const document = await vscode.workspace.openTextDocument(vscode.Uri.file(filePath));
    const options: vscode.TextDocumentShowOptions = { preview: true };
    if (line) {
      const row = Math.max(0, line - 1);
      const col = column ? Math.max(0, column - 1) : 0;
      options.selection = new vscode.Range(row, col, row, col);
    }
    await vscode.window.showTextDocument(document, options);
  }

  dispose(): void {
    for (const subscription of this.subscriptions.splice(0)) subscription.dispose();
    this.contents.clear();
  }
}
