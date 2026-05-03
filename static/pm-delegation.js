/**
 * group-chat.js — PM 聊天功能
 *
 * PM 是被标记为 isPM 的员工，任务委派和结果回传都通过 PM 会话进行。
 * 支持通过 @员工名 委派任务，员工执行结果回传到 PM 聊天框。
 */

// ── PM专员名称（全局常量，避免硬编码） ────────────────────────────────────────
// 注意：PM_NAME 是兜底默认值，实际显示名由 pm-manager.js::getCurrentPMName() 动态提供。
const PM_NAME = 'PM专员';

// ── PM 辅助函数 ─────────────────────────────────────────────────────────
/** 获取 PM 员工的 sessionId */
function _getPMSessionId() {
  const pm = (typeof getPMEmployee === 'function') ? getPMEmployee() : null;
  return pm?.sessionId || null;
}

/** 判断当前是否处于 PM 聊天状态
 *  新逻辑：检查 S.sessionId 是否等于 PM sessionId（即当前右侧面板是否正在显示 PM 会话）
 *  旧逻辑（PM 员工是否被选中）不够准确：PM 委派栏打开时用户可能选中了其他员工
 */
function _isPMChatOpen() {
  const pmSessionId = (typeof _getPMSessionId === 'function') ? _getPMSessionId() : null;
  if (!pmSessionId) return false;
  // 当前右侧面板正在显示 PM 会话 → 认为 PM 聊天已打开
  if (S && S.session && S.session.session_id === pmSessionId) return true;
  // 兼容旧逻辑：PM 员工被选中
  const pm = (typeof getPMEmployee === 'function') ? getPMEmployee() : null;
  return !!(pm && (typeof EMPLOYEE_STORE !== 'undefined') && EMPLOYEE_STORE.selectedId === pm.id);
}

/** 获取所有员工成员列表 */
function _getAllMembers() {
  if (typeof EMPLOYEE_STORE === 'undefined') return [];
  return EMPLOYEE_STORE.employees.map(e => ({
    id: e.id, name: e.name, avatar: e.avatar,
    role: e.role, status: e.status, sessionId: e.sessionId,
  }));
}

/** 获取当前工作区 */
function _getCurrentWorkspace() {
  return (typeof _currentCanvasWorkspace !== 'undefined') ? _currentCanvasWorkspace : '';
}

// ── 自动协作模式状态 ─────────────────────────────────────────────────────
let _autoOrchestrate = (localStorage.getItem('gc_auto_orchestrate') === '1');

// ── 向后兼容：GROUP_CHAT_STATE（最小化兼容层，供外部可能的引用） ──────────────
const GROUP_CHAT_STATE = {
  get sessionId() { return _getPMSessionId(); },
  set sessionId(v) {},
  get isOpen() { return _isPMChatOpen(); },
  set isOpen(v) {},
  get members() { return _getAllMembers(); },
  set members(v) {},
  get workspace() { return _getCurrentWorkspace(); },
  set workspace(v) {},
  get messages() { return []; },
  set messages(v) {},
  get autoOrchestrate() { return _autoOrchestrate; },
  set autoOrchestrate(v) { _autoOrchestrate = !!v; },
};

/** 切换自动协作模式（与心跳联动，通过 setActiveAutoCollabEmpId 统一管理） */
function toggleAutoOrchestrate() {
  const activeId = getActiveAutoCollabEmpId();
  if (activeId) {
    setActiveAutoCollabEmpId(null);
    if (typeof showToast === 'function') showToast('⏸ 自动协作已关闭，PM身份已取消');
  } else {
    const firstEmp = (typeof EMPLOYEE_STORE !== 'undefined') ? EMPLOYEE_STORE.employees[0] : null;
    if (firstEmp) {
      setActiveAutoCollabEmpId(firstEmp.id);
      if (typeof showToast === 'function') showToast(`✅ ${firstEmp.name} 设为PM并开启协作`);
    }
  }
}

// ── 加载 PM 会话数据 ─────────────────────────────────────────────────────────
async function loadPMSession(workspace) {
  if (!workspace) return null;
  const pm = (typeof getPMEmployee === 'function') ? getPMEmployee() : null;
  if (pm && pm.sessionId) {
    try {
      const data = await api(`/api/session?session_id=${encodeURIComponent(pm.sessionId)}`);
      return { session_id: pm.sessionId, messages: (data.session && data.session.messages) || [] };
    } catch(e) {
      console.warn('加载PM会话失败:', e);
    }
  }
  return null;
}
// 向后兼容别名
const loadGroupChat = loadPMSession;

/**
 * 向 PM session 添加系统消息（替代旧的 /api/group-chat/send）
 * @param {string} message - 消息内容
 * @param {string} senderName - 发送者名称
 */
async function _addPMSessionMessage(message, senderName) {
  const pmSessionId = _getPMSessionId();
  if (!pmSessionId) {
    console.warn('[PM] _addPMSessionMessage 跳过：pmSessionId 为空 (PM 员工可能未创建或无 sessionId)');
    return;
  }
  try {
    await api('/api/session/message', {
      method: 'POST',
      body: JSON.stringify({
        session_id: pmSessionId,
        role: 'user',
        content: `[${senderName || '系统'}] ${message}`,
      }),
    });
    // 成功后刷新 PM 聊天（如已打开）
    if (_isPMChatOpen() && typeof _renderGroupMessages === 'function') {
      _renderGroupMessages();
    }
  } catch (e) {
    console.warn('[PM] 添加 session 消息失败:', e);
  }
}

/**
 * 向 PM session 回传员工执行结果（替代旧的 /api/group-chat/result）
 * @param {object} opts - { workspace, employee_name, task_id, result, requester_name }
 */
async function _postResultToPMSession(opts) {
  const pmSessionId = _getPMSessionId();
  if (!pmSessionId) {
    console.warn('[PM] _postResultToPMSession 跳过：pmSessionId 为空 (PM 员工可能未创建或无 sessionId)',
      'empName=', opts.employee_name, 'taskId=', opts.task_id);
    return;
  }
  try {
    const fullResult = String(opts.result || '');
    // ★ 2026-05-01：结果保留前 2000 字符（从 200 扩大到 2000，避免上下文重要信息被截断）
    const MAX_LEN = 2000;
    const summary = fullResult.slice(0, MAX_LEN);
    const content = `[${opts.employee_name} 完成任务 #${opts.task_id}]\n${summary}${fullResult.length > MAX_LEN ? `\n\n...(结果已截断，完整内容共 ${fullResult.length} 字符)` : ''}`;
    console.log('[PM] _postResultToPMSession POST, empName=', opts.employee_name, 'taskId=', opts.task_id,
      'pmSessionId=', pmSessionId, 'resultLen=', fullResult.length, 'contentLen=', content.length);
    await api('/api/session/message', {
      method: 'POST',
      body: JSON.stringify({
        session_id: pmSessionId,
        role: 'user',
        content,
        timestamp: Date.now() / 1000,
      }),
    });
    console.log('[PM] _postResultToPMSession POST 成功，taskId=', opts.task_id);
    // 成功后刷新 PM 聊天（如已打开）
    if (_isPMChatOpen() && typeof _renderGroupMessages === 'function') {
      _renderGroupMessages();
    }
  } catch (e) {
    console.warn('[PM] 回传结果失败:', e, 'taskId=', opts.task_id);
  }
}

/** 刷新成员列表（直接从 _getAllMembers() 实时获取） */
function _refreshGroupMembers() {
  // No-op: 成员始终从 _getAllMembers() 实时获取
}

/** 获取PM聊天标题 */
function _groupChatTitle() {
  return 'PM';
}

/** 查找适合的"PM"（用于自动协作模式）
 *  优先级：
 *    1) 名为"制作人"、"项目经理"、"Producer"、"Project Manager" 的员工
 *    2) presetId 为 producer / technical-director / creative-director / art-director 的员工
 *    3) 角色含"总监"、"经理"、"Director"、"Manager" 的员工
 *    4) 首个员工（兜底）
 */
function _findOrchestratorEmployee() {
  if (typeof EMPLOYEE_STORE === 'undefined') return null;
  const emps = EMPLOYEE_STORE.employees || [];
  if (!emps.length) return null;

  // 优先名字匹配
  const nameMatches = ['制作人', '项目经理', 'Producer', 'Project Manager'];
  for (const name of nameMatches) {
    const e = emps.find(x => x.name === name);
    if (e) return e;
  }

  // 预设 ID 匹配
  const presetMatches = ['producer', 'technical-director', 'creative-director', 'art-director'];
  for (const pid of presetMatches) {
    const e = emps.find(x => x.presetId === pid);
    if (e) return e;
  }

  // 角色关键词匹配
  const leadKeywords = ['总监', '经理', 'Director', 'Manager', 'Lead'];
  for (const kw of leadKeywords) {
    const e = emps.find(x => String(x.role || '').includes(kw));
    if (e) return e;
  }

  // 兜底
  return emps[0];
}


// ── 总群面板 ────────────────────────────────────────────────────────────────

/** 打开PM聊天框（重定向：不再打开总群面板，改为导航到PM员工聊天） */
async function openGroupChat() {
  const pm = (typeof getPMEmployee === 'function') ? getPMEmployee() : null;
  if (pm && typeof selectEmployee === 'function') {
    selectEmployee(pm.id, true);
  } else {
    if (typeof showToast === 'function') showToast('未设置PM');
  }
}

/** 渲染系统消息正文内容（识别 {{TASK_LINK:xxx}} 占位符转为可点击锚点）
 *  @param {string} content - 消息原文
 *  @param {object} msg     - 消息对象（用于兼容旧格式，读取 _task_ids）
 */
function _renderSystemMessageContent(content, msg) {
  const lines = String(content).split('\n');
  const taskIds = (msg && Array.isArray(msg._task_ids)) ? msg._task_ids : [];

  const rendered = lines.map(line => {
    // ★ 路径 1：含新版 {{TASK_LINK:xxx}} 占位符 — 直接替换
    if (/\{\{TASK_LINK:(task-[A-Za-z0-9_-]+)\}\}/.test(line)) {
      let html = esc(line);
      html = html.replace(/\{\{TASK_LINK:(task-[A-Za-z0-9_-]+)\}\}/g, (_, tid) => {
        return `<a href="#" class="gc-task-link" data-task-id="${esc(tid)}" onclick="event.preventDefault();jumpToGroupChatTask('${esc(tid)}');return false;" title="点击跳转到该任务相关位置">[#${esc(tid)}]</a>`;
      });
      html = html.replace(/@([\w\u4e00-\u9fff]+)/g, (_match, name) => {
        const escName = esc(name);
        return `<span class="gc-mention" onclick="_onMentionClick('${escName}')" style="cursor:pointer">@${escName}</span>`;
      });
      return html;
    }

    // ★ 路径 2：旧版"已将任务委派给 @X、@Y..."— 在每个 @Name 前插入对应 task_id 链接
    if (/^已将任务委派给\s/.test(line) && taskIds.length) {
      // 按出现顺序匹配 @名字，对应 taskIds[0], taskIds[1], ...
      let escHtml = esc(line);
      let tidIdx = 0;
      escHtml = escHtml.replace(/@([\w\u4e00-\u9fff]+)/g, (_match, name) => {
        const escName = esc(name);
        const tid = taskIds[tidIdx++];
        const linkPart = (tid && /^task-[A-Za-z0-9_-]+$/.test(tid))
          ? `<a href="#" class="gc-task-link" data-task-id="${esc(tid)}" onclick="event.preventDefault();jumpToGroupChatTask('${esc(tid)}');return false;" title="点击跳转到该任务相关位置">[#${esc(tid)}]</a> `
          : '';
        return `${linkPart}<span class="gc-mention" onclick="_onMentionClick('${escName}')" style="cursor:pointer">@${escName}</span>`;
      });
      return escHtml;
    }

    // ★ 路径 3：其他系统消息 — 正常转义 + @mention 点击 + 若有单个 task_id 则追加链接
    let html = esc(line);
    if (taskIds.length === 1 && /^task-[A-Za-z0-9_-]+$/.test(taskIds[0])) {
      const tid = taskIds[0];
      html += ` <a href="#" class="gc-task-link" data-task-id="${esc(tid)}" onclick="event.preventDefault();jumpToGroupChatTask('${esc(tid)}');return false;" title="点击跳转到该任务相关位置">[#${esc(tid)}]</a>`;
    }
    html = html.replace(/@([\w\u4e00-\u9fff]+)/g, (_match, name) => {
      const escName = esc(name);
      return `<span class="gc-mention" onclick="_onMentionClick('${escName}')" style="cursor:pointer">@${escName}</span>`;
    });
    return html;
  });
  return rendered.join('<br>');
}

/** 渲染总群消息（DEPRECATED: 总群概念已移除）
 *  PM聊天框的消息由 _renderRpMessages() 统一渲染。
 */
function _renderGroupMessages() {
  // ★ 刷新 PM 聊天：重新加载 PM session 消息 → 更新 S.messages → 渲染
  if (!_isPMChatOpen()) return;
  const pm = (typeof getPMEmployee === 'function') ? getPMEmployee() : null;
  if (!pm || !pm.sessionId) return;
  api(`/api/session?session_id=${encodeURIComponent(pm.sessionId)}`).then(data => {
    // ★★★ 异步守卫：回调到达时用户可能已切换到其他员工聊天，
    //     此时若继续写入 S.messages 会把 PM 的消息覆盖到当前员工的渲染状态，
    //     导致该员工聊天框里的思考过程、工具调用消失（竞态 bug）。
    if (!_isPMChatOpen()) {
      console.log('[PM] _renderGroupMessages 回调丢弃：用户已切换到其他员工聊天');
      return;
    }
    // ★★★ 修复：检查 messages 非空（长度>0），防止后端异常时返回 messages:[] 清空前端已有的消息
    if (data && data.session && data.session.messages && data.session.messages.length > 0) {
      S.session = data.session;
      S.messages = data.session.messages || [];
      if (typeof _ensureDelegationDividersForMainSession === 'function') {
        _ensureDelegationDividersForMainSession(pm);
      }
      if (typeof _renderRpMessages === 'function') _renderRpMessages();
      if (typeof _scrollMsgAreaIfSticky === 'function') _scrollMsgAreaIfSticky();
    }
  }).catch(e => {
    console.warn('[PM] 刷新PM聊天失败:', e);
  });
}

/**
 * ★ SSE error/apperror 后的刷新逻辑（3路径降级，与 done 处理一致）
 *   路径 1: 从 /api/session 获取 session 数据
 *   路径 2: 固化 live DOM + 将积累内容写入 S.messages
 */
async function _refreshAfterStreamEnd(pmSessionId, streamingRow) {
  // 路径 1：从后端拉取
  if (pmSessionId && _isPMChatOpen()) {
    try {
      const sessData = await api(`/api/session?session_id=${encodeURIComponent(pmSessionId)}`);
      // ★★★ 异步守卫：await 期间用户可能已切换到其他员工聊天
      if (!_isPMChatOpen()) {
        console.log('[PM] _refreshAfterStreamEnd 丢弃：用户已切换到其他员工聊天');
        return;
      }
      if (sessData && sessData.session && sessData.session.messages && sessData.session.messages.length > 0) {
        S.session = sessData.session;
        S.messages = sessData.session.messages || [];
        if (typeof _ensureDelegationDividersForMainSession === 'function') {
          const pm = (typeof getPMEmployee === 'function') ? getPMEmployee() : null;
          if (pm) _ensureDelegationDividersForMainSession(pm);
        }
        if (streamingRow) { streamingRow.remove(); }
        if (typeof _renderRpMessages === 'function') _renderRpMessages();
        if (typeof _scrollMsgAreaToBottom === 'function') _scrollMsgAreaToBottom();
        return;
      }
    } catch(e) {
      console.warn('[PM] _refreshAfterStreamEnd path1 失败:', e);
    }
  }
  // 路径 2：保留 streaming DOM（不做额外操作，卡片已在调用方固化）
}



/**
 * 点击任务链接（如 #task-xxx）时的跳转逻辑：
 *  - 总群面板中点击：跳转到对应员工的聊天框，定位到该任务消息
 *  - 员工聊天框中点击委派前缀链接：跳转到总群对应消息（原有行为）
 *
 * 判断依据：若当前在PM（isPM）聊天框中，视为"从PM点击"→ 跳转到员工聊天框
 *           否则视为"从员工聊天框点击"→ 跳转到PM聊天框
 */
async function jumpToGroupChatTask(taskId) {
  if (!taskId) return;
  const pmEmp = (typeof getPMEmployee === 'function') ? getPMEmployee() : null;
  const isCoordinatorChat = pmEmp && typeof EMPLOYEE_STORE !== 'undefined'
    && EMPLOYEE_STORE.selectedId === pmEmp.id;
  console.log('[任务跳转] taskId=', taskId, 'isCoordinatorChat=', isCoordinatorChat);

  // ── 路径 A：从PM聊天框点击 → 跳转到员工聊天框 ──
  if (isCoordinatorChat) {
    // 1) 从 taskId 找到员工
    let empId = null;
    if (typeof DelegationVM !== 'undefined') {
      const job = DelegationVM.findJob ? DelegationVM.findJob(taskId) : null;
      if (job) empId = job.empId;
      if (!empId) {
        // 查找队列中的 job
        if (DelegationVM.queues) {
          for (const [eid, q] of DelegationVM.queues.entries()) {
            if (q.some(j => j && j.id === taskId)) { empId = eid; break; }
          }
        }
      }
    }
    // 兜底：遍历所有员工，查找 sessionId 中包含该 taskId 的 session
    if (!empId && typeof getEmployee === 'function' && typeof EMPLOYEE_STORE !== 'undefined') {
      // 从 DelegationVM.tasks 中找
      if (typeof DelegationVM !== 'undefined' && DelegationVM.getTask) {
        const task = DelegationVM.getTask(taskId);
        if (task && task.empId) empId = task.empId;
      }
    }
    // ★ 兜底：从 localStorage 持久化映射中恢复（页面刷新后内存 Map 为空）
    if (!empId && typeof DelegationVM !== 'undefined' && DelegationVM.getPersistedTask) {
      const meta = DelegationVM.getPersistedTask(taskId);
      if (meta && meta.empId) {
        empId = meta.empId;
        console.log('[任务跳转] 从持久化映射恢复 empId:', empId, 'taskId:', taskId);
      }
    }
    if (!empId) {
      // 最终兜底：从总群消息中推断——找包含该 taskId 的 @mention 消息，取被 mention 的员工
      const inner = $('rpMsgInner');
      if (inner) {
        const rows = inner.querySelectorAll('.gc-msg-row[data-task-ids]');
        for (const r of rows) {
          const ids = (r.dataset.taskIds || '').split(',').map(s => s.trim());
          if (ids.includes(taskId)) {
            // 尝试从消息文本中提取 @员工名
            const text = r.textContent || '';
            const mMatch = text.match(/@([\w\u4e00-\u9fff\u3400-\u4dbf]+)/);
            if (mMatch && typeof getEmployee === 'function') {
              // 按名字查找
              const allEmps = EMPLOYEE_STORE.employees || [];
              const found = allEmps.find(e => e.name === mMatch[1]);
              if (found) { empId = found.id; break; }
            }
            break;
          }
        }
      }
    }

    if (!empId) {
      console.warn('[任务跳转] 未找到 taskId 对应的员工:', taskId);
      if (typeof showToast === 'function') showToast('未找到对应的员工');
      return;
    }

    // 2) 切换到员工聊天框（★ 传 taskId 以便加载委派任务的独立 session）
    if (typeof selectEmployee === 'function') {
      selectEmployee(empId, true, taskId);
    }

    // 3) 等待聊天框渲染后，滚动到含该 taskId 的消息
    //    selectEmployee 会触发 openEmployeeChat → _renderChatHistory（异步）
    //    用重试机制确保历史加载完毕
    let _retryCount = 0;
    const _retryScroll = () => {
      const found = _scrollToEmployeeTask(taskId);
      if (!found && _retryCount < 5) {
        _retryCount++;
        setTimeout(_retryScroll, 400);
      }
    };
    setTimeout(_retryScroll, 400);
    return;
  }

  // ── 路径 B：从员工聊天框点击 → 跳转到PM聊天框 ──
  console.log('[跳转PM] taskId=', taskId);

  if (pmEmp) {
    selectEmployee(pmEmp.id, true, taskId);
    let _retryCount = 0;
    const _retryScroll = () => {
      const found = _scrollToEmployeeTask(taskId);
      if (!found && _retryCount < 5) {
        _retryCount++;
        setTimeout(_retryScroll, 400);
      }
    };
    setTimeout(_retryScroll, 400);
  } else {
    if (typeof showToast === 'function') showToast('未设置PM');
  }
}

