/**
 * logs-panel.js — 实时日志面板
 * 连接 /api/logs/stream SSE，实时显示所有 agent 的 token/tool/done/error 事件。
 *
 * 关键设计：token 事件合并显示（不是每 token 一行，而是按 session 分组追加），
 * done 事件后插入视觉分隔线，明确标识会话边界。
 */

// ── State ──────────────────────────────────────────────────────────────────
let _logsSSE = null;           // EventSource instance
let _logFilter = 'all';        // 'all' | 'token' | 'tool' | 'done' | 'user_input' | 'delegation'
let _logSearchQuery = '';      // search filter string
let _logEntries = [];          // all entries for current session
const _LOG_MAX_ENTRIES = 2000; // keep last N entries in memory

// Deduplication: track seen _log_id values to prevent duplicate entries from SSE reconnects
const _seenLogIds = new Set();
const _SEEN_LOG_IDS_MAX = 3000;

// Token merging: instead of one row per token, we group consecutive tokens
// from the same session into a single "token group" entry.
let _activeTokenGroup = null;  // { session_id, employee_name, text, ts, _log_id }
//
// ★ 2026-04-27 Bug 修复：原值 500 会把"一次完整的模型回复"从第 500 个字起
//   被强制切成第二条日志；用户在日志面板看到一个 response 被拆成 2~N 段，
//   视觉上完全不连贯（见用户反馈的截图：同一次 SOP 分派被切成 15:55 + 15:56
//   两条日志）。
//
//   正确的切分边界在别处：done / tool / approval / clarify / cancel /
//   employee_created / team_created / apperror / compressed —— 这些事件
//   都已经在其 SSE handler 里主动调用 _flushTokenGroup()，把"一次模型
//   token 流"自然终结。也就是说：只要没有任何"终结事件"进来，所有 token
//   都应该合并到同一个 group。
//
//   把上限从 500 提到 100k：保留极端兜底（防止极个别 runaway 的 token
//   流把 DOM 里一条日志撑到百万字级导致滚动卡顿），但不再影响任何正常
//   回复。100k 相当于一次性吐出 ~30 万字中文文本才会触发切分。
const _TOKEN_GROUP_MAX_LEN = 100000;  // safety cap only; real boundary is done/tool/etc events

// Track recently flushed token groups to prevent duplicate group rendering
const _flushedTokenGroups = new Map();  // key -> ts
const _FLUSHED_GROUP_MAX = 200;
const _FLUSHED_GROUP_TTL_MS = 5000;  // 5s dedup window for identical content

// Track sessions that have finished (done/cancel/error) so we ignore late stray tokens/tools
const _completedSessions = new Set();
const _COMPLETED_SESSIONS_MAX = 500;

// ── Panel visibility detection ──────────────────────────────────────────────
// ★ 2026-04-27 Bug 修复：日志面板已从中栏迁移到右栏输出区（outputPanelLogs）。
//   原代码仍在检查旧占位 `#logsContent`，但它在 index.html 里被标为 display:none
//   的兼容占位，永远不会被加上 .active class。结果：
//     - isActive 永远 false
//     - 所有 SSE 事件（token/tool/done/...）只 push 到 _logEntries，DOM 不更新
//     - 用户点"全部"按钮 → _reRenderLogs 不检查 isActive，直接重建 DOM → 才看到历史
//   修复：把激活判定统一放到 _isLogsPanelActive()，同时兼容两套 DOM：
//     - 新版：右栏输出区 #outputPanelLogs.active
//     - 旧版：中栏 #logsContent.active（某些老布局可能仍在用）
//   只要其中一个处于激活态且 #logsList 容器存在，就视为可渲染。
function _isLogsPanelActive() {
  const container = document.getElementById('logsList');
  if (!container) return false;
  // 新版容器（右栏输出区）
  const outputPanel = document.getElementById('outputPanelLogs');
  if (outputPanel && outputPanel.classList.contains('active')) return true;
  // 旧版容器（中栏占位）
  const legacy = document.getElementById('logsContent');
  if (legacy && legacy.classList.contains('active')) return true;
  // ★ 最终兜底：直接看 #logsList 本身是否实际可见（offsetParent != null）
  //   这覆盖了任何未来可能再次迁移的布局：只要容器在 DOM 树里且没被
  //   祖先 display:none 隐藏，就认为可渲染。
  //   offsetParent 为 null 意味着元素或某个祖先 display:none。
  return container.offsetParent !== null;
}

