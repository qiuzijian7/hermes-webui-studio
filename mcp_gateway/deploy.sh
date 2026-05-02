#!/bin/bash
# ============================================================================
#  Hermes MCP Gateway — CVM 部署脚本（非 Docker 方式）
#
#  直接在 CVM 上运行，无需 Docker。
#  前提：Python 3.10+ 已安装
# ============================================================================

set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRIPT_DIR"

echo "============================================================"
echo "  Hermes MCP Gateway — 部署"
echo "============================================================"
echo

# 1. 创建虚拟环境
if [ ! -d "venv" ]; then
    echo "[1/4] 创建 Python 虚拟环境..."
    python3 -m venv venv
else
    echo "[1/4] 虚拟环境已存在"
fi

# 2. 安装依赖
echo "[2/4] 安装依赖..."
./venv/bin/pip install --upgrade pip -q
./venv/bin/pip install -r requirements.txt -q

# 3. 加载环境配置
if [ -f ".env.gateway" ]; then
    echo "[3/4] 加载 .env.gateway 配置..."
    export $(grep -v '^#' ".env.gateway" | grep -v '^\s*$' | xargs)
else
    echo "[3/4] 警告: .env.gateway 不存在，使用默认配置"
    echo "       建议: cp .env.gateway.example .env.gateway && vim .env.gateway"
fi

# 4. 设置默认值
export HERMES_GATEWAY_DATA="${HERMES_GATEWAY_DATA:-$SCRIPT_DIR/gateway-data}"
export HERMES_GATEWAY_PORT="${HERMES_GATEWAY_PORT:-8080}"
export HERMES_GATEWAY_HOST="${HERMES_GATEWAY_HOST:-0.0.0.0}"
mkdir -p "$HERMES_GATEWAY_DATA"

echo "[4/4] 启动 MCP Gateway..."
echo "       HTTP API: http://$HERMES_GATEWAY_HOST:$HERMES_GATEWAY_PORT"
echo "       MCP Server: http://$HERMES_GATEWAY_HOST:$((HERMES_GATEWAY_PORT + 1))/mcp"
echo "       Data: $HERMES_GATEWAY_DATA"
echo

# 用 nohup 后台运行
cd "$SCRIPT_DIR/.."
nohup "$SCRIPT_DIR/venv/bin/python" -m mcp_gateway > "$SCRIPT_DIR/gateway.log" 2>&1 &
GATEWAY_PID=$!
echo "$GATEWAY_PID" > "$SCRIPT_DIR/gateway.pid"

echo "✅ Gateway 已启动 (PID: $GATEWAY_PID)"
echo "   日志: $SCRIPT_DIR/gateway.log"
echo "   停止: kill \$(cat $SCRIPT_DIR/gateway.pid)"
echo
echo "验证："
sleep 2
curl -s "http://127.0.0.1:${HERMES_GATEWAY_PORT}/health" | python3 -m json.tool || echo "  (等待启动中...)"