/** 在总群 DOM 中定位并高亮指定 taskId 对应的消息 */
function _scrollToGroupChatTask(taskId) {
  const inner = $('rpMsgInner');
  if (!inner) return;

  // 优先匹配 data-task-id（assistant 结果消息）
  let target = inner.querySelector(`.gc-msg-row[data-task-id="${CSS.escape(taskId)}"]`);

  // 其次匹配 data-task-ids 包含（user 原始委派消息 / 系统派发消息）
  if (!target) {
    const rows = inner.querySelectorAll('.gc-msg-row[data-task-ids]');
    for (const r of rows) {
      const ids = (r.dataset.taskIds || '').split(',').map(s => s.trim());
      if (ids.includes(taskId)) {
        target = r;
        break;
      }
    }
  }

  if (!target) {
    console.warn('[跳转总群] 未找到 taskId 对应的消息:', taskId);
    if (typeof showToast === 'function') showToast('未找到对应的总群消息');
    return;
  }

  // 滚动到目标位置
  target.scrollIntoView({ behavior: 'smooth', block: 'center' });

  // 临时高亮（2 秒后移除）
  target.classList.add('gc-msg-highlight');
  setTimeout(() => target.classList.remove('gc-msg-highlight'), 2500);
}

/** 在员工聊天框 DOM 中定位并高亮指定 taskId 对应的消息
 *  @returns {boolean} 是否找到并滚动成功
 */
