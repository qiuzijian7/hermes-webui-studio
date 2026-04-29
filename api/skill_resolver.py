"""
Hermes Web UI -- Skill Resolver (三源技能解析)

员工的 `skills` 字段支持从三个源加载真实的 SKILL.md / <name>.md 内容：

    1. preset      — employees/presets/<preset_id>/skills/<name>.md
    2. workspace   — workspaces/<ws_slug>/skills/<name>.md
    3. global      — <REPO_PARENT>/skills/**/SKILL.md   (Hermes 官方库)

解析规则：
  - 当员工 skill 条目显式指定 `source: "..."` 时，只在该源中查找
  - 未指定 source 时，按 preset → workspace → global 顺序查找，取第一个命中
  - 找到后附加 content 正文（限制 10KB 以避免 prompt 爆炸）

数据流：
  前端 → /api/employee/skills/resolve?workspace=&emp_id=
  后端 → 读取员工 info.json → 对每个 enabled skill 解析 → 返回 content 列表
  → prompt_builder.py 把 skills 数组注入到 {{ skills }} 模板变量
"""
from __future__ import annotations

import logging
from pathlib import Path
from typing import Any, Dict, List, Optional

from api.config import REPO_ROOT

logger = logging.getLogger(__name__)

# ── Paths ────────────────────────────────────────────────────────────────────

PRESETS_DIR = REPO_ROOT / "employees" / "presets"
MARKETPLACE_DIR = REPO_ROOT / "employees" / "marketplace"
WORKSPACES_DIR = REPO_ROOT / "workspaces"

# 全局 skills 库：优先找 hermes-agent 项目根下的 skills/（与 webui 同级或父级）
def _find_global_skills_dir() -> Optional[Path]:
    """
    定位全局 skills 库。搜索顺序：
      1. $HERMES_SKILLS_DIR 环境变量
      2. REPO_ROOT.parent / "skills"   (webui 作为子模块的常见布局)
      3. REPO_ROOT / "skills"
      4. REPO_ROOT.parent.parent / "skills"
    """
    import os
    env = os.getenv("HERMES_SKILLS_DIR", "").strip()
    if env:
        p = Path(env).expanduser().resolve()
        if p.is_dir():
            return p
    candidates = [
        REPO_ROOT.parent / "skills",
        REPO_ROOT / "skills",
        REPO_ROOT.parent.parent / "skills",
    ]
    for p in candidates:
        if p.is_dir():
            return p.resolve()
    return None


GLOBAL_SKILLS_DIR: Optional[Path] = _find_global_skills_dir()

# 单条 skill 内容字符数上限（防止 prompt 爆炸）
SKILL_CONTENT_MAX_CHARS = 10_000


# ── Skill file discovery ─────────────────────────────────────────────────────

def _normalize_skill_name(name: str) -> str:
    """规范化 skill 名称：小写，去扩展名，替换非法字符。"""
    s = (name or "").strip()
    if not s:
        return ""
    # 去掉 .md 扩展名
    if s.lower().endswith(".md"):
        s = s[:-3]
    return s


def _safe_slug(name: str) -> str:
    """与 workspace_manager 中 _safe_slug 等价（防止目录穿越）。"""
    import re
    return re.sub(r"[^a-zA-Z0-9_\-]", "_", (name or "").strip())[:128]


def _try_read_skill_file(path: Path) -> Optional[str]:
    """读 SKILL.md 或同名 .md；失败返回 None。"""
    try:
        if not path.is_file():
            return None
        content = path.read_text(encoding="utf-8")
        if len(content) > SKILL_CONTENT_MAX_CHARS:
            content = content[:SKILL_CONTENT_MAX_CHARS] + "\n\n…（已截断，完整内容见源文件）"
        return content
    except Exception as exc:
        logger.debug("Failed to read skill file %s: %s", path, exc)
        return None


def _parse_frontmatter(content: str) -> Dict[str, Any]:
    """
    解析 SKILL.md 的 YAML frontmatter（可选）：

        ---
        name: xxx
        description: ...
        ---

    返回 dict；失败或无 frontmatter 返回 {}。
    """
    if not content or not content.startswith("---"):
        return {}
    try:
        import yaml  # type: ignore
    except ImportError:
        return {}
    lines = content.split("\n", 1)[1].split("---", 1)
    if len(lines) < 2:
        return {}
    try:
        data = yaml.safe_load(lines[0]) or {}
        return data if isinstance(data, dict) else {}
    except Exception:
        return {}


# ── Preset source ────────────────────────────────────────────────────────────

