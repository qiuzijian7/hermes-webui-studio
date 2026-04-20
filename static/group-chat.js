/**
 * group-chat.js — 总群聊天功能
 *
 * 每个工作区对应一个总群，名称为 [工作区名]_总群
 * 支持通过 @员工名 委派任务，员工执行结果回传到总群
 */

// ── 总群状态 ────────────────────────────────────────────────────────────────
const GROUP_CHAT_STATE = {
  sessionId: null,       // 总群 session ID
  messages: [],          // 总群消息列表
  members: [],           // 成员列表（从员工数据读取）
  isOpen: false,         // 总群面板是否打开
  workspace: '',         // 当前总群对应的工作区路径
};

// ── 获取总群数据 ────────────────────────────────────────────────────────────
async function loadGroupChat(workspace) {
  if (!workspace) return null;
  try {
    const data = await api(`/api/group-chat?workspace=${encodeURIComponent(workspace)}`);
    GROUP_CHAT_STATE.sessionId = data.session_id;
    GROUP_CHAT_STATE.messages = data.messages || [];
    // 从员工列表获取成员
    _refreshGroupMembers();
    return data;
  } catch(e) {
    console.warn('加载总群失败:', e);
    return null;
  }
}

/** 从 EMPLOYEE_STORE 刷新成员列表 */
function _refreshGroupMembers() {
  if (typeof EMPLOYEE_STORE === 'undefined') return;
  GROUP_CHAT_STATE.members = EMPLOYEE_STORE.employees.map(e => ({
    id: e.id,
    name: e.name,
    avatar: e.avatar,
    role: e.role,
    status: e.status,
    sessionId: e.sessionId,
  }));
}

/** 获取总群标题 */
function _groupChatTitle(wsPath) {
  const wsName = wsPath ? wsPath.split(/[\/\\]/).filter(Boolean).pop() : 'workspace';
  return `${wsName}_总群`;
}

// ── 总群面板 ────────────────────────────────────────────────────────────────

/** 打开总群面板（替换右侧面板内容） */
async function openGroupChat() {
  let ws = typeof _currentCanvasWorkspace !== 'undefined' ? _currentCanvasWorkspace : '';
  // __default__ 表示未选择特定工作区，仍允许打开总群（使用默认路径）
  if (!ws || ws === '__default__') {
    ws = (S.session && S.session.workspace) || '';
  }
  // 最终兜底：从工作区列表获取第一个
  if (!ws) {
    try {
      const data = await api('/api/workspaces');
      const workspaces = data.workspaces || [];
      if (workspaces.length) ws = workspaces[0].path;
    } catch(_) {}
  }
  // 最终兜底：使用 _activeWorkspacePath()（统一的工作区解析函数）
  if (!ws && typeof _activeWorkspacePath === 'function') {
    ws = _activeWorkspacePath();
  }

  console.log('[总群] openGroupChat, ws=', ws, '_currentCanvasWorkspace=', typeof _currentCanvasWorkspace !== 'undefined' ? _currentCanvasWorkspace : '(undefined)');

  // 取消选中员工
  if (typeof EMPLOYEE_STORE !== 'undefined') EMPLOYEE_STORE.selectedId = null;
  document.querySelectorAll('.emp-card').forEach(c => c.classList.remove('emp-selected'));

  // 保存工作区到状态
  GROUP_CHAT_STATE.workspace = ws;

  // 先切换右侧面板视图并更新 UI（不等 API）
  _setRightPanelView('chat');
  GROUP_CHAT_STATE.isOpen = true;
  console.log('[总群] openGroupChat: isOpen set to true');

  // 更新头部 — 显示总群头像（不显示成员，成员在委派栏中）
  const avatarEl = $('rpEmployeeAvatar');
  if (avatarEl) avatarEl.innerHTML = '<span class="gc-avatar">🏠</span>';

  const nameEl = $('rpEmployeeName');
  if (nameEl) nameEl.textContent = _groupChatTitle(ws);

  _refreshGroupMembers();
  console.log('[总群] openGroupChat: members after refresh =', GROUP_CHAT_STATE.members.length, GROUP_CHAT_STATE.members.map(m => m.name));
  const roleEl = $('rpEmployeeRole');
  if (roleEl) roleEl.textContent = '';

  // 隐藏员工专用的头部按钮（编辑提示词、配置技能）
  const btnEditPrompt = $('btnEditPrompt');
  if (btnEditPrompt) btnEditPrompt.style.display = 'none';
  const btnCondense = $('btnCondenseSkill');
  if (btnCondense) btnCondense.style.display = 'none';
  const btnSkills = $('btnEmployeeSkills');
  if (btnSkills) btnSkills.style.display = 'none';

  // ★ 关键：在 await 之前就更新委派栏，确保显示正确
  _updateGroupDelegationBar();
  console.log('[总群] openGroupChat: _updateGroupDelegationBar called (before await)');

  // 渲染总群空状态（先渲染空状态，不等 API）
  _renderGroupMessages();

  // 异步加载总群数据，成功后刷新消息
  if (ws) {
    try {
      await loadGroupChat(ws);
      _renderGroupMessages();
    } catch(e) {
      console.warn('[总群] loadGroupChat 失败:', e);
    }
  }
}

