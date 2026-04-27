/**
 * static/browser-panel.js — 浏览器面板（AI 自动化可视化 + "下一步"暂停）
 *
 * P0/P1/P2/P3 前端核心。监听 SSE 事件：
 *   browser_step              每次 browser_* 工具的 started / done / error 阶段
 *   user_continue_required    agent 请求用户点"下一步"（登录 / 验证码场景）
 *
 * 核心 UI：
 *   - 步骤流（aiBrowserStepsBody）：每步一行，status 图标/动画
 *   - 截图镜像（aiBrowserOverlay + aiBrowserShot）：每步完成后推截图 URL，img 更新
 *   - 元素高亮（aiBrowserHighlight）：根据 element_box 的 x/y/w/h 画一个红框覆盖
 *   - "下一步"卡片（aiBrowserContinueCard）：显示 reason + 倒计时 + 两个按钮
 */
(function() {
  'use strict';

  const MAX_STEPS = 200;

  // ── 状态 ──────────────────────────────────────────────────────────────
  const PANEL_STATE = {
    steps: [],              // [{step_id, action, status, url, ref, text, ..., screenshot_url}]
    stepIndex: {},          // step_id → step DOM row
    collapsed: false,
    currentContinue: null,  // {continue_id, reason, timeout_seconds, deadline_ts}
    countdownTimer: null,
    lastSessionId: null,
  };

  // ── DOM helpers ──────────────────────────────────────────────────────
  function $(id) { return document.getElementById(id); }

  // ── 入口：切到浏览器 tab 时、打开某个员工时自动调 ────────────────────
  function ensureBrowserPanelForSession(sessionId) {
    if (!sessionId) return;
    PANEL_STATE.lastSessionId = sessionId;
    // 查询是否有挂起的 continue（页面刷新后恢复）
    fetch(`/api/browser/continue/pending?session_id=${encodeURIComponent(sessionId)}`)
      .then(r => r.ok ? r.json() : null)
      .then(data => {
        if (data && data.pending) {
          showContinueCard({
            continue_id: data.pending.continue_id,
            reason: data.pending.reason,
            timeout_seconds: data.pending.timeout_seconds_remaining,
            session_id: sessionId,
          });
        }
      })
      .catch(() => {});
  }

  // ── browser_step 事件处理 ────────────────────────────────────────────
  function handleBrowserStep(data) {
    if (!data || !data.step_id) return;

    // 自动切到浏览器 tab
    _autoSwitchToBrowserTab();
    _showAiOverlay(true);
    _setAiModeTag(true, data.action || '');

    const existing = PANEL_STATE.stepIndex[data.step_id];
    if (existing) {
      _updateStepRow(existing, data);
    } else {
      _appendStepRow(data);
    }

    // 若有截图，更新截图镜像层
    if (data.screenshot_url) {
      _updateShot(data.screenshot_url);
    }

    // 若有 element_box，更新高亮层
    if (data.element_box && data.status === 'done') {
      _showHighlight(data.element_box);
    }

    // 当前动作文本（badge）
    const actLabel = _humanizeAction(data);
    const cur = $('aiBrowserCurrentAction');
    if (cur) cur.textContent = actLabel;

    // 完成后渐隐 AI 模式（延时——避免闪烁）
    if (data.status === 'done' || data.status === 'error') {
      clearTimeout(PANEL_STATE._fadeTimer);
      PANEL_STATE._fadeTimer = setTimeout(() => {
        // 若 1.5s 内没有新的 step_running 进来，则撤掉 AI badge
        const lastRunning = PANEL_STATE.steps.some(s => s.status === 'running');
        if (!lastRunning) {
          _setAiModeTag(false);
        }
      }, 1500);
    }
  }

  function _appendStepRow(data) {
    const body = $('aiBrowserStepsBody');
    if (!body) return;

    // 清掉 empty 提示
    const empty = body.querySelector('.ai-browser-steps-empty');
    if (empty) empty.remove();

    const row = document.createElement('div');
    row.className = 'ai-step';
    row.dataset.stepId = data.step_id;
    row.dataset.status = data.status || 'running';
    row.innerHTML = _renderStepRowHTML(data);
    // 点击截图缩略图放大查看
    _bindThumbZoom(row);
    body.appendChild(row);
    // 自动滚到底
    body.scrollTop = body.scrollHeight;

    PANEL_STATE.steps.push(data);
    PANEL_STATE.stepIndex[data.step_id] = row;

    // 限流：超过 MAX_STEPS 时移除最旧的
    while (PANEL_STATE.steps.length > MAX_STEPS) {
      const old = PANEL_STATE.steps.shift();
      const oldRow = PANEL_STATE.stepIndex[old.step_id];
      if (oldRow) oldRow.remove();
      delete PANEL_STATE.stepIndex[old.step_id];
    }

    // 更新计数
    const cnt = $('aiBrowserStepsCount');
    if (cnt) cnt.textContent = String(PANEL_STATE.steps.length);
  }

  function _updateStepRow(row, data) {
    row.dataset.status = data.status || 'running';
    row.innerHTML = _renderStepRowHTML(data);
    _bindThumbZoom(row);

    // 也更新 PANEL_STATE.steps 里的记录
    const idx = PANEL_STATE.steps.findIndex(s => s.step_id === data.step_id);
    if (idx >= 0) PANEL_STATE.steps[idx] = Object.assign({}, PANEL_STATE.steps[idx], data);
  }

  function _renderStepRowHTML(data) {
    const iconChar = data.status === 'done' ? '✓'
                    : data.status === 'error' ? '✗'
                    : '⟳';
    const title = _escapeHtml(_humanizeAction(data));
    let metaParts = [];
    if (data.url) metaParts.push(`→ ${_escapeHtml(_shortenUrl(data.url))}`);
    if (data.title) metaParts.push(_escapeHtml(data.title));
    if (typeof data.duration_ms === 'number' && data.duration_ms > 0) {
      metaParts.push(`<span class="ai-step-duration">${(data.duration_ms / 1000).toFixed(1)}s</span>`);
    }
    if (data.status === 'error' && data.error) {
      metaParts.push(`<span class="ai-step-error">${_escapeHtml(data.error)}</span>`);
    }
    const metaHtml = metaParts.length
      ? `<div class="ai-step-meta">${metaParts.join(' · ')}</div>`
      : '';
    const thumbHtml = data.screenshot_url
      ? `<img class="ai-step-thumb" src="${_escapeAttr(data.screenshot_url)}" alt="截图" loading="lazy">`
      : '';
    return `
      <div class="ai-step-icon">${iconChar}</div>
      <div class="ai-step-body">
        <div class="ai-step-title"><span class="ai-step-action">${_escapeHtml(data.action || 'browser')}</span>${title}</div>
        ${metaHtml}
      </div>
      ${thumbHtml}
    `;
  }

  function _bindThumbZoom(row) {
    const thumb = row.querySelector('.ai-step-thumb');
    if (!thumb) return;
    thumb.addEventListener('click', (e) => {
      e.stopPropagation();
      _updateShot(thumb.src);
      _showAiOverlay(true);
    });
  }

  function _humanizeAction(data) {
    const a = data.action || 'browser';
    if (a === 'navigate') return `打开网页 ${_shortenUrl(data.url || '')}`;
    if (a === 'click')    return `点击元素 ${data.ref || ''}`;
    if (a === 'type')     return `输入文本 "${_truncate(data.text || '', 30)}" → ${data.ref || ''}`;
    if (a === 'scroll')   return `滚动 ${data.direction || ''}`;
    if (a === 'back')     return `返回上一页`;
    if (a === 'press')    return `按键 ${data.key || ''}`;
    if (a === 'snapshot') return `拍快照`;
    if (a === 'vision')   return `视觉分析`;
    if (a === 'console')  return `读控制台`;
    if (a === 'get_images') return `读取图片`;
    if (a === 'user_continue') return `请求用户协助: ${_truncate(data.reason || '', 60)}`;
    return `${a}`;
  }

  function _shortenUrl(url) {
    if (!url) return '';
    if (url.length <= 60) return url;
    try {
      const u = new URL(url);
      return u.host + u.pathname.substring(0, 40) + (u.pathname.length > 40 ? '…' : '');
    } catch (_) {
      return url.substring(0, 60) + '…';
    }
  }

  function _truncate(s, n) {
    s = String(s || '');
    return s.length > n ? s.substring(0, n) + '…' : s;
  }

  function _escapeHtml(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  function _escapeAttr(s) {
    return _escapeHtml(s);
  }

  // ── 截图镜像 ─────────────────────────────────────────────────────────
  function _updateShot(url) {
    const img = $('aiBrowserShot');
    if (!img) return;
    // 平滑过渡：fade out → 换图 → fade in
    img.style.opacity = '0.2';
    const newImg = new Image();
    newImg.onload = () => {
      img.src = url;
      img.style.opacity = '1';
    };
    newImg.onerror = () => {
      img.style.opacity = '1';
    };
    newImg.src = url;
  }

  function _showAiOverlay(show) {
    const o = $('aiBrowserOverlay');
    const e = $('outBrowserEmpty');
    if (!o) return;
    o.style.display = show ? 'block' : 'none';
    if (show && e) e.classList.add('hidden');
  }

  function _setAiModeTag(active, action) {
    const tag = $('browserAiModeTag');
    const txt = $('browserAiModeText');
    if (!tag) return;
    tag.style.display = active ? 'inline-flex' : 'none';
    if (active && txt) txt.textContent = action ? `AI · ${action}` : 'AI 自动化中';
  }

  // ── 元素高亮 ─────────────────────────────────────────────────────────
  function _showHighlight(box) {
    const hl = $('aiBrowserHighlight');
    const img = $('aiBrowserShot');
    if (!hl || !img) return;
    if (!box || typeof box.x !== 'number') return;

    // 等 img 加载完再定位（要拿到 naturalWidth/Height 来做缩放）
    const apply = () => {
      const rect = img.getBoundingClientRect();
      const parent = img.parentElement.getBoundingClientRect();
      const sx = (img.naturalWidth || rect.width) ? rect.width / (img.naturalWidth || rect.width) : 1;
      const sy = (img.naturalHeight || rect.height) ? rect.height / (img.naturalHeight || rect.height) : 1;
      hl.style.left = (rect.left - parent.left + box.x * sx) + 'px';
      hl.style.top  = (rect.top  - parent.top  + box.y * sy) + 'px';
      hl.style.width  = (box.w * sx) + 'px';
      hl.style.height = (box.h * sy) + 'px';
      hl.style.display = 'block';
      // 1.2s 后自动淡出（靠 CSS 动画）
      clearTimeout(hl._hideTimer);
      hl._hideTimer = setTimeout(() => { hl.style.display = 'none'; }, 1500);
    };

    if (img.complete && img.naturalWidth > 0) {
      apply();
    } else {
      img.addEventListener('load', apply, { once: true });
    }
  }

  // ── "下一步"暂停卡片（P3） ────────────────────────────────────────────
  function showContinueCard(data) {
    if (!data) return;
    PANEL_STATE.currentContinue = {
      continue_id: data.continue_id,
      reason: data.reason || '',
      timeout_seconds: Number(data.timeout_seconds || 600),
      deadline_ts: Date.now() + (Number(data.timeout_seconds || 600) * 1000),
      session_id: data.session_id || PANEL_STATE.lastSessionId,
    };
    const card = $('aiBrowserContinueCard');
    const reason = $('aiBrowserContinueReason');
    if (!card) return;

    if (reason) reason.textContent = data.reason || '需要你的协助';
    card.style.display = 'block';

    // 自动切到浏览器 tab，让用户立即看到
    _autoSwitchToBrowserTab();
    // 展开步骤面板
    const panel = $('aiBrowserSteps');
    if (panel) panel.classList.remove('collapsed');

    _startContinueCountdown();

    // 通知声 + 浏览器通知
    try { if (typeof playNotificationSound === 'function') playNotificationSound(); } catch(_){}
    try {
      if (typeof sendBrowserNotification === 'function') {
        sendBrowserNotification('需要你的协助', data.reason || '请完成操作后点击「下一步」');
      }
    } catch(_){}
  }

  function hideContinueCard() {
    const card = $('aiBrowserContinueCard');
    if (card) card.style.display = 'none';
    _stopContinueCountdown();
    PANEL_STATE.currentContinue = null;
  }

  function _startContinueCountdown() {
    _stopContinueCountdown();
    const cd = $('aiBrowserContinueCountdown');
    if (!cd || !PANEL_STATE.currentContinue) return;
    const tick = () => {
      if (!PANEL_STATE.currentContinue) return;
      const rem = Math.max(0, Math.ceil((PANEL_STATE.currentContinue.deadline_ts - Date.now()) / 1000));
      const mm = Math.floor(rem / 60);
      const ss = rem % 60;
      cd.textContent = `剩余 ${mm}:${String(ss).padStart(2, '0')}`;
      if (rem <= 0) {
        hideContinueCard();  // 超时（后端也会自动解除）
      }
    };
    tick();
    PANEL_STATE.countdownTimer = setInterval(tick, 1000);
  }

  function _stopContinueCountdown() {
    if (PANEL_STATE.countdownTimer) {
      clearInterval(PANEL_STATE.countdownTimer);
      PANEL_STATE.countdownTimer = null;
    }
    const cd = $('aiBrowserContinueCountdown');
    if (cd) cd.textContent = '';
  }

  async function respondBrowserContinue(action) {
    const cur = PANEL_STATE.currentContinue;
    if (!cur) { hideContinueCard(); return; }
    const sid = cur.session_id || PANEL_STATE.lastSessionId;
    if (!sid) { hideContinueCard(); return; }
    hideContinueCard();
    try {
      await fetch('/api/browser/continue', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ session_id: sid, action: action || 'continue' }),
      });
    } catch (e) {
      console.error('[browser-panel] respond failed:', e);
      if (typeof showToast === 'function') showToast('响应失败：' + e.message);
    }
  }

  // ── 辅助 ──────────────────────────────────────────────────────────────
  function _autoSwitchToBrowserTab() {
    try {
      if (typeof switchOutputTab === 'function') {
        const activeBtn = document.querySelector('.output-tab.active');
        const cur = activeBtn ? activeBtn.dataset.outTab : '';
        if (cur !== 'browser') {
          switchOutputTab('browser');
        }
      }
    } catch (_) {}
  }

  function clearBrowserSteps() {
    const body = $('aiBrowserStepsBody');
    if (body) {
      body.innerHTML = '<div class="ai-browser-steps-empty">暂无操作步骤。当 AI 使用浏览器工具时，将在此展示实时步骤。</div>';
    }
    PANEL_STATE.steps = [];
    PANEL_STATE.stepIndex = {};
    const cnt = $('aiBrowserStepsCount');
    if (cnt) cnt.textContent = '0';
    // 同时隐藏 AI overlay
    _showAiOverlay(false);
    _setAiModeTag(false);
    const hl = $('aiBrowserHighlight');
    if (hl) hl.style.display = 'none';
  }

  function toggleBrowserStepsPanel() {
    const panel = $('aiBrowserSteps');
    if (!panel) return;
    panel.classList.toggle('collapsed');
    PANEL_STATE.collapsed = panel.classList.contains('collapsed');
  }

  // ── 暴露到全局 ───────────────────────────────────────────────────────
  window.handleBrowserStep = handleBrowserStep;
  window.showContinueCard = showContinueCard;
  window.hideContinueCard = hideContinueCard;
  window.respondBrowserContinue = respondBrowserContinue;
  window.clearBrowserSteps = clearBrowserSteps;
  window.toggleBrowserStepsPanel = toggleBrowserStepsPanel;
  window.ensureBrowserPanelForSession = ensureBrowserPanelForSession;

  // 供调试
  window.__BROWSER_PANEL_STATE = PANEL_STATE;
})();