// ── SSE Connection ─────────────────────────────────────────────────────────

function connectLogsSSE() {
  if (_logsSSE && _logsSSE.readyState !== EventSource.CLOSED) return; // already connected

  _logsSSE = new EventSource(
    new URL('/api/logs/stream', location.origin).href,
    { withCredentials: true }
  );

  _logsSSE.addEventListener('token', (e) => {
    try { _handleTokenEvent(JSON.parse(e.data)); } catch(err) { console.warn('[logs-panel] token parse error', err); }
  });
  // ★ 2026-04-28：添加 reasoning 事件监听，flush 当前 token group。
  //   模型输出 reasoning（如 Claude extended thinking）时，token 流会被中断，
  //   需要 flush 已累积的 token group，避免 reasoning 结束后的新 token 被错误合并。
  _logsSSE.addEventListener('reasoning', (e) => {
    try { _flushTokenGroup(); } catch(err) {}
  });
  _logsSSE.addEventListener('tool', (e) => {
    try { console.log('[logs-panel] tool event', e.data.slice(0,80)); _flushTokenGroup(); _appendLogEntry(JSON.parse(e.data), 'tool'); } catch(err) { console.warn('[logs-panel] tool parse error', err); }
  });
  _logsSSE.addEventListener('done', (e) => {
    try {
      console.log('[logs-panel] done event', e.data.slice(0,80));
      _flushTokenGroup();
      const data = JSON.parse(e.data);
      _appendLogEntry(data, 'done');
      _appendSessionSeparator(data);
    } catch(err) { console.warn('[logs-panel] done parse error', err); }
  });
  _logsSSE.addEventListener('error', (e) => {
    // SSE 'error' event is a connection error (e.data is undefined); agent errors come via 'apperror'
    console.warn('[logs-panel] SSE connection error, readyState=', _logsSSE?.readyState);
  });
  _logsSSE.addEventListener('cancel', (e) => {
    try { console.log('[logs-panel] cancel event', e.data.slice(0,80)); _flushTokenGroup(); _appendLogEntry(JSON.parse(e.data), 'cancel'); } catch(err) { console.warn('[logs-panel] cancel parse error', err); }
  });
  _logsSSE.addEventListener('approval', (e) => {
    try { console.log('[logs-panel] approval event', e.data.slice(0,80)); _flushTokenGroup(); _appendLogEntry(JSON.parse(e.data), 'approval'); } catch(err) { console.warn('[logs-panel] approval parse error', err); }
  });
  _logsSSE.addEventListener('clarify', (e) => {
    try { console.log('[logs-panel] clarify event', e.data.slice(0,80)); _flushTokenGroup(); _appendLogEntry(JSON.parse(e.data), 'clarify'); } catch(err) { console.warn('[logs-panel] clarify parse error', err); }
  });
  _logsSSE.addEventListener('employee_created', (e) => {
    try { console.log('[logs-panel] employee_created event', e.data.slice(0,80)); _flushTokenGroup(); _appendLogEntry(JSON.parse(e.data), 'employee_created'); } catch(err) { console.warn('[logs-panel] employee_created parse error', err); }
  });
  _logsSSE.addEventListener('team_created', (e) => {
    try { console.log('[logs-panel] team_created event', e.data.slice(0,80)); _flushTokenGroup(); _appendLogEntry(JSON.parse(e.data), 'team_created'); } catch(err) { console.warn('[logs-panel] team_created parse error', err); }
  });
  _logsSSE.addEventListener('compressed', (e) => {
    try { console.log('[logs-panel] compressed event', e.data.slice(0,80)); _appendLogEntry(JSON.parse(e.data), 'compressed'); } catch(err) { console.warn('[logs-panel] compressed parse error', err); }
  });
  _logsSSE.addEventListener('apperror', (e) => {
    try { console.log('[logs-panel] apperror event', e.data.slice(0,80)); _flushTokenGroup(); _appendLogEntry(JSON.parse(e.data), 'error'); } catch(err) { console.warn('[logs-panel] apperror parse error', err); }
  });
  _logsSSE.addEventListener('user_input', (e) => {
    try { _flushTokenGroup(); _appendLogEntry(JSON.parse(e.data), 'user_input'); } catch(err) { console.warn('[logs-panel] user_input parse error', err); }
  });
  _logsSSE.addEventListener('delegation', (e) => {
    try { _flushTokenGroup(); _appendLogEntry(JSON.parse(e.data), 'delegation'); } catch(err) { console.warn('[logs-panel] delegation parse error', err); }
  });
  _logsSSE.addEventListener('group_message', (e) => {
    try { _flushTokenGroup(); _appendLogEntry(JSON.parse(e.data), 'group_message'); } catch(err) { console.warn('[logs-panel] group_message parse error', err); }
  });
  _logsSSE.addEventListener('employee_session_bound', (e) => {
    // No need to show in log panel — it's an internal event
  });

  _logsSSE.onerror = (e) => {
    console.warn('[logs-panel] SSE error, readyState=', _logsSSE?.readyState, e);
  };

  _logsSSE.onopen = () => {
    console.log('[logs-panel] SSE connected to /api/logs/stream');
  };
}

