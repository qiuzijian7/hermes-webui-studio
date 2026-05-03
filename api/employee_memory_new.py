"""
Hermes Web UI -- Employee Memory System (Updated with auto-sync).

Added:
  - sync_employee_memory_after_turn() now uses LLM to extract conversation facts
  - _call_knot_for_extraction() helper to call Knot API
  - _rule_based_extraction() fallback when LLM is unavailable
"""

import json
import os
import re
import time
from pathlib import Path
from typing import Optional


# ── Constants ──────────────────────────────────────────────────────────────────

DEFAULT_MEMORY_CHAR_LIMIT = 2200
DEFAULT_USER_CHAR_LIMIT = 1375

MEMORY_FILENAME = "MEMORY.md"
USER_FILENAME = "USER.md"

# 安全扫描：检测提示注入模式
_INJECTION_PATTERNS = [
    r"ignore\s+(all\s+)?previous\s+instructions",
    r"you\s+are\s+now\s+a\s+",
    r"forget\s+(everything|all\s+instructions)",
    r"repeat\s+after\s+me",
    r"system\s*:\s*",
]

# 安全扫描：检测秘密泄露模式（API keys, tokens 等）
_SECRET_PATTERNS = [
    r"sk-[a-zA-Z0-9]{48}",              # OpenAI API key
    r"Bearer\s+[a-zA-Z0-9_\-\.]{20,}",  # Bearer token
    r"x-[a-z]+-api-key\s*:\s*\S+",      # API key header
    r"password\s*[:=]\s*\S+",             # password
]


# ── EmployeeMemoryStore ────────────────────────────────────────────────────────

