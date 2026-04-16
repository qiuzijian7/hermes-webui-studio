import time, urllib.request
for i in range(10):
    time.sleep(1)
    try:
        resp = urllib.request.urlopen("http://127.0.0.1:18080/", timeout=3)
        print(f"OK: status={resp.status}")
        break
    except Exception as e:
        print(f"Attempt {i+1}: FAIL - {e}")
