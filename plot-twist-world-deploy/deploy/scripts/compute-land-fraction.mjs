// One-off, reproducible utility — NOT part of the shipped app bundle
// (nothing in src/ imports this; it never touches the Vite build).
//
// Computes what fraction of the game's actual Z17 tile grid is land, and
// prints the WORLD_LAND_TILES_ESTIMATE constant used by the world
// land-claimed indicator in PlotTwistWorld.jsx. Re-run this any time you
// want to sanity-check or refresh that number (e.g. against a newer
// Natural Earth release).
//
// Why this exists instead of just "29.2% of Earth is land": that figure is
// real *spherical surface area*, not area in the game's own coordinate
// system. The game's tiles are Web Mercator quadkey cells — equal in
// projected map space, not equal in real km². Mercator inflates area at
// higher latitudes, and most of Earth's land sits in the temperate north
// (Russia, Canada, northern Europe/Asia) where that inflation is largest,
// while a lot of the Southern Hemisphere's area is ocean. It also clips at
// the standard ±85.05112878° Web Mercator bound, which excludes nearly all
// (nearly all) of Antarctica from the grid entirely — there's no tile
// coordinate for it.
// Both effects push the true land-tile fraction meaningfully above the
// naive real-surface-area number — measured here as 38.35% vs. 29.2%.
//
// Two independent methods are computed and cross-checked:
//   1. Exact polygon area in the game's projected (wx,wy) tile space
//      (shoelace formula, after Sutherland-Hodgman clipping each ring to
//      the reachable latitude band — naive per-vertex clamping would
//      distort any polygon that crosses the clip line, e.g. Antarctica,
//      Greenland).
//   2. A 3000x3000 Monte Carlo point-in-polygon raster sample, as a
//      sanity check against the exact method.
// Last run: methods agreed to within 0.002 percentage points (38.3537%
// vs 38.3553%), ~6.589 billion estimated land tiles.
//
// Usage: node scripts/compute-land-fraction.mjs
// (downloads Natural Earth's 1:50m land polygons into this scripts/
// folder on first run, ~1.6MB, then reuses the cached copy)

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const DATA_URL = "https://raw.githubusercontent.com/nvkelso/natural-earth-vector/master/geojson/ne_50m_land.geojson";
const DATA_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), "ne_50m_land.geojson");

// mirrors the exact formulas in PlotTwistWorld.jsx (MAXLAT / lonToWx /
// latToWy / wyToLat) — must stay identical, or this measures a different
// projection than the one the game's tile grid actually uses
const MAXLAT = 85.05112878;
const lonToWx = (lon) => (lon + 180) / 360;
const latToWy = (lat) => {
  const s = Math.sin((lat * Math.PI) / 180);
  return 0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI);
};
const wyToLat = (wy) => (Math.atan(Math.sinh(Math.PI * (1 - 2 * wy))) * 180) / Math.PI;

async function loadLandPolygons() {
  if (!fs.existsSync(DATA_PATH)) {
    console.log(`downloading ${DATA_URL} ...`);
    const res = await fetch(DATA_URL);
    if (!res.ok) throw new Error(`download failed: ${res.status}`);
    fs.writeFileSync(DATA_PATH, await res.text());
  }
  const geojson = JSON.parse(fs.readFileSync(DATA_PATH, "utf8"));
  const polygons = [];
  for (const f of geojson.features) {
    const g = f.geometry;
    if (!g) continue;
    if (g.type === "Polygon") polygons.push(g.coordinates);
    else if (g.type === "MultiPolygon") for (const poly of g.coordinates) polygons.push(poly);
  }
  console.log(`loaded ${polygons.length} polygons from ${geojson.features.length} features`);
  return polygons;
}

// ---------- method 1: exact projected-space polygon area ----------

