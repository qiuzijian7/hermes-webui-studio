async function api(path,opts={}){
  const url=new URL(path,location.origin);
  const res=await fetch(url.href,{credentials:'include',headers:{'Content-Type':'application/json'},...opts});
  if(!res.ok){
    const text=await res.text();
    // Parse JSON error body and surface the human-readable message,
    // rather than showing raw JSON like {"error":"Profile 'x' does not exist."}
    try{const j=JSON.parse(text);throw new Error(j.error||j.message||text);}
    catch(e){if(e instanceof SyntaxError)throw new Error(text);throw e;}
  }
  const ct=res.headers.get('content-type')||'';
  return ct.includes('application/json')?res.json():res.text();
}

// Persist/restore expanded directory state per workspace in localStorage
function _wsExpandKey(){
  const ws=_activeWorkspacePath();
  return ws?'hermes-webui-expanded:'+ws:null;
}
function _saveExpandedDirs(){
  const key=_wsExpandKey();if(!key)return;
  try{localStorage.setItem(key,JSON.stringify([...(S._expandedDirs||new Set())]));}catch(e){}
}
function _restoreExpandedDirs(){
  const key=_wsExpandKey();
  if(!key){S._expandedDirs=new Set();return;}
  try{
    const raw=localStorage.getItem(key);
    S._expandedDirs=raw?new Set(JSON.parse(raw)):new Set();
  }catch(e){S._expandedDirs=new Set();}
}

/** 获取当前活跃的工作区路径（画布工作区优先于 session.workspace） */
function _activeWorkspacePath(){
  const canvasWs=(typeof _currentCanvasWorkspace!=='undefined')?_currentCanvasWorkspace:'';
  if(canvasWs&&canvasWs!=='__default__') return canvasWs;
  return (S.session&&S.session.workspace)||'';
}

async function loadDir(path){
  // 如果 session workspace 与画布工作区不一致，先同步
  const activeWs=_activeWorkspacePath();
  if(S.session&&S.session.workspace!==activeWs&&activeWs&&activeWs!=='__default__'){
    try{
      await api('/api/session/update',{method:'POST',body:JSON.stringify({
        session_id:S.session.session_id,workspace:activeWs,model:S.session.model
      })});
      S.session.workspace=activeWs;
    }catch(e){}
  }
  const sid=(S.session&&S.session.session_id)?encodeURIComponent(S.session.session_id):'';
  // Reset the auto-load guard so _renderMainFileTree knows a load was triggered externally
  S._dirLoadAttempted = true;
  try{
    if(!path||path==='.'){
      S._dirCache={};
      _restoreExpandedDirs();  // restore per-workspace expanded state on root load
    }else{
      // Invalidate cache for the target dir so fresh data is always fetched
      delete S._dirCache[path];
    }
    S.currentDir=path||'.';
    const listQs=sid?`session_id=${sid}&path=${encodeURIComponent(path)}`:`path=${encodeURIComponent(path)}`;
    const data=await api(`/api/list?${listQs}`);
    S.entries=data.entries||[];renderBreadcrumb();renderFileTree();
    // Re-fetch contents of expanded dirs so new/deleted files show immediately
    if(!path||path==='.'){
      for(const dirPath of (S._expandedDirs||[])){
        try{
          const dcQs=sid?`session_id=${sid}&path=${encodeURIComponent(dirPath)}`:`path=${encodeURIComponent(dirPath)}`;
          const dc=await api(`/api/list?${dcQs}`);
          S._dirCache[dirPath]=dc.entries||[];
        }catch(e2){S._dirCache[dirPath]=[];}
      }
      if(S._expandedDirs&&S._expandedDirs.size>0)renderFileTree();
    }
    if(typeof clearPreview==='function'){
      if(typeof _previewDirty!=='undefined'&&_previewDirty){
        showConfirmDialog({title:t('unsaved_confirm'),message:'',confirmLabel:'Discard',danger:true,focusCancel:true}).then(ok=>{if(ok)clearPreview();});
      }else{
        clearPreview();
      }
    }
    // Fetch git info for workspace root (non-blocking)
    if(!path||path==='.') _refreshGitBadge();
  }catch(e){
    console.warn('loadDir',e);
    // If session not found (server restart), clear stale session reference
    if(e.message&&e.message.includes('not found')&&S.session){
      console.warn('[loadDir] Session not found, clearing stale session');
      S.session=null;
      localStorage.removeItem('hermes-webui-session');
      S.entries=[];
      if(typeof renderBreadcrumb==='function')renderBreadcrumb();
      if(typeof renderFileTree==='function')renderFileTree();
    }
  }
}

