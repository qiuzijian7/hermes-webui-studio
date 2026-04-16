import sys, time, threading, traceback
sys.path.insert(0, r'g:\CustomWorkspaces\AIProjects\hermes-agent-studio\hermes-webui-studio')

from http.server import ThreadingHTTPServer, BaseHTTPRequestHandler
from api.config import HOST, PORT

class TestHandler(BaseHTTPRequestHandler):
    def do_GET(self):
        try:
            print(f"GET {self.path}", flush=True)
            if self.path == '/' or self.path == '/index.html':
                self.send_response(200)
                self.send_header('Content-Type', 'text/html')
                self.end_headers()
                self.wfile.write(b'Hello World')
            else:
                self.send_response(404)
                self.end_headers()
        except Exception as e:
            traceback.print_exc()

httpd = ThreadingHTTPServer((HOST, PORT), TestHandler)
print(f"Test server on {HOST}:{PORT}", flush=True)

t = threading.Thread(target=httpd.serve_forever, daemon=True)
t.start()
time.sleep(1)

import urllib.request
try:
    resp = urllib.request.urlopen(f"http://127.0.0.1:8787/")
    print(f"Response: {resp.status} - {resp.read()[:100]}", flush=True)
except Exception as e:
    print(f"Connection failed: {e}", flush=True)

httpd.shutdown()
print("Done", flush=True)
