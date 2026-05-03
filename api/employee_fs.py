"""
Hermes Web UI -- Employee Filesystem Storage (外部工作区模式).

⚠️ 使用指引（与 api/workspace_manager.py 的关系）：
    - 本模块：管理【外部工作区路径】下的员工目录 `<workspace>/employees/<name>/`
      适合把员工信息跟随业务项目仓库走。
    - workspace_manager：管理 webui 内部 `workspaces/<slug>/employee_ins/<name>/`
      适合集中管理多工作区。
    - 共享工具：使用 api/employee_common.py 中的 safe_dirname / normalize_skills 等。

两套存储长期共存，路由层会按 workspace 入参的形态自动选择。

Each employee is stored as an independent directory under
``<workspace>/employees/<safe_name>/`` with the following structure::

    employees/
    └── <employee_name>/
        ├── info.json          # Core metadata (skills, version, prompts, model, params, etc.)
        ├── index.html         # configHtml content (rendered in browser tab)
        ├── scripts/           # Python scripts
        ├── output/            # Final output files
        ├── Intermediate/      # Intermediate process files
        ├── experience/        # Error-correction notes (MD format)
        ├── skill/             # Configured & accumulated skills
        └── database/          # Database files

The ``info.json`` schema (v1)::

    {
        "version": 1,
        "id": "emp-1",
        "name": "员工名",
        "role": "代码工程师",
        "avatar": "🤖",
        "skills": [{"name": "Python", "enabled": true}],
        "presetId": null,
        "characterImg": null,
        "model": "anthropic/claude-sonnet-4",
        "customPrompt": "",
        "params": {},
        "subagentOf": null,
        "createdAt": 1714000000000,
        "lastActiveAt": 1714000000000,
        "sessionId": null,
        "_pos": {"x": 100, "y": 200}
    }
"""
import json
import os
import re
import shutil
import time
from pathlib import Path
from typing import Optional

# ── Constants ────────────────────────────────────────────────────────────────

EMPLOYEES_DIR_NAME = "employees"
INFO_FILENAME = "info.json"
INDEX_HTML_FILENAME = "index.html"
INFO_VERSION = 1

SUBDIRS = [
    "scripts",
    "output",
    "Intermediate",
    "experience",
    "skill",
    "database",
]

# Fields stored in info.json (everything except configHtml which goes to index.html)
_INFO_FIELDS = [
    "version", "id", "name", "role", "avatar", "skills",
    "presetId", "characterImg", "model", "customPrompt", "params",
    "subagentOf", "createdAt", "lastActiveAt", "sessionId",
    "_pos", "metadata",
]


# ── Helpers ──────────────────────────────────────────────────────────────────

def _safe_dirname(name: str) -> str:
    """Convert an employee name to a safe directory name.

    - Strips leading/trailing whitespace
    - Replaces path-unsafe chars with '_'
    - Truncates to 128 chars
    - Falls back to 'unnamed' if empty
    """
    s = (name or "").strip()
    if not s:
        return "unnamed"
    # Replace characters that are problematic in paths
    s = re.sub(r'[<>:"/\\|?*\x00-\x1f]', '_', s)
    s = s.strip('. ')  # Windows doesn't like leading/trailing dots or spaces
    return s[:128] or "unnamed"


def _employees_root(workspace: str) -> Path:
    """Return the employees/ directory for a given workspace."""
    return Path(workspace) / EMPLOYEES_DIR_NAME


def _employee_dir(workspace: str, name: str) -> Path:
    """Return the directory path for a named employee."""
    return _employees_root(workspace) / _safe_dirname(name)


def _next_id_file(workspace: str) -> Path:
    """Return the path to the auto-increment ID tracker file."""
    return _employees_root(workspace) / "_next_id.json"


def _get_next_id(workspace: str) -> int:
    """Read and increment the per-workspace auto-increment counter."""
    id_file = _next_id_file(workspace)
    current = 1
    if id_file.exists():
        try:
            data = json.loads(id_file.read_text(encoding='utf-8'))
            current = int(data.get("next_id", 1))
        except Exception:
            current = 1
    # Write incremented value
    id_file.parent.mkdir(parents=True, exist_ok=True)
    id_file.write_text(json.dumps({"next_id": current + 1}), encoding='utf-8')
    return current


# ── Core API ─────────────────────────────────────────────────────────────────

