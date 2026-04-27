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
  localStorage.removeItem('hermes-webui-selected-employee');
  // 5. 关闭右侧面板（旧工作区的对话不再显示）
  if (typeof closeRightPanel === 'function') closeRightPanel();
  // 6. 重新渲染
  renderEmployeeCards();
  // 6.5 重新加载连线数据并重绘
  if (typeof _loadConnections === 'function') _loadConnections();
  if (typeof refreshConnections === 'function') refreshConnections();
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
    model: opts.model || ($('modelSelect')?.value || ''),  // 使用的模型，默认取当前下拉框的值
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

  // 4. ★ 工作区上下文（告知当前 cwd，让 AI 知道去哪儿找文件）
  let wsPath = '';
  try {
    wsPath = (typeof _currentCanvasWorkspace !== 'undefined' && _currentCanvasWorkspace && _currentCanvasWorkspace !== '__default__')
      ? _currentCanvasWorkspace
      : (typeof S !== 'undefined' && S.session && S.session.workspace) || '';
  } catch(_) { wsPath = ''; }
  if (wsPath) {
    const wsName = (typeof getWorkspaceFriendlyName === 'function')
      ? getWorkspaceFriendlyName(wsPath)
      : wsPath.split(/[\/\\]/).filter(Boolean).pop() || wsPath;
    parts.push(`## 工作区上下文
- **当前工作区名称**：${wsName}
- **工作区绝对路径**：\`${wsPath}\`
- 所有 \`read_file\` / \`write_to_file\` / \`list_files\` 等工具的相对路径都以该工作区为根
- 遇到"读取工作区文件 / 查看现有文档 / 继续项目"等指令时，**必须**先用 \`list_files\` 探索该目录，再 \`read_file\` 读取 README / PLAN / TASK / SPRINT 等疑似规划文档，**不要**直接询问用户文件内容`);
  }

  // 5. 行为指引（★ 强化"行动优先、探索优先"）
  parts.push(`## 行为指引
- 始终以「${emp.name}」的身份回应，保持角色一致性
- 根据你的角色和技能，提供专业、精准的建议和解决方案
- **行动优先**：收到任务后，先用工具收集信息（\`list_files\` / \`read_file\` / \`search\`）再判断，**不要**在信息不足时立即反问用户；当你可以通过读文件/搜索得到答案时，**必须**自己去查
- **合理假设**：对模糊目标，基于工作区现有文档做合理假设并**立即开始执行**；把假设写在回复中让用户纠偏，而非阻塞等待
- 只有在**工具也拿不到答案且假设会导致重大错误**时，才向用户提问——且每次最多 1–2 个最关键问题
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
      relationCtx += `\n\n## 管理范围
你管理以下下属员工：${subNames}。你可以通过 \`delegate_task\` 向他们委派任务，指定 \`employee_name\` 为下属名称。

## 任务分派 SOP（重要）
作为管理者，当你收到"规划/分派/安排任务"类指令时，**必须**按以下顺序执行，而不是反问用户：

1. **探索现状**：用 \`list_files\` 扫描工作区根目录，找出已有的 PLAN / TASK / SPRINT / README / DESIGN 等疑似规划文档
2. **读取规划**：用 \`read_file\` 读取所有相关文档，理解项目背景、目标、优先级、时间节点
3. **做出假设**：若文档中目标/截止时间等信息模糊，基于已有内容做合理假设（并在最终汇报中说明你的假设）
4. **产出拆解**：用 \`write_to_file\` 写出任务拆解文档（如 \`task-breakdown.md\`），包含：每个子任务的 title / 负责人 / 交付物 / 优先级 / 估时
5. **并行委派**：对每个下属并行调用 \`delegate_task\`，传入清晰的任务描述、上下文（引用你拆解文档的路径）和验收标准
6. **汇总汇报**：用 \`send_group_message\` 在总群发布任务清单和委派情况

**反模式（不要这样做）**：
- ❌ 不读文件就向用户索要"本次冲刺目标 / 截止时间 / 范围边界 / 风险预案 / 优先级"
- ❌ 只说"我将使用 write_to_file / delegate_task ..."而不实际调用工具
- ❌ 一次只委派一个下属就结束（应在同一回合内并行 \`delegate_task\` 多个下属）`;
    }
  }

  // 6. 总群协作指引（始终追加，告知员工如何使用 send_group_message 和 delegate_task 协作）
  let groupChatCtx = '';
  if (emp.subagentOf || (typeof getSubagentsOf === 'function' && getSubagentsOf(emp.id)?.length)) {
    groupChatCtx = `\n\n## 总群协作\n你当前在总群上下文中工作。你可以使用以下工具与团队成员协作：\n- **send_group_message**: 向总群发送消息，汇报进度、请求帮助、或与其他员工协调。支持 @mention 其他员工来委派任务。\n- **delegate_task**: 向下属员工委派子任务。委派结果会自动回传到总群，所有成员可见。\n\n协作建议：\n- 复杂任务请使用 delegate_task 分解给下属，不要自己全部执行\n- 需要其他员工协助时，使用 send_group_message @对方名\n- 定期用 send_group_message 汇报进度，让团队了解你的工作状态`;
  } else {
    // 普通员工（无上下级关系）也可以向总群发消息
    groupChatCtx = `\n\n## 总群协作\n你当前在总群上下文中工作。你可以使用 **send_group_message** 工具向总群发送消息，汇报进度或请求帮助。`;
  }

  // 7. 用户自定义提示词
  // 当 customPrompt 存在时，以用户编辑的完整提示词为基础，但仍追加关系上下文和总群指引
  if (emp.customPrompt && emp.customPrompt.trim()) {
    return emp.customPrompt.trim() + relationCtx + groupChatCtx;
  }

  return parts.join('\n\n') + relationCtx + groupChatCtx;
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

