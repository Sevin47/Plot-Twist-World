/*
  hCaptcha, for one call and one call only: signInAnonymously.

  Why it exists: "Play now" mints a real Supabase auth user with no
  identity behind it, which is exactly the endpoint a bot would hammer —
  and anonymous users count toward Supabase's MAU billing. Captcha
  protection is enabled on the Supabase project's auth endpoints, so the
  anonymous sign-in request is REJECTED without a fresh token.

  What does NOT need a token: signInWithGoogle and linkIdentity. Supabase's
  captcha protection covers the endpoints it can challenge inline
  (anonymous, password, OTP) — OAuth is a redirect out to the provider and
  is never captcha-gated. Don't add it there; you'd be solving a challenge
  for a request that ignores it.

  Invisible mode on purpose: the whole point of the guest flow is that one
  press opens the map. A checkbox in front of "Play now" is a smaller wall
  than a sign-in, but it's still a wall. Invisible hCaptcha only shows a
  challenge when it doesn't like the look of the request, which is the
  behaviour we actually want. hCaptcha's terms require the privacy/terms
  attribution to be visible when the badge is hidden — that's the line of
  small print under the buttons on the start screen, don't remove it.

  Degrades quietly: with no VITE_HCAPTCHA_SITE_KEY configured this is a
  no-op that returns no token. That's correct for a local dev build
  against a project without captcha protection, and if the project DOES
  have it on, the sign-in fails with a real error rather than silently
  half-working.

  *** hCaptcha does not run on localhost. *** A real site key refuses the
  host outright ("[hCaptcha] Warning: localhost detected") and execute()
  rejects with a bare `network-error`, which looks exactly like a flaky
  connection and isn't one. "Play now" therefore CANNOT be exercised end
  to end on a dev server — verify it on the deployed origin, which also
  has to be listed in the site key's hostname allowlist in the hCaptcha
  dashboard. To work on the flow locally, either leave
  VITE_HCAPTCHA_SITE_KEY unset (and turn captcha protection off in
  Supabase), or pair hCaptcha's published test key
  (10000000-ffff-ffff-ffff-000000000001) with its matching test secret in
  the Supabase dashboard — the real secret rejects test tokens.
*/

const SITE_KEY = import.meta.env.VITE_HCAPTCHA_SITE_KEY;

export const CAPTCHA_ON = !!SITE_KEY;

// The script is only fetched the first time someone actually presses Play
// now — a returning player with a session never pays for it at all.
//
// The api.js `onload` PARAMETER, not the script element's onload event:
// the element fires as soon as the file is fetched, which is earlier than
// the API being usable, and rendering into that gap gets you "[hCaptcha]
// should not render before js api is fully loaded" and a widget that
// silently doesn't work. The global below is the handshake hCaptcha
// documents for it.
const READY_CB = "__ptwHcaptchaReady";
let scriptPromise = null;
function loadHcaptcha() {
  if (scriptPromise) return scriptPromise;
  scriptPromise = new Promise((resolve, reject) => {
    if (window.hcaptcha?.render) { resolve(window.hcaptcha); return; }
    window[READY_CB] = () => resolve(window.hcaptcha);
    const s = document.createElement("script");
    // render=explicit: nothing auto-renders, we place the one widget below
    s.src = `https://js.hcaptcha.com/1/api.js?render=explicit&onload=${READY_CB}`;
    s.async = true;
    s.defer = true;
    s.onerror = () => { scriptPromise = null; reject(new Error("hCaptcha script blocked or offline")); };
    document.head.appendChild(s);
  });
  return scriptPromise;
}

// One widget for the life of the page, reset between uses. Parked
// off-screen rather than display:none — an invisible widget still renders
// its challenge overlay relative to a real, laid-out host element, and
// display:none has been known to break that.
let widgetId = null;
async function ensureWidget() {
  const hc = await loadHcaptcha();
  if (widgetId != null) return { hc, id: widgetId };
  const host = document.createElement("div");
  host.style.cssText = "position:fixed;left:-9999px;bottom:0;";
  document.body.appendChild(host);
  widgetId = hc.render(host, { sitekey: SITE_KEY, size: "invisible" });
  return { hc, id: widgetId };
}

// Resolves to a single-use token, or null when captcha isn't configured.
// Throws if the player dismissed the challenge or hCaptcha itself failed —
// the caller turns that into a message rather than a silent dead button.
export async function captchaToken() {
  if (!CAPTCHA_ON) return null;
  const { hc, id } = await ensureWidget();
  try {
    // { async: true } makes execute() return a promise instead of relying
    // on the render-time callbacks.
    const res = await hc.execute(id, { async: true });
    if (!res?.response) throw new Error("challenge-closed");
    return res.response;
  } finally {
    // Tokens are one-shot; a stale one on the widget makes the NEXT
    // execute resolve instantly with a token the server will reject.
    try { hc.reset(id); } catch { /* widget already gone */ }
  }
}

// hCaptcha's raw errors are strings like "challenge-closed" / "network-error".
export function captchaMessage(err) {
  const raw = (err?.message || String(err || "")).toLowerCase();
  if (raw.includes("closed")) return "Captcha dismissed — press Play now to try again.";
  if (raw.includes("network") || raw.includes("blocked") || raw.includes("offline")) {
    return "Couldn't reach the captcha service — check your connection or an ad blocker, then try again.";
  }
  return null;
}
