"""
Hermes Web UI -- Workspace Manager.

Manages the centralized ``workspaces/`` directory where each workspace is
instantiated with its own employees, scripts, experience, skills, and config.

Directory structure per workspace::

    workspaces/<workspace_slug>/
    ├── info.json              # Workspace metadata
    ├── employee_ins/          # Instantiated employees (from templates)
    │   ├── _next_id.json
    │   └── <employee_name>/
    │       ├── info.json
    │       └── index.html
    ├── scripts/               # PM specialist scripts
    ├── experience/            # PM specialist error notes
    ├── skills/                # PM specialist skills
    ├── Intermediate/          # Generated temp files
    └── connections.json       # Employee connection graph

A workspace export = a "team" that can be imported elsewhere.
"""
import json
import os
import re
import shutil
import time
from pathlib import Path
from typing import Optional

from api.config import REPO_ROOT

# ── Paths ────────────────────────────────────────────────────────────────────

WORKSPACES_DIR = REPO_ROOT / "workspaces"
REGISTRY_FILE = WORKSPACES_DIR / "_registry.json"

# Subdirectories created for each workspace
WORKSPACE_SUBDIRS = [
    "employee_ins",
    "scripts",
    "experience",
    "skills",
    "Intermediate",
]

INFO_VERSION = 1


# ── Helpers ──────────────────────────────────────────────────────────────────

def _safe_slug(name: str) -> str:
    """Convert a workspace name to a filesystem-safe slug.

    - Strips whitespace
    - Replaces path-unsafe chars with '_'
    - Truncates to 128 chars
    """
    s = (name or "").strip()
    if not s:
        return "unnamed"
    s = re.sub(r'[<>:"/\\|?*\x00-\x1f]', '_', s)
    s = s.strip('. ')
    return s[:128] or "unnamed"


def _workspace_dir(name: str) -> Path:
    """Return the directory for a workspace by name/slug."""
    return WORKSPACES_DIR / _safe_slug(name)


# ── Registry ─────────────────────────────────────────────────────────────────

def load_registry() -> dict:
    """Load the workspace registry."""
    if REGISTRY_FILE.exists():
        try:
            data = json.loads(REGISTRY_FILE.read_text(encoding="utf-8"))
            if isinstance(data, dict):
                return data
        except Exception:
            pass
    return {"version": 1, "description": "工作区注册表", "workspaces": []}


def save_registry(registry: dict) -> None:
    """Save the workspace registry."""
    REGISTRY_FILE.parent.mkdir(parents=True, exist_ok=True)
    REGISTRY_FILE.write_text(
        json.dumps(registry, ensure_ascii=False, indent=2),
        encoding="utf-8"
    )


def _register_workspace(name: str, path: str, slug: str) -> None:
    """Add a workspace to the registry."""
    registry = load_registry()
    # Avoid duplicates
    existing = [w for w in registry["workspaces"] if w.get("slug") == slug]
    if not existing:
        registry["workspaces"].append({
            "name": name,
            "path": path,
            "slug": slug,
            "createdAt": int(time.time() * 1000),
        })
        save_registry(registry)


def _unregister_workspace(slug: str) -> None:
    """Remove a workspace from the registry."""
    registry = load_registry()
    registry["workspaces"] = [
        w for w in registry["workspaces"] if w.get("slug") != slug
    ]
    save_registry(registry)


# ── Workspace CRUD ───────────────────────────────────────────────────────────

