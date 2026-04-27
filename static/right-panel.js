/**
 * right-panel.js — 右侧面板（对话/技能详情切换）
 */

// ── 粘底滚动辅助 ─────────────────────────────────────────────────────────────
// 行为：用户滚到底部（或靠近底部 30px 内）时视为"粘底"，之后新消息会自动跟随。
// 用户手动向上滚动后取消粘底，新消息不会打断阅读；回到底部再次粘底。
const _STICKY_THRESHOLD = 32; // px 容差
const _rpStickyState = { attached: false, sticky: true };

function _isMsgAreaSticky() {
  return _rpStickyState.sticky;
}

function _attachMsgAreaStickyListener() {
  if (_rpStickyState.attached) return;
  const el = document.getElementById('rpMessages');
  if (!el) return;
  _rpStickyState.attached = true;
  el.addEventListener('scroll', () => {
    const distance = el.scrollHeight - el.scrollTop - el.clientHeight;
    _rpStickyState.sticky = distance < _STICKY_THRESHOLD;
  }, { passive: true });
}

/** 若当前处于粘底状态，则滚到底；否则保持不动。 */
function _scrollMsgAreaIfSticky() {
  _attachMsgAreaStickyListener();
  const el = document.getElementById('rpMessages');
  if (!el) return;
  if (_rpStickyState.sticky) {
    // ★ 2026-04-27: 显式 instant，防御将来 CSS 或上游全局样式加了 scroll-behavior: smooth
    try {
      el.scrollTo({ top: el.scrollHeight, behavior: 'instant' });
    } catch (_) {
      el.scrollTop = el.scrollHeight;
    }
  }
}

/** 强制滚到底（用于：用户发送消息、首次打开会话、显式跳转）并重置粘底标记。
 *  ★ 微信聊天式体验：由于消息 DOM 插入后，图片/代码高亮/字体布局等可能异步
 *    使 scrollHeight 持续增长若干毫秒；单次设置 scrollTop 会停在"中间"。
 *    这里用多帧稳定策略：立即置底 → requestAnimationFrame 再置底 → 再延时 60ms/160ms 各置底一次。
 *  ★ 2026-04-27: 全程用 behavior:'instant' 瞬时置底，防止 CSS scroll-behavior:smooth
 *    被意外加回后导致"从顶部慢慢滚到底"的动画。
 */
function _scrollMsgAreaToBottom() {
  _attachMsgAreaStickyListener();
  const el = document.getElementById('rpMessages');
  if (!el) return;
  const snap = () => {
    if (!document.body.contains(el)) return;
    try {
      el.scrollTo({ top: el.scrollHeight, behavior: 'instant' });
    } catch (_) {
      el.scrollTop = el.scrollHeight;
    }
    _rpStickyState.sticky = true;
  };
  snap();
  requestAnimationFrame(snap);
  setTimeout(snap, 60);
  setTimeout(snap, 160);
  setTimeout(snap, 320);
}
// 导出供 messages.js / group-chat.js 在用户发送消息后调用
window._scrollMsgAreaToBottom = _scrollMsgAreaToBottom;
window._scrollMsgAreaIfSticky = _scrollMsgAreaIfSticky;

// ── 聊天窗口化渲染（只渲染最近 N 条，向上滚动加载历史） ──────────────────────
// 目的：聊天消息很多时，避免一次性 DOM 渲染造成卡顿。
// 行为：
//  - 每次渲染只显示 `_rpWindow.startIdx` 到消息末尾的切片，默认打开时只渲染最近 _RP_PAGE_SIZE 条
//  - 列表顶部插入 "加载更多历史" sentinel；用户滚到顶部附近时，startIdx -= PAGE_SIZE，重新渲染并恢复 scrollTop，使视觉位置不跳动
//  - 切换会话/员工时由调用方显式调用 _resetRenderWindow() 重置
const _RP_PAGE_SIZE = 30;           // 每次加载/初始显示的消息数量
const _RP_NEAR_TOP_PX = 80;         // 距离顶部 < 此值时视为触达
const _rpWindow = {
  source: '',        // 'employee' | 'group'，用于切换会话时判定是否需要重置
  key: '',           // 会话标识（session_id 或 workspace），变化时重置
  startIdx: 0,       // 从可见消息数组的哪个下标开始渲染
  total: 0,          // 可见消息总数（渲染时由 _applyRenderWindow 记录）
  scrollAttached: false,
  _loading: false,
};
window._rpWindow = _rpWindow;

/**
 * 重置渲染窗口到"只显示最近 PAGE_SIZE 条"。
 * 调用时机：切换员工/会话/工作区；用户发送新消息（可选，保持粘底即可）；
 * @param {string} source - 'employee' | 'group'
 * @param {string} key    - 会话唯一标识
 */
function _resetRenderWindow(source, key) {
  _rpWindow.source = source || '';
  _rpWindow.key = key || '';
  _rpWindow.startIdx = -1;  // -1 表示"按 total 自动取最近一页"，由渲染函数根据 total 计算
  _rpWindow.total = 0;
}
window._resetRenderWindow = _resetRenderWindow;

/**
 * 根据当前 total 与 _rpWindow 状态，计算实际的 startIdx。
 * - 首次渲染（startIdx=-1）或会话切换：取最近一页
 * - 新消息到达（total 增大，startIdx>=0）：startIdx 保持不变，窗口自然扩大
 * - total 变小（消息被清空/重新加载）：重置为最近一页
 * - key 变化（切换员工/会话/工作区）：自动重置（调用方可省略显式 _resetRenderWindow）
 *
 * @param {number} total  当前可见消息总数
 * @param {string} [key]  （可选）会话标识。传入且与上次不同 → 自动触发重置
 * @param {string} [source] （可选）'employee' | 'group'，用于记录来源
 */
function _computeWindowStart(total, key, source) {
  // key 变化检测：用户切换员工/工作区时自动重置（免得调用方到处记着调 _resetRenderWindow）
  if (key !== undefined && key !== null && String(key) !== _rpWindow.key) {
    _rpWindow.source = source || _rpWindow.source || '';
    _rpWindow.key = String(key);
    _rpWindow.startIdx = -1;
    _rpWindow.total = 0;
  }
  if (_rpWindow.startIdx < 0 || total < _rpWindow.total) {
    _rpWindow.startIdx = Math.max(0, total - _RP_PAGE_SIZE);
  }
  if (_rpWindow.startIdx > total) _rpWindow.startIdx = Math.max(0, total - _RP_PAGE_SIZE);
  _rpWindow.total = total;
  return _rpWindow.startIdx;
}
window._computeWindowStart = _computeWindowStart;

/** 在消息列表顶部插入 "加载更多历史" sentinel 元素（返回 DOM 节点），便于点击回退。 */
function _insertHistorySentinel(inner, remaining, onClick) {
  if (!inner || remaining <= 0) return null;
  const sentinel = document.createElement('div');
  sentinel.className = 'rp-history-sentinel';
  sentinel.setAttribute('role', 'button');
  sentinel.setAttribute('tabindex', '0');
  sentinel.innerHTML =
    `<span class="rp-history-icon">⇡</span>` +
    `<span class="rp-history-label">加载更早的历史（还有 ${remaining} 条）</span>`;
  sentinel.addEventListener('click', () => onClick && onClick());
  sentinel.addEventListener('keydown', (e) => {
    if ((e.key === 'Enter' || e.key === ' ') && onClick) { e.preventDefault(); onClick(); }
  });
  inner.insertBefore(sentinel, inner.firstChild);
  return sentinel;
}
window._insertHistorySentinel = _insertHistorySentinel;

/** 加载上一页历史：startIdx -= PAGE_SIZE，重新渲染并保持视觉位置。 */
function _loadMoreHistory(rerenderFn) {
  if (_rpWindow._loading) return;
  if (_rpWindow.startIdx <= 0) return;
  _rpWindow._loading = true;
  _rpWindow._loadCooldownUntil = Date.now() + 400; // 防抖：加载完成后 400ms 内不再触发
  const el = document.getElementById('rpMessages');
  const prevScrollHeight = el ? el.scrollHeight : 0;
  const prevScrollTop = el ? el.scrollTop : 0;
  _rpWindow.startIdx = Math.max(0, _rpWindow.startIdx - _RP_PAGE_SIZE);
  try {
    if (typeof rerenderFn === 'function') rerenderFn();
  } finally {
    // 恢复 scrollTop：新的 scrollHeight - 旧的 scrollHeight = 新增的顶部内容高度
    // 用 requestAnimationFrame 确保 DOM 已提交渲染，scrollHeight 是最新值
    requestAnimationFrame(() => {
      if (el) {
        const delta = el.scrollHeight - prevScrollHeight;
        el.scrollTop = prevScrollTop + delta;
      }
      _rpWindow._loading = false;
    });
  }
}
window._loadMoreHistory = _loadMoreHistory;

/** 挂载滚动监听：用户滚到顶部 < _RP_NEAR_TOP_PX 时自动加载上一页。 */
function _attachHistoryScrollListener(rerenderFn) {
  if (_rpWindow.scrollAttached) {
    _rpWindow._activeRerender = rerenderFn; // 更新回调以指向当前视图（员工/总群）
    return;
  }
  const el = document.getElementById('rpMessages');
  if (!el) return;
  _rpWindow.scrollAttached = true;
  _rpWindow._activeRerender = rerenderFn;
  el.addEventListener('scroll', () => {
    if (_rpWindow._loading) return;
    if (_rpWindow._loadCooldownUntil && Date.now() < _rpWindow._loadCooldownUntil) return;
    if (_rpWindow.startIdx <= 0) return;
    if (el.scrollTop < _RP_NEAR_TOP_PX) {
      const fn = _rpWindow._activeRerender;
      if (typeof fn === 'function') _loadMoreHistory(fn);
    }
  }, { passive: true });
}
window._attachHistoryScrollListener = _attachHistoryScrollListener;

// ── 面板视图切换 ────────────────────────────────────────────────────────────
let _rpView = 'empty'; // 'empty' | 'chat' | 'skill' | 'file' | 'prompt'
window._rpView = _rpView; // ★ 暴露到 window 以便 messages.js / ui.js 跨文件读取


function _setRightPanelView(view) {
  // ★ 空态优化：当被要求进入 empty 视图时，若存在员工却未选中，自动选中一个。
  //   这样用户切换"聊天"tab 时不会再看到"还没有员工可对话"——哪怕已经有员工了。
  //   只在 EMPLOYEE_STORE 已就绪时尝试；避免打断 onboarding 等首次流程。
  if (view === 'empty'
      && typeof EMPLOYEE_STORE !== 'undefined'
      && Array.isArray(EMPLOYEE_STORE.employees)
      && EMPLOYEE_STORE.employees.length > 0) {
    if (!EMPLOYEE_STORE.selectedId) {
      // 优先取上次记住的员工 id；否则取第一个
      let pickId = null;
      try { pickId = localStorage.getItem('hermes-webui-selected-employee') || null; } catch (_) {}
      if (pickId && !EMPLOYEE_STORE.employees.some(e => e && e.id === pickId)) {
        pickId = null;
      }
      if (!pickId) pickId = EMPLOYEE_STORE.employees[0].id;
      if (pickId && typeof selectEmployee === 'function') {
        // selectEmployee 内部会走 openEmployeeChat → _setRightPanelView('chat')
        selectEmployee(pickId, true);
        return;
      }
    }
  }

  // 动态更新 empty 视图的文案（有员工但暂时未选中时，文案不该是"还没有员工"）
  if (view === 'empty') {
    const titleEl = $('rpEmptyTitle');
    const hintEl = $('rpEmptyHint');
    const hasEmployees = typeof EMPLOYEE_STORE !== 'undefined'
      && Array.isArray(EMPLOYEE_STORE.employees)
      && EMPLOYEE_STORE.employees.length > 0;
    if (titleEl) {
      titleEl.textContent = hasEmployees ? '选择一位员工开始对话' : '还没有员工可对话';
    }
    if (hintEl) {
      hintEl.textContent = hasEmployees
        ? '在画布上点击员工卡片，或点击顶部"总群"进入群聊'
        : '点击右上角"添加员工"创建你的第一个 AI 助手';
    }
  }

  _rpView = view;
  window._rpView = view; // ★ 同步到 window
  const chatView = $('rpChatView');
  const skillView = $('rpSkillView');
  const fileView = $('rpFileView');
  const promptView = $('rpPromptView');
  const emptyView = $('rpEmpty');

  // ★ 2026-04 新布局：file view 在右栏输出区；其他 view 在中栏 chat-panel。
  //   因此 file 与其他 view 独立，不互相遮蔽。
  if (view === 'file') {
    if (fileView) fileView.style.display = 'flex';
    // 其他中栏视图保持原状（不改动）
  } else {
    if (chatView) chatView.style.display = view === 'chat' ? 'flex' : 'none';
    if (skillView) skillView.style.display = view === 'skill' ? 'flex' : 'none';
    if (promptView) promptView.style.display = view === 'prompt' ? 'flex' : 'none';
    if (emptyView) emptyView.style.display = view === 'empty' ? 'flex' : 'none';
    // 切到非 file 视图时：隐藏文件预览
    if (fileView) fileView.style.display = 'none';
  }

  // 右侧面板始终显示（不再折叠）
  const panel = $('rightPanel');
  const layout = document.querySelector('.layout');
  if (panel) {
    // 强制面板可见 — 使用 inline style 覆盖所有 CSS 规则
    panel.classList.remove('rp-collapsed');
    panel.style.display = 'flex';
    panel.style.opacity = '1';
    panel.style.pointerEvents = '';
    panel.style.width = panel.style.width || '460px';
    panel.style.minWidth = panel.style.minWidth || '340px';
    // 始终移除 workspace-panel-collapsed 确保面板可见
    if (layout) {
      layout.classList.remove('workspace-panel-collapsed');
    }
    // 移动端处理
    if (typeof _isCompactWorkspaceViewport === 'function' && _isCompactWorkspaceViewport()) {
      if (view !== 'empty') {
        panel.classList.add('mobile-open');
      }
    }
  }
}

function closeRightPanel() {
  EMPLOYEE_STORE.selectedId = null;
  localStorage.removeItem('hermes-webui-selected-employee');
  document.querySelectorAll('.emp-card').forEach(c => c.classList.remove('emp-selected'));
  // 关闭总群模式
  if (typeof GROUP_CHAT_STATE !== 'undefined') GROUP_CHAT_STATE.isOpen = false;
  // 恢复总群隐藏的头部按钮
  const btnEditPrompt = $('btnEditPrompt');
  if (btnEditPrompt) btnEditPrompt.style.display = '';
  const btnCondense = $('btnCondenseSkill');
  if (btnCondense) btnCondense.style.display = '';
  const btnSkills = $('btnEmployeeSkills');
  if (btnSkills) btnSkills.style.display = '';
  // 移动端滑出
  const panel = $('rightPanel');
  if (panel) panel.classList.remove('mobile-open');
  // 如果还有其他员工，自动选第一个；否则显示空状态
  if (EMPLOYEE_STORE.employees.length > 0) {
    selectEmployee(EMPLOYEE_STORE.employees[0].id);
  } else {
    _setRightPanelView('empty');
  }
}

