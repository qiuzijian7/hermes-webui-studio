#!/bin/bash
# ============================================================================
# Hermes MCP Gateway — CentOS/TencentOS 一键部署脚本
# 
# 用法：
#   1. SSH 到服务器: ssh -p 36000 root@21.91.41.66
#   2. 创建此文件并执行: bash deploy-cvm.sh
#
# 服务端口：
#   - HTTP API: 8080 (WebUI 实例注册/心跳/任务)
#   - MCP SSE:  8081 (Knot 智能体通过 MCP 协议调用)
# ============================================================================

set -e

echo "============================================"
echo " Hermes MCP Gateway — CentOS/TencentOS 部署"
echo "============================================"

# ── 配置变量 ──
DEPLOY_DIR="/opt/hermes-mcp-gateway"
DATA_DIR="/data/hermes-gateway"
GATEWAY_PORT=8080
MCP_PORT=8081
PYTHON_MIN_VERSION="3.10"

# ── 1. 系统依赖 ──
echo ""
echo "[1/6] 安装系统依赖..."
if command -v dnf &>/dev/null; then
    dnf install -y python3 python3-pip python3-devel firewalld 2>/dev/null || true
elif command -v yum &>/dev/null; then
    yum install -y python3 python3-pip python3-devel firewalld 2>/dev/null || true
fi

# 检查 Python 版本
PYTHON_CMD=""
for cmd in python3.12 python3.11 python3.10 python3; do
    if command -v "$cmd" &>/dev/null; then
        ver=$("$cmd" --version 2>&1 | grep -oP '\d+\.\d+')
        major=$(echo "$ver" | cut -d. -f1)
        minor=$(echo "$ver" | cut -d. -f2)
        if [ "$major" -ge 3 ] && [ "$minor" -ge 10 ]; then
            PYTHON_CMD="$cmd"
            break
        fi
    fi
done

if [ -z "$PYTHON_CMD" ]; then
    echo "[ERROR] 需要 Python >= 3.10。当前系统没有合适版本。"
    echo "  请手动安装: dnf install python3.11 (TencentOS 4)"
    exit 1
fi
echo "  Python: $PYTHON_CMD ($($PYTHON_CMD --version))"

# ── 2. 创建部署目录 ──
echo ""
echo "[2/6] 创建部署目录..."
mkdir -p "$DEPLOY_DIR"
mkdir -p "$DATA_DIR"

# ── 3. 部署代码 ──
echo ""
echo "[3/6] 部署 MCP Gateway 代码..."

# 创建 __init__.py
cat > "$DEPLOY_DIR/__init__.py" << 'PYEOF'
"""Hermes MCP Gateway package."""
PYEOF

# 创建 registry.py
cat > "$DEPLOY_DIR/registry.py" << 'PYEOF'
"""实例注册表 — 管理多个 Hermes WebUI 实例的注册、心跳和发现。"""
from __future__ import annotations

import json
import threading
import time
from pathlib import Path
from typing import Any

DEFAULT_REGISTRY_FILE = Path("/data/hermes-gateway/registry.json")
HEARTBEAT_TIMEOUT = 90
PRUNE_INTERVAL = 30


