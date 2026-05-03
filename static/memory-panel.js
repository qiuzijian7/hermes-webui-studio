/**
 * memory-panel.js — 员工记忆面板逻辑
 * 在聊天区域显示/编辑 MEMORY.md / USER.md，支持 AI 自动提取记忆
 */

let _memoryCurrentTab = 'memory'; // 'memory' | 'user'
let _memoryCurrentEmpId = null;
let _memoryOriginalContent = ''; // 用于检测是否有未保存的修改
let _memoryPanelVisible = false; // 记忆面板是否可见

// ── 获取员工的工作区（共用函数）────────────────────────────────────

function _getEmployeeWorkspace(emp) {
  if (!emp) return '';
  // 优先使用员工自己的 workspace 字段
  if (emp.workspace) return emp.workspace;
  // 其次使用全局 getWorkspace 函数
  if (typeof getWorkspace === 'function') {
    const ws = getWorkspace();
    if (ws) return ws;
  }
  // 再其次使用 getCurrentWorkspace 函数
  if (typeof getCurrentWorkspace === 'function') {
    const ws = getCurrentWorkspace();
    if (ws) return ws;
  }
  // 尝试使用 _currentCanvasWorkspace 变量（在 employee.js 中定义）
  try {
    if (typeof _currentCanvasWorkspace !== 'undefined' && _currentCanvasWorkspace) {
      return _currentCanvasWorkspace;
    }
  } catch(e) {}
  // 最后尝试从 EMPLOYEE_STORE 获取当前工作区
  if (EMPLOYEE_STORE && EMPLOYEE_STORE.currentWorkspace) {
    return EMPLOYEE_STORE.currentWorkspace;
  }
  return '';
}

// ── 切换记忆面板（在聊天区域显示/隐藏）──────────────────────────────

function toggleMemoryPanel() {
  console.log('[Memory] toggleMemoryPanel called, current state:', _memoryPanelVisible);
  const panel = document.getElementById('memoryPanelInChat');
  const msgs = document.getElementById('rpMessages');
  const emptyChat = document.getElementById('rpEmptyChat');
  const msgInner = document.getElementById('rpMsgInner');

  console.log('[Memory] panel element:', panel, 'msgs:', msgs);
  if (!panel) {
    console.error('[Memory] panel element not found!');
    return;
  }

  _memoryPanelVisible = !_memoryPanelVisible;

  if (_memoryPanelVisible) {
    // 显示记忆面板，隐藏聊天消息
    // 注意：panel 是 msgs 的子元素，不能隐藏 msgs，只能隐藏其兄弟元素
    if (emptyChat) emptyChat.style.display = 'none';
    if (msgInner) msgInner.style.display = 'none';
    panel.style.display = 'flex';
    console.log('[Memory] Panel shown, display=', panel.style.display);
    // 加载记忆内容
    loadMemory();
  } else {
    // 隐藏记忆面板，显示聊天消息
    panel.style.display = 'none';
    // 显示聊天内容（msgs 本身始终可见）
    if (msgInner) msgInner.style.display = '';
    // 如果没有消息，显示空聊天提示
    const emp = getEmployee(EMPLOYEE_STORE.selectedId);
    if (emptyChat) {
      emptyChat.style.display = (emp && emp._hasMessages) ? 'none' : '';
    }
  }
}

// ── 加载记忆 ──────────────────────────────────────────────────────────────

function loadMemory() {
  const emp = getEmployee(EMPLOYEE_STORE.selectedId);
  if (!emp) {
    // 若没有选中员工，隐藏 Memory 按钮
    const memBtn = document.getElementById('btnEmployeeMemory');
    if (memBtn) memBtn.style.display = 'none';
    return;
  }

  _memoryCurrentEmpId = emp.id;

  // 显示 Memory 按钮（在员工操作栏）
  const memBtn = document.getElementById('btnEmployeeMemory');
  if (memBtn) memBtn.style.display = '';

  // 更新面板标题
  const nameEl = document.getElementById('memoryChatEmployeeName');
  if (nameEl) nameEl.textContent = (emp.name || '员工') + ' 的记忆';

  // 加载当前 tab 的内容
  _loadMemoryContent(emp);
}

