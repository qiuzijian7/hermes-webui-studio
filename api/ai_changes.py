"""
Hermes Web UI -- AI file change tracker.

Records each file modification made by AI agent tools (write_file, patch,
write_to_file, edit_file) per session.  Each change stores the original
file content so the user can review the diff and accept or reject it.

Storage: one JSON file per session at {STATE_DIR}/ai_changes/{session_id}.json
"""

import difflib
import json
import threading
import time
import uuid
from pathlib import Path
from typing import Optional

from api.config import STATE_DIR

# ── Storage path ──────────────────────────────────────────────────────────────
_CHANGES_DIR = STATE_DIR / "ai_changes"
_changes_lock = threading.Lock()


def _ensure_dir():
    _CHANGES_DIR.mkdir(parents=True, exist_ok=True)


def _changes_path(session_id: str) -> Path:
    return _CHANGES_DIR / f"{session_id}.json"


# ── Write-tool names that modify files ────────────────────────────────────────
_WRITE_TOOL_NAMES = frozenset({
    "write_file", "write_to_file", "patch", "edit_file",
})


# ── In-memory buffer for original content captured at tool.started ─────────────
# Key: (session_id, tc_id) → {path, original_content}
_orig_buffer: dict[tuple, dict] = {}
_orig_buffer_lock = threading.Lock()


def capture_original(session_id: str, tc_id: str, workspace: str,
                     tool_name: str, tool_args: dict):
    """
    Called when a file-writing tool STARTS (tool.started phase).
    Reads the current file content as the "original" before the AI writes.
    """
    if tool_name not in _WRITE_TOOL_NAMES:
        return
    file_path = _extract_path(tool_args)
    if not file_path:
        return

    # Resolve to absolute path
    ws = Path(workspace)
    abs_path = ws / file_path if not Path(file_path).is_absolute() else Path(file_path)
    try:
        abs_path = abs_path.resolve()
    except (OSError, ValueError):
        return

    original_content = ""
    try:
        if abs_path.exists() and abs_path.is_file():
            raw = abs_path.read_bytes()
            # Skip binary files
            if b'\x00' in raw[:8192]:
                return
            original_content = raw.decode("utf-8", errors="replace")
    except (OSError, PermissionError):
        pass

    with _orig_buffer_lock:
        _orig_buffer[(session_id, tc_id)] = {
            "path": file_path,
            "original_content": original_content,
            "workspace": workspace,
        }


def record_change(session_id: str, tc_id: str, tool_name: str,
                  tool_args: dict, tool_result: str = ""):
    """
    Called when a file-writing tool COMPLETES (on_tool_complete callback).
    Records the AI change entry with original content + diff metadata.
    """
    if tool_name not in _WRITE_TOOL_NAMES:
        return

    # Pop the original content captured at tool.started
    with _orig_buffer_lock:
        buf = _orig_buffer.pop((session_id, tc_id), None)

    file_path = _extract_path(tool_args)
    if not file_path:
        # Try to get path from buffer
        if buf:
            file_path = buf.get("path", "")
        if not file_path:
            return

    workspace = ""
    original_content = ""
    if buf:
        workspace = buf.get("workspace", "")
        original_content = buf.get("original_content", "")

    # Read the new (post-write) content
    ws = Path(workspace) if workspace else None
    if ws:
        abs_path = ws / file_path if not Path(file_path).is_absolute() else Path(file_path)
        try:
            abs_path = abs_path.resolve()
        except (OSError, ValueError):
            return
    else:
        return

    new_content = ""
    try:
        if abs_path.exists() and abs_path.is_file():
            raw = abs_path.read_bytes()
            if b'\x00' in raw[:8192]:
                return  # binary
            new_content = raw.decode("utf-8", errors="replace")
    except (OSError, PermissionError):
        return

    # Skip if content unchanged (shouldn't happen but safety check)
    if original_content == new_content:
        return

    # Compute unified diff
    diff_text = _unified_diff(original_content, new_content, file_path)

    # Count additions and deletions
    additions = 0
    deletions = 0
    for line in diff_text.splitlines():
        if line.startswith('+') and not line.startswith('+++'):
            additions += 1
        elif line.startswith('-') and not line.startswith('---'):
            deletions += 1

    # Create change entry
    change_entry = {
        "id": uuid.uuid4().hex[:10],
        "path": file_path,
        "tool_name": tool_name,
        "additions": additions,
        "deletions": deletions,
        "diff": diff_text,
        "original_content": original_content,
        "new_content": new_content,
        "timestamp": time.time(),
        "accepted": False,
    }

    # Append to session's change store
    with _changes_lock:
        _ensure_dir()
        cp = _changes_path(session_id)
        changes = []
        if cp.exists():
            try:
                changes = json.loads(cp.read_text(encoding="utf-8"))
                if not isinstance(changes, list):
                    changes = []
            except (json.JSONDecodeError, OSError):
                changes = []
        changes.append(change_entry)
        cp.write_text(json.dumps(changes, ensure_ascii=False), encoding="utf-8")

    return change_entry


