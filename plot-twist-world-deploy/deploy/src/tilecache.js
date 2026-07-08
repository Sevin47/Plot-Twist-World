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

let dbPromise = null;
function openDb() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    if (typeof indexedDB === "undefined") { reject(new Error("no indexedDB")); return; }
    let req;
    try { req = indexedDB.open(DB_NAME, DB_VERSION); }
    catch (err) { reject(err); return; }
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) {
        const os = db.createObjectStore(STORE, { keyPath: "key" });
        os.createIndex("savedAt", "savedAt");
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
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