def create_workspace(name: str, path: str = "", description: str = "",
                     team_name: str = "") -> dict:
    """Create a new workspace with full directory structure.

    Args:
        name: Display name for the workspace
        path: External project path this workspace is associated with
        description: Optional description
        team_name: Optional team name (for export/import)

    Returns:
        The workspace info dict

    Raises:
        ValueError: If name is empty or workspace already exists
    """
    if not name or not name.strip():
        raise ValueError("Workspace name is required")

    slug = _safe_slug(name)
    ws_dir = WORKSPACES_DIR / slug

    if ws_dir.exists():
        raise ValueError(f"Workspace '{name}' already exists (slug: {slug})")

    # Create directory structure
    ws_dir.mkdir(parents=True, exist_ok=True)
    for subdir in WORKSPACE_SUBDIRS:
        (ws_dir / subdir).mkdir(exist_ok=True)

    # Create info.json
    now = int(time.time() * 1000)
    info = {
        "version": INFO_VERSION,
        "name": name,
        "slug": slug,
        "path": path,
        "description": description,
        "team_name": team_name or name,
        "createdAt": now,
        "updatedAt": now,
        "employee_count": 0,
        "settings": {},
    }
    info_path = ws_dir / "info.json"
    info_path.write_text(
        json.dumps(info, ensure_ascii=False, indent=2),
        encoding="utf-8"
    )

    # Create empty connections.json
    connections_path = ws_dir / "connections.json"
    connections_path.write_text(
        json.dumps([], ensure_ascii=False, indent=2),
        encoding="utf-8"
    )

    # Register
    _register_workspace(name, path, slug)

    return info


def get_workspace(name_or_slug: str) -> Optional[dict]:
    """Get workspace info by name or slug."""
    slug = _safe_slug(name_or_slug)
    ws_dir = WORKSPACES_DIR / slug
    info_path = ws_dir / "info.json"
    if info_path.exists():
        try:
            return json.loads(info_path.read_text(encoding="utf-8"))
        except Exception:
            pass
    return None


def list_workspaces() -> list:
    """List all workspaces with their info."""
    if not WORKSPACES_DIR.is_dir():
        return []
    result = []
    for entry in sorted(WORKSPACES_DIR.iterdir()):
        if not entry.is_dir() or entry.name.startswith("_"):
            continue
        info_path = entry / "info.json"
        if info_path.exists():
            try:
                info = json.loads(info_path.read_text(encoding="utf-8"))
                info["_slug"] = entry.name
                result.append(info)
            except Exception:
                continue
    return result


def update_workspace(name_or_slug: str, updates: dict) -> Optional[dict]:
    """Update workspace metadata.

    Supports updating: name, description, team_name, path, settings.
    """
    slug = _safe_slug(name_or_slug)
    ws_dir = WORKSPACES_DIR / slug
    info_path = ws_dir / "info.json"
    if not info_path.exists():
        return None

    info = json.loads(info_path.read_text(encoding="utf-8"))

    # Apply allowed updates
    allowed = ("description", "team_name", "path", "settings")
    for key in allowed:
        if key in updates:
            info[key] = updates[key]

    # Handle name change (requires directory rename)
    if "name" in updates and updates["name"] != info.get("name"):
        new_name = updates["name"].strip()
        if new_name:
            new_slug = _safe_slug(new_name)
            new_dir = WORKSPACES_DIR / new_slug
            if new_dir.exists() and new_slug != slug:
                raise ValueError(f"Workspace '{new_name}' already exists")
            if new_slug != slug:
                ws_dir.rename(new_dir)
                _unregister_workspace(slug)
                _register_workspace(new_name, info.get("path", ""), new_slug)
                ws_dir = new_dir
                info_path = ws_dir / "info.json"
            info["name"] = new_name
            info["slug"] = new_slug

    info["updatedAt"] = int(time.time() * 1000)
    info_path.write_text(
        json.dumps(info, ensure_ascii=False, indent=2),
        encoding="utf-8"
    )
    return info


def delete_workspace(name_or_slug: str) -> bool:
    """Delete a workspace and all its data.

    Returns True if deleted, False if not found.
    """
    slug = _safe_slug(name_or_slug)
    ws_dir = WORKSPACES_DIR / slug
    if not ws_dir.is_dir():
        return False
    shutil.rmtree(str(ws_dir))
    _unregister_workspace(slug)
    return True


# ── Employee Instance Management ─────────────────────────────────────────────

def _emp_ins_root(ws_slug: str) -> Path:
    """Return the employee_ins/ path for a workspace."""
    return WORKSPACES_DIR / ws_slug / "employee_ins"