def _resolve_from_preset(skill_name: str, preset_id: str) -> Optional[Dict[str, Any]]:
    """从 employees/presets/<preset_id>/skills/ 查找。"""
    if not preset_id:
        return None
    for base in (PRESETS_DIR, MARKETPLACE_DIR):
        skill_file = base / _safe_slug(preset_id) / "skills" / f"{skill_name}.md"
        if skill_file.is_file():
            content = _try_read_skill_file(skill_file)
            if content:
                meta = _parse_frontmatter(content)
                return {
                    "name": skill_name,
                    "source": "preset",
                    "path": str(skill_file),
                    "description": meta.get("description", ""),
                    "content": content,
                }
    return None


# ── Workspace source ─────────────────────────────────────────────────────────

def _resolve_from_workspace(skill_name: str, workspace: str) -> Optional[Dict[str, Any]]:
    """从 workspaces/<slug>/skills/ 查找。workspace 参数可为 slug 或绝对路径。"""
    if not workspace:
        return None
    # 支持两种形式：(1) workspace slug；(2) 绝对路径
    candidates: List[Path] = []
    ws_path = Path(workspace)
    if ws_path.is_absolute() and ws_path.is_dir():
        candidates.append(ws_path / "skills" / f"{skill_name}.md")
    # 按 slug 查找（从 slug 拼路径）
    slug = _safe_slug(workspace.replace("\\", "_").replace("/", "_").replace(":", "_"))
    candidates.append(WORKSPACES_DIR / slug / "skills" / f"{skill_name}.md")
    # 原始 basename 兜底
    candidates.append(WORKSPACES_DIR / Path(workspace).name / "skills" / f"{skill_name}.md")

    for sf in candidates:
        if sf.is_file():
            content = _try_read_skill_file(sf)
            if content:
                meta = _parse_frontmatter(content)
                return {
                    "name": skill_name,
                    "source": "workspace",
                    "path": str(sf),
                    "description": meta.get("description", ""),
                    "content": content,
                }
    return None


# ── Global source ────────────────────────────────────────────────────────────

def _resolve_from_global(skill_name: str, hint_path: str = "") -> Optional[Dict[str, Any]]:
    """
    从 global skills/ 查找。

    支持两种形式：
      1. hint_path 明确指定路径（如 "software-development/plan/SKILL.md"）
      2. 按 skill name 递归搜索（匹配 <name>/SKILL.md）

    返回第一个命中。
    """
    if not GLOBAL_SKILLS_DIR:
        return None

    # 方式 1：明确路径
    if hint_path:
        # 防止路径穿越
        if ".." in hint_path or hint_path.startswith(("/", "\\")):
            return None
        target = (GLOBAL_SKILLS_DIR / hint_path).resolve()
        try:
            target.relative_to(GLOBAL_SKILLS_DIR.resolve())
        except ValueError:
            return None
        if target.is_file():
            content = _try_read_skill_file(target)
            if content:
                meta = _parse_frontmatter(content)
                return {
                    "name": skill_name,
                    "source": "global",
                    "path": str(target.relative_to(GLOBAL_SKILLS_DIR)),
                    "description": meta.get("description", ""),
                    "content": content,
                }

    # 方式 2：按名递归搜索
    # 匹配 <skill_name>/SKILL.md
    for sf in GLOBAL_SKILLS_DIR.rglob("SKILL.md"):
        if sf.parent.name == skill_name:
            content = _try_read_skill_file(sf)
            if content:
                meta = _parse_frontmatter(content)
                return {
                    "name": skill_name,
                    "source": "global",
                    "path": str(sf.relative_to(GLOBAL_SKILLS_DIR)),
                    "description": meta.get("description", ""),
                    "content": content,
                }
    return None


# ── Main resolver ────────────────────────────────────────────────────────────

def resolve_skill(
    skill_spec: Any,
    *,
    preset_id: str = "",
    workspace: str = "",
) -> Dict[str, Any]:
    """
    解析单个 skill 条目，返回统一格式：

        {
            "name": "ux-design",
            "source": "preset" | "workspace" | "global" | "",
            "description": "...",
            "content": "# ..."  (可能为空),
            "enabled": True,
            "path": "...",
            "found": True | False,
        }

    入参 skill_spec 支持：
      - 字符串：          "ux-design"
      - 对象（旧格式）：  {"name": "ux-design", "enabled": True}
      - 对象（新格式）：  {"name": "ux-design", "source": "global", "path": "..."}
    """
    # 规范化输入
    if isinstance(skill_spec, str):
        spec = {"name": skill_spec, "enabled": True}
    elif isinstance(skill_spec, dict):
        spec = dict(skill_spec)
    else:
        return {"name": "", "enabled": False, "found": False}

    name = _normalize_skill_name(spec.get("name", ""))
    if not name:
        return {"name": "", "enabled": False, "found": False}

    enabled = spec.get("enabled", True) is not False
    wanted_source = (spec.get("source") or "").strip().lower()
    hint_path = spec.get("path", "")

    # 按优先级解析
    result: Optional[Dict[str, Any]] = None

    if wanted_source == "preset":
        result = _resolve_from_preset(name, preset_id)
    elif wanted_source == "workspace":
        result = _resolve_from_workspace(name, workspace)
    elif wanted_source == "global":
        result = _resolve_from_global(name, hint_path)
    else:
        # 未指定 source → 三源依次查找
        result = (
            _resolve_from_preset(name, preset_id)
            or _resolve_from_workspace(name, workspace)
            or _resolve_from_global(name, hint_path)
        )

    if result:
        result["enabled"] = enabled
        result["found"] = True
        return result

    # 未找到任何内容，仍返回基本信息（仅 name，无 content）
    return {
        "name": name,
        "source": wanted_source or "",
        "description": spec.get("description", ""),
        "content": "",
        "enabled": enabled,
        "path": hint_path,
        "found": False,
    }


