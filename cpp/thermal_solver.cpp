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
#include <algorithm>
#include <cmath>
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

// A node (grid point) of the FEA mesh, in millimetres.
struct MeshNode {
  double x;
  double y;
  double temperature;  // to be solved for, in degrees Celsius
  int groupId;          // debug: id of the nearest non-adiabatic boundary group, or -1
  double boundaryDistance;  // debug: resistance-weighted distance to that boundary
};

// A quadrilateral element of the mesh, referencing its four corner nodes by
// index in `Mesh::nodes` (counter-clockwise: bottom-left, bottom-right,
// top-right, top-left), with the thermal conductivity of the material
// occupying it. `lambda` is 0 for cells outside every layer (no material).
struct MeshElement {
  int n0;
  int n1;
  int n2;
  int n3;
  double lambda;
};

// A regular rectangular grid mesh covering the bounding box of the input
// layers. Nodes are laid out row-major, (cols+1) x (rows+1) of them;
// elements are laid out row-major, cols x rows of them, each `cellSizeMm`
// millimetres square.
struct Mesh {
  int cols;
  int rows;
  double cellSizeMm;
  double originX;
  double originY;
  std::vector<MeshNode> nodes;
  std::vector<MeshElement> elements;
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
  std::vector<double> lambda;  // per-cell conductivity, 0 = no material
  int iterations;
  double maxResidual;
  double insideLengthM;   // total exposed length of "inside" boundary, m
  double insideU;         // effective U-value of "inside" boundary, W/m^2K
  double outsideLengthM;  // total exposed length of "outside" boundary, m
  double outsideU;        // effective U-value of "outside" boundary, W/m^2K
};

#include "initial_temperature.h"
#include "steady_state_solver.h"
#include "u_value.h"

// Builds the sorted list of grid-line positions along one axis: every
// distinct layer-boundary coordinate in `coords`, with the gaps between
// consecutive boundaries subdivided into roughly `cellSizeMm`-sized steps so
// every cell aligns exactly with a layer edge.
std::vector<double> buildMeshAxis(std::vector<double> coords, double cellSizeMm) {
  std::sort(coords.begin(), coords.end());
  std::vector<double> axis;
  axis.push_back(coords.front());
  const double eps = 1e-6;
  for (size_t i = 0; i + 1 < coords.size(); ++i) {
    double a = coords[i];
    double b = coords[i + 1];
    double span = b - a;
    if (span <= eps) continue;
    int steps = std::max(1, (int)std::ceil(span / cellSizeMm));
    double step = span / steps;
    for (int k = 1; k <= steps; ++k) {
      axis.push_back(a + step * k);
    }
  }
  return axis;
}

// Builds a rectangular grid mesh covering the bounding box of `layers`, with
// roughly `cellSizeMm`-sized cells. Grid lines are placed on every layer
// boundary so cells align exactly with material edges, and the gaps between
// boundaries are subdivided evenly to stay close to `cellSizeMm`. Each
// element is assigned the thermal conductivity of whichever layer's
// rectangle contains its centre (0 if none, i.e. the cell falls outside
// every layer).
Mesh buildMesh(const std::vector<Layer>& layers, double cellSizeMm) {
  Mesh mesh;
  mesh.cols = 0;
  mesh.rows = 0;
  mesh.cellSizeMm = cellSizeMm;
  mesh.originX = 0;
  mesh.originY = 0;

  if (layers.empty() || cellSizeMm <= 0) return mesh;

  std::vector<double> xs, ys;
  for (const auto& layer : layers) {
    xs.push_back(layer.x);
    xs.push_back(layer.x + layer.w);
    ys.push_back(layer.y);
    ys.push_back(layer.y + layer.h);
  }

  std::vector<double> nodeXs = buildMeshAxis(xs, cellSizeMm);
  std::vector<double> nodeYs = buildMeshAxis(ys, cellSizeMm);

  int cols = (int)nodeXs.size() - 1;
  int rows = (int)nodeYs.size() - 1;
  if (cols < 1 || rows < 1) return mesh;

  mesh.cols = cols;
  mesh.rows = rows;
  mesh.originX = nodeXs.front();
  mesh.originY = nodeYs.front();

  // Nodes: (cols+1) x (rows+1) grid points, row-major from the origin.
  int nodeCols = cols + 1;
  mesh.nodes.reserve(nodeCols * (rows + 1));
  for (int j = 0; j <= rows; ++j) {
    for (int i = 0; i <= cols; ++i) {
      mesh.nodes.push_back({nodeXs[i], nodeYs[j]});
    }
  }

  // Elements: cols x rows quads, each referencing its four corner nodes and
  // taking the conductivity of the layer whose rectangle contains its centre.
  mesh.elements.reserve(cols * rows);
  for (int j = 0; j < rows; ++j) {
    for (int i = 0; i < cols; ++i) {
      double cx = (nodeXs[i] + nodeXs[i + 1]) / 2.0;
      double cy = (nodeYs[j] + nodeYs[j + 1]) / 2.0;

      double lambda = 0.0;
      for (const auto& layer : layers) {
        if (cx >= layer.x && cx <= layer.x + layer.w &&
            cy >= layer.y && cy <= layer.y + layer.h) {
          lambda = layer.lambda;
          break;
        }
      }

      int n0 = j * nodeCols + i;
      int n1 = j * nodeCols + (i + 1);
      int n2 = (j + 1) * nodeCols + (i + 1);
      int n3 = (j + 1) * nodeCols + i;

      mesh.elements.push_back({n0, n1, n2, n3, lambda});
    }
  }

  return mesh;
}

