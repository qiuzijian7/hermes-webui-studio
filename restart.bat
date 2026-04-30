@echo off
chcp 65001 >nul 2>&1

echo ======================================
echo  Hermes WebUI - 重启脚本
echo ======================================
echo.

cd /d "%~dp0"

echo [1/3] 关闭 WebUI 服务器 (端口 18080)...
for /f "tokens=5" %%a in ('netstat -ano ^| findstr :18080 ^| findstr LISTENING') do (
    taskkill /PID %%a /F >nul 2>&1
    echo     已终止 PID %%a
)

echo [2/3] 关闭宿主机辅助服务 (端口 18791)...
for /f "tokens=5" %%a in ('netstat -ano ^| findstr :18791 ^| findstr LISTENING') do (
    taskkill /PID %%a /F >nul 2>&1
    echo     已终止 PID %%a
)

echo [3/3] 等待 2 秒...
timeout /t 2 /nobreak >nul 2>&1

echo.
echo [ok] 启动服务器...
start "Hermes WebUI" cmd /c "cd /d "%~dp0" && call start.bat"
