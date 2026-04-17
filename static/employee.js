/**
 * employee.js — 员工卡片渲染、拖拽、状态管理
 * 参考 OpenOffice 的 office-store 架构
 */

// ── 员工数据模型 ────────────────────────────────────────────────────────────
const EMPLOYEE_STORE = {
  employees: [],
  selectedId: null,
  _nextId: 1,
};

const EMPLOYEE_AVATARS = [
  '🤖', '👩‍💻', '🧑‍🔬', '👨‍🎨', '👩‍🔧', '🧙‍♂️', '🦊', '🐱', '🐶', '🦁',
  '🐼', '🦄', '🐸', '🦉', '🐝', '🧑‍🚀', '🥷', '🧑‍🍳', '👨‍⚕️', '👩‍🏫'
];

const EMPLOYEE_ROLES = [
  '通用助手', '代码工程师', '数据分析师', '内容创作者',
  '测试专家', '运维工程师', '产品经理', '设计顾问',
  '架构师', '安全专家', 'DBA', 'AI 工程师',
];

const STATUS_MAP = {
  idle:     { label: '空闲',   color: 'var(--muted)',  bg: 'rgba(255,255,255,.05)', dot: 'var(--muted)',  animated: false },
  working:  { label: '工作中', color: '#4ade80',        bg: 'rgba(74,222,128,.08)',  dot: '#4ade80',       animated: true  },
  thinking: { label: '思考中', color: 'var(--blue)',    bg: 'rgba(124,185,255,.08)', dot: 'var(--blue)',   animated: true  },
  error:    { label: '出错',   color: 'var(--accent)',  bg: 'rgba(233,69,96,.08)',   dot: 'var(--accent)', animated: false },
  offline:  { label: '离线',   color: 'var(--muted)',   bg: 'rgba(255,255,255,.02)', dot: 'rgba(255,255,255,.2)', animated: false },
};

// ── 当前画布绑定的工作区路径 ──────────────────────────────────────────────
// 每个工作区拥有独立的员工画布。切换工作区时保存/加载对应数据。
let _currentCanvasWorkspace = '';  // 当前画布绑定的工作区路径

/** 返回带工作区前缀的 localStorage key */
function _wsEmployeeKey(wsPath) {
  const ws = wsPath || _currentCanvasWorkspace || '__default__';
  return 'hermes-employees:' + ws;
}
function _wsNextIdKey(wsPath) {
  const ws = wsPath || _currentCanvasWorkspace || '__default__';
  return 'hermes-employees-nextid:' + ws;
}

// ── 持久化（按工作区） ──────────────────────────────────────────────────────
function _saveEmployees() {
  try {
    localStorage.setItem(_wsEmployeeKey(), JSON.stringify(EMPLOYEE_STORE.employees));
    localStorage.setItem(_wsNextIdKey(), String(EMPLOYEE_STORE._nextId));
  } catch(e) {}
}

function _loadEmployees() {
  try {
    const raw = localStorage.getItem(_wsEmployeeKey());
    if (raw) {
      EMPLOYEE_STORE.employees = JSON.parse(raw);
    } else {
      EMPLOYEE_STORE.employees = [];
    }
    const nid = localStorage.getItem(_wsNextIdKey());
    if (nid) EMPLOYEE_STORE._nextId = parseInt(nid, 10);
    else EMPLOYEE_STORE._nextId = 1;
  } catch(e) {
    EMPLOYEE_STORE.employees = [];
    EMPLOYEE_STORE._nextId = 1;
  }
}

/** 切换画布工作区：保存当前画布 → 切换 → 加载新画布 */
function switchCanvasWorkspace(newWsPath) {
  const newWs = newWsPath || '__default__';
  const oldWs = _currentCanvasWorkspace || '__default__';
  if (newWs === oldWs) return;
  // 1. 保存当前工作区的员工数据
  _saveEmployees();
  // 2. 保存当前画布视觉状态（zoom/pan）
  if (typeof _saveCanvasState === 'function') _saveCanvasState();
  // 3. 切换
  _currentCanvasWorkspace = newWs;
  localStorage.setItem('hermes-canvas-workspace', newWs);
  // 4. 加载新工作区的员工数据
  _loadEmployees();
  EMPLOYEE_STORE.selectedId = null;
  // 5. 关闭右侧面板（旧工作区的对话不再显示）
  if (typeof closeRightPanel === 'function') closeRightPanel();
  // 6. 重新渲染
  renderEmployeeCards();
  // 6.5 重新加载连线数据
  if (typeof _loadConnections === 'function') _loadConnections();
  // 7. 恢复新工作区的画布视觉状态
  if (typeof _loadCanvasState === 'function') _loadCanvasState();
}

