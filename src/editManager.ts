import * as vscode from 'vscode';
import * as path from 'path';
import { createPatch } from 'diff';
import type { EditRecord } from './types.js';

/**
 * Manages file snapshots and edit tracking for accept/revert.
 * 
 * Flow:
 * 1. On agent_start: snapshot all open workspace files
 * 2. On edit tool start: snapshot unopened files before reading the result
 * 3. On edit tool result: update the pending file change and unified diff
 * 4. User can revert → restore from snapshot, or accept → keep current contents
 */
export class EditManager {
  private snapshots = new Map<string, Promise<string | null>>();
  private edits = new Map<string, EditRecord>();
  private onDidChangeEdits: vscode.EventEmitter<EditRecord> = new vscode.EventEmitter();

  readonly onDidChange: vscode.Event<EditRecord> = this.onDidChangeEdits.event;

  constructor() {}

  /** Take snapshots of all dirty/visible documents before agent work */
  async snapshotWorkspace(): Promise<void> {
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
    diff: string,
  ): Promise<EditRecord> {
    if (!this.snapshots.has(filePath)) {
      throw new Error(`Cannot snapshot file: ${filePath}`);
    }
    const snapshot = await this.snapshots.get(filePath)!;
    const pending = this.getPendingEdits().find(edit => edit.filePath === filePath);
    const originalContent = pending?.originalContent ?? snapshot ?? '';
    const originalExists = pending?.originalExists ?? snapshot !== null;
    // Pi's details.diff may be a line-numbered display, not a unified patch.
    diff = createPatch(path.basename(filePath), originalContent, newContent);

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
    const record = this.edits.get(editId);
    if (!record || record.status !== 'pending') return false;

    try {
      const uri = vscode.Uri.file(record.filePath);
      if (record.originalExists) {
        await vscode.workspace.fs.writeFile(uri, Buffer.from(record.originalContent, 'utf8'));
      } else {
        await vscode.workspace.fs.delete(uri);
      }
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

  /** Get all edits */
  getAllEdits(): EditRecord[] {
    return Array.from(this.edits.values());
  }

  /** Clear state (new session) */
  clear(): void {
    this.snapshots.clear();
    this.edits.clear();
  }

  /**
   * Compute a simple unified diff between two strings.
   * Used when pi's edit result doesn't include details.diff.
   */
  static computeDiff(original: string, modified: string): string {
    const origLines = original.split('\n');
    const modLines = modified.split('\n');

    // Simple LCS-based diff for small changes
    // For real use, we'd use diff-match-patch or similar
    // This is a minimal implementation
    const lines: string[] = [];
    let i = 0, j = 0;

    while (i < origLines.length || j < modLines.length) {
      if (i < origLines.length && j < modLines.length && origLines[i] === modLines[j]) {
        lines.push(` ${origLines[i]}`);
        i++; j++;
      } else {
        if (i < origLines.length) {
          lines.push(`-${origLines[i]}`);
          i++;
        }
        if (j < modLines.length) {
          lines.push(`+${modLines[j]}`);
          j++;
        }
      }
    }

    return lines.join('\n');
  }
}
