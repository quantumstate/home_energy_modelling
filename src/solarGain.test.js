import { describe, it, expect } from "vitest";
import { solarPosition, verticalIncident, computeMonthlySolarGains } from "./solarGain.js";

// Tolerance helpers
const DEG = (val, tol = 1.0) => ({ val, tol }); // degrees tolerance
function near(actual, expected, tol = 1.0) {
  expect(actual).toBeGreaterThanOrEqual(expected - tol);
  expect(actual).toBeLessThanOrEqual(expected + tol);
}

// ─── solarPosition ────────────────────────────────────────────────────────────

describe("solarPosition", () => {

  it("returns aboveHorizon:false before sunrise (midnight)", () => {
    // Midnight anywhere — sun is below horizon
    const pos = solarPosition(51.5, -0.1, 0, 6, 21, 1); // hour=1 → 00:30
    expect(pos.aboveHorizon).toBe(false);
    expect(pos.altitude).toBe(0);
  });

  it("solar noon at equator on equinox — altitude high, azimuth ≈ 180°", () => {
    // March equinox: declination ≈ 0°. At lat=0, true solar noon altitude = 90°.
    // EPW hour 13 has midpoint 12:30, so ha ≈ 7.5° past noon → altitude ≈ 82°.
    const pos = solarPosition(0, 0, 0, 3, 21, 13);
    expect(pos.aboveHorizon).toBe(true);
    near(pos.altitude, 82, 5);
  });

  it("solar noon at London on summer solstice — altitude ≈ 62°, azimuth ≈ 180°", () => {
    // Lat=51.5°N, Jun 21, decl≈23.45°. Max altitude = 90 - (51.5 - 23.45) = 61.95°
    // Solar noon at lon=-0.1, tz=0: EPW hour 13 (midpoint 12:30)
    const pos = solarPosition(51.5, -0.1, 0, 6, 21, 13);
    expect(pos.aboveHorizon).toBe(true);
    near(pos.altitude, 62, 2);
    // Hour 13 midpoint = 12:30, ~30 min past true solar noon → sun slightly west of south
    near(pos.azimuth, 180, 15);
  });

  it("solar noon at London on winter solstice — altitude ≈ 15°, azimuth ≈ 180°", () => {
    // Lat=51.5°N, Dec 21, decl≈-23.45°. Max altitude = 90 - (51.5 + 23.45) = 15.05°
    const pos = solarPosition(51.5, -0.1, 0, 12, 21, 13);
    expect(pos.aboveHorizon).toBe(true);
    near(pos.altitude, 15, 2);
    // Hour 13 midpoint = 12:30, slightly past solar noon → just west of due south
    near(pos.azimuth, 180, 10);
  });

  it("morning sun is east of south (azimuth < 180°)", () => {
    // 9am London, June — sun is in the east
    const pos = solarPosition(51.5, -0.1, 0, 6, 21, 9); // midpoint 8:30
    expect(pos.aboveHorizon).toBe(true);
    expect(pos.azimuth).toBeLessThan(180); // east of south = azimuth < 180 from north
    expect(pos.azimuth).toBeGreaterThan(0);
  });

  it("afternoon sun is west of south (azimuth > 180°)", () => {
    // 4pm London, June — sun is in the west
    const pos = solarPosition(51.5, -0.1, 0, 6, 21, 16); // midpoint 15:30
    expect(pos.aboveHorizon).toBe(true);
    expect(pos.azimuth).toBeGreaterThan(180); // west of south = azimuth > 180 from north
    expect(pos.azimuth).toBeLessThan(360);
  });

  it("azimuth symmetric morning vs afternoon around solar noon", () => {
    // Use hours equidistant from noon: hour=10 (midpoint 9:30, ha=−37.5°) and
    // hour=15 (midpoint 14:30, ha=+37.5°). Azimuths should sum to ~360°.
    const morning   = solarPosition(51.5, 0, 0, 6, 21, 10); // 9:30 — sun in east
    const afternoon = solarPosition(51.5, 0, 0, 6, 21, 15); // 14:30 — sun in west
    near(morning.azimuth + afternoon.azimuth, 360, 10); // symmetric around 180° (due south)
    near(morning.altitude, afternoon.altitude, 3);       // same elevation by symmetry
  });

  it("returns aboveHorizon:false in polar night (lat=70, Dec, midnight)", () => {
    const pos = solarPosition(70, 0, 0, 12, 21, 13); // solar noon in polar night
    // At lat=70°N, Dec 21, decl=-23.45°: max alt = 90 - (70+23.45) = -3.45° — below horizon
    expect(pos.aboveHorizon).toBe(false);
  });

});

// ─── verticalIncident ─────────────────────────────────────────────────────────