/** 渲染总群消息 */
function _renderGroupMessages() {
  const inner = $('rpMsgInner');
  const emptyChat = $('rpEmptyChat');
  if (!inner) return;

  // 隐藏原有的"与员工开始对话"空状态（总群有自己的空状态）
  if (emptyChat) emptyChat.style.display = 'none';

  // 清空右侧面板原有的员工对话内容
  inner.innerHTML = '';

  const msgs = GROUP_CHAT_STATE.messages.filter(m => m && m.role && m.role !== 'tool');

  // 如果没有消息，显示总群空状态
  if (!msgs.length) {
    const emptyDiv = document.createElement('div');
    emptyDiv.className = 'gc-empty-state';
    emptyDiv.innerHTML = `
      <div class="gc-empty-icon">🏠</div>
      <div class="gc-empty-title">工作区总群</div>
      <div class="gc-empty-hint">发送消息或 @员工名 来委派任务</div>
    `;
    inner.appendChild(emptyDiv);
    return;
  }

  for (const m of msgs) {
    const content = _extractContent(m);
    if (!content && !m._mentions?.length) continue;

    const row = document.createElement('div');
    row.className = 'rp-msg-row gc-msg-row';
    row.dataset.role = m.role;

    // 发送者信息
    const senderName = m._sender || (m.role === 'user' ? '你' : m.role === 'system' ? '系统' : '助手');
    const senderAvatar = _senderAvatar(m);
    const isUser = m.role === 'user';
    const isSystem = m.role === 'system';

    // 处理 @mention 高亮
    let bodyHtml = isUser ? esc(String(content)).replace(/\n/g, '<br>') : renderMd(String(content));
    bodyHtml = _highlightMentions(bodyHtml);

    if (isSystem) {
      row.innerHTML = `
        <div class="rp-msg-role system" style="justify-content:center">
          <span class="gc-system-msg">${bodyHtml}</span>
        </div>
      `;
    } else {
      row.innerHTML = `
        <div class="rp-msg-role ${m.role}">
          <span class="rp-msg-icon">${senderAvatar}</span>
          <span class="rp-msg-name">${esc(senderName)}</span>${_fmtMsgTime(m)}
        </div>
        <div class="rp-msg-body">${bodyHtml}</div>
      `;
    }
    inner.appendChild(row);
  }

  // 滚动到底部
  const msgArea = $('rpMessages');
  if (msgArea) msgArea.scrollTop = msgArea.scrollHeight;
}

/** 获取发送者头像 */
function _senderAvatar(m) {
  const senderName = m._sender;
  if (senderName && typeof getEmployee === 'function') {
    const emp = EMPLOYEE_STORE.employees.find(e => e.name === senderName);
    if (emp) return emp.avatar;
  }
  return m.role === 'user' ? '👤' : '🤖';
}

