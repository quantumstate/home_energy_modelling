// Effective U-value of the "inside" and "outside" boundaries, computed from
// the solved temperature field (see cpp/steady_state_solver.h).
#pragma once

#include <algorithm>
#include <cmath>
#include <string>
#include <vector>

namespace u_value_detail {
constexpr double kEps = 1e-6;

// Standard internal/external surface (film) resistances for walls, per BS EN
// ISO 6946 (m^2 K/W). The solve imposes the boundary condition's air
// temperature directly on the exposed surface nodes, i.e. it models the
// construction's conduction resistance only; these are added in series
// afterwards so the reported U-value matches the conventional definition
// (1 / (Rsi + R_construction + Rse)).
constexpr double kRsi = 0.13;
constexpr double kRse = 0.04;

inline double elementLambdaAt(const Mesh& mesh, int ei, int ej) {
  if (ei < 0 || ei >= mesh.cols || ej < 0 || ej >= mesh.rows) return 0.0;
  return mesh.elements[(size_t)ej * mesh.cols + ei].lambda;
}

// Combines a conduction-only U-value (from the solved flux) with the
// standard surface resistances in series. Returns 0 if `conductionU` is 0
// (no exposed length / no flux).
inline double applySurfaceResistances(double conductionU) {
  if (conductionU <= 0) return 0.0;
  return 1.0 / (1.0 / conductionU + kRsi + kRse);
}
}  // namespace u_value_detail

// Total exposed length and effective U-value of the "inside" and "outside"
// boundaries, each computed separately since they may have different
// lengths (e.g. at corners / thermal bridges).
struct UValueResult {
  double insideLengthM = 0.0;
  double insideU = 0.0;
  double outsideLengthM = 0.0;
  double outsideU = 0.0;
};

