"""
Employee Script Executor — 员工/工作区 Python 脚本执行。

设计目标：
  - 员工可通过 `run_employee_script` 工具调用自己 `scripts/` 目录下的 Python 脚本
  - PM 专员等主管角色可执行工作区级脚本（workspaces/<slug>/scripts/）
  - 支持 local（宿主机）+ docker（隔离沙箱）两种执行模式
  - 超时保护 + 输出长度限制 + 参数/返回值 JSON 化
  - 所有路径强制 relative_to scripts/ 根，防止目录穿越

核心 API：
  - execute_script(scope, scope_id, script_name, args, timeout, mode) -> dict
      在后端服务进程中直接调用（同步）
  - run_employee_script(args, **kw) — 注册为 agent tool，员工 agent 直接调用
  - handle_script_execute / handle_script_list / handle_script_sse — HTTP 路由

调用方式：
  前端点击 "运行脚本" → POST /api/script/execute → SSE 流式返回 stdout
  Agent 工具调用 → run_employee_script(scope='employee', script_name='xxx.py', args={...})
"""
from __future__ import annotations

import json
import logging
import os
import re
import subprocess
import sys
import threading
import time
from pathlib import Path
from typing import Any, Dict, Optional, Tuple

logger = logging.getLogger(__name__)


# ── 沙箱模式 ────────────────────────────────────────────────────────────────

MODE_LOCAL = "local"
MODE_DOCKER = "docker"

# 默认执行策略
DEFAULT_TIMEOUT_SEC = 60
MAX_TIMEOUT_SEC = 600
MAX_OUTPUT_BYTES = 256 * 1024   # 256 KB 输出上限
DEFAULT_MODE = os.getenv("HERMES_SCRIPT_SANDBOX", MODE_LOCAL).lower()

# 允许的脚本扩展名
ALLOWED_EXTS = {".py"}

# Docker 镜像（用户可通过环境变量覆盖）
DOCKER_IMAGE = os.getenv("HERMES_SCRIPT_DOCKER_IMAGE", "python:3.11-slim")


# ── 路径解析 ────────────────────────────────────────────────────────────────

def _scripts_dir_for(scope: str, scope_id: str) -> Optional[Path]:
    """
    解析脚本目录。

    scope="employee" + scope_id=workspace 绝对路径（+ emp_id 通过另一参数）
      → workspaces/<slug>/employee_ins/<emp_name>/scripts/
      (暂不使用 employee_fs 的外置员工目录)
    scope="workspace" + scope_id=workspace slug 或绝对路径
      → workspaces/<slug>/scripts/
    scope="preset" + scope_id=preset id
      → employees/presets/<preset_id>/scripts/（通常只读，作为示例库）
    """
    from api.config import REPO_ROOT

    if scope == "workspace":
        ws = (scope_id or "").strip()
        if not ws:
            return None
        # 若是绝对路径，直接 workspace/scripts
        p = Path(ws)
        if p.is_absolute() and p.is_dir():
            return p / "scripts"
        # 否则按 slug 在 webui 的 workspaces 下找
        slug = _safe_slug(ws)
        return REPO_ROOT / "workspaces" / slug / "scripts"

    if scope == "preset":
        pid = _safe_slug(scope_id or "")
        if not pid:
            return None
        return REPO_ROOT / "employees" / "presets" / pid / "scripts"

    # scope == "employee" 需要额外的 emp_id，通过下面 _employee_scripts_dir
    return None


def _employee_scripts_dir(workspace: str, emp_id: str) -> Optional[Path]:
    """
    解析员工 scripts/ 目录。
    优先尝试 workspaces/<slug>/employee_ins/<name>/scripts/；
    再尝试 <workspace>/employees/<name>/scripts/ (旧结构)。
    """
    try:
        from api.employee_fs import get_employee_by_id, _employee_dir
    except Exception:
        return None
    try:
        emp = get_employee_by_id(workspace, emp_id)
    except Exception:
        emp = None
    if not emp:
        return None
    name = emp.get("name", "")
    if not name:
        return None
    try:
        emp_dir = _employee_dir(workspace, name)
        if emp_dir and emp_dir.is_dir():
            return emp_dir / "scripts"
    except Exception:
        pass
    return None


_SLUG_RE = re.compile(r"[^a-zA-Z0-9_\-]")


