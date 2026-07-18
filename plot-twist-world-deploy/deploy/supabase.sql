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
  ('water',      50,  0.009,  false)
on conflict (cls) do update set price = excluded.price, rps = excluded.rps, sellable = excluded.sellable;

-- ── reference data: status ladder (mirrors STATUS_TIERS in
--    PlotTwistWorld.jsx). Sticky/high-water-mark — driven by
--    profiles.peak_net_worth (all-time-highest net worth), which never
--    decreases, not live current net worth — see reset_daily_energy and
--    the accrue_rent peak-tracking block below. Tier 6's cap of 20 is the
--    old unconditional energy default from before the daily-cap rework:
--    you used to start with it for free, now you earn your way back. ──
create table if not exists status_tier (
  tier int primary key,
  name text not null,
  min_net_worth bigint not null,
  daily_energy_cap int not null
);
insert into status_tier (tier, name, min_net_worth, daily_energy_cap) values
  (1, 'Squatter',    0,       10),
  (2, 'Homesteader', 5000,    12),
  (3, 'Landholder',  25000,   14),
  (4, 'Developer',   100000,  16),
  (5, 'Baron',       500000,  18),
  (6, 'Magnate',     2000000, 20)
on conflict (tier) do update set name = excluded.name, min_net_worth = excluded.min_net_worth, daily_energy_cap = excluded.daily_energy_cap;

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
begin
  select st.daily_energy_cap into v_cap
  from status_tier st
  where st.min_net_worth <= (select peak_net_worth from profiles where user_id = p_uid)
  order by st.min_net_worth desc
  limit 1;

  update profiles set energy = coalesce(v_cap, 10), energy_date = v_today
  where user_id = p_uid and energy_date < v_today;
end;
$$;
revoke all on function reset_daily_energy(uuid) from public;

-- ── reset_daily_attacks_sent: hard daily cap (3/day, flat, not tier-scaled)
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

