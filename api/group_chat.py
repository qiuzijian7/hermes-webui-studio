"""
Hermes Web UI -- Coordinator session API (formerly group chat / 总群).

This module provides an abstraction layer for storing coordination messages
(task delegations, results, heartbeat notifications) in the PM employee's
session instead of a separate group-chat session.

Key change from the old group-chat architecture:
  - BEFORE: Each workspace had a separate group-chat session (is_group_chat=True)
  - AFTER: Coordination messages are stored directly in the PM employee's session

The module keeps the same public API (add_group_message, post_task_result, etc.)
so that existing callers (hooks, routes.py) don't need to change.
"""

import json
import re
import threading
import time
import uuid
from pathlib import Path

from api.config import SESSION_DIR, LOCK, DEFAULT_MODEL, PM_NAME
from api.models import Session, get_session, new_session, _write_session_index


# ── In-memory PM session cache ────────────────────────────────────────────────
# Maps workspace path → PM session_id (resolved dynamically from employee data)
# This replaces the old _GROUP_CHAT_MAP.
_PM_SESSION_CACHE: dict[str, str] = {}
_PM_SESSION_LOCK = threading.RLock()


def _get_pm_session_id_for_workspace(workspace: str) -> str | None:
    """Find the PM employee's session_id for a workspace.

    This queries the employee filesystem to find the PM employee
    and returns their session_id. If no PM exists or has no session,
    returns None.
    """
    ws = str(Path(workspace).expanduser().resolve())

    # Check cache first
    with _PM_SESSION_LOCK:
        cached = _PM_SESSION_CACHE.get(ws)
        if cached:
            try:
                s = get_session(cached)
                if s:
                    return cached
            except KeyError:
                pass
            # Cache stale — clear it
            _PM_SESSION_CACHE.pop(ws, None)

    # Resolve from employee filesystem
    try:
        from api.employee_fs import list_employees
        employees = list_employees(ws)
        pm_emp = None
        for emp in employees:
            if emp.get("isPM") or emp.get("role") == PM_NAME:
                pm_emp = emp
                break
        # Fallback: first employee with subagentOf or any employee
        if not pm_emp:
            for emp in employees:
                if emp.get("subagentOf") is None:
                    pm_emp = emp
                    break
        if not pm_emp and employees:
            pm_emp = employees[0]

        if pm_emp:
            sid = pm_emp.get("sessionId") or pm_emp.get("session_id")
            if sid:
                with _PM_SESSION_LOCK:
                    _PM_SESSION_CACHE[ws] = sid
                return sid
    except Exception:
        pass

    return None


def _invalidate_pm_session_cache(workspace: str) -> None:
    """Clear the cached PM session_id for a workspace (call when PM changes)."""
    ws = str(Path(workspace).expanduser().resolve())
    with _PM_SESSION_LOCK:
        _PM_SESSION_CACHE.pop(ws, None)


def get_or_create_group_chat(workspace: str) -> dict:
    """DEPRECATED: Kept for backward compatibility.

    Returns the PM employee's session data as if it were a "group chat" session.
    This allows old callers to keep working without changes.
    """
    ws = str(Path(workspace).expanduser().resolve())
    sid = _get_pm_session_id_for_workspace(ws)

    if sid:
        try:
            s = get_session(sid)
            return _group_chat_data(s, ws)
        except KeyError:
            pass

    # No PM session yet — return a minimal placeholder
    return {
        "session_id": None,
        "title": PM_NAME,
        "workspace": ws,
        "is_group_chat": False,
        "messages": [],
        "created_at": time.time(),
        "updated_at": time.time(),
    }


def _group_chat_data(s: Session, ws: str) -> dict:
    """Build the group-chat-style response dict from a Session."""
    return {
        "session_id": s.session_id,
        "title": getattr(s, "title", PM_NAME),
        "workspace": ws,
        "is_group_chat": False,  # No longer a separate GC session
        "messages": s.messages,
        "created_at": getattr(s, "created_at", time.time()),
        "updated_at": getattr(s, "updated_at", time.time()),
    }


