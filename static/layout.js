/**
 * layout.js — 2026-04 新布局行为：
 *   - 中栏垂直拖动条（画布 / 聊天区）
 *   - 右栏输出区 tab 切换（全部文件 / 变更 / 浏览器 / 日志）
 *   - 浏览器 tab 简易历史与导航
 *   - 变更 tab（git status + git diff）加载
 *
 * 依赖：boot.js 的 $() 辅助、workspace.js 的 api()、S 全局状态。
 */

(function(){
  'use strict';

  // ── Dockable Panel 系统（替代旧 vsplit） ─────────────────────────────────
  let _dock = null;

  function initDock() {
    const root = document.getElementById('dockRoot');
    if (!root || typeof DockManager !== 'function') return;

    // 从 HTML 原位置取出 host 元素（作为 panel contentEl）
    const canvasHost = document.getElementById('dockPanel_canvas');
    const chatHost = document.getElementById('dockPanel_chat');
    if (!canvasHost || !chatHost) return;

    // 注册 panel
    if (typeof dockRegisterPanel === 'function') {
      dockRegisterPanel({
        id: 'canvas',
        title: canvasHost.dataset.dockTitle || '工作画布',
        contentEl: canvasHost,
        icon: '<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/><rect x="3" y="14" width="7" height="7"/><rect x="14" y="14" width="7" height="7"/></svg>',
      });
      dockRegisterPanel({
        id: 'chat',
        title: chatHost.dataset.dockTitle || '聊天',
        contentEl: chatHost,
        icon: '<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>',
      });
    }

    _dock = new DockManager(root);
    const panelIds = ['canvas', 'chat'];
    if (!_dock.loadSavedLayout(panelIds)) {
      _dock.useDefaultLayout(panelIds);
    }
    // 强制设为 column（初次默认），之后由用户操作保存
    _dock.render();
    window._dock = _dock;
  }

  window.resetDockLayout = function() {
    if (_dock) _dock.resetLayout();
  };

  /**
   * 全局便捷函数：激活某个 dock panel（如 'chat' / 'canvas'）。
   * 点击员工卡片、打开总群等入口都应调用 `dockFocusPanel('chat')`，
   * 保证该面板当前是 active tab（否则若用户把画布和聊天合并到同一 leaf，
   * 聊天 panel 可能被 detach 在内存里不可见）。
   */
  window.dockFocusPanel = function(panelId) {
    if (!_dock || typeof _dock.focusPanel !== 'function') return false;
    try { return _dock.focusPanel(panelId); } catch (e) { return false; }
  };

  // ── 左/右栏折叠切换 ──────────────────────────────────────────────────────
  const COLLAPSE_LS = {
    sidebar:    'hermes-sidebar-collapsed',
    rightpanel: 'hermes-rightpanel-collapsed',
  };

  function togglePanel(which, force) {
    const layout = document.querySelector('.layout');
    if (!layout) return;
    const cls = which === 'sidebar' ? 'sidebar-collapsed' : 'rightpanel-collapsed';
    const isCollapsed = layout.classList.contains(cls);
    const next = (typeof force === 'boolean') ? force : !isCollapsed;
    layout.classList.toggle(cls, next);
    try { localStorage.setItem(COLLAPSE_LS[which], next ? '1' : '0'); } catch (e) {}
    // 同步按钮 active 状态
    const btnId = which === 'sidebar' ? 'btnToggleSidebar' : 'btnToggleRightPanel';
    const btn = document.getElementById(btnId);
    if (btn) btn.classList.toggle('active', next);
    // 通知：折叠状态变化可能需要重绘画布等
    if (typeof renderConnections === 'function') {
      try { setTimeout(renderConnections, 240); } catch (e) {}
    }
  }
  window.togglePanel = togglePanel;

  function initPanelCollapse() {
    // 恢复上次折叠状态
    for (const which of ['sidebar', 'rightpanel']) {
      try {
        const saved = localStorage.getItem(COLLAPSE_LS[which]);
        if (saved === '1') togglePanel(which, true);
      } catch (e) {}
    }
    // 快捷键：Ctrl+B 切换左栏，Ctrl+Shift+B 切换右栏
    document.addEventListener('keydown', (e) => {
      if (!(e.ctrlKey || e.metaKey)) return;
      if (e.key && e.key.toLowerCase() === 'b') {
        // 避免在 textarea / input 内误触
        const t = e.target;
        const tag = t && t.tagName;
        if (tag === 'TEXTAREA' || tag === 'INPUT' || (t && t.isContentEditable)) return;
        e.preventDefault();
        togglePanel(e.shiftKey ? 'rightpanel' : 'sidebar');
      }
    });
  }

  // ── 右栏输出区 tab 切换 ───────────────────────────────────────────────────
  const OUT_TAB_KEY = 'hermes-output-tab';

  function switchOutputTab(tab) {
    const tabs = ['files', 'changes', 'browser', 'logs', 'agents', 'detail'];
    if (!tabs.includes(tab)) tab = 'files';
    localStorage.setItem(OUT_TAB_KEY, tab);

    // 按钮状态
    document.querySelectorAll('.output-tab').forEach(btn => {
      btn.classList.toggle('active', btn.dataset.outTab === tab);
    });

    // 面板显示
    const panelMap = {
      files:    'outputPanelFiles',
      changes:  'outputPanelChanges',
      browser:  'outputPanelBrowser',
      logs:     'outputPanelLogs',
      agents:   'outputPanelAgents',
      detail:   'outputPanelDetail',
    };
    Object.entries(panelMap).forEach(([k, id]) => {
      const el = document.getElementById(id);
      if (!el) return;
      const on = (k === tab);
      el.classList.toggle('active', on);
      el.style.display = on ? 'flex' : 'none';
    });

    // 切到 changes 时自动加载 git diff
    if (tab === 'changes') {
      loadGitChanges();
    }
    // 切到 logs 时重连 SSE + 重渲染
    if (tab === 'logs') {
      if (typeof connectLogsSSE === 'function') connectLogsSSE();
      if (typeof _reRenderLogs === 'function') _reRenderLogs();
    }
    // 切到 files 时：重新渲染文件树（若已有缓存）
    if (tab === 'files') {
      if (typeof _renderMainBreadcrumb === 'function') {
        try { _renderMainBreadcrumb(); } catch (e) {}
      }
      if (typeof _renderMainFileTree === 'function') {
        try { _renderMainFileTree(); } catch (e) {}
      }
      const tree = document.getElementById('mainFileTree');
      if (tree && !tree.children.length && typeof loadDir === 'function') {
        try { loadDir(S.currentDir || '.'); } catch (e) {}
      }
    }
    // 切到 agents：启动轮询；切走则停
    if (tab === 'agents') {
      if (typeof activateAgentsPolling === 'function') activateAgentsPolling();
    } else {
      if (typeof deactivateAgentsPolling === 'function') deactivateAgentsPolling();
    }
  }
  window.switchOutputTab = switchOutputTab;

  // ── 变更 tab：加载 git status + diff ──────────────────────────────────────
  let _changesCurrentFile = null;

  async function loadGitChanges() {
    const listEl = document.getElementById('outChangesList');
    const emptyEl = document.getElementById('outChangesEmpty');
    const branchEl = document.getElementById('outChangesBranch');
    const summaryEl = document.getElementById('outChangesSummary');
    const badgeEl = document.getElementById('outChangesBadge');
    const diffEl = document.getElementById('outChangesDiff');
    if (!listEl) return;

    if (!S.session || !S.session.session_id) {
      if (branchEl) branchEl.textContent = '—';
      if (summaryEl) summaryEl.textContent = '';
      listEl.innerHTML = '';
      if (emptyEl) { emptyEl.style.display = ''; listEl.appendChild(emptyEl); emptyEl.querySelector('p').textContent = '请先选择会话'; }
      return;
    }

    try {
      const sid = encodeURIComponent(S.session.session_id);
      const data = await api(`/api/git-changes?session_id=${sid}`);
      if (!data || !data.is_git) {
        if (branchEl) branchEl.textContent = '非 git 仓库';
        if (summaryEl) summaryEl.textContent = '';
        if (badgeEl) badgeEl.style.display = 'none';
        listEl.innerHTML = '';
        if (emptyEl) { emptyEl.style.display = ''; listEl.appendChild(emptyEl); emptyEl.querySelector('p').textContent = '当前工作区不是 git 仓库'; }
        if (diffEl) { diffEl.style.display = 'none'; diffEl.innerHTML = ''; }
        return;
      }
      if (branchEl) branchEl.textContent = data.branch || 'HEAD';
      if (summaryEl) {
        const bits = [];
        if (data.modified)  bits.push(`${data.modified} 改动`);
        if (data.added)     bits.push(`${data.added} 新增`);
        if (data.deleted)   bits.push(`${data.deleted} 删除`);
        if (data.untracked) bits.push(`${data.untracked} 未跟踪`);
        summaryEl.textContent = bits.join(' · ');
      }
      const files = data.files || [];
      if (badgeEl) {
        if (files.length) { badgeEl.textContent = files.length; badgeEl.style.display = ''; }
        else badgeEl.style.display = 'none';
      }

      listEl.innerHTML = '';
      if (!files.length) {
        if (emptyEl) { emptyEl.style.display = ''; emptyEl.querySelector('p').textContent = '没有未提交的变更'; listEl.appendChild(emptyEl); }
        if (diffEl) { diffEl.style.display = 'none'; diffEl.innerHTML = ''; }
        _changesCurrentFile = null;
        return;
      }

      for (const f of files) {
        const row = document.createElement('div');
        row.className = 'output-change-item';
        row.dataset.path = f.path;
        const statusCh = (f.status || '??').trim().charAt(0) || '?';
        const st = document.createElement('span');
        st.className = 'output-change-status ' + statusCh;
        st.dataset.status = f.status || '';
        st.textContent = statusCh;
        const p = document.createElement('span');
        p.className = 'output-change-path';
        p.textContent = f.path;
        p.title = f.path;
        const sub = document.createElement('span');
        sub.className = 'output-change-sub';
        if (typeof f.additions === 'number' || typeof f.deletions === 'number') {
          sub.textContent = `+${f.additions||0} -${f.deletions||0}`;
        }
        row.appendChild(st);
        row.appendChild(p);
        row.appendChild(sub);
        row.addEventListener('click', () => showGitDiff(f.path));
        listEl.appendChild(row);
      }

      // 默认展开第一个文件的 diff
      if (files[0] && !_changesCurrentFile) {
        showGitDiff(files[0].path);
      } else if (_changesCurrentFile) {
        const cur = files.find(f => f.path === _changesCurrentFile);
        if (cur) showGitDiff(cur.path);
        else { _changesCurrentFile = null; if (diffEl) { diffEl.style.display='none'; diffEl.innerHTML=''; } }
      }
    } catch (e) {
      console.warn('[changes] loadGitChanges failed:', e);
      listEl.innerHTML = '';
      if (emptyEl) { emptyEl.style.display = ''; emptyEl.querySelector('p').textContent = '加载失败：' + e.message; listEl.appendChild(emptyEl); }
    }
  }
  window.loadGitChanges = loadGitChanges;

  async function showGitDiff(path) {
    _changesCurrentFile = path;
    const diffEl = document.getElementById('outChangesDiff');
    const listEl = document.getElementById('outChangesList');
    if (!diffEl) return;
    if (listEl) {
      listEl.querySelectorAll('.output-change-item').forEach(row => {
        row.classList.toggle('active', row.dataset.path === path);
      });
    }
    diffEl.style.display = 'block';
    diffEl.textContent = '加载中...';
    try {
      const sid = encodeURIComponent(S.session.session_id);
      const p = encodeURIComponent(path);
      const data = await api(`/api/git-diff?session_id=${sid}&path=${p}`);
      const diffText = (data && data.diff) || '';
      if (!diffText.trim()) {
        diffEl.textContent = '（无差异 — 可能是二进制文件或未跟踪文件）';
        return;
      }
      diffEl.innerHTML = _colorizeDiff(diffText);
    } catch (e) {
      diffEl.textContent = '加载 diff 失败：' + e.message;
    }
  }
  window.showGitDiff = showGitDiff;

  function _colorizeDiff(text) {
    const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    return text.split('\n').map(line => {
      if (line.startsWith('diff --git') || line.startsWith('+++ ') || line.startsWith('--- ')) {
        return `<span class="diff-file">${esc(line)}</span>`;
      }
      if (line.startsWith('@@')) {
        return `<span class="diff-hunk">${esc(line)}</span>`;
      }
      if (line.startsWith('+') && !line.startsWith('+++')) {
        return `<span class="diff-add">${esc(line)}</span>`;
      }
      if (line.startsWith('-') && !line.startsWith('---')) {
        return `<span class="diff-del">${esc(line)}</span>`;
      }
      return esc(line);
    }).join('\n');
  }

  // ── 浏览器 tab ────────────────────────────────────────────────────────────
  const BROWSER_URL_KEY = 'hermes-browser-url';
  const _browserHistory = { stack: [], index: -1 };

  function _normalizeUrl(raw) {
    raw = (raw || '').trim();
    if (!raw) return '';
    if (/^https?:\/\//i.test(raw)) return raw;
    if (/^(about|data|blob):/i.test(raw)) return raw;
    // 本地端口简写：localhost:3000 → http://localhost:3000
    if (/^[\w.-]+:\d+/.test(raw)) return 'http://' + raw;
    // 域名简写：example.com → https://example.com
    if (/^[\w.-]+\.\w+/.test(raw) && !/\s/.test(raw)) return 'https://' + raw;
    return raw;
  }

  function _setBrowserUrl(url) {
    const input = document.getElementById('outBrowserUrl');
    const frame = document.getElementById('outBrowserFrame');
    const empty = document.getElementById('outBrowserEmpty');
    if (!frame) return;
    if (!url) {
      frame.src = 'about:blank';
      frame.classList.remove('loaded');
      if (empty) empty.classList.remove('hidden');
      return;
    }
    if (input) input.value = url;
    frame.src = url;
    frame.classList.add('loaded');
    if (empty) empty.classList.add('hidden');
    localStorage.setItem(BROWSER_URL_KEY, url);
  }

  function browserNavigate() {
    const input = document.getElementById('outBrowserUrl');
    if (!input) return;
    const url = _normalizeUrl(input.value);
    if (!url) return;
    // 压入历史
    if (_browserHistory.index < _browserHistory.stack.length - 1) {
      _browserHistory.stack = _browserHistory.stack.slice(0, _browserHistory.index + 1);
    }
    _browserHistory.stack.push(url);
    _browserHistory.index = _browserHistory.stack.length - 1;
    _setBrowserUrl(url);
  }
  window.browserNavigate = browserNavigate;

  function browserGoBack() {
    if (_browserHistory.index <= 0) return;
    _browserHistory.index -= 1;
    _setBrowserUrl(_browserHistory.stack[_browserHistory.index]);
  }
  window.browserGoBack = browserGoBack;

  function browserReload() {
    const frame = document.getElementById('outBrowserFrame');
    if (!frame) return;
    try {
      // 跨域 iframe 可能会抛 SecurityError
      frame.contentWindow.location.reload();
    } catch (e) {
      const cur = _browserHistory.stack[_browserHistory.index];
      if (cur) _setBrowserUrl(cur);
    }
  }
  window.browserReload = browserReload;

  function browserOpenExternal() {
    // ★ 优先检查 iframe 是否为 srcdoc 内容（如 configHtml）
    const frame = document.getElementById('outBrowserFrame');
    if (frame && frame.srcdoc) {
      const w = window.open('', '_blank');
      if (w) {
        w.document.open();
        w.document.write(frame.srcdoc);
        w.document.close();
      }
      return;
    }
    const input = document.getElementById('outBrowserUrl');
    if (!input) return;
    const url = _normalizeUrl(input.value);
    if (!url) return;
    window.open(url, '_blank', 'noopener');
  }
  window.browserOpenExternal = browserOpenExternal;

  function initBrowser() {
    const last = localStorage.getItem(BROWSER_URL_KEY) || '';
    const input = document.getElementById('outBrowserUrl');
    if (input && last) input.value = last;
  }

  // ── 文件预览显隐：open/close 时切换 outputFilesView 显隐 ─────────────────
  //     （保持 right-panel.js 原有的 _setRightPanelView/openFileInRightPanel 行为。
  //      这里通过 MutationObserver 监听 rpFileView 的 display 变化，
  //      在文件预览打开时隐藏文件树，关闭时恢复。）
  function initFilePreviewToggle() {
    const fv = document.getElementById('rpFileView');
    const tree = document.getElementById('outputFilesView');
    if (!fv || !tree) return;
    const sync = () => {
      const shown = fv.style.display && fv.style.display !== 'none';
      if (shown) {
        tree.style.display = 'none';
        fv.style.display = 'flex';
        // 切换到 files tab（如果不在）
        const filesBtn = document.querySelector('.output-tab[data-out-tab="files"]');
        if (filesBtn && !filesBtn.classList.contains('active')) {
          switchOutputTab('files');
        }
      } else {
        tree.style.display = '';
      }
    };
    const mo = new MutationObserver(sync);
    mo.observe(fv, { attributes: true, attributeFilter: ['style'] });
    sync();
  }

  // ── 覆写 switchWorkspaceTab：新布局下画布常驻，文件/日志路由到右栏 ──────
  //     （保持兼容：agent-presets.js/employee.js/workspace-tabs.js 仍在调用）
  function installSwitchWorkspaceTabShim() {
    const orig = window.switchWorkspaceTab;
    window.switchWorkspaceTab = function(tab) {
      // 画布常驻；文件/日志路由到右栏输出区
      if (tab === 'files') { switchOutputTab('files'); return; }
      if (tab === 'logs')  { switchOutputTab('logs'); return; }
      // canvas：画布常驻，无需切换；仅为保留兼容，尝试原函数（用于 emp-toolbar 显隐等副作用）
      if (typeof orig === 'function') {
        try { orig('canvas'); } catch (e) {}
      }
    };
  }

  // ── DOM ready ────────────────────────────────────────────────────────────
  function init() {
    initDock();
    initBrowser();
    initFilePreviewToggle();
    installSwitchWorkspaceTabShim();
    initPanelCollapse();

    // 恢复上次的 output tab
    const savedTab = localStorage.getItem(OUT_TAB_KEY) || 'files';
    switchOutputTab(savedTab);
  }

  // Dock 布局变化后：重绘画布连线 + 刷新可能的下游尺寸计算
  window.addEventListener('dock:rendered', () => {
    if (typeof renderConnections === 'function') {
      try { renderConnections(); } catch (e) {}
    }
    // 通知员工卡片刷新位置（若缩放层需要）
    if (typeof _syncCanvasTransform === 'function') {
      try { _syncCanvasTransform(); } catch (e) {}
    }
  });

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    // boot.js 在末尾加载，可能已 DOMContentLoaded
    init();
  }

  // 当 session 切换后，若变更 tab 激活则自动刷新
  window.addEventListener('hermes:session-changed', () => {
    const active = document.querySelector('.output-tab.active');
    if (active && active.dataset.outTab === 'changes') loadGitChanges();
  });
})();