def _safe_slug(name: str) -> str:
    return _SLUG_RE.sub("_", (name or "").strip())[:128]


def _safe_script_path(scripts_dir: Path, script_name: str) -> Optional[Path]:
    """
    校验脚本路径：
      - 只允许 .py
      - 必须位于 scripts_dir 内（防路径穿越）
      - 文件必须存在
    """
    if not script_name or "\x00" in script_name:
        return None
    if ".." in script_name.replace("\\", "/").split("/"):
        return None
    candidate = (scripts_dir / script_name).resolve()
    try:
        candidate.relative_to(scripts_dir.resolve())
    except (ValueError, OSError):
        return None
    if candidate.suffix.lower() not in ALLOWED_EXTS:
        return None
    if not candidate.is_file():
        return None
    return candidate


# ── 列表 API ────────────────────────────────────────────────────────────────

def list_scripts(scope: str, scope_id: str,
                 emp_id: str = "", workspace: str = "") -> list:
    """列出指定 scope 下可执行的 Python 脚本。"""
    if scope == "employee":
        scripts_dir = _employee_scripts_dir(workspace or scope_id, emp_id)
    else:
        scripts_dir = _scripts_dir_for(scope, scope_id)
    if not scripts_dir or not scripts_dir.is_dir():
        return []
    items = []
    for f in sorted(scripts_dir.iterdir()):
        if f.is_file() and f.suffix.lower() in ALLOWED_EXTS:
            # 尝试读取第一个 docstring 作为描述
            desc = ""
            try:
                src = f.read_text(encoding="utf-8")
                m = re.search(r'^\s*"""([\s\S]*?)"""', src)
                if m:
                    desc = m.group(1).strip().split("\n")[0][:200]
            except Exception:
                pass
            items.append({
                "name": f.name,
                "size": f.stat().st_size,
                "description": desc,
                "mtime": int(f.stat().st_mtime),
            })
    return items


# ── 执行器 ──────────────────────────────────────────────────────────────────

def _run_local(script_path: Path, args: Dict[str, Any],
               timeout: int, cwd: Path) -> Dict[str, Any]:
    """本地子进程执行。"""
    cmd = [sys.executable, "-u", str(script_path)]
    # 把参数作为 JSON 通过 stdin 注入（脚本可 sys.stdin.read() 解析）
    stdin_payload = json.dumps(args or {}, ensure_ascii=False)

    started = time.time()
    try:
        proc = subprocess.Popen(
            cmd,
            cwd=str(cwd),
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            env={**os.environ, "PYTHONIOENCODING": "utf-8", "PYTHONUTF8": "1"},
        )
    except Exception as exc:
        return {"success": False, "error": f"spawn failed: {exc}",
                "exit_code": -1, "duration_ms": 0}

    try:
        stdout, stderr = proc.communicate(
            input=stdin_payload.encode("utf-8"),
            timeout=timeout,
        )
        exit_code = proc.returncode
    except subprocess.TimeoutExpired:
        proc.kill()
        try:
            stdout, stderr = proc.communicate(timeout=2)
        except Exception:
            stdout, stderr = b"", b""
        return {
            "success": False,
            "error": f"timeout after {timeout}s",
            "exit_code": -1,
            "stdout": _truncate(stdout),
            "stderr": _truncate(stderr),
            "duration_ms": int((time.time() - started) * 1000),
        }

    return {
        "success": exit_code == 0,
        "exit_code": exit_code,
        "stdout": _truncate(stdout),
        "stderr": _truncate(stderr),
        "duration_ms": int((time.time() - started) * 1000),
    }


