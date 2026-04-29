"""
Hermes Web UI -- Employee System Prompt Builder.

统一的员工 system_prompt 生成入口，前后端共用。

设计原则：
  - **单一权威源**：替代前端 static/employee.js::buildEmployeeSystemPrompt 的硬编码拼接
  - **分段模板化**：每段独立 .md 文件，位于 prompt_templates/<locale>/<name>.md
  - **多语言**：zh + en，缺失自动回退到 default_locale
  - **可 override**：员工/团队可通过 info.json.promptSegments 关闭或替换指定段
  - **渐进依赖**：优先使用 Jinja2；若未安装，降级为轻量 {{var}} 替换（功能略简）

使用：
    from api.prompt_builder import build_employee_prompt
    prompt = build_employee_prompt(emp, locale='zh', workspace='/tmp/ws',
                                   preset=preset_dict, skills=skill_list)
"""
from __future__ import annotations

import logging
import re
from pathlib import Path
from typing import Any, Dict, List, Optional

from api.config import PM_NAME, REPO_ROOT

logger = logging.getLogger(__name__)

# ── Paths ────────────────────────────────────────────────────────────────────
TEMPLATES_ROOT = REPO_ROOT / "prompt_templates"
CONFIG_FILE = TEMPLATES_ROOT / "_config.yaml"

# ── Config cache ─────────────────────────────────────────────────────────────
_config_cache: Optional[Dict[str, Any]] = None
_config_mtime: float = 0.0


def _load_config() -> Dict[str, Any]:
    """加载 _config.yaml；基于文件 mtime 做热重载。"""
    global _config_cache, _config_mtime
    if not CONFIG_FILE.exists():
        return _default_config()
    try:
        mtime = CONFIG_FILE.stat().st_mtime
        if _config_cache is not None and mtime == _config_mtime:
            return _config_cache
        import yaml  # type: ignore
        data = yaml.safe_load(CONFIG_FILE.read_text(encoding="utf-8")) or {}
        if not isinstance(data, dict):
            data = _default_config()
        _config_cache = data
        _config_mtime = mtime
        return data
    except Exception as exc:
        logger.warning("Failed to load prompt_templates config: %s", exc)
        return _default_config()


def _default_config() -> Dict[str, Any]:
    """缺省配置（与 _config.yaml 保持一致，作为兜底）。"""
    return {
        "version": 1,
        "segments": [
            {"name": "role_definition", "order": 10, "enabled": True, "required": True},
            {"name": "config_params", "order": 20, "enabled": True, "required": False},
            {"name": "skills_context", "order": 30, "enabled": True, "required": False},
            {"name": "workspace_context", "order": 40, "enabled": True, "required": False},
            {"name": "behavior_rules", "order": 50, "enabled": True, "required": True},
            {"name": "tool_discipline", "order": 60, "enabled": True, "required": True},
            {"name": "subagent_context", "order": 70, "enabled": True, "required": False},
            {"name": "collab_rules", "order": 80, "enabled": True, "required": False},
        ],
        "supported_locales": ["zh", "en"],
        "default_locale": "zh",
        "fallback_to_default_locale": True,
    }


# ── Template loading ─────────────────────────────────────────────────────────

def _segment_path(segment_name: str, locale: str) -> Optional[Path]:
    """返回指定段 + 语言的模板文件路径；不存在返回 None。"""
    p = TEMPLATES_ROOT / locale / f"{segment_name}.md"
    return p if p.is_file() else None


def _read_segment(segment_name: str, locale: str, config: Dict[str, Any]) -> str:
    """读取模板原文；按 fallback 规则回退。"""
    path = _segment_path(segment_name, locale)
    if path is None and config.get("fallback_to_default_locale", True):
        default_locale = config.get("default_locale", "zh")
        if default_locale != locale:
            path = _segment_path(segment_name, default_locale)
    if path is None:
        return ""
    try:
        return path.read_text(encoding="utf-8")
    except Exception as exc:
        logger.warning("Failed to read template %s/%s: %s", locale, segment_name, exc)
        return ""


# ── Rendering ────────────────────────────────────────────────────────────────

