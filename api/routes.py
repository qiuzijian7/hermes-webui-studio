"""
Hermes Web UI -- Route handlers for GET and POST endpoints.
Extracted from server.py (Sprint 11) so server.py is a thin shell.
"""

import html as _html
import json
import os
import queue
import sys
import threading
import time
import uuid
from pathlib import Path
from urllib.parse import parse_qs

from api.config import (
    STATE_DIR,
    SESSION_DIR,
    DEFAULT_WORKSPACE,
    DEFAULT_MODEL,
    SESSIONS,
    SESSIONS_MAX,
    LOCK,
    STREAMS,
    STREAMS_LOCK,
    CANCEL_FLAGS,
    SERVER_START_TIME,
    CLI_TOOLSETS,
    _INDEX_HTML_PATH,
    get_available_models,
    IMAGE_EXTS,
    MD_EXTS,
    MIME_MAP,
    MAX_FILE_BYTES,
    MAX_UPLOAD_BYTES,
    CHAT_LOCK,
    load_settings,
    save_settings,
    PM_NAME,
)
from api.helpers import (
    require,
    bad,
    safe_resolve,
    j,
    t,
    read_body,
    _security_headers,
    _sanitize_error,
    redact_session_data,
    _redact_text,
)

# ── CSRF: validate Origin/Referer on POST ────────────────────────────────────
import re as _re


def _check_csrf(handler) -> bool:
    """Reject cross-origin POST requests. Returns True if OK."""
    origin = handler.headers.get("Origin", "")
    referer = handler.headers.get("Referer", "")
    host = handler.headers.get("Host", "")
    if not origin and not referer:
        return True  # non-browser clients (curl, agent) have no Origin
    target = origin or referer
    # Extract host:port from origin/referer
    m = _re.match(r"^https?://([^/]+)", target)
    if not m:
        return False
    origin_host = m.group(1)
    # Allow same-origin: check Host, X-Forwarded-Host (reverse proxy), and
    # X-Real-Host against the origin. Reverse proxies (Caddy, nginx) set
    # X-Forwarded-Host to the client's original Host header.
    allowed_hosts = {
        h.strip()
        for h in [
            host,
            handler.headers.get("X-Forwarded-Host", ""),
            handler.headers.get("X-Real-Host", ""),
        ]
        if h.strip()
    }
    if origin_host in allowed_hosts:
        return True
    return False


from api.models import (
    Session,
    get_session,
    new_session,
    all_sessions,
    title_from,
    _write_session_index,
    SESSION_INDEX_FILE,
    load_projects,
    save_projects,
    import_cli_session,
    get_cli_sessions,
    get_cli_session_messages,
)
from api.workspace import (
    load_workspaces,
    save_workspaces,
    get_last_workspace,
    set_last_workspace,
    list_dir,
    read_file_content,
    safe_resolve_ws,
)
from api.upload import handle_upload
from api.streaming import _sse, _run_agent_streaming, cancel_stream
from api.config import LOG_SUBSCRIBERS, LOG_SUBSCRIBERS_LOCK, LOG_MAX_SUBSCRIBERS, _LOG_HISTORY, _LOG_HISTORY_LOCK

import hashlib
from api.onboarding import (
    apply_onboarding_setup,
    get_onboarding_status,
    complete_onboarding,
)

# Approval system (optional -- graceful fallback if agent not available)
try:
    from tools.approval import (
        submit_pending,
        approve_session,
        approve_permanent,
        save_permanent_allowlist,
        is_approved,
        _pending,
        _lock,
        _permanent_approved,
        resolve_gateway_approval,
    )
except ImportError:
    submit_pending = lambda *a, **k: None
    approve_session = lambda *a, **k: None
    approve_permanent = lambda *a, **k: None
    save_permanent_allowlist = lambda *a, **k: None
    is_approved = lambda *a, **k: True
    resolve_gateway_approval = lambda *a, **k: 0
    _pending = {}
    _lock = threading.Lock()
    _permanent_approved = set()


# ── Global log broadcast helper ──────────────────────────────────────────────
# Used for non-streaming events (user input, delegation, etc.) that need to
# appear in the unified log panel alongside token/tool/done events.
def _broadcast_log_event(event: str, data: dict, session_id: str = "", employee_name: str = ""):
    """Broadcast a log event to all connected log panel subscribers and store in history."""
    try:
        log_entry = dict(data)
        log_entry['event'] = event
        log_entry['session_id'] = session_id
        log_entry['employee_name'] = employee_name or ''
        log_entry['ts'] = time.time()
        # Generate unique ID for frontend deduplication
        _id_content = f"{event}:{session_id}:{log_entry.get('text','')}:{log_entry.get('message','')}:{log_entry.get('name','')}"
        log_entry['_log_id'] = hashlib.md5(_id_content.encode()).hexdigest()[:16]
        with _LOG_HISTORY_LOCK:
            # Deduplication: if the last entry has the same _log_id, replace it instead of appending
            if _LOG_HISTORY and _LOG_HISTORY[-1].get('_log_id') == log_entry['_log_id']:
                _LOG_HISTORY[-1] = log_entry
            else:
                _LOG_HISTORY.append(log_entry)
        with LOG_SUBSCRIBERS_LOCK:
            for sub_q in list(LOG_SUBSCRIBERS):
                try:
                    sub_q.put_nowait(log_entry)
                except Exception:
                    pass
    except Exception:
        pass


# ── Login page locale strings ─────────────────────────────────────────────────
# Add entries here to support more languages on the login page.
# The key must match the 'language' setting value (from static/i18n.js LOCALES).
_LOGIN_LOCALE = {
    "en": {
        "lang": "en",
        "title": "Sign in",
        "subtitle": "Enter your password to continue",
        "placeholder": "Password",
        "btn": "Sign in",
        "invalid_pw": "Invalid password",
        "conn_failed": "Connection failed",
    },
    "zh": {
        "lang": "zh-CN",
        "title": "\u767b\u5f55",
        "subtitle": "\u8f93\u5165\u5bc6\u7801\u7ee7\u7eed\u4f7f\u7528",
        "placeholder": "\u5bc6\u7801",
        "btn": "\u767b\u5f55",
        "invalid_pw": "\u5bc6\u7801\u9519\u8bef",
        "conn_failed": "\u8fde\u63a5\u5931\u8d25",
    },
}

# ── Login page (self-contained, no external deps) ────────────────────────────
_LOGIN_PAGE_HTML = """<!doctype html>
<html lang="{{LANG}}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>{{BOT_NAME}} — {{LOGIN_TITLE}}</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{background:#1a1a2e;color:#e8e8f0;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",system-ui,sans-serif;
  height:100vh;display:flex;align-items:center;justify-content:center}
.card{background:#16213e;border:1px solid rgba(255,255,255,.08);border-radius:16px;padding:36px 32px;
  width:320px;text-align:center;box-shadow:0 8px 32px rgba(0,0,0,.3)}
.logo{width:48px;height:48px;border-radius:12px;background:linear-gradient(145deg,#e8a030,#e94560);
  display:flex;align-items:center;justify-content:center;font-weight:800;font-size:20px;color:#fff;
  margin:0 auto 12px;box-shadow:0 2px 12px rgba(233,69,96,.3)}
h1{font-size:18px;font-weight:600;margin-bottom:4px}
.sub{font-size:12px;color:#8888aa;margin-bottom:24px}
input{width:100%;padding:10px 14px;border-radius:10px;border:1px solid rgba(255,255,255,.1);
  background:rgba(255,255,255,.04);color:#e8e8f0;font-size:14px;outline:none;margin-bottom:14px;
  transition:border-color .15s}
input:focus{border-color:rgba(124,185,255,.5);box-shadow:0 0 0 3px rgba(124,185,255,.1)}
button{width:100%;padding:10px;border-radius:10px;border:none;background:rgba(124,185,255,.15);
  border:1px solid rgba(124,185,255,.3);color:#7cb9ff;font-size:14px;font-weight:600;cursor:pointer;
  transition:all .15s}
button:hover{background:rgba(124,185,255,.25)}
.err{color:#e94560;font-size:12px;margin-top:10px;display:none}
</style></head><body>
<div class="card">
  <div class="logo">{{BOT_NAME_INITIAL}}</div>
  <h1>{{BOT_NAME}}</h1>
  <p class="sub">{{LOGIN_SUBTITLE}}</p>
  <form id="login-form" data-invalid-pw="{{LOGIN_INVALID_PW}}" data-conn-failed="{{LOGIN_CONN_FAILED}}">
    <input type="password" id="pw" placeholder="{{LOGIN_PLACEHOLDER}}" autofocus>
    <button type="submit">{{LOGIN_BTN}}</button>
  </form>
  <div class="err" id="err"></div>
</div>
<script src="/static/login.js"></script>
</body></html>"""

# ── GET routes ────────────────────────────────────────────────────────────────


def handle_get(handler, parsed) -> bool:
    """Handle all GET routes. Returns True if handled, False for 404."""

    if parsed.path in ("/", "/index.html"):
        return t(
            handler,
            _INDEX_HTML_PATH.read_text(encoding="utf-8"),
            content_type="text/html; charset=utf-8",
        )

    if parsed.path == "/login":
        _settings = load_settings()
        _bn = _html.escape(_settings.get("bot_name") or "Hermes")
        _lang = _settings.get("language", "en")
        _login_strings = _LOGIN_LOCALE.get(_lang, _LOGIN_LOCALE["en"])
        _page = (
            _LOGIN_PAGE_HTML.replace("{{BOT_NAME}}", _bn)
            .replace("{{BOT_NAME_INITIAL}}", _bn[0].upper())
            .replace("{{LANG}}", _html.escape(_login_strings["lang"]))
            .replace("{{LOGIN_TITLE}}", _html.escape(_login_strings["title"]))
            .replace("{{LOGIN_SUBTITLE}}", _html.escape(_login_strings["subtitle"]))
            .replace(
                "{{LOGIN_PLACEHOLDER}}", _html.escape(_login_strings["placeholder"])
            )
            .replace("{{LOGIN_BTN}}", _html.escape(_login_strings["btn"]))
            .replace("{{LOGIN_INVALID_PW}}", _html.escape(_login_strings["invalid_pw"]))
            .replace(
                "{{LOGIN_CONN_FAILED}}", _html.escape(_login_strings["conn_failed"])
            )
        )
        return t(handler, _page, content_type="text/html; charset=utf-8")

    if parsed.path == "/api/auth/status":
        from api.auth import is_auth_enabled, parse_cookie, verify_session

        logged_in = False
        if is_auth_enabled():
            cv = parse_cookie(handler)
            logged_in = bool(cv and verify_session(cv))
        return j(handler, {"auth_enabled": is_auth_enabled(), "logged_in": logged_in})

    if parsed.path == "/favicon.ico":
        handler.send_response(204)
        handler.end_headers()
        return True

    if parsed.path == "/health":
        with STREAMS_LOCK:
            n_streams = len(STREAMS)
        return j(
            handler,
            {
                "status": "ok",
                "sessions": len(SESSIONS),
                "active_streams": n_streams,
                "uptime_seconds": round(time.time() - SERVER_START_TIME, 1),
            },
        )

    if parsed.path == "/api/models":
        return j(handler, get_available_models())

    if parsed.path == "/api/settings":
        settings = load_settings()
        # Never expose the stored password hash or sensitive tokens to clients
        settings.pop("password_hash", None)
        try:
            from api.config import _SETTINGS_SENSITIVE_KEYS
            for _sk in _SETTINGS_SENSITIVE_KEYS:
                if _sk in settings and settings[_sk]:
                    settings[_sk] = "●●●●"  # mask value, frontend uses placeholder
        except ImportError:
            pass
        return j(handler, settings)

    # ── Config file (GET / POST) ────────────────────────────────────────
    if parsed.path == "/api/config":
        # GET: return full config (with sensitive keys masked)
        if handler.command == "GET":
            from api.config import get_config
            config = get_config()
            # Mask sensitive keys
            _SENSITIVE_KEYS = {"api_key", "password", "token", "secret"}
            def _mask_sensitive(obj, depth=0):
                if depth > 10:  # prevent infinite recursion
                    return obj
                if isinstance(obj, dict):
                    return {k: "●●●●" if k.lower() in _SENSITIVE_KEYS else _mask_sensitive(v, depth+1) for k, v in obj.items()}
                elif isinstance(obj, list):
                    return [_mask_sensitive(item, depth+1) for item in obj]
                else:
                    return obj
            masked_config = _mask_sensitive(config)
            return j(handler, masked_config)
    
    # ── Local CLI backends (OpenClaw-style): wrap local AI CLIs as providers ──
    if parsed.path == "/api/cli/backends":
        from api.config import get_config
        cfg = get_config()
        backends = cfg.get("cli_backends") or {}
        if not isinstance(backends, dict):
            backends = {}
        # Return as ordered list for stable UI rendering
        items = []
        for name, data in backends.items():
            if not isinstance(data, dict):
                continue
            items.append({"name": str(name), **data})
        return j(handler, {"backends": items})


    if parsed.path == "/api/providers":
        from api.config import get_config, reload_config
        reload_config()
        cfg = get_config()
        providers = []
        # Read from both legacy custom_providers and newer providers dict
        cp = cfg.get("custom_providers")
        if isinstance(cp, list):
            for entry in cp:
                if isinstance(entry, dict):
                    providers.append({
                        "name": entry.get("name", ""),
                        "base_url": entry.get("base_url", ""),
                        "api_key": entry.get("api_key", ""),
                        "api_mode": entry.get("api_mode", ""),
                        "model": entry.get("model", ""),
                    })
        prov = cfg.get("providers")
        if isinstance(prov, dict):
            for key, entry in prov.items():
                if isinstance(entry, dict):
                    providers.append({
                        "name": entry.get("name", key),
                        "base_url": entry.get("base_url", ""),
                        "api_key": entry.get("api_key", ""),
                        "api_mode": entry.get("api_mode", ""),
                        "model": entry.get("model", ""),
                    })
        # Deduplicate by name
        seen = set()
        deduped = []
        for p in providers:
            name = p.get("name", "")
            if name and name not in seen:
                seen.add(name)
                deduped.append(p)
        # Built-in providers supported by Hermes
        from api.config import _PROVIDER_DISPLAY
        built_in = [{"id": k, "name": v} for k, v in _PROVIDER_DISPLAY.items()]
        return j(handler, {"providers": deduped, "built_in_providers": built_in})

    if parsed.path == "/api/onboarding/status":
        return j(handler, get_onboarding_status())

    if parsed.path.startswith("/static/"):
        return _serve_static(handler, parsed)

    if parsed.path == "/api/session":
        sid = parse_qs(parsed.query).get("session_id", [""])[0]
        if not sid:
            return j(handler, {"error": "session_id is required"}, status=400)
        try:
            s = get_session(sid)
            raw = s.compact() | {
                "messages": s.messages,
                "tool_calls": getattr(s, "tool_calls", []),
            }
            return j(handler, {"session": redact_session_data(raw)})
        except KeyError:
            # Not a WebUI session -- try CLI store
            msgs = get_cli_session_messages(sid)
            if msgs:
                cli_meta = None
                for cs in get_cli_sessions():
                    if cs["session_id"] == sid:
                        cli_meta = cs
                        break
                sess = {
                    "session_id": sid,
                    "title": (cli_meta or {}).get("title", "CLI Session"),
                    "workspace": (cli_meta or {}).get("workspace", ""),
                    "model": (cli_meta or {}).get("model", "unknown"),
                    "message_count": len(msgs),
                    "created_at": (cli_meta or {}).get("created_at", 0),
                    "updated_at": (cli_meta or {}).get("updated_at", 0),
                    "pinned": False,
                    "archived": False,
                    "project_id": None,
                    "profile": (cli_meta or {}).get("profile"),
                    "is_cli_session": True,
                    "messages": msgs,
                    "tool_calls": [],
                }
                return j(handler, {"session": redact_session_data(sess)})
            return bad(handler, "Session not found", 404)

    if parsed.path == "/api/sessions":
        webui_sessions = all_sessions()
        settings = load_settings()
        if settings.get("show_cli_sessions"):
            cli = get_cli_sessions()
            webui_ids = {s["session_id"] for s in webui_sessions}
            deduped_cli = [s for s in cli if s["session_id"] not in webui_ids]
        else:
            deduped_cli = []
        merged = webui_sessions + deduped_cli
        merged.sort(key=lambda s: s.get("updated_at", 0) or 0, reverse=True)
        return j(handler, {"sessions": merged, "cli_count": len(deduped_cli)})

    if parsed.path == "/api/projects":
        return j(handler, {"projects": load_projects()})

    if parsed.path == "/api/session/export":
        return _handle_session_export(handler, parsed)

    if parsed.path == "/api/workspaces":
        return j(
            handler, {"workspaces": load_workspaces(), "last": get_last_workspace()}
        )

    # ── Employee filesystem API (GET) ──
    if parsed.path == "/api/employees":
        return _handle_employees_list(handler, parsed)

    if parsed.path == "/api/employee":
        return _handle_employee_get(handler, parsed)

    if parsed.path == "/api/employee/files":
        return _handle_employee_files(handler, parsed)

    # ── Employee templates API (GET) ──
    if parsed.path == "/api/employee-templates":
        return _handle_employee_templates_list(handler, parsed)

    if parsed.path == "/api/employee-templates/manifest":
        return _handle_employee_templates_manifest(handler, parsed)

    # ── Team templates API (GET) ──
    if parsed.path == "/api/team-templates":
        return _handle_team_templates_list(handler, parsed)

    if parsed.path == "/api/team-templates/manifest":
        return _handle_team_templates_manifest(handler, parsed)

    if parsed.path == "/api/sessions/search":
        return _handle_sessions_search(handler, parsed)

    # ── Coordinator (协调员) GET — DEPRECATED: 前端已迁移到 PM session API，此路由仅供内部兼容 ──
    if parsed.path == "/api/group-chat":
        return _handle_group_chat_get(handler, parsed)

    # ── Workspace Manager (集中化工作区管理) GET ──
    if parsed.path == "/api/ws-manager/list":
        return _handle_ws_manager_list(handler, parsed)

    if parsed.path == "/api/ws-manager/get":
        return _handle_ws_manager_get(handler, parsed)

    if parsed.path == "/api/ws-manager/employees":
        return _handle_ws_manager_employees(handler, parsed)

    if parsed.path == "/api/ws-manager/connections":
        return _handle_ws_manager_connections_get(handler, parsed)

    if parsed.path == "/api/ws-manager/files":
        return _handle_ws_manager_files(handler, parsed)

    # ── Workflow templates (多 agent 协同) ──
    if parsed.path == "/api/workflows":
        from api.workflow import handle_list as _wf_list
        return _wf_list(handler, parsed)

    if parsed.path == "/api/workflow":
        from api.workflow import handle_detail as _wf_detail
        return _wf_detail(handler, parsed)

    # ── Prompt builder config (分段模板配置，供前端展示) ──
    if parsed.path == "/api/prompt/config":
        from api.prompt_builder import handle_config as _pb_config
        return _pb_config(handler, parsed)

    # ── Skill resolver (员工技能三源解析) ──
    if parsed.path == "/api/employee/skills/resolve":
        from api.skill_resolver import handle_resolve as _sr_resolve
        return _sr_resolve(handler, parsed)

    # ── Global skills library listing ──
    if parsed.path == "/api/skills/global/list":
        from api.skill_resolver import handle_list_global as _sr_list
        return _sr_list(handler, parsed)

    # ── Employee / Workspace scripts 列表 ──
    if parsed.path == "/api/script/list":
        from api.employee_scripts import handle_script_list as _es_list
        return _es_list(handler, parsed)

    # ── Async subagent status (由 spawn_agent 产生的子 agent 控制面板) ──
    if parsed.path == "/api/agents":
        from api.agents import handle_list as _ag_list
        return _ag_list(handler, parsed)

    # ── Delegation: child sessions for a given parent ──
    if parsed.path == "/api/delegation/children":
        return _handle_delegation_children(handler, parsed)

    if parsed.path == "/api/delegation/history":
        return _handle_delegation_history(handler, parsed)

    if parsed.path == "/api/list":
        return _handle_list_dir(handler, parsed)

    if parsed.path == "/api/browse-dir":
        return _handle_browse_dir(handler, parsed)

    if parsed.path == "/api/path-maps":
        return _handle_path_maps(handler)

    if parsed.path == "/api/host/open":
        return _handle_host_open(handler, parsed)

    # ★ P0/P1/P3: 浏览器面板支持
    if parsed.path == "/api/browser/shot":
        return _handle_browser_shot(handler, parsed)
    if parsed.path == "/api/browser/continue/pending":
        return _handle_browser_continue_pending(handler, parsed)
    # ★ P5: 外部员工包（Agent Packs）
    if parsed.path == "/api/agent-packs":
        return _handle_agent_packs_list(handler)
    if parsed.path.startswith("/api/agent-packs/") and parsed.path.endswith("/definition"):
        return _handle_agent_pack_definition(handler, parsed)
    if parsed.path.startswith("/api/agent-packs/ui/"):
        return _handle_agent_pack_ui_asset(handler, parsed)

    if parsed.path == "/api/pick-folder":
        return _handle_pick_folder(handler, parsed)

    if parsed.path == "/api/personalities":
        # Read personalities from config.yaml agent.personalities section
        # (matches hermes-agent CLI behavior, not filesystem SOUL.md approach)
        from api.config import reload_config as _reload_cfg

        _reload_cfg()  # pick up config.yaml changes without server restart
        from api.config import get_config as _get_cfg

        _cfg = _get_cfg()
        agent_cfg = _cfg.get("agent", {})
        raw_personalities = agent_cfg.get("personalities", {})
        personalities = []
        if isinstance(raw_personalities, dict):
            for name, value in raw_personalities.items():
                desc = ""
                if isinstance(value, dict):
                    desc = value.get("description", "")
                elif isinstance(value, str):
                    desc = value[:80] + ("..." if len(value) > 80 else "")
                personalities.append({"name": name, "description": desc})
        return j(handler, {"personalities": personalities})

    if parsed.path == "/api/git-info":
        qs = parse_qs(parsed.query)
        sid = qs.get("session_id", [""])[0]
        if not sid:
            return bad(handler, "session_id required")
        try:
            s = get_session(sid)
        except KeyError:
            return bad(handler, "Session not found", 404)
        from api.workspace import git_info_for_workspace

        info = git_info_for_workspace(Path(s.workspace))
        return j(handler, {"git": info})

    if parsed.path == "/api/git-changes":
        qs = parse_qs(parsed.query)
        sid = qs.get("session_id", [""])[0]
        if not sid:
            return bad(handler, "session_id required")
        try:
            s = get_session(sid)
        except KeyError:
            return bad(handler, "Session not found", 404)
        from api.workspace import git_changes_for_workspace

        data = git_changes_for_workspace(Path(s.workspace))
        return j(handler, data or {"is_git": False})

    if parsed.path == "/api/git-diff":
        qs = parse_qs(parsed.query)
        sid = qs.get("session_id", [""])[0]
        path = qs.get("path", [""])[0]
        if not sid:
            return bad(handler, "session_id required")
        if not path:
            return bad(handler, "path required")
        try:
            s = get_session(sid)
        except KeyError:
            return bad(handler, "Session not found", 404)
        from api.workspace import git_diff_for_path

        diff = git_diff_for_path(Path(s.workspace), path)
        return j(handler, {"diff": diff, "path": path})

    # ── AI 变更追踪 API ────────────────────────────────────────────────────────
    if parsed.path == "/api/ai-changes":
        qs = parse_qs(parsed.query)
        sid = qs.get("session_id", [""])[0]
        if not sid:
            return bad(handler, "session_id required")
        try:
            s = get_session(sid)
        except KeyError:
            return bad(handler, "Session not found", 404)
        from api.ai_changes import get_changes_summary
        summary = get_changes_summary(sid)
        return j(handler, summary)

    if parsed.path == "/api/ai-changes/detail":
        qs = parse_qs(parsed.query)
        sid = qs.get("session_id", [""])[0]
        change_id = qs.get("change_id", [""])[0]
        if not sid:
            return bad(handler, "session_id required")
        if not change_id:
            return bad(handler, "change_id required")
        try:
            s = get_session(sid)
        except KeyError:
            return bad(handler, "Session not found", 404)
        from api.ai_changes import get_change_diff
        entry = get_change_diff(sid, change_id)
        if not entry:
            return bad(handler, "Change not found", 404)
        return j(handler, entry)

    if parsed.path == "/api/updates/check":
        settings = load_settings()
        if not settings.get("check_for_updates", True):
            return j(handler, {"disabled": True})
        qs = parse_qs(parsed.query)
        force = qs.get("force", ["0"])[0] == "1"
        # ?simulate=1 returns fake behind counts for UI testing (localhost only)
        if (
            qs.get("simulate", ["0"])[0] == "1"
            and handler.client_address[0] == "127.0.0.1"
        ):
            return j(
                handler,
                {
                    "webui": {
                        "name": "webui",
                        "behind": 3,
                        "current_sha": "abc1234",
                        "latest_sha": "def5678",
                        "branch": "master",
                    },
                    "agent": {
                        "name": "agent",
                        "behind": 1,
                        "current_sha": "aaa0001",
                        "latest_sha": "bbb0002",
                        "branch": "master",
                    },
                    "checked_at": 0,
                },
            )
        from api.updates import check_for_updates

        return j(handler, check_for_updates(force=force))

    if parsed.path == "/api/chat/stream/status":
        stream_id = parse_qs(parsed.query).get("stream_id", [""])[0]
        from api.config import STREAM_HISTORY
        # active=True 意味着：流仍在跑 (STREAMS 里) 或刚结束且历史仍可回放 (STREAM_HISTORY 里)
        is_running = stream_id in STREAMS
        has_history = stream_id in STREAM_HISTORY
        return j(handler, {
            "active": is_running,
            "replayable": has_history and not is_running,
            "stream_id": stream_id,
        })

    if parsed.path == "/api/chat/cancel":
        stream_id = parse_qs(parsed.query).get("stream_id", [""])[0]
        if not stream_id:
            return bad(handler, "stream_id required")
        cancelled = cancel_stream(stream_id)
        return j(handler, {"ok": True, "cancelled": cancelled, "stream_id": stream_id})

    if parsed.path == "/api/chat/stream":
        return _handle_sse_stream(handler, parsed)

    if parsed.path == "/api/logs/stream":
        return _handle_logs_sse_stream(handler)

    if parsed.path == '/api/sessions/gateway/stream':
        return _handle_gateway_sse_stream(handler)

    if parsed.path == "/api/file/raw":
        return _handle_file_raw(handler, parsed)

    if parsed.path == "/api/file":
        return _handle_file_read(handler, parsed)

    if parsed.path == "/api/approval/pending":
        return _handle_approval_pending(handler, parsed)

    if parsed.path == "/api/approval/inject_test":
        # Loopback-only: used by automated tests; blocked from any remote client
        if handler.client_address[0] != "127.0.0.1":
            return j(handler, {"error": "not found"}, status=404)
        return _handle_approval_inject(handler, parsed)

    # ── Cron API (GET) ──
    if parsed.path == "/api/crons":
        from cron.jobs import list_jobs

        return j(handler, {"jobs": list_jobs(include_disabled=True)})

    if parsed.path == "/api/crons/output":
        return _handle_cron_output(handler, parsed)

    if parsed.path == "/api/crons/recent":
        return _handle_cron_recent(handler, parsed)

    # ── Knot AG-UI local tools API (GET) ──
    if parsed.path == "/api/agui/tools":
        qs = parse_qs(parsed.query)
        workspace = qs.get("workspace", [""])[0]
        emp_name = qs.get("employee", [""])[0]
        try:
            from api.knot_agui_tools import get_all_available_tools, get_employee_toolsets
            employee_obj = None
            if emp_name and workspace:
                try:
                    from api.employee_fs import get_employee
                    employee_obj = get_employee(workspace, emp_name)
                except Exception:
                    pass
            emp_enabled, emp_disabled = get_employee_toolsets(employee_obj)
            tools = get_all_available_tools(
                employee=employee_obj,
                workspace=workspace,
                enabled_toolsets=emp_enabled,
                disabled_toolsets=emp_disabled,
            )
            return j(handler, {
                "ok": True,
                "tools": tools,
                "total": len(tools),
                "hermes_tools": sum(1 for t in tools if not t["name"].startswith("hermes_skill_")),
                "skill_tools": sum(1 for t in tools if t["name"].startswith("hermes_skill_")),
            })
        except Exception as _e:
            return j(handler, {"ok": False, "error": str(_e)}, status=500)

    # ── Skills API (GET) ──
    if parsed.path == "/api/skills":
        from tools.skills_tool import skills_list as _skills_list

        raw = _skills_list()
        data = json.loads(raw) if isinstance(raw, str) else raw
        return j(handler, {"skills": data.get("skills", [])})

    if parsed.path == "/api/skills/content":
        from tools.skills_tool import skill_view as _skill_view, SKILLS_DIR

        qs = parse_qs(parsed.query)
        name = qs.get("name", [""])[0]
        if not name:
            return j(handler, {"error": "name required"}, status=400)
        file_path = qs.get("file", [""])[0]
        if file_path:
            # Serve a linked file from the skill directory
            import re as _re

            if _re.search(r"[*?\[\]]", name):
                return bad(handler, "Invalid skill name", 400)
            skill_dir = None
            for p in SKILLS_DIR.rglob(name):
                if p.is_dir():
                    skill_dir = p
                    break
            if not skill_dir:
                return bad(handler, "Skill not found", 404)
            target = (skill_dir / file_path).resolve()
            try:
                target.relative_to(skill_dir.resolve())
            except ValueError:
                return bad(handler, "Invalid file path", 400)
            if not target.exists() or not target.is_file():
                return bad(handler, "File not found", 404)
            return j(
                handler,
                {"content": target.read_text(encoding="utf-8"), "path": file_path},
            )
        raw = _skill_view(name)
        data = json.loads(raw) if isinstance(raw, str) else raw
        if "linked_files" not in data:
            data["linked_files"] = {}
        return j(handler, data)

    # ── Memory API (GET) ──
    if parsed.path == "/api/memory":
        return _handle_memory_read(handler)

    # ── Profile API (GET) ──
    if parsed.path == "/api/profiles":
        from api.profiles import list_profiles_api, get_active_profile_name

        return j(
            handler,
            {"profiles": list_profiles_api(), "active": get_active_profile_name()},
        )

    if parsed.path == "/api/profile/active":
        from api.profiles import get_active_profile_name, get_active_hermes_home

        return j(
            handler,
            {"name": get_active_profile_name(), "path": str(get_active_hermes_home())},
        )

    return False  # 404


