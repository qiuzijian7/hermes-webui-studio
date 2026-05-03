/**
 * workspace-tabs.js — 中间工作区页签切换、画布自由拖动、文件目录、画布缩放
 */

// ── 页签切换 ─────────────────────────────────────────────────────────────────
let _activeWorkspaceTab = 'canvas';

function _ensureFileToolbarInline() {
  const filesContent = $('filesContent');
  if (!filesContent) return;

  let toolbar = $('fileDirToolbar');
  if (!toolbar) {
    toolbar = document.createElement('div');
    toolbar.className = 'file-dir-toolbar';
    toolbar.id = 'fileDirToolbar';

    const breadcrumb = document.createElement('div');
    breadcrumb.className = 'breadcrumb-bar';
    breadcrumb.id = 'mainBreadcrumb';
    toolbar.appendChild(breadcrumb);

    const mainFileTree = $('mainFileTree');
    if (mainFileTree) {
      filesContent.insertBefore(toolbar, mainFileTree);
    } else {
      filesContent.appendChild(toolbar);
    }
  }

  // 确保页签栏中的刷新按钮有事件绑定
  const refreshBtn = $('btnRefreshDir');
  if (refreshBtn && !refreshBtn._boundRefresh) {
    refreshBtn._boundRefresh = true;
    refreshBtn.onclick = () => { if (typeof loadDir === 'function') loadDir(S.currentDir || '.'); };
  }
}



// ── 无限画布 — 缩放 + 平移 ──────────────────────────────────────────────────
// 通过 transform: translate(panX, panY) scale(zoom) 实现，不依赖浏览器 scrollbar。
// panX/panY 是 **视口像素** 级别的偏移量（layer 左上角相对于 canvas 左上角的像素偏移）。
let _canvasZoomLevel = 1;
let _canvasPanX = 0;   // layer 左上角在视口中的 X 偏移（像素）
let _canvasPanY = 0;   // layer 左上角在视口中的 Y 偏移（像素）
const _ZOOM_STEPS = [0.25, 0.33, 0.5, 0.67, 0.75, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2, 2.5, 3];
const _ZOOM_MIN = 0.25;
const _ZOOM_MAX = 3;

/** 获取当前画布工作区路径（与 employee.js 共用） */
function _currentWsKey() {
  return (typeof _currentCanvasWorkspace !== 'undefined' ? _currentCanvasWorkspace : '') || '__default__';
}

/** 保存当前画布视觉状态到 localStorage（按工作区） */
function _saveCanvasState() {
  const key = 'hermes-canvas-state:' + _currentWsKey();
  try {
    localStorage.setItem(key, JSON.stringify({
      zoom: _canvasZoomLevel,
      panX: _canvasPanX,
      panY: _canvasPanY
    }));
  } catch(e) {}
}

/** 加载指定工作区的画布视觉状态 */
function _loadCanvasState() {
  const key = 'hermes-canvas-state:' + _currentWsKey();
  try {
    let raw = localStorage.getItem(key);
    // 旧版全局数据迁移
    if (!raw) {
      const oldZoom = localStorage.getItem('hermes-canvas-zoom');
      const oldPanX = localStorage.getItem('hermes-canvas-panX');
      const oldPanY = localStorage.getItem('hermes-canvas-panY');
      if (oldZoom || oldPanX || oldPanY) {
        const migrated = {
          zoom: parseFloat(oldZoom) || 1,
          panX: parseFloat(oldPanX) || 0,
          panY: parseFloat(oldPanY) || 0
        };
        localStorage.setItem(key, JSON.stringify(migrated));
        localStorage.removeItem('hermes-canvas-zoom');
        localStorage.removeItem('hermes-canvas-panX');
        localStorage.removeItem('hermes-canvas-panY');
        raw = localStorage.getItem(key);
      }
    }
    if (raw) {
      const st = JSON.parse(raw);
      _canvasZoomLevel = st.zoom || 1;
      _canvasPanX = st.panX || 0;
      _canvasPanY = st.panY || 0;
    } else {
      _canvasZoomLevel = 1;
      _canvasPanX = 0;
      _canvasPanY = 0;
    }
  } catch(e) {
    _canvasZoomLevel = 1;
    _canvasPanX = 0;
    _canvasPanY = 0;
  }
  _applyCanvasTransform();
}

/** 应用当前 pan + zoom 到 canvasZoomLayer 的 transform */
function _applyCanvasTransform() {
  const layer = $('canvasZoomLayer');
  if (layer) {
    // translate 在 scale 之前，所以 translate 是像素级别
    layer.style.transform = `translate(${_canvasPanX}px, ${_canvasPanY}px) scale(${_canvasZoomLevel})`;
    layer.style.transformOrigin = '0 0';
  }
  // 背景网格跟随 pan/zoom
  const canvas = $('employeeCanvas');
  if (canvas) {
    const gridBase = 24;
    const gridSize = gridBase * _canvasZoomLevel;
    canvas.style.backgroundSize = `${gridSize}px ${gridSize}px`;
    canvas.style.backgroundPosition = `${_canvasPanX}px ${_canvasPanY}px`;
  }
  const label = $('canvasZoomLabel');
  if (label) label.textContent = Math.round(_canvasZoomLevel * 100) + '%';
  // 持久化（按工作区）
  _saveCanvasState();
}

/** 以某一视口像素点 (pivotX, pivotY) 为中心，从 oldZoom 缩放到 newZoom */
function _zoomAroundPoint(pivotX, pivotY, oldZoom, newZoom) {
  // pivotX/pivotY: 鼠标（或视口中心）相对于 canvas 容器左上角的像素坐标
  // 该点对应的逻辑坐标 = (pivotX - panX) / oldZoom
  // 缩放后要让同一逻辑点仍在 (pivotX, pivotY)：
  //   pivotX = panX_new + logicalX * newZoom
  //   => panX_new = pivotX - logicalX * newZoom
  const logicalX = (pivotX - _canvasPanX) / oldZoom;
  const logicalY = (pivotY - _canvasPanY) / oldZoom;
  _canvasPanX = pivotX - logicalX * newZoom;
  _canvasPanY = pivotY - logicalY * newZoom;
}

/** 纯粹改变 zoom 级别（不 apply，不改 pan） */
function _stepZoomLevel(direction) {
  if (direction === 0) {
    _canvasZoomLevel = 1;
  } else {
    const idx = _ZOOM_STEPS.findIndex(s => s >= _canvasZoomLevel);
    if (direction > 0) {
      _canvasZoomLevel = _ZOOM_STEPS[Math.min(idx + 1, _ZOOM_STEPS.length - 1)];
    } else {
      _canvasZoomLevel = _ZOOM_STEPS[Math.max(idx - 1, 0)];
    }
  }
}

/** 公共接口：按钮点击缩放，以画布视口中心为基准 */
function canvasZoom(direction) {
  const canvas = $('employeeCanvas');
  const oldZoom = _canvasZoomLevel;

  if (direction === 0) {
    // 重置：zoom=1, pan 让内容左上角在 (0,0)
    _canvasZoomLevel = 1;
    _canvasPanX = 0;
    _canvasPanY = 0;
    _applyCanvasTransform();
    return;
  }

  _stepZoomLevel(direction);
  const newZoom = _canvasZoomLevel;

  if (oldZoom !== newZoom && canvas) {
    const vpCX = canvas.clientWidth / 2;
    const vpCY = canvas.clientHeight / 2;
    _zoomAroundPoint(vpCX, vpCY, oldZoom, newZoom);
  }
  _applyCanvasTransform();
}

