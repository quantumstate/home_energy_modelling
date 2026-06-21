// Ground slab transient heat solver — compiled to WebAssembly via Emscripten.
//
// Accepts a 2-D cross-section (layers + boundary conditions + measurement line)
// and an hourly/daily surface temperature series from an EPW file. Runs an
// implicit backward-Euler simulation over (spinupYears + 1) years on a graded
// rectangular mesh, then returns 52 weekly temperature snapshots and 12 monthly
// heat-loss totals through the measurement polyline.
//
// Build:  cpp\build_ground.bat   (Windows)
//         cpp/build_ground.sh    (Unix)
// Output: src/wasm/ground_solver.mjs  (+.wasm)

#include <emscripten/bind.h>
#include <algorithm>
#include <cmath>
#include <numeric>
#include <string>
#include <vector>

#include "graded_mesh.h"
#include "transient_solver.h"
#include "measurement_line.h"

// ── Result struct ──────────────────────────────────────────────────────────

struct GroundResult {
  int cols, rows;
  double originX, originY;
  std::vector<double> nodeXs;  // cols+1 x-axis positions (mm)
  std::vector<double> nodeYs;  // rows+1 y-axis positions (mm)
  std::vector<double> lambda;  // cols*rows per-cell conductivity (0 = void)

  // 52 weekly temperature snapshots (each cols*rows cell-average values, row-major).
  // Flattened: weeklyTemps[w * cols * rows + j * cols + i]
  std::vector<double> weeklyTemps;

  std::vector<double> monthlyHeatLossKwh;  // 12 monthly values (kWh/m depth)

  int    totalSteps;
  double periodicityResidual;  // max |ΔT| node between last two year passes
};

// ── Debug mesh result ──────────────────────────────────────────────────────

struct GroundMeshResult {
  int cols, rows;
  double originX, originY;
  std::vector<double> nodeXs;
  std::vector<double> nodeYs;
  std::vector<double> lambda;
};

// ── Helper: cell-average temperature from node temperatures ────────────────

static double cellAvgTemp(const GroundMesh& mesh, int ci, int cj) {
  const int nc = mesh.cols + 1;
  double t = mesh.temperatures[ cj      * nc +  ci     ]
           + mesh.temperatures[ cj      * nc + (ci + 1)]
           + mesh.temperatures[(cj + 1) * nc +  ci     ]
           + mesh.temperatures[(cj + 1) * nc + (ci + 1)];
  return t * 0.25;
}

// ── EPW surface temperature stats ─────────────────────────────────────────

struct EPWStats {
  double mean;
  double amplitude;  // half peak-to-peak
  int    coldestStep;  // index into surfaceTemp of the minimum
};

static EPWStats computeEPWStats(const std::vector<double>& surfaceTemp) {
  if (surfaceTemp.empty()) return {10.0, 5.0, 0};
  double sum = 0, mn = surfaceTemp[0], mx = surfaceTemp[0];
  int coldIdx = 0;
  for (int i = 0; i < (int)surfaceTemp.size(); ++i) {
    sum += surfaceTemp[i];
    if (surfaceTemp[i] < mn) { mn = surfaceTemp[i]; coldIdx = i; }
    if (surfaceTemp[i] > mx) mx = surfaceTemp[i];
  }
  return {sum / surfaceTemp.size(), (mx - mn) * 0.5, coldIdx};
}

// ── Main solve function ────────────────────────────────────────────────────