def _get_next_emp_id(ws_slug: str) -> int:
    """Read and increment the per-workspace employee ID counter."""
    id_file = _emp_ins_root(ws_slug) / "_next_id.json"
    current = 1
    if id_file.exists():
        try:
            data = json.loads(id_file.read_text(encoding="utf-8"))
            current = int(data.get("next_id", 1))
        except Exception:
            current = 1
    id_file.parent.mkdir(parents=True, exist_ok=True)
    id_file.write_text(json.dumps({"next_id": current + 1}), encoding="utf-8")
    return current


def create_employee_instance(ws_slug: str, data: dict) -> dict:
    """Create an employee instance in a workspace.

    Args:
        ws_slug: Workspace slug
        data: Employee data (name, role, skills, etc.)

    Returns:
        The created employee dict
    """
    name = (data.get("name") or "").strip()
    if not name:
        raise ValueError("Employee name is required")

    emp_root = _emp_ins_root(ws_slug)
    safe_name = _safe_slug(name)
    emp_dir = emp_root / safe_name

    if emp_dir.exists():
        raise ValueError(f"Employee '{name}' already exists in workspace")

    # Generate ID
    emp_id = data.get("id") or f"emp-{_get_next_emp_id(ws_slug)}"

    # Create directory
    emp_dir.mkdir(parents=True, exist_ok=True)

    # Build info
    now = int(time.time() * 1000)
    info = {
        "version": 1,
        "id": emp_id,
        "name": name,
        "role": data.get("role", "通用助手"),
        "avatar": data.get("avatar", "🤖"),
        "skills": _normalize_skills(data.get("skills", [])),
        "presetId": data.get("presetId"),
        "characterImg": data.get("characterImg"),
        "model": data.get("model", ""),
        "customPrompt": data.get("customPrompt", ""),
        "params": data.get("params", {}),
        "subagentOf": data.get("subagentOf"),
        "createdAt": data.get("createdAt", now),
        "lastActiveAt": data.get("lastActiveAt", now),
        "sessionId": data.get("sessionId"),
        "_pos": data.get("_pos"),
        "metadata": data.get("metadata", {}),
    }

    # Write info.json
    (emp_dir / "info.json").write_text(
        json.dumps(info, ensure_ascii=False, indent=2),
        encoding="utf-8"
    )

    # Write index.html if configHtml provided
    config_html = data.get("configHtml", "")
    if config_html:
        (emp_dir / "index.html").write_text(config_html, encoding="utf-8")

    # Update workspace employee count
    _update_employee_count(ws_slug)

    result = dict(info)
    result["configHtml"] = config_html
    return result


def list_employee_instances(ws_slug: str) -> list:
    """List all employee instances in a workspace."""
    emp_root = _emp_ins_root(ws_slug)
    if not emp_root.is_dir():
        return []

    employees = []
    for entry in sorted(emp_root.iterdir()):
        if not entry.is_dir() or entry.name.startswith("_"):
            continue
        info_path = entry / "info.json"
        if not info_path.exists():
            continue
        try:
            info = json.loads(info_path.read_text(encoding="utf-8"))
            # Load configHtml from index.html
            html_path = entry / "index.html"
            if html_path.exists():
                info["configHtml"] = html_path.read_text(encoding="utf-8")
                info["_hasConfigHtml"] = True
            else:
                info["configHtml"] = ""
                info["_hasConfigHtml"] = False
            info["_dirName"] = entry.name
            employees.append(info)
        except Exception:
            continue
    return employees


def delete_employee_instance(ws_slug: str, emp_id: str) -> bool:
    """Delete an employee instance by ID."""
    emp_root = _emp_ins_root(ws_slug)
    if not emp_root.is_dir():
        return False
    for entry in emp_root.iterdir():
        if not entry.is_dir() or entry.name.startswith("_"):
            continue
        info_path = entry / "info.json"
        if not info_path.exists():
            continue
        try:
            info = json.loads(info_path.read_text(encoding="utf-8"))
            if info.get("id") == emp_id:
                shutil.rmtree(str(entry))
                _update_employee_count(ws_slug)
                return True
        except Exception:
            continue
    return False


