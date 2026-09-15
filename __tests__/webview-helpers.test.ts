import { describe, expect, test } from 'bun:test';
import { cleanAnsi, escapeHtml } from '../media/chat/dom.js';
import { fileRefParts } from '../media/chat/markdown.js';
import { fileUri } from '../media/chat/drop-input.js';
import { imageBytes, IMAGE_LIMITS } from '../media/chat/images.js';
import { IMAGE_LIMITS as HOST_IMAGE_LIMITS } from '../src/image-attachments.ts';
import { PNG } from './image-fixtures.ts';

describe('webview module helpers', () => {
  test('escapes markup and strips terminal control sequences', () => {
    expect(escapeHtml('<a title="x">&\'</a>')).toBe('&lt;a title=&quot;x&quot;&gt;&amp;&#39;&lt;/a&gt;');
    expect(cleanAnsi('\x1b[31mFailed\x1b[0m')).toBe('Failed');
  });

  test('parses file references with line ranges but not arbitrary domains', () => {
    expect(fileRefParts('src/main.ts:12-34')).toEqual({ filePath: 'src/main.ts', line: 12, endLine: 34 });
    expect(fileRefParts('package.json')?.filePath).toBe('package.json');
    expect(fileRefParts('C:\\work\\file.ts:42')?.line).toBe(42);
    expect(fileRefParts('example.com')).toBeNull();
    expect(fileRefParts('https://example.com/file.ts')).toBeNull();
  });

  test.each([
    ['/work/a b.png', 'file:///work/a%20b.png'],
    ['C:\\work\\a b.png', 'file:///C:/work/a%20b.png'],
    ['vscode-remote://ssh-remote+host/work/a%20b.png', 'vscode-remote://ssh-remote+host/work/a%20b.png'],
    ['vscode-file://vscode-app/work/a.png', 'file:///work/a.png'],
    ['https://example.com/a.png', ''],
    ['relative.png', ''],
  ])('normalizes drop reference %s', (input, expected) => {
    expect(fileUri(input)).toBe(expected);
  });

  test('webview image limits match host validation and base64 sizes account for padding', () => {
    expect(IMAGE_LIMITS).toEqual(HOST_IMAGE_LIMITS);
    for (const data of ['YQ==', 'YWI=', 'YWJj', PNG]) {
      expect(imageBytes({ data })).toBe(Buffer.from(data, 'base64').length);
    }
  });

  test('feature modules import without touching the DOM or acquiring the VS Code API', async () => {
    for (const [file, factory] of [
      ['shell', 'createShell'], ['conversation', 'createConversation'],
      ['composer', 'createComposer'], ['panels', 'createPanels'],
    ]) {
      const module = await import(`../media/chat/${file}.js`);
      expect(typeof module[factory]).toBe('function');
    }
  });

  test('entry bundles into one standalone CSP-compatible script', async () => {
    const build = await Bun.build({ entrypoints: [new URL('../media/main.js', import.meta.url).pathname],
      target: 'browser', format: 'iife', write: false });
    expect(build.success).toBe(true);
    expect(build.outputs).toHaveLength(1);
    const script = await build.outputs[0].text();
    expect(script.match(/\bacquireVsCodeApi\(/g)).toHaveLength(1);
    expect(script).not.toMatch(/^import\s/m);
  });
});