# ── POST routes ───────────────────────────────────────────────────────────────


def handle_post(handler, parsed) -> bool:
    """Handle all POST routes. Returns True if handled, False for 404."""
    print(f"[POST] path={parsed.path}", file=sys.stderr, flush=True)
    # CSRF: reject cross-origin browser requests
    if not _check_csrf(handler):
        print(f"[POST] CSRF REJECTED path={parsed.path}", file=sys.stderr, flush=True)
        return j(handler, {"error": "Cross-origin request rejected"}, status=403)

    if parsed.path == "/api/upload":
        return handle_upload(handler)

    body = read_body(handler)
    print(f"[POST] path={parsed.path} body_keys={list(body.keys())[:5]}", file=sys.stderr, flush=True)

    # ── Config file (POST) ────────────────────────────────────────
    if parsed.path == "/api/config":
        # POST: save config updates
        if not isinstance(body, dict):
            return bad(handler, "Invalid request body")

        try:
            from api.config import save_config
            updated = save_config(body)
            # Mask sensitive keys in response
            _SENSITIVE_KEYS = {"api_key", "password", "token", "secret"}
            def _mask_sensitive(obj, depth=0):
                if depth > 10:
                    return obj
                if isinstance(obj, dict):
                    return {k: "●●●●" if k.lower() in _SENSITIVE_KEYS else _mask_sensitive(v, depth+1) for k, v in obj.items()}
                elif isinstance(obj, list):
                    return [_mask_sensitive(item, depth+1) for item in obj]
                else:
                    return obj
            masked = _mask_sensitive(updated)
            return j(handler, {"ok": True, "config": masked})
        except Exception as e:
            return bad(handler, f"Failed to save config: {str(e)}")

    # ── Knot-CLI management API ────────────────────────────────
    if parsed.path == "/api/knot-cli/check-git-bash":
        """Check if Git Bash is available (needed for knot-cli install on Windows)."""
        try:
            from api.knot_agui import check_git_bash
            result = check_git_bash()
            return j(handler, {"ok": True, **result})
        except Exception as e:
            return j(handler, {"ok": False, "error": str(e)}, status=500)

    if parsed.path == "/api/knot-cli/status":
        """Check knot-cli installation status and workspace registration."""
        try:
            from api.knot_agui import (
                _get_knot_cli_path,
                get_connection_uuid,
                check_git_bash,
            )

            workspace = str(body.get("workspace", "")).strip() or "."

            # Check knot-cli installation
            cli_path = _get_knot_cli_path()
            installed = cli_path is not None

            # Check Git Bash availability (relevant on Windows)
            git_bash_info = check_git_bash()

            print(f"[knot-status] installed={installed} cli_path={cli_path} workspace={workspace} git_bash={git_bash_info.get('available')}", flush=True)

            result = {
                "ok": True,
                "installed": installed,
                "cli_path": cli_path or "",
                "git_bash_available": git_bash_info.get("available", False),
                "git_bash_path": git_bash_info.get("path", ""),
                "git_bash_message": git_bash_info.get("message", ""),
            }

            # If installed, try to get connection_uuid for workspace
            if installed:
                try:
                    connection_uuid = get_connection_uuid(workspace)
                    print(f"[knot-status] connection_uuid={connection_uuid[:20] if connection_uuid else 'EMPTY'}", flush=True)
                except Exception as uuid_err:
                    print(f"[knot-status] get_connection_uuid error: {uuid_err}", flush=True)
                    connection_uuid = ""
                result["connection_uuid"] = connection_uuid
                result["workspace"] = workspace
            else:
                result["connection_uuid"] = ""
                result["workspace"] = ""

            return j(handler, result)
        except Exception as e:
            print(f"[knot-status] Exception: {e}", flush=True)
            import traceback; traceback.print_exc()
            return j(handler, {"ok": False, "error": str(e)}, status=500)

    if parsed.path == "/api/knot-cli/install":
        """Install knot-cli programmatically.
        
        Requires Git Bash on Windows for fresh installation.
        Returns connection_uuid on success.
        """
        try:
            from api.knot_agui import ensure_knot_cli, ensure_workspace, check_git_bash, _get_knot_cli_path

            workspace = str(body.get("workspace", "")).strip() or "."
            token = str(body.get("token", "")).strip()

            if not token:
                return j(handler, {"ok": False, "error": "token is required for installation"}, status=400)

            # Check if knot-cli is already installed
            existing_cli = _get_knot_cli_path()
            
            # If not installed, check Git Bash availability on Windows
            if not existing_cli:
                git_bash_info = check_git_bash()
                if not git_bash_info["available"]:
                    return j(handler, {
                        "ok": False,
                        "error": "需要安装 Git Bash",
                        "need_git_bash": True,
                        "message": git_bash_info["message"],
                        "download_url": "https://git-scm.com/download/win"
                    }, status=400)

            # Ensure knot-cli is installed
            cli_path = ensure_knot_cli(workspace, token)
            if not cli_path:
                return j(handler, {"ok": False, "error": "Failed to install knot-cli"}, status=500)

            # Ensure workspace is registered
            connection_uuid = ensure_workspace(workspace, token)

            return j(handler, {
                "ok": True,
                "cli_path": cli_path,
                "connection_uuid": connection_uuid,
                "workspace": workspace,
            })
        except Exception as e:
            return j(handler, {"ok": False, "error": str(e)}, status=500)

    if parsed.path == "/api/knot-cli/workspace/create":
        """Create or get workspace registration and return connection_uuid."""
        try:
            from api.knot_agui import ensure_workspace, _get_knot_cli_path
            from api.config import load_settings

            workspace = str(body.get("workspace", "")).strip() or "."
            token = str(body.get("token", "")).strip()

            print(f"[knot-workspace] Creating workspace: {workspace}", flush=True)

            # 如果请求体中没有 token，从配置文件读取
            if not token:
                try:
                    settings = load_settings()
                    token = settings.get("knot_agui_token", "")
                    print(f"[knot-workspace] Loaded token from config: {len(token)} chars", flush=True)
                except Exception as e:
                    print(f"[knot-workspace] Failed to load token from config: {e}", flush=True)
                    pass

            # Check if knot-cli is installed
            cli_path = _get_knot_cli_path()
            print(f"[knot-workspace] knot-cli path: {cli_path}", flush=True)
            if not cli_path:
                print(f"[knot-workspace] knot-cli not installed", flush=True)
                return j(handler, {"ok": False, "error": "knot-cli not installed"}, status=400)

            # Ensure workspace is registered
            connection_uuid = ""
            error_msg = ""
            try:
                print(f"[knot-workspace] Calling ensure_workspace...", flush=True)
                connection_uuid = ensure_workspace(workspace, token)
                print(f"[knot-workspace] ensure_workspace returned: uuid={connection_uuid[:20] if connection_uuid else 'EMPTY'}", flush=True)
            except Exception as e:
                error_msg = str(e)
                print(f"[knot-cli] Warning: workspace registration failed: {e}", flush=True)

            # Return result based on connection_uuid
            if connection_uuid:
                print(f"[knot-workspace] Success: connection_uuid={connection_uuid[:20]}...", flush=True)
                return j(handler, {
                    "ok": True,
                    "connection_uuid": connection_uuid,
                    "workspace": workspace,
                })
            else:
                # Registration failed — return 200 with ok=false so frontend can
                # handle gracefully without triggering api() throw on non-2xx
                print(f"[knot-workspace] Failed: connection_uuid is empty, error={error_msg}", flush=True)
                return j(handler, {
                    "ok": False,
                    "error": error_msg or "Workspace registration failed. Please check if knot-cli service is running.",
                    "connection_uuid": "",
                    "workspace": workspace,
                })
        except Exception as e:
            print(f"[knot-workspace] Exception: {e}", flush=True)
            return j(handler, {"ok": False, "error": str(e)}, status=500)

    if parsed.path == "/api/knot-cli/workspace/list":
        """List all registered workspaces."""
        try:
            from api.knot_agui import list_workspaces
            
            workspaces = list_workspaces()
            return j(handler, {
                "ok": True,
                "workspaces": workspaces,
            })
        except Exception as e:
            return j(handler, {"ok": False, "error": str(e)}, status=500)

    if parsed.path == "/api/knot-cli/workspace/check":
        """Check if a workspace path is registered in knot-cli (lightweight, no side effects)."""
        try:
            from api.knot_agui import is_workspace_in_knot_list, _get_knot_cli_path
            path = str(body.get("path", "")).strip()
            if not path:
                return j(handler, {"ok": False, "error": "path is required"}, status=400)
            cli_path = _get_knot_cli_path()
            if not cli_path:
                return j(handler, {"ok": True, "registered": False, "reason": "knot-cli not installed"})
            registered = is_workspace_in_knot_list(path)
            return j(handler, {"ok": True, "registered": registered})
        except Exception as e:
            return j(handler, {"ok": False, "error": str(e)}, status=500)

    if parsed.path == "/api/knot-cli/workspace/add":
        """Add a workspace directory (checks list first to avoid duplicates)."""
        try:
            from api.knot_agui import ensure_knot_workspace, _get_knot_cli_path
            
            path = str(body.get("path", "")).strip()
            if not path:
                return j(handler, {"ok": False, "error": "path is required"}, status=400)
            
            if not _get_knot_cli_path():
                return j(handler, {"ok": False, "error": "knot-cli not installed"}, status=400)
            
            # Use ensure_knot_workspace which checks list first, then adds if missing
            result = ensure_knot_workspace(path)
            if result["ok"]:
                return j(handler, {"ok": True, "path": path, "action": result["action"]})
            else:
                return j(handler, {"ok": False, "error": result["message"]}, status=500)
        except Exception as e:
            return j(handler, {"ok": False, "error": str(e)}, status=500)

    if parsed.path == "/api/knot-cli/workspace/remove":
        """Remove a workspace directory from knot-cli registry."""
        try:
            from api.knot_agui import remove_knot_workspace, _get_knot_cli_path
            
            path = str(body.get("path", "")).strip()
            if not path:
                return j(handler, {"ok": False, "error": "path is required"}, status=400)
            
            if not _get_knot_cli_path():
                return j(handler, {"ok": False, "error": "knot-cli not installed"}, status=400)
            
            result = remove_knot_workspace(path)
            if result["ok"]:
                return j(handler, {"ok": True, "path": path, "action": result["action"]})
            else:
                return j(handler, {"ok": False, "error": result["message"]}, status=500)
        except Exception as e:
            return j(handler, {"ok": False, "error": str(e)}, status=500)

    # ── Knot AG-UI Agents API ─────────────────────────────
    if parsed.path == "/api/knot/agents":
        """Return configured Knot AG-UI agents list."""
        try:
            from api.knot_agui import get_knot_agents
            agents = get_knot_agents()
            return j(handler, {"ok": True, "agents": agents})
        except Exception as e:
            return j(handler, {"ok": False, "error": str(e)}, status=500)

    if parsed.path == "/api/session/new":
        s = new_session(workspace=body.get("workspace"), model=body.get("model"))
        return j(handler, {"session": s.compact() | {"messages": s.messages}})

    if parsed.path == "/api/session/update":
        try:
            require(body, "session_id")
        except ValueError as e:
            return bad(handler, str(e))
        try:
            s = get_session(body["session_id"])
        except KeyError:
            return bad(handler, "Session not found", 404)
        if "system_prompt" in body:
            s.system_prompt = body["system_prompt"]
        if "model" in body:
            s.model = body["model"]
        if "title" in body:
            s.title = body["title"]
        if "workspace" in body:
            new_ws = str(Path(body["workspace"]).expanduser().resolve())
            s.workspace = new_ws
            set_last_workspace(new_ws)
        s.save()
        return j(handler, {"ok": True})

    if parsed.path == "/api/sessions/cleanup":
        return _handle_sessions_cleanup(handler, body, zero_only=False)

    if parsed.path == "/api/sessions/cleanup_zero_message":
        return _handle_sessions_cleanup(handler, body, zero_only=True)

    if parsed.path == "/api/session/rename":
        try:
            require(body, "session_id", "title")
        except ValueError as e:
            return bad(handler, str(e))
        try:
            s = get_session(body["session_id"])
        except KeyError:
            return bad(handler, "Session not found", 404)
        s.title = str(body["title"]).strip()[:80] or "Untitled"
        s.save()
        return j(handler, {"session": s.compact()})

    if parsed.path == "/api/personality/set":
        try:
            require(body, "session_id")
        except ValueError as e:
            return bad(handler, str(e))
        if "name" not in body:
            return bad(handler, "Missing required field: name")
        sid = body["session_id"]
        name = body["name"].strip()
        try:
            s = get_session(sid)
        except KeyError:
            return bad(handler, "Session not found", 404)
        # Resolve personality from config.yaml agent.personalities section
        # (matches hermes-agent CLI behavior)
        prompt = ""
        if name:
            from api.config import reload_config as _reload_cfg2

            _reload_cfg2()  # pick up config changes without restart
            from api.config import get_config as _get_cfg2

            _cfg2 = _get_cfg2()
            agent_cfg = _cfg2.get("agent", {})
            raw_personalities = agent_cfg.get("personalities", {})
            if not isinstance(raw_personalities, dict) or name not in raw_personalities:
                return bad(
                    handler, f'Personality "{name}" not found in config.yaml', 404
                )
            value = raw_personalities[name]
            # Resolve prompt using the same logic as hermes-agent cli.py
            if isinstance(value, dict):
                parts = [value.get("system_prompt", "") or value.get("prompt", "")]
                if value.get("tone"):
                    parts.append(f"Tone: {value['tone']}")
                if value.get("style"):
                    parts.append(f"Style: {value['style']}")
                prompt = "\n".join(p for p in parts if p)
            else:
                prompt = str(value)
        s.personality = name if name else None
        s.save()
        return j(handler, {"ok": True, "personality": s.personality, "prompt": prompt})

    if parsed.path == "/api/session/delete":
        sid = body.get("session_id", "")
        if not sid:
            return bad(handler, "session_id is required")
        # Delete from WebUI session store
        with LOCK:
            SESSIONS.pop(sid, None)
        p = SESSION_DIR / f"{sid}.json"
        try:
            p.unlink(missing_ok=True)
        except Exception:
            pass
        try:
            SESSION_INDEX_FILE.unlink(missing_ok=True)
        except Exception:
            pass
        # Also delete from CLI state.db (for CLI sessions shown in sidebar)
        try:
            from api.models import delete_cli_session

            delete_cli_session(sid)
        except Exception:
            pass
        return j(handler, {"ok": True})

    if parsed.path == "/api/session/message":
        # Append a single message to a session (used by PM delegation to persist user messages)
        try:
            require(body, "session_id", "role", "content")
        except ValueError as e:
            return bad(handler, str(e))
        try:
            s = get_session(body["session_id"])
        except KeyError:
            return bad(handler, "Session not found", 404)
        msg = {
            "role": body["role"],
            "content": body["content"],
        }
        # Optional fields
        if "reasoning" in body:
            msg["reasoning"] = body["reasoning"]
        if "timestamp" in body:
            msg["timestamp"] = body["timestamp"]
        s.messages.append(msg)
        s.save()
        return j(handler, {"ok": True, "message": msg})

    if parsed.path == "/api/session/clear":
        try:
            require(body, "session_id")
        except ValueError as e:
            return bad(handler, str(e))
        try:
            s = get_session(body["session_id"])
        except KeyError:
            return bad(handler, "Session not found", 404)
        s.messages = []
        s.tool_calls = []
        s.title = "Untitled"
        s.save()
        return j(handler, {"ok": True, "session": s.compact()})

    if parsed.path == "/api/session/truncate":
        try:
            require(body, "session_id")
        except ValueError as e:
            return bad(handler, str(e))
        if body.get("keep_count") is None:
            return bad(handler, "Missing required field(s): keep_count")
        try:
            s = get_session(body["session_id"])
        except KeyError:
            return bad(handler, "Session not found", 404)
        keep = int(body["keep_count"])
        s.messages = s.messages[:keep]
        s.save()
        return j(
            handler, {"ok": True, "session": s.compact() | {"messages": s.messages}}
        )

    if parsed.path == "/api/chat/start":
        return _handle_chat_start(handler, body)

    if parsed.path == "/api/chat":
        return _handle_chat_sync(handler, body)

    # ── Employee filesystem API (POST) ──
    if parsed.path == "/api/employee/create":
        return _handle_employee_create(handler, body)

    if parsed.path == "/api/employee/update":
        return _handle_employee_update(handler, body)

    if parsed.path == "/api/employee/delete":
        return _handle_employee_delete(handler, body)

    if parsed.path == "/api/employees/save":
        return _handle_employees_save(handler, body)

    if parsed.path == "/api/employee/experience":
        return _handle_employee_experience(handler, body)

    if parsed.path == "/api/employees/export":
        return _handle_employees_export(handler, body)

    if parsed.path == "/api/employees/import":
        return _handle_employees_import(handler, body)

    # ── Employee templates API (POST) ──
    if parsed.path == "/api/employee-templates/init":
        return _handle_employee_templates_init(handler, body)

    if parsed.path == "/api/employee-templates/install":
        return _handle_employee_templates_install(handler, body)

    if parsed.path == "/api/employee-templates/uninstall":
        return _handle_employee_templates_uninstall(handler, body)

    if parsed.path == "/api/employee-templates/manifest":
        return _handle_employee_templates_manifest_update(handler, body)

    # ── Prompt builder (统一 system_prompt 构建) ──
    if parsed.path == "/api/prompt/build":
        from api.prompt_builder import handle_build as _pb_build
        return _pb_build(handler, body)

    # ── Employee / Workspace scripts 执行 ──
    if parsed.path == "/api/script/execute":
        from api.employee_scripts import handle_script_execute as _es_exec
        return _es_exec(handler, body)

    # ── Team templates API (POST) ──
    if parsed.path == "/api/team-templates/install":
        return _handle_team_templates_install(handler, body)

    if parsed.path == "/api/team-templates/uninstall":
        return _handle_team_templates_uninstall(handler, body)

    if parsed.path == "/api/team-templates/manifest":
        return _handle_team_templates_manifest_update(handler, body)

    # ── Coordinator (协调员) POST — DEPRECATED: 前端已迁移到 PM session API，此路由仅供内部 hook 兼容 ──
    if parsed.path == "/api/group-chat/send":
        return _handle_group_chat_send(handler, body)

    if parsed.path == "/api/group-chat/message":
        return _handle_group_chat_message(handler, body)

    if parsed.path == "/api/group-chat/result":
        return _handle_group_chat_result(handler, body)

    # ── PM Heartbeat (心跳调度) POST ──
    if parsed.path == "/api/pm-heartbeat/trigger":
        return _handle_pm_heartbeat_trigger(handler, body)

    # ── Async subagent control (POST) ──
    if parsed.path == "/api/agents/steer":
        from api.agents import handle_steer as _ag_steer
        return _ag_steer(handler, body)

    if parsed.path == "/api/agents/cancel":
        from api.agents import handle_cancel as _ag_cancel
        return _ag_cancel(handler, body)

    # ── Cron API (POST) ──
    if parsed.path == "/api/crons/create":
        return _handle_cron_create(handler, body)

    if parsed.path == "/api/crons/update":
        return _handle_cron_update(handler, body)

    if parsed.path == "/api/crons/delete":
        return _handle_cron_delete(handler, body)

    if parsed.path == "/api/crons/run":
        return _handle_cron_run(handler, body)

    if parsed.path == "/api/crons/pause":
        return _handle_cron_pause(handler, body)

    if parsed.path == "/api/crons/resume":
        return _handle_cron_resume(handler, body)

    # ── File ops (POST) ──
    if parsed.path == "/api/file/delete":
        return _handle_file_delete(handler, body)

    if parsed.path == "/api/file/save":
        return _handle_file_save(handler, body)

    if parsed.path == "/api/file/create":
        return _handle_file_create(handler, body)

    if parsed.path == "/api/file/rename":
        return _handle_file_rename(handler, body)

    if parsed.path == "/api/file/create-dir":
        return _handle_create_dir(handler, body)

    if parsed.path == "/api/file/reveal":
        return _handle_file_reveal(handler, body)

    # ── Workspace management (POST) ──
    if parsed.path == "/api/workspaces/add":
        return _handle_workspace_add(handler, body)

    if parsed.path == "/api/workspaces/remove":
        return _handle_workspace_remove(handler, body)

    if parsed.path == "/api/workspaces/rename":
        return _handle_workspace_rename(handler, body)

    # ── Workspace Manager (集中化工作区管理) POST ──
    if parsed.path == "/api/ws-manager/create":
        return _handle_ws_manager_create(handler, body)

    if parsed.path == "/api/ws-manager/update":
        return _handle_ws_manager_update(handler, body)

    if parsed.path == "/api/ws-manager/delete":
        return _handle_ws_manager_delete(handler, body)

    if parsed.path == "/api/ws-manager/init-employees":
        return _handle_ws_manager_init_employees(handler, body)

    if parsed.path == "/api/ws-manager/connections":
        return _handle_ws_manager_connections_save(handler, body)

    if parsed.path == "/api/ws-manager/export":
        return _handle_ws_manager_export(handler, body)

    if parsed.path == "/api/ws-manager/import":
        return _handle_ws_manager_import(handler, body)

    if parsed.path == "/api/ws-manager/file/save":
        return _handle_ws_manager_file_save(handler, body)

    if parsed.path == "/api/ws-manager/file/delete":
        return _handle_ws_manager_file_delete(handler, body)

    # ── Approval (POST) ──
    if parsed.path == "/api/approval/respond":
        return _handle_approval_respond(handler, body)

    if parsed.path == "/api/clarify/respond":
        return _handle_clarify_respond(handler, body)

    # ★ P3: "下一步"暂停机制
    if parsed.path == "/api/browser/continue":
        return _handle_browser_continue(handler, body)
    # ★ P5: Agent Pack 安装/卸载/启停
    if parsed.path == "/api/agent-packs/install":
        return _handle_agent_pack_install(handler, body)
    if parsed.path == "/api/agent-packs/uninstall":
        return _handle_agent_pack_uninstall(handler, body)
    if parsed.path == "/api/agent-packs/enable":
        return _handle_agent_pack_set_enabled(handler, body)

    # ── Skills (POST) ──
    if parsed.path == "/api/skills/save":
        return _handle_skill_save(handler, body)

    if parsed.path == "/api/skills/delete":
        return _handle_skill_delete(handler, body)

    # ── Memory (POST) ──
    if parsed.path == "/api/memory/write":
        return _handle_memory_write(handler, body)

    # ── Profile API (POST) ──
    if parsed.path == "/api/profile/switch":
        name = body.get("name", "").strip()
        if not name:
            return bad(handler, "name is required")
        try:
            from api.profiles import switch_profile

            result = switch_profile(name)
            return j(handler, result)
        except (ValueError, FileNotFoundError) as e:
            return bad(handler, _sanitize_error(e), 404)
        except RuntimeError as e:
            return bad(handler, str(e), 409)

    if parsed.path == "/api/profile/create":
        name = body.get("name", "").strip()
        if not name:
            return bad(handler, "name is required")
        import re as _re

        if not _re.match(r"^[a-z0-9][a-z0-9_-]{0,63}$", name):
            return bad(
                handler,
                "Invalid profile name: lowercase letters, numbers, hyphens, underscores only",
            )
        clone_from = body.get("clone_from")
        if clone_from is not None:
            clone_from = str(clone_from).strip()
            if not _re.match(r"^[a-z0-9][a-z0-9_-]{0,63}$", clone_from):
                return bad(handler, "Invalid clone_from name")
        base_url = body.get("base_url", "").strip() if body.get("base_url") else None
        api_key = body.get("api_key", "").strip() if body.get("api_key") else None
        if base_url and not base_url.startswith(("http://", "https://")):
            return bad(handler, "base_url must start with http:// or https://")
        try:
            from api.profiles import create_profile_api

            result = create_profile_api(
                name,
                clone_from=clone_from,
                clone_config=bool(body.get("clone_config", False)),
                base_url=base_url,
                api_key=api_key,
            )
            return j(handler, {"ok": True, "profile": result})
        except (ValueError, FileExistsError, RuntimeError) as e:
            return bad(handler, str(e))

    if parsed.path == "/api/profile/delete":
        name = body.get("name", "").strip()
        if not name:
            return bad(handler, "name is required")
        try:
            from api.profiles import delete_profile_api

            result = delete_profile_api(name)
            return j(handler, result)
        except (ValueError, FileNotFoundError) as e:
            return bad(handler, _sanitize_error(e))
        except RuntimeError as e:
            return bad(handler, str(e), 409)

    # ── Settings (POST) ──
    if parsed.path == "/api/settings":
        if "bot_name" in body:
            body["bot_name"] = (str(body["bot_name"]) or "").strip() or "Hermes"
        # Sensitive tokens: don't overwrite with blank (frontend sends blank when masked ●●●●)
        try:
            from api.config import _SETTINGS_SENSITIVE_KEYS
            current = load_settings()
            for _sk in _SETTINGS_SENSITIVE_KEYS:
                if _sk in body and not body[_sk]:
                    body.pop(_sk, None)  # keep existing value
        except ImportError:
            pass
        saved = save_settings(body)
        saved.pop("password_hash", None)  # never expose hash to client
        # Mask sensitive keys in response
        try:
            from api.config import _SETTINGS_SENSITIVE_KEYS
            for _sk in _SETTINGS_SENSITIVE_KEYS:
                if _sk in saved and saved[_sk]:
                    saved[_sk] = "●●●●"
        except ImportError:
            pass
        return j(handler, saved)

    # ── Local CLI backends (POST save/delete) ──
    if parsed.path == "/api/cli/backends":
        from api.config import get_config, reload_config, _get_config_path
        action = str(body.get("action", "save")).strip().lower()
        name = str(body.get("name", "")).strip()
        if not name:
            return bad(handler, "backend name is required")
        # Only allow simple identifier-like names
        import re as _re
        if not _re.match(r"^[A-Za-z0-9_\-]{1,48}$", name):
            return bad(handler, "invalid backend name (allowed: a-z A-Z 0-9 _ -, max 48 chars)")
        reload_config()
        cfg = get_config()
        backends = cfg.get("cli_backends") or {}
        if not isinstance(backends, dict):
            backends = {}
        if action == "delete":
            backends.pop(name, None)
        else:
            # Normalize incoming backend definition
            def _coerce_list(v):
                if v is None:
                    return []
                if isinstance(v, list):
                    return [str(x) for x in v if x is not None]
                if isinstance(v, str):
                    s = v.strip()
                    if not s:
                        return []
                    # Split whitespace-separated tokens unless quoted (basic heuristic)
                    try:
                        import shlex as _shlex
                        return _shlex.split(s)
                    except Exception:
                        return s.split()
                return []

            def _coerce_map(v):
                """支持三种输入：
                - dict: 直接使用
                - str: 每行解析 "alias = real" / "alias: real" / "alias" (简写)
                - 其他: 返回空 dict
                """
                if isinstance(v, dict):
                    return {str(k): str(val) if val is not None else str(k)
                            for k, val in v.items() if k is not None and str(k).strip()}
                if isinstance(v, str):
                    out = {}
                    import re as _re
                    for line in v.splitlines():
                        t = line.strip()
                        if not t or t.startswith('#'):
                            continue
                        eq_idx = t.find('=')
                        if eq_idx > 0:
                            k = t[:eq_idx].strip()
                            val = t[eq_idx+1:].strip()
                            if k:
                                out[k] = val or k
                            continue
                        # 冒号分隔（排除 URL 等：要求冒号后紧跟空格或值不含斜杠前缀）
                        m = _re.match(r'^([^\s:]+)\s*:\s+(.+)$', t)
                        if m:
                            out[m.group(1).strip()] = m.group(2).strip()
                            continue
                        # 简写：整行视为 alias，映射到自身
                        tok = t.split()[0]
                        if tok:
                            out[tok] = tok
                    return out
                return {}


            entry = {
                "command": str(body.get("command", "")).strip(),
                "args": _coerce_list(body.get("args")),
                "input": str(body.get("input", "stdin")).strip() or "stdin",
                "output": str(body.get("output", "text")).strip() or "text",
                "modelArg": str(body.get("modelArg", "")).strip(),
                "modelAliases": _coerce_map(body.get("modelAliases")),
                "listModelsArg": str(body.get("listModelsArg", "")).strip(),
                "systemPromptArg": str(body.get("systemPromptArg", "")).strip(),
                "systemPromptFileArg": str(body.get("systemPromptFileArg", "")).strip(),
                "systemPromptMode": str(body.get("systemPromptMode", "")).strip().lower(),
                "userPromptArg": str(body.get("userPromptArg", "")).strip(),
                "sessionMode": str(body.get("sessionMode", "none")).strip() or "none",
                "sessionArg": str(body.get("sessionArg", "")).strip(),
                "resumeArgs": _coerce_list(body.get("resumeArgs")),
                "resumeOutput": str(body.get("resumeOutput", "")).strip(),
                "imageArg": str(body.get("imageArg", "")).strip(),
                "systemPromptWhen": str(body.get("systemPromptWhen", "")).strip(),
                "workdir": str(body.get("workdir", "")).strip(),
                "env": _coerce_map(body.get("env")),
                "enabled": bool(body.get("enabled", True)),
                "useShellWrapper": bool(body.get("useShellWrapper", False)),
                "description": str(body.get("description", "")).strip(),
            }
            if not entry["command"]:
                return bad(handler, "command is required")
            if entry["sessionMode"] not in ("none", "always", "existing"):
                entry["sessionMode"] = "none"
            if entry["systemPromptMode"] not in ("", "arg", "file", "prepend", "skip"):
                entry["systemPromptMode"] = ""
            backends[name] = entry
        cfg["cli_backends"] = backends
        try:
            import yaml as _yaml
            config_path = _get_config_path()
            config_path.parent.mkdir(parents=True, exist_ok=True)
            with open(config_path, "w", encoding="utf-8") as f:
                _yaml.safe_dump(cfg, f, default_flow_style=False, sort_keys=False, allow_unicode=True)
        except Exception as exc:
            return bad(handler, f"Failed to save CLI backend config: {exc}", 500)
        reload_config()
        # Return updated list
        items = []
        for n, data in backends.items():
            if isinstance(data, dict):
                items.append({"name": str(n), **data})
        return j(handler, {"ok": True, "action": action, "backends": items})


    # ── CLI test: verify executable is callable ──
    if parsed.path == "/api/cli/test":
        cmd = str(body.get("command", "")).strip()
        if not cmd:
            return bad(handler, "command is required")
        workdir = str(body.get("workdir", "")).strip() or None
        # Parse args from body (list or string)
        raw_args = body.get("args")
        if isinstance(raw_args, list):
            args_list = [str(x) for x in raw_args if x is not None]
        elif isinstance(raw_args, str) and raw_args.strip():
            try:
                import shlex as _shlex
                args_list = _shlex.split(raw_args)
            except Exception:
                args_list = raw_args.split()
        else:
            args_list = ["--version"]  # default probe
        import shutil as _shutil
        import subprocess as _subprocess
        # Resolve command existence (allow absolute path too)
        resolved = _shutil.which(cmd) or (cmd if os.path.isabs(cmd) and os.path.exists(cmd) else None)
        if not resolved:
            return j(handler, {"ok": False, "error": f"command not found in PATH: {cmd}"}, status=200)
        try:
            proc = _subprocess.run(
                [resolved] + args_list,
                cwd=workdir or None,
                capture_output=True,
                text=True,
                encoding='utf-8',
                errors='replace',
                timeout=8,
            )
            stdout = (proc.stdout or "").strip()
            stderr = (proc.stderr or "").strip()
            return j(handler, {
                "ok": proc.returncode == 0,
                "resolved": resolved,
                "return_code": proc.returncode,
                "stdout": stdout[:1500],
                "stderr": stderr[:1500],
            })
        except _subprocess.TimeoutExpired:
            return j(handler, {"ok": False, "error": "CLI test timed out after 8s", "resolved": resolved})
        except Exception as exc:
            return j(handler, {"ok": False, "error": str(exc), "resolved": resolved})

    # ── CLI probe-models: run command + listModelsArg and parse output ──
    if parsed.path == "/api/cli/probe-models":
        cmd = str(body.get("command", "")).strip()
        list_arg = str(body.get("listModelsArg", "")).strip()
        if not cmd:
            return bad(handler, "command is required")
        if not list_arg:
            return bad(handler, "listModelsArg is required")
        workdir = str(body.get("workdir", "")).strip() or None
        import shutil as _shutil
        import subprocess as _subprocess
        import shlex as _shlex
        import re as _re
        resolved = _shutil.which(cmd) or (cmd if os.path.isabs(cmd) and os.path.exists(cmd) else None)
        if not resolved:
            return j(handler, {"ok": False, "error": f"command not found: {cmd}"})
        # Parse listModelsArg (may be multiple tokens like "models list")
        try:
            list_tokens = _shlex.split(list_arg)
        except Exception:
            list_tokens = list_arg.split()
        # Optional base args from backend (some CLIs need them even for list-models)
        base_raw = body.get("args")
        if isinstance(base_raw, list):
            base_args = [str(x) for x in base_raw if x is not None]
        elif isinstance(base_raw, str) and base_raw.strip():
            try:
                base_args = _shlex.split(base_raw)
            except Exception:
                base_args = base_raw.split()
        else:
            base_args = []
        # Merge env
        env = dict(os.environ)
        user_env = body.get("env") or {}
        if isinstance(user_env, dict):
            for k, v in user_env.items():
                env[str(k)] = str(v)
        # Windows GBK 默认会解码失败 → 强制 UTF-8
        env.setdefault('PYTHONIOENCODING', 'utf-8')
        env.setdefault('PYTHONUTF8', '1')
        argv = [resolved] + base_args + list_tokens
        try:
            proc = _subprocess.run(
                argv,
                cwd=workdir or None,
                env=env,
                capture_output=True,
                text=True,
                encoding='utf-8',
                errors='replace',
                timeout=15,
            )
            stdout = proc.stdout or ""
            stderr = proc.stderr or ""
            combined = stdout + ("\n" + stderr if stderr and not stdout.strip() else "")
            # Parse strategies (in order):
            # 1) JSON array / object with `models` field
            # 2) JSON Lines (one object per line)
            # 3) Plain lines: skip blanks/headers, take first token as model id
            models = []

            def _from_json(obj):
                out = []
                if isinstance(obj, list):
                    for item in obj:
                        if isinstance(item, dict):
                            mid = item.get("id") or item.get("name") or item.get("model") or item.get("path")
                            if mid:
                                out.append({"id": str(mid), "alias": str(item.get("name") or item.get("label") or mid)})
                        elif isinstance(item, str):
                            out.append({"id": item, "alias": item})
                elif isinstance(obj, dict):
                    arr = obj.get("models") or obj.get("data") or obj.get("items")
                    if isinstance(arr, list):
                        out.extend(_from_json(arr))
                return out

            # Try JSON first
            try:
                import json as _j
                data = _j.loads(stdout.strip())
                models = _from_json(data)
            except Exception:
                pass
            # Try JSONL
            if not models:
                for ln in stdout.splitlines():
                    t = ln.strip()
                    if not t or not (t.startswith("{") or t.startswith("[")):
                        continue
                    try:
                        import json as _j
                        data = _j.loads(t)
                        models.extend(_from_json(data))
                    except Exception:
                        continue
            # Fallback: plain text heuristic
            if not models:
                skip_patterns = (_re.compile(r"^\s*$"), _re.compile(r"^(usage|NAME|ID|MODEL|─|━|-+)", _re.I))
                for ln in combined.splitlines():
                    t = ln.strip()
                    if not t:
                        continue
                    if any(p.search(t) for p in skip_patterns):
                        continue
                    # Take first whitespace-delimited token as id
                    tok = t.split()[0]
                    # Skip if looks like help text (contains common help words)
                    if tok.startswith("-") or tok.lower() in {"usage:", "help", "error:", "error"}:
                        continue
                    # Avoid duplicates
                    if not any(m.get("id") == tok for m in models):
                        models.append({"id": tok, "alias": tok})
                # Cap to avoid huge dumps
                if len(models) > 200:
                    models = models[:200]
            return j(handler, {
                "ok": bool(models) or proc.returncode == 0,
                "return_code": proc.returncode,
                "resolved": resolved,
                "models": models,
                "stdout_preview": stdout[:500],
                "stderr_preview": stderr[:500],
            })
        except _subprocess.TimeoutExpired:
            return j(handler, {"ok": False, "error": "probe timed out after 15s", "resolved": resolved})
        except Exception as exc:
            return j(handler, {"ok": False, "error": str(exc), "resolved": resolved})

    # ── Providers (POST) ──
    if parsed.path == "/api/providers/save":
        providers = body.get("providers")
        if not isinstance(providers, list):
            return bad(handler, "providers must be a list")
        from api.config import get_config, reload_config, _get_config_path
        reload_config()
        cfg = get_config()
        # Normalize entries
        normalized = []
        for entry in providers:
            if not isinstance(entry, dict):
                continue
            name = str(entry.get("name", "")).strip()
            base_url = str(entry.get("base_url", "")).strip()
            if not name or not base_url:
                continue
            item = {"name": name, "base_url": base_url}
            api_key = str(entry.get("api_key", "")).strip()
            if api_key:
                item["api_key"] = api_key
            api_mode = str(entry.get("api_mode", "")).strip()
            if api_mode:
                item["api_mode"] = api_mode
            model = str(entry.get("model", "")).strip()
            if model:
                item["model"] = model
            normalized.append(item)
        # Write back to config.yaml under custom_providers (legacy list format)
        cfg["custom_providers"] = normalized
        config_path = _get_config_path()
        try:
            import yaml as _yaml
            config_path.parent.mkdir(parents=True, exist_ok=True)
            # Use safe_dump so the output is guaranteed parseable by safe_load
            with open(config_path, "w", encoding="utf-8") as f:
                _yaml.safe_dump(cfg, f, default_flow_style=False, sort_keys=False)
        except Exception as exc:
            return bad(handler, f"Failed to save config: {exc}", 500)
        # Verify write by reading back immediately
        try:
            import yaml as _yaml
            if config_path.exists():
                raw = config_path.read_text(encoding="utf-8")
                verify_cfg = _yaml.safe_load(raw) or {}
                saved_cp = verify_cfg.get("custom_providers")
                if not isinstance(saved_cp, list):
                    return bad(handler, "Config was not written correctly (custom_providers missing).", 500)
            else:
                return bad(handler, "Config file was not created.", 500)
        except Exception as exc:
            return bad(handler, f"Failed to verify config write: {exc}", 500)
        # Sync to CLI config path only if it points to a different file
        try:
            from hermes_cli.config import save_config, get_config_path as _cli_get_config_path
            cli_path = _cli_get_config_path()
            if cli_path.resolve() != config_path.resolve():
                save_config(cfg)
        except Exception:
            pass
        # Also update runtime cache
        reload_config()
        return j(handler, {"ok": True, "providers": normalized})

    if parsed.path == "/api/onboarding/setup":
        # Writing API keys to disk - restrict to local/private networks unless auth is active.
        # In Docker, requests arrive from the bridge network (172.x.x.x), not 127.0.0.1,
        # even when the user accesses via localhost:8787 on the host.
        from api.auth import is_auth_enabled
        if not is_auth_enabled():
            import ipaddress
            try:
                addr = ipaddress.ip_address(handler.client_address[0])
                is_local = addr.is_loopback or addr.is_private
            except ValueError:
                is_local = False
            if not is_local:
                return bad(handler, "Onboarding setup is only available from local networks when auth is not enabled.", 403)
        try:
            return j(handler, apply_onboarding_setup(body))
        except ValueError as e:
            return bad(handler, str(e))
        except RuntimeError as e:
            return bad(handler, str(e), 500)

    if parsed.path == "/api/onboarding/complete":
        return j(handler, complete_onboarding())

    # ── Session pin (POST) ──
    if parsed.path == "/api/session/pin":
        try:
            require(body, "session_id")
        except ValueError as e:
            return bad(handler, str(e))
        try:
            s = get_session(body["session_id"])
        except KeyError:
            return bad(handler, "Session not found", 404)
        s.pinned = bool(body.get("pinned", True))
        s.save()
        return j(handler, {"ok": True, "session": s.compact()})

    # ── Session archive (POST) ──
    if parsed.path == "/api/session/archive":
        try:
            require(body, "session_id")
        except ValueError as e:
            return bad(handler, str(e))
        try:
            s = get_session(body["session_id"])
        except KeyError:
            return bad(handler, "Session not found", 404)
        s.archived = bool(body.get("archived", True))
        s.save()
        return j(handler, {"ok": True, "session": s.compact()})

    # ── Session move to project (POST) ──
    if parsed.path == "/api/session/move":
        try:
            require(body, "session_id")
        except ValueError as e:
            return bad(handler, str(e))
        try:
            s = get_session(body["session_id"])
        except KeyError:
            return bad(handler, "Session not found", 404)
        s.project_id = body.get("project_id") or None
        s.save()
        return j(handler, {"ok": True, "session": s.compact()})

    # ── Project CRUD (POST) ──
    if parsed.path == "/api/projects/create":
        try:
            require(body, "name")
        except ValueError as e:
            return bad(handler, str(e))
        import re as _re

        name = body["name"].strip()[:128]
        if not name:
            return bad(handler, "name required")
        color = body.get("color")
        if color and not _re.match(r"^#[0-9a-fA-F]{3,8}$", color):
            return bad(handler, "Invalid color format")
        projects = load_projects()
        proj = {
            "project_id": uuid.uuid4().hex[:12],
            "name": name,
            "color": color,
            "created_at": time.time(),
        }
        projects.append(proj)
        save_projects(projects)
        return j(handler, {"ok": True, "project": proj})

    if parsed.path == "/api/projects/rename":
        try:
            require(body, "project_id", "name")
        except ValueError as e:
            return bad(handler, str(e))
        import re as _re

        projects = load_projects()
        proj = next(
            (p for p in projects if p["project_id"] == body["project_id"]), None
        )
        if not proj:
            return bad(handler, "Project not found", 404)
        proj["name"] = body["name"].strip()[:128]
        if "color" in body:
            color = body["color"]
            if color and not _re.match(r"^#[0-9a-fA-F]{3,8}$", color):
                return bad(handler, "Invalid color format")
            proj["color"] = color
        save_projects(projects)
        return j(handler, {"ok": True, "project": proj})

    if parsed.path == "/api/projects/delete":
        try:
            require(body, "project_id")
        except ValueError as e:
            return bad(handler, str(e))
        projects = load_projects()
        proj = next(
            (p for p in projects if p["project_id"] == body["project_id"]), None
        )
        if not proj:
            return bad(handler, "Project not found", 404)
        projects = [p for p in projects if p["project_id"] != body["project_id"]]
        save_projects(projects)
        # Unassign all sessions that belonged to this project
        if SESSION_INDEX_FILE.exists():
            try:
                index = json.loads(SESSION_INDEX_FILE.read_text(encoding="utf-8"))
                for entry in index:
                    if entry.get("project_id") == body["project_id"]:
                        try:
                            s = get_session(entry["session_id"])
                            s.project_id = None
                            s.save()
                        except Exception:
                            pass
            except Exception:
                pass
        return j(handler, {"ok": True})

    # ── Session import from JSON (POST) ──
    if parsed.path == "/api/session/import":
        return _handle_session_import(handler, body)

    # ── Self-update (POST) ──
    if parsed.path == "/api/updates/apply":
        target = body.get("target", "")
        if target not in ("webui", "agent"):
            return bad(handler, 'target must be "webui" or "agent"')
        from api.updates import apply_update

        return j(handler, apply_update(target))

    # ── CLI session import (POST) ──
    if parsed.path == "/api/session/import_cli":
        return _handle_session_import_cli(handler, body)

    # ── Auth endpoints (POST) ──
    if parsed.path == "/api/auth/login":
        from api.auth import (
            verify_password,
            create_session,
            set_auth_cookie,
            is_auth_enabled,
        )
        from api.auth import _check_login_rate, _record_login_attempt

        if not is_auth_enabled():
            return j(handler, {"ok": True, "message": "Auth not enabled"})
        client_ip = handler.client_address[0]
        if not _check_login_rate(client_ip):
            return j(
                handler,
                {"error": "Too many attempts. Try again in a minute."},
                status=429,
            )
        password = body.get("password", "")
        if not verify_password(password):
            _record_login_attempt(client_ip)
            return bad(handler, "Invalid password", 401)
        cookie_val = create_session()
        handler.send_response(200)
        handler.send_header("Content-Type", "application/json")
        handler.send_header("Cache-Control", "no-store")
        _security_headers(handler)
        set_auth_cookie(handler, cookie_val)
        handler.end_headers()
        handler.wfile.write(json.dumps({"ok": True}).encode())
        return True

    if parsed.path == "/api/auth/logout":
        from api.auth import clear_auth_cookie, invalidate_session, parse_cookie

        cookie_val = parse_cookie(handler)
        if cookie_val:
            invalidate_session(cookie_val)
        handler.send_response(200)
        handler.send_header("Content-Type", "application/json")
        handler.send_header("Cache-Control", "no-store")
        _security_headers(handler)
        clear_auth_cookie(handler)
        handler.end_headers()
        handler.wfile.write(json.dumps({"ok": True}).encode())
        return True

    # ── AI 变更追踪 (POST) ───────────────────────────────────────────────────
    if parsed.path == "/api/ai-changes/accept":
        sid = body.get("session_id", "")
        change_id = body.get("change_id", "")
        if not sid or not change_id:
            return bad(handler, "session_id and change_id required")
        try:
            s = get_session(sid)
        except KeyError:
            return bad(handler, "Session not found", 404)
        from api.ai_changes import accept_change
        ok = accept_change(sid, change_id)
        return j(handler, {"success": ok})

    if parsed.path == "/api/ai-changes/accept-file":
        sid = body.get("session_id", "")
        file_path = body.get("path", "")
        if not sid or not file_path:
            return bad(handler, "session_id and path required")
        try:
            s = get_session(sid)
        except KeyError:
            return bad(handler, "Session not found", 404)
        from api.ai_changes import accept_file_changes
        count = accept_file_changes(sid, file_path)
        return j(handler, {"success": count > 0, "count": count})

    if parsed.path == "/api/ai-changes/accept-all":
        sid = body.get("session_id", "")
        if not sid:
            return bad(handler, "session_id required")
        try:
            s = get_session(sid)
        except KeyError:
            return bad(handler, "Session not found", 404)
        from api.ai_changes import accept_all_changes
        count = accept_all_changes(sid)
        return j(handler, {"success": count > 0, "count": count})

    return False  # 404