def _run_docker(script_path: Path, args: Dict[str, Any],
                timeout: int, cwd: Path) -> Dict[str, Any]:
    """在 Docker 容器中执行（需要宿主机有 docker 可用）。"""
    # 检查 docker 可用
    try:
        subprocess.run(["docker", "--version"],
                       capture_output=True, check=True, timeout=5)
    except Exception as exc:
        return {
            "success": False,
            "error": f"docker not available: {exc}",
            "exit_code": -1, "duration_ms": 0,
        }

    mount = str(cwd.resolve())
    rel = str(script_path.relative_to(cwd))

    cmd = [
        "docker", "run", "--rm", "-i",
        "--network=none",                 # 默认无网络
        "--memory=512m",                  # 内存限制
        "--cpus=1",                       # CPU 限制
        "-v", f"{mount}:/work:ro",        # 挂载 scripts 目录只读
        "-w", "/work",
        "-e", "PYTHONIOENCODING=utf-8",
        "-e", "PYTHONUTF8=1",
        DOCKER_IMAGE,
        "python", "-u", rel,
    ]
    stdin_payload = json.dumps(args or {}, ensure_ascii=False)
    started = time.time()
    try:
        result = subprocess.run(
            cmd, input=stdin_payload.encode("utf-8"),
            capture_output=True, timeout=timeout,
        )
        return {
            "success": result.returncode == 0,
            "exit_code": result.returncode,
            "stdout": _truncate(result.stdout),
            "stderr": _truncate(result.stderr),
            "duration_ms": int((time.time() - started) * 1000),
            "sandbox": "docker",
        }
    except subprocess.TimeoutExpired:
        return {
            "success": False,
            "error": f"timeout after {timeout}s",
            "exit_code": -1,
            "duration_ms": int((time.time() - started) * 1000),
        }


def _truncate(data: bytes) -> str:
    """字节数据转字符串，限制长度。"""
    if not data:
        return ""
    text = data.decode("utf-8", errors="replace")
    if len(text) > MAX_OUTPUT_BYTES:
        text = text[:MAX_OUTPUT_BYTES] + f"\n\n…(truncated, total {len(text)} bytes)"
    return text


def execute_script(
    scope: str,
    scope_id: str,
    script_name: str,
    args: Optional[Dict[str, Any]] = None,
    timeout: int = DEFAULT_TIMEOUT_SEC,
    mode: str = "",
    emp_id: str = "",
    workspace: str = "",
) -> Dict[str, Any]:
    """
    主执行入口。

    Args:
        scope: "employee" | "workspace" | "preset"
        scope_id: workspace slug / preset id / (employee 用 emp_id + workspace)
        script_name: 脚本文件名（相对于 scripts/ 目录）
        args: 传给脚本的参数（JSON，通过 stdin 注入）
        timeout: 秒，上限 MAX_TIMEOUT_SEC
        mode: "local" | "docker"，默认 HERMES_SCRIPT_SANDBOX

    Returns:
        {success, exit_code, stdout, stderr, duration_ms, script_path, sandbox}
    """
    timeout = max(1, min(int(timeout or DEFAULT_TIMEOUT_SEC), MAX_TIMEOUT_SEC))
    mode = (mode or DEFAULT_MODE or MODE_LOCAL).lower()
    if mode not in (MODE_LOCAL, MODE_DOCKER):
        mode = MODE_LOCAL

    # 解析 scripts 目录
    if scope == "employee":
        scripts_dir = _employee_scripts_dir(workspace or scope_id, emp_id)
    else:
        scripts_dir = _scripts_dir_for(scope, scope_id)

    if not scripts_dir or not scripts_dir.is_dir():
        return {
            "success": False,
            "error": f"scripts directory not found for scope={scope}",
            "exit_code": -1,
        }

    script_path = _safe_script_path(scripts_dir, script_name)
    if not script_path:
        return {
            "success": False,
            "error": f"invalid or missing script: {script_name}",
            "exit_code": -1,
        }

    logger.info("Executing script %s (mode=%s, timeout=%ds)",
                script_path, mode, timeout)

    if mode == MODE_DOCKER:
        result = _run_docker(script_path, args or {}, timeout, scripts_dir)
    else:
        result = _run_local(script_path, args or {}, timeout, scripts_dir)

    result["script_path"] = str(script_path)
    result.setdefault("sandbox", mode)
    return result


# ── Agent Tool Registration ─────────────────────────────────────────────────

