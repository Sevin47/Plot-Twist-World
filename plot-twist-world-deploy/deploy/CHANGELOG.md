# Changelog

Player-visible changes. Bumped together with `package.json`'s `version`,
which is the single source of truth the corner badge and the new-version
poll both read (see `vite.config.js`).

## 1.22.1

- **Your balance no longer looks stuck when you're starting out.** One
  starter tile earns around ₲0.027 a second, so the whole-₲ display only
  moved once every ~37 seconds — which read as broken, right while the
  tutorial was telling you it climbs every second. Small balances earning
  under ₲1/s now show two decimals, so you can watch it tick. It goes back
  to whole ₲ on its own once your income is fast enough to see.

## 1.22.0

### The tutorial now points at things, and waits for you to do them

- **Every step highlights its actual target.** The tour used to describe
  where to look ("the ⚡ counter at the top") from a fixed panel that never
  moved. It now dims the screen around the real button, chip or counter it's
  talking about — including your own tile on the map, spotlit through the
  live camera so it stays lit while you pan and zoom.
- **Steps that teach an action wait for the action.** Opening your tile,
  starting a build, zooming out to world view and finding the Assets tab no
  longer have a Next button to click past. If a step sits untouched for 20
  seconds it offers to skip itself, and "Skip tour" is always there.
- **Eight steps instead of five**, each one line instead of a paragraph, and
  the tour now ends on your portfolio rather than on the map.
- **The tour repositions itself before it asks.** Panned away from your
  tile, already zoomed out, already on the tab it's about to send you to —
  each step puts the world back into a state where its instruction actually
  makes sense, which also means replaying it from the pause menu no longer
  skips half the steps.

### Tips that arrive when they're relevant

- **Six one-shot hints**, each shown the first time it matters rather than
  up front: rent collecting itself, unlocking new territory, running out of
  energy, contracts waiting to be claimed, being raided for the first time,
  and — one level before you get there — what redeveloping a maxed tile
  does. Existing players won't see them; they're for people meeting each
  thing for the first time.
- **Tile sheets now name the ceiling.** Any tile you can still build on
  says what happens at Tower, so the redevelop loop stops being a surprise
  you find by accident.

### Onboarding progress follows your account

- **Finishing the tutorial on your phone now counts on your desktop.**
  Progress lived in per-device browser storage, so switching device replayed
  the whole thing. It's on your account now.

### One free rush, for everyone starting out

- **New accounts begin with a rush credit.** Your first build timer can be
  skipped for free, so rushing is something you've met once before you're
  ever asked to pay for it. Existing balances are untouched.

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
