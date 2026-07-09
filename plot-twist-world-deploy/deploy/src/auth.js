import { supabase, MULTIPLAYER } from "./storage.js";

/*
  Thin wrapper around Supabase Auth's Google OAuth flow. Accounts are
  mandatory — there is no anonymous play — so this is the only way into
  the game. See HANDOFF.md / the plan for the external Google Cloud +
  Supabase dashboard setup this depends on.
*/

export function signInWithGoogle() {
  if (!supabase) return Promise.reject(new Error("Supabase not configured"));
  return supabase.auth.signInWithOAuth({
    provider: "google",
    options: { redirectTo: window.location.origin + window.location.pathname },
  });
}

export function signOut() {
  return supabase ? supabase.auth.signOut() : Promise.resolve();
}

export async function getSession() {
  if (!supabase) return null;
  const { data } = await supabase.auth.getSession();
  return data.session;
}

// Returns an unsubscribe function. cb receives (event, session) — callers
// MUST check event, not just session: this fires for TOKEN_REFRESHED (a
// routine background token renewal, not a new login) as well as real
// sign-in/sign-out, and treating a refresh as a fresh sign-in will blow
// away any in-memory game state built up since the real sign-in.
export function onAuthStateChange(cb) {
  if (!supabase) return () => {};
  const { data } = supabase.auth.onAuthStateChange((event, session) => cb(event, session));
  return () => data.subscription.unsubscribe();
}

export { supabase, MULTIPLAYER };