function selectEmployee(id, fromUser, taskId) {
  // 如果总群正在打开中 且 不是用户主动点击，忽略员工选择请求（防止异步操作干扰总群UI）
  if (typeof GROUP_CHAT_STATE !== 'undefined' && GROUP_CHAT_STATE.isOpen && !fromUser) {
    console.log('[selectEmployee] 总群打开中，忽略非用户触发的选择:', id);
    return;
  }

  // ★ 关闭该员工当前 active 任务的总群 SSE 监听（避免与 _attachLiveStreamToChat 双消费者竞争）
  // 方案 A：SSE 引用现在存储在 task 对象上，不再在 emp 上
  const emp = getEmployee(id);
  if (emp && emp._activeTaskId && typeof DelegationVM !== 'undefined') {
    const task = DelegationVM.getTask(emp._activeTaskId);
    if (task && task.sseSource) {
      console.log('[selectEmployee] 关闭总群任务 SSE 监听, taskId=', task.id);
      // 标记为主动关闭，避免 error 处理器触发重复回传
      task.sseSource._intentionallyClosed = true;
      try { task.sseSource.close(); } catch(_) {}
      task.sseSource = null;
    }
  }
  // 向后兼容：若有旧字段残留，也清理
  if (emp && emp._gcSseSource) {
    try {
      emp._gcSseSource._intentionallyClosed = true;
      emp._gcSseSource.close();
    } catch(_) {}
    emp._gcSseSource = null;
  }

  EMPLOYEE_STORE.selectedId = id;
  // ★ 持久化选中状态，刷新UI后恢复
  localStorage.setItem('hermes-webui-selected-employee', id);
  // 关闭总群模式
  if (typeof GROUP_CHAT_STATE !== 'undefined') GROUP_CHAT_STATE.isOpen = false;
  // 恢复总群隐藏的头部按钮
  const btnEditPrompt = $('btnEditPrompt');
  if (btnEditPrompt) btnEditPrompt.style.display = '';
  const btnCondense = $('btnCondenseSkill');
  if (btnCondense) btnCondense.style.display = '';
  const btnSkills = $('btnEmployeeSkills');
  if (btnSkills) btnSkills.style.display = '';
  // 更新卡片选中状态
  document.querySelectorAll('.emp-card').forEach(c => {
    c.classList.toggle('emp-selected', c.dataset.id === id);
  });
  // 打开右侧对话面板（★ 传 taskId 以便加载委派任务的独立 session）
  openEmployeeChat(id, taskId || undefined);
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
        <button class="emp-action-btn" onclick="event.stopPropagation();selectEmployee('${emp.id}', true)" title="对话">${li('message-square',13)}</button>
        <button class="emp-action-btn" onclick="event.stopPropagation();_showEmployeeSkillConfig('${emp.id}')" title="技能">${li('book-open',13)}</button>
      </div>
    </div>
  `;

  // 点击选中（始终传 fromUser=true，因为这是用户主动点击）
  card.addEventListener('click', () => selectEmployee(emp.id, true));

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
  if (label) {
    label.style.color = st.color;
    // 方案 B：状态标签后追加"· 排队 N"
    let extra = '';
    if (typeof DelegationVM !== 'undefined' && typeof DelegationVM.getQueueLength === 'function') {
      try {
        const qlen = DelegationVM.getQueueLength(emp.id) || 0;
        if (qlen > 0) extra = ` · 排队 ${qlen}`;
      } catch (_) {}
    }
    label.textContent = st.label + extra;
  }
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
    <div class="emp-menu-item" onclick="selectEmployee('${empId}', true);_hideCardMenu()">${li('message-square',13)} 打开对话</div>
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
      const role = m.role === 'user' ? '你' : '助手';
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

// ── 团队批量创建（基于 agent 返回的结构化 JSON）───────────────────────────────
/**
 * 根据结构化 JSON 在画布上批量创建员工卡片 + 连线。
 *
 * JSON 格式：
 * {
 *   "team_name": "Godot 游戏开发团队",
 *   "members": [
 *     {
 *       "name": "制作人",            // 必填
 *       "presetId": "producer",     // 可选：优先从 AGENT_PRESETS 精确匹配
 *       "role": "总监层",            // 可选：无预设时使用
 *       "model": "opus",            // 可选：覆盖预设的模型
 *       "manages": ["创意总监","技术总监"]  // 可选：该成员管理的下属名称
 *     },
 *     ...
 *   ]
 * }
 *
 * 预设匹配优先级：
 * 1. presetId 精确匹配 AGENT_PRESETS[].id
 * 2. name 匹配 AGENT_PRESETS[].name
 * 3. 无匹配 → 创建通用员工
 */
function createTeamFromJSON(teamData) {
  if (!teamData || !teamData.members || !teamData.members.length) return;

  const members = teamData.members;
  const nameToEmp = {};  // name → emp 对象（用于后续连线）

  // ── 第一步：按层级分组 ──
  const tiers = {};  // tier → [member, ...]
  for (const m of members) {
    let tier = 3; // 默认 tier 3（最底层）
    let preset = null;

    // 尝试从预设获取 tier
    if (typeof AGENT_PRESETS !== 'undefined') {
      // 优先 presetId 精确匹配
      if (m.presetId) {
        preset = AGENT_PRESETS.find(p => p.id === m.presetId);
      }
      // 其次 name 匹配
      if (!preset && m.name) {
        preset = AGENT_PRESETS.find(p => p.name === m.name);
      }
    }
    if (preset && typeof AGENT_CATEGORIES !== 'undefined') {
      const cat = AGENT_CATEGORIES.find(c => c.id === preset.category);
      if (cat) tier = cat.tier;
    }
    if (!tiers[tier]) tiers[tier] = [];
    tiers[tier].push({ ...m, _preset: preset, _tier: tier });
  }

  // ── 第二步：按层级布局 + 创建员工 ──
  const CARD_W = 240, CARD_H = 160;
  const COL_GAP = 24, ROW_GAP = 80;
  const sortedTiers = Object.keys(tiers).map(Number).sort((a, b) => a - b);

  for (const tier of sortedTiers) {
    const rowIdx = sortedTiers.indexOf(tier);
    const rowMembers = tiers[tier];
    const totalWidth = rowMembers.length * CARD_W + (rowMembers.length - 1) * COL_GAP;
    const startX = Math.max(50, 400 - totalWidth / 2);
    const y = 50 + rowIdx * (CARD_H + ROW_GAP);

    for (let i = 0; i < rowMembers.length; i++) {
      const m = rowMembers[i];
      // 检查是否已存在同名员工
      const existing = EMPLOYEE_STORE.employees.find(e => e.name === m.name);
      if (existing) {
        nameToEmp[m.name] = existing;
        continue;
      }

      const preset = m._preset;
      const empOpts = {
        name: m.name,
        role: m.role || (preset ? preset.role : '通用助手'),
        _pos: { x: startX + i * (CARD_W + COL_GAP), y },
      };

      // 从预设填充配置
      if (preset) {
        empOpts.presetId = preset.id;
        empOpts.characterImg = preset.characterImg;
        // 将预设的 skills 字符串数组转为 createEmployee 期望的对象数组格式
        if (preset.skills && Array.isArray(preset.skills)) {
          empOpts.skills = preset.skills.map(s =>
            typeof s === 'string' ? { name: s, enabled: true } : s
          );
        }
        empOpts.role = preset.role;
        empOpts.avatar = preset.avatar || preset.icon;
        if (preset.model) empOpts.model = preset.model;
      }

      // 显式指定的 model 覆盖预设
      if (m.model) empOpts.model = m.model;

      const emp = createEmployee(empOpts);
      nameToEmp[m.name] = emp;
    }
  }

  // ── 第三步：根据 manages 建立连线 ──
  let connCount = 0;
  for (const m of members) {
    if (!m.manages || !m.manages.length) continue;
    const manager = nameToEmp[m.name];
    if (!manager) continue;
    for (const subName of m.manages) {
      const sub = nameToEmp[subName];
      if (sub && typeof addConnection === 'function') {
        const conn = addConnection(manager.id, sub.id);
        if (conn) {
          connCount++;
          // 同步 subagentOf 字段
          sub.subagentOf = manager.id;
        }
      }
    }
  }
  if (connCount) _saveEmployees();

  // ── 第四步：自动切换到画布 + 显示提示 ──
  if (typeof switchWorkspaceTab === 'function') switchWorkspaceTab('canvas');
  showToast(`已创建团队: ${teamData.team_name || '自定义团队'}（${members.length} 人, ${connCount} 条连线）`);
}
