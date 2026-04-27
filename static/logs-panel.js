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
const _TOKEN_GROUP_MAX_LEN = 500;  // max chars before forcing a new group

// Track recently flushed token groups to prevent duplicate group rendering
const _flushedTokenGroups = new Map();  // key -> ts
const _FLUSHED_GROUP_MAX = 200;
const _FLUSHED_GROUP_TTL_MS = 5000;  // 5s dedup window for identical content

// Track sessions that have finished (done/cancel/error) so we ignore late stray tokens/tools
const _completedSessions = new Set();
const _COMPLETED_SESSIONS_MAX = 500;

// ── SSE Connection ─────────────────────────────────────────────────────────

function connectLogsSSE() {
  if (_logsSSE && _logsSSE.readyState !== EventSource.CLOSED) return; // already connected

  _logsSSE = new EventSource(
    new URL('/api/logs/stream', location.origin).href,
    { withCredentials: true }
  );

  _logsSSE.addEventListener('token', (e) => {
    try { console.log('[logs-panel] token event', e.data.slice(0,80)); _handleTokenEvent(JSON.parse(e.data)); } catch(err) { console.warn('[logs-panel] token parse error', err); }
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
  if (_activeTokenGroup &&
      _activeTokenGroup.session_id === sid &&
      _activeTokenGroup.employee_name === empName &&
      _activeTokenGroup.text.length < _TOKEN_GROUP_MAX_LEN) {
    _activeTokenGroup.text += text;
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
  const logsContent = document.getElementById('logsContent');
  const isActive = logsContent && logsContent.classList.contains('active');
  if (!isActive) {
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
    const logsContent = document.getElementById('logsContent');
    const isActive = logsContent && logsContent.classList.contains('active');
    if (!isActive) return;

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

  const logsContent = document.getElementById('logsContent');
  const isActive = logsContent && logsContent.classList.contains('active');
  if (!isActive) return;

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
    default:
      entry.message = JSON.stringify(data).slice(0, 120);
  }

  _logEntries.push(entry);
  if (_logEntries.length > _LOG_MAX_ENTRIES) {
    _logEntries.splice(0, _logEntries.length - _LOG_MAX_ENTRIES);
  }

  // Only render if the log panel is active/visible
  const logsContent = document.getElementById('logsContent');
  const isActive = logsContent && logsContent.classList.contains('active');
  if (!isActive) return;

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
