/**
 * employee.js — 员工卡片渲染、拖拽、状态管理
 * 参考 OpenOffice 的 office-store 架构
 */

// esc fallback（ui.js 在部分加载场景可能晚于 employee.js）
if (typeof esc === 'undefined') {
  window.esc = function(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function(c) {
      return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c];
    });
  };
}

// ── 员工数据模型 ────────────────────────────────────────────────────────────
const EMPLOYEE_STORE = {
  employees: [],
  selectedId: null,
  _nextId: 1,
};

// ── 头像风格配置（DiceBear）────────────────────────────────────────────────
const EMPLOYEE_AVATAR_STYLES = [
  { id: 'bottts',      label: '机器人', icon: '🤖', color: 'b6e3f4' },
  { id: 'pixel-art',   label: '像素',   icon: '👾', color: 'c0aede' },
  { id: 'avataaars',   label: '人物',   icon: '🧑', color: 'd1d4f9' },
  { id: 'shapes',      label: '几何',   icon: '🔷', color: 'ffd5dc' },
  { id: 'identicon',   label: '标识',   icon: '🔮', color: 'ffdfbf' },
  { id: 'notionists',  label: '简笔',   icon: '✏️', color: 'c0aede' },
  { id: 'fun-emoji',   label: '趣味',   icon: '😊', color: 'ffdfbf' },
  { id: 'rings',       label: '环形',   icon: '⭕', color: 'b6e3f4' },
  { id: 'thumbs',      label: '手势',   icon: '👍', color: 'ffd5dc' },
  { id: 'lorelei',     label: '插画',   icon: '🎨', color: 'd1d4f9' },
];

// 保留旧版 emoji 作为加载失败/离线 fallback
const EMPLOYEE_AVATARS = [
  '🤖', '👩‍💻', '🧑‍🔬', '👨‍🎨', '👩‍🔧', '🧙‍♂️', '🦊', '🐱', '🐶', '🦁',
  '🐼', '🦄', '🐸', '🦉', '🐝', '🧑‍🚀', '🥷', '🧑‍🍳', '👨‍⚕️', '👩‍🏫'
];

/** 字符串哈希，用于确定性分配风格 */
function hashString(str) {
  let h = 0;
  for (let i = 0; i < (str || '').length; i++) {
    h = ((h << 5) - h) + str.charCodeAt(i);
    h |= 0;
  }
  return Math.abs(h);
}

/** 根据员工数据生成 DiceBear 头像 URL */
function getEmployeeAvatarUrl(emp, opts = {}) {
  if (!emp) return '';
  const size = opts.size || 128;
  // 若 avatar 已是完整 URL，直接复用
  if (emp.avatar && /^https?:\/\//.test(emp.avatar)) {
    return emp.avatar;
  }
  // 确定风格（兼容旧版：emoji 不是风格 id，则哈希分配）
  let style = emp.avatarStyle || emp.avatar;
  const validStyles = EMPLOYEE_AVATAR_STYLES.map(s => s.id);
  if (!style || !validStyles.includes(style)) {
    style = validStyles[hashString(emp.id || emp.name || 'emp') % validStyles.length];
  }
  const seed = emp.avatarSeed || emp.name || emp.id || 'employee';
  return `https://api.dicebear.com/9.x/${style}/svg?seed=${encodeURIComponent(seed)}&size=${size}`;
}

