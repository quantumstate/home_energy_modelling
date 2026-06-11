@echo off
REM Builds cpp\thermal_solver.cpp into a WebAssembly module under src\wasm\.
REM
REM Activates the Emscripten SDK environment automatically, so this can be
REM run from a normal terminal (no need to open emcmdprompt.bat first).
REM
REM Usage:
REM   cpp\build.bat

setlocal

call "%USERPROFILE%\emsdk\emsdk_env.bat" >nul

cd /d "%~dp0"

set OUT_DIR=..\src\wasm
if not exist "%OUT_DIR%" mkdir "%OUT_DIR%"

call emcc thermal_solver.cpp ^
  -O2 ^
  -lembind ^
  -s MODULARIZE=1 ^
  -s EXPORT_ES6=1 ^
  -s ENVIRONMENT=web ^
  -s ALLOW_MEMORY_GROWTH=1 ^
  -o "%OUT_DIR%\thermal_solver.mjs"

if errorlevel 1 exit /b %errorlevel%

echo Built %OUT_DIR%\thermal_solver.mjs (+ .wasm)
