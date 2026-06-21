// Transient (backward-Euler) heat conduction solver for the ground mesh.
//
// Uses a 4-neighbour finite-volume stencil (axis-only, no diagonals) to avoid
// skewing effective conductivity on the non-uniform graded grid.
// The backward-Euler update for each interior node is:
//
//   T_i^{n+1} = (C_i/dt * T_i^n  +  Σ_j G_ij * T_j^{n+1})
//               / (C_i/dt  +  Σ_j G_ij)
//
// which is the standard Gauss-Seidel update with a thermal-mass term added
// to both numerator and denominator. Unconditionally stable for any Δt.
#pragma once

#include <algorithm>
#include <cmath>
#include <cstring>
#include <functional>
#include <string>
#include <vector>

#include "graded_mesh.h"

namespace transient_solver_detail {

// Lambda of cell (ci, cj), or 0 outside the mesh.
inline double cellLambda(const GroundMesh& mesh, int ci, int cj) {
  if (ci < 0 || ci >= mesh.cols || cj < 0 || cj >= mesh.rows) return 0.0;
  return mesh.lambda[cj * mesh.cols + ci];
}

// Harmonic-mean resistance of an edge bordered by cell lambdas a and b.
// Returns -1 if neither side has material.
inline double edgeResistance(double a, double b) {
  if (a > 0.0 && b > 0.0) return 1.0 / ((a + b) * 0.5);
  if (a > 0.0) return 1.0 / a;
  if (b > 0.0) return 1.0 / b;
  return -1.0;
}

// Euclidean distance between nodes (i,j) and a neighbour along an axis.
// For axis-aligned neighbours, this is just the spacing between node lines.
inline double axisNodeDist(const GroundMesh& mesh, int i, int j, int ni, int nj) {
  double dx = mesh.nodeXs[ni] - mesh.nodeXs[i];
  double dy = mesh.nodeYs[nj] - mesh.nodeYs[j];
  return std::sqrt(dx * dx + dy * dy);
}

}  // namespace transient_solver_detail

// Calls fn(neighbourNodeIndex, conductance_G) for the 4 axis-aligned neighbours
// of node `nodeIdx`. G = 1 / (nodeDistance * edgeResistance).
// Follows the same logic as forEachConnection in initial_temperature.h but
// restricted to 4 neighbours and adapted for GroundMesh.
template <typename F>
inline void forEachAxisConnection(const GroundMesh& mesh, int nodeIdx, F&& fn) {
  using namespace transient_solver_detail;
  const int nodeCols = mesh.cols + 1;
  const int i = nodeIdx % nodeCols;
  const int j = nodeIdx / nodeCols;

  // Right (i+1, j)
  if (i + 1 <= mesh.cols) {
    double r = edgeResistance(cellLambda(mesh, i, j - 1), cellLambda(mesh, i, j));
    if (r > 0.0) {
      double dist = mesh.nodeXs[i + 1] - mesh.nodeXs[i];
      if (dist > 1e-12) fn(j * nodeCols + (i + 1), 1.0 / (dist * r));
    }
  }
  // Left (i-1, j)
  if (i - 1 >= 0) {
    double r = edgeResistance(cellLambda(mesh, i - 1, j - 1), cellLambda(mesh, i - 1, j));
    if (r > 0.0) {
      double dist = mesh.nodeXs[i] - mesh.nodeXs[i - 1];
      if (dist > 1e-12) fn(j * nodeCols + (i - 1), 1.0 / (dist * r));
    }
  }
  // Down (i, j+1)
  if (j + 1 <= mesh.rows) {
    double r = edgeResistance(cellLambda(mesh, i - 1, j), cellLambda(mesh, i, j));
    if (r > 0.0) {
      double dist = mesh.nodeYs[j + 1] - mesh.nodeYs[j];
      if (dist > 1e-12) fn((j + 1) * nodeCols + i, 1.0 / (dist * r));
    }
  }
  // Up (i, j-1)
  if (j - 1 >= 0) {
    double r = edgeResistance(cellLambda(mesh, i - 1, j - 1), cellLambda(mesh, i, j - 1));
    if (r > 0.0) {
      double dist = mesh.nodeYs[j] - mesh.nodeYs[j - 1];
      if (dist > 1e-12) fn((j - 1) * nodeCols + i, 1.0 / (dist * r));
    }
  }
}