// `cellTemperatures` is the cols x rows row-major grid of cell-average
// temperatures (ThermalResult::temperatures), from a converged solve.
//
// For each boundary type ("inside" / "outside"), sums Fourier's-law heat
// flux Q (W per metre of depth) from every adjacent material cell to the
// condition's fixed temperature, and the total exposed length L (m) of that
// boundary type. Q / (L * deltaT), where deltaT is the difference between
// the "inside" and "outside" condition temperatures, gives the construction's
// conduction-only U-value; the standard internal/external surface
// resistances (Rsi/Rse) are then added in series to give the conventional
// U-value (see u_value_detail::applySurfaceResistances).
inline UValueResult computeUValues(const Mesh& mesh,
                                    const std::vector<Layer>& layers,
                                    const std::vector<EdgeCondition>& conditions,
                                    const std::vector<double>& cellTemperatures) {
  using namespace u_value_detail;
  UValueResult result;
  if (mesh.cols <= 0 || mesh.rows <= 0) return result;

  int nodeCols = mesh.cols + 1;
  std::vector<double> xs(nodeCols), ys(mesh.rows + 1);
  for (int i = 0; i < nodeCols; ++i) xs[i] = mesh.nodes[i].x;
  for (int j = 0; j <= mesh.rows; ++j) ys[j] = mesh.nodes[(size_t)j * nodeCols].y;

  double insideTemp = 0.0, outsideTemp = 0.0;
  bool haveInside = false, haveOutside = false;
  for (const auto& cond : conditions) {
    if (cond.type == "inside" && !haveInside) { insideTemp = cond.temperature; haveInside = true; }
    if (cond.type == "outside" && !haveOutside) { outsideTemp = cond.temperature; haveOutside = true; }
  }
  double deltaT = std::fabs(insideTemp - outsideTemp);
  if (!haveInside || !haveOutside || deltaT < kEps) return result;

  for (const auto& cond : conditions) {
    if (cond.type != "inside" && cond.type != "outside") continue;
    if (cond.layerIndex < 0 || cond.layerIndex >= (int)layers.size()) continue;
    const Layer& layer = layers[cond.layerIndex];

    double x1, y1, x2, y2;
    if (cond.side == "top") {
      x1 = layer.x; y1 = layer.y; x2 = layer.x + layer.w; y2 = layer.y;
    } else if (cond.side == "bottom") {
      x1 = layer.x; y1 = layer.y + layer.h; x2 = layer.x + layer.w; y2 = layer.y + layer.h;
    } else if (cond.side == "left") {
      x1 = layer.x; y1 = layer.y; x2 = layer.x; y2 = layer.y + layer.h;
    } else {
      x1 = layer.x + layer.w; y1 = layer.y; x2 = layer.x + layer.w; y2 = layer.y + layer.h;
    }

    bool horizontal = std::abs(y1 - y2) < kEps;
    double lo = horizontal ? std::min(x1, x2) : std::min(y1, y2);
    double hi = horizontal ? std::max(x1, x2) : std::max(y1, y2);
    double fixed = horizontal ? y1 : x1;

    double q = 0.0;
    double length = 0.0;

    if (horizontal) {
      for (int j = 0; j < mesh.rows; ++j) {
        bool topEdge = std::abs(ys[j] - fixed) < kEps;
        bool bottomEdge = std::abs(ys[j + 1] - fixed) < kEps;
        if (!topEdge && !bottomEdge) continue;
        double cellHeightM = (ys[j + 1] - ys[j]) / 1000.0;
        if (cellHeightM <= 0) continue;
        for (int i = 0; i < mesh.cols; ++i) {
          double lambda = elementLambdaAt(mesh, i, j);
          if (lambda <= 0) continue;
          // Only count edges actually exposed to void on the condition's side.
          if (topEdge && elementLambdaAt(mesh, i, j - 1) > 0) continue;
          if (bottomEdge && elementLambdaAt(mesh, i, j + 1) > 0) continue;
          double overlapLo = std::max(xs[i], lo);
          double overlapHi = std::min(xs[i + 1], hi);
          if (overlapHi <= overlapLo + kEps) continue;
          double edgeLenM = (overlapHi - overlapLo) / 1000.0;
          double tCell = cellTemperatures[(size_t)j * mesh.cols + i];
          double flux = lambda * std::fabs(tCell - cond.temperature) / (cellHeightM / 2.0);
          q += flux * edgeLenM;
          length += edgeLenM;
        }
      }
    } else {
      for (int i = 0; i < mesh.cols; ++i) {
        bool leftEdge = std::abs(xs[i] - fixed) < kEps;
        bool rightEdge = std::abs(xs[i + 1] - fixed) < kEps;
        if (!leftEdge && !rightEdge) continue;
        double cellWidthM = (xs[i + 1] - xs[i]) / 1000.0;
        if (cellWidthM <= 0) continue;
        for (int j = 0; j < mesh.rows; ++j) {
          double lambda = elementLambdaAt(mesh, i, j);
          if (lambda <= 0) continue;
          if (leftEdge && elementLambdaAt(mesh, i - 1, j) > 0) continue;
          if (rightEdge && elementLambdaAt(mesh, i + 1, j) > 0) continue;
          double overlapLo = std::max(ys[j], lo);
          double overlapHi = std::min(ys[j + 1], hi);
          if (overlapHi <= overlapLo + kEps) continue;
          double edgeLenM = (overlapHi - overlapLo) / 1000.0;
          double tCell = cellTemperatures[(size_t)j * mesh.cols + i];
          double flux = lambda * std::fabs(tCell - cond.temperature) / (cellWidthM / 2.0);
          q += flux * edgeLenM;
          length += edgeLenM;
        }
      }
    }

    if (cond.type == "inside") {
      result.insideLengthM += length;
      result.insideU += q;
    } else {
      result.outsideLengthM += length;
      result.outsideU += q;
    }
  }

  result.insideU = result.insideLengthM > kEps ? result.insideU / (result.insideLengthM * deltaT) : 0.0;
  result.outsideU = result.outsideLengthM > kEps ? result.outsideU / (result.outsideLengthM * deltaT) : 0.0;

  result.insideU = applySurfaceResistances(result.insideU);
  result.outsideU = applySurfaceResistances(result.outsideU);

  return result;
}