function _initCanvasZoom() {
  // 恢复保存的状态（按工作区）
  _loadCanvasState();

  const canvas = $('employeeCanvas');
  if (!canvas) return;

  // 画布交互提示浮窗（首次访问显示，用户关闭后永久隐藏）
  try {
    const hint = document.getElementById('canvasHint');
    const closeBtn = document.getElementById('canvasHintClose');
    if (hint && !localStorage.getItem('hermes-canvas-hint-dismissed')) {
      hint.style.display = 'block';
    }
    if (closeBtn && !closeBtn._bound) {
      closeBtn._bound = true;
      closeBtn.onclick = () => {
        if (hint) hint.style.display = 'none';
        try { localStorage.setItem('hermes-canvas-hint-dismissed', '1'); } catch(_) {}
      };
    }
  } catch(_) {}

  // ── 滚轮缩放 — 以鼠标位置为中心 ──
  // 支持两种触发方式（满足不同用户习惯）：
  //  1. Ctrl / Cmd + 滚轮 —— 业界标准（Figma/Miro/VSCode），推荐
  //  2. 直接滚轮 —— 兼容旧行为（仅当指针在画布内且目标不是卡片输入框等）
  //
  // 监听挂在 document 上 + capture 阶段，这样即使画布被 DockManager 重新 parent
  // 或套在 tab/split 容器中，都能捕获到 wheel 事件；命中判断用 closest('#employeeCanvas')
  // 以保证只在画布区域生效。
  const _onCanvasWheel = (e) => {
    // 必须命中画布
    const canvasEl = e.target.closest('#employeeCanvas');
    if (!canvasEl) return;
    // 例外：文件树/代码编辑器等内部元素需要自己滚动
    if (e.target.closest('.main-file-tree')
     || e.target.closest('.cm-editor')
     || e.target.closest('textarea')
     || e.target.closest('input')
     || e.target.closest('[contenteditable="true"]')) {
      return;
    }

    // 判断是否触发缩放：Ctrl/Cmd + 滚轮 → 缩放
    //   普通滚轮 → 平移（垂直）；Shift+滚轮 → 平移（横向）
    //   这样即使用户不知道 Ctrl+滚轮，也能用普通滚轮浏览画布
    const isZoomGesture = e.ctrlKey || e.metaKey;
    const rect = canvasEl.getBoundingClientRect();

    if (!isZoomGesture) {
      // 普通滚轮 → 平移画布（触控板二指 / 鼠标滚轮）
      e.preventDefault();
      e.stopPropagation();
      const step = 60; // 每次滚动的像素量（画布坐标系）
      if (e.shiftKey) {
        // Shift+滚轮 → 横向平移
        _canvasPanX -= (e.deltaY > 0 ? step : -step);
      } else {
        // 竖向平移 — 同时支持 deltaX（触控板横向）
        if (Math.abs(e.deltaX) > Math.abs(e.deltaY)) {
          _canvasPanX -= (e.deltaX > 0 ? step : -step);
        } else {
          _canvasPanY -= (e.deltaY > 0 ? step : -step);
        }
      }
      _applyCanvasTransform();
      return;
    }

    e.preventDefault();
    e.stopPropagation();

    const delta = e.deltaY > 0 ? -1 : 1;
    const oldZoom = _canvasZoomLevel;
    _stepZoomLevel(delta);
    const newZoom = _canvasZoomLevel;

    if (oldZoom !== newZoom) {
      const pivotX = e.clientX - rect.left;
      const pivotY = e.clientY - rect.top;
      _zoomAroundPoint(pivotX, pivotY, oldZoom, newZoom);
      _applyCanvasTransform();
    }
  };
  // 同时挂 document 级 + canvas 级，双保险。passive:false 以便 preventDefault 阻止页面缩放。
  document.addEventListener('wheel', _onCanvasWheel, { passive: false, capture: true });

  // ── 右键/中键/空格+左键 拖动平移画布 ──
  //   主流画布应用（Figma/Miro/Excalidraw）都默认支持 空格+左键 拖动，
  //   这是用户最习惯的方式，比右键更符合直觉。
  let _panning = false;
  let _panStartX = 0, _panStartY = 0;
  let _panOriginX = 0, _panOriginY = 0;
  let _spaceHeld = false; // 空格键是否按住

  // 空格键按住 → 画布进入"平移模式"，鼠标变为 grab
  document.addEventListener('keydown', (e) => {
    if (e.code === 'Space' && !_spaceHeld) {
      // 避免在 input/textarea/contenteditable 里触发
      const t = e.target;
      const tag = t && t.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || (t && t.isContentEditable)) return;
      _spaceHeld = true;
      if (canvas) canvas.classList.add('canvas-space-pan');
      e.preventDefault();
    }
  });
  document.addEventListener('keyup', (e) => {
    if (e.code === 'Space') {
      _spaceHeld = false;
      if (canvas) canvas.classList.remove('canvas-space-pan');
      if (_panning && !canvas.style.cursor.includes('grabbing')) {
        // 放开空格键 → 若不在拖动中，恢复默认光标
        canvas.style.cursor = '';
      }
    }
  });

  canvas.addEventListener('contextmenu', (e) => {
    if (!e.target.closest('.emp-card')) {
      e.preventDefault();
    }
  });

  canvas.addEventListener('mousedown', (e) => {
    // 右键（button 2）或 空格+左键（button 0 + _spaceHeld）或 中键（button 1） → 平移
    const isRightPan = (e.button === 2);
    const isSpacePan = (e.button === 0 && _spaceHeld);
    const isMiddlePan = (e.button === 1);
    if ((isRightPan || isSpacePan || isMiddlePan) && !e.target.closest('.emp-card')) {
      _panning = true;
      _panStartX = e.clientX;
      _panStartY = e.clientY;
      _panOriginX = _canvasPanX;
      _panOriginY = _canvasPanY;
      canvas.style.cursor = 'grabbing';
      e.preventDefault();
      e.stopPropagation(); // 防止 _initBoxSelection 的左键 mousedown 同时启动框选
    }
  });

  document.addEventListener('mousemove', (e) => {
    if (!_panning) return;
    const dx = e.clientX - _panStartX;
    const dy = e.clientY - _panStartY;
    _canvasPanX = _panOriginX + dx;
    _canvasPanY = _panOriginY + dy;
    _applyCanvasTransform();
  });

  document.addEventListener('mouseup', (e) => {
    // 任一被支持的按钮释放都停止平移（1=中键,2=右键,0=左键/空格模式）
    if (_panning && (e.button === 0 || e.button === 1 || e.button === 2)) {
      _panning = false;
      canvas.style.cursor = _spaceHeld ? 'grab' : '';
    }
  });
}

// ── 工作区选择下拉框 ──────────────────────────────────────────────────────────
let _wsSelectorList = [];