function disconnectLogsSSE() {
  if (_logsSSE) {
    _logsSSE.close();
    _logsSSE = null;
  }
}

// ── Token Grouping ──────────────────────────────────────────────────────────
// Instead of creating a new row for every token, we merge consecutive tokens
// from the same session into a single "token group" entry. This dramatically
// reduces noise in the log panel.

function _handleTokenEvent(data) {
  const sid = data.session_id || '';
  const empName = data.employee_name || '';
  const text = data.text || '';

  // Ignore tokens for sessions that have already finished
  if (_completedSessions.has(sid)) return;

  // If we have an active token group from the same session, append to it
  // ★ 2026-04-28 修复：放宽合并条件，只要求 session_id 相同即可合并。
  //   employee_name 可能因后端事件属性不一致导致同 session 的 token 被拆分，
  //   产生"每个 token 一行"的错误换行问题。
  if (_activeTokenGroup &&
      _activeTokenGroup.session_id === sid &&
      _activeTokenGroup.text.length < _TOKEN_GROUP_MAX_LEN) {
    _activeTokenGroup.text += text;
    // 如果 employee_name 不一致，取较长的那个（更可能是有值的）
    if (empName && (!_activeTokenGroup.employee_name || empName.length > _activeTokenGroup.employee_name.length)) {
      _activeTokenGroup.employee_name = empName;
      // 同步更新 DOM 中的员工名显示
      if (_activeTokenGroup._domEl) {
        const empEl = _activeTokenGroup._domEl.querySelector('.log-employee');
        if (empEl) empEl.textContent = empName;
      }
    }
    if (data._log_id) {
      _activeTokenGroup._log_ids = _activeTokenGroup._log_ids || [];
      _activeTokenGroup._log_ids.push(data._log_id);
    }
    _updateActiveTokenGroupDOM();
    return;
  }

  // Flush any previous token group
  _flushTokenGroup();

  // Start a new token group
  _activeTokenGroup = {
    session_id: sid,
    employee_name: empName,
    text: text,
    ts: data.ts || Date.now() / 1000,
    _domEl: null,
    _log_ids: data._log_id ? [data._log_id] : [],
  };

  // ★ 2026-04-27 Bug 修复：新建 token group 后立即触发一次 DOM 创建。
  //   原代码只在"追加到既存 group"的路径调 _updateActiveTokenGroupDOM，
  //   新开一段 token 流时的第一个 token 不会进入 DOM，必须等第 2+ 个 token
  //   才出现——用户感受就是"前几 token 看不见 / 延迟显示"。
  //   现在新建 group 后也主动调一次，第 1 个 token 就会立刻可见。
  _updateActiveTokenGroupDOM();
}

