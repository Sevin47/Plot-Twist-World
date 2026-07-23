import { supabase } from "./storage.js";

/*
  Opt-in Web Push, two independent alert types (energy reset, tile
  captured) sharing one underlying browser subscription — a device only
  ever holds one PushManager subscription regardless of how many alert
  types it's opted into, so subscribing/unsubscribing is shared plumbing
  here while each alert type's on/off state is its own column server-side
  (see push_subscriptions in supabase.sql). Entirely separate from
  MULTIPLAYER/Supabase configuration below the browser-capability check —
  a device without notification support (or over plain HTTP in dev) just
  can't offer either toggle at all.
*/

const VAPID_PUBLIC_KEY = import.meta.env.VITE_VAPID_PUBLIC_KEY;

export function pushSupported() {
  return typeof window !== "undefined" && "serviceWorker" in navigator && "PushManager" in window && !!VAPID_PUBLIC_KEY;
}

// PushManager.subscribe wants the VAPID key as a raw Uint8Array, not the
// base64url string it's stored/transmitted as.
function urlBase64ToUint8Array(base64) {
  const padding = "=".repeat((4 - (base64.length % 4)) % 4);
  const b64 = (base64 + padding).replace(/-/g, "+").replace(/_/g, "/");
  const raw = atob(b64);
  return Uint8Array.from([...raw].map((c) => c.charCodeAt(0)));
}

// Reads back this account's actual preferences, cross-checked against
// whether the browser still holds a live subscription — the latter can
// never drift from reality (e.g. the player revoking the permission from
// browser settings instead of the in-game toggles), so a missing browser
// subscription forces both to read as off regardless of what's stored
// server-side. A stale "on" in the DB in that case is harmless: the next
// send attempt against the dead endpoint gets pruned server-side, same as
// always.
export async function getPushPrefs() {
  const off = { energyAlerts: false, attackAlerts: false };
  if (!pushSupported() || !supabase) return off;
  const reg = await navigator.serviceWorker.getRegistration();
  const sub = reg ? await reg.pushManager.getSubscription() : null;
  if (!sub) return off;
  const { data, error } = await supabase.rpc("get_push_prefs");
  if (error || !data || !data.length) return off;
  return { energyAlerts: !!data[0].energy_alerts, attackAlerts: !!data[0].attack_alerts };
}

// Applies the full desired pair in one shot (not a partial update) —
// callers always pass both current values, one changed. Handles
// subscribing the browser on first opt-in of either kind, and tearing the
// subscription down entirely once both are off.
export async function setPushPrefs(energyAlerts, attackAlerts) {
  if (!pushSupported() || !supabase) throw new Error("Push not supported here");

  if (!energyAlerts && !attackAlerts) {
    await disablePushAlerts();
    return;
  }

  const permission = await Notification.requestPermission();
  if (permission !== "granted") throw new Error("Notification permission denied");

  // Relative to BASE_URL, not "/" — this project deploys to a GitHub Pages
  // subpath (see vite.config.js's base: "./"), so an absolute root path
  // would 404 there. scope is explicit for the same reason.
  const swUrl = `${import.meta.env.BASE_URL}sw.js`;
  const reg = await navigator.serviceWorker.register(swUrl, { scope: import.meta.env.BASE_URL });
  await navigator.serviceWorker.ready;
  let sub = await reg.pushManager.getSubscription();
  if (!sub) {
    sub = await reg.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(VAPID_PUBLIC_KEY),
    });
  }

  const json = sub.toJSON();
  const { error } = await supabase.rpc("save_push_subscription", {
    p_endpoint: json.endpoint,
    p_p256dh: json.keys.p256dh,
    p_auth: json.keys.auth,
    p_energy_alerts: energyAlerts,
    p_attack_alerts: attackAlerts,
  });
  if (error) throw error;
}

export async function disablePushAlerts() {
  if (supabase) {
    // Best-effort — the row is harmless if this fails (the send-*-alerts
    // functions will just prune it after one failed delivery to the dead
    // endpoint), so a network blip here shouldn't block unsubscribing
    // locally. try/catch, not .catch() — supabase.rpc(...) returns a
    // thenable builder, not a real Promise, so it has no .catch method to
    // chain.
    try {
      await supabase.rpc("disable_push_alerts");
    } catch {
      /* ignore */
    }
  }
  if (!pushSupported()) return;
  const reg = await navigator.serviceWorker.getRegistration();
  const sub = await reg?.pushManager.getSubscription();
  if (sub) await sub.unsubscribe();
}
