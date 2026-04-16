import os, sys
os.environ['HERMES_WEBUI_PORT'] = '18080'
sys.path.insert(0, r'g:\CustomWorkspaces\AIProjects\hermes-agent-studio\hermes-webui-studio')
os.chdir(r'g:\CustomWorkspaces\AIProjects\hermes-agent-studio\hermes-webui-studio')

try:
    from server import main
    main()
except Exception as e:
    import traceback
    traceback.print_exc()