/**
 * 定位下拉到触发按钮的正下方。
 * 下拉使用 position: fixed（见 style.css），因此 top/left 以视口为参考。
 * 好处：不受祖先 stacking context 影响，不会被画布/dock-content 盖住。
 *
 * ★ 关键：需要先把下拉从 .topbar 移到 document.body 才能正确 fixed 定位。
 *   因为 .topbar 有 backdrop-filter: blur(...)，按 CSS 规范会创建
 *   fixed 定位的包含块（containing block），导致 left/top 以 topbar
 *   左上角为原点而非视口——下拉会向右偏移 sidebar 宽度。
 *
 * @param {HTMLElement} dd 下拉元素
 * @param {HTMLElement} btn 触发按钮
 */
function _positionWsDropdown(dd, btn) {
  if (!dd || !btn) return;
  // 提升到 body 层，摆脱 .topbar 的 backdrop-filter 包含块
  if (dd.parentElement !== document.body) {
    document.body.appendChild(dd);
  }
  const r = btn.getBoundingClientRect();
  const vw = window.innerWidth;
  const margin = 4;

  // ★ 2026-04-27 再次调整：按钮改为自适应宽度后（不再填满 topbar），
  //   下拉不能再"严格等按钮宽"，否则按钮很窄时下拉跟着窄，工作区名/路径
  //   会被截成一条非常挤的列表。改为：
  //     - 下限：max(按钮宽, 360) —— 保证下拉足够宽能看清工作区信息
  //     - 上限：min(视口-16, 900) —— 防止在超宽屏上过分拉伸
  //   这样视觉上"按钮 <= 下拉"，仍然左对齐到按钮左边；对齐上舒服但不僵硬等宽。
  const MIN_DROPDOWN_W = 360;
  const MAX_DROPDOWN_W = Math.min(vw - 16, 900);
  const btnW = Math.round(r.width);
  const wantW = Math.max(MIN_DROPDOWN_W, Math.min(MAX_DROPDOWN_W, btnW));
  // 用 inline 强制覆盖 CSS 的 min/max，确保下拉精确宽度
  dd.style.width = wantW + 'px';
  dd.style.minWidth = wantW + 'px';
  dd.style.maxWidth = wantW + 'px';

  // 默认左对齐到按钮左边；若下拉会溢出视口右边，则右对齐到按钮右边
  let left = r.left;
  if (left + wantW > vw - 8) {
    left = Math.max(8, r.right - wantW);
  }
  dd.style.top = (r.bottom + margin) + 'px';
  dd.style.left = left + 'px';
}

function toggleWsSelector() {
  const dd = $('wsSelectorDropdown');
  if (!dd) return;
  const open = dd.classList.contains('open');
  if (open) {
    dd.classList.remove('open');
  } else {
    loadWorkspaceList().then(data => {
      _wsSelectorList = data.workspaces || [];
      _renderWsSelectorDropdown(dd);
      dd.classList.add('open');
      // 定位到触发按钮的正下方（fixed 定位）
      const btn = $('wsSelectorBtn') || (dd.parentElement && dd.parentElement.querySelector('button'));
      _positionWsDropdown(dd, btn);
    });
  }
}

/**
 * 顶部左侧"工作区信息"按钮的下拉切换：复用同一份工作区列表渲染，
 * 但渲染到 wsInfoDropdown 节点上。点击选项/外部会关闭下拉。
 */
function toggleWsInfoSelector() {
  const dd = $('wsInfoDropdown');
  if (!dd) return;
  // 若另一个 ws 下拉开着，先关掉
  const otherDd = $('wsSelectorDropdown');
  if (otherDd) otherDd.classList.remove('open');
  const open = dd.classList.contains('open');
  if (open) {
    dd.classList.remove('open');
  } else {
    loadWorkspaceList().then(data => {
      _wsSelectorList = data.workspaces || [];
      _renderWsSelectorDropdown(dd);
      dd.classList.add('open');
      // 定位到 wsInfoBtn 的正下方（fixed 定位）
      _positionWsDropdown(dd, $('wsInfoBtn'));
    });
  }
}

function closeWsInfoSelector() {
  const dd = $('wsInfoDropdown');
  if (dd) dd.classList.remove('open');
}

function closeWsSelector() {
  const dd = $('wsSelectorDropdown');
  if (dd) dd.classList.remove('open');
}

function _renderWsSelectorDropdown(dd) {
  if (!dd) return;
  const currentWs = (typeof _currentCanvasWorkspace !== 'undefined' ? _currentCanvasWorkspace : '') || S.session?.workspace || '';
  dd.innerHTML = '';

  // ★ 顶部显示"当前工作区"信息卡片（让下拉自身也能承载工作区信息）
  if (currentWs && currentWs !== '__default__') {
    const curName = typeof getWorkspaceFriendlyName === 'function' ? getWorkspaceFriendlyName(currentWs) : (currentWs.split(/[\/\\]/).filter(Boolean).pop() || currentWs);
    const header = document.createElement('div');
    header.className = 'ws-current-header';
    header.innerHTML = `
      <div class="ws-current-label">当前工作区</div>
      <div class="ws-current-name">${esc(curName)}</div>
      <div class="ws-current-path" title="${esc(currentWs)}">${esc(currentWs)}</div>
    `;
    dd.appendChild(header);
    dd.appendChild(Object.assign(document.createElement('div'), { className: 'ws-divider' }));
  }

  for (const w of _wsSelectorList) {

    const opt = document.createElement('div');
    opt.className = 'ws-opt' + (w.path === currentWs ? ' active' : '');
    // 左侧：点击切换工作区
    const infoDiv = document.createElement('div');
    infoDiv.className = 'ws-opt-info';
    infoDiv.innerHTML = `<span class="ws-opt-name">${esc(w.name)}</span><span class="ws-opt-path" title="${esc(w.path)}">${esc(w.path)}</span>`;
    infoDiv.onclick = () => {
      closeWsSelector();
      if (typeof closeWsInfoSelector === 'function') closeWsInfoSelector();
      if (w.path !== currentWs && typeof switchToWorkspace === 'function') {
        switchToWorkspace(w.path, w.name);
      }
    };
    opt.appendChild(infoDiv);
    // 右侧：删除按钮
    const delBtn = document.createElement('button');
    delBtn.className = 'ws-opt-del';
    delBtn.title = '删除工作区';
    delBtn.innerHTML = li('x', 12);
    delBtn.onclick = (e) => {
      e.stopPropagation();
      if (typeof removeWorkspace === 'function') removeWorkspace(w.path);
    };
    opt.appendChild(delBtn);
    dd.appendChild(opt);
  }

  // 添加工作区选项
  dd.appendChild(Object.assign(document.createElement('div'), { className: 'ws-divider' }));
  const addAction = document.createElement('div');
  addAction.className = 'ws-opt ws-opt-action';
  addAction.innerHTML = `<span class="ws-opt-name">+ 添加工作区路径</span>`;
  addAction.onclick = () => {
    closeWsSelector();
    if (typeof closeWsInfoSelector === 'function') closeWsInfoSelector();
    setTimeout(() => {
      if (typeof promptWorkspacePath === 'function') promptWorkspacePath();
    }, 50);
  };
  dd.appendChild(addAction);
}

