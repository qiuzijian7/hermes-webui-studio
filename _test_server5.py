import sys, time, threading, traceback
sys.path.insert(0, r'g:\CustomWorkspaces\AIProjects\hermes-agent-studio\hermes-webui-studio')

from http.server import ThreadingHTTPServer
from server import Handler
from api.config import HOST, PORT

print(f"Starting on {HOST}:{PORT}", flush=True)
httpd = ThreadingHTTPServer((HOST, PORT), Handler)
print(f"Server on {HOST}:{PORT} with real Handler", flush=True)

t = threading.Thread(target=httpd.serve_forever, daemon=True)
t.start()
time.sleep(2)

import urllib.request
try:
    resp = urllib.request.urlopen(f"http://127.0.0.1:{PORT}/", timeout=5)
    print(f"Response: {resp.status} - {resp.read()[:200]}", flush=True)
except Exception as e:
    print(f"Connection failed: {e}", flush=True)
    traceback.print_exc()

httpd.shutdown()
print("Done", flush=True)