function _flushTokenGroup() {
  if (!_activeTokenGroup) return;
  const group = _activeTokenGroup;
  _activeTokenGroup = null;

  if (!group.text.trim()) {
    // 空文本：如果已创建过 DOM，清理掉
    if (group._domEl && group._domEl.parentNode) {
      group._domEl.parentNode.removeChild(group._domEl);
    }
    return;
  }

  // ★ Deduplication for token groups: skip if we've recently rendered identical content
  const groupKey = group.session_id + '\x00' + group.employee_name + '\x00' + group.text;
  const now = Date.now();
  // Clean expired entries
  for (const [k, ts] of _flushedTokenGroups) {
    if (now - ts > _FLUSHED_GROUP_TTL_MS) {
      _flushedTokenGroups.delete(k);
    }
  }
  if (_flushedTokenGroups.has(groupKey)) {
    // Already rendered this exact text for this session recently — skip.
    // 如果本 group 之前通过 _updateActiveTokenGroupDOM 附加过 DOM，也要清理
    if (group._domEl && group._domEl.parentNode) {
      group._domEl.parentNode.removeChild(group._domEl);
    }
    return;
  }
  _flushedTokenGroups.set(groupKey, now);
  while (_flushedTokenGroups.size > _FLUSHED_GROUP_MAX) {
    const first = _flushedTokenGroups.keys().next().value;
    _flushedTokenGroups.delete(first);
  }

  // Also check _seenLogIds if the group carries _log_ids
  if (group._log_ids && group._log_ids.length) {
    const primaryId = group._log_ids[0];
    if (primaryId && _seenLogIds.has(primaryId)) {
      if (group._domEl && group._domEl.parentNode) {
        group._domEl.parentNode.removeChild(group._domEl);
      }
      return;
    }
    if (primaryId) {
      _seenLogIds.add(primaryId);
      while (_seenLogIds.size > _SEEN_LOG_IDS_MAX) {
        const first = _seenLogIds.values().next().value;
        _seenLogIds.delete(first);
      }
    }
  }

  // Create a log entry for the token group
  const entry = {
    event: 'token',
    ts: group.ts,
    session_id: group.session_id,
    employee_name: group.employee_name,
    text: group.text,
    _log_id: group._log_ids && group._log_ids.length ? group._log_ids[0] : '',
  };

  // ★ 避免 _logEntries 中出现与 group._domEl 对应的重复条目：
  //   如果 _updateActiveTokenGroupDOM 已经把此 group 的 DOM 挂上了，
  //   仅需 push entry 并做最终文本刷新，不再 append 新 DOM
  _logEntries.push(entry);
  if (_logEntries.length > _LOG_MAX_ENTRIES) {
    _logEntries.splice(0, _logEntries.length - _LOG_MAX_ENTRIES);
  }

  // Only render if the log panel is active/visible
  if (!_isLogsPanelActive()) {
    // 若已经挂了 DOM 但面板不可见，保留 DOM 引用以便后续渲染
    return;
  }

  const container = document.getElementById('logsList');
  if (!container) return;
  if (!_logEntryMatches(entry)) {
    // 不匹配过滤器：若已有 DOM 需要移除
    if (group._domEl && group._domEl.parentNode) {
      group._domEl.parentNode.removeChild(group._domEl);
    }
    return;
  }

  // ★ 关键修复：如果 group 已经通过 _updateActiveTokenGroupDOM 创建并附加了 DOM，
  //   直接更新其内容到最终完整文本，不再 append 新 DOM（防止重复显示）
  if (group._domEl && container.contains(group._domEl)) {
    const contentEl = group._domEl.querySelector('.log-content');
    if (contentEl) contentEl.textContent = group.text;
    _autoScrollAndTrim(container);
    return;
  }

  // 首次为本 group 创建 DOM（例如收到 tool 事件前尚未触发过 _updateActiveTokenGroupDOM）
  const el = _buildLogRow(entry);
  container.appendChild(el);
  group._domEl = el;

  _autoScrollAndTrim(container);
}

