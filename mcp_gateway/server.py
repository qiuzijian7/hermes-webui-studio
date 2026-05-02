"""
Hermes MCP Gateway — FastMCP Server + 注册/心跳/任务 HTTP API。

统一进程，单端口暴露两套接口：
  1. MCP 协议端点（/mcp）— Knot 智能体通过 MCP 调用工具
  2. HTTP REST API（其他路径）— Hermes WebUI 实例注册/心跳/取任务/回报结果

运行方式：
    python -m mcp_gateway.server

环境变量：
    HERMES_GATEWAY_PORT    — 统一端口（默认 8080，MCP 和 HTTP API 共用）
    HERMES_GATEWAY_HOST    — 监听地址（默认 0.0.0.0）
    HERMES_GATEWAY_DATA    — 数据目录（默认 /data/hermes-gateway）
    HERMES_GATEWAY_TOKEN   — API 鉴权 Token（可选，保护注册接口）
"""
from __future__ import annotations

import json
import os
import threading
import time
from pathlib import Path

from .registry import InstanceRegistry
from .task_queue import TaskQueue, TaskStatus

# ── 配置 ──────────────────────────────────────────────────────────────────────
GATEWAY_HOST = os.getenv("HERMES_GATEWAY_HOST", "0.0.0.0")
GATEWAY_PORT = int(os.getenv("HERMES_GATEWAY_PORT", "8080"))
GATEWAY_DATA = Path(os.getenv("HERMES_GATEWAY_DATA", "/data/hermes-gateway"))
GATEWAY_TOKEN = os.getenv("HERMES_GATEWAY_TOKEN", "")  # 空=无鉴权

# ── 全局实例 ──────────────────────────────────────────────────────────────────
registry = InstanceRegistry(GATEWAY_DATA / "registry.json")
task_queue = TaskQueue(GATEWAY_DATA / "tasks.json")

# 定期清理线程
_cleanup_thread: threading.Thread | None = None


def _cleanup_loop():
    """后台清理：过期任务 + 离线实例。"""
    while True:
        time.sleep(60)
        try:
            task_queue.cleanup(max_age=3600)
        except Exception:
            pass


# ── MCP 工具定义（用于 FastMCP 注册）─────────────────────────────────────────

# FastMCP 工具函数，后面 server 启动时注册

def mcp_list_agents() -> dict:
    """列出所有在线的 Hermes Agent 实例及其状态和技能。

    返回每个实例的 ID、名称、状态、技能列表（含描述）、工作区和模型信息。
    用于发现可用的 Agent 实例，决定任务路由。
    """
    instances = registry.list_all()
    return {
        "agents": [
            {
                "id": inst["agent_id"],
                "name": inst.get("name", inst["agent_id"]),
                "status": inst.get("status", "unknown"),
                "skills": inst.get("skills", []),
                "skills_detail": inst.get("skills_detail", []),
                "workspace": inst.get("workspace", ""),
                "model": inst.get("model", ""),
                "last_heartbeat_ago": f"{int(time.time() - inst.get('last_heartbeat', 0))}s",
            }
            for inst in instances
        ],
        "total_online": len(instances),
    }


def mcp_delegate_task(task: str, skill: str = "",
                      assigned_to: str = "", timeout: int = 300) -> dict:
    """委派任务给 Hermes Agent 执行。

    任务将进入队列，由指定（或自动选择的）Agent 拉取并执行。
    调用后会同步等待结果返回，直到超时。

    Args:
        task: 任务描述/消息内容（必填）
        skill: 要使用的技能名（空则由 Agent 自行决策）
        assigned_to: 指定实例 ID，如 "zhangsan@DESKTOP-ABC"（空则自动选择空闲实例）
        timeout: 超时秒数（默认 300，最大 600）
    """
    timeout = min(max(timeout, 30), 600)

    # 确定目标
    target = assigned_to
    if not target:
        target = registry.select(skill=skill)
    if not target:
        return {"status": "error", "error": "No online Hermes agent available. Use list_agents() to check."}

    # 验证目标在线
    inst = registry.get(target)
    if not inst:
        return {"status": "error", "error": f"Agent '{target}' not found or offline."}

    # 提交任务
    t = task_queue.submit(
        message=task,
        skill=skill,
        assigned_to=target,
        timeout_seconds=timeout,
        metadata={"target_name": inst.get("name", target)},
    )

    # 同步等待结果
    result_task = task_queue.wait_for_result(t.task_id, timeout=timeout)

    if result_task is None:
        return {"status": "error", "error": "Task lost from queue."}

    return {
        "status": result_task.status.value,
        "task_id": result_task.task_id,
        "result": result_task.result or result_task.error,
        "executed_by": result_task.assigned_to,
        "duration_seconds": round(result_task.completed_at - result_task.created_at, 1)
        if result_task.completed_at > 0 else None,
    }


