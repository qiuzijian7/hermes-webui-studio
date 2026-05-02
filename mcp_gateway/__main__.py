"""
MCP Gateway 包入口 — 支持 python -m mcp_gateway 启动。
"""
from .server import run_gateway_http, run_gateway_mcp
import sys

if __name__ == "__main__":
    mode = sys.argv[1] if len(sys.argv) > 1 else "both"
    if mode == "http":
        run_gateway_http()
    elif mode == "mcp":
        run_gateway_mcp()
    else:
        import threading
        mcp_thread = threading.Thread(target=run_gateway_mcp, daemon=True)
        mcp_thread.start()
        run_gateway_http()
