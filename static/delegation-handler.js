/**
 * delegation-handler.js — 处理 delegate_task 路径的 SSE 事件
 *
 * ★ 2026-04-27 新增
 *   解决"制作人通过 delegate_task 工具委派任务给手下员工后，员工聊天框看不到
 *   任务内容，也看不到思考过程"的 bug。
 *
 * 背景：
 *   前端之前有两种委派路径：
 *     A) 总群 @ 员工 → `_dispatchTaskToEmployee` → 前端创建 DelegationVM.Task
 *        → 新建独立 session → chat/start → 走员工自己的 SSE 流
 *     B) 制作人 agent 在对话中调用 delegate_task 工具 → 后端 spawn child agent
 *        → 走 `run_agent.run_conversation` 独立跑 → 结束后父 session 里
 *           通过 employee_session_bound 把 child_session_id 绑到员工
 *   路径 A 有完整的"实时显示到员工聊天面板"链路；路径 B 完全没有——
 *   父 SSE 只看得到父自己的 token，child 的 token 不会外泄。
 *
 * 新机制：
 *   后端 `tools/delegate_hooks.py` 在 child 构造 / 运行 / 完成时，通过
 *   observer 模式通知所有订阅者；WebUI 的 `streaming.py` 把事件映射为
 *   `delegation_started` / `delegation_token` / `delegation_reasoning` /
 *   `delegation_tool` / `delegation_tool_done` / `delegation_completed`
 *   这 6 个 SSE 事件推给前端。本文件负责在前端消费这些事件：
 *     1. 在 DelegationVM 登记一个 Task（带上 child_session_id / goal / empId）
 *     2. 如果员工画布上还没这位员工，自动创建员工卡片（沿用 employee_created 逻辑）
 *     3. 如果员工聊天面板已打开且指向该员工：
 *        - 插入"制作人派的任务"user message + 任务分隔符
 *        - 按 token/reasoning/tool 事件实时追加到 S.messages
 *     4. 如果员工聊天面板未打开：写入一条"待打开"的状态供事后加载
 *     5. `delegation_completed` 收到后：setTaskStatus=done，触发 UI 刷新
 */