def _render_jinja2(template_text: str, ctx: Dict[str, Any]) -> str:
    """优先使用 Jinja2 渲染；失败抛出供上层 fallback。"""
    from jinja2 import Environment, StrictUndefined, TemplateError  # type: ignore
    env = Environment(
        trim_blocks=True,
        lstrip_blocks=True,
        keep_trailing_newline=False,
        autoescape=False,
    )
    try:
        tmpl = env.from_string(template_text)
        return tmpl.render(**ctx)
    except TemplateError as exc:
        logger.warning("Jinja2 render error: %s", exc)
        raise


_SIMPLE_VAR_RE = re.compile(r"\{\{\s*([a-zA-Z_][\w\.]*)\s*\}\}")


def _resolve_dotpath(ctx: Dict[str, Any], dotpath: str) -> Any:
    """简易 `a.b.c` 路径解析，用于无 Jinja2 时的降级渲染。"""
    cur: Any = ctx
    for part in dotpath.split("."):
        if isinstance(cur, dict):
            cur = cur.get(part)
        else:
            cur = getattr(cur, part, None)
        if cur is None:
            return ""
    return cur


def _render_simple(template_text: str, ctx: Dict[str, Any]) -> str:
    """
    简易降级渲染（无 Jinja2 时）：
      - 支持 {{ var.path }} 变量替换
      - 不支持 {% if %} {% for %}：遇到这些控制块时会尝试**软跳过**（原样保留文本）
      - 因此输出质量会下降，但不会崩溃
    """
    return _SIMPLE_VAR_RE.sub(
        lambda m: str(_resolve_dotpath(ctx, m.group(1)) or ""),
        template_text,
    )


def _render(template_text: str, ctx: Dict[str, Any]) -> str:
    """主渲染入口：优先 Jinja2，失败降级到简易替换。"""
    if not template_text:
        return ""
    try:
        return _render_jinja2(template_text, ctx)
    except ImportError:
        logger.debug("Jinja2 not installed; using simple renderer")
        return _render_simple(template_text, ctx)
    except Exception:
        return _render_simple(template_text, ctx)


# ── Context building ─────────────────────────────────────────────────────────

def _get_workspace_name(workspace_path: str) -> str:
    """从工作区路径提取友好名称（最后一级目录）。"""
    if not workspace_path:
        return ""
    # Windows 路径兼容：同时处理 / 和 \
    parts = re.split(r"[/\\]+", workspace_path.rstrip("/\\"))
    parts = [p for p in parts if p]
    return parts[-1] if parts else workspace_path


def _auto_resolve_scripts(
    emp: Dict[str, Any],
    *,
    workspace: str = "",
    preset: Optional[Dict[str, Any]] = None,
) -> List[Dict[str, Any]]:
    """
    自动解析员工可调用的脚本清单（employee → workspace → preset 三源合并，去重）。

    每项形如 {name, source, description, size?}。source ∈ {employee, workspace, preset}。
    调用失败时静默返回 []，不阻断 prompt 渲染。
    """
    try:
        from api.employee_scripts import list_scripts
    except Exception:
        return []

    merged: List[Dict[str, Any]] = []
    seen_names: set = set()

    emp_id = (emp or {}).get("id", "")
    preset_id = (preset or {}).get("id") or (emp or {}).get("presetId", "")

    # 1) employee scripts/
    if emp_id and workspace:
        try:
            for item in list_scripts("employee", workspace, emp_id=emp_id, workspace=workspace):
                name = item.get("name")
                if name and name not in seen_names:
                    seen_names.add(name)
                    merged.append({**item, "source": "employee"})
        except Exception:
            pass

    # 2) workspace scripts/
    if workspace:
        try:
            for item in list_scripts("workspace", workspace, workspace=workspace):
                name = item.get("name")
                if name and name not in seen_names:
                    seen_names.add(name)
                    merged.append({**item, "source": "workspace"})
        except Exception:
            pass

    # 3) preset scripts/ (built-in examples)
    if preset_id:
        try:
            for item in list_scripts("preset", preset_id):
                name = item.get("name")
                if name and name not in seen_names:
                    seen_names.add(name)
                    merged.append({**item, "source": "preset"})
        except Exception:
            pass

    # 为避免 prompt 过长，限制最多 20 条
    return merged[:20]


