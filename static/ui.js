const S={session:null,messages:[],entries:[],busy:false,pendingFiles:[],toolCalls:[],activeStreamId:null,currentDir:'.',activeProfile:'default'};
const INFLIGHT={};  // keyed by session_id while request in-flight
const MSG_QUEUE=[];  // messages queued while a request is in-flight
const $=id=>document.getElementById(id);
const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));

// Dynamic model labels -- populated by populateModelDropdown(), fallback to static map
let _dynamicModelLabels={};

// ── Smart model resolver ────────────────────────────────────────────────────
// Finds the best matching option value in a <select> for a given model ID.
// Handles mismatches like 'claude-sonnet-4-6' vs 'anthropic/claude-sonnet-4.6'.
// Returns the matched option's value (already in the list), or null if no match.
function _findModelInDropdown(modelId, sel){
  if(!modelId||!sel) return null;
  const opts=Array.from(sel.options).map(o=>o.value);
  // 1. Exact match
  if(opts.includes(modelId)) return modelId;
  // 2. Normalize: lowercase, strip namespace prefix, replace hyphens→dots
  const norm=s=>s.toLowerCase().replace(/^[^/]+\//,'').replace(/-/g,'.');
  const target=norm(modelId);
  const exact=opts.find(o=>norm(o)===target);
  if(exact) return exact;
  // 3. Prefix/substring: target starts with or contains a significant chunk
  const base=target.replace(/\.\d+$/,'');  // strip trailing version number
  const partial=opts.find(o=>norm(o).startsWith(base)||norm(o).includes(base));
  return partial||null;
}

// Set the model picker to the best match for modelId.
// Returns the resolved value that was actually set, or null if nothing matched.
function _applyModelToDropdown(modelId, sel){
  if(!modelId||!sel) return null;
  const resolved=_findModelInDropdown(modelId,sel);
  if(resolved){
    sel.value=resolved;
    if(sel.id==='modelSelect' && typeof syncModelChip==='function') syncModelChip();
    return resolved;
  }
  return null;
}

async function populateModelDropdown(){
  const sel=$('modelSelect');
  if(!sel) return;
  try{
    const data=await fetch(new URL('/api/models',location.origin).href,{credentials:'include'}).then(r=>r.json());
    // ★ 2026-04-27 Bug 修复：即使 data.groups 为空也要清空占位 <option>，
    //   否则用户会看到 HTML 里的 "Loading models…" 一直不消失；或者更坏——
    //   原 HTML 里硬编码的 OpenAI/Anthropic/Other optgroup 一直留着，和
    //   后端实际检测到的 provider 完全不符（用户反馈的真实 bug 场景）。
    if(!data.groups||!data.groups.length){
      sel.innerHTML='<option value="" disabled selected>No models available — configure an API key or custom_provider in your config</option>';
      if(typeof syncModelChip==='function') syncModelChip();
      return;
    }
    // Store active provider globally so the send path can warn on mismatch
    window._activeProvider=data.active_provider||null;
    // Clear existing options (包含启动占位 <option> 和任何 HTML 硬编码残留)
    sel.innerHTML='';
    _dynamicModelLabels={};
    const ap=(data.active_provider||'').toLowerCase();
    // Sort groups: active provider first, then others alphabetically
    const sorted=data.groups.slice().sort((a,b)=>{
      const ga=(a.provider||'').toLowerCase();
      const gb=(b.provider||'').toLowerCase();
      if(ga===ap) return -1;
      if(gb===ap) return 1;
      return ga.localeCompare(gb);
    });
    for(const g of sorted){
      const og=document.createElement('optgroup');
      og.label=g.provider;
      for(const m of g.models){
        const opt=document.createElement('option');
        opt.value=m.id;
        opt.textContent=m.label;
        og.appendChild(opt);
        _dynamicModelLabels[m.id]=m.label;
      }
      sel.appendChild(og);
    }
    // Restore model selection: prefer session model > localStorage > server default
    const savedModel=(typeof S!=='undefined'&&S.session&&S.session.model)||localStorage.getItem('hermes-webui-model')||data.default_model;
    if(savedModel){
      _applyModelToDropdown(savedModel, sel);
    }
    if(typeof syncModelChip==='function') syncModelChip();

    // ★ 2026-04-27 Bug 修复：清理掉 syncTopbar 先前可能追加的"(unavailable)"条目。
    //   场景：populateModelDropdown 是异步 fetch，在它完成前浏览器可能已经走过
    //   renderModelDropdown 或 syncTopbar，syncTopbar 里会把 session.model append
    //   为 unavailable option。populate 完成后这些 stale option 仍会留在 sel 末尾
    //   （sel.innerHTML='' 只在本函数顶部执行一次），下一次 syncTopbar 又可能再加。
    //   这里保险起见：清除所有不在真正 optgroup 下的散落 option。
    Array.from(sel.children).forEach(child => {
      if (child.tagName === 'OPTION') {
        sel.removeChild(child);
      }
    });

    // ★ 如果 composer model dropdown 当前是打开状态（用户早于 populate 完成前点开），
    //   主动重新渲染，让用户立刻看到真实模型列表而不是过时/空状态。
    const _dd = $('composerModelDropdown');
    if (_dd && _dd.classList.contains('open') && typeof renderModelDropdown === 'function') {
      try { renderModelDropdown(); } catch(_) {}
    }
  }catch(e){
    // ★ 2026-04-27 Bug 修复：API 不可达时不再保留 HTML 硬编码 fallback（那些是
    //   错误的假模型名，与用户实际配置的 provider 无关）。显示明确的错误占位。
    console.warn('Failed to load models from server:',e.message);
    sel.innerHTML='<option value="" disabled selected>Failed to load models — check server connectivity</option>';
    if(typeof syncModelChip==='function') syncModelChip();
  }
}

/**
 * Check if the given model ID belongs to a different provider than the one
 * currently configured in Hermes. Returns a warning string if mismatched,
 * or null if the selection looks compatible.
 *
 * NOTE: The backend resolve_model_provider() automatically routes cross-provider
 * models (e.g. openai/gpt-4o when config provider is 'nous') through OpenRouter,
 * so cross-provider selection works transparently. We no longer warn about this
 * since it was misleading — the model *will* work via OpenRouter routing.
 *
 * We only return a warning for bare model names that clearly belong to a
 * different provider and cannot be auto-routed (no slash prefix = no routing hint).
 */
function _checkProviderMismatch(modelId){
  // Cross-provider models with a slash prefix (e.g. openai/gpt-4o) are
  // automatically routed through OpenRouter by the backend. No warning needed.
  const slash=modelId.indexOf('/');
  if(slash>0) return null; // has provider prefix → backend handles routing
  // Bare model names without a slash cannot be auto-routed, but we also
  // can't reliably determine the provider, so skip the check.
  return null;
}

function _selectedModelOption(){
  const sel=$('modelSelect');
  if(!sel) return null;
  return sel.options[sel.selectedIndex]||null;
}

function syncModelChip(){
  const sel=$('modelSelect');
  const chip=$('composerModelChip');
  const label=$('composerModelLabel');
  const dd=$('composerModelDropdown');
  if(!sel||!chip||!label) return;
  const opt=_selectedModelOption();
  label.textContent=opt?opt.textContent:getModelLabel(sel.value||'');
  chip.title=sel.value||'Conversation model';
  chip.classList.toggle('active',!!(dd&&dd.classList.contains('open')));
}

function _positionModelDropdown(){
  const dd=$('composerModelDropdown');
  const chip=$('composerModelChip');
  const footer=document.querySelector('.composer-footer');
  if(!dd||!chip||!footer) return;
  const chipRect=chip.getBoundingClientRect();
  const footerRect=footer.getBoundingClientRect();
  let left=chipRect.left-footerRect.left;
  const maxLeft=Math.max(0, footer.clientWidth-dd.offsetWidth);
  left=Math.max(0, Math.min(left, maxLeft));
  dd.style.left=`${left}px`;
}

function renderModelDropdown(){
  const dd=$('composerModelDropdown');
  const sel=$('modelSelect');
  if(!dd||!sel) return;
  dd.innerHTML='';

  // ★ 2026-04-27 Bug 修复：如果打开 dropdown 时 #modelSelect 里没有任何真实
  //   optgroup（只剩启动占位 option 或只有 syncTopbar 追加的 unavailable 条目），
  //   说明 populateModelDropdown 还没跑完或失败了。此时触发一次后台重试，
  //   让用户不用手动刷新页面就能拿到最新列表。
  const hasRealOptgroups = Array.from(sel.children).some(c => c.tagName === 'OPTGROUP' && c.children && c.children.length > 0);
  if (!hasRealOptgroups && typeof populateModelDropdown === 'function') {
    // 异步触发重试——不阻塞本次 dropdown 渲染（用户仍能看到当前状态）
    populateModelDropdown().then(() => {
      // 重试成功后如果下拉仍开着，重新渲染
      if (dd.classList.contains('open')) renderModelDropdown();
    }).catch(() => {});
  }

  const ap=(window._activeProvider||'').toLowerCase();
  // ── Provider tabs ──
  const providerBar=document.createElement('div');
  providerBar.className='model-provider-bar';
  providerBar.id='modelProviderBar';
  // Collect unique providers from <select> optgroups
  const providers=[];
  for(const child of Array.from(sel.children)){
    if(child.tagName==='OPTGROUP' && child.label){
      providers.push({name:child.label, key:(child.label||'').toLowerCase()});
    }
  }
  for(const p of providers){
    const tab=document.createElement('button');
    tab.className='model-provider-tab'+(p.key===ap?' active':'');
    tab.textContent=p.name;
    tab.dataset.provider=p.key;
    tab.onclick=()=>{
      // Highlight active tab
      providerBar.querySelectorAll('.model-provider-tab').forEach(t=>t.classList.remove('active'));
      tab.classList.add('active');
      _filterByProvider(p.key);
    };
    providerBar.appendChild(tab);
  }
  dd.appendChild(providerBar);
  // ── Search input ──
  const searchWrap=document.createElement('div');
  searchWrap.className='model-search-wrap';
  searchWrap.innerHTML=`<input type="text" class="model-search-input" id="modelSearchInput" placeholder="${esc(t('model_search_placeholder'))}" autocomplete="off">`;
  dd.appendChild(searchWrap);
  // ── Model list (scrollable) ──
  const listWrap=document.createElement('div');
  listWrap.className='model-list-wrap';
  listWrap.id='modelListWrap';
  for(const child of Array.from(sel.children)){
    if(child.tagName==='OPTGROUP'){
      const heading=document.createElement('div');
      heading.className='model-group';
      heading.dataset.group=child.label||'Models';
      heading.textContent=child.label||'Models';
      listWrap.appendChild(heading);
      for(const opt of Array.from(child.children)){
        const row=document.createElement('div');
        row.className='model-opt'+(opt.value===sel.value?' active':'');
        row.dataset.label=(opt.textContent||getModelLabel(opt.value)||'').toLowerCase();
        row.dataset.value=opt.value.toLowerCase();
        row.dataset.provider=(child.label||'').toLowerCase();
        row.innerHTML=`<span class="model-opt-name">${esc(opt.textContent||getModelLabel(opt.value))}</span><span class="model-opt-id">${esc(opt.value)}</span>`;
        row.onclick=()=>selectModelFromDropdown(opt.value);
        listWrap.appendChild(row);
      }
      continue;
    }
    if(child.tagName==='OPTION'){
      const row=document.createElement('div');
      row.className='model-opt'+(child.value===sel.value?' active':'');
      row.dataset.label=(child.textContent||getModelLabel(child.value)||'').toLowerCase();
      row.dataset.value=child.value.toLowerCase();
      row.dataset.provider='';
      row.innerHTML=`<span class="model-opt-name">${esc(child.textContent||getModelLabel(child.value))}</span><span class="model-opt-id">${esc(child.value)}</span>`;
      row.onclick=()=>selectModelFromDropdown(child.value);
      listWrap.appendChild(row);
    }
  }
  dd.appendChild(listWrap);
  // ── Custom model input ──
  const customWrap=document.createElement('div');
  customWrap.className='model-custom-wrap';
  customWrap.innerHTML=`<div class="model-custom-divider"></div><div class="model-custom-row"><input type="text" class="model-custom-input" id="modelCustomInput" placeholder="${esc(t('model_custom_placeholder'))}" autocomplete="off"><button class="model-custom-btn" id="modelCustomBtn" title="${esc(t('model_custom_apply'))}"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg></button></div>`;
  dd.appendChild(customWrap);
  // ── Wire up events ──
  const searchInput=$('modelSearchInput');
  if(searchInput){
    searchInput.addEventListener('input',()=>{
      const q=searchInput.value.trim();
      // Clear provider tab selection when searching
      if(q){
        providerBar.querySelectorAll('.model-provider-tab').forEach(t=>t.classList.remove('active'));
      }
      _filterModelDropdown(q);
    });
    // Auto-focus search when dropdown opens
    requestAnimationFrame(()=>searchInput.focus());
  }
  const customInput=$('modelCustomInput');
  const customBtn=$('modelCustomBtn');
  if(customInput&&customBtn){
    const applyCustom=()=>{
      const val=customInput.value.trim();
      if(val) selectModelFromDropdown(val);
    };
    customBtn.addEventListener('click',applyCustom);
    customInput.addEventListener('keydown',(e)=>{if(e.key==='Enter'){e.preventDefault();applyCustom();}});
  }
  // Auto-select active provider tab on open
  if(ap) _filterByProvider(ap);
}

function _filterByProvider(providerKey){
  const listWrap=$('modelListWrap');
  if(!listWrap) return;
  const pk=(providerKey||'').toLowerCase();
  const groups=listWrap.querySelectorAll('.model-group');
  const opts=listWrap.querySelectorAll('.model-opt');
  // Clear search input
  const searchInput=$('modelSearchInput');
  if(searchInput) searchInput.value='';
  if(!pk){
    // Show all
    groups.forEach(g=>g.style.display='');
    opts.forEach(o=>o.style.display='');
    return;
  }
  // Show only models matching this provider
  let currentGroup=null;
  const groupOrder=[];
  const groupVisible={};
  groups.forEach(g=>{
    currentGroup=g;
    groupOrder.push(g);
    groupVisible[g.dataset.group]=false;
  });
  opts.forEach(o=>{
    const op=o.dataset.provider||'';
    const match=op===pk;
    o.style.display=match?'':'none';
    // Mark its parent group as visible
    if(match){
      let prev=o.previousElementSibling;
      while(prev){
        if(prev.classList.contains('model-group')){
          groupVisible[prev.dataset.group]=true;
          break;
        }
        prev=prev.previousElementSibling;
      }
    }
  });
  groups.forEach(g=>{
    g.style.display=groupVisible[g.dataset.group]?'':'none';
  });
}

function _filterModelDropdown(query){
  const listWrap=$('modelListWrap');
  if(!listWrap) return;
  const q=(query||'').toLowerCase().trim();
  const groups=listWrap.querySelectorAll('.model-group');
  const opts=listWrap.querySelectorAll('.model-opt');
  if(!q){
    // Show all
    groups.forEach(g=>g.style.display='');
    opts.forEach(o=>o.style.display='');
    return;
  }
  // Hide/show options based on search
  opts.forEach(o=>{
    const label=o.dataset.label||'';
    const value=o.dataset.value||'';
    const match=label.includes(q)||value.includes(q);
    o.style.display=match?'':'none';
  });
  // Hide empty groups
  groups.forEach(g=>{
    let next=g.nextElementSibling;
    let hasVisible=false;
    while(next&&!next.classList.contains('model-group')){
      if(next.style.display!=='none') hasVisible=true;
      next=next.nextElementSibling;
    }
    g.style.display=hasVisible?'':'none';
  });
}

async function selectModelFromDropdown(value){
  const sel=$('modelSelect');
  if(!sel) { closeModelDropdown(); return; }
  if(sel.value===value) { closeModelDropdown(); return; }
  // If value not in existing options, add it as a custom entry
  if(!sel.querySelector(`option[value="${CSS.escape(value)}"]`)){
    const opt=document.createElement('option');
    opt.value=value;
    opt.textContent=getModelLabel(value);
    sel.appendChild(opt);
  }
  sel.value=value;
  syncModelChip();
  closeModelDropdown();
  // sel.onchange() 会同步 emp.model + S.session.model + 保存 session
  if(typeof sel.onchange==='function') await sel.onchange();
}

function toggleModelDropdown(){
  const dd=$('composerModelDropdown');
  const chip=$('composerModelChip');
  const sel=$('modelSelect');
  if(!dd||!chip||!sel) return;
  const open=dd.classList.contains('open');
  if(open){closeModelDropdown(); return;}
  if(typeof closeProfileDropdown==='function') closeProfileDropdown();
  if(typeof closeWsDropdown==='function') closeWsDropdown();
  renderModelDropdown();
  dd.classList.add('open');
  _positionModelDropdown();
  chip.classList.add('active');
}

function closeModelDropdown(){
  const dd=$('composerModelDropdown');
  const chip=$('composerModelChip');
  if(dd) dd.classList.remove('open');
  if(chip) chip.classList.remove('active');
}

document.addEventListener('click',e=>{
  if(!e.target.closest('#composerModelChip') && !e.target.closest('#composerModelDropdown')) closeModelDropdown();
});
window.addEventListener('resize',()=>{
  const dd=$('composerModelDropdown');
  if(dd&&dd.classList.contains('open')) _positionModelDropdown();
});

// ── Scroll pinning ──────────────────────────────────────────────────────────
// When streaming, auto-scroll only if the user hasn't manually scrolled up.
// Once the user scrolls back to within 80px of the bottom, re-pin.
let _scrollPinned=true;
(function(){
  const el=document.getElementById('rpMessages')||document.getElementById('messages');
  if(!el) return;
  el.addEventListener('scroll',()=>{
    const nearBottom=el.scrollHeight-el.scrollTop-el.clientHeight<80;
    _scrollPinned=nearBottom;
  });
})();
function _fmtTokens(n){if(!n||n<0)return'0';if(n>=1e6)return(n/1e6).toFixed(1)+'M';if(n>=1e3)return(n/1e3).toFixed(1)+'k';return String(n);}

// Context usage indicator in composer footer
function _syncCtxIndicator(usage){
  const wrap=$('ctxIndicatorWrap');
  const el=$('ctxIndicator');
  if(!el)return;
  const promptTok=usage.last_prompt_tokens||usage.input_tokens||0;
  const totalTok=(usage.input_tokens||0)+(usage.output_tokens||0);
  const ctxWindow=usage.context_length||0;
  const cost=usage.estimated_cost;
  // Show indicator whenever we have any usage data (tokens or cost)
  if(!promptTok&&!totalTok&&!cost){
    if(wrap) wrap.style.display='none';
    return;
  }
  if(wrap) wrap.style.display='';
  const hasCtxWindow=!!(promptTok&&ctxWindow);
  const pct=hasCtxWindow?Math.min(100,Math.round((promptTok/ctxWindow)*100)):0;
  const ring=$('ctxRingValue');
  const center=$('ctxPercent');
  const usageLine=$('ctxTooltipUsage');
  const tokensLine=$('ctxTooltipTokens');
  const thresholdLine=$('ctxTooltipThreshold');
  const costLine=$('ctxTooltipCost');
  if(ring){
    const circumference=61.261056745;
    ring.style.strokeDasharray=String(circumference);
    ring.style.strokeDashoffset=String(circumference*(1-pct/100));
  }
  if(center) center.textContent=hasCtxWindow?String(pct):'\u00b7';
  el.classList.toggle('ctx-mid',pct>50&&pct<=75);
  el.classList.toggle('ctx-high',pct>75);
  let label=hasCtxWindow?`Context window ${pct}% used`:`${_fmtTokens(totalTok)} tokens used`;
  if(cost) label+=` \u00b7 $${cost<0.01?cost.toFixed(4):cost.toFixed(2)}`;
  el.setAttribute('aria-label',label);
  if(usageLine) usageLine.textContent=hasCtxWindow?`${pct}% used (${Math.max(0,100-pct)}% left)`:`${_fmtTokens(totalTok)} tokens used`;
  if(tokensLine) tokensLine.textContent=hasCtxWindow?`${_fmtTokens(promptTok)} / ${_fmtTokens(ctxWindow)} tokens used`:`In: ${_fmtTokens(usage.input_tokens||0)} \u00b7 Out: ${_fmtTokens(usage.output_tokens||0)}`;
  const threshold=usage.threshold_tokens||0;
  if(thresholdLine){
    if(threshold&&ctxWindow){
      thresholdLine.style.display='';
      thresholdLine.textContent=`Auto-compress at ${_fmtTokens(threshold)} (${Math.round(threshold/ctxWindow*100)}%)`;
    }else{
      thresholdLine.style.display='none';
      thresholdLine.textContent='';
    }
  }
  if(costLine){
    if(cost){
      costLine.style.display='';
      costLine.textContent=`Estimated cost: $${cost<0.01?cost.toFixed(4):cost.toFixed(2)}`;
    }else{
      costLine.style.display='none';
      costLine.textContent='';
    }
  }
}

function scrollIfPinned(){
  if(!_scrollPinned) return;
  const el=$('rpMessages')||$('messages');
  if(el) el.scrollTop=el.scrollHeight;
}
function scrollToBottom(){
  _scrollPinned=true;
  const el=$('rpMessages')||$('messages');
  if(el) el.scrollTop=el.scrollHeight;
}

function getModelLabel(modelId){
  if(!modelId) return 'Unknown';
  // Check dynamic labels first, then fall back to splitting the ID
  if(_dynamicModelLabels[modelId]) return _dynamicModelLabels[modelId];
  // Static fallback for common models
  const STATIC_LABELS={'openai/gpt-5.4-mini':'GPT-5.4 Mini','openai/gpt-4o':'GPT-4o','openai/o3':'o3','openai/o4-mini':'o4-mini','anthropic/claude-sonnet-4.6':'Sonnet 4.6','anthropic/claude-sonnet-4-5':'Sonnet 4.5','anthropic/claude-haiku-3-5':'Haiku 3.5','google/gemini-2.5-pro':'Gemini 2.5 Pro','deepseek/deepseek-chat-v3-0324':'DeepSeek V3','meta-llama/llama-4-scout':'Llama 4 Scout'};
  if(STATIC_LABELS[modelId]) return STATIC_LABELS[modelId];
  return modelId.split('/').pop()||'Unknown';
}

// ── marked.js configuration (initialized once) ────────────────────────────────
let _markedReady = false;

function _initMarked() {
  if (_markedReady || typeof marked === 'undefined') return;
  _markedReady = true;

  // Configure marked via marked.use() (v15 API — setOptions is removed)
  marked.use({
    gfm: true,
    breaks: true,
    renderer: {
      // Code blocks: add language header + Prism-compatible class for syntax highlighting
      code({ text, lang }) {
        // Mermaid blocks: render as diagram containers
        if (lang === 'mermaid') {
          const id = 'mermaid-' + Math.random().toString(36).slice(2, 10);
          return `<div class="mermaid-block" data-mermaid-id="${id}">${esc(text)}</div>`;
        }
        const header = lang ? `<div class="pre-header">${esc(lang)}</div>` : '';
        const langClass = lang ? ` class="language-${esc(lang)}"` : '';
        return `${header}<pre><code${langClass}>${esc(text.replace(/\n$/, ''))}</code></pre>`;
      },
      // Links: open in new tab with security attributes
      link({ href, title, text, tokens }) {
        // marked v15: text is pre-rendered string, tokens are raw tokens
        // Fallback: use text directly if this.parser is unavailable
        const linkText = (this.parser && tokens) ? this.parser.parseInline(tokens) : (text || esc(href));
        return `<a href="${esc(href)}" target="_blank" rel="noopener"${title ? ` title="${esc(title)}"` : ''}>${linkText}</a>`;
      },
    },
  });
}

// ── Inline tool-XML transformation (OpenClaw-style safety net) ──────────────
// When models output tool calls as pseudo-XML (<write_to_file path="..." content="...">
// ...</write_to_file>) instead of via native function-calling, this pre-processor
// converts them into collapsible cards so users see a friendly summary instead of
// raw tag text. Matches only known tool names to avoid mangling legit markup.
const _INLINE_TOOL_NAMES = [
  'write_to_file','read_file','edit_file','patch','apply_patch','str_replace',
  'search_files','grep','find_files','list_dir',
  'terminal','shell','bash','execute_code','run_code','python','exec',
  'web_search','web_extract','web_fetch','browser_navigate','vision_analyze',
  'delegate_task','spawn_agent','steer_agent','list_agents','send_message',
  'send_group_message','group_message',
  'memory','skill_manage','todo','cronjob','subagent_progress',
  'tool_call','function_call','invoke','tool',
];
const _INLINE_TOOL_NAME_SET = new Set(_INLINE_TOOL_NAMES.map(n => n.toLowerCase()));

// Build a regex once for all known tool names; case-insensitive; greedy content match
const _INLINE_TOOL_RE = new RegExp(
  '<(' + _INLINE_TOOL_NAMES.map(n => n.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')).join('|') + ')\\b([^>]*)>([\\s\\S]*?)<\\/\\1\\s*>',
  'gi'
);
// Also detect unclosed opening tags (streaming in progress): <write_to_file ...>
const _INLINE_TOOL_OPEN_RE = new RegExp(
  '<(' + _INLINE_TOOL_NAMES.map(n => n.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')).join('|') + ')\\b([^>]*)>(?![\\s\\S]*?<\\/\\1\\s*>)',
  'gi'
);

function _parseXmlAttrs(attrStr) {
  const attrs = {};
  if (!attrStr) return attrs;
  // Match key="val" / key='val' / key=val(no quotes, up to next whitespace or >)
  const re = /([a-zA-Z_][\w-]*)\s*=\s*("([^"]*)"|'([^']*)'|([^\s"'>]+))/g;
  let m;
  while ((m = re.exec(attrStr)) !== null) {
    attrs[m[1]] = m[3] !== undefined ? m[3] : (m[4] !== undefined ? m[4] : (m[5] || ''));
  }
  return attrs;
}