def _update_employee_count(ws_slug: str) -> None:
    """Update the employee_count in workspace info.json."""
    ws_dir = WORKSPACES_DIR / ws_slug
    info_path = ws_dir / "info.json"
    if not info_path.exists():
        return
    try:
        info = json.loads(info_path.read_text(encoding="utf-8"))
        employees = list_employee_instances(ws_slug)
        info["employee_count"] = len(employees)
        info["updatedAt"] = int(time.time() * 1000)
        info_path.write_text(
            json.dumps(info, ensure_ascii=False, indent=2),
            encoding="utf-8"
        )
    except Exception:
        pass


# ── Connections ──────────────────────────────────────────────────────────────

def get_connections(ws_slug: str) -> list:
    """Get the employee connection graph for a workspace."""
    conn_path = WORKSPACES_DIR / ws_slug / "connections.json"
    if conn_path.exists():
        try:
            data = json.loads(conn_path.read_text(encoding="utf-8"))
            if isinstance(data, list):
                return data
        except Exception:
            pass
    return []


def save_connections(ws_slug: str, connections: list) -> None:
    """Save the employee connection graph."""
    conn_path = WORKSPACES_DIR / ws_slug / "connections.json"
    conn_path.parent.mkdir(parents=True, exist_ok=True)
    conn_path.write_text(
        json.dumps(connections, ensure_ascii=False, indent=2),
        encoding="utf-8"
    )


# ── Workspace Initialization from Templates ──────────────────────────────────

def initialize_from_templates(ws_slug: str, force: bool = False) -> dict:
    """Initialize a workspace with auto-init template employees.

    Reads templates from employees/presets/ and creates instances
    in the workspace's employee_ins/ directory.

    Returns:
        {"created": N, "skipped": M, "errors": [...]}
    """
    from api.employee_templates import get_auto_init_templates

    # Check if workspace already has employees
    if not force:
        existing = list_employee_instances(ws_slug)
        if existing:
            return {"created": 0, "skipped": 0, "errors": [],
                    "message": "Workspace already has employees"}

    templates = get_auto_init_templates()
    if not templates:
        return {"created": 0, "skipped": 0, "errors": [],
                "message": "No auto-init templates configured"}

    created = 0
    skipped = 0
    errors = []

    for tmpl in templates:
        name = tmpl.get("name", "").strip()
        if not name:
            errors.append(f"Template '{tmpl.get('id', '?')}' has no name")
            continue

        emp_data = {
            "name": name,
            "role": tmpl.get("role", "通用助手"),
            "skills": _normalize_skills(tmpl.get("skills", [])),
            "presetId": tmpl.get("id"),
            "characterImg": tmpl.get("characterImg"),
            "model": tmpl.get("model", ""),
            "customPrompt": tmpl.get("customPrompt", ""),
            "params": tmpl.get("params", {}),
            "configHtml": tmpl.get("configHtml", ""),
        }

        try:
            create_employee_instance(ws_slug, emp_data)
            created += 1
        except ValueError as e:
            if "already exists" in str(e):
                skipped += 1
            else:
                errors.append(f"Failed to create '{name}': {e}")
        except Exception as e:
            errors.append(f"Failed to create '{name}': {e}")

    return {"created": created, "skipped": skipped, "errors": errors}


# ── Workspace Scripts/Experience/Skills File Management ──────────────────────

def _list_files_in_subdir(ws_slug: str, subdir: str) -> list:
    """List files in a workspace subdirectory (scripts, experience, skills)."""
    dir_path = WORKSPACES_DIR / ws_slug / subdir
    if not dir_path.is_dir():
        return []
    files = []
    for f in sorted(dir_path.iterdir()):
        if f.is_file() and not f.name.startswith("_"):
            try:
                files.append({
                    "name": f.name,
                    "path": str(f.relative_to(WORKSPACES_DIR / ws_slug)),
                    "size": f.stat().st_size,
                    "modifiedAt": int(f.stat().st_mtime * 1000),
                })
            except Exception:
                continue
    return files


