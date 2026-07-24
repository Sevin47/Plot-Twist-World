-- Run this once in Supabase: SQL Editor -> New query -> paste -> Run.
--
-- Replaces the old fully-open `kv` table (which let any anon client rewrite
-- tile ownership, prices, or net worth directly) with a real relational
-- schema plus a locked-down write path: every economic action goes through
-- a `security definer` RPC function that computes price/balance/ownership
-- itself, server-side, using `auth.uid()` as the only source of identity.
-- Nothing but these functions can write to `profiles`/`tiles` — RLS is
-- enabled with SELECT-only policies, so a modified client can no longer
-- fabricate balance, ownership, rarity, or leaderboard standing.
--
-- This intentionally wipes any old anonymous-pid world state rather than
-- migrating it (pre-launch decision).

drop table if exists kv;

-- ── reference data: district tiers (mirrors CLS in PlotTwistWorld.jsx) ──
create table if not exists tile_class (
  cls text primary key,
  price bigint not null,
  rps numeric not null,
  sellable boolean not null default true
);
-- Tuned for a ~45-70 minute payback period per tier (was ~3.5 minutes) and
-- roughly 35-40x less revenue per tile — with 300m+ tiles on the planet,
-- the old numbers let income snowball into buying the whole world in an
-- afternoon; the limiting factor should be how fast someone can click buy,
-- not how fast money compounds. MUST match CLS in PlotTwistWorld.jsx exactly.
-- rps cut a further 25% (multiply by 0.75) on top of the tuning above —
-- lengthens per-tile payback from ~45-50min to ~60-67min to slow the whole
-- economy down and stretch out how many sessions it takes to reach any
-- given net worth, a deliberate retention lever, not a bug.
insert into tile_class (cls, price, rps, sellable) values
  ('downtown',   800, 0.225,  true),
  ('waterfront', 500, 0.135,  true),
  ('urban',      400, 0.105,  true),
  ('coast',      200, 0.0525, true),
  ('suburbs',    150, 0.0375, true),
  ('rural',      50,  0.0135, true),
  ('water',      50,  0.009,  false),
  -- landmark: the landmark itself IS the land use — real-world geo/water
  -- classification underneath a landmark tile is deliberately ignored
  -- entirely (see buy_unowned_tile's forced-cls override below), which is
  -- what fixes a real tile of the Eiffel Tower's 3x3 cluster sitting on
  -- the Seine and reading as unbuyable "international waters". `price`
  -- here is a display-only fallback — the real charge always comes from
  -- landmark_tiles.claim_price. rps intentionally matches Rural's (the
  -- lowest tier) — landmarks are about the perk and the trophy, not rent
  -- farming, on purpose.
  ('landmark',   1000000, 0.0135, true)
on conflict (cls) do update set price = excluded.price, rps = excluded.rps, sellable = excluded.sellable;

-- ── reference data: status ladder (mirrors STATUS_TIERS in
--    PlotTwistWorld.jsx). Sticky/high-water-mark — driven by
--    profiles.peak_net_worth (all-time-highest net worth), which never
--    decreases, not live current net worth — see reset_daily_energy and
--    the accrue_rent peak-tracking block below.
--
--    2026-07: added two tiers above the old ceiling (Magnate at 2M was
--    reachable by almost anyone with a bit of playtime, which flattened
--    the whole point of a status ladder — nothing left to aspire to).
--    Magnate itself moved from 2M to 10M; Tycoon and Mogul extend the
--    climb well past what a landmark-collecting whale needs (216 tiles
--    world-wide at 1M each). Also added daily_atk_cap, alongside
--    daily_energy_cap — attacks were flat for every tier before this,
--    which meant status only ever bought you claim throughput, never
--    combat throughput. ──
create table if not exists status_tier (
  tier int primary key,
  name text not null,
  min_net_worth bigint not null,
  daily_energy_cap int not null
);
-- builder_slots: max tiles a player can have under construction at once
-- (see the "Pacing: build timers" section below) — added here rather than
-- as a hardcoded CASE so it lives alongside daily_energy_cap as one
-- tier-indexed config table, same reasoning as that column.
alter table status_tier add column if not exists builder_slots int not null default 2;
-- daily_atk_cap: mirrors attack_tile's old hardcoded "6" — see the
-- 2026-07 note above. Default matches tier 1 so any pre-existing row
-- keeps working even before the insert below runs.
alter table status_tier add column if not exists daily_atk_cap int not null default 6;

insert into status_tier (tier, name, min_net_worth, daily_energy_cap, builder_slots, daily_atk_cap) values
  (1, 'Squatter',    0,         10, 2, 6),
  (2, 'Homesteader', 5000,      12, 2, 8),
  (3, 'Landholder',  25000,     14, 3, 10),
  (4, 'Developer',   100000,    16, 3, 12),
  (5, 'Baron',       500000,    18, 4, 14),
  (6, 'Magnate',     10000000,  20, 4, 16),
  (7, 'Tycoon',      50000000,  22, 5, 18),
  (8, 'Mogul',       250000000, 24, 6, 20)
on conflict (tier) do update set name = excluded.name, min_net_worth = excluded.min_net_worth, daily_energy_cap = excluded.daily_energy_cap, builder_slots = excluded.builder_slots, daily_atk_cap = excluded.daily_atk_cap;

-- ── accounts ──
create table if not exists profiles (
  user_id uuid primary key references auth.users(id) on delete cascade,
  username text unique not null,
  balance bigint not null default 2000,
  streak int not null default 0,
  last_daily date,
  boost_until timestamptz,
  boost_ready_at timestamptz,
  last_seen timestamptz not null default now(),
  created_at timestamptz not null default now()
);
-- Adds boost_ready_at to a profiles table created before the boost cooldown
-- existed — create table if not exists above is a no-op on an already-live
-- table, so this is what actually lands the column on a running database.
alter table profiles add column if not exists boost_ready_at timestamptz;

-- ── the world ──
-- owner references profiles (not auth.users directly) so PostgREST can
-- embed the seller's username in one query (tiles.select('*, profiles(username)'))
create table if not exists tiles (
  qk text primary key,
  owner uuid references profiles(user_id) on delete set null,
  cls text not null references tile_class(cls),
  level int not null default 0,
  rarity int not null default 0,
  paid bigint not null default 0,
  list_price bigint,
  updated_at timestamptz not null default now()
);
create index if not exists idx_tiles_owner on tiles(owner);
create index if not exists idx_tiles_listed on tiles(updated_at desc) where list_price is not null;

