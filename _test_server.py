import sys, time, threading, traceback
sys.path.insert(0, r'g:\CustomWorkspaces\AIProjects\hermes-agent-studio\hermes-webui-studio')

def run_server():
    try:
        from http.server import ThreadingHTTPServer
        from api.config import HOST, PORT
        from server import Handler
        
        httpd = ThreadingHTTPServer((HOST, PORT), Handler)
        print(f"Server started on {HOST}:{PORT}", flush=True)
        httpd.serve_forever()
    except Exception as e:
        traceback.print_exc()

t = threading.Thread(target=run_server, daemon=True)
t.start()
time.sleep(3)

# Test connection
import urllib.request
try:
    resp = urllib.request.urlopen(f"http://127.0.0.1:8787/")
    print(f"Response: {resp.status}", flush=True)
except Exception as e:
    print(f"Connection test failed: {e}", flush=True)

print("Done", flush=True)
