"""
Hook: agent.complete → PM专员心跳（Heartbeat）

当工作区内的员工 agent 完成任务时，向总群 session 追加一条系统消息，
并通过 SSE 通知前端触发 PM专员 的心跳调度。

PM 心跳流程：
  1. 员工 agent 完成 → streaming.py emit("agent.complete")
  2. 本 hook 拦截事件 → 判断是否需要触发心跳
  3. 向总群追加"员工完成"系统消息 + 推送 heartbeat SSE 事件
  4. 前端收到 heartbeat 事件 → 调用 PM专员 AI（带心跳模式提示词）
  5. PM专员 分析结果 → 决定是否通过 @mention 委派后续任务

设计要点：
  - 仅处理有 workspace + employee_name 的事件（过滤掉 PM 自己的完成事件和 CLI 模式）
  - PM专员自己完成对话时不触发心跳（避免无限循环）
  - 短时间内同一工作区多个员工完成时合并为一次心跳（节流 5 秒）
  - 异步执行，不阻塞 agent.complete 事件链

启用方法：什么都不用做——event_bus 启动时会自动扫描 hooks/ 目录导入本文件。
关闭方法：把本文件改名为 _pm_heartbeat.py（下划线开头）或删除。
"""

from __future__ import annotations

import logging
import threading
import time
from typing import Dict

from api.event_bus import on

logger = logging.getLogger(__name__)

# ── 心跳节流（同一工作区 5 秒内只触发一次）─────────────────────────────────
_HEARTBEAT_THROTTLE_SECONDS = 5.0
_last_heartbeat: Dict[str, float] = {}  # workspace → last trigger timestamp
_heartbeat_lock = threading.Lock()

# 累积的员工完成事件（节流窗口内合并）
_pending_completions: Dict[str, list] = {}  # workspace → [{employee_name, summary, ...}, ...]
_pending_timers: Dict[str, threading.Timer] = {}  # workspace → Timer


def _should_trigger_heartbeat(workspace: str) -> bool:
    """判断是否应该触发心跳（节流逻辑）"""
    now = time.time()
    with _heartbeat_lock:
        last = _last_heartbeat.get(workspace, 0)
        if now - last < _HEARTBEAT_THROTTLE_SECONDS:
            return False
        _last_heartbeat[workspace] = now
        return True


def _flush_heartbeat(workspace: str) -> None:
    """节流窗口结束后，实际触发心跳通知"""
    with _heartbeat_lock:
        completions = _pending_completions.pop(workspace, [])
        _pending_timers.pop(workspace, None)
        _last_heartbeat[workspace] = time.time()

    if not completions:
        return

    # 构建心跳摘要消息
    summaries = []
    for c in completions:
        emp_name = c.get("employee_name", "未知员工")
        status = c.get("status", "completed")
        summary = (c.get("final_response") or "").strip()
        if len(summary) > 300:
            summary = summary[:300] + "…"

        if status == "completed":
            summaries.append(f"✅ **{emp_name}** 完成了任务：{summary if summary else '（无输出摘要）'}")
        else:
            summaries.append(f"⚠️ **{emp_name}** 任务结束（{status}）：{summary if summary else '（无输出）'}")

    heartbeat_text = "\n".join(summaries)

    # 向总群追加系统消息
    try:
        from api.group_chat import append_group_system_message
        append_group_system_message(
            workspace=workspace,
            message=f"💓 心跳通知：\n{heartbeat_text}",
            sender_name="heartbeat",
        )
    except Exception:
        logger.exception("[pm_heartbeat] failed to append heartbeat message to group chat")

    # 通过 SSE 推送心跳事件给前端（前端监听后触发 PM专员 AI 调度）
    try:
        from api.group_chat import get_or_create_group_chat
        gc_data = get_or_create_group_chat(workspace)
        gc_session_id = gc_data.get("session_id")
        if gc_session_id:
            _push_heartbeat_sse(workspace, gc_session_id, completions)
    except Exception:
        logger.exception("[pm_heartbeat] failed to push heartbeat SSE")


def _push_heartbeat_sse(workspace: str, gc_session_id: str, completions: list) -> None:
    """通过 LOG_SUBSCRIBERS 广播 heartbeat 事件给所有前端连接。

    前端 group-chat.js 监听 'pm_heartbeat' 类型的日志事件，
    收到后自动调用 PM专员 AI 进行调度决策。
    """
    import hashlib

    payload = {
        "event": "pm_heartbeat",
        "session_id": gc_session_id,
        "workspace": workspace,
        "completions": [
            {
                "employee_name": c.get("employee_name", ""),
                "status": c.get("status", "completed"),
                "summary": (c.get("final_response") or "")[:500],
            }
            for c in completions
        ],
        "ts": time.time(),
        "_log_id": hashlib.md5(
            f"pm_heartbeat:{workspace}:{time.time()}".encode()
        ).hexdigest()[:16],
    }

    try:
        from api.config import LOG_SUBSCRIBERS, LOG_SUBSCRIBERS_LOCK
        with LOG_SUBSCRIBERS_LOCK:
            for sub_q in list(LOG_SUBSCRIBERS):
                try:
                    sub_q.put_nowait(payload)
                except Exception:
                    pass
    except Exception:
        logger.exception("[pm_heartbeat] failed to broadcast to LOG_SUBSCRIBERS")


@on("agent.complete", async_=True)
def on_agent_complete_heartbeat(payload: dict) -> None:
    """agent.complete 事件回调：员工完成任务时累积并节流触发心跳。

    payload 期望字段：
      - workspace (str, 必填)：工作区路径
      - employee_name (str, 可选)：完成任务的员工名
      - session_id (str)：agent session ID
      - final_response (str)：agent 最终回复（截断到 2000 字符）
      - api_calls (int)
      - interrupted (bool)
    """
    workspace = (payload.get("workspace") or "").strip()
    if not workspace:
        return  # 非 WebUI 上下文

    employee_name = (payload.get("employee_name") or "").strip()
    if not employee_name:
        return  # 无员工名 → 可能是 CLI/gateway 模式

    # ★ 过滤 PM专员 自己的完成事件（避免心跳→PM回复→心跳的无限循环）
    if employee_name == "PM专员":
        return

    logger.info(
        "[pm_heartbeat] employee completed: workspace=%s, employee=%s",
        workspace, employee_name,
    )

    # 累积到 pending 列表
    completion_info = {
        "employee_name": employee_name,
        "session_id": payload.get("session_id", ""),
        "final_response": payload.get("final_response", ""),
        "status": "interrupted" if payload.get("interrupted") else "completed",
        "api_calls": payload.get("api_calls", 0),
    }

    with _heartbeat_lock:
        if workspace not in _pending_completions:
            _pending_completions[workspace] = []
        _pending_completions[workspace].append(completion_info)

        # 如果该工作区还没有 pending timer，创建一个
        if workspace not in _pending_timers:
            timer = threading.Timer(
                _HEARTBEAT_THROTTLE_SECONDS,
                _flush_heartbeat,
                args=(workspace,),
            )
            timer.daemon = True
            timer.start()
            _pending_timers[workspace] = timer