function _scrollToEmployeeTask(taskId) {
  const inner = $('rpMsgInner');
  if (!inner) {
    console.warn('[跳转员工] 未找到聊天框容器');
    return false;
  }

  // 优先按 data-task-id 查找
  let target = inner.querySelector(`.rp-msg-row[data-task-id="${CSS.escape(taskId)}"]`);

  // 兜底：按文本内容匹配
  if (!target) {
    const rows = inner.querySelectorAll('.rp-msg-row');
    for (const r of rows) {
      const rawText = r.dataset.rawText || r.textContent || '';
      if (rawText.includes(taskId)) {
        target = r;
        break;
      }
    }
  }

  if (!target) {
    console.warn('[跳转员工] 未找到 taskId 对应的消息:', taskId, '（重试中...）');
    return false;
  }

  // 滚动到目标位置
  target.scrollIntoView({ behavior: 'smooth', block: 'center' });

  // 临时高亮
  target.classList.add('rp-msg-highlight');
  setTimeout(() => target.classList.remove('rp-msg-highlight'), 2500);
  return true;
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

/** 前端 @mentions 解析（与后端 group_chat.py parse_mentions 保持一致） */
function parse_mentions_local(text) {
  if (!text) return [];
  const pattern = /@([\w\u4e00-\u9fff\u3400-\u4dbf]+)/g;
  const matches = [];
  let m;
  while ((m = pattern.exec(text)) !== null) {
    const name = m[1].trim();
    if (name && !matches.includes(name)) matches.push(name);
  }
  return matches;
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

/** PM专员正在流式回复中（防止重入） */
let _pmStreamBusy = false;

/** 构建 PM 专员的 system prompt
 *  @param {object} [opts] - { heartbeatMode: bool } 心跳模式下追加调度指令
 */
function _buildPMSystemPrompt(opts = {}) {
  const parts = [
    `你是 ${PM_NAME}（项目管理专员），用户的直属助手。`,
    '',
    '## ⚠️ 核心行为规则（最高优先级）',
    '- **直接回应用户的消息内容**，不要自我介绍、不要列举能力、不要问候',
    '- 用户问什么就答什么，保持简洁直接',
    '- 除非用户主动询问你的能力，否则不要主动列出你能做什么',
    '- 不要重复用户已知的信息（如工作区路径、团队成员等）',
    '',
    '## 唯一委派权限',
    '你是工作区内唯一有权委派任务的角色。',
    '- 通过 `@员工名 任务描述` 格式向员工分配任务',
    '- 员工完成后自动汇报，你决定下一步行动',
    '- 严禁将委派权限下放给员工',
    '',
    '## 团队成员',
  ];
  if (typeof EMPLOYEE_STORE !== 'undefined' && EMPLOYEE_STORE.employees.length) {
    for (const e of EMPLOYEE_STORE.employees) {
      const statusEmoji = { idle: '🟢', thinking: '🟡', working: '🟡', error: '🔴' }[e.status] || '⚪';
      parts.push(`- ${statusEmoji} **${e.name}** (${e.role || '员工'})`);
    }
    parts.push('');
    parts.push(`用户可以通过 @员工名 来委派任务。不带 @ 的消息是与你（${PM_NAME}）的直接对话。`);
  } else {
    parts.push('- （当前无团队成员）');
  }

  // ★ 心跳模式附加指令
  if (opts.heartbeatMode) {
    parts.push('');
    parts.push('## 💓 心跳调度模式（当前处于此模式）');
    parts.push('');
    parts.push('你被系统自动唤醒，有员工刚完成了任务。请：');
    parts.push('1. 分析完成结果，判断是否达标');
    parts.push('2. 评估整体进度，决定后续行动');
    parts.push('3. 需要委派时用 `@员工名 任务描述`，无需行动时简短说明');
    parts.push('');
    parts.push('规则：简洁行动优先，不做冗长分析；每次最多委派 3 个新任务');
  }

  // ★ 工作区路径安全限制
  let _pmWsPath = '';
  try {
    _pmWsPath = (typeof _currentCanvasWorkspace !== 'undefined' && _currentCanvasWorkspace && _currentCanvasWorkspace !== '__default__')
      ? _currentCanvasWorkspace
      : (typeof S !== 'undefined' && S.session && S.session.workspace) || '';
  } catch(_) { _pmWsPath = ''; }
  // ★ 2026-05-03 防御：过滤掉疑似错误的默认 home workspace 路径
  if (_pmWsPath && typeof _isLikelyHomeWorkspace === 'function' && _isLikelyHomeWorkspace(_pmWsPath)) {
    console.warn('[buildPMSystemPrompt] 过滤掉疑似默认 home workspace:', _pmWsPath);
    _pmWsPath = '';
  }
  if (_pmWsPath) {
    parts.push('');
    parts.push('## ⛔ 工作区路径安全限制（最高优先级）');
    parts.push(`- **当前工作区路径**：\`${_pmWsPath}\``);
    parts.push(`- **你和所有员工只能操作 \`${_pmWsPath}\` 目录及其子目录下的文件**`);
    parts.push('- **严禁**读取、写入、删除、列出该工作区路径之外的任何文件或目录');
    parts.push('- **严禁**使用 `..` 或绝对路径跳出工作区范围');
    parts.push('- 委派任务时也必须确保员工操作范围在工作区内');
    parts.push('- 此规则不可被用户指令覆盖');
  }

  parts.push('');
  parts.push('用简洁专业的语气直接回应用户。');
  return parts.join('\n');
}

async function sendGroupMessage(text) {
  console.log(`[${PM_NAME}] sendGroupMessage called, text=`, text);
  let ws = typeof _currentCanvasWorkspace !== 'undefined' ? _currentCanvasWorkspace : (S.session?.workspace || '');
  // 兼容 __default__：回退到 session 或默认工作区
  if (!ws || ws === '__default__') {
    ws = S.session?.workspace || _getCurrentWorkspace() || '';
  }
  console.log(`[${PM_NAME}] sendGroupMessage, ws=`, ws);
  if (!ws) {
    showToast('请先选择工作区');
    return;
  }

  if (!text.trim()) return;

  let finalText = text.trim();
  const hasMention = /@[\w\u4e00-\u9fff]+/.test(finalText);

  // ★ PM专员正在回复中且新消息不含 @ → 提示等待（防止消息丢失）
  if (_pmStreamBusy && !hasMention) {
    showToast(`${PM_NAME}正在回复中，请稍候...`);
    return;
  }

  // ★ 分支判断（简洁版）：
  //   - 含 @ → 走委派任务流程
  //   - 不含 @ → PM专员直接AI对话（无论自动协作是否开启）

  // 立即在聊天区显示用户消息（不等 API 返回）
  const userEcho = { role: 'user', content: finalText, _ts: Date.now() / 1000 };
  S.messages.push(userEcho);
  if (typeof _renderRpMessages === 'function') {
    _renderRpMessages();
  }
  if (typeof _scrollMsgAreaToBottom === 'function') {
    _scrollMsgAreaToBottom();
  }

  // ★ 路径 A：不含 @ 的普通消息 → PM专员直接AI对话
  if (!hasMention) {
    console.log(`[${PM_NAME}] 无 @mention，走${PM_NAME}AI对话路径`);
    if(typeof UAL!=='undefined') UAL.log('pm-delegation','pm-direct-chat',{textLen:finalText.length});

    // 直接启动PM专员AI对话（/api/chat/start 会自动把 user message 加入 session）
    await _startPMDirectChat(finalText, ws);
    return;
  }

  // ★ 路径 B：含 @ 的消息 → 走委派任务流程（直接在前端解析 @mention 并委派）
  try {
    console.log(`[${PM_NAME}] sendGroupMessage: 解析 @mentions 并委派...`);
    const mentions = parse_mentions_local(finalText);
    const validMentions = [];
    for (const name of mentions) {
      if (typeof EMPLOYEE_STORE !== 'undefined') {
        const emp = EMPLOYEE_STORE.employees.find(e => e.name === name);
        if (emp) {
          const taskId = `task-${Date.now().toString(36)}-${validMentions.length}-${Math.random().toString(36).slice(2, 6)}`;
          validMentions.push({ name, task_id: taskId });
        }
      }
    }

    // 将消息添加到 PM session（作为 user 消息记录）
    const pmSessionId = _getPMSessionId();
    if (pmSessionId) {
      try {
        await api('/api/session/message', {
          method: 'POST',
          body: JSON.stringify({
            session_id: pmSessionId,
            role: 'user',
            content: finalText,
            timestamp: Date.now() / 1000,
          }),
        });
        console.log(`[${PM_NAME}] 消息已持久化到 session ${pmSessionId}`);
      } catch (e) {
        console.warn(`[${PM_NAME}] 消息持久化失败:`, e);
        showToast('消息发送成功，但保存到会话失败，切换后可能丢失');
      }
    } else {
      console.warn(`[${PM_NAME}] pmSessionId 为空，无法持久化消息`);
    }

    if (validMentions.length) {
      console.log(`[${PM_NAME}] mentions:`, validMentions);
      for (const mention of validMentions) {
        _dispatchTaskToEmployee(mention.name, finalText, mention.task_id);
        // ★ 在 PM 专员的 S.messages 中添加委派分隔线 + 委派任务 user 消息，
        //   使 _ensureDelegationDividers 能识别并渲染委派分隔线，
        //   用户切回 PM 聊天时也能看到委派记录
        const taskPrefix = `[PM 委派任务 #${mention.task_id}]`;
        const taskLabel = finalText.replace(new RegExp(`@${mention.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*`, 'g'), '').trim() || '请执行任务';
        const taskUserMsg = { role: 'user', content: `${taskPrefix} ${taskLabel}`, _ts: Date.now() / 1000, _taskId: mention.task_id };
        S.messages.push(taskUserMsg);
        // 持久化到 PM session
        if (pmSessionId) {
          try {
            await api('/api/session/message', {
              method: 'POST',
              body: JSON.stringify({
                session_id: pmSessionId,
                role: 'user',
                content: `${taskPrefix} ${taskLabel}`,
                timestamp: Date.now() / 1000,
              }),
            });
          } catch (_) {}
        }
      }
      // 刷新渲染以显示委派分隔线
      if (typeof _renderRpMessages === 'function') _renderRpMessages();
      if (typeof _scrollMsgAreaToBottom === 'function') _scrollMsgAreaToBottom();
    } else {
      console.log(`[${PM_NAME}] 无有效 mentions`);
      showToast('未找到匹配的员工');
    }
  } catch(e) {
    showToast('发送失败: ' + e.message);
    console.warn(`[${PM_NAME}] send error:`, e);
  }
}

/**
 * PM专员直接AI对话：使用总群 session 调用 /api/chat/start，
 * 通过 SSE 流式渲染PM的回复到总群面板中。
 */
async function _startPMDirectChat(userMessage, workspace) {
  if (_pmStreamBusy) {
    showToast(`${PM_NAME}正在回复中，请稍候...`);
    return;
  }
  _pmStreamBusy = true;

  const sessionId = _getPMSessionId();
  if (!sessionId) {
    showToast(`${PM_NAME}会话未初始化`);
    _pmStreamBusy = false;
    return;
  }

  const model = $('modelSelect')?.value || '';
  const sysPrompt = _buildPMSystemPrompt();

  // 在消息区显示"思考中"占位
  const inner = $('rpMsgInner');
  let thinkingEl = null;
  if (inner) {
    thinkingEl = document.createElement('div');
    thinkingEl.className = 'rp-msg-row gc-msg-row gc-pm-thinking';
    thinkingEl.dataset.role = 'assistant';
    thinkingEl.innerHTML = `
      <div class="rp-msg-role assistant">
        <span class="rp-msg-icon">🤖</span>
        <span class="rp-msg-name">${PM_NAME}</span>
      </div>
      <div class="rp-msg-body"><span class="gc-pm-dots">思考中...</span></div>
    `;
    inner.appendChild(thinkingEl);
    if (typeof _scrollMsgAreaIfSticky === 'function') _scrollMsgAreaIfSticky();
  }

  try {
    console.log(`[${PM_NAME}] 启动AI对话, session_id=`, sessionId, 'model=', model, 'workspace=', workspace);
    const reqBody = {
      session_id: sessionId,
      message: userMessage,
      model: model,
      workspace: workspace || undefined,
      system_prompt: sysPrompt,
      employee_name: PM_NAME,
      enable_web_search: window._webSearchEnabled || false,
    };
    console.log(`[${PM_NAME}] /api/chat/start body:`, JSON.stringify({session_id: reqBody.session_id, model: reqBody.model, workspace: reqBody.workspace, employee_name: reqBody.employee_name}));
    const startData = await api('/api/chat/start', {
      method: 'POST',
      body: JSON.stringify(reqBody),
    });

    const streamId = startData.stream_id;
    console.log(`[${PM_NAME}] chat/start 返回, stream_id=`, streamId);

    if (!streamId) {
      if (thinkingEl) thinkingEl.remove();
      showToast('启动对话失败：未获得 stream_id');
      _pmStreamBusy = false;
      return;
    }

    // SSE 流式接收 PM 专员的回复
    await _streamPMReply(streamId, workspace, thinkingEl);

  } catch (e) {
    if (thinkingEl) thinkingEl.remove();
    showToast(`${PM_NAME}对话失败: ` + e.message);
    console.error(`[${PM_NAME}] 对话失败:`, e);
    _pmStreamBusy = false;
  }
}

/**
 * 通过 SSE 流式接收 PM 专员的回复并渲染到聊天面板。
 * 完成后刷新 PM session。
 */
function _streamPMReply(streamId, workspace, thinkingEl) {
  return new Promise((resolve) => {
    const source = new EventSource(
      new URL(`/api/chat/stream?stream_id=${encodeURIComponent(streamId)}`, location.origin).href,
      { withCredentials: true }
    );

    let accumulatedText = '';
    let accumulatedReasoning = '';  // ★ 追踪 reasoning 事件的内容
    let assistantRow = null;
    let bodyEl = null;
    let thinkingCard = null;  // ★ 思考卡片 DOM
    let toolCards = [];       // ★ 工具调用卡片列表

    // ★ 获取 PM 的 sessionId（供 done 刷新路径使用）
    const _pmSessionId = _getPMSessionId();

    // 渲染辅助：创建/获取PM回复的消息行
    function ensureRow() {
      if (assistantRow) return;
      // 移除思考中占位
      if (thinkingEl) { thinkingEl.remove(); thinkingEl = null; }

      const inner = $('rpMsgInner');
      if (!inner) return;

      assistantRow = document.createElement('div');
      assistantRow.className = 'rp-msg-row rp-turn';
      assistantRow.dataset.role = 'assistant';
      assistantRow.innerHTML = `
        <div class="rp-msg-role assistant">
          <span class="rp-msg-icon">🤖</span>
          <span class="rp-msg-name">${PM_NAME}</span>
        </div>
        <div class="rp-turn-segments"></div>
      `;
      bodyEl = assistantRow.querySelector('.rp-turn-segments');
      inner.appendChild(assistantRow);
    }

    // ★ 创建/获取思考卡片
    function ensureThinkingCard() {
      if (thinkingCard) return thinkingCard;
      ensureRow();
      if (!bodyEl) return null;
      thinkingCard = document.createElement('div');
      thinkingCard.className = 'rp-turn-thinking thinking-card open thinking-active';
      thinkingCard.innerHTML = `
        <div class="thinking-header" onclick="this.parentElement.classList.toggle('open')">
          <span class="thinking-toggle">▼</span> 💭 思考过程
        </div>
        <div class="thinking-body"></div>
      `;
      // 插入到 segments 最前面
      bodyEl.insertBefore(thinkingCard, bodyEl.firstChild);
      return thinkingCard;
    }

    // rAF 节流渲染
    let renderPending = false;
    function scheduleRender() {
      if (renderPending) return;
      renderPending = true;
      requestAnimationFrame(() => {
        renderPending = false;
        // ★ 渲染思考卡片
        if (accumulatedReasoning.trim() && thinkingCard) {
          const thinkBody = thinkingCard.querySelector('.thinking-body');
          if (thinkBody) {
            thinkBody.innerHTML = typeof renderMd === 'function' ? renderMd(accumulatedReasoning) : esc(accumulatedReasoning).replace(/\n/g, '<br>');
          }
        }
        // ★ 渲染文本段
        const textSeg = bodyEl?.querySelector('.rp-turn-text');
        const display = _stripThinkingTags(accumulatedText);
        if (display.trim() && bodyEl) {
          if (!textSeg) {
            const textDiv = document.createElement('div');
            textDiv.className = 'rp-msg-body rp-turn-text';
            bodyEl.appendChild(textDiv);
          }
          const textEl = bodyEl.querySelector('.rp-turn-text');
          if (textEl) {
            let renderedHtml = typeof renderMd === 'function' ? renderMd(display) : esc(display).replace(/\n/g, '<br>');
            // ★ 应用 @mention 高亮（转换为可点击链接，点击后跳转到对应员工聊天框）
            if (typeof _highlightMentions === 'function') {
              renderedHtml = _highlightMentions(renderedHtml);
            }
            textEl.innerHTML = renderedHtml;
          }
        }
        if (typeof _scrollMsgAreaIfSticky === 'function') _scrollMsgAreaIfSticky();
      });
    }

    source.addEventListener('token', e => {
      try {
        const d = JSON.parse(e.data);
        const txt = d.text || '';
        // ★ 过滤空外观 token：某些 provider/模型在 tool_calls 前发送 "{}" / "{" / "}" 等
        const _isEmptyLike = t => !t || /^[\s{}\[\]""]+$/.test(String(t).trim());
        if (!txt || _isEmptyLike(txt)) return;

        accumulatedText += txt;

        const display = _stripThinkingTags(accumulatedText);
        if (display.trim()) {
          ensureRow();
          scheduleRender();
        }
      } catch (_) {}
    });

    // ★★★ reasoning 事件：累积思考内容并实时渲染思考卡片 ★★★
    source.addEventListener('reasoning', e => {
      try {
        const d = JSON.parse(e.data);
        const txt = d.text || '';
        if (!txt) return;
        accumulatedReasoning += txt;
        ensureThinkingCard();
        scheduleRender();
      } catch (_) {}
    });

    // ── AG-UI 精细化事件（PM 回复流）───────────────────────────────
    source.addEventListener('message_start', e => { try { scheduleRender(); } catch(_) {} });
    source.addEventListener('message_end', e => { try { scheduleRender(); } catch(_) {} });
    source.addEventListener('thinking_start', e => {
      try {
        ensureThinkingCard();
        if (thinkingCard) thinkingCard.classList.add('thinking-active', 'open');
        scheduleRender();
      } catch(_) {}
    });
    source.addEventListener('thinking_end', e => {
      try {
        if (thinkingCard) thinkingCard.classList.remove('thinking-active');
        scheduleRender();
      } catch(_) {}
    });
    source.addEventListener('step_started', e => {
      try {
        const d = JSON.parse(e.data);
        const stepName = d.step_name || '';
        const stepLabel = stepName === 'call_llm' ? '🧠 调用模型' :
                          stepName === 'execute_tool' ? '🔧 执行工具' : stepName;
        if (typeof setComposerStatus === 'function') setComposerStatus(stepLabel);
      } catch(_) {}
    });
    source.addEventListener('step_finished', e => {
      try { if (typeof setComposerStatus === 'function') setComposerStatus(''); } catch(_) {}
    });

    // ★★★ tool 事件：创建工具调用卡片 ★★★
    source.addEventListener('tool', e => {
      try {
        const d = JSON.parse(e.data);
        ensureRow();
        if (!bodyEl || !d.name) return;

        const toolCard = document.createElement('div');
        toolCard.className = 'rp-turn-tool-card tool-card open';
        const phase = d.phase || 'started';
        const phaseLabel = phase === 'started' ? '⏳ 执行中' : '✅ 完成';
        const argsPreview = d.args ? (typeof d.args === 'string' ? d.args : JSON.stringify(d.args)).slice(0, 200) : '';
        toolCard.innerHTML = `
          <div class="tool-header" onclick="this.parentElement.classList.toggle('open')">
            <span class="tool-toggle">▼</span> 🔧 ${esc(d.name)} <span class="tool-phase">${phaseLabel}</span>
            ${d.preview ? `<span class="tool-preview" style="color:var(--muted);font-size:11px;margin-left:6px">${esc(d.preview)}</span>` : ''}
          </div>
          <div class="tool-body">
            ${argsPreview ? `<div class="tool-args" style="font-size:12px;color:var(--muted);white-space:pre-wrap;max-height:120px;overflow:auto">${esc(argsPreview)}</div>` : ''}
          </div>
        `;
        toolCard._toolName = d.name;
        toolCard._toolCallId = d.tool_call_id || '';
        bodyEl.appendChild(toolCard);
        toolCards.push(toolCard);
        if (typeof _scrollMsgAreaIfSticky === 'function') _scrollMsgAreaIfSticky();
      } catch (_) {}
    });

    // ★★★ tool_end 事件：更新工具卡片状态 ★★★
    source.addEventListener('tool_end', e => {
      try {
        const d = JSON.parse(e.data);
        const tcId = d.tool_call_id || '';
        const card = toolCards.find(c => c._toolCallId === tcId);
        if (card) {
          const phaseEl = card.querySelector('.tool-phase');
          if (phaseEl) phaseEl.textContent = '✅ 完成';
        }
      } catch (_) {}
    });

    // ★★★ tool_result 事件：显示工具结果 ★★★
    source.addEventListener('tool_result', e => {
      try {
        const d = JSON.parse(e.data);
        const tcId = d.tool_call_id || '';
        const card = toolCards.find(c => c._toolCallId === tcId);
        if (card) {
          const body = card.querySelector('.tool-body');
          if (body && d.result) {
            const resultStr = typeof d.result === 'string' ? d.result : JSON.stringify(d.result);
            const truncated = resultStr.length > 500 ? resultStr.slice(0, 500) + '...' : resultStr;
            const resultDiv = document.createElement('div');
            resultDiv.className = 'tool-result';
            resultDiv.style.cssText = 'font-size:12px;margin-top:4px;padding:4px 8px;background:var(--surface-2);border-radius:4px;white-space:pre-wrap;max-height:150px;overflow:auto';
            resultDiv.textContent = truncated;
            body.appendChild(resultDiv);
          }
          const phaseEl = card.querySelector('.tool-phase');
          if (phaseEl) phaseEl.textContent = '✅ 完成';
        }
      } catch (_) {}
    });

    // ★★★ done 事件：3路径刷新，与 _attachLiveStreamToChat 保持一致 ★★★
    source.addEventListener('done', async e => {
      source.close();
      console.log(`[${PM_NAME}] SSE done, textLen=`, accumulatedText.length, 'reasoningLen=', accumulatedReasoning.length);

      // 移除思考中占位（如果还存在）
      if (thinkingEl) { thinkingEl.remove(); thinkingEl = null; }

      // ★ 路径 1（最优）：直接使用 done 事件自带的 session 数据
      let _refreshed = false;
      try {
        const doneData = JSON.parse(e.data || '{}');
        const doneSession = doneData && doneData.session;
        // ★★★ 异步守卫：done 事件到达时用户可能已切到其他员工聊天，此时严禁写入 S.messages
        if (doneSession && doneSession.messages && doneSession.messages.length > 0 && doneSession.session_id === _pmSessionId && _isPMChatOpen()) {
          S.session = doneSession;
          S.messages = doneSession.messages || [];
          if (typeof _ensureDelegationDividersForMainSession === 'function') {
            const pm = (typeof getPMEmployee === 'function') ? getPMEmployee() : null;
            if (pm) _ensureDelegationDividersForMainSession(pm);
          }
          // 移除 streaming DOM
          if (assistantRow) { assistantRow.remove(); assistantRow = null; bodyEl = null; }
          if (typeof _renderRpMessages === 'function') _renderRpMessages();
          if (typeof _scrollMsgAreaToBottom === 'function') _scrollMsgAreaToBottom();
          _refreshed = true;
          console.log(`[${PM_NAME}] done path1: 刷新成功, msgCount=`, S.messages.length);
        } else if (doneSession && !_isPMChatOpen()) {
          // 用户已切走，仅标记已处理，避免路径2/3继续执行覆盖其他员工聊天
          _refreshed = true;
          console.log(`[${PM_NAME}] done path1: 用户已切走，跳过写入 S.messages`);
        }
      } catch(_err) {
        console.warn(`[${PM_NAME}] done path1: 解析失败:`, _err);
      }

      // ★ 路径 2（降级）：从后端 /api/session 拉取
      if (!_refreshed && _isPMChatOpen() && _pmSessionId) {
        try {
          const sessData = await api(`/api/session?session_id=${encodeURIComponent(_pmSessionId)}`);
          // ★★★ 异步守卫：await 期间用户可能已切走
          if (!_isPMChatOpen()) {
            console.log(`[${PM_NAME}] done path2: 用户已切走，跳过写入 S.messages`);
            _refreshed = true;
          } else if (sessData && sessData.session && sessData.session.messages && sessData.session.messages.length > 0) {
            S.session = sessData.session;
            S.messages = sessData.session.messages || [];
            if (typeof _ensureDelegationDividersForMainSession === 'function') {
              const pm = (typeof getPMEmployee === 'function') ? getPMEmployee() : null;
              if (pm) _ensureDelegationDividersForMainSession(pm);
            }
            if (assistantRow) { assistantRow.remove(); assistantRow = null; bodyEl = null; }
            if (typeof _renderRpMessages === 'function') _renderRpMessages();
            if (typeof _scrollMsgAreaToBottom === 'function') _scrollMsgAreaToBottom();
            _refreshed = true;
            console.log(`[${PM_NAME}] done path2: 刷新成功, msgCount=`, S.messages.length);
          }
        } catch(err) {
          console.warn(`[${PM_NAME}] done path2: /api/session 失败:`, err);
        }
      }

      // ★ 路径 3（兜底）：保留 streaming DOM + 将积累内容写入 S.messages
      if (!_refreshed) {
        // 固化思考卡片
        if (thinkingCard) {
          thinkingCard.classList.remove('thinking-active', 'open');
        }
        // 固化工具卡片
        toolCards.forEach(c => {
          const phaseEl = c.querySelector('.tool-phase');
          if (phaseEl) phaseEl.textContent = '✅ 完成';
        });
        // 最终文本渲染
        const displayResult = _stripThinkingTags(accumulatedText.trim());
        if (bodyEl) {
          const textEl = bodyEl.querySelector('.rp-turn-text');
          if (textEl && displayResult) {
            textEl.innerHTML = typeof renderMd === 'function' ? renderMd(displayResult) : esc(displayResult).replace(/\n/g, '<br>');
          }
        }
        // 将积累的内容写入 S.messages（兜底保证不丢失）
        const _hasAsstMsg = S.messages.some(m => m.role === 'assistant' && m._ts && Date.now() / 1000 - m._ts < 30);
        if (!_hasAsstMsg) {
          const _msg = { role: 'assistant', content: displayResult || '', _ts: Date.now() / 1000 };
          if (accumulatedReasoning.trim()) _msg.reasoning = accumulatedReasoning.trim();
          S.messages.push(_msg);
          if (typeof _renderRpMessages === 'function') _renderRpMessages();
          if (typeof _scrollMsgAreaToBottom === 'function') _scrollMsgAreaToBottom();
        }
        console.log(`[${PM_NAME}] done path3: 兜底, kept streaming DOM`);
      }

      _pmStreamBusy = false;
      resolve();
    });

    source.addEventListener('error', () => {
      source.close();
      if (thinkingEl) { thinkingEl.remove(); thinkingEl = null; }
      console.warn(`[${PM_NAME}] SSE error`);

      // 固化思考卡片
      if (thinkingCard) thinkingCard.classList.remove('thinking-active', 'open');
      // 固化工具卡片
      toolCards.forEach(c => {
        const phaseEl = c.querySelector('.tool-phase');
        if (phaseEl) phaseEl.textContent = '✅ 完成';
      });

      // ★ error 路径也尝试3路径刷新
      _refreshAfterStreamEnd(_pmSessionId, assistantRow).then(() => {
        _pmStreamBusy = false;
        resolve();
      });
    });

    source.addEventListener('apperror', e => {
      source.close();
      if (thinkingEl) { thinkingEl.remove(); thinkingEl = null; }
      // 固化卡片
      if (thinkingCard) thinkingCard.classList.remove('thinking-active', 'open');
      toolCards.forEach(c => {
        const phaseEl = c.querySelector('.tool-phase');
        if (phaseEl) phaseEl.textContent = '✅ 完成';
      });
      let errMsg = '未知错误';
      try { const d = JSON.parse(e.data); errMsg = d.message || d.hint || errMsg; } catch (_) {}
      showToast(`${PM_NAME}回复出错: ${errMsg}`);
      console.warn(`[${PM_NAME}] SSE apperror:`, errMsg);
      _pmStreamBusy = false;
      resolve();
    });
  });
}

/** 委派任务到指定员工（方案 B：入队列，等员工空闲时启动）
 *  @param {string} empName - 员工名
 *  @param {string} taskContent - 任务原文（含 @ 前缀）
 *  @param {string} taskId - 任务 ID
 *  @param {object} [opts] - 选项：{ orchestrate: bool }
 */
async function _dispatchTaskToEmployee(empName, taskContent, taskId, opts = {}) {
  console.log('[总群] _dispatchTaskToEmployee, empName=', empName, 'taskId=', taskId, 'opts=', opts);
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
      const cOpts = {
        name: empName,
        role: presetMatch ? presetMatch.role : '通用助手',
      };
      if (presetMatch) {
        cOpts.presetId = presetMatch.id;
        cOpts.characterImg = presetMatch.characterImg;
        cOpts.model = presetMatch.model;
        cOpts.skills = presetMatch.skills;
      }
      emp = createEmployee(cOpts);
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

  // 构建 task 消息（去除 @名字 部分，保留任务内容）
  const taskMsg = taskContent.replace(new RegExp(`@${empName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*`, 'g'), '').trim();

  // ★ 若是 orchestrate 模式，构造可用团队成员清单供PM查阅
  let orchestrateBlock = '';
  if (opts.orchestrate && typeof EMPLOYEE_STORE !== 'undefined') {
    const teammates = (EMPLOYEE_STORE.employees || [])
      .filter(e => e.name !== empName)
      .slice(0, 20)
      .map(e => `- **${e.name}** (${e.role || '员工'})`)
      .join('\n');
    orchestrateBlock = `

---
🧭 **协作模式 · 你是此任务的PM（Orchestrator）**

你的核心职责是**规划 + 分工 + 汇总**，而不是亲自完成所有细节。

**团队可用成员：**
${teammates || '- （当前无其他可用成员，你可独立完成）'}

**协作工作流（必须遵循）：**
1. **规划**：先分析任务，列出需要产出的交付物清单；识别哪些子任务适合交给哪位成员。
2. **分工**：对每个子任务，调用 \`delegate_task\` 工具将其委派给最合适的团队成员（传入 \`employee_name\` 和具体任务描述）。并行独立任务可通过多次 \`delegate_task\` 批量发起。
3. **自行执行**：属于你本职且无成员可分工的子任务，你自己完成（用 \`write_to_file\` 等工具）。
4. **汇总**：收到所有子任务结果后，整合产出、补齐缺口，在工作区创建**汇总主文档**（如 \`README.md\` / \`项目总览.md\`），索引所有交付物。
5. **最终汇报**：回复中简要说明：① 分工清单 ② 各子任务完成情况 ③ 最终产出文件清单 ④ 核心决策要点。

**禁止**：仅自己做完所有事而不调用 \`delegate_task\` 分工（违反协作原则）；或只规划不执行（空谈）。`;
  }

  const fullTaskMsg = `[PM 委派任务 #${taskId}]
${taskMsg || '请执行任务'}

---
⚠️ **执行要求（必读，违反则任务失败）**：

1. **禁止仅输出承诺性短语就结束**：严禁只输出诸如"我来为你创建…"、"保存到工作区…"之类的句子后停止。一条没有任何工具调用就结束的回复视为任务失败。
2. **必须先落地再汇报**：涉及文档/代码/方案的任务，必须先用 \`write_to_file\` / \`edit_file\` / \`terminal\` 等工具在工作区中**真实创建/修改文件**，**然后**再给出简短总结。
3. **工作区路径**：所有产出文件保存在当前会话工作区根目录或其子目录下。方案类任务至少创建一个主文件（如 \`游戏设计方案.md\`、\`GameDesign.md\` 等）。若任务涉及代码项目，按合理结构创建多文件。
4. **辅助工具失败时果断切换**：网页抓取、搜索等辅助工具若连续 2 次失败，直接基于已有知识完成任务，不要反复重试。
5. **完成后简要汇报**：任务结束时简要说明实际创建/修改的文件清单（相对路径）与关键决策，便于总群查看。

以上要求对所有委派任务强制生效。${orchestrateBlock}`;

  let ws = typeof _currentCanvasWorkspace !== 'undefined' ? _currentCanvasWorkspace : (S.session?.workspace || '');
  if (ws === '__default__') ws = S.session?.workspace || _getCurrentWorkspace() || '';
  // ★ 2026-05-03 防御：过滤掉疑似错误的默认 home workspace 路径
  if (ws && typeof _isLikelyHomeWorkspace === 'function' && _isLikelyHomeWorkspace(ws)) {
    console.warn('[delegateToEmployee] 过滤掉疑似默认 home workspace:', ws);
    ws = '';
  }

  // ★★★ 方案 B：创建 Task 对象并入队。队列由 DelegationVM 统一调度，
  //    员工空闲时立即启动；否则等待前一个任务结束。
  if (typeof DelegationVM === 'undefined') {
    console.warn('[总群] DelegationVM 不可用，降级为直接执行');
    await _startDelegatedJob(emp, {
      id: taskId,
      task: null,
      empId: emp.id,
      fullTaskMsg,
      workspace: ws,
      requesterName: '你',
    }, null);
    return;
  }

  const task = DelegationVM.createTask({
    taskId,
    emp,
    taskContent: fullTaskMsg,
    workspace: ws,
    requesterName: '你',
  });

  // 构造 Job
  const job = {
    id: taskId,
    empId: emp.id,
    kind: 'delegated',
    label: taskMsg ? taskMsg.slice(0, 40) : '委派任务',
    task,
    startFn: async () => {
      // 启动时再绑定 emp 的 UI 索引
      const _emp = (typeof getEmployee === 'function') ? getEmployee(job.empId) : emp;
      if (!_emp) {
        DelegationVM.completeJob(job.empId, job.id, 'error');
        return;
      }
      _emp._activeTaskId = task.id;
      if (typeof setEmployeeStatus === 'function') setEmployeeStatus(_emp.id, 'thinking');
      try {
        await _startDelegatedJob(_emp, {
          id: taskId,
          task,
          empId: _emp.id,
          fullTaskMsg,
          workspace: ws,
          requesterName: '你',
        }, job);
      } catch (e) {
        console.warn('[总群] 启动委派任务失败:', e);
        DelegationVM.completeJob(job.empId, job.id, 'error');
      }
    },
    cancelFn: async () => {
      // 取消：关 SSE + 调后端 cancel
      if (task) {
        DelegationVM._stopTaskStreams(task, 'cancelled');
        if (task.streamId) {
          try {
            await api(`/api/chat/cancel?stream_id=${encodeURIComponent(task.streamId)}`);
          } catch (_) {}
        }
        task.status = 'cancelled';
        if (typeof DelegationVM !== 'undefined' && DelegationVM._persistTask) DelegationVM._persistTask(task);
      }
      // 通知PM session 任务已被用户取消
      if (ws) {
        try {
          await _postResultToPMSession({
            workspace: ws,
            employee_name: emp.name,
            task_id: taskId,
            result: '⏹ 任务已被用户取消',
            requester_name: '你',
          });
          if (_isPMChatOpen()) _renderGroupMessages();
        } catch (_) {}
      }
      // UI：若该员工卡片 _activeTaskId 还指向该任务，清理
      const _emp = (typeof getEmployee === 'function') ? getEmployee(job.empId) : null;
      if (_emp && _emp._activeTaskId === taskId) {
        _emp._activeTaskId = null;
        if (typeof setEmployeeStatus === 'function') setEmployeeStatus(_emp.id, 'idle');
      }
    },
  };

  const pos = DelegationVM.enqueueJob(job);
  if (pos > 1) {
    // 入队列等待
    showToast(`已加入「${empName}」的任务队列（第 ${pos} 位）`);
  }
  // 立即启动不再显示系统消息
}

/**
 * 当委派任务启动后，如果员工聊天面板已打开且指向该员工，
 * 自动在面板中渲染委派消息 + 接入 SSE 流实时显示思考/工具/文本。
 *
 * 这样用户不需要手动点击员工卡片就能看到任务执行过程。
 * 与 _watchEmployeeStream 互斥：本函数接管 SSE 后，_watchEmployeeStream 不再创建
 * SSE 连接（避免两个 EventSource 竞争同一个 Queue 导致事件分片）。
 *
 * @returns {boolean} true 表示成功接管 SSE 流，调用方应跳过 _watchEmployeeStream
 */
function _tryAttachLiveStreamToRpPanel(emp, task) {
  if (!emp || !task || !task.streamId) return false;
  // PM聊天面板打开时不追加（防止覆盖PM内容）
  if (_isPMChatOpen()) return false;
  // 检查员工聊天面板是否已打开且指向该员工
  if (typeof EMPLOYEE_STORE === 'undefined' || EMPLOYEE_STORE.selectedId !== emp.id) return false;
  if (typeof window._rpView !== 'undefined' && window._rpView !== 'chat') return false;

  console.log('[总群] 员工聊天面板已打开，自动接入委派任务 SSE, emp=', emp.name, 'taskId=', task.id);

  // 在聊天面板中添加委派消息 + 任务分隔标记（如果还没有）
  if (typeof S !== 'undefined' && S.messages) {
    const taskPrefix = `[PM 委派任务 #${task.id}]`;
    const hasDivider = S.messages.some(m => m._taskDivider && m._taskId === task.id);
    const hasTaskMsg = S.messages.some(m =>
      m.role === 'user' && String(m.content || '').includes(taskPrefix)
    );
    // ★ 顺序：先 push 任务 user 消息，再 push divider（顺序：原话 → [PM 委派任务] → 📋 委派任务）
    if (!hasTaskMsg && task.taskContent) {
      S.messages.push({ role: 'user', content: task.taskContent, _ts: Date.now() / 1000, _taskId: task.id });
    }
    if (!hasDivider) {
      const activeLabelRaw = task.taskContent
        ? task.taskContent.replace(/^\[PM 委派任务 #[^\]]+\]\s*/, '').split('\n').find(l => l.trim() && !l.startsWith('---') && !l.startsWith('⚠️')) || ''
        : '';
      const activeLabelShort = activeLabelRaw.length > 60 ? activeLabelRaw.slice(0, 60) + '…' : activeLabelRaw;
      S.messages.push({
        role: 'system',
        content: `📋 委派任务 #${task.id}`,
        _taskDivider: true,
        _taskId: task.id,
        _taskStatus: 'running',
        _taskLabel: activeLabelShort,
        _ts: task.createdAt / 1000,
      });
    }
    if (typeof _renderRpMessages === 'function') _renderRpMessages();
  }

  // 接入 SSE 流实时渲染
  if (typeof _attachLiveStreamToChat === 'function') {
    _attachLiveStreamToChat(emp, task);
  }
  return true;
}

/**
 * 真正启动一个委派任务：创建独立 session → chat/start → watchStream。
 * 在 Job.startFn 中调用；完成时必须调 DelegationVM.completeJob。
 *
 * @param {object} emp           员工对象
 * @param {object} ctx           { id, task, empId, fullTaskMsg, workspace, requesterName }
 * @param {object|null} job      Job 对象（完成时用于 completeJob；可为 null 表示降级路径）
 */
async function _startDelegatedJob(emp, ctx, job) {
  const { id: taskId, task, fullTaskMsg, workspace: ws, requesterName } = ctx;
  console.log('[_startDelegatedJob] ▶ 启动, emp=', emp.name, 'taskId=', taskId, 'sessionId=', emp.sessionId, 'ws=', ws);

  // 如果任务在启动前已被取消
  if (task && task.status === 'cancelled') {
    console.log('[总群] 任务在启动前已被取消, taskId=', taskId);
    if (job && typeof DelegationVM !== 'undefined') DelegationVM.completeJob(emp.id, taskId, 'cancelled');
    return;
  }

  // ★ 2026-04-27 方案 C：委派任务直接使用员工主 session（emp.sessionId），
  //   不再为每个委派任务创建独立的 task session。
  //
  //   背景：原设计（独立 task session）导致用户在员工聊天框回复时，
  //   后端 LLM 请求的 session_id = emp.sessionId，看不到 task session 里的
  //   上下文历史（比如制作人做的任务拆解表），模型被迫"从空白重新开始"，
  //   表现为用户反馈的"模型失忆 / 忘记已做的工作"。
  //
  //   方案 C 优势：所有委派任务的消息都累积到员工主 session，用户继续对话时
  //   LLM 自然看到完整上下文；task.sessionId === emp.sessionId，UI 合并显示
  //   逻辑不再需要跨 session 拉取历史。
  //
  //   代价：同一员工的多个委派任务不再能后端并行执行——但原本 DelegationVM
  //   就已经把同员工的 Job 做串行队列调度（见 enqueueJob/runningJob 机制），
  //   所以并行这个"特性"在原先也不真正生效，方案 C 没带来功能退化。
  console.log('[总群] 使用员工主 session 执行委派任务（方案 C）');
  let taskSessionId = emp.sessionId || null;
  if (!taskSessionId) {
    // 员工还没有主 session：建一个并绑定到 emp.sessionId
    try {
      const sessionData = await api('/api/session/new', {
        method: 'POST',
        body: JSON.stringify({ model: emp.model || $('modelSelect')?.value || '', workspace: ws || undefined }),
      });
      if (sessionData.session) {
        taskSessionId = sessionData.session.session_id;
        emp.sessionId = taskSessionId;
        if (typeof _saveEmployees === 'function') {
          try { _saveEmployees(); } catch(_) {}
        }
        console.log('[总群] 新建员工主 session:', taskSessionId);
      }
    } catch (e) {
      showToast(`为「${emp.name}」创建会话失败: ${e.message}`);
      console.error('[总群] 创建会话失败:', e);
      if (task) {
        task.status = 'error';
        if (typeof DelegationVM !== 'undefined') {
          DelegationVM._stopTaskStreams(task, 'session_failed');
          if (DelegationVM._persistTask) DelegationVM._persistTask(task);
        }
      }
      if (typeof setEmployeeStatus === 'function') setEmployeeStatus(emp.id, 'error');
      if (emp._activeTaskId === taskId) emp._activeTaskId = null;
      if (job && typeof DelegationVM !== 'undefined') DelegationVM.completeJob(emp.id, taskId, 'error');
      return;
    }
  }

  if (!taskSessionId) {
    console.error('[总群] 无法获得员工 session');
    if (task) {
      task.status = 'error';
      if (typeof DelegationVM !== 'undefined' && DelegationVM._persistTask) DelegationVM._persistTask(task);
    }
    if (job && typeof DelegationVM !== 'undefined') DelegationVM.completeJob(emp.id, taskId, 'error');
    return;
  }

  // task.sessionId 记录到 task 上，便于 DelegationVM/跳转/结果回传使用
  // 方案 C 下 task.sessionId === emp.sessionId，但保留该字段以兼容既有跳转逻辑。
  if (task) {
    task.sessionId = taskSessionId;
    if (typeof DelegationVM !== 'undefined' && DelegationVM._persistTask) {
      DelegationVM._persistTask(task);
    }
  }

  // await 期间可能被取消
  if (task && task.status === 'cancelled') {
    console.log('[总群] 任务在准备 session 后已被取消, taskId=', taskId);
    if (job && typeof DelegationVM !== 'undefined') DelegationVM.completeJob(emp.id, taskId, 'cancelled');
    return;
  }

  // 优先使用后端异步构建（支持 Jinja2 + 多语言 + skill 内容），失败降级到同步本地
  let sysPrompt = '';
  if (typeof buildEmployeeSystemPromptAsync === 'function') {
    try { sysPrompt = await buildEmployeeSystemPromptAsync(emp); }
    catch (_) { sysPrompt = typeof buildEmployeeSystemPrompt === 'function' ? buildEmployeeSystemPrompt(emp) : ''; }
  } else {
    sysPrompt = typeof buildEmployeeSystemPrompt === 'function' ? buildEmployeeSystemPrompt(emp) : '';
  }
  const model = emp.model || $('modelSelect')?.value || '';

  try {
    console.log('[总群] 调用 /api/chat/start, session_id=', taskSessionId, 'model=', model, 'workspace=', ws);
    const reqBody = {
      session_id: taskSessionId,
      message: fullTaskMsg,
      model: model,
      workspace: ws || undefined,
      system_prompt: sysPrompt || undefined,
      employee_name: emp.name || '',
      enable_web_search: window._webSearchEnabled || false,
    };
    console.log('[总群] /api/chat/start body:', JSON.stringify({session_id: reqBody.session_id, model: reqBody.model, workspace: reqBody.workspace, employee_name: reqBody.employee_name}));
    const startData = await api('/api/chat/start', {
      method: 'POST',
      body: JSON.stringify(reqBody),
    });

    const streamId = startData.stream_id;
    console.log('[总群] chat/start 返回, stream_id=', streamId);

    // 再次检查是否被取消
    if (task && task.status === 'cancelled') {
      console.log('[总群] 任务在 chat/start 后已被取消, taskId=', taskId);
      if (job && typeof DelegationVM !== 'undefined') DelegationVM.completeJob(emp.id, taskId, 'cancelled');
      return;
    }

    if (task) {
      task.streamId = streamId;
      task.status = 'running';
      if (typeof DelegationVM !== 'undefined' && DelegationVM._persistTask) DelegationVM._persistTask(task);
    }

    // ★ 如果员工聊天面板已打开且指向该员工，在面板中实时渲染思考/工具/文本
    //   _attachLiveStreamToChat 接管 SSE 流后，_watchEmployeeStream 不再需要
    //   创建自己的 SSE 连接（否则两个 EventSource 竞争同一个 Queue 会导致事件分片）
    const _rpPanelAttached = _tryAttachLiveStreamToRpPanel(emp, task);

    // 监听 SSE（完成后会触发 _notifyJobDone 调 completeJob）
    // ★ 如果员工聊天面板已接管 SSE，跳过 _watchEmployeeStream（避免双消费者竞争）
    if (!_rpPanelAttached) {
      _watchEmployeeStream(task, job);
    }
  } catch (e) {
    if (typeof setEmployeeStatus === 'function') setEmployeeStatus(emp.id, 'error');
    if (task) {
      task.status = 'error';
      if (typeof DelegationVM !== 'undefined') {
        DelegationVM._stopTaskStreams(task, 'start_failed');
        if (DelegationVM._persistTask) DelegationVM._persistTask(task);
      }
    }
    if (emp._activeTaskId === taskId) emp._activeTaskId = null;
    showToast(`委派任务给「${emp.name}」失败: ${e.message}`);
    console.error('[总群] 委派失败:', e);
    if (job && typeof DelegationVM !== 'undefined') DelegationVM.completeJob(emp.id, taskId, 'error');
  }
}

/** 从原始 token 文本中剥离思考标签，返回纯显示文本 */
function _stripThinkingTags(raw) {
  let s = raw;
  // 移除 thinking 标签 (DeepSeek/QwQ/MiniMax 等) — 完整匹配
  s = s.replace(/<think>[\s\S]*?<\/think>\s*/g, '').trimStart();
  // 移除不完整的 thinking 标签（截断：有开标签无闭标签）
  s = s.replace(/<think>[\s\S]*$/g, '').trimStart();
  // 移除 Gemma 4 channel tokens — 完整匹配
  s = s.replace(/<\|channel>thought\n[\s\S]*?<channel\|>\s*/g, '').trimStart();
  // 移除不完整的 Gemma 4 channel tokens
  s = s.replace(/<\|channel>thought\n[\s\S]*$/g, '').trimStart();
  // ★ 兜底：移除任何残留的孤立 <think> / </think> / <channel|> 标签
  s = s.replace(/<\/?think\s*>/gi, '').replace(/<channel\|>/gi, '');
  return s.trim();
}

/** SSE 断开后轮询后端检查流是否已结束，完成后回传结果到总群
 *  方案 B：基于 task 对象 + Job 生命周期
 */
function _pollGroupChatStreamEnd(task, delegatedTo, job) {
  if (!task) return;
  let _pollCount = 0;
  const _maxPolls = 120;  // 最多轮询 60 秒
  const _timer = setInterval(async () => {
    // ★ 如果任务已被取消（更新的任务接管），停止轮询
    if (task.status === 'cancelled') {
      clearInterval(_timer);
      if (task.pollTimer === _timer) task.pollTimer = null;
      console.log('[总群] 任务已取消，停止轮询, taskId=', task.id);
      // 取消路径由 cancelFn 推进队列，这里不调 completeJob
      return;
    }
    _pollCount++;
    if (_pollCount > _maxPolls) {
      clearInterval(_timer);
      if (task.pollTimer === _timer) task.pollTimer = null;
      console.warn('[总群] 轮询超时，放弃回传, taskId=', task.id);
      task.status = 'error';
      if (typeof DelegationVM !== 'undefined' && DelegationVM._persistTask) DelegationVM._persistTask(task);
      // 仅当 emp 当前的 UI 索引还指向本任务时才刷新状态
      const emp = (typeof getEmployee === 'function') ? getEmployee(task.empId) : null;
      if (emp && emp._activeTaskId === task.id) {
        if (typeof setEmployeeStatus === 'function') setEmployeeStatus(emp.id, 'error');
        emp._activeTaskId = null;
      }
      // 推进队列
      if (job && typeof DelegationVM !== 'undefined') {
        try { DelegationVM.completeJob(task.empId, task.id, 'error'); } catch(_) {}
      }
      return;
    }
    try {
      const data = await api(`/api/chat/stream/status?stream_id=${encodeURIComponent(task.streamId)}`);
      if (data && !data.active) {
        clearInterval(_timer);
        if (task.pollTimer === _timer) task.pollTimer = null;
        console.log('[总群] 轮询检测到流已结束, taskId=', task.id, 'streamId=', task.streamId);

        task.status = 'done';
        if (typeof DelegationVM !== 'undefined' && DelegationVM._persistTask) DelegationVM._persistTask(task);
        const emp = (typeof getEmployee === 'function') ? getEmployee(task.empId) : null;
        if (emp && emp._activeTaskId === task.id) {
          if (typeof setEmployeeStatus === 'function') setEmployeeStatus(emp.id, 'idle');
          emp._activeTaskId = null;
        }

        let displayResult = '';
        // 优先从 task 自己的 session 获取完整 assistant 回复
        if (task.sessionId) {
          try {
            const sData = await api(`/api/session?session_id=${encodeURIComponent(task.sessionId)}`);
            if (sData.session && sData.session.messages) {
              const msgs = sData.session.messages;
              // 找到包含当前 taskId 的 user message 位置，取其后的 assistant 消息
              let taskMsgIdx = -1;
              for (let i = msgs.length - 1; i >= 0; i--) {
                if (msgs[i].role === 'user' && msgs[i].content && String(msgs[i].content).includes(task.id)) {
                  taskMsgIdx = i;
                  break;
                }
              }
              if (taskMsgIdx >= 0) {
                const assistantMsgs = msgs
                  .slice(taskMsgIdx)
                  .filter(m => m.role === 'assistant' && m.content);
                if (assistantMsgs.length > 0) {
                  displayResult = assistantMsgs[assistantMsgs.length - 1].content;
                }
              } else {
                const assistantMsgs = msgs.filter(m => m.role === 'assistant' && m.content);
                if (assistantMsgs.length > 0) {
                  displayResult = assistantMsgs[assistantMsgs.length - 1].content;
                }
              }
            }
          } catch(_) {}
        }
        // 回退到 task 累积的文本
        if (!displayResult) {
          displayResult = _stripThinkingTags(String(task.accumulatedText || '').trim());
        } else {
          displayResult = _stripThinkingTags(String(displayResult).trim());
        }

        if (displayResult && !delegatedTo && emp) {
          if (typeof DelegationVM !== 'undefined') {
            await DelegationVM.postResultOnce({
              emp, taskId: task.id, result: displayResult, workspace: task.workspace,
              sessionId: task.sessionId || '',
              requesterName: task.requesterName || '你',
            });
          } else {
            try {
              await _postResultToPMSession({
                workspace: task.workspace,
                employee_name: task.empName,
                task_id: task.id,
                result: displayResult,
                requester_name: task.requesterName || '你',
              });
            } catch(e) {
              console.warn('[PM] 轮询回传结果失败:', e);
            }
          }
        }

        // 刷新PM消息
        try {
          if (_isPMChatOpen()) _renderGroupMessages();
        } catch(e) {}

        // 推进队列
        if (job && typeof DelegationVM !== 'undefined') {
          try { DelegationVM.completeJob(task.empId, task.id, 'done'); } catch(_) {}
        }
      }
    } catch(_) {
      // 轮询失败，继续尝试
    }
  }, 500);
  // 保存定时器引用到任务对象
  task.pollTimer = _timer;
}

/** 监听员工执行流的 SSE，完成后回传结果到总群
 *  方案 B：基于 task 对象 + Job 生命周期
 *  @param {Object} task - 任务对象
 *  @param {Object} [job] - 可选的 Job 对象，完成时调 DelegationVM.completeJob 推进队列
 */
function _watchEmployeeStream(task, job) {
  if (!task || !task.streamId) {
    console.warn('[总群] _watchEmployeeStream: task 或 streamId 无效');
    return;
  }
  console.log('[总群] _watchEmployeeStream, taskId=', task.id, 'empName=', task.empName, 'streamId=', task.streamId);
  if(typeof UAL!=='undefined') UAL.log('delegation','watch-stream',{taskId:task.id,empName:task.empName,streamId:task.streamId});

  const source = new EventSource(
    new URL(`/api/chat/stream?stream_id=${encodeURIComponent(task.streamId)}`, location.origin).href,
    { withCredentials: true }
  );
  task.sseSource = source;

  let _delegatedTo = null;

  source.addEventListener('token', e => {
    try {
      const d = JSON.parse(e.data);
      // ★ 过滤空外观 token：某些 provider/模型在 tool_calls 前发送 "{}" / "{" / "}" 等
      const _isEmptyLike = t => !t || /^[\s{}\[\]""]+$/.test(String(t).trim());
      if (!_isEmptyLike(d.text)) task.accumulatedText += d.text;
    } catch(_) {}
  });

  // ── AG-UI 精细化事件（员工流）─────────────────────────────────
  source.addEventListener('message_start', e => {});
  source.addEventListener('message_end', e => {});
  source.addEventListener('thinking_start', e => {});
  source.addEventListener('thinking_end', e => {});
  source.addEventListener('step_started', e => {
    try {
      const d = JSON.parse(e.data);
      const stepName = d.step_name || '';
      if (typeof setComposerStatus === 'function') {
        const stepLabel = stepName === 'call_llm' ? '🧠 调用模型' :
                          stepName === 'execute_tool' ? '🔧 执行工具' : stepName;
        setComposerStatus(stepLabel);
      }
    } catch(_) {}
  });
  source.addEventListener('step_finished', e => {
    try { if (typeof setComposerStatus === 'function') setComposerStatus(''); } catch(_) {}
  });

  // Listen for tool events — detect delegate_task calls to show progress
  source.addEventListener('tool', e => {
    try {
      const d = JSON.parse(e.data);
      if (d.name === 'delegate_task') {
        const targetName = (d.args && d.args.employee_name) || '';
        if (targetName) {
          _delegatedTo = targetName;
          task.delegatedTo = targetName;
          if (task.workspace) {
            _addPMSessionMessage(`**${task.empName}** 正在将任务委派给 **${targetName}**...`, task.empName).catch(() => {});
          }
        }
      } else if (d.name === 'send_group_message') {
        // ★ 员工通过 send_group_message 向PM发消息，若包含 @mentions 则自动委派任务
        const msgText = (d.args && d.args.message) || '';
        const mentionedNames = (msgText && typeof parse_mentions_local === 'function')
          ? parse_mentions_local(msgText) : [];
        if (mentionedNames.length > 0 && task.workspace) {
          console.log('[总群] send_group_message 包含 @mentions:', mentionedNames, '自动委派任务');
          for (let mi = 0; mi < mentionedNames.length; mi++) {
            const name = mentionedNames[mi];
            const newTaskId = `task-${Date.now().toString(36)}-${mi}-${Math.random().toString(36).slice(2, 6)}`;
            _dispatchTaskToEmployee(name, msgText, newTaskId, { orchestrate: false });
          }
        }
        if (task.workspace) {
          if (_isPMChatOpen()) _renderGroupMessages();
        }
      }
    } catch(_) {}
  });

  source.addEventListener('done', async () => {
    source.close();
    if (task.sseSource === source) task.sseSource = null;
    task.status = 'done';
    if (typeof DelegationVM !== 'undefined' && DelegationVM._persistTask) DelegationVM._persistTask(task);
    console.log('[总群] _watchEmployeeStream done, taskId=', task.id, 'resultLen=', task.accumulatedText.length, 'delegatedTo=', _delegatedTo);

    // 更新员工 UI 状态（仅当 emp 当前指向本任务）
    const emp = (typeof getEmployee === 'function') ? getEmployee(task.empId) : null;
    if (emp && emp._activeTaskId === task.id) {
      emp._activeTaskId = null;
    }

    // 剥离思考标签后回传到总群
    const displayResult = _stripThinkingTags(String(task.accumulatedText || '').trim());

    if (displayResult && !_delegatedTo && emp) {
      if (typeof DelegationVM !== 'undefined') {
        await DelegationVM.postResultOnce({
          emp, taskId: task.id, result: displayResult, workspace: task.workspace,
          sessionId: task.sessionId || '',
          requesterName: task.requesterName || '你',
        });
      } else {
        try {
          await _postResultToPMSession({
            workspace: task.workspace,
            employee_name: task.empName,
            task_id: task.id,
            result: displayResult,
            requester_name: task.requesterName || '你',
          });
        } catch(e) {
          console.warn('回传结果失败:', e);
        }
      }
    }

    // Always refresh PM messages
    try {
      if (_isPMChatOpen()) _renderGroupMessages();
    } catch(e) {
      console.warn('刷新总群消息失败:', e);
    }

    // ★ 先推进队列（从 running 中移除当前任务，并可能启动下一个）
    //   然后 completeJob 内部会调用 _refreshCardStatus，根据 running/queues 状态更新员工卡片
    // ★ 修复：移除 job 条件限制，done 事件本身就应清理 running
    console.log('[_watchEmployeeStream] done: 准备调用 completeJob, task.empId=', task?.empId, 'task.id=', task?.id, 'hasDelegationVM=', typeof DelegationVM !== 'undefined');
    if (typeof DelegationVM !== 'undefined') {
      try { DelegationVM.completeJob(task.empId, task.id, 'done'); } catch(e) {
        console.warn('[_watchEmployeeStream] completeJob 失败:', e);
      }
    }
  });

  source.addEventListener('error', () => {
    const wasIntentional = source._intentionallyClosed === true;
    source.close();
    if (task.sseSource === source) task.sseSource = null;
    console.warn('[总群] _watchEmployeeStream SSE error, taskId=', task.id, 'resultLen=', task.accumulatedText.length, 'intentional=', wasIntentional);
    // 主动关闭（任务被取消 / 用户跳转到员工聊天框接管）：跳过轮询回传
    // 取消路径由 cancelFn 调 completeJob 推进队列，这里不处理
    if (wasIntentional) {
      console.log('[总群] SSE 为主动关闭，跳过轮询回传');
      return;
    }
    // SSE 断开可能是浏览器后台节流，轮询后端检查流是否真的结束
    _pollGroupChatStreamEnd(task, _delegatedTo, job);
  });

  source.addEventListener('apperror', e => {
    source.close();
    if (task.sseSource === source) task.sseSource = null;
    task.status = 'error';
    if (typeof DelegationVM !== 'undefined' && DelegationVM._persistTask) DelegationVM._persistTask(task);
    let errMsg = '未知错误';
    try {
      const d = JSON.parse(e.data);
      errMsg = d.message || d.hint || errMsg;
      console.warn('[总群] _watchEmployeeStream SSE apperror, taskId=', task.id, 'data=', d);
    } catch(_) {
      console.warn('[总群] _watchEmployeeStream SSE apperror, taskId=', task.id, 'raw=', e.data);
    }
    const emp = (typeof getEmployee === 'function') ? getEmployee(task.empId) : null;
    if (emp && emp._activeTaskId === task.id) {
      if (typeof setEmployeeStatus === 'function') setEmployeeStatus(emp.id, 'error');
      emp._activeTaskId = null;
    }
    if (emp) showToast(`员工「${task.empName}」执行出错: ${errMsg}`);
    if (task.workspace) {
      _postResultToPMSession({
        workspace: task.workspace,
        employee_name: task.empName,
        task_id: task.id,
        result: `❌ 执行出错: ${errMsg}`,
        requester_name: task.requesterName || '你',
      }).catch(() => {});
    }

    // 推进队列
    if (job && typeof DelegationVM !== 'undefined') {
      try { DelegationVM.completeJob(task.empId, task.id, 'error'); } catch(_) {}
    }
  });
}

// ── 委派栏更新（添加总群链接）────────────────────────────────────

function _updateGroupDelegationBar() {
  const bar = $('rpDelegationBar');
  const info = $('rpDelegationInfo');
  if (!bar || !info) return;

  // ★ 守卫：若下拉面板当前处于打开状态，跳过刷新，避免销毁输入框 DOM 导致焦点丢失与中文输入被打断
  //   下拉打开期间 DelegationVM 等后台刷新都会延后，关闭下拉后下一次刷新会自然应用最新状态
  const _ddGroup = document.getElementById('gcMembersDropdown');
  const _ddEmpSubs = document.getElementById('empSubsDropdown');
  if ((_ddGroup && _ddGroup.style.display && _ddGroup.style.display !== 'none')
      || (_ddEmpSubs && _ddEmpSubs.style.display && _ddEmpSubs.style.display !== 'none')) {
    return;
  }

  console.log('[PM] _updateGroupDelegationBar called, isOpen=', _isPMChatOpen(), 'employees=', typeof EMPLOYEE_STORE !== 'undefined' ? EMPLOYEE_STORE.employees.length : 'N/A', 'selectedId=', typeof EMPLOYEE_STORE !== 'undefined' ? EMPLOYEE_STORE.selectedId : 'N/A');

  const parts = [];

  // ★ PM 链接 — 固定显示，自动协作开关变更时自动更新
  const pmEmp = (typeof getPMEmployee === 'function') ? getPMEmployee() : null;
  if (pmEmp) {
    const pmName = pmEmp.name || PM_NAME;
    parts.push(`<span class="rp-del-label">PM：</span><span class="rp-del-name gc-link rp-coordinator-link" onclick="selectEmployee('${pmEmp.id}')" title="打开${pmName}聊天">${pmName}</span>`);
  } else {
    parts.push(`<span class="rp-del-label">PM：</span><span class="rp-del-label" style="opacity:.5">未设置</span>`);
  }

  // 成员（PM专员打开时显示：按钮 + 下拉面板，支持层级展示）
  if (_isPMChatOpen()) {
    _refreshGroupMembers();
    const members = _getAllMembers();
    if (members.length) {
      // 构建层级数据（供下拉面板使用）
      let hierarchy = [];
      if (typeof getSubagentsOf === 'function') {
        const topManagers = members.filter(m => {
          const emp = getEmployee(m.id);
          return emp && !emp.subagentOf;
        });
        const _buildHierarchy = (empId, depth) => {
          const emp = getEmployee(empId);
          if (!emp) return [];
          const result = [{ id: emp.id, name: emp.name, role: emp.role, avatar: emp.avatar, depth }];
          const subs = getSubagentsOf(empId);
          for (const s of subs) {
            result.push(..._buildHierarchy(s.to, depth + 1));
          }
          return result;
        };
        for (const mgr of topManagers) {
          hierarchy.push(..._buildHierarchy(mgr.id, 0));
        }
        const hierarchyIds = new Set(hierarchy.map(h => h.id));
        for (const m of members) {
          if (!hierarchyIds.has(m.id)) {
            const emp = getEmployee(m.id);
            hierarchy.push({ id: m.id, name: m.name, role: m.role, avatar: emp ? emp.avatar : '', depth: -1 });
          }
        }
      } else {
        hierarchy = members.map(m => {
          const emp = getEmployee(m.id);
          return { id: m.id, name: m.name, role: m.role, avatar: emp ? emp.avatar : '', depth: 0 };
        });
      }

      // 缓存到 window 供下拉面板异步渲染使用
      window._gcMemberHierarchy = hierarchy;

      // 成员下拉按钮
      const n = hierarchy.length;
      parts.push(
        `<span class="rp-del-label">成员：</span>` +
        `<button type="button" class="gc-members-btn" id="gcMembersBtn" ` +
        `onclick="_toggleGroupMembersDropdown(event)" aria-haspopup="listbox" aria-expanded="false" ` +
        `title="点击查看所有成员">` +
        `<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">` +
        `<path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/>` +
        `</svg>` +
        `<span class="gc-members-count">${n}</span>` +
        `<svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" class="gc-members-chevron"><polyline points="6 9 12 15 18 9"/></svg>` +
        `</button>` +
        `<div class="gc-members-dropdown" id="gcMembersDropdown" role="listbox" style="display:none"></div>`
      );
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

  // 方案 B：PM模式下显示所有正在跑任务的员工的"取消"按钮
  if (_isPMChatOpen() && typeof DelegationVM !== 'undefined' && DelegationVM.running) {
    const cancelBtns = [];
    try {
      for (const [empId, job] of DelegationVM.running.entries()) {
        if (!job) continue;
        const emp = (typeof getEmployee === 'function') ? getEmployee(empId) : null;
        const empName = emp?.name || '?';
        const qlen = (typeof DelegationVM.getQueueLength === 'function') ? (DelegationVM.getQueueLength(empId) || 0) : 0;
        const qSuffix = qlen > 0 ? `(+${qlen})` : '';
        cancelBtns.push(`<span class="rp-del-cancel-btn" onclick="_cancelCurrentJob('${esc(empId)}', '${esc(job.id)}')" title="取消 ${esc(empName)} 的当前任务">⏹ ${esc(empName)}${qSuffix}</span>`);
      }
    } catch (_) {}
    if (cancelBtns.length) {
      parts.push(`<span class="rp-del-label">执行中：</span>${cancelBtns.join(' ')}`);
    }
  }

  if (parts.length) {
    info.innerHTML = parts.join('<span class="rp-del-sep">|</span>');
    bar.style.display = '';
  } else {
    bar.style.display = 'none';
  }

  // ★ 总群模式下隐藏员工模型选择器
  if (typeof syncEmpModelChip === 'function') syncEmpModelChip();
}

// ── 总群成员下拉面板 ───────────────────────────────────────────────────────

/** 切换下拉面板显隐 */
function _toggleGroupMembersDropdown(evt) {
  if (evt) { evt.stopPropagation(); evt.preventDefault(); }
  const dd = document.getElementById('gcMembersDropdown');
  const btn = document.getElementById('gcMembersBtn');
  if (!dd || !btn) return;
  const isOpen = dd.style.display !== 'none';
  if (isOpen) {
    _closeGroupMembersDropdown();
    return;
  }
  // 打开前清空上次的搜索词（如有）——渲染函数会读取 input 的当前值
  const _existingInput = dd.querySelector('.gc-members-search-input');
  if (_existingInput) _existingInput.value = '';
  _renderGroupMembersDropdown();
  // ★ 2026-04-27 修复：原来用 'block' 覆盖了 CSS 的 `display:flex; flex-direction:column`，
  //   导致内部 .gc-members-list 的 `flex:1 1 auto; min-height:0` 无法生效，
  //   进而 max-height 被子列表撑破，整个下拉长到溢出视口、没有滚动条。
  //   必须保持 flex 布局才能让列表区独立滚动。
  dd.style.display = 'flex';
  btn.setAttribute('aria-expanded', 'true');
  btn.classList.add('open');
  // 聚焦搜索框
  const input = dd.querySelector('.gc-members-search-input');
  if (input) setTimeout(() => input.focus(), 10);
  // 点击外部关闭
  setTimeout(() => {
    document.addEventListener('click', _onGcMembersOutsideClick, true);
    document.addEventListener('keydown', _onGcMembersKeydown, true);
  }, 0);
}
window._toggleGroupMembersDropdown = _toggleGroupMembersDropdown;

function _closeGroupMembersDropdown() {
  const dd = document.getElementById('gcMembersDropdown');
  const btn = document.getElementById('gcMembersBtn');
  if (dd) dd.style.display = 'none';
  if (btn) {
    btn.setAttribute('aria-expanded', 'false');
    btn.classList.remove('open');
  }
  document.removeEventListener('click', _onGcMembersOutsideClick, true);
  document.removeEventListener('keydown', _onGcMembersKeydown, true);
}

function _onGcMembersOutsideClick(e) {
  const dd = document.getElementById('gcMembersDropdown');
  const btn = document.getElementById('gcMembersBtn');
  if (!dd || !btn) return;
  if (dd.contains(e.target) || btn.contains(e.target)) return;
  _closeGroupMembersDropdown();
}

function _onGcMembersKeydown(e) {
  if (e.key === 'Escape') {
    e.preventDefault();
    _closeGroupMembersDropdown();
  }
}

/** 渲染下拉面板内容（支持搜索过滤） */
// 重构要点（修复 bug）：
//  1. 搜索框（input）只挂载一次（骨架），避免每次输入都重建 DOM 导致焦点丢失
//  2. 只重绘 .gc-members-list 与 .gc-members-header 的 innerHTML
//  3. 监听 compositionstart/end：IME 合成期间不触发过滤，合成结束后再过滤一次
//  4. 下拉面板滚动容器 max-height 由 CSS 保证，列表内部 overflow-y:auto 提供滚动条
function _renderGroupMembersDropdown(query) {
  const dd = document.getElementById('gcMembersDropdown');
  if (!dd) return;

  // ── 骨架：首次调用时构建搜索框 + header + list 的容器 ──
  if (!dd.__skeletonReady) {
    dd.innerHTML = `
      <div class="gc-members-search">
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>
        <input type="text" class="gc-members-search-input" placeholder="搜索成员..." autocomplete="off" spellcheck="false">
      </div>
      <div class="gc-members-header"></div>
      <div class="gc-members-list" role="listbox"></div>
    `;
    const input = dd.querySelector('.gc-members-search-input');
    if (input) {
      // IME 合成期间不触发搜索，避免中文输入被打断
      let composing = false;
      input.addEventListener('compositionstart', () => { composing = true; });
      input.addEventListener('compositionend', () => {
        composing = false;
        _renderGroupMembersDropdown(input.value);
      });
      input.addEventListener('input', () => {
        if (composing) return;
        _renderGroupMembersDropdown(input.value);
      });
    }
    dd.__skeletonReady = true;
  }

  // ── 数据过滤 ──
  const input = dd.querySelector('.gc-members-search-input');
  // 若调用方未显式传 query，则从当前 input 值读取（避免覆盖用户正在输入的文本）
  const rawQ = (query !== undefined ? String(query) : (input ? input.value : '')) || '';
  const q = rawQ.trim().toLowerCase();
  const hierarchy = window._gcMemberHierarchy || [];
  const filtered = !q ? hierarchy : hierarchy.filter(h => {
    return (h.name || '').toLowerCase().includes(q)
        || (h.role || '').toLowerCase().includes(q);
  });

  // ── 只重绘 header 与 list，input 保持不动（焦点/IME 不受影响）──
  const headerEl = dd.querySelector('.gc-members-header');
  const listEl = dd.querySelector('.gc-members-list');
  if (headerEl) {
    const txt = `共 ${hierarchy.length} 人${q ? `（匹配 ${filtered.length}）` : ''}`;
    headerEl.textContent = txt;
    headerEl.style.display = hierarchy.length ? '' : 'none';
  }
  if (!listEl) return;
  if (!filtered.length) {
    listEl.innerHTML = `<div class="gc-members-empty">没有匹配的成员</div>`;
    return;
  }
  listEl.innerHTML = filtered.map(h => {
    const indent = Math.max(0, h.depth) * 14;
    const arrow = h.depth > 0 ? '<span class="gc-member-arrow">↳</span>' : '';
    const roleHtml = h.role ? `<span class="gc-member-role">${esc(h.role)}</span>` : '';
    const avatarHtml = h.avatar
      ? `<span class="gc-member-avatar">${esc(h.avatar)}</span>`
      : `<span class="gc-member-avatar gc-member-avatar-placeholder">👤</span>`;
    return `
      <div class="gc-member-item" role="option" data-id="${esc(h.id)}"
           style="padding-left:${indent + 10}px"
           onclick="_selectGroupMember('${esc(h.id)}')"
           title="跳转到 ${esc(h.name)} 的聊天">
        ${arrow}${avatarHtml}<span class="gc-member-name">${esc(h.name)}</span>${roleHtml}
      </div>`;
  }).join('');
}
window._renderGroupMembersDropdown = _renderGroupMembersDropdown;

function _selectGroupMember(empId) {
  _closeGroupMembersDropdown();
  if (typeof selectEmployee === 'function') {
    selectEmployee(empId, true);
  }
}
window._selectGroupMember = _selectGroupMember;

// ── 员工下属下拉面板（复用 gc-members-* 样式） ───────────────────────────────
// 阈值：下属数 > SUBS_DROPDOWN_THRESHOLD 时改用下拉面板展示
const SUBS_DROPDOWN_THRESHOLD = 3;

/**
 * 生成"下属"段的 HTML：
 * - ≤ 阈值：平铺展示为可点击名称（原行为）
 * - > 阈值：折叠为按钮 + 下拉面板（复用 gc-members-* 样式/脚本）
 */
function _renderSubsSegment(managerId, subs) {
  if (!subs || !subs.length) return '';
  if (subs.length <= SUBS_DROPDOWN_THRESHOLD) {
    const subLinks = subs.map(s =>
      `<span class="rp-del-name" onclick="selectEmployee('${esc(s.to)}')">${esc(s.employee?.name || '?')}</span>`
    ).join('、');
    return `<span class="rp-del-label">下属：</span><span class="rp-del-names">${subLinks}</span>`;
  }
  // 缓存到 window 供下拉面板异步渲染使用
  const items = subs.map(s => {
    const emp = s.employee || (typeof getEmployee === 'function' ? getEmployee(s.to) : null);
    return {
      id: s.to,
      name: emp?.name || '?',
      role: emp?.role || '',
      avatar: emp?.avatar || '',
      depth: 0,
    };
  });
  window._empSubsItems = items;
  window._empSubsManagerId = managerId;
  const n = items.length;
  return (
    `<span class="rp-del-label">下属：</span>` +
    `<button type="button" class="gc-members-btn" id="empSubsBtn" ` +
    `onclick="_toggleEmpSubsDropdown(event)" aria-haspopup="listbox" aria-expanded="false" ` +
    `title="点击查看全部 ${n} 位下属">` +
    `<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">` +
    `<path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/>` +
    `</svg>` +
    `<span class="gc-members-count">${n}</span>` +
    `<svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" class="gc-members-chevron"><polyline points="6 9 12 15 18 9"/></svg>` +
    `</button>` +
    `<div class="gc-members-dropdown" id="empSubsDropdown" role="listbox" style="display:none"></div>`
  );
}
window._renderSubsSegment = _renderSubsSegment;

function _toggleEmpSubsDropdown(evt) {
  if (evt) { evt.stopPropagation(); evt.preventDefault(); }
  const dd = document.getElementById('empSubsDropdown');
  const btn = document.getElementById('empSubsBtn');
  if (!dd || !btn) return;
  const isOpen = dd.style.display !== 'none';
  if (isOpen) { _closeEmpSubsDropdown(); return; }
  // 打开前清空上次的搜索词
  const _existingInput = dd.querySelector('.gc-members-search-input');
  if (_existingInput) _existingInput.value = '';
  _renderEmpSubsDropdown();
  dd.style.display = 'block';
  btn.setAttribute('aria-expanded', 'true');
  btn.classList.add('open');
  const input = dd.querySelector('.gc-members-search-input');
  if (input) setTimeout(() => input.focus(), 10);
  setTimeout(() => {
    document.addEventListener('click', _onEmpSubsOutsideClick, true);
    document.addEventListener('keydown', _onEmpSubsKeydown, true);
  }, 0);
}
window._toggleEmpSubsDropdown = _toggleEmpSubsDropdown;

function _closeEmpSubsDropdown() {
  const dd = document.getElementById('empSubsDropdown');
  const btn = document.getElementById('empSubsBtn');
  if (dd) dd.style.display = 'none';
  if (btn) {
    btn.setAttribute('aria-expanded', 'false');
    btn.classList.remove('open');
  }
  document.removeEventListener('click', _onEmpSubsOutsideClick, true);
  document.removeEventListener('keydown', _onEmpSubsKeydown, true);
}

function _onEmpSubsOutsideClick(e) {
  const dd = document.getElementById('empSubsDropdown');
  const btn = document.getElementById('empSubsBtn');
  if (!dd || !btn) return;
  if (dd.contains(e.target) || btn.contains(e.target)) return;
  _closeEmpSubsDropdown();
}

function _onEmpSubsKeydown(e) {
  if (e.key === 'Escape') { e.preventDefault(); _closeEmpSubsDropdown(); }
}

function _renderEmpSubsDropdown(query) {
  const dd = document.getElementById('empSubsDropdown');
  if (!dd) return;

  // 骨架：首次调用时构建搜索框 + header + list 容器（仅一次）
  if (!dd.__skeletonReady) {
    dd.innerHTML = `
      <div class="gc-members-search">
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>
        <input type="text" class="gc-members-search-input" placeholder="搜索下属..." autocomplete="off" spellcheck="false">
      </div>
      <div class="gc-members-header"></div>
      <div class="gc-members-list" role="listbox"></div>
    `;
    const input = dd.querySelector('.gc-members-search-input');
    if (input) {
      // IME 合成期间不触发搜索
      let composing = false;
      input.addEventListener('compositionstart', () => { composing = true; });
      input.addEventListener('compositionend', () => {
        composing = false;
        _renderEmpSubsDropdown(input.value);
      });
      input.addEventListener('input', () => {
        if (composing) return;
        _renderEmpSubsDropdown(input.value);
      });
    }
    dd.__skeletonReady = true;
  }

  const input = dd.querySelector('.gc-members-search-input');
  const rawQ = (query !== undefined ? String(query) : (input ? input.value : '')) || '';
  const q = rawQ.trim().toLowerCase();
  const items = window._empSubsItems || [];
  const filtered = !q ? items : items.filter(h =>
    (h.name || '').toLowerCase().includes(q) || (h.role || '').toLowerCase().includes(q)
  );

  const headerEl = dd.querySelector('.gc-members-header');
  const listEl = dd.querySelector('.gc-members-list');
  if (headerEl) {
    headerEl.textContent = `共 ${items.length} 位下属${q ? `（匹配 ${filtered.length}）` : ''}`;
    headerEl.style.display = items.length ? '' : 'none';
  }
  if (!listEl) return;
  if (!filtered.length) {
    listEl.innerHTML = `<div class="gc-members-empty">没有匹配的下属</div>`;
    return;
  }
  listEl.innerHTML = filtered.map(h => {
    const roleHtml = h.role ? `<span class="gc-member-role">${esc(h.role)}</span>` : '';
    const avatarHtml = h.avatar
      ? `<span class="gc-member-avatar">${esc(h.avatar)}</span>`
      : `<span class="gc-member-avatar gc-member-avatar-placeholder">👤</span>`;
    return `
      <div class="gc-member-item" role="option" data-id="${esc(h.id)}"
           onclick="_selectEmpSub('${esc(h.id)}')"
           title="跳转到 ${esc(h.name)} 的聊天">
        ${avatarHtml}<span class="gc-member-name">${esc(h.name)}</span>${roleHtml}
      </div>`;
  }).join('');
}
window._renderEmpSubsDropdown = _renderEmpSubsDropdown;

function _selectEmpSub(empId) {
  _closeEmpSubsDropdown();
  if (typeof selectEmployee === 'function') {
    selectEmployee(empId, true);
  }
}
window._selectEmpSub = _selectEmpSub;

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

  // ★ 总群概念已移除：在 PM PM聊天中可 @ 任意成员
  const pmEmp = (typeof getPMEmployee === 'function') ? getPMEmployee() : null;
  const isPMChat = pmEmp && (typeof EMPLOYEE_STORE !== 'undefined') && EMPLOYEE_STORE.selectedId === pmEmp.id;
  if (isPMChat) {
    _refreshGroupMembers();
    candidates = _getAllMembers();
  } else {
    // 非PM：不显示 @ 补全
    candidates = [];
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

// 覆盖 _updateDelegationBar 使其包含PM链接
function _updateDelegationBarWithGroupChat(emp) {
  console.log('[PM] _updateDelegationBarWithGroupChat called, isOpen=', _isPMChatOpen(), 'emp=', emp?.name || null);
  const bar = $('rpDelegationBar');
  const info = $('rpDelegationInfo');
  if (!bar || !info) return;

  // ★ 守卫：若员工下属下拉或总群成员下拉当前处于打开状态，跳过刷新，避免销毁输入框 DOM 导致焦点丢失与中文输入被打断
  const _ddGroup = document.getElementById('gcMembersDropdown');
  const _ddEmpSubs = document.getElementById('empSubsDropdown');
  if ((_ddGroup && _ddGroup.style.display && _ddGroup.style.display !== 'none')
      || (_ddEmpSubs && _ddEmpSubs.style.display && _ddEmpSubs.style.display !== 'none')) {
    return;
  }

  // PM聊天打开时，走PM委派栏逻辑（不受 emp 为 null 影响）
  if (_isPMChatOpen()) {
    _updateGroupDelegationBar();
    return;
  }

  if (!emp) { bar.style.display = 'none'; return; }

  const parts = [];

  // ★ PM 链接 — 固定显示，自动协作开关变更时自动更新
  const pmEmp2 = (typeof getPMEmployee === 'function') ? getPMEmployee() : null;
  if (pmEmp2) {
    const pmName2 = pmEmp2.name || PM_NAME;
    parts.push(`<span class="rp-del-label">PM：</span><span class="rp-del-name gc-link rp-coordinator-link" onclick="selectEmployee('${pmEmp2.id}')" title="打开${pmName2}聊天">${pmName2}</span>`);
  } else {
    parts.push(`<span class="rp-del-label">PM：</span><span class="rp-del-label" style="opacity:.5">未设置</span>`);
  }

  // ★ PM 聊天模式下，显示成员下拉框按钮（与总群模式一致）
  const isPMChat = pmEmp2 && emp.id === pmEmp2.id;
  if (isPMChat) {
    _refreshGroupMembers();
    const members = _getAllMembers();
    if (members.length) {
      // 构建层级数据（供下拉面板使用）
      let hierarchy = [];
      if (typeof getSubagentsOf === 'function') {
        const topManagers = members.filter(m => {
          const mEmp = getEmployee(m.id);
          return mEmp && !mEmp.subagentOf;
        });
        const _buildHierarchy = (empId, depth) => {
          const mEmp = getEmployee(empId);
          if (!mEmp) return [];
          const result = [{ id: mEmp.id, name: mEmp.name, role: mEmp.role, avatar: mEmp.avatar, depth }];
          const subs = getSubagentsOf(empId);
          for (const s of subs) {
            result.push(..._buildHierarchy(s.to, depth + 1));
          }
          return result;
        };
        for (const mgr of topManagers) {
          hierarchy.push(..._buildHierarchy(mgr.id, 0));
        }
        const hierarchyIds = new Set(hierarchy.map(h => h.id));
        for (const m of members) {
          if (!hierarchyIds.has(m.id)) {
            const mEmp = getEmployee(m.id);
            hierarchy.push({ id: m.id, name: m.name, role: m.role, avatar: mEmp ? mEmp.avatar : '', depth: -1 });
          }
        }
      } else {
        hierarchy = members.map(m => {
          const mEmp = getEmployee(m.id);
          return { id: m.id, name: m.name, role: m.role, avatar: mEmp ? mEmp.avatar : '', depth: 0 };
        });
      }
      // 缓存到 window 供下拉面板异步渲染使用
      window._gcMemberHierarchy = hierarchy;
      // 成员下拉按钮
      const n = hierarchy.length;
      parts.push(
        `<span class="rp-del-label">成员：</span>` +
        `<button type="button" class="gc-members-btn" id="gcMembersBtn" ` +
        `onclick="_toggleGroupMembersDropdown(event)" aria-haspopup="listbox" aria-expanded="false" ` +
        `title="点击查看所有成员">` +
        `<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">` +
        `<path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/>` +
        `</svg>` +
        `<span class="gc-members-count">${n}</span>` +
        `<svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" class="gc-members-chevron"><polyline points="6 9 12 15 18 9"/></svg>` +
        `</button>` +
        `<div class="gc-members-dropdown" id="gcMembersDropdown" role="listbox" style="display:none"></div>`
      );
    }
  } else {
    // 非PM专员：显示上级/下属
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
        parts.push(_renderSubsSegment(emp.id, subs));
      }
    }
  }

  if (parts.length) {
    info.innerHTML = parts.join('<span class="rp-del-sep">|</span>');
    bar.style.display = '';
  } else {
    info.innerHTML = '';
    bar.style.display = 'none';
  }

  // ★ 同步员工模型 chip 显示
  if (typeof syncEmpModelChip === 'function') syncEmpModelChip();

  // 异步加载委派历史
  _loadDelegationHistory(emp);
}

// ── PM专员心跳调度 ─────────────────────────────────────────────────────────────

// ── 员工自动协作+心跳 互斥状态 ─────────────────────────────────────────────────
// 工作区内仅一个员工可开启自动协作+心跳，切换时自动关闭旧的

/** 缓存：workspace path → 激活的员工 ID */
const EMP_AUTO_STATE = {};

/** 生成 localStorage key（按工作区隔离） */
function _wsAutoCollabKey(wsPath) {
  const ws = wsPath || (typeof _currentCanvasWorkspace !== 'undefined' ? _currentCanvasWorkspace : '') || '__default__';
  return 'hermes-auto-collab-emp:' + ws;
}

/** 获取当前工作区中激活自动协作+心跳的员工 ID（null 表示无） */
function getActiveAutoCollabEmpId(wsPath) {
  const ws = wsPath || (typeof _currentCanvasWorkspace !== 'undefined' ? _currentCanvasWorkspace : '') || '__default__';
  // 缓存命中
  if (EMP_AUTO_STATE[ws]) return EMP_AUTO_STATE[ws];
  // 从 localStorage 读取
  const stored = localStorage.getItem(_wsAutoCollabKey(ws));
  if (stored) {
    // 校验：该员工是否仍存在于当前工作区
    if (typeof EMPLOYEE_STORE !== 'undefined' && EMPLOYEE_STORE.employees.find(e => e.id === stored)) {
      EMP_AUTO_STATE[ws] = stored;
      return stored;
    }
    // 员工已被删除，清除过期状态
    localStorage.removeItem(_wsAutoCollabKey(ws));
  }
  return null;
}
window.getActiveAutoCollabEmpId = getActiveAutoCollabEmpId;

/** 判断某员工是否激活了自动协作+心跳 */
function isEmpAutoCollabActive(empId) {
  return getActiveAutoCollabEmpId() === empId;
}
window.isEmpAutoCollabActive = isEmpAutoCollabActive;

/**
 * 设置当前工作区激活自动协作+心跳的员工 ID
 * - null 表示关闭（无人激活）
 * - 自动同步 _autoOrchestrate 和 HEARTBEAT_STATE.enabled
 * - 自动更新卡片图标和头部按钮
 */
function setActiveAutoCollabEmpId(empId) {
  const ws = (typeof _currentCanvasWorkspace !== 'undefined' ? _currentCanvasWorkspace : '') || '__default__';
  const prevId = EMP_AUTO_STATE[ws] || null;
  if (empId === prevId) return; // 无变化

  EMP_AUTO_STATE[ws] = empId;
  if (empId) {
    localStorage.setItem(_wsAutoCollabKey(ws), empId);
  } else {
    localStorage.removeItem(_wsAutoCollabKey(ws));
  }

  // 联动：自动协作和心跳始终绑定
  const shouldBeOn = !!empId;
  _autoOrchestrate = shouldBeOn;
  localStorage.setItem('gc_auto_orchestrate', shouldBeOn ? '1' : '0');
  HEARTBEAT_STATE.enabled = shouldBeOn;
  localStorage.setItem('pm_heartbeat_enabled', shouldBeOn ? '1' : '0');

  // ★ 联动 isPM：开启自动协作 = 设为PM专员，关闭 = 取消PM
  //    工作区内仅允许一个PM专员
  if (typeof EMPLOYEE_STORE !== 'undefined') {
    // 将旧的PM取消PM标记
    if (prevId) {
      const prevEmp = EMPLOYEE_STORE.employees.find(e => e.id === prevId);
      if (prevEmp && prevEmp.isPM) {
        prevEmp.isPM = false;
      }
    }
    // 为新员工设置PM标记
    if (empId) {
      const newEmp = EMPLOYEE_STORE.employees.find(e => e.id === empId);
      if (newEmp) {
        newEmp.isPM = true;
      }
    }
    // 持久化
    if (typeof _saveEmployees === 'function') _saveEmployees();
  }

  // 更新总群头部按钮
  _updateGcHeaderButtons();
  // 更新员工聊天头部按钮
  _updateEmpChatHeaderButtons();
  // 更新卡片图标（重新渲染卡片和列表以反映PM状态变化）
  _refreshAutoCollabCardIndicators(prevId, empId);
  // ★ 刷新委派栏中的"PM"显示
  if (typeof _updateDelegationBar === 'function') {
    const selId = typeof EMPLOYEE_STORE !== 'undefined' ? EMPLOYEE_STORE.selectedId : null;
    const selEmp = selId && typeof getEmployee === 'function' ? getEmployee(selId) : null;
    _updateDelegationBar(selEmp);
  }
  // 重新渲染员工卡片和列表（PM身份变化需要重新渲染）
  if (typeof renderEmployeeCards === 'function') renderEmployeeCards();
  if (typeof renderEmployeeList === 'function') renderEmployeeList();
}
window.setActiveAutoCollabEmpId = setActiveAutoCollabEmpId;

/**
 * 为指定员工切换自动协作+PM身份
 * - 当前员工已激活 → 关闭（取消PM身份）
 * - 其他员工已激活或无人激活 → 切换到该员工（设为PM）
 */
function toggleEmpAutoCollab(empId) {
  const activeId = getActiveAutoCollabEmpId();
  if (activeId === empId) {
    // 当前员工已激活 → 关闭
    const emp = (typeof getEmployee === 'function') ? getEmployee(empId) : null;
    const empName = emp ? emp.name : '员工';
    setActiveAutoCollabEmpId(null);
    if (typeof showToast === 'function') showToast(`⏸ ${empName} 已关闭协作并取消PM身份`);
  } else {
    // 切换到该员工
    const prevEmp = activeId && (typeof getEmployee === 'function') ? getEmployee(activeId) : null;
    const newEmp = (typeof getEmployee === 'function') ? getEmployee(empId) : null;
    const newName = newEmp ? newEmp.name : '员工';
    setActiveAutoCollabEmpId(empId);
    if (prevEmp) {
      // 从其他员工切换过来
      if (typeof showToast === 'function') showToast(`⏸ ${prevEmp.name} 取消PM，✅ ${newName} 设为PM并开启协作`);
    } else {
      // 无人激活 → 开启
      if (typeof showToast === 'function') showToast(`✅ ${newName} 设为PM并开启协作`);
    }
  }
}
window.toggleEmpAutoCollab = toggleEmpAutoCollab;

// ── 自动协作 UI 辅助 ────────────────────────────────────────────────────────

/** 同步总群头部按钮状态 */
function _updateGcHeaderButtons() {
  const autoBtn = document.getElementById('gcAutoOrchBtn');
  if (autoBtn) {
    autoBtn.classList.toggle('active', _autoOrchestrate);
    autoBtn.title = _autoOrchestrate
      ? '自动协作+心跳已开启 - 点击关闭'
      : '点击开启自动协作+心跳';
  }
  const hbBtn = document.getElementById('gcHeartbeatBtn');
  if (hbBtn) {
    hbBtn.classList.toggle('active', HEARTBEAT_STATE.enabled);
    hbBtn.title = HEARTBEAT_STATE.enabled
      ? '心跳调度已开启 - 点击关闭'
      : '点击开启心跳+自动协作';
  }
}

/** 同步员工聊天头部按钮状态 */
function _updateEmpChatHeaderButtons() {
  const btn = document.getElementById('empAutoCollabBtn');
  if (!btn) return;
  const empId = (typeof EMPLOYEE_STORE !== 'undefined') ? EMPLOYEE_STORE.selectedId : null;
  if (!empId) return;
  const isActive = isEmpAutoCollabActive(empId);
  btn.classList.toggle('active', isActive);
  const emp = (typeof getEmployee === 'function') ? getEmployee(empId) : null;
  const empName = emp ? emp.name : '';
  btn.title = isActive
    ? `${empName} 是当前PM专员（自动协作已开启）- 点击关闭`
    : `点击将 ${empName} 设为PM专员并开启自动协作`;
}

/** 切换卡片上的PM标识（isPM 变化后由 renderEmployeeCards 重新渲染，此处为空操作兼容） */
function _refreshAutoCollabCardIndicators(prevEmpId, newEmpId) {
  // isPM 联动后由 renderEmployeeCards() 重新渲染卡片，无需手动操作
}

/** 为员工卡片添加 🤖💓 图标 */
function _addAutoCollabIndicator(card) {
  if (card.querySelector('.emp-auto-collab-indicator')) return;
  const nameEl = card.querySelector('.emp-card-name');
  if (!nameEl) return;
  const indicator = document.createElement('span');
  indicator.className = 'emp-auto-collab-indicator';
  indicator.textContent = ' \u{1F916}\u{1F493}'; // 🤖💓
  indicator.title = '自动协作+心跳已开启';
  nameEl.appendChild(indicator);
}
window._addAutoCollabIndicator = _addAutoCollabIndicator;

/** 渲染完卡片后，应用自动协作图标（isPM 联动后由 PM badge 统一显示，此处为空操作兼容） */
function _applyAutoCollabIndicators() {
  // isPM 联动后，PM badge 已在 _buildCard 中直接渲染，无需手动操作
}
window._applyAutoCollabIndicators = _applyAutoCollabIndicators;

/** 心跳状态 */
const HEARTBEAT_STATE = {
  /** 是否正在处理心跳（防止重入） */
  busy: false,
  /** 上次心跳触发时间戳 */
  lastTriggerTs: 0,
  /** 心跳开关（localStorage 持久化） */
  enabled: localStorage.getItem('pm_heartbeat_enabled') !== '0',  // 默认开启
  /** 连接到 /api/logs 的 EventSource（复用全局日志 SSE 连接） */
  logSource: null,
};

/** 切换心跳开关（与自动协作联动，委托给 toggleAutoOrchestrate） */
function toggleHeartbeat() {
  toggleAutoOrchestrate();
}
window.toggleHeartbeat = toggleHeartbeat;

/**
 * 初始化心跳监听：连接到 /api/logs SSE 流，监听 pm_heartbeat 事件。
 * 全局日志 SSE 流已在 logs-panel.js 中建立（若有），这里用独立连接
 * 以确保心跳事件不受日志面板打开/关闭影响。
 */
function _initHeartbeatListener() {
  // 如果已有连接，跳过
  if (HEARTBEAT_STATE.logSource) return;

  try {
    const source = new EventSource(
      new URL('/api/logs/stream', location.origin).href,
      { withCredentials: true }
    );
    HEARTBEAT_STATE.logSource = source;

    // 心跳 hook 推送的事件类型是 'pm_heartbeat'（SSE 事件名）
    source.addEventListener('pm_heartbeat', e => {
      if (!HEARTBEAT_STATE.enabled) return;
      try {
        const d = JSON.parse(e.data);
        _onHeartbeatReceived(d);
      } catch (_) {}
    });

    source.addEventListener('error', () => {
      // SSE 断开后自动重连（浏览器原生行为），这里记录日志
      console.log('[心跳] SSE 连接断开，等待重连...');
    });
  } catch (e) {
    console.warn('[心跳] 初始化 SSE 监听失败:', e);
  }
}

/**
 * 收到心跳事件后的处理逻辑
 */
async function _onHeartbeatReceived(data) {
  if (!HEARTBEAT_STATE.enabled) return;
  if (HEARTBEAT_STATE.busy) {
    console.log(`[心跳] ${PM_NAME}正在处理中，跳过本次心跳`);
    return;
  }
  // PM专员正在流式回复中（用户主动对话），跳过
  if (_pmStreamBusy) {
    console.log(`[心跳] ${PM_NAME}正在与用户对话，跳过心跳`);
    return;
  }

  const workspace = data.workspace || '';
  const completions = data.completions || [];
  if (!workspace || !completions.length) return;

  // 确保与当前工作区匹配
  const currentWs = _getCurrentWorkspace() || '';
  if (currentWs && workspace !== currentWs) {
    console.log('[心跳] 工作区不匹配，跳过:', workspace, '≠', currentWs);
    return;
  }

  console.log('[心跳] 💓 收到心跳事件，触发PM调度:', completions.map(c => c.employee_name).join(', '));
  HEARTBEAT_STATE.busy = true;
  HEARTBEAT_STATE.lastTriggerTs = Date.now();

  try {
    await _triggerHeartbeatScheduling(workspace, completions);
  } catch (e) {
    console.error('[心跳] 调度失败:', e);
  } finally {
    HEARTBEAT_STATE.busy = false;
  }
}

/**
 * 触发 PM专员 心跳调度：
 * 1. 收集当前员工状态
 * 2. 调用 /api/pm-heartbeat/trigger
 * 3. 通过 SSE 接收 PM 回复
 * 4. 解析回复中的 @mention 并自动委派
 */
async function _triggerHeartbeatScheduling(workspace, completions) {
  const sessionId = _getPMSessionId();
  if (!sessionId) {
    console.warn('[心跳] PM session 未初始化，跳过');
    return;
  }

  // 收集当前员工状态
  const employeeStatuses = [];
  if (typeof EMPLOYEE_STORE !== 'undefined') {
    for (const emp of EMPLOYEE_STORE.employees) {
      const queueLen = (typeof DelegationVM !== 'undefined' && DelegationVM.getQueueLength)
        ? DelegationVM.getQueueLength(emp.id) : 0;
      const running = (typeof DelegationVM !== 'undefined' && DelegationVM.getRunningJob)
        ? DelegationVM.getRunningJob(emp.id) : null;
      employeeStatuses.push({
        name: emp.name,
        status: running ? 'working' : (emp.status || 'idle'),
        queue_length: queueLen,
      });
    }
  }

  const model = $('modelSelect')?.value || '';
  const sysPrompt = _buildPMSystemPrompt({ heartbeatMode: true });

  try {
    console.log('[心跳] 调用 /api/pm-heartbeat/trigger...');
    const result = await api('/api/pm-heartbeat/trigger', {
      method: 'POST',
      body: JSON.stringify({
        workspace,
        completions,
        employee_statuses: employeeStatuses,
        model,
        system_prompt: sysPrompt,
      }),
    });

    if (!result.ok || !result.stream_id) {
      console.warn('[心跳] trigger 失败:', result);
      return;
    }

    console.log('[心跳] 收到 stream_id:', result.stream_id, '开始监听 PM 回复...');

    // 通过 SSE 接收 PM专员 的心跳回复
    await _streamHeartbeatReply(result.stream_id, workspace);

  } catch (e) {
    console.error('[心跳] trigger API 调用失败:', e);
  }
}

/**
 * 接收 PM专员 心跳回复的 SSE 流。
 * 完成后解析 @mention 并自动委派任务。
 */
function _streamHeartbeatReply(streamId, workspace) {
  return new Promise((resolve) => {
    const source = new EventSource(
      new URL(`/api/chat/stream?stream_id=${encodeURIComponent(streamId)}`, location.origin).href,
      { withCredentials: true }
    );

    let accumulatedText = '';

    // 如果总群面板正在打开，在面板中实时渲染心跳回复
    let assistantRow = null;
    let bodyEl = null;

    function ensureRow() {
      if (assistantRow) return;
      if (!_isPMChatOpen()) return;  // PM聊天未打开则不渲染

      const inner = $('rpMsgInner');
      if (!inner) return;

      assistantRow = document.createElement('div');
      assistantRow.className = 'rp-msg-row gc-msg-row gc-heartbeat-reply';
      assistantRow.dataset.role = 'assistant';
      assistantRow.innerHTML = `
        <div class="rp-msg-role assistant">
          <span class="rp-msg-icon">💓</span>
          <span class="rp-msg-name">${PM_NAME} · 心跳调度</span>
        </div>
        <div class="rp-msg-body"></div>
      `;
      bodyEl = assistantRow.querySelector('.rp-msg-body');
      inner.appendChild(assistantRow);
    }

    let renderPending = false;
    function scheduleRender() {
      if (renderPending || !bodyEl) return;
      renderPending = true;
      requestAnimationFrame(() => {
        renderPending = false;
        if (bodyEl) {
          const display = _stripThinkingTags(accumulatedText);
          bodyEl.innerHTML = typeof renderMd === 'function' ? renderMd(display) : esc(display).replace(/\n/g, '<br>');
          if (typeof _scrollMsgAreaIfSticky === 'function') _scrollMsgAreaIfSticky();
        }
      });
    }

    source.addEventListener('token', e => {
      try {
        const d = JSON.parse(e.data);
        const txt = d.text || '';
        // ★ 过滤空外观 token：某些 provider/模型在 tool_calls 前发送 "{}" / "{" / "}" 等
        const _isEmptyLike = t => !t || /^[\s{}\[\]""]+$/.test(String(t).trim());
        if (!txt || _isEmptyLike(txt)) return;
        accumulatedText += txt;
        const display = _stripThinkingTags(accumulatedText);
        if (display.trim()) {
          ensureRow();
          scheduleRender();
        }
      } catch (_) {}
    });

    // ── AG-UI 精细化事件（心跳流）─────────────────────────────
    source.addEventListener('message_start', e => { try { scheduleRender(); } catch(_) {} });
    source.addEventListener('message_end', e => { try { scheduleRender(); } catch(_) {} });
    source.addEventListener('thinking_start', e => { try { scheduleRender(); } catch(_) {} });
    source.addEventListener('thinking_end', e => { try { scheduleRender(); } catch(_) {} });
    source.addEventListener('step_started', e => {
      try {
        const d = JSON.parse(e.data);
        const stepName = d.step_name || '';
        const stepLabel = stepName === 'call_llm' ? '🧠 调用模型' :
                          stepName === 'execute_tool' ? '🔧 执行工具' : stepName;
        if (typeof setComposerStatus === 'function') setComposerStatus(stepLabel);
      } catch(_) {}
    });
    source.addEventListener('step_finished', e => {
      try { if (typeof setComposerStatus === 'function') setComposerStatus(''); } catch(_) {}
    });

    source.addEventListener('done', async e => {
      source.close();
      console.log('[心跳] PM回复完成, textLen=', accumulatedText.length);

      const displayResult = _stripThinkingTags(accumulatedText.trim());
      const _pmSessionId = _getPMSessionId();

      // ★ 核心：解析 PM 回复中的 @mention 并自动委派任务
      if (displayResult) {
        await _processHeartbeatMentions(displayResult, workspace);
      }

      // ★ 刷新PM消息：3路径降级（与 _streamPMReply 一致）
      let _refreshed = false;
      // 路径 1：使用 done 事件自带的 session 数据
      try {
        const doneData = JSON.parse(e.data || '{}');
        const doneSession = doneData && doneData.session;
        // ★★★ 异步守卫：done 到达时用户可能已切到其他员工聊天，禁止写入 S.messages
        if (doneSession && doneSession.messages && doneSession.messages.length > 0 && doneSession.session_id === _pmSessionId && _isPMChatOpen()) {
          S.session = doneSession;
          S.messages = doneSession.messages || [];
          if (typeof _ensureDelegationDividersForMainSession === 'function') {
            const pm = (typeof getPMEmployee === 'function') ? getPMEmployee() : null;
            if (pm) _ensureDelegationDividersForMainSession(pm);
          }
          if (assistantRow) { assistantRow.remove(); assistantRow = null; bodyEl = null; }
          if (typeof _renderRpMessages === 'function') _renderRpMessages();
          if (typeof _scrollMsgAreaToBottom === 'function') _scrollMsgAreaToBottom();
          _refreshed = true;
        } else if (doneSession && !_isPMChatOpen()) {
          // 已切走 → 标记已处理，跳过 path2/3
          _refreshed = true;
          console.log('[心跳] done path1: 用户已切走，跳过写入 S.messages');
        }
      } catch(_) {}

      // 路径 2：从 /api/session 拉取
      if (!_refreshed && _isPMChatOpen() && _pmSessionId) {
        try {
          const sessData = await api(`/api/session?session_id=${encodeURIComponent(_pmSessionId)}`);
          // ★★★ 异步守卫：await 期间用户可能已切走
          if (!_isPMChatOpen()) {
            console.log('[心跳] done path2: 用户已切走，跳过写入 S.messages');
            _refreshed = true;
          } else if (sessData && sessData.session && sessData.session.messages && sessData.session.messages.length > 0) {
            S.session = sessData.session;
            S.messages = sessData.session.messages || [];
            if (typeof _ensureDelegationDividersForMainSession === 'function') {
              const pm = (typeof getPMEmployee === 'function') ? getPMEmployee() : null;
              if (pm) _ensureDelegationDividersForMainSession(pm);
            }
            if (assistantRow) { assistantRow.remove(); assistantRow = null; bodyEl = null; }
            if (typeof _renderRpMessages === 'function') _renderRpMessages();
            if (typeof _scrollMsgAreaToBottom === 'function') _scrollMsgAreaToBottom();
            _refreshed = true;
          }
        } catch(_) {}
      }

      // 路径 3：保留 streaming DOM（最终渲染）
      if (!_refreshed) {
        if (bodyEl && displayResult) {
          bodyEl.innerHTML = typeof renderMd === 'function' ? renderMd(displayResult) : esc(displayResult).replace(/\n/g, '<br>');
        }
      }

      resolve();
    });

    source.addEventListener('error', () => {
      source.close();
      console.warn('[心跳] SSE error');
      // 尝试从 session 获取结果并处理 @mention
      loadPMSession(workspace).then(async (pmSession) => {
        if (_isPMChatOpen()) _renderGroupMessages();
        // 尝试从最后的 assistant 消息中提取 @mention
        const msgs = (pmSession && pmSession.messages) || [];
        for (let i = msgs.length - 1; i >= 0; i--) {
          if (msgs[i].role === 'assistant' && msgs[i]._sender === PM_NAME) {
            const content = String(msgs[i].content || '');
            if (content.includes('心跳') || msgs[i]._ts > HEARTBEAT_STATE.lastTriggerTs / 1000 - 10) {
              await _processHeartbeatMentions(content, workspace);
            }
            break;
          }
        }
      }).catch(() => {});
      resolve();
    });

    source.addEventListener('apperror', e => {
      source.close();
      let errMsg = '未知错误';
      try { const d = JSON.parse(e.data); errMsg = d.message || errMsg; } catch (_) {}
      console.warn('[心跳] PM回复出错:', errMsg);
      resolve();
    });
  });
}

/**
 * 解析 PM专员 心跳回复中的 @mention，自动委派任务。
 * 只委派给存在的员工；最多 3 个任务（防止过载）。
 * 为每个员工提取与其相关的任务段落（而非全文）。
 */
async function _processHeartbeatMentions(pmReply, workspace) {
  const mentions = parse_mentions_local(pmReply);
  if (!mentions.length) {
    console.log('[心跳] PM回复中无 @mention，无需委派');
    return;
  }

  console.log('[心跳] PM回复中发现 @mentions:', mentions);

  // 过滤掉不存在的员工 + PM专员自身
  const validMentions = mentions.filter(name => {
    if (name === PM_NAME) return false;
    if (typeof EMPLOYEE_STORE === 'undefined') return false;
    return EMPLOYEE_STORE.employees.some(e => e.name === name);
  });

  if (!validMentions.length) {
    console.log('[心跳] 无有效员工 @mention');
    return;
  }

  // 限制最多 3 个委派
  const toDispatch = validMentions.slice(0, 3);
  console.log('[心跳] 自动委派任务给:', toDispatch);

  // 提取每个员工相关的任务段落：
  // 策略：按行扫描 PM 回复，从 @员工名 出现位置开始到下一个 @员工名 或段落结束
  const lines = pmReply.split('\n');

  for (const empName of toDispatch) {
    let taskDescription = '';

    // 提取与该员工相关的行
    const empMentionRegex = new RegExp(`@${empName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*`);
    let capturing = false;
    const relevantLines = [];

    for (const line of lines) {
      if (empMentionRegex.test(line)) {
        capturing = true;
        relevantLines.push(line.replace(empMentionRegex, '').trim());
      } else if (capturing) {
        // 遇到其他 @mention 或空行组结束捕获
        if (/@[\w\u4e00-\u9fff]+/.test(line) && !empMentionRegex.test(line)) {
          capturing = false;
        } else if (line.trim() === '' && relevantLines.length > 0) {
          // 空行分隔：继续收集（允许多行描述）但设上限
          if (relevantLines.length < 10) relevantLines.push(line);
          else capturing = false;
        } else {
          relevantLines.push(line);
        }
      }
    }

    taskDescription = relevantLines.join('\n').trim();
    if (!taskDescription) {
      // 回退：使用完整回复
      taskDescription = pmReply;
    }

    const taskId = `hb-task-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
    try {
      await _dispatchTaskToEmployee(empName, `@${empName} ${taskDescription}`, taskId);
    } catch (e) {
      console.warn('[心跳] 自动委派失败:', empName, e);
    }
  }

  // 在PM聊天中发送系统消息记录自动委派
  try {
    const dispatchNames = toDispatch.map(n => `@${n}`).join('、');
    await _addPMSessionMessage(`💓 心跳调度：${PM_NAME}已自动委派任务给 ${dispatchNames}`, '系统');
    if (_isPMChatOpen()) _renderGroupMessages();
  } catch (_) {}
}

// ── 初始化 ──────────────────────────────────────────────────────────────────
function initGroupChat() {
  // 覆盖 _updateDelegationBar 以包含总群链接
  // 注意：这必须在 right-panel.js 加载后执行
  window._updateDelegationBar = _updateDelegationBarWithGroupChat;

  // 初始化 @mention 补全
  initMentionAutocomplete();

  // ★ 初始化心跳监听
  _initHeartbeatListener();

  // 立即刷新委派栏，确保PM链接在页面初始加载时显示
  // （initRightPanel 在 initGroupChat 之前执行，此时 _updateDelegationBar 还是原始版本）
  if (typeof EMPLOYEE_STORE !== 'undefined' && EMPLOYEE_STORE.selectedId && typeof getEmployee === 'function') {
    const emp = getEmployee(EMPLOYEE_STORE.selectedId);
    if (emp) _updateDelegationBar(emp);
  }
}

// ── 员工模型选择器（provider + model 联动） ──────────────────────────────────

/** 同步模型 chip 显示 */
function syncEmpModelChip() {
  const emp = (typeof EMPLOYEE_STORE !== 'undefined' && EMPLOYEE_STORE.selectedId)
    ? (typeof getEmployee === 'function' ? getEmployee(EMPLOYEE_STORE.selectedId) : null)
    : null;
  const label = document.getElementById('rpEmpModelLabel');
  const chip = document.getElementById('rpEmpModelChip');
  if (!label || !chip) return;
  // 有选中员工且员工有 model → 显示员工模型短名
  // 否则显示全局 modelSelect 当前选中的模型短名
  if (emp && emp.model) {
    const shortName = emp.model.split('/').pop();
    label.textContent = shortName;
    chip.title = emp.model;
  } else {
    // 从全局 modelSelect 获取当前模型
    const sel = document.getElementById('modelSelect');
    const modelVal = sel ? sel.value : '';
    if (modelVal) {
      label.textContent = modelVal.split('/').pop();
      chip.title = modelVal;
    } else {
      label.textContent = 'Model';
      chip.title = '选择模型';
    }
  }
  // 同步 provider chip
  syncEmpProviderChip();
  // Provider / Model 选择器始终显示（替代旧的全局模型选择器）
  // ★ 联网搜索开关可见性联动
  if (typeof syncWebSearchToggle === 'function') syncWebSearchToggle();
}

/** 同步 provider chip 显示 */
function syncEmpProviderChip() {
  const emp = (typeof EMPLOYEE_STORE !== 'undefined' && EMPLOYEE_STORE.selectedId)
    ? (typeof getEmployee === 'function' ? getEmployee(EMPLOYEE_STORE.selectedId) : null)
    : null;
  const label = document.getElementById('rpEmpProviderLabel');
  const chip = document.getElementById('rpEmpProviderChip');
  if (!label || !chip) return;
  const sel = $('modelSelect');
  if (!sel) { label.textContent = 'Provider'; chip.title = '选择 Provider'; return; }
  // 有选中员工 → 从员工模型推断 provider；否则从全局 modelSelect 当前值推断
  const modelValue = (emp && emp.model) ? emp.model : (sel.value || '');
  const currentProvider = modelValue ? _getModelProvider(modelValue, sel) : '';
  // 同步 window._empSelectedProvider（如果有推断结果）
  if (currentProvider) window._empSelectedProvider = currentProvider;
  if (currentProvider) {
    // 查找 provider 友好名
    let friendlyName = currentProvider;
    for (const child of Array.from(sel.children)) {
      if (child.tagName === 'OPTGROUP' && child.label && child.label.toLowerCase() === currentProvider) {
        friendlyName = child.label;
        break;
      }
    }
    label.textContent = friendlyName;
    chip.title = friendlyName;
  } else {
    label.textContent = 'Provider';
    chip.title = '选择 Provider';
  }
}

// ── Provider 选择器 ────────────────────────────────────────────────────────

/** 切换 provider 下拉面板 */
function toggleEmpProviderDropdown() {
  const dd = document.getElementById('rpEmpProviderDropdown');
  const chip = document.getElementById('rpEmpProviderChip');
  if (!dd || !chip) return;
  const isOpen = dd.classList.contains('open');
  if (isOpen) {
    closeEmpProviderDropdown();
    return;
  }
  // 关闭另一个下拉
  closeEmpModelDropdown();
  renderEmpProviderDropdown();
  // ★ 定位下拉：对齐 chip 左侧（chip 相对于 composer-footer）
  _positionEmpDropdown(dd, chip);
  dd.classList.add('open');
  chip.classList.add('active');
  setTimeout(() => {
    document.addEventListener('click', _onEmpProviderOutsideClick, true);
    document.addEventListener('keydown', _onEmpProviderKeydown, true);
  }, 0);
}

function closeEmpProviderDropdown() {
  const dd = document.getElementById('rpEmpProviderDropdown');
  const chip = document.getElementById('rpEmpProviderChip');
  if (dd) dd.classList.remove('open');
  if (chip) chip.classList.remove('active');
  document.removeEventListener('click', _onEmpProviderOutsideClick, true);
  document.removeEventListener('keydown', _onEmpProviderKeydown, true);
}

function _onEmpProviderOutsideClick(e) {
  const dd = document.getElementById('rpEmpProviderDropdown');
  const chip = document.getElementById('rpEmpProviderChip');
  if (!dd || !chip) return;
  if (dd.contains(e.target) || chip.contains(e.target)) return;
  closeEmpProviderDropdown();
}

function _onEmpProviderKeydown(e) {
  if (e.key === 'Escape') { e.preventDefault(); closeEmpProviderDropdown(); }
}

/** 渲染 provider 下拉面板 */
function renderEmpProviderDropdown() {
  const dd = document.getElementById('rpEmpProviderDropdown');
  if (!dd) return;
  dd.innerHTML = '';
  const sel = $('modelSelect');
  if (!sel) return;

  const emp = (typeof EMPLOYEE_STORE !== 'undefined' && EMPLOYEE_STORE.selectedId)
    ? (typeof getEmployee === 'function' ? getEmployee(EMPLOYEE_STORE.selectedId) : null)
    : null;
  const modelValue = emp ? emp.model : (sel.value || '');
  const currentProvider = modelValue ? _getModelProvider(modelValue, sel) : (window._empSelectedProvider || '');

  // 收集 provider 列表（含模型数量）
  const providers = [];
  for (const child of Array.from(sel.children)) {
    if (child.tagName === 'OPTGROUP' && child.label) {
      const count = Array.from(child.children).length;
      providers.push({ name: child.label, key: child.label.toLowerCase(), count });
    }
  }

  // "全部"选项
  const allItem = document.createElement('div');
  allItem.className = 'emp-prov-item' + (!currentProvider ? ' active' : '');
  allItem.innerHTML = `<span class="emp-prov-check">${!currentProvider ? '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>' : ''}</span><span>全部</span><span class="emp-prov-count">${Array.from(sel.querySelectorAll('option')).length}</span>`;
  allItem.onclick = () => _selectEmpProvider('');
  dd.appendChild(allItem);

  for (const p of providers) {
    const item = document.createElement('div');
    item.className = 'emp-prov-item' + (p.key === currentProvider ? ' active' : '');
    item.innerHTML = `<span class="emp-prov-check">${p.key === currentProvider ? '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>' : ''}</span><span>${esc(p.name)}</span><span class="emp-prov-count">${p.count}</span>`;
    item.onclick = () => _selectEmpProvider(p.key);
    dd.appendChild(item);
  }
}

/** 选择 provider 后，设置过滤并打开 model 选择器 */
function _selectEmpProvider(providerKey) {
  // 保存当前选中的 provider key
  window._empSelectedProvider = providerKey;
  // 更新 provider chip 显示
  const label = document.getElementById('rpEmpProviderLabel');
  const chip = document.getElementById('rpEmpProviderChip');
  if (label && chip) {
    if (providerKey) {
      // 查找友好名
      const sel = $('modelSelect');
      let friendlyName = providerKey;
      if (sel) {
        for (const child of Array.from(sel.children)) {
          if (child.tagName === 'OPTGROUP' && child.label && child.label.toLowerCase() === providerKey) {
            friendlyName = child.label;
            break;
          }
        }
      }
      label.textContent = friendlyName;
      chip.title = friendlyName;
    } else {
      label.textContent = 'Provider';
      chip.title = '选择 Provider';
    }
  }
  closeEmpProviderDropdown();
  // 标记 provider chip 为 active（已选择）
  const pChip = document.getElementById('rpEmpProviderChip');
  if (pChip && providerKey) pChip.classList.add('active');
  // ★ 切换 provider 后，将 model 重置为空
  const emp = (typeof EMPLOYEE_STORE !== 'undefined' && EMPLOYEE_STORE.selectedId)
    ? (typeof getEmployee === 'function' ? getEmployee(EMPLOYEE_STORE.selectedId) : null)
    : null;
  if (emp) {
    emp.model = '';
    if (typeof _saveEmployees === 'function') _saveEmployees();
  }
  const mLabel = document.getElementById('rpEmpModelLabel');
  const mChip = document.getElementById('rpEmpModelChip');
  if (mLabel) { mLabel.textContent = 'Model'; mLabel.title = '选择模型'; }
  if (mChip) { mChip.classList.remove('active'); mChip.title = '选择模型'; }
  // 自动打开 model 选择器
  setTimeout(() => toggleEmpModelDropdown(), 80);
}

// ── Model 选择器 ────────────────────────────────────────────────────────

/** 切换员工模型下拉面板 */
function toggleEmpModelDropdown() {
  const dd = document.getElementById('rpEmpModelDropdown');
  const chip = document.getElementById('rpEmpModelChip');
  if (!dd || !chip) return;
  const isOpen = dd.classList.contains('open');
  if (isOpen) {
    closeEmpModelDropdown();
    return;
  }
  // 关闭另一个下拉
  closeEmpProviderDropdown();
  renderEmpModelDropdown();
  // ★ 定位下拉：对齐 chip 左侧
  _positionEmpDropdown(dd, chip);
  dd.classList.add('open');
  chip.classList.add('active');
  setTimeout(() => {
    document.addEventListener('click', _onEmpModelOutsideClick, true);
    document.addEventListener('keydown', _onEmpModelKeydown, true);
  }, 0);
}

function closeEmpModelDropdown() {
  const dd = document.getElementById('rpEmpModelDropdown');
  const chip = document.getElementById('rpEmpModelChip');
  if (dd) dd.classList.remove('open');
  if (chip) chip.classList.remove('active');
  document.removeEventListener('click', _onEmpModelOutsideClick, true);
  document.removeEventListener('keydown', _onEmpModelKeydown, true);
}

function _onEmpModelOutsideClick(e) {
  const dd = document.getElementById('rpEmpModelDropdown');
  const chip = document.getElementById('rpEmpModelChip');
  if (!dd || !chip) return;
  if (dd.contains(e.target) || chip.contains(e.target)) return;
  closeEmpModelDropdown();
}

function _onEmpModelKeydown(e) {
  if (e.key === 'Escape') { e.preventDefault(); closeEmpModelDropdown(); }
}

/** 渲染员工模型下拉面板（不含 provider tabs，由 provider chip 控制） */
function renderEmpModelDropdown() {
  const dd = document.getElementById('rpEmpModelDropdown');
  if (!dd) return;
  dd.innerHTML = '';

  const sel = $('modelSelect');
  if (!sel) return;

  const emp = (typeof EMPLOYEE_STORE !== 'undefined' && EMPLOYEE_STORE.selectedId)
    ? (typeof getEmployee === 'function' ? getEmployee(EMPLOYEE_STORE.selectedId) : null)
    : null;
  const currentModel = emp ? emp.model : (sel.value || '');

  // 获取当前选中的 provider（由 provider chip 设置）
  const activeProvider = window._empSelectedProvider || _getModelProvider(currentModel, sel);

  // ── Search input ──
  const searchWrap = document.createElement('div');
  searchWrap.className = 'model-search-wrap';
  searchWrap.innerHTML = '<input type="text" class="model-search-input" id="empModelSearchInput" placeholder="搜索模型..." autocomplete="off">';
  dd.appendChild(searchWrap);

  // ── Model list ──
  const listWrap = document.createElement('div');
  listWrap.className = 'model-list-wrap';
  listWrap.id = 'empModelListWrap';
  for (const child of Array.from(sel.children)) {
    if (child.tagName === 'OPTGROUP') {
      const provKey = (child.label || '').toLowerCase();
      // 如果有选中的 provider，只显示该 provider 下的模型
      if (activeProvider && provKey !== activeProvider) continue;
      const heading = document.createElement('div');
      heading.className = 'model-group';
      heading.dataset.group = child.label || 'Models';
      heading.textContent = child.label || 'Models';
      listWrap.appendChild(heading);
      for (const opt of Array.from(child.children)) {
        const row = document.createElement('div');
        row.className = 'model-opt' + (opt.value === currentModel ? ' active' : '');
        row.dataset.label = (opt.textContent || '').toLowerCase();
        row.dataset.value = opt.value.toLowerCase();
        row.dataset.provider = provKey;
        row.innerHTML = `<span class="model-opt-name">${esc(opt.textContent || '')}</span><span class="model-opt-id">${esc(opt.value)}</span>`;
        row.onclick = () => _selectEmpModel(opt.value);
        listWrap.appendChild(row);
      }
    } else if (child.tagName === 'OPTION') {
      const row = document.createElement('div');
      row.className = 'model-opt' + (child.value === currentModel ? ' active' : '');
      row.dataset.label = (child.textContent || '').toLowerCase();
      row.dataset.value = child.value.toLowerCase();
      row.dataset.provider = '';
      row.innerHTML = `<span class="model-opt-name">${esc(child.textContent || '')}</span><span class="model-opt-id">${esc(child.value)}</span>`;
      row.onclick = () => _selectEmpModel(child.value);
      listWrap.appendChild(row);
    }
  }
  dd.appendChild(listWrap);

  // ── Custom model input ──
  const customWrap = document.createElement('div');
  customWrap.className = 'model-custom-wrap';
  customWrap.innerHTML = '<div class="model-custom-divider"></div><div class="model-custom-row"><input type="text" class="model-custom-input" id="empModelCustomInput" placeholder="自定义模型 ID..." autocomplete="off"><button class="model-custom-btn" id="empModelCustomBtn" title="应用"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg></button></div>';
  dd.appendChild(customWrap);

  // ── Wire up events ──
  const searchInput = document.getElementById('empModelSearchInput');
  if (searchInput) {
    let composing = false;
    searchInput.addEventListener('compositionstart', () => { composing = true; });
    searchInput.addEventListener('compositionend', () => {
      composing = false;
      _filterEmpModelDropdown(searchInput.value);
    });
    searchInput.addEventListener('input', () => {
      if (composing) return;
      _filterEmpModelDropdown(searchInput.value.trim());
    });
    requestAnimationFrame(() => searchInput.focus());
  }

  const customInput = document.getElementById('empModelCustomInput');
  const customBtn = document.getElementById('empModelCustomBtn');
  if (customInput && customBtn) {
    const applyCustom = () => {
      const val = customInput.value.trim();
      if (val) _selectEmpModel(val);
    };
    customBtn.addEventListener('click', applyCustom);
    customInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); applyCustom(); } });
  }
}

/** 获取模型所属的 provider key */
function _getModelProvider(modelId, sel) {
  if (!modelId || !sel) return '';
  const slashIdx = modelId.indexOf('/');
  if (slashIdx > 0) {
    const prefix = modelId.slice(0, slashIdx).toLowerCase();
    for (const child of Array.from(sel.children)) {
      if (child.tagName === 'OPTGROUP' && child.label && child.label.toLowerCase() === prefix) {
        return prefix;
      }
    }
  }
  for (const child of Array.from(sel.children)) {
    if (child.tagName === 'OPTGROUP') {
      for (const opt of Array.from(child.children)) {
        if (opt.value === modelId) {
          return (child.label || '').toLowerCase();
        }
      }
    }
  }
  return '';
}

/** 搜索过滤员工模型列表 */
function _filterEmpModelDropdown(query) {
  const listWrap = document.getElementById('empModelListWrap');
  if (!listWrap) return;
  const q = (query || '').toLowerCase().trim();
  const groups = listWrap.querySelectorAll('.model-group');
  const opts = listWrap.querySelectorAll('.model-opt');
  if (!q) {
    groups.forEach(g => g.style.display = '');
    opts.forEach(o => o.style.display = '');
    return;
  }
  opts.forEach(o => {
    const label = o.dataset.label || '';
    const value = o.dataset.value || '';
    const match = label.includes(q) || value.includes(q);
    o.style.display = match ? '' : 'none';
  });
  groups.forEach(g => {
    let next = g.nextElementSibling;
    let hasVisible = false;
    while (next && !next.classList.contains('model-group')) {
      if (next.style.display !== 'none') hasVisible = true;
      next = next.nextElementSibling;
    }
    g.style.display = hasVisible ? '' : 'none';
  });
}

/** 选择模型并更新（员工模式更新员工 model，否则更新全局 modelSelect） */
function _selectEmpModel(modelId) {
  const emp = (typeof EMPLOYEE_STORE !== 'undefined' && EMPLOYEE_STORE.selectedId)
    ? (typeof getEmployee === 'function' ? getEmployee(EMPLOYEE_STORE.selectedId) : null)
    : null;

  // 员工模式：更新员工 model
  if (emp) {
    emp.model = modelId;
    if (typeof _saveEmployees === 'function') _saveEmployees();
  }

  // 同步 chip 显示
  syncEmpModelChip();

  closeEmpModelDropdown();

  // 标记 model chip 为 active（已选择）
  const mChip = document.getElementById('rpEmpModelChip');
  if (mChip) mChip.classList.add('active');

  // 同步到全局模型选择器
  const sel = $('modelSelect');
  if (sel && sel.value !== modelId) {
    if (!sel.querySelector(`option[value="${CSS.escape(modelId)}"]`)) {
      const opt = document.createElement('option');
      opt.value = modelId;
      opt.textContent = (typeof getModelLabel === 'function') ? getModelLabel(modelId) : modelId;
      sel.appendChild(opt);
    }
    sel.value = modelId;
    if (typeof syncModelChip === 'function') syncModelChip();
  }

  if (typeof showToast === 'function') {
    const shortName = modelId.split('/').pop();
    const name = emp ? emp.name : '';
    showToast(name ? `✅ ${name} 模型已切换为 ${shortName}` : `✅ 模型已切换为 ${shortName}`);
  }
  // ★ 联网搜索开关可见性联动
  if (typeof syncWebSearchToggle === 'function') syncWebSearchToggle();
}

/** 定位员工下拉面板（对齐对应 chip 的左侧） */
function _positionEmpDropdown(dd, chip) {
  const footer = dd.parentElement; // composer-footer
  if (!footer || !chip) return;
  const footerRect = footer.getBoundingClientRect();
  const chipRect = chip.getBoundingClientRect();
  dd.style.left = (chipRect.left - footerRect.left) + 'px';
}

window.syncEmpModelChip = syncEmpModelChip;
window.syncEmpProviderChip = syncEmpProviderChip;
window.toggleEmpProviderDropdown = toggleEmpProviderDropdown;
window.closeEmpProviderDropdown = closeEmpProviderDropdown;
window.toggleEmpModelDropdown = toggleEmpModelDropdown;
window.closeEmpModelDropdown = closeEmpModelDropdown;

// ── 联网搜索开关 ─────────────────────────────────────────────────────

/** 全局状态：是否启用联网搜索 */
window._webSearchEnabled = false;

/** 切换联网搜索开关 */
function toggleWebSearch() {
  window._webSearchEnabled = !window._webSearchEnabled;
  const btn = document.getElementById('webSearchToggle');
  if (btn) {
    btn.classList.toggle('active', window._webSearchEnabled);
    btn.title = window._webSearchEnabled ? '联网搜索：已开启' : '联网搜索';
  }
  if (typeof showToast === 'function') {
    showToast(window._webSearchEnabled ? '🌐 联网搜索已开启' : '联网搜索已关闭', 1500);
  }
}

/**
 * 根据当前模型更新联网搜索开关的可见性。
 * 仅在 knot-agui 模型时显示。
 */
function syncWebSearchToggle() {
  const btn = document.getElementById('webSearchToggle');
  if (!btn) return;
  // 获取当前模型（优先员工模型，否则全局模型选择器）
  let currentModel = '';
  if (typeof EMPLOYEE_STORE !== 'undefined' && EMPLOYEE_STORE.selectedId && typeof getEmployee === 'function') {
    const emp = getEmployee(EMPLOYEE_STORE.selectedId);
    if (emp) currentModel = emp.model || '';
  }
  if (!currentModel) {
    const sel = document.getElementById('modelSelect');
    if (sel) currentModel = sel.value || '';
  }
  const isKnotAgui = currentModel.startsWith('knot-agui:');
  btn.style.display = isKnotAgui ? '' : 'none';
  // 如果切换到非 knot-agui 模型，自动关闭联网搜索
  if (!isKnotAgui && window._webSearchEnabled) {
    window._webSearchEnabled = false;
    btn.classList.remove('active');
  }
}

window.toggleWebSearch = toggleWebSearch;
window.syncWebSearchToggle = syncWebSearchToggle;