def list_scripts(ws_slug: str) -> list:
    """List scripts in workspace."""
    return _list_files_in_subdir(ws_slug, "scripts")


def list_experience(ws_slug: str) -> list:
    """List experience files (error notes) in workspace."""
    return _list_files_in_subdir(ws_slug, "experience")


def list_skills(ws_slug: str) -> list:
    """List skill files in workspace."""
    return _list_files_in_subdir(ws_slug, "skills")


def save_file_to_subdir(ws_slug: str, subdir: str, filename: str,
                        content: str) -> dict:
    """Save a file to a workspace subdirectory."""
    if subdir not in ("scripts", "experience", "skills", "Intermediate"):
        raise ValueError(f"Invalid subdirectory: {subdir}")
    dir_path = WORKSPACES_DIR / ws_slug / subdir
    dir_path.mkdir(parents=True, exist_ok=True)
    # Sanitize filename
    safe_name = re.sub(r'[<>:"/\\|?*\x00-\x1f]', '_', filename.strip())
    if not safe_name:
        raise ValueError("Invalid filename")
    file_path = dir_path / safe_name
    file_path.write_text(content, encoding="utf-8")
    return {
        "name": safe_name,
        "path": str(file_path.relative_to(WORKSPACES_DIR / ws_slug)),
        "size": file_path.stat().st_size,
    }


def read_file_from_subdir(ws_slug: str, subdir: str, filename: str) -> Optional[str]:
    """Read a file from a workspace subdirectory."""
    if subdir not in ("scripts", "experience", "skills", "Intermediate"):
        return None
    file_path = WORKSPACES_DIR / ws_slug / subdir / filename
    if file_path.exists() and file_path.is_file():
        return file_path.read_text(encoding="utf-8")
    return None


def delete_file_from_subdir(ws_slug: str, subdir: str, filename: str) -> bool:
    """Delete a file from a workspace subdirectory."""
    if subdir not in ("scripts", "experience", "skills", "Intermediate"):
        return False
    file_path = WORKSPACES_DIR / ws_slug / subdir / filename
    if file_path.exists() and file_path.is_file():
        file_path.unlink()
        return True
    return False


# ── Export / Import (Team Package) ───────────────────────────────────────────

def export_workspace(ws_slug: str) -> Optional[dict]:
    """Export a workspace as a team package.

    Returns a dict that can be serialized to JSON for download.
    Includes all employees, connections, scripts, experience, and skills.
    """
    ws_dir = WORKSPACES_DIR / ws_slug
    info_path = ws_dir / "info.json"
    if not info_path.exists():
        return None

    info = json.loads(info_path.read_text(encoding="utf-8"))

    # Export employees
    employees = []
    for emp in list_employee_instances(ws_slug):
        # Also include any files in the employee directory
        emp_dir_name = emp.get("_dirName", _safe_slug(emp.get("name", "")))
        emp_dir = _emp_ins_root(ws_slug) / emp_dir_name
        emp_export = {k: v for k, v in emp.items()
                      if not k.startswith("_")}
        emp_export["configHtml"] = emp.get("configHtml", "")
        employees.append(emp_export)

    # Export connections
    connections = get_connections(ws_slug)

    # Export scripts
    scripts = _export_subdir_files(ws_slug, "scripts")

    # Export experience
    experience = _export_subdir_files(ws_slug, "experience")

    # Export skills
    skills = _export_subdir_files(ws_slug, "skills")

    return {
        "version": 1,
        "type": "team",
        "exportedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "workspace": {
            "name": info.get("name", ""),
            "description": info.get("description", ""),
            "team_name": info.get("team_name", ""),
            "path": info.get("path", ""),
            "settings": info.get("settings", {}),
        },
        "employees": employees,
        "connections": connections,
        "scripts": scripts,
        "experience": experience,
        "skills": skills,
    }


