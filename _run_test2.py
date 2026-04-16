import os, sys, subprocess, traceback
os.environ['HERMES_WEBUI_PORT'] = '18080'
os.chdir(r'g:\CustomWorkspaces\AIProjects\hermes-agent-studio\hermes-webui-studio')
try:
    result = subprocess.run(
        [sys.executable, 'server.py'],
        capture_output=True, text=True, timeout=10,
        env={**os.environ, 'HERMES_WEBUI_PORT': '18080'}
    )
    print("STDOUT:", result.stdout[:3000])
    print("STDERR:", result.stderr[:3000])
    print("RC:", result.returncode)
except subprocess.TimeoutExpired as e:
    print("TIMEOUT (server still running, that's good!)")
    print("STDOUT so far:", (e.stdout or b'').decode('utf-8', errors='replace')[:2000] if e.stdout else '')
    print("STDERR so far:", (e.stderr or b'').decode('utf-8', errors='replace')[:2000] if e.stderr else '')
except Exception as e:
    traceback.print_exc()
