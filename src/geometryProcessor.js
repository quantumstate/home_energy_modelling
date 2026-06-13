
// src/shared/geometryProcessor.js
//
// Converts BuildingModel (authored data) → ProcessedBuilding (computed).
// This runs in the browser; the same logic can be ported to C++/Wasm
// for the full energy engine.

import { STOREY_LABELS, DEFAULT_U_VALUES, UNHEATED_DELTA_T_FACTOR } from "./constants.js";

// ─── Geometry helpers (local) ─────────────────────────────────────────────────

const v2dist  = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
const v2sub   = (a, b) => ({ x: a.x - b.x, y: a.y - b.y });
const v2len   = (v)    => Math.hypot(v.x, v.y);

// Twice the signed area of the polygon (shoelace-like sum). Its sign encodes
// the winding direction, which `wallOutwardBearing` uses to find outward
// normals consistently even for concave (non-convex) polygons.
function signedAreaX2(pts) {
  let a = 0;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++)
    a += (pts[j].x + pts[i].x) * (pts[j].y - pts[i].y);
  return a;
}

function polyCentroid(pts) {
  return {
    x: pts.reduce((s, p) => s + p.x, 0) / pts.length,
    y: pts.reduce((s, p) => s + p.y, 0) / pts.length,
  };
}

// ─── Bearing & orientation ────────────────────────────────────────────────────

/**
 * Compute the outward wall bearing (degrees clockwise from north) for the
 * wall from ptA → ptB, given the room centroid and the building rotation.
 *
 * In SVG coordinates (Y increases downward), north = (0, -1).
 * The outward normal points away from the room interior.
 *
 * @param {Vec2}    ptA
 * @param {Vec2}    ptB
 * @param {Vec2}    centroid - room centroid in local coords
 * @param {number}  buildingRotation - degrees CW from north to local +X axis
 * @param {number}  [windingSignX2] - signedAreaX2() of the room polygon. When
 *                  provided, the outward normal is derived from the polygon's
 *                  winding direction, which is correct for concave rooms too.
 *                  When omitted, falls back to the "away from centroid"
 *                  heuristic, which only holds for convex rooms.
 * @returns {number} compass bearing, 0–360
 */
export function wallOutwardBearing(ptA, ptB, centroid, buildingRotation = 0, windingSignX2) {
  const dx = ptB.x - ptA.x, dy = ptB.y - ptA.y;
  const len = Math.sqrt(dx * dx + dy * dy);
  if (len < 1e-6) return 0;

  // Two candidate normals (perpendiculars to the wall direction)
  const n1 = { x: -dy / len, y:  dx / len };  // left of A→B direction
  const n2 = { x:  dy / len, y: -dx / len };  // right of A→B direction

  let normal;
  if (windingSignX2) {
    // For a polygon with signedAreaX2() > 0, n1 is outward for every edge
    // (and n2 for every edge when < 0) — independent of convexity.
    normal = windingSignX2 > 0 ? n1 : n2;
  } else {
    // Wall midpoint
    const mid = { x: (ptA.x + ptB.x) / 2, y: (ptA.y + ptB.y) / 2 };
    // Outward normal: points away from centroid (only correct for convex rooms)
    const toCentroid = { x: centroid.x - mid.x, y: centroid.y - mid.y };
    normal = (n1.x * toCentroid.x + n1.y * toCentroid.y) < 0 ? n1 : n2;
  }

  // Convert normal vector to bearing.
  // In SVG coords: north = (0, -1), so bearing = atan2(nx, -ny).
  // Subtract buildingRotation: when rotation=90 (north=right/+X), a normal of (1,0)
  // gives localBearing=90°; subtracting 90 gives 0° (north) as required.
  const localBearing = Math.atan2(normal.x, -normal.y) * (180 / Math.PI);
  return ((localBearing - buildingRotation) % 360 + 360) % 360;
}

/** Bin a bearing into one of 8 compass directions. */
export function bearingToOrientation(bearing) {
  const dirs = ["N", "NE", "E", "SE", "S", "SW", "W", "NW"];
  return dirs[Math.round(((bearing % 360) + 360) % 360 / 45) % 8];
}

// ─── Adjacency detection ──────────────────────────────────────────────────────

const ADJACENCY_TOLERANCE = 0.05; // metres — walls closer than this are "shared"

/**
 * Determine whether the wall from ptA → ptB (belonging to selfRoomId in
 * storeyIndex) is external or shared with another room.
 *
 * Two walls are shared when one runs A→B and another runs B→A (reversed)
 * within the same storey.
 *
 * @returns {{ type: AdjacencyType, adjacentRoomId?: string }}
 */
