#!/bin/bash
# 停止 MCP Gateway
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PID_FILE="$SCRIPT_DIR/gateway.pid"

if [ -f "$PID_FILE" ]; then
    PID=$(cat "$PID_FILE")
    if kill -0 "$PID" 2>/dev/null; then
        kill "$PID"
        echo "✅ Gateway 已停止 (PID: $PID)"
    else
        echo "⚠️  进程 $PID 已不存在"
    fi
    rm -f "$PID_FILE"
else
    echo "⚠️  未找到 gateway.pid 文件"
    # 尝试通过进程名查找
    PIDS=$(pgrep -f "python.*mcp_gateway" || true)
    if [ -n "$PIDS" ]; then
        echo "   发现运行中的 gateway 进程: $PIDS"
        echo "   执行 kill $PIDS 来停止"
    fi
fi
