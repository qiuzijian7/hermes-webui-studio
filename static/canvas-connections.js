/**
 * canvas-connections.js — 画布连线功能：员工之间 subagent 关系可视化
 *
 * 功能：
 * 1. SVG 连线层：在画布上绘制从 A（manager）到 B（subagent）的贝塞尔曲线
 * 2. 拖拽创建连线：从员工卡片底部的连接点拖拽到另一个员工
 * 3. 连线数据持久化：与员工数据一起存储在 localStorage
 * 4. 连线交互：hover 高亮、右键删除、点击查看关系详情
 */

// ── 连线数据存储 ────────────────────────────────────────────────────────────

/** 连线数据结构：{ id, from (manager empId), to (subagent empId), label } */
let _connections = [];

/** 当前选中的连线 ID（用于 Delete 键删除） */
let _selectedConnId = null;

/** 当前是否处于连线创建模式 */
let _isDrawingConnection = false;
let _drawFromEmpId = null;
let _drawFromEl = null;
let _tempLineEl = null;

// ── 持久化 ──────────────────────────────────────────────────────────────────

function _connStorageKey() {
  return 'hermes-connections:' + (typeof _currentWsKey === 'function' ? _currentWsKey() : '__default__');
}

function _saveConnections() {
  try {
    localStorage.setItem(_connStorageKey(), JSON.stringify(_connections));
  } catch (e) {
    console.error('[_saveConnections] localStorage 写入失败:', e);
  }
}

function _loadConnections() {
  try {
    const raw = localStorage.getItem(_connStorageKey());
    _connections = raw ? JSON.parse(raw) : [];
  } catch (e) {
    _connections = [];
  }
}

// ── 连线 CRUD ──────────────────────────────────────────────────────────────

function addConnection(fromEmpId, toEmpId, label = '') {
  // 防止重复
  if (_connections.some(c => c.from === fromEmpId && c.to === toEmpId)) return null;
  // 防止自连
  if (fromEmpId === toEmpId) return null;
  // 防止循环（B 不能是 A 的 manager，如果 A 已经是 B 的 subagent）
  if (wouldCreateCycle(fromEmpId, toEmpId)) {
    showToast('无法创建循环依赖关系');
    return null;
  }

  const conn = {
    id: 'conn-' + Date.now() + '-' + Math.random().toString(36).slice(2, 6),
    from: fromEmpId,
    to: toEmpId,
    label: label || '',
  };
  _connections.push(conn);
  _saveConnections();

  // 更新员工的 subagentOf 字段
  const toEmp = getEmployee(toEmpId);
  if (toEmp) {
    toEmp.subagentOf = fromEmpId;
    if (typeof _saveEmployees === 'function') _saveEmployees();
  }

  // 同步 system prompt 到后端 session（subagent 关系会影响 prompt）
  if (typeof _syncEmployeePromptToSession === 'function') {
    if (toEmp) _syncEmployeePromptToSession(toEmp);
    const fromEmp = getEmployee(fromEmpId);
    if (fromEmp) _syncEmployeePromptToSession(fromEmp);
  }

  renderConnections();
  return conn;
}

function removeConnection(connId) {
  const idx = _connections.findIndex(c => c.id === connId);
  if (idx < 0) return;
  const conn = _connections[idx];

  // 清除员工的 subagentOf 字段
  const toEmp = getEmployee(conn.to);
  if (toEmp && toEmp.subagentOf === conn.from) {
    toEmp.subagentOf = null;
    if (typeof _saveEmployees === 'function') _saveEmployees();
  }

  // 同步 system prompt
  if (typeof _syncEmployeePromptToSession === 'function') {
    if (toEmp) _syncEmployeePromptToSession(toEmp);
    const fromEmp = getEmployee(conn.from);
    if (fromEmp) _syncEmployeePromptToSession(fromEmp);
  }

  // 清除选中状态
  if (_selectedConnId === connId) _selectedConnId = null;

  _connections.splice(idx, 1);
  _saveConnections();
  renderConnections();
}

function removeConnectionsForEmployee(empId) {
  _connections = _connections.filter(c => c.from !== empId && c.to !== empId);
  _saveConnections();
}