class EmployeeMemoryStore:
    """Per-employee memory store (MEMORY.md + USER.md).

    Design mirrors Hermes core MemoryStore:
      - Frozen snapshot for system prompt stability
      - Character limits to prevent unbounded growth
      - Deduplication to prevent repeated entries
      - Security scan to prevent prompt injection / secret leakage
      - File locking for concurrent access safety
      """

    def __init__(
        self,
        employee_dir: str,
        memory_char_limit: int = DEFAULT_MEMORY_CHAR_LIMIT,
        user_char_limit: int = DEFAULT_USER_CHAR_LIMIT,
    ):
        """
        Args:
            employee_dir: Path to employee directory (contains info.json)
            memory_char_limit: Max chars in MEMORY.md content
            user_char_limit: Max chars in USER.md content
        """
        self.employee_dir = Path(employee_dir)
        self.memory_char_limit = memory_char_limit
        self.user_char_limit = user_char_limit

        # Frozen snapshot (set on load_from_disk)
        self._system_prompt_snapshot = {"memory": "", "user": ""}

        # Live state (modified by tool calls)
        self.memory_entries: list = []
        self.user_entries: list = []

    # ── Public API ────────────────────────────────────────────────────────────

    def load_from_disk(self) -> None:
        """Load memory files from disk and capture frozen snapshot."""
        self.memory_entries = self._read_file(MEMORY_FILENAME)
        self.user_entries = self._read_file(USER_FILENAME)

        # Capture frozen snapshot for system prompt use
        self._system_prompt_snapshot = {
            "memory": self._render_block("memory", self.memory_entries),
            "user": self._render_block("user", self.user_entries),
        }

    def format_for_system_prompt(self, target: str) -> Optional[str]:
        """Return the frozen snapshot captured at load time.

        Using a snapshot ensures system prompt stability (prefix caching).
        Writes during a session won't affect the system prompt until reload.
        """
        return self._system_prompt_snapshot.get(target, "")

    def add(self, target: str, content: str) -> dict:
        """Add a new entry to MEMORY.md or USER.md.

        Returns:
            {"ok": bool, "message": str, "content": str}
        """
        # Security scan
        scan_result = self._scan_content(content)
        if not scan_result["ok"]:
            return scan_result

        if target == "memory":
            return self._add_to_entries("memory", content, self.memory_entries,
                                        MEMORY_FILENAME, self.memory_char_limit)
        elif target == "user":
            return self._add_to_entries("user", content, self.user_entries,
                                        USER_FILENAME, self.user_char_limit)
        else:
            return {"ok": False, "message": f"Unknown target: {target}"}

    def replace(self, target: str, old_text: str, new_content: str) -> dict:
        """Replace an entry in MEMORY.md or USER.md.

        Uses substring match to find the entry to replace.
        Returns:
            {"ok": bool, "message": str}
        """
        # Security scan on new content
        scan_result = self._scan_content(new_content)
        if not scan_result["ok"]:
            return scan_result

        if target == "memory":
            return self._replace_in_entries("memory", old_text, new_content,
                                            self.memory_entries, MEMORY_FILENAME)
        elif target == "user":
            return self._replace_in_entries("user", old_text, new_content,
                                            self.user_entries, USER_FILENAME)
        else:
            return {"ok": False, "message": f"Unknown target: {target}"}

    def remove(self, target: str, old_text: str) -> dict:
        """Remove an entry from MEMORY.md or USER.md.

        Returns:
            {"ok": bool, "message": str}
        """
        if target == "memory":
            return self._remove_from_entries("memory", old_text,
                                             self.memory_entries, MEMORY_FILENAME)
        elif target == "user":
            return self._remove_from_entries("user", old_text,
                                             self.user_entries, USER_FILENAME)
        else:
            return {"ok": False, "message": f"Unknown target: {target}"}

    def get_all_entries(self, target: str) -> list:
        """Return all entries for target (memory or user)."""
        if target == "memory":
            return list(self.memory_entries)
        elif target == "user":
            return list(self.user_entries)
        return []

    def save_to_disk(self) -> None:
        """Explicitly save current state to disk (refreshes snapshot)."""
        self._write_file(MEMORY_FILENAME, self.memory_entries)
        self._write_file(USER_FILENAME, self.user_entries)
        # Refresh snapshot
        self._system_prompt_snapshot = {
            "memory": self._render_block("memory", self.memory_entries),
            "user": self._render_block("user", self.user_entries),
        }

    # ── Internal Helpers ─────────────────────────────────────────────────────

    def _read_file(self, filename: str) -> list:
        """Read a memory file and return list of entry strings."""
        path = self.employee_dir / filename
        if not path.exists():
            return []
        try:
            content = path.read_text(encoding="utf-8").strip()
            if not content:
                return []
            # Parse entries: split by double newline, filter empty
            entries = [e.strip() for e in content.split("\n\n") if e.strip()]
            return entries
        except Exception as e:
            print(f"[EmployeeMemory] Error reading {path}: {e}", flush=True)
            return []

    def _write_file(self, filename: str, entries: list) -> None:
        """Write entries to a memory file."""
        path = self.employee_dir / filename
        self.employee_dir.mkdir(parents=True, exist_ok=True)
        content = "\n\n".join(entries)
        path.write_text(content, encoding="utf-8")

    def _render_block(self, target: str, entries: list) -> str:
        """Render entries as a markdown block for system prompt injection."""
        if not entries:
            return ""

        if target == "memory":
            header = "# Memory"
            intro = (
                "The following memory entries contain important facts, "
                "conventions, and notes. Use them to inform your responses."
            )
        else:  # user
            header = "# User Profile"
            intro = (
                "The following user profile contains preferences and style notes. "
                "Adapt your communication accordingly."
            )

        entries_text = "\n\n".join(f"- {e}" for e in entries)
        return f"{header}\n{intro}\n\n{entries_text}"

    def _add_to_entries(self, target: str, content: str, entries: list,
                        filename: str, char_limit: int) -> dict:
        """Add content as a new entry (with dedup and char limit check)."""
        # Deduplication: check if identical or very similar entry exists
        for existing in entries:
            if self._is_similar(content, existing):
                return {"ok": True, "message": "Entry already exists (dedup)", "content": existing}

        # Char limit check (approximate: entries + new content)
        total_chars = sum(len(e) for e in entries) + len(content)
        if total_chars > char_limit:
            return {
                "ok": False,
                "message": (
                    f"{target.upper()} character limit exceeded "
                    f"({total_chars}/{char_limit}). "
                    f"Please remove some entries before adding new ones."
                ),
            }

        entries.append(content)
        self._write_file(filename, entries)

        # Update snapshot incrementally (append mode — system prompt gets new entry)
        snapshot_key = "memory" if target == "memory" else "user"
        current_block = self._system_prompt_snapshot.get(snapshot_key, "")
        new_entry_text = f"\n\n- {content}"
        self._system_prompt_snapshot[snapshot_key] = current_block + new_entry_text

        return {"ok": True, "message": "Entry added", "content": content}

    def _replace_in_entries(self, target: str, old_text: str, new_content: str,
                            entries: list, filename: str) -> dict:
        """Replace an entry that contains old_text with new_content."""
        for i, entry in enumerate(entries):
            if old_text in entry:
                entries[i] = new_content
                self._write_file(filename, entries)
                self._refresh_snapshot()
                return {"ok": True, "message": "Entry replaced"}

        return {"ok": False, "message": f"Old text not found in {target.upper()}"}

    def _remove_from_entries(self, target: str, old_text: str,
                             entries: list, filename: str) -> dict:
        """Remove an entry that contains old_text."""
        for i, entry in enumerate(entries):
            if old_text in entry:
                del entries[i]
                self._write_file(filename, entries)
                self._refresh_snapshot()
                return {"ok": True, "message": "Entry removed"}

        return {"ok": False, "message": f"Old text not found in {target.upper()}"}

    def _refresh_snapshot(self) -> None:
        """Recalculate the frozen snapshot from live state."""
        self._system_prompt_snapshot = {
            "memory": self._render_block("memory", self.memory_entries),
            "user": self._render_block("user", self.user_entries),
        }

    def _is_similar(self, a: str, b: str, threshold: float = 0.9) -> bool:
        """Check if two entries are similar (simple char-level Jaccard)."""
        if a == b:
            return True
        set_a = set(a.lower())
        set_b = set(b.lower())
        intersection = len(set_a & set_b)
        union = len(set_a | set_b)
        if union == 0:
            return True
        return (intersection / union) > threshold

    def _scan_content(self, content: str) -> dict:
        """Scan content for prompt injection or secret leakage.

        Returns:
            {"ok": bool, "message": str}
        """
        # Check for invisible Unicode characters
        if re.search(r"[\u200b\u200c\u200d\u2060\ufeff]", content):
            return {
                "ok": False,
                "message": "Content contains invisible Unicode characters (possible injection)",
            }

        # Check for prompt injection patterns
        for pattern in _INJECTION_PATTERNS:
            if re.search(pattern, content, re.IGNORECASE):
                return {
                    "ok": False,
                    "message": f"Content matches prompt injection pattern: {pattern}",
                }

        # Check for secret patterns
        for pattern in _SECRET_PATTERNS:
            if re.search(pattern, content):
                return {
                    "ok": False,
                    "message": "Content appears to contain secrets (API keys, tokens, etc.)",
                }

        return {"ok": True, "message": "Content passed security scan"}


