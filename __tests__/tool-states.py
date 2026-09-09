"""Browser regression tests: run `bun run test:webview` from the repository root.

Requires browser-harness and its Chrome connection. Loads the real webview HTML,
CSS and main.js in an isolated blank tab, with a mocked VS Code messaging API.
No Pi process is started and no workspace files or real chat state are changed.
"""

import json
import re
from pathlib import Path

root = Path.cwd()
provider = (root / 'src/chatSidebarProvider.ts').read_text()
html = provider.split('return /* html */`', 1)[1].split('`;', 1)[0]
# Resource URIs and CSP belong to the extension host, not this isolated fixture.
html = re.sub(r'<meta http-equiv="Content-Security-Policy"[^>]*>', '', html)
html = re.sub(r'<script\b[^>]*>.*?</script>', '', html, flags=re.S)
html = re.sub(r'<link\b[^>]*>', '', html)

target = new_tab('about:blank')
try:
    js('document.open(); document.write(' + json.dumps(html) + '); document.close();')
    js('''
      window.acquireVsCodeApi = () => ({
        getState: () => null, setState: () => {}, postMessage: () => {}
      });
      window.testErrors = [];
      window.addEventListener('error', event => testErrors.push(event.message));
    ''')
    js('''(() => {
      const style = document.createElement('style');
      style.textContent = ''' + json.dumps((root / 'media/style.custom.css').read_text()) + ''';
      document.head.appendChild(style);
      document.documentElement.style.setProperty('--warning', '#ffaa00');
      document.documentElement.style.setProperty('--error', '#ff0000');
    })()''')
    js((root / 'media/main.js').read_text())
    results = js('''(() => {
      const passed = [];
      const assert = (condition, message) => {
        if (!condition) throw new Error(message);
      };
      const send = data => window.dispatchEvent(new MessageEvent('message', { data }));
      const reset = () => send({ type: 'sessionCleared' });
      const start = id => {
        send({ type: 'agentStart' });
        send({ type: 'toolStart', messageId: 'current', toolCallId: id,
          toolName: 'bash', args: '{"command":"exit 1"}' });
      };
      const end = (id, isError) => send({ type: 'toolEnd', toolCallId: id,
        isError, output: isError ? 'Command exited with code 1' : 'OK' });
      const card = id => document.getElementById(`tool-${id}`);
      const check = (id, status) => {
        const el = card(id);
        assert(el, `Missing card ${id}`);
        assert(el.className === `tool-card ${status}`, `${id}: ${el.className}, expected ${status}`);
        assert(!!el.querySelector('.spinner') === (status === 'running'), `${id}: spinner mismatch`);
        assert(!!el.querySelector('.tool-status').getAttribute('aria-label'), `${id}: missing status label`);
        return el;
      };
      const test = (name, fn) => {
        reset();
        fn();
        assert(testErrors.length === 0, testErrors.join('; '));
        passed.push(name);
      };
      const call = id => ({ type: 'toolCall', id, name: 'bash', arguments: {} });
      const result = (id, isError) => ({ role: 'toolResult', toolCallId: id,
        isError, content: [{ type: 'text', text: isError ? 'Failed' : 'OK' }] });
      const diff = id => send({ type: 'toolDiff', toolCallId: id, filePath: 'example.txt',
        fileContent: 'new', diff: '--- a/example.txt\\n+++ b/example.txt\\n@@ -1 +1 @@\\n-old\\n+new' });

      test('ordinary failure remains failed after agentEnd', () => {
        start('failed'); check('failed', 'running'); end('failed', true);
        send({ type: 'agentEnd' });
        const el = check('failed', 'error');
        assert(el.querySelector('.tool-status').title === 'Failed', 'Wrong failure icon label');
        assert(getComputedStyle(el).backgroundColor === 'rgb(253, 236, 234)', 'Missing error background');
      });

      test('ordinary success remains successful after agentEnd', () => {
        start('ok'); end('ok', false); send({ type: 'agentEnd' });
        check('ok', 'done');
      });

      test('unfinished tools become interrupted, not failed', () => {
        start('interrupted'); send({ type: 'agentEnd' });
        const el = check('interrupted', 'interrupted');
        assert(getComputedStyle(el.querySelector('.tool-status')).color === 'rgb(255, 170, 0)',
          'Missing interruption warning styling');
        end('interrupted', true);
        check('interrupted', 'error');
      });

      test('process-exit messages stop outstanding spinners', () => {
        start('exit');
        // The real provider exit handler is covered by tool-events.test.ts.
        send({ type: 'agentEnd' });
        send({ type: 'error', message: 'pi process exited' });
        send({ type: 'init', state: 'idle' });
        check('exit', 'interrupted');
      });

      test('unrelated error banners do not interrupt active tools', () => {
        start('active'); send({ type: 'error', message: 'Extension error' });
        check('active', 'running');
      });

      test('history uses explicit results and leaves missing outcomes unknown', () => {
        send({ type: 'loadHistory', messages: [
          { role: 'assistant', content: [call('history-ok'), call('history-fail'), call('history-missing')] },
          result('history-ok', false), result('history-fail', true)
        ] });
        check('history-ok', 'done'); check('history-fail', 'error');
        check('history-missing', 'unknown');
        send({ type: 'agentEnd' });
        check('history-missing', 'unknown');
      });

      test('history cards accept late output and failed completion', () => {
        send({ type: 'loadHistory', messages: [{ role: 'assistant', content: [call('late')] }] });
        check('late', 'unknown');
        send({ type: 'toolUpdate', toolCallId: 'late', output: 'partial output' });
        assert(card('late').querySelector('.tool-output code').textContent === 'partial output',
          'History card did not receive output');
        end('late', true); send({ type: 'agentEnd' });
        check('late', 'error');
      });

      test('repeated completion updates leave exactly one terminal class', () => {
        start('repeat'); end('repeat', true); check('repeat', 'error');
        end('repeat', false); check('repeat', 'done');
        assert(card('repeat').querySelector('.tool-status').title === 'Succeeded', 'Wrong success label');
        end('repeat', true); check('repeat', 'error');
      });

      test('late diff enrichment preserves completion and is ignored after failure', () => {
        start('edit'); end('edit', false); send({ type: 'agentEnd' });
        diff('edit'); check('edit', 'done');
        assert(card('edit').querySelector('.tool-diff'), 'Missing late diff');
        end('edit', true); diff('edit'); check('edit', 'error');
        assert(!card('edit').querySelector('.tool-diff'), 'Failed tool retained a success diff');
      });

      test('diffs never complete active tools or resurrect cleared cards', () => {
        start('orphan'); diff('orphan'); check('orphan', 'running');
        assert(!card('orphan').querySelector('.tool-diff'), 'Running tool received a diff');
        reset(); diff('orphan');
        assert(!card('orphan'), 'Diff resurrected a cleared card');
      });

      return { passed, errors: testErrors };
    })()''')
    assert isinstance(results, dict) and len(results.get('passed', [])) == 10, results
    assert not results['errors'], results['errors']
    for name in results['passed']:
        print('PASS:', name)
    print('10 webview regression tests passed')
finally:
    cdp('Target.closeTarget', targetId=target)
