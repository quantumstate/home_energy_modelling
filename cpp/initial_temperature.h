// Heuristic initial-temperature fill for the thermal solver's mesh.
//
// Given a mesh built by buildMesh() and the boundary conditions, this fills
// MeshNode::temperature with a fast distance-weighted-by-thermal-resistance
// estimate, plus MeshNode::groupId and MeshNode::boundaryDistance for
// debugging. See cpp/thermal_solver.cpp for the data types this depends on
// (Mesh, MeshNode, MeshElement, Layer, EdgeCondition).
#pragma once

#include <algorithm>
#include <cmath>
#include <functional>
#include <limits>
#include <queue>
#include <vector>

namespace initial_temperature_detail {

constexpr double kEps = 1e-6;

inline int nodeIndex(const Mesh& mesh, int i, int j) {
  return j * (mesh.cols + 1) + i;
}

// Conductivity of element (ei, ej), or 0 if out of range (no material).
inline double elementLambda(const Mesh& mesh, int ei, int ej) {
  if (ei < 0 || ei >= mesh.cols || ej < 0 || ej >= mesh.rows) return 0.0;
  return mesh.elements[ej * mesh.cols + ei].lambda;
}

// A node is on the domain boundary if, among the up to 4 elements that share
// it, at least one has material and at least one doesn't.
inline bool isBoundaryNode(const Mesh& mesh, int i, int j) {
  double l00 = elementLambda(mesh, i - 1, j - 1);
  double l10 = elementLambda(mesh, i, j - 1);
  double l01 = elementLambda(mesh, i - 1, j);
  double l11 = elementLambda(mesh, i, j);
  bool hasMaterial = l00 > 0 || l10 > 0 || l01 > 0 || l11 > 0;
  bool hasVoid = l00 <= 0 || l10 <= 0 || l01 <= 0 || l11 <= 0;
  return hasMaterial && hasVoid;
}

// True if the horizontal edge between nodes (i,j) and (i+1,j) separates
// material from void (i.e. it's on the domain boundary).
inline bool isHorizontalBoundaryEdge(const Mesh& mesh, int i, int j) {
  double above = elementLambda(mesh, i, j - 1);
  double below = elementLambda(mesh, i, j);
  return (above > 0) != (below > 0);
}

// True if the vertical edge between nodes (i,j) and (i,j+1) separates
// material from void (i.e. it's on the domain boundary).
inline bool isVerticalBoundaryEdge(const Mesh& mesh, int i, int j) {
  double left = elementLambda(mesh, i - 1, j);
  double right = elementLambda(mesh, i, j);
  return (left > 0) != (right > 0);
}

// Resistance (1/lambda) of an edge bordered by elements with conductivities
// `a` and `b` (either may be 0, meaning no material on that side). Returns
// -1 if neither side has material (edge isn't part of the domain).
inline double edgeResistance(double a, double b) {
  if (a > 0 && b > 0) return 1.0 / ((a + b) / 2.0);
  if (a > 0) return 1.0 / a;
  if (b > 0) return 1.0 / b;
  return -1.0;
}

// Invokes callback(neighborNodeIndex, resistance) for every node connected
// to `idx` by a mesh edge (axis-aligned or diagonal) that runs through at
// least some material.
template <typename F>
inline void forEachConnection(const Mesh& mesh, int idx, F&& callback) {
  int nodeCols = mesh.cols + 1;
  int i = idx % nodeCols;
  int j = idx / nodeCols;

  if (i + 1 <= mesh.cols) {
    double r = edgeResistance(elementLambda(mesh, i, j - 1), elementLambda(mesh, i, j));
    if (r > 0) callback(nodeIndex(mesh, i + 1, j), r);
  }
  if (i - 1 >= 0) {
    double r = edgeResistance(elementLambda(mesh, i - 1, j - 1), elementLambda(mesh, i - 1, j));
    if (r > 0) callback(nodeIndex(mesh, i - 1, j), r);
  }
  if (j + 1 <= mesh.rows) {
    double r = edgeResistance(elementLambda(mesh, i - 1, j), elementLambda(mesh, i, j));
    if (r > 0) callback(nodeIndex(mesh, i, j + 1), r);
  }
  if (j - 1 >= 0) {
    double r = edgeResistance(elementLambda(mesh, i - 1, j - 1), elementLambda(mesh, i, j - 1));
    if (r > 0) callback(nodeIndex(mesh, i, j - 1), r);
  }
  // Diagonal n0-n2 of element (i,j): (i,j) <-> (i+1,j+1).
  if (i + 1 <= mesh.cols && j + 1 <= mesh.rows) {
    double lam = elementLambda(mesh, i, j);
    if (lam > 0) callback(nodeIndex(mesh, i + 1, j + 1), 1.0 / lam);
  }
  if (i - 1 >= 0 && j - 1 >= 0) {
    double lam = elementLambda(mesh, i - 1, j - 1);
    if (lam > 0) callback(nodeIndex(mesh, i - 1, j - 1), 1.0 / lam);
  }
  // Diagonal n1-n3 of element (i-1,j): (i,j) <-> (i-1,j+1).
  if (i - 1 >= 0 && j + 1 <= mesh.rows) {
    double lam = elementLambda(mesh, i - 1, j);
    if (lam > 0) callback(nodeIndex(mesh, i - 1, j + 1), 1.0 / lam);
  }
  if (i + 1 <= mesh.cols && j - 1 >= 0) {
    double lam = elementLambda(mesh, i, j - 1);
    if (lam > 0) callback(nodeIndex(mesh, i + 1, j - 1), 1.0 / lam);
  }
}

inline double nodeDistance(const Mesh& mesh, int a, int b) {
  double dx = mesh.nodes[a].x - mesh.nodes[b].x;
  double dy = mesh.nodes[a].y - mesh.nodes[b].y;
  return std::sqrt(dx * dx + dy * dy);
}

// Step 1: per-node temperature for nodes lying on a non-adiabatic boundary
// segment, and whether each node is such a boundary node at all.
struct BoundaryInfo {
  std::vector<double> temp;
  std::vector<bool> isBoundary;
};

inline BoundaryInfo classifyBoundaryNodes(const Mesh& mesh,
                                           const std::vector<Layer>& layers,
                                           const std::vector<EdgeCondition>& conditions) {
  int nodeCols = mesh.cols + 1;
  int nodeRows = mesh.rows + 1;
  int numNodes = nodeCols * nodeRows;

  BoundaryInfo info;
  info.temp.assign(numNodes, std::numeric_limits<double>::quiet_NaN());
  info.isBoundary.assign(numNodes, false);
  std::vector<double> sumT(numNodes, 0.0);
  std::vector<int> countT(numNodes, 0);

  for (const auto& cond : conditions) {
    if (cond.type == "adiabatic") continue;
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

    for (int j = 0; j < nodeRows; ++j) {
      for (int i = 0; i < nodeCols; ++i) {
        int idx = nodeIndex(mesh, i, j);
        const MeshNode& node = mesh.nodes[idx];
        double along = horizontal ? node.x : node.y;
        double cross = horizontal ? node.y : node.x;
        if (std::abs(cross - fixed) > kEps) continue;
        if (along < lo - kEps || along > hi + kEps) continue;
        if (!isBoundaryNode(mesh, i, j)) continue;
        sumT[idx] += cond.temperature;
        countT[idx] += 1;
      }
    }
  }

  for (int idx = 0; idx < numNodes; ++idx) {
    if (countT[idx] > 0) {
      info.temp[idx] = sumT[idx] / countT[idx];
      info.isBoundary[idx] = true;
    }
  }
  return info;
}

// Step 2: contiguous chains of boundary nodes, connected along domain
// boundary edges.
struct Chain {
  std::vector<int> nodes;
  bool closed;
};

inline std::vector<int> boundaryNeighbors(const Mesh& mesh, const BoundaryInfo& info, int idx) {
  int nodeCols = mesh.cols + 1;
  int i = idx % nodeCols;
  int j = idx / nodeCols;
  std::vector<int> result;
  if (i + 1 <= mesh.cols && info.isBoundary[nodeIndex(mesh, i + 1, j)] &&
      isHorizontalBoundaryEdge(mesh, i, j)) {
    result.push_back(nodeIndex(mesh, i + 1, j));
  }
  if (i - 1 >= 0 && info.isBoundary[nodeIndex(mesh, i - 1, j)] &&
      isHorizontalBoundaryEdge(mesh, i - 1, j)) {
    result.push_back(nodeIndex(mesh, i - 1, j));
  }
  if (j + 1 <= mesh.rows && info.isBoundary[nodeIndex(mesh, i, j + 1)] &&
      isVerticalBoundaryEdge(mesh, i, j)) {
    result.push_back(nodeIndex(mesh, i, j + 1));
  }
  if (j - 1 >= 0 && info.isBoundary[nodeIndex(mesh, i, j - 1)] &&
      isVerticalBoundaryEdge(mesh, i, j - 1)) {
    result.push_back(nodeIndex(mesh, i, j - 1));
  }
  return result;
}

inline std::vector<Chain> findBoundaryChains(const Mesh& mesh, const BoundaryInfo& info) {
  int numNodes = (int)info.isBoundary.size();
  std::vector<bool> visited(numNodes, false);
  std::vector<Chain> chains;

  // First pass: open chains, starting from endpoints (degree <= 1).
  for (int idx = 0; idx < numNodes; ++idx) {
    if (!info.isBoundary[idx] || visited[idx]) continue;
    if (boundaryNeighbors(mesh, info, idx).size() >= 2) continue;

    Chain chain;
    chain.closed = false;
    int prev = -1;
    int cur = idx;
    while (true) {
      chain.nodes.push_back(cur);
      visited[cur] = true;
      auto nbrs = boundaryNeighbors(mesh, info, cur);
      int next = -1;
      for (int n : nbrs) {
        if (n != prev) { next = n; break; }
      }
      if (next == -1 || visited[next]) break;
      prev = cur;
      cur = next;
    }
    chains.push_back(std::move(chain));
  }

  // Second pass: remaining nodes form closed loops.
  for (int idx = 0; idx < numNodes; ++idx) {
    if (!info.isBoundary[idx] || visited[idx]) continue;

    Chain chain;
    chain.closed = true;
    int start = idx;
    int prev = -1;
    int cur = start;
    while (true) {
      chain.nodes.push_back(cur);
      visited[cur] = true;
      auto nbrs = boundaryNeighbors(mesh, info, cur);
      int next = -1;
      for (int n : nbrs) {
        if (n != prev) { next = n; break; }
      }
      if (next == -1 || next == start) break;
      prev = cur;
      cur = next;
    }
    chains.push_back(std::move(chain));
  }

  return chains;
}

// Step 3: true if every boundary node has the same temperature (within
// kEps); writes that value to `outTemp`.
inline bool allSameTemperature(const BoundaryInfo& info, double& outTemp) {
  bool found = false;
  for (size_t idx = 0; idx < info.isBoundary.size(); ++idx) {
    if (!info.isBoundary[idx]) continue;
    if (!found) {
      outTemp = info.temp[idx];
      found = true;
    } else if (std::abs(info.temp[idx] - outTemp) > kEps) {
      return false;
    }
  }
  return found;
}

// Step 4: per-node group id (only meaningful for boundary nodes; -1 for
// everything else).
inline std::vector<int> assignGroupIds(const BoundaryInfo& info, const std::vector<Chain>& chains) {
  std::vector<int> group(info.isBoundary.size(), -1);

  if (chains.size() >= 2) {
    for (size_t c = 0; c < chains.size(); ++c) {
      for (int idx : chains[c].nodes) group[idx] = (int)c;
    }
    return group;
  }

  const Chain& chain = chains[0];
  int n = (int)chain.nodes.size();
  int hotPos = 0, coldPos = 0;
  for (int p = 1; p < n; ++p) {
    if (info.temp[chain.nodes[p]] > info.temp[chain.nodes[hotPos]]) hotPos = p;
    if (info.temp[chain.nodes[p]] < info.temp[chain.nodes[coldPos]]) coldPos = p;
  }

  if (!chain.closed) {
    int mid = (hotPos + coldPos) / 2;
    for (int p = 0; p < n; ++p) group[chain.nodes[p]] = (p <= mid) ? 0 : 1;
  } else {
    int lo = std::min(hotPos, coldPos);
    int hi = std::max(hotPos, coldPos);
    int mid1 = (lo + hi) / 2;
    int mid2 = ((hi + (lo + n)) / 2) % n;
    for (int p = 0; p < n; ++p) {
      bool inFirstArc = (mid1 <= mid2) ? (p > mid1 && p <= mid2) : (p > mid1 || p <= mid2);
      group[chain.nodes[p]] = inFirstArc ? 0 : 1;
    }
  }
  return group;
}

// Step 5: multi-source Dijkstra from every boundary node, weighted by
// Euclidean distance times thermal resistance.
struct PathResult {
  std::vector<double> dist;
  std::vector<int> prev;
  std::vector<int> group;
};

inline PathResult computeShortestPaths(const Mesh& mesh, const BoundaryInfo& info,
                                        const std::vector<int>& initGroup) {
  int numNodes = (int)mesh.nodes.size();
  const double kInf = std::numeric_limits<double>::infinity();

  PathResult result;
  result.dist.assign(numNodes, kInf);
  result.prev.assign(numNodes, -1);
  result.group = initGroup;

  using QItem = std::pair<double, int>;
  std::priority_queue<QItem, std::vector<QItem>, std::greater<QItem>> pq;

  for (int idx = 0; idx < numNodes; ++idx) {
    if (info.isBoundary[idx]) {
      result.dist[idx] = 0.0;
      pq.push({0.0, idx});
    }
  }

  while (!pq.empty()) {
    double d = pq.top().first;
    int u = pq.top().second;
    pq.pop();
    if (d > result.dist[u] + kEps) continue;

    forEachConnection(mesh, u, [&](int v, double resistance) {
      double w = nodeDistance(mesh, u, v) * resistance;
      double nd = d + w;
      if (nd < result.dist[v] - kEps) {
        result.dist[v] = nd;
        result.prev[v] = u;
        result.group[v] = result.group[u];
        pq.push({nd, v});
      }
    });
  }

  return result;
}

inline std::vector<int> reconstructPath(const PathResult& pr, int node) {
  std::vector<int> path;
  for (int cur = node; cur != -1; cur = pr.prev[cur]) path.push_back(cur);
  std::reverse(path.begin(), path.end());
  return path;
}

inline void applyTemperature(int node, double t, std::vector<double>& temperature, std::vector<bool>& filled) {
  if (filled[node]) {
    temperature[node] = (temperature[node] + t) / 2.0;
  } else {
    temperature[node] = t;
    filled[node] = true;
  }
}

// Steps 6/7: solve the 1D heat equation along the path
// sourceA -> ... -> A -> B -> ... -> sourceB, where A and B are adjacent
// nodes whose shortest paths lead to different boundary groups.
inline void solveInterfacePath(const PathResult& pr, const BoundaryInfo& info, int A, int B, double weightAB,
                                std::vector<double>& temperature, std::vector<bool>& filled) {
  double total = pr.dist[A] + weightAB + pr.dist[B];
  if (total < kEps) return;

  std::vector<int> pathA = reconstructPath(pr, A);  // sourceA .. A
  std::vector<int> pathB = reconstructPath(pr, B);  // sourceB .. B
  double tA = info.temp[pathA.front()];
  double tB = info.temp[pathB.front()];

  for (int node : pathA) {
    double s = pr.dist[node] / total;
    applyTemperature(node, tA + s * (tB - tA), temperature, filled);
  }
  for (int node : pathB) {
    double s = (total - pr.dist[node]) / total;
    applyTemperature(node, tA + s * (tB - tA), temperature, filled);
  }
}

// Step 8: fill nodes not touched by any interface path, working outwards
// from the deepest interior nodes using the average temperature of their
// already-filled neighbours as the far boundary condition.
inline void fillRemainingNodes(const Mesh& mesh, const PathResult& pr, const BoundaryInfo& info,
                                std::vector<double>& temperature, std::vector<bool>& filled) {
  int numNodes = (int)temperature.size();
  std::vector<int> pending;
  for (int idx = 0; idx < numNodes; ++idx) {
    if (!filled[idx] && std::isfinite(pr.dist[idx])) pending.push_back(idx);
  }
  std::sort(pending.begin(), pending.end(),
            [&](int a, int b) { return pr.dist[a] > pr.dist[b]; });

  int maxPasses = 2 * (mesh.cols + mesh.rows) + 2;
  for (int pass = 0; pass < maxPasses; ++pass) {
    bool progressed = false;
    for (int idx : pending) {
      if (filled[idx]) continue;

      double sum = 0.0;
      int count = 0;
      forEachConnection(mesh, idx, [&](int nb, double /*resistance*/) {
        if (filled[nb]) {
          sum += temperature[nb];
          count += 1;
        }
      });
      if (count == 0) continue;
      double avg = sum / count;

      double total = pr.dist[idx];
      if (total < kEps) {
        applyTemperature(idx, avg, temperature, filled);
        progressed = true;
        continue;
      }

      std::vector<int> path = reconstructPath(pr, idx);  // source .. idx
      double tSource = info.temp[path.front()];
      for (int node : path) {
        double s = pr.dist[node] / total;  // 0 at source, 1 at idx
        applyTemperature(node, tSource + s * (avg - tSource), temperature, filled);
      }
      progressed = true;
    }
    if (!progressed) break;
  }
}

}  // namespace initial_temperature_detail

