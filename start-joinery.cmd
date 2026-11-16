@echo off
rem Starts Joinery from this checkout and opens it in the browser. Ctrl+C stops it.
cd /d "%~dp0"
where bun >nul 2>nul || (echo Bun is required: npm install -g bun& exit /b 1)
if not exist node_modules (call bun install || exit /b 1)
call bun run --filter @joinery/web build || exit /b 1
bun scripts\start.ts