// Builds the mesh and fills in the heuristic initial temperature guess (see
// initial_temperature.h), without running the full solve. Used by the debug
// view to inspect the heuristic's output.
Mesh buildMeshWithInitialTemperature(
    const std::vector<Layer>& layers,
    const std::vector<EdgeCondition>& conditions,
    double cellSizeMm) {
  Mesh mesh = buildMesh(layers, cellSizeMm);
  computeInitialTemperatures(mesh, layers, conditions);
  return mesh;
}

// Builds the mesh, fills in the heuristic initial temperature guess, and
// then refines it toward the steady-state solution (see
// steady_state_solver.h). Used by the debug view to inspect the solver's
// output.
Mesh buildMeshWithSteadyStateTemperature(
    const std::vector<Layer>& layers,
    const std::vector<EdgeCondition>& conditions,
    double cellSizeMm) {
  Mesh mesh = buildMesh(layers, cellSizeMm);
  auto info = computeInitialTemperatures(mesh, layers, conditions);
  refineTemperatures(mesh, info);
  return mesh;
}

// Solves for the steady-state temperature field across the cross-section.
//
// `cellSizeMm` controls the resolution of the mesh and the returned grid.
ThermalResult solveThermal(
    const std::vector<Layer>& layers,
    const std::vector<EdgeCondition>& conditions,
    double cellSizeMm) {
  Mesh mesh = buildMesh(layers, cellSizeMm);
  auto info = computeInitialTemperatures(mesh, layers, conditions);
  RefineResult rr = refineTemperatures(mesh, info);

  ThermalResult result;
  result.cols = mesh.cols;
  result.rows = mesh.rows;
  result.cellSizeMm = cellSizeMm;
  result.originX = mesh.originX;
  result.originY = mesh.originY;
  result.iterations = rr.iterations;
  result.maxResidual = rr.maxResidual;

  result.temperatures.assign((size_t)mesh.cols * mesh.rows, 0.0);
  result.lambda.assign((size_t)mesh.cols * mesh.rows, 0.0);
  int nodeCols = mesh.cols + 1;
  for (int j = 0; j < mesh.rows; ++j) {
    for (int i = 0; i < mesh.cols; ++i) {
      int n0 = j * nodeCols + i;
      int n1 = j * nodeCols + (i + 1);
      int n2 = (j + 1) * nodeCols + (i + 1);
      int n3 = (j + 1) * nodeCols + i;
      double avg = (mesh.nodes[n0].temperature + mesh.nodes[n1].temperature +
                    mesh.nodes[n2].temperature + mesh.nodes[n3].temperature) / 4.0;
      result.temperatures[(size_t)j * mesh.cols + i] = avg;
      result.lambda[(size_t)j * mesh.cols + i] = mesh.elements[(size_t)j * mesh.cols + i].lambda;
    }
  }

  UValueResult uValues = computeUValues(mesh, layers, conditions, result.temperatures);
  result.insideLengthM = uValues.insideLengthM;
  result.insideU = uValues.insideU;
  result.outsideLengthM = uValues.outsideLengthM;
  result.outsideU = uValues.outsideU;

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

  emscripten::value_object<MeshNode>("MeshNode")
      .field("x", &MeshNode::x)
      .field("y", &MeshNode::y)
      .field("temperature", &MeshNode::temperature)
      .field("groupId", &MeshNode::groupId)
      .field("boundaryDistance", &MeshNode::boundaryDistance);

  emscripten::value_object<MeshElement>("MeshElement")
      .field("n0", &MeshElement::n0)
      .field("n1", &MeshElement::n1)
      .field("n2", &MeshElement::n2)
      .field("n3", &MeshElement::n3)
      .field("lambda", &MeshElement::lambda);

  emscripten::value_object<Mesh>("Mesh")
      .field("cols", &Mesh::cols)
      .field("rows", &Mesh::rows)
      .field("cellSizeMm", &Mesh::cellSizeMm)
      .field("originX", &Mesh::originX)
      .field("originY", &Mesh::originY)
      .field("nodes", &Mesh::nodes)
      .field("elements", &Mesh::elements);

  emscripten::value_object<ThermalResult>("ThermalResult")
      .field("cols", &ThermalResult::cols)
      .field("rows", &ThermalResult::rows)
      .field("cellSizeMm", &ThermalResult::cellSizeMm)
      .field("originX", &ThermalResult::originX)
      .field("originY", &ThermalResult::originY)
      .field("temperatures", &ThermalResult::temperatures)
      .field("lambda", &ThermalResult::lambda)
      .field("iterations", &ThermalResult::iterations)
      .field("maxResidual", &ThermalResult::maxResidual)
      .field("insideLengthM", &ThermalResult::insideLengthM)
      .field("insideU", &ThermalResult::insideU)
      .field("outsideLengthM", &ThermalResult::outsideLengthM)
      .field("outsideU", &ThermalResult::outsideU);

  emscripten::register_vector<Layer>("LayerVector");
  emscripten::register_vector<EdgeCondition>("EdgeConditionVector");
  emscripten::register_vector<MeshNode>("MeshNodeVector");
  emscripten::register_vector<MeshElement>("MeshElementVector");
  emscripten::register_vector<double>("DoubleVector");

  emscripten::function("buildMesh", &buildMesh);
  emscripten::function("buildMeshWithInitialTemperature", &buildMeshWithInitialTemperature);
  emscripten::function("buildMeshWithSteadyStateTemperature", &buildMeshWithSteadyStateTemperature);
  emscripten::function("solveThermal", &solveThermal);
}
