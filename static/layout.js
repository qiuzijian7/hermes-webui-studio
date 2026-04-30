/**
 * layout.js — 2026-04 新布局行为：
 *   - 中栏垂直拖动条（画布 / 聊天区）
 *   - 右栏输出区 tab 切换（工作区目录 / 变更 / 浏览器 / 日志）
 *   - 浏览器 tab 简易历史与导航
 *   - 变更 tab（git status + git diff）加载
 *   - 变更 tab 左右分栏：左侧文件列表 + 右侧 Diff/预览切换
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

  // ── 变更 tab：左右分栏 — 文件列表 + Diff/预览 ──────────────────────────
  let _changesCurrentFile = null;
  let _changesViewMode = 'diff';  // 'diff' | 'file'
  let _changesFiles = [];         // 缓存文件列表
  let _aiChanges = {};            // AI 变更数据 {path: {count, pending, changes[]}}
  let _aiTotalPending = 0;        // AI 待确认变更总数
  let _currentAiChangeId = null;  // 当前显示的 AI 变更 ID

  // 文件扩展名分类
  const _CHANGES_IMAGE_EXTS = new Set(['.png','.jpg','.jpeg','.gif','.svg','.webp','.ico','.bmp']);
  const _CHANGES_MD_EXTS = new Set(['.md','.markdown','.mdown']);

  function _changesFileExt(p) {
    const i = p.lastIndexOf('.');
    return i >= 0 ? p.slice(i).toLowerCase() : '';
  }

  function _escHtml(s) {
    return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
  }

  async function loadGitChanges() {
    const listEl = document.getElementById('outChangesList');
    const emptyEl = document.getElementById('outChangesEmpty');
    const branchEl = document.getElementById('outChangesBranch');
    const summaryEl = document.getElementById('outChangesSummary');
    const badgeEl = document.getElementById('outChangesBadge');
    const diffEl = document.getElementById('outChangesDiff');
    const previewEmpty = document.getElementById('changesPreviewEmpty');
    const previewHeader = document.getElementById('changesPreviewHeader');
    const filePreview = document.getElementById('changesFilePreview');
    const aiBadgeEl = document.getElementById('outChangesAiBadge');
    const saveAllBtn = document.getElementById('btnAcceptAllChanges');
    const acceptBtn = document.getElementById('changesAcceptBtn');
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
      // 同时加载 git 变更和 AI 变更
      const [gitData, aiData] = await Promise.all([
        api(`/api/git-changes?session_id=${sid}`),
        api(`/api/ai-changes?session_id=${sid}`).catch(() => null),
      ]);

      // 处理 AI 变更数据
      _aiChanges = {};
      _aiTotalPending = 0;
      if (aiData && aiData.files) {
        for (const f of aiData.files) {
          _aiChanges[f.path] = f;
        }
        _aiTotalPending = aiData.total_pending || 0;
      }

      // 更新 AI badge
      if (aiBadgeEl) {
        if (_aiTotalPending > 0) {
          aiBadgeEl.textContent = `${_aiTotalPending} 待确认`;
          aiBadgeEl.style.display = '';
        } else {
          aiBadgeEl.style.display = 'none';
        }
      }
      if (saveAllBtn) {
        saveAllBtn.style.display = _aiTotalPending > 0 ? '' : 'none';
      }

      const data = gitData;
      if (!data) {
        if (branchEl) branchEl.textContent = '—';
        if (summaryEl) summaryEl.textContent = '';
        if (badgeEl) badgeEl.style.display = 'none';
        listEl.innerHTML = '';
        if (emptyEl) { emptyEl.style.display = ''; listEl.appendChild(emptyEl); emptyEl.querySelector('p').textContent = '加载失败'; }
        if (diffEl) { diffEl.style.display = 'none'; diffEl.innerHTML = ''; }
        if (previewEmpty) previewEmpty.style.display = '';
        if (previewHeader) previewHeader.style.display = 'none';
        if (filePreview) filePreview.style.display = 'none';
        _changesFiles = [];
        return;
      }
      const isGit = !!data.is_git;
      if (isGit) {
        if (branchEl) branchEl.textContent = data.branch || 'HEAD';
      } else {
        if (branchEl) branchEl.textContent = data.recent_hours ? `近 ${data.recent_hours}h` : '本地';
      }
      if (summaryEl) {
        const bits = [];
        if (data.modified)  bits.push(`${data.modified} ${isGit ? '改动' : '文件'}`);
        if (isGit && data.added)     bits.push(`${data.added} 新增`);
        if (isGit && data.deleted)   bits.push(`${data.deleted} 删除`);
        if (isGit && data.untracked) bits.push(`${data.untracked} 未跟踪`);
        summaryEl.textContent = bits.join(' · ');
      }
      const files = data.files || [];
      _changesFiles = files;
      if (badgeEl) {
        if (files.length) { badgeEl.textContent = files.length; badgeEl.style.display = ''; }
        else badgeEl.style.display = 'none';
      }

      // 计算最大改动量（用于统计条宽度）
      let maxChanges = 1;
      for (const f of files) {
        const total = (f.additions || 0) + (f.deletions || 0);
        if (total > maxChanges) maxChanges = total;
      }

      listEl.innerHTML = '';
      if (!files.length) {
        const emptyMsg = isGit ? '没有未提交的变更' : '近期没有文件变更';
        if (emptyEl) { emptyEl.style.display = ''; emptyEl.querySelector('p').textContent = emptyMsg; listEl.appendChild(emptyEl); }
        if (diffEl) { diffEl.style.display = 'none'; diffEl.innerHTML = ''; }
        if (previewEmpty) previewEmpty.style.display = '';
        if (previewHeader) previewHeader.style.display = 'none';
        if (filePreview) filePreview.style.display = 'none';
        _changesCurrentFile = null;
        return;
      }

      for (const f of files) {
        const row = document.createElement('div');
        row.className = 'output-change-item';
        row.dataset.path = f.path;
        row.tabIndex = 0;
        const statusCh = (f.status || '??').trim().charAt(0) || '?';
        const st = document.createElement('span');
        st.className = 'output-change-status ' + statusCh;
        st.dataset.status = f.status || '';
        st.textContent = statusCh;
        const p = document.createElement('span');
        p.className = 'output-change-path';
        p.textContent = f.path;
        p.title = f.path;

        // 增删统计条
        const bar = document.createElement('span');
        bar.className = 'output-change-bar';
        const totalChanges = (f.additions || 0) + (f.deletions || 0);
        if (totalChanges > 0) {
          const addWidth = Math.max(1, Math.round(((f.additions || 0) / maxChanges) * 100));
          const delWidth = Math.max(1, Math.round(((f.deletions || 0) / maxChanges) * 100));
          const barAdd = document.createElement('span');
          barAdd.className = 'output-change-bar-add';
          barAdd.style.width = addWidth + '%';
          const barDel = document.createElement('span');
          barDel.className = 'output-change-bar-del';
          barDel.style.width = delWidth + '%';
          bar.appendChild(barAdd);
          bar.appendChild(barDel);
        }

        const sub = document.createElement('span');
        sub.className = 'output-change-sub';
        if (typeof f.additions === 'number' || typeof f.deletions === 'number') {
          sub.textContent = `+${f.additions||0} -${f.deletions||0}`;
        }

        // AI 修改次数 badge
        const aiInfo = _aiChanges[f.path];
        let aiBadge = null;
        if (aiInfo && aiInfo.pending > 0) {
          aiBadge = document.createElement('span');
          aiBadge.className = 'output-change-ai-count';
          aiBadge.textContent = aiInfo.pending;
          aiBadge.title = `${aiInfo.pending} 次 AI 修改待确认`;
        }

        row.appendChild(st);
        row.appendChild(p);
        if (aiBadge) row.appendChild(aiBadge);
        row.appendChild(bar);
        row.appendChild(sub);
        row.addEventListener('click', () => _selectChangesFile(f.path));
        // 键盘支持
        row.addEventListener('keydown', (e) => {
          if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); _selectChangesFile(f.path); }
        });
        listEl.appendChild(row);
      }

      // 默认展开第一个文件
      if (files[0] && !_changesCurrentFile) {
        _selectChangesFile(files[0].path);
      } else if (_changesCurrentFile) {
        const cur = files.find(f => f.path === _changesCurrentFile);
        if (cur) _selectChangesFile(cur.path);
        else {
          _changesCurrentFile = null;
          if (diffEl) { diffEl.style.display='none'; diffEl.innerHTML=''; }
          if (previewEmpty) previewEmpty.style.display = '';
          if (previewHeader) previewHeader.style.display = 'none';
          if (filePreview) filePreview.style.display = 'none';
        }
      }
    } catch (e) {
      console.warn('[changes] loadGitChanges failed:', e);
      listEl.innerHTML = '';
      if (emptyEl) { emptyEl.style.display = ''; emptyEl.querySelector('p').textContent = '加载失败：' + e.message; listEl.appendChild(emptyEl); }
    }
  }
  window.loadGitChanges = loadGitChanges;

  /** 选中变更文件，更新左侧高亮 + 右侧预览 */
  function _selectChangesFile(path) {
    _changesCurrentFile = path;
    const listEl = document.getElementById('outChangesList');
    const previewHeader = document.getElementById('changesPreviewHeader');
    const previewEmpty = document.getElementById('changesPreviewEmpty');
    const filenameEl = document.getElementById('changesPreviewFilename');
    const filepathEl = document.getElementById('changesPreviewFilepath');
    const openInEditorBtn = document.getElementById('changesOpenInEditor');
    const acceptBtn = document.getElementById('changesAcceptBtn');

    // 高亮当前选中文件
    if (listEl) {
      listEl.querySelectorAll('.output-change-item').forEach(row => {
        row.classList.toggle('active', row.dataset.path === path);
      });
    }

    // 更新预览头部
    if (previewHeader) previewHeader.style.display = '';
    if (previewEmpty) previewEmpty.style.display = 'none';
    const fileName = path.split('/').pop();
    const dirPath = path.substring(0, path.length - fileName.length);
    if (filenameEl) filenameEl.textContent = fileName;
    if (filepathEl) filepathEl.textContent = dirPath;
    if (openInEditorBtn) openInEditorBtn.style.display = '';

    // 显示/隐藏保存按钮
    const aiInfo = _aiChanges[path];
    if (acceptBtn) {
      if (aiInfo && aiInfo.pending > 0) {
        acceptBtn.style.display = '';
        acceptBtn.textContent = '';
        acceptBtn.innerHTML = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg><span>保存</span>';
        acceptBtn.classList.remove('saved');
      } else {
        acceptBtn.style.display = 'none';
      }
    }

    // 根据当前视图模式加载内容
    if (_changesViewMode === 'diff') {
      showGitDiff(path);
    } else {
      _showChangesFilePreview(path);
    }
  }

  /** 切换 Diff / 文件预览模式 */
  function _switchChangesViewMode(mode) {
    _changesViewMode = mode;
    const diffBtn = document.getElementById('changesModeDiff');
    const fileBtn = document.getElementById('changesModeFile');
    const diffEl = document.getElementById('outChangesDiff');
    const filePreview = document.getElementById('changesFilePreview');

    if (diffBtn) diffBtn.classList.toggle('active', mode === 'diff');
    if (fileBtn) fileBtn.classList.toggle('active', mode === 'file');

    if (mode === 'diff') {
      if (diffEl) diffEl.style.display = '';
      if (filePreview) filePreview.style.display = 'none';
      if (_changesCurrentFile) showGitDiff(_changesCurrentFile);
    } else {
      if (diffEl) diffEl.style.display = 'none';
      if (filePreview) filePreview.style.display = '';
      if (_changesCurrentFile) _showChangesFilePreview(_changesCurrentFile);
    }
  }
  window._switchChangesViewMode = _switchChangesViewMode;

  /** 在变更面板右侧显示文件预览 */
  async function _showChangesFilePreview(path) {
    const contentEl = document.getElementById('changesFileContent');
    const diffEl = document.getElementById('outChangesDiff');
    const filePreview = document.getElementById('changesFilePreview');
    if (!contentEl) return;

    if (diffEl) diffEl.style.display = 'none';
    if (filePreview) filePreview.style.display = '';

    const ext = _changesFileExt(path);
    const sid = (S.session && S.session.session_id) ? encodeURIComponent(S.session.session_id) : '';
    const qs = sid ? `session_id=${sid}&path=${encodeURIComponent(path)}` : `path=${encodeURIComponent(path)}`;

    // 图片预览
    if (_CHANGES_IMAGE_EXTS.has(ext)) {
      contentEl.innerHTML = `<div style="display:flex;align-items:center;justify-content:center;padding:20px;min-height:200px"><img src="/api/file/raw?${qs}" alt="${_escHtml(path)}" style="max-width:100%;border-radius:6px" onerror="this.parentElement.innerHTML='<p style=\\'color:var(--muted)\\'>图片加载失败</p>'"></div>`;
      return;
    }

    // Markdown 预览
    if (_CHANGES_MD_EXTS.has(ext)) {
      try {
        const data = await api(`/api/file?${qs}`);
        const mdHtml = typeof renderMd === 'function' ? renderMd(data.content || '') : (data.content || '');
        contentEl.innerHTML = `<div class="md-preview">${mdHtml}</div>`;
      } catch (e) {
        contentEl.innerHTML = `<p style="color:var(--muted);padding:16px">文件加载失败: ${_escHtml(e.message)}</p>`;
      }
      return;
    }

    // 代码/文本预览 - 使用 CM6 或纯文本
    try {
      const data = await api(`/api/file?${qs}`);
      if (data.binary) {
        contentEl.innerHTML = `<p style="color:var(--muted);padding:16px">二进制文件，无法预览</p>`;
        return;
      }
      const lang = typeof _rpFileLang === 'function' ? _rpFileLang(path) : '';
      // 尝试 CM6
      contentEl.innerHTML = '';
      if (typeof window.CM_EDITOR !== 'undefined' && window.CM_EDITOR.create) {
        try {
          window.CM_EDITOR.create(contentEl, data.content || '', lang, false);
          if (!contentEl.querySelector('.cm-editor')) throw new Error('no mount');
          contentEl.classList.add('cm-active');
        } catch (_) {
          contentEl.classList.remove('cm-active');
          contentEl.innerHTML = `<pre>${_escHtml(data.content || '')}</pre>`;
        }
      } else {
        contentEl.innerHTML = `<pre>${_escHtml(data.content || '')}</pre>`;
      }
    } catch (e) {
      contentEl.innerHTML = `<p style="color:var(--muted);padding:16px">文件加载失败: ${_escHtml(e.message)}</p>`;
    }
  }

  /** 在编辑器中打开变更文件（跳转到工作区目录的文件预览） */
  function _openChangesFileInEditor() {
    if (!_changesCurrentFile) return;
    if (typeof openFileInRightPanel === 'function') {
      openFileInRightPanel(_changesCurrentFile);
    }
  }
  window._openChangesFileInEditor = _openChangesFileInEditor;

  async function showGitDiff(path) {
    _changesCurrentFile = path;
    const diffEl = document.getElementById('outChangesDiff');
    const filePreview = document.getElementById('changesFilePreview');
    const listEl = document.getElementById('outChangesList');
    const previewHeader = document.getElementById('changesPreviewHeader');
    const previewEmpty = document.getElementById('changesPreviewEmpty');
    const filenameEl = document.getElementById('changesPreviewFilename');
    const filepathEl = document.getElementById('changesPreviewFilepath');
    const openInEditorBtn = document.getElementById('changesOpenInEditor');
    const acceptBtn = document.getElementById('changesAcceptBtn');
    if (!diffEl) return;

    // 确保 diff 视图可见
    if (filePreview) filePreview.style.display = 'none';
    diffEl.style.display = '';

    if (listEl) {
      listEl.querySelectorAll('.output-change-item').forEach(row => {
        row.classList.toggle('active', row.dataset.path === path);
      });
    }
    if (previewHeader) previewHeader.style.display = '';
    if (previewEmpty) previewEmpty.style.display = 'none';

    // 更新文件名
    const fileName = path.split('/').pop();
    const dirPath = path.substring(0, path.length - fileName.length);
    if (filenameEl) filenameEl.textContent = fileName;
    if (filepathEl) filepathEl.textContent = dirPath;
    if (openInEditorBtn) openInEditorBtn.style.display = '';

    // 显示/隐藏保存按钮
    const aiInfo = _aiChanges[path];
    if (acceptBtn) {
      if (aiInfo && aiInfo.pending > 0) {
        acceptBtn.style.display = '';
        acceptBtn.innerHTML = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg><span>保存</span>';
        acceptBtn.classList.remove('saved');
      } else {
        acceptBtn.style.display = 'none';
      }
    }

    diffEl.textContent = '加载中...';
    try {
      const sid = encodeURIComponent(S.session.session_id);
      const p = encodeURIComponent(path);
      // 如果有 AI 变更，优先显示 AI 变更的 diff
      if (aiInfo && aiInfo.pending > 0 && aiInfo.changes && aiInfo.changes.length > 0) {
        // 获取最新的 AI 变更 diff
        const latestChange = aiInfo.changes[aiInfo.changes.length - 1];
        if (latestChange.id) {
          const detail = await api(`/api/ai-changes/detail?session_id=${sid}&change_id=${latestChange.id}`);
          if (detail && detail.diff) {
            diffEl.innerHTML = _colorizeDiff(detail.diff);
            _currentAiChangeId = latestChange.id;
            _initSideBySideScroll();
            return;
          }
        }
      }
      // 否则显示 git diff
      const data = await api(`/api/git-diff?session_id=${sid}&path=${p}`);
      const diffText = (data && data.diff) || '';
      if (!diffText.trim()) {
        diffEl.textContent = '（无差异 — 可能是二进制文件或未跟踪文件）';
        return;
      }
      diffEl.innerHTML = _colorizeDiff(diffText);
      _initSideBySideScroll();
    } catch (e) {
      diffEl.textContent = '加载 diff 失败：' + e.message;
    }
  }
  window.showGitDiff = showGitDiff;

  /**
   * 将 unified diff 解析为左右分栏 HTML 视图（参考 VS Code / Git 工具风格）
   * 截图样式：左侧旧版红色背景，右侧新版绿色背景，带行号和统计信息
   */
  function _colorizeDiff(text) {
    const lines = text.split('\n');
    const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

    // 统计数据
    let additions = 0, deletions = 0, modifications = 0;
    const hunkStats = []; // [{oldStart, oldCount, newStart, newCount}]
    let currentHunk = null;

    // 第一遍扫描：收集 hunk 信息用于统计
    for (const line of lines) {
      const m = line.match(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/);
      if (m) {
        currentHunk = {
          oldStart: parseInt(m[1]),
          oldCount: parseInt(m[2] || 1),
          newStart: parseInt(m[3]),
          newCount: parseInt(m[4] || 1),
        };
        hunkStats.push(currentHunk);
      }
      if (line.startsWith('+') && !line.startsWith('+++')) additions++;
      else if (line.startsWith('-') && !line.startsWith('---')) deletions++;
    }

    // 统计"修改"（删除后紧跟添加算作一次修改）
    let pendingDels = [];
    for (const line of lines) {
      if (line.startsWith('-') && !line.startsWith('---')) pendingDels.push(line);
      else if (line.startsWith('+') && !line.startsWith('+++')) {
        if (pendingDels.length > 0) { modifications++; pendingDels = []; }
        else pendingDels = [];
      }
      else pendingDels = [];
    }

    // 解析 unified diff，分割为 left/right 列
    let oldLineNum = 0, newLineNum = 0;
    let inHunk = false;
    let hunkHeader = '';

    // 统计栏 HTML
    const statsBar = `
      <div class="ssdiff-stats">
        <span class="ssdiff-stat ssdiff-add">+${additions}</span>
        <span class="ssdiff-stat ssdiff-del">-${deletions}</span>
        ${modifications > 0 ? `<span class="ssdiff-stat ssdiff-mod">~${modifications}</span>` : ''}
      </div>`;

    let leftHtml = '', rightHtml = '';
    let leftContent = '', rightContent = '';
    let hunkStart = false;

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];

      // 解析 hunk 头
      const hm = line.match(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/);
      if (hm) {
        // 关闭上一个 hunk
        if (leftContent || rightContent) {
          leftHtml += leftContent;
          rightHtml += rightContent;
        }
        oldLineNum = parseInt(hm[1]);
        newLineNum = parseInt(hm[3]);
        const oldCount = parseInt(hm[2] || 1);
        const newCount = parseInt(hm[4] || 1);
        hunkHeader = `@@ -${hm[1]}${oldCount > 1 ? ',' + oldCount : ''} +${hm[3]}${newCount > 1 ? ',' + newCount : ''} @@`;
        leftContent = `<div class="ssdiff-hdr">${esc(hunkHeader)}</div>`;
        rightContent = `<div class="ssdiff-hdr">${esc(hunkHeader)}</div>`;
        hunkStart = true;
        continue;
      }

      if (line.startsWith('diff --git') || line.startsWith('index ') || line.startsWith('--- ') || line.startsWith('+++ ')) {
        // 文件头，提取文件名
        const fm = line.match(/^[a-z]+ --git a\/(.+?) b\//);
        if (fm) {
          hunkHeader = `b/${fm[1]}`;
          leftContent = `<div class="ssdiff-hdr">${esc(hunkHeader)}</div>`;
          rightContent = `<div class="ssdiff-hdr">${esc(hunkHeader)}</div>`;
        }
        continue;
      }

      if (line.startsWith('-') && !line.startsWith('---')) {
        // 删除行 → 左侧红色，右侧留空
        leftContent += `<div class="ssdiff-line ssdiff-del"><span class="ssdiff-num">${oldLineNum}</span><span class="ssdiff-code">${esc(line.substring(1))}</span></div>`;
        rightContent += `<div class="ssdiff-line ssdiff-empty"><span class="ssdiff-num"></span><span class="ssdiff-code"></span></div>`;
        oldLineNum++;
        hunkStart = false;
        continue;
      }

      if (line.startsWith('+') && !line.startsWith('+++')) {
        // 添加行 → 左侧留空，右侧绿色
        leftContent += `<div class="ssdiff-line ssdiff-add-blank"><span class="ssdiff-num"></span><span class="ssdiff-code"></span></div>`;
        rightContent += `<div class="ssdiff-line ssdiff-add"><span class="ssdiff-num">${newLineNum}</span><span class="ssdiff-code">${esc(line.substring(1))}</span></div>`;
        newLineNum++;
        hunkStart = false;
        continue;
      }

      // 上下文行
      const displayLine = line.startsWith(' ') ? line.substring(1) : line;
      if (!line.startsWith('+') && !line.startsWith('-')) {
        leftContent += `<div class="ssdiff-line"><span class="ssdiff-num">${oldLineNum > 0 && !hunkStart ? oldLineNum : ''}</span><span class="ssdiff-code">${esc(displayLine)}</span></div>`;
        rightContent += `<div class="ssdiff-line"><span class="ssdiff-num">${newLineNum > 0 && !hunkStart ? newLineNum : ''}</span><span class="ssdiff-code">${esc(displayLine)}</span></div>`;
        if (!hunkStart) {
          oldLineNum++;
          newLineNum++;
        }
        continue;
      }
    }

    if (leftContent || rightContent) {
      leftHtml += leftContent;
      rightHtml += rightContent;
    }

    if (!leftHtml && !rightHtml) {
      return '<div class="ssdiff-empty-msg">（无差异 — 可能是二进制文件或未跟踪文件）</div>';
    }

    return `
    <div class="ssdiff-wrap">
      ${statsBar}
      <div class="ssdiff-container">
        <div class="ssdiff-pane ssdiff-left" id="ssdiffLeft">${leftHtml}</div>
        <div class="ssdiff-pane ssdiff-right" id="ssdiffRight">${rightHtml}</div>
      </div>
    </div>`;
  }

  // 左右分栏同步滚动
  function _initSideBySideScroll() {
    const left = document.getElementById('ssdiffLeft');
    const right = document.getElementById('ssdiffRight');
    if (!left || !right) return;
    let syncing = false;
    left.addEventListener('scroll', () => {
      if (syncing) return;
      syncing = true;
      right.scrollTop = left.scrollTop;
      syncing = false;
    });
    right.addEventListener('scroll', () => {
      if (syncing) return;
      syncing = true;
      left.scrollTop = right.scrollTop;
      syncing = false;
    });
  }

  // ── AI 变更追踪：接受/保存功能 ───────────────────────────────────────────

  /** 接受当前选中文件的所有 AI 变更 */
  async function _acceptFileChanges() {
    if (!_changesCurrentFile || !_aiChanges[_changesCurrentFile]) return;
    const path = _changesCurrentFile;
    try {
      const sid = S.session.session_id;
      const res = await api('/api/ai-changes/accept-file', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ session_id: sid, path: path })
      });
      if (res && res.success) {
        // 更新本地状态
        const aiInfo = _aiChanges[path];
        if (aiInfo) {
          aiInfo.pending = 0;
          aiInfo.accepted = aiInfo.count;
          for (const c of aiInfo.changes) {
            c.accepted = true;
          }
        }
        _aiTotalPending = Math.max(0, _aiTotalPending - (res.count || 0));
        // 更新 UI
        const acceptBtn = document.getElementById('changesAcceptBtn');
        if (acceptBtn) {
          acceptBtn.innerHTML = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg><span>已保存</span>';
          acceptBtn.classList.add('saved');
        }
        const aiBadgeEl = document.getElementById('outChangesAiBadge');
        if (aiBadgeEl) {
          if (_aiTotalPending > 0) {
            aiBadgeEl.textContent = `${_aiTotalPending} 待确认`;
          } else {
            aiBadgeEl.style.display = 'none';
          }
        }
        const saveAllBtn = document.getElementById('btnAcceptAllChanges');
        if (saveAllBtn) {
          saveAllBtn.style.display = _aiTotalPending > 0 ? '' : 'none';
        }
        // 刷新文件列表中的 badge
        loadGitChanges();
      }
    } catch (e) {
      console.warn('[changes] accept file failed:', e);
    }
  }
  window._acceptFileChanges = _acceptFileChanges;

  /** 接受所有 AI 变更 */
  async function _acceptAllAiChanges() {
    try {
      const sid = S.session.session_id;
      const res = await api('/api/ai-changes/accept-all', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ session_id: sid })
      });
      if (res && res.success) {
        // 更新本地状态
        for (const path in _aiChanges) {
          const info = _aiChanges[path];
          info.pending = 0;
          info.accepted = info.count;
          for (const c of info.changes) {
            c.accepted = true;
          }
        }
        _aiTotalPending = 0;
        // 更新 UI
        const aiBadgeEl = document.getElementById('outChangesAiBadge');
        if (aiBadgeEl) aiBadgeEl.style.display = 'none';
        const saveAllBtn = document.getElementById('btnAcceptAllChanges');
        if (saveAllBtn) saveAllBtn.style.display = 'none';
        const acceptBtn = document.getElementById('changesAcceptBtn');
        if (acceptBtn) acceptBtn.style.display = 'none';
        // 刷新
        loadGitChanges();
      }
    } catch (e) {
      console.warn('[changes] accept all failed:', e);
    }
  }
  window._acceptAllAiChanges = _acceptAllAiChanges;

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

  // initFilePreviewToggle removed: split-view layout handles file preview visibility differently

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
    // initFilePreviewToggle removed: split-view layout handles file preview visibility differently
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
