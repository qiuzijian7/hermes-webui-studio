"""
Hermes WebUI — MCP Gateway 注册客户端 + 任务 Worker。

在 WebUI 启动后自动向 MCP Gateway 注册本实例，
定期发送心跳，并拉取/执行委派任务。

配置环境变量：
    HERMES_MCP_GATEWAY      — Gateway URL（如 http://10.x.x.x:8080）
    HERMES_GATEWAY_TOKEN    — API 鉴权 Token（可选）
    HERMES_AGENT_NAME       — 实例显示名（默认自动生成）
    HERMES_AGENT_ID         — 实例 ID（默认 user@hostname）

此模块使用纯标准库（urllib），不需要额外依赖。
"""
from __future__ import annotations

import json
import os
import socket
import threading
import time
import traceback
import urllib.error
import urllib.request
from typing import Any

# ── 配置 ──────────────────────────────────────────────────────────────────────
MCP_GATEWAY_URL = os.getenv("HERMES_MCP_GATEWAY", "").rstrip("/")
GATEWAY_TOKEN = os.getenv("HERMES_GATEWAY_TOKEN", "")

HEARTBEAT_INTERVAL = 30   # 心跳间隔（秒）
POLL_INTERVAL = 5         # 任务拉取间隔（秒）
REGISTER_RETRY = 10       # 注册失败重试间隔

# ── 状态 ──────────────────────────────────────────────────────────────────────
_registered = False
_worker_thread: threading.Thread | None = None
_heartbeat_thread: threading.Thread | None = None
_stop_event = threading.Event()


# ── 工具函数 ──────────────────────────────────────────────────────────────────

def _get_agent_id() -> str:
    """生成唯一的 agent_id: user@hostname。"""
    # 允许环境变量覆盖
    override = os.getenv("HERMES_AGENT_ID", "").strip()
    if override:
        return override
    user = os.getenv("USER") or os.getenv("USERNAME") or "unknown"
    host = socket.gethostname()
    return f"{user}@{host}"


def _get_agent_name() -> str:
    """获取实例显示名。"""
    override = os.getenv("HERMES_AGENT_NAME", "").strip()
    if override:
        return override
    user = os.getenv("USER") or os.getenv("USERNAME") or "user"
    return f"{user} 的 Hermes"


def _get_local_ip() -> str:
    """获取本机可达 IP。"""
    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        s.settimeout(2)
        s.connect(("8.8.8.8", 80))
        ip = s.getsockname()[0]
        s.close()
        return ip
    except Exception:
        return "127.0.0.1"


def _http_request(path: str, method: str = "GET",
                  data: dict | None = None, timeout: int = 10) -> dict | None:
    """向 MCP Gateway 发送 HTTP 请求。"""
    if not MCP_GATEWAY_URL:
        return None

    url = f"{MCP_GATEWAY_URL}{path}"
    headers = {"Content-Type": "application/json"}
    if GATEWAY_TOKEN:
        headers["Authorization"] = f"Bearer {GATEWAY_TOKEN}"

    body = None
    if data is not None:
        body = json.dumps(data, ensure_ascii=False).encode("utf-8")

    req = urllib.request.Request(url, data=body, headers=headers, method=method)

    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            raw = resp.read().decode("utf-8")
            return json.loads(raw) if raw else {}
    except urllib.error.HTTPError as e:
        try:
            err_body = e.read().decode("utf-8")
            return {"_http_error": e.code, "_message": err_body}
        except Exception:
            return {"_http_error": e.code}
    except (urllib.error.URLError, OSError, TimeoutError):
        return None


def _get_skills() -> list[str]:
    """获取本实例可用的技能名称列表。"""
    skills = []
    try:
        from pathlib import Path
        hermes_home = os.getenv("HERMES_HOME", str(Path.home() / ".hermes"))
        skills_dir = Path(hermes_home) / "skills"
        if skills_dir.is_dir():
            skills = [d.name for d in skills_dir.iterdir()
                      if d.is_dir() and not d.name.startswith(".")]
    except Exception:
        pass
    return skills