function _buildInlineToolCardHtml(name, attrs, body, opts) {
  const unclosed = !!(opts && opts.unclosed);
  const icon = (typeof toolIcon === 'function') ? toolIcon(name) : '🔧';
  // Title: prefer meaningful attrs like path/command/query
  let summary = '';
  if (attrs.path) summary = attrs.path;
  else if (attrs.file_path) summary = attrs.file_path;
  else if (attrs.command) summary = attrs.command;
  else if (attrs.query) summary = attrs.query;
  else if (attrs.url) summary = attrs.url;
  else if (attrs.name) summary = attrs.name;
  else if (attrs.employee_name) summary = attrs.employee_name;
  const safeName = esc(name);
  const safeSummary = summary ? esc(String(summary).slice(0, 120)) : '';
  const statusBadge = unclosed
    ? '<span class="inline-tool-status inline-tool-status-pending">生成中</span>'
    : '<span class="inline-tool-status inline-tool-status-inline">内联调用</span>';

  // Render key attributes as a small table
  const attrRows = Object.entries(attrs)
    .filter(([k]) => k !== 'content' && k !== 'text')
    .slice(0, 10)
    .map(([k, v]) => `<tr><td class="inline-tool-k">${esc(k)}</td><td class="inline-tool-v">${esc(String(v).slice(0, 500))}</td></tr>`)
    .join('');
  const attrBlock = attrRows
    ? `<table class="inline-tool-attrs">${attrRows}</table>`
    : '';

  // Render content/body as preformatted text (trim to 4000 chars for safety)
  const bodyText = (body || attrs.content || attrs.text || '').toString();
  const bodyTrimmed = bodyText.length > 4000 ? bodyText.slice(0, 4000) + '\n...[truncated]' : bodyText;
  const bodyBlock = bodyTrimmed.trim()
    ? `<pre class="inline-tool-body">${esc(bodyTrimmed)}</pre>`
    : '';

  return (
    '<details class="inline-tool-card" data-tool="' + safeName + '">'
    + '<summary class="inline-tool-summary">'
    +   '<span class="inline-tool-icon">' + icon + '</span>'
    +   '<span class="inline-tool-name">' + safeName + '</span>'
    +   (safeSummary ? '<span class="inline-tool-target">' + safeSummary + '</span>' : '')
    +   statusBadge
    + '</summary>'
    + '<div class="inline-tool-detail">' + attrBlock + bodyBlock + '</div>'
    + '</details>'
  );
}

