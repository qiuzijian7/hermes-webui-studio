// ★ 全局判断：当前是否处于"员工右面板对话"模式
//   从 _wireSSE 内部提升为全局函数，使 send() 等外部函数也能调用
function _isEmployeeRpMode(){
  return typeof EMPLOYEE_STORE!=='undefined'
    && EMPLOYEE_STORE.selectedId
    && (!window._rpView || window._rpView==='chat');
}

async function send(){
  const text=$('msg').value.trim();
  const pendingFiles=S.pendingFiles||[];
  if(!text&&!pendingFiles.length)return;
  console.log('[send] called, S.busy=', S.busy);
  // Slash command intercept -- local commands handled without agent round-trip
  if(text.startsWith('/')&&!pendingFiles.length&&executeCommand(text)){
    $('msg').value='';autoResize();hideCmdDropdown();return;
  }
  // Don't send while an inline message edit is active
  if(document.querySelector('.msg-edit-area'))return;

  // PM专员聊天时的 @mention 委派检测
  const pmEmp=(typeof getPMEmployee==='function')?getPMEmployee():null;
  const isPMChat=pmEmp && EMPLOYEE_STORE.selectedId===pmEmp.id;
  if(isPMChat && /@[\w\u4e00-\u9fff]+/.test(text)){
    console.log('[send] PM @mention 委派, text=', text);
    if(typeof UAL!=='undefined') UAL.log('message','send-to-coordinator',{textLen:text.length,textPreview:text.slice(0,50)});
    $('msg').value='';autoResize();hideCmdDropdown();
    await sendGroupMessage(text);
    return;
  }

  // ★ Peer 派发拦截：在员工 A 的聊天框中 @员工B → 把任务派发给 B，
  //    B 的执行过程显示在 B 的聊天框；B 完成后结果回传到 A 的聊天框由 A 评估。
  //    仅在"有选中员工 + 文本包含可解析的 @其他员工"时生效。
  if(text
     && typeof EMPLOYEE_STORE!=='undefined' && EMPLOYEE_STORE.selectedId
     && typeof parsePeerMentions==='function' && typeof dispatchPeerTask==='function'
     && typeof getEmployee==='function'){
    const _fromEmp=getEmployee(EMPLOYEE_STORE.selectedId);
    const _mentions=_fromEmp ? parsePeerMentions(text, _fromEmp.id) : [];
    if(_fromEmp && _mentions.length){
      console.log('[send] peer 派发拦截, from=', _fromEmp.name,
                  '→', _mentions.map(m=>m.name).join(','));
      $('msg').value='';autoResize();hideCmdDropdown();
      // 在 A 的聊天框里本地 echo 用户原始指令（作为 user 消息显示）
      try{
        const userEcho={role:'user',content:text,_ts:Date.now()/1000,_peerDispatch:true};
        S.messages.push(userEcho);
        if(typeof _renderRpMessages==='function') _renderRpMessages();
        else if(typeof renderMessages==='function') renderMessages();
        // 持久化到 A 的后端 session（防止切换员工后消息消失）
        if(typeof api==='function' && _fromEmp.sessionId){
          try {
            await api('/api/session/message',{
              method:'POST',
              body:JSON.stringify({session_id:_fromEmp.sessionId,role:'user',content:text}),
            });
          }catch(_){}
        }
      }catch(_){}
      // 去除 @mention 前缀，得到干净的任务内容
      let _cleanedTask=text;
      for(const m of _mentions){
        const re=new RegExp('@'+m.name.replace(/[.*+?^${}()|[\\]\\\\]/g,'\\$&')+'\\s*','g');
        _cleanedTask=_cleanedTask.replace(re,'').trim();
      }
      if(!_cleanedTask) _cleanedTask='请根据上下文执行任务';
      // 逐个派发（通常只有一个）
      for(const m of _mentions){
        const _toEmp=getEmployee(m.empId);
        if(!_toEmp) continue;
        // 若 A 尚未创建 session，先建一个（以便 B 完成后能回传到 A 的 session）
        if(!_fromEmp.sessionId && typeof openEmployeeChat==='function'){
          try{await openEmployeeChat(_fromEmp.id);}catch(_){}
        }
        try{
          await dispatchPeerTask({
            fromEmp:_fromEmp,
            toEmp:_toEmp,
            taskContent:_cleanedTask,
            rawText:text,
          });
          if(typeof showToast==='function'){
            showToast('已委派给 @'+_toEmp.name+'，完成后结果会回传到此处');
          }
        }catch(e){
          console.warn('[send] peer 派发失败:', e);
          if(typeof showToast==='function') showToast('派发失败: '+e.message);
        }
      }
      return;
    }
  }

  // 方案 B：员工级任务队列 —— 若当前员工正在跑任务（委派/手动），入队
  if(typeof EMPLOYEE_STORE!=='undefined'&&EMPLOYEE_STORE.selectedId
     &&typeof DelegationVM!=='undefined'&&typeof getEmployee==='function'){
    const _curEmp=getEmployee(EMPLOYEE_STORE.selectedId);
    if(_curEmp){
      const runningJob=DelegationVM.getRunningJob(_curEmp.id);
      if(runningJob){
        // 员工有在跑的任务（委派或手动），入队
        const pendingText=text;
        const pendingFilesSnap=(S.pendingFiles||[]).slice();
        $('msg').value='';autoResize();
        S.pendingFiles=[];
        if(typeof renderTray==='function') renderTray();
        const manualJobId='m_'+Date.now()+'_'+Math.random().toString(36).slice(2,8);
        const manualJob={
          id:manualJobId,
          empId:_curEmp.id,
          kind:'manual',
          pendingText,
          pendingFilesSnap,
          startFn:async()=>{
            // 恢复输入框 + pending files，再次调 send()（此时员工空闲了）
            S.pendingFiles=(manualJob.pendingFilesSnap||[]).slice();
            if(typeof renderTray==='function') renderTray();
            $('msg').value=manualJob.pendingText||'';
            autoResize();
            // 标记"本次 send 是从队列中 drain 出来的 manual job"，避免重入队
            S._manualJobDraining=manualJob;
            await send();
          },
          cancelFn:async()=>{
            // manual job 未启动即取消：无需后端动作
            console.log('[队列] manual job 取消', manualJob.id);
          },
        };
        const pos=DelegationVM.enqueueJob(manualJob);
        if(typeof UAL!=='undefined') UAL.log('message','enqueue',{empName:_curEmp.name,pos,textLen:text.length});
        if(typeof showToast==='function'){
          showToast(`员工「${_curEmp.name}」正在处理任务，你的消息已加入队列（第 ${pos} 位）`,3500);
        }
        return;
      }
    }
  }

  // If busy, queue the message instead of dropping it
  if(S.busy){
    if(text){
      MSG_QUEUE.push(text);
      if(typeof UAL!=='undefined') UAL.log('message','busy-queue',{textLen:text.length,queueLen:MSG_QUEUE.length});
      $('msg').value='';autoResize();
      updateQueueBadge();
      showToast(`Queued: "${text.slice(0,40)}${text.length>40?'\u2026':''}"`,2000);
    }
    return;
  }

  if(!S.session){
    // ★ 如果有选中的员工，通过 openEmployeeChat 为员工创建 session（而非通用的 newSession）
    // 这样 session 会绑定到员工，消息发到正确的 session
    if(typeof EMPLOYEE_STORE!=='undefined'&&EMPLOYEE_STORE.selectedId&&typeof openEmployeeChat==='function'){
      const _empId=EMPLOYEE_STORE.selectedId;
      await openEmployeeChat(_empId);
      // openEmployeeChat 会设置 S.session 和 emp.sessionId
    } else {
      await newSession();
    }
    await renderSessionList();
    // 安全守卫：如果 session 仍为 null（API 失败等），中止发送
    if(!S.session){
      setComposerStatus('无法创建会话，请重试');
      return;
    }
  }

  const activeSid=S.session.session_id;

  // 员工级配置：从当前选中员工获取独立 system prompt 和 model
  let _empSysPrompt='';
  let _empModel='';
  // ★ 2026-04-27 Bug 修复：_emp 之前是块作用域 const，到 line 245 已失效导致
  //   "_emp is not defined"。提升到 send() 函数作用域，整个函数都能安全引用。
  let _emp=null;
  if(typeof EMPLOYEE_STORE!=='undefined'&&EMPLOYEE_STORE.selectedId&&typeof getEmployee==='function'&&typeof buildEmployeeSystemPrompt==='function'){
    _emp=getEmployee(EMPLOYEE_STORE.selectedId);
    if(_emp){
      // 优先使用后端异步构建（Jinja2 + 多语言 + skill 内容），失败降级到同步本地
      if(typeof buildEmployeeSystemPromptAsync==='function'){
        try{
          _empSysPrompt=await buildEmployeeSystemPromptAsync(_emp);
        }catch(_){
          _empSysPrompt=buildEmployeeSystemPrompt(_emp);
        }
      }else{
        _empSysPrompt=buildEmployeeSystemPrompt(_emp);
      }
      _empModel=_emp.model||'';
      // 规范化：短名称（如 'sonnet'）→ 完整模型 ID（如 'anthropic/claude-sonnet-4.6'）
      // 同时更新员工的 model 字段，避免下次再走 fallback
      if(_empModel && typeof _findModelInDropdown==='function' && $('modelSelect')){
        const resolved=_findModelInDropdown(_empModel,$('modelSelect'));
        if(resolved && resolved!==_empModel){
          _empModel=resolved;
          _emp.model=resolved;
          if(typeof _saveEmployees==='function') _saveEmployees();
          if(typeof _updateCardTokenUsage==='function') _updateCardTokenUsage(_emp);
        }
      }
      // ★ 如果员工记忆的模型已在下拉里不可用（如 cli: backend 被删）
      //   回退到下拉当前选中的模型，并同步写回员工。
      if(_empModel){
        const sel=$('modelSelect');
        if(sel && sel.options){
          const opts=Array.from(sel.options).map(o=>o.value);
          if(!opts.includes(_empModel)){
            const fallback=sel.value || (opts[0]||'');
            if(fallback && fallback!==_empModel){
              console.warn('[model] employee model "'+_empModel+'" not in dropdown, falling back to "'+fallback+'"');
              if(typeof showToast==='function') showToast('员工记忆的模型 '+_empModel+' 已不可用，已切换到 '+fallback);
              _empModel=fallback;
              _emp.model=fallback;
              if(typeof _saveEmployees==='function') _saveEmployees();
            }
          }
        }
      }
    }
  }

  setComposerStatus(pendingFiles.length?'Uploading…':'');
  let uploaded=[];
  try{uploaded=await uploadPendingFiles();}
  catch(e){if(!text){setComposerStatus(`Upload error: ${e.message}`);return;}}

  let msgText=text;
  if(uploaded.length&&!msgText)msgText=`I've uploaded ${uploaded.length} file(s): ${uploaded.join(', ')}`;
  else if(uploaded.length)msgText=`${text}\n\n[Attached files: ${uploaded.join(', ')}]`;
  if(!msgText){setComposerStatus('Nothing to send');return;}

  $('msg').value='';autoResize();
  const displayText=text||(uploaded.length?`Uploaded: ${uploaded.join(', ')}`:'(file upload)');
  const userMsg={role:'user',content:displayText,attachments:uploaded.length?uploaded:undefined,_ts:Date.now()/1000};
  S.toolCalls=[];  // clear tool calls from previous turn
  clearLiveToolCards();  // clear any leftover live cards from last turn
  S.messages.push(userMsg);
  // ★ 员工模式：渲染到右侧面板（rpMsgInner），而非左侧主面板（msgInner）
  if(_isEmployeeRpMode()){
    try{if(typeof _renderRpMessages==='function') _renderRpMessages();}catch(_){}
  } else {
    try{renderMessages();}catch(_){}
  }
  // 用户发送消息：强制滚到底（看到自己发的消息），并重置粘底标记
  try{ if(typeof _scrollMsgAreaToBottom==='function') _scrollMsgAreaToBottom(); }catch(_){}
  try{appendThinking();}catch(_){}
  setBusy(true);
  // 记录发送消息时的员工ID（完成后用此ID重置状态，而非selectedId）
  const _sendEmpId = (typeof EMPLOYEE_STORE!=='undefined') ? EMPLOYEE_STORE.selectedId : null;
  // 更新员工状态为思考中
  if(_sendEmpId && typeof setEmployeeStatus==='function'){
    setEmployeeStatus(_sendEmpId,'thinking');
  }
  INFLIGHT[activeSid]={messages:[...S.messages],uploaded};
  startApprovalPolling(activeSid);
  S.activeStreamId = null;  // will be set after stream starts

  // Set provisional title from user message immediately so session appears
  // in the sidebar right away with a meaningful name (server may refine later)
  if(S.session&&(S.session.title==='Untitled'||!S.session.title)){
    const provisionalTitle=displayText.slice(0,64);
    S.session.title=provisionalTitle;
    syncTopbar();
    // Persist it and refresh the sidebar now -- don't wait for done
    api('/api/session/rename',{method:'POST',body:JSON.stringify({
      session_id:activeSid, title:provisionalTitle
    })}).catch(()=>{});  // fire-and-forget, server refines on done
    renderSessionList();  // session appears in sidebar immediately
  } else {
    renderSessionList();  // ensure it's visible even if already titled
  }

  // Start the agent via POST, get a stream_id back
  let streamId;
  try{
    const startData=await api('/api/chat/start',{method:'POST',body:JSON.stringify({
      session_id:activeSid,message:msgText,
      model:_empModel||S.session.model||$('modelSelect').value,
      workspace:S.session.workspace,
      attachments:uploaded.length?uploaded:undefined,
      system_prompt:_empSysPrompt||undefined,
      employee_name:(_emp&&_emp.name)||'',
      enable_web_search:window._webSearchEnabled||false,
    })});
    streamId=startData.stream_id;
    S.activeStreamId = streamId;
    markInflight(activeSid, streamId);
    // Show Cancel button
    const cancelBtn=$('btnCancel');
    if(cancelBtn) cancelBtn.style.display='inline-flex';
    // 方案 B：登记 manual job 到 DelegationVM（若不是由 drain 启动）
    if(_sendEmpId && typeof DelegationVM!=='undefined'){
      if(S._manualJobDraining && S._manualJobDraining.empId===_sendEmpId){
        // 由队列 drain 触发的 manual job —— 把已登记的 Job 的 streamId/sessionId 补齐
        const draining=S._manualJobDraining;
        draining.streamId=streamId;
        draining.sessionId=activeSid;
        S._activeManualJobId=draining.id;
        S._manualJobDraining=null;
      } else {
        // 空闲时直接发起的手动消息：生成临时 Job 登记为 running（旁路，不调 startFn）
        const jobId='m_'+Date.now()+'_'+Math.random().toString(36).slice(2,8);
        const job={
          id:jobId, empId:_sendEmpId, kind:'manual',
          streamId, sessionId:activeSid,
          startFn:async()=>{},  // 已启动，占位
          cancelFn:async()=>{
            // 通过后端 cancel_stream 中断
            try{await api(`/api/chat/cancel?stream_id=${encodeURIComponent(streamId)}`,{method:'POST'});}catch(_){}
          },
        };
        try{DelegationVM.registerRunning(job);}catch(_){}
        S._activeManualJobId=jobId;
      }
    }
  }catch(e){
    delete INFLIGHT[activeSid];
    stopApprovalPolling();
    // Only hide approval card if it belongs to the session that just finished
    if(!_approvalSessionId || _approvalSessionId===activeSid) hideApprovalCard(true);hideClarifyCard();removeThinking();
    S.messages.push({role:'assistant',content:`**Error:** ${e.message}`});
    if(_isEmployeeRpMode()){
      try{if(typeof _renderRpMessages==='function') _renderRpMessages();}catch(_){}
    } else { renderMessages(); }
    setBusy(false);setComposerStatus(`Error: ${e.message}`);
    // 更新员工状态为出错（使用发送时记录的ID）
    if(_sendEmpId && typeof setEmployeeStatus==='function'){
      setEmployeeStatus(_sendEmpId,'error');
    }
    return;
  }

  // Open SSE stream and render tokens live
  let assistantText='';
  let assistantRow=null;
  let assistantBody=null;
  // ★ 分离 reasoning 缓冲区，避免 token 被污染进 <think> 块
  let _reasoningBuffer='';
  // Thinking tag patterns for streaming display
  const _thinkPairs=[
    {open:'<think>',close:'</think>'},
    {open:'<|channel>thought\n',close:'<channel|>'}
  ];

  // ★ _isEmployeeRpMode 已提升为全局函数（文件顶部），这里不再需要局部定义
  function ensureAssistantRow(){
    if(assistantRow)return;
    // 总群概念已移除：PM聊天 = PM 员工聊天框，正常渲染
    removeThinking();
    const tr=$('toolRunningRow');if(tr)tr.remove();
    const emp = typeof EMPLOYEE_STORE!=='undefined'?getEmployee(EMPLOYEE_STORE.selectedId):null;
    const avatar = emp?emp.avatar:'🤖';
    const name = emp?emp.name:(window._botName||'Hermes');
    const inner = $('rpMsgInner');
    if(!inner) return;

    if(_isEmployeeRpMode()){
      // ── 员工模式：复用已有的 live turn-row 或新建一个 ──
      let turnRow = $('msgLiveTurnRow');
      if(!turnRow){
        turnRow = document.createElement('div');
        turnRow.className = 'rp-msg-row rp-turn';
        turnRow.id = 'msgLiveTurnRow';
        turnRow.dataset.role = 'assistant';
        const role = document.createElement('div');
        role.className = 'rp-msg-role assistant';
        const iconSpan = document.createElement('span');
        iconSpan.className = 'rp-msg-icon';
        iconSpan.textContent = avatar;
        const lbl = document.createElement('span');
        lbl.className = 'rp-msg-name';
        lbl.textContent = name;
        role.appendChild(iconSpan);
        role.appendChild(lbl);
        turnRow.appendChild(role);
        const segs = document.createElement('div');
        segs.className = 'rp-turn-segments';
        segs.id = 'msgLiveTurnSegments';
        turnRow.appendChild(segs);
        inner.appendChild(turnRow);
      }
      // 当前活动文本段：id=msgLiveStreamBody（被 tool 事件固化后会重建新的）
      const segs = $('msgLiveTurnSegments');
      let body = segs.querySelector('#msgLiveStreamBody');
      if(!body){
        body = document.createElement('div');
        body.className = 'rp-msg-body rp-turn-text';
        body.id = 'msgLiveStreamBody';
        segs.appendChild(body);
      }
      assistantRow = turnRow;
      assistantBody = body;
      return;
    }

    // 非员工模式：保持原逻辑（独立 rp-msg-row）
    assistantRow=document.createElement('div');assistantRow.className='rp-msg-row';
    assistantBody=document.createElement('div');assistantBody.className='rp-msg-body';
    const role=document.createElement('div');role.className='rp-msg-role assistant';
    const iconSpan=document.createElement('span');iconSpan.className='rp-msg-icon';iconSpan.textContent=avatar;
    const lbl=document.createElement('span');lbl.className='rp-msg-name';lbl.textContent=name;
    role.appendChild(iconSpan);role.appendChild(lbl);
    assistantRow.appendChild(role);assistantRow.appendChild(assistantBody);
    inner.appendChild(assistantRow);
  }

  // ── Shared SSE handler wiring (used for initial connection and reconnect) ──
  let _reconnectAttempted=false;

  // ★ OpenClaw 风格：检查当前视图是否仍显示我们这条流的 session
  //   - 用于决定是否刷新 DOM（切换到其他 session 时只缓冲数据不渲染）
  //   - assistantText/_reasoningBuffer 依然累积，切回时 _scheduleRender 会显示全部
  function _isViewingOurSession(){
    return !!(S.session && S.session.session_id===activeSid);
  }

  // 当用户切回本流所属 session 时，立刻补一次完整渲染
  window.addEventListener('hermes:session-switched', (ev)=>{
    try{
      const sid = ev && ev.detail && ev.detail.session_id;
      if(sid === activeSid){
        // 切回了本流的 session —— 清空闭包 DOM 引用（旧的已被销毁），
        // ensureAssistantRow 会重建，_scheduleRender 会用累积的 assistantText 刷新
        assistantRow = null;
        assistantBody = null;
        ensureAssistantRow();
        _scheduleRender();
      }
    }catch(_){}
  });

  // rAF-throttled rendering: buffer tokens, render at most once per frame
  let _renderPending=false;
  // Extract display text from assistantText, stripping ALL thinking blocks
  // (complete or in-progress) and hiding content still inside an open tag.
  function _streamDisplay(){
    let raw=assistantText;
    // Step 1: extract and remove all COMPLETE think blocks anywhere in the text
    for(const {open,close} of _thinkPairs){
      let idx=raw.indexOf(open);
      while(idx!==-1){
        const afterOpen=idx+open.length;
        const closeIdx=raw.indexOf(close,afterOpen);
        if(closeIdx===-1) break; // unclosed — handled below
        raw=raw.slice(0,idx)+raw.slice(closeIdx+close.length);
        idx=raw.indexOf(open);
      }
    }
    // Step 2: if text starts with an unclosed think tag, hide everything
    for(const {open,close} of _thinkPairs){
      const trimmed=raw.trimStart();
      if(trimmed.startsWith(open)){
        const ci=trimmed.indexOf(close,open.length);
        if(ci===-1) return ''; // still inside thinking block
      }
      if(open.startsWith(trimmed)) return ''; // partial tag prefix
    }
    // Step 3: strip any orphaned tags
    return raw.replace(/<\/?think>/gi,'').trim();
  }
  // ★ 从 assistantText + _reasoningBuffer 中提取思考内容与显示文本
  //   返回 {thinking: string, text: string}
  //   reasoning 事件的内容优先进入 _reasoningBuffer，不再污染 assistantText。
  function _extractThinkingAndText(){
    let thinkingParts=[];
    // 1) reasoningBuffer 的内容始终作为 thinking（最高优先级）
    if(_reasoningBuffer.trim()){
      thinkingParts.push(_reasoningBuffer.trim());
    }
    // 2) 从 assistantText 中提取内联 think 块（防御性：模型可能通过 token 输出 think 标签）
    let remaining=assistantText;
    for(const {open,close} of _thinkPairs){
      let idx=remaining.indexOf(open);
      while(idx!==-1){
        const afterOpen=idx+open.length;
        const closeIdx=remaining.indexOf(close,afterOpen);
        if(closeIdx===-1) break;
        thinkingParts.push(remaining.slice(afterOpen,closeIdx).trim());
        remaining=remaining.slice(0,idx)+remaining.slice(closeIdx+close.length);
        idx=remaining.indexOf(open);
      }
    }
    // 3) 未闭合的 think 标签 → 视为进行中
    for(const {open,close} of _thinkPairs){
      const trimmed=remaining.trimStart();
      if(trimmed.startsWith(open)){
        const closeIdx=trimmed.indexOf(close,open.length);
        if(closeIdx===-1){
          thinkingParts.push(trimmed.slice(open.length).trim());
          return {thinking:thinkingParts.join('\n'), text:''};
        }
      }
      if(open.startsWith(trimmed)) return {thinking:thinkingParts.join('\n'), text:''};
    }
    // 4) 清理剩余文本中的孤儿标签
    const cleanedText=remaining.replace(/^\s+/,'').replace(/<\/?think>/gi,'').trim();
    return {thinking:thinkingParts.join('\n'), text:cleanedText};
  }

  let _lastRenderTime=0;

  // ★ AG-UI 精细化状态：thinking/message/step 的开始结束标记
  //   提升为模块级变量，使 _scheduleRender 和 _wireSSE 都能访问
  let _thinkingActive = false;   // thinking_start → true, thinking_end → false
  let _messageActive = false;    // message_start → true, message_end → false
  let _currentStep = '';         // step_started 设置, step_finished 清空

  function _scheduleRender(){
    if(_renderPending) return;
    // Throttle: skip if last render was less than 80ms ago (reduces CPU load
    // during fast token streaming while keeping display responsive)
    const now=Date.now();
    const elapsed=now-_lastRenderTime;
    const MIN_INTERVAL=80;
    const delay=Math.max(0,MIN_INTERVAL-elapsed);
    _renderPending=true;
    setTimeout(()=>{
      // ★ 异常防御：无论中途哪步抛错，下一次 schedule 都要能进来。
      //   现象：bug 报告中"执行一半日志和聊天框不刷新"多半是某次渲染抛异常卡住节流状态。
      try{
        _renderPending=false;
        _lastRenderTime=Date.now();
        // ★ 节流延迟中用户可能切换了 session —— 再次检查视图状态
        if(!_isViewingOurSession()) return;
      if(_isEmployeeRpMode()){
        // ★ 员工模式：在 turn-row segments 内实时显示思考 + 文本
        // 如果 turn-row/segments 不存在（切走又切回，rpMsgInner 被重建），
        // 重新 ensureAssistantRow 创建结构
        if(!$('msgLiveTurnSegments')){
          assistantRow=null;
          assistantBody=null;
          ensureAssistantRow();
        }
        const {thinking,text}=_extractThinkingAndText();
        const segs=$('msgLiveTurnSegments');
        if(!segs) return;
        // 思考段：查找或创建 .rp-live-thinking-card
        let thinkCard=segs.querySelector('.rp-live-thinking-card');
        if(thinking){
          if(!thinkCard){
            thinkCard=document.createElement('div');
            thinkCard.className='rp-turn-thinking thinking-card rp-live-thinking-card open';
            // ★ AG-UI thinking_start/end 控制动画状态
            if(_thinkingActive) thinkCard.classList.add('thinking-active');
            thinkCard.innerHTML='<div class="thinking-card-header" onclick="this.parentElement.classList.toggle(\'open\')"><span class="thinking-card-icon">'+(typeof li==='function'?li('lightbulb',14):'💡')+'</span><span class="thinking-card-label">思考过程</span><span class="thinking-card-toggle">'+(typeof li==='function'?li('chevron-right',12):'▶')+'</span></div><div class="thinking-card-body"></div>';
            // 插到 segments 最前面（在已有文本段之前）
            const firstChild=segs.firstChild;
            if(firstChild) segs.insertBefore(thinkCard,firstChild);
            else segs.appendChild(thinkCard);
          }
          // ★ 根据 _thinkingActive 控制思考卡片动画
          if(_thinkingActive) thinkCard.classList.add('thinking-active');
          else thinkCard.classList.remove('thinking-active');
          const body=thinkCard.querySelector('.thinking-card-body');
          if(body) body.innerHTML=renderMd(thinking);
        }
        // ★ 思考已完成（text 出现）→ 折叠思考卡片（无论 thinking 是否为空）
        if(thinkCard && text){
          thinkCard.classList.remove('open');
        }
        // 文本段
        // ★ _isEmptyLike：某些 provider 在 tool_calls 前返回 content="{}"，
        //   不应渲染为可见文本（否则在工具卡片间显示空大括号）
        const _isEmptyLike = t => !t || /^[\s{}\[\]""]+$/.test(String(t).trim());
        const _stripEmptyLike = t => { const s = String(t).trim(); return /^[\s{}\[\]""]+$/.test(s) ? '' : s; };
        const cleanedText = _stripEmptyLike(text);
        let currentBody=segs.querySelector('#msgLiveStreamBody');
        if(cleanedText && !_isEmptyLike(cleanedText)){
          if(currentBody) currentBody.innerHTML=renderMd(cleanedText);
        } else if((!cleanedText || _isEmptyLike(cleanedText)) && assistantText.length>0 && !thinking){
          // 纯占位（如 open tag 前缀匹配时）
          if(currentBody) currentBody.innerHTML='<span style="color:var(--muted);font-size:13px">Thinking\u2026</span>';
        } else if(!text && thinking){
          // 还在思考中 → 如果活动文本段只显示占位符则隐藏
          if(currentBody && !currentBody.textContent.trim()){
            currentBody.innerHTML='';
          }
        }
      } else {
        // 非员工模式：原逻辑
        // ★ 如果 assistantBody 已经不在文档中（例如 renderMessages 重建了 DOM），
        //   清空闭包引用并重建，确保补渲时能继续显示
        if(assistantBody && !document.body.contains(assistantBody)){
          assistantBody=null;
          assistantRow=null;
          ensureAssistantRow();
        }
        if(assistantBody){
          const txt=_streamDisplay();
          const isThinking=!txt&&assistantText.length>0;
          // ★ AG-UI 步骤状态优先于 "Thinking…" 占位
          const stepLabel=_currentStep==='call_llm'?'🧠 调用模型…':
                          _currentStep==='execute_tool'?'🔧 执行工具…':'';
          assistantBody.innerHTML=txt?renderMd(txt):(isThinking?(stepLabel||'<span style="color:var(--muted);font-size:13px">Thinking\u2026</span>'):'');
        }
      }
      scrollIfPinned();
      }catch(err){
        // 捕获渲染异常，确保下一次 _scheduleRender 能重新进入 (防止卡死不刷新)
        try{ console.error('[_scheduleRender] render error:', err); }catch(_){}
        _renderPending=false;
      }
    },delay);
  }

  function _wireSSE(source){
    let _firstToken = true;
    // ★ 新 SSE 流启动时，重置 AG-UI 状态（防止残留上一流的状态）
    _thinkingActive = false;
    _messageActive = false;
    _currentStep = '';
    // ★ 看门狗：每 500ms 检查一次 assistantText 长度是否比上次渲染时的多，
    //   如果多了但 DOM 没被渲染（render 被异常卡住、或节流状态错乱），强制调度一次。
    //   这是防御性自愈：即使某条 SSE handler 挂了导致 _scheduleRender 没被调，
    //   watchdog 也能把"已到后端但未显示"的内容推上 UI。
    let _lastSeenTextLen = 0;
    const _watchdog = setInterval(()=>{
      try{
        if((assistantText && assistantText.length > _lastSeenTextLen)
           || (_reasoningBuffer && _reasoningBuffer.length > _lastSeenTextLen)){
          _lastSeenTextLen = Math.max(
            (assistantText||'').length,
            (_reasoningBuffer||'').length
          );
          if(_isViewingOurSession()){
            // 强制重置 pending 状态，确保下一次能进入
            if(typeof _renderPending !== 'undefined') _renderPending = false;
            try{ ensureAssistantRow(); }catch(_){}
            _scheduleRender();
          }
        }
      }catch(_){}
    }, 500);
    // 挂到 source 上以便 done/error 时清理
    source._watchdog = _watchdog;
    source.addEventListener('token',e=>{
      try{
        // ★ 不再因 session 切换而丢弃 token —— 始终累积到 assistantText。
        //   用户切回此 session 时 hermes:session-switched 会触发补渲。
        // ★ 过滤空外观 token：某些 provider/模型在 tool_calls 前发送 "{}" 作为 content，
        //   不应累积到 assistantText，否则会在工具卡片间渲染出空大括号
        const _isEmptyLikeToken = t => !t || /^[\s{}\[\]""]+$/.test(String(t).trim());
        const d=JSON.parse(e.data);
        if(_isEmptyLikeToken(d && d.text)) return;
        assistantText+=(d && d.text) || '';
        // 第一个 token 时更新员工状态为工作中
        if(_firstToken&&typeof EMPLOYEE_STORE!=='undefined'&&EMPLOYEE_STORE.selectedId&&typeof setEmployeeStatus==='function'){
          setEmployeeStatus(EMPLOYEE_STORE.selectedId,'working');
          _firstToken = false;
        }
        // 只有当前视图仍在显示本流所属 session 时才更新 DOM
        if(_isViewingOurSession()){
          ensureAssistantRow();
          _scheduleRender();
        }
      }catch(err){
        try{ console.error('[SSE token handler] error:', err, 'data=', e && e.data && e.data.slice && e.data.slice(0,200)); }catch(_){}
      }
    });

    // ★ 原生 reasoning 内容（Claude 3.7, DeepSeek 等）实时显示
    //   后端 reasoning_callback 推送增量内容，直接累加到独立的 _reasoningBuffer，
    //   绝不污染 assistantText。token 与 reasoning 完全隔离。
    source.addEventListener('reasoning',e=>{
      try{
        const d=JSON.parse(e.data);
        const text=d.text||'';
        if(!text) return;
        _reasoningBuffer += text;
        if(_isViewingOurSession()){
          ensureAssistantRow();
          _scheduleRender();
        }
      }catch(_){}
    });

    // ── AG-UI 精细化事件（Knot 等协议的 Start/End/Step 事件）──────────────
    // TextMessageStart / TextMessageEnd：标记文本消息的开始和结束
    source.addEventListener('message_start',e=>{
      try{
        const d=JSON.parse(e.data);
        _messageActive = true;
        // 文本消息开始：可在此初始化状态或显示"正在回复…"占位
        if(_isViewingOurSession()){
          ensureAssistantRow();
          _scheduleRender();
        }
      }catch(_){}
    });
    source.addEventListener('message_end',e=>{
      try{
        const d=JSON.parse(e.data);
        _messageActive = false;
        // 文本消息结束：固化当前文本段，停止"正在回复…"状态
        if(_isViewingOurSession()){
          _scheduleRender();
        }
      }catch(_){}
    });

    // ThinkingTextMessageStart / ThinkingTextMessageEnd：标记思考过程
    source.addEventListener('thinking_start',e=>{
      try{
        const d=JSON.parse(e.data);
        _thinkingActive = true;
        // 思考开始：显示思考中卡片（展开状态 + 动画）
        if(_isViewingOurSession()){
          ensureAssistantRow();
          // 如果在员工模式，更新思考卡片状态
          if(_isEmployeeRpMode()){
            const segs=$('msgLiveTurnSegments');
            if(segs){
              const thinkCard=segs.querySelector('.rp-live-thinking-card');
              if(thinkCard) thinkCard.classList.add('thinking-active');
            }
          }
          _scheduleRender();
        }
      }catch(_){}
    });
    source.addEventListener('thinking_end',e=>{
      try{
        const d=JSON.parse(e.data);
        _thinkingActive = false;
        // 思考结束：折叠思考卡片，停止动画
        if(_isViewingOurSession()){
          if(_isEmployeeRpMode()){
            const segs=$('msgLiveTurnSegments');
            if(segs){
              const thinkCard=segs.querySelector('.rp-live-thinking-card');
              if(thinkCard){
                thinkCard.classList.remove('thinking-active');
                thinkCard.classList.remove('open');
              }
            }
          }
          _scheduleRender();
        }
      }catch(_){}
    });

    // ToolCallArgs / ToolCallEnd / ToolCallResult：工具调用增量参数和结果
    source.addEventListener('tool_args',e=>{
      try{
        const d=JSON.parse(e.data);
        // 增量工具参数：更新最后一个未完成工具卡片的参数显示
        if(!_isViewingOurSession()) return;
        const lastTool = S.toolCalls[S.toolCalls.length - 1];
        if(lastTool && !lastTool.done){
          if(d.args_delta) lastTool.argsRaw = (lastTool.argsRaw||'') + d.args_delta;
          _scheduleRender();
        }
      }catch(_){}
    });
    source.addEventListener('tool_end',e=>{
      try{
        const d=JSON.parse(e.data);
        // 工具调用完成：更新工具卡片为完成状态
        const lastTool = S.toolCalls[S.toolCalls.length - 1];
        if(lastTool && !lastTool.done){
          lastTool.done = true;
          if(d.name) lastTool.name = d.name;
        }
      }catch(_){}
    });
    source.addEventListener('tool_result',e=>{
      try{
        const d=JSON.parse(e.data);
        // 工具返回结果：可在此显示结果摘要
        if(!_isViewingOurSession()) return;
        const lastTool = S.toolCalls[S.toolCalls.length - 1];
        if(lastTool){
          lastTool.done = true;
          lastTool.result = d.result || '';
          if(typeof _scheduleRender==='function') _scheduleRender();
        }
      }catch(_){}
    });

    // StepStarted / StepFinished：Agent 执行步骤生命周期
    //   step_name: "call_llm" | "execute_tool"
    //   StepFinished 包含 token_usage
    source.addEventListener('step_started',e=>{
      try{
        const d=JSON.parse(e.data);
        const stepName = d.step_name || '';
        _currentStep = stepName;
        if(_isViewingOurSession()){
          // 在状态栏显示当前步骤
          const stepLabel = stepName === 'call_llm' ? '🧠 调用模型' :
                            stepName === 'execute_tool' ? '🔧 执行工具' : stepName;
          setComposerStatus(stepLabel);
          // ★ 员工模式：在活动文本段显示步骤状态
          if(_isEmployeeRpMode()){
            const liveBody=$('msgLiveStreamBody');
            if(liveBody && !liveBody.textContent.trim()){
              liveBody.innerHTML='<span style="color:var(--muted);font-size:13px">'+stepLabel+'…</span>';
            }
          }
        }
      }catch(_){}
    });
    source.addEventListener('step_finished',e=>{
      try{
        const d=JSON.parse(e.data);
        const stepName = d.step_name || '';
        _currentStep = '';
        // 如果有 token_usage，更新用量显示
        if(d.token_usage && _isViewingOurSession()){
          const tu = d.token_usage;
          // 缓存逐步的 token 用量，done 事件时合并
          if(!S._stepTokenUsage) S._stepTokenUsage = {prompt_tokens:0,completion_tokens:0,total_tokens:0};
          S._stepTokenUsage.prompt_tokens += (tu.prompt_tokens || 0);
          S._stepTokenUsage.completion_tokens += (tu.completion_tokens || 0);
          S._stepTokenUsage.total_tokens += (tu.total_tokens || 0);
          // 实时显示 token 用量指示器
          if(typeof _syncCtxIndicator==='function'){
            _syncCtxIndicator({
              input_tokens: S._stepTokenUsage.prompt_tokens,
              output_tokens: S._stepTokenUsage.completion_tokens,
            });
          }
        }
        setComposerStatus('');
      }catch(_){}
    });

    source.addEventListener('tool',e=>{
      try{
      const d=JSON.parse(e.data);
      // 始终处理 tool 事件（记录到 S.toolCalls），但 DOM 更新仅在当前视图时
      const tc={name:d.name, preview:d.preview||'', args:d.args||{}, snippet:'', done:false};
      S.toolCalls.push(tc);
      if(!_isViewingOurSession()){
        // 只累积不渲染 —— assistantText 会在切回时由补渲逻辑显示
        assistantText='';
        _reasoningBuffer='';
        return;
      }
      removeThinking();
      const oldRow=$('toolRunningRow');if(oldRow)oldRow.remove();

      if(_isEmployeeRpMode()){
        // ★ 员工模式：工具卡片放入当前 turn-row 的 segments 中，
        //   同时固化当前思考段+文本段，然后新建下一个活动文本段。
        ensureAssistantRow();
        const segs = $('msgLiveTurnSegments');
        if(segs){
          // 步骤 0：固化思考段（去掉 live 标记，折叠）
          const thinkCard=segs.querySelector('.rp-live-thinking-card');
          if(thinkCard){
            thinkCard.classList.remove('open','rp-live-thinking-card');
          }
          // 步骤 1：固化当前文本段
          const currentBody = segs.querySelector('#msgLiveStreamBody');
          if(currentBody){
            const {text:rawFinalText}=_extractThinkingAndText();
            // ★ _isEmptyLike：某些 provider 在 tool_calls 前返回 content="{}"，
            //   不应渲染为可见文本（否则在工具卡片间显示空大括号）
            const _isEmptyLike = t => !t || /^[\s{}\[\]""]+$/.test(String(t).trim());
            const _stripEmptyLike = t => { const s = String(t).trim(); return /^[\s{}\[\]""]+$/.test(s) ? '' : s; };
            const finalText = _stripEmptyLike(rawFinalText);
            if(finalText && !_isEmptyLike(finalText)){
              currentBody.innerHTML = renderMd(finalText);
              currentBody.removeAttribute('id');
            } else {
              currentBody.remove();
            }
          }
          // 步骤 2：把工具卡片追加到 segments
          if(typeof buildToolCard==='function'){
            const cardRow = buildToolCard(tc);
            cardRow.classList.add('rp-turn-tool','rp-live-tool-card');
            if(tc.tid) cardRow.dataset.tid = tc.tid;
            segs.appendChild(cardRow);
          }
          // 步骤 3：新建下一个活动文本段（占位 Thinking）
          assistantText='';
          _reasoningBuffer='';
          const newBody = document.createElement('div');
          newBody.className = 'rp-msg-body rp-turn-text';
          newBody.id = 'msgLiveStreamBody';
          newBody.innerHTML = '<span style="color:var(--muted);font-size:13px">Thinking\u2026</span>';
          segs.appendChild(newBody);
          assistantBody = newBody;
        }
        scrollIfPinned();
        return;
      }

      // 非员工模式：工具卡片进入独立的 liveToolCards 容器（主聊天等场景）
      appendLiveToolCard(tc);
      scrollIfPinned();
      }catch(err){
        try{ console.error('[SSE tool handler] error:', err); }catch(_){}
      }
    });

    source.addEventListener('approval',e=>{
      const d=JSON.parse(e.data);
      d._session_id=activeSid;
      showApprovalCard(d);
      playNotificationSound();
      sendBrowserNotification('Approval required',d.description||'Tool approval needed');
    });

    source.addEventListener('clarify',e=>{
      const d=JSON.parse(e.data);
      showClarifyCard(d);
      playNotificationSound();
      sendBrowserNotification('Question',d.question||'Agent is asking a question');
    });

    // ★ P0/P1/P2: 浏览器操作步骤流 + 截图镜像
    source.addEventListener('browser_step',e=>{
      try {
        const d = JSON.parse(e.data);
        if (typeof handleBrowserStep === 'function') handleBrowserStep(d);
      } catch(err) { console.warn('browser_step parse err:', err); }
    });

    // ★ P3: "下一步"暂停机制
    source.addEventListener('user_continue_required',e=>{
      try {
        const d = JSON.parse(e.data);
        if (typeof showContinueCard === 'function') showContinueCard(d);
      } catch(err) { console.warn('user_continue_required parse err:', err); }
    });

    // ★ 2026-04-27: delegate_task 路径的 child agent 事件
    //   让员工聊天框能实时看到"制作人派的任务 + child 的思考过程 + 工具调用 + 最终 summary"
    source.addEventListener('delegation_started',e=>{
      try { if (typeof handleDelegationStarted==='function') handleDelegationStarted(JSON.parse(e.data)); }
      catch(err){ console.warn('delegation_started err:', err); }
    });
    source.addEventListener('delegation_token',e=>{
      try { if (typeof handleDelegationToken==='function') handleDelegationToken(JSON.parse(e.data)); }
      catch(err){ console.warn('delegation_token err:', err); }
    });
    source.addEventListener('delegation_reasoning',e=>{
      try { if (typeof handleDelegationReasoning==='function') handleDelegationReasoning(JSON.parse(e.data)); }
      catch(err){ console.warn('delegation_reasoning err:', err); }
    });
    source.addEventListener('delegation_tool',e=>{
      try { if (typeof handleDelegationTool==='function') handleDelegationTool(JSON.parse(e.data)); }
      catch(err){ console.warn('delegation_tool err:', err); }
    });
    source.addEventListener('delegation_tool_done',e=>{
      try { if (typeof handleDelegationToolDone==='function') handleDelegationToolDone(JSON.parse(e.data)); }
      catch(err){ console.warn('delegation_tool_done err:', err); }
    });
    source.addEventListener('delegation_completed',e=>{
      try { if (typeof handleDelegationCompleted==='function') handleDelegationCompleted(JSON.parse(e.data)); }
      catch(err){ console.warn('delegation_completed err:', err); }
    });

    source.addEventListener('done',e=>{
      source.close(); if(source._watchdog){ clearInterval(source._watchdog); source._watchdog=null; }
      // ★ reasoning 与 token 已分离，无需再向 assistantText 追加 </think>
      //   _reasoningBuffer 会在 finalize 后自然丢弃
      const d=JSON.parse(e.data);
      delete INFLIGHT[activeSid];
      clearInflight();
      stopApprovalPolling();
      if(!_approvalSessionId || _approvalSessionId===activeSid) hideApprovalCard(true);
      hideClarifyCard();
      if(S.session&&S.session.session_id===activeSid){
        S.activeStreamId=null;
        const _cb=$('btnCancel');if(_cb)_cb.style.display='none';
      }
      if(S.session&&S.session.session_id===activeSid){
        S.session=d.session;S.messages=d.session.messages||[];
        // Stamp _ts on the last assistant message if it has no timestamp
        const lastAsst=[...S.messages].reverse().find(m=>m.role==='assistant');
        if(lastAsst&&!lastAsst._ts&&!lastAsst.timestamp) lastAsst._ts=Date.now()/1000;
        if(d.usage){S.lastUsage=d.usage;_syncCtxIndicator(d.usage);}
        // 更新当前选中员工的 tokenUsage
        if(d.usage && typeof EMPLOYEE_STORE!=='undefined' && EMPLOYEE_STORE.selectedId && typeof getEmployee==='function'){
          const _emp=getEmployee(EMPLOYEE_STORE.selectedId);
          if(_emp){
            _emp.tokenUsage={
              input_tokens:((_emp.tokenUsage&&_emp.tokenUsage.input_tokens)||0)+(d.usage.input_tokens||0),
              output_tokens:((_emp.tokenUsage&&_emp.tokenUsage.output_tokens)||0)+(d.usage.output_tokens||0),
            };
            // 同步 session 的 model 到员工
            if(S.session&&S.session.model) _emp.model=S.session.model;
            if(typeof _saveEmployees==='function') _saveEmployees();
            if(typeof _updateCardTokenUsage==='function') _updateCardTokenUsage(_emp);
          }
        }
        if(d.session.tool_calls&&d.session.tool_calls.length){
          S.toolCalls=d.session.tool_calls.map(tc=>({...tc,done:true}));
        } else {
          S.toolCalls=S.toolCalls.map(tc=>({...tc,done:true}));
        }
        if(uploaded.length){
          const lastUser=[...S.messages].reverse().find(m=>m.role==='user');
          if(lastUser)lastUser.attachments=uploaded;
        }
        clearLiveToolCards();
        S.busy=false;
        // ★ 员工模式：不重建整个右面板 DOM（避免清空再重建的闪烁/看起来"被清空"的问题）
        //   只 finalize 当前 live turn-row 的思考段+活动文本段。
        if(_isEmployeeRpMode()){
          syncTopbar();
          const segs=$('msgLiveTurnSegments');
          // 固化思考段
          if(segs){
            const thinkCard=segs.querySelector('.rp-live-thinking-card');
            if(thinkCard) thinkCard.classList.remove('open','rp-live-thinking-card');
          }
          // 固化活动文本段
          const liveBody = $('msgLiveStreamBody');
          if(liveBody){
            // ★ _isEmptyLike：某些 provider 在 tool_calls 前返回 content="{}"，
            //   不应渲染为可见文本
            const _isEmptyLike = t => !t || /^[\s{}\[\]""]+$/.test(String(t).trim());
            const _stripEmptyLike = t => { const s = String(t).trim(); return /^[\s{}\[\]""]+$/.test(s) ? '' : s; };
            const {thinking:finalThinking,text:rawFinalText}=_extractThinkingAndText();
            const finalText = _stripEmptyLike(rawFinalText);
            if(finalText && !_isEmptyLike(finalText)){
              liveBody.innerHTML = renderMd(finalText);
              liveBody.removeAttribute('id');
            } else if(finalThinking && finalThinking.trim()){
              // 只有 thinking 没有外部文本 → 显示 thinking 内容
              liveBody.innerHTML = renderMd(finalThinking);
              liveBody.removeAttribute('id');
            } else {
              liveBody.remove();
              if(segs && !segs.children.length){
                const ph = document.createElement('div');
                ph.className = 'rp-msg-body rp-turn-text';
                ph.innerHTML = '<span style="color:var(--muted)">（无回复）</span>';
                segs.appendChild(ph);
              }
            }
          }
          // 移除临时 id，让后续新回合不会复用本 turn-row
          const liveTurn = $('msgLiveTurnRow');
          if(liveTurn){
            liveTurn.removeAttribute('id');
            const innerSegs = liveTurn.querySelector('#msgLiveTurnSegments');
            if(innerSegs) innerSegs.removeAttribute('id');
            const lastAsstIdx = S.messages.map((m,i)=>({m,i})).reverse().find(x=>x.m && x.m.role==='assistant');
            if(lastAsstIdx) liveTurn.dataset.msgIdx = lastAsstIdx.i;
          }
          // 语法高亮
          const inner = $('rpMsgInner');
          if(inner){
            requestAnimationFrame(()=>{
              if(typeof highlightCode==='function') highlightCode(inner);
              if(typeof addCopyButtons==='function') addCopyButtons(inner);
            });
          }
          loadDir('.');
          // ★ 重新合并该员工的委派任务历史消息（S.messages 被 d.session.messages 覆盖后会丢失合并内容）
          if(typeof _loadAllDelegatedTaskMessages==='function' && typeof getEmployee==='function' && _sendEmpId){
            const _remergeEmp=getEmployee(_sendEmpId);
            if(_remergeEmp){
              _loadAllDelegatedTaskMessages(_remergeEmp).then(()=>{
                if(typeof _renderRpMessages==='function') _renderRpMessages();
              }).catch(()=>{});
            }
          }
        } else {
          syncTopbar();renderMessages();loadDir('.');
        }
      }
      renderSessionList();setBusy(false);setStatus('');
      setComposerStatus('');
      // 更新员工状态为空闲（使用发送时记录的ID，而非当前selectedId）
      if(_sendEmpId && typeof setEmployeeStatus==='function'){
        setEmployeeStatus(_sendEmpId,'idle');
      }
      playNotificationSound();
      sendBrowserNotification('Response complete',assistantText?assistantText.slice(0,100):'Task finished');
    });

    source.addEventListener('employee_created',e=>{
      // Agent called delegate_task with employee_name — auto-create
      // employee card + connection line on the canvas.
      if(!S.session||S.session.session_id!==activeSid) return;
      try{
        const d=JSON.parse(e.data);
        const empName=d.name;
        if(!empName) return;
        // Check if employee already exists on canvas
        const existing=typeof EMPLOYEE_STORE!=='undefined'&&
          EMPLOYEE_STORE.employees.find(emp=>emp.name===empName);
        if(existing) return;
        if(typeof createEmployee==='function'){
          // Try to match a preset by name first
          let presetMatch=null;
          if(typeof AGENT_PRESETS!=='undefined'){
            presetMatch=AGENT_PRESETS.find(p=>p.name===empName);
          }
          const empOpts={
            name:empName,
            role:d.role||'',
            subagentOf:_sendEmpId||null,
          };
          if(presetMatch){
            empOpts.presetId=presetMatch.id;
            empOpts.characterImg=presetMatch.characterImg;
            empOpts.model=presetMatch.model;
            empOpts.skills=presetMatch.skills;
            empOpts.role=presetMatch.role;
            if(presetMatch.configHtml) empOpts.configHtml=presetMatch.configHtml;
          }
          const emp=createEmployee(empOpts);
          // Create connection line from sender to new employee
          if(_sendEmpId&&typeof addConnection==='function'){
            addConnection(_sendEmpId,emp.id);
          }
          showToast(presetMatch
            ?`已创建员工: ${empName}（${presetMatch.role}）`
            :`已创建员工: ${empName}`);
        }
      }catch(err){
        console.warn('[employee_created] Failed:',err);
      }
    });

    source.addEventListener('team_created',e=>{
      // Agent returned a structured team definition via team_structure
      // parameter — batch-create employee cards with connections.
      if(!S.session||S.session.session_id!==activeSid) return;
      try{
        const d=JSON.parse(e.data);
        if(typeof createTeamFromJSON==='function'){
          createTeamFromJSON(d);
        }
      }catch(err){
        console.warn('[team_created] Failed:',err);
      }
    });

    source.addEventListener('employee_session_bound',e=>{
      // delegate_task completed — bind child_session_id to the
      // corresponding employee card so clicking it opens the right session.
      //
      // ★ 2026-04-27 修复：原实现在 batch 委派 4 个任务时，4 次事件会连续把
      //   emp.sessionId 覆盖 4 遍，最后只保留最后一个 child_session_id，
      //   之前员工"主 session"（openEmployeeChat 时创建）被彻底丢失。
      //   现在改为：
      //     1) 仅在员工完全没有 sessionId 时，才把 child_session_id 设为主 sessionId
      //        （向后兼容老行为——首次打开员工就看到最近一个委派的 session）
      //     2) 所有 child_session_id 都通过 DelegationVM 登记为 Task，
      //        这样 _loadAllDelegatedTaskMessages 能加载每个任务的完整历史消息
      try{
        const d=JSON.parse(e.data);
        if(!d.name||!d.child_session_id) return;
        if(typeof EMPLOYEE_STORE==='undefined') return;
        const emp=EMPLOYEE_STORE.employees.find(x=>x.name===d.name);
        if(emp){
          // 仅在员工还没 sessionId 时绑定主 session（向后兼容）
          if(!emp.sessionId){
            emp.sessionId=d.child_session_id;
            if(typeof _saveEmployees==='function') _saveEmployees();
          }
          // ★ 关键：把 child_session_id 登记到 DelegationVM（若尚未登记）
          //   这样无论是打开员工聊天时的历史加载，还是刷新后恢复，都能拿到
          if(typeof DelegationVM!=='undefined'){
            const taskId=d.child_session_id;
            let t=DelegationVM.getTask(taskId);
            if(!t && DelegationVM.createTask){
              t=DelegationVM.createTask({
                taskId,
                emp,
                taskContent:'（制作人委派任务）',
                workspace:(S.session && S.session.workspace) || '',
                requesterName:'制作人',
              });
            }
            if(t){
              t.sessionId=d.child_session_id;
              // 若 delegation_completed 已把状态设为 done/error，保持之；否则 done
              if(!t.status || t.status==='pending' || t.status==='running'){
                t.status='done';
              }
              if(DelegationVM._persistTask) DelegationVM._persistTask(t);
            }
          }
        }
      }catch(err){
        console.warn('[employee_session_bound] Failed:',err);
      }
    });

    source.addEventListener('compressed',e=>{
      // Context was auto-compressed during this turn -- show a system message
      if(!S.session||S.session.session_id!==activeSid) return;
      try{
        const d=JSON.parse(e.data);
        const sysMsg={role:'assistant',content:'*[Context was auto-compressed to continue the conversation]*'};
        S.messages.push(sysMsg);
        showToast(d.message||'Context compressed');
      }catch(err){}
    });

    source.addEventListener('apperror',e=>{
      // Application-level error sent explicitly by the server (rate limit, crash, etc.)
      // This is distinct from the SSE network 'error' event below.
      source.close(); if(source._watchdog){ clearInterval(source._watchdog); source._watchdog=null; }
      delete INFLIGHT[activeSid];clearInflight();stopApprovalPolling();
      if(!_approvalSessionId||_approvalSessionId===activeSid) hideApprovalCard(true);
      hideClarifyCard();
      if(S.session&&S.session.session_id===activeSid){
        S.activeStreamId=null;const _cbe=$('btnCancel');if(_cbe)_cbe.style.display='none';
        clearLiveToolCards();if(!assistantText)removeThinking();
        try{
          const d=JSON.parse(e.data);
          const isRateLimit=d.type==='rate_limit';
          const isAuthMismatch=d.type==='auth_mismatch';
          const label=isRateLimit?'Rate limit reached':isAuthMismatch?(typeof t==='function'?t('provider_mismatch_label'):'Provider mismatch'):'Error';
          const hint=d.hint?`\n\n*${d.hint}*`:'';
          S.messages.push({role:'assistant',content:`**${label}:** ${d.message}${hint}`});
        }catch(_){
          S.messages.push({role:'assistant',content:'**Error:** An error occurred. Check server logs.'});
        }
        if(_isEmployeeRpMode()){
          try{if(typeof _renderRpMessages==='function') _renderRpMessages();}catch(_){}
        } else { renderMessages(); }
      }else if(typeof trackBackgroundError==='function'){
        const _errTitle=(typeof _allSessions!=='undefined'&&_allSessions.find(s=>s.session_id===activeSid)||{}).title||null;
        try{const d=JSON.parse(e.data);trackBackgroundError(activeSid,_errTitle,d.message||'Error');}
        catch(_){trackBackgroundError(activeSid,_errTitle,'Error');}
      }
      if(!S.session||!INFLIGHT[S.session.session_id]){setBusy(false);setComposerStatus('');}
      // 更新员工状态为出错
      if(_sendEmpId && typeof setEmployeeStatus==='function'){
        setEmployeeStatus(_sendEmpId,'error');
      }
    });

    source.addEventListener('warning',e=>{
      // Non-fatal warning from server (e.g. fallback activated, retrying)
      if(!S.session||S.session.session_id!==activeSid) return;
      try{
        const d=JSON.parse(e.data);
        // Show as a small inline notice, not a full error
        setComposerStatus(`${d.message||'Warning'}`);
        // If it's a fallback notice, show it briefly then clear
        if(d.type==='fallback') setTimeout(()=>setComposerStatus(''),4000);
      }catch(_){}
    });

    source.addEventListener('error',e=>{
      source.close(); if(source._watchdog){ clearInterval(source._watchdog); source._watchdog=null; }
      // Attempt one reconnect if the stream is still active server-side
      if(!_reconnectAttempted && streamId){
        _reconnectAttempted=true;
        setComposerStatus('Reconnecting…');
        setTimeout(async()=>{
          try{
            const st=await api(`/api/chat/stream/status?stream_id=${encodeURIComponent(streamId)}`);
            if(st.active){
              setComposerStatus('Reconnected');
              _wireSSE(new EventSource(new URL(`/api/chat/stream?stream_id=${encodeURIComponent(streamId)}`,location.origin).href,{withCredentials:true}));
              return;
            }
          }catch(_){}
          _handleStreamError();
        },1500);
        return;
      }
      _handleStreamError();
    });

    source.addEventListener('cancel',e=>{
      source.close(); if(source._watchdog){ clearInterval(source._watchdog); source._watchdog=null; }
      delete INFLIGHT[activeSid];clearInflight();stopApprovalPolling();
      if(!_approvalSessionId||_approvalSessionId===activeSid) hideApprovalCard(true);
      hideClarifyCard();
      if(S.session&&S.session.session_id===activeSid){
        S.activeStreamId=null;const _cbc=$('btnCancel');if(_cbc)_cbc.style.display='none';
      }
      if(S.session&&S.session.session_id===activeSid){
        clearLiveToolCards();if(!assistantText)removeThinking();
        S.messages.push({role:'assistant',content:'*Task cancelled.*'});
        if(_isEmployeeRpMode()){
          try{if(typeof _renderRpMessages==='function') _renderRpMessages();}catch(_){}
        } else { renderMessages(); }
      }
      renderSessionList();
      if(!S.session||!INFLIGHT[S.session.session_id]){setBusy(false);setComposerStatus('');}
      // 更新员工状态为空闲
      if(_sendEmpId && typeof setEmployeeStatus==='function'){
        setEmployeeStatus(_sendEmpId,'idle');
      }
    });
  }

  function _handleStreamError(){
    delete INFLIGHT[activeSid];clearInflight();stopApprovalPolling();
    if(!_approvalSessionId||_approvalSessionId===activeSid) hideApprovalCard(true);
    hideClarifyCard();
    if(S.session&&S.session.session_id===activeSid){
      S.activeStreamId=null;const _cbe=$('btnCancel');if(_cbe)_cbe.style.display='none';
      clearLiveToolCards();if(!assistantText)removeThinking();
      S.messages.push({role:'assistant',content:'**Error:** Connection lost'});
      if(_isEmployeeRpMode()){
        try{if(typeof _renderRpMessages==='function') _renderRpMessages();}catch(_){}
      } else { renderMessages(); }
    }else{
      // User switched away — show background error banner
      if(typeof trackBackgroundError==='function'){
        // Look up session title from the session list cache so the banner names it correctly
        const _errTitle=(typeof _allSessions!=='undefined'&&_allSessions.find(s=>s.session_id===activeSid)||{}).title||null;
        trackBackgroundError(activeSid,_errTitle,'Connection lost');
      }
    }
    if(!S.session||!INFLIGHT[S.session.session_id]){setBusy(false);setComposerStatus('');}
    // 更新员工状态为出错
    if(_sendEmpId && typeof setEmployeeStatus==='function'){
      setEmployeeStatus(_sendEmpId,'error');
    }
  }

  _wireSSE(new EventSource(new URL(`/api/chat/stream?stream_id=${encodeURIComponent(streamId)}`,location.origin).href,{withCredentials:true}));

}