function syncWsSelectorLabel() {
  const label = $('wsSelectorLabel');
  if (!label) return;
  const ws = (typeof _currentCanvasWorkspace !== 'undefined' ? _currentCanvasWorkspace : '') || S.session?.workspace || '';
  if (ws && ws !== '__default__') {
    const name = typeof getWorkspaceFriendlyName === 'function' ? getWorkspaceFriendlyName(ws) : ws.split(/[\/\\]/).filter(Boolean).pop();
    label.textContent = name;
    label.title = ws;
  } else {
    label.textContent = '工作区';
    label.title = '';
  }
}

// 点击外部关闭下拉
document.addEventListener('click', e => {
  if (!e.target.closest('#wsSelectorWrap')
      && !e.target.closest('#wsSelectorDropdown')) closeWsSelector();
  if (!e.target.closest('#wsInfoWrap')
      && !e.target.closest('#wsInfoDropdown')) closeWsInfoSelector();
});

// 视口变化时重新定位打开中的下拉（fixed 定位需跟随按钮移动）
window.addEventListener('resize', () => {
  const sel = $('wsSelectorDropdown');
  if (sel && sel.classList.contains('open')) _positionWsDropdown(sel, $('wsSelectorBtn'));
  const info = $('wsInfoDropdown');
  if (info && info.classList.contains('open')) _positionWsDropdown(info, $('wsInfoBtn'));
});

function switchWorkspaceTab(tab) {
  _activeWorkspaceTab = tab;
  localStorage.setItem('hermes-workspace-tab', tab);
  // 更新页签按钮状态
  document.querySelectorAll('.workspace-tab').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.tab === tab);
  });
  // 切换内容面板
  const canvasContent = $('canvasContent');
  const filesContent = $('filesContent');
  const logsContent = $('logsContent');
  const empToolbarInline = $('empToolbarInline');

  if (tab === 'canvas') {
    if (canvasContent) canvasContent.classList.add('active');
    if (filesContent) filesContent.classList.remove('active');
    if (logsContent) logsContent.classList.remove('active');
    if (empToolbarInline) empToolbarInline.style.display = '';
    const zoomControls = $('canvasZoomControls');
    if (zoomControls) zoomControls.style.display = '';
    const fileTabRefresh = $('fileTabRefreshBtn');
    if (fileTabRefresh) fileTabRefresh.classList.remove('visible');
  } else if (tab === 'logs') {
    if (canvasContent) canvasContent.classList.remove('active');
    if (filesContent) filesContent.classList.remove('active');
    if (logsContent) logsContent.classList.add('active');
    if (empToolbarInline) empToolbarInline.style.display = 'none';
    const zoomControls = $('canvasZoomControls');
    if (zoomControls) zoomControls.style.display = 'none';
    const fileTabRefresh = $('fileTabRefreshBtn');
    if (fileTabRefresh) fileTabRefresh.classList.remove('visible');
    // Auto-connect SSE if not already
    if (typeof connectLogsSSE === 'function') connectLogsSSE();
    // Re-render logs that may have accumulated while tab was hidden
    if (typeof _reRenderLogs === 'function') _reRenderLogs();
  } else {
    if (canvasContent) canvasContent.classList.remove('active');
    if (filesContent) filesContent.classList.add('active');
    if (logsContent) logsContent.classList.remove('active');
    if (empToolbarInline) empToolbarInline.style.display = 'none';
    const zoomControls = $('canvasZoomControls');
    if (zoomControls) zoomControls.style.display = 'none';
    const fileTabRefresh = $('fileTabRefreshBtn');
    if (fileTabRefresh) fileTabRefresh.classList.add('visible');
    // 先用缓存数据渲染（立即可见）
    _renderMainBreadcrumb();
    _renderMainFileTree();
    // 然后异步刷新最新数据
    if (typeof loadDir === 'function') {
      try { loadDir('.'); } catch(e) { console.warn('auto loadDir failed:', e); }
    }
  }
}

// ── 框选 + 多选 + 整体移动 ──────────────────────────────────────────────────

/** 当前被框选/多选的卡片 ID 集合 */
let _selectedCardIds = new Set();

/** 框选状态 */
let _boxSelecting = false;
let _boxStartX = 0, _boxStartY = 0;   // 鼠标按下时的 client 坐标
let _boxEl = null;                      // 框选矩形 DOM

/** 清除所有选中状态 */
function _clearCardSelection() {
  _selectedCardIds.clear();
  document.querySelectorAll('.emp-card.emp-multi-selected').forEach(c => c.classList.remove('emp-multi-selected'));
}

/** 切换单张卡片的选中状态（Ctrl/Meta 点击） */
function _toggleCardSelection(cardId) {
  if (_selectedCardIds.has(cardId)) {
    _selectedCardIds.delete(cardId);
  } else {
    _selectedCardIds.add(cardId);
  }
  _syncSelectionClasses();
}

/** 同步 DOM 上的选中 class */
function _syncSelectionClasses() {
  const layer = $('canvasZoomLayer') || $('employeeCanvas');
  if (!layer) return;
  layer.querySelectorAll('.emp-card').forEach(card => {
    card.classList.toggle('emp-multi-selected', _selectedCardIds.has(card.dataset.id));
  });
}

/** 判断两个矩形是否相交 */
function _rectsIntersect(a, b) {
  return !(a.right < b.left || a.left > b.right || a.bottom < b.top || a.top > b.bottom);
}

/** 初始化框选功能 */
function _initBoxSelection() {
  const canvas = $('employeeCanvas');
  if (!canvas) return;

  // 创建框选矩形元素
  _boxEl = document.createElement('div');
  _boxEl.className = 'canvas-box-select';
  _boxEl.style.display = 'none';
  canvas.appendChild(_boxEl);

  // 鼠标按下：只在画布空白处（非卡片、非连线手柄）触发框选
  canvas.addEventListener('mousedown', (e) => {
    // 右键/中键不做框选
    if (e.button !== 0) return;
    // 如果点在卡片上、按钮上、连线手柄上则跳过
    if (e.target.closest('.emp-card') || e.target.closest('button') || e.target.closest('.emp-conn-handle')) return;
    // 如果正在画布平移或连线，不框选
    if (_isDrawingConnection) return;

    _boxSelecting = true;
    _boxStartX = e.clientX;
    _boxStartY = e.clientY;
    _boxEl.style.display = 'block';
    _boxEl.style.left = '0';
    _boxEl.style.top = '0';
    _boxEl.style.width = '0';
    _boxEl.style.height = '0';

    // 如果没有按 Ctrl/Meta/Shift，清除之前的选择
    if (!e.ctrlKey && !e.metaKey && !e.shiftKey) {
      _clearCardSelection();
    }

    e.preventDefault();
  });

  document.addEventListener('mousemove', (e) => {
    if (!_boxSelecting) return;

    const canvasRect = canvas.getBoundingClientRect();
    // 框选矩形在视口坐标系中的范围
    const x1 = Math.min(_boxStartX, e.clientX);
    const y1 = Math.min(_boxStartY, e.clientY);
    const x2 = Math.max(_boxStartX, e.clientX);
    const y2 = Math.max(_boxStartY, e.clientY);

    // 定位框选矩形（相对于 canvas 容器）
    _boxEl.style.left = (x1 - canvasRect.left) + 'px';
    _boxEl.style.top = (y1 - canvasRect.top) + 'px';
    _boxEl.style.width = (x2 - x1) + 'px';
    _boxEl.style.height = (y2 - y1) + 'px';

    // 实时高亮相交的卡片
    const selRect = { left: x1, top: y1, right: x2, bottom: y2 };
    const layer = $('canvasZoomLayer') || $('employeeCanvas');
    layer.querySelectorAll('.emp-card').forEach(card => {
      const cardRect = card.getBoundingClientRect();
      if (_rectsIntersect(selRect, cardRect)) {
        _selectedCardIds.add(card.dataset.id);
      } else if (!e.ctrlKey && !e.metaKey && !e.shiftKey) {
        _selectedCardIds.delete(card.dataset.id);
      }
    });
    _syncSelectionClasses();
  });

  document.addEventListener('mouseup', (e) => {
    if (!_boxSelecting) return;
    _boxSelecting = false;
    _boxEl.style.display = 'none';
  });

  // 点击空白处清除选择（非框选、非平移）
  canvas.addEventListener('click', (e) => {
    if (e.target.closest('.emp-card') || e.target.closest('button')) return;
    // 如果框选刚结束（有选中卡片），不清除
    if (_selectedCardIds.size > 0) return;
    _clearCardSelection();
  });

  // ESC 键取消选择
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && _selectedCardIds.size > 0) {
      _clearCardSelection();
    }
  });
}

