"""
Hermes Web UI -- Employee Template System.

Manages preset and marketplace employee templates that are automatically
initialized when a new workspace is created.

Template sources:
  - ``employees/presets/``      — Built-in preset templates (shipped with the repo)
  - ``employees/marketplace/``  — Templates downloaded from the marketplace

Each template is a **folder** containing:

  - ``info.json``     — Metadata (id, name, role, desc, category, model, skills, …)
  - ``index.html``    — Optional config panel HTML (omitted if not needed)
  - ``skills/``       — Skill definition files (.md)
  - ``experience/``   — Experience / lesson-learned files (.md)

The ``employees/_manifest.json`` controls which templates are auto-initialized
into new workspaces.
"""
import json
import os
import shutil
from pathlib import Path
from typing import Optional

from api.config import REPO_ROOT

# ── Paths ────────────────────────────────────────────────────────────────────

TEMPLATES_DIR = REPO_ROOT / "employees"
PRESETS_DIR = TEMPLATES_DIR / "presets"
MARKETPLACE_DIR = TEMPLATES_DIR / "marketplace"
MANIFEST_FILE = TEMPLATES_DIR / "_manifest.json"

# ── Manifest ─────────────────────────────────────────────────────────────────

_DEFAULT_MANIFEST = {
    "version": 1,
    "auto_init_enabled": True,
    "auto_init_templates": ["pm-specialist"],
    "description": "Controls which templates are auto-initialized into new workspaces",
}


def load_manifest() -> dict:
    """Load the template manifest. Returns default if file is missing or invalid."""
    if MANIFEST_FILE.exists():
        try:
            data = json.loads(MANIFEST_FILE.read_text(encoding="utf-8"))
            if isinstance(data, dict):
                return data
        except Exception:
            pass
    return dict(_DEFAULT_MANIFEST)


def save_manifest(manifest: dict) -> None:
    """Save the template manifest to disk."""
    MANIFEST_FILE.parent.mkdir(parents=True, exist_ok=True)
    MANIFEST_FILE.write_text(
        json.dumps(manifest, ensure_ascii=False, indent=2),
        encoding="utf-8"
    )


# ── Template Loading (folder-based) ─────────────────────────────────────────

def _load_template_folder(folder: Path) -> Optional[dict]:
    """Load a template from a folder structure.

    Expected layout:
        folder/
          ├── info.json      (required)
          ├── index.html     (optional — config panel)
          ├── skills/        (optional — skill .md files)
          └── experience/    (optional — experience .md files)

    Returns the merged template dict (info.json fields + configHtml from index.html),
    or None on error.
    """
    info_path = folder / "info.json"
    if not info_path.is_file():
        return None

    try:
        data = json.loads(info_path.read_text(encoding="utf-8"))
        if not isinstance(data, dict) or not data.get("name"):
            return None
    except Exception as e:
        print(f"[employee_templates] Failed to load {info_path}: {e}", flush=True)
        return None

    # 规范化 paramsSchema（若存在）
    if "paramsSchema" in data:
        try:
            from api.employee_common import normalize_params_schema
            data["paramsSchema"] = normalize_params_schema(data.get("paramsSchema"))
        except Exception:
            pass

    # Load index.html → configHtml
    index_path = folder / "index.html"
    if index_path.is_file():
        data["configHtml"] = index_path.read_text(encoding="utf-8")

    # List skill files
    skills_dir = folder / "skills"
    if skills_dir.is_dir():
        data["_skill_files"] = sorted([
            f.name for f in skills_dir.iterdir()
            if f.is_file() and f.suffix.lower() == ".md"
        ])

    # List experience files
    exp_dir = folder / "experience"
    if exp_dir.is_dir():
        data["_experience_files"] = sorted([
            f.name for f in exp_dir.iterdir()
            if f.is_file() and f.suffix.lower() == ".md"
        ])

    data["_folder"] = str(folder)
    return data


def _is_template_folder(path: Path) -> bool:
    """Check if a path looks like a template folder (has info.json)."""
    return path.is_dir() and (path / "info.json").is_file() and not path.name.startswith("_")


def list_preset_templates() -> list:
    """List all built-in preset templates."""
    if not PRESETS_DIR.is_dir():
        return []
    templates = []
    for f in sorted(PRESETS_DIR.iterdir()):
        if _is_template_folder(f):
            tmpl = _load_template_folder(f)
            if tmpl:
                tmpl["_source"] = "preset"
                templates.append(tmpl)
    return templates


def list_marketplace_templates() -> list:
    """List all marketplace-downloaded templates."""
    if not MARKETPLACE_DIR.is_dir():
        return []
    templates = []
    for f in sorted(MARKETPLACE_DIR.iterdir()):
        if _is_template_folder(f):
            tmpl = _load_template_folder(f)
            if tmpl:
                tmpl["_source"] = "marketplace"
                templates.append(tmpl)
    return templates


def list_all_templates() -> list:
    """List all available templates (preset + marketplace)."""
    return list_preset_templates() + list_marketplace_templates()


def get_template_by_id(template_id: str) -> Optional[dict]:
    """Find a template by its ID across all sources."""
    for tmpl in list_all_templates():
        if tmpl.get("id") == template_id:
            return tmpl
    return None


def get_template_folder(template_id: str) -> Optional[Path]:
    """Return the folder Path for a template by ID, searching preset + marketplace."""
    for base_dir in [PRESETS_DIR, MARKETPLACE_DIR]:
        if not base_dir.is_dir():
            continue
        # Try folder name == template_id first
        candidate = base_dir / template_id
        if _is_template_folder(candidate):
            return candidate
        # Fallback: scan all subdirs and match by info.json id
        for d in base_dir.iterdir():
            if _is_template_folder(d):
                info_path = d / "info.json"
                try:
                    info = json.loads(info_path.read_text(encoding="utf-8"))
                    if info.get("id") == template_id:
                        return d
                except Exception:
                    continue
    return None