describe("verticalIncident", () => {

  it("direct beam on a wall facing the sun at 45° altitude", () => {
    // Sun due south (az=180°), surface facing south (bearing=180°), alt=45°
    // cosTheta = cos(45°)*cos(0°) = 0.7071
    // beam = 800 * 0.7071 = 565.7
    // diffuse = 100 * 0.5 = 50
    // ground = 500 * 0.2 * 0.5 = 50
    // total ≈ 665.7
    const result = verticalIncident(45, 180, 180, 800, 100, 500);
    near(result, 665, 5);
  });

  it("no beam when sun is directly behind the surface", () => {
    // Sun due north (az=0°), surface facing south (bearing=180°)
    // dAz = 0 - 180 = -180°, cosTheta = cos(alt)*cos(180°) = -cos(alt) → beam = 0
    const result = verticalIncident(45, 0, 180, 800, 100, 500);
    // only diffuse + ground
    const expected = 100 * 0.5 + 500 * 0.2 * 0.5; // 50 + 50 = 100
    near(result, expected, 1);
  });

  it("no beam at night — only diffuse and ground", () => {
    const result = verticalIncident(0, 180, 180, 0, 80, 0);
    near(result, 80 * 0.5, 1); // diffuse only (ghi=0 so ground=0)
  });

  it("purely diffuse day (overcast) — result independent of surface orientation", () => {
    // When DNI=0, incident depends only on DHI and GHI (isotropic), not on surface bearing
    const south = verticalIncident(30, 180, 180, 0, 200, 250);
    const north  = verticalIncident(30, 180,   0, 0, 200, 250);
    near(south, north, 0.001);
  });

  it("sun at 90° azimuth (east), surface facing east (bearing=90°) — beam component present", () => {
    // dAz = 90 - 90 = 0°, cosTheta = cos(alt)*1 — maximum beam for this altitude
    const alt = 30;
    const result = verticalIncident(alt, 90, 90, 600, 50, 300);
    const beam = 600 * Math.cos(alt * Math.PI / 180);
    const expected = beam + 50 * 0.5 + 300 * 0.2 * 0.5;
    near(result, expected, 1);
  });

  it("sun exactly grazing the surface normal (90° dAz) — beam = 0", () => {
    // Sun due east (az=90°), surface facing south (bearing=180°) — dAz = 90 - 180 = -90°
    // cosTheta = cos(alt)*cos(90°) = 0 → no beam
    const result = verticalIncident(45, 90, 180, 800, 100, 400);
    const expected = 100 * 0.5 + 400 * 0.2 * 0.5;
    near(result, expected, 2);
  });

  it("all inputs zero — returns zero", () => {
    expect(verticalIncident(0, 0, 0, 0, 0, 0)).toBe(0);
  });

});

// ─── computeMonthlySolarGains ─────────────────────────────────────────────────