async function _refreshGitBadge(){
  const badge=$('gitBadge');
  if(!badge||!S.session)return;
  try{
    const data=await api(`/api/git-info?session_id=${encodeURIComponent(S.session.session_id)}`);
    if(data.git&&data.git.is_git){
      const g=data.git;
      let text=g.branch||'git';
      if(g.dirty>0) text+=` \u00b7 ${g.dirty}\u2206`; // middot + delta
      if(g.behind>0) text+=` \u2193${g.behind}`;
      if(g.ahead>0) text+=` \u2191${g.ahead}`;
      badge.textContent=text;
      badge.className='git-badge'+(g.dirty>0?' dirty':'');
      badge.style.display='';
    } else {
      badge.style.display='none';
      badge.textContent='';
    }
  }catch(e){badge.style.display='none';}
}

function navigateUp(){
  if(S.currentDir==='.')return;
  const parts=S.currentDir.split('/');
  parts.pop();
  loadDir(parts.length?parts.join('/'):'.');
}

// File extension sets for preview routing (must match server-side sets)
const IMAGE_EXTS  = new Set(['.png','.jpg','.jpeg','.gif','.svg','.webp','.ico','.bmp']);
const MD_EXTS     = new Set(['.md','.markdown','.mdown']);
// Binary formats that should download rather than preview
const DOWNLOAD_EXTS = new Set([
  '.docx','.doc','.xlsx','.xls','.pptx','.ppt','.odt','.ods','.odp',
  '.pdf','.zip','.tar','.gz','.bz2','.7z','.rar',
  '.mp3','.mp4','.wav','.m4a','.ogg','.flac','.mov','.avi','.mkv','.webm',
  '.exe','.dmg','.pkg','.deb','.rpm',
  '.woff','.woff2','.ttf','.otf','.eot',
  '.bin','.dat','.db','.sqlite','.pyc','.class','.so','.dylib','.dll',
]);

function fileExt(p){ const i=p.lastIndexOf('.'); return i>=0?p.slice(i).toLowerCase():''; }

let _previewCurrentPath = '';  // relative path of currently previewed file
let _previewCurrentMode = '';  // 'code' | 'md' | 'image'
let _previewDirty = false;     // true when edits are unsaved

function showPreview(mode){
  // mode: 'code' | 'image' | 'md'
  const _pc=$('previewCode');if(_pc)_pc.style.display=mode==='code'?'':'none';
  const _piw=$('previewImgWrap');if(_piw)_piw.style.display=mode==='image'?'':'none';
  const _pm=$('previewMd');if(_pm)_pm.style.display=mode==='md'?'':'none';
  const _pea=$('previewEditArea');if(_pea)_pea.style.display='none';
  const badge=$('previewBadge');
  const _ppt=$('previewPathText');
  if(badge){
    badge.className='preview-badge '+mode;
    badge.textContent = mode==='image'?'image':mode==='md'?'md':fileExt(_ppt?_ppt.textContent:'')||'text';
  }
  _previewCurrentMode = mode;
  _previewDirty = false;
  updateEditBtn();
}

function updateEditBtn(){
  const btn=$('btnEditFile');
  if(!btn)return;
  const editable = _previewCurrentMode==='code'||_previewCurrentMode==='md';
  btn.style.display = editable?'':'none';
  const _pea=$('previewEditArea');
  const editing = _pea?_pea.style.display!=='none':false;
  btn.innerHTML = editing ? `&#128190; ${t('save')}` : `&#9998; ${t('edit')}`;
  btn.title = editing ? t('save_title') : t('edit_title');
  btn.style.color = editing ? 'var(--blue)' : '';
  if(_previewDirty) btn.innerHTML = '&#128190; Save*';
}

async function toggleEditMode(){
  const _pea=$('previewEditArea');
  const editing = _pea?_pea.style.display!=='none':false;
  if(editing){
    // Save
    if(!S.session||!_previewCurrentPath)return;
    const content=_pea?_pea.value:'';
    try{
      await api('/api/file/save',{method:'POST',body:JSON.stringify({
        session_id:S.session.session_id, path:_previewCurrentPath, content
      })});
      _previewDirty=false;
      // Update read-only views
      const _pc=$('previewCode');
      const _pm=$('previewMd');
      if(_previewCurrentMode==='code'&&_pc)_pc.textContent=content;
      else if(_pm)_pm.innerHTML=renderMd(content);
      if(_pea)_pea.style.display='none';
      if(_previewCurrentMode==='code'&&_pc)_pc.style.display='';
      else if(_pm)_pm.style.display='';
      showToast(t('saved'));
    }catch(e){setStatus(t('save_failed')+e.message);}
  }else{
    // Enter edit mode: populate textarea with current content
    const _pc=$('previewCode');
    const _pm=$('previewMd');
    const currentText = _previewCurrentMode==='code'
      ? (_pc?_pc.textContent:'')
      : _previewRawContent||'';
    if(_pea)_pea.value=currentText;
    if(_pea)_pea.style.display='';
    if(_previewCurrentMode==='code'&&_pc)_pc.style.display='none';
    else if(_pm)_pm.style.display='none';
    // Escape cancels the edit without saving
    if(_pea)_pea.onkeydown=e=>{
      if(e.key==='Escape'){e.preventDefault();cancelEditMode();}
    };
  }
  updateEditBtn();
}