def _export_subdir_files(ws_slug: str, subdir: str) -> list:
    """Export all files from a workspace subdirectory."""
    dir_path = WORKSPACES_DIR / ws_slug / subdir
    if not dir_path.is_dir():
        return []
    files = []
    for f in sorted(dir_path.iterdir()):
        if not f.is_file() or f.name.startswith("_"):
            continue
        try:
            content = f.read_text(encoding="utf-8")
            files.append({
                "name": f.name,
                "content": content,
                "size": len(content),
            })
        except Exception:
            # Skip binary or unreadable files
            continue
    return files


def import_workspace(team_data: dict, name_override: str = "") -> dict:
    """Import a workspace from a team package.

    Args:
        team_data: The exported team package dict
        name_override: Optional override for workspace name

    Returns:
        {"ok": True, "workspace": info, "imported_employees": N}
    """
    ws_meta = team_data.get("workspace", {})
    name = name_override or ws_meta.get("name", "Imported Team")

    # Ensure unique name
    slug = _safe_slug(name)
    ws_dir = WORKSPACES_DIR / slug
    if ws_dir.exists():
        # Append timestamp for uniqueness
        slug = f"{slug}_{int(time.time())}"
        name = f"{name} ({time.strftime('%m%d%H%M')})"

    # Create workspace
    info = create_workspace(
        name=name,
        path=ws_meta.get("path", ""),
        description=ws_meta.get("description", ""),
        team_name=ws_meta.get("team_name", name),
    )
    slug = info["slug"]

    # Import employees
    employees_data = team_data.get("employees", [])
    imported_count = 0
    id_map = {}  # old_id -> new_id

    for emp_data in employees_data:
        old_id = emp_data.get("id", "")
        try:
            # Remove old ID so a new one is generated
            emp_copy = dict(emp_data)
            emp_copy.pop("id", None)
            new_emp = create_employee_instance(slug, emp_copy)
            id_map[old_id] = new_emp["id"]
            imported_count += 1
        except Exception as e:
            print(f"[import_workspace] Failed to import employee: {e}",
                  flush=True)
            continue

    # Remap connections with new IDs
    connections = team_data.get("connections", [])
    remapped_connections = []
    for conn in connections:
        new_from = id_map.get(conn.get("from"), conn.get("from"))
        new_to = id_map.get(conn.get("to"), conn.get("to"))
        remapped_connections.append({"from": new_from, "to": new_to})
    save_connections(slug, remapped_connections)

    # Import scripts
    for file_data in team_data.get("scripts", []):
        _import_file_to_subdir(slug, "scripts", file_data)

    # Import experience
    for file_data in team_data.get("experience", []):
        _import_file_to_subdir(slug, "experience", file_data)

    # Import skills
    for file_data in team_data.get("skills", []):
        _import_file_to_subdir(slug, "skills", file_data)

    # Update settings if provided
    if ws_meta.get("settings"):
        update_workspace(slug, {"settings": ws_meta["settings"]})

    return {
        "ok": True,
        "workspace": get_workspace(slug),
        "imported_employees": imported_count,
        "id_map": id_map,
    }


def _import_file_to_subdir(ws_slug: str, subdir: str, file_data: dict) -> None:
    """Import a file into a workspace subdirectory."""
    name = file_data.get("name", "").strip()
    content = file_data.get("content", "")
    if not name:
        return
    try:
        save_file_to_subdir(ws_slug, subdir, name, content)
    except Exception:
        pass


# ── Utility ──────────────────────────────────────────────────────────────────

def _normalize_skills(skills) -> list:
    """Normalize skills from various formats to employee format."""
    if not skills:
        return []
    result = []
    for s in skills:
        if isinstance(s, str):
            result.append({"name": s, "enabled": True})
        elif isinstance(s, dict):
            result.append(s)
    return result


def get_workspace_by_path(path: str) -> Optional[dict]:
    """Find a workspace by its associated external path."""
    for ws in list_workspaces():
        if ws.get("path") == path:
            return ws
    return None
