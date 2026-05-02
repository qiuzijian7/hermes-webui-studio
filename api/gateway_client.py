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
from pathlib import Path
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

def _load_hermes_env() -> None:
    """将 Hermes ~/.hermes/.env（或当前 profile 的 .env）中的 API Key 加载到 os.environ。

    WebUI server 的 Python 进程不会自动继承 start.bat 设置的环境变量，
    此函数确保 _execute_task() 创建 AIAgent 时能读到正确的 API Key。

    只会执行一次（结果缓存到 _hermes_env_loaded）。
    """
    global _hermes_env_loaded
    if _hermes_env_loaded:
        return
    _hermes_env_loaded = True

    # 定位 .env 文件路径
    try:
        from api.profiles import get_active_hermes_home
        env_path = get_active_hermes_home() / ".env"
    except Exception:
        env_path = Path.home() / ".hermes" / ".env"

    if not env_path.exists():
        return

    loaded = 0
    try:
        for raw_line in env_path.read_text(encoding="utf-8").splitlines():
            line = raw_line.strip()
            if not line or line.startswith("#"):
                continue
            # 兼容 bash 格式：export KEY=value
            if line.startswith("export "):
                line = line[len("export "):].strip()
            if "=" not in line:
                continue
            key, val = line.split("=", 1)
            key = key.strip()
            val = val.strip().strip('"').strip("'")
            if key and key not in os.environ:  # 不覆盖已设置的环境变量
                os.environ[key] = val
                loaded += 1
    except Exception as e:
        print(f"[mcp-worker] Warning: failed to load .env: {e}", flush=True)

    if loaded:
        print(f"[mcp-worker] Loaded {loaded} env vars from {env_path}", flush=True)


_hermes_env_loaded = False


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
    """获取实例显示名。

    默认格式：{用户名}@{电脑名}（与 agent_id 格式一致，便于识别）
    可通过 HERMES_AGENT_NAME 环境变量覆盖。
    """
    override = os.getenv("HERMES_AGENT_NAME", "").strip()
    if override:
        return override
    user = os.getenv("USER") or os.getenv("USERNAME") or "user"
    host = socket.gethostname()
    return f"{user}@{host}"


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
    # 提取触发该任务的员工 session_id（兼容多种字段名）
    session_id = (
        task.get("_hermes_session_id")
        or task.get("session_id")
        or task.get("sessionId")
        or ""
    )

    print(f"[mcp-worker] Received task {task_id}: {message[:80]}... session_id={session_id!r}", flush=True)

    # 上报 running 状态
    _http_request("/tasks/update", method="POST", data={
        "task_id": task_id,
        "status": "running",
    })

    # 执行任务
    try:
        response = _execute_task(message, skill, task.get("timeout_seconds", 300), session_id)
        # 上报结果
        _http_request("/tasks/result", method="POST", data={
            "task_id": task_id,
            "status": "completed",
            "result": response,
            "session_id": session_id,
        })
        print(f"[mcp-worker] Task {task_id} completed.", flush=True)
    except Exception as e:
        _http_request("/tasks/result", method="POST", data={
            "task_id": task_id,
            "status": "failed",
            "error": str(e),
            "session_id": session_id,
        })
        print(f"[mcp-worker] Task {task_id} failed: {e}", flush=True)


def _resolve_task_model(session_id: str = "") -> str:
    """根据触发任务的员工 session，返回该员工配置的模型。

    优先级：
      1. session_id 能匹配到某员工 → 该员工的 model
      2. 环境变量 HERMES_MCP_GATEWAY_EMPLOYEE 指定的员工 → 该员工的 model
      3. 兜底返回 DEFAULT_MODEL

    核心逻辑：通过员工 X 发送的消息，使用员工 X 的模型。
    """
    from api.config import DEFAULT_MODEL
    import json

    # ── 1. 通过 session_id 查找对应的员工 ──────────────────────────────
    if session_id:
        from api.workspace_manager import WORKSPACES_DIR as _WSD
        for ws_dir in sorted(_WSD.iterdir()):
            if not ws_dir.is_dir() or ws_dir.name.startswith("_"):
                continue
            emp_root = ws_dir / "employee_ins"
            if not emp_root.is_dir():
                continue
            for emp_dir in sorted(emp_root.iterdir()):
                if not emp_dir.is_dir() or emp_dir.name.startswith("_"):
                    continue
                emp_info_path = emp_dir / "info.json"
                if not emp_info_path.exists():
                    continue
                try:
                    emp_info = json.loads(emp_info_path.read_text(encoding="utf-8"))
                    emp_session = emp_info.get("sessionId") or emp_info.get("session_id") or ""
                    if emp_session == session_id:
                        model = emp_info.get("model", "")
                        if model:
                            print(f"[mcp-worker] Resolved model from session {session_id[-8:]}: {model}", flush=True)
                            return model
                except Exception:
                    continue

    # ── 2. 环境变量指定了员工名/ID ─────────────────────────────────────
    import os
    target_emp = os.getenv("HERMES_MCP_GATEWAY_EMPLOYEE", "").strip()
    if target_emp:
        from api.workspace_manager import WORKSPACES_DIR as _WSD
        for ws_dir in sorted(_WSD.iterdir()):
            if not ws_dir.is_dir() or ws_dir.name.startswith("_"):
                continue
            emp_root = ws_dir / "employee_ins"
            if not emp_root.is_dir():
                continue
            for emp_dir in sorted(emp_root.iterdir()):
                if not emp_dir.is_dir() or emp_dir.name.startswith("_"):
                    continue
                emp_info_path = emp_dir / "info.json"
                if not emp_info_path.exists():
                    continue
                try:
                    emp_info = json.loads(emp_info_path.read_text(encoding="utf-8"))
                    if emp_info.get("name") == target_emp or emp_info.get("id") == target_emp:
                        model = emp_info.get("model", "")
                        if model:
                            return model
                except Exception:
                    continue

    # ── 3. 兜底 ─────────────────────────────────────────────────────────
    print(f"[mcp-worker] Cannot resolve employee from session_id={session_id!r}, using DEFAULT_MODEL", flush=True)
    return DEFAULT_MODEL