def list_employees(workspace: str) -> list:
    """List all employees in a workspace.

    Returns a list of employee dicts (info.json contents + configHtml flag).
    """
    root = _employees_root(workspace)
    if not root.is_dir():
        return []

    employees = []
    for entry in sorted(root.iterdir()):
        if not entry.is_dir():
            continue
        if entry.name.startswith('_'):
            continue
        info_path = entry / INFO_FILENAME
        if not info_path.exists():
            continue
        try:
            emp = json.loads(info_path.read_text(encoding='utf-8'))
            # Check if index.html exists (don't load content, just flag)
            html_path = entry / INDEX_HTML_FILENAME
            if html_path.exists():
                emp["_hasConfigHtml"] = True
                # Load configHtml content so frontend gets it
                try:
                    emp["configHtml"] = html_path.read_text(encoding='utf-8')
                except Exception:
                    emp["configHtml"] = ""
            else:
                emp["_hasConfigHtml"] = False
                emp["configHtml"] = ""
            emp["_dirName"] = entry.name
            employees.append(emp)
        except Exception as e:
            print(f"[employee_fs] Failed to load {info_path}: {e}", flush=True)
            continue

    return employees


def get_employee(workspace: str, name: str) -> Optional[dict]:
    """Load a single employee by name. Returns None if not found."""
    emp_dir = _employee_dir(workspace, name)
    info_path = emp_dir / INFO_FILENAME
    if not info_path.exists():
        return None
    try:
        emp = json.loads(info_path.read_text(encoding='utf-8'))
        html_path = emp_dir / INDEX_HTML_FILENAME
        if html_path.exists():
            emp["configHtml"] = html_path.read_text(encoding='utf-8')
        else:
            emp["configHtml"] = ""
        return emp
    except Exception:
        return None


def get_employee_by_id(workspace: str, emp_id: str) -> Optional[dict]:
    """Find an employee by ID (scans all directories)."""
    root = _employees_root(workspace)
    if not root.is_dir():
        return None
    for entry in root.iterdir():
        if not entry.is_dir() or entry.name.startswith('_'):
            continue
        info_path = entry / INFO_FILENAME
        if not info_path.exists():
            continue
        try:
            emp = json.loads(info_path.read_text(encoding='utf-8'))
            if emp.get("id") == emp_id:
                html_path = entry / INDEX_HTML_FILENAME
                if html_path.exists():
                    emp["configHtml"] = html_path.read_text(encoding='utf-8')
                else:
                    emp["configHtml"] = ""
                return emp
        except Exception:
            continue
    return None


def create_employee(workspace: str, data: dict) -> dict:
    """Create a new employee directory with full structure.

    Args:
        workspace: Workspace root path
        data: Employee data dict (name, role, avatar, skills, etc.)

    Returns:
        The created employee dict (with generated id if not provided)

    Raises:
        ValueError: If name is empty or already exists
        OSError: If directory creation fails
    """
    name = (data.get("name") or "").strip()
    if not name:
        raise ValueError("Employee name is required")

    emp_dir = _employee_dir(workspace, name)
    if emp_dir.exists():
        raise ValueError(f"Employee '{name}' already exists in this workspace")

    # Generate ID if not provided
    emp_id = data.get("id") or f"emp-{_get_next_id(workspace)}"

    # Create directory structure
    emp_dir.mkdir(parents=True, exist_ok=True)
    for subdir in SUBDIRS:
        (emp_dir / subdir).mkdir(exist_ok=True)

    # Build info.json
    now = int(time.time() * 1000)
    info = {
        "version": INFO_VERSION,
        "id": emp_id,
        "name": name,
        "role": data.get("role", "通用助手"),
        "avatar": data.get("avatar", "🤖"),
        "skills": data.get("skills", []),
        "presetId": data.get("presetId"),
        "characterImg": data.get("characterImg"),
        "model": data.get("model", ""),
        "customPrompt": data.get("customPrompt", ""),
        "params": data.get("params", {}),
        "subagentOf": data.get("subagentOf"),
        "createdAt": data.get("createdAt", now),
        "lastActiveAt": data.get("lastActiveAt", now),
        # ★ 防御性修复：新员工必须 sessionId=None，防止从模板错误继承 sessionId
        "sessionId": None,
        "_pos": data.get("_pos"),
        "metadata": data.get("metadata", {}),
    }

    # Write info.json
    info_path = emp_dir / INFO_FILENAME
    info_path.write_text(
        json.dumps(info, ensure_ascii=False, indent=2),
        encoding='utf-8'
    )

    # Write index.html if configHtml provided
    config_html = data.get("configHtml", "")
    if config_html:
        html_path = emp_dir / INDEX_HTML_FILENAME
        html_path.write_text(config_html, encoding='utf-8')

    # Return full employee data
    result = dict(info)
    result["configHtml"] = config_html
    return result


