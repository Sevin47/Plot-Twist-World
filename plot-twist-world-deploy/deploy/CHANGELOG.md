# Changelog

Player-visible changes. Bumped together with `package.json`'s `version`,
which is the single source of truth the corner badge and the new-version
poll both read (see `vite.config.js`).

## 1.33.0

### Status promotions announce themselves

- Reaching a new `STATUS_TIERS` rank raised nothing but the badge on
  Profile. The capacity that came with it — daily energy, builder slots,
  daily attacks, and the `contract_defs.min_tier` gates that open at tiers
  2/3/5 — was only ever discoverable in one line of small print under the
  progress bar.
- **The modal.** `kind: "status"`, showing the new rank and every number as
  a **delta against the rank they were on** ("16 → 18/day (+2)"). A bare
  "18/day" says nothing about what just changed, which was the whole
  problem being fixed.
- **Detection.** `peak_net_worth` only ever arrives from the server, so
  `noteStatus()` hangs off `syncRent()` — the one place a rank change is
  observable, and why a promotion shows up within a ~20s reconcile of the
  purchase that earned it rather than instantly.
- **What's been seen** lives in `localStorage` (`ptw_status:<uid>`), not in
  session state: rent accrues server-side while the app is closed, so a
  rank can be earned entirely between sessions and comparing against "what
  this session started at" would swallow it. A device with no record
  adopts the current tier silently — nobody is congratulated on boot for a
  rank they made last month.
- Hands off through `statusUp` state to an effect rather than calling
  `setModal` from inside `syncRent`. Two reasons: a state updater with a
  side effect double-fires under StrictMode, and boot's own modal drain
  (`pendings.current.shift()` right after `setReady(true)`) would overwrite
  anything set before it. The effect is `ready`-gated for that second one,
  same as the link-bonus effect it's modelled on.

### The daily stipend is a card on Profile, not a modal at startup

- `claim_daily()` ran during boot and raised a modal announcing money that
  had already landed — the one reward in the game with an expiry was the
  one reward the player never had to think about, and the seven-day ladder
  (the most useful thing about it) was visible nowhere.
- **Split server-side.** `touch_daily()` advances the visit streak and pays
  nothing; `claim_daily()` pays. Two columns to match: `last_daily` is "last
  UTC day seen", the new `last_daily_paid` is "last UTC day collected". They
  were one thing when visiting *was* claiming, which is what the backfill
  (`last_daily_paid = last_daily`) encodes.
- **The streak is never at risk.** Boot calls `touch_daily()`, so a session
  that never opens Profile still counts as showing up. This is the whole
  reason for the split — a manual claim that also gated the streak would
  reset a day-40 run to 1 for not tapping a card.
- Both functions are safe in either order, any number of times per day, and
  `claim_daily()` keeps its pre-split return shape so an older cached bundle
  still calling it at startup keeps working.
- **The card** sits above Contracts: seven pips for the ladder, today's
  payout, tomorrow's if they come back, a countdown to 00:00 UTC, and an
  amber border until it's collected. It feeds the Profile nav dot
  (`claimableTotal`) alongside contracts and collections.
- Refreshed on every Profile visit and on refocus, not just at boot, so a
  session left open across the UTC rollover rolls over with it.
- `refreshDaily()` falls back to the old auto-pay path if `touch_daily`
  isn't there yet — a bundle can ship before `supabase.sql` is re-run, and
  the stipend shouldn't drop on the floor for however long that gap lasts.

### "HQ" swept out of the source

- HQ stopped being a tab in 1.14.x when it split into Profile / World /
  Social, but the name survived across a dozen comments, one wiki section
  and — the only one a player could see — the new-DM toast, which told them
  to "see Friends in HQ".
- Each reference now names the tab that actually holds the thing: territory
  and the activity log are **World**, friends/DMs/blocking are **Social**,
  contracts, collections, achievements and the stipend are **Profile**, and
  account deletion is the pause menu's Settings card.
- **Dated release notes are left alone**, in both the in-app `CHANGELOG` and
  the wiki's version history. Those entries describe what shipped on a day
  when HQ *was* the name; editing them would make the history wrong to fix
  a word that was right at the time.
- The two root planning docs (`LANDMARKS-PLAN.md`, `CONTENT-RESEARCH.md`)
  are left alone for the same reason — they record what was being
  considered, not what exists.

## 1.32.6

### "While you were away" waits for a real absence

- The welcome modal is raised by the boot effect, and boot re-runs far more
  often than "the player came back tomorrow" — a mobile browser evicts a
  backgrounded PWA within seconds, so a trip to the home screen, a look at
  another app, or an OAuth round-trip all reload the page and re-ran it.
- **Why:** it turned every app switch into a popup announcing a few seconds'
  rent, including switching to the home menu and straight back in.
- **The gate.** A heartbeat (`AWAY_BEAT_MS`, 15s) stamps `ptw_lastActive`
  while the document is visible, and writes one final stamp on
  `visibilitychange`→hidden and on `pagehide` — that last one is the reading
  that matters, since it's the moment the player actually left. Boot reads
  the stamp through a `useState` lazy initializer (before the heartbeat can
  overwrite it) and only queues the modal when the gap is at least
  `AWAY_MODAL_MIN_MS` (2 minutes).
- No stamp at all — first run on a device, or private mode — reads as
  away-long-enough, so a genuinely returning player is never silently
  skipped.
- Nothing about the economy changed: `accrue_rent()` credits the rent
  server-side and the balance display picks it up regardless. Only the
  announcement is suppressed.

## 1.32.5

### The Wiki stops documenting a channel the game doesn't have

