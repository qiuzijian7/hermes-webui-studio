"""
Hermes Web UI -- Group chat (总群) API.

Each workspace has one group chat named `[workspace_name]_总群`.
The group chat allows @mentioning employees to delegate tasks.
Task results are posted back to the group chat.
"""

import json
import re
import threading
import time
import uuid
from pathlib import Path

from api.config import SESSION_DIR, LOCK, DEFAULT_MODEL, STREAMS, STREAMS_LOCK
from api.models import Session, get_session, new_session, _write_session_index


# ── In-memory group chat registry ─────────────────────────────────────────────
# Maps workspace path → group chat session_id
# Persisted to SESSION_DIR/_group_chats.json
_GROUP_CHAT_MAP: dict[str, str] = {}
_GROUP_CHAT_MAP_FILE = SESSION_DIR / "_group_chats.json"
_GROUP_CHAT_MAP_LOCK = threading.RLock()


def _load_group_chat_map():
    """Load the group chat map from disk (only if not already loaded)."""
    global _GROUP_CHAT_MAP
    with _GROUP_CHAT_MAP_LOCK:
        if _GROUP_CHAT_MAP:  # already loaded
            return
        if _GROUP_CHAT_MAP_FILE.exists():
            try:
                _GROUP_CHAT_MAP = json.loads(
                    _GROUP_CHAT_MAP_FILE.read_text(encoding="utf-8")
                )
            except Exception:
                _GROUP_CHAT_MAP = {}
        else:
            _GROUP_CHAT_MAP = {}


def _save_group_chat_map():
    """Save the group chat map to disk."""
    with _GROUP_CHAT_MAP_LOCK:
        _GROUP_CHAT_MAP_FILE.write_text(
            json.dumps(_GROUP_CHAT_MAP, ensure_ascii=False, indent=2),
            encoding="utf-8",
        )


def get_or_create_group_chat(workspace: str) -> dict:
    """Get or create the group chat session for a workspace.

    Returns the session data dict.
    """
    ws = str(Path(workspace).expanduser().resolve())
    _load_group_chat_map()

    # Check if group chat already exists (without holding _GROUP_CHAT_MAP_LOCK)
    existing_sid = _GROUP_CHAT_MAP.get(ws)
    if existing_sid:
        try:
            s = get_session(existing_sid)
            if s and getattr(s, "is_group_chat", False):
                return _group_chat_data(s, ws)
        except KeyError:
            pass

    # Create new group chat session (outside _GROUP_CHAT_MAP_LOCK to avoid deadlock with LOCK)
    ws_name = Path(ws).name or "workspace"
    title = f"{ws_name}_总群"

    try:
        from api.profiles import get_active_profile_name
        _profile = get_active_profile_name()
    except ImportError:
        _profile = None

    s = Session(
        title=title,
        workspace=ws,
        model=DEFAULT_MODEL,
        profile=_profile,
        is_group_chat=True,
    )
    s.is_group_chat = True
    with LOCK:
        from api.config import SESSIONS, SESSIONS_MAX
        SESSIONS[s.session_id] = s
        SESSIONS.move_to_end(s.session_id)
    s.save()

    with _GROUP_CHAT_MAP_LOCK:
        _GROUP_CHAT_MAP[ws] = s.session_id
        _save_group_chat_map()

    return _group_chat_data(s, ws)


def _group_chat_data(s: Session, ws: str) -> dict:
    """Build the group chat response dict."""
    # Load employees from frontend localStorage — not available on backend.
    # The frontend will provide member info via the API.
    return {
        "session_id": s.session_id,
        "title": s.title,
        "workspace": ws,
        "is_group_chat": True,
        "messages": s.messages,
        "created_at": s.created_at,
        "updated_at": s.updated_at,
    }