/** 高亮 @mention */
function _highlightMentions(html) {
  // 在 HTML 中高亮 @名字，但避免影响 HTML 标签内的内容
  return html.replace(/@([\w\u4e00-\u9fff\u3400-\u4dbf]+)/g,
    '<span class="gc-mention" onclick="_onMentionClick(\'$1\')">@$1</span>');
}

/** 点击 @mention 时跳转到对应员工 */
function _onMentionClick(name) {
  if (typeof getEmployee !== 'function') return;
  const emp = EMPLOYEE_STORE.employees.find(e => e.name === name);
  if (emp) selectEmployee(emp.id, true);  // fromUser=true — 允许从总群跳转
}

/** 从消息对象提取内容 */
function _extractContent(m) {
  let content = m.content || '';
  // Extract from structured content
  if (Array.isArray(content)) content = content.filter(p => p.type === 'text').map(p => p.text || '').join('\n');
  let s = String(content).trim();
  // Strip thinking tags (defensive: in case old messages stored them)
  s = s.replace(/<think>[\s\S]*?<\/think>\s*/g, '').trimStart();
  s = s.replace(/<\|channel>thought\n[\s\S]*?<channel\|>\s*/g, '').trimStart();
  return s.trim();
}

// ── 发送总群消息 ─────────────────────────────────────────────────────────────

async function sendGroupMessage(text) {
  console.log('[总群] sendGroupMessage called, text=', text);
  let ws = typeof _currentCanvasWorkspace !== 'undefined' ? _currentCanvasWorkspace : (S.session?.workspace || '');
  // 兼容 __default__：回退到 session 或默认工作区
  if (!ws || ws === '__default__') {
    ws = S.session?.workspace || GROUP_CHAT_STATE.workspace || '';
  }
  console.log('[总群] sendGroupMessage, ws=', ws);
  if (!ws) {
    showToast('请先选择工作区');
    return;
  }

  if (!text.trim()) return;

  // 立即在聊天区显示用户消息（不等 API 返回）
  GROUP_CHAT_STATE.messages.push({
    role: 'user',
    content: text.trim(),
    _sender: '你',
    _ts: Date.now() / 1000,
  });
  _renderGroupMessages();

  try {
    console.log('[总群] sendGroupMessage: calling /api/group-chat/send...');
    const data = await api('/api/group-chat/send', {
      method: 'POST',
      body: JSON.stringify({
        workspace: ws,
        message: text.trim(),
        sender_name: '你',
      }),
    });
    console.log('[总群] sendGroupMessage response:', JSON.stringify(data).slice(0, 200));

    if (data.ok) {
      // 用服务端数据刷新（替换本地临时消息）
      await loadGroupChat(ws);
      _renderGroupMessages();

      // 如果有 @mention，委派任务给对应员工
      if (data.mentions && data.mentions.length) {
        console.log('[总群] mentions:', data.mentions);
        for (const mention of data.mentions) {
          _dispatchTaskToEmployee(mention.name, text.trim(), mention.task_id);
        }
      } else {
        console.log('[总群] 无 mentions');
      }
    } else {
      // API 返回了错误（非网络异常）
      const errMsg = data.error || data.message || '未知错误';
      showToast(`发送失败: ${errMsg}`);
      console.warn('[总群] send failed:', data);
    }
  } catch(e) {
    showToast('发送失败: ' + e.message);
    console.warn('[总群] send error:', e);
  }
}