def mcp_list_skills(agent_id: str = "") -> dict:
    """列出指定 Hermes Agent 实例可用的技能列表（含每个技能的描述和分类）。

    Knot 在每次用户聊天时应先调用此工具，了解该客户端可执行哪些技能，
    然后在执行任务时通过 delegate_task(skill="xxx") 调用对应技能。

    Args:
        agent_id: 实例 ID（空则查默认/第一个在线实例）

    Returns:
        skills: 技能名称列表
        skills_detail: 详细技能信息列表（含 name, description, category, tags）
    """
    aid = agent_id or registry.select()
    if not aid:
        return {"error": "No online agent available."}

    inst = registry.get(aid)
    if not inst:
        return {"error": f"Agent '{aid}' not found or offline."}

    return {
        "agent_id": aid,
        "agent_name": inst.get("name", aid),
        "skills": inst.get("skills", []),
        "skills_detail": inst.get("skills_detail", []),
        "model": inst.get("model", ""),
        "workspace": inst.get("workspace", ""),
    }


def mcp_get_task_status(task_id: str) -> dict:
    """查询任务执行状态。

    Args:
        task_id: 任务 ID（由 delegate_task 返回）
    """
    task = task_queue.get(task_id)
    if not task:
        return {"error": f"Task '{task_id}' not found."}
    return task.to_dict()


def mcp_execute_skill(skill: str, task: str, agent_id: str = "",
                      timeout: int = 300) -> dict:
    """直接执行指定技能（delegate_task 的简化接口）。

    这是推荐给 Knot 使用的主要执行入口。只需指定技能名和任务描述即可。
    系统会自动选择拥有该技能的在线 Agent 执行。

    Args:
        skill: 技能名称（必填，如 "code-review", "plan", "debug"）
        task: 任务描述/上下文信息（必填）
        agent_id: 可选，指定执行的 Agent 实例 ID（空则自动选择）
        timeout: 超时秒数（默认 300，最大 600）

    Returns:
        status: completed / failed / timeout / error
        result: 执行结果文本
        skill: 实际使用的技能名
        executed_by: 执行的 Agent ID
        duration_seconds: 耗时（秒）
    """
    if not skill.strip():
        return {"status": "error", "error": "skill parameter is required. Use list_skills() to see available skills."}
    if not task.strip():
        return {"status": "error", "error": "task parameter is required. Describe what you want the skill to do."}

    # 委派给 delegate_task 逻辑
    result = mcp_delegate_task(
        task=task,
        skill=skill.strip(),
        assigned_to=agent_id,
        timeout=min(max(timeout, 30), 600),
    )

    # 增强返回信息
    result["skill"] = skill.strip()
    return result


# ── Starlette HTTP API 路由 ───────────────────────────────────────────────────

def _check_token(headers) -> bool:
    """验证 Bearer Token（如果配置了的话）。"""
    if not GATEWAY_TOKEN:
        return True
    auth = headers.get("authorization", "")
    return auth == f"Bearer {GATEWAY_TOKEN}"


def _json(data: dict, status: int = 200):
    """快速构造 JSON Response。"""
    from starlette.responses import JSONResponse
    return JSONResponse(data, status_code=status, headers={"Access-Control-Allow-Origin": "*"})