def resolve_employee_skills(
    emp: Dict[str, Any],
    *,
    workspace: str = "",
) -> List[Dict[str, Any]]:
    """
    解析员工的所有 enabled skill。

    Args:
        emp: 员工对象（必须含 skills 数组；可选 presetId）
        workspace: 当前工作区（slug 或绝对路径）

    Returns:
        技能列表，每项已附加 content（可能为空）
    """
    if not isinstance(emp, dict):
        return []
    skills = emp.get("skills") or []
    if not isinstance(skills, list):
        return []
    preset_id = emp.get("presetId") or ""

    resolved: List[Dict[str, Any]] = []
    for spec in skills:
        item = resolve_skill(spec, preset_id=preset_id, workspace=workspace)
        # 只保留 enabled 的
        if item.get("enabled", True):
            resolved.append(item)
    return resolved


# ── HTTP handlers ────────────────────────────────────────────────────────────

def handle_resolve(handler, parsed) -> bool:
    """
    GET /api/employee/skills/resolve?workspace=...&emp_id=...

    返回该员工 enabled 技能的完整内容（含 SKILL.md 正文）。
    """
    from urllib.parse import parse_qs
    from api.helpers import j, bad
    try:
        qs = parse_qs(parsed.query)
        workspace = (qs.get("workspace", [""])[0] or "").strip()
        emp_id = (qs.get("emp_id", [""])[0] or "").strip()
        if not workspace or not emp_id:
            return bad(handler, "workspace and emp_id are required")

        # 读员工 info.json
        try:
            from api.employee_fs import get_employee_by_id
            emp = get_employee_by_id(workspace, emp_id)
        except Exception as exc:
            return j(handler, {"ok": False, "error": f"employee fetch failed: {exc}"}, status=500)
        if not emp:
            return bad(handler, f"employee '{emp_id}' not found", status=404)

        skills = resolve_employee_skills(emp, workspace=workspace)
        return j(handler, {
            "ok": True,
            "emp_id": emp_id,
            "skills": skills,
            "total": len(skills),
            "found": sum(1 for s in skills if s.get("found")),
        })
    except Exception as exc:
        logger.exception("skill resolve failed")
        return j(handler, {"ok": False, "error": str(exc)}, status=500)


def handle_list_global(handler, parsed) -> bool:
    """
    GET /api/skills/global/list

    枚举全局 skills/ 下所有 SKILL.md 的元数据（供前端选择面板使用）。
    返回格式：
        {
            "ok": true,
            "skills_dir": "/path/to/skills",
            "skills": [
                {"name": "plan", "path": "software-development/plan/SKILL.md",
                 "description": "...", "category": "software-development"},
                ...
            ]
        }
    """
    from api.helpers import j
    try:
        if not GLOBAL_SKILLS_DIR:
            return j(handler, {"ok": True, "skills_dir": None, "skills": []})

        results = []
        for sf in sorted(GLOBAL_SKILLS_DIR.rglob("SKILL.md")):
            try:
                relative = sf.relative_to(GLOBAL_SKILLS_DIR)
                # category = 顶层目录名
                parts = relative.parts
                category = parts[0] if len(parts) > 1 else ""
                name = sf.parent.name
                # 轻量读取 frontmatter（不读完整内容，避免巨大响应）
                content = ""
                try:
                    with open(sf, "r", encoding="utf-8") as f:
                        # 只读前 4KB 用于解析 frontmatter
                        content = f.read(4096)
                except Exception:
                    pass
                meta = _parse_frontmatter(content)
                results.append({
                    "name": name,
                    "path": str(relative).replace("\\", "/"),
                    "category": category,
                    "description": meta.get("description", ""),
                    "version": meta.get("version", ""),
                    "tags": meta.get("metadata", {}).get("hermes", {}).get("tags", [])
                            if isinstance(meta.get("metadata"), dict) else [],
                })
            except Exception:
                continue

        return j(handler, {
            "ok": True,
            "skills_dir": str(GLOBAL_SKILLS_DIR),
            "skills": results,
            "total": len(results),
        })
    except Exception as exc:
        logger.exception("list global skills failed")
        return j(handler, {"ok": False, "error": str(exc)}, status=500)