/** 委派任务到指定员工 */
async function _dispatchTaskToEmployee(empName, taskContent, taskId) {
  console.log('[总群] _dispatchTaskToEmployee, empName=', empName, 'taskId=', taskId);
  if (typeof getEmployee !== 'function') {
    console.warn('[总群] getEmployee not available');
    return;
  }

  let emp = EMPLOYEE_STORE.employees.find(e => e.name === empName);

  // 员工不存在时，尝试从 AGENT_PRESETS 自动创建
  if (!emp) {
    console.log('[总群] 员工不存在，尝试自动创建:', empName);
    let presetMatch = null;
    if (typeof AGENT_PRESETS !== 'undefined') {
      presetMatch = AGENT_PRESETS.find(p => p.name === empName);
    }
    if (typeof createEmployee === 'function') {
      const opts = {
        name: empName,
        role: presetMatch ? presetMatch.role : '通用助手',
      };
      if (presetMatch) {
        opts.presetId = presetMatch.id;
        opts.characterImg = presetMatch.characterImg;
        opts.model = presetMatch.model;
        opts.skills = presetMatch.skills;
      }
      emp = createEmployee(opts);
      console.log('[总群] 自动创建员工成功:', empName, 'id=', emp.id);
      showToast(presetMatch
        ? `已从预设创建员工: ${empName}（${presetMatch.role}）`
        : `已创建员工: ${empName}`);
    } else {
      showToast(`未找到员工「${empName}」，且无法自动创建`);
      return;
    }
  }

  console.log('[总群] 员工找到:', emp.name, 'sessionId=', emp.sessionId);

  // 确保员工有会话
  if (!emp.sessionId) {
    console.log('[总群] 员工无会话，创建新会话...');
    try {
      let ws = typeof _currentCanvasWorkspace !== 'undefined' ? _currentCanvasWorkspace : (S.session?.workspace || '');
      if (ws === '__default__') ws = S.session?.workspace || GROUP_CHAT_STATE.workspace || '';
      const sessionData = await api('/api/session/new', {
        method: 'POST',
        body: JSON.stringify({ model: emp.model || $('modelSelect')?.value || '', workspace: ws || undefined }),
      });
      if (sessionData.session) {
        emp.sessionId = sessionData.session.session_id;
        if (typeof _saveEmployees === 'function') _saveEmployees();
        console.log('[总群] 会话创建成功:', emp.sessionId);
      }
    } catch(e) {
      showToast(`为「${empName}」创建会话失败: ${e.message}`);
      console.error('[总群] 创建会话失败:', e);
      return;
    }
  }

  // 更新员工状态
  if (typeof setEmployeeStatus === 'function') {
    setEmployeeStatus(emp.id, 'thinking');
  }

  // 构建 task 消息（去除 @名字 部分，保留任务内容）
  const taskMsg = taskContent.replace(new RegExp(`@${empName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*`, 'g'), '').trim();
  const fullTaskMsg = `[总群委派任务 #${taskId}]\n${taskMsg || '请执行任务'}`;
  console.log('[总群] 发送任务给员工:', fullTaskMsg);

  // 保存任务内容到员工对象，以便跳转到员工聊天框时显示
  emp._activeTaskContent = fullTaskMsg;

  // 获取员工 system prompt
  const sysPrompt = typeof buildEmployeeSystemPrompt === 'function' ? buildEmployeeSystemPrompt(emp) : '';
  const model = emp.model || $('modelSelect')?.value || '';

  try {
    console.log('[总群] 调用 /api/chat/start, session_id=', emp.sessionId, 'model=', model);
    const startData = await api('/api/chat/start', {
      method: 'POST',
      body: JSON.stringify({
        session_id: emp.sessionId,
        message: fullTaskMsg,
        model: model,
        workspace: emp.sessionId ? (await api(`/api/session?session_id=${encodeURIComponent(emp.sessionId)}`)).session?.workspace : undefined,
        system_prompt: sysPrompt || undefined,
      }),
    });

    const streamId = startData.stream_id;
    console.log('[总群] chat/start 返回, stream_id=', streamId);

    // 保存活跃流信息到员工对象，以便跳转到员工聊天框时能接入 SSE
    emp._activeStreamId = streamId;
    emp._activeTaskId = taskId;

    // 启动 SSE 监听，完成后将结果回传到总群
    _watchEmployeeStream(emp, streamId, taskId);
  } catch(e) {
    if (typeof setEmployeeStatus === 'function') setEmployeeStatus(emp.id, 'error');
    showToast(`委派任务给「${empName}」失败: ${e.message}`);
    console.error('[总群] 委派失败:', e);
  }
}

/** 从原始 token 文本中剥离思考标签，返回纯显示文本 */
function _stripThinkingTags(raw) {
  let s = raw;
  // 移除 thinking 标签 (DeepSeek/QwQ/MiniMax 等)
  s = s.replace(/<think>[\s\S]*?<\/think>\s*/g, '').trimStart();
  // 移除 Gemma 4 channel tokens
  s = s.replace(/<\|channel>thought\n[\s\S]*?<channel\|>\s*/g, '').trimStart();
  return s.trim();
}

