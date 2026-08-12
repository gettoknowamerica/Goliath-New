# LeadForge - one-time install on Windows (F: drive ready)
param([string]$Dir = "F:\GoliathOmni\mission-control")
$ErrorActionPreference = "Stop"
Write-Host "=== LeadForge install ===" -ForegroundColor Cyan
Write-Host "Target: $Dir"
# 1) Prereqs
foreach ($cmd in @("git", "bun", "node", "cloudflared", "ollama")) {
  if (Get-Command $cmd -ErrorAction SilentlyContinue) { Write-Host "OK  $cmd" -ForegroundColor Green }
  else { Write-Host "MISSING  $cmd  (see README section 1)" -ForegroundColor Yellow }
}
# 2) Clone (if not already there)
if (-not (Test-Path "$Dir\.git")) {
  New-Item -ItemType Directory -Force -Path (Split-Path $Dir -Parent) | Out-Null
  git clone https://github.com/gettoknowamerica/Goliath-New.git $Dir
}
Set-Location $Dir
# 3) Dependencies
bun install
# 4) .env from template (never overwrite an existing .env)
if (-not (Test-Path ".env")) { Copy-Item .env.example .env; Write-Host ".env created - EDIT IT (ADMIN_INITIAL_PASSWORD + SESSION_SECRET!)" -ForegroundColor Yellow }
# 5) Build with the mission-control base path
$env:APP_BASE_PATH = "/mission-control"
bun run build
# 6) Pull the default Ollama model (8B-class fits the 10GB RTX 3080)
if (Get-Command ollama -ErrorAction SilentlyContinue) { ollama pull llama3.1:8b }
Write-Host "=== Install done. Edit $Dir\.env, then run start-local.ps1 ===" -ForegroundColor Cyan