def _build_context(
    emp: Dict[str, Any],
    *,
    preset: Optional[Dict[str, Any]] = None,
    skills: Optional[List[Dict[str, Any]]] = None,
    scripts: Optional[List[Dict[str, Any]]] = None,
    workspace: str = "",
    manager: Optional[Dict[str, Any]] = None,
    pm_name: Optional[str] = None,
    extra: Optional[Dict[str, Any]] = None,
) -> Dict[str, Any]:
    """构建模板渲染上下文。"""
    ctx: Dict[str, Any] = {
        "emp": emp or {},
        "preset": preset or {},
        "preset_desc": (preset or {}).get("desc", "") if preset else "",
        "params": emp.get("params") or {},
        "skills": skills or [],
        "scripts": scripts or [],
        "workspace_path": workspace or "",
        "workspace_name": _get_workspace_name(workspace),
        "manager_name": (manager or {}).get("name") if manager else None,
        "pm_name": pm_name or PM_NAME,
    }
    if extra:
        ctx.update(extra)
    return ctx


# ── Main entry ───────────────────────────────────────────────────────────────

def build_employee_prompt(
    emp: Dict[str, Any],
    *,
    locale: str = "zh",
    preset: Optional[Dict[str, Any]] = None,
    skills: Optional[List[Dict[str, Any]]] = None,
    scripts: Optional[List[Dict[str, Any]]] = None,
    workspace: str = "",
    manager: Optional[Dict[str, Any]] = None,
    pm_name: Optional[str] = None,
    custom_prompt: Optional[str] = None,
    segment_overrides: Optional[Dict[str, Any]] = None,
) -> str:
    """
    生成员工完整 system_prompt。

    Args:
        emp: 员工对象（含 name/role/params/subagentOf/presetId/skills…）
        locale: 语言代码（zh/en）
        preset: 可选，员工关联的预设完整数据（含 desc）
        skills: 已解析的技能列表，每项 {name, source, description, content}
        scripts: 可调用的脚本列表，每项 {name, source, description}。未提供时
                 自动从 employee_scripts.list_scripts 解析（employee + workspace + preset）。
        workspace: 工作区绝对路径
        manager: 可选，上级员工对象（当 emp.subagentOf 有值时传入）
        pm_name: PM 员工名称（默认 config.PM_NAME）
        custom_prompt: 若非空，使用它替代 role/skills/workspace/behavior 段，
                       但仍追加 subagent_context 和 collab_rules
        segment_overrides: 段级开关/覆盖，格式：
            {"behavior_rules": False,                    # 禁用该段
             "role_definition": "自定义模板字符串"}      # 用字符串覆盖

    Returns:
        完整的 system_prompt 字符串
    """
    config = _load_config()
    segments_cfg = sorted(
        config.get("segments", []),
        key=lambda s: s.get("order", 999),
    )

    # 若 scripts 未显式提供，尝试从 employee_scripts 自动解析
    if scripts is None:
        try:
            scripts = _auto_resolve_scripts(emp, workspace=workspace, preset=preset)
        except Exception as exc:
            logger.debug("Auto-resolve scripts failed: %s", exc)
            scripts = []

    ctx = _build_context(
        emp,
        preset=preset,
        skills=skills,
        scripts=scripts,
        workspace=workspace,
        manager=manager,
        pm_name=pm_name,
    )

    segment_overrides = segment_overrides or {}
    # 员工级 override：emp.promptSegments 提供 per-segment 开关/替换
    emp_overrides = (emp or {}).get("promptSegments") or {}
    if isinstance(emp_overrides, dict):
        # emp.promptSegments 优先级低于显式 segment_overrides 参数
        merged = dict(emp_overrides)
        merged.update(segment_overrides)
        segment_overrides = merged

    # ── custom_prompt 模式：跳过默认的 role/params/skills/workspace/behavior ──
    # 但始终保留 subagent_context + collab_rules（防止用户误删关键规则）
    custom_prompt = (custom_prompt or emp.get("customPrompt") or "").strip()
    use_custom = bool(custom_prompt)

    # 允许在 custom_prompt 中使用 {{params.key}} 引用
    if use_custom:
        custom_prompt = _render(custom_prompt, ctx)

    rendered_parts: List[str] = []
    for seg in segments_cfg:
        name = seg.get("name")
        if not name:
            continue
        required = seg.get("required", False)

        # custom_prompt 模式下，跳过被 customPrompt 替代的段
        if use_custom and name in ("role_definition", "config_params",
                                   "skills_context", "workspace_context",
                                   "behavior_rules", "tool_discipline"):
            continue

        # 检查 segment_overrides
        override = segment_overrides.get(name, None)
        if override is False:
            if required:
                logger.warning("Segment '%s' is required and cannot be disabled", name)
            else:
                continue

        # 渲染段
        if isinstance(override, str):
            # 字符串 override：直接用 override 文本作模板
            try:
                rendered = _render(override, ctx)
            except Exception:
                rendered = override
        else:
            tmpl_text = _read_segment(name, locale, config)
            if not tmpl_text:
                continue
            rendered = _render(tmpl_text, ctx)

        rendered = rendered.strip()
        if rendered:
            rendered_parts.append(rendered)

    if use_custom:
        # 把 custom_prompt 放在最前，后面拼接 subagent + collab（如启用）
        final_parts = [custom_prompt] + rendered_parts
    else:
        final_parts = rendered_parts

    return "\n\n".join(final_parts).strip()