def update_employee(workspace: str, emp_id: str, updates: dict) -> Optional[dict]:
    """Update an existing employee.

    Finds the employee by ID, applies updates to info.json and optionally
    index.html, and renames the directory if the name changes.

    Returns the updated employee dict, or None if not found.
    """
    # Find the employee directory
    root = _employees_root(workspace)
    if not root.is_dir():
        return None

    emp_dir = None
    info_path = None
    for entry in root.iterdir():
        if not entry.is_dir() or entry.name.startswith('_'):
            continue
        _ip = entry / INFO_FILENAME
        if not _ip.exists():
            continue
        try:
            _data = json.loads(_ip.read_text(encoding='utf-8'))
            if _data.get("id") == emp_id:
                emp_dir = entry
                info_path = _ip
                break
        except Exception:
            continue

    if emp_dir is None or info_path is None:
        return None

    # Load current data
    info = json.loads(info_path.read_text(encoding='utf-8'))

    # Apply updates
    old_name = info.get("name", "")
    for key in updates:
        if key == "configHtml":
            # configHtml goes to index.html, not info.json
            html_content = updates[key] or ""
            html_path = emp_dir / INDEX_HTML_FILENAME
            if html_content:
                html_path.write_text(html_content, encoding='utf-8')
            elif html_path.exists():
                html_path.unlink()
            continue
        if key in ("_hasConfigHtml", "_dirName"):
            continue  # skip computed fields
        info[key] = updates[key]

    info["lastActiveAt"] = int(time.time() * 1000)

    # Write updated info.json
    info_path.write_text(
        json.dumps(info, ensure_ascii=False, indent=2),
        encoding='utf-8'
    )

    # Rename directory if name changed
    new_name = info.get("name", "")
    if new_name and new_name != old_name:
        new_dir = _employees_root(workspace) / _safe_dirname(new_name)
        if new_dir != emp_dir and not new_dir.exists():
            try:
                emp_dir.rename(new_dir)
                emp_dir = new_dir
            except OSError as e:
                print(f"[employee_fs] Failed to rename {emp_dir} -> {new_dir}: {e}", flush=True)

    # Return full data
    result = dict(info)
    html_path = emp_dir / INDEX_HTML_FILENAME
    result["configHtml"] = html_path.read_text(encoding='utf-8') if html_path.exists() else ""
    return result


def delete_employee(workspace: str, emp_id: str) -> bool:
    """Delete an employee and all their files.

    Returns True if deleted, False if not found.
    """
    root = _employees_root(workspace)
    if not root.is_dir():
        return False

    for entry in root.iterdir():
        if not entry.is_dir() or entry.name.startswith('_'):
            continue
        info_path = entry / INFO_FILENAME
        if not info_path.exists():
            continue
        try:
            data = json.loads(info_path.read_text(encoding='utf-8'))
            if data.get("id") == emp_id:
                shutil.rmtree(str(entry))
                return True
        except Exception:
            continue
    return False


# ── Batch operations ─────────────────────────────────────────────────────────

def save_all_employees(workspace: str, employees: list) -> dict:
    """Save a full employee list (used for migration from localStorage).

    This is an "upsert" operation:
    - Creates new employees that don't exist
    - Updates existing employees
    - Does NOT delete employees not in the list (safe merge)

    Returns: {"created": N, "updated": M, "errors": [...]}
    """
    created = 0
    updated = 0
    errors = []

    for emp_data in employees:
        try:
            emp_id = emp_data.get("id", "")
            name = (emp_data.get("name") or "").strip()
            if not name:
                errors.append(f"Skipped employee with empty name (id={emp_id})")
                continue

            # Check if employee already exists (by ID)
            existing = get_employee_by_id(workspace, emp_id) if emp_id else None

            if existing:
                # Update existing
                update_employee(workspace, emp_id, emp_data)
                updated += 1
            else:
                # Create new
                create_employee(workspace, emp_data)
                created += 1
        except Exception as e:
            errors.append(f"Failed to save '{emp_data.get('name', '?')}': {str(e)}")

    return {"created": created, "updated": updated, "errors": errors}