# ── GET route helpers ─────────────────────────────────────────────────────────


def _serve_static(handler, parsed):
    static_root = (Path(__file__).parent.parent / "static").resolve()
    # Strip the leading '/static/' prefix, then resolve and sandbox
    rel = parsed.path[len("/static/") :]
    static_file = (static_root / rel).resolve()
    try:
        static_file.relative_to(static_root)
    except ValueError:
        return j(handler, {"error": "not found"}, status=404)
    if not static_file.exists() or not static_file.is_file():
        return j(handler, {"error": "not found"}, status=404)
    ext = static_file.suffix.lower()
    ct = {"css": "text/css", "js": "application/javascript", "html": "text/html"}.get(
        ext.lstrip("."), "text/plain"
    )
    handler.send_response(200)
    handler.send_header("Content-Type", f"{ct}; charset=utf-8")
    handler.send_header("Cache-Control", "no-store")
    raw = static_file.read_bytes()
    handler.send_header("Content-Length", str(len(raw)))
    handler.end_headers()
    handler.wfile.write(raw)
    return True


def _handle_session_export(handler, parsed):
    sid = parse_qs(parsed.query).get("session_id", [""])[0]
    if not sid:
        return bad(handler, "session_id is required")
    try:
        s = get_session(sid)
    except KeyError:
        return bad(handler, "Session not found", 404)
    safe = redact_session_data(s.__dict__)
    payload = json.dumps(safe, ensure_ascii=False, indent=2)
    handler.send_response(200)
    handler.send_header("Content-Type", "application/json; charset=utf-8")
    handler.send_header(
        "Content-Disposition", f'attachment; filename="hermes-{sid}.json"'
    )
    handler.send_header("Content-Length", str(len(payload.encode("utf-8"))))
    handler.send_header("Cache-Control", "no-store")
    handler.end_headers()
    handler.wfile.write(payload.encode("utf-8"))
    return True


