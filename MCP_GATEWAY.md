# Hermes MCP Gateway — 多实例部署指南

## 概述

当多台机器各自运行 Hermes WebUI 时，MCP Gateway 作为统一入口：
- **实例发现**：自动注册 + 心跳，动态感知在线实例
- **任务路由**：按指定人/技能/空闲度智能选择执行者
- **NAT 友好**：WebUI 只需出站访问 Gateway（Pull 模式），无需暴露端口

## 架构图

```
┌───────────────────────────────────────────────────────────┐
│                    Knot 智能体平台                          │
│                                                           │
│  调用 MCP 工具:                                            │
│    list_agents() → 查看在线实例                             │
│    delegate_task(task="...", assigned_to="zhangsan@PC")    │
└────────────────────────┬──────────────────────────────────┘
                         │ MCP Protocol (Streamable HTTP)
                         ▼
┌───────────────────────────────────────────────────────────┐
│            MCP Gateway (DevCloud / 公网服务器)              │
│                                                           │
│  Port 8080: HTTP REST API (注册/心跳/任务队列)              │
│  Port 8081: FastMCP Server (MCP 工具协议)                  │
│                                                           │
│  ┌──────────────────────────────────────────────────────┐ │
│  │  实例注册表          │  任务队列                       │ │
│  │  zhangsan@PC: idle  │  task-abc: pending → running   │ │
│  │  lisi@Mac: busy     │  task-def: completed           │ │
│  │  server@prod: idle  │                                │ │
│  └──────────────────────────────────────────────────────┘ │
└──────┬──────────────────────────────┬─────────────────────┘
       │                              │
       │  ← 出站 HTTP (Pull)          │  ← 出站 HTTP (Pull)
       ▼                              ▼
┌──────────────────┐          ┌──────────────────┐
│  张三的 PC        │          │  李四的 Mac       │
│  WebUI :18080    │          │  WebUI :18080    │
│                  │          │                  │
│  注册→Gateway    │          │  注册→Gateway    │
│  心跳 30s/次     │          │  心跳 30s/次     │
│  拉取任务 5s/次  │          │  拉取任务 5s/次  │
│  本地执行 Agent  │          │  本地执行 Agent  │
│  回报结果→Gateway│          │  回报结果→Gateway│
└──────────────────┘          └──────────────────┘
```

## 快速开始

### 1. 部署 Gateway（DevCloud / 公网服务器）

```bash
# 克隆项目
cd hermes-webui-studio

# 配置环境变量
cp .env.gateway.example .env.gateway
# 编辑 .env.gateway，设置 HERMES_GATEWAY_TOKEN

# 安装 FastMCP（可选，不装则只有 HTTP 模式）
pip install fastmcp

# 启动
bash start-gateway.sh        # Linux/macOS
# 或
start-gateway.bat            # Windows
```

Gateway 启动后会监听：
- `http://0.0.0.0:8080` — REST API（实例注册/心跳/任务队列）
- `http://0.0.0.0:8081` — MCP Server（Knot 连接此端口）

### 2. 配置 WebUI 实例（每台开发者机器）

在每台运行 WebUI 的机器上，设置环境变量：

```bash
# 方式 1：在 .env 文件中添加
echo "HERMES_MCP_GATEWAY=http://gateway-server-ip:8080" >> .env
echo "HERMES_GATEWAY_TOKEN=your-secret-token-here" >> .env

# 方式 2：直接 export
export HERMES_MCP_GATEWAY=http://10.x.x.x:8080
export HERMES_GATEWAY_TOKEN=your-secret-token-here

# 可选：自定义实例 ID 和名称
export HERMES_AGENT_ID=zhangsan@my-pc
export HERMES_AGENT_NAME="张三的 Hermes"
```

然后正常启动 WebUI：

```bash
python server.py
# 或
start.bat / start.sh
```

启动时会看到：
```
[mcp-client] Gateway: http://10.x.x.x:8080
[mcp-client] Agent ID: zhangsan@DESKTOP-A1B2C3D
[mcp-client] Registered to Gateway as 'zhangsan@DESKTOP-A1B2C3D'
[mcp-client] Worker started (polling for tasks).
```

### 3. 在 Knot 注册 MCP

在 Knot MCP 市场注册一个 MCP：

| 字段 | 值 |
|------|-----|
| 名称 | hermes-team |
| URL | `http://gateway-server-ip:8081/mcp` |
| 传输方式 | streamable-http |
| 鉴权 | Bearer Token（如果设置了的话） |

### 4. Knot 智能体 Prompt 配置

在智能体系统提示中加入：

```
你可以通过 hermes-team MCP 调用团队成员的 Hermes Agent。

## 使用流程

1. 先调用 list_agents() 查看在线实例
2. 根据任务选择实例：
   - 用户指定某人 → assigned_to 参数
   - 需要特定技能 → 先 list_skills() 确认
   - 未指定 → 留空，系统自动选择空闲实例
3. 调用 delegate_task(task="...", assigned_to="...") 委派任务
4. 等待结果返回并告知用户

## 实例 ID 格式

agent_id 格式为 "用户名@主机名"，如：
- zhangsan@DESKTOP-A1B2C3D
- lisi@MacBook-Pro.local
```

