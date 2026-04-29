"""
Hermes Web UI -- Team Template System.

Manages preset and marketplace team templates that can be used
to create a full team with one click.

Template sources:
  - ``teams/presets/``      — Built-in preset teams (shipped with the repo)
  - ``teams/marketplace/``  — Teams downloaded from the marketplace

Each template is a **folder** containing:

  - ``info.json``     — Metadata (id, name, icon, desc, color, members, manages, …)
  - ``skills/``       — Skill definition files (.md)
  - ``experience/``   — Experience / lesson-learned files (.md)

The ``teams/_manifest.json`` controls which teams are shown in the UI.
"""
import json
import os
import shutil
from pathlib import Path
from typing import Optional

from api.config import REPO_ROOT

# ── Paths ────────────────────────────────────────────────────────────────────

TEMPLATES_DIR = REPO_ROOT / "teams"
PRESETS_DIR = TEMPLATES_DIR / "presets"
MARKETPLACE_DIR = TEMPLATES_DIR / "marketplace"
MANIFEST_FILE = TEMPLATES_DIR / "_manifest.json"

# ── Manifest ─────────────────────────────────────────────────────────────────

_DEFAULT_MANIFEST = {
    "version": 1,
    "description": "团队模板清单，控制预设团队的加载和展示",
}


def load_manifest() -> dict:
    """Load the team template manifest. Returns default if file is missing."""
    if MANIFEST_FILE.exists():
        try:
            data = json.loads(MANIFEST_FILE.read_text(encoding="utf-8"))
            if isinstance(data, dict):
                return data
        except Exception:
            pass
    return dict(_DEFAULT_MANIFEST)


def save_manifest(manifest: dict) -> None:
    """Save the team template manifest to disk."""
    MANIFEST_FILE.parent.mkdir(parents=True, exist_ok=True)
    MANIFEST_FILE.write_text(
        json.dumps(manifest, ensure_ascii=False, indent=2),
        encoding="utf-8"
    )


# ── Template Loading (folder-based) ─────────────────────────────────────────

def _load_template_folder(folder: Path) -> Optional[dict]:
    """Load a team template from a folder structure.

    Expected layout:
        folder/
          ├── info.json      (required — team metadata)
          ├── skills/        (optional — skill .md files)
          └── experience/    (optional — experience .md files)

    Returns the template dict from info.json, or None on error.
    """
    info_path = folder / "info.json"
    if not info_path.is_file():
        return None

    try:
        data = json.loads(info_path.read_text(encoding="utf-8"))
        if not isinstance(data, dict) or not data.get("name"):
            return None
    except Exception as e:
        print(f"[team_templates] Failed to load {info_path}: {e}", flush=True)
        return None

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
    """List all built-in preset team templates."""
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
    """List all marketplace-downloaded team templates."""
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
    """List all available team templates (preset + marketplace)."""
    return list_preset_templates() + list_marketplace_templates()


def get_template_by_id(template_id: str) -> Optional[dict]:
    """Find a team template by its ID across all sources."""
    for tmpl in list_all_templates():
        if tmpl.get("id") == template_id:
            return tmpl
    return None


def get_template_folder(template_id: str) -> Optional[Path]:
    """Return the folder Path for a team template by ID."""
    for base_dir in [PRESETS_DIR, MARKETPLACE_DIR]:
        if not base_dir.is_dir():
            continue
        candidate = base_dir / template_id
        if _is_template_folder(candidate):
            return candidate
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
    """Read a skill file from a team template's skills/ directory."""
    folder = get_template_folder(template_id)
    if not folder:
        return None
    skill_path = folder / "skills" / filename
    if skill_path.is_file():
        return skill_path.read_text(encoding="utf-8")
    return None


def read_template_experience(template_id: str, filename: str) -> Optional[str]:
    """Read an experience file from a team template's experience/ directory."""
    folder = get_template_folder(template_id)
    if not folder:
        return None
    exp_path = folder / "experience" / filename
    if exp_path.is_file():
        return exp_path.read_text(encoding="utf-8")
    return None


# ── Marketplace Operations ───────────────────────────────────────────────────

def install_marketplace_template(template_data: dict) -> Optional[dict]:
    """Install a team template downloaded from the marketplace.

    Saves the template as a folder structure under ``teams/marketplace/``.

    Args:
        template_data: The template dict (must include 'id' and 'name')

    Returns:
        The saved template dict, or None on failure.
    """
    tmpl_id = (template_data.get("id") or "").strip()
    name = (template_data.get("name") or "").strip()
    if not tmpl_id or not name:
        return None

    MARKETPLACE_DIR.mkdir(parents=True, exist_ok=True)

    if "template_version" not in template_data:
        template_data["template_version"] = 1

    # Create template folder
    folder_name = tmpl_id.replace("/", "_").replace("\\", "_")
    folder = MARKETPLACE_DIR / folder_name
    folder.mkdir(parents=True, exist_ok=True)

    # Write info.json (without source)
    info = {k: v for k, v in template_data.items() if k not in ("source",)}
    (folder / "info.json").write_text(
        json.dumps(info, ensure_ascii=False, indent=2),
        encoding="utf-8"
    )

    # Create standard subdirs
    (folder / "skills").mkdir(exist_ok=True)
    (folder / "experience").mkdir(exist_ok=True)

    template_data["source"] = "marketplace"
    return template_data


def uninstall_marketplace_template(template_id: str) -> bool:
    """Remove a marketplace team template folder.

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