// ── Node heat capacities ───────────────────────────────────────────────────

// Computes the lumped heat capacity C_i (J/K per metre depth) for each node,
// by accumulating one quarter of each surrounding cell's area × rhoC.
inline std::vector<double> computeNodeCapacities(const GroundMesh& mesh) {
  const int nodeCols = mesh.cols + 1;
  const int numNodes = nodeCols * (mesh.rows + 1);
  std::vector<double> C(numNodes, 0.0);

  for (int cj = 0; cj < mesh.rows; ++cj) {
    for (int ci = 0; ci < mesh.cols; ++ci) {
      const double rc = mesh.rhoC[cj * mesh.cols + ci];
      if (rc <= 0.0) continue;
      // Cell area in m² (grid coordinates are in mm → ÷1000 each dimension).
      const double dx = (mesh.nodeXs[ci + 1] - mesh.nodeXs[ci]) * 1e-3;
      const double dy = (mesh.nodeYs[cj + 1] - mesh.nodeYs[cj]) * 1e-3;
      const double quarterArea = dx * dy * 0.25;
      const double contrib = rc * quarterArea;
      // Four corner nodes of this cell.
      C[ cj      * nodeCols +  ci     ] += contrib;
      C[ cj      * nodeCols + (ci + 1)] += contrib;
      C[(cj + 1) * nodeCols +  ci     ] += contrib;
      C[(cj + 1) * nodeCols + (ci + 1)] += contrib;
    }
  }
  return C;
}

// ── Boundary classification ────────────────────────────────────────────────

struct GroundBoundaryInfo {
  std::vector<bool>   isInside;   // fixed indoor temp
  std::vector<bool>   isSurface;  // fixed EPW surface temp (updated per step)
  std::vector<bool>   isBoundary; // isInside || isSurface
  std::vector<double> insideTemp; // temperature to hold for inside nodes
};

