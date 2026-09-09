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


def load_fixture(saved_state=None):
    fixture_html = html
    for token, filename in [('defaultStyleUri', 'style.css'), ('customStyleUri', 'style.custom.css')]:
        css = (root / 'media' / filename).read_text()
        uri = js('URL.createObjectURL(new Blob([' + json.dumps(css) + '], {type: "text/css"}))')
        fixture_html = fixture_html.replace('${' + token + '}', uri)
    js('document.open(); document.write(' + json.dumps(fixture_html) + '); document.close();')
    js('window.testSavedState = ' + json.dumps(saved_state) + ';')
    js('''
      window.testPostedMessages = [];
      window.acquireVsCodeApi = () => ({
        getState: () => structuredClone(testSavedState),
        setState: value => { testSavedState = structuredClone(value); },
        postMessage: message => testPostedMessages.push(message)
      });
      window.testErrors = [];
      window.addEventListener('error', event => testErrors.push(event.message));
      document.documentElement.style.setProperty('--warning', '#ffaa00');
      document.documentElement.style.setProperty('--error', '#ff0000');
      document.documentElement.style.setProperty('--card-bg', '#ffffff');
      document.documentElement.style.setProperty('--text-dim', '#64748b');
    ''')
    js((root / 'media/main.js').read_text())
    js('''new Promise((resolve, reject) => {
      const link = document.getElementById('chat-style');
      if (link.sheet) return resolve();
      link.addEventListener('load', resolve, {once: true});
      link.addEventListener('error', () => reject(new Error('Stylesheet failed to load')), {once: true});
    })''')


target = new_tab('about:blank')
try:
    load_fixture()
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
    print('10 tool-state regression tests passed')

    # Use a real browser click to exercise the footer action, including layout.
    cdp('Emulation.setDeviceMetricsOverride', width=360, height=800, deviceScaleFactor=1, mobile=False)
    button = next(node for node in cdp('Accessibility.getFullAXTree')['nodes']
                  if node.get('role', {}).get('value') == 'button'
                  and node.get('name', {}).get('value') == 'Select chat style (current: Custom)')
    bounds = cdp('DOM.getBoxModel', backendNodeId=button['backendDOMNodeId'])['model']['content']
    click_at_xy(sum(bounds[0::2]) / 4, sum(bounds[1::2]) / 4)
    assert js('testPostedMessages.at(-1)') == {'type': 'selectStyle', 'currentStyle': 'custom'}
    assert js('''(() => {
      const keys = document.getElementById('btn-keys');
      const style = document.getElementById('btn-style');
      return keys.nextElementSibling === style
        && style.getBoundingClientRect().left >= keys.getBoundingClientRect().right;
    })()'''), 'Style button must be to the right of Keys'
    print('PASS: Style button opens the picker next to Keys in a narrow sidebar')

    style_results = js('''(async () => {
      const passed = [];
      const assert = (condition, message) => { if (!condition) throw new Error(message); };
      const send = data => window.dispatchEvent(new MessageEvent('message', {data}));
      const link = document.getElementById('chat-style');
      const select = style => new Promise((resolve, reject) => {
        link.addEventListener('load', resolve, {once: true});
        link.addEventListener('error', () => reject(new Error('Stylesheet failed to load')), {once: true});
        send({type: 'styleSelected', style});
      });
      const saved = async () => {
        await new Promise(resolve => setTimeout(resolve, 150));
        return testSavedState;
      };
      send({type: 'loadHistory', messages: [
        {role: 'assistant', content: [
          {type: 'toolCall', id: 'styled-failure', name: 'bash', arguments: {}},
          {type: 'toolCall', id: 'styled-unknown', name: 'read', arguments: {}}
        ]},
        {role: 'toolResult', toolCallId: 'styled-failure', isError: true, content: [{text: 'Failed'}]}
      ]});
      send({type: 'toolStart', messageId: 'current', toolCallId: 'styled-interrupted', toolName: 'bash', args: '{}'});
      send({type: 'agentEnd'});
      const failure = document.getElementById('tool-styled-failure');
      failure.open = true;
      document.getElementById('input').value = 'Unsent draft';
      const content = document.getElementById('messages').innerHTML;

      await select('default');
      assert(link.getAttribute('href') === link.dataset.default, 'Default stylesheet not selected');
      assert(getComputedStyle(failure).backgroundColor === 'rgb(255, 255, 255)', 'Default retained custom background');
      assert(getComputedStyle(failure.querySelector('.tool-status')).color === 'rgb(255, 0, 0)', 'Default missing error styling');
      assert(getComputedStyle(document.querySelector('#tool-styled-interrupted .tool-status')).color === 'rgb(255, 170, 0)', 'Default missing interrupted styling');
      assert(getComputedStyle(document.querySelector('#tool-styled-unknown .tool-status')).color === 'rgb(100, 116, 139)', 'Default missing unknown styling');
      assert(document.getElementById('messages').innerHTML === content, 'Style switch changed conversation');
      assert(document.getElementById('input').value === 'Unsent draft', 'Style switch cleared draft');
      assert((await saved()).style === 'default', 'Default preference not saved');
      passed.push('Default style updates all tool states without changing chat or draft');

      await select('custom');
      assert(link.getAttribute('href') === link.dataset.custom, 'Custom stylesheet not selected');
      assert(getComputedStyle(failure).backgroundColor === 'rgb(253, 236, 234)', 'Custom missing tinted background');
      assert((await saved()).style === 'custom', 'Custom preference not saved');
      passed.push('Custom style restores tinted backgrounds and saves the selection');

      send({type: 'styleSelected', style: 'https://invalid.example/theme.css'});
      assert(link.getAttribute('href') === link.dataset.custom, 'Untrusted stylesheet URL accepted');
      passed.push('Invalid styles fall back to a bundled stylesheet');

      await select('default');
      send({type: 'sessionCleared'});
      assert((await saved()).style === 'default', 'New chat reset the preference');
      assert(document.getElementById('btn-style').title.includes('Default'), 'Button has stale style label');
      passed.push('New chat preserves the selected style');
      assert(testErrors.length === 0, testErrors.join('; '));
      return {passed, savedState: testSavedState};
    })()''')
    assert len(style_results['passed']) == 4, style_results
    for name in style_results['passed']:
        print('PASS:', name)

    # A fresh JS context models disposal/restoration of the VS Code webview.
    restored_target = new_tab('about:blank')
    try:
        load_fixture(style_results['savedState'])
        assert js('''(() => {
          const link = document.getElementById('chat-style');
          return link.getAttribute('href') === link.dataset.default
            && document.getElementById('btn-style').title.includes('Default');
        })()'''), 'Saved style was not restored in a fresh webview'
        print('PASS: Saved style is restored in a fresh webview')
    finally:
        cdp('Target.closeTarget', targetId=restored_target)
    print('16 webview regression tests passed')
finally:
    cdp('Target.closeTarget', targetId=target)