(function() {
  'use strict';

  // taskId (= child_session_id) → 本地状态
  // 保存 accumulator（当前正在输出的 assistant 消息），便于 token 增量拼接
  const _CHILD_STATE = new Map();
  // taskId → 最新的 reasoning accumulator
  const _REASONING_STATE = new Map();

  /** 根据 employee_name 查找已存在的员工；若无，尝试自动创建员工卡片。 */
  function _findOrCreateEmployee(empName, empRole) {
    if (!empName || typeof EMPLOYEE_STORE === 'undefined') return null;
    let emp = EMPLOYEE_STORE.employees.find(e => e && e.name === empName);
    if (emp) return emp;

    // 自动创建：复用 messages.js 的 employee_created 逻辑——直接 push 到 store。
    // 若 AGENT_PRESETS 里有同名预设，带上 preset 元信息；否则生成一个基础卡。
    let preset = null;
    try {
      if (typeof AGENT_PRESETS !== 'undefined' && Array.isArray(AGENT_PRESETS)) {
        preset = AGENT_PRESETS.find(p => p && (p.name === empName || p.title === empName));
      }
    } catch (_) {}

    const newId = 'e_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 6);
    const newEmp = {
      id: newId,
      name: empName,
      role: empRole || (preset && (preset.role || preset.title)) || '',
      avatar: (preset && preset.avatar) || '🤖',
      presetId: (preset && preset.id) || null,
      skills: [],
      model: '',
      status: 'thinking',
      sessionId: null,
      customPrompt: '',
    };
    try {
      EMPLOYEE_STORE.employees.push(newEmp);
      if (typeof _saveEmployees === 'function') _saveEmployees();
      if (typeof _renderEmployeeCards === 'function') _renderEmployeeCards();
    } catch (e) {
      console.warn('[delegation] 自动创建员工失败:', e);
      return null;
    }
    return newEmp;
  }

  /** 判断当前右面板是否正显示该员工的聊天 */
  function _isEmployeePanelActive(empId) {
    if (!empId || typeof EMPLOYEE_STORE === 'undefined') return false;
    if (EMPLOYEE_STORE.selectedId !== empId) return false;
    if (typeof window._rpView !== 'undefined' && window._rpView !== 'chat') return false;
    if (typeof GROUP_CHAT_STATE !== 'undefined' && GROUP_CHAT_STATE.isOpen) return false;
    return true;
  }

  /** 在当前右面板聊天中插入任务分隔符 + 任务内容（若尚未插入） */
  function _ensureTaskHeaderInPanel(emp, task) {
    if (typeof S === 'undefined' || !S.messages) return;
    const taskId = task.id;
    const hasDivider = S.messages.some(m => m._taskDivider && m._taskId === taskId);
    if (!hasDivider) {
      const labelRaw = (task.taskContent || '').split('\n').find(l => l.trim()) || '';
      const labelShort = labelRaw.length > 60 ? labelRaw.slice(0, 60) + '…' : labelRaw;
      S.messages.push({
        role: 'system',
        content: `📋 制作人委派任务 #${taskId.slice(0, 8)}`,
        _taskDivider: true,
        _taskId: taskId,
        _taskStatus: 'running',
        _taskLabel: labelShort,
        _ts: Date.now() / 1000,
      });
    }
    const hasTaskMsg = S.messages.some(m =>
      m.role === 'user' && m._taskId === taskId
    );
    if (!hasTaskMsg && task.taskContent) {
      S.messages.push({
        role: 'user',
        content: task.taskContent,
        _ts: Date.now() / 1000,
        _taskId: taskId,
      });
    }
    if (typeof _renderRpMessages === 'function') _renderRpMessages();
  }

  /**
   * 获取当前任务 state（若不存在则初始化）。
   * state 保存 assistant 文本 accumulator、最后一条消息索引、reasoning 等。
   */
  function _getChildState(taskId) {
    let st = _CHILD_STATE.get(taskId);
    if (!st) {
      st = {
        assistantText: '',        // 当前正在输出的 assistant 文本（未 append 到 S.messages）
        reasoningText: '',        // reasoning 累积
        msgIndex: -1,             // 对应 S.messages 中的 index（-1 表示尚未插入）
        taskId,
      };
      _CHILD_STATE.set(taskId, st);
    }
    return st;
  }

  /** 更新 S.messages 中某个 _taskId 的 assistant live message，否则新建 */
  function _upsertAssistantLive(taskId, text, reasoning) {
    if (typeof S === 'undefined' || !S.messages) return;
    // 查找该 taskId 的 live assistant 消息
    let idx = S.messages.findIndex(m => m._taskId === taskId && m.role === 'assistant' && m._delegationLive);
    if (idx === -1) {
      S.messages.push({
        role: 'assistant',
        content: text || '',
        reasoning: reasoning || '',
        _ts: Date.now() / 1000,
        _taskId: taskId,
        _delegationLive: true,
      });
    } else {
      S.messages[idx].content = text || '';
      if (reasoning !== undefined) S.messages[idx].reasoning = reasoning;
    }
    if (typeof _renderRpMessages === 'function') _renderRpMessages();
  }

  /** 把工具调用事件作为一条辅助消息插入（类似 CLI 的 ├─ tool_name 行） */
  function _appendToolEvent(taskId, toolName, preview, phase) {
    if (typeof S === 'undefined' || !S.messages) return;
    const icon = phase === 'tool.completed' ? '✓' : '⚙';
    const prefix = phase === 'tool.completed' ? '[工具完成]' : '[调用工具]';
    S.messages.push({
      role: 'system',
      content: `${icon} ${prefix} ${toolName}${preview ? ' — ' + preview.slice(0, 80) : ''}`,
      _ts: Date.now() / 1000,
      _taskId: taskId,
      _delegationTool: true,
    });
    if (typeof _renderRpMessages === 'function') _renderRpMessages();
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // SSE 事件处理器（由 messages.js 的 EventSource 监听后调用）
  // ═══════════════════════════════════════════════════════════════════════════

  /** delegation_started: 父 agent 的 delegate_task 刚 spawn 了一个 child */
  function handleDelegationStarted(d) {
    try {
      const childSid = d.child_session_id;
      const empName = d.employee_name || '';
      const empRole = d.employee_role || '';
      const goal = d.goal || '';
      if (!childSid) return;

      // 1. 找 / 建员工
      const emp = empName ? _findOrCreateEmployee(empName, empRole) : null;

      // 2. 用 child_session_id 作为 taskId，登记到 DelegationVM
      const taskId = childSid;  // 唯一稳定 ID
      let task = null;
      if (typeof DelegationVM !== 'undefined') {
        task = DelegationVM.getTask(taskId);
        if (!task && emp) {
          task = DelegationVM.createTask({
            taskId,
            emp,
            taskContent: goal || '（未提供任务描述）',
            workspace: (d.workspace || (typeof S !== 'undefined' && S.session && S.session.workspace) || ''),
            requesterName: '制作人',
          });
          if (task) {
            task.sessionId = childSid;
            task.status = 'running';
            if (DelegationVM._persistTask) DelegationVM._persistTask(task);
          }
        }
      }

      // 3. 员工状态 = thinking
      if (emp && typeof setEmployeeStatus === 'function') {
        setEmployeeStatus(emp.id, 'thinking');
      }

      // 4. 如果当前右面板就是这位员工，立即插入任务卡
      if (emp && task && _isEmployeePanelActive(emp.id)) {
        _ensureTaskHeaderInPanel(emp, task);
      }

      console.log('[delegation] started:', {taskId, empName, goal: goal.slice(0, 80)});
    } catch (e) {
      console.warn('[delegation] handleDelegationStarted err:', e);
    }
  }

  /** delegation_token: child agent 流式输出一个 token */
  function handleDelegationToken(d) {
    const taskId = d.child_session_id;
    const empName = d.employee_name || '';
    const delta = d.delta || '';
    if (!taskId || !delta) return;

    const st = _getChildState(taskId);
    st.assistantText += delta;

    // 仅当右面板显示该员工时，才实时渲染（否则只累积，等打开再一次性显示）
    if (empName && typeof EMPLOYEE_STORE !== 'undefined') {
      const emp = EMPLOYEE_STORE.employees.find(e => e && e.name === empName);
      if (emp && _isEmployeePanelActive(emp.id)) {
        const task = (typeof DelegationVM !== 'undefined') ? DelegationVM.getTask(taskId) : null;
        if (task) _ensureTaskHeaderInPanel(emp, task);
        _upsertAssistantLive(taskId, st.assistantText, st.reasoningText);
      }
    }
  }

  /** delegation_reasoning: child 的思考过程（reasoning token） */
  function handleDelegationReasoning(d) {
    const taskId = d.child_session_id;
    const empName = d.employee_name || '';
    const delta = d.delta || '';
    if (!taskId || !delta) return;

    const st = _getChildState(taskId);
    st.reasoningText += delta;

    if (empName && typeof EMPLOYEE_STORE !== 'undefined') {
      const emp = EMPLOYEE_STORE.employees.find(e => e && e.name === empName);
      if (emp && _isEmployeePanelActive(emp.id)) {
        const task = (typeof DelegationVM !== 'undefined') ? DelegationVM.getTask(taskId) : null;
        if (task) _ensureTaskHeaderInPanel(emp, task);
        _upsertAssistantLive(taskId, st.assistantText, st.reasoningText);
      }
    }
  }

  /** delegation_tool: child agent 开始调用一个工具 */
  function handleDelegationTool(d) {
    const taskId = d.child_session_id;
    const empName = d.employee_name || '';
    const toolName = d.tool_name || '';
    const preview = d.preview || '';
    if (!taskId || !toolName) return;

    // 当前 assistant 输出是一个独立片段；此刻把它 flush 成一条"已完成"消息
    // （去掉 _delegationLive 标记），然后后续 token 会新建下一条
    const st = _getChildState(taskId);
    if (st.assistantText) {
      if (typeof S !== 'undefined' && S.messages) {
        const idx = S.messages.findIndex(m => m._taskId === taskId && m.role === 'assistant' && m._delegationLive);
        if (idx !== -1) {
          delete S.messages[idx]._delegationLive;
        }
      }
      st.assistantText = '';
      st.reasoningText = '';
    }

    if (empName && typeof EMPLOYEE_STORE !== 'undefined') {
      const emp = EMPLOYEE_STORE.employees.find(e => e && e.name === empName);
      if (emp && _isEmployeePanelActive(emp.id)) {
        _appendToolEvent(taskId, toolName, preview, 'tool.started');
      }
    }
  }

  /** delegation_tool_done: child agent 工具调用完成 */
  function handleDelegationToolDone(d) {
    // 简洁起见，仅当有 error 时才追加 UI 提示
    if (d && d.is_error) {
      const taskId = d.child_session_id;
      const empName = d.employee_name || '';
      const toolName = d.tool_name || '';
      if (empName && taskId) {
        const emp = (typeof EMPLOYEE_STORE !== 'undefined')
          ? EMPLOYEE_STORE.employees.find(e => e && e.name === empName) : null;
        if (emp && _isEmployeePanelActive(emp.id)) {
          _appendToolEvent(taskId, toolName, '(执行出错)', 'tool.completed');
        }
      }
    }
  }

  /** delegation_completed: child agent 跑完了，拿到 summary */
  function handleDelegationCompleted(d) {
    try {
      const taskId = d.child_session_id;
      const empName = d.employee_name || '';
      const status = d.status || 'completed';
      const summary = d.summary || '';
      const duration = Number(d.duration_seconds || 0);
      if (!taskId) return;

      // 1. flush 最后一段 assistant
      const st = _getChildState(taskId);
      if (st.assistantText && typeof S !== 'undefined' && S.messages) {
        const idx = S.messages.findIndex(m => m._taskId === taskId && m.role === 'assistant' && m._delegationLive);
        if (idx !== -1) {
          S.messages[idx].content = st.assistantText;
          delete S.messages[idx]._delegationLive;
        }
      }
      _CHILD_STATE.delete(taskId);
      _REASONING_STATE.delete(taskId);

      // 2. DelegationVM 状态更新
      if (typeof DelegationVM !== 'undefined' && DelegationVM.setTaskStatus) {
        const _s = status === 'completed' ? 'done' : (status === 'failed' ? 'error' : status);
        DelegationVM.setTaskStatus(taskId, _s);
      }

      // 3. 插入 summary 总结 + 更新分隔符状态
      if (empName && typeof EMPLOYEE_STORE !== 'undefined') {
        const emp = EMPLOYEE_STORE.employees.find(e => e && e.name === empName);
        if (emp) {
          if (typeof setEmployeeStatus === 'function') {
            setEmployeeStatus(emp.id, status === 'completed' ? 'idle' : 'error');
          }
          if (_isEmployeePanelActive(emp.id)) {
            // 更新 divider 的 _taskStatus
            if (typeof S !== 'undefined' && S.messages) {
              for (const m of S.messages) {
                if (m._taskDivider && m._taskId === taskId) {
                  m._taskStatus = status === 'completed' ? 'done' : 'error';
                }
              }
              // 若 summary 还没以 assistant 形式出现过，补一条
              if (summary) {
                const hasSummary = S.messages.some(m =>
                  m._taskId === taskId && m.role === 'assistant' &&
                  String(m.content || '').trim() === summary.trim()
                );
                if (!hasSummary) {
                  S.messages.push({
                    role: 'assistant',
                    content: summary,
                    _ts: Date.now() / 1000,
                    _taskId: taskId,
                    _delegationSummary: true,
                  });
                }
              }
              // 任务结束行（耗时）
              S.messages.push({
                role: 'system',
                content: `✓ 任务完成（${duration.toFixed(1)}s）`,
                _ts: Date.now() / 1000,
                _taskId: taskId,
                _delegationEnd: true,
              });
              if (typeof _renderRpMessages === 'function') _renderRpMessages();
            }
          }
        }
      }

      console.log('[delegation] completed:', {taskId, empName, status, summary: summary.slice(0, 80)});
    } catch (e) {
      console.warn('[delegation] handleDelegationCompleted err:', e);
    }
  }

  // 暴露到全局
  window.handleDelegationStarted = handleDelegationStarted;
  window.handleDelegationToken = handleDelegationToken;
  window.handleDelegationReasoning = handleDelegationReasoning;
  window.handleDelegationTool = handleDelegationTool;
  window.handleDelegationToolDone = handleDelegationToolDone;
  window.handleDelegationCompleted = handleDelegationCompleted;
})();