function clipRingByLat(ring, bound, keepBelow) {
  const out = [];
  const inside = (p) => (keepBelow ? p[1] <= bound : p[1] >= bound);
  const intersect = (a, b) => {
    const t = (bound - a[1]) / (b[1] - a[1]);
    return [a[0] + t * (b[0] - a[0]), bound];
  };
  for (let i = 0; i < ring.length; i++) {
    const cur = ring[i];
    const prev = ring[(i - 1 + ring.length) % ring.length];
    const curIn = inside(cur), prevIn = inside(prev);
    if (curIn) {
      if (!prevIn) out.push(intersect(prev, cur));
      out.push(cur);
    } else if (prevIn) {
      out.push(intersect(prev, cur));
    }
  }
  return out;
}
function clipRingToBand(ring) {
  let r = clipRingByLat(ring, MAXLAT, true);
  if (r.length < 3) return [];
  r = clipRingByLat(r, -MAXLAT, false);
  if (r.length < 3) return [];
  return r;
}
function ringAreaWxWy(ring) {
  const proj = ring.map(([lon, lat]) => [lonToWx(lon), latToWy(lat)]);
  let sum = 0;
  for (let i = 0; i < proj.length; i++) {
    const [x1, y1] = proj[i];
    const [x2, y2] = proj[(i + 1) % proj.length];
    sum += x1 * y2 - x2 * y1;
  }
  return Math.abs(sum) / 2;
}
function polygonAreaWxWy(rings) {
  if (!rings.length) return 0;
  const ext = clipRingToBand(rings[0]);
  if (ext.length < 3) return 0;
  let area = ringAreaWxWy(ext);
  for (let i = 1; i < rings.length; i++) {
    const hole = clipRingToBand(rings[i]);
    if (hole.length >= 3) area -= ringAreaWxWy(hole);
  }
  return Math.max(0, area);
}

// ---------- method 2: raster sanity check ----------

function pointInRing(x, y, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i], [xj, yj] = ring[j];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}
function pointInPolygon(lon, lat, rings, bbox) {
  if (lon < bbox[0] || lon > bbox[2] || lat < bbox[1] || lat > bbox[3]) return false;
  if (!pointInRing(lon, lat, rings[0])) return false;
  for (let i = 1; i < rings.length; i++) if (pointInRing(lon, lat, rings[i])) return false;
  return true;
}

async function main() {
  const polygons = await loadLandPolygons();

  let totalArea = 0;
  for (const poly of polygons) totalArea += polygonAreaWxWy(poly);
  console.log(`method 1 (exact, clipped): land fraction of grid = ${(totalArea * 100).toFixed(4)}%`);

  const bboxes = polygons.map((rings) => {
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const [lon, lat] of rings[0]) {
      if (lon < minX) minX = lon; if (lon > maxX) maxX = lon;
      if (lat < minY) minY = lat; if (lat > maxY) maxY = lat;
    }
    return [minX, minY, maxX, maxY];
  });

  // coarse 10deg x 10deg bucket index so each sample point only tests
  // polygons whose bbox overlaps its bucket, not all of them
  const BUCKET_DEG = 10, bucketsX = 36, bucketsY = 18;
  const buckets = Array.from({ length: bucketsX * bucketsY }, () => []);
  const bx = (lon) => Math.min(bucketsX - 1, Math.max(0, Math.floor((lon + 180) / BUCKET_DEG)));
  const by = (lat) => Math.min(bucketsY - 1, Math.max(0, Math.floor((lat + 90) / BUCKET_DEG)));
  polygons.forEach((_, p) => {
    const [minX, minY, maxX, maxY] = bboxes[p];
    for (let gy = by(minY); gy <= by(maxY); gy++)
      for (let gx = bx(minX); gx <= bx(maxX); gx++)
        buckets[gy * bucketsX + gx].push(p);
  });

  const SAMPLES = 3000;
  let landHits = 0;
  for (let iy = 0; iy < SAMPLES; iy++) {
    const wy = (iy + 0.5) / SAMPLES;
    const lat = wyToLat(wy);
    const gy = by(lat);
    for (let ix = 0; ix < SAMPLES; ix++) {
      const wx = (ix + 0.5) / SAMPLES;
      const lon = wx * 360 - 180;
      const cands = buckets[gy * bucketsX + bx(lon)];
      for (let c = 0; c < cands.length; c++) {
        const p = cands[c];
        if (pointInPolygon(lon, lat, polygons[p], bboxes[p])) { landHits++; break; }
      }
    }
  }
  const rasterFraction = landHits / (SAMPLES * SAMPLES);
  console.log(`method 2 (${SAMPLES}x${SAMPLES} raster sample): land fraction of grid = ${(rasterFraction * 100).toFixed(4)}%`);
  console.log(`agreement: ${(Math.abs(totalArea - rasterFraction) * 100).toFixed(4)} percentage points apart`);

  const N = 1 << 17;
  console.log(`\nZ17 tile grid is ${N}x${N} = ${(N * N).toLocaleString()} total cells`);
  console.log(`method 1 estimate: ${Math.round(totalArea * N * N).toLocaleString()} land tiles`);
  console.log(`method 2 estimate: ${Math.round(rasterFraction * N * N).toLocaleString()} land tiles`);
  console.log(`\nWORLD_LAND_TILES_ESTIMATE = Math.round(N * N * ${totalArea.toFixed(6)});`);
}

main();
