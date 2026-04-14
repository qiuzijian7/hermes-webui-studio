"""Simple dev server for hermes-webui-studio static preview.

Supports GET + POST + OPTIONS for /api/* with mock responses so the
front-end can boot without a real Hermes backend.
"""
import http.server
import json
import os
import uuid
import time

PORT = 8788
DIRECTORY = os.path.dirname(os.path.abspath(__file__))

# ── In-memory mock state ──────────────────────────────────────────────────────
_sessions = {}  # session_id -> session dict
_settings = {
    "send_key": "enter",
    "show_token_usage": False,
    "show_cli_sessions": False,
    "sound_enabled": False,
    "notifications_enabled": False,
    "bot_name": "Hermes",
    "theme": "dark",
    "language": "en",
    "check_for_updates": False,
}


def _new_session(model="", workspace=None):
    sid = str(uuid.uuid4())[:12]
    session = {
        "session_id": sid,
        "model": model or "anthropic/claude-sonnet-4-20250514",
        "workspace": workspace or ".",
        "title": "New Session",
        "messages": [],
        "pinned": False,
        "archived": False,
        "created_at": time.time(),
        "updated_at": time.time(),
    }
    _sessions[sid] = session
    return session


class StudioHandler(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=DIRECTORY, **kwargs)

    def end_headers(self):
        # Disable caching for all responses during development
        self.send_header("Cache-Control", "no-cache, no-store, must-revalidate")
        self.send_header("Pragma", "no-cache")
        self.send_header("Expires", "0")
        super().end_headers()

    # ── Helpers ────────────────────────────────────────────────────────────────

    def _send_json(self, data, status=200):
        body = json.dumps(data).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _read_body(self):
        length = int(self.headers.get("Content-Length", 0))
        if length == 0:
            return {}
        raw = self.rfile.read(length)
        try:
            return json.loads(raw)
        except Exception:
            return {}

    # ── CORS preflight ─────────────────────────────────────────────────────────

    def do_OPTIONS(self):
        self.send_response(204)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.send_header("Content-Length", "0")
        self.end_headers()

    # ── GET ─────────────────────────────────────────────────────────────────────

    def do_GET(self):
        if self.path == "/" or self.path == "":
            self.send_response(302)
            self.send_header("Location", "/static/index.html")
            self.end_headers()
            return

        if self.path.startswith("/api/"):
            return self._handle_api_get()

        super().do_GET()

    # ── POST ────────────────────────────────────────────────────────────────────

    def do_POST(self):
        if self.path.startswith("/api/"):
            return self._handle_api_post()
        self.send_error(404, "Not Found")

    # ── API routing ─────────────────────────────────────────────────────────────

    def _route(self):
        return self.path.split("?")[0]

    def _handle_api_get(self):
        route = self._route()

        if route == "/api/sessions":
            sessions = sorted(_sessions.values(), key=lambda s: s["updated_at"], reverse=True)
            return self._send_json({"sessions": sessions})

        if route == "/api/settings":
            return self._send_json(_settings)

        if route == "/api/profile/active":
            return self._send_json({"name": "default"})

        if route == "/api/profiles":
            return self._send_json({"profiles": [{"name": "default"}], "active": "default"})

        if route == "/api/skills":
            return self._send_json({"skills": []})

        if route == "/api/memory":
            return self._send_json({"memory": "", "sections": {}, "user": ""})

        if route == "/api/workspaces":
            return self._send_json({"workspaces": [{"path": ".", "name": "Default"}]})

        if route == "/api/crons":
            return self._send_json({"jobs": []})

        if route == "/api/models":
            return self._send_json({"models": [
                "anthropic/claude-sonnet-4-20250514",
                "anthropic/claude-opus-4-20250514",
                "openai/gpt-4o",
            ]})

        if route == "/api/health":
            return self._send_json({"status": "ok"})

        if route == "/api/list":
            # Mock file listing
            return self._send_json({"entries": [
                {"name": "src", "type": "dir", "path": "src"},
                {"name": "README.md", "type": "file", "path": "README.md"},
                {"name": "package.json", "type": "file", "path": "package.json"},
                {"name": "config.yaml", "type": "file", "path": "config.yaml"},
            ]})

        if route == "/api/git-info":
            return self._send_json({"git": {"is_git": False}})

        if route == "/api/projects":
            return self._send_json({"projects": []})

        if route == "/api/todos":
            return self._send_json({"items": []})

        if route == "/api/employees":
            return self._send_json({"employees": []})

        if route == "/api/config":
            return self._send_json({"config": {}})

        if route == "/api/personalities":
            return self._send_json({"personalities": []})

        if "/onboarding" in route:
            return self._send_json({"complete": True, "step": "done"})

        if "/approval/pending" in route:
            return self._send_json({"pending": []})

        # ── File operations ─────────────────────────────────────────────────
        if "/file/" in route:
            return self._send_json({"ok": True})

        # Fallback
        return self._send_json({})

    def _handle_api_post(self):
        route = self._route()
        body = self._read_body()

        # ── Session operations ──────────────────────────────────────────────
        if route == "/api/session/new":
            session = _new_session(
                model=body.get("model", ""),
                workspace=body.get("workspace"),
            )
            return self._send_json({"session": session})

        if route == "/api/session/update":
            sid = body.get("session_id", "")
            if sid in _sessions:
                if "workspace" in body:
                    _sessions[sid]["workspace"] = body["workspace"]
                if "model" in body:
                    _sessions[sid]["model"] = body["model"]
                _sessions[sid]["updated_at"] = time.time()
                return self._send_json({"ok": True, "session": _sessions[sid]})
            return self._send_json({"ok": True})

        if route == "/api/session/rename":
            sid = body.get("session_id", "")
            if sid in _sessions:
                _sessions[sid]["title"] = body.get("title", _sessions[sid]["title"])
                _sessions[sid]["updated_at"] = time.time()
            return self._send_json({"ok": True})

        if route == "/api/session/delete":
            sid = body.get("session_id", "")
            _sessions.pop(sid, None)
            return self._send_json({"ok": True})

        if route == "/api/session/clear":
            sid = body.get("session_id", "")
            if sid in _sessions:
                _sessions[sid]["messages"] = []
                _sessions[sid]["updated_at"] = time.time()
                return self._send_json({"session": _sessions[sid]})
            return self._send_json({"session": {"messages": []}})

        if route == "/api/session/pin":
            sid = body.get("session_id", "")
            if sid in _sessions:
                _sessions[sid]["pinned"] = body.get("pinned", False)
            return self._send_json({"ok": True})

        if route == "/api/session/archive":
            sid = body.get("session_id", "")
            if sid in _sessions:
                _sessions[sid]["archived"] = body.get("archived", False)
            return self._send_json({"ok": True})

        if route == "/api/session/truncate":
            return self._send_json({"ok": True})

        if route == "/api/session/move":
            return self._send_json({"ok": True})

        if route == "/api/session/import":
            session = _new_session()
            return self._send_json({"ok": True, "session": session})

        if route == "/api/session/import_cli":
            return self._send_json({"ok": True})

        # ── Chat ────────────────────────────────────────────────────────────
        if route == "/api/chat/start":
            return self._send_json({
                "ok": True,
                "response": "This is a mock response from the dev server. "
                            "Connect to a real Hermes backend for actual AI responses.",
                "done": True,
            })

        # ── Settings ────────────────────────────────────────────────────────
        if route == "/api/settings":
            _settings.update(body)
            return self._send_json({"ok": True})

        # ── Profiles ────────────────────────────────────────────────────────
        if route == "/api/profile/switch":
            return self._send_json({
                "ok": True, "name": body.get("name", "default"),
                "default_workspace": ".",
            })

        if route == "/api/profile/create":
            return self._send_json({"ok": True})

        if route == "/api/profile/delete":
            return self._send_json({"ok": True})

        if route == "/api/personality/set":
            return self._send_json({"ok": True})

        # ── Skills ──────────────────────────────────────────────────────────
        if route in ("/api/skills/save", "/api/skill/save"):
            return self._send_json({"ok": True})

        # ── Memory ──────────────────────────────────────────────────────────
        if route == "/api/memory/write":
            return self._send_json({"ok": True})

        # ── Workspaces ──────────────────────────────────────────────────────
        if route == "/api/workspaces/add":
            return self._send_json({"ok": True, "workspaces": [{"path": body.get("path", "."), "name": "Added"}]})

        if route == "/api/workspaces/remove":
            return self._send_json({"ok": True})

        # ── Crons ───────────────────────────────────────────────────────────
        if route == "/api/crons/create":
            return self._send_json({"ok": True, "job": {"job_id": str(uuid.uuid4())[:8]}})

        if route in ("/api/crons/run", "/api/crons/pause", "/api/crons/resume",
                      "/api/crons/update", "/api/crons/delete"):
            return self._send_json({"ok": True})

        # ── Onboarding ──────────────────────────────────────────────────────
        if "/onboarding" in route:
            return self._send_json({"ok": True, "complete": True})

        # ── Approval ────────────────────────────────────────────────────────
        if "/approval" in route:
            return self._send_json({"ok": True})

        # ── Projects ────────────────────────────────────────────────────────
        if route == "/api/project/create":
            pid = str(uuid.uuid4())[:8]
            return self._send_json({"ok": True, "project": {"project_id": pid, "name": body.get("name", "New Project")}})

        # ── File operations ─────────────────────────────────────────────────
        if "/file/" in route:
            return self._send_json({"ok": True})

        # ── Fallback ────────────────────────────────────────────────────────
        return self._send_json({"ok": True})

    def log_message(self, format, *args):
        """Quieter logging — only show errors and API calls."""
        msg = format % args
        if "404" in msg or "/api/" in msg:
            super().log_message(format, *args)


if __name__ == "__main__":
    with http.server.HTTPServer(("127.0.0.1", PORT), StudioHandler) as httpd:
        print(f"Serving hermes-webui-studio at http://127.0.0.1:{PORT}")
        print(f"  Root directory: {DIRECTORY}")
        print(f"  Open: http://127.0.0.1:{PORT}/static/index.html")
        print("  Mock API enabled — POST requests return stub data")
        httpd.serve_forever()
