@echo off
REM ============================================================================
REM  Hermes MCP Gateway -- 启动脚本 (Windows)
REM
REM  部署在 DevCloud 或公网可达的服务器上，作为 Knot 与多个 WebUI 实例的桥梁。
REM
REM  环境变量（在同目录 .env 中设置或 export）：
REM    HERMES_GATEWAY_PORT    -- 监听端口（默认 8080）
REM    HERMES_GATEWAY_HOST    -- 监听地址（默认 0.0.0.0）
REM    HERMES_GATEWAY_DATA    -- 数据目录（默认 ./gateway-data）
REM    HERMES_GATEWAY_TOKEN   -- API 鉴权 Token（推荐设置）
REM ============================================================================

setlocal enabledelayedexpansion

REM -- 加载 .env 文件 ---
if exist "%~dp0.env.gateway" (
    for /f "usebackq tokens=1,* delims==" %%A in ("%~dp0.env.gateway") do (
        if not "%%A"=="" if not "%%A:~0,1%"=="#" set "%%A=%%B"
    )
)

REM -- 设置默认值 ---
if "%HERMES_GATEWAY_DATA%"=="" set "HERMES_GATEWAY_DATA=%~dp0gateway-data"
if "%HERMES_GATEWAY_PORT%"=="" set "HERMES_GATEWAY_PORT=8080"

REM -- 确保数据目录存在 ---
if not exist "%HERMES_GATEWAY_DATA%" mkdir "%HERMES_GATEWAY_DATA%"

echo ============================================================
echo   Hermes MCP Gateway
echo   Port: %HERMES_GATEWAY_PORT%
echo   Data: %HERMES_GATEWAY_DATA%
echo ============================================================
echo.

REM -- 启动 ---
python -m mcp_gateway %*
