import sys, time, threading, traceback, socket
sys.path.insert(0, r'g:\CustomWorkspaces\AIProjects\hermes-agent-studio\hermes-webui-studio')
os = __import__('os')

# Use port 18080 (outside Windows dynamic port range 1024-14999)
os.environ['HERMES_WEBUI_PORT'] = '18080'

from http.server import ThreadingHTTPServer
from server import Handler
from api.config import HOST

print(f"Starting on {HOST}:18080", flush=True)
httpd = ThreadingHTTPServer((HOST, 18080), Handler)
print(f"Server ready on http://127.0.0.1:18080", flush=True)

t = threading.Thread(target=httpd.serve_forever, daemon=True)
t.start()
time.sleep(2)

import urllib.request
try:
    resp = urllib.request.urlopen("http://127.0.0.1:18080/", timeout=5)
    print(f"Test OK: {resp.status}", flush=True)
except Exception as e:
    print(f"Test FAILED: {e}", flush=True)

# Keep running for user to access
print("\nServer is running. Press Ctrl+C to stop.", flush=True)
try:
    while True:
        time.sleep(1)
except KeyboardInterrupt:
    httpd.shutdown()