// ── CRUD ──────────────────────────────────────────────────────────────────
function createEmployee(opts = {}) {
  const rawName = opts.name || ('员工 ' + (EMPLOYEE_STORE._nextId + 1));
  // 名称唯一性：若重名则追加序号
  let name = rawName;
  if (!isEmployeeNameUnique(name, null)) {
    let suffix = 2;
    while (!isEmployeeNameUnique(name + ' ' + suffix, null)) suffix++;
    name = rawName + ' ' + suffix;
  }
  const id = 'emp-' + EMPLOYEE_STORE._nextId++;
  const avatarIdx = (EMPLOYEE_STORE.employees.length) % EMPLOYEE_AVATARS.length;
  const emp = {
    id,
    name,
    role: opts.role || EMPLOYEE_ROLES[0],
    avatar: opts.avatar || EMPLOYEE_AVATARS[avatarIdx],
    status: 'idle',
    skills: opts.skills || [],
    sessionId: null,  // 绑定的会话 ID
    createdAt: Date.now(),
    lastActiveAt: Date.now(),
    metadata: {},
    // 新增：预设相关字段
    presetId: opts.presetId || null,       // 关联的 Agent 预设 ID
    characterImg: opts.characterImg || null, // 角色精灵图标识
    model: opts.model || 'sonnet',         // 使用的模型
    customPrompt: opts.customPrompt || '', // 用户自定义提示词
    subagentOf: opts.subagentOf || null,   // 该员工是谁的下属（manager empId）
    _pos: opts._pos || null,               // 画布位置
  };
  EMPLOYEE_STORE.employees.push(emp);
  _saveEmployees();
  renderEmployeeCards();
  // 如果是第一个员工或当前没有选中员工，自动选中新员工
  if (EMPLOYEE_STORE.employees.length === 1 || !EMPLOYEE_STORE.selectedId) {
    setTimeout(() => selectEmployee(emp.id), 100);
  }
  return emp;
}

function getEmployee(id) {
  return EMPLOYEE_STORE.employees.find(e => e.id === id);
}

/** 简化模型名称显示，如 claude-sonnet-4-20250514 → sonnet-4, gpt-4o → gpt-4o */
function _shortModelLabel(model) {
  if (!model) return '';
  // 移除常见前缀
  let s = model.replace(/^(anthropic\/|openai\/|google\/|x-ai\/|deepseek\/|meta-llama\/)/, '');
  // 移除日期后缀 -20250514
  s = s.replace(/-\d{8}$/, '');
  // 已够短则直接用
  if (s.length <= 12) return s;
  // claude-sonnet-4 → sonnet-4
  s = s.replace(/^claude-/, '');
  return s.length > 12 ? s.slice(0, 12) : s;
}

/** 格式化 token 数字：1234 → 1.2k, 1234567 → 1.2M */
function _fmtEmpTokens(n) {
  if (!n || n < 0) return '0';
  if (n >= 1e6) return (n / 1e6).toFixed(1) + 'M';
  if (n >= 1e3) return (n / 1e3).toFixed(1) + 'k';
  return String(n);
}

/** 检查员工名称在工作区内是否唯一（排除指定 ID 的员工自身） */
function isEmployeeNameUnique(name, excludeId) {
  const n = (name || '').trim();
  if (!n) return false;
  return !EMPLOYEE_STORE.employees.some(e => e.name === n && e.id !== excludeId);
}