class InstanceRegistry:
    """线程安全的实例注册表。"""

    def __init__(self, storage_path: Path | str | None = None):
        self._path = Path(storage_path) if storage_path else DEFAULT_REGISTRY_FILE
        self._lock = threading.Lock()
        self._data: dict[str, dict[str, Any]] = {}
        self._load()

    def _load(self) -> None:
        if self._path.exists():
            try:
                raw = self._path.read_text(encoding="utf-8")
                data = json.loads(raw)
                self._data = data.get("instances", {})
            except (json.JSONDecodeError, OSError):
                self._data = {}
        else:
            self._data = {}

    def _save(self) -> None:
        self._path.parent.mkdir(parents=True, exist_ok=True)
        payload = {"instances": self._data, "updated_at": time.time()}
        self._path.write_text(
            json.dumps(payload, ensure_ascii=False, indent=2),
            encoding="utf-8",
        )

    def register(self, agent_id: str, info: dict[str, Any]) -> dict:
        with self._lock:
            now = time.time()
            existing = self._data.get(agent_id, {})
            entry = {
                "agent_id": agent_id,
                "name": info.get("name", agent_id),
                "url": info.get("url", ""),
                "token": info.get("token", ""),
                "workspace": info.get("workspace", ""),
                "model": info.get("model", ""),
                "skills": info.get("skills", []),
                "skills_detail": info.get("skills_detail", []),
                "status": info.get("status", "idle"),
                "last_heartbeat": now,
                "registered_at": existing.get("registered_at", now),
                "metadata": info.get("metadata", {}),
            }
            self._data[agent_id] = entry
            self._save()
            return entry

    def heartbeat(self, agent_id: str, status: str = "idle",
                  extra: dict | None = None) -> bool:
        with self._lock:
            if agent_id not in self._data:
                return False
            self._data[agent_id]["last_heartbeat"] = time.time()
            self._data[agent_id]["status"] = status
            if extra:
                self._data[agent_id].update(extra)
            self._save()
            return True

    def unregister(self, agent_id: str) -> bool:
        with self._lock:
            if agent_id in self._data:
                del self._data[agent_id]
                self._save()
                return True
            return False

    def get(self, agent_id: str) -> dict | None:
        with self._lock:
            self._prune_stale()
            return self._data.get(agent_id)

    def list_all(self, include_offline: bool = False) -> list[dict]:
        with self._lock:
            if not include_offline:
                self._prune_stale()
            return list(self._data.values())

    def select(self, skill: str = "", prefer_idle: bool = True) -> str | None:
        with self._lock:
            self._prune_stale()
            if not self._data:
                return None
            candidates = list(self._data.values())
            if skill:
                skill_lower = skill.lower()
                with_skill = [c for c in candidates
                              if any(skill_lower in s.lower() for s in c.get("skills", []))]
                if with_skill:
                    candidates = with_skill
            if prefer_idle:
                idle = [c for c in candidates if c.get("status") == "idle"]
                if idle:
                    candidates = idle
            candidates.sort(key=lambda x: x.get("last_heartbeat", 0), reverse=True)
            return candidates[0]["agent_id"] if candidates else None

    def _prune_stale(self) -> None:
        now = time.time()
        stale = [
            aid for aid, info in self._data.items()
            if now - info.get("last_heartbeat", 0) > HEARTBEAT_TIMEOUT
        ]
        for aid in stale:
            del self._data[aid]
        if stale:
            self._save()
PYEOF

# 创建 task_queue.py
cat > "$DEPLOY_DIR/task_queue.py" << 'PYEOF'
"""任务队列 — Pull 模式任务分发。"""
from __future__ import annotations

import json
import threading
import time
import uuid
from dataclasses import dataclass, field, asdict
from enum import Enum
from pathlib import Path
from typing import Any


class TaskStatus(str, Enum):
    PENDING = "pending"
    ASSIGNED = "assigned"
    RUNNING = "running"
    COMPLETED = "completed"
    FAILED = "failed"
    TIMEOUT = "timeout"
    CANCELLED = "cancelled"


@dataclass
class Task:
    task_id: str = field(default_factory=lambda: uuid.uuid4().hex[:12])
    message: str = ""
    skill: str = ""
    assigned_to: str = ""
    status: TaskStatus = TaskStatus.PENDING
    result: str = ""
    error: str = ""
    created_at: float = field(default_factory=time.time)
    assigned_at: float = 0.0
    completed_at: float = 0.0
    timeout_seconds: int = 300
    session_id: str = ""
    metadata: dict = field(default_factory=dict)

    def to_dict(self) -> dict:
        d = asdict(self)
        d["status"] = self.status.value
        return d

    @classmethod
    def from_dict(cls, d: dict) -> "Task":
        d = d.copy()
        if "status" in d:
            d["status"] = TaskStatus(d["status"])
        return cls(**{k: v for k, v in d.items() if k in cls.__dataclass_fields__})