function _transformInlineToolXml(s) {
  if (!s || typeof s !== 'string') return s;
  // Quick check: any "<" + known-tool? If none, bail out cheap
  if (s.indexOf('<') < 0) return s;

  // Step 1: replace closed tool blocks
  s = s.replace(_INLINE_TOOL_RE, (full, name, attrs, body) => {
    if (!_INLINE_TOOL_NAME_SET.has(name.toLowerCase())) return full;
    const parsedAttrs = _parseXmlAttrs(attrs);
    return '\n\n' + _buildInlineToolCardHtml(name, parsedAttrs, body, { unclosed: false }) + '\n\n';
  });

  // Step 2: replace unclosed opening tags (in-progress streaming)
  s = s.replace(_INLINE_TOOL_OPEN_RE, (full, name, attrs) => {
    if (!_INLINE_TOOL_NAME_SET.has(name.toLowerCase())) return full;
    const parsedAttrs = _parseXmlAttrs(attrs);
    // Capture remaining text after this open tag and before next newline pair
    // as best-effort "body in progress"
    return '\n\n' + _buildInlineToolCardHtml(name, parsedAttrs, '', { unclosed: true }) + '\n\n';
  });

  return s;
}

function renderMd(raw) {
  let s = raw || '';
  // Pre-pass: decode HTML entities so markdown processing works correctly.
  // LLM outputs may contain &lt; &gt; &amp; which should be treated as their
  // actual characters before markdown parsing.
  const decode = s => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;/g, "'");
  s = decode(s);

  // ★ OpenClaw 风格：拦截并转换伪工具调用 XML
  //   模型有时会把工具调用以 <tool_name ...>...</tool_name> 的 XML 形式输出到可见文本，
  //   而不是通过原生 function-calling 通道。这里把它们渲染成折叠卡片，避免 "原始标签
  //   + 原始参数" 以纯文本形式泄漏给用户。
  s = _transformInlineToolXml(s);

  // ★ Thinking 标签处理（防泄漏）：
  //   1) 成对 <think>...</think> 及 Gemma <|channel>thought...<channel|> → 完整移除
  //      （这些内容应该通过 thinking-card 单独渲染，而不是混在 assistant 文本里）
  //   2) 孤立 </think> / 孤立 <think> / 未闭合 <think>... → 静默移除
  //   3) 任何残余的 <think> / </think> 字面量 → 剥掉（避免转义后作为可见文本出现）
  // 成对块
  s = s.replace(/<think>[\s\S]*?<\/think>\s*/gi, '');
  s = s.replace(/<\|channel>thought\n[\s\S]*?<channel\|>\s*/gi, '');
  // 未闭合 <think>... 到字符串末尾（流式输出截断场景）
  s = s.replace(/<think>[\s\S]*$/gi, '');
  s = s.replace(/<\|channel>thought\n[\s\S]*$/gi, '');
  // 孤立的单独标签
  s = s.replace(/<\/?think\s*>/gi, '');
  s = s.replace(/<channel\|>/gi, '');

  // Escape HTML comments: closed comments are fully escaped, lone <!-- are
  // escaped to prevent them from swallowing subsequent content.
  s = s.replace(/<!--[\s\S]*?-->/g, comment => esc(comment));
  s = s.replace(/<!--/g, '&lt;!--');

  // Ensure marked is initialized (wrap in try-catch to prevent breaking renderMd)
  try { _initMarked(); } catch(e) { console.warn('[renderMd] _initMarked failed:', e); }

  // Use marked.parse() for full GFM markdown rendering
  let html;
  try {
    html = marked.parse(s);
  } catch (e) {
    // Fallback: if marked fails, escape and wrap in paragraphs
    console.warn('[renderMd] marked.parse failed, falling back to escaped text:', e);
    html = '<p>' + esc(s).replace(/\n/g, '<br>') + '</p>';
  }

  // Post-process: sanitize any remaining unsafe HTML tags that marked may
  // have passed through (marked with sanitize:false allows HTML through).
  // Only allow tags from our known safe set.
  const SAFE_TAGS = /^<\/?(strong|em|code|pre|h[1-6]|ul|ol|li|table|thead|tbody|tr|th|td|hr|blockquote|p|br|a|div|span|sup|sub|details|summary|input|del|ins|mark|abbr|img)([\s>]|$)/i;
  html = html.replace(/<\/?[a-z][^>]*>/gi, tag => SAFE_TAGS.test(tag) ? tag : esc(tag));

  return html;
}

// ── Shared thinking-text extraction ──────────────────────────────────────────
// Extracts thinking blocks (full + in-progress) and remaining display text
// from raw LLM output that may contain <think>...</think> blocks or
// Gemma-style <|channel>thought...<channel|> blocks.
// Returns { thinking: string, text: string }.
const THINK_PAIRS = [
  { open: '\u003Cthink\u003E', close: '\u003C/think\u003E' },
  { open: '<|channel>thought\n', close: '<channel|>' },
];

function extractThinkingAndText(raw) {
  let thinkingParts = [];
  let remaining = raw;
  for (const { open, close } of THINK_PAIRS) {
    let idx = remaining.indexOf(open);
    while (idx !== -1) {
      const afterOpen = idx + open.length;
      const closeIdx = remaining.indexOf(close, afterOpen);
      if (closeIdx === -1) break;
      thinkingParts.push(remaining.slice(afterOpen, closeIdx).trim());
      remaining = remaining.slice(0, idx) + remaining.slice(closeIdx + close.length);
      idx = remaining.indexOf(open);
    }
  }
  // Check for in-progress (unclosed) thinking block
  for (const { open, close } of THINK_PAIRS) {
    const trimmed = remaining.trimStart();
    if (trimmed.startsWith(open)) {
      const closeIdx = trimmed.indexOf(close, open.length);
      if (closeIdx === -1) {
        thinkingParts.push(trimmed.slice(open.length).trim());
        return { thinking: thinkingParts.join('\n'), text: '' };
      }
    }
    if (open.startsWith(trimmed)) return { thinking: '', text: '' };
  }
  // Strip orphaned tags
  const cleanedText = remaining.replace(/^\s+/, '').replace(/<\/?think>/gi, '').trim();
  return { thinking: thinkingParts.join('\n'), text: cleanedText };
}

function setStatus(t){
  if(!t)return;
  showToast(t, 4000);
}

function setComposerStatus(t){
  const el=$('composerStatus');
  if(!el)return;
  if(!t){
    el.style.display='none';
    el.textContent='';
    return;
  }
  el.textContent=t;
  el.style.display='';
}

function updateSendBtn(){
  const btn=$('btnSend');
  if(!btn) return;
  const pendingFiles=S.pendingFiles||[];
  const hasContent=$('msg').value.trim().length>0||pendingFiles.length>0;
  const canSend=hasContent&&!S.busy;
  // Hide while busy (cancel button takes its place); show otherwise
  btn.style.display=S.busy?'none':'';
  btn.disabled=!canSend;
  if(canSend&&!btn.classList.contains('visible')){
    btn.classList.remove('visible');
    requestAnimationFrame(()=>btn.classList.add('visible'));
  }
}
function setBusy(v){
  S.busy=v;
  updateSendBtn();
  if(!v){
    setStatus('');
    setComposerStatus('');
    // Always hide Cancel button when not busy
    const _cb=$('btnCancel');if(_cb)_cb.style.display='none';
    updateQueueBadge();
    // 方案 B：释放 manual Job（推进员工队列）
    if(S._activeManualJobId && typeof DelegationVM!=='undefined'){
      try{
        const job=DelegationVM.findJob?DelegationVM.findJob(S._activeManualJobId):null;
        if(job){
          DelegationVM.completeJob(job.empId, job.id, 'done');
        }
      }catch(err){console.warn('[setBusy] completeJob err', err);}
      S._activeManualJobId=null;
    }
    // Drain one queued message after UI settles
    if(MSG_QUEUE.length>0){
      const next=MSG_QUEUE.shift();
      updateQueueBadge();
      setTimeout(()=>{ $('msg').value=next; send(); }, 120);
    }
  }
}

function updateQueueBadge(){
  let badge=$('queueBadge');
  if(MSG_QUEUE.length>0){
    if(!badge){
      badge=document.createElement('div');
      badge.id='queueBadge';
      badge.style.cssText='position:fixed;bottom:80px;right:24px;background:rgba(124,185,255,.18);border:1px solid rgba(124,185,255,.4);color:var(--blue);font-size:12px;font-weight:600;padding:6px 14px;border-radius:20px;z-index:50;pointer-events:none;backdrop-filter:blur(8px);';
      document.body.appendChild(badge);
    }
    badge.textContent=MSG_QUEUE.length===1?'1 message queued':`${MSG_QUEUE.length} messages queued`;
  } else {
    if(badge) badge.remove();
  }
}
function showToast(msg,ms){const el=$('toast');el.textContent=msg;el.classList.add('show');clearTimeout(el._t);el._t=setTimeout(()=>el.classList.remove('show'),ms||2800);}

// ── Shared app dialogs ───────────────────────────────────────────────────────
// showConfirmDialog(opts) and showPromptDialog(opts) replace browser-native dialog calls
// throughout the UI. Both return Promises and support: title, message, confirmLabel,
// cancelLabel, danger (confirm only), placeholder/value/inputType (prompt only).

const APP_DIALOG={resolve:null,kind:null,lastFocus:null};
let _appDialogBound=false;

function _isAppDialogOpen(){
  const overlay=$('appDialogOverlay');
  return !!(overlay&&overlay.style.display!=='none');
}

function _getAppDialogFocusable(){
  return [$('appDialogInput'), $('appDialogBrowseBtn'), $('appDialogCancel'), $('appDialogConfirm'), $('appDialogClose')]
    .filter(el=>el&&el.style.display!=='none'&&el.offsetParent!==null&&!el.disabled);
}

function _finishAppDialog(result, restoreFocus=true){
  const overlay=$('appDialogOverlay');
  const dialog=$('appDialog');
  const inputRow=$('appDialogInputRow');
  const input=$('appDialogInput');
  const confirmBtn=$('appDialogConfirm');
  const resolve=APP_DIALOG.resolve;
  const lastFocus=APP_DIALOG.lastFocus;
  APP_DIALOG.resolve=null;
  APP_DIALOG.kind=null;
  APP_DIALOG.lastFocus=null;
  if(overlay){overlay.style.display='none';overlay.setAttribute('aria-hidden','true');}
  if(dialog) dialog.setAttribute('role','dialog');
  if(inputRow) inputRow.style.display='none';
  if(input){input.value='';input.placeholder='';if(input._browseKeyHandler){input.removeEventListener('keydown',input._browseKeyHandler);input._browseKeyHandler=null;}}
  const browse=$('appDialogBrowse');if(browse) browse.style.display='none';
  if(confirmBtn){confirmBtn.classList.remove('danger');confirmBtn.textContent=t('dialog_confirm_btn');}
  if(restoreFocus&&lastFocus&&typeof lastFocus.focus==='function'){setTimeout(()=>lastFocus.focus(),0);}
  if(resolve) resolve(result);
}

