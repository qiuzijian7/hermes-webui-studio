"""Simple dev server for hermes-webui-studio static preview."""
import http.server
import os

PORT = 8788
DIRECTORY = os.path.dirname(os.path.abspath(__file__))


class StudioHandler(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=DIRECTORY, **kwargs)

    def do_GET(self):
        # Redirect root to /static/index.html
        if self.path == "/" or self.path == "":
            self.send_response(302)
            self.send_header("Location", "/static/index.html")
            self.end_headers()
            return
        # For /api/* paths, return a stub JSON (no backend)
        if self.path.startswith("/api/"):
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Access-Control-Allow-Origin", "*")
            self.end_headers()
            # Return sensible stubs for common endpoints
            stub = self._api_stub()
            self.wfile.write(stub.encode())
            return
        super().do_GET()

    def _api_stub(self):
        """Return stub JSON for API endpoints so the UI doesn't break."""
        import json
        path = self.path.split("?")[0]
        if "/sessions" in path:
            return json.dumps({"sessions": []})
        if "/crons" in path or "/jobs" in path:
            return json.dumps({"jobs": []})
        if "/skills" in path:
            return json.dumps({"skills": []})
        if "/memory" in path:
            return json.dumps({"memory": "", "sections": {}})
        if "/workspaces" in path:
            return json.dumps({"workspaces": []})
        if "/profiles" in path:
            return json.dumps({"profiles": [], "active": "default"})
        if "/todos" in path:
            return json.dumps({"items": []})
        if "/employees" in path:
            return json.dumps({"employees": []})
        if "/config" in path:
            return json.dumps({"config": {}})
        if "/models" in path:
            return json.dumps({"models": []})
        if "/health" in path:
            return json.dumps({"status": "ok"})
        return json.dumps({})


if __name__ == "__main__":
    with http.server.HTTPServer(("127.0.0.1", PORT), StudioHandler) as httpd:
        print(f"Serving hermes-webui-studio at http://127.0.0.1:{PORT}")
        print(f"  Root directory: {DIRECTORY}")
        print(f"  Open: http://127.0.0.1:{PORT}/static/index.html")
        httpd.serve_forever()