/** 根据员工的角色、技能、预设构建独立的 system prompt */
function buildEmployeeSystemPrompt(emp) {
  if (!emp) return '';
  const parts = [];

  // 1. 预设描述（如有 presetId，从 AGENT_PRESETS 加载完整描述）
  if (emp.presetId && typeof AGENT_PRESETS !== 'undefined') {
    const preset = AGENT_PRESETS.find(p => p.id === emp.presetId);
    if (preset && preset.desc) {
      parts.push(`## 角色定义\n你是「${emp.name}」，${preset.desc}`);
    }
  }

  // 2. 角色信息（无预设时或作为补充）
  if (!parts.length) {
    parts.push(`## 角色定义\n你是「${emp.name}」，角色为「${emp.role}」。`);
  }

  // 3. 技能上下文
  if (emp.skills && emp.skills.length) {
    const enabledSkills = emp.skills.filter(s => s.enabled !== false);
    const skillNames = enabledSkills.map(s => s.name || s).filter(Boolean);
    if (skillNames.length) {
      parts.push(`## 专业技能\n你擅长以下领域：${skillNames.join('、')}。在处理相关任务时，请充分发挥这些专长。`);
    }
  }

  // 4. 行为指引
  parts.push(`## 行为指引
- 始终以「${emp.name}」的身份回应，保持角色一致性
- 根据你的角色和技能，提供专业、精准的建议和解决方案
- 如果问题超出你的专业领域，坦诚说明并给出力所能及的帮助`);

  // 5. subagent 关系上下文（始终追加，不受 customPrompt 影响）
  let relationCtx = '';
  if (emp.subagentOf && typeof getEmployee === 'function') {
    const manager = getEmployee(emp.subagentOf);
    if (manager) {
      relationCtx += `\n\n## 工作关系\n你是「${manager.name}」的下属员工。当「${manager.name}」通过 delegate_task 向你委派任务时，你应该专注执行并汇报结果。`;
    }
  }
  if (typeof getSubagentsOf === 'function') {
    const subs = getSubagentsOf(emp.id);
    if (subs && subs.length) {
      const subNames = subs.map(s => s.employee?.name || '?').join('、');
      relationCtx += `\n\n## 管理范围\n你管理以下下属员工：${subNames}。你可以通过 delegate_task 向他们委派任务，指定 employee_name 为下属名称。`;
    }
  }

  // 6. 用户自定义提示词
  // 当 customPrompt 存在时，以用户编辑的完整提示词为基础，但仍追加关系上下文
  if (emp.customPrompt && emp.customPrompt.trim()) {
    return emp.customPrompt.trim() + relationCtx;
  }

  return parts.join('\n\n') + relationCtx;
}

function updateEmployee(id, updates) {
  const emp = getEmployee(id);
  if (!emp) return;
  Object.assign(emp, updates);
  _saveEmployees();
  renderEmployeeCards();
}

function deleteEmployee(id) {
  const idx = EMPLOYEE_STORE.employees.findIndex(e => e.id === id);
  if (idx < 0) return;
  // 清理连线关系
  if (typeof removeConnectionsForEmployee === 'function') {
    removeConnectionsForEmployee(id);
  }
  EMPLOYEE_STORE.employees.splice(idx, 1);
  if (EMPLOYEE_STORE.selectedId === id) {
    EMPLOYEE_STORE.selectedId = null;
    closeRightPanel();
  }
  _saveEmployees();
  renderEmployeeCards();
}

function setEmployeeStatus(id, status) {
  const emp = getEmployee(id);
  if (!emp) return;
  emp.status = status;
  emp.lastActiveAt = Date.now();
  _saveEmployees();
  // 只更新对应卡片的状态，不全量重渲染
  const card = document.querySelector(`.emp-card[data-id="${id}"]`);
  if (card) _updateCardStatus(card, emp);
}

function selectEmployee(id) {
  EMPLOYEE_STORE.selectedId = id;
  // 更新卡片选中状态
  document.querySelectorAll('.emp-card').forEach(c => {
    c.classList.toggle('emp-selected', c.dataset.id === id);
  });
  // 打开右侧对话面板
  openEmployeeChat(id);
}

// ── 搜索/筛选 ────────────────────────────────────────────────────────────

function _timeAgo(ts) {
  if (!ts) return '';
  const diff = Date.now() - ts;
  const sec = Math.floor(diff / 1000);
  if (sec < 60) return '刚刚';
  const min = Math.floor(sec / 60);
  if (min < 60) return min + '分钟前';
  const hr = Math.floor(min / 60);
  if (hr < 24) return hr + '小时前';
  const day = Math.floor(hr / 24);
  return day + '天前';
}

