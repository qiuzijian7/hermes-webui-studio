/**
 * peer-delegate.js — 员工间任务分派（Peer-to-Peer Delegation）
 *
 * 场景：员工 A 在自己的聊天框里 @员工B 请 B 执行某任务。
 *   - B 立刻调用模型执行（复用总群的派发基础设施：队列、独立 session、SSE）
 *   - B 的思考过程、工具调用、输出在 B 的聊天框里显示（_tryAttachLiveStreamToRpPanel）
 *   - B 完成后，结果以"来自 @B 的任务 #xxx 执行结果"的形式回传 A 的聊天框
 *   - A 收到后由模型评估，决定是否继续迭代（正常的 agent loop）
 *
 * 本模块提供的入口：
 *   - parsePeerMentions(text, excludeEmpId) -> [{name, empId}]
 *   - dispatchPeerTask({fromEmp, toEmp, taskContent, rawText}) -> Promise<taskId>
 *
 * 在 messages.js `send()` 开头会检测并拦截 @mention，调用本模块。
 */
(function(){
  'use strict';

  // 与 group-chat.js 一致的 @mention 正则
  const MENTION_RE = /@([\w\u4e00-\u9fff\u3400-\u4dbf]+)/g;

  /**
   * 从文本中解析所有 @mention 员工（按当前 EMPLOYEE_STORE 做名字匹配）。
   * @param {string} text
   * @param {string} [excludeEmpId] 排除的员工 ID（通常是发起方，防止自己@自己）
   * @returns {Array<{name:string, empId:string}>}
   */
  function parsePeerMentions(text, excludeEmpId){
    if (!text || typeof EMPLOYEE_STORE === 'undefined') return [];
    const employees = EMPLOYEE_STORE.employees || [];
    const found = [];
    const seen = new Set();
    let m;
    MENTION_RE.lastIndex = 0;
    while ((m = MENTION_RE.exec(text)) !== null) {
      const name = m[1];
      if (!name) continue;
      const emp = employees.find(e => e.name === name);
      if (!emp) continue;
      if (excludeEmpId && emp.id === excludeEmpId) continue;
      if (seen.has(emp.id)) continue;
      seen.add(emp.id);
      found.push({ name: emp.name, empId: emp.id });
    }
    return found;
  }

  /**
   * 生成一个 peer 任务 ID。
   */
  function _genTaskId(){
    return 'peer-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8);
  }

  /**
   * 把 B 完成的结果回传给 A 的聊天框：
   *   - 调 /api/chat/start，消息内容形如"来自 @B 的任务 #xxx 执行结果：..."
   *   - 返回的 stream_id 交给 messages.js 的 SSE 处理（当 A 聊天框激活时实时渲染）
   *
   * @param {object} ctx {fromEmp, toEmp, taskId, result}
   */
  async function _postbackResultToRequester(ctx){
    const { fromEmp, toEmp, taskId, result } = ctx;
    if (!fromEmp || !toEmp || !result) return;
    // 发起方必须已有 session（否则没有上下文可继续迭代）
    const fromSid = fromEmp.sessionId;
    if (!fromSid) {
      console.warn('[peer-delegate] 发起方无 sessionId，跳过回传', fromEmp.name);
      return;
    }
    const sysPrompt = typeof buildEmployeeSystemPrompt === 'function'
      ? buildEmployeeSystemPrompt(fromEmp) : '';
    const model = fromEmp.model || ($('modelSelect') && $('modelSelect').value) || '';
    const workspace = (typeof S !== 'undefined' && S.session && S.session.workspace) || '';

    // 构造回传消息（作为 user message 注入到 A 的会话）
    const feedbackMsg = `[来自 @${toEmp.name} 的任务 #${taskId} 执行结果]

${result}

---
请评估上述结果：
1. 若满足你委派的目标 → 简要总结并推进后续任务；
2. 若存在不足/偏差 → 说明原因并再次调用 \`@${toEmp.name}\`（或其他合适员工）迭代，直到达成目标；
3. 若需要澄清/补充信息 → 提出具体问题。`;

    try {
      console.log('[peer-delegate] 回传到发起方', fromEmp.name, 'session=', fromSid);
      const startData = await api('/api/chat/start', {
        method: 'POST',
        body: JSON.stringify({
          session_id: fromSid,
          message: feedbackMsg,
          model: model,
          workspace: workspace || undefined,
          system_prompt: sysPrompt || undefined,
          employee_name: fromEmp.name || '',
        }),
      });
      const streamId = startData && startData.stream_id;
      if (!streamId) return;

      // 若 A 聊天框当前激活 → 直接附加渲染：
      //   - 插一条 user 消息让用户看到"自动注入的回传+评估请求"
      //   - 再调 _attachLiveStreamToChat 接入 SSE 实时渲染 A 的回复
      const aIsActive = typeof EMPLOYEE_STORE !== 'undefined'
        && EMPLOYEE_STORE.selectedId === fromEmp.id
        && (!window._rpView || window._rpView === 'chat')
        && !(typeof GROUP_CHAT_STATE !== 'undefined' && GROUP_CHAT_STATE.isOpen);

      let rpAttached = false;
      if (aIsActive && typeof S !== 'undefined' && S.messages
          && S.session && S.session.session_id === fromSid) {
        try {
          S.messages.push({
            role: 'user',
            content: feedbackMsg,
            _ts: Date.now() / 1000,
            _peerFeedback: true,
            _peerTaskId: taskId,
          });
          if (typeof _renderRpMessages === 'function') _renderRpMessages();
        } catch(_){}
        if (typeof _attachLiveStreamToChat === 'function') {
          try {
            _attachLiveStreamToChat(fromEmp, {
              id: 'feedback-' + taskId,
              streamId: streamId,
              sessionId: fromSid,
              taskContent: feedbackMsg,
              workspace: workspace,
              createdAt: Date.now(),
              accumulatedText: '',
            });
            rpAttached = true;
          } catch(e) {
            console.warn('[peer-delegate] _attachLiveStreamToChat 失败:', e);
          }
        }
      }

      // 无论是否 attached，都开一条后台 SSE 监听 done（用于 A 不在前台时的token累积 + 刷新员工卡片状态）
      // 当 rpAttached=true 时，_attachLiveStreamToChat 已消费 token；这里再开一条会争抢 Queue。
      // 因此：只有 A 不在前台时才开后台监听。
      if (!rpAttached) {
        _watchPeerFeedbackStream({ fromEmp, toEmp, taskId, streamId });
      }
    } catch(e) {
      console.warn('[peer-delegate] 回传 /api/chat/start 失败:', e);
      showToast('回传结果到 @' + (fromEmp.name || '发起方') + ' 失败: ' + e.message);
    }
  }

  /**
   * 后台监听 A 的回传 stream，仅在 A 聊天框未打开时使用；done 时更新员工状态。
   */
  function _watchPeerFeedbackStream(ctx){
    const { fromEmp, streamId } = ctx;
    if (!streamId) return;
    try {
      const url = new URL('/api/chat/stream?stream_id=' + encodeURIComponent(streamId), location.origin).href;
      const src = new EventSource(url, { withCredentials: true });

      if (typeof setEmployeeStatus === 'function' && fromEmp && fromEmp.id) {
        setEmployeeStatus(fromEmp.id, 'thinking');
      }

      src.addEventListener('token', () => {
        if (typeof setEmployeeStatus === 'function' && fromEmp && fromEmp.id) {
          setEmployeeStatus(fromEmp.id, 'working');
        }
      });
      src.addEventListener('done', () => {
        try { src.close(); } catch(_){}
        if (typeof setEmployeeStatus === 'function' && fromEmp && fromEmp.id) {
          setEmployeeStatus(fromEmp.id, 'idle');
        }
      });
      src.addEventListener('apperror', () => {
        try { src.close(); } catch(_){}
        if (typeof setEmployeeStatus === 'function' && fromEmp && fromEmp.id) {
          setEmployeeStatus(fromEmp.id, 'error');
        }
      });
      src.addEventListener('cancel', () => {
        try { src.close(); } catch(_){}
        if (typeof setEmployeeStatus === 'function' && fromEmp && fromEmp.id) {
          setEmployeeStatus(fromEmp.id, 'idle');
        }
      });
      src.addEventListener('error', () => {
        try { src.close(); } catch(_){}
      });
    } catch(e) {
      console.warn('[peer-delegate] 无法打开后台回传 SSE:', e);
    }
  }

  /**
   * 派发一个 peer 任务（A → B）。
   *   - 复用 _dispatchTaskToEmployee 的队列/SSE/RP接入逻辑
   *   - 额外挂一个"任务完成 → 回传结果给 A"的 hook
   *
   * @param {object} args {fromEmp, toEmp, taskContent, rawText}
   * @returns {Promise<string>} taskId
   */
  async function dispatchPeerTask(args){
    const { fromEmp, toEmp, taskContent } = args || {};
    if (!fromEmp || !toEmp) {
      console.warn('[peer-delegate] 缺少 fromEmp/toEmp');
      return null;
    }
    if (typeof _dispatchTaskToEmployee !== 'function') {
      showToast('派发功能不可用（_dispatchTaskToEmployee 未加载）');
      return null;
    }

    const taskId = _genTaskId();
    console.log('[peer-delegate] 发起 peer 派发', fromEmp.name, '→', toEmp.name, 'taskId=', taskId);

    // 在 A 的聊天框里本地 echo 一条"我委派给 B"的系统提示，便于用户理解
    try {
      if (typeof S !== 'undefined' && S.messages && fromEmp.sessionId === (S.session && S.session.session_id)) {
        S.messages.push({
          role: 'system',
          content: `🔗 已委派任务 #${taskId} 给 @${toEmp.name}，等待其结果后继续…`,
          _peerDispatch: true,
          _taskId: taskId,
          _ts: Date.now() / 1000,
        });
        if (typeof _renderRpMessages === 'function') _renderRpMessages();
        else if (typeof renderMessages === 'function') renderMessages();
      }
    } catch(_){}

    // 复用总群派发（会入 B 的队列、创建独立 session、SSE 接入 B 聊天框）
    // 任务文案带上 @B 前缀以触发 _dispatchTaskToEmployee 内部的 strip 逻辑
    const fullText = `@${toEmp.name} ${taskContent}`;
    const peerHint = `

---
🤝 **协作上下文**：本任务由 **@${fromEmp.name}** 通过员工间 @mention 委派给你。完成后请直接给出结果（文件清单 + 关键决策），系统会自动把结果回传给 @${fromEmp.name} 的聊天框由其评估。`;

    await _dispatchTaskToEmployee(toEmp.name, fullText + peerHint, taskId, { peer: true });

    // 挂一个轮询钩子：观察 task.status === 'done' 后回传结果
    _schedulePeerDoneHook({ fromEmp, toEmp, taskId });

    return taskId;
  }

  /**
   * 轮询等待 peer 任务完成，成功后把结果回传发起方。
   * 用轮询而非事件订阅是因为 DelegationVM 目前没有对外暴露 done 事件。
   */
  function _schedulePeerDoneHook(ctx){
    const { fromEmp, toEmp, taskId } = ctx;
    if (typeof DelegationVM === 'undefined') return;

    const MAX_MS = 15 * 60 * 1000;  // 15 分钟上限
    const started = Date.now();
    let postedOnce = false;

    const timer = setInterval(async () => {
      if (Date.now() - started > MAX_MS) {
        console.warn('[peer-delegate] 等待超时，放弃回传', taskId);
        clearInterval(timer);
        return;
      }
      const task = DelegationVM.getTask ? DelegationVM.getTask(taskId) : null;
      if (!task) return;  // 还没登记，继续等

      if (task.status === 'cancelled' || task.status === 'error') {
        clearInterval(timer);
        if (postedOnce) return;
        postedOnce = true;
        // 通知 A：B 任务失败/取消
        const failMsg = task.status === 'cancelled'
          ? `⏹ @${toEmp.name} 的任务 #${taskId} 已取消。`
          : `❌ @${toEmp.name} 的任务 #${taskId} 执行失败。`;
        await _postbackResultToRequester({
          fromEmp, toEmp, taskId, result: failMsg,
        });
        return;
      }

      if (task.status !== 'done') return;
      clearInterval(timer);
      if (postedOnce) return;
      postedOnce = true;

      // 从 task.sessionId 取最终结果（更完整），回退到 accumulatedText
      let finalResult = '';
      if (task.sessionId) {
        try {
          const sData = await api('/api/session?session_id=' + encodeURIComponent(task.sessionId));
          if (sData && sData.session && sData.session.messages) {
            const msgs = sData.session.messages;
            const lastAsst = [...msgs].reverse().find(m => m.role === 'assistant' && m.content);
            if (lastAsst) {
              finalResult = typeof lastAsst.content === 'string'
                ? lastAsst.content
                : JSON.stringify(lastAsst.content);
            }
          }
        } catch(_){}
      }
      if (!finalResult) {
        finalResult = (typeof _stripThinkingTags === 'function'
          ? _stripThinkingTags(String(task.accumulatedText || '').trim())
          : String(task.accumulatedText || '').trim()) || '（无内容）';
      } else if (typeof _stripThinkingTags === 'function') {
        finalResult = _stripThinkingTags(finalResult);
      }

      console.log('[peer-delegate] peer 任务完成，回传结果到', fromEmp.name, 'len=', finalResult.length);
      await _postbackResultToRequester({
        fromEmp, toEmp, taskId, result: finalResult,
      });
    }, 1500);
  }

  // 暴露到全局
  window.parsePeerMentions = parsePeerMentions;
  window.dispatchPeerTask = dispatchPeerTask;
})();