/** 获取员工头像的 HTML（含动画状态与 fallback） */
function getEmployeeAvatarHtml(emp, opts = {}) {
  if (!emp) return '';
  const size = opts.size || 128;
  const cls = opts.className || 'emp-avatar';
  const url = getEmployeeAvatarUrl(emp, { size });
  const st = opts.statusStyle || STATUS_MAP[emp.status] || STATUS_MAP.idle;
  const fallback = esc(emp.avatar || '🤖').replace(/'/g, "\\'");
  // 用 onerror 将 img 替换为 fallback emoji
  return `<div class="${cls}${opts.animated !== false ? ' emp-avatar-animated' : ''}" style="background:${st.bg};padding:0;overflow:hidden" data-status="${emp.status}">
    <img src="${url}" alt="" style="width:100%;height:100%;object-fit:cover;display:block;border-radius:inherit" onerror="this.parentElement.innerHTML='<span style=font-size:22px>${fallback}</span>'">
  </div>`;
}

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
    let key = _wsEmployeeKey();
    let raw = localStorage.getItem(key);

    // ★ 2026-04-27(v3) Bug 修复：路径归一化模糊匹配兜底
    //   用户反馈"切换到 GodotWorkspace 后画布空，点全部按钮才刷新出员工"。
    //   root cause 之一：路径 key 大小写/分隔符不一致导致 key mismatch。
    //   例：
    //     - 创建员工时 _currentCanvasWorkspace='G:\HermesWorkspaces\GodotWorkspace'
    //     - 切换时传入 path='G:/HermesWorkspaces/GodotWorkspace'（正斜杠）
    //       或盘符大小写不同（'g:\...')
    //   两个 key 不相等 → 读不到数据 → 显示"还没有员工"空态。
    //   兜底策略：精确 key 没命中时，遍历 localStorage 所有 hermes-employees:*
    //   条目，对比归一化路径（小写 + 统一正斜杠 + trim），找到相同工作区
    //   的另一种写法就使用其数据，同时**把数据迁移到当前规范 key**避免下次再绕路。
    if (!raw) {
      const wanted = _normalizeWsPath(_currentCanvasWorkspace || '__default__');
      if (wanted) {
        for (let i = 0; i < localStorage.length; i++) {
          const k = localStorage.key(i);
          if (!k || !k.startsWith('hermes-employees:')) continue;
          if (k === key) continue;
          const wsPartRaw = k.slice('hermes-employees:'.length);
          if (_normalizeWsPath(wsPartRaw) === wanted) {
            const altRaw = localStorage.getItem(k);
            if (altRaw) {
              console.warn('[_loadEmployees] key mismatch recovered: "' + k +
                           '" (data) vs "' + key + '" (expected). Migrating data to expected key.');
              // 迁移到规范 key
              try {
                localStorage.setItem(key, altRaw);
                const altNid = localStorage.getItem('hermes-employees-nextid:' + wsPartRaw);
                if (altNid) localStorage.setItem(_wsNextIdKey(), altNid);
              } catch(_) {}
              raw = altRaw;
              break;
            }
          }
        }
      }
    }

    if (raw) {
      EMPLOYEE_STORE.employees = JSON.parse(raw);
    } else {
      EMPLOYEE_STORE.employees = [];
    }
    const nid = localStorage.getItem(_wsNextIdKey());
    if (nid) EMPLOYEE_STORE._nextId = parseInt(nid, 10);
    else EMPLOYEE_STORE._nextId = 1;
  } catch(e) {
    console.error('[_loadEmployees] err:', e);
    EMPLOYEE_STORE.employees = [];
    EMPLOYEE_STORE._nextId = 1;
  }
}

/** 归一化工作区路径用于 key 比较：小写、统一正斜杠、去首尾空白 */
function _normalizeWsPath(p) {
  if (!p) return '';
  return String(p).trim().toLowerCase().replace(/\\/g, '/').replace(/\/+$/, '');
}

