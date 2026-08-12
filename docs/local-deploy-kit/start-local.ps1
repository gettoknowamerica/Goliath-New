# LeadForge - start (or restart) app server + cloudflared tunnel, kept alive
$ErrorActionPreference = "Stop"
Set-Location C:\Goliath-New

# Load APP_BASE_PATH (and anything else) from .env
if (Test-Path ".env") { Get-Content ".env" | ForEach-Object { if ($_ -match "^\s*([^#][^=]+)=(.*)$") { [Environment]::SetEnvironmentVariable($matches[1].Trim(), $matches[2].Trim(), "Process") } } }
if (-not $env:APP_BASE_PATH) { $env:APP_BASE_PATH = "/mission-control" }

# Kill stale copies
Get-Process -Name "bun" -ErrorAction SilentlyContinue | Where-Object { $_.Path -like "*bun*" } | Stop-Process -Force -ErrorAction SilentlyContinue
Get-Process -Name "cloudflared" -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue

# App server (detached)
Start-Process -WindowStyle Hidden -FilePath "bun" -ArgumentList "run serve.ts" -WorkingDirectory "C:\Goliath-New"
Write-Host "App server starting on http://localhost:3000 (base path $env:APP_BASE_PATH)"

# Tunnel (detached) - creates the tunnel + DNS route on first run if missing
Start-Process -WindowStyle Hidden -FilePath "cloudflared" -ArgumentList "tunnel run leadforge-home" -WorkingDirectory "C:\Goliath-New"
Write-Host "cloudflared starting (tunnel: leadforge-home)"

Start-Sleep 3
Write-Host "Local check:  http://localhost:3000$env:APP_BASE_PATH/login"
Write-Host "Public check: https://mission-control.markpires.com$env:APP_BASE_PATH/login"
Write-Host "AI health:    curl http://localhost:3000/api/ai/health"
