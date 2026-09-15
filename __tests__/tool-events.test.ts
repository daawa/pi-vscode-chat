import { afterEach, describe, expect, test } from 'bun:test';
import { createProvider, EditManager, readFile, writeFile, deleteFile, toolEnd, resetHostFixture } from './host-fixture.ts';
afterEach(resetHostFixture);

describe('tool completion bridge', () => {
  test('Pi start args and arg-less completion produce working Diff / Keep / Undo', async () => {
    const manager = new EditManager();
    const { provider, messages } = await createProvider(true, manager);
    readFile.mockResolvedValueOnce(Buffer.from('old content'));
    provider.events.handleToolStart({ toolCallId: 'edit-1', toolName: 'edit', args: { path: 'example.txt' } });
    const { args, ...end } = toolEnd(false);
    await provider.events.handleToolEnd(end);
    const record = manager.getPendingEdits()[0];
    expect(record.originalContent).toBe('old content');
    expect(record.newContent).toBe('new content');
    expect(record.diff).toContain('-old content');
    expect(record.diff).toContain('+new content');
    expect(messages.find(m => m.type === 'editRecorded')).toMatchObject({ editId: record.id });
    expect(messages.find(m => m.type === 'toolDiff')?.diff).toBe(record.diff);
    await provider.handleMessage({ type: 'revertEdit', editId: record.id });
    expect(writeFile.mock.calls[0][1].toString()).toBe('old content');
    expect(manager.getPendingEdits()).toHaveLength(0);
    expect(messages.some(m => m.type === 'editReverted')).toBe(true);
  });

  test('write without a Pi diff generates a patch; Undo removes a newly created file', async () => {
    const manager = new EditManager();
    const { provider, messages } = await createProvider(true, manager);
    readFile.mockRejectedValueOnce(Object.assign(new Error('missing'), { code: 'FileNotFound' }));
    provider.events.handleToolStart({ toolCallId: 'write-1', toolName: 'write', args: { file_path: 'new.txt' } });
    await provider.events.handleToolEnd({ toolCallId: 'write-1', toolName: 'write', isError: false, result: {} });
    const record = manager.getPendingEdits()[0];
    expect(record.originalExists).toBe(false);
    expect(messages.find(m => m.type === 'toolDiff')?.diff).toContain('+new content');
    await manager.revertEdit(record.id);
    expect(deleteFile).toHaveBeenCalledWith(expect.objectContaining({ fsPath: '/workspace/new.txt' }));
  });

  test('repeated edits share a baseline until Keep, then capture a fresh baseline', async () => {
    const manager = new EditManager();
    readFile.mockResolvedValueOnce(Buffer.from('original'));
    await manager.snapshotFile('/workspace/example.txt');
    const first = await manager.recordEdit('/workspace/example.txt', 'second');
    await manager.snapshotWorkspace();
    await manager.snapshotFile('/workspace/example.txt');
    const second = await manager.recordEdit('/workspace/example.txt', 'third');
    expect(second.id).toBe(first.id);
    expect(second.originalContent).toBe('original');
    expect(manager.getPendingEdits()).toHaveLength(1);
    manager.acceptEdit(second.id);
    readFile.mockResolvedValueOnce(Buffer.from('third'));
    await manager.snapshotFile('/workspace/example.txt');
    const next = await manager.recordEdit('/workspace/example.txt', 'fourth');
    expect(next.id).not.toBe(first.id);
    expect(next.originalContent).toBe('third');
  });

  test('never takes an Undo snapshot after completion', async () => {
    const manager = new EditManager();
    await expect(manager.recordEdit('/workspace/example.txt', 'changed')).rejects.toThrow('Cannot snapshot');
    expect(readFile).not.toHaveBeenCalled();
  });

  test('process exit settles tools before displaying the error banner', async () => {
    const { pi, messages } = await createProvider();
    pi.emit('exit', 1, null, 'crashed');
    expect(messages.map(m => m.type)).toEqual(['agentEnd', 'error']);
    expect(messages[1].message).toContain('crashed');
    // Allow the asynchronously requested idle state to arrive as well.
    await Promise.resolve();
    await Promise.resolve();
    expect(messages.find(m => m.type === 'init')?.state).toBe('idle');
  });

  test('failed tools publish their outcome without edit/diff work', async () => {
    const { provider, edits, messages } = await createProvider();
    await provider.events.handleToolEnd(toolEnd(true));
    expect(messages).toEqual([{
      type: 'toolEnd', messageId: 'current', toolCallId: 'edit-1',
      toolName: 'edit', isError: true, output: 'Edit failed',
    }]);
    expect(readFile).not.toHaveBeenCalled();
    expect(edits.recordEdit).not.toHaveBeenCalled();
  });

  test('completion precedes agentEnd even when file processing is delayed', async () => {
    let release!: (content: Buffer) => void;
    const fileRead = new Promise<Buffer>(resolve => { release = resolve; });
    readFile.mockImplementation(() => fileRead);
    const { provider, pi, messages } = await createProvider();

    const pending = provider.events.handleToolEnd(toolEnd(false));
    expect(messages.map(m => m.type)).toEqual(['toolEnd']);
    expect(messages[0].isError).toBe(false);

    pi.emit('event', { type: 'agent_end', messages: [] });
    expect(messages.slice(0, 2).map(m => m.type)).toEqual(['toolEnd', 'agentEnd']);
    expect(messages.some(m => m.type === 'toolDiff')).toBe(false);

    release(Buffer.from('new content'));
    await pending;
    expect(messages.filter(m => m.type === 'toolEnd')).toHaveLength(1);
    expect(messages.find(m => m.type === 'toolDiff')).toMatchObject({
      toolCallId: 'edit-1', filePath: 'example.txt', fileContent: 'new content',
    });
  });

  test('edit bookkeeping failure cannot change an already-published outcome', async () => {
    const { provider, edits, messages } = await createProvider();
    edits.recordEdit.mockImplementation(async () => { throw new Error('snapshot unavailable'); });
    await provider.events.handleToolEnd(toolEnd(false));
    expect(messages[0]).toMatchObject({ type: 'toolEnd', isError: false });
    expect(messages.filter(m => m.type === 'toolEnd')).toHaveLength(1);
    expect(messages[1].type).toBe('toolDiff');
  });
});
