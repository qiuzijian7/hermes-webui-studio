"""
Hermes Web UI — Browser 事件桥接（P0 + P1 + P2 基础设施）

架构思路：
  - browser_* 工具在主 hermes-agent 仓（tools/browser_tool.py）里，不应改动它
  - 利用 run_agent.py 已有的 tool_progress_callback / tool_complete_callback
    在每个 browser_* 工具的 started/completed 时刻，截取事件、拿截图、解析参数，
    然后通过 SSE 推送到前端

对外 API：
  - make_browser_event_capture(session_id, put_sse)
        返回 {on_tool_started, on_tool_completed, last_screenshot_path}
        给 streaming.py 的 on_tool / on_tool_complete 使用

  - register_pending_continue(session_id, cid, reason, timeout_s)
        请求用户点"下一步"——由 tools/user_continue_tool.py 调用
  - resolve_pending_continue(session_id, action)
        用户点了"下一步"（或"取消"）后解除阻塞

设计要点：
  - 每个 browser_* 工具结束后尝试截取一张 PNG，写到会话 shots 目录
    并通过 SSE 推 browser_step 事件（含 screenshot_url）
  - click/type 的 ref 被解析出来，作为 element_ref 传给前端做高亮
  - 用最轻量的 _run_browser_command 直接拿 screenshot，不走 vision 链路（省时间）
  - 凡是 session 级的数据都以 session_id 为 key，存在本模块级字典里
"""
from __future__ import annotations

import base64
import logging
import os
import threading
import time
import uuid
from pathlib import Path
from typing import Any, Callable, Dict, Optional

logger = logging.getLogger(__name__)

# ── 常量 ──────────────────────────────────────────────────────────────────────

# 哪些工具名被视为 browser 操作；列表用白名单维护，避免误触
_BROWSER_TOOL_NAMES = frozenset({
    "browser_navigate",
    "browser_click",
    "browser_type",
    "browser_scroll",
    "browser_back",
    "browser_press",
    "browser_snapshot",
    "browser_console",
    "browser_get_images",
    "browser_vision",
    "request_user_continue",
})

# 仅以下动作需要在 completed 时拍截图（snapshot/console 本身不改变页面，跳过）
_SHOT_WORTHY = frozenset({
    "browser_navigate",
    "browser_click",
    "browser_type",
    "browser_scroll",
    "browser_back",
    "browser_press",
})


def _get_webui_home() -> Path:
    """返回 webui 的状态根目录（~/.hermes/webui/browser-shots/）。"""
    try:
        from api.config import STATE_DIR
        base = Path(STATE_DIR)
    except Exception:
        base = Path.home() / ".hermes" / "webui"
    shots = base / "browser-shots"
    shots.mkdir(parents=True, exist_ok=True)
    return shots


def _take_screenshot_quick(task_id: str) -> Optional[Path]:
    """
    调 agent-browser 的 screenshot 子命令拿一张 PNG。
    返回文件路径（失败返回 None）。
    """
    try:
        from tools.browser_tool import _run_browser_command  # type: ignore
    except Exception as e:
        logger.debug("browser_events: cannot import _run_browser_command: %s", e)
        return None

    try:
        shots_dir = _get_webui_home() / task_id
        shots_dir.mkdir(parents=True, exist_ok=True)
        path = shots_dir / f"shot_{uuid.uuid4().hex[:12]}.png"
        # agent-browser: screenshot [output_path]（viewport 即可，full 会慢）
        result = _run_browser_command(task_id, "screenshot", [str(path)], timeout=15)
        if not isinstance(result, dict) or not result.get("success"):
            logger.debug("browser_events: screenshot failed: %s", result)
            return None
        actual = result.get("data", {}).get("path")
        if actual and Path(actual).exists():
            return Path(actual)
        if path.exists():
            return path
    except Exception as e:
        logger.debug("browser_events: _take_screenshot_quick exception: %s", e)
    return None