function transcript(){
  const lines=[`# Hermes session ${S.session?.session_id||''}`,``,
    `Workspace: ${S.session?.workspace||''}`,`Model: ${S.session?.model||''}`,``];
  for(const m of S.messages){
    if(!m||m.role==='tool')continue;
    let c=m.content||'';
    if(Array.isArray(c))c=c.filter(p=>p&&p.type==='text').map(p=>p.text||'').join('\n');
    const ct=String(c).trim();
    if(!ct&&!m.attachments?.length)continue;
    const attach=m.attachments?.length?`\n\n_Files: ${m.attachments.join(', ')}_`:'';
    lines.push(`## ${m.role}`,'',ct+attach,'');
  }
  return lines.join('\n');
}

function autoResize(){const el=$('msg');el.style.height='auto';el.style.height=Math.min(el.scrollHeight,200)+'px';updateSendBtn();}


// ── Approval polling ──
let _approvalPollTimer = null;
let _approvalHideTimer = null;
let _approvalVisibleSince = 0;
let _approvalSignature = '';
const APPROVAL_MIN_VISIBLE_MS = 30000;

// showApprovalCard moved above respondApproval

function _clearApprovalHideTimer() {
  if (_approvalHideTimer) {
    clearTimeout(_approvalHideTimer);
    _approvalHideTimer = null;
  }
}

