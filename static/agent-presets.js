/**
 * agent-presets.js — 员工预设列表
 * 预设数据从后端 API 动态加载（employees/presets/ 文件夹结构）
 * 员工图像资源使用 character-pack-full_version 精灵图
 */

// ── 预设分类（从 manifest API 加载，此处为 fallback） ─────────────────────────────
let AGENT_CATEGORIES = [
  { id: 'directors',    label: '总监层',   icon: '👑', tier: 1 },
  { id: 'leads',        label: '部门主管', icon: '🎯', tier: 2 },
  { id: 'programmers',  label: '程序员',   icon: '💻', tier: 3 },
  { id: 'designers',    label: '设计师',   icon: '🎨', tier: 3 },
  { id: 'art_audio',    label: '美术/音频', icon: '🎭', tier: 3 },
  { id: 'narrative',    label: '叙事/内容', icon: '📝', tier: 3 },
  { id: 'qa_ops',       label: 'QA/运维',  icon: '🔍', tier: 3 },
  { id: 'engine_godot', label: 'Godot 专家', icon: '🎮', tier: 3 },
  { id: 'engine_unity', label: 'Unity 专家', icon: '🕹️', tier: 3 },
  { id: 'engine_ue',    label: 'UE5 专家',  icon: '🎬', tier: 3 },
];

// ── 预设定义（从后端 API 加载） ─────────────────────────────────────────────────
// 每个 preset 包含: id, name, role, desc, category, model, skills, characterImg
// 可选: configHtml (从 index.html 加载), auto_create, customPrompt, params
let AGENT_PRESETS = [];

// ── 从后端 API 加载预设数据 ──────────────────────────────────────────────────────
async function loadPresetsFromAPI() {
  try {
    // 并行加载员工预设列表、manifest 分类、团队预设列表
    const [presetsRes, manifestRes, teamRes] = await Promise.all([
      fetch('/api/employee-templates?source=preset'),
      fetch('/api/employee-templates/manifest'),
      fetch('/api/team-templates?source=preset'),
    ]);

    // 加载员工预设
    if (presetsRes.ok) {
      const data = await presetsRes.json();
      if (data.templates && Array.isArray(data.templates)) {
        AGENT_PRESETS = data.templates;
        console.log(`[presets] Loaded ${AGENT_PRESETS.length} employee presets from API`);
      }
    }

    // 加载分类（从 manifest）
    if (manifestRes.ok) {
      const manifest = await manifestRes.json();
      if (manifest.categories && Array.isArray(manifest.categories)) {
        AGENT_CATEGORIES = manifest.categories;
        console.log(`[presets] Loaded ${AGENT_CATEGORIES.length} categories from manifest`);
      }
    }

    // 加载团队预设
    if (teamRes.ok) {
      const data = await teamRes.json();
      if (data.templates && Array.isArray(data.templates)) {
        TEAM_PRESETS = data.templates;
        console.log(`[presets] Loaded ${TEAM_PRESETS.length} team presets from API`);
      }
    }
  } catch (err) {
    console.warn('[presets] Failed to load from API, using fallback data:', err);
  }
}

// ── 预设图像路径 ──────────────────────────────────────────────────────────────
function getCharacterImgUrl(characterImg) {
  return `/static/img/characters/${characterImg}_frame32x32.png`;
}

// ── 预设搜索/筛选 ─────────────────────────────────────────────────────────────
let _presetSearchQuery = '';
let _presetCategory = 'all';

function getFilteredPresets() {
  let list = AGENT_PRESETS;
  if (_presetCategory !== 'all') {
    list = list.filter(p => p.category === _presetCategory);
  }
  if (_presetSearchQuery) {
    const q = _presetSearchQuery.toLowerCase();
    list = list.filter(p =>
      p.name.toLowerCase().includes(q) ||
      p.desc.toLowerCase().includes(q) ||
      p.role.toLowerCase().includes(q)
    );
  }
  return list;
}