# ── HTTP handler ─────────────────────────────────────────────────────────────

def handle_build(handler, body: Dict[str, Any]) -> bool:
    """
    POST /api/prompt/build

    Body:
        {
          "emp": {...},            # 必需，员工对象
          "locale": "zh",          # 可选，默认 zh
          "preset": {...},         # 可选；若省略，会尝试按 emp.presetId 查询
          "skills": [...],         # 可选；若省略且启用 skills_context 段，会返回空
          "workspace": "...",      # 可选
          "manager_id": "emp-x",   # 可选，后端会查员工列表
          "manager": {...},        # 可选，直接提供（优先级高于 manager_id）
          "pm_name": "PM专员",      # 可选
          "custom_prompt": "...",  # 可选，覆盖 emp.customPrompt
          "segment_overrides": {...}
        }

    Response:
        { "prompt": "...", "locale": "zh", "segments": ["role_definition", ...] }
    """
    from api.helpers import j, bad
    try:
        emp = body.get("emp") or {}
        if not isinstance(emp, dict) or not emp.get("name"):
            return bad(handler, "emp.name is required")

        locale = (body.get("locale") or "zh").strip().lower()
        if locale not in _load_config().get("supported_locales", ["zh", "en"]):
            locale = "zh"

        # 若未提供 preset 但有 presetId，尝试查询
        preset = body.get("preset")
        if preset is None and emp.get("presetId"):
            try:
                from api.employee_templates import get_template_by_id
                preset = get_template_by_id(emp["presetId"])
            except Exception as exc:
                logger.debug("Failed to resolve preset %s: %s", emp["presetId"], exc)
                preset = None

        # 若未提供 manager 但有 manager_id，尝试从 workspace 查询
        manager = body.get("manager")
        manager_id = body.get("manager_id") or emp.get("subagentOf")
        workspace = body.get("workspace") or ""
        if manager is None and manager_id and workspace:
            try:
                from api.employee_fs import get_employee_by_id
                manager = get_employee_by_id(workspace, manager_id)
            except Exception:
                manager = None

        # 若未提供 skills，尝试通过 skill_resolver 自动解析（三源：preset/workspace/global）
        skills = body.get("skills")
        if skills is None:
            try:
                from api.skill_resolver import resolve_employee_skills
                skills = resolve_employee_skills(emp, workspace=workspace)
            except Exception as exc:
                logger.debug("Auto-resolve skills failed: %s", exc)
                skills = None

        prompt = build_employee_prompt(
            emp,
            locale=locale,
            preset=preset,
            skills=skills,
            scripts=body.get("scripts"),
            workspace=workspace,
            manager=manager,
            pm_name=body.get("pm_name"),
            custom_prompt=body.get("custom_prompt"),
            segment_overrides=body.get("segment_overrides"),
        )

        return j(handler, {
            "ok": True,
            "prompt": prompt,
            "locale": locale,
        })
    except Exception as exc:
        logger.exception("prompt build failed")
        return j(handler, {"ok": False, "error": str(exc)}, status=500)


def handle_config(handler, parsed) -> bool:
    """GET /api/prompt/config — 返回模板配置，供前端 UI 展示段开关。"""
    from api.helpers import j
    try:
        return j(handler, {"ok": True, "config": _load_config()})
    except Exception as exc:
        logger.exception("prompt config failed")
        return j(handler, {"ok": False, "error": str(exc)}, status=500)