-- ── repossess_stale_tiles: land decay. An owner absent 60+ days (profiles.
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
    where (t.owner is null and t.flip_price is null) or p.last_seen < now() - interval '60 days'
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
begin
  if v_uid is null then raise exception 'not authenticated'; end if;
  if not exists (select 1 from profiles where user_id = v_uid) then raise exception 'no profile'; end if;
  perform accrue_rent(v_uid);

  select dev_mode into v_dev_mode from profiles where user_id = v_uid;

  select * into v_class from tile_class where cls = p_cls;
  if not found or v_class.sellable = false then raise exception 'not purchasable'; end if;

  if (select balance from profiles where user_id = v_uid) < v_class.price then
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

  v_roll := random();
  v_rarity := case when v_roll < 0.02 then 3 when v_roll < 0.10 then 2 when v_roll < 0.30 then 1 else 0 end;

  update profiles
    set balance = balance - v_class.price,
        energy = case when v_dev_mode then energy else energy - 1 end
    where user_id = v_uid;
  insert into tiles (qk, owner, cls, level, rarity, paid, updated_at)
  values (p_qk, v_uid, p_cls, 0, v_rarity, v_class.price, now())
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

  update tiles set owner = v_uid, paid = p_expected_price, list_price = null, updated_at = now()
  where qk = p_qk
  returning * into v_tile;

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
begin
  if v_uid is null then raise exception 'not authenticated'; end if;
  if not exists (select 1 from profiles where user_id = v_uid) then raise exception 'no profile'; end if;
  perform accrue_rent(v_uid);

  select * into v_tile from tiles where qk = p_qk and owner = v_uid for update;
  if not found then raise exception 'tile not found or not yours'; end if;
  if v_tile.level >= 4 then raise exception 'already at max level'; end if;

  select * into v_class from tile_class where cls = v_tile.cls;
  -- the prestige factor is why this doesn't cost the same every
  -- redevelopment cycle — see the `prestige` column comment above
  v_cost := round(v_class.price * 0.8 * power(v_tile.level + 1, 1.6) * (1 + 0.5 * v_tile.prestige));

  if (select balance from profiles where user_id = v_uid) < v_cost then
    raise exception 'insufficient balance';
  end if;

  update profiles set balance = balance - v_cost where user_id = v_uid;
  update tiles set level = level + 1, paid = paid + v_cost, updated_at = now()
  where qk = p_qk
  returning * into v_tile;

  return v_tile;
end;
$$;
revoke all on function upgrade_tile(text) from public;
grant execute on function upgrade_tile(text) to authenticated;

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

-- ── flip_tile: cash out a maxed-out (level 4) tile instead of prestiging
--    it. Tears the building down, wipes rarity/prestige, and releases the
--    tile (owner -> null) at an auto-computed asking price of 1.5x total
--    invested (tiles.paid, which upgrade_tile already accumulates) — see
--    buy_flipped_tile below for the other half of this trade. ──
create or replace function flip_tile(p_qk text)
returns tiles
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  v_tile tiles;
  v_price bigint;
begin
  if v_uid is null then raise exception 'not authenticated'; end if;
  perform accrue_rent(v_uid);

  select * into v_tile from tiles where qk = p_qk and owner = v_uid for update;
  if not found then raise exception 'tile not found or not yours'; end if;
  if v_tile.level < 4 then raise exception 'not fully built yet'; end if;

  v_price := round(v_tile.paid * 1.5);

  update tiles
    set owner = null, level = 0, rarity = 0, prestige = 0, paid = 0,
        list_price = null, flip_price = v_price, flip_royalty_to = v_uid,
        updated_at = now()
  where qk = p_qk
  returning * into v_tile;

  return v_tile;
end;
$$;
revoke all on function flip_tile(text) from public;
grant execute on function flip_tile(text) to authenticated;

-- ── buy_flipped_tile: buy a tile released via flip_tile. Pays a fixed 28%
--    royalty to whoever flipped it (bank_ledger 'flip' entry, same "paid
--    while you were away" pipe as a normal sale via claim_bank_ledger); the
--    remaining 72% is a deliberate sink, same as buy_unowned_tile — the
--    buyer is paying a premium for an already-classified, pre-cleared tile,
--    not funding the previous owner 1:1. Energy-free and not region-gated,
--    same as buy_listed_tile — this is a trade, not a land grab. The buyer
--    gets a freshly-rolled deed (matches "starts over" framing), not the
--    flipper's old rarity. ──
create or replace function buy_flipped_tile(p_qk text, p_expected_price bigint)
returns tiles
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  v_tile tiles;
  v_royalty bigint;
  v_roll numeric;
  v_rarity int;
  v_buyer_name text;
  v_region text;
  v_is_first_tile boolean;
begin
  if v_uid is null then raise exception 'not authenticated'; end if;
  if not exists (select 1 from profiles where user_id = v_uid) then raise exception 'no profile'; end if;
  perform accrue_rent(v_uid);

  select * into v_tile from tiles where qk = p_qk for update;
  if not found then raise exception 'tile not found'; end if;
  if v_tile.owner is not null then raise exception 'no longer available'; end if;
  if v_tile.flip_price is null or v_tile.flip_price <> p_expected_price then
    raise exception 'listing changed';
  end if;
  if v_tile.flip_royalty_to = v_uid then raise exception 'cannot buy back your own flip'; end if;
  if (select balance from profiles where user_id = v_uid) < p_expected_price then
    raise exception 'insufficient balance';
  end if;

  -- Same region gate as buy_listed_tile (see that function's comment) —
  -- kept consistent so "which regions can I trade in" is one rule, not a
  -- different rule per market surface.
  v_region := left(p_qk, 8);
  v_is_first_tile := not exists (select 1 from tiles where owner = v_uid);
  if not v_is_first_tile and not exists (
    select 1 from unlocked_regions where owner = v_uid and region = v_region
  ) then
    raise exception 'region not unlocked — travel here first';
  end if;

  v_royalty := round(p_expected_price * 0.28);
  v_roll := random();
  v_rarity := case when v_roll < 0.02 then 3 when v_roll < 0.10 then 2 when v_roll < 0.30 then 1 else 0 end;
  select username into v_buyer_name from profiles where user_id = v_uid;

  update profiles set balance = balance - p_expected_price where user_id = v_uid;
  if v_tile.flip_royalty_to is not null then
    update profiles set balance = balance + v_royalty where user_id = v_tile.flip_royalty_to;
    insert into bank_ledger (recipient, amount, from_username, qk, kind)
    values (v_tile.flip_royalty_to, v_royalty, v_buyer_name, p_qk, 'flip');
  end if;

  update tiles
    set owner = v_uid, level = 0, rarity = v_rarity,
        paid = p_expected_price, flip_price = null, flip_royalty_to = null,
        updated_at = now()
  where qk = p_qk
  returning * into v_tile;

  if v_is_first_tile then
    insert into unlocked_regions (owner, region, is_home)
    values (v_uid, v_region, true)
    on conflict (owner, region) do nothing;
  end if;

  return v_tile;
end;
$$;
revoke all on function buy_flipped_tile(text, bigint) from public;
grant execute on function buy_flipped_tile(text, bigint) to authenticated;

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
create or replace view leaderboard as
select p.user_id, p.username,
       p.balance + coalesce(sum(t.paid), 0) as net_worth,
       count(t.qk) as tile_count,
       p.peak_net_worth
from profiles p
left join tiles t on t.owner = p.user_id
group by p.user_id, p.username, p.balance, p.peak_net_worth
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

  if not v_dev_mode and (select attacks_sent_count from profiles where user_id = v_uid) >= 3 then
    raise exception 'no attacks left today — resets tomorrow';
  end if;

  v_neighbors := qk_neighbors(p_qk);
  v_att_power := (select count(*) from tiles where owner = v_uid and tiles.qk = any(v_neighbors));
  if v_att_power < 1 then
    raise exception 'you need to own an adjacent tile to attack this one';
  end if;

  select * into v_class from tile_class where cls = v_tile.cls;
  v_cost := round(v_class.price * 0.5 * (1 + 0.5 * v_tile.level));
  if (select balance from profiles where user_id = v_uid) < v_cost then
    raise exception 'insufficient balance';
  end if;

  v_def_power := (1 + v_tile.level) * (case v_tile.rarity when 0 then 1 when 1 then 1.5 when 2 then 3 when 3 then 8 else 1 end);
  -- independent ±15% roll per side, server-side only — can't be predicted
  -- or influenced by the client
  v_att_roll := v_att_power * (1 + (random() - 0.5) * 0.3);
  v_def_roll := v_def_power * (1 + (random() - 0.5) * 0.3);
  v_won := v_att_roll > v_def_roll;

  v_is_first_tile := v_won and not exists (select 1 from tiles where owner = v_uid);

  -- cost is spent regardless of outcome
  update profiles
    set balance = balance - v_cost,
        attacks_sent_count = attacks_sent_count + 1,
        attacks_sent_date = v_today
    where user_id = v_uid;

  -- only a CAPTURE resets the tile — level/rarity/prestige wiped, any
  -- listing cleared, paid reset to the district's base price (mirrors
  -- flip_tile's "tear it down" reset), ownership transferred. A successful
  -- DEFENSE leaves the tile completely untouched — the defender's build is
  -- what won the fight, so it has to survive the fight, or defending would
  -- never be worth more than losing outright. Either outcome still bumps
  -- the per-tile daily received-attack counter.
  if v_won then
    update tiles
      set level = 0, rarity = 0, prestige = 0, paid = v_class.price,
          list_price = null, flip_price = null, flip_royalty_to = null,
          owner = v_uid,
          attacks_received_count = v_tile.attacks_received_count + 1,
          attacks_received_date = v_today,
          updated_at = now()
      where tiles.qk = p_qk;
  else
    update tiles
      set attacks_received_count = v_tile.attacks_received_count + 1,
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

-- Force PostgREST to pick up schema changes from this script immediately.
-- It normally reloads on its own shortly after DDL, but that can lag or
-- occasionally not fire when running raw SQL through the dashboard editor
-- (as opposed to a tracked migration) — leaving queries against a
-- brand-new column/function failing with "column/function not found in
-- schema cache" even though the DDL above genuinely succeeded. Safe to
-- run every time this script runs.
notify pgrst, 'reload schema';