def get_next_id_value(workspace: str) -> int:
    """Get the current next ID value without incrementing."""
    id_file = _next_id_file(workspace)
    if id_file.exists():
        try:
            data = json.loads(id_file.read_text(encoding='utf-8'))
            return int(data.get("next_id", 1))
        except Exception:
            pass
    return 1


def set_next_id_value(workspace: str, value: int) -> None:
    """Set the next ID counter (used during migration)."""
    id_file = _next_id_file(workspace)
    id_file.parent.mkdir(parents=True, exist_ok=True)
    id_file.write_text(json.dumps({"next_id": value}), encoding='utf-8')


# ── Experience file operations ───────────────────────────────────────────────

def list_experience_files(workspace: str, emp_id: str) -> list:
    """List all experience (error-correction) files for an employee."""
    emp = get_employee_by_id(workspace, emp_id)
    if not emp:
        return []
    emp_dir = _employee_dir(workspace, emp.get("name", ""))
    exp_dir = emp_dir / "experience"
    if not exp_dir.is_dir():
        return []
    files = []
    for f in sorted(exp_dir.iterdir()):
        if f.is_file() and f.suffix.lower() in ('.md', '.txt'):
            files.append({
                "name": f.name,
                "size": f.stat().st_size,
                "modified": f.stat().st_mtime,
            })
    return files


def read_experience_file(workspace: str, emp_id: str, filename: str) -> Optional[str]:
    """Read an experience file content."""
    emp = get_employee_by_id(workspace, emp_id)
    if not emp:
        return None
    emp_dir = _employee_dir(workspace, emp.get("name", ""))
    filepath = emp_dir / "experience" / filename
    # Security: ensure path stays within experience directory
    try:
        filepath.resolve().relative_to((emp_dir / "experience").resolve())
    except ValueError:
        return None
    if filepath.is_file():
        return filepath.read_text(encoding='utf-8', errors='replace')
    return None


def write_experience_file(workspace: str, emp_id: str, filename: str, content: str) -> bool:
    """Write an experience file."""
    emp = get_employee_by_id(workspace, emp_id)
    if not emp:
        return False
    emp_dir = _employee_dir(workspace, emp.get("name", ""))
    exp_dir = emp_dir / "experience"
    exp_dir.mkdir(parents=True, exist_ok=True)
    filepath = exp_dir / filename
    # Security check
    try:
        filepath.resolve().relative_to(exp_dir.resolve())
    except ValueError:
        return False
    filepath.write_text(content, encoding='utf-8')
    return True


# ── Skill file operations ────────────────────────────────────────────────────

def list_skill_files(workspace: str, emp_id: str) -> list:
    """List skill files for an employee."""
    emp = get_employee_by_id(workspace, emp_id)
    if not emp:
        return []
    emp_dir = _employee_dir(workspace, emp.get("name", ""))
    skill_dir = emp_dir / "skill"
    if not skill_dir.is_dir():
        return []
    files = []
    for f in sorted(skill_dir.iterdir()):
        if f.is_file():
            files.append({
                "name": f.name,
                "size": f.stat().st_size,
                "modified": f.stat().st_mtime,
            })
    return files


# ── Script file operations ───────────────────────────────────────────────────

def list_script_files(workspace: str, emp_id: str) -> list:
    """List Python scripts for an employee."""
    emp = get_employee_by_id(workspace, emp_id)
    if not emp:
        return []
    emp_dir = _employee_dir(workspace, emp.get("name", ""))
    scripts_dir = emp_dir / "scripts"
    if not scripts_dir.is_dir():
        return []
    files = []
    for f in sorted(scripts_dir.iterdir()):
        if f.is_file() and f.suffix.lower() == '.py':
            files.append({
                "name": f.name,
                "size": f.stat().st_size,
                "modified": f.stat().st_mtime,
            })
    return files


# ── Directory listing (generic) ──────────────────────────────────────────────

