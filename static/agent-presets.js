/**
 * agent-presets.js — 员工预设列表
 * 基于 Claude-Code-Game-Studios 项目的 Agent 定义
 * 员工图像资源使用 character-pack-full_version 精灵图
 */

// ── 预设分类 ──────────────────────────────────────────────────────────────────
const AGENT_CATEGORIES = [
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

// ── 预设定义 ──────────────────────────────────────────────────────────────────
// 每个预设包含: id, name, role, desc, category, model, skills, characterImg
const AGENT_PRESETS = [
  // ── Tier 1: Directors (Opus) ────────────────────────────────────────
  { id: 'creative-director',  name: '创意总监',   role: '总监层', category: 'directors', model: 'opus',
    desc: '最高创意权威，决定游戏愿景、基调和美学方向，解决部门间创意冲突',
    skills: ['brainstorm', 'design-review'], characterImg: 'character_1' },
  { id: 'technical-director', name: '技术总监',   role: '总监层', category: 'directors', model: 'opus',
    desc: '负责引擎架构、技术选型、性能策略和技术风险管理',
    skills: ['architecture-decision', 'tech-debt'], characterImg: 'character_2' },
  { id: 'producer',           name: '制作人',     role: '总监层', category: 'directors', model: 'opus',
    desc: '确保项目按时交付，管理冲刺计划、范围和跨部门协调',
    skills: ['sprint-plan', 'scope-check', 'estimate'], characterImg: 'character_3' },

  // ── Tier 2: Department Leads (Sonnet) ───────────────────────────────
  { id: 'game-designer',      name: '游戏设计师', role: '部门主管', category: 'leads', model: 'sonnet',
    desc: '设计核心机制、系统和玩家体验，维护游戏设计文档',
    skills: ['design-review', 'brainstorm'], characterImg: 'character_4' },
  { id: 'lead-programmer',    name: '主程序员',   role: '部门主管', category: 'leads', model: 'sonnet',
    desc: '代码架构、编码标准、代码审查和编程任务分配',
    skills: ['code-review', 'architecture-decision'], characterImg: 'character_5' },
  { id: 'art-director',       name: '艺术总监',   role: '部门主管', category: 'leads', model: 'sonnet',
    desc: '视觉标识、风格指南、艺术圣经和美术生产管线',
    skills: ['design-review'], characterImg: 'character_6' },
  { id: 'audio-director',     name: '音频总监',   role: '部门主管', category: 'leads', model: 'sonnet',
    desc: '音频愿景、风格指南和音频生产管线管理',
    skills: ['design-review'], characterImg: 'character_7' },
  { id: 'narrative-director', name: '叙事总监',   role: '部门主管', category: 'leads', model: 'sonnet',
    desc: '故事愿景、世界观和叙事一致性管理',
    skills: ['brainstorm', 'design-review'], characterImg: 'character_8' },
  { id: 'qa-lead',            name: 'QA 负责人',  role: '部门主管', category: 'leads', model: 'sonnet',
    desc: '测试策略、质量标准和缺陷分级管理',
    skills: ['test-plan', 'bug-triage'], characterImg: 'character_9' },
  { id: 'release-manager',    name: '发布经理',   role: '部门主管', category: 'leads', model: 'sonnet',
    desc: '发布流程、版本管理和构建管线',
    skills: ['release-checklist'], characterImg: 'character_10' },
  { id: 'localization-lead',  name: '本地化负责人', role: '部门主管', category: 'leads', model: 'sonnet',
    desc: '翻译策略、文化适配和本地化管线',
    skills: ['l10n-check'], characterImg: 'character_11' },

  // ── Tier 3: Programmers ─────────────────────────────────────────────
  { id: 'gameplay-programmer', name: '游戏逻辑程序员', role: '程序员', category: 'programmers', model: 'sonnet',
    desc: '实现游戏机制、玩家系统、战斗和交互功能',
    skills: ['gameplay-impl'], characterImg: 'character_12' },
  { id: 'engine-programmer',   name: '引擎程序员',  role: '程序员', category: 'programmers', model: 'sonnet',
    desc: '核心引擎系统、渲染管线和底层架构',
    skills: ['engine-impl'], characterImg: 'character_13' },
  { id: 'ai-programmer',       name: 'AI 程序员',   role: '程序员', category: 'programmers', model: 'sonnet',
    desc: 'AI 行为系统、决策树和行为树实现',
    skills: ['ai-impl'], characterImg: 'character_14' },
  { id: 'network-programmer',  name: '网络程序员',  role: '程序员', category: 'programmers', model: 'sonnet',
    desc: '多人游戏网络功能、同步和复制系统',
    skills: ['network-impl'], characterImg: 'character_15' },
  { id: 'tools-programmer',    name: '工具程序员',  role: '程序员', category: 'programmers', model: 'sonnet',
    desc: '开发工具、编辑器扩展和自动化脚本',
    skills: ['tools-impl'], characterImg: 'character_16' },
  { id: 'ui-programmer',       name: 'UI 程序员',   role: '程序员', category: 'programmers', model: 'sonnet',
    desc: '用户界面系统、HUD 和交互反馈',
    skills: ['ui-impl'], characterImg: 'character_17' },

  // ── Tier 3: Designers ───────────────────────────────────────────────
  { id: 'systems-designer',    name: '系统设计师',  role: '设计师', category: 'designers', model: 'sonnet',
    desc: '设计游戏系统、经济模型和进度机制',
    skills: ['systems-design'], characterImg: 'character_18' },
  { id: 'level-designer',      name: '关卡设计师',  role: '设计师', category: 'designers', model: 'sonnet',
    desc: '关卡布局、节奏和玩家引导设计',
    skills: ['level-design'], characterImg: 'character_19' },
  { id: 'economy-designer',    name: '经济系统设计师', role: '设计师', category: 'designers', model: 'sonnet',
    desc: '游戏内经济、货币系统和价值平衡',
    skills: ['economy-design'], characterImg: 'character_20' },

  // ── Tier 3: Art/Audio ───────────────────────────────────────────────
  { id: 'technical-artist',    name: '技术美术',   role: '美术/音频', category: 'art_audio', model: 'sonnet',
    desc: '着色器实现、VFX 创建和美术管线优化',
    skills: ['shader-impl', 'vfx-impl'], characterImg: 'character_21' },
  { id: 'sound-designer',      name: '音效设计师',  role: '美术/音频', category: 'art_audio', model: 'sonnet',
    desc: '音效设计、音频实现和空间音频',
    skills: ['sound-design'], characterImg: 'character_22' },

  // ── Tier 3: Narrative/Content ───────────────────────────────────────
  { id: 'writer',              name: '编剧',      role: '叙事/内容', category: 'narrative', model: 'sonnet',
    desc: '对话文本、剧情脚本和叙事内容创作',
    skills: ['writing'], characterImg: 'character_23' },
  { id: 'world-builder',       name: '世界构建师', role: '叙事/内容', category: 'narrative', model: 'sonnet',
    desc: '世界观设定、背景故事和环境叙事',
    skills: ['worldbuilding'], characterImg: 'character_24' },

  // ── Tier 3: UX/Prototype ────────────────────────────────────────────
  { id: 'ux-designer',         name: 'UX 设计师',  role: '设计师', category: 'designers', model: 'sonnet',
    desc: '交互设计、用户流程和可用性测试',
    skills: ['ux-design'], characterImg: 'character_25' },
  { id: 'prototyper',          name: '原型制作师',  role: '设计师', category: 'designers', model: 'sonnet',
    desc: '快速原型验证概念和交互方案',
    skills: ['prototype'], characterImg: 'character_26' },

  // ── Tier 3: QA/Ops ──────────────────────────────────────────────────
  { id: 'performance-analyst', name: '性能分析师', role: 'QA/运维', category: 'qa_ops', model: 'sonnet',
    desc: '性能剖析、瓶颈定位和优化建议',
    skills: ['perf-analysis'], characterImg: 'character_27' },
  { id: 'devops-engineer',     name: '运维工程师',  role: 'QA/运维', category: 'qa_ops', model: 'sonnet',
    desc: 'CI/CD 管线、基础设施和部署自动化',
    skills: ['devops'], characterImg: 'character_28' },
  { id: 'analytics-engineer',  name: '数据分析工程师', role: 'QA/运维', category: 'qa_ops', model: 'sonnet',
    desc: '遥测系统、数据管道和玩家行为分析',
    skills: ['analytics'], characterImg: 'character_29' },
  { id: 'security-engineer',   name: '安全工程师',  role: 'QA/运维', category: 'qa_ops', model: 'sonnet',
    desc: '安全审计、反作弊和漏洞修复',
    skills: ['security'], characterImg: 'character_30' },
  { id: 'qa-tester',           name: 'QA 测试员',  role: 'QA/运维', category: 'qa_ops', model: 'haiku',
    desc: '功能测试、回归测试和缺陷报告',
    skills: ['testing'], characterImg: 'character_31' },
  { id: 'accessibility-specialist', name: '无障碍专家', role: 'QA/运维', category: 'qa_ops', model: 'sonnet',
    desc: '无障碍标准、辅助功能和包容性设计',
    skills: ['a11y'], characterImg: 'character_32' },

  // ── Tier 3: Live Ops ────────────────────────────────────────────────
  { id: 'live-ops-designer',   name: '运营设计师',  role: 'QA/运维', category: 'qa_ops', model: 'sonnet',
    desc: '实时运营活动、赛季设计和玩家留存',
    skills: ['live-ops'], characterImg: 'character_1' },
  { id: 'community-manager',   name: '社区经理',   role: 'QA/运维', category: 'qa_ops', model: 'sonnet',
    desc: '社区管理、玩家反馈收集和社区活动',
    skills: ['community'], characterImg: 'character_2' },

  // ── Godot Engine Specialists ─────────────────────────────────────────
  { id: 'godot-specialist',         name: 'Godot 专家',    role: 'Godot 专家', category: 'engine_godot', model: 'sonnet',
    desc: 'Godot 4 引擎全局专家，协调 Godot 子专家',
    skills: ['godot-core'], characterImg: 'character_3' },
  { id: 'godot-gdscript-specialist', name: 'GDScript 专家', role: 'Godot 专家', category: 'engine_godot', model: 'sonnet',
    desc: 'GDScript 脚本编写、最佳实践和性能优化',
    skills: ['gdscript'], characterImg: 'character_4' },
  { id: 'godot-shader-specialist',  name: 'Godot Shader 专家', role: 'Godot 专家', category: 'engine_godot', model: 'sonnet',
    desc: 'Godot 着色器编写、视觉特效和渲染管线',
    skills: ['godot-shader'], characterImg: 'character_5' },
  { id: 'godot-gdextension-specialist', name: 'GDExtension 专家', role: 'Godot 专家', category: 'engine_godot', model: 'sonnet',
    desc: 'GDExtension/C++ 扩展开发和原生模块集成',
    skills: ['gdextension'], characterImg: 'character_6' },
  { id: 'godot-csharp-specialist',  name: 'Godot C# 专家',  role: 'Godot 专家', category: 'engine_godot', model: 'sonnet',
    desc: 'Godot C# 脚本开发、.NET 集成和类型安全架构',
    skills: ['godot-csharp'], characterImg: 'character_7' },

  // ── Unity Specialists ───────────────────────────────────────────────
  { id: 'unity-specialist',         name: 'Unity 专家',   role: 'Unity 专家', category: 'engine_unity', model: 'sonnet',
    desc: 'Unity 引擎全局专家，协调 Unity 子专家',
    skills: ['unity-core'], characterImg: 'character_8' },
  { id: 'unity-dots-specialist',    name: 'DOTS/ECS 专家', role: 'Unity 专家', category: 'engine_unity', model: 'sonnet',
    desc: 'Unity DOTS、ECS 架构和数据导向设计',
    skills: ['dots-ecs'], characterImg: 'character_9' },
  { id: 'unity-shader-specialist',  name: 'Unity Shader 专家', role: 'Unity 专家', category: 'engine_unity', model: 'sonnet',
    desc: 'Shader Graph、URP/HDRP 和视觉特效',
    skills: ['unity-shader'], characterImg: 'character_10' },
  { id: 'unity-addressables-specialist', name: 'Addressables 专家', role: 'Unity 专家', category: 'engine_unity', model: 'sonnet',
    desc: '资源管理、Addressables 系统和异步加载',
    skills: ['addressables'], characterImg: 'character_11' },
  { id: 'unity-ui-specialist',      name: 'UI Toolkit 专家', role: 'Unity 专家', category: 'engine_unity', model: 'sonnet',
    desc: 'UI Toolkit、USS 样式和自定义控件',
    skills: ['ui-toolkit'], characterImg: 'character_12' },

  // ── Unreal Engine 5 Specialists ──────────────────────────────────────
  { id: 'unreal-specialist',        name: 'UE5 专家',     role: 'UE5 专家', category: 'engine_ue', model: 'sonnet',
    desc: 'Unreal Engine 5 全局专家，协调 UE 子专家',
    skills: ['unreal-core'], characterImg: 'character_13' },
  { id: 'ue-gas-specialist',        name: 'GAS 专家',     role: 'UE5 专家', category: 'engine_ue', model: 'sonnet',
    desc: 'Gameplay Ability System、能力系统和游戏玩法标签',
    skills: ['gas'], characterImg: 'character_14' },
  { id: 'ue-blueprint-specialist',  name: 'Blueprint 专家', role: 'UE5 专家', category: 'engine_ue', model: 'sonnet',
    desc: '蓝图可视化脚本、宏库和组件开发',
    skills: ['blueprint'], characterImg: 'character_15' },
  { id: 'ue-replication-specialist', name: 'Replication 专家', role: 'UE5 专家', category: 'engine_ue', model: 'sonnet',
    desc: '网络复制、多人同步和延迟补偿',
    skills: ['replication'], characterImg: 'character_16' },
  { id: 'ue-umg-specialist',        name: 'UMG/CommonUI 专家', role: 'UE5 专家', category: 'engine_ue', model: 'sonnet',
    desc: 'UMG 界面、CommonUI 框架和 UI 优化',
    skills: ['umg'], characterImg: 'character_17' },
];

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
  return `
    <div class="preset-card" draggable="true" data-preset-id="${preset.id}"
         ondragstart="onPresetDragStart(event, '${preset.id}')"
         onclick="onPresetClick('${preset.id}')">
      <div class="preset-avatar preset-avatar-sprite" style="background-image:url('${getCharacterImgUrl(preset.characterImg)}');background-size:300% 400%;background-position:0 0;background-repeat:no-repeat" onerror="this.style.backgroundImage='none';this.nextElementSibling.style.display='flex'"></div>
      <div class="preset-avatar-fallback" style="display:none">${preset.name[0]}</div>
      <div class="preset-info">
        <div class="preset-name">${preset.name}</div>
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
  // 创建员工实例
  const emp = createEmployee({
    name: preset.name,
    role: preset.role,
    presetId: preset.id,
    characterImg: preset.characterImg,
    model: preset.model,
    skills: preset.skills,
  });
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
      const emp = createEmployee({
        name: preset.name,
        role: preset.role,
        presetId: preset.id,
        characterImg: preset.characterImg,
        model: preset.model,
        skills: preset.skills,
        _pos: { x, y },
      });

      // 选中并打开对话
      setTimeout(() => selectEmployee(emp.id), 200);
    } catch (err) {
      console.error('[Canvas Drop] Error:', err);
    }
  });
}

// ── 团队预设 ──────────────────────────────────────────────────────────────────
// 一键创建完整团队，包含管理层级和连线关系
const TEAM_PRESETS = [
  {
    id: 'godot-game-team',
    name: 'Godot 游戏团队',
    icon: '🎮',
    desc: '基于 Godot 4 引擎的完整游戏开发团队，覆盖策划、程序、美术、QA 全流程',
    color: '#478CBF',
    members: [
      { name: '制作人', presetId: 'producer' },
      { name: '技术总监', presetId: 'technical-director' },
      { name: '游戏设计师', presetId: 'game-designer' },
      { name: '主程序员', presetId: 'lead-programmer' },
      { name: '艺术总监', presetId: 'art-director' },
      { name: 'QA 负责人', presetId: 'qa-lead' },
      { name: 'Godot 专家', presetId: 'godot-specialist' },
      { name: 'GDScript 专家', presetId: 'godot-gdscript-specialist' },
      { name: 'Godot Shader 专家', presetId: 'godot-shader-specialist' },
      { name: 'GDExtension 专家', presetId: 'godot-gdextension-specialist' },
      { name: 'Godot C# 专家', presetId: 'godot-csharp-specialist' },
      { name: '游戏逻辑程序员', presetId: 'gameplay-programmer' },
      { name: 'AI 程序员', presetId: 'ai-programmer' },
      { name: 'UI 程序员', presetId: 'ui-programmer' },
      { name: '网络程序员', presetId: 'network-programmer' },
      { name: '关卡设计师', presetId: 'level-designer' },
      { name: '系统设计师', presetId: 'systems-designer' },
      { name: '技术美术', presetId: 'technical-artist' },
      { name: '音效设计师', presetId: 'sound-designer' },
      { name: 'QA 测试员', presetId: 'qa-tester' },
    ],
    manages: {
      '制作人': ['技术总监', '游戏设计师', '艺术总监', 'QA 负责人'],
      '技术总监': ['主程序员', 'Godot 专家'],
      '主程序员': ['游戏逻辑程序员', 'AI 程序员', 'UI 程序员', '网络程序员'],
      'Godot 专家': ['GDScript 专家', 'Godot Shader 专家', 'GDExtension 专家', 'Godot C# 专家'],
      '游戏设计师': ['关卡设计师', '系统设计师'],
      '艺术总监': ['技术美术', '音效设计师'],
      'QA 负责人': ['QA 测试员'],
    },
  },
  {
    id: 'unity-game-team',
    name: 'Unity 游戏团队',
    icon: '🕹️',
    desc: '基于 Unity 引擎的完整游戏开发团队，包含 DOTS/ECS、Shader Graph 等专业分工',
    color: '#000000',
    members: [
      { name: '制作人', presetId: 'producer' },
      { name: '技术总监', presetId: 'technical-director' },
      { name: '游戏设计师', presetId: 'game-designer' },
      { name: '主程序员', presetId: 'lead-programmer' },
      { name: '艺术总监', presetId: 'art-director' },
      { name: 'QA 负责人', presetId: 'qa-lead' },
      { name: 'Unity 专家', presetId: 'unity-specialist' },
      { name: 'DOTS/ECS 专家', presetId: 'unity-dots-specialist' },
      { name: 'Unity Shader 专家', presetId: 'unity-shader-specialist' },
      { name: 'Addressables 专家', presetId: 'unity-addressables-specialist' },
      { name: 'UI Toolkit 专家', presetId: 'unity-ui-specialist' },
      { name: '游戏逻辑程序员', presetId: 'gameplay-programmer' },
      { name: 'AI 程序员', presetId: 'ai-programmer' },
      { name: 'UI 程序员', presetId: 'ui-programmer' },
      { name: '网络程序员', presetId: 'network-programmer' },
      { name: '关卡设计师', presetId: 'level-designer' },
      { name: '系统设计师', presetId: 'systems-designer' },
      { name: '技术美术', presetId: 'technical-artist' },
      { name: '音效设计师', presetId: 'sound-designer' },
      { name: 'QA 测试员', presetId: 'qa-tester' },
    ],
    manages: {
      '制作人': ['技术总监', '游戏设计师', '艺术总监', 'QA 负责人'],
      '技术总监': ['主程序员', 'Unity 专家'],
      '主程序员': ['游戏逻辑程序员', 'AI 程序员', 'UI 程序员', '网络程序员'],
      'Unity 专家': ['DOTS/ECS 专家', 'Unity Shader 专家', 'Addressables 专家', 'UI Toolkit 专家'],
      '游戏设计师': ['关卡设计师', '系统设计师'],
      '艺术总监': ['技术美术', '音效设计师'],
      'QA 负责人': ['QA 测试员'],
    },
  },
  {
    id: 'unreal-game-team',
    name: 'Unreal 游戏团队',
    icon: '🎬',
    desc: '基于 Unreal Engine 5 的完整游戏开发团队，包含 GAS、Blueprint、Replication 等专业分工',
    color: '#0E84B5',
    members: [
      { name: '制作人', presetId: 'producer' },
      { name: '技术总监', presetId: 'technical-director' },
      { name: '游戏设计师', presetId: 'game-designer' },
      { name: '主程序员', presetId: 'lead-programmer' },
      { name: '艺术总监', presetId: 'art-director' },
      { name: 'QA 负责人', presetId: 'qa-lead' },
      { name: 'UE5 专家', presetId: 'unreal-specialist' },
      { name: 'GAS 专家', presetId: 'ue-gas-specialist' },
      { name: 'Blueprint 专家', presetId: 'ue-blueprint-specialist' },
      { name: 'Replication 专家', presetId: 'ue-replication-specialist' },
      { name: 'UMG/CommonUI 专家', presetId: 'ue-umg-specialist' },
      { name: '游戏逻辑程序员', presetId: 'gameplay-programmer' },
      { name: 'AI 程序员', presetId: 'ai-programmer' },
      { name: 'UI 程序员', presetId: 'ui-programmer' },
      { name: '网络程序员', presetId: 'network-programmer' },
      { name: '关卡设计师', presetId: 'level-designer' },
      { name: '系统设计师', presetId: 'systems-designer' },
      { name: '技术美术', presetId: 'technical-artist' },
      { name: '音效设计师', presetId: 'sound-designer' },
      { name: 'QA 测试员', presetId: 'qa-tester' },
    ],
    manages: {
      '制作人': ['技术总监', '游戏设计师', '艺术总监', 'QA 负责人'],
      '技术总监': ['主程序员', 'UE5 专家'],
      '主程序员': ['游戏逻辑程序员', 'AI 程序员', 'UI 程序员', '网络程序员'],
      'UE5 专家': ['GAS 专家', 'Blueprint 专家', 'Replication 专家', 'UMG/CommonUI 专家'],
      '游戏设计师': ['关卡设计师', '系统设计师'],
      '艺术总监': ['技术美术', '音效设计师'],
      'QA 负责人': ['QA 测试员'],
    },
  },
];

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
function initPresetPanel() {
  renderPresetList();
  renderTeamPresets();
  initCanvasDropZone();
}
