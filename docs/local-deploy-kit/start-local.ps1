# LeadForge - start (or restart) app server + cloudflared tunnel, kept alive
param([string]$Dir = "F:\GoliathOmni\mission-control")
$ErrorActionPreference = "Stop"
Set-Location $Dir
# Load APP_BASE_PATH (and anything else) from .env
if (Test-Path ".env") { Get-Content ".env" | ForEach-Object { if ($_ -match "^\s*([^#][^=]+)=(.*)$") { [Environment]::SetEnvironmentVariable($matches[1].Trim(), $matches[2].Trim(), "Process") } } }
if (-not $env:APP_BASE_PATH) { $env:APP_BASE_PATH = "/mission-control" }
# Kill stale copies
Get-Process -Name "bun" -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
Get-Process -Name "cloudflared" -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
# App server (detached)
Start-Process -WindowStyle Hidden -FilePath "bun" -ArgumentList "run serve.ts" -WorkingDirectory $Dir
Write-Host "App server starting on http://localhost:3000 (base path $env:APP_BASE_PATH)"
# Tunnel (detached) - assumes you already ran: cloudflared tunnel login + create + route dns leadforge-home markpires.com
Start-Process -WindowStyle Hidden -FilePath "cloudflared" -ArgumentList "tunnel run leadforge-home" -WorkingDirectory $Dir
Write-Host "cloudflared starting (tunnel: leadforge-home -> markpires.com)"
Start-Sleep 3
Write-Host "Local check:  http://localhost:3000$env:APP_BASE_PATH/login"
Write-Host "Public check: https://markpires.com$env:APP_BASE_PATH/login   (after DNS is on Cloudflare)"
Write-Host "AI health:    curl http://localhost:3000/api/ai/health"
