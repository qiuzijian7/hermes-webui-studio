# hermes-webui-studio 功能分析报告

**分析日期**: 2026-05-04  
**分析者**: AI Agent  
**目标**: 将 hermes-webui-studio 的功能整合到 sarosis-webui

---

## 项目概述

### hermes-webui-studio
- **技术栈**: 原生 JavaScript (Vanilla JS) + 静态 HTML + CSS
- **数据持久化**: localStorage
- **UI 模式**: 多面板单页应用（ sidebar + 多个 panel）
- **主要文件**: `static/*.js` (20+ 个 JS 文件)

### sarosis-webui (已有)
- **技术栈**: Next.js 15 + React 19 + TypeScript
- **数据持久化**: 基于文件系统的 JSON 数据库 (`.db/` 目录)
- **UI 模式**: 组件化架构 (Next.js App Router)
- **已有功能**: 8 个 API 路由（Teams、Employees、Tasks、Skills、Memory、Profiles、Todos、Files）

---

## hermes-webui-studio 功能清单

### 1. 员工管理 (Employee Management)
**文件**: `employee.js`

#### 功能特性
- ✅ 员工卡片渲染（头像、名称、角色、状态）
- ✅ 员工预设系统（按分类筛选：总监、主管、程序员、设计师、引擎专家）
- ✅ 拖拽员工到画布
- ✅ 员工头像生成（DiceBear API，多种风格）
- ✅ 员工状态管理（空闲、工作中、思考中、出错、离线）
- ✅ 员工数据按工作区隔离存储
- ✅ 员工会话管理（每个员工独立的 session）
- ✅ 员工级配置（system prompt、model、skills）
- ✅ 员工记忆系统（个人记忆、团队记忆）
- ✅ 员工 token 使用统计

#### 需要整合到 sarosis-webui
- [ ] 员工卡片组件（带状态显示）
- [ ] 员工预设面板（带分类筛选）
- [ ] 拖拽功能（如果 sarosis-webui 有画布）
- [ ] 员工头像生成（DiceBear 集成）
- [ ] 员工状态管理（需后端支持）
- [ ] 按工作区隔离数据（已支持，通过 API）
- [ ] 员工会话管理（需后端支持）
- [ ] 员工级配置 UI

---

### 2. 团队管理 (Team Management)
**文件**: `index.html` (团队预设面板)

#### 功能特性
- ✅ 团队预设系统（一键创建完整团队）
- ✅ 团队层级关系可视化
- ✅ 团队成员连线

#### 需要整合到 sarosis-webui
- [ ] 团队预设面板
- [ ] 一键创建团队功能
- [ ] 团队层级可视化（需画布支持）

---

### 3. 任务管理 (Task Management / Cron Jobs)
**文件**: `index.html` (Tasks panel), `delegation-handler.js`, `delegation-vm.js`

#### 功能特性
- ✅ Cron 任务创建（定时任务）
- ✅ 任务调度管理（start/stop/delete）
- ✅ 任务执行历史
- ✅ 任务委派（员工之间互相委派任务）
- ✅ 任务队列（员工忙碌时排队）
- ✅ PM 专员委派（通过项目经理统一委派）

#### 需要整合到 sarosis-webui
- [ ] Cron 任务管理 UI
- [ ] 任务创建/编辑表单
- [ ] 任务列表（带状态显示）
- [ ] 任务委派 UI（需后端支持）
- [ ] 任务队列可视化（需后端支持）

---

### 4. 技能管理 (Skill Management)
**文件**: `index.html` (Skills panel), `agent-presets.js`

#### 功能特性
- ✅ 技能创建/编辑（支持 YAML frontmatter）
- ✅ 技能搜索/筛选
- ✅ 技能分类管理
- ✅ 技能与员工关联

#### 需要整合到 sarosis-webui
- [ ] 技能管理面板（已有 API，需 UI）
- [ ] 技能创建/编辑表单（支持 YAML 编辑）
- [ ] 技能搜索/筛选功能
- [ ] 技能与员工关联 UI

---

### 5. 记忆管理 (Memory Management)
**文件**: `index.html` (Memory panel), `memory-panel.js`

