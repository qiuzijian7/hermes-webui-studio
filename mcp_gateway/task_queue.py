"""
任务队列 — Pull 模式任务分发。

MCP Gateway 将任务入队，WebUI Worker 主动拉取并执行。
避免 Gateway 回调 WebUI 的网络可达性问题（NAT 友好）。

任务生命周期：
  pending → assigned → running → completed/failed/timeout
"""
from __future__ import annotations

import json
import threading
import time
import uuid
from dataclasses import dataclass, field, asdict
from enum import Enum
from pathlib import Path
from typing import Any


class TaskStatus(str, Enum):
    PENDING = "pending"
    ASSIGNED = "assigned"
    RUNNING = "running"
    COMPLETED = "completed"
    FAILED = "failed"
    TIMEOUT = "timeout"
    CANCELLED = "cancelled"


@dataclass
class Task:
    """一个委派任务。"""
    task_id: str = field(default_factory=lambda: uuid.uuid4().hex[:12])
    message: str = ""               # 用户消息/任务描述
    skill: str = ""                 # 可选：指定使用的技能
    assigned_to: str = ""           # 空=自动选择，否则为 agent_id
    status: TaskStatus = TaskStatus.PENDING
    result: str = ""                # 执行结果
    error: str = ""                 # 错误信息
    created_at: float = field(default_factory=time.time)
    assigned_at: float = 0.0
    completed_at: float = 0.0
    timeout_seconds: int = 300
    session_id: str = ""            # WebUI 侧分配的 session_id
    metadata: dict = field(default_factory=dict)

    def to_dict(self) -> dict:
        d = asdict(self)
        d["status"] = self.status.value
        return d

    @classmethod
    def from_dict(cls, d: dict) -> "Task":
        d = d.copy()
        if "status" in d:
            d["status"] = TaskStatus(d["status"])
        return cls(**{k: v for k, v in d.items() if k in cls.__dataclass_fields__})


class TaskQueue:
    """线程安全的任务队列，支持持久化。"""

    def __init__(self, storage_path: Path | str | None = None):
        self._path = Path(storage_path) if storage_path else Path("/data/hermes-tasks.json")
        self._lock = threading.Lock()
        self._tasks: dict[str, Task] = {}
        # 等待任务完成的事件 {task_id: threading.Event}
        self._waiters: dict[str, threading.Event] = {}
        self._load()

    def _load(self) -> None:
        if self._path.exists():
            try:
                raw = json.loads(self._path.read_text(encoding="utf-8"))
                for tid, td in raw.get("tasks", {}).items():
                    self._tasks[tid] = Task.from_dict(td)
            except (json.JSONDecodeError, OSError):
                pass

    def _save(self) -> None:
        self._path.parent.mkdir(parents=True, exist_ok=True)
        payload = {
            "tasks": {tid: t.to_dict() for tid, t in self._tasks.items()},
            "updated_at": time.time(),
        }
        self._path.write_text(
            json.dumps(payload, ensure_ascii=False, indent=2),
            encoding="utf-8",
        )

    # ── 生产者侧（MCP Gateway → 创建任务）────────────────────────────────────

    def submit(self, message: str, skill: str = "", assigned_to: str = "",
               timeout_seconds: int = 300, metadata: dict | None = None) -> Task:
        """提交新任务到队列。"""
        task = Task(
            message=message,
            skill=skill,
            assigned_to=assigned_to,
            timeout_seconds=timeout_seconds,
            metadata=metadata or {},
        )
        with self._lock:
            self._tasks[task.task_id] = task
            self._waiters[task.task_id] = threading.Event()
            self._save()
        return task

    def wait_for_result(self, task_id: str, timeout: float = 300) -> Task | None:
        """同步等待任务完成，返回最终任务状态。"""
        event = self._waiters.get(task_id)
        if not event:
            with self._lock:
                return self._tasks.get(task_id)

        # 等待 Worker 完成
        completed = event.wait(timeout=timeout)

        with self._lock:
            task = self._tasks.get(task_id)
            if task and not completed:
                # 超时
                task.status = TaskStatus.TIMEOUT
                task.error = f"Task timed out after {timeout}s"
                self._save()
            # 清理 waiter
            self._waiters.pop(task_id, None)
            return task

    # ── 消费者侧（WebUI Worker → 拉取并执行）─────────────────────────────────

    def poll(self, agent_id: str) -> Task | None:
        """拉取分配给指定 agent 的 pending 任务。

        返回最早的 pending 任务（assigned_to 匹配或 assigned_to 为空）。
        任务状态变为 assigned。
        """
        with self._lock:
            now = time.time()
            for task in sorted(self._tasks.values(),
                               key=lambda t: t.created_at):
                if task.status != TaskStatus.PENDING:
                    continue
                # 超时清理
                if now - task.created_at > task.timeout_seconds:
                    task.status = TaskStatus.TIMEOUT
                    task.error = "Expired before assignment"
                    continue
                # 匹配逻辑：assigned_to 为空（任何人可接）或精确匹配
                if task.assigned_to and task.assigned_to != agent_id:
                    continue
                # 分配给此 agent
                task.status = TaskStatus.ASSIGNED
                task.assigned_to = agent_id
                task.assigned_at = now
                self._save()
                return task
            return None

    def update_status(self, task_id: str, status: TaskStatus,
                      result: str = "", error: str = "",
                      session_id: str = "") -> bool:
        """Worker 上报任务状态。"""
        with self._lock:
            task = self._tasks.get(task_id)
            if not task:
                return False
            task.status = status
            if result:
                task.result = result
            if error:
                task.error = error
            if session_id:
                task.session_id = session_id
            if status in (TaskStatus.COMPLETED, TaskStatus.FAILED, TaskStatus.TIMEOUT):
                task.completed_at = time.time()
            self._save()

        # 唤醒等待者
        if status in (TaskStatus.COMPLETED, TaskStatus.FAILED, TaskStatus.TIMEOUT):
            event = self._waiters.get(task_id)
            if event:
                event.set()

        return True

    # ── 查询 ──────────────────────────────────────────────────────────────────

    def get(self, task_id: str) -> Task | None:
        with self._lock:
            return self._tasks.get(task_id)

    def list_tasks(self, agent_id: str = "", status: str = "",
                   limit: int = 50) -> list[dict]:
        """列出任务（可按 agent_id 和状态过滤）。"""
        with self._lock:
            tasks = list(self._tasks.values())
        if agent_id:
            tasks = [t for t in tasks if t.assigned_to == agent_id]
        if status:
            tasks = [t for t in tasks if t.status.value == status]
        tasks.sort(key=lambda t: t.created_at, reverse=True)
        return [t.to_dict() for t in tasks[:limit]]

    def cleanup(self, max_age: int = 3600) -> int:
        """清理已完成且超过 max_age 秒的任务。"""
        with self._lock:
            now = time.time()
            stale = [
                tid for tid, t in self._tasks.items()
                if t.status in (TaskStatus.COMPLETED, TaskStatus.FAILED,
                                TaskStatus.TIMEOUT, TaskStatus.CANCELLED)
                and now - t.completed_at > max_age
            ]
            for tid in stale:
                del self._tasks[tid]
                self._waiters.pop(tid, None)
            if stale:
                self._save()
            return len(stale)
