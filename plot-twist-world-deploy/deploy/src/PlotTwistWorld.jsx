import { useState, useEffect, useRef, useCallback, useReducer } from "react";
import { supabase, MULTIPLAYER } from "./storage.js";
import { signInWithGoogle, signOut, onAuthStateChange } from "./auth.js";
// Inlined rather than referenced by URL: Vite's separate-chunk worker
// resolution (new Worker(new URL(...), import.meta.url)) has documented
// failure modes specifically with a relative build base ("./", which this
// project uses for GitHub Pages subpath hosting) — the URL can resolve to
// the wrong place, and a Worker constructed from a bad URL never throws
// synchronously, so the failure is silent. Inlining removes the separate
// file/URL entirely: the worker's whole bundle travels as a data URL inside
// the main chunk, so there's nothing for a base-path mismatch to break.
import VectorWorker from "./vectorWorker.js?worker&inline";

/* ─────────────────────────────────────────────────────────────
   PLOT TWIST: WORLD DEED — one shared Earth, ~300m tiles.
   Real coastlines (Natural Earth), quadkey grid, live trading.
   Virtual money only. Parody ads. No real anything.
   ───────────────────────────────────────────────────────────── */

// Bumped by hand alongside any fix worth confirming actually shipped —
// shows in the debug panel so a stale cached bundle is immediately obvious
// instead of looking like the bug is still unfixed.
const BUILD_TAG = "2026-07-09.4-concurrency-and-margin-tuning";

const Z = 17;                 // parcel zoom: ~306m tiles at the equator
const N = 1 << Z;             // tiles per axis

/* district-preview LOD: continuously choose a coarser quadkey depth so
   color cells stay a sensible on-screen size at any zoom, spanning from
   ~20km cells (country/region scale) down to ~600m (just above the real
   ~306m deed grid, which takes over entirely once gridOn kicks in). */
const PREVIEW_T = 26;       // target on-screen cell size, px
const PREVIEW_Z_MIN = 11;   // ~19.6km cells at the equator
const PREVIEW_Z_MAX = 16;   // ~611m cells at the equator
function previewLevelFor(s) {
  const z = Math.round(Math.log2(s / PREVIEW_T));
  return Math.max(PREVIEW_Z_MIN, Math.min(PREVIEW_Z_MAX, z));
}

/* ── real vector geography: Protomaps hosted OSM basemap ─────────────
   Actual water/land-use polygons and building footprints, not a color
   guess — decoded client-side from Mapbox Vector Tiles (MVT/PBF). Free
   for non-commercial use with a Protomaps API key (see README). Used
   ONLY to decide classification; the CARTO raster tiles elsewhere in
   this file remain the visual basemap, unchanged. */
const PROTOMAPS_KEY = import.meta.env.VITE_PROTOMAPS_KEY || "";
const VECTOR_Z = 14; // ~2.4km reference tiles — fixed, independent of
// display zoom, so a given real-world spot always classifies the same
// way regardless of how zoomed in the camera happens to be
const VECTOR_EXTENT = 4096; // standard MVT tile-local coordinate space

// Real OSM land-use kinds (see docs.protomaps.com/basemaps/layers_v2)
// mapped to our district tiers. Unlisted kinds fall through to the
// building-density estimate below.
const LANDUSE_TIER = {
  commercial: "downtown", retail: "downtown",
  residential: "urban",
  industrial: "suburbs", brownfield: "suburbs", railway: "suburbs", quarry: "suburbs", military: "suburbs", naval_base: "suburbs", airfield: "suburbs",
  park: "rural", garden: "rural", national_park: "rural", nature_reserve: "rural", forest: "rural", farmland: "rural", cemetery: "rural", golf_course: "rural", recreation_ground: "rural", grass: "rural", orchard: "rural", winter_sports: "rural", beach: "rural", zoo: "rural",
};

function pointInRing(x, y, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const xi = ring[i].x, yi = ring[i].y, xj = ring[j].x, yj = ring[j].y;
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}
function pointInFeatureGeom(geom, x, y) {
  let inside = false;
  for (const ring of geom) if (pointInRing(x, y, ring)) inside = !inside;
  return inside;
}

// pointInDecoded is used by classifyFromVector below to test the pre-decoded,
// bbox-indexed geometry the worker hands back — decoding itself now happens
// in vectorWorker.js, off the main thread.
function pointInDecoded(feat, x, y) {
  if (x < feat.minX || x > feat.maxX || y < feat.minY || y > feat.maxY) return false;
  return pointInFeatureGeom(feat.geom, x, y);
}

// squared distance from point (px,py) to segment (ax,ay)-(bx,by) — used for
// real coastal-proximity testing (see classifyFromVector), since a water
// feature's bounding box alone hugely overclaims "near water" on any
// concave shoreline (bays, inlets, river bends): the bbox can extend far
// past the water itself, tagging inland land as coastal.
function distToSegSq(px, py, ax, ay, bx, by) {
  const dx = bx - ax, dy = by - ay;
  const len2 = dx * dx + dy * dy;
  let t = len2 > 0 ? ((px - ax) * dx + (py - ay) * dy) / len2 : 0;
  t = Math.max(0, Math.min(1, t));
  const cx = ax + t * dx, cy = ay + t * dy;
  const ex = px - cx, ey = py - cy;
  return ex * ex + ey * ey;
}
const REGION_LEN = 8;         // shared-storage shard prefix (~150km regions)

const C = {
  ink: "#0A1622", panel: "#111C2B", hair: "#243146",
  ocean: "#0A2233", oceanDeep: "#081B2A", landFill: "#22384A",
  amber: "#FFC24B", text: "#E8EDF5", dim: "#8DA0B8",

  // ── premium-pass additions (purely additive — nothing above this line
  // changed, so every existing usage keeps rendering exactly as before) ──
  amberDeep: "#E29A2E",  // shadowed edge of the amber gradient (buttons, glows)
  amberSoft: "#FFD98A",  // lit edge of the amber gradient / hover highlight
  panelHi: "#16233570",  // panel-tinted glass highlight (top edge of cards/sheets)
  hairLit: "#33445E",    // brighter hairline for hover/focus states
  glow: "rgba(255,194,75,0.30)",
  glowStrong: "rgba(255,194,75,0.5)",
  shadowSm: "0 2px 10px rgba(2,7,14,0.35)",
  shadowMd: "0 10px 28px rgba(2,7,14,0.45)",
  shadowLg: "0 20px 56px rgba(2,7,14,0.55)",
  amberGrad: "linear-gradient(180deg, #FFD98A 0%, #FFC24B 45%, #E29A2E 100%)",
  panelGrad: "linear-gradient(180deg, #14213380 0%, #0F1A2900 60%)",
};
const blur = (px) => ({ backdropFilter: `blur(${px}px)`, WebkitBackdropFilter: `blur(${px}px)` });
// shared card surface (assets/market rows, HQ panels+stat tiles) — one
// gradient+shadow treatment so every list/panel in the app reads as the
// same material instead of each screen inventing its own flat rectangle
const cardSty = { background: `${C.panel}cc`, backgroundImage: C.panelGrad, border: `1px solid ${C.hairLit}`, boxShadow: C.shadowSm };
const inputSty = { background: `${C.ink}b3`, color: C.text, border: `1px solid ${C.hairLit}`, outlineColor: C.amber };

// Tuned for a ~45-70 minute payback period per tier (was ~3.5 minutes) and
// roughly 35-40x less revenue per tile — with 300m+ tiles on the planet,
// the old numbers let a player's income snowball into buying the whole
// world in an afternoon; the limiting factor should be how fast someone can
// click buy, not how fast money compounds. MUST match tile_class in
// supabase.sql exactly — the server is authoritative for real transactions,
// this copy only drives client-side display (rentOf/upCost/netWorth).
const CLS = {
  downtown:   { name: "Downtown",   price: 800, rps: 0.225,  color: "#F0784E" },
  waterfront: { name: "Waterfront", price: 500, rps: 0.135,  color: "#3FB8AF" },
  urban:      { name: "Urban",      price: 400, rps: 0.105,  color: "#9B7BF5" },
  coast:      { name: "Coast",      price: 200, rps: 0.0525, color: "#4FA3C7" },
  suburbs:    { name: "Suburbs",    price: 150, rps: 0.0375, color: "#6E8F7C" },
  rural:      { name: "Rural",      price: 50,  rps: 0.0135, color: "#B08D57" },
  water:      { name: "Open water", price: 50,  rps: 0.009,  color: "#4A7FA5", sale: false },
  land:       { name: "Inland",     price: 400, rps: 1.6,   color: "#7BA88A" }, // legacy saves only
  pending:    { name: "Surveying…", price: 0,   rps: 0,     color: "#5A6472", sale: false }, // real vector data hasn't loaded for this spot yet
};
const LEGEND = ["downtown", "waterfront", "urban", "coast", "suburbs", "rural"];

const RAR = [
  { name: "Common",    m: 1,   color: "#93A3B8" },
  { name: "Uncommon",  m: 1.5, color: "#5FD68B" },
  { name: "Rare",      m: 3,   color: "#5FA8F5" },
  { name: "Legendary", m: 8,   color: "#FFC24B" },
];
const LVL = ["Vacant tile", "Cottage", "Duplex", "Apartments", "Tower"];
const MAX_LVL = 4;

// Mirrors reset_daily_energy()/buy_unowned_tile's energy gate in
// supabase.sql — display-only, the server is the sole authority on the
// real value. Gates claiming NEW unowned land specifically (not trading or
// upgrading), so wealth/click-speed alone can't sprawl across the whole
// map instantly. Hard daily cap, no banking — resets once per UTC day, at
// whatever this player's current status tier grants (see STATUS_TIERS).

// MUST match status_tier in supabase.sql exactly. Sticky/high-water-mark:
// driven by peak_net_worth (all-time-highest net worth this account has
// ever reached), never demotes for spending down or losing tiles. Tier 6's
// cap of 20 is the old unconditional energy default from before the
// daily-cap rework — you used to start with it for free, now you earn
// your way back to it.
// `slots` = max tiles this tier can have under construction at once —
// MUST match status_tier.builder_slots in supabase.sql exactly.
const STATUS_TIERS = [
  { tier: 1, name: "Squatter",    min: 0,       cap: 10, slots: 2 },
  { tier: 2, name: "Homesteader", min: 5000,    cap: 12, slots: 2 },
  { tier: 3, name: "Landholder",  min: 25000,   cap: 14, slots: 3 },
  { tier: 4, name: "Developer",   min: 100000,  cap: 16, slots: 3 },
  { tier: 5, name: "Baron",       min: 500000,  cap: 18, slots: 4 },
  { tier: 6, name: "Magnate",     min: 2000000, cap: 20, slots: 4 },
];
// Highest tier whose threshold this net worth clears, plus the next tier
// up (null once already at the top) for progress-bar display.
const statusFor = (netWorth) => {
  const nw = netWorth || 0;
  let idx = 0;
  for (let i = 0; i < STATUS_TIERS.length; i++) if (nw >= STATUS_TIERS[i].min) idx = i;
  return { ...STATUS_TIERS[idx], next: STATUS_TIERS[idx + 1] || null };
};

// PvP: mirrors attack_tile()'s hardcoded caps in supabase.sql — flat for
// every player regardless of status tier, unlike energy's cap.
const ATTACK_DAILY_CAP = 3;    // attacks a player may LAUNCH per UTC day
const ATTACK_RECEIVED_CAP = 2; // attacks a single TILE may absorb per UTC day

const ADS = [
  { brand: "Bolder Boulders", line: "Rocks, but bolder." },
  { brand: "Grandma's Artisanal Gravel", line: "Chew responsibly." },
  { brand: "InvisiBlinds", line: "Window blinds you can't see." },
  { brand: "Soup Loans", line: "Liquid assets, instantly." },
  { brand: "Pigeon Mail Pro", line: "Unlimited data. Bring crumbs." },
  { brand: "The Ladder Store", line: "This ad is a step up." },
  { brand: "Mildly Haunted Realty", line: "Every home has character(s)." },
  { brand: "Actual Cloud Storage", line: "0% uptime. 100% sky." },
];



const ACH = [
  { k: "deed1",  name: "First deed",     desc: "Claim your first tile" },
  { k: "deed10", name: "Landlord",       desc: "Own 10 tiles" },
  { k: "globe",  name: "Globetrotter",   desc: "Own tiles in 3+ regions" },
  { k: "lux",    name: "Legendary find", desc: "Roll a Legendary deed" },
  { k: "tower",  name: "Skyline",        desc: "Build a Tower (Lv 4)" },
  { k: "trader", name: "Trader",         desc: "Sell a tile to another player" },
  { k: "rich",   name: "Deep pockets",   desc: "Hold ₲50,000 at once" },
  { k: "streak3",name: "Regular",        desc: "3-day visit streak" },
  { k: "redevelop1", name: "Redeveloper", desc: "Tear down and rebuild a maxed-out tile" },
  { k: "conqueror", name: "Conqueror", desc: "Win a PvP attack and capture a tile" },
];

/* ── math: mercator + quadkeys ──────────────────────────────── */

const MAXLAT = 85.05112878;
const lonToWx = (lon) => (lon + 180) / 360;
const latToWy = (lat) => {
  lat = Math.max(-MAXLAT, Math.min(MAXLAT, lat));
  const s = Math.sin((lat * Math.PI) / 180);
  return 0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI);
};
const wyToLat = (wy) => (Math.atan(Math.sinh(Math.PI * (1 - 2 * wy))) * 180) / Math.PI;

function qkOf(tx, ty) {
  let q = "";
  for (let i = Z; i > 0; i--) {
    const m = 1 << (i - 1);
    q += (tx & m ? 1 : 0) + (ty & m ? 2 : 0);
  }
  return q;
}
function txyOf(qk) {
  let tx = 0, ty = 0;
  for (const ch of qk) { tx = tx * 2 + (ch === "1" || ch === "3" ? 1 : 0); ty = ty * 2 + (ch === "2" || ch === "3" ? 1 : 0); }
  return [tx, ty];
}
const centerOfQk = (qk) => { const [tx, ty] = txyOf(qk); const n = 1 << qk.length; return [(tx + 0.5) / n, (ty + 0.5) / n]; };

// PvP: up to 4 orthogonal (N/S/E/W) neighbor quadkeys, clamped at the grid
// edge — plpgsql-equivalent mirror of qk_neighbors() in supabase.sql. This
// copy is display/disabled-state only; attack_tile() recomputes adjacency
// itself server-side, this never gates the real outcome.
function neighborsOf(qk) {
  const [tx, ty] = txyOf(qk);
  const out = [];
  if (ty > 0) out.push(qkOf(tx, ty - 1));
  if (ty < N - 1) out.push(qkOf(tx, ty + 1));
  if (tx > 0) out.push(qkOf(tx - 1, ty));
  if (tx < N - 1) out.push(qkOf(tx + 1, ty));
  return out;
}
const regionOf = (qk) => qk.slice(0, REGION_LEN);

function prefixesFor(camv, sz, cap = 9) {
  const out = [];
  const { s, x: ox, y: oy } = camv;
  const { w, h } = sz;
  const nR = 1 << REGION_LEN, rpx = s / nR;
  const rx0 = Math.max(0, Math.floor(-ox / rpx)), ry0 = Math.max(0, Math.floor(-oy / rpx));
  const rx1 = Math.min(nR - 1, Math.floor((w - ox) / rpx)), ry1 = Math.min(nR - 1, Math.floor((h - oy) / rpx));
  for (let ry = ry0; ry <= ry1 && out.length < cap; ry++)
    for (let rx = rx0; rx <= rx1 && out.length < cap; rx++) {
      let q = "";
      for (let i = REGION_LEN; i > 0; i--) {
        const m = 1 << (i - 1);
        q += (rx & m ? 1 : 0) + (ry & m ? 2 : 0);
      }
      out.push(q);
    }
  return out;
}

function coordLabel(qk) {
  const [wx, wy] = centerOfQk(qk);
  const lat = wyToLat(wy), lon = wx * 360 - 180;
  return `${Math.abs(lat).toFixed(2)}°${lat >= 0 ? "N" : "S"} ${Math.abs(lon).toFixed(2)}°${lon >= 0 ? "E" : "W"}`;
}

/* ── real urban geography: Natural Earth populated places ───── */

const CITY_DATA = [["Tokyo",3569,13975,755],["New York",4075,-7398,728],["Mexico City",1944,-9913,728],["Mumbai",1902,7286,728],["São Paulo",-2356,-4663,728],["Delhi",2867,7723,720],["Shanghai",3122,12143,718],["Kolkata",2250,8832,717],["Dhaka",2373,9041,711],["Buenos Aires",-3460,-5840,711],["Los Angeles",3399,-11818,710],["Karachi",2487,6699,708],["Cairo",3005,3125,708],["Rio de Janeiro",-2292,-4323,707],["Manila",1461,12098,705],["Ōsaka",3475,13546,705],["Beijing",3993,11639,705],["Moscow",5575,3761,702],["Istanbul",4111,2901,700],["Paris",4887,233,700],["Seoul",3757,12700,699],["Lagos",645,339,698],["Jakarta",-617,10683,696],["Guangzhou",2315,11332,695],["Chicago",4183,-8775,695],["London",5150,-12,693],["Lima",-1205,-7705,690],["Tehran",3567,5142,690],["Kinshasa",-433,1531,689],["Bogota",460,-7409,689],["Shenzhen",2255,11412,688],["Wuhan",3058,11427,686],["Tianjin",3913,11720,686],["Chennai",1309,8028,686],["Hong Kong",2231,11418,686],["Taipei",2504,12157,684],["Bangkok",1375,10051,683],["Bengaluru",1297,7756,683],["Lahore",3156,7435,682],["Chongqing",2957,10659,681],["Hyderabad",1740,7848,680],["Amaravati",1653,8052,676],["Santiago",-3345,-7067,676],["Belo Horizonte",-1991,-4392,675],["Miami",2579,-8023,675],["Madrid",4040,-369,675],["Philadelphia",4000,-7517,674],["Ho Chi Minh City",1078,10669,673],["Ahmedabad",2303,7258,673],["Toronto",4370,-7942,672],["Luanda",-884,1323,671],["Singapore",129,10385,671],["Baghdad",3334,4439,670],["Barcelona",4139,218,669],["Haora",2258,8833,668],["Dallas",3282,-9684,668],["Khartoum",1559,3253,668],["Shenyeng",4181,12345,668],["Pune",1853,7385,667],["Sydney",-3392,15118,667],["St.  Petersburg",5994,3031,666],["Dongguan",2305,11374,666],["Chattogram",2233,9180,666],["Boston",4233,-7107,665],["Houston",2982,-9534,665],["Atlanta",3383,-8440,665],["Riyadh",2464,4677,665],["Hanoi",2104,10585,664],["Washington,  D.C.",3890,-7701,664],["Guadalajara",2067,-10333,662],["Alexandria",3120,2995,662],["Chengdu",3067,10407,662],["Melbourne",-3782,14497,662],["Detroit",4233,-8308,661],["Yangon",1679,9616,661],["Xian",3428,10889,660],["New Taipei",2501,12147,659],["Porto Alegre",-3005,-5120,659],["Hechi",2470,10808,658],["Surat",2120,7284,658],["Abidjan",532,-404,658],["Yokohama",3543,13960,657],["Ankara",3993,3286,657],["Nanjing",3205,11878,657],["Brasília",-1578,-4792,657],["Montréal",4550,-7359,657],["Monterrey",2567,-10033,657],["Guiyang",2658,10672,656],["Harbin",4575,12665,656],["Fortaleza",-375,-3858,656],["Recife",-807,-3492,656],["Zhangzhou",2452,11767,655],["Phoenix",3354,-11207,655],["Ürümqi",4381,8757,655],["Busan",3510,12901,654],["Salvador",-1297,-3848,654],["San Francisco",3777,-12242,654],["Johannesburg",-2617,2803,654],["Algiers",3677,305,653],["Berlin",5252,1340,653],["Pyongyang",3902,12575,652],["Medellín",628,-7558,652],["Kabul",3452,6918,652],["Rome",4190,1248,652],["Nagoya",3516,13691,651],["Athens",3799,2373,651],["Cape Town",-3392,1843,651],["Dalian",3892,12163,650],["Kano",1200,852,650],["Changchun",4387,12534,650],["Kanpur",2646,8032,650],["Casablanca",3360,-762,650],["Zibo",3680,11805,649],["Seattle",4757,-12234,649],["Tel Aviv",3208,3477,649],["Curitiba",-2542,-4932,649],["Addis Ababa",904,3870,649],["Irvine",3368,-11783,648],["Benoni",-2615,2833,648],["Jeddah",2152,3922,648],["Hangzhou",3025,12017,648],["Nairobi",-128,3681,648],["Stuttgart",4878,920,647],["Dar es Salaam",-680,3927,647],["Milan",4547,920,647],["Kunming",2507,10268,647],["Caracas",1050,-6692,647],["Qingdao",3609,12033,646],["San Diego",3282,-11718,646],["Frankfurt",5010,868,646],["Taiyuan",3788,11254,646],["Jaipur",2692,7581,646],["Fukuoka",3360,13041,645],["Campinas",-2290,-4710,645],["Lisbon",3872,-915,645],["Surabaya",-725,11275,645],["Jinan",3668,11699,645],["Quezon City",1465,12103,644],["Katowice",5026,1902,644],["Kaohsiung",2263,12027,644],["Aleppo",3623,3717,644],["Durban",-2986,3098,644],["Giza",3001,3119,643],["Lucknow",2686,8091,643],["Kyiv",5044,3051,643],["Faisalabad",3141,7311,642],["Ibadan",738,393,642],["Taichung",2415,12068,642],["Minneapolis",4498,-9325,642],["Fuzhou",2608,11930,642],["Changsha",2820,11297,642],["Zhengzhou",3476,11366,642],["Dakar",1472,-1748,642],["Xiangtan",2785,11290,641],["Incheon",3748,12664,641],["İzmir",3844,2715,641],["Lanzhou",3606,10379,641],["Sapporo",4308,14134,641],["Xiamen",2445,11808,640],["George Town",541,10033,640],["Guayaquil",-222,-7992,640],["Daegu",3587,12861,639],["San Juan",1844,-6613,639],["Damascus",3350,3630,639],["Nagpur",2117,7909,639],["Mashhad",3627,5957,639],["Bekasi",-622,10697,638],["Jinxi",4075,12083,638],["Jilin",4385,12655,638],["Omdurman",1562,3248,638],["Shijiazhuang",3805,11448,638],["Tunis",3680,1018,638],["Bandung",-695,10757,638],["Vienna",4820,1636,638],["Mannheim",4950,847,637],["Wenzhou",2802,12065,637],["Nanchang",2868,11588,637],["Birmingham",5248,-192,636],["Tampa",2795,-8246,636],["Denver",3974,-10499,636],["Vancouver",4928,-12312,636],["Manchester",5350,-225,635],["Baltimore",3930,-7662,635],["Sendai",3829,14102,635],["Naples",4084,1424,635],["Cali",340,-7650,635],["Nanchong",3078,10613,634],["St. Louis",3864,-9024,634],["Puebla",1905,-9820,634],["Nanning",2282,10832,634],["Havana",2313,-8237,634],["Tripoli",3289,1318,634],["Belém",-145,-4848,634],["Tashkent",4131,6929,634],["Yantai",3753,12140,633],["Zaozhuang",3488,11757,633],["Baku",4040,4986,633],["Medan",358,9865,633],["Santo Domingo",1847,-6990,633],["Accra",555,-22,633],["Patna",2563,8513,633],["Xuzhou",3428,11718,632],["Linyi",3508,11833,632],["Santa Cruz",-1775,-6323,632],["Maracaibo",1073,-7166,632],["Fort Lauderdale",2614,-8014,631],["Dammam",2643,5010,631],["Long Beach",3379,-11816,631],["Haikou",2005,11032,631],["Hefei",3185,11728,631],["Indore",2272,7586,631],["Kuwait City",2937,4798,631],["Hiroshima",3439,13244,631],["Baotou",4065,10982,631],["Goiânia",-1672,-4930,631],["Port-au-Prince",1854,-7234,630],["Sanaa",1536,4420,630],["Nanyang",3300,11253,629],["Haiphong",2083,10668,629],["Suzhou",3364,11698,629],["Bucharest",4444,2610,629],["Douala",406,971,628],["Ningbo",2988,12155,628],["Cleveland",4147,-8170,628],["Rawalpindi",3360,7304,627],["Saidu",3475,7235,627],["Datong",4008,11330,627],["Tangshan",3963,11819,627],["Tainan",2300,12020,627],["Portland",4552,-12268,627],["Asunción",-2529,-5764,627],["Beirut",3387,3551,627],["Brisbane",-2745,15303,627],["Kyoto",3503,13575,626],["Las Vegas",3621,-11522,626],["Pittsburgh",4043,-8000,626],["Minsk",5390,2756,626],["Shuyang",3413,11877,625],["Barranquilla",1096,-7480,625],["Valencia",1023,-6798,625],["Essen",5145,702,624],["Shangqiu",3445,11565,624],["San Bernardino",3412,-11730,624],["Wuxi",3158,12030,624],["Vadodara",2231,7318,624],["Hohhot",4082,11166,624],["Palembang",-298,10475,624],["Bhopal",2325,7741,624],["Manaus",-310,-6000,624],["Hamburg",5355,1000,624],["Brussels",5084,433,624],["Wanzhou",3082,10840,623],["Luan",3175,11648,623],["Jianmen",3065,11316,623],["Luoyang",3468,11247,623],["Vitória",-2032,-4037,623],["Santos",-2395,-4633,623],["Daqing",4658,12500,623],["Rabat",3403,-684,623],["Antananarivo",-1891,4751,623],["Quito",-21,-7850,623],["Coimbatore",1100,7695,623],["Budapest",4750,1908,623],["Warsaw",5225,2100,623],["Turin",4507,767,622],["Kumasi",669,-163,622],["Suzhou",3130,12062,622],["Ludhiana",3093,7587,622],["San Jose",3730,-12185,622],["Qiqihar",4735,12399,622],["Zhongli",2497,12122,621],["Taian",3620,11712,621],["Handan",3658,11448,621],["Anshan",4112,12294,621],["Sacramento",3858,-12147,621],["Cincinnati",3916,-8446,621],["Isfahan",3270,5170,621],["Yaoundé",387,1151,621],["Kalyan",1925,7316,620],["Agra",2717,7801,620],["Zhanjiang",2120,11038,620],["Harare",-1782,3104,620],["Abuja",909,753,620],["Shantou",2337,11667,620],["La Paz",-1650,-6815,620],["Xiantao",3037,11344,619],["Luzhou",2888,10538,619],["Xinyang",3213,11407,619],["Weifang",3672,11910,619],["Santiago",1950,-7067,619],["Khulna",2284,8956,619],["Tijuana",3250,-11708,619],["Perth",-3195,11584,619],["Niterói",-2290,-4310,618],["Toluca",1933,-9967,618],["Leeds",5383,-158,618],["Liuzhou",2428,10925,618],["Ganzhou",2592,11495,618],["Kōbe",3468,13517,618],["Oakland",3777,-12222,618],["Gujranwala",3216,7418,618],["Florence",4378,1125,618],["Kochi",1002,7622,618],["Montevideo",-3486,-5617,618],["Multan",3020,7145,618],["Vishakhapatnam",1773,8330,618],["Virginia Beach",3686,-7598,617],["Changde",2903,11168,617],["Fushun",4187,12387,617],["Neijiang",2958,10505,617],["Nasik",2000,7378,617],["Kansas City",3911,-9461,617],["Bursa",4020,2907,617],["Daejeon",3634,12742,617],["León",2115,-10170,617],["Quanzhou",2490,11858,617],["San Antonio",2949,-9851,617],["Bamako",1265,-800,617],["Conakry",953,-1368,617],["Phnom Penh",1155,10491,617],["Kawasaki",3553,13971,616],["Ft.  Worth",3274,-9734,616],["Indianapolis",3975,-8617,616],["Kharkiv",5000,3625,616],["Doha",2529,5153,616],["Gwangju",3517,12691,616],["Kaduna",1052,744,616],["Lomé",613,122,616],["Hyderabad",2538,6837,616],["Maputo",-2595,3259,616],["Huainan",3263,11698,616],["San Salvador",1371,-8920,616],["Córdoba",-3140,-6418,616],["Kuala Lumpur",317,10170,616],["Karaj",3580,5097,615],["Suining",3054,10553,615],["Meerut",2900,7770,615],["The Hague",5208,427,615],["Marseille",4329,537,615],["Tabriz",3809,4630,615],["Kampala",32,3258,615],["Davao",711,12563,615],["Lyon",4577,483,615],["Maanshan",3173,11848,614],["Mianyang",3147,10477,614],["Faridabad",2844,7731,614],["Milwaukee",4305,-8792,614],["Novosibirsk",5503,8296,614],["Semarang",-696,11042,614],["Makkah",2143,3982,614],["Dubai",2523,5528,614],["Auckland",-3685,17476,614],["Porto",4115,-862,613],["Ciudad Juárez",3169,-10649,613],["Yiyang",2860,11233,613],["Heze",3523,11545,613],["Ghaziabad",2866,7741,613],["Orlando",2851,-8138,613],["Pretoria",-2570,2823,613],["Lubumbashi",-1168,2748,613],["Varanasi",2533,8300,613],["Brazzaville",-426,1528,613],["Changzhou",3178,11997,612],["Mosul",3635,4314,612],["Lusaka",-1541,2828,612],["Yekaterinburg",5685,6060,612],["Asansol",2369,8698,612],["Sheffield",5337,-150,611],["Duisburg",5143,675,611],["Providence",4182,-7142,611],["Adana",3700,3532,611],["Chifeng",4227,11895,611],["Mbuji-Mayi",-615,2360,611],["Jabalpur",2318,7995,611],["Mandalay",2197,9608,611],["Jamshedpur",2279,8620,611],["Peshawar",3401,7153,611],["Panama City",897,-7953,611],["Nizhny Novgorod",5633,4400,611],["San José",994,-8409,611],["Madurai",992,7812,611],["Munich",4813,1157,611],["West Palm Beach",2675,-8012,610],["Columbus",3998,-8299,610],["Dhanbad",2380,8642,610],["Rajkot",2231,7080,610],["Huaiyin",3358,11903,610],["Makassar",-514,11943,610],["Stockholm",5935,1810,610],["Maoming",2192,11087,609],["Düsseldorf",5122,678,609],["Huzhou",3087,12010,609],["Mudangiang",4458,12959,609],["Tianshui",3460,10592,609],["Liupanshui",2660,10483,609],["Shiraz",2963,5257,609],["Geneva",4621,614,609],["Warangal",1801,7958,608],["Vila Velha",322,-5122,608],["Benin City",634,562,608],["Allahabad",2546,8184,608],["Vila Velha",-2037,-4032,608],["Rosario",-3295,-6067,608],["Seville",3741,-598,608],["Almaty",4333,7691,608],["Amritsar",3164,7487,608],["Abbottabad",3415,7320,607],["Cilacap",-772,10902,607],["Jining",3540,11655,607],["Maceió",-962,-3573,607],["Raleigh",3582,-7864,607],["Banghazi",3212,2006,607],["Sofia",4269,2331,607],["Prague",5009,1446,607],["Shangrao",2847,11797,606],["Leshan",2957,10373,606],["Austin",3027,-9774,606],["Torreón",2557,-10342,606],["Srinagar",3410,7481,606],["Vijayawada",1652,8063,606],["Glasgow",5588,-425,606],["Samara",5320,5015,606],["Ottawa",4542,-7570,606],["Adelaide",-3493,13860,606],["Ouagadougou",1237,-153,606],["Nezahualcoyotl",1941,-9903,605],["Barquisimeto",1005,-6930,605],["Birmingham",3353,-8682,605],["Nampo",3877,12545,605],["Can Tho",1005,10577,605],["Cagayan de Oro",845,12469,605],["Xianyang",3435,10871,605],["Aurangabad",1990,7532,605],["Omsk",5499,7340,605],["Yulin",2263,11015,605],["Kazan",5575,4912,605],["Calgary",5108,-11408,605],["Helsinki",6018,2493,605],["Mesa",3342,-11174,604],["Sharjah",2537,5541,604],["Ikare",753,576,604],["Zigong",2940,10478,604],["Baoding",3887,11548,604],["Jinhua",2912,11965,604],["Chelyabinsk",5516,6144,604],["Ankang",3268,10902,604],["Natal",-578,-3524,604],["Dushanbe",3856,6877,604],["Mogadishu",207,4536,604],["Tbilisi",4173,4479,604],["Bhilai",2122,8143,604],["Belgrade",4482,2047,604],["Yerevan",4018,4451,604],["Huambo",-1275,1576,604],["Zürich",4738,855,604],["København",5568,1256,604],["Changwon",3522,12858,603],["Zhucheng",3599,11938,603],["Suwon",3726,12701,603],["Vereeniging",-2665,2796,603],["Ulsan",3555,12932,603],["Zhuzhou",2783,11315,603],["Xiangyang",3202,11213,603],["Memphis",3512,-9000,603],["Amman",3195,3593,603],["Zhangjiakou",4083,11493,602],["Lille",5065,308,602],["Gaziantep",3708,3738,602],["Sholapur",1767,7590,602],["Dnipro",4848,3500,602],["Rostov",4724,3971,602],["Ranchi",2337,8533,602],["São Luís",-251,-4427,602],["Norfolk",3685,-7628,602],["Xining",3662,10177,602],["Dublin",5334,-625,602],["Monrovia",631,-1080,602],["Edmonton",5355,-11350,602],["Benxi",4133,12375,601],["Zhuhai",2228,11357,601],["Bridgeport",4118,-7320,601],["Port Harcourt",481,701,601],["Hengyang",2688,11259,601],["Jiamusi",4683,13035,601],["Buffalo",4288,-7888,601],["Port Elizabeth",-3397,2560,601],["Ufa",5479,5604,601],["Guatemala City",1462,-9053,601],["Florianópolis",-2758,-4852,601],["Jerusalem",3178,3521,601],["Amsterdam",5235,491,601],["Kitakyūshū",3387,13082,600],["Haifa",3282,3498,600],["Rotterdam",5192,448,600],["Bucaramanga",713,-7313,600],["Yongzhou",2623,11162,600],["Qinhuangdao",3993,11962,600],["Charlotte",3521,-8083,600],["Maracay",1025,-6760,600],["Cochabamba",-1741,-6617,600],["Homs",3473,3672,600],["Cologne",5093,695,600],["Odessa",4649,3071,600],["Da Nang",1606,10825,600],["Medina",2450,3958,600],["San Luis Potosí",2217,-10100,600],["Baoshan",2512,9915,600],["Ahvaz",3128,4872,600],["Jodhpur",2629,7301,600],["Aden",1278,4501,600],["Fez",3406,-500,600],["Perm",5800,5625,600],["N'Djamena",1212,1505,600],["Yinchuan",3847,10627,600],["Duhok",3687,4300,599],["Yangquan",3787,11357,599],["Hamamatsu",3472,13773,599],["Jiaxing",3077,12075,599],["Joinville",-2632,-4884,599],["Yichun",2784,11440,599],["Qom",3465,5095,599],["Natal",-698,-6027,599],["Chandigarh",3072,7678,599],["Gwalior",2623,7818,599],["Jacksonville",3033,-8167,599],["Donetsk",4800,3783,599],["Guwahati",2616,9177,599],["Volgograd",4871,4450,599],["Guilin",2528,11028,599],["Xinyi",3438,11835,598],["Salerno",4068,1477,598],["Kelang",302,10155,598],["Querétaro",2063,-10038,598],["Jinzhou",4112,12110,598],["Nantong",3203,12082,598],["Louisville",3823,-8575,598],["Hue",1647,10758,598],["João Pessoa",-710,-3488,598],["Bacolod",1063,12298,598],["Tulsa",3612,-9593,598],["General Santos",611,12517,598],["Ogbomosho",813,424,598],["Jixi",4530,13097,598],["Thiruvananthapuram",850,7695,598],["Tiruchirappalli",1081,7869,598],["Kozhikode",1125,7577,598],["Salt Lake City",4078,-11193,598],["Tegucigalpa",1410,-8722,598],["Mérida",2097,-8962,598],["Pingxiang",2762,11385,598],["Songnam",3744,12714,597],["Foshan",2303,11312,597],["Nice",4372,726,597],["Irbil",3618,4401,597],["Djibouti",1160,4315,597],["Krasnoyarsk",5602,9286,597],["Kingston",1798,-7677,597],["Naypyidaw",1977,9612,597],["Olinda",-800,-3485,596],["Goyang",3765,12684,596],["Hartford",4177,-7268,596],["Huaibei",3395,11675,596],["Yibin",2877,10457,596],["Xinxiang",3532,11387,596],["Xinyu",2780,11493,596],["Antwerpen",5122,441,596],["Bogor",-657,10675,596],["Richmond",3755,-7745,596],["Konya",3788,3247,596],["Naha",2621,12767,596],["Teresina",-509,-4278,596],["Niamey",1352,211,596],["Managua",1215,-8627,596],["Az Zarqa",3207,3610,595],["Tarsus",3692,3488,595],["Aba",510,735,595],["Bandar Lampung",-545,10530,595],["Newcastle",5500,-160,595],["Bengbu",3295,11733,595],["Anyang",3608,11435,595],["Zaria",1108,771,595],["Albuquerque",3510,-10664,595],["Mexicali",3265,-11548,595],["Maiduguri",1185,1316,595],["Tongliao",4362,12227,595],["Hubballi",1536,7512,595],["Mysuru",1231,7666,595],["Kathmandu",2772,8531,595],["Ulaanbaatar",4792,10691,595],["Mombasa",-404,3969,595],["Cartagena",1040,-7552,595],["Concepción",-3683,-7305,595],["Mendoza",-3288,-6882,595],["Tirana",4133,1982,595],["Okayama",3467,13392,594],["Yangjiang",2185,11197,594],["Rizhao",3543,11945,594],["Novo Hamburgo",-2971,-5114,594],["Bucheon",3750,12678,594],["Cardiff",5150,-323,594],["Callao",-1207,-7713,594],["Johor Bahru",148,10373,594],["Aguascalientes",2188,-10229,594],["Yichang",3070,11128,594],["Kaifeng",3485,11435,594],["Dandong",4015,12439,594],["Albany",4267,-7382,594],["Xuanzhou",3095,11875,594],["Bilbao",4325,-293,594],["Bandar Lampung",-543,10527,594],["Basra",3052,4781,594],["Raipur",2124,8163,594],["Salem",1167,7818,594],["Omaha",4124,-9601,594],["Nashville",3617,-8678,594],["Marrakesh",3163,-800,594],["Palermo",3813,1335,594],["Nova Iguaçu",-2274,-4347,593],["Duque de Caxias",-2277,-4331,593],["New Haven",4133,-7290,593],["Anshun",2625,10593,593],["Zunyi",2770,10692,593],["Jiaozuo",3525,11322,593],["Pingdingshan",3373,11330,593],["Zhenjiang",3222,11943,593],["Toulouse",4362,145,593],["Jullundur",3134,7557,593],["Kigali",-195,3006,593],["Voronezh",5173,3927,593],["Saratov",5158,4603,593],["Shache",3843,7725,593],["Bhubaneswar",2027,8583,593],["Tampico",2230,-9787,593],["Padang",-96,10036,593],["Valparaíso",-3305,-7162,593],["Braga",4155,-842,592],["Nottingham",5297,-117,592],["Basel",4758,759,592],["Jhansi",2545,7856,592],["Cuernavaca",1892,-9924,592],["Linfen",3608,11152,592],["Yuci",3768,11273,592],["Agadir",3044,-962,592],["Yancheng",3339,12012,592],["Kermanshah",3438,4706,592],["Tucson",3221,-11089,592],["Warri",552,576,592],["Yueyang",2938,11310,592],["Kota",2518,7583,592],["Tucumán",-2681,-6522,592],["Freetown",847,-1324,592],["Bishkek",4288,7458,592],["Thessaloniki",4070,2288,592],["Bangui",437,1856,592],["Oslo",5992,1075,592],["Butterworth",542,10040,591],["Bareilly",2835,7942,591],["Liverpool",5342,-292,591],["Xingyi",2509,10489,591],["Wuhu",3135,11837,591],["Zhaotang",2732,10372,591],["Langfang",3952,11668,591],["Qui Nhon",1378,10918,591],["Jos",993,889,591],["Lingyuan",4124,11940,591],["Aligarh",2789,7806,591],["Lviv",4983,2403,591],["Arequipa",-1642,-7153,591],["Culiacán",2483,-10738,591],["Malang",-798,11261,591],["Cuiabá",-1557,-5609,591],["Rajshahi",2438,8860,591],["Cebu",1032,12390,591],["Valencia",3949,-40,591],["St. Petersburg",2777,-8268,590],["Zaporizhzhya",4786,3517,590],["Baoji",3438,10715,590],["Liaoyang",4128,12318,590],["Yingkow",4067,12228,590],["Bhiwandi",1935,7313,590],["Pekanbaru",57,10142,590],["Malacca",221,10225,590],["Jammu",3271,7484,590],["Moradabad",2884,7875,590],["Bordeaux",4485,-60,590],["Oklahoma City",3547,-9752,590],["Chihuahua",2865,-10609,590],["Oran",3571,-62,590],["Honolulu",2131,-15786,590],["Cheongju",3664,12750,589],["Wuppertal",5125,717,589],["Shiyan",3257,11078,589],["Saarbrücken",4925,697,589],["Dayton",3975,-8420,589],["Hamhung",3991,12754,589],["Fuxin",4201,12166,589],["Shaoxing",3000,12057,589],["Yichun",4770,12890,589],["Al Hudaydah",1480,4295,589],["Antalya",3689,3070,589],["Ilorin",849,455,589],["Fuyang",3006,11995,589],["Quetta",3022,6702,589],["Zamboanga",692,12208,589],["Mangaluru",1290,7485,589],["Islamabad",3370,7316,589],["Campo Grande",-2045,-5462,589],["New Orleans",3000,-9004,589],["São José dos Campos",-2320,-4588,588],["Jincheng",3550,11283,588],["Changhua",2407,12051,588],["Hsinchu",2482,12098,588],["Fargona",4039,7178,588],["Namangan",4100,7167,588],["Trabzon",4098,3972,588],["Saltillo",2542,-10101,588],["Pietermaritzburg",-2961,3039,588],["Tangier",3575,-583,588],["Łódź",5178,1945,588],["Rochester",4317,-7762,588],["El Paso",3178,-10651,588],["Taizz",1361,4404,588],["Kraków",5006,1996,588],["Kananga",-589,2240,588],["Kolhapur",1670,7422,588],["Trujillo",-812,-7902,588],["Vientiane",1797,10260,588],["Cotonou",640,252,588],["Stamford",4105,-7354,587],["Ansan",3735,12686,587],["Liège",5063,558,587],["Oyo",785,393,587],["Nürnberg",4945,1108,587],["Hegang",4740,13037,587],["Amravati",2095,7777,587],["Naga",1362,12318,587],["St.  Paul",4494,-9308,587],["Gdańsk",5436,1864,587],["Ciudad Guayana",837,-6262,587],["Muscat",2361,5859,587],["Riga",5695,2410,587],["Nouakchott",1809,-1598,587],["Arlington",3268,-9702,586],["Lowell",4263,-7132,586],["Moshi",-334,3734,586],["Beihai",2148,10910,586],["Hanover",5237,972,586],["Kumamoto",3280,13070,586],["As Sulaymaniyah",3556,4543,586],["Tacoma",4721,-12252,586],["Denpasar",-865,11522,586],["Cúcuta",792,-7252,586],["Bremen",5308,880,586],["Hamilton",4325,-7983,586],["Shaoguan",2480,11358,586],["Ashgabat",3795,5838,586],["Sokoto",1306,524,586],["Zagreb",4580,1600,586],["Jaboatao",-811,-3502,585],["Akron",4107,-8152,585],["Tolyatti",5348,4953,585],["Jeonju",3583,12714,585],["Qingyuan",2370,11303,585],["Changzhi",3618,11311,585],["Lianyungang",3460,11917,585],["Shizuoka",3499,13839,585],["Dehra Dun",3032,7805,585],["Samarkand",3967,6694,585],["Acapulco",1685,-9992,585],["Kandahar",3161,6569,585],["Soledad",1092,-7477,584],["Stockton",3796,-12129,584],["Meknes",3390,-556,584],["Malegaon",2056,7453,584],["La Plata",-3491,-5796,584],["Aksu",4115,8025,584],["Huangshi",3022,11510,584],["Aracaju",-1090,-3712,584],["Bulawayo",-2017,2858,584],["Chișinău",4701,2886,584],["Enugu",645,750,584],["Sarajevo",4385,1838,584],["Bonn",5072,708,583],["San Pedro Sula",1550,-8803,583],["Chongjin",4178,12979,583],["Gorakhpur",2675,8338,583],["Ipoh",460,10106,583],["Nellore",1444,7999,583],["Catania",3750,1508,583],["At Taif",2126,4038,582],["Bytom",5035,1891,582],["Utsunomiya",3655,13987,582],["São José dos Pinhais",-2557,-4918,582],["Santo André",-2365,-4653,582],["Ismaïlia",3059,3226,582],["Puyang",3570,11498,582],["Shivamogga",1393,7556,582],["Knoxville",3597,-8392,582],["Syracuse",4305,-7615,582],["Najaf",3200,4434,582],["Pointe-Noire",-477,1188,582],["Kryvyy Rih",4793,3334,581],["Irbid",3255,3585,581],["Diyarbakır",3792,4023,581],["Utrecht",5210,512,581],["Morelia",1973,-10119,581],["Turpan",4294,8917,581],["Zhanyi",2560,10382,581],["Tiruppur",1108,7733,581],["Shihezi",4430,8603,581],["Biên Hòa",1097,10683,581],["Zaragoza",4165,-89,581],["Genoa",4441,893,581],["Andijan",4079,7234,581],["Krasnodar",4502,3900,581],["Ulyanovsk",5433,4841,581],["Lilongwe",-1398,3378,581],["San Mateo",3756,-12231,580],["Pasadena",2966,-9515,580],["Zhuozhou",3954,11579,580],["Wrocław",5111,1703,580],["Poznań",5241,1690,580],["Raurkela",2223,8483,580],["Hofuf",2535,4959,580],["Izhevsk",5685,5323,580],["Yogyakarta",-778,11038,580],["Bur Said",3126,3229,580],["Kikwit",-503,1885,580],["Winnipeg",4988,-9717,580],["Québec",4684,-7125,580],["Icel",3680,3462,579],["Southend-on-Sea",5155,72,579],["Oceanside",3322,-11733,579],["Bannu",3299,7060,579],["Changping",4022,11619,579],["Wiesbaden",5008,825,579],["Xiangtai",3705,11450,579],["Taizhou",3249,11990,579],["Korla",4173,8615,579],["Palu",-91,11983,579],["Fresno",3675,-11977,579],["Dresden",5105,1375,579],["Nanded",1917,7730,579],["Asmara",1533,3893,579],["Canoas",-2992,-5118,578],["Barcelona",1013,-6472,578],["El Mansura",3105,3138,578],["Sohag",2655,3170,578],["Sangli",1686,7458,578],["Jalalabad",3444,7044,578],["Chiclayo",-676,-7984,578],["Pontianak",-3,10932,578],["Belagavi",1587,7451,578],["Zahedan",2950,6083,578],["Samsun",4128,3634,578],["Yaroslavl",5762,3987,578],["Hermosillo",2910,-11095,578],["Kirkuk",3547,4439,578],["Constantine",3636,660,578],["Abu Dhabi",2447,5437,578],["Barnaul",5335,8375,578],["Bandjarmasin",-333,11458,578],["Luxor",2570,3265,578],["Aurora",3970,-10481,577],["Al Hillah",2349,4676,577],["Dortmund",5153,745,577],["Ajmer",2645,7464,577],["Gary",4158,-8733,577],["Covington",3908,-8451,577],["Abeokuta",716,335,577],["Al Hillah",3247,4442,577],["Vinh",1870,10568,577],["Chandrapur",1997,7930,577],["Sarasota",2734,-8253,577],["Kayseri",3873,3549,577],["Samarinda",-50,11715,577],["Rasht",3730,4963,577],["Nagano",3665,13817,577],["Blantyre",-1579,3499,577],["Port Louis",-2017,5750,577],["Irkutsk",5232,10425,577],["Vladivostok",4313,13191,577],["Joliet",4153,-8811,576],["Hachiōji",3566,13933,576],["Urmia",3753,4500,576],["Shuozhou",3930,11242,576],["Bikaner",2803,7333,576],["Anqing",3050,11705,576],["Niigata",3792,13904,576],["Kerman",3030,5708,576],["Khabarovsk",4845,13512,576],["Kuching",153,11033,576],["Kisangani",52,2522,576],["Quetzaltenango",1483,-9152,576],["Cuttack",2047,8589,576],["Veracruz",1918,-9616,576],["Hami",4283,9352,576],["Libreville",39,946,576],["Binjai",362,9850,575],["Tongling",3095,11778,575],["Pereira",481,-7568,575],["Weihai",3750,12210,575],["Macau",2220,11355,575],["Bouaké",769,-503,575],["Uberlândia",-1890,-4828,575],["Sorocaba",-2349,-4747,575],["Manama",2624,5058,575],["Uyo",501,785,574],["Puerto la Cruz",1017,-6468,574],["Bristol",5145,-258,574],["Hisar",2917,7573,574],["Málaga",3672,-442,574],["Kenitra",3427,-658,574],["Matola",-2597,3246,574],["Bilaspur",2209,8216,574],["Bhavnagar",2178,7213,574],["Bahawalpur",2939,7167,574],["Makhachkala",4298,4750,574],["Jiujiang",2973,11598,574],["Siping",4317,12433,574],["Kagoshima",3159,13056,574],["Kanazawa",3656,13664,574],["Tabuk",2838,3655,574],["Orenburg",5178,5511,574],["Surakarta",-756,11083,574],["Santiago de Cuba",2003,-7582,574],["Ribeirão Preto",-2117,-4783,574],["Mar del Plata",-3800,-5758,574],["Latakia",3554,3578,573],["Linxia",3560,10320,573],["Yangzhou",3240,11943,573],["Ōtsu",3501,13587,573],["Grand Rapids",4296,-8567,573],["Sargodha",3209,7267,573],["Jiangmen",2258,11308,573],["Leipzig",5134,1241,573],["Rouen",4943,108,573],["Tirunelveli",873,7769,573],["Matsuyama",3385,13277,573],["Göteborg",5775,1200,573],["Novokuznetsk",5375,8711,573],["Matamoros",2588,-9750,573],["Yining",4390,8135,573],["Tomsk",5649,8498,573],["Cancún",2117,-8683,573],["Vilnius",5468,2532,573],["Newcastle",-3285,15182,573],["Jingzhou",3032,11223,572],["Cangzhou",3832,11687,572],["Jian",2713,11500,572],["Bello",633,-7557,572],["Harrisburg",4027,-7688,572],["Kota Kinabalu",598,11611,572],["Guntur",1633,8045,572],["Ṭarābulus",3442,3587,572],["Londrina",-2330,-5118,572],["Vancouver",4563,-12264,572],["Ryazan",5462,3972,572],["Tyumen",5714,6553,572],["Oaxaca",1708,-9667,572],["Hamadan",3480,4852,572],["Gold Coast",-2808,15345,572],["Beira",-1982,3487,572],["Mykolayiv",4697,3198,571],["Gliwice",5033,1867,571],["Karbala",3261,4402,571],["Siliguri",2672,8846,571],["Ujjain",2319,7579,571],["Blida",3642,283,571],["Eskişehir",3979,3053,571],["Lipetsk",5262,3964,571],["Penza",5318,4500,571],["Banda Aceh",555,9532,571],["Suez",3000,3255,571],["Salta",-2478,-6542,571],["Taoyuan",2499,12131,570],["Glendale",3358,-11220,570],["Berkeley",3787,-12227,570],["Kansas City",3911,-9463,570],["Allentown",4060,-7550,570],["Douma",3358,3640,570],["Bradford",5380,-175,570],["San Lorenzo",-2534,-5752,570],["Reynosa",2608,-9830,570],["Tlaxcala",1932,-9823,570],["Viña del Mar",-3303,-7154,570],["Jundiaí",-2320,-4688,570],["Keelung",2513,12173,570],["Shahrisabz",3906,6683,570],["Brighton",5083,-17,570],["Mazatlán",2902,-11013,570],["Awka",621,707,570],["Bukittinggi",-30,10036,570],["Mataram",-858,11614,570],["Bari",4111,1687,570],["Pasuruan",-763,11290,570],["Damanhûr",3105,3047,570],["Songyuan",4518,12482,570],["Shuangyashan",4667,13135,570],["Tsu",3472,13652,570],["Arak",3408,4970,570],["Chiayi",2348,12044,570],["Pingtung",2268,12048,570],["Thái Nguyên",2160,10583,570],["Edinburgh",5595,-322,570],["Liaoyuan",4290,12513,570],["Kota Baharu",612,10223,570],["El Minya",2809,3075,570],["Davangere",1447,7592,570],["Astrakhan",4635,4805,570],["Akola",2071,7701,570],["Annaba",3692,776,570],["Gaza City",3153,3445,570],["Kashgar",3948,7597,570],["Macapá",3,-5105,570],["Yanji",4288,12951,569],["Everett",4796,-12220,569],["Bologna",4450,1134,569],["Beni Suef",2908,3109,569],["Tula",5420,3763,569],["Colorado Springs",3886,-10479,569],["Mwanza",-252,3293,569],["Wuwei",3793,10264,569],["Skopje",4200,2143,569],["Saharanpur",2997,7755,569],["Santa Fe",-3162,-6069,569],["Port Sudan",1962,3722,569],["Shah Alam",307,10155,568],["Sialkote",3252,7456,568],["Americana",-2275,-4733,568],["Ife",748,456,568],["Zhaoqing",2305,11245,568],["Ostrava",4983,1825,568],["Bhatpara",2285,8852,568],["Dhule",2090,7477,568],["Mariupol",4710,3756,568],["Homyel",5243,3100,568],["Nazret",855,3927,568],["Kemerovo",5534,8609,568],["Kalaburagi",1735,7682,568],["Yazd",3192,5437,568],["Herat",3433,6217,568],["Tuxtla Gutiérrez",1675,-9315,568],["Feira de Santana",-1225,-3897,568],["Hargeisa",956,4407,568],["Piraeus",3795,2370,567],["İzmit",4078,2993,567],["Iligan",817,12422,567],["Chaoyang",4155,12042,567],["Jiaojing",2868,12145,567],["Kuqa",4173,8294,567],["Udaipur",2460,7373,567],["Toledo",4167,-8358,567],["Juiz de Fora",-2177,-4337,567],["Qazvin",3627,5000,567],["Pristina",4267,2117,567],["Shymkent",4232,6960,567],["Bloemfontein",-2912,2623,567],["Sunderland",5492,-138,566],["Leicester",5263,-113,566],["Naberezhnyye Chelny",5570,5232,566],["Xalapa",1953,-9692,566],["Hengshui",3772,11570,566],["Hamah",3515,3673,566],["Luhansk",4857,3933,566],["Malatya",3837,3830,566],["Calabar",496,833,566],["Jingdezhen",2927,11718,566],["Volta Redonda",-2252,-4409,566],["Cranbourne",-3810,14528,566],["Durango",2403,-10467,566],["Panzhihua",2655,10173,566],["Sfax",3475,1072,566],["Manado",148,12485,566],["Jambi",-159,10361,566],["Iquitos",-375,-7325,566],["Kirov",5859,4967,566],["Bandar-e-Abbas",2720,5627,566],["Mazar-i-Sharif",3670,6710,566],["Tokushima",3407,13455,565],["Oshawa",4388,-7885,565],["Gent",5103,370,565],["Portsmouth",5080,-108,565],["Ado Ekiti",763,522,565],["Chengde",4096,11793,565],["Xuchang",3402,11382,565],["Ōita",3324,13160,565],["An Nasiriyah",3104,4627,565],["Chlef",3617,132,565],["Şanlıurfa",3717,3879,565],["Cheboksary",5613,4725,565],["Qitaihe",4580,13085,565],["Bakersfield",3537,-11902,565],["Ballari",1515,7692,565],["Belfast",5460,-596,565],["Baguio",1643,12057,565],["Wuzhou",2348,11132,565],["Balikpapan",-125,11683,565],["San Juan",-3155,-6852,565],["Bamenda",596,1015,565],["Qaraghandy",4988,7312,565],["Cabimas",1043,-7145,564],["Spanish Town",1798,-7695,564],["Katsina",1299,760,564],["Wakayama",3422,13517,564],["Nantes",4721,-159,564],["Khomeini Shahr",3270,5147,564],["Foz do Iguaçu",-2552,-5453,564],["Mawlamyine",1650,9767,564],["Khujand",4029,6962,564],["Pohang",3602,12937,564],["Santa Marta",1125,-7420,564],["Guangyuan",3243,10587,564],["Strasbourg",4858,775,564],["San Luis",-3330,-6635,564],["Bukavu",-251,2884,564],["Likasi",-1097,2678,564],["Tuticorin",882,7813,564],["Laredo",2751,-9951,564],["Welkom",-2797,2673,564],["Kaliningrad",5470,2050,564],["Garoua",930,1339,564],["San Cristóbal",777,-7225,564],["Nagasaki",3276,12989,564],["Springfield",4212,-7258,563],["Bournemouth",5073,-190,563],["Chaozhou",2368,11663,563],["Heidelberg",4942,870,563],["Villahermosa",1800,-9290,563],["Gaya",2480,8500,563],["Batangas",1378,12102,563],["Bengkulu",-380,10227,563],["Kurnool",1583,7803,563],["Arak",2528,375,563],["Baton Rouge",3046,-9114,563],["Bratislava",4815,1712,563],["Bryansk",5326,3443,563],["Luohe",3357,11403,562],["Kitchener",4345,-8050,562],["Middlesbrough",5458,-123,562],["Erzurum",3992,4129,562],["Akure",725,520,562],["Meizhou",2430,11612,562],["Gifu",3542,13676,562],["Sukkur",2771,6885,562],["Ibagué",444,-7523,562],["Campina Grande",-723,-3588,562],["Ivanovo",5701,4101,562],["Ardabil",3825,4830,562],["Huancayo",-1208,-7520,562],["Magnitogorsk",5342,5898,562],["Asyut",2719,3118,562],["Kolwezi",-1072,2547,562],["Miami Beach",2581,-8013,561],["Xuanhua",4059,11502,561],["Al Ayn",2423,5574,561],["Jeju",3351,12652,561],["Pasay City",1455,12100,561],["Oshogbo",777,456,561],["Szczecin",5342,1453,561],["Tanta",3079,3100,561],["Metz",4912,618,561],["Ipatinga",-1948,-4252,561],["Taubaté",-2302,-4556,561],["Maturín",975,-6317,561],["Murcia",3798,-113,561],["Kursk",5174,3619,561],["Charleston",3279,-7999,561],["Nha Trang",1225,10917,561],["Kitwe",-1281,2822,561],["Oujda",3469,-191,561],["Zanzibar",-616,3920,561],["Bissau",1187,-1560,561],["Hotan",3710,7993,561],["Metairie",2998,-9015,560],["Khmelnytskyy",4942,2700,560],["Horlivka",4830,3805,560],["Eindhoven",5143,550,560],["Gómez Palacio",2557,-10350,560],["Sunchon",3942,12594,560],["Columbia",3895,-9233,560],["Mbale",109,3417,560],["Buraydah",2637,4396,560],["Jingmen",3103,11210,560],["Kollam",890,7657,560],["Sikar",2761,7514,560],["Wichita",3772,-9733,560],["Yuxi",2438,10257,560],["Ndola",-1300,2865,560],["Kisumu",-9,3475,560],["Tumakuru",1333,7710,560],["Columbia",3404,-8090,560],["Chiang Mai",1880,9898,560],["Piura",-521,-8063,560],["Tver",5686,3589,560],["Kassala",1546,3639,560],["Surgut",6126,7343,560],["Tallinn",5943,2473,560],["Elgin",4204,-8829,559],["Alajuela",1002,-8423,559],["Palm Springs",3378,-11653,559],["Qarshi",3887,6580,559],["Samut Prakan",1361,10061,559],["Coventry",5242,-150,559],["Stoke",5300,-218,559],["Hail",2752,4170,559],["Osh",4054,7279,559],["Grenoble",4518,572,559],["Brno",4920,1661,559],["Nizamabad",1867,7810,559],["Bhilwara",2535,7464,559],["Béjaïa",3676,507,559],["Comilla",2347,9117,559],["Greensboro",3607,-7980,559],["Granada‎",3716,-359,559],["Baicheng",4562,12282,559],["Ahmednagar",1911,7475,559],["Sandakan",584,11811,559],["Campos",-2175,-4132,559],["Resistencia",-2746,-5899,559],["Al-Ubayyid",1318,3022,559],["Nampula",-1514,3929,559],["Misrata",3238,1510,559],["Nyala",1206,2489,559],["Iloilo",1071,12255,559],["Wellington",-4130,17478,559],["Makiyivka",4803,3797,558],["Southampton",5090,-140,558],["Kahramanmaraş",3761,3695,558],["Celaya",2053,-10080,558],["Karlsruhe",4900,840,558],["Ogden",4123,-11197,558],["Putian",2543,11902,558],["Zhoukou",3363,11463,558],["Dezhou",3745,11630,558],["Parbhani",1927,7676,558],["Vigo",4222,-873,558],["Nizhny Tagil",5792,5997,558],["Manizales",506,-7552,558],["Pasto",121,-7728,558],["Xichang",2788,10230,558],["Caxias do Sul",-2918,-5117,558],["Las Palmas",2810,-1543,558],["Des Moines",4158,-9362,558],["Sevastopol",4460,3346,558],["Reading",5147,-98,557],["Najran",1751,4413,557],["Al-Qatif",2652,5001,557],["Denizli",3777,2908,557],["Van",3850,4340,557],["Kaunas",5495,2388,557],["Seremban",271,10194,557],["Longyan",2518,11703,557],["Quzhou",2897,11887,557],["Shillong",2557,9188,557],["Khorramabad",3348,4835,557],["Rajapalaiyam",942,7758,557],["São José do Rio Preto",-2080,-4939,557],["Mahilyow",5390,3032,557],["La Coruña",4333,-842,557],["Villavicencio",415,-7363,557],["Latur",1840,7657,557],["Palma",3957,265,557],["Abadan",3033,4828,557],["Manukau",-3700,17488,557],["Mazatlán",2322,-10642,557],["Valletta",3590,1451,557],["McAllen",2620,-9823,556],["Hampton",3703,-7635,556],["Sheikhu Pura",3172,7399,556],["Augsburg",4835,1090,556],["St. Charles",3878,-9051,556],["Vladikavkaz",4305,4467,556],["Bydgoszcz",5312,1801,556],["Lublin",5125,2257,556],["Tamale",940,-84,556],["Trenton",4022,-7474,556],["Sanya",1826,10950,556],["Nakuru",-28,3607,556],["Kuantan",383,10332,556],["Larkana",2756,6821,556],["Stavropol",4505,4198,556],["Ulan-Ude",5182,10762,556],["Gorontalo",55,12307,556],["Bhagalpur",2523,8698,556],["Bobo Dioulasso",1118,-429,556],["Cusco",-1353,-7197,556],["Maseru",-2932,2748,556],["Halifax",4465,-6360,556],["Christchurch",-4354,17263,556],["Encarnación",-2735,-5587,555],["Rahim Yar Khan",2842,7030,555],["Orizaba",1885,-9713,555],["Wafangdian",3963,12200,555],["Ad Diwaniyah",3199,4492,555],["Zanjan",3667,4850,555],["Greenville",3485,-8239,555],["Simferopol",4495,3410,555],["Vinnytsya",4923,2848,555],["Cà Mau",918,10515,555],["San Sebastián",4332,-198,555],["Sungai Petani",565,10048,555],["Longxi",3505,10464,555],["Neiva",293,-7533,555],["Mito",3637,14048,555],["Iwaki",3706,14089,555],["Toulon",4313,592,555],["Provo",4025,-11164,555],["Mirpur Khas",2553,6901,555],["Asahikawa",4376,14238,555],["Santiago del Estero",-2778,-6427,555],["Safi",3232,-924,555],["Ambon",-372,12820,555],["Eldoret",52,3527,555],["Taraz",4290,7136,555],["Archangel",6457,4055,555],["Posadas",-2736,-5589,555],["Evanston",4205,-8770,554],["Kohat",3360,7143,554],["Yumen",3983,9773,554],["Maebashi",3639,13907,554],["Sanandaj",3530,4702,554],["Muzaffarnagar",2949,7770,554],["London",4297,-8125,554],["Aurora",4177,-8830,554],["Qoqon",4054,7094,554],["Việt Trì",2133,10543,554],["Buon Me Thuot",1267,10805,554],["Long Xuyen",1038,10542,554],["Kuala Terengganu",533,10312,554],["Mbombela",-2547,3098,554],["Haarlem",5238,463,554],["Verona",4544,1099,554],["Al Amarah",3184,4715,554],["Charleroi",5042,445,554],["Linz",4832,1429,554],["Kurgan",5546,6534,554],["Camagüey",2138,-7792,554],["Kosti",1317,3266,554],["Belgorod",5063,3660,554],["Hualien",2398,12160,554],["Spokane",4767,-11742,554],["Mérida",840,-7113,554],["Chimbote",-907,-7857,554],["Nuevo Laredo",2750,-9955,554],["Nur-Sultan",5118,7143,554],["Salem",4252,-7088,553],["Gijón",4353,-567,553],["Lalitpur",2767,8533,553],["Irapuato",2067,-10150,553],["Kaesong",3796,12656,553],["Kawagoe",3592,13949,553],["Kōriyama",3741,14038,553],["Corrientes",-2749,-5881,553],["Piracicaba",-2271,-4764,553],["Plovdiv",4215,2475,553],["Phan Thiet",1093,10810,553],["Yeosu",3474,12775,553],["Jhang",3128,7232,553],["Alor Setar",611,10037,553],["Kaluga",5452,3627,553],["Yaan",2998,10308,553],["Tieling",4230,12382,553],["Ciudad Bolívar",810,-6360,553],["Pematangsiantar",296,9906,553],["Bauru",-2233,-4908,553],["Vitsyebsk",5519,3019,553],["Santa Cruz de Tenerife",2847,-1625,553],["Chitungwiza",-1800,3110,553],["Nakhon Ratchasima",1500,10210,553],["East London",-3297,2787,553],["Arusha",-336,3667,553],["Kōchi",3356,13354,553],["Boise",4361,-11623,553],["Sanford",2879,-8128,552],["Bielefeld",5203,853,552],["Hangu",3923,11778,552],["Baishan",4190,12643,552],["Takamatsu",3434,13404,552],["Toyama",3670,13723,552],["Mathura",2750,7767,552],["Heyuan",2373,11468,552],["Beni",49,2945,552],["Patiala",3032,7638,552],["Muzaffarpur",2612,8538,552],["Sagar",2385,7875,552],["Maringá",-2341,-5193,552],["Mymensingh",2475,9038,552],["Madison",4307,-8940,552],["Medani",1440,3352,552],["Orel",5297,3607,552],["Reno",3953,-11982,552],["Sochi",4359,3973,552],["Wonsan",3916,12743,552],["Pavlodar",5230,7695,552],["Montes Claros",-1672,-4386,552],["Bujumbura",-338,2936,552],["Canberra",-3528,14913,552],["Itu",-2326,-4730,551],["Modesto",3766,-12099,551],["Kherson",4663,3260,551],["Podolsk",5538,3753,551],["Volzhskiy",4879,4477,551],["Yoshkar Ola",5664,4787,551],["Chenzhou",2580,11303,551],["Montpellier",4361,387,551],["Al Kut",3249,4583,551],["Shahjahanpur",2788,7991,551],["Itajaí",-2690,-4868,551],["Legazpi",1317,12375,551],["Akita",3971,14009,551],["Brahmapur",1932,8480,551],["Valladolid",4165,-475,551],["Birjand",3288,5922,551],["Sousse",3583,1063,551],["Córdoba",3788,-477,551],["Iași",4717,2757,551],["Ciudad del Este",-2552,-5462,551],["Smolensk",5478,3205,551],["Miyazaki",3192,13142,551],["Pelotas",-3175,-5233,551],["Maroua",1060,1432,551],["Rohtak",2890,7658,550],["Maiquetía",1060,-6697,550],["Poltava",4957,3457,550],["Alicante",3835,-48,550],["Timișoara",4576,2122,550],["Tepic",2151,-10488,550],["Pachuca",2017,-9873,550],["Bauchi",1031,984,550],["Gdynia",5452,1853,550],["Pescara",4246,1422,550],["Ninde",2668,11953,550],["Armenia",453,-7568,550],["Koblenz",5035,760,550],["Dezful",3238,4847,550],["Anápolis",-1632,-4896,550],["Varna",4322,2790,550],["Hrodna",5368,2383,550],["Cumaná",1045,-6418,550],["Holguín",2089,-7626,550],["Windsor",4232,-8304,550],["Cluj-Napoca",4679,2360,550],["Hat Yai",700,10047,550],["Vladimir",5613,4041,550],["Angeles",1515,12055,550],["Bukhara",3978,6443,550],["Ljubljana",4606,1451,550],["El Faiyum",2931,3084,550],["Aswan",2409,3290,550],["Oskemen",4999,8261,550],["Murmansk",6897,3310,550],["New Delhi",2860,7720,550],["Durham",3600,-7892,549],["Chernihiv",5150,3130,549],["Qurghonteppa",3784,6877,549],["Galați",4546,2805,549],["Valledupar",1048,-7325,549],["Firozabad",2715,7839,549],["Dayr az Zawr",3533,4013,549],["Brașov",4565,2561,549],["Ksar El Kebir",3502,-591,549],["Cherepovets",5914,3791,549],["Sapele",589,568,549],["Sambalpur",2147,8397,549],["Ratlam",2335,7503,549],["Youngstown",4110,-8065,549],["San Salvador de Jujuy",-2418,-6530,549],["Tawau",427,11790,549],["Antsirabe",-1985,4703,549],["Pucallpa",-837,-7453,549],["Nalchik",4350,4362,549],["Semey",5043,8028,549],["Porto Velho",-875,-6390,549],["Vitória da Conquista",-1485,-4084,549],["Chita",5206,11347,549],["Antofagasta",-2365,-7040,549],["Los Teques",1042,-6702,548],["Al Mubarraz",2543,4957,548],["Gujrat",3258,7408,548],["Mardan",3420,7204,548],["Chemnitz",5083,1292,548],["Mengzi",2336,10341,548],["Ganca",4068,4635,548],["Fort Wayne",4108,-8513,548],["Rạch Giá",1002,10509,548],["Sóc Trăng",960,10598,548],["Kingston upon Hull",5375,-33,548],["Batman",3789,4114,548],["Jinja",44,3320,548],["Craiova",4433,2383,548],["Saransk",5417,4518,548],["Olongapo",1483,12028,548],["Kanggye",4097,12660,548],["Dumyat",3142,3182,548],["Qena",2615,3272,548],["Rajahmundry",1703,8179,548],["Bidar",1792,7752,548],["Baqubah",3375,4466,548],["Curepipe",-2032,5752,548],["Tambov",5273,4143,548],["Barddhaman",2325,8786,548],["Jember",-817,11369,548],["Kom Ombo",2447,3295,548],["Franca",-2053,-4739,548],["Constanța",4420,2861,548],["Hakodate",4179,14074,548],["Qyzylorda",4480,6546,548],["Porto-Novo",648,262,548],["Brest",5210,2370,548],["Riverside",3394,-11740,547],["Swansea",5163,-395,547],["Ar Ramadi",3342,4330,547],["Blumenau",-2692,-4909,547],["Flint",4301,-8369,547],["Chernivtsi",4831,2592,547],["Cherkasy",4943,3207,547],["İskenderun",3658,3617,547],["Thiès",1481,-1693,547],["Al Kharj",2416,4731,547],["Białystok",5315,2317,547],["Panipat",2940,7697,547],["Rampur",2882,7902,547],["Aomori",4083,14071,547],["Fukushima",3774,14047,547],["Morioka",3972,14113,547],["Kakinada",1697,8224,547],["Sumy",5092,3478,547],["Minna",962,655,547],["Port-of-Spain",1065,-6152,547],["Vologda",5921,3992,547],["Makurdi",773,853,547],["Ponta Grossa",-2509,-5016,547],["Bandar Seri Begawan",488,11493,547],["Sakarya",4077,3040,546],["Barlett",3522,-8984,546],["Huizhou",2308,11440,546],["Kassel",5130,950,546],["Hulan Ergi",4721,12361,546],["Talcahuano",-3672,-7312,546],["Worcester",4227,-7180,546],["Kasur",3113,7446,546],["Ciudad Obregon",2747,-10992,546],["Coatzacoalcos",1812,-9442,546],["Cagliari",3922,910,546],["Tirupati",1365,7942,546],["Khammam",1728,8016,546],["Karimnagar",1846,7911,546],["Hosapete",1528,7638,546],["Bhuj",2325,6981,546],["Petrópolis",-2251,-4320,546],["Bafoussam",549,1041,546],["Limeira",-2255,-4740,546],["Mayagüez",1820,-6714,546],["Rangpur",2575,8928,546],["Sekondi",494,-170,546],["Sinuiju",4009,12442,546],["Cuenca",-290,-7900,546],["Butembo",13,2928,546],["Mbeya",-889,3343,546],["Victoria",4843,-12335,546],["Zagazig",3058,3152,545],["Barinas",860,-7025,545],["Rize",4102,4052,545],["Iksan",3594,12695,545],["Taganrog",4723,3892,545],["Sumqayt",4058,4963,545],["Al Khalil",3154,3510,545],["Winston-Salem",3611,-8026,545],["Newark",4070,-7417,545],["Cadiz",1096,12331,545],["Tacloban",1125,12500,545],["Ambato",-127,-7862,545],["Xinzhou",3841,11272,545],["Mandya",1257,7692,545],["Gorgan",3683,5448,545],["Alwar",2755,7660,545],["Aizawl",2371,9272,545],["Lansing",4273,-8455,545],["Cádiz",3653,-623,545],["Cap-Haïtien",1976,-7221,545],["Tongchuan",3508,10903,545],["Jining",4103,11308,545],["Bago",1732,9651,545],["Cotabato",722,12425,545],["Batna",3557,617,545],["Zhytomyr",5025,2866,545],["Kupang",-1018,12358,545],["Tacna",-1800,-7025,545],["Ica",-1407,-7573,545],["Port Moresby",-946,14719,545],["Bahía Blanca",-3874,-6227,545],["Blackpool",5383,-305,544],["Owo",720,559,544],["Sukabumi",-691,10690,544],["Majene",-353,11897,544],["Jinshi",2963,11185,544],["Crato",-723,-3942,544],["Pamplona",4282,-165,544],["Prokopyevsk",5390,8671,544],["Komsomolsk na Amure",5055,13702,544],["Ciudad Victoria",2372,-9913,544],["Montería",876,-7589,544],["Guantánamo",2015,-7521,544],["Ubon Ratchathani",1525,10483,544],["Kostroma",5777,4094,544],["Crato",-746,-6304,544],["Sétif",3618,540,544],["Corpus Christi",2774,-9740,544],["Kaolack",1415,-1610,544],["Bern",4692,747,544],["Mbandaka",4,1826,544],["Elâzığ",3868,3923,543],["Yanbu al Bahr",2409,3805,543],["Mokpo",3481,12640,543],["Gombe",1029,1117,543],["Padangsidempuan",139,9927,543],["Tebingtinggi",333,9913,543],["Pakalongan",-688,10967,543],["Münster",5197,762,543],["Kiel",5433,1013,543],["Yamagata",3827,14032,543],["Nancy",4868,620,543],["Sari",3655,5310,543],["Little Rock",3474,-9233,543],["Sterlitamak",5363,5596,543],["Vijayapura",1684,7571,543],["Thohoyandou",-2295,3048,543],["Tasikmalaya",-733,10821,543],["Tshikapa",-641,2077,543],["Myeik",1245,9861,543],["Malmö",5558,1303,543],["Venice",4544,1233,543],["Windhoek",-2257,1708,543],["Umuahia",553,749,542],["Melbourne",2808,-8061,542],["Az Aubayr",3039,4771,542],["Cabo Frio",-2289,-4204,542],["Paraná",-3173,-6053,542],["Lakeville",4465,-9324,542],["Acarigua",958,-6920,542],["Naples",2614,-8179,542],["Ann Arbor",4230,-8372,542],["Balıkesir",3965,2789,542],["Sivas",3975,3703,542],["Lausanne",4653,665,542],["Uruapan",1942,-10207,542],["Saint-Étienne",4543,438,542],["Sincelejo",929,-7538,542],["Zhuanghe",3968,12296,542],["Graz",4708,1541,542],["Adapazarı",4080,3042,542],["Karamay",4559,8486,542],["Imphal",2480,9395,542],["Temuco",-3873,-7258,542],["Augusta",3346,-8198,542],["Lexington",3805,-8450,542],["Wollongong",-3442,15089,542],["Kindu",-296,2591,542],["Tubruq",3208,2396,542],["Uberaba",-1978,-4795,542],["Petrozavodsk",6185,3428,542],["Aqtobe",5028,5717,542],["Petrolina",-938,-4051,542],["Georgetown",680,-5817,542],["Anchorage",6122,-14990,542],["Damaturu",1175,1197,541],["Rockford",4227,-8907,541],["Konibodom",4029,7043,541],["Chuxiong",2504,10155,541],["Davenport",4155,-9059,541],["Rivne",5062,2625,541],["Nonthaburi",1383,10048,541],["Da Lat",1193,10842,541],["Dzerzhinsk",5625,4346,541],["Poza Rica de Hidalgo",2055,-9747,541],["Ondo",709,484,541],["Mendefera",1489,3882,541],["Freiburg",4800,787,541],["Raichur",1621,7736,541],["Etawah",2679,7901,541],["Cascavel",-2496,-5346,541],["Kondoz",3673,6887,541],["Ensenada",3187,-11662,541],["Popayán",242,-7661,541],["Canton",4080,-8138,541],["Chattanooga",3507,-8525,541],["Al Mukalla",1454,4913,541],["Chimoio",-1912,3347,541],["Cirebon",-673,10857,541],["Daloa",689,-645,541],["Tampere",6150,2375,541],["Rio Branco",-997,-6780,541],["Paramaribo",584,-5517,541],["Coral Springs",2627,-8027,540],["Waukesha",4301,-8823,540],["Iwo",763,418,540],["Caserta",4106,1434,540],["Como",4581,908,540],["Linhai",2885,12112,540],["Sonipat",2900,7702,540],["Melun",4853,267,540],["Borujerd",3392,4880,540],["Várzea Grande",-1565,-5614,540],["Luzern",4705,828,540],["Kirovohrad",4850,3226,540],["Quảng Ngãi",1515,10883,540],["Vung Tau",1036,10708,540],["Arua",302,3090,540],["Hafar al Batin",2843,4596,540],["Jalal Abad",4094,7300,540],["Zumpango",1981,-9911,540],["Messina",3820,1555,540],["Buenaventura",387,-7705,540],["Fort-de-France",1461,-6108,540],["Suihua",4663,12698,540],["Fukui",3607,13622,540],["Pathankot",3227,7572,540],["Chirala",1586,8034,540],["Kashan",3398,5158,540],["Niš",4333,2190,540],["Mobile",3068,-8805,540],["Khon Kaen",1642,10283,540],["Los Mochis",2579,-10900,540],["Santa Clara",2240,-7997,540],["Laiyang",3697,12071,540],["Mutare",-1897,3265,540],["Governador Valadares",-1887,-4197,540],["Santa Maria",-2968,-5380,540],["El Fasher",1363,2535,540],["Jaffna",968,8001,540],["Morogoro",-682,3766,540],["Dire Dawa",959,4186,540],["Jackson",3230,-9018,540],["Thu Dau Mot",1097,10665,539],["Kattaqorgon",3990,6626,539],["Wonju",3736,12794,539],["Braunschweig",5225,1050,539],["Shimonoseki",3397,13095,539],["San Bernardo",-3360,-7070,539],["Hapur",2874,7776,539],["Fayetteville",3506,-7888,539],["Ternopil",4954,2558,539],["Udon Thani",1740,10279,539],["Plymouth",5039,-416,539],["Manisa",3863,2744,539],["Miskolc",4810,2078,539],["Gunsan",3598,12672,539],["Rzeszów",5007,2200,539],["Qinzhou",2195,10862,539],["Singkawang",91,10897,539],["Hebi",3595,11422,539],["Mirzapur",2515,8257,539],["Jashore",2317,8920,539],["Nam Định",2042,10620,539],["Juliaca",-1550,-7014,539],["Orsk",5121,5863,539],["Nizhenvartovsk",6093,7658,539],["Eugene",4405,-12310,539],["Lincoln",4082,-9668,539],["Oruro",-1798,-6713,539],["Shreveport",3250,-9377,539],["Angarsk",5256,10392,539],["Bratsk",5616,10162,539],["Matadi",-582,1345,539],["South Bend",4168,-8625,538],["Fürth",4947,1100,538],["Ivano-Frankivsk",4893,2471,538],["Al Jubayl",2700,4965,538],["San Pablo",1407,12132,538],["Tehuacan",1845,-9738,538],["Linchuan",2797,11636,538],["Sasebo",3316,12972,538],["Seeb",2368,5818,538],["Hachinohe",4051,14154,538],["Novorossiysk",4473,3777,538],["Århus",5616,1021,538],["Caruaru",-828,-3598,538],["Ulan Hot",4608,12208,538],["Le Havre",4950,10,538],["Neuquén",-3895,-6806,538],["Berbera",1044,4502,538],["Ibb",1398,4417,537],["Sahiwal",3067,7311,537],["Hetauda",2742,8503,537],["Clermont-Ferrand",4578,308,537],["Santa Ana",-1376,-6558,537],["Sylhet",2490,9187,537],["Santa Rosa",3845,-12270,537],["Kremenchuk",4908,3343,537],["Jizzax",4010,6783,537],["Oviedo",4335,-583,537],["Luton",5188,-42,537],["Ploiești",4495,2604,537],["Košice",4873,2125,537],["Dera Ghazi Khan",3006,7064,537],["Springs",-2627,2843,537],["Nizhnekamsk",5564,5182,537],["Zacatecas",2277,-10258,537],["Tegal",-687,10912,537],["Singaraja",-812,11509,537],["Kediri",-779,11200,537],["Santa Ana",1399,-8956,537],["Lübeck",5387,1067,537],["Zicheng",3030,11150,537],["Shishou",2970,11240,537],["Tours",4738,70,537],["Al Fallujah",3335,4378,537],["Saidpur",2580,8900,537],["Pathein",1677,9475,537],["Pensacola",3042,-8722,537],["Oostanay",5322,6363,537],["Porbandar",2167,6967,537],["Punto Fijo",1172,-7021,537],["Nakhon Si Thammarat",840,9997,537],["Kismaayo",-36,4252,537],["Monclova",2690,-10142,537],["Taiping",486,10072,537],["Rancagua",-3417,-7074,537],["Zabol",3102,6148,537],["Palmas",-1024,-4829,537],["Türkmenabat",3911,6358,537],["Niamey",1349,710,537],["Dili",-856,12558,537],["Yakutsk",6203,12974,537],["Boa Vista",282,-6067,537],["Chuncheon",3787,12773,536],["Beipiao",4181,12076,536],["Quillacollo",-1740,-6628,536],["Fort Collins",4056,-10506,536],["Fort Pierce",2745,-8033,536],["Chon Buri",1340,10100,536],["Debrecen",4753,2163,536],["Nawabshah",2625,6840,536],["Miri",440,11398,536],["Er Rachidia",3194,-445,536],["Uitenhage",-3376,2539,536],["Noginsk",5587,3848,536],["Starsy Oskol",5130,3784,536],["Gusau",1217,666,536],["Hyeson",4139,12819,536],["Osnabrück",5228,805,536],["Magdeburg",5213,1162,536],["Tanjungpinang",92,10447,536],["Liaocheng",3643,11597,536],["Bharatpur",2725,7750,536],["Ngaoundéré",732,1358,536],["Tlimcen",3489,-132,536],["Syktyvkar",6166,5082,536],["Noginsk",6448,9123,536],["Petropavlovsk",5488,6922,536],["Ilhéus",-1478,-3905,536],["Salem",4493,-12302,536],["Nukus",4247,5962,536],["Zhangye",3893,10045,536],["Hailar",4920,11970,536],["Puducherry",1193,7983,536],["Zinder",1380,898,536],["Iquique",-2025,-7013,536],["Santarém",-243,-5470,536],["Nassau",2508,-7735,536],["Gueckedou",855,-1015,535],["Vitoria",4285,-267,535],["Kolpino",5973,3065,535],["Neyshabur",3622,5882,535],["Kissimmee",2829,-8141,535],["Bạc Liêu",928,10572,535],["Adıyaman",3777,3828,535],["Nyanza",-235,2974,535],["Arar",3099,4102,535],["Okara",3081,7345,535],["Shakhty",4772,4027,535],["Sikasso",1132,-568,535],["Mubi",1027,1327,535],["Haeju",3804,12571,535],["Hancheng",3547,11043,535],["Matsumoto",3624,13797,535],["Karnal",2968,7697,535],["Amol",3647,5236,535],["Nagercoil",818,7743,535],["Itabuna",-1479,-3928,535],["Novi Sad",4525,1985,535],["Narayanganj",2362,9050,535],["Skikda",3688,690,535],["Banja Luka",4478,1718,535],["Tapachula",1490,-9227,535],["Lancaster",3470,-11814,535],["Juazeiro do Norte",-721,-3932,535],["Monywa",2210,9515,535],["Tanga",-507,3909,535],["Sabzewar",3622,5763,535],["Grozny",4332,4570,535],["Colima",1923,-10372,535],["Formosa",-2617,-5818,535],["Nacala",-1452,4072,535],["Sucre",-1904,-6526,535],["Nicosia",3517,3337,535],["Denow",3828,6789,534],["Columbus",3247,-8498,534],["York",3996,-7673,534],["Gabès",3390,1010,534],["Groningen",5322,658,534],["Gilgit",3592,7430,534],["Rybinsk",5805,3882,534],["Cabanatuan",1550,12096,534],["Córdoba",1892,-9692,534],["San Pedro de Macorís",1845,-6930,534],["Mallawi",2773,3084,534],["Potsdam",5240,1307,534],["Orléans",4790,190,534],["Thanjavur",1077,7915,534],["Bertoua",458,1368,534],["Babruysk",5313,2919,534],["Velikiy Novgorod",5850,3133,534],["Wuhai",3966,10681,534],["Daytona Beach",2921,-8102,534],["Baghlan",3614,6870,534],["Polokwane",-2389,2945,534],["Saint-Louis",1602,-1651,534],["Sibolga",175,9880,534],["Imperatriz",-552,-4749,534],["Tallahassee",3045,-8428,534],["Blagoveshchensk",5027,12753,534],["Dodoma",-618,3575,534],["Colombo",693,7986,534],["Lhasa",2965,9110,534],["Brăila",4529,2797,533],["Owerri",549,703,533],["Oradea",4705,2192,533],["Marília",-2221,-4995,533],["Lutsk",5075,2533,533],["Navoi",4011,6535,533],["Biysk",5253,8518,533],["Zamora",1998,-10228,533],["Kielce",5089,2066,533],["Trieste",4565,1380,533],["Nanping",2663,11817,533],["Split",4352,1647,533],["Mulhouse",4775,735,533],["Limbe",403,919,533],["Nablus",3222,3525,533],["Lubbock",3358,-10188,533],["Portoviejo",-106,-8046,533],["Huntsville",3472,-8661,533],["Machala",-326,-7996,533],["Bergen",6039,532,533],["Thái Bình",2045,10633,532],["Lancaster",4004,-7631,532],["Sanming",2623,11758,532],["Bojnurd",3747,5732,532],["Presidente Prudente",-2212,-5139,532],["Santander",4338,-380,532],["Hajjah",1569,4360,532],["Kırıkkale",3985,3353,532],["Ijebu Ode",682,392,532],["Pingliang",3553,10668,532],["Tema",564,1,532],["Pali",2579,7333,532],["San-Pedro",477,-664,532],["Sidi bel Abbes",3519,-64,532],["La Romana",1842,-6897,532],["Waitakere",-3685,17455,532],["Rennes",4810,-167,532],["Springfield",3718,-9332,532],["Abha",1823,4250,532],["Toamasina",-1818,4940,532],["Oral",5127,5133,532],["Lobito",-1237,1354,532],["Laoag",1820,12059,532],["Bahir Dar",1160,3738,532],["Gaborone",-2465,2591,532],["Appleton",4427,-8840,531],["Erfurt",5097,1103,531],["Beer Sheva",3125,3483,531],["Timon",-511,-4284,531],["Guaratinguetá",-2282,-4519,531],["São Carlos",-2202,-4789,531],["Angren",4103,7015,531],["Lampang",1829,9948,531],["Minatitlán",1798,-9453,531],["Al Khums",3266,1426,531],["Pisa",4372,1040,531],["Taranto",4051,1723,531],["Lianxian",2478,11238,531],["Las Tunas",2096,-7695,531],["Puqi",2972,11388,531],["Jiutai",4414,12584,531],["Ongole",1556,8005,531],["Rostock",5407,1215,531],["Khvoy",3853,4497,531],["Agartala",2384,9128,531],["Edéa",380,1012,531],["Djougou",970,168,531],["Salzburg",4781,1304,531],["Barishal",2270,9037,531],["North Shore",-3679,17478,531],["Colón",937,-7987,531],["Salalah",1703,5409,531],["Funchal",3265,-1688,531],["Sibu",230,11184,531],["Criciúma",-2868,-4939,531],["Mossoró",-519,-3734,531],["Biskra",3486,573,531],["Pskov",5783,2833,531],["Campeche",1983,-9050,531],["Kalemie",-593,2920,531],["Yamoussoukro",682,-528,531],["Lashkar Gah",3158,6436,530],["Pingzhen",2494,12122,530],["Zhubei",2483,12101,530],["Bila Tserkva",4977,3013,530],["Aydın",3785,2785,530],["Chiniot",3172,7298,530],["San Miguel",1348,-8818,530],["Huangyan",2865,12125,530],["Gurgaon",2845,7702,530],["Bulandshahr",2841,7785,530],["Rivera",-3090,-5556,530],["Waukegan",4236,-8784,530],["Roanoke",3727,-7994,530],["El Tigre",889,-6426,530],["Kasama",-1020,3118,530],["Cartagena",3760,-98,530],["Moratuwa",678,7988,530],["Bacău",4658,2692,530],["Batu Pahat",185,10293,530],["Taza",3422,-402,530],["Armavir",4500,4113,530],["Salamanca",2057,-10120,530],["Nema",1662,-725,530],["Az Zawiyah",3276,1272,530],["Bergamo",4570,967,530],["Rashid",3146,3039,530],["Kōfu",3565,13858,530],["Mbanza-Ngungu",-525,1486,530],["Proddatur",1475,7857,530],["Puri",1982,8590,530],["Haldia",2203,8806,530],["Purnia",2579,8748,530],["Sete Lagoas",-1945,-4425,530],["Meymaneh",3593,6477,530],["Pokhara",2826,8397,530],["Green Bay",4453,-8800,530],["Thanh Hóa",1982,10580,530],["Balakovo",5203,4780,530],["Daşoguz",4184,5996,530],["Gedaref",1404,3538,530],["Martapura",-341,11484,530],["Gemena",326,1977,530],["Talca",-3546,-7167,530],["Dindigul",1038,7800,530],["Montgomery",3236,-8628,530],["Kushiro",4297,14437,530],["Saskatoon",5217,-10667,530],["Iskandar",4155,6968,529],["Al Jahra",2934,4766,529],["Cartago",987,-8393,529],["Manchester",4300,-7146,529],["Porlamar",1096,-6385,529],["Oxford",5177,-125,529],["Engels",5150,4612,529],["Bongor",1029,1539,529],["Kure",3425,13257,529],["Nagaoka",3745,13886,529],["Brikama",1328,-1666,529],["Machilipatnam",1620,8118,529],["Reims",4925,403,529],["Burhanpur",2130,7613,529],["Gandhinagar",2330,7264,529],["Divinópolis",-2015,-4490,529],["Severodvinsk",6457,3983,529],["Coro",1142,-6968,529],["Burgas",4251,2747,529],["Tarakan",330,11763,529],["Valera",932,-7062,528],["Dhamar",1456,4439,528],["Syzran",5317,4848,528],["Ciudad Madero",2232,-9784,528],["Barrancabermeja",709,-7385,528],["Bhiwani",2881,7613,528],["Angers",4748,-53,528],["Sơn Tây",2114,10551,528],["Aberdeen",5717,-208,528],["Norwich",5263,130,528],["Klaipėda",5572,2112,528],["Sadiqabad",2830,7013,528],["Muar",203,10257,528],["Butuan",895,12554,528],["Bayamo",2038,-7664,528],["Dunhua",4335,12822,528],["Nandyal",1552,7848,528],["Caen",4918,-35,528],["Đồng Hới",1748,10660,528],["Cork",5190,-850,528],["Gainesville",2965,-8233,528],["Ft. Myers",2664,-8186,528],["Ziguinchor",1259,-1629,528],["Zlatoust",5517,5965,528],["Mwene-Ditu",-700,2344,528],["Catamarca",-2847,-6578,528],["Kabwe",-1444,2845,528],["Quelimane",-1788,3689,528],["La Paz",2414,-11032,528],["St.-Denis",-2088,5545,528],["Bridgetown",1310,-5962,528],["Parakou",934,262,528],["Mainz",4998,827,527],["Marbella",3652,-488,527],["Kramatorsk",4872,3753,527],["Kütahya",3942,2993,527],["San Cristobal de Las Casas",1675,-9263,527],["Olsztyn",5380,2048,527],["Manpo",4115,12630,527],["Cachoeiro de Itapemirim",-2085,-4113,527],["Ad Damazīn",1177,3435,527],["Yei",409,3068,527],["Shendi",1668,3342,527],["Pécs",4608,1822,527],["Szeged",4625,2015,527],["Paarl",-3370,1896,527],["Puerto Vallarta",2068,-10524,527],["Madiun",-763,11151,527],["Cienfuegos",2214,-8044,527],["Rio Grande",-3205,-5212,527],["Mostaganem",3594,9,527],["Tiarat",3538,132,527],["Ruse",4385,2597,527],["Gibraltar",3613,-538,527],["Kimchaek",4067,12920,527],["Pinar del Rio",2242,-8370,527],["Jamaame",7,4275,527],["Arapiraca",-975,-3667,527],["Laayoune",2715,-1320,527],["Ternate",79,12736,527],["Fianarantsoa",-2143,4708,527],["Arica",-1850,-7029,527],["Petropavlovsk-Kamchatsky",5306,15862,527],["Shibin el Kom",3059,3090,526],["Ceerigaabo",1058,4733,526],["Mataró",4154,245,526],["Corum",4052,3495,526],["Chilpancingo",1755,-9950,526],["Reggio di Calabria",3811,1564,526],["Anda",4640,12532,526],["Bhusawal",2102,7583,526],["Kutaisi",4225,4273,526],["Rio Claro",-2241,-4756,526],["Tangail",2425,8992,526],["Kalamazoo",4229,-8559,526],["Chingola",-1254,2785,526],["Castello",3997,-5,526],["Biratnagar",2648,8728,526],["El Jadida",3326,-851,526],["Kamensk Uralskiy",5642,6194,526],["Gangneung",3776,12890,526],["Tarlac",1548,12058,526],["Funtua",1152,732,526],["Probolinggo",-775,11315,526],["Pinrang",-379,11965,526],["Zhaodong",4608,12598,526],["Obuasi",619,-166,526],["Sirsa",2949,7503,526],["Tonk",2615,7579,526],["Bahraich",2762,8167,526],["Barrie",4438,-7970,526],["Balkh",3675,6690,526],["Potosí",-1957,-6575,526],["Hinthada",1765,9547,526],["Brownsville",2592,-9750,526],["Gweru",-1945,2982,526],["Manta",-98,-8073,526],["Dese",1113,3963,526],["Santa Barbara",3443,-11972,526],["Amarillo",3523,-10183,526],["Savannah",3202,-8111,526],["Zuwara",3293,1208,526],["Atyrau",4711,5192,526],["Nyíregyháza",4797,2172,525],["Treviso",4567,1224,525],["Sangolquí",-31,-7846,525],["Varamin",3532,5165,525],["Malayer",3432,4885,525],["Denton",3322,-9713,525],["Erie",4213,-8008,525],["Almería",3683,-243,525],["Ar Raqqah",3593,3902,525],["Si Racha",1316,10093,525],["Phan Rang",1157,10898,525],["Teziutlán",1982,-9736,525],["Salatiga",-731,11049,525],["El Arish",3112,3380,525],["Vizianagaram",1812,8350,525],["Alappuzha",950,7637,525],["Vellore",1292,7915,525],["El Oued",3337,686,525],["Letpadan",1778,9574,525],["Termiz",3723,6727,525],["Turku",6045,2225,525],["Passo Fundo",-2825,-5242,525],["Kadugli",1101,2970,525],["Klerksdorp",-2688,2662,525],["Boma",-583,1305,525],["Korhogo",946,-564,525],["Ouargla",3197,534,525],["Mary",3760,6183,525],["Yuzhno Sakhalinsk",4696,14274,525],["Nogales",3131,-11094,525],["Sittwe",2014,9288,525],["Regina",5045,-10462,525],["Bade",2496,12130,524],["Yangmei",2492,12115,524],["Waterbury",4155,-7305,524],["Isparta",3777,3053,524],["Saida",3356,3537,524],["Modena",4465,1092,524],["Simla",3110,7717,524],["Sirjan",2947,5573,524],["Wahiawa",2150,-15802,524],["Puerto Cabello",1047,-6817,524],["Hong Gai",2096,10710,524],["Les Cayes",1820,-7375,524],["Entebbe",6,3246,524],["Bida",908,601,524],["Banyuwangi",-820,11437,524],["Esmeraldas",93,-7967,524],["Ulm",4840,1000,524],["Weinan",3450,10950,524],["Lishui",2845,11990,524],["Obihiro",4293,14317,524],["Tomakomai",4265,14155,524],["As Samawah",3131,4528,524],["Saveh",3502,5033,524],["Stavanger",5897,568,524],["Hirosaki",4057,14047,524],["Peoria",4070,-8967,524],["Evansville",3797,-8756,524],["Nova Friburgo",-2226,-4254,524],["Bo",797,-1174,524],["Riobamba",-167,-7865,524],["Bata",187,977,524],["Harar",932,4215,524],["Taitung",2276,12114,524],["George",-3395,2245,524],["Bose",2390,10661,524],["Suva",-1813,17844,524],["Puerto Montt",-4147,-7293,524],["Poughkeepsie",4170,-7392,523],["Arad",4617,2132,523],["Prizren",4223,2075,523],["Sonsonate",1372,-8973,523],["Rijeka",4533,1445,523],["Takaoka",3667,13700,523],["Barra Mansa",-2256,-4417,523],["Kragujevac",4402,2092,523],["Baranavichy",5314,2601,523],["Burgos",4235,-368,523],["Pitești",4486,2488,523],["Keluang",204,10332,523],["Al Marj",3250,2083,523],["Fuyang",3290,11582,523],["Würzburg",4980,995,523],["Baramula",3420,7435,523],["Hindupur",1378,7749,523],["Nîmes",4383,435,523],["Dijon",4733,503,523],["Medinipur",2233,8715,523],["Čačak",4389,2033,523],["Jamalpur",2490,8995,523],["Tébessa",3541,812,523],["Temirtau",5007,7296,523],["Cedar Rapids",4197,-9166,523],["Araçatuba",-2121,-5045,523],["Atbarah",1771,3398,523],["Sarh",915,1839,523],["Uvira",-337,2914,523],["Bandar-e Bushehr",2892,5083,523],["Djelfa",3468,325,523],["Jayapura",-253,14070,523],["Nzérékoré",776,-883,523],["Benha",3047,3118,522],["Hawalli",2933,4800,522],["Rock Island",4149,-9053,522],["Ocumare del Tuy",1012,-6678,522],["San Fernando",1028,-6146,522],["Chirchiq",4145,6956,522],["Novocherkassk",4742,4008,522],["Oldenburg",5313,822,522],["Sitapur",2763,8075,522],["Carpina",-784,-3526,522],["Elbasan",4112,2008,522],["Zenica",4422,1792,522],["Nantou",2392,12068,522],["Hà Tĩnh",1833,10590,522],["Gonaïves",1945,-7268,522],["Kigoma",-488,2961,522],["Miass",5500,6009,522],["Ormac",1106,12461,522],["Parma",4481,1032,522],["Serang",-611,10615,522],["Tuluá",409,-7621,522],["Pizen",4974,1336,522],["Regensburg",4902,1212,522],["Fatehpur",2588,8080,522],["Lajes",-2781,-5031,522],["Waco",3155,-9715,522],["Ayacucho",-1318,-7422,522],["León",1244,-8688,522],["Dibrugarh",2748,9490,522],["Kimberley",-2875,2477,522],["Rustenburg",-2565,2724,522],["Volgodonsk",4751,4216,522],["Berezniki",5942,5676,522],["Kendari",-396,12260,522],["Livingstone",-1786,2586,522],["Abakan",5370,9145,522],["Norilsk",6934,8822,522],["Reykjavík",6415,-2195,522],["Marabá",-535,-4912,522],["La Vega",1922,-7052,521],["Ash Shatrah",3142,4618,521],["Budaun",2803,7909,521],["Wilmington",3975,-7555,521],["Salamanca",4097,-567,521],["Tartus",3488,3589,521],["Ras al Khaymah",2579,5594,521],["Phitsanulok",1683,10027,521],["Sullana",-489,-8068,521],["Settat",3301,-762,521],["Dagupan",1605,12034,521],["Lecce",4036,1815,521],["Tunja",555,-7337,521],["Ingolstadt",4877,1145,521],["Xiaogan",3092,11390,521],["Simao",2278,10098,521],["Coquimbo",-2995,-7134,521],["Mahabad",3677,4572,521],["Navsari",2085,7292,521],["Mostar",4335,1782,521],["Myingyan",2146,9539,521],["Ponce",1800,-6662,521],["Rubtsovsk",5152,8121,521],["Patra",3823,2173,521],["Dourados",-2223,-5481,521],["Geelong",-3817,14440,521],["Bhisho",-3287,2739,521],["La Rioja",-2941,-6685,521],["Fargo",4688,-9679,521],["Wilmington",3423,-7795,521],["Geneina",1345,2244,521],["Malakal",954,3166,521],["Bumba",219,2246,521],["Taunggyi",2078,9704,520],["Samarra",3419,4388,520],["Punta del Este",-3497,-5495,520],["Maykop",4461,4012,520],["Hoshiarpur",3152,7598,520],["Sobral",-369,-4035,520],["Rio Largo",-948,-3584,520],["Wilkes-Barre",4125,-7588,520],["Albacete",3900,-187,520],["Zarzis",3351,1110,520],["Melitopol",4684,3538,520],["York",5397,-108,520],["Afyon",3875,3055,520],["Zonguldak",4143,3178,520],["Tiraspol",4685,2964,520],["Salavat",5337,5593,520],["Nakhodka",6775,7752,520],["Pagadian",785,12351,520],["Lázaro Cárdenas",1796,-10220,520],["Matsue",3547,13307,520],["Rustavi",4157,4505,520],["Gonbad-e Kavus",3725,5517,520],["Cuddalore",1172,7977,520],["Odense",5540,1038,520],["Lafayette",3020,-9202,520],["Nakhodka",4284,13289,520],["Ussuriysk",4380,13202,520],["Dali",2570,10018,520],["Kashmar",3518,5845,520],["Salinas",3668,-12164,520],["Xapeco",-2710,-5264,520],["Huánuco",-992,-7624,520],["Puerto Princesa",975,11874,520],["Hurghada",2723,3383,520],["Isiro",276,2762,520],["Sudbury",4650,-8097,520],["Olympia",4704,-12290,520],["Surat Thani",915,9934,520],["Moundou",855,1609,520],["Barreiras",-1214,-4500,520],["Tarija",-2152,-6475,520],["Abéché",1384,2083,520],["Valdivia",-3980,-7325,520],["Antakya",3623,3612,519],["Sariwon",3851,12576,519],["San Cristóbal",1842,-7011,519],["Gyeongju",3584,12921,519],["Sibiu",4580,2414,519],["Masjed Soleyman",3198,4930,519],["Niagara Falls",4309,-7904,519],["Scranton",4141,-7566,519],["Uroteppa",3992,6900,519],["Pathum Thani",1402,10053,519],["Ordu",4100,3787,519],["Middelburg",-2576,2947,519],["Kovrov",5636,4133,519],["Ciudad del Carmen",1865,-9182,519],["Livorno",4355,1030,519],["Foggia",4146,1556,519],["Guangshui",3162,11400,519],["Tottori",3550,13423,519],["Moanda",-592,1235,519],["Gandajika",-674,2396,519],["Koforidua",609,-26,519],["Kanchipuram",1283,7972,519],["Shkodër",4207,1952,519],["Innsbruck",4728,1141,519],["Barysaw",5423,2849,519],["Lemosos",3468,3303,519],["Chetumal",1850,-8830,519],["Muroran",4235,14098,519],["Batumi",4160,4163,519],["Río Cuarto",-3313,-6435,519],["Osorno",-4057,-7316,519],["Sioux Falls",4355,-9673,519],["Mufulira",-1255,2826,519],["Mahajanga",-1567,4635,519],["Yulin",3828,10973,519],["Bei'an",4824,12648,519],["La Serena",-2990,-7125,519],["Battambang",1310,10320,519],["Cairns",-1689,14576,519],["Malabo",375,878,519],["Gondar",1261,3746,519],["Cao Lãnh",1047,10564,518],["Pattani",686,10125,518],["M'sila",3570,455,518],["Yilan",2475,12175,518],["National City",3267,-11710,518],["Carora",1019,-7008,518],["Guanare",905,-6975,518],["Paterson",4092,-7417,518],["Uzhgorod",4863,2225,518],["Nusaybin",3707,4122,518],["Novokuybishevsk",5312,4992,518],["Deyang",3113,10440,518],["San Francisco de Macorís",1930,-7025,518],["Guarapuava",-2538,-5148,518],["Fayetteville",3606,-9416,518],["Edinburg",2630,-9816,518],["Coral Gables",2572,-8029,518],["Zabīd",1420,4332,518],["Kerch",4537,3649,518],["Khiwa",4139,6036,518],["El Manaqil",1425,3298,518],["Dundee",5647,-300,518],["Uşak",3868,2942,518],["Tororo",71,3417,518],["Chincha Alta",-1342,-7614,518],["Kitale",103,3499,518],["Bintulu",317,11304,518],["Bălți",4776,2791,518],["Samalut",2830,3071,518],["Keren",1568,3845,518],["Wenshan",2337,10425,518],["Dingzhou",3850,11500,518],["Silchar",2479,9279,518],["Nazareth",3270,3530,518],["Ilam",3363,4643,518],["Maragheh",3742,4622,518],["Faizabad",2675,8217,518],["Rondonópolis",-1647,-5464,518],["Abbotsford",4905,-12230,518],["Mudon",1626,9772,518],["Miaoli",2457,12082,518],["Suhar",2436,5673,518],["Limoges",4583,125,518],["Urgentch",4156,6064,518],["Luanshya",-1313,2840,518],["Vryheid",-2776,3079,518],["Chillán",-3660,-7211,518],["Benguela",-1258,1341,518],["Lạng Sơn",2185,10676,517],["Dar'a",3263,3611,517],["El Progreso",1485,-9002,517],["Jijel",3682,577,517],["Mangyshlak",4369,5114,517],["Vallejo",3811,-12226,517],["Independence",3909,-9442,517],["Bryan",3067,-9637,517],["Elkhart",4168,-8597,517],["Kolomna",5508,3878,517],["San Juan del Río",2038,-10000,517],["Ambala",3032,7682,517],["Aix-en-Provence",4352,545,517],["Perpignan",4270,290,517],["Poços de Caldas",-2178,-4657,517],["Cabo de Santo Agostinho",-829,-3503,517],["Gyumri",4079,4385,517],["Schenectady",4281,-7394,517],["Trang",756,9961,517],["Yala",655,10129,517],["Tirgu Mures",4656,2456,517],["Diourbel",1466,-1624,517],["Gharyan",3217,1302,517],["Perugia",4311,1239,517],["Ibarra",36,-7813,517],["Matanzas",2304,-8158,517],["Wamba",214,2799,517],["Palangkaraya",-221,11391,517],["Man",740,-755,517],["Brugge",5122,323,517],["Médéa",3627,277,517],["Willemstad",1220,-6902,517],["Turbat",2599,6307,517],["Cam Ranh",1190,10922,517],["Tabora",-502,3280,517],["Santa Cruz",3697,-12203,517],["Gulu",278,3228,517],["Gejiu",2338,10315,517],["Hamilton",-3778,17529,517],["Trondheim",6342,1042,517],["Jiayuguan",3982,9830,517],["Kafr el Sheikh",3111,3094,516],["Tizi-Ouzou",3671,405,516],["Székesfehérvár",4719,1841,516],["Biarritz",4347,-156,516],["Macaé",-2238,-4179,516],["Sarnia",4297,-8240,516],["Pasadena",3416,-11814,516],["Urbana",4011,-8820,516],["Belleville",3853,-9000,516],["Huelva",3725,-693,516],["Qairouan",3568,1010,516],["Ayutthaya",1436,10057,516],["Logroño",4247,-243,516],["Ipswich",5207,117,516],["Kenema",788,-1119,516],["Machakos",-151,3726,516],["Jinchang",3850,10217,516],["Otaru",4319,14098,516],["Cape Coast",511,-125,516],["Kolar",1313,7813,516],["Brest",4839,-450,516],["Le Mans",4800,10,516],["Amiens",4990,230,516],["Tall Afar",3638,4245,516],["Quchan",3711,5850,516],["Pointe-à-Pitre",1624,-6153,516],["Kumba",464,944,516],["Concordia",-3139,-5803,516],["Stara Zagora",4242,2562,516],["Tuzla",4455,1868,516],["Dawei",1410,9819,516],["La Ceiba",1576,-8680,516],["Hanzhong",3313,10703,516],["Krishnanagar",2338,8853,516],["Play Ku",1398,10800,516],["Calama",-2245,-6892,516],["Ajdabiya",3077,2022,516],["Béchar",3161,-223,516],["Podgorica",4247,1927,516],["Goma",-168,2922,516],["Los Angeles",-3746,-7236,516],["Arnhem",5199,592,515],["Bordj Bou Arréridj",3608,476,515],["Pyatigorsk",4408,4309,515],["Arzamas",5540,4380,515],["Orekhovo-Zuevo",5582,3898,515],["As Salt",3204,3573,515],["Ciego de Ávila",2184,-7876,515],["Paranaguá",-2553,-4853,515],["Sherbrooke",4540,-7190,515],["Ocala",2919,-8214,515],["Asheville",3560,-8255,515],["Binghamton",4210,-7592,515],["Bizerte",3729,985,515],["Badajoz",3888,-697,515],["Peterborough",5258,-25,515],["Almetyevsk",5490,5232,515],["Chongju",3968,12522,515],["Jieshou",3325,11535,515],["Massawa",1561,3945,515],["Nongan",4443,12517,515],["Durrës",4132,1945,515],["Ghazni",3356,6842,515],["Saïda",3484,14,515],["Nawabganj",2458,8835,515],["Phuket",788,9838,515],["Cajamarca",-715,-7853,515],["Melilla",3530,-295,515],["Lhokseumawe",519,9714,515],["Labé",1132,-1230,515],["Dunhuang",4014,9466,515],["Altay",4787,8812,515],["Comodoro Rivadavia",-4587,-6750,515],["Zalantun",4800,12272,514],["Killeen",3112,-9773,514],["Tan An",1053,10642,514],["Baia Mare",4766,2358,514],["Chinandega",1263,-8713,514],["Piedras Negras",2871,-10053,514],["Bremerhaven",5355,858,514],["Göttingen",5152,992,514],["Tiruvannamalai",1226,7910,514],["Kumbakonam",1098,7940,514],["Castanhal",-129,-4793,514],["Pabna",2400,8925,514],["Cerro de Pasco",-1069,-7627,514],["Myitkyina",2536,9739,514],["Umtata",-3158,2879,514],["Iraklio",3533,2513,514],["Oulu",6500,2547,514],["Parnaíba",-291,-4177,514],["Shizuishan",3923,10677,514],["Townsville",-1925,14677,514],["'s-Hertogenbosch",5168,532,513],["New Bedford",4166,-7094,513],["Lafayette",4042,-8688,513],["León",4258,-557,513],["Šiauliai",5594,2333,513],["Nevinnomyssk",4462,4195,513],["May Pen",1797,-7723,513],["Cartago",475,-7591,513],["Cẩm Phả",2104,10732,513],["Lira",226,3289,513],["Győr",4770,1763,513],["Serpukhov",5493,3743,513],["Ravenna",4442,1222,513],["Yunxian",3281,11081,513],["Zakho",3714,4269,513],["Souk Ahras",3629,795,513],["Orsha",5452,3042,513],["Springfield",3982,-8965,513],["Portland",4367,-7025,513],["Pyay",1882,9521,513],["Pervouralsk",5691,5996,513],["Jequié",-1385,-4008,513],["Touggourt",3310,606,513],["Caxias",-483,-4335,513],["Tra Vinh",993,10633,512],["Awasa",706,3848,512],["Buzău",4516,2681,512],["Kislovodsk",4391,4272,512],["Novomoskovsk",5409,3822,512],["Opole",5068,1793,512],["San Luis",1620,-8944,512],["Shahrud",3642,5496,512],["Pilibhit",2864,7981,512],["Pindamonhangaba",-2292,-4547,512],["Caldwell",4366,-11667,512],["Cape Coral",2660,-8198,512],["Clarksville",3653,-8736,512],["Fredericksburg",3830,-7746,512],["Racine",4273,-8781,512],["Nikopol",4757,3441,512],["Ninh Bình",2025,10598,512],["Musoma",-149,3380,512],["Birganj",2700,8487,512],["Murom",5557,4204,512],["Dimitrovgrad",5425,4956,512],["Ferrara",4485,1161,512],["Blitar",-807,11215,512],["Riohacha",1154,-7291,512],["Florencia",161,-7562,512],["Ciénaga",1101,-7425,512],["Shuangcheng",4535,12628,512],["Abohar",3012,7429,512],["Pinsk",5213,2609,512],["Uppsala",5986,1764,512],["Topeka",3905,-9567,512],["Lae",-673,14699,512],["Moçâmedes",-1519,1216,512],["Papeete",-1753,-14957,512],["St. John's",4758,-5268,512],["Tokat",4031,3656,511],["Divo",584,-536,511],["Masaya",1197,-8609,511],["Sakakah",3000,4013,511],["Shahrekord",3232,5085,511],["Idlib",3593,3663,511],["Al Hasakah",3648,4075,511],["Karabük",4120,3260,511],["Panevežys",5574,2437,511],["Elbląg",5419,1940,511],["Girardot",431,-7481,511],["Besançon",4723,603,511],["Jaraguá do Sul",-2648,-4910,511],["San Nicolas",-3333,-6024,511],["Bragança Paulista",-2295,-4655,511],["Bloomington",4048,-8899,511],["Cambridge",5220,12,511],["Erzincan",3975,3949,511],["Batticaloa",772,8170,511],["Andong",3657,12873,511],["Tukuyu",-925,3364,511],["Kamyshin",5008,4540,511],["Manzanillo",2034,-7712,511],["Girga",2633,3188,511],["Port Blair",1167,9274,511],["Larissa",3963,2242,511],["Kokshetau",5330,6942,511],["Sennar",1355,3360,511],["Baydhabo",312,4365,511],["Kamina",-873,2501,511],["Surt",3121,1659,511],["Darnah",3276,2264,511],["Jima",768,3683,511],["Moroni",-1170,4324,511],["Worcester",-3364,1944,511],["Tete",-1617,3358,511],["Xai-Xai",-2504,3364,511],["Copiapó",-2736,-7034,511],["Ekibastuz",5173,7532,511],["Wau",770,2799,511],["Tây Ninh",1132,10615,510],["Nueva San Salvador",1367,-8929,510],["Greeley",4042,-10474,510],["Carúpano",1067,-6323,510],["Sogamoso",572,-7294,510],["Tengchong",2503,9847,510],["Marv Dasht",2980,5282,510],["Hathras",2760,7805,510],["Itapetininga",-2359,-4804,510],["Bremerton",4757,-12264,510],["Alexandria",3882,-7710,510],["Tarragona",4112,125,510],["Gafsa",3442,878,510],["Edirne",4167,2657,510],["Leeuwarden",5325,578,510],["Neftekamsk",5608,5426,510],["Lafia",849,852,510],["Gashua",1287,1104,510],["Sancti Spíritus",2193,-7944,510],["Zlín",4923,1765,510],["Fasa",2897,5367,510],["Semnan",3555,5337,510],["Alipur Duar",2648,8957,510],["Kumbo",622,1068,510],["Pakokku",2133,9509,510],["Montego Bay",1847,-7792,510],["Macheng",3118,11503,510],["Sorong",-86,13128,510],["Kelowna",4990,-11948,510],["Magway",2014,9492,510],["Songea",-1068,3565,510],["Pangkalpinang",-208,10615,510],["Loja",-399,-7921,510],["Malanje",-954,1634,510],["Lubango",-1491,1349,510],["Ghardaia",3249,367,510],["Maastricht",5085,568,509],["Higuey",1862,-6871,509],["Guelma",3647,743,509],["Spartanburg",3495,-8193,509],["Drohobych",4934,2350,509],["Barbacena",-2122,-4377,509],["Visalia",3633,-11932,509],["Boulder",4004,-10525,509],["Lysychansk",4892,3843,509],["Mỹ Tho",1035,10635,509],["Tekirdağ",4099,2751,509],["Brits",-2563,2778,509],["Potchefstroom",-2670,2710,509],["Siracusa",3707,1529,509],["Indramayu",-634,10832,509],["Pati",-674,11103,509],["Laiwu",3620,11766,509],["Jiaohe",4372,12735,509],["Aalborg",5703,992,509],["Gagnoa",615,-588,509],["Uruguaiana",-2977,-5709,509],["Porto Seguro",-1643,-3908,509],["San Fernando de Apure",790,-6747,509],["Monterey",3660,-12189,509],["Alagoinhas",-1214,-3843,509],["Agana",1347,14475,509],["Charleston",3835,-8163,509],["Ségou",1344,-626,509],["Rudniy",5295,6313,509],["Puerto Plata",1979,-7069,508],["Southaven",3497,-9000,508],["New Albany",3831,-8582,508],["Beaver Falls",4075,-8032,508],["Manbij",3653,3796,508],["Tetovo",4201,2097,508],["Udine",4607,1324,508],["Tuscaloosa",3323,-8754,508],["Olmaliq",4085,6960,508],["Karaman",3718,3322,508],["Larache",3520,-616,508],["Maxixe",-2387,3539,508],["Huanghua",3837,11733,508],["Nancha",4714,12929,508],["Jaú",-2229,-4857,508],["Sassari",4073,857,508],["Xilinhot",4394,11604,508],["Saginaw",4342,-8395,508],["Trois-Rivières",4635,-7255,508],["Tauranga",-3770,17615,508],["Nakhon Pathom",1382,10006,507],["Petersburg",3723,-7740,507],["Anaco",944,-6446,507],["Berdyansk",4676,3679,507],["San Martín",-3307,-6849,507],["Yuba City",3914,-12162,507],["Calabozo",893,-6744,507],["Jaén",3777,-380,507],["Sokodé",899,115,507],["Nizhyn",5105,3189,507],["Chiang Rai",1991,9983,507],["Puno",-1583,-7003,507],["Cherkessk",4429,4206,507],["Bama",1152,1369,507],["Jalingo",890,1136,507],["Zielona Góra",5195,1550,507],["Langsa",467,9797,507],["Tongren",2768,10913,507],["Huanren",4126,12535,507],["Taonan",4533,12278,507],["Yakeshi",4928,12073,507],["Qomsheh",3201,5186,507],["Nkongsamba",496,994,507],["Pleven",4342,2461,507],["Ourense",4233,-787,507],["Setúbal",3853,-890,507],["Achinsk",5627,9050,507],["Vyborg",6070,2875,507],["Anuradhapura",835,8038,507],["Boké",1094,-1430,507],["Kindia",1006,-1287,507],["Bandundu",-331,1738,507],["Gao",1627,-5,507],["Dunedin",-4589,17049,507],["Agadez",1700,798,507],["Port-Gentil",-72,878,507],["Punta Arenas",-5316,-7094,507],["Siirt",3794,4193,506],["Bærum",5991,1135,506],["Spring Hill",2848,-8255,506],["Columbia",3561,-8704,506],["Kamyanets-Podilskyy",4868,2658,506],["Kecskemét",4690,1970,506],["Yelets",5258,3850,506],["Ciudad Valles",2198,-9902,506],["Pouso Alegre",-2222,-4594,506],["Santa Cruz do Sul",-2971,-5244,506],["Las Cruces",3231,-10678,506],["Norman",3523,-9734,506],["Macon",3285,-8363,506],["Murfreesboro",3585,-8639,506],["Nabeul",3646,1073,506],["Kulob",3792,6978,506],["Maribor",4654,1565,506],["Botoșani",4775,2666,506],["Navajoa",2708,-10945,506],["Zhijiang",2744,10968,506],["Buizhou",3737,11802,506],["Giyon",853,3797,506],["Shashemene",720,3859,506],["Valparai",1032,7697,506],["Kingston",4423,-7648,506],["Botucatu",-2288,-4845,506],["Tobolsk",5820,6826,506],["Tuguegarao",1761,12173,506],["Delicias",2820,-10550,506],["Abilene",3245,-9973,506],["Inhambane",-2386,3534,506],["Goulimine",2898,-1007,506],["Curicó",-3498,-7124,506],["Kuito",-1238,1694,506],["Laghouat",3381,288,506],["Tahoua",1490,526,506],["Sri Jayawardenepura Kotte",690,7995,506],["Toliara",-2336,4369,506],["Kankan",1039,-931,506],["Satu Mare",4779,2289,505],["Zwolle",5252,610,505],["Algeciras",3613,-547,505],["Tokmak",4283,7528,505],["Nefteyugansk",6108,7270,505],["Iguala",1837,-9954,505],["Conselheiro Lafaiete",-2067,-4379,505],["St. Cloud",4556,-9416,505],["Pueblo",3828,-10463,505],["Beaumont",3009,-9410,505],["Exeter",5070,-353,505],["Iringa",-777,3569,505],["Jawhar",277,4552,505],["Guanajuato",2102,-10128,505],["Nsukka",687,738,505],["Nguru",1288,1045,505],["Shaowu",2730,11750,505],["Magelang",-747,11018,505],["Mojokerto",-747,11243,505],["Kitami",4385,14390,505],["Kipushi",-1176,2725,505],["Mazyr",5205,2927,505],["Tyler",3235,-9530,505],["Nakhon Sawan",1570,10007,505],["Daugavpils",5588,2651,505],["Juba",483,3158,505],["Kandy",728,8067,505],["Santa Rosa",-3662,-6430,505],["Malé",417,7350,505],["Praia",1492,-2352,505],["Manzini",-2650,3139,504],["Trincomalee",857,8123,504],["Harlingen",2620,-9769,504],["Winter Haven",2802,-8173,504],["Szombathely",4723,1663,504],["Sergiyev Posad",5633,3817,504],["Bataysk",4714,3974,504],["Leninsk Kuznetsky",5466,8617,504],["Dali",3480,10994,504],["Volos",3937,2295,504],["Catanduva",-2114,-4898,504],["Rochester",4402,-9247,504],["Santa Maria",3494,-12044,504],["Athens",3396,-8338,504],["Balkanabat",3951,5436,504],["Kaposvár",4637,1780,504],["Szolnok",4719,2018,504],["Matagalpa",1292,-8592,504],["Tuxpam",2096,-9741,504],["Milagro",-218,-7960,504],["Ipiales",83,-7765,504],["Linqing",3685,11568,504],["Hailun",4745,12693,504],["Tieli",4695,12805,504],["Soubré",579,-661,504],["Kandi",1113,294,504],["Bouïra",3638,390,504],["Yaynangyoung",2046,9488,504],["Medford",4233,-12287,504],["Noyabrsk",6317,7562,504],["Manzanillo",1905,-10432,504],["Heihe",5025,12745,504],["Tumbes",-357,-8046,504],["Lichinga",-1330,3524,504],["Mopti",1449,-418,504],["San Rafael",-3460,-6833,504],["Garanhuns",-889,-3650,504],["Pemba",-1298,4053,504],["David",843,-8243,504],["Mzuzu",-1146,3402,504],["Siem Reap",1337,10385,504],["Rimnicu Vilcea",4511,2438,503],["Västerås",5963,1654,503],["Drobeta-Turnu Severin",4465,2267,503],["Estelí",1309,-8636,503],["Oktyabrskiy",5446,5346,503],["Novotroitsk",5120,5833,503],["Chapayevsk",5297,4972,503],["Escuintla",1533,-9263,503],["Barletta",4132,1627,503],["Apucarana",-2355,-5147,503],["Koszalin",5420,1618,503],["Douliou",2371,12054,503],["Kogon",3972,6455,503],["Ratchaburi",1354,9982,503],["Shinyanga",-366,3342,503],["En Nuhud",1269,2842,503],["Coimbra",4020,-842,503],["Obninsk",5508,3662,503],["Derbent",4206,4828,503],["Birnin Kebbi",1245,420,503],["Louangphrabang",1988,10214,503],["Trento",4608,1112,503],["Pardubice",5004,1576,503],["Longjiang",4734,12318,503],["Ilebo",-432,2061,503],["Escuintla",1430,-9078,503],["Namur",5047,487,503],["Mascara",3540,14,503],["Taungoo",1895,9642,503],["Burco",952,4554,503],["Odessa",3185,-10237,503],["Luxembourg",4961,613,503],["Nehe",4849,12488,503],["Elista",4633,4421,503],["Bagé",-3132,-5410,503],["Kyzyl",5171,9438,503],["Raba",-845,11877,503],["Golmud",3642,9488,503],["Al Qamishli",3703,4123,502],["Konotop",5124,3321,502],["Suceava",4764,2626,502],["Focșani",4570,2719,502],["Kiselevsk",5400,8664,502],["Annecy",4590,612,502],["Ahar",3848,4706,502],["Utica",4310,-7523,502],["Lugano",4600,897,502],["Yevpatoriya",4520,3336,502],["Nong Khai",1787,10275,502],["Hoa Binh",2081,10534,502],["Kon Tum",1438,10798,502],["Kilinochchi",940,8040,502],["Granada‎",1193,-8595,502],["Pec",4266,2031,502],["Lahad Datu",505,11834,502],["Queenstown",-3190,2688,502],["Fresnillo",2317,-10286,502],["Koutiala",1239,-547,502],["Azare",1168,1019,502],["Biak",-116,13605,502],["Brindisi",4064,1793,502],["Maumere",-862,12221,502],["Gera",5087,1207,502],["Jena",5093,1158,502],["Cottbus",5177,1433,502],["Kongolo",-538,2698,502],["San Antonio",-3360,-7161,502],["Adigrat",1428,3947,502],["Torbat-e Jam",3522,6061,502],["Loubomo",-418,1267,502],["Abengourou",673,-349,502],["Prijedor",4498,1670,502],["Gardiz",3360,6921,502],["Grand Junction",3909,-10855,502],["Zhezqazghan",4778,6777,502],["Salto",-3139,-5797,502],["Lynchburg",3741,-7914,502],["Sadah",1694,4385,502],["Tandil",-3732,-5915,502],["Albury",-3606,14692,502],["Ad-Damir",1759,3396,502],["Jizan",1691,4256,502],["Mmabatho",-2583,2561,502],["Kroonstad",-2766,2721,502],["Linhares",-1939,-4005,502],["Billings",4579,-10854,502],["Assab",1301,4273,502],["Vĩnh Long",1026,10596,501],["Piatra-Neamt",4694,2638,501],["Kennewick",4621,-11914,501],["Hidalgo del Parral",2693,-10567,501],["Palma Soriano",2022,-7600,501],["Liberec",5080,1508,501],["Olomouc",4963,1725,501],["Barretos",-2055,-4858,501],["Maladzyechna",5432,2687,501],["Lower Hutt",-4120,17491,501],["Council Bluffs",4126,-9586,501],["Monroe",3251,-9212,501],["Muskegon",4323,-8625,501],["Pedro Juan Caballero",-2254,-5576,501],["Dera Ismail Khan",3183,7090,501],["Teluk Intan",401,10103,501],["Bethal",-2647,2945,501],["Sarapul",5648,5380,501],["Ibri",2323,5652,501],["Grudziądz",5348,1875,501],["Pakxe",1512,10582,501],["Kilchu",4096,12932,501],["Perabumulih",-344,10423,501],["Matruh",3135,2723,501],["Wichita Falls",3391,-9849,501],["Velikiye Luki",5632,3052,501],["Ukhta",6356,5369,501],["Kansk",5619,9571,501],["Bontang",13,11750,501],["Roxas",1159,12275,501],["Teófilo Otoni",-1787,-4150,501],["Guaymas",2793,-11089,501],["Houma",3562,11121,501],["Oum el Bouaghi",3585,715,500],["Panama City",3016,-8566,500],["Solikamsk",5967,5675,500],["Novara",4545,862,500],["Magangué",923,-7474,500],["Subotica",4607,1968,500],["Vanadzor",4081,4449,500],["Bloomington",3917,-8653,500],["Kpalimé",690,63,500],["Bukoba",-132,3180,500],["Glazov",5812,5263,500],["Ancona",4360,1350,500],["Duitama",583,-7302,500],["Isna",2529,3255,500],["Lida",5389,2528,500],["Chamdo",3117,9723,500],["Arlit",1882,733,500],["Tartu",5838,2671,500],["Ust-Ilimsk",5799,10263,500],["Sakata",3892,13985,500],["Sabha",2703,1443,500]]; // [name, lat*100, lon*100, log10(pop)*100][]

const CITY_IDX = new Map();
const cityRadiusKm = (logp) => Math.min(42, 3 + 14 * Math.max(0, logp - 5));
for (const [name, la, lo, lp] of CITY_DATA) {
  const lat = la / 100, lon = lo / 100, logp = lp / 100;
  const c = { name, lat, lon, R: cityRadiusKm(logp) };
  const key = (Math.floor(lat * 2) + 200) * 1000 + (Math.floor(lon * 2) + 400);
  const b = CITY_IDX.get(key);
  if (b) b.push(c); else CITY_IDX.set(key, [c]);
}

const TOP_CITIES = [...CITY_DATA]
  .sort((a, b) => b[3] - a[3])
  .slice(0, 60)
  .map(([name, la, lo]) => [name, la / 100, lo / 100]);

function urbanAt(lat, lon) {
  const cosl = Math.max(0.05, Math.cos((lat * Math.PI) / 180));
  const dLat = 45 / 110.6, dLon = Math.min(20, 45 / (111.32 * cosl));
  let u = 0, city = null, dkm = 1e9;
  const b0 = Math.floor((lat - dLat) * 2), b1 = Math.floor((lat + dLat) * 2);
  const g0 = Math.floor((lon - dLon) * 2), g1 = Math.floor((lon + dLon) * 2);
  for (let bl = b0; bl <= b1; bl++) for (let bg = g0; bg <= g1; bg++) {
    const bucket = CITY_IDX.get((bl + 200) * 1000 + (bg + 400));
    if (!bucket) continue;
    for (const c of bucket) {
      const dx = (lon - c.lon) * 111.32 * cosl, dy = (lat - c.lat) * 110.57;
      const d = Math.sqrt(dx * dx + dy * dy);
      if (d < dkm) { dkm = d; city = c; }
      const w = 1 - d / c.R;
      if (w > u) u = w;
    }
  }
  return { u, city, dkm };
}

function hashQk(qk) {
  let h = 2166136261;
  for (let i = 0; i < qk.length; i++) { h ^= qk.charCodeAt(i); h = Math.imul(h, 16777619); }
  return (h >>> 0) / 4294967296;
}

/* ── economy helpers ────────────────────────────────────────── */

// t.pr ("prestige") — see redevelop_tile in supabase.sql: a maxed-out tile
// can reset to Vacant for a permanent +25% rent bonus per cycle, repeatable.
// Rebuild cost scales with it too (upCost below), or it'd cost the same
// every cycle and let a wealthy player farm unlimited rent for free.
const rentOf = (t) => CLS[t.cls].rps * RAR[t.r].m * (1 + t.l) * (1 + 0.25 * (t.pr || 0));
const upCost = (t) => Math.round(CLS[t.cls].price * 0.8 * Math.pow(t.l + 1, 1.6) * (1 + 0.5 * (t.pr || 0)));

// Build timers — base seconds per TARGET level, MUST match the CASE in
// upgrade_tile()/rush_build() in supabase.sql exactly. Display/disabled-
// state only; the server owns the real countdown and completion.
const BUILD_SECONDS = { 1: 300, 2: 1800, 3: 7200, 4: 28800 };
const buildDurationSecs = (targetLevel, prestige) => BUILD_SECONDS[targetLevel] * (1 + 0.25 * (prestige || 0));
const buildSecsLeft = (t) => t.bu ? Math.max(0, Math.round((new Date(t.bu).getTime() - Date.now()) / 1000)) : 0;
// mirrors rush_build()'s proportional-remaining-time pricing exactly
const rushCostFor = (t) => {
  const totalSecs = buildDurationSecs(t.l + 1, t.pr);
  const frac = Math.min(1, buildSecsLeft(t) / Math.max(totalSecs, 1));
  return Math.ceil(upCost(t) * frac);
};

function rollRarity() {
  const n = Math.random();
  if (n < 0.02) return 3;
  if (n < 0.1) return 2;
  if (n < 0.3) return 1;
  return 0;
}

function fmt(n) {
  n = Math.floor(n);
  if (n < 10000) return n.toLocaleString();
  if (n < 1e6) return (n / 1e3).toFixed(1) + "k";
  if (n < 1e9) return (n / 1e6).toFixed(2) + "m";
  return (n / 1e9).toFixed(2) + "b";
}
// rps values now go well under 1 (see CLS) — 1 decimal alone would round
// e.g. 0.018 down to a meaningless "0.0", so sub-1 values get 3 decimals.
const fmt1 = (n) => (n < 1 ? n.toFixed(3) : n < 100 ? n.toFixed(1) : fmt(n));

// energy is now a flat daily value with no client-side ticking to
// simulate (unlike the old continuous regen model) — it only ever changes
// via an explicit server round-trip (sync_rent, or the optimistic
// decrement in buyUnowned). This wrapper exists purely so call sites don't
// need to care whether that's a plain field read; the server re-derives
// and enforces the real value independently either way.
const energyNow = (g) => g.energy;
// Seconds until the next UTC-midnight reset — display-only estimate of
// when reset_daily_energy() will next actually reset this player's energy
// (the real reset only happens lazily, on that player's next RPC call
// after the boundary, same "compute on read" pattern as everything else
// here, but midnight UTC is close enough for a countdown).
const energySecsToReset = () => {
  const now = new Date();
  const next = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1, 0, 0, 0);
  return Math.max(0, Math.round((next - Date.now()) / 1000));
};

// PvP: UTC calendar-day string ("YYYY-MM-DD") — used only to locally
// interpret a synced tile's attacks_received_date for the "attacked X/2
// today" display before the region cache next resyncs. Display only:
// attack_tile() re-derives this server-side and is the sole authority.
const todayUTC = () => new Date().toISOString().slice(0, 10);

// relative-time label for the HQ activity log — display only.
const timeAgo = (iso) => {
  const secs = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 1000));
  if (secs < 60) return "just now";
  if (secs < 3600) return `${Math.floor(secs / 60)}m ago`;
  if (secs < 86400) return `${Math.floor(secs / 3600)}h ago`;
  return `${Math.floor(secs / 86400)}d ago`;
};

/* ── in-memory game state ──────────────────────────────────────
   No localStorage save anymore: `profiles`/`tiles` in Postgres (via the
   RPCs in supabase.sql, keyed by auth.uid()) are the only source of truth.
   `g` stays a plain mutable object rather than React state — the render
   loop and economy tick both mutate it directly and call force() — so the
   rest of the component (Assets/Market/HQ tabs, the canvas renderer) reads
   the exact same shape it always has; only *where these fields come from*
   has changed. */
const gameFromProfile = (uid, profile) => ({
  uid,
  name: profile.username,
  bal: Number(profile.balance),
  own: [],
  ach: {},
  streak: profile.streak || 0,
  boostUntil: profile.boost_until ? new Date(profile.boost_until).getTime() : 0,
  boostReadyAt: profile.boost_ready_at ? new Date(profile.boost_ready_at).getTime() : 0,
  lastSeen: profile.last_seen ? new Date(profile.last_seen).getTime() : Date.now(),
  peakNetWorth: profile.peak_net_worth || 0,
  energy: profile.energy ?? statusFor(profile.peak_net_worth || 0).cap,
  attacksSent: profile.attacks_sent_count || 0,
  devMode: profile.dev_mode || false,
  hasUnseenLoss: false, // pure client-side cosmetic flag, never persisted server-side — see collectBattles
  rps: 0,
});

/* ── UI atoms ───────────────────────────────────────────────── */

const mono = { fontFamily: "'JetBrains Mono', ui-monospace, SFMono-Regular, Menlo, Consolas, monospace" };
const display = { fontFamily: "'Space Grotesk', ui-sans-serif, system-ui, sans-serif" };

/* ── minimal line-icon set — replaces emoji glyphs in the persistent map
   HUD (zoom/globe/cities/debug/basemap toggle). Emoji render inconsistently
   across platforms and read as placeholder art; a single stroke weight/size
   here reads as one deliberate icon system instead. */
function Icon({ children, size = 18 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor"
      strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {children}
    </svg>
  );
}
const IconPlus = (p) => <Icon {...p}><path d="M12 5v14M5 12h14" /></Icon>;
const IconMinus = (p) => <Icon {...p}><path d="M5 12h14" /></Icon>;
const IconGlobe = (p) => (
  <Icon {...p}>
    <circle cx="12" cy="12" r="8.5" />
    <path d="M3.5 12h17" />
    <path d="M12 3.5c3 3 3 14 0 17M12 3.5c-3 3-3 14 0 17" />
  </Icon>
);
const IconPlane = (p) => (
  <Icon {...p}>
    <path d="M3 13.2 20 6.5c1-.4 1.8.5 1.3 1.4l-6.9 12.4c-.4.7-1.5.6-1.8-.2L10.5 14 3.9 12.9c-.8-.1-1.1-1.2-.4-1.6Z" />
    <path d="M10.5 14 15 9.5" />
  </Icon>
);
const IconBug = (p) => (
  <Icon {...p}>
    <rect x="8" y="8.5" width="8" height="10" rx="4" />
    <path d="M12 8.5V6M9 6.8 7.3 5M15 6.8 16.7 5M8 12H4.5M16 12h3.5M8.3 16.5 5 18.5M15.7 16.5 19 18.5M10 6.2a2 2 0 0 1 4 0" />
  </Icon>
);
const IconGrid = (p) => (
  <Icon {...p}>
    <rect x="3.5" y="3.5" width="17" height="17" rx="1.5" />
    <path d="M3.5 9.5h17M3.5 14.5h17M9.5 3.5v17M14.5 3.5v17" />
  </Icon>
);
const IconLayers = (p) => (
  <Icon {...p}>
    <path d="M12 3.5 21 8l-9 4.5L3 8Z" />
    <path d="m3 12.5 9 4.5 9-4.5M3 16.5l9 4.5 9-4.5" />
  </Icon>
);

function Btn({ children, onClick, disabled, tone = "amber", full, small }) {
  const tones = {
    amber: {
      backgroundImage: C.amberGrad,
      color: "#2B1B03",
      border: "1px solid #E8A430",
      boxShadow: disabled ? "none" : "0 1px 0 rgba(255,255,255,.4) inset, 0 -3px 6px rgba(0,0,0,.14) inset, 0 8px 18px -6px rgba(226,154,46,.55)",
    },
    ghost: { background: `${C.panel}b3`, color: C.text, border: `1px solid ${C.hairLit}`, ...blur(8) },
    danger: { background: "#2A1013b3", color: "#F08A8A", border: "1px solid #5A2A33" },
  };
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      className={`rounded-xl font-semibold tracking-wide transition-all duration-150 ease-out focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 ${
        small ? "px-3 py-1.5 text-xs" : "px-4 py-2.5 text-sm"
      } ${full ? "w-full" : ""} ${disabled ? "opacity-35" : "hover:brightness-110 active:scale-[0.97] active:brightness-95"}`}
      style={{ ...display, fontWeight: 600, ...tones[tone], outlineColor: C.amber }}
    >
      {children}
    </button>
  );
}

function Chip({ color, children }) {
  return (
    <span className="pt10 rounded-full px-2 py-0.5 font-bold uppercase tracking-widest"
      style={{ ...display, color, background: color + "22", border: `1px solid ${color}66`, boxShadow: `0 0 10px ${color}33` }}>
      {children}
    </span>
  );
}

function Eyebrow({ children }) {
  return <div className="pt10 trk uppercase font-semibold" style={{ ...display, color: C.dim }}>{children}</div>;
}

/* ═════════════════════════════════════════════════════════════
   MAIN
   ═════════════════════════════════════════════════════════════ */

// One persistent account per Google login, forever — there is no "new
// game": signing back in with the same account always continues the same
// wallet/tiles/streak, and the only way to start over is to delete your
// account & data from the HQ tab (which really deletes it, see auth.js /
// the delete-account edge function).
// Real continent silhouettes — derived from Natural Earth 110m land polygons
// (public domain; same source this project already credits for coastlines),
// equirectangular-projected to this 1000x500 viewBox and decimated down to
// ~1000 points for a lightweight decorative path. Antarctica is dropped
// deliberately: at this simplification level it's an unrecognizable jagged
// strip, and every decorative world-map background (Stripe, Mailchimp, etc.)
// crops it for the same reason.
const WORLD_LAND_PATH = "M797.1,36.2L808.5,36.9L814.8,38.3L806.0,43.1L813.9,44.5L821.0,45.1L829.9,45.6L842.2,47.3L848.3,45.7L857.2,47.1L860.3,52.2L867.4,50.5L876.6,51.0L884.0,51.0L890.2,47.6L915.3,49.4L924.9,53.2L936.1,52.7L944.0,54.3L950.8,56.5L960.9,57.0L971.0,59.2L982.3,56.1L996.1,57.2L1000.0,69.5L992.8,70.5L998.3,75.0L984.9,78.4L978.2,80.7L969.2,81.7L961.9,83.9L954.3,83.7L950.0,88.2L952.9,94.0L945.5,99.0L940.4,102.9L935.5,108.3L933.3,102.3L931.8,96.2L935.4,90.7L944.9,85.2L954.6,80.2L944.8,81.8L935.3,79.3L928.4,84.0L920.2,86.7L912.6,85.7L904.1,85.2L895.0,86.0L886.0,91.4L875.4,98.0L881.1,100.1L888.6,99.5L892.7,104.9L890.3,111.0L884.9,119.4L880.2,124.6L874.6,129.4L867.4,129.8L861.0,133.5L857.3,138.4L858.9,146.0L858.6,152.5L851.3,154.5L850.3,148.0L847.6,142.1L841.3,139.9L835.5,137.2L830.6,141.0L832.5,146.8L839.9,146.0L835.1,149.7L835.1,157.3L838.6,164.0L838.0,171.6L832.2,178.5L825.8,184.4L818.8,187.0L810.7,190.1L805.2,193.7L800.1,190.1L794.1,195.1L798.2,203.6L803.7,212.7L801.0,219.4L795.6,223.5L789.8,220.9L785.0,216.1L778.0,212.8L776.3,219.9L778.6,227.0L783.7,232.7L787.3,238.4L789.6,245.5L781.6,242.3L779.3,236.8L776.9,231.0L772.9,225.1L774.3,218.2L772.5,212.1L771.1,205.3L764.9,206.3L762.0,199.4L756.6,192.6L753.9,186.8L747.3,188.7L741.8,192.4L736.3,195.9L731.1,200.9L724.4,205.7L722.9,211.6L721.8,221.2L716.5,227.1L711.5,221.4L708.0,214.6L704.3,205.6L702.3,196.6L697.7,192.3L692.1,188.6L687.3,183.5L679.3,179.9L670.8,180.3L662.6,178.9L656.9,174.6L648.6,175.5L643.1,172.6L639.2,166.3L633.6,168.6L636.9,173.7L640.4,179.6L646.0,182.8L651.9,181.1L656.6,176.7L657.9,182.7L664.4,186.1L662.5,193.3L657.2,198.4L652.2,202.9L645.5,204.5L637.7,209.1L631.5,212.2L625.4,214.0L619.7,210.9L618.8,204.6L614.5,198.1L610.6,193.5L608.5,187.3L604.1,182.5L600.7,176.2L596.2,172.1L590.1,167.1L592.6,173.1L595.8,178.9L598.7,185.8L603.3,191.6L604.1,198.3L608.3,203.2L614.4,209.7L619.7,214.7L622.5,221.0L629.6,220.0L636.0,218.3L642.0,216.6L640.4,224.4L637.4,231.1L632.6,238.3L626.6,244.3L619.8,249.2L616.1,254.0L611.4,259.1L607.6,266.4L609.0,272.2L611.0,278.1L612.7,285.1L612.4,292.8L607.1,297.5L600.8,301.8L596.4,306.9L598.7,314.1L595.0,318.9L591.2,324.3L587.6,331.3L583.5,336.5L578.4,341.0L572.0,343.5L565.5,343.9L557.5,345.6L551.2,344.4L550.6,337.9L545.4,329.4L541.6,322.5L540.0,316.3L538.5,310.3L535.6,304.6L532.6,298.1L533.7,291.3L537.0,284.7L536.4,277.1L535.9,271.1L533.1,264.0L528.0,258.2L524.4,253.1L526.4,247.2L526.1,239.6L519.7,237.6L514.0,234.4L507.5,232.6L498.6,235.2L492.1,236.1L483.8,236.1L477.8,237.9L472.5,234.5L467.5,230.9L463.2,225.3L459.2,220.4L453.9,216.2L452.4,210.1L454.0,203.7L454.8,197.0L452.7,190.5L455.6,184.1L458.9,178.8L463.5,173.2L469.7,169.9L472.7,163.4L476.0,157.7L482.7,152.4L489.9,151.7L496.6,150.8L504.1,148.3L513.4,147.6L520.4,146.9L526.4,146.2L530.4,150.8L530.9,157.5L538.7,159.1L543.6,162.8L550.1,164.5L555.9,160.4L563.6,159.3L569.9,162.3L576.3,163.0L582.5,163.4L588.8,164.1L595.2,163.3L598.6,155.8L599.4,149.2L590.3,149.7L582.5,149.6L575.1,145.4L575.8,137.7L586.5,135.9L593.1,133.3L602.5,135.2L609.8,135.8L615.8,133.4L611.0,129.3L604.3,126.0L608.7,119.3L602.1,120.3L597.9,125.2L590.2,124.1L584.4,122.1L579.3,128.6L580.5,135.3L573.2,138.5L565.9,137.0L565.4,143.0L562.5,148.9L558.7,143.6L553.9,138.2L551.3,132.0L544.5,129.1L539.6,124.4L539.0,131.2L544.9,134.1L551.0,137.9L546.2,142.1L540.8,137.2L533.6,134.2L528.3,128.0L521.8,128.4L512.7,129.4L505.8,135.5L500.3,138.5L498.1,145.4L490.5,148.2L483.7,149.9L476.7,147.3L473.8,140.6L475.0,134.6L477.8,128.5L485.0,129.0L494.7,129.4L496.7,122.2L491.8,117.9L494.6,111.7L503.7,110.8L509.2,107.4L513.1,102.5L519.2,101.4L523.7,97.3L526.2,91.2L527.6,97.3L533.2,99.5L539.2,100.7L545.5,98.6L551.7,98.1L559.1,96.7L559.9,90.5L567.0,91.6L564.8,85.6L571.8,84.4L580.9,83.3L572.9,82.2L563.5,83.8L559.8,78.6L562.3,72.7L568.7,69.7L561.6,67.4L554.9,73.3L547.6,79.6L549.6,86.2L545.7,91.6L539.2,96.1L532.7,90.4L528.8,84.8L523.3,88.0L515.7,87.3L513.9,77.9L523.8,73.7L529.2,70.9L534.3,67.0L541.0,61.6L553.3,56.1L559.4,54.8L568.2,52.7L578.2,52.3L586.9,54.3L593.8,57.5L601.4,58.2L611.9,61.3L606.6,66.7L594.2,64.6L597.1,71.1L603.2,71.3L610.0,70.8L616.9,65.3L623.7,64.6L628.5,60.4L639.5,61.1L649.2,58.7L659.2,59.8L666.5,60.3L676.4,56.8L690.3,60.9L686.8,55.8L690.4,50.2L701.6,47.8L702.2,54.5L704.6,60.0L698.0,65.8L705.3,64.5L708.2,58.4L703.1,51.5L708.8,47.6L715.5,49.3L726.4,50.7L728.5,44.9L735.2,45.0L741.2,44.6L750.7,39.9L758.1,39.5L766.3,38.5L774.8,37.6L783.3,35.3L789.9,34.2L797.1,36.2Z M248.5,57.0L255.5,59.4L262.3,58.9L270.5,56.5L274.3,62.2L268.5,65.5L261.8,65.1L257.4,70.1L250.2,72.1L244.6,75.5L238.2,80.8L241.1,86.7L247.5,90.9L255.4,93.1L263.9,96.4L271.5,96.8L273.9,105.1L280.2,106.9L280.2,99.6L285.8,94.9L285.3,88.7L284.0,81.2L289.7,77.0L297.5,77.5L306.7,80.4L310.1,86.7L316.1,86.8L320.6,82.4L326.4,88.4L332.0,95.1L339.0,97.4L344.0,101.0L341.3,107.2L333.2,110.4L322.6,110.3L315.6,110.5L309.7,113.7L302.5,119.9L309.3,115.8L315.1,113.5L321.7,114.6L320.9,121.6L329.1,122.5L321.5,127.0L313.5,124.6L308.2,127.8L303.3,132.4L297.6,135.5L291.9,141.8L286.2,143.8L289.6,151.2L283.2,155.8L276.9,159.7L274.1,166.6L277.6,175.3L271.6,175.7L269.6,169.2L263.6,167.7L256.9,165.9L251.6,169.0L245.5,167.6L239.3,167.5L231.7,171.4L229.6,177.2L228.4,186.3L230.0,192.7L233.6,197.7L240.1,198.8L246.1,197.6L249.2,191.7L256.5,190.4L256.7,197.1L254.6,204.1L260.8,205.9L267.3,207.2L267.9,213.5L267.6,219.6L271.7,224.4L278.0,224.1L284.1,225.1L289.8,222.8L296.1,218.8L301.7,215.6L299.8,222.6L305.1,218.4L313.1,220.7L319.7,222.0L328.1,220.2L331.5,226.2L337.5,229.6L344.6,234.0L351.1,234.3L356.5,238.5L359.7,244.7L364.9,250.7L370.6,252.6L376.6,255.9L384.8,258.1L393.1,260.3L398.7,264.2L403.1,268.7L402.4,275.0L397.1,280.7L393.3,286.2L392.0,293.5L390.9,299.6L386.7,308.1L383.4,313.8L376.0,314.9L367.6,319.1L365.3,325.5L362.3,331.2L356.7,338.3L351.7,343.8L345.3,346.5L339.4,345.7L342.4,351.1L335.5,357.6L326.8,357.9L325.7,364.0L319.1,364.1L323.7,368.2L318.5,373.6L313.1,376.5L317.7,381.2L311.6,388.5L310.7,395.4L303.2,396.9L295.3,396.8L291.7,391.8L290.0,385.2L294.1,380.4L293.5,372.5L298.0,367.7L295.3,361.0L295.6,353.2L300.4,344.2L300.9,335.9L303.0,326.8L304.4,315.6L305.3,309.4L304.5,301.0L296.0,295.4L288.9,290.7L285.8,284.0L280.5,273.3L276.3,268.2L274.7,261.2L275.2,252.9L279.0,247.3L283.5,242.5L284.6,234.5L282.1,227.6L275.3,229.9L269.9,227.0L264.9,223.3L260.9,218.3L256.5,214.1L250.5,212.4L243.8,209.6L239.2,205.7L233.2,206.2L225.1,204.0L217.6,201.0L211.3,197.9L206.3,193.2L205.5,186.7L200.2,181.8L196.4,176.5L191.2,172.4L186.6,166.6L181.2,161.7L184.5,169.3L188.2,174.5L191.7,179.7L196.1,185.1L189.8,182.0L184.8,175.6L180.7,168.7L175.8,162.1L172.4,156.6L165.6,154.3L161.9,149.6L158.5,144.1L154.4,138.0L154.1,131.2L155.8,123.5L154.5,117.4L153.0,111.2L146.0,108.8L141.3,103.5L137.4,97.8L132.6,93.4L127.6,88.5L120.5,88.3L111.5,84.6L104.0,83.1L94.7,82.1L88.3,81.5L81.6,85.1L72.2,85.1L65.8,90.5L59.9,94.5L52.2,96.2L42.3,98.9L50.5,94.7L59.2,91.6L63.8,86.3L56.4,86.3L50.1,87.0L44.9,83.9L38.6,79.2L42.9,74.6L49.3,73.5L41.8,71.0L33.0,67.6L43.1,65.1L50.9,66.3L45.2,63.6L36.8,60.1L43.2,58.6L50.3,54.6L58.2,53.1L65.1,51.8L71.3,53.6L81.3,54.4L90.0,55.0L97.4,55.6L105.4,56.0L113.6,57.0L120.8,58.6L126.6,56.6L134.9,55.7L141.4,56.2L150.7,57.0L158.2,56.8L166.8,57.3L173.3,58.3L179.9,58.6L192.2,61.6L200.6,61.4L207.4,59.6L213.3,60.8L222.5,61.7L228.7,59.5L234.8,60.9L232.0,55.3L235.5,50.2L242.0,51.9L248.5,57.0Z M898.8,288.2L903.8,291.6L906.0,299.3L909.6,304.1L914.7,309.1L919.2,315.2L924.6,320.2L926.6,328.1L925.2,334.3L923.5,340.4L919.5,345.3L916.9,351.2L912.0,355.0L906.4,358.4L898.9,357.8L890.7,355.6L887.7,350.4L883.9,345.5L877.7,346.9L873.9,342.3L867.5,338.8L859.8,337.8L853.1,339.7L845.1,341.6L839.4,344.5L833.0,344.4L827.8,347.4L821.0,345.5L821.7,339.5L819.4,333.4L816.8,325.9L815.9,319.4L815.9,312.4L822.1,308.5L828.4,306.6L835.7,304.7L839.7,299.4L843.9,294.8L849.1,290.3L856.6,291.3L862.1,287.1L868.3,283.7L875.8,284.0L876.2,290.9L882.2,295.0L889.5,299.2L892.8,294.0L893.5,286.0L895.9,279.6L898.7,285.7Z M424.7,18.0L442.1,20.2L426.3,21.4L411.4,21.7L422.6,21.9L431.0,22.8L438.7,23.0L456.2,22.5L464.5,23.0L454.8,26.2L444.3,27.3L450.7,27.4L445.3,31.2L439.8,37.1L445.6,41.0L440.0,43.8L434.5,46.4L438.5,51.5L432.5,53.2L422.9,59.8L414.8,60.8L408.9,61.8L399.0,66.7L389.4,68.2L385.6,73.7L380.9,80.3L375.6,83.2L365.9,80.9L361.4,76.7L355.2,71.4L350.9,66.4L352.8,60.1L358.7,55.8L351.5,57.5L357.2,54.0L350.0,51.3L344.1,45.4L337.2,41.4L329.8,38.6L316.5,38.5L309.7,38.7L301.7,36.1L309.0,35.2L302.7,34.3L296.4,33.2L307.3,30.8L317.5,29.5L311.0,27.5L323.1,24.4L332.5,22.1L341.1,21.7L349.6,21.7L360.0,21.0L366.7,22.0L376.3,23.2L369.7,21.7L379.4,18.8L389.2,18.9L402.5,17.7L424.7,18.0Z M259.5,46.8L271.3,45.1L275.7,49.8L283.8,47.9L290.0,49.3L299.3,51.2L308.9,54.1L314.0,57.8L319.8,61.5L328.2,64.3L322.4,69.4L314.7,65.6L318.6,71.2L308.9,72.9L315.8,77.0L308.7,76.9L302.7,75.2L296.2,71.7L284.1,71.6L294.6,68.2L298.2,63.1L292.1,59.6L285.3,56.2L279.2,55.9L264.0,55.6L253.7,54.4L249.4,49.3L254.4,45.7L261.6,45.0Z M309.7,19.1L317.1,19.4L328.2,20.5L321.3,22.4L314.6,23.0L307.0,26.1L296.5,28.8L286.4,29.7L282.3,34.7L276.2,38.4L269.0,37.6L260.8,38.1L251.4,37.6L256.5,33.4L264.0,34.6L255.7,32.3L262.8,30.6L268.3,27.5L256.7,26.3L249.4,24.3L258.4,21.4L265.9,20.6L274.7,19.4L288.2,19.0L297.7,18.8L303.7,19.0L309.7,19.1Z M872.6,253.2L876.3,259.4L881.8,254.7L888.7,256.7L896.5,259.1L903.5,262.1L910.1,266.9L913.2,275.3L918.9,278.6L910.9,278.1L905.7,272.4L898.0,272.9L891.8,275.3L886.5,272.5L883.1,265.0L875.5,262.4L869.4,261.4L866.2,254.5L872.2,252.2Z M827.4,244.9L826.4,252.2L822.6,261.1L816.0,259.6L808.5,258.5L804.4,253.7L803.0,246.3L808.8,244.9L813.9,241.4L818.3,236.4L824.2,230.8L831.1,235.0L825.9,241.0Z M639.0,287.7L639.9,293.6L637.3,299.9L634.9,306.9L632.1,316.1L626.1,321.1L621.4,315.5L620.6,309.3L623.5,304.0L623.1,296.8L628.6,293.8L633.3,289.1L636.7,283.4Z M182.9,46.9L191.5,48.7L199.5,51.0L204.1,47.0L209.0,50.8L214.5,54.2L205.7,57.8L197.2,58.9L189.0,59.4L179.9,57.6L174.1,55.7L180.2,54.9L187.7,54.5L176.4,54.1L168.3,51.2L180.0,46.3Z M793.9,266.3L785.0,261.7L780.3,255.7L775.7,249.5L771.4,243.2L764.9,236.2L773.2,238.1L779.6,244.2L786.3,248.4L790.4,255.0L794.0,262.0Z M891.6,146.8L886.0,153.7L877.2,157.0L870.4,154.5L863.9,155.9L864.8,162.6L859.5,157.5L866.3,153.5L873.9,150.7L879.8,146.4L885.7,144.9L888.6,137.3L894.1,141.2L891.6,146.8Z M491.7,87.1L491.3,94.5L496.9,98.3L501.3,103.0L501.5,109.0L493.1,109.7L485.4,111.2L490.5,107.1L487.3,101.4L486.0,95.0L483.9,89.4L491.7,87.1Z M659.8,53.6L649.1,53.4L643.3,51.5L651.2,45.5L660.7,40.0L669.9,38.2L679.2,37.7L689.3,36.3L679.5,39.6L671.1,40.9L662.4,43.6L653.9,49.0L659.8,53.6Z M165.4,51.7L158.1,53.1L150.2,50.4L155.7,45.3L162.4,43.2L173.5,43.9L179.1,45.9L168.8,48.6Z M13.8,65.0L22.6,64.1L28.1,66.7L20.7,68.2L14.9,70.5L7.7,68.0L0.3,67.0L0.0,58.4L6.8,60.6L14.1,63.3Z M459.7,65.4L450.6,73.1L444.5,73.2L436.8,72.3L432.4,67.7L438.5,65.5L447.1,65.9L455.1,65.2Z M237.0,35.8L245.5,36.7L252.3,40.0L260.1,40.3L270.1,39.5L277.6,40.7L268.8,42.9L260.8,43.3L250.7,43.0L243.3,42.1L233.4,37.7Z M550.7,28.6L559.8,30.7L552.9,31.8L547.6,36.6L538.2,35.1L531.2,30.9L536.6,27.7L543.1,27.7L550.7,28.6Z M344.1,109.2L351.5,113.2L352.6,120.4L346.1,119.8L335.4,117.8L340.7,109.1Z M258.3,28.7L252.7,32.5L242.0,32.4L236.2,29.5L243.3,24.3L251.5,26.4L258.3,28.7Z M847.9,246.1L840.9,248.8L833.8,249.3L842.6,251.7L837.5,255.3L842.1,263.0L835.8,260.0L832.8,265.8L831.9,259.7L832.8,249.6L841.5,247.6L847.4,245.4Z";

function WorldMap() {
  return (
    <svg viewBox="0 0 1000 500" preserveAspectRatio="xMidYMid meet" aria-hidden="true"
      className="pt-anim-worldDrift pointer-events-none absolute inset-0 h-full w-full" style={{ opacity: 0.16 }}>
      <defs>
        <linearGradient id="wmGrad" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={C.amberSoft} />
          <stop offset="100%" stopColor={C.amber} stopOpacity="0.35" />
        </linearGradient>
      </defs>
      {/* real continent silhouettes (see WORLD_LAND_PATH) — decorative, not navigational data */}
      <path d={WORLD_LAND_PATH} fill="url(#wmGrad)" />
    </svg>
  );
}

function MenuShell({ children }) {
  return (
    <div className="relative flex h-screen w-full flex-col items-center justify-center overflow-hidden p-6" style={{ color: C.text,
      background: `radial-gradient(60% 46% at 50% 20%, #1C2E46 0%, ${C.ink} 62%), radial-gradient(90% 60% at 50% 100%, #0E1A2A 0%, ${C.ink} 55%), ${C.ink}` }}>
      <style>{`.pt9{font-size:9px}.pt10{font-size:10px}.pt11{font-size:11px}.trk{letter-spacing:.22em}`}</style>
      <WorldMap />
      <div aria-hidden className="pt-anim-glowPulse pointer-events-none absolute rounded-full"
        style={{ width: 440, height: 440, top: "10%", background: `radial-gradient(circle, ${C.glow} 0%, transparent 72%)`, filter: "blur(18px)" }} />
      <div className="pt-anim-slideUp relative text-center">
        <Eyebrow>One shared Earth · ~300 m tiles</Eyebrow>
        <h1 className="mb-1 mt-2 text-5xl font-bold" style={{ ...display, letterSpacing: ".01em",
          backgroundImage: C.amberGrad, WebkitBackgroundClip: "text", backgroundClip: "text", color: "transparent",
          filter: `drop-shadow(0 4px 28px ${C.glow})` }}>PLOT TWIST</h1>
        <div className="pt11 trk mb-8 uppercase font-semibold" style={{ ...display, color: C.dim }}>World Deed Edition</div>
        {children}
      </div>
    </div>
  );
}

function HowToModal({ onClose }) {
  return (
    <Modal onClose={onClose}>
      <Eyebrow>How to play</Eyebrow>
      <div className="mt-3 flex flex-col gap-2.5 text-sm leading-relaxed" style={{ color: C.text }}>
        <div>Zoom into anywhere on Earth until the deed grid appears, then tap a ~300 m tile and buy it. Everyone plays on the same planet — one tile, one owner.</div>
        <div>Tiles pay rent per second. Rarity is rolled when you buy (up to 8×). Build them up from cottage to tower for more rent.</div>
        <div>Trade with real players: list your tiles at any price on the open market, or buy theirs. Sales pay you even while you're offline.</div>
        <div>Districts come from real OpenStreetMap data — actual water, land-use and building footprints, not a guess. A freshly-revealed tile briefly shows as "Surveying…" (not yet purchasable) until its real data finishes loading, which is usually well under a second.</div>
      </div>
      <div className="mt-4"><Btn full onClick={onClose}>Got it</Btn></div>
    </Modal>
  );
}

export default function PlotTwistWorld() {
  // checking | unconfigured | signedOut | needsUsername | ready
  const [authState, setAuthState] = useState(MULTIPLAYER ? "checking" : "unconfigured");
  const [session, setSession] = useState(null);
  const [howto, setHowto] = useState(false);
  const [nameDraft, setNameDraft] = useState("");
  const [nameErr, setNameErr] = useState("");
  const [nameBusy, setNameBusy] = useState(false);
  const [inGame, setInGame] = useState(true);
  // Set true only by claimName() below — that's the one moment we know for
  // certain this is a brand-new account (a profile row didn't exist yet),
  // as opposed to loadProfile() restoring an existing session. Seeds Game's
  // internal pickingHome state on mount; Game owns the rest of that flow.
  const [freshAccount, setFreshAccount] = useState(false);
  const G = useRef(null);

  useEffect(() => {
    if (!MULTIPLAYER) return;
    let cancelled = false;
    // Guards against calling loadProfile twice concurrently — belt-and-
    // suspenders on top of removing the redundant getSession() call below,
    // which is what actually caused the race (see comment further down).
    const loading = { current: false };
    const loadProfile = async (sess) => {
      if (loading.current) return;
      loading.current = true;
      const { data, error } = await supabase.from("profiles").select("*").eq("user_id", sess.user.id).maybeSingle();
      loading.current = false;
      if (cancelled) return;
      if (error) {
        // transient failure (network blip, cold connection, etc.) — do NOT
        // send an existing player through the username-claim screen, which
        // would look like account loss. Just retry shortly.
        setTimeout(() => loadProfile(sess), 2000);
        return;
      }
      if (data) {
        G.current = gameFromProfile(sess.user.id, data);
        setInGame(true);
        setAuthState("ready");
      } else {
        setAuthState("needsUsername");
      }
    };
    // Deliberately NOT also calling getSession() here — onAuthStateChange
    // fires an INITIAL_SESSION event immediately upon subscribing, which is
    // the same information. Calling both raced two independent loadProfile
    // calls against each other; whichever resolved last silently overwrote
    // G.current with a fresh, empty game-state object, discarding a real
    // player's already-loaded tiles/rent on the very next render (map
    // rendering and the leaderboard stayed correct because those read
    // straight from the server on every use, not from this cached object).
    const unsub = onAuthStateChange((event, sess) => {
      if (cancelled) return;
      setSession(sess);
      if (!sess) { G.current = null; setAuthState("signedOut"); return; }
      // TOKEN_REFRESHED fires routinely in the background (Supabase renews
      // the access token roughly hourly) — it is NOT a new sign-in. Treating
      // it as one re-fetched only the profile (not tiles) into a brand new
      // G.current, discarding the real one's owned tiles/rent on the next
      // render. Only (re)load the profile for an actual new session, and
      // only if we don't already have one loaded for this exact account.
      if (event === "TOKEN_REFRESHED" || event === "USER_UPDATED") return;
      if (G.current && G.current.uid === sess.user.id) return;
      loadProfile(sess);
    });
    return () => { cancelled = true; unsub(); };
  }, []);

  const claimName = async () => {
    if (!session) return;
    setNameErr(""); setNameBusy(true);
    try {
      const { data, error } = await supabase.rpc("claim_username", { p_username: nameDraft.trim() });
      if (error) throw error;
      G.current = gameFromProfile(session.user.id, data);
      setFreshAccount(true);
      setInGame(true);
      setAuthState("ready");
    } catch (e) {
      setNameErr(e.message || "Could not claim that username");
    } finally {
      setNameBusy(false);
    }
  };

  if (authState === "unconfigured") {
    return (
      <MenuShell>
        <div className="pt11 mx-auto max-w-xs leading-relaxed" style={{ ...mono, color: C.dim }}>
          This deployment isn't configured for accounts yet — missing Supabase credentials.
        </div>
      </MenuShell>
    );
  }

  if (authState === "checking") {
    return <MenuShell><div className="pt11" style={{ ...mono, color: C.dim }}>Checking your account…</div></MenuShell>;
  }

  if (authState === "signedOut") {
    return (
      <MenuShell>
        <div className="mx-auto flex w-64 flex-col gap-2.5">
          <Btn full onClick={() => signInWithGoogle()}>Sign in with Google</Btn>
          <Btn full tone="ghost" onClick={() => setHowto(true)}>How to play</Btn>
        </div>
        <div className="pt9 mx-auto mt-10 max-w-xs leading-relaxed" style={{ ...mono, color: C.dim }}>
          One account per player, tied to your Google sign-in — no separate "new game," ever. Parody idle game. ₲ Geobux are virtual and worth nothing.
        </div>
        {howto && <HowToModal onClose={() => setHowto(false)} />}
      </MenuShell>
    );
  }

  if (authState === "needsUsername") {
    return (
      <MenuShell>
        <div className="mx-auto w-64 text-left">
          <div className="pt11 mb-3 text-center" style={{ ...mono, color: C.dim }}>
            Pick a name to claim tiles and trade. This is permanent for this account.
          </div>
          <input value={nameDraft} onChange={(e) => setNameDraft(e.target.value)} maxLength={16} placeholder="e.g. DirtBaron"
            className="mb-2 w-full rounded-xl px-3 py-2.5 text-sm focus-visible:outline focus-visible:outline-2"
            style={{ ...display, ...inputSty }} />
          {nameErr && <div className="pt10 mb-2" style={{ ...mono, color: "#F08A8A" }}>{nameErr}</div>}
          <Btn full onClick={claimName} disabled={!nameDraft.trim() || nameBusy}>{nameBusy ? "Claiming…" : "Claim name"}</Btn>
        </div>
      </MenuShell>
    );
  }

  // authState === "ready"
  if (!inGame) {
    return (
      <MenuShell>
        <div className="mx-auto flex w-64 flex-col gap-2.5">
          <Btn full onClick={() => setInGame(true)}>Continue</Btn>
          <Btn full tone="ghost" onClick={() => setHowto(true)}>How to play</Btn>
          <Btn full tone="ghost" onClick={() => signOut()}>Sign out</Btn>
        </div>
        {howto && <HowToModal onClose={() => setHowto(false)} />}
      </MenuShell>
    );
  }

  return <Game key={session.user.id} G={G} onExit={() => setInGame(false)} startFresh={freshAccount} />;
}

function Modal({ children, onClose }) {
  return (
    <div className="absolute inset-0 z-20 flex items-center justify-center p-6 pt-anim-fadeIn" style={{ background: "rgba(4,9,16,0.72)", ...blur(6) }} onClick={onClose}>
      <div className="w-full max-w-sm rounded-2xl p-5 pt-anim-popIn" onClick={(e) => e.stopPropagation()}
        style={{ background: `${C.panel}f5`, backgroundImage: C.panelGrad, border: `1px solid ${C.hairLit}`, boxShadow: C.shadowLg }}>
        {children}
      </div>
    </div>
  );
}

/* ═════════════════════════════════════════════════════════════
   GAME
   ═════════════════════════════════════════════════════════════ */

function Game({ G, onExit, startFresh }) {
  const [, force] = useReducer((x) => x + 1, 0);
  // Brand-new accounts (startFresh, seeded once from the mount-time prop —
  // see claimName in PlotTwistWorld) start on a basemap-only "pick your
  // starting area" screen instead of the normal HUD: no fine grid, no
  // preview mosaic, no vector-tile fetches at all until they confirm a
  // spot. Doesn't affect returning players — startFresh is only ever true
  // right after claim_username creates a brand-new profile row.
  const [pickingHome, setPickingHome] = useState(!!startFresh);
  const [homeBusy, setHomeBusy] = useState(false);
  const [homeErr, setHomeErr] = useState("");
  const [ready, setReady] = useState(false);
  const [tab, setTab] = useState("map");
  const [sel, setSel] = useState(null);          // quadkey or null
  const [roll, setRoll] = useState(null);        // {qk, phase, r}
  const [modal, setModal] = useState(null);
  const [toasts, setToasts] = useState([]);
  const [syncing, setSyncing] = useState(false);
  const [cities, setCities] = useState(false);
  const [citySearch, setCitySearch] = useState("");
  const [showBasemap, setShowBasemap] = useState(true);
  const [dbg, setDbg] = useState(() => typeof location !== "undefined" && location.hash.includes("debug"));
  const [market, setMarket] = useState({ loading: false, rows: null });
  const [flips, setFlips] = useState({ loading: false, rows: null });
  const [lb, setLb] = useState({ loading: false, rows: null });
  const [log, setLog] = useState({ loading: false, rows: null });
  const [assetQuery, setAssetQuery] = useState("");
  const [assetClsFilter, setAssetClsFilter] = useState("all");
  const [assetRarityFilter, setAssetRarityFilter] = useState(-1);
  const [assetSort, setAssetSort] = useState("rent");
  const [batchBusy, setBatchBusy] = useState(null);
  const [nameDraft, setNameDraft] = useState(G.current.name || "");
  const [priceDraft, setPriceDraft] = useState("");
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [deleteBusy, setDeleteBusy] = useState(false);
  const pendings = useRef([]);
  const dirty = useRef(false);
  const regions = useRef(new Map()); // prefix -> {t:{qk:rec}, at}
  const busyRegions = useRef(new Set());
  const dbgRef = useRef({ fps: 0, avg: 0, max: 0, s: 0, tilePx: 0, cnt: 0, gridOn: false, long: 0, longMax: 0, errs: [], lastEvt: "-" });
  const logEvt = (n) => { dbgRef.current.lastEvt = n; };

  const reduced = typeof window !== "undefined" && window.matchMedia &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  const toast = useCallback((text) => {
    const id = Math.random();
    setToasts((t) => [...t.slice(-2), { id, text }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), 2800);
  }, []);

  /* ── derived ── */
  const g = G.current;
  const ownMap = useRef(new Map());
  // regions this player has paid (or bootstrapped) to unlock — gates the
  // fine deed grid's interactivity/classification, NOT the basemap or
  // preview grid, both of which stay fully visible everywhere regardless
  const unlockedRegions = useRef(new Set());
  const homeRegionRef = useRef(null);
  const rebuildOwn = useCallback(() => {
    ownMap.current = new Map(g.own.map((t) => [t.qk, t]));
    g.rps = g.own.reduce((s, t) => s + rentOf(t), 0);
  }, [g]);

  const netWorth = () => g.bal + g.own.reduce((s, t) => s + (t.pd || 0), 0);

  const checkAch = useCallback(() => {
    const unlock = (k, name) => { if (!g.ach[k]) { g.ach[k] = 1; toast(`Unlocked — ${name}`); dirty.current = true; } };
    const n = g.own.length;
    if (n >= 1) unlock("deed1", "First deed");
    if (n >= 10) unlock("deed10", "Landlord");
    if (new Set(g.own.map((t) => regionOf(t.qk))).size >= 3) unlock("globe", "Globetrotter");
    if (g.own.some((t) => t.r === 3)) unlock("lux", "Legendary find");
    if (g.own.some((t) => t.l >= 4)) unlock("tower", "Skyline");
    if (g.bal >= 50000) unlock("rich", "Deep pockets");
    if ((g.streak || 0) >= 3) unlock("streak3", "Regular");
  }, [g, toast]);

  // The real balance/tiles live in Postgres; this just clears the dirty
  // flag so existing "dirty.current = true; save();" call sites keep
  // working unchanged — every actual mutation already went through a
  // server-validated RPC by the time save() is called.
  const save = useCallback(() => { dirty.current = false; }, []);

  /* ── bank: surface "sold while away" notifications. The money itself was
     already credited straight to profiles.balance at sale time (see
     buy_listed_tile in supabase.sql) — this just reports + acknowledges it,
     and sync_rent()'s balance read (below) is what the client actually
     trusts for display. ── */
  const collectBank = useCallback(async () => {
    const { data, error } = await supabase.rpc("claim_bank_ledger");
    if (error || !data || !data.length) return;
    const { sale_total, sale_count, repo_total, repo_count } = data[0];
    if (sale_count) {
      if (!g.ach.trader) { g.ach.trader = 1; toast("Unlocked — Trader"); }
      toast(`+₲${fmt(sale_total)} from ${sale_count} tile sale${sale_count === 1 ? "" : "s"}`);
    }
    if (repo_count) {
      // a tile going stale isn't "trading" — kept separate from the sale
      // toast/achievement above on purpose
      toast(`+₲${fmt(repo_total)} refunded — ${repo_count} tile${repo_count === 1 ? "" : "s"} repossessed for inactivity (60+ days)`);
    }
  }, [g, toast]);

  // Reconciles the optimistic local tick against the real server balance —
  // a client can display whatever it wants, but every RPC that spends money
  // checks the real profiles.balance, never this value.
  const syncRent = useCallback(async () => {
    const { data, error } = await supabase.rpc("sync_rent");
    if (error || !data) return;
    g.bal = Number(data.balance);
    g.boostUntil = data.boost_until ? new Date(data.boost_until).getTime() : 0;
    g.boostReadyAt = data.boost_ready_at ? new Date(data.boost_ready_at).getTime() : 0;
    if (data.energy != null) g.energy = data.energy;
    if (data.peak_net_worth != null) g.peakNetWorth = data.peak_net_worth;
    if (data.attacks_sent_count != null) g.attacksSent = data.attacks_sent_count;
    if (data.dev_mode != null) g.devMode = data.dev_mode;
    return data;
  }, [g]);

  // Re-pulls the real owned-tile list straight from the server, independent
  // of viewport/tab (unlike ensureRegion's per-prefix reconcile, which only
  // touches whatever region the map camera happens to be looking at). Used
  // to catch up a tab/device that's been sitting backgrounded while another
  // device bought/sold/upgraded tiles on the same account — see the
  // regainFocus effect below. Deliberately no retry loop (unlike the boot
  // fetch this mirrors): a failure here just means the next resync trigger
  // tries again, not a real player watching an empty portfolio.
  const refreshOwnedTiles = useCallback(async () => {
    const { data, error } = await supabase
      .from("tiles").select("qk,cls,level,rarity,paid,list_price,prestige,build_until").eq("owner", g.uid);
    if (error || !data) return;
    g.own = data.map((t) => ({
      qk: t.qk, cls: t.cls, l: t.level, r: t.rarity, pd: t.paid, pr: t.prestige || 0,
      ...(t.list_price != null ? { p: t.list_price } : {}),
      ...(t.build_until != null ? { bu: t.build_until } : {}),
    }));
    rebuildOwn();
    dirty.current = true;
  }, [g, rebuildOwn]);

  /* ── PvP: surface "N of your attacks resolved" / "your territory was
     raided N times" — same lazy claim-and-mark-seen pattern as collectBank
     above, backed by battle_log/claim_battle_log() instead of
     bank_ledger/claim_bank_ledger(). Money/ownership already moved
     instantly inside attack_tile() — this only reports + acknowledges. ── */
  const collectBattles = useCallback(async () => {
    const { data, error } = await supabase.rpc("claim_battle_log");
    if (error || !data || !data.length) return;
    const { sent_win_count, sent_loss_count, sent_cost_total, received_count, received_lost_count } = data[0];
    if (sent_win_count || sent_loss_count) {
      toast(`Attack results: ${sent_win_count} won, ${sent_loss_count} lost (₲${fmt(sent_cost_total)} spent)`);
    }
    if (received_count) {
      // a lost tile changes g.own out from under us with no local action —
      // pull the real portfolio immediately rather than waiting for the
      // next focus/visibility resync. Also flags the HQ nav badge so a loss
      // that happened fully offline stays visible past the toast, until
      // the player actually opens HQ (see the refreshLog effect above).
      if (received_lost_count) { refreshOwnedTiles(); g.hasUnseenLoss = true; }
      toast(received_lost_count
        ? `Your territory was raided — ${received_lost_count} of ${received_count} attack${received_count === 1 ? "" : "s"} took a tile`
        : `Your territory was raided ${received_count} time${received_count === 1 ? "" : "s"} — you held every tile`);
    }
  }, [g, toast, refreshOwnedTiles]);

  /* ── boot: pull real state from Supabase (profile was already fetched to
     get here; this fills in tiles + reconciles rent/streak) ── */
  useEffect(() => {
    (async () => {
      const before = g.bal;
      const fresh = await syncRent();
      if (fresh) {
        const gain = Math.round(Number(fresh.balance) - before);
        if (gain > 0) pendings.current.push({ kind: "welcome", gain });
      }

      const { data: dailyRows, error: dailyErr } = await supabase.rpc("claim_daily");
      const daily = !dailyErr && dailyRows && dailyRows[0];
      if (daily) {
        g.streak = daily.streak;
        if (!daily.already_claimed) {
          g.bal += Number(daily.reward);
          pendings.current.push({ kind: "daily", streak: daily.streak, reward: Number(daily.reward) });
        }
      }

      // Fetch owned tiles with a couple of retries — this must NEVER fall
      // through to an empty g.own on a transient failure, or a real owner
      // would see their tiles (and rent) vanish from the UI even though the
      // `tiles` table itself never changed. An actual zero-tiles account
      // just returns an empty array here with no error, which is fine.
      let tileRows = null, tilesErr = null;
      for (let attempt = 0; attempt < 3 && !tileRows; attempt++) {
        const res = await supabase
          .from("tiles").select("qk,cls,level,rarity,paid,list_price,prestige,build_until").eq("owner", g.uid);
        if (!res.error) { tileRows = res.data || []; break; }
        tilesErr = res.error;
        await new Promise((r) => setTimeout(r, 500 * (attempt + 1)));
      }
      if (tileRows) {
        g.own = tileRows.map((t) => ({
          qk: t.qk, cls: t.cls, l: t.level, r: t.rarity, pd: t.paid, pr: t.prestige || 0,
          ...(t.list_price != null ? { p: t.list_price } : {}),
          ...(t.build_until != null ? { bu: t.build_until } : {}),
        }));
      } else {
        toast("Couldn't load your tiles — check your connection and reopen the app.");
        console.error("tiles fetch failed after retries", tilesErr);
      }
      rebuildOwn();

      // territory: which regions this player can buy/interact with on the
      // fine deed grid. A fetch failure here just leaves the set empty —
      // worst case the fine grid reads as all-locked until the next sync,
      // never a false "unlocked" that could bypass the server-side check.
      const { data: regionRows } = await supabase
        .from("unlocked_regions").select("region,is_home").eq("owner", g.uid);
      for (const r of regionRows || []) {
        unlockedRegions.current.add(r.region);
        if (r.is_home) homeRegionRef.current = r.region;
      }

      // silently pre-populate already-earned achievement flags so they
      // don't re-toast every login — checkAch()'s unlock() only toasts
      // achievements that become newly true *during* this session
      const n = g.own.length;
      if (n >= 1) g.ach.deed1 = 1;
      if (n >= 10) g.ach.deed10 = 1;
      if (new Set(g.own.map((t) => regionOf(t.qk))).size >= 3) g.ach.globe = 1;
      if (g.own.some((t) => t.r === 3)) g.ach.lux = 1;
      if (g.own.some((t) => t.l >= 4)) g.ach.tower = 1;
      if (g.bal >= 50000) g.ach.rich = 1;
      if ((g.streak || 0) >= 3) g.ach.streak3 = 1;

      setReady(true);
      if (pendings.current.length) setModal(pendings.current.shift());
      collectBank();
      collectBattles();
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /* ── economy tick: live optimistic display locally, reconciled against
     the real server balance roughly every 20s ── */
  useEffect(() => {
    if (!ready) return;
    let n = 0;
    const iv = setInterval(() => {
      const mult = Date.now() < g.boostUntil ? 2 : 1;
      if (g.rps > 0) { g.bal += (g.rps * mult) / 4; dirty.current = true; }
      // optimistic local completion the moment a build's countdown hits
      // zero, rather than waiting for the next server round-trip to
      // confirm it (finish_builds will do the same thing lazily server-
      // side anyway — this is purely so the UI doesn't sit on a stale
      // "5s left" after time's actually up)
      for (const t of g.own) {
        if (t.bu && buildSecsLeft(t) <= 0) {
          t.l += 1;
          delete t.bu;
          dirty.current = true;
          toast(`🔨 ${LVL[t.l]} finished building`);
        }
      }
      n++;
      if (n % 8 === 0) checkAch();
      if (n % 80 === 0) { syncRent(); collectBank(); collectBattles(); }
      force();
    }, 250);
    return () => clearInterval(iv);
  }, [ready, g, checkAch, syncRent, collectBank, collectBattles, toast]);

  /* Classification is fully vector-driven (see classifyFromVector above);
     there's no procedural mask/coastline-image fallback. */

  const TILE_SUBS = ["a", "b", "c", "d"];
  const tileCache = useRef(new Map()); // "z/x/y" -> tile entry
  const tileOrder = useRef([]);
  const tileStats = useRef({ ok: 0, fail: 0 });

  // cap simultaneous fetches so fast panning/zooming can't spawn a request
  // storm that stalls the browser — queued requests just wait their turn
  const MAX_INFLIGHT = 6;
  const inflight = useRef(0);
  const fetchQueue = useRef([]);
  const runQueue = () => {
    while (inflight.current < MAX_INFLIGHT && fetchQueue.current.length) {
      const job = fetchQueue.current.shift();
      startTileFetch(job.e, job.url);
    }
  };
  const startTileFetch = (e, url) => {
    inflight.current++;
    const img = new Image();
    // No crossOrigin here — CARTO's CDN sends no CORS header, and setting
    // it on a direct (non-proxied) request makes the image fail to load
    // at all, silently.
    const settle = () => { inflight.current--; runQueue(); };
    img.onload = () => { e.loaded = true; tileStats.current.ok++; settle(); };
    img.onerror = () => { e.failed = true; tileStats.current.fail++; settle(); };
    img.src = url;
    e.img = img;
  };

  const getTile = useCallback((z, tx, ty) => {
    const key = `${z}/${tx}/${ty}`;
    let e = tileCache.current.get(key);
    if (e) return e;
    e = { img: null, loaded: false, failed: false };
    tileCache.current.set(key, e);
    tileOrder.current.push(key);
    if (tileOrder.current.length > 400) {
      const old = tileOrder.current.shift();
      tileCache.current.delete(old);
    }
    const sub = TILE_SUBS[(tx + ty) % TILE_SUBS.length];
    // Fetched directly from CARTO — no proxy. Classification is fully
    // vector-driven (see classifyFromVector), so nothing ever needs to read
    // this image's pixels back; a proxy hop here would only add latency.
    const url = `https://${sub}.basemaps.cartocdn.com/dark_all/${z}/${tx}/${ty}.png`;
    if (inflight.current < MAX_INFLIGHT) startTileFetch(e, url);
    else {
      if (fetchQueue.current.length > 60) fetchQueue.current.shift(); // drop stalest queued request
      fetchQueue.current.push({ e, url });
    }
    return e;
  }, []);

  /* nearest-city label (flavor text only — "near X, 4 km") */
  const nearestCity = useCallback((lat, lon) => {
    const { city, dkm } = urbanAt(lat, lon);
    return city && dkm < 60 ? { n: city.name, d: Math.round(dkm) } : { n: null, d: Math.round(dkm) };
  }, []);

  /* Shared tier decision: given "is this land near water" (from real water
     polygon proximity — see classifyFromVector) plus a 0..1 built-up density
     (from real landuse or measured building coverage), pick a district. */
  const tierFor = (coastal, density) => {
    if (coastal) return density >= 0.4 ? "waterfront" : "coast";
    if (density >= 0.62) return "downtown";
    if (density >= 0.4) return "urban";
    if (density >= 0.18) return "suburbs";
    return "rural";
  };

  /* Real classifier: fetches the Protomaps vector tile covering (wx,wy) at
     a FIXED reference zoom (VECTOR_Z, ~2.4km tiles) — deliberately NOT tied
     to whatever zoom the camera/display happens to be at, so a given spot
     always classifies the same way regardless of how zoomed in you are.
     This directly replaces the old raster color-guessing: water comes from
     the tile's actual `water` polygons, district tier from actual `landuse`
     polygon kinds (residential/commercial/industrial/park/...), refined by
     real building-footprint coverage where no explicit landuse is tagged.
     Returns null (falls back to the procedural mask+ring reading) until the
     covering tile has loaded and decoded, or if no API key is configured. */
  const vtCache = useRef(new Map()); // "z/x/y" -> { water, landuse, buildings, loading, failed, failedAt }
  const vtOrder = useRef([]);
  const vtPending = useRef(new Set()); // keys currently awaited from the worker (dedup)
  const VT_RETRY_MS = 20000; // don't hammer a persistently-failing tile, but don't give up on it forever either

  /* Fetch, protobuf decoding, and IndexedDB access all live in a dedicated
     Web Worker (vectorWorker.js) — the same architectural pattern Mapbox GL
     JS / MapLibre use for exactly this problem: their own docs describe
     parsing vector tiles in workers specifically so tile processing can
     never block the UI thread. The main thread's job shrinks to almost
     nothing — dedupe requests, send them, and fold results back into the
     local cache when they arrive. Classification (point-in-polygon against
     the decoded arrays) stays HERE on the main thread, deliberately — it's
     already sub-millisecond per query once a tile is decoded, so moving it
     off-thread would just add message-passing overhead for no real gain. */
  const vtWorkerRef = useRef(null);
  const vtWorkerReady = useRef(false); // true once the worker confirms it actually started
  const vtWorkerError = useRef(null);  // captured startup/runtime error, if any — "worker: on" alone only means the Worker object was constructed, NOT that its script successfully loaded
  if (!vtWorkerRef.current && typeof Worker !== "undefined") {
    try {
      vtWorkerRef.current = new VectorWorker();
    } catch (err) {
      vtWorkerRef.current = null; // e.g. no module-worker support — classification just stays "pending" forever, same as no API key
      vtWorkerError.current = String(err && err.message || err);
    }
  }
  useEffect(() => {
    const worker = vtWorkerRef.current;
    if (!worker) return;
    const onMsg = (ev) => {
      const d = ev.data;
      if (d && d.type === "ready") { vtWorkerReady.current = true; return; }
      const { key, ok, water, landuse, buildings } = d;
      vtPending.current.delete(key);
      const e = vtCache.current.get(key);
      if (!e) return; // evicted from the local cache already — fine, it'll be re-requested if still needed
      if (ok) { e.water = water; e.landuse = landuse; e.buildings = buildings; e.loading = false; }
      else { e.failed = true; e.failedAt = Date.now(); e.loading = false; }
    };
    const onErr = (ev) => {
      // this is exactly what "worker: on" can't tell you — the Worker object
      // constructs fine even if its script 404s or throws, since that
      // failure is async. This is the only way that failure becomes visible.
      vtWorkerError.current = `${ev.message || "worker error"} (${ev.filename || "?"}:${ev.lineno || "?"})`;
    };
    worker.addEventListener("message", onMsg);
    worker.addEventListener("error", onErr);
    worker.addEventListener("messageerror", onErr);
    return () => {
      worker.removeEventListener("message", onMsg);
      worker.removeEventListener("error", onErr);
      worker.removeEventListener("messageerror", onErr);
    };
  }, []);

  // Tuned by real connection quality, not a fixed guess — the same aggressive
  // concurrency/prefetch-margin that made a wifi connection feel instant was
  // actively hurting mobile: firing many parallel requests down a narrow,
  // high-latency pipe makes EACH of them slower (a well-known effect on
  // constrained links), so "faster" needs to mean "sized to the connection,"
  // not "always maximum." Stored in a ref so it updates live without any
  // stale-closure risk if the connection changes mid-session. margin/cap
  // are used here on the main thread (viewport prefetch math); maxInflight
  // is relayed to the worker, which does its own fetch throttling.
  //
  // "fast" tier's maxInflight was measured directly against the real
  // Protomaps endpoint (fetch+decode+IndexedDB, not just raw network): 150
  // real tiles took 2.4s at the old maxInflight=16, 0.8s at 64-96, zero
  // errors observed up to 128 concurrent. This is a latency-bound workload
  // (small payloads, ~150ms/request even warm) — more concurrency is a
  // direct, close-to-linear win here, unlike a bandwidth-constrained mobile
  // link where it backfires. margin also dropped from 0.6x to 0.35x viewport
  // (matching "medium"): at a typical viewport that was fetching ~7x the
  // visible area on every camera jump — real anticipatory buffer for
  // panning, but far more than a first paint needs, and the now-much-faster
  // concurrency easily keeps the buffer topped up during actual panning.
  const vtTuning = useRef({ maxInflight: 6, margin: 0.35, cap: 900 }); // moderate default until measured
  useEffect(() => {
    const tuningFor = (tier) => ({
      slow:   { maxInflight: 3,  margin: 0.15, cap: 250 },
      medium: { maxInflight: 5,  margin: 0.3,  cap: 600 },
      fast:   { maxInflight: 64, margin: 0.35, cap: 1800 },
      unknown:{ maxInflight: 6,  margin: 0.35, cap: 900 }, // e.g. iOS Safari, which has no Network Information API at all
    }[tier]);
    const conn = typeof navigator !== "undefined" ? navigator.connection : null;
    const measure = () => {
      let tier = "unknown";
      if (conn) {
        if (conn.saveData) tier = "slow";
        else if (conn.effectiveType === "slow-2g" || conn.effectiveType === "2g") tier = "slow";
        else if (conn.effectiveType === "3g") tier = "medium";
        else if (conn.effectiveType === "4g") tier = "fast";
      }
      vtTuning.current = tuningFor(tier);
      if (vtWorkerRef.current) vtWorkerRef.current.postMessage({ type: "tuning", maxInflight: vtTuning.current.maxInflight });
    };
    measure();
    if (conn && conn.addEventListener) {
      conn.addEventListener("change", measure);
      return () => conn.removeEventListener("change", measure);
    }
  }, []);

  const getVectorTile = useCallback((z, tx, ty) => {
    const key = `${z}/${tx}/${ty}`;
    let e = vtCache.current.get(key);
    if (e) {
      // self-heal: a tile that failed a while ago gets deleted and
      // re-created fresh below, instead of being stuck on fallback forever
      const staleFail = e.failed && Date.now() - (e.failedAt || 0) > VT_RETRY_MS;
      if (!staleFail) return e;
      vtCache.current.delete(key);
    }
    if (!PROTOMAPS_KEY || !vtWorkerRef.current) {
      // no key configured, or worker unavailable — don't bother, just mark
      // permanently unavailable so callers fall back immediately
      e = { loading: false, failed: true, failedAt: Infinity };
      vtCache.current.set(key, e);
      return e;
    }
    e = { loading: true, failed: false };
    vtCache.current.set(key, e);
    vtOrder.current.push(key);
    // capacity must comfortably exceed the largest single prefetch burst
    // (vtTuning's "fast" cap is 1800) — otherwise a single wide, stationary
    // view could evict tiles it still needs, causing them to be re-fetched
    // in a loop for no reason
    if (vtOrder.current.length > 2200) {
      const evictedKey = vtOrder.current.shift();
      vtCache.current.delete(evictedKey);
      if (vtPending.current.has(evictedKey)) {
        // this tile is no longer needed — tell the worker to drop it from
        // its queue instead of letting it keep competing with requests for
        // wherever the camera actually is now. Without this, panning across
        // several areas without waiting for each to finish could leave tens
        // of thousands of stale requests ahead of the current viewport.
        vtPending.current.delete(evictedKey);
        vtWorkerRef.current.postMessage({ type: "cancel", key: evictedKey });
      }
    }
    if (!vtPending.current.has(key)) {
      vtPending.current.add(key);
      vtWorkerRef.current.postMessage({ type: "resolve", key, z, tx, ty });
    }
    return e;
  }, []);

  // sample a small grid of points across the cell's own footprint (in this
  // tile's local 0..VECTOR_EXTENT space) against the building layer, giving
  // a real measured building-coverage fraction instead of a guessed density
  const BUILD_SAMPLES = [[0,0],[-0.35,0],[0.35,0],[0,-0.35],[0,0.35],[-0.3,-0.3],[0.3,-0.3],[-0.3,0.3],[0.3,0.3]];
  const classifyFromVector = useCallback((cellZ, wx, wy) => {
    const vn = 1 << VECTOR_Z;
    const fx = wx * vn, fy = wy * vn;
    const vtx = Math.max(0, Math.min(vn - 1, Math.floor(fx)));
    const vty = Math.max(0, Math.min(vn - 1, Math.floor(fy)));
    const e = getVectorTile(VECTOR_Z, vtx, vty);
    if (!e.water) return null; // still loading or failed — caller falls back

    const lx = (fx - vtx) * VECTOR_EXTENT, ly = (fy - vty) * VECTOR_EXTENT;

    for (const feat of e.water) {
      if (pointInDecoded(feat, lx, ly)) return { c: "water", src: "vector" };
    }

    let landuseKind = null;
    for (const feat of e.landuse) {
      if (pointInDecoded(feat, lx, ly)) { landuseKind = feat.kind; break; }
    }

    // cell footprint size in this tile's local units, for the building sample spread
    const cellLocal = VECTOR_EXTENT / Math.pow(2, cellZ - VECTOR_Z);
    let hits = 0;
    for (const [ox, oy] of BUILD_SAMPLES) {
      const sx = lx + ox * cellLocal, sy = ly + oy * cellLocal;
      for (const feat of e.buildings) {
        if (pointInDecoded(feat, sx, sy)) { hits++; break; }
      }
    }
    const buildingFrac = hits / BUILD_SAMPLES.length;

    // Coastal proximity, from the SAME decoded water polygons — "is any
    // water within ~150m," tested as real distance to the polygon's edges
    // (feature bbox is only a cheap pre-filter to skip most features, NOT
    // the proximity test itself — a bbox alone overclaims badly on concave
    // shapes like bays/inlets/river bends, tagging land far from any actual
    // shoreline as coastal). Without this upgrade step at all, waterfront/
    // coast would be unreachable: nothing else in the real classifier ever
    // produces them, since landuse tags and building density alone don't
    // encode "near the shore."
    const COASTAL_BUFFER = 256; // ~150m in VECTOR_EXTENT units at z14
    const COASTAL_BUFFER_SQ = COASTAL_BUFFER * COASTAL_BUFFER;
    let coastal = false;
    coastalCheck:
    for (const feat of e.water) {
      if (lx < feat.minX - COASTAL_BUFFER || lx > feat.maxX + COASTAL_BUFFER ||
          ly < feat.minY - COASTAL_BUFFER || ly > feat.maxY + COASTAL_BUFFER) continue;
      for (const ring of feat.geom) {
        for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
          if (distToSegSq(lx, ly, ring[j].x, ring[j].y, ring[i].x, ring[i].y) <= COASTAL_BUFFER_SQ) {
            coastal = true;
            break coastalCheck;
          }
        }
      }
    }

    const dbg = { landuseKind, buildingFrac: +buildingFrac.toFixed(2), hits, coastal };
    if (landuseKind && LANDUSE_TIER[landuseKind]) {
      let c = LANDUSE_TIER[landuseKind];
      if (coastal) c = c === "downtown" || c === "urban" ? "waterfront" : c === "rural" || c === "suburbs" ? "coast" : c;
      return { c, src: "vector", dbg };
    }
    // no explicit landuse tag — measured building coverage decides tier,
    // with the same coastal upgrade applied
    return { c: tierFor(coastal, buildingFrac), src: "vector", dbg };
  }, [getVectorTile]);

  /* Batch-prefetch every vector tile the current view needs, computed
     directly from the camera rather than discovered lazily one cell at a
     time. Two modes, matching the two render modes:

     - Deep zoom (the tappable ~306m deed grid is on screen): scan every
       VECTOR_Z (~2.4km) tile across the viewport+margin directly — there
       just aren't that many at this zoom, so an exhaustive scan is cheap.

     - Wide/preview zoom (country down to city scale): an exhaustive
       VECTOR_Z scan is the wrong tool entirely — at a ~300km view that's
       50,000+ individual 2.4km tiles, blowing through any reasonable cap
       and causing prefetch to just give up. But the renderer at this zoom
       only samples ONE point per visible preview cell (which can be up to
       ~20km across), so the actual need is a couple hundred tiles, not
       tens of thousands. This mode mirrors the render loop's own preview
       cell math and requests exactly what it will actually sample. */
  const prefetchVectorTiles = useCallback(() => {
    if (!PROTOMAPS_KEY || pickingHome) return;
    const { s, x: ox, y: oy } = cam.current;
    const { w, h } = size.current;
    if (!w || !h || s <= 0) return;
    const { margin: marginFrac, cap } = vtTuning.current;
    const gridOn = s / N >= 8;

    if (gridOn) {
      const vn = 1 << VECTOR_Z;
      const vtile = s / vn;
      if (vtile <= 0) return;
      const margin = Math.max(w, h) * marginFrac;
      const vx0 = Math.max(0, Math.floor((-ox - margin) / vtile));
      const vy0 = Math.max(0, Math.floor((-oy - margin) / vtile));
      const vx1 = Math.min(vn - 1, Math.floor((w - ox + margin) / vtile));
      const vy1 = Math.min(vn - 1, Math.floor((h - oy + margin) / vtile));
      const cnt = Math.max(0, vx1 - vx0 + 1) * Math.max(0, vy1 - vy0 + 1);
      if (cnt > cap) return;
      // Mirror the render loop's fog gate (line ~1772): the fine grid is
      // only ever painted inside unlocked territory (or unconditionally
      // before a player's first-ever purchase — see that comment), but
      // prefetch didn't know that and kept fetching+decoding+caching real
      // vector data for whatever the camera happened to be panned over,
      // regardless of whether any of it could ever be drawn. qkOf is fixed
      // to Z (fine-parcel zoom); shifting these VECTOR_Z-scale coords left
      // by (Z - VECTOR_Z) aligns them to the same bit-space before slicing
      // out the REGION_LEN-digit prefix — the trailing zero digits from the
      // shift don't affect the region prefix since REGION_LEN < VECTOR_Z.
      const gated = g.own.length > 0;
      const shift = Z - VECTOR_Z;
      for (let ty = vy0; ty <= vy1; ty++) {
        for (let tx = vx0; tx <= vx1; tx++) {
          if (gated && !unlockedRegions.current.has(qkOf(tx << shift, ty << shift).slice(0, REGION_LEN))) continue;
          getVectorTile(VECTOR_Z, tx, ty);
        }
      }
      return;
    }

    const pz = previewLevelFor(s);
    const pn = 1 << pz;
    const ptile = s / pn;
    if (ptile <= 0) return;
    const MARGIN_CELLS = 2;
    const px0 = Math.max(0, Math.floor(-ox / ptile) - MARGIN_CELLS);
    const py0 = Math.max(0, Math.floor(-oy / ptile) - MARGIN_CELLS);
    const px1 = Math.min(pn - 1, Math.ceil((w - ox) / ptile) + MARGIN_CELLS);
    const py1 = Math.min(pn - 1, Math.ceil((h - oy) / ptile) + MARGIN_CELLS);
    const pcnt = Math.max(0, px1 - px0 + 1) * Math.max(0, py1 - py0 + 1);
    if (pcnt <= 0 || pcnt > 8000) return; // matches the render loop's own cap — if it won't draw, don't fetch for it either
    const vn = 1 << VECTOR_Z;
    const seen = new Set();
    for (let ty = py0; ty <= py1; ty++) {
      for (let tx = px0; tx <= px1; tx++) {
        const wx = (tx + 0.5) / pn, wy = (ty + 0.5) / pn;
        const vtx = Math.max(0, Math.min(vn - 1, Math.floor(wx * vn)));
        const vty = Math.max(0, Math.min(vn - 1, Math.floor(wy * vn)));
        const vkey = vty * vn + vtx;
        if (seen.has(vkey)) continue; // several nearby preview cells often share one underlying vector tile
        seen.add(vkey);
        getVectorTile(VECTOR_Z, vtx, vty);
      }
    }
  }, [getVectorTile, g, pickingHome]);

  const clsCache = useRef(new Map());
  const classifyTxy = useCallback((tx, ty) => {
    const cc = clsCache.current;
    const key = ty * N + tx;
    const cached = cc.get(key);
    if (cached) return cached;

    const wx = (tx + 0.5) / N, wy = (ty + 0.5) / N;
    const lat = wyToLat(wy), lon = wx * 360 - 180;
    const { n, d } = nearestCity(lat, lon);

    const vec = classifyFromVector(Z, wx, wy);
    if (vec) {
      const v = { c: vec.c, n, d, src: "vector", dbg: vec.dbg };
      if (cc.size > 60000) cc.clear();
      cc.set(key, v);
      return v;
    }
    // vector tile not loaded yet (or no API key configured) — pending,
    // not purchasable, deliberately NOT cached so this cell re-attempts
    // the real classifier (and upgrades) on a later call once it arrives
    return { c: "pending", n, d, src: "pending" };
  }, [nearestCity, classifyFromVector]);

  const classify = useCallback((qk) => {
    const [tx, ty] = txyOf(qk);
    return classifyTxy(tx, ty);
  }, [classifyTxy]);

  /* ── real basemap tiles (CARTO Dark Matter, © OpenStreetMap contributors
     © CARTO) — crisp raster imagery with built-in place labels at every
     zoom, replacing the single static planet image for visuals. ── */
  // Removed: an old "migrate tile classes from older builds" effect used to
  // live here, re-deriving each owned tile's cls via classify(t.qk) once
  // ready flipped true. That made sense in the pre-accounts era, where cls
  // was a locally-cached value that could go stale if the classification
  // algorithm changed between app versions. Now cls is server-authoritative
  // and permanent (set once, at purchase, in the tiles table) — but
  // classify() depends on the *local* vector-tile cache, which is empty on
  // every fresh page load. This effect was overwriting a freshly-fetched
  // real district (e.g. "coast") with "pending" (rps 0) on almost every
  // boot, simply because the player hadn't zoomed into that spot yet in the
  // current session — a real, confirmed bug, not a hypothetical one.

  /* ── shared world regions ── */
  // Real ownership/rarity/level/listing data straight from the `tiles`
  // table (RLS makes it public-read, see supabase.sql). Field names (o/n/r/l/p)
  // are kept short to match what the canvas renderer + tile-detail sheet
  // already read — only the source (Postgres, not a kv blob) changed.
  const ensureRegion = useCallback(async (prefix, forceRefresh) => {
    const rc = regions.current;
    const cur = rc.get(prefix);
    if (!forceRefresh && cur && Date.now() - cur.at < 8000) return cur;
    if (busyRegions.current.has(prefix)) return cur;
    busyRegions.current.add(prefix);
    setSyncing(true);
    const { data, error } = await supabase
      .from("tiles")
      // profiles!tiles_owner_fkey — tiles now has two FKs into profiles
      // (owner, flip_royalty_to as of the flip feature), so PostgREST can no
      // longer infer which relationship an unqualified `profiles(username)`
      // embed means and rejects the whole query. Must stay qualified.
      .select("qk,owner,cls,rarity,level,paid,list_price,flip_price,prestige,attacks_received_count,attacks_received_date,build_until,profiles!tiles_owner_fkey(username,peak_net_worth)")
      .like("qk", `${prefix}%`);
    const t = {};
    if (error) {
      // A failed fetch here used to fail silently: t stayed {}, the fine
      // grid rendered zero tiles for this region, and nothing anywhere
      // told you why (a schema drift — e.g. a client querying a column a
      // live DB doesn't have yet — is exactly the kind of thing that
      // trips this). Route it into the same errs/🐞 pipe as window error/
      // unhandledrejection so it's visible via the debug overlay and
      // "copy diagnostics" instead of a blank map with no signal.
      const D = dbgRef.current;
      D.errs = [...D.errs.slice(-2), `tiles fetch (${prefix}): ${error.message || error.code || "unknown error"}`.slice(0, 140)];
      setDbg(true);
      console.error("ensureRegion fetch failed", prefix, error);
    } else {
      for (const row of data || []) {
        t[row.qk] = {
          o: row.owner, n: row.profiles?.username, pnw: row.profiles?.peak_net_worth || 0, r: row.rarity, l: row.level, pr: row.prestige || 0,
          cls: row.cls, pd: row.paid, ...(row.list_price != null ? { p: row.list_price } : {}),
          ...(row.flip_price != null ? { fp: row.flip_price } : {}),
          arc: row.attacks_received_date === todayUTC() ? (row.attacks_received_count || 0) : 0,
          ...(row.build_until != null ? { bu: row.build_until } : {}),
        };
      }
    }
    const obj = { t, at: Date.now() };
    rc.set(prefix, obj);
    // reconcile: recover tiles deeded to me that I lost track of on this
    // device (e.g. just signed in); drop ones I no longer own (sold elsewhere)
    let changed = false;
    for (const [qk, rec] of Object.entries(obj.t)) {
      const mine = ownMap.current.get(qk);
      if (rec.o === g.uid && !mine) {
        // Use the tile's real, permanently-stored cls (rec.cls) — NOT a
        // fresh classify(qk).c re-derivation. classify() depends on the
        // local vector-tile cache, which may not have loaded yet for this
        // spot; a live "pending" read here would get baked into g.own as a
        // real district, silently zeroing that tile's rent (pending has
        // rps 0) even though the account genuinely owns a real, priced tile.
        g.own.push({ qk, l: rec.l || 0, r: rec.r || 0, pr: rec.pr || 0, cls: rec.cls, pd: rec.pd || 0, ...(rec.p != null ? { p: rec.p } : {}), ...(rec.bu != null ? { bu: rec.bu } : {}) });
        changed = true;
      } else if (mine) {
        if (rec.o !== g.uid) { g.own.splice(g.own.findIndex((t2) => t2.qk === qk), 1); changed = true; }
        else if (mine.p !== rec.p) { mine.p = rec.p; changed = true; }
      }
    }
    if (changed) { rebuildOwn(); dirty.current = true; }
    busyRegions.current.delete(prefix);
    setSyncing(busyRegions.current.size > 0);
    return obj;
  }, [g, rebuildOwn]);

  const recOf = (qk) => {
    const r = regions.current.get(regionOf(qk));
    return r ? r.t[qk] : undefined;
  };

  /* ── market: just a live query over tiles.list_price, no separate index ── */
  // Builds a PostgREST `.or()` filter matching any of the player's
  // currently-unlocked regions — keeps the Market/Flip tabs scoped to
  // territory actually reachable, the same boundary the map's fog-of-war
  // and fine-grid prefetch already enforce visually (see the matching
  // server-side check in buy_listed_tile/buy_flipped_tile — this is a
  // convenience filter for what gets shown, not the real enforcement).
  const regionOrFilter = () => [...unlockedRegions.current].map((r) => `qk.like.${r}%`).join(",");

  const refreshMarket = useCallback(async () => {
    setMarket({ loading: true, rows: null });
    const filter = regionOrFilter();
    if (!filter) { setMarket({ loading: false, rows: [] }); return; }
    const { data, error } = await supabase
      // see the matching comment in ensureRegion — must stay FK-qualified
      // now that tiles has two relationships into profiles.
      .from("tiles").select("qk,cls,list_price,profiles!tiles_owner_fkey(username,peak_net_worth)")
      .not("list_price", "is", null).or(filter).order("updated_at", { ascending: false }).limit(40);
    if (error) { setMarket({ loading: false, rows: [] }); return; }
    setMarket({ loading: false, rows: (data || []).map((r) => ({ qk: r.qk, cls: r.cls, p: r.list_price, n: r.profiles?.username, pnw: r.profiles?.peak_net_worth || 0 })) });
  }, []);

  // Flipped tiles (owner null, flip_price set — see flip_tile/buy_flipped_tile
  // in supabase.sql) are otherwise only discoverable by literally panning to
  // that exact tile on the map, same as raw unclaimed land — which means
  // most would probably never sell. Surfaced here as their own section so a
  // flip is actually likely to find a buyer. Deliberately doesn't fetch/show
  // who flipped it (keeps this query simple — flip_royalty_to is a second FK
  // into profiles and embedding it would need its own qualified hint, same
  // issue list_price's owner embed hit above).
  const refreshFlips = useCallback(async () => {
    setFlips({ loading: true, rows: null });
    const filter = regionOrFilter();
    if (!filter) { setFlips({ loading: false, rows: [] }); return; }
    const { data, error } = await supabase
      .from("tiles").select("qk,cls,flip_price")
      .not("flip_price", "is", null).or(filter).order("updated_at", { ascending: false }).limit(40);
    if (error) { setFlips({ loading: false, rows: [] }); return; }
    setFlips({ loading: false, rows: (data || []).map((r) => ({ qk: r.qk, cls: r.cls, p: r.flip_price })) });
  }, []);

  useEffect(() => { if (tab === "market") { refreshMarket(); refreshFlips(); } }, [tab, refreshMarket, refreshFlips]);

  /* ── leaderboard: real joined data (see the `leaderboard` view) ── */
  const refreshLB = useCallback(async () => {
    setLb({ loading: true, rows: null });
    const { data, error } = await supabase
      .from("leaderboard").select("*").order("net_worth", { ascending: false }).limit(10);
    if (error) { setLb({ loading: false, rows: [] }); return; }
    setLb({ loading: false, rows: (data || []).map((r) => ({ id: r.user_id, n: r.username, nw: r.net_worth, pc: r.tile_count, pnw: r.peak_net_worth || 0 })) });
  }, []);
  useEffect(() => { if (tab === "hq") refreshLB(); }, [tab, refreshLB]);

  /* ── activity log: reads bank_ledger + battle_log directly (both already
     RLS-permitted for your own rows — no new RPC needed) and merges them
     into one human-readable feed. battle_log references auth.users, not
     profiles, so it can't ride a PostgREST embed the way tiles.owner does —
     opponent usernames need a separate lookup. ── */
  const refreshLog = useCallback(async () => {
    setLog({ loading: true, rows: null });
    const [bankRes, battleRes] = await Promise.all([
      supabase.from("bank_ledger").select("id,amount,from_username,kind,qk,created_at").eq("recipient", g.uid).order("created_at", { ascending: false }).limit(20),
      supabase.from("battle_log").select("id,attacker,defender,attacker_won,cost,qk,created_at").or(`attacker.eq.${g.uid},defender.eq.${g.uid}`).order("created_at", { ascending: false }).limit(20),
    ]);
    const bankRows = bankRes.data || [];
    const battleRows = battleRes.data || [];
    const oppIds = [...new Set(battleRows.map((r) => (r.attacker === g.uid ? r.defender : r.attacker)))];
    let names = {};
    if (oppIds.length) {
      const { data: profRows } = await supabase.from("profiles").select("user_id,username").in("user_id", oppIds);
      names = Object.fromEntries((profRows || []).map((p) => [p.user_id, p.username]));
    }
    const bankEvents = bankRows.map((r) => ({
      id: `bank-${r.id}`, ts: r.created_at, qk: r.qk,
      text: r.kind === "repossession" ? `Tile repossessed for inactivity — ₲${fmt(r.amount)} refunded`
        : r.kind === "flip" ? `Flip royalty from ${r.from_username || "a player"} — +₲${fmt(r.amount)}`
        : `Sold to ${r.from_username || "a player"} — +₲${fmt(r.amount)}`,
      tone: r.kind === "repossession" ? "dim" : "good",
    }));
    const battleEvents = battleRows.map((r) => {
      const iAmAttacker = r.attacker === g.uid;
      const oppName = names[iAmAttacker ? r.defender : r.attacker] || "a player";
      return iAmAttacker
        ? { id: `battle-${r.id}`, ts: r.created_at, qk: r.qk, tone: r.attacker_won ? "good" : "bad",
            text: r.attacker_won ? `Captured a tile from ${oppName} — ₲${fmt(r.cost)} spent` : `Attack on ${oppName} repelled — ₲${fmt(r.cost)} lost` }
        : { id: `battle-${r.id}`, ts: r.created_at, qk: r.qk, tone: r.attacker_won ? "bad" : "good",
            text: r.attacker_won ? `Lost a tile to ${oppName}'s attack` : `Defended against ${oppName}'s attack — nothing lost` };
    });
    const merged = [...bankEvents, ...battleEvents].sort((a, b) => new Date(b.ts) - new Date(a.ts)).slice(0, 30);
    setLog({ loading: false, rows: merged });
  }, [g]);
  useEffect(() => { if (tab === "hq") { refreshLog(); g.hasUnseenLoss = false; } }, [tab, refreshLog, g]);

  /* ── actions: every one of these is a security-definer RPC call — price,
     rarity, balance and ownership are all decided server-side (see
     supabase.sql). The client applies the same debit optimistically for a
     snappy UI, then syncRent() reconciles the real balance periodically. ── */
  const needName = () => false; // username is claimed before the game ever mounts now

  const buyUnowned = async (qk) => {
    if (roll || needName()) return;
    const cls = classify(qk).c;
    if (CLS[cls].sale === false) return;
    const price = CLS[cls].price;
    if (g.bal < price) return;
    // claiming NEW unowned land costs energy (see buy_unowned_tile in
    // supabase.sql) — trading/upgrading tiles you already have doesn't.
    // Client-side check just saves a round-trip; the server enforces this
    // independently and for real.
    if (!g.devMode && energyNow(g) < 1) {
      toast(`Out of energy for today (${statusFor(g.peakNetWorth).cap}/day) — resets at midnight UTC`);
      return;
    }
    setRoll({ qk, phase: "spin" });
    const { data, error } = await supabase.rpc("buy_unowned_tile", { p_qk: qk, p_cls: cls });
    if (error || !data) {
      setRoll(null);
      toast(error?.message || "Beaten to it — another player owns that tile.");
      return;
    }
    g.bal -= price;
    g.energy = Math.max(0, energyNow(g) - 1);
    const r = data.rarity;
    g.own.push({ qk, l: data.level, r, pr: data.prestige || 0, cls, pd: data.paid });
    // if this was the player's very first tile anywhere, the server just
    // set it as their free home region (see buy_unowned_tile) — mirror
    // that locally so it doesn't render as freshly-fogged before the next
    // full resync. Harmless no-op for every later purchase (region is
    // already unlocked, or the check above wouldn't have allowed it).
    const region = regionOf(qk);
    unlockedRegions.current.add(region);
    if (!homeRegionRef.current) homeRegionRef.current = region;
    rebuildOwn(); checkAch(); dirty.current = true; save();
    setTimeout(() => setRoll({ qk, phase: "done", r }), reduced ? 50 : 900);
    if (r === 3) toast("Legendary deed!");
  };

  // mirrors unlock_region()'s pricing in supabase.sql exactly — display/
  // disabled-state only, the RPC is what actually decides and charges.
  // The free home region is excluded from the count, matching the server.
  const nextUnlockCost = () => {
    const paid = unlockedRegions.current.size - (homeRegionRef.current ? 1 : 0);
    return 1000 * Math.pow(2, Math.max(0, paid));
  };

  const unlockRegion = async (qk) => {
    const region = regionOf(qk);
    if (unlockedRegions.current.has(region)) return;
    const cost = nextUnlockCost();
    if (g.bal < cost) return;
    const { data, error } = await supabase.rpc("unlock_region", { p_qk: qk });
    if (error || !data) { toast(error?.message || "Couldn't unlock that region — try again."); return; }
    g.bal -= cost;
    unlockedRegions.current.add(region);
    dirty.current = true; save();
    toast("New territory unlocked");
  };

  // PvP: true if the player owns at least one orthogonal neighbor of qk —
  // display/disabled-state mirror of attack_tile()'s adjacency check; the
  // server re-derives this itself from `tiles`, this never gates the real
  // outcome.
  const attackableFrom = (qk) => neighborsOf(qk).some((nqk) => ownMap.current.has(nqk));

  // mirrors attack_tile()'s cost/power/odds formulas exactly — display/
  // disabled-state only, the RPC is what actually charges and resolves
  // the battle. Includes the wealth-indexed floor (0.2% of the ATTACKER's
  // own peak net worth, via g.peakNetWorth) — this was previously missing
  // client-side, which meant the button showed/gated on the pre-floor
  // price even though the server was already charging the real (higher,
  // for wealthy attackers) amount.
  const attackCostFor = (rec) => Math.max(
    Math.round(CLS[rec.cls].price * 0.5 * (1 + 0.5 * (rec.l || 0))),
    Math.round((g.peakNetWorth || 0) * 0.002)
  );
  const defPowerFor = (rec) => (1 + (rec.l || 0)) * RAR[rec.r || 0].m * (1 + 0.25 * (rec.pr || 0));
  // win probability from the attacker's side, same clamp as attack_tile()
  const winProbFor = (attPower, defPower) => Math.max(0.05, Math.min(0.90, attPower / (attPower + defPower)));

  const buyListed = async (qk) => {
    if (needName()) return;
    const rec = recOf(qk);
    if (!rec) { toast("Tile not synced yet — one moment, then try again."); return; }
    if (rec.p == null || rec.o === g.uid) return;
    const price = rec.p;
    if (g.bal < price) return;
    const { data, error } = await supabase.rpc("buy_listed_tile", { p_qk: qk, p_expected_price: price });
    if (error || !data) { toast(error?.message || "Listing changed — trade cancelled."); return; }
    g.bal -= price;
    g.own.push({ qk, l: data.level, r: data.rarity, pr: data.prestige || 0, cls: data.cls, pd: data.paid });
    rebuildOwn(); checkAch(); dirty.current = true; save();
    toast(`Deed acquired from ${rec.n || "a player"}`);
  };

  // PvP: raid an orthogonally-adjacent enemy tile — cost is charged whether
  // you win or lose (attack_tile() in supabase.sql owns the real formulas;
  // this mirrors them for the optimistic debit + battle/reveal animation,
  // but who actually wins is entirely server-decided).
  const attackTile = async (qk) => {
    if (roll || needName()) return;
    const rec = recOf(qk);
    if (!rec || rec.o == null || rec.o === g.uid) return;
    if (!attackableFrom(qk)) { toast("You need to own a neighboring tile to attack this one."); return; }
    const cost = attackCostFor(rec);
    if (g.bal < cost) { toast("Not enough ₲ to launch this attack."); return; }
    if (!g.devMode && (g.attacksSent || 0) >= ATTACK_DAILY_CAP) {
      toast(`No attacks left today (${ATTACK_DAILY_CAP}/day) — resets at midnight UTC`);
      return;
    }
    if (!g.devMode && (rec.arc || 0) >= ATTACK_RECEIVED_CAP) {
      toast("This tile has already been attacked enough today — try again tomorrow.");
      return;
    }
    setRoll({ qk, phase: "battle" });
    const { data, error } = await supabase.rpc("attack_tile", { p_qk: qk });
    if (error || !data || !data.length) {
      setRoll(null);
      toast(error?.message || "Attack failed — try again.");
      return;
    }
    const result = data[0]; // { qk, won, cost, att_power, def_power }
    g.bal -= Number(result.cost);
    g.attacksSent = (g.attacksSent || 0) + 1;

    // only a capture resets the target to Vacant (see attack_tile) — a
    // successful defense leaves it completely untouched, so the defender's
    // build is what actually won the fight. Patch the shared region cache
    // directly either way, same immediate-local-patch pattern flip() uses
    // above, instead of waiting for the next region resync.
    const targetCls = rec.cls;
    const r = regions.current.get(regionOf(qk));
    if (r && r.t[qk]) {
      if (result.won) {
        r.t[qk] = { ...r.t[qk], o: g.uid, n: g.name, pnw: g.peakNetWorth, r: 0, l: 0, pr: 0, pd: CLS[targetCls].price, arc: (rec.arc || 0) + 1 };
        delete r.t[qk].p;
        delete r.t[qk].fp;
      } else {
        r.t[qk] = { ...r.t[qk], arc: (rec.arc || 0) + 1 };
      }
    }

    if (result.won) {
      g.own.push({ qk, l: 0, r: 0, pr: 0, cls: targetCls, pd: CLS[targetCls].price });
      const region = regionOf(qk);
      unlockedRegions.current.add(region);
      if (!homeRegionRef.current) homeRegionRef.current = region;
      rebuildOwn(); checkAch();
      if (!g.ach.conqueror) { g.ach.conqueror = 1; toast("Unlocked — Conqueror"); }
    }
    dirty.current = true; save();
    setTimeout(() => setRoll({
      qk, phase: "battle-done", won: result.won,
      attPower: Number(result.att_power), defPower: Number(result.def_power),
    }), reduced ? 50 : 1100);
  };

  const listTile = async (qk, price) => {
    const t = ownMap.current.get(qk);
    if (!t || !(price > 0)) return;
    const { error } = await supabase.rpc("list_tile", { p_qk: qk, p_price: price });
    if (error) { toast("Couldn't list — " + (error.message || "try again")); return; }
    t.p = price; dirty.current = true; save();
    toast(`Listed for ₲${fmt(price)}`);
  };

  const unlist = async (qk) => {
    const t = ownMap.current.get(qk);
    if (!t) return;
    const { error } = await supabase.rpc("unlist_tile", { p_qk: qk });
    if (error) { toast("Couldn't unlist — " + (error.message || "try again")); return; }
    delete t.p; dirty.current = true; save();
    toast("Listing removed");
  };

  // Starts a build timer rather than completing instantly (see
  // upgrade_tile in supabase.sql) — the response's level is UNCHANGED and
  // build_until is set, unless this account is dev_mode (server completes
  // it immediately, same as the old pre-timer behavior). Slot-cap check
  // here is display/UX only; the server enforces it for real.
  const upgrade = async (qk) => {
    const t = ownMap.current.get(qk);
    if (!t || t.l >= MAX_LVL) return;
    if (t.bu) { toast("Already building — rush it or wait for it to finish."); return; }
    if (!g.devMode) {
      const activeBuilds = g.own.filter((x) => x.bu).length;
      const slotCap = statusFor(g.peakNetWorth).slots;
      if (activeBuilds >= slotCap) { toast(`No free builder slots (${slotCap}) — rush a build or wait for one to finish`); return; }
    }
    const cost = upCost(t);
    if (g.bal < cost) return;
    const { data, error } = await supabase.rpc("upgrade_tile", { p_qk: qk });
    if (error || !data) { toast(error?.message || "Couldn't upgrade."); return; }
    g.bal -= cost; t.pd = data.paid;
    if (data.build_until) {
      t.bu = data.build_until;
      toast(`Building ${LVL[t.l + 1]}…`);
    } else {
      t.l = data.level;
      delete t.bu;
      checkAch();
      toast(`${LVL[t.l]} built`);
    }
    rebuildOwn(); dirty.current = true; save();
  };

  // Pay to finish an in-progress build instantly (see rush_build in
  // supabase.sql) — cost is proportional to time remaining, computed
  // client-side via rushCostFor() for display; the server computes its
  // own authoritative charge, so a few seconds of drift between the two
  // is possible and self-corrects on the next syncRent().
  const rushBuild = async (qk) => {
    const t = ownMap.current.get(qk);
    if (!t || !t.bu) return;
    const cost = rushCostFor(t);
    if (g.bal < cost) { toast("Not enough ₲ to rush this build."); return; }
    const { data, error } = await supabase.rpc("rush_build", { p_qk: qk });
    if (error || !data) { toast(error?.message || "Couldn't rush this build."); return; }
    g.bal -= cost; t.l = data.level;
    delete t.bu;
    rebuildOwn(); checkAch(); dirty.current = true; save();
    toast(`Rushed — ${LVL[t.l]} built for ₲${fmt(cost)}`);
  };

  // Manual, sequential batch upgrade over a given tile set (the Assets
  // tab's currently-filtered list, so it's scoped to whatever the player
  // was already looking at — "upgrade all my Rural tiles" falls out of
  // the existing filter for free). Deliberately re-picks the single
  // cheapest still-upgradable tile each round rather than sorting once
  // up front — upgrading a tile changes ITS OWN next cost, which can
  // reorder it relative to the others mid-batch. Sequential (not
  // parallel) on purpose: affordability is order-dependent against a
  // running balance, and running it visibly one tile at a time (with a
  // live progress toast) is the point — a player asked for this, it's
  // not a background auto-upgrade bot.
  const upgradeAll = async (tiles) => {
    if (batchBusy) return;
    // already-building tiles aren't "eligible" here — starting a build is
    // all this does now, and a tile can only run one at a time
    let pool = tiles.filter((t) => t.l < MAX_LVL && !t.bu);
    const totalEligible = pool.length;
    if (totalEligible === 0) { toast("Nothing here needs upgrading."); return; }
    let count = 0, spent = 0, slotLimited = false;
    setBatchBusy({ done: 0, total: totalEligible });
    while (pool.length) {
      if (!g.devMode) {
        const activeBuilds = g.own.filter((x) => x.bu).length;
        const slotCap = statusFor(g.peakNetWorth).slots;
        if (activeBuilds >= slotCap) { slotLimited = true; break; }
      }
      pool.sort((a, b) => upCost(a) - upCost(b));
      const t = pool[0];
      const cost = upCost(t);
      if (g.bal < cost) break; // cheapest remaining is unaffordable — nothing else in the pool will be either
      const { data, error } = await supabase.rpc("upgrade_tile", { p_qk: t.qk });
      if (error || !data) break; // stop on any server-side rejection rather than retry-looping
      g.bal -= cost; t.pd = data.paid;
      if (data.build_until) t.bu = data.build_until; else t.l = data.level;
      spent += cost; count++;
      pool = pool.filter((x) => x !== t); // one build per tile at a time either way
      setBatchBusy({ done: count, total: totalEligible });
      force();
    }
    setBatchBusy(null);
    rebuildOwn(); checkAch(); dirty.current = true; save();
    toast(count > 0
      ? `Started ${count} build${count === 1 ? "" : "s"} for ₲${fmt(spent)}${slotLimited ? " — builder slots full, queue the rest once one finishes" : ""}`
      : slotLimited ? "No free builder slots — wait for a build to finish or rush one." : "Not enough ₲ to upgrade anything here.");
  };

  const redevelop = async (qk) => {
    const t = ownMap.current.get(qk);
    if (!t || t.l < MAX_LVL) return;
    const { data, error } = await supabase.rpc("redevelop_tile", { p_qk: qk });
    if (error || !data) { toast(error?.message || "Couldn't redevelop."); return; }
    t.l = data.level; t.pr = data.prestige;
    if (!g.ach.redevelop1) { g.ach.redevelop1 = 1; toast("Unlocked — Redeveloper"); }
    rebuildOwn(); dirty.current = true; save();
    toast(`Redeveloped — ★${t.pr} · +${t.pr * 25}% rent permanently`);
  };

  // The alternative to redevelop(): cash out a maxed tile instead of
  // prestiging it in place. Ownership is relinquished (see flip_tile in
  // supabase.sql) so the local region cache is patched directly to reflect
  // that immediately, same as the region-resync path would eventually show.
  const flip = async (qk) => {
    const t = ownMap.current.get(qk);
    if (!t || t.l < MAX_LVL) return;
    const { data, error } = await supabase.rpc("flip_tile", { p_qk: qk });
    if (error || !data) { toast(error?.message || "Couldn't flip."); return; }
    g.own.splice(g.own.findIndex((x) => x.qk === qk), 1);
    const r = regions.current.get(regionOf(qk));
    if (r) r.t[qk] = { o: null, r: 0, l: 0, pr: 0, cls: t.cls, pd: 0, fp: data.flip_price };
    rebuildOwn(); dirty.current = true; save();
    toast(`Flipped — listed for ₲${fmt(data.flip_price)}, you get a cut when it sells`);
  };

  const buyFlipped = async (qk) => {
    if (needName()) return;
    const rec = recOf(qk);
    if (!rec) { toast("Tile not synced yet — one moment, then try again."); return; }
    if (rec.fp == null || rec.o != null) return;
    const price = rec.fp;
    if (g.bal < price) return;
    const { data, error } = await supabase.rpc("buy_flipped_tile", { p_qk: qk, p_expected_price: price });
    if (error || !data) { toast(error?.message || "Listing changed — trade cancelled."); return; }
    g.bal -= price;
    g.own.push({ qk, l: data.level, r: data.rarity, pr: data.prestige || 0, cls: data.cls, pd: data.paid });
    rebuildOwn(); checkAch(); dirty.current = true; save();
    toast("Fresh deed acquired — flipped tile");
  };

  const abandon = async (qk) => {
    const t = ownMap.current.get(qk);
    if (!t) return;
    const refund = Math.round((t.pd || 0) * 0.5);
    const { error } = await supabase.rpc("abandon_tile", { p_qk: qk });
    if (error) { toast("Couldn't abandon — " + (error.message || "try again")); return; }
    g.own.splice(g.own.findIndex((x) => x.qk === qk), 1);
    g.bal += refund;
    rebuildOwn(); dirty.current = true; save();
    toast(`Sold to the void for ₲${fmt(refund)}`);
  };

  const claimBoost = async () => {
    const { data, error } = await supabase.rpc("activate_boost");
    if (error || !data) {
      toast(/cooldown/i.test(error?.message || "") ? "Boost still on cooldown." : "Couldn't activate boost — try again.");
      setModal(null);
      return;
    }
    g.boostUntil = data.boost_until ? new Date(data.boost_until).getTime() : 0;
    g.boostReadyAt = data.boost_ready_at ? new Date(data.boost_ready_at).getTime() : 0;
    dirty.current = true; save(); setModal(null);
    toast("2× rent for 5 minutes");
  };

  const closeModal = () => {
    if (pendings.current.length) setModal(pendings.current.shift());
    else setModal(null);
  };

  const setName = async () => {
    const n = nameDraft.trim().slice(0, 16);
    if (!n) return;
    const { data, error } = await supabase.rpc("claim_username", { p_username: n });
    if (error) { toast(error.message || "Couldn't rename"); return; }
    g.name = data.username; dirty.current = true; save();
    setModal(null);
    toast("Deeds will be signed as " + data.username);
  };

  // Deleting an auth user needs the service-role key, which must never ship
  // to the client — this calls the delete-account edge function instead
  // (see supabase/functions/delete-account), which runs with that key
  // server-side, then signs the browser out locally.
  const deleteAccount = async () => {
    setDeleteBusy(true);
    try {
      const { error } = await supabase.functions.invoke("delete-account");
      if (error) throw error;
      await signOut();
    } catch (e) {
      toast("Couldn't delete account — " + (e.message || "try again"));
      setDeleteBusy(false);
      setConfirmDelete(false);
    }
  };

  /* ── camera & canvas ── */
  const wrapRef = useRef(null);
  const canvasRef = useRef(null);
  const cam = useRef({ x: 0, y: 0, s: 300, init: false }); // s = world width in px
  const size = useRef({ w: 0, h: 0, dpr: 1 });
  const frame = useRef(0);
  const ptrs = useRef(new Map());
  const gesture = useRef(null);

  const fitWorld = useCallback(() => {
    const { w, h } = size.current;
    const s = Math.min(w, h * 2) * 0.95;
    cam.current = { s, x: (w - s) / 2, y: (h - s) / 2, init: true };
  }, []);

  const flyTo = useCallback((lat, lon, tilePx = 16) => {
    const { w, h } = size.current;
    const s = N * tilePx;
    const wx = lonToWx(lon), wy = latToWy(lat);
    cam.current = { s, x: w / 2 - wx * s, y: h / 2 - wy * s, init: true };
    setCities(false);
    prefetchVectorTiles();
  }, [prefetchVectorTiles]);

  useEffect(() => {
    const el = wrapRef.current, cv = canvasRef.current;
    if (!el || !cv) return;
    const measure = () => {
      const r = el.getBoundingClientRect();
      if (r.width === 0 || r.height === 0) return; // hidden or not laid out yet
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      // Checked against the actual canvas element's own pixel buffer, not
      // just the cached size.current ref — size.current persists across a
      // canvas remount (see the pickingHome comment below) and would still
      // "match" even though the freshly-mounted <canvas> itself still has
      // its default, never-set 300x150 buffer. Comparing to cv.width/height
      // directly is what makes this guard correct for that case too.
      if (cv.width === Math.round(r.width * dpr) && cv.height === Math.round(r.height * dpr) && cam.current.init) return;
      size.current = { w: r.width, h: r.height, dpr };
      cv.width = r.width * dpr; cv.height = r.height * dpr;
      cv.style.width = r.width + "px"; cv.style.height = r.height + "px";
      if (!cam.current.init && r.width > 0) fitWorld();
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    window.addEventListener("resize", measure);
    return () => { ro.disconnect(); window.removeEventListener("resize", measure); };
    // must re-run after the loading screen unmounts (ready), AND after the
    // start-location picker hands off to the normal game view (pickingHome)
    // — that transition swaps in a completely different <canvas> DOM node
    // (two separate early-return JSX trees sharing the same canvasRef/
    // wrapRef), and without pickingHome here this effect stayed attached
    // via ResizeObserver to the OLD, now-unmounted picker canvas forever,
    // leaving the new one at the browser's default 300x150 pixel buffer
    // while its container was CSS-stretched to full size — exactly the
    // clipped/mis-proportioned render a player reported after confirming
    // a start location.
  }, [fitWorld, ready, pickingHome]);

  const hexA = (hex, a) => {
    const n = parseInt(hex.slice(1), 16);
    return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
  };

  const drawBuilding = (ctx, px, py, cs, lvl, seed) => {
    const f = frame.current;
    const win = (idx) => (reduced ? true : ((seed * 31 + idx * 7 + (f >> 4)) % 13) !== 0);
    const A = C.amber;
    if (lvl === 0) {
      ctx.fillStyle = A;
      const s2 = cs * 0.16;
      ctx.beginPath();
      ctx.moveTo(px + cs / 2, py + cs / 2 - s2); ctx.lineTo(px + cs / 2 + s2, py + cs / 2);
      ctx.lineTo(px + cs / 2, py + cs / 2 + s2); ctx.lineTo(px + cs / 2 - s2, py + cs / 2);
      ctx.closePath(); ctx.fill();
      return;
    }
    ctx.fillStyle = "#3A4A63";
    if (lvl === 1) {
      ctx.fillRect(px + cs * 0.25, py + cs * 0.55, cs * 0.5, cs * 0.3);
      if (win(0)) { ctx.fillStyle = A; ctx.fillRect(px + cs * 0.45, py + cs * 0.62, cs * 0.1, cs * 0.1); }
    } else if (lvl === 2) {
      ctx.fillRect(px + cs * 0.14, py + cs * 0.45, cs * 0.32, cs * 0.4);
      ctx.fillRect(px + cs * 0.54, py + cs * 0.45, cs * 0.32, cs * 0.4);
      ctx.fillStyle = A;
      if (win(0)) ctx.fillRect(px + cs * 0.24, py + cs * 0.55, cs * 0.1, cs * 0.1);
      if (win(1)) ctx.fillRect(px + cs * 0.64, py + cs * 0.55, cs * 0.1, cs * 0.1);
    } else if (lvl === 3) {
      ctx.fillRect(px + cs * 0.28, py + cs * 0.3, cs * 0.44, cs * 0.58);
      ctx.fillStyle = A;
      for (let i = 0; i < 4; i++) if (win(i))
        ctx.fillRect(px + cs * (0.34 + (i % 2) * 0.2), py + cs * (0.38 + Math.floor(i / 2) * 0.24), cs * 0.1, cs * 0.12);
    } else {
      ctx.fillStyle = "#42536F";
      ctx.fillRect(px + cs * 0.3, py + cs * 0.22, cs * 0.4, cs * 0.7);
      ctx.fillRect(px + cs * 0.48, py + cs * 0.1, cs * 0.04, cs * 0.12);
      ctx.fillStyle = A;
      for (let i = 0; i < 6; i++) if (win(i))
        ctx.fillRect(px + cs * (0.36 + (i % 2) * 0.18), py + cs * (0.28 + Math.floor(i / 2) * 0.21), cs * 0.09, cs * 0.11);
    }
  };

  const draw = useCallback(() => {
    const cv = canvasRef.current;
    if (!cv) return;
    const ctx = cv.getContext("2d");
    const { w, h, dpr } = size.current;
    if (!w || !h) return;
    const { x: ox, y: oy, s } = cam.current;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = C.oceanDeep;
    ctx.fillRect(0, 0, w, h);

    const tilePx = s / N;
    const dx = Math.max(ox, 0), dy = Math.max(oy, 0);
    const dx1 = Math.min(ox + s, w), dy1 = Math.min(oy + s, h);
    if (dx1 > dx && dy1 > dy) {
      ctx.fillStyle = C.ocean;
      ctx.fillRect(dx, dy, dx1 - dx, dy1 - dy);
    }

    /* terrain: real basemap tiles at whatever integer zoom best matches the
       current camera scale, so imagery is always native-resolution crisp
       instead of one static image stretched to arbitrary size */
    if (showBasemap && dx1 > dx && dy1 > dy) {
      const bz = Math.max(0, Math.min(19, Math.round(Math.log2(s / 256))));
      const bn = 1 << bz, btile = s / bn;
      const tx0 = Math.max(0, Math.floor(-ox / btile));
      const ty0 = Math.max(0, Math.floor(-oy / btile));
      const tx1 = Math.min(bn - 1, Math.floor((w - ox) / btile));
      const ty1 = Math.min(bn - 1, Math.floor((h - oy) / btile));
      ctx.imageSmoothingEnabled = true;
      for (let ty = ty0; ty <= ty1; ty++) {
        for (let tx = tx0; tx <= tx1; tx++) {
          const e = getTile(bz, tx, ty);
          if (e.loaded) {
            const px = ox + tx * btile, py = oy + ty * btile;
            ctx.drawImage(e.img, px, py, btile + 0.6, btile + 0.6); // +overlap hides seams
          }
        }
      }
    } else if (!showBasemap && dx1 > dx && dy1 > dy) {
      // grid-only mode: flat neutral so district tint/lines read on their
      // own, undistracted by real imagery — this is the whole point of the toggle
      ctx.fillStyle = "#12151A";
      ctx.fillRect(dx, dy, dx1 - dx, dy1 - dy);
    }

    const gridOn = tilePx >= 8;
    const D = dbgRef.current;
    D.s = s; D.tilePx = tilePx; D.gridOn = gridOn; D.cnt = 0; D.pcnt = 0; D.ptile = 0;
    D.tileOk = tileStats.current.ok; D.tileFail = tileStats.current.fail;

    // The new-player start-location picker reuses this same draw() for its
    // basemap + pan/zoom (see pickingHome below) but must never touch the
    // fine grid, preview mosaic, or vector-tile pipeline at all — that's
    // the whole performance point of a basemap-only picker. Scale bar and
    // attribution below stay unconditional either way (CARTO/OSM require
    // the attribution regardless of what else is drawn — see Hard-won
    // lessons #10 in HANDOFF.md).
    if (!pickingHome) {
    if (gridOn) {
      const tx0 = Math.max(0, Math.floor(-ox / tilePx));
      const ty0 = Math.max(0, Math.floor(-oy / tilePx));
      const tx1 = Math.min(N - 1, Math.ceil((w - ox) / tilePx));
      const ty1 = Math.min(N - 1, Math.ceil((h - oy) / tilePx));
      const cnt = Math.max(0, tx1 - tx0 + 1) * Math.max(0, ty1 - ty0 + 1);
      D.cnt = cnt;

      /* district tint: land-use class colors, cached per tile and skipped
         when the viewport holds too many tiles */
      if (cnt <= 6500) {
        for (let ty = ty0; ty <= ty1; ty++) for (let tx = tx0; tx <= tx1; tx++) {
          const px0 = ox + tx * tilePx, py0 = oy + ty * tilePx;
          // territory check FIRST, before classification — this is the
          // actual perf win (skips point-in-polygon + building-density
          // sampling entirely for locked cells), not just a visual gate.
          // Basemap/preview-grid exploration is untouched by this; only
          // the tappable fine grid is gated. g.own.length === 0 means this
          // player hasn't bought a first tile yet — buy_unowned_tile lets
          // that happen anywhere unconditionally (it's what sets home), so
          // nothing should read as fogged until after that first purchase.
          if (g.own.length > 0 && !unlockedRegions.current.has(qkOf(tx, ty).slice(0, REGION_LEN))) {
            ctx.fillStyle = hexA(C.ink, 0.62);
            ctx.fillRect(px0, py0, tilePx, tilePx);
            continue;
          }
          const cc = classifyTxy(tx, ty);
          if (cc.c === "pending") continue; // no data yet — leave the raw basemap showing, no guessed color
          if (cc.c === "water") {
            // explicit, unmistakable water treatment — never leave it as
            // blank passthrough, which reads as "uncertain" rather than
            // "not for sale"
            ctx.fillStyle = hexA(CLS.water.color, 0.3);
            ctx.fillRect(px0, py0, tilePx, tilePx);
          } else {
            ctx.fillStyle = hexA(CLS[cc.c].color, 0.34);
            ctx.fillRect(px0, py0, tilePx, tilePx);
          }
        }
      }

      /* grid as a few hundred batched lines instead of ~20k strokeRects */
      ctx.strokeStyle = hexA("#8DA0B8", 0.12);
      ctx.lineWidth = 1;
      ctx.beginPath();
      for (let tx = tx0; tx <= tx1 + 1; tx++) { const px = ox + tx * tilePx; ctx.moveTo(px, dy); ctx.lineTo(px, dy1); }
      for (let ty = ty0; ty <= ty1 + 1; ty++) { const py = oy + ty * tilePx; ctx.moveTo(dx, py); ctx.lineTo(dx1, py); }
      ctx.stroke();

      /* owned & listed tiles: iterate sparse region records, not every tile */
      for (const prefix of prefixesFor(cam.current, size.current)) {
        const reg = regions.current.get(prefix);
        if (!reg) continue;
        for (const [qk, rec] of Object.entries(reg.t)) {
          const [tx, ty] = txyOf(qk);
          if (tx < tx0 || tx > tx1 || ty < ty0 || ty > ty1) continue;
          // same territory gate as the tint loop above — without this, any
          // tile still sitting in the shared `tiles` table for this region
          // (someone else's, or an orphaned owner=null row awaiting the
          // decay sweep) would render its real ownership marker straight
          // through the fog, defeating it visually. A player's own tiles
          // are never affected — grandfathering/bootstrap guarantees their
          // own regions are always unlocked.
          if (g.own.length > 0 && rec.o !== g.uid && !unlockedRegions.current.has(regionOf(qk))) continue;
          const px = ox + tx * tilePx, py = oy + ty * tilePx;
          const mine = rec.o === g.uid;
          ctx.fillStyle = hexA(mine ? C.amber : CLS[classifyTxy(tx, ty).c].color, mine ? 0.28 : 0.3);
          ctx.fillRect(px + 1, py + 1, tilePx - 2, tilePx - 2);
          if (!mine) {
            // owned-by-someone-else marker — otherwise an enemy tile is
            // pixel-identical to unowned land of the same district until
            // you click it. Reuses the existing danger red so "bordered in
            // red" reads as "someone else's, contestable" at a glance.
            ctx.strokeStyle = hexA("#F08A8A", 0.55);
            ctx.lineWidth = 1.5;
            ctx.strokeRect(px + 1.5, py + 1.5, tilePx - 3, tilePx - 3);
            ctx.lineWidth = 1;
          }
          if (rec.r === 3) {
            const pulse = reduced ? 0.8 : 0.55 + 0.35 * Math.sin(frame.current / 12 + tx + ty);
            ctx.strokeStyle = hexA(C.amber, pulse);
            ctx.lineWidth = 2;
            ctx.strokeRect(px + 1, py + 1, tilePx - 2, tilePx - 2);
            ctx.lineWidth = 1;
          }
          if (tilePx > 13) drawBuilding(ctx, px, py, tilePx, rec.l || 0, tx * 7 + ty);
          if (rec.p) {
            ctx.fillStyle = C.amber;
            ctx.beginPath(); ctx.arc(px + tilePx - 4, py + 4, 2.6, 0, 7); ctx.fill();
          }
          if (rec.fp) {
            // flipped tile awaiting a buyer — distinct color from the amber
            // "listed by a player" dot above so the two are tellable apart
            // at a glance while panning.
            ctx.fillStyle = RAR[1].color;
            ctx.beginPath(); ctx.arc(px + tilePx - 4, py + 4, 2.6, 0, 7); ctx.fill();
          }
          // owner name label — only readable at all once tiles are large
          // enough to hold text, so gate to near the zoom ceiling (max
          // tilePx is N*64/N = 64, see zoomAt's clamp). Own tiles skip this
          // — the amber fill already says "mine" without needing a label.
          if (!mine && tilePx >= 48 && rec.n) {
            const label = rec.n.length > 10 ? rec.n.slice(0, 9) + "…" : rec.n;
            ctx.font = "9px ui-monospace, Menlo, monospace";
            ctx.textAlign = "left";
            const textW = ctx.measureText(label).width;
            const labelH = 12;
            const lx = px + 2, ly = py + tilePx - labelH - 2;
            ctx.fillStyle = hexA("#000000", 0.5);
            ctx.fillRect(lx, ly, Math.min(tilePx - 4, textW + 6), labelH);
            ctx.fillStyle = "#F0F4F8";
            ctx.fillText(label, lx + 3, ly + 9);
          }
        }
      }
    } else {
      D.pz = previewLevelFor(s); D.pcnt = 0; D.ptile = 0;

      // your deeds as glowing dots, layered on top regardless of preview state
      ctx.fillStyle = C.amber;
      let i = 0;
      for (const t of g.own) {
        if (i++ > 800) break;
        const [wx, wy] = centerOfQk(t.qk);
        const px = ox + wx * s, py = oy + wy * s;
        if (px < -4 || py < -4 || px > w + 4 || py > h + 4) continue;
        ctx.beginPath(); ctx.arc(px, py, Math.max(1.6, tilePx * 2), 0, 7); ctx.fill();
      }
    }

    /* territory outlines: a glowing outline around each unlocked region's
       actual boundary, at EVERY zoom — not just the wide preview level.
       Drawn unconditionally here (outside the gridOn/preview branches)
       so the same "wall of light" marking the edge of your unlocked
       territory is visible whether you're looking at the whole planet or
       standing right on the boundary at deed-grid zoom. A region is a
       REGION_LEN=8 quadkey tile, i.e. already a plain rectangle, so this
       needs no polygon geometry — just a coordinate transform. */
    {
      const REGION_N = 1 << REGION_LEN;
      ctx.lineWidth = 2;
      ctx.strokeStyle = C.amber;
      ctx.shadowColor = C.amber;
      ctx.shadowBlur = 10;
      for (const region of unlockedRegions.current) {
        const [rtx, rty] = txyOf(region);
        const rpx0 = ox + (rtx / REGION_N) * s, rpy0 = oy + (rty / REGION_N) * s;
        const rpx1 = ox + ((rtx + 1) / REGION_N) * s, rpy1 = oy + ((rty + 1) / REGION_N) * s;
        if (rpx1 < 0 || rpy1 < 0 || rpx0 > w || rpy0 > h) continue; // off-screen
        ctx.strokeRect(rpx0, rpy0, rpx1 - rpx0, rpy1 - rpy0);
      }
      // canvas shadow/lineWidth state persists across draw calls — reset or
      // it silently leaks onto whatever's drawn next this frame (the
      // selection outline right below explicitly sets its own, but don't
      // rely on that — reset here regardless)
      ctx.shadowBlur = 0;
      ctx.lineWidth = 1;
    }

    if (sel) {
      const [tx, ty] = txyOf(sel);
      const px = ox + tx * tilePx, py = oy + ty * tilePx;
      ctx.strokeStyle = C.amber; ctx.lineWidth = 2;
      ctx.strokeRect(px + 0.5, py + 0.5, tilePx - 1, tilePx - 1);
      ctx.lineWidth = 1;
    }
    } // !pickingHome

    /* scale bar (real scale at screen-centre latitude) */
    const midWy = (h / 2 - oy) / s;
    if (midWy > 0 && midWy < 1) {
      const lat = wyToLat(midWy);
      const mpp = (40075016 * Math.cos((lat * Math.PI) / 180)) / s;
      let target = mpp * 110;
      const pow = Math.pow(10, Math.floor(Math.log10(target)));
      const nice = [1, 2, 5, 10].map((k) => k * pow).reduce((a, b) => (Math.abs(b - target) < Math.abs(a - target) ? b : a));
      const barPx = nice / mpp;
      const label = nice >= 1000 ? (nice / 1000).toLocaleString() + " km" : Math.round(nice) + " m";
      const bx = 14, by = h - 16;
      ctx.strokeStyle = C.text; ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.moveTo(bx, by - 4); ctx.lineTo(bx, by); ctx.lineTo(bx + barPx, by); ctx.lineTo(bx + barPx, by - 4);
      ctx.stroke();
      ctx.fillStyle = C.text;
      ctx.font = "10px ui-monospace, Menlo, monospace";
      ctx.fillText(label, bx + 4, by - 6);
      ctx.lineWidth = 1;
    }

    if (showBasemap) {
      ctx.textAlign = "right";
      ctx.font = "9px ui-monospace, Menlo, monospace";
      ctx.fillStyle = hexA(C.dim, 0.7);
      ctx.fillText("\u00A9 OpenStreetMap \u00A9 CARTO", w - 8, h - 6);
      ctx.textAlign = "left";
    }
  }, [g, sel, classifyTxy, reduced, getTile, showBasemap, pickingHome]);

  useEffect(() => {
    if (!ready || tab !== "map") return;
    let raf, last = 0, acc = 0, maxd = 0, n = 0, rep = performance.now();
    const loop = (t) => {
      if (t - last > 33) {
        last = t; frame.current++;
        const t0 = performance.now();
        draw();
        const dms = performance.now() - t0;
        acc += dms; n++; if (dms > maxd) maxd = dms;
        if (t0 - rep > 500) {
          const D = dbgRef.current;
          D.fps = Math.round((n * 1000) / (t0 - rep));
          D.avg = +(acc / Math.max(1, n)).toFixed(1);
          D.max = +maxd.toFixed(1);
          acc = 0; maxd = 0; n = 0; rep = t0;
        }
      }
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [ready, tab, draw]);

  /* region sync for viewport */
  useEffect(() => {
    if (!ready) return;
    const iv = setInterval(() => {
      if (tab !== "map") return;
      if (cam.current.s / N < 8) return;
      for (const q of prefixesFor(cam.current, size.current)) ensureRegion(q, false);
    }, 1200);
    return () => clearInterval(iv);
  }, [ready, tab, ensureRegion]);

  /* keep vector tiles ahead of the camera during continuous pan/zoom —
     eager jumps (flyTo, tap-to-zoom, +/-) also call this directly for an
     immediate kick instead of waiting for the next tick */
  useEffect(() => {
    if (!ready) return;
    const iv = setInterval(() => { if (tab === "map") prefetchVectorTiles(); }, 180);
    return () => clearInterval(iv);
  }, [ready, tab, prefetchVectorTiles]);

  /* pointer input */
  const zoomAt = (mx, my, ns) => {
    const c = cam.current;
    const { w, h } = size.current;
    ns = Math.max(Math.min(w, h * 2) * 0.7, Math.min(N * 64, ns));
    const k = ns / c.s;
    cam.current = { s: ns, x: mx - (mx - c.x) * k, y: my - (my - c.y) * k, init: true };
  };
  const onDown = (e) => {
    const now = performance.now();
    for (const [id, p] of ptrs.current) if (now - p.t > 4000) ptrs.current.delete(id); // prune ghost pointers
    const cv = canvasRef.current;
    try { cv.setPointerCapture(e.pointerId); } catch {}
    const r = cv.getBoundingClientRect();
    ptrs.current.set(e.pointerId, { x: e.clientX - r.left, y: e.clientY - r.top, t: now });
    logEvt("down x" + ptrs.current.size);
    const pts = [...ptrs.current.values()];
    if (pts.length === 1) gesture.current = { kind: "pan", sx: pts[0].x, sy: pts[0].y, ox: cam.current.x, oy: cam.current.y, moved: false };
    else if (pts.length === 2) {
      const d = Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y);
      gesture.current = { kind: "pinch", d0: Math.max(d, 1), s0: cam.current.s, moved: true };
    } else gesture.current = null;
  };
  const onMove = (e) => {
    if (!ptrs.current.has(e.pointerId)) return;
    const r = canvasRef.current.getBoundingClientRect();
    ptrs.current.set(e.pointerId, { x: e.clientX - r.left, y: e.clientY - r.top, t: performance.now() });
    logEvt("move");
    const gst = gesture.current;
    const pts = [...ptrs.current.values()];
    if (!gst) return;
    if (gst.kind === "pan" && pts.length === 1) {
      const dx = pts[0].x - gst.sx, dy = pts[0].y - gst.sy;
      if (Math.abs(dx) + Math.abs(dy) > 7) gst.moved = true;
      if (gst.moved) { cam.current.x = gst.ox + dx; cam.current.y = gst.oy + dy; }
    } else if (gst.kind === "pinch" && pts.length === 2) {
      const d = Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y);
      const mx = (pts[0].x + pts[1].x) / 2, my = (pts[0].y + pts[1].y) / 2;
      zoomAt(mx, my, gst.s0 * (d / gst.d0));
    }
  };
  const onLost = (e) => {
    ptrs.current.delete(e.pointerId);
    if (ptrs.current.size === 0) gesture.current = null;
    logEvt("lostcapture");
  };
  const onUp = (e) => {
    logEvt("up");
    const gst = gesture.current;
    const wasTap = gst && gst.kind === "pan" && !gst.moved && ptrs.current.size === 1;
    const pt = ptrs.current.get(e.pointerId);
    ptrs.current.delete(e.pointerId);
    if (wasTap && pt) {
      const { s, x: ox, y: oy } = cam.current;
      const tilePx = s / N;
      if (tilePx >= 8) {
        const tx = Math.floor((pt.x - ox) / tilePx), ty = Math.floor((pt.y - oy) / tilePx);
        if (tx >= 0 && ty >= 0 && tx < N && ty < N) {
          const qk = qkOf(tx, ty);
          setSel(qk); setRoll(null);
          ensureRegion(regionOf(qk), false);
        } else setSel(null);
      } else {
        zoomAt(pt.x, pt.y, cam.current.s * 3.2);
        prefetchVectorTiles();
      }
    }
    if (ptrs.current.size === 0) gesture.current = null;
  };
  const zoomAtRef = useRef(null);
  zoomAtRef.current = zoomAt;

  useEffect(() => {
    const cv = canvasRef.current;
    if (!cv) return;
    const onW = (e) => {
      e.preventDefault(); // keep ctrl+wheel / trackpad pinch from zooming the page
      logEvt(e.ctrlKey ? "pinch-wheel" : "wheel");
      const r = cv.getBoundingClientRect();
      const f = e.ctrlKey ? Math.exp(-e.deltaY * 0.01) : e.deltaY < 0 ? 1.25 : 0.8;
      zoomAtRef.current(e.clientX - r.left, e.clientY - r.top, cam.current.s * f);
    };
    cv.addEventListener("wheel", onW, { passive: false });
    return () => cv.removeEventListener("wheel", onW);
  }, [ready]);

  useEffect(() => {
    const onVis = () => { if (document.hidden) { ptrs.current.clear(); gesture.current = null; } };
    document.addEventListener("visibilitychange", onVis);
    return () => document.removeEventListener("visibilitychange", onVis);
  }, []);

  // Resync the instant this tab/device is looked at again, instead of
  // waiting for the next ~20s interval tick (which browsers throttle hard
  // in a backgrounded tab anyway). This is what actually fixes "looked
  // stale/mismatched after switching devices" — the server was always
  // right, the display just hadn't caught up yet. visibilitychange covers
  // phones/tab-switches; focus covers alt-tabbing between two desktop
  // windows that are both technically "visible". Both can fire for the
  // same switch, so they're deduped against a short cooldown.
  useEffect(() => {
    if (!ready) return;
    let last = 0;
    const resync = () => {
      const now = Date.now();
      if (now - last < 2000) return;
      last = now;
      syncRent();
      refreshOwnedTiles();
      collectBank();
      collectBattles();
      if (tab === "map") for (const q of prefixesFor(cam.current, size.current)) ensureRegion(q, true);
    };
    const onVis = () => { if (!document.hidden) resync(); };
    document.addEventListener("visibilitychange", onVis);
    window.addEventListener("focus", resync);
    return () => {
      document.removeEventListener("visibilitychange", onVis);
      window.removeEventListener("focus", resync);
    };
  }, [ready, tab, syncRent, refreshOwnedTiles, collectBank, collectBattles, ensureRegion]);

  useEffect(() => {
    const onE = (e) => {
      const D = dbgRef.current;
      D.errs = [...D.errs.slice(-2), String((e && (e.reason || e.message || e.error)) || "error").slice(0, 140)];
      setDbg(true);
    };
    window.addEventListener("error", onE);
    window.addEventListener("unhandledrejection", onE);
    return () => { window.removeEventListener("error", onE); window.removeEventListener("unhandledrejection", onE); };
  }, []);

  useEffect(() => {
    if (typeof PerformanceObserver === "undefined") return;
    try {
      const po = new PerformanceObserver((l) => {
        for (const en of l.getEntries()) {
          const D = dbgRef.current;
          D.long++;
          if (en.duration > D.longMax) D.longMax = Math.round(en.duration);
        }
      });
      po.observe({ entryTypes: ["longtask"] });
      return () => po.disconnect();
    } catch {}
  }, []);

  const copyDbg = () => {
    const D = dbgRef.current;
    const data = JSON.stringify({
      buildTag: BUILD_TAG,
      ua: navigator.userAgent, dpr: size.current.dpr,
      view: { w: size.current.w, h: size.current.h }, cam: cam.current,
      fps: D.fps, drawAvgMs: D.avg, drawMaxMs: D.max, tilePx: D.tilePx, tiles: D.cnt, gridOn: D.gridOn,
      previewZ: D.pz, previewPx: D.ptile, previewCells: D.pcnt, basemapOk: D.tileOk, basemapFail: D.tileFail,
      protomapsKeyConfigured: !!PROTOMAPS_KEY, vectorCached: vtCache.current.size, vectorPending: vtPending.current.size, vectorWorkerActive: !!vtWorkerRef.current, vectorWorkerReady: vtWorkerReady.current, vectorWorkerError: vtWorkerError.current,
      vtTuning: vtTuning.current, connectionEffectiveType: typeof navigator !== "undefined" && navigator.connection ? navigator.connection.effectiveType : null, connectionSaveData: typeof navigator !== "undefined" && navigator.connection ? !!navigator.connection.saveData : null,
      pointers: ptrs.current.size, gesture: gesture.current && gesture.current.kind,
      supabaseConfigured: MULTIPLAYER, regions: regions.current.size, clsCache: clsCache.current.size,
      longtasks: D.long, longtaskMaxMs: D.longMax, errors: D.errs, lastInput: D.lastEvt,
      // full per-tile breakdown — this is what actually shows whether a
      // tile's district/rent is wrong, and if so what cls it's stuck at
      owned: g.own.length, rps: g.rps, energy: energyNow(g), energyDailyCap: statusFor(g.peakNetWorth).cap, energySecsToReset: energySecsToReset(),
      status: statusFor(g.peakNetWorth).name, peakNetWorth: g.peakNetWorth,
      ownTiles: g.own.map((t) => ({ qk: t.qk, cls: t.cls, rarity: t.r, level: t.l, rps: CLS[t.cls] ? rentOf(t) : "UNKNOWN_CLS" })),
    }, null, 1);
    try { navigator.clipboard.writeText(data); toast("Diagnostics copied"); }
    catch { window.prompt("Copy diagnostics:", data); }
  };

  /* ── render ── */
  if (!ready) {
    return (
      <div className="flex h-screen w-full items-center justify-center" style={{ background: C.ink, color: C.dim, ...mono }}>
        Unrolling the planet…
      </div>
    );
  }

  const boostLeft = Math.max(0, g.boostUntil - Date.now());
  const boostOn = boostLeft > 0;
  const boostCooldownLeft = Math.max(0, (g.boostReadyAt || 0) - Date.now());
  const boostOnCooldown = !boostOn && boostCooldownLeft > 0;
  const mmss = (ms) => { const s = Math.ceil(ms / 1000); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`; };
  const hm = (secs) => { const h = Math.floor(secs / 3600), m = Math.floor((secs % 3600) / 60); return h > 0 ? `${h}h ${m}m` : `${m}m`; };
  const myStatus = statusFor(g.peakNetWorth);

  const selRec = sel ? recOf(sel) : undefined;
  const selDbg = dbg && sel ? classify(sel) : null;
  const selMine = sel ? ownMap.current.get(sel) : undefined;
  const selInfo = sel ? classify(sel) : null;
  const selCls = selInfo ? selInfo.c : null;
  // grandfathering/bootstrap guarantee any tile a player actually owns is
  // always in an unlocked region, so this only ever gates unclaimed land.
  // Before a player's first-ever purchase, buy_unowned_tile allows it
  // anywhere unconditionally (that purchase is what sets home) — mirror
  // that exemption here so a brand-new player sees their first claim as a
  // normal buy, not an "unlock this region for ₲1000" prompt.
  const selLocked = sel && g.own.length > 0 ? !unlockedRegions.current.has(regionOf(sel)) : false;
  const tilePxNow = cam.current.s / N;

  // Only actually filters/sorts when the Assets tab is showing — skipped
  // otherwise so a 50+ tile portfolio doesn't pay this cost 4x/sec on the
  // 250ms economy tick while the player is looking at the map instead.
  const assetsFiltered = tab !== "assets" ? g.own : (() => {
    const q = assetQuery.trim().toLowerCase();
    let list = g.own;
    if (assetClsFilter !== "all") list = list.filter((t) => t.cls === assetClsFilter);
    if (assetRarityFilter !== -1) list = list.filter((t) => t.r === assetRarityFilter);
    if (q) {
      list = list.filter((t) => {
        const city = classify(t.qk).n || "";
        return (CLS[t.cls]?.name || "").toLowerCase().includes(q)
          || city.toLowerCase().includes(q)
          || coordLabel(t.qk).toLowerCase().includes(q);
      });
    }
    const sorted = list.slice();
    if (assetSort === "rent") sorted.sort((a, b) => rentOf(b) - rentOf(a));
    else if (assetSort === "rent-asc") sorted.sort((a, b) => rentOf(a) - rentOf(b));
    else if (assetSort === "level") sorted.sort((a, b) => b.l - a.l);
    else if (assetSort === "rarity") sorted.sort((a, b) => b.r - a.r);
    else if (assetSort === "district") sorted.sort((a, b) => (CLS[a.cls]?.name || "").localeCompare(CLS[b.cls]?.name || ""));
    return sorted;
  })();
  const assetsUpgradable = tab !== "assets" ? [] : assetsFiltered.filter((t) => t.l < MAX_LVL);

  // Reads whatever world coordinate is currently centered under the fixed
  // pin (the map pans underneath it, not the other way around — same
  // pattern as most map-based location pickers), resolves REAL
  // classification for just that one spot (prefetch is fully off during
  // picking — see pickingHome gates elsewhere — so nothing is cached yet;
  // this is one deliberate fetch at the moment of commitment, not a return
  // to scanning the viewport), then hands off to the existing buyUnowned
  // flow so it's a real purchase with the normal roll/rarity animation,
  // not a separate purchase path to keep in sync.
  const confirmStartLocation = async () => {
    const { x, y, s } = cam.current;
    const { w, h } = size.current;
    if (!w || !h || s <= 0) return;
    const wx = (w / 2 - x) / s, wy = (h / 2 - y) / s;
    const tx = Math.max(0, Math.min(N - 1, Math.floor(wx * N)));
    const ty = Math.max(0, Math.min(N - 1, Math.floor(wy * N)));
    const qk = qkOf(tx, ty);

    setHomeBusy(true); setHomeErr("");
    const vn = 1 << VECTOR_Z;
    getVectorTile(VECTOR_Z, Math.floor(wx * vn), Math.floor(wy * vn));
    let cc = classifyTxy(tx, ty);
    for (let i = 0; i < 20 && cc.c === "pending"; i++) {
      await new Promise((r) => setTimeout(r, 150));
      cc = classifyTxy(tx, ty);
    }
    if (cc.c === "pending") {
      setHomeBusy(false);
      setHomeErr("Couldn't verify this spot — check your connection and try again.");
      return;
    }
    if (CLS[cc.c].sale === false) {
      setHomeBusy(false);
      setHomeErr("That's open water — pan to a spot on land and try again.");
      return;
    }

    const lat = wyToLat(wy), lon = wx * 360 - 180;
    setPickingHome(false);
    setSel(qk);
    flyTo(lat, lon, 16);
    buyUnowned(qk);
    setHomeBusy(false);
  };

  if (pickingHome) {
    return (
      <div className="relative flex h-screen w-full flex-col overflow-hidden select-none" style={{ background: C.ink, color: C.text }}>
        <div className="relative z-10 px-4 pb-3 pt-4 text-center" style={{ borderBottom: `1px solid ${C.hair}`, background: C.panel, backgroundImage: `linear-gradient(180deg, #16233a 0%, ${C.panel} 100%)`, boxShadow: C.shadowSm }}>
          <Eyebrow>Welcome, {g.name}</Eyebrow>
          <div className="mt-1 text-base font-bold" style={display}>Pick your starting area</div>
          <div className="pt10 mx-auto mt-1 max-w-xs leading-relaxed" style={{ ...mono, color: C.dim }}>
            Pan the map to find your home turf, then drop your pin — that's the tile you'll claim first. You can explore and claim more anywhere in the world once you're in.
          </div>
        </div>
        <div className="relative flex-1 overflow-hidden">
          <div ref={wrapRef} className="absolute inset-0">
            <canvas
              ref={canvasRef}
              className="h-full w-full touch-none"
              onPointerDown={onDown} onPointerMove={onMove} onPointerUp={onUp} onPointerCancel={onUp} onLostPointerCapture={onLost}
            />
            {/* fixed center pin — you pan the map under it, not the pin over the map */}
            <div className="pointer-events-none absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-full">
              <svg width="30" height="40" viewBox="0 0 30 40" style={{ filter: "drop-shadow(0 2px 6px rgba(0,0,0,0.5))" }}>
                <path d="M15 0C6.7 0 0 6.7 0 15c0 10.5 15 25 15 25s15-14.5 15-25C30 6.7 23.3 0 15 0z" fill={C.amber} />
                <circle cx="15" cy="15" r="6" fill={C.ink} />
              </svg>
            </div>
            <div className="absolute right-3 top-3 flex flex-col overflow-hidden rounded-2xl"
              style={{ background: `${C.panel}d9`, border: `1px solid ${C.hairLit}`, boxShadow: C.shadowMd, ...blur(14) }}>
              {[
                [IconPlus, () => zoomAt(size.current.w / 2, size.current.h / 2, cam.current.s * 1.6), "Zoom in"],
                [IconMinus, () => zoomAt(size.current.w / 2, size.current.h / 2, cam.current.s * 0.62), "Zoom out"],
                [IconGlobe, fitWorld, "Fit whole world"],
              ].map(([IconC, fn, label], i) => (
                <button key={label} onClick={fn} title={label} aria-label={label}
                  className="flex h-10 w-10 items-center justify-center transition-colors hover:bg-white/[0.06] active:scale-90 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-[-2px]"
                  style={{ color: C.text, borderTop: i ? `1px solid ${C.hair}` : "none", outlineColor: C.amber }}>
                  <IconC size={16} />
                </button>
              ))}
            </div>
          </div>
        </div>
        <div className="relative z-10 p-4" style={{ borderTop: `1px solid ${C.hair}`, background: C.panel }}>
          {homeErr && <div className="pt10 mb-2 text-center" style={{ ...mono, color: "#F08A8A" }}>{homeErr}</div>}
          <Btn full onClick={confirmStartLocation} disabled={homeBusy}>{homeBusy ? "Surveying…" : "Claim this spot"}</Btn>
        </div>
      </div>
    );
  }

  return (
    <div className="relative flex h-screen w-full flex-col overflow-hidden select-none" style={{ background: C.ink, color: C.text }}>
      <style>{`.pt9{font-size:9px}.pt10{font-size:10px}.pt11{font-size:11px}.trk{letter-spacing:.22em}`}</style>

      {/* ticker */}
      <div className="relative z-10 flex items-center justify-between gap-3 px-4 pb-2.5 pt-3"
        style={{ borderBottom: `1px solid ${C.hair}`, background: C.panel, backgroundImage: `linear-gradient(180deg, #16233a 0%, ${C.panel} 100%)`, boxShadow: C.shadowSm }}>
        <div className="min-w-0">
          <button onClick={() => { save(); onExit(); }} className="pt9 trk flex items-center gap-1 uppercase font-semibold focus-visible:outline focus-visible:outline-2" style={{ ...display, color: C.dim, outlineColor: C.amber }}>
            ‹ Plot Twist · World Deed
          </button>
          <div className="flex items-baseline gap-2">
            <div className="text-2xl font-bold" style={{ ...mono, color: C.amber, fontVariantNumeric: "tabular-nums", textShadow: `0 0 18px ${C.glow}` }}>₲{fmt(g.bal)}</div>
            <div className="text-xs" style={{ ...mono, color: C.dim }}>+{fmt1(g.rps * (boostOn ? 2 : 1))}/s{boostOn ? " ⚡" : ""}</div>
          </div>
          <div className="mt-0.5 flex items-center gap-1.5">
            <Chip color={C.amber}>{myStatus.name}</Chip>
            {g.devMode && <Chip color="#F08A8A">DEV</Chip>}
            <span className="pt10 font-bold" style={{ ...mono, color: energyNow(g) > 0 ? C.amber : "#F08A8A", fontVariantNumeric: "tabular-nums" }} title="Energy — spent claiming unowned land, resets once per day">
              ⚡{energyNow(g)}/{myStatus.cap} today
            </span>
            {energyNow(g) < myStatus.cap && (
              <span className="pt10" style={{ ...mono, color: C.dim }}>resets in {hm(energySecsToReset())}</span>
            )}
            <span className="pt10 font-bold" style={{ ...mono, color: (g.attacksSent || 0) < ATTACK_DAILY_CAP ? C.text : "#F08A8A", fontVariantNumeric: "tabular-nums" }} title="Attacks launched — resets once per day">
              ⚔{Math.max(0, ATTACK_DAILY_CAP - (g.attacksSent || 0))}/{ATTACK_DAILY_CAP} today
            </span>
            <span className="pt10 font-bold" style={{ ...mono, color: C.text, fontVariantNumeric: "tabular-nums" }} title="Tiles currently under construction">
              🔨{g.own.filter((t) => t.bu).length}/{myStatus.slots} building
            </span>
          </div>
        </div>
        {boostOn ? (
          <div className="pt-anim-glowPulse rounded-xl px-3 py-2 text-xs font-bold" style={{ ...mono, color: C.amber, border: `1px solid ${C.amber}66`, background: `${C.amber}14`, fontVariantNumeric: "tabular-nums" }}>
            2× {mmss(boostLeft)}
          </div>
        ) : boostOnCooldown ? (
          <div className="rounded-xl px-3 py-2 text-xs font-bold" style={{ ...mono, color: C.dim, border: `1px solid ${C.hair}`, fontVariantNumeric: "tabular-nums" }} title="Boost recharges every 30 minutes">
            ⚡ {mmss(boostCooldownLeft)}
          </div>
        ) : (
          <Btn small onClick={() => setModal({ kind: "ad", ad: ADS[(Math.random() * ADS.length) | 0] })}>⚡ 2× boost</Btn>
        )}
      </div>

      {/* body */}
      <div className="relative flex-1 overflow-hidden">
        <div ref={wrapRef} className={`absolute inset-0 ${tab === "map" ? "" : "hidden"}`}>
          <canvas
            ref={canvasRef}
            className="h-full w-full touch-none"
            onPointerDown={onDown} onPointerMove={onMove} onPointerUp={onUp} onPointerCancel={onUp} onLostPointerCapture={onLost}
          />
          {/* controls */}
          <div className="absolute right-3 top-3 flex flex-col overflow-hidden rounded-2xl"
            style={{ background: `${C.panel}d9`, border: `1px solid ${C.hairLit}`, boxShadow: C.shadowMd, ...blur(14) }}>
            {[
              [IconPlus, () => { zoomAt(size.current.w / 2, size.current.h / 2, cam.current.s * 1.6); prefetchVectorTiles(); }, "Zoom in"],
              [IconMinus, () => { zoomAt(size.current.w / 2, size.current.h / 2, cam.current.s * 0.62); prefetchVectorTiles(); }, "Zoom out"],
              [IconGlobe, fitWorld, "Fit whole world"],
              [IconPlane, () => setCities((c) => !c), "Search cities"],
              [IconBug, () => setDbg((v) => !v), "Debug overlay"],
            ].map(([IconC, fn, label], i) => (
              <button key={label} onClick={fn} title={label} aria-label={label}
                className="flex h-10 w-10 items-center justify-center transition-colors hover:bg-white/[0.06] active:scale-90 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-[-2px]"
                style={{ color: C.text, borderTop: i ? `1px solid ${C.hair}` : "none", outlineColor: C.amber }}>
                <IconC size={16} />
              </button>
            ))}
            <button
              onClick={() => setShowBasemap((v) => !v)}
              title={showBasemap ? "Hide basemap — grid only" : "Show basemap"}
              aria-label="Toggle basemap"
              className="flex h-10 w-10 items-center justify-center transition-colors active:scale-90 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-[-2px]"
              style={{
                color: showBasemap ? C.text : "#2B1B03",
                backgroundImage: showBasemap ? "none" : C.amberGrad,
                borderTop: `1px solid ${showBasemap ? C.hair : "transparent"}`,
                outlineColor: C.amber,
              }}
            >
              {showBasemap ? <IconLayers size={16} /> : <IconGrid size={16} />}
            </button>
          </div>
          {cities && (
            <div className="pt-anim-popIn absolute right-14 top-3 w-48 rounded-2xl p-2" style={{ background: `${C.panel}f2`, border: `1px solid ${C.hairLit}`, boxShadow: C.shadowMd, ...blur(14) }}>
              <input
                autoFocus
                value={citySearch}
                onChange={(e) => setCitySearch(e.target.value)}
                placeholder="Search cities…"
                className="mb-1 w-full rounded-lg px-2 py-1.5 text-xs focus-visible:outline focus-visible:outline-2"
                style={{ ...display, ...inputSty }}
              />
              <div className="max-h-64 overflow-y-auto">
                {TOP_CITIES.filter(([name]) => name.toLowerCase().includes(citySearch.trim().toLowerCase())).slice(0, 60).map(([name, lat, lon]) => (
                  <button key={name} onClick={() => flyTo(lat, lon)} className="block w-full rounded-lg px-2 py-1.5 text-left text-xs transition-colors hover:bg-white/[0.06] focus-visible:outline focus-visible:outline-2"
                    style={{ ...display, color: C.text, outlineColor: C.amber }}>
                    {name}
                  </button>
                ))}
              </div>
            </div>
          )}
          <div className="absolute left-3 top-3 rounded-2xl px-2.5 py-2" style={{ background: `${C.panel}d9`, border: `1px solid ${C.hairLit}`, boxShadow: C.shadowSm, ...blur(14) }}>
            {LEGEND.map((k) => (
              <div key={k} className="pt9 flex items-center gap-1.5 py-0.5 font-medium" style={{ ...display, color: C.dim }}>
                <span className="h-2 w-2 rounded-full" style={{ background: CLS[k].color, boxShadow: `0 0 6px ${CLS[k].color}99` }} />
                {CLS[k].name}
              </div>
            ))}
          </div>

          {syncing && (
            <div className="pt-anim-fadeIn pt10 absolute left-32 top-3 rounded-full px-2.5 py-1 font-medium" style={{ ...display, color: C.dim, background: `${C.panel}e6`, border: `1px solid ${C.hair}`, ...blur(10) }}>
              syncing deeds…
            </div>
          )}
          {tilePxNow < 8 && !sel && (
            <div className="pt10 pointer-events-none absolute inset-x-0 top-3 text-center font-medium" style={{ ...display, color: C.dim }}>
              {(() => {
                const { s: cs } = cam.current;
                const { w: vw, h: vh } = size.current;
                const pz = previewLevelFor(cs);
                const ptile = cs / (1 << pz);
                const cnt = (vw / ptile) * (vh / ptile);
                return cnt <= 8000 ? "tap a district to zoom in · deed grid appears up close" : "zoom in to see districts · tap to zoom";
              })()}
            </div>
          )}

          {dbg && (() => { const D = dbgRef.current; return (
            <div className="pt-anim-popIn pt10 absolute bottom-8 left-3 rounded-xl p-2 leading-relaxed" style={{ ...mono, color: C.text, background: `${C.panel}f5`, border: `1px solid ${C.hairLit}`, boxShadow: C.shadowMd, maxWidth: 240, ...blur(10) }}>
              <div>build {BUILD_TAG}</div>
              <div>
                own {g.own.length} · rps {g.rps.toFixed(3)}
                {g.own.some((t) => !CLS[t.cls] || CLS[t.cls].rps === 0) && (
                  <span style={{ color: "#F08A8A" }}> · {g.own.filter((t) => !CLS[t.cls] || CLS[t.cls].rps === 0).length} zero-rent!</span>
                )}
              </div>
              <div>energy {energyNow(g)}/{myStatus.cap} today ({myStatus.name}) · resets in {hm(energySecsToReset())}</div>
              <div>builds: {g.own.filter((t) => t.bu).length}/{myStatus.slots} slots · attacks {g.attacksSent || 0}/{ATTACK_DAILY_CAP} sent</div>
              <div>territory: {unlockedRegions.current.size} region(s){homeRegionRef.current ? ` · home ${homeRegionRef.current}` : ""}{sel ? ` · sel ${regionOf(sel)} locked=${String(selLocked)}` : ""}</div>
              <div>fps {D.fps} · draw {D.avg}ms · max {D.max}ms</div>
              <div>tilePx {D.tilePx.toFixed(2)} · grid {String(D.gridOn)} · tiles {D.cnt}</div>
              <div>preview z{D.pz || 0} · {D.ptile.toFixed(1)}px · cells {D.pcnt}</div>
              <div>basemap tiles ok {D.tileOk} fail {D.tileFail}</div>
              <div>vector: cached {vtCache.current.size} pending {vtPending.current.size} worker {vtWorkerRef.current ? "on" : "off"} ready {String(vtWorkerReady.current)}</div>
              {vtWorkerError.current && <div style={{ color: "#F0784E" }}>worker error: {vtWorkerError.current}</div>}
              <div>tuning: max {vtTuning.current.maxInflight} margin {vtTuning.current.margin} cap {vtTuning.current.cap}{typeof navigator !== "undefined" && navigator.connection ? ` (${navigator.connection.effectiveType || "?"}${navigator.connection.saveData ? " saveData" : ""})` : " (no Network Info API)"}</div>
              {!PROTOMAPS_KEY && <div style={{ color: "#F0784E" }}>no Protomaps key configured — using fallback classifier</div>}
              {!MULTIPLAYER && <div style={{ color: "#F0784E" }}>no Supabase config — single-player only</div>}
              {selDbg && (
                <div style={{ color: selDbg.src === "vector" ? C.amber : C.dim }}>
                  sel: {selDbg.c} via {selDbg.src}{selDbg.dbg ? ` · landuse ${selDbg.dbg.landuseKind || "none"} bldg ${selDbg.dbg.buildingFrac ?? "-"} (${selDbg.dbg.hits ?? "-"}/9)` : ""}
                </div>
              )}
              <div>s {Math.round(D.s).toLocaleString()} · dpr {size.current.dpr}</div>
              <div>pointers {ptrs.current.size} · gesture {gesture.current ? gesture.current.kind : "-"}</div>
              <div>regions {regions.current.size} · cache {clsCache.current.size}</div>
              <div>longtasks {D.long} · worst {D.longMax}ms</div>
              <div>last input: {D.lastEvt}</div>
              {D.errs.length > 0 && <div style={{ color: "#F08A8A" }}>ERR: {D.errs[D.errs.length - 1]}</div>}
              <button onClick={copyDbg} className="mt-1 rounded px-2 py-1 font-bold focus-visible:outline focus-visible:outline-2" style={{ ...mono, background: C.amber, color: "#221A05", outlineColor: C.amber }}>
                copy diagnostics
              </button>
            </div>
          ); })()}

          {/* tile sheet */}
          {sel && (
            <div className="pt-anim-sheetUp absolute inset-x-0 bottom-0 rounded-t-2xl p-4"
              style={{ background: `${C.panel}f7`, backgroundImage: C.panelGrad, borderTop: `1px solid ${C.hairLit}`, boxShadow: C.shadowLg, ...blur(16) }}>
              <div aria-hidden className="mx-auto mb-3 h-1 w-9 rounded-full" style={{ background: C.hairLit }} />
              <div className="mb-2 flex items-start justify-between">
                <div>
                  <Eyebrow>{CLS[selCls].name}{selInfo.n ? ` · near ${selInfo.n} (${selInfo.d} km)` : selCls !== "water" && selCls !== "pending" ? " · remote" : ""}</Eyebrow>
                  <div className="text-lg font-bold" style={mono}>{coordLabel(sel)}</div>
                  <div className="pt10" style={{ ...mono, color: C.dim }}>tile #{sel.slice(-6)} · ~306 m square</div>
                </div>
                <button onClick={() => { setSel(null); setRoll(null); }} className="px-2 text-lg focus-visible:outline focus-visible:outline-2" style={{ color: C.dim, outlineColor: C.amber }}>✕</button>
              </div>

              {roll && roll.qk === sel && roll.phase === "spin" && (
                <div className="flex items-center justify-center gap-2.5 py-3 text-sm font-bold" style={{ ...display, color: C.amber }}>
                  <span className="pt-anim-spin inline-block h-3.5 w-3.5 rounded-full" style={{ border: `2px solid ${C.amber}44`, borderTopColor: C.amber }} />
                  Recording deed… rolling rarity
                </div>
              )}
              {roll && roll.qk === sel && roll.phase === "done" && (
                <div className="pt-anim-popIn py-2 text-center">
                  <div className="text-2xl font-bold" style={{ ...display, color: RAR[roll.r].color, textShadow: `0 0 22px ${RAR[roll.r].color}88` }}>{RAR[roll.r].name}!</div>
                  <div className="mt-1 text-xs" style={{ color: C.dim }}>Rent ×{RAR[roll.r].m} on this tile, forever.</div>
                </div>
              )}
              {roll && roll.qk === sel && roll.phase === "battle" && (
                <div className="flex items-center justify-center gap-2.5 py-3 text-sm font-bold" style={{ ...display, color: C.amber }}>
                  <span className="pt-anim-spin inline-block h-3.5 w-3.5 rounded-full" style={{ border: `2px solid ${C.amber}44`, borderTopColor: C.amber }} />
                  Battle resolving…
                </div>
              )}
              {roll && roll.qk === sel && roll.phase === "battle-done" && (
                <div className="pt-anim-popIn py-2 text-center">
                  <div className="text-2xl font-bold" style={{ ...display, color: roll.won ? C.amber : "#F08A8A", textShadow: `0 0 22px ${(roll.won ? C.amber : "#F08A8A")}88` }}>
                    {roll.won ? "Victory!" : "Defeated"}
                  </div>
                  <div className="mt-1 text-xs" style={{ color: C.dim }}>
                    {roll.won ? "Tile captured — the building was razed, but it's yours now." : "Repelled — their defenses held. Nothing lost on their side."}
                  </div>
                  <div className="mt-1 pt10" style={{ ...mono, color: C.dim }}>Your power {roll.attPower.toFixed(2)} vs their {roll.defPower.toFixed(2)}</div>
                </div>
              )}

              {selLocked && !(roll && roll.qk === sel) && (
                <div>
                  <div className="mb-3 text-sm leading-relaxed" style={{ color: C.dim }}>
                    This region hasn't been scouted yet — unlock it to claim land here.
                  </div>
                  <Btn full onClick={() => unlockRegion(sel)} disabled={g.bal < nextUnlockCost()}>
                    {g.bal < nextUnlockCost() ? "Not enough ₲" : `Unlock region — ₲${fmt(nextUnlockCost())}`}
                  </Btn>
                </div>
              )}

              {!selLocked && !selRec && selCls === "water" && (
                <div className="pb-1 text-sm" style={{ color: C.dim }}>
                  International waters — not for sale. The fish hold the deed.
                </div>
              )}

              {!selLocked && !selRec && selCls === "pending" && (
                <div className="pb-1 text-sm" style={{ color: C.dim }}>
                  Still surveying this spot — hang tight a moment, real map data is on its way.
                </div>
              )}

              {!selLocked && !selRec && CLS[selCls].sale !== false && !(roll && roll.qk === sel) && (
                <div>
                  <div className="mb-3 flex items-center justify-between text-sm" style={mono}>
                    <span style={{ color: C.dim }}>Unclaimed · deed price</span>
                    <span className="font-bold">₲{fmt(CLS[selCls].price)}</span>
                  </div>
                  <Btn full onClick={() => buyUnowned(sel)} disabled={g.bal < CLS[selCls].price}>
                    {g.bal < CLS[selCls].price ? "Not enough ₲" : `Claim deed — ₲${fmt(CLS[selCls].price)}`}
                  </Btn>
                </div>
              )}

              {!selLocked && selRec && selRec.o == null && selRec.fp != null && !selMine && !(roll && roll.qk === sel && roll.phase === "spin") && (
                <div>
                  <div className="mb-3 flex items-center justify-between text-sm" style={mono}>
                    <span style={{ color: C.dim }}>Flipped · fresh deed available</span>
                    <span className="font-bold">₲{fmt(selRec.fp)}</span>
                  </div>
                  <Btn full onClick={() => buyFlipped(sel)} disabled={g.bal < selRec.fp}>
                    {g.bal < selRec.fp ? "Not enough ₲" : `Buy — ₲${fmt(selRec.fp)}`}
                  </Btn>
                </div>
              )}

              {!selLocked && selRec && selRec.o != null && !selMine && !(roll && roll.qk === sel && (roll.phase === "spin" || roll.phase === "battle")) && (
                <div>
                  <div className="mb-2 flex flex-wrap items-center gap-2">
                    <Chip color={RAR[selRec.r || 0].color}>{RAR[selRec.r || 0].name}</Chip>
                    <Chip color={CLS[selCls].color}>{LVL[selRec.l || 0]}</Chip>
                    <span className="text-xs" style={{ ...mono, color: C.dim }}>owned by {selRec.n || "a player"}</span>
                    <Chip color={C.amber}>{statusFor(selRec.pnw).name}</Chip>
                  </div>
                  {selRec.p ? (
                    <Btn full onClick={() => buyListed(sel)} disabled={g.bal < selRec.p}>
                      {g.bal < selRec.p ? "Not enough ₲" : `Buy from ${selRec.n || "player"} — ₲${fmt(selRec.p)}`}
                    </Btn>
                  ) : (
                    <div className="py-2 text-center text-xs" style={{ ...mono, color: C.dim }}>Not for sale. Try making friends.</div>
                  )}

                  {attackableFrom(sel) && (
                    <div className="mt-2 border-t pt-2" style={{ borderColor: C.hair }}>
                      <div className="mb-1.5 flex items-center justify-between pt10" style={{ ...mono, color: C.dim }}>
                        <span>attacks left today: {Math.max(0, ATTACK_DAILY_CAP - (g.attacksSent || 0))}/{ATTACK_DAILY_CAP}</span>
                        <span>attacked {selRec.arc || 0}/{ATTACK_RECEIVED_CAP} today</span>
                      </div>
                      <div className="mb-1.5 pt10" style={{ ...mono, color: C.dim }}>
                        your power {neighborsOf(sel).filter((nqk) => ownMap.current.has(nqk)).length} vs their power {defPowerFor(selRec).toFixed(2)}
                        {" — "}
                        <span style={{ color: C.amber, fontWeight: 700 }}>
                          {Math.round(winProbFor(neighborsOf(sel).filter((nqk) => ownMap.current.has(nqk)).length, defPowerFor(selRec)) * 100)}% chance to win
                        </span>
                      </div>
                      <Btn full tone="danger"
                        onClick={() => attackTile(sel)}
                        disabled={g.bal < attackCostFor(selRec) || (!g.devMode && ((g.attacksSent || 0) >= ATTACK_DAILY_CAP || (selRec.arc || 0) >= ATTACK_RECEIVED_CAP))}>
                        {!g.devMode && (g.attacksSent || 0) >= ATTACK_DAILY_CAP ? "No attacks left today"
                          : !g.devMode && (selRec.arc || 0) >= ATTACK_RECEIVED_CAP ? "Tile defended twice today"
                          : g.bal < attackCostFor(selRec) ? "Not enough ₲ to attack"
                          : `Attack — ₲${fmt(attackCostFor(selRec))}`}
                      </Btn>
                    </div>
                  )}
                </div>
              )}

              {selMine && !(roll && roll.qk === sel && (roll.phase === "spin" || roll.phase === "battle")) && (
                <div>
                  <div className="mb-2 flex flex-wrap items-center gap-2">
                    <Chip color={RAR[selMine.r].color}>{RAR[selMine.r].name}</Chip>
                    <Chip color={CLS[selCls].color}>{LVL[selMine.l]}</Chip>
                    {selMine.pr > 0 && <Chip color={C.amber}>★{selMine.pr}</Chip>}
                    <span className="text-xs" style={{ ...mono, color: C.amber }}>₲{fmt1(rentOf(selMine))}/s</span>
                    {selMine.p && <Chip color={C.amber}>Listed ₲{fmt(selMine.p)}</Chip>}
                  </div>
                  {selMine.l < MAX_LVL ? (
                    selMine.bu ? (
                      <div className="flex flex-col gap-2">
                        <div className="flex items-center justify-between rounded-xl p-2.5 text-sm" style={cardSty}>
                          <span style={{ ...mono, color: C.dim }}>Building {LVL[selMine.l + 1]}…</span>
                          <span className="font-bold" style={{ ...mono, fontVariantNumeric: "tabular-nums" }}>{hm(buildSecsLeft(selMine))}</span>
                        </div>
                        <div className="flex gap-2">
                          <Btn full tone="ghost" onClick={() => rushBuild(sel)} disabled={g.bal < rushCostFor(selMine)}>
                            Rush — ₲{fmt(rushCostFor(selMine))}
                          </Btn>
                          <Btn tone="danger" onClick={() => abandon(sel)}>50%</Btn>
                        </div>
                      </div>
                    ) : (
                      <div className="flex gap-2">
                        <Btn full onClick={() => upgrade(sel)} disabled={g.bal < upCost(selMine)}>
                          Build {LVL[selMine.l + 1]} — ₲{fmt(upCost(selMine))}
                        </Btn>
                        {selMine.p ? (
                          <Btn tone="ghost" onClick={() => unlist(sel)}>Unlist</Btn>
                        ) : (
                          <Btn tone="ghost" onClick={() => { setPriceDraft(String(Math.round((selMine.pd || CLS[selCls].price) * 1.5))); setModal({ kind: "list", qk: sel }); }}>List…</Btn>
                        )}
                        <Btn tone="danger" onClick={() => abandon(sel)}>50%</Btn>
                      </div>
                    )
                  ) : (
                    <div className="flex flex-col gap-2">
                      <div className="flex gap-2">
                        <Btn full onClick={() => redevelop(sel)}>Redevelop — +25% rent, keep tile</Btn>
                        <Btn full onClick={() => flip(sel)}>Flip — cash out ₲{fmt(Math.round((selMine.pd || 0) * 1.5))}</Btn>
                      </div>
                      <div className="flex gap-2">
                        {selMine.p ? (
                          <Btn tone="ghost" onClick={() => unlist(sel)}>Unlist</Btn>
                        ) : (
                          <Btn tone="ghost" onClick={() => { setPriceDraft(String(Math.round((selMine.pd || CLS[selCls].price) * 1.5))); setModal({ kind: "list", qk: sel }); }}>List…</Btn>
                        )}
                        <Btn tone="danger" onClick={() => abandon(sel)}>50%</Btn>
                      </div>
                    </div>
                  )}
                </div>
              )}
            </div>
          )}
        </div>

        {/* PORTFOLIO */}
        {tab === "assets" && (
          <div className="absolute inset-0 flex flex-col">
            <div className="shrink-0 px-4 pt-4">
              <div className="mb-3"><Eyebrow>Your holdings · {g.own.length} tile{g.own.length === 1 ? "" : "s"} · net worth ₲{fmt(netWorth())}</Eyebrow></div>
              {g.own.length > 0 && (
                <div className="mb-1">
                  <input value={assetQuery} onChange={(e) => setAssetQuery(e.target.value)} placeholder="Search by district or nearby city…"
                    className="mb-2 w-full rounded-xl px-3 py-2 text-sm focus-visible:outline focus-visible:outline-2"
                    style={{ ...display, ...inputSty }} />
                  <div className="mb-2 flex gap-1.5 overflow-x-auto pb-1">
                    {["all", ...LEGEND].map((cls) => (
                      <button key={cls} onClick={() => setAssetClsFilter(cls)}
                        className="pt10 shrink-0 rounded-full px-2.5 py-1 font-bold uppercase tracking-wide focus-visible:outline focus-visible:outline-2"
                        style={{
                          ...display, outlineColor: C.amber,
                          color: assetClsFilter === cls ? C.ink : C.dim,
                          background: assetClsFilter === cls ? C.amber : C.panel,
                          border: `1px solid ${assetClsFilter === cls ? C.amber : C.hairLit}`,
                        }}>
                        {cls === "all" ? "All" : CLS[cls].name}
                      </button>
                    ))}
                  </div>
                  <div className="flex items-center gap-1.5">
                    <div className="flex flex-1 gap-1.5 overflow-x-auto pb-1">
                      {[{ v: -1, n: "All rarity", c: C.dim }, ...RAR.map((r, i) => ({ v: i, n: r.name, c: r.color }))].map((r) => (
                        <button key={r.v} onClick={() => setAssetRarityFilter(r.v)}
                          className="pt10 shrink-0 rounded-full px-2.5 py-1 font-bold uppercase tracking-wide focus-visible:outline focus-visible:outline-2"
                          style={{
                            ...display, outlineColor: C.amber,
                            color: assetRarityFilter === r.v ? "#0B1420" : r.c,
                            background: assetRarityFilter === r.v ? r.c : C.panel,
                            border: `1px solid ${assetRarityFilter === r.v ? r.c : C.hairLit}`,
                          }}>
                          {r.n}
                        </button>
                      ))}
                    </div>
                    <select value={assetSort} onChange={(e) => setAssetSort(e.target.value)}
                      className="pt11 shrink-0 rounded-xl px-2 py-2 focus-visible:outline focus-visible:outline-2"
                      style={{ ...display, ...inputSty }}>
                      <option value="rent">Rent ↓</option>
                      <option value="rent-asc">Rent ↑</option>
                      <option value="level">Level</option>
                      <option value="rarity">Rarity</option>
                      <option value="district">District</option>
                    </select>
                  </div>
                  {assetsUpgradable.length > 0 && (
                    <Btn small tone="ghost" full onClick={() => upgradeAll(assetsFiltered)} disabled={!!batchBusy}>
                      {batchBusy ? `Upgrading… ${batchBusy.done}/${batchBusy.total}` : `Upgrade all — ${assetsUpgradable.length} eligible${assetClsFilter !== "all" || assetRarityFilter !== -1 || assetQuery.trim() ? " (filtered)" : ""}`}
                    </Btn>
                  )}
                </div>
              )}
            </div>
            <div className="flex-1 overflow-y-auto px-4 pb-4">
              {g.own.length === 0 && (
                <div className="rounded-xl p-6 text-center text-sm" style={{ background: C.panel, color: C.dim }}>
                  You own nothing. The planet awaits — zoom in anywhere and claim your first ~300 m of it.
                </div>
              )}
              {g.own.length > 0 && assetsFiltered.length === 0 && (
                <div className="rounded-xl p-6 text-center text-sm" style={{ background: C.panel, color: C.dim }}>
                  No tiles match those filters. <button className="font-bold underline" style={{ color: C.amber }}
                    onClick={() => { setAssetQuery(""); setAssetClsFilter("all"); setAssetRarityFilter(-1); }}>Clear filters</button>
                </div>
              )}
              {g.own.length > 0 && assetsFiltered.length > 0 && assetsFiltered.length !== g.own.length && (
                <div className="pt10 mb-2" style={{ ...mono, color: C.dim }}>Showing {assetsFiltered.length} of {g.own.length}</div>
              )}
              {assetsFiltered.map((t) => (
              <div key={t.qk} className="mb-2 rounded-xl p-3 transition-transform duration-150 hover:-translate-y-0.5" style={cardSty}>
                <button className="flex w-full items-center justify-between text-left focus-visible:outline focus-visible:outline-2" style={{ outlineColor: C.amber }}
                  onClick={() => { setTab("map"); setSel(t.qk); const [wx, wy] = centerOfQk(t.qk); const { w, h } = size.current; const s = N * 16; cam.current = { s, x: w / 2 - wx * s, y: h / 2 - wy * s, init: true }; ensureRegion(regionOf(t.qk), true); }}>
                  <div className="flex min-w-0 items-center gap-2">
                    <span className="h-2.5 w-2.5 shrink-0 rounded-full" style={{ background: CLS[t.cls].color, boxShadow: `0 0 6px ${CLS[t.cls].color}99` }} />
                    <span className="truncate text-sm font-bold" style={mono}>{coordLabel(t.qk)}</span>
                    <Chip color={RAR[t.r].color}>{RAR[t.r].name}</Chip>
                    {t.pr > 0 && <Chip color={C.amber}>★{t.pr}</Chip>}
                  </div>
                  <span className="text-xs" style={{ ...mono, color: C.amber }}>₲{fmt1(rentOf(t))}/s</span>
                </button>
                <div className="mt-2 flex items-center justify-between">
                  <span className="pt11" style={{ ...mono, color: t.bu ? C.amber : C.dim }}>
                    {t.bu ? `Building ${LVL[t.l + 1]}… ${hm(buildSecsLeft(t))}` : `${LVL[t.l]} · Lv ${t.l}/${MAX_LVL}${t.p ? ` · listed ₲${fmt(t.p)}` : ""}`}
                  </span>
                  <div className="flex gap-1.5">
                    {t.bu ? (
                      <Btn small onClick={() => rushBuild(t.qk)} disabled={g.bal < rushCostFor(t)}>Rush ₲{fmt(rushCostFor(t))}</Btn>
                    ) : t.l < MAX_LVL ? (
                      <Btn small onClick={() => upgrade(t.qk)} disabled={g.bal < upCost(t)}>₲{fmt(upCost(t))}</Btn>
                    ) : (
                      <>
                        <Btn small onClick={() => redevelop(t.qk)}>Redevelop</Btn>
                        <Btn small onClick={() => flip(t.qk)}>Flip</Btn>
                      </>
                    )}
                    {!t.bu && (t.p ? (
                      <Btn small tone="ghost" onClick={() => unlist(t.qk)}>Unlist</Btn>
                    ) : (
                      <Btn small tone="ghost" onClick={() => { setPriceDraft(String(Math.round((t.pd || CLS[t.cls].price) * 1.5))); setModal({ kind: "list", qk: t.qk }); }}>List</Btn>
                    ))}
                  </div>
                </div>
              </div>
              ))}
            </div>
          </div>
        )}

        {/* MARKET */}
        {tab === "market" && (
          <div className="absolute inset-0 overflow-y-auto p-4">
            <div className="mb-3 flex items-center justify-between">
              <Eyebrow>Open market · player listings</Eyebrow>
              <button onClick={() => { refreshMarket(); refreshFlips(); }} className="pt11 focus-visible:outline focus-visible:outline-2" style={{ ...mono, color: C.amber, outlineColor: C.amber }}>Refresh</button>
            </div>
            {market.loading && <div className="pt11 py-2" style={{ ...mono, color: C.dim }}>Checking the register…</div>}
            {market.rows && market.rows.length === 0 && (
              <div className="rounded-xl p-6 text-center text-sm" style={{ background: C.panel, color: C.dim }}>
                Nothing listed in your unlocked territory right now. List one of your tiles, or unlock a new region to trade there too.
              </div>
            )}
            {market.rows && market.rows.map((e) => (
              <div key={e.qk} className="mb-2 flex items-center justify-between rounded-xl p-3 transition-transform duration-150 hover:-translate-y-0.5" style={cardSty}>
                <button className="min-w-0 text-left focus-visible:outline focus-visible:outline-2" style={{ outlineColor: C.amber }}
                  onClick={() => { setTab("map"); setSel(e.qk); const [wx, wy] = centerOfQk(e.qk); const { w, h } = size.current; const s = N * 16; cam.current = { s, x: w / 2 - wx * s, y: h / 2 - wy * s, init: true }; ensureRegion(regionOf(e.qk), true); }}>
                  <div className="flex items-center gap-2">
                    <span className="h-2.5 w-2.5 shrink-0 rounded-full" style={{ background: (CLS[e.cls] || CLS.land).color, boxShadow: `0 0 6px ${(CLS[e.cls] || CLS.land).color}99` }} />
                    <span className="truncate text-sm font-bold" style={mono}>{coordLabel(e.qk)}</span>
                  </div>
                  <div className="pt11 mt-0.5" style={{ ...mono, color: C.dim }}>by {e.n || "a player"}{e.n === g.name ? " (you)" : ""} · {statusFor(e.pnw).name}</div>
                </button>
                <div className="flex shrink-0 items-center gap-2">
                  <span className="text-sm font-bold" style={{ ...mono, color: C.amber }}>₲{fmt(e.p)}</span>
                  {e.n !== g.name && (
                    <Btn small onClick={async () => { await ensureRegion(regionOf(e.qk), true); buyListed(e.qk); }} disabled={g.bal < e.p}>Buy</Btn>
                  )}
                </div>
              </div>
            ))}
            <div className="pt10 mt-2 mb-4 text-center" style={{ ...mono, color: C.dim }}>
              Only shows listings in territory you've unlocked. Sales pay the seller even while they're offline.
            </div>

            <Eyebrow>Flipped · fresh deeds available</Eyebrow>
            <div className="mb-3" />
            {flips.loading && <div className="pt11 py-2" style={{ ...mono, color: C.dim }}>Checking flipped deeds…</div>}
            {flips.rows && flips.rows.length === 0 && (
              <div className="rounded-xl p-6 text-center text-sm" style={{ background: C.panel, color: C.dim }}>
                No flipped tiles available in your unlocked territory right now.
              </div>
            )}
            {flips.rows && flips.rows.map((e) => (
              <div key={e.qk} className="mb-2 flex items-center justify-between rounded-xl p-3 transition-transform duration-150 hover:-translate-y-0.5" style={cardSty}>
                <button className="min-w-0 text-left focus-visible:outline focus-visible:outline-2" style={{ outlineColor: C.amber }}
                  onClick={() => { setTab("map"); setSel(e.qk); const [wx, wy] = centerOfQk(e.qk); const { w, h } = size.current; const s = N * 16; cam.current = { s, x: w / 2 - wx * s, y: h / 2 - wy * s, init: true }; ensureRegion(regionOf(e.qk), true); }}>
                  <div className="flex items-center gap-2">
                    <span className="h-2.5 w-2.5 shrink-0 rounded-full" style={{ background: (CLS[e.cls] || CLS.land).color, boxShadow: `0 0 6px ${(CLS[e.cls] || CLS.land).color}99` }} />
                    <span className="truncate text-sm font-bold" style={mono}>{coordLabel(e.qk)}</span>
                  </div>
                  <div className="pt11 mt-0.5" style={{ ...mono, color: C.dim }}>fresh deed · rarity rolled on purchase</div>
                </button>
                <div className="flex shrink-0 items-center gap-2">
                  <span className="text-sm font-bold" style={{ ...mono, color: RAR[1].color }}>₲{fmt(e.p)}</span>
                  <Btn small onClick={async () => { await ensureRegion(regionOf(e.qk), true); buyFlipped(e.qk); }} disabled={g.bal < e.p}>Buy</Btn>
                </div>
              </div>
            ))}
            <div className="pt10 mt-2 text-center" style={{ ...mono, color: C.dim }}>
              Only shows flips in territory you've unlocked. They reset to Vacant with a freshly-rolled rarity — the previous owner gets a cut when one sells.
            </div>
          </div>
        )}

        {/* HQ */}
        {tab === "hq" && (
          <div className="absolute inset-0 overflow-y-auto p-4">
            {/* zone: you — identity comes first, then the numbers, then what you've earned */}
            <div className="mb-2 flex items-center gap-2">
              <span className="text-xs font-bold uppercase tracking-wide" style={{ ...display, color: C.text }}>You</span>
              <div className="h-px flex-1" style={{ background: C.hair }} />
            </div>

            <div className="mb-3 rounded-xl p-3" style={cardSty}>
              <div className="mb-2 flex items-center justify-between gap-2">
                {g.name ? (
                  <div className="flex min-w-0 items-center gap-2">
                    <span className="truncate text-base font-bold" style={mono}>{g.name}</span>
                    <button className="pt10 shrink-0 font-bold underline focus-visible:outline focus-visible:outline-2" style={{ ...display, color: C.dim, outlineColor: C.amber }}
                      onClick={() => { setNameDraft(g.name); setModal({ kind: "name" }); }}>Rename</button>
                  </div>
                ) : (
                  <div className="flex items-center gap-2">
                    <span className="text-xs" style={{ color: C.dim }}>Pick a name to claim tiles and trade.</span>
                    <Btn small onClick={() => setModal({ kind: "name" })}>Set name</Btn>
                  </div>
                )}
                <Chip color={C.amber}>{myStatus.name}</Chip>
              </div>
              {myStatus.next ? (
                <>
                  <div className="pt10 mb-1 flex items-center justify-between" style={{ ...mono, color: C.dim }}>
                    <span>₲{fmt(g.peakNetWorth)} peak net worth</span>
                    <span>{myStatus.next.name} at ₲{fmt(myStatus.next.min)}</span>
                  </div>
                  <div className="h-1.5 w-full overflow-hidden rounded-full" style={{ background: C.hair }}>
                    <div className="h-full rounded-full" style={{
                      width: `${Math.min(100, Math.max(0, ((g.peakNetWorth - myStatus.min) / (myStatus.next.min - myStatus.min)) * 100))}%`,
                      background: C.amber,
                    }} />
                  </div>
                </>
              ) : (
                <div className="pt10" style={{ ...mono, color: C.dim }}>Highest status reached — ₲{fmt(g.peakNetWorth)} peak net worth.</div>
              )}
              <div className="pt10 mt-2" style={{ ...mono, color: C.dim }}>
                Status is sticky (never drops) and raises your daily energy cap — {myStatus.cap}/day now. Your name is public on tiles, listings and the leaderboard.
              </div>
            </div>

            <div className="mb-3 grid grid-cols-2 gap-2">
              {[
                ["Net worth", "₲" + fmt(netWorth())],
                ["Rent rate", "₲" + fmt1(g.rps) + "/s"],
                ["Tiles", g.own.length],
                ["Visit streak", (g.streak || 0) + "d"],
              ].map(([k, v]) => (
                <div key={k} className="rounded-xl p-3" style={cardSty}>
                  <div className="pt9 trk uppercase font-semibold" style={{ ...display, color: C.dim }}>{k}</div>
                  <div className="text-lg font-bold" style={{ ...mono, fontVariantNumeric: "tabular-nums" }}>{v}</div>
                </div>
              ))}
            </div>

            <div className="mb-3 rounded-xl p-3" style={cardSty}>
              <div className="mb-2"><Eyebrow>Commendations</Eyebrow></div>
              <div className="flex flex-wrap gap-1.5">
                {ACH.map((a) => (
                  <span key={a.k} title={a.desc} className="pt10 rounded-full px-2.5 py-1 font-bold"
                    style={{
                      ...display,
                      color: g.ach[a.k] ? C.ink : C.dim,
                      background: g.ach[a.k] ? C.amber : C.panel,
                      border: `1px solid ${g.ach[a.k] ? C.amber : C.hairLit}`,
                    }}>
                    {a.name}
                  </span>
                ))}
              </div>
            </div>

            {/* zone: world — territory + who else is out there */}
            <div className="mb-2 mt-1 flex items-center gap-2">
              <span className="text-xs font-bold uppercase tracking-wide" style={{ ...display, color: C.text }}>World</span>
              <div className="h-px flex-1" style={{ background: C.hair }} />
            </div>

            <div className="mb-3 rounded-xl p-3" style={cardSty}>
              <div className="mb-2"><Eyebrow>Territory · {unlockedRegions.current.size} region{unlockedRegions.current.size === 1 ? "" : "s"}</Eyebrow></div>
              {unlockedRegions.current.size === 0 ? (
                <div className="text-xs" style={{ color: C.dim }}>Buy your first tile anywhere to set your home region — it's free.</div>
              ) : (
                [...unlockedRegions.current]
                  .sort((a, b) => (b === homeRegionRef.current ? 1 : 0) - (a === homeRegionRef.current ? 1 : 0))
                  .map((region) => {
                    const [wx, wy] = centerOfQk(region);
                    const lat = wyToLat(wy), lon = wx * 360 - 180;
                    const { n } = nearestCity(lat, lon);
                    const isHome = region === homeRegionRef.current;
                    return (
                      <button key={region} className="flex w-full items-center justify-between py-1.5 text-left focus-visible:outline focus-visible:outline-2" style={{ outlineColor: C.amber }}
                        onClick={() => { setTab("map"); flyTo(lat, lon); }}>
                        <span className="text-sm font-bold" style={display}>{n || "Unnamed territory"}</span>
                        {isHome && <Chip color={C.amber}>Home</Chip>}
                      </button>
                    );
                  })
              )}
              <div className="pt10 mt-2" style={{ ...display, color: C.dim }}>
                The fine deed grid only shows/interacts within unlocked territory — next region costs ₲{fmt(nextUnlockCost())}, doubling each time.
              </div>
            </div>

            <div className="mb-3 rounded-xl p-3" style={cardSty}>
              <div className="mb-2 flex items-center justify-between">
                <Eyebrow>World register · top landlords</Eyebrow>
                <button onClick={refreshLB} className="pt11 focus-visible:outline focus-visible:outline-2" style={{ ...mono, color: C.amber, outlineColor: C.amber }}>Refresh</button>
              </div>
              {lb.loading ? (
                <div className="pt11 py-2" style={{ ...mono, color: C.dim }}>Pulling records…</div>
              ) : lb.rows && lb.rows.length ? (
                lb.rows.map((r, idx) => (
                  <div key={r.id} className="flex items-center justify-between py-1.5 text-sm" style={{ borderTop: idx ? `1px solid ${C.hair}` : "none" }}>
                    <div className="flex min-w-0 items-center gap-2" style={mono}>
                      <span className="w-5 shrink-0 text-right text-xs" style={{ color: C.dim }}>{idx + 1}</span>
                      <span className={`truncate ${r.id === g.uid ? "font-bold" : ""}`} style={r.id === g.uid ? { color: C.amber } : {}}>
                        {r.n}{r.id === g.uid ? " (you)" : ""}
                      </span>
                      <Chip color={C.amber}>{statusFor(r.pnw).name}</Chip>
                    </div>
                    <span className="shrink-0 text-xs" style={{ ...mono, color: C.dim }}>₲{fmt(r.nw || 0)} · {r.pc || 0} tiles</span>
                  </div>
                ))
              ) : (
                <div className="pt11 py-2" style={{ ...mono, color: C.dim }}>{g.name ? "No landlords on record yet." : "Set a name to appear here."}</div>
              )}
            </div>

            {/* zone: activity — sales, repossessions, battle results */}
            <div className="mb-2 mt-1 flex items-center gap-2">
              <span className="text-xs font-bold uppercase tracking-wide" style={{ ...display, color: C.text }}>Activity</span>
              <div className="h-px flex-1" style={{ background: C.hair }} />
            </div>

            <div className="mb-3 rounded-xl p-3" style={cardSty}>
              <div className="mb-2 flex items-center justify-between">
                <Eyebrow>Recent activity</Eyebrow>
                <button onClick={refreshLog} className="pt11 focus-visible:outline focus-visible:outline-2" style={{ ...mono, color: C.amber, outlineColor: C.amber }}>Refresh</button>
              </div>
              {log.loading ? (
                <div className="pt11 py-2" style={{ ...mono, color: C.dim }}>Pulling records…</div>
              ) : log.rows && log.rows.length ? (
                log.rows.map((e, idx) => (
                  <button key={e.id} className="flex w-full items-center justify-between gap-2 py-1.5 text-left text-xs focus-visible:outline focus-visible:outline-2"
                    style={{ ...mono, borderTop: idx ? `1px solid ${C.hair}` : "none", color: e.tone === "bad" ? "#F08A8A" : e.tone === "good" ? C.amber : C.dim, outlineColor: C.amber }}
                    onClick={() => {
                      if (!e.qk) return;
                      setTab("map"); setSel(e.qk);
                      const [wx, wy] = centerOfQk(e.qk);
                      const { w, h } = size.current;
                      const s = N * 16;
                      cam.current = { s, x: w / 2 - wx * s, y: h / 2 - wy * s, init: true };
                      ensureRegion(regionOf(e.qk), true);
                    }}>
                    <span className="min-w-0 flex-1 truncate">{e.text}</span>
                    <span className="shrink-0" style={{ color: C.dim }}>{timeAgo(e.ts)}</span>
                  </button>
                ))
              ) : (
                <div className="pt11 py-2" style={{ ...mono, color: C.dim }}>Nothing yet — sales, repossessions, and battle results will show up here.</div>
              )}
            </div>

            {/* zone: account */}
            <div className="mb-2 mt-1 flex items-center gap-2">
              <span className="text-xs font-bold uppercase tracking-wide" style={{ ...display, color: C.text }}>Account</span>
              <div className="h-px flex-1" style={{ background: C.hair }} />
            </div>

            <div className="mb-3 rounded-xl p-3" style={cardSty}>
              <div className="flex gap-2">
                <Btn small tone="ghost" onClick={() => { save(); onExit(); signOut(); }}>Sign out</Btn>
                <Btn small tone="danger" onClick={() => setConfirmDelete(true)}>Delete account &amp; data</Btn>
              </div>
              <div className="pt10 mt-2" style={{ ...mono, color: C.dim }}>
                Deleting removes your wallet, tiles and username permanently. This can't be undone.
              </div>
            </div>
            <div className="pt10 pb-2 text-center leading-relaxed" style={{ ...mono, color: C.dim }}>
              Parody idle game. ₲ Geobux are virtual and worth nothing.<br />
              Coastlines are real (Natural Earth data) but simplified — your beach house may be approximate.
            </div>
          </div>
        )}
      </div>

      {/* toasts */}
      <div className="pointer-events-none absolute inset-x-0 bottom-20 z-10 flex flex-col items-center gap-1.5">
        {toasts.map((t) => (
          <div key={t.id} className="pt-anim-popIn rounded-full px-4 py-2 text-xs font-bold"
            style={{ ...display, background: C.amber, color: C.ink, boxShadow: C.shadowMd }}>{t.text}</div>
        ))}
      </div>

      {/* nav */}
      <div className="flex gap-1 p-1.5" style={{ background: C.panel, borderTop: `1px solid ${C.hair}` }}>
        {[["map", "Map"], ["assets", "Assets"], ["market", "Market"], ["hq", "HQ"]].map(([k, label]) => (
          <button key={k} onClick={() => setTab(k)} className="relative pt11 trk flex-1 rounded-xl py-2.5 font-bold uppercase transition-all duration-150 focus-visible:outline focus-visible:outline-2"
            style={{
              ...display,
              color: tab === k ? C.ink : C.dim,
              background: tab === k ? C.amber : "none",
              boxShadow: tab === k ? "0 4px 14px -4px rgba(226,154,46,.55)" : "none",
              outlineColor: C.amber,
            }}>
            {label}
            {k === "hq" && g.hasUnseenLoss && (
              <span className="absolute right-2.5 top-1.5 h-2 w-2 rounded-full" style={{ background: "#F08A8A", boxShadow: "0 0 6px #F08A8A99" }} title="Territory lost while you were away" />
            )}
          </button>
        ))}
      </div>

      {/* modals */}
      {modal && (
        <Modal onClose={closeModal}>
          {modal.kind === "welcome" && (
            <>
              <Eyebrow>While you were away</Eyebrow>
              <div className="my-2 text-3xl font-bold" style={{ ...mono, color: C.amber, textShadow: `0 0 26px ${C.glow}` }}>+₲{fmt(modal.gain)}</div>
              <div className="mb-4 text-xs" style={{ color: C.dim }}>Your tenants kept paying (half rate, capped at 8h — even fake landlords need limits).</div>
              <Btn full onClick={closeModal}>Collect</Btn>
            </>
          )}
          {modal.kind === "daily" && (
            <>
              <Eyebrow>Daily stipend · day {modal.streak}</Eyebrow>
              <div className="my-2 text-3xl font-bold" style={{ ...mono, color: C.amber, textShadow: `0 0 26px ${C.glow}` }}>+₲{fmt(modal.reward)}</div>
              <div className="mb-4 text-xs" style={{ color: C.dim }}>The World Deed Office pays you for showing up. Streak grows the stipend, up to day 7.</div>
              <Btn full onClick={closeModal}>Accept</Btn>
            </>
          )}
          {modal.kind === "name" && (
            <>
              <Eyebrow>Landlord identity</Eyebrow>
              <div className="mb-3 mt-2 text-xs" style={{ color: C.dim }}>
                Deeds are public records: this name is visible to every player on tiles you own, in listings, and on the leaderboard.
              </div>
              <div className="flex gap-2">
                <input value={nameDraft} onChange={(e) => setNameDraft(e.target.value)} maxLength={16} placeholder="e.g. DirtBaron"
                  className="min-w-0 flex-1 rounded-xl px-3 py-2.5 text-sm focus-visible:outline focus-visible:outline-2"
                  style={{ ...display, ...inputSty }} />
                <Btn small onClick={setName} disabled={!nameDraft.trim()}>Save</Btn>
              </div>
            </>
          )}
          {modal.kind === "list" && (
            <>
              <Eyebrow>List {coordLabel(modal.qk)}</Eyebrow>
              <div className="mb-3 mt-2 text-xs" style={{ color: C.dim }}>
                Any player can buy it at this price. Proceeds land in your account even if you're offline.
              </div>
              <div className="flex gap-2">
                <input value={priceDraft} onChange={(e) => setPriceDraft(e.target.value.replace(/[^0-9]/g, ""))} inputMode="numeric" placeholder="Price in ₲"
                  className="min-w-0 flex-1 rounded-xl px-3 py-2.5 text-sm focus-visible:outline focus-visible:outline-2"
                  style={{ ...mono, ...inputSty }} />
                <Btn small onClick={() => { const p = parseInt(priceDraft, 10); if (p > 0) { listTile(modal.qk, p); closeModal(); } }} disabled={!(parseInt(priceDraft, 10) > 0)}>List</Btn>
              </div>
            </>
          )}
          {modal.kind === "ad" && <AdModal ad={modal.ad} reduced={reduced} onClaim={claimBoost} onClose={closeModal} />}
        </Modal>
      )}

      {confirmDelete && (
        <Modal onClose={() => !deleteBusy && setConfirmDelete(false)}>
          <Eyebrow>Delete account &amp; data?</Eyebrow>
          <div className="mt-3 text-sm leading-relaxed" style={{ color: C.text }}>
            This permanently deletes your account, wallet, username and every tile you own. There is no undo, and this Google account can never be recovered back into this save.
          </div>
          <div className="mt-4 flex gap-2">
            <Btn full tone="ghost" onClick={() => setConfirmDelete(false)} disabled={deleteBusy}>Cancel</Btn>
            <Btn full tone="danger" onClick={deleteAccount} disabled={deleteBusy}>{deleteBusy ? "Deleting…" : "Delete everything"}</Btn>
          </div>
        </Modal>
      )}
    </div>
  );
}

/* ── fake ad modal ──────────────────────────────────────────── */

function AdModal({ ad, reduced, onClaim, onClose }) {
  const [t, setT] = useState(0);
  const DUR = reduced ? 1 : 6;
  useEffect(() => {
    const iv = setInterval(() => setT((x) => Math.min(DUR, x + 0.1)), 100);
    return () => clearInterval(iv);
  }, [DUR]);
  const done = t >= DUR;
  return (
    <>
      <div className="flex items-center justify-between">
        <Eyebrow>Paid promotion · parody, not a real ad</Eyebrow>
        <button onClick={onClose} className="px-1 text-lg focus-visible:outline focus-visible:outline-2" style={{ color: C.dim, outlineColor: C.amber }}>✕</button>
      </div>
      <div className="my-4 rounded-xl p-5 text-center" style={{ background: C.ink, border: `1px dashed ${C.hairLit}` }}>
        <div className="text-lg font-bold" style={display}>{ad.brand}</div>
        <div className="mt-1 text-sm italic" style={{ color: C.dim }}>“{ad.line}”</div>
      </div>
      <div className="mb-3 h-1.5 overflow-hidden rounded-full" style={{ background: C.hair }}>
        <div className="h-full rounded-full transition-all"
          style={{
            width: `${(t / DUR) * 100}%`,
            backgroundImage: `linear-gradient(90deg, ${C.amberDeep}, ${C.amber}, ${C.amberSoft}, ${C.amber}, ${C.amberDeep})`,
            backgroundSize: "200% 100%",
            animation: "ptShimmer 1.4s linear infinite",
          }} />
      </div>
      <Btn full disabled={!done} onClick={onClaim}>
        {done ? "Claim 2× rent (5:00)" : `Enjoying this fine message… ${Math.ceil(DUR - t)}s`}
      </Btn>
    </>
  );
}