function _resetApprovalCardState() {
  _clearApprovalHideTimer();
  _approvalVisibleSince = 0;
  _approvalSignature = '';
}

function hideApprovalCard(force=false) {
  const card = $("approvalCard");
  if (!card) return;
  if (!force && _approvalVisibleSince) {
    const remaining = APPROVAL_MIN_VISIBLE_MS - (Date.now() - _approvalVisibleSince);
    if (remaining > 0) {
      const scheduledSignature = _approvalSignature;
      _clearApprovalHideTimer();
      _approvalHideTimer = setTimeout(() => {
        _approvalHideTimer = null;
        if (_approvalSignature !== scheduledSignature) return;
        hideApprovalCard(true);
      }, remaining);
      return;
    }
  }
  _approvalSessionId = null;
  _resetApprovalCardState();
  card.classList.remove("visible");
  $("approvalCmd").textContent = "";
  $("approvalDesc").textContent = "";
}

// Track session_id of the active approval so respond goes to the right session
let _approvalSessionId = null;

function showApprovalCard(pending) {
  const keys = pending.pattern_keys || (pending.pattern_key ? [pending.pattern_key] : []);
  const desc = (pending.description || "") + (keys.length ? " [" + keys.join(", ") + "]" : "");
  const cmd = pending.command || "";
  const sig = JSON.stringify({desc, cmd, sid: pending._session_id || (S.session && S.session.session_id) || null});
  const card = $("approvalCard");
  const sameApproval = card.classList.contains("visible") && _approvalSignature === sig;
  $("approvalDesc").textContent = desc;
  $("approvalCmd").textContent = cmd;
  _approvalSessionId = pending._session_id || (S.session && S.session.session_id) || null;
  _approvalSignature = sig;
  if (!sameApproval) {
    _approvalVisibleSince = Date.now();
    _clearApprovalHideTimer();
  }
  // Re-enable buttons in case a previous approval disabled them
  ["approvalBtnOnce","approvalBtnSession","approvalBtnAlways","approvalBtnDeny"].forEach(id => {
    const b = $(id); if (b) { b.disabled = false; b.classList.remove("loading"); }
  });
  card.classList.add("visible");
  if (!sameApproval) card.scrollIntoView({block:"nearest", behavior:"smooth"});
  // Apply current locale to data-i18n elements inside the card
  if (typeof applyLocaleToDOM === "function") applyLocaleToDOM();
  // Focus Allow once button so Enter works immediately
  const onceBtn = $("approvalBtnOnce");
  if (onceBtn) setTimeout(() => onceBtn.focus(), 50);
}