alter table tiles add column if not exists flip_price bigint;
alter table tiles add column if not exists flip_royalty_to uuid references profiles(user_id) on delete set null;
create index if not exists idx_tiles_flipped on tiles(updated_at desc) where flip_price is not null;
-- flip_royalty_to is a SECOND foreign key from tiles into profiles
-- (alongside owner) — this makes any unqualified PostgREST embed like
-- `profiles(username)` on a tiles query ambiguous ("more than one
-- relationship was found") and the whole query gets rejected, not just
-- the embed. The client's tiles queries use the FK-qualified form
-- `profiles!tiles_owner_fkey(username)` for exactly this reason — if you
-- add another FK from tiles to profiles later, audit every tiles query
-- with a profiles(...) embed in PlotTwistWorld.jsx, not just the new one.
-- "flip" — see flip_tile()/buy_flipped_tile() below: the alternative to
-- redevelop_tile's self-prestige loop. Instead of resetting a maxed tile
-- and keeping it, the owner tears it down and releases it back onto the
-- open market (owner set to null) at an auto-computed price, and gets a
-- fixed royalty cut whenever someone else buys it. Mutually exclusive with
-- prestige per cycle — a tile is owned-and-building, prestiging-in-place,
-- or released-and-flipped, never more than one of those at once.
-- text_pattern_ops so `qk like 'prefix%'` (region-shard lookups) can use an
-- index scan regardless of the database's default collation
create index if not exists idx_tiles_qk_pattern on tiles(qk text_pattern_ops);

alter table tiles add column if not exists prestige int not null default 0;
-- "redevelopment" — see redevelop_tile() below: resets a maxed-out (level 4)
-- tile back to Vacant in exchange for a permanent +25% rent bonus per cycle,
-- so a single tile has repeatable depth instead of dead-ending at Tower.
-- Rebuild cost also scales with this (see upgrade_tile), or a wealthy player
-- could farm unlimited rent multiplier at a fixed, non-escalating price.

-- ── lightweight "you sold a tile" notification log (money moves instantly
--    via profiles.balance above; this is just history, not a payment queue) ──
create table if not exists bank_ledger (
  id bigserial primary key,
  recipient uuid not null references auth.users(id) on delete cascade,
  amount bigint not null,
  from_username text,
  qk text,
  created_at timestamptz not null default now(),
  claimed boolean not null default false
);
create index if not exists idx_bank_ledger_recipient on bank_ledger(recipient) where claimed = false;

-- ── land economy: repossession of inactive-owner tiles + energy-limited
--    claims (see repossess_stale_tiles / reset_daily_energy / buy_unowned_tile
--    below). Additive only — safe to re-run against a live database. ──
alter table bank_ledger add column if not exists kind text not null default 'sale';
-- distinguishes "someone bought your listing" ('sale'), "a tile was
-- repossessed for inactivity" ('repossession'), and "your flipped tile
-- sold" ('flip', see buy_flipped_tile) in the one shared notification pipe
-- (claim_bank_ledger); no CHECK constraint — RLS already blocks any insert
-- except through the security-definer functions below, which are the only
-- writers.

alter table profiles add column if not exists energy int not null default 10;
alter table profiles add column if not exists energy_date date not null default (now() at time zone 'utc')::date;
-- Hard daily cap (10/day, no banking) on *new unowned land* claims,
-- independent of wallet size — the actual anti-sprawl lever, not just a
-- speed bump. Reset once per UTC calendar day, same "compute on read"
-- pattern as accrue_rent's rent accrual (see reset_daily_energy below) and
-- the same date-comparison idiom claim_daily already uses. Deliberately
-- hard-expire rather than bank up across missed days — a player who checks
-- in daily should get more total claims over time than one who checks in
-- weekly, not the same amount just delayed.
-- energy_at (timestamptz) is vestigial from the old continuous 1/60s-tick
-- regen model this replaced — safe to ignore, left in place rather than
-- dropped (this script never drops columns from a live table). No
-- blanket "cap existing energy down" migration line here (an earlier
-- version of this had one, hardcoded to 10) — now that the cap varies by
-- status tier (see peak_net_worth/status_tier below), that would wrongly
-- punish a high-status player; any old leftover energy self-corrects at
-- each player's own next UTC-day reset regardless.

create index if not exists idx_profiles_last_seen on profiles(last_seen);
-- backs repossess_stale_tiles()'s inactivity scan below

alter table profiles add column if not exists peak_net_worth bigint not null default 0;
-- Sticky status ladder (see status_tier above): driven by the
-- all-time-highest net worth this account has ever reached, which only
-- ever increases (see accrue_rent's rate-limited peak-tracking block) —
-- never demotes a player for spending down or losing tiles, same
-- philosophy as everything else this session (boost cooldown not a
-- penalty, resync-on-focus not a session lock, etc.). Also what
-- reset_daily_energy looks up to decide a player's actual daily cap, now
-- that it varies by tier instead of being a flat number for everyone.
-- One-time backfill for existing accounts, so nobody's status appears to
-- reset to tier 1 on this migration even though they've already earned
-- more — guarded by peak_net_worth = 0 so it only touches never-backfilled
-- rows (a real account can't have exactly 0 once backfilled, since every
-- profile starts with a positive balance).
update profiles p set peak_net_worth = p.balance + coalesce((select sum(t.paid) from tiles t where t.owner = p.user_id), 0)
where p.peak_net_worth = 0;

-- Commendations (ACH in PlotTwistWorld.jsx) — see sync_achievements far
-- below for why this is persisted at all (badges used to be client-only
-- and un-viewable for anyone but yourself). Declared up here, ahead of
-- the leaderboard view below, since that view selects it.
alter table profiles add column if not exists ach jsonb not null default '{}'::jsonb;

-- ── territory: a player's fine-deed-grid interaction is gated to regions
--    they've unlocked (see unlock_region / buy_unowned_tile below) — the
--    same REGION_LEN=8 quadkey-prefix "region" (~150km) the client already
--    uses for ownership-sync sharding, reused here as the unlock unit so no
--    new geometry/distance logic is needed anywhere, client or server. ──
create table if not exists unlocked_regions (
  owner uuid not null references profiles(user_id) on delete cascade,
  region text not null,
  is_home boolean not null default false,
  unlocked_at timestamptz not null default now(),
  primary key (owner, region)
);
create index if not exists idx_unlocked_regions_owner on unlocked_regions(owner);

-- one-time grandfathering: anyone who already owns tiles today keeps free
-- access to every region they're already established in — this feature
-- must never retroactively lock an existing player out of their own
-- territory. Idempotent (on conflict do nothing), safe to re-run.
insert into unlocked_regions (owner, region, is_home)
select owner, left(qk, 8) as region, false
from tiles
where owner is not null
group by owner, left(qk, 8)
on conflict (owner, region) do nothing;

-- mark each owner's single earliest-acquired region as home (only among
-- rows this migration itself just inserted as non-home, so re-running
-- never clobbers a home already chosen via real gameplay afterward)
with earliest as (
  select distinct on (owner) owner, left(qk, 8) as region
  from tiles
  where owner is not null
  order by owner, updated_at asc
)
update unlocked_regions ur
set is_home = true
from earliest e
where ur.owner = e.owner and ur.region = e.region
  and not exists (select 1 from unlocked_regions where owner = e.owner and is_home = true);

-- ── RLS: public read everywhere it matters, NO direct writes anywhere.
--    All mutation happens through the security-definer functions below.
--    (drop-then-create because CREATE POLICY has no IF NOT EXISTS — this
--    makes the whole script safe to re-run any time, e.g. after a price
--    change like this one.) ──
alter table tile_class enable row level security;
drop policy if exists "read tile_class" on tile_class;
create policy "read tile_class" on tile_class for select using (true);
grant select on tile_class to anon, authenticated;

alter table status_tier enable row level security;
drop policy if exists "read status_tier" on status_tier;
create policy "read status_tier" on status_tier for select using (true);
grant select on status_tier to anon, authenticated;

alter table profiles enable row level security;
drop policy if exists "read profiles" on profiles;
create policy "read profiles" on profiles for select using (true);
grant select on profiles to anon, authenticated;

alter table tiles enable row level security;
drop policy if exists "read tiles" on tiles;
create policy "read tiles" on tiles for select using (true);
grant select on tiles to anon, authenticated;

alter table bank_ledger enable row level security;
drop policy if exists "read own bank_ledger" on bank_ledger;
create policy "read own bank_ledger" on bank_ledger for select using (auth.uid() = recipient);
grant select on bank_ledger to authenticated;

alter table unlocked_regions enable row level security;
drop policy if exists "read own unlocked_regions" on unlocked_regions;
create policy "read own unlocked_regions" on unlocked_regions for select using (auth.uid() = owner);
grant select on unlocked_regions to authenticated;

-- ═════════════════════════════════════════════════════════════
-- Internal helper: credit real elapsed-time rent onto a profile.
-- NOT exposed to clients directly (no grant to anon/authenticated) —
-- every public function below calls this first so a stale client-side
-- sync can never cause a legitimate purchase to be wrongly rejected,
-- and a client can never claim more than its own tiles actually earned.
-- Mirrors PlotTwistWorld.jsx's two rent rules: live full-rate accrual
-- while actively playing (<=120s since last sync), half-rate capped at
-- 8h for a real "welcome back" gap (>120s) — matching the client's
-- `+₲ while you were away` behavior exactly.
-- ═════════════════════════════════════════════════════════════
create or replace function accrue_rent(p_uid uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_profile profiles;
  v_rps numeric;
  v_elapsed numeric;
  v_gain numeric;
  v_mult numeric;
  v_net_worth bigint;
begin
  select * into v_profile from profiles where user_id = p_uid for update;
  if not found then return; end if;

  select coalesce(sum(
    tc.rps * (case t.rarity when 0 then 1 when 1 then 1.5 when 2 then 3 when 3 then 8 else 1 end) * (1 + t.level) * (1 + 0.25 * t.prestige)
  ), 0) into v_rps
  from tiles t join tile_class tc on tc.cls = t.cls
  where t.owner = p_uid;

  v_elapsed := greatest(0, extract(epoch from (now() - v_profile.last_seen)));

  if v_elapsed <= 120 then
    v_mult := case when v_profile.boost_until is not null and v_profile.boost_until > now() then 2 else 1 end;
    v_gain := v_rps * v_mult * v_elapsed;
  else
    v_gain := v_rps * 0.5 * least(v_elapsed, 8 * 3600);
  end if;

  update profiles set balance = balance + floor(v_gain), last_seen = now() where user_id = p_uid;

  perform finish_builds(p_uid); -- see the "Pacing: build timers" section below
  perform reset_daily_energy(p_uid);
  perform reset_daily_attacks_sent(p_uid);
  -- rate-limited to a quarter of calls, not every one — repossess_stale_tiles
  -- does real writes (balance credit + ledger insert + delete) per row, so
  -- there's no need to run it on literally every RPC round-trip; any active
  -- player's ordinary traffic still drives it constantly enough with no
  -- cron/extension required.
  if random() < 0.25 then perform repossess_stale_tiles(); end if;

  -- Same rate-limiting logic for the sticky status ladder's high-water
  -- mark (see peak_net_worth above) — this aggregates over every tile a
  -- player owns, so it doesn't need to run on literally every call either.
  if random() < 0.25 then
    select balance + coalesce((select sum(paid) from tiles where owner = p_uid), 0)
    into v_net_worth from profiles where user_id = p_uid;
    update profiles set peak_net_worth = greatest(peak_net_worth, v_net_worth) where user_id = p_uid;
  end if;
end;
$$;
revoke all on function accrue_rent(uuid) from public;

-- Renamed from regen_energy — CREATE OR REPLACE can't rename a function,
-- so the old name has to be dropped explicitly (same pattern used for
-- claim_bank_ledger's signature change above).
drop function if exists regen_energy(uuid);

-- ── reset_daily_energy: hard daily cap on buy_unowned_tile's energy gate,
--    replacing the old continuous 1/60s leaky-bucket regen entirely. Once
--    per UTC calendar day, energy resets to this player's current status
--    tier's daily_energy_cap (see status_tier/peak_net_worth above) —
--    deliberately hard-expire, not banked: unused claims from a day you
--    didn't play are gone, not carried forward, so a daily-habit player
--    accumulates more total claims over time than a weekly one, not just
--    the same amount delayed. Same "compute on read" pattern as
--    accrue_rent above, and the same date-comparison idiom claim_daily
--    already uses for the streak. The cap is looked up fresh at each
--    day's reset, not recalculated mid-day — crossing into a new tier
--    takes effect on the next day's reset, not retroactively today. ──
create or replace function reset_daily_energy(p_uid uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_today date := (now() at time zone 'utc')::date;
  v_cap int;
  v_energy_bonus int;
begin
  select st.daily_energy_cap into v_cap
  from status_tier st
  where st.min_net_worth <= (select peak_net_worth from profiles where user_id = p_uid)
  order by st.min_net_worth desc
  limit 1;

  -- energy_boost: flat, account-wide (energy itself isn't regional, unlike
  -- the other three perk types) — not capped by perk_pct_cap, wrong unit
  -- for a flat count; natural ceiling is how many energy_boost landmark
  -- tiles exist in the world at all (6 landmarks x 9 tiles = 54 max,
  -- across every player combined).
  select coalesce(sum(l.perk_value_per_tile), 0) into v_energy_bonus
  from tiles t
  join landmark_tiles lt on lt.qk = t.qk
  join landmarks l on l.id = lt.landmark_id
  where t.owner = p_uid and l.perk_type = 'energy_boost';

  update profiles set energy = coalesce(v_cap, 10) + coalesce(v_energy_bonus, 0), energy_date = v_today
  where user_id = p_uid and energy_date < v_today;
end;
$$;
revoke all on function reset_daily_energy(uuid) from public;

-- ── reset_daily_attacks_sent: hard daily cap (6/day, flat, not tier-scaled)
--    on attack_tile's "attacks launched" gate. Same compute-on-read,
--    hard-expire-not-banked pattern as reset_daily_energy above, called
--    from accrue_rent the same way so the counter stays fresh on every
--    sync_rent(), not just when the player actually attacks. ──
create or replace function reset_daily_attacks_sent(p_uid uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_today date := (now() at time zone 'utc')::date;
begin
  update profiles set attacks_sent_count = 0, attacks_sent_date = v_today
  where user_id = p_uid and attacks_sent_date < v_today;
end;
$$;
revoke all on function reset_daily_attacks_sent(uuid) from public;

-- ── repossess_stale_tiles: land decay. An owner absent 30+ days (profiles.
--    last_seen — already tracked by accrue_rent for every player, no new
--    activity column needed) has their tiles returned to the unclaimed pool
--    a few at a time, with a 30% refund of what they paid credited to their
--    balance and logged so they see it next time they do return. Mirrors
--    abandon_tile's delete-the-row semantics below (unowned tiles simply
--    aren't rows in `tiles`), just system-initiated with a smaller refund
--    and a notification since the owner isn't there to see it happen.
--
--    Also sweeps up a separate pre-existing gap noticed while building this:
--    `tiles.owner references profiles(user_id) on delete set null` means a
--    deleted account leaves its tiles behind as permanently-stuck `owner is
--    null` rows — buy_unowned_tile can never reclaim them (primary-key
--    conflict on qk) and nobody owns them to ever call abandon_tile. Left
--    join (not the original inner join) so those rows are found too; no
--    refund/notification for them since there's no one left to receive one. ──
create or replace function repossess_stale_tiles()
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_tile record;
  v_refund bigint;
begin
  for v_tile in
    select t.qk, t.owner, t.paid
    from tiles t
    left join profiles p on p.user_id = t.owner
    -- t.owner is null alone would also match an active flip listing
    -- (flip_tile sets owner = null on purpose while it waits for a buyer —
    -- see flip_tile/buy_flipped_tile above) and, worse, such a listing
    -- would sort FIRST every time (coalesce(null last_seen, 'epoch') is
    -- always the oldest possible timestamp), making it the top repossession
    -- target within seconds of being created. flip_price is not null is
    -- exactly how a real orphaned owner=null row (deleted account, see
    -- above) is told apart from a live flip listing.
    where (t.owner is null and t.flip_price is null) or p.last_seen < now() - interval '30 days'
    order by coalesce(p.last_seen, 'epoch'::timestamptz) asc
    limit 5
    for update of t skip locked
  loop
    if v_tile.owner is not null then
      v_refund := round(v_tile.paid * 0.3);
      update profiles set balance = balance + v_refund where user_id = v_tile.owner;
      insert into bank_ledger (recipient, amount, from_username, qk, kind)
      values (v_tile.owner, v_refund, 'World Deed Office', v_tile.qk, 'repossession');
    end if;
    delete from tiles where qk = v_tile.qk;
  end loop;
end;
$$;
revoke all on function repossess_stale_tiles() from public;

-- ── claim_username: first-login setup, also used for rename ──
create or replace function claim_username(p_username text)
returns profiles
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  v_name text := trim(p_username);
  v_row profiles;
begin
  if v_uid is null then raise exception 'not authenticated'; end if;
  if v_name !~ '^[A-Za-z0-9_]{2,16}$' then
    raise exception 'username must be 2-16 letters, numbers or underscores';
  end if;

  insert into profiles (user_id, username, last_seen)
  values (v_uid, v_name, now())
  on conflict (user_id) do update set username = excluded.username
  returning * into v_row;

  return v_row;
exception
  when unique_violation then
    raise exception 'that username is taken';
end;
$$;
revoke all on function claim_username(text) from public;
grant execute on function claim_username(text) to authenticated;

-- ── sync_rent: client calls this periodically + at boot to reconcile its
--    optimistic live-ticking display against the real server balance ──
create or replace function sync_rent()
returns profiles
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  v_row profiles;
begin
  if v_uid is null then raise exception 'not authenticated'; end if;
  perform accrue_rent(v_uid);
  select * into v_row from profiles where user_id = v_uid;
  return v_row;
end;
$$;
revoke all on function sync_rent() from public;
grant execute on function sync_rent() to authenticated;

-- ── activate_boost: 2x rent for 5 minutes (fake "watch an ad" reward).
--    Server-side because boost_until directly doubles accrue_rent's output —
--    a client-set value would let anyone grant themselves permanent 2x.
--    Gated by boost_ready_at (30 min between activations = 5 min active +
--    25 min cooldown) so it's a thing to catch, not a timer to babysit —
--    without a cooldown a rational player would re-click it every 5 minutes
--    to avoid leaving free rent on the table. Checked server-side for the
--    same reason boost_until is: a client-only cooldown is not a cooldown. ──
create or replace function activate_boost()
returns profiles
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  v_row profiles;
begin
  if v_uid is null then raise exception 'not authenticated'; end if;
  perform accrue_rent(v_uid);
  select * into v_row from profiles where user_id = v_uid;
  if not found then raise exception 'no profile'; end if;
  if v_row.boost_ready_at is not null and v_row.boost_ready_at > now() then
    raise exception 'boost on cooldown for % more seconds', ceil(extract(epoch from (v_row.boost_ready_at - now())));
  end if;
  update profiles
    set boost_until = now() + interval '5 minutes',
        boost_ready_at = now() + interval '30 minutes'
    where user_id = v_uid
  returning * into v_row;
  return v_row;
end;
$$;
revoke all on function activate_boost() from public;
grant execute on function activate_boost() to authenticated;

-- ── claim_daily: streak stipend, once per UTC calendar day ──
create or replace function claim_daily()
returns table(streak int, reward bigint, already_claimed boolean)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  v_profile profiles;
  v_today date := (now() at time zone 'utc')::date;
  v_reward bigint;
  v_new_streak int;
begin
  if v_uid is null then raise exception 'not authenticated'; end if;
  perform accrue_rent(v_uid);
  select * into v_profile from profiles where user_id = v_uid for update;
  if not found then raise exception 'no profile'; end if;

  if v_profile.last_daily = v_today then
    return query select v_profile.streak, 0::bigint, true;
    return;
  end if;

  v_new_streak := case when v_profile.last_daily = v_today - 1 then v_profile.streak + 1 else 1 end;
  v_reward := 150 * least(v_new_streak, 7);

  update profiles set balance = balance + v_reward, streak = v_new_streak, last_daily = v_today
  where user_id = v_uid;

  return query select v_new_streak, v_reward, false;
end;
$$;
revoke all on function claim_daily() from public;
grant execute on function claim_daily() to authenticated;

-- ── unlock_region: pays to extend a player's fine-deed-grid territory
--    beyond their free home region (see buy_unowned_tile below for how home
--    itself gets set, and the unlocked_regions table comment for why a
--    "region" is just a REGION_LEN=8 quadkey prefix). ──
create or replace function unlock_region(p_qk text)
returns unlocked_regions
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  v_region text := left(p_qk, 8);
  v_cost bigint;
  v_row unlocked_regions;
begin
  if v_uid is null then raise exception 'not authenticated'; end if;
  perform accrue_rent(v_uid);

  if exists (select 1 from unlocked_regions where owner = v_uid and region = v_region) then
    raise exception 'already unlocked';
  end if;

  -- the free home region is excluded from this count, so the first PAID
  -- unlock is exactly 1000, the second 2000, the third 4000, and so on
  v_cost := round(1000 * power(2, (
    select count(*) from unlocked_regions where owner = v_uid and is_home = false
  )))::bigint;

  if (select balance from profiles where user_id = v_uid) < v_cost then
    raise exception 'insufficient balance';
  end if;

  update profiles set balance = balance - v_cost where user_id = v_uid;
  insert into unlocked_regions (owner, region, is_home)
  values (v_uid, v_region, false)
  returning * into v_row;

  return v_row;
end;
$$;
revoke all on function unlock_region(text) from public;
grant execute on function unlock_region(text) to authenticated;

-- ── buy_unowned_tile: price/rarity are both server-decided, never client-supplied ──
create or replace function buy_unowned_tile(p_qk text, p_cls text)
returns tiles
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  v_class tile_class;
  v_roll numeric;
  v_rarity int;
  v_row tiles;
  v_region text := left(p_qk, 8);
  v_is_first_tile boolean;
  v_dev_mode boolean;
  v_price bigint;
  v_cls text;
  v_is_landmark boolean;
begin
  if v_uid is null then raise exception 'not authenticated'; end if;
  if not exists (select 1 from profiles where user_id = v_uid) then raise exception 'no profile'; end if;
  perform accrue_rent(v_uid);

  select dev_mode into v_dev_mode from profiles where user_id = v_uid;

  -- landmark tiles ignore whatever real-world land use/water classification
  -- the client thinks this qk has and are ALWAYS 'landmark' — the landmark
  -- itself is the land use, full stop. Never trust p_cls for this; derive
  -- it server-side from landmark_tiles so a stale/wrong client-reported cls
  -- (e.g. "water", which is exactly what a real tile of the Eiffel Tower's
  -- cluster sitting on the Seine was reporting) can never block a claim.
  select claim_price into v_price from landmark_tiles where qk = p_qk;
  v_is_landmark := v_price is not null;
  v_cls := case when v_is_landmark then 'landmark' else p_cls end;

  select * into v_class from tile_class where cls = v_cls;
  if not found or v_class.sellable = false then raise exception 'not purchasable'; end if;

  -- landmark tiles claim at their own steep flat price instead of the
  -- district price — see the "Landmarks" section above. Energy gate and
  -- region-unlock gate are otherwise unaffected; this is a claim like any
  -- other, just far more expensive.
  v_price := coalesce(v_price, v_class.price);

  if (select balance from profiles where user_id = v_uid) < v_price then
    raise exception 'insufficient balance';
  end if;
  -- energy gates claiming NEW unowned land specifically — the actual sprawl
  -- vector (zoom anywhere, buy instantly). buy_listed_tile (trading with
  -- another player) and upgrade_tile (investing in what you already own)
  -- are deliberately left energy-free. dev_mode accounts skip this gate
  -- entirely (see the column comment above).
  if not v_dev_mode and (select energy from profiles where user_id = v_uid) < 1 then
    raise exception 'no energy left today — resets tomorrow (your daily cap grows with status)';
  end if;

  -- a player's very first tile anywhere is always allowed regardless of
  -- unlocked territory — that purchase itself is what sets their free home
  -- region (see the unlocked_regions upsert below). Every purchase after
  -- that requires the target region to already be unlocked (see
  -- unlock_region above); this is the actual anti-sprawl/locality lever —
  -- energy only throttles rate, this throttles reach.
  v_is_first_tile := not exists (select 1 from tiles where owner = v_uid);
  if not v_is_first_tile and not exists (
    select 1 from unlocked_regions where owner = v_uid and region = v_region
  ) then
    raise exception 'region not unlocked — travel here first';
  end if;

  -- landmark tiles never roll rarity — always Common (0). The incentive to
  -- hold a landmark piece is the perk and the trophy, not a lucky rarity
  -- multiplier that makes one player's identical ₲1,000,000 purchase
  -- quietly worth more than another's.
  if v_is_landmark then
    v_rarity := 0;
  else
    v_roll := random();
    v_rarity := case when v_roll < 0.02 then 3 when v_roll < 0.10 then 2 when v_roll < 0.30 then 1 else 0 end;
  end if;

  update profiles
    set balance = balance - v_price,
        energy = case when v_dev_mode then energy else energy - 1 end
    where user_id = v_uid;
  insert into tiles (qk, owner, cls, level, rarity, paid, owner_since, updated_at)
  values (p_qk, v_uid, v_cls, 0, v_rarity, v_price, now(), now())
  returning * into v_row;

  if v_is_first_tile then
    insert into unlocked_regions (owner, region, is_home)
    values (v_uid, v_region, true)
    on conflict (owner, region) do nothing;
  end if;

  return v_row;
exception
  when unique_violation then
    raise exception 'beaten to it — someone already owns that tile';
end;
$$;
revoke all on function buy_unowned_tile(text, text) from public;
grant execute on function buy_unowned_tile(text, text) to authenticated;

-- ── buy_listed_tile: verifies the listing hasn't changed, moves money
--    between both accounts atomically, no mailbox/polling needed ──
create or replace function buy_listed_tile(p_qk text, p_expected_price bigint)
returns tiles
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  v_tile tiles;
  v_seller uuid;
  v_buyer_name text;
  v_region text := left(p_qk, 8);
  v_is_first_tile boolean;
begin
  if v_uid is null then raise exception 'not authenticated'; end if;
  if not exists (select 1 from profiles where user_id = v_uid) then raise exception 'no profile'; end if;
  perform accrue_rent(v_uid);

  select * into v_tile from tiles where qk = p_qk for update;
  if not found then raise exception 'tile not found'; end if;
  if v_tile.owner = v_uid then raise exception 'you already own this tile'; end if;
  if v_tile.list_price is null or v_tile.list_price <> p_expected_price then
    raise exception 'listing changed';
  end if;
  if (select balance from profiles where user_id = v_uid) < p_expected_price then
    raise exception 'insufficient balance';
  end if;

  -- Trading is now region-gated the same as claiming new land (see
  -- buy_unowned_tile's identical check/bootstrap-exemption pattern) — the
  -- Market tab only ever queries/shows listings inside regions the buyer
  -- has unlocked, so this is enforcement of a rule the client already
  -- follows, not a new restriction a normal client should ever hit.
  v_is_first_tile := not exists (select 1 from tiles where owner = v_uid);
  if not v_is_first_tile and not exists (
    select 1 from unlocked_regions where owner = v_uid and region = v_region
  ) then
    raise exception 'region not unlocked — travel here first';
  end if;

  v_seller := v_tile.owner;
  select username into v_buyer_name from profiles where user_id = v_uid;

  update profiles set balance = balance - p_expected_price where user_id = v_uid;
  update profiles set balance = balance + p_expected_price where user_id = v_seller;

  update tiles set owner = v_uid, paid = p_expected_price, list_price = null, owner_since = now(), updated_at = now()
  where qk = p_qk
  returning * into v_tile;
  -- see the "Tile nicknames" section below: the seller's private nickname
  -- (if any) doesn't carry over to a new owner
  delete from tile_nicknames where tile_nicknames.qk = p_qk;

  if v_is_first_tile then
    insert into unlocked_regions (owner, region, is_home)
    values (v_uid, v_region, true)
    on conflict (owner, region) do nothing;
  end if;

  insert into bank_ledger (recipient, amount, from_username, qk)
  values (v_seller, p_expected_price, v_buyer_name, p_qk);

  return v_tile;
end;
$$;
revoke all on function buy_listed_tile(text, bigint) from public;
grant execute on function buy_listed_tile(text, bigint) to authenticated;

-- ── list_tile / unlist_tile ──
create or replace function list_tile(p_qk text, p_price bigint)
returns tiles
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  v_row tiles;
begin
  if v_uid is null then raise exception 'not authenticated'; end if;
  if p_price is null or p_price <= 0 then raise exception 'invalid price'; end if;
  if exists (select 1 from tiles where qk = p_qk and owner = v_uid and build_until is not null) then
    raise exception 'tile is mid-build — finish or rush it before listing';
  end if;

  update tiles set list_price = p_price, updated_at = now()
  where qk = p_qk and owner = v_uid
  returning * into v_row;
  if not found then raise exception 'tile not found or not yours'; end if;
  return v_row;
end;
$$;
revoke all on function list_tile(text, bigint) from public;
grant execute on function list_tile(text, bigint) to authenticated;

create or replace function unlist_tile(p_qk text)
returns tiles
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  v_row tiles;
begin
  if v_uid is null then raise exception 'not authenticated'; end if;
  update tiles set list_price = null, updated_at = now()
  where qk = p_qk and owner = v_uid
  returning * into v_row;
  if not found then raise exception 'tile not found or not yours'; end if;
  return v_row;
end;
$$;
revoke all on function unlist_tile(text) from public;
grant execute on function unlist_tile(text) to authenticated;

-- ── upgrade_tile: cost formula ported from upCost() in PlotTwistWorld.jsx ──
-- ── upgrade_tile: starts a build timer instead of completing instantly
--    (see "Pacing: build timers" below) — cost is charged up front same as
--    always, but the level only bumps once build_until passes (lazily, via
--    finish_builds). Gated by builder_slots so a player can't queue their
--    whole portfolio at once. dev_mode accounts skip the timer and the
--    slot cap entirely and complete immediately, matching the pre-timer
--    behavior — needed for fast iteration/testing. ──
create or replace function upgrade_tile(p_qk text)
returns tiles
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  v_tile tiles;
  v_class tile_class;
  v_cost bigint;
  v_dev_mode boolean;
  v_active_builds int;
  v_slot_cap int;
  v_duration interval;
  v_build_speed_pct numeric;
begin
  if v_uid is null then raise exception 'not authenticated'; end if;
  if not exists (select 1 from profiles where user_id = v_uid) then raise exception 'no profile'; end if;
  perform accrue_rent(v_uid); -- also completes any of this player's finished builds, see finish_builds

  select dev_mode into v_dev_mode from profiles where user_id = v_uid;

  select * into v_tile from tiles where tiles.qk = p_qk and owner = v_uid for update;
  if not found then raise exception 'tile not found or not yours'; end if;
  -- landmark tiles never develop — thematically the landmark itself IS the
  -- building (nobody builds an apartment tower on the Eiffel Tower). This
  -- also means level stays permanently 0 for any landmark tile, so
  -- redevelop_tile/flip_tile's existing "requires level >= 4" checks
  -- already block those forever too, with no extra code needed there.
  if exists (select 1 from landmark_tiles where qk = p_qk) then
    raise exception 'landmark tiles can''t be developed — the landmark itself is the attraction';
  end if;
  if v_tile.level >= 4 then raise exception 'already at max level'; end if;
  if v_tile.build_until is not null then raise exception 'already building — wait or rush it'; end if;

  if not v_dev_mode then
    select count(*) into v_active_builds from tiles where owner = v_uid and build_until is not null;
    select st.builder_slots into v_slot_cap
    from status_tier st
    where st.min_net_worth <= (select peak_net_worth from profiles where user_id = v_uid)
    order by st.min_net_worth desc
    limit 1;
    if v_active_builds >= coalesce(v_slot_cap, 2) then
      raise exception 'no free builder slots — rush a build or wait for one to finish';
    end if;
  end if;

  select * into v_class from tile_class where cls = v_tile.cls;
  -- the prestige factor is why this doesn't cost the same every
  -- redevelopment cycle — see the `prestige` column comment above.
  -- Capped at 10 (MUST match PRESTIGE_COST_CAP in PlotTwistWorld.jsx and
  -- the matching cap in rush_build below): uncapped, this multiplier
  -- compounds across every rebuild cycle into tiles.paid — which never
  -- resets on redevelop — producing quadratic growth (cycle 50 landed
  -- paid around ₲13M on a base Downtown tile). That number then leaked
  -- into peak_net_worth and abandon_tile's refund (both read paid
  -- directly), not just flip_price (which has since been decoupled from
  -- paid entirely — see flip's removal). The rent bonus itself (accrue_rent,
  -- redevelop_tile) stays uncapped — prestige keeps paying off forever,
  -- it just stops getting more expensive to maintain past cycle 10.
  v_cost := round(v_class.price * 0.8 * power(v_tile.level + 1, 1.6) * (1 + 0.5 * least(v_tile.prestige, 10)));

  if (select balance from profiles where user_id = v_uid) < v_cost then
    raise exception 'insufficient balance';
  end if;

  update profiles set balance = balance - v_cost where user_id = v_uid;

  if v_dev_mode then
    update tiles set level = level + 1, paid = paid + v_cost, updated_at = now()
    where tiles.qk = p_qk
    returning * into v_tile;
  else
    -- MUST match BUILD_SECONDS in PlotTwistWorld.jsx exactly (client-side
    -- display/rush-cost mirror, server here is the sole authority). Same
    -- prestige cap as v_cost above, same reasoning.
    v_duration := (case v_tile.level + 1
        when 1 then interval '5 minutes'
        when 2 then interval '30 minutes'
        when 3 then interval '2 hours'
        when 4 then interval '8 hours'
      end) * (1 + 0.25 * least(v_tile.prestige, 10));

    -- build_speed: sum of this player's landmark tiles' perk contribution
    -- in THIS tile's region (REGION_LEN=8 prefix, reusing the existing
    -- region concept — no new geometry). Live sum, never stored, so it
    -- tracks ownership changes automatically. Capped per-landmark at
    -- perk_pct_cap (30) so it can never approach a free build.
    select least(coalesce(sum(l.perk_value_per_tile), 0), coalesce(max(l.perk_pct_cap), 30))
      into v_build_speed_pct
    from tiles t2
    join landmark_tiles lt2 on lt2.qk = t2.qk
    join landmarks l on l.id = lt2.landmark_id
    where t2.owner = v_uid and l.perk_type = 'build_speed' and left(t2.qk, 8) = left(p_qk, 8);
    v_duration := v_duration * (1 - coalesce(v_build_speed_pct, 0) / 100);

    update tiles set paid = paid + v_cost, build_until = now() + v_duration, updated_at = now()
    where tiles.qk = p_qk
    returning * into v_tile;
  end if;

  return v_tile;
end;
$$;
revoke all on function upgrade_tile(text) from public;
grant execute on function upgrade_tile(text) to authenticated;

-- ── rush_build: pay to finish an in-progress build instantly. Priced
--    proportional to how much time is actually left — rushing right after
--    starting costs close to the full upgrade price again, rushing near
--    completion costs almost nothing. ──
create or replace function rush_build(p_qk text)
returns tiles
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  v_tile tiles;
  v_class tile_class;
  v_full_cost bigint;
  v_total_secs numeric;
  v_remaining_secs numeric;
  v_frac numeric;
  v_rush_cost bigint;
  v_build_speed_pct numeric;
  v_rush_discount_pct numeric;
begin
  if v_uid is null then raise exception 'not authenticated'; end if;
  perform accrue_rent(v_uid);

  select * into v_tile from tiles where tiles.qk = p_qk and owner = v_uid for update;
  if not found then raise exception 'tile not found or not yours'; end if;
  if v_tile.build_until is null then raise exception 'nothing is building on this tile'; end if;

  select * into v_class from tile_class where cls = v_tile.cls;
  -- same prestige cap as upgrade_tile — see that function's comment
  v_full_cost := round(v_class.price * 0.8 * power(v_tile.level + 1, 1.6) * (1 + 0.5 * least(v_tile.prestige, 10)));

  -- must match the SAME effective duration upgrade_tile used when it set
  -- build_until (including the build_speed perk), or v_frac below would
  -- be computed against the wrong total and misprice the rush.
  select least(coalesce(sum(l.perk_value_per_tile), 0), coalesce(max(l.perk_pct_cap), 30))
    into v_build_speed_pct
  from tiles t2
  join landmark_tiles lt2 on lt2.qk = t2.qk
  join landmarks l on l.id = lt2.landmark_id
  where t2.owner = v_uid and l.perk_type = 'build_speed' and left(t2.qk, 8) = left(p_qk, 8);

  v_total_secs := extract(epoch from (
    (case v_tile.level + 1
        when 1 then interval '5 minutes'
        when 2 then interval '30 minutes'
        when 3 then interval '2 hours'
        when 4 then interval '8 hours'
      end) * (1 + 0.25 * least(v_tile.prestige, 10))
  )) * (1 - coalesce(v_build_speed_pct, 0) / 100);
  v_remaining_secs := greatest(0, extract(epoch from (v_tile.build_until - now())));
  v_frac := least(1, v_remaining_secs / greatest(v_total_secs, 1));
  v_rush_cost := ceil(v_full_cost * v_frac);

  -- rush_discount: same region-scoped live-sum pattern, applied to the
  -- final rush price (independent lever from build_speed — a shorter
  -- perked duration already makes rushes cheaper at the same remaining
  -- fraction; this discounts the price itself on top of that, the two
  -- compose without double-counting since they act on different factors).
  select least(coalesce(sum(l.perk_value_per_tile), 0), coalesce(max(l.perk_pct_cap), 30))
    into v_rush_discount_pct
  from tiles t2
  join landmark_tiles lt2 on lt2.qk = t2.qk
  join landmarks l on l.id = lt2.landmark_id
  where t2.owner = v_uid and l.perk_type = 'rush_discount' and left(t2.qk, 8) = left(p_qk, 8);
  v_rush_cost := ceil(v_rush_cost * (1 - coalesce(v_rush_discount_pct, 0) / 100));

  if v_rush_cost > 0 and (select balance from profiles where user_id = v_uid) < v_rush_cost then
    raise exception 'insufficient balance to rush';
  end if;

  update profiles set balance = balance - v_rush_cost where user_id = v_uid;
  update tiles set level = level + 1, build_until = null, updated_at = now()
  where tiles.qk = p_qk
  returning * into v_tile;

  return v_tile;
end;
$$;
revoke all on function rush_build(text) from public;
grant execute on function rush_build(text) to authenticated;

-- ── redevelop_tile: the prestige loop. Requires a fully-built (level 4)
--    tile; resets it to Vacant in exchange for a permanent +25% rent bonus
--    (see accrue_rent) on this tile, repeatable indefinitely — each cycle's
--    rebuild costs more than the last (see upgrade_tile's prestige factor),
--    so this self-limits without an arbitrary hard cap on prestige. No
--    separate charge here: giving up four levels of paid-for building IS
--    the cost, same as how upgrading itself is just credits spent. ──
create or replace function redevelop_tile(p_qk text)
returns tiles
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  v_tile tiles;
begin
  if v_uid is null then raise exception 'not authenticated'; end if;
  perform accrue_rent(v_uid);

  select * into v_tile from tiles where qk = p_qk and owner = v_uid for update;
  if not found then raise exception 'tile not found or not yours'; end if;
  if v_tile.level < 4 then raise exception 'not fully built yet'; end if;

  update tiles set level = 0, prestige = prestige + 1, updated_at = now()
  where qk = p_qk
  returning * into v_tile;

  return v_tile;
end;
$$;
revoke all on function redevelop_tile(text) from public;
grant execute on function redevelop_tile(text) to authenticated;

-- ── flip/buy_flipped: CUT (2026-07). The mechanic never found a real niche
--    once PvP existed — abandon_tile (50% of paid, instant, any level)
--    paid out roughly 10x more than flip in every realistic case, and
--    listing already covers voluntary sale. flip's only unique property
--    (owner -> null removes attack exposure immediately, same as abandon,
--    but keeps the tile claimable instead of erasing it) wasn't enough to
--    carry it as a standalone mechanic. May come back later in a different
--    shape — see the design discussion for context if reviving this.
--
--    tiles.flip_price/flip_royalty_to columns are left in place (this file
--    never drops columns from a live table) but are permanently null going
--    forward — nothing writes them anymore. Any tile flip-listed before
--    this cutover is deleted outright below rather than left owner=null
--    forever with no buy path: buy_unowned_tile only succeeds when NO row
--    exists for a qk (its insert relies on a primary-key conflict to
--    detect "already claimed"), so an orphaned owner=null row with
--    flip_price set — unreachable now that buy_flipped_tile is gone —
--    would otherwise sit permanently unclaimable AND unrepossessable
--    (repossess_stale_tiles deliberately excludes flip_price is not null
--    rows, to avoid sweeping up live flip listings). Deleting returns that
--    land to genuinely-never-claimed status, buyable fresh like any other
--    unclaimed tile. One-time, safe to leave in on re-runs (no-op once
--    there are none left). ──
drop function if exists flip_tile(text);
drop function if exists buy_flipped_tile(text, bigint);
delete from tiles where flip_price is not null;

-- ── abandon_tile: 50% refund, matching the client's current rule ──
create or replace function abandon_tile(p_qk text)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  v_tile tiles;
  v_refund bigint;
begin
  if v_uid is null then raise exception 'not authenticated'; end if;

  select * into v_tile from tiles where qk = p_qk and owner = v_uid for update;
  if not found then raise exception 'tile not found or not yours'; end if;

  v_refund := round(v_tile.paid * 0.5);
  delete from tiles where qk = p_qk;
  update profiles set balance = balance + v_refund where user_id = v_uid;
end;
$$;
revoke all on function abandon_tile(text) from public;
grant execute on function abandon_tile(text) to authenticated;

-- ── claim_bank_ledger: surfaces "while you were away, N sales earned ₲X" /
--    "M tiles were repossessed for inactivity, here's a refund" notifications.
--    Money already moved instantly in buy_listed_tile / repossess_stale_tiles
--    above — this only reports + marks rows seen, never credits balance again.
--    Return shape changed (sale_count/repo_count replace a single count), so
--    the old signature must be dropped first — CREATE OR REPLACE can't change
--    a function's return type. ──
drop function if exists claim_bank_ledger();
create or replace function claim_bank_ledger()
returns table("sale_total" bigint, "sale_count" int, "repo_total" bigint, "repo_count" int)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  v_sale_total bigint;
  v_sale_count int;
  v_repo_total bigint;
  v_repo_count int;
begin
  if v_uid is null then raise exception 'not authenticated'; end if;
  -- 'flip' royalty payouts are bucketed into the sale total/count here too
  -- (a flip is, from the flipper's side, functionally a sale — they just
  -- got a cut instead of the full price) so they surface in the same
  -- "while you were away, N sales earned ₲X" notification without a new UI.
  select coalesce(sum(amount) filter (where kind in ('sale', 'flip')), 0),
         coalesce(sum((kind in ('sale', 'flip'))::int), 0),
         coalesce(sum(amount) filter (where kind = 'repossession'), 0),
         coalesce(sum((kind = 'repossession')::int), 0)
  into v_sale_total, v_sale_count, v_repo_total, v_repo_count
  from bank_ledger where recipient = v_uid and claimed = false;

  update bank_ledger set claimed = true where recipient = v_uid and claimed = false;

  return query select v_sale_total, v_sale_count, v_repo_total, v_repo_count;
end;
$$;
revoke all on function claim_bank_ledger() from public;
grant execute on function claim_bank_ledger() to authenticated;

-- ── leaderboard: real joined data, no client-submitted net-worth blob ──
-- ach (added alongside a friend-stats card — see sync_achievements further
-- down) rides on the same no-per-row-privacy-gate trust model as
-- net_worth/tile_count here: nothing in this view is scoped to the
-- caller, so exposing badges the same way isn't a new exposure.
create or replace view leaderboard as
select p.user_id, p.username,
       p.balance + coalesce(sum(t.paid), 0) as net_worth,
       count(t.qk) as tile_count,
       p.peak_net_worth,
       p.ach
from profiles p
left join tiles t on t.owner = p.user_id
group by p.user_id, p.username, p.balance, p.peak_net_worth, p.ach
order by net_worth desc;
grant select on leaderboard to anon, authenticated;

-- ═════════════════════════════════════════════════════════════
-- PvP: attack a tile orthogonally adjacent to your own territory.
-- Adjacency-restricted (you must already own a neighbor of the target),
-- cost scales with the target's value and burns whether you win or lose,
-- and either outcome resets the tile to Vacant ("scorched earth") — a win
-- also transfers ownership to the attacker, a loss leaves the original
-- owner holding the now-blank land. Two daily caps (attacker-launched,
-- tile-received) throttle both a single aggressive player and a dogpile on
-- one victim; a 72h new-account grace period protects brand-new players.
-- Deliberately out of scope for this pass: safe zones, fortify/
-- reinforcement spending, diagonal adjacency, anti-multi-accounting beyond
-- the mandatory-Google-sign-in bar that already exists.
-- ═════════════════════════════════════════════════════════════

alter table profiles add column if not exists attacks_sent_date date not null default (now() at time zone 'utc')::date;
alter table profiles add column if not exists attacks_sent_count int not null default 0;

-- ── dev_mode: per-account testing flag, deliberately NOT settable through
--    any RPC or client action — the only way to grant it is a direct SQL
--    UPDATE by whoever has SQL-editor access to this project, same as
--    backdating a test account's created_at. A global env-var-style
--    toggle would be dangerous here (this is a real shared multiplayer
--    world) — this stays scoped to whichever specific accounts you flag.
--    When true: buy_unowned_tile ignores the energy gate, and attack_tile
--    ignores the 72h new-account grace, the attacker daily cap, and the
--    per-tile received-attack cap — everything else (cost, balance checks,
--    the actual power/roll math) stays real, so the mechanics you're
--    testing still behave like they will for real players. ──
alter table profiles add column if not exists dev_mode boolean not null default false;

-- per-TILE daily received-attack cap, independent of who's attacking
alter table tiles add column if not exists attacks_received_date date not null default (now() at time zone 'utc')::date;
alter table tiles add column if not exists attacks_received_count int not null default 0;

-- ── qk_to_txy / qk_of_txy / qk_neighbors: plpgsql port of txyOf()/qkOf() in
--    PlotTwistWorld.jsx (same bit logic — char '1'/'3' sets the x-bit, '2'/
--    '3' sets the y-bit, iterated MSB-first) — needed so attack_tile can
--    verify adjacency server-side instead of trusting the client's claim. ──
create or replace function qk_to_txy(p_qk text, out tx bigint, out ty bigint)
language plpgsql
immutable
as $$
declare
  ch text;
begin
  tx := 0; ty := 0;
  for i in 1..length(p_qk) loop
    ch := substr(p_qk, i, 1);
    tx := tx * 2 + (case when ch in ('1','3') then 1 else 0 end);
    ty := ty * 2 + (case when ch in ('2','3') then 1 else 0 end);
  end loop;
end;
$$;
revoke all on function qk_to_txy(text) from public;

create or replace function qk_of_txy(p_tx bigint, p_ty bigint, p_z int)
returns text
language plpgsql
immutable
as $$
declare
  q text := '';
  m bigint;
begin
  for i in reverse p_z..1 loop
    m := 1::bigint << (i - 1);
    q := q || ((case when (p_tx & m) <> 0 then 1 else 0 end)
             + (case when (p_ty & m) <> 0 then 2 else 0 end))::text;
  end loop;
  return q;
end;
$$;
revoke all on function qk_of_txy(bigint, bigint, int) from public;

-- up to 4 orthogonal (N/S/E/W) neighbor quadkeys, clamped at the grid edge
-- (tx/ty = 0 or 2^Z-1) rather than wrapping or erroring — edge tiles just
-- have fewer attackable/attacking sides.
create or replace function qk_neighbors(p_qk text)
returns text[]
language plpgsql
immutable
as $$
declare
  v_tx bigint; v_ty bigint;
  v_z int := length(p_qk);
  v_n bigint := 1::bigint << v_z;
  v_out text[] := '{}';
begin
  select tx, ty into v_tx, v_ty from qk_to_txy(p_qk);
  if v_ty > 0       then v_out := v_out || qk_of_txy(v_tx, v_ty - 1, v_z); end if; -- N
  if v_ty < v_n - 1 then v_out := v_out || qk_of_txy(v_tx, v_ty + 1, v_z); end if; -- S
  if v_tx > 0       then v_out := v_out || qk_of_txy(v_tx - 1, v_ty, v_z); end if; -- W
  if v_tx < v_n - 1 then v_out := v_out || qk_of_txy(v_tx + 1, v_ty, v_z); end if; -- E
  return v_out;
end;
$$;
revoke all on function qk_neighbors(text) from public;

-- ── battle_log: "you were attacked / your attack resolved" notification
--    log, mirrors bank_ledger's "while you were away" pattern — but a
--    single battle has TWO interested parties with different framings of
--    the same event, so it gets its own claimed flag per side instead of
--    one shared `claimed` boolean + one `recipient`. ──
create table if not exists battle_log (
  id bigserial primary key,
  attacker uuid not null references auth.users(id) on delete cascade,
  defender uuid not null references auth.users(id) on delete cascade,
  qk text not null,
  att_power numeric not null,
  def_power numeric not null,
  att_roll numeric not null,
  def_roll numeric not null,
  attacker_won boolean not null,
  cost bigint not null,
  created_at timestamptz not null default now(),
  attacker_claimed boolean not null default false,
  defender_claimed boolean not null default false
);
create index if not exists idx_battle_log_attacker on battle_log(attacker) where attacker_claimed = false;
create index if not exists idx_battle_log_defender on battle_log(defender) where defender_claimed = false;

alter table battle_log enable row level security;
drop policy if exists "read own battle_log" on battle_log;
create policy "read own battle_log" on battle_log for select using (auth.uid() = attacker or auth.uid() = defender);
grant select on battle_log to authenticated;

-- ── attack_tile: the main PvP RPC. Cost is charged up front and kept
--    regardless of outcome. Win: tile resets to Vacant AND ownership
--    transfers to the attacker (first-tile-ever bootstrap mirrors
--    buy_unowned_tile's unlocked_regions insert). Lose: "scorched earth" —
--    tile resets to Vacant but the ORIGINAL owner keeps it, blank. ──
create or replace function attack_tile(p_qk text)
returns table(qk text, won boolean, cost bigint, att_power numeric, def_power numeric)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  v_tile tiles;
  v_class tile_class;      -- the TARGET's own district — cost and reset price ride on the defender's tile, not the attacker's
  v_defender profiles;
  v_neighbors text[];
  v_att_power numeric;
  v_def_power numeric;
  v_att_roll numeric;
  v_def_roll numeric;
  v_cost bigint;
  v_won boolean;
  v_today date := (now() at time zone 'utc')::date;
  v_is_first_tile boolean;
  v_region text := left(p_qk, 8);
  v_dev_mode boolean;
  v_landmark_price bigint;
  v_defense_mult numeric;
  v_siege_discount_pct numeric;
  v_atk_cap int;
begin
  if v_uid is null then raise exception 'not authenticated'; end if;
  if not exists (select 1 from profiles where user_id = v_uid) then raise exception 'no profile'; end if;
  perform accrue_rent(v_uid); -- also resets attacks_sent_count/date, see accrue_rent above

  -- dev_mode is the ATTACKER's own flag (see the column comment near its
  -- alter table above) — a flagged tester account can attack past the
  -- age-grace/cooldowns below regardless of who owns the target. Cost,
  -- balance, and the actual power/roll math are never bypassed.
  select dev_mode into v_dev_mode from profiles where user_id = v_uid;

  -- `tiles.` qualification below is load-bearing, not stylistic: this
  -- function's `returns table(qk text, ...)` introduces an implicit
  -- variable named `qk` in scope for the whole function body, which a bare
  -- `qk` column reference in any query here is genuinely ambiguous against
  -- ("column reference qk is ambiguous") — unlike every other function in
  -- this file, which returns `tiles`/`void`/named-non-qk columns and never
  -- hits this.
  select * into v_tile from tiles where tiles.qk = p_qk for update;
  if not found then raise exception 'tile not found'; end if;
  if v_tile.owner is null then raise exception 'that tile is unowned — claim it instead of attacking it'; end if;
  if v_tile.owner = v_uid then raise exception 'you already own this tile'; end if;

  -- landmark lookup, once, reused below for the grace check, the defense
  -- multiplier, and the base attack-cost premium. v_landmark_price stays
  -- null for an ordinary tile — every landmark branch below is gated on
  -- "is this not null", never a separate existence query.
  select lt.claim_price, l.defense_mult
    into v_landmark_price, v_defense_mult
  from landmark_tiles lt join landmarks l on l.id = lt.landmark_id
  where lt.qk = p_qk;

  -- 48h post-ownership-change grace, landmark tiles only: at a
  -- ₲1,000,000+ claim price, "bought it, lost it to a snipe the next day"
  -- is a real bad-feeling failure mode worth designing against directly
  -- (see LANDMARKS-PLAN.md) — unlike OSRS's Wilderness, owning a landmark
  -- tile isn't opt-in, so this grace is the substitute for "choosing not
  -- to bring your risky item into danger". Applies equally whether
  -- owner_since was set by an original claim or by a previous capture
  -- (see the win branch below) — `null > ...` is falsy, so a tile that
  -- somehow has no owner_since simply isn't gated by this.
  if v_landmark_price is not null and not v_dev_mode and v_tile.owner_since > now() - interval '48 hours' then
    raise exception 'this landmark tile changed hands recently — protected for 48 hours';
  end if;

  -- lazily complete a finished-but-not-yet-processed build on the TARGET
  -- before computing defense power — otherwise a defender whose Tower
  -- finished construction hours ago but hasn't logged in since (so their
  -- own finish_builds never ran) would defend at their pre-completion
  -- level. Mirrors finish_builds' own logic inline since this is a single
  -- already-locked row, not a per-player sweep. Persisted below in both
  -- the win and loss branches so the completion isn't silently discarded.
  if v_tile.build_until is not null and v_tile.build_until <= now() then
    v_tile.level := v_tile.level + 1;
    v_tile.build_until := null;
  end if;

  select * into v_defender from profiles where user_id = v_tile.owner;
  if not found then raise exception 'target has no profile'; end if;
  if not v_dev_mode and v_defender.created_at > now() - interval '72 hours' then
    raise exception 'that player is too new to attack — protected for 72 hours';
  end if;

  -- per-tile daily received-attack cap, same compute-on-read reset idiom as
  -- everything else here, done inline since this row is already locked and
  -- no other function ever touches this counter
  if v_tile.attacks_received_date < v_today then
    v_tile.attacks_received_count := 0;
  end if;
  if not v_dev_mode and v_tile.attacks_received_count >= 2 then
    raise exception 'this tile has already been attacked twice today — try again tomorrow';
  end if;

  -- daily attack cap now scales with status, same lookup pattern as
  -- reset_daily_energy's daily_energy_cap — mirrors statusFor(...).atk in
  -- PlotTwistWorld.jsx.
  select st.daily_atk_cap into v_atk_cap
  from status_tier st
  where st.min_net_worth <= (select peak_net_worth from profiles where user_id = v_uid)
  order by st.min_net_worth desc
  limit 1;

  if not v_dev_mode and (select attacks_sent_count from profiles where user_id = v_uid) >= v_atk_cap then
    raise exception 'no attacks left today — resets tomorrow';
  end if;

  v_neighbors := qk_neighbors(p_qk);
  v_att_power := (select count(*) from tiles where owner = v_uid and tiles.qk = any(v_neighbors));
  if v_att_power < 1 then
    raise exception 'you need to own an adjacent tile to attack this one';
  end if;

  select * into v_class from tile_class where cls = v_tile.cls;

  -- siege_discount: attacker's own landmark tiles in the TARGET's region
  -- discount the BASE cost formula only (before the wealth floor below),
  -- same region-scoped live-sum pattern as build_speed/rush_discount —
  -- see upgrade_tile/rush_build. Capped per-landmark at perk_pct_cap (30).
  select least(coalesce(sum(l.perk_value_per_tile), 0), coalesce(max(l.perk_pct_cap), 30))
    into v_siege_discount_pct
  from tiles t2
  join landmark_tiles lt2 on lt2.qk = t2.qk
  join landmarks l on l.id = lt2.landmark_id
  where t2.owner = v_uid and l.perk_type = 'siege_discount' and left(t2.qk, 8) = v_region;

  -- wealth-indexed floor: attacking DOWN (a wealthy player raiding modest
  -- land) costs at least 0.2% of the attacker's own peak net worth, so a
  -- ₲5M player pays ≥₲10k per attack instead of the base formula's trivial
  -- ₲25-1,200. Attacking UP stays cheap — a newcomer's floor is pennies,
  -- so the base formula still governs for them. greatest() means whichever
  -- number is actually bigger wins, never both charged — siege_discount
  -- only reduces the base, so a wealthy attacker can never perk their way
  -- under the wealth floor; the discount only helps players who aren't
  -- already hitting it. A landmark TARGET uses its own steep claim price
  -- as the base instead of the district price — sieging a landmark costs
  -- real money up front, not just defending one.
  v_cost := greatest(
    round(coalesce(v_landmark_price, v_class.price) * 0.5 * (1 + 0.5 * v_tile.level) * (1 - coalesce(v_siege_discount_pct, 0) / 100)),
    round((select peak_net_worth from profiles where user_id = v_uid) * 0.002)
  );
  if (select balance from profiles where user_id = v_uid) < v_cost then
    raise exception 'insufficient balance';
  end if;

  -- prestige now counts toward defense (same multiplier shape as its rent
  -- bonus) — safe to include ONLY because the probability floor below
  -- guarantees no amount of investment ever reaches a true 100% defense.
  -- Before this floor existed, attacker power was hard-capped at 4 (max
  -- possible orthogonal neighbors) while defender power was unbounded —
  -- a maxed legendary Tower (defPower 40) was already very close to
  -- unconquerable by the old roll-and-compare method, and adding prestige
  -- on top of THAT would have made it mathematically certain.
  v_def_power := (1 + v_tile.level) * (case v_tile.rarity when 0 then 1 when 1 then 1.5 when 2 then 3 when 3 then 8 else 1 end) * (1 + 0.25 * v_tile.prestige);
  -- "fortress of status" — any landmark tile defends harder on top of the
  -- normal level/rarity/prestige formula, still bounded by the same
  -- probability floor so it's never truly unconquerable.
  if v_defense_mult is not null then
    v_def_power := v_def_power * v_defense_mult;
  end if;

  -- win probability = power ratio, clamped so neither side is ever a sure
  -- thing: a fully-encircled attack on a hopeless target caps at 90%, and
  -- a lone probe against a maxed-out fortress never drops below 5% — the
  -- floor is what makes prestige-in-defense safe (see above) and is also
  -- what keeps conquest a real, standing threat against even the most
  -- developed tiles, which is the actual point of a PvP system. Replaces
  -- the old "roll each side ±15%, higher wins" method, which let whichever
  -- side had the larger raw power ceiling win almost every time — the
  -- jitter was nowhere near enough to bridge a 10x+ gap. att_roll/def_roll
  -- (battle_log columns, kept for schema stability) now store the
  -- probability split rather than literal rolled values.
  v_att_roll := greatest(0.05, least(0.90, v_att_power / (v_att_power + v_def_power)));
  v_def_roll := 1 - v_att_roll;
  v_won := random() < v_att_roll;

  v_is_first_tile := v_won and not exists (select 1 from tiles where owner = v_uid);

  -- cost is spent regardless of outcome
  update profiles
    set balance = balance - v_cost,
        attacks_sent_count = attacks_sent_count + 1,
        attacks_sent_date = v_today
    where user_id = v_uid;

  -- only a CAPTURE resets the tile — level/rarity/prestige wiped, any
  -- listing cleared, paid reset to the district's base price (mirrors
  -- flip_tile's "tear it down" reset), ownership transferred, and any
  -- build in progress is scrapped (build_until = null; a freshly-captured
  -- Vacant tile has nothing under construction). A successful DEFENSE
  -- leaves the tile completely untouched except for persisting the lazy
  -- build-completion from above (if the timer had already passed) — the
  -- defender's build is what won the fight, so it has to survive the
  -- fight, or defending would never be worth more than losing outright.
  -- Either outcome still bumps the per-tile daily received-attack counter.
  if v_won then
    update tiles
      set level = 0, rarity = 0, prestige = 0, paid = coalesce(v_landmark_price, v_class.price),
          list_price = null, flip_price = null, flip_royalty_to = null,
          build_until = null,
          owner = v_uid, owner_since = now(),
          attacks_received_count = v_tile.attacks_received_count + 1,
          attacks_received_date = v_today,
          updated_at = now()
      where tiles.qk = p_qk;
    -- see the "Tile nicknames" section below: a captured tile's private
    -- nickname doesn't carry over to whoever just took it
    delete from tile_nicknames where tile_nicknames.qk = p_qk;
  else
    update tiles
      set level = v_tile.level, build_until = v_tile.build_until,
          attacks_received_count = v_tile.attacks_received_count + 1,
          attacks_received_date = v_today
      where tiles.qk = p_qk;
  end if;

  if v_is_first_tile then
    insert into unlocked_regions (owner, region, is_home)
    values (v_uid, v_region, true)
    on conflict (owner, region) do nothing;
  end if;

  insert into battle_log (attacker, defender, qk, att_power, def_power, att_roll, def_roll, attacker_won, cost)
  values (v_uid, v_tile.owner, p_qk, v_att_power, v_def_power, v_att_roll, v_def_roll, v_won, v_cost);

  return query select p_qk, v_won, v_cost, v_att_power, v_def_power;
end;
$$;
revoke all on function attack_tile(text) from public;
grant execute on function attack_tile(text) to authenticated;

-- ── claim_battle_log: surfaces "N of your attacks resolved (W/L, ₲ spent)"
--    and "your territory was raided N times" notifications, same lazy
--    claim-and-mark-seen shape as claim_bank_ledger — money/ownership
--    already moved instantly in attack_tile above, this only reports +
--    marks rows seen. Two independent claimed flags because one battle_log
--    row has two viewers with different framings of the same event. ──
create or replace function claim_battle_log()
returns table("sent_win_count" int, "sent_loss_count" int, "sent_cost_total" bigint, "received_count" int, "received_lost_count" int)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  v_sent_win int; v_sent_loss int; v_sent_cost bigint;
  v_recv_count int; v_recv_lost int;
begin
  if v_uid is null then raise exception 'not authenticated'; end if;

  select coalesce(sum((attacker_won)::int), 0), coalesce(sum((not attacker_won)::int), 0), coalesce(sum(cost), 0)
  into v_sent_win, v_sent_loss, v_sent_cost
  from battle_log where attacker = v_uid and attacker_claimed = false;

  select count(*), coalesce(sum((attacker_won)::int), 0)
  into v_recv_count, v_recv_lost
  from battle_log where defender = v_uid and defender_claimed = false;

  update battle_log set attacker_claimed = true where attacker = v_uid and attacker_claimed = false;
  update battle_log set defender_claimed = true where defender = v_uid and defender_claimed = false;

  return query select v_sent_win, v_sent_loss, v_sent_cost, v_recv_count, v_recv_lost;
end;
$$;
revoke all on function claim_battle_log() from public;
grant execute on function claim_battle_log() to authenticated;

-- ═════════════════════════════════════════════════════════════
-- Pacing: build timers. Upgrading a tile no longer completes instantly —
-- it starts a timer (build_until) and the level increments lazily once
-- that passes, same compute-on-read idiom as everything else in this
-- file (energy, daily attack counters). This is the actual fix for
-- "wealthy players reach the point where every price is trivial" — time
-- binds every wealth level equally, where a flat ₲ cost eventually
-- doesn't. Builder slots (status_tier.builder_slots above) cap how many
-- tiles can be building at once, scaling with status tier, so a player
-- can't just queue their whole portfolio and let it all finish overnight.
-- Rushing (rush_build below) is the money sink this creates — pay to
-- finish instantly, priced proportional to how much time is actually
-- left. dev_mode accounts skip both the timer and the slot cap entirely
-- (see the dev_mode column comment near the PvP section above).
-- ═════════════════════════════════════════════════════════════

alter table tiles add column if not exists build_until timestamptz;

-- ── finish_builds: lazily completes any of this player's tiles whose
--    timer has passed. Called from accrue_rent (after the rent credit)
--    so it rides every RPC round-trip already touching this player, same
--    as reset_daily_energy/reset_daily_attacks_sent. Deliberately does
--    NOT retroactively credit the rent gap between actual completion and
--    whenever this runs — a slightly-late rent bump is fine and exploit-
--    safe; back-crediting exact completion timestamps would not be. ──
create or replace function finish_builds(p_uid uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  update tiles
    set level = level + 1, build_until = null
    where owner = p_uid and build_until is not null and build_until <= now();
end;
$$;
revoke all on function finish_builds(uuid) from public;

-- ═════════════════════════════════════════════════════════════
-- Landmarks: real-world trophy tile clusters. A landmark is a 3x3 block
-- of ordinary `tiles` rows, tagged via landmark_tiles — NOT a parallel
-- ownership structure. Every existing acquisition path (claim, attack,
-- decay, listing) already works on a landmark tile unchanged; this
-- section only adds a price premium, a defense bonus, a perk
-- contribution, and a post-ownership-change grace period, layered on
-- top of functions that already exist. Perks buy tempo/convenience only
-- — never raw income (see each perk's touch-point below) — a win-more
-- engine compounds existing advantage instead of creating a real
-- decision. See LANDMARKS-PLAN.md for the full design discussion.
-- ═════════════════════════════════════════════════════════════

-- perk_value_per_tile's UNIT depends on perk_type: a percentage point
-- for build_speed/rush_discount/siege_discount, a flat integer amount
-- for energy_boost. perk_pct_cap only constrains the percentage-style
-- perks — see reset_daily_energy below for why energy_boost doesn't
-- need it (its own scarcity already bounds it).
create table if not exists landmarks (
  id serial primary key,
  name text not null,
  emoji text not null default '🏛️',
  perk_type text not null default 'build_speed',
  perk_value_per_tile numeric not null default 2,
  perk_pct_cap numeric not null default 30,
  defense_mult numeric not null default 1.5
);

-- membership: which quadkeys belong to which landmark, and what an
-- unowned piece costs to claim (overrides tile_class.price for these qks)
create table if not exists landmark_tiles (
  qk text primary key,
  landmark_id int not null references landmarks(id) on delete cascade,
  claim_price bigint not null default 1000000
);
create index if not exists idx_landmark_tiles_landmark on landmark_tiles(landmark_id);

alter table landmarks enable row level security;
drop policy if exists "read landmarks" on landmarks;
create policy "read landmarks" on landmarks for select using (true);
grant select on landmarks to anon, authenticated;

alter table landmark_tiles enable row level security;
drop policy if exists "read landmark_tiles" on landmark_tiles;
create policy "read landmark_tiles" on landmark_tiles for select using (true);
grant select on landmark_tiles to anon, authenticated;

-- ── owner_since: when the CURRENT owner most recently became the owner —
--    set only by ownership-establishing/transferring writes (claim, trade,
--    capture), left untouched by everything else (upgrade, list,
--    redevelop, a defended attack). Generic on `tiles` (not landmark-
--    specific) since "since when has the current owner owned this" is a
--    sensible concept for any tile, but the only reader right now is
--    attack_tile's 48h landmark grace-period check below — existing rows
--    staying null is fine, it's only meaningful for landmark tiles, which
--    didn't exist before this migration. ──
alter table tiles add column if not exists owner_since timestamptz;

-- ── seed: 24 landmarks worldwide, 9 tiles each (216 total), computed
--    offline from real lat/lon via the client's own qkOf/lonToWx/latToWy
--    math (Z=17) — see LANDMARKS-PLAN.md for the source coordinate list
--    and the build script. Explicit ids so landmark_tiles can reference
--    them directly without a round-trip; setval afterward keeps future
--    serial-generated ids from colliding if more landmarks are added by
--    hand later. ──
insert into landmarks (id, name, emoji, perk_type) values
  (1, 'Eiffel Tower', '🗼', 'build_speed'),
  (2, 'Sagrada Familia', '⛪', 'build_speed'),
  (3, 'Neuschwanstein Castle', '🏰', 'build_speed'),
  (4, 'Tokyo Tower', '🗼', 'build_speed'),
  (5, 'CN Tower', '🗼', 'build_speed'),
  (6, 'Space Needle', '🚀', 'build_speed'),
  (7, 'Great Wall of China', '🧱', 'siege_discount'),
  (8, 'Colosseum', '🏛️', 'siege_discount'),
  (9, 'Kremlin', '⭐', 'siege_discount'),
  (10, 'Petra', '🏜️', 'siege_discount'),
  (11, 'Machu Picchu', '⛰️', 'siege_discount'),
  (12, 'Angkor Wat', '🕌', 'siege_discount'),
  (13, 'Statue of Liberty', '🗽', 'energy_boost'),
  (14, 'Golden Gate Bridge', '🌉', 'energy_boost'),
  (15, 'Burj Khalifa', '🏙️', 'energy_boost'),
  (16, 'Mount Rushmore', '🗿', 'energy_boost'),
  (17, 'Table Mountain', '⛰️', 'energy_boost'),
  (18, 'Acropolis of Athens', '🏛️', 'energy_boost'),
  (19, 'Big Ben', '🕰️', 'rush_discount'),
  (20, 'Taj Mahal', '🕌', 'rush_discount'),
  (21, 'Great Pyramid of Giza', '🔺', 'rush_discount'),
  (22, 'Sydney Opera House', '🎭', 'rush_discount'),
  (23, 'Christ the Redeemer', '✝️', 'rush_discount'),
  (24, 'Leaning Tower of Pisa', '🗼', 'rush_discount')
on conflict (id) do update set name = excluded.name, emoji = excluded.emoji, perk_type = excluded.perk_type;
select setval(pg_get_serial_sequence('landmarks','id'), (select max(id) from landmarks));

insert into landmark_tiles (qk, landmark_id) values
  ('12022001101200030', 1),
  ('12022001101200031', 1),
  ('12022001101200120', 1),
  ('12022001101200032', 1),
  ('12022001101200033', 1),
  ('12022001101200122', 1),
  ('12022001101200210', 1),
  ('12022001101200211', 1),
  ('12022001101200300', 1),
  ('12022223300230112', 2),
  ('12022223300230113', 2),
  ('12022223300231002', 2),
  ('12022223300230130', 2),
  ('12022223300230131', 2),
  ('12022223300231020', 2),
  ('12022223300230132', 2),
  ('12022223300230133', 2),
  ('12022223300231022', 2),
  ('12022113123203002', 3),
  ('12022113123203003', 3),
  ('12022113123203012', 3),
  ('12022113123203020', 3),
  ('12022113123203021', 3),
  ('12022113123203030', 3),
  ('12022113123203022', 3),
  ('12022113123203023', 3),
  ('12022113123203032', 3),
  ('13300211230311330', 4),
  ('13300211230311331', 4),
  ('13300211231200220', 4),
  ('13300211230311332', 4),
  ('13300211230311333', 4),
  ('13300211231200222', 4),
  ('13300211230313110', 4),
  ('13300211230313111', 4),
  ('13300211231202000', 4),
  ('03022313122032333', 5),
  ('03022313122033222', 5),
  ('03022313122033223', 5),
  ('03022313122210111', 5),
  ('03022313122211000', 5),
  ('03022313122211001', 5),
  ('03022313122210113', 5),
  ('03022313122211002', 5),
  ('03022313122211003', 5),
  ('02123002133111322', 6),
  ('02123002133111323', 6),
  ('02123002133111332', 6),
  ('02123002133113100', 6),
  ('02123002133113101', 6),
  ('02123002133113110', 6),
  ('02123002133113102', 6),
  ('02123002133113103', 6),
  ('02123002133113112', 6),
  ('13210010311001220', 7),
  ('13210010311001221', 7),
  ('13210010311001230', 7),
  ('13210010311001222', 7),
  ('13210010311001223', 7),
  ('13210010311001232', 7),
  ('13210010311003000', 7),
  ('13210010311003001', 7),
  ('13210010311003010', 7),
  ('12023222113000211', 8),
  ('12023222113000300', 8),
  ('12023222113000301', 8),
  ('12023222113000213', 8),
  ('12023222113000302', 8),
  ('12023222113000303', 8),
  ('12023222113000231', 8),
  ('12023222113000320', 8),
  ('12023222113000321', 8),
  ('12031010110002202', 9),
  ('12031010110002203', 9),
  ('12031010110002212', 9),
  ('12031010110002220', 9),
  ('12031010110002221', 9),
  ('12031010110002230', 9),
  ('12031010110002222', 9),
  ('12031010110002223', 9),
  ('12031010110002232', 9),
  ('12213003021320113', 10),
  ('12213003021321002', 10),
  ('12213003021321003', 10),
  ('12213003021320131', 10),
  ('12213003021321020', 10),
  ('12213003021321021', 10),
  ('12213003021320133', 10),
  ('12213003021321022', 10),
  ('12213003021321023', 10),
  ('21003102033210030', 11),
  ('21003102033210031', 11),
  ('21003102033210120', 11),
  ('21003102033210032', 11),
  ('21003102033210033', 11),
  ('21003102033210122', 11),
  ('21003102033210210', 11),
  ('21003102033210211', 11),
  ('21003102033210300', 11),
  ('13221221130332331', 12),
  ('13221221130333220', 12),
  ('13221221130333221', 12),
  ('13221221130332333', 12),
  ('13221221130333222', 12),
  ('13221221130333223', 12),
  ('13221221132110111', 12),
  ('13221221132111000', 12),
  ('13221221132111001', 12),
  ('03201011030112020', 13),
  ('03201011030112021', 13),
  ('03201011030112030', 13),
  ('03201011030112022', 13),
  ('03201011030112023', 13),
  ('03201011030112032', 13),
  ('03201011030112200', 13),
  ('03201011030112201', 13),
  ('03201011030112210', 13),
  ('02301020333021110', 14),
  ('02301020333021111', 14),
  ('02301020333030000', 14),
  ('02301020333021112', 14),
  ('02301020333021113', 14),
  ('02301020333030002', 14),
  ('02301020333021130', 14),
  ('02301020333021131', 14),
  ('02301020333030020', 14),
  ('12302313032231031', 15),
  ('12302313032231120', 15),
  ('12302313032231121', 15),
  ('12302313032231033', 15),
  ('12302313032231122', 15),
  ('12302313032231123', 15),
  ('12302313032231211', 15),
  ('12302313032231300', 15),
  ('12302313032231301', 15),
  ('02132312013213010', 16),
  ('02132312013213011', 16),
  ('02132312013213100', 16),
  ('02132312013213012', 16),
  ('02132312013213013', 16),
  ('02132312013213102', 16),
  ('02132312013213030', 16),
  ('02132312013213031', 16),
  ('02132312013213120', 16),
  ('30023103202301323', 17),
  ('30023103202301332', 17),
  ('30023103202301333', 17),
  ('30023103202303101', 17),
  ('30023103202303110', 17),
  ('30023103202303111', 17),
  ('30023103202303103', 17),
  ('30023103202303112', 17),
  ('30023103202303113', 17),
  ('12210020330113121', 18),
  ('12210020330113130', 18),
  ('12210020330113131', 18),
  ('12210020330113123', 18),
  ('12210020330113132', 18),
  ('12210020330113133', 18),
  ('12210020330113301', 18),
  ('12210020330113310', 18),
  ('12210020330113311', 18),
  ('03131313113010023', 19),
  ('03131313113010032', 19),
  ('03131313113010033', 19),
  ('03131313113010201', 19),
  ('03131313113010210', 19),
  ('03131313113010211', 19),
  ('03131313113010203', 19),
  ('03131313113010212', 19),
  ('03131313113010213', 19),
  ('12312133233113323', 20),
  ('12312133233113332', 20),
  ('12312133233113333', 20),
  ('12312133233131101', 20),
  ('12312133233131110', 20),
  ('12312133233131111', 20),
  ('12312133233131103', 20),
  ('12312133233131112', 20),
  ('12312133233131113', 20),
  ('12212112203000310', 21),
  ('12212112203000311', 21),
  ('12212112203001200', 21),
  ('12212112203000312', 21),
  ('12212112203000313', 21),
  ('12212112203001202', 21),
  ('12212112203000330', 21),
  ('12212112203000331', 21),
  ('12212112203001220', 21),
  ('31123013300223112', 22),
  ('31123013300223113', 22),
  ('31123013300232002', 22),
  ('31123013300223130', 22),
  ('31123013300223131', 22),
  ('31123013300232020', 22),
  ('31123013300223132', 22),
  ('31123013300223133', 22),
  ('31123013300232022', 22),
  ('21120001230003210', 23),
  ('21120001230003211', 23),
  ('21120001230003300', 23),
  ('21120001230003212', 23),
  ('21120001230003213', 23),
  ('21120001230003302', 23),
  ('21120001230003230', 23),
  ('21120001230003231', 23),
  ('21120001230003320', 23),
  ('12022313031221222', 24),
  ('12022313031221223', 24),
  ('12022313031221232', 24),
  ('12022313031223000', 24),
  ('12022313031223001', 24),
  ('12022313031223010', 24),
  ('12022313031223002', 24),
  ('12022313031223003', 24),
  ('12022313031223012', 24)
on conflict (qk) do update set landmark_id = excluded.landmark_id;

-- one-time normalization: any landmark tile already claimed before this
-- migration (real geo cls, possibly a rolled rarity) gets fixed up to
-- match the rules now — 'landmark' cls, rarity reset to Common. Safe to
-- re-run; a no-op once every landmark tile already matches.
update tiles set cls = 'landmark', rarity = 0
where qk in (select qk from landmark_tiles) and (cls <> 'landmark' or rarity <> 0);

-- ══════════════════════════════════════════════════════════════════
-- Friends (social phase 1 — see phases 2/3 notes at the bottom)
-- ══════════════════════════════════════════════════════════════════
-- One row per player pair, canonical ordering (user_a < user_b as uuid)
-- so "are we friends" is a single primary-key lookup with no OR. Unlike
-- the public-read game tables above, this is PRIVATE user data: RLS
-- restricts reads to the two people in the row, and a blocked row is
-- invisible to the blocked party (never confirm a block to its target).
-- All writes go through the RPCs below — no direct table writes at all.
create table if not exists friendships (
  user_a uuid not null references profiles(user_id) on delete cascade,
  user_b uuid not null references profiles(user_id) on delete cascade,
  requested_by uuid not null,
  status text not null check (status in ('pending','accepted','blocked')),
  blocked_by uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (user_a, user_b),
  check (user_a < user_b)
);
create index if not exists idx_friendships_b on friendships(user_b);

alter table friendships enable row level security;
drop policy if exists "read own friendships" on friendships;
create policy "read own friendships" on friendships for select using (
  auth.uid() in (user_a, user_b) and (status <> 'blocked' or blocked_by = auth.uid())
);
grant select on friendships to authenticated;

-- ── send_friend_request: by username (the only public identity surface).
--    Rate-limited server-side. If the target has blocked the sender, this
--    silently reports success WITHOUT creating anything — erroring here
--    would let anyone probe who has blocked them. ──
create or replace function send_friend_request(p_username text)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  v_target uuid;
  v_a uuid; v_b uuid;
  v_row friendships;
begin
  if v_uid is null then raise exception 'not authenticated'; end if;

  select user_id into v_target from profiles where lower(username) = lower(trim(p_username));
  if v_target is null then raise exception 'no player by that name'; end if;
  if v_target = v_uid then raise exception 'that is you'; end if;

  if (select count(*) from friendships
      where requested_by = v_uid and status = 'pending'
        and created_at > now() - interval '1 day') >= 20 then
    raise exception 'too many pending requests today — try again tomorrow';
  end if;

  v_a := least(v_uid, v_target); v_b := greatest(v_uid, v_target);
  select * into v_row from friendships where user_a = v_a and user_b = v_b;
  if found then
    if v_row.status = 'blocked' then return; end if; -- silent: never reveal a block
    if v_row.status = 'accepted' then raise exception 'already friends'; end if;
    -- pending: if THEY asked first, sending "a request back" just accepts
    if v_row.requested_by <> v_uid then
      update friendships set status = 'accepted', updated_at = now()
        where user_a = v_a and user_b = v_b;
      return;
    end if;
    raise exception 'request already sent';
  end if;

  insert into friendships (user_a, user_b, requested_by, status)
  values (v_a, v_b, v_uid, 'pending');
end;
$$;
revoke all on function send_friend_request(text) from public;
grant execute on function send_friend_request(text) to authenticated;

-- ── accept_friend_request: only the addressee (not the requester) ──
create or replace function accept_friend_request(p_user uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  v_a uuid; v_b uuid;
begin
  if v_uid is null then raise exception 'not authenticated'; end if;
  v_a := least(v_uid, p_user); v_b := greatest(v_uid, p_user);
  update friendships set status = 'accepted', updated_at = now()
    where user_a = v_a and user_b = v_b and status = 'pending' and requested_by <> v_uid;
  if not found then raise exception 'no pending request from that player'; end if;
end;
$$;
revoke all on function accept_friend_request(uuid) from public;
grant execute on function accept_friend_request(uuid) to authenticated;

-- ── remove_friend: one verb for decline (addressee), cancel (requester),
--    and unfriend (either side of an accepted pair). Never touches a
--    blocked row — that's unblock_player's job, and only for the blocker. ──
create or replace function remove_friend(p_user uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  v_a uuid; v_b uuid;
begin
  if v_uid is null then raise exception 'not authenticated'; end if;
  v_a := least(v_uid, p_user); v_b := greatest(v_uid, p_user);
  delete from friendships
    where user_a = v_a and user_b = v_b and status in ('pending','accepted');
end;
$$;
revoke all on function remove_friend(uuid) from public;
grant execute on function remove_friend(uuid) to authenticated;

-- ── block_player: upserts the pair row to blocked, from any prior state
--    (stranger, pending either direction, or accepted). Enforced server-
--    side: send_friend_request checks it (silently), and phases 2/3
--    (DMs/chat) must check it too. ──
create or replace function block_player(p_user uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  v_a uuid; v_b uuid;
begin
  if v_uid is null then raise exception 'not authenticated'; end if;
  if p_user = v_uid then raise exception 'that is you'; end if;
  if not exists (select 1 from profiles where user_id = p_user) then
    raise exception 'no such player';
  end if;
  v_a := least(v_uid, p_user); v_b := greatest(v_uid, p_user);
  insert into friendships (user_a, user_b, requested_by, status, blocked_by)
  values (v_a, v_b, v_uid, 'blocked', v_uid)
  on conflict (user_a, user_b)
  do update set status = 'blocked', blocked_by = excluded.blocked_by, updated_at = now();
end;
$$;
revoke all on function block_player(uuid) from public;
grant execute on function block_player(uuid) to authenticated;

-- ── unblock_player: only the blocker can lift a block; the row is simply
--    removed (relationship resets to strangers, not to friends) ──
create or replace function unblock_player(p_user uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  v_a uuid; v_b uuid;
begin
  if v_uid is null then raise exception 'not authenticated'; end if;
  v_a := least(v_uid, p_user); v_b := greatest(v_uid, p_user);
  delete from friendships
    where user_a = v_a and user_b = v_b and status = 'blocked' and blocked_by = v_uid;
end;
$$;
revoke all on function unblock_player(uuid) from public;
grant execute on function unblock_player(uuid) to authenticated;

-- ── list_friendships: everything the client's social UI needs in one
--    call — avoids PostgREST FK-qualification pain (friendships has TWO
--    FKs into profiles, the same trap tiles fell into with flip_royalty_to,
--    see that comment above). direction is only meaningful for pending
--    rows; home_region powers "visit their turf". Blocked rows only ever
--    surface to the blocker (matching the RLS policy). Every column
--    reference is table-qualified — plpgsql resolves bare names against
--    the RETURNS TABLE output columns first, the same "ambiguous qk"
--    gotcha attack_tile hit. ──
create or replace function list_friendships()
returns table(other_user uuid, username text, status text, direction text, home_region text)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
begin
  if v_uid is null then raise exception 'not authenticated'; end if;
  return query
  select
    (case when f.user_a = v_uid then f.user_b else f.user_a end),
    p.username,
    f.status,
    (case when f.status <> 'pending' then null
          when f.requested_by = v_uid then 'outgoing'
          else 'incoming' end),
    (select ur.region from unlocked_regions ur
      where ur.owner = (case when f.user_a = v_uid then f.user_b else f.user_a end)
        and ur.is_home
      limit 1)
  from friendships f
  join profiles p on p.user_id = (case when f.user_a = v_uid then f.user_b else f.user_a end)
  where (f.user_a = v_uid or f.user_b = v_uid)
    and (f.status <> 'blocked' or f.blocked_by = v_uid);
end;
$$;
revoke all on function list_friendships() from public;
grant execute on function list_friendships() to authenticated;

-- ══════════════════════════════════════════════════════════════════
-- Direct messages (social phase 2) — friends-only
-- ══════════════════════════════════════════════════════════════════
-- PRIVATE user content, like friendships above: RLS restricts reads to
-- the two people in a message, writes happen only through send_message.
-- Friends-only is the abuse-surface decision, not an implementation
-- shortcut: requiring an accepted friendship before any message can
-- exist eliminates stranger spam/harassment structurally, so this needs
-- no separate block check — a blocked pair is by definition no longer
-- 'accepted'. Delivery is client polling for now; if this ever moves to
-- Supabase Realtime, RLS already covers postgres_changes, so it's an
-- additive publication change, not a schema one.
create table if not exists messages (
  id bigserial primary key,
  sender uuid not null references profiles(user_id) on delete cascade,
  recipient uuid not null references profiles(user_id) on delete cascade,
  body text not null check (char_length(body) between 1 and 500),
  created_at timestamptz not null default now(),
  read_at timestamptz
);
create index if not exists idx_messages_recipient_unread on messages(recipient) where read_at is null;
create index if not exists idx_messages_pair on messages(sender, recipient, id desc);

alter table messages enable row level security;
drop policy if exists "read own messages" on messages;
create policy "read own messages" on messages for select using (auth.uid() in (sender, recipient));
grant select on messages to authenticated;

-- ── send_message: friends-only, rate-limited, self-pruning ──
create or replace function send_message(p_to uuid, p_body text)
returns messages
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  v_body text := trim(p_body);
  v_a uuid; v_b uuid;
  v_row messages;
begin
  if v_uid is null then raise exception 'not authenticated'; end if;
  if v_body is null or char_length(v_body) < 1 then raise exception 'empty message'; end if;
  if char_length(v_body) > 500 then raise exception 'message too long (500 characters max)'; end if;
  if p_to = v_uid then raise exception 'that is you'; end if;

  v_a := least(v_uid, p_to); v_b := greatest(v_uid, p_to);
  if not exists (select 1 from friendships
      where user_a = v_a and user_b = v_b and status = 'accepted') then
    -- same message whether they're a stranger, pending, or blocked —
    -- never a distinct "blocked" answer (see send_friend_request)
    raise exception 'you can only message friends';
  end if;

  if (select count(*) from messages
      where sender = v_uid and created_at > now() - interval '1 minute') >= 20 then
    raise exception 'sending too fast — give it a moment';
  end if;

  insert into messages (sender, recipient, body)
  values (v_uid, p_to, v_body)
  returning * into v_row;

  -- lazy retention, same philosophy as repossess_stale_tiles: no cron,
  -- the write path itself keeps the table bounded. Only the latest 200
  -- messages per pair survive — a DM history, not an archive.
  delete from messages m
  where ((m.sender = v_uid and m.recipient = p_to) or (m.sender = p_to and m.recipient = v_uid))
    and m.id not in (
      select m2.id from messages m2
      where (m2.sender = v_uid and m2.recipient = p_to) or (m2.sender = p_to and m2.recipient = v_uid)
      order by m2.id desc
      limit 200
    );

  return v_row;
end;
$$;
revoke all on function send_message(uuid, text) from public;
grant execute on function send_message(uuid, text) to authenticated;

-- ── mark_messages_read: one conversation at a time (recipient only) ──
create or replace function mark_messages_read(p_from uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
begin
  if v_uid is null then raise exception 'not authenticated'; end if;
  update messages set read_at = now()
    where recipient = v_uid and sender = p_from and read_at is null;
end;
$$;
revoke all on function mark_messages_read(uuid) from public;
grant execute on function mark_messages_read(uuid) to authenticated;

-- ══════════════════════════════════════════════════════════════════
-- Region chat (social phase 3) + reports
-- ══════════════════════════════════════════════════════════════════
-- Local chat scoped to a REGION_LEN=8 quadkey region — you talk to the
-- people whose territory you share. Unlike DMs, this is semi-public
-- content, so it ships WITH the abuse tooling: reports, block-pair
-- filtering, tight rate limits, small retention window.
--
-- RLS is deny-all (no select policy at all): every read goes through
-- list_region_messages below, which is the single enforcement point for
-- BOTH the territory gate (only regions you've unlocked) and block
-- filtering. A permissive select policy here would let a direct
-- PostgREST query bypass the block filter.
create table if not exists region_messages (
  id bigserial primary key,
  region text not null,
  sender uuid not null references profiles(user_id) on delete cascade,
  body text not null check (char_length(body) between 1 and 300),
  created_at timestamptz not null default now()
);
create index if not exists idx_region_messages_region on region_messages(region, id desc);
alter table region_messages enable row level security;

-- ── send_region_message: territory-gated, rate-limited, self-pruning ──
create or replace function send_region_message(p_region text, p_body text)
returns region_messages
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  v_body text := trim(p_body);
  v_row region_messages;
begin
  if v_uid is null then raise exception 'not authenticated'; end if;
  if v_body is null or char_length(v_body) < 1 then raise exception 'empty message'; end if;
  if char_length(v_body) > 300 then raise exception 'message too long (300 characters max)'; end if;

  if not exists (select 1 from unlocked_regions
      where owner = v_uid and region = p_region) then
    raise exception 'unlock this region to join its chat';
  end if;

  if (select count(*) from region_messages
      where sender = v_uid and created_at > now() - interval '1 minute') >= 10 then
    raise exception 'sending too fast — give it a moment';
  end if;

  insert into region_messages (region, sender, body)
  values (p_region, v_uid, v_body)
  returning * into v_row;

  -- lazy retention: latest 100 messages per region, pruned on the write
  -- path (same no-cron pattern as messages/repossess_stale_tiles)
  delete from region_messages rm
  where rm.region = p_region
    and rm.id not in (
      select rm2.id from region_messages rm2
      where rm2.region = p_region
      order by rm2.id desc
      limit 100
    );

  return v_row;
end;
$$;
revoke all on function send_region_message(text, text) from public;
grant execute on function send_region_message(text, text) to authenticated;

-- ── list_region_messages: the only read path. Territory-gated, joins
--    usernames live (renames stay correct), and filters out any sender
--    the caller shares a blocked pair with — in BOTH directions, which
--    is standard mutual-ignore semantics and doesn't confirm to the
--    blocked party which side initiated. Newest first, latest 50. ──
create or replace function list_region_messages(p_region text)
returns table(id bigint, sender uuid, username text, body text, created_at timestamptz)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
begin
  if v_uid is null then raise exception 'not authenticated'; end if;
  if not exists (select 1 from unlocked_regions ur
      where ur.owner = v_uid and ur.region = p_region) then
    raise exception 'unlock this region to join its chat';
  end if;
  return query
  select rm.id, rm.sender, p.username, rm.body, rm.created_at
  from region_messages rm
  join profiles p on p.user_id = rm.sender
  where rm.region = p_region
    and not exists (select 1 from friendships f
      where f.status = 'blocked'
        and f.user_a = least(v_uid, rm.sender)
        and f.user_b = greatest(v_uid, rm.sender))
  order by rm.id desc
  limit 50;
end;
$$;
revoke all on function list_region_messages(text) from public;
grant execute on function list_region_messages(text) to authenticated;

-- ── reports: write-only from players' perspective — no select policy,
--    no select grant; rows are read via the Supabase dashboard (service
--    role) only. body carries a copy of the offending text since chat
--    retention prunes aggressively. ──
create table if not exists reports (
  id bigserial primary key,
  reporter uuid not null references profiles(user_id) on delete cascade,
  reported uuid not null references profiles(user_id) on delete cascade,
  context text not null,
  body text,
  created_at timestamptz not null default now()
);
alter table reports enable row level security;

create or replace function report_player(p_user uuid, p_context text, p_body text)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
begin
  if v_uid is null then raise exception 'not authenticated'; end if;
  if p_user = v_uid then raise exception 'that is you'; end if;
  if not exists (select 1 from profiles where user_id = p_user) then
    raise exception 'no such player';
  end if;
  if (select count(*) from reports
      where reporter = v_uid and created_at > now() - interval '1 day') >= 10 then
    raise exception 'too many reports today';
  end if;
  insert into reports (reporter, reported, context, body)
  values (v_uid, p_user, left(coalesce(p_context, 'unspecified'), 40), left(p_body, 600));
end;
$$;
revoke all on function report_player(uuid, text, text) from public;
grant execute on function report_player(uuid, text, text) to authenticated;

-- ══════════════════════════════════════════════════════════════════
-- Tile nicknames — private to the owner, cleared on transfer
-- ══════════════════════════════════════════════════════════════════
-- A separate table rather than a column on `tiles`, on purpose: `tiles`
-- has a public-read policy (everyone needs to see who owns what, at what
-- price/level), and RLS can't restrict individual COLUMNS of an
-- otherwise-visible row — only which ROWS a query sees. A private
-- per-owner column would need Postgres column-level GRANTs layered on
-- top of that policy, which is real surface area to get right on a
-- table this central. A separate table with its own "read own" policy
-- (same shape as unlocked_regions/bank_ledger above) is simpler and
-- can't leak: RLS alone is enough here.
--
-- No explicit "clear on transfer" column/flag needed either — the row's
-- qk is only ever meaningful for the CURRENT owner, so any ownership
-- change just deletes it outright rather than trying to keep it in
-- sync. `on delete cascade` handles abandon_tile and
-- repossess_stale_tiles for free (both delete the tiles row outright);
-- buy_listed_tile and attack_tile's win branch update the row in place
-- instead of deleting it, so those two explicitly delete the nickname
-- as part of the transfer — see both below.
create table if not exists tile_nicknames (
  qk text primary key references tiles(qk) on delete cascade,
  owner uuid not null references profiles(user_id) on delete cascade,
  nickname text not null check (char_length(nickname) between 1 and 24),
  updated_at timestamptz not null default now()
);
create index if not exists idx_tile_nicknames_owner on tile_nicknames(owner);

alter table tile_nicknames enable row level security;
drop policy if exists "read own tile_nicknames" on tile_nicknames;
create policy "read own tile_nicknames" on tile_nicknames for select using (auth.uid() = owner);
grant select on tile_nicknames to authenticated;

-- ── set_tile_nickname: owner-only. Empty/whitespace-only body clears the
--    nickname (deletes the row) instead of erroring — "rename to nothing"
--    is how a player removes one, there's no separate "clear" action in
--    the UI. ──
create or replace function set_tile_nickname(p_qk text, p_nickname text)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  v_name text := trim(coalesce(p_nickname, ''));
begin
  if v_uid is null then raise exception 'not authenticated'; end if;
  if not exists (select 1 from tiles where tiles.qk = p_qk and owner = v_uid) then
    raise exception 'tile not found or not yours';
  end if;

  if v_name = '' then
    delete from tile_nicknames where tile_nicknames.qk = p_qk;
    return;
  end if;
  if char_length(v_name) > 24 then raise exception 'nicknames are 24 characters max'; end if;

  insert into tile_nicknames (qk, owner, nickname, updated_at)
  values (p_qk, v_uid, v_name, now())
  on conflict (qk) do update set nickname = excluded.nickname, owner = excluded.owner, updated_at = now();
end;
$$;
revoke all on function set_tile_nickname(text, text) from public;
grant execute on function set_tile_nickname(text, text) to authenticated;

-- ── push_subscriptions: opt-in Web Push registrations for the "energy
--    reset" alert. One row per account (a second device resubscribing just
--    overwrites the first — v1 doesn't fan out to multiple devices). No
--    client-facing RLS policy at all, same reasoning as the SELECT-only
--    philosophy above but taken one step further: a push endpoint is
--    bearer-credential-shaped (anyone holding it can make the push service
--    fire a notification at that browser), so unlike tiles/profiles this
--    table isn't even publicly readable — every access goes through the
--    two security-definer functions below (owner read/write) or the
--    service-role key inside the send-energy-alerts edge function (bypasses
--    RLS entirely, never shipped to the client). ──
create table if not exists push_subscriptions (
  user_id uuid primary key references profiles(user_id) on delete cascade,
  endpoint text not null,
  p256dh text not null,
  auth_key text not null,
  created_at timestamptz not null default now()
);

-- Per-alert-type opt-in, added alongside the "tile captured" alert below —
-- v1 only had one alert type, so "row exists" WAS "energy alerts on".
-- energy_alerts defaults true on the add so existing subscribers from that
-- v1 keep getting alerts unchanged; attack_alerts defaults false since it's
-- a brand-new ask nobody has stated a preference for yet. New rows (a
-- player who's never subscribed before) get both defaults too, but
-- save_push_subscription below always passes explicit values for a fresh
-- insert, so the column default only really matters for this backfill.
alter table push_subscriptions add column if not exists energy_alerts boolean not null default true;
alter table push_subscriptions add column if not exists attack_alerts boolean not null default false;

alter table push_subscriptions enable row level security;

-- ── save_push_subscription: called right after the client subscribes via
--    the browser's PushManager, and again on every toggle flip — the
--    client always sends its full current pair of preferences, not just
--    the one that changed, so this is a plain upsert with no partial-
--    update ambiguity. Keyed on user_id (not endpoint): re-subscribing
--    (e.g. after clearing site data) replaces this account's old
--    registration rather than accumulating stale ones. ──
create or replace function save_push_subscription(p_endpoint text, p_p256dh text, p_auth text, p_energy_alerts boolean, p_attack_alerts boolean)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
begin
  if v_uid is null then raise exception 'not authenticated'; end if;
  insert into push_subscriptions (user_id, endpoint, p256dh, auth_key, energy_alerts, attack_alerts, created_at)
  values (v_uid, p_endpoint, p_p256dh, p_auth, p_energy_alerts, p_attack_alerts, now())
  on conflict (user_id) do update
    set endpoint = excluded.endpoint, p256dh = excluded.p256dh, auth_key = excluded.auth_key,
        energy_alerts = excluded.energy_alerts, attack_alerts = excluded.attack_alerts, created_at = now();
end;
$$;
drop function if exists save_push_subscription(text, text, text);
revoke all on function save_push_subscription(text, text, text, boolean, boolean) from public;
grant execute on function save_push_subscription(text, text, text, boolean, boolean) to authenticated;

-- ── get_push_prefs: lets the client re-hydrate its two toggle states on
--    load without a client-facing SELECT policy on the table itself (see
--    the no-RLS-policy reasoning above push_subscriptions) — this only
--    ever returns the CALLER's own two booleans, never the endpoint/keys
--    that make this table sensitive in the first place. ──
create or replace function get_push_prefs()
returns table(energy_alerts boolean, attack_alerts boolean)
language sql
security definer
set search_path = public
as $$
  select energy_alerts, attack_alerts from push_subscriptions where user_id = auth.uid();
$$;
revoke all on function get_push_prefs() from public;
grant execute on function get_push_prefs() to authenticated;

-- ── disable_push_alerts: full opt-out, used when BOTH toggles end up off
--    — deletes the row outright rather than leaving a with-both-flags-
--    false row sitting around holding a subscription nothing uses. ──
create or replace function disable_push_alerts()
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if auth.uid() is null then raise exception 'not authenticated'; end if;
  delete from push_subscriptions where user_id = auth.uid();
end;
$$;
revoke all on function disable_push_alerts() from public;
grant execute on function disable_push_alerts() to authenticated;

-- ── battle_log.notified: tracks whether send-attack-alerts has already
--    processed a given capture, same idea as attacker_claimed/
--    defender_claimed above but for the push side rather than the in-app
--    "unclaimed battle results" banner — entirely independent of those two
--    flags, a player can claim the in-app result and still be waiting on
--    (or have already gotten) the push, and vice versa. Set true whether
--    or not a push actually went out (e.g. the defender never opted in) —
--    it means "processed", not "delivered", so a row is never re-queried
--    once handled. ──
alter table battle_log add column if not exists notified boolean not null default false;
create index if not exists idx_battle_log_unnotified on battle_log(id) where attacker_won and not notified;

-- ── Schedule send-energy-alerts once per UTC calendar day, right at the
--    same midnight-UTC instant reset_daily_energy uses as "today" (see
--    v_today above) — the reset itself is still lazy/compute-on-read (no
--    cron needed for the game logic), this cron is purely for the
--    notification side, which has no "on read" moment to piggyback on.
--
--    pg_cron/pg_net may need enabling once via Dashboard -> Database ->
--    Extensions if the CREATE EXTENSION lines below fail for lack of
--    privilege.
--
--    Auth: NOT a Bearer JWT. This project's service-role credential is
--    the newer sb_secret_... format (see VITE_SUPABASE_ANON_KEY in .env,
--    which is the sibling sb_publishable_... key) — that's not JWT-shaped,
--    so Supabase's automatic Authorization-header verification on the
--    function rejects it with 401 UNAUTHORIZED_INVALID_JWT_FORMAT before
--    the function's own code ever runs. Both send-*-alerts functions are
--    instead deployed with `--no-verify-jwt` and check the x-cron-secret
--    header themselves against the CRON_SECRET function secret (`supabase
--    secrets set CRON_SECRET=...`, a random value, not the service-role
--    key).
--
--    The header value below is looked up from Supabase Vault at call time
--    (`vault.decrypted_secrets`), NOT inlined as literal SQL text. This
--    file is meant to be re-pasted into the SQL Editor whenever the schema
--    changes, and cron.schedule() unconditionally overwrites the job on
--    every run — an earlier version put the secret directly in the header
--    string here, which meant every single re-paste silently reset auth to
--    whatever placeholder text happened to be sitting in this file at that
--    moment (this is exactly what broke energy-reset-push in production —
--    see the vault.create_secret block immediately below for the one-time
--    fix). Routing through vault.decrypted_secrets makes cron.schedule()
--    itself secret-agnostic, so it's safe to re-run indefinitely: the
--    vault entry, once created, is never touched by this file again.
create extension if not exists pg_cron;
create extension if not exists pg_net;
create extension if not exists supabase_vault;

-- One-time bootstrap: creates the 'cron_secret' vault entry if it doesn't
-- already exist (guarded — safe to leave in this idempotent file, unlike
-- the old inline header). Must match the CRON_SECRET value set via
-- `supabase secrets set` above, or the functions will 401 forever. Replace
-- <CRON_SECRET> below with the real value ONLY when running this for the
-- first time (or after rotating the secret) — paste directly in the SQL
-- Editor, never commit this block with the real value filled in. Once the
-- row exists, this is a permanent no-op regardless of what the placeholder
-- text says, so there's no more "forgot to edit it" failure mode on later
-- re-runs. Goes through vault.create_secret() rather than a raw `insert
-- into vault.secrets` — the raw insert calls pgsodium's encryption
-- trigger directly with the connecting role's own privileges, which the
-- Management API connection (`supabase db query --linked`) doesn't have;
-- vault.create_secret() is a security-definer wrapper that already holds
-- the grants it needs.
do $$
begin
  if not exists (select 1 from vault.secrets where name = 'cron_secret') then
    perform vault.create_secret('<CRON_SECRET>', 'cron_secret');
  end if;
end $$;

select cron.unschedule('energy-reset-push') where exists (select 1 from cron.job where jobname = 'energy-reset-push');
select cron.schedule(
  'energy-reset-push',
  '0 0 * * *',
  $$
  select net.http_post(
    url := 'https://trjrbqkwxmsfxlqermam.supabase.co/functions/v1/send-energy-alerts',
    headers := jsonb_build_object(
      'x-cron-secret', (select decrypted_secret from vault.decrypted_secrets where name = 'cron_secret'),
      'Content-Type', 'application/json'
    ),
    body := '{}'::jsonb
  );
  $$
);

-- ── Schedule send-attack-alerts every 2 minutes — unlike the energy reset
--    (one fixed instant for everyone), a capture happens whenever it
--    happens, so this is a short poll of battle_log's not-yet-notified
--    rows rather than a once-a-day fire. 2 minutes keeps it feeling close
--    to real-time without invoking the function 1440 times/day for what's
--    usually a near-empty query. Same vault-backed x-cron-secret auth as
--    above. ──
select cron.unschedule('attack-alert-push') where exists (select 1 from cron.job where jobname = 'attack-alert-push');
select cron.schedule(
  'attack-alert-push',
  '*/2 * * * *',
  $$
  select net.http_post(
    url := 'https://trjrbqkwxmsfxlqermam.supabase.co/functions/v1/send-attack-alerts',
    headers := jsonb_build_object(
      'x-cron-secret', (select decrypted_secret from vault.decrypted_secrets where name = 'cron_secret'),
      'Content-Type', 'application/json'
    ),
    body := '{}'::jsonb
  );
  $$
);

-- ── friend stats: sync_achievements — see the `ach` column comment far
--    above (right before the leaderboard view) for why this is persisted
--    at all. Called from the client's save() whenever a badge changes. ──
create or replace function sync_achievements(p_ach jsonb)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if auth.uid() is null then raise exception 'not authenticated'; end if;
  -- merge, never overwrite — badges are monotonic (once true, always
  -- true client-side), so this only ever adds keys; a stale/older client
  -- syncing a smaller ach blob can't un-unlock one another client already set.
  update profiles set ach = coalesce(ach, '{}'::jsonb) || p_ach where user_id = auth.uid();
end;
$$;
revoke all on function sync_achievements(jsonb) from public;
grant execute on function sync_achievements(jsonb) to authenticated;

-- leaderboard (see its definition above) now also selects p.ach — it
-- already has no per-row privacy gate (net worth/tile count are public
-- to any authenticated/anon client), so adding ach alongside them is the
-- same trust model, not a new exposure.

-- Force PostgREST to pick up schema changes from this script immediately.
-- It normally reloads on its own shortly after DDL, but that can lag or
-- occasionally not fire when running raw SQL through the dashboard editor
-- (as opposed to a tracked migration) — leaving queries against a
-- brand-new column/function failing with "column/function not found in
-- schema cache" even though the DDL above genuinely succeeded. Safe to
-- run every time this script runs.
notify pgrst, 'reload schema';
