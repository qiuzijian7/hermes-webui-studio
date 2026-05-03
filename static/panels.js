let _currentPanel = 'chat';
let _skillsData = null; // cached skills list

async function switchPanel(name) {
  _currentPanel = name;
  // Update nav tabs
  document.querySelectorAll('.nav-tab').forEach(t => t.classList.toggle('active', t.dataset.panel === name));
  // Update panel views
  document.querySelectorAll('.panel-view').forEach(p => p.classList.remove('active'));
  const panelEl = $('panel' + name.charAt(0).toUpperCase() + name.slice(1));
  if (panelEl) panelEl.classList.add('active');
  // Lazy-load panel data
  if (name === 'tasks') await loadCrons();
  if (name === 'teams') { if (typeof renderTeamPresets === 'function') renderTeamPresets(); }
  if (name === 'skills') await loadSkills();
  if (name === 'memory') await loadMemory();
  if (name === 'workspaces') await loadWorkspacesPanel();
  if (name === 'profiles') await loadProfilesPanel();
  if (name === 'todos') loadTodos();
}

// ── Cron panel ──
async function loadCrons() {
  const box = $('cronList');
  try {
    const data = await api('/api/crons');
    if (!data.jobs || !data.jobs.length) {
      box.innerHTML = '<div style="padding:16px;color:var(--muted);font-size:12px">No scheduled jobs found.</div>';
      return;
    }
    box.innerHTML = '';
    for (const job of data.jobs) {
      const item = document.createElement('div');
      item.className = 'cron-item';
      item.id = 'cron-' + job.id;
      const statusClass = job.enabled === false ? 'disabled' : job.state === 'paused' ? 'paused' : job.last_status === 'error' ? 'error' : 'active';
      const statusLabel = job.enabled === false ? 'off' : job.state === 'paused' ? 'paused' : job.last_status === 'error' ? 'error' : 'active';
      const nextRun = job.next_run_at ? new Date(job.next_run_at).toLocaleString() : 'N/A';
      const lastRun = job.last_run_at ? new Date(job.last_run_at).toLocaleString() : 'never';
      item.innerHTML = `
        <div class="cron-header" onclick="toggleCron('${job.id}')">
          <span class="cron-name" title="${esc(job.name)}">${esc(job.name)}</span>
          <span class="cron-status ${statusClass}">${statusLabel}</span>
        </div>
        <div class="cron-body" id="cron-body-${job.id}">
          <div class="cron-schedule">${li('clock',12)} ${esc(job.schedule_display || job.schedule?.expression || '')} &nbsp;|&nbsp; Next: ${esc(nextRun)} &nbsp;|&nbsp; Last: ${esc(lastRun)}</div>
          <div class="cron-prompt">${esc((job.prompt||'').slice(0,300))}${(job.prompt||'').length>300?'…':''}</div>
          <div class="cron-actions">
            <button class="cron-btn run" onclick="cronRun('${job.id}')">${li('play',12)} Run now</button>
            ${statusLabel==='paused'
              ? `<button class="cron-btn" onclick="cronResume('${job.id}')">${li('play',12)} Resume</button>`
              : `<button class="cron-btn pause" onclick="cronPause('${job.id}')">${li('pause',12)} Pause</button>`}
            <button class="cron-btn" onclick="cronEditOpen('${job.id}',${JSON.stringify(job).replace(/"/g,'&quot;')})">${li('pencil',12)} Edit</button>
            <button class="cron-btn" style="border-color:rgba(201,168,76,.3);color:var(--accent)" onclick="cronDelete('${job.id}')">${li('trash-2',12)} Delete</button>
          </div>
          <!-- Inline edit form, hidden by default -->
          <div id="cron-edit-${job.id}" style="display:none;margin-top:8px;border-top:1px solid var(--border);padding-top:8px">
            <input id="cron-edit-name-${job.id}" placeholder="Job name" style="width:100%;background:rgba(255,255,255,.05);border:1px solid var(--border2);border-radius:6px;color:var(--text);padding:5px 8px;font-size:12px;outline:none;margin-bottom:5px;box-sizing:border-box">
            <input id="cron-edit-schedule-${job.id}" placeholder="Schedule" style="width:100%;background:rgba(255,255,255,.05);border:1px solid var(--border2);border-radius:6px;color:var(--text);padding:5px 8px;font-size:12px;outline:none;margin-bottom:5px;box-sizing:border-box">
            <textarea id="cron-edit-prompt-${job.id}" rows="3" placeholder="Prompt" style="width:100%;background:rgba(255,255,255,.05);border:1px solid var(--border2);border-radius:6px;color:var(--text);padding:5px 8px;font-size:12px;outline:none;resize:none;font-family:inherit;margin-bottom:5px;box-sizing:border-box"></textarea>
            <div id="cron-edit-err-${job.id}" style="font-size:11px;color:var(--accent);display:none;margin-bottom:5px"></div>
            <div style="display:flex;gap:6px">
              <button class="cron-btn run" style="flex:1" onclick="cronEditSave('${job.id}')">Save</button>
              <button class="cron-btn" style="flex:1" onclick="cronEditClose('${job.id}')">Cancel</button>
            </div>
          </div>
          <div id="cron-output-${job.id}">
            <div class="cron-last-header" style="display:flex;align-items:center;justify-content:space-between">
              <span>Last output</span>
              <button class="cron-btn" style="padding:1px 8px;font-size:10px" onclick="loadCronHistory('${job.id}',this)">All runs</button>
            </div>
            <div class="cron-last" id="cron-out-text-${job.id}" style="color:var(--muted);font-size:11px">Loading…</div>
            <div id="cron-history-${job.id}" style="display:none"></div>
          </div>
        </div>`;
      box.appendChild(item);
      // Eagerly load last output for visible items
      loadCronOutput(job.id);
    }
  } catch(e) { box.innerHTML = `<div style="padding:12px;color:var(--accent);font-size:12px">Error: ${esc(e.message)}</div>`; }
}

let _cronSelectedSkills=[];
let _cronSkillsCache=null;

function toggleCronForm(){
  const form=$('cronCreateForm');
  if(!form)return;
  const open=form.style.display!=='none';
  form.style.display=open?'none':'';
  if(!open){
    $('cronFormName').value='';
    $('cronFormSchedule').value='';
    $('cronFormPrompt').value='';
    $('cronFormDeliver').value='local';
    $('cronFormError').style.display='none';
    _cronSelectedSkills=[];
    _renderCronSkillTags();
    const search=$('cronFormSkillSearch');
    if(search)search.value='';
    // Pre-fetch skills for the picker
    if(!_cronSkillsCache){
      api('/api/skills').then(d=>{_cronSkillsCache=d.skills||[];}).catch(()=>{});
    }
    $('cronFormName').focus();
  }
}

function _renderCronSkillTags(){
  const wrap=$('cronFormSkillTags');
  if(!wrap)return;
  wrap.innerHTML='';
  for(const name of _cronSelectedSkills){
    const tag=document.createElement('span');
    tag.className='skill-tag';
    tag.dataset.skill=name;
    const rm=document.createElement('span');
    rm.className='remove-tag';rm.textContent='×';
    rm.onclick=()=>{_cronSelectedSkills=_cronSelectedSkills.filter(s=>s!==name);tag.remove();};
    tag.appendChild(document.createTextNode(name));
    tag.appendChild(rm);
    wrap.appendChild(tag);
  }
}

// Skill search input handler
(function(){
  const setup=()=>{
    const search=$('cronFormSkillSearch');
    const dropdown=$('cronFormSkillDropdown');
    if(!search||!dropdown)return;
    search.oninput=()=>{
      const q=search.value.trim().toLowerCase();
      if(!q||!_cronSkillsCache){dropdown.style.display='none';return;}
      const matches=_cronSkillsCache.filter(s=>
        !_cronSelectedSkills.includes(s.name)&&
        (s.name.toLowerCase().includes(q)||(s.category||'').toLowerCase().includes(q))
      ).slice(0,8);
      if(!matches.length){dropdown.style.display='none';return;}
      dropdown.innerHTML='';
      for(const s of matches){
        const opt=document.createElement('div');
        opt.className='skill-opt';
        opt.textContent=s.name+(s.category?' ('+s.category+')':'');
        opt.onclick=()=>{
          _cronSelectedSkills.push(s.name);
          _renderCronSkillTags();
          search.value='';
          dropdown.style.display='none';
        };
        dropdown.appendChild(opt);
      }
      dropdown.style.display='';
    };
    search.onblur=()=>setTimeout(()=>{dropdown.style.display='none';},150);
  };
  if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',setup);
  else setTimeout(setup,0);
})();

async function submitCronCreate(){
  const name=$('cronFormName').value.trim();
  const schedule=$('cronFormSchedule').value.trim();
  const prompt=$('cronFormPrompt').value.trim();
  const deliver=$('cronFormDeliver').value;
  const errEl=$('cronFormError');
  errEl.style.display='none';
  if(!schedule){errEl.textContent='Schedule is required (e.g. "0 9 * * *" or "every 1h")';errEl.style.display='';return;}
  if(!prompt){errEl.textContent='Prompt is required';errEl.style.display='';return;}
  try{
    const body={schedule,prompt,deliver};
    if(name)body.name=name;
    if(_cronSelectedSkills.length)body.skills=_cronSelectedSkills;
    await api('/api/crons/create',{method:'POST',body:JSON.stringify(body)});
    toggleCronForm();
    showToast('Job created');
    await loadCrons();
  }catch(e){
    errEl.textContent='Error: '+e.message;errEl.style.display='';
  }
}

function _cronOutputSnippet(content) {
  // Extract the response body from a cron output .md file
  const lines = content.split('\n');
  const responseIdx = lines.findIndex(l => l.startsWith('## Response') || l.startsWith('# Response'));
  const body = (responseIdx >= 0 ? lines.slice(responseIdx + 1) : lines).join('\n').trim();
  return body.slice(0, 600) || '(empty)';
}

async function loadCronOutput(jobId) {
  try {
    const data = await api(`/api/crons/output?job_id=${encodeURIComponent(jobId)}&limit=1`);
    const el = $('cron-out-text-' + jobId);
    if (!el) return;
    if (!data.outputs || !data.outputs.length) { el.textContent = '(no runs yet)'; return; }
    const out = data.outputs[0];
    const ts = out.filename.replace('.md','').replace(/_/g,' ');
    el.textContent = ts + '\n\n' + _cronOutputSnippet(out.content);
  } catch(e) { /* ignore */ }
}

async function loadCronHistory(jobId, btn) {
  const histEl = $('cron-history-' + jobId);
  if (!histEl) return;
  // Toggle: if already open, close it
  if (histEl.style.display !== 'none') {
    histEl.style.display = 'none';
    if (btn) btn.textContent = 'All runs';
    return;
  }
  if (btn) btn.textContent = 'Loading…';
  try {
    const data = await api(`/api/crons/output?job_id=${encodeURIComponent(jobId)}&limit=20`);
    if (!data.outputs || !data.outputs.length) {
      histEl.innerHTML = '<div style="font-size:11px;color:var(--muted);padding:4px 0">(no runs yet)</div>';
    } else {
      histEl.innerHTML = data.outputs.map((out, i) => {
        const ts = out.filename.replace('.md','').replace(/_/g,' ');
        const snippet = _cronOutputSnippet(out.content);
        const id = `cron-hist-run-${jobId}-${i}`;
        return `<div style="border-top:1px solid var(--border);padding:6px 0">
          <div style="display:flex;align-items:center;justify-content:space-between;cursor:pointer" onclick="document.getElementById('${id}').style.display=document.getElementById('${id}').style.display==='none'?'':'none'">
            <span style="font-size:11px;font-weight:600;color:var(--muted)">${esc(ts)}</span>
            <span style="font-size:10px;color:var(--muted);opacity:.6">▸</span>
          </div>
          <div id="${id}" style="display:none;font-size:11px;color:var(--muted);white-space:pre-wrap;line-height:1.5;margin-top:4px;max-height:200px;overflow-y:auto">${esc(snippet)}</div>
        </div>`;
      }).join('');
    }
    histEl.style.display = '';
    if (btn) btn.textContent = 'Hide runs';
  } catch(e) {
    if (btn) btn.textContent = 'All runs';
  }
}

function toggleCron(id) {
  const body = $('cron-body-' + id);
  if (body) body.classList.toggle('open');
}

async function cronRun(id) {
  try {
    await api('/api/crons/run', {method:'POST', body: JSON.stringify({job_id: id})});
    showToast('Job triggered');
    setTimeout(() => loadCronOutput(id), 5000);
  } catch(e) { showToast('Run failed: ' + e.message, 4000); }
}

async function cronPause(id) {
  try {
    await api('/api/crons/pause', {method:'POST', body: JSON.stringify({job_id: id})});
    showToast('Job paused');
    await loadCrons();
  } catch(e) { showToast('Pause failed: ' + e.message, 4000); }
}

async function cronResume(id) {
  try {
    await api('/api/crons/resume', {method:'POST', body: JSON.stringify({job_id: id})});
    showToast('Job resumed');
    await loadCrons();
  } catch(e) { showToast('Resume failed: ' + e.message, 4000); }
}

function cronEditOpen(id, job) {
  const form = $('cron-edit-' + id);
  if (!form) return;
  $('cron-edit-name-' + id).value = job.name || '';
  $('cron-edit-schedule-' + id).value = job.schedule_display || (job.schedule && job.schedule.expression) || job.schedule || '';
  $('cron-edit-prompt-' + id).value = job.prompt || '';
  const errEl = $('cron-edit-err-' + id);
  if (errEl) errEl.style.display = 'none';
  form.style.display = '';
}

function cronEditClose(id) {
  const form = $('cron-edit-' + id);
  if (form) form.style.display = 'none';
}

async function cronEditSave(id) {
  const name = $('cron-edit-name-' + id).value.trim();
  const schedule = $('cron-edit-schedule-' + id).value.trim();
  const prompt = $('cron-edit-prompt-' + id).value.trim();
  const errEl = $('cron-edit-err-' + id);
  if (!schedule) { errEl.textContent = 'Schedule is required'; errEl.style.display = ''; return; }
  if (!prompt) { errEl.textContent = 'Prompt is required'; errEl.style.display = ''; return; }
  try {
    const updates = {job_id: id, schedule, prompt};
    if (name) updates.name = name;
    await api('/api/crons/update', {method:'POST', body: JSON.stringify(updates)});
    showToast('Job updated');
    await loadCrons();
  } catch(e) { errEl.textContent = 'Error: ' + e.message; errEl.style.display = ''; }
}

async function cronDelete(id) {
  const _delCron=await showConfirmDialog({title:'Delete cron job',message:'This cannot be undone.',confirmLabel:'Delete',danger:true,focusCancel:true});
  if(!_delCron) return;
  try {
    await api('/api/crons/delete', {method:'POST', body: JSON.stringify({job_id: id})});
    showToast('Job deleted');
    await loadCrons();
  } catch(e) { showToast('Delete failed: ' + e.message, 4000); }
}

function loadTodos() {
  const panel = $('todoPanel');
  if (!panel) return;
  // Parse the most recent todo state from message history
  let todos = [];
  for (let i = S.messages.length - 1; i >= 0; i--) {
    const m = S.messages[i];
    if (m && m.role === 'tool') {
      try {
        const d = JSON.parse(typeof m.content === 'string' ? m.content : JSON.stringify(m.content));
        if (d && Array.isArray(d.todos) && d.todos.length) {
          todos = d.todos;
          break;
        }
      } catch(e) {}
    }
  }
  if (!todos.length) {
    panel.innerHTML = '<div style="color:var(--muted);font-size:12px;padding:4px 0">No active task list in this session.</div>';
    return;
  }
  const statusIcon = {pending:li('square',14), in_progress:li('loader',14), completed:li('check',14), cancelled:li('x',14)};
  const statusColor = {pending:'var(--muted)', in_progress:'var(--blue)', completed:'rgba(100,200,100,.8)', cancelled:'rgba(200,100,100,.5)'};
  panel.innerHTML = todos.map(t => `
    <div style="display:flex;align-items:flex-start;gap:10px;padding:6px 0;border-bottom:1px solid var(--border);">
      <span style="font-size:14px;display:inline-flex;align-items:center;flex-shrink:0;margin-top:1px;color:${statusColor[t.status]||'var(--muted)'}">${statusIcon[t.status]||li('square',14)}</span>
      <div style="flex:1;min-width:0">
        <div style="font-size:13px;color:${t.status==='completed'?'var(--muted)':t.status==='in_progress'?'var(--text)':'var(--text)'};${t.status==='completed'?'text-decoration:line-through;opacity:.5':''};line-height:1.4">${esc(t.content)}</div>
        <div style="font-size:10px;color:var(--muted);margin-top:2px;opacity:.6">${esc(t.id)} · ${esc(t.status)}</div>
      </div>
    </div>`).join('');
}