- `guide.html` was still carrying a full page for the per-region room that
  was pulled in 1.15.0 — sidebar link, TOC entry, its own rate-limit callout,
  a cheat-sheet row, and passing references in the Map tab card, the fog
  paragraph, the username step and a starter strategy. All gone.
- **Why:** it read as a shipped feature. A player following the wiki went
  looking for a button on the map that hasn't existed for seventeen releases,
  and the projects section told them to go negotiate with their neighbours
  somewhere they can't.
- **Reporting & blocking → Blocking.** The old section's only described
  entry point was "tap a message in the room," so with the room gone it
  described nothing. Rewritten against the actual client: `Block` next to
  Accept/Decline on an incoming request, mutual, silent, lifted only by the
  blocker from the Blocked list, `Remove` for an existing friend. Section id
  stays `#safety` so no inbound anchor breaks.
- **Reports dropped from the wiki.** `report_player` exists server-side but
  `supabase.sql` says it plainly — the client has no report UI wired up, so
  nothing calls it. The wiki was promising a 10/day allowance on an action a
  player cannot take. The RPC is untouched; only the documentation of it went.
- **Direct messages** now say what they are: the only channel in the game.
  The friends strategy card says the same, and points at why you'd want one
  (project coordination, non-aggression) now that friendship is the only way
  to have that conversation.
- **Choosing what gets built** rewritten to explain convergence on its own
  terms — the default follows the leading project, so passive landlords
  accelerate an emerging consensus instead of four bars stalling at a quarter.
  Matches the "Follow the leader" default in `settle_region`.
- Version history: the wiki's v1.6.0 entry and one v1.8.0 bullet are gone,
  and in-app "What's new" lost the same bullet plus its 1.6.0 and 1.10.0
  entries — every note in those was about the removed room, so the entries
  had nothing left to say.

## 1.32.4

### The Wiki reads its own version

- `guide.html`'s version chip and the infobox's "Current version" row now
  come from `version.json` — the file the Vite build writes and the game's
  own update-available poll already reads. The hardcoded strings remain as a
  silent fallback.
- **Why:** the chip said `v1.32.1` on a `1.32.3` build within an hour of the
  big wiki refresh landing, because it's a number typed into a document. That
  is the same failure mode that let it sit at `v1.9.0` for 23 releases; the
  fix is to stop hand-maintaining it.

## 1.32.3

### Market listings no longer disclose a covenant

- `refreshMarket` stops selecting `covenant`, and the listing row drops the
  covenant chip. The comment claiming it "TRANSFERS with the deed" was true
  under 1.25.0's runs-with-the-land model and wrong from 1.26.0 onward, when
  covenants became tenure-scoped and `buy_listed_tile` started clearing them
  on transfer. Disclosure of terms the buyer will never be under isn't
  fairness, it's misinformation.
- **No mechanical change.** Verified in `supabase.sql`: `buy_listed_tile`
  clears `covenant`/`covenant_at`/`covenant_declined`; `list_tile` only
  *reads* the covenant (to refuse `no_list` cards) and `unlist_tile` doesn't
  touch it at all. So listing → unlisting cannot be used to launder a bad
  covenant, which was the specific worry.
- A rival's tile still shows its covenant on the sheet before a raid — those
  terms are in force and affect the fight, so that disclosure is real.
- Wiki updated to match, including an explicit note that selling is a
  legitimate exit from a covenant but listing alone changes nothing.

## 1.32.2

### The Wiki, brought back up to date

`public/guide.html` had drifted 23 releases behind the game. Its version
chip still said v1.9.0, it described four tabs and a five-step tutorial,
and the entire covenant system — shipped over 1.23.0–1.32.0 — was absent.

**New sections:** Covenants (all 28 cards across both tiers, the
once-per-tenure offer, why declining is permanent), Region projects,
Playing as a guest, Notifications, Live feed.

**Rewritten or corrected:** Getting started (guest play is now the
default entry path), The interface (six tabs + pause menu, Assets grouped
by region), Buildings (Rush all, collection builder slots), Redeveloping
(the covenant moment, and which cards move the ceiling), PvP (what a
defender's covenant does to defense and attack cost), The open market
(5% duty, Free Port waiver, unlistable covenants), World register (moved
to the pause menu), Inactivity (the three no-decay covenants), Tutorial
(eight steps and the one-shot tips).

**Reference:** formula reference gained covenant modifiers, the region
levy/upkeep/duty numbers, project effects and the rare-deal odds; cheat
sheet and infobox gained covenants, projects, duty and notifications;
version history filled in 1.10.0 → 1.32.1.

Verified: 40 sections, 40 nav links, zero broken anchors, no horizontal
overflow, sidebar filter resolves the new sections.

## 1.32.1

### Energy alerts fire for both refills

- **The `energy-reset-push` pg_cron job was still on `0 0 * * *`.** The
  split refill (energy in two tranches, 00:00 and 12:00 UTC) shipped
  without moving it, so the noon half was never announced — every client
  surface said energy arrives in two halves while the push only ever
  reported one. Now `0 0,12 * * *`.
- `send-energy-alerts` works out which tranche it's announcing from the
  **UTC hour**, the same `>= 12` test `reset_daily_energy` uses to decide
  what to grant, so the two can't drift. `{"tranche": 1 | 2}` in the body
  overrides it for manual testing; the cron keeps sending `{}`.
- Push copy names the half that landed; the settings blurb says two
  pushes a day at 00:00 and 12:00 UTC instead of "one push a day".

**Deploy note:** needs both a re-paste of `supabase.sql` (to reschedule
the job) and `supabase functions deploy send-energy-alerts
--no-verify-jwt` (for the copy). Neither ships with the Pages build.

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
