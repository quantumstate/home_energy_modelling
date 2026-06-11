#!/usr/bin/env bash
# Builds cpp/thermal_solver.cpp into a WebAssembly module under src/wasm/.
#
# Requires the Emscripten SDK (emcc) to be installed and activated:
#   https://emscripten.org/docs/getting_started/downloads.html
#
# Usage:
#   ./cpp/build.sh

set -euo pipefail

cd "$(dirname "$0")"

OUT_DIR="../src/wasm"
mkdir -p "$OUT_DIR"

emcc thermal_solver.cpp \
  -O2 \
  -lembind \
  -s MODULARIZE=1 \
  -s EXPORT_ES6=1 \
  -s ENVIRONMENT=web \
  -s ALLOW_MEMORY_GROWTH=1 \
  -o "$OUT_DIR/thermal_solver.mjs"

echo "Built $OUT_DIR/thermal_solver.mjs (+ .wasm)"