// ── 侧栏预设列表渲染 ─────────────────────────────────────────────────────────
function renderPresetList() {
  const container = $('presetList');
  if (!container) return;

  const presets = getFilteredPresets();
  const catId = _presetCategory;

  if (catId === 'all') {
    // 按分类分组渲染
    container.innerHTML = AGENT_CATEGORIES.map(cat => {
      const items = presets.filter(p => p.category === cat.id);
      if (items.length === 0) return '';
      return `
        <div class="preset-group">
          <div class="preset-group-header" onclick="togglePresetGroup('${cat.id}')">
            <span class="preset-group-icon">${cat.icon}</span>
            <span class="preset-group-label">${cat.label}</span>
            <span class="preset-group-count">${items.length}</span>
            <svg class="preset-group-arrow" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="6 9 12 15 18 9"/></svg>
          </div>
          <div class="preset-group-items" id="presetGroup_${cat.id}">
            ${items.map(p => _buildPresetCard(p)).join('')}
          </div>
        </div>`;
    }).join('');
  } else {
    container.innerHTML = presets.map(p => _buildPresetCard(p)).join('');
  }
}

function _buildPresetCard(preset) {
  const tierBadge = preset.model === 'opus' ? '<span class="preset-tier tier-opus">Opus</span>'
                  : preset.model === 'haiku' ? '<span class="preset-tier tier-haiku">Haiku</span>'
                  : '<span class="preset-tier tier-sonnet">Sonnet</span>';
  const configBadge = preset.configHtml ? ' <span class="preset-config-badge">⚙</span>' : '';
  // DiceBear 头像（基于预设 id 确定性生成）
  const styleIdx = (typeof hashString === 'function' ? hashString(preset.id) : preset.id.length) % 10;
  const styles = ['bottts','pixel-art','avataaars','shapes','identicon','notionists','fun-emoji','rings','thumbs','lorelei'];
  const style = preset.avatarStyle || styles[styleIdx];
  const seed = preset.avatarSeed || preset.name || preset.id;
  const avatarUrl = `https://api.dicebear.com/9.x/${style}/svg?seed=${encodeURIComponent(seed)}&size=64`;
  const fallback = esc(preset.name[0] || '🤖');
  return `
    <div class="preset-card" draggable="true" data-preset-id="${preset.id}"
         ondragstart="onPresetDragStart(event, '${preset.id}')"
         onclick="onPresetClick('${preset.id}')">
      <div class="preset-avatar preset-avatar-animated" style="padding:0;overflow:hidden">
        <img src="${avatarUrl}" alt="" style="width:100%;height:100%;object-fit:cover;display:block;border-radius:inherit" onerror="this.parentElement.innerHTML='<span style=font-size:18px>${fallback}</span>'">
      </div>
      <div class="preset-info">
        <div class="preset-name">${preset.name}${configBadge}</div>
        <div class="preset-desc">${preset.desc}</div>
      </div>
      ${tierBadge}
    </div>`;
}

// ── 预设组折叠/展开 ───────────────────────────────────────────────────────────
function togglePresetGroup(catId) {
  const el = $(`presetGroup_${catId}`);
  if (!el) return;
  el.classList.toggle('collapsed');
}

// ── 预设搜索 ──────────────────────────────────────────────────────────────────
function filterPresets() {
  const input = $('presetSearch');
  if (input) _presetSearchQuery = input.value.trim();
  renderPresetList();
}

// ── 预设分类筛选 ──────────────────────────────────────────────────────────────
function setPresetCategory(catId, btn) {
  _presetCategory = catId;
  // 更新筛选按钮状态
  document.querySelectorAll('.preset-cat-btn').forEach(b => {
    b.classList.toggle('active', b.dataset.cat === catId);
  });
  renderPresetList();
}

