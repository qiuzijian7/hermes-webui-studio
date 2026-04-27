"""
Hermes Web UI -- Agents API (async subagent status & control).

HTTP endpoints backing the frontend "Agents" panel in the right sidebar.

Endpoints:
  GET  /api/agents?session_id=<parent_sid>
       List all spawned async children for the given parent session.
  POST /api/agents/steer    body {session_id, child_session_id, message}
       Send a steer (guidance) message to a running child agent.
  POST /api/agents/cancel   body {session_id, child_session_id}
       Cancel a running child agent.

Implementation: looks up the AgentRunner via its in-process global registry
(``AgentRunner._GLOBAL_REGISTRY`` keyed on parent session_id) and forwards
the call. The AgentRunner is created on first ``spawn_agent`` tool call and
stays alive while the parent AIAgent is alive.

If the parent agent is no longer running (request finished / process restart),
the runner will be absent → clients get a 404 with a helpful message.
"""

from __future__ import annotations

import json
import logging
from typing import Any, Dict
from urllib.parse import parse_qs

from api.helpers import j, bad

logger = logging.getLogger(__name__)


def _lookup_runner(session_id: str):
    """Lookup an AgentRunner by parent session_id (None if unavailable)."""
    if not session_id:
        return None
    try:
        from tools.agent_runner import AgentRunner
    except ImportError:
        return None
    try:
        return AgentRunner.lookup(session_id)
    except Exception:
        return None


# ── GET /api/agents ─────────────────────────────────────────────────────────

def handle_list(handler, parsed) -> bool:
    """GET /api/agents?session_id=<parent_sid>

    Returns:
        {
            "ok": True,
            "session_id": "...",
            "runner_active": bool,      # True if parent agent still alive
            "children": [ {...}, ... ],  # see AgentRunner.list_children()
        }
    """
    qs = parse_qs(parsed.query)
    sid = (qs.get("session_id", [""])[0] or "").strip()
    if not sid:
        return bad(handler, "session_id is required")

    runner = _lookup_runner(sid)
    if runner is None:
        # parent agent not active — return empty list (not an error)
        return j(handler, {
            "ok": True,
            "session_id": sid,
            "runner_active": False,
            "children": [],
            "message": "No active async runner for this session (agent may have completed).",
        })

    try:
        children = runner.list_children()
    except Exception as exc:
        logger.exception("runner.list_children failed for sid=%s", sid)
        return j(handler, {"ok": False, "error": str(exc)}, status=500)

    return j(handler, {
        "ok": True,
        "session_id": sid,
        "runner_active": True,
        "children": children,
    })


# ── POST /api/agents/steer ──────────────────────────────────────────────────

def handle_steer(handler, body: Dict[str, Any]) -> bool:
    """POST /api/agents/steer

    Body:
        {
            "session_id": "parent session id",
            "child_session_id": "spawn-xxxxx",
            "message": "steer text (max 4000 chars)"
        }
    """
    sid = str(body.get("session_id") or "").strip()
    child_sid = str(body.get("child_session_id") or "").strip()
    message = str(body.get("message") or "").strip()

    if not sid:
        return bad(handler, "session_id is required")
    if not child_sid:
        return bad(handler, "child_session_id is required")
    if not message:
        return bad(handler, "message is required")

    runner = _lookup_runner(sid)
    if runner is None:
        return bad(handler, "No active async runner for this session.", status=404)

    try:
        result = runner.steer(child_sid, message)
    except Exception as exc:
        logger.exception("runner.steer failed")
        return j(handler, {"ok": False, "error": str(exc)}, status=500)

    if "error" in result:
        return j(handler, {"ok": False, **result}, status=400)
    return j(handler, {"ok": True, **result})


# ── POST /api/agents/cancel ─────────────────────────────────────────────────

def handle_cancel(handler, body: Dict[str, Any]) -> bool:
    """POST /api/agents/cancel

    Body:
        { "session_id": "...", "child_session_id": "..." }
    """
    sid = str(body.get("session_id") or "").strip()
    child_sid = str(body.get("child_session_id") or "").strip()
    if not sid:
        return bad(handler, "session_id is required")
    if not child_sid:
        return bad(handler, "child_session_id is required")

    runner = _lookup_runner(sid)
    if runner is None:
        return bad(handler, "No active async runner for this session.", status=404)

    try:
        result = runner.cancel(child_sid)
    except Exception as exc:
        logger.exception("runner.cancel failed")
        return j(handler, {"ok": False, "error": str(exc)}, status=500)

    if "error" in result:
        return j(handler, {"ok": False, **result}, status=400)
    return j(handler, {"ok": True, **result})
