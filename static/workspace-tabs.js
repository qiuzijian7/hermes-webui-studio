/**
 * workspace-tabs.js — 中间工作区页签切换、画布自由拖动、文件目录
 */

// ── 页签切换 ─────────────────────────────────────────────────────────────────
let _activeWorkspaceTab = 'canvas';

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
  const fileToolbarInline = $('fileToolbarInline');

  if (tab === 'canvas') {
    if (canvasContent) canvasContent.classList.add('active');
    if (filesContent) filesContent.classList.remove('active');
    if (empToolbarInline) empToolbarInline.style.display = '';
    if (fileToolbarInline) fileToolbarInline.style.display = 'none';
  } else {
    if (canvasContent) canvasContent.classList.remove('active');
    if (filesContent) filesContent.classList.add('active');
    if (empToolbarInline) empToolbarInline.style.display = 'none';
    if (fileToolbarInline) fileToolbarInline.style.display = '';
    // 加载文件目录
    _renderMainFileTree();
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
    // 不拦截按钮和输入框
    if (e.target.closest('button') || e.target.closest('input') || e.target.closest('.emp-card-menu-btn')) return;
    if (e.button !== 0) return;
    e.preventDefault();
    startDrag(e.clientX, e.clientY);
    document.addEventListener('mousemove', onMouseMove);
    document.addEventListener('mouseup', onMouseUp);
  }

  function onTouchStart(e) {
    if (e.target.closest('button') || e.target.closest('input')) return;
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

  function moveDrag(clientX, clientY) {
    const dx = clientX - startX;
    const dy = clientY - startY;
    if (!isDragging && (Math.abs(dx) > 3 || Math.abs(dy) > 3)) {
      isDragging = true;
      card.classList.add('emp-dragging-free');
    }
    if (!isDragging) return;

    const canvas = $('employeeCanvas');
    const maxX = Math.max(0, canvas.scrollWidth - card.offsetWidth);
    const maxY = Math.max(0, canvas.scrollHeight - card.offsetHeight);
    const newX = Math.max(0, Math.min(maxX, origX + dx));
    const newY = Math.max(0, Math.min(maxY, origY + dy));

    card.style.left = newX + 'px';
    card.style.top = newY + 'px';
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
    const cols = Math.max(1, Math.floor(($('employeeCanvas')?.clientWidth || 800) / 264));
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

  // 如果没有会话，显示空状态
  if (!S.session) {
    container.innerHTML = `
      <div class="main-file-empty">
        <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></svg>
        <span>请先创建或选择会话</span>
      </div>`;
    return;
  }

  // 渲染面包屑到页签工具栏
  _renderMainBreadcrumb();

  // 渲染文件树
  const entries = S.entries || [];
  container.innerHTML = '';
  _renderMainTreeItems(container, entries, 0);
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
    return;
  }

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

function _renderMainTreeItems(container, entries, depth) {
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
              const data = await api(`/api/list?session_id=${encodeURIComponent(S.session.session_id)}&path=${encodeURIComponent(item.path)}`);
              S._dirCache[item.path] = data.entries || [];
            } catch (e) { S._dirCache[item.path] = []; }
          }
        }
        if (typeof _saveExpandedDirs === 'function') _saveExpandedDirs();
        _renderMainFileTree();
      };
    } else {
      el.onclick = () => {
        // 切换到画布视图并打开文件预览
        if (typeof openFile === 'function') openFile(item.path);
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
  const canvas = $('employeeCanvas');
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
    // 重新绑定操作按钮
    clone.querySelectorAll('.emp-action-btn').forEach(btn => {
      const title = btn.getAttribute('title');
      if (title === '对话') btn.onclick = (e) => { e.stopPropagation(); selectEmployee(emp.id); };
    });

    _positionCard(clone, emp);
    _initFreeDrag(clone, emp);
    canvas.appendChild(clone);
  }
}

// ── 监听文件目录数据刷新 ─────────────────────────────────────────────────────
// 覆盖 renderFileTree 以同时刷新中间面板的文件目录
(function() {
  const _origRenderFileTree = typeof renderFileTree === 'function' ? renderFileTree : null;
  window.renderFileTree = function() {
    if (_origRenderFileTree) _origRenderFileTree();
    if (_activeWorkspaceTab === 'files') {
      _renderMainFileTree();
    }
  };
})();

// ── 初始化 ────────────────────────────────────────────────────────────────────
function initWorkspaceTabs() {
  // 恢复上次的页签状态
  const saved = localStorage.getItem('hermes-workspace-tab');
  if (saved === 'files') {
    switchWorkspaceTab('files');
  }
}