def _handle_sessions_search(handler, parsed):
    qs = parse_qs(parsed.query)
    q = qs.get("q", [""])[0].lower().strip()
    content_search = qs.get("content", ["1"])[0] == "1"
    depth = int(qs.get("depth", ["5"])[0])
    if not q:
        return j(handler, {"sessions": all_sessions()})
    results = []
    for s in all_sessions():
        title_match = q in (s.get("title") or "").lower()
        if title_match:
            results.append(dict(s, match_type="title"))
            continue
        if content_search:
            try:
                sess = get_session(s["session_id"])
                msgs = sess.messages[:depth] if depth else sess.messages
                for m in msgs:
                    c = m.get("content") or ""
                    if isinstance(c, list):
                        c = " ".join(
                            p.get("text", "")
                            for p in c
                            if isinstance(p, dict) and p.get("type") == "text"
                        )
                    if q in str(c).lower():
                        results.append(dict(s, match_type="content"))
                        break
            except (KeyError, Exception):
                pass
    return j(handler, {"sessions": results, "query": q, "count": len(results)})


def _handle_list_dir(handler, parsed):
    qs = parse_qs(parsed.query)
    sid = qs.get("session_id", [""])[0]
    if not sid:
        return bad(handler, "session_id is required")
    try:
        s = get_session(sid)
        workspace = s.workspace
    except KeyError:
        # Fallback for CLI sessions not loaded in WebUI memory
        try:
            cli_meta = None
            for cs in get_cli_sessions():
                if cs["session_id"] == sid:
                    cli_meta = cs
                    break
            if not cli_meta:
                return bad(handler, "Session not found", 404)
            workspace = cli_meta.get("workspace", "")
        except Exception:
            return bad(handler, "Session not found", 404)
    try:
        ws_path = Path(workspace)
        target_path = qs.get("path", ["."])[0]
        entries = list_dir(ws_path, target_path)
        return j(
            handler,
            {
                "entries": entries,
                "path": target_path,
            },
        )
    except (FileNotFoundError, ValueError) as e:
        return bad(handler, _sanitize_error(e), 404)


def _handle_path_maps(handler):
    """Return the Docker volume path mappings (container → host).
    Useful for the UI to display host paths when running inside Docker."""
    from api.config import PATH_MAPS
    return j(handler, {"maps": [{"container": c, "host": h} for c, h in PATH_MAPS]})


def _handle_host_open(handler, parsed):
    """Proxy: ask the host helper service to open a path in the file manager.
    This avoids CORS issues — the browser sends the request to the same-origin
    WebUI backend, which forwards it to the host helper on the host machine."""
    import urllib.request
    import urllib.error
    qs = parse_qs(parsed.query)
    host_path = qs.get("path", [""])[0]
    if not host_path:
        return bad(handler, "Missing 'path' parameter", 400)
    # From inside Docker, use host.docker.internal to reach the host machine.
    # From native mode, 127.0.0.1 works directly.
    import os
    host_target = os.getenv("HOST_HELPER_HOST", "host.docker.internal" if os.path.exists("/.within_container") else "127.0.0.1")
    helper_port = os.getenv("HOST_HELPER_PORT", "18791")
    helper_url = f"http://{host_target}:{helper_port}/open?path=" + urllib.parse.quote(host_path, safe="")
    try:
        req = urllib.request.Request(helper_url)
        resp = urllib.request.urlopen(req, timeout=3)
        import json as _json
        data = _json.loads(resp.read().decode())
        return j(handler, data)
    except urllib.error.URLError:
        return j(handler, {"ok": False, "error": "Host helper not running"}, 502)
    except Exception as e:
        return bad(handler, f"Host helper error: {e}")


def _handle_browse_dir(handler, parsed):
    """Browse directories on the server filesystem for workspace path selection.
    Returns directories; optionally includes files when include_files=true.
    Requires authentication."""
    qs = parse_qs(parsed.query)
    raw_path = qs.get("path", [""])[0]
    include_files = qs.get("include_files", [""])[0].lower() in ("true", "1", "yes")
    if not raw_path:
        # Default to home directory
        raw_path = str(Path.home())
    try:
        target = Path(raw_path).resolve()
        if not target.is_dir():
            return bad(handler, "Not a directory", 400)
        dirs = []
        files = []
        try:
            for item in sorted(target.iterdir(), key=lambda p: p.name.lower()):
                if item.name.startswith('.'):
                    continue
                try:
                    if item.is_dir():
                        dirs.append({"name": item.name, "path": str(item)})
                    elif include_files and item.is_file():
                        files.append({"name": item.name, "path": str(item),
                                      "size": item.stat().st_size})
                except (PermissionError, OSError):
                    pass
        except (PermissionError, OSError):
            pass  # cannot list directory contents
        result = {"path": str(target),
                  "parent": str(target.parent) if str(target) != str(target.parent) else None,
                  "dirs": dirs[:200]}
        if include_files:
            result["files"] = files[:200]
        return j(handler, result)
    except (PermissionError, OSError) as e:
        return bad(handler, _sanitize_error(e), 403)