// Full signature with optional JS progress callback (0–100 integer).
// Call via module.solveGroundWithProgress(... , progressFn).
// module.solveGround(...)  is a backward-compatible wrapper without progress.
GroundResult solveGroundWithProgress(
    const std::vector<GroundLayer>& layers,
    const std::vector<GroundEdgeCondition>& conditions,
    const MeasureLine& line,
    const GroundConfig& config,
    const std::vector<double>& surfaceTemp,  // length stepsPerYear
    emscripten::val onProgress)              // JS function(pct:int) or undefined
{
  GroundResult result;
  result.monthlyHeatLossKwh.assign(12, 0.0);
  result.totalSteps = 0;
  result.periodicityResidual = 0.0;

  if (layers.empty() || surfaceTemp.empty() || config.stepsPerYear <= 0) return result;

  // Collect measurement-line breakpoints for the mesh.
  std::vector<double> lineXs(line.xs.begin(), line.xs.end());
  std::vector<double> lineYs(line.ys.begin(), line.ys.end());

  // Build the graded mesh.
  GroundMesh mesh = buildGroundMesh(layers, config, lineXs, lineYs);
  if (mesh.cols <= 0 || mesh.rows <= 0) return result;

  result.cols    = mesh.cols;
  result.rows    = mesh.rows;
  result.originX = mesh.originX;
  result.originY = mesh.originY;
  result.nodeXs  = mesh.nodeXs;
  result.nodeYs  = mesh.nodeYs;
  result.lambda  = mesh.lambda;

  // Pre-compute node capacities and boundary classification.
  auto capacities = computeNodeCapacities(mesh);
  auto binfo = classifyGroundBoundaryNodes(mesh, layers, conditions, config.indoorTemp);

  // Detect the ground surface y-coordinate (top of the ground-box layer).
  // The ground box has priority 0; its top edge is the surface.
  double surfaceY_mm = 0.0;
  for (const auto& l : layers) {
    if (l.priority == 0) { surfaceY_mm = l.y; break; }
  }

  // Kusuda initialisation.
  EPWStats epwStats = computeEPWStats(surfaceTemp);
  double groundAlpha = 0.0;  // compute from bulk ground properties
  for (const auto& l : layers) {
    if (l.priority == 0 && l.lambda > 0.0 && l.rhoC > 0.0) {
      groundAlpha = l.lambda / l.rhoC;
      break;
    }
  }
  if (groundAlpha <= 0.0) groundAlpha = 5e-7;  // fallback: typical soil

  // coldestDay = coldestStep * dt_days
  double dtDays = config.dtSeconds / 86400.0;
  double coldestDay = epwStats.coldestStep * dtDays;

  initializeKusuda(mesh, surfaceY_mm, 0.0,
                   epwStats.mean, epwStats.amplitude, coldestDay, groundAlpha);

  // Apply initial Dirichlet conditions so boundary nodes start correct.
  {
    const int numNodes = (mesh.cols + 1) * (mesh.rows + 1);
    for (int idx = 0; idx < numNodes; ++idx) {
      if (binfo.isInside[idx])  mesh.temperatures[idx] = config.indoorTemp;
      if (binfo.isSurface[idx]) mesh.temperatures[idx] = surfaceTemp[0];
    }
  }

  // Steady-state pre-solve. The Kusuda profile assumes undisturbed ground
  // everywhere; under a heated slab the real mean field is far warmer, and a
  // pure transient spin-up would take *decades* of simulated time to warm that
  // ground up — leaving cold artefacts (especially at slab edges). Running the
  // implicit step with the thermal-mass term removed (huge dt) and a constant
  // annual-mean surface temperature converges the *time-averaged* field
  // directly, so the subsequent transient spin-up only needs to add the
  // seasonal wave and converges in ~1 year.
  for (int k = 0; k < 100; ++k)
    stepBackwardEuler(mesh, binfo, capacities, epwStats.mean, 1e12);

  // Weekly snapshot storage.
  const int numCells = mesh.cols * mesh.rows;
  const int weeksPerYear = 52;
  result.weeklyTemps.resize((size_t)weeksPerYear * numCells, 0.0);

  // Which step indices correspond to weekly snapshots (one per 7 days, or
  // every stepsPerYear/52 steps if not hourly).
  const int stepsPerYear = config.stepsPerYear;
  double stepsPerWeek = (double)stepsPerYear / weeksPerYear;

  // Month mapping: for each step in a year, which month (0-11).
  // Approximate uniform month lengths.
  const int daysPerMonth[12] = {31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31};
  std::vector<int> stepMonth(stepsPerYear, 0);
  {
    int totalDays = 0;
    double daysPerStep = 365.25 / stepsPerYear;
    for (int s = 0; s < stepsPerYear; ++s) {
      double dayOfYear = s * daysPerStep;
      int cumDays = 0;
      int m = 0;
      for (m = 0; m < 11; ++m) {
        if (dayOfYear < cumDays + daysPerMonth[m]) break;
        cumDays += daysPerMonth[m];
      }
      stepMonth[s] = m;
    }
  }

  // Spin-up + reported year loop.
  const int totalYears = config.spinupYears + 1;
  const bool isReportedYear = true;  // only last year reported

  // Track periodicity by saving temperatures at year start.
  std::vector<double> prevYearStart(mesh.temperatures);

  const double dtSec = config.dtSeconds;
  const double J_per_kWh = 3.6e6;
  const int totalSteps = totalYears * stepsPerYear;
  int stepsDone = 0;
  int lastPct = -1;
  const bool hasProgress = !onProgress.isUndefined() && !onProgress.isNull();

  for (int year = 0; year < totalYears; ++year) {
    bool reporting = (year == totalYears - 1);

    // Monthly accumulators (J/m depth) for this year.
    std::vector<double> monthlyJ(12, 0.0);

    // Save start-of-year temperatures for periodicity check.
    if (year > 0) {
      double maxDelta = 0.0;
      const int nn = (int)mesh.temperatures.size();
      for (int k = 0; k < nn; ++k)
        maxDelta = std::max(maxDelta, std::fabs(mesh.temperatures[k] - prevYearStart[k]));
      result.periodicityResidual = maxDelta;
    }
    prevYearStart = mesh.temperatures;

    int lastCapturedWeek = -1;

    for (int step = 0; step < stepsPerYear; ++step) {
      double surfT = surfaceTemp[step];
      stepBackwardEuler(mesh, binfo, capacities, surfT, dtSec);
      result.totalSteps++;
      stepsDone++;
      if (hasProgress) {
        int pct = totalSteps > 0 ? (stepsDone * 100) / totalSteps : 100;
        if (pct != lastPct) { onProgress(pct); lastPct = pct; }
      }

      if (reporting) {
        // Weekly snapshot: capture on the first step of each new week.
        int weekIdx = std::min((int)(step / stepsPerWeek), weeksPerYear - 1);
        if (weekIdx != lastCapturedWeek) {
          lastCapturedWeek = weekIdx;
          size_t base = (size_t)weekIdx * numCells;
          for (int cj = 0; cj < mesh.rows; ++cj)
            for (int ci = 0; ci < mesh.cols; ++ci)
              result.weeklyTemps[base + cj * mesh.cols + ci] = cellAvgTemp(mesh, ci, cj);
        }

        // Monthly heat-loss integration.
        if (!line.xs.empty() && line.xs.size() >= 2) {
          double flux = integrateLineFlux(mesh, line);  // W/m depth
          monthlyJ[stepMonth[step]] += flux * dtSec;    // J/m depth
        }
      }
    }

    if (reporting) {
      for (int m = 0; m < 12; ++m)
        result.monthlyHeatLossKwh[m] = monthlyJ[m] / J_per_kWh;
    }
  }

  return result;
}

