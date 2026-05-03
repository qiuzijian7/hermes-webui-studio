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
    // 使用 scrollTop 赋值比 scrollTo 更可靠（避免 behavior 冲突）
    el.scrollTop = el.scrollHeight;
    _rpStickyState.sticky = true;
  };
  // 立即执行一次（若 DOM 已就绪）
  snap();
  // 多次延迟确保 DOM 渲染和布局计算完成
  requestAnimationFrame(snap);
  requestAnimationFrame(() => requestAnimationFrame(snap));
  setTimeout(snap, 50);
  setTimeout(snap, 150);
  setTimeout(snap, 300);
  setTimeout(snap, 600);
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
    _rpWindow._activeRerender = rerenderFn; // 更新回调以指向当前视图
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
let _rpView = 'empty'; // 'empty' | 'chat' | 'skill' | 'file' | 'prompt' | 'confightml' | 'params'
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
        ? `在画布上点击员工卡片，或点击顶部"PM"开始对话`
        : '点击右上角"添加员工"创建你的第一个 AI 助手';
    }
  }

  _rpView = view;
  window._rpView = view; // ★ 同步到 window
  const chatView = $('rpChatView');
  const skillView = $('rpSkillView');
  const fileView = $('rpFileView');
  const promptView = $('rpPromptView');
  const paramsView = $('rpParamsView');
  const confightmlView = $('rpConfigHtmlView');
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
    if (paramsView) paramsView.style.display = view === 'params' ? 'flex' : 'none';
    if (confightmlView) confightmlView.style.display = view === 'confightml' ? 'flex' : 'none';
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
    panel.style.minWidth = panel.style.minWidth || '200px';
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
  // PM模式已移除独立面板（PM聊天 = PM 员工聊天框）
  // 恢复头部按钮
  const btnEditPrompt = $('btnEditPrompt');
  if (btnEditPrompt) btnEditPrompt.style.display = '';
  const btnCondense = $('btnCondenseSkill');
  if (btnCondense) btnCondense.style.display = '';
  const btnSkills = $('btnEmployeeSkills');
  if (btnSkills) btnSkills.style.display = '';
  const btnConfigHtml = $('btnEmployeeConfigHtml');
  if (btnConfigHtml) btnConfigHtml.style.display = '';


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

  // 用户显式点击员工卡片 / 调用 openEmployeeChat 时：继续走员工聊天流程
  // REMOVED: 总群模式关闭逻辑 — 总群概念已移除

  // ★★★ 合并加载该员工所有委派任务的 session 消息 + 主 session 消息
  //   无论是否指定 taskId，都加载主 session + 所有已完成委派任务的 session，合并显示
  //   taskId 仅用于跳转后滚动定位，不影响数据加载逻辑
  const targetSessionId = emp.sessionId;

  _setRightPanelView('chat');

  // 更新头部信息
  const avatarEl = $('rpEmployeeAvatar');
  if (avatarEl) {
    if (emp.avatarStyle || emp.avatar) {
      // DiceBear SVG 头像（优先）
      const url = getEmployeeAvatarUrl(emp, { size: 128 });
      const fallback = esc(emp.avatar || '🤖').replace(/'/g, "\\'");
      avatarEl.innerHTML = `<div class="rp-employee-avatar rp-avatar-animated" data-status="${emp.status}"><img src="${url}" alt="" style="width:100%;height:100%;object-fit:cover;display:block;border-radius:inherit" onerror="this.parentElement.innerHTML='<span style=font-size:20px>${fallback}</span>'"></div>`;
    } else if (emp.characterImg) {
      const fb = (emp.avatar||'').replace(/'/g, "\\'");
      avatarEl.innerHTML = `<div class="rp-employee-avatar-sprite" style="background-image:url('/static/img/characters/${emp.characterImg}_frame32x32.png');background-size:300% 400%;background-position:0 0;background-repeat:no-repeat" data-fallback="${fb}" onerror="this.remove();this.parentElement.textContent='${fb}'"></div>`;
    } else {
      avatarEl.textContent = emp.avatar || '🤖';
    }
  }
  const nameEl = $('rpEmployeeName');
  if (nameEl) {
    // ★ 在员工名称旁添加"自动协作"切换按钮（开启=设为PM专员，关闭=取消PM，工作区内仅一个PM）
    const isActive = (typeof isEmpAutoCollabActive === 'function') && isEmpAutoCollabActive(emp.id);
    nameEl.innerHTML = `${esc(emp.name)}
      <button id="empAutoCollabBtn"
              class="gc-auto-orch-btn emp-auto-collab-btn${isActive ? ' active' : ''}"
              onclick="event.stopPropagation();toggleEmpAutoCollab('${esc(emp.id)}')"
              title="${isActive ? esc(emp.name) + ' 是当前PM专员（自动协作已开启）- 点击关闭' : '点击将 ' + esc(emp.name) + ' 设为PM专员并开启自动协作'}"
      >🤖💓 自动协作</button>`;
  }
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

  // ★ 同步员工模型 chip 显示
  if (typeof syncEmpModelChip === 'function') syncEmpModelChip();

  if (!targetSessionId) {
    try {
      // 传递当前工作区路径，确保新 session 的 workspace 与画布工作区一致
      let currentWs = (typeof _currentCanvasWorkspace !== 'undefined' && _currentCanvasWorkspace && _currentCanvasWorkspace !== '__default__')
        ? _currentCanvasWorkspace
        : (S.session?.workspace || '');
      // ★ 2026-05-03 防御：过滤掉疑似错误的默认 home workspace 路径
      if (currentWs && typeof _isLikelyHomeWorkspace === 'function' && _isLikelyHomeWorkspace(currentWs)) {
        console.warn('[openEmployeeChat] 过滤掉疑似默认 home workspace:', currentWs);
        currentWs = '';
      }
      const data = await api('/api/session/new', { method: 'POST', body: JSON.stringify({
        model: emp.model || $('modelSelect')?.value || '',
        workspace: currentWs || undefined,
      }) });
      // 异步完成后继续渲染（总群概念已移除，无需竞态检查）
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
      // 总群概念已移除，无需竞态检查
      if (data.session) {
        S.session = data.session;
        S.messages = data.session.messages || [];
        // ★★★ 2026-04-30 诊断日志：切换员工后后端返回的消息摘要
        try {
          const _bkSummary = (data.session.messages || []).map((m, idx) => {
            const _r = m.role || '?';
            const _hasR = !!(m.reasoning);
            const _hasTc = !!(m.tool_calls && m.tool_calls.length);
            const _tcid = m.tool_call_id ? `,tcid=${String(m.tool_call_id).slice(0, 10)}` : '';
            const _cLen = String(m.content || '').length;
            return `#${idx}:${_r}(c=${_cLen}${_hasR?',r':''}${_hasTc?`,tc=${m.tool_calls.length}`:''}${_tcid})`;
          });
          console.log('[openEmployeeChat] ★ 后端返回 messages count=', (data.session.messages||[]).length, 'summary=', _bkSummary);
        } catch(_) {}
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

    // ★ 2026-04-27 方案 C 兜底：扫描 S.messages 中所有 [PM 委派任务 #task-xxx] 前缀的
    //   user 消息，为每个 taskId 在该消息之前插入 _taskDivider 分隔符。
    //   方案 C 下 task.sessionId === emp.sessionId，所有委派消息都在主 session 里，
    //   _loadAllDelegatedTaskMessages 的 `task.sessionId !== emp.sessionId` 守卫会
    //   全部过滤掉，导致历史委派任务没有视觉分隔。这里基于消息文本补渲。
    //   ★ 同时处理 ghost task：localStorage 登记但后端 session 里找不到的任务
    //   （dispatch 失败/中断所致），前端补渲 ghost 消息，避免"点了链接啥也看不到"。
    _ensureDelegationDividersForMainSession(emp);

    // REMOVED: 总群消息合并逻辑 — 总群概念已移除，委派消息直接存储在 PM session 中
    // 不再需要从 GROUP_CHAT_STATE 合并消息

    // ★ 每次打开员工面板都重置渲染窗口，自动滚动到最新消息
    // _resetRenderWindow 设置 startIdx=-1，_renderRpMessages 内部 _computeWindowStart 会自动计算正确位置
    const _newKey = (S.session && S.session.session_id) || emp.id || '';
    _resetRenderWindow('employee', _newKey);
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

  // ★ 同步员工的 configHtml 到输出区浏览器
  //   点击员工卡片时，如果该员工有配置页面，自动在浏览器中显示
  try {
    const frame = $('outBrowserFrame');
    const empty = $('outBrowserEmpty');
    if (frame) {
      if (emp.configHtml) {
        frame.srcdoc = _injectSendToChatIntoHtml(emp.configHtml);
        frame.src = '';
        frame.classList.add('loaded');
        if (empty) empty.classList.add('hidden');
        const urlInput = $('outBrowserUrl');
        if (urlInput) urlInput.value = 'config://' + emp.id;
        // ★ 自动切换输出区到浏览器 tab，让用户直接看到 configHtml 页面
        if (typeof switchOutputTab === 'function') switchOutputTab('browser');
      } else {
        // 如果当前浏览器显示的是上一个员工的 config，清空
        if (frame.srcdoc) {
          frame.srcdoc = '';
          frame.src = 'about:blank';
          frame.classList.remove('loaded');
          if (empty) empty.classList.remove('hidden');
          const urlInput = $('outBrowserUrl');
          if (urlInput) urlInput.value = '';
        }
      }
    }
  } catch(_) {}

  // ── 如果员工正在执行总群委派的任务，显示委派消息 + 接入 SSE 流 ──
  // ★ 方案 A：从 DelegationVM 读取该员工最新的 active 任务
  //
  // ★ 2026-04-27 Bug 修复：刷新页面后 emp._activeTaskId 丢失（只在内存，不持久化），
  //   此前逻辑只看 _activeTaskId → 读不到 activeTask → 页面不补渲"正在执行的任务"
  //   信息，用户刷新后看到的是"空白的聊天框"，直到任务结束才出现结果。
  //
  //   修复策略：
  //   1) 优先 emp._activeTaskId（内存路径，最准确，用于非刷新场景）
  //   2) 退化到 DelegationVM.running 查该员工 running Job（内存里有就用）
  //   3) 再退化到 DelegationVM 持久化映射 _loadPersistedMap → 找 empId 匹配
  //      且 status in [pending,running] 的 task → 用 _restorePersistedTask
  //      恢复到内存 Map，再走后续逻辑
  let activeTask = null;
  if (typeof DelegationVM !== 'undefined') {
    // 路径 1：内存 _activeTaskId
    if (emp._activeTaskId) {
      activeTask = DelegationVM.getTask(emp._activeTaskId);
      console.log('[openEmployeeChat] 路径1: emp._activeTaskId=', emp._activeTaskId, '→ task=', activeTask ? {id:activeTask.id, status:activeTask.status, streamId:activeTask.streamId} : null);
    }
    // 路径 2：DelegationVM.running 里该员工的 Job
    if (!activeTask || !['pending', 'running'].includes(activeTask.status)) {
      const runJob = DelegationVM.getRunningJob(emp.id);
      console.log('[openEmployeeChat] 路径2: runJob=', runJob ? {id:runJob.id, taskStatus:runJob.task?.status} : null);
      if (runJob && runJob.task && ['pending', 'running'].includes(runJob.task.status)) {
        activeTask = runJob.task;
      }
    }
    // 路径 3：localStorage 持久化映射（刷新后唯一信息源）
    if (!activeTask || !['pending', 'running'].includes(activeTask.status)) {
      try {
        const persistMap = (typeof _loadDelegationPersistMap === 'function')
          ? _loadDelegationPersistMap()
          : null;
        if (persistMap && typeof persistMap === 'object') {
          let bestTid = null;
          let bestTs = -1;
          const candidates = [];
          for (const [tid, meta] of Object.entries(persistMap)) {
            if (!meta || meta.empId !== emp.id) continue;
            if (!['pending', 'running'].includes(meta.status || '')) continue;
            candidates.push({tid, status: meta.status, createdAt: meta.createdAt});
            // 取 createdAt 最大的一条（若缺失则用 tid 字典序兜底）
            const ts = Number(meta.createdAt || 0);
            if (ts > bestTs) {
              bestTs = ts;
              bestTid = tid;
            } else if (bestTid === null) {
              bestTid = tid;
            }
          }
          console.log('[openEmployeeChat] 路径3: persistMap candidates=', candidates, 'bestTid=', bestTid);
          if (bestTid && typeof DelegationVM._restorePersistedTask === 'function') {
            const restored = DelegationVM._restorePersistedTask(bestTid);
            if (restored) {
              activeTask = restored;
              // 记到 emp 上，便于后续 UI 逻辑沿用既有路径
              emp._activeTaskId = bestTid;
              console.log('[openEmployeeChat] 刷新后从持久化映射恢复 active 任务:', bestTid);
            }
          }
        }
      } catch (e) {
        console.warn('[openEmployeeChat] 恢复 activeTask 失败', e);
      }
    }
  }
  console.log('[openEmployeeChat] activeTask 最终结果:', activeTask ? {id:activeTask.id, status:activeTask.status, streamId:activeTask.streamId, taskContent:!!activeTask.taskContent} : null,
    'S.messages.length=', S.messages?.length, 'emp._activeTaskId=', emp._activeTaskId);

  if (activeTask && (activeTask.status === 'pending' || activeTask.status === 'running')) {
    // ★ 顺序：先 push 任务 user 消息，再 push divider（divider 显示在任务消息之后）
    const taskPrefix = `[PM 委派任务 #${activeTask.id}]`;
    const hasDivider = S.messages.some(m =>
      m._taskDivider && m._taskId === activeTask.id
    );
    // 先追加任务 user 消息（如果 session 消息中还没有）
    const hasTaskMsg = S.messages.some(m =>
      m.role === 'user' && String(m.content || '').includes(taskPrefix)
    );
    if (!hasTaskMsg && activeTask.taskContent) {
      const taskMsg = { role: 'user', content: activeTask.taskContent, _ts: Date.now() / 1000, _taskId: activeTask.id };
      S.messages.push(taskMsg);
      console.log('[openEmployeeChat] 已手动追加 taskContent user 消息 for', activeTask.id);
    }
    // 再追加 divider（如果还没有）
    if (!hasDivider) {
      const activeLabelRaw = activeTask.taskContent
        ? activeTask.taskContent.replace(/^\[PM 委派任务 #[^\]]+\]\s*/, '').split('\n').find(l => l.trim() && !l.startsWith('---') && !l.startsWith('⚠️')) || ''
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
      console.log('[openEmployeeChat] 已添加 _taskDivider for', activeTask.id);
    }
    console.log('[openEmployeeChat] 渲染 active 任务, streamId=', activeTask.streamId, hasDivider ? '(divider已存在)' : '(新增divider)', hasTaskMsg ? '(taskMsg已存在)' : '(新增taskMsg)');
    _renderRpMessages();
    // 有真实 streamId → 直接接入；还在 pending → 显示占位并轮询
    if (activeTask.streamId) {
      console.log('[openEmployeeChat] 接入 SSE 流, streamId=', activeTask.streamId);
      _attachLiveStreamToChat(emp, activeTask);
    } else {
      console.log('[openEmployeeChat] 显示 Thinking 占位（streamId 尚未就绪）');
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
  // ★ 更新顶栏 Knot 工作区标记
  if (typeof updateKnotBadge === 'function') updateKnotBadge(ws);
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

  // ★★★ 2026-04-30 修复: 外部任务消息应"前置"到 S.messages，而不是追加
  //     理由: 外部任务代表更早的历史（独立 session），主 session 是当前"活跃"数据。
  //     如果追加到末尾，渲染窗口 slice(-30) 会落到外部任务尾部，
  //     丢失主 session 尾部的思考/工具卡 —— 这正是"切换员工后再切回，
  //     思考过程和工具调用消失"的根因。
  //     同时也与 _mergeDoneSessionPreservingForeignTasks (foreignMsgs 前置)
  //     保持一致的顺序语义。
  const _foreignBlock = [];  // 收集所有外部任务消息（暂存，最后统一前置）
  for (const task of loadableTasks) {
    try {
      const data = await api(`/api/session?session_id=${encodeURIComponent(task.sessionId)}`);
      if (!data.session || !data.session.messages) continue;

      const taskMsgs = data.session.messages;
      // 检查 S.messages 或 _foreignBlock 是否已有该任务的消息（避免重复）
      const taskPrefix = `[PM 委派任务 #${task.id}]`;
      const _hasInMain = S.messages.some(m =>
        m.role === 'user' && String(m.content || '').includes(taskPrefix)
      );
      const _hasInForeign = _foreignBlock.some(m =>
        m.role === 'user' && String(m.content || '').includes(taskPrefix)
      );
      if (_hasInMain || _hasInForeign) continue;

      // ★ 顺序：先 push [PM 委派任务 #xxx] user 消息，再 push divider，最后 push 其他消息
      //   最终顺序：[PM 委派任务 ...] user → 📋 委派任务 divider → assistant/tool 消息
      const taskLabelRaw = task.taskContent
        ? task.taskContent.replace(/^\[PM 委派任务 #[^\]]+\]\s*/, '').split('\n').find(l => l.trim() && !l.startsWith('---') && !l.startsWith('⚠️')) || ''
        : '';
      const taskLabelShort = taskLabelRaw.length > 60 ? taskLabelRaw.slice(0, 60) + '…' : taskLabelRaw;

      // 先把 [PM 委派任务 #xxx] 开头的 user 消息挑出来 push 在前
      const otherMsgs = [];
      for (const m of taskMsgs) {
        if (m.role === 'system') continue;  // 跳过 system 消息
        const _c = typeof m.content === 'string' ? m.content : '';
        if (m.role === 'user' && _c.startsWith(`[PM 委派任务 #${task.id}]`)) {
          // 防御重复
          const _mc = _c.trim();
          const _mr = String(m.reasoning || '').trim();
          const _exists = _foreignBlock.some(sm =>
            sm._taskId === task.id && sm.role === m.role &&
            String(sm.content || '').trim() === _mc &&
            String(sm.reasoning || '').trim() === _mr
          );
          if (!_exists) _foreignBlock.push({ ...m, _taskId: task.id });
        } else {
          otherMsgs.push(m);
        }
      }
      // 然后 push divider
      _foreignBlock.push({
        role: 'system',
        content: `📋 委派任务 #${task.id}`,
        _taskDivider: true,
        _taskId: task.id,
        _taskStatus: task.status,
        _taskLabel: taskLabelShort,
        _ts: task.createdAt / 1000,
      });

      // 最后 push 其他（assistant / tool）消息
      for (const m of otherMsgs) {
        // 防御重复：同一批 _foreignBlock 内同 _taskId+content+reasoning 去重
        const _mc = String(m.content || '').trim();
        const _mr = String(m.reasoning || '').trim();
        const _exists = _foreignBlock.some(sm =>
          sm._taskId === task.id &&
          sm.role === m.role &&
          String(sm.content || '').trim() === _mc &&
          String(sm.reasoning || '').trim() === _mr
        );
        if (_exists) continue;
        // 为消息打上 _taskId 标记，便于渲染时关联
        _foreignBlock.push({ ...m, _taskId: task.id });
      }
    } catch (e) {
      console.warn('[openEmployeeChat] 加载委派任务 session 失败:', task.id, e);
    }
  }

  // ★ 将外部任务消息统一前置到 S.messages（主 session 保持在末尾）
  if (_foreignBlock.length > 0) {
    console.log('[_loadAllDelegatedTaskMessages] 前置', _foreignBlock.length, '条外部任务消息到 S.messages 头部');
    S.messages = _foreignBlock.concat(S.messages);
  }
}

/**
 * ★ 2026-04-27 方案 C 兜底：扫描 S.messages 中所有带 "[PM 委派任务 #task-xxx]"
 * 前缀的 user 消息，为每一个 taskId（且尚未插入 divider 的）在该消息之前插入
 * 一条 _taskDivider 分隔消息。
 *
 * 背景：方案 C 下 task.sessionId === emp.sessionId，所有委派消息都累积到员工
 * 主 session。_loadAllDelegatedTaskMessages 的 `task.sessionId !== emp.sessionId`
 * 守卫会把方案 C 下所有任务都过滤掉（它原本是为独立 task session 设计的），
 * 结果就是：openEmployeeChat 打开聊天后，只看到 user 原始委派消息与 assistant
 * 回复交错的"平铺消息流"，视觉上分不清一段任务的边界 / 结果属于哪个任务 / 点击
 * 跳转锚点也找不到分隔符。
 *
 * 策略：不改原有函数（保留它对"独立 session"路径的处理），在主 session 消息
 * 加载后单独做一次"基于文本的"分隔符兜底补渲：
 *   1. 遍历 S.messages，匹配 role=user 且 content 以 "[PM 委派任务 #task-xxx]"
 *      开头的消息，抽出 taskId；
 *   2. 若 S.messages 中尚无 _taskDivider && _taskId===taskId，则构造一条
 *      divider 消息并插入到该 user 消息之前；
 *   3. taskStatus 优先从 DelegationVM（内存 Map 或持久化映射）读取真实状态，
 *      否则默认 'done'（过去消息的默认语义）。
 *
 * 因为在 _renderRpMessages 之前调用，_renderRpMessages 的 dedupe 也只按
 *   role+_taskId+content+reasoning 键合并，新插入的 divider 不会被误去重。
 */
/**
 * ★ 2026-04-27 方案 C 兜底：为方案 C 下（task.sessionId===emp.sessionId）的
 * 委派任务补渲"分隔符"，并处理 ghost task（任务登记在 localStorage 但后端
 * session 里找不到对应的 "[PM 委派任务 #xxx] ..." 用户消息）。
 *
 * 背景：
 *   A) 方案 C 下，_loadAllDelegatedTaskMessages 的 `task.sessionId !== emp.sessionId`
 *      守卫会把方案 C 下所有任务都过滤掉（它原本是为独立 task session 设计的），
 *      结果就是：openEmployeeChat 打开聊天后，只看到 user 原始委派消息与 assistant
 *      回复交错的"平铺消息流"，视觉上分不清一段任务的边界。
 *   B) 更严重：总群 @ 员工时后端先创建 group-chat 系统消息 "已将任务 [#xxx] 委派给
 *      @Name"，然后前端调 _dispatchTaskToEmployee。若 _startDelegatedJob 失败
 *      （agent 抛异常、网络中断、窗口在 await 过程中被刷新），任务的 fullTaskMsg
 *      就永远不会被 `/api/chat/start` 写进员工 session → 用户点击总群的任务
 *      链接跳到员工聊天，**什么都看不到**，以为系统"吞"了任务。
 *
 * 策略（两阶段）：
 *   Phase 1：扫描 S.messages，为所有带 "[PM 委派任务 #task-xxx]" 前缀的 user
 *            消息补插 _taskDivider（taskStatus 从 DelegationVM/持久化映射读）。
 *   Phase 2：遍历 localStorage 持久化映射，找该员工的 task；若 Phase 1 没覆盖
 *            到（即 S.messages 里没有该任务的用户消息），则前端主动追加一条
 *            ghost 用户消息 + divider（状态按持久化读），并在 divider 上打
 *            `_taskGhost=true` 标记以便渲染层显示警示文案（\"任务登记但未送达，
 *            可能后端未收到 → 建议重试\"）。
 *
 * 参数：
 *   @param {object} [emp] 当前员工对象；用于 Phase 2 过滤该员工的任务。
 *                         不传时跳过 Phase 2（保持向后兼容）。
 */
/**
 * ★ 2026-04-30 修复：done 事件"历史任务消息丢失"bug
 *
 * 背景：员工主 session（emp.sessionId）上跑完一个委派任务 done 后，
 *   后端返回的 doneSession.messages 只包含主 session 的消息。
 *   但打开员工聊天框时，`_loadDelegationTaskMessages` 可能已经把
 *   "其他独立 session（task.sessionId !== emp.sessionId）的历史任务消息"
 *   注入到 S.messages（带 _taskId = 其他 tid 标记）。
 *   若直接 S.messages = doneSession.messages 会把这些历史数据冲掉，
 *   用户会看到"思考过程和工具调用都消失"。
 *
 * 策略：从旧 S.messages 中提取所有"外部任务"消息（_taskId 存在 且 != currentTaskId
 *   且 taskId 不是 task-xxx 格式（说明是独立 session 加载来的历史），或 _taskId
 *   在 doneSession.messages 中找不到对应消息且不是 currentTaskId）；
 *   以 doneSession.messages 为主干，将这些外部任务消息按原顺序插入合适位置。
 *
 * 为了简洁和鲁棒，本实现采用"分组合并"：
 *   1) 把旧 S.messages 按"连续 _taskId 块"和"主干消息"分段
 *   2) 主干以 doneSession.messages 替换
 *   3) 外部任务块按其原始相对位置（相对于下一个主干 anchor）恢复到新数组
 *
 * 为了最小风险，这里用更简单的做法：
 *   - foreignChunks = 旧 S.messages 中 _taskId 存在 且 _taskId != currentTaskId
 *     且该 _taskId 的消息在 doneSession.messages 中不存在（按 _taskId 归属判断）
 *   - 将 foreignChunks 追加到 doneSession.messages 之前（放到历史区），
 *     由 _ensureDelegationDividersForMainSession 随后按 [PM 委派任务 #xxx] 前缀
 *     补 divider。
 *
 * @param {Array} newMsgs     后端返回的 session.messages
 * @param {string} currentTaskId  本次 done 的委派任务 id（task-xxx）
 * @returns {Array} 合并后的新 S.messages
 */
function _mergeDoneSessionPreservingForeignTasks(newMsgs, currentTaskId) {
  try {
    if (!Array.isArray(newMsgs)) return Array.isArray(S.messages) ? S.messages : [];
    const oldMsgs = Array.isArray(S.messages) ? S.messages : [];
    if (oldMsgs.length === 0) return newMsgs.slice();

    // 1) 收集 newMsgs 中出现过的 _taskId（仅 task-xxx 格式；无标记的视为主干）
    //    以及通过消息内容前缀 [PM 委派任务 #task-xxx] 推断出的 taskId
    const newTaskIds = new Set();
    for (const m of newMsgs) {
      if (!m) continue;
      if (m._taskId) newTaskIds.add(m._taskId);
      const c = typeof m.content === 'string' ? m.content : '';
      const mm = c.match(/^\[PM 委派任务 #(task-[A-Za-z0-9_-]+)\]/);
      if (mm) newTaskIds.add(mm[1]);
    }

    // 2) 从 oldMsgs 提取"外部任务消息"：
    //    - 有 _taskId
    //    - _taskId !== currentTaskId
    //    - _taskId 不出现在 newTaskIds（即后端主 session 里没有，属于独立 session 加载的历史数据）
    //    - 排除 _delegationLive/_delegationTool 这类临时占位（避免把已结束的 live 旧态复活）
    //    ★ 注意：_taskDivider 消息（divider）必须保留，否则 _ensureDelegationDividers 会重复插入
    const foreignMsgs = [];
    for (const m of oldMsgs) {
      if (!m) continue;
      // ★ 保留 divider 消息（_taskDivider: true），不依赖 _taskId 过滤
      if (m._taskDivider && m._taskId) {
        foreignMsgs.push(m);
        continue;
      }
      if (!m._taskId) continue;
      if (m._taskId === currentTaskId) continue;
      if (newTaskIds.has(m._taskId)) continue;
      // 跳过 live 占位（会在下一轮任务中重建）
      if (m._delegationLive) continue;
      foreignMsgs.push(m);
    }

    if (foreignMsgs.length === 0) {
      return newMsgs.slice();
    }

    console.log('[_mergeDoneSession] 保留', foreignMsgs.length, '条外部任务消息（独立 session 历史），currentTaskId=', currentTaskId);
    // 3) 将外部任务消息前置（它们代表更早的历史），主 session 消息紧随其后
    //    _ensureDelegationDividersForMainSession 会按 [PM 委派任务 #xxx] 前缀补 divider
    return foreignMsgs.concat(newMsgs);
  } catch (err) {
    console.warn('[_mergeDoneSession] 合并失败，回退到直接替换:', err);
    return Array.isArray(newMsgs) ? newMsgs.slice() : (S.messages || []);
  }
}

function _ensureDelegationDividersForMainSession(emp) {
  if (typeof S === 'undefined' || !Array.isArray(S.messages)) return;
  console.log('[_ensureDelegationDividers] 开始, emp=', emp?.name, 'S.messages.length=', S.messages.length);
  const persistMap = (typeof _loadDelegationPersistMap === 'function') ? _loadDelegationPersistMap() : {};
  // 先收集现有 divider 的 taskId 集合，避免重复插入
  const existingDividerIds = new Set();
  for (const m of S.messages) {
    if (m && m._taskDivider && m._taskId) existingDividerIds.add(m._taskId);
  }
  // ── Phase 1：基于 S.messages 中已存在的 user 消息补插 divider ──
  // 同时记录每个 taskId 已在 S.messages 里出现过 → Phase 2 可据此判断"ghost"
  const seenTaskIdsInMessages = new Set();
  const inserts = []; // [{ idx, divider }]
  for (let i = 0; i < S.messages.length; i++) {
    const m = S.messages[i];
    if (!m || m.role !== 'user') continue;
    const content = typeof m.content === 'string' ? m.content : '';
    if (!content.startsWith('[PM 委派任务')) continue;
    const match = content.match(/^\[PM 委派任务 #(task-[A-Za-z0-9_-]+)\]/);
    if (!match) continue;
    const taskId = match[1];
    seenTaskIdsInMessages.add(taskId);
    // ★ 推断任务状态：优先内存 Map → 持久化映射 → 默认 done
    //   （必须在 continue 之前执行，否则已存在 divider 拿不到最新 status）
    let status = 'done';
    try {
      if (typeof DelegationVM !== 'undefined') {
        const t = DelegationVM.getTask ? DelegationVM.getTask(taskId) : null;
        if (t && t.status) status = t.status;
        else if (persistMap[taskId] && persistMap[taskId].status) status = persistMap[taskId].status;
      } else if (persistMap[taskId] && persistMap[taskId].status) {
        status = persistMap[taskId].status;
      }
    } catch (_) {}
    // ★ 修复：已存在的 divider 也要更新状态（任务完成后 status 会从 running→done）
    if (existingDividerIds.has(taskId)) {
      // 查找并更新已有 divider 的状态
      for (const m of S.messages) {
        if (m && m._taskDivider && m._taskId === taskId) {
          if (m._taskStatus !== status) {
            console.log('[_ensureDelegationDividers] 更新 divider 状态:', taskId, m._taskStatus, '→', status);
            m._taskStatus = status;
          }
          break;
        }
      }
      continue;
    }
    existingDividerIds.add(taskId);  // 防御同一 taskId 多次出现
    // 抽任务短标签：去掉前缀行 + 跳过空行/样板行，取首条有效内容
    const labelRaw = content
      .replace(/^\[PM 委派任务 #[^\]]+\]\s*/, '')
      .split('\n')
      .find(l => l.trim() && !l.startsWith('---') && !l.startsWith('⚠️')) || '';
    const labelShort = labelRaw.length > 60 ? labelRaw.slice(0, 60) + '…' : labelRaw;
    // 为该 user 消息打上 _taskId（若尚未有），便于渲染阶段定位
    if (!m._taskId) m._taskId = taskId;
    // ★ 2026-05-01 修复：divider 的 _ts 必须严格继承对应 user 消息的时间戳（含 timestamp 兼容），
    //   并加一个极小 epsilon 确保排序时紧跟 user 消息（_renderRpMessages 按 _ts 排序）。
    //   否则 user 消息只有 timestamp 而无 _ts 时，divider 会 fallback 到 Date.now()/1000，
    //   导致所有历史 divider 聚集到消息末尾（14 条 divider 堆积的根因）。
    const _userTs = Number(m._ts) || Number(m.timestamp) || (Date.now() / 1000);
    const divider = {
      role: 'system',
      content: `📋 委派任务 #${taskId}`,
      _taskDivider: true,
      _taskId: taskId,
      _taskStatus: status,
      _taskLabel: labelShort,
      _ts: _userTs + 0.001,
    };
    inserts.push({ idx: i, divider });
  }
  // 逆序插入保持原索引有效
  // ★ divider 插在任务 user 消息**之后**（idx+1），
  //   顺序为：你的原话 → [PM 委派任务 #xxx] 消息 → 📋 委派任务(状态)
  for (let k = inserts.length - 1; k >= 0; k--) {
    const { idx, divider } = inserts[k];
    S.messages.splice(idx + 1, 0, divider);
  }
  if (inserts.length > 0) {
    console.log('[_ensureDelegationDividers] Phase 1 插入', inserts.length, '条 divider, taskIds=', inserts.map(i=>i.divider._taskId));
  }

  // ── Phase 2：ghost 任务补渲 ──
  // 遍历 localStorage 持久化映射，找该员工的 task；若 Phase 1 没覆盖到（即
  // S.messages 里没有该任务的用户消息，后端 session 也没写入），则追加一条
  // ghost user 消息 + divider，避免用户点击总群任务链接后看到"空"聊天框。
  if (!emp || !emp.id) return;
  // 按 createdAt 升序排列，确保 ghost 消息追加顺序与时间一致
  const ghostCandidates = [];
  for (const [tid, meta] of Object.entries(persistMap)) {
    if (!meta || meta.empId !== emp.id) continue;
    if (seenTaskIdsInMessages.has(tid)) continue;  // Phase 1 已处理，跳过
    if (existingDividerIds.has(tid)) continue;      // 已有 divider，跳过
    // 只补渲有 taskContent 的 ghost（没有的话啥都没法显示）
    if (!meta.taskContent) continue;
    // ★ 2026-04-28：跳过 pending/running 状态的任务——这些任务的消息/分隔符
    //   由 openEmployeeChat 的 activeTask 代码块来补渲（它会手动 push taskContent
    //   + divider + 接入 SSE/显示占位）。若 Phase 2 也把它们当 ghost 补渲，
    //   会导致：① divider 被错标为 _taskGhost 显示 "⚠ 未送达"；② 消息重复。
    if (meta.status === 'pending' || meta.status === 'running') continue;
    ghostCandidates.push({ tid, meta });
  }
  ghostCandidates.sort((a, b) => Number(a.meta.createdAt || 0) - Number(b.meta.createdAt || 0));
  if (ghostCandidates.length > 0) {
    console.log('[_ensureDelegationDividers] Phase 2 ghost 候选:', ghostCandidates.map(g => ({tid:g.tid, status:g.meta.status, empName:g.meta.empName})));
  }
  for (const { tid, meta } of ghostCandidates) {
    const status = meta.status || 'error';
    const taskContent = meta.taskContent || '';
    // 抽短标签
    const labelRaw = taskContent
      .replace(/^\[PM 委派任务 #[^\]]+\]\s*/, '')
      .split('\n')
      .find(l => l.trim() && !l.startsWith('---') && !l.startsWith('⚠️')) || '';
    const labelShort = labelRaw.length > 60 ? labelRaw.slice(0, 60) + '…' : labelRaw;
    // ★ 先追加 ghost user 消息（任务原话），再追加 ghost divider（带 _taskGhost 标记），
    //   顺序为：[PM 委派任务 #xxx] 消息 → 📋 委派任务(状态)
    // ★ 2026-05-01 修复：divider _ts 需 +epsilon，确保按时间戳排序时紧跟 user 消息之后
    const _ghostTs = Number(meta.createdAt || Date.now()) / 1000;
    S.messages.push({
      role: 'user',
      content: taskContent,
      _taskId: tid,
      _taskGhost: true,
      _ts: _ghostTs,
    });
    S.messages.push({
      role: 'system',
      content: `📋 委派任务 #${tid}`,
      _taskDivider: true,
      _taskId: tid,
      _taskStatus: status,
      _taskLabel: labelShort,
      _taskGhost: true,
      _ts: _ghostTs + 0.001,
    });
    existingDividerIds.add(tid);
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
  //
  // ★ 2026-04-27 方案 C Bug 修复：移除 task.sessionId !== emp.sessionId 守卫。
  //   该守卫原本是防止"task session == 主 session"时的重复轮询——但方案 C
  //   下两者本来就相等，守卫会让轮询完全不启动，导致刷新页面后"正在执行的
  //   任务内容"永远不会被补渲到聊天框里。
  //
  //   现在的安全保障在于 line 795-801 已经用 "role + content + reasoning" 三元组
  //   对 S.messages 做去重 push，轮询多次拉取同一条消息不会导致 UI 重复显示。
  const runningTasks = [];
  const seen = new Set();
  for (const task of DelegationVM.tasks.values()) {
    if (task.empId === emp.id && task.sessionId
        && (task.status === 'running' || task.status === 'pending')) {
      runningTasks.push({id: task.id, sessionId: task.sessionId, status: task.status});
      seen.add(task.id);
    }
  }
  if (typeof _loadDelegationPersistMap === 'function') {
    const persistMap = _loadDelegationPersistMap();
    for (const [tid, meta] of Object.entries(persistMap)) {
      if (seen.has(tid)) continue;
      if (meta.empId === emp.id && meta.sessionId
          && (meta.status === 'running' || meta.status === 'pending')) {
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
    const taskPrefix = `[PM 委派任务 #${rt.id}]`;

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

        // ★ 2026-04-27 方案 C Bug 修复：dedupe 比较不再按 _taskId（该字段在
        //   主 session 消息上本就没有，老逻辑导致永远匹配不到 → 重复 push）。
        //   改为按 role + content + reasoning 三元组全局匹配。
        //   同时去掉强行 {..., _taskId: rt.id}，保持主 session 消息的归属中立
        //   （多个任务交错时不会被误打上单一 task 标签）。
        let added = 0;
        for (const m of msgs) {
          if (m.role === 'system') continue;
          const _mc = String(m.content || '').trim();
          const _mr = String(m.reasoning || '').trim();
          if (!_mc && !_mr) continue;
          const _exists = S.messages.some(sm =>
            sm.role === m.role
            && String(sm.content || '').trim() === _mc
            && String(sm.reasoning || '').trim() === _mr
          );
          if (_exists) continue;
          S.messages.push({ ...m });
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
  // ★ 2026-04-27：把 timer 挂到 task 上，供 openGroupChat 切换时主动 clearInterval，
  //   避免用户在 streamId 返回前频繁切换总群↔员工导致多条 poll 泄漏 30s。
  //   开新 poll 前先关旧 poll（同一 task 多次打开占位的情况）。
  if (task._placeholderPollTimer) {
    try { clearInterval(task._placeholderPollTimer); } catch (_) {}
    task._placeholderPollTimer = null;
  }
  let _pollCount = 0;
  const _pollTimer = setInterval(() => {
    _pollCount++;
    if (_pollCount > 60) {  // 最多轮询 30 秒
      clearInterval(_pollTimer);
      if (task._placeholderPollTimer === _pollTimer) task._placeholderPollTimer = null;
      return;
    }
    // 任务已取消或结束：停止轮询
    if (task.status === 'cancelled' || task.status === 'done' || task.status === 'error') {
      clearInterval(_pollTimer);
      if (task._placeholderPollTimer === _pollTimer) task._placeholderPollTimer = null;
      return;
    }
    if (task.streamId) {
      clearInterval(_pollTimer);
      if (task._placeholderPollTimer === _pollTimer) task._placeholderPollTimer = null;
      _attachLiveStreamToChat(emp, task);
    }
  }, 500);
  task._placeholderPollTimer = _pollTimer;
}

/**
 * 固化 live stream 的 DOM 元素（降级路径，当后端 session 刷新失败时使用）。
 * 将思考段折叠、活动文本段渲染最终内容、移除临时 ID。
 */
function _solidifyLiveElements(liveRow, assistantText) {
  const liveBody = document.getElementById('rpLiveStreamBody');
  const seg = document.getElementById('rpLiveTurnSegments');

  // 固化思考段（去掉 live 标记，折叠）
  if (seg) {
    const thinkCard = seg.querySelector('.rp-live-thinking-card');
    if (thinkCard) thinkCard.classList.remove('open', 'rp-live-thinking-card');
  }

  // ★ _isEmptyLike：某些 provider 在 tool_calls 前返回 content="{}" / "{" / "}" 等，
  //   不应渲染为可见文本（否则在工具卡片间显示空大括号）
  const _isEmptyLike = t => {
    if (!t) return true;
    const s = String(t).trim();
    if (!s) return true;
    if (/^[\s{}\[\]""]+$/.test(s)) return true;
    return false;
  };
  const _stripEmptyLike = t => {
    let s = String(t).trim();
    if (/^[\s{}\[\]""]+$/.test(s)) return '';
    return s;
  };

  if (liveBody) {
    const rawDisplayText = typeof _stripThinkingTags === 'function'
      ? _stripThinkingTags(assistantText.trim())
      : assistantText.trim();
    const displayText = _stripEmptyLike(rawDisplayText);
    if (displayText && !_isEmptyLike(displayText)) {
      liveBody.innerHTML = renderMd(displayText);
      liveBody.removeAttribute('id');
    } else {
      const hasThinking = /<think[\s\S]*?<\/think>/.test(assistantText);
      if (hasThinking) {
        let thinkContent = '';
        const thinkMatch = assistantText.match(/<think([\s\S]*?)<\/think>/);
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
    liveRow.removeAttribute('id');
    const innerSeg = liveRow.querySelector('#rpLiveTurnSegments');
    if (innerSeg) innerSeg.removeAttribute('id');
  }
}

/**
 * 当用户从总群跳转到正在执行任务的员工聊天框时，
 * 接入已有的 SSE 流实时渲染 token 输出。
 * 方案 A：基于 task 对象，状态隔离
 */
function _attachLiveStreamToChat(emp, task) {
  const capturedEmpId = emp && emp.id;
  const capturedEmpName = emp && emp.name;
  console.log('[_attachLiveStreamToChat] 开始, emp=', capturedEmpName, 'empId=', capturedEmpId, 'taskId=', task?.id, 'streamId=', task?.streamId, 'status=', task?.status);
  if (!task || !task.streamId) return;
  const streamId = task.streamId;
  const capturedTaskId = task.id;

  // 接管 SSE 流时，停止该员工的后台轮询——轮询每 2s 调 _renderRpMessages()
  //   会清空 inner.innerHTML 再从 S.messages 重绘，但 SSE 流的实时内容不在
  //   S.messages 中，导致制作人聊天框"所有内容消失"。
  if (typeof _stopDelegatedRunningTaskPolling === 'function') {
    try { _stopDelegatedRunningTaskPolling(emp.id); } catch(_) {}
  }

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

  // ★ 新增：SSE连接建立后，立即设置员工状态为 'thinking'
  if (typeof setEmployeeStatus === 'function' && emp && emp.id) {
    setEmployeeStatus(emp.id, 'thinking');
  }

  // 连接 SSE 流
  const source = new EventSource(
    new URL(`/api/chat/stream?stream_id=${encodeURIComponent(streamId)}`, location.origin).href,
    { withCredentials: true }
  );
  // ★ 2026-04-27 Bug 修复：把 SSE 句柄挂到 task 上，供 openGroupChat 在切换
  //   到总群视图时主动关闭——否则该 SSE 会在后台继续消费 done 事件，
  //   把 task.status 置为 done、清空 emp._activeTaskId，
  //   导致用户切回员工聊天时看不到"正在执行"的任务信息。
  //   关闭前打标 _intentionallyClosed，error 处理器据此忽略关闭信号，
  //   避免误把正常切换识别为连接故障。
  try {
    if (task._chatSseSource && task._chatSseSource !== source) {
      task._chatSseSource._intentionallyClosed = true;
      try { task._chatSseSource.close(); } catch(_) {}
    }
  } catch(_) {}
  task._chatSseSource = source;
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

  // ★ AG-UI 精细化状态
  let _rpThinkingActive = false;  // thinking_start → true, thinking_end → false
  let _rpCurrentStep = '';         // step_started 设置, step_finished 清空

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
      if (task._chatSseSource === source) task._chatSseSource = null;
      // ★ 仅当任务仍在进行中时才更新状态
      if (task.status === 'pending' || task.status === 'running') {
        task.status = 'done';
        if (typeof DelegationVM !== 'undefined' && DelegationVM._persistTask) DelegationVM._persistTask(task);
        if (emp._activeTaskId === task.id) {
          emp._activeTaskId = null;
          if (typeof setEmployeeStatus === 'function') setEmployeeStatus(emp.id, 'idle');
        }
      }

      // ★ 方案 C 修复（v2）：同 done 事件逻辑，从后端刷新 S.messages
      //   超时路径无 SSE event data，只能走 /api/session + 兜底固化
      const _sid = (task && task.sessionId) || emp.sessionId;
      const liveRow = $('rpLiveTurnRow');
      let _timeoutRefreshed = false;
      if (_sid && S.session && S.session.session_id === _sid) {
        try {
          const sessData = await api(`/api/session?session_id=${encodeURIComponent(_sid)}`);
          // ★★★ 修复：检查 messages 非空，防止清空已有消息
          if (sessData && sessData.session && sessData.session.messages && sessData.session.messages.length > 0) {
            S.session = sessData.session;
            // ★ 2026-04-30 修复：合并保留外部任务消息
            S.messages = _mergeDoneSessionPreservingForeignTasks(sessData.session.messages, capturedTaskId);
            if (typeof _ensureDelegationDividersForMainSession === 'function') {
              _ensureDelegationDividersForMainSession(emp);
            }
            if (liveRow) liveRow.remove();
            if (typeof _renderRpMessages === 'function') _renderRpMessages();
            if (typeof _scrollMsgAreaToBottom === 'function') _scrollMsgAreaToBottom();
            _timeoutRefreshed = true;
          }
        } catch(e) {
          console.warn('[超时轮询] /api/session 失败:', e);
        }
      }
      if (!_timeoutRefreshed) {
        _solidifyLiveElements(liveRow, assistantText);
        // ★ 兜底：将积累文本写入 S.messages
        const _tpfx = `[PM 委派任务 #${capturedTaskId}]`;
        const _hasAsst = S.messages.some(m => m.role === 'assistant' && m._taskId === capturedTaskId);
        if (!_hasAsst && assistantText.trim()) {
          const _dt = typeof _stripThinkingTags === 'function'
            ? _stripThinkingTags(assistantText.trim()) : assistantText.trim();
          if (_dt) {
            S.messages.push({ role: 'assistant', content: _dt, _ts: Date.now() / 1000, _taskId: capturedTaskId });
            if (typeof _renderRpMessages === 'function') _renderRpMessages();
            if (typeof _scrollMsgAreaToBottom === 'function') _scrollMsgAreaToBottom();
          }
        }
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
          // ★ AG-UI thinking_start/end 控制动画
          if (_rpThinkingActive) thinkCard.classList.add('thinking-active');
          thinkCard.innerHTML = `<div class="thinking-card-header" onclick="this.parentElement.classList.toggle('open')"><span class="thinking-card-icon">${typeof li === 'function' ? li('lightbulb', 14) : '💡'}</span><span class="thinking-card-label">思考过程</span><span class="thinking-card-toggle">${typeof li === 'function' ? li('chevron-right', 12) : '▶'}</span></div><div class="thinking-card-body"></div>`;
          const firstChild = segments.firstChild;
          if (firstChild) segments.insertBefore(thinkCard, firstChild);
          else segments.appendChild(thinkCard);
        }
        // ★ 根据 _rpThinkingActive 控制思考卡片动画
        if (_rpThinkingActive) thinkCard.classList.add('thinking-active');
        else thinkCard.classList.remove('thinking-active');
        const body = thinkCard.querySelector('.thinking-card-body');
        if (body) body.innerHTML = renderMd(thinking);
      } else if (thinkCard && text) {
        // 思考已结束且文本出现了 → 折叠思考卡片
        thinkCard.classList.remove('open', 'rp-live-thinking-card', 'thinking-active');
      }

      // 文本段
      // ★ _isEmptyLike：某些 provider 在 tool_calls 前返回 content="{}" / "{" / "}" 等，
      //   不应渲染为可见文本（否则在工具卡片间显示空大括号）
      const _isEmptyLike = t => {
        if (!t) return true;
        const s = String(t).trim();
        if (!s) return true;
        if (/^[\s{}\[\]""]+$/.test(s)) return true;
        return false;
      };
      // ★ _stripEmptyLike：如果整个字符串只由括号/引号/空白组成则返回空，否则保留原始内容
      const _stripEmptyLike = t => {
        let s = String(t).trim();
        if (/^[\s{}\[\]""]+$/.test(s)) return '';
        return s;
      };
      const cleanedText = _stripEmptyLike(text);
      let currentBody = segments.querySelector('#rpLiveStreamBody');
      if (cleanedText && !_isEmptyLike(cleanedText)) {
        if (currentBody) {
          let renderedHtml = renderMd(cleanedText);
          // ★ 应用 @mention 高亮（转换为可点击链接，点击后跳转到对应员工聊天框）
          if (typeof _highlightMentions === 'function') {
            renderedHtml = _highlightMentions(renderedHtml);
          }
          currentBody.innerHTML = renderedHtml;
        }
      } else if ((!cleanedText || _isEmptyLike(cleanedText)) && assistantText.length > 0 && !thinking) {
        // ★ 如果有 step 状态，显示步骤名称而非 "Thinking…"
        const stepLabel = _rpCurrentStep === 'call_llm' ? '🧠 调用模型…' :
                          _rpCurrentStep === 'execute_tool' ? '🔧 执行工具…' : 'Thinking…';
        if (currentBody) currentBody.innerHTML = '<span style="color:var(--muted);font-size:13px">' + stepLabel + '</span>';
      } else if (!text && thinking) {
        // 还在思考中 → 如果活动文本段只显示占位符则清空
        if (currentBody && !currentBody.textContent.trim()) {
          currentBody.innerHTML = '';
        }
      }

      _scrollMsgAreaIfSticky();
    }, delay);
  }


  // ★ 过滤空外观 token：某些 provider/模型（如 GLM）在 tool_calls 前发送
  //   "{}" / "{" / "}" 等作为 content，不应累积到 assistantText，
  //   否则会在工具卡片间渲染出空大括号。
  //   扩展规则：单独的大括号/方括号字符、成对括号（含中间空白）、空引号
  const _isEmptyLikeToken = t => {
    if (!t) return true;
    const s = String(t).trim();
    if (!s) return true;
    // 只由括号/引号/空白字符组成的 token 视为"空外观"
    if (/^[\s{}\[\]""]+$/.test(s)) return true;
    return false;
  };

  source.addEventListener('token', e => {
    try {
      const d = JSON.parse(e.data);
      // ★ 过滤空外观 token（"{}" / "{" / "}" / "[]" / '""' 等），不累积到 assistantText
      if (_isEmptyLikeToken(d.text)) return;
      assistantText += d.text;
      // 同步回任务对象，保持全局单一事实源
      task.accumulatedText = assistantText;
      // ★ 新增：token 到达时，设置员工状态为 'working'
      if (typeof setEmployeeStatus === 'function' && emp && emp.id) {
        setEmployeeStatus(emp.id, 'working');
      }
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

  // ── AG-UI 精细化事件（Knot 等协议的 Start/End/Step 事件）──────────────
  source.addEventListener('message_start', e => {
    try {
      _scheduleRender();
    } catch (_) {}
  });
  source.addEventListener('message_end', e => {
    try {
      _scheduleRender();
    } catch (_) {}
  });
  source.addEventListener('thinking_start', e => {
    try {
      _rpThinkingActive = true;
      if (!segments) segments = $('rpLiveTurnSegments');
      if (segments) {
        const thinkCard = segments.querySelector('.rp-live-thinking-card');
        if (thinkCard) thinkCard.classList.add('thinking-active');
      }
      _scheduleRender();
    } catch (_) {}
  });
  source.addEventListener('thinking_end', e => {
    try {
      _rpThinkingActive = false;
      if (!segments) segments = $('rpLiveTurnSegments');
      if (segments) {
        const thinkCard = segments.querySelector('.rp-live-thinking-card');
        if (thinkCard) {
          thinkCard.classList.remove('thinking-active');
          thinkCard.classList.remove('open');
        }
      }
      _scheduleRender();
    } catch (_) {}
  });
  source.addEventListener('tool_args', e => {
    try {
      const d = JSON.parse(e.data);
      // 增量工具参数 — 更新最后一个 live tool 卡片的参数
      if (!segments) segments = $('rpLiveTurnSegments');
      if (segments) {
        const liveToolCards = segments.querySelectorAll('.rp-live-tool-card');
        const lastCard = liveToolCards[liveToolCards.length - 1];
        if (lastCard && d.args_delta) {
          const argsEl = lastCard.querySelector('.tool-card-args');
          if (argsEl) argsEl.textContent = (argsEl.textContent || '') + d.args_delta;
        }
      }
    } catch (_) {}
  });
  source.addEventListener('tool_end', e => {
    try {
      const d = JSON.parse(e.data);
      // 标记工具完成 — 移除 live 标记
      if (!segments) segments = $('rpLiveTurnSegments');
      if (segments) {
        const liveToolCards = segments.querySelectorAll('.rp-live-tool-card');
        const lastCard = liveToolCards[liveToolCards.length - 1];
        if (lastCard) lastCard.classList.remove('rp-live-tool-card');
      }
    } catch (_) {}
  });
  source.addEventListener('tool_result', e => {
    try {
      const d = JSON.parse(e.data);
      // 工具结果 — 在最后一个 tool 卡片内追加结果
      if (!segments) segments = $('rpLiveTurnSegments');
      if (segments && d.result) {
        const toolCards = segments.querySelectorAll('.rp-turn-tool');
        const lastCard = toolCards[toolCards.length - 1];
        if (lastCard) {
          const resultText = typeof d.result === 'string' ? d.result : JSON.stringify(d.result);
          // ★ 过滤空外观 result（如 "{}" / "[]" / '""'）避免在 tool card 下方显示无意义内容
          const _trimmed = (resultText || '').trim();
          if (!_trimmed || /^[\s{}\[\]""]+$/.test(_trimmed)) return;
          let resultEl = lastCard.querySelector('.tool-card-result');
          if (!resultEl) {
            resultEl = document.createElement('div');
            resultEl.className = 'tool-card-result';
            resultEl.style.cssText = 'font-size:12px;color:var(--muted);margin-top:4px;padding:4px 8px;background:rgba(255,255,255,.03);border-radius:4px;max-height:120px;overflow:auto;';
            lastCard.appendChild(resultEl);
          }
          resultEl.textContent = resultText.length > 500 ? resultText.slice(0, 500) + '...' : resultText;
        }
      }
    } catch (_) {}
  });
  source.addEventListener('step_started', e => {
    try {
      const d = JSON.parse(e.data);
      const stepName = d.step_name || '';
      _rpCurrentStep = stepName;
      const stepLabel = stepName === 'call_llm' ? '🧠 调用模型' :
                        stepName === 'execute_tool' ? '🔧 执行工具' : stepName;
      if (typeof setComposerStatus === 'function') setComposerStatus(stepLabel);
      // ★ 新增：根据步骤类型更新员工状态
      if (typeof setEmployeeStatus === 'function' && emp && emp.id) {
        if (stepName === 'call_llm') {
          setEmployeeStatus(emp.id, 'thinking');
        } else if (stepName === 'execute_tool') {
          setEmployeeStatus(emp.id, 'working');
        }
      }
      // ★ 在活动文本段显示步骤状态
      const liveBody = $('rpLiveStreamBody');
      if (liveBody && !liveBody.textContent.trim()) {
        liveBody.innerHTML = '<span style="color:var(--muted);font-size:13px">' + stepLabel + '…</span>';
      }
    } catch (_) {}
  });
  source.addEventListener('step_finished', e => {
    try {
      const d = JSON.parse(e.data);
      _rpCurrentStep = '';
      if (d.token_usage) {
        // 缓存逐步的 token 用量
        if (!task._stepTokenUsage) task._stepTokenUsage = {prompt_tokens:0,completion_tokens:0,total_tokens:0};
        task._stepTokenUsage.prompt_tokens += (d.token_usage.prompt_tokens || 0);
        task._stepTokenUsage.completion_tokens += (d.token_usage.completion_tokens || 0);
        task._stepTokenUsage.total_tokens += (d.token_usage.total_tokens || 0);
        // ★ 实时更新 token 用量显示
        if (typeof _syncCtxIndicator === 'function') {
          _syncCtxIndicator({
            input_tokens: task._stepTokenUsage.prompt_tokens,
            output_tokens: task._stepTokenUsage.completion_tokens,
          });
        }
      }
      if (typeof setComposerStatus === 'function') setComposerStatus('');
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

      // ★ 检测 delegate_task 和 send_group_message 事件，同步到PM
      if (d.name === 'delegate_task') {
        const targetName = (d.args && d.args.employee_name) || '';
        if (targetName && task.workspace) {
          task.delegatedTo = targetName;
          if (typeof _addPMSessionMessage === 'function') {
            _addPMSessionMessage(`**${task.empName}** 正在将任务委派给 **${targetName}**...`, task.empName).catch(() => {});
          }
        }
      } else if (d.name === 'send_group_message') {
        // ★ 员工通过 send_group_message 向PM发消息，若包含 @mentions 则自动委派任务
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
        // 总群概念已移除：结果消息直接回传到PM session
        if (task.workspace && typeof loadPMSession === 'function') {
          loadPMSession(task.workspace).catch(() => {});
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
      // ★ _isEmptyLike：某些 provider 在 tool_calls 前返回 content="{}" / "{" / "}" 等，
      //   不应渲染为可见文本（否则在工具卡片间显示空大括号）
      const _isEmptyLike = t => {
        if (!t) return true;
        const s = String(t).trim();
        if (!s) return true;
        if (/^[\s{}\[\]""]+$/.test(s)) return true;
        return false;
      };
      // ★ _stripEmptyLike：如果整个字符串只由括号/引号/空白组成则返回空，否则保留原始内容
      const _stripEmptyLike = t => {
        let s = String(t).trim();
        if (/^[\s{}\[\]""]+$/.test(s)) return '';
        return s;
      };
      const currentBody = segments.querySelector('#rpLiveStreamBody');
      if (currentBody) {
        const rawFinalText = typeof _stripThinkingTags === 'function'
          ? _stripThinkingTags(assistantText)
          : assistantText;
        const finalText = _stripEmptyLike(rawFinalText);
        if (finalText && !_isEmptyLike(finalText)) {
          currentBody.innerHTML = renderMd(finalText);
          currentBody.removeAttribute('id');  // 固化为历史段
        } else {
          // 空段（只有 thinking 占位 / 空外观内容如 "{}"）：直接移除
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
    console.log('[_attachLiveStreamToChat] ★ done 事件, taskId=', capturedTaskId, 'assistantTextLen=', assistantText.length);
    if(typeof UAL!=='undefined') UAL.log('stream','done',{taskId:capturedTaskId,textLen:assistantText.length});
    _streamEnded = true;
    source.close();
    if (task._chatSseSource === source) task._chatSseSource = null;
    clearTimeout(_streamTimeout);
    // ★ 修复：移除 task.status 条件限制，done 事件本身就意味着任务结束
    //   无论 task.status 之前是什么值，都应该调用 completeJob
    console.log('[_attachLiveStreamToChat] done: task.status=', task.status, 'capturedTaskId=', capturedTaskId, 'capturedEmpId=', capturedEmpId);
    if (task.status !== 'done' && task.status !== 'error' && task.status !== 'cancelled') {
      task.status = 'done';
      if (typeof DelegationVM !== 'undefined' && DelegationVM._persistTask) DelegationVM._persistTask(task);
    }
    // 使用 capturedEmpId 获取员工对象，而不是依赖闭包变量 emp
    const _empObj = (typeof getEmployee === 'function') ? getEmployee(capturedEmpId) : null;
    if (_empObj && _empObj._activeTaskId === capturedTaskId) {
      _empObj._activeTaskId = null;
      console.log('[_attachLiveStreamToChat] 清除 _activeTaskId, empId=', capturedEmpId);
    }
    // ★ 先调用 completeJob 从 running 中移除任务（并启动排队任务）
    //   然后 _refreshCardStatus 会根据 running+queues 状态正确计算员工状态
    if (typeof DelegationVM !== 'undefined' && capturedTaskId && capturedEmpId) {
      try {
        console.log('[_attachLiveStreamToChat] 调用 completeJob, capturedEmpId=', capturedEmpId, 'capturedTaskId=', capturedTaskId);
        DelegationVM.completeJob(capturedEmpId, capturedTaskId, task.status || 'done');
      } catch(e) {
        console.warn('[_attachLiveStreamToChat] completeJob 失败:', e);
      }
    } else {
      console.warn('[_attachLiveStreamToChat] 未调用 completeJob, DelegationVM=', typeof DelegationVM, 'capturedTaskId=', capturedTaskId, 'capturedEmpId=', capturedEmpId);
    }

    // ★ 推进 DelegationVM 队列（当从总群跳转过来时，_watchEmployeeStream 的 SSE
    //   已被 selectEmployee 关闭，_attachLiveStreamToChat 成为唯一消费者，
    //   所以这里需要替代 _watchEmployeeStream 的 completeJob 职责）
    // ★ 注意：already called completeJob above (line ~1958), so we skip here to avoid double-call
    // if (typeof DelegationVM !== 'undefined' && capturedTaskId) {
    //   try { DelegationVM.completeJob(emp.id, capturedTaskId, 'done'); } catch(_) {}
    // }

    // ★ 方案 C 修复（v2）：委派任务完成后，刷新 S.messages 保持一致性
    //   v1：重新调 /api/session 获取后端数据（有网络延迟/竞态风险）
    //   v2：优先从 done 事件自带的 session 数据刷新（SSE 已包含完整 messages），
    //       降级才走 /api/session 拉取；再降级走 _solidifyLiveElements。
    //   旧逻辑仅"固化 live DOM 元素"但不更新 S.messages，导致后续任何
    //   _renderRpMessages() 调用（轮询/切换员工/切回聊天框）都会清空 DOM
    //   后从 S.messages 重绘，而 S.messages 不含委派内容→"所有内容消失"。
    const _sid = (task && task.sessionId) || emp.sessionId;
    const liveRow = $('rpLiveTurnRow');
    let _refreshed = false;

    // ★ 路径 1（最优）：直接使用 done 事件自带的 session 数据
    try {
      const doneData = JSON.parse(e.data || '{}');
      const doneSession = doneData && doneData.session;
      // ★★★ 调试：记录 done event 的 session 数据结构
      if (doneSession) {
        const _msgSummary = (doneSession.messages || []).map((m, idx) => {
          const _r = m.role || '?';
          const _hasR = !!(m.reasoning);
          const _hasTc = !!(m.tool_calls && m.tool_calls.length);
          const _cLen = String(m.content || '').length;
          const _cPreview = String(m.content || '').replace(/\s+/g, ' ').slice(0, 40);
          return `#${idx}:${_r}(c=${_cLen}${_hasR?',r':''}${_hasTc?',tc':''})"${_cPreview}"`;
        });
        console.log('[_attachLiveStreamToChat] ★ done path1: sid=', doneSession.session_id, '_sid=', _sid, 'match=', doneSession.session_id === _sid, 'msgCount=', (doneSession.messages||[]).length);
        console.log('[_attachLiveStreamToChat] ★ done path1 messages=', _msgSummary);
      } else {
        console.log('[_attachLiveStreamToChat] ★ done path1: doneSession is null/undefined, doneData keys=', doneData ? Object.keys(doneData) : 'null');
      }
      // ★★★ 修复：检查 doneSession.messages 非空（长度>0），
      //   防止后端异常时返回 messages:[] 清空前端已有的消息
      if (doneSession && doneSession.messages && doneSession.messages.length > 0 && doneSession.session_id === _sid) {
        S.session = doneSession;
        // ★ 2026-04-30 修复：使用合并函数保留从独立 session 加载来的历史任务消息
        //   避免直接 S.messages = doneSession.messages 冲掉那些数据
        S.messages = _mergeDoneSessionPreservingForeignTasks(doneSession.messages, capturedTaskId);
        if (typeof _ensureDelegationDividersForMainSession === 'function') {
          _ensureDelegationDividersForMainSession(emp);
        }
        if (liveRow) liveRow.remove();
        if (typeof _renderRpMessages === 'function') _renderRpMessages();
        if (typeof _scrollMsgAreaToBottom === 'function') _scrollMsgAreaToBottom();
        _refreshed = true;
        console.log('[_attachLiveStreamToChat] done: 从 SSE event data 刷新成功, msgCount=', S.messages.length);
      } else {
        console.log('[_attachLiveStreamToChat] ★ done path1 SKIPPED: hasDoneSession=', !!doneSession, 'hasMessages=', !!(doneSession && doneSession.messages), 'sidMatch=', !!(doneSession && doneSession.session_id === _sid));
      }
    } catch(_err) {
      console.warn('[_attachLiveStreamToChat] done: 解析 event data 失败:', _err);
    }

    // ★ 路径 2（降级）：从后端 /api/session 拉取
    if (!_refreshed && _sid && S.session && S.session.session_id === _sid) {
      console.log('[_attachLiveStreamToChat] ★ done path2: 尝试从 /api/session 刷新, _sid=', _sid);
      try {
        const sessData = await api(`/api/session?session_id=${encodeURIComponent(_sid)}`);
        // ★★★ 修复：检查 messages 非空（长度>0），防止清空已有消息
        if (sessData && sessData.session && sessData.session.messages && sessData.session.messages.length > 0) {
          S.session = sessData.session;
          // ★ 2026-04-30 修复：合并保留外部任务消息
          S.messages = _mergeDoneSessionPreservingForeignTasks(sessData.session.messages, capturedTaskId);
          // ★★★ 调试：记录路径2获取的消息结构
          const _msgSummary2 = S.messages.map(m => {
            const _r = m.role || '?';
            const _hasR = !!(m.reasoning);
            const _hasTc = !!(m.tool_calls && m.tool_calls.length);
            const _cLen = String(m.content || '').length;
            return `${_r}(c=${_cLen},reasoning=${_hasR},tc=${_hasTc})`;
          });
          console.log('[_attachLiveStreamToChat] ★ done path2: msgCount=', S.messages.length, 'summary=[', _msgSummary2.join(', '), ']');
          if (typeof _ensureDelegationDividersForMainSession === 'function') {
            _ensureDelegationDividersForMainSession(emp);
          }
          if (liveRow) liveRow.remove();
          if (typeof _renderRpMessages === 'function') _renderRpMessages();
          if (typeof _scrollMsgAreaToBottom === 'function') _scrollMsgAreaToBottom();
          _refreshed = true;
          console.log('[_attachLiveStreamToChat] done: 从 /api/session 刷新成功, msgCount=', S.messages.length);
        }
      } catch(e) {
        console.warn('[_attachLiveStreamToChat] done 刷新 session 失败，降级固化 live 元素:', e);
      }
    }

    // ★ 路径 3（兜底）：固化 live DOM 元素 + 将积累文本写入 S.messages
    if (!_refreshed) {
      _solidifyLiveElements(liveRow, assistantText);
      // ★ 兜底：如果 S.messages 中仍无本次任务的 assistant 回复，手动追加
      //   避免 _renderRpMessages() 重绘时丢失所有内容
      const taskPrefix = `[PM 委派任务 #${capturedTaskId}]`;
      const hasTaskAssistant = S.messages.some(m =>
        m.role === 'assistant' && m._taskId === capturedTaskId
      );
      if (!hasTaskAssistant && assistantText.trim()) {
        const displayText = typeof _stripThinkingTags === 'function'
          ? _stripThinkingTags(assistantText.trim()) : assistantText.trim();
        if (displayText) {
          S.messages.push({
            role: 'assistant',
            content: displayText,
            _ts: Date.now() / 1000,
            _taskId: capturedTaskId,
          });
          if (typeof _renderRpMessages === 'function') _renderRpMessages();
          if (typeof _scrollMsgAreaToBottom === 'function') _scrollMsgAreaToBottom();
        }
      }
    }

    // ★ 回传结果到总群
    try {
      console.log('[_attachLiveStreamToChat] 准备调用 _handleStreamEnd, taskId=', capturedTaskId, 'task?.workspace=', task?.workspace, 'emp.sessionId=', emp?.sessionId);
      await _handleStreamEnd(emp, assistantText, capturedTaskId, task);
      console.log('[_attachLiveStreamToChat] _handleStreamEnd 完成, taskId=', capturedTaskId);
    } catch(e) {
      console.warn('[_attachLiveStreamToChat] _handleStreamEnd 失败:', e);
    }

    // ★ 刷新PM消息（替代 _watchEmployeeStream 的职责）
    if (task.workspace) {
      try { await loadGroupChat(task.workspace); } catch(_) {}
    }

    // ★ 推进 DelegationVM 队列（当从总群跳转过来时，_watchEmployeeStream 的 SSE
    //   已被 selectEmployee 关闭，_attachLiveStreamToChat 成为唯一消费者，
    //   所以这里需要替代 _watchEmployeeStream 的 completeJob 职责）
    if (typeof DelegationVM !== 'undefined' && capturedTaskId) {
      try { DelegationVM.completeJob(emp.id, capturedTaskId, 'done'); } catch(_) {}
    }
  });

  source.addEventListener('error', async () => {
    console.log('[_attachLiveStreamToChat] error 事件, taskId=', capturedTaskId, '_streamEnded=', _streamEnded, '_intentionallyClosed=', !!source._intentionallyClosed);
    if(typeof UAL!=='undefined') UAL.log('stream','error',{taskId:capturedTaskId,intentionallyClosed:!!source._intentionallyClosed});
    if (_streamEnded) return;
    // ★ 2026-04-27: 切换到总群时会主动关闭 SSE（task._chatSseSource），
    //   EventSource close 会同步触发一次 error 事件。此时任务仍在后台执行，
    //   不能把 task.status 置为 error（否则切回员工聊天后任务被标记为出错）。
    if (source._intentionallyClosed) {
      _streamEnded = true;
      clearTimeout(_streamTimeout);
      if (task._chatSseSource === source) task._chatSseSource = null;
      return;
    }
    _streamEnded = true;
    source.close();
    if (task._chatSseSource === source) task._chatSseSource = null;
    // ★ 基于 task 状态
    if (task.status === 'pending' || task.status === 'running') {
      task.status = 'error';
      if (typeof DelegationVM !== 'undefined' && DelegationVM._persistTask) DelegationVM._persistTask(task);
      if (emp._activeTaskId === task.id) {
        emp._activeTaskId = null;
        // ★ 新增：错误时更新员工状态为 'error'
        if (typeof setEmployeeStatus === 'function' && emp.id) {
          setEmployeeStatus(emp.id, 'error');
        }
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
    // 流出错时回传已积累结果到PM session
    try {
      console.log('[_attachLiveStreamToChat] error路径：准备调用 _handleStreamEnd, taskId=', capturedTaskId);
      await _handleStreamEnd(emp, assistantText, capturedTaskId, task);
      console.log('[_attachLiveStreamToChat] error路径：_handleStreamEnd 完成');
    } catch(e) {
      console.warn('[_attachLiveStreamToChat] error路径：_handleStreamEnd 失败:', e);
    }
    // ★ 推进 DelegationVM 队列（error 路径）
    if (typeof DelegationVM !== 'undefined' && capturedTaskId) {
      try { DelegationVM.completeJob(emp.id, capturedTaskId, 'error'); } catch(_) {}
    }
  });

  source.addEventListener('apperror', async () => {
    if (_streamEnded) return;
    _streamEnded = true;
    source.close();
    if (task._chatSseSource === source) task._chatSseSource = null;
    // ★ 基于 task 状态
    if (task.status === 'pending' || task.status === 'running') {
      task.status = 'error';
      if (typeof DelegationVM !== 'undefined' && DelegationVM._persistTask) DelegationVM._persistTask(task);
      if (emp._activeTaskId === task.id) {
        emp._activeTaskId = null;
        // ★ 新增：错误时更新员工状态为 'error'
        if (typeof setEmployeeStatus === 'function' && emp.id) {
          setEmployeeStatus(emp.id, 'error');
        }
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
    // 流出错时回传已积累结果到PM session
    try {
      console.log('[_attachLiveStreamToChat] apperror路径：准备调用 _handleStreamEnd, taskId=', capturedTaskId);
      await _handleStreamEnd(emp, assistantText, capturedTaskId, task);
      console.log('[_attachLiveStreamToChat] apperror路径：_handleStreamEnd 完成');
    } catch(e) {
      console.warn('[_attachLiveStreamToChat] apperror路径：_handleStreamEnd 失败:', e);
    }
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
  console.log('[_handleStreamEnd] 开始, taskId=', taskId, 'emp.name=', emp?.name, 'task?.workspace=', task?.workspace, 'assistantText.len=', assistantText?.length);
  // ★ 优先使用任务自己的 workspace
  let ws = task && task.workspace ? task.workspace : '';
  if (!ws) {
    ws = typeof _currentCanvasWorkspace !== 'undefined' ? _currentCanvasWorkspace : (S.session?.workspace || '');
    if (ws === '__default__') ws = _currentCanvasWorkspace || S.session?.workspace || '';
  }
  if (!ws) return;

  // ★ 优先从任务的 sessionId 拉取（避免 emp.sessionId 已被新任务覆盖导致查错库）
  const sid = (task && task.sessionId) || emp.sessionId;
  console.log('[_handleStreamEnd] ws=', ws, 'sid=', sid, 'task?.sessionId=', task?.sessionId, 'emp.sessionId=', emp?.sessionId);

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
  console.log('[_handleStreamEnd] 准备回传，ws=', ws, 'displayResult.len=', displayResult.length, 'hasDelegationVM=', typeof DelegationVM !== 'undefined');

  // ★ 通过 DelegationVM 统一回传（内建去重守卫，sessionId 让后端聚合完整回复）
  if (typeof DelegationVM !== 'undefined') {
    try {
      console.log('[_handleStreamEnd] 调用 DelegationVM.postResultOnce...');
      const postResult = await DelegationVM.postResultOnce({
        emp,
        taskId: taskId || (task && task.id) || '',
        result: displayResult,
        workspace: ws,
        sessionId: sid || '',
        requesterName: (task && task.requesterName) || '你',
      });
      console.log('[_handleStreamEnd] DelegationVM.postResultOnce 结果:', postResult);
    } catch(e) {
      console.warn('[_handleStreamEnd] DelegationVM.postResultOnce 失败:', e);
    }
  } else {
    try {
      if (typeof _postResultToPMSession === 'function') {
        console.log('[_handleStreamEnd] 调用 _postResultToPMSession...');
        await _postResultToPMSession({
          workspace: ws,
          employee_name: emp.name,
          task_id: taskId || (task && task.id) || '',
          result: displayResult,
          requester_name: (task && task.requesterName) || '你',
        });
        console.log('[_handleStreamEnd] _postResultToPMSession 完成');
      }
    } catch(e) {
      console.warn('[_handleStreamEnd] _postResultToPMSession 失败:', e);
    }
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

  // ★★★ 调试：记录渲染时的消息结构 + 调用栈
  const _callerStack = (new Error()).stack || '';
  const _callerLine = _callerStack.split('\n').slice(2, 5).map(s => s.trim()).join(' ← ');
  if (S.messages && S.messages.length > 0) {
    const _rMsgSummary = S.messages.map(m => {
      const _r = m.role || '?';
      const _hasR = !!(m.reasoning);
      const _hasTc = !!(m.tool_calls && m.tool_calls.length);
      const _cLen = String(m.content || '').length;
      const _isDiv = !!m._taskDivider;
      const _tid = m._taskId ? `,tid=${String(m._taskId).slice(-8)}` : '';
      return `${_r}(c=${_cLen},r=${_hasR?1:0},tc=${_hasTc?1:0},div=${_isDiv?1:0}${_tid})`;
    });
    console.log('[_renderRpMessages] ★ S.messages count=', S.messages.length, 'sid=', S.session?.session_id?.slice(-8), 'summary=[', _rMsgSummary.join(', '), ']');
  } else {
    console.log('[_renderRpMessages] ★ S.messages is EMPTY, sid=', S.session?.session_id?.slice(-8), 'caller=', _callerLine);
  }

  // 保留带 tool_calls 的 assistant 消息作为锚点（即使 content 为空）
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
      // ★ 去重键包含 tool_calls 摘要，避免相同 role+content+reasoning 但不同 tool_calls 的消息被误去重
      const _tcKey = hasTc ? m.tool_calls.map(tc => {
        const fn = tc.function || {};
        return `${fn.name || tc.name || ''}:${tc.id || ''}`;
      }).join(',') : hasTu ? 'tu' : '';
      const key = `${m.role}|${_tid}|${_cmpContent}|${String(m.reasoning || '')}|${_tcKey}`;
      if (_seenKeys.has(key)) continue;
      _seenKeys.add(key);
      visWithIdx.push({ m, rawIdx: i });
    }
  }

  // ★ 按时间戳排序（确保消息按时间顺序排列：旧消息在前，新消息在后）
  // ★ 2026-05-01 修复：缺少 _ts/timestamp 的消息仅按 rawIdx 排序，
  //   避免 ts=0 导致这些消息被错误排到最前面。
  //   只有双方都有 ts 时才按 ts 排序，否则退回 rawIdx。
  visWithIdx.sort((a, b) => {
    const tsA = Number(a.m._ts) || Number(a.m.timestamp) || 0;
    const tsB = Number(b.m._ts) || Number(b.m.timestamp) || 0;
    const hasA = !!(a.m._ts || a.m.timestamp);
    const hasB = !!(b.m._ts || b.m.timestamp);
    // 双方都有 ts → 按 ts 排，ts 相等时按 rawIdx
    if (hasA && hasB) {
      if (tsA !== tsB) return tsA - tsB;
      return a.rawIdx - b.rawIdx;
    }
    // 一方或双方缺少 ts → 仅按 rawIdx 保持原始顺序
    return a.rawIdx - b.rawIdx;
  });

  if (emptyChat) emptyChat.style.display = visWithIdx.length ? 'none' : '';
  inner.innerHTML = '';

  // ── 窗口化：只渲染最近一页，更早的消息通过顶部 sentinel 点击/滚动加载 ──
  // 把当前 session_id 作为 key，key 变化时 _computeWindowStart 会自动重置窗口
  // 这样即使切换员工/会话的代码路径没调用 _resetRenderWindow，也能正确显示最新一页
  const _total = visWithIdx.length;
  const _key = (S.session && S.session.session_id) || (EMPLOYEE_STORE && EMPLOYEE_STORE.selectedId) || '';
  // ★ 2026-05-01 修复：新消息到达时，如果用户在底部则自动滚动到最新
  const _container = document.getElementById('rpMessages');
  const _isAtBottom = _container && (_container.scrollHeight - _container.scrollTop - _container.clientHeight <= 100);
  if (_total > _rpWindow.total && _isAtBottom) {
    // 新消息到达 + 用户在底部 → 自动滚动到最新
    console.log('[_renderRpMessages] 新消息到达 + 用户在底部，自动滚动到最新：total=', _total, 'oldTotal=', _rpWindow.total);
    _rpWindow.startIdx = -1;
  }
  const _start = _computeWindowStart(_total, _key, 'employee');
  const _slice = visWithIdx.slice(_start);

  for (const { m, rawIdx } of _slice) {
    // ★ 任务分隔标记：渲染为分隔线 + 任务标题
    if (m._taskDivider) {
      const statusIcon = m._taskStatus === 'done' ? '✅' : m._taskStatus === 'error' ? '❌' : m._taskStatus === 'running' ? '⏳' : '📋';
      const statusLabel = m._taskStatus === 'done' ? '已完成' : m._taskStatus === 'error' ? '出错' : m._taskStatus === 'running' ? '执行中' : '';
      const taskLabel = m._taskLabel ? ` — ${esc(m._taskLabel)}` : '';
      const statusHtml = statusLabel ? `<span class="rp-task-divider-status" style="font-size:11px;color:var(--muted);margin-left:4px">(${esc(statusLabel)})</span>` : '';
      // ★ 2026-04-27 ghost 标记：任务登记在 localStorage 但后端 session 没写入
      //   （dispatch 失败/中断所致），附加警示 + 重试按钮
      const ghostHtml = m._taskGhost
        ? `<span class="rp-task-divider-ghost" style="font-size:11px;color:#ef4444;margin-left:6px" title="该任务未在后端 session 中找到——可能 dispatch 失败或被中断。">⚠ 未送达</span> <button class="rp-task-retry-btn" style="font-size:11px;padding:1px 6px;margin-left:4px;border:1px solid #ef4444;border-radius:4px;background:transparent;color:#ef4444;cursor:pointer" onclick="event.preventDefault();_retryGhostTask('${esc(m._taskId || '')}')">重试</button>`
        : '';
      const dividerRow = document.createElement('div');
      dividerRow.className = 'rp-msg-row rp-task-divider';
      dividerRow.dataset.taskId = m._taskId || '';
      if (m._taskGhost) dividerRow.dataset.taskGhost = '1';
      dividerRow.innerHTML = `
        <div class="rp-task-divider-line"></div>
        <div class="rp-task-divider-label">
          <span class="rp-task-divider-icon">${statusIcon}</span>
          <a href="#" class="gc-task-link" data-task-id="${esc(m._taskId || '')}" onclick="event.preventDefault();jumpToGroupChatTask('${esc(m._taskId || '')}');return false;" title="点击跳转到PM聊天">${esc(m.content || '')}</a>${taskLabel}${statusHtml}${ghostHtml}
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
    if (m.role === 'user' && typeof content === 'string' && content.startsWith('[PM 委派任务')) {
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
      // ★ 检测PM委派任务前缀，转为可点击链接跳转回总群
      const taskMatch = String(content).match(/^\[PM 委派任务 #(task-[A-Za-z0-9_-]+)\]/);
      // ★ 2026-05-01：检测员工完成任务回传消息 `[员工名 完成任务 #task-xxx]\n结果`
      //   这类消息 role=user 但实际是员工回传给 PM，渲染为"员工反馈"样式（区别于用户本人发言）
      const contentStr = String(content);
      const resultMatch = !taskMatch && contentStr.match(/^\[([^\]]+?)\s+完成任务\s+#(task-[A-Za-z0-9_-]+)\]\s*([\s\S]*)$/);
      console.log('[renderRpMessages] resultMatch 检测: contentStr前100=', contentStr.slice(0,100), 'resultMatch=', resultMatch ? {empName:resultMatch[1],tid:resultMatch[2],bodyLen:resultMatch[3]?.length} : null);
      if (taskMatch) {
        const tid = taskMatch[1];
        const prefix = taskMatch[0];
        const rest = String(content).slice(prefix.length);
        const prefixHtml = `<a href="#" class="gc-task-link" data-task-id="${esc(tid)}" onclick="event.preventDefault();jumpToGroupChatTask('${esc(tid)}');return false;" title="点击跳转到PM聊天">${esc(prefix)}</a>`;
        bodyHtml = prefixHtml + renderMd(rest);
      } else if (resultMatch) {
        // 员工完成任务回传：特殊样式（紫色/青色边框 + 员工名字 + 任务链接 + 完整内容 markdown）
        const empName = resultMatch[1];
        const tid = resultMatch[2];
        const resultBody = resultMatch[3] || '';
        console.log('[renderRpMessages] resultMatch 匹配成功: empName=', empName, 'tid=', tid, 'resultBody.len=', resultBody.length, 'rawIdx=', rawIdx);
        const taskLinkHtml = `<a href="#" class="gc-task-link" data-task-id="${esc(tid)}" onclick="event.preventDefault();jumpToGroupChatTask('${esc(tid)}');return false;" title="查看任务详情" style="font-size:11px;color:var(--muted);margin-left:6px">#${esc(tid.slice(-12))}</a>`;
        const row = document.createElement('div');
        row.className = 'rp-msg-row rp-msg-task-result';
        row.style.cssText = 'display:flex;flex-direction:column;margin:8px 12px 8px 0;background:rgba(16,185,129,.06);border:1px solid rgba(16,185,129,.2);border-radius:0 8px 8px 0';
        row.dataset.role = 'user';
        row.dataset.msgIdx = rawIdx;
        row.dataset.taskId = tid;
        row.innerHTML = `
          <div class="rp-msg-role assistant" style="color:#10b981;padding:4px 12px 0 12px">
            <span class="rp-msg-icon">✅</span>
            <span class="rp-msg-name" style="font-weight:600">${esc(empName)} 已完成</span>${taskLinkHtml}${_fmtMsgTime(m)}
          </div>
          <div class="rp-msg-body" style="padding:8px 12px;border-left:3px solid #10b981">${renderMd(resultBody)}</div>
        `;
        row.dataset.rawText = String(content).trim();
        inner.appendChild(row);
        console.log('[renderRpMessages] resultMatch 行已追加到 inner, inner.children.length=', inner.children.length);
        continue;
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
    // ★ _isEmptyLike：某些 provider 在 assistant 只有 tool_calls 时返回 content="{}" / "{" / "}" 等，
    //   这不应被视为有效文本内容，否则会在工具卡片之间渲染出空大括号
    const _isEmptyLike = t => {
      if (!t) return true;
      const s = String(t).trim();
      if (!s) return true;
      if (/^[\s{}\[\]""]+$/.test(s)) return true;
      return false;
    };
    // ★ _stripEmptyLike：如果整个字符串只由括号/引号/空白组成则返回空，否则保留原始内容
    const _stripEmptyLike = t => {
      let s = String(t).trim();
      if (/^[\s{}\[\]""]+$/.test(s)) return '';
      return s;
    };
    const strippedContent = _stripEmptyLike(content);
    const hasText = !_isEmptyLike(strippedContent) && !!strippedContent;
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
      const _tidMatch = hasText ? strippedContent.match(/#(task-[A-Za-z0-9_-]+)/) : null;
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
      let renderedHtml = renderMd(strippedContent);
      // ★ 应用 @mention 高亮（转换为可点击链接，点击后跳转到对应员工聊天框）
      if (typeof _highlightMentions === 'function') {
        renderedHtml = _highlightMentions(renderedHtml);
      }
      bodyEl.innerHTML = renderedHtml;
      segments.appendChild(bodyEl);
      if (!turnRow.dataset.rawText) turnRow.dataset.rawText = strippedContent;
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

  // ★★★ 调试：渲染完成后检查关键 DOM 元素
  const _thinkingCards = inner.querySelectorAll('.thinking-card');
  const _toolCards = inner.querySelectorAll('.rp-turn-tool');
  const _userMsgs = inner.querySelectorAll('[data-role="user"]');
  const _asstTurns = inner.querySelectorAll('.rp-turn[data-role="assistant"]');
  console.log('[_renderRpMessages] ★ RENDERED: thinkingCards=', _thinkingCards.length, 'toolCards=', _toolCards.length, 'userMsgs=', _userMsgs.length, 'asstTurns=', _asstTurns.length, 'visWithIdx=', visWithIdx.length, 'windowStart=', _start, 'sliceLen=', _slice.length, 'caller=', _callerLine);

  // 窗口化：顶部插入 sentinel（若还有更早的历史未渲染）+ 挂载 scroll 监听
  if (_start > 0) {
    _insertHistorySentinel(inner, _start, () => _loadMoreHistory(_renderRpMessages));
  }
  _attachHistoryScrollListener(_renderRpMessages);

    // ★ 强制滚动到底（打开员工面板时保证看到最新消息）

  requestAnimationFrame(() => {

    const el = document.getElementById("rpMessages");

    if (el) { el.scrollTop = el.scrollHeight; _rpStickyState.sticky = true; }

  });

  // 粘底滚动（用户在底部时才跟随新消息，手动向上滚动后不中断阅读）

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
 *  - 切回默认的「工作区目录」tab；
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
    const SRC_BADGE = {
      custom: { label: '自定义', color: '#60a5fa' },
      global: { label: 'Hermes', color: '#c084fc' },
      preset: { label: '预设',   color: '#34d399' },
      workspace: { label: '工作区', color: '#fbbf24' },
    };
    let html = '<div class="rp-skill-list">';
    if (emp.skills.length) {
      for (const sk of emp.skills) {
        const name = sk.name || sk;
        const enabled = sk.enabled !== false;
        const source = sk.source || '';
        const badge = SRC_BADGE[source];
        const badgeHtml = badge
          ? `<span style="padding:1px 5px;border-radius:3px;font-size:10px;font-weight:500;color:${badge.color};background:${badge.color}22;margin-right:6px">${badge.label}</span>`
          : '';
        html += `
          <div class="rp-skill-item">
            <span class="rp-skill-item-name">${badgeHtml}${esc(name)}</span>
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
 * ★ 2026-04-29 增强：下拉合并三源技能（来源标签区分）：
 *   - 用户自定义技能：`GET /api/skills`（本地积累 / 沉淀）
 *   - 全局 Hermes 技能库：`GET /api/skills/global/list`（如 plan / systematic-debugging）
 *   - 当前预设技能：从 AGENT_PRESETS 中读取该员工预设目录下的 skill 文件列表
 *   三源合并后按"未拥有 + 关键字匹配"过滤，每项带来源 badge。
 *   支持键盘 ↑/↓/Enter/Esc 导航。允许输入自定义技能名（不在列表中也可添加）。
 */
async function addSkillToEmployeeInline(empId) {
  const emp = getEmployee(empId);
  if (!emp) return;

  // 1) 预取三源技能（带简单缓存）
  if (!window._allSkillsCache) {
    try {
      const data = await api('/api/skills');
      window._allSkillsCache = Array.isArray(data.skills) ? data.skills : [];
    } catch (_) {
      window._allSkillsCache = [];
    }
  }
  if (!window._globalSkillsCache) {
    try {
      const data = await api('/api/skills/global/list');
      window._globalSkillsCache = (data && Array.isArray(data.skills)) ? data.skills : [];
    } catch (_) {
      window._globalSkillsCache = [];
    }
  }

  // 合并三源为统一结构 {name, description, source, path?}
  const mergeSources = () => {
    const out = [];
    // 用户自定义
    for (const sk of window._allSkillsCache || []) {
      if (sk && sk.name) {
        out.push({
          name: sk.name,
          description: sk.description || '',
          source: 'custom',
        });
      }
    }
    // 全局 Hermes 库
    for (const sk of window._globalSkillsCache || []) {
      if (sk && sk.name) {
        out.push({
          name: sk.name,
          description: sk.description || '',
          source: 'global',
          path: sk.path,
          category: sk.category,
        });
      }
    }
    // 当前预设自带
    if (emp.presetId && typeof AGENT_PRESETS !== 'undefined') {
      const preset = AGENT_PRESETS.find(p => p.id === emp.presetId);
      if (preset && Array.isArray(preset._skill_files)) {
        for (const fname of preset._skill_files) {
          const name = fname.replace(/\.md$/i, '');
          out.push({
            name,
            description: `来自 ${preset.name || preset.id} 预设`,
            source: 'preset',
          });
        }
      }
    }
    // 去重（以 name + source 为 key）
    const seen = new Set();
    return out.filter(s => {
      const k = (s.name + '|' + s.source).toLowerCase();
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    });
  };

  const SOURCE_BADGE = {
    custom: { label: '自定义', color: '#60a5fa' },
    global: { label: 'Hermes', color: '#c084fc' },
    preset: { label: '预设',   color: '#34d399' },
  };

  // 弹出添加技能对话框
  const overlay = document.createElement('div');
  overlay.className = 'app-dialog-overlay';
  overlay.style.display = 'flex';
  overlay.innerHTML = `
    <div class="app-dialog" style="max-width:480px">
      <div class="app-dialog-header">
        <div class="app-dialog-title">添加技能</div>
        <button class="app-dialog-close" id="addSkillClose"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg></button>
      </div>
      <div style="padding:4px 20px 16px">
        <div style="font-size:12px;color:var(--muted);margin-bottom:10px">
          为「${esc(emp.name)}」添加一项专业技能（从三个来源检索：Hermes 技能库 / 预设自带 / 自定义积累）
        </div>
        <div class="skill-source-filter" style="display:flex;gap:6px;margin-bottom:10px">
          <button class="skill-filter-btn active" data-source="all" style="flex:1;padding:4px 8px;font-size:11px;border-radius:4px;cursor:pointer;background:var(--bg-elevated);border:1px solid var(--border)">全部</button>
          <button class="skill-filter-btn" data-source="global" style="flex:1;padding:4px 8px;font-size:11px;border-radius:4px;cursor:pointer;background:transparent;border:1px solid var(--border);color:#c084fc">Hermes 官方</button>
          <button class="skill-filter-btn" data-source="preset" style="flex:1;padding:4px 8px;font-size:11px;border-radius:4px;cursor:pointer;background:transparent;border:1px solid var(--border);color:#34d399">预设自带</button>
          <button class="skill-filter-btn" data-source="custom" style="flex:1;padding:4px 8px;font-size:11px;border-radius:4px;cursor:pointer;background:transparent;border:1px solid var(--border);color:#60a5fa">自定义</button>
        </div>
        <div class="skill-ac-wrap" style="position:relative">
          <input class="emp-dialog-input" id="addSkillInput" placeholder="输入关键字检索技能，或输入自定义技能名后直接添加" style="width:100%" maxlength="60" autocomplete="off">
          <div class="skill-ac-dropdown" id="addSkillDropdown" style="display:none;max-height:300px;overflow-y:auto"></div>
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

  // 当前下拉状态
  let activeIdx = -1;
  let currentMatches = [];
  let sourceFilter = 'all';

  const allSkills = mergeSources();

  /** 渲染下拉列表（最多 20 条） */
  function renderDropdown(q) {
    const qLower = (q || '').trim().toLowerCase();
    currentMatches = allSkills
      .filter(sk => !ownedNames.has(sk.name.toLowerCase()))
      .filter(sk => sourceFilter === 'all' || sk.source === sourceFilter)
      .filter(sk => {
        if (!qLower) return true;
        const n = (sk.name || '').toLowerCase();
        const d = (sk.description || '').toLowerCase();
        const c = (sk.category || '').toLowerCase();
        return n.includes(qLower) || d.includes(qLower) || c.includes(qLower);
      })
      .slice(0, 20);

    if (!currentMatches.length) {
      dd.style.display = 'none';
      dd.innerHTML = '';
      activeIdx = -1;
      return;
    }
    dd.style.display = 'block';
    dd.innerHTML = currentMatches.map((sk, i) => {
      const badge = SOURCE_BADGE[sk.source] || { label: sk.source, color: '#888' };
      return `
        <div class="skill-ac-item${i === activeIdx ? ' active' : ''}" data-idx="${i}" style="padding:8px 10px;cursor:pointer;border-bottom:1px solid rgba(255,255,255,.05);display:flex;align-items:start;gap:8px">
          <span style="padding:1px 5px;border-radius:3px;font-size:10px;font-weight:500;color:${badge.color};background:${badge.color}22;flex-shrink:0;line-height:1.6">${badge.label}</span>
          <div style="flex:1;min-width:0">
            <div class="skill-ac-name" style="font-size:13px;font-weight:500">${esc(sk.name)}</div>
            ${sk.description ? `<div class="skill-ac-desc" style="font-size:11px;opacity:.6;margin-top:2px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(sk.description)}</div>` : ''}
            ${sk.category ? `<div style="font-size:10px;opacity:.4;margin-top:2px">📁 ${esc(sk.category)}</div>` : ''}
          </div>
        </div>
      `;
    }).join('');

    // 点击选中某项 → 填入输入框 + 自动提交
    dd.querySelectorAll('.skill-ac-item').forEach(el => {
      el.onclick = () => {
        const idx = parseInt(el.dataset.idx, 10);
        if (currentMatches[idx]) {
          const sk = currentMatches[idx];
          input.value = sk.name;
          input.dataset.selectedSource = sk.source;
          if (sk.path) input.dataset.selectedPath = sk.path;
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
      el.style.background = i === activeIdx ? 'rgba(255,255,255,.06)' : '';
    });
    const activeEl = dd.querySelector('.skill-ac-item.active');
    if (activeEl && activeEl.scrollIntoView) {
      activeEl.scrollIntoView({ block: 'nearest' });
    }
  }

  // 来源过滤按钮
  overlay.querySelectorAll('.skill-filter-btn').forEach(btn => {
    btn.onclick = () => {
      overlay.querySelectorAll('.skill-filter-btn').forEach(b => {
        b.classList.remove('active');
        b.style.background = 'transparent';
      });
      btn.classList.add('active');
      btn.style.background = 'var(--bg-elevated)';
      sourceFilter = btn.dataset.source;
      activeIdx = -1;
      renderDropdown(input.value);
    };
  });

  // 初始显示（空关键字 → 全量候选）
  renderDropdown('');

  input.addEventListener('input', () => {
    activeIdx = -1;
    delete input.dataset.selectedSource;
    delete input.dataset.selectedPath;
    renderDropdown(input.value);
  });

  overlay.querySelector('#addSkillOk').onclick = () => {
    const name = input.value.trim();
    if (!name) return;
    if (emp.skills.find(s => (s.name || s) === name)) {
      showToast('该技能已存在');
      return;
    }
    // 构造 skill 对象：如果是从下拉选择的，保留 source/path 以供后端 skill_resolver 精确定位
    const skillEntry = { name, enabled: true };
    if (input.dataset.selectedSource) {
      skillEntry.source = input.dataset.selectedSource;
    }
    if (input.dataset.selectedPath) {
      skillEntry.path = input.dataset.selectedPath;
    }
    emp.skills.push(skillEntry);
    _saveEmployees();
    renderEmployeeCards();
    showEmployeeSkillPanel(empId);
    if (typeof invalidatePromptCache === 'function') invalidatePromptCache(emp.id);
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
      if (activeIdx >= 0 && currentMatches[activeIdx]) {
        const sk = currentMatches[activeIdx];
        input.value = sk.name;
        input.dataset.selectedSource = sk.source;
        if (sk.path) input.dataset.selectedPath = sk.path;
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

// ── 员工配置页面（从 chat header 调用）─────────────────────────────────────────
// 配置页面面板的回退栈（用于撤销）
let _cfgHtmlUndoStack = [];
let _cfgHtmlCurrentEmpId = null;

function openEmployeeConfigHtml() {
  const empId = EMPLOYEE_STORE.selectedId;
  if (!empId) { showToast('请先选择一个员工'); return; }
  const emp = getEmployee(empId);
  if (!emp) return;

  // 切换到配置页面面板视图
  _cfgHtmlCurrentEmpId = empId;
  _cfgHtmlUndoStack = [];
  _setRightPanelView('confightml');

  // 更新面板标题
  const titleEl = $('rpConfigHtmlTitle');
  if (titleEl) titleEl.textContent = emp.name + ' · 配置页面';
  const subtitleEl = $('rpConfigHtmlSubtitle');
  if (subtitleEl) subtitleEl.textContent = '编辑员工的自定义 HTML 页面';

  // 加载当前 HTML 到编辑器
  const editor = $('cfgHtmlEditor');
  if (editor) {
    editor.value = emp.configHtml || '';
    // 实时预览：编辑器输入时同步到输出区浏览器
    editor.oninput = () => {
      _cfgHtmlSyncPreview();
    };
  }

  // 隐藏回退按钮（没有历史可回退）
  const undoBtn = $('cfgUndoBtn');
  if (undoBtn) undoBtn.style.display = 'none';

  // 初始预览
  _cfgHtmlSyncPreview();
}

/** 同步编辑器内容到输出区浏览器 */
function _cfgHtmlSyncPreview() {
  const editor = $('cfgHtmlEditor');
  const frame = $('outBrowserFrame');
  const empty = $('outBrowserEmpty');
  if (!editor || !frame) return;

  const html = editor.value;
  if (html) {
    // 使用 srcdoc 直接渲染 HTML（注入 sendToChat 桥接脚本）
    frame.srcdoc = _injectSendToChatIntoHtml(html);
    frame.src = '';  // 清除 src，避免与 srcdoc 冲突
    frame.classList.add('loaded');
    if (empty) empty.classList.add('hidden');
    // 更新浏览器地址栏显示
    const urlInput = $('outBrowserUrl');
    if (urlInput) urlInput.value = 'config://' + (_cfgHtmlCurrentEmpId || 'unknown');
  } else {
    frame.srcdoc = '';
    frame.src = 'about:blank';
    frame.classList.remove('loaded');
    if (empty) empty.classList.remove('hidden');
  }
}

/** 保存配置页面 */
async function saveConfigHtml() {
  const emp = _cfgHtmlCurrentEmpId ? getEmployee(_cfgHtmlCurrentEmpId) : null;
  if (!emp) { showToast('员工不存在'); return; }

  const editor = $('cfgHtmlEditor');
  const newHtml = editor ? editor.value : '';

  emp.configHtml = newHtml;
  try { _saveEmployees(); } catch (_) {}

  // 尝试写入后端
  try {
    const ws = (typeof _activeWorkspacePath === 'function' ? _activeWorkspacePath() : '')
            || (typeof _currentCanvasWorkspace !== 'undefined' ? _currentCanvasWorkspace : '');
    if (ws && emp._backendSynced) {
      await api('/api/employee/update', {
        method: 'POST',
        body: JSON.stringify({
          workspace: ws,
          id: emp.id,
          configHtml: newHtml,
        }),
      });
    }
  } catch (_) {}

  showToast('配置页面已保存');
  // 回到聊天视图
  if (EMPLOYEE_STORE.selectedId) {
    _setRightPanelView('chat');
  } else {
    _setRightPanelView('empty');
  }
  _cfgHtmlCurrentEmpId = null;
  _cfgHtmlUndoStack = [];
  // ★ 恢复浏览器为该员工的 configHtml 预览（而非清空白屏）
  const _savedEmp = emp;
  const frame = $('outBrowserFrame');
  if (frame) {
    if (_savedEmp.configHtml) {
      frame.srcdoc = _injectSendToChatIntoHtml(_savedEmp.configHtml);
      frame.src = '';
      frame.classList.add('loaded');
      const emptyEl = $('outBrowserEmpty');
      if (emptyEl) emptyEl.classList.add('hidden');
      const urlInput = $('outBrowserUrl');
      if (urlInput) urlInput.value = 'config://' + _savedEmp.id;
    } else {
      frame.srcdoc = '';
      frame.src = 'about:blank';
      frame.classList.remove('loaded');
      const emptyEl = $('outBrowserEmpty');
      if (emptyEl) emptyEl.classList.remove('hidden');
      const urlInput = $('outBrowserUrl');
      if (urlInput) urlInput.value = '';
    }
  }
  if (typeof renderEmployeeCards === 'function') renderEmployeeCards();
}

/** 关闭配置页面编辑器（不保存） */
function closeConfigHtmlEditor() {
  const editor = $('cfgHtmlEditor');
  const emp = _cfgHtmlCurrentEmpId ? getEmployee(_cfgHtmlCurrentEmpId) : null;
  // 如果内容有变化，提示确认
  if (emp && editor && editor.value !== (emp.configHtml || '')) {
    if (!confirm('配置页面内容已修改但未保存，确定关闭？')) return;
  }
  // 回到聊天视图
  if (EMPLOYEE_STORE.selectedId) {
    _setRightPanelView('chat');
  } else {
    _setRightPanelView('empty');
  }
  _cfgHtmlCurrentEmpId = null;
  _cfgHtmlUndoStack = [];
  // ★ 恢复浏览器为该员工的 configHtml 预览（而非清空白屏）
  const frame = $('outBrowserFrame');
  if (frame) {
    if (emp && emp.configHtml) {
      frame.srcdoc = _injectSendToChatIntoHtml(emp.configHtml);
      frame.src = '';
      frame.classList.add('loaded');
      const emptyEl = $('outBrowserEmpty');
      if (emptyEl) emptyEl.classList.add('hidden');
      const urlInput = $('outBrowserUrl');
      if (urlInput) urlInput.value = 'config://' + emp.id;
    } else {
      frame.srcdoc = '';
      frame.src = 'about:blank';
      frame.classList.remove('loaded');
      const emptyEl = $('outBrowserEmpty');
      if (emptyEl) emptyEl.classList.remove('hidden');
      const urlInput = $('outBrowserUrl');
      if (urlInput) urlInput.value = '';
    }
  }
}

/** 回退到上一版本 */
function configHtmlUndo() {
  if (_cfgHtmlUndoStack.length === 0) return;
  const prev = _cfgHtmlUndoStack.pop();
  const editor = $('cfgHtmlEditor');
  if (editor) {
    editor.value = prev;
    _cfgHtmlSyncPreview();
  }
  // 如果没有更多历史，隐藏回退按钮
  const undoBtn = $('cfgUndoBtn');
  if (undoBtn && _cfgHtmlUndoStack.length === 0) undoBtn.style.display = 'none';
}

/** AI 生成配置页面 HTML */
async function configHtmlGenerate() {
  const promptEl = $('cfgGenPrompt');
  const statusEl = $('cfgGenStatus');
  const genBtn = $('cfgGenBtn');
  const editor = $('cfgHtmlEditor');
  const emp = _cfgHtmlCurrentEmpId ? getEmployee(_cfgHtmlCurrentEmpId) : null;
  if (!emp || !promptEl || !editor) return;

  const prompt = promptEl.value.trim();
  if (!prompt) { showToast('请描述想要的页面'); return; }

  // 保存当前内容到回退栈
  if (editor.value) {
    _cfgHtmlUndoStack.push(editor.value);
    const undoBtn = $('cfgUndoBtn');
    if (undoBtn) undoBtn.style.display = '';
  }

  // 禁用按钮、显示状态
  if (genBtn) { genBtn.disabled = true; genBtn.textContent = '生成中...'; }
  if (statusEl) { statusEl.textContent = 'AI 正在生成...'; statusEl.style.color = 'var(--blue)'; }

  try {
    // 构造生成请求：让 AI 生成 HTML
    const genPrompt = `你是一个前端工程师。请根据以下需求生成一个完整的 HTML 页面（单文件，包含内联 CSS 和 JS）。
需求：${prompt}

要求：
1. 生成完整的 HTML 文档（<!DOCTYPE html> 开头）
2. CSS 写在 <style> 标签中
3. JS 写在 <script> 标签中
4. 页面风格现代简洁
5. 只输出 HTML 代码，不要其他说明文字`;

    // 使用当前员工的 session 来生成
    const sessionId = emp.sessionId;
    if (!sessionId) {
      if (statusEl) { statusEl.textContent = '该员工还没有会话，请先与员工对话'; statusEl.style.color = 'var(--accent)'; }
      return;
    }

    // ★ 修复：传递当前选中的工作区
    const _ws = (typeof _activeWorkspacePath === 'function' ? _activeWorkspacePath() : '') 
                || (emp && emp.workspace) || S.session?.workspace || '';
    const data = await api('/api/chat/start', {
      method: 'POST',
      body: JSON.stringify({
        session_id: sessionId,
        message: genPrompt,
        workspace: _ws || undefined,
        stream: false,
      }),
    });

    if (data.response) {
      // 提取 HTML 代码块（如果被 markdown 包裹）
      let html = data.response;
      const codeBlockMatch = html.match(/```html?\n([\s\S]*?)```/);
      if (codeBlockMatch) {
        html = codeBlockMatch[1].trim();
      } else {
        const htmlMatch = html.match(/(<!DOCTYPE html>[\s\S]*)/i);
        if (htmlMatch) {
          html = htmlMatch[1].trim();
        }
      }
      editor.value = html;
      _cfgHtmlSyncPreview();
      if (statusEl) { statusEl.textContent = '生成完成'; statusEl.style.color = '#4ade80'; }
      setTimeout(() => { if (statusEl) statusEl.textContent = ''; }, 2000);
    } else {
      if (statusEl) { statusEl.textContent = '生成失败：无响应'; statusEl.style.color = 'var(--accent)'; }
    }
  } catch (e) {
    if (statusEl) { statusEl.textContent = '生成失败: ' + (e.message || '未知错误'); statusEl.style.color = 'var(--accent)'; }
  } finally {
    if (genBtn) { genBtn.disabled = false; genBtn.textContent = '生成'; }
  }
}

if (typeof window !== 'undefined') {
  window.openEmployeeConfigHtml = openEmployeeConfigHtml;
  window.saveConfigHtml = saveConfigHtml;
  window.closeConfigHtmlEditor = closeConfigHtmlEditor;
  window.configHtmlUndo = configHtmlUndo;
  window.configHtmlGenerate = configHtmlGenerate;
  window._cfgHtmlSyncPreview = _cfgHtmlSyncPreview;
}




// ── 提示词编辑器 ──────────────────────────────────────────────────────────────
function openEmployeePromptEditor() {
  const emp = getEmployee(EMPLOYEE_STORE.selectedId);
  if (!emp) { showToast('请先选择一个员工'); return; }

  _setRightPanelView('prompt');

  const titleEl = $('rpPromptTitle');
  if (titleEl) titleEl.textContent = emp.name + ' 的提示词';

  const editorEl = $('rpPromptEditor');
  if (!editorEl) return;

  // 先用同步版本显示占位内容（避免等待）
  try { editorEl.value = buildEmployeeSystemPrompt(emp) || ''; } catch(_) {}

  // 若后端可用，异步更新为完整的后端渲染版本（含 skill.md 正文等）
  if (typeof buildEmployeeSystemPromptAsync === 'function') {
    buildEmployeeSystemPromptAsync(emp, { forceRefresh: true }).then(fullPrompt => {
      // 用户可能在等待期间已经编辑；若未编辑则刷新为后端版本
      if (editorEl && (editorEl.value === '' || editorEl.dataset._autoLoaded !== '1')) {
        editorEl.value = fullPrompt || '';
        editorEl.dataset._autoLoaded = '1';
      }
    }).catch(() => {});
  }
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
  // 优先使用后端异步构建；失败降级到同步版本
  const buildPromise = (typeof buildEmployeeSystemPromptAsync === 'function')
    ? buildEmployeeSystemPromptAsync(emp)
    : Promise.resolve(buildEmployeeSystemPrompt(emp));
  buildPromise.then(prompt => {
    // 更新后端 session 的 system_prompt
    return api('/api/session/update', {
      method: 'POST',
      body: JSON.stringify({ session_id: emp.sessionId, system_prompt: prompt }),
    });
  }).catch(() => {}); // fire-and-forget
}

// ── 委派关系信息条 ──────────────────────────────────────────────────────────
function _updateDelegationBar(emp) {
  console.log('[右面板] _updateDelegationBar called, emp=', emp?.name || null);
  const bar = $('rpDelegationBar');
  const info = $('rpDelegationInfo');
  if (!bar || !info) return;

  // 守卫：若任一成员下拉面板正打开，跳过刷新，避免销毁输入框 DOM 导致焦点丢失与中文输入被打断
  const _ddGroup = document.getElementById('pmMembersDropdown');
  const _ddEmpSubs = document.getElementById('empSubsDropdown');
  if ((_ddGroup && _ddGroup.style.display && _ddGroup.style.display !== 'none')
      || (_ddEmpSubs && _ddEmpSubs.style.display && _ddEmpSubs.style.display !== 'none')) {
    return;
  }

  // 总群打开时，走总群委派栏逻辑（不受 emp 为 null 影响）
  // REMOVED: GROUP_CHAT_STATE.isOpen check — 总群概念已移除

  if (!emp) { bar.style.display = 'none'; return; }

  const parts = [];

  // PM链接 — 固定显示
  if (typeof getPMEmployee === 'function') {
    const pm = getPMEmployee();
    if (pm) {
      const pmName = pm.name || (typeof PM_NAME !== 'undefined' ? PM_NAME : 'PM专员');
      parts.push(`<span class="rp-del-label">PM：</span><span class="rp-del-name rp-coordinator-link" onclick="selectEmployee('${pm.id}')" title="打开${esc(pmName)}聊天">${esc(pmName)}</span>`);
      // PM聊天模式下，显示成员下拉框按钮
      const isPMChat = emp.id === pm.id;
      if (isPMChat && typeof EMPLOYEE_STORE !== 'undefined') {
        const members = EMPLOYEE_STORE.employees || [];
        if (members.length) {
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
          if (typeof window !== 'undefined') window._pmMemberHierarchy = hierarchy;
          const n = hierarchy.length;
          parts.push(
            `<span class="rp-del-label">成员：</span>` +
            `<button type="button" class="pm-members-btn" id="pmMembersBtn" ` +
            `onclick="_togglePMMembersDropdown(event)" aria-haspopup="listbox" aria-expanded="false" ` +
            `title="点击查看所有成员">` +
            `<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">` +
            `<path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/>` +
            `</svg>` +
            `<span class="pm-members-count">${n}</span>` +
            `<svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" class="pm-members-chevron"><polyline points="6 9 12 15 18 9"/></svg>` +
            `</button>` +
            `<div class="pm-members-dropdown" id="pmMembersDropdown" role="listbox" style="display:none"></div>`
          );
        }
      }
    } else {
      parts.push(`<span class="rp-del-label">PM：</span><span class="rp-del-label" style="opacity:.5">未设置</span>`);
    }
  }

  // 管理者（从连线关系）— 仅非PM专员时显示
  const _isPMChat = (typeof getPMEmployee === 'function' && getPMEmployee() && emp.id === getPMEmployee().id);
  if (!_isPMChat && emp.subagentOf && typeof getEmployee === 'function') {
    const mgr = getEmployee(emp.subagentOf);
    if (mgr) {
      parts.push(`<span class="rp-del-label">上级：</span><span class="rp-del-name" onclick="selectEmployee('${mgr.id}')">${esc(mgr.name)}</span>`);
    }
  }

  // 下属（从连线关系）— 仅非PM专员时显示
  if (!_isPMChat && typeof getSubagentsOf === 'function') {
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
    info.innerHTML = '';
    bar.style.display = 'none';
  }

  // ★ 同步员工模型 chip 显示
  if (typeof syncEmpModelChip === 'function') syncEmpModelChip();

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

/** ★ 2026-04-27：重试一个 ghost task（localStorage 登记但后端 session 未写入的任务）
 *  - 从 DelegationVM 持久化映射读 empName / taskContent / workspace
 *  - 把任务状态重置为 pending
 *  - 复用 _dispatchTaskToEmployee 重走"方案 B"入队 + 启动流程
 *  - 关闭 ghost 标记（通过 status 更新 → 下一次渲染不再显示 "未送达" 徽标）
 */
async function _retryGhostTask(taskId) {
  if (!taskId) return;
  if (typeof DelegationVM === 'undefined' || typeof DelegationVM.getPersistedTask !== 'function') {
    if (typeof showToast === 'function') showToast('DelegationVM 不可用，无法重试');
    return;
  }
  const meta = DelegationVM.getPersistedTask(taskId);
  if (!meta || !meta.taskContent) {
    if (typeof showToast === 'function') showToast('任务元数据缺失，无法重试');
    return;
  }
  const empName = meta.empName || '';
  if (!empName) {
    if (typeof showToast === 'function') showToast('任务缺少员工名，无法重试');
    return;
  }
  // 用户二次确认
  let ok;
  if (typeof showConfirmDialog === 'function') {
    ok = await showConfirmDialog({
      title: '重试委派任务',
      message: `将使用原任务内容重新委派给 ${empName}。\n（taskId=${taskId} 之前未送达到员工 session，这可能是由于上次 dispatch 失败或浏览器中断）`,
      confirmLabel: '重新委派',
      cancelLabel: '取消',
    });
  } else {
    ok = confirm(`重新委派任务给 ${empName}？`);
  }
  if (!ok) return;
  // 不复用原 taskId（可能已有残留状态）——直接用原 taskContent 重新发一遍
  //   _dispatchTaskToEmployee 会创建新的 Task 对象、入队、启动。
  //   原 ghost taskId 通过 setTaskStatus 标为 cancelled 避免再次补渲为 ghost。
  try {
    DelegationVM.setTaskStatus(taskId, 'cancelled');
  } catch (_) {}
  // 调用 _dispatchTaskToEmployee 复用原逻辑——用新生成的 taskId
  const newTaskId = `task-${Math.random().toString(36).slice(2, 10)}`;
  if (typeof _dispatchTaskToEmployee === 'function') {
    try {
      await _dispatchTaskToEmployee(empName, meta.taskContent, newTaskId, { orchestrate: false });
      if (typeof showToast === 'function') showToast(`已重新委派任务给 ${empName}（#${newTaskId.slice(0, 13)}）`);
      // 刷新当前员工聊天显示（若正在看该员工）
      const emp = (typeof getEmployee === 'function' && typeof EMPLOYEE_STORE !== 'undefined')
        ? getEmployee(EMPLOYEE_STORE.selectedId) : null;
      if (emp && emp.name === empName && typeof openEmployeeChat === 'function') {
        try { await openEmployeeChat(emp.id); } catch (_) {}
      }
    } catch (e) {
      console.warn('[重试任务] _dispatchTaskToEmployee 失败:', e);
      if (typeof showToast === 'function') showToast(`重试失败: ${e.message || e}`);
    }
  } else {
    if (typeof showToast === 'function') showToast('无法重试：_dispatchTaskToEmployee 不可用');
  }
}
window._retryGhostTask = _retryGhostTask;

// ── 配置页面 iframe ↔ 父页面消息桥接 ─────────────────────────────────────
// 配置页面中的 sendToChat() 通过 postMessage 与父页面通信，
// 父页面收到消息后填入输入框并触发发送。
function _handleConfigHtmlMessage(e) {
  // 只接受来自同源的消息
  if (!e.data || e.data.type !== 'hermes-config-chat') return;
  const text = (e.data.text || '').trim();
  if (!text) return;
  const msgEl = $('msg');
  if (msgEl) {
    msgEl.value = text;
    if (typeof autoResize === 'function') autoResize();
    if (typeof send === 'function') send();
  }
}

/** 在 iframe 加载后注入 sendToChat 函数（通过 srcdoc 渲染的 iframe 无跨域限制） */
function _injectSendToChat(frame) {
  if (!frame) return;
  try {
    const doc = frame.contentDocument || frame.contentWindow?.document;
    if (!doc) return;
    const script = doc.createElement('script');
    script.textContent = `
      function sendToChat(text) {
        window.parent.postMessage({ type: 'hermes-config-chat', text: text || '' }, '*');
      }
      function sendForm() {
        var f = document.querySelector('form,textarea,input[type=text]');
        var t = f ? (f.value || f.textContent || '') : '';
        sendToChat(t);
      }
    `;
    (doc.head || doc.documentElement).appendChild(script);
  } catch (_) {
    // 跨域 iframe 无法注入（srcdoc 场景不会出现此问题）
  }
}

/** 在 HTML 末尾注入 sendToChat 桥接脚本（比 onload 更可靠） */
function _injectSendToChatIntoHtml(html) {
  if (!html) return html;
  // 使用字符串拼接避免模板字符串中的 <\/script> 转义问题
  const bridgeScript = '<script>' +
    'function sendToChat(t){window.parent.postMessage({type:"hermes-config-chat",text:t||""},"*")}' +
    'function _collectAllFormValues(){' +
      'var parts=[];' +
      // 1. Text inputs
      'document.querySelectorAll(\'input[type="text"],input[type="password"],input[type="email"],input[type="number"],input[type="url"],input[type="tel"],input[type="date"],input[type="time"],input[type="search"],input:not([type])\').forEach(function(el){' +
        'if(!el.id&&!el.name)return;' +
        'var label=_findLabel(el);' +
        'var val=el.value.trim();' +
        'if(val)parts.push(label+": "+val);' +
      '});' +
      // 2. Textarea
      'document.querySelectorAll("textarea").forEach(function(el){' +
        'if(!el.id&&!el.name)return;' +
        'var label=_findLabel(el);' +
        'var val=el.value.trim();' +
        'if(val)parts.push(label+": "+val);' +
      '});' +
      // 3. Select (dropdown)
      'document.querySelectorAll("select").forEach(function(el){' +
        'if(!el.id&&!el.name)return;' +
        'var label=_findLabel(el);' +
        'var val=el.options[el.selectedIndex]?el.options[el.selectedIndex].text:"";' +
        'parts.push(label+": "+val);' +
      '});' +
      // 4. Checkbox / Toggle
      'document.querySelectorAll(\'input[type="checkbox"]\').forEach(function(el){' +
        'if(!el.id&&!el.name)return;' +
        'var label=_findToggleLabel(el);' +
        'parts.push(label+": "+(el.checked?"已启用":"已禁用"));' +
      '});' +
      // 5. Radio
      'var radios={};' +
      'document.querySelectorAll(\'input[type="radio"]:checked\').forEach(function(el){' +
        'var name=el.name||el.id||"";' +
        'if(!name)return;' +
        'var label=_findRadioGroupLabel(el);' +
        'if(!radios[name])radios[name]={label:label,val:el.value,text:el.parentElement?el.parentElement.textContent.trim():el.value};' +
      '});' +
      'for(var k in radios)parts.push(radios[k].label+": "+radios[k].text);' +
      // 6. Range / Slider
      'document.querySelectorAll(\'input[type="range"]\').forEach(function(el){' +
        'if(!el.id&&!el.name)return;' +
        'var label=_findSliderLabel(el);' +
        'parts.push(label+": "+el.value);' +
      '});' +
      // 7. Color picker
      'document.querySelectorAll(\'input[type="color"]\').forEach(function(el){' +
        'if(!el.id&&!el.name)return;' +
        'var label=_findLabel(el);' +
        'parts.push(label+": "+el.value);' +
      '});' +
      // 8. Tags
      'document.querySelectorAll(".tag-container,.tag-list,[data-tags]").forEach(function(el){' +
        'var tags=[];' +
        'el.querySelectorAll(".tag,.tag-item,.badge").forEach(function(t){' +
          'var txt=t.textContent.replace(/\\s*[×✕xX]\\s*$/,"").trim();' +
          'if(txt)tags.push(txt);' +
        '});' +
        'if(tags.length){' +
          'var label=el.getAttribute("data-label")||"标签";' +
          'parts.push(label+": "+tags.join(", "));' +
        '}' +
      '});' +
      // 9. KB cards
      'var selectedKBs=[];' +
      'document.querySelectorAll(".kb-card.selected,[data-selected=true]").forEach(function(el){' +
        'var name=el.getAttribute("data-name")||el.getAttribute("data-kb")||"";' +
        'var h=el.querySelector(\'div[style*="font-weight"]\');' +
        'if(h)name=h.textContent.trim()||name;' +
        'if(name)selectedKBs.push(name);' +
      '});' +
      'if(selectedKBs.length)parts.push("知识库: "+selectedKBs.join(", "));' +
      'return parts;' +
    '}' +
    'function _findLabel(el){' +
      'var lbl=el.closest(".form-group, .form-field, .field");' +
      'if(lbl){' +
        'var l=lbl.querySelector(".form-label,label,.field-label");' +
        'if(l)return l.textContent.replace(/[*\\s]+$/,"").trim();' +
      '}' +
      'if(el.id){' +
        'var l2=document.querySelector(\'label[for="\'+el.id+\'"]\');' +
        'if(l2)return l2.textContent.replace(/[*\\s]+$/,"").trim();' +
      '}' +
      'return el.getAttribute("placeholder")||el.id||el.name||"";' +
    '}' +
    'function _findToggleLabel(el){' +
      'var row=el.closest(".toggle-row, .toggle-group, .switch-row");' +
      'if(row){' +
        'var n=row.querySelector(".toggle-name, .switch-label, .toggle-label");' +
        'if(n)return n.textContent.trim();' +
      '}' +
      'return _findLabel(el);' +
    '}' +
    'function _findSliderLabel(el){' +
      'var grp=el.closest(".slider-group, .slider-row");' +
      'if(grp){' +
        'var l=grp.querySelector(".slider-label, label");' +
        'if(l)return l.textContent.trim();' +
      '}' +
      'return _findLabel(el);' +
    '}' +
    'function _findRadioGroupLabel(el){' +
      'var grp=el.closest(".radio-group, [role=radiogroup]");' +
      'if(grp){' +
        'var l=grp.querySelector(".radio-group-label, label, legend");' +
        'if(l)return l.textContent.trim();' +
      '}' +
      'return el.name||el.id||"";' +
    '}' +
    'function sendForm(){' +
      'var custom=typeof collectFormData==="function"?collectFormData():null;' +
      'if(custom&&Object.keys(custom).length){' +
        'sendToChat(JSON.stringify(custom,null,2));' +
      '}else{' +
        'var parts=_collectAllFormValues();' +
        'sendToChat(parts.length?parts.join("\\n"):"(空表单)");' +
      '}' +
    '}' +
  '<\/script>';
  // 在 </body> 或 </html> 前插入，如果没有则追加到末尾
  if (html.includes('</body>')) {
    return html.replace('</body>', bridgeScript + '</body>');
  } else if (html.includes('</html>')) {
    return html.replace('</html>', bridgeScript + '</html>');
  } else {
    return html + bridgeScript;
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
    panel.style.minWidth = '60px';
    panel.style.opacity = '1';
  }
  if (layout) {
    layout.classList.remove('workspace-panel-collapsed');
  }

  // ★ 监听配置页面 iframe 的 postMessage（sendToChat → 父页面聊天框）
  window.removeEventListener('message', _handleConfigHtmlMessage);
  window.addEventListener('message', _handleConfigHtmlMessage);

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
      if (targetEmployee.avatarStyle || targetEmployee.avatar) {
        const url = getEmployeeAvatarUrl(targetEmployee, { size: 128 });
        const fallback = esc(targetEmployee.avatar || '🤖').replace(/'/g, "\\'");
        avatarEl.innerHTML = `<div class="rp-employee-avatar rp-avatar-animated" data-status="${targetEmployee.status}"><img src="${url}" alt="" style="width:100%;height:100%;object-fit:cover;display:block;border-radius:inherit" onerror="this.parentElement.innerHTML='<span style=font-size:20px>${fallback}</span>'"></div>`;
      } else if (targetEmployee.characterImg) {
        const fb2 = (targetEmployee.avatar||'').replace(/'/g, "\\'");
        avatarEl.innerHTML = `<div class="rp-employee-avatar-sprite" style="background-image:url('/static/img/characters/${targetEmployee.characterImg}_frame32x32.png');background-size:300% 400%;background-position:0 0;background-repeat:no-repeat" data-fallback="${fb2}" onerror="this.remove();this.parentElement.textContent='${fb2}'"></div>`;
      } else {
        avatarEl.textContent = targetEmployee.avatar || '🤖';
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

  // 分栏布局：显示文件头部，隐藏空状态提示
  const rpHeader = $('rpFileHeader');
  const rpEmptyHint = $('rpFileEmptyHint');
  if (rpHeader) rpHeader.style.display = '';
  if (rpEmptyHint) rpEmptyHint.style.display = 'none';

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

  // 分栏布局：显示空状态提示，隐藏文件头部
  const rpHeader = $('rpFileHeader');
  const rpEmptyHint = $('rpFileEmptyHint');
  if (rpHeader) rpHeader.style.display = 'none';
  if (rpEmptyHint) rpEmptyHint.style.display = '';

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

// ─────────────────────────────────────────────────────────────────────────────
// 参数配置编辑器（基于 preset.paramsSchema 自动渲染表单，无 schema 时回退到通用 key-value 编辑器）
// ─────────────────────────────────────────────────────────────────────────────

/**
 * HTML 转义辅助
 */
function _rpEsc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

/**
 * 打开员工参数配置面板
 *
 * 行为：
 *   1. 若员工所属预设声明了 paramsSchema → 按 schema 自动渲染表单
 *      （类型：string / number / boolean / enum / multiline）
 *   2. 否则 → 渲染通用的 key-value 编辑器
 *      （用户可自由添加 key/value 对，删除、修改）
 */
function openEmployeeParamsEditor() {
  const emp = getEmployee(EMPLOYEE_STORE.selectedId);
  if (!emp) { showToast('请先选择一个员工'); return; }

  _setRightPanelView('params');

  const titleEl = $('rpParamsTitle');
  const subEl = $('rpParamsSubtitle');
  if (titleEl) titleEl.textContent = emp.name + ' · 参数';

  // 查预设（同步查本地 AGENT_PRESETS；若未加载则异步补查）
  const contentEl = $('rpParamsContent');
  if (!contentEl) return;

  contentEl.innerHTML = '<div class="rp-params-loading">加载中…</div>';

  const preset = (emp.presetId && typeof AGENT_PRESETS !== 'undefined')
    ? AGENT_PRESETS.find(p => p.id === emp.presetId)
    : null;

  const schema = (preset && Array.isArray(preset.paramsSchema) && preset.paramsSchema.length)
    ? preset.paramsSchema
    : null;

  if (subEl) {
    subEl.textContent = schema
      ? `${preset.name || preset.id} 预设已定义 ${schema.length} 个参数`
      : '自由编辑 key-value（会自动注入到提示词）';
  }

  // 延迟渲染，让加载动画显示
  setTimeout(() => {
    if (schema) {
      _renderParamsBySchema(contentEl, emp, schema);
    } else {
      _renderParamsKeyValue(contentEl, emp);
    }
  }, 150);
}

/** 基于 schema 渲染结构化表单 */
function _renderParamsBySchema(contentEl, emp, schema) {
  const params = emp.params || {};
  const rows = schema.map((field, idx) => {
    const key = field.key;
    const label = _rpEsc(field.label || key);
    const desc = field.description ? `<div class="rp-params-field-desc">${_rpEsc(field.description)}</div>` : '';
    const curVal = (params[key] != null) ? params[key] : (field.default != null ? field.default : '');
    const fieldId = `rpParamField_${idx}`;
    let input = '';

    switch (field.type) {
      case 'number': {
        const min = field.min != null ? ` min="${_rpEsc(field.min)}"` : '';
        const max = field.max != null ? ` max="${_rpEsc(field.max)}"` : '';
        input = `<input type="number" class="rp-params-input" id="${fieldId}" data-key="${_rpEsc(key)}" data-type="number" value="${_rpEsc(curVal)}"${min}${max} placeholder="${_rpEsc(field.placeholder || '请输入数字')}"/>`;
        break;
      }
      case 'boolean': {
        const checked = (curVal === true || curVal === 'true') ? ' checked' : '';
        input = `<label class="rp-params-checkbox"><input type="checkbox" id="${fieldId}" data-key="${_rpEsc(key)}" data-type="boolean"${checked}><span>启用</span></label>`;
        break;
      }
      case 'enum': {
        const options = Array.isArray(field.options) ? field.options : [];
        const opts = options.map(o => `<option value="${_rpEsc(o)}"${String(curVal) === String(o) ? ' selected' : ''}>${_rpEsc(o)}</option>`).join('');
        input = `<select class="rp-params-input" id="${fieldId}" data-key="${_rpEsc(key)}" data-type="enum">${opts}</select>`;
        break;
      }
      case 'multiline':
        input = `<textarea class="rp-params-input" id="${fieldId}" data-key="${_rpEsc(key)}" data-type="multiline" rows="3" placeholder="${_rpEsc(field.placeholder || '请输入多行文本')}">${_rpEsc(curVal)}</textarea>`;
        break;
      default: // string
        input = `<input type="text" class="rp-params-input" id="${fieldId}" data-key="${_rpEsc(key)}" data-type="string" value="${_rpEsc(curVal)}" placeholder="${_rpEsc(field.placeholder || '请输入参数值')}"/>`;
    }

    return `
      <div class="rp-params-field">
        <label for="${fieldId}">${label}${field.required ? '<span class="required">*</span>' : ''}</label>
        ${input}
        ${desc}
      </div>`;
  }).join('');

  contentEl.innerHTML = `
    <div class="rp-params-form">
      ${rows}
      <div class="rp-params-hint">
        💡 这些值会通过 <code>{{params.key}}</code> 注入到提示词模板。
      </div>
    </div>
    <div class="rp-params-save-bar">
      <span class="rp-params-save-info">修改会自动保存</span>
      <button class="rp-params-save-btn" onclick="saveEmployeeParams()">保存参数</button>
    </div>`;
}

/** 无 schema 时的通用 key-value 编辑器 */
function _renderParamsKeyValue(contentEl, emp) {
  const params = emp.params || {};
  const keys = Object.keys(params);

  const rows = keys.length > 0 
    ? keys.map((k, i) => {
        const val = params[k];
        // 支持新格式 {value, type} 和旧格式 (纯值)
        const value = (val && typeof val === 'object' && 'value' in val) ? val.value : val;
        const type = (val && typeof val === 'object' && 'type' in val) ? val.type : 'string';
        return _createKvRowHtml(k, value, i, type);
      }).join('')
    : `<div class="rp-params-empty">
        <div class="rp-params-empty-icon">📝</div>
        <div class="rp-params-empty-title">暂无参数</div>
        <div class="rp-params-empty-hint">点击下方按钮添加参数，或导入预设配置</div>
      </div>`;

  contentEl.innerHTML = `
    <div class="rp-params-kv">
      <div class="rp-params-kv-header">
        <span class="rp-params-kv-title">参数列表</span>
        <span class="rp-params-kv-count">${keys.length} 个参数</span>
      </div>
      <div class="rp-params-kv-list" id="rpParamsKvList">${rows}</div>
      <button class="rp-add-param-btn" onclick="_rpAddParamsRow()">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <line x1="12" y1="5" x2="12" y2="19"/>
          <line x1="5" y1="12" x2="19" y2="12"/>
        </svg>
        添加参数
      </button>
      <div class="rp-params-hint">
        💡 这些值会注入到提示词的"配置参数"段，也可通过 <code>{{params.key}}</code> 在自定义 prompt 中引用。
      </div>
    </div>
    <div class="rp-params-save-bar">
      <button class="rp-params-save-btn" onclick="saveEmployeeParams()">保存参数</button>
    </div>`;
}

/** 创建 key-value 行 HTML */
function _createKvRowHtml(key = '', value = '', idx = -1, type = 'string') {
  return `
    <div class="rp-params-kv-row" data-idx="${idx}">
      <input type="text" class="rp-params-kv-key" value="${_rpEsc(key)}" placeholder="参数名"/>
      <input type="text" class="rp-params-kv-val" value="${_rpEsc(value)}" placeholder="参数值"/>
      <select class="rp-params-kv-type" title="参数类型">
        <option value="string"${type === 'string' ? ' selected' : ''}>文本</option>
        <option value="number"${type === 'number' ? ' selected' : ''}>数字</option>
        <option value="boolean"${type === 'boolean' ? ' selected' : ''}>布尔</option>
        <option value="json"${type === 'json' ? ' selected' : ''}>JSON</option>
      </select>
      <button class="panel-icon-btn" onclick="_rpRemoveParamsRow(this)" title="删除参数">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <line x1="18" y1="6" x2="6" y2="18"/>
          <line x1="6" y1="6" x2="18" y2="18"/>
        </svg>
      </button>
    </div>`;
}

/** 给 key-value 编辑器添加一行 */
function _rpAddParamsRow() {
  const list = $('rpParamsKvList');
  if (!list) return;
  
  // 移除空状态提示（如果存在）
  const emptyEl = list.querySelector('.rp-params-empty');
  if (emptyEl) {
    emptyEl.remove();
    // 更新计数
    const countEl = document.querySelector('.rp-params-kv-count');
    if (countEl) countEl.textContent = '1 个参数';
  }
  
  const row = document.createElement('div');
  row.className = 'rp-params-kv-row';
  row.innerHTML = _createKvRowHtml('', '', -1, 'string');
  list.appendChild(row);
  row.querySelector('.rp-params-kv-key')?.focus();
  
  // 更新计数
  _updateKvCount();
}

/** 删除参数行（带动画） */
function _rpRemoveParamsRow(btn) {
  const row = btn.closest('.rp-params-kv-row');
  if (!row) return;
  
  // 添加删除动画
  row.classList.add('removing');
  
  // 动画结束后移除元素
  setTimeout(() => {
    row.remove();
    _updateKvCount();
    
    // 如果没有参数了，显示空状态
    const list = $('rpParamsKvList');
    if (list && list.children.length === 0) {
      list.innerHTML = `
        <div class="rp-params-empty">
          <div class="rp-params-empty-icon">📝</div>
          <div class="rp-params-empty-title">暂无参数</div>
          <div class="rp-params-empty-hint">点击下方按钮添加参数，或导入预设配置</div>
        </div>`;
    }
  }, 200);
}

/** 更新参数计数 */
function _updateKvCount() {
  const countEl = document.querySelector('.rp-params-kv-count');
  const rows = document.querySelectorAll('#rpParamsKvList .rp-params-kv-row');
  if (countEl) {
    countEl.textContent = `${rows.length} 个参数`;
  }
}

/** 收集表单并保存 */
function saveEmployeeParams() {
  const emp = getEmployee(EMPLOYEE_STORE.selectedId);
  if (!emp) return;

  const newParams = {};

  // 1. Schema-based fields
  document.querySelectorAll('#rpParamsContent .rp-params-input').forEach(el => {
    const key = el.dataset.key;
    const type = el.dataset.type;
    if (!key) return;
    let val;
    if (type === 'number') {
      const n = Number(el.value);
      val = isNaN(n) ? '' : n;
    } else {
      val = el.value;
    }
    if (val !== '' && val != null) {
      // 使用新格式保存：{value, type}
      newParams[key] = {value: val, type: type || 'string'};
    }
  });
  document.querySelectorAll('#rpParamsContent input[data-type="boolean"]').forEach(el => {
    const key = el.dataset.key;
    if (key) newParams[key] = {value: !!el.checked, type: 'boolean'};
  });

  // 2. Key-value fields
  document.querySelectorAll('#rpParamsContent .rp-params-kv-row').forEach(row => {
    const k = row.querySelector('.rp-params-kv-key')?.value?.trim();
    const v = row.querySelector('.rp-params-kv-val')?.value;
    const typeSelect = row.querySelector('.rp-params-kv-type');
    const type = typeSelect ? typeSelect.value : 'string';
    
    if (k) {
      // 根据类型转换值
      let typedValue = v || '';
      if (type === 'number') {
        const n = Number(v);
        typedValue = isNaN(n) ? 0 : n;
      } else if (type === 'boolean') {
        typedValue = v === 'true' || v === '1' || v === 'yes';
      } else if (type === 'json') {
        try {
          typedValue = JSON.parse(v);
        } catch (e) {
          // 如果不是有效的JSON，保存为字符串
          typedValue = v || '';
        }
      }
      
      newParams[k] = {value: typedValue, type: type};
    }
  });

  emp.params = newParams;
  if (typeof _saveEmployees === 'function') _saveEmployees();
  if (typeof invalidatePromptCache === 'function') invalidatePromptCache(emp.id);

  // 同步到 session（如果已经建过 session）
  if (typeof _syncEmployeePromptToSession === 'function') {
    _syncEmployeePromptToSession(emp);
  }

  if (typeof showToast === 'function') showToast('✅ 参数已保存');
  
  // 不立即关闭，让用户继续编辑
  // closeParamsEditor();
}

/** 关闭参数编辑器 → 回到聊天 */
function closeParamsEditor() {
  if (EMPLOYEE_STORE.selectedId) {
    _setRightPanelView('chat');
  } else {
    _setRightPanelView('empty');
  }
}


// 暴露到 window（供 onclick 调用）
if (typeof window !== 'undefined') {
  window.openEmployeeParamsEditor = openEmployeeParamsEditor;
  window.saveEmployeeParams = saveEmployeeParams;
  window.closeParamsEditor = closeParamsEditor;
  window._rpAddParamsRow = _rpAddParamsRow;
  window._rpRemoveParamsRow = _rpRemoveParamsRow;
  window._updateKvCount = _updateKvCount;
  window._exportParams = _exportParams;
  window._importParams = _importParams;
}

/** 导出参数配置 */
function _exportParams() {
  const emp = getEmployee(EMPLOYEE_STORE.selectedId);
  if (!emp) {
    showToast('❌ 请先选择一个员工');
    return;
  }
  
  const params = emp.params || {};
  if (Object.keys(params).length === 0) {
    showToast('⚠️ 暂无参数可导出');
    return;
  }
  
  // 简化导出格式（只导出value和type）
  const exportData = {};
  for (const [key, val] of Object.entries(params)) {
    if (val && typeof val === 'object' && 'value' in val) {
      exportData[key] = {value: val.value, type: val.type || 'string'};
    } else {
      exportData[key] = {value: val, type: 'string'};
    }
  }
  
  const dataStr = JSON.stringify(exportData, null, 2);
  const dataBlob = new Blob([dataStr], {type: 'application/json'});
  
  const link = document.createElement('a');
  link.href = URL.createObjectURL(dataBlob);
  link.download = `${emp.name || 'employee'}_params_${new Date().toISOString().slice(0,10)}.json`;
  link.click();
  
  setTimeout(() => URL.revokeObjectURL(link.href), 100);
  showToast('✅ 参数配置已导出');
}

/** 导入参数配置 */
function _importParams() {
  const emp = getEmployee(EMPLOYEE_STORE.selectedId);
  if (!emp) {
    showToast('❌ 请先选择一个员工');
    return;
  }
  
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = '.json';
  input.onchange = function(e) {
    const file = e.target.files[0];
    if (!file) return;
    
    const reader = new FileReader();
    reader.onload = function(event) {
      try {
        const imported = JSON.parse(event.target.result);
        
        // 验证格式
        if (typeof imported !== 'object' || imported === null) {
          throw new Error('无效的配置格式');
        }
        
        // 合并参数（保留现有参数，合并导入的参数）
        const currentParams = emp.params || {};
        
        for (const [key, val] of Object.entries(imported)) {
          if (val && typeof val === 'object' && 'value' in val) {
            currentParams[key] = val;
          } else {
            // 兼容旧格式
            currentParams[key] = {value: val, type: 'string'};
          }
        }
        
        emp.params = currentParams;
        
        // 重新渲染UI
        const contentEl = document.getElementById('rpParamsContent');
        if (contentEl) {
          _renderParamsKeyValue(contentEl, emp);
        }
        
        if (typeof _saveEmployees === 'function') _saveEmployees();
        showToast(`✅ 已导入 ${Object.keys(imported).length} 个参数`);
        
      } catch (err) {
        showToast('❌ 导入失败：' + err.message);
      }
    };
    reader.readAsText(file);
  };
  
  input.click();
}