/** 监听员工执行流的 SSE，完成后回传结果到总群 */
function _watchEmployeeStream(emp, streamId, taskId) {
  console.log('[总群] _watchEmployeeStream, emp=', emp.name, 'streamId=', streamId);
  const source = new EventSource(
    new URL(`/api/chat/stream?stream_id=${encodeURIComponent(streamId)}`, location.origin).href,
    { withCredentials: true }
  );

  let resultText = '';

  source.addEventListener('token', e => {
    try {
      const d = JSON.parse(e.data);
      resultText += d.text;
    } catch(_) {}
  });

  source.addEventListener('done', async e => {
    source.close();
    console.log('[总群] _watchEmployeeStream done, emp=', emp.name, 'resultLen=', resultText.length);
    if (typeof setEmployeeStatus === 'function') setEmployeeStatus(emp.id, 'idle');
    // 清除活跃流标记
    emp._activeStreamId = null;
    emp._activeTaskId = null;
    emp._activeTaskContent = null;

    // 剥离思考标签后回传到总群
    const displayResult = _stripThinkingTags(resultText.trim());
    if (displayResult) {
      let ws = typeof _currentCanvasWorkspace !== 'undefined' ? _currentCanvasWorkspace : (S.session?.workspace || '');
      if (ws === '__default__') ws = GROUP_CHAT_STATE.workspace || S.session?.workspace || '';
      try {
        await api('/api/group-chat/result', {
          method: 'POST',
          body: JSON.stringify({
            workspace: ws,
            employee_name: emp.name,
            task_id: taskId,
            result: displayResult,
            requester_name: '你',
          }),
        });
        // 刷新总群消息
        await loadGroupChat(ws);
        if (GROUP_CHAT_STATE.isOpen) _renderGroupMessages();
      } catch(e) {
        console.warn('回传结果失败:', e);
      }
    }
  });

  source.addEventListener('error', () => {
    source.close();
    console.warn('[总群] _watchEmployeeStream SSE error, emp=', emp.name);
    if (typeof setEmployeeStatus === 'function') setEmployeeStatus(emp.id, 'error');
    emp._activeStreamId = null;
    emp._activeTaskId = null;
    emp._activeTaskContent = null;
  });

  source.addEventListener('apperror', () => {
    source.close();
    console.warn('[总群] _watchEmployeeStream SSE apperror, emp=', emp.name);
    if (typeof setEmployeeStatus === 'function') setEmployeeStatus(emp.id, 'error');
    emp._activeStreamId = null;
    emp._activeTaskId = null;
    emp._activeTaskContent = null;
  });
}

// ── 委派栏更新（添加总群链接）────────────────────────────────────

