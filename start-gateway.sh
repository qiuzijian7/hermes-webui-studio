#!/bin/bash
# ============================================================================
#  Hermes MCP Gateway -- 启动脚本 (Linux/macOS)
#
#  部署在 DevCloud 或公网可达的服务器上，作为 Knot 与多个 WebUI 实例的桥梁。
#
#  环境变量（在同目录 .env.gateway 中设置或 export）：
#    HERMES_GATEWAY_PORT    -- 监听端口（默认 8080）
#    HERMES_GATEWAY_HOST    -- 监听地址（默认 0.0.0.0）
#    HERMES_GATEWAY_DATA    -- 数据目录（默认 ./gateway-data）
#    HERMES_GATEWAY_TOKEN   -- API 鉴权 Token（推荐设置）
# ============================================================================

set -e
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

# 加载 .env.gateway
if [ -f "$SCRIPT_DIR/.env.gateway" ]; then
    export $(grep -v '^#' "$SCRIPT_DIR/.env.gateway" | xargs)
fi

# 默认值
export HERMES_GATEWAY_DATA="${HERMES_GATEWAY_DATA:-$SCRIPT_DIR/gateway-data}"
export HERMES_GATEWAY_PORT="${HERMES_GATEWAY_PORT:-8080}"

# 确保数据目录存在
mkdir -p "$HERMES_GATEWAY_DATA"

echo "============================================================"
echo "  Hermes MCP Gateway"
echo "  Port: $HERMES_GATEWAY_PORT"
echo "  Data: $HERMES_GATEWAY_DATA"
echo "============================================================"
echo

# 启动
exec python -m mcp_gateway "$@"