def add_group_message(workspace: str, role: str, content: str,
                      sender_name: str = None, mentions: list = None,
                      task_id: str = None, task_ids: list = None) -> dict:
    """Add a message to the group chat.

    Args:
        workspace: The workspace path
        role: 'user' | 'assistant' | 'system'
        content: Message text
        sender_name: Name of the sender (for display)
        mentions: List of employee names mentioned (@name)
        task_id: Optional single task ID (for assistant result messages)
        task_ids: Optional list of task IDs associated with this message
                  (used on user messages that triggered multiple delegated tasks;
                  enables anchor-based jumping from employee chat back to group chat)

    Returns:
        The message dict that was added.
    """
    import sys
    print(f"[group_chat] add_group_message: workspace={workspace}, role={role}, content_len={len(content)}", file=sys.stderr, flush=True)
    data = get_or_create_group_chat(workspace)
    sid = data["session_id"]
    s = get_session(sid)
    print(f"[group_chat] add_group_message: session_id={sid}", file=sys.stderr, flush=True)

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
    """快捷 wrapper：以 system role 往总群追加一条消息。

    供 event_bus hook（如 ``hooks/group_chat_echo.py``）使用：子 agent 完成后
    把摘要以系统消息形式回显到总群，所有打开总群面板的前端会通过 SSE 刷新看到。

    失败时不抛出（调用方多为事件回调，不应影响发射方）。
    """
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
    """Post a task result back to the group chat.

    The result message mentions the original requester.

    Idempotency strategy (two layers):
      1) If task_id is provided: skip if a result for the same
         (task_id, employee_name) pair already exists.
      2) Fallback (when task_id is empty or unmatched): skip if the
         same employee posted the exact same result content within the
         last 120 seconds. This catches cases where multiple frontend
         SSE paths race to post the same result without a task_id.
    """
    import sys
    DEDUPE_WINDOW_SECONDS = 120

    try:
        data = get_or_create_group_chat(workspace)
        existing = get_session(data["session_id"])
        messages = existing.messages or []

        # Layer 1: strict task_id match
        if task_id:
            for m in reversed(messages):
                if (
                    m.get("_task_id") == task_id
                    and m.get("_sender") == employee_name
                    and m.get("role") == "assistant"
                ):
                    print(f"[group_chat] post_task_result: duplicate task_id={task_id} employee={employee_name}, skipping",
                          file=sys.stderr, flush=True)
                    return m

        # Layer 2: content-based dedupe within a short time window
        # Applies whether or not task_id was provided — different SSE paths
        # may pass different task_id values (or none) yet carry the same result.
        now = time.time()
        target_content_suffix = result.strip()
        for m in reversed(messages):
            mts = m.get("_ts") or 0
            if mts and (now - mts) > DEDUPE_WINDOW_SECONDS:
                break  # older than window, no need to look further
            if (
                m.get("_sender") == employee_name
                and m.get("role") == "assistant"
                and isinstance(m.get("content"), str)
                and m.get("content", "").rstrip().endswith(target_content_suffix)
            ):
                print(f"[group_chat] post_task_result: content-based duplicate within {DEDUPE_WINDOW_SECONDS}s "
                      f"(employee={employee_name}, task_id={task_id!r}), skipping",
                      file=sys.stderr, flush=True)
                return m
    except Exception as e:
        print(f"[group_chat] post_task_result: dedupe lookup failed: {e}",
              file=sys.stderr, flush=True)
        # fall through and insert normally

    mention_str = f"@{requester_name}" if requester_name else ""
    # 任务 id 片段：前端把 {{TASK_LINK:xxx}} 渲染为可跳转链接
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
    """Extract @mentions from message text.

    Returns list of mentioned names (without @ prefix).
    Matches @ followed by name characters (letters, digits, Chinese chars, underscores).
    Name ends at whitespace, punctuation, or another @.
    """
    pattern = r'@([\w\u4e00-\u9fff\u3400-\u4dbf]+)'
    matches = re.findall(pattern, text)
    return [m.strip() for m in matches if m.strip()]


# Initialize on module load
_load_group_chat_map()