async function clearConversation() {
  if(!S.session) return;
  const _clrMsg=await showConfirmDialog({title:'Clear conversation',message:'Clear all messages? This cannot be undone.',confirmLabel:'Clear',danger:true,focusCancel:true});
  if(!_clrMsg) return;
  try {
    const data = await api('/api/session/clear', {method:'POST',
      body: JSON.stringify({session_id: S.session.session_id})});
    S.session = data.session;
    S.messages = [];
    S.toolCalls = [];
    syncTopbar();
    renderMessages();
    showToast('Conversation cleared');
  } catch(e) { setStatus('Clear failed: ' + e.message); }
}

// ── Skills panel ──
async function loadSkills() {
  if (_skillsData) { renderSkills(_skillsData); return; }
  const box = $('skillsList');
  try {
    const data = await api('/api/skills');
    _skillsData = data.skills || [];
    renderSkills(_skillsData);
  } catch(e) { box.innerHTML = `<div style="padding:12px;color:var(--accent);font-size:12px">Error: ${esc(e.message)}</div>`; }
}

function renderSkills(skills) {
  const query = ($('skillsSearch').value || '').toLowerCase();
  const filtered = query ? skills.filter(s =>
    (s.name||'').toLowerCase().includes(query) ||
    (s.description||'').toLowerCase().includes(query) ||
    (s.category||'').toLowerCase().includes(query)
  ) : skills;
  // Group by category
  const cats = {};
  for (const s of filtered) {
    const cat = s.category || '(general)';
    if (!cats[cat]) cats[cat] = [];
    cats[cat].push(s);
  }
  const box = $('skillsList');
  box.innerHTML = '';
  if (!filtered.length) { box.innerHTML = '<div style="padding:12px;color:var(--muted);font-size:12px">No skills match.</div>'; return; }
  for (const [cat, items] of Object.entries(cats).sort()) {
    const sec = document.createElement('div');
    sec.className = 'skills-category';
    sec.innerHTML = `<div class="skills-cat-header">${li('folder',12)} ${esc(cat)} <span style="opacity:.5">(${items.length})</span></div>`;
    for (const skill of items.sort((a,b) => a.name.localeCompare(b.name))) {
      const el = document.createElement('div');
      el.className = 'skill-item';
      el.innerHTML = `<span class="skill-name">${esc(skill.name)}</span><span class="skill-desc">${esc(skill.description||'')}</span>`;
      el.onclick = () => openSkill(skill.name, el);
      sec.appendChild(el);
    }
    box.appendChild(sec);
  }
}

function filterSkills() {
  if (_skillsData) renderSkills(_skillsData);
}

async function openSkill(name, el) {
  // Highlight active skill
  document.querySelectorAll('.skill-item').forEach(e => e.classList.remove('active'));
  if (el) el.classList.add('active');
  try {
    const data = await api(`/api/skills/content?name=${encodeURIComponent(name)}`);
    const category = data.category || '(general)';
    // 在右侧面板显示技能详情
    if (typeof openSkillDetail === 'function') {
      openSkillDetail(name, category, data.content || '');
    }
  } catch(e) { setStatus('Could not load skill: ' + e.message); }
}

async function openSkillFile(skillName, filePath) {
  try {
    const data = await api(`/api/skills/content?name=${encodeURIComponent(skillName)}&file=${encodeURIComponent(filePath)}`);
    const _ppt=$('previewPathText');if(_ppt)_ppt.textContent = skillName + ' / ' + filePath;
    const _pb=$('previewBadge');if(_pb){_pb.textContent = filePath.split('.').pop() || 'file';_pb.className = 'preview-badge code';}
    const ext = filePath.split('.').pop() || '';
    if (['md','markdown'].includes(ext)) {
      showPreview('md');
      const _pm=$('previewMd');if(_pm)_pm.innerHTML = renderMd(data.content || '');
    } else {
      showPreview('code');
      const _pc=$('previewCode');if(_pc)_pc.textContent = data.content || '';
      requestAnimationFrame(() => highlightCode());
    }
  } catch(e) { setStatus('Could not load file: ' + e.message); }
}

// ── Skill create/edit form ──
let _editingSkillName = null;

function toggleSkillForm(prefillName, prefillCategory, prefillContent) {
  const form = $('skillCreateForm');
  if (!form) return;
  const open = form.style.display !== 'none';
  if (open) { form.style.display = 'none'; _editingSkillName = null; return; }
  $('skillFormName').value = prefillName || '';
  $('skillFormCategory').value = prefillCategory || '';
  $('skillFormContent').value = prefillContent || '';
  $('skillFormError').style.display = 'none';
  _editingSkillName = prefillName || null;
  form.style.display = '';
  $('skillFormName').focus();
}

async function submitSkillSave() {
  const name = ($('skillFormName').value||'').trim().toLowerCase().replace(/\s+/g, '-');
  const category = ($('skillFormCategory').value||'').trim();
  const content = $('skillFormContent').value;
  const errEl = $('skillFormError');
  errEl.style.display = 'none';
  if (!name) { errEl.textContent = 'Skill name is required'; errEl.style.display = ''; return; }
  if (!content.trim()) { errEl.textContent = 'Content is required'; errEl.style.display = ''; return; }
  try {
    await api('/api/skills/save', {method:'POST', body: JSON.stringify({name, category: category||undefined, content})});
    showToast(_editingSkillName ? 'Skill updated' : 'Skill created');
    _skillsData = null;
    toggleSkillForm();
    await loadSkills();
  } catch(e) { errEl.textContent = 'Error: ' + e.message; errEl.style.display = ''; }
}

// ── Memory inline edit ──
let _memoryData = null;

function toggleMemoryEdit() {
  const form = $('memoryEditForm');
  if (!form) return;
  const open = form.style.display !== 'none';
  if (open) { form.style.display = 'none'; return; }
  $('memEditSection').textContent = 'memory (notes)';
  $('memEditContent').value = _memoryData ? (_memoryData.memory || '') : '';
  $('memEditError').style.display = 'none';
  form.style.display = '';
}

function closeMemoryEdit() {
  const form = $('memoryEditForm');
  if (form) form.style.display = 'none';
}

async function submitMemorySave() {
  const content = $('memEditContent').value;
  const errEl = $('memEditError');
  errEl.style.display = 'none';
  try {
    await api('/api/memory/write', {method:'POST', body: JSON.stringify({section: 'memory', content})});
    showToast('Memory saved');
    closeMemoryEdit();
    await loadMemory(true);
  } catch(e) { errEl.textContent = 'Error: ' + e.message; errEl.style.display = ''; }
}

// ── Workspace management ──
let _workspaceList = [];  // cached from /api/workspaces

function getWorkspaceFriendlyName(path){
  // Look up the friendly name from the workspace list cache, fallback to last path segment
  if(_workspaceList && _workspaceList.length){
    const match=_workspaceList.find(w=>w.path===path);
    if(match && match.name) return match.name;
  }
  return path.split('/').filter(Boolean).pop()||path;
}

function syncWorkspaceDisplays(){
  const hasSession=!!(S.session&&S.session.workspace);
  const ws=hasSession?S.session.workspace:'';
  const label=hasSession?getWorkspaceFriendlyName(ws):t('no_workspace');

  const sidebarName=$('sidebarWsName');
  const sidebarPath=$('sidebarWsPath');
  if(sidebarName) sidebarName.textContent=label;
  if(sidebarPath) sidebarPath.textContent=ws;

  const composerChip=$('composerWorkspaceChip');
  const composerLabel=$('composerWorkspaceLabel');
  const composerDropdown=$('composerWsDropdown');
  if(!hasSession && composerDropdown) composerDropdown.classList.remove('open');
  if(composerLabel) composerLabel.textContent=label;
  if(composerChip){
    composerChip.disabled=!hasSession;
    composerChip.title=hasSession?ws:'No active workspace';
    composerChip.classList.toggle('active',!!(composerDropdown&&composerDropdown.classList.contains('open')));
  }
}

async function loadWorkspaceList(){
  try{
    const data = await api('/api/workspaces');
    _workspaceList = data.workspaces || [];
    syncWorkspaceDisplays();
    return data;
  }catch(e){ return {workspaces:[], last:''}; }
}

function _renderWorkspaceAction(label, meta, iconSvg, onClick){
  const opt=document.createElement('div');
  opt.className='ws-opt ws-opt-action';
  opt.innerHTML=`<span class="ws-opt-icon">${iconSvg}</span><span><span class="ws-opt-name">${esc(label)}</span>${meta?`<span class="ws-opt-meta">${esc(meta)}</span>`:''}</span>`;
  opt.onclick=onClick;
  return opt;
}

function _positionComposerWsDropdown(){
  const dd=$('composerWsDropdown');
  const chip=$('composerWorkspaceChip');
  const footer=document.querySelector('.composer-footer');
  if(!dd||!chip||!footer)return;
  const chipRect=chip.getBoundingClientRect();
  const footerRect=footer.getBoundingClientRect();
  let left=chipRect.left-footerRect.left;
  const maxLeft=Math.max(0, footer.clientWidth-dd.offsetWidth);
  left=Math.max(0, Math.min(left, maxLeft));
  dd.style.left=`${left}px`;
}

function _positionProfileDropdown(){
  const dd=$('profileDropdown');
  const chip=$('profileChip');
  const footer=document.querySelector('.composer-footer');
  if(!dd||!chip||!footer)return;
  const chipRect=chip.getBoundingClientRect();
  const footerRect=footer.getBoundingClientRect();
  let left=chipRect.left-footerRect.left;
  const maxLeft=Math.max(0, footer.clientWidth-dd.offsetWidth);
  left=Math.max(0, Math.min(left, maxLeft));
  dd.style.left=`${left}px`;
}

function renderWorkspaceDropdownInto(dd, workspaces, currentWs){
  if(!dd)return;
  console.log('[renderWorkspaceDropdownInto] workspaces:', workspaces?.length, 'currentWs:', currentWs);
  dd.innerHTML='';
  for(const w of workspaces){
    const opt=document.createElement('div');
    opt.className='ws-opt'+(w.path===currentWs?' active':'');
    // 左侧：点击切换工作区
    const infoDiv=document.createElement('div');
    infoDiv.className='ws-opt-info';
    infoDiv.innerHTML=`<span class="ws-opt-name">${esc(w.name)}</span><span class="ws-opt-path">${esc(w.path)}</span>`;
    infoDiv.onclick=()=>switchToWorkspace(w.path,w.name);
    opt.appendChild(infoDiv);
    // 右侧：删除按钮
    const delBtn=document.createElement('button');
    delBtn.className='ws-opt-del';
    delBtn.title='删除工作区';
    delBtn.innerHTML=li('x',12);
    if (!delBtn.innerHTML) {
      console.warn('[renderWorkspaceDropdownInto] li("x",12) returned empty string for workspace:', w.name);
    }
    delBtn.onclick=(e)=>{
      e.stopPropagation();
      removeWorkspace(w.path);
    };
    opt.appendChild(delBtn);
    dd.appendChild(opt);
  }
  console.log('[renderWorkspaceDropdownInto] dropdown rendered, child count:', dd.children.length);
  dd.appendChild(document.createElement('div')).className='ws-divider';
  dd.appendChild(_renderWorkspaceAction(
    'Choose workspace path',
    'Add a validated path and switch this conversation',
    li('folder',12),
    ()=>promptWorkspacePath()
  ));
  const div=document.createElement('div');div.className='ws-divider';dd.appendChild(div);
  dd.appendChild(_renderWorkspaceAction(
    'Manage workspaces',
    'Open the Spaces panel',
    li('settings',12),
    ()=>{closeWsDropdown();mobileSwitchPanel('workspaces');}
  ));
}

function toggleWsDropdown(){
  const dd=$('wsDropdown');
  if(!dd)return;
  const open=dd.classList.contains('open');
  if(open){closeWsDropdown();}
  else{
    closeProfileDropdown(); // close profile dropdown if open
    loadWorkspaceList().then(data=>{
      renderWorkspaceDropdownInto(dd, data.workspaces, S.session?S.session.workspace:'');
      dd.classList.add('open');
    });
  }
}

function toggleComposerWsDropdown(){
  const dd=$('composerWsDropdown');
  const chip=$('composerWorkspaceChip');
  if(!dd||!chip||chip.disabled)return;
  const open=dd.classList.contains('open');
  if(open){closeWsDropdown();}
  else{
    closeProfileDropdown();
    if(typeof closeModelDropdown==='function') closeModelDropdown();
    loadWorkspaceList().then(data=>{
      renderWorkspaceDropdownInto(dd, data.workspaces, S.session?S.session.workspace:'');
      dd.classList.add('open');
      _positionComposerWsDropdown();
      chip.classList.add('active');
    });
  }
}

function closeWsDropdown(){
  const dd=$('wsDropdown');
  const composerDd=$('composerWsDropdown');
  const composerChip=$('composerWorkspaceChip');
  if(dd)dd.classList.remove('open');
  if(composerDd)composerDd.classList.remove('open');
  if(composerChip)composerChip.classList.remove('active');
}
document.addEventListener('click',e=>{
  if(
    !e.target.closest('#composerWorkspaceChip') &&
    !e.target.closest('#composerWsDropdown')
  ) closeWsDropdown();
});
window.addEventListener('resize',()=>{
  const dd=$('composerWsDropdown');
  if(dd&&dd.classList.contains('open')) _positionComposerWsDropdown();
});

async function loadWorkspacesPanel(){
  const panel=$('workspacesPanel');
  if(!panel)return;
  const data=await loadWorkspaceList();
  renderWorkspacesPanel(data.workspaces);
}

function renderWorkspacesPanel(workspaces){
  const panel=$('workspacesPanel');
  panel.innerHTML='';
  for(const w of workspaces){
    const row=document.createElement('div');row.className='ws-row';
    row.innerHTML=`
      <div class="ws-row-info">
        <div class="ws-row-name">${esc(w.name)}</div>
        <div class="ws-row-path">${esc(w.path)}</div>
      </div>
      <div class="ws-row-actions">
        <button class="ws-action-btn" title="Use in current session" onclick="switchToWorkspace('${esc(w.path)}','${esc(w.name)}')">${li('arrow-right',12)} Use</button>
        <button class="ws-action-btn danger" title="Remove" onclick="removeWorkspace('${esc(w.path)}')">${li('x',12)}</button>
      </div>`;
    panel.appendChild(row);
  }
  const addRow=document.createElement('div');addRow.className='ws-add-row';
  addRow.innerHTML=`
    <input id="wsAddInput" placeholder="Add workspace path (e.g. /home/user/my-project)" style="flex:1;background:rgba(255,255,255,.06);border:1px solid var(--border2);border-radius:7px;color:var(--text);padding:7px 10px;font-size:12px;outline:none;">
    <button class="ws-action-btn" onclick="addWorkspace()">${li('plus',12)} Add</button>`;
  panel.appendChild(addRow);
  const hint=document.createElement('div');
  hint.style.cssText='font-size:11px;color:var(--muted);padding:4px 0 8px';
  hint.textContent='Paths are validated as existing directories before saving.';
  panel.appendChild(hint);
}

async function addWorkspace(){
  const input=$('wsAddInput');
  const path=(input?input.value:'').trim();
  if(!path)return;
  try{
    const data=await api('/api/workspaces/add',{method:'POST',body:JSON.stringify({path,create:true})});
    _workspaceList=data.workspaces;
    if(typeof _wsSelectorList!=='undefined') _wsSelectorList=_workspaceList.slice();
    renderWorkspacesPanel(data.workspaces);
    if(input)input.value='';
    if(data.resolved_path&&data.resolved_path!==path){
      showToast('Workspace created at '+data.resolved_path);
    }else{
      showToast('Workspace added');
    }
    // Show template init info if employees were created
    if(data.template_init&&data.template_init.created>0){
      showToast(`已自动创建 ${data.template_init.created} 个模板员工`);
    }
    // ★ 不再在这里调用 ensurePMExists()，因为此时 _currentCanvasWorkspace 仍指向旧工作区。
    //   PM 专员的创建由 switchCanvasWorkspace 的 hook 触发（_hookWorkspaceSwitch），
    //   确保在新工作区的上下文中正确创建 PM 专员。
    // Show workspace manager init info
    if(data.ws_manager&&data.ws_manager.slug){
      console.log('[addWorkspace] Centralized workspace created:', data.ws_manager.slug);
    }
  }catch(e){setStatus('Add failed: '+e.message);}
}