def _execute_task(message: str, skill: str, timeout: int, session_id: str = "") -> str:
    """使用 Knot AG-UI 或本地 Hermes Agent 执行任务。

    如果 settings 中配置了 knot_agui_mcp_model，
    则通过 Knot AG-UI API 执行（同步调用，不启动 AIAgent）。
    """
    # ── 优先使用 Knot AG-UI（如已在 settings 中配置）────────────
    try:
        from api.config import load_settings
        _settings = load_settings()
        _knot_model = _settings.get("knot_agui_mcp_model", "").strip()
    except Exception:
        _knot_model = ""

    if _knot_model:
        try:
            from api.knot_agui import run_knot_agui_sync
            print(f"[mcp-worker] Using Knot AG-UI: model={_knot_model}", flush=True)
            result = run_knot_agui_sync(message, model_name=_knot_model)
            if result.startswith("[Error]"):
                print(f"[mcp-worker] Knot AG-UI error: {result}", flush=True)
                return result  # 不 fallback，直接返回错误
            return result
        except Exception as _e:
            print(f"[mcp-worker] Knot AG-UI exception: {_e}", flush=True)
            return f"[Error] Knot AG-UI call failed: {_e}"

    # ── 兜底：使用本地 Hermes Agent ─────────────────────────────
    # 加载 Hermes .env 中的 API Key（如果尚未加载）
    _load_hermes_env()

    import sys
    from pathlib import Path

    # 确保项目根目录在 sys.path 中（run_agent.py 在 hermes-agent-studio/ 根目录）
    project_root = Path(__file__).parent.parent.parent  # api/ → hermes-webui-studio/ → hermes-agent-studio/
    if str(project_root) not in sys.path:
        sys.path.insert(0, str(project_root))

    # 构造 prompt
    prompt = message
    if skill:
        prompt = f"/skill {skill}\n{message}"

    # 使用 Hermes Agent 的 chat() 接口
    try:
        from api.config import (
            _HERMES_FOUND, DEFAULT_MODEL, DEFAULT_WORKSPACE,
            cfg
        )

        if not _HERMES_FOUND:
            return "[Error] Hermes agent not found on this machine."

        from run_agent import AIAgent

        # 解析模型：使用触发任务的员工对应的模型
        import os
        raw_model = _resolve_task_model(session_id)
        model = raw_model
        provider = ""
        base_url = ""

        # raw_model 格式通常为 "provider/model-name"（如 "openai/gpt-5.4-mini"）
        if "/" in model:
            parts = model.split("/", 1)
            provider = parts[0]
            model = parts[1]  # 传给 AIAgent 的 model 不含 provider 前缀

        # 从 cfg 中解析 base_url
        providers_cfg = cfg.get("providers", {})
        if isinstance(providers_cfg, dict) and provider:
            p_cfg = providers_cfg.get(provider, {})
            if isinstance(p_cfg, dict):
                base_url = p_cfg.get("base_url", base_url)

        # 检查 custom_providers 段
        if not base_url and provider and provider.startswith("custom:"):
            cp_name = provider.replace("custom:", "")
            for cp in cfg.get("custom_providers", []):
                if cp.get("name") == cp_name:
                    base_url = cp.get("base_url", "")
                    break

        # 如果 model 不含 provider 前缀，尝试从字符串判断
        if not provider:
            if "claude" in model.lower():
                provider = "anthropic"
            elif "gpt" in model.lower() or "o1" in model.lower() or "o3" in model.lower():
                provider = "openai"
            elif "openrouter" in model.lower():
                provider = "openrouter"

        print(f"[mcp-worker] Using model: {raw_model} → provider={provider}, base_url={base_url}", flush=True)

        # 根据 provider 获取对应的 API key
        api_key = ""
        if provider == "anthropic":
            api_key = os.getenv("ANTHROPIC_API_KEY", "")
        elif provider == "openai":
            api_key = os.getenv("OPENAI_API_KEY", "")
        elif provider == "openrouter":
            api_key = os.getenv("OPENROUTER_API_KEY", "")
        elif provider and provider.startswith("custom:"):
            # custom provider，从 cfg 中获取
            cp_name = provider.replace("custom:", "")
            for cp in cfg.get("custom_providers", []):
                if cp.get("name") == cp_name:
                    api_key = cp.get("api_key", "")
                    if not base_url:
                        base_url = cp.get("base_url", "")
                    break
        else:
            # 尝试从 cfg 的 model 段获取
            model_cfg = cfg.get("model", {})
            if isinstance(model_cfg, dict):
                api_key = model_cfg.get("api_key", "")

        print(f"[mcp-worker] API key present: {bool(api_key)}", flush=True)

        agent = AIAgent(
            model=model,
            base_url=base_url,
            api_key=api_key,
            provider=provider,
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
