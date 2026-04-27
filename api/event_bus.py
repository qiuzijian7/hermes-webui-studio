"""
Hermes Web UI -- Event Bus for multi-agent coordination hooks.

轻量级 in-process pub/sub，供多 agent 协同功能使用：
  - 发射点：AIAgent run_conversation / AgentRunner 生命周期
  - 订阅者：hermes-webui-studio/hooks/*.py（启动时自动导入）

设计要点：
  - 线程安全（RLock）
  - 回调默认同步调用；慢回调可以用 async=True 注册到后台线程池
  - 回调异常不会影响发射方（try/except 日志打印）
  - 6 个核心事件（见下方 EVENTS 常量）

用法示例：
    from api.event_bus import on, emit

    @on("subagent.announce")
    def echo_to_group(payload):
        # payload: {parent_id, child_session_id, status, summary, ...}
        ...

    # 发射方：
    emit("subagent.announce", {
        "parent_id": "...",
        "child_session_id": "...",
        "status": "completed",
        "summary": "...",
    })
"""

from __future__ import annotations

import logging
import threading
from concurrent.futures import ThreadPoolExecutor
from typing import Any, Callable, Dict, List

logger = logging.getLogger(__name__)


# ── 已知事件清单 ─────────────────────────────────────────────────────────────
# 发射点应使用这些常量而不是魔法字符串，便于编辑器/IDE 跳转与重构。
EVENTS = {
    "AGENT_START":         "agent.start",
    "AGENT_BEFORE_TOOL":   "agent.before_tool",
    "AGENT_AFTER_TOOL":    "agent.after_tool",
    "AGENT_COMPLETE":      "agent.complete",
    "SUBAGENT_SPAWN":      "subagent.spawn",
    "SUBAGENT_ANNOUNCE":   "subagent.announce",
}


_lock = threading.RLock()
_handlers: Dict[str, List[Dict[str, Any]]] = {}
_async_pool: ThreadPoolExecutor | None = None


def _get_async_pool() -> ThreadPoolExecutor:
    """Lazy-init 后台线程池（仅供 async=True 的 hook 使用）。"""
    global _async_pool
    if _async_pool is None:
        with _lock:
            if _async_pool is None:
                _async_pool = ThreadPoolExecutor(
                    max_workers=4, thread_name_prefix="event-bus-async"
                )
    return _async_pool


def on(event: str, *, async_: bool = False) -> Callable:
    """装饰器：注册事件回调。

    Args:
        event: 事件名（见 EVENTS 常量，如 "subagent.announce"）
        async_: True = 回调在后台线程池中执行，不阻塞 emit 调用方；
                False（默认）= 回调同步执行，emit 调用方等待。

    用法：
        @on("subagent.announce")
        def my_hook(payload): ...

        @on("agent.complete", async_=True)
        def slow_analytics_hook(payload): ...
    """
    def _decorator(fn: Callable) -> Callable:
        register(event, fn, async_=async_)
        return fn
    return _decorator


def register(event: str, handler: Callable, *, async_: bool = False) -> None:
    """程序式注册事件回调（on 装饰器的底层实现）。"""
    if not event or not callable(handler):
        raise ValueError("event must be a non-empty string and handler must be callable")
    entry = {"handler": handler, "async": bool(async_)}
    with _lock:
        _handlers.setdefault(event, []).append(entry)
    logger.debug(
        "event_bus: registered handler '%s' for event '%s' (async=%s)",
        getattr(handler, "__name__", repr(handler)), event, async_,
    )


def unregister(event: str, handler: Callable) -> bool:
    """注销已注册的回调。返回是否成功移除。"""
    with _lock:
        lst = _handlers.get(event)
        if not lst:
            return False
        for i, entry in enumerate(lst):
            if entry["handler"] is handler:
                lst.pop(i)
                return True
    return False


def emit(event: str, payload: Dict[str, Any] | None = None) -> None:
    """向所有订阅了 ``event`` 的 handler 派发 ``payload``。

    - 同步 handler：按注册顺序依次调用，异常被捕获并记录日志
    - 异步 handler：提交到线程池，不阻塞 emit 调用方

    emit 本身应当是"发射即忘"语义——调用方不关心 handler 是否成功。
    """
    payload = payload or {}
    with _lock:
        entries = list(_handlers.get(event, []))

    for entry in entries:
        handler = entry["handler"]
        if entry["async"]:
            pool = _get_async_pool()
            pool.submit(_safe_call, handler, event, payload)
        else:
            _safe_call(handler, event, payload)


def _safe_call(handler: Callable, event: str, payload: Dict[str, Any]) -> None:
    """以 try/except 包装 handler 调用，避免一个 hook 抛错影响其他。"""
    try:
        handler(payload)
    except Exception:
        logger.exception(
            "event_bus: handler '%s' for event '%s' raised an exception",
            getattr(handler, "__name__", repr(handler)), event,
        )


def handlers_for(event: str) -> List[Callable]:
    """返回给定事件的当前 handler 列表副本（用于调试/测试）。"""
    with _lock:
        return [e["handler"] for e in _handlers.get(event, [])]


def clear() -> None:
    """清空所有已注册的 handler（测试时使用）。"""
    with _lock:
        _handlers.clear()


# ── Hook 自动加载 ────────────────────────────────────────────────────────────

def load_hooks_dir(hooks_dir: str | None = None) -> int:
    """遍历 ``hooks_dir`` 下的 ``*.py`` 并 import，触发模块级别的 @on 装饰器。

    启动时调用一次即可（见 api/startup.py）。

    Args:
        hooks_dir: 默认为 ``hermes-webui-studio/hooks/``

    Returns:
        成功加载的模块数量。
    """
    import importlib.util
    from pathlib import Path

    if hooks_dir is None:
        # 默认：项目根/hooks
        hooks_dir = str(Path(__file__).resolve().parent.parent / "hooks")

    p = Path(hooks_dir)
    if not p.is_dir():
        return 0

    loaded = 0
    for fp in sorted(p.glob("*.py")):
        if fp.name.startswith("_"):
            continue
        mod_name = f"hermes_hooks.{fp.stem}"
        try:
            spec = importlib.util.spec_from_file_location(mod_name, fp)
            if spec and spec.loader:
                module = importlib.util.module_from_spec(spec)
                spec.loader.exec_module(module)  # type: ignore[union-attr]
                loaded += 1
                logger.info("event_bus: loaded hook module '%s'", fp.name)
        except Exception:
            logger.exception("event_bus: failed to load hook '%s'", fp.name)
    return loaded