export function detectWallAdjacency(ptA, ptB, selfRoomId, storeyRooms, tol = ADJACENCY_TOLERANCE) {
  for (const room of storeyRooms) {
    if (room.id === selfRoomId) continue;
    const pts = room.points;
    for (let i = 0; i < pts.length; i++) {
      const p = pts[i], q = pts[(i + 1) % pts.length];
      // Reversed direction = shared wall
      if (v2dist(p, ptB) < tol && v2dist(q, ptA) < tol) {
        const adj = room.isHeated ? "internal-heated" : "internal-unheated";
        return { type: adj, adjacentRoomId: room.id };
      }
    }
  }
  return { type: "external" };
}

// ─── Editor state → BuildingModel ─────────────────────────────────────────────

/**
 * Convert the React editor state into a portable BuildingModel.
 * Call this whenever you need to serialise or pass data to another component.
 *
 * @param {object} editorState
 * @param {Record<number, Room[]>} editorState.roomsByStorey
 * @param {Record<number, number>} editorState.ceilingHeights
 * @param {object}                 editorState.globalU
 * @param {Partial<SiteData>}      editorState.site  - optional, uses defaults
 * @returns {BuildingModel}
 */
export function buildingModelFromState({
  roomsByStorey,
  ceilingHeights,
  globalU,
  site = {},
  name = "Untitled Building",
  id   = `bld_${Date.now()}`,
}) {
  const now = new Date().toISOString();

  // Build storey elevation from cumulative ceiling heights
  let elevation = 0;
  const storeys = STOREY_LABELS.map((label, i) => {
    const storeyType = i === 0 ? "ground" : "upper";
    const ceilH = ceilingHeights[i] ?? 2.7;
    const rooms  = (roomsByStorey[i] || []).map(r => ({
      id: r.id,
      name: r.name,
      use: r.use ?? "other",
      isHeated: r.isHeated !== false,   // default heated
      points: r.points,
      openings: (r.openings || []).map(o => ({
        id: o.id,
        type: o.type,
        wallIndex: o.wallIdx ?? o.wallIndex ?? 0,
        offset: o.offset,
        width: o.width,
        height: o.height ?? (o.type === "window" ? 1.2 : 2.1),
        sillHeight: o.sillHeight ?? (o.type === "window" ? 0.9 : 0.0),
        uValue: o.uValue ?? null,
        glazing: o.glazing ?? (o.type === "window"
          ? { solarHeatGainCoeff: 0.63, lightTransmittance: 0.77 }
          : undefined),
      })),
      wallUs: r.wallUs ?? {},
      floorU: r.floorU ?? null,
      roofU:  r.roofU  ?? null,
    }));

    const floorElevation = elevation;
    elevation += ceilH;

    return {
      id: `storey_${i}`,
      index: i,
      type: storeyType,
      label,
      floorElevation,
      ceilingHeight: ceilH,
      rooms,
    };
  });

  return {
    version: "1.0",
    id,
    name,
    site: {
      latitude:         site.latitude         ?? 51.5,
      longitude:        site.longitude        ?? -0.1,
      altitude:         site.altitude         ?? 20,
      buildingRotation: site.buildingRotation ?? 0,
      exposure:         site.exposure         ?? "normal",
      climateZone:      site.climateZone,
    },
    storeys,
    defaults: {
      uValues: {
        wall:   globalU?.wall   ?? DEFAULT_U_VALUES.wall,
        floor:  globalU?.floor  ?? DEFAULT_U_VALUES.floor,
        roof:   globalU?.roof   ?? DEFAULT_U_VALUES.roof,
        window: globalU?.window ?? DEFAULT_U_VALUES.window,
        door:   globalU?.door   ?? DEFAULT_U_VALUES.door,
      },
    },
    createdAt: now,
    updatedAt: now,
  };
}

// ─── BuildingModel → ProcessedBuilding ────────────────────────────────────────

/**
 * Full geometry processing pass. Computes all derived quantities.
 * Safe to call on every relevant state change (fast for typical house sizes).
 *
 * @param {BuildingModel} model
 * @returns {ProcessedBuilding}
 */