def list_employee_subdir(workspace: str, emp_id: str, subdir: str) -> list:
    """List files in any employee subdirectory (scripts, output, etc.)."""
    # Validate subdir name
    if subdir not in SUBDIRS:
        return []
    emp = get_employee_by_id(workspace, emp_id)
    if not emp:
        return []
    emp_dir = _employee_dir(workspace, emp.get("name", ""))
    target = emp_dir / subdir
    if not target.is_dir():
        return []
    files = []
    for f in sorted(target.iterdir()):
        files.append({
            "name": f.name,
            "type": "dir" if f.is_dir() else "file",
            "size": f.stat().st_size if f.is_file() else None,
            "modified": f.stat().st_mtime,
        })
    return files


# ── Export / Import (cross-machine portable) ─────────────────────────────────

import base64

# Max single file size to include in export (5 MB)
_EXPORT_MAX_FILE_BYTES = 5 * 1024 * 1024

# File extensions treated as text (read as UTF-8)
_TEXT_EXTS = {
    '.md', '.txt', '.py', '.js', '.ts', '.html', '.css', '.json',
    '.yaml', '.yml', '.xml', '.csv', '.sh', '.bat', '.toml', '.ini',
    '.cfg', '.conf', '.env', '.sql', '.r', '.java', '.c', '.cpp',
    '.h', '.hpp', '.go', '.rs', '.rb', '.php', '.lua', '.swift',
    '.kt', '.scala', '.pl', '.pm',
}


def _collect_subdir_files(emp_dir: Path, subdir_name: str) -> list:
    """Collect all files in an employee subdirectory for export.

    Returns a list of dicts:
        {"name": "filename.ext", "content": "...", "encoding": "text"|"base64"}

    Text files are stored as plain text; binary files as base64.
    Files larger than _EXPORT_MAX_FILE_BYTES are skipped.
    """
    target = emp_dir / subdir_name
    if not target.is_dir():
        return []
    files = []
    for f in sorted(target.iterdir()):
        if not f.is_file():
            continue
        try:
            size = f.stat().st_size
            if size > _EXPORT_MAX_FILE_BYTES:
                continue
            ext = f.suffix.lower()
            if ext in _TEXT_EXTS:
                content = f.read_text(encoding='utf-8', errors='replace')
                files.append({
                    "name": f.name,
                    "content": content,
                    "encoding": "text",
                })
            else:
                raw = f.read_bytes()
                files.append({
                    "name": f.name,
                    "content": base64.b64encode(raw).decode('ascii'),
                    "encoding": "base64",
                })
        except Exception as e:
            print(f"[employee_fs] export: skip {f}: {e}", flush=True)
            continue
    return files


def export_employee(workspace: str, emp_id: str) -> Optional[dict]:
    """Export a single employee with all subdirectory files.

    Returns a portable dict suitable for JSON serialization, or None if not found.
    The dict includes info.json fields, configHtml, and all subdirectory files.
    """
    emp = get_employee_by_id(workspace, emp_id)
    if not emp:
        return None
    name = emp.get("name", "")
    emp_dir = _employee_dir(workspace, name)
    if not emp_dir.is_dir():
        return None

    # Base employee data (from info.json + configHtml)
    export_data = dict(emp)
    # Remove computed/internal fields
    for key in ("_hasConfigHtml", "_dirName"):
        export_data.pop(key, None)

    # Collect subdirectory files
    subdirs_data = {}
    for subdir in SUBDIRS:
        files = _collect_subdir_files(emp_dir, subdir)
        if files:
            subdirs_data[subdir] = files
    if subdirs_data:
        export_data["_files"] = subdirs_data

    return export_data


def export_all_employees(workspace: str) -> list:
    """Export all employees in a workspace with their files.

    Returns a list of portable employee dicts.
    """
    root = _employees_root(workspace)
    if not root.is_dir():
        return []

    result = []
    for entry in sorted(root.iterdir()):
        if not entry.is_dir() or entry.name.startswith('_'):
            continue
        info_path = entry / INFO_FILENAME
        if not info_path.exists():
            continue
        try:
            emp = json.loads(info_path.read_text(encoding='utf-8'))
            emp_id = emp.get("id", "")
            if emp_id:
                exported = export_employee(workspace, emp_id)
                if exported:
                    result.append(exported)
        except Exception as e:
            print(f"[employee_fs] export_all: skip {entry}: {e}", flush=True)
            continue
    return result