## 环境变量参考

### Gateway 侧

| 变量 | 说明 | 默认值 |
|------|------|--------|
| `HERMES_GATEWAY_PORT` | HTTP API 端口 | 8080 |
| `HERMES_GATEWAY_HOST` | 监听地址 | 0.0.0.0 |
| `HERMES_GATEWAY_DATA` | 数据存储目录 | /data/hermes-gateway |
| `HERMES_GATEWAY_TOKEN` | API 鉴权 Token | 空（无鉴权） |

### WebUI 侧

| 变量 | 说明 | 默认值 |
|------|------|--------|
| `HERMES_MCP_GATEWAY` | Gateway URL | 空（不启用） |
| `HERMES_GATEWAY_TOKEN` | API 鉴权 Token | 空 |
| `HERMES_AGENT_ID` | 实例 ID | `user@hostname` |
| `HERMES_AGENT_NAME` | 实例显示名 | "用户名 的 Hermes" |

## API 参考

### Gateway HTTP REST API

#### POST /register — 实例注册

```json
{
  "agent_id": "zhangsan@DESKTOP-A1B2C3D",
  "name": "张三的 Hermes",
  "url": "http://10.0.1.50:18080",
  "token": "webui-password",
  "workspace": "/home/zhangsan/project",
  "model": "openai/gpt-5.4-mini",
  "skills": ["code-review", "debug"],
  "status": "idle"
}
```

#### POST /heartbeat — 心跳

```json
{
  "agent_id": "zhangsan@DESKTOP-A1B2C3D",
  "status": "idle"
}
```

#### GET /tasks/poll?agent_id=xxx — 拉取任务

响应：
```json
{
  "task": {
    "task_id": "abc123",
    "message": "帮我审查这段代码",
    "skill": "code-review",
    "assigned_to": "zhangsan@DESKTOP-A1B2C3D",
    "status": "assigned",
    "timeout_seconds": 300
  }
}
```

#### POST /tasks/result — 回报结果

```json
{
  "task_id": "abc123",
  "status": "completed",
  "result": "代码审查完成，发现 3 个问题..."
}
```

#### GET /agents — 列出在线实例

#### GET /health — 健康检查

### MCP 工具

| 工具 | 说明 | 参数 |
|------|------|------|
| `list_agents` | 列出在线实例 | 无 |
| `delegate_task` | 委派任务 | task, skill?, assigned_to?, timeout? |
| `list_skills` | 查看实例技能 | agent_id? |
| `get_task_status` | 查询任务状态 | task_id |

## 任务执行流程

```
1. Knot Agent 调用 delegate_task(task="...", assigned_to="zhangsan@PC")
   │
2. Gateway 将任务入队 (status: pending, assigned_to: zhangsan@PC)
   │
3. 张三的 WebUI Worker 每 5 秒 poll → 拿到任务
   │
4. Worker 上报 status: running
   │
5. Worker 调用本地 AIAgent.chat(message) 执行
   │
6. Worker 上报结果 → status: completed, result: "..."
   │
7. Gateway 唤醒等待的 delegate_task 调用 → 返回结果给 Knot
```

## 安全考虑

1. **Token 鉴权**：设置 `HERMES_GATEWAY_TOKEN`，所有注册/心跳/任务请求都需要带 Bearer Token
2. **HTTPS**：生产环境建议通过 Nginx 反向代理添加 TLS
3. **网络隔离**：Gateway 只需对 WebUI 实例和 Knot 平台可达
4. **实例身份**：agent_id 基于 user@hostname 自然唯一，且人类可读

## 故障处理

| 场景 | 处理方式 |
|------|----------|
| WebUI 离线 | 心跳超时 90s 后自动从注册表移除 |
| 任务超时 | 默认 300s，超时后标记为 timeout 状态 |
| Gateway 重启 | 注册表持久化到磁盘，重启后恢复；WebUI 会自动重新注册 |
| 网络断开 | WebUI 心跳失败会重试，不影响本地使用 |

## Docker 部署

```yaml
# docker-compose.gateway.yml
version: "3.8"
services:
  hermes-gateway:
    build:
      context: .
      dockerfile: Dockerfile.gateway
    ports:
      - "8080:8080"   # REST API
      - "8081:8081"   # MCP Server
    volumes:
      - gateway-data:/data/hermes-gateway
    environment:
      - HERMES_GATEWAY_TOKEN=your-secret-token
      - HERMES_GATEWAY_DATA=/data/hermes-gateway
    restart: unless-stopped

volumes:
  gateway-data:
```

```dockerfile
# Dockerfile.gateway
FROM python:3.11-slim
WORKDIR /app
COPY mcp_gateway/ ./mcp_gateway/
RUN pip install --no-cache-dir fastmcp
EXPOSE 8080 8081
CMD ["python", "-m", "mcp_gateway"]
```
