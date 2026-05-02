"""
MCP Gateway 包入口 — 支持 python -m mcp_gateway 启动。

单端口模式：HTTP API + MCP 协议统一在同一端口 (默认 8080)。
MCP 端点挂载在 /mcp 路径下。
"""
from .server import run_gateway

if __name__ == "__main__":
    run_gateway()