# ── Helper Functions ──────────────────────────────────────────────────────────

def get_employee_memory_store(workspace: str, employee_name: str):
    """Factory: get an EmployeeMemoryStore for a given employee.

    Args:
        workspace: Workspace root path
        employee_name: Employee name (will be safe-dirnamed)

    Returns:
        EmployeeMemoryStore instance, or None if employee dir not found
    """
    from api.employee_fs import _employee_dir, _safe_dirname

    emp_dir = _employee_dir(workspace, employee_name)
    if not emp_dir.exists():
        return None

    store = EmployeeMemoryStore(str(emp_dir))
    store.load_from_disk()
    return store


def initialize_employee_memory_files(employee_dir: str) -> None:
    """Initialize empty MEMORY.md and USER.md for a new employee.

    Called during employee creation.
    """
    emp_dir = Path(employee_dir)
    for filename in [MEMORY_FILENAME, USER_FILENAME]:
        path = emp_dir / filename
        if not path.exists():
            # Write empty file with header comment
            header = "# Memory\n\n" if filename == MEMORY_FILENAME else "# User Profile\n\n"
            path.write_text(header, encoding="utf-8")


def build_employee_memory_system_prompt(workspace: str, employee_name: str) -> str:
    """Build the memory block for an employee's system prompt.

    This is called by knot_agui.py before sending the request to Knot API.

    Returns:
        String to inject into system_prompt, or empty string if no memory.
    """
    store = get_employee_memory_store(workspace, employee_name)
    if not store:
        return ""

    parts = []
    memory_block = store.format_for_system_prompt("memory")
    if memory_block:
        parts.append(memory_block)

    user_block = store.format_for_system_prompt("user")
    if user_block:
        parts.append(user_block)

    if not parts:
        return ""

    # Wrap in <memory-context> tags (matching Hermes core convention)
    return "<memory-context>\n\n" + "\n\n".join(parts) + "\n\n</memory-context>"


