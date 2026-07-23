// Fires the opt-in "your tile was captured" push to the defender of every
// not-yet-processed loss in battle_log. Invoked every 2 minutes by the
// pg_cron job in supabase.sql — never called from the client. Unlike
// send-energy-alerts (one fixed instant for everyone), a capture happens
// whenever it happens, so this is a short poll rather than a once-a-day
// broadcast.
//
// Deploy: `supabase functions deploy send-attack-alerts --no-verify-jwt`
// (same one-time `supabase login` / `supabase link` as delete-account).
// --no-verify-jwt is required: this project's service-role credential is
// the newer sb_secret_... format, not a JWT, so Supabase's automatic
// Authorization-header check (which expects a JWT) would 401 every call
// pg_cron makes before this code ever runs — auth here is the x-cron-
// secret header check below instead.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import webpush from "npm:web-push@3";

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok");

  if (req.headers.get("x-cron-secret") !== Deno.env.get("CRON_SECRET")) {
    return new Response(JSON.stringify({ error: "unauthorized" }), { status: 401 });
  }

  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL");
    const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
    const vapidPublicKey = Deno.env.get("VAPID_PUBLIC_KEY");
    const vapidPrivateKey = Deno.env.get("VAPID_PRIVATE_KEY");
    const vapidSubject = Deno.env.get("VAPID_SUBJECT") || "mailto:sevin.eldridge@gmail.com";

    if (!vapidPublicKey || !vapidPrivateKey) {
      return new Response(JSON.stringify({ error: "VAPID keys not configured" }), { status: 500 });
    }
    webpush.setVapidDetails(vapidSubject, vapidPublicKey, vapidPrivateKey);

    // Only this function ever reads push_subscriptions directly (RLS has
    // no client-facing policy on it at all) — service-role client, never
    // the anon key.
    const admin = createClient(supabaseUrl, serviceRoleKey);

    // Bounded per run — a burst of captures while this function is briefly
    // unavailable drains over successive 2-minute ticks instead of one
    // giant batch. idx_battle_log_unnotified makes this cheap even as the
    // table grows, since it's a partial index on exactly this predicate.
    const { data: captures, error } = await admin
      .from("battle_log")
      .select("id, defender, qk")
      .eq("attacker_won", true)
      .eq("notified", false)
      .limit(500);
    if (error) throw error;

    if (!captures || captures.length === 0) {
      return new Response(JSON.stringify({ ok: true, sent: 0, processed: 0 }), {
        headers: { "Content-Type": "application/json" },
      });
    }

    const defenderIds = [...new Set(captures.map((c) => c.defender))];
    const { data: subs, error: subsErr } = await admin
      .from("push_subscriptions")
      .select("user_id, endpoint, p256dh, auth_key")
      .in("user_id", defenderIds)
      .eq("attack_alerts", true);
    if (subsErr) throw subsErr;
    const subByUser = new Map((subs || []).map((s) => [s.user_id, s]));

    const payload = JSON.stringify({
      title: "Tile captured ⚔️",
      body: "One of your tiles was just taken in a raid — go check the damage.",
      url: ".",
    });

    let sent = 0;
    let pruned = 0;
    await Promise.all(
      captures.map(async (cap) => {
        const sub = subByUser.get(cap.defender);
        if (!sub) return; // not opted in (or no subscription at all) — still counts as "processed" below
        try {
          await webpush.sendNotification(
            { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth_key } },
            payload
          );
          sent++;
        } catch (err) {
          // 404/410 = the browser or push service has invalidated this
          // registration — same prune-on-expiry handling as send-energy-alerts.
          const status = err && (err.statusCode || err.status);
          if (status === 404 || status === 410) {
            await admin.from("push_subscriptions").delete().eq("user_id", cap.defender);
            pruned++;
          }
        }
      })
    );

    // "Processed", not "delivered" — a row marked here without a matching
    // subscription just means the defender wasn't opted in when it
    // happened, not that anything failed. See battle_log.notified's
    // comment in supabase.sql.
    await admin
      .from("battle_log")
      .update({ notified: true })
      .in("id", captures.map((c) => c.id));

    return new Response(JSON.stringify({ ok: true, sent, pruned, processed: captures.length }), {
      headers: { "Content-Type": "application/json" },
    });
  } catch (e) {
    return new Response(JSON.stringify({ error: String(e) }), { status: 500 });
  }
});