let _empFilter = 'all';  // 'all' | 'working' | 'idle'
let _empSearchQuery = '';

function filterEmployees() {
  const input = $('empSearch');
  _empSearchQuery = (input ? input.value : '').toLowerCase().trim();
  renderEmployeeCards();
}

function setEmpFilter(filter, btn) {
  _empFilter = filter;
  document.querySelectorAll('.emp-filter-btn').forEach(b => b.classList.remove('active'));
  if (btn) btn.classList.add('active');
  renderEmployeeCards();
}

function _getFilteredEmployees() {
  let list = EMPLOYEE_STORE.employees;
  // 状态筛选
  if (_empFilter === 'working') {
    list = list.filter(e => e.status === 'working' || e.status === 'thinking');
  } else if (_empFilter === 'idle') {
    list = list.filter(e => e.status === 'idle' || e.status === 'offline');
  }
  // 文字搜索
  if (_empSearchQuery) {
    list = list.filter(e => {
      const nameMatch = e.name.toLowerCase().includes(_empSearchQuery);
      const roleMatch = e.role.toLowerCase().includes(_empSearchQuery);
      const skillMatch = e.skills.some(s => (s.name || s).toLowerCase().includes(_empSearchQuery));
      return nameMatch || roleMatch || skillMatch;
    });
  }
  return list;
}

// ── 渲染 ──────────────────────────────────────────────────────────────────
function renderEmployeeCards() {
  const canvas = $('employeeCanvas');
  const empty = $('employeeEmptyState');
  if (!canvas) return;

  // 清除旧卡片（保留空状态元素和工具栏等）
  canvas.querySelectorAll('.emp-card').forEach(c => c.remove());

  const filtered = _getFilteredEmployees();

  if (!EMPLOYEE_STORE.employees.length) {
    if (empty) empty.style.display = '';
    return;
  }
  if (empty) empty.style.display = 'none';

  if (!filtered.length && _empSearchQuery) {
    // 搜索无结果
    const noResult = document.createElement('div');
    noResult.className = 'emp-search-no-result';
    noResult.innerHTML = '<p>没有找到匹配的员工</p>';
    canvas.appendChild(noResult);
    return;
  }

  for (const emp of filtered) {
    const card = _buildCard(emp);
    canvas.appendChild(card);
  }
}