// Marks nodes that lie on "inside" or "surface" edges of the given layers.
inline GroundBoundaryInfo classifyGroundBoundaryNodes(
    const GroundMesh& mesh,
    const std::vector<GroundLayer>& layers,
    const std::vector<GroundEdgeCondition>& conditions,
    double indoorTemp) {
  const int nodeCols = mesh.cols + 1;
  const int numNodes = nodeCols * (mesh.rows + 1);
  const double eps   = 1e-6;

  GroundBoundaryInfo info;
  info.isInside.assign(numNodes, false);
  info.isSurface.assign(numNodes, false);
  info.isBoundary.assign(numNodes, false);
  info.insideTemp.assign(numNodes, 0.0);

  for (const auto& cond : conditions) {
    if (cond.type == "adiabatic") continue;
    if (cond.layerIndex < 0 || cond.layerIndex >= (int)layers.size()) continue;
    const GroundLayer& layer = layers[cond.layerIndex];

    double x1, y1, x2, y2;
    if (cond.side == "top") {
      x1 = layer.x; y1 = layer.y; x2 = layer.x + layer.w; y2 = layer.y;
    } else if (cond.side == "bottom") {
      x1 = layer.x; y1 = layer.y + layer.h; x2 = layer.x + layer.w; y2 = layer.y + layer.h;
    } else if (cond.side == "left") {
      x1 = layer.x; y1 = layer.y; x2 = layer.x; y2 = layer.y + layer.h;
    } else {  // right
      x1 = layer.x + layer.w; y1 = layer.y; x2 = layer.x + layer.w; y2 = layer.y + layer.h;
    }

    bool horizontal = std::abs(y1 - y2) < eps;
    double lo    = horizontal ? std::min(x1, x2) : std::min(y1, y2);
    double hi    = horizontal ? std::max(x1, x2) : std::max(y1, y2);
    double fixed = horizontal ? y1 : x1;

    // Snap the edge's perpendicular coordinate to the nearest mesh node line.
    // The mesh builder may merge near-coincident breakpoints, so an edge
    // coordinate is not guaranteed to land exactly on a node — without this
    // snap the exact-match loop below would silently stamp no nodes and the
    // boundary condition would be lost.
    {
      const std::vector<double>& axis = horizontal ? mesh.nodeYs : mesh.nodeXs;
      double best = fixed; double bestD = 1e18;
      for (double a : axis) {
        double d = std::abs(a - fixed);
        if (d < bestD) { bestD = d; best = a; }
      }
      fixed = best;
    }

    for (int nj = 0; nj <= mesh.rows; ++nj) {
      for (int ni = 0; ni <= mesh.cols; ++ni) {
        double nodeX = mesh.nodeXs[ni];
        double nodeY = mesh.nodeYs[nj];
        double along = horizontal ? nodeX : nodeY;
        double cross = horizontal ? nodeY : nodeX;

        if (std::abs(cross - fixed) > eps) continue;
        if (along < lo - eps || along > hi + eps) continue;

        // Only mark nodes that are actually on the material boundary
        // (at least one adjacent cell has material).
        auto cl = [&](int ci, int cj) -> double {
          if (ci < 0 || ci >= mesh.cols || cj < 0 || cj >= mesh.rows) return 0.0;
          return mesh.lambda[cj * mesh.cols + ci];
        };
        bool hasMaterial = cl(ni-1,nj-1)>0 || cl(ni,nj-1)>0 || cl(ni-1,nj)>0 || cl(ni,nj)>0;
        if (!hasMaterial) continue;

        // Don't let a lower-priority layer's condition override the area
        // belonging to a higher-priority layer (e.g. the ground-box "surface"
        // edge must not stamp nodes that sit inside the concrete slab).
        bool coveredByHigher = false;
        for (const auto& other : layers) {
          if (other.priority <= layer.priority) continue;
          if (nodeX >= other.x - eps && nodeX <= other.x + other.w + eps &&
              nodeY >= other.y - eps && nodeY <= other.y + other.h + eps) {
            coveredByHigher = true;
            break;
          }
        }
        if (coveredByHigher) continue;

        int idx = nj * nodeCols + ni;
        if (cond.type == "inside") {
          info.isInside[idx]   = true;
          info.isBoundary[idx] = true;
          info.insideTemp[idx] = indoorTemp;
        } else if (cond.type == "surface") {
          info.isSurface[idx]  = true;
          info.isBoundary[idx] = true;
        }
      }
    }
  }
  return info;
}

// ── Kusuda–Achenbach initialisation ───────────────────────────────────────

// Initialises node temperatures with the 1D periodic Kusuda–Achenbach ground
// profile so deep nodes start near periodic steady state, collapsing spin-up.
//
// T(z, t) = T_mean - A * exp(-z*d) * cos(2π/P * (t - t0) - z*d)
// where d = sqrt(π/(α·P)), α = lambda/rhoC, P = 1 year.
//
// `surfaceY_mm`: y-coordinate (mm) of the ground surface (top of the ground box).
// `startDayOfYear`: day number (0-based) at which the simulation begins.
// `annualMeanTemp`: mean air temperature over the year (°C).
// `annualAmplitude`: half the peak-to-peak swing (°C).
// `coldestDay`: day of year (0-based) with the minimum temperature.
// `groundDiffusivity`: α in m²/s for the bulk ground material.
inline void initializeKusuda(GroundMesh& mesh,
                              double surfaceY_mm,
                              double startDayOfYear,
                              double annualMeanTemp,
                              double annualAmplitude,
                              double coldestDay,
                              double groundDiffusivity) {
  const double P  = 365.25 * 86400.0;  // period (s)
  const double pi = 3.14159265358979323846;
  const double d  = std::sqrt(pi / (groundDiffusivity * P));  // 1/m

  const int nodeCols = mesh.cols + 1;
  const double t0 = startDayOfYear * 86400.0;  // start time (s)
  const double tc = coldestDay     * 86400.0;  // time of minimum surface temp (s)

  for (int nj = 0; nj <= mesh.rows; ++nj) {
    double z = (mesh.nodeYs[nj] - surfaceY_mm) * 1e-3;  // depth below surface (m)
    if (z < 0.0) z = 0.0;  // above-ground nodes → surface temperature
    double decay  = std::exp(-z * d);
    double phase  = 2.0 * pi / P * (t0 - tc) - z * d;
    double T      = annualMeanTemp - annualAmplitude * decay * std::cos(phase);
    for (int ni = 0; ni <= mesh.cols; ++ni) {
      mesh.temperatures[nj * nodeCols + ni] = T;
    }
  }
}