async function respondApproval(choice) {
  const sid = _approvalSessionId || (S.session && S.session.session_id);
  if (!sid) return;
  // Disable all buttons immediately to prevent double-submit
  ["approvalBtnOnce","approvalBtnSession","approvalBtnAlways","approvalBtnDeny"].forEach(id => {
    const b = $(id);
    if (b) { b.disabled = true; if (b.id === "approvalBtn" + choice.charAt(0).toUpperCase() + choice.slice(1)) b.classList.add("loading"); }
  });
  _approvalSessionId = null;
  hideApprovalCard(true);
  try {
    await api("/api/approval/respond", {
      method: "POST",
      body: JSON.stringify({ session_id: sid, choice })
    });
  } catch(e) { setStatus(t("approval_responding") + " " + e.message); }
}

function startApprovalPolling(sid) {
  stopApprovalPolling();
  _approvalPollTimer = setInterval(async () => {
    if (!S.busy || !S.session || S.session.session_id !== sid) {
      stopApprovalPolling(); hideApprovalCard(true); return;
    }
    try {
      const data = await api("/api/approval/pending?session_id=" + encodeURIComponent(sid));
      if (data.pending) { data.pending._session_id=sid; showApprovalCard(data.pending); }
      else { hideApprovalCard(); }
    } catch(e) { /* ignore poll errors */ }
  }, 1500);
}