def _cleanup_old_shots(session_id: str, keep_latest: int = 30):
    """限制每个 session 的截图数量，删除最早的。"""
    try:
        d = _get_webui_home() / session_id
        if not d.exists():
            return
        files = sorted(d.glob("shot_*.png"), key=lambda p: p.stat().st_mtime, reverse=True)
        for f in files[keep_latest:]:
            try:
                f.unlink()
            except Exception:
                pass
    except Exception:
        pass


# ── browser_step 事件捕获 ─────────────────────────────────────────────────────

class BrowserEventCapture:
    """
    绑定到某个 stream 的 SSE put 函数 + session_id，截取 browser_* 工具进度并发事件。

    使用方式（streaming.py）：
        cap = BrowserEventCapture(session_id=session_id, put_sse=put)
        # 在 tool_progress_callback 里
        cap.on_tool_event(phase, name, args, duration, is_error)
    """

    def __init__(self, session_id: str, put_sse: Callable[[str, dict], None]):
        self.session_id = session_id
        self.put = put_sse
        # step_id 由 on_started 生成并记录，on_completed 里配对取回
        self._pending: Dict[str, str] = {}   # name -> step_id（最新一个；单线程串行）
        self._lock = threading.Lock()

    def on_started(self, name: str, args: Any, preview: str = ""):
        """tool 调用开始。推送 status=running 的 browser_step。"""
        if name not in _BROWSER_TOOL_NAMES:
            return
        step_id = f"bstep_{uuid.uuid4().hex[:10]}"
        with self._lock:
            self._pending[name] = step_id
        evt = {
            "step_id": step_id,
            "action": self._action_of(name),
            "tool_name": name,
            "status": "running",
            "timestamp": time.time(),
        }
        if isinstance(args, dict):
            # 标准化抽取参数
            for k in ("url", "ref", "text", "direction", "key", "expression", "reason"):
                if k in args and args[k] is not None:
                    v = str(args[k])
                    # 脱敏：密码字段不记录
                    if k == "text" and self._looks_like_password(v):
                        v = "••••••"
                    evt[k] = v[:500]
        try:
            self.put("browser_step", evt)
        except Exception as e:
            logger.debug("browser_events: put browser_step(running) failed: %s", e)

    def on_completed(self, name: str, args: Any, result: Any, duration: float = 0.0,
                     is_error: bool = False):
        """tool 调用完成。拍截图 + 推 status=done/error 的 browser_step。"""
        if name not in _BROWSER_TOOL_NAMES:
            return
        with self._lock:
            step_id = self._pending.pop(name, f"bstep_{uuid.uuid4().hex[:10]}")

        evt = {
            "step_id": step_id,
            "action": self._action_of(name),
            "tool_name": name,
            "status": "error" if is_error else "done",
            "duration_ms": int(duration * 1000),
            "timestamp": time.time(),
        }

        # 从 args 再次带参数（方便前端渲染步骤标题）
        if isinstance(args, dict):
            for k in ("url", "ref", "text", "direction", "key", "reason"):
                if k in args and args[k] is not None:
                    v = str(args[k])
                    if k == "text" and self._looks_like_password(v):
                        v = "••••••"
                    evt[k] = v[:500]

        # 从 result 尝试抽取 url/title（browser_navigate 返回 JSON 字符串）
        if not is_error and isinstance(result, str) and result.startswith("{"):
            try:
                import json
                rd = json.loads(result)
                if isinstance(rd, dict):
                    if rd.get("url"):
                        evt.setdefault("url", str(rd["url"])[:500])
                    if rd.get("title"):
                        evt["title"] = str(rd["title"])[:300]
                    if rd.get("error"):
                        evt["error"] = str(rd["error"])[:500]
            except Exception:
                pass
        elif is_error and isinstance(result, str):
            evt["error"] = result[:500]

        # 尝试拍截图（仅在可能改变页面的工具上）
        if not is_error and name in _SHOT_WORTHY:
            shot = _take_screenshot_quick(self.session_id)
            if shot is not None:
                # 通过 /api/browser/shot?session_id=...&file=shot_xxx.png 暴露
                evt["screenshot_url"] = (
                    f"/api/browser/shot?session_id={self.session_id}&file={shot.name}"
                )
                _cleanup_old_shots(self.session_id, keep_latest=30)

        try:
            self.put("browser_step", evt)
        except Exception as e:
            logger.debug("browser_events: put browser_step(done) failed: %s", e)

    # ── 辅助 ──────────────────────────────────────────────────────────

    @staticmethod
    def _action_of(tool_name: str) -> str:
        """browser_click → click。"""
        return tool_name.replace("browser_", "", 1)

    @staticmethod
    def _looks_like_password(text: str) -> bool:
        """粗略判断是否是密码（纯字母数字+特殊，长度 6-128）。"""
        if not text or len(text) < 6 or len(text) > 128:
            return False
        # 有空格/换行一般不是密码
        if " " in text or "\n" in text:
            return False
        # 纯字母也可能是普通搜索词——不做过滤
        # 保守起见：仅当看起来像"典型密码"才打码（带数字+大写+特殊）
        has_digit = any(c.isdigit() for c in text)
        has_upper = any(c.isupper() for c in text)
        has_special = any(not c.isalnum() for c in text)
        return has_digit and has_upper and has_special