function _loadMemoryContent(emp) {
  if (!emp || !emp.id) return;

  const workspace = _getEmployeeWorkspace(emp);

  // ★ 调试：显示传递的参数
  console.log('[Memory] Loading memory for:', { empId: emp.id, empName: emp.name, workspace: workspace });

  if (!workspace) {
    // ★ 提供更友好的提示，并允许快速设置工作区
    const panel = document.getElementById('memoryPanelInChat');
    if (panel) {
      panel.innerHTML = `
        <div class="memory-empty-state" style="padding: 40px 20px; text-align: center; color: var(--text-muted);">
          <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" style="margin-bottom: 16px; opacity: 0.5;">
            <path d="M12 2L2 7l10 5 10-5-10-5z"/>
            <path d="M2 17l10 5 10-5"/>
            <path d="M2 12l10 5 10-5"/>
          </svg>
          <h3 style="margin: 0 0 8px; color: var(--text); font-size: 16px;">未设置工作区</h3>
          <p style="margin: 0 0 20px; font-size: 13px; line-height: 1.5;">
            员工记忆需要工作区来存储 MEMORY.md 和 USER.md 文件。<br>
            请先在员工参数中设置工作区路径。
          </p>
          <button class="memory-btn primary" onclick="openEmployeeParamsEditor(); toggleMemoryPanel();"
                  style="padding: 8px 20px; font-size: 13px;">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="margin-right: 6px; vertical-align: -2px;">
              <line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/>
            </svg>
            设置工作区
          </button>
        </div>
      `;
    }
    return;
  }

  // ★ 调试：显示完整的请求 URL
  const url = `/api/employee/memory?workspace=${encodeURIComponent(workspace)}&id=${encodeURIComponent(emp.id)}&name=${encodeURIComponent(emp.name || '')}`;
  console.log('[Memory] Fetching:', url);

  // 调用后端 API 读取记忆
  fetch(url)
    .then(r => {
      console.log('[Memory] Response status:', r.status);
      return r.json();
    })
    .then(data => {
      console.log('[Memory] Response data:', data);
      if (!data.ok && data.error) {
        // ★ 显示更详细的错误信息
        const errMsg = `加载记忆失败：${data.error}\nWorkspace: ${workspace}\nEmployee ID: ${emp.id}`;
        console.error('[Memory]', errMsg);
        showToast(errMsg);
        return;
      }

      const editor = document.getElementById('memoryEditorChat');
      if (!editor) return;

      const content = _memoryCurrentTab === 'memory' ? (data.memory || '') : (data.user || '');
      editor.value = content;
      _memoryOriginalContent = content;

      // 更新标签样式
      document.querySelectorAll('.memory-tab').forEach(btn => {
        btn.classList.toggle('active', btn.dataset.tab === _memoryCurrentTab);
      });

      // 隐藏预览和自动更新结果
      const preview = document.getElementById('memoryPreviewChat');
      const autoResult = document.getElementById('memoryAutoUpdateResultChat');
      if (preview) preview.style.display = 'none';
      if (autoResult) autoResult.style.display = 'none';
    })
    .catch(err => {
      console.error('[memory] load error:', err);
      showToast('加载记忆失败：' + err.message);
    });
}


// ── Tab 切换 ──────────────────────────────────────────────────────────────

function switchMemoryTab(tab, btnEl) {
  _memoryCurrentTab = tab;

  // 检查是否有未保存的修改
  const editor = document.getElementById('memoryEditorChat');
  if (editor && editor.value !== _memoryOriginalContent) {
    if (!confirm('当前有未保存的修改，切换 tab 将丢失修改，是否继续？')) {
      // 恢复之前的 tab 选中状态
      document.querySelectorAll('.memory-tab').forEach(b => {
        b.classList.toggle('active', b.dataset.tab === _memoryCurrentTab);
      });
      return;
    }
  }

  // 更新标签样式
  document.querySelectorAll('.memory-tab').forEach(b => {
    b.classList.toggle('active', b.dataset.tab === tab);
  });

  // 重新加载内容
  const emp = getEmployee(EMPLOYEE_STORE.selectedId);
  if (emp) _loadMemoryContent(emp);
}


