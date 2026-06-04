
// src/shared/buildingModel.ts
//
// Interchange data structure for the floor plan editor, 3D view, and energy model.
//
// DESIGN GOALS
// ─────────────
// • One authoritative BuildingModel that the editor writes.
// • A geometry processor derives ProcessedBuilding from it — all computed
//   quantities live there, never in the authored data.
// • Both layers serialise cleanly to JSON so C++/Wasm, web workers, and
//   future server-side engines can all consume the same payload.
// • Schema-versioned so the format can evolve without silent breakage.
//
// DATA FLOW
// ──────────
//   Editor state
//       │  buildingModelFromState()
//       ▼
//   BuildingModel          ← serialised / stored / transferred
//       │  processBuilding()
//       ▼
//   ProcessedBuilding      ← consumed by 3D view and energy model
//

// ─── Version ─────────────────────────────────────────────────────────────────

export const SCHEMA_VERSION = "1.0";

// ─── Primitives ───────────────────────────────────────────────────────────────

/** A point in the floor plan's local coordinate system, in metres. */
export interface Vec2 {
  x: number;
  y: number;
}

/**
 * Compass bearing in degrees, clockwise from true north (0–360).
 * Used for wall orientations and solar calculations.
 */
export type Bearing = number;

/** Eight cardinal / inter-cardinal compass directions. */
export type Orientation = "N" | "NE" | "E" | "SE" | "S" | "SW" | "W" | "NW";

// ─── Site ─────────────────────────────────────────────────────────────────────

export interface SiteData {
  /** Decimal degrees, positive = north. */
  latitude: number;
  /** Decimal degrees, positive = east. */
  longitude: number;
  /** Metres above sea level. */
  altitude: number;
  /**
   * Degrees clockwise from north to the floor plan's local +X axis.
   * A value of 0 means the drawing is aligned with north pointing up.
   * Used to convert local wall bearings to true compass bearings.
   */
  buildingRotation: Bearing;
  /** Affects wind-driven infiltration rates. */
  exposure: "sheltered" | "normal" | "exposed";
  /** Optional CIBSE / ASHRAE climate zone identifier. */
  climateZone?: string;
}

// ─── Constructions ────────────────────────────────────────────────────────────

/** A single homogeneous material layer. */
export interface MaterialLayer {
  id: string;
  name: string;
  thickness: number;             // metres
  thermalConductivity: number;   // W/(m·K)
  density: number;               // kg/m³  — needed for thermal mass
  specificHeat: number;          // J/(kg·K)
}

/**
 * An ordered stack of material layers (outermost first).
 * The U-value may be set directly (measured/certified) or computed
 * from layers by the energy engine.
 */
export interface Construction {
  id: string;
  name: string;
  layers: MaterialLayer[];
  /** W/(m²·K) — directly set or computed; null = compute from layers. */
  uValue: number | null;
}

/** Glazing unit properties used for solar and thermal calculations. */
export interface GlazingSpec {
  id: string;
  name: string;
  uValue: number;              // W/(m²·K), whole-window value
  /** Solar heat gain coefficient (g-value), 0–1. */
  solarHeatGainCoeff: number;
  lightTransmittance: number;  // 0–1
}

// ─── Openings ─────────────────────────────────────────────────────────────────

export type OpeningType = "window" | "door" | "rooflight";

/**
 * A window or door cut into a wall.
 * Position is defined relative to the start of the host wall.
 */
export interface Opening {
  id: string;
  type: OpeningType;
  /** Index into the parent room's `points` array (wall i → points[i]→points[i+1]). */
  wallIndex: number;
  /** Metres from the start vertex of the host wall to the nearest jamb. */
  offset: number;
  width: number;       // metres
  height: number;      // metres
  /** Metres above the finished floor level of the host storey. */
  sillHeight: number;
  /**
   * W/(m²·K). null = use the relevant global default (window or door).
   * For doors this is the whole-door U-value.
   * For windows this is the whole-window U-value (frame + glazing combined).
   */
  uValue: number | null;
  /** Glazing performance — required for solar gain calculation (windows only). */
  glazing?: {
    solarHeatGainCoeff: number;  // g-value, 0–1
    lightTransmittance: number;  // 0–1
  };
}

// ─── Rooms / Spaces ───────────────────────────────────────────────────────────