// ── One backward-Euler timestep ────────────────────────────────────────────

struct StepResult {
  int    iterations;
  double maxResidual;  // max |ΔT| across all interior nodes in the last sweep
};

// Performs one implicit timestep on `mesh.temperatures` using Gauss-Seidel
// with a thermal-mass term. Boundary nodes are held fixed:
//   – nodes in `info.isInside`  are clamped to their indoor temperature.
//   – nodes in `info.isSurface` are clamped to `surfaceTemp` (current step).
// `capacities` is from computeNodeCapacities.
// `dt` is in seconds; distances are in mm, conductivities in W/m·K.
// The conductance G is in W/K·m (per unit depth), distance in mm so we must
// convert: G = 1 / (dist_mm * 1e-3 * resistance_mK/W) = lambda / dist_m.
inline StepResult stepBackwardEuler(GroundMesh& mesh,
                                     const GroundBoundaryInfo& info,
                                     const std::vector<double>& capacities,
                                     double surfaceTemp,
                                     double dt,
                                     int maxIter = 30,
                                     double tol  = 1e-3) {
  const int numNodes = (mesh.cols + 1) * (mesh.rows + 1);

  // Apply Dirichlet boundary temperatures before the sweep.
  // Surface is applied first; inside overwrites it so "inside" always wins
  // when both flags are set on the same node (e.g. slab floor collinear with
  // the ground-box top edge that carries a surface condition).
  for (int idx = 0; idx < numNodes; ++idx) {
    if (info.isSurface[idx]) mesh.temperatures[idx] = surfaceTemp;
    if (info.isInside[idx])  mesh.temperatures[idx] = info.insideTemp[idx];
  }

  // Gauss-Seidel sweeps.
  StepResult res{0, 0.0};
  for (int pass = 0; pass < maxIter; ++pass) {
    double maxDelta = 0.0;
    bool forward = (pass % 2 == 0);
    for (int k = 0; k < numNodes; ++k) {
      int idx = forward ? k : numNodes - 1 - k;
      if (info.isBoundary[idx]) continue;

      // Thermal-mass term C_i / dt adds to the diagonal.
      double ci_dt = (dt > 1e-12) ? capacities[idx] / dt : 0.0;
      double sumG  = ci_dt;
      double sumGT = ci_dt * mesh.temperatures[idx];

      // Note: forEachAxisConnection gives G in units of W/(K·mm).
      // We need W/(K·m), so multiply distance factor. Actually, edgeResistance
      // returns 1/lambda_eff in m·K/W and dist is in mm: G = 1/(dist_mm * res).
      // To convert G to W/(K·m): G_SI = G * 1e3 (since dist was in mm not m).
      // The factor cancels in the ratio T = sumGT/sumG, so we keep raw G.
      forEachAxisConnection(mesh, idx, [&](int nb, double G) {
        sumG  += G;
        sumGT += G * mesh.temperatures[nb];
      });

      if (sumG <= 0.0) continue;
      double newT  = sumGT / sumG;
      double delta = std::fabs(newT - mesh.temperatures[idx]);
      if (delta > maxDelta) maxDelta = delta;
      mesh.temperatures[idx] = newT;
    }
    res.iterations  = pass + 1;
    res.maxResidual = maxDelta;
    if (maxDelta < tol) break;
  }

  // Re-clamp boundary nodes after the sweep (GS may have drifted them).
  for (int idx = 0; idx < numNodes; ++idx) {
    if (info.isSurface[idx]) mesh.temperatures[idx] = surfaceTemp;
    if (info.isInside[idx])  mesh.temperatures[idx] = info.insideTemp[idx];
  }

  return res;
}