// ── 画布自由拖动 ─────────────────────────────────────────────────────────────

/** 为员工卡片在画布上设置自由拖动 */
function _initFreeDrag(card, emp) {
  let isDragging = false;
  let startX, startY, origX, origY;
  let _isGroupDrag = false;          // 是否正在整体拖动多张选中卡片
  let _groupOrigPositions = null;    // 整体拖动时记录每张卡片的初始位置

  card.addEventListener('mousedown', onMouseDown);
  card.addEventListener('touchstart', onTouchStart, { passive: false });

  function onMouseDown(e) {
    // 不拦截按钮、输入框和连接手柄
    if (e.target.closest('button') || e.target.closest('input') || e.target.closest('.emp-card-menu-btn') || e.target.closest('.emp-conn-handle')) return;
    if (e.button !== 0) return;
    e.preventDefault();

    // Ctrl/Meta 点击切换选择
    if (e.ctrlKey || e.metaKey) {
      _toggleCardSelection(card.dataset.id);
      return; // 不开始拖动
    }

    startDrag(e.clientX, e.clientY);
    document.addEventListener('mousemove', onMouseMove);
    document.addEventListener('mouseup', onMouseUp);
  }

  function onTouchStart(e) {
    if (e.target.closest('button') || e.target.closest('input') || e.target.closest('.emp-conn-handle')) return;
    const t = e.touches[0];
    startDrag(t.clientX, t.clientY);
    document.addEventListener('touchmove', onTouchMove, { passive: false });
    document.addEventListener('touchend', onTouchEnd);
  }

  function startDrag(clientX, clientY) {
    isDragging = false;
    _isGroupDrag = false;
    _groupOrigPositions = null;
    startX = clientX;
    startY = clientY;
    const style = card.style;
    origX = parseInt(style.left) || card.offsetLeft || 0;
    origY = parseInt(style.top) || card.offsetTop || 0;

    // 判断是否属于多选拖动
    if (_selectedCardIds.size > 1 && _selectedCardIds.has(card.dataset.id)) {
      _isGroupDrag = true;
      // 记录所有选中卡片的初始位置
      _groupOrigPositions = new Map();
      const layer = $('canvasZoomLayer') || $('employeeCanvas');
      layer.querySelectorAll('.emp-card').forEach(c => {
        if (_selectedCardIds.has(c.dataset.id)) {
          _groupOrigPositions.set(c.dataset.id, {
            el: c,
            x: parseInt(c.style.left) || 0,
            y: parseInt(c.style.top) || 0
          });
        }
      });
    }
  }

  function onMouseMove(e) { moveDrag(e.clientX, e.clientY); }
  function onTouchMove(e) { e.preventDefault(); const t = e.touches[0]; moveDrag(t.clientX, t.clientY); }

  let _dragRafId = 0;

  function moveDrag(clientX, clientY) {
    const zoom = _canvasZoomLevel || 1;
    const dx = (clientX - startX) / zoom;
    const dy = (clientY - startY) / zoom;
    if (!isDragging && (Math.abs(clientX - startX) > 3 || Math.abs(clientY - startY) > 3)) {
      isDragging = true;
      card.classList.add('emp-dragging-free');
      if (_isGroupDrag && _groupOrigPositions) {
        _groupOrigPositions.forEach((pos) => {
          pos.el.classList.add('emp-dragging-free');
        });
      }
    }
    if (!isDragging) return;

    if (_isGroupDrag && _groupOrigPositions) {
      // 整体移动所有选中卡片
      _groupOrigPositions.forEach((pos) => {
        pos.el.style.left = (pos.x + dx) + 'px';
        pos.el.style.top = (pos.y + dy) + 'px';
      });
    } else {
      // 单卡拖动
      card.style.left = (origX + dx) + 'px';
      card.style.top = (origY + dy) + 'px';
    }

    // 拖拽时用 rAF 节流刷新连线
    if (typeof renderConnections === 'function') {
      cancelAnimationFrame(_dragRafId);
      _dragRafId = requestAnimationFrame(renderConnections);
    }
  }

  function onMouseUp(e) {
    document.removeEventListener('mousemove', onMouseMove);
    document.removeEventListener('mouseup', onMouseUp);
    endDrag(e.clientX, e.clientY);
  }
  function onTouchEnd(e) {
    document.removeEventListener('touchmove', onTouchMove);
    document.removeEventListener('touchend', onTouchEnd);
    endDrag(startX, startY); // use last known position
  }

  function endDrag() {
    if (isDragging) {
      card.classList.remove('emp-dragging-free');

      if (_isGroupDrag && _groupOrigPositions) {
        // 整体拖动：保存所有选中卡片的位置
        _groupOrigPositions.forEach((pos) => {
          pos.el.classList.remove('emp-dragging-free');
          const x = parseInt(pos.el.style.left) || 0;
          const y = parseInt(pos.el.style.top) || 0;
          const empData = getEmployee(pos.el.dataset.id);
          if (empData) {
            empData._pos = { x, y };
          }
        });
        _saveEmployees();
      } else {
        // 单卡拖动：保存位置到员工数据
        const x = parseInt(card.style.left) || 0;
        const y = parseInt(card.style.top) || 0;
        const emp = getEmployee(card.dataset.id);
        if (emp) {
          emp._pos = { x, y };
          _saveEmployees();
        }
      }
      // 拖拽结束后刷新连线
      if (typeof refreshConnections === 'function') refreshConnections();
    }
    isDragging = false;
    _isGroupDrag = false;
    _groupOrigPositions = null;
  }
}

