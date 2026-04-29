# Workspaces（工作区实例化目录）

此目录存储每个工作区的实例化数据。每个工作区是一个独立的文件夹，包含该工作区中
所有员工实例、脚本、配置和产出。

## 目录结构

```
workspaces/
├── README.md
├── _registry.json             # 工作区注册表（索引所有工作区）
└── <workspace_name>/          # 单个工作区
    ├── info.json              # 工作区元数据（版本、路径、创建时间等）
    ├── employee_ins/          # 实例化的员工
    │   ├── _next_id.json      # 员工 ID 自增计数器
    │   ├── PM专员/
    │   │   ├── info.json      # 员工核心数据
    │   │   └── index.html     # 员工 configHtml
    │   └── 主程序员/
    │       ├── info.json
    │       └── index.html
    ├── scripts/               # 工作区脚本（通常是 PM 专员使用的脚本）
    ├── experience/            # PM 专员的错题集
    ├── skills/                # 工作区内 PM 专员的技能
    ├── Intermediate/          # 工作区生成的临时文件
    └── connections.json       # 员工之间的连线关系
```

## info.json 格式

```json
{
  "version": 1,
  "name": "我的项目",
  "path": "G:\\Projects\\my-project",
  "createdAt": 1714000000000,
  "updatedAt": 1714000000000,
  "description": "",
  "team_name": "",
  "employee_count": 3,
  "settings": {}
}
```

## 设计理念

- **每个工作区 = 一个团队**：导出后的工作区可作为完整团队分享
- **员工实例化**：`employee_ins/` 中的员工是从 `employees/presets/` 模板实例化而来
- **集中管理**：所有工作区数据集中在项目内，方便备份和迁移
- **可导入导出**：整个工作区可导出为 `.json` 团队包，在其他环境中导入还原

## 导入导出

导出后的 JSON 格式：
```json
{
  "version": 1,
  "type": "team",
  "exportedAt": "2024-01-01T00:00:00Z",
  "workspace": {
    "name": "我的项目",
    "description": "",
    "settings": {}
  },
  "employees": [...],
  "connections": [...],
  "scripts": [...],
  "experience": [...],
  "skills": [...]
}
```