# ── 用户"下一步"暂停机制 ─────────────────────────────────────────────────────

class _ContinueEntry:
    __slots__ = ("cid", "reason", "timeout_at", "event", "result", "started_at")

    def __init__(self, cid: str, reason: str, timeout_at: float):
        self.cid = cid
        self.reason = reason
        self.timeout_at = timeout_at
        self.event = threading.Event()
        self.result: Optional[dict] = None
        self.started_at = time.time()


_CONTINUE_LOCK = threading.Lock()
_CONTINUE_QUEUES: Dict[str, list] = {}   # session_id -> [_ContinueEntry,...]


def register_pending_continue(session_id: str, cid: str, reason: str,
                              timeout_seconds: int) -> _ContinueEntry:
    """
    由 request_user_continue 工具调用——注册一个"等待用户点下一步"条目。
    返回 _ContinueEntry；调用方需要 entry.event.wait(timeout_seconds) 阻塞等待。
    """
    entry = _ContinueEntry(cid=cid, reason=reason,
                           timeout_at=time.time() + timeout_seconds)
    with _CONTINUE_LOCK:
        _CONTINUE_QUEUES.setdefault(session_id, []).append(entry)
    return entry


def resolve_pending_continue(session_id: str, action: str = "continue") -> bool:
    """
    由 /api/browser/continue 调用——解除最早一个等待的 entry。
    action: "continue" | "cancel"
    """
    with _CONTINUE_LOCK:
        q = _CONTINUE_QUEUES.get(session_id)
        if not q:
            return False
        entry = q.pop(0)
        if not q:
            _CONTINUE_QUEUES.pop(session_id, None)
    entry.result = {
        "status": "continued" if action == "continue" else "cancelled",
        "waited_seconds": int(time.time() - entry.started_at),
    }
    entry.event.set()
    return True


def cancel_all_pending_continues(session_id: str):
    """session 取消/结束时解除所有等待。"""
    with _CONTINUE_LOCK:
        entries = _CONTINUE_QUEUES.pop(session_id, [])
    for entry in entries:
        entry.result = {"status": "cancelled", "waited_seconds": int(time.time() - entry.started_at)}
        entry.event.set()


def get_pending_continue(session_id: str) -> Optional[_ContinueEntry]:
    """用于 /api/browser/continue/pending 查询——返回最早一个未解的 entry（仅用于前端刷新恢复显示）。"""
    with _CONTINUE_LOCK:
        q = _CONTINUE_QUEUES.get(session_id)
        if q:
            return q[0]
    return None