function _updateGroupDelegationBar() {
  const bar = $('rpDelegationBar');
  const info = $('rpDelegationInfo');
  if (!bar || !info) return;

  console.log('[总群] _updateGroupDelegationBar called, isOpen=', GROUP_CHAT_STATE.isOpen, 'employees=', typeof EMPLOYEE_STORE !== 'undefined' ? EMPLOYEE_STORE.employees.length : 'N/A', 'selectedId=', typeof EMPLOYEE_STORE !== 'undefined' ? EMPLOYEE_STORE.selectedId : 'N/A');

  const parts = [];

  // 总群链接 — 多级兜底获取工作区路径
  let ws = GROUP_CHAT_STATE.workspace || '';
  if (!ws || ws === '__default__') ws = (typeof _currentCanvasWorkspace !== 'undefined' ? _currentCanvasWorkspace : '');
  if (!ws || ws === '__default__') ws = (S.session?.workspace || '');
  if (!ws || ws === '__default__') ws = (typeof _activeWorkspacePath === 'function' ? _activeWorkspacePath() : '');
  if (!ws && typeof _currentCanvasWorkspace !== 'undefined') ws = _currentCanvasWorkspace;
  if (ws) {
    const groupTitle = _groupChatTitle(ws);
    parts.push(`<span class="rp-del-label">总群：</span><span class="rp-del-name gc-link" onclick="openGroupChat()" title="打开${esc(groupTitle)}">${esc(groupTitle)}</span>`);
  }

  // 成员（总群打开时显示，按层级分组）
  if (GROUP_CHAT_STATE.isOpen) {
    _refreshGroupMembers();
    const members = GROUP_CHAT_STATE.members;
    if (members.length) {
      // 按角色层级显示成员
      if (typeof getSubagentsOf === 'function') {
        // 找出顶层管理者（没有 subagentOf 的员工）
        const topManagers = members.filter(m => {
          const emp = getEmployee(m.id);
          return emp && !emp.subagentOf;
        });
        // 递归构建层级树
        const _buildHierarchy = (empId, depth) => {
          const emp = getEmployee(empId);
          if (!emp) return [];
          const result = [{ id: emp.id, name: emp.name, role: emp.role, depth }];
          const subs = getSubagentsOf(empId);
          for (const s of subs) {
            result.push(..._buildHierarchy(s.to, depth + 1));
          }
          return result;
        };
        // 构建完整层级
        const hierarchy = [];
        for (const mgr of topManagers) {
          hierarchy.push(..._buildHierarchy(mgr.id, 0));
        }
        // 也加入没有出现在层级中的成员
        const hierarchyIds = new Set(hierarchy.map(h => h.id));
        for (const m of members) {
          if (!hierarchyIds.has(m.id)) {
            hierarchy.push({ id: m.id, name: m.name, role: m.role, depth: -1 });
          }
        }
        // 渲染层级信息
        if (hierarchy.length) {
          const hierarchyHtml = hierarchy.map(h => {
            const indent = h.depth > 0 ? `<span style="margin-left:${h.depth * 12}px">↳ </span>` : '';
            return `${indent}<span class="rp-del-name gc-link" onclick="selectEmployee('${esc(h.id)}', true)" title="查看${esc(h.name)}">${esc(h.name)}</span>`;
          }).join('、');
          parts.push(`<span class="rp-del-label">成员：</span><span class="rp-del-names">${hierarchyHtml}</span>`);
        }
      } else {
        // 回退：简单列出成员
        const memberLinks = members.map(m =>
          `<span class="rp-del-name gc-link" onclick="selectEmployee('${esc(m.id)}', true)" title="查看${esc(m.name)}">${esc(m.name)}</span>`
        ).join('、');
        parts.push(`<span class="rp-del-label">成员：</span><span class="rp-del-names">${memberLinks}</span>`);
      }
    }
  } else {
    // 非总群模式：显示当前员工的上级/下属
    const emp = typeof EMPLOYEE_STORE !== 'undefined' ? getEmployee(EMPLOYEE_STORE.selectedId) : null;
    if (emp && emp.subagentOf && typeof getEmployee === 'function') {
      const mgr = getEmployee(emp.subagentOf);
      if (mgr) {
        parts.push(`<span class="rp-del-label">上级：</span><span class="rp-del-name" onclick="selectEmployee('${mgr.id}')">${esc(mgr.name)}</span>`);
      }
    }
  }

  if (parts.length) {
    info.innerHTML = parts.join('<span class="rp-del-sep">|</span>');
    bar.style.display = '';
  } else {
    bar.style.display = 'none';
  }
}

// ── @mention 输入补全 ────────────────────────────────────────────────────────

let _mentionDropdown = null;
let _mentionStart = -1;  // @ 符号在输入框中的位置

/** 初始化 @mention 补全 */
function initMentionAutocomplete() {
  const msgEl = $('msg');
  if (!msgEl) return;

  msgEl.addEventListener('input', _onMentionInput);
  msgEl.addEventListener('keydown', _onMentionKeydown);
}

function _onMentionInput(e) {
  const el = e.target;
  const text = el.value;
  const pos = el.selectionStart;

  // 查找当前位置的 @mention
  const beforeCursor = text.slice(0, pos);
  const atMatch = beforeCursor.match(/@([\w\u4e00-\u9fff\u3400-\u4dbf]*)$/);

  if (atMatch) {
    _mentionStart = pos - atMatch[0].length;
    const query = atMatch[1].toLowerCase();
    _showMentionDropdown(query, el);
  } else {
    _hideMentionDropdown();
  }
}

