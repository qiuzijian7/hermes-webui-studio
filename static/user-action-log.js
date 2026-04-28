/**
 * user-action-log.js — 用户行为日志模块
 *
 * 统一记录客户端的点击、输入、面板切换、委派、消息发送等行为，
 * 便于调试和追踪用户操作链路。
 *
 * 用法：
 *   UAL.log('category', 'action', { ...detail })
 *   UAL.history  — 最近 N 条日志数组
 *   UAL.dump()   — 打印完整日志到 console
 *
 * 所有日志通过 console.log 输出，前缀 [UAL] 。
 * 2026-04-28 初始版本
 */
;(function () {
  'use strict';

  const MAX_HISTORY = 500;       // 内存中保留最近 500 条
  const LOG_PREFIX  = '%c[UAL]';
  const LOG_STYLE   = 'color:#7cb9ff;font-weight:bold';
  const _history    = [];

  // ── 核心 log 方法 ──────────────────────────────────────────────────
  function log(category, action, detail) {
    const entry = {
      ts: Date.now(),
      time: new Date().toLocaleTimeString('zh-CN', { hour12: false }),
      cat: category,
      act: action,
      detail: detail || null,
    };
    _history.push(entry);
    if (_history.length > MAX_HISTORY) _history.shift();

    const detailStr = detail ? ' ' + _summarize(detail) : '';
    console.log(LOG_PREFIX, LOG_STYLE, `[${entry.time}] ${category}::${action}${detailStr}`);
  }

  // 简化 detail 对象为可读字符串（避免打印大对象）
  function _summarize(obj) {
    if (typeof obj === 'string') return obj;
    try {
      const keys = Object.keys(obj);
      const parts = [];
      for (const k of keys.slice(0, 8)) {
        let v = obj[k];
        if (v === undefined || v === null) continue;
        if (typeof v === 'string' && v.length > 80) v = v.slice(0, 77) + '…';
        if (typeof v === 'object') v = Array.isArray(v) ? `[${v.length}]` : '{…}';
        parts.push(`${k}=${v}`);
      }
      return parts.join(', ');
    } catch (_) { return String(obj); }
  }

  // dump 全部日志
  function dump() {
    console.group('[UAL] 完整行为日志 (' + _history.length + ' 条)');
    for (const e of _history) {
      const d = e.detail ? ' ' + _summarize(e.detail) : '';
      console.log(`[${e.time}] ${e.cat}::${e.act}${d}`);
    }
    console.groupEnd();
  }

  // ── 1. 全局 Click 拦截（事件委托） ──────────────────────────────────
  document.addEventListener('click', (e) => {
    const target = e.target;
    // 忽略非交互元素的冒泡
    const interactiveEl = target.closest('button, a, [onclick], .nav-tab, .emp-card, .gc-mention, .gc-task-link, .preset-card, .emp-menu-item, .session-card, .workspace-tab, .emp-filter-btn, .preset-cat-btn, .approval-btn');
    if (!interactiveEl) return;

    const info = _describeElement(interactiveEl);
    log('click', info.type, info.detail);
  }, true); // capture phase to log before handlers

  function _describeElement(el) {
    const tag = el.tagName.toLowerCase();
    const id  = el.id || '';
    const cls = el.className && typeof el.className === 'string' ? el.className : '';
    const text = (el.textContent || '').trim().slice(0, 40);
    const title = el.title || el.getAttribute('aria-label') || '';

    // 导航标签
    if (cls.includes('nav-tab')) {
      const panel = el.dataset.panel || el.dataset.label || text;
      return { type: 'nav-tab', detail: { panel } };
    }
    // 员工卡片
    if (cls.includes('emp-card') || el.closest('.emp-card')) {
      const card = el.closest('.emp-card') || el;
      const empName = card.querySelector('.emp-card-name')?.textContent || '';
      return { type: 'emp-card', detail: { empName: empName.trim() } };
    }
    // 员工菜单项
    if (cls.includes('emp-menu-item')) {
      return { type: 'emp-menu', detail: { label: text } };
    }
    // @mention 点击
    if (cls.includes('gc-mention')) {
      return { type: '@mention-click', detail: { name: text } };
    }
    // 任务链接
    if (cls.includes('gc-task-link')) {
      return { type: 'task-link', detail: { taskId: el.dataset.taskId || text } };
    }
    // 预设卡片
    if (cls.includes('preset-card')) {
      return { type: 'preset-card', detail: { label: text.slice(0, 30) } };
    }
    // 预设分类
    if (cls.includes('preset-cat-btn')) {
      return { type: 'preset-category', detail: { cat: el.dataset.cat || text } };
    }
    // 员工筛选
    if (cls.includes('emp-filter-btn')) {
      return { type: 'emp-filter', detail: { filter: el.dataset.filter || text } };
    }
    // 工作区标签
    if (cls.includes('workspace-tab')) {
      return { type: 'workspace-tab', detail: { tab: el.dataset.tab || text } };
    }
    // 审批按钮
    if (cls.includes('approval-btn')) {
      return { type: 'approval', detail: { action: text } };
    }
    // session 卡片
    if (cls.includes('session-card') || el.closest('.session-card')) {
      return { type: 'session-card', detail: { label: text.slice(0, 30) } };
    }
    // 通用按钮
    if (tag === 'button') {
      const label = title || text || id || '(anonymous)';
      return { type: 'button', detail: { id, label: label.slice(0, 40) } };
    }
    // 链接
    if (tag === 'a') {
      return { type: 'link', detail: { href: (el.href || '').slice(0, 60), text: text.slice(0, 30) } };
    }
    // 其他可点击
    return { type: 'element', detail: { tag, id, text: text.slice(0, 30) } };
  }

  // ── 2. 全局键盘快捷键追踪 ──────────────────────────────────────────
  document.addEventListener('keydown', (e) => {
    // 仅记录有修饰键的快捷键（Ctrl/Cmd + 字母/数字）或 ESC/Enter 等特殊键
    const isMod = e.ctrlKey || e.metaKey;
    const isSpecial = ['Escape', 'F1', 'F2', 'F3', 'F5', 'Delete'].includes(e.key);

    if (!isMod && !isSpecial) return;

    const combo = [
      e.ctrlKey ? 'Ctrl' : '',
      e.metaKey ? 'Cmd' : '',
      e.shiftKey ? 'Shift' : '',
      e.altKey ? 'Alt' : '',
      e.key,
    ].filter(Boolean).join('+');

    log('keyboard', 'shortcut', { combo, target: (e.target.id || e.target.tagName).slice(0, 20) });
  }, true);

  // ── 3. 关键函数 Wrapper ────────────────────────────────────────────
  //    在 DOMContentLoaded 之后包装已定义的全局函数
  function _wrapAll() {
    // — 消息发送 —
    _wrapFn('send', 'message', 'send', () => {
      const msg = document.getElementById('msg');
      const text = msg ? msg.value.trim() : '';
      const isGroup = typeof GROUP_CHAT_STATE !== 'undefined' && GROUP_CHAT_STATE.isOpen;
      return { textLen: text.length, textPreview: text.slice(0, 50), isGroupChat: isGroup };
    });

    // — 员工操作 —
    _wrapFn('selectEmployee', 'employee', 'select', (id, fromUser) => {
      const emp = typeof getEmployee === 'function' ? getEmployee(id) : null;
      return { id, name: emp?.name, fromUser: !!fromUser };
    });
    _wrapFn('createEmployee', 'employee', 'create', (opts) => ({
      name: opts?.name, role: opts?.role, model: opts?.model,
    }));
    _wrapFn('deleteEmployee', 'employee', 'delete', (id) => {
      const emp = typeof getEmployee === 'function' ? getEmployee(id) : null;
      return { id, name: emp?.name };
    });
    _wrapFn('showEmployeeDialog', 'employee', 'open-create-dialog');
    _wrapFn('showEditEmployeeDialog', 'employee', 'open-edit-dialog', (id) => ({ id }));

    // — 面板 / 导航 —
    _wrapFn('switchPanel', 'panel', 'switch', (name) => ({ panel: name }));
    _wrapFn('toggleSettings', 'panel', 'toggle-settings');
    _wrapFn('togglePanel', 'panel', 'toggle', (which) => ({ which }));
    _wrapFn('openGroupChat', 'panel', 'open-group-chat');
    _wrapFn('closeRightPanel', 'panel', 'close-right-panel');
    _wrapFn('openEmployeeChat', 'panel', 'open-employee-chat', (empId, taskId) => ({ empId, taskId }));

    // — 总群 & 委派 —
    _wrapFn('sendGroupMessage', 'group-chat', 'send-message', (text) => ({
      textLen: text?.length, textPreview: (text || '').slice(0, 50),
    }));
    _wrapFn('_dispatchTaskToEmployee', 'delegation', 'dispatch', (empName, taskContent, taskId, opts) => ({
      empName, taskId, orchestrate: opts?.orchestrate,
    }));
    _wrapFn('_startDelegatedJob', 'delegation', 'start-job', (emp, ctx) => ({
      empName: emp?.name, taskId: ctx?.id,
    }));
    _wrapFn('_retryGhostTask', 'delegation', 'retry-ghost', (taskId) => ({ taskId }));
    _wrapFn('_cancelCurrentJob', 'delegation', 'cancel-job', (empId, jobId) => ({ empId, jobId }));
    _wrapFn('toggleAutoOrchestrate', 'delegation', 'toggle-auto-orchestrate');
    _wrapFn('jumpToGroupChatTask', 'delegation', 'jump-to-task', (taskId) => ({ taskId }));

    // — 工作区 —
    _wrapFn('switchCanvasWorkspace', 'workspace', 'switch-canvas', (path) => ({ path }));
    _wrapFn('switchToWorkspace', 'workspace', 'switch-to', (path, name) => ({ path, name }));
    _wrapFn('addWorkspace', 'workspace', 'add');
    _wrapFn('removeWorkspace', 'workspace', 'remove', (path) => ({ path }));
    _wrapFn('switchWorkspaceTab', 'workspace', 'switch-tab', (tab) => ({ tab }));

    // — 消息操作 —
    _wrapFn('editMessage', 'message', 'edit');
    _wrapFn('regenerateResponse', 'message', 'regenerate');
    _wrapFn('copyMsg', 'message', 'copy');
    _wrapFn('cancelStream', 'message', 'cancel-stream');

    // — Session —
    _wrapFn('loadSession', 'session', 'load', (id) => ({ sessionId: id }));
    _wrapFn('newChat', 'session', 'new-chat');

    // — 模型 —
    _wrapFn('toggleModelDropdown', 'model', 'toggle-dropdown');
    _wrapFn('selectModelFromDropdown', 'model', 'select', (value) => ({ model: value }));

    // — 技能 —
    _wrapFn('assignSkillToEmployee', 'skill', 'assign', (empId, skillName) => ({ empId, skillName }));
    _wrapFn('removeEmployeeSkill', 'skill', 'remove', (empId, skillName) => ({ empId, skillName }));

    // — 审批 —
    _wrapFn('respondApproval', 'approval', 'respond', (action) => ({ action }));
    _wrapFn('respondClarify', 'approval', 'clarify-respond');

    // — 画布 —
    _wrapFn('canvasZoom', 'canvas', 'zoom', (dir) => ({ direction: dir }));
    _wrapFn('saveCanvasData', 'canvas', 'save');

    // — 设置 —
    _wrapFn('saveSettings', 'settings', 'save', (andClose) => ({ andClose }));

    log('system', 'init', { wrappedFunctions: _wrappedCount, timestamp: new Date().toISOString() });
  }

  let _wrappedCount = 0;

  /**
   * 安全地包装全局函数：在原函数执行前记录日志
   * @param {string} fnName   全局函数名
   * @param {string} category 日志分类
   * @param {string} action   日志动作
   * @param {Function} [detailFn] 从参数生成 detail 对象的函数（可选）
   */
  function _wrapFn(fnName, category, action, detailFn) {
    if (typeof window[fnName] !== 'function') return;
    const original = window[fnName];
    window[fnName] = function (...args) {
      try {
        const detail = detailFn ? detailFn.apply(null, args) : undefined;
        log(category, action, detail || undefined);
      } catch (_) { /* 日志不能影响业务 */ }
      return original.apply(this, args);
    };
    // 保留原始函数引用，方便调试
    window[fnName]._original = original;
    window[fnName]._ualWrapped = true;
    _wrappedCount++;
  }

  // ── 4. 消息输入追踪（带去抖） ──────────────────────────────────────
  let _inputTimer = null;
  document.addEventListener('input', (e) => {
    const target = e.target;
    if (!target) return;
    // 只关心消息输入框和搜索框
    const id = target.id || '';
    if (!['msg', 'empSearch', 'clarifyInput'].includes(id) && !target.closest('.gc-members-search, .emp-subs-search')) return;

    clearTimeout(_inputTimer);
    _inputTimer = setTimeout(() => {
      const val = (target.value || '').trim();
      if (!val) return;
      log('input', 'typing', { field: id || target.className?.split(' ')[0] || 'unknown', length: val.length, preview: val.slice(0, 30) });
    }, 800); // 800ms 去抖，避免每次按键都记录
  }, true);

  // ── 5. 文件附件 ────────────────────────────────────────────────────
  document.addEventListener('change', (e) => {
    if (e.target.id === 'fileInput' && e.target.files) {
      const files = Array.from(e.target.files).map(f => ({ name: f.name, size: f.size, type: f.type }));
      log('file', 'attach', { count: files.length, files: files.slice(0, 5) });
    }
  }, true);

  // ── 6. 页面生命周期 ────────────────────────────────────────────────
  window.addEventListener('beforeunload', () => {
    log('system', 'page-unload', { historyLen: _history.length });
  });

  window.addEventListener('visibilitychange', () => {
    log('system', 'visibility', { hidden: document.hidden });
  });

  // ── 挂载到 window + 延迟 wrap ──────────────────────────────────────
  window.UAL = { log, history: _history, dump };

  // boot.js 是最后加载的，所以用 load 事件确保所有函数已定义
  if (document.readyState === 'complete') {
    _wrapAll();
  } else {
    window.addEventListener('load', _wrapAll);
  }

  log('system', 'module-loaded', { readyState: document.readyState });
})();