function _updateActiveTokenGroupDOM() {
  if (!_activeTokenGroup) return;

  // ★ 若 _domEl 已从 document 中分离（例如 _reRenderLogs 清空容器），重置引用
  if (_activeTokenGroup._domEl && !document.body.contains(_activeTokenGroup._domEl)) {
    _activeTokenGroup._domEl = null;
  }

  if (!_activeTokenGroup._domEl) {
    // Need to create DOM element
    if (!_isLogsPanelActive()) return;

    const container = document.getElementById('logsList');
    if (!container) return;

    const entry = {
      event: 'token',
      ts: _activeTokenGroup.ts,
      session_id: _activeTokenGroup.session_id,
      employee_name: _activeTokenGroup.employee_name,
      text: _activeTokenGroup.text,
    };

    if (!_logEntryMatches(entry)) return;

    const el = _buildLogRow(entry);
    container.appendChild(el);
    _activeTokenGroup._domEl = el;

    _autoScrollAndTrim(container);
    return;
  }

  // Update existing DOM element's text content
  const contentEl = _activeTokenGroup._domEl.querySelector('.log-content');
  if (contentEl) {
    contentEl.textContent = _activeTokenGroup.text;
  }

  // Auto-scroll
  const autoScroll = document.getElementById('logsAutoScroll');
  if (autoScroll && autoScroll.checked) {
    const container = document.getElementById('logsList');
    if (container) container.scrollTop = container.scrollHeight;
  }
}

function _autoScrollAndTrim(container) {
  const autoScroll = document.getElementById('logsAutoScroll');
  if (autoScroll && autoScroll.checked) {
    container.scrollTop = container.scrollHeight;
  }
  while (container.children.length > _LOG_MAX_ENTRIES) {
    container.removeChild(container.firstChild);
  }
}

// ── Session Separator ──────────────────────────────────────────────────────

function _appendSessionSeparator(data) {
  const empName = data.employee_name || '';
  const sid = data.session_id || '';

  const entry = {
    event: 'separator',
    ts: data.ts || Date.now() / 1000,
    session_id: sid,
    employee_name: empName,
    text: '',
  };

  _logEntries.push(entry);

  if (!_isLogsPanelActive()) return;

  const container = document.getElementById('logsList');
  if (!container) return;

  const el = document.createElement('div');
  el.className = 'log-separator';
  el.dataset.event = 'separator';
  container.appendChild(el);

  _autoScrollAndTrim(container);
}

// ── Log Entry Rendering ────────────────────────────────────────────────────