// Fills mesh.nodes[*].temperature with a heuristic initial guess, and
// mesh.nodes[*].groupId / boundaryDistance with debug information about the
// nearest non-adiabatic boundary.
inline void computeInitialTemperatures(Mesh& mesh, const std::vector<Layer>& layers,
                                        const std::vector<EdgeCondition>& conditions) {
  using namespace initial_temperature_detail;

  int numNodes = (int)mesh.nodes.size();
  if (numNodes == 0) return;

  for (auto& node : mesh.nodes) {
    node.temperature = 0.0;
    node.groupId = -1;
    node.boundaryDistance = 0.0;
  }

  BoundaryInfo info = classifyBoundaryNodes(mesh, layers, conditions);

  bool anyBoundary = false;
  for (bool b : info.isBoundary) {
    if (b) { anyBoundary = true; break; }
  }
  if (!anyBoundary) return;

  double uniformTemp;
  if (allSameTemperature(info, uniformTemp)) {
    for (auto& node : mesh.nodes) node.temperature = uniformTemp;
    for (int idx = 0; idx < numNodes; ++idx) {
      if (info.isBoundary[idx]) mesh.nodes[idx].groupId = 0;
    }
    return;
  }

  std::vector<Chain> chains = findBoundaryChains(mesh, info);
  std::vector<int> initGroup = assignGroupIds(info, chains);
  PathResult pr = computeShortestPaths(mesh, info, initGroup);

  for (int idx = 0; idx < numNodes; ++idx) {
    mesh.nodes[idx].groupId = pr.group[idx];
    mesh.nodes[idx].boundaryDistance = std::isfinite(pr.dist[idx]) ? pr.dist[idx] : 0.0;
  }

  std::vector<double> temperature(numNodes, 0.0);
  std::vector<bool> filled(numNodes, false);
  for (int idx = 0; idx < numNodes; ++idx) {
    if (info.isBoundary[idx]) {
      temperature[idx] = info.temp[idx];
      filled[idx] = true;
    }
  }

  // Steps 6/7: solve along paths crossing from one boundary group to another.
  for (int idx = 0; idx < numNodes; ++idx) {
    if (!std::isfinite(pr.dist[idx])) continue;
    forEachConnection(mesh, idx, [&](int nb, double resistance) {
      if (nb <= idx) return;  // each connection considered once
      if (!std::isfinite(pr.dist[nb])) return;
      if (pr.group[idx] < 0 || pr.group[nb] < 0 || pr.group[idx] == pr.group[nb]) return;
      double w = nodeDistance(mesh, idx, nb) * resistance;
      solveInterfacePath(pr, info, idx, nb, w, temperature, filled);
    });
  }

  // Step 8: fill everything else.
  fillRemainingNodes(mesh, pr, info, temperature, filled);

  for (int idx = 0; idx < numNodes; ++idx) mesh.nodes[idx].temperature = temperature[idx];
}
