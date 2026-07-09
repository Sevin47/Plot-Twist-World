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

Deno.serve(async (req) => {
  try {
    const authHeader = req.headers.get("Authorization");
    if (!authHeader) {
      return new Response(JSON.stringify({ error: "missing authorization" }), { status: 401 });
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
      return new Response(JSON.stringify({ error: "invalid session" }), { status: 401 });
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
      return new Response(JSON.stringify({ error: tilesErr.message }), { status: 500 });
    }

    // Deletes the profiles row too, via `on delete cascade` from auth.users.
    const { error: delErr } = await admin.auth.admin.deleteUser(uid);
    if (delErr) {
      return new Response(JSON.stringify({ error: delErr.message }), { status: 500 });
    }

    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  } catch (e) {
    return new Response(JSON.stringify({ error: String(e) }), { status: 500 });
  }
});