function _ensureAppDialogBindings(){
  if(_appDialogBound) return;
  _appDialogBound=true;
  const overlay=$('appDialogOverlay');
  const cancelBtn=$('appDialogCancel');
  const confirmBtn=$('appDialogConfirm');
  const closeBtn=$('appDialogClose');
  if(overlay){
    overlay.addEventListener('click',e=>{
      if(e.target===overlay) _finishAppDialog(APP_DIALOG.kind==='prompt'?null:false);
    });
  }
  if(cancelBtn) cancelBtn.addEventListener('click',()=>_finishAppDialog(APP_DIALOG.kind==='prompt'?null:false));
  if(closeBtn)  closeBtn.addEventListener('click',()=>_finishAppDialog(APP_DIALOG.kind==='prompt'?null:false));
  if(confirmBtn){
    confirmBtn.addEventListener('click',()=>{
      if(APP_DIALOG.kind==='prompt'){
        const input=$('appDialogInput');
        _finishAppDialog(input?input.value:null);
      }else{
        _finishAppDialog(true);
      }
    });
  }
  document.addEventListener('keydown',e=>{
    if(!_isAppDialogOpen()) return;
    if(e.key==='Escape'){
      e.preventDefault();
      _finishAppDialog(APP_DIALOG.kind==='prompt'?null:false);
      return;
    }
    if(e.key==='Enter'){
      const target=e.target;
      const isTextarea=target&&target.tagName==='TEXTAREA';
      // 如果输入框处于浏览模式（有 _browseKeyHandler），让浏览处理器优先
      const dialogInput=$('appDialogInput');
      if(target===dialogInput&&dialogInput._browseKeyHandler&&dialogInput.value){
        // 不拦截，让 input 的 keydown 事件处理器处理（浏览到指定路径）
        return;
      }
      if(!isTextarea){
        e.preventDefault();
        if(target===cancelBtn||target===closeBtn){
          _finishAppDialog(APP_DIALOG.kind==='prompt'?null:false);
        }else if(APP_DIALOG.kind==='prompt'){
          const input=$('appDialogInput');
          _finishAppDialog(input?input.value:null);
        }else{
          _finishAppDialog(true);
        }
      }
      return;
    }
    if(e.key==='Tab'){
      const nodes=_getAppDialogFocusable();
      if(!nodes.length) return;
      const idx=nodes.indexOf(document.activeElement);
      let nextIdx=idx;
      if(e.shiftKey){nextIdx=idx<=0?nodes.length-1:idx-1;}
      else{nextIdx=idx===-1||idx===nodes.length-1?0:idx+1;}
      e.preventDefault();
      nodes[nextIdx].focus();
    }
  }, true);
}

function showConfirmDialog(opts={}){
  _ensureAppDialogBindings();
  if(APP_DIALOG.resolve) _finishAppDialog(false,false);
  const overlay=$('appDialogOverlay'),dialog=$('appDialog'),title=$('appDialogTitle'),
    desc=$('appDialogDesc'),input=$('appDialogInput'),cancelBtn=$('appDialogCancel'),confirmBtn=$('appDialogConfirm');
  const browseEl2=$('appDialogBrowse');if(browseEl2) browseEl2.style.display='none';
  const inputRow2=$('appDialogInputRow');if(inputRow2) inputRow2.style.display='none';
  APP_DIALOG.resolve=null;APP_DIALOG.kind='confirm';APP_DIALOG.lastFocus=document.activeElement;
  if(title) title.textContent=opts.title||t('dialog_confirm_title');
  if(desc) desc.textContent=opts.message||'';
  if(input){input.value='';}
  if(cancelBtn) cancelBtn.textContent=opts.cancelLabel||t('cancel');
  if(confirmBtn){
    confirmBtn.textContent=opts.confirmLabel||t('dialog_confirm_btn');
    confirmBtn.classList.toggle('danger',!!opts.danger);
  }
  if(dialog) dialog.setAttribute('role',opts.danger?'alertdialog':'dialog');
  if(overlay){overlay.style.display='flex';overlay.setAttribute('aria-hidden','false');}
  return new Promise(resolve=>{
    APP_DIALOG.resolve=resolve;
    setTimeout(()=>((opts.focusCancel?cancelBtn:confirmBtn)||confirmBtn||cancelBtn).focus(),0);
  });
}

function showPromptDialog(opts={}){
  _ensureAppDialogBindings();
  if(APP_DIALOG.resolve) _finishAppDialog(null,false);
  const overlay=$('appDialogOverlay'),dialog=$('appDialog'),title=$('appDialogTitle'),
    desc=$('appDialogDesc'),input=$('appDialogInput'),cancelBtn=$('appDialogCancel'),confirmBtn=$('appDialogConfirm');
  const browseEl=$('appDialogBrowse');if(browseEl) browseEl.style.display='none';
  const inputRow=$('appDialogInputRow');if(inputRow) inputRow.style.display='';
  const browseBtn2=$('appDialogBrowseBtn');if(browseBtn2) browseBtn2.style.display='none';
  APP_DIALOG.resolve=null;APP_DIALOG.kind='prompt';APP_DIALOG.lastFocus=document.activeElement;
  if(title) title.textContent=opts.title||t('dialog_prompt_title');
  if(desc) desc.textContent=opts.message||'';
  if(input){
    input.type=opts.inputType||'text';
    input.value=opts.value||'';input.placeholder=opts.placeholder||'';
    input.autocomplete='off';input.spellcheck=false;
  }
  if(cancelBtn) cancelBtn.textContent=opts.cancelLabel||t('cancel');
  if(confirmBtn){confirmBtn.textContent=opts.confirmLabel||t('create');confirmBtn.classList.remove('danger');}
  if(dialog) dialog.setAttribute('role','dialog');
  if(overlay){overlay.style.display='flex';overlay.setAttribute('aria-hidden','false');}
  return new Promise(resolve=>{
    APP_DIALOG.resolve=resolve;
    setTimeout(()=>{if(inputRow&&inputRow.style.display!=='none'&&input)input.focus();else if(confirmBtn)confirmBtn.focus();},0);
  });
}


function copyMsg(btn){
  const row=btn.closest('.msg-row');
  const text=row?row.dataset.rawText:'';
  if(!text)return;
  navigator.clipboard.writeText(text).then(()=>{
    const orig=btn.innerHTML;btn.innerHTML=li('check',13);btn.style.color='var(--blue)';
    setTimeout(()=>{btn.innerHTML=orig;btn.style.color='';},1500);
  }).catch(()=>showToast('Copy failed'));
}

// ── Reconnect banner (B4/B5: reload resilience) ──
const INFLIGHT_KEY = 'hermes-webui-inflight'; // localStorage key for in-flight session tracking

function markInflight(sid, streamId) {
  localStorage.setItem(INFLIGHT_KEY, JSON.stringify({sid, streamId, ts: Date.now()}));
}
function clearInflight() {
  localStorage.removeItem(INFLIGHT_KEY);
}
function showReconnectBanner(msg) {
  const el=$('reconnectMsg');if(el)el.textContent = msg || 'A response may have been in progress when you last left.';
  const b=$('reconnectBanner');if(b)b.classList.add('visible');
}
function dismissReconnect() {
  $('reconnectBanner').classList.remove('visible');
  clearInflight();
}
async function refreshSession() {
  dismissReconnect();
  if (!S.session) return;
  try {
    const data = await api(`/api/session?session_id=${encodeURIComponent(S.session.session_id)}`);
    S.session = data.session;
    S.messages = (data.session.messages || []).filter(m => {
      if (!m || !m.role || m.role === 'tool') return false;
      if (m.role === 'assistant') { let c = m.content || ''; if (Array.isArray(c)) c = c.map(p => p.text||'').join(''); return String(c).trim().length > 0; }
      return true;
    });
    syncTopbar(); renderMessages();
    showToast('Conversation refreshed');
  } catch(e) { setStatus('Refresh failed: ' + e.message); }
}
// ── Update banner ──
function _showUpdateBanner(data){
  const parts=[];
  if(data.webui&&data.webui.behind>0) parts.push(`WebUI: ${data.webui.behind} update${data.webui.behind>1?'s':''}`);
  if(data.agent&&data.agent.behind>0) parts.push(`Agent: ${data.agent.behind} update${data.agent.behind>1?'s':''}`);
  if(!parts.length)return;
  const msg=$('updateMsg');
  if(msg) msg.textContent='\u2B06 '+parts.join(', ')+' available';
  const banner=$('updateBanner');
  if(banner) banner.classList.add('visible');
  window._updateData=data;
}
function dismissUpdate(){
  const b=$('updateBanner');if(b)b.classList.remove('visible');
  sessionStorage.setItem('hermes-update-dismissed','1');
}
async function applyUpdates(){
  const btn=$('btnApplyUpdate');
  if(btn){btn.disabled=true;btn.textContent='Updating\u2026';}
  const targets=[];
  if(window._updateData?.webui?.behind>0) targets.push('webui');
  if(window._updateData?.agent?.behind>0) targets.push('agent');
  try{
    for(const target of targets){
      const res=await api('/api/updates/apply',{method:'POST',body:JSON.stringify({target})});
      if(!res.ok){
        showToast('Update failed ('+target+'): '+(res.message||'unknown error'));
        if(btn){btn.disabled=false;btn.textContent='Update Now';}
        return;
      }
    }
    showToast('Updated! Reloading\u2026');
    sessionStorage.removeItem('hermes-update-checked');
    sessionStorage.removeItem('hermes-update-dismissed');
    setTimeout(()=>location.reload(),1500);
  }catch(e){
    showToast('Update failed: '+e.message);
    if(btn){btn.disabled=false;btn.textContent='Update Now';}
  }
}

async function checkInflightOnBoot(sid) {
  const raw = localStorage.getItem(INFLIGHT_KEY);
  if (!raw) return;
  try {
    const {sid: inflightSid, streamId, ts} = JSON.parse(raw);
    if (inflightSid !== sid) { clearInflight(); return; }
    // Only show banner if the in-flight entry is less than 10 minutes old
    if (Date.now() - ts > 10 * 60 * 1000) { clearInflight(); return; }
    // Check if stream is still active
    const status = await api(`/api/chat/stream/status?stream_id=${encodeURIComponent(streamId || '')}`);
    if (status.active) {
      // Stream is genuinely still running -- show the banner
      showReconnectBanner(t('reconnect_active'));
    } else {
      // Stream finished. Only show banner if reload happened within 90 seconds
      // (longer gap = normal completed session, not a mid-stream reload)
      if (Date.now() - ts < 90 * 1000) {
        showReconnectBanner(t('reconnect_finished'));
      } else {
        clearInflight();  // completed normally, no banner needed
      }
    }
  } catch(e) { clearInflight(); }
}

// ── Knot 工作区标记（topbar badge） ─────────────────────────
let _knotBadgeLastWs = '';  // 上次检查的工作区路径（去重）
let _knotBadgeInFlight = false;
/**
 * 异步检查当前工作区是否已注册到 knot-cli，
 * 并在顶栏工作区名称旁显示/隐藏 Knot 标记。
 */
async function updateKnotBadge(wsPath) {
  const badge = document.getElementById('knotBadge');
  if (!badge) return;
  const ws = wsPath
    || (typeof _currentCanvasWorkspace !== 'undefined' && _currentCanvasWorkspace && _currentCanvasWorkspace !== '__default__' ? _currentCanvasWorkspace : '')
    || (S && S.session && S.session.workspace ? S.session.workspace : '');
  if (!ws) { badge.style.display = 'none'; _knotBadgeLastWs = ''; return; }
  // 同一路径不重复请求
  if (ws === _knotBadgeLastWs) return;
  if (_knotBadgeInFlight) return;
  _knotBadgeInFlight = true;
  try {
    const res = await api('/api/knot-cli/workspace/check', {
      method: 'POST',
      body: JSON.stringify({ path: ws })
    });
    _knotBadgeLastWs = ws;
    badge.style.display = (res && res.ok && res.registered) ? 'inline-flex' : 'none';
  } catch (e) {
    console.warn('[knot-badge] check failed:', e);
    badge.style.display = 'none';
  } finally {
    _knotBadgeInFlight = false;
  }
}