function _onMentionKeydown(e) {
  if (!_mentionDropdown || !_mentionDropdown.style.display || _mentionDropdown.style.display === 'none') return;

  const items = _mentionDropdown.querySelectorAll('.gc-mention-item');
  let activeIdx = -1;
  items.forEach((item, i) => { if (item.classList.contains('active')) activeIdx = i; });

  if (e.key === 'ArrowDown') {
    e.preventDefault();
    items.forEach(i => i.classList.remove('active'));
    activeIdx = (activeIdx + 1) % items.length;
    if (items[activeIdx]) items[activeIdx].classList.add('active');
  } else if (e.key === 'ArrowUp') {
    e.preventDefault();
    items.forEach(i => i.classList.remove('active'));
    activeIdx = (activeIdx - 1 + items.length) % items.length;
    if (items[activeIdx]) items[activeIdx].classList.add('active');
  } else if (e.key === 'Enter' || e.key === 'Tab') {
    if (activeIdx >= 0 && items[activeIdx]) {
      e.preventDefault();
      _insertMention(items[activeIdx].dataset.name, e.target);
    }
  } else if (e.key === 'Escape') {
    _hideMentionDropdown();
  }
}

function _showMentionDropdown(query, inputEl) {
  let candidates;

  if (GROUP_CHAT_STATE.isOpen) {
    // 总群模式：可以 @ 任意成员
    _refreshGroupMembers();
    candidates = GROUP_CHAT_STATE.members;
  } else {
    // 员工聊天模式：只允许 @ 下属
    candidates = [];
    const empId = typeof EMPLOYEE_STORE !== 'undefined' ? EMPLOYEE_STORE.selectedId : null;
    if (empId && typeof getSubagentsOf === 'function') {
      const subs = getSubagentsOf(empId);
      if (subs && subs.length) {
        candidates = subs.map(s => s.employee).filter(Boolean);
      }
    }
  }

  const filtered = candidates.filter(m => m.name.toLowerCase().includes(query));

  if (!filtered.length) { _hideMentionDropdown(); return; }

  if (!_mentionDropdown) {
    _mentionDropdown = document.createElement('div');
    _mentionDropdown.className = 'gc-mention-dropdown';
    document.body.appendChild(_mentionDropdown);
  }

  _mentionDropdown.innerHTML = filtered.slice(0, 8).map((m, i) =>
    `<div class="gc-mention-item${i === 0 ? ' active' : ''}" data-name="${esc(m.name)}" onclick="_insertMention('${esc(m.name)}', $('msg'))">${m.avatar} ${esc(m.name)} <span class="gc-mention-role">${esc(m.role)}</span></div>`
  ).join('');

  // 定位到输入框下方
  const rect = inputEl.getBoundingClientRect();
  _mentionDropdown.style.position = 'fixed';
  _mentionDropdown.style.left = rect.left + 'px';
  _mentionDropdown.style.bottom = (window.innerHeight - rect.top + 4) + 'px';
  _mentionDropdown.style.display = 'block';

  // 点击外部关闭
  setTimeout(() => {
    document.addEventListener('click', function hide(e) {
      if (!_mentionDropdown.contains(e.target)) {
        _hideMentionDropdown();
        document.removeEventListener('click', hide);
      }
    });
  }, 10);
}

function _hideMentionDropdown() {
  if (_mentionDropdown) _mentionDropdown.style.display = 'none';
}

function _insertMention(name, inputEl) {
  if (!inputEl) return;
  const text = inputEl.value;
  const pos = inputEl.selectionStart;
  // 替换从 @ 开始到当前位置的文本
  const before = text.slice(0, _mentionStart);
  const after = text.slice(pos);
  inputEl.value = before + '@' + name + ' ' + after;
  const newPos = _mentionStart + name.length + 2;
  inputEl.setSelectionRange(newPos, newPos);
  inputEl.focus();
  if (typeof autoResize === 'function') autoResize();
  _hideMentionDropdown();
}

