# Team Templates（团队模板库）

此目录存储预设的团队模板和从商城下载的团队模板。
团队模板可以一键创建完整团队，包含成员和管理层级连线关系。

## 架构关系

```
teams/              ← 团队模板库（本目录）
  └── presets/      ← 内置预设团队（文件夹结构）
  └── marketplace/  ← 从商城下载的团队

employees/          ← 员工模板库
  └── presets/      ← 内置预设员工（文件夹结构）
  └── marketplace/  ← 从商城下载的员工

workspaces/         ← 工作区实例化目录
  └── <workspace>/
      └── employee_ins/   ← 从模板实例化的员工
```

## 目录结构

```
teams/
├── README.md              # 本说明文件
├── _manifest.json         # 团队模板清单
├── presets/               # 内置预设团队
│   ├── godot-game-team/   # Godot 游戏开发团队
│   │   ├── info.json      # 团队元数据
│   │   ├── skills/        # 团队级技能文件（.md）
│   │   └── experience/    # 团队级经验/错题集（.md）
│   ├── unity-game-team/
│   │   ├── info.json
│   │   ├── skills/
│   │   └── experience/
│   └── unreal-game-team/
│       ├── info.json
│       ├── skills/
│       └── experience/
└── marketplace/           # 从商城下载的团队模板
    └── <team-id>/
        ├── info.json
        ├── skills/
        └── experience/
```

## 团队模板文件夹格式

每个团队是一个文件夹，核心文件为 `info.json`：

### info.json

```json
{
  "template_version": 1,
  "id": "godot-game-team",
  "name": "Godot 游戏团队",
  "icon": "🎮",
  "desc": "基于 Godot 4 引擎的完整游戏开发团队",
  "color": "#478CBF",
  "members": [
    { "name": "制作人", "presetId": "producer" },
    { "name": "技术总监", "presetId": "technical-director" }
  ],
  "manages": {
    "制作人": ["技术总监"]
  }
}
```

## 字段说明

| 字段 | 必选 | 说明 |
|------|------|------|
| `template_version` | ✅ | 模板格式版本号（当前为 1） |
| `id` | ✅ | 团队模板唯一标识符（同时作为文件夹名） |
| `name` | ✅ | 团队显示名称 |
| `icon` | ❌ | 团队图标（emoji） |
| `desc` | ❌ | 团队描述 |
| `color` | ❌ | 团队主题色（hex） |
| `members` | ✅ | 成员列表，每个成员包含 `name` 和 `presetId` |
| `manages` | ❌ | 管理关系映射（上级 → 下属名称数组） |

### members 成员格式

| 字段 | 必选 | 说明 |
|------|------|------|
| `name` | ✅ | 成员名称（用于连线和显示） |
| `presetId` | ✅ | 对应 `employees/presets/<presetId>/` 中的员工预设 ID |
| `role` | ❌ | 覆盖预设的角色名称 |
| `model` | ❌ | 覆盖预设的模型 |

### manages 管理关系

键为上级成员名称，值为下属成员名称数组。
创建团队时自动建立连线（subagent 关系）。

### 子文件夹

| 子文件夹 | 说明 |
|----------|------|
| `skills/` | 团队级技能定义文件（.md），可为团队成员提供共享技能知识 |
| `experience/` | 团队级经验/错题集（.md），记录团队协作中的经验教训 |

## 数据流

```
teams/presets/<team-id>/info.json
    ↓  team_templates._load_template_folder()
    ↓  team_templates.list_preset_templates()
    ↓  API: GET /api/team-templates?source=preset
    ↓  agent-presets.js: loadPresetsFromAPI() → TEAM_PRESETS
    ↓  renderTeamPresets() → 团队预设面板
    ↓  createTeamFromPreset() → createTeamFromJSON()
    ↓  创建员工实例 + 建立连线
```

## 扩展方式

1. **添加内置团队预设**：在 `presets/` 下新增文件夹，包含 `info.json` + `skills/` + `experience/`
2. **商城下载**：通过 `POST /api/team-templates/install` 安装，自动存入 `marketplace/` 下
3. **商城卸载**：通过 `POST /api/team-templates/uninstall` 卸载
4. **导入/导出**：团队包通过工作区管理器的 import/export API 处理

## API 接口

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/api/team-templates` | 列出所有团队模板（?source=preset/marketplace） |
| GET | `/api/team-templates/manifest` | 获取团队模板清单 |
| POST | `/api/team-templates/install` | 安装商城团队模板 |
| POST | `/api/team-templates/uninstall` | 卸载商城团队模板 |
| POST | `/api/team-templates/manifest` | 更新团队模板清单 |