let _previewRawContent = '';  // raw text for md files (to populate editor)

function cancelEditMode(){
  // Discard changes and return to read-only view
  const _pea=$('previewEditArea');
  const _pc=$('previewCode');
  const _pm=$('previewMd');
  if(_pea)_pea.style.display='none';
  if(_pea)_pea.onkeydown=null;
  if(_previewCurrentMode==='code'&&_pc)_pc.style.display='';
  else if(_pm)_pm.style.display='';
  _previewDirty=false;
  updateEditBtn();
}

async function openFile(path){
  if(!S.session)return;
  const ext=fileExt(path);

  // Binary/download-only formats: trigger browser download, don't preview
  if(DOWNLOAD_EXTS.has(ext)){
    downloadFile(path);
    return;
  }

  const _ppt=$('previewPathText');if(_ppt)_ppt.textContent=path;
  const _pa=$('previewArea');if(_pa)_pa.classList.add('visible');
  const _ft=$('fileTree');if(_ft)_ft.style.display='none';

  _previewCurrentPath = path;
  renderFileBreadcrumb(path);
  if(IMAGE_EXTS.has(ext)){
    // Image: load via raw endpoint, show as <img>
    showPreview('image');
    const url=`/api/file/raw?session_id=${encodeURIComponent(S.session.session_id)}&path=${encodeURIComponent(path)}`;
    const _pImg=$('previewImg');if(_pImg){_pImg.alt=path;_pImg.src=url;_pImg.onerror=()=>setStatus(t('image_load_failed'));}
  } else if(MD_EXTS.has(ext)){
    // Markdown: fetch text, render with renderMd, display as formatted HTML
    try{
      const data=await api(`/api/file?session_id=${encodeURIComponent(S.session.session_id)}&path=${encodeURIComponent(path)}`);
      showPreview('md');
      _previewRawContent = data.content;
      const _pm=$('previewMd');if(_pm)_pm.innerHTML=renderMd(data.content);
    }catch(e){setStatus(t('file_open_failed'));}
  } else {
    // Plain code / text -- but fall back to download if server signals binary
    try{
      const data=await api(`/api/file?session_id=${encodeURIComponent(S.session.session_id)}&path=${encodeURIComponent(path)}`);
      if(data.binary){
        // Server flagged this as binary content
        downloadFile(path);
        return;
      }
      showPreview('code');
      const _pc=$('previewCode');if(_pc)_pc.textContent=data.content;
    }catch(e){
      // If it's a 400/too-large error, offer download instead
      downloadFile(path);
    }
  }
}

function downloadFile(path){
  if(!S.session)return;
  // Trigger browser download via the raw file endpoint with content-disposition attachment
  const url=`/api/file/raw?session_id=${encodeURIComponent(S.session.session_id)}&path=${encodeURIComponent(path)}&download=1`;
  const filename=path.split('/').pop();
  const a=document.createElement('a');
  a.href=url;a.download=filename;
  document.body.appendChild(a);a.click();
  setTimeout(()=>document.body.removeChild(a),100);
  showToast(t('downloading',filename),2000);
}


// ── Render breadcrumb for file preview mode ──────────────────────────────────
function renderFileBreadcrumb(filePath) {
  const bar = $('breadcrumbBar');
  if (!bar) return;
  bar.style.display = 'flex';
  const upBtn = $('btnUpDir');
  if (upBtn) upBtn.style.display = '';

  bar.innerHTML = '';
  // Root
  const root = document.createElement('span');
  root.className = 'breadcrumb-seg breadcrumb-link';
  root.textContent = '~';
  root.onclick = () => { clearPreview(); loadDir('.'); };
  bar.appendChild(root);

  const parts = filePath.split('/');
  let accumulated = '';
  for (let i = 0; i < parts.length; i++) {
    const sep = document.createElement('span');
    sep.className = 'breadcrumb-sep';
    sep.textContent = '/';
    bar.appendChild(sep);

    accumulated += (accumulated ? '/' : '') + parts[i];
    const seg = document.createElement('span');
    seg.textContent = parts[i];
    if (i < parts.length - 1) {
      seg.className = 'breadcrumb-seg breadcrumb-link';
      const target = accumulated;
      seg.onclick = () => { clearPreview(); loadDir(target); };
    } else {
      seg.className = 'breadcrumb-seg breadcrumb-current';
    }
    bar.appendChild(seg);
  }
}