#### 功能特性
- ✅ 个人记忆编辑
- ✅ 记忆分类（fact、reference、context、instruction）
- ✅ 记忆标签系统
- ✅ 记忆实时编辑

#### 需要整合到 sarosis-webui
- [ ] 记忆管理面板（已有 API，需 UI）
- [ ] 记忆编辑功能
- [ ] 记忆分类/标签筛选

---

### 6. 工作区管理 (Workspace Management)
**文件**: `workspace.js`, `index.html` (Workspaces panel)

#### 功能特性
- ✅ 工作区切换
- ✅ 工作区列表显示
- ✅ 文件浏览器（目录树）
- ✅ 文件预览（图片、Markdown、代码）
- ✅ Git 状态显示（分支、dirty、ahead/behind）
- ✅ 文件上传/下载
- ✅ 拖拽上传文件

#### 需要整合到 sarosis-webui
- [ ] 工作区管理面板（已有 API，需 UI）
- [ ] 文件浏览器 UI（需 API 支持）
- [ ] 文件预览功能
- [ ] Git 状态显示（需后端支持）

---

### 7. 会话管理 (Session Management)
**文件**: `sessions.js`, `messages.js`

#### 功能特性
- ✅ 多会话管理（创建、重命名、删除、固定）
- ✅ 会话列表显示
- ✅ 会话搜索
- ✅ 会话导入/导出

#### 需要整合到 sarosis-webui
- [ ] 会话管理 UI（需后端支持）
- [ ] 会话列表/搜索
- [ ] 会话导入/导出

---

### 8. 消息处理 (Message Handling)
**文件**: `messages.js`

#### 功能特性
- ✅ 实时消息流（streaming）
- ✅ 消息编辑/删除
- ✅ 工具调用显示（live tool cards）
- ✅ 消息队列（忙碌时排队）
- ✅ 斜杠命令（slash commands）
- ✅ @mention 委派检测
- ✅ 文件附件上传

#### 需要整合到 sarosis-webui
- [ ] 实时消息流 UI（需后端支持）
- [ ] 消息编辑/删除功能
- [ ] 工具调用可视化
- [ ] 斜杠命令支持
- [ ] 文件附件上传

---

### 9. 子 Agent 管理 (Sub-Agent Management)
**文件**: `agents-panel.js`

#### 功能特性
- ✅ 显示派生的子 agent 列表
- ✅ 子 agent 状态监控（pending、running、steered、completed、failed）
- ✅ Steer 子 agent（发送引导消息）
- ✅ Cancel 子 agent（取消执行）
- ✅ 自动轮询更新状态

#### 需要整合到 sarosis-webui
- [ ] 子 Agent 管理面板（需后端支持）
- [ ] 子 Agent 状态显示
- [ ] Steer/Cancel 功能

---

### 10. 画布/可视化 (Canvas/Visualization)
**文件**: `canvas-connections.js`, `delegation-vm.js`

#### 功能特性
- ✅ 员工卡片在画布上可视化
- ✅ 员工之间的连线（委派关系）
- ✅ 工作流模板（批量创建员工 + 连线）
- ✅ 画布缩放/拖拽

#### 需要整合到 sarosis-webui
- [ ] 画布功能（如果 sarosis-webui 需要）
- [ ] 员工关系可视化
- [ ] 工作流模板应用

---

### 11. Dock 管理 (Dock Management)
**文件**: `dock.js`, `dock-manager.js`

#### 功能特性
- ✅ 可拖拽的 Dock 面板
- ✅ Dock 布局保存/恢复
- ✅ 多 Dock 支持

#### 需要整合到 sarosis-webui
- [ ] Dock 布局系统（如果 sarosis-webui 需要）

---

### 12. 其他功能

#### 12.1 代码编辑器集成
**文件**: `cm-editor.js`
- ✅ CodeMirror 6 集成
- ✅ 语法高亮
- ✅ 主题适配（dark/light）

#### 12.2 浏览器面板
**文件**: `browser-panel.js`
- ✅ 内嵌浏览器
- ✅ 网页预览

