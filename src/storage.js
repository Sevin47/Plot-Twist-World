import { createClient } from "@supabase/supabase-js";

/*
  Storage adapter replicating the claude.ai artifact `window.storage` API:

    get(key, shared)  -> { key, value, shared } | null
    set(key, value, shared) -> { key, value, shared }
    delete(key, shared) -> { key, deleted, shared }
    list(prefix, shared) -> { keys: [...] }

  - Personal data (shared=false): always localStorage on this device.
  - Shared data (shared=true): Supabase `kv` table if VITE_SUPABASE_URL and
    VITE_SUPABASE_ANON_KEY are set — that's what makes the world multiplayer.
    Without them, shared data also falls back to localStorage, which gives
    you a fully working single-player planet.
*/

const url = import.meta.env.VITE_SUPABASE_URL;
const anon = import.meta.env.VITE_SUPABASE_ANON_KEY;
const sb = url && anon ? createClient(url, anon) : null;

export const MULTIPLAYER = !!sb;

const LKEY = (k, shared) => `ptw:${shared ? "shared" : "me"}:${k}`;

const local = {
  get(k, shared) {
    const v = localStorage.getItem(LKEY(k, shared));
    return v === null ? null : { key: k, value: v, shared };
  },
  set(k, v, shared) {
    localStorage.setItem(LKEY(k, shared), v);
    return { key: k, value: v, shared };
  },
  del(k, shared) {
    localStorage.removeItem(LKEY(k, shared));
    return { key: k, deleted: true, shared };
  },
  list(prefix, shared) {
    const pre = LKEY(prefix, shared);
    const keys = [];
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k && k.startsWith(pre)) keys.push(k.slice(LKEY("", shared).length));
    }
    return { keys, prefix, shared };
  },
};

async function sbGet(key) {
  const { data, error } = await sb.from("kv").select("value").eq("scope", "shared").eq("key", key).maybeSingle();
  if (error) throw error;
  return data ? { key, value: data.value, shared: true } : null;
}
async function sbSet(key, value) {
  const { error } = await sb.from("kv").upsert({ scope: "shared", key, value, updated_at: new Date().toISOString() });
  if (error) throw error;
  return { key, value, shared: true };
}
async function sbDel(key) {
  const { error } = await sb.from("kv").delete().eq("scope", "shared").eq("key", key);
  if (error) throw error;
  return { key, deleted: true, shared: true };
}
async function sbList(prefix) {
  const { data, error } = await sb
    .from("kv").select("key").eq("scope", "shared")
    .like("key", `${(prefix || "").replaceAll("%", "\\%")}%`).limit(100);
  if (error) throw error;
  return { keys: (data || []).map((r) => r.key), prefix, shared: true };
}

export function installStorage() {
  window.storage = {
    async get(key, shared = false) {
      if (shared && sb) return sbGet(key);
      return local.get(key, shared);
    },
    async set(key, value, shared = false) {
      if (shared && sb) return sbSet(key, value);
      return local.set(key, value, shared);
    },
    async delete(key, shared = false) {
      if (shared && sb) return sbDel(key);
      return local.del(key, shared);
    },
    async list(prefix = "", shared = false) {
      if (shared && sb) return sbList(prefix);
      return local.list(prefix, shared);
    },
  };
}
