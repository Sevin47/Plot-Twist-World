// Web Worker: owns the entire vector-tile fetch → decode → IndexedDB-cache
// pipeline, off the main thread. Same pattern Mapbox GL JS / MapLibre use —
// their own architecture docs describe parsing vector tiles in workers
// specifically so tile processing can never block the UI thread.
//
// This worker does NOT do classification (point-in-polygon testing) — that
// stays on the main thread, because it's already sub-millisecond per query
// once a tile is decoded (measured ~0.5ms for a whole viewport). The actual
// cost worth moving off-thread is protobuf parsing, network fetch overhead,
// and IndexedDB transactions — real, measurable work, unlike the query math.
//
// Protocol: main thread posts { type: "resolve", key, z, tx, ty }; this
// worker eventually posts back either { key, ok: true, water, landuse,
// buildings } or { key, ok: false }. One message in, one message out, per
// tile — the main thread deduplicates repeated requests for the same key.

import { PbfReader } from "pbf";
import { VectorTile } from "@mapbox/vector-tile";
import { getTileCacheBatch, putTileCache } from "./tilecache.js";

const PROTOMAPS_KEY = import.meta.env.VITE_PROTOMAPS_KEY || "";

function pointsFromRing(ring) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  const pts = ring.map((p) => {
    if (p.x < minX) minX = p.x; if (p.x > maxX) maxX = p.x;
    if (p.y < minY) minY = p.y; if (p.y > maxY) maxY = p.y;
    return { x: p.x, y: p.y };
  });
  return { pts, minX, minY, maxX, maxY };
}

// Decode every polygon feature in a layer once, with a bbox for cheap
// pre-filtering on the main thread later. Points become plain {x,y} objects
// so the result is safe to postMessage (structured clone) and to persist
// via IndexedDB — no library class instances leaking out of this worker.
function decodePolyLayer(layer, withKind) {
  if (!layer) return [];
  const out = [];
  for (let i = 0; i < layer.length; i++) {
    const f = layer.feature(i);
    if (f.type !== 3) continue; // polygons only
    const rawGeom = f.loadGeometry();
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    const geom = rawGeom.map((ring) => {
      const r = pointsFromRing(ring);
      if (r.minX < minX) minX = r.minX; if (r.maxX > maxX) maxX = r.maxX;
      if (r.minY < minY) minY = r.minY; if (r.maxY > maxY) maxY = r.maxY;
      return r.pts;
    });
    out.push({ geom, minX, minY, maxX, maxY, kind: withKind ? f.properties.kind || null : null });
  }
  return out;
}

// Concurrency budget for actual network fetches — the browser's connection
// pool is shared regardless of which thread issues the request, so this
// still matters exactly as it did on the main thread. The main thread tells
// us the right number for the current connection quality via a "tuning"
// message (see below); it already has that detection logic.
let maxInflight = 6;
let inflight = 0;
const queue = [];
// Hard backlog cap — without this, panning across many areas without
// waiting for each to finish loading can queue up tens of thousands of
// requests for places the player has long since left, which then sit ahead
// of whatever's actually on screen right now. Must stay >= the main
// thread's own per-prefetch tile cap (fast tier: 1800) — it was previously
// 800, silently dropping the stalest queued tiles as genuinely-needed
// (not stale) requests for a single large, dense view before they were
// ever attempted.
const MAX_QUEUE = 2000;

function drainQueue() {
  // LIFO on purpose: the most recently requested tile is the one most likely
  // to still be on screen. FIFO here was the actual bug — panning to a new
  // area just appended to the end of a long line of stale requests from
  // wherever you'd already panned away from, so the new area never got its
  // turn until that entire backlog drained first.
  while (inflight < maxInflight && queue.length) startNetwork(queue.pop());
}
function startNetwork(job) {
  inflight++;
  fetch(`https://api.protomaps.com/tiles/v4/${job.z}/${job.tx}/${job.ty}.mvt?key=${PROTOMAPS_KEY}`)
    .then((res) => { if (!res.ok) throw new Error(String(res.status)); return res.arrayBuffer(); })
    .then((buf) => {
      const tile = new VectorTile(new PbfReader(new Uint8Array(buf)));
      const water = decodePolyLayer(tile.layers.water);
      const landuse = decodePolyLayer(tile.layers.landuse, true);
      const buildings = decodePolyLayer(tile.layers.buildings);
      postMessage({ key: job.key, ok: true, water, landuse, buildings });
      putTileCache(job.z, job.tx, job.ty, water, landuse, buildings); // fire-and-forget
    })
    .catch(() => postMessage({ key: job.key, ok: false }))
    .finally(() => { inflight--; drainQueue(); });
}
function enqueueNetwork(job) {
  if (inflight < maxInflight) { startNetwork(job); return; }
  if (queue.length >= MAX_QUEUE) {
    // drop the stalest (front of the array) queued job rather than let the
    // backlog grow forever — tell the main thread so it isn't left waiting
    const dropped = queue.shift();
    postMessage({ key: dropped.key, ok: false });
  }
  queue.push(job);
}

// Coalesce IndexedDB lookups: requests that arrive in the same microtask
// tick (typical for a prefetch burst — many "resolve" messages posted in a
// tight loop) get checked in ONE transaction instead of one each. Same
// technique used on the main thread earlier, just relocated — it's still a
// real, measurable win, it just no longer matters for main-thread jank
// specifically (that's the whole point of this file existing).
let pendingBatch = [];
let batchScheduled = false;
function scheduleBatchCheck() {
  if (batchScheduled) return;
  batchScheduled = true;
  Promise.resolve().then(runBatchCheck);
}
async function runBatchCheck() {
  const batch = pendingBatch;
  pendingBatch = [];
  batchScheduled = false;
  if (!batch.length) return;
  const found = await getTileCacheBatch(batch.map((j) => ({ z: j.z, tx: j.tx, ty: j.ty })));
  for (const job of batch) {
    const rec = found.get(`${job.z}/${job.tx}/${job.ty}`);
    if (rec) postMessage({ key: job.key, ok: true, water: rec.water, landuse: rec.landuse, buildings: rec.buildings });
    else enqueueNetwork(job);
  }
}

self.onmessage = (ev) => {
  const msg = ev.data;
  if (msg.type === "tuning") { maxInflight = msg.maxInflight; drainQueue(); return; }
  if (msg.type === "cancel") {
    // the main thread evicted this tile from its cache (something newer
    // pushed it out) — drop it from wherever it's waiting so it stops
    // competing with requests that are actually still relevant. Can't abort
    // a fetch already in flight without more plumbing than this is worth,
    // but that's a small, bounded cost (at most `maxInflight` wasted
    // requests) compared to an unbounded backlog of queued-but-not-started
    // stale work, which is what this is actually fixing.
    const qi = queue.findIndex((j) => j.key === msg.key);
    if (qi !== -1) queue.splice(qi, 1);
    pendingBatch = pendingBatch.filter((j) => j.key !== msg.key);
    return;
  }
  if (msg.type === "resolve") {
    if (!PROTOMAPS_KEY) { postMessage({ key: msg.key, ok: false }); return; }
    pendingBatch.push(msg);
    scheduleBatchCheck();
  }
};

// Announce successful startup. If the main thread never sees this, the
// worker's script itself failed to load or crashed during evaluation —
// which is otherwise a SILENT failure (constructing a Worker never throws
// just because its script 404s or errors; that failure is async and easy
// to miss without explicitly checking for it, exactly like this).
postMessage({ type: "ready", hasKey: !!PROTOMAPS_KEY });
