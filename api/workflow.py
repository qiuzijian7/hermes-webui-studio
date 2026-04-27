"""
Hermes Web UI -- Workflow templates API.

Workflow 是"多位员工 + 协同脚本"的可复用模板，YAML 定义在 ``workflows/`` 目录。
用户选择一个 workflow 后，可一键在当前工作区实例化：前端会据此批量创建员工卡片
与连线关系，并在启动对话时把 ``entry.message`` 发给 manager。

与 ``agent-presets.js`` 的区别：
  - Preset = 单个角色模板（用于画布上拖拽单个员工）
  - Workflow = 多个 preset 的编排模板（批量创建 + 定义协同关系 + 启动指令）

本模块只做 YAML 解析与校验，不负责写入 localStorage（那是前端职责）。
"""

from __future__ import annotations

import json
import logging
from pathlib import Path
from typing import Any, Dict, List

logger = logging.getLogger(__name__)


# ── 路径 ────────────────────────────────────────────────────────────────────
# workflows 目录与 api/ 同级，位于项目根：
#   hermes-webui-studio/workflows/*.yaml
WORKFLOWS_DIR = Path(__file__).resolve().parent.parent / "workflows"


# ── YAML 加载 ───────────────────────────────────────────────────────────────

def _load_yaml(path: Path) -> Dict[str, Any] | None:
    """读取并解析单个 workflow YAML。失败返回 None 并记录日志。"""
    try:
        import yaml  # type: ignore
    except ImportError:
        logger.warning("PyYAML not installed; workflow feature disabled")
        return None
    try:
        raw = path.read_text(encoding="utf-8")
        data = yaml.safe_load(raw)
        if not isinstance(data, dict):
            logger.warning("Workflow %s is not a dict (top level)", path.name)
            return None
        return data
    except Exception as exc:
        logger.exception("Failed to parse workflow %s: %s", path.name, exc)
        return None


# ── 校验 ────────────────────────────────────────────────────────────────────

def _validate_workflow(data: Dict[str, Any]) -> List[str]:
    """校验 workflow 结构合法性。返回错误列表（空=有效）。"""
    errors: List[str] = []

    # 必填字段
    for req in ("name", "title", "members"):
        if req not in data:
            errors.append(f"missing required field: {req}")

    members = data.get("members", [])
    if not isinstance(members, list) or not members:
        errors.append("members must be a non-empty list")
    else:
        keys_seen: set[str] = set()
        for i, m in enumerate(members):
            if not isinstance(m, dict):
                errors.append(f"members[{i}] is not a dict")
                continue
            k = m.get("key")
            if not k or not isinstance(k, str):
                errors.append(f"members[{i}].key is required and must be a string")
                continue
            if k in keys_seen:
                errors.append(f"duplicate member key: {k}")
            keys_seen.add(k)
            # name / role 可缺省，前端 fallback 到 preset 或 key

        # topology 校验（可选字段）
        topo = data.get("topology", {}) or {}
        if not isinstance(topo, dict):
            errors.append("topology must be a dict")
        else:
            manager = topo.get("manager")
            if manager is not None and manager not in keys_seen:
                errors.append(f"topology.manager '{manager}' is not a defined member key")
            subs = topo.get("subagents", {}) or {}
            if isinstance(subs, dict):
                for parent_key, child_list in subs.items():
                    if parent_key not in keys_seen:
                        errors.append(f"topology.subagents key '{parent_key}' is not a defined member")
                    if not isinstance(child_list, list):
                        errors.append(f"topology.subagents['{parent_key}'] must be a list")
                        continue
                    for c in child_list:
                        if c not in keys_seen:
                            errors.append(f"topology.subagents['{parent_key}'] child '{c}' is not a defined member")
            else:
                errors.append("topology.subagents must be a dict")

        # entry 可选
        entry = data.get("entry")
        if entry is not None:
            if not isinstance(entry, dict):
                errors.append("entry must be a dict")
            else:
                to = entry.get("to")
                if to is not None and to not in keys_seen:
                    errors.append(f"entry.to '{to}' is not a defined member")

    return errors


# ── 列出所有可用 workflow ───────────────────────────────────────────────────

def list_workflows() -> List[Dict[str, Any]]:
    """扫描 workflows 目录，返回所有有效 workflow 的摘要列表。

    返回项格式：
        {
            "id": "<filename without .yaml>",
            "name": "<name>",
            "title": "<title>",
            "description": "<desc>",
            "member_count": N,
            "members_preview": ["角色1", "角色2", ...],  # 前 3 个
            "version": N,
        }
    """
    results: List[Dict[str, Any]] = []
    if not WORKFLOWS_DIR.is_dir():
        return results
    for path in sorted(WORKFLOWS_DIR.glob("*.yaml")):
        if path.name.startswith("_"):
            continue
        data = _load_yaml(path)
        if not data:
            continue
        errors = _validate_workflow(data)
        if errors:
            logger.warning("Workflow %s has errors: %s", path.name, errors)
            continue
        members = data.get("members", [])
        results.append({
            "id": path.stem,
            "name": data.get("name", path.stem),
            "title": data.get("title", data.get("name", path.stem)),
            "description": data.get("description", ""),
            "member_count": len(members),
            "members_preview": [
                m.get("name") or m.get("role") or m.get("key", "")
                for m in members[:3]
            ],
            "version": data.get("version", 1),
        })
    return results


# ── 获取单个 workflow 详情 ──────────────────────────────────────────────────

def get_workflow(workflow_id: str) -> Dict[str, Any] | None:
    """按 id（文件名 stem）读取并返回 workflow 完整定义。不存在或无效时返回 None。"""
    if not workflow_id or "/" in workflow_id or ".." in workflow_id:
        return None
    path = WORKFLOWS_DIR / f"{workflow_id}.yaml"
    if not path.is_file():
        return None
    data = _load_yaml(path)
    if not data:
        return None
    errors = _validate_workflow(data)
    if errors:
        return {"_errors": errors, **data}
    data["id"] = workflow_id
    return data


# ── HTTP 路由处理 ───────────────────────────────────────────────────────────
# 这些函数由 api/routes.py 调用，签名遵循项目惯例：
#   handler: BaseHTTPRequestHandler 实例
#   parsed:  urllib.parse.ParseResult
# 返回值：True 表示已写入响应。

def handle_list(handler, parsed) -> bool:
    """GET /api/workflows — 列出所有可用 workflow 模板。"""
    from api.helpers import j
    try:
        items = list_workflows()
        return j(handler, {"ok": True, "workflows": items})
    except Exception as exc:
        logger.exception("workflow list failed")
        return j(handler, {"ok": False, "error": str(exc)}, status=500)


def handle_detail(handler, parsed) -> bool:
    """GET /api/workflow?id=<workflow_id> — 返回单个 workflow 的完整定义（用于前端实例化）。"""
    from urllib.parse import parse_qs
    from api.helpers import j, bad
    qs = parse_qs(parsed.query)
    wf_id = qs.get("id", [""])[0].strip()
    if not wf_id:
        return bad(handler, "id is required")
    data = get_workflow(wf_id)
    if not data:
        return bad(handler, f"workflow '{wf_id}' not found", status=404)
    if "_errors" in data:
        return j(handler, {"ok": False, "errors": data["_errors"], "workflow": data}, status=422)
    return j(handler, {"ok": True, "workflow": data})