function stopApprovalPolling() {
  if (_approvalPollTimer) { clearInterval(_approvalPollTimer); _approvalPollTimer = null; }
}

// ── Notifications and Sound ──────────────────────────────────────────────────

function playNotificationSound(){
  if(!window._soundEnabled) return;
  try{
    const ctx=new (window.AudioContext||window.webkitAudioContext)();
    const osc=ctx.createOscillator();
    const gain=ctx.createGain();
    osc.connect(gain);gain.connect(ctx.destination);
    osc.type='sine';osc.frequency.setValueAtTime(660,ctx.currentTime);
    osc.frequency.setValueAtTime(880,ctx.currentTime+0.1);
    gain.gain.setValueAtTime(0.3,ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.01,ctx.currentTime+0.3);
    osc.start(ctx.currentTime);osc.stop(ctx.currentTime+0.3);
    osc.onended=()=>ctx.close();
  }catch(e){console.warn('Notification sound failed:',e);}
}

function sendBrowserNotification(title,body){
  if(!window._notificationsEnabled||!document.hidden) return;
  if(!('Notification' in window)) return;
  const botName=window._botName||'Hermes';
  if(Notification.permission==='granted'){
    new Notification(title||botName,{body:body});
  }else if(Notification.permission!=='denied'){
    Notification.requestPermission().then(p=>{
      if(p==='granted') new Notification(title||botName,{body:body});
    });
  }
}