/** 切换画布工作区：保存当前画布 → 切换 → 加载新画布 */
function switchCanvasWorkspace(newWsPath) {
  const newWs = newWsPath || '__default__';
  const oldWs = _currentCanvasWorkspace || '__default__';

  // ★ 2026-04-27(v3) Bug 修复：newWs === oldWs 时不再直接 early-return。
  //   原实现完全什么都不做 → 画布维持原状。但用户实际场景里：
  //     1) 某些路径下 DOM 里的 .emp-card 可能被旁路副作用清空（如
  //        右面板重建、画布 transform 重置、syncTopbar 重绘等），
  //        而 _currentCanvasWorkspace 未变；
  //     2) panels.js 的 ws-dropdown 点击不检查 w.path===currentWs，
  //        用户选中当前激活的工作区也进来 → early-return 导致
  //        "画布没更新/空态 placeholder 留着/选择没反馈"；
  //     3) renderEmployeeCards 是幂等的，重复渲染几乎零成本。
  //   新策略：同工作区跳过保存/加载（避免覆盖未持久化状态），但**仍然
  //   执行一次 renderEmployeeCards** 保证 DOM 与 store 一致。
  if (newWs === oldWs) {
    try { renderEmployeeCards(); } catch(e) { console.error('[switchCanvasWorkspace] same-ws rerender err:', e); }
    try { if (typeof refreshConnections === 'function') refreshConnections(); } catch(_) {}
    try { if (typeof syncTopbar === 'function') syncTopbar(); } catch(_) {}
    return;
  }

  // 1. 保存当前工作区的员工数据
  try { _saveEmployees(); } catch(e) { console.error('[switchCanvasWorkspace] save employees err:', e); }
  // 2. 保存当前画布视觉状态（zoom/pan）
  try { if (typeof _saveCanvasState === 'function') _saveCanvasState(); } catch(e) { console.error('[switchCanvasWorkspace] save canvas state err:', e); }
  // 3. 切换
  _currentCanvasWorkspace = newWs;
  localStorage.setItem('hermes-canvas-workspace', newWs);
  // 4. 加载新工作区的员工数据
  try { _loadEmployees(); } catch(e) { console.error('[switchCanvasWorkspace] load employees err:', e); }
  EMPLOYEE_STORE.selectedId = null;
  try { localStorage.removeItem('hermes-webui-selected-employee'); } catch(_) {}
  // 5. 关闭右侧面板（旧工作区的对话不再显示）——try/catch 保护，防止 selectEmployee 异常中断
  try { if (typeof closeRightPanel === 'function') closeRightPanel(); } catch(e) { console.error('[switchCanvasWorkspace] closeRightPanel err:', e); }

  // ★ 2026-04-27 Bug 修复：重置员工过滤器为"全部"，并同步 DOM
  //   原问题：切换工作区后，如果用户之前选了"工作中"/"空闲"过滤器，
  //   _empFilter 仍是旧值，新工作区的员工被过滤掉，画布空着，
  //   必须手动点"全部"才显示。
  //   每个工作区的员工状态独立，没理由沿用旧工作区的过滤状态。
  _empFilter = 'all';
  _empSearchQuery = '';
  const _empSearchInput = $('empSearch');
  if (_empSearchInput) _empSearchInput.value = '';
  document.querySelectorAll('.emp-filter-btn').forEach(b => {
    b.classList.toggle('active', b.dataset.filter === 'all');
  });

  // ★ 2026-04-27 修复渲染顺序：先恢复新工作区的画布 transform（zoom/pan），
  //   再渲染员工卡片，这样卡片位置以新 transform 为基准，不会因旧 transform
  //   导致卡片跑到视口外被用户误以为"画布空"。
  // 6. 恢复新工作区的画布视觉状态（移到前面）
  try { if (typeof _loadCanvasState === 'function') _loadCanvasState(); } catch(e) { console.error('[switchCanvasWorkspace] load canvas state err:', e); }
  // 7. 重新渲染
  try { renderEmployeeCards(); } catch(e) { console.error('[switchCanvasWorkspace] render employees err:', e); }
  // 7.5 重新加载连线数据并重绘
  try { if (typeof _loadConnections === 'function') _loadConnections(); } catch(e) { console.error('[switchCanvasWorkspace] load connections err:', e); }
  try { if (typeof refreshConnections === 'function') refreshConnections(); } catch(e) { console.error('[switchCanvasWorkspace] refresh connections err:', e); }

  // ★ 2026-04-27(v3) 防御性异步兜底重渲染（强化版）：
  //   兜底条件同时检测"DOM 无 .emp-card"和"空态 placeholder 处于显示态"，
  //   两个条件任意一个命中都会触发重渲——这样即使 store 非空但
  //   renderEmployeeCards 因时序/DOM 异常没挂上卡片，仍能通过异步重试修复。
  //   检测时机扩展为 rAF + 100ms + 400ms + 1000ms 四次，覆盖 session update /
  //   loadDir / 子组件重绘等更晚的异步副作用。
  const _retryRenderIfNeeded = () => {
    try {
      if (EMPLOYEE_STORE.employees.length === 0) return;
      const cardCount = document.querySelectorAll('.emp-card').length;
      const emptyEl = document.getElementById('employeeEmptyState');
      const emptyVisible = !!(emptyEl
        && emptyEl.style.display !== 'none'
        && emptyEl.offsetParent !== null);
      if (cardCount === 0 || emptyVisible) {
        console.warn('[switchCanvasWorkspace] post-switch canvas needs rerender (cards=' +
                     cardCount + ', emptyVisible=' + emptyVisible +
                     ', store=' + EMPLOYEE_STORE.employees.length + ')');
        // 强制隐藏空态 placeholder（防止与卡片同时存在）
        if (emptyEl) emptyEl.style.display = 'none';
        renderEmployeeCards();
        if (typeof refreshConnections === 'function') refreshConnections();
      }
    } catch(e) { console.error('[switchCanvasWorkspace] retry render err:', e); }
  };
  if (typeof requestAnimationFrame === 'function') {
    requestAnimationFrame(_retryRenderIfNeeded);
  }
  setTimeout(_retryRenderIfNeeded, 100);
  setTimeout(_retryRenderIfNeeded, 400);
  setTimeout(_retryRenderIfNeeded, 1000);

  // ★ 2026-04-27 Bug 修复：切换画布工作区后立即刷新顶栏工作区按钮显示
  //   （#wsInfoBtn 显示当前工作区名 + 路径）。panels.js::switchToWorkspace
  //   会调 syncTopbar，但某些路径（仅调 switchCanvasWorkspace 而不走 session
  //   update）时按钮不会更新，仍显示 "Untitled" 等旧文本。
  try { if (typeof syncTopbar === 'function') syncTopbar(); } catch(_) {}
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
  const styleIdx = hashString(id) % EMPLOYEE_AVATAR_STYLES.length;
  const emp = {
    id,
    name,
    role: opts.role || EMPLOYEE_ROLES[0],
    avatar: opts.avatar || EMPLOYEE_AVATARS[avatarIdx],
    avatarStyle: opts.avatarStyle || EMPLOYEE_AVATAR_STYLES[styleIdx].id,
    avatarSeed: opts.avatarSeed || name,
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
    // 扩展字段
    isPM: opts.isPM === true,              // ★ 是否为 PM 专员（工作区中最多一个）
    params: opts.params || {},             // 配置参数
    configHtml: opts.configHtml || '',     // 配置页面 HTML
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
- 如果问题超出你的专业领域，坦诚说明并给出力所能及的帮助

## ⚠️ 工具调用的铁律（违反即任务失败）
- **Markdown 代码块不是工具调用**：\`\`\`bash list_files ...\`\`\` / \`\`\`json {...}\`\`\` 这种只是**纯文本**，系统**不会**执行。你必须通过真正的 function call（tool call）机制来触发工具。
- **禁止伪装执行**：严禁在回复中写"\`list_files G:\\...\`（等待结果...）"、"正在执行 read_file ..."之类的**伪代码块模拟**然后就结束回复。这样的回复会被视为**未完成任务**。
- **识别自己是否真的调了工具**：如果你的这一轮回复里**没有任何 tool_call 产生**（不是文本，是真正的工具调用事件），那就意味着你**什么都没做**，哪怕你写了多漂亮的"计划"文字。
- **正确做法**：直接发起工具调用——你的客户端会把你的工具调用发给用户可见的界面，工具结果会作为下一轮输入回传给你，你再根据结果继续行动。`);

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
5. **HTML 原型验证（⚠️ 必须等用户确认后才能进入下一步）**：
   - 用 \`write_to_file\` 在工作区根目录生成一个**可独立打开的 HTML 原型文件**（如 \`prototype-preview.html\`）
   - 原型要求：**单文件、内联 CSS/JS、浏览器直接打开即可预览**，不依赖外部资源
   - 原型内容应包含：项目概览、任务拆解甘特图/看板视图、各下属的职责分工、里程碑时间线、关键交付物列表
   - 使用现代 UI 风格（卡片布局、渐变配色、交互折叠/展开），让用户一目了然
   - 生成后**必须停下来**，向用户展示原型文件路径，并明确询问：**"请查看原型文件 prototype-preview.html，确认任务规划是否合理。确认后我将开始分派任务给各下属。"**
   - ⛔ **在用户明确回复确认（如"确认"/"可以"/"开始"/"OK"等肯定答复）之前，绝对不能执行 \`delegate_task\`**
   - 如果用户提出修改意见，先更新原型文件和拆解文档，再次请求确认
6. **并行委派**（仅在用户确认原型后执行）：对每个下属并行调用 \`delegate_task\`，传入清晰的任务描述、上下文（引用你拆解文档的路径）和验收标准
7. **汇总汇报**：用 \`send_group_message\` 在PM专员发布任务清单和委派情况

**反模式（不要这样做）**：
- ❌ 不读文件就向用户索要"本次冲刺目标 / 截止时间 / 范围边界 / 风险预案 / 优先级"
- ❌ 只说"我将使用 write_to_file / delegate_task ..."而不实际调用工具
- ❌ 一次只委派一个下属就结束（应在同一回合内并行 \`delegate_task\` 多个下属）
- ❌ **把工具名写进 markdown 代码块假装执行**（例如 \`\`\`bash\\nlist_files G:\\\\...\\n\`\`\` 然后"（等待结果...）"就结束），这只是纯文本，系统不会执行任何工具。必须通过真正的 function call 调工具，工具结果才会作为下一轮输入回传给你
- ❌ 回复中**没有任何真正的 tool_call** 就交还控制权——这会被视为任务失败
- ❌ **跳过 HTML 原型验证直接委派任务**——用户必须先看到可视化规划并确认后，才能启动委派`;
    }
  }

  // 6. PM专员协作指引（始终追加，告知员工如何使用 send_group_message 和 delegate_task 协作）
  let groupChatCtx = '';
  if (emp.subagentOf || (typeof getSubagentsOf === 'function' && getSubagentsOf(emp.id)?.length)) {
    groupChatCtx = `\n\n## PM专员协作\n你当前在PM专员上下文中工作。你可以使用以下工具与团队成员协作：\n- **send_group_message**: 向PM专员发送消息，汇报进度、请求帮助、或与其他员工协调。支持 @mention 其他员工来委派任务。\n- **delegate_task**: 向下属员工委派子任务。委派结果会自动回传到PM专员，所有成员可见。\n\n协作建议：\n- 复杂任务请使用 delegate_task 分解给下属，不要自己全部执行\n- 需要其他员工协助时，使用 send_group_message @对方名\n- 定期用 send_group_message 汇报进度，让团队了解你的工作状态`;
  } else {
    // 普通员工（无上下级关系）也可以向PM专员发消息
    groupChatCtx = `\n\n## PM专员协作\n你当前在PM专员上下文中工作。你可以使用 **send_group_message** 工具向PM专员发送消息，汇报进度或请求帮助。`;
  }

  // 7. 用户自定义提示词
  // 当 customPrompt 存在时，以用户编辑的完整提示词为基础，但仍追加关系上下文和总群指引
  if (emp.customPrompt && emp.customPrompt.trim()) {
    return emp.customPrompt.trim() + relationCtx + groupChatCtx;
  }

  return parts.join('\n\n') + relationCtx + groupChatCtx;
}

