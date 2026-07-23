import { supabase } from "./storage.js";

/*
  Opt-in Web Push for the "energy reset" alert. Entirely separate from
  MULTIPLAYER/Supabase configuration below the browser-capability check —
  a device without notification support (or over plain HTTP in dev) just
  can't offer the toggle at all.
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

// Reflects only whether *this browser* holds a live subscription — the
// source of truth for "are alerts on" the account. Deliberately not
// mirrored into profiles/localStorage: asking the browser directly means
// it can never drift from reality (e.g. the user revoking the permission
// from browser settings instead of the in-game toggle).
export async function pushIsSubscribed() {
  if (!pushSupported()) return false;
  const reg = await navigator.serviceWorker.getRegistration();
  if (!reg) return false;
  const sub = await reg.pushManager.getSubscription();
  return !!sub;
}

export async function enablePushAlerts() {
  if (!pushSupported() || !supabase) throw new Error("Push not supported here");
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
  });
  if (error) throw error;
}

export async function disablePushAlerts() {
  if (supabase) {
    // Best-effort — the row is harmless if this fails (send-energy-alerts
    // will just prune it after one failed delivery to the dead endpoint),
    // so a network blip here shouldn't block unsubscribing locally.
    await supabase.rpc("disable_push_alerts").catch(() => {});
  }
  if (!pushSupported()) return;
  const reg = await navigator.serviceWorker.getRegistration();
  const sub = await reg?.pushManager.getSubscription();
  if (sub) await sub.unsubscribe();
}
