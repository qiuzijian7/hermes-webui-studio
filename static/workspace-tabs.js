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

  // ── 滚轮缩放 — 以鼠标位置为中心 ──
  canvas.addEventListener('wheel', (e) => {
    if (e.target.closest('.main-file-tree')) return;
    e.preventDefault();

    const delta = e.deltaY > 0 ? -1 : 1;
    const oldZoom = _canvasZoomLevel;
    _stepZoomLevel(delta);
    const newZoom = _canvasZoomLevel;

    if (oldZoom !== newZoom) {
      const rect = canvas.getBoundingClientRect();
      const pivotX = e.clientX - rect.left;
      const pivotY = e.clientY - rect.top;
      _zoomAroundPoint(pivotX, pivotY, oldZoom, newZoom);
      _applyCanvasTransform();
    }
  }, { passive: false });

  // ── 右键拖动平移画布 ──
  let _panning = false;
  let _panStartX = 0, _panStartY = 0;
  let _panOriginX = 0, _panOriginY = 0;

  canvas.addEventListener('contextmenu', (e) => {
    if (!e.target.closest('.emp-card')) {
      e.preventDefault();
    }
  });

  canvas.addEventListener('mousedown', (e) => {
    if (e.button === 2 && !e.target.closest('.emp-card')) {
      _panning = true;
      _panStartX = e.clientX;
      _panStartY = e.clientY;
      _panOriginX = _canvasPanX;
      _panOriginY = _canvasPanY;
      canvas.style.cursor = 'grabbing';
      e.preventDefault();
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
    if (e.button === 2 && _panning) {
      _panning = false;
      canvas.style.cursor = '';
    }
  });

  // ── 中键拖动平移画布 ──
  canvas.addEventListener('mousedown', (e) => {
    if (e.button === 1) {
      _panning = true;
      _panStartX = e.clientX;
      _panStartY = e.clientY;
      _panOriginX = _canvasPanX;
      _panOriginY = _canvasPanY;
      canvas.style.cursor = 'grabbing';
      e.preventDefault();
    }
  });

  document.addEventListener('mouseup', (e) => {
    if (e.button === 1 && _panning) {
      _panning = false;
      canvas.style.cursor = '';
    }
  });
}

// ── 工作区选择下拉框 ──────────────────────────────────────────────────────────
let _wsSelectorList = [];

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
    });
  }
}

function closeWsSelector() {
  const dd = $('wsSelectorDropdown');
  if (dd) dd.classList.remove('open');
}

function _renderWsSelectorDropdown(dd) {
  if (!dd) return;
  const currentWs = (typeof _currentCanvasWorkspace !== 'undefined' ? _currentCanvasWorkspace : '') || S.session?.workspace || '';
  dd.innerHTML = '';

  for (const w of _wsSelectorList) {

    const opt = document.createElement('div');
    opt.className = 'ws-opt' + (w.path === currentWs ? ' active' : '');
    opt.innerHTML = `<span class="ws-opt-name">${esc(w.name)}</span><span class="ws-opt-path" title="${esc(w.path)}">${esc(w.path)}</span>`;
    opt.onclick = () => {
      closeWsSelector();
      if (w.path !== currentWs && typeof switchToWorkspace === 'function') {
        switchToWorkspace(w.path, w.name);
      }
    };
    dd.appendChild(opt);
  }

  // 添加工作区选项
  dd.appendChild(Object.assign(document.createElement('div'), { className: 'ws-divider' }));
  const addAction = document.createElement('div');
  addAction.className = 'ws-opt ws-opt-action';
  addAction.innerHTML = `<span class="ws-opt-name">+ 添加工作区路径</span>`;
  addAction.onclick = () => {
    closeWsSelector();
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
  if (!e.target.closest('#wsSelectorWrap')) closeWsSelector();
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
  const empToolbarInline = $('empToolbarInline');

  if (tab === 'canvas') {
    if (canvasContent) canvasContent.classList.add('active');
    if (filesContent) filesContent.classList.remove('active');
    if (empToolbarInline) empToolbarInline.style.display = '';
    const zoomControls = $('canvasZoomControls');
    if (zoomControls) zoomControls.style.display = '';
    const fileTabRefresh = $('fileTabRefreshBtn');
    if (fileTabRefresh) fileTabRefresh.classList.remove('visible');
  } else {
    if (canvasContent) canvasContent.classList.remove('active');
    if (filesContent) filesContent.classList.add('active');
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

// ── 画布自由拖动 ─────────────────────────────────────────────────────────────

/** 为员工卡片在画布上设置自由拖动 */
function _initFreeDrag(card, emp) {
  let isDragging = false;
  let startX, startY, origX, origY;

  card.addEventListener('mousedown', onMouseDown);
  card.addEventListener('touchstart', onTouchStart, { passive: false });

  function onMouseDown(e) {
    // 不拦截按钮、输入框和连接手柄
    if (e.target.closest('button') || e.target.closest('input') || e.target.closest('.emp-card-menu-btn') || e.target.closest('.emp-conn-handle')) return;
    if (e.button !== 0) return;
    e.preventDefault();
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
    startX = clientX;
    startY = clientY;
    const style = card.style;
    origX = parseInt(style.left) || card.offsetLeft || 0;
    origY = parseInt(style.top) || card.offsetTop || 0;
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
    }
    if (!isDragging) return;

    const newX = Math.max(0, origX + dx);
    const newY = Math.max(0, origY + dy);

    card.style.left = newX + 'px';
    card.style.top = newY + 'px';

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
      // 保存位置到员工数据
      const x = parseInt(card.style.left) || 0;
      const y = parseInt(card.style.top) || 0;
      const emp = getEmployee(card.dataset.id);
      if (emp) {
        emp._pos = { x, y };
        _saveEmployees();
      }
      // 拖拽结束后刷新连线
      if (typeof refreshConnections === 'function') refreshConnections();
    }
    isDragging = false;
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

  if (!S.currentDir || S.currentDir === '.') {
    const root = document.createElement('span');
    root.className = 'breadcrumb-seg breadcrumb-current';
    root.textContent = '~';
    bar.appendChild(root);
  } else {
    // Root
    const root = document.createElement('span');
    root.className = 'breadcrumb-seg breadcrumb-link';
    root.textContent = '~';
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
  const canvas = $('canvasZoomLayer') || $('employeeCanvas');
  const empty = $('employeeEmptyState');
  if (!canvas) return;

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
      if (title === '对话') btn.onclick = (e) => { e.stopPropagation(); selectEmployee(emp.id); };
    });

    _positionCard(clone, emp);
    _initFreeDrag(clone, emp);
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
    if (_activeWorkspaceTab === 'files') {
      // 主面板文件页签激活时，只渲染主面板树，跳过旧版侧边栏渲染
      _renderMainFileTree();
    } else if (_origRenderFileTree) {
      _origRenderFileTree();
    }
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
  }
  // 初始化画布缩放
  _initCanvasZoom();
  // 初始化工作区选择器标签
  syncWsSelectorLabel();
}