export function processBuilding(model) {
  const warnings = [];
  const processedRooms = [];

  for (const storey of model.storeys) {
    const { ceilingHeight, floorElevation, index: si } = storey;
    const defU = model.defaults.uValues;

    for (const room of storey.rooms) {
      const pts      = room.points;
      const nPts     = pts.length;
      const windingSignX2 = signedAreaX2(pts);
      const roomArea = Math.abs(windingSignX2) / 2;
      const roomVol  = roomArea * ceilingHeight;
      const cen      = polyCentroid(pts);

      // ── Walls ──────────────────────────────────────────────────────────────
      const processedWalls = [];

      for (let wi = 0; wi < nPts; wi++) {
        const ptA = pts[wi], ptB = pts[(wi + 1) % nPts];
        const len  = v2dist(ptA, ptB);
        if (len < 0.01) continue;

        // Orientation
        const bearing     = wallOutwardBearing(ptA, ptB, cen, model.site.buildingRotation, windingSignX2);
        const orientation = bearingToOrientation(bearing);

        // Adjacency
        const adj = detectWallAdjacency(ptA, ptB, room.id, storey.rooms);

        // Effective U-value
        const uOverride = room.wallUs?.[wi];
        const uValue    = (uOverride !== null && uOverride !== undefined) ? uOverride : defU.wall;

        // 3-D positions (Z = up, metres from site datum)
        const z0 = floorElevation;
        const z1 = floorElevation + ceilingHeight;
        const worldStart = { x: ptA.x, y: ptA.y, z: z0 };
        const worldEnd   = { x: ptB.x, y: ptB.y, z: z0 };

        // Openings on this wall
        const wallOpenings = (room.openings || [])
          .filter(o => (o.wallIndex ?? o.wallIdx) === wi);

        const processedOpenings = wallOpenings.map(o => {
          const oH    = o.height    ?? (o.type === "window" ? 1.2 : 2.1);
          const oSill = o.sillHeight ?? (o.type === "window" ? 0.9 : 0.0);
          const oArea = o.width * oH;
          const oU    = (o.uValue !== null && o.uValue !== undefined)
            ? o.uValue : (o.type === "window" ? defU.window : defU.door);
          const oHLC  = oU * oArea;
          const shgc  = o.glazing?.solarHeatGainCoeff ?? (o.type === "window" ? 0.63 : 0.0);
          const lt    = o.glazing?.lightTransmittance  ?? (o.type === "window" ? 0.77 : 0.0);

          // Validate: head height vs ceiling
          const headH = oSill + oH;
          if (headH > ceilingHeight + 0.01) {
            warnings.push({
              severity: "warning",
              roomId: room.id,
              openingId: o.id,
              message: `Opening head height ${headH.toFixed(2)}m exceeds ceiling ${ceilingHeight.toFixed(2)}m`,
            });
          }

          // World position: start of opening along wall + sill height
          const dir   = { x: (ptB.x - ptA.x) / len, y: (ptB.y - ptA.y) / len };
          const ox    = ptA.x + dir.x * o.offset;
          const oy    = ptA.y + dir.y * o.offset;
          const worldPosition = { x: ox, y: oy, z: z0 + oSill };

          return {
            sourceId: o.id,
            type: o.type,
            area: oArea, width: o.width, height: oH, sillHeight: oSill,
            worldPosition,
            bearing, orientation, tilt: 90,
            uValue: oU, solarHeatGainCoeff: shgc, lightTransmittance: lt,
            heatLossCoeff: oHLC,
          };
        });

        const openingArea  = processedOpenings.reduce((s, o) => s + o.area, 0);
        const grossArea    = len * ceilingHeight;
        const netOpaqueArea = Math.max(0, grossArea - openingArea);
        const wallHLC      = adj.type === "external" ? uValue * netOpaqueArea
          : adj.type === "internal-unheated" ? uValue * netOpaqueArea * UNHEATED_DELTA_T_FACTOR
          : 0;

        processedWalls.push({
          roomId: room.id, storeyIndex: si, wallIndex: wi,
          startPoint: ptA, endPoint: ptB, length: len,
          worldStart, worldEnd, height: ceilingHeight,
          grossArea, netOpaqueArea,
          bearing, orientation, tilt: 90,
          adjacency: adj.type, adjacentRoomId: adj.adjacentRoomId,
          uValue,
          heatLossCoeff: wallHLC,
          openings: processedOpenings,
        });
      }

      // Warn about openings whose wallIndex no longer matches any wall
      // (e.g. the room polygon was edited and walls were removed/reordered).
      for (const o of room.openings || []) {
        const wi = o.wallIndex ?? o.wallIdx ?? 0;
        if (wi < 0 || wi >= nPts) {
          warnings.push({
            severity: "warning",
            roomId: room.id,
            openingId: o.id,
            message: `Opening references wall index ${wi}, but room only has ${nPts} walls; it will not be included in the model`,
          });
        }
      }

      // ── Floor ──────────────────────────────────────────────────────────────
      const uFloor    = (room.floorU !== null && room.floorU !== undefined) ? room.floorU : defU.floor;
      const floorAdj  = storey.type === "ground" || storey.type === "basement" ? "ground" : "internal-heated";
      const floorHLC  = floorAdj === "ground" ? uFloor * roomArea : 0;
      const floor = {
        roomId: room.id, storeyIndex: si, type: "floor",
        area: roomArea, adjacency: floorAdj,
        uValue: uFloor, heatLossCoeff: floorHLC,
        tilt: 0, bearing: 180,   // facing downward
      };

      // ── Roof ───────────────────────────────────────────────────────────────
      const uRoof    = (room.roofU !== null && room.roofU !== undefined) ? room.roofU : defU.roof;
      // A storey is the top (exposed roof) when no higher storey has any rooms.
      // We cannot use `si === model.storeys.length - 1` because buildingModelFromState
      // always generates a fixed number of storeys (one per STOREY_LABELS entry),
      // leaving upper storeys empty when the building only uses lower floors.
      const isTopStorey = model.storeys.slice(si + 1).every(s => s.rooms.length === 0);
      const roofAdj  = isTopStorey ? "external" : "internal-heated";
      const roofHLC  = roofAdj === "external" ? uRoof * roomArea : 0;
      const roof = {
        roomId: room.id, storeyIndex: si, type: "roof",
        area: roomArea, adjacency: roofAdj,
        uValue: uRoof, heatLossCoeff: roofHLC,
        tilt: 0, bearing: 0,    // facing upward
      };

      // ── Room totals ────────────────────────────────────────────────────────
      const wallHLC    = processedWalls.reduce((s, w) => s + w.heatLossCoeff, 0);
      const openingHLC = processedWalls.flatMap(w => w.openings).reduce((s, o) => s + o.heatLossCoeff, 0);
      const fabricHLC  = wallHLC + openingHLC + floorHLC + roofHLC;
      const totalGlazingArea = processedWalls
        .flatMap(w => w.openings)
        .filter(o => o.type === "window")
        .reduce((s, o) => s + o.area, 0);

      processedRooms.push({
        sourceId: room.id, name: room.name, storeyIndex: si,
        use: room.use ?? "other", isHeated: room.isHeated !== false,
        floorArea: roomArea, volume: roomVol,
        walls: processedWalls, floor, roof,
        fabricHeatLossCoeff: fabricHLC,
        totalGlazingArea,
      });
    }
  }

  // ── Building summary ────────────────────────────────────────────────────────
  const heated         = processedRooms.filter(r => r.isHeated);
  const totalFloorArea = heated.reduce((s, r) => s + r.floorArea, 0);
  const totalVolume    = heated.reduce((s, r) => s + r.volume, 0);
  const fabricHLC      = heated.reduce((s, r) => s + r.fabricHeatLossCoeff, 0);

  // All external surfaces (for envelope area and avg U)
  const allExternalWalls = processedRooms
    .flatMap(r => r.walls)
    .filter(w => w.adjacency === "external");
  const allExternalHoriz = processedRooms
    .flatMap(r => [r.floor, r.roof])
    .filter(s => s.adjacency === "external" || s.adjacency === "ground");

  const totalEnvelopeArea =
    allExternalWalls.reduce((s, w) => s + w.grossArea, 0) +
    allExternalHoriz.reduce((s, s2) => s + s2.area, 0);

  const avgFabricU = totalEnvelopeArea > 0 ? fabricHLC / totalEnvelopeArea : 0;

  // Glazing split by orientation — heated rooms only, to match totalFloorArea
  // (otherwise glazingRatio could be skewed by windows in unheated spaces).
  const glazingByOrientation = {};
  heated
    .flatMap(r => r.walls)
    .flatMap(w => w.openings)
    .filter(o => o.type === "window")
    .forEach(o => {
      glazingByOrientation[o.orientation] =
        (glazingByOrientation[o.orientation] ?? 0) + o.area;
    });

  const totalGlazing = Object.values(glazingByOrientation).reduce((s, a) => s + a, 0);
  const glazingRatio = totalFloorArea > 0 ? totalGlazing / totalFloorArea : 0;

  const envelopeSurfaces = [
    ...allExternalWalls,
    ...allExternalHoriz,
  ];

  return {
    source:      model,
    processedAt: new Date().toISOString(),
    rooms:       processedRooms,
    envelopeSurfaces,
    summary: {
      totalFloorArea, totalVolume, totalEnvelopeArea,
      fabricHeatLossCoeff: fabricHLC,
      glazingAreaByOrientation: glazingByOrientation,
      glazingRatio, avgFabricU,
      warnings,
    },
  };
}