#### 12.3 国际化 (i18n)
**文件**: `i18n.js`
- ✅ 多语言支持（中文、英文）
- ✅ 动态切换语言

#### 12.4 登录/认证
**文件**: `login.js`
- ✅ 简单的登录界面

#### 12.5 新手引导
**文件**: `onboarding.js`
- ✅ 首次使用引导
- ✅ 功能介绍

#### 12.6 日志面板
**文件**: `logs-panel.js`
- ✅ 查看系统日志
- ✅ 日志级别筛选

#### 12.7 用户操作日志
**文件**: `user-action-log.js`
- ✅ 记录用户操作
- ✅ 操作回放（可能）

---

## 整合优先级建议

### P0 - 核心功能（必须整合）
1. **员工管理 UI** - 员工卡片、列表、创建/编辑
2. **技能管理 UI** - 技能列表、创建/编辑
3. **记忆管理 UI** - 记忆列表、编辑
4. **工作区管理 UI** - 工作区切换、文件浏览器

### P1 - 重要功能（应该整合）
1. **团队管理 UI** - 团队列表、创建/编辑
2. **任务管理 UI** - 任务列表、创建/编辑
3. **Cron 任务管理 UI** - 定时任务管理
4. **会话管理 UI** - 多会话支持

### P2 - 高级功能（可以后整合）
1. **消息流 UI** - 实时消息、工具调用显示
2. **子 Agent 管理 UI** - 子 Agent 监控
3. **员工委派系统** - 任务委派、队列
4. **画布/可视化** - 员工关系可视化

### P3 - 增强功能（可选整合）
1. **代码编辑器集成**
2. **浏览器面板**
3. **国际化 (i18n)**
4. **新手引导**
5. **Dock 管理**

---

## 技术挑战

### 1. 架构差异
- **hermes-webui-studio**: 原生 JS，单页应用，localStorage
- **sarosis-webui**: React/Next.js，组件化，JSON 数据库 + API

**解决方案**: 将原生 JS 功能重写为 React 组件，使用 API 替代 localStorage

### 2. 后端支持
- **hermes-webui-studio**: 依赖 Python 后端（Hermes Agent）
- **sarosis-webui**: 需要独立的后端 API（已实现 8 个）

**解决方案**: 
- 扩展现有 API（如需要会话管理，需新增 API）
- 或连接 Hermes Agent 后端

### 3. 实时功能
- **消息流、状态更新** 需要 WebSocket 或轮询

**解决方案**: 
- 使用 React Query 轮询
- 或集成 WebSocket（如 Socket.io）

---

## 下一步行动

### 第一步：确认优先级
**问题**: 你希望优先整合哪些功能？
- [ ] P0 核心功能（员工、技能、记忆、工作区 UI）
- [ ] P1 重要功能（团队、任务、Cron、会话 UI）
- [ ] P2 高级功能（消息流、子 Agent、委派系统）
- [ ] P3 增强功能（代码编辑器、浏览器、i18n）

### 第二步：制定详细计划
根据确认的优先级，制定分阶段整合计划。

### 第三步：开始实施
按阶段逐步实现功能，每个阶段完成后验证。

---

## 附录：文件功能映射

| 文件 | 主要功能 | 整合优先级 |
|------|---------|------------|
| `employee.js` | 员工管理 | P0 |
| `agents-panel.js` | 子 Agent 管理 | P2 |
| `workspace.js` | 工作区/文件管理 | P0 |
| `messages.js` | 消息处理 | P2 |
| `sessions.js` | 会话管理 | P1 |
| `delegation-handler.js` | 任务委派 | P2 |
| `delegation-vm.js` | 委派虚拟机 | P2 |
| `canvas-connections.js` | 画布连线 | P2 |
| `agent-presets.js` | 员工预设 | P0 |
| `i18n.js` | 国际化 | P3 |
| `cm-editor.js` | 代码编辑器 | P3 |
| `browser-panel.js` | 浏览器面板 | P3 |
| `dock.js` | Dock 管理 | P3 |
| `onboarding.js` | 新手引导 | P3 |
| `logs-panel.js` | 日志面板 | P1 |

---

**分析完成**。请确认优先级，我将制定详细的整合计划并开始实施。