def _build_starlette_app():
    """构建 Starlette ASGI 应用（HTTP REST API 部分）。"""
    from starlette.applications import Starlette
    from starlette.routing import Route
    from starlette.requests import Request
    from starlette.responses import Response
    from starlette.middleware import Middleware
    from starlette.middleware.cors import CORSMiddleware

    async def health(request: Request):
        instances = registry.list_all()
        return _json({
            "status": "ok",
            "online_agents": len(instances),
            "uptime": "running",
        })

    async def agents(request: Request):
        if not _check_token(request.headers):
            return _json({"error": "Unauthorized"}, 401)
        include_offline = "all" in request.query_params
        instances = registry.list_all(include_offline=include_offline)
        return _json({"instances": instances})

    async def tasks_poll(request: Request):
        if not _check_token(request.headers):
            return _json({"error": "Unauthorized"}, 401)
        agent_id = request.query_params.get("agent_id", "")
        if not agent_id:
            return _json({"error": "agent_id required"}, 400)
        task = task_queue.poll(agent_id)
        if task:
            return _json({"task": task.to_dict()})
        return _json({"task": None})

    async def tasks_status(request: Request):
        task_id = request.query_params.get("task_id", "")
        if not task_id:
            return _json({"error": "task_id required"}, 400)
        task = task_queue.get(task_id)
        if task:
            return _json({"task": task.to_dict()})
        return _json({"error": "not found"}, 404)

    async def register(request: Request):
        if not _check_token(request.headers):
            return _json({"error": "Unauthorized"}, 401)
        body = await request.json()
        agent_id = body.get("agent_id", "").strip()
        if not agent_id:
            return _json({"error": "agent_id required"}, 400)
        entry = registry.register(agent_id, body)
        print(f"[gateway] Registered: {agent_id} ({body.get('name', '')})", flush=True)
        return _json({"ok": True, "agent_id": agent_id, "entry": entry})

    async def heartbeat(request: Request):
        if not _check_token(request.headers):
            return _json({"error": "Unauthorized"}, 401)
        body = await request.json()
        agent_id = body.get("agent_id", "").strip()
        if not agent_id:
            return _json({"error": "agent_id required"}, 400)
        status = body.get("status", "idle")
        ok = registry.heartbeat(agent_id, status, extra=body.get("extra"))
        if not ok:
            registry.register(agent_id, body)
        return _json({"ok": True})

    async def unregister(request: Request):
        if not _check_token(request.headers):
            return _json({"error": "Unauthorized"}, 401)
        body = await request.json()
        agent_id = body.get("agent_id", "").strip()
        if agent_id:
            registry.unregister(agent_id)
        return _json({"ok": True})

    async def tasks_result(request: Request):
        if not _check_token(request.headers):
            return _json({"error": "Unauthorized"}, 401)
        body = await request.json()
        task_id = body.get("task_id", "").strip()
        if not task_id:
            return _json({"error": "task_id required"}, 400)
        status_str = body.get("status", "completed")
        try:
            task_status = TaskStatus(status_str)
        except ValueError:
            task_status = TaskStatus.COMPLETED
        ok = task_queue.update_status(
            task_id=task_id,
            status=task_status,
            result=body.get("result", ""),
            error=body.get("error", ""),
            session_id=body.get("session_id", ""),
        )
        return _json({"ok": ok})

    async def tasks_update(request: Request):
        if not _check_token(request.headers):
            return _json({"error": "Unauthorized"}, 401)
        body = await request.json()
        task_id = body.get("task_id", "").strip()
        if not task_id:
            return _json({"error": "task_id required"}, 400)
        try:
            task_status = TaskStatus(body.get("status", "running"))
        except ValueError:
            task_status = TaskStatus.RUNNING
        ok = task_queue.update_status(
            task_id=task_id,
            status=task_status,
            session_id=body.get("session_id", ""),
        )
        return _json({"ok": ok})

    routes = [
        Route("/health", health, methods=["GET"]),
        Route("/agents", agents, methods=["GET"]),
        Route("/tasks/poll", tasks_poll, methods=["GET"]),
        Route("/tasks/status", tasks_status, methods=["GET"]),
        Route("/register", register, methods=["POST"]),
        Route("/heartbeat", heartbeat, methods=["POST"]),
        Route("/unregister", unregister, methods=["POST"]),
        Route("/tasks/result", tasks_result, methods=["POST"]),
        Route("/tasks/update", tasks_update, methods=["POST"]),
    ]

    app = Starlette(
        routes=routes,
        middleware=[
            Middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"]),
        ],
    )
    return app


# ── FastMCP 创建 ─────────────────────────────────────────────────────────────

def _build_mcp_server():
    """创建 FastMCP 实例并注册工具（不启动服务）。"""
    try:
        from fastmcp import FastMCP
    except ImportError:
        print("[gateway] ERROR: fastmcp not installed. Run: pip install fastmcp", flush=True)
        return None

    mcp = FastMCP("hermes-team", instructions="""
Hermes Team MCP Gateway — 连接多个 Hermes Agent 实例的协调网关。

## 概述

本 MCP 服务连接分布在不同机器上的 Hermes Agent 实例，每个实例拥有独立的技能集合。
客户端（如 Knot-AGUI）通过 MCP 协议发现可用技能并委派任务执行。

## 推荐使用流程

### 步骤 1: 发现可用技能
在每次用户聊天开始时，调用 list_skills() 获取当前在线 Agent 的技能列表：
- 返回 skills（名称列表）和 skills_detail（含描述/分类的详细列表）
- skills_detail 中每个条目有 name、description、category、tags 字段
- 利用 description 来判断用户意图与哪个技能匹配

### 步骤 2: 任务委派
当需要执行具体任务时，调用 delegate_task()：
- 设置 skill 参数指定要使用的技能名（从 skills 列表中选择）
- 设置 task 参数描述具体任务内容
- 可选 assigned_to 指定特定实例（适用于多实例场景）
- timeout 默认 300 秒，可按任务复杂度调整

### 步骤 3: 获取结果
delegate_task() 会同步等待执行结果返回。结果包含：
- status: completed / failed / timeout
- result: 执行结果文本
- duration_seconds: 耗时

## 多实例场景

如果连接了多个 Agent 实例（如不同开发者的机器），可以：
1. 调用 list_agents() 查看所有在线实例及其各自技能
2. 根据技能匹配或负载情况选择实例
3. 使用 assigned_to 精确指定

## 实例标识

每个实例有唯一 agent_id（格式: 用户名@主机名），如:
- zhangsan@DESKTOP-A1B2C3D
- lisi@MacBook-Pro
- deploy-server@prod-01

## 技能说明

技能（Skill）是 Hermes Agent 的专业能力模块，例如：
- code-review: 代码审查
- plan: 软件开发计划
- debug: 调试分析
- test: 测试生成

每个 Agent 实例可能拥有不同的技能集合，取决于其安装配置。
""")

    # 注册 MCP 工具
    mcp.tool(name="list_agents", description="列出所有在线的 Hermes Agent 实例及其状态和技能")(mcp_list_agents)
    mcp.tool(name="list_skills", description="列出可用技能（含描述/分类），建议每次聊天开始时调用")(mcp_list_skills)
    mcp.tool(name="execute_skill", description="执行指定技能（推荐入口：技能名+任务描述，自动路由）")(mcp_execute_skill)
    mcp.tool(name="delegate_task", description="委派任务给 Hermes Agent 执行（高级接口，支持指定实例/超时）")(mcp_delegate_task)
    mcp.tool(name="get_task_status", description="查询任务执行状态")(mcp_get_task_status)

    return mcp