/** 将卡片定位到画布上的位置 */
function _positionCard(card, emp) {
  const pos = emp._pos;
  if (pos && typeof pos.x === 'number' && typeof pos.y === 'number') {
    card.style.left = pos.x + 'px';
    card.style.top = pos.y + 'px';
  } else {
    // 自动布局：根据数组索引排列
    const idx = EMPLOYEE_STORE.employees.indexOf(emp);
    const canvasEl = $('employeeCanvas');
    const cols = Math.max(1, Math.floor((canvasEl?.clientWidth || 800) / 264));
    const col = idx % cols;
    const row = Math.floor(idx / cols);
    card.style.left = (col * 264 + 16) + 'px';
    card.style.top = (row * 200 + 16) + 'px';
  }
}

// ── 文件目录面板 ─────────────────────────────────────────────────────────────

/** 渲染中间面板的文件目录 */
function _renderMainFileTree() {
  const container = $('mainFileTree');
  if (!container) return;

  // 文件列表为空时，自动加载工作目录（仅一次，防止无限循环）
  if (!S.entries || S.entries.length === 0) {
    // Need a valid session with workspace to load files
    if (typeof loadDir === 'function' && S.session && (_activeWorkspacePath())) {
      // Guard: only auto-load once per workspace. After that, accept empty results.
      // Reset _dirLoadAttempted when workspace changes (detected via active workspace).
      const wsKey = _activeWorkspacePath();
      if (S._dirLoadWsKey !== wsKey) {
        S._dirLoadWsKey = wsKey;
        S._dirLoadAttempted = false;
      }
      if (!S._dirLoadAttempted) {
        S._dirLoadAttempted = true;
        loadDir('.');
      }
      container.innerHTML = '<div class="empty-tree-hint" style="padding:16px;color:var(--muted);font-size:12px">' +
        (S._dirLoadAttempted && S.entries.length === 0 ? 'Empty directory' : 'Loading...') + '</div>';
    } else {
      container.innerHTML = '<div class="empty-tree-hint">Select a workspace to browse files</div>';
    }
    return;
  }

  // 渲染面包屑到页签工具栏
  _renderMainBreadcrumb();

  // 渲染文件树
  const entries = S.entries || [];
  const frag = document.createDocumentFragment();
  _renderMainTreeItems(frag, entries, 0);
  container.innerHTML = '';
  container.appendChild(frag);
}

/** 在中间面板渲染面包屑导航 */
function _renderMainBreadcrumb() {
  const bar = $('mainBreadcrumb');
  if (!bar) return;
  bar.innerHTML = '';

  // 获取工作区绝对路径
  const wsPath = (typeof _activeWorkspacePath === 'function') ? _activeWorkspacePath() : (S.session && S.session.workspace) || '';

  if (!S.currentDir || S.currentDir === '.') {
    const root = document.createElement('span');
    root.className = 'breadcrumb-seg breadcrumb-current';
    root.textContent = wsPath || '~';
    root.title = wsPath || '~';
    bar.appendChild(root);
  } else {
    // Root — 显示工作区路径
    const root = document.createElement('span');
    root.className = 'breadcrumb-seg breadcrumb-link';
    root.textContent = wsPath || '~';
    root.title = wsPath || '~';
    root.onclick = () => { if (typeof loadDir === 'function') loadDir('.'); };
    bar.appendChild(root);

    const parts = S.currentDir.split('/');
    let accumulated = '';
    for (let i = 0; i < parts.length; i++) {
      const sep = document.createElement('span');
      sep.className = 'breadcrumb-sep'; sep.textContent = '/';
      bar.appendChild(sep);
      accumulated += (accumulated ? '/' : '') + parts[i];
      const seg = document.createElement('span');
      seg.textContent = parts[i];
      if (i < parts.length - 1) {
        seg.className = 'breadcrumb-seg breadcrumb-link';
        const target = accumulated;
        seg.onclick = () => { if (typeof loadDir === 'function') loadDir(target); };
      } else {
        seg.className = 'breadcrumb-seg breadcrumb-current';
      }
      bar.appendChild(seg);
    }
  }
}

const _MAX_TREE_DEPTH = 20;  // 防止无限递归

function _renderMainTreeItems(container, entries, depth) {
  if (depth > _MAX_TREE_DEPTH) return;  // 超过最大深度，停止渲染
  for (const item of entries) {
    const el = document.createElement('div');
    el.className = 'file-item';
    el.style.paddingLeft = (8 + depth * 16) + 'px';

    if (item.type === 'dir') {
      const arrow = document.createElement('span');
      arrow.className = 'file-tree-toggle';
      const isExpanded = S._expandedDirs && S._expandedDirs.has(item.path);
      arrow.textContent = isExpanded ? '\u25BE' : '\u25B8';
      el.appendChild(arrow);
    }

    // Icon
    const iconEl = document.createElement('span');
    iconEl.className = 'file-icon';
    iconEl.innerHTML = typeof fileIcon === 'function' ? fileIcon(item.name, item.type) : (item.type === 'dir' ? '📁' : '📄');
    el.appendChild(iconEl);

    // Name
    const nameEl = document.createElement('span');
    nameEl.className = 'file-name';
    nameEl.textContent = item.name;
    el.appendChild(nameEl);

    // Size -- only for files
    if (item.type === 'file' && item.size) {
      const sizeEl = document.createElement('span');
      sizeEl.className = 'file-size';
      sizeEl.textContent = `${(item.size / 1024).toFixed(1)}k`;
      el.appendChild(sizeEl);
    }

    // Delete button -- for files
    if (item.type === 'file') {
      const del = document.createElement('button');
      del.className = 'file-del-btn';
      del.title = typeof t === 'function' ? t('delete_title') : '删除';
      del.textContent = '\u00d7';
      del.onclick = async (e) => {
        e.stopPropagation();
        if (typeof deleteWorkspaceFile === 'function') {
          await deleteWorkspaceFile(item.path, item.name);
        }
      };
      el.appendChild(del);
    }

    // Right-click context menu
    el.oncontextmenu = (e) => {
      e.preventDefault(); e.stopPropagation();
      if (typeof _showFileCtxMenu === 'function') _showFileCtxMenu(e.clientX, e.clientY, item);
    };

    // Click handler
    if (item.type === 'dir') {
      el.onclick = async () => {
        if (!S._expandedDirs) S._expandedDirs = new Set();
        if (S._expandedDirs.has(item.path)) {
          S._expandedDirs.delete(item.path);
        } else {
          S._expandedDirs.add(item.path);
          if (!S._dirCache) S._dirCache = {};
          if (!S._dirCache[item.path]) {
            try {
              const _sid = (S.session && S.session.session_id) ? encodeURIComponent(S.session.session_id) : '';
              const _qs = _sid ? `session_id=${_sid}&path=${encodeURIComponent(item.path)}` : `path=${encodeURIComponent(item.path)}`;
              const data = await api(`/api/list?${_qs}`);
              // 过滤掉 path 与父目录相同的自引用条目，防止无限递归
              const raw = data.entries || [];
              S._dirCache[item.path] = raw.filter(e => e.path !== item.path);
            } catch (e) { S._dirCache[item.path] = []; }
          }
        }
        if (typeof _saveExpandedDirs === 'function') _saveExpandedDirs();
        _renderMainFileTree();
      };
    } else {
      el.onclick = () => {
        // 在右侧面板中打开文件预览
        if (typeof openFileInRightPanel === 'function') openFileInRightPanel(item.path);
        else if (typeof openFile === 'function') openFile(item.path);
      };
    }

    container.appendChild(el);

    // Children
    if (item.type === 'dir' && S._expandedDirs && S._expandedDirs.has(item.path)) {
      const children = (S._dirCache && S._dirCache[item.path]) || [];
      if (children.length) {
        _renderMainTreeItems(container, children, depth + 1);
      } else {
        const empty = document.createElement('div');
        empty.className = 'file-item file-empty';
        empty.style.paddingLeft = (8 + (depth + 1) * 16) + 'px';
        empty.textContent = '空目录';
        container.appendChild(empty);
      }
    }
  }
}

