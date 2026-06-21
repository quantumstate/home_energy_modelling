// Graded rectangular mesh for the ground slab transient simulator.
//
// Builds a tensor-product grid with fine cells near building features and
// the ground surface, growing geometrically toward the far-field domain
// boundaries. All existing conductance helpers (edgeResistance, nodeDistance)
// remain valid on a non-uniform grid because they read actual node coordinates.
#pragma once

#include <algorithm>
#include <cmath>
#include <cstdint>
#include <string>
#include <vector>

// ── Input structs ──────────────────────────────────────────────────────────

// A rectangular material layer (mm) with thermal properties and a priority.
// Higher priority wins at cell-centre lookup; the ground box uses priority 0,
// building layers use priority 1 so they "subtract" from the ground.
struct GroundLayer {
  double x, y, w, h;  // bounding rectangle (mm)
  double lambda;       // thermal conductivity (W/m·K)
  double rhoC;         // volumetric heat capacity (J/m³·K) = density * specificHeat
  int priority;        // 0 = ground background, 1+ = building elements
};

// Boundary condition assigned to one edge of a GroundLayer.
// type: "inside"   – fixed indoor temperature (Dirichlet)
//       "surface"  – time-varying EPW air temperature (Dirichlet per step)
//       "adiabatic"– zero flux (natural Neumann; no action needed in solver)
struct GroundEdgeCondition {
  int layerIndex;
  std::string side;  // "top" | "right" | "bottom" | "left"
  std::string type;
  double temperature;  // used for "inside"; ignored for "surface"/"adiabatic"
};

// Freely-placed polyline across which heat flux is integrated.
struct MeasureLine {
  std::vector<double> xs;  // vertex x-coordinates (mm)
  std::vector<double> ys;  // vertex y-coordinates (mm)
};

// Solver configuration / domain parameters.
struct GroundConfig {
  double nearCellMm;        // finest cell size near features (mm)
  double growthRatio;       // geometric growth factor per cell (> 1)
  double maxCellMm;         // largest cell size in the far field (mm)
  double domainDepthM;      // ground domain depth below surface (m)
  double domainHalfWidthM;  // half-width of ground domain (m)
  double dtSeconds;         // timestep length (s) — 3600 for hourly
  double indoorTemp;        // indoor air temperature (°C)
  int stepsPerYear;         // timesteps in one year (e.g. 8760)
  int spinupYears;          // spin-up passes before the reported year
};

// ── Internal mesh ──────────────────────────────────────────────────────────

// Non-uniform tensor-product grid for the ground domain.
// Node (i, j) is at world position (nodeXs[i], nodeYs[j]).
// Node index = j * (cols + 1) + i.
// Cell (ci, cj) occupies [nodeXs[ci], nodeXs[ci+1]] × [nodeYs[cj], nodeYs[cj+1]].
// Cell index = cj * cols + ci.
struct GroundMesh {
  int cols, rows;
  double originX, originY;        // nodeXs[0], nodeYs[0]
  std::vector<double> nodeXs;    // cols+1 x-axis node positions (mm)
  std::vector<double> nodeYs;    // rows+1 y-axis node positions (mm)
  std::vector<double> temperatures;  // (cols+1)*(rows+1) node temperatures (°C)
  std::vector<double> lambda;        // cols*rows per-cell conductivity (W/m·K)
  std::vector<double> rhoC;          // cols*rows per-cell volumetric heat cap (J/m³·K)
};

// ── Mesh construction ──────────────────────────────────────────────────────

namespace graded_mesh_detail {

// Adds graded or uniform fill points between `a` and `b` into `axis`.
// fineAtA = true  → cells start small at a and grow toward b
// fineAtA = false → cells start small at b (reversed), coarse at a
static void fillGap(std::vector<double>& axis, double a, double b,
                    bool fineAtA, double nearCellMm, double growthRatio, double maxCellMm) {
  double span = b - a;
  if (span < 1e-9) { axis.push_back(b); return; }

  // Build cell sizes from the fine end outward.
  std::vector<double> sizes;
  double h = nearCellMm;
  double cum = 0.0;
  while (cum + 1e-9 < span) {
    double cell = std::min(h, span - cum);
    sizes.push_back(cell);
    cum += cell;
    h = std::min(h * growthRatio, maxCellMm);
  }

  // Rescale so sizes sum exactly to span.
  double total = 0.0;
  for (double s : sizes) total += s;
  double scale = (total > 1e-12) ? (span / total) : 1.0;

  if (!fineAtA) std::reverse(sizes.begin(), sizes.end());

  double pos = a;
  for (size_t k = 0; k < sizes.size(); ++k) {
    pos += sizes[k] * scale;
    axis.push_back((k + 1 == sizes.size()) ? b : pos);
  }
}

// Builds one axis of the graded mesh from a sorted, deduplicated coordinate
// list. `minIsFar` / `maxIsFar` flag whether the domain extent at that end
// should trigger geometric grading (true) or leave the first/last gap uniform.
static std::vector<double> buildGradedAxis(std::vector<double> coords,
                                            bool minIsFar, bool maxIsFar,
                                            double nearCellMm, double growthRatio,
                                            double maxCellMm) {
  // Merge near-coincident breakpoints. Feature edges that fall within a small
  // fraction of the finest cell size produce degenerate sliver cells that wreck
  // the local conditioning of the Gauss-Seidel solve (slow/asymmetric
  // convergence, persistent hot/cold artefacts). Snapping them together is
  // physically negligible (sub-cell) and keeps the mesh well-conditioned.
  const double eps = std::max(1e-6, nearCellMm * 0.1);
  std::sort(coords.begin(), coords.end());
  coords.erase(std::unique(coords.begin(), coords.end(),
                           [eps](double a, double b) { return std::abs(b - a) < eps; }),
               coords.end());

  std::vector<double> axis;
  if (coords.empty()) return axis;
  axis.push_back(coords[0]);

  for (size_t i = 0; i + 1 < coords.size(); ++i) {
    double a = coords[i], b = coords[i + 1];
    bool aIsFar = (i == 0 && minIsFar);
    bool bIsFar = (i + 1 == coords.size() - 1 && maxIsFar);

    if (aIsFar || bIsFar) {
      // Grade from the near end toward the far end.
      bool fineAtA = bIsFar;  // b is the far end → fine at a
      fillGap(axis, a, b, fineAtA, nearCellMm, growthRatio, maxCellMm);
    } else {
      // Both endpoints are feature breakpoints: uniform fine fill.
      int steps = std::max(1, (int)std::ceil((b - a) / nearCellMm));
      double step = (b - a) / steps;
      for (int k = 1; k <= steps; ++k)
        axis.push_back(a + step * k);
    }
  }
  return axis;
}

}  // namespace graded_mesh_detail