export type SpaceUse =
  | "living" | "dining" | "kitchen" | "bedroom" | "bathroom"
  | "hallway" | "utility" | "garage" | "unheated-store" | "other";

/**
 * A thermally distinct zone within a storey.
 * Points trace the room perimeter in any consistent winding order.
 * The geometry processor normalises to CCW (when viewed from above,
 * Y-up convention) before computing outward normals.
 */
export interface Room {
  id: string;
  name: string;
  use: SpaceUse;
  /** If false, treated as an unheated buffer zone in the energy model. */
  isHeated: boolean;
  /** Polygon vertices in local metres. Closed implicitly (last→first). */
  points: Vec2[];
  openings: Opening[];
  /**
   * Per-wall U-value overrides, keyed by wall index (same indexing as points).
   * A missing key or null value means "use the global default".
   */
  wallUs: Record<number, number | null>;
  /** Floor U-value override. null = use global default. */
  floorU: number | null;
  /** Roof/ceiling U-value override. null = use global default. */
  roofU: number | null;
}

// ─── Storeys ──────────────────────────────────────────────────────────────────

export type StoreyType = "basement" | "ground" | "upper" | "roof-room";

export interface Storey {
  id: string;
  /** 0 = lowest occupied floor. */
  index: number;
  type: StoreyType;
  label: string;
  /** Metres above the site datum (ground level = 0). */
  floorElevation: number;
  /** Clear height from finished floor to finished ceiling, metres. */
  ceilingHeight: number;
  rooms: Room[];
}

// ─── Global Defaults ──────────────────────────────────────────────────────────

/** Fallback U-values applied when a building element has no individual override. */
export interface GlobalDefaults {
  uValues: {
    wall:   number;   // W/(m²·K)
    floor:  number;
    roof:   number;
    window: number;
    door:   number;
  };
}

// ─── Building Model (authored data) ───────────────────────────────────────────

/**
 * The complete authored description of a building.
 * This is what the editor writes, stores, and transfers.
 * All values are either directly set by the user or defaulted on creation;
 * no derived / computed quantities belong here.
 */
export interface BuildingModel {
  /** Schema version — increment when the structure changes incompatibly. */
  version: string;
  id: string;
  name: string;
  site: SiteData;
  storeys: Storey[];
  defaults: GlobalDefaults;
  createdAt: string;   // ISO 8601
  updatedAt: string;   // ISO 8601
}

// ═══════════════════════════════════════════════════════════════════════════════
// PROCESSED LAYER  (computed by geometry processor — never authored directly)
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * How a surface relates to its thermal boundary.
 * Drives whether heat loss through the surface should be counted.
 */
export type AdjacencyType =
  | "external"           // exposed to outside air → full ΔT
  | "ground"             // in contact with ground → reduced ΔT, use ground temps
  | "internal-heated"    // adjacent to another heated space → no net loss
  | "internal-unheated"  // adjacent to unheated space (garage, loft) → partial ΔT
  | "party";             // shared with neighbouring building → adiabatic

// ── Processed opening ─────────────────────────────────────────────────────────

/**
 * A window or door with all geometric quantities resolved into world space
 * and all U-values filled in (no nulls — defaults applied).
 */
export interface ProcessedOpening {
  /** Original opening id for traceability. */
  sourceId: string;
  type: OpeningType;
  // Geometry
  area: number;          // m²  (width × height)
  width: number;         // m
  height: number;        // m
  sillHeight: number;    // m above storey floor
  /** Bottom-left corner in 3-D world space (for 3D view). */
  worldPosition: { x: number; y: number; z: number };
  // Orientation
  bearing: Bearing;      // outward normal, degrees from north
  orientation: Orientation;
  tilt: number;          // 90° for vertical openings, 0° for rooflights
  // Thermal (all resolved — no nulls)
  uValue: number;        // W/(m²·K)
  solarHeatGainCoeff: number;
  lightTransmittance: number;
  /** U × area, W/K — pre-computed for the energy model. */
  heatLossCoeff: number;
}

// ── Processed wall ────────────────────────────────────────────────────────────

/**
 * One wall segment with all derived geometric and thermal properties.
 * Openings are inlined so the energy model can iterate without cross-referencing.
 */
