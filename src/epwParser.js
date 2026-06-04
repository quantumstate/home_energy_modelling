// src/epwParser.js
//
// Parses EnergyPlus Weather (.epw) files in the browser.
//
// EPW structure
// ─────────────
// Line 1  : LOCATION, City, State/Region, Country, Source, WMO, Lat, Lon, TZ, Elev
// Lines 2–8 : Design conditions, typical/extreme periods, ground temps, etc.
// Lines 9+  : 8760 (or 8784 leap) hourly records, one per line
//
// Each hourly record field order (1-indexed, so subtract 1 for JS):
//   0  Year
//   1  Month
//   2  Day
//   3  Hour  (1–24)
//   4  Minute
//   5  Data source flags
//   6  Dry Bulb Temperature            °C
//   7  Dew Point Temperature           °C
//   8  Relative Humidity               %
//   9  Atmospheric Station Pressure    Pa
//  10  Extraterrestrial Horizontal Radiation  Wh/m²
//  11  Extraterrestrial Direct Normal Radiation Wh/m²
//  12  Horizontal Infrared Radiation Intensity Wh/m²
//  13  Global Horizontal Radiation     Wh/m²
//  14  Direct Normal Radiation         Wh/m²
//  15  Diffuse Horizontal Radiation    Wh/m²
//  21  Wind Direction                  °
//  22  Wind Speed                      m/s

const MONTH_NAMES = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
const HOURLY_DATA_START_LINE = 8; // 0-indexed: lines 0–7 are headers

// ─── Main export ──────────────────────────────────────────────────────────────

/**
 * Parse an EPW file text string.
 *
 * @param {string} text  Full contents of the .epw file.
 * @returns {EPWData}
 */
export function parseEPW(text) {
  const lines = text.split(/\r?\n/);

  // ── Location header ──────────────────────────────────────────────────────
  const loc = lines[0].split(",");
  const location = {
    city:        (loc[1] || "").trim(),
    region:      (loc[2] || "").trim(),
    country:     (loc[3] || "").trim(),
    source:      (loc[4] || "").trim(),
    wmo:         (loc[5] || "").trim(),
    latitude:    parseFloat(loc[6]),
    longitude:   parseFloat(loc[7]),
    timezone:    parseFloat(loc[8]),
    elevation:   parseFloat(loc[9]),
  };

  // ── Hourly records ────────────────────────────────────────────────────────
  const hourly = [];
  for (let i = HOURLY_DATA_START_LINE; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    const f = line.split(",");
    if (f.length < 16) continue;

    const dryBulb = parseFloat(f[6]);
    if (isNaN(dryBulb)) continue;

    hourly.push({
      month:   parseInt(f[1], 10),   // 1–12
      day:     parseInt(f[2], 10),   // 1–31
      hour:    parseInt(f[3], 10),   // 1–24
      dryBulb,
      dewPoint:   parseFloat(f[7]),
      rh:         parseFloat(f[8]),
      ghi:        parseFloat(f[13]), // Wh/m²  — global horiz. radiation
      dni:        parseFloat(f[14]), // Wh/m²  — direct normal radiation
      dhi:        parseFloat(f[15]), // Wh/m²  — diffuse horiz. radiation
      windDir:    parseFloat(f[21]),
      windSpeed:  parseFloat(f[22]),
    });
  }

  if (hourly.length === 0) throw new Error("No hourly records found in EPW file.");

  // ── Derived statistics ────────────────────────────────────────────────────
  const monthly = computeMonthlyStats(hourly);

  return { location, hourly, monthly };
}

// ─── HDD computation ──────────────────────────────────────────────────────────

/**
 * Compute annual heating degree days from hourly dry-bulb temperatures.
 *
 * Method: for each calendar day, average the 24 hourly readings, then
 *   HDD_day = max(0, baseTemp − dailyMean)
 * Annual HDD = Σ HDD_day.
 *
 * @param {object[]} hourly      Array of hourly records from parseEPW().
 * @param {number}   baseTemp    Base (balance-point) temperature, °C. Default 15.5 (CIBSE UK).
 * @returns {number}  Annual HDD in K·day.
 */
export function computeHDD(hourly, baseTemp = 15.5) {
  // Bucket hourly temps by "month-day" key
  const buckets = {};
  for (const h of hourly) {
    const key = `${h.month}-${h.day}`;
    if (!buckets[key]) buckets[key] = [];
    buckets[key].push(h.dryBulb);
  }
  let hdd = 0;
  for (const temps of Object.values(buckets)) {
    const mean = temps.reduce((s, t) => s + t, 0) / temps.length;
    if (mean < baseTemp) hdd += baseTemp - mean;
  }
  return hdd;
}

/**
 * Compute monthly HDD values (same algorithm, grouped by month).
 *
 * @param {object[]} hourly
 * @param {number}   baseTemp
 * @returns {number[]}  Array of 12 monthly HDD values (index 0 = January).
 */
export function computeMonthlyHDD(hourly, baseTemp = 15.5) {
  // Group by month → day → hours
  const byMonthDay = {};
  for (const h of hourly) {
    const key = `${h.month}-${h.day}`;
    if (!byMonthDay[key]) byMonthDay[key] = { month: h.month, temps: [] };
    byMonthDay[key].temps.push(h.dryBulb);
  }

  const monthlyHDD = new Array(12).fill(0);
  for (const { month, temps } of Object.values(byMonthDay)) {
    const mean = temps.reduce((s, t) => s + t, 0) / temps.length;
    if (mean < baseTemp) monthlyHDD[month - 1] += baseTemp - mean;
  }
  return monthlyHDD;
}

// ─── Monthly statistics ───────────────────────────────────────────────────────

/**
 * Compute per-month climate statistics from hourly data.
 *
 * @param {object[]} hourly
 * @returns {MonthStats[]}  Array of 12 objects (index 0 = January).
 */
function computeMonthlyStats(hourly) {
  const months = Array.from({ length: 12 }, (_, i) => ({
    name:       MONTH_NAMES[i],
    index:      i + 1,
    dryBulbs:   [],
    ghi:        [],
  }));

  for (const h of hourly) {
    const m = months[h.month - 1];
    m.dryBulbs.push(h.dryBulb);
    if (h.ghi >= 0) m.ghi.push(h.ghi);
  }

  return months.map(m => {
    const n      = m.dryBulbs.length;
    const mean   = n > 0 ? m.dryBulbs.reduce((s, t) => s + t, 0) / n : 0;
    const min    = n > 0 ? Math.min(...m.dryBulbs) : 0;
    const max    = n > 0 ? Math.max(...m.dryBulbs) : 0;
    const totalGhi = m.ghi.reduce((s, v) => s + v, 0); // Wh/m² for the month
    return {
      name:       m.name,
      index:      m.index,
      meanTemp:   mean,
      minTemp:    min,
      maxTemp:    max,
      totalGhiKwh: totalGhi / 1000, // kWh/m²
    };
  });
}