// ─── 异步 Prompt 构建（走后端 /api/prompt/build，Jinja2 + 多语言 + skill 注入） ───
// 旧的同步 buildEmployeeSystemPrompt() 保留作为本地 fallback，与后端不可达时的安全网。
//
// 使用示例：
//   const prompt = await buildEmployeeSystemPromptAsync(emp);          // 默认当前 locale
//   const prompt = await buildEmployeeSystemPromptAsync(emp, {locale: 'en'});
//   const prompt = await buildEmployeeSystemPromptAsync(emp, {forceRefresh: true});
//
// 返回值与同步版一致：一个完整的 system prompt 字符串。

const _PROMPT_CACHE = new Map();      // cacheKey → prompt string
const _PROMPT_CACHE_MAX = 100;

function _promptCacheKey(emp, locale, skillsHash) {
  if (!emp) return '';
  const fingerprint = JSON.stringify({
    id: emp.id,
    name: emp.name,
    role: emp.role,
    presetId: emp.presetId,
    subagentOf: emp.subagentOf,
    customPrompt: emp.customPrompt || '',
    params: emp.params || {},
    skills: (emp.skills || []).map(s => ({ name: s.name || s, enabled: s.enabled !== false })),
    promptSegments: emp.promptSegments || null,
  });
  return locale + '|' + (skillsHash || '') + '|' + fingerprint;
}

