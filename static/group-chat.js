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
  // ★ 自动协作模式：开启时，用户发送未 @任何人 的消息会被自动转给
  //   "制作人"（或其他 lead 角色），让其规划并通过 delegate_task 分工执行
  autoOrchestrate: (localStorage.getItem('gc_auto_orchestrate') === '1'),
};

/** 切换自动协作模式 */
function toggleAutoOrchestrate() {
  GROUP_CHAT_STATE.autoOrchestrate = !GROUP_CHAT_STATE.autoOrchestrate;
  localStorage.setItem('gc_auto_orchestrate', GROUP_CHAT_STATE.autoOrchestrate ? '1' : '0');
  // 更新按钮 UI
  const btn = document.getElementById('gcAutoOrchBtn');
  if (btn) {
    btn.classList.toggle('active', GROUP_CHAT_STATE.autoOrchestrate);
    btn.title = GROUP_CHAT_STATE.autoOrchestrate
      ? '自动协作已开启：未 @ 人的消息会交给 @制作人 规划分工'
      : '自动协作已关闭：消息仅发送给 @ 到的员工';
  }
  if (typeof showToast === 'function') {
    showToast(GROUP_CHAT_STATE.autoOrchestrate ? '✅ 自动协作已开启' : '⏸ 自动协作已关闭');
  }
}

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
  return `PM专员`;
}