class TaskQueue:
    def __init__(self, storage_path: Path | str | None = None):
        self._path = Path(storage_path) if storage_path else Path("/data/hermes-gateway/tasks.json")
        self._lock = threading.Lock()
        self._tasks: dict[str, Task] = {}
        self._waiters: dict[str, threading.Event] = {}
        self._load()

    def _load(self) -> None:
        if self._path.exists():
            try:
                raw = json.loads(self._path.read_text(encoding="utf-8"))
                for tid, td in raw.get("tasks", {}).items():
                    self._tasks[tid] = Task.from_dict(td)
            except (json.JSONDecodeError, OSError):
                pass

    def _save(self) -> None:
        self._path.parent.mkdir(parents=True, exist_ok=True)
        payload = {
            "tasks": {tid: t.to_dict() for tid, t in self._tasks.items()},
            "updated_at": time.time(),
        }
        self._path.write_text(
            json.dumps(payload, ensure_ascii=False, indent=2),
            encoding="utf-8",
        )

    def submit(self, message: str, skill: str = "", assigned_to: str = "",
               timeout_seconds: int = 300, metadata: dict | None = None) -> Task:
        task = Task(
            message=message, skill=skill, assigned_to=assigned_to,
            timeout_seconds=timeout_seconds, metadata=metadata or {},
        )
        with self._lock:
            self._tasks[task.task_id] = task
            self._waiters[task.task_id] = threading.Event()
            self._save()
        return task

    def wait_for_result(self, task_id: str, timeout: float = 300) -> Task | None:
        event = self._waiters.get(task_id)
        if not event:
            with self._lock:
                return self._tasks.get(task_id)
        completed = event.wait(timeout=timeout)
        with self._lock:
            task = self._tasks.get(task_id)
            if task and not completed:
                task.status = TaskStatus.TIMEOUT
                task.error = f"Task timed out after {timeout}s"
                self._save()
            self._waiters.pop(task_id, None)
            return task

    def poll(self, agent_id: str) -> Task | None:
        with self._lock:
            now = time.time()
            for task in sorted(self._tasks.values(), key=lambda t: t.created_at):
                if task.status != TaskStatus.PENDING:
                    continue
                if now - task.created_at > task.timeout_seconds:
                    task.status = TaskStatus.TIMEOUT
                    task.error = "Expired before assignment"
                    continue
                if task.assigned_to and task.assigned_to != agent_id:
                    continue
                task.status = TaskStatus.ASSIGNED
                task.assigned_to = agent_id
                task.assigned_at = now
                self._save()
                return task
            return None

    def update_status(self, task_id: str, status: TaskStatus,
                      result: str = "", error: str = "",
                      session_id: str = "") -> bool:
        with self._lock:
            task = self._tasks.get(task_id)
            if not task:
                return False
            task.status = status
            if result:
                task.result = result
            if error:
                task.error = error
            if session_id:
                task.session_id = session_id
            if status in (TaskStatus.COMPLETED, TaskStatus.FAILED, TaskStatus.TIMEOUT):
                task.completed_at = time.time()
            self._save()
        if status in (TaskStatus.COMPLETED, TaskStatus.FAILED, TaskStatus.TIMEOUT):
            event = self._waiters.get(task_id)
            if event:
                event.set()
        return True

    def get(self, task_id: str) -> Task | None:
        with self._lock:
            return self._tasks.get(task_id)

    def list_tasks(self, agent_id: str = "", status: str = "", limit: int = 50) -> list[dict]:
        with self._lock:
            tasks = list(self._tasks.values())
        if agent_id:
            tasks = [t for t in tasks if t.assigned_to == agent_id]
        if status:
            tasks = [t for t in tasks if t.status.value == status]
        tasks.sort(key=lambda t: t.created_at, reverse=True)
        return [t.to_dict() for t in tasks[:limit]]

    def cleanup(self, max_age: int = 3600) -> int:
        with self._lock:
            now = time.time()
            stale = [
                tid for tid, t in self._tasks.items()
                if t.status in (TaskStatus.COMPLETED, TaskStatus.FAILED,
                                TaskStatus.TIMEOUT, TaskStatus.CANCELLED)
                and now - t.completed_at > max_age
            ]
            for tid in stale:
                del self._tasks[tid]
                self._waiters.pop(tid, None)
            if stale:
                self._save()
            return len(stale)
PYEOF

# 创建 server.py (主服务)
cat > "$DEPLOY_DIR/server.py" << 'PYEOF'
"""Hermes MCP Gateway — FastMCP Server + HTTP API。"""
from __future__ import annotations

import json
import os
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse

# 添加部署目录到 path
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from registry import InstanceRegistry
from task_queue import TaskQueue, TaskStatus

GATEWAY_HOST = os.getenv("HERMES_GATEWAY_HOST", "0.0.0.0")
GATEWAY_PORT = int(os.getenv("HERMES_GATEWAY_PORT", "8080"))
GATEWAY_DATA = Path(os.getenv("HERMES_GATEWAY_DATA", "/data/hermes-gateway"))
GATEWAY_TOKEN = os.getenv("HERMES_GATEWAY_TOKEN", "")

