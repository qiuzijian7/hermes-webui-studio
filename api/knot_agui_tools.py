"""
Knot AG-UI Tools Bridge — 工具查询模块

提供 Hermes 注册的工具/技能定义查询功能。

★ 工具执行策略 ★
  Knot AG-UI 智能体的工具统一在 Knot 平台后台配置（Client 工具），
  由 Knot 平台原生执行。本模块不参与工具执行，仅提供：
  - 查询可用工具列表（供前端/调试接口使用）
  - 员工级别的 toolset 过滤
  - 工具名判断辅助函数
"""
import json
import logging
from typing import Any, Dict, List, Optional, Set

logger = logging.getLogger(__name__)


# ══════════════════════════════════════════════════════════════════════════════
# Tool Definition Export — 将 Hermes 工具导出为 AG-UI 格式（供查询/调试）
# ══════════════════════════════════════════════════════════════════════════════

def get_hermes_tool_definitions(
    enabled_toolsets: Optional[List[str]] = None,
    disabled_toolsets: Optional[List[str]] = None,
) -> List[Dict[str, Any]]:
    """
    获取 Hermes 注册的工具定义，转换为 AG-UI 兼容格式。

    AG-UI tool 格式:
        {
            "name": "tool_name",
            "description": "Tool description",
            "parameters": {
                "type": "object",
                "properties": {...},
                "required": [...]
            }
        }

    Returns:
        AG-UI 格式的工具定义列表
    """
    try:
        from model_tools import get_tool_definitions
        # 获取 OpenAI 格式的工具定义
        openai_defs = get_tool_definitions(
            enabled_toolsets=enabled_toolsets,
            disabled_toolsets=disabled_toolsets,
            quiet_mode=True,
        )
        # 转换为 AG-UI 格式（从 OpenAI wrapper 中提取 function 定义）
        agui_tools = []
        for td in openai_defs:
            fn = td.get("function", {})
            if not fn.get("name"):
                continue
            agui_tools.append({
                "name": fn["name"],
                "description": fn.get("description", ""),
                "parameters": fn.get("parameters", {
                    "type": "object",
                    "properties": {},
                }),
            })
        return agui_tools
    except Exception as e:
        logger.warning("Failed to get Hermes tool definitions: %s", e)
        return []


def get_skill_tool_definitions(
    employee: Optional[Dict[str, Any]] = None,
    workspace: str = "",
) -> List[Dict[str, Any]]:
    """
    将员工的技能（skills）导出为 AG-UI 工具定义。

    每个已启用的技能生成一个虚拟工具：
        name: "hermes_skill_{skill_name}"
        description: 技能描述
        parameters: { query: string }  -- agent 通过 query 参数描述想让技能做的事
    """
    if not employee:
        return []
    try:
        from api.skill_resolver import resolve_employee_skills
        skills = resolve_employee_skills(employee, workspace=workspace)
        skill_tools = []
        for sk in skills:
            if not sk.get("found") or not sk.get("enabled"):
                continue
            name = sk.get("name", "")
            if not name:
                continue
            skill_tools.append({
                "name": f"hermes_skill_{name}",
                "description": (
                    f"[Hermes Skill] {sk.get('description', name)} — "
                    f"Invoke the '{name}' skill to perform specialized tasks. "
                    f"Pass a natural language query describing what you need."
                ),
                "parameters": {
                    "type": "object",
                    "properties": {
                        "query": {
                            "type": "string",
                            "description": "Natural language description of the task to perform using this skill",
                        },
                    },
                    "required": ["query"],
                },
            })
        return skill_tools
    except Exception as e:
        logger.warning("Failed to get skill tool definitions: %s", e)
        return []


def get_all_available_tools(
    employee: Optional[Dict[str, Any]] = None,
    workspace: str = "",
    enabled_toolsets: Optional[List[str]] = None,
    disabled_toolsets: Optional[List[str]] = None,
    include_skills: bool = True,
    include_tools: bool = True,
) -> List[Dict[str, Any]]:
    """
    获取所有可用的工具定义（工具 + 技能）。

    主要供 /api/agui/tools 调试接口使用。

    Args:
        employee: 当前员工对象（可选，用于获取技能）
        workspace: 当前工作区路径/slug
        enabled_toolsets: 启用的工具集列表
        disabled_toolsets: 禁用的工具集列表
        include_skills: 是否包含技能
        include_tools: 是否包含 Hermes 注册工具

    Returns:
        AG-UI 格式的所有可用工具定义
    """
    all_tools = []
    if include_tools:
        all_tools.extend(get_hermes_tool_definitions(
            enabled_toolsets=enabled_toolsets,
            disabled_toolsets=disabled_toolsets,
        ))
    if include_skills:
        all_tools.extend(get_skill_tool_definitions(
            employee=employee,
            workspace=workspace,
        ))
    return all_tools


# ══════════════════════════════════════════════════════════════════════════════
# Tool Query Helpers — 工具查询辅助函数
# ══════════════════════════════════════════════════════════════════════════════

def is_local_tool(tool_name: str) -> bool:
    """
    判断给定的工具名是否为 Hermes 本地注册的工具或技能。

    Returns:
        True 如果工具在 Hermes 注册表中
    """
    # 技能工具
    if tool_name.startswith("hermes_skill_"):
        return True
    # 注册表中的工具
    try:
        from tools.registry import registry
        entry = registry.get_entry(tool_name)
        return entry is not None
    except Exception:
        return False


def get_local_tool_names() -> Set[str]:
    """获取所有本地注册的工具名集合。"""
    try:
        from tools.registry import registry
        return set(registry.get_all_tool_names())
    except Exception:
        return set()


# ══════════════════════════════════════════════════════════════════════════════
# Tool Filtering — 按员工配置过滤可用工具
# ══════════════════════════════════════════════════════════════════════════════

def get_employee_toolsets(employee: Optional[Dict[str, Any]] = None) -> tuple:
    """
    从员工配置中提取启用/禁用的 toolset 信息。

    Returns:
        (enabled_toolsets, disabled_toolsets) 元组
    """
    if not employee:
        return None, None

    # 员工可能有 toolsets 配置
    toolsets_config = employee.get("toolsets", {})
    if not toolsets_config:
        return None, None

    enabled = toolsets_config.get("enabled")
    disabled = toolsets_config.get("disabled")

    # 规范化为 list 或 None
    if isinstance(enabled, list) and enabled:
        enabled_list = enabled
    else:
        enabled_list = None

    if isinstance(disabled, list) and disabled:
        disabled_list = disabled
    else:
        disabled_list = None

    return enabled_list, disabled_list


# ══════════════════════════════════════════════════════════════════════════════
# AG-UI Protocol Helpers — 协议辅助函数
# ══════════════════════════════════════════════════════════════════════════════

def format_tools_for_agui_input(tools: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    """
    将工具定义格式化为 AG-UI 格式（供查询接口使用）。
    """
    formatted = []
    for tool in tools:
        formatted.append({
            "name": tool.get("name", ""),
            "description": tool.get("description", ""),
            "parameters": tool.get("parameters", {
                "type": "object",
                "properties": {},
            }),
        })
    return formatted


def build_tool_result_message(tool_call_id: str, result: str) -> Dict[str, Any]:
    """
    构建 AG-UI ToolMessage 格式的工具结果消息。

    用于在对话历史中追加 tool result，以便 agent 后续轮次能获取结果。
    """
    import time
    return {
        "id": f"result_{tool_call_id}_{int(time.time()*1000)}",
        "role": "tool",
        "content": result,
        "toolCallId": tool_call_id,
    }
