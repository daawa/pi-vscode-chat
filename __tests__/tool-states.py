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
    # Keep each CDP request below the browser-harness daemon's line-size limit.
    for filename in ['vendor.js', 'main.js']:
        source = (root / 'media' / filename).read_text()
        js('window.testMainSource = "";')
        for offset in range(0, len(source), 6000):
            js('window.testMainSource += ' + json.dumps(source[offset:offset + 6000]))
        js('(0, eval)(window.testMainSource); delete window.testMainSource;')
    js('''new Promise((resolve, reject) => {
      const link = document.getElementById('chat-style');
      if (link.sheet) return resolve();
      link.addEventListener('load', resolve, {once: true});
      link.addEventListener('error', () => reject(new Error('Stylesheet failed to load')), {once: true});
    })''')


target = new_tab('about:blank')
try:
    load_fixture()
    js('''(() => {
      const assert = (value, message) => { if (!value) throw new Error(message); };
      const send = data => window.dispatchEvent(new MessageEvent('message', {data}));
      const input = document.getElementById('input');
      const button = document.getElementById('btn-send');
      const submissions = () => testPostedMessages.filter(m => m.type === 'prompt' || m.type === 'runCommand');
      assert(input.readOnly && button.disabled && input.placeholder.includes('Loading'), 'Startup must lock the composer');
      send({type: 'setInputText', text: 'Preserved draft'});
      send({type: 'init', state: 'idle', sessionId: 'resumed'});
      assert(button.disabled, 'Init or input update unlocked submission before history');
      input.dispatchEvent(new KeyboardEvent('keydown', {key: 'Enter', bubbles: true}));
      button.click();
      document.querySelector('[data-cmd]').click();
      assert(submissions().length === 0 && input.value === 'Preserved draft', 'Loading submitted or lost the draft');
      send({type: 'loadHistory', messages: [{role: 'user', content: 'Earlier context'}]});
      assert(button.disabled, 'Snapshot alone must not bypass the loading lifecycle');
      send({type: 'historyLoading', loading: false});
      assert(!input.readOnly && !button.disabled, 'Successful history did not unlock');
      assert(document.getElementById('messages').textContent.includes('Earlier context'), 'History was not rendered');
      input.dispatchEvent(new KeyboardEvent('keydown', {key: 'Enter', bubbles: true}));
      assert(submissions().length === 1 && submissions()[0].text === 'Preserved draft', 'Ready composer did not submit draft');

      send({type: 'historyLoading', loading: true});
      send({type: 'setInputText', text: 'Retry draft'});
      send({type: 'error', message: 'Failed to load session history'});
      send({type: 'historyLoading', loading: false});
      assert(!input.readOnly && !button.disabled, 'History failure left composer locked');
      assert(document.querySelector('.error-banner').textContent.includes('Failed to load'), 'History failure was not visible');
      button.click();
      assert(submissions().length === 2 && submissions()[1].text === 'Retry draft', 'Cannot submit after visible failure');
    })()''')
    print('PASS: Startup blocks Enter, Send and commands until history is rendered, preserving the draft')
    print('PASS: A visible history failure unlocks the composer')
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

      test('session label uses name, falls back to ID, and clears stale identity', () => {
        const header = document.getElementById('session-header');
        const label = document.getElementById('session-name');
        const init = metadata => send({ type: 'init', state: 'idle', ...metadata });
        assert(header.classList.contains('hidden'), 'Unknown session should be hidden');
        init({ sessionId: 'full-session-uuid' });
        assert(label.textContent === 'full-session-uuid', 'Missing ID fallback');
        assert(!header.classList.contains('hidden'), 'Session ID should be visible');
        init({ sessionId: 'full-session-uuid', sessionName: 'My session' });
        assert(label.textContent === 'My session', 'Name should take precedence');
        assert(label.title.includes('My session') && label.title.includes('full-session-uuid'), 'Tooltip should include name and ID');
        init({ sessionId: 'full-session-uuid', sessionName: '<b>Renamed</b>' });
        assert(label.textContent === '<b>Renamed</b>' && !label.querySelector('b'), 'Name must render as text');
        init({ sessionId: 'next-session' });
        assert(label.textContent === 'next-session', 'Old name leaked into next session');
        init({ sessionId: 'next-session', sessionName: '' });
        assert(label.textContent === 'next-session', 'Cleared name should fall back to ID');
        reset();
        assert(header.classList.contains('hidden') && !label.textContent && !label.title, 'New session must clear identity');
        init({ sessionId: 'session-3', sessionName: 'Resumed' });
        init({});
        assert(header.classList.contains('hidden'), 'Unavailable state must not retain old name');
      });

      test('session label truncates long names without losing full text', () => {
        const name = 'A very long session name '.repeat(40);
        send({ type: 'init', state: 'idle', sessionId: 'session-1', sessionName: name });
        const header = document.getElementById('session-header');
        const label = document.getElementById('session-name');
        header.style.width = '240px';
        const style = getComputedStyle(label);
        assert(style.textOverflow === 'ellipsis' && style.whiteSpace === 'nowrap', 'Missing truncation styles');
        assert(label.scrollWidth > label.clientWidth, 'Long name should overflow its label');
        assert(label.getBoundingClientRect().right <= header.getBoundingClientRect().right, 'Label overflows header');
        assert(label.textContent === name && label.title.includes(name), 'Full name was lost');
        header.style.width = '';
      });

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
        assert(card('edit').querySelector('.d2h-diff-table'), 'Bundled diff renderer produced no table');
        end('edit', true); diff('edit'); check('edit', 'error');
        assert(!card('edit').querySelector('.tool-diff'), 'Failed tool retained a success diff');
      });

      test('diffs never complete active tools or resurrect cleared cards', () => {
        start('orphan'); diff('orphan'); check('orphan', 'running');
        assert(!card('orphan').querySelector('.tool-diff'), 'Running tool received a diff');
        reset(); diff('orphan');
        assert(!card('orphan'), 'Diff resurrected a cleared card');
      });

      test('edit review actions remain visible outside collapsed tools and update in place', () => {
        start('review'); end('review', false); diff('review');
        const record = {type: 'editRecorded', editId: 'review', filePath: '/workspace/example.txt'};
        send(record); send(record);
        send({type: 'editsSummary', pending: [{editId: 'review', filePath: record.filePath}]});
        assert(document.querySelectorAll('#edit-review').length === 1, 'Repeated edit duplicated review actions');
        const review = document.getElementById('edit-review');
        assert(!card('review').open && review.getBoundingClientRect().height > 0, 'Collapsed tool hides review actions');
        for (const action of ['showDiff', 'acceptEdit', 'revertEdit']) {
          review.querySelector(`[data-action="${action}"]`).click();
          assert(testPostedMessages.at(-1).type === action && testPostedMessages.at(-1).editId === 'review', 'Review action not sent');
        }
        assert(!document.getElementById('changes-bar').classList.contains('hidden'), 'Changes bar missing');
        send({type: 'editAccepted', editId: 'review'});
        assert(review.textContent.includes('Kept'), 'Keep did not settle review card');
        send({type: 'editsSummary', pending: []});
        assert(document.getElementById('changes-bar').classList.contains('hidden'), 'Empty changes bar retained');
      });

      test('Pi display diffs remain readable when no unified patch is available', () => {
        start('raw'); end('raw', false);
        send({type: 'toolDiff', toolCallId: 'raw', filePath: 'example.txt', diff: '-1 old\\n+1 new'});
        assert(card('raw').querySelector('.diff-content code').textContent.includes('-1 old'), 'Display diff lost in renderer');
      });

      return { passed, errors: testErrors };
    })()''')
    assert isinstance(results, dict) and len(results.get('passed', [])) == 14, results
    assert not results['errors'], results['errors']
    for name in results['passed']:
        print('PASS:', name)
    print('14 session/tool-state regression tests passed')

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
      send({type: 'init', state: 'idle', sessionName: 'Default style session', sessionId: 'session-1'});
      assert(document.getElementById('session-name').textContent === 'Default style session', 'Default missing session label');
      assert(getComputedStyle(document.getElementById('session-name')).textOverflow === 'ellipsis', 'Default missing session truncation');
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
    print('22 webview regression tests passed')
finally:
    cdp('Target.closeTarget', targetId=target)