function wouldCreateCycle(fromEmpId, toEmpId) {
  // 检查从 toEmpId 沿着 from 链是否能回到 fromEmpId
  let current = fromEmpId;
  const visited = new Set();
  while (current) {
    if (current === toEmpId) return true;
    if (visited.has(current)) return false; // 已经存在环（不应发生）
    visited.add(current);
    const conn = _connections.find(c => c.to === current);
    current = conn ? conn.from : null;
  }
  return false;
}

function getSubagentsOf(empId) {
  return _connections.filter(c => c.from === empId).map(c => ({
    ...c,
    employee: getEmployee(c.to),
  }));
}

function getManagerOf(empId) {
  const conn = _connections.find(c => c.to === empId);
  if (!conn) return null;
  return { ...conn, employee: getEmployee(conn.from) };
}

// ── SVG 渲染 ───────────────────────────────────────────────────────────────

function renderConnections() {
  const svg = $('canvasConnectionsSvg');
  if (!svg) return;

  // 清空
  svg.innerHTML = '';

  // SVG 不拦截底层鼠标事件（CSS 已设置 pointer-events:none, z-index 低于卡片）
  // 保持 CSS 尺寸控制，不覆盖

  // 定义箭头标记
  const defs = document.createElementNS('http://www.w3.org/2000/svg', 'defs');
  defs.innerHTML = `
    <marker id="conn-arrow" viewBox="0 0 10 10" refX="9" refY="5"
            markerWidth="6" markerHeight="6" orient="auto-start-reverse"
            fill="var(--blue)" opacity="0.6">
      <path d="M 0 0 L 10 5 L 0 10 z"/>
    </marker>
    <marker id="conn-arrow-hover" viewBox="0 0 10 10" refX="9" refY="5"
            markerWidth="6" markerHeight="6" orient="auto-start-reverse"
            fill="var(--blue)" opacity="1">
      <path d="M 0 0 L 10 5 L 0 10 z"/>
    </marker>
  `;
  svg.appendChild(defs);

  for (const conn of _connections) {
    const fromCard = document.querySelector(`.emp-card[data-id="${conn.from}"]`);
    const toCard = document.querySelector(`.emp-card[data-id="${conn.to}"]`);
    if (!fromCard || !toCard) continue;

    const line = _createConnectionLine(fromCard, toCard, conn);
    svg.appendChild(line);
  }
}