registry = InstanceRegistry(GATEWAY_DATA / "registry.json")
task_queue = TaskQueue(GATEWAY_DATA / "tasks.json")

_cleanup_thread = None

def _cleanup_loop():
    while True:
        time.sleep(60)
        try:
            task_queue.cleanup(max_age=3600)
        except Exception:
            pass


# ── MCP 工具 ──

def mcp_list_agents() -> dict:
    """列出所有在线的 Hermes Agent 实例及其状态和技能。"""
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
    """委派任务给 Hermes Agent 执行。"""
    timeout = min(max(timeout, 30), 600)
    target = assigned_to
    if not target:
        target = registry.select(skill=skill)
    if not target:
        return {"status": "error", "error": "No online Hermes agent available."}
    inst = registry.get(target)
    if not inst:
        return {"status": "error", "error": f"Agent '{target}' not found or offline."}
    t = task_queue.submit(
        message=task, skill=skill, assigned_to=target,
        timeout_seconds=timeout, metadata={"target_name": inst.get("name", target)},
    )
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
    """列出指定 Agent 可用的技能列表。"""
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
    """查询任务执行状态。"""
    task = task_queue.get(task_id)
    if not task:
        return {"error": f"Task '{task_id}' not found."}
    return task.to_dict()


def mcp_execute_skill(skill: str, task: str, agent_id: str = "",
                      timeout: int = 300) -> dict:
    """直接执行指定技能。"""
    if not skill.strip():
        return {"status": "error", "error": "skill parameter is required."}
    if not task.strip():
        return {"status": "error", "error": "task parameter is required."}
    result = mcp_delegate_task(task=task, skill=skill.strip(),
                               assigned_to=agent_id, timeout=min(max(timeout, 30), 600))
    result["skill"] = skill.strip()
    return result


# ── HTTP Handler ──