// Backward-compatible wrapper: no progress callback.
GroundResult solveGround(
    const std::vector<GroundLayer>& layers,
    const std::vector<GroundEdgeCondition>& conditions,
    const MeasureLine& line,
    const GroundConfig& config,
    const std::vector<double>& surfaceTemp)
{
  return solveGroundWithProgress(layers, conditions, line, config, surfaceTemp,
                                  emscripten::val::undefined());
}

// ── Debug: build mesh only, no solve ──────────────────────────────────────

GroundMeshResult buildGroundMeshDebug(
    const std::vector<GroundLayer>& layers,
    const GroundConfig& config,
    const MeasureLine& line)
{
  std::vector<double> lxs(line.xs.begin(), line.xs.end());
  std::vector<double> lys(line.ys.begin(), line.ys.end());
  GroundMesh mesh = buildGroundMesh(layers, config, lxs, lys);
  GroundMeshResult r;
  r.cols    = mesh.cols;
  r.rows    = mesh.rows;
  r.originX = mesh.originX;
  r.originY = mesh.originY;
  r.nodeXs  = mesh.nodeXs;
  r.nodeYs  = mesh.nodeYs;
  r.lambda  = mesh.lambda;
  return r;
}

// ── Emscripten bindings ────────────────────────────────────────────────────