def _handle_pick_folder(handler, parsed):
    """Open system native folder picker dialog using tkinter.
    Returns the selected folder path, or null if cancelled."""
    import threading

    qs = parse_qs(parsed.query)
    initial_dir = qs.get("initial", [""])[0] or str(Path.home())

    result = {"path": None}

    def _pick():
        try:
            import tkinter as tk
            from tkinter import filedialog
            root = tk.Tk()
            root.withdraw()
            root.attributes('-topmost', True)
            folder = filedialog.askdirectory(
                title="选择工作区文件夹",
                initialdir=initial_dir,
            )
            root.destroy()
            result["path"] = folder if folder else None
        except Exception:
            result["path"] = None

    # tkinter must run on a thread (the HTTP handler thread is OK on most platforms)
    t = threading.Thread(target=_pick)
    t.start()
    t.join(timeout=120)  # 2 min timeout
    return j(handler, {"path": result["path"]})


def _handle_sse_stream(handler, parsed):
    stream_id = parse_qs(parsed.query).get("stream_id", [""])[0]
    # ★ 多消费者支持：如果流已经存在主 queue 且被别的连接占着，
    #   新连接不能抢主 queue 的事件。这里给每个连接分配独立的订阅队列，
    #   _handle_sse_stream 从订阅队列消费；后端 put() 会同时广播给所有订阅者。
    #   场景：总群→员工跳转时，员工右侧面板和后台重连都可能创建 SSE 连接同时观察同一流。
    from api.config import STREAM_SUBS, STREAM_HISTORY, STREAMS_LOCK as _slock
    q = STREAMS.get(stream_id)
    history = STREAM_HISTORY.get(stream_id)
    if q is None and not history:
        # 流完全不存在 (既未开始也未保留历史)
        return j(handler, {"error": "stream not found"}, status=404)
    # 创建订阅者专属 queue 并挂到 STREAM_SUBS
    sub_q: queue.Queue = queue.Queue()
    if q is not None:
        with _slock:
            STREAM_SUBS.setdefault(stream_id, []).append(sub_q)
    else:
        # 流已结束但历史还在：只读历史，不订阅
        pass

    handler.send_response(200)
    handler.send_header("Content-Type", "text/event-stream; charset=utf-8")
    handler.send_header("Cache-Control", "no-cache")
    handler.send_header("X-Accel-Buffering", "no")
    handler.send_header("Connection", "keep-alive")
    handler.end_headers()

    try:
        # 1) 先回放历史事件（若有），让新订阅者拿到在它接入前已发生的全部事件
        if history:
            for event, data in list(history):
                try:
                    _sse(handler, event, data)
                except Exception:
                    break
            # 如果历史里已经有 done/error/cancel，直接结束（流已终结）
            last_events = [e for e, _ in history]
            if any(ev in last_events for ev in ("done", "error", "cancel")):
                # 清理订阅
                try:
                    with _slock:
                        if sub_q in STREAM_SUBS.get(stream_id, []):
                            STREAM_SUBS[stream_id].remove(sub_q)
                except Exception:
                    pass
                return True

        # 2) 从订阅 queue 拿新事件 (主 queue 由原来的第一个连接继续消费，我们不抢它)
        while True:
            try:
                item = sub_q.get(timeout=30)
            except queue.Empty:
                handler.wfile.write(b": heartbeat\n\n")
                handler.wfile.flush()
                continue
            if item is None:
                # EOF 哨兵 (流结束后发出)
                break
            event, data = item
            _sse(handler, event, data)
            if event in ("done", "error", "cancel"):
                break
    except (BrokenPipeError, ConnectionResetError):
        pass
    finally:
        # 清理订阅
        try:
            with _slock:
                if sub_q in STREAM_SUBS.get(stream_id, []):
                    STREAM_SUBS[stream_id].remove(sub_q)
        except Exception:
            pass
    return True


def _handle_gateway_sse_stream(handler):
    """SSE endpoint for real-time gateway session updates.
    Streams change events from the gateway watcher background thread.
    Only active when show_cli_sessions (show_agent_sessions) setting is enabled.
    """
    # Check if the feature is enabled
    settings = load_settings()
    if not settings.get('show_cli_sessions'):
        return j(handler, {'error': 'agent sessions not enabled'}, status=404)

    from api.gateway_watcher import get_watcher
    watcher = get_watcher()
    if watcher is None:
        return j(handler, {'error': 'watcher not started'}, status=503)

    handler.send_response(200)
    handler.send_header('Content-Type', 'text/event-stream; charset=utf-8')
    handler.send_header('Cache-Control', 'no-cache')
    handler.send_header('X-Accel-Buffering', 'no')
    handler.send_header('Connection', 'keep-alive')
    handler.end_headers()

    q = watcher.subscribe()
    try:
        # Send initial snapshot immediately
        from api.models import get_cli_sessions
        initial = get_cli_sessions()
        _sse(handler, 'sessions_changed', {'sessions': initial})

        while True:
            try:
                event_data = q.get(timeout=30)
            except queue.Empty:
                handler.wfile.write(b': keepalive\n\n')
                handler.wfile.flush()
                continue
            if event_data is None:
                break  # watcher is stopping
            _sse(handler, event_data.get('type', 'sessions_changed'), event_data)
    except (BrokenPipeError, ConnectionResetError, ConnectionAbortedError):
        pass
    finally:
        watcher.unsubscribe(q)
    return True


def _handle_logs_sse_stream(handler):
    """SSE endpoint for the global log panel.
    Subscribes to LOG_SUBSCRIBERS and streams all agent events (token, tool, etc.)
    with session/employee metadata so the frontend can display a unified log view.
    """
    q = queue.Queue(maxsize=500)

    handler.send_response(200)
    handler.send_header("Content-Type", "text/event-stream; charset=utf-8")
    handler.send_header("Cache-Control", "no-cache")
    handler.send_header("X-Accel-Buffering", "no")
    handler.send_header("Connection", "keep-alive")
    handler.end_headers()

    # Replay recent history so the client sees past events after a page refresh.
    # Do this BEFORE adding q to LOG_SUBSCRIBERS so that any new events produced
    # during replay don't get duplicated (they would be in both history and q).
    try:
        with _LOG_HISTORY_LOCK:
            history_snapshot = list(_LOG_HISTORY)
        # ★ 回放时过滤重复 _log_id，防止历史中存在非连续重复条目
        _seen_ids = set()
        for entry in history_snapshot:
            log_id = entry.get('_log_id')
            if log_id and log_id in _seen_ids:
                continue  # skip duplicate
            if log_id:
                _seen_ids.add(log_id)
            try:
                event_name = entry.get('event', 'log')
                data_for_sse = {k: v for k, v in entry.items() if k != 'event'}
                _sse(handler, event_name, data_for_sse)
            except (BrokenPipeError, ConnectionResetError, ConnectionAbortedError):
                raise
            except Exception:
                pass  # skip stale entries, keep streaming
        handler.wfile.flush()
    except (BrokenPipeError, ConnectionResetError, ConnectionAbortedError):
        return True

    # Now subscribe to real-time events
    with LOG_SUBSCRIBERS_LOCK:
        if len(LOG_SUBSCRIBERS) >= LOG_MAX_SUBSCRIBERS:
            LOG_SUBSCRIBERS.pop(0)
        LOG_SUBSCRIBERS.append(q)
    print(f'[logs-sse] New subscriber connected, total={len(LOG_SUBSCRIBERS)}', flush=True)

    # Track _log_ids seen on this connection to filter duplicates from the live stream
    _live_seen_ids = set()

    try:
        while True:
            try:
                entry = q.get(timeout=30)
            except queue.Empty:
                handler.wfile.write(b": heartbeat\n\n")
                handler.wfile.flush()
                continue
            try:
                event_name = entry.get('event', 'log')
                # ★ Deduplication: skip if this connection has already sent the same _log_id
                log_id = entry.get('_log_id')
                if log_id and log_id in _live_seen_ids:
                    print(f'[logs-sse] Dropping duplicate event={event_name} _log_id={log_id}', flush=True)
                    continue
                if log_id:
                    _live_seen_ids.add(log_id)
                # Make a copy without 'event' key for SSE data payload
                data_for_sse = {k: v for k, v in entry.items() if k != 'event'}
                # ★ 2026-04-28 移除高频 print：token/reasoning 事件每秒数十次，
                #   print 到 stdout 会产生大量 I/O 瓶颈。仅保留非 token 事件的日志。
                if event_name not in ('token', 'reasoning'):
                    print(f'[logs-sse] Sending event={event_name} sid={data_for_sse.get("session_id","")[:8]}', flush=True)
                _sse(handler, event_name, data_for_sse)
            except (TypeError, ValueError) as e:
                # Serialization error — skip this entry but keep the stream alive
                print(f'[logs-sse] Skipping entry due to serialization error: {e}', flush=True)
            except (BrokenPipeError, ConnectionResetError, ConnectionAbortedError):
                raise  # let outer except handle disconnect
    except (BrokenPipeError, ConnectionResetError, ConnectionAbortedError):
        pass
    finally:
        with LOG_SUBSCRIBERS_LOCK:
            try:
                LOG_SUBSCRIBERS.remove(q)
            except ValueError:
                pass
    return True


def _handle_file_raw(handler, parsed):
    qs = parse_qs(parsed.query)
    sid = qs.get("session_id", [""])[0]
    if not sid:
        return bad(handler, "session_id is required")
    try:
        s = get_session(sid)
    except KeyError:
        return bad(handler, "Session not found", 404)
    rel = qs.get("path", [""])[0]
    force_download = qs.get("download", [""])[0] == "1"
    target = safe_resolve(Path(s.workspace), rel)
    if not target.exists() or not target.is_file():
        return j(handler, {"error": "not found"}, status=404)
    ext = target.suffix.lower()
    mime = MIME_MAP.get(ext, "application/octet-stream")
    raw_bytes = target.read_bytes()
    import urllib.parse as _up

    safe_name = _up.quote(target.name, safe="")
    handler.send_response(200)
    handler.send_header("Content-Type", mime)
    handler.send_header("Content-Length", str(len(raw_bytes)))
    handler.send_header("Cache-Control", "no-store")
    # Security: force download for dangerous MIME types to prevent XSS
    dangerous_types = {"text/html", "application/xhtml+xml", "image/svg+xml"}
    if force_download or mime in dangerous_types:
        handler.send_header(
            "Content-Disposition",
            f"attachment; filename=\"{target.name}\"; filename*=UTF-8''{safe_name}",
        )
    else:
        handler.send_header(
            "Content-Disposition",
            f"inline; filename=\"{target.name}\"; filename*=UTF-8''{safe_name}",
        )
    handler.end_headers()
    handler.wfile.write(raw_bytes)
    return True


def _handle_file_read(handler, parsed):
    qs = parse_qs(parsed.query)
    sid = qs.get("session_id", [""])[0]
    if not sid:
        return bad(handler, "session_id is required")
    try:
        s = get_session(sid)
    except KeyError:
        return bad(handler, "Session not found", 404)
    rel = qs.get("path", [""])[0]
    if not rel:
        return bad(handler, "path is required")
    try:
        return j(handler, read_file_content(Path(s.workspace), rel))
    except (FileNotFoundError, ValueError) as e:
        return bad(handler, _sanitize_error(e), 404)


def _handle_approval_pending(handler, parsed):
    sid = parse_qs(parsed.query).get("session_id", [""])[0]
    with _lock:
        p = _pending.get(sid)
    if p:
        return j(handler, {"pending": dict(p)})
    return j(handler, {"pending": None})


def _handle_approval_inject(handler, parsed):
    """Inject a fake pending approval -- loopback-only, used by automated tests."""
    qs = parse_qs(parsed.query)
    sid = qs.get("session_id", [""])[0]
    key = qs.get("pattern_key", ["test_pattern"])[0]
    cmd = qs.get("command", ["rm -rf /tmp/test"])[0]
    if sid:
        submit_pending(
            sid,
            {
                "command": cmd,
                "pattern_key": key,
                "pattern_keys": [key],
                "description": "test pattern",
            },
        )
        return j(handler, {"ok": True, "session_id": sid})
    return j(handler, {"error": "session_id required"}, status=400)


def _handle_cron_output(handler, parsed):
    from cron.jobs import OUTPUT_DIR as CRON_OUT

    qs = parse_qs(parsed.query)
    job_id = qs.get("job_id", [""])[0]
    limit = int(qs.get("limit", ["5"])[0])
    if not job_id:
        return j(handler, {"error": "job_id required"}, status=400)
    out_dir = CRON_OUT / job_id
    outputs = []
    if out_dir.exists():
        files = sorted(out_dir.glob("*.md"), reverse=True)[:limit]
        for f in files:
            try:
                txt = f.read_text(encoding="utf-8", errors="replace")
                outputs.append({"filename": f.name, "content": txt[:8000]})
            except Exception:
                pass
    return j(handler, {"job_id": job_id, "outputs": outputs})


def _handle_cron_recent(handler, parsed):
    """Return cron jobs that have completed since a given timestamp."""
    import datetime

    qs = parse_qs(parsed.query)
    since = float(qs.get("since", ["0"])[0])
    try:
        from cron.jobs import list_jobs

        jobs = list_jobs(include_disabled=True)
        completions = []
        for job in jobs:
            last_run = job.get("last_run_at")
            if not last_run:
                continue
            if isinstance(last_run, str):
                try:
                    ts = datetime.datetime.fromisoformat(
                        last_run.replace("Z", "+00:00")
                    ).timestamp()
                except (ValueError, TypeError):
                    continue
            else:
                ts = float(last_run)
            if ts > since:
                completions.append(
                    {
                        "job_id": job.get("id", ""),
                        "name": job.get("name", "Unknown"),
                        "status": job.get("last_status", "unknown"),
                        "completed_at": ts,
                    }
                )
        return j(handler, {"completions": completions, "since": since})
    except ImportError:
        return j(handler, {"completions": [], "since": since})


def _handle_memory_read(handler):
    try:
        from api.profiles import get_active_hermes_home

        mem_dir = get_active_hermes_home() / "memories"
    except ImportError:
        mem_dir = Path.home() / ".hermes" / "memories"
    mem_file = mem_dir / "MEMORY.md"
    user_file = mem_dir / "USER.md"
    memory = (
        mem_file.read_text(encoding="utf-8", errors="replace")
        if mem_file.exists()
        else ""
    )
    user = (
        user_file.read_text(encoding="utf-8", errors="replace")
        if user_file.exists()
        else ""
    )
    return j(
        handler,
        {
            "memory": _redact_text(memory),
            "user": _redact_text(user),
            "memory_path": str(mem_file),
            "user_path": str(user_file),
            "memory_mtime": mem_file.stat().st_mtime if mem_file.exists() else None,
            "user_mtime": user_file.stat().st_mtime if user_file.exists() else None,
        },
    )


# ── POST route helpers ────────────────────────────────────────────────────────


def _handle_sessions_cleanup(handler, body, zero_only=False):
    cleaned = 0
    for p in SESSION_DIR.glob("*.json"):
        if p.name.startswith("_"):
            continue
        try:
            s = Session.load(p.stem)
            if zero_only:
                should_delete = s and len(s.messages) == 0
            else:
                should_delete = s and s.title == "Untitled" and len(s.messages) == 0
            if should_delete:
                with LOCK:
                    SESSIONS.pop(p.stem, None)
                p.unlink(missing_ok=True)
                cleaned += 1
        except Exception:
            pass
    if SESSION_INDEX_FILE.exists():
        SESSION_INDEX_FILE.unlink(missing_ok=True)
    return j(handler, {"ok": True, "cleaned": cleaned})


def _handle_chat_start(handler, body):
    try:
        require(body, "session_id")
    except ValueError as e:
        return bad(handler, str(e))
    try:
        s = get_session(body["session_id"])
    except KeyError:
        return bad(handler, "Session not found", 404)
    msg = str(body.get("message", "")).strip()
    if not msg:
        return bad(handler, "message is required")
    attachments = [str(a) for a in (body.get("attachments") or [])][:20]
    workspace = str(Path(body.get("workspace") or s.workspace).expanduser().resolve())
    model = body.get("model") or s.model or DEFAULT_MODEL
    print(f"[_handle_chat_start] session_id={body['session_id'][:12]} workspace='{workspace}' model='{model}' employee='{body.get('employee_name','')}'", flush=True)
    system_prompt = body.get("system_prompt") or getattr(s, 'system_prompt', '') or ""
    employee_name = body.get("employee_name", "") or ""
    s.workspace = workspace
    s.model = model
    if system_prompt:
        s.system_prompt = system_prompt
    s.save()
    set_last_workspace(workspace)
    # ★ disable_tools: 用于 configHtml 生成等不需要工具的场景
    disable_tools = bool(body.get("disable_tools", False))
    # ★ enable_web_search: 联网搜索开关（Knot AG-UI 协议参数）
    enable_web_search = bool(body.get("enable_web_search", False))
    # ★ Log user input to the unified log panel
    _broadcast_log_event('user_input', {
        'text': msg[:500] + ('...' if len(msg) > 500 else ''),
        'message': f"用户输入: {msg[:120]}{'...' if len(msg) > 120 else ''}",
        'attachments_count': len(attachments),
    }, session_id=s.session_id, employee_name=employee_name)
    stream_id = uuid.uuid4().hex
    q = queue.Queue()
    with STREAMS_LOCK:
        STREAMS[stream_id] = q
    thr = threading.Thread(
        target=_run_agent_streaming,
        args=(s.session_id, msg, model, workspace, stream_id, attachments, system_prompt, employee_name, disable_tools, enable_web_search),
        daemon=True,
    )
    thr.start()
    return j(handler, {"stream_id": stream_id, "session_id": s.session_id})


def _handle_chat_sync(handler, body):
    """Fallback synchronous chat endpoint (POST /api/chat). Not used by frontend."""
    from api.config import _get_session_agent_lock

    s = get_session(body["session_id"])
    msg = str(body.get("message", "")).strip()
    if not msg:
        return j(handler, {"error": "empty message"}, status=400)
    workspace = Path(body.get("workspace") or s.workspace).expanduser().resolve()
    s.workspace = str(workspace)
    s.model = body.get("model") or s.model
    from api.streaming import _ENV_LOCK

    with _ENV_LOCK:
        old_cwd = os.environ.get("TERMINAL_CWD")
        os.environ["TERMINAL_CWD"] = str(workspace)
        old_exec_ask = os.environ.get("HERMES_EXEC_ASK")
        old_session_key = os.environ.get("HERMES_SESSION_KEY")
        os.environ["HERMES_EXEC_ASK"] = "1"
        os.environ["HERMES_SESSION_KEY"] = s.session_id
    try:
        from run_agent import AIAgent

        with CHAT_LOCK:
            from api.config import resolve_model_provider

            _model, _provider, _base_url = resolve_model_provider(s.model)
            # Resolve API key via Hermes runtime provider (matches gateway behaviour)
            _api_key = None
            try:
                from hermes_cli.runtime_provider import resolve_runtime_provider

                _rt = resolve_runtime_provider(requested=_provider)
                _api_key = _rt.get("api_key")
                # Also use runtime provider/base_url if the webui config didn't resolve them
                if not _provider:
                    _provider = _rt.get("provider")
                if not _base_url:
                    _base_url = _rt.get("base_url")
            except Exception as _e:
                print(
                    f"[webui] WARNING: resolve_runtime_provider failed: {_e}",
                    flush=True,
                )
            agent = AIAgent(
                model=_model,
                provider=_provider,
                base_url=_base_url,
                api_key=_api_key,
                platform="cli",
                quiet_mode=True,
                enabled_toolsets=CLI_TOOLSETS,
                session_id=s.session_id,
            )
            workspace_ctx = f"[Workspace: {s.workspace}]\n"
            workspace_system_msg = (
                f"Active workspace at session start: {s.workspace}\n"
                "Every user message is prefixed with [Workspace: /absolute/path] indicating the "
                "workspace the user has selected in the web UI at the time they sent that message. "
                "This tag is the single authoritative source of the active workspace and updates "
                "with every message. It overrides any prior workspace mentioned in this system "
                "prompt, memory, or conversation history. Always use the value from the most recent "
                "[Workspace: ...] tag as your default working directory for ALL file operations: "
                "write_file, read_file, search_files, terminal workdir, and patch. "
                "Never fall back to a hardcoded path when this tag is present."
            )
            from api.streaming import _sanitize_messages_for_api

            result = agent.run_conversation(
                user_message=workspace_ctx + msg,
                system_message=workspace_system_msg,
                conversation_history=_sanitize_messages_for_api(s.messages),
                task_id=s.session_id,
                persist_user_message=msg,
            )
    finally:
        with _ENV_LOCK:
            if old_cwd is None:
                os.environ.pop("TERMINAL_CWD", None)
            else:
                os.environ["TERMINAL_CWD"] = old_cwd
            if old_exec_ask is None:
                os.environ.pop("HERMES_EXEC_ASK", None)
            else:
                os.environ["HERMES_EXEC_ASK"] = old_exec_ask
            if old_session_key is None:
                os.environ.pop("HERMES_SESSION_KEY", None)
            else:
                os.environ["HERMES_SESSION_KEY"] = old_session_key
    s.messages = result.get("messages") or s.messages
    # Only auto-generate title when still default; preserves user renames
    if s.title == "Untitled":
        s.title = title_from(s.messages, s.title)
    s.save()
    # Sync to state.db for /insights (opt-in setting)
    try:
        if load_settings().get("sync_to_insights"):
            from api.state_sync import sync_session_usage

            sync_session_usage(
                session_id=s.session_id,
                input_tokens=s.input_tokens or 0,
                output_tokens=s.output_tokens or 0,
                estimated_cost=s.estimated_cost,
                model=s.model,
                title=s.title,
                message_count=len(s.messages),
            )
    except Exception:
        pass
    return j(
        handler,
        {
            "answer": result.get("final_response") or "",
            "status": "done" if result.get("completed", True) else "partial",
            "session": s.compact() | {"messages": s.messages},
            "result": {k: v for k, v in result.items() if k != "messages"},
        },
    )


