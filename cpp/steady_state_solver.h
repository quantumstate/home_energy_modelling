// Iterative refinement of MeshNode::temperature toward the steady-state
// heat-conduction solution, by Gauss-Seidel relaxation over the same
// resistor-network graph used by the initial-temperature heuristic (see
// cpp/initial_temperature.h).
#pragma once

#include <cmath>
#include <vector>

#include "initial_temperature.h"

struct RefineResult {
  int iterations;
  double maxResidual;  // largest |deltaT| in the final sweep, degrees C
};

// Relaxes mesh.nodes[*].temperature toward the steady-state solution. Nodes
// with info.isBoundary[i] are held fixed (Dirichlet); all other nodes are
// updated to the conductance-weighted average of their neighbours' current
// temperatures. Sweeps the whole mesh, alternating forward and backward node
// order each pass, until the largest change in a pass is below `tolerance`
// or `maxIterations` passes have run.
inline RefineResult refineTemperatures(Mesh& mesh,
                                        const initial_temperature_detail::BoundaryInfo& info,
                                        int maxIterations = 2000,
                                        double tolerance = 1e-3) {
  using namespace initial_temperature_detail;

  int numNodes = (int)mesh.nodes.size();
  RefineResult result{0, 0.0};
  if (numNodes == 0) return result;

  for (int pass = 0; pass < maxIterations; ++pass) {
    double maxDelta = 0.0;
    bool forward = (pass % 2) == 0;
    for (int k = 0; k < numNodes; ++k) {
      int idx = forward ? k : numNodes - 1 - k;
      if (idx < (int)info.isBoundary.size() && info.isBoundary[idx]) continue;

      double sumG = 0.0;
      double sumGT = 0.0;
      forEachConnection(mesh, idx, [&](int nb, double resistance) {
        double g = 1.0 / (nodeDistance(mesh, idx, nb) * resistance);
        sumG += g;
        sumGT += g * mesh.nodes[nb].temperature;
      });
      if (sumG <= 0) continue;

      double newT = sumGT / sumG;
      maxDelta = std::max(maxDelta, std::fabs(newT - mesh.nodes[idx].temperature));
      mesh.nodes[idx].temperature = newT;
    }

    result.iterations = pass + 1;
    result.maxResidual = maxDelta;
    if (maxDelta < tolerance) break;
  }

  return result;
}
