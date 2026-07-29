# Changelog

Player-visible changes. Bumped together with `package.json`'s `version`,
which is the single source of truth the corner badge and the new-version
poll both read (see `vite.config.js`).

## 1.32.0

### Covenants: one offer, one answer

- **Declining a covenant is now permanent for your tenure on that tile.**
  A tile's first redevelop offers three cards; turn them all down and no
  later redevelop offers again while you hold it. Backed by
  `tiles.covenant_declined`, set in `decline_covenant` and read by
  `redevelop_tile`.
- **Why:** declining was free *and* consequence-free, so the next
  redevelop dealt three fresh cards. That made "decline" a reroll button
  — keep going until Prime Frontage shows up — and drained every card
  with a real cost out of the game. The refusal is now itself the
  permanent decision, which is what makes "sign one or none" a choice.
- The flag clears with the covenant on every tenure change (sale, raid
  capture, abandon/repossess + reclaim), so a new owner gets their own
  one-time offer.
- Declining is a **two-tap** button in the sheet, and a tile that spent
  its offer says so above Redevelop.

### Nine new covenants, and six rare deals

- New standard cards: Transit Hub, Flood Plain, Night Market, Company
  Town, Land Bank, Co-op Board, Civic Trust, Bunker Lot, Holdout Parcel.
- **New `tier` on `covenant_defs`.** Rare cards are excluded from the
  ordinary pool and reached through a single gate in
  `covenant_offer_roll` (~7% of offers swap one standard card for a
  deal), so their frequency is one tunable number rather than an
  emergent property of the weight table.
- The deals — Sovereign Charter, The Black Ledger, Midas Clause, Iron
  Covenant, Founder's Pact, Ghost Tenancy — sit deliberately outside the
  standard pool's tuning band on both sides. They still obey all four
  covenant rules: offered not imposed, free to decline, a real tradeoff,
  and every one names the build it's bad for.
- Rare cards render gold in the offer and sort first.
- `atk_cost` chips now colour on the number, not the key — below 1 it
  invites raiders in (Night Market, Midas Clause) and reads as a
  downside. Expiry chips read their `after` rent off the card rather
  than hardcoding "dead".

## 1.29.0

### Assets, by region

- **The portfolio list now nests under one collapsible header per region.**
  Each header carries the region's name, its tile count and its combined
  rent per second, so "what do I actually own in Lisbon" is a glance
  rather than a scroll through coordinate labels that all look alike.
- **Home region opens by default, everything else starts collapsed**,
  ordered biggest-earner-first behind it. A player with tiles in only one
  region never sees a closed group — collapsing the only group would just
  make the tab look empty. `Expand all` / `Collapse all` sits next to the
  region count.
- **Searching or filtering force-opens every group.** Hiding matches
  behind a closed header is how a search box gets reported as broken.
  Sorting is unchanged in meaning: it now orders tiles *within* each
  region.
- The **Building** section is untouched and still sits above everything,
  ungrouped — it's a transient "what did Upgrade All just do" view, not a
  place to go looking for a specific tile.

### Behind the scenes

- `regionLabel()` is memoised. It costs five city-index sweeps per call
  and is now called once per region on every Assets render — a list that
  re-renders off the 250ms economy tick — for a label that can never
  change for a given region.

## 1.28.0

### The tutorial names the thing it was giving away

- **New tour step: rushing.** It sits right after the build timer, points
  at the real Rush button on the tile you just started building, and says
  what rushing does and that your first one is free. The game was handing
  new players a free rush credit — and, since 1.27.0, a second one for
  signing in — while never once defining the word.
- It's an **explanation step, not an action step**: the credit is meant to
  be spent on the first timer that actually hurts (the 30-minute Duplex),
  not burned on the 5-minute Cottage because a script said to. The button
  is live inside the spotlight, so anyone impatient can still use it there.

### Behind the scenes

- **Abandoned guest accounts are now cleaned up.** A guest who never
  claimed a tile and hasn't been seen for a week is deleted, along with
  anonymous accounts that never finished signing up at all. Guests who own
  land are untouched — their tile decays on the same 30-day inactivity
  timer as everyone else's first, and only then are they reaped. No Google
  account is ever deleted without its owner asking.

## 1.27.1

### A failed sign-in says so

- **Linking a Google account that already owns a world is now reported.**
  It was always correctly refused, but silently: `linkIdentity()` leaves
  the page, so the refusal arrives as `error_code=identity_already_exists`
  in the URL on the way back, not as a rejected promise. 1.27.0 only
  checked the return value, so the player landed back on the map with no
  explanation. The choice — use the world you already have, or link a
  different account — is now put in front of them.