def _restore_subdir_files(emp_dir: Path, subdir_name: str, files: list) -> int:
    """Restore files into an employee subdirectory from export data.

    Returns the number of files successfully written.
    """
    if subdir_name not in SUBDIRS:
        return 0
    target = emp_dir / subdir_name
    target.mkdir(parents=True, exist_ok=True)
    written = 0
    for fdata in files:
        fname = fdata.get("name", "")
        content = fdata.get("content", "")
        encoding = fdata.get("encoding", "text")
        if not fname:
            continue
        # Security: prevent path traversal
        safe_name = Path(fname).name  # strip any directory components
        if not safe_name or safe_name.startswith('.'):
            continue
        filepath = target / safe_name
        try:
            # Ensure path stays within target directory
            filepath.resolve().relative_to(target.resolve())
        except ValueError:
            continue
        try:
            if encoding == "base64":
                filepath.write_bytes(base64.b64decode(content))
            else:
                filepath.write_text(content, encoding='utf-8')
            written += 1
        except Exception as e:
            print(f"[employee_fs] import: failed to write {filepath}: {e}", flush=True)
    return written


def import_employee(workspace: str, emp_data: dict, force: bool = False) -> Optional[dict]:
    """Import a single employee from export data.

    Creates the employee directory, writes info.json, index.html,
    and restores all subdirectory files.

    Args:
        workspace: Workspace root path
        emp_data: Employee export data (from export_employee)
        force: If True, overwrite existing employee with same name

    Returns:
        The imported employee dict with new ID, or None on failure.
    """
    name = (emp_data.get("name") or "").strip()
    if not name:
        return None

    emp_dir = _employee_dir(workspace, name)

    if emp_dir.exists() and not force:
        # Employee with this name already exists — skip
        return None

    if emp_dir.exists() and force:
        # Remove existing to do a clean import
        shutil.rmtree(str(emp_dir))

    # Generate a new ID for this workspace
    new_id = f"emp-{_get_next_id(workspace)}"

    # Prepare info data — use new ID, preserve everything else
    info = {}
    for key in _INFO_FIELDS:
        if key in emp_data:
            info[key] = emp_data[key]
    info["id"] = new_id
    info["version"] = INFO_VERSION
    info["name"] = name
    # Clear runtime fields
    info["sessionId"] = None
    info["lastActiveAt"] = int(time.time() * 1000)

    # Create directory structure
    emp_dir.mkdir(parents=True, exist_ok=True)
    for subdir in SUBDIRS:
        (emp_dir / subdir).mkdir(exist_ok=True)

    # Write info.json
    info_path = emp_dir / INFO_FILENAME
    info_path.write_text(
        json.dumps(info, ensure_ascii=False, indent=2),
        encoding='utf-8'
    )

    # Write index.html (configHtml)
    config_html = emp_data.get("configHtml", "")
    if config_html:
        html_path = emp_dir / INDEX_HTML_FILENAME
        html_path.write_text(config_html, encoding='utf-8')

    # Restore subdirectory files
    files_data = emp_data.get("_files", {})
    files_restored = 0
    for subdir_name, files_list in files_data.items():
        files_restored += _restore_subdir_files(emp_dir, subdir_name, files_list)

    result = dict(info)
    result["configHtml"] = config_html
    result["_oldId"] = emp_data.get("id", "")  # For ID remapping by caller
    result["_filesRestored"] = files_restored
    return result


def import_employees(workspace: str, employees_data: list,
                     force: bool = False) -> dict:
    """Import multiple employees into a workspace.

    Args:
        workspace: Workspace root path
        employees_data: List of employee export dicts
        force: If True, overwrite existing employees with same name

    Returns:
        {"imported": N, "skipped": M, "errors": [...],
         "id_map": {"old-id": "new-id", ...}}
    """
    imported = 0
    skipped = 0
    errors = []
    id_map = {}  # old_id → new_id

    for emp_data in employees_data:
        name = (emp_data.get("name") or "").strip()
        old_id = emp_data.get("id", "")
        if not name:
            errors.append("Skipped employee with empty name")
            continue
        try:
            result = import_employee(workspace, emp_data, force=force)
            if result is None:
                # Already exists, skipped
                skipped += 1
                # Still need to map the old ID to the existing employee's ID
                existing = get_employee(workspace, name)
                if existing:
                    id_map[old_id] = existing.get("id", old_id)
            else:
                imported += 1
                id_map[old_id] = result["id"]
        except Exception as e:
            errors.append(f"Failed to import '{name}': {str(e)}")

    return {
        "imported": imported,
        "skipped": skipped,
        "errors": errors,
        "id_map": id_map,
    }