// ── 修改原 _updateDelegationBar 以包含总群链接 ──────────────────────────────
// 保存原始函数引用
const _origUpdateDelegationBar = typeof _updateDelegationBar === 'function' ? _updateDelegationBar : null;

// 覆盖 _updateDelegationBar 使其包含总群链接
function _updateDelegationBarWithGroupChat(emp) {
  console.log('[总群] _updateDelegationBarWithGroupChat called, isOpen=', GROUP_CHAT_STATE.isOpen, 'emp=', emp?.name || null);
  const bar = $('rpDelegationBar');
  const info = $('rpDelegationInfo');
  if (!bar || !info) return;

  // 总群打开时，走总群委派栏逻辑（不受 emp 为 null 影响）
  if (GROUP_CHAT_STATE.isOpen) {
    _updateGroupDelegationBar();
    return;
  }

  if (!emp) { bar.style.display = 'none'; return; }

  const parts = [];

  // 总群链接（始终显示在最前）— 多级兜底获取工作区路径
  let ws = GROUP_CHAT_STATE.workspace || '';
  if (!ws || ws === '__default__') ws = (typeof _currentCanvasWorkspace !== 'undefined' ? _currentCanvasWorkspace : '');
  if (!ws || ws === '__default__') ws = (S.session?.workspace || '');
  if (!ws || ws === '__default__') ws = (typeof _activeWorkspacePath === 'function' ? _activeWorkspacePath() : '');
  // 最终兜底：使用 _currentCanvasWorkspace 即使是 __default__（确保始终有总群名）
  if (!ws && typeof _currentCanvasWorkspace !== 'undefined') ws = _currentCanvasWorkspace;
  if (ws) {
    const groupTitle = _groupChatTitle(ws);
    parts.push(`<span class="rp-del-label">总群：</span><span class="rp-del-name gc-link" onclick="openGroupChat()" title="打开${esc(groupTitle)}">${esc(groupTitle)}</span>`);
  }

  // 上级
  if (emp.subagentOf && typeof getEmployee === 'function') {
    const mgr = getEmployee(emp.subagentOf);
    if (mgr) {
      parts.push(`<span class="rp-del-label">上级：</span><span class="rp-del-name" onclick="selectEmployee('${mgr.id}')">${esc(mgr.name)}</span>`);
    }
  }

  // 下属
  if (typeof getSubagentsOf === 'function') {
    const subs = getSubagentsOf(emp.id);
    if (subs && subs.length) {
      const subLinks = subs.map(s =>
        `<span class="rp-del-name" onclick="selectEmployee('${s.to}')">${esc(s.employee?.name || '?')}</span>`
      ).join('、');
      parts.push(`<span class="rp-del-label">下属：</span><span class="rp-del-names">${subLinks}</span>`);
    }
  }

  if (parts.length) {
    info.innerHTML = parts.join('<span class="rp-del-sep">|</span>');
    bar.style.display = '';
  } else {
    bar.style.display = 'none';
  }

  // 异步加载委派历史
  _loadDelegationHistory(emp);
}

// ── 初始化 ──────────────────────────────────────────────────────────────────
function initGroupChat() {
  // 覆盖 _updateDelegationBar 以包含总群链接
  // 注意：这必须在 right-panel.js 加载后执行
  window._updateDelegationBar = _updateDelegationBarWithGroupChat;

  // 初始化 @mention 补全
  initMentionAutocomplete();

  // 立即刷新委派栏，确保总群链接在页面初始加载时显示
  // （initRightPanel 在 initGroupChat 之前执行，此时 _updateDelegationBar 还是原始版本）
  if (typeof EMPLOYEE_STORE !== 'undefined' && EMPLOYEE_STORE.selectedId && typeof getEmployee === 'function') {
    const emp = getEmployee(EMPLOYEE_STORE.selectedId);
    if (emp) _updateDelegationBar(emp);
  } else if (typeof GROUP_CHAT_STATE !== 'undefined' && GROUP_CHAT_STATE.isOpen) {
    _updateGroupDelegationBar();
  }
}