def _handle_cron_create(handler, body):
    try:
        require(body, "prompt", "schedule")
    except ValueError as e:
        return bad(handler, str(e))
    try:
        from cron.jobs import create_job

        job = create_job(
            prompt=body["prompt"],
            schedule=body["schedule"],
            name=body.get("name") or None,
            deliver=body.get("deliver") or "local",
            skills=body.get("skills") or [],
            model=body.get("model") or None,
        )
        return j(handler, {"ok": True, "job": job})
    except Exception as e:
        return j(handler, {"error": str(e)}, status=400)


def _handle_cron_update(handler, body):
    try:
        require(body, "job_id")
    except ValueError as e:
        return bad(handler, str(e))
    from cron.jobs import update_job

    updates = {k: v for k, v in body.items() if k != "job_id" and v is not None}
    job = update_job(body["job_id"], updates)
    if not job:
        return bad(handler, "Job not found", 404)
    return j(handler, {"ok": True, "job": job})


def _handle_cron_delete(handler, body):
    try:
        require(body, "job_id")
    except ValueError as e:
        return bad(handler, str(e))
    from cron.jobs import remove_job

    ok = remove_job(body["job_id"])
    if not ok:
        return bad(handler, "Job not found", 404)
    return j(handler, {"ok": True, "job_id": body["job_id"]})


def _handle_cron_run(handler, body):
    job_id = body.get("job_id", "")
    if not job_id:
        return bad(handler, "job_id required")
    from cron.jobs import get_job
    from cron.scheduler import run_job

    job = get_job(job_id)
    if not job:
        return bad(handler, "Job not found", 404)
    threading.Thread(target=run_job, args=(job,), daemon=True).start()
    return j(handler, {"ok": True, "job_id": job_id, "status": "triggered"})


def _handle_cron_pause(handler, body):
    job_id = body.get("job_id", "")
    if not job_id:
        return bad(handler, "job_id required")
    from cron.jobs import pause_job

    result = pause_job(job_id, reason=body.get("reason"))
    if result:
        return j(handler, {"ok": True, "job": result})
    return bad(handler, "Job not found", 404)


def _handle_cron_resume(handler, body):
    job_id = body.get("job_id", "")
    if not job_id:
        return bad(handler, "job_id required")
    from cron.jobs import resume_job

    result = resume_job(job_id)
    if result:
        return j(handler, {"ok": True, "job": result})
    return bad(handler, "Job not found", 404)


def _handle_file_delete(handler, body):
    try:
        require(body, "session_id", "path")
    except ValueError as e:
        return bad(handler, str(e))
    try:
        s = get_session(body["session_id"])
    except KeyError:
        return bad(handler, "Session not found", 404)
    try:
        target = safe_resolve(Path(s.workspace), body["path"])
        if not target.exists():
            return bad(handler, "File not found", 404)
        if target.is_dir():
            import shutil
            shutil.rmtree(target)
        else:
            target.unlink()
        return j(handler, {"ok": True, "path": body["path"]})
    except (ValueError, PermissionError) as e:
        return bad(handler, _sanitize_error(e))


def _handle_file_save(handler, body):
    try:
        require(body, "session_id", "path")
    except ValueError as e:
        return bad(handler, str(e))
    try:
        s = get_session(body["session_id"])
    except KeyError:
        return bad(handler, "Session not found", 404)
    try:
        target = safe_resolve(Path(s.workspace), body["path"])
        if not target.exists():
            return bad(handler, "File not found", 404)
        if target.is_dir():
            return bad(handler, "Cannot save: path is a directory")
        target.write_text(body.get("content", ""), encoding="utf-8")
        return j(
            handler, {"ok": True, "path": body["path"], "size": target.stat().st_size}
        )
    except (ValueError, PermissionError) as e:
        return bad(handler, _sanitize_error(e))


def _handle_file_create(handler, body):
    try:
        require(body, "session_id", "path")
    except ValueError as e:
        return bad(handler, str(e))
    try:
        s = get_session(body["session_id"])
    except KeyError:
        return bad(handler, "Session not found", 404)
    try:
        target = safe_resolve(Path(s.workspace), body["path"])
        if target.exists():
            return bad(handler, "File already exists")
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(body.get("content", ""), encoding="utf-8")
        return j(
            handler, {"ok": True, "path": str(target.relative_to(Path(s.workspace)))}
        )
    except (ValueError, PermissionError) as e:
        return bad(handler, _sanitize_error(e))


def _handle_file_rename(handler, body):
    try:
        require(body, "session_id", "path", "new_name")
    except ValueError as e:
        return bad(handler, str(e))
    try:
        s = get_session(body["session_id"])
    except KeyError:
        return bad(handler, "Session not found", 404)
    try:
        source = safe_resolve(Path(s.workspace), body["path"])
        if not source.exists():
            return bad(handler, "File not found", 404)
        new_name = body["new_name"].strip()
        if not new_name or "/" in new_name or ".." in new_name:
            return bad(handler, "Invalid file name")
        dest = source.parent / new_name
        if dest.exists():
            return bad(handler, f'A file named "{new_name}" already exists')
        source.rename(dest)
        new_rel = str(dest.relative_to(Path(s.workspace)))
        return j(handler, {"ok": True, "old_path": body["path"], "new_path": new_rel})
    except (ValueError, PermissionError, OSError) as e:
        return bad(handler, _sanitize_error(e))


def _handle_create_dir(handler, body):
    try:
        require(body, "session_id", "path")
    except ValueError as e:
        return bad(handler, str(e))
    try:
        s = get_session(body["session_id"])
    except KeyError:
        return bad(handler, "Session not found", 404)
    try:
        target = safe_resolve(Path(s.workspace), body["path"])
        if target.exists():
            return bad(handler, "Path already exists")
        target.mkdir(parents=True)
        return j(
            handler, {"ok": True, "path": str(target.relative_to(Path(s.workspace)))}
        )
    except (ValueError, PermissionError, OSError) as e:
        return bad(handler, _sanitize_error(e))