def _register_agent_tool():
    """把 run_employee_script 注册到 agent 的 tools/registry。"""
    try:
        from tools.registry import registry, tool_error, tool_result
    except Exception:
        return

    def _handler(args: dict, **kw) -> str:
        scope = args.get("scope", "employee")
        script_name = args.get("script_name", "")
        script_args = args.get("args", {}) or {}
        timeout = int(args.get("timeout", DEFAULT_TIMEOUT_SEC))
        # 从调用上下文取 workspace / emp_id（通过 kw）
        workspace = kw.get("workspace", "") or args.get("workspace", "")
        emp_id = kw.get("emp_id", "") or args.get("emp_id", "")
        scope_id = args.get("scope_id", "") or workspace

        if not script_name:
            return tool_error("script_name is required")

        result = execute_script(
            scope=scope,
            scope_id=scope_id,
            script_name=script_name,
            args=script_args,
            timeout=timeout,
            emp_id=emp_id,
            workspace=workspace,
        )
        return json.dumps(result, ensure_ascii=False)

    registry.register(
        name="run_employee_script",
        toolset="employee_scripts",
        schema={
            "name": "run_employee_script",
            "description": (
                "Execute a Python script from the employee's or workspace's scripts/ folder. "
                "Useful for running custom automation, data processing, or PM specialist tasks. "
                "Scripts receive their arguments via stdin as JSON. "
                "Returns {success, exit_code, stdout, stderr, duration_ms}."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "scope": {
                        "type": "string",
                        "enum": ["employee", "workspace", "preset"],
                        "description": "Which scripts/ directory to use. 'employee' = own scripts/, 'workspace' = workspace-level, 'preset' = built-in preset examples (read-only).",
                    },
                    "script_name": {
                        "type": "string",
                        "description": "Script filename (e.g. 'task_decompose.py'). Must exist in the scripts/ directory.",
                    },
                    "args": {
                        "type": "object",
                        "description": "Arguments to pass to the script. Delivered via stdin as JSON; the script reads with sys.stdin.read().",
                    },
                    "timeout": {
                        "type": "integer",
                        "description": f"Execution timeout in seconds (max {MAX_TIMEOUT_SEC}, default {DEFAULT_TIMEOUT_SEC}).",
                    },
                },
                "required": ["scope", "script_name"],
            },
        },
        handler=_handler,
        description="Execute a Python script from scripts/ folder",
    )


# 模块加载时自动注册（若 tools.registry 可用）
try:
    _register_agent_tool()
except Exception as _exc:
    logger.debug("Agent tool registration skipped: %s", _exc)


# ── HTTP Handlers ───────────────────────────────────────────────────────────

def handle_script_list(handler, parsed) -> bool:
    """GET /api/script/list?scope=&scope_id=&emp_id=&workspace="""
    from urllib.parse import parse_qs
    from api.helpers import j, bad
    try:
        qs = parse_qs(parsed.query)
        scope = (qs.get("scope", [""])[0] or "").strip().lower()
        scope_id = (qs.get("scope_id", [""])[0] or "").strip()
        emp_id = (qs.get("emp_id", [""])[0] or "").strip()
        workspace = (qs.get("workspace", [""])[0] or "").strip()
        if scope not in ("employee", "workspace", "preset"):
            return bad(handler, "scope must be employee|workspace|preset")
        items = list_scripts(scope, scope_id, emp_id=emp_id, workspace=workspace)
        return j(handler, {"ok": True, "scripts": items, "count": len(items)})
    except Exception as exc:
        logger.exception("script list failed")
        return j(handler, {"ok": False, "error": str(exc)}, status=500)


def handle_script_execute(handler, body: Dict[str, Any]) -> bool:
    """POST /api/script/execute"""
    from api.helpers import j, bad
    try:
        scope = (body.get("scope") or "").strip().lower()
        scope_id = (body.get("scope_id") or "").strip()
        script_name = (body.get("script_name") or "").strip()
        args = body.get("args") or {}
        timeout = int(body.get("timeout") or DEFAULT_TIMEOUT_SEC)
        mode = (body.get("mode") or "").strip().lower() or DEFAULT_MODE
        emp_id = (body.get("emp_id") or "").strip()
        workspace = (body.get("workspace") or "").strip()

        if scope not in ("employee", "workspace", "preset"):
            return bad(handler, "scope must be employee|workspace|preset")
        if not script_name:
            return bad(handler, "script_name is required")
        if not isinstance(args, dict):
            return bad(handler, "args must be an object")

        result = execute_script(
            scope=scope,
            scope_id=scope_id,
            script_name=script_name,
            args=args,
            timeout=timeout,
            mode=mode,
            emp_id=emp_id,
            workspace=workspace,
        )
        status = 200 if result.get("success") else 200  # 保留 200 让 client 根据 success 判断
        return j(handler, {"ok": True, **result}, status=status)
    except Exception as exc:
        logger.exception("script execute failed")
        return j(handler, {"ok": False, "error": str(exc)}, status=500)
