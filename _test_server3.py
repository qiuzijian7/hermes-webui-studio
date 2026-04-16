import sys, time, threading, traceback, socket

# Test basic socket
s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
try:
    s.bind(('127.0.0.1', 8787))
    s.listen(1)
    print("Socket bind OK on 8787", flush=True)
    s.close()
except Exception as e:
    print(f"Socket bind FAILED on 8787: {e}", flush=True)
    s.close()

# Try port 9999
from http.server import ThreadingHTTPServer, BaseHTTPRequestHandler

class TestHandler(BaseHTTPRequestHandler):
    def do_GET(self):
        self.send_response(200)
        self.send_header('Content-Type', 'text/html')
        self.end_headers()
        self.wfile.write(b'Hello from 9999')
    
    def log_message(self, format, *args):
        print(f"Request: {args}", flush=True)

try:
    httpd = ThreadingHTTPServer(('127.0.0.1', 9999), TestHandler)
    print("Server on 127.0.0.1:9999", flush=True)
    t = threading.Thread(target=httpd.serve_forever, daemon=True)
    t.start()
    time.sleep(1)
    
    import urllib.request
    resp = urllib.request.urlopen("http://127.0.0.1:9999/")
    print(f"Response: {resp.status} - {resp.read()[:100]}", flush=True)
    httpd.shutdown()
except Exception as e:
    traceback.print_exc()

print("Done", flush=True)
