import { describe, expect, mock, test } from 'bun:test';
import { mkdtempSync, writeFileSync, rmSync, mkdirSync, utimesSync, createReadStream } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SessionRepository } from '../src/services/session-repository.ts';

describe('session repository', () => {
  test('history uses the latest session_info name, including renames after messages', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'pi-chat-session-'));
    const file = join(dir, 'session.jsonl');
    const repository = new SessionRepository(dir);
    try {
      const entries = [
        { type: 'session', id: 'session-1' },
        { type: 'message', message: { role: 'user', content: 'First prompt' } },
        { type: 'session_info', name: 'Old name' },
        { type: 'session_info', name: 'Latest name' },
      ];
      writeFileSync(file, entries.map(e => JSON.stringify(e)).join('\n') + '\n{partial');
      expect(await repository.getTitle(file)).toBe('Latest name');
      writeFileSync(file, [...entries, { type: 'session_info', name: '' }].map(e => JSON.stringify(e)).join('\n'));
      expect(await repository.getTitle(file)).toBe('First prompt');
      writeFileSync(file, JSON.stringify({ type: 'session_info', name: 'Named before first prompt' }));
      expect(await repository.getTitle(file)).toBe('Named before first prompt');
    } finally {
      repository.dispose();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('sorts and limits metadata before opening session files', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'pi-chat-sessions-'));
    const open = mock(createReadStream);
    const repository = new SessionRepository(dir, open);
    try {
      for (let i = 0; i < 55; i++) {
        const file = join(dir, `${i}.jsonl`);
        writeFileSync(file, JSON.stringify({ type: 'session_info', name: `Session ${i}` }));
        utimesSync(file, i + 100, i + 100);
      }
      mkdirSync(join(dir, 'directory.jsonl'));
      writeFileSync(join(dir, 'not-a-session.txt'), 'ignored');
      const sessions = await repository.list();
      expect(sessions).toHaveLength(50);
      expect(sessions[0].title).toBe('Session 54');
      expect(sessions.at(-1)?.title).toBe('Session 5');
      expect(open).toHaveBeenCalledTimes(50);
      await repository.list();
      expect(open).toHaveBeenCalledTimes(50); // Unchanged titles are cached.
      writeFileSync(join(dir, '54.jsonl'), JSON.stringify({ type: 'session_info', name: 'Renamed session' }));
      expect((await repository.list())[0].title).toBe('Renamed session');
      expect(open).toHaveBeenCalledTimes(51);
    } finally { repository.dispose(); rmSync(dir, { recursive: true, force: true }); }
  });

  test('image blocks do not become titles; a later name overrides a long first prompt', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'pi-chat-session-'));
    const file = join(dir, 'image.jsonl');
    const repository = new SessionRepository(dir);
    try {
      const first = { type: 'message', message: { role: 'user', content: [
        { type: 'image', data: 'A'.repeat(256 * 1024), mimeType: 'image/png' },
        { type: 'text', text: 'x'.repeat(70) },
      ] } };
      writeFileSync(file, JSON.stringify(first) + '\n');
      expect(await repository.getTitle(file)).toBe('x'.repeat(60) + '…');
      writeFileSync(file, JSON.stringify(first) + '\n' + JSON.stringify({ type: 'session_info', name: 'Screenshot review' }));
      expect(await repository.getTitle(file)).toBe('Screenshot review');
    } finally { repository.dispose(); rmSync(dir, { recursive: true, force: true }); }
  });

  test('missing directories/files and disposal return safe empty/fallback results', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'pi-chat-session-'));
    const repository = new SessionRepository(join(dir, 'missing'));
    try {
      expect(await repository.list()).toEqual([]);
      expect(await repository.getTitle(join(dir, 'gone.jsonl'))).toBe('gone');
      repository.dispose();
      expect(await repository.list()).toEqual([]);
      expect(await repository.getTitle(join(dir, 'gone.jsonl'))).toBe('gone');
    } finally { repository.dispose(); rmSync(dir, { recursive: true, force: true }); }
  });
});
