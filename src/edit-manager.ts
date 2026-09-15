import * as vscode from 'vscode';
import * as path from 'path';
import { createPatch } from 'diff';
import type { EditRecord } from './edit-types.ts';

/**
 * Manages file snapshots and edit tracking for accept/revert.
 *
 * Flow:
 * 1. On agent_start: snapshot all open workspace files
 * 2. On edit tool start: snapshot unopened files before reading the result
 * 3. On edit tool result: update the pending file change and unified diff
 * 4. User can revert → restore from snapshot, or accept → keep current contents
 */
export class EditManager implements vscode.Disposable {
  private generation = 0;
  private disposed = false;
  private snapshots = new Map<string, Promise<string | null>>();
  private edits = new Map<string, EditRecord>();
  private onDidChangeEdits: vscode.EventEmitter<EditRecord> = new vscode.EventEmitter();

  readonly onDidChange: vscode.Event<EditRecord> = this.onDidChangeEdits.event;

  /** Take snapshots of all dirty/visible documents before agent work */
  async snapshotWorkspace(): Promise<void> {
    if (this.disposed) return;
    this.snapshots.clear();

    // Snapshot all open text documents
    for (const doc of vscode.workspace.textDocuments) {
      if (doc.uri.scheme !== 'file') continue;
      if (doc.isUntitled) continue;
      try {
        const content = doc.getText();
        this.snapshots.set(doc.uri.fsPath, Promise.resolve(content));
      } catch { /* skip */ }
    }

    // Unopened files are captured lazily at tool start.
  }

  /** Start reading at tool start, never after the tool has changed the file. */
  snapshotFile(filePath: string): Promise<string | null> {
    if (this.disposed) return Promise.reject(new Error('Edit manager is disposed'));
    if (this.snapshots.has(filePath)) {
      return this.snapshots.get(filePath)!;
    }
    const pending = this.getPendingEdits().find(edit => edit.filePath === filePath);
    const snapshot = pending
      ? Promise.resolve(pending.originalExists ? pending.originalContent : null)
      : vscode.workspace.fs.readFile(vscode.Uri.file(filePath)).then(
        bytes => Buffer.from(bytes).toString('utf8'),
        err => {
          if (err.code === 'FileNotFound' || err.code === 'ENOENT') return null;
          throw err;
        },
      );
    const promise = Promise.resolve(snapshot);
    this.snapshots.set(filePath, promise);
    return promise;
  }

  /** Record an edit from tool_execution_end */
  async recordEdit(
    filePath: string,
    newContent: string,
  ): Promise<EditRecord> {
    const generation = this.generation;
    if (!this.snapshots.has(filePath)) {
      throw new Error(`Cannot snapshot file: ${filePath}`);
    }
    const snapshot = await this.snapshots.get(filePath)!;
    if (this.disposed || generation !== this.generation) throw new Error('Session changed while recording edit');
    const pending = this.getPendingEdits().find(edit => edit.filePath === filePath);
    const originalContent = pending?.originalContent ?? snapshot ?? '';
    const originalExists = pending?.originalExists ?? snapshot !== null;
    // Pi's details.diff may be a line-numbered display, not a unified patch.
    const diff = createPatch(path.basename(filePath), originalContent, newContent);

    const record: EditRecord = {
      id: pending?.id ?? `edit-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      filePath,
      originalContent,
      originalExists,
      newContent,
      diff,
      timestamp: Date.now(),
      status: 'pending',
    };

    this.edits.set(record.id, record);
    this.onDidChangeEdits.fire(record);
    return record;
  }

  /** Revert a file to its pre-agent snapshot */
  async revertEdit(editId: string): Promise<boolean> {
    const generation = this.generation;
    const record = this.edits.get(editId);
    if (!record || record.status !== 'pending') return false;

    try {
      const uri = vscode.Uri.file(record.filePath);
      if (record.originalExists) {
        await vscode.workspace.fs.writeFile(uri, Buffer.from(record.originalContent, 'utf8'));
      } else {
        await vscode.workspace.fs.delete(uri);
      }
      if (generation !== this.generation) return true;
      this.snapshots.delete(record.filePath);
      record.status = 'reverted';
      this.onDidChangeEdits.fire(record);
      return true;
    } catch (err) {
      console.error(`[pi] revert failed for ${record.filePath}:`, err);
      return false;
    }
  }

  /** Mark edit as accepted (no-op, edit already applied) */
  acceptEdit(editId: string): void {
    const record = this.edits.get(editId);
    if (!record || record.status !== 'pending') return;
    record.status = 'accepted';
    this.snapshots.delete(record.filePath);
    this.onDidChangeEdits.fire(record);
  }

  /** Get a diff for a recorded edit */
  getEdit(editId: string): EditRecord | undefined {
    return this.edits.get(editId);
  }

  /** Get all pending edits */
  getPendingEdits(): EditRecord[] {
    return Array.from(this.edits.values()).filter(e => e.status === 'pending');
  }

  /** Clear state (new session), invalidating asynchronous edit work. */
  clear(): void {
    this.generation++;
    this.snapshots.clear();
    this.edits.clear();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.clear();
    this.onDidChangeEdits.dispose();
  }
}