def _get_skills_detail() -> list[dict]:
    """获取本实例可用技能的详细信息（含描述/标签），供 Knot 做智能匹配。

    返回格式：
        [{"name": "plan", "description": "软件开发计划", "category": "dev", "tags": [...]}, ...]
    """
    details = []
    try:
        from pathlib import Path
        import re as _re

        hermes_home = os.getenv("HERMES_HOME", str(Path.home() / ".hermes"))
        skills_dir = Path(hermes_home) / "skills"
        if not skills_dir.is_dir():
            return details

        # 也尝试全局 skills 库
        global_skills_dir = None
        try:
            from api.skill_resolver import GLOBAL_SKILLS_DIR
            global_skills_dir = GLOBAL_SKILLS_DIR
        except Exception:
            pass

        # 搜索所有 SKILL.md
        search_dirs = [skills_dir]
        if global_skills_dir and global_skills_dir.is_dir():
            search_dirs.append(global_skills_dir)

        seen_names = set()
        for sdir in search_dirs:
            for skill_md in sdir.rglob("SKILL.md"):
                name = skill_md.parent.name
                if name in seen_names or name.startswith("."):
                    continue
                seen_names.add(name)

                # 轻量读取 frontmatter 提取描述
                description = ""
                category = ""
                tags = []
                try:
                    content = skill_md.read_text(encoding="utf-8")[:4096]
                    # 解析 YAML frontmatter
                    fm_match = _re.match(r"^---\s*\n(.*?)\n---", content, _re.DOTALL)
                    if fm_match:
                        fm_text = fm_match.group(1)
                        # 简单提取 description
                        desc_m = _re.search(r"^description:\s*(.+)", fm_text, _re.MULTILINE)
                        if desc_m:
                            description = desc_m.group(1).strip().strip("'\"")
                    # 若没 frontmatter 描述，取第一行非空行作为描述
                    if not description:
                        for line in content.split("\n"):
                            line = line.strip()
                            if line and not line.startswith(("#", "---", "```")):
                                description = line[:120]
                                break
                except Exception:
                    pass

                # category = 父目录的父目录名（如 software-development/plan → software-development）
                try:
                    rel = skill_md.relative_to(sdir)
                    parts = rel.parts
                    category = parts[0] if len(parts) > 2 else ""
                except Exception:
                    pass

                details.append({
                    "name": name,
                    "description": description,
                    "category": category,
                    "tags": tags,
                })

    except Exception:
        pass
    return details


# ── 注册 ──────────────────────────────────────────────────────────────────────

def _do_register() -> bool:
    """执行一次注册。"""
    global _registered

    from api.config import HOST, PORT, DEFAULT_WORKSPACE, DEFAULT_MODEL

    agent_id = _get_agent_id()
    local_ip = _get_local_ip()
    own_url = f"http://{local_ip}:{PORT}"

    skills_detail = _get_skills_detail()
    skill_names = [s["name"] for s in skills_detail] if skills_detail else _get_skills()

    reg_data = {
        "agent_id": agent_id,
        "name": _get_agent_name(),
        "url": own_url,
        "token": os.getenv("HERMES_WEBUI_PASSWORD", ""),
        "workspace": str(DEFAULT_WORKSPACE),
        "model": DEFAULT_MODEL,
        "skills": skill_names,
        "skills_detail": skills_detail,
        "status": "idle",
        "metadata": {
            "host": HOST,
            "port": PORT,
            "pid": os.getpid(),
            "platform": os.name,
        },
    }

    result = _http_request("/register", method="POST", data=reg_data)
    if result and result.get("ok"):
        _registered = True
        print(f"[mcp-client] Registered to Gateway as '{agent_id}'", flush=True)
        return True
    else:
        err = result.get("_message", "connection failed") if result else "unreachable"
        print(f"[mcp-client] Registration failed: {err}", flush=True)
        return False


# ── 心跳 ──────────────────────────────────────────────────────────────────────

def _heartbeat_loop():
    """心跳线程：每 HEARTBEAT_INTERVAL 秒向 Gateway 报告存活。"""
    agent_id = _get_agent_id()

    while not _stop_event.is_set():
        _stop_event.wait(HEARTBEAT_INTERVAL)
        if _stop_event.is_set():
            break

        # 检查当前状态（是否有活跃流）
        try:
            from api.config import STREAMS
            status = "busy" if len(STREAMS) > 0 else "idle"
        except Exception:
            status = "idle"

        # 每次心跳也刷新技能信息（支持动态安装技能后自动发现）
        skills_detail = _get_skills_detail()
        skill_names = [s["name"] for s in skills_detail] if skills_detail else _get_skills()

        data = {
            "agent_id": agent_id,
            "status": status,
            "extra": {
                "skills": skill_names,
                "skills_detail": skills_detail,
            },
        }
        result = _http_request("/heartbeat", method="POST", data=data)
        if result is None:
            print("[mcp-client] Heartbeat failed (gateway unreachable)", flush=True)


# ── 任务 Worker ──────────────────────────────────────────────────────────────