function syncTopbar(){
  // ★ 2026-04-27 Bug 修复：抽取出一个通用的"把当前工作区信息写到 #wsInfoBtn"逻辑，
  //   无论是否有 session 都应该让按钮显示工作区名——因为它本质是"工作区切换按钮"。
  //   同时把 document.title（浏览器 tab 标题）也一起更新，保持视觉一致。
  const _syncWsInfoBtn = () => {
    const _currentWs = (typeof _currentCanvasWorkspace !== 'undefined' && _currentCanvasWorkspace && _currentCanvasWorkspace !== '__default__')
      ? _currentCanvasWorkspace
      : ((S.session && S.session.workspace) ? S.session.workspace : '');
    if (!_currentWs) return ''; // 无工作区信息就保留 HTML 默认
    const wsName = typeof getWorkspaceFriendlyName === 'function'
      ? getWorkspaceFriendlyName(_currentWs)
      : _currentWs.split(/[\/\\]/).filter(Boolean).pop();
    const _ttW = $('topbarTitle'); if (_ttW) _ttW.textContent = wsName || _ttW.textContent;
    const _tmW = $('topbarMeta'); if (_tmW) _tmW.textContent = _currentWs;
    // ★ 2026-04-27(v2) Bug 修复：浏览器 tab 标题（document.title）原本用 sessionTitle
    //   （如 "Untitled"），与顶栏按钮不一致。改为统一优先使用工作区友好名：
    //   "GodotWorkspace — Hermes"。无工作区时回退到 botName。
    if (wsName) {
      document.title = wsName + ' \u2014 ' + (window._botName || 'Hermes');
    }
    return wsName || '';
  };

  if(!S.session){
    if(typeof syncWorkspaceDisplays==='function') syncWorkspaceDisplays();
    if(typeof syncModelChip==='function') syncModelChip();
    if(typeof _syncHermesPanelSessionActions==='function') _syncHermesPanelSessionActions();
    else {
      const sidebarName=$('sidebarWsName');
      if(sidebarName && sidebarName.textContent==='Workspace'){
        sidebarName.textContent=t('no_workspace');
      }
    }
    // ★ 无 session 时也要用 _currentCanvasWorkspace 更新顶部按钮 + document.title。
    //   如果 _syncWsInfoBtn 返回空字符串（无工作区信息），回退到 botName。
    const _wsName = _syncWsInfoBtn();
    if (!_wsName) {
      document.title = window._botName || 'Hermes';
    }
    return;
  }
  const sessionTitle=S.session.title||t('untitled');
  const _tt=$('topbarTitle');if(_tt)_tt.textContent=sessionTitle;
  // 先设一个兜底 title（万一下面 _syncWsInfoBtn 因没有工作区信息未覆盖，至少不为空白）
  document.title=sessionTitle+' \u2014 '+(window._botName||'Hermes');
  const vis=S.messages.filter(m=>m&&m.role&&m.role!=='tool');
  const _tm=$('topbarMeta');if(_tm)_tm.textContent=t('n_messages',vis.length);
  // If a profile switch just happened, apply its model rather than the session's stale value.
  // S._pendingProfileModel is set by switchToProfile() and cleared here after one application.
  const modelOverride=S._pendingProfileModel;
  let currentModel=S.session.model||'';
  if(modelOverride){
    S._pendingProfileModel=null;
    _applyModelToDropdown(modelOverride,$('modelSelect'));
    currentModel=modelOverride;
  } else {
    const applied=_applyModelToDropdown(currentModel,$('modelSelect'));
    // If the model isn't in the current provider list, add it as a visually marked
    // "(unavailable)" entry so the session value is preserved without misleading the user.
    // Selecting it will still attempt to send (same as before), but the label makes
    // clear it's a stale model from a previous session.
    //
    // ★ 2026-04-27 Bug 修复：只在 modelSelect 里已经有真实的 <optgroup> 时才
    //   追加 unavailable 条目。如果 populateModelDropdown 还没跑完 / 失败（modelSelect
    //   里只有 "Loading models…" 占位或 nothing），追加 unavailable 条目会让用户看到
    //   "Loading models... + xxx(unavailable)" 这种奇怪的组合且无法修复——populate
    //   成功后的 sel.innerHTML='' 会清掉 unavailable 条目，但 syncTopbar 的下一次调用
    //   又会再 append 一次，陷入循环。正确做法：populate 失败时这里什么也不做，
    //   让模型列表保持为空，renderModelDropdown 会 lazy-retry populate。
    const _ms = $('modelSelect');
    const _hasRealGroups = _ms && Array.from(_ms.children).some(c => c.tagName === 'OPTGROUP' && c.children.length > 0);
    if(!applied && currentModel && _hasRealGroups){
      const opt=document.createElement('option');
      opt.value=currentModel;
      opt.textContent=getModelLabel(currentModel)+t('model_unavailable');
      opt.style.color='var(--muted, #888)';
      opt.title=t('model_unavailable_title');
      _ms.appendChild(opt);
      _ms.value=currentModel;
    } else if(!applied && currentModel && !_hasRealGroups){
      // populate 还没跑完：只设 value（如果 option 存在会生效，否则保持原状），
      // 不追加 unavailable 条目。当 populate 成功后，会有新一次 syncTopbar 触发
      // 正常路径，或者 renderModelDropdown 里的 lazy-retry 填充后自动 sync。
      if (_ms) _ms.value = currentModel;
    }
  }
  if(typeof syncModelChip==='function') syncModelChip();
  // Show Clear button only when session has messages
  const clearBtn=$('btnClearConv');
  if(clearBtn) clearBtn.style.display=(S.messages&&S.messages.filter(msg=>msg.role!=='tool').length>0)?'':'none';
  if(typeof _syncHermesPanelSessionActions==='function') _syncHermesPanelSessionActions();
  if(typeof syncWorkspaceDisplays==='function') syncWorkspaceDisplays();
  // 员工模式下，topbar 显示工作区信息
  if(typeof syncWsSelectorLabel==='function') syncWsSelectorLabel();
  // ★ 2026-04-27 Bug 修复：topbar 按钮（#wsInfoBtn）是"工作区切换"按钮，
  //   原代码前面把 sessionTitle（"Untitled"）和 n_messages（"160 messages"）
  //   写到 #topbarTitle / #topbarMeta 上——与按钮语义不符。
  //   原覆盖逻辑只在 S.session.workspace 非空时执行；某些场景（session 刚从
  //   本地存储恢复、首次访问、workspace 字段为空串）下 S.session.workspace=''
  //   → 分支跳过 → 按钮残留 "Untitled / 160 messages"。
  //   修复：复用 _syncWsInfoBtn，优先使用 _currentCanvasWorkspace，与工作区
  //   下拉里"当前工作区"显示逻辑保持一致。
  _syncWsInfoBtn();
  // modelSelect already set above
  // Update profile chip label
  const profileLabel=$('profileChipLabel');
  if(profileLabel) profileLabel.textContent=S.activeProfile||'default';
  // ★ 异步更新 Knot 工作区标记
  if (typeof updateKnotBadge === 'function') updateKnotBadge();
}

function msgContent(m){
  // Extract plain text content from a message for filtering
  let c=m.content||'';
  if(Array.isArray(c))c=c.filter(p=>p&&p.type==='text').map(p=>p.text||'').join('').trim();
  return String(c).trim();
}

function renderMessages(){
  const inner=$('msgInner');
  const vis=S.messages.filter(m=>{
    if(!m||!m.role||m.role==='tool')return false;
    // Keep assistant messages with tool_use content even if they have no text,
    // so tool cards can be anchored to their DOM rows on page reload (#140).
    if(m.role==='assistant'&&Array.isArray(m.content)&&m.content.some(p=>p&&p.type==='tool_use'))return true;
    return msgContent(m)||m.attachments?.length||m.reasoning;
  });
  $('emptyState').style.display=vis.length?'none':'';
  inner.innerHTML='';
  // Track original indices (in S.messages) so truncate knows the cut point.
  // Also include assistant messages that have tool_calls (OpenAI format) or
  // tool_use content (Anthropic format) even when their text is empty — these
  // rows serve as DOM anchors for tool card insertion on page reload.
  const visWithIdx=[];
  let rawIdx=0;
  for(const m of S.messages){
    if(!m||!m.role||m.role==='tool'){rawIdx++;continue;}
    const hasTc=Array.isArray(m.tool_calls)&&m.tool_calls.length>0;
    const hasTu=Array.isArray(m.content)&&m.content.some(p=>p&&p.type==='tool_use');
    if(msgContent(m)||m.attachments?.length||m.reasoning||(m.role==='assistant'&&(hasTc||hasTu))) visWithIdx.push({m,rawIdx});
    rawIdx++;
  }
  for(let vi=0;vi<visWithIdx.length;vi++){
    const {m,rawIdx}=visWithIdx[vi];
    let content=m.content||'';
    // Extract thinking/reasoning blocks from structured content (Claude extended thinking, o3)
    let thinkingText='';
    if(Array.isArray(content)){
      thinkingText=content.filter(p=>p&&(p.type==='thinking'||p.type==='reasoning')).map(p=>p.thinking||p.reasoning||p.text||'').join('\n');
      content=content.filter(p=>p&&p.type==='text').map(p=>p.text||p.content||'').join('\n');
    }
    // Also check top-level reasoning field (Hermes format)
    if(!thinkingText && m.reasoning){
      thinkingText=m.reasoning;
    }
    // Parse inline thinking tags from plain text: <think>...</think> (DeepSeek, QwQ, MiniMax, etc.)
    // and Gemma 4 channel tokens: <|channel>thought\n...<channel|>
    // Note: no ^ anchor — some models emit leading whitespace/newlines before <think>.
    if(!thinkingText && typeof content==='string'){
      // Extract ALL <think> blocks (global replace) so leftover tags don't leak into rendered text
      const thinkRe=/<think>([\s\S]*?)<\/think>/g;
      const thinkingParts=[];
      let m;
      while((m=thinkRe.exec(content))!==null){
        thinkingParts.push(m[1].trim());
      }
      if(thinkingParts.length){
        thinkingText=thinkingParts.join('\n');
        content=content.replace(/<think>[\s\S]*?<\/think>\s*/g,'').trimStart().replace(/<\/?think>/gi,'').trim();
      }
      if(!thinkingText){
        const gemmaMatch=content.match(/<\|channel>thought\n([\s\S]*?)<channel\|>/);
        if(gemmaMatch){
          thinkingText=gemmaMatch[1].trim();
          content=content.replace(/<\|channel>thought\n[\s\S]*?<channel\|>\s*/g,'').trimStart();
        }
      }
    }
    const isUser=m.role==='user';
    const isLastAssistant=!isUser&&vi===visWithIdx.length-1;
    // Render thinking card before the assistant message (collapsed by default)
    if(thinkingText&&!isUser){
      const thinkRow=document.createElement('div');thinkRow.className='msg-row thinking-card-row';
      thinkRow.innerHTML=`<div class="thinking-card"><div class="thinking-card-header" onclick="this.parentElement.classList.toggle('open')"><span class="thinking-card-icon">${li('lightbulb',14)}</span><span class="thinking-card-label">${t('thinking')}</span><span class="thinking-card-toggle">${li('chevron-right',12)}</span></div><div class="thinking-card-body">${renderMd(thinkingText)}</div></div>`;
      inner.appendChild(thinkRow);
    }
    const row=document.createElement('div');row.className='msg-row';
    row.dataset.msgIdx=rawIdx;row.dataset.role=m.role||'assistant';
    let filesHtml='';
    if(m.attachments&&m.attachments.length)
      filesHtml=`<div class="msg-files">${m.attachments.map(f=>`<div class="msg-file-badge">${li('paperclip',12)} ${esc(f)}</div>`).join('')}</div>`;
    const bodyHtml = renderMd(String(content));
    // Action buttons for this bubble
    const editBtn  = isUser  ? `<button class="msg-action-btn" title="${t('edit_message')}" onclick="editMessage(this)">${li('pencil',13)}</button>` : '';
    const retryBtn = isLastAssistant ? `<button class="msg-action-btn" title="${t('regenerate')}" onclick="regenerateResponse(this)">${li('rotate-ccw',13)}</button>` : '';
    const tsVal=m._ts||m.timestamp;
    const tsTitle=tsVal?new Date(tsVal*1000).toLocaleString():'';
    const _bn=window._botName||'Hermes';
    row.innerHTML=`<div class="msg-role ${m.role}" ${tsTitle?`title="${esc(tsTitle)}"`:''}><div class="role-icon ${m.role}">${isUser?'Y':esc(_bn.charAt(0).toUpperCase())}</div><span style="font-size:12px">${isUser?t('you'):esc(_bn)}</span>${tsTitle?`<span class="msg-time">${new Date(tsVal*1000).toLocaleTimeString([],{hour:'2-digit',minute:'2-digit'})}</span>`:''}<span class="msg-actions">${editBtn}<button class="msg-copy-btn msg-action-btn" title="${t('copy')}" onclick="copyMsg(this)">${li('copy',13)}</button>${retryBtn}</span></div>${filesHtml}<div class="msg-body">${bodyHtml}</div>`;
    row.dataset.rawText = String(content).trim();
    inner.appendChild(row);
  }
  // Insert settled tool call cards (history view only).
  // During live streaming, tool cards are rendered in #liveToolCards by the
  // tool SSE handler and never mixed into the message list until done fires.
  //
  // Fallback: if S.toolCalls is empty (sessions that predate session-level tool
  // tracking, or runs that didn't go through the normal streaming path), build
  // a display list from per-message tool_calls (OpenAI format) stored in each
  // assistant message. This covers the reload case described in issue #140.
  if(!S.busy && (!S.toolCalls||!S.toolCalls.length)){
    const derived=[];
    S.messages.forEach((m,rawIdx)=>{
      if(m.role!=='assistant') return;
      (m.tool_calls||[]).forEach(tc=>{
        if(!tc||typeof tc!=='object') return;
        const fn=tc.function||{};
        const name=fn.name||tc.name||'tool';
        let args={};
        try{ args=JSON.parse(fn.arguments||'{}'); }catch(e){}
        let argsSnap={};
        Object.keys(args).slice(0,4).forEach(k=>{ const v=String(args[k]); argsSnap[k]=v.slice(0,120)+(v.length>120?'...':''); });
        derived.push({name,snippet:'',tid:tc.id||tc.call_id||'',assistant_msg_idx:rawIdx,args:argsSnap,done:true});
      });
    });
    if(derived.length) S.toolCalls=derived;
  }
  if(!S.busy && S.toolCalls && S.toolCalls.length){
    inner.querySelectorAll('.tool-card-row').forEach(el=>el.remove());
    const byAssistant = {};
    for(const tc of S.toolCalls){
      const key = tc.assistant_msg_idx !== undefined ? tc.assistant_msg_idx : -1;
      if(!byAssistant[key]) byAssistant[key] = [];
      byAssistant[key].push(tc);
    }
    const allRows = Array.from(inner.querySelectorAll('.msg-row[data-msg-idx]'));
    // Track the last inserted node per anchor so back-to-back groups for the
    // same (filtered) anchor row are inserted in chronological order.
    const anchorInsertAfter = new Map();
    for(const [key, cards] of Object.entries(byAssistant)){
      const aIdx = parseInt(key);
      // Find the right insertion point: cards go AFTER the assistant message
      // that triggered them. We look for the row at aIdx, or the nearest
      // visible ASSISTANT row at or before aIdx (the assistant message may be
      // filtered out if it contained only tool_use blocks with no text response).
      let anchorRow = null;
      if(aIdx >= 0){
        // First: exact match for the assistant row
        for(const r of allRows){
          const ri=parseInt(r.dataset.msgIdx||'-1');
          if(ri===aIdx){anchorRow=r;break;}
        }
        // Fallback: nearest visible ASSISTANT row at or before aIdx
        if(!anchorRow){
          for(let i=allRows.length-1;i>=0;i--){
            const ri=parseInt(allRows[i].dataset.msgIdx||'-1');
            if(ri<=aIdx&&S.messages[ri]&&S.messages[ri].role==='assistant'){anchorRow=allRows[i];break;}
          }
        }
      }
      // aIdx === -1 or no assistant anchor found: attach after the last assistant row
      if(!anchorRow){
        for(let i=allRows.length-1;i>=0;i--){
          const ri=parseInt(allRows[i].dataset.msgIdx||'-1',10);
          if(ri>=0&&S.messages[ri]&&S.messages[ri].role==='assistant'){anchorRow=allRows[i];break;}
        }
      }
      const frag=document.createDocumentFragment();
      for(const tc of cards){frag.appendChild(buildToolCard(tc));}
      // Add expand/collapse toggle for groups with 2+ cards
      if(cards.length>=2){
        const toggle=document.createElement('div');
        toggle.className='tool-cards-toggle';
        // Collect card elements before they get moved to DOM
        const cardEls=Array.from(frag.querySelectorAll('.tool-card'));
        const expandBtn=document.createElement('button');
        expandBtn.textContent=t('expand_all');
        expandBtn.onclick=()=>cardEls.forEach(c=>c.classList.add('open'));
        const collapseBtn=document.createElement('button');
        collapseBtn.textContent=t('collapse_all');
        collapseBtn.onclick=()=>cardEls.forEach(c=>c.classList.remove('open'));
        toggle.appendChild(expandBtn);
        toggle.appendChild(collapseBtn);
        frag.insertBefore(toggle,frag.firstChild);
      }
      // Insert after the anchor row (or after any previously inserted group for
      // the same anchor), preserving chronological order for multi-step chains.
      const insertAfterNode = anchorInsertAfter.get(anchorRow) || anchorRow;
      const refNode = insertAfterNode ? insertAfterNode.nextSibling : null;
      if(refNode) inner.insertBefore(frag,refNode);
      else inner.appendChild(frag);
      // Record the last child we inserted so the next group for this anchor
      // goes after it rather than back at anchorRow.nextSibling.
      anchorInsertAfter.set(anchorRow, inner.lastChild);
    }
  }
  // Render usage badge on the last assistant message row (if enabled and usage data exists)
  if(window._showTokenUsage&&S.session&&(S.session.input_tokens||S.session.output_tokens)){
    const rows=inner.querySelectorAll('.msg-row');
    let lastAssist=null;
    for(let i=rows.length-1;i>=0;i--){if(rows[i].dataset.role==='assistant'){lastAssist=rows[i];break;}}
    if(lastAssist&&!lastAssist.querySelector('.msg-usage')){
      const usage=document.createElement('div');
      usage.className='msg-usage';
      const inTok=S.session.input_tokens||0;
      const outTok=S.session.output_tokens||0;
      const cost=S.session.estimated_cost;
      let text=`${_fmtTokens(inTok)} in · ${_fmtTokens(outTok)} out`;
      if(cost) text+=` · ~$${cost<0.01?cost.toFixed(4):cost.toFixed(2)}`;
      usage.textContent=text;
      lastAssist.appendChild(usage);
    }
  }
  scrollToBottom();
  // Apply syntax highlighting after DOM is built
  requestAnimationFrame(()=>{highlightCode();addCopyButtons();renderMermaidBlocks();});
  // Refresh todo panel if it's currently open
  if(typeof loadTodos==='function' && document.getElementById('panelTodos') && document.getElementById('panelTodos').classList.contains('active')){
    loadTodos();
  }
}

