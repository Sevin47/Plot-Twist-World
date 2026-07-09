// Persistent cache for decoded vector-tile land-use data (water/landuse/
// building polygons), backed by IndexedDB. This is what actually gets you
// "download once, reuse forever" behavior — but per-player, per-device,
// building up naturally as people explore, rather than one big pre-baked
// file we'd have to host and keep in sync with changing OSM data.
//
// Every function here is best-effort and silently falls back to "no cache"
// (the caller just re-fetches from the network) if IndexedDB is unavailable
// or a write/read fails for any reason — this must never be able to break
// gameplay, only speed it up.

const DB_NAME = "plottwist-tiles";
const DB_VERSION = 1;
const STORE = "tiles";
const SCHEMA = "v1"; // bump this if the stored data shape ever changes
const MAX_AGE_MS = 21 * 24 * 3600 * 1000; // OSM data changes; don't trust a cached tile forever
const MAX_ENTRIES = 3000;
const PRUNE_TO = 2500;
// IndexedDB can wedge at the browser level (confirmed in the wild: even a
// bare indexedDB.databases() call hung indefinitely on one real profile) —
// when that happens, every single request events simply never fires, not
// even onerror. Without a hard timeout, openDb()'s promise (and every
// caller awaiting it) hangs forever, and because dbPromise is memoized,
// that poisons every future call in the session too — permanently
// disabling all classification with zero error surfaced anywhere. A cache
// that can never respond is worse than no cache: time out and fall
// straight through to "no cache, fetch from network" instead.
const DB_TIMEOUT_MS = 3000;

let dbPromise = null;
function openDb() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    if (typeof indexedDB === "undefined") { reject(new Error("no indexedDB")); return; }
    let req;
    try { req = indexedDB.open(DB_NAME, DB_VERSION); }
    catch (err) { reject(err); return; }
    const timeout = setTimeout(() => reject(new Error("indexedDB.open timed out")), DB_TIMEOUT_MS);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) {
        const os = db.createObjectStore(STORE, { keyPath: "key" });
        os.createIndex("savedAt", "savedAt");
      }
    };
    req.onsuccess = () => { clearTimeout(timeout); resolve(req.result); };
    req.onerror = () => { clearTimeout(timeout); reject(req.error); };
    req.onblocked = () => { clearTimeout(timeout); reject(new Error("indexedDB.open blocked")); };
  }).catch((err) => {
    // Don't permanently poison future calls over a transient hang (a stuck
    // connection elsewhere can clear up later) — only forget-and-never-
    // retry when the environment genuinely has no indexedDB at all.
    if (!/no indexedDB/.test(String(err && err.message))) dbPromise = null;
    throw err;
  });
  return dbPromise;
}

const tileKey = (z, tx, ty) => `${SCHEMA}:${z}/${tx}/${ty}`;

export async function getTileCache(z, tx, ty) {
  try {
    const db = await openDb();
    const rec = await new Promise((resolve, reject) => {
      const req = db.transaction(STORE, "readonly").objectStore(STORE).get(tileKey(z, tx, ty));
      req.onsuccess = () => resolve(req.result || null);
      req.onerror = () => reject(req.error);
    });
    if (!rec || Date.now() - rec.savedAt > MAX_AGE_MS) return null;
    return rec;
  } catch {
    return null; // unavailable/failed — caller just fetches from the network
  }
}

// Same lookup as getTileCache, but for many tiles at once inside a SINGLE
// transaction — used by the batch prefetch path, which otherwise needs a
// separate transaction per tile (real overhead: opening/closing hundreds of
// transactions for one viewport is measurably slower than one transaction
// making hundreds of get() requests, especially on weaker mobile CPUs).
// Returns a Map keyed by "z/tx/ty" (not the schema-prefixed internal key).
export async function getTileCacheBatch(keys) {
  const results = new Map();
  if (!keys.length) return results;
  try {
    const db = await openDb();
    await new Promise((resolve, reject) => {
      const store = db.transaction(STORE, "readonly").objectStore(STORE);
      const now = Date.now();
      let pending = keys.length;
      // Same rationale as openDb()'s timeout: a wedged IndexedDB can leave
      // individual get() requests never firing onsuccess/onerror at all —
      // without this, one bad batch hangs every tile in it forever.
      const timeout = setTimeout(() => reject(new Error("getTileCacheBatch timed out")), DB_TIMEOUT_MS);
      const settle = () => { if (--pending === 0) { clearTimeout(timeout); resolve(); } };
      for (const k of keys) {
        const req = store.get(tileKey(k.z, k.tx, k.ty));
        req.onsuccess = () => {
          const rec = req.result;
          if (rec && now - rec.savedAt <= MAX_AGE_MS) results.set(`${k.z}/${k.tx}/${k.ty}`, rec);
          settle();
        };
        req.onerror = () => settle();
      }
    });
  } catch {
    // unavailable — return whatever we already found (likely nothing);
    // callers treat missing entries as "fetch from network"
  }
  return results;
}

let writeCount = 0;
export async function putTileCache(z, tx, ty, water, landuse, buildings) {
  try {
    const db = await openDb();
    await new Promise((resolve, reject) => {
      const store = db.transaction(STORE, "readwrite").objectStore(STORE);
      const req = store.put({ key: tileKey(z, tx, ty), savedAt: Date.now(), water, landuse, buildings });
      req.onsuccess = () => resolve();
      req.onerror = () => reject(req.error);
    });
    writeCount++;
    if (writeCount % 50 === 0) pruneIfNeeded().catch(() => {});
  } catch {
    // best-effort only — a failed cache write must never affect gameplay
  }
}

async function pruneIfNeeded() {
  const db = await openDb();
  const count = await new Promise((resolve, reject) => {
    const req = db.transaction(STORE, "readonly").objectStore(STORE).count();
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  if (count <= MAX_ENTRIES) return;
  const toDelete = count - PRUNE_TO;
  await new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, "readwrite");
    let deleted = 0;
    const cursorReq = tx.objectStore(STORE).index("savedAt").openCursor();
    cursorReq.onsuccess = () => {
      const cursor = cursorReq.result;
      if (!cursor || deleted >= toDelete) { resolve(); return; }
      cursor.delete();
      deleted++;
      cursor.continue();
    };
    cursorReq.onerror = () => reject(cursorReq.error);
  });
}
