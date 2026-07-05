@echo off
rem ── The Wilds of Aerwyn — double-click to play ──
cd /d "%~dp0"
start "Aerwyn server" /min python serve.py
rem give the server a moment, then open the game
timeout /t 1 /nobreak >nul
start "" http://localhost:8123