// Builds the graded ground mesh from a set of layers and the domain config.
// `lineXs` / `lineYs` are measurement-line vertex coordinates to snap into
// the mesh axes so the line aligns cleanly with cell edges.
inline GroundMesh buildGroundMesh(const std::vector<GroundLayer>& layers,
                                   const GroundConfig& config,
                                   const std::vector<double>& lineXs = {},
                                   const std::vector<double>& lineYs = {}) {
  using namespace graded_mesh_detail;

  const double domainLeft  = -config.domainHalfWidthM * 1000.0;
  const double domainRight = +config.domainHalfWidthM * 1000.0;
  // domainTop is derived from the topmost layer (may include above-ground building).
  // domainBottom is the configurable deep boundary.
  double domainTop = 0.0;
  for (const auto& l : layers) domainTop = std::min(domainTop, l.y);
  const double domainBottom = config.domainDepthM * 1000.0;

  // Collect mandatory breakpoints for each axis.
  std::vector<double> xCoords = {domainLeft, domainRight};
  std::vector<double> yCoords = {domainTop, domainBottom};

  for (const auto& l : layers) {
    xCoords.push_back(l.x);
    xCoords.push_back(l.x + l.w);
    yCoords.push_back(l.y);
    yCoords.push_back(l.y + l.h);
  }
  for (double x : lineXs) xCoords.push_back(x);
  for (double y : lineYs) yCoords.push_back(y);

  // Build graded axes.
  // X: both domain extents are "far" → grade from building edges outward.
  // Y: only domainBottom is "far" (top is features/building) → grade downward.
  auto nodeXs = buildGradedAxis(xCoords, /*minIsFar=*/true,  /*maxIsFar=*/true,
                                 config.nearCellMm, config.growthRatio, config.maxCellMm);
  auto nodeYs = buildGradedAxis(yCoords, /*minIsFar=*/false, /*maxIsFar=*/true,
                                 config.nearCellMm, config.growthRatio, config.maxCellMm);

  GroundMesh mesh;
  mesh.cols    = (int)nodeXs.size() - 1;
  mesh.rows    = (int)nodeYs.size() - 1;
  mesh.originX = nodeXs.front();
  mesh.originY = nodeYs.front();
  mesh.nodeXs  = nodeXs;
  mesh.nodeYs  = nodeYs;

  int numNodes = (mesh.cols + 1) * (mesh.rows + 1);
  int numCells = mesh.cols * mesh.rows;
  mesh.temperatures.assign(numNodes, 0.0);
  mesh.lambda.assign(numCells, 0.0);
  mesh.rhoC.assign(numCells, 0.0);

  // Priority-based cell-material assignment: highest priority layer wins.
  for (int cj = 0; cj < mesh.rows; ++cj) {
    for (int ci = 0; ci < mesh.cols; ++ci) {
      double cx = (nodeXs[ci] + nodeXs[ci + 1]) * 0.5;
      double cy = (nodeYs[cj] + nodeYs[cj + 1]) * 0.5;

      int bestPriority = INT32_MIN;
      double bestLambda = 0.0;
      double bestRhoC   = 0.0;

      for (const auto& l : layers) {
        if (cx >= l.x && cx <= l.x + l.w && cy >= l.y && cy <= l.y + l.h) {
          if (l.priority > bestPriority) {
            bestPriority = l.priority;
            bestLambda   = l.lambda;
            bestRhoC     = l.rhoC;
          }
        }
      }

      int idx = cj * mesh.cols + ci;
      mesh.lambda[idx] = bestLambda;
      mesh.rhoC[idx]   = bestRhoC;
    }
  }

  return mesh;
}