- **Abandoning a guest world now deletes it.** Choosing "use my old world"
  used to sign out and leave the anonymous account behind: unreachable
  forever, still holding its home tile, still counting toward monthly
  active users.
- **No more 403 in the console after deleting an account.** The sign-out
  that follows deletion was asking the server to invalidate a session for
  a user the server had just deleted. It's local-only now.

## 1.27.0

### Play first, sign in later

- **"Play now" opens the map with no account.** A first-time visitor
  presses one button, picks a spot on Earth and starts playing. The Google
  sign-in is still there for returning players, but it is no longer the
  toll gate on a stranger's first thirty seconds.
- **A guest tile is a real tile.** Same shared map, same district
  classification, same rarity roll, same rent accruing while the tab is
  closed. Guests are Supabase anonymous accounts, so the world they play
  in is the world everyone else is playing in — not a sandbox.
- **Linking keeps everything.** Signing in with Google attaches the
  account to the identity a guest already has, so the tile, the ₲, the
  streak and the tutorial progress survive the upgrade untouched, and the
  world becomes reachable from any device. **+₲1,000 and one free rush**
  are paid on linking.
- **The ask waits for the end of the tutorial.** Once a new player has
  claimed a tile, watched it earn and built on it, they're invited to keep
  it — dismissibly. A "Guest · save world" pill in the header, and the
  pause menu, both lead back to the same offer.
- **Guests are held to their home tile.** Claiming further land,
  unlocking territory, the market, raids, listings and friends all wait
  until an account exists — enforced server-side, not just in the UI,
  because anonymous accounts are cheap to mint. Guests are also kept off
  the World register until they link.
- **Known limit:** a guest world lives in one browser. Clearing site data
  before linking loses it, and there is no recovery — the sign-in prompt
  says so.
- **"Play now" is captcha-protected**, invisibly — a challenge only
  appears if hCaptcha doesn't like the request. Guest accounts are the one
  door into this game that hands out an identity to nobody in particular,
  so it's the one worth guarding; every bot-minted account would also
  count toward the project's monthly-active-user billing. Signing in with
  Google is unaffected.

Requires three Supabase dashboard settings — anonymous sign-ins, manual
identity linking, and captcha protection (hCaptcha) — plus the
`VITE_HCAPTCHA_SITE_KEY` build secret.

## 1.26.0

### Covenants are drafted at redevelopment, and last your whole tenure

- **Offers now come from redeveloping**, not from finishing a building. One
  offer per tile, at the moment you've maxed it out and chosen to reset —
  rather than a decision arriving every few seconds during a rush-heavy
  upgrade session. Only a tile without a covenant is offered one, so it's
  once per tile per owner.
- **The full 13-card pool is eligible.** A freshly redeveloped tile is
  Vacant with the whole ladder ahead of it, so the build-modifying cards
  (Brownfield, Union Site) and the ceiling card (Heritage Listing) are all
  live again — they were previously restricted to early build levels.
- **What you sign is permanent.** It survives every rebuild after it, for
  as long as the tile is yours.
- **It ends when the tile stops being yours** — sold on the market,
  abandoned for the 50% refund, taken in a raid, or repossessed for
  inactivity. Whoever holds it next starts clean and drafts their own.
- **The paid release is gone.** With covenants scoped to a tenure rather
  than running with the land, giving the tile up already ends one, and the
  failure mode the release existed to prevent — a permanently ruined tile
  that outlives its owner — can't happen.

This supersedes the "runs with the land" model from 1.25.0 entirely; the
`tile_covenants` table and `release_covenant` are dropped.

*Server-side changes live in `supabase.sql` and must be re-applied to the
database for this release to do anything.*

## 1.25.0

### Covenants run with the land

A covenant is now an encumbrance on the ground rather than a deal with
whoever currently holds the deed — which is what the word means in property
law, and what the name always implied.

- **It survives everything.** Selling, being conquered, redeveloping,
  abandoning. Land that goes back on the market goes back carrying its
  terms, and whoever claims it next takes them on.
- **New: pay to release one.** The only way off a covenant now. Priced at
  ten times the district's deed price or 0.5% of your peak net worth,
  whichever is larger — the same wealth-indexing as raid costs, so it stays
  a real decision instead of decaying into a rounding error.
- **Disclosure before commitment, everywhere.** Unclaimed land that carries
  terms shows them on its sheet before the claim button; a rival's tile
  shows its card before you raid it; market listings already did.
- **Redeveloping no longer clears one.** It demolishes the building, and
  the covenant was never on the building.