function _currentPromptLocale() {
  try {
    if (typeof window !== 'undefined' && window._locale && window._locale._lang) {
      const lang = String(window._locale._lang).toLowerCase();
      if (lang.startsWith('zh')) return 'zh';
      if (lang.startsWith('en')) return 'en';
      return lang;
    }
  } catch (_) {}
  return 'zh';
}

async function buildEmployeeSystemPromptAsync(emp, opts) {
  opts = opts || {};
  if (!emp) return '';

  const locale = opts.locale || _currentPromptLocale();

  // 始终预先计算同步 fallback（作为最终保底）
  let syncFallback = '';
  try { syncFallback = buildEmployeeSystemPrompt(emp); } catch (_) {}

  // 组装后端请求参数
  let workspace = opts.workspace;
  if (!workspace) {
    try {
      workspace = (typeof _currentCanvasWorkspace !== 'undefined' && _currentCanvasWorkspace && _currentCanvasWorkspace !== '__default__')
        ? _currentCanvasWorkspace
        : ((typeof S !== 'undefined' && S.session && S.session.workspace) || '');
    } catch (_) { workspace = ''; }
  }

  let preset = opts.preset || null;
  if (!preset && emp.presetId && typeof AGENT_PRESETS !== 'undefined') {
    preset = AGENT_PRESETS.find(p => p.id === emp.presetId) || null;
  }

  let manager = opts.manager || null;
  if (!manager && emp.subagentOf && typeof getEmployee === 'function') {
    manager = getEmployee(emp.subagentOf) || null;
  }

  const skills = opts.skills !== undefined
    ? opts.skills
    : (emp.skills || []).filter(s => s.enabled !== false).map(s => ({
        name: s.name || s,
        enabled: true,
      }));

  // 缓存查询（仅在无 override 时生效）
  const useCache = opts.skills === undefined && !opts.forceRefresh;
  const cacheKey = useCache ? _promptCacheKey(emp, locale, JSON.stringify(skills)) : null;
  if (cacheKey && _PROMPT_CACHE.has(cacheKey)) {
    return _PROMPT_CACHE.get(cacheKey);
  }

  try {
    const resp = await api('/api/prompt/build', {
      method: 'POST',
      body: JSON.stringify({
        emp: emp,
        locale: locale,
        preset: preset,
        skills: skills,
        workspace: workspace,
        manager: manager,
        pm_name: (typeof PM_NAME !== 'undefined') ? PM_NAME : 'PM专员',
      }),
    });
    if (resp && resp.ok && typeof resp.prompt === 'string' && resp.prompt.length > 0) {
      if (cacheKey) {
        if (_PROMPT_CACHE.size >= _PROMPT_CACHE_MAX) {
          const firstKey = _PROMPT_CACHE.keys().next().value;
          _PROMPT_CACHE.delete(firstKey);
        }
        _PROMPT_CACHE.set(cacheKey, resp.prompt);
      }
      return resp.prompt;
    }
    console.warn('[prompt] backend returned bad response, using local fallback', resp);
    return syncFallback;
  } catch (err) {
    console.warn('[prompt] backend call failed, using local fallback:', err && err.message);
    return syncFallback;
  }
}