function toolIcon(name){
  const icons={
    terminal:        li('terminal'),
    read_file:       li('file-text'),
    write_file:      li('file-pen'),
    search_files:    li('search'),
    web_search:      li('globe'),
    web_extract:     li('globe'),
    execute_code:    li('play'),
    patch:           li('wrench'),
    memory:          li('brain'),
    skill_manage:    li('book-open'),
    todo:            li('list-todo'),
    cronjob:         li('clock'),
    delegate_task:   li('bot'),
    send_message:    li('message-square'),
    browser_navigate:li('globe'),
    vision_analyze:  li('eye'),
    subagent_progress:li('shuffle'),
  };
  return icons[name]||li('wrench');
}

function buildToolCard(tc){
  const row=document.createElement('div');
  row.className='msg-row tool-card-row';
  const icon=toolIcon(tc.name);
  const hasDetail=tc.snippet||(tc.args&&Object.keys(tc.args).length>0);
  let displaySnippet='';
  if(tc.snippet){
    const s=tc.snippet;
    if(s.length<=220){displaySnippet=s;}
    else{
      const cutoff=s.slice(0,220);
      const lastBreak=Math.max(cutoff.lastIndexOf('. '),cutoff.lastIndexOf('\n'),cutoff.lastIndexOf('; '));
      displaySnippet=lastBreak>80?s.slice(0,lastBreak+1):cutoff;
    }
  }
  const hasMore=tc.snippet&&tc.snippet.length>displaySnippet.length;
  const runIndicator=tc.done===false?'<span class="tool-card-running-dot"></span>':'';
  const isSubagent=tc.name==='subagent_progress';
  const isDelegation=tc.name==='delegate_task';
  const isLocalExec=!!tc.localExecution;
  const isSkillTool=tc.name&&tc.name.startsWith('hermes_skill_');
  const cardClass='tool-card'+(tc.done===false?' tool-card-running':'')+(isSubagent?' tool-card-subagent':'')+(isLocalExec?' tool-card-local':'')+(isSkillTool?' tool-card-skill':'');
  // Clean up legacy subagent prefixes since the Lucide icon already shows it
  let displayName=tc.name;
  if(isSubagent) displayName='Subagent';
  if(isDelegation) displayName='Delegate task';
  if(isSkillTool) displayName=tc.name.replace('hermes_skill_','Skill: ');
  // ★ 本地执行标记
  const localBadge=isLocalExec?'<span class="tool-card-badge tool-card-badge-local" title="Executed locally by Hermes">Local</span>':'';
  const skillBadge=isSkillTool&&!isLocalExec?'<span class="tool-card-badge tool-card-badge-skill" title="Hermes Skill">Skill</span>':'';
  let previewText=tc.preview||displaySnippet||'';
  if(isSubagent) previewText=previewText.replace(/^(?:\u{1F500}|↳)\s*/u,'');
  row.innerHTML=`
    <div class="${cardClass}">
      <div class="tool-card-header" onclick="this.closest('.tool-card').classList.toggle('open')">
        ${runIndicator}
        <span class="tool-card-icon">${icon}</span>
        <span class="tool-card-name">${esc(displayName)}</span>
        ${localBadge}${skillBadge}
        <span class="tool-card-preview">${esc(previewText)}</span>
        ${hasDetail?'<span class="tool-card-toggle">▸</span>':''}
      </div>
      ${hasDetail?`<div class="tool-card-detail">
        ${tc.args&&Object.keys(tc.args).length?`<div class="tool-card-args">${
          Object.entries(tc.args).map(([k,v])=>`<div><span class="tool-arg-key">${esc(k)}</span> <span class="tool-arg-val">${esc(String(v))}</span></div>`).join('')
        }</div>`:''}
        ${displaySnippet?`<div class="tool-card-result">
          <pre>${esc(displaySnippet)}</pre>
          ${hasMore?`<button class="tool-card-more" data-full="${esc(tc.snippet||'').replace(/"/g,'&quot;')}" data-short="${esc(displaySnippet||'').replace(/"/g,'&quot;')}" onclick="event.stopPropagation();const p=this.previousElementSibling;const full=this.dataset.full;const short=this.dataset.short;p.textContent=p.textContent===short?full:short;this.textContent=p.textContent===short?'Show more':'Show less'">Show more</button>`:''}
        </div>`:''}
      </div>`:''}
    </div>`;
  return row;
}

// ── Live tool card helpers (called during SSE streaming) ──
function appendLiveToolCard(tc){
  const container=$('liveToolCards');
  if(!container)return;
  container.style.display='';
  // Update existing card if same tool call id (e.g. snippet arrives after done)
  const existing=container.querySelector(`[data-tid="${CSS.escape(tc.tid||'')}"]`);
  if(existing){existing.replaceWith(buildToolCard(tc));return;}
  const card=buildToolCard(tc);
  if(tc.tid)card.dataset.tid=tc.tid;
  container.appendChild(card);
}

function clearLiveToolCards(){
  const container=$('liveToolCards');
  if(!container)return;
  container.innerHTML='';
  container.style.display='none';
}

// ── Edit + Regenerate ──

function editMessage(btn) {
  if(S.busy) return;
  const row = btn.closest('.msg-row');
  if(!row) return;
  const msgIdx = parseInt(row.dataset.msgIdx, 10);
  const originalText = row.dataset.rawText || '';
  const body = row.querySelector('.msg-body');
  if(!body || row.dataset.editing) return;
  row.dataset.editing = '1';

  // Replace msg-body with an editable textarea
  const ta = document.createElement('textarea');
  ta.className = 'msg-edit-area';
  ta.value = originalText;
  body.replaceWith(ta);
  // Resize after DOM insertion so scrollHeight is correct
  requestAnimationFrame(() => { autoResizeTextarea(ta); ta.focus(); ta.setSelectionRange(ta.value.length, ta.value.length); });
  ta.addEventListener('input', () => autoResizeTextarea(ta));

  // Action bar below the textarea
  const bar = document.createElement('div');
  bar.className = 'msg-edit-bar';
  bar.innerHTML = `<button class="msg-edit-send">Send edit</button><button class="msg-edit-cancel">Cancel</button>`;
  ta.after(bar);

  bar.querySelector('.msg-edit-send').onclick = async () => {
    const newText = ta.value.trim();
    if(!newText) return;
    await submitEdit(msgIdx, newText);
  };
  bar.querySelector('.msg-edit-cancel').onclick = () => cancelEdit(row, originalText, body);

  ta.addEventListener('keydown', e => {
    if(e.key==='Enter' && !e.shiftKey) { e.preventDefault(); bar.querySelector('.msg-edit-send').click(); }
    if(e.key==='Escape') { e.preventDefault(); cancelEdit(row, originalText, body); }
  });
}

function cancelEdit(row, originalText, originalBody) {
  delete row.dataset.editing;
  const ta = row.querySelector('.msg-edit-area');
  const bar = row.querySelector('.msg-edit-bar');
  if(ta) ta.replaceWith(originalBody);
  if(bar) bar.remove();
}

function autoResizeTextarea(ta) {
  ta.style.height = 'auto';
  ta.style.height = Math.min(ta.scrollHeight, 300) + 'px';
}

async function submitEdit(msgIdx, newText) {
  if(!S.session || S.busy) return;
  // Truncate session at msgIdx (keep messages before the edited one)
  // then re-send the edited text
  try {
    await api('/api/session/truncate', {method:'POST', body:JSON.stringify({
      session_id: S.session.session_id,
      keep_count: msgIdx  // keep messages[0..msgIdx-1], discard from msgIdx onward
    })});
    S.messages = S.messages.slice(0, msgIdx);
    renderMessages();
    // Now send the edited message as a new chat
    $('msg').value = newText;
    await send();
  } catch(e) { setStatus(t('edit_failed') + e.message); }
}

async function regenerateResponse(btn) {
  if(!S.session || S.busy) return;
  // Find the last user message and re-run it
  // Remove the last assistant message first (truncate to before it)
  const row = btn.closest('.msg-row');
  if(!row) return;
  const assistantIdx = parseInt(row.dataset.msgIdx, 10);
  // Find the last user message text (one before this assistant message)
  let lastUserText = '';
  for(let i = assistantIdx - 1; i >= 0; i--) {
    const m = S.messages[i];
    if(m && m.role === 'user') { lastUserText = msgContent(m); break; }
  }
  if(!lastUserText) return;
  try {
    await api('/api/session/truncate', {method:'POST', body:JSON.stringify({
      session_id: S.session.session_id,
      keep_count: assistantIdx  // remove the assistant message
    })});
    S.messages = S.messages.slice(0, assistantIdx);
    renderMessages();
    $('msg').value = lastUserText;
    await send();
  } catch(e) { setStatus(t('regen_failed') + e.message); }
}

function highlightCode(container) {
  // Apply Prism.js syntax highlighting to all code blocks in container (or whole messages area)
  if(typeof Prism === 'undefined' || !Prism.highlightAllUnder) return;
  const el = container || $('msgInner');
  if(!el) return;
  Prism.highlightAllUnder(el);
}

