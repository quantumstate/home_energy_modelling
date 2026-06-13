// Solar gain calculations for vertical glazed surfaces.
//
// Solar position: Spencer (1971) algorithm, accurate to ~0.01° for altitude/azimuth.
// Incident irradiance: isotropic sky diffuse model (Duffie & Beckman).

const D2R = Math.PI / 180;
const R2D = 180 / Math.PI;

function dayOfYear(month, day) {
  const dim = [0, 31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  let doy = day;
  for (let m = 1; m < month; m++) doy += dim[m];
  return doy;
}

/**
 * Compute solar altitude and azimuth for a given location and time.
 *
 * @param {number} latDeg    Site latitude (°, positive north)
 * @param {number} lonDeg    Site longitude (°, positive east)
 * @param {number} timezone  UTC offset (hours)
 * @param {number} month     1–12
 * @param {number} day       1–31
 * @param {number} hourEPW   EPW hour 1–24 (end-of-hour convention; mid-point used)
 * @returns {{ altitude: number, azimuth: number, aboveHorizon: boolean }}
 *   altitude in degrees above horizon; azimuth in degrees from north, clockwise.
 */
export function solarPosition(latDeg, lonDeg, timezone, month, day, hourEPW) {
  const hourDec = hourEPW - 0.5; // EPW uses end-of-hour; take mid-point
  const doy = dayOfYear(month, day);
  const B = (2 * Math.PI / 365) * (doy - 1);

  // Equation of time (minutes) — Spencer 1971
  const EqT = 229.18 * (
    0.000075
    + 0.001868 * Math.cos(B)   - 0.032077 * Math.sin(B)
    - 0.014615 * Math.cos(2*B) - 0.040890 * Math.sin(2*B)
  );

  // Apparent solar time (hours)
  const solarTime = hourDec + EqT / 60 + (lonDeg - timezone * 15) / 15;

  // Hour angle (degrees; negative = morning, positive = afternoon)
  const ha  = (solarTime - 12) * 15;

  // Solar declination (degrees) — Spencer 1971
  const decl = R2D * (
    0.006918
    - 0.399912 * Math.cos(B)   + 0.070257 * Math.sin(B)
    - 0.006758 * Math.cos(2*B) + 0.000907 * Math.sin(2*B)
    - 0.002697 * Math.cos(3*B) + 0.001480 * Math.sin(3*B)
  );

  const lat = latDeg * D2R;
  const dec = decl  * D2R;
  const h   = ha    * D2R;

  // Solar altitude
  const sinAlt = Math.sin(lat)*Math.sin(dec) + Math.cos(lat)*Math.cos(dec)*Math.cos(h);
  const alt = Math.asin(Math.max(-1, Math.min(1, sinAlt)));
  if (alt <= 0) return { altitude: 0, azimuth: 180, aboveHorizon: false };

  // Azimuth from south (positive west), using Duffie & Beckman formula:
  //   cos(γs) = [sin(α)·sin(φ) − sin(δ)] / [cos(α)·cos(φ)]
  // Note the sign: sin(alt)*sin(lat) − sin(dec), NOT the reverse.
  const cosAlt = Math.cos(alt);
  const cosAz  = (Math.sin(alt)*Math.sin(lat) - Math.sin(dec)) / (cosAlt * Math.cos(lat));
  const sinAz  = Math.cos(dec) * Math.sin(h) / cosAlt;
  const gammaS = Math.atan2(sinAz, cosAz) * R2D; // from south, + = west
  const azNorth = ((180 + gammaS) % 360 + 360) % 360;

  return { altitude: alt * R2D, azimuth: azNorth, aboveHorizon: true };
}

/**
 * Incident solar irradiance (Wh/m²) on a vertical surface.
 *
 * Uses the isotropic sky diffuse model:
 *   Beam component:            DNI × cos(angle_of_incidence)   [only when sun faces surface]
 *   Isotropic diffuse:         DHI × 0.5                        [(1+cos 90°)/2]
 *   Ground-reflected diffuse:  GHI × albedo × 0.5              [(1−cos 90°)/2], albedo = 0.2
 *
 * @param {number} altDeg         Solar altitude (°)
 * @param {number} azSun          Solar azimuth from north CW (°)
 * @param {number} surfaceBearing Surface outward normal, from north CW (°)
 * @param {number} dni            Direct normal irradiance (Wh/m²)
 * @param {number} dhi            Diffuse horizontal irradiance (Wh/m²)
 * @param {number} ghi            Global horizontal irradiance (Wh/m²)
 * @returns {number} Total incident irradiance (Wh/m²)
 */
export function verticalIncident(altDeg, azSun, surfaceBearing, dni, dhi, ghi) {
  const diffuse = Math.max(0, dhi) * 0.5;
  const ground  = Math.max(0, ghi) * 0.2 * 0.5;
  if (altDeg <= 0 || dni <= 0) return diffuse + ground;

  const alt  = altDeg * D2R;
  const dAz  = (azSun - surfaceBearing) * D2R;
  // cos(θ) for a vertical surface tilted at 90°:
  const cosTheta = Math.cos(alt) * Math.cos(dAz);
  const beam = cosTheta > 0 ? dni * cosTheta : 0;

  return beam + diffuse + ground;
}

/**
 * Compute monthly solar heat gains transmitted through windows using EPW hourly data.
 *
 * @param {object[]} hourly        EPW hourly records (from parseEPW)
 * @param {object}   location      EPW location { latitude, longitude, timezone }
 * @param {object[]} windowGroups  Array of { bearing, effectiveArea, orientation }
 *                                 effectiveArea = Σ(area × SHGC) for windows in that group (m²)
 * @returns {{
 *   monthly:       number[],              // kWh gained per calendar month (length 12)
 *   annualKwh:     number,                // total annual solar gain (kWh)
 *   byOrientation: Record<string,number>, // kWh per orientation label
 * }}
 */
export function computeMonthlySolarGains(hourly, location, windowGroups) {
  if (!windowGroups.length) {
    return { monthly: new Array(12).fill(0), annualKwh: 0, byOrientation: {} };
  }

  const { latitude, longitude, timezone } = location;
  const monthly       = new Array(12).fill(0); // accumulated in Wh
  const byOrientation = {};
  for (const { orientation } of windowGroups) byOrientation[orientation] = 0;

  for (const rec of hourly) {
    const { month, day, hour, dni, dhi, ghi } = rec;
    if (!Number.isFinite(ghi) || !Number.isFinite(dni) || !Number.isFinite(dhi)) continue;
    if (ghi <= 0 && dhi <= 0 && dni <= 0) continue;

    const pos = solarPosition(latitude, longitude, timezone, month, day, hour);

    for (const { bearing, effectiveArea, orientation } of windowGroups) {
      const incident = verticalIncident(pos.altitude, pos.azimuth, bearing, dni, dhi, ghi);
      const gainWh   = incident * effectiveArea;
      monthly[month - 1]      += gainWh;
      byOrientation[orientation] += gainWh;
    }
  }

  return {
    monthly:       monthly.map(v => v / 1000),
    annualKwh:     monthly.reduce((s, v) => s + v, 0) / 1000,
    byOrientation: Object.fromEntries(
      Object.entries(byOrientation).map(([k, v]) => [k, v / 1000])
    ),
  };
}
