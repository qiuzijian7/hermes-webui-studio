"""Simple dev server for hermes-webui-studio static preview.

Supports GET + POST + OPTIONS for /api/* with mock responses so the
front-end can boot without a real Hermes backend.
"""
import http.server
import json
import os
import uuid
import time
from urllib.parse import urlparse, parse_qs

PORT = 8788
DIRECTORY = os.path.dirname(os.path.abspath(__file__))

# ── In-memory mock state ──────────────────────────────────────────────────────
_sessions = {}  # session_id -> session dict
_workspaces = [{"path": ".", "name": "Default"}]  # workspace list (persisted in memory)
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
        print(f"[dev_server] _handle_api_get route={route!r} full_path={self.path!r}")

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
            return self._send_json({"workspaces": _workspaces})

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
            # Mock file listing – return different entries based on path
            parsed = urlparse(self.path)
            req_path = parse_qs(parsed.query).get("path", ["."])[0]
            _mock_fs = {
                ".": [
                    {"name": "src", "type": "dir", "path": "src"},
                    {"name": "README.md", "type": "file", "path": "README.md"},
                    {"name": "package.json", "type": "file", "path": "package.json"},
                    {"name": "config.yaml", "type": "file", "path": "config.yaml"},
                ],
                "src": [
                    {"name": "components", "type": "dir", "path": "src/components"},
                    {"name": "utils", "type": "dir", "path": "src/utils"},
                    {"name": "index.js", "type": "file", "path": "src/index.js"},
                    {"name": "app.js", "type": "file", "path": "src/app.js"},
                    {"name": "styles.css", "type": "file", "path": "src/styles.css"},
                ],
                "src/components": [
                    {"name": "Header.jsx", "type": "file", "path": "src/components/Header.jsx"},
                    {"name": "Footer.jsx", "type": "file", "path": "src/components/Footer.jsx"},
                    {"name": "Button.jsx", "type": "file", "path": "src/components/Button.jsx"},
                ],
                "src/utils": [
                    {"name": "helpers.js", "type": "file", "path": "src/utils/helpers.js"},
                    {"name": "api.js", "type": "file", "path": "src/utils/api.js"},
                ],
            }
            entries = _mock_fs.get(req_path, [])
            return self._send_json({"entries": entries})

        if route == "/api/session":
            parsed = urlparse(self.path)
            sid = parse_qs(parsed.query).get("session_id", [""])[0]
            if sid in _sessions:
                return self._send_json({"session": _sessions[sid]})
            return self._send_json({"session": None}, status=404)

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
        if route == "/api/file":
            print(f"[dev_server] HIT /api/file route! path={self.path}")
            parsed = urlparse(self.path)
            qs = parse_qs(parsed.query)
            file_path = qs.get("path", [""])[0]
            print(f"[dev_server] file_path={file_path!r}")
            # Mock file contents based on path
            _mock_files = {
                "README.md": "# My Project\n\nWelcome to the project!\n\n## Getting Started\n\n```bash\nnpm install\nnpm run dev\n```\n\n## Features\n\n- 🚀 Fast and lightweight\n- 🎨 Beautiful UI\n- 📦 Modular architecture\n",
                "package.json": '{\n  "name": "my-project",\n  "version": "1.0.0",\n  "description": "A sample project",\n  "main": "src/index.js",\n  "scripts": {\n    "dev": "vite",\n    "build": "vite build",\n    "preview": "vite preview"\n  },\n  "dependencies": {\n    "react": "^18.2.0",\n    "react-dom": "^18.2.0"\n  },\n  "devDependencies": {\n    "vite": "^5.0.0"\n  }\n}',
                "config.yaml": "# Project Configuration\n\napp:\n  name: My Project\n  version: 1.0.0\n  port: 3000\n\ndatabase:\n  host: localhost\n  port: 5432\n  name: mydb\n\nlogging:\n  level: info\n  format: json\n",
                "src/index.js": 'import React from "react";\nimport ReactDOM from "react-dom/client";\nimport App from "./app";\nimport "./styles.css";\n\nconst root = ReactDOM.createRoot(document.getElementById("root"));\nroot.render(\n  <React.StrictMode>\n    <App />\n  </React.StrictMode>\n);\n',
                "src/app.js": 'import React, { useState } from "react";\nimport Header from "./components/Header";\nimport Footer from "./components/Footer";\n\nexport default function App() {\n  const [count, setCount] = useState(0);\n\n  return (\n    <div className="app">\n      <Header />\n      <main>\n        <h1>Hello World</h1>\n        <p>Count: {count}</p>\n        <button onClick={() => setCount(c => c + 1)}>+1</button>\n      </main>\n      <Footer />\n    </div>\n  );\n}\n',
                "src/styles.css": "/* Global Styles */\n\n:root {\n  --primary: #646cff;\n  --bg: #242424;\n  --text: rgba(255, 255, 255, 0.87);\n}\n\nbody {\n  margin: 0;\n  font-family: Inter, system-ui, sans-serif;\n  background: var(--bg);\n  color: var(--text);\n}\n\n.app {\n  max-width: 1280px;\n  margin: 0 auto;\n  padding: 2rem;\n  text-align: center;\n}\n\nbutton {\n  border-radius: 8px;\n  border: 1px solid transparent;\n  padding: 0.6em 1.2em;\n  font-size: 1em;\n  font-weight: 500;\n  background-color: var(--primary);\n  color: white;\n  cursor: pointer;\n  transition: background-color 0.25s;\n}\n\nbutton:hover {\n  background-color: #535bf2;\n}\n",
                "src/components/Header.jsx": 'import React from "react";\n\nexport default function Header() {\n  return (\n    <header style={{ padding: "1rem 0", borderBottom: "1px solid #333" }}>\n      <nav>\n        <h2 style={{ margin: 0 }}>🚀 My Project</h2>\n      </nav>\n    </header>\n  );\n}\n',
                "src/components/Footer.jsx": 'import React from "react";\n\nexport default function Footer() {\n  return (\n    <footer style={{ padding: "1rem 0", borderTop: "1px solid #333", marginTop: "2rem" }}>\n      <p style={{ color: "#888", fontSize: "0.9rem" }}>\n        &copy; 2026 My Project. All rights reserved.\n      </p>\n    </footer>\n  );\n}\n',
                "src/components/Button.jsx": 'import React from "react";\n\nexport default function Button({ children, onClick, variant = "primary" }) {\n  const styles = {\n    primary: { background: "var(--primary)", color: "white" },\n    secondary: { background: "transparent", color: "var(--primary)", border: "1px solid var(--primary)" },\n  };\n\n  return (\n    <button style={styles[variant]} onClick={onClick}>\n      {children}\n    </button>\n  );\n}\n',
                "src/utils/helpers.js": '/**\n * Utility helper functions\n */\n\nexport function formatDate(date) {\n  return new Intl.DateTimeFormat("en-US", {\n    year: "numeric",\n    month: "long",\n    day: "numeric",\n  }).format(date);\n}\n\nexport function debounce(fn, ms = 300) {\n  let timer;\n  return (...args) => {\n    clearTimeout(timer);\n    timer = setTimeout(() => fn.apply(this, args), ms);\n  };\n}\n\nexport function classNames(...classes) {\n  return classes.filter(Boolean).join(" ");\n}\n',
                "src/utils/api.js": '/**\n * API client utilities\n */\n\nconst BASE_URL = "/api";\n\nexport async function fetchJSON(endpoint, options = {}) {\n  const res = await fetch(`${BASE_URL}${endpoint}`, {\n    headers: { "Content-Type": "application/json" },\n    ...options,\n  });\n\n  if (!res.ok) {\n    throw new Error(`API error: ${res.status} ${res.statusText}`);\n  }\n\n  return res.json();\n}\n\nexport const api = {\n  get: (endpoint) => fetchJSON(endpoint),\n  post: (endpoint, data) =>\n    fetchJSON(endpoint, { method: "POST", body: JSON.stringify(data) }),\n};\n',
            }
            content = _mock_files.get(file_path, f"// File: {file_path}\\n// (mock content)")
            return self._send_json({"content": content, "binary": False})

        if route == "/api/file/raw":
            # Raw file — for images, return empty placeholder
            self.send_response(200)
            self.send_header("Content-Type", "application/octet-stream")
            self.send_header("Content-Length", "0")
            self.end_headers()
            return

        if "/file/" in route:
            return self._send_json({"ok": True})

        # Fallback
        print(f"[dev_server] FALLBACK! route={route!r} path={self.path!r}")
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
            ws_path = body.get("path", ".")
            ws_name = body.get("name", "") or os.path.basename(ws_path) or ws_path
            # Check if already exists
            if any(w["path"] == ws_path for w in _workspaces):
                return self._send_json({"ok": True, "workspaces": _workspaces})
            _workspaces.append({"path": ws_path, "name": ws_name})
            return self._send_json({"ok": True, "workspaces": _workspaces})

        if route == "/api/workspaces/remove":
            rm_path = body.get("path", "")
            _workspaces[:] = [w for w in _workspaces if w["path"] != rm_path]
            return self._send_json({"ok": True, "workspaces": _workspaces})

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