function _appendLogEntry(data, eventType) {
  const sid = data.session_id || '';
  const ev = eventType || data.event || 'unknown';

  // ★ Deduplication: skip if we've already seen this _log_id
  const logId = data._log_id || '';
  if (logId) {
    if (_seenLogIds.has(logId)) {
      return; // duplicate entry, skip
    }
    _seenLogIds.add(logId);
    // Evict old IDs to prevent unbounded growth
    while (_seenLogIds.size > _SEEN_LOG_IDS_MAX) {
      const first = _seenLogIds.values().next().value;
      _seenLogIds.delete(first);
    }
  }

  // ★ Fallback deduplication by content hash for entries without _log_id or
  // for robustness against duplicate content from different sources.
  const contentKey = ev + '\x00' + sid + '\x00' + (data.employee_name || '') + '\x00' + (data.text || data.message || data.name || '');
  const contentHash = contentKey; // simple string key is sufficient here
  if (_seenLogIds.has(contentHash)) {
    return; // duplicate by content, skip
  }
  _seenLogIds.add(contentHash);
  while (_seenLogIds.size > _SEEN_LOG_IDS_MAX) {
    const first = _seenLogIds.values().next().value;
    _seenLogIds.delete(first);
  }

  // Block late tool/token/compressed events for sessions that have already finished.
  // done/cancel/error themselves are allowed through because they trigger completion.
  if (_completedSessions.has(sid) && ['token', 'tool', 'compressed'].includes(ev)) {
    return;
  }

  // Mark session as completed on terminal events, and evict old entries if needed
  if (['done', 'cancel', 'error'].includes(ev) && sid) {
    _completedSessions.add(sid);
    while (_completedSessions.size > _COMPLETED_SESSIONS_MAX) {
      const first = _completedSessions.values().next().value;
      _completedSessions.delete(first);
    }
    // If there's an active token group for this session, flush it now
    if (_activeTokenGroup && _activeTokenGroup.session_id === sid) {
      _flushTokenGroup();
    }
  }

  const entry = {
    event: ev,
    ts: data.ts || Date.now() / 1000,
    session_id: sid,
    employee_name: data.employee_name || '',
    _log_id: logId,
  };

  // Extract event-specific payload
  switch (entry.event) {
    case 'token':
      entry.text = data.text || '';
      break;
    case 'tool':
      entry.name = data.name || '';
      entry.preview = data.preview || '';
      entry.args = data.args || {};
      break;
    case 'done':
      entry.message = '会话完成';
      break;
    case 'error':
      entry.message = data.message || data.error || '错误';
      break;
    case 'cancel':
      entry.message = data.message || '已取消';
      break;
    case 'approval':
      entry.message = '审批请求: ' + (data.command || JSON.stringify(data).slice(0, 80));
      break;
    case 'clarify':
      entry.message = '交互提问: ' + (data.question || '').slice(0, 80);
      break;
    case 'employee_created':
      entry.message = '创建员工: ' + (data.name || '');
      break;
    case 'team_created':
      entry.message = '创建团队: ' + ((data.team_name || '') || JSON.stringify(data).slice(0, 80));
      break;
    case 'compressed':
      entry.message = '上下文压缩';
      break;
    case 'user_input':
      entry.message = data.message || ('用户输入: ' + (data.text || '').slice(0, 120));
      entry.text = data.text || '';
      break;
    case 'delegation':
      entry.message = data.message || ('委派任务: ' + (data.target_employee || ''));
      entry.target_employee = data.target_employee || '';
      entry.task_id = data.task_id || '';
      break;
    case 'group_message':
      entry.message = data.message || ('[PM] ' + (data.sender_name || '') + ': ' + (data.text || '').slice(0, 120));
      entry.text = data.text || '';
      entry.sender_name = data.sender_name || '';
      break;
    default:
      entry.message = JSON.stringify(data).slice(0, 120);
  }

  _logEntries.push(entry);
  if (_logEntries.length > _LOG_MAX_ENTRIES) {
    _logEntries.splice(0, _logEntries.length - _LOG_MAX_ENTRIES);
  }

  // Only render if the log panel is active/visible
  if (!_isLogsPanelActive()) return;

  const container = document.getElementById('logsList');
  if (!container) return;

  // Check filter
  if (!_logEntryMatches(entry)) return;

  const el = _buildLogRow(entry);
  container.appendChild(el);

  _autoScrollAndTrim(container);
}