function _createConnectionLine(fromCard, toCard, conn) {
  const from = _getCardAnchor(fromCard, 'bottom');
  const to = _getCardAnchor(toCard, 'top');

  // 贝塞尔曲线控制点
  const dy = Math.abs(to.y - from.y);
  const cpOffset = Math.max(40, dy * 0.4);
  const d = `M ${from.x} ${from.y} C ${from.x} ${from.y + cpOffset}, ${to.x} ${to.y - cpOffset}, ${to.x} ${to.y}`;

  const g = document.createElementNS('http://www.w3.org/2000/svg', 'g');
  g.classList.add('conn-group');
  g.dataset.connId = conn.id;
  g.style.pointerEvents = 'auto';

  // 不可见的宽点击区域
  const hitArea = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  hitArea.setAttribute('d', d);
  hitArea.setAttribute('stroke', 'transparent');
  hitArea.setAttribute('stroke-width', '16');
  hitArea.setAttribute('fill', 'none');
  hitArea.style.cursor = 'pointer';
  hitArea.style.pointerEvents = 'stroke';

  // 可见线条
  const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  path.setAttribute('d', d);
  path.setAttribute('stroke', 'var(--blue)');
  path.setAttribute('stroke-width', '2');
  path.setAttribute('fill', 'none');
  path.setAttribute('marker-end', 'url(#conn-arrow)');
  path.setAttribute('opacity', '0.5');
  path.classList.add('conn-line');

  // 动画虚线（表示数据流方向）
  const animPath = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  animPath.setAttribute('d', d);
  animPath.setAttribute('stroke', 'var(--blue)');
  animPath.setAttribute('stroke-width', '1');
  animPath.setAttribute('fill', 'none');
  animPath.setAttribute('stroke-dasharray', '4 6');
  animPath.setAttribute('opacity', '0.3');
  animPath.classList.add('conn-flow');
  // CSS 动画驱动虚线流动
  animPath.style.animation = 'conn-flow 1.5s linear infinite';

  // 标签
  if (conn.label) {
    const midX = (from.x + to.x) / 2;
    const midY = (from.y + to.y) / 2;
    const text = document.createElementNS('http://www.w3.org/2000/svg', 'text');
    text.setAttribute('x', midX);
    text.setAttribute('y', midY - 8);
    text.setAttribute('text-anchor', 'middle');
    text.setAttribute('fill', 'var(--muted)');
    text.setAttribute('font-size', '11');
    text.textContent = conn.label;
    g.appendChild(text);
  }

  g.appendChild(animPath);
  g.appendChild(path);
  g.appendChild(hitArea);

  // 交互：hover 高亮
  g.addEventListener('mouseenter', () => {
    if (_selectedConnId !== conn.id) {
      path.setAttribute('opacity', '1');
      path.setAttribute('stroke-width', '2.5');
      path.setAttribute('marker-end', 'url(#conn-arrow-hover)');
      animPath.setAttribute('opacity', '0.6');
    }
    fromCard.classList.add('conn-highlight');
    toCard.classList.add('conn-highlight');
  });
  g.addEventListener('mouseleave', () => {
    if (_selectedConnId !== conn.id) {
      path.setAttribute('opacity', '0.5');
      path.setAttribute('stroke-width', '2');
      path.setAttribute('marker-end', 'url(#conn-arrow)');
      animPath.setAttribute('opacity', '0.3');
    }
    fromCard.classList.remove('conn-highlight');
    toCard.classList.remove('conn-highlight');
  });

  // 右键删除
  g.addEventListener('contextmenu', async (e) => {
    e.preventDefault();
    e.stopPropagation();
    const ok = typeof showConfirmDialog === 'function'
      ? await showConfirmDialog({ title: '删除关系', message: `删除「${getEmployee(conn.from)?.name || '?'}」→「${getEmployee(conn.to)?.name || '?'}」的 subagent 关系？`, confirmLabel: '删除', danger: true, focusCancel: true })
      : confirm(`删除「${getEmployee(conn.from)?.name || '?'}」→「${getEmployee(conn.to)?.name || '?'}」的 subagent 关系？`);
    if (ok) {
      if (_selectedConnId === conn.id) _selectedConnId = null;
      removeConnection(conn.id);
    }
  });

  // 点击选中连线
  g.addEventListener('click', (e) => {
    e.stopPropagation();
    if (_selectedConnId === conn.id) {
      // 再次点击同一连线 → 取消选中并显示详情
      _selectedConnId = null;
      _updateConnectionSelection();
      _showConnectionTooltip(conn, e);
    } else {
      _selectedConnId = conn.id;
      _hideConnectionTooltip();
      _updateConnectionSelection();
    }
  });

  return g;
}

function _getCardAnchor(card, side) {
  const zoomLayer = $('canvasZoomLayer');
  if (!zoomLayer) return { x: 0, y: 0 };

  // 卡片和 SVG 都在 zoomLayer 内部，使用 offsetLeft/offsetTop 递归累加到 zoomLayer
  let x = 0, y = 0;
  let el = card;
  while (el && el !== zoomLayer) {
    x += el.offsetLeft;
    y += el.offsetTop;
    el = el.offsetParent;
    // 防御性检查：如果 offsetParent 链断裂，退出
    if (!el) break;
  }

  const w = card.offsetWidth;
  const h = card.offsetHeight;
  switch (side) {
    case 'top': return { x: x + w / 2, y: y };
    case 'bottom': return { x: x + w / 2, y: y + h };
    default: return { x: x + w / 2, y: y + h / 2 };
  }
}

// ── 连线选中状态视觉更新 ──────────────────────────────────────────────────────

