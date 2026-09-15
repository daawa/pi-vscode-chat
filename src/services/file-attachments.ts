import * as vscode from 'vscode';
import * as path from 'node:path';
import { IMAGE_LIMITS, inspectImage, isImagePath } from '../image-attachments.ts';
import type { Attachment, PostMessage } from '../webview-types.ts';

/** Source-aware reads: remote workspace URIs never become host-local paths. */
export class FileAttachments {
  constructor(private readonly postMessage: PostMessage) {}

  async selectFiles(requestId: string): Promise<void> {
    try {
      const uris = await vscode.window.showOpenDialog({
        canSelectFiles: true,
        canSelectFolders: false,
        canSelectMany: true,
        openLabel: 'Attach File',
      });
      await this.attachFiles(requestId, (uris || []).map(uri => uri.toString()));
    } catch (err) {
      this.postMessage({ type: 'attachmentsSelected', requestId, attachments: [], errors: [String(err)] });
    }
  }

  async attachFiles(requestId: string, uris: string[]): Promise<void> {
    const attachments: Attachment[] = [];
    const errors: string[] = [];
    try {
      if (!Array.isArray(uris) || uris.length > 20) throw new Error('Select at most 20 files at a time.');
      let imageBytes = 0;
      for (const value of new Set(uris)) {
        try {
          if (typeof value !== 'string') throw new Error('Invalid file URI.');
          const uri = vscode.Uri.parse(value, true);
          if (!['file', 'vscode-remote'].includes(uri.scheme)) throw new Error('Only local or VS Code remote files can be attached.');
          const name = path.posix.basename(uri.path);
          if (!isImagePath(name)) {
            attachments.push({ id: uri.toString(), type: 'file', name, path: uri.fsPath });
            continue;
          }
          if (attachments.filter(a => a.type === 'image').length >= IMAGE_LIMITS.count) throw new Error('Attach at most 4 images per message.');
          const stat = await vscode.workspace.fs.stat(uri);
          if (!(stat.type & vscode.FileType.File) || stat.size > IMAGE_LIMITS.bytes) throw new Error('Image must be a file of at most 4 MiB.');
          const bytes = await vscode.workspace.fs.readFile(uri);
          const { mime } = inspectImage(bytes);
          if (imageBytes + bytes.length > IMAGE_LIMITS.totalBytes) throw new Error('Images must total at most 12 MiB.');
          imageBytes += bytes.length;
          attachments.push({ id: uri.toString(), type: 'image', name, data: Buffer.from(bytes).toString('base64'), mime });
        } catch (err) { errors.push(String(err)); }
      }
    } catch (err) { errors.push(String(err)); }
    this.postMessage({ type: 'attachmentsSelected', requestId, attachments, errors });
  }

  /** Inline fuzzy file search — results rendered as a dropdown inside the webview */
  async searchFiles(query: string): Promise<void> {
    const glob = query ? `**/*${query}*` : '**/*';
    const files = await vscode.workspace.findFiles(glob, '**/{node_modules,.git,out,dist}/**', 12);
    const results = files.map(uri => ({
      label: vscode.workspace.asRelativePath(uri),
      path: uri.fsPath,
    })).sort((a, b) => a.label.length - b.label.length);
    this.postMessage({ type: 'fileResults', query, results });
  }

}
