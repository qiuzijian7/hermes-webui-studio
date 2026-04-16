import os, sys, subprocess
os.environ['HERMES_WEBUI_PORT'] = '18080'
os.chdir(r'g:\CustomWorkspaces\AIProjects\hermes-agent-studio\hermes-webui-studio')
result = subprocess.run([sys.executable, 'server.py'], capture_output=True, text=True, timeout=10)
print("STDOUT:", result.stdout[:2000])
print("STDERR:", result.stderr[:2000])
print("Return code:", result.returncode)