// ── 保存记忆 ──────────────────────────────────────────────────────────────

function saveMemory() {
  const emp = getEmployee(EMPLOYEE_STORE.selectedId);
  if (!emp || !emp.id) {
    showToast('请先选择员工');
    return;
  }

  const workspace = _getEmployeeWorkspace(emp);
  if (!workspace) {
    showToast('未设置工作区，请在员工参数中设置工作区路径');
    return;
  }

  const editor = document.getElementById('memoryEditorChat');
  if (!editor) return;

  const content = editor.value;

  // 格式化内容：确保每条记忆是独立的一行，以 "- " 开头
  const formatted = _formatMemoryContent(content, _memoryCurrentTab);

  // 构建请求体
  const body = {
    workspace: workspace,
    id: emp.id,
    name: emp.name || '',
  };
  if (_memoryCurrentTab === 'memory') {
    body.memory_content = formatted;
  } else {
    body.user_content = formatted;
  }

  // 禁用保存按钮
  const saveBtn = document.querySelector('#memoryPanelInChat .memory-btn.primary');
  if (saveBtn) saveBtn.disabled = true;

  fetch('/api/employee/memory', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
    .then(r => r.json())
    .then(data => {
      if (data.ok) {
        showToast('记忆已保存');
        _memoryOriginalContent = formatted;
        editor.value = formatted;
      } else {
        showToast('保存失败：' + (data.error || '未知错误'));
      }
    })
    .catch(err => {
      console.error('[memory] save error:', err);
      showToast('保存失败：' + err.message);
    })
    .finally(() => {
      if (saveBtn) saveBtn.disabled = false;
    });
}


function _formatMemoryContent(raw, tab) {
  // 简单格式化：按行分割，过滤空行，确保每条以 "- " 开头
  const lines = raw.split('\n').map(l => l.trim()).filter(l => l);
  const prefix = tab === 'memory' ? '# Memory\n\n' : '# User Profile\n\n';
  const entries = lines.map(l => {
    if (l.startsWith('- ')) return l;
    return '- ' + l;
  });
  return prefix + entries.join('\n');
}


// ── AI 自动更新记忆 ──────────────────────────────────────────────────────────────

function autoUpdateMemory() {
  const emp = getEmployee(EMPLOYEE_STORE.selectedId);
  if (!emp || !emp.id) {
    showToast('请先选择员工');
    return;
  }

  const workspace = _getEmployeeWorkspace(emp);
  if (!workspace) {
    showToast('未设置工作区，请在员工参数中设置工作区路径');
    return;
  }

  // 获取最近的对话记录（从 session 中）
  const sessionId = emp.sessionId;
  if (!sessionId) {
    showToast('该员工没有会话记录');
    return;
  }

  // 调用后端 API 获取最近对话
  fetch(`/api/session/messages?session_id=${encodeURIComponent(sessionId)}&limit=10`)
    .then(r => r.json())
    .then(data => {
      if (!data.messages || data.messages.length === 0) {
        showToast('没有可分析的对话记录');
        return;
      }

      // 取最后一轮对话（用户消息 + 助手回复）
      const msgs = data.messages;
      let userMsg = '';
      let assistantMsg = '';
      for (let i = msgs.length - 1; i >= 0; i--) {
        if (msgs[i].role === 'assistant') {
          assistantMsg = msgs[i].content || '';
          if (i > 0 && msgs[i-1].role === 'user') {
            userMsg = msgs[i-1].content || '';
          }
          break;
        }
      }

      if (!userMsg || !assistantMsg) {
        showToast('需要完整的对话（用户消息 + 助手回复）才能自动提取记忆');
        return;
      }

      // 调用后端自动更新 API
      _doAutoUpdate(workspace, emp.id, emp.name || '', userMsg, assistantMsg);
    })
    .catch(err => {
      console.error('[memory] auto-update fetch messages error:', err);
      showToast('获取对话记录失败：' + err.message);
    });
}


function _doAutoUpdate(workspace, empId, empName, userMsg, assistantMsg) {
  const btn = document.getElementById('btnMemoryAutoUpdateChat');
  if (btn) btn.disabled = true;

  fetch('/api/employee/memory/auto-update', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      workspace: workspace,
      id: empId,
      name: empName || '',
      user_message: userMsg,
      assistant_response: assistantMsg,
    }),
  })
    .then(r => r.json())
    .then(data => {
      // 显示自动更新结果
      const resultDiv = document.getElementById('memoryAutoUpdateResultChat');
      const contentDiv = document.getElementById('memoryAutoUpdateContentChat');
      if (resultDiv && contentDiv) {
        resultDiv.style.display = '';
        let html = '';
        if (data.added && data.added.length > 0) {
          html += '<div class="added"><strong>新增：</strong><ul>' + data.added.map(a => '<li>' + _escHtml(a) + '</li>').join('') + '</ul></div>';
        }
        if (data.updated && data.updated.length > 0) {
          html += '<div class="updated"><strong>更新：</strong><ul>' + data.updated.map(u => '<li>' + _escHtml(u) + '</li>').join('') + '</ul></div>';
        }
        if (data.deleted && data.deleted.length > 0) {
          html += '<div class="deleted"><strong>删除：</strong><ul>' + data.deleted.map(d => '<li>' + _escHtml(d) + '</li>').join('') + '</ul></div>';
        }
        if (!html) html = '<div>没有发现需要更新的记忆</div>';
        contentDiv.innerHTML = html;
      }

      // 重新加载记忆内容
      const emp = getEmployee(EMPLOYEE_STORE.selectedId);
      if (emp) _loadMemoryContent(emp);

      showToast(data.message || '自动更新完成');
    })
    .catch(err => {
      console.error('[memory] auto-update error:', err);
      showToast('自动更新失败：' + err.message);
    })
    .finally(() => {
      if (btn) btn.disabled = false;
    });
}


