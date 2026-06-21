@echo off
REM Builds cpp\ground_solver.cpp into a WebAssembly module under src\wasm\.
REM Loaded inside a Web Worker so ENVIRONMENT includes "worker".
REM
REM Usage:
REM   cpp\build_ground.bat

setlocal

call "%USERPROFILE%\emsdk\emsdk_env.bat" >nul
if errorlevel 1 (
  echo Failed to activate the Emscripten SDK at "%USERPROFILE%\emsdk". 1>&2
  echo Install/configure emsdk, or edit cpp\build_ground.bat if it lives elsewhere. 1>&2
  exit /b 1
)

cd /d "%~dp0"

set OUT_DIR=..\src\wasm
if not exist "%OUT_DIR%" mkdir "%OUT_DIR%"

call emcc ground_solver.cpp ^
  -O2 ^
  -lembind ^
  -s MODULARIZE=1 ^
  -s EXPORT_ES6=1 ^
  -s ENVIRONMENT=web,worker ^
  -s ALLOW_MEMORY_GROWTH=1 ^
  -o "%OUT_DIR%\ground_solver.mjs"

if errorlevel 1 exit /b %errorlevel%

echo Built %OUT_DIR%\ground_solver.mjs (+ .wasm)