/** 查找适合的"协调员"（用于自动协作模式）
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

  // ★ 2026-04-27 Bug 修复：打开总群前，主动关闭所有员工 active 任务挂在聊天面板上
  //   的 SSE（task._chatSseSource）与占位轮询定时器（task._placeholderPollTimer）。
  //   否则 DOM 已被总群渲染替换，但后台 SSE/轮询仍在运行：
  //     - SSE 会消费 done 事件，把 task.status 置为 done、清空 emp._activeTaskId，
  //       导致用户切回员工聊天时丢失"正在执行"的任务信息；
  //     - _showThinkingPlaceholder 的 500ms×60 轮询会在 streamId 到达时静默调用
  //       _attachLiveStreamToChat，但此刻总群已打开（被 isOpen 守卫拦住），轮询
  //       继续 30 秒才退出，白白消耗资源。
  //   关闭后重新打开员工聊天时，_attachLiveStreamToChat / _showThinkingPlaceholder
  //   会按新 DOM 重建；SSE 通过 STREAM_HISTORY 回放把 token 全部补给新连接。
  try {
    if (typeof DelegationVM !== 'undefined' && DelegationVM.tasks) {
      for (const task of DelegationVM.tasks.values()) {
        if (!task) continue;
        if (task._chatSseSource) {
          task._chatSseSource._intentionallyClosed = true;
          try { task._chatSseSource.close(); } catch (_) {}
          task._chatSseSource = null;
        }
        if (task._placeholderPollTimer) {
          try { clearInterval(task._placeholderPollTimer); } catch (_) {}
          task._placeholderPollTimer = null;
        }
      }
    }
  } catch (_) {}

  // 保存工作区到状态
  GROUP_CHAT_STATE.workspace = ws;

  // 先切换右侧面板视图并更新 UI（不等 API）
  _setRightPanelView('chat');
  GROUP_CHAT_STATE.isOpen = true;
  console.log('[总群] openGroupChat: isOpen set to true');

  // ★ 确保聊天 dock panel 处于 active tab 状态（与员工聊天同理），
  //   否则若用户把画布和聊天合并到同一 leaf，总群界面会被 detach 不可见
  if (typeof dockFocusPanel === 'function') {
    try { dockFocusPanel('chat'); } catch (_) {}
  }

  // 更新头部 — 显示总群头像（不显示成员，成员在委派栏中）
  const avatarEl = $('rpEmployeeAvatar');
  if (avatarEl) avatarEl.innerHTML = '<span class="gc-avatar">🏠</span>';

  const nameEl = $('rpEmployeeName');
  if (nameEl) {
    // ★ 在标题中附加"自动协作"切换按钮
    const autoOn = GROUP_CHAT_STATE.autoOrchestrate;
    nameEl.innerHTML = `${esc(_groupChatTitle(ws))}
      <button id="gcAutoOrchBtn"
              class="gc-auto-orch-btn${autoOn ? ' active' : ''}"
              onclick="event.stopPropagation();toggleAutoOrchestrate()"
              title="${autoOn ? '自动协作已开启：未 @ 人的消息会交给 @制作人 规划分工' : '点击开启自动协作：未 @ 人的消息会交给 @制作人 规划分工'}"
      >🤖 自动协作</button>`;
  }

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

  // 切换到总群：重置渲染窗口，仅渲染最近一页消息（避免历史过多时卡顿）
  if (typeof window._resetRenderWindow === 'function') {
    window._resetRenderWindow('group', ws || '__default__');
  }

  // 渲染总群空状态（先渲染空状态，不等 API）
  _renderGroupMessages();

  // 异步加载总群数据，成功后刷新消息
  if (ws) {
    try {
      await loadGroupChat(ws);
      // 数据加载完成后，再次重置窗口为"最近一页"（首次打开需要看到最新消息）
      if (typeof window._resetRenderWindow === 'function') {
        window._resetRenderWindow('group', ws);
      }
      _renderGroupMessages();
    } catch(e) {
      console.warn('[总群] loadGroupChat 失败:', e);
    }
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

/** 渲染总群消息 */
function _renderGroupMessages() {
  const inner = $('rpMsgInner');
  const emptyChat = $('rpEmptyChat');
  if (!inner) return;

  // ★ 如果总群已关闭，不渲染总群消息（防止覆盖员工聊天内容）
  if (!GROUP_CHAT_STATE.isOpen) return;

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
      <div class="gc-empty-title">PM专员</div>
      <div class="gc-empty-hint">直接发消息与PM对话，或 @员工名 来委派任务</div>
    `;
    inner.appendChild(emptyDiv);
    return;
  }

  // ── 窗口化：只渲染最近一页，更早的消息通过顶部 sentinel 加载 ──
  // 用 workspace 作为 key；切换总群所属工作区时会自动重置窗口
  const _total = msgs.length;
  const _key = (GROUP_CHAT_STATE && GROUP_CHAT_STATE.workspace) || '__default__';
  const _start = (typeof window._computeWindowStart === 'function')
    ? window._computeWindowStart(_total, 'group:' + _key, 'group')
    : 0;
  const _visible = msgs.slice(_start);

  for (const m of _visible) {
    const content = _extractContent(m);
    if (!content && !m._mentions?.length) continue;

    const row = document.createElement('div');
    row.className = 'rp-msg-row gc-msg-row';
    row.dataset.role = m.role;

    // ★ 锚点标记：单个 task_id（assistant 结果）或 task_ids 列表（user 委派消息/系统派发消息）
    if (m._task_id) row.dataset.taskId = m._task_id;
    if (Array.isArray(m._task_ids) && m._task_ids.length) {
      row.dataset.taskIds = m._task_ids.join(',');
    }

    // 发送者信息
    const senderName = m._sender || (m.role === 'user' ? '你' : m.role === 'system' ? '系统' : 'PM专员');
    const senderAvatar = _senderAvatar(m);
    const isUser = m.role === 'user';
    const isSystem = m.role === 'system';

    // 消息正文渲染
    let bodyHtml;
    if (isSystem) {
      // ★ 系统消息独立渲染：识别 {{TASK_LINK:xxx}} 占位符，转换为可点击锚点
      bodyHtml = _renderSystemMessageContent(String(content), m);
    } else {
      bodyHtml = isUser ? esc(String(content)).replace(/\n/g, '<br>') : renderMd(String(content));
      // ★ 非系统消息也识别 {{TASK_LINK:xxx}} 占位符（员工结果消息含任务 id 链接）
      bodyHtml = bodyHtml.replace(/\{\{TASK_LINK:(task-[A-Za-z0-9_-]+)\}\}/g, (_, tid) => {
        return `<a href="#" class="gc-task-link" data-task-id="${esc(tid)}" onclick="event.preventDefault();jumpToGroupChatTask('${esc(tid)}');return false;" title="点击跳转到该任务相关位置">[#${esc(tid)}]</a>`;
      });
      bodyHtml = _highlightMentions(bodyHtml);
    }

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

  // 窗口化：顶部插入 sentinel + 挂载 scroll 监听（加载更早的历史）
  if (_start > 0 && typeof window._insertHistorySentinel === 'function') {
    window._insertHistorySentinel(inner, _start, () => {
      if (typeof window._loadMoreHistory === 'function') {
        window._loadMoreHistory(_renderGroupMessages);
      }
    });
  }
  if (typeof window._attachHistoryScrollListener === 'function') {
    window._attachHistoryScrollListener(_renderGroupMessages);
  }

  // 粘底滚动：用户在底部时才跟随新消息；用户向上滚动（包括点击"加载更早"）后不打断位置
  // 注意：_loadMoreHistory 会自行恢复 scrollTop，此处的粘底调用不会干扰它（_loading 期间会提前 return）
  if (typeof window._scrollMsgAreaIfSticky === 'function' && !(_rpWindow && _rpWindow._loading)) {
    window._scrollMsgAreaIfSticky();
  }
}