- **Heritage Listing is now a permanent prestige loop.** Capped at
  Apartments, it redevelops a level early — and now keeps doing so every
  cycle rather than needing to be redrawn. Deliberate, and the first thing
  to look at if prestige pacing drifts.

Why the paid release exists rather than a free one: with no exit at all, an
expired Ground Lease would be a permanently worthless tile that anyone could
deliberately manufacture on prime land and then abandon — turning a
self-inflicted cost into a way to salt ground for every future player. A
covenant should be a bad deal you signed, never permanent damage to the
shared map.

*Server-side changes live in `supabase.sql` (new `tile_covenants` land
record, `release_covenant`, and edits to `buy_unowned_tile`, `attack_tile`,
`redevelop_tile` and `accept_covenant`) and must be re-applied to the
database for this release to do anything.*

## 1.24.0

### Covenant offers wait for you instead of stopping you

The build timer was meant to space these decisions out, but rushing is
*designed* to collapse that timer — it's the game's main money sink. So for
an active player doing a rush-upgrade-rush session, completions arrive
seconds apart and a modal on each one turned an upgrade bender into a wall
of forced choices. The frequency of that event is entirely player-controlled
and unbounded, so nothing that blocks on it can behave well.

- **No popup, ever.** Offers roll exactly as before and wait to be found.
- **The three cards render inline in the tile's own sheet**, under the build
  buttons — the panel a rushing player is already standing in. One tap takes
  a card; ignoring it costs nothing and it stays put.
- **A violet dot on the Assets tab** counts tiles with an offer waiting, and
  Assets rows keep their per-tile chip, so an offer on a tile you're not
  looking at still surfaces.
- **A one-shot tip** introduces the system the first time cards appear,
  anchored to the real cards rather than describing them from elsewhere.
- **Rushing still earns a full draft on every completed build.** Making
  rushing forfeit the draft would have fixed the spam by taxing the exact
  playstyle the money sink depends on — the wrong trade.

"Later" is gone as a concept, along with the deferral bookkeeping added in
1.23.1 to work around the popup: with nothing interrupting, there is nothing
to defer.

## 1.23.1

- **"Later" on a covenant offer actually works now.** Dismissing the card
  (or tapping the backdrop) cleared the modal, but the effect that surfaces
  a waiting offer immediately re-satisfied its own condition and reopened
  the same one — so the only way past the decision was to accept or decline
  it. Deferring now silences that specific offer for the session; the tile's
  sheet keeps a button back to it, and a genuinely new offer rolled by a
  later build on the same tile still surfaces on its own.
- **Offers earned while you were away appear on open.** Builds run offline,
  so returning after several finish leaves several offers waiting
  server-side. They were only picked up by the 20-second reconcile tick;
  they now load as soon as the session is live. They still arrive one at a
  time, and skipping one moves to the next.

## 1.23.0

### Covenants — three offers on every finished build

- **Every completed build now draws three cards.** Each one is a permanent
  trade attached to that specific tile: Anchor Tenant earns 25% more rent
  but defends 40% weaker, Fortified Block defends twice as hard for half
  the rent, Brownfield builds fast and cheap on a tile that pays less,
  Ground Lease pays 60% more for fourteen days and then nothing until you
  redevelop. Thirteen cards in the pool; which three you're offered depends
  on the level you just finished.
- **Declining is free and always available**, and a covenant only ever
  lands on a tile you picked it for. Nothing reaches over and changes a
  tile you were quietly holding.
- **Redeveloping clears a covenant**, so no card is a trap — and redevelop
  now has a second job beyond the prestige loop.
- **Covenants travel with the deed.** Buy a listed tile and you inherit its
  terms, both halves, which is why market listings now show the card and
  its effects up front instead of behind a tap.
- **One card, Prime Frontage, is a straight bonus with no downside.** It's
  the rarest thing in the pool by design — a draft where every option costs
  something reads as a tax no matter how fair the numbers are.
- **Heritage Listing tiles redevelop from Apartments** rather than Tower.
  Capping out a level early is now a cheaper, faster prestige cycle instead
  of a tile that can neither build nor reset.
- Covenanted tiles carry a small violet dot on the map, and the tile sheet
  always shows both sides of whatever it's signed to.

*Server-side changes live in `supabase.sql` (new `covenant_defs` /
`covenant_offers` tables plus hooks in `accrue_rent`, `upgrade_tile`,
`rush_build`, `finish_builds`, `attack_tile`, `list_tile`,
`redevelop_tile` and `repossess_stale_tiles`) and must be re-applied to the
database for this release to do anything.*

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
