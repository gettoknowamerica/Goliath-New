# Move Ollama models off C: to the 8TB F: drive. Run as Administrator.
# Reclaims roughly 36 GB on C: with the current model set.

Write-Host "Stopping Ollama..." -ForegroundColor Cyan
Get-Process ollama* -ErrorAction SilentlyContinue | Stop-Process -Force
Start-Sleep -Seconds 3

$src = Join-Path $env:USERPROFILE ".ollama\models"
$dst = "F:\GoliathOmni\ollama-models"

if (-not (Test-Path $src)) { Write-Host "No models at $src - nothing to move." -ForegroundColor Yellow }
else {
  Write-Host "Moving $src -> $dst" -ForegroundColor Cyan
  robocopy $src $dst /E /MOVE /MT:16 /R:2 /W:2 | Out-Null
}

Write-Host "Setting machine environment..." -ForegroundColor Cyan
[Environment]::SetEnvironmentVariable("OLLAMA_MODELS", $dst, "Machine")
# 0.0.0.0 is what lets n8n, the watcher and PHP reach Ollama - not just the desktop app
[Environment]::SetEnvironmentVariable("OLLAMA_HOST", "0.0.0.0:11434", "Machine")
# Short keep-alive so a 7B model releases VRAM before ComfyUI needs the card
[Environment]::SetEnvironmentVariable("OLLAMA_KEEP_ALIVE", "5m", "Machine")
[Environment]::SetEnvironmentVariable("OLLAMA_MAX_LOADED_MODELS", "1", "Machine")

Write-Host ""
Write-Host "Done. CLOSE this terminal, open a new one, start Ollama, then run:" -ForegroundColor Green
Write-Host "  ollama list" -ForegroundColor Green
Write-Host "  curl.exe http://localhost:11434/api/tags" -ForegroundColor Green