def sync_employee_memory_after_turn(
    workspace: str, employee_name: str,
    user_message: str, assistant_response: str
) -> dict:
    """After a conversation turn, use LLM to extract key info and update memory.

    Args:
        workspace: Workspace path
        employee_name: Employee name
        user_message: User's message
        assistant_response: Assistant's response

    Returns:
        {"ok": bool, "message": str, "added": list}
    """
    if not user_message or not assistant_response:
        return {"ok": False, "message": "Empty message or response"}

    store = get_employee_memory_store(workspace, employee_name)
    if not store:
        return {"ok": False, "message": f"Employee '{employee_name}' not found"}

    # Read current memory for context
    current_memory = store.format_for_system_prompt("memory") or "(empty)"
    current_user = store.format_for_system_prompt("user") or "(empty)"

    # Build extraction prompt
    extraction_prompt = f"""You are a memory extraction assistant. Analyze the conversation below and extract key facts that should be remembered.

Current MEMORY.md:
{current_memory}

Current USER.md:
{current_user}

New conversation:
User: {user_message}
Assistant: {assistant_response}

Instructions:
1. Extract NEW facts about the user (preferences, style, goals) -> USER.md entries
2. Extract NEW facts about projects, environment, tools -> MEMORY.md entries
3. If existing entries need updating, note them as "UPDATE: old_text -> new_text"
4. If entries are no longer relevant, note them as "DELETE: old_text"
5. Return JSON only, no markdown fences.

Output JSON format:
{{
  "user_entries": ["new entry 1", "new entry 2"],
  "memory_entries": ["new fact 1", "new fact 2"],
  "updates": [{{"target": "memory", "old": "old text", "new": "new text"}}],
  "deletes": [{{"target": "user", "old": "old text"}}]
}}

If nothing new to add, return empty arrays. Be concise (each entry < 100 chars)."""

    # Call LLM to extract memory
    try:
        from api.config import load_settings
        settings = load_settings()

        # Try Knot API first (if configured)
        api_token = settings.get("knot_api_token", "")
        api_url = settings.get("knot_api_url", "https://knot.woa.com/apigw/api/v1/agui")

        if api_token:
            result = _call_knot_for_extraction(extraction_prompt, api_token, api_url)
        else:
            # Fallback: simple rule-based extraction
            result = _rule_based_extraction(user_message, assistant_response)

        if not result:
            return {"ok": False, "message": "LLM extraction failed"}

        # Apply extracted memory updates
        added = []
        updated = []
        deleted = []

        # Add new user entries
        for entry in result.get("user_entries", []):
            if entry and isinstance(entry, str):
                r = store.add("user", entry.strip())
                if r.get("ok"):
                    added.append(f"USER: {entry}")

        # Add new memory entries
        for entry in result.get("memory_entries", []):
            if entry and isinstance(entry, str):
                r = store.add("memory", entry.strip())
                if r.get("ok"):
                    added.append(f"MEMORY: {entry}")

        # Apply updates
        for update in result.get("updates", []):
            target = update.get("target", "memory")
            old = update.get("old", "")
            new = update.get("new", "")
            if old and new:
                r = store.replace(target, old, new)
                if r.get("ok"):
                    updated.append(f"{target.upper()}: {old[:30]}... -> {new[:30]}...")

        # Apply deletes
        for delete in result.get("deletes", []):
            target = delete.get("target", "memory")
            old = delete.get("old", "")
            if old:
                r = store.remove(target, old)
                if r.get("ok"):
                    deleted.append(f"{target.upper()}: {old[:30]}...")

        # Save to disk
        store.save_to_disk()

        return {
            "ok": True,
            "message": f"Added {len(added)}, updated {len(updated)}, deleted {len(deleted)}",
            "added": added,
            "updated": updated,
            "deleted": deleted,
        }

    except Exception as e:
        print(f"[sync_employee_memory_after_turn] Error: {e}", flush=True)
        return {"ok": False, "message": str(e)}