// ── 关闭面板 ──────────────────────────────────────────────────────────────

function closeMemoryPanel() {
  // 检查是否有未保存的修改
  const editor = document.getElementById('memoryEditorChat');
  if (editor && editor.value !== _memoryOriginalContent) {
    if (!confirm('当前有未保存的修改，确定要关闭吗？')) {
      return;
    }
  }

  // 隐藏面板，显示聊天
  _memoryPanelVisible = false;
  const panel = document.getElementById('memoryPanelInChat');
  const msgs = document.getElementById('rpMessages');
  const emptyChat = document.getElementById('rpEmptyChat');
  const msgInner = document.getElementById('rpMsgInner');

  if (panel) panel.style.display = 'none';
  if (msgs) msgs.style.display = '';
  if (msgInner) msgInner.style.display = '';

  // 如果没有消息，显示空聊天提示
  const emp = getEmployee(EMPLOYEE_STORE.selectedId);
  if (emptyChat) {
    emptyChat.style.display = (emp && emp._hasMessages) ? 'none' : '';
  }
}


// ── 辅助函数 ──────────────────────────────────────────────────────────────

function _escHtml(s) {
  const div = document.createElement('div');
  div.textContent = s;
  return div.innerHTML;
}


// ── 暴露到全局作用域（供 HTML onclick 调用）────────────────────────────

if (typeof window !== 'undefined') {
  window.toggleMemoryPanel = toggleMemoryPanel;
  window.loadMemory = loadMemory;
  window.switchMemoryTab = switchMemoryTab;
  window.saveMemory = saveMemory;
  window.autoUpdateMemory = autoUpdateMemory;
  window.closeMemoryPanel = closeMemoryPanel;
}
