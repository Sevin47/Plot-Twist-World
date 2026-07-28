import { supabase, MULTIPLAYER } from "./storage.js";
import { captchaToken } from "./captcha.js";

/*
  Thin wrapper around Supabase Auth. Two ways in:

    playAsGuest()      — an anonymous auth user. A real row in auth.users
                         with the ordinary `authenticated` role, so every
                         RPC and RLS policy applies unchanged; the only
                         difference is profiles.is_guest, which the server
                         sets from the JWT's is_anonymous claim and uses to
                         hold guests to the tutorial (see the GUEST
                         ACCOUNTS section in supabase.sql).
    signInWithGoogle() — the permanent account.

  linkGoogle() upgrades the first into the second WITHOUT changing user_id,
  which is the whole reason guest play is safe to offer: a guest's home
  tile, wallet, rarity roll and streak are already stored against the
  identity they keep.

  External setup this depends on, none of it expressible in code: the
  Google Cloud + Supabase OAuth config the Google flow always needed, plus
  "Allow anonymous sign-ins" and manual identity linking, both enabled in
  the Supabase dashboard's Authentication settings. Captcha protection is
  also on for that project, which is why playAsGuest carries a token —
  see captcha.js.
*/

const redirectTo = () => window.location.origin + window.location.pathname;

export function signInWithGoogle() {
  if (!supabase) return Promise.reject(new Error("Supabase not configured"));
  return supabase.auth.signInWithOAuth({
    provider: "google",
    options: { redirectTo: redirectTo() },
  });
}

// Captcha-gated (see captcha.js): this is the one endpoint that hands out
// an account to nobody in particular, so it's the one a bot would grind —
// and every anonymous user it mints counts toward Supabase's MAU billing.
// Returns supabase's own { data, error } shape either way, including when
// it's the captcha that failed, so callers have a single thing to check.
export async function playAsGuest() {
  if (!supabase) return { data: null, error: new Error("Supabase not configured") };
  let token;
  try {
    token = await captchaToken();
  } catch (e) {
    return { data: null, error: e };
  }
  return supabase.auth.signInAnonymously(token ? { options: { captchaToken: token } } : undefined);
}

// Attaches a Google identity to the CURRENT (anonymous) user. Redirects
// out to Google and back, exactly like signInWithGoogle — the session that
// returns has the same user id with is_anonymous now false.
//
// The one failure that matters: if that Google account is already attached
// to a different user (a returning player who guest-played on a new
// device), Supabase refuses with an "identity already exists" style error.
// There is no merge to offer there — two separate worlds can't become one —
// so the caller's job is to explain that and offer a plain sign-in, which
// abandons the guest world. See linkErrorIsIdentityTaken.
export function linkGoogle() {
  if (!supabase) return Promise.reject(new Error("Supabase not configured"));
  return supabase.auth.linkIdentity({
    provider: "google",
    options: { redirectTo: redirectTo() },
  });
}

export function linkErrorIsIdentityTaken(err) {
  const msg = (err?.message || "").toLowerCase();
  return msg.includes("already") && (msg.includes("identity") || msg.includes("linked") || msg.includes("exists"));
}

export const isGuestSession = (session) => !!session?.user?.is_anonymous;

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
