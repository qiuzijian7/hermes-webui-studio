import sys, traceback
sys.path.insert(0, r'g:\CustomWorkspaces\AIProjects\hermes-agent-studio\hermes-webui-studio')
try:
    from api.config import HOST, PORT
    print(f"HOST={HOST}, PORT={PORT}")
    from api.routes import handle_get, handle_post
    print("routes OK")
    from api.auth import check_auth
    print("auth OK")
    print("All imports OK")
except Exception as e:
    traceback.print_exc()
