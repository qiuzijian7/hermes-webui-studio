"""
Hermes Web UI -- Host Helper Service

A lightweight HTTP service that runs on the **host machine** alongside the
WebUI container.  It provides endpoints that the browser cannot reach from
inside Docker, such as opening a directory in the native file explorer.

Endpoints
---------
GET /open?path=<host-path>   — Open a file/directory in the system file manager
GET /health                  — Health check

Usage
-----
  python host_helper.py                # listen on 127.0.0.1:18791
  python host_helper.py 8791           # custom port
  python host_helper.py 8791 0.0.0.0   # custom host + port

Security: Only listens on 127.0.0.1 by default.
The path parameter is validated — only absolute local paths are accepted.
"""

import subprocess
import platform
import shutil
import sys
import os
import urllib.parse
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

DEFAULT_HOST = "127.0.0.1"
DEFAULT_PORT = 18791


class HostHelperHandler(BaseHTTPRequestHandler):
    timeout = 10
    server_version = "HermesHostHelper/1.0"

    def log_message(self, fmt, *args):
        import time
        ts = time.strftime('%H:%M:%S')
        msg = fmt % args
        print(f"[host-helper] {ts} {msg}", flush=True)

    # ── CORS headers (required for browser fetch from WebUI) ──
    def _cors_headers(self):
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        # Private Network Access headers (Chrome 104+)
        self.send_header("Access-Control-Allow-Private-Network", "true")

    def _json_response(self, code, obj):
        import json
        body = json.dumps(obj, ensure_ascii=False).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self._cors_headers()
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_OPTIONS(self):
        self.send_response(204)
        self._cors_headers()
        self.send_header("Content-Length", "0")
        self.end_headers()

    def do_GET(self):
        parsed = urllib.parse.urlparse(self.path)

        if parsed.path == "/health":
            self._json_response(200, {"ok": True, "platform": platform.system()})
            return

        if parsed.path == "/open":
            qs = urllib.parse.parse_qs(parsed.query)
            path_list = qs.get("path", [])
            if not path_list:
                self._json_response(400, {"error": "Missing 'path' query parameter"})
                return

            raw_path = path_list[0]
            # Normalize: forward slashes → backslashes on Windows
            if platform.system() == "Windows":
                raw_path = raw_path.replace("/", "\\")

            # Security: only accept absolute paths
            if not os.path.isabs(raw_path):
                self._json_response(400, {"error": "Only absolute paths are allowed"})
                return

            # Check existence
            if not os.path.exists(raw_path):
                self._json_response(404, {"error": f"Path not found: {raw_path}"})
                return

            try:
                _open_in_explorer(raw_path)
                self._json_response(200, {"ok": True, "path": raw_path})
            except Exception as e:
                self._json_response(500, {"error": str(e)})
            return

        self._json_response(404, {"error": "Unknown endpoint"})


def _open_in_explorer(path: str) -> None:
    """Open a file or directory in the system file manager."""
    system = platform.system()

    if system == "Windows":
        if os.path.isfile(path):
            subprocess.Popen(
                ["explorer", "/select,", path],
                creationflags=0x08000000,  # CREATE_NO_WINDOW
            )
        else:
            subprocess.Popen(
                ["explorer", path],
                creationflags=0x08000000,
            )
    elif system == "Darwin":
        subprocess.Popen(["open", "-R", path])
    else:
        # Linux
        dir_to_open = str(os.path.dirname(path)) if os.path.isfile(path) else path
        openers = ["xdg-open", "nautilus", "dolphin", "thunar", "pcmanfm"]
        opener = None
        for cmd in openers:
            if shutil.which(cmd):
                opener = cmd
                break
        if opener:
            args = [opener, dir_to_open]
            if opener == "nautilus" and os.path.isfile(path):
                args = ["nautilus", "--select", path]
            subprocess.Popen(args, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        else:
            raise RuntimeError("No file manager found")


def main():
    host = DEFAULT_HOST
    port = DEFAULT_PORT

    if len(sys.argv) >= 2:
        try:
            port = int(sys.argv[1])
        except ValueError:
            print(f"Invalid port: {sys.argv[1]}")
            sys.exit(1)
    if len(sys.argv) >= 3:
        host = sys.argv[2]

    print(f"[host-helper] Hermes Host Helper starting on http://{host}:{port}")
    print(f"[host-helper] Platform: {platform.system()}")
    print(f"[host-helper] Endpoints: /open?path=..., /health")

    httpd = ThreadingHTTPServer((host, port), HostHelperHandler)
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print("\n[host-helper] Shutting down.")
        httpd.shutdown()


if __name__ == "__main__":
    main()