class GatewayHandler(BaseHTTPRequestHandler):
    server_version = "HermesMCPGateway/0.1"

    def log_message(self, fmt, *args):
        print(f"[gateway] {self.command} {self.path} {args[0] if args else ''}", flush=True)

    def _read_body(self) -> dict:
        length = int(self.headers.get("Content-Length", 0))
        if length == 0:
            return {}
        raw = self.rfile.read(length)
        try:
            return json.loads(raw)
        except (json.JSONDecodeError, UnicodeDecodeError):
            return {}

    def _json_response(self, data: dict, status: int = 200):
        body = json.dumps(data, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Access-Control-Allow-Origin", "*")
        self.end_headers()
        self.wfile.write(body)

    def _check_token(self) -> bool:
        if not GATEWAY_TOKEN:
            return True
        auth = self.headers.get("Authorization", "")
        if auth == f"Bearer {GATEWAY_TOKEN}":
            return True
        self._json_response({"error": "Unauthorized"}, 401)
        return False

    def do_OPTIONS(self):
        self.send_response(204)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type, Authorization")
        self.end_headers()

    def do_GET(self):
        parsed = urlparse(self.path)
        qs = parse_qs(parsed.query)

        if parsed.path == "/health":
            instances = registry.list_all()
            return self._json_response({
                "status": "ok", "online_agents": len(instances), "uptime": "running",
            })
        if parsed.path == "/agents":
            if not self._check_token():
                return
            instances = registry.list_all(include_offline="all" in qs)
            return self._json_response({"instances": instances})
        if parsed.path == "/tasks/poll":
            if not self._check_token():
                return
            agent_id = qs.get("agent_id", [""])[0]
            if not agent_id:
                return self._json_response({"error": "agent_id required"}, 400)
            task = task_queue.poll(agent_id)
            if task:
                return self._json_response({"task": task.to_dict()})
            else:
                return self._json_response({"task": None})
        if parsed.path == "/tasks/status":
            task_id = qs.get("task_id", [""])[0]
            if not task_id:
                return self._json_response({"error": "task_id required"}, 400)
            task = task_queue.get(task_id)
            if task:
                return self._json_response({"task": task.to_dict()})
            return self._json_response({"error": "not found"}, 404)
        self._json_response({"error": "not found"}, 404)

    def do_POST(self):
        parsed = urlparse(self.path)
        if not self._check_token():
            return
        body = self._read_body()

        if parsed.path == "/register":
            agent_id = body.get("agent_id", "").strip()
            if not agent_id:
                return self._json_response({"error": "agent_id required"}, 400)
            entry = registry.register(agent_id, body)
            print(f"[gateway] Registered: {agent_id} ({body.get('name', '')})", flush=True)
            return self._json_response({"ok": True, "agent_id": agent_id, "entry": entry})
        if parsed.path == "/heartbeat":
            agent_id = body.get("agent_id", "").strip()
            if not agent_id:
                return self._json_response({"error": "agent_id required"}, 400)
            status = body.get("status", "idle")
            ok = registry.heartbeat(agent_id, status, extra=body.get("extra"))
            if not ok:
                registry.register(agent_id, body)
            return self._json_response({"ok": True})
        if parsed.path == "/unregister":
            agent_id = body.get("agent_id", "").strip()
            if agent_id:
                registry.unregister(agent_id)
            return self._json_response({"ok": True})
        if parsed.path == "/tasks/result":
            task_id = body.get("task_id", "").strip()
            if not task_id:
                return self._json_response({"error": "task_id required"}, 400)
            status_str = body.get("status", "completed")
            try:
                task_status = TaskStatus(status_str)
            except ValueError:
                task_status = TaskStatus.COMPLETED
            ok = task_queue.update_status(
                task_id=task_id, status=task_status,
                result=body.get("result", ""), error=body.get("error", ""),
                session_id=body.get("session_id", ""),
            )
            return self._json_response({"ok": ok})
        if parsed.path == "/tasks/update":
            task_id = body.get("task_id", "").strip()
            if not task_id:
                return self._json_response({"error": "task_id required"}, 400)
            try:
                task_status = TaskStatus(body.get("status", "running"))
            except ValueError:
                task_status = TaskStatus.RUNNING
            ok = task_queue.update_status(
                task_id=task_id, status=task_status,
                session_id=body.get("session_id", ""),
            )
            return self._json_response({"ok": ok})
        self._json_response({"error": "not found"}, 404)


# ── 启动 ──

def run_gateway_http():
    global _cleanup_thread
    GATEWAY_DATA.mkdir(parents=True, exist_ok=True)
    _cleanup_thread = threading.Thread(target=_cleanup_loop, daemon=True)
    _cleanup_thread.start()
    httpd = ThreadingHTTPServer((GATEWAY_HOST, GATEWAY_PORT), GatewayHandler)
    print(f"[gateway] HTTP API on http://{GATEWAY_HOST}:{GATEWAY_PORT}", flush=True)
    print(f"[gateway] Data: {GATEWAY_DATA}", flush=True)
    print(f"[gateway] Token: {'enabled' if GATEWAY_TOKEN else 'disabled'}", flush=True)
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print("\n[gateway] Shutting down...", flush=True)
        httpd.shutdown()


def run_gateway_mcp():
    try:
        from fastmcp import FastMCP
    except ImportError:
        print("[gateway] ERROR: fastmcp not installed. Run: pip install fastmcp", flush=True)
        return

    mcp = FastMCP("hermes-team", instructions="""
Hermes Team MCP Gateway — 连接多个 Hermes Agent 实例的协调网关。
通过 MCP 协议发现在线 Agent 的技能，并委派任务执行。

使用流程:
1. list_skills() — 发现可用技能
2. execute_skill(skill, task) — 执行技能
3. list_agents() — 查看在线实例（多实例场景）
""")

    mcp.tool(name="list_agents", description="列出所有在线 Hermes Agent 实例及其状态和技能")(mcp_list_agents)
    mcp.tool(name="list_skills", description="列出可用技能（含描述/分类）")(mcp_list_skills)
    mcp.tool(name="execute_skill", description="执行指定技能（推荐入口）")(mcp_execute_skill)
    mcp.tool(name="delegate_task", description="委派任务给 Agent 执行（高级接口）")(mcp_delegate_task)
    mcp.tool(name="get_task_status", description="查询任务执行状态")(mcp_get_task_status)

    mcp_port = GATEWAY_PORT + 1
    print(f"[gateway] FastMCP (streamable-http) on port {mcp_port}", flush=True)
    mcp.run(transport="streamable-http", host=GATEWAY_HOST, port=mcp_port)


if __name__ == "__main__":
    mode = sys.argv[1] if len(sys.argv) > 1 else "both"
    if mode == "http":
        run_gateway_http()
    elif mode == "mcp":
        run_gateway_mcp()
    else:
        mcp_thread = threading.Thread(target=run_gateway_mcp, daemon=True)
        mcp_thread.start()
        run_gateway_http()
PYEOF

echo "  代码已部署到 $DEPLOY_DIR"

# ── 4. Python 虚拟环境 + 依赖 ──
echo ""
echo "[4/6] 创建 Python 虚拟环境并安装依赖..."
cd "$DEPLOY_DIR"

if [ ! -d "venv" ]; then
    $PYTHON_CMD -m venv venv
fi
source venv/bin/activate

pip install --upgrade pip -q
pip install "fastmcp>=2.0" -q

echo "  fastmcp 已安装: $(pip show fastmcp 2>/dev/null | grep Version)"

# ── 5. Systemd 服务 ──
echo ""
echo "[5/6] 配置 systemd 服务..."

cat > /etc/systemd/system/hermes-mcp-gateway.service << EOF
[Unit]
Description=Hermes MCP Gateway
After=network.target

[Service]
Type=simple
User=root
WorkingDirectory=$DEPLOY_DIR
Environment=HERMES_GATEWAY_HOST=0.0.0.0
Environment=HERMES_GATEWAY_PORT=$GATEWAY_PORT
Environment=HERMES_GATEWAY_DATA=$DATA_DIR
Environment=HERMES_GATEWAY_TOKEN=
ExecStart=$DEPLOY_DIR/venv/bin/python $DEPLOY_DIR/server.py both
Restart=always
RestartSec=5
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable hermes-mcp-gateway
systemctl restart hermes-mcp-gateway

echo "  服务已启动"

# ── 6. 防火墙 ──
echo ""
echo "[6/6] 配置防火墙..."

# firewalld
if systemctl is-active firewalld &>/dev/null; then
    firewall-cmd --permanent --add-port=${GATEWAY_PORT}/tcp 2>/dev/null || true
    firewall-cmd --permanent --add-port=${MCP_PORT}/tcp 2>/dev/null || true
    firewall-cmd --reload 2>/dev/null || true
    echo "  firewalld: 已开放 $GATEWAY_PORT, $MCP_PORT"
fi

# iptables fallback
if command -v iptables &>/dev/null; then
    iptables -C INPUT -p tcp --dport $GATEWAY_PORT -j ACCEPT 2>/dev/null || \
        iptables -I INPUT -p tcp --dport $GATEWAY_PORT -j ACCEPT 2>/dev/null || true
    iptables -C INPUT -p tcp --dport $MCP_PORT -j ACCEPT 2>/dev/null || \
        iptables -I INPUT -p tcp --dport $MCP_PORT -j ACCEPT 2>/dev/null || true
    echo "  iptables: 已开放 $GATEWAY_PORT, $MCP_PORT"
fi

# ── 验证 ──
echo ""
echo "============================================"
echo " 部署完成！等待服务启动..."
echo "============================================"
sleep 3

# 检查服务状态
if systemctl is-active hermes-mcp-gateway &>/dev/null; then
    echo ""
    echo "✅ 服务运行正常！"
    echo ""
    echo "服务端点："
    echo "  HTTP API:  http://21.91.41.66:${GATEWAY_PORT}/health"
    echo "  MCP Server: http://21.91.41.66:${MCP_PORT}/mcp"
    echo ""
    echo "验证命令："
    echo "  curl http://localhost:${GATEWAY_PORT}/health"
    echo "  curl http://localhost:${MCP_PORT}/mcp"
    echo ""
    echo "查看日志："
    echo "  journalctl -u hermes-mcp-gateway -f"
    echo ""
    echo "═══════════════════════════════════════════"
    echo " Knot MCP 配置（添加到 Knot 的 MCP 设置中）"
    echo "═══════════════════════════════════════════"
    echo ""
    echo "  服务名称: hermes-team"
    echo "  传输协议: Streamable HTTP"
    echo "  URL:      http://21.91.41.66:${MCP_PORT}/mcp"
    echo ""
    echo "═══════════════════════════════════════════"
else
    echo ""
    echo "⚠️  服务可能未正常启动，查看日志排查："
    echo "  journalctl -u hermes-mcp-gateway --no-pager -n 30"
    systemctl status hermes-mcp-gateway --no-pager
fi