EMSCRIPTEN_BINDINGS(ground_solver) {
  emscripten::value_object<GroundLayer>("GroundLayer")
      .field("x",        &GroundLayer::x)
      .field("y",        &GroundLayer::y)
      .field("w",        &GroundLayer::w)
      .field("h",        &GroundLayer::h)
      .field("lambda",   &GroundLayer::lambda)
      .field("rhoC",     &GroundLayer::rhoC)
      .field("priority", &GroundLayer::priority);

  emscripten::value_object<GroundEdgeCondition>("GroundEdgeCondition")
      .field("layerIndex",  &GroundEdgeCondition::layerIndex)
      .field("side",        &GroundEdgeCondition::side)
      .field("type",        &GroundEdgeCondition::type)
      .field("temperature", &GroundEdgeCondition::temperature);

  emscripten::value_object<MeasureLine>("MeasureLine")
      .field("xs", &MeasureLine::xs)
      .field("ys", &MeasureLine::ys);

  emscripten::value_object<GroundConfig>("GroundConfig")
      .field("nearCellMm",       &GroundConfig::nearCellMm)
      .field("growthRatio",      &GroundConfig::growthRatio)
      .field("maxCellMm",        &GroundConfig::maxCellMm)
      .field("domainDepthM",     &GroundConfig::domainDepthM)
      .field("domainHalfWidthM", &GroundConfig::domainHalfWidthM)
      .field("dtSeconds",        &GroundConfig::dtSeconds)
      .field("indoorTemp",       &GroundConfig::indoorTemp)
      .field("stepsPerYear",     &GroundConfig::stepsPerYear)
      .field("spinupYears",      &GroundConfig::spinupYears);

  emscripten::value_object<GroundResult>("GroundResult")
      .field("cols",                &GroundResult::cols)
      .field("rows",                &GroundResult::rows)
      .field("originX",             &GroundResult::originX)
      .field("originY",             &GroundResult::originY)
      .field("nodeXs",              &GroundResult::nodeXs)
      .field("nodeYs",              &GroundResult::nodeYs)
      .field("lambda",              &GroundResult::lambda)
      .field("weeklyTemps",         &GroundResult::weeklyTemps)
      .field("monthlyHeatLossKwh",  &GroundResult::monthlyHeatLossKwh)
      .field("totalSteps",          &GroundResult::totalSteps)
      .field("periodicityResidual", &GroundResult::periodicityResidual);

  emscripten::value_object<GroundMeshResult>("GroundMeshResult")
      .field("cols",    &GroundMeshResult::cols)
      .field("rows",    &GroundMeshResult::rows)
      .field("originX", &GroundMeshResult::originX)
      .field("originY", &GroundMeshResult::originY)
      .field("nodeXs",  &GroundMeshResult::nodeXs)
      .field("nodeYs",  &GroundMeshResult::nodeYs)
      .field("lambda",  &GroundMeshResult::lambda);

  emscripten::register_vector<GroundLayer>("GroundLayerVector");
  emscripten::register_vector<GroundEdgeCondition>("GroundEdgeConditionVector");
  emscripten::register_vector<double>("DoubleVector");

  emscripten::function("solveGround",             &solveGround);
  emscripten::function("solveGroundWithProgress", &solveGroundWithProgress);
  emscripten::function("buildGroundMeshDebug",    &buildGroundMeshDebug);
}