function _logEntryMatches(entry) {
  // Separators always match (they're visual, not content)
  if (entry.event === 'separator') return true;
  // Filter by event type
  if (_logFilter !== 'all' && entry.event !== _logFilter) return false;
  // Filter by search query
  if (_logSearchQuery) {
    const q = _logSearchQuery.toLowerCase();
    const text = [
      entry.employee_name,
      entry.text,
      entry.name,
      entry.preview,
      entry.message,
    ].filter(Boolean).join(' ').toLowerCase();
    if (!text.includes(q)) return false;
  }
  return true;
}

function _buildLogRow(entry) {
  const el = document.createElement('div');
  el.className = 'log-row log-event-' + entry.event;
  el.dataset.event = entry.event;

  const time = document.createElement('span');
  time.className = 'log-time';
  const d = new Date(entry.ts * 1000);
  time.textContent = d.toLocaleTimeString('zh-CN', { hour12: false }) + '.' + String(d.getMilliseconds()).padStart(3, '0');
  el.appendChild(time);

  const badge = document.createElement('span');
  badge.className = 'log-badge log-badge-' + entry.event;
  badge.textContent = _eventBadge(entry.event);
  el.appendChild(badge);

  if (entry.employee_name) {
    const emp = document.createElement('span');
    emp.className = 'log-employee';
    emp.textContent = entry.employee_name;
    el.appendChild(emp);
  }

  const content = document.createElement('span');
  content.className = 'log-content';
  if (entry.event === 'token') {
    content.textContent = entry.text;
  } else if (entry.event === 'tool') {
    content.textContent = entry.name + (entry.preview ? ': ' + entry.preview : '');
  } else if (entry.event === 'delegation' && entry.target_employee) {
    content.textContent = entry.message || ('委派给 ' + entry.target_employee);
  } else {
    content.textContent = entry.message || '';
  }
  el.appendChild(content);

  return el;
}

function _eventBadge(event) {
  switch (event) {
    case 'token': return '✏️';
    case 'tool': return '🔧';
    case 'done': return '✅';
    case 'error': return '❌';
    case 'cancel': return '🚫';
    case 'approval': return '⚠️';
    case 'clarify': return '❓';
    case 'employee_created': return '👤';
    case 'team_created': return '👥';
    case 'compressed': return '📦';
    case 'user_input': return '💬';
    case 'delegation': return '🔀';
    case 'group_message': return '🏠';
    default: return '📋';
  }
}

// ── Filter / Search ────────────────────────────────────────────────────────

function setLogFilter(filter, btn) {
  _flushTokenGroup();
  _logFilter = filter;
  document.querySelectorAll('.logs-filter-btn').forEach(b => b.classList.remove('active'));
  if (btn) btn.classList.add('active');
  _reRenderLogs();
}

function filterLogs() {
  const input = document.getElementById('logsSearch');
  _logSearchQuery = input ? input.value.trim() : '';
  _reRenderLogs();
}

function _reRenderLogs() {
  const container = document.getElementById('logsList');
  if (!container) return;
  container.innerHTML = '';
  const frag = document.createDocumentFragment();
  for (const entry of _logEntries) {
    if (!_logEntryMatches(entry)) continue;
    if (entry.event === 'separator') {
      const sep = document.createElement('div');
      sep.className = 'log-separator';
      sep.dataset.event = 'separator';
      frag.appendChild(sep);
    } else {
      frag.appendChild(_buildLogRow(entry));
    }
  }
  container.appendChild(frag);
  const autoScroll = document.getElementById('logsAutoScroll');
  if (autoScroll && autoScroll.checked) {
    container.scrollTop = container.scrollHeight;
  }
}

function clearLogs() {
  _logEntries = [];
  _activeTokenGroup = null;
  const container = document.getElementById('logsList');
  if (container) container.innerHTML = '';
}

// ── Auto-connect on page load ────────────────────────────────────────────────
// Connect SSE early so we don't miss events even before the user opens the log tab.
// Events received while the tab is hidden are stored in _logEntries and rendered
// when the user switches to the logs tab.
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => setTimeout(connectLogsSSE, 500));
} else {
  setTimeout(connectLogsSSE, 500);
}
