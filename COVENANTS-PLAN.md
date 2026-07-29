# Covenants Plan — Two-Sided Tile Traits, Drafted on Redevelop

> **STATUS — read this first.** This document is the original design
> handoff (shipped 1.25.0) plus a revision log at the bottom. The body
> below still describes the **build-completion** offer point and a
> 13-card catalogue; both have since changed. Two revisions supersede it:
>
> - **1.26.0** — the offer point moved to **redevelop**, and an accepted
>   covenant became permanent for the owner's tenure (it survives every
>   rebuild, and ends only when the tile changes hands). `release_covenant`
>   and the `tile_covenants` side table were dropped.
> - **1.32.0** — **declining is permanent too**, one offer per tile per
>   tenure; nine more standard cards; a rare `tier` of six "deal" cards
>   behind their own gate. See "Revision, 2026-07-29" at the end.
>
> Where the body and a revision disagree, the revision wins, and
> `supabase.sql` wins over both.

Handoff document for the implementation session. Read HANDOFF.md first for
architecture/conventions, then PACING-PLAN.md (build timers — this feature
hangs off their completion event) and LANDMARKS-PLAN.md (the perk-value
doctrine this deliberately bends, see "The income rule" below). All SQL goes
in `Plot-Twist-World/plot-twist-world-deploy/deploy/supabase.sql`
(idempotent, re-run the whole file in the Supabase SQL editor after
changes); all client work in `src/PlotTwistWorld.jsx`. Deploy = push to
main (GitHub Actions), expect CDN lag of up to ~1 min on the Pages asset.

## Why (context from design discussion)

The design question was whether a roguelike-deckbuilder direction fits. The
answer that came out of it: the **structure** doesn't (a run needs an ending
where you lose the board, which is impossible with permanent, shared,
PvP-contested land), but the **draft-with-tradeoffs mechanic** does, and it
addresses a real structural gap this game has.

The gap, stated plainly: **the portfolio is a deck with no deckbuilding.**
Rent is a straight sum over holdings —

```
sum(rps × rarity × (1 + level) × (1 + 0.25 × prestige))
```

— and nothing in that formula can be dragged down by a bad holding. Owning
more tiles is unconditionally better. There is no such thing as a bad
acquisition, which is why claiming reads as a treadmill rather than a
decision, and why `abandon_tile` isn't a strategic act but an undo button
(its 50%-of-`paid` refund confirms nobody expected it to be one).

The same gap shows up as "a Tower is a dead tile": once a tile is maxed it
never asks the player anything again, so a portfolio of forty tiles is forty
things you scroll past.

Covenants attack both at once. A covenant is a **permanent, two-sided trait
attached to one tile**, drafted from three options at each build completion.
Every card has a real upside and a real cost, so accepting one is a genuine
decision, and the resulting tiles have *identity* — two Downtown tiles stop
being interchangeable, which incidentally gives the market real depth for
the first time.

### The income rule, and why this is a deliberate exception

LANDMARKS-PLAN.md states it flatly: *perks buy tempo/convenience, never raw
income.* Several covenants below move rent directly, which looks like a
violation. It isn't, and the distinction is worth writing down because it's
the line every future feature here has to walk:

> **The rule bans free multipliers on what you already hold.** A landmark
> perk that granted +rent would pay the already-ahead player for owning
> things — a win-more engine, no decision attached. A covenant that grants
> +25% rent and −40% defense is not free; it is a *price*. The player gave
> something up, chose to, and can be punished for choosing wrong.

The operative test for any new card: **name the build it's bad for.** If
you can't, it isn't a covenant, it's a perk, and it doesn't belong here.
`Prime Frontage` (below) is the single deliberate exception — see its note.

### On making "hurt" survivable

The obvious trap: in a roguelike you accept a curse because the run ends —
a bad card is a forty-minute problem. Here a debuff is *forever*, sitting on
an asset the player paid for and may want to sell. Loss aversion runs about
2:1, so symmetric math produces an asymmetric feeling. Four rules, each of
which shows up as a concrete constraint later in this document:

