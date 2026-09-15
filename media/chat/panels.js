import { $, cleanAnsi, escapeHtml, createElement } from './dom.js';
import { ICONS } from './icons.js';
import { createDialogs } from './dialogs.js';

export function createPanels({ vscode, isLocked }) {
  const widgetsContainer = $('widgets-container');
  const statusBar = $('status-bar');
  const queueBar = $('queue-bar');
  const footerStats = $('footer-stats');
  let activeStatuses = {};
  const { showDialog } = createDialogs(vscode);
  // ── Team monitor (pi-agents-team) ──

  const TEAM_AGENTS = ['orchestrator', 'scout', 'researcher', 'planner', 'worker', 'reviewer', 'oracle', 'context-builder', 'delegate'];
  let teamState = {};

  function isTeamAgent(key) {
    const k = String(key || '').toLowerCase();
    return TEAM_AGENTS.some(agent => k.includes(agent)) || k === 'team';
  }

  function updateTeamAgent(key, statusText, widgetLines) {
    const name = key.charAt(0).toUpperCase() + key.slice(1);
    if (!teamState[key]) teamState[key] = { name, status: 'Idle', detail: '', active: false };

    if (statusText !== undefined) {
      const cleanTxt = cleanAnsi(statusText);
      teamState[key].status = cleanTxt || 'Idle';
      teamState[key].active = !!cleanTxt && !cleanTxt.toLowerCase().includes('idle');
    }
    if (widgetLines !== undefined) {
      teamState[key].detail = widgetLines && widgetLines.length ? cleanAnsi(widgetLines[widgetLines.length - 1]) : '';
    }
    renderTeamGrid();
  }

  let teamPanelPinned = false;

  function renderTeamGrid() {
    const monitor = $('team-monitor');
    const grid = $('team-grid');
    const countBadge = $('team-active-count');

    grid.innerHTML = '';
    const keys = Object.keys(teamState);
    let activeCount = 0;

    keys.forEach(key => {
      const agent = teamState[key];
      if (agent.active) activeCount++;
      const card = createElement('div', 'agent-card');
      card.innerHTML = `
        <div class="agent-card-header">
          <span class="agent-card-name">${escapeHtml(agent.name)}</span>
          <div class="agent-status-dot ${agent.active ? 'active' : ''}"></div>
        </div>
        <div class="agent-card-status" title="${escapeHtml(agent.status)}">${escapeHtml(agent.status)}</div>
        <div class="agent-card-detail" title="${escapeHtml(agent.detail)}">${escapeHtml(agent.detail || '—')}</div>`;
      grid.appendChild(card);
    });

    if (keys.length === 0) {
      if (teamPanelPinned) {
        monitor.classList.remove('hidden');
        grid.innerHTML = '<div class="team-empty">No active agents. Use <b>Init</b> to set up a team, then ask Pi to delegate work.</div>';
      } else {
        monitor.classList.add('hidden');
      }
      countBadge.textContent = '0 active';
    } else {
      monitor.classList.remove('hidden');
      countBadge.textContent = `${activeCount} active`;
    }
  }

  function toggleTeamPanel() {
    const monitor = $('team-monitor');
    if (monitor.classList.contains('hidden')) {
      teamPanelPinned = true;
      renderTeamGrid();
    } else {
      teamPanelPinned = false;
      monitor.classList.add('hidden');
    }
  }

  // ── Status bar & widgets ──

  // Run a pi extension command silently (no chat bubble). The extension
  // updates its own status afterwards, which refreshes the chip.
  function runCommand(cmd) {
    if (isLocked()) return;
    vscode.postMessage({ type: 'runCommand', command: cmd });
  }

  const CAVEMAN_LEVELS = ['off', 'lite', 'full', 'ultra', 'wenyan-lite', 'wenyan', 'wenyan-ultra', 'micro'];

  let chipMenuEl = null;
  function closeChipMenu() {
    if (chipMenuEl) { chipMenuEl.remove(); chipMenuEl = null; }
  }
  document.addEventListener('mousedown', (e) => {
    if (chipMenuEl && !chipMenuEl.contains(e.target)) closeChipMenu();
  });

  function showChipMenu(anchor, items) {
    closeChipMenu();
    chipMenuEl = createElement('div', 'chip-menu');
    items.forEach(it => {
      const b = createElement('button', `chip-menu-item${it.active ? ' active' : ''}`);
      b.innerHTML = `<span class="check">${it.active ? ICONS.check : ''}</span><span>${escapeHtml(it.label)}</span>`;
      b.addEventListener('click', () => { closeChipMenu(); it.fn(); });
      chipMenuEl.appendChild(b);
    });
    document.body.appendChild(chipMenuEl);
    const r = anchor.getBoundingClientRect();
    const mh = chipMenuEl.offsetHeight;
    chipMenuEl.style.left = Math.min(r.left, window.innerWidth - chipMenuEl.offsetWidth - 8) + 'px';
    chipMenuEl.style.top = Math.max(4, r.top - mh - 4) + 'px';
  }

  function updateStatus(statusKey, statusText) {
    if (isTeamAgent(statusKey)) {
      updateTeamAgent(statusKey, statusText, undefined);
      return;
    }
    if (!statusText) delete activeStatuses[statusKey];
    else activeStatuses[statusKey] = statusText;
    renderStatusBar();
  }

  function buildStatusChip(key, raw) {
    // Busy chips (retry/compaction) keep a real spinner — they represent live work
    if (key === '__retry' || key === '__compaction') {
      const chip = createElement('div', 'status-item busy');
      chip.innerHTML = `<div class="spinner"></div><span>${escapeHtml(raw)}</span>`;
      return chip;
    }

    // pi-rtk → on/off toggle
    if (key === 'pi-rtk') {
      const off = /✗|✕|disabled|off/i.test(raw);
      const on = !off;
      const chip = createElement('button', `status-item action toggle ${on ? 'on' : 'off'}`);
      chip.title = `${raw}\nClick to ${on ? 'disable' : 'enable'} rtk`;
      chip.innerHTML = `<span class="dot"></span><span>rtk</span>`;
      chip.addEventListener('click', () => runCommand(`/rtk ${on ? 'disable' : 'enable'}`));
      return chip;
    }

    // caveman → level picker (strip the animated frame char from the text)
    if (key === 'caveman') {
      const m = raw.match(/caveman level:\s*([\w-]+)/i);
      const level = (m ? m[1] : '?').toLowerCase();
      const chip = createElement('button', 'status-item action');
      chip.title = 'Caveman prompt compression — click to change level';
      chip.innerHTML = `<span>caveman: <b>${escapeHtml(level)}</b></span><svg class="chev" width="9" height="9" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M4 10l4-4 4 4"/></svg>`;
      chip.addEventListener('click', () => showChipMenu(chip, CAVEMAN_LEVELS.map(l => ({
        label: l,
        active: l === level,
        fn: () => runCommand(`/caveman ${l}`),
      }))));
      return chip;
    }

    // pi-agent-team → condensed text, click opens the team panel
    if (key === 'pi-agent-team') {
      const short = raw.split(/[·\-–]\s*Tip:/i)[0].replace(/\s+/g, ' ').trim();
      const chip = createElement('button', 'status-item action');
      chip.title = `${raw}\nClick to open the team panel`;
      chip.innerHTML = `${ICONS.agent}<span>${escapeHtml(short.slice(0, 48))}</span>`;
      chip.addEventListener('click', toggleTeamPanel);
      return chip;
    }

    // Generic: static informational chip — no fake spinner
    const chip = createElement('div', 'status-item');
    chip.title = raw;
    chip.innerHTML = `<span>${escapeHtml(raw.slice(0, 80))}</span>`;
    return chip;
  }

  function renderStatusBar() {
    const keys = Object.keys(activeStatuses);
    statusBar.innerHTML = '';
    if (keys.length === 0) {
      statusBar.classList.add('hidden');
      return;
    }
    statusBar.classList.remove('hidden');
    keys.forEach(key => {
      statusBar.appendChild(buildStatusChip(key, cleanAnsi(activeStatuses[key]).trim()));
    });
  }

  function updateWidget(widgetKey, widgetLines) {
    if (isTeamAgent(widgetKey)) {
      updateTeamAgent(widgetKey, undefined, widgetLines);
      return;
    }
    let card = widgetsContainer.querySelector(`.widget-card[data-widget-key="${widgetKey}"]`);
    if (!widgetLines || widgetLines.length === 0) {
      if (card) card.remove();
    } else {
      if (!card) {
        card = createElement('div', 'widget-card');
        card.dataset.widgetKey = widgetKey;
        widgetsContainer.appendChild(card);
      }
      card.innerHTML = `
        <div class="widget-card-title">${escapeHtml(widgetKey)}</div>
        <div class="widget-card-line">${escapeHtml(widgetLines.map(cleanAnsi).join('\n'))}</div>`;
    }
    widgetsContainer.classList.toggle('hidden', widgetsContainer.children.length === 0);
  }

  // ── Queue bar ──

  function renderQueue(steering, followUp) {
    const total = (steering?.length || 0) + (followUp?.length || 0);
    if (!total) {
      queueBar.classList.add('hidden');
      queueBar.innerHTML = '';
      return;
    }
    queueBar.classList.remove('hidden');
    queueBar.innerHTML = '';
    (steering || []).forEach(t => {
      queueBar.appendChild(createElement('span', 'queue-chip steer', `↪ ${escapeHtml(t.slice(0, 60))}`));
    });
    (followUp || []).forEach(t => {
      queueBar.appendChild(createElement('span', 'queue-chip follow', `⏭ ${escapeHtml(t.slice(0, 60))}`));
    });
  }

  // ── Stats footer ──

  function renderStats(stats) {
    if (!stats) { footerStats.textContent = ''; return; }
    const parts = [];
    if (stats.contextUsage && stats.contextUsage.percent != null) {
      const pct = Math.round(stats.contextUsage.percent);
      parts.push(`<span class="ctx ${pct > 80 ? 'warn' : ''}">${pct}% context</span>`);
    }
    if (typeof stats.cost === 'number' && stats.cost > 0) {
      parts.push(`<span>$${stats.cost.toFixed(3)}</span>`);
    }
    if (stats.tokens?.total) {
      const t = stats.tokens.total;
      parts.push(`<span>${t > 1000 ? (t / 1000).toFixed(1) + 'k' : t} tok</span>`);
    }
    footerStats.innerHTML = parts.join('<span class="sep">·</span>');
  }

  // Team panel actions (Init / Result / Stop / Close)
  document.querySelectorAll('.team-action').forEach(btn => {
    btn.addEventListener('click', () => runCommand(btn.dataset.cmd));
  });
  const btnCloseTeam = $('btn-close-team');
  if (btnCloseTeam) {
    btnCloseTeam.addEventListener('click', () => {
      teamPanelPinned = false;
      $('team-monitor').classList.add('hidden');
    });
  }

  function clear() {
    widgetsContainer.innerHTML = '';
    widgetsContainer.classList.add('hidden');
    statusBar.innerHTML = '';
    statusBar.classList.add('hidden');
    activeStatuses = {};
    teamState = {};
    renderTeamGrid();
    renderQueue([], []);
  }

  return { updateStatus, updateWidget, renderQueue, renderStats, showDialog, clear };
}
