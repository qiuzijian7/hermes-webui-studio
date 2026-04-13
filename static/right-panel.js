/**
 * right-panel.js — 右侧面板（对话/技能详情切换）
 */

// ── 面板视图切换 ────────────────────────────────────────────────────────────
let _rpView = 'empty'; // 'empty' | 'chat' | 'skill'

function _setRightPanelView(view) {
  _rpView = view;
  const chatView = $('rpChatView');
  const skillView = $('rpSkillView');
  const emptyView = $('rpEmpty');

  if (chatView) chatView.style.display = view === 'chat' ? 'flex' : 'none';
  if (skillView) skillView.style.display = view === 'skill' ? 'flex' : 'none';
  if (emptyView) emptyView.style.display = view === 'empty' ? 'flex' : 'none';

  // 右侧面板显示/隐藏
  const panel = $('rightPanel');
  if (panel) {
    if (view === 'empty') {
      panel.classList.add('rp-collapsed');
    } else {
      panel.classList.remove('rp-collapsed');
    }
  }
}

function closeRightPanel() {
  _setRightPanelView('empty');
  EMPLOYEE_STORE.selectedId = null;
  document.querySelectorAll('.emp-card').forEach(c => c.classList.remove('emp-selected'));
}

// ── 员工对话模式 ────────────────────────────────────────────────────────────
async function openEmployeeChat(empId) {
  const emp = getEmployee(empId);
  if (!emp) return;

  _setRightPanelView('chat');

  // 更新头部信息
  const avatarEl = $('rpEmployeeAvatar');
  if (avatarEl) avatarEl.textContent = emp.avatar;
  const nameEl = $('rpEmployeeName');
  if (nameEl) nameEl.textContent = emp.name;
  const roleEl = $('rpEmployeeRole');
  if (roleEl) roleEl.textContent = emp.role;

  // 确保员工有会话
  if (!emp.sessionId) {
    try {
      const data = await api('/api/session/new', { method: 'POST', body: JSON.stringify({ model: $('modelSelect')?.value || '' }) });
      if (data.session) {
        emp.sessionId = data.session.session_id;
        _saveEmployees();
        S.session = data.session;
        S.messages = [];
        _renderRpMessages();
      }
    } catch(e) {
      showToast('创建会话失败: ' + e.message);
      return;
    }
  } else {
    // 加载已有会话
    try {
      const data = await api(`/api/session?session_id=${encodeURIComponent(emp.sessionId)}`);
      if (data.session) {
        S.session = data.session;
        S.messages = (data.session.messages || []).filter(m => m.role !== 'tool');
        _renderRpMessages();
      }
    } catch(e) {
      // 会话可能已被删除，创建新的
      emp.sessionId = null;
      _saveEmployees();
      openEmployeeChat(empId);
      return;
    }
  }

  // 更新 topbar
  $('topbarTitle').textContent = emp.name;
  $('topbarMeta').textContent = emp.role + ' · ' + (STATUS_MAP[emp.status]?.label || '空闲');
}

function _renderRpMessages() {
  const inner = $('rpMsgInner');
  const emptyChat = $('rpEmptyChat');
  if (!inner) return;

  const vis = S.messages.filter(m => m && m.role && m.role !== 'tool' && msgContent(m));
  if (emptyChat) emptyChat.style.display = vis.length ? 'none' : '';
  inner.innerHTML = '';

  for (const m of vis) {
    let content = m.content || '';
    if (Array.isArray(content)) content = content.filter(p => p.type === 'text').map(p => p.text || '').join('\n');
    const isUser = m.role === 'user';
    const bodyHtml = isUser ? esc(String(content)).replace(/\n/g, '<br>') : renderMd(String(content));
    const row = document.createElement('div');
    row.className = 'rp-msg-row';
    row.dataset.role = m.role;
    row.innerHTML = `
      <div class="rp-msg-role ${m.role}">
        <span class="rp-msg-icon">${isUser ? '👤' : (getEmployee(EMPLOYEE_STORE.selectedId)?.avatar || '🤖')}</span>
        <span class="rp-msg-name">${isUser ? '你' : (getEmployee(EMPLOYEE_STORE.selectedId)?.name || 'Hermes')}</span>
      </div>
      <div class="rp-msg-body">${bodyHtml}</div>
    `;
    row.dataset.rawText = String(content).trim();
    inner.appendChild(row);
  }

  // 滚动到底部
  const msgArea = $('rpMessages');
  if (msgArea) msgArea.scrollTop = msgArea.scrollHeight;

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
  _setRightPanelView('skill');

  const nameEl = $('rpSkillName');
  if (nameEl) nameEl.textContent = skillName;
  const catEl = $('rpSkillCategory');
  if (catEl) catEl.textContent = category || '未分类';

  const metaEl = $('rpSkillMeta');
  if (metaEl) {
    metaEl.innerHTML = `
      <div class="rp-skill-info"><strong>名称:</strong> ${esc(skillName)}</div>
      <div class="rp-skill-info"><strong>分类:</strong> ${esc(category || '未分类')}</div>
      <div class="rp-skill-info"><strong>类型:</strong> ${content ? '自定义技能' : '系统技能'}</div>
    `;
  }

  const bodyEl = $('rpSkillBody');
  if (bodyEl) {
    bodyEl.innerHTML = content ? renderMd(content) : '<p style="color:var(--muted)">暂无详细内容</p>';
  }

  // 保存当前查看的技能名，用于分配
  window._currentViewSkill = skillName;
}

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
            <label class="rp-skill-toggle">
              <input type="checkbox" ${enabled ? 'checked' : ''} onchange="toggleEmployeeSkill('${emp.id}','${esc(name)}',this.checked)">
              <span class="rp-skill-toggle-slider"></span>
            </label>
          </div>
        `;
      }
    } else {
      html += '<p style="color:var(--muted);font-size:13px;padding:12px 0">暂无配置技能，点击左侧技能面板中的技能进行分配</p>';
    }
    html += '</div>';
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
  }
}

// ── 初始化 ─────────────────────────────────────────────────────────────────
function initRightPanel() {
  _setRightPanelView('empty');
}
