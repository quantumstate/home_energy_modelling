// Thermal bridge solver — compiled to WebAssembly via Emscripten.
//
// Receives the cross-section geometry drawn in the "Thermal Bridges" tab
// (a list of rectangular material layers plus boundary conditions assigned
// to their external edges) and returns a grid of temperatures covering the
// section's bounding box.
//
// The actual finite-difference / finite-element solve is not implemented
// here — this file only defines the data layout and the function signature
// so the JS side and build toolchain can be wired up ahead of the numerics.

#include <emscripten/bind.h>
#include <string>
#include <vector>

// One rectangular material layer, in millimetres, with its thermal
// conductivity (W/m·K).
struct Layer {
  double x;
  double y;
  double w;
  double h;
  double lambda;
};

// A boundary condition assigned to one edge of one layer.
// `side` is one of "top" | "right" | "bottom" | "left".
// `type` is one of "inside" | "outside" | "adiabatic".
// `temperature` is in degrees Celsius and is ignored when type == "adiabatic".
struct EdgeCondition {
  int layerIndex;
  std::string side;
  std::string type;
  double temperature;
};

// Result grid: row-major array of temperatures (degrees Celsius), `cols` x
// `rows` cells, each `cellSizeMm` millimetres square. The grid covers the
// bounding box of the input layers, with `originX` / `originY` giving the
// world-space position (mm) of the grid's top-left corner.
struct ThermalResult {
  int cols;
  int rows;
  double cellSizeMm;
  double originX;
  double originY;
  std::vector<double> temperatures;
};

// Solves for the steady-state temperature field across the cross-section.
//
// `cellSizeMm` controls the resolution of the returned grid.
//
// TODO: implement the actual heat-conduction solve. Currently returns an
// empty grid.
ThermalResult solveThermal(
    const std::vector<Layer>& layers,
    const std::vector<EdgeCondition>& conditions,
    double cellSizeMm) {
  ThermalResult result;
  result.cols = 0;
  result.rows = 0;
  result.cellSizeMm = cellSizeMm;
  result.originX = 0;
  result.originY = 0;
  return result;
}

EMSCRIPTEN_BINDINGS(thermal_solver) {
  emscripten::value_object<Layer>("Layer")
      .field("x", &Layer::x)
      .field("y", &Layer::y)
      .field("w", &Layer::w)
      .field("h", &Layer::h)
      .field("lambda", &Layer::lambda);

  emscripten::value_object<EdgeCondition>("EdgeCondition")
      .field("layerIndex", &EdgeCondition::layerIndex)
      .field("side", &EdgeCondition::side)
      .field("type", &EdgeCondition::type)
      .field("temperature", &EdgeCondition::temperature);

  emscripten::value_object<ThermalResult>("ThermalResult")
      .field("cols", &ThermalResult::cols)
      .field("rows", &ThermalResult::rows)
      .field("cellSizeMm", &ThermalResult::cellSizeMm)
      .field("originX", &ThermalResult::originX)
      .field("originY", &ThermalResult::originY)
      .field("temperatures", &ThermalResult::temperatures);

  emscripten::register_vector<Layer>("LayerVector");
  emscripten::register_vector<EdgeCondition>("EdgeConditionVector");
  emscripten::register_vector<double>("DoubleVector");

  emscripten::function("solveThermal", &solveThermal);
}