export interface ProcessedWall {
  // Source traceability
  roomId: string;
  storeyIndex: number;
  wallIndex: number;
  // 2-D geometry (local floor plan)
  startPoint: Vec2;
  endPoint: Vec2;
  length: number;        // m
  // 3-D geometry (for 3D view)
  worldStart: { x: number; y: number; z: number };
  worldEnd:   { x: number; y: number; z: number };
  height: number;        // = storey ceiling height, m
  // Areas
  grossArea: number;     // length × height, m²
  netOpaqueArea: number; // gross − sum(opening areas), m²
  // Orientation
  bearing: Bearing;
  orientation: Orientation;
  tilt: number;          // always 90° for vertical walls
  // Adjacency & thermal
  adjacency: AdjacencyType;
  /** Populated when adjacency is internal-heated or internal-unheated. */
  adjacentRoomId?: string;
  uValue: number;        // W/(m²·K), resolved from override or default
  heatLossCoeff: number; // U × netOpaqueArea, W/K
  // Openings on this wall
  openings: ProcessedOpening[];
}

// ── Processed floor / roof ────────────────────────────────────────────────────

export interface ProcessedHorizontalSurface {
  roomId: string;
  storeyIndex: number;
  type: "floor" | "roof";
  area: number;          // m²
  adjacency: AdjacencyType;
  uValue: number;        // W/(m²·K)
  heatLossCoeff: number; // U × area, W/K
  tilt: number;          // 0° = horizontal
  bearing: Bearing;      // 0° for roofs (upward facing), 180° for floors
}

// ── Processed room ────────────────────────────────────────────────────────────

/**
 * A single thermally-distinct zone with all surfaces and heat loss resolved.
 * The energy model works primarily with this type.
 */
export interface ProcessedRoom {
  // Source
  sourceId: string;
  name: string;
  storeyIndex: number;
  use: SpaceUse;
  isHeated: boolean;
  // Geometry
  floorArea: number;    // m²
  volume: number;       // m³  (floorArea × ceilingHeight)
  // Surfaces
  walls: ProcessedWall[];
  floor: ProcessedHorizontalSurface;
  roof:  ProcessedHorizontalSurface;
  // Totals (convenient cache — sum of all surface heatLossCoeffs)
  fabricHeatLossCoeff: number;   // W/K — excludes ventilation
  totalGlazingArea: number;      // m²
}

// ── Envelope summary ──────────────────────────────────────────────────────────

/** High-level summary of the whole building envelope. */
export interface EnvelopeSummary {
  totalFloorArea: number;         // m², heated spaces only
  totalVolume: number;            // m³, heated spaces only
  totalEnvelopeArea: number;      // m², all external surfaces
  fabricHeatLossCoeff: number;    // W/K — basis for SAP/PHPP-style calculation
  /** Glazing area split by compass direction — used for solar gain model. */
  glazingAreaByOrientation: Partial<Record<Orientation, number>>;
  /** Total glazing area / total floor area. */
  glazingRatio: number;
  /** Area-weighted mean U-value of the whole envelope. */
  avgFabricU: number;
  /** Validation warnings generated during processing. */
  warnings: ProcessingWarning[];
}

export interface ProcessingWarning {
  severity: "info" | "warning" | "error";
  roomId?: string;
  wallIndex?: number;
  openingId?: string;
  message: string;
}

// ── ProcessedBuilding ─────────────────────────────────────────────────────────

/**
 * Complete computed representation of a building.
 * Produced by processBuilding() and consumed by the 3D view and energy model.
 *
 * The 3D view uses: rooms[*].walls[*].worldStart/worldEnd, ProcessedOpening.worldPosition
 * The energy model uses: rooms[*].fabricHeatLossCoeff, summary, ProcessedOpening.solarHeatGainCoeff
 */
export interface ProcessedBuilding {
  /** The original authored data that was processed. */
  source: BuildingModel;
  /** ISO 8601 timestamp of when processBuilding() was last run. */
  processedAt: string;
  /** One entry per room, across all storeys. */
  rooms: ProcessedRoom[];
  /** Flat list of all external envelope surfaces (walls + floors + roofs). */
  envelopeSurfaces: Array<ProcessedWall | ProcessedHorizontalSurface>;
  /** Building-level aggregates. */
  summary: EnvelopeSummary;
}
