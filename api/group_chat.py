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
                      task_id: str = None) -> dict:
    """Add a message to the group chat.

    Args:
        workspace: The workspace path
        role: 'user' | 'assistant' | 'system'
        content: Message text
        sender_name: Name of the sender (for display)
        mentions: List of employee names mentioned (@name)
        task_id: Optional task ID for tracking delegated tasks

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

    s.messages.append(msg)
    s.updated_at = time.time()
    s.save()

    return msg


def post_task_result(workspace: str, employee_name: str, task_id: str,
                     result: str, requester_name: str = None) -> dict:
    """Post a task result back to the group chat.

    The result message mentions the original requester.
    """
    mention_str = f"@{requester_name}" if requester_name else ""
    content = f"**{employee_name}** 完成了任务：\n\n{result}"
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