def read_template_skill(template_id: str, filename: str) -> Optional[str]:
    """Read a skill file from a template's skills/ directory."""
    folder = get_template_folder(template_id)
    if not folder:
        return None
    skill_path = folder / "skills" / filename
    if skill_path.is_file():
        return skill_path.read_text(encoding="utf-8")
    return None


def read_template_experience(template_id: str, filename: str) -> Optional[str]:
    """Read an experience file from a template's experience/ directory."""
    folder = get_template_folder(template_id)
    if not folder:
        return None
    exp_path = folder / "experience" / filename
    if exp_path.is_file():
        return exp_path.read_text(encoding="utf-8")
    return None


# ── Auto-initialization ──────────────────────────────────────────────────────

def get_auto_init_templates() -> list:
    """Get the list of templates that should be auto-created in new workspaces.

    Respects the manifest's auto_init_enabled flag and auto_init_templates list.
    Also includes any template with auto_create=True that isn't in the manifest's
    explicit list (for backward compat with templates that self-declare).
    """
    manifest = load_manifest()

    if not manifest.get("auto_init_enabled", True):
        return []

    # Explicit list from manifest
    explicit_ids = set(manifest.get("auto_init_templates", []))

    # Collect templates: those explicitly listed + those with auto_create=True
    result = []
    seen_ids = set()

    for tmpl in list_all_templates():
        tmpl_id = tmpl.get("id", "")
        if not tmpl_id or tmpl_id in seen_ids:
            continue

        should_include = (
            tmpl_id in explicit_ids or
            tmpl.get("auto_create", False)
        )

        if should_include:
            result.append(tmpl)
            seen_ids.add(tmpl_id)

    return result


def initialize_workspace_employees(workspace: str, force: bool = False) -> dict:
    """Initialize a workspace with auto-init template employees.

    This is called when a new workspace is created. It creates employee
    directories from the auto-init templates.

    Args:
        workspace: The workspace root path
        force: If True, re-create even if employees already exist

    Returns:
        {"created": N, "skipped": M, "errors": [...]}
    """
    from api.employee_fs import (
        create_employee, list_employees, _employees_root
    )

    # Check if workspace already has employees (skip if it does, unless force)
    if not force:
        existing = list_employees(workspace)
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

        # Build employee data from template
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
            create_employee(workspace, emp_data)
            created += 1
        except ValueError as e:
            # Already exists — skip
            if "already exists" in str(e):
                skipped += 1
            else:
                errors.append(f"Failed to create '{name}': {e}")
        except Exception as e:
            errors.append(f"Failed to create '{name}': {e}")

    return {"created": created, "skipped": skipped, "errors": errors}


def _normalize_skills(skills) -> list:
    """Normalize skills from template format to employee format.

    Templates may store skills as simple strings ["Python", "web"]
    or as objects [{"name": "Python", "enabled": true}].
    Employee format expects objects.
    """
    if not skills:
        return []
    result = []
    for s in skills:
        if isinstance(s, str):
            result.append({"name": s, "enabled": True})
        elif isinstance(s, dict):
            result.append(s)
    return result


# ── Marketplace Operations ───────────────────────────────────────────────────

def install_marketplace_template(template_data: dict) -> Optional[dict]:
    """Install a template downloaded from the marketplace.

    Saves the template as a folder structure under ``employees/marketplace/``.
    If ``template_data`` contains ``configHtml``, it is extracted to ``index.html``.

    Args:
        template_data: The template dict (must include 'id' and 'name')

    Returns:
        The saved template dict, or None on failure.
    """
    tmpl_id = (template_data.get("id") or "").strip()
    name = (template_data.get("name") or "").strip()
    if not tmpl_id or not name:
        return None

    # Ensure marketplace dir exists
    MARKETPLACE_DIR.mkdir(parents=True, exist_ok=True)

    if "template_version" not in template_data:
        template_data["template_version"] = 1

    # Extract configHtml → index.html
    config_html = template_data.pop("configHtml", "")

    # Create template folder
    folder_name = tmpl_id.replace("/", "_").replace("\\", "_")
    folder = MARKETPLACE_DIR / folder_name
    folder.mkdir(parents=True, exist_ok=True)

    # Write info.json (without configHtml, without source)
    info = {k: v for k, v in template_data.items() if k not in ("source",)}
    (folder / "info.json").write_text(
        json.dumps(info, ensure_ascii=False, indent=2),
        encoding="utf-8"
    )

    # Write index.html if configHtml provided
    if config_html:
        (folder / "index.html").write_text(config_html, encoding="utf-8")

    # Create standard subdirs
    (folder / "skills").mkdir(exist_ok=True)
    (folder / "experience").mkdir(exist_ok=True)

    # Return the full template data (including configHtml for API response)
    template_data["configHtml"] = config_html
    template_data["source"] = "marketplace"
    return template_data


def uninstall_marketplace_template(template_id: str) -> bool:
    """Remove a marketplace template folder.

    Returns True if removed, False if not found.
    """
    if not MARKETPLACE_DIR.is_dir():
        return False

    for d in MARKETPLACE_DIR.iterdir():
        if not d.is_dir() or d.name.startswith("_"):
            continue
        info_path = d / "info.json"
        if not info_path.is_file():
            continue
        try:
            data = json.loads(info_path.read_text(encoding="utf-8"))
            if data.get("id") == template_id:
                shutil.rmtree(str(d))
                return True
        except Exception:
            continue
    return False