async function removeWorkspace(path){
  const _rmWs=await showConfirmDialog({title:'Remove workspace',message:`Remove "${path}"?`,confirmLabel:'Remove',danger:true,focusCancel:true});
  if(!_rmWs) return;
  try{
    const data=await api('/api/workspaces/remove',{method:'POST',body:JSON.stringify({path})});
    _workspaceList=data.workspaces;
    if(typeof _wsSelectorList!=='undefined') _wsSelectorList=_workspaceList.slice();
    renderWorkspacesPanel(data.workspaces);
    // ★ 同时更新下拉列表：关闭并重新渲染（如果打开了）
    const dd=$('wsDropdown');
    const composerDd=$('composerWsDropdown');
    if(dd&&dd.classList.contains('open')){
      // 重新渲染下拉列表
      loadWorkspaceList().then(d=>{
        renderWorkspaceDropdownInto(dd,d.workspaces,S.session?S.session.workspace:'');
      });
    }
    if(composerDd&&composerDd.classList.contains('open')){
      loadWorkspaceList().then(d=>{
        renderWorkspaceDropdownInto(composerDd,d.workspaces,S.session?S.session.workspace:'');
      });
    }
    showToast('Workspace removed');
  }catch(e){setStatus('Remove failed: '+e.message);}
}

async function promptWorkspacePath(){
  const result=await _showBrowsePathDialog({
    title:'设置工作区路径',
    message:'输入或浏览选择工作区路径，将自动创建并切换到该工作区。',
    confirmLabel:'确定',
    value:S.session?S.session.workspace||'':''
  });
  const path=(result||'').trim();
  if(!path)return;
  try{
    // 确保有活跃会话
    if(!S.session){
      if(typeof newSession==='function'){
        await newSession(false);
        if(typeof renderSessionList==='function') await renderSessionList();
      }else{
        showToast('无法创建会话');
        return;
      }
    }
    const data=await api('/api/workspaces/add',{method:'POST',body:JSON.stringify({path,create:true})});
    _workspaceList=data.workspaces||[];
    // 同步中间工作区选择器的缓存
    if(typeof _wsSelectorList!=='undefined') _wsSelectorList=_workspaceList.slice();
    const target=_workspaceList[_workspaceList.length-1];
    if(!target) throw new Error('Workspace was not added');
    await switchToWorkspace(target.path,target.name);
    showToast('工作区已切换到 '+(data.resolved_path||path));
    if(data.template_init&&data.template_init.created>0){
      showToast(`已自动创建 ${data.template_init.created} 个模板员工`);
    }
  }catch(e){
    if(String(e.message||'').includes('Workspace already in list')){
      // 已存在则刷新列表并直接切换
      await loadWorkspaceList();
      if(typeof _wsSelectorList!=='undefined') _wsSelectorList=_workspaceList.slice();
      const existing=_workspaceList.find(w=>w.path===path);
      if(existing) await switchToWorkspace(existing.path,existing.name);
      else showToast('工作区已存在 — 请从列表中选择');
      return;
    }
    showToast('工作区切换失败: '+e.message);
  }
}

let _browseDirCache={};
async function _browseDir(path){
  const cacheKey=path||'__home__';
  if(_browseDirCache[cacheKey]&&Date.now()-_browseDirCache[cacheKey]._ts<5000)
    return _browseDirCache[cacheKey];
  try{
    const url='/api/browse-dir'+(path?'?path='+encodeURIComponent(path):'');
    const data=await api(url);
    data._ts=Date.now();
    _browseDirCache[cacheKey]=data;
    return data;
  }catch(e){return {path:path||'',parent:null,dirs:[]};}
}

async function _showBrowsePathDialog(opts={}){
  _ensureAppDialogBindings();
  if(APP_DIALOG.resolve) _finishAppDialog(null,false);
  const overlay=$('appDialogOverlay'),dialog=$('appDialog'),title=$('appDialogTitle'),
    desc=$('appDialogDesc'),inputRow=$('appDialogInputRow'),input=$('appDialogInput'),
    cancelBtn=$('appDialogCancel'),confirmBtn=$('appDialogConfirm'),
    browseBtn=$('appDialogBrowseBtn'),
    browseEl=$('appDialogBrowse');
  APP_DIALOG.resolve=null;APP_DIALOG.kind='prompt';APP_DIALOG.lastFocus=document.activeElement;
  if(title) title.textContent=opts.title||'';
  if(desc) desc.textContent=opts.message||'';
  if(inputRow) inputRow.style.display='';
  if(browseBtn) browseBtn.style.display='';
  if(input){
    input.type='text';
    input.value=opts.value||'';input.placeholder=opts.placeholder||'输入工作区路径';
    input.autocomplete='off';input.spellcheck=false;
  }
  if(cancelBtn) cancelBtn.textContent=opts.cancelLabel||t('cancel');
  if(confirmBtn){confirmBtn.textContent=opts.confirmLabel||t('create');confirmBtn.classList.remove('danger');}
  // 内嵌服务器端目录浏览面板
  if(browseEl){
    browseEl.style.display='block';
    browseEl.innerHTML='';
    const browseList=document.createElement('div');
    browseList.style.cssText='max-height:200px;overflow-y:auto;margin:6px 0;border:1px solid var(--border-color,#333);border-radius:4px;background:var(--bg-secondary,#1a1a1a);';
    const loadDirs=async(dirPath)=>{
      browseList.innerHTML='<div style="padding:8px;color:var(--text-dim,#888)">Loading…</div>';
      try{
        const url='/api/browse-dir'+(dirPath?'?path='+encodeURIComponent(dirPath):'');
        const data=await api(url);
        browseList.innerHTML='';
        // Parent dir link
        if(data.parent!==null&&data.parent!==undefined){
          const parentItem=document.createElement('div');
          parentItem.style.cssText='padding:4px 8px;cursor:pointer;color:var(--text-dim,#888);border-bottom:1px solid var(--border-color,#333);';
          parentItem.textContent='📁 ..';
          parentItem.onclick=()=>loadDirs(data.parent);
          browseList.appendChild(parentItem);
        }
        for(const d of(data.dirs||[])){
          const item=document.createElement('div');
          item.style.cssText='padding:4px 8px;cursor:pointer;color:var(--text-primary,#eee);border-bottom:1px solid var(--border-color,#222);';
          item.textContent='📁 '+d.name;
          item.onmouseenter=()=>{item.style.background='var(--bg-hover,#2a2a2a)';};
          item.onmouseleave=()=>{item.style.background='';};
          item.onclick=()=>{if(input)input.value=d.path;loadDirs(d.path);};
          browseList.appendChild(item);
        }
        if(!(data.dirs||[]).length){
          const empty=document.createElement('div');
          empty.style.cssText='padding:8px;color:var(--text-dim,#888);';
          empty.textContent='(no subdirectories)';
          browseList.appendChild(empty);
        }
      }catch(e){
        browseList.innerHTML='<div style="padding:8px;color:var(--error,#f44)">Failed to browse: '+e.message+'</div>';
      }
    };
    // Initial browse from the input value or home
    loadDirs((opts.value||'').trim()||'');
    browseEl.appendChild(browseList);
  }
  // "..." 按钮：调用后端弹出系统原生文件夹选择对话框
  if(browseBtn){
    browseBtn.onclick=async()=>{
      browseBtn.disabled=true;
      browseBtn.textContent='…';
      try{
        const initial=(input?input.value.trim():'')||'';
        const url='/api/pick-folder'+(initial?'?initial='+encodeURIComponent(initial):'');
        const data=await api(url);
        if(data.path){
          if(input) input.value=data.path;
        }
      }catch(e){
        showToast('无法打开文件夹选择器（Docker环境请使用下方目录列表浏览）');
      }finally{
        browseBtn.disabled=false;
        browseBtn.textContent='...';
      }
    };
  }
  // 清理旧的 keydown 处理器
  if(input&&input._browseKeyHandler){
    input.removeEventListener('keydown',input._browseKeyHandler);
    input._browseKeyHandler=null;
  }
  if(dialog) dialog.setAttribute('role','dialog');
  if(overlay){overlay.style.display='flex';overlay.setAttribute('aria-hidden','false');}
  return new Promise(resolve=>{
    APP_DIALOG.resolve=resolve;
    setTimeout(()=>{if(inputRow&&inputRow.style.display!=='none')input.focus();else if(confirmBtn)confirmBtn.focus();},0);
  });
}

function Path_parent(p){
  // 简单的路径父级计算（跨平台）
  if(!p) return null;
  const sep=p.includes('\\')?'\\':'/';
  const parts=p.replace(/[\/\\]+$/,'').split(/[\/\\]/).filter(Boolean);
  if(parts.length<=1) return null;
  const parentParts=parts.slice(0,-1);
  let parent=parentParts.join(sep);
  // Windows: C: → C:\
  if(p.match(/^[A-Za-z]:/)&&!parent.includes(sep)) parent+=sep;
  if(!parent||parent===p) return null;
  return parent;
}

async function switchToWorkspace(path,name){
  // ★ 即使没有 session 也切换画布工作区
  if(typeof switchCanvasWorkspace==='function') switchCanvasWorkspace(path);
  if(typeof syncWsSelectorLabel==='function') syncWsSelectorLabel();
  
  // ★ Ensure workspace is registered in knot-cli (async, non-blocking)
  _ensureKnotWorkspaceAsync(path);
  // ★ 更新顶栏 Knot 标记
  if (typeof _knotBadgeLastWs !== 'undefined') _knotBadgeLastWs = '';
  if (typeof updateKnotBadge === 'function') updateKnotBadge(path);
  
  if(!S.session){
    // No session — create one with the selected workspace so files can load
    try{
      const data=await api('/api/session/new',{method:'POST',body:JSON.stringify({workspace:path,model:$('modelSelect')?.value||''})});
      S.session=data.session;
      S.messages=[];
      localStorage.setItem('hermes-webui-session',S.session.session_id);
      syncTopbar();
      await loadDir('.');
      showToast(`Switched to ${name||getWorkspaceFriendlyName(path)}`);
    }catch(e){
      console.error('[switchToWorkspace] create session failed:', e);
      showToast(`Switched canvas to ${name||getWorkspaceFriendlyName(path)}`);
    }
    return;
  }
  if(S.busy){
    showToast('Cannot switch workspace while agent is running');
    return;
  }
  if(typeof _previewDirty!=='undefined'&&_previewDirty){
    const discard=await showConfirmDialog({
      title:'Discard file edits?',
      message:'Switching workspaces will discard unsaved file edits in the preview.',
      confirmLabel:t('discard'),
      danger:true
    });
    if(!discard)return;
    if(typeof cancelEditMode==='function')cancelEditMode();
    if(typeof clearPreview==='function')clearPreview();
  }
  try{
    closeWsDropdown();
    await api('/api/session/update',{method:'POST',body:JSON.stringify({
      session_id:S.session.session_id, workspace:path, model:S.session.model
    })});
    S.session.workspace=path;
    syncTopbar();
    if(typeof syncWsSelectorLabel==='function') syncWsSelectorLabel();
    await loadDir('.');
    showToast(`Switched to ${name||getWorkspaceFriendlyName(path)}`);
  }catch(e){
    setStatus('Switch failed: '+e.message);
  }
}

// ── knot-cli workspace sync helper (non-blocking) ──
function _ensureKnotWorkspaceAsync(path) {
  // Use knot-cli workspace --action list to check, then --action add if missing
  // This runs in the background to not block the UI
  api('/api/knot-cli/workspace/add', {
    method: 'POST',
    body: JSON.stringify({ path: path })
  }).then(r => {
    if (r && r.ok) {
      console.log('[knot-sync] workspace ensured:', path);
    }
  }).catch(e => {
    // Silently ignore — knot-cli might not be installed
    console.debug('[knot-sync] workspace sync skipped:', e.message || e);
  });
}

// ── Profile panel + dropdown ──
let _profilesCache = null;

async function loadProfilesPanel() {
  const panel = $('profilesPanel');
  if (!panel) return;
  try {
    const data = await api('/api/profiles');
    _profilesCache = data;
    panel.innerHTML = '';
    if (!data.profiles || !data.profiles.length) {
      panel.innerHTML = '<div style="padding:16px;color:var(--muted);font-size:12px">No profiles found.</div>';
      return;
    }
    for (const p of data.profiles) {
      const card = document.createElement('div');
      card.className = 'profile-card';
      const meta = [];
      if (p.model) meta.push(p.model.split('/').pop());
      if (p.provider) meta.push(p.provider);
      if (p.skill_count) meta.push(p.skill_count + ' skill' + (p.skill_count !== 1 ? 's' : ''));
      if (p.has_env) meta.push('API keys configured');
      const gwDot = p.gateway_running
        ? '<span class="profile-opt-badge running" title="Gateway running"></span>'
        : '<span class="profile-opt-badge stopped" title="Gateway stopped"></span>';
      const isActive = p.name === data.active;
      const activeBadge = isActive ? '<span style="color:var(--link);font-size:10px;font-weight:600;margin-left:6px">ACTIVE</span>' : '';
      card.innerHTML = `
        <div class="profile-card-header">
          <div style="min-width:0;flex:1">
            <div class="profile-card-name${isActive ? ' is-active' : ''}">${gwDot}${esc(p.name)}${p.is_default ? ' <span style="opacity:.5">(default)</span>' : ''}${activeBadge}</div>
            ${meta.length ? `<div class="profile-card-meta">${esc(meta.join(' \u00b7 '))}</div>` : '<div class="profile-card-meta">No configuration</div>'}
          </div>
          <div class="profile-card-actions">
            ${!isActive ? `<button class="ws-action-btn" onclick="switchToProfile('${esc(p.name)}')" title="Switch to this profile">Use</button>` : ''}
            ${!p.is_default ? `<button class="ws-action-btn danger" onclick="deleteProfile('${esc(p.name)}')" title="Delete this profile">${li('x',12)}</button>` : ''}
          </div>
        </div>`;
      panel.appendChild(card);
    }
  } catch (e) {
    panel.innerHTML = `<div style="color:var(--accent);font-size:12px;padding:12px">Error: ${esc(e.message)}</div>`;
  }
}

function renderProfileDropdown(data) {
  const dd = $('profileDropdown');
  if (!dd) return;
  dd.innerHTML = '';
  const profiles = data.profiles || [];
  const active = data.active || 'default';
  for (const p of profiles) {
    const opt = document.createElement('div');
    opt.className = 'profile-opt' + (p.name === active ? ' active' : '');
    const meta = [];
    if (p.model) meta.push(p.model.split('/').pop());
    if (p.skill_count) meta.push(p.skill_count + ' skills');
    const gwDot = `<span class="profile-opt-badge ${p.gateway_running ? 'running' : 'stopped'}"></span>`;
    const checkmark = p.name === active ? ' <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="var(--link)" stroke-width="3" style="vertical-align:-1px"><polyline points="20 6 9 17 4 12"/></svg>' : '';
    opt.innerHTML = `<div class="profile-opt-name">${gwDot}${esc(p.name)}${p.is_default ? ' <span style="opacity:.5;font-weight:400">(default)</span>' : ''}${checkmark}</div>` +
      (meta.length ? `<div class="profile-opt-meta">${esc(meta.join(' \u00b7 '))}</div>` : '');
    opt.onclick = async () => {
      closeProfileDropdown();
      if (p.name === active) return;
      await switchToProfile(p.name);
    };
    dd.appendChild(opt);
  }
  // Divider + Manage link
  const div = document.createElement('div'); div.className = 'ws-divider'; dd.appendChild(div);
  const mgmt = document.createElement('div'); mgmt.className = 'profile-opt ws-manage';
  mgmt.innerHTML = `${li('settings',12)} Manage profiles`;
  mgmt.onclick = () => { closeProfileDropdown(); mobileSwitchPanel('profiles'); };
  dd.appendChild(mgmt);
}

function toggleProfileDropdown() {
  const dd = $('profileDropdown');
  if (!dd) return;
  if (dd.classList.contains('open')) { closeProfileDropdown(); return; }
  closeWsDropdown(); // close workspace dropdown if open
  if(typeof closeModelDropdown==='function') closeModelDropdown();
  api('/api/profiles').then(data => {
    renderProfileDropdown(data);
    dd.classList.add('open');
    _positionProfileDropdown();
    const chip=$('profileChip');
    if(chip) chip.classList.add('active');
  }).catch(e => { showToast('Failed to load profiles'); });
}

