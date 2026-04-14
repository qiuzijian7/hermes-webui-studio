/**
 * right-panel.js — 右侧面板（对话/技能详情切换）
 */

// ── 面板视图切换 ────────────────────────────────────────────────────────────
let _rpView = 'empty'; // 'empty' | 'chat' | 'skill' | 'file'

function _setRightPanelView(view) {
  _rpView = view;
  const chatView = $('rpChatView');
  const skillView = $('rpSkillView');
  const fileView = $('rpFileView');
  const emptyView = $('rpEmpty');

  if (chatView) chatView.style.display = view === 'chat' ? 'flex' : 'none';
  if (skillView) skillView.style.display = view === 'skill' ? 'flex' : 'none';
  if (fileView) fileView.style.display = view === 'file' ? 'flex' : 'none';
  if (emptyView) emptyView.style.display = view === 'empty' ? 'flex' : 'none';

  // 右侧面板始终显示（不再折叠）
  const panel = $('rightPanel');
  const layout = document.querySelector('.layout');
  if (panel) {
    // 强制面板可见 — 使用 inline style 覆盖所有 CSS 规则
    panel.classList.remove('rp-collapsed');
    panel.style.display = 'flex';
    panel.style.opacity = '1';
    panel.style.pointerEvents = '';
    panel.style.width = panel.style.width || '440px';
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
  document.querySelectorAll('.emp-card').forEach(c => c.classList.remove('emp-selected'));
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
async function openEmployeeChat(empId) {
  const emp = getEmployee(empId);
  if (!emp) return;

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

  // 更新 topbar — 显示工作区信息
  const ws = S.session?.workspace || '';
  const wsName = ws ? (typeof getWorkspaceFriendlyName === 'function' ? getWorkspaceFriendlyName(ws) : ws.split(/[\/\\]/).filter(Boolean).pop()) : '';
  $('topbarTitle').textContent = wsName || 'Hermes Studio';
  $('topbarMeta').textContent = ws ? ws : '员工工作台 — 点击员工卡片开始对话';
  // 同步工作区选择器标签
  if (typeof syncWsSelectorLabel === 'function') syncWsSelectorLabel();
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

  // 如果有员工，自动选择第一个并打开聊天框
  if (typeof EMPLOYEE_STORE !== 'undefined' && EMPLOYEE_STORE.employees.length > 0) {
    const firstEmployee = EMPLOYEE_STORE.employees[0];
    EMPLOYEE_STORE.selectedId = firstEmployee.id;
    // 先设置面板视图为 chat（不依赖 API 调用）
    _setRightPanelView('chat');
    // 更新头部信息
    const avatarEl = $('rpEmployeeAvatar');
    if (avatarEl) {
      if (firstEmployee.characterImg) {
        const fb2 = (firstEmployee.avatar||'').replace(/'/g, "\\'");
        avatarEl.innerHTML = `<div class="rp-employee-avatar-sprite" style="background-image:url('/static/img/characters/${firstEmployee.characterImg}_frame32x32.png');background-size:300% 400%;background-position:0 0;background-repeat:no-repeat" data-fallback="${fb2}" onerror="this.remove();this.parentElement.textContent='${fb2}'"></div>`;
      } else {
        avatarEl.textContent = firstEmployee.avatar;
      }
    }
    const nameEl = $('rpEmployeeName');
    if (nameEl) nameEl.textContent = firstEmployee.name;
    const roleEl = $('rpEmployeeRole');
    if (roleEl) roleEl.textContent = firstEmployee.role;
    // 异步加载会话（失败也不影响面板显示）
    openEmployeeChat(firstEmployee.id).catch(() => {});
    // 更新卡片选中状态（需要等卡片渲染完）
    setTimeout(() => {
      document.querySelectorAll('.emp-card').forEach(c => {
        c.classList.toggle('emp-selected', c.dataset.id === firstEmployee.id);
      });
    }, 150);
  } else {
    _setRightPanelView('empty');
  }
  
  console.log('[initRightPanel] 面板初始化完成, panel display:', panel?.style.display, 'panel width:', panel?.style.width);
}

// ── 文件预览模式（右侧面板）────────────────────────────────────────────────

let _rpFileCurrentPath = '';
let _rpFileCurrentMode = '';  // 'code' | 'md' | 'image'
let _rpFileRawContent = '';
let _rpFileDirty = false;

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
  const ext = _rpFileExt(path);
  const sid = (S.session && S.session.session_id) ? encodeURIComponent(S.session.session_id) : '';

  // 二进制文件直接下载
  if (_RP_DOWNLOAD_EXTS.has(ext)) {
    if (typeof downloadFile === 'function') downloadFile(path);
    return;
  }

  _rpFileCurrentPath = path;
  _rpFileDirty = false;

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
  const editArea = $('rpFileEditArea');
  const badge = $('rpFileBadge');
  const editBtn = $('rpFileEditBtn');

  if (codeEl) codeEl.style.display = 'none';
  if (mdEl) mdEl.style.display = 'none';
  if (imgWrap) imgWrap.style.display = 'none';
  if (editArea) editArea.style.display = 'none';

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
      // 语法高亮
      requestAnimationFrame(() => {
        if (typeof highlightCode === 'function' && mdEl) highlightCode(mdEl);
        if (typeof addCopyButtons === 'function' && mdEl) addCopyButtons(mdEl);
      });
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
        closeRpFilePreview();
        return;
      }
      _rpFileRawContent = data.content || '';
      if (codeEl) {
        codeEl.style.display = '';
        codeEl.textContent = data.content || '';
      }
      // 语法高亮
      requestAnimationFrame(() => {
        if (typeof highlightCode === 'function' && codeEl) highlightCode(codeEl);
      });
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
function closeRpFilePreview() {
  _rpFileCurrentPath = '';
  _rpFileCurrentMode = '';
  _rpFileRawContent = '';
  _rpFileDirty = false;
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
}

/** 切换编辑模式 */
function toggleRpFileEdit() {
  const editArea = $('rpFileEditArea');
  const codeEl = $('rpFileCode');
  const mdEl = $('rpFileMd');
  const editBtn = $('rpFileEditBtn');
  if (!editArea) return;

  const editing = editArea.style.display !== 'none';

  if (editing) {
    // 保存
    if (!_rpFileCurrentPath) return;
    const content = editArea.value;
    const savePayload = { path: _rpFileCurrentPath, content };
    if (S.session && S.session.session_id) savePayload.session_id = S.session.session_id;
    api('/api/file/save', {
      method: 'POST',
      body: JSON.stringify(savePayload)
    }).then(() => {
      _rpFileDirty = false;
      _rpFileRawContent = content;
      editArea.style.display = 'none';
      if (_rpFileCurrentMode === 'code' && codeEl) {
        codeEl.textContent = content;
        codeEl.style.display = '';
        requestAnimationFrame(() => { if (typeof highlightCode === 'function') highlightCode(codeEl); });
      } else if (_rpFileCurrentMode === 'md' && mdEl) {
        mdEl.innerHTML = typeof renderMd === 'function' ? renderMd(content) : content;
        mdEl.style.display = '';
        requestAnimationFrame(() => {
          if (typeof highlightCode === 'function') highlightCode(mdEl);
          if (typeof addCopyButtons === 'function') addCopyButtons(mdEl);
        });
      }
      if (editBtn) editBtn.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>';
      if (editBtn) editBtn.style.color = '';
      if (typeof showToast === 'function') showToast('已保存');
    }).catch(e => {
      if (typeof showToast === 'function') showToast('保存失败: ' + e.message);
    });
  } else {
    // 进入编辑模式
    editArea.value = _rpFileRawContent;
    editArea.style.display = '';
    if (codeEl) codeEl.style.display = 'none';
    if (mdEl) mdEl.style.display = 'none';
    if (editBtn) editBtn.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z"/><polyline points="17 21 17 13 7 13 7 21"/><polyline points="7 3 7 8 15 8"/></svg>';
    if (editBtn) editBtn.style.color = 'var(--blue)';
    editArea.focus();
    editArea.onkeydown = (e) => {
      if (e.key === 'Escape') { e.preventDefault(); _cancelRpFileEdit(); }
    };
    editArea.oninput = () => { _rpFileDirty = true; };
  }
}

function _cancelRpFileEdit() {
  const editArea = $('rpFileEditArea');
  const codeEl = $('rpFileCode');
  const mdEl = $('rpFileMd');
  const editBtn = $('rpFileEditBtn');
  if (editArea) editArea.style.display = 'none';
  if (_rpFileCurrentMode === 'code' && codeEl) codeEl.style.display = '';
  if (_rpFileCurrentMode === 'md' && mdEl) mdEl.style.display = '';
  _rpFileDirty = false;
  if (editBtn) {
    editBtn.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>';
    editBtn.style.color = '';
  }
}

/** 下载当前预览的文件 */
function downloadRpFile() {
  if (_rpFileCurrentPath && typeof downloadFile === 'function') {
    downloadFile(_rpFileCurrentPath);
  }
}
