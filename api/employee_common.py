"""
api/employee_common.py — 两套员工存储（employee_fs + workspace_manager）共享的工具函数。

背景：
  - api/employee_fs.py 管理【外部工作区路径】下的员工目录
      <workspace>/employees/<name>/
    这是最初的设计，员工数据跟着用户的业务工作区走。

  - api/workspace_manager.py 管理【webui 内部 workspaces/ 目录】下的员工实例
      workspaces/<slug>/employee_ins/<name>/
    这是 Sprint 之后引入的"集中管理"模式。

两者共存的原因：
  1. 外部工作区模式：适合希望把员工信息提交到用户项目仓库的场景
  2. 集中模式：适合企业级/多工作区集中管理的场景
  3. 迁移成本高：许多路由同时使用

本模块抽取两者共用的纯函数，避免重复实现导致差异。

使用指引：
  - 需要跨两种结构读写员工数据 → 用本文件的函数
  - 只读 preset 模板 → 用 api/employee_templates.py
  - 只操作外部工作区员工 → 用 api/employee_fs.py
  - 只操作 webui 工作区 → 用 api/workspace_manager.py

TODO（未来重构）：统一两套存储层到单一抽象（EmployeeStore ABC），
但需要大规模改动路由层，不在本 PR 范围内。
"""
from __future__ import annotations

import re
from typing import Any, List


# ── 名称与路径规范 ─────────────────────────────────────────────────────────

_UNSAFE_PATH_CHARS = re.compile(r'[<>:"/\\|?*\x00-\x1f]')


def safe_dirname(name: str) -> str:
    """
    把员工名称转成安全的目录名：
      - 去首尾空白
      - 替换路径不合法字符
      - Windows 不允许首尾 `.` 或空格
      - 截断到 128 字符
      - 空输入回退到 'unnamed'
    """
    s = (name or "").strip()
    if not s:
        return "unnamed"
    s = _UNSAFE_PATH_CHARS.sub("_", s)
    s = s.strip(". ")
    return s[:128] or "unnamed"


_SLUG_RE = re.compile(r"[^a-zA-Z0-9_\-]")


def safe_slug(name: str) -> str:
    """
    更严格的 slug：只允许 ASCII 字母数字和 _/-。
    用于 workspace_manager 的 ws_slug / emp_dir 名。
    """
    s = (name or "").strip()
    s = _SLUG_RE.sub("_", s)
    return s[:128] or "unnamed"


# ── Skill 规范化 ──────────────────────────────────────────────────────────

def normalize_skills(skills: Any) -> List[dict]:
    """
    Skill 入参归一化（支持 3 种输入）：
      - ["Python", "web"]                         字符串数组
      - [{"name": "Python", "enabled": true}]     对象数组
      - [{"name": "Python", "source": "global"}]  新扩展（带 source）

    返回：统一的对象数组
        [{"name": "Python", "enabled": true}, ...]
    - 未知字段会被保留（例如 source / path / description）
    - enabled 默认 True
    - name 为空的条目被丢弃
    """
    if not skills:
        return []
    if not isinstance(skills, list):
        return []
    result: List[dict] = []
    for s in skills:
        if isinstance(s, str):
            if s.strip():
                result.append({"name": s.strip(), "enabled": True})
        elif isinstance(s, dict):
            name = (s.get("name") or "").strip()
            if not name:
                continue
            item = dict(s)
            item["name"] = name
            if "enabled" not in item:
                item["enabled"] = True
            result.append(item)
    return result


# ── Params Schema 支持 ────────────────────────────────────────────────────
# 新增字段：预设 info.json 可声明 paramsSchema 让前端自动渲染表单
# 例：
# {
#   "paramsSchema": [
#     {"key": "language", "label": "编程语言", "type": "enum",
#      "options": ["Python", "Go", "TypeScript"], "default": "Python"},
#     {"key": "years", "label": "经验年数", "type": "number",
#      "min": 0, "max": 30, "default": 3}
#   ]
# }

VALID_SCHEMA_TYPES = {"string", "number", "boolean", "enum", "multiline"}


def validate_params_schema(schema: Any) -> List[str]:
    """
    校验 paramsSchema 结构。返回错误信息列表（空 = 有效）。
    不符合规范的字段会被丢弃（在 normalize_params_schema 中）。
    """
    errors: List[str] = []
    if schema is None:
        return errors
    if not isinstance(schema, list):
        errors.append("paramsSchema must be a list")
        return errors
    seen_keys = set()
    for i, item in enumerate(schema):
        if not isinstance(item, dict):
            errors.append(f"paramsSchema[{i}] is not a dict")
            continue
        key = item.get("key", "").strip() if isinstance(item.get("key"), str) else ""
        if not key or not re.match(r"^[a-zA-Z_][a-zA-Z0-9_]*$", key):
            errors.append(f"paramsSchema[{i}].key invalid: {key!r}")
            continue
        if key in seen_keys:
            errors.append(f"duplicate key: {key}")
            continue
        seen_keys.add(key)
        typ = item.get("type", "string")
        if typ not in VALID_SCHEMA_TYPES:
            errors.append(f"paramsSchema[{i}].type '{typ}' not in {VALID_SCHEMA_TYPES}")
        if typ == "enum":
            opts = item.get("options")
            if not isinstance(opts, list) or not opts:
                errors.append(f"paramsSchema[{i}] enum requires non-empty options")
    return errors


def normalize_params_schema(schema: Any) -> List[dict]:
    """
    过滤并规范 paramsSchema；丢弃非法条目。
    调用方可安全地把返回值直接发给前端。
    """
    if not isinstance(schema, list):
        return []
    result: List[dict] = []
    seen = set()
    for item in schema:
        if not isinstance(item, dict):
            continue
        key = item.get("key", "").strip() if isinstance(item.get("key"), str) else ""
        if not key or not re.match(r"^[a-zA-Z_][a-zA-Z0-9_]*$", key):
            continue
        if key in seen:
            continue
        typ = item.get("type", "string")
        if typ not in VALID_SCHEMA_TYPES:
            typ = "string"
        if typ == "enum":
            opts = item.get("options")
            if not isinstance(opts, list) or not opts:
                continue
        normalized = {
            "key": key,
            "type": typ,
            "label": item.get("label", key),
            "default": item.get("default"),
        }
        # 可选字段
        for optional in ("description", "options", "min", "max",
                         "pattern", "placeholder", "required"):
            if optional in item:
                normalized[optional] = item[optional]
        result.append(normalized)
        seen.add(key)
    return result
