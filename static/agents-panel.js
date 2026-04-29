/**
 * agents-panel.js — 异步子 Agents 状态面板
 *
 * 功能：
 *  - 显示当前员工会话下所有通过 spawn_agent 派生的后台子 agent
 *  - 支持 Steer（发送引导消息）与 Cancel（取消）
 *  - 仅在 Agents tab 激活时自动轮询（3 秒一次），切走后停止
 *
 * 后端 API：见 api/agents.py
 *  - GET  /api/agents?session_id=<parent_sid>
 *  - POST /api/agents/steer  { session_id, child_session_id, message }
 *  - POST /api/agents/cancel { session_id, child_session_id }
 */

(function() {
  'use strict';

  const POLL_INTERVAL_MS = 3000;
  let _pollTimer = null;
  let _isActive = false;

  /** 获取当前 parent session_id（员工会话或总群）。 */
  function _getParentSessionId() {
    try {
      if (typeof GROUP_CHAT_STATE !== 'undefined' && GROUP_CHAT_STATE.isOpen) {
        return GROUP_CHAT_STATE.sessionId || null;
      }
      if (typeof S !== 'undefined' && S.session) {
        return S.session.session_id || null;
      }
    } catch (_) {}
    return null;
  }

  /** 发起一次刷新（获取并渲染当前 session 的子 agents 状态）。 */
  async function refreshAgentsPanel() {
    const sid = _getParentSessionId();
    const listEl = document.getElementById('agentsList');
    const badgeEl = document.getElementById('outAgentsBadge');
    const hintEl = document.getElementById('agentsHint');

    if (!sid) {
      _renderEmpty(listEl, '未选择会话', `请先打开一个员工聊天或${typeof PM_NAME !== 'undefined' ? PM_NAME : 'PM专员'}`);
      if (badgeEl) badgeEl.style.display = 'none';
      if (hintEl) hintEl.textContent = '未选择会话';
      return;
    }

    try {
      const resp = await fetch(`/api/agents?session_id=${encodeURIComponent(sid)}`);
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      const data = await resp.json();
      const children = Array.isArray(data.children) ? data.children : [];

      // 更新 tab badge：仅计数活跃（pending/running/steered）
      const activeCount = children.filter(c =>
        c.status === 'pending' || c.status === 'running' || c.status === 'steered'
      ).length;
      if (badgeEl) {
        if (activeCount > 0) {
          badgeEl.textContent = String(activeCount);
          badgeEl.style.display = '';
        } else {
          badgeEl.style.display = 'none';
        }
      }

      if (hintEl) {
        if (!data.runner_active) {
          hintEl.textContent = '会话已结束，无活跃子 agent';
        } else if (children.length === 0) {
          hintEl.textContent = '当前无子 agent';
        } else {
          hintEl.textContent = `共 ${children.length} 个（活跃 ${activeCount}）`;
        }
      }

      if (!children.length) {
        _renderEmpty(
          listEl,
          '暂无运行中的异步子 agent',
          '当员工 agent 调用 spawn_agent 派生后台子 agent 时，这里会显示其状态、Steer、取消按钮。'
        );
        return;
      }

      _renderList(listEl, sid, children);
    } catch (e) {
      console.warn('[agents-panel] refresh failed:', e);
      _renderEmpty(listEl, '加载失败', String(e && e.message || e));
    }
  }
  window.refreshAgentsPanel = refreshAgentsPanel;

  function _renderEmpty(listEl, title, hint) {
    if (!listEl) return;
    listEl.innerHTML =
      `<div class="agents-empty">` +
      `<svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="9" cy="7" r="4"/><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg>` +
      `<div class="agents-empty-title">${_esc(title)}</div>` +
      `<div class="agents-empty-hint">${_esc(hint)}</div>` +
      `</div>`;
  }

  function _renderList(listEl, parentSid, children) {
    if (!listEl) return;
    // 按状态排序：active（运行/steered/pending）在前，completed 次之，failed 最后
    const order = { 'running': 0, 'steered': 0, 'pending': 1, 'completed': 2, 'failed': 3, 'timed_out': 3, 'interrupted': 3, 'error': 3 };
    const sorted = children.slice().sort((a, b) => (order[a.status] ?? 9) - (order[b.status] ?? 9));
    listEl.innerHTML = sorted.map(c => _renderCard(parentSid, c)).join('');
  }

  function _renderCard(parentSid, c) {
    const sid = c.session_id || '';
    const status = (c.status || 'unknown').toLowerCase();
    const label = c.label || c.goal || '(未命名任务)';
    const goal = c.goal || '';
    const elapsed = (typeof c.elapsed_seconds === 'number') ? `${c.elapsed_seconds.toFixed(1)}s` : '';
    const empName = c.employee_name || '';
    const steerCount = c.steer_count || 0;
    const role = c.role || '';

    const isActive = (status === 'pending' || status === 'running' || status === 'steered');
    const canSteer = isActive;
    const canCancel = isActive;

    return `
      <div class="agent-card" data-child-sid="${_esc(sid)}">
        <div class="agent-card-head">
          <span class="agent-card-avatar">${empName ? '👤' : '🤖'}</span>
          <span class="agent-card-name" title="${_esc(label)}">${_esc(empName || label)}</span>
          <span class="agent-card-status ${_esc(status)}">${_esc(status)}</span>
        </div>
        <div class="agent-card-goal" title="${_esc(goal)}">${_esc(goal)}</div>
        <div class="agent-card-meta">
          ${elapsed ? `<span class="agent-meta-item" title="已运行时长">⏱ ${_esc(elapsed)}</span>` : ''}
          ${role ? `<span class="agent-meta-item" title="角色">${_esc(role)}</span>` : ''}
          ${steerCount > 0 ? `<span class="agent-meta-item" title="Steer 次数">📡 ${steerCount}</span>` : ''}
          <span class="agent-meta-item agent-meta-sid" title="子会话 ID">#${_esc(sid.slice(-8))}</span>
        </div>
        <div class="agent-card-actions">
          <button class="agent-card-btn" onclick="_toggleSteerBox('${_esc(sid)}')" ${canSteer ? '' : 'disabled'}>📡 Steer</button>
          <button class="agent-card-btn danger" onclick="_cancelChildAgent('${_esc(parentSid)}','${_esc(sid)}')" ${canCancel ? '' : 'disabled'}>⏹ 取消</button>
        </div>
        <div class="agent-card-steer-box" id="steerBox_${_esc(sid)}" style="display:none">
          <textarea id="steerInput_${_esc(sid)}" placeholder="给子 agent 的引导消息（最多 4000 字符，每 2 秒限 1 条）"></textarea>
          <div class="agent-card-steer-actions">
            <button class="agent-card-btn" onclick="_toggleSteerBox('${_esc(sid)}')">取消</button>
            <button class="agent-card-btn" onclick="_sendSteer('${_esc(parentSid)}','${_esc(sid)}')">发送</button>
          </div>
        </div>
      </div>
    `;
  }

  function _toggleSteerBox(childSid) {
    const box = document.getElementById('steerBox_' + childSid);
    if (!box) return;
    const isOpen = box.style.display !== 'none';
    box.style.display = isOpen ? 'none' : '';
    if (!isOpen) {
      const input = document.getElementById('steerInput_' + childSid);
      if (input) setTimeout(() => input.focus(), 10);
    }
  }
  window._toggleSteerBox = _toggleSteerBox;

  async function _sendSteer(parentSid, childSid) {
    const input = document.getElementById('steerInput_' + childSid);
    if (!input) return;
    const message = input.value.trim();
    if (!message) {
      if (typeof showToast === 'function') showToast('请输入 Steer 消息');
      return;
    }
    try {
      const resp = await fetch('/api/agents/steer', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ session_id: parentSid, child_session_id: childSid, message }),
      });
      const data = await resp.json();
      if (data.ok) {
        if (typeof showToast === 'function') showToast('Steer 已发送');
        input.value = '';
        _toggleSteerBox(childSid);
        refreshAgentsPanel();
      } else {
        if (typeof showToast === 'function') showToast('Steer 失败：' + (data.error || '未知错误'));
      }
    } catch (e) {
      if (typeof showToast === 'function') showToast('Steer 请求失败：' + e.message);
    }
  }
  window._sendSteer = _sendSteer;

  async function _cancelChildAgent(parentSid, childSid) {
    // 使用通用 UI 对话框，避免触发 Chrome 系统提示框
    let ok;
    if (typeof showConfirmDialog === 'function') {
      ok = await showConfirmDialog({
        title: '终止子 Agent',
        message: '确定取消这个子 agent 的执行吗？',
        confirmLabel: '终止',
        cancelLabel: '继续',
        danger: true,
        focusCancel: true,
      });
    } else {
      ok = confirm('确定取消这个子 agent 的执行？');
    }
    if (!ok) return;
    try {
      const resp = await fetch('/api/agents/cancel', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ session_id: parentSid, child_session_id: childSid }),
      });
      const data = await resp.json();
      if (data.ok) {
        if (typeof showToast === 'function') showToast('已请求取消');
        refreshAgentsPanel();
      } else {
        if (typeof showToast === 'function') showToast('取消失败：' + (data.error || '未知错误'));
      }
    } catch (e) {
      if (typeof showToast === 'function') showToast('取消请求失败：' + e.message);
    }
  }
  window._cancelChildAgent = _cancelChildAgent;

  /** 由 switchOutputTab('agents') 调用，开始自动轮询。 */
  function activateAgentsPolling() {
    _isActive = true;
    refreshAgentsPanel();
    if (_pollTimer) clearInterval(_pollTimer);
    _pollTimer = setInterval(() => {
      if (_isActive) refreshAgentsPanel();
    }, POLL_INTERVAL_MS);
  }
  window.activateAgentsPolling = activateAgentsPolling;

  /** 切走 Agents tab 时调用，停止轮询。 */
  function deactivateAgentsPolling() {
    _isActive = false;
    if (_pollTimer) { clearInterval(_pollTimer); _pollTimer = null; }
  }
  window.deactivateAgentsPolling = deactivateAgentsPolling;

  // ── Helpers ────────────────────────────────────────────────────────────
  function _esc(s) {
    if (s == null) return '';
    return String(s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }
})();
