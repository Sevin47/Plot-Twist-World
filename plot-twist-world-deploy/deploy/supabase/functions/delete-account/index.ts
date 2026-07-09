// Deletes the calling user's account and everything tied to it.
//
// This has to be an edge function rather than a Postgres RPC because
// deleting a row from auth.users requires the Supabase service-role key,
// which must never be shipped to the client or embedded in a `security
// definer` SQL function callable by `authenticated` — this function is the
// one place that key is allowed to exist, and it never leaves this server.
//
// Deploy: `supabase functions deploy delete-account` (see HANDOFF.md /
// the plan for the one-time `supabase login` / `supabase link` setup).
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

// Supabase's edge runtime does NOT add CORS headers automatically — every
// response (including the OPTIONS preflight and every error path) needs
// these explicitly, or the browser blocks the whole request before our code
// even gets to run. Skipping the OPTIONS check specifically is what caused
// the real bug here: the browser's preflight (no Authorization header) fell
// through to the "missing authorization" 401 path, and a non-2xx preflight
// response fails CORS outright regardless of headers.
const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    const authHeader = req.headers.get("Authorization");
    if (!authHeader) {
      return json({ error: "missing authorization" }, 401);
    }

    const supabaseUrl = Deno.env.get("SUPABASE_URL");
    const anonKey = Deno.env.get("SUPABASE_ANON_KEY");
    const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");

    // Identify the caller from their own JWT — never trust a client-supplied
    // user id for a destructive operation like this.
    const callerClient = createClient(supabaseUrl, anonKey, {
      global: { headers: { Authorization: authHeader } },
    });
    const { data: userData, error: userErr } = await callerClient.auth.getUser();
    if (userErr || !userData?.user) {
      return json({ error: "invalid session" }, 401);
    }
    const uid = userData.user.id;

    // Service-role client — only ever used here, server-side.
    const admin = createClient(supabaseUrl, serviceRoleKey);

    // Fully delete (not just unlink) this account's tiles: `buy_unowned_tile`
    // treats "no row for this qk" as the only valid unowned state, matching
    // abandon_tile's behavior — leaving a row behind with owner=null would
    // permanently block anyone else from ever buying that tile again.
    const { error: tilesErr } = await admin.from("tiles").delete().eq("owner", uid);
    if (tilesErr) {
      return json({ error: tilesErr.message }, 500);
    }

    // Deletes the profiles row too, via `on delete cascade` from auth.users.
    const { error: delErr } = await admin.auth.admin.deleteUser(uid);
    if (delErr) {
      return json({ error: delErr.message }, 500);
    }

    return json({ ok: true });
  } catch (e) {
    return json({ error: String(e) }, 500);
  }
});