// ── Clarify card (interactive question from agent) ──────────────────────────

let _clarifySessionId = null;

function showClarifyCard(data) {
  const card = $('clarifyCard');
  const qEl = $('clarifyQuestion');
  const choicesEl = $('clarifyChoices');
  const openEl = $('clarifyOpen');
  const inputEl = $('clarifyInput');

  _clarifySessionId = data.session_id || (S.session && S.session.session_id) || null;
  qEl.textContent = data.question || '';

  // Render choices
  const choices = data.choices || [];
  choicesEl.innerHTML = '';
  if (choices.length) {
    const letters = 'ABCD';
    choices.forEach((c, i) => {
      const btn = document.createElement('button');
      btn.className = 'clarify-choice';
      btn.innerHTML = `<span class="choice-letter">${letters[i] || ''}</span><span class="choice-text">${escHtml(c)}</span>`;
      btn.onclick = () => respondClarify(c);
      choicesEl.appendChild(btn);
    });
    choicesEl.style.display = 'flex';
  } else {
    choicesEl.style.display = 'none';
  }

  // Always show the open input as the last option
  openEl.style.display = 'flex';
  inputEl.value = '';
  inputEl.placeholder = choices.length ? 'Other (type your answer)…' : 'Type your answer…';

  card.classList.add('visible');
  card.scrollIntoView({block:'nearest', behavior:'smooth'});

  // Focus input
  setTimeout(() => inputEl.focus(), 50);

  // Enter key to submit
  inputEl.onkeydown = (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      respondClarify();
    }
  };
}

function hideClarifyCard() {
  const card = $('clarifyCard');
  if (card) card.classList.remove('visible');
  _clarifySessionId = null;
}

async function respondClarify(answer) {
  if (!answer && $('clarifyInput')) answer = $('clarifyInput').value.trim();
  if (!answer) return;
  const sid = _clarifySessionId || (S.session && S.session.session_id);
  if (!sid) return;
  hideClarifyCard();
  try {
    await api('/api/clarify/respond', {
      method: 'POST',
      body: JSON.stringify({ session_id: sid, answer }),
    });
  } catch(e) {
    console.warn('Clarify respond failed:', e);
  }
}

function escHtml(s) {
  const d = document.createElement('div');
  d.textContent = s;
  return d.innerHTML;
}

// ── Panel navigation (Chat / Tasks / Skills / Memory) ──