function invalidatePromptCache(empId) {
  if (!empId) {
    _PROMPT_CACHE.clear();
    return;
  }
  const needle = '"id":"' + empId + '"';
  const keys = Array.from(_PROMPT_CACHE.keys());
  for (let i = 0; i < keys.length; i++) {
    if (keys[i].indexOf(needle) !== -1) {
      _PROMPT_CACHE.delete(keys[i]);
    }
  }
}

if (typeof window !== 'undefined') {
  window.buildEmployeeSystemPromptAsync = buildEmployeeSystemPromptAsync;
  window.invalidatePromptCache = invalidatePromptCache;
}

function updateEmployee(id, updates) {
  const emp = getEmployee(id);
  if (!emp) return;
  Object.assign(emp, updates);
  _saveEmployees();
  renderEmployeeCards();
  // 使该员工的 prompt 缓存失效（updates 可能改变了影响 prompt 的字段）
  try { invalidatePromptCache(id); } catch (_) {}
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

  // 头像：优先 DiceBear SVG 动画头像 → characterImg 精灵图 → emoji fallback
  let avatarHtml = '';
  if (emp.avatarStyle || emp.avatar) {
    avatarHtml = getEmployeeAvatarHtml(emp, { size: 128, statusStyle: st, className: 'emp-avatar', animated: true });
  } else if (emp.characterImg) {
    const avatarFallback = esc(emp.avatar).replace(/'/g, "\\'");
    avatarHtml = `<div class="emp-avatar emp-avatar-sprite" style="background-color:${st.bg};background-image:url('/static/img/characters/${emp.characterImg}_frame32x32.png');background-size:300% 400%;background-position:0 0;background-repeat:no-repeat" data-fallback="${avatarFallback}" onerror="this.style.backgroundImage='none';this.textContent=this.dataset.fallback"></div>`;
  } else {
    avatarHtml = `<div class="emp-avatar" style="background:${st.bg}">${esc(emp.avatar || '🤖')}</div>`;
  }

  card.innerHTML = `
    <div class="emp-card-status-bar" data-status="${emp.status}"></div>
    <div class="emp-card-body">
      <div class="emp-card-header">
        ${avatarHtml}
        <div class="emp-card-info">
          <div class="emp-card-name" ondblclick="event.stopPropagation();_startRenameEmployee('${emp.id}')">${esc(emp.name)}${emp.isPM ? ' <span class="emp-pm-badge" title="PM 专员">PM</span>' : ''}</div>
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
  if (avatar) {
    avatar.style.background = st.bg;
    avatar.dataset.status = emp.status;
  }
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

  // DiceBear 风格选择器
  const currentStyle = existing && (existing.avatarStyle || existing.avatar);
  const avatarOptions = EMPLOYEE_AVATAR_STYLES.map((s, idx) => {
    const isSelected = existing
      ? (currentStyle === s.id)
      : idx === 0;
    const previewUrl = `https://api.dicebear.com/9.x/${s.id}/svg?seed=preview&size=64`;
    return `<button type="button" class="emp-avatar-opt${isSelected ? ' emp-avatar-selected' : ''}" data-style="${s.id}" title="${s.label}" style="padding:2px">
      <img src="${previewUrl}" alt="${s.label}" style="width:28px;height:28px;border-radius:6px;object-fit:cover" loading="lazy">
    </button>`;
  }).join('');

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

  // 头像风格选择
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
    const avatarStyle = avatarEl ? avatarEl.dataset.style : EMPLOYEE_AVATAR_STYLES[0].id;

    if (existing) {
      updateEmployee(existing.id, { name, role, avatarStyle, avatarSeed: name });
    } else {
      const emp = createEmployee({ name, role, avatarStyle, avatarSeed: name });
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
/**
 * ★ 2026-04-27 修复 "对话为空 无法沉淀" bug
 * 原问题：只从 `/api/session?session_id=emp.sessionId` 拉主 session 的消息。
 *   但员工在右面板看到的对话 = 主 session + 所有委派子 session 的消息
 *   （由 `_loadAllDelegatedTaskMessages` 合并到 S.messages）。
 *   主 session 往往只包含 system prompt，用户通过总群 @ 员工的对话全部
 *   存在委派子 session 里 → 主 session.messages 过滤后为空 → 误报"对话为空"。
 *   另外，前端调用 `/api/skill/save`（单数）——后端 routes.py 只注册了
 *   `/api/skills/save`（复数），实际请求会 404，导致沉淀失败不被感知。
 *
 * 修复策略：
 *   1) 优先使用 S.messages（右面板已合并好的消息源，= 用户所见即所得）
 *   2) 若 S.messages 不可用（比如当前没打开该员工），再拉主 session 作为兜底
 *   3) 同时支持 content 为字符串 / Anthropic 数组两种格式，过滤纯工具调用消息
 *   4) 调用后端正确的 `/api/skills/save` 路径
 */
function _extractTextFromMessageContent(content) {
  if (content == null) return '';
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    // Anthropic 格式：[{type:'text',text:'...'},{type:'tool_use',...},...]
    return content
      .filter(p => p && (p.type === 'text' || p.type === 'output_text' || typeof p.text === 'string'))
      .map(p => p.text || p.content || '')
      .join('\n');
  }
  if (typeof content === 'object' && typeof content.text === 'string') return content.text;
  return String(content);
}