function addCopyButtons(container){
  const el=container||$('msgInner');
  if(!el) return;
  el.querySelectorAll('pre > code').forEach(codeEl=>{
    const pre=codeEl.parentElement;
    if(pre.querySelector('.code-copy-btn')) return;
    const btn=document.createElement('button');
    btn.className='code-copy-btn';
    btn.textContent=t('copy');
    btn.onclick=(e)=>{
      e.stopPropagation();
      navigator.clipboard.writeText(codeEl.textContent).then(()=>{
        btn.textContent=t('copied');
        setTimeout(()=>{btn.textContent=t('copy');},1500);
      });
    };
    const header=pre.previousElementSibling;
    if(header&&header.classList.contains('pre-header')){
      header.style.display='flex';
      header.style.justifyContent='space-between';
      header.style.alignItems='center';
      header.appendChild(btn);
    }else{
      pre.style.position='relative';
      btn.style.cssText='position:absolute;top:6px;right:6px;';
      pre.appendChild(btn);
    }
  });
}

let _mermaidLoading=false;
let _mermaidReady=false;

function renderMermaidBlocks(){
  const blocks=document.querySelectorAll('.mermaid-block:not([data-rendered])');
  if(!blocks.length) return;
  if(!_mermaidReady){
    if(!_mermaidLoading){
      _mermaidLoading=true;
      const script=document.createElement('script');
      script.src='https://cdn.jsdelivr.net/npm/mermaid@10.9.3/dist/mermaid.min.js';
      script.integrity='sha384-R63zfMfSwJF4xCR11wXii+QUsbiBIdiDzDbtxia72oGWfkT7WHJfmD/I/eeHPJyT';
      script.crossOrigin='anonymous';
      script.onload=()=>{
        if(typeof mermaid!=='undefined'){
          mermaid.initialize({startOnLoad:false,theme:'dark',themeVariables:{
            primaryColor:'#4a6fa5',primaryTextColor:'#e2e8f0',lineColor:'#718096',
            secondaryColor:'#2d3748',tertiaryColor:'#1a202c',primaryBorderColor:'#4a5568',
          }});
          _mermaidReady=true;
          renderMermaidBlocks();
        }
      };
      document.head.appendChild(script);
    }
    return;
  }
  blocks.forEach(async(block)=>{
    block.dataset.rendered='true';
    const code=block.textContent;
    const id=block.dataset.mermaidId||('m-'+Math.random().toString(36).slice(2));
    try{
      const {svg}=await mermaid.render(id,code);
      block.innerHTML=svg;
      block.classList.add('mermaid-rendered');
    }catch(e){
      // Fall back to showing as a code block
      block.innerHTML=`<div class="pre-header">mermaid</div><pre><code>${esc(code)}</code></pre>`;
    }
  });
}

function appendThinking(){
  // REMOVED: 总群打开时不追加 thinking 行 — 总群概念已移除
  const emp = typeof EMPLOYEE_STORE!=='undefined'?getEmployee(EMPLOYEE_STORE.selectedId):null;
  const avatar = emp?emp.avatar:'🤖';
  const name = emp?emp.name:'Hermes';
  const inner = $('rpMsgInner');
  if(!inner) return;
  const emptyChat = $('rpEmptyChat');
  if(emptyChat) emptyChat.style.display='none';
  // ★ 员工模式下直接用 turn-row 的 Thinking 占位（与 messages.js 的流式渲染一致，
  //   避免 #thinkingRow → ensureAssistantRow 移除 → turn-row 的闪烁）
  const _rpView = window._rpView || null;
  if(emp && (!_rpView || _rpView === 'chat')){
    let turnRow = $('msgLiveTurnRow');
    if(!turnRow){
      turnRow = document.createElement('div');
      turnRow.className = 'rp-msg-row rp-turn';
      turnRow.id = 'msgLiveTurnRow';
      turnRow.dataset.role = 'assistant';
      turnRow.innerHTML = `
        <div class="rp-msg-role assistant">
          <span class="rp-msg-icon">${avatar}</span>
          <span class="rp-msg-name">${esc(name)}</span>
        </div>
        <div class="rp-turn-segments" id="msgLiveTurnSegments">
          <div class="rp-msg-body rp-turn-text" id="msgLiveStreamBody">
            <span style="color:var(--muted);font-size:13px">Thinking\u2026</span>
          </div>
        </div>
      `;
      inner.appendChild(turnRow);
    } else {
      // 已有 turn-row（上一轮流未正常结束）：清空 segments 并重建初始占位
      let segs = $('msgLiveTurnSegments');
      if(!segs){
        segs = document.createElement('div');
        segs.className = 'rp-turn-segments';
        segs.id = 'msgLiveTurnSegments';
        turnRow.appendChild(segs);
      }
      segs.innerHTML = '<div class="rp-msg-body rp-turn-text" id="msgLiveStreamBody"><span style="color:var(--muted);font-size:13px">Thinking\u2026</span></div>';
    }
    const msgArea = $('rpMessages');
    if(msgArea) msgArea.scrollTop = msgArea.scrollHeight;
    return;
  }
  const row=document.createElement('div');row.className='rp-msg-row';row.id='thinkingRow';
  row.innerHTML=`<div class="rp-msg-role assistant"><span class="rp-msg-icon">${avatar}</span><span class="rp-msg-name">${esc(name)}</span></div><div class="thinking" style="padding-left:22px"><div class="dot"></div><div class="dot"></div><div class="dot"></div></div>`;
  inner.appendChild(row);
  const msgArea = $('rpMessages');
  if(msgArea) msgArea.scrollTop = msgArea.scrollHeight;
}
function removeThinking(){const el=$('thinkingRow');if(el)el.remove();}

function fileIcon(name, type){
  if(type==='dir') return li('folder',14);
  const e=fileExt(name);
  if(IMAGE_EXTS.has(e)) return li('image',14);
  if(MD_EXTS.has(e))    return li('file-text',14);
  if(typeof DOWNLOAD_EXTS!=='undefined'&&DOWNLOAD_EXTS.has(e)) return li('download',14);
  if(e==='.py')   return li('file-code',14);
  if(e==='.js'||e==='.ts'||e==='.jsx'||e==='.tsx') return li('zap',14);
  if(e==='.json'||e==='.yaml'||e==='.yml'||e==='.toml') return li('settings',14);
  if(e==='.sh'||e==='.bash') return li('terminal',14);
  if(e==='.pdf') return li('download',14);
  return li('file-text',14);
}

function renderBreadcrumb(){
  const bar=$('breadcrumbBar');
  const upBtn=$('btnUpDir');
  if(!bar)return;
  if(S.currentDir==='.'){
    bar.style.display='none';
    if(upBtn)upBtn.style.display='none';
    return;
  }
  bar.style.display='flex';
  if(upBtn)upBtn.style.display='';
  bar.innerHTML='';
  // Root segment
  const root=document.createElement('span');
  root.className='breadcrumb-seg breadcrumb-link';
  root.textContent='~';
  root.onclick=()=>loadDir('.');
  bar.appendChild(root);
  // Path segments
  const parts=S.currentDir.split('/');
  let accumulated='';
  for(let i=0;i<parts.length;i++){
    const sep=document.createElement('span');
    sep.className='breadcrumb-sep';sep.textContent='/';
    bar.appendChild(sep);
    accumulated+=(accumulated?'/':'')+parts[i];
    const seg=document.createElement('span');
    seg.textContent=parts[i];
    if(i<parts.length-1){
      seg.className='breadcrumb-seg breadcrumb-link';
      const target=accumulated;
      seg.onclick=()=>loadDir(target);
    } else {
      seg.className='breadcrumb-seg breadcrumb-current';
    }
    bar.appendChild(seg);
  }
}

// Track expanded directories for tree view
if(!S._expandedDirs) S._expandedDirs=new Set();
// Cache of fetched directory contents: path -> entries[]
if(!S._dirCache) S._dirCache={};

function renderFileTree(){
  const box=$('fileTree');if(!box)return;
  // Cache current dir entries
  S._dirCache[S.currentDir||'.']=S.entries;
  const frag=document.createDocumentFragment();
  _renderTreeItems(frag, S.entries, 0);
  box.innerHTML='';
  box.appendChild(frag);
}

function _renderTreeItems(container, entries, depth){
  if(depth>20)return; // 防止无限递归
  for(const item of entries){
    const el=document.createElement('div');el.className='file-item';
    el.style.paddingLeft=(8+depth*16)+'px';

    if(item.type==='dir'){
      // Toggle arrow for directories
      const arrow=document.createElement('span');
      arrow.className='file-tree-toggle';
      const isExpanded=S._expandedDirs.has(item.path);
      arrow.textContent=isExpanded?'\u25BE':'\u25B8';
      el.appendChild(arrow);
    }

    // Icon
    const iconEl=document.createElement('span');
    iconEl.className='file-icon';iconEl.innerHTML=fileIcon(item.name,item.type);
    el.appendChild(iconEl);

    // Name
    const nameEl=document.createElement('span');
    nameEl.className='file-name';nameEl.textContent=item.name;nameEl.title=t('double_click_rename');
    nameEl.ondblclick=(e)=>{
      e.stopPropagation();
      // For directories, double-click navigates (breadcrumb view)
      if(item.type==='dir'){loadDir(item.path);return;}
      const inp=document.createElement('input');
      inp.className='file-rename-input';inp.value=item.name;
      inp.onclick=(e2)=>e2.stopPropagation();
      const finish=async(save)=>{
        inp.onblur=null;
        if(save){
          const newName=inp.value.trim();
          if(newName&&newName!==item.name){
            try{
              await api('/api/file/rename',{method:'POST',body:JSON.stringify({
                session_id:S.session.session_id,path:item.path,new_name:newName
              })});
              showToast(t('renamed_to')+newName);
              // Invalidate cache and re-render
              delete S._dirCache[S.currentDir];
              await loadDir(S.currentDir);
            }catch(err){showToast(t('rename_failed')+err.message);}
          }
        }
        inp.replaceWith(nameEl);
      };
      inp.onkeydown=(e2)=>{
        if(e2.key==='Enter'){e2.preventDefault();finish(true);}
        if(e2.key==='Escape'){e2.preventDefault();finish(false);}
      };
      inp.onblur=()=>finish(false);
      nameEl.replaceWith(inp);
      setTimeout(()=>{inp.focus();inp.select();},10);
    };
    el.appendChild(nameEl);

    // Size -- only for files
    if(item.type==='file'&&item.size){
      const sizeEl=document.createElement('span');
      sizeEl.className='file-size';
      sizeEl.textContent=`${(item.size/1024).toFixed(1)}k`;
      el.appendChild(sizeEl);
    }

    // Delete button -- for files (also available via right-click)
    if(item.type==='file'){
      const del=document.createElement('button');
      del.className='file-del-btn';del.title=t('delete_title');del.textContent='\u00d7';
      del.onclick=async(e)=>{e.stopPropagation();await deleteWorkspaceFile(item.path,item.name);};
      el.appendChild(del);
    }

    // Right-click context menu
    el.oncontextmenu=(e)=>{
      e.preventDefault();e.stopPropagation();
      _showFileCtxMenu(e.clientX, e.clientY, item);
    };

    if(item.type==='dir'){
      // Single-click toggles expand/collapse
      el.onclick=async(e)=>{
        e.stopPropagation();
        if(S._expandedDirs.has(item.path)){
          S._expandedDirs.delete(item.path);
          if(typeof _saveExpandedDirs==='function')_saveExpandedDirs();
          renderFileTree();
        }else{
          S._expandedDirs.add(item.path);
          if(typeof _saveExpandedDirs==='function')_saveExpandedDirs();
          // Fetch children if not cached
          if(!S._dirCache[item.path]){
            try{
              const _sid2=(S.session&&S.session.session_id)?encodeURIComponent(S.session.session_id):'';
              const _qs2=_sid2?`session_id=${_sid2}&path=${encodeURIComponent(item.path)}`:`path=${encodeURIComponent(item.path)}`;
              const data=await api(`/api/list?${_qs2}`);
              // 过滤掉 path 与父目录相同的自引用条目，防止无限递归
              const raw=data.entries||[];
              S._dirCache[item.path]=raw.filter(e=>e.path!==item.path);
            }catch(e2){S._dirCache[item.path]=[];}
          }
          renderFileTree();
        }
      };
    }else{
      el.onclick=async()=>{
        // 优先在右侧面板中打开文件预览
        if(typeof openFileInRightPanel==='function') openFileInRightPanel(item.path);
        else openFile(item.path);
      };
    }

    container.appendChild(el);

    // Render children if directory is expanded
    if(item.type==='dir'&&S._expandedDirs.has(item.path)){
      const children=S._dirCache[item.path]||[];
      if(children.length){
        _renderTreeItems(container, children, depth+1);
      }else{
        const empty=document.createElement('div');
        empty.className='file-item file-empty';
        empty.style.paddingLeft=(8+(depth+1)*16)+'px';
        empty.textContent=t('empty_dir');
        container.appendChild(empty);
      }
    }
  }
}

// ── File context menu (right-click) ──────────────────────────────────
function _closeFileCtxMenu(){
  const m=document.getElementById('fileCtxMenu');
  if(m)m.remove();
}