function closeProfileDropdown() {
  const dd = $('profileDropdown');
  if (dd) dd.classList.remove('open');
  const chip=$('profileChip');
  if(chip) chip.classList.remove('active');
}
document.addEventListener('click', e => {
  if (!e.target.closest('#profileChipWrap') && !e.target.closest('#profileDropdown')) closeProfileDropdown();
});
window.addEventListener('resize',()=>{
  const dd=$('profileDropdown');
  if(dd&&dd.classList.contains('open')) _positionProfileDropdown();
});

async function switchToProfile(name) {
  if (S.busy) { showToast('Cannot switch profiles while agent is running'); return; }

  // Determine whether the current session has any messages.
  // A session with messages is "in progress" and belongs to the current profile —
  // we must not retag it.  We'll start a fresh session for the new profile instead.
  const sessionInProgress = S.session && S.messages && S.messages.length > 0;

  try {
    const data = await api('/api/profile/switch', { method: 'POST', body: JSON.stringify({ name }) });
    S.activeProfile = data.active || name;

    // ── Model ──────────────────────────────────────────────────────────────
    localStorage.removeItem('hermes-webui-model');
    _skillsData = null;
    await populateModelDropdown();
    if (data.default_model) {
      const sel = $('modelSelect');
      const resolved = _applyModelToDropdown(data.default_model, sel);
      const modelToUse = resolved || data.default_model;
      S._pendingProfileModel = modelToUse;
      // Only patch the in-memory session model if we're NOT about to replace the session
      if (S.session && !sessionInProgress) {
        S.session.model = modelToUse;
      }
    }

    // ── Workspace ──────────────────────────────────────────────────────────
    _workspaceList = null;
    await loadWorkspaceList();
    if (data.default_workspace) {
      // Always store the profile default for new sessions
      S._profileDefaultWorkspace = data.default_workspace;

      if (S.session && !sessionInProgress) {
        // Empty session (no messages yet) — safe to update it in place
        try {
          await api('/api/session/update', { method: 'POST', body: JSON.stringify({
            session_id: S.session.session_id,
            workspace: data.default_workspace,
            model: S.session.model,
          })});
          S.session.workspace = data.default_workspace;
        } catch (_) {}
      }
    }

    // ── Session ────────────────────────────────────────────────────────────
    _showAllProfiles = false;

    if (sessionInProgress) {
      // The current session has messages and belongs to the previous profile.
      // Start a new session for the new profile so nothing gets cross-tagged.
      await newSession(false);
      await renderSessionList();
      showToast('Switched to profile: ' + name + ' — new conversation started');
    } else {
      // No messages yet — just refresh the list and topbar in place
      await renderSessionList();
      syncTopbar();
      showToast('Switched to profile: ' + name);
    }

    // ── Sidebar panels ─────────────────────────────────────────────────────
    if (_currentPanel === 'skills') await loadSkills();
    if (_currentPanel === 'memory') await loadMemory();
    if (_currentPanel === 'tasks') await loadCrons();
    if (_currentPanel === 'profiles') await loadProfilesPanel();
    if (_currentPanel === 'workspaces') await loadWorkspacesPanel();

  } catch (e) { showToast('Switch failed: ' + e.message); }
}

function toggleProfileForm() {
  const form = $('profileCreateForm');
  if (!form) return;
  form.style.display = form.style.display === 'none' ? '' : 'none';
  if (form.style.display !== 'none') {
    $('profileFormName').value = '';
    $('profileFormClone').checked = false;
    if ($('profileFormBaseUrl')) $('profileFormBaseUrl').value = '';
    if ($('profileFormApiKey')) $('profileFormApiKey').value = '';
    const errEl = $('profileFormError');
    if (errEl) errEl.style.display = 'none';
    $('profileFormName').focus();
  }
}

async function submitProfileCreate() {
  const name = ($('profileFormName').value || '').trim().toLowerCase();
  const cloneConfig = $('profileFormClone').checked;
  const errEl = $('profileFormError');
  if (!name) { errEl.textContent = 'Name is required'; errEl.style.display = ''; return; }
  if (!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(name)) { errEl.textContent = 'Lowercase letters, numbers, hyphens, underscores only'; errEl.style.display = ''; return; }
  try {
    const baseUrl = (($('profileFormBaseUrl') && $('profileFormBaseUrl').value) || '').trim();
    const apiKey = (($('profileFormApiKey') && $('profileFormApiKey').value) || '').trim();
    if (baseUrl && !/^https?:\/\//.test(baseUrl)) {
      errEl.textContent = 'Base URL must start with http:// or https://'; errEl.style.display = ''; return;
    }
    const payload = { name, clone_config: cloneConfig };
    if (baseUrl) payload.base_url = baseUrl;
    if (apiKey) payload.api_key = apiKey;
    await api('/api/profile/create', { method: 'POST', body: JSON.stringify(payload) });
    toggleProfileForm();
    await loadProfilesPanel();
    showToast('Profile created: ' + name);
  } catch (e) { errEl.textContent = e.message || 'Create failed'; errEl.style.display = ''; }
}

async function deleteProfile(name) {
  const _delProf=await showConfirmDialog({title:`Delete profile "${name}"?`,message:'This removes all config, skills, memory, and sessions for this profile.',confirmLabel:'Delete',danger:true,focusCancel:true});
  if(!_delProf) return;
  try {
    await api('/api/profile/delete', { method: 'POST', body: JSON.stringify({ name }) });
    await loadProfilesPanel();
    showToast('Profile deleted: ' + name);
  } catch (e) { showToast('Delete failed: ' + e.message); }
}

// ── Memory panel ──
async function loadMemory(force) {
  const panel = $('memoryPanel');
  try {
    const data = await api('/api/memory');
    _memoryData = data;  // cache for edit form
    const fmtTime = ts => ts ? new Date(ts*1000).toLocaleString() : '';
    panel.innerHTML = `
      <div class="memory-section">
        <div class="memory-section-title">
          <span style="display:inline-flex;align-items:center;gap:6px">${li('brain',14)} My Notes</span>
          <span class="memory-mtime">${fmtTime(data.memory_mtime)}</span>
        </div>
        ${data.memory
          ? `<div class="memory-content preview-md">${renderMd(data.memory)}</div>`
          : '<div class="memory-empty">No notes yet.</div>'}
      </div>
      <div class="memory-section">
        <div class="memory-section-title">
          <span style="display:inline-flex;align-items:center;gap:6px">${li('user',14)} User Profile</span>
          <span class="memory-mtime">${fmtTime(data.user_mtime)}</span>
        </div>
        ${data.user
          ? `<div class="memory-content preview-md">${renderMd(data.user)}</div>`
          : '<div class="memory-empty">No profile yet.</div>'}
      </div>`;
  } catch(e) { panel.innerHTML = `<div style="color:var(--accent);font-size:12px">Error: ${esc(e.message)}</div>`; }
}

// Drag and drop
const wrap=$('composerWrap');let dragCounter=0;
document.addEventListener('dragover',e=>e.preventDefault());
document.addEventListener('dragenter',e=>{e.preventDefault();if(e.dataTransfer.types.includes('Files')){dragCounter++;wrap.classList.add('drag-over');}});
document.addEventListener('dragleave',e=>{dragCounter--;if(dragCounter<=0){dragCounter=0;wrap.classList.remove('drag-over');}});
document.addEventListener('drop',e=>{e.preventDefault();dragCounter=0;wrap.classList.remove('drag-over');const files=Array.from(e.dataTransfer.files);if(files.length){addFiles(files);$('msg').focus();}});

// ── Settings panel ───────────────────────────────────────────────────────────

let _settingsDirty = false;
let _settingsThemeOnOpen = null; // track theme at open time for discard revert
let _settingsSection = 'conversation';

function switchSettingsSection(name){
  const section=(name==='preferences'||name==='system'||name==='providers'||name==='cli'||name==='knot_agui'||name==='auxiliary')?name:'conversation';
  _settingsSection=section;
  const map={conversation:'Conversation',preferences:'Preferences',providers:'Providers',cli:'Cli',knot_agui:'KnotAgui',system:'System',auxiliary:'Auxiliary'};
  ['conversation','preferences','providers','cli','knot_agui','system','auxiliary'].forEach(key=>{
    const tab=$('settingsTab'+map[key]);
    const pane=$('settingsPane'+map[key]);
    const active=key===section;
    if(tab){
      tab.classList.toggle('active',active);
      tab.setAttribute('aria-selected',active?'true':'false');
    }
    if(pane) pane.classList.toggle('active',active);
  });
  if(section==='providers') loadProvidersPanel();
  if(section==='cli') loadCliBackendsPanel();
  if(section==='auxiliary') loadAuxiliarySettings();

  if(section==='knot_agui') loadKnotAguiPanel();
}

function _syncHermesPanelSessionActions(){
  const hasSession=!!S.session;
  const visibleMessages=hasSession?(S.messages||[]).filter(m=>m&&m.role&&m.role!=='tool').length:0;
  const title=hasSession?(S.session.title||'Untitled'):'No active conversation selected.';
  const meta=$('hermesSessionMeta');
  if(meta){
    meta.textContent=hasSession
      ? `${title} · ${visibleMessages} message${visibleMessages===1?'':'s'}`
      : 'No active conversation selected.';
  }
  const setDisabled=(id,disabled)=>{
    const el=$(id);
    if(!el)return;
    el.disabled=!!disabled;
    el.classList.toggle('disabled',!!disabled);
  };
  setDisabled('btnDownload',!hasSession||visibleMessages===0);
  setDisabled('btnExportJSON',!hasSession);
  setDisabled('btnClearConvModal',!hasSession||visibleMessages===0);
}

function toggleSettings(){
  const overlay=$('settingsOverlay');
  if(!overlay) return;
  if(overlay.style.display==='none'){
    _settingsDirty = false;
    _settingsThemeOnOpen = document.documentElement.dataset.theme || 'dark';
    _settingsSection = 'conversation';
    overlay.style.display='';
    loadSettingsPanel();
  } else {
    _closeSettingsPanel();
  }
}

function _resetSettingsPanelState(){
  _settingsSection = 'conversation';
  switchSettingsSection('conversation');
  const bar=$('settingsUnsavedBar');
  if(bar) bar.style.display='none';
}

function _hideSettingsPanel(){
  const overlay=$('settingsOverlay');
  if(!overlay) return;
  _resetSettingsPanelState();
  overlay.style.display='none';
}

// Close with unsaved-changes check. If dirty, show a confirm dialog.
function _closeSettingsPanel(){
  if(!_settingsDirty){
    // Nothing changed -- revert any live preview and close
    _revertSettingsPreview();
    _hideSettingsPanel();
    return;
  }
  // Dirty -- show inline confirm bar
  _showSettingsUnsavedBar();
}

// Revert live DOM/localStorage to what they were when the panel opened
function _revertSettingsPreview(){
  if(_settingsThemeOnOpen){
    document.documentElement.dataset.theme = _settingsThemeOnOpen;
    localStorage.setItem('hermes-theme', _settingsThemeOnOpen);
  }
}

// Show the "Unsaved changes" bar inside the settings panel
function _showSettingsUnsavedBar(){
  let bar = $('settingsUnsavedBar');
  if(bar){ bar.style.display=''; return; }
  // Create it
  bar = document.createElement('div');
  bar.id = 'settingsUnsavedBar';
  bar.style.cssText = 'display:flex;align-items:center;justify-content:space-between;gap:8px;background:rgba(233,69,96,.12);border:1px solid rgba(233,69,96,.3);border-radius:8px;padding:10px 14px;margin:0 0 12px;font-size:13px;';
  bar.innerHTML = '<span style="color:var(--text)">You have unsaved changes.</span>'
    + '<span style="display:flex;gap:8px">'
    + '<button onclick="_discardSettings()" style="padding:5px 12px;border-radius:6px;border:1px solid var(--border2);background:rgba(255,255,255,.06);color:var(--muted);cursor:pointer;font-size:12px;font-weight:600">Discard</button>'
    + '<button onclick="saveSettings(true)" style="padding:5px 12px;border-radius:6px;border:none;background:var(--accent);color:#fff;cursor:pointer;font-size:12px;font-weight:600">Save</button>'
    + '</span>';
  const body = document.querySelector('.settings-main') || document.querySelector('.settings-body') || document.querySelector('.settings-panel');
  if(body) body.prepend(bar);
}

function _discardSettings(){
  _revertSettingsPreview();
  _settingsDirty = false;
  _hideSettingsPanel();
}

// Mark settings as dirty whenever anything changes
function _markSettingsDirty(){
  _settingsDirty = true;
}

async function loadSettingsPanel(){
  try{
    const settings=await api('/api/settings');
    // Apply server-persisted locale immediately (overrides localStorage boot default)
    if(settings.language && typeof setLocale==='function') setLocale(settings.language);
    // Populate model dropdown from /api/models
    const modelSel=$('settingsModel');
    if(modelSel){
      modelSel.innerHTML='';
      try{
        const models=await api('/api/models');
        for(const g of (models.groups||[])){
          const og=document.createElement('optgroup');
          og.label=g.provider;
          for(const m of g.models){
            const opt=document.createElement('option');
            opt.value=m.id;opt.textContent=m.label;
            og.appendChild(opt);
          }
          modelSel.appendChild(og);
        }
      }catch(e){}
      modelSel.value=settings.default_model||'';
      modelSel.addEventListener('change',_markSettingsDirty,{once:false});
    }
    // Send key preference
    const sendKeySel=$('settingsSendKey');
    if(sendKeySel){sendKeySel.value=settings.send_key||'enter';sendKeySel.addEventListener('change',_markSettingsDirty,{once:false});}
    // Theme preference
    const themeSel=$('settingsTheme');
    if(themeSel){themeSel.value=settings.theme||'dark';themeSel.addEventListener('change',_markSettingsDirty,{once:false});}
    // Language preference — populate from LOCALES bundle
    const langSel=$('settingsLanguage');
    if(langSel){
      langSel.innerHTML='';
      if(typeof LOCALES!=='undefined'){
        for(const [code,bundle] of Object.entries(LOCALES)){
          const opt=document.createElement('option');
          opt.value=code;opt.textContent=bundle._label||code;
          langSel.appendChild(opt);
        }
      }
      langSel.value=settings.language||'en';
      langSel.addEventListener('change',_markSettingsDirty,{once:false});
    }
    const showUsageCb=$('settingsShowTokenUsage');
    if(showUsageCb){showUsageCb.checked=!!settings.show_token_usage;showUsageCb.addEventListener('change',_markSettingsDirty,{once:false});}
    const showCliCb=$('settingsShowCliSessions');
    if(showCliCb){showCliCb.checked=!!settings.show_cli_sessions;showCliCb.addEventListener('change',_markSettingsDirty,{once:false});}
    const syncCb=$('settingsSyncInsights');
    if(syncCb){syncCb.checked=!!settings.sync_to_insights;syncCb.addEventListener('change',_markSettingsDirty,{once:false});}
    const updateCb=$('settingsCheckUpdates');
    if(updateCb){updateCb.checked=settings.check_for_updates!==false;updateCb.addEventListener('change',_markSettingsDirty,{once:false});}
    const soundCb=$('settingsSoundEnabled');
    if(soundCb){soundCb.checked=!!settings.sound_enabled;soundCb.addEventListener('change',_markSettingsDirty,{once:false});}
    const notifCb=$('settingsNotificationsEnabled');
    if(notifCb){notifCb.checked=!!settings.notifications_enabled;notifCb.addEventListener('change',_markSettingsDirty,{once:false});}
    // Bot name
    const botNameField=$('settingsBotName');
    if(botNameField){botNameField.value=settings.bot_name||'Hermes';botNameField.addEventListener('input',_markSettingsDirty,{once:false});}
    // Password field: always blank (we don't send hash back)
    const pwField=$('settingsPassword');
    if(pwField){pwField.value='';pwField.addEventListener('input',_markSettingsDirty,{once:false});}
    // Show auth buttons only when auth is active
    try{
      const authStatus=await api('/api/auth/status');
      const active=authStatus.auth_enabled;
      const signOutBtn=$('btnSignOut');
      if(signOutBtn) signOutBtn.style.display=active?'':'none';
      const disableBtn=$('btnDisableAuth');
      if(disableBtn) disableBtn.style.display=active?'':'none';
    }catch(e){}
    _syncHermesPanelSessionActions();
    switchSettingsSection(_settingsSection);
  }catch(e){
    showToast(t('settings_load_failed')+e.message);
  }
}