// ── 员工对话模式 ────────────────────────────────────────────────────────────
async function openEmployeeChat(empId, taskId) {
  const emp = getEmployee(empId);
  if (!emp) return;

  // ★ 确保聊天面板（dock chat panel）在当前 leaf 中处于 active tab 状态。
  //   若用户把画布和聊天合并到同一 leaf（通过 tab 拖拽），不激活的话
  //   chat 的 DOM 会被 dock detach 在内存中，用户看到的仍是画布，
  //   表现为"点击员工卡片的聊天按钮没有跳转"。
  if (typeof dockFocusPanel === 'function') {
    try { dockFocusPanel('chat'); } catch (_) {}
  }

  // ★ 用户显式点击员工卡片 / 调用 openEmployeeChat 时：关闭总群模式
  //   原先这里为"防竞态"直接 return，但会导致"切换总群↔员工"时员工聊天无法刷新。
  //   改为：显式关闭总群 + 停总群轮询 + 继续走员工聊天流程。
  //   注意：不在这里清空 rpMsgInner —— 下面 _renderRpMessages 自己会清并重绘，
  //         提前清空会在 await 卡顿时造成"长时间空白"的视觉感。
  if (typeof GROUP_CHAT_STATE !== 'undefined' && GROUP_CHAT_STATE.isOpen) {
    console.log('[openEmployeeChat] 关闭总群模式，切换到员工聊天:', emp.name);
    GROUP_CHAT_STATE.isOpen = false;
    // 停止总群轮询（若存在）
    if (typeof _stopGroupChatPolling === 'function') {
      try { _stopGroupChatPolling(); } catch (_) {}
    }
  }

  // ★★★ 合并加载该员工所有委派任务的 session 消息 + 主 session 消息
  //   无论是否指定 taskId，都加载主 session + 所有已完成委派任务的 session，合并显示
  //   taskId 仅用于跳转后滚动定位，不影响数据加载逻辑
  const targetSessionId = emp.sessionId;

  _setRightPanelView('chat');

  // 更新头部信息
  const avatarEl = $('rpEmployeeAvatar');
  if (avatarEl) {
    if (emp.characterImg) {
      const fb = (emp.avatar||'').replace(/'/g, "\\'");
      avatarEl.innerHTML = `<div class="rp-employee-avatar-sprite" style="background-image:url('/static/img/characters/${emp.characterImg}_frame32x32.png');background-size:300% 400%;background-position:0 0;background-repeat:no-repeat" data-fallback="${fb}" onerror="this.remove();this.parentElement.textContent='${fb}'"></div>`;
    } else {
      avatarEl.textContent = emp.avatar;
    }
  }
  const nameEl = $('rpEmployeeName');
  if (nameEl) nameEl.textContent = emp.name;
  const roleEl = $('rpEmployeeRole');
  if (roleEl) roleEl.textContent = emp.role;

  // 规范化员工的 model：短名称（如 'sonnet'）→ 完整模型 ID（如 'anthropic/claude-sonnet-4.6'）
  if (emp.model && typeof _findModelInDropdown === 'function' && $('modelSelect')) {
    const resolved = _findModelInDropdown(emp.model, $('modelSelect'));
    if (resolved && resolved !== emp.model) {
      emp.model = resolved;
      if (typeof _saveEmployees === 'function') _saveEmployees();
      if (typeof _updateCardTokenUsage === 'function') _updateCardTokenUsage(emp);
    }
  }

  if (!targetSessionId) {
    try {
      // 传递当前工作区路径，确保新 session 的 workspace 与画布工作区一致
      const currentWs = (typeof _currentCanvasWorkspace !== 'undefined' && _currentCanvasWorkspace && _currentCanvasWorkspace !== '__default__')
        ? _currentCanvasWorkspace
        : (S.session?.workspace || '');
      const data = await api('/api/session/new', { method: 'POST', body: JSON.stringify({
        model: emp.model || $('modelSelect')?.value || '',
        workspace: currentWs || undefined,
      }) });
      // ★ 异步完成后再次检查总群状态（防止竞态条件）
      if (typeof GROUP_CHAT_STATE !== 'undefined' && GROUP_CHAT_STATE.isOpen) {
        console.log('[openEmployeeChat] 异步创建会话完成，但总群已打开，跳过渲染');
        return;
      }
      if (data.session) {
        emp.sessionId = data.session.session_id;
        _saveEmployees();
        S.session = data.session;
        S.messages = [];
        // 切换员工/新建会话：重置渲染窗口 → 渲染 → 滚到最底（微信式）
        _resetRenderWindow('employee', S.session.session_id);
        _renderRpMessages();
        _scrollMsgAreaToBottom();
        // 同步模型下拉框到员工的模型
        const effectiveModel = emp.model || data.session.model;
        if (effectiveModel && typeof _applyModelToDropdown === 'function') {
          _applyModelToDropdown(effectiveModel, $('modelSelect'));
        }
      }
    } catch(e) {
      showToast('创建会话失败: ' + e.message);
      return;
    }
  } else {
    // ★ 加载主 session + 异步合并所有委派任务 session 的消息
    try {
      const data = await api(`/api/session?session_id=${encodeURIComponent(targetSessionId)}`);
      if (typeof GROUP_CHAT_STATE !== 'undefined' && GROUP_CHAT_STATE.isOpen) return;
      if (data.session) {
        S.session = data.session;
        S.messages = data.session.messages || [];
        // 同步模型/token 信息
        if (data.session.model && data.session.model !== emp.model) {
          emp.model = data.session.model;
          if (typeof _saveEmployees === 'function') _saveEmployees();
          if (typeof _updateCardTokenUsage === 'function') _updateCardTokenUsage(emp);
        }
        const effectiveModel = emp.model || data.session.model;
        if (effectiveModel && typeof _applyModelToDropdown === 'function') {
          _applyModelToDropdown(effectiveModel, $('modelSelect'));
        }
        if (data.session.input_tokens || data.session.output_tokens) {
          emp.tokenUsage = {
            input_tokens: data.session.input_tokens || 0,
            output_tokens: data.session.output_tokens || 0,
          };
          if (typeof _saveEmployees === 'function') _saveEmployees();
          if (typeof _updateCardTokenUsage === 'function') _updateCardTokenUsage(emp);
        }
      }
    } catch(e) {
      // 主 session 加载失败，创建新的
      emp.sessionId = null;
      _saveEmployees();
      openEmployeeChat(empId);
      return;
    }

    // ★ 异步加载该员工所有委派任务的 session 消息，追加到 S.messages
    await _loadAllDelegatedTaskMessages(emp);

    // 切换员工/打开聊天：重置渲染窗口到"最近一页"，避免一次性渲染全部历史造成卡顿
    _resetRenderWindow('employee', S.session?.session_id || emp.id);
    _renderRpMessages();
    // 切换员工/打开聊天：强制滚到底（看到最新消息），并重置粘底标记
    _scrollMsgAreaToBottom();

    // ★ 通知正在运行的 SSE 流：session 已切换，若此流所属 session 被切回需补渲
    try{
      if(S.session && S.session.session_id){
        window.dispatchEvent(new CustomEvent('hermes:session-switched',{detail:{session_id:S.session.session_id}}));
      }
    }catch(_){}

    // ★ 刷新后流恢复：对于仍在 running/pending 的委派任务，启动后台轮询
    //   定期拉取最新 session 消息，直到任务结束。这样即使 streamId 已断，
    //   用户也能看到模型正在生成的内容。
    try{ _startDelegatedRunningTaskPolling(emp); }catch(e){ console.warn('[restart-poll] error', e); }
  }

  // 更新委派关系信息条
  _updateDelegationBar(emp);

  // ── 如果员工正在执行总群委派的任务，显示委派消息 + 接入 SSE 流 ──
  // ★ 方案 A：从 DelegationVM 读取该员工最新的 active 任务
  const activeTask = (typeof DelegationVM !== 'undefined' && emp._activeTaskId)
    ? DelegationVM.getTask(emp._activeTaskId)
    : null;

  if (activeTask && (activeTask.status === 'pending' || activeTask.status === 'running')) {
    // ★ 先添加任务分隔标记（如果还没有）
    const taskPrefix = `[总群委派任务 #${activeTask.id}]`;
    const hasDivider = S.messages.some(m =>
      m._taskDivider && m._taskId === activeTask.id
    );
    if (!hasDivider) {
      const activeLabelRaw = activeTask.taskContent
        ? activeTask.taskContent.replace(/^\[总群委派任务 #[^\]]+\]\s*/, '').split('\n').find(l => l.trim() && !l.startsWith('---') && !l.startsWith('⚠️')) || ''
        : '';
      const activeLabelShort = activeLabelRaw.length > 60 ? activeLabelRaw.slice(0, 60) + '…' : activeLabelRaw;
      S.messages.push({
        role: 'system',
        content: `📋 委派任务 #${activeTask.id}`,
        _taskDivider: true,
        _taskId: activeTask.id,
        _taskStatus: 'running',
        _taskLabel: activeLabelShort,
        _ts: activeTask.createdAt / 1000,
      });
    }
    // 如果 session 消息中没有这条委派消息（后端可能还没持久化），前端侧手动追加
    const hasTaskMsg = S.messages.some(m =>
      m.role === 'user' && String(m.content || '').includes(taskPrefix)
    );
    if (!hasTaskMsg && activeTask.taskContent) {
      const taskMsg = { role: 'user', content: activeTask.taskContent, _ts: Date.now() / 1000, _taskId: activeTask.id };
      S.messages.push(taskMsg);
    }
    _renderRpMessages();
    // 有真实 streamId → 直接接入；还在 pending → 显示占位并轮询
    if (activeTask.streamId) {
      _attachLiveStreamToChat(emp, activeTask);
    } else {
      _showThinkingPlaceholder(emp, activeTask);
    }
    // ★ 微信式：插入委派分隔/占位/live流后，再次强制滚到底
    _scrollMsgAreaToBottom();
  }

  // 更新 topbar — 显示工作区信息
  const ws = _activeWorkspacePath();
  const wsName = ws ? (typeof getWorkspaceFriendlyName === 'function' ? getWorkspaceFriendlyName(ws) : ws.split(/[\/\\]/).filter(Boolean).pop()) : '';
  const topTitle = $('topbarTitle');
  if (topTitle) topTitle.textContent = wsName || 'Hermes Studio';
  const topMeta = $('topbarMeta');
  if (topMeta) topMeta.textContent = ws ? ws : '员工工作台 — 点击员工卡片开始对话';
  // 同步工作区选择器标签
  if (typeof syncWsSelectorLabel === 'function') syncWsSelectorLabel();
  // 如果 session workspace 与画布工作区不一致，刷新文件目录以显示正确的工作区内容
  if (S.session && S.session.workspace !== ws && ws && typeof loadDir === 'function') {
    loadDir('.');
  }
}

/**
 * 异步加载该员工所有委派任务（已完成/出错）的 session 消息，
 * 合并到 S.messages 中，并在每段任务消息前插入任务分隔标记。
 * 正在执行的任务（pending/running）不在此处加载——它们由 _attachLiveStreamToChat 实时渲染。
 *
 * 合并策略：
 *   1. 主 session 消息已在 S.messages 中
 *   2. 每个已完成任务的消息作为独立段落追加，前缀一个 _taskDivider 标记消息
 *   3. 按任务创建时间排序（先完成的排在前面）
 */
/** 从 localStorage 读取委派任务持久化映射 */
function _loadDelegationPersistMap() {
  try {
    const raw = localStorage.getItem('hermes-delegation-tasks');
    return raw ? JSON.parse(raw) : {};
  } catch (_) {
    return {};
  }
}

async function _loadAllDelegatedTaskMessages(emp) {
  if (!emp || typeof DelegationVM === 'undefined') return;

  // ★ 收集该员工所有有效委派任务：done/error（已完成）+ running/pending（进行中）
  //    进行中的任务也需要加载已输出的消息，避免页面刷新后只看到"委派任务已完成"
  //    却看不到模型已生成的回复
  const loadableTasks = [];
  const seenIds = new Set();
  const _isLoadableStatus = (s) => s === 'done' || s === 'error' || s === 'running' || s === 'pending';
  // 1. 从内存 Map 中收集
  for (const task of DelegationVM.tasks.values()) {
    if (task.empId === emp.id && task.sessionId
        && _isLoadableStatus(task.status)
        && task.sessionId !== emp.sessionId) {
      loadableTasks.push(task);
      seenIds.add(task.id);
    }
  }
  // 2. ★ 从 localStorage 持久化映射中补充（页面刷新后内存 Map 可能为空）
  if (DelegationVM.getPersistedTask) {
    const persistMap = _loadDelegationPersistMap();
    for (const [tid, meta] of Object.entries(persistMap)) {
      if (seenIds.has(tid)) continue;
      if (meta.empId === emp.id && meta.sessionId
          && _isLoadableStatus(meta.status)
          && meta.sessionId !== emp.sessionId) {
        // 构造轻量 task 对象（仅含必要字段）
        loadableTasks.push({
          id: tid,
          empId: meta.empId,
          empName: meta.empName || '',
          sessionId: meta.sessionId,
          taskContent: '',
          status: meta.status,
          createdAt: 0,  // 无精确时间
        });
        seenIds.add(tid);
      }
    }
  }

  if (!loadableTasks.length) return;

  // 按创建时间排序（先完成的排在前面）
  loadableTasks.sort((a, b) => a.createdAt - b.createdAt);

  // 异步加载每个任务的 session 消息
  for (const task of loadableTasks) {
    try {
      const data = await api(`/api/session?session_id=${encodeURIComponent(task.sessionId)}`);
      if (!data.session || !data.session.messages) continue;

      const taskMsgs = data.session.messages;
      // 检查是否已有该任务的消息（避免重复）
      const taskPrefix = `[总群委派任务 #${task.id}]`;
      const alreadyHas = S.messages.some(m =>
        m.role === 'user' && String(m.content || '').includes(taskPrefix)
      );
      if (alreadyHas) continue;

      // ★ 插入任务分隔标记消息
      const taskLabelRaw = task.taskContent
        ? task.taskContent.replace(/^\[总群委派任务 #[^\]]+\]\s*/, '').split('\n').find(l => l.trim() && !l.startsWith('---') && !l.startsWith('⚠️')) || ''
        : '';
      const taskLabelShort = taskLabelRaw.length > 60 ? taskLabelRaw.slice(0, 60) + '…' : taskLabelRaw;
      S.messages.push({
        role: 'system',
        content: `📋 委派任务 #${task.id}`,
        _taskDivider: true,
        _taskId: task.id,
        _taskStatus: task.status,
        _taskLabel: taskLabelShort,
        _ts: task.createdAt / 1000,
      });

      // 追加任务 session 的消息（保留 tool 消息用于配对）
      for (const m of taskMsgs) {
        // 跳过 system 消息（避免与主 session 的 system 消息混淆）
        if (m.role === 'system') continue;
        // 防御重复：仅当 S.messages 中已存在"同 _taskId 且内容完全相同"的消息才跳过
        // 之前的实现会跨 taskId 检查，导致用户在多个不同委派任务中发了相同问题时，后面的任务消息被错误吞掉
        const _mc = String(m.content || '').trim();
        const _mr = String(m.reasoning || '').trim();
        const _exists = S.messages.some(sm =>
          sm._taskId === task.id &&
          sm.role === m.role &&
          String(sm.content || '').trim() === _mc &&
          String(sm.reasoning || '').trim() === _mr
        );
        if (_exists) continue;
        // 为消息打上 _taskId 标记，便于渲染时关联
        S.messages.push({ ...m, _taskId: task.id });
      }
    } catch (e) {
      console.warn('[openEmployeeChat] 加载委派任务 session 失败:', task.id, e);
    }
  }
}

// ── 刷新后委派任务自愈轮询 ─────────────────────────────────────────────────
// 页面刷新后，原本正在跑的委派任务 streamId 已丢失，无法重连 SSE。
// 本函数对 localStorage 中 status=running/pending 的委派任务启动后台轮询：
// 每 2s 拉取 session 最新消息，若内容有更新则合并到 S.messages 并重渲染；
// 直到后端 session 中出现最终 assistant 回复 / 任务状态被别处更新为终态 / 轮询超时。
const _restartPollingTimers = new Map();  // empId -> timer map (taskId -> intervalId)

function _stopDelegatedRunningTaskPolling(empId) {
  const timers = _restartPollingTimers.get(empId);
  if (!timers) return;
  for (const [, iv] of timers) { try{ clearInterval(iv); }catch(_){} }
  _restartPollingTimers.delete(empId);
}

function _startDelegatedRunningTaskPolling(emp) {
  if (!emp || typeof DelegationVM === 'undefined') return;
  // 先停掉该员工之前的轮询
  _stopDelegatedRunningTaskPolling(emp.id);

  // 收集 running/pending 任务
  const runningTasks = [];
  const seen = new Set();
  for (const task of DelegationVM.tasks.values()) {
    if (task.empId === emp.id && task.sessionId
        && (task.status === 'running' || task.status === 'pending')
        && task.sessionId !== emp.sessionId) {
      runningTasks.push({id: task.id, sessionId: task.sessionId, status: task.status});
      seen.add(task.id);
    }
  }
  if (typeof _loadDelegationPersistMap === 'function') {
    const persistMap = _loadDelegationPersistMap();
    for (const [tid, meta] of Object.entries(persistMap)) {
      if (seen.has(tid)) continue;
      if (meta.empId === emp.id && meta.sessionId
          && (meta.status === 'running' || meta.status === 'pending')
          && meta.sessionId !== emp.sessionId) {
        runningTasks.push({id: tid, sessionId: meta.sessionId, status: meta.status});
        seen.add(tid);
      }
    }
  }
  if (!runningTasks.length) return;

  console.log('[restart-poll] 启动委派任务自愈轮询:', emp.name, runningTasks.map(t=>t.id));

  const timers = new Map();
  _restartPollingTimers.set(emp.id, timers);

  const POLL_INTERVAL = 2000;
  const MAX_POLLS = 300;  // 10 分钟上限

  for (const rt of runningTasks) {
    let lastMsgCount = 0;
    let polls = 0;
    const taskPrefix = `[总群委派任务 #${rt.id}]`;

    const iv = setInterval(async () => {
      polls++;
      if (polls > MAX_POLLS) {
        clearInterval(iv);
        timers.delete(rt.id);
        return;
      }
      // 用户切走员工聊天框 → 停止轮询
      if (typeof EMPLOYEE_STORE === 'undefined' || EMPLOYEE_STORE.selectedId !== emp.id) {
        clearInterval(iv);
        timers.delete(rt.id);
        return;
      }
      try {
        const data = await api(`/api/session?session_id=${encodeURIComponent(rt.sessionId)}`);
        if (!data.session || !data.session.messages) return;
        const msgs = data.session.messages;

        // 如果消息数没变化，继续轮询
        if (msgs.length === lastMsgCount) return;
        lastMsgCount = msgs.length;

        // 检测任务是否已完成：最后一条 assistant 消息非空 + 没有 tool_calls
        const lastMsg = msgs[msgs.length - 1];
        const looksComplete = lastMsg && lastMsg.role === 'assistant'
          && String(lastMsg.content || '').trim().length > 0
          && !(lastMsg.tool_calls && lastMsg.tool_calls.length);

        // 合并新消息到 S.messages（按任务分组，避免重复）
        let added = 0;
        for (const m of msgs) {
          if (m.role === 'system') continue;
          const _mc = String(m.content || '').trim();
          const _mr = String(m.reasoning || '').trim();
          const _exists = S.messages.some(sm =>
            sm._taskId === rt.id
            && sm.role === m.role
            && String(sm.content || '').trim() === _mc
            && String(sm.reasoning || '').trim() === _mr
          );
          if (_exists) continue;
          S.messages.push({ ...m, _taskId: rt.id });
          added++;
        }

        if (added > 0) {
          console.log('[restart-poll] 补充', added, '条消息 task=', rt.id);
          if (typeof _renderRpMessages === 'function') _renderRpMessages();
        }

        // 任务完成 → 更新持久化状态 + 停止轮询
        if (looksComplete) {
          clearInterval(iv);
          timers.delete(rt.id);
          try {
            if (DelegationVM._persistTask && DelegationVM.getTask) {
              const t = DelegationVM._restorePersistedTask ? DelegationVM._restorePersistedTask(rt.id) : DelegationVM.getTask(rt.id);
              if (t) {
                t.status = 'done';
                DelegationVM._persistTask(t);
              }
            }
            // 更新已渲染的 divider 状态（running → done）
            const divider = S.messages.find(sm => sm._taskDivider && sm._taskId === rt.id);
            if (divider) {
              divider._taskStatus = 'done';
              if (typeof _renderRpMessages === 'function') _renderRpMessages();
            }
          } catch(_) {}
        }
      } catch (e) {
        console.warn('[restart-poll] session 拉取失败:', rt.id, e);
      }
    }, POLL_INTERVAL);
    timers.set(rt.id, iv);
  }
}

/**
 * 当 streamId 还在等待 /api/chat/start 返回时（pending 状态），
 * 显示一个"思考中..."占位行，并启动轮询检测 task.streamId 更新。
 */
function _showThinkingPlaceholder(emp, task) {
  const inner = $('rpMsgInner');
  if (!inner) return;

  // 避免重复添加
  if ($('rpLiveTurnRow')) return;

  const turnRow = document.createElement('div');
  turnRow.className = 'rp-msg-row rp-turn';
  turnRow.id = 'rpLiveTurnRow';
  turnRow.dataset.role = 'assistant';
  turnRow.innerHTML = `
    <div class="rp-msg-role assistant">
      <span class="rp-msg-icon">${emp.avatar || '🤖'}</span>
      <span class="rp-msg-name">${esc(emp.name || 'Hermes')}</span>${_fmtMsgTime({_ts: Date.now() / 1000})}
    </div>
    <div class="rp-turn-segments" id="rpLiveTurnSegments">
      <div class="rp-msg-body rp-turn-text" id="rpLiveStreamBody">
        <span style="color:var(--muted);font-size:13px">Thinking…</span>
      </div>
    </div>
  `;
  inner.appendChild(turnRow);

  // 粘底滚动（用户滚到底时才跟随）
  _scrollMsgAreaIfSticky();

  if (!task) return;

  // 轮询检测 task.streamId 更新（/api/chat/start 返回后 task.streamId 会被设为真实值）
  let _pollCount = 0;
  const _pollTimer = setInterval(() => {
    _pollCount++;
    if (_pollCount > 60) {  // 最多轮询 30 秒
      clearInterval(_pollTimer);
      return;
    }
    // 任务已取消或结束：停止轮询
    if (task.status === 'cancelled' || task.status === 'done' || task.status === 'error') {
      clearInterval(_pollTimer);
      return;
    }
    if (task.streamId) {
      clearInterval(_pollTimer);
      _attachLiveStreamToChat(emp, task);
    }
  }, 500);
}

/**
 * 当用户从总群跳转到正在执行任务的员工聊天框时，
 * 接入已有的 SSE 流实时渲染 token 输出。
 * 方案 A：基于 task 对象，状态隔离
 */
function _attachLiveStreamToChat(emp, task) {
  if (!task || !task.streamId) return;
  const streamId = task.streamId;
  const capturedTaskId = task.id;

  // ★ 总群打开时不追加流式消息（防止覆盖总群内容）
  if (typeof GROUP_CHAT_STATE !== 'undefined' && GROUP_CHAT_STATE.isOpen) return;

  const inner = $('rpMsgInner');
  if (!inner) return;

  // ★ 用 task 已积累文本作为初始内容（从 _watchEmployeeStream 的 token 事件中保存）
  const initialText = task.accumulatedText || '';

  // ★ 新设计：一次 assistant 回合 = 一个 turn-row，内部依次放置
  //   [思考段/文本段/工具卡片段]，而不是每段另起一行。
  //   这里复用或创建 turn-row（id=rpLiveTurnRow），并在其内维护一个 segments 容器。
  let turnRow = $('rpLiveTurnRow');
  let segments; // .rp-turn-segments 容器
  if (!turnRow) {
    turnRow = document.createElement('div');
    turnRow.className = 'rp-msg-row rp-turn';
    turnRow.id = 'rpLiveTurnRow';
    turnRow.dataset.role = 'assistant';
    turnRow.innerHTML = `
      <div class="rp-msg-role assistant">
        <span class="rp-msg-icon">${emp.avatar || '🤖'}</span>
        <span class="rp-msg-name">${esc(emp.name || 'Hermes')}</span>${_fmtMsgTime({_ts: Date.now() / 1000})}
      </div>
      <div class="rp-turn-segments" id="rpLiveTurnSegments"></div>
    `;
    inner.appendChild(turnRow);
  }
  segments = $('rpLiveTurnSegments');

  // 确保当前存在一个"活动文本段"（用于接收 token / 显示 Thinking 占位）
  function _ensureActiveBody() {
    let b = segments.querySelector('#rpLiveStreamBody');
    if (!b) {
      b = document.createElement('div');
      b.className = 'rp-msg-body rp-turn-text';
      b.id = 'rpLiveStreamBody';
      b.innerHTML = '<span style="color:var(--muted);font-size:13px">Thinking…</span>';
      segments.appendChild(b);
    }
    return b;
  }
  _ensureActiveBody();

  // 如果有已积累的文本，先显示
  if (initialText) {
    const displayText = typeof _stripThinkingTags === 'function'
      ? _stripThinkingTags(initialText)
      : initialText;
    if (displayText) {
      const b = _ensureActiveBody();
      b.innerHTML = renderMd(displayText);
    }
  }

  // 粘底滚动
  _scrollMsgAreaIfSticky();

  // 连接 SSE 流
  const source = new EventSource(
    new URL(`/api/chat/stream?stream_id=${encodeURIComponent(streamId)}`, location.origin).href,
    { withCredentials: true }
  );
  // ★ 包装 addEventListener：任何具名事件到达都先标记 _receivedAnyEvent=true，
  //   再清超时、再交给原 handler。
  //   解决："source.onmessage 永远不会被调到（所有事件都有 event:xxx）"导致必定 5s 超时的问题。
  const _origAdd = source.addEventListener.bind(source);
  source.addEventListener = function(type, handler, opts){
    return _origAdd(type, function(e){
      try{ _receivedAnyEvent = true; clearTimeout(_streamTimeout); }catch(_){}
      return handler(e);
    }, opts);
  };

  let assistantText = initialText;  // ★ 以已积累文本为起始

  // ★ 超时保护：如果 5 秒内没收到任何事件，可能是 done 被旧 SSE 消费。
  //   此时轮询后端检查流是否真的结束了。
  let _receivedAnyEvent = false;
  let _streamEnded = false;  // 标记流是否已结束
  const _streamTimeout = setTimeout(() => {
    if (_receivedAnyEvent) return;
    console.log('[总群跳转] SSE 超时无事件，开始轮询后端检查流状态, emp=', emp.name);
    // 不直接关闭 SSE，而是轮询后端检查流是否结束
    _pollStreamCompletion(emp, streamId, async () => {
      // 流已结束的回调
      _streamEnded = true;
      source.close();
      // ★ 仅当任务仍在进行中时才更新状态
      if (task.status === 'pending' || task.status === 'running') {
        task.status = 'done';
        if (typeof DelegationVM !== 'undefined' && DelegationVM._persistTask) DelegationVM._persistTask(task);
        if (emp._activeTaskId === task.id) {
          emp._activeTaskId = null;
          if (typeof setEmployeeStatus === 'function') setEmployeeStatus(emp.id, 'idle');
        }
      }

      // ★ 不替换 S.session / S.messages —— 同 done 事件处理逻辑
      // 把活动文本段替换为最终回复
      const liveRow = $('rpLiveTurnRow');
      const liveBody = $('rpLiveStreamBody');
      const seg = $('rpLiveTurnSegments');

      // 固化思考段（去掉 live 标记，折叠）
      if (seg) {
        const thinkCard = seg.querySelector('.rp-live-thinking-card');
        if (thinkCard) thinkCard.classList.remove('open', 'rp-live-thinking-card');
      }

      if (liveBody) {
        const displayText = typeof _stripThinkingTags === 'function'
          ? _stripThinkingTags(assistantText.trim())
          : assistantText.trim();
        if (displayText) {
          liveBody.innerHTML = renderMd(displayText);
          liveBody.removeAttribute('id');
        } else {
          // 如果剥离 thinking 后为空，但原始文本有内容（全是 thinking），则显示 thinking
          const hasThinking = /<think>[\s\S]*?<\/think>/.test(assistantText);
          if (hasThinking) {
            let thinkContent = '';
            const thinkMatch = assistantText.match(/<think>([\s\S]*?)<\/think>/);
            if (thinkMatch) thinkContent = thinkMatch[1].trim();
            liveBody.innerHTML = thinkContent ? renderMd(thinkContent) : '<span style="color:var(--muted)">（无回复）</span>';
            liveBody.removeAttribute('id');
          } else {
            // 没有文本：移除占位 body；如果整个 turn 为空才提示"无回复"
            liveBody.remove();
            if (seg && !seg.children.length) {
              const ph = document.createElement('div');
              ph.className = 'rp-msg-body rp-turn-text';
              ph.innerHTML = '<span style="color:var(--muted)">（无回复）</span>';
              seg.appendChild(ph);
            }
          }
        }
      }
      if (liveRow) {
        liveRow.removeAttribute('id');  // 移除临时 ID
        const innerSegs = liveRow.querySelector('#rpLiveTurnSegments');
        if (innerSegs) innerSegs.removeAttribute('id');
      }

      // 回传结果到总群（传入闭包捕获的 taskId 避免丢失）
      _handleStreamEnd(emp, assistantText, capturedTaskId, task);
      // ★ 推进 DelegationVM 队列（超时轮询路径）
      if (typeof DelegationVM !== 'undefined' && capturedTaskId) {
        try { DelegationVM.completeJob(emp.id, capturedTaskId, 'done'); } catch(_) {}
      }
    });
  }, 5000);

  // Thinking tag patterns for streaming display
  const _thinkPairs = [
    { open: '<think>', close: '</think>' },
    { open: '<|channel>thought\n', close: '<channel|>' }
  ];

  // ★ 从 _rpReasoningBuffer + assistantText 中提取思考内容与显示文本
  //   reasoning 事件的文本优先作为 thinking，再从 assistantText 中剥离任何内联 <think> 块
  function _extractThinkingAndText() {
    // 先从 assistantText 提取/剥离内联 think 块
    const res = extractThinkingAndText(assistantText);
    // 把独立 reasoning buffer 的内容合并到 thinking（优先级最高）
    const merged = [];
    if (_rpReasoningBuffer && _rpReasoningBuffer.trim()) merged.push(_rpReasoningBuffer.trim());
    if (res.thinking && res.thinking.trim()) merged.push(res.thinking.trim());
    return { thinking: merged.join('\n'), text: res.text };
  }

  let _renderPending = false;
  let _lastRenderTime = 0;
  function _scheduleRender() {
    if (_renderPending) return;
    const now = Date.now();
    const elapsed = now - _lastRenderTime;
    const MIN_INTERVAL = 80;
    const delay = Math.max(0, MIN_INTERVAL - elapsed);
    _renderPending = true;
    setTimeout(() => {
      _renderPending = false;
      _lastRenderTime = Date.now();
      if (!segments) segments = $('rpLiveTurnSegments');
      if (!segments) return;

      const { thinking, text } = _extractThinkingAndText();

      // 思考段：查找或创建 .rp-live-thinking-card
      let thinkCard = segments.querySelector('.rp-live-thinking-card');
      if (thinking) {
        if (!thinkCard) {
          thinkCard = document.createElement('div');
          thinkCard.className = 'rp-turn-thinking thinking-card rp-live-thinking-card open';
          thinkCard.innerHTML = `<div class="thinking-card-header" onclick="this.parentElement.classList.toggle('open')"><span class="thinking-card-icon">${typeof li === 'function' ? li('lightbulb', 14) : '💡'}</span><span class="thinking-card-label">思考过程</span><span class="thinking-card-toggle">${typeof li === 'function' ? li('chevron-right', 12) : '▶'}</span></div><div class="thinking-card-body"></div>`;
          const firstChild = segments.firstChild;
          if (firstChild) segments.insertBefore(thinkCard, firstChild);
          else segments.appendChild(thinkCard);
        }
        const body = thinkCard.querySelector('.thinking-card-body');
        if (body) body.innerHTML = renderMd(thinking);
      } else if (thinkCard && text) {
        // 思考已结束且文本出现了 → 折叠思考卡片
        thinkCard.classList.remove('open', 'rp-live-thinking-card');
      }

      // 文本段
      let currentBody = segments.querySelector('#rpLiveStreamBody');
      if (text) {
        if (currentBody) currentBody.innerHTML = renderMd(text);
      } else if (!text && assistantText.length > 0 && !thinking) {
        if (currentBody) currentBody.innerHTML = '<span style="color:var(--muted);font-size:13px">Thinking…</span>';
      } else if (!text && thinking) {
        // 还在思考中 → 如果活动文本段只显示占位符则清空
        if (currentBody && !currentBody.textContent.trim()) {
          currentBody.innerHTML = '';
        }
      }

      _scrollMsgAreaIfSticky();
    }, delay);
  }


  source.addEventListener('token', e => {
    try {
      const d = JSON.parse(e.data);
      assistantText += d.text;
      // 同步回任务对象，保持全局单一事实源
      task.accumulatedText = assistantText;
      _scheduleRender();
    } catch (_) {}
  });

  // ★ 原生 reasoning 内容（Claude 3.7, DeepSeek 等）实时显示
  //   使用独立缓冲区，绝不污染 assistantText —— 防止 token/reasoning 事件交错时
  //   回复内容被意外吞进 <think> 块、或 stream 错误路径残留孤立 </think>。
  let _rpReasoningBuffer = '';
  source.addEventListener('reasoning', e => {
    try {
      const d = JSON.parse(e.data);
      const text = d.text || '';
      if (!text) return;
      _rpReasoningBuffer += text;
      // 同步 task.accumulatedText 时把 reasoning 与 text 组合为包装块
      //   方便刷新后通过持久化数据恢复（保持向后兼容）
      task.accumulatedText = (_rpReasoningBuffer ? '<think>' + _rpReasoningBuffer + '</think>' : '') + assistantText;
      _scheduleRender();
    } catch (_) {}
  });

  // ★ 实时显示工具调用（新布局：同一 turn-row 内多段连续）：
  //   1. 固化当前活动文本段（脱掉 id，保留内容作为一段）
  //   2. 在 segments 容器内追加工具卡片
  //   3. 新建下一个活动文本段（id=rpLiveStreamBody），用于接收工具之后的下一段文本
  // ★ 同时检测 delegate_task / send_group_message 事件，同步到总群
  //   （当 _watchEmployeeStream 被 _tryAttachLiveStreamToRpPanel 替代时，这些事件需要在此处理）
  source.addEventListener('tool', e => {
    try {
      const d = JSON.parse(e.data);

      // ★ 检测 delegate_task 和 send_group_message 事件，同步到总群
      if (d.name === 'delegate_task') {
        const targetName = (d.args && d.args.employee_name) || '';
        if (targetName && task.workspace) {
          task.delegatedTo = targetName;
          api('/api/group-chat/send', {
            method: 'POST',
            body: JSON.stringify({
              workspace: task.workspace,
              message: `**${task.empName}** 正在将任务委派给 **${targetName}**...`,
              sender_name: task.empName,
            }),
          }).catch(() => {});
        }
      } else if (d.name === 'send_group_message') {
        // ★ 员工通过 send_group_message 向总群发消息，若包含 @mentions 则自动委派任务
        const msgText = (d.args && d.args.message) || '';
        const mentionedNames = (msgText && typeof parse_mentions_local === 'function')
          ? parse_mentions_local(msgText) : [];
        if (mentionedNames.length > 0 && task.workspace) {
          console.log('[总群面板SSE] send_group_message 包含 @mentions:', mentionedNames, '自动委派任务');
          for (let mi = 0; mi < mentionedNames.length; mi++) {
            const name = mentionedNames[mi];
            const newTaskId = `task-${Date.now().toString(36)}-${mi}-${Math.random().toString(36).slice(2, 6)}`;
            if (typeof _dispatchTaskToEmployee === 'function') {
              _dispatchTaskToEmployee(name, msgText, newTaskId, { orchestrate: false });
            }
          }
        }
        if (task.workspace) {
          if (typeof loadGroupChat === 'function') {
            loadGroupChat(task.workspace).then(() => {
              if (typeof GROUP_CHAT_STATE !== 'undefined' && GROUP_CHAT_STATE.isOpen && typeof _renderGroupMessages === 'function') _renderGroupMessages();
            }).catch(() => {});
          }
        }
      }

      const tc = {
        name: d.name,
        preview: d.preview || '',
        args: d.args || {},
        snippet: '',
        done: true,
      };
      if (typeof buildToolCard !== 'function') return;
      if (!segments) segments = $('rpLiveTurnSegments');
      if (!segments) return;

      // 步骤 0：固化思考段（去掉 live 标记，折叠）
      const thinkCard = segments.querySelector('.rp-live-thinking-card');
      if (thinkCard) {
        thinkCard.classList.remove('open', 'rp-live-thinking-card');
      }

      // 步骤 1：固化当前文本段
      const currentBody = segments.querySelector('#rpLiveStreamBody');
      if (currentBody) {
        const finalText = typeof _stripThinkingTags === 'function'
          ? _stripThinkingTags(assistantText)
          : assistantText;
        if (finalText && finalText.trim()) {
          currentBody.innerHTML = renderMd(finalText);
          currentBody.removeAttribute('id');  // 固化为历史段
        } else {
          // 空段（只有 thinking 占位）：直接移除
          currentBody.remove();
        }
      }

      // 步骤 2：在 segments 内追加工具卡片
      const cardRow = buildToolCard(tc);
      cardRow.classList.add('rp-turn-tool', 'rp-live-tool-card');
      segments.appendChild(cardRow);

      // 步骤 3：新建下一个活动文本段
      assistantText = '';
      _rpReasoningBuffer = '';  // ★ 清空 reasoning 缓冲，防止跨工具轮次残留 think 内容
      const newBody = document.createElement('div');
      newBody.className = 'rp-msg-body rp-turn-text';
      newBody.id = 'rpLiveStreamBody';
      newBody.innerHTML = '<span style="color:var(--muted);font-size:13px">Thinking…</span>';
      segments.appendChild(newBody);

      // 粘底滚动
      _scrollMsgAreaIfSticky();
    } catch(_) {}
  });

  source.addEventListener('done', async e => {
    _streamEnded = true;
    source.close();
    // ★ reasoning 与 token 已分离（_rpReasoningBuffer），无需再向 assistantText 追加 </think>
    clearTimeout(_streamTimeout);
    // ★ 基于 task 状态判断（而非 emp 共享字段）
    if (task.status === 'pending' || task.status === 'running') {
      task.status = 'done';
      if (typeof DelegationVM !== 'undefined' && DelegationVM._persistTask) DelegationVM._persistTask(task);
      if (emp._activeTaskId === task.id) {
        emp._activeTaskId = null;
        if (typeof setEmployeeStatus === 'function') setEmployeeStatus(emp.id, 'idle');
      }
    }

    // ★ 不替换 S.session / S.messages —— 委派任务用的是独立 session，
    //   替换会导致聊天框被清空（因为委派 session 只有那一轮对话）
    //   直接更新活动文本段为最终回复即可

    // 把活动文本段替换为最终回复
    const liveRow = $('rpLiveTurnRow');
    const liveBody = $('rpLiveStreamBody');
    const seg = $('rpLiveTurnSegments');

    // 固化思考段（去掉 live 标记，折叠）
    if (seg) {
      const thinkCard = seg.querySelector('.rp-live-thinking-card');
      if (thinkCard) thinkCard.classList.remove('open', 'rp-live-thinking-card');
    }

    if (liveBody) {
      const displayText = typeof _stripThinkingTags === 'function'
        ? _stripThinkingTags(assistantText.trim())
        : assistantText.trim();
      if (displayText) {
        liveBody.innerHTML = renderMd(displayText);
        liveBody.removeAttribute('id');
      } else {
        // 如果剥离 thinking 后为空，但原始文本有内容（全是 thinking），则显示 thinking
        const hasThinking = /<think>[\s\S]*?<\/think>/.test(assistantText);
        if (hasThinking) {
          // 提取 thinking 内容作为显示文本
          let thinkContent = '';
          const thinkMatch = assistantText.match(/<think>([\s\S]*?)<\/think>/);
          if (thinkMatch) thinkContent = thinkMatch[1].trim();
          liveBody.innerHTML = thinkContent ? renderMd(thinkContent) : '<span style="color:var(--muted)">（无回复）</span>';
          liveBody.removeAttribute('id');
        } else {
          liveBody.remove();
          if (seg && !seg.children.length) {
            const ph = document.createElement('div');
            ph.className = 'rp-msg-body rp-turn-text';
            ph.innerHTML = '<span style="color:var(--muted)">（无回复）</span>';
            seg.appendChild(ph);
          }
        }
      }
    }
    if (liveRow) {
      liveRow.removeAttribute('id');  // 移除临时 ID，避免后续冲突
      const seg = liveRow.querySelector('#rpLiveTurnSegments');
      if (seg) seg.removeAttribute('id');
    }

    // ★ 回传结果到总群
    _handleStreamEnd(emp, assistantText, capturedTaskId, task);

    // ★ 刷新总群消息（替代 _watchEmployeeStream 的职责）
    if (task.workspace) {
      try {
        await loadGroupChat(task.workspace);
        if (typeof GROUP_CHAT_STATE !== 'undefined' && GROUP_CHAT_STATE.isOpen) _renderGroupMessages();
      } catch(_) {}
    }

    // ★ 推进 DelegationVM 队列（当从总群跳转过来时，_watchEmployeeStream 的 SSE
    //   已被 selectEmployee 关闭，_attachLiveStreamToChat 成为唯一消费者，
    //   所以这里需要替代 _watchEmployeeStream 的 completeJob 职责）
    if (typeof DelegationVM !== 'undefined' && capturedTaskId) {
      try { DelegationVM.completeJob(emp.id, capturedTaskId, 'done'); } catch(_) {}
    }
  });

  source.addEventListener('error', () => {
    if (_streamEnded) return;
    _streamEnded = true;
    source.close();
    // ★ 基于 task 状态
    if (task.status === 'pending' || task.status === 'running') {
      task.status = 'error';
      if (typeof DelegationVM !== 'undefined' && DelegationVM._persistTask) DelegationVM._persistTask(task);
      if (emp._activeTaskId === task.id) {
        emp._activeTaskId = null;
      }
    }
    // 把活动文本段标记为出错（保留已积累的文本）
    const liveRow = $('rpLiveTurnRow');
    const liveBody = $('rpLiveStreamBody');
    if (liveBody) {
      const displayText = typeof _stripThinkingTags === 'function'
        ? _stripThinkingTags(assistantText.trim())
        : assistantText.trim();
      liveBody.innerHTML = displayText
        ? renderMd(displayText) + '<div style="color:#ef4444;font-size:12px;margin-top:4px">⚠ 流中断</div>'
        : '<span style="color:#ef4444">⚠ 连接中断</span>';
      liveBody.removeAttribute('id');
    }
    if (liveRow) {
      liveRow.removeAttribute('id');
      const seg = liveRow.querySelector('#rpLiveTurnSegments');
      if (seg) seg.removeAttribute('id');
    }
    // 流出错时回传已积累结果到总群
    _handleStreamEnd(emp, assistantText, capturedTaskId, task);
    // ★ 推进 DelegationVM 队列（error 路径）
    if (typeof DelegationVM !== 'undefined' && capturedTaskId) {
      try { DelegationVM.completeJob(emp.id, capturedTaskId, 'error'); } catch(_) {}
    }
  });

  source.addEventListener('apperror', () => {
    if (_streamEnded) return;
    _streamEnded = true;
    source.close();
    // ★ 基于 task 状态
    if (task.status === 'pending' || task.status === 'running') {
      task.status = 'error';
      if (typeof DelegationVM !== 'undefined' && DelegationVM._persistTask) DelegationVM._persistTask(task);
      if (emp._activeTaskId === task.id) {
        emp._activeTaskId = null;
      }
    }
    // 把活动文本段标记为出错
    const liveRow = $('rpLiveTurnRow');
    const liveBody = $('rpLiveStreamBody');
    if (liveBody) {
      liveBody.innerHTML = '<span style="color:#ef4444">❌ 执行出错</span>';
      liveBody.removeAttribute('id');
    }
    if (liveRow) {
      liveRow.removeAttribute('id');
      const seg = liveRow.querySelector('#rpLiveTurnSegments');
      if (seg) seg.removeAttribute('id');
    }
    // 流出错时回传已积累结果到总群
    _handleStreamEnd(emp, assistantText, capturedTaskId, task);
    // ★ 推进 DelegationVM 队列（apperror 路径）
    if (typeof DelegationVM !== 'undefined' && capturedTaskId) {
      try { DelegationVM.completeJob(emp.id, capturedTaskId, 'error'); } catch(_) {}
    }
  });

  // 任何 SSE 事件到达时标记收到事件（取消超时保护）
  source.onmessage = () => { _receivedAnyEvent = true; clearTimeout(_streamTimeout); };
}

/** 轮询后端检查流是否已结束（SSE done 可能被旧消费者取走） */
function _pollStreamCompletion(emp, streamId, onDone) {
  let _pollCount = 0;
  const _maxPolls = 120;  // 最多轮询 60 秒（每 500ms 一次）
  const _timer = setInterval(async () => {
    _pollCount++;
    if (_pollCount > _maxPolls) {
      clearInterval(_timer);
      // 超时，强制结束
      console.warn('[总群跳转] 轮询超时，强制结束, emp=', emp.name);
      onDone();
      return;
    }
    try {
      const data = await api(`/api/chat/stream/status?stream_id=${encodeURIComponent(streamId)}`);
      if (data && !data.active) {
        // 流已结束
        clearInterval(_timer);
        console.log('[总群跳转] 轮询检测到流已结束, emp=', emp.name);
        onDone();
      }
    } catch(_) {
      // 轮询失败，继续尝试
    }
  }, 500);
}

/** 流结束时回传结果到总群（如果是从总群跳转过来的）
 *  优先从后端 session 获取完整 assistant 回复（SSE 积累的文本可能不完整）
 *  @param {object} emp - 员工对象
 *  @param {string} assistantText - SSE 累积文本
 *  @param {string} taskId - 任务 ID
 *  @param {object} [task] - 可选的 Task 对象（优先使用 task.sessionId，避免 emp.sessionId 被新任务覆盖）
 */
async function _handleStreamEnd(emp, assistantText, taskId, task) {
  if (typeof GROUP_CHAT_STATE === 'undefined') return;
  // ★ 优先使用任务自己的 workspace
  let ws = task && task.workspace ? task.workspace : '';
  if (!ws) {
    ws = typeof _currentCanvasWorkspace !== 'undefined' ? _currentCanvasWorkspace : (S.session?.workspace || '');
    if (ws === '__default__') ws = GROUP_CHAT_STATE.workspace || S.session?.workspace || '';
  }
  if (!ws) return;

  // ★ 优先从任务的 sessionId 拉取（避免 emp.sessionId 已被新任务覆盖导致查错库）
  const sid = (task && task.sessionId) || emp.sessionId;

  // ★ 优先从后端 session 获取完整的 assistant 回复（比 SSE 积累文本更可靠）
  let displayResult = '';
  if (sid) {
    try {
      const data = await api(`/api/session?session_id=${encodeURIComponent(sid)}`);
      if (data.session && data.session.messages) {
        const msgs = data.session.messages;
        // ★ 找到包含当前 taskId 的 user message 位置，取其后的最后一条 assistant 消息
        let taskMsgIdx = -1;
        for (let i = msgs.length - 1; i >= 0; i--) {
          if (msgs[i].role === 'user' && msgs[i].content && taskId && msgs[i].content.includes(taskId)) {
            taskMsgIdx = i;
            break;
          }
        }
        if (taskMsgIdx >= 0) {
          const assistantMsgs = msgs.slice(taskMsgIdx).filter(m => m.role === 'assistant' && m.content);
          if (assistantMsgs.length > 0) {
            displayResult = assistantMsgs[assistantMsgs.length - 1].content;
          }
        } else {
          // 兜底：取最后一条 assistant 消息
          const assistantMsgs = msgs.filter(m => m.role === 'assistant' && m.content);
          if (assistantMsgs.length > 0) {
            displayResult = assistantMsgs[assistantMsgs.length - 1].content;
          }
        }
      }
    } catch(_) {}
  }

  // 回退到 SSE 积累的文本
  if (!displayResult) {
    displayResult = typeof _stripThinkingTags === 'function'
      ? _stripThinkingTags(assistantText.trim())
      : assistantText.trim();
  } else {
    displayResult = typeof _stripThinkingTags === 'function'
      ? _stripThinkingTags(displayResult.trim())
      : displayResult.trim();
  }

  if (!displayResult) return;

  // ★ 通过 DelegationVM 统一回传（内建去重守卫，sessionId 让后端聚合完整回复）
  if (typeof DelegationVM !== 'undefined') {
    await DelegationVM.postResultOnce({
      emp,
      taskId: taskId || (task && task.id) || '',
      result: displayResult,
      workspace: ws,
      sessionId: sid || '',
      requesterName: (task && task.requesterName) || '你',
    });
  } else {
    try {
      await api('/api/group-chat/result', {
        method: 'POST',
        body: JSON.stringify({
          workspace: ws,
          employee_name: emp.name,
          task_id: taskId || (task && task.id) || '',
          result: displayResult,
          requester_name: (task && task.requesterName) || '你',
        }),
      });
    } catch(_) {}
  }
}

/** 格式化消息时间，显示在人名后面 */
function _fmtMsgTime(m) {
  const ts = m._ts || m.timestamp;
  if (!ts) return '';
  const t = new Date(ts * 1000);
  const now = new Date();
  const isToday = t.toDateString() === now.toDateString();
  const timeStr = t.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  const fullStr = t.toLocaleString();
  if (isToday) return `<span class="msg-time" title="${esc(fullStr)}">${esc(timeStr)}</span>`;
  const dateStr = `${(t.getMonth() + 1).toString().padStart(2, '0')}-${t.getDate().toString().padStart(2, '0')} ${timeStr}`;
  return `<span class="msg-time" title="${esc(fullStr)}">${esc(dateStr)}</span>`;
}

function _renderRpMessages() {
  const inner = $('rpMsgInner');
  const emptyChat = $('rpEmptyChat');
  if (!inner) return;

  // ★ 总群打开时不渲染员工消息（防止覆盖总群内容）
  if (typeof GROUP_CHAT_STATE !== 'undefined' && GROUP_CHAT_STATE.isOpen) {
    console.log('[_renderRpMessages] 总群打开中，跳过员工消息渲染');
    return;
  }

  // ★ 保留带 tool_calls 的 assistant 消息作为锚点（即使 content 为空）
  //   这样工具卡片可以插入到对应 assistant 消息之后
  //   同时包含 _taskDivider 类型的 system 消息（任务分隔标记）
  const visWithIdx = [];
  const _seenKeys = new Set();
  for (let i = 0; i < S.messages.length; i++) {
    const m = S.messages[i];
    if (!m || !m.role || m.role === 'tool') continue;
    // ★ 任务分隔标记消息（_taskDivider）
    if (m._taskDivider) {
      visWithIdx.push({ m, rawIdx: i });
      continue;
    }
    const hasTc = Array.isArray(m.tool_calls) && m.tool_calls.length > 0;
    const hasTu = Array.isArray(m.content) && m.content.some(p => p && p.type === 'tool_use');
    if (msgContent(m) || m.reasoning || (m.role === 'assistant' && (hasTc || hasTu))) {
      // 防御重复消息：相同 role+content+reasoning+taskId 的消息只保留第一条
      // 清理 content 中的 think 标签后再比较，避免 "原始文本+think标签" 和 "已提取think后的文本" 被视为不同消息
      // 注意：必须带上 _taskId — 否则不同委派任务（如 @制作人 多次发相同问题）的消息会被错误去重掉
      let _cmpContent = String(msgContent(m) || '');
      _cmpContent = _cmpContent.replace(/<think>[\s\S]*?<\/think>\s*/g, '').replace(/<\/?think>/gi, '').trim();
      const _tid = m._taskId || '';
      const key = `${m.role}|${_tid}|${_cmpContent}|${String(m.reasoning || '')}`;
      if (_seenKeys.has(key)) continue;
      _seenKeys.add(key);
      visWithIdx.push({ m, rawIdx: i });
    }
  }

  if (emptyChat) emptyChat.style.display = visWithIdx.length ? 'none' : '';
  inner.innerHTML = '';

  // ── 窗口化：只渲染最近一页，更早的消息通过顶部 sentinel 点击/滚动加载 ──
  // 把当前 session_id 作为 key，key 变化时 _computeWindowStart 会自动重置窗口
  // 这样即使切换员工/会话的代码路径没调用 _resetRenderWindow，也能正确显示最新一页
  const _total = visWithIdx.length;
  const _key = (S.session && S.session.session_id) || (EMPLOYEE_STORE && EMPLOYEE_STORE.selectedId) || '';
  const _start = _computeWindowStart(_total, _key, 'employee');
  const _slice = visWithIdx.slice(_start);

  for (const { m, rawIdx } of _slice) {
    // ★ 任务分隔标记：渲染为分隔线 + 任务标题
    if (m._taskDivider) {
      const statusIcon = m._taskStatus === 'done' ? '✅' : m._taskStatus === 'error' ? '❌' : m._taskStatus === 'running' ? '⏳' : '📋';
      const statusLabel = m._taskStatus === 'done' ? '已完成' : m._taskStatus === 'error' ? '出错' : m._taskStatus === 'running' ? '执行中' : '';
      const taskLabel = m._taskLabel ? ` — ${esc(m._taskLabel)}` : '';
      const statusHtml = statusLabel ? `<span class="rp-task-divider-status" style="font-size:11px;color:var(--muted);margin-left:4px">(${esc(statusLabel)})</span>` : '';
      const dividerRow = document.createElement('div');
      dividerRow.className = 'rp-msg-row rp-task-divider';
      dividerRow.dataset.taskId = m._taskId || '';
      dividerRow.innerHTML = `
        <div class="rp-task-divider-line"></div>
        <div class="rp-task-divider-label">
          <span class="rp-task-divider-icon">${statusIcon}</span>
          <a href="#" class="gc-task-link" data-task-id="${esc(m._taskId || '')}" onclick="event.preventDefault();jumpToGroupChatTask('${esc(m._taskId || '')}');return false;" title="点击跳转到总群对应消息">${esc(m.content || '')}</a>${taskLabel}${statusHtml}
        </div>
        <div class="rp-task-divider-line"></div>
      `;
      inner.appendChild(dividerRow);
      continue;
    }

    let content = m.content || '';
    let thinkingText = '';

    // ── 提取思考过程（与 ui.js renderMessages 逻辑一致）──
    // 结构化内容中的 thinking/reasoning 块
    if (Array.isArray(content)) {
      thinkingText = content.filter(p => p && (p.type === 'thinking' || p.type === 'reasoning')).map(p => p.thinking || p.reasoning || p.text || '').join('\n');
      content = content.filter(p => p && p.type === 'text').map(p => p.text || p.content || '').join('\n');
    }
    // 顶层 reasoning 字段
    if (!thinkingText && m.reasoning) thinkingText = m.reasoning;
    // ★ 针对总群委派消息：折叠样板"执行要求"部分，只显示核心任务
    if (m.role === 'user' && typeof content === 'string' && content.startsWith('[总群委派任务')) {
      const sepIdx = content.indexOf('\n---\n');
      if (sepIdx !== -1) {
        content = content.slice(0, sepIdx).trimEnd();
      }
    }
    // 内联 <think>...</think> 标签（全局提取，防止残留）
    if (!thinkingText && typeof content === 'string') {
      const thinkRe = /<think>([\s\S]*?)<\/think>/g;
      const thinkingParts = [];
      let m;
      while ((m = thinkRe.exec(content)) !== null) {
        thinkingParts.push(m[1].trim());
      }
      if (thinkingParts.length) {
        thinkingText = thinkingParts.join('\n');
        content = content.replace(/<think>[\s\S]*?<\/think>\s*/g, '').trimStart();
      }
      if (!thinkingText) {
        const gemmaMatch = content.match(/<\|channel>thought\n([\s\S]*?)<channel\|>/);
        if (gemmaMatch) {
          thinkingText = gemmaMatch[1].trim();
          content = content.replace(/<\|channel>thought\n[\s\S]*?<channel\|>\s*/g, '').trimStart();
        }
      }
      // 清理孤立的 think 标签
      content = content.replace(/<\/?think>/gi, '').trim();
    }

    const isUser = m.role === 'user';
    const hasToolCalls = Array.isArray(m.tool_calls) && m.tool_calls.length > 0;

    // ── User 消息：独立一行 ───────────────────────────────────────────
    if (isUser) {
      if (!String(content).trim()) continue;
      let bodyHtml;
      // ★ 检测总群委派任务前缀，转为可点击链接跳转回总群
      const taskMatch = String(content).match(/^\[总群委派任务 #(task-[A-Za-z0-9_-]+)\]/);
      if (taskMatch) {
        const tid = taskMatch[1];
        const prefix = taskMatch[0];
        const rest = String(content).slice(prefix.length);
        const prefixHtml = `<a href="#" class="gc-task-link" data-task-id="${esc(tid)}" onclick="event.preventDefault();jumpToGroupChatTask('${esc(tid)}');return false;" title="点击跳转到总群对应消息">${esc(prefix)}</a>`;
        bodyHtml = prefixHtml + renderMd(rest);
      } else {
        bodyHtml = renderMd(String(content));
      }
      const row = document.createElement('div');
      row.className = 'rp-msg-row';
      row.dataset.role = 'user';
      row.dataset.msgIdx = rawIdx;
      if (taskMatch) row.dataset.taskId = taskMatch[1];
      else {
        const _tidMatch = String(content).match(/#(task-[A-Za-z0-9_-]+)/);
        if (_tidMatch) row.dataset.taskId = _tidMatch[1];
      }
      row.innerHTML = `
        <div class="rp-msg-role user">
          <span class="rp-msg-icon">👤</span>
          <span class="rp-msg-name">你</span>${_fmtMsgTime(m)}
        </div>
        <div class="rp-msg-body">${bodyHtml}</div>
      `;
      row.dataset.rawText = String(content).trim();
      inner.appendChild(row);
      continue;
    }

    // ── Assistant 回合：连续的 assistant 消息合并到同一个 turn-row ──
    //   一次任务的完整回答可能包含多个 assistant 消息（每次 agent 迭代一个）
    //   将它们合并为一个"回合"，包含所有思考过程、文本和工具调用
    const hasText = !!String(content).trim();
    if (!thinkingText && !hasText && !hasToolCalls) continue;

    // ★ 检查上一行是否也是 assistant 的 turn-row，如果是则追加段；否则新建
    const prevRow = inner.lastElementChild;
    const isContinuation = prevRow && prevRow.classList.contains('rp-turn') && prevRow.dataset.role === 'assistant';

    let turnRow, segments;
    if (isContinuation) {
      // 复用已有的 turn-row，追加段到末尾
      turnRow = prevRow;
      segments = turnRow.querySelector('.rp-turn-segments');
    } else {
      // 新建 turn-row
      turnRow = document.createElement('div');
      turnRow.className = 'rp-msg-row rp-turn';
      turnRow.dataset.role = 'assistant';
      turnRow.dataset.msgIdx = rawIdx;
      const _tidMatch = hasText ? String(content).match(/#(task-[A-Za-z0-9_-]+)/) : null;
      if (_tidMatch) turnRow.dataset.taskId = _tidMatch[1];

      const emp = getEmployee(EMPLOYEE_STORE.selectedId);
      const headerHtml = `
        <div class="rp-msg-role assistant">
          <span class="rp-msg-icon">${emp?.avatar || '🤖'}</span>
          <span class="rp-msg-name">${esc(emp?.name || 'Hermes')}</span>${_fmtMsgTime(m)}
        </div>
      `;
      turnRow.innerHTML = headerHtml + '<div class="rp-turn-segments"></div>';
      segments = turnRow.querySelector('.rp-turn-segments');
      inner.appendChild(turnRow);
    }

    // 段：思考卡片（可折叠）— 每个迭代都有独立的思考块
    if (thinkingText) {
      const tk = document.createElement('div');
      tk.className = 'rp-turn-thinking thinking-card';
      tk.innerHTML = `<div class="thinking-card-header" onclick="this.parentElement.classList.toggle('open')"><span class="thinking-card-icon">${typeof li === 'function' ? li('lightbulb', 14) : '💡'}</span><span class="thinking-card-label">思考过程</span><span class="thinking-card-toggle">${typeof li === 'function' ? li('chevron-right', 12) : '▶'}</span></div><div class="thinking-card-body">${renderMd(thinkingText)}</div>`;
      segments.appendChild(tk);
    }

    // 段：正文文本气泡 — 每个迭代的文本都显示
    if (hasText) {
      const bodyEl = document.createElement('div');
      bodyEl.className = 'rp-msg-body rp-turn-text';
      bodyEl.innerHTML = renderMd(String(content));
      segments.appendChild(bodyEl);
      if (!turnRow.dataset.rawText) turnRow.dataset.rawText = String(content).trim();
    }

    // 段：工具卡片（tool_calls + 配对的 tool 结果）
    if (hasToolCalls) {
      for (const tc of m.tool_calls) {
        if (!tc || typeof tc !== 'object') continue;
        const fn = tc.function || {};
        const toolName = fn.name || tc.name || 'tool';
        const toolCallId = tc.id || tc.call_id || '';
        let argsObj = {};
        try { argsObj = JSON.parse(fn.arguments || '{}'); } catch(_) {}
        const argsSnap = {};
        Object.keys(argsObj).slice(0, 4).forEach(k => {
          const v = String(argsObj[k] ?? '');
          argsSnap[k] = v.length > 120 ? v.slice(0, 120) + '...' : v;
        });
        let resultSnippet = '';
        if (toolCallId) {
          const toolMsg = S.messages.find(x => x && x.role === 'tool' && x.tool_call_id === toolCallId);
          if (toolMsg) {
            resultSnippet = typeof toolMsg.content === 'string'
              ? toolMsg.content
              : JSON.stringify(toolMsg.content || '');
          }
        }
        const tcData = {
          name: toolName,
          snippet: resultSnippet,
          tid: toolCallId,
          args: argsSnap,
          done: true,
        };
        if (typeof buildToolCard === 'function') {
          const cardRow = buildToolCard(tcData);
          cardRow.classList.add('rp-turn-tool');
          segments.appendChild(cardRow);
        }
      }
    }
  }

  // 窗口化：顶部插入 sentinel（若还有更早的历史未渲染）+ 挂载 scroll 监听
  if (_start > 0) {
    _insertHistorySentinel(inner, _start, () => _loadMoreHistory(_renderRpMessages));
  }
  _attachHistoryScrollListener(_renderRpMessages);

  // 粘底滚动（用户在底部时才跟随新消息，手动向上滚动后不打断阅读）
  _scrollMsgAreaIfSticky();

  // 语法高亮
  requestAnimationFrame(() => {
    if (typeof highlightCode === 'function') highlightCode(inner);
    if (typeof addCopyButtons === 'function') addCopyButtons(inner);
  });
}

// ── 发送消息（覆盖原 send）────────────────────────────────────────────────
// 原 send 函数由 messages.js 定义，这里不覆盖，而是在 boot.js 中做适配
// 关键：确保 S.session 和 S.messages 正确绑定到员工会话

// ── 技能详情模式 ────────────────────────────────────────────────────────────
function openSkillDetail(skillName, category, content) {
  // ★ 2026-04-27 变更：技能详情不再占用中栏聊天页签（原 rpSkillView），
  //   改为在右侧栏新增的「详情」tab 中展示，避免干扰员工对话。
  //   - 会自动显示并切换到右侧栏的「详情」tab
  //   - 右侧栏始终可见（不折叠）
  //   - 保留 assignSkillToEmployee 的入口按钮
  const tabBtn = document.getElementById('outputTabDetail');
  if (tabBtn) tabBtn.style.display = '';

  const titleEl = document.getElementById('outDetailTitle');
  if (titleEl) titleEl.textContent = skillName || '技能详情';
  const subtitleEl = document.getElementById('outDetailSubtitle');
  if (subtitleEl) subtitleEl.textContent = category || '未分类';

  const metaEl = document.getElementById('outDetailMeta');
  if (metaEl) {
    metaEl.innerHTML = `
      <div class="rp-skill-info"><strong>名称:</strong> ${esc(skillName)}</div>
      <div class="rp-skill-info"><strong>分类:</strong> ${esc(category || '未分类')}</div>
      <div class="rp-skill-info"><strong>类型:</strong> ${content ? '自定义技能' : '系统技能'}</div>
    `;
  }

  const bodyEl = document.getElementById('outDetailBody');
  if (bodyEl) {
    bodyEl.innerHTML = content ? renderMd(content) : '<p style="color:var(--muted)">暂无详细内容</p>';
  }

  // 动作区：重建（清空后插入"分配给员工" + 关闭按钮）
  const actionsEl = document.getElementById('outDetailActions');
  if (actionsEl) {
    actionsEl.innerHTML = `
      <button class="panel-icon-btn" title="分配给员工" onclick="assignSkillToEmployee()"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M16 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="8.5" cy="7" r="4"/><line x1="20" y1="8" x2="20" y2="14"/><line x1="23" y1="11" x2="17" y2="11"/></svg></button>
      <button class="panel-icon-btn close-preview" title="关闭详情" onclick="closeDetailPanel()"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg></button>
    `;
  }

  // 保存当前查看的技能名，用于分配
  window._currentViewSkill = skillName;

  // 切到详情 tab
  if (typeof switchOutputTab === 'function') {
    try { switchOutputTab('detail'); } catch (_) {}
  }

  // 确保右侧栏不折叠
  const panel = document.getElementById('rightPanel');
  const layout = document.querySelector('.layout');
  if (panel) {
    panel.classList.remove('rp-collapsed');
    panel.style.display = 'flex';
  }
  if (layout) layout.classList.remove('workspace-panel-collapsed');
}

/**
 * 关闭右侧栏「详情」tab：
 *  - 隐藏 tab 按钮；
 *  - 切回默认的「全部文件」tab；
 *  - 清空内容避免下次打开时短暂看到旧数据。
 */
function closeDetailPanel() {
  const tabBtn = document.getElementById('outputTabDetail');
  if (tabBtn) tabBtn.style.display = 'none';

  const bodyEl = document.getElementById('outDetailBody');
  if (bodyEl) bodyEl.innerHTML = '';
  const metaEl = document.getElementById('outDetailMeta');
  if (metaEl) metaEl.innerHTML = '';
  window._currentViewSkill = null;

  // 切回默认 tab
  if (typeof switchOutputTab === 'function') {
    try { switchOutputTab('files'); } catch (_) {}
  }
}

// 暴露到 window（onclick 需要）
window.closeDetailPanel = closeDetailPanel;

function assignSkillToEmployee() {
  const skillName = window._currentViewSkill;
  if (!skillName) return;

  // 显示员工选择器
  const employees = EMPLOYEE_STORE.employees;
  if (!employees.length) { showToast('没有可分配的员工'); return; }

  const overlay = document.createElement('div');
  overlay.className = 'emp-dialog-overlay';
  overlay.innerHTML = `
    <div class="emp-dialog">
      <div class="emp-dialog-header">
        <h3>分配技能到员工</h3>
        <button class="panel-icon-btn" onclick="this.closest('.emp-dialog-overlay').remove()"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg></button>
      </div>
      <div class="emp-dialog-body">
        <p style="font-size:13px;color:var(--muted);margin-bottom:12px">选择要分配技能「${esc(skillName)}」的员工：</p>
        ${employees.map(e => `
          <div class="emp-assign-row${e.skills.find(s => (s.name || s) === skillName) ? ' emp-already-assigned' : ''}" data-emp-id="${e.id}">
            <span class="emp-assign-avatar">${e.avatar}</span>
            <span class="emp-assign-name">${esc(e.name)}</span>
            <span class="emp-assign-role">${esc(e.role)}</span>
            ${e.skills.find(s => (s.name || s) === skillName) ? '<span class="emp-assign-badge">已分配</span>' : ''}
          </div>
        `).join('')}
      </div>
    </div>
  `;

  document.body.appendChild(overlay);

  overlay.querySelectorAll('.emp-assign-row:not(.emp-already-assigned)').forEach(row => {
    row.onclick = () => {
      const empId = row.dataset.empId;
      assignSkillToEmployee(empId, skillName);
      showToast(`已将技能「${skillName}」分配给 ${getEmployee(empId)?.name}`);
      overlay.remove();
    };
  });
}

// ── 员工技能面板（右侧）────────────────────────────────────────────────────
function showEmployeeSkillPanel(empId) {
  const emp = getEmployee(empId);
  if (!emp) return;

  _setRightPanelView('skill');

  const nameEl = $('rpSkillName');
  if (nameEl) nameEl.textContent = emp.name + ' 的技能';
  const catEl = $('rpSkillCategory');
  if (catEl) catEl.textContent = emp.role;

  const metaEl = $('rpSkillMeta');
  if (metaEl) metaEl.innerHTML = '';

  const bodyEl = $('rpSkillBody');
  if (bodyEl) {
    let html = '<div class="rp-skill-list">';
    if (emp.skills.length) {
      for (const sk of emp.skills) {
        const name = sk.name || sk;
        const enabled = sk.enabled !== false;
        html += `
          <div class="rp-skill-item">
            <span class="rp-skill-item-name">${esc(name)}</span>
            <div class="rp-skill-item-actions">
              <label class="rp-skill-toggle">
                <input type="checkbox" ${enabled ? 'checked' : ''} onchange="toggleEmployeeSkill('${emp.id}','${esc(name)}',this.checked)">
                <span class="rp-skill-toggle-slider"></span>
              </label>
              <button class="rp-skill-remove-btn" title="移除技能" onclick="removeEmployeeSkill('${emp.id}','${esc(name)}')">×</button>
            </div>
          </div>
        `;
      }
    } else {
      html += '<p style="color:var(--muted);font-size:13px;padding:12px 0">暂无配置技能</p>';
    }
    html += '</div>';
    html += `<button class="rp-skill-add-btn" onclick="addSkillToEmployeeInline('${emp.id}')">+ 添加技能</button>`;
    bodyEl.innerHTML = html;
  }

  window._currentViewSkill = null;
}

function toggleEmployeeSkill(empId, skillName, enabled) {
  const emp = getEmployee(empId);
  if (!emp) return;
  const sk = emp.skills.find(s => (s.name || s) === skillName);
  if (sk) {
    sk.enabled = enabled;
    _saveEmployees();
    _syncEmployeePromptToSession(emp);
  }
}

// ── 技能删除 ─────────────────────────────────────────────────────────────────
function removeEmployeeSkill(empId, skillName) {
  const emp = getEmployee(empId);
  if (!emp) return;
  const idx = emp.skills.findIndex(s => (s.name || s) === skillName);
  if (idx !== -1) {
    emp.skills.splice(idx, 1);
    _saveEmployees();
    renderEmployeeCards();
    showEmployeeSkillPanel(empId); // 刷新面板
    _syncEmployeePromptToSession(emp);
    showToast(`已移除技能「${skillName}」`);
  }
}

// ── 技能快速添加 ─────────────────────────────────────────────────────────────
/**
 * 弹出"添加技能"对话框。
 * ★ 2026-04-27 增强：输入框下方实时显示可添加技能的自动补全下拉，
 *   数据源 = `GET /api/skills`（缓存为 `window._allSkillsCache`），
 *   过滤规则 = （名称或描述含输入关键字）且 员工尚未拥有该技能。
 *   支持键盘 ↑/↓/Enter/Esc 导航。允许输入自定义技能名（不在列表中也可添加）。
 */
async function addSkillToEmployeeInline(empId) {
  const emp = getEmployee(empId);
  if (!emp) return;

  // 1) 预取所有可用技能（带简单缓存，避免每次点击都请求）
  if (!window._allSkillsCache) {
    try {
      const data = await api('/api/skills');
      window._allSkillsCache = Array.isArray(data.skills) ? data.skills : [];
    } catch (_) {
      window._allSkillsCache = [];
    }
  }

  // 弹出添加技能对话框
  const overlay = document.createElement('div');
  overlay.className = 'app-dialog-overlay';
  overlay.style.display = 'flex';
  overlay.innerHTML = `
    <div class="app-dialog" style="max-width:380px">
      <div class="app-dialog-header">
        <div class="app-dialog-title">添加技能</div>
        <button class="app-dialog-close" id="addSkillClose"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg></button>
      </div>
      <div style="padding:4px 20px 16px">
        <div style="font-size:12px;color:var(--muted);margin-bottom:10px">为「${esc(emp.name)}」添加一项专业技能</div>
        <div class="skill-ac-wrap" style="position:relative">
          <input class="emp-dialog-input" id="addSkillInput" placeholder="输入技能名称，如：Python、代码审查、架构设计" style="width:100%" maxlength="40" autocomplete="off">
          <div class="skill-ac-dropdown" id="addSkillDropdown" style="display:none"></div>
        </div>
      </div>
      <div class="app-dialog-actions">
        <button class="app-dialog-btn" id="addSkillCancel">取消</button>
        <button class="app-dialog-btn confirm" id="addSkillOk">添加</button>
      </div>
    </div>
  `;
  document.body.appendChild(overlay);
  const input = overlay.querySelector('#addSkillInput');
  const dd = overlay.querySelector('#addSkillDropdown');
  setTimeout(() => input.focus(), 50);

  const close = () => overlay.remove();
  overlay.querySelector('#addSkillClose').onclick = close;
  overlay.querySelector('#addSkillCancel').onclick = close;

  // 已拥有技能名集合（大小写不敏感）
  const ownedNames = new Set(emp.skills.map(s => ((s.name || s) + '').toLowerCase()));

  // 当前下拉高亮项索引（-1 表示无高亮）
  let activeIdx = -1;
  let currentMatches = [];

  /** 渲染下拉列表（最多 8 条） */
  function renderDropdown(q) {
    const qLower = (q || '').trim().toLowerCase();
    const skills = window._allSkillsCache || [];
    // 过滤：未被该员工拥有 + 名称或描述包含关键字
    currentMatches = skills
      .filter(sk => sk && sk.name && !ownedNames.has(sk.name.toLowerCase()))
      .filter(sk => {
        if (!qLower) return true;
        const n = (sk.name || '').toLowerCase();
        const d = (sk.description || '').toLowerCase();
        return n.includes(qLower) || d.includes(qLower);
      })
      .slice(0, 8);

    if (!currentMatches.length) {
      dd.style.display = 'none';
      dd.innerHTML = '';
      activeIdx = -1;
      return;
    }
    dd.style.display = 'block';
    dd.innerHTML = currentMatches.map((sk, i) => `
      <div class="skill-ac-item${i === activeIdx ? ' active' : ''}" data-idx="${i}">
        <div class="skill-ac-name">${esc(sk.name)}</div>
        ${sk.description ? `<div class="skill-ac-desc">${esc(sk.description)}</div>` : ''}
      </div>
    `).join('');

    // 点击选中某项 → 填入输入框 + 自动提交
    dd.querySelectorAll('.skill-ac-item').forEach(el => {
      el.onclick = () => {
        const idx = parseInt(el.dataset.idx, 10);
        if (currentMatches[idx]) {
          input.value = currentMatches[idx].name;
          overlay.querySelector('#addSkillOk').click();
        }
      };
      el.onmouseenter = () => {
        activeIdx = parseInt(el.dataset.idx, 10);
        updateActiveHighlight();
      };
    });
  }

  function updateActiveHighlight() {
    dd.querySelectorAll('.skill-ac-item').forEach((el, i) => {
      el.classList.toggle('active', i === activeIdx);
    });
    // 滚动到可视区
    const activeEl = dd.querySelector('.skill-ac-item.active');
    if (activeEl && activeEl.scrollIntoView) {
      activeEl.scrollIntoView({ block: 'nearest' });
    }
  }

  // 初始显示（空关键字 → 全量候选）
  renderDropdown('');

  input.addEventListener('input', () => {
    activeIdx = -1;
    renderDropdown(input.value);
  });

  overlay.querySelector('#addSkillOk').onclick = () => {
    const name = input.value.trim();
    if (!name) return;
    if (emp.skills.find(s => (s.name || s) === name)) {
      showToast('该技能已存在');
      return;
    }
    emp.skills.push({ name, enabled: true });
    _saveEmployees();
    renderEmployeeCards();
    showEmployeeSkillPanel(empId);
    _syncEmployeePromptToSession(emp);
    showToast(`已添加技能「${name}」`);
    close();
  };

  input.addEventListener('keydown', e => {
    if (e.key === 'ArrowDown') {
      if (!currentMatches.length) return;
      e.preventDefault();
      activeIdx = (activeIdx + 1) % currentMatches.length;
      updateActiveHighlight();
    } else if (e.key === 'ArrowUp') {
      if (!currentMatches.length) return;
      e.preventDefault();
      activeIdx = (activeIdx - 1 + currentMatches.length) % currentMatches.length;
      updateActiveHighlight();
    } else if (e.key === 'Enter') {
      e.preventDefault();
      // 若下拉有高亮项，用高亮项填入后再添加；否则按当前输入值添加
      if (activeIdx >= 0 && currentMatches[activeIdx]) {
        input.value = currentMatches[activeIdx].name;
      }
      overlay.querySelector('#addSkillOk').click();
    } else if (e.key === 'Escape') {
      close();
    }
  });
}

// ── 员工技能弹窗（从 chat header 调用）───────────────────────────────────────
function showEmployeeSkillDialog() {
  const empId = EMPLOYEE_STORE.selectedId;
  if (!empId) { showToast('请先选择一个员工'); return; }
  showEmployeeSkillPanel(empId);
}

// ── 提示词编辑器 ──────────────────────────────────────────────────────────────
function openEmployeePromptEditor() {
  const emp = getEmployee(EMPLOYEE_STORE.selectedId);
  if (!emp) { showToast('请先选择一个员工'); return; }

  _setRightPanelView('prompt');

  const titleEl = $('rpPromptTitle');
  if (titleEl) titleEl.textContent = emp.name + ' 的提示词';

  // 直接在完整提示词区域编辑
  const fullPrompt = buildEmployeeSystemPrompt(emp);
  const editorEl = $('rpPromptEditor');
  if (editorEl) editorEl.value = fullPrompt || '';
}

function saveEmployeePrompt() {
  const emp = getEmployee(EMPLOYEE_STORE.selectedId);
  if (!emp) return;

  const editorEl = $('rpPromptEditor');
  const newPrompt = editorEl ? editorEl.value.trim() : '';

  // 计算自动生成的原始提示词（不含 customPrompt）
  const autoPrompt = buildEmployeeSystemPrompt({ ...emp, customPrompt: '' });

  // 如果编辑后的内容与自动生成的一致，清空 customPrompt（避免冗余存储）
  emp.customPrompt = (newPrompt && newPrompt !== autoPrompt) ? newPrompt : '';
  _saveEmployees();

  // 即时生效：同步到 session
  _syncEmployeePromptToSession(emp);

  showToast('提示词已保存，即时生效');
  // 返回聊天视图
  openEmployeeChat(emp.id);
}

function closePromptEditor() {
  const emp = getEmployee(EMPLOYEE_STORE.selectedId);
  if (emp) {
    openEmployeeChat(emp.id);
  } else {
    _setRightPanelView('empty');
  }
}

// ── 即时同步提示词到 session ────────────────────────────────────────────────
function _syncEmployeePromptToSession(emp) {
  if (!emp || !emp.sessionId) return;
  const prompt = buildEmployeeSystemPrompt(emp);
  // 更新后端 session 的 system_prompt
  api('/api/session/update', {
    method: 'POST',
    body: JSON.stringify({ session_id: emp.sessionId, system_prompt: prompt }),
  }).catch(() => {}); // fire-and-forget
}

// ── 委派关系信息条 ──────────────────────────────────────────────────────────
function _updateDelegationBar(emp) {
  console.log('[右面板] _updateDelegationBar(原始) called, emp=', emp?.name || null, 'isOpen=', typeof GROUP_CHAT_STATE !== 'undefined' ? GROUP_CHAT_STATE.isOpen : 'N/A');
  const bar = $('rpDelegationBar');
  const info = $('rpDelegationInfo');
  if (!bar || !info) return;

  // ★ 守卫：若任一成员下拉面板正打开，跳过刷新，避免销毁输入框 DOM 导致焦点丢失与中文输入被打断
  const _ddGroup = document.getElementById('gcMembersDropdown');
  const _ddEmpSubs = document.getElementById('empSubsDropdown');
  if ((_ddGroup && _ddGroup.style.display && _ddGroup.style.display !== 'none')
      || (_ddEmpSubs && _ddEmpSubs.style.display && _ddEmpSubs.style.display !== 'none')) {
    return;
  }

  // 总群打开时，走总群委派栏逻辑（不受 emp 为 null 影响）
  if (typeof GROUP_CHAT_STATE !== 'undefined' && GROUP_CHAT_STATE.isOpen) {
    if (typeof _updateGroupDelegationBar === 'function') {
      _updateGroupDelegationBar();
    } else {
      bar.style.display = 'none';
    }
    return;
  }

  if (!emp) { bar.style.display = 'none'; return; }

  const parts = [];

  // 总群链接（始终显示在最前）
  if (typeof _groupChatTitle === 'function') {
    let ws = (typeof GROUP_CHAT_STATE !== 'undefined' && GROUP_CHAT_STATE.workspace) || '';
    if (!ws || ws === '__default__') ws = (typeof _currentCanvasWorkspace !== 'undefined' ? _currentCanvasWorkspace : '');
    if (!ws || ws === '__default__') ws = (S.session?.workspace || '');
    if (!ws || ws === '__default__') ws = (typeof _activeWorkspacePath === 'function' ? _activeWorkspacePath() : '');
    if (!ws && typeof _currentCanvasWorkspace !== 'undefined') ws = _currentCanvasWorkspace;
    if (ws) {
      const groupTitle = _groupChatTitle(ws);
      parts.push(`<span class="rp-del-label">总群：</span><span class="rp-del-name gc-link" onclick="openGroupChat()" title="打开${esc(groupTitle)}">${esc(groupTitle)}</span>`);
    }
  }

  // 管理者（从连线关系）
  if (emp.subagentOf && typeof getEmployee === 'function') {
    const mgr = getEmployee(emp.subagentOf);
    if (mgr) {
      parts.push(`<span class="rp-del-label">上级：</span><span class="rp-del-name" onclick="selectEmployee('${mgr.id}')">${esc(mgr.name)}</span>`);
    }
  }

  // 下属（从连线关系）
  if (typeof getSubagentsOf === 'function') {
    const subs = getSubagentsOf(emp.id);
    if (subs && subs.length) {
      if (typeof window._renderSubsSegment === 'function') {
        parts.push(window._renderSubsSegment(emp.id, subs));
      } else {
        const subLinks = subs.map(s =>
          `<span class="rp-del-name" onclick="selectEmployee('${s.to}')">${esc(s.employee?.name || '?')}</span>`
        ).join('、');
        parts.push(`<span class="rp-del-label">下属：</span><span class="rp-del-names">${subLinks}</span>`);
      }
    }
  }

  // 方案 B：若员工有正在跑的任务，显示"取消当前任务"按钮
  if (typeof DelegationVM !== 'undefined' && typeof DelegationVM.getRunningJob === 'function') {
    try {
      const runningJob = DelegationVM.getRunningJob(emp.id);
      if (runningJob) {
        const qlen = (typeof DelegationVM.getQueueLength === 'function') ? (DelegationVM.getQueueLength(emp.id) || 0) : 0;
        const kindLabel = runningJob.kind === 'delegated' ? '委派任务' : '当前任务';
        const queueSuffix = qlen > 0 ? `（队列还有 ${qlen}）` : '';
        parts.push(`<span class="rp-del-cancel-btn" onclick="_cancelCurrentJob('${esc(emp.id)}', '${esc(runningJob.id)}')" title="取消${kindLabel}${queueSuffix}">⏹ 取消${kindLabel}${queueSuffix}</span>`);
      }
    } catch (_) {}
  }

  if (parts.length) {
    info.innerHTML = parts.join('<span class="rp-del-sep">|</span>');
    bar.style.display = '';
  } else {
    bar.style.display = 'none';
  }

  // 异步加载委派历史（从后端 API）
  _loadDelegationHistory(emp);
}

/** 异步从后端 API 加载委派历史，追加显示到委派栏下方 */
async function _loadDelegationHistory(emp) {
  const historyEl = $('rpDelegationHistory');
  if (!historyEl || !emp || !emp.sessionId) {
    if (historyEl) historyEl.innerHTML = '';
    return;
  }

  if (typeof fetchDelegationHistory !== 'function') {
    historyEl.innerHTML = '';
    return;
  }

  try {
    const children = await fetchDelegationHistory(emp.id);
    if (!children || !children.length) {
      historyEl.innerHTML = '';
      return;
    }

    // 渲染委派历史摘要
    let html = '<div class="rp-del-history-title">委派历史</div>';
    for (const child of children.slice(0, 5)) {  // 最多显示 5 条
      const name = child.employee_name || child.title || '子任务';
      const status = child.status || '';
      const summary = child.summary ? (child.summary.length > 60 ? child.summary.slice(0, 60) + '...' : child.summary) : '';
      html += `<div class="rp-del-history-item">
        <span class="rp-del-history-name">${esc(name)}</span>
        ${summary ? `<span class="rp-del-history-summary">${esc(summary)}</span>` : ''}
      </div>`;
    }
    if (children.length > 5) {
      html += `<div class="rp-del-history-more">还有 ${children.length - 5} 条记录</div>`;
    }
    historyEl.innerHTML = html;
  } catch (e) {
    historyEl.innerHTML = '';
  }
}

/** 方案 B：取消员工当前正在跑的 Job（委派或手动）
 *  通过 DelegationVM.cancelJob 统一入口，内部会调 cancelFn（关 SSE + /api/chat/cancel）
 *  并推进队列下一项启动。
 */
async function _cancelCurrentJob(empId, jobId) {
  if (!empId || !jobId) return;
  if (typeof DelegationVM === 'undefined' || typeof DelegationVM.cancelJob !== 'function') return;
  const emp = (typeof getEmployee === 'function') ? getEmployee(empId) : null;
  const empName = emp?.name || '员工';
  // 使用通用 UI 对话框，避免触发 Chrome 系统提示框
  let ok;
  if (typeof showConfirmDialog === 'function') {
    ok = await showConfirmDialog({
      title: '终止执行',
      message: `确定要终止 ${empName} 当前正在执行的任务吗？\n（队列中等待的任务不受影响，将依次继续执行）`,
      confirmLabel: '终止执行',
      cancelLabel: '继续执行',
      danger: true,
      focusCancel: true,
    });
  } else {
    ok = confirm(`确定要取消 ${empName} 当前正在执行的任务吗？\n（队列中等待的任务不受影响，将依次继续执行）`);
  }
  if (!ok) return;
  try {
    const cancelled = await DelegationVM.cancelJob(jobId);
    if (cancelled) {
      if (typeof showToast === 'function') showToast(`已取消 ${empName} 的当前任务`, 2500);
      // 若当前 UI 正在看这个员工的 session，手动隐藏 Cancel 按钮与 thinking
      if (typeof S !== 'undefined' && emp && S.session && S.session.session_id === emp.sessionId) {
        const _cb = $('btnCancel'); if (_cb) _cb.style.display = 'none';
        if (typeof removeThinking === 'function') removeThinking();
      }
    } else {
      if (typeof showToast === 'function') showToast('取消失败：任务可能已结束', 2000);
    }
  } catch (err) {
    console.warn('[取消任务] 失败:', err);
    if (typeof showToast === 'function') showToast(`取消失败: ${err.message || err}`, 2500);
  }
}

// ── 初始化 ─────────────────────────────────────────────────────────────────
function initRightPanel() {
  // 强制确保右侧面板可见（移除所有可能的隐藏类和样式）
  const panel = $('rightPanel');
  const layout = document.querySelector('.layout');
  if (panel) {
    panel.classList.remove('rp-collapsed');
    panel.style.display = 'flex';
    panel.style.width = '440px';
    panel.style.minWidth = '340px';
    panel.style.opacity = '1';
  }
  if (layout) {
    layout.classList.remove('workspace-panel-collapsed');
  }

  // 如果有员工，恢复上次选中的员工并打开聊天框
  if (typeof EMPLOYEE_STORE !== 'undefined' && EMPLOYEE_STORE.employees.length > 0) {
    // ★ 从 localStorage 恢复上次选中的员工
    const savedEmpId = localStorage.getItem('hermes-webui-selected-employee');
    const targetEmployee = (savedEmpId && EMPLOYEE_STORE.employees.find(e => e.id === savedEmpId))
      || EMPLOYEE_STORE.employees[0];
    EMPLOYEE_STORE.selectedId = targetEmployee.id;
    // 先设置面板视图为 chat（不依赖 API 调用）
    _setRightPanelView('chat');
    // 更新头部信息
    const avatarEl = $('rpEmployeeAvatar');
    if (avatarEl) {
      if (targetEmployee.characterImg) {
        const fb2 = (targetEmployee.avatar||'').replace(/'/g, "\\'");
        avatarEl.innerHTML = `<div class="rp-employee-avatar-sprite" style="background-image:url('/static/img/characters/${targetEmployee.characterImg}_frame32x32.png');background-size:300% 400%;background-position:0 0;background-repeat:no-repeat" data-fallback="${fb2}" onerror="this.remove();this.parentElement.textContent='${fb2}'"></div>`;
      } else {
        avatarEl.textContent = targetEmployee.avatar;
      }
    }
    const nameEl = $('rpEmployeeName');
    if (nameEl) nameEl.textContent = targetEmployee.name;
    const roleEl = $('rpEmployeeRole');
    if (roleEl) roleEl.textContent = targetEmployee.role;
    // 异步加载会话（失败也不影响面板显示）
    openEmployeeChat(targetEmployee.id).catch(() => {});
    // 更新卡片选中状态（需要等卡片渲染完）
    setTimeout(() => {
      document.querySelectorAll('.emp-card').forEach(c => {
        c.classList.toggle('emp-selected', c.dataset.id === targetEmployee.id);
      });
    }, 150);
  } else {
    _setRightPanelView('empty');
  }
}

// ── 文件预览模式（右侧面板）────────────────────────────────────────────────

let _rpFileCurrentPath = '';
let _rpFileCurrentMode = '';  // 'code' | 'md' | 'image'
let _rpFileRawContent = '';
let _rpFileDirty = false;
let _rpFileIsEditing = false;    // 当前是否处于编辑态
let _cmEditOriginalContent = ''; // 编辑前的原始内容，用于取消时恢复

// ── CodeMirror 6 辅助函数 ─────────────────────────────────────────────────

/** 检测 CM_EDITOR 模块是否已就绪 */
function _cmReady() {
  return typeof window.CM_EDITOR === 'object' && window.CM_EDITOR !== null;
}

/** 根据文件扩展名推断 Prism 语言名（CM6 语言映射也使用同一套名字） */
function _rpFileLang(path) {
  const ext = _rpFileExt(path).replace(/^\./, '');
  const base = String(path || '').split(/[\\/]/).pop().toLowerCase();
  const map = {
    py: 'python', pyw: 'python',
    js: 'javascript', mjs: 'javascript', cjs: 'javascript',
    ts: 'typescript', tsx: 'tsx', jsx: 'jsx',
    css: 'css', scss: 'scss', less: 'less',
    html: 'html', htm: 'markup', xml: 'xml', svg: 'svg',
    json: 'json', jsonc: 'json',
    yml: 'yaml', yaml: 'yaml',
    md: 'markdown', markdown: 'markdown',
    java: 'java',
    c: 'c', h: 'c', cpp: 'cpp', cc: 'cpp', cxx: 'cpp', hpp: 'cpp',
    cs: 'csharp',
    go: 'go',
    rs: 'rust',
    php: 'php',
    sql: 'sql',
    vue: 'vue',
    sh: 'bash', bash: 'bash', zsh: 'bash',
    ps1: 'powershell', psm1: 'powershell', psd1: 'powershell',
    bat: 'shell', cmd: 'shell',
    toml: 'toml', ini: 'ini', cfg: 'ini',
    diff: 'diff', patch: 'diff',
  };
  if (base === 'dockerfile') return 'docker';
  return map[ext] || 'none';
}

/** 在 rpFileCode 容器中创建 CM6 预览实例 */
function _cmCreatePreview(content, lang) {
  const container = $('rpFileCode');
  if (!container) return false;

  container.classList.remove('cm-active');
  container.innerHTML = _plainCodeHtml(content);

  if (!_cmReady()) return false;

  try {
    container.innerHTML = '';
    window.CM_EDITOR.create(container, content, lang, false);

    if (!container.querySelector('.cm-editor')) {
      throw new Error('CM editor did not mount');
    }

    container.classList.add('cm-active');
    return true;
  } catch (err) {
    console.error('[RP] Failed to create CM preview:', err);
    container.classList.remove('cm-active');
    container.innerHTML = _plainCodeHtml(content);
    return false;
  }
}

/** 切换 CM6 到编辑态 */
function _cmStartEdit() {
  if (!_cmReady() || !window.CM_EDITOR.getView()) return;
  window.CM_EDITOR.setEditable(true);
  _rpFileIsEditing = true;
}

/** 切换 CM6 回预览态 */
function _cmStopEdit() {
  if (!_cmReady() || !window.CM_EDITOR.getView()) return;
  window.CM_EDITOR.setEditable(false);
  _rpFileIsEditing = false;
}

/** 销毁当前 CM6 实例 */
function _cmDestroy() {
  if (_cmReady()) {
    window.CM_EDITOR.destroy();
  }
}

/** 获取 CM6 当前内容 */
function _cmGetContent() {
  if (_cmReady()) return window.CM_EDITOR.getContent();
  return '';
}

/** 设置 CM6 内容 */
function _cmSetContent(content) {
  if (_cmReady()) window.CM_EDITOR.setContent(content);
}

const _RP_FILE_EDIT_ICON = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>';
const _RP_FILE_SAVE_ICON = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z"/><polyline points="17 21 17 13 7 13 7 21"/><polyline points="7 3 7 8 15 8"/></svg>';

function _setRpFileEditButtonState(editing) {
  const editBtn = $('rpFileEditBtn');
  if (!editBtn) return;
  editBtn.innerHTML = editing ? _RP_FILE_SAVE_ICON : _RP_FILE_EDIT_ICON;
  editBtn.style.color = editing ? 'var(--blue)' : '';
}

function _syncRpFileDirtyState(nextContent) {
  if (!_rpFileIsEditing) {
    _rpFileDirty = false;
    return false;
  }
  const content = typeof nextContent === 'string' ? nextContent : _cmGetContent();
  _rpFileDirty = content !== _cmEditOriginalContent;
  return _rpFileDirty;
}

function _rpFileHasUnsavedChanges() {
  return !!(_rpFileIsEditing && _syncRpFileDirtyState());
}

async function _saveRpFileEdit() {
  if (!_rpFileCurrentPath) return false;
  const content = _cmGetContent();
  const savePayload = { path: _rpFileCurrentPath, content };
  if (S.session && S.session.session_id) savePayload.session_id = S.session.session_id;

  try {
    await api('/api/file/save', {
      method: 'POST',
      body: JSON.stringify(savePayload)
    });
    _rpFileDirty = false;
    _rpFileRawContent = content;
    _rpFileIsEditing = false;
    _cmEditOriginalContent = '';
    _cmStopEdit();

    if (_rpFileCurrentMode === 'md') {
      const mdEl = $('rpFileMd');
      const codeEl = $('rpFileCode');
      if (mdEl) {
        mdEl.innerHTML = typeof renderMd === 'function' ? renderMd(content) : content;
        mdEl.style.display = '';
      }
      if (codeEl) codeEl.style.display = 'none';
    }

    _setRpFileEditButtonState(false);
    if (typeof showToast === 'function') showToast('已保存');
    return true;
  } catch (e) {
    if (typeof showToast === 'function') showToast('保存失败: ' + e.message);
    return false;
  }
}

async function _confirmRpFileLeave(nextPath = '') {
  if (!_rpFileCurrentPath || !_rpFileIsEditing) return true;

  if (!_rpFileHasUnsavedChanges()) {
    _cancelRpFileEdit();
    return true;
  }

  const currentName = _rpFileCurrentPath.split('/').pop() || '当前文件';
  const nextName = nextPath ? (String(nextPath).split('/').pop() || nextPath) : '当前页面';
  const saveMessage = `文件 “${currentName}” 已修改，是否先保存后再切换到 “${nextName}”？`;

  let shouldSave = false;
  if (typeof showConfirmDialog === 'function') {
    shouldSave = await showConfirmDialog({
      title: '未保存修改',
      message: saveMessage,
      confirmLabel: '保存并切换',
      cancelLabel: '继续编辑',
      focusCancel: true,
    });
  } else {
    shouldSave = window.confirm(saveMessage);
  }

  if (shouldSave) {
    return await _saveRpFileEdit();
  }

  const discardMessage = `如果继续切换到 “${nextName}”，当前修改将会丢失。是否继续？`;
  let shouldDiscard = false;
  if (typeof showConfirmDialog === 'function') {
    shouldDiscard = await showConfirmDialog({
      title: '放弃修改？',
      message: discardMessage,
      confirmLabel: '放弃并切换',
      cancelLabel: '继续编辑',
      danger: true,
      focusCancel: true,
    });
  } else {
    shouldDiscard = window.confirm(discardMessage);
  }

  if (!shouldDiscard) return false;
  _cancelRpFileEdit();
  return true;
}

/** 纯文本 HTML 回退（CM6 未加载时使用） */
function _plainCodeHtml(content) {
  const text = esc(content || '');
  return `<pre class="rp-file-code-fallback">${text}</pre>`;
}

// 文件扩展名分类（与 workspace.js 保持一致）
const _RP_IMAGE_EXTS = new Set(['.png','.jpg','.jpeg','.gif','.svg','.webp','.ico','.bmp']);
const _RP_MD_EXTS = new Set(['.md','.markdown','.mdown']);
const _RP_DOWNLOAD_EXTS = new Set([
  '.docx','.doc','.xlsx','.xls','.pptx','.ppt','.odt','.ods','.odp',
  '.pdf','.zip','.tar','.gz','.bz2','.7z','.rar',
  '.mp3','.mp4','.wav','.m4a','.ogg','.flac','.mov','.avi','.mkv','.webm',
  '.exe','.dmg','.pkg','.deb','.rpm',
  '.woff','.woff2','.ttf','.otf','.eot',
  '.bin','.dat','.db','.sqlite','.pyc','.class','.so','.dylib','.dll',
]);

function _rpFileExt(p) {
  const i = p.lastIndexOf('.');
  return i >= 0 ? p.slice(i).toLowerCase() : '';
}

/** 在右侧面板中打开文件预览 */
async function openFileInRightPanel(path) {
  if (!path) return;
  if (_rpView === 'file' && _rpFileCurrentPath === path) return;
  if (!(await _confirmRpFileLeave(path))) return;

  const ext = _rpFileExt(path);
  const sid = (S.session && S.session.session_id) ? encodeURIComponent(S.session.session_id) : '';

  // 二进制文件直接下载
  if (_RP_DOWNLOAD_EXTS.has(ext)) {
    if (typeof downloadFile === 'function') downloadFile(path);
    return;
  }

  _rpFileCurrentPath = path;
  _rpFileDirty = false;
  _rpFileIsEditing = false;
  _cmEditOriginalContent = '';

  // 切换到文件视图
  _setRightPanelView('file');

  // 更新头部信息
  const fileName = path.split('/').pop();
  const rpFileName = $('rpFileName');
  if (rpFileName) rpFileName.textContent = fileName;
  const rpFilePath = $('rpFilePath');
  if (rpFilePath) rpFilePath.textContent = path;

  // 重置内容区
  const codeEl = $('rpFileCode');
  const mdEl = $('rpFileMd');
  const imgWrap = $('rpFileImgWrap');
  const badge = $('rpFileBadge');
  const editBtn = $('rpFileEditBtn');

  if (codeEl) codeEl.style.display = 'none';
  if (mdEl) mdEl.style.display = 'none';
  if (imgWrap) imgWrap.style.display = 'none';
  // 销毁之前的 CM6 实例
  _cmDestroy();
  _setRpFileEditButtonState(false);
  if (editBtn) editBtn.style.display = 'none';

  // 构建 API 查询字符串
  const _fileQs = sid ? `session_id=${sid}&path=${encodeURIComponent(path)}` : `path=${encodeURIComponent(path)}`;

  if (_RP_IMAGE_EXTS.has(ext)) {
    // 图片预览
    _rpFileCurrentMode = 'image';
    if (badge) { badge.textContent = 'image'; badge.className = 'rp-file-badge image'; }
    if (editBtn) editBtn.style.display = 'none';
    if (imgWrap) imgWrap.style.display = '';
    const url = `/api/file/raw?${_fileQs}`;
    const img = $('rpFileImg');
    if (img) {
      img.alt = path;
      img.src = url;
      img.onerror = () => { if (typeof showToast === 'function') showToast('图片加载失败'); };
    }
  } else if (_RP_MD_EXTS.has(ext)) {
    // Markdown 预览
    _rpFileCurrentMode = 'md';
    if (badge) { badge.textContent = 'md'; badge.className = 'rp-file-badge md'; }
    if (editBtn) editBtn.style.display = '';
    try {
      const data = await api(`/api/file?${_fileQs}`);
      _rpFileRawContent = data.content || '';
      if (mdEl) {
        mdEl.style.display = '';
        mdEl.innerHTML = typeof renderMd === 'function' ? renderMd(data.content || '') : (data.content || '');
      }
    } catch (e) {
      if (mdEl) { mdEl.style.display = ''; mdEl.innerHTML = '<p style="color:var(--muted)">文件加载失败</p>'; }
    }
  } else {
    // 代码/文本预览
    _rpFileCurrentMode = 'code';
    if (badge) { badge.textContent = ext || 'text'; badge.className = 'rp-file-badge'; }
    if (editBtn) editBtn.style.display = '';
    try {
      const data = await api(`/api/file?${_fileQs}`);
      if (data.binary) {
        if (typeof downloadFile === 'function') downloadFile(path);
        await closeRpFilePreview({ force: true });
        return;
      }
      _rpFileRawContent = data.content || '';
      if (codeEl) {
        codeEl.style.display = '';
        // 使用 CM6 预览（readonly + 语法高亮 + 行号）
        const lang = _rpFileLang(path);
        _cmCreatePreview(data.content || '', lang);
      }
    } catch (e) {
      // 请求失败时在面板内显示错误，而不是下载
      if (codeEl) {
        codeEl.style.display = '';
        codeEl.textContent = `// 无法加载文件: ${path}\n// ${e.message || '请求失败'}`;
      }
    }
  }

  // 高亮当前选中的文件
  document.querySelectorAll('#mainFileTree .file-item').forEach(el => {
    el.classList.remove('file-item-active');
  });
  document.querySelectorAll('#mainFileTree .file-item').forEach(el => {
    const nameEl = el.querySelector('.file-name');
    if (nameEl && nameEl.textContent === fileName) {
      el.classList.add('file-item-active');
    }
  });
}

/** 关闭文件预览，返回之前的视图 */
async function closeRpFilePreview(options = {}) {
  if (!options.force && !(await _confirmRpFileLeave('当前页面'))) return false;

  _rpFileCurrentPath = '';
  _rpFileCurrentMode = '';
  _rpFileRawContent = '';
  _rpFileDirty = false;
  _rpFileIsEditing = false;
  _cmEditOriginalContent = '';
  // 销毁 CM6 实例并清空容器
  _cmDestroy();
  const codeEl = $('rpFileCode');
  if (codeEl) codeEl.innerHTML = '';
  // 如果有选中的员工，回到对话视图；否则显示空状态
  if (EMPLOYEE_STORE.selectedId) {
    _setRightPanelView('chat');
  } else {
    _setRightPanelView('empty');
  }
  // 移除文件选中高亮
  document.querySelectorAll('#mainFileTree .file-item').forEach(el => {
    el.classList.remove('file-item-active');
  });
  return true;
}

/** 切换编辑模式 — 使用 CM6 同一实例切换 readonly/可编辑 */
async function toggleRpFileEdit() {
  if (!_rpFileCurrentPath) return;

  if (_rpFileIsEditing) {
    await _saveRpFileEdit();
    return;
  }

  // ── 进入编辑模式 ──
  _cmEditOriginalContent = _rpFileRawContent;
  _rpFileDirty = false;

  if (_rpFileCurrentMode === 'md') {
    // MD 文件：隐藏渲染预览，显示 CM6 代码编辑
    const mdEl = $('rpFileMd');
    const codeEl = $('rpFileCode');
    if (mdEl) mdEl.style.display = 'none';
    if (codeEl) codeEl.style.display = '';
    // 为 MD 文件创建 CM6 实例
    _cmCreatePreview(_rpFileRawContent, 'markdown');
  }

  _cmStartEdit();
  _rpFileIsEditing = true;
  _setRpFileEditButtonState(true);

  // 监听 CM6 内容变更
  if (_cmReady()) {
    window.CM_EDITOR.onChange((content) => {
      _syncRpFileDirtyState(content);
    });
  }
}

function _cancelRpFileEdit() {
  // 恢复原始内容
  if (_cmEditOriginalContent !== '') {
    _cmSetContent(_cmEditOriginalContent);
  }
  _cmStopEdit();
  _rpFileIsEditing = false;
  _rpFileDirty = false;
  _cmEditOriginalContent = '';

  if (_rpFileCurrentMode === 'md') {
    // MD 文件：切换回渲染预览
    const mdEl = $('rpFileMd');
    const codeEl = $('rpFileCode');
    _cmDestroy();
    if (codeEl) { codeEl.innerHTML = ''; codeEl.style.display = 'none'; }
    if (mdEl) {
      mdEl.innerHTML = typeof renderMd === 'function' ? renderMd(_rpFileRawContent) : _rpFileRawContent;
      mdEl.style.display = '';
    }
  }

  _setRpFileEditButtonState(false);
}

/** 下载当前预览的文件 */
function downloadRpFile() {
  if (_rpFileCurrentPath && typeof downloadFile === 'function') {
    downloadFile(_rpFileCurrentPath);
  }
}
