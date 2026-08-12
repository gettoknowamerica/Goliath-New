# LeadForge - one-time install on Windows
$ErrorActionPreference = "Stop"
Write-Host "=== LeadForge install ===" -ForegroundColor Cyan

# 1) Prereqs
foreach ($cmd in @("git", "bun", "node", "cloudflared", "ollama")) {
  if (Get-Command $cmd -ErrorAction SilentlyContinue) { Write-Host "OK  $cmd" -ForegroundColor Green }
  else { Write-Host "MISSING  $cmd  (see README section 1)" -ForegroundColor Yellow }
}

# 2) Clone
if (-not (Test-Path "C:\Goliath-New")) {
  git clone https://github.com/gettoknowamerica/Goliath-New.git C:\Goliath-New
}
Set-Location C:\Goliath-New

# 3) Dependencies
bun install

# 4) .env from template (never overwrite an existing .env)
if (-not (Test-Path ".env")) { Copy-Item .env.example .env; Write-Host ".env created - EDIT IT (passwords!)" -ForegroundColor Yellow }

# 5) Build with the mission-control base path
$env:APP_BASE_PATH = "/mission-control"
bun run build

# 6) Pull the default Ollama model (8B-class fits the 10GB RTX 3080)
if (Get-Command ollama -ErrorAction SilentlyContinue) { ollama pull llama3.1:8b }

Write-Host "=== Install done. Edit .env, then run start-local.ps1 ===" -ForegroundColor Cyan