async function saveSettings(andClose){
  const model=($('settingsModel')||{}).value;
  const sendKey=($('settingsSendKey')||{}).value;
  const showTokenUsage=!!($('settingsShowTokenUsage')||{}).checked;
  const showCliSessions=!!($('settingsShowCliSessions')||{}).checked;
  const pw=($('settingsPassword')||{}).value;
  const theme=($('settingsTheme')||{}).value||'dark';
  const language=($('settingsLanguage')||{}).value||'en';
  const body={};
  if(model) body.default_model=model;

  if(sendKey) body.send_key=sendKey;
  body.theme=theme;
  body.language=language;
  body.show_token_usage=showTokenUsage;
  body.show_cli_sessions=showCliSessions;
  body.sync_to_insights=!!($('settingsSyncInsights')||{}).checked;
  body.check_for_updates=!!($('settingsCheckUpdates')||{}).checked;
  body.sound_enabled=!!($('settingsSoundEnabled')||{}).checked;
  body.notifications_enabled=!!($('settingsNotificationsEnabled')||{}).checked;
  const botName=(($('settingsBotName')||{}).value||'').trim();
  body.bot_name=botName||'Hermes';
  // Password: only act if the field has content; blank = leave auth unchanged
  if(pw && pw.trim()){
    try{
      await api('/api/settings',{method:'POST',body:JSON.stringify({...body,_set_password:pw.trim()})});
      window._sendKey=sendKey||'enter';
      window._showTokenUsage=showTokenUsage;
      window._soundEnabled=body.sound_enabled;
      window._notificationsEnabled=body.notifications_enabled;
      if(typeof setLocale==='function') setLocale(language);
      if(typeof applyLocaleToDOM==='function') applyLocaleToDOM();
      showToast(t('settings_saved_pw'));
      _settingsDirty=false; _settingsThemeOnOpen=theme;
      _hideSettingsPanel();
      return;
    }catch(e){showToast('Save failed: '+e.message);return;}
  }
  try{
    await api('/api/settings',{method:'POST',body:JSON.stringify(body)});
    window._sendKey=sendKey||'enter';
    window._showTokenUsage=showTokenUsage;
    window._showCliSessions=showCliSessions;
    window._soundEnabled=body.sound_enabled;
    window._notificationsEnabled=body.notifications_enabled;
    window._botName=body.bot_name;
    if(typeof applyBotName==='function') applyBotName();
    if(typeof setLocale==='function') setLocale(language);
    if(typeof applyLocaleToDOM==='function') applyLocaleToDOM();
    // Restart gateway SSE when agent session setting changes
    if(typeof startGatewaySSE==='function'){if(showCliSessions)startGatewaySSE();else if(typeof stopGatewaySSE==='function')stopGatewaySSE();}
    _settingsDirty=false; _settingsThemeOnOpen=theme;
    const bar=$('settingsUnsavedBar'); if(bar) bar.style.display='none';
    renderMessages();
    if(typeof syncTopbar==='function') syncTopbar();
    if(typeof renderSessionList==='function') renderSessionList();
    showToast(t('settings_saved'));
    _hideSettingsPanel();
  }catch(e){
    showToast(t('settings_save_failed')+e.message);
  }
}

async function signOut(){
  try{
    await api('/api/auth/logout',{method:'POST',body:'{}'});
    window.location.href='/login';
  }catch(e){
    showToast('Sign out failed: '+e.message);
  }
}

async function disableAuth(){
  const _disAuth=await showConfirmDialog({title:'Disable password protection',message:'Anyone will be able to access this instance.',confirmLabel:'Disable',danger:true,focusCancel:true});
  if(!_disAuth) return;
  try{
    await api('/api/settings',{method:'POST',body:JSON.stringify({_clear_password:true})});
    showToast('Auth disabled — password protection removed');
    // Hide both auth buttons since auth is now off
    const disableBtn=$('btnDisableAuth');
    if(disableBtn) disableBtn.style.display='none';
    const signOutBtn=$('btnSignOut');
    if(signOutBtn) signOutBtn.style.display='none';
  }catch(e){
    showToast('Failed to disable auth: '+e.message);
  }
}

// ── Knot AG-UI panel ──────────────────────────────────────────────────────────
async function loadKnotAguiPanel(){
  try{
    const settings=await api('/api/settings');
    const tokenField=$('settingsKnotAguiToken');
    const userField=$('settingsKnotAguiUser');
    const agentsField=$('settingsKnotAguiAgents');
    const mcpModelField=$('settingsKnotAguiMcpModel');
    if(tokenField){
      tokenField.value=(settings.knot_agui_token&&settings.knot_agui_token!=='●●●●')?settings.knot_agui_token:'';
      tokenField.placeholder=settings.knot_agui_token==='●●●●'?'已配置（留空保持不变）':'粘贴你的 Knot API Token';
      tokenField.addEventListener('input',_markSettingsDirty,{once:false});
    }
    if(userField){userField.value=settings.knot_agui_user||'';userField.addEventListener('input',_markSettingsDirty,{once:false});}
    if(agentsField){agentsField.value=settings.knot_agui_agents||'';agentsField.addEventListener('input',_markSettingsDirty,{once:false});}
    if(mcpModelField){mcpModelField.value=settings.knot_agui_mcp_model||'';mcpModelField.addEventListener('input',_markSettingsDirty,{once:false});}
    
    // ── Auto-check knot-cli status ─────────────────────
    const workspace = (typeof S !== 'undefined' && S.session && S.session.workspace) || '.';
    try {
      const status = await api('/api/knot-cli/status', {
        method: 'POST',
        body: JSON.stringify({ workspace: workspace })
      });
      if (status.ok) {
        const statusDiv = document.getElementById('knotCliStatus');
        if (statusDiv) {
          if (status.installed) {
            let statusHtml = `
              <div style="color:var(--green);font-size:12px;margin-top:8px">
                ✓ knot-cli 已安装: ${status.cli_path}
              </div>`;
            
            if (status.connection_uuid) {
              statusHtml += `
                <div style="color:var(--muted);font-size:11px;font-family:monospace;margin-top:4px;">
                  connection_uuid: ${status.connection_uuid}
                </div>`;
            } else {
              statusHtml += `
                <div style="color:var(--accent);font-size:12px;">
                  ⚠ 当前工作区未注册
                </div>`;
              // Show auto-register button if token is configured
              if (settings.knot_agui_token) {
                statusHtml += `
                  <button onclick="autoRegisterKnotWorkspace()" style="margin-top:6px;padding:4px 12px;font-size:11px;cursor:pointer">
                    注册当前工作区
                  </button>`;
              }
            }
            statusDiv.innerHTML = statusHtml;
          } else {
            // knot-cli 未安装
            let statusHtml = `
              <div style="color:var(--accent);font-size:12px;margin-top:8px">
                ⚠ knot-cli 未安装
              </div>`;
            
            // Check Git Bash availability
            if (!status.git_bash_available) {
              statusHtml += `
                <div style="color:var(--red,#e74c3c);font-size:12px;margin-top:4px;padding:8px;border:1px solid var(--border2);border-radius:6px;background:rgba(231,76,60,0.05)">
                  ⚠ 安装 knot-cli 需要 Git Bash<br>
                  <span style="font-size:11px;color:var(--muted)">
                    请先安装 Git for Windows：
                    <a href="https://git-scm.com/download/win" target="_blank" style="color:var(--link,#3498db)">
                      https://git-scm.com/download/win
                    </a>
                  </span>
                  <br><br>
                  <span style="font-size:11px;color:var(--muted)">安装 Git 后请刷新此页面重试。</span>
                </div>`;
            }
            
            if (settings.knot_agui_token) {
              if (status.git_bash_available) {
                statusHtml += `
                  <button onclick="autoInstallKnotCli()" style="margin-top:8px;padding:6px 14px;font-size:12px;cursor:pointer">
                    🚀 自动安装 knot-cli
                  </button>`;
              }
            } else {
              statusHtml += `
                <div style="color:var(--muted);font-size:11px;margin-top:4px">
                  请先配置 Token 后再安装
                </div>`;
            }
            statusDiv.innerHTML = statusHtml;
          }
        }
      }
    } catch(e) {
      console.warn('Failed to check knot-cli status:', e);
      const statusDiv = document.getElementById('knotCliStatus');
      if(statusDiv) statusDiv.innerHTML = `<div style="color:var(--muted);font-size:11px">无法检查 knot-cli 状态</div>`;
    }
  }catch(e){
    showToast('加载 Knot AG-UI 配置失败: '+e.message);
  }
}

// ── Auto-install knot-cli ─────────────────────────────
async function autoInstallKnotCli() {
  try {
    const settings = await api('/api/settings');
    if (!settings.knot_agui_token || settings.knot_agui_token === '●●●●') {
      showToast('请先配置 Knot API Token');
      return;
    }
    
    const workspace = (typeof S !== 'undefined' && S.session && S.session.workspace) || '.';
    
    // Update status UI to show progress
    const statusDiv = document.getElementById('knotCliStatus');
    if (statusDiv) {
      statusDiv.innerHTML = `
        <div style="color:var(--accent);font-size:12px;margin-top:8px">
          ⏳ 正在安装 knot-cli，请稍候...
        </div>`;
    }
    
    const result = await api('/api/knot-cli/install', {
      method: 'POST',
      body: JSON.stringify({
        workspace: workspace,
        token: settings.knot_agui_token
      })
    });
    
    if (result.ok) {
      showToast('knot-cli 安装成功！');
      // Show connection_uuid immediately
      if (statusDiv) {
        let html = `
          <div style="color:var(--green);font-size:12px;margin-top:8px">
            ✓ knot-cli 安装成功: ${result.cli_path}
          </div>`;
        if (result.connection_uuid) {
          html += `
            <div style="color:var(--muted);font-size:11px;font-family:monospace;margin-top:4px;">
              connection_uuid: ${result.connection_uuid}
            </div>`;
        } else {
          html += `
            <div style="color:var(--accent);font-size:12px;">
              ⚠ 安装成功，但工作区注册尚未完成
            </div>
            <button onclick="autoRegisterKnotWorkspace()" style="margin-top:6px;padding:4px 12px;font-size:11px;cursor:pointer">
              重试注册工作区
            </button>`;
        }
        statusDiv.innerHTML = html;
      }
    } else {
      // Check if it's a Git Bash missing error
      if (result.need_git_bash) {
        if (statusDiv) {
          statusDiv.innerHTML = `
            <div style="color:var(--red,#e74c3c);font-size:12px;margin-top:8px;padding:10px;border:1px solid var(--border2);border-radius:6px;background:rgba(231,76,60,0.05)">
              ⚠ 安装 knot-cli 需要 Git Bash<br><br>
              <span style="font-size:11px;color:var(--muted)">
                请先安装 Git for Windows：
                <a href="${result.download_url || 'https://git-scm.com/download/win'}" target="_blank" style="color:var(--link,#3498db)">
                  ${result.download_url || 'https://git-scm.com/download/win'}
                </a>
              </span>
              <br><br>
              <span style="font-size:11px;color:var(--muted)">安装 Git 后请刷新此页面重试。</span>
            </div>`;
        }
        showToast('需要先安装 Git Bash');
      } else {
        showToast('knot-cli 安装失败: ' + (result.error || '未知错误'));
        if (statusDiv) {
          statusDiv.innerHTML = `
            <div style="color:var(--red,#e74c3c);font-size:12px;margin-top:8px">
              ✗ 安装失败: ${result.error || '未知错误'}
            </div>
            <button onclick="autoInstallKnotCli()" style="margin-top:6px;padding:4px 12px;font-size:11px;cursor:pointer">
              重试安装
            </button>`;
        }
      }
    }
  } catch(e) {
    showToast('安装失败: ' + e.message);
    const statusDiv = document.getElementById('knotCliStatus');
    if (statusDiv) {
      statusDiv.innerHTML = `
        <div style="color:var(--red,#e74c3c);font-size:12px;margin-top:8px">
          ✗ 安装异常: ${e.message}
        </div>
        <button onclick="autoInstallKnotCli()" style="margin-top:6px;padding:4px 12px;font-size:11px;cursor:pointer">
          重试安装
        </button>`;
    }
  }
}

// ── Auto-register workspace in knot-cli ─────────────────────────────
async function autoRegisterKnotWorkspace() {
  try {
    const workspace = (typeof S !== 'undefined' && S.session && S.session.workspace) || '.';
    const statusDiv = document.getElementById('knotCliStatus');
    
    if (statusDiv) {
      statusDiv.innerHTML = `
        <div style="color:var(--accent);font-size:12px;margin-top:8px">
          ⏳ 正在注册工作区...
        </div>`;
    }
    
    const result = await api('/api/knot-cli/workspace/create', {
      method: 'POST',
      body: JSON.stringify({ workspace: workspace })
    });
    
    if (result.ok && result.connection_uuid) {
      showToast('工作区注册成功');
      if (statusDiv) {
        statusDiv.innerHTML = `
          <div style="color:var(--green);font-size:12px;margin-top:8px">
            ✓ knot-cli 已安装: ${result.cli_path || ''}
          </div>
          <div style="color:var(--muted);font-size:11px;font-family:monospace;margin-top:4px;">
            connection_uuid: ${result.connection_uuid}
          </div>`;
      }
    } else {
      showToast('工作区注册失败: ' + (result.error || '未获取到 connection_uuid'));
      // Reload panel for fresh status
      loadKnotAguiPanel();
    }
  } catch(e) {
    showToast('注册失败: ' + e.message);
    loadKnotAguiPanel();
  }
}

async function saveKnotAguiSettings(){
  const tokenField=$('settingsKnotAguiToken');
  const userField=$('settingsKnotAguiUser');
  const agentsField=$('settingsKnotAguiAgents');
  const mcpModelField=$('settingsKnotAguiMcpModel');
  const body={};
  const tokenVal=(tokenField||{}).value||'';
  const userVal=(userField||{}).value||'';
  const agentsVal=(agentsField||{}).value||'';
  const mcpModelVal=(mcpModelField||{}).value||'';
  // Validate agents JSON
  if(agentsVal.trim()){
    try{
      const parsed=JSON.parse(agentsVal);
      if(!Array.isArray(parsed)){
        showToast('智能体列表必须是 JSON 数组格式');return;
      }
      for(const a of parsed){
        if(!a.id){showToast('每个智能体必须包含 id 字段');return;}
      }
    }catch(e){
      showToast('智能体列表 JSON 格式错误: '+e.message);return;
    }
  }
  // Only send token if user typed something new (not placeholder)
  const isNewToken = tokenVal && tokenVal !== '●●●●';
  if(isNewToken) body.knot_agui_token=tokenVal;
  body.knot_agui_user=userVal;
  body.knot_agui_agents=agentsVal;
  body.knot_agui_mcp_model=mcpModelVal;
  try{
    await api('/api/settings',{method:'POST',body:JSON.stringify(body)});
    showToast('Knot AG-UI 配置已保存');
    _settingsDirty=false;
    const bar=$('settingsUnsavedBar');if(bar) bar.style.display='none';
    
    // ★ If a new token was just configured, auto-install knot-cli
    if(isNewToken){
      // Check current knot-cli status and auto-install if not installed
      const workspace = (typeof S !== 'undefined' && S.session && S.session.workspace) || '.';
      try {
        const status = await api('/api/knot-cli/status', {
          method: 'POST',
          body: JSON.stringify({ workspace: workspace })
        });
        if (status.ok && !status.installed) {
          // Not installed — trigger auto-install
          showToast('Token 已保存，正在自动安装 knot-cli...');
          setTimeout(() => autoInstallKnotCli(), 500);
        } else if (status.ok && status.installed && !status.connection_uuid) {
          // Installed but workspace not registered — auto-register
          showToast('Token 已保存，正在注册工作区...');
          setTimeout(() => autoRegisterKnotWorkspace(), 500);
        } else {
          // Already fully configured, just reload panel
          loadKnotAguiPanel();
        }
      } catch(_e) {
        // Fallback: just reload panel
        loadKnotAguiPanel();
      }
    } else {
      // Reload panel to reflect masked token
      loadKnotAguiPanel();
    }
    
    // ★ 刷新模型下拉框，使 Knot AG-UI 智能体立即出现在聊天框模型选择中
    if(typeof populateModelDropdown==='function'){
      try{ await populateModelDropdown(); }catch(_){}
    }
    // Also refresh the settings model dropdown
    if(typeof loadSettingsPanel==='function') loadSettingsPanel();
  }catch(e){
    showToast('保存失败: '+e.message);
  }
}