function _buildCard(emp) {
  const card = document.createElement('div');
  card.className = 'emp-card' + (emp.id === EMPLOYEE_STORE.selectedId ? ' emp-selected' : '');
  card.dataset.id = emp.id;
  card.draggable = true;

  const st = STATUS_MAP[emp.status] || STATUS_MAP.idle;
  const skillsHtml = emp.skills.length
    ? emp.skills.slice(0, 3).map(s => `<span class="emp-skill-tag">${esc(s.name || s)}</span>`).join('') +
      (emp.skills.length > 3 ? `<span class="emp-skill-more">+${emp.skills.length - 3}</span>` : '')
    : '';

  // 模型标签：简化显示（取最后一段，如 claude-sonnet-4-20250514 → sonnet-4）
  const modelLabel = _shortModelLabel(emp.model);
  // Token 使用量
  const usage = emp.tokenUsage || {};
  const totalTokens = (usage.input_tokens || 0) + (usage.output_tokens || 0);
  const usageHtml = totalTokens > 0
    ? `<span class="emp-usage-badge">${_fmtEmpTokens(totalTokens)}</span>`
    : '';

  // 头像：如果有 characterImg 则显示精灵图（3×4 sprite sheet 裁剪首帧），否则显示 emoji
  const avatarFallback = esc(emp.avatar).replace(/'/g, "\\'");
  const avatarHtml = emp.characterImg
    ? `<div class="emp-avatar emp-avatar-sprite" style="background-color:${st.bg};background-image:url('/static/img/characters/${emp.characterImg}_frame32x32.png');background-size:300% 400%;background-position:0 0;background-repeat:no-repeat" data-fallback="${avatarFallback}" onerror="this.style.backgroundImage='none';this.textContent=this.dataset.fallback"></div>`
    : `<div class="emp-avatar" style="background:${st.bg}">${emp.avatar}</div>`;

  card.innerHTML = `
    <div class="emp-card-status-bar" data-status="${emp.status}"></div>
    <div class="emp-card-body">
      <div class="emp-card-header">
        ${avatarHtml}
        <div class="emp-card-info">
          <div class="emp-card-name" ondblclick="event.stopPropagation();_startRenameEmployee('${emp.id}')">${esc(emp.name)}</div>
          <div class="emp-card-role">${esc(emp.role)}</div>
        </div>
        <button class="emp-card-menu-btn" onclick="event.stopPropagation();_showCardMenu(event,'${emp.id}')">⋯</button>
      </div>
      <div class="emp-card-status">
        <span class="emp-status-dot${st.animated ? ' emp-dot-animated' : ''}" style="background:${st.dot}"></span>
        <span class="emp-status-label" style="color:${st.color}">${st.label}</span>
        <span class="emp-card-time">${_timeAgo(emp.lastActiveAt)}</span>
        ${modelLabel ? `<span class="emp-model-badge">${esc(modelLabel)}</span>` : ''}
        ${usageHtml}
      </div>
      ${skillsHtml ? `<div class="emp-card-skills">${skillsHtml}</div>` : ''}
      <div class="emp-card-actions">
        <button class="emp-action-btn" onclick="event.stopPropagation();selectEmployee('${emp.id}')" title="对话">${li('message-square',13)}</button>
        <button class="emp-action-btn" onclick="event.stopPropagation();_showEmployeeSkillConfig('${emp.id}')" title="技能">${li('book-open',13)}</button>
      </div>
    </div>
  `;

  // 点击选中
  card.addEventListener('click', () => selectEmployee(emp.id));

  // 拖拽由外部初始化（card.dataset.dragInit 标记）
  if (!card.dataset.dragInit) {
    _initCardDrag(card, emp);
    card.dataset.dragInit = 'grid';
  }

  return card;
}

function _updateCardStatus(card, emp) {
  const st = STATUS_MAP[emp.status] || STATUS_MAP.idle;
  const bar = card.querySelector('.emp-card-status-bar');
  if (bar) bar.dataset.status = emp.status;
  const dot = card.querySelector('.emp-status-dot');
  if (dot) {
    dot.style.background = st.dot;
    dot.classList.toggle('emp-dot-animated', st.animated);
  }
  const label = card.querySelector('.emp-status-label');
  if (label) { label.style.color = st.color; label.textContent = st.label; }
  const avatar = card.querySelector('.emp-avatar');
  if (avatar) avatar.style.background = st.bg;
}

/** 增量更新卡片上的 token 使用量和模型标签 */
function _updateCardTokenUsage(emp) {
  const card = document.querySelector(`.emp-card[data-id="${emp.id}"]`);
  if (!card) return;
  const usage = emp.tokenUsage || {};
  const totalTokens = (usage.input_tokens || 0) + (usage.output_tokens || 0);
  // 更新 token badge
  let badge = card.querySelector('.emp-usage-badge');
  if (totalTokens > 0) {
    if (!badge) {
      badge = document.createElement('span');
      badge.className = 'emp-usage-badge';
      const statusRow = card.querySelector('.emp-card-status');
      if (statusRow) statusRow.appendChild(badge);
    }
    badge.textContent = _fmtEmpTokens(totalTokens);
  } else if (badge) {
    badge.remove();
  }
  // 更新模型 badge
  const modelLabel = _shortModelLabel(emp.model);
  let modelBadge = card.querySelector('.emp-model-badge');
  if (modelLabel) {
    if (!modelBadge) {
      modelBadge = document.createElement('span');
      modelBadge.className = 'emp-model-badge';
      const statusRow = card.querySelector('.emp-card-status');
      if (statusRow) {
        // 插入到 time 后面
        const timeEl = statusRow.querySelector('.emp-card-time');
        if (timeEl && timeEl.nextSibling) {
          statusRow.insertBefore(modelBadge, timeEl.nextSibling);
        } else {
          statusRow.appendChild(modelBadge);
        }
      }
    }
    modelBadge.textContent = modelLabel;
  } else if (modelBadge) {
    modelBadge.remove();
  }
}

// ── 拖拽（网格内交换位置）──────────────────────────────────────────────────
let _dragSourceId = null;

function _initCardDrag(card, emp) {
  card.addEventListener('dragstart', e => {
    if (e.target.closest('button') || e.target.closest('.emp-card-menu-btn') || e.target.closest('.emp-conn-handle')) {
      e.preventDefault();
      return;
    }
    _dragSourceId = emp.id;
    card.classList.add('emp-dragging');
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', emp.id);
    // 设置拖拽预览
    requestAnimationFrame(() => card.classList.add('emp-dragging'));
  });

  card.addEventListener('dragend', () => {
    card.classList.remove('emp-dragging');
    _dragSourceId = null;
    // 清理所有 drag-over 状态
    document.querySelectorAll('.emp-drag-over').forEach(c => c.classList.remove('emp-drag-over'));
  });

  card.addEventListener('dragover', e => {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    if (_dragSourceId && _dragSourceId !== emp.id) {
      card.classList.add('emp-drag-over');
    }
  });

  card.addEventListener('dragleave', () => {
    card.classList.remove('emp-drag-over');
  });

  card.addEventListener('drop', e => {
    e.preventDefault();
    card.classList.remove('emp-drag-over');
    const sourceId = _dragSourceId || e.dataTransfer.getData('text/plain');
    if (!sourceId || sourceId === emp.id) return;

    // 在数组中交换位置
    const srcIdx = EMPLOYEE_STORE.employees.findIndex(em => em.id === sourceId);
    const tgtIdx = EMPLOYEE_STORE.employees.findIndex(em => em.id === emp.id);
    if (srcIdx < 0 || tgtIdx < 0) return;

    // 交换
    const [moved] = EMPLOYEE_STORE.employees.splice(srcIdx, 1);
    EMPLOYEE_STORE.employees.splice(tgtIdx, 0, moved);
    _saveEmployees();
    renderEmployeeCards();
  });
}

// ── 右键菜单 ──────────────────────────────────────────────────────────────
let _cardMenuEl = null;

function _showCardMenu(event, empId) {
  _hideCardMenu();
  const emp = getEmployee(empId);
  if (!emp) return;

  const menu = document.createElement('div');
  menu.className = 'emp-card-menu';
  menu.innerHTML = `
    <div class="emp-menu-item" onclick="selectEmployee('${empId}');_hideCardMenu()">${li('message-square',13)} 打开对话</div>
    <div class="emp-menu-item" onclick="_startRenameEmployee('${empId}');_hideCardMenu()">${li('pencil',13)} 重命名</div>
    <div class="emp-menu-item" onclick="_showEmployeeSkillConfig('${empId}');_hideCardMenu()">${li('book-open',13)} 配置技能</div>
    <div class="emp-menu-item" onclick="showEditEmployeeDialog('${empId}');_hideCardMenu()">${li('settings',13)} 编辑员工</div>
    <div class="emp-menu-sep"></div>
    <div class="emp-menu-item emp-menu-danger" onclick="deleteEmployee('${empId}');_hideCardMenu()">${li('trash-2',13)} 删除员工</div>
  `;

  // 定位
  const rect = event.target.closest('.emp-card').getBoundingClientRect();
  menu.style.left = rect.left + 'px';
  menu.style.top = (rect.bottom + 4) + 'px';
  document.body.appendChild(menu);
  _cardMenuEl = menu;

  // 点击外部关闭
  setTimeout(() => {
    document.addEventListener('click', _hideCardMenu, { once: true });
  }, 10);
}

function _hideCardMenu() {
  if (_cardMenuEl) { _cardMenuEl.remove(); _cardMenuEl = null; }
}

// ── 内联重命名 ──────────────────────────────────────────────────────────────
function _startRenameEmployee(empId) {
  const card = document.querySelector(`.emp-card[data-id="${empId}"]`);
  if (!card) return;
  const emp = getEmployee(empId);
  if (!emp) return;

  const nameEl = card.querySelector('.emp-card-name');
  if (!nameEl || nameEl.dataset.editing === '1') return;

  nameEl.dataset.editing = '1';
  const oldName = emp.name;
  nameEl.innerHTML = `<input class="emp-rename-input" type="text" value="${esc(oldName)}" maxlength="32">`;
  const input = nameEl.querySelector('.emp-rename-input');
  input.focus();
  input.select();

  const finish = (save) => {
    if (nameEl.dataset.editing !== '1') return;
    nameEl.dataset.editing = '';
    const newName = save ? input.value.trim() : null;
    if (newName && newName !== oldName) {
      if (!isEmployeeNameUnique(newName, empId)) {
        showToast('员工名称不能重复');
        nameEl.textContent = oldName;
        return;
      }
      updateEmployee(empId, { name: newName });
      // 同步右侧面板名字
      const rpName = $('rpEmployeeName');
      if (rpName && EMPLOYEE_STORE.selectedId === empId) rpName.textContent = newName;
    } else {
      nameEl.textContent = oldName;
    }
  };

  input.addEventListener('blur', () => finish(true));
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); input.blur(); }
    if (e.key === 'Escape') { nameEl.dataset.editing = ''; nameEl.textContent = oldName; }
    e.stopPropagation();
  });
  input.addEventListener('click', (e) => e.stopPropagation());
}

