// Fires the opt-in "your energy reset" push to every registered device
// that has energy_alerts on. Invoked once a day at 00:00 UTC by the
// pg_cron job in supabase.sql — never called from the client. Not a
// per-user computation: energy resets for everyone at the same UTC
// instant (see reset_daily_energy in supabase.sql), so there's nothing to
// check per-row here beyond the opt-in flag — no need to look at
// energy_date/energy at all.
//
// Deploy: `supabase functions deploy send-energy-alerts --no-verify-jwt`
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

    // Only this function ever reads this table (RLS has no client-facing
    // policy on it at all) — service-role client, never the anon key.
    const admin = createClient(supabaseUrl, serviceRoleKey);
    const { data: subs, error } = await admin
      .from("push_subscriptions")
      .select("user_id, endpoint, p256dh, auth_key")
      .eq("energy_alerts", true);
    if (error) throw error;

    // "." not "/" — sw.js resolves this relative to its own script URL,
    // which matters because this app can be deployed at a GitHub Pages
    // subpath rather than a domain root.
    const payload = JSON.stringify({
      title: "Energy refilled ⚡",
      body: "Your daily claim energy just reset — go grab some land.",
      url: ".",
    });

    let sent = 0;
    let pruned = 0;
    await Promise.all(
      (subs || []).map(async (row) => {
        const subscription = {
          endpoint: row.endpoint,
          keys: { p256dh: row.p256dh, auth: row.auth_key },
        };
        try {
          await webpush.sendNotification(subscription, payload);
          sent++;
        } catch (err) {
          // 404/410 = the browser or push service has invalidated this
          // registration (uninstalled, cleared data, etc.) — stale rows
          // would otherwise just accumulate and fail silently forever.
          const status = err && (err.statusCode || err.status);
          if (status === 404 || status === 410) {
            await admin.from("push_subscriptions").delete().eq("user_id", row.user_id);
            pruned++;
          }
        }
      })
    );

    return new Response(JSON.stringify({ ok: true, sent, pruned, total: (subs || []).length }), {
      headers: { "Content-Type": "application/json" },
    });
  } catch (e) {
    return new Response(JSON.stringify({ error: String(e) }), { status: 500 });
  }
});