function _updateConnectionSelection() {
  const svg = $('canvasConnectionsSvg');
  if (!svg) return;
  svg.querySelectorAll('.conn-group').forEach(g => {
    const connId = g.dataset.connId;
    const path = g.querySelector('path:not([stroke="transparent"])');
    const animPath = g.querySelector('path + path');
    if (connId === _selectedConnId) {
      // 选中状态：明亮 + 粗线
      if (path) {
        path.setAttribute('opacity', '1');
        path.setAttribute('stroke-width', '3');
        path.setAttribute('stroke', 'var(--accent)');
        path.setAttribute('marker-end', 'url(#conn-arrow-hover)');
      }
      if (animPath) animPath.setAttribute('opacity', '0.7');
      g.classList.add('conn-selected');
    } else {
      // 默认状态
      if (path) {
        path.setAttribute('opacity', '0.5');
        path.setAttribute('stroke-width', '2');
        path.setAttribute('stroke', 'var(--blue)');
        path.setAttribute('marker-end', 'url(#conn-arrow)');
      }
      if (animPath) animPath.setAttribute('opacity', '0.3');
      g.classList.remove('conn-selected');
    }
  });
}

// ── 连线提示框 ──────────────────────────────────────────────────────────────

let _connTooltip = null;

function _showConnectionTooltip(conn, event) {
  _hideConnectionTooltip();
  const fromEmp = getEmployee(conn.from);
  const toEmp = getEmployee(conn.to);

  const div = document.createElement('div');
  div.className = 'conn-tooltip';
  div.innerHTML = `
    <div class="conn-tooltip-header">
      <span class="conn-tooltip-manager">${esc(fromEmp?.name || '?')}</span>
      <span class="conn-tooltip-arrow">→</span>
      <span class="conn-tooltip-subagent">${esc(toEmp?.name || '?')}</span>
    </div>
    <div class="conn-tooltip-desc">${esc(fromEmp?.name || '?')} 是 ${esc(toEmp?.name || '?')} 的管理者（manager）</div>
    ${conn.label ? `<div class="conn-tooltip-label">${esc(conn.label)}</div>` : ''}
    <div class="conn-tooltip-actions">
      <button class="conn-tooltip-btn" onclick="removeConnection('${conn.id}');_hideConnectionTooltip()">删除关系</button>
      <button class="conn-tooltip-btn" onclick="selectEmployee('${conn.to}');_hideConnectionTooltip()">查看 ${esc(toEmp?.name || '员工')}</button>
    </div>
  `;
  document.body.appendChild(div);
  _connTooltip = div;

  // 定位
  const x = event.clientX + 12;
  const y = event.clientY + 12;
  div.style.left = Math.min(x, window.innerWidth - 250) + 'px';
  div.style.top = Math.min(y, window.innerHeight - 150) + 'px';
}

function _hideConnectionTooltip() {
  if (_connTooltip) {
    _connTooltip.remove();
    _connTooltip = null;
  }
}

// ── 拖拽创建连线 ──────────────────────────────────────────────────────────

