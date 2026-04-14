# Hermes WebUI - 本地启动脚本 (PowerShell)
$ErrorActionPreference = "Stop"

Write-Host "======================================" -ForegroundColor Cyan
Write-Host " Hermes WebUI - 本地启动" -ForegroundColor Cyan
Write-Host "======================================" -ForegroundColor Cyan
Write-Host ""

Set-Location $PSScriptRoot

# 加载 .env 文件
$envFile = Join-Path $PSScriptRoot ".env"
if (Test-Path $envFile) {
    Write-Host "[ok] 加载 .env 配置..." -ForegroundColor Green
    Get-Content $envFile | ForEach-Object {
        $line = $_.Trim()
        if ($line -and -not $line.StartsWith("#")) {
            $parts = $line -split "=", 2
            if ($parts.Length -eq 2) {
                $key = $parts[0].Trim()
                $value = $parts[1].Trim()
                Set-Item -Path "env:$key" -Value $value
                Write-Host "  $key = $value" -ForegroundColor DarkGray
            }
        }
    }
} else {
    Write-Host "[!!] 警告: .env 文件不存在" -ForegroundColor Yellow
}

# 检查 Python
$pythonExe = Get-Command python -ErrorAction SilentlyContinue
if (-not $pythonExe) {
    $pythonExe = Get-Command python3 -ErrorAction SilentlyContinue
}
if (-not $pythonExe) {
    Write-Host "[!!] 错误: 未找到 Python" -ForegroundColor Red
    Read-Host "按 Enter 退出"
    exit 1
}
Write-Host "[ok] Python: $($pythonExe.Source)" -ForegroundColor Green

# 检查 agent 路径
$agentDir = $env:HERMES_WEBUI_AGENT_DIR
if ($agentDir -and (Test-Path (Join-Path $agentDir "run_agent.py"))) {
    Write-Host "[ok] Agent 路径: $agentDir" -ForegroundColor Green
} else {
    Write-Host "[!!] 警告: Agent 路径无效或未设置" -ForegroundColor Yellow
}

# 检查 HERMES_HOME
$hermesHome = $env:HERMES_HOME
if ($hermesHome -and (Test-Path $hermesHome)) {
    Write-Host "[ok] HERMES_HOME: $hermesHome" -ForegroundColor Green
} else {
    Write-Host "[!!] 警告: HERMES_HOME 无效或未设置" -ForegroundColor Yellow
}

$host_ = $env:HERMES_WEBUI_HOST
$port_ = $env:HERMES_WEBUI_PORT
Write-Host ""
Write-Host "[ok] 启动 Hermes WebUI..." -ForegroundColor Green
Write-Host "    地址: http://${host_}:${port_}" -ForegroundColor White
Write-Host ""

& python server.py
