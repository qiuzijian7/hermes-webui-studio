"""
实例注册表 — 管理多个 Hermes WebUI 实例的注册、心跳和发现。

存储格式（JSON 文件，可替换为 Redis）：
{
    "instances": {
        "zhangsan@DESKTOP-A1B2C3D": {
            "agent_id": "zhangsan@DESKTOP-A1B2C3D",
            "name": "张三的 Hermes",
            "url": "http://10.0.1.50:18080",
            "token": "xxx",
            "workspace": "/home/zhangsan/project",
            "model": "openai/gpt-5.4-mini",
            "skills": ["code-review", "debug"],
            "status": "idle",
            "last_heartbeat": 1714600000.0,
            "registered_at": 1714600000.0,
            "metadata": {}
        }
    }
}
"""
from __future__ import annotations

import json
import threading
import time
from pathlib import Path
from typing import Any

# ── 配置 ──────────────────────────────────────────────────────────────────────
DEFAULT_REGISTRY_FILE = Path("/data/hermes-registry.json")
HEARTBEAT_TIMEOUT = 90  # 超过此秒数未心跳则视为离线
PRUNE_INTERVAL = 30     # 自动清理间隔


class InstanceRegistry:
    """线程安全的实例注册表。"""

    def __init__(self, storage_path: Path | str | None = None):
        self._path = Path(storage_path) if storage_path else DEFAULT_REGISTRY_FILE
        self._lock = threading.Lock()
        self._data: dict[str, dict[str, Any]] = {}
        self._load()

    # ── 持久化 ────────────────────────────────────────────────────────────────

    def _load(self) -> None:
        """从磁盘加载注册表。"""
        if self._path.exists():
            try:
                raw = self._path.read_text(encoding="utf-8")
                data = json.loads(raw)
                self._data = data.get("instances", {})
            except (json.JSONDecodeError, OSError):
                self._data = {}
        else:
            self._data = {}

    def _save(self) -> None:
        """持久化注册表到磁盘。"""
        self._path.parent.mkdir(parents=True, exist_ok=True)
        payload = {"instances": self._data, "updated_at": time.time()}
        self._path.write_text(
            json.dumps(payload, ensure_ascii=False, indent=2),
            encoding="utf-8",
        )

    # ── 公共接口 ──────────────────────────────────────────────────────────────

    def register(self, agent_id: str, info: dict[str, Any]) -> dict:
        """注册或更新实例信息。"""
        with self._lock:
            now = time.time()
            existing = self._data.get(agent_id, {})
            entry = {
                "agent_id": agent_id,
                "name": info.get("name", agent_id),
                "url": info.get("url", ""),
                "token": info.get("token", ""),
                "workspace": info.get("workspace", ""),
                "model": info.get("model", ""),
                "skills": info.get("skills", []),
                "skills_detail": info.get("skills_detail", []),
                "status": info.get("status", "idle"),
                "last_heartbeat": now,
                "registered_at": existing.get("registered_at", now),
                "metadata": info.get("metadata", {}),
            }
            self._data[agent_id] = entry
            self._save()
            return entry

    def heartbeat(self, agent_id: str, status: str = "idle",
                  extra: dict | None = None) -> bool:
        """更新心跳时间戳和状态。返回 True 表示更新成功。"""
        with self._lock:
            if agent_id not in self._data:
                return False
            self._data[agent_id]["last_heartbeat"] = time.time()
            self._data[agent_id]["status"] = status
            if extra:
                self._data[agent_id].update(extra)
            self._save()
            return True

    def unregister(self, agent_id: str) -> bool:
        """注销实例。"""
        with self._lock:
            if agent_id in self._data:
                del self._data[agent_id]
                self._save()
                return True
            return False

    def get(self, agent_id: str) -> dict | None:
        """获取指定实例信息（已过滤过期实例）。"""
        with self._lock:
            self._prune_stale()
            return self._data.get(agent_id)

    def list_all(self, include_offline: bool = False) -> list[dict]:
        """列出所有在线实例。"""
        with self._lock:
            if not include_offline:
                self._prune_stale()
            return list(self._data.values())

    def select(self, skill: str = "", prefer_idle: bool = True) -> str | None:
        """选择一个可用实例（优先空闲 + 按技能匹配）。

        Returns:
            agent_id 或 None（无可用实例）
        """
        with self._lock:
            self._prune_stale()
            if not self._data:
                return None

            candidates = list(self._data.values())

            # 按技能过滤
            if skill:
                skill_lower = skill.lower()
                with_skill = [c for c in candidates
                              if any(skill_lower in s.lower() for s in c.get("skills", []))]
                if with_skill:
                    candidates = with_skill

            # 优先选空闲
            if prefer_idle:
                idle = [c for c in candidates if c.get("status") == "idle"]
                if idle:
                    candidates = idle

            # 按最近心跳排序（最活跃优先）
            candidates.sort(key=lambda x: x.get("last_heartbeat", 0), reverse=True)
            return candidates[0]["agent_id"] if candidates else None

    # ── 内部 ──────────────────────────────────────────────────────────────────

    def _prune_stale(self) -> None:
        """清理超时实例。"""
        now = time.time()
        stale = [
            aid for aid, info in self._data.items()
            if now - info.get("last_heartbeat", 0) > HEARTBEAT_TIMEOUT
        ]
        for aid in stale:
            del self._data[aid]
        if stale:
            self._save()