def get_changes(session_id: str, accepted: Optional[bool] = None) -> list:
    """Get AI change entries for a session. Optionally filter by accepted status."""
    with _changes_lock:
        cp = _changes_path(session_id)
        if not cp.exists():
            return []
        try:
            changes = json.loads(cp.read_text(encoding="utf-8"))
            if not isinstance(changes, list):
                return []
        except (json.JSONDecodeError, OSError):
            return []

    if accepted is not None:
        changes = [c for c in changes if c.get("accepted") == accepted]

    return changes


def get_changes_summary(session_id: str) -> dict:
    """
    Return a summary of AI changes for a session, grouped by file path.
    Each file entry has: path, count (number of AI modifications),
    total_additions, total_deletions, pending (not yet accepted).
    """
    changes = get_changes(session_id)
    file_map: dict[str, dict] = {}
    for c in changes:
        p = c.get("path", "")
        if p not in file_map:
            file_map[p] = {
                "path": p,
                "count": 0,
                "additions": 0,
                "deletions": 0,
                "pending": 0,
                "accepted": 0,
                "latest_timestamp": 0,
                "changes": [],
            }
        entry = file_map[p]
        entry["count"] += 1
        entry["additions"] += c.get("additions", 0)
        entry["deletions"] += c.get("deletions", 0)
        if c.get("accepted"):
            entry["accepted"] += 1
        else:
            entry["pending"] += 1
        entry["latest_timestamp"] = max(entry["latest_timestamp"], c.get("timestamp", 0))
        # Include change metadata (without full content for summary)
        entry["changes"].append({
            "id": c.get("id"),
            "tool_name": c.get("tool_name"),
            "additions": c.get("additions", 0),
            "deletions": c.get("deletions", 0),
            "timestamp": c.get("timestamp"),
            "accepted": c.get("accepted", False),
        })

    # Sort by latest timestamp descending
    files = sorted(file_map.values(), key=lambda x: x["latest_timestamp"], reverse=True)
    total_pending = sum(f["pending"] for f in files)
    return {
        "files": files,
        "total_pending": total_pending,
    }


def accept_change(session_id: str, change_id: str) -> bool:
    """Mark a specific AI change as accepted."""
    with _changes_lock:
        cp = _changes_path(session_id)
        if not cp.exists():
            return False
        try:
            changes = json.loads(cp.read_text(encoding="utf-8"))
        except (json.JSONDecodeError, OSError):
            return False

        found = False
        for c in changes:
            if c.get("id") == change_id:
                c["accepted"] = True
                found = True
                break

        if found:
            cp.write_text(json.dumps(changes, ensure_ascii=False), encoding="utf-8")
        return found