// ── Providers panel ──────────────────────────────────────────────────────────
let _providersData = [];
let _builtInProviders = [];

async function loadProvidersPanel(){
  const list = $('providersList');
  if(!list) return;
  try{
    const data = await api('/api/providers');
    _providersData = data.providers || [];
    _builtInProviders = data.built_in_providers || [];
    renderProvidersList();
    renderBuiltInProviders();
    renderConfiguredProviders();
  }catch(e){
    if(list) list.innerHTML = '<div style="padding:8px;color:var(--accent);font-size:12px">Failed to load providers.</div>';
  }
}

function renderBuiltInProviders(){
  const container = $('builtInProvidersList');
  if(!container) return;
  if(!_builtInProviders.length){
    container.innerHTML = '<div style="font-size:12px;color:var(--muted)">No built-in providers available.</div>';
    return;
  }
  container.innerHTML = '';
  _builtInProviders.forEach(p=>{
    const chip = document.createElement('span');
    chip.style.cssText = 'display:inline-block;padding:4px 10px;border-radius:999px;font-size:12px;background:rgba(255,255,255,.06);color:var(--text);border:1px solid var(--border2);white-space:nowrap';
    chip.textContent = p.name || p.id;
    chip.title = p.id;
    container.appendChild(chip);
  });
}

function renderConfiguredProviders(){
  const container = $('configuredProvidersList');
  if(!container) return;
  if(!_providersData.length){
    container.innerHTML = '<div style="font-size:12px;color:var(--muted)">No custom providers configured yet.</div>';
    return;
  }
  container.innerHTML = '';
  _providersData.forEach(p=>{
    const chip = document.createElement('span');
    chip.style.cssText = 'display:inline-flex;align-items:center;gap:4px;padding:4px 10px;border-radius:999px;font-size:12px;background:rgba(80,200,120,.12);color:#50c878;border:1px solid rgba(80,200,120,.25);white-space:nowrap';
    chip.innerHTML = `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg> ${_esc(p.name || 'Unnamed')}`;
    chip.title = p.base_url || '';
    container.appendChild(chip);
  });
}

function renderProvidersList(){
  const list = $('providersList');
  if(!list) return;
  if(!_providersData.length){
    list.innerHTML = '<div style="padding:8px;color:var(--muted);font-size:12px">No custom providers configured yet.</div>';
    return;
  }
  list.innerHTML = '';
  _providersData.forEach((p, idx)=>{
    const row = document.createElement('div');
    row.style.cssText = 'border:1px solid var(--border2);border-radius:8px;padding:10px;margin-bottom:8px;background:rgba(255,255,255,.03)';
    row.innerHTML = `
      <div style="display:flex;gap:6px;margin-bottom:6px">
        <input type="text" data-idx="${idx}" data-field="name" placeholder="Name (e.g. ollama)" value="${_esc(p.name||'')}" style="flex:1;padding:6px;background:var(--code-bg);color:var(--text);border:1px solid var(--border2);border-radius:6px;font-size:12px">
        <button onclick="removeProviderRow(${idx})" title="Remove" style="padding:4px 8px;border-radius:6px;border:1px solid rgba(233,69,96,.3);background:rgba(233,69,96,.1);color:var(--accent);cursor:pointer;font-size:12px">×</button>
      </div>
      <input type="text" data-idx="${idx}" data-field="base_url" placeholder="Base URL (e.g. http://localhost:11434/v1)" value="${_esc(p.base_url||'')}" style="width:100%;padding:6px;background:var(--code-bg);color:var(--text);border:1px solid var(--border2);border-radius:6px;font-size:12px;margin-bottom:6px">
      <div style="display:flex;gap:6px">
        <input type="text" data-idx="${idx}" data-field="model" placeholder="Default model (optional)" value="${_esc(p.model||'')}" style="flex:1;padding:6px;background:var(--code-bg);color:var(--text);border:1px solid var(--border2);border-radius:6px;font-size:12px">
        <input type="text" data-idx="${idx}" data-field="api_mode" placeholder="API mode (optional)" value="${_esc(p.api_mode||'')}" style="flex:1;padding:6px;background:var(--code-bg);color:var(--text);border:1px solid var(--border2);border-radius:6px;font-size:12px">
      </div>
      <input type="password" data-idx="${idx}" data-field="api_key" placeholder="API key (optional)" value="${_esc(p.api_key||'')}" style="width:100%;padding:6px;background:var(--code-bg);color:var(--text);border:1px solid var(--border2);border-radius:6px;font-size:12px;margin-top:6px">
    `;
    list.appendChild(row);
  });
  // Attach change listeners to mark dirty
  list.querySelectorAll('input').forEach(inp=>{
    inp.addEventListener('input', ()=>{ _markSettingsDirty(); });
  });
}

