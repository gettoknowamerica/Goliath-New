@echo off
setlocal enabledelayedexpansion
title Goliath Omni OS - local runtime

set ROOT=F:\GoliathOmni
set LOCAL=%ROOT%\local
set VENVPY=%ROOT%\venv\Scripts\python.exe
set CFL=%ROOT%\cloudflared\cloudflared.exe
set COMFY=F:\Mark Pires\ComfyUI

echo ============================================================
echo   GOLIATH OMNI OS - starting local stack
echo   Everything local. Only Twilio + Resend leave this machine.
echo ============================================================
echo.

rem ---------- 1. Ollama ----------
echo [1/6] Ollama...
curl.exe -s -m 5 http://127.0.0.1:11434/api/tags >nul 2>&1
if errorlevel 1 (
  echo       not responding - launching
  start "" ollama serve
  timeout /t 8 >nul
) else (
  echo       up
)
"%VENVPY%" "%LOCAL%\llm\router.py"

rem ---------- 2. Media receiver ----------
echo.
echo [2/6] Media receiver (8787)...
start "Goliath Receiver" cmd /k "cd /d %ROOT% && %VENVPY% media_receiver.py"
timeout /t 3 >nul

rem ---------- 3. Watcher ----------
echo [3/6] Media watcher (8788)...
start "Goliath Watcher" cmd /k "cd /d %LOCAL%\watcher && %VENVPY% watcher.py"
timeout /t 3 >nul

rem ---------- 4. ComfyUI ----------
echo [4/6] ComfyUI (8188)...
if exist "%COMFY%\main.py" (
  start "ComfyUI" cmd /k "cd /d \"%COMFY%\" && %VENVPY% main.py --listen 127.0.0.1 --port 8188"
) else (
  echo       NOT FOUND at %COMFY%
)
timeout /t 3 >nul

rem ---------- 5. App on 3000 ----------
echo [5/6] Mission Control (3000)...
start "Goliath App" cmd /k "cd /d %ROOT%\mission-control && npm run start"
timeout /t 5 >nul

rem ---------- 6. Tunnels ----------
echo [6/6] Cloudflare quick tunnels...
start "Tunnel - App 3000" cmd /k "%CFL% tunnel --url http://localhost:3000"
start "Tunnel - Receiver 8787" cmd /k "%CFL% tunnel --url http://localhost:8787"

echo.
echo ============================================================
echo   Local:  http://localhost:3000/mission-control/
echo.
echo   Two tunnel windows opened. Copy BOTH trycloudflare.com URLs
echo   into local\config\goliath.env - they change on every restart.
echo ============================================================
echo.
pause
