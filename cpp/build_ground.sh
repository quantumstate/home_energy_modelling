#!/usr/bin/env bash
# Builds cpp/ground_solver.cpp into a WebAssembly module under src/wasm/.
# Loaded inside a Web Worker so ENVIRONMENT includes "worker".
set -e
cd "$(dirname "$0")"
OUT_DIR="../src/wasm"
mkdir -p "$OUT_DIR"
emcc ground_solver.cpp \
  -O2 \
  -lembind \
  -s MODULARIZE=1 \
  -s EXPORT_ES6=1 \
  -s "ENVIRONMENT=web,worker" \
  -s ALLOW_MEMORY_GROWTH=1 \
  -o "$OUT_DIR/ground_solver.mjs"
echo "Built $OUT_DIR/ground_solver.mjs (+ .wasm)"
