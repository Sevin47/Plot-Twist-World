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

Open the printed URL. With no configuration the game runs in **single-player
mode**: your save and your copy of the world live in this browser's
localStorage.

## Enable multiplayer (free, ~5 minutes)

The shared world (global tile ownership, the market, offline sale payouts, the
leaderboard) needs one tiny database table.

1. Create a free project at https://supabase.com
2. In the Supabase dashboard, open **SQL Editor**, paste the contents of
   `supabase.sql`, and run it.
3. In **Project Settings → API**, copy the Project URL and the `anon` public
   key.
4. Copy `.env.example` to `.env` and fill in both values. For deployed sites,
   set the same two variables in your host's environment settings instead.

That's it — every visitor to your deployed site now plays on the same planet.

## Deploy

Build output is a fully static site in `dist/`.

**Netlify** — either drag-and-drop: `npm run build`, then drag the `dist`
folder onto https://app.netlify.com/drop — or connect your Git repo with build
command `npm run build` and publish directory `dist`. Add the two `VITE_...`
environment variables under Site settings → Environment variables.

**Vercel** — push to GitHub, import the repo at https://vercel.com/new. Vercel
auto-detects Vite. Add the two `VITE_...` variables under Project → Settings →
Environment Variables, then redeploy.

**GitHub Pages** — the Vite config uses `base: './'`, so builds work from any
subpath. Simplest path: in your repo, Settings → Pages → Source: GitHub
Actions, and pick the suggested "Static site / Vite" workflow (it runs
`npm run build` and publishes `dist`). Note that Pages has no environment
variable UI at build time — put your two `VITE_...` values in the workflow file
or repo Action secrets referenced by the workflow.

## Honest limitations

- **Trust-based multiplayer.** Writes go straight from browsers to the shared
  table with the public anon key, so a motivated cheater could edit world
  state. Fine for friends and demos; a production version should move buy/
  trade logic into server-side functions (Supabase Edge Functions) that
  validate every transaction.
- **Last-write-wins races.** Two players buying the same tile in the same
  instant can conflict; the game detects this and refunds the loser, but a
  real database transaction would eliminate it entirely.
- **Approximate coastlines.** Terrain comes from Natural Earth 1:50m data
  rasterized to a 2048×1024 mask, so land/coast/water classification is
  kilometer-scale, not parcel-scale.
- **Personal saves are per-browser.** There are no passworded accounts; your
  save lives in localStorage. Real accounts would use Supabase Auth.

## Project layout

- `src/PlotTwistWorld.jsx` — the entire game (map engine, economy, trading, UI)
- `src/storage.js` — storage adapter: localStorage and/or Supabase
- `supabase.sql` — one-time database setup for multiplayer