async function condenseConversationToSkill() {
  const emp = getEmployee(EMPLOYEE_STORE.selectedId);
  if (!emp) {
    showToast('请先选择一个员工');
    return;
  }

  try {
    // ── 1. 收集消息：优先用右面板已合并的 S.messages（含委派子 session） ──
    let rawMsgs = [];
    let sourceDesc = '';
    const sIsSelected = (typeof S !== 'undefined' && S.session && emp.sessionId &&
                        S.session.session_id === emp.sessionId);
    if (sIsSelected && Array.isArray(S.messages) && S.messages.length) {
      rawMsgs = S.messages;
      sourceDesc = `S.messages(${rawMsgs.length})`;
    } else if (emp.sessionId) {
      // 兜底：拉主 session（注意：可能不含委派子任务的消息）
      const data = await api(`/api/session?session_id=${encodeURIComponent(emp.sessionId)}`);
      rawMsgs = (data && data.session && data.session.messages) || [];
      sourceDesc = `主session(${rawMsgs.length})`;
    } else {
      showToast('该员工还没有任何对话，无法沉淀');
      return;
    }

    // ── 2. 过滤：只保留有实际文本的 user / assistant 消息 ──
    const textMsgs = [];
    for (const m of rawMsgs) {
      if (!m || (m.role !== 'user' && m.role !== 'assistant')) continue;
      const text = _extractTextFromMessageContent(m.content).trim();
      if (!text) continue;  // 纯工具调用 / 空消息跳过
      textMsgs.push({ role: m.role, text });
    }

    if (!textMsgs.length) {
      // 诊断信息：帮用户理解为什么"看到对话却被拒"
      const rolesFound = [...new Set(rawMsgs.map(m => m && m.role).filter(Boolean))].join(',');
      showToast(`对话为空，无法沉淀（来源=${sourceDesc}，消息角色=${rolesFound || '无'}）`);
      return;
    }

    // ── 3. 生成技能 markdown ──
    const createdIso = new Date().toISOString();
    let skillContent = `---\nname: ${emp.name}-skill\ncreated: ${createdIso}\nsource: employee-${emp.id}\n---\n\n`;
    skillContent += `# 从「${emp.name}」对话沉淀的技能\n\n共 ${textMsgs.length} 轮有效对话。\n\n`;
    for (const m of textMsgs) {
      const role = m.role === 'user' ? '你' : '助手';
      skillContent += `### ${role}\n${m.text}\n\n`;
    }

    // ── 4. 保存为技能（★ 修正 URL：/api/skill/save → /api/skills/save） ──
    const skillName = `${emp.name}-skill-${Date.now().toString(36)}`;
    const resp = await api('/api/skills/save', {
      method: 'POST',
      body: JSON.stringify({ name: skillName, category: 'condensed', content: skillContent })
    });
    if (resp && resp.error) throw new Error(resp.error);

    // ── 5. 自动分配给该员工 ──
    assignSkillToEmployee(emp.id, skillName);
    showToast(`已沉淀为技能：${skillName}（${textMsgs.length} 轮对话）`);
  } catch(e) {
    console.error('[condenseConversationToSkill] 失败:', e);
    showToast('沉淀失败: ' + (e && e.message ? e.message : String(e)));
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
        // 为预设员工分配确定性 DiceBear 风格
        const styleIdx = hashString(preset.id) % EMPLOYEE_AVATAR_STYLES.length;
        empOpts.avatarStyle = preset.avatarStyle || EMPLOYEE_AVATAR_STYLES[styleIdx].id;
        empOpts.avatarSeed = preset.avatarSeed || preset.name || preset.id;
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
