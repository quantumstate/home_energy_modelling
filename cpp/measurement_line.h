// Heat-flux integration across a freely-placed polyline on the ground mesh.
//
// For each timestep, integrates q = -λ ∇T · n̂ along the polyline,
// where n̂ is the unit normal pointing to the LEFT of the polyline direction
// (consistently pointing toward the building interior). The result is
// heat loss in W per metre depth crossing the line.
#pragma once

#include <cmath>
#include <vector>

#include "graded_mesh.h"

namespace measurement_line_detail {

// Finds the cell (ci, cj) that contains world point (x, y) by binary search
// on the sorted node axes. Returns false if (x, y) lies outside the mesh.
inline bool findCell(const GroundMesh& mesh, double x, double y, int& ci, int& cj) {
  // Binary search on x axis.
  const auto& xs = mesh.nodeXs;
  const auto& ys = mesh.nodeYs;
  if (x < xs.front() || x > xs.back()) return false;
  if (y < ys.front() || y > ys.back()) return false;
  auto itX = std::upper_bound(xs.begin(), xs.end(), x);
  if (itX == xs.end()) --itX;
  ci = (int)(itX - xs.begin()) - 1;
  if (ci < 0) ci = 0;
  if (ci >= mesh.cols) ci = mesh.cols - 1;

  auto itY = std::upper_bound(ys.begin(), ys.end(), y);
  if (itY == ys.end()) --itY;
  cj = (int)(itY - ys.begin()) - 1;
  if (cj < 0) cj = 0;
  if (cj >= mesh.rows) cj = mesh.rows - 1;
  return true;
}

// Bilinear temperature gradient (dT/dx, dT/dy) at cell (ci, cj) centre.
// Uses the four corner node temperatures and actual cell dimensions.
inline void cellGradient(const GroundMesh& mesh,
                          int ci, int cj,
                          double& dTdx, double& dTdy) {
  const int nc = mesh.cols + 1;
  // Corner node indices: n0=bottom-left, n1=bottom-right, n2=top-right, n3=top-left
  // In screen coords, j increases downward, so:
  //   n00 = (ci,   cj)   = top-left
  //   n10 = (ci+1, cj)   = top-right
  //   n01 = (ci,   cj+1) = bottom-left
  //   n11 = (ci+1, cj+1) = bottom-right
  double T00 = mesh.temperatures[ cj      * nc +  ci     ];
  double T10 = mesh.temperatures[ cj      * nc + (ci + 1)];
  double T01 = mesh.temperatures[(cj + 1) * nc +  ci     ];
  double T11 = mesh.temperatures[(cj + 1) * nc + (ci + 1)];

  double dx = (mesh.nodeXs[ci + 1] - mesh.nodeXs[ci]) * 1e-3;  // mm → m
  double dy = (mesh.nodeYs[cj + 1] - mesh.nodeYs[cj]) * 1e-3;

  if (dx < 1e-12 || dy < 1e-12) { dTdx = 0.0; dTdy = 0.0; return; }

  // Average gradient over the cell using bilinear interpolation at centre.
  dTdx = ((T10 - T00) + (T11 - T01)) * 0.5 / dx;
  dTdy = ((T01 - T00) + (T11 - T10)) * 0.5 / dy;
}

}  // namespace measurement_line_detail

// Integrates conductive heat flux (W per metre depth) across the polyline.
//
// Sign convention: the LEFT-hand normal of the polyline direction is used.
// If the polyline runs left-to-right (x increasing), the left normal points
// upward (y decreasing), i.e. toward the building. Positive result = heat
// flowing in the direction of the left normal (out of the ground into the
// building or out of the building into the ground depending on orientation).
// For a polyline drawn from left to right under the building, positive =
// heat flowing upward = heat loss from the building to the ground in winter.
inline double integrateLineFlux(const GroundMesh& mesh,
                                 const MeasureLine& line,
                                 double sampleSpacingMm = -1.0) {
  using namespace measurement_line_detail;

  const int nVerts = (int)line.xs.size();
  if (nVerts < 2) return 0.0;

  if (sampleSpacingMm <= 0.0) {
    // Default: half the smallest near-cell spacing visible in the mesh.
    double minDx = 1e9;
    for (size_t i = 0; i + 1 < mesh.nodeXs.size(); ++i)
      minDx = std::min(minDx, mesh.nodeXs[i + 1] - mesh.nodeXs[i]);
    double minDy = 1e9;
    for (size_t j = 0; j + 1 < mesh.nodeYs.size(); ++j)
      minDy = std::min(minDy, mesh.nodeYs[j + 1] - mesh.nodeYs[j]);
    sampleSpacingMm = std::max(1.0, std::min(minDx, minDy) * 0.5);
  }

  double totalFlux = 0.0;  // W/m depth

  for (int v = 0; v + 1 < nVerts; ++v) {
    double ax = line.xs[v],    ay = line.ys[v];
    double bx = line.xs[v+1],  by = line.ys[v+1];
    double segLen = std::hypot(bx - ax, by - ay);
    if (segLen < 1e-9) continue;

    // Unit tangent and left-hand normal.
    double tx = (bx - ax) / segLen;
    double ty = (by - ay) / segLen;
    // Left-hand normal: rotate tangent 90° CCW → (-ty, tx)
    double nx = -ty;
    double ny =  tx;

    // Sample the segment at sampleSpacingMm intervals.
    int nSamples = std::max(1, (int)std::ceil(segLen / sampleSpacingMm));
    double ds = segLen / nSamples * 1e-3;  // sample arc length in m

    for (int s = 0; s < nSamples; ++s) {
      double t  = (s + 0.5) / nSamples;
      double sx = ax + t * (bx - ax);
      double sy = ay + t * (by - ay);

      int ci, cj;
      if (!findCell(mesh, sx, sy, ci, cj)) continue;

      double lam = mesh.lambda[cj * mesh.cols + ci];
      if (lam <= 0.0) continue;  // void cell (outside material domain)

      double dTdx, dTdy;
      cellGradient(mesh, ci, cj, dTdx, dTdy);

      // q = -λ ∇T · n  (W/m² of the cut face, per unit depth = W/m depth per m arc)
      double q = -lam * (dTdx * nx + dTdy * ny);  // W/m²
      totalFlux += q * ds;                          // W/m depth (ds in m)
    }
  }

  return totalFlux;
}