def _handle_file_reveal(handler, body):
    """Reveal a file or directory in the system file manager."""
    import subprocess
    import platform
    import shutil
    try:
        require(body, "session_id", "path")
    except ValueError as e:
        return bad(handler, str(e))
    try:
        s = get_session(body["session_id"])
    except KeyError:
        return bad(handler, "Session not found", 404)
    try:
        # 优先使用前端传递的 workspace（画布工作区），回退到 session.workspace
        workspace = Path(body.get("workspace") or s.workspace)
        target = safe_resolve(workspace, body["path"])
        if not target.exists():
            return bad(handler, f"Path not found: {body['path']} (resolved={target}, workspace={workspace})", 404)
        system = platform.system()
        # Resolve host paths for Docker environments (always include in response)
        from api.config import resolve_host_path
        dir_to_open = str(target.parent if target.is_file() else target)
        host_path = resolve_host_path(dir_to_open)
        host_file_path = resolve_host_path(str(target)) if target.is_file() else None
        # Normalize host path to Windows-style backslashes for display/opening
        host_path_win = host_path.replace("/", "\\") if host_path else None
        host_file_path_win = host_file_path.replace("/", "\\") if host_file_path else None
        try:
            if system == "Windows":
                if target.is_file():
                    subprocess.Popen(
                        ['explorer', '/select,', str(target)],
                        creationflags=0x08000000,  # CREATE_NO_WINDOW
                    )
                else:
                    subprocess.Popen(
                        ['explorer', str(target)],
                        creationflags=0x08000000,
                    )
            elif system == "Darwin":
                subprocess.Popen(['open', '-R', str(target)])
            else:
                # Linux / Docker: try multiple file managers in priority order
                openers = ['xdg-open', 'nautilus', 'dolphin', 'thunar', 'pcmanfm', 'nemo', 'caja']
                opener = None
                for cmd in openers:
                    if shutil.which(cmd):
                        opener = cmd
                        break
                if opener:
                    args = [opener, dir_to_open]
                    if opener == 'nautilus':
                        # nautilus supports --select to highlight a specific file
                        if target.is_file():
                            args = [opener, '--select', str(target)]
                    subprocess.Popen(args, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
                else:
                    # No file manager available (e.g. minimal Docker container)
                    return j(handler, {"ok": True, "path": body["path"],
                                       "hint": "No file manager found on this system",
                                       "dir_path": dir_to_open,
                                       "host_path": host_path_win or host_path,
                                       "host_file_path": host_file_path_win or host_file_path,
                                       "host_path_url": _host_path_to_file_url(host_path_win or host_path),
                                       "host_file_path_url": _host_path_to_file_url(host_file_path_win or host_file_path)})
            return j(handler, {"ok": True, "path": body["path"],
                               "host_path": host_path_win or host_path,
                               "host_file_path": host_file_path_win or host_file_path,
                               "host_path_url": _host_path_to_file_url(host_path_win or host_path),
                               "host_file_path_url": _host_path_to_file_url(host_file_path_win or host_file_path)})
        except (OSError, FileNotFoundError) as e:
            return bad(handler, f"Failed to open file manager: {e}")
    except (ValueError, PermissionError) as e:
        return bad(handler, _sanitize_error(e))


def _host_path_to_file_url(host_path):
    """Convert a host path (e.g. G:\\path or /home/user/path) to a file:/// URL.
    This allows the browser to attempt opening the path on the host machine."""
    if not host_path:
        return None
    # Windows path: G:\path → file:///G:/path
    import re
    if re.match(r'^[A-Za-z]:[/\\]', host_path):
        # Replace backslashes with forward slashes
        normalized = host_path.replace('\\', '/')
        return 'file:///' + normalized
    # Unix path: /home/user → file:///home/user
    return 'file://' + host_path


def _handle_workspace_add(handler, body):
    path_str = body.get("path", "").strip()
    name = body.get("name", "").strip()
    create = body.get("create", False)  # auto-create if not exists
    if not path_str:
        return bad(handler, "path is required")
    p = Path(path_str).expanduser().resolve()

    # If the path doesn't exist and we need to create it, check if the
    # parent directory is writable.  If not (e.g. Docker container where
    # only /workspace and $HOME are writable), redirect to a subdirectory
    # under the current default workspace so creation succeeds.
    if not p.exists():
        if create:
            # First attempt: try creating directly
            try:
                p.mkdir(parents=True, exist_ok=True)
            except PermissionError:
                # Permission denied — redirect under DEFAULT_WORKSPACE
                ws_root = Path(str(DEFAULT_WORKSPACE))
                # If the user gave an absolute path like /workspace1,
                # use just the last component as the subdir name
                if p.is_absolute():
                    subdir = p.name  # e.g. "workspace1" from "/workspace1"
                else:
                    subdir = str(p)
                redirected = ws_root / subdir
                try:
                    redirected.mkdir(parents=True, exist_ok=True)
                except (OSError, PermissionError) as e2:
                    return bad(handler, f"Permission denied for {p}. "
                               f"Also tried redirect to {redirected}: {e2}")
                p = redirected
            except OSError as e:
                return bad(handler, f"Failed to create directory {p}: {e}")
        else:
            return bad(handler, f"Path does not exist: {p} (pass create=true to auto-create)")
    if not p.is_dir():
        return bad(handler, f"Path is not a directory: {p}")
    wss = load_workspaces()
    if any(w["path"] == str(p) for w in wss):
        return bad(handler, "Workspace already in list")
    wss.append({"path": str(p), "name": name or p.name})
    save_workspaces(wss)

    # Auto-initialize template employees into the new workspace (legacy)
    try:
        from api.employee_templates import initialize_workspace_employees
        init_result = initialize_workspace_employees(str(p))
    except Exception as e:
        init_result = {"created": 0, "skipped": 0, "errors": [str(e)]}

    # Create centralized workspace structure in workspaces/ directory
    ws_manager_result = None
    try:
        from api.workspace_manager import create_workspace as _wm_create, initialize_from_templates
        ws_name = name or p.name
        ws_info = _wm_create(name=ws_name, path=str(p))
        tmpl_result = initialize_from_templates(ws_info["slug"])
        ws_manager_result = {
            "slug": ws_info["slug"],
            "created_employees": tmpl_result.get("created", 0),
        }
    except Exception as e:
        ws_manager_result = {"error": str(e)}

    # ── Sync with knot-cli workspace registry ──
    # Use `knot-cli workspace --action list` to check, then `--action add` if missing
    knot_sync_result = None
    try:
        from api.knot_agui import ensure_knot_workspace, _get_knot_cli_path
        if _get_knot_cli_path():
            knot_sync_result = ensure_knot_workspace(str(p))
            print(f"[workspace-add] knot sync: {knot_sync_result}", flush=True)
    except Exception as e:
        knot_sync_result = {"ok": False, "action": "error", "message": str(e)}
        print(f"[workspace-add] knot sync error: {e}", flush=True)

    return j(handler, {
        "ok": True, "workspaces": wss, "resolved_path": str(p),
        "template_init": init_result,
        "ws_manager": ws_manager_result,
        "knot_sync": knot_sync_result
    })


def _handle_workspace_remove(handler, body):
    path_str = body.get("path", "").strip()
    if not path_str:
        return bad(handler, "path is required")
    wss = load_workspaces()
    wss = [w for w in wss if w["path"] != path_str]
    save_workspaces(wss)

    # ── Sync with knot-cli: remove workspace from registry ──
    knot_sync_result = None
    try:
        from api.knot_agui import remove_knot_workspace, _get_knot_cli_path
        if _get_knot_cli_path():
            knot_sync_result = remove_knot_workspace(path_str)
            print(f"[workspace-remove] knot sync: {knot_sync_result}", flush=True)
    except Exception as e:
        knot_sync_result = {"ok": False, "action": "error", "message": str(e)}
        print(f"[workspace-remove] knot sync error: {e}", flush=True)

    return j(handler, {"ok": True, "workspaces": wss, "knot_sync": knot_sync_result})


def _handle_workspace_rename(handler, body):
    path_str = body.get("path", "").strip()
    name = body.get("name", "").strip()
    if not path_str or not name:
        return bad(handler, "path and name are required")
    wss = load_workspaces()
    for w in wss:
        if w["path"] == path_str:
            w["name"] = name
            break
    else:
        return bad(handler, "Workspace not found", 404)
    save_workspaces(wss)
    return j(handler, {"ok": True, "workspaces": wss})


def _handle_approval_respond(handler, body):
    sid = body.get("session_id", "")
    if not sid:
        return bad(handler, "session_id is required")
    choice = body.get("choice", "deny")
    if choice not in ("once", "session", "always", "deny"):
        return bad(handler, f"Invalid choice: {choice}")
    # Pop the legacy polling-mode pending entry (no-op when gateway path is active).
    with _lock:
        pending = _pending.pop(sid, None)
    if pending:
        keys = pending.get("pattern_keys") or [pending.get("pattern_key", "")]
        if choice in ("once", "session"):
            for k in keys:
                approve_session(sid, k)
        elif choice == "always":
            for k in keys:
                approve_session(sid, k)
                approve_permanent(k)
            save_permanent_allowlist(_permanent_approved)
    # Unblock the agent thread waiting in the gateway approval queue.
    # This is the primary signal when streaming is active — the agent
    # thread is parked in entry.event.wait() and needs to be woken up.
    resolve_gateway_approval(sid, choice, resolve_all=False)
    return j(handler, {"ok": True, "choice": choice})


def _handle_clarify_respond(handler, body):
    """POST /api/clarify/respond

    User answers a pending clarify question.  Body:
        session_id: str
        answer: str
    """
    from api.streaming import resolve_clarify
    sid = body.get("session_id", "")
    answer = body.get("answer", "").strip()
    if not sid:
        return bad(handler, "session_id is required")
    if not answer:
        return bad(handler, "answer is required")
    ok = resolve_clarify(sid, answer)
    if not ok:
        return bad(handler, "No pending clarify question for this session", 404)
    return j(handler, {"ok": True, "answer": answer})


# ═════════════════════════════════════════════════════════════════════════
# P3: "下一步"暂停机制（Pausable Agent）
# ═════════════════════════════════════════════════════════════════════════

def _handle_browser_continue(handler, body):
    """
    POST /api/browser/continue
    Body: { session_id: str, action: "continue" | "cancel" }

    用户点了「下一步」或「取消任务」，解除 agent 阻塞。
    """
    sid = (body.get("session_id") or "").strip()
    action = (body.get("action") or "continue").strip().lower()
    if not sid:
        return bad(handler, "session_id is required")
    if action not in ("continue", "cancel"):
        action = "continue"
    try:
        from tools.user_continue_tool import resolve_pending
    except Exception as e:
        return bad(handler, f"user_continue_tool not available: {e}", 500)
    ok = resolve_pending(sid, action)
    if not ok:
        return bad(handler, "No pending 'continue' request for this session", 404)
    return j(handler, {"ok": True, "action": action})


def _handle_browser_continue_pending(handler, parsed):
    """
    GET /api/browser/continue/pending?session_id=...
    查询当前 session 是否有挂起的 "下一步" 请求（用于页面刷新后恢复显示按钮）。
    """
    qs = parse_qs(parsed.query)
    sid = (qs.get("session_id", [""])[0] or "").strip()
    if not sid:
        return bad(handler, "session_id is required")
    try:
        from tools.user_continue_tool import get_pending
    except Exception:
        return j(handler, {"pending": None})
    p = get_pending(sid)
    return j(handler, {"pending": p})


def _handle_browser_shot(handler, parsed):
    """
    GET /api/browser/shot?session_id=<sid>&file=<shot_xxx.png>
    返回浏览器截图 PNG（由 BrowserEventCapture 生成）。
    """
    qs = parse_qs(parsed.query)
    sid = (qs.get("session_id", [""])[0] or "").strip()
    fname = (qs.get("file", [""])[0] or "").strip()
    # 严格校验：只允许 shot_xxx.png
    if not sid or not fname:
        return bad(handler, "session_id and file required")
    import re as _re_shot
    if not _re_shot.match(r"^shot_[a-f0-9]{6,32}\.png$", fname):
        return bad(handler, "Invalid file name")
    if "/" in sid or ".." in sid or "\\" in sid:
        return bad(handler, "Invalid session_id")
    try:
        from api.browser_events import _get_webui_home
        shots_dir = _get_webui_home() / sid
        path = (shots_dir / fname).resolve()
        # 防越狱
        try:
            path.relative_to(shots_dir.resolve())
        except ValueError:
            return bad(handler, "Forbidden path")
        if not path.exists():
            return bad(handler, "Shot not found", 404)
        data = path.read_bytes()
    except Exception as e:
        return bad(handler, f"Read failed: {e}", 500)
    return t(handler, data, content_type="image/png")


# ═════════════════════════════════════════════════════════════════════════
# P5: Agent Packs（外部员工包） — ComfyUI 式插件化员工
# ═════════════════════════════════════════════════════════════════════════

def _handle_agent_packs_list(handler):
    """GET /api/agent-packs  列出所有已安装的外部员工包。"""
    try:
        from api.agent_packs import get_registry
        packs = get_registry().list()
    except Exception as e:
        return bad(handler, f"agent_packs unavailable: {e}", 500)
    return j(handler, {"packs": packs})


def _handle_agent_pack_definition(handler, parsed):
    """GET /api/agent-packs/<pack_id>/definition
    返回包内所有员工的完整定义（含 system_prompt、toolsets、skills 等）。
    """
    import re as _re_pk
    m = _re_pk.match(r"^/api/agent-packs/([^/]+)/definition$", parsed.path)
    if not m:
        return bad(handler, "Bad path")
    pack_id = m.group(1)
    try:
        from api.agent_packs import get_registry
        pack = get_registry().get_pack(pack_id)
    except Exception as e:
        return bad(handler, f"Failed: {e}", 500)
    if pack is None:
        return bad(handler, "Pack not found", 404)
    return j(handler, pack)


def _handle_agent_pack_ui_asset(handler, parsed):
    """GET /api/agent-packs/ui/<pack_id>/<...path>
    提供包内 ui/ 目录下的静态资源（html/js/css/png）。
    """
    import re as _re_pk
    m = _re_pk.match(r"^/api/agent-packs/ui/([^/]+)/(.+)$", parsed.path)
    if not m:
        return bad(handler, "Bad path")
    pack_id, rel = m.group(1), m.group(2)
    try:
        from api.agent_packs import get_registry
        path = get_registry().resolve_ui_asset(pack_id, rel)
    except Exception as e:
        return bad(handler, f"Failed: {e}", 500)
    if path is None or not path.exists():
        return bad(handler, "Asset not found", 404)
    # 推断 MIME
    ext = path.suffix.lower()
    ctype = {
        ".html": "text/html; charset=utf-8",
        ".js":   "application/javascript; charset=utf-8",
        ".css":  "text/css; charset=utf-8",
        ".png":  "image/png",
        ".jpg":  "image/jpeg", ".jpeg": "image/jpeg",
        ".svg":  "image/svg+xml",
        ".json": "application/json; charset=utf-8",
    }.get(ext, "application/octet-stream")
    try:
        data = path.read_bytes()
    except Exception as e:
        return bad(handler, f"Read failed: {e}", 500)
    return t(handler, data, content_type=ctype)


def _handle_agent_pack_install(handler, body):
    """POST /api/agent-packs/install  Body: { source: str } — file path / git url / zip upload。"""
    src = (body.get("source") or "").strip()
    if not src:
        return bad(handler, "source is required")
    try:
        from api.agent_packs import get_registry
        result = get_registry().install(src)
    except Exception as e:
        return bad(handler, f"Install failed: {e}", 500)
    return j(handler, result)


def _handle_agent_pack_uninstall(handler, body):
    pack_id = (body.get("id") or body.get("pack_id") or "").strip()
    if not pack_id:
        return bad(handler, "id is required")
    try:
        from api.agent_packs import get_registry
        result = get_registry().uninstall(pack_id)
    except Exception as e:
        return bad(handler, f"Uninstall failed: {e}", 500)
    return j(handler, result)


def _handle_agent_pack_set_enabled(handler, body):
    pack_id = (body.get("id") or body.get("pack_id") or "").strip()
    enabled = bool(body.get("enabled", True))
    if not pack_id:
        return bad(handler, "id is required")
    try:
        from api.agent_packs import get_registry
        result = get_registry().set_enabled(pack_id, enabled)
    except Exception as e:
        return bad(handler, f"Failed: {e}", 500)
    return j(handler, result)


def _handle_skill_save(handler, body):
    try:
        require(body, "name", "content")
    except ValueError as e:
        return bad(handler, str(e))
    skill_name = body["name"].strip().lower().replace(" ", "-")
    if not skill_name or "/" in skill_name or ".." in skill_name:
        return bad(handler, "Invalid skill name")
    category = body.get("category", "").strip()
    if category and ("/" in category or ".." in category):
        return bad(handler, "Invalid category")
    from tools.skills_tool import SKILLS_DIR

    if category:
        skill_dir = SKILLS_DIR / category / skill_name
    else:
        skill_dir = SKILLS_DIR / skill_name
    # Validate resolved path stays within SKILLS_DIR
    try:
        skill_dir.resolve().relative_to(SKILLS_DIR.resolve())
    except ValueError:
        return bad(handler, "Invalid skill path")
    skill_dir.mkdir(parents=True, exist_ok=True)
    skill_file = skill_dir / "SKILL.md"
    skill_file.write_text(body["content"], encoding="utf-8")
    return j(handler, {"ok": True, "name": skill_name, "path": str(skill_file)})


def _handle_skill_delete(handler, body):
    try:
        require(body, "name")
    except ValueError as e:
        return bad(handler, str(e))
    from tools.skills_tool import SKILLS_DIR
    import shutil

    matches = list(SKILLS_DIR.rglob(f"{body['name']}/SKILL.md"))
    if not matches:
        return bad(handler, "Skill not found", 404)
    skill_dir = matches[0].parent
    shutil.rmtree(str(skill_dir))
    return j(handler, {"ok": True, "name": body["name"]})


# ── Employee Templates Handlers ──────────────────────────────────────────────


def _handle_employee_templates_list(handler, parsed):
    """GET /api/employee-templates — List all available templates."""
    from api.employee_templates import list_all_templates
    qs = parse_qs(parsed.query)
    source = (qs.get("source", [None])[0] or "").strip()

    if source == "preset":
        from api.employee_templates import list_preset_templates
        templates = list_preset_templates()
    elif source == "marketplace":
        from api.employee_templates import list_marketplace_templates
        templates = list_marketplace_templates()
    else:
        templates = list_all_templates()

    # Strip internal fields for API response
    cleaned = []
    for tmpl in templates:
        t_copy = {k: v for k, v in tmpl.items() if not k.startswith("_")}
        t_copy["source"] = tmpl.get("_source", "unknown")
        cleaned.append(t_copy)

    return j(handler, {"templates": cleaned})


def _handle_employee_templates_manifest(handler, parsed):
    """GET /api/employee-templates/manifest — Get the template manifest."""
    from api.employee_templates import load_manifest
    return j(handler, load_manifest())


def _handle_employee_templates_init(handler, body):
    """POST /api/employee-templates/init — Manually trigger template initialization."""
    workspace = (body.get("workspace") or "").strip()
    if not workspace:
        return bad(handler, "workspace is required")
    force = bool(body.get("force", False))

    from api.employee_templates import initialize_workspace_employees
    try:
        result = initialize_workspace_employees(workspace, force=force)
    except Exception as e:
        return bad(handler, f"Initialization failed: {e}", 500)
    return j(handler, {"ok": True, **result})


def _handle_employee_templates_install(handler, body):
    """POST /api/employee-templates/install — Install a marketplace template."""
    template_data = body.get("template")
    if not template_data or not isinstance(template_data, dict):
        return bad(handler, "template (object with id and name) is required")

    from api.employee_templates import install_marketplace_template
    result = install_marketplace_template(template_data)
    if result is None:
        return bad(handler, "Template must have 'id' and 'name' fields")
    return j(handler, {"ok": True, "template": result})


def _handle_employee_templates_uninstall(handler, body):
    """POST /api/employee-templates/uninstall — Remove a marketplace template."""
    template_id = (body.get("id") or body.get("template_id") or "").strip()
    if not template_id:
        return bad(handler, "id is required")

    from api.employee_templates import uninstall_marketplace_template
    removed = uninstall_marketplace_template(template_id)
    if not removed:
        return bad(handler, f"Template '{template_id}' not found", 404)
    return j(handler, {"ok": True, "removed": template_id})


def _handle_employee_templates_manifest_update(handler, body):
    """POST /api/employee-templates/manifest — Update the template manifest."""
    from api.employee_templates import load_manifest, save_manifest

    manifest = load_manifest()

    # Merge provided fields into current manifest
    if "auto_init_enabled" in body:
        manifest["auto_init_enabled"] = bool(body["auto_init_enabled"])
    if "auto_init_templates" in body:
        templates_list = body["auto_init_templates"]
        if isinstance(templates_list, list):
            manifest["auto_init_templates"] = templates_list

    save_manifest(manifest)
    return j(handler, {"ok": True, "manifest": manifest})


# ── Team Template Handlers ──────────────────────────────────────────────────


def _handle_team_templates_list(handler, parsed):
    """GET /api/team-templates — List all available team templates."""
    from api.team_templates import list_all_templates
    qs = parse_qs(parsed.query)
    source = (qs.get("source", [None])[0] or "").strip()

    if source == "preset":
        from api.team_templates import list_preset_templates
        templates = list_preset_templates()
    elif source == "marketplace":
        from api.team_templates import list_marketplace_templates
        templates = list_marketplace_templates()
    else:
        templates = list_all_templates()

    # Strip internal fields (prefixed with _)
    public = []
    for t in templates:
        public.append({k: v for k, v in t.items() if not k.startswith("_")})
    return j(handler, {"templates": public})


def _handle_team_templates_manifest(handler, parsed):
    """GET /api/team-templates/manifest — Get the team template manifest."""
    from api.team_templates import load_manifest
    return j(handler, load_manifest())


def _handle_team_templates_install(handler, body):
    """POST /api/team-templates/install — Install a marketplace team template."""
    template_data = body.get("template")
    if not template_data or not isinstance(template_data, dict):
        return bad(handler, "template (object with id and name) is required")

    from api.team_templates import install_marketplace_template
    result = install_marketplace_template(template_data)
    if not result:
        return bad(handler, "Template must have 'id' and 'name' fields")
    # Strip internal fields
    public = {k: v for k, v in result.items() if not k.startswith("_")}
    return j(handler, {"ok": True, "template": public})


def _handle_team_templates_uninstall(handler, body):
    """POST /api/team-templates/uninstall — Remove a marketplace team template."""
    template_id = (body.get("id") or body.get("template_id") or "").strip()
    if not template_id:
        return bad(handler, "id is required")

    from api.team_templates import uninstall_marketplace_template
    removed = uninstall_marketplace_template(template_id)
    if not removed:
        return bad(handler, f"Team template '{template_id}' not found", 404)
    return j(handler, {"ok": True, "removed": template_id})


def _handle_team_templates_manifest_update(handler, body):
    """POST /api/team-templates/manifest — Update the team template manifest."""
    from api.team_templates import load_manifest, save_manifest

    manifest = load_manifest()

    # Merge provided fields into current manifest
    if isinstance(body, dict):
        for key in body:
            if not key.startswith("_"):
                manifest[key] = body[key]

    save_manifest(manifest)
    return j(handler, {"ok": True, "manifest": manifest})


# ── Workspace Manager Handlers ───────────────────────────────────────────────


def _handle_ws_manager_list(handler, parsed):
    """GET /api/ws-manager/list — List all centralized workspaces."""
    from api.workspace_manager import list_workspaces as wm_list
    workspaces = wm_list()
    # Strip internal fields
    cleaned = [{k: v for k, v in ws.items() if not k.startswith("_")}
               for ws in workspaces]
    return j(handler, {"workspaces": cleaned})


def _handle_ws_manager_get(handler, parsed):
    """GET /api/ws-manager/get?slug=... — Get workspace details."""
    qs = parse_qs(parsed.query)
    slug = (qs.get("slug", [None])[0] or "").strip()
    if not slug:
        return bad(handler, "slug is required")
    from api.workspace_manager import get_workspace as wm_get
    ws = wm_get(slug)
    if not ws:
        return bad(handler, "Workspace not found", 404)
    return j(handler, ws)


def _handle_ws_manager_employees(handler, parsed):
    """GET /api/ws-manager/employees?slug=... — List employees in workspace."""
    qs = parse_qs(parsed.query)
    slug = (qs.get("slug", [None])[0] or "").strip()
    if not slug:
        return bad(handler, "slug is required")
    from api.workspace_manager import list_employee_instances
    employees = list_employee_instances(slug)
    # Strip internal fields
    cleaned = [{k: v for k, v in emp.items() if not k.startswith("_")}
               for emp in employees]
    return j(handler, {"employees": cleaned})


def _handle_ws_manager_connections_get(handler, parsed):
    """GET /api/ws-manager/connections?slug=... — Get connections."""
    qs = parse_qs(parsed.query)
    slug = (qs.get("slug", [None])[0] or "").strip()
    if not slug:
        return bad(handler, "slug is required")
    from api.workspace_manager import get_connections
    return j(handler, {"connections": get_connections(slug)})


def _handle_ws_manager_files(handler, parsed):
    """GET /api/ws-manager/files?slug=...&subdir=scripts|experience|skills"""
    qs = parse_qs(parsed.query)
    slug = (qs.get("slug", [None])[0] or "").strip()
    subdir = (qs.get("subdir", [None])[0] or "").strip()
    if not slug:
        return bad(handler, "slug is required")
    if not subdir:
        return bad(handler, "subdir is required (scripts, experience, skills)")
    from api.workspace_manager import list_scripts, list_experience, list_skills
    if subdir == "scripts":
        files = list_scripts(slug)
    elif subdir == "experience":
        files = list_experience(slug)
    elif subdir == "skills":
        files = list_skills(slug)
    else:
        return bad(handler, f"Invalid subdir: {subdir}")
    return j(handler, {"files": files, "subdir": subdir})


def _handle_ws_manager_create(handler, body):
    """POST /api/ws-manager/create — Create a new centralized workspace."""
    name = (body.get("name") or "").strip()
    if not name:
        return bad(handler, "name is required")
    path = (body.get("path") or "").strip()
    description = (body.get("description") or "").strip()
    team_name = (body.get("team_name") or "").strip()
    auto_init = body.get("auto_init", True)

    from api.workspace_manager import create_workspace as wm_create, initialize_from_templates
    try:
        ws = wm_create(name=name, path=path, description=description,
                       team_name=team_name)
    except ValueError as e:
        return bad(handler, str(e))

    # Auto-initialize employees from templates
    init_result = None
    if auto_init:
        try:
            init_result = initialize_from_templates(ws["slug"])
        except Exception as e:
            init_result = {"error": str(e)}

    return j(handler, {"ok": True, "workspace": ws, "template_init": init_result})


def _handle_ws_manager_update(handler, body):
    """POST /api/ws-manager/update — Update workspace metadata."""
    slug = (body.get("slug") or "").strip()
    if not slug:
        return bad(handler, "slug is required")
    from api.workspace_manager import update_workspace as wm_update
    try:
        ws = wm_update(slug, body)
    except ValueError as e:
        return bad(handler, str(e))
    if not ws:
        return bad(handler, "Workspace not found", 404)
    return j(handler, {"ok": True, "workspace": ws})


def _handle_ws_manager_delete(handler, body):
    """POST /api/ws-manager/delete — Delete a workspace and all its data."""
    slug = (body.get("slug") or "").strip()
    if not slug:
        return bad(handler, "slug is required")
    from api.workspace_manager import delete_workspace as wm_delete
    removed = wm_delete(slug)
    if not removed:
        return bad(handler, "Workspace not found", 404)
    return j(handler, {"ok": True, "deleted": slug})


def _handle_ws_manager_init_employees(handler, body):
    """POST /api/ws-manager/init-employees — Initialize employees from templates."""
    slug = (body.get("slug") or "").strip()
    if not slug:
        return bad(handler, "slug is required")
    force = bool(body.get("force", False))
    from api.workspace_manager import initialize_from_templates
    try:
        result = initialize_from_templates(slug, force=force)
    except Exception as e:
        return bad(handler, f"Initialization failed: {e}", 500)
    return j(handler, {"ok": True, **result})


def _handle_ws_manager_connections_save(handler, body):
    """POST /api/ws-manager/connections — Save employee connections."""
    slug = (body.get("slug") or "").strip()
    if not slug:
        return bad(handler, "slug is required")
    connections = body.get("connections", [])
    if not isinstance(connections, list):
        return bad(handler, "connections must be an array")
    from api.workspace_manager import save_connections
    save_connections(slug, connections)
    return j(handler, {"ok": True})


def _handle_ws_manager_export(handler, body):
    """POST /api/ws-manager/export — Export workspace as team package."""
    slug = (body.get("slug") or "").strip()
    if not slug:
        return bad(handler, "slug is required")
    from api.workspace_manager import export_workspace as wm_export
    data = wm_export(slug)
    if not data:
        return bad(handler, "Workspace not found", 404)
    return j(handler, {"ok": True, "data": data})


def _handle_ws_manager_import(handler, body):
    """POST /api/ws-manager/import — Import a team package as workspace."""
    team_data = body.get("data") or body.get("team")
    if not team_data or not isinstance(team_data, dict):
        return bad(handler, "data (team package object) is required")
    name_override = (body.get("name") or "").strip()
    from api.workspace_manager import import_workspace as wm_import
    try:
        result = wm_import(team_data, name_override=name_override)
    except Exception as e:
        return bad(handler, f"Import failed: {e}", 500)
    return j(handler, result)


def _handle_ws_manager_file_save(handler, body):
    """POST /api/ws-manager/file/save — Save a file to workspace subdir."""
    slug = (body.get("slug") or "").strip()
    subdir = (body.get("subdir") or "").strip()
    filename = (body.get("filename") or "").strip()
    content = body.get("content", "")
    if not slug or not subdir or not filename:
        return bad(handler, "slug, subdir, and filename are required")
    from api.workspace_manager import save_file_to_subdir
    try:
        result = save_file_to_subdir(slug, subdir, filename, content)
    except ValueError as e:
        return bad(handler, str(e))
    return j(handler, {"ok": True, **result})


def _handle_ws_manager_file_delete(handler, body):
    """POST /api/ws-manager/file/delete — Delete a file from workspace subdir."""
    slug = (body.get("slug") or "").strip()
    subdir = (body.get("subdir") or "").strip()
    filename = (body.get("filename") or "").strip()
    if not slug or not subdir or not filename:
        return bad(handler, "slug, subdir, and filename are required")
    from api.workspace_manager import delete_file_from_subdir
    removed = delete_file_from_subdir(slug, subdir, filename)
    if not removed:
        return bad(handler, "File not found", 404)
    return j(handler, {"ok": True})



    try:
        require(body, "section", "content")
    except ValueError as e:
        return bad(handler, str(e))
    try:
        from api.profiles import get_active_hermes_home

        mem_dir = get_active_hermes_home() / "memories"
    except ImportError:
        mem_dir = Path.home() / ".hermes" / "memories"
    mem_dir.mkdir(parents=True, exist_ok=True)
    section = body["section"]
    if section == "memory":
        target = mem_dir / "MEMORY.md"
    elif section == "user":
        target = mem_dir / "USER.md"
    else:
        return bad(handler, 'section must be "memory" or "user"')
    target.write_text(body["content"], encoding="utf-8")
    return j(handler, {"ok": True, "section": section, "path": str(target)})


def _handle_session_import_cli(handler, body):
    """Import a single CLI session into the WebUI store."""
    try:
        require(body, "session_id")
    except ValueError as e:
        return bad(handler, str(e))

    sid = str(body["session_id"])

    # Check if already imported — idempotent
    existing = Session.load(sid)
    if existing:
        return j(
            handler,
            {
                "session": existing.compact()
                | {
                    "messages": existing.messages,
                    "is_cli_session": True,
                },
                "imported": False,
            },
        )

    # Fetch messages from CLI store
    msgs = get_cli_session_messages(sid)
    if not msgs:
        return bad(handler, "Session not found in CLI store", 404)

    # Derive title from first user message
    title = title_from(msgs, "CLI Session")
    model = "unknown"

    # Get profile and model from CLI session metadata
    profile = None
    for cs in get_cli_sessions():
        if cs["session_id"] == sid:
            profile = cs.get("profile")
            model = cs.get("model", "unknown")
            break

    s = import_cli_session(sid, title, msgs, model, profile=profile)
    s.is_cli_session = True
    s._cli_origin = sid
    s.save()
    return j(
        handler,
        {
            "session": s.compact()
            | {
                "messages": msgs,
                "is_cli_session": True,
            },
            "imported": True,
        },
    )


def _handle_session_import(handler, body):
    """Import a session from a JSON export. Creates a new session with a new ID."""
    if not body or not isinstance(body, dict):
        return bad(handler, "Request body must be a JSON object")
    messages = body.get("messages")
    if not isinstance(messages, list):
        return bad(handler, 'JSON must contain a "messages" array')
    title = body.get("title", "Imported session")
    workspace = body.get("workspace", str(DEFAULT_WORKSPACE))
    model = body.get("model", DEFAULT_MODEL)
    s = Session(
        title=title,
        workspace=workspace,
        model=model,
        messages=messages,
        tool_calls=body.get("tool_calls", []),
    )
    s.pinned = body.get("pinned", False)
    with LOCK:
        SESSIONS[s.session_id] = s
        SESSIONS.move_to_end(s.session_id)
        while len(SESSIONS) > SESSIONS_MAX:
            SESSIONS.popitem(last=False)
    s.save()
    return j(handler, {"ok": True, "session": s.compact() | {"messages": s.messages}})


# ── Delegation history endpoints ──────────────────────────────────────────────

def _handle_delegation_children(handler, parsed):
    """GET /api/delegation/children?session_id=...

    Returns child sessions (subagent runs) for a given parent session.
    Queries the CLI state.db (hermes_state.py SessionDB) which stores
    parent_session_id links from delegate_task.
    """
    qs = parse_qs(parsed.query)
    parent_sid = qs.get("session_id", [""])[0].strip()
    if not parent_sid:
        return bad(handler, "session_id is required")

    try:
        from api.models import get_cli_session_children
        children = get_cli_session_children(parent_sid)
        return j(handler, {"children": children})
    except Exception as e:
        return j(handler, {"children": [], "error": str(e)})


def _handle_delegation_history(handler, parsed):
    """GET /api/delegation/history?session_id=...

    Returns the full delegation history tree: all descendant sessions
    (children, grandchildren, etc.) with their messages summaries.
    Useful for visualizing the complete delegation chain.
    """
    qs = parse_qs(parsed.query)
    root_sid = qs.get("session_id", [""])[0].strip()
    depth = int(qs.get("depth", ["3"])[0])
    if not root_sid:
        return bad(handler, "session_id is required")

    try:
        from api.models import get_cli_delegation_tree
        tree = get_cli_delegation_tree(root_sid, max_depth=depth)
        return j(handler, {"tree": tree})
    except Exception as e:
        return j(handler, {"tree": None, "error": str(e)})


# ── Employee filesystem endpoints ──────────────────────────────────────────────

def _handle_employees_list(handler, parsed):
    """GET /api/employees?workspace=...

    List all employees for a workspace from the filesystem.
    """
    from api.employee_fs import list_employees
    qs = parse_qs(parsed.query)
    workspace = (qs.get("workspace", [""])[0] or "").strip()
    if not workspace:
        return bad(handler, "workspace query parameter is required")
    try:
        employees = list_employees(workspace)
        from api.employee_fs import get_next_id_value
        next_id = get_next_id_value(workspace)
        return j(handler, {"employees": employees, "next_id": next_id})
    except Exception as e:
        return bad(handler, _sanitize_error(e), 500)


def _handle_employee_get(handler, parsed):
    """GET /api/employee?workspace=...&id=...

    Get a single employee by ID.
    """
    from api.employee_fs import get_employee_by_id
    qs = parse_qs(parsed.query)
    workspace = (qs.get("workspace", [""])[0] or "").strip()
    emp_id = (qs.get("id", [""])[0] or "").strip()
    if not workspace or not emp_id:
        return bad(handler, "workspace and id query parameters are required")
    emp = get_employee_by_id(workspace, emp_id)
    if not emp:
        return bad(handler, "Employee not found", 404)
    return j(handler, {"employee": emp})


def _handle_employee_files(handler, parsed):
    """GET /api/employee/files?workspace=...&id=...&subdir=...

    List files in an employee subdirectory (scripts, output, experience, etc.)
    """
    from api.employee_fs import list_employee_subdir
    qs = parse_qs(parsed.query)
    workspace = (qs.get("workspace", [""])[0] or "").strip()
    emp_id = (qs.get("id", [""])[0] or "").strip()
    subdir = (qs.get("subdir", [""])[0] or "").strip()
    if not workspace or not emp_id or not subdir:
        return bad(handler, "workspace, id, and subdir query parameters are required")
    files = list_employee_subdir(workspace, emp_id, subdir)
    return j(handler, {"files": files})


def _handle_employee_create(handler, body):
    """POST /api/employee/create

    Create a new employee with filesystem directory structure.
    Body: { workspace, name, role, avatar, skills, model, ... }
    If the employee already exists (by name), fall back to update.
    """
    from api.employee_fs import create_employee, update_employee, get_employee_by_id
    workspace = (body.get("workspace") or "").strip()
    if not workspace:
        return bad(handler, "workspace is required")
    try:
        emp = create_employee(workspace, body)
        return j(handler, {"ok": True, "employee": emp})
    except ValueError as e:
        # If employee already exists, try to update instead (race condition with debounced save)
        err_msg = str(e)
        emp_id = (body.get("id") or "").strip()
        if "already exists" in err_msg and emp_id:
            try:
                emp = update_employee(workspace, emp_id, body)
                if emp:
                    return j(handler, {"ok": True, "employee": emp, "fallback": "update"})
            except Exception:
                pass
        return bad(handler, err_msg)
    except Exception as e:
        return bad(handler, _sanitize_error(e), 500)


def _handle_employee_update(handler, body):
    """POST /api/employee/update

    Update an existing employee.
    Body: { workspace, id, ...updates }
    """
    from api.employee_fs import update_employee
    workspace = (body.get("workspace") or "").strip()
    emp_id = (body.get("id") or "").strip()
    if not workspace or not emp_id:
        return bad(handler, "workspace and id are required")
    try:
        emp = update_employee(workspace, emp_id, body)
        if not emp:
            return bad(handler, "Employee not found", 404)
        return j(handler, {"ok": True, "employee": emp})
    except Exception as e:
        return bad(handler, _sanitize_error(e), 500)


def _handle_employee_delete(handler, body):
    """POST /api/employee/delete

    Delete an employee and their directory.
    Body: { workspace, id }
    """
    from api.employee_fs import delete_employee
    workspace = (body.get("workspace") or "").strip()
    emp_id = (body.get("id") or "").strip()
    if not workspace or not emp_id:
        return bad(handler, "workspace and id are required")
    ok = delete_employee(workspace, emp_id)
    if not ok:
        return bad(handler, "Employee not found", 404)
    return j(handler, {"ok": True})


def _handle_employees_save(handler, body):
    """POST /api/employees/save

    Batch save employees (used for migration from localStorage).
    Body: { workspace, employees: [...], next_id: N }
    """
    from api.employee_fs import save_all_employees, set_next_id_value
    workspace = (body.get("workspace") or "").strip()
    if not workspace:
        return bad(handler, "workspace is required")
    employees = body.get("employees", [])
    if not isinstance(employees, list):
        return bad(handler, "employees must be a list")
    try:
        result = save_all_employees(workspace, employees)
        # Sync next_id counter
        next_id = body.get("next_id")
        if next_id and isinstance(next_id, int):
            set_next_id_value(workspace, next_id)
        return j(handler, {"ok": True, **result})
    except Exception as e:
        return bad(handler, _sanitize_error(e), 500)


def _handle_employee_experience(handler, body):
    """POST /api/employee/experience

    Read or write an experience file.
    Body: { workspace, id, filename, content (optional for write), action: 'read'|'write' }
    """
    from api.employee_fs import read_experience_file, write_experience_file, list_experience_files
    workspace = (body.get("workspace") or "").strip()
    emp_id = (body.get("id") or "").strip()
    action = (body.get("action") or "list").strip()

    if not workspace or not emp_id:
        return bad(handler, "workspace and id are required")

    if action == "list":
        files = list_experience_files(workspace, emp_id)
        return j(handler, {"files": files})
    elif action == "read":
        filename = (body.get("filename") or "").strip()
        if not filename:
            return bad(handler, "filename is required for read")
        content = read_experience_file(workspace, emp_id, filename)
        if content is None:
            return bad(handler, "File not found", 404)
        return j(handler, {"filename": filename, "content": content})
    elif action == "write":
        filename = (body.get("filename") or "").strip()
        content = body.get("content", "")
        if not filename:
            return bad(handler, "filename is required for write")
        ok = write_experience_file(workspace, emp_id, filename, content)
        if not ok:
            return bad(handler, "Failed to write file")
        return j(handler, {"ok": True, "filename": filename})
    else:
        return bad(handler, f"Unknown action: {action}")


def _handle_employees_export(handler, body):
    """POST /api/employees/export

    Export employees with all subdirectory files for cross-machine portability.
    Body: { workspace, employee_ids: [...] (optional, omit for all) }
    Returns: { ok: true, data: { version, exportedAt, workspace, employees: [...] } }
    """
    from api.employee_fs import export_employee, export_all_employees
    workspace = (body.get("workspace") or "").strip()
    if not workspace:
        return bad(handler, "workspace is required")
    try:
        emp_ids = body.get("employee_ids")
        if emp_ids and isinstance(emp_ids, list):
            # Export specific employees
            employees = []
            for eid in emp_ids:
                exported = export_employee(workspace, eid)
                if exported:
                    employees.append(exported)
        else:
            # Export all
            employees = export_all_employees(workspace)

        export_data = {
            "version": 2,
            "exportedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
            "workspace": workspace,
            "employees": employees,
        }
        return j(handler, {"ok": True, "data": export_data})
    except Exception as e:
        return bad(handler, _sanitize_error(e), 500)


def _handle_employees_import(handler, body):
    """POST /api/employees/import

    Import employees from export data, restoring all files.
    Body: { workspace, employees: [...], force: false }
    Returns: { ok: true, imported, skipped, errors, id_map }
    """
    from api.employee_fs import import_employees, list_employees
    workspace = (body.get("workspace") or "").strip()
    if not workspace:
        return bad(handler, "workspace is required")
    employees_data = body.get("employees", [])
    if not isinstance(employees_data, list) or not employees_data:
        return bad(handler, "employees list is required and must be non-empty")
    force = bool(body.get("force", False))
    try:
        result = import_employees(workspace, employees_data, force=force)
        # Also return the full updated employee list so frontend can refresh
        updated_list = list_employees(workspace)
        result["ok"] = True
        result["employees"] = updated_list
        return j(handler, result)
    except Exception as e:
        return bad(handler, _sanitize_error(e), 500)


# ── Coordinator (协调员) endpoints (formerly group chat / 总群) ─────────────────

def _handle_group_chat_get(handler, parsed):
    """GET /api/group-chat?workspace=...  (DEPRECATED — now returns PM session data)

    Returns the PM employee's session for a workspace.
    """
    from api.group_chat import get_or_create_group_chat
    qs = parse_qs(parsed.query)
    workspace = qs.get("workspace", [""])[0].strip()
    if not workspace:
        return bad(handler, "workspace is required")

    try:
        data = get_or_create_group_chat(workspace)
        return j(handler, data)
    except Exception as e:
        return bad(handler, _sanitize_error(e), 500)


def _handle_group_chat_send(handler, body):
    """POST /api/group-chat/send  (DEPRECATED — now writes to PM session)

    Send a message to the coordinator (PM) session. Parses @mentions and returns
    the parsed mentions list for the frontend to dispatch tasks.

    Body: {
        workspace: str,
        message: str,
        sender_name: str (optional, defaults to "你")
    }

    Returns: {
        ok: True,
        message: dict,
        mentions: [{name: str, task_id: str}]
    }
    """
    from api.group_chat import get_or_create_group_chat, add_group_message, parse_mentions

    workspace = body.get("workspace", "").strip()
    message = body.get("message", "").strip()
    sender_name = body.get("sender_name", "你").strip()
    orchestrate = bool(body.get("orchestrate", False))

    print(f"[coordinator_send] workspace={workspace}, orchestrate={orchestrate}, message={message[:50]}...", file=sys.stderr, flush=True)

    if not workspace:
        return bad(handler, "workspace is required")
    if not message:
        return bad(handler, "message is required")

    try:
        # ★ Log user message to the unified log panel
        _broadcast_log_event('user_input', {
            'text': message[:500] + ('...' if len(message) > 500 else ''),
            'message': f"[协调员] {sender_name}: {message[:120]}{'...' if len(message) > 120 else ''}",
        }, session_id='', employee_name=sender_name)

        # Parse @mentions from the message
        mentioned_names = parse_mentions(message)
        print(f"[coordinator_send] mentions={mentioned_names}", file=sys.stderr, flush=True)
        mentions_with_tasks = []
        for name in mentioned_names:
            task_id = f"task-{uuid.uuid4().hex[:8]}"
            mentions_with_tasks.append({"name": name, "task_id": task_id})

        # Collect all task_ids for anchor-based jumping
        all_task_ids = [m["task_id"] for m in mentions_with_tasks]

        # Add the message to the group chat
        msg = add_group_message(
            workspace=workspace,
            role="user",
            content=message,
            sender_name=sender_name,
            mentions=mentioned_names if mentioned_names else None,
            task_ids=all_task_ids if all_task_ids else None,
        )

        # If there are mentions, add a system message indicating task dispatch
        if mentions_with_tasks:
            # 每个 mention 生成一行"已将任务 [task-id] 委派给 @Name"
            # task-id 用 {{TASK_LINK:xxx}} 占位符包裹，前端渲染时替换为可点击链接
            lines = [
                f"已将任务 {{{{TASK_LINK:{m['task_id']}}}}} 委派给 @{m['name']}"
                for m in mentions_with_tasks
            ]
            add_group_message(
                workspace=workspace,
                role="system",
                content="\n".join(lines),
                task_ids=all_task_ids,
            )
            # ★ Log delegation events to the unified log panel
            for m in mentions_with_tasks:
                _broadcast_log_event('delegation', {
                    'message': f"委派任务给 @{m['name']}: {message[:120]}{'...' if len(message) > 120 else ''}",
                    'task_id': m['task_id'],
                    'target_employee': m['name'],
                    'source': sender_name,
                }, session_id='', employee_name=sender_name)

        print(f"[coordinator_send] returning ok, mentions_with_tasks={mentions_with_tasks}", file=sys.stderr, flush=True)
        return j(handler, {
            "ok": True,
            "message": msg,
            "mentions": mentions_with_tasks,
        })
    except Exception as e:
        print(f"[coordinator_send] ERROR: {e}", file=sys.stderr, flush=True)
        import traceback; traceback.print_exc(file=sys.stderr)
        return bad(handler, _sanitize_error(e), 500)


def _handle_group_chat_message(handler, body):
    """POST /api/group-chat/message  (DEPRECATED — now writes to PM session)

    Directly add a message to the coordinator (PM) session.
    """
    from api.group_chat import add_group_message

    workspace = body.get("workspace", "").strip()
    message = body.get("message", "").strip()
    sender_name = body.get("sender_name", "").strip()

    if not workspace:
        return bad(handler, "workspace is required")
    if not message:
        return bad(handler, "message is required")

    try:
        msg = add_group_message(
            workspace=workspace,
            role="assistant",
            content=message,
            sender_name=sender_name or None,
        )
        # ★ Log assistant/employee message to the unified log panel
        log_sender = sender_name or '员工'
        _broadcast_log_event('group_message', {
            'text': message[:500] + ('...' if len(message) > 500 else ''),
            'message': f"[协调员] {log_sender}: {message[:120]}{'...' if len(message) > 120 else ''}",
            'sender_name': log_sender,
        }, session_id='', employee_name=log_sender)
        return j(handler, {"ok": True, "message": msg})
    except Exception as e:
        print(f"[coordinator_message] ERROR: {e}", file=sys.stderr, flush=True)
        import traceback; traceback.print_exc(file=sys.stderr)
        return bad(handler, _sanitize_error(e), 500)


def _handle_group_chat_result(handler, body):
    """POST /api/group-chat/result  (DEPRECATED — now writes to PM session)

    Post a task result back to the coordinator (PM) session from an employee.
    """
    from api.group_chat import post_task_result

    workspace = body.get("workspace", "").strip()
    employee_name = body.get("employee_name", "").strip()
    task_id = body.get("task_id", "").strip()
    result = body.get("result", "").strip()
    requester_name = body.get("requester_name", "").strip()
    session_id = body.get("session_id", "").strip()

    if not workspace or not employee_name:
        return bad(handler, "workspace and employee_name are required")

    # ── If session_id is provided, aggregate the full assistant response from
    #    the employee session (covers multi-segment replies split by tool calls)
    if session_id:
        try:
            s = get_session(session_id)
            if s and s.messages:
                aggregated = _aggregate_task_assistant_reply(s.messages, task_id)
                if aggregated:
                    result = aggregated
        except Exception as e:
            import sys
            print(f"[coordinator_result] session aggregation failed: {e}",
                  file=sys.stderr, flush=True)

    if not result:
        return bad(handler, "result is required (and could not be derived from session)")

    try:
        msg = post_task_result(
            workspace=workspace,
            employee_name=employee_name,
            task_id=task_id,
            result=result,
            requester_name=requester_name or None,
        )
        return j(handler, {"ok": True, "message": msg})
    except Exception as e:
        print(f"[coordinator_result] ERROR: {e}", file=sys.stderr, flush=True)
        import traceback; traceback.print_exc(file=sys.stderr)
        return bad(handler, _sanitize_error(e), 500)


# ── PM Heartbeat (心跳调度) endpoint ───────────────────────────────────────────

def _handle_pm_heartbeat_trigger(handler, body):
    """POST /api/pm-heartbeat/trigger

    前端收到 pm_heartbeat 日志事件后调用此端点，
    启动 PM专员 AI 对话，让 PM 分析员工完成情况并决定后续调度。
    现在使用 PM 员工的 session（而非独立的总群 session）。
    """
    from api.group_chat import get_or_create_group_chat

    workspace = (body.get("workspace") or "").strip()
    completions = body.get("completions") or []

    if not workspace:
        return bad(handler, "workspace is required")
    if not completions:
        return bad(handler, "completions list is required")

    try:
        gc_data = get_or_create_group_chat(workspace)
        gc_session_id = gc_data.get("session_id")
        if not gc_session_id:
            # Fallback: try to find any employee session for this workspace
            try:
                from api.employee_fs import list_employees
                employees = list_employees(workspace)
                for emp in employees:
                    sid = emp.get("sessionId") or emp.get("session_id")
                    if sid:
                        gc_session_id = sid
                        break
            except Exception:
                pass
        if not gc_session_id:
            return bad(handler, "Failed to get coordinator session: no PM employee with session found", 500)
    except Exception as e:
        return bad(handler, f"Failed to get coordinator session: {_sanitize_error(e)}", 500)

    # 构建心跳模式的 user message
    # 包含员工完成摘要 + 当前员工状态，让 PM 决定后续调度
    completion_lines = []
    for c in completions:
        emp_name = c.get("employee_name", "未知")
        status = c.get("status", "completed")
        summary = (c.get("summary") or "")[:500]
        emoji = "✅" if status == "completed" else "⚠️"
        completion_lines.append(f"{emoji} **{emp_name}**（{status}）：{summary if summary else '无输出摘要'}")

    # 获取员工状态概览（从前端传递，或使用默认值）
    employee_statuses = body.get("employee_statuses") or []
    status_lines = []
    for es in employee_statuses:
        name = es.get("name", "?")
        status = es.get("status", "unknown")
        status_emoji = {"idle": "🟢", "thinking": "🟡", "working": "🟡", "error": "🔴"}.get(status, "⚪")
        queue_len = es.get("queue_length", 0)
        queue_info = f"（队列中 {queue_len} 个任务）" if queue_len > 0 else ""
        status_lines.append(f"  {status_emoji} {name}: {status}{queue_info}")

    heartbeat_msg = (
        "💓 **心跳调度通知**\n\n"
        "以下员工刚刚完成了任务：\n"
        + "\n".join(completion_lines) + "\n"
    )
    if status_lines:
        heartbeat_msg += (
            "\n**当前团队状态：**\n"
            + "\n".join(status_lines) + "\n"
        )
    heartbeat_msg += (
        "\n请根据以上信息决定下一步行动："
        "\n1. 如果有员工的任务结果需要后续处理，通过 @员工名 委派新任务"
        "\n2. 如果所有工作已完成，简要总结当前进度"
        "\n3. 如果有员工出错，分析原因并决定是否重新委派"
        "\n\n直接回复你的分析和决策。如需委派，在回复中使用 @员工名 格式。"
    )

    # 使用协调员(PM) session 启动 PM专员 AI 对话
    model = body.get("model") or gc_data.get("model") or DEFAULT_MODEL
    s = get_session(gc_session_id)

    stream_id = uuid.uuid4().hex
    q = queue.Queue()
    with STREAMS_LOCK:
        STREAMS[stream_id] = q

    # 不在这里传 system_prompt（前端会动态构建包含心跳模式的 PM 提示词）
    system_prompt = body.get("system_prompt") or ""

    thr = threading.Thread(
        target=_run_agent_streaming,
        args=(gc_session_id, heartbeat_msg, model, workspace, stream_id, None, system_prompt, PM_NAME),
        daemon=True,
    )
    thr.start()

    return j(handler, {"ok": True, "stream_id": stream_id, "session_id": gc_session_id})


def _aggregate_task_assistant_reply(messages: list, task_id: str = "") -> str:
    """Extract the final meaningful assistant reply for a delegated task.

    Strategy (v2 -- final-reply only):
      1) Find the last user message whose content starts with
         "[协调员（PM专员）委派任务 #<task_id>]" (or just "[协调员（PM专员）委派任务" as fallback).
      2) Scan all subsequent assistant messages in order, collecting only the
         ones that contain actual text content (skip empty / tool-only turns).
      3) Return ONLY the LAST non-empty text segment -- this is the final answer.
         Intermediate "thinking aloud" text from earlier iterations is dropped.

    Rationale: Multi-step tool-use agents produce many assistant messages per
    task. The group chat only needs the final answer.

    Returns empty string if no anchor found or no text accumulated.
    """
    import re

    if not messages:
        return ""

    # Find the anchor user message (most recent matching)
    anchor_idx = -1
    if task_id:
        marker = f"[协调员（PM专员）委派任务 #{task_id}]"
        for i in range(len(messages) - 1, -1, -1):
            m = messages[i]
            if not isinstance(m, dict) or m.get("role") != "user":
                continue
            c = m.get("content", "")
            if isinstance(c, str) and c.startswith(marker):
                anchor_idx = i
                break
    # Fallback: most recent user message with the generic prefix
    if anchor_idx < 0:
        for i in range(len(messages) - 1, -1, -1):
            m = messages[i]
            if not isinstance(m, dict) or m.get("role") != "user":
                continue
            c = m.get("content", "")
            if isinstance(c, str) and c.startswith("[协调员（PM专员）委派任务"):
                anchor_idx = i
                break
    if anchor_idx < 0:
        return ""

    # Collect the LAST non-empty assistant text segment after the anchor.
    # This gives us the final answer, discarding intermediate chatter.
    last_text = ""
    for j in range(anchor_idx + 1, len(messages)):
        m = messages[j]
        if not isinstance(m, dict) or m.get("role") != "assistant":
            continue
        content_val = m.get("content")
        text = ""
        if isinstance(content_val, str):
            text = content_val
        elif isinstance(content_val, list):
            text = "\n".join(
                (p.get("text") or "") for p in content_val
                if isinstance(p, dict) and p.get("type") == "text"
            )
        text = (text or "").strip()
        if text:
            last_text = text  # keep overwriting -- last one wins

    if not last_text:
        return ""

    # Strip think blocks (complete and unterminated)
    last_text = re.sub(r"<think[\s\S]*?</think\s*>", "", last_text)
    last_text = re.sub(r"<think[\s\S]*$", "", last_text)
    # Strip Gemma channel thoughts
    last_text = re.sub(r"<\|channel\|thought\n[\s\S]*?<channel\|>\s*", "", last_text)
    last_text = re.sub(r"<\|channel\|thought\n[\s\S]*$", "", last_text)

    return last_text.strip()