def add_group_message(workspace: str, role: str, content: str,
                      sender_name: str = None, mentions: list = None,
                      task_id: str = None, task_ids: list = None) -> dict:
    """Add a message to the PM employee's session (instead of a separate GC session).

    This is the core migration: messages that used to go into the standalone
    group-chat session now go directly into the PM employee's session.
    """
    import sys
    print(f"[coordinator] add_group_message: workspace={workspace}, role={role}, content_len={len(content)}", file=sys.stderr, flush=True)

    ws = str(Path(workspace).expanduser().resolve())
    sid = _get_pm_session_id_for_workspace(ws)

    if not sid:
        print(f"[coordinator] add_group_message: no PM session found for workspace={ws}, message dropped", file=sys.stderr, flush=True)
        return {}

    s = get_session(sid)
    print(f"[coordinator] add_group_message: session_id={sid}", file=sys.stderr, flush=True)

    msg = {
        "role": role,
        "content": content,
        "_ts": time.time(),
    }
    if sender_name:
        msg["_sender"] = sender_name
    if mentions:
        msg["_mentions"] = mentions
    if task_id:
        msg["_task_id"] = task_id
    if task_ids:
        msg["_task_ids"] = list(task_ids)

    s.messages.append(msg)
    s.updated_at = time.time()
    s.save()

    return msg


def append_group_system_message(workspace: str, message: str, sender_name: str = "system") -> dict:
    """Append a system message to the PM employee's session."""
    try:
        return add_group_message(
            workspace=workspace,
            role="system",
            content=message,
            sender_name=sender_name,
        )
    except Exception:
        import logging
        logging.getLogger(__name__).exception("append_group_system_message failed")
        return {}


def post_task_result(workspace: str, employee_name: str, task_id: str,
                     result: str, requester_name: str = None) -> dict:
    """Post a task result back to the PM employee's session.

    The dedup logic is preserved exactly as before.
    """
    import sys
    DEDUPE_WINDOW_SECONDS = 120

    ws = str(Path(workspace).expanduser().resolve())
    sid = _get_pm_session_id_for_workspace(ws)
    if not sid:
        print(f"[coordinator] post_task_result: no PM session for workspace={ws}", file=sys.stderr, flush=True)
        return {}

    try:
        s = get_session(sid)
        messages = s.messages or []

        # Layer 1: strict task_id match
        if task_id:
            for m in reversed(messages):
                if (
                    m.get("_task_id") == task_id
                    and m.get("_sender") == employee_name
                    and m.get("role") == "assistant"
                ):
                    print(f"[coordinator] post_task_result: duplicate task_id={task_id} employee={employee_name}, skipping",
                          file=sys.stderr, flush=True)
                    return m

        # Layer 2: content-based dedupe within a short time window
        now = time.time()
        target_content_suffix = result.strip()
        for m in reversed(messages):
            mts = m.get("_ts") or 0
            if mts and (now - mts) > DEDUPE_WINDOW_SECONDS:
                break
            if (
                m.get("_sender") == employee_name
                and m.get("role") == "assistant"
                and isinstance(m.get("content"), str)
                and m.get("content", "").rstrip().endswith(target_content_suffix)
            ):
                print(f"[coordinator] post_task_result: content-based duplicate within {DEDUPE_WINDOW_SECONDS}s "
                      f"(employee={employee_name}, task_id={task_id!r}), skipping",
                      file=sys.stderr, flush=True)
                return m
    except Exception as e:
        print(f"[coordinator] post_task_result: dedupe lookup failed: {e}",
              file=sys.stderr, flush=True)

    mention_str = f"@{requester_name}" if requester_name else ""
    task_id_seg = f"{{{{TASK_LINK:{task_id}}}}} " if task_id else ""
    content = f"{task_id_seg}**{employee_name}** 完成了任务：\n\n{result}"
    if mention_str:
        content = f"{mention_str} {content}"

    return add_group_message(
        workspace=workspace,
        role="assistant",
        content=content,
        sender_name=employee_name,
        mentions=[requester_name] if requester_name else [],
        task_id=task_id,
    )


def parse_mentions(text: str) -> list[str]:
    """Extract @mentions from message text."""
    pattern = r'@([\w\u4e00-\u9fff\u3400-\u4dbf]+)'
    matches = re.findall(pattern, text)
    return [m.strip() for m in matches if m.strip()]
