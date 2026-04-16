@echo off
chcp 65001 >nul 2>&1
setlocal

echo ======================================
echo  Hermes WebUI - 本地启动脚本
echo ======================================
echo.

cd /d "%~dp0"

REM 加载 .env 文件中的环境变量
if exist ".env" (
    echo [ok] 加载 .env 配置...
    for /f "usebackq tokens=1,* delims==" %%a in (".env") do (
        REM 跳过注释行和空行
        echo %%a | findstr /r "^#" >nul || (
            if not "%%a"=="" (
                set "%%a=%%b"
            )
        )
    )
) else (
    echo [!!] 警告: .env 文件不存在
)

REM 检查 Python
where python >nul 2>&1
if %errorlevel% neq 0 (
    echo [!!] 错误: 未找到 Python，请安装 Python 3.10+
    pause
    exit /b 1
)

REM 检查 pyyaml
python -c "import yaml" >nul 2>&1
if %errorlevel% neq 0 (
    echo [ok] 安装依赖 pyyaml...
    pip install pyyaml>=6.0
)

REM 检查 agent 源码
if defined HERMES_WEBUI_AGENT_DIR (
    echo [ok] Agent 路径: %HERMES_WEBUI_AGENT_DIR%
    if exist "%HERMES_WEBUI_AGENT_DIR%\run_agent.py" (
        echo [ok] 已找到 run_agent.py
    ) else (
        echo [!!] 警告: 在 %HERMES_WEBUI_AGENT_DIR% 中未找到 run_agent.py
    )
) else (
    echo [!!] 警告: HERMES_WEBUI_AGENT_DIR 未设置
)

if not defined HERMES_WEBUI_HOST set "HERMES_WEBUI_HOST=127.0.0.1"
if not defined HERMES_WEBUI_PORT set "HERMES_WEBUI_PORT=18080"

set "HERMES_WEBUI_ACCESS_HOST=%HERMES_WEBUI_HOST%"
if /I "%HERMES_WEBUI_ACCESS_HOST%"=="0.0.0.0" set "HERMES_WEBUI_ACCESS_HOST=127.0.0.1"
if /I "%HERMES_WEBUI_ACCESS_HOST%"=="::" set "HERMES_WEBUI_ACCESS_HOST=127.0.0.1"
if /I "%HERMES_WEBUI_ACCESS_HOST%"=="[::]" set "HERMES_WEBUI_ACCESS_HOST=127.0.0.1"

echo.
echo [ok] 启动 Hermes WebUI...
echo     监听: http://%HERMES_WEBUI_HOST%:%HERMES_WEBUI_PORT%
echo     打开: http://%HERMES_WEBUI_ACCESS_HOST%:%HERMES_WEBUI_PORT%
echo.

python server.py

pause