function _esc(s){ return s.replace(/[&<>"']/g, c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }

function addProviderRow(){
  _providersData.push({name:'',base_url:'',model:'',api_mode:'',api_key:''});
  renderProvidersList();
  _markSettingsDirty();
}

function removeProviderRow(idx){
  _providersData.splice(idx,1);
  renderProvidersList();
  _markSettingsDirty();
}

function _collectProvidersFromDOM(){
  const list = $('providersList');
  if(!list) return _providersData;
  const rows = list.querySelectorAll('[data-idx]');
  const map = new Map();
  rows.forEach(el=>{
    const idx = parseInt(el.dataset.idx,10);
    const field = el.dataset.field;
    if(!map.has(idx)) map.set(idx,{});
    map.get(idx)[field] = el.value.trim();
  });
  const collected = [];
  map.forEach((obj)=>{
    if(obj.name && obj.base_url) collected.push(obj);
  });
  return collected;
}

async function saveProviders(){
  const providers = _collectProvidersFromDOM();
  const errEl = $('providersSaveError');
  if(errEl) errEl.style.display='none';
  try{
    const result = await api('/api/providers/save',{method:'POST',body:JSON.stringify({providers})});
    if(result.ok){
      _providersData = result.providers || providers;
      // Close provider input forms after successful save
      const list = $('providersList');
      if(list) list.innerHTML = '<div style="padding:8px;color:var(--muted);font-size:12px">Providers saved. Click <b>+ Add Provider</b> to add more.</div>';
      renderConfiguredProviders();
      _settingsDirty = false;
      showToast('Providers saved');
      // Refresh model dropdown so new providers appear immediately
      if(typeof populateModelDropdown==='function') await populateModelDropdown();
    }else{
      throw new Error(result.error||'Save failed');
    }
  }catch(e){
    if(errEl){ errEl.textContent='Save failed: '+e.message; errEl.style.display=''; }
    showToast('Save failed: '+e.message);
  }
}

// ── Local CLI Backends (OpenClaw-style) ─────────────────────────────────────
// 每个后端是一个可编辑卡片；保存后会持久化到 config.yaml 的 cli_backends.
let _cliBackendsData = [];  // [{name, command, args, input, output, modelArg, modelAliases, sessionMode, sessionArg, resumeArgs, resumeOutput, imageArg, systemPromptArg, systemPromptWhen, workdir, env, enabled, description}]

function _cliBlankBackend(){
  return {
    name: '', command: '', args: [], input: 'stdin', output: 'text',
    modelArg: '', modelAliases: {}, systemPromptArg: '', systemPromptFileArg: '', systemPromptMode: '', userPromptArg: '', sessionMode: 'none', sessionArg: '',
    resumeArgs: [], resumeOutput: '', imageArg: '', systemPromptWhen: '',
    workdir: '', env: {}, enabled: true, description: '',
    _isNew: true,
  };
}

async function loadCliBackendsPanel(){
  const list = $('cliBackendsList');
  if(!list) return;
  list.innerHTML = '<div style="padding:8px;color:var(--muted);font-size:12px">加载中...</div>';
  try{
    const data = await api('/api/cli/backends');
    _cliBackendsData = Array.isArray(data.backends) ? data.backends : [];
    renderCliBackendsList();
  }catch(e){
    list.innerHTML = '<div style="padding:8px;color:var(--accent);font-size:12px">加载 CLI 后端配置失败: '+esc(e.message)+'</div>';
  }
}

function addCliBackendRow(preset){
  const base = _cliBlankBackend();
  if(preset === 'knot-cli'){
    Object.assign(base, {
      name: 'knot-cli',
      command: 'knot-cli',
      args: ['chat'],
      input: 'stdin',
      output: 'text',
      modelArg: '-m',
      modelAliases: { 'glm-5.1': 'glm-5.1' },
      systemPromptArg: '',                       // knot-cli 没有 append-system-prompt 参数
      systemPromptFileArg: '--user-rules',       // system 写入临时文件，走 --user-rules
      systemPromptMode: 'file',                  // 文件模式 (配合 useShellWrapper 稳定工作)
      userPromptArg: '-p',                       // 用户消息通过 -p 传入
      sessionMode: 'always',
      sessionArg: '--sessionId',
      useShellWrapper: true,                     // Windows 必须用 cmd.exe /c 包装
      description: 'Knot CLI (chat + -m + -p + --sessionId + --user-rules, cmd.exe wrapped)',
    });
  } else if(preset === 'claude-code'){
    Object.assign(base, {
      name: 'claude-code',
      command: 'claude',
      args: ['-p'],                       // Claude Code 的 -p 是 "print mode (non-interactive)"
      input: 'stdin',
      output: 'text',
      modelArg: '--model',
      modelAliases: { 'sonnet': 'sonnet', 'opus': 'opus', 'haiku': 'haiku' },
      systemPromptArg: '--append-system-prompt',
      systemPromptMode: 'arg',
      userPromptArg: '',                  // 用户消息从 stdin 进
      sessionMode: 'none',
      sessionArg: '',
      description: 'Claude Code CLI',
    });
  }
  _cliBackendsData.push(base);
  renderCliBackendsList();
}

function _cliArgsArrToString(arr){
  if(!Array.isArray(arr)) return '';
  // 用空格分隔，带空格的参数加引号
  return arr.map(x => {
    const s = String(x);
    return /\s/.test(s) ? JSON.stringify(s) : s;
  }).join(' ');
}

function _cliMapToText(m){
  if(!m || typeof m !== 'object') return '';
  return Object.entries(m).map(([k,v]) => k+'='+v).join('\n');
}

function _cliTextToMap(text){
  // 文本格式：
  //   alias = real_id   (完整映射)
  //   alias: real_id    (兼容冒号)
  //   alias             (简写：等号两侧相同)
  //   # 注释 / 空行被忽略
  const out = {};
  if(!text) return out;
  for(const line of text.split(/\r?\n/)){
    const t = line.trim();
    if(!t || t.startsWith('#')) continue;
    // 优先用 =，其次冒号（空格包围的才算分隔符，避免 http:// 被误拆）
    let sep = -1;
    let sepLen = 1;
    const eqIdx = t.indexOf('=');
    if(eqIdx > 0){
      sep = eqIdx;
    } else {
      // 冒号分隔：仅当整个 token 里只有一个 `:` 且两侧都有内容（排除 `http://...` 这种）
      const colonMatch = t.match(/^([^\s:]+)\s*:\s+(.+)$/);
      if(colonMatch){
        out[colonMatch[1].trim()] = colonMatch[2].trim();
        continue;
      }
    }
    if(sep > 0){
      const alias = t.slice(0, sep).trim();
      const real = t.slice(sep + sepLen).trim();
      if(!alias) continue;
      out[alias] = real || alias;   // 若右侧为空，等价于 alias 本身
    } else {
      // 无分隔符 → 简写：alias 即 real_id
      // 允许空格分隔的第一个 token（更宽松）
      const tok = t.split(/\s+/)[0];
      if(tok) out[tok] = tok;
    }
  }
  return out;
}

function renderCliBackendsList(){
  const list = $('cliBackendsList');
  if(!list) return;
  list.innerHTML = '';
  if(!_cliBackendsData.length){
    list.innerHTML = '<div style="padding:10px;background:rgba(255,255,255,.02);border:1px dashed var(--border);border-radius:8px;color:var(--muted);font-size:12px;text-align:center">尚未配置任何本地 CLI 后端。点击下方 <b>+ 新增</b> 开始。</div>';
    return;
  }
  for(let i = 0; i < _cliBackendsData.length; i++){
    const b = _cliBackendsData[i];
    const card = document.createElement('div');
    card.className = 'cli-backend-card';
    card.style.cssText = 'border:1px solid var(--border);border-radius:8px;padding:12px;background:rgba(255,255,255,.02)';
    card.dataset.idx = String(i);
    card.innerHTML = `
      <div style="display:flex;align-items:center;gap:8px;margin-bottom:8px">
        <input type="text" data-k="name" value="${esc(b.name||'')}" placeholder="backend name (如 local-llama)" style="flex:1;padding:6px 8px;background:var(--code-bg);color:var(--text);border:1px solid var(--border2);border-radius:6px;font-size:12px;font-family:ui-monospace,monospace" ${b._isNew?'':'readonly title="名称保存后不可改（请删除后重建）"'}>
        <label style="display:inline-flex;align-items:center;gap:4px;font-size:11px;color:var(--muted)">
          <input type="checkbox" data-k="enabled" ${b.enabled!==false?'checked':''}> 启用
        </label>
      </div>
      <div style="display:grid;grid-template-columns:120px 1fr;gap:6px 10px;font-size:12px">
        <label style="color:var(--muted);align-self:center">命令 *</label>
        <input type="text" data-k="command" value="${esc(b.command||'')}" placeholder="claude / /usr/local/bin/llama-cli" style="padding:6px 8px;background:var(--code-bg);color:var(--text);border:1px solid var(--border2);border-radius:6px;font-family:ui-monospace,monospace;font-size:11.5px">

        <label style="color:var(--muted);align-self:center">启动参数</label>
        <input type="text" data-k="args" value="${esc(_cliArgsArrToString(b.args))}" placeholder='-p --output-format json' style="padding:6px 8px;background:var(--code-bg);color:var(--text);border:1px solid var(--border2);border-radius:6px;font-family:ui-monospace,monospace;font-size:11.5px">

        <label style="color:var(--muted);align-self:center">工作目录</label>
        <input type="text" data-k="workdir" value="${esc(b.workdir||'')}" placeholder="留空使用当前目录" style="padding:6px 8px;background:var(--code-bg);color:var(--text);border:1px solid var(--border2);border-radius:6px;font-family:ui-monospace,monospace;font-size:11.5px">

        <label style="color:var(--muted);align-self:center">输入模式</label>
        <select data-k="input" style="padding:6px 8px;background:var(--code-bg);color:var(--text);border:1px solid var(--border2);border-radius:6px;font-size:12px">
          <option value="stdin" ${(b.input||'stdin')==='stdin'?'selected':''}>stdin (提示词从标准输入)</option>
          <option value="args" ${b.input==='args'?'selected':''}>args (提示词作为参数)</option>
        </select>

        <label style="color:var(--muted);align-self:center">输出格式</label>
        <select data-k="output" style="padding:6px 8px;background:var(--code-bg);color:var(--text);border:1px solid var(--border2);border-radius:6px;font-size:12px">
          <option value="text" ${(b.output||'text')==='text'?'selected':''}>text (纯文本)</option>
          <option value="json" ${b.output==='json'?'selected':''}>json</option>
          <option value="jsonl" ${b.output==='jsonl'?'selected':''}>jsonl (流式 JSON)</option>
        </select>

        <label style="color:var(--muted);align-self:center">modelArg</label>
        <input type="text" data-k="modelArg" value="${esc(b.modelArg||'')}" placeholder="--model / -m" style="padding:6px 8px;background:var(--code-bg);color:var(--text);border:1px solid var(--border2);border-radius:6px;font-family:ui-monospace,monospace;font-size:11.5px">

        <label style="color:var(--muted);align-self:center">systemPromptArg</label>
        <input type="text" data-k="systemPromptArg" value="${esc(b.systemPromptArg||'')}" placeholder="--append-system-prompt (留空则按 systemPromptMode 处理)" style="padding:6px 8px;background:var(--code-bg);color:var(--text);border:1px solid var(--border2);border-radius:6px;font-family:ui-monospace,monospace;font-size:11.5px">

        <label style="color:var(--muted);align-self:center" title="若 CLI 只接受文件路径作为 system prompt (如 knot-cli 的 --user-rules)">systemPromptFileArg</label>
        <input type="text" data-k="systemPromptFileArg" value="${esc(b.systemPromptFileArg||'')}" placeholder="--user-rules / --system-file (配合 systemPromptMode=file)" style="padding:6px 8px;background:var(--code-bg);color:var(--text);border:1px solid var(--border2);border-radius:6px;font-family:ui-monospace,monospace;font-size:11.5px">

        <label style="color:var(--muted);align-self:center" title="当 CLI 不支持系统提示参数时，系统提示如何处理">systemPromptMode</label>
        <select data-k="systemPromptMode" style="padding:6px 8px;background:var(--code-bg);color:var(--text);border:1px solid var(--border2);border-radius:6px;font-size:12px">
          <option value="" ${!b.systemPromptMode?'selected':''}>自动 (有 systemPromptArg 则作参数，否则拼到用户消息前)</option>
          <option value="arg" ${b.systemPromptMode==='arg'?'selected':''}>arg (强制作为参数, 需要 systemPromptArg)</option>
          <option value="file" ${b.systemPromptMode==='file'?'selected':''}>file (写入临时文件, 需要 systemPromptFileArg)</option>
          <option value="prepend" ${b.systemPromptMode==='prepend'?'selected':''}>prepend (拼到用户消息前)</option>
          <option value="skip" ${b.systemPromptMode==='skip'?'selected':''}>skip (丢弃系统提示)</option>
        </select>

        <label style="color:var(--muted);align-self:center" title="用户消息作为参数传入时使用的参数名，如 knot-cli 的 -p">userPromptArg</label>
        <input type="text" data-k="userPromptArg" value="${esc(b.userPromptArg||'')}" placeholder="-p / --prompt (留空则按 输入模式 处理)" style="padding:6px 8px;background:var(--code-bg);color:var(--text);border:1px solid var(--border2);border-radius:6px;font-family:ui-monospace,monospace;font-size:11.5px">

        <label style="color:var(--muted);align-self:center" title="Windows 下用 cmd.exe /c 包装启动，用于绕过某些 CLI (如 knot-cli) 对父进程的检测">useShellWrapper</label>
        <select data-k="useShellWrapper" style="padding:6px 8px;background:var(--code-bg);color:var(--text);border:1px solid var(--border2);border-radius:6px;font-size:12px">
          <option value="false" ${!b.useShellWrapper?'selected':''}>否 (直接启动)</option>
          <option value="true" ${b.useShellWrapper?'selected':''}>是 (cmd.exe /c 包装, Windows 推荐给 knot-cli)</option>
        </select>

        <label style="color:var(--muted);align-self:center">sessionMode</label>
        <select data-k="sessionMode" style="padding:6px 8px;background:var(--code-bg);color:var(--text);border:1px solid var(--border2);border-radius:6px;font-size:12px">
          <option value="none" ${(b.sessionMode||'none')==='none'?'selected':''}>none (无会话)</option>
          <option value="always" ${b.sessionMode==='always'?'selected':''}>always (总是带 session)</option>
          <option value="existing" ${b.sessionMode==='existing'?'selected':''}>existing (仅恢复已有)</option>
        </select>

        <label style="color:var(--muted);align-self:center">sessionArg</label>
        <input type="text" data-k="sessionArg" value="${esc(b.sessionArg||'')}" placeholder="--session-id" style="padding:6px 8px;background:var(--code-bg);color:var(--text);border:1px solid var(--border2);border-radius:6px;font-family:ui-monospace,monospace;font-size:11.5px">

        <label style="color:var(--muted);align-self:center">resumeArgs</label>
        <input type="text" data-k="resumeArgs" value="${esc(_cliArgsArrToString(b.resumeArgs))}" placeholder='--resume {sessionId}' style="padding:6px 8px;background:var(--code-bg);color:var(--text);border:1px solid var(--border2);border-radius:6px;font-family:ui-monospace,monospace;font-size:11.5px">

        <label style="color:var(--muted);align-self:center">imageArg</label>
        <input type="text" data-k="imageArg" value="${esc(b.imageArg||'')}" placeholder="--image (留空表示不支持)" style="padding:6px 8px;background:var(--code-bg);color:var(--text);border:1px solid var(--border2);border-radius:6px;font-family:ui-monospace,monospace;font-size:11.5px">

        <label style="color:var(--muted);align-self:center">listModelsArg</label>
        <input type="text" data-k="listModelsArg" value="${esc(b.listModelsArg||'')}" placeholder="--list-models / models list (留空则跳过自动探测)" style="padding:6px 8px;background:var(--code-bg);color:var(--text);border:1px solid var(--border2);border-radius:6px;font-family:ui-monospace,monospace;font-size:11.5px">

        <label style="color:var(--muted);align-self:start;padding-top:6px">可用模型</label>
        <div style="display:flex;flex-direction:column;gap:4px">
          <div id="cliModelList${i}" class="cli-model-list" style="display:flex;flex-direction:column;gap:4px"></div>
          <div style="display:flex;gap:6px;margin-top:4px;flex-wrap:wrap">
            <button class="sm-btn" type="button" onclick="addCliModelRow(${i})" style="padding:3px 10px;font-size:11px">+ 添加模型</button>
            <button class="sm-btn" type="button" onclick="probeCliBackendModels(${i})" style="padding:3px 10px;font-size:11px" title="运行 command + listModelsArg 自动拉取模型列表">🔍 自动探测</button>
            <button class="sm-btn" type="button" onclick="toggleCliModelBulk(${i})" id="cliModelBulkToggleBtn${i}" style="padding:3px 10px;font-size:11px" title="切换批量文本模式">📝 批量编辑</button>
            <span id="cliModelStatus${i}" style="font-size:10px;color:var(--muted);align-self:center"></span>
          </div>
          <!-- 批量编辑文本域（默认隐藏，点击 📝 切换显示） -->
          <div id="cliModelBulkWrap${i}" style="display:none;margin-top:6px">
            <textarea id="cliModelBulk${i}" rows="6" placeholder="每行一条，三种写法均可：&#10;  gpt-4o = openai/gpt-4o-2024-11-20      （完整映射）&#10;  llama3-8b: models/llama-3-8b.Q4_K_M.gguf（冒号亦可）&#10;  claude-sonnet                           （简写：等号两侧相同）&#10;  # 以 # 开头是注释" style="width:100%;padding:6px 8px;background:var(--code-bg);color:var(--text);border:1px solid var(--border2);border-radius:6px;font-family:ui-monospace,monospace;font-size:11.5px;resize:vertical;min-height:80px"></textarea>
            <div style="display:flex;gap:6px;margin-top:4px">
              <button class="sm-btn" type="button" onclick="applyCliModelBulk(${i})" style="padding:3px 10px;font-size:11px">✓ 应用到列表</button>
              <button class="sm-btn" type="button" onclick="toggleCliModelBulk(${i})" style="padding:3px 10px;font-size:11px">取消</button>
              <span style="font-size:10px;color:var(--muted);align-self:center">解析后会覆盖上面的列表</span>
            </div>
          </div>
          <div style="font-size:10px;color:var(--muted);line-height:1.4;margin-top:2px">
            每一行代表一个可在聊天框选择的模型。左：显示名（alias），右：实际传给 CLI 的 ID/路径。
            若定义了 modelArg（如 <code>--model</code>），选择模型时会把实际 ID 作为该参数值传入。
          </div>
        </div>

        <label style="color:var(--muted);align-self:start;padding-top:6px">环境变量</label>
        <textarea data-k="env" placeholder="每行一个，格式: KEY=VALUE" style="padding:6px 8px;background:var(--code-bg);color:var(--text);border:1px solid var(--border2);border-radius:6px;font-family:ui-monospace,monospace;font-size:11.5px;resize:vertical;min-height:40px">${esc(_cliMapToText(b.env))}</textarea>

        <label style="color:var(--muted);align-self:center">备注</label>
        <input type="text" data-k="description" value="${esc(b.description||'')}" placeholder="Claude Code CLI - fallback" style="padding:6px 8px;background:var(--code-bg);color:var(--text);border:1px solid var(--border2);border-radius:6px;font-size:12px">
      </div>
      <div style="display:flex;gap:6px;margin-top:10px;flex-wrap:wrap">
        <button class="sm-btn" onclick="testCliBackend(${i})" style="padding:5px 10px;font-size:11px" title="运行 command --version 验证可用">🔬 测试</button>
        <button class="sm-btn" onclick="saveCliBackend(${i})" style="padding:5px 10px;font-size:11px">💾 保存</button>
        <button class="sm-btn danger" onclick="deleteCliBackend(${i})" style="padding:5px 10px;font-size:11px">🗑 删除</button>
        <span id="cliBackendStatus${i}" style="font-size:11px;color:var(--muted);margin-left:auto;align-self:center"></span>
      </div>
      <div id="cliBackendTestOutput${i}" style="display:none;margin-top:8px;padding:8px 10px;background:rgba(0,0,0,.28);border:1px solid var(--border);border-radius:6px;font-family:ui-monospace,monospace;font-size:11px;white-space:pre-wrap;max-height:200px;overflow:auto"></div>
    `;
    list.appendChild(card);
    // 渲染可用模型行
    _renderCliModelListRows(i, b.modelAliases || {});
  }
}

// ── 可用模型行（动态 +/- 编辑器）──
function _renderCliModelListRows(idx, aliases){
  const container = document.getElementById('cliModelList' + idx);
  if(!container) return;
  container.innerHTML = '';
  const entries = Object.entries(aliases || {});
  if(entries.length === 0){
    const empty = document.createElement('div');
    empty.style.cssText = 'padding:6px 8px;color:var(--muted);font-size:11px;font-style:italic;border:1px dashed var(--border);border-radius:6px';
    empty.textContent = '尚无模型 — 点击 + 添加，或点击 🔍 自动探测';
    empty.id = 'cliModelEmpty' + idx;
    container.appendChild(empty);
    return;
  }
  for(const [alias, realId] of entries){
    _appendCliModelRow(idx, alias, realId);
  }
}

function _appendCliModelRow(idx, alias, realId){
  const container = document.getElementById('cliModelList' + idx);
  if(!container) return;
  // 移除 empty 占位
  const empty = document.getElementById('cliModelEmpty' + idx);
  if(empty) empty.remove();
  const row = document.createElement('div');
  row.className = 'cli-model-row';
  row.style.cssText = 'display:grid;grid-template-columns:1fr 1fr auto;gap:6px;align-items:center';
  row.innerHTML = `
    <input type="text" class="cli-model-alias" value="${esc(alias||'')}" placeholder="显示名 / alias（如 gpt-4o）" style="padding:5px 8px;background:var(--code-bg);color:var(--text);border:1px solid var(--border2);border-radius:6px;font-family:ui-monospace,monospace;font-size:11px">
    <input type="text" class="cli-model-real" value="${esc(realId||'')}" placeholder="实际 ID / 路径（传给 CLI 的值）" style="padding:5px 8px;background:var(--code-bg);color:var(--text);border:1px solid var(--border2);border-radius:6px;font-family:ui-monospace,monospace;font-size:11px">
    <button class="sm-btn" type="button" style="padding:3px 8px;font-size:11px;color:var(--accent)" title="删除此模型">✕</button>
  `;
  row.querySelector('button').onclick = () => {
    row.remove();
    // 若删完了，显示 empty
    if(container.children.length === 0){
      _renderCliModelListRows(idx, {});
    }
  };
  container.appendChild(row);
}

function addCliModelRow(idx){
  _appendCliModelRow(idx, '', '');
}

// 切换批量编辑文本域的显隐；打开时把当前列表序列化回文本（简写优先）
function toggleCliModelBulk(idx){
  const wrap = document.getElementById('cliModelBulkWrap' + idx);
  const ta = document.getElementById('cliModelBulk' + idx);
  const btn = document.getElementById('cliModelBulkToggleBtn' + idx);
  if(!wrap || !ta) return;
  const isHidden = wrap.style.display === 'none';
  if(isHidden){
    // 打开：把当前行编辑器的内容序列化为多行文本
    const current = _collectCliModelAliases(idx);
    const lines = [];
    for(const [alias, real] of Object.entries(current)){
      if(alias === real){
        lines.push(alias);           // 简写形式
      }else{
        lines.push(alias + ' = ' + real);
      }
    }
    ta.value = lines.join('\n');
    wrap.style.display = '';
    if(btn){ btn.textContent = '📝 关闭批量'; btn.style.color = 'var(--accent)'; }
    ta.focus();
  }else{
    wrap.style.display = 'none';
    if(btn){ btn.textContent = '📝 批量编辑'; btn.style.color = ''; }
  }
}

// 把批量文本解析后覆盖到行编辑器
function applyCliModelBulk(idx){
  const ta = document.getElementById('cliModelBulk' + idx);
  if(!ta) return;
  const parsed = _cliTextToMap(ta.value);
  _renderCliModelListRows(idx, parsed);
  // 关闭批量区
  const wrap = document.getElementById('cliModelBulkWrap' + idx);
  const btn = document.getElementById('cliModelBulkToggleBtn' + idx);
  if(wrap) wrap.style.display = 'none';
  if(btn){ btn.textContent = '📝 批量编辑'; btn.style.color = ''; }
  const count = Object.keys(parsed).length;
  _setCliModelStatus(idx, '✓ 应用 '+count+' 条', '#22c55e');
}

function _collectCliModelAliases(idx){
  const rows = document.querySelectorAll('#cliModelList'+idx+' .cli-model-row');
  const out = {};
  rows.forEach(row => {
    const alias = (row.querySelector('.cli-model-alias') || {}).value || '';
    const real = (row.querySelector('.cli-model-real') || {}).value || '';
    const a = String(alias).trim();
    if(!a) return;
    out[a] = String(real).trim() || a;  // 留空则 alias 即真实 ID
  });
  return out;
}

async function probeCliBackendModels(idx){
  const entry = _collectCliBackendFromCard(idx);
  if(!entry){ return; }
  if(!entry.command){
    _setCliModelStatus(idx, '请先填 command', 'var(--accent)');
    return;
  }
  if(!entry.listModelsArg){
    _setCliModelStatus(idx, '请先填 listModelsArg（如 --list-models）', 'var(--accent)');
    return;
  }
  _setCliModelStatus(idx, '探测中...', 'var(--muted)');
  try{
    const res = await api('/api/cli/probe-models',{method:'POST',body:JSON.stringify({
      command: entry.command,
      listModelsArg: entry.listModelsArg,
      args: entry.args || '',
      workdir: entry.workdir || '',
      env: entry.env || {},
    })});
    if(res && res.ok && Array.isArray(res.models) && res.models.length){
      // 合并到现有列表（保留用户已编辑的）
      const existing = _collectCliModelAliases(idx);
      for(const m of res.models){
        const alias = String(m.alias || m.id || '').trim();
        if(!alias) continue;
        if(!(alias in existing)){
          existing[alias] = String(m.id || alias);
        }
      }
      _renderCliModelListRows(idx, existing);
      _setCliModelStatus(idx, '✓ 探测到 '+res.models.length+' 个模型', '#22c55e');
    }else{
      _setCliModelStatus(idx, res && res.error ? ('探测失败: '+res.error) : '未解析到模型', 'var(--accent)');
    }
  }catch(e){
    _setCliModelStatus(idx, '探测失败: '+e.message, 'var(--accent)');
  }
}

function _setCliModelStatus(idx, text, color){
  const s = document.getElementById('cliModelStatus' + idx);
  if(!s) return;
  s.textContent = text || '';
  s.style.color = color || 'var(--muted)';
}

function _collectCliBackendFromCard(idx){
  const card = document.querySelectorAll('#cliBackendsList .cli-backend-card')[idx];
  if(!card) return null;
  const get = k => {
    const el = card.querySelector(`[data-k="${k}"]`);
    return el ? (el.type === 'checkbox' ? el.checked : el.value) : '';
  };
  const argsStr = String(get('args') || '').trim();
  const resumeArgsStr = String(get('resumeArgs') || '').trim();
  return {
    name: String(get('name') || '').trim(),
    command: String(get('command') || '').trim(),
    args: argsStr,   // backend will parse
    input: get('input') || 'stdin',
    output: get('output') || 'text',
    modelArg: String(get('modelArg') || '').trim(),
    modelAliases: _collectCliModelAliases(idx),
    listModelsArg: String(get('listModelsArg') || '').trim(),
    systemPromptArg: String(get('systemPromptArg') || '').trim(),
    systemPromptFileArg: String(get('systemPromptFileArg') || '').trim(),
    systemPromptMode: String(get('systemPromptMode') || '').trim().toLowerCase(),
    userPromptArg: String(get('userPromptArg') || '').trim(),
    sessionMode: get('sessionMode') || 'none',
    sessionArg: String(get('sessionArg') || '').trim(),
    resumeArgs: resumeArgsStr,
    resumeOutput: '',
    imageArg: String(get('imageArg') || '').trim(),
    systemPromptWhen: '',
    workdir: String(get('workdir') || '').trim(),
    env: _cliTextToMap(String(get('env') || '')),
    enabled: !!get('enabled'),
    useShellWrapper: String(get('useShellWrapper') || 'false') === 'true',
    description: String(get('description') || '').trim(),
  };
}

function _setCliBackendStatus(idx, text, color){
  const s = $('cliBackendStatus' + idx);
  if(!s) return;
  s.textContent = text || '';
  s.style.color = color || 'var(--muted)';
}

async function saveCliBackend(idx){
  const entry = _collectCliBackendFromCard(idx);
  if(!entry) return;
  if(!entry.name){ _setCliBackendStatus(idx, '名称不能为空', 'var(--accent)'); return; }
  if(!entry.command){ _setCliBackendStatus(idx, 'command 不能为空', 'var(--accent)'); return; }
  // ★ 常见配置错误自动清洗：若 args 第一个 token 与 command 的 basename 同名
  //   (如 command="knot-cli.exe", args="knot-cli chat ..."), 剥离并温和提示。
  try{
    const cmdBase = String(entry.command).trim().split(/[\/\\]/).pop().replace(/\.(exe|cmd|bat|sh)$/i,'').toLowerCase();
    const argsStr = String(entry.args||'').trim();
    if(cmdBase && argsStr){
      const firstTok = argsStr.split(/\s+/)[0].replace(/\.(exe|cmd|bat|sh)$/i,'').toLowerCase();
      if(firstTok === cmdBase){
        // 剥离首个 token
        entry.args = argsStr.replace(/^\S+\s*/,'');
        // 同步回输入框
        const card = document.querySelectorAll('#cliBackendsList .cli-backend-card')[idx];
        const argsInput = card && card.querySelector('[data-k="args"]');
        if(argsInput) argsInput.value = entry.args;
        showToast('已自动去除 args 中重复的命令名: '+firstTok);
      }
    }
  }catch(_){}
  _setCliBackendStatus(idx, '保存中...', 'var(--muted)');
  try{
    const res = await api('/api/cli/backends',{method:'POST',body:JSON.stringify({action:'save', ...entry})});
    if(res && res.ok){
      _cliBackendsData = Array.isArray(res.backends) ? res.backends : _cliBackendsData;
      renderCliBackendsList();
      showToast('CLI 后端「'+entry.name+'」已保存');
      // ★ 立即刷新模型下拉框，让新 CLI 出现在聊天框模型选择中
      if(typeof populateModelDropdown === 'function'){
        try{ await populateModelDropdown(); }catch(_){}
      }
    }else{
      throw new Error((res && res.error) || '保存失败');
    }
  }catch(e){
    _setCliBackendStatus(idx, '保存失败: '+e.message, 'var(--accent)');
  }
}

async function deleteCliBackend(idx){
  const b = _cliBackendsData[idx];
  if(!b) return;
  if(b._isNew){
    _cliBackendsData.splice(idx, 1);
    renderCliBackendsList();
    return;
  }
  if(!confirm('删除 CLI 后端「'+(b.name||'(未命名)')+'」？')) return;
  try{
    const res = await api('/api/cli/backends',{method:'POST',body:JSON.stringify({action:'delete', name: b.name})});
    if(res && res.ok){
      _cliBackendsData = Array.isArray(res.backends) ? res.backends : [];
      renderCliBackendsList();
      showToast('已删除');
      if(typeof populateModelDropdown === 'function'){
        try{ await populateModelDropdown(); }catch(_){}
      }
    }
  }catch(e){
    showToast('删除失败: '+e.message);
  }
}

async function testCliBackend(idx){
  const entry = _collectCliBackendFromCard(idx);
  if(!entry || !entry.command){
    _setCliBackendStatus(idx, '请先填 command', 'var(--accent)');
    return;
  }
  _setCliBackendStatus(idx, '测试中...', 'var(--muted)');
  const outEl = $('cliBackendTestOutput' + idx);
  if(outEl){ outEl.style.display = ''; outEl.textContent = '运行 '+entry.command+' --version …'; }
  try{
    const res = await api('/api/cli/test',{method:'POST',body:JSON.stringify({
      command: entry.command,
      // 测试用 --version，不用用户的 args（可能包含对话专用参数）
      args: ['--version'],
      workdir: entry.workdir || '',
    })});
    const ok = res && res.ok;
    _setCliBackendStatus(idx, ok ? '✓ 可用' : '✗ 不可用', ok ? '#22c55e' : 'var(--accent)');
    if(outEl){
      const parts = [];
      if(res.resolved) parts.push('解析路径: ' + res.resolved);
      if(typeof res.return_code === 'number') parts.push('return_code: ' + res.return_code);
      if(res.stdout) parts.push('--- stdout ---\n' + res.stdout);
      if(res.stderr) parts.push('--- stderr ---\n' + res.stderr);
      if(res.error) parts.push('错误: ' + res.error);
      outEl.textContent = parts.join('\n\n') || '无输出';
    }
  }catch(e){
    _setCliBackendStatus(idx, '测试失败', 'var(--accent)');
    if(outEl){ outEl.textContent = e.message; }
  }
}

// Close settings on overlay click (not panel click) -- with unsaved-changes check
document.addEventListener('click',e=>{
  const overlay=$('settingsOverlay');
  if(overlay&&e.target===overlay) _closeSettingsPanel();
});

// ── Cron completion alerts ────────────────────────────────────────────────────

let _cronPollSince=Date.now()/1000;  // track from page load
let _cronPollTimer=null;
let _cronUnreadCount=0;

function startCronPolling(){
  if(_cronPollTimer) return;
  _cronPollTimer=setInterval(async()=>{
    if(document.hidden) return;  // don't poll when tab is in background
    try{
      const data=await api(`/api/crons/recent?since=${_cronPollSince}`);
      if(data.completions&&data.completions.length>0){
        for(const c of data.completions){
          showToast(`Cron "${c.name}" ${c.status==='error'?'failed':'completed'}`,4000);
          _cronPollSince=Math.max(_cronPollSince,c.completed_at);
        }
        _cronUnreadCount+=data.completions.length;
        updateCronBadge();
      }
    }catch(e){}
  },30000);
}

function updateCronBadge(){
  const tab=document.querySelector('.nav-tab[data-panel="tasks"]');
  if(!tab) return;
  let badge=tab.querySelector('.cron-badge');
  if(_cronUnreadCount>0){
    if(!badge){
      badge=document.createElement('span');
      badge.className='cron-badge';
      tab.style.position='relative';
      tab.appendChild(badge);
    }
    badge.textContent=_cronUnreadCount>9?'9+':_cronUnreadCount;
    badge.style.display='';
  }else if(badge){
    badge.style.display='none';
  }
}

// Clear cron badge when Tasks tab is opened
const _origSwitchPanel=switchPanel;
switchPanel=async function(name){
  if(name==='tasks'){_cronUnreadCount=0;updateCronBadge();}
  return _origSwitchPanel(name);
};

// Start polling on page load
startCronPolling();

// ── Background agent error tracking ──────────────────────────────────────────

const _backgroundErrors=[];  // {session_id, title, message, ts}

function trackBackgroundError(sessionId, title, message){
  // Only track if user is NOT currently viewing this session
  if(S.session&&S.session.session_id===sessionId) return;
  _backgroundErrors.push({session_id:sessionId, title:title||'Untitled', message, ts:Date.now()});
  showErrorBanner();
}

function showErrorBanner(){
  let banner=$('bgErrorBanner');
  if(!banner){
    banner=document.createElement('div');
    banner.id='bgErrorBanner';
    banner.className='bg-error-banner';
    const msgs=document.querySelector('.messages');
    if(msgs) msgs.parentNode.insertBefore(banner,msgs);
    else document.body.appendChild(banner);
  }
  const latest=_backgroundErrors[0];  // FIFO: show oldest (first) error
  if(!latest){banner.style.display='none';return;}
  const count=_backgroundErrors.length;
  banner.innerHTML=`<span>\u26a0 ${count>1?count+' sessions have':'"'+esc(latest.title)+'" has'} encountered an error</span><div style="display:flex;gap:6px;flex-shrink:0"><button class="reconnect-btn" onclick="navigateToErrorSession()">View</button><button class="reconnect-btn" onclick="dismissErrorBanner()">Dismiss</button></div>`;
  banner.style.display='';
}

function navigateToErrorSession(){
  const latest=_backgroundErrors.shift();  // FIFO: show oldest error first
  if(latest){
    loadSession(latest.session_id);renderSessionList();
  }
  if(_backgroundErrors.length===0) dismissErrorBanner();
  else showErrorBanner();
}

function dismissErrorBanner(){
  _backgroundErrors.length=0;
  const banner=$('bgErrorBanner');
  if(banner) banner.style.display='none';
}

// ── Auxiliary Models Configuration ─────────────────────────────────────────

// Task name mapping to DOM element IDs
const _AUX_TASKS = {
  Vision: {providerId: 'auxVisionProvider', modelId: 'auxVisionModel'},
  WebExtract: {providerId: 'auxWebExtractProvider', modelId: 'auxWebExtractModel'},
  SessionSearch: {providerId: 'auxSessionSearchProvider', modelId: 'auxSessionSearchModel'},
  Compression: {providerId: 'auxCompressionProvider', modelId: 'auxCompressionModel'},
  GoalJudge: {providerId: 'auxGoalJudgeProvider', modelId: 'auxGoalJudgeModel'},
  Curator: {providerId: 'auxCuratorProvider', modelId: 'auxCuratorModel'},
};

async function loadAuxiliaryModelOptions(provider, inputId, currentValue) {
  // For datalist, the inputId is like "auxVisionModel", and the datalist id is inputId + "List"
  const dataListId = inputId + 'List';
  const dataList = $(dataListId);
  const inputEl = $(inputId);
  
  if (!dataList || !inputEl) return;
  
  // Clear existing options
  dataList.innerHTML = '';
  
  if (!provider || provider === 'auto' || provider === 'main' || provider === 'custom') {
    // No model selection needed, clear input value
    // Keep current value if it's custom text
    return;
  }
  
  try {
    if (provider === 'knot') {
      // Load Knot AG-UI agents
      const data = await api('/api/knot/agents');
      const agents = data.agents || [];
      agents.forEach(agent => {
        const opt = document.createElement('option');
        opt.value = 'knot-agui:' + agent.id;
        let label = agent.name || agent.id;
        if (agent.models && Array.isArray(agent.models)) {
          label += ' (' + agent.models.join(', ') + ')';
        }
        opt.label = label;
        if (opt.value === currentValue) inputEl.value = opt.value;
        dataList.appendChild(opt);
      });
    } else {
      // Load models from /api/models and filter by provider
      const data = await api('/api/models');
      const groups = data.groups || [];
      
      // Build provider alias mapping
      const providerAlias = {
        'openrouter': 'openrouter',
        'nous': 'nous',
        'gemini': 'gemini',
        'anthropic': 'anthropic',
      };
      
      groups.forEach(g => {
        const p = (g.provider || '').toLowerCase();
        if (p === providerAlias[provider]) {
          (g.models || []).forEach(m => {
            const opt = document.createElement('option');
            opt.value = m.id || m;
            opt.label = m.label || m.id || m;
            if (opt.value === currentValue) inputEl.value = opt.value;
            dataList.appendChild(opt);
          });
        }
      });
    }
  } catch (e) {
    console.error('Failed to load model options for ' + provider + ':', e);
  }
}

async function onAuxProviderChange(taskName) {
  const task = _AUX_TASKS[taskName];
  if (!task) return;
  
  const providerSel = $(task.providerId);
  const modelSel = $(task.modelId);
  if (!providerSel || !modelSel) return;
  
  await loadAuxiliaryModelOptions(providerSel.value, task.modelId, '');
}

async function loadAuxiliarySettings(){
  try{
    const config=await api('/api/config');
    const aux=config.auxiliary||{};

    // Helper to safely set select value
    function setSelect(id, value){
      const el=$(id);
      if(!el) return;
      // Find option with matching value, or default to "auto"
      let found=false;
      for(const opt of el.options){
        if(opt.value===value){opt.selected=true;found=true;break;}
      }
      if(!found) el.value='auto';
    }

    // Vision
    const vision=aux.vision||{};
    setSelect('auxVisionProvider', vision.provider||'auto');
    // Load model options after setting provider
    await loadAuxiliaryModelOptions(vision.provider||'auto', 'auxVisionModel', vision.model||'');
    
    $('auxVisionTimeout').value=vision.timeout||30;
    $('auxVisionDownloadTimeout').value=vision.download_timeout||30;

    // Web Extract
    const webExtract=aux.web_extract||{};
    setSelect('auxWebExtractProvider', webExtract.provider||'auto');
    await loadAuxiliaryModelOptions(webExtract.provider||'auto', 'auxWebExtractModel', webExtract.model||'');

    // Session Search
    const sessionSearch=aux.session_search||{};
    setSelect('auxSessionSearchProvider', sessionSearch.provider||'auto');
    await loadAuxiliaryModelOptions(sessionSearch.provider||'auto', 'auxSessionSearchModel', sessionSearch.model||'');
    
    $('auxSessionSearchTimeout').value=sessionSearch.timeout||30;
    $('auxSessionSearchMaxConcurrency').value=sessionSearch.max_concurrency||3;

    // Compression
    const compression=aux.compression||{};
    setSelect('auxCompressionProvider', compression.provider||'auto');
    await loadAuxiliaryModelOptions(compression.provider||'auto', 'auxCompressionModel', compression.model||'');
    
    $('auxCompressionTimeout').value=compression.timeout||30;

    // Goal Judge
    const goalJudge=aux.goal_judge||{};
    setSelect('auxGoalJudgeProvider', goalJudge.provider||'auto');
    await loadAuxiliaryModelOptions(goalJudge.provider||'auto', 'auxGoalJudgeModel', goalJudge.model||'');
    
    $('auxGoalJudgeTimeout').value=goalJudge.timeout||30;

    // Curator
    const curator=aux.curator||{};
    setSelect('auxCuratorProvider', curator.provider||'auto');
    await loadAuxiliaryModelOptions(curator.provider||'auto', 'auxCuratorModel', curator.model||'');
    
    $('auxCuratorTimeout').value=curator.timeout||600;

    const errEl=$('auxiliarySaveError');
    if(errEl) errEl.style.display='none';
  }catch(e){
    console.error('Failed to load auxiliary settings:',e);
    showToast('Failed to load auxiliary models configuration');
  }
}

async function saveAuxiliarySettings(){
  try{
    // Build auxiliary config object
    const aux={
      vision: {
        provider: $('auxVisionProvider').value,
        model: $('auxVisionModel').value.trim(),
        timeout: parseInt($('auxVisionTimeout').value)||30,
        download_timeout: parseInt($('auxVisionDownloadTimeout').value)||30
      },
      web_extract: {
        provider: $('auxWebExtractProvider').value,
        model: $('auxWebExtractModel').value.trim()
      },
      session_search: {
        provider: $('auxSessionSearchProvider').value,
        model: $('auxSessionSearchModel').value.trim(),
        timeout: parseInt($('auxSessionSearchTimeout').value)||30,
        max_concurrency: parseInt($('auxSessionSearchMaxConcurrency').value)||3
      },
      compression: {
        provider: $('auxCompressionProvider').value,
        model: $('auxCompressionModel').value.trim(),
        timeout: parseInt($('auxCompressionTimeout').value)||30
      },
      goal_judge: {
        provider: $('auxGoalJudgeProvider').value,
        model: $('auxGoalJudgeModel').value.trim(),
        timeout: parseInt($('auxGoalJudgeTimeout').value)||30
      },
      curator: {
        provider: $('auxCuratorProvider').value,
        model: $('auxCuratorModel').value.trim(),
        timeout: parseInt($('auxCuratorTimeout').value)||600
      }
    };

    // Remove empty model strings (use provider default)
    for(const key of Object.keys(aux)){
      if(aux[key].model==='') delete aux[key].model;
    }

    await api('/api/config',{method:'POST',body:JSON.stringify({auxiliary:aux})});
    showToast('Auxiliary models configuration saved successfully');
    const errEl=$('auxiliarySaveError');
    if(errEl) errEl.style.display='none';
  }catch(e){
    console.error('Failed to save auxiliary settings:',e);
    const errEl=$('auxiliarySaveError');
    if(errEl){
      errEl.textContent='Failed to save: '+e.message;
      errEl.style.display='block';
    }
  }
}