def _worker_loop():
    """Worker 线程：定期拉取并执行委派任务。"""
    agent_id = _get_agent_id()

    while not _stop_event.is_set():
        _stop_event.wait(POLL_INTERVAL)
        if _stop_event.is_set():
            break

        try:
            _poll_and_execute(agent_id)
        except Exception as e:
            print(f"[mcp-worker] Error: {e}\n{traceback.format_exc()}", flush=True)
            time.sleep(5)


def _poll_and_execute(agent_id: str):
    """拉取一个任务并执行。"""
    result = _http_request(f"/tasks/poll?agent_id={agent_id}", method="GET")
    if not result or not result.get("task"):
        return  # 无任务

    task = result["task"]
    task_id = task["task_id"]
    message = task.get("message", "")
    skill = task.get("skill", "")

    print(f"[mcp-worker] Received task {task_id}: {message[:80]}...", flush=True)

    # 上报 running 状态
    _http_request("/tasks/update", method="POST", data={
        "task_id": task_id,
        "status": "running",
    })

    # 执行任务
    try:
        response = _execute_task(message, skill, task.get("timeout_seconds", 300))
        # 上报结果
        _http_request("/tasks/result", method="POST", data={
            "task_id": task_id,
            "status": "completed",
            "result": response,
            "session_id": "",
        })
        print(f"[mcp-worker] Task {task_id} completed.", flush=True)
    except Exception as e:
        _http_request("/tasks/result", method="POST", data={
            "task_id": task_id,
            "status": "failed",
            "error": str(e),
        })
        print(f"[mcp-worker] Task {task_id} failed: {e}", flush=True)


def _execute_task(message: str, skill: str, timeout: int) -> str:
    """使用本地 Hermes Agent 执行任务。

    这里复用 WebUI 现有的 agent 调用逻辑。
    """
    # 构造 prompt
    prompt = message
    if skill:
        prompt = f"/skill {skill}\n{message}"

    # 使用 Hermes Agent 的 chat() 接口
    try:
        from api.config import (
            HERMES_DIR, _HERMES_FOUND, DEFAULT_MODEL, DEFAULT_WORKSPACE,
            get_setting
        )

        if not _HERMES_FOUND:
            return "[Error] Hermes agent not found on this machine."

        from run_agent import AIAgent

        # 获取模型配置
        model = DEFAULT_MODEL
        provider_settings = get_setting("provider", {})

        agent = AIAgent(
            model=model,
            base_url=provider_settings.get("base_url"),
            api_key=provider_settings.get("api_key"),
            provider=provider_settings.get("provider"),
            max_iterations=30,
            quiet_mode=True,
            platform="mcp_worker",
        )

        # 设置工作目录
        if hasattr(agent, 'working_directory'):
            agent.working_directory = str(DEFAULT_WORKSPACE)

        result = agent.chat(prompt)
        return result if result else "[No response from agent]"

    except ImportError as e:
        return f"[Error] Cannot import Hermes agent: {e}"
    except Exception as e:
        return f"[Error] Agent execution failed: {e}"


# ── 公共接口 ──────────────────────────────────────────────────────────────────

def init_gateway_client():
    """初始化 Gateway 客户端（在 WebUI server.py 启动后调用）。

    如果 HERMES_MCP_GATEWAY 环境变量未设置则静默 no-op。
    """
    global _worker_thread, _heartbeat_thread

    if not MCP_GATEWAY_URL:
        return  # 未配置 Gateway，静默跳过

    print(f"[mcp-client] Gateway: {MCP_GATEWAY_URL}", flush=True)
    print(f"[mcp-client] Agent ID: {_get_agent_id()}", flush=True)

    # 注册（带重试）
    def _register_with_retry():
        while not _stop_event.is_set():
            if _do_register():
                break
            _stop_event.wait(REGISTER_RETRY)

    reg_thread = threading.Thread(target=_register_with_retry, daemon=True)
    reg_thread.start()

    # 启动心跳线程
    _heartbeat_thread = threading.Thread(target=_heartbeat_loop, daemon=True, name="mcp-heartbeat")
    _heartbeat_thread.start()

    # 启动 Worker 线程
    _worker_thread = threading.Thread(target=_worker_loop, daemon=True, name="mcp-worker")
    _worker_thread.start()

    print("[mcp-client] Worker started (polling for tasks).", flush=True)


def shutdown_gateway_client():
    """停止 Gateway 客户端（WebUI 关闭时调用）。"""
    global _registered

    _stop_event.set()

    if MCP_GATEWAY_URL and _registered:
        # 注销
        _http_request("/unregister", method="POST", data={
            "agent_id": _get_agent_id(),
        })
        print("[mcp-client] Unregistered from Gateway.", flush=True)
        _registered = False
