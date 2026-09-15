import * as path from 'node:path';
import { createReadStream, type ReadStream } from 'node:fs';
import { readdir, stat } from 'node:fs/promises';
import { createInterface, type Interface } from 'node:readline';
import { isRecord } from '../value-guards.ts';
import type { SessionInfo } from '../webview-types.ts';

/** Disk metadata only. Conversation history must still come from get_messages RPC. */
export class SessionRepository {
  private titles = new Map<string, { version: string; title: string }>();
  private readers = new Set<{ input: ReadStream; lines: Interface }>();
  private disposed = false;
  constructor(private readonly directory: string, private readonly openFile = createReadStream) {}

  async list(): Promise<SessionInfo[]> {
    if (this.disposed || !this.directory) return [];
    let names: string[];
    try { names = await readdir(this.directory); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw error;
    }
    if (this.disposed) return [];
    const entries = await mapLimited(names.filter(name => name.endsWith('.jsonl')), 8, async name => {
      const filePath = path.join(this.directory, name);
      try {
        const info = await stat(filePath);
        return info.isFile() ? { name, filePath, info } : undefined;
      } catch { return undefined; } // A session can disappear while the list is being refreshed.
    });
    const latest = entries.filter(entry => entry !== undefined)
      .sort((a, b) => b.info.mtimeMs - a.info.mtimeMs).slice(0, 50);
    const retained = new Set(latest.map(entry => entry.filePath));
    for (const file of this.titles.keys()) if (!retained.has(file)) this.titles.delete(file);
    // Only parse the visible sessions, with bounded I/O and memory usage.
    const sessions = await mapLimited(latest, 4, async ({ name, filePath, info }) => ({
      id: name, filePath, title: await this.getTitle(filePath),
      date: info.mtime.toLocaleString(), mtime: info.mtimeMs,
    }));
    return this.disposed ? [] : sessions;
  }

  async getTitle(filePath: string): Promise<string> {
    const fallback = path.basename(filePath, '.jsonl');
    if (this.disposed) return fallback;
    try {
      const info = await stat(filePath);
      if (this.disposed) return fallback;
      const version = `${info.mtimeMs}:${info.ctimeMs}:${info.size}`;
      const cached = this.titles.get(filePath);
      if (cached?.version === version) return cached.title;
      let name: string | undefined;
      let firstPrompt: string | undefined;
      const input = this.openFile(filePath, { encoding: 'utf8' });
      const lines = createInterface({ input, crlfDelay: Infinity });
      const reader = { input, lines };
      this.readers.add(reader);
      try {
        for await (const line of lines) {
          let entry: unknown;
          try { entry = JSON.parse(line); } catch { continue; }
          if (!isRecord(entry)) continue;
          if (entry.type === 'session' || entry.type === 'session_info') {
            name = typeof entry.name === 'string' ? entry.name.trim() : undefined;
          }
          if (firstPrompt === undefined && entry.type === 'message' && isRecord(entry.message) && entry.message.role === 'user') {
            const content = entry.message.content;
            firstPrompt = (Array.isArray(content)
              ? content.map(block => isRecord(block) && typeof block.text === 'string' ? block.text : '').join('')
              : typeof content === 'string' ? content : '').trim();
          }
        }
      } finally { this.readers.delete(reader); lines.close(); input.destroy(); }
      if (this.disposed) return fallback;
      const title = name || (firstPrompt ? firstPrompt.slice(0, 60) + (firstPrompt.length > 60 ? '…' : '') : fallback);
      this.titles.set(filePath, { version, title });
      return title;
    } catch { return fallback; }
  }

  dispose(): void {
    this.disposed = true;
    for (const { lines, input } of this.readers) { lines.close(); input.destroy(); }
    this.readers.clear();
    this.titles.clear();
  }
}

async function mapLimited<T, R>(values: T[], concurrency: number, fn: (value: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(values.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(concurrency, values.length) }, async () => {
    while (next < values.length) {
      const index = next++;
      results[index] = await fn(values[index]);
    }
  }));
  return results;
}