# ── 统一启动入口 ──────────────────────────────────────────────────────────────

def run_gateway():
    """单端口统一启动 — HTTP API + MCP 协议 都在同一端口 (GATEWAY_PORT)。

    MCP 挂载在 /mcp 路径下，其余路径为 HTTP REST API。
    """
    global _cleanup_thread
    import uvicorn

    GATEWAY_DATA.mkdir(parents=True, exist_ok=True)

    # 启动清理线程
    _cleanup_thread = threading.Thread(target=_cleanup_loop, daemon=True)
    _cleanup_thread.start()

    # 构建 Starlette HTTP App
    http_app = _build_starlette_app()

    # 构建 FastMCP 并获取其 ASGI app
    mcp = _build_mcp_server()
    if mcp:
        # FastMCP http_app() 返回一个 Starlette/ASGI 应用
        # path="/" 表示 MCP 在这个子应用的根路径响应
        # 然后我们 mount 到 /mcp，最终外部访问 /mcp 即可
        mcp_asgi = mcp.http_app(path="/")
        http_app.mount("/mcp", mcp_asgi)
        print(f"[gateway] MCP endpoint mounted at /mcp", flush=True)
    else:
        print("[gateway] WARNING: FastMCP unavailable, running in HTTP-only mode", flush=True)

    print(f"[gateway] ═══════════════════════════════════════════════════════", flush=True)
    print(f"[gateway] Hermes MCP Gateway — Single Port Mode", flush=True)
    print(f"[gateway] Listening on http://{GATEWAY_HOST}:{GATEWAY_PORT}", flush=True)
    print(f"[gateway] Data directory: {GATEWAY_DATA}", flush=True)
    print(f"[gateway] Token auth: {'enabled' if GATEWAY_TOKEN else 'disabled'}", flush=True)
    print(f"[gateway] ───────────────────────────────────────────────────────", flush=True)
    print(f"[gateway] HTTP API Endpoints:", flush=True)
    print(f"           GET  /health        — 健康检查", flush=True)
    print(f"           GET  /agents        — 列出实例", flush=True)
    print(f"           POST /register      — 实例注册", flush=True)
    print(f"           POST /heartbeat     — 心跳", flush=True)
    print(f"           POST /unregister    — 注销", flush=True)
    print(f"           GET  /tasks/poll    — Worker 拉取任务", flush=True)
    print(f"           POST /tasks/result  — Worker 回报结果", flush=True)
    print(f"           POST /tasks/update  — Worker 更新状态", flush=True)
    print(f"[gateway] MCP Protocol:", flush=True)
    print(f"           POST /mcp           — MCP Streamable HTTP", flush=True)
    print(f"[gateway] ═══════════════════════════════════════════════════════", flush=True)
    print("", flush=True)

    uvicorn.run(http_app, host=GATEWAY_HOST, port=GATEWAY_PORT, log_level="info")


# 兼容旧的分离模式入口
def run_gateway_http():
    """（已废弃）旧的纯 HTTP 模式入口，现在重定向到统一入口。"""
    run_gateway()


def run_gateway_mcp():
    """（已废弃）旧的纯 MCP 模式入口，现在重定向到统一入口。"""
    run_gateway()


if __name__ == "__main__":
    import sys

    mode = sys.argv[1] if len(sys.argv) > 1 else "both"
    # 所有模式统一走单端口
    run_gateway()