// ── 覆盖原有 renderEmployeeCards 以支持自由拖动 ───────────────────────────────
const _originalRenderEmployeeCards = typeof renderEmployeeCards === 'function' ? renderEmployeeCards : null;

function renderEmployeeCards() {
  // 列表模式时渲染列表，不走画布渲染
  if (_displayMode === 'list') {
    renderEmployeeList();
    return;
  }
  const canvas = $('canvasZoomLayer') || $('employeeCanvas');
  const empty = $('employeeEmptyState');
  if (!canvas) return;
  // ★ 如果正在内联重命名，跳过重渲（防止 input 被销毁）
  if (canvas.querySelector('[data-editing="1"]')) return;

  // 清除旧卡片
  canvas.querySelectorAll('.emp-card').forEach(c => c.remove());
  canvas.querySelectorAll('.emp-search-no-result').forEach(c => c.remove());

  const filtered = _getFilteredEmployees();

  if (!EMPLOYEE_STORE.employees.length) {
    if (empty) empty.style.display = '';
    return;
  }
  if (empty) empty.style.display = 'none';

  if (!filtered.length && _empSearchQuery) {
    const noResult = document.createElement('div');
    noResult.className = 'emp-search-no-result';
    noResult.innerHTML = '<p>没有找到匹配的员工</p>';
    canvas.appendChild(noResult);
    return;
  }

  for (const emp of filtered) {
    const card = _buildCard(emp);
    // 移除旧的 grid 拖拽（_buildCard 中 _initCardDrag 添加的事件）
    // 用 clone 替换法清除所有事件监听
    const clone = card.cloneNode(true);
    clone.dataset.dragInit = 'free';
    clone.draggable = false; // 自由拖动不使用 HTML5 drag API
    // 重新绑定点击事件
    clone.addEventListener('click', () => selectEmployee(emp.id));
    // 重新绑定菜单按钮
    const menuBtn = clone.querySelector('.emp-card-menu-btn');
    if (menuBtn) menuBtn.onclick = (e) => { e.stopPropagation(); _showCardMenu(e, emp.id); };
    // 重新绑定双击重命名
    const nameEl = clone.querySelector('.emp-card-name');
    if (nameEl) nameEl.ondblclick = (e) => { e.stopPropagation(); _startRenameEmployee(emp.id); };
    // 重新绑定操作按钮
    clone.querySelectorAll('.emp-action-btn').forEach(btn => {
      const title = btn.getAttribute('title');
      if (title === '对话') btn.onclick = (e) => { e.stopPropagation(); selectEmployee(emp.id, true); };
    });

    _positionCard(clone, emp);
    _initFreeDrag(clone, emp);
    // 恢复多选状态
    if (_selectedCardIds.has(emp.id)) clone.classList.add('emp-multi-selected');
    canvas.appendChild(clone);
  }

  // 刷新连线（SVG 层 + 连接点手柄 + 徽标）
  if (typeof refreshConnections === 'function') {
    setTimeout(refreshConnections, 50);
  }
}

// ── 监听文件目录数据刷新 ─────────────────────────────────────────────────────
// 覆盖 renderFileTree 以同时刷新中间面板的文件目录
(function() {
  const _origRenderFileTree = typeof renderFileTree === 'function' ? renderFileTree : null;
  window.renderFileTree = function() {
    // 始终更新右侧面板文件树（mainFileTree），不受中间面板 tab 状态影响
    _renderMainFileTree();
  };

  // 同时覆盖 renderBreadcrumb，让中间面板面包屑也能被 loadDir 自动更新
  const _origRenderBreadcrumb = typeof renderBreadcrumb === 'function' ? renderBreadcrumb : null;
  window.renderBreadcrumb = function() {
    // 始终更新中间面板面包屑
    _renderMainBreadcrumb();
    // 同时更新右侧面板面包屑（如果存在）
    if (_origRenderBreadcrumb) {
      try { _origRenderBreadcrumb(); } catch(e) {}
    }
  };
})();

// ── 初始化 ────────────────────────────────────────────────────────────────────
function initWorkspaceTabs() {
  _ensureFileToolbarInline();
  // 恢复上次的页签状态
  const saved = localStorage.getItem('hermes-workspace-tab');
  if (saved === 'files') {
    switchWorkspaceTab('files');
  } else if (saved === 'logs') {
    switchWorkspaceTab('logs');
  }
  // 初始化画布缩放
  _initCanvasZoom();
  // 初始化框选功能
  _initBoxSelection();
  // 初始化工作区选择器标签
  syncWsSelectorLabel();
  // 恢复显示模式
  _loadDisplayMode();
  _applyDisplayMode();
}


// ═══════════════════════════════════════════════════════════════════
// 显示模式：画布 / 员工列表
// ═══════════════════════════════════════════════════════════════════

let _displayMode = 'canvas';  // 'canvas' | 'list'

function _displayModeStorageKey() {
  return 'hermes-display-mode:' + _currentWsKey();
}

function _saveDisplayMode() {
  try { localStorage.setItem(_displayModeStorageKey(), _displayMode); } catch(e) {}
}

function _loadDisplayMode() {
  try {
    const saved = localStorage.getItem(_displayModeStorageKey());
    if (saved === 'list' || saved === 'canvas') _displayMode = saved;
    else _displayMode = 'canvas';
  } catch(e) { _displayMode = 'canvas'; }
}

/** 切换画布/列表模式 */
function toggleDisplayMode() {
  _displayMode = _displayMode === 'canvas' ? 'list' : 'canvas';
  _saveDisplayMode();
  _applyDisplayMode();
}

/** 应用当前显示模式到 DOM */
function _applyDisplayMode() {
  const canvas = $('employeeCanvas');
  const list = $('employeeList');
  const toggle = $('empModeToggle');
  const zoomControls = $('canvasZoomControls');
  const canvasHint = $('canvasHint');
  const empty = $('employeeEmptyState');

  if (_displayMode === 'list') {
    if (canvas) canvas.style.display = 'none';
    if (list) list.style.display = '';
    if (toggle) toggle.classList.add('list-active');
    if (zoomControls) zoomControls.style.display = 'none';
    if (canvasHint) canvasHint.style.display = 'none';
    if (empty) empty.style.display = 'none';
    renderEmployeeList();
  } else {
    if (canvas) canvas.style.display = '';
    if (list) list.style.display = 'none';
    if (toggle) toggle.classList.remove('list-active');
    if (zoomControls) zoomControls.style.display = '';
    renderEmployeeCards();
  }
}


// ── 员工列表渲染 ──────────────────────────────────────────────────────────