function _showFileCtxMenu(x, y, item){
  _closeFileCtxMenu();
  const menu=document.createElement('div');
  menu.id='fileCtxMenu';
  menu.className='file-ctx-menu';
  // Position: keep within viewport
  menu.style.left=Math.min(x, window.innerWidth-200)+'px';
  menu.style.top=Math.min(y, window.innerHeight-100)+'px';

  // Open in file manager
  const revealItem=document.createElement('div');
  revealItem.className='file-ctx-item';
  revealItem.innerHTML='📂 '+t('reveal_in_explorer','在资源管理器中打开');
  revealItem.onclick=async()=>{
    _closeFileCtxMenu();
    if(!S.session)return;
    try{
      const ws=_activeWorkspacePath();
      const res=await api('/api/file/reveal',{method:'POST',body:JSON.stringify({session_id:S.session.session_id,path:item.path,workspace:ws||undefined})});
      const hostPath=res.host_file_path||res.host_path;
      if(hostPath){
        // Docker environment: try host helper via WebUI proxy (avoids CORS)
        let helperOk=false;
        try{
          const helperRes=await fetch('/api/host/open?path='+encodeURIComponent(hostPath));
          const helperData=await helperRes.json();
          if(helperData.ok) helperOk=true;
        }catch(_e){
          console.warn('[reveal] host helper failed:', _e.message||_e);
        }
        if(helperOk){
          showToast(t('revealed','已打开'));
          return;
        }
        // Fallback: copy path and show hint
        try{await navigator.clipboard.writeText(hostPath);}catch(_e){}
        showToast(t('host_path_copied_fallback','已复制路径，若未自动打开请在资源管理器地址栏粘贴'));
      }else if(!res.hint){
        showToast(t('revealed','已打开'));
      }else{
        showToast(t('reveal_no_filemanager','无可用的文件管理器 (Docker环境)'));
      }
    }catch(e){showToast(t('reveal_failed','打开失败')+': '+e.message);}
  };
  menu.appendChild(revealItem);

  // Separator
  const sep=document.createElement('div');
  sep.className='file-ctx-sep';
  menu.appendChild(sep);

  // Delete
  const delItem=document.createElement('div');
  delItem.className='file-ctx-item danger';
  delItem.innerHTML='🗑️ '+t('delete_title','删除');
  delItem.onclick=async()=>{
    _closeFileCtxMenu();
    await deleteWorkspaceFile(item.path, item.name);
  };
  menu.appendChild(delItem);

  document.body.appendChild(menu);
  // Close on any click outside
  setTimeout(()=>{
    const close=()=>{_closeFileCtxMenu();document.removeEventListener('click',close);document.removeEventListener('contextmenu',close);};
    document.addEventListener('click',close);
    document.addEventListener('contextmenu',close);
  },0);
}

// ── In-browser directory viewer (Docker fallback) ─────────────────────
function _showInBrowserDirViewer(dirPath, highlightName, hostDirPath, hostFilePath, hostDirPathUrl, hostFilePathUrl){
  // Remove any existing viewer
  const existing=document.getElementById('dirViewerOverlay');
  if(existing) existing.remove();

  const overlay=document.createElement('div');
  overlay.id='dirViewerOverlay';
  overlay.className='dir-viewer-overlay';

  const panel=document.createElement('div');
  panel.className='dir-viewer';

  // Header
  const header=document.createElement('div');
  header.className='dir-viewer-header';

  const titleEl=document.createElement('div');
  titleEl.className='dir-viewer-title';
  titleEl.textContent=t('dir_viewer_title','目录浏览');

  const pathEl=document.createElement('div');
  pathEl.id='_dirViewerPath';
  pathEl.className='dir-viewer-path';
  pathEl.textContent=dirPath;

  const titleWrap=document.createElement('div');
  titleWrap.appendChild(titleEl);
  titleWrap.appendChild(pathEl);

  const closeBtn=document.createElement('button');
  closeBtn.className='dir-viewer-close';
  closeBtn.innerHTML='&#x2715;';
  closeBtn.onclick=()=>overlay.remove();

  header.appendChild(titleWrap);
  header.appendChild(closeBtn);
  panel.appendChild(header);

  // Host path info bar (Docker volume mapping)
  if(hostDirPath||hostFilePath){
    const hostBar=document.createElement('div');
    hostBar.className='dir-viewer-host';
    const hostLabel=document.createElement('div');
    hostLabel.className='dir-viewer-host-label';
    hostLabel.textContent=t('host_path_label','宿主机路径 (Docker映射)');
    hostBar.appendChild(hostLabel);
    const hostRow=document.createElement('div');
    hostRow.className='dir-viewer-host-row';
    const hostPathText=document.createElement('code');
    hostPathText.className='dir-viewer-host-code';
    hostPathText.textContent=hostFilePath||hostDirPath;
    hostRow.appendChild(hostPathText);
    // Copy button
    const copyBtn=document.createElement('button');
    copyBtn.className='dir-viewer-host-btn';
    copyBtn.textContent='📋';
    copyBtn.title=t('copy_host_path','复制宿主机路径');
    copyBtn.onclick=async()=>{
      try{
        await navigator.clipboard.writeText(hostFilePath||hostDirPath);
        copyBtn.textContent='✓';
        copyBtn.classList.add('copied');
        setTimeout(()=>{copyBtn.textContent='📋';copyBtn.classList.remove('copied');},1500);
      }catch(e){
        showToast(t('copy_failed','复制失败'));
      }
    };
    hostRow.appendChild(copyBtn);
    // Open in explorer button
    const openUrl=hostFilePathUrl||hostDirPathUrl;
    if(openUrl){
      const openBtn=document.createElement('button');
      openBtn.className='dir-viewer-open-btn';
      openBtn.innerHTML='📂 '+t('open_host_dir','打开目录');
      openBtn.title=t('open_host_dir_title','在宿主机资源管理器中打开此目录');
      openBtn.onclick=()=>{
        const a=document.createElement('a');
        a.href=openUrl;
        a.target='_blank';
        a.rel='noopener';
        document.body.appendChild(a);
        a.click();
        a.remove();
        navigator.clipboard.writeText(hostFilePath||hostDirPath).catch(()=>{});
        showToast(t('host_path_copied_fallback','已复制路径，若未自动打开请在资源管理器地址栏粘贴'));
      };
      hostRow.appendChild(openBtn);
    }
    hostBar.appendChild(hostRow);
    panel.appendChild(hostBar);
  }

  // File list
  const listWrap=document.createElement('div');
  listWrap.className='dir-viewer-list';
  listWrap.id='_dirViewerList';

  panel.appendChild(listWrap);
  overlay.appendChild(panel);
  document.body.appendChild(overlay);

  // Close on backdrop click
  overlay.onclick=(e)=>{if(e.target===overlay)overlay.remove();};

  // Load directory contents
  _loadDirViewerContents(dirPath, highlightName);
}

async function _loadDirViewerContents(dirPath, highlightName){
  const listWrap=document.getElementById('_dirViewerList');
  const pathEl=document.getElementById('_dirViewerPath');
  if(!listWrap) return;
  if(pathEl) pathEl.textContent=dirPath;
  listWrap.innerHTML='<div class="dir-viewer-empty">Loading…</div>';
  try{
    const data=await api('/api/browse-dir?path='+encodeURIComponent(dirPath)+'&include_files=true');
    listWrap.innerHTML='';

    // Parent directory link
    if(data.parent!==null&&data.parent!==undefined){
      const parentItem=document.createElement('div');
      parentItem.className='dir-viewer-item parent';
      parentItem.textContent='📁 ..';
      parentItem.onclick=()=>_loadDirViewerContents(data.parent,'');
      listWrap.appendChild(parentItem);
    }

    // Directories
    const dirs=data.dirs||[];
    for(const d of dirs){
      const item=document.createElement('div');
      const isHighlight=highlightName&&d.name===highlightName;
      item.className='dir-viewer-item'+(isHighlight?' highlight':'');
      item.textContent='📁 '+d.name;
      item.onclick=()=>_loadDirViewerContents(d.path,'');
      listWrap.appendChild(item);
    }

    // Files
    const files=data.files||[];
    for(const f of files){
      const item=document.createElement('div');
      const isHighlight=highlightName&&f.name===highlightName;
      const sizeStr=f.size!=null?'<span class="dv-size">'+Math.round(f.size/1024)+'KB</span>':'';
      item.className='dir-viewer-item file'+(isHighlight?' highlight':'');
      item.innerHTML='📄 '+esc(f.name)+sizeStr;
      listWrap.appendChild(item);
    }

    if(!dirs.length&&!files.length){
      const empty=document.createElement('div');
      empty.className='dir-viewer-empty';
      empty.textContent=t('dir_viewer_empty','(空目录)');
      listWrap.appendChild(empty);
    }
  }catch(e){
    listWrap.innerHTML='<div class="dir-viewer-empty" style="color:var(--error,#f44)">Failed to load: '+esc(e.message)+'</div>';
  }
}

async function deleteWorkspaceFile(relPath, name){
  console.log('[deleteWorkspaceFile] called', {relPath, name, session: !!S.session});
  if(!S.session){showToast('No active session');return;}
  const displayName = name || relPath || 'file';
  // Step 1: Confirm dialog
  let confirmed = false;
  try{
    confirmed = await showConfirmDialog({title:t('delete_confirm',displayName),message:'',confirmLabel:'Delete',danger:true,focusCancel:true});
  }catch(e){console.warn('[deleteWorkspaceFile] Confirm dialog error:',e);return;}
  if(!confirmed) return;
  // Step 2: API call
  try{
    const sid = S.session && S.session.session_id ? S.session.session_id : '';
    console.log('[deleteWorkspaceFile] Deleting via API', {sid, relPath});
    await api('/api/file/delete',{method:'POST',body:JSON.stringify({session_id:sid,path:relPath})});
  }catch(e){
    console.error('[deleteWorkspaceFile] API error:', e);
    showToast(t('delete_failed')+(e&&e.message?e.message:String(e)));
    return;
  }
  showToast(t('deleted')+displayName);
  // Step 3: Close file preview in right panel if we just deleted the viewed file
  try{
    const rpFilePathEl=$('rpFilePath');
    if(rpFilePathEl && rpFilePathEl.textContent === relPath){
      if(typeof closeRpFilePreview==='function') closeRpFilePreview();
    }
  }catch(e){console.warn('[deleteWorkspaceFile] preview cleanup error:',e);}
  // Step 4: Refresh file tree
  try{await loadDir(S.currentDir||'.');}catch(e){console.warn('[deleteWorkspaceFile] refresh error:',e);}
}

async function promptNewFile(){
  if(!S.session)return;
  const name=await showPromptDialog({title:t('new_file_prompt'),placeholder:'filename.txt',confirmLabel:t('create')});
  if(!name||!name.trim())return;
  const relPath=S.currentDir==='.'?name.trim():(S.currentDir+'/'+name.trim());
  try{
    await api('/api/file/create',{method:'POST',body:JSON.stringify({session_id:S.session.session_id,path:relPath,content:''})});
    showToast(t('created')+name.trim());
    await loadDir(S.currentDir);
    openFile(relPath);
  }catch(e){setStatus(t('create_failed')+e.message);}
}

async function promptNewFolder(){
  if(!S.session)return;
  const name=await showPromptDialog({title:t('new_folder_prompt'),placeholder:'folder-name',confirmLabel:t('create')});
  if(!name||!name.trim())return;
  const relPath=S.currentDir==='.'?name.trim():(S.currentDir+'/'+name.trim());
  try{
    await api('/api/file/create-dir',{method:'POST',body:JSON.stringify({session_id:S.session.session_id,path:relPath})});
    showToast(t('folder_created')+name.trim());
    await loadDir(S.currentDir);
  }catch(e){setStatus(t('folder_create_failed')+e.message);}
}

function renderTray(){
  const tray=$('attachTray');tray.innerHTML='';
  const pendingFiles=S.pendingFiles||[];
  if(!pendingFiles.length){tray.classList.remove('has-files');updateSendBtn();return;}
  tray.classList.add('has-files');
  updateSendBtn();
  pendingFiles.forEach((f,i)=>{
    const chip=document.createElement('div');chip.className='attach-chip';
    chip.innerHTML=`${li('paperclip',12)} ${esc(f.name)} <button title="${t('remove_title')}">${li('x',12)}</button>`;
    chip.querySelector('button').onclick=()=>{S.pendingFiles.splice(i,1);renderTray();};
    tray.appendChild(chip);
  });
}
function addFiles(files){if(!S.pendingFiles)S.pendingFiles=[];for(const f of files){if(!S.pendingFiles.find(p=>p.name===f.name))S.pendingFiles.push(f);}renderTray();}

async function uploadPendingFiles(){
  const pendingFiles=S.pendingFiles||[];
  if(!pendingFiles.length||!S.session)return[];
  const names=[];let failures=0;
  const bar=$('uploadBar');const barWrap=$('uploadBarWrap');
  barWrap.classList.add('active');bar.style.width='0%';
  const total=pendingFiles.length;
  for(let i=0;i<total;i++){
    const f=pendingFiles[i];const fd=new FormData();
    fd.append('session_id',S.session.session_id);fd.append('file',f,f.name);
    try{
      const res=await fetch(new URL('/api/upload',location.origin).href,{method:'POST',credentials:'include',body:fd});
      if(!res.ok){const err=await res.text();throw new Error(err);}
      const data=await res.json();
      if(data.error)throw new Error(data.error);
      names.push(data.filename);
    }catch(e){failures++;setStatus(`\u274c ${t('upload_failed')}${f.name} \u2014 ${e.message}`);}
    bar.style.width=`${Math.round((i+1)/total*100)}%`;
  }
  barWrap.classList.remove('active');bar.style.width='0%';
  S.pendingFiles=[];renderTray();
  if(failures===total&&total>0)throw new Error(t('all_uploads_failed',total));
  return names;
}