// ── 预设拖拽到画布 ────────────────────────────────────────────────────────────
function onPresetDragStart(event, presetId) {
  const preset = AGENT_PRESETS.find(p => p.id === presetId);
  if (!preset) return;
  event.dataTransfer.setData('text/plain', JSON.stringify({
    type: 'agent-preset',
    presetId: preset.id,
  }));
  event.dataTransfer.effectAllowed = 'copy';
  // 添加拖拽视觉反馈
  event.target.closest('.preset-card')?.classList.add('preset-dragging');
  setTimeout(() => {
    event.target.closest('.preset-card')?.classList.remove('preset-dragging');
  }, 200);
}

// ── 预设点击 → 快速添加到画布 ─────────────────────────────────────────────────
function onPresetClick(presetId) {
  const preset = AGENT_PRESETS.find(p => p.id === presetId);
  if (!preset) return;
  // 为预设员工分配确定性 DiceBear 风格
  const styleIdx = (typeof hashString === 'function' ? hashString(preset.id) : preset.id.length) % 10;
  const styles = ['bottts','pixel-art','avataaars','shapes','identicon','notionists','fun-emoji','rings','thumbs','lorelei'];
  // 创建员工实例（包含 configHtml）
  const empOpts = {
    name: preset.name,
    role: preset.role,
    presetId: preset.id,
    model: preset.model,
    skills: preset.skills,
    avatarStyle: preset.avatarStyle || styles[styleIdx],
    avatarSeed: preset.avatarSeed || preset.name || preset.id,
  };
  if (preset.configHtml) empOpts.configHtml = preset.configHtml;
  if (preset.customPrompt) empOpts.customPrompt = preset.customPrompt;
  if (preset.params && Object.keys(preset.params).length) empOpts.params = preset.params;
  const emp = createEmployee(empOpts);
  // 切换到工作画布并选中
  switchWorkspaceTab('canvas');
  setTimeout(() => selectEmployee(emp.id), 200);
}

// ── 画布拖拽接收 ─────────────────────────────────────────────────────────────
function initCanvasDropZone() {
  const canvas = $('employeeCanvas');
  if (!canvas) return;

  canvas.addEventListener('dragover', (e) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
    canvas.classList.add('canvas-drop-hover');
  });

  canvas.addEventListener('dragleave', (e) => {
    // 只有真正离开 canvas 时才移除
    if (!canvas.contains(e.relatedTarget)) {
      canvas.classList.remove('canvas-drop-hover');
    }
  });

  canvas.addEventListener('drop', (e) => {
    e.preventDefault();
    canvas.classList.remove('canvas-drop-hover');

    try {
      const data = JSON.parse(e.dataTransfer.getData('text/plain'));
      if (data.type !== 'agent-preset') return;

      const preset = AGENT_PRESETS.find(p => p.id === data.presetId);
      if (!preset) return;

      // 计算放置位置（相对于画布，考虑缩放）
      const rect = canvas.getBoundingClientRect();
      const zoom = typeof _canvasZoomLevel !== 'undefined' ? _canvasZoomLevel : 1;
      const panX = typeof _canvasPanX !== 'undefined' ? _canvasPanX : 0;
      const panY = typeof _canvasPanY !== 'undefined' ? _canvasPanY : 0;
      const x = (e.clientX - rect.left - panX) / zoom - 120;
      const y = (e.clientY - rect.top - panY) / zoom - 80;

      // 创建员工实例并设定位置
      const styleIdx = (typeof hashString === 'function' ? hashString(preset.id) : preset.id.length) % 10;
      const styles = ['bottts','pixel-art','avataaars','shapes','identicon','notionists','fun-emoji','rings','thumbs','lorelei'];
      const empOpts = {
        name: preset.name,
        role: preset.role,
        presetId: preset.id,
        model: preset.model,
        skills: preset.skills,
        _pos: { x, y },
        avatarStyle: preset.avatarStyle || styles[styleIdx],
        avatarSeed: preset.avatarSeed || preset.name || preset.id,
      };
      if (preset.configHtml) empOpts.configHtml = preset.configHtml;
      if (preset.customPrompt) empOpts.customPrompt = preset.customPrompt;
      if (preset.params && Object.keys(preset.params).length) empOpts.params = preset.params;

      const emp = createEmployee(empOpts);

      // 选中并打开对话
      setTimeout(() => selectEmployee(emp.id), 200);
    } catch (err) {
      console.error('[Canvas Drop] Error:', err);
    }
  });
}