// ── 员工创建对话框 ────────────────────────────────────────────────────────
function showEmployeeDialog() {
  _showEmployeeFormDialog(null);
}

function showEditEmployeeDialog(empId) {
  const emp = getEmployee(empId);
  if (!emp) return;
  _showEmployeeFormDialog(emp);
}

function _showEmployeeFormDialog(existing) {
  _hideCardMenu();
  const overlay = document.createElement('div');
  overlay.className = 'emp-dialog-overlay';

  const avatarOptions = EMPLOYEE_AVATARS.map(a =>
    `<button type="button" class="emp-avatar-opt${existing && existing.avatar === a ? ' emp-avatar-selected' : (!existing && a === EMPLOYEE_AVATARS[0] ? ' emp-avatar-selected' : '')}" data-avatar="${a}">${a}</button>`
  ).join('');

  const roleOptions = EMPLOYEE_ROLES.map(r =>
    `<option value="${esc(r)}"${existing && existing.role === r ? ' selected' : ''}>${esc(r)}</option>`
  ).join('');

  overlay.innerHTML = `
    <div class="emp-dialog">
      <div class="emp-dialog-header">
        <h3>${existing ? '编辑员工' : '创建新员工'}</h3>
        <button class="panel-icon-btn" onclick="this.closest('.emp-dialog-overlay').remove()"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg></button>
      </div>
      <div class="emp-dialog-body">
        <label class="emp-dialog-label">头像</label>
        <div class="emp-avatar-picker" id="empAvatarPicker">${avatarOptions}</div>
        <label class="emp-dialog-label">名称</label>
        <input class="emp-dialog-input" id="empFormName" placeholder="员工名称" value="${existing ? esc(existing.name) : ''}">
        <label class="emp-dialog-label">角色</label>
        <select class="emp-dialog-select" id="empFormRole">${roleOptions}</select>
      </div>
      <div class="emp-dialog-footer">
        <button class="cron-btn" onclick="this.closest('.emp-dialog-overlay').remove()">取消</button>
        <button class="cron-btn run" id="empFormSubmit">${existing ? '保存' : '创建'}</button>
      </div>
    </div>
  `;

  document.body.appendChild(overlay);

  // 头像选择
  overlay.querySelectorAll('.emp-avatar-opt').forEach(btn => {
    btn.onclick = () => {
      overlay.querySelectorAll('.emp-avatar-opt').forEach(b => b.classList.remove('emp-avatar-selected'));
      btn.classList.add('emp-avatar-selected');
    };
  });

  // 提交
  overlay.querySelector('#empFormSubmit').onclick = () => {
    const nameInput = overlay.querySelector('#empFormName');
    const name = nameInput.value.trim();
    if (!name) { nameInput.style.borderColor = 'var(--accent)'; return; }
    // 名称唯一性校验（编辑时排除自身）
    if (!isEmployeeNameUnique(name, existing ? existing.id : null)) {
      nameInput.style.borderColor = 'var(--accent)';
      nameInput.title = '该名称已被其他员工使用';
      showToast('员工名称不能重复');
      return;
    }
    nameInput.style.borderColor = '';
    nameInput.title = '';
    const role = overlay.querySelector('#empFormRole').value;
    const avatarEl = overlay.querySelector('.emp-avatar-selected');
    const avatar = avatarEl ? avatarEl.dataset.avatar : EMPLOYEE_AVATARS[0];

    if (existing) {
      updateEmployee(existing.id, { name, role, avatar });
    } else {
      const emp = createEmployee({ name, role, avatar });
      selectEmployee(emp.id);
    }
    overlay.remove();
  };

  // Enter 提交
  overlay.querySelector('#empFormName').addEventListener('keydown', e => {
    if (e.key === 'Enter') overlay.querySelector('#empFormSubmit').click();
  });

  setTimeout(() => overlay.querySelector('#empFormName').focus(), 50);
}