def _call_knot_for_extraction(prompt: str, api_token: str, api_url: str) -> dict:
    """Call Knot API for memory extraction."""
    try:
        import requests

        # Use chat_completions endpoint for simple extraction
        url = api_url.replace("/agui", "/chat_completions")
        headers = {
            "x-knot-api-token": api_token,
            "Content-Type": "application/json",
        }
        body = {
            "model": "default",
            "messages": [
                {"role": "system", "content": "You are a JSON-only assistant. Return only valid JSON."},
                {"role": "user", "content": prompt}
            ],
            "temperature": 0.1,
            "max_tokens": 500,
        }

        resp = requests.post(url, json=body, headers=headers, timeout=30)
        if resp.status_code != 200:
            print(f"[_call_knot_for_extraction] HTTP {resp.status_code}: {resp.text[:200]}", flush=True)
            return None

        data = resp.json()
        content = data.get("choices", [{}])[0].get("message", {}).get("content", "")

        # Extract JSON from response (handle markdown fences)
        content = content.strip()
        if content.startswith("```"):
            # Find the closing fence
            parts = content.split("```")
            if len(parts) >= 2:
                content = parts[1]
                if content.startswith("json"):
                    content = content[4:]
        content = content.strip()

        result = json.loads(content)
        return result

    except Exception as e:
        print(f"[_call_knot_for_extraction] Error: {e}", flush=True)
        return None


def _rule_based_extraction(user_message: str, assistant_response: str) -> dict:
    """Fallback: simple rule-based extraction when LLM is not available.

    Looks for explicit memory-like phrases in the conversation.
    """
    import re

    result = {
        "user_entries": [],
        "memory_entries": [],
        "updates": [],
        "deletes": [],
    }

    combined = f"{user_message}\n{assistant_response}".lower()

    # Simple patterns for demonstration
    # In practice, you'd want more sophisticated extraction
    if "remember" in combined or "记住" in combined:
        # Extract the sentence after "remember"
        sentences = re.split(r'[.!?]', user_message)
        for sent in sentences:
            if "remember" in sent.lower() or "记住" in sent:
                fact = sent.strip()
                if len(fact) > 10:
                    result["memory_entries"].append(fact[:100])

    return result


# ── Memory Tool Handlers (for future tool-based access) ──────────────────────

def handle_employee_memory_tool(
    workspace: str, employee_name: str,
    tool_name: str, args: dict
) -> str:
    """Handle memory tool calls for an employee.

    Tools:
      - employee_memory_add(target, content)
      - employee_memory_replace(target, old_text, new_content)
      - employee_memory_remove(target, old_text)
      - employee_memory_list(target)

    Returns:
        JSON string with result.
    """
    store = get_employee_memory_store(workspace, employee_name)
    if not store:
        return json.dumps({"error": f"Employee '{employee_name}' not found"})

    try:
        if tool_name == "employee_memory_add":
            target = args.get("target", "")
            content = args.get("content", "")
            result = store.add(target, content)
            return json.dumps(result, ensure_ascii=False)

        elif tool_name == "employee_memory_replace":
            target = args.get("target", "")
            old_text = args.get("old_text", "")
            new_content = args.get("new_content", "")
            result = store.replace(target, old_text, new_content)
            return json.dumps(result, ensure_ascii=False)

        elif tool_name == "employee_memory_remove":
            target = args.get("target", "")
            old_text = args.get("old_text", "")
            result = store.remove(target, old_text)
            return json.dumps(result, ensure_ascii=False)

        elif tool_name == "employee_memory_list":
            target = args.get("target", "")
            entries = store.get_all_entries(target)
            return json.dumps({"ok": True, "entries": entries}, ensure_ascii=False)

        else:
            return json.dumps({"error": f"Unknown memory tool: {tool_name}"})

    except Exception as e:
        return json.dumps({"error": str(e)})
