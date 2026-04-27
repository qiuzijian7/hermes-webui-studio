"""
Hook: subagent.announce → 总群回显

示例 hook：当 ``spawn_agent`` 生成的子 agent 完成任务时，
将其摘要自动发到当前工作区的总群，所有员工和用户都能看到。

启用方法：什么都不用做——``api/event_bus.py`` 启动时会扫描 hooks/ 目录
自动 import 本文件。

关闭方法：把本文件改名为 ``_group_chat_echo.py``（下划线开头）或删除。

注意：
  - 只处理 completed 状态，failed/timed_out 状态也会发但标注
  - 若无 workspace 信息则静默跳过（例如 gateway / CLI 模式）
  - 设计文档：docs/multi_agent_collaboration.md
"""

from __future__ import annotations

import logging

from api.event_bus import on

logger = logging.getLogger(__name__)


@on("subagent.announce")
def echo_subagent_result_to_group(payload: dict) -> None:
    """子 agent 完成后，把摘要作为系统消息发到总群。

    payload 期望字段：
      - workspace (str, 必填)：当前工作区路径
      - parent_id (str)：父 agent 的 session_id
      - child_session_id (str)
      - child_employee_name (str, 可选)：子 agent 关联的员工名
      - status (str)：completed / failed / timed_out / interrupted
      - summary (str)：子 agent 输出
      - duration_seconds (float)
    """
    workspace = (payload.get("workspace") or "").strip()
    if not workspace:
        return  # 非 WebUI 上下文，跳过

    status = payload.get("status", "unknown")
    summary = (payload.get("summary") or "").strip()
    child_name = payload.get("child_employee_name") or "子 agent"
    duration = payload.get("duration_seconds", 0)

    # 失败时简短标注，成功时截断摘要
    if status == "completed":
        if not summary:
            return
        body = summary if len(summary) <= 400 else (summary[:400] + "…")
        text = f"[{child_name}] 完成（{duration:.0f}s）：{body}"
    elif status in ("failed", "timed_out", "interrupted"):
        text = f"[{child_name}] 未完成（{status}, {duration:.0f}s）：{summary[:200] if summary else '无输出'}"
    else:
        return  # 其他状态（pending/running/steered）不 echo

    try:
        # 延迟 import 以避免循环依赖
        from api.group_chat import append_group_system_message  # type: ignore[attr-defined]
        append_group_system_message(workspace=workspace, message=text)
    except ImportError:
        # append_group_system_message 尚未提供时，降级为日志
        logger.info("[group_chat_echo] (no-op fallback): %s", text)
    except Exception:
        logger.exception("[group_chat_echo] failed to append to group chat")