function initConnectionDrag() {
  const canvas = $('employeeCanvas');
  if (!canvas) return;

  // 监听连接点 mousedown（事件委托）
  canvas.addEventListener('mousedown', (e) => {
    const handle = e.target.closest('.emp-conn-handle');
    if (!handle) return;
    e.preventDefault();
    e.stopPropagation();

    const card = handle.closest('.emp-card');
    if (!card) return;

    _isDrawingConnection = true;
    _drawFromEmpId = card.dataset.id;
    _drawFromEl = card;

    // 创建临时线条
    const svg = $('canvasConnectionsSvg');
    if (svg) {
      _tempLineEl = document.createElementNS('http://www.w3.org/2000/svg', 'line');
      _tempLineEl.setAttribute('stroke', 'var(--blue)');
      _tempLineEl.setAttribute('stroke-width', '2');
      _tempLineEl.setAttribute('stroke-dasharray', '6 4');
      _tempLineEl.setAttribute('opacity', '0.6');
      svg.appendChild(_tempLineEl);
    }
  });

  document.addEventListener('mousemove', (e) => {
    if (!_isDrawingConnection || !_tempLineEl || !_drawFromEl) return;

    const from = _getCardAnchor(_drawFromEl, 'bottom');
    // 鼠标位置转为 SVG 逻辑坐标：视口坐标 → zoomLayer 逻辑坐标
    const zoomLayer = $('canvasZoomLayer');
    if (!zoomLayer) return;
    const layerRect = zoomLayer.getBoundingClientRect();
    const zoom = typeof _canvasZoomLevel !== 'undefined' ? _canvasZoomLevel : 1;
    const toX = (e.clientX - layerRect.left) / zoom;
    const toY = (e.clientY - layerRect.top) / zoom;

    _tempLineEl.setAttribute('x1', from.x);
    _tempLineEl.setAttribute('y1', from.y);
    _tempLineEl.setAttribute('x2', toX);
    _tempLineEl.setAttribute('y2', toY);
  });

  document.addEventListener('mouseup', (e) => {
    if (!_isDrawingConnection) return;
    _isDrawingConnection = false;

    // 先移除临时线，避免 elementFromPoint 命中线条而非目标卡片
    if (_tempLineEl) {
      _tempLineEl.remove();
      _tempLineEl = null;
    }

    // 检查是否释放在某个员工卡片上
    const targetEl = document.elementFromPoint(e.clientX, e.clientY);
    const targetCard = targetEl?.closest('.emp-card');
    if (targetCard && targetCard.dataset.id !== _drawFromEmpId) {
      const toEmpId = targetCard.dataset.id;
      const conn = addConnection(_drawFromEmpId, toEmpId);
      if (conn) {
        const fromName = getEmployee(_drawFromEmpId)?.name || '?';
        const toName = getEmployee(toEmpId)?.name || '?';
        showToast(`已建立关系：${fromName} → ${toName}（subagent）`);
      }
    }

    _drawFromEmpId = null;
    _drawFromEl = null;
  });
}

// ── 连接点渲染 ─────────────────────────────────────────────────────────────
// 在员工卡片底部添加连接点，需要在 renderEmployeeCards 后调用

function _addConnHandlesToCards() {
  document.querySelectorAll('.emp-card').forEach(card => {
    if (card.querySelector('.emp-conn-handle')) return;

    const handle = document.createElement('div');
    handle.className = 'emp-conn-handle';
    handle.title = '拖拽到另一个员工以创建 subagent 关系';
    handle.innerHTML = `<svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.5"><circle cx="6" cy="6" r="4"/><line x1="6" y1="2" x2="6" y2="10"/><line x1="2" y1="6" x2="10" y2="6"/></svg>`;
    card.appendChild(handle);
  });
}

// ── 连线状态指示器 ──────────────────────────────────────────────────────────
// 在员工卡片上显示 subagent 徽标

function _updateConnBadges() {
  document.querySelectorAll('.emp-card').forEach(card => {
    const empId = card.dataset.id;
    const existing = card.querySelector('.emp-subagent-badge');

    const isManager = _connections.some(c => c.from === empId);
    const isSubagent = _connections.some(c => c.to === empId);

    if (isManager || isSubagent) {
      if (!existing) {
        const badge = document.createElement('div');
        badge.className = 'emp-subagent-badge';
        card.appendChild(badge);
      }
      const badge = card.querySelector('.emp-subagent-badge');
      if (isManager && isSubagent) {
        badge.className = 'emp-subagent-badge both';
        badge.title = '既是管理者又是下属';
      } else if (isManager) {
        badge.className = 'emp-subagent-badge manager';
        badge.title = '管理者（有下属员工）';
      } else {
        badge.className = 'emp-subagent-badge subagent';
        badge.title = '下属（有管理者）';
      }
    } else if (existing) {
      existing.remove();
    }
  });
}

// ── 公共刷新接口 ────────────────────────────────────────────────────────────

function refreshConnections() {
  renderConnections();
  _addConnHandlesToCards();
  _updateConnBadges();
}

// ── 委派历史 API ──────────────────────────────────────────────────────────

/** 获取指定员工的委派历史（从后端 API），返回 Promise<array> */
async function fetchDelegationHistory(empId) {
  const emp = typeof getEmployee === 'function' ? getEmployee(empId) : null;
  if (!emp || !emp.sessionId) return [];

  try {
    const data = await api(`/api/delegation/children?session_id=${encodeURIComponent(emp.sessionId)}`);
    return data.children || [];
  } catch (e) {
    return [];
  }
}