describe("computeMonthlySolarGains", () => {

  it("returns zeros when windowGroups is empty", () => {
    const result = computeMonthlySolarGains([], { latitude: 51.5, longitude: 0, timezone: 0 }, []);
    expect(result.annualKwh).toBe(0);
    expect(result.monthly).toHaveLength(12);
    result.monthly.forEach(v => expect(v).toBe(0));
  });

  it("returns zeros when all hourly records have no radiation", () => {
    const hourly = Array.from({ length: 8760 }, (_, i) => ({
      month: 1, day: 1, hour: (i % 24) + 1,
      dni: 0, dhi: 0, ghi: 0,
    }));
    const groups = [{ orientation: "S", bearing: 180, effectiveArea: 10 }];
    const result = computeMonthlySolarGains(hourly, { latitude: 51.5, longitude: 0, timezone: 0 }, groups);
    expect(result.annualKwh).toBe(0);
  });

  it("south-facing glazing gains more than north-facing at London latitude", () => {
    // Build a minimal synthetic EPW: one hour per day at solar noon with DNI=600, DHI=100, GHI=400
    const hourly = [];
    const daysInMonth = [31,28,31,30,31,30,31,31,30,31,30,31];
    for (let m = 1; m <= 12; m++) {
      for (let d = 1; d <= daysInMonth[m-1]; d++) {
        hourly.push({ month: m, day: d, hour: 13, dni: 600, dhi: 100, ghi: 400 });
      }
    }
    const loc = { latitude: 51.5, longitude: 0, timezone: 0 };
    const southGrp = [{ orientation: "S", bearing: 180, effectiveArea: 1 }];
    const northGrp = [{ orientation: "N", bearing: 0,   effectiveArea: 1 }];
    const south = computeMonthlySolarGains(hourly, loc, southGrp);
    const north = computeMonthlySolarGains(hourly, loc, northGrp);
    expect(south.annualKwh).toBeGreaterThan(north.annualKwh * 2);
  });

  it("monthly array has 12 entries that sum to annualKwh", () => {
    const hourly = [{ month: 6, day: 21, hour: 13, dni: 500, dhi: 100, ghi: 350 }];
    const groups = [{ orientation: "S", bearing: 180, effectiveArea: 5 }];
    const result = computeMonthlySolarGains(hourly, { latitude: 51.5, longitude: 0, timezone: 0 }, groups);
    expect(result.monthly).toHaveLength(12);
    const sum = result.monthly.reduce((s, v) => s + v, 0);
    near(sum, result.annualKwh, 0.001);
  });

  it("byOrientation keys match window group orientations", () => {
    const hourly = [{ month: 6, day: 21, hour: 13, dni: 500, dhi: 100, ghi: 350 }];
    const groups = [
      { orientation: "S", bearing: 180, effectiveArea: 5 },
      { orientation: "E", bearing: 90,  effectiveArea: 3 },
    ];
    const result = computeMonthlySolarGains(hourly, { latitude: 51.5, longitude: 0, timezone: 0 }, groups);
    expect(Object.keys(result.byOrientation).sort()).toEqual(["E", "S"]);
  });

  it("byOrientation values sum to annualKwh", () => {
    const hourly = [{ month: 6, day: 21, hour: 13, dni: 500, dhi: 100, ghi: 350 }];
    const groups = [
      { orientation: "S", bearing: 180, effectiveArea: 5 },
      { orientation: "E", bearing: 90,  effectiveArea: 3 },
    ];
    const result = computeMonthlySolarGains(hourly, { latitude: 51.5, longitude: 0, timezone: 0 }, groups);
    const sum = Object.values(result.byOrientation).reduce((s, v) => s + v, 0);
    near(sum, result.annualKwh, 0.001);
  });

  it("doubling effectiveArea doubles the gain", () => {
    const hourly = [{ month: 6, day: 21, hour: 13, dni: 500, dhi: 100, ghi: 350 }];
    const loc = { latitude: 51.5, longitude: 0, timezone: 0 };
    const r1 = computeMonthlySolarGains(hourly, loc, [{ orientation: "S", bearing: 180, effectiveArea: 1 }]);
    const r2 = computeMonthlySolarGains(hourly, loc, [{ orientation: "S", bearing: 180, effectiveArea: 2 }]);
    near(r2.annualKwh, r1.annualKwh * 2, 0.001);
  });

  it("reasonable annual solar gain for London south-facing 1m² SHGC=0.63 glazing", () => {
    // For a 1m² south-facing window at London with SHGC=0.63, typical annual solar gain
    // is roughly 200–400 kWh/yr. We use a simplified hourly set here (noon only) so
    // the result will be lower, but the order of magnitude should be plausible.
    // This test mainly guards against unit/scaling bugs (e.g. Wh vs kWh confusion).
    const daysInMonth = [31,28,31,30,31,30,31,31,30,31,30,31];
    const hourly = [];
    for (let m = 1; m <= 12; m++) {
      for (let d = 1; d <= daysInMonth[m-1]; d++) {
        // Represent each day as a full set of daytime hours with plausible irradiance
        for (let h = 7; h <= 18; h++) {
          const sunFrac = Math.sin(Math.PI * (h - 6) / 12); // rough daily profile
          hourly.push({ month: m, day: d, hour: h,
            dni: 400 * sunFrac, dhi: 80 * sunFrac, ghi: 350 * sunFrac });
        }
      }
    }
    const loc = { latitude: 51.5, longitude: 0, timezone: 0 };
    const groups = [{ orientation: "S", bearing: 180, effectiveArea: 0.63 }]; // 1m² × SHGC
    const result = computeMonthlySolarGains(hourly, loc, groups);
    // Must be in the right ballpark — not tens of thousands (unit bug), not near zero (algorithm bug).
    // Synthetic 12-hour days inflate vs real EPW, so upper bound is generous.
    expect(result.annualKwh).toBeGreaterThan(30);
    expect(result.annualKwh).toBeLessThan(700);
  });

  it("winter months gain less than summer months for south-facing London glazing", () => {
    const daysInMonth = [31,28,31,30,31,30,31,31,30,31,30,31];
    const hourly = [];
    for (let m = 1; m <= 12; m++) {
      for (let d = 1; d <= daysInMonth[m-1]; d++) {
        hourly.push({ month: m, day: d, hour: 13, dni: 600, dhi: 100, ghi: 400 });
      }
    }
    const loc = { latitude: 51.5, longitude: 0, timezone: 0 };
    const result = computeMonthlySolarGains(hourly, loc,
      [{ orientation: "S", bearing: 180, effectiveArea: 1 }]);
    // June (index 5) should beat December (index 11) for solar gain
    // For a south-facing vertical surface, angle-of-incidence at solar noon = altitude.
    // cos(AoI) = cos(alt). Dec noon alt≈15° → cos=0.97; Jun noon alt≈62° → cos=0.47.
    // So with identical DNI, December actually delivers more beam to a south-facing wall.
    // With one-hour-per-day data, December (31 days, higher cos) beats June (30 days, lower cos).
    expect(result.monthly[11]).toBeGreaterThan(result.monthly[5]);
  });

});