def accept_file_changes(session_id: str, file_path: str) -> int:
    """Accept all pending changes for a specific file. Returns count accepted."""
    with _changes_lock:
        cp = _changes_path(session_id)
        if not cp.exists():
            return 0
        try:
            changes = json.loads(cp.read_text(encoding="utf-8"))
        except (json.JSONDecodeError, OSError):
            return 0

        count = 0
        for c in changes:
            if c.get("path") == file_path and not c.get("accepted"):
                c["accepted"] = True
                count += 1

        if count:
            cp.write_text(json.dumps(changes, ensure_ascii=False), encoding="utf-8")
        return count


def accept_all_changes(session_id: str) -> int:
    """Accept all pending changes for a session. Returns count accepted."""
    with _changes_lock:
        cp = _changes_path(session_id)
        if not cp.exists():
            return 0
        try:
            changes = json.loads(cp.read_text(encoding="utf-8"))
        except (json.JSONDecodeError, OSError):
            return 0

        count = 0
        for c in changes:
            if not c.get("accepted"):
                c["accepted"] = True
                count += 1

        if count:
            cp.write_text(json.dumps(changes, ensure_ascii=False), encoding="utf-8")
        return count


def reject_change(session_id: str, change_id: str, workspace: str) -> bool:
    """
    Reject a change: revert the file to the original content of this change
    and remove the change entry.  Returns True if successful.
    """
    with _changes_lock:
        cp = _changes_path(session_id)
        if not cp.exists():
            return False
        try:
            changes = json.loads(cp.read_text(encoding="utf-8"))
        except (json.JSONDecodeError, OSError):
            return False

        target = None
        for c in changes:
            if c.get("id") == change_id:
                target = c
                break

        if not target:
            return False

        # Revert file to original content
        original = target.get("original_content", "")
        file_path = target.get("path", "")
        if file_path and workspace:
            abs_path = Path(workspace) / file_path if not Path(file_path).is_absolute() else Path(file_path)
            try:
                abs_path = abs_path.resolve()
            except (OSError, ValueError):
                return False
            try:
                abs_path.parent.mkdir(parents=True, exist_ok=True)
                abs_path.write_text(original, encoding="utf-8")
            except (OSError, PermissionError):
                return False

        # Remove the change entry
        changes = [c for c in changes if c.get("id") != change_id]
        cp.write_text(json.dumps(changes, ensure_ascii=False), encoding="utf-8")
        return True


def get_change_diff(session_id: str, change_id: str) -> Optional[dict]:
    """Get a single change entry with full diff content."""
    changes = get_changes(session_id)
    for c in changes:
        if c.get("id") == change_id:
            return c
    return None


def get_file_diff(session_id: str, file_path: str) -> Optional[str]:
    """
    Get the cumulative diff for a file across all pending (unaccepted) AI changes.
    This combines all unaccepted changes for the file into a single diff.
    """
    changes = get_changes(session_id, accepted=False)
    file_changes = [c for c in changes if c.get("path") == file_path]
    if not file_changes:
        return None

    # If there's only one change, return its diff directly
    if len(file_changes) == 1:
        return file_changes[0].get("diff", "")

    # Multiple changes: compute diff from earliest original to latest new
    # Sort by timestamp ascending
    file_changes.sort(key=lambda c: c.get("timestamp", 0))
    original = file_changes[0].get("original_content", "")
    new = file_changes[-1].get("new_content", "")
    return _unified_diff(original, new, file_path)


# ── Helpers ───────────────────────────────────────────────────────────────────

def _extract_path(tool_args: dict) -> str:
    """Extract file path from tool arguments."""
    if not isinstance(tool_args, dict):
        return ""
    # Common key names across different tool implementations
    for key in ("path", "file_path", "filename", "filePath"):
        val = tool_args.get(key, "")
        if isinstance(val, str) and val.strip():
            return val.strip()
    return ""


def _unified_diff(original: str, new: str, path: str) -> str:
    """Generate unified diff between original and new content."""
    orig_lines = original.splitlines(keepends=True)
    new_lines = new.splitlines(keepends=True)
    diff = difflib.unified_diff(
        orig_lines, new_lines,
        fromfile=f"a/{path}", tofile=f"b/{path}",
        lineterm="",
    )
    return "\n".join(diff)