1. **Never non-consensual.** A covenant only ever lands on a tile whose
   owner picked it from an offer. Nothing in this system wanders over and
   modifies a tile the player was quietly holding. Declining is always free
   and always available. *(1.32.0: still free, but one-time — see the
   revision log. The rule it protects is "nothing lands on you without a
   yes", and that is untouched.)*
2. **Always escapable.** `redevelop_tile` clears the covenant, and a later
   build completion can replace it outright. No card is a trap the player
   cannot get out of. (`Freehold` is the one card that closes its own exit,
   which is exactly why its downside is a *restriction* rather than a
   penalty — see the catalogue.) *(**Superseded, 1.26.0**: a covenant now
   survives redevelopment, so the exit is giving the tile up — sell,
   abandon, or lose it. Every card is still escapable; the price is the
   tile rather than a rebuild.)*
3. **Tradeoff, not tax.** "−30% rent, +100% defense" is a card. "−30% rent"
   is a punishment. Every card must have a build it is actively good for.
4. **The floor is "nothing happened," not "you lost something."** Declining
   all three offers leaves the tile exactly as it is today. A player who
   never engages with this system is never worse off than before it shipped.

## Core design

- A **covenant** is a row in `covenant_defs` — a named card carrying a
  `mods` jsonb of effect keys. Cards are data, not code: the hook points
  below read *effect keys*, so adding a thirteenth card that recombines
  existing effects is a seed row and nothing else. Same architecture as
  `contract_defs`, `collections` and `landmarks`.
- A tile holds **at most one** covenant (`tiles.covenant`, null by default).
- **Offers happen at build completion.** All three completion paths
  (`finish_builds`, `rush_build`, and `upgrade_tile`'s `dev_mode` instant
  path) generate an offer of **3 distinct cards**, weighted-random from the
  pool eligible for that tile's just-completed level.
  *(**Superseded, 1.26.0**: the sole offer point is `redevelop_tile`, at
  level 0, once per tile per tenure. Rushing collapses build timers by
  design, so completions arrive seconds apart and permanent decisions
  arrived faster than anyone could care about them. **1.32.0**: ~7% of
  offers replace one of the three with a rare card.)*
- The offer is **stored server-side** (`covenant_offers`) so it cannot be
  rerolled by refetching. It persists until answered; a later completion on
  the same tile replaces it.
- **Accepting replaces** whatever covenant the tile already had, free.
  Declining keeps the current one. *(**Superseded, 1.26.0/1.32.0**: a tile
  is offered a covenant once per tenure — only when it has none and its
  owner hasn't declined — so there is nothing to replace. Accepting or
  declining both end the tile's offers until it changes hands.)* This is
  deliberate: it keeps every build
  completion a live moment rather than only the first one, and the cards
  whose cost is a *restriction* (`max_level`, `no_redevelop`) self-enforce,
  because they remove the future builds that would have offered a
  replacement.
- **Covenants transfer with the tile** on a market sale. This is the whole
  reason the market gets interesting — but it makes disclosure a fairness
  requirement, not a nicety: the covenant must be visible on the listing
  (see Client).
- **Cleared by**: `redevelop_tile` (the escape hatch, and redevelop's new
  second purpose), and attack capture (which already wipes
  level/rarity/prestige — covenant joins that list).
- **Existing tiles are untouched.** `covenant` defaults to null and a null
  covenant behaves exactly as the game does today. No backfill — same
  reasoning as `rush_credits` in PACING-PLAN.md; backfilling would be a
  silent economy change.

## The card catalogue (v1 — 13 cards)

*(Now 22 standard + 6 rare as of 1.32.0. The v1 thirteen below are
unchanged in their numbers; the additions are listed in the revision log
and, authoritatively, in the `covenant_defs` seed in `supabase.sql`.)*

`mods` keys are documented under Schema. Weights are relative roll
frequency within the eligible pool. "Offer at" restricts which
just-completed level can draw the card.

| Card | Effect | `mods` | Offer at | W |
|---|---|---|---|---|
| **Prime Frontage** | +15% rent. Nothing else. | `{"rent":1.15}` | any | 4 |
| **Corner Lot** | +25% rent while you own 3+ tiles in this block | `{"rent":1.25}`, `cond:block3` | any | 8 |
| **Anchor Tenant** | +25% rent, −40% defense | `{"rent":1.25,"def":0.6}` | any | 10 |
| **Heritage Listing** | +40% rent, never builds past Apartments | `{"rent":1.4,"max_level":3}` | ≤2 | 8 |
| **Ground Lease** | +60% rent for 14 days, then earns nothing until redeveloped | `{"rent":1.6,"expires_days":14,"after":{"rent":0}}` | any | 6 |
| **Fortified Block** | ×2 defense, rent halved | `{"rent":0.5,"def":2}` | any | 10 |
| **Gated Community** | +50% defense, attacks here cost the attacker double, −15% rent | `{"rent":0.85,"def":1.5,"atk_cost":2}` | any | 8 |
| **Conservation Easement** | Can never be attacked, −25% rent | `{"rent":0.75,"no_attack":true}` | any | 6 |
| **Brownfield** | Builds here 50% faster and 25% cheaper, −30% rent | `{"rent":0.7,"build_time":0.5,"build_cost":0.75}` | ≤2 | 8 |
| **Union Site** | Builds here take twice as long but cost half, +10% rent | `{"rent":1.1,"build_time":2,"build_cost":0.5}` | ≤2 | 8 |
| **Absentee Deed** | Earns at full rate while offline, −25% while online | `{"rent":0.75,"rent_offline":2}` | any | 8 |
| **Mixed Use** | +20% rent, can never be listed on the market | `{"rent":1.2,"no_list":true}` | any | 8 |
| **Freehold** | +20% rent, immune to repossession, can never be redeveloped | `{"rent":1.2,"no_redevelop":true,"no_decay":true}` | any | 6 |

**Notes on specific cards:**

- **Prime Frontage** is the deliberate no-downside jackpot, at the lowest
  weight in the pool (~4%). A draft system where every option costs
  something reads as a tax no matter how fair the math is; one rare pure
  win is what makes the other twelve feel like choices instead of
  punishments. Keep it rare and keep it small — 15% is a nice draw, not a
  build-defining one.
- **Corner Lot** is the only conditional card in v1. Its condition reads
  the player's *other* holdings but its effect is purely local, which is
  what keeps it cheap (see Deferred — cards that *modify* other tiles are a
  different and much more expensive thing).
- **Ground Lease** is the sharpest card and the one to watch in testing.
  "Then earns nothing until redeveloped" is survivable specifically because
  redevelop exists as a known, priced exit — verify that reads clearly in
  the UI before shipping, because "my tile stopped earning" is the single
  most alarming thing this feature can do to someone.
- **Absentee Deed**'s `rent_offline: 2` multiplies the tile's contribution
  *within the offline branch*, which already runs at 0.5× — so 2 × 0.5 = a
  full-rate offline tile. That's the card in one line: earns the same asleep
  as awake, 25% less awake. It is deliberately the best card in the pool for
  a genuinely casual player, which is the "active vs casual is a rate
  difference, not a viability difference" principle from PACING-PLAN.md
  showing up as a card.
- **Freehold** blocks its own escape hatch. That's legal under rule 2 above
  only because its cost is a *restriction* (no more prestige cycles), never
  a penalty — a Freehold tile is strictly better than a plain tile at its
  current level, forever. At level 4 it is genuinely permanent; the player
  can still sell or abandon.

## Schema

```sql
-- ══════════════════════════════════════════════════════════════════
-- Covenants: two-sided permanent traits on individual tiles, drafted
-- three-at-a-time when a build completes.
--
-- WHY THIS EXISTS: rent is a straight sum over holdings, so owning more
-- was unconditionally better and no acquisition was ever a real decision
-- (see COVENANTS-PLAN.md "Why"). A covenant is the first thing in this
-- game that can make a specific tile WORSE in exchange for making it
-- better at something else — which is what turns a portfolio into a set
-- of choices instead of a running total.
--
-- THE INCOME RULE: LANDMARKS-PLAN.md bans perks that grant raw income.
-- Covenants move rent directly and that is deliberate — the rule bans
-- FREE multipliers on existing holdings (a win-more engine with no
-- decision attached). A covenant's rent is bought with defense, build
-- ceiling, liquidity or tempo. The test for any new card: name the build
-- it's bad for. If you can't, it's a perk, not a covenant.
--
-- CARDS ARE DATA. Every hook below reads an EFFECT KEY out of `mods`,
-- never a card code (the sole exception is nothing — `cond` is a named
-- predicate, also data). A new card that recombines existing effects is
-- a seed row and zero lines of code. Same posture as contract_defs,
-- collections and landmarks.
-- ══════════════════════════════════════════════════════════════════

-- mods jsonb keys — ALL optional, absent means "no effect":
--   rent          numeric  multiplier on this tile's online rent
--   rent_offline  numeric  multiplier applied INSTEAD of `rent` inside
--                          accrue_rent's offline branch (which already
--                          runs at 0.5x — so 2 means full offline rate)
--   def           numeric  multiplier on def_power in attack_tile
--   atk_cost      numeric  multiplier on what an ATTACKER pays to hit
--                          this tile (defender-side cost modifier)
--   no_attack     bool     tile can never be targeted by attack_tile
--   max_level     int      caps upgrade_tile below the usual 4
--   build_time    numeric  multiplier on build duration for this tile
--   build_cost    numeric  multiplier on upgrade cost for this tile
--   no_list       bool     list_tile refuses
--   no_redevelop  bool     redevelop_tile refuses
--   no_decay      bool     repossess_stale_tiles skips it
--   expires_days  int      after N days from covenant_at, `after` replaces
--                          the whole mods object
--   after         jsonb    the post-expiry mods (see Ground Lease)
create table if not exists covenant_defs (
  code text primary key,
  name text not null,
  descr text not null,           -- player-facing, one line, states BOTH sides
  mods jsonb not null default '{}'::jsonb,
  cond text,                     -- null | 'block3' — see covenant_active below
  min_level int not null default 0,   -- offerable when the just-completed
  max_level int not null default 4,   -- level falls in [min_level, max_level]
  weight int not null default 10,
  active boolean not null default true
);

-- covenant_at: when the CURRENT covenant was accepted. Only read by the
-- expires_days path (Ground Lease); null whenever covenant is null.
alter table tiles add column if not exists covenant text references covenant_defs(code);
alter table tiles add column if not exists covenant_at timestamptz;

-- A pending 3-card offer. One row per tile, replaced by a later build
-- completion, deleted on accept/decline. Stored server-side rather than
-- rolled client-side for the obvious reason: a client-rolled offer is a
-- client-rerollable offer.
create table if not exists covenant_offers (
  qk text primary key references tiles(qk) on delete cascade,
  codes text[] not null,
  level int not null,            -- the level whose completion generated this
  created_at timestamptz not null default now()
);

alter table covenant_defs enable row level security;
drop policy if exists "read covenant_defs" on covenant_defs;
create policy "read covenant_defs" on covenant_defs for select using (true);
grant select on covenant_defs to anon, authenticated;

-- Offers are private to the tile's owner. Unlike contract_slots this can't
-- key on the row itself (there's no owner column), so the policy joins
-- tiles — cheap, tiles.qk is the primary key.
alter table covenant_offers enable row level security;
drop policy if exists "read own covenant_offers" on covenant_offers;
create policy "read own covenant_offers" on covenant_offers for select
  using (exists (select 1 from tiles t where t.qk = covenant_offers.qk and t.owner = auth.uid()));
grant select on covenant_offers to authenticated;
```

No write policy on either table — cards are seed data, offers are written
only by `security definer` functions. Same trust boundary as `tile_class`,
`status_tier`, `contract_defs` and `landmarks`.

### Seed

Insert the 13 rows from the catalogue table above, with the standard
`on conflict (code) do update set ...` tail every seed block in this file
uses, so re-running `supabase.sql` retunes cards in place.

## Server logic

### New helper: `covenant_mods(p_tile tiles, p_uid uuid) → jsonb`

The single place that resolves a tile's *effective* mods. Every hook below
calls this and reads one key out of the result, so expiry and conditional
logic live in exactly one function.

```
if p_tile.covenant is null            → '{}'
look up covenant_defs.mods
if mods ? 'expires_days'
   and p_tile.covenant_at + (expires_days || ' days')::interval <= now()
                                      → mods->'after'
if cond = 'block3'
   and (select count(*) from tiles t2
        where t2.owner = p_uid and left(t2.qk,12) = left(p_tile.qk,12)) < 3
                                      → '{}'
otherwise                             → mods
```

`stable`, `security definer`, `set search_path = public`, no grant.

**Performance note, and it matters:** `accrue_rent` runs on effectively
every RPC round-trip and sums over a player's whole portfolio. Do **not**
call this per-row from inside that sum — inline the mods as a `left join
covenant_defs` and gate the `block3` correlated subquery behind
`case when t.covenant is not null and cd.cond = 'block3' then (...) end` so
Postgres only evaluates it for the handful of rows that actually carry a
conditional card. See the Verification section for the check on this.

### Touch points on existing functions

Each is additive — a lookup, then an adjustment to a number the function
already computes.

- **`accrue_rent`** ([the `v_rps` sum](Plot-Twist-World/plot-twist-world-deploy/deploy/supabase.sql:367)):
  becomes **two** sums in one query — `v_rps` (online, applying `rent`) and
  `v_rps_offline` (applying `rent_offline` if present, else `rent`). The
  branch below it then picks the matching one:
  `v_gain := v_rps * v_mult * v_elapsed` stays as-is for the online branch;
  the offline branch becomes `v_rps_offline * 0.5 * least(v_elapsed, 8*3600)`.
  The 0.5 and the 8h cap are unchanged — `rent_offline` multiplies inside
  them, which is what makes Absentee Deed's "2" mean "full rate."
- **`upgrade_tile`**: three additions.
  `max_level` replaces the hardcoded `if v_tile.level >= 4` ceiling
  (`coalesce((mods->>'max_level')::int, 4)`) — note the error message needs
  to name the covenant, or a Heritage Listing tile refusing to build reads
  as a bug. `build_cost` multiplies `v_cost` at
  [line 1160](Plot-Twist-World/plot-twist-world-deploy/deploy/supabase.sql:1160).
  `build_time` multiplies `v_duration` after the existing landmark
  `build_speed` perk is applied at
  [line 1179](Plot-Twist-World/plot-twist-world-deploy/deploy/supabase.sql:1179)
  (order matters only for legibility — they commute — but keep the landmark
  perk first so its 30% cap is obviously still a cap on the perk).
  Also: the `dev_mode` instant-completion branch must generate an offer.
- **`rush_build`**: the rush price derives from `upCost`, so `build_cost`
  flows through for free — verify rather than re-apply it, or Brownfield
  double-discounts. Must generate an offer on completion.
- **`finish_builds`**: currently a bulk `update ... get diagnostics`. Change
  to `update ... returning qk, level` collected into a set, then loop to
  generate one offer per completed tile. The existing
  `contract_progress(..., 'build_finish', v_done, ...)` call keeps its
  count semantics — take `v_done` from the collected row count.
- **`attack_tile`**: `no_attack` raises before any battle math (put it
  beside the landmark 48h grace check, same shape, and reuse that message
  style). `def` multiplies `v_def_power` at
  [line 1781](Plot-Twist-World/plot-twist-world-deploy/deploy/supabase.sql:1781),
  after the landmark `defense_mult` and before the NPC escalation factor.
  `atk_cost` multiplies `v_cost` at
  [line 1765](Plot-Twist-World/plot-twist-world-deploy/deploy/supabase.sql:1765)
  — **inside** the `greatest(...)`'s first argument, so it raises the base
  but the wealth floor still binds, consistent with how `siege_discount`
  is handled. On a **win**, the covenant is cleared alongside
  level/rarity/prestige, and any `covenant_offers` row for that qk is
  deleted.
- **`list_tile`**: `no_list` refuses, with a message naming the covenant.
- **`redevelop_tile`**: `no_redevelop` refuses, naming the covenant. On
  success, clear `covenant`, `covenant_at`, and any pending offer — this is
  redevelop's new second job and the system's primary escape hatch.
- **`repossess_stale_tiles`**: add `and coalesce((cd.mods->>'no_decay')::bool, false) = false`
  to the sweep's where clause (join `covenant_defs` via `tiles.covenant`).
- **`buy_listed_tile`**: no change needed — `covenant`/`covenant_at` are
  columns on `tiles` and the sale only moves `owner`. **Confirm** this by
  reading the update rather than assuming; a covenant silently surviving is
  the intent, a covenant silently being cleared would be a bug.
- **`abandon_tile`**: no change. Row is deleted, covenant goes with it.

### New RPCs

- **`list_covenant_offer(p_qk text)`** — owner-only; returns the pending
  offer joined to `covenant_defs` (name, descr, mods) so the client renders
  cards without a second fetch. Follows `list_contracts`'s shape.
- **`accept_covenant(p_qk text, p_code text)`** — owner-only. Validates the
  code is actually in that tile's stored offer (this is the anti-cheat —
  never trust a client-supplied card), sets `covenant`/`covenant_at`,
  deletes the offer. Emits `contract_progress(v_uid, 'covenant', 1,
  jsonb_build_object('code', p_code))` so contracts can later reference it.
- **`decline_covenant(p_qk text)`** — owner-only, deletes the offer.
  *(1.32.0: also sets `tiles.covenant_declined`, which stops
  `redevelop_tile` ever offering on that tile again for this tenure.)*

Standard conventions on all three: `security definer`,
`set search_path = public`, `revoke all ... from public`,
`grant execute ... to authenticated`, `perform accrue_rent(v_uid)` first,
`select ... for update` before mutating.

**Gotcha carried over from the PvP work:** any new function that
`returns table(...)` with a column named `qk` must qualify every `qk`
reference in its body as `tiles.qk`, or it fails with "column reference qk
is ambiguous." `list_covenant_offer` is the one at risk here.

## Client (`PlotTwistWorld.jsx`)

- **Constants**: mirror the 13 cards' `mods` as a `COVENANTS` literal, with
  the usual comment cross-referencing the exact SQL it mirrors. Server is
  sole authority; this is display only — same pattern as `BUILD_SECONDS`
  and `PRESTIGE_COST_CAP`.
- **Plumbing**: add `covenant, covenant_at` to `ensureRegion`'s select and
  region tile records, `refreshOwnedTiles`' select and `g.own` records, and
  the boot fetch — follow the `build_until`/`owner_since` precedent.
- **Display mirrors** — five existing helpers need the covenant factor:
  | Helper | Line | Apply |
  |---|---|---|
  | `rentOf` | [991](Plot-Twist-World/plot-twist-world-deploy/deploy/src/PlotTwistWorld.jsx:991) | `rent` (and `rent_offline` wherever offline earnings are previewed) |
  | `upCost` | [999](Plot-Twist-World/plot-twist-world-deploy/deploy/src/PlotTwistWorld.jsx:999) | `build_cost` |
  | `buildDurationSecs` | [1009](Plot-Twist-World/plot-twist-world-deploy/deploy/src/PlotTwistWorld.jsx:1009) | `build_time` |
  | `attackCostFor` | [3392](Plot-Twist-World/plot-twist-world-deploy/deploy/src/PlotTwistWorld.jsx:3392) | `atk_cost` (target's) |
  | `defPowerFor` | [3402](Plot-Twist-World/plot-twist-world-deploy/deploy/src/PlotTwistWorld.jsx:3402) | `def` (target's) |
- **The offer modal** — the centrepiece. Three cards, name + one-line
  effect + explicit "Decline" that is never styled as the lesser option.
  Reuse the existing rarity-roll reveal aesthetic (the *"Recording deed…
  rolling rarity"* spin at
  [line 5384](Plot-Twist-World/plot-twist-world-deploy/deploy/src/PlotTwistWorld.jsx:5384))
  — same animation language, new payload. Fires from the build-completion
  toast; if the player dismisses it, the offer persists and the tile shows
  a badge until answered.
- **Tile detail panel**: covenant name + both sides of its effect, always
  both. If a `no_*` restriction is active, the blocked button says why
  ("Mixed Use — can't be listed") rather than merely being disabled.
  Ground Lease shows its countdown, and after expiry says plainly that
  redeveloping restores the tile.
- **Market rows**: show the covenant on every listing. This is a fairness
  requirement, not polish — covenants transfer on sale, so an undisclosed
  one is a trap sold to another player.
- **Assets tab**: show the covenant per row; add it to the existing sort/
  filter controls alongside rarity.
- **Map**: a small glyph on covenanted tiles at high zoom, same gating as
  the owner-name labels. Do not colour-code good/bad — several cards are
  both.
- **Versioning**: bump `package.json` to **1.23.0** (new visible feature)
  and add the matching `CHANGELOG` entry with `id: "1.23.0"` in the same
  commit — see HANDOFF.md "Versioning & changelog."

## Explicitly deferred (do not build in this pass)

- **Portfolio-wide cards** — cards that *modify other tiles* ("+15% to your
  rural tiles, −50% here"). This is where the real deckbuilding lives and
  it's the natural v2, but it turns the rent sum into a two-pass
  computation and needs its own performance work. Note the line: a card
  that *reads* the portfolio (Corner Lot) is cheap and is in v1; a card that
  *writes* to it is not.
- **The Zoning Board** — the pure gamble: pay a fee, roll to reclassify a
  tile's district (Rural → Suburbs is a 2.8× permanent rent jump). Very
  strong idea, thematically perfect, and mechanically viable because
  `tiles.cls` is a stored column the server takes from the client at claim
  time, not re-derived on read. **Open question before building it:** the
  map's district colour grid is drawn from the live vector classifier, so a
  rezoned tile may render as its original district underneath while the
  panel reports the new one. Trace the render path before committing.
- **Paid replacement / a "variance fee" to swap a covenant** — v1 makes
  replacement free on the next build completion. If that proves to make the
  restriction-cost cards toothless, price it then, with data.
- **Covenants on landmark tiles** — landmark tiles never develop (level
  stays 0 forever), so they never hit a build completion and are naturally
  excluded with no code. Leave it that way; the landmark perk is that
  tile's trait.
- **Contracts referencing covenants** — `accept_covenant` already emits the
  metric, so a `d_covenant` contract def is a seed row whenever wanted.

## Implementation order

1. **SQL**: schema + seed the 13 cards + `covenant_mods` helper + the three
   new RPCs + the ten touch points above. Sanity-check directly in the SQL
   editor before any client work — accept a card by hand, confirm the rent
   sum moves, confirm `no_list` refuses.
2. **Client**: constants → plumbing → the five display mirrors → offer
   modal → detail panel → market/assets/map. `npm run build` after each
   chunk.
3. **Version bump + changelog**, same commit.
4. Deploy (push to main), then live verification.

## Verification

Most of this is **single-account testable**, which is unusual for this
project — only the market-transfer and attack cases need two accounts.

- A tile with no covenant earns, builds, lists, attacks and decays exactly
  as before. Run this first; it's the grandfathering guarantee.
- Completing a build produces an offer of exactly 3 distinct cards, all
  eligible for that level (a level-3 completion never offers Brownfield).
- The offer survives a page reload and cannot be rerolled by refetching.
- `accept_covenant` with a code **not** in the stored offer is rejected.
- Rent: accept Anchor Tenant, confirm the client's displayed rate and the
  server's actual credit both move by 1.25× and agree with each other.
- Offline: accept Absentee Deed, go offline 30 min, confirm the credit is
  full-rate rather than half-rate, and that an *un*covenanted tile in the
  same portfolio is still half-rate in the same sync.
- Heritage Listing blocks the level-4 build with a message naming the card.
- Brownfield's discount appears in `upCost` **once**, not twice, when
  rushing (the rush price derives from `upCost` — this is the double-apply
  trap called out above).
- Ground Lease: accept, confirm +60%; backdate `covenant_at` by 15 days,
  confirm rent goes to zero and the UI says redeveloping restores it;
  redevelop, confirm the tile is normal again.
- Freehold refuses redevelop and is skipped by `repossess_stale_tiles`.
- Two-account: Conservation Easement makes the tile untargetable; Gated
  Community doubles the attacker's quoted cost **and** the wealth floor
  still binds for a wealthy attacker; capturing a covenanted tile clears
  the covenant and any pending offer.
- Two-account: a covenanted tile sold on the market arrives with its
  covenant intact, and the buyer could see it on the listing beforehand.
- **Performance**: with a 100+ tile portfolio including at least one Corner
  Lot, compare `explain analyze` on `accrue_rent`'s rent sum before and
  after. This runs on every RPC round-trip; if the conditional subquery
  shows up as a per-row cost rather than a handful of rows, restructure it
  before shipping.
- `npm run build` green; boot clean with no console errors.

---

## Revision, 2026-07-29 (v1.32.0): one offer, one answer + a rare tier

Two changes, both to the parts of this document above that are now stale.

### The offer is one-time per tenure

Since v1.26 the offer point has been **redevelop**, not build completion,
and only on a tile with no covenant yet. That still left a hole: declining
was free *and* left the tile eligible, so the loop was redevelop → glance
at three cards → decline anything with a cost → redevelop again. Declining
wasn't a decision, it was a reroll button, and it drained every card with a
real trade out of the game — nobody signs Fortified Block when the
alternative is a free re-draw.

`tiles.covenant_declined` closes it. `decline_covenant` sets it;
`redevelop_tile` rolls an offer only when `covenant is null and not
covenant_declined`. It clears wherever the covenant clears — sale, raid
capture, and (via row deletion) abandon and repossession — so a new owner
still gets their own one-time offer.

Rule 4 survives intact: declining still leaves the tile exactly as it was,
and a player who ignores this system is no worse off than before it
shipped. What changed is that the *refusal* is now the permanent decision,
which is what makes "sign one or none" a choice rather than a filter. Rule
2 also survives — accepting is still escapable by giving the tile up, and
that was already the only exit after v1.26 made covenants survive rebuilds.

The client shows both halves: the decline button is two-tap and labels
itself permanent, and a tile that has spent its offer says so above
Redevelop rather than silently producing no cards.

### `covenant_defs.tier`, and the deals

The catalogue is now 22 standard cards plus 6 rare ones. Rare cards are
**excluded from the ordinary pool** and reached through a single gate in
`covenant_offer_roll`: ~7% of offers roll one rare card first and draw only
2 standard, so the deal is prepended and renders first and gold.

This is deliberately one tunable number rather than a low weight in the
shared pool. A rare card at weight 1 among thirteen is a frequency nobody
can reason about and that drifts every time another card is added; a gate
is a number you can change on purpose.

The deals sit **outside the standard pool's tuning band on both sides** —
double rent, quarter defense, 4x defense, 150% rent for 30 days then half
forever. All four rules still bind: they're offered and never imposed, free
to decline, every one names the build it's bad for, and the floor is still
"nothing happened". What they don't obey is the band, and that's the point:
at roughly one in fourteen redevelops, a deal should feel like the map
handed you something. Keep the gate low. A deal you see every cycle is
power creep with a gold border.