/** 渲染员工列表 */
function renderEmployeeList() {
  const container = $('empListItems');
  if (!container) return;
  // ★ 如果正在内联重命名，跳过重渲（防止 input 被销毁）
  if (container.querySelector('[data-editing="1"]')) return;
  container.innerHTML = '';

  const filtered = _getFilteredEmployees();

  // 空状态
  if (!EMPLOYEE_STORE.employees.length) {
    container.innerHTML = '<div class="emp-list-empty">还没有员工<br><span style="font-size:11px;opacity:.6">点击"添加员工"按钮创建你的第一个 AI 员工</span></div>';
    return;
  }

  if (!filtered.length && _empSearchQuery) {
    container.innerHTML = '<div class="emp-list-empty">没有找到匹配的员工</div>';
    return;
  }

  // 分离 PM 区和员工区
  // ★ 开启自动协作 = isPM=true，PM 专区即自动协作员工
  const pmList = filtered.filter(e => e.isPM);
  const empList = filtered.filter(e => !e.isPM);

  // 渲染分区
  const appendSection = (title, list) => {
    if (!list.length) return;
    const header = document.createElement('div');
    header.className = 'emp-list-zone-header';
    header.textContent = title;
    container.appendChild(header);
    for (const emp of list) {
      container.appendChild(_buildListItem(emp));
    }
  };

  appendSection('PM 专区', pmList);
  appendSection('员工专区', empList);
}

/** 构建单个列表项 */
function _buildListItem(emp) {
  const st = (typeof _computeEmpStatus === 'function' ? STATUS_MAP[_computeEmpStatus(emp)] : null)
    || (typeof STATUS_MAP !== 'undefined' ? STATUS_MAP[emp.status] : null)
    || { label: '空闲', color: 'var(--muted)', bg: 'rgba(255,255,255,.05)', dot: 'var(--muted)', animated: false };
  const item = document.createElement('div');
  item.className = 'emp-list-item' + (emp.id === EMPLOYEE_STORE.selectedId ? ' emp-list-selected' : '');
  item.dataset.id = emp.id;
  item.draggable = true;

  const avatarHtml = (typeof getEmployeeAvatarHtml === 'function')
    ? getEmployeeAvatarHtml(emp, { size: 64, statusStyle: st, className: 'emp-list-avatar', animated: false })
    : `<div class="emp-list-avatar" style="background:${st.bg}"><span style="font-size:16px">${esc(emp.avatar || '🤖')}</span></div>`;

  item.innerHTML = `
    <div class="emp-list-drag-handle" title="拖拽排序">
      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="9" cy="6" r="1"/><circle cx="15" cy="6" r="1"/><circle cx="9" cy="12" r="1"/><circle cx="15" cy="12" r="1"/><circle cx="9" cy="18" r="1"/><circle cx="15" cy="18" r="1"/></svg>
    </div>
    ${avatarHtml}
    <div class="emp-list-info">
      <div class="emp-list-name">${esc(emp.name)}${emp.isPM ? ' <span class="emp-pm-badge" title="PM 专员（自动协作已开启）">PM</span>' : ''}</div>
      <div class="emp-list-role">${esc(emp.role)}</div>
    </div>
    <div class="emp-list-status">
      <span class="emp-status-dot${st.animated ? ' emp-dot-animated' : ''}" style="background:${st.dot}"></span>
      <span class="emp-status-label" style="color:${st.color}">${st.label}</span>
    </div>
    <button class="emp-list-menu-btn" onclick="event.stopPropagation();if(typeof _showCardMenu==='function')_showCardMenu(event,'${emp.id}')">⋯</button>
  `;

  // 点击选中
  item.addEventListener('click', () => {
    if (typeof selectEmployee === 'function') selectEmployee(emp.id, true);
  });

  // 双击名称重命名
  const nameEl = item.querySelector('.emp-list-name');
  if (nameEl) nameEl.ondblclick = (e) => {
    e.stopPropagation();
    if (typeof _startRenameEmployee === 'function') _startRenameEmployee(emp.id);
  };

  // 拖拽排序
  _initListItemDrag(item, emp);

  return item;
}

// ── 列表拖拽排序 ──────────────────────────────────────────────────────────

let _listDragSourceId = null;
let _listDragOverId = null;
let _listDragSide = null;  // 'before' | 'after'

function _initListItemDrag(item, emp) {
  item.addEventListener('dragstart', e => {
    if (e.target.closest('button')) { e.preventDefault(); return; }
    _listDragSourceId = emp.id;
    item.classList.add('emp-list-dragging');
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', emp.id);
  });

  item.addEventListener('dragend', () => {
    item.classList.remove('emp-list-dragging');
    _listDragSourceId = null;
    _listDragOverId = null;
    _listDragSide = null;
    document.querySelectorAll('.emp-list-drag-over-before, .emp-list-drag-over-after').forEach(el => {
      el.classList.remove('emp-list-drag-over-before', 'emp-list-drag-over-after');
    });
  });

  item.addEventListener('dragover', e => {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    if (!_listDragSourceId || _listDragSourceId === emp.id) return;

    const rect = item.getBoundingClientRect();
    const midY = rect.top + rect.height / 2;
    const side = e.clientY < midY ? 'before' : 'after';

    // 清除其他项的指示器
    document.querySelectorAll('.emp-list-drag-over-before, .emp-list-drag-over-after').forEach(el => {
      el.classList.remove('emp-list-drag-over-before', 'emp-list-drag-over-after');
    });

    item.classList.add('emp-list-drag-over-' + side);
    _listDragOverId = emp.id;
    _listDragSide = side;
  });

  item.addEventListener('dragleave', () => {
    item.classList.remove('emp-list-drag-over-before', 'emp-list-drag-over-after');
  });

  item.addEventListener('drop', e => {
    e.preventDefault();
    item.classList.remove('emp-list-drag-over-before', 'emp-list-drag-over-after');
    const sourceId = _listDragSourceId || e.dataTransfer.getData('text/plain');
    if (!sourceId || sourceId === emp.id) return;

    const sourceEmp = EMPLOYEE_STORE.employees.find(em => em.id === sourceId);
    const targetEmp = EMPLOYEE_STORE.employees.find(em => em.id === emp.id);
    if (!sourceEmp || !targetEmp) return;

    // 分区保护：非 PM（普通员工）不能进入 PM 专区
    if (!sourceEmp.isPM && targetEmp.isPM) return;

    // 在 EMPLOYEE_STORE.employees 数组中重排
    const srcIdx = EMPLOYEE_STORE.employees.findIndex(em => em.id === sourceId);
    const tgtIdx = EMPLOYEE_STORE.employees.findIndex(em => em.id === emp.id);
    if (srcIdx < 0 || tgtIdx < 0) return;

    const [moved] = EMPLOYEE_STORE.employees.splice(srcIdx, 1);
    const newTgtIdx = EMPLOYEE_STORE.employees.findIndex(em => em.id === emp.id);
    const insertIdx = _listDragSide === 'before' ? newTgtIdx : newTgtIdx + 1;
    EMPLOYEE_STORE.employees.splice(insertIdx, 0, moved);

    // 持久化
    if (typeof _saveEmployees === 'function') _saveEmployees();
    renderEmployeeList();
  });
}

