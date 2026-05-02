# Hermes MCP Gateway

多实例注册发现 + 技能路由网关，为 Knot 等 AI 客户端提供 MCP 协议接入。

## 架构概览

```
┌─────────────────────┐         MCP 协议 (streamable-http)
│  Knot / AGUI 客户端  │ ──────────────────────────────────►  ┌──────────────────┐
└─────────────────────┘                                       │  MCP Gateway     │
                                                              │  (port 8081)     │
                                                              └────────┬─────────┘
                                                                       │
                                                    ┌──────────────────┼──────────────────┐
                                                    │ HTTP REST API (port 8080)           │
                                                    │ • /register  • /heartbeat           │
                                                    │ • /tasks/poll  • /tasks/result      │
                                                    └──────────┬─────────────┬────────────┘
                                                               │             │
                                              ┌────────────────┘             └────────────────┐
                                              ▼                                               ▼
                                    ┌───────────────────┐                          ┌───────────────────┐
                                    │ Hermes WebUI #1   │                          │ Hermes WebUI #2   │
                                    │ (Agent + Skills)  │                          │ (Agent + Skills)  │
                                    └───────────────────┘                          └───────────────────┘
```

## 快速开始

### 1. 启动 Gateway

```bash
cd hermes-webui-studio/mcp_gateway

# 安装依赖
pip install fastmcp

# 启动（同时运行 HTTP API + MCP Server）
python -m mcp_gateway

# 仅 HTTP API
python -m mcp_gateway http

# 仅 MCP Server
python -m mcp_gateway mcp
```

**环境变量：**

| 变量 | 说明 | 默认值 |
|------|------|--------|
| `HERMES_GATEWAY_PORT` | HTTP API 端口 | 8080 |
| `HERMES_GATEWAY_HOST` | 监听地址 | 0.0.0.0 |
| `HERMES_GATEWAY_DATA` | 数据持久化目录 | /data/hermes-gateway |
| `HERMES_GATEWAY_TOKEN` | API 鉴权 Token（可选） | 空（无鉴权） |

> MCP Server 运行在 `HERMES_GATEWAY_PORT + 1` 端口（默认 8081）。

### 2. 配置 Hermes WebUI 连接 Gateway

在 Hermes WebUI 启动环境中设置：

```bash
export HERMES_MCP_GATEWAY=http://<gateway-host>:8080
export HERMES_GATEWAY_TOKEN=your-secret-token  # 如果 Gateway 启用了鉴权
```

WebUI 启动后会自动：
- 向 Gateway 注册（上报技能列表、模型、工作区等信息）
- 每 30 秒发送心跳（含最新技能列表）
- 启动 Worker 线程，每 5 秒拉取待执行任务

### 3. Knot 接入配置

在 Knot 的 MCP 配置中添加 Hermes Gateway：

```json
{
  "mcpServers": {
    "hermes-team": {
      "url": "http://<gateway-host>:8081/mcp",
      "transport": "streamable-http"
    }
  }
}
```

## MCP 工具列表

### `list_skills` — 查询可用技能 ⭐ 推荐首先调用

列出当前在线 Agent 拥有的所有技能，含名称、描述、分类。

```json
// 请求
{"skill": "", "agent_id": ""}

// 响应
{
  "agent_id": "zhangsan@DESKTOP-A1B2C3D",
  "agent_name": "张三的 Hermes",
  "skills": ["plan", "code-review", "debug", "test"],
  "skills_detail": [
    {"name": "plan", "description": "制定软件开发计划和架构设计", "category": "software-development", "tags": []},
    {"name": "code-review", "description": "代码审查与改进建议", "category": "software-development", "tags": []},
    {"name": "debug", "description": "调试问题分析与修复方案", "category": "software-development", "tags": []},
    {"name": "test", "description": "生成测试用例和测试代码", "category": "software-development", "tags": []}
  ],
  "model": "openai/gpt-5.4-mini",
  "workspace": "/home/zhangsan/project"
}
```

### `execute_skill` — 执行技能 ⭐ 推荐主要执行入口

简化接口：指定技能名 + 任务描述，自动路由到合适的 Agent。

```json
// 请求
{
  "skill": "code-review",
  "task": "请审查 src/utils.py 中的 parse_config 函数，关注错误处理和性能",
  "agent_id": "",
  "timeout": 300
}

// 响应
{
  "status": "completed",
  "task_id": "a1b2c3d4e5f6",
  "result": "## 代码审查结果\n\n### 问题 1: 缺少异常处理...",
  "skill": "code-review",
  "executed_by": "zhangsan@DESKTOP-A1B2C3D",
  "duration_seconds": 45.2
}
```

### `delegate_task` — 委派任务（高级接口）

提供更多控制选项：指定实例、自定义超时等。

```json
// 请求
{
  "task": "分析这段代码的性能瓶颈并给出优化方案",
  "skill": "debug",
  "assigned_to": "zhangsan@DESKTOP-A1B2C3D",
  "timeout": 600
}
```

### `list_agents` — 列出在线实例

查看所有已注册且在线的 Agent 实例。

```json
// 响应
{
  "agents": [
    {
      "id": "zhangsan@DESKTOP-A1B2C3D",
      "name": "张三的 Hermes",
      "status": "idle",
      "skills": ["plan", "code-review", "debug"],
      "skills_detail": [...],
      "workspace": "/home/zhangsan/project",
      "model": "openai/gpt-5.4-mini",
      "last_heartbeat_ago": "5s"
    }
  ],
  "total_online": 1
}
```

### `get_task_status` — 查询任务状态

用于异步场景或超时后检查任务进度。

## Knot-AGUI 集成最佳实践

### 推荐流程

```
用户发起聊天
    │
    ├─ 1. 调用 list_skills() 获取技能列表
    │     → 用 skills_detail 的 description 构建系统提示
    │     → 告知 AI "你可以使用以下技能：..."
    │
    ├─ 2. AI 根据用户意图决策是否需要调用技能
    │     → 匹配 description 与用户需求
    │
    └─ 3. 调用 execute_skill(skill="xxx", task="用户的具体需求")
          → 等待结果返回
          → 将结果呈现给用户
```

### 系统提示模板

```
你可以使用以下技能来完成用户的任务：

{{#each skills_detail}}
- **{{name}}**: {{description}}
{{/each}}

当用户的请求匹配某个技能时，使用 execute_skill 工具来执行。
直接将用户的需求描述作为 task 参数传入。
```

### 错误处理

| 错误场景 | 处理方式 |
|---------|---------|
| 无在线 Agent | 提示用户"当前没有可用的 Hermes 实例" |
| 任务超时 | 可增大 timeout 重试，或建议用户简化任务 |
| Agent 繁忙 | list_agents 检查状态，等待或选择其他实例 |
| 技能不存在 | 提示用户当前可用技能列表 |

## 安全

- **Token 鉴权**：设置 `HERMES_GATEWAY_TOKEN` 后，所有 API 请求需携带 `Authorization: Bearer <token>` 头
- **内网部署**：建议 Gateway 部署在内网或 VPN 环境中
- **实例隔离**：每个 WebUI 实例独立注册，互不干扰

## 开发调试

```bash
# 查看已注册实例
curl http://localhost:8080/agents

# 手动测试 MCP（需要 MCP 客户端工具）
# 或使用 fastmcp 的调试模式
python -c "
from mcp_gateway.server import mcp_list_skills, mcp_list_agents
print(mcp_list_agents())
print(mcp_list_skills())
"
```