// ── 团队预设 ──────────────────────────────────────────────────────────────────
// 一键创建完整团队，包含管理层级和连线关系
// 从后端 API 动态加载（teams/presets/ 文件夹结构）
let TEAM_PRESETS = [];

// ── 团队预设渲染 ──────────────────────────────────────────────────────────────

let _teamPresetSearchQuery = '';

function getFilteredTeamPresets() {
  let list = TEAM_PRESETS;
  if (_teamPresetSearchQuery) {
    const q = _teamPresetSearchQuery.toLowerCase();
    list = list.filter(t =>
      t.name.toLowerCase().includes(q) ||
      t.desc.toLowerCase().includes(q) ||
      t.members.some(m => m.name.toLowerCase().includes(q)) ||
      Object.keys(t.manages).some(k => k.toLowerCase().includes(q))
    );
  }
  return list;
}

function filterTeamPresets() {
  const input = $('teamPresetSearch');
  if (input) _teamPresetSearchQuery = input.value.trim();
  renderTeamPresets();
}

function renderTeamPresets() {
  const container = $('teamPresetList');
  if (!container) return;
  const teams = getFilteredTeamPresets();
  if (teams.length === 0) {
    container.innerHTML = '<div style="text-align:center;padding:20px 12px;color:var(--muted);font-size:12px">未找到匹配的团队预设</div>';
    return;
  }
  container.innerHTML = teams.map(team => {
    const memberCount = team.members.length;
    const connCount = Object.values(team.manages).reduce((s, a) => s + a.length, 0);
    // 收集成员的角色标签（最多显示3个分类）
    const categories = new Set();
    team.members.forEach(m => {
      const preset = AGENT_PRESETS.find(p => p.id === m.presetId);
      if (preset) categories.add(preset.category);
    });
    const catLabels = [...categories].slice(0, 3).map(catId => {
      const cat = AGENT_CATEGORIES.find(c => c.id === catId);
      return cat ? cat.label : catId;
    }).join(' · ');
    return `
      <div class="team-preset-card" data-team-id="${team.id}">
        <div class="team-preset-header">
          <div class="team-preset-icon" style="background:${team.color}">${team.icon}</div>
          <div class="team-preset-info">
            <div class="team-preset-name">${team.name}</div>
            <div class="team-preset-desc">${team.desc}</div>
          </div>
        </div>
        <div class="team-preset-meta">
          <span class="team-preset-stat">👤 ${memberCount} 人</span>
          <span class="team-preset-stat">🔗 ${connCount} 条连线</span>
          <span class="team-preset-cats">${catLabels}</span>
        </div>
        <button class="team-preset-create-btn" onclick="createTeamFromPreset('${team.id}')">
          一键创建团队
        </button>
      </div>`;
  }).join('');
}

// ── 从团队预设创建 ────────────────────────────────────────────────────────────

function createTeamFromPreset(teamPresetId) {
  const team = TEAM_PRESETS.find(t => t.id === teamPresetId);
  if (!team) return;

  // 构建 createTeamFromJSON 所需的 JSON 格式
  const teamData = {
    team_name: team.name,
    members: team.members.map(m => ({
      name: m.name,
      presetId: m.presetId,
      manages: team.manages[m.name] || [],
    })),
  };

  if (typeof createTeamFromJSON === 'function') {
    createTeamFromJSON(teamData);
  }
}

// ── 初始化 ────────────────────────────────────────────────────────────────────
async function initPresetPanel() {
  await loadPresetsFromAPI();
  renderPresetList();
  renderTeamPresets();
  initCanvasDropZone();
}
