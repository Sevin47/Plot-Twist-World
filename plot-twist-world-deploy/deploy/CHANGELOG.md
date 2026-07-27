# Changelog

Player-visible changes. Bumped together with `package.json`'s `version`,
which is the single source of truth the corner badge and the new-version
poll both read (see `vite.config.js`).

## 1.21.0

### NPC landlords place in neighbourhoods, and catch up while you're away

- **Spawn budget accrues instead of expiring.** The 2h figure was a boolean
  cooldown, so a region produced at most one tile per visit no matter how
  long you'd been gone — and since nothing runs server-side while a region
  is unwatched (there is no cron), an overnight absence produced one tile.
  A region now banks one spawn per whole 2h since its last one, capped at
  12h of arrears, and spends the balance on the next sync. Unspent budget
  stays owed rather than being forfeited, so tiles that had nowhere legal
  to go still land once the viewport offers somewhere to put them.
- **Tiles cluster into neighbourhoods under one company.** Candidates are
  now ranked by how deep a quadkey prefix they share with existing NPC
  land, and each tile is assigned to whichever company already holds the
  most of that block. The first tile in a fresh block lands at random and
  the rest grow outward from it under that brand, instead of eight
  unrelated companies landing one tile apart.
- **Per-block cap raised from 4 to 12** so a neighbourhood is big enough to
  read as one, giving a region roughly two clusters rather than six thin
  scatterings.
- **Fixed: NPC land only ever appeared toward the top-left of the screen.**
  The client offered the server candidate tiles by sweeping the viewport
  row-major and stopping at a cap, so the server's entire legal world was
  the top-left corner of wherever you were looking. It now sweeps the full
  viewport and takes a uniform random sample. This mattered more with
  clustering than without it — a biased seed drags its whole neighbourhood
  along with it.

Unchanged: NPCs still never claim in a ~9.8km block where any real player
owns anything, still never take landmark tiles, and still never attack.

*Server-side changes live in `supabase.sql` (`sync_npc_presence`) and must
be re-applied to the database for this release to do anything.*
