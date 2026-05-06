"""
Hermes Web UI -- Teams Filesystem Storage.

Each team is stored as an independent JSON file under
``<workspace>/teams/<team_id>.json`` with the following schema::

    {
        "id": "team-1",
        "name": "团队名",
        "description": "团队描述",
        "leadId": null,
        "memberIds": [],
        "color": "#3B82F6",
        "icon": "🏢",
        "createdAt": 1714000000000,
        "updatedAt": 1714000000000,
        "hubId": null,        // 从哪个 Hub 模板导入
        "hubVersion": null,   // 导入时的 Hub 模板版本号
    }
"""
import json
import os
import time
from pathlib import Path
from typing import Optional, List, Dict, Any

# ── Constants ────────────────────────────────────────────────────────────────

TEAMS_DIR_NAME = "teams"
INFO_FILENAME = "info.json"  # Each team is a single JSON file

# Fields stored in team JSON
_TEAM_FIELDS = [
    "id", "name", "description", "leadId", "memberIds",
    "color", "icon",
    "createdAt", "updatedAt",
    # Hub 模板跟踪
    "hubId", "hubVersion",
]


# ── Helpers ──────────────────────────────────────────────────────────────────

def _teams_root(workspace: str) -> Path:
    """Return the teams directory for a workspace."""
    return Path(workspace) / TEAMS_DIR_NAME


def _team_file_path(workspace: str, team_id: str) -> Path:
    """Return the full path to a team's JSON file."""
    return _teams_root(workspace) / f"{team_id}.json"


# ── CRUD Operations ─────────────────────────────────────────────────────────

def list_teams(workspace: str) -> List[Dict[str, Any]]:
    """List all teams in a workspace."""
    root = _teams_root(workspace)
    if not root.is_dir():
        return []

    teams = []
    for f in sorted(root.iterdir()):
        if not f.is_file() or f.suffix != ".json":
            continue
        try:
            data = json.loads(f.read_text(encoding="utf-8"))
            if isinstance(data, dict) and "id" in data:
                teams.append(data)
        except Exception:
            continue
    return teams


def get_team(workspace: str, team_id: str) -> Optional[Dict[str, Any]]:
    """Get a single team by ID."""
    file_path = _team_file_path(workspace, team_id)
    if not file_path.is_file():
        return None
    try:
        return json.loads(file_path.read_text(encoding="utf-8"))
    except Exception:
        return None


def create_team(workspace: str, data: Dict[str, Any]) -> Dict[str, Any]:
    """Create a new team."""
    name = (data.get("name") or "").strip()
    if not name:
        raise ValueError("Team name is required")

    root = _teams_root(workspace)
    root.mkdir(parents=True, exist_ok=True)

    # Generate ID if not provided
    team_id = data.get("id") or f"team-{int(time.time() * 1000)}"
    now = int(time.time() * 1000)

    team = {
        "id": team_id,
        "name": name,
        "description": data.get("description", ""),
        "leadId": data.get("leadId"),
        "memberIds": data.get("memberIds", []),
        "color": data.get("color", "#3B82F6"),
        "icon": data.get("icon", "🏢"),
        "createdAt": data.get("createdAt", now),
        "updatedAt": data.get("updatedAt", now),
        "hubId": data.get("hubId"),
        "hubVersion": data.get("hubVersion"),
    }

    file_path = _team_file_path(workspace, team_id)
    file_path.write_text(
        json.dumps(team, ensure_ascii=False, indent=2),
        encoding="utf-8"
    )
    return team


def update_team(workspace: str, team_id: str, updates: Dict[str, Any]) -> Optional[Dict[str, Any]]:
    """Update an existing team."""
    file_path = _team_file_path(workspace, team_id)
    if not file_path.is_file():
        return None

    try:
        team = json.loads(file_path.read_text(encoding="utf-8"))
    except Exception:
        return None

    # Apply updates
    for key in updates:
        if key in ("id", "createdAt"):
            continue  # Don't update id or createdAt
        if key in _TEAM_FIELDS:
            team[key] = updates[key]

    team["updatedAt"] = int(time.time() * 1000)

    file_path.write_text(
        json.dumps(team, ensure_ascii=False, indent=2),
        encoding="utf-8"
    )
    return team


def delete_team(workspace: str, team_id: str) -> bool:
    """Delete a team."""
    file_path = _team_file_path(workspace, team_id)
    if not file_path.is_file():
        return False
    try:
        file_path.unlink()
        return True
    except Exception:
        return False


def save_all_teams(workspace: str, teams: List[Dict[str, Any]]) -> Dict[str, Any]:
    """Batch save all teams (used for migration from localStorage)."""
    root = _teams_root(workspace)
    root.mkdir(parents=True, exist_ok=True)

    saved = 0
    for team_data in teams:
        if not isinstance(team_data, dict) or not team_data.get("id"):
            continue
        try:
            team_id = team_data["id"]
            file_path = _team_file_path(workspace, team_id)
            file_path.write_text(
                json.dumps(team_data, ensure_ascii=False, indent=2),
                encoding="utf-8"
            )
            saved += 1
        except Exception:
            continue

    return {"saved": saved}
