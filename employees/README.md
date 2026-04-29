# Employee Templates（员工模板库）

此目录存储预设的员工模板和从商城下载的员工模板。
模板在新建工作区时被实例化到 `workspaces/<workspace>/employee_ins/` 目录中。

## 架构关系

```
employees/          ← 模板库（本目录）
  └── presets/      ← 内置预设模板（文件夹结构）
  └── marketplace/  ← 从商城下载的模板（文件夹结构）

teams/              ← 团队模板库
  └── presets/      ← 内置预设团队
  └── marketplace/  ← 从商城下载的团队

workspaces/         ← 工作区实例化目录
  └── <workspace>/
      └── employee_ins/   ← 从模板实例化的员工
      └── scripts/        ← PM专员脚本
      └── experience/     ← PM专员错题集
      └── skills/         ← 工作区技能
      └── Intermediate/   ← 临时文件
      └── info.json       ← 工作区元数据
```

## 目录结构

```
employees/
├── README.md              # 本说明文件
├── _manifest.json         # 模板清单（分类体系 + 自动初始化配置）
├── presets/               # 内置预设模板（文件夹结构）
│   ├── creative-director/
│   │   ├── info.json          # 员工元数据
│   │   ├── skills/            # 技能定义（.md 文件）
│   │   └── experience/        # 经验/错题集（.md 文件）
│   ├── producer/
│   │   ├── info.json          # 员工元数据
│   │   ├── index.html         # 控制台面板 HTML
│   │   ├── skills/
│   │   └── experience/
│   └── ...                    # 共 50 个预设文件夹
└── marketplace/           # 从商城下载的模板（同样文件夹结构）
    └── ...
```

## 预设文件夹结构

每个预设是一个以 `id` 命名的文件夹，包含以下文件和子目录：

```
<preset-id>/
├── info.json          # 必需 — 员工元数据
├── index.html         # 可选 — 控制台面板 HTML（仅部分角色需要）
├── skills/            # 可选 — 技能定义文件（.md）
└── experience/        # 可选 — 经验/错题集（.md）
```

### info.json 格式

**基础预设（最简形式）**：

```json
{
  "template_version": 1,
  "id": "ai-programmer",
  "name": "AI 程序员",
  "role": "程序员",
  "desc": "AI 行为系统、决策树和行为树实现",
  "category": "programmers",
  "model": "sonnet",
  "skills": ["ai-impl"],
  "characterImg": "character_14"
}
```

**带控制台面板的预设**（configHtml 不在 info.json 中，而是存放在 index.html）：

```
producer/
├── info.json          # 不含 configHtml 字段
├── index.html         # 控制台 HTML 面板
├── skills/
└── experience/
```

**自动创建的预设**（info.json 中有 auto_create 字段）：

```json
{
  "template_version": 1,
  "id": "pm-specialist",
  "name": "PM专员",
  "...": "...",
  "auto_create": true
}
```

### index.html 格式

控制台面板是标准的 HTML 文件，通过 `sendToChat()` 函数与聊天框交互：

```html
<html><head><style>
  /* 暗色主题样式 */
</style></head><body>
  <h2>🎬 制作人控制台</h2>
  <button onclick="sendToChat('请查看冲刺进度')">查看冲刺进度</button>
</body></html>
```

### skills/ 子目录

技能定义文件，使用 Markdown 格式。每个 `.md` 文件描述一个技能：

```markdown
# sprint-plan

## 描述
冲刺计划管理能力，能够规划迭代任务和里程碑。

## 使用场景
- 规划冲刺周期
- 分配迭代任务
- 跟踪冲刺进度
```

### experience/ 子目录

经验/错题集文件，记录角色在工作中积累的经验教训：

```markdown
# 常见问题排查

## 构建失败
- 检查依赖版本是否一致
- 确认编译环境配置正确
```

## 字段说明

### info.json 必选字段

| 字段 | 说明 |
|------|------|
| `template_version` | 模板格式版本号（当前为 1） |
| `id` | 模板唯一标识符（用于去重和团队引用，也是文件夹名） |
| `name` | 员工显示名称 |
| `role` | 角色分类（总监层/部门主管/程序员/设计师等） |
| `desc` | 角色描述（用于 system prompt 和侧栏展示） |
| `category` | 分类 ID（对应 AGENT_CATEGORIES） |
| `model` | 默认模型（opus/sonnet/haiku） |
| `skills` | 技能列表 |
| `characterImg` | 角色精灵图标识（character_1 ~ character_32） |

### 可选字段（仅在有值时包含）

| 字段 | 默认值 | 说明 |
|------|--------|------|
| `auto_create` | `false` | 是否在新建 workspace 时自动创建 |
| `customPrompt` | _(省略)_ | 自定义系统提示词（覆盖默认生成） |
| `params` | _(省略)_ | 配置参数对象 |

> **设计原则**：`configHtml` 不存放在 info.json 中，而是作为独立的 `index.html` 文件。
> 空字段（`""`, `{}`, `false`）不在 info.json 中出现。

## _manifest.json 格式

```json
{
  "version": 1,
  "auto_init_enabled": true,
  "auto_init_templates": ["pm-specialist"],
  "categories": [
    { "id": "directors",    "label": "总监层",     "icon": "👑", "tier": 1 },
    { "id": "leads",        "label": "部门主管",   "icon": "🎯", "tier": 2 },
    { "id": "programmers",  "label": "程序员",     "icon": "💻", "tier": 3 }
  ],
  "description": "控制哪些员工模板在新建 workspace 时自动初始化到工作区中"
}
```

## 分类体系

| category ID | 标签 | Tier | 默认模型 |
|-------------|------|------|----------|
| `directors` | 总监层 | 1 | opus |
| `leads` | 部门主管 | 2 | sonnet |
| `programmers` | 程序员 | 3 | sonnet |
| `designers` | 设计师 | 3 | sonnet |
| `art_audio` | 美术/音频 | 3 | sonnet |
| `narrative` | 叙事/内容 | 3 | sonnet |
| `qa_ops` | QA/运维 | 3 | sonnet/haiku |
| `engine_godot` | Godot 专家 | 3 | sonnet |
| `engine_unity` | Unity 专家 | 3 | sonnet |
| `engine_ue` | UE5 专家 | 3 | sonnet |

## 数据流

```
employees/presets/<id>/info.json + index.html
         │
         ▼  _load_template_folder()
  employee_templates.list_preset_templates()
         │  (合并 info.json + index.html → configHtml)
         ▼
  API: GET /api/employee-templates?source=preset
         │
         ▼  loadPresetsFromAPI()
  前端 AGENT_PRESETS[] (含 configHtml)
         │
         ▼  onPresetClick() / createTeamFromJSON()
  createEmployee({ presetId, configHtml, ... })
         │
         ▼  _apiCreateEmployee()
  后端 employee_fs.create_employee()
         │  (configHtml → 写入 index.html)
         ▼
  workspaces/<ws>/employee_ins/<name>/info.json + index.html
```

## 扩展方式

1. **添加内置预设**：在 `presets/` 下新建文件夹，包含 `info.json`（必需）和可选的 `index.html`、`skills/`、`experience/`
2. **商城下载**：自动创建文件夹结构到 `marketplace/` 下
3. **控制自动创建**：修改 `_manifest.json` 的 `auto_init_templates` 列表，或在 `info.json` 中设置 `auto_create: true`
4. **团队引用**：团队模板通过 `presetId` 字段引用员工预设文件夹名
5. **技能扩展**：在预设的 `skills/` 子目录中添加 `.md` 文件
6. **经验积累**：在预设的 `experience/` 子目录中添加 `.md` 文件