// ── 员工技能配置 ──────────────────────────────────────────────────────────
function _showEmployeeSkillConfig(empId) {
  const emp = getEmployee(empId);
  if (!emp) return;

  // 在右侧面板显示技能配置
  showEmployeeSkillPanel(empId);
}

function assignSkillToEmployee(empId, skillName) {
  const emp = getEmployee(empId);
  if (!emp) return;
  if (!emp.skills.find(s => (s.name || s) === skillName)) {
    emp.skills.push({ name: skillName, enabled: true });
    _saveEmployees();
    renderEmployeeCards();
  }
}

// ── 技能沉淀（对话 → 技能）────────────────────────────────────────────────
async function condenseConversationToSkill() {
  const emp = getEmployee(EMPLOYEE_STORE.selectedId);
  if (!emp || !emp.sessionId) {
    showToast('当前没有活跃的对话可以沉淀');
    return;
  }

  // 获取对话内容
  try {
    const data = await api(`/api/session?session_id=${encodeURIComponent(emp.sessionId)}`);
    const msgs = (data.session.messages || []).filter(m => m.role === 'user' || m.role === 'assistant');
    if (!msgs.length) { showToast('对话为空，无法沉淀'); return; }

    // 生成技能内容
    let skillContent = `---\nname: ${emp.name}-skill\ncreated: ${new Date().toISOString()}\nsource: employee-${emp.id}\n---\n\n`;
    for (const m of msgs) {
      const role = m.role === 'user' ? '用户' : '助手';
      let content = m.content || '';
      if (Array.isArray(content)) content = content.filter(p => p.type === 'text').map(p => p.text || '').join('\n');
      skillContent += `### ${role}\n${String(content).trim()}\n\n`;
    }

    // 保存为技能
    const skillName = `${emp.name}-skill-${Date.now().toString(36)}`;
    await api('/api/skill/save', {
      method: 'POST',
      body: JSON.stringify({ name: skillName, category: 'condensed', content: skillContent })
    });

    // 自动分配给该员工
    assignSkillToEmployee(emp.id, skillName);
    showToast(`已沉淀为技能: ${skillName}`);
  } catch(e) {
    showToast('沉淀失败: ' + e.message);
  }
}

