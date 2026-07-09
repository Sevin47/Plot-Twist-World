# Plot Twist: World Deed

A parody land-grab idle game on one shared Earth. Buy ~300 m tiles anywhere on
the planet, roll deed rarities, build towers, and trade tiles with other
players on an open market. Virtual currency only — nothing is worth real money,
and the "ads" are fictional.

## Run locally

```bash
npm install
npm run dev
```

Accounts are mandatory — there is no single-player/local-only mode. Without
Supabase configured (below), the game shows an "unconfigured" screen instead
of a menu.

## Set up accounts + the shared world (Supabase, free)

Every player signs in with Google; their wallet, tiles, streak and username
live in one Supabase Postgres project — the server, not the browser, is the
source of truth (see "Server-validated economy" below for why that matters).

1. Create a free project at https://supabase.com
2. In the Supabase dashboard, open **SQL Editor**, paste the contents of
   `supabase.sql`, and run it. This creates the `profiles`/`tiles` tables and
   every economy function (buy/sell/upgrade/abandon/etc.) as locked-down
   `security definer` RPCs — no table accepts a direct write from the client.
3. **Enable Google sign-in:** Authentication → Providers → Google. You'll
   need an OAuth 2.0 Client ID from https://console.cloud.google.com (APIs &
   Services → Credentials → Create Credentials → OAuth client ID → Web
   application). Set its **Authorized redirect URI** to
   `https://<your-project-ref>.supabase.co/auth/v1/callback`, and its
   **Authorized JavaScript origins** to your deployed site's origin plus
   `http://localhost:5173` for local dev. Paste the resulting Client ID +
   Secret into the Supabase Google provider settings.
4. Authentication → URL Configuration: add your deployed origin and
   `http://localhost:5173` to the allowed redirect URLs.
5. In **Project Settings → API**, copy the Project URL and the `anon` public
   key.
6. Copy `.env.example` to `.env` and fill in both values. For deployed sites,
   set the same two variables in your host's environment settings instead.
7. **Deploy the account-deletion function** (needed for the "Delete account &
   data" button — it uses the service-role key, which never touches the
   client): install the Supabase CLI, then from this directory run
   `supabase login`, `supabase link`, `supabase functions deploy delete-account`.

That's it — every visitor to your deployed site signs in with their own
Google account and plays on the same shared planet.

## Server-validated economy

Every economic action (buying, selling, upgrading, abandoning a tile,
claiming rent, the daily streak, the ad-boost) is a Postgres RPC that
computes price, rarity and balance itself from `auth.uid()` — never from
anything the client sends. Row-level security blocks direct table writes
entirely, so a modified client can display whatever it wants locally, but the
next real transaction is always checked against the actual server balance.
The one thing still client-supplied is *which district tier* a tile is (real
OpenStreetMap data the server doesn't independently re-derive) — see "Honest
limitations" below.

## Enable real geography (free, ~3 minutes)

District classification (which tiles are water, downtown, residential,
industrial, park, etc.) can read **actual OpenStreetMap data** instead of an
approximate built-in model.

1. Sign up for a free account at https://protomaps.com and create an API key
   at https://app.protomaps.com (free for non-commercial use, 1M tile
   requests/month soft cap).
2. On that key's settings, add your site's origin to the allowed CORS list —
   e.g. `https://yourname.github.io` for GitHub Pages, or `localhost` for
   local dev (which is allowed automatically).
3. Add `VITE_PROTOMAPS_KEY=your-key` to `.env` (or your host's environment
   variables, same as the Supabase ones above).

Without this, every tile just shows "Surveying…" forever and can't be
bought — there's no procedural fallback anymore; the game would rather say
"we don't know yet" than guess.

## Deploy

Build output is a fully static site in `dist/`.

**Netlify** — either drag-and-drop: `npm run build`, then drag the `dist`
folder onto https://app.netlify.com/drop — or connect your Git repo with build
command `npm run build` and publish directory `dist`. Add the two `VITE_...`
environment variables (all three `VITE_...` ones) under Site settings → Environment variables.

**Vercel** — push to GitHub, import the repo at https://vercel.com/new. Vercel
auto-detects Vite. Add the three `VITE_...` variables under Project → Settings →
Environment Variables, then redeploy.

**GitHub Pages** — the Vite config uses `base: './'`, so builds work from any
subpath. Simplest path: in your repo, Settings → Pages → Source: GitHub
Actions, and pick the suggested "Static site / Vite" workflow (it runs
`npm run build` and publishes `dist`). Note that Pages has no environment
variable UI at build time — put your `VITE_...` values in the workflow file
or repo Action secrets referenced by the workflow.

## Honest limitations

- **Vector classification has a fixed reference resolution (~2.4km tiles).**
  A single deed still gets one classification for its whole ~306m footprint,
  so land right at a complex coastline or a landuse boundary can occasionally
  read as the wrong side.
- **Building-density fallback is a rough estimate.** Where OSM has no
  explicit landuse tag, district tier comes from sampling how much of a
  cell's footprint is covered by real building polygons — a genuine
  measurement, but the specific thresholds (what counts as "downtown" vs.
  "suburbs") are a first pass, not carefully tuned.
- **Tile tier is still client-reported.** The server validates balance,
  ownership and rarity for every transaction, but *which district tier* a
  spot is comes from the buyer's own real-time OSM read — fully verifying
  that server-side would mean re-fetching and parsing vector tiles in
  Postgres/an edge function, a much bigger undertaking. A malicious client
  could at most mis-tier its own purchase to pay a cheaper listed price;
  it can't fabricate balance, ownership, or rarity.
- **Protomaps free tier is a shared 1M-request/month soft cap** across every
  player using your deployment's key.

## Project layout

- `src/PlotTwistWorld.jsx` — the entire game (map engine, economy, trading, UI)
- `src/storage.js` — the shared Supabase client
- `src/auth.js` — Google sign-in / sign-out / session helpers
- `supabase.sql` — one-time database setup: tables, RLS, and every economy
  RPC (buy/sell/upgrade/abandon/rent/daily/boost/leaderboard)
- `supabase/functions/delete-account/` — edge function for account deletion
  (needs the service-role key, so it can't be a client-callable RPC)