/**
 * 点击任务链接（如 #task-xxx）时的跳转逻辑：
 *  - 总群面板中点击：跳转到对应员工的聊天框，定位到该任务消息
 *  - 员工聊天框中点击委派前缀链接：跳转到总群对应消息（原有行为）
 *
 * 判断依据：若总群面板正在打开，视为"从总群点击"→ 跳转到员工聊天框
 *           否则视为"从员工聊天框点击"→ 跳转到总群
 */
async function jumpToGroupChatTask(taskId) {
  if (!taskId) return;
  const fromGroupChat = typeof GROUP_CHAT_STATE !== 'undefined' && GROUP_CHAT_STATE.isOpen;
  console.log('[任务跳转] taskId=', taskId, 'fromGroupChat=', fromGroupChat);

  // ── 路径 A：从总群点击 → 跳转到员工聊天框 ──
  if (fromGroupChat) {
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

  // ── 路径 B：从员工聊天框点击 → 跳转到总群（原有行为） ──
  console.log('[跳转总群] taskId=', taskId);

  // 步骤 1：确保总群打开
  if (!GROUP_CHAT_STATE.isOpen) {
    try {
      await openGroupChat();
    } catch(e) {
      console.warn('[跳转总群] 打开总群失败:', e);
      return;
    }
  } else {
    // 已打开：确保消息是最新的
    try {
      let ws = typeof _currentCanvasWorkspace !== 'undefined' ? _currentCanvasWorkspace : '';
      if (ws === '__default__') ws = GROUP_CHAT_STATE.workspace || '';
      if (ws) {
        await loadGroupChat(ws);
        _renderGroupMessages();
      }
    } catch(_) {}
  }

  // 步骤 2：在下一帧寻找目标行（等待 DOM 渲染完成）
  requestAnimationFrame(() => {
    _scrollToGroupChatTask(taskId);
  });
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

/** 构建 PM 专员的 system prompt */
function _buildPMSystemPrompt() {
  const parts = [
    '你是 PM专员（项目管理专员），你是用户的直属助手，负责协助用户进行项目管理、任务规划、沟通协调。',
    '',
    '## 你的能力',
    '- 与用户进行自然对话，回答问题、提供建议',
    '- 帮助用户规划任务、拆解需求',
    '- 提供项目管理、团队协作方面的专业建议',
    '- 分析问题、提供解决方案',
    '',
    '## 团队成员',
  ];
  if (typeof EMPLOYEE_STORE !== 'undefined' && EMPLOYEE_STORE.employees.length) {
    for (const e of EMPLOYEE_STORE.employees) {
      parts.push(`- **${e.name}** (${e.role || '员工'})`);
    }
    parts.push('');
    parts.push('用户可以通过在消息中 @员工名 来委派任务给特定员工。当用户不 @任何人时，消息是与你（PM专员）的直接对话。');
  } else {
    parts.push('- （当前无团队成员）');
  }
  parts.push('');
  parts.push('## 工作区');
  const ws = GROUP_CHAT_STATE.workspace || '';
  if (ws) parts.push(`当前工作区路径：${ws}`);
  parts.push('');
  parts.push('请用简洁友好的语气与用户沟通。');
  return parts.join('\n');
}

async function sendGroupMessage(text) {
  console.log('[PM专员] sendGroupMessage called, text=', text);
  let ws = typeof _currentCanvasWorkspace !== 'undefined' ? _currentCanvasWorkspace : (S.session?.workspace || '');
  // 兼容 __default__：回退到 session 或默认工作区
  if (!ws || ws === '__default__') {
    ws = S.session?.workspace || GROUP_CHAT_STATE.workspace || '';
  }
  console.log('[PM专员] sendGroupMessage, ws=', ws);
  if (!ws) {
    showToast('请先选择工作区');
    return;
  }

  if (!text.trim()) return;

  let finalText = text.trim();
  const hasMention = /@[\w\u4e00-\u9fff]+/.test(finalText);

  // ★ PM专员正在回复中且新消息不含 @ → 提示等待（防止消息丢失）
  if (_pmStreamBusy && !hasMention) {
    showToast('PM专员正在回复中，请稍候...');
    return;
  }

  // ★ 分支判断（简洁版）：
  //   - 含 @ → 走委派任务流程
  //   - 不含 @ → PM专员直接AI对话（无论自动协作是否开启）

  // 立即在聊天区显示用户消息（不等 API 返回）
  GROUP_CHAT_STATE.messages.push({
    role: 'user',
    content: finalText,
    _sender: '你',
    _ts: Date.now() / 1000,
  });
  _renderGroupMessages();

  // ★ 路径 A：不含 @ 的普通消息 → PM专员直接AI对话
  if (!hasMention) {
    console.log('[PM专员] 无 @mention，走PM专员AI对话路径');
    if(typeof UAL!=='undefined') UAL.log('group-chat','pm-direct-chat',{textLen:finalText.length});

    // 直接启动PM专员AI对话（/api/chat/start 会自动把 user message 加入 session）
    await _startPMDirectChat(finalText, ws);
    return;
  }

  // ★ 路径 B：含 @ 的消息 → 走委派任务流程
  try {
    console.log('[PM专员] sendGroupMessage: calling /api/group-chat/send...');
    const data = await api('/api/group-chat/send', {
      method: 'POST',
      body: JSON.stringify({
        workspace: ws,
        message: finalText,
        sender_name: '你',
      }),
    });
    console.log('[PM专员] sendGroupMessage response:', JSON.stringify(data).slice(0, 200));

    if (data.ok) {
      // 用服务端数据刷新（替换本地临时消息）
      await loadGroupChat(ws);
      if (GROUP_CHAT_STATE.isOpen) _renderGroupMessages();

      // 如果有 @mention，委派任务给对应员工
      if (data.mentions && data.mentions.length) {
        console.log('[PM专员] mentions:', data.mentions);
        for (const mention of data.mentions) {
          _dispatchTaskToEmployee(mention.name, finalText, mention.task_id);
        }
      } else {
        console.log('[PM专员] 无 mentions');
      }
    } else {
      const errMsg = data.error || data.message || '未知错误';
      showToast(`发送失败: ${errMsg}`);
      console.warn('[PM专员] send failed:', data);
    }
  } catch(e) {
    showToast('发送失败: ' + e.message);
    console.warn('[PM专员] send error:', e);
  }
}

/**
 * PM专员直接AI对话：使用总群 session 调用 /api/chat/start，
 * 通过 SSE 流式渲染PM的回复到总群面板中。
 */
async function _startPMDirectChat(userMessage, workspace) {
  if (_pmStreamBusy) {
    showToast('PM专员正在回复中，请稍候...');
    return;
  }
  _pmStreamBusy = true;

  const sessionId = GROUP_CHAT_STATE.sessionId;
  if (!sessionId) {
    showToast('PM专员会话未初始化');
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
        <span class="rp-msg-name">PM专员</span>
      </div>
      <div class="rp-msg-body"><span class="gc-pm-dots">思考中...</span></div>
    `;
    inner.appendChild(thinkingEl);
    if (typeof _scrollMsgAreaIfSticky === 'function') _scrollMsgAreaIfSticky();
  }

  try {
    console.log('[PM专员] 启动AI对话, session_id=', sessionId, 'model=', model);
    const startData = await api('/api/chat/start', {
      method: 'POST',
      body: JSON.stringify({
        session_id: sessionId,
        message: userMessage,
        model: model,
        workspace: workspace || undefined,
        system_prompt: sysPrompt,
        employee_name: 'PM专员',
      }),
    });

    const streamId = startData.stream_id;
    console.log('[PM专员] chat/start 返回, stream_id=', streamId);

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
    showToast('PM专员对话失败: ' + e.message);
    console.error('[PM专员] 对话失败:', e);
    _pmStreamBusy = false;
  }
}

/**
 * 通过 SSE 流式接收 PM 专员的回复并渲染到总群面板。
 * 完成后将回复存入总群 session 并刷新。
 */
function _streamPMReply(streamId, workspace, thinkingEl) {
  return new Promise((resolve) => {
    const source = new EventSource(
      new URL(`/api/chat/stream?stream_id=${encodeURIComponent(streamId)}`, location.origin).href,
      { withCredentials: true }
    );

    let accumulatedText = '';
    let assistantRow = null;
    let bodyEl = null;

    // 渲染辅助：创建/获取PM回复的消息行
    function ensureRow() {
      if (assistantRow) return;
      // 移除思考中占位
      if (thinkingEl) { thinkingEl.remove(); thinkingEl = null; }

      const inner = $('rpMsgInner');
      if (!inner) return;

      assistantRow = document.createElement('div');
      assistantRow.className = 'rp-msg-row gc-msg-row';
      assistantRow.dataset.role = 'assistant';
      assistantRow.innerHTML = `
        <div class="rp-msg-role assistant">
          <span class="rp-msg-icon">🤖</span>
          <span class="rp-msg-name">PM专员</span>
        </div>
        <div class="rp-msg-body"></div>
      `;
      bodyEl = assistantRow.querySelector('.rp-msg-body');
      inner.appendChild(assistantRow);
    }

    // rAF 节流渲染
    let renderPending = false;
    function scheduleRender() {
      if (renderPending) return;
      renderPending = true;
      requestAnimationFrame(() => {
        renderPending = false;
        if (bodyEl) {
          // 剥离思考标签后渲染
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
        if (!txt) return;

        // 思考标签过滤（与 messages.js 一致）
        accumulatedText += txt;

        // 有内容后显示消息行
        const display = _stripThinkingTags(accumulatedText);
        if (display.trim()) {
          ensureRow();
          scheduleRender();
        }
      } catch (_) {}
    });

    source.addEventListener('tool', e => {
      // PM专员对话中的工具调用：显示工具状态
      try {
        const d = JSON.parse(e.data);
        ensureRow();
        if (bodyEl && d.name) {
          // 简单显示工具执行信息
          const toolInfo = document.createElement('div');
          toolInfo.className = 'gc-pm-tool-info';
          toolInfo.textContent = `🔧 ${d.name}${d.preview ? ': ' + d.preview : ''}`;
          bodyEl.appendChild(toolInfo);
          if (typeof _scrollMsgAreaIfSticky === 'function') _scrollMsgAreaIfSticky();
        }
      } catch (_) {}
    });

    source.addEventListener('done', async () => {
      source.close();
      console.log('[PM专员] SSE done, textLen=', accumulatedText.length);

      // 移除思考中占位（如果还存在）
      if (thinkingEl) { thinkingEl.remove(); thinkingEl = null; }

      // 最终渲染
      const displayResult = _stripThinkingTags(accumulatedText.trim());
      if (bodyEl && displayResult) {
        bodyEl.innerHTML = typeof renderMd === 'function' ? renderMd(displayResult) : esc(displayResult).replace(/\n/g, '<br>');
      }

      // 刷新总群消息（后端 session 已包含 AI 回复）
      try {
        await loadGroupChat(workspace);
        if (GROUP_CHAT_STATE.isOpen) _renderGroupMessages();
      } catch (_) {}

      _pmStreamBusy = false;
      resolve();
    });

    source.addEventListener('error', () => {
      source.close();
      if (thinkingEl) { thinkingEl.remove(); thinkingEl = null; }
      console.warn('[PM专员] SSE error');

      // 尝试从 session 获取结果
      _pmStreamBusy = false;
      loadGroupChat(workspace).then(() => {
        if (GROUP_CHAT_STATE.isOpen) _renderGroupMessages();
      }).catch(() => {});
      resolve();
    });

    source.addEventListener('apperror', e => {
      source.close();
      if (thinkingEl) { thinkingEl.remove(); thinkingEl = null; }
      let errMsg = '未知错误';
      try { const d = JSON.parse(e.data); errMsg = d.message || d.hint || errMsg; } catch (_) {}
      showToast(`PM专员回复出错: ${errMsg}`);
      console.warn('[PM专员] SSE apperror:', errMsg);
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

  // ★ 若是 orchestrate 模式，构造可用团队成员清单供协调员查阅
  let orchestrateBlock = '';
  if (opts.orchestrate && typeof EMPLOYEE_STORE !== 'undefined') {
    const teammates = (EMPLOYEE_STORE.employees || [])
      .filter(e => e.name !== empName)
      .slice(0, 20)
      .map(e => `- **${e.name}** (${e.role || '员工'})`)
      .join('\n');
    orchestrateBlock = `

---
🧭 **协作模式 · 你是此任务的协调员（Orchestrator）**

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

  const fullTaskMsg = `[总群委派任务 #${taskId}]
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
  if (ws === '__default__') ws = S.session?.workspace || GROUP_CHAT_STATE.workspace || '';

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
      // 通知总群任务已被用户取消
      if (ws) {
        try {
          await api('/api/group-chat/result', {
            method: 'POST',
            body: JSON.stringify({
              workspace: ws,
              employee_name: emp.name,
              task_id: taskId,
              result: '⏹ 任务已被用户取消',
              requester_name: '你',
            }),
          });
          await loadGroupChat(ws);
          if (GROUP_CHAT_STATE.isOpen) _renderGroupMessages();
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
    // 入队列等待 → 在总群发系统提示
    showToast(`已加入「${empName}」的任务队列（第 ${pos} 位）`);
    if (ws) {
      try {
        await api('/api/group-chat/send', {
          method: 'POST',
          body: JSON.stringify({
            workspace: ws,
            message: `📋 任务 {{TASK_LINK:${taskId}}} 已加入 **${empName}** 的任务队列（第 ${pos} 位），等当前任务完成后自动开始`,
            sender_name: '系统',
          }),
        });
        await loadGroupChat(ws);
        if (GROUP_CHAT_STATE.isOpen) _renderGroupMessages();
      } catch (_) {}
    }
  }
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
  // 总群面板打开时不追加（防止覆盖总群内容）
  if (typeof GROUP_CHAT_STATE !== 'undefined' && GROUP_CHAT_STATE.isOpen) return false;
  // 检查员工聊天面板是否已打开且指向该员工
  if (typeof EMPLOYEE_STORE === 'undefined' || EMPLOYEE_STORE.selectedId !== emp.id) return false;
  if (typeof window._rpView !== 'undefined' && window._rpView !== 'chat') return false;

  console.log('[总群] 员工聊天面板已打开，自动接入委派任务 SSE, emp=', emp.name, 'taskId=', task.id);

  // 在聊天面板中添加委派消息 + 任务分隔标记（如果还没有）
  if (typeof S !== 'undefined' && S.messages) {
    const taskPrefix = `[总群委派任务 #${task.id}]`;
    const hasDivider = S.messages.some(m => m._taskDivider && m._taskId === task.id);
    if (!hasDivider) {
      const activeLabelRaw = task.taskContent
        ? task.taskContent.replace(/^\[总群委派任务 #[^\]]+\]\s*/, '').split('\n').find(l => l.trim() && !l.startsWith('---') && !l.startsWith('⚠️')) || ''
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
    const hasTaskMsg = S.messages.some(m =>
      m.role === 'user' && String(m.content || '').includes(taskPrefix)
    );
    if (!hasTaskMsg && task.taskContent) {
      S.messages.push({ role: 'user', content: task.taskContent, _ts: Date.now() / 1000, _taskId: task.id });
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

  const sysPrompt = typeof buildEmployeeSystemPrompt === 'function' ? buildEmployeeSystemPrompt(emp) : '';
  const model = emp.model || $('modelSelect')?.value || '';

  try {
    console.log('[总群] 调用 /api/chat/start, session_id=', taskSessionId, 'model=', model);
    const startData = await api('/api/chat/start', {
      method: 'POST',
      body: JSON.stringify({
        session_id: taskSessionId,
        message: fullTaskMsg,
        model: model,
        workspace: ws || undefined,
        system_prompt: sysPrompt || undefined,
        employee_name: emp.name || '',
      }),
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
              await api('/api/group-chat/result', {
                method: 'POST',
                body: JSON.stringify({
                  workspace: task.workspace,
                  employee_name: task.empName,
                  task_id: task.id,
                  result: displayResult,
                  requester_name: task.requesterName || '你',
                }),
              });
            } catch(e) {
              console.warn('[总群] 轮询回传结果失败:', e);
            }
          }
        }

        // 刷新总群消息
        try {
          await loadGroupChat(task.workspace);
          if (GROUP_CHAT_STATE.isOpen) _renderGroupMessages();
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
      task.accumulatedText += d.text;
    } catch(_) {}
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
            api('/api/group-chat/send', {
              method: 'POST',
              body: JSON.stringify({
                workspace: task.workspace,
                message: `**${task.empName}** 正在将任务委派给 **${targetName}**...`,
                sender_name: task.empName,
              }),
            }).catch(() => {});
          }
        }
      } else if (d.name === 'send_group_message') {
        // ★ 员工通过 send_group_message 向总群发消息，若包含 @mentions 则自动委派任务
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
          loadGroupChat(task.workspace).then(() => {
            if (GROUP_CHAT_STATE.isOpen) _renderGroupMessages();
          }).catch(() => {});
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
      if (typeof setEmployeeStatus === 'function') setEmployeeStatus(emp.id, 'idle');
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
          await api('/api/group-chat/result', {
            method: 'POST',
            body: JSON.stringify({
              workspace: task.workspace,
              employee_name: task.empName,
              task_id: task.id,
              result: displayResult,
              requester_name: task.requesterName || '你',
            }),
          });
        } catch(e) {
          console.warn('回传结果失败:', e);
        }
      }
    }

    // Always refresh group chat messages
    try {
      await loadGroupChat(task.workspace);
      if (GROUP_CHAT_STATE.isOpen) _renderGroupMessages();
    } catch(e) {
      console.warn('刷新总群消息失败:', e);
    }

    // 推进队列
    if (job && typeof DelegationVM !== 'undefined') {
      try { DelegationVM.completeJob(task.empId, task.id, 'done'); } catch(_) {}
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
      api('/api/group-chat/result', {
        method: 'POST',
        body: JSON.stringify({
          workspace: task.workspace,
          employee_name: task.empName,
          task_id: task.id,
          result: `❌ 执行出错: ${errMsg}`,
          requester_name: task.requesterName || '你',
        }),
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

  console.log('[总群] _updateGroupDelegationBar called, isOpen=', GROUP_CHAT_STATE.isOpen, 'employees=', typeof EMPLOYEE_STORE !== 'undefined' ? EMPLOYEE_STORE.employees.length : 'N/A', 'selectedId=', typeof EMPLOYEE_STORE !== 'undefined' ? EMPLOYEE_STORE.selectedId : 'N/A');

  const parts = [];

  // 总群链接 — 多级兜底获取工作区路径
  let ws = GROUP_CHAT_STATE.workspace || '';
  if (!ws || ws === '__default__') ws = (typeof _currentCanvasWorkspace !== 'undefined' ? _currentCanvasWorkspace : '');
  if (!ws || ws === '__default__') ws = (S.session?.workspace || '');
  if (!ws || ws === '__default__') ws = (typeof _activeWorkspacePath === 'function' ? _activeWorkspacePath() : '');
  if (!ws && typeof _currentCanvasWorkspace !== 'undefined') ws = _currentCanvasWorkspace;
  if (ws) {
    parts.push(`<span class="rp-del-name gc-link" onclick="openGroupChat()" title="打开PM专员">PM专员</span>`);
  }

  // 成员（PM专员打开时显示：按钮 + 下拉面板，支持层级展示）
  if (GROUP_CHAT_STATE.isOpen) {
    _refreshGroupMembers();
    const members = GROUP_CHAT_STATE.members;
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

  // 方案 B：总群模式下显示所有正在跑任务的员工的"取消"按钮
  if (GROUP_CHAT_STATE.isOpen && typeof DelegationVM !== 'undefined' && DelegationVM.running) {
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

  // ★ 守卫：若员工下属下拉或总群成员下拉当前处于打开状态，跳过刷新，避免销毁输入框 DOM 导致焦点丢失与中文输入被打断
  const _ddGroup = document.getElementById('gcMembersDropdown');
  const _ddEmpSubs = document.getElementById('empSubsDropdown');
  if ((_ddGroup && _ddGroup.style.display && _ddGroup.style.display !== 'none')
      || (_ddEmpSubs && _ddEmpSubs.style.display && _ddEmpSubs.style.display !== 'none')) {
    return;
  }

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
  // 最终兜底：使用 _currentCanvasWorkspace 即使是 __default__（确保始终有PM专员名）
  if (!ws && typeof _currentCanvasWorkspace !== 'undefined') ws = _currentCanvasWorkspace;
  if (ws) {
    parts.push(`<span class="rp-del-name gc-link" onclick="openGroupChat()" title="打开PM专员">PM专员</span>`);
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
      parts.push(_renderSubsSegment(emp.id, subs));
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