// ── 初始化 ─────────────────────────────────────────────────────────────────
function initEmployees() {
  // 确定当前画布工作区
  const savedWs = localStorage.getItem('hermes-canvas-workspace');
  if (savedWs) {
    _currentCanvasWorkspace = savedWs;
  } else if (S.session && S.session.workspace) {
    _currentCanvasWorkspace = S.session.workspace;
  } else {
    _currentCanvasWorkspace = '__default__';
  }
  // 兼容旧版全局数据 → 迁移到当前工作区（一次性）
  _migrateGlobalEmployees();
  _loadEmployees();
  renderEmployeeCards();
}

/** 一次性迁移：如果旧版全局 key 有数据但当前工作区 key 没有，则迁移 */
function _migrateGlobalEmployees() {
  const oldKey = 'hermes-employees';
  const newKey = _wsEmployeeKey();
  if (localStorage.getItem(newKey)) return; // 新 key 已有数据，不迁移
  const oldData = localStorage.getItem(oldKey);
  if (!oldData) return; // 旧数据也没有
  try {
    localStorage.setItem(newKey, oldData);
    const oldNextId = localStorage.getItem('hermes-employee-next-id');
    if (oldNextId) localStorage.setItem(_wsNextIdKey(), oldNextId);
    // 迁移完成后删除旧 key（避免重复迁移）
    localStorage.removeItem(oldKey);
    localStorage.removeItem('hermes-employee-next-id');
  } catch(e) {}
}