/** 获取完整委派树，返回 Promise<obj> */
async function fetchDelegationTree(empId) {
  const emp = typeof getEmployee === 'function' ? getEmployee(empId) : null;
  if (!emp || !emp.sessionId) return null;

  try {
    const data = await api(`/api/delegation/history?session_id=${encodeURIComponent(emp.sessionId)}`);
    return data.tree || null;
  } catch (e) {
    return null;
  }
}

// ── 手动保存画布数据（连线 + 员工） ──────────────────────────────────────────

function saveCanvasData() {
  if (typeof _saveConnections === 'function') _saveConnections();
  if (typeof _saveEmployees === 'function') _saveEmployees();
  if (typeof showToast === 'function') showToast('已保存画布状态', 1500);
}

// ── 初始化 ──────────────────────────────────────────────────────────────────

function initCanvasConnections() {
  _loadConnections();
  renderConnections();
  initConnectionDrag();
}

// 页面加载后自动初始化（仅加载连线数据；渲染延迟到 renderEmployeeCards 中调用 refreshConnections）
document.addEventListener('DOMContentLoaded', () => {
  _loadConnections();
  initConnectionDrag();
});

// Ctrl+S 快捷键保存画布状态
document.addEventListener('keydown', (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key === 's') {
    // 仅在画布模式下拦截
    if (typeof _activeWorkspaceTab !== 'undefined' && _activeWorkspaceTab === 'canvas') {
      e.preventDefault();
      saveCanvasData();
    }
  }
});

// 点击空白处关闭 tooltip + 取消连线选中
document.addEventListener('click', (e) => {
  if (_connTooltip && !e.target.closest('.conn-tooltip')) {
    _hideConnectionTooltip();
  }
  // 点击非连线区域时取消连线选中
  if (_selectedConnId && !e.target.closest('.conn-group')) {
    _selectedConnId = null;
    _updateConnectionSelection();
  }
});

// ── Delete 键删除选中的连线或员工 ────────────────────────────────────────────
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Delete' && e.key !== 'Backspace') return;
  // 如果焦点在输入框/文本框中，不拦截
  const tag = (e.target.tagName || '').toLowerCase();
  if (tag === 'input' || tag === 'textarea' || tag === 'select' || e.target.isContentEditable) return;

  // 1. 删除选中的连线
  if (_selectedConnId) {
    e.preventDefault();
    const conn = _connections.find(c => c.id === _selectedConnId);
    if (conn) {
      const fromName = getEmployee(conn.from)?.name || '?';
      const toName = getEmployee(conn.to)?.name || '?';
      const doDelete = async () => {
        const ok = typeof showConfirmDialog === 'function'
          ? await showConfirmDialog({ title: '删除关系', message: `删除「${fromName}」→「${toName}」的 subagent 关系？`, confirmLabel: '删除', danger: true, focusCancel: true })
          : confirm(`删除「${fromName}」→「${toName}」的 subagent 关系？`);
        if (ok) {
          const id = _selectedConnId;
          _selectedConnId = null;
          removeConnection(id);
        }
      };
      doDelete();
    }
    return;
  }

  // 2. 删除选中的员工卡片
  if (typeof EMPLOYEE_STORE !== 'undefined' && EMPLOYEE_STORE.selectedId && _activeWorkspaceTab === 'canvas') {
    e.preventDefault();
    const emp = typeof getEmployee === 'function' ? getEmployee(EMPLOYEE_STORE.selectedId) : null;
    if (emp) {
      const doDelete = async () => {
        const ok = typeof showConfirmDialog === 'function'
          ? await showConfirmDialog({ title: '删除员工', message: `删除员工「${emp.name}」？此操作不可撤销。`, confirmLabel: '删除', danger: true, focusCancel: true })
          : confirm(`删除员工「${emp.name}」？此操作不可撤销。`);
        if (ok) {
          typeof deleteEmployee === 'function' && deleteEmployee(EMPLOYEE_STORE.selectedId);
        }
      };
      doDelete();
    }
  }
});
