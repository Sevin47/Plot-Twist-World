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
insert into tile_class (cls, price, rps, sellable) values
  ('downtown',   800, 0.3,   true),
  ('waterfront', 500, 0.18,  true),
  ('urban',      400, 0.14,  true),
  ('coast',      200, 0.07,  true),
  ('suburbs',    150, 0.05,  true),
  ('rural',      50,  0.018, true),
  ('water',      50,  0.012, false)
on conflict (cls) do update set price = excluded.price, rps = excluded.rps, sellable = excluded.sellable;

-- ── accounts ──
create table if not exists profiles (
  user_id uuid primary key references auth.users(id) on delete cascade,
  username text unique not null,
  balance bigint not null default 2000,
  streak int not null default 0,
  last_daily date,
  boost_until timestamptz,
  last_seen timestamptz not null default now(),
  created_at timestamptz not null default now()
);

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
-- text_pattern_ops so `qk like 'prefix%'` (region-shard lookups) can use an
-- index scan regardless of the database's default collation
create index if not exists idx_tiles_qk_pattern on tiles(qk text_pattern_ops);

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
--    claims (see repossess_stale_tiles / regen_energy / buy_unowned_tile
--    below). Additive only — safe to re-run against a live database. ──
alter table bank_ledger add column if not exists kind text not null default 'sale';
-- distinguishes "someone bought your listing" from "a tile was repossessed
-- for inactivity" in the one shared notification pipe (claim_bank_ledger);
-- no CHECK constraint — RLS already blocks any insert except through the
-- security-definer functions below, which are the only two writers.

alter table profiles add column if not exists energy int not null default 20;
alter table profiles add column if not exists energy_at timestamptz not null default now();
-- lazy-regen resource (same "compute on read" pattern as accrue_rent's rent
-- accrual, not a background job): 1 point per 60s, cap 20. Throttles how
-- fast *new unowned land* can be claimed, independent of wallet size — the
-- actual anti-sprawl lever, not just a speed bump.

create index if not exists idx_profiles_last_seen on profiles(last_seen);
-- backs repossess_stale_tiles()'s inactivity scan below

-- ── RLS: public read everywhere it matters, NO direct writes anywhere.
--    All mutation happens through the security-definer functions below.
--    (drop-then-create because CREATE POLICY has no IF NOT EXISTS — this
--    makes the whole script safe to re-run any time, e.g. after a price
--    change like this one.) ──
alter table tile_class enable row level security;
drop policy if exists "read tile_class" on tile_class;
create policy "read tile_class" on tile_class for select using (true);
grant select on tile_class to anon, authenticated;

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
begin
  select * into v_profile from profiles where user_id = p_uid for update;
  if not found then return; end if;

  select coalesce(sum(
    tc.rps * (case t.rarity when 0 then 1 when 1 then 1.5 when 2 then 3 when 3 then 8 else 1 end) * (1 + t.level)
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

  perform regen_energy(p_uid);
  -- rate-limited to a quarter of calls, not every one — repossess_stale_tiles
  -- does real writes (balance credit + ledger insert + delete) per row, so
  -- there's no need to run it on literally every RPC round-trip; any active
  -- player's ordinary traffic still drives it constantly enough with no
  -- cron/extension required.
  if random() < 0.25 then perform repossess_stale_tiles(); end if;
end;
$$;
revoke all on function accrue_rent(uuid) from public;

-- ── regen_energy: lazy leaky-bucket regen for buy_unowned_tile's energy
--    gate, same "compute on read" idea as accrue_rent above. Advances
--    energy_at by whole consumed 60s ticks (never snaps to now()) so partial
--    progress toward the next point is never lost — that would let frequent
--    syncing quietly reset the regen clock. ──
create or replace function regen_energy(p_uid uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_profile profiles;
  v_ticks int;
begin
  select * into v_profile from profiles where user_id = p_uid for update;
  if not found or v_profile.energy >= 20 then return; end if;

  v_ticks := floor(greatest(0, extract(epoch from (now() - v_profile.energy_at))) / 60);
  if v_ticks <= 0 then return; end if;

  update profiles
  set energy = least(20, energy + v_ticks),
      energy_at = energy_at + (v_ticks * interval '60 seconds')
  where user_id = p_uid;
end;
$$;
revoke all on function regen_energy(uuid) from public;

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
    where t.owner is null or p.last_seen < now() - interval '60 days'
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
--    a client-set value would let anyone grant themselves permanent 2x. ──
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
  update profiles set boost_until = now() + interval '5 minutes' where user_id = v_uid
  returning * into v_row;
  if not found then raise exception 'no profile'; end if;
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
begin
  if v_uid is null then raise exception 'not authenticated'; end if;
  if not exists (select 1 from profiles where user_id = v_uid) then raise exception 'no profile'; end if;
  perform accrue_rent(v_uid);

  select * into v_class from tile_class where cls = p_cls;
  if not found or v_class.sellable = false then raise exception 'not purchasable'; end if;

  if (select balance from profiles where user_id = v_uid) < v_class.price then
    raise exception 'insufficient balance';
  end if;
  -- energy gates claiming NEW unowned land specifically — the actual sprawl
  -- vector (zoom anywhere, buy instantly). buy_listed_tile (trading with
  -- another player) and upgrade_tile (investing in what you already own)
  -- are deliberately left energy-free.
  if (select energy from profiles where user_id = v_uid) < 1 then
    raise exception 'no energy left — recharges 1/min, max 20';
  end if;

  v_roll := random();
  v_rarity := case when v_roll < 0.02 then 3 when v_roll < 0.10 then 2 when v_roll < 0.30 then 1 else 0 end;

  update profiles set balance = balance - v_class.price, energy = energy - 1 where user_id = v_uid;
  insert into tiles (qk, owner, cls, level, rarity, paid, updated_at)
  values (p_qk, v_uid, p_cls, 0, v_rarity, v_class.price, now())
  returning * into v_row;

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

  v_seller := v_tile.owner;
  select username into v_buyer_name from profiles where user_id = v_uid;

  update profiles set balance = balance - p_expected_price where user_id = v_uid;
  update profiles set balance = balance + p_expected_price where user_id = v_seller;

  update tiles set owner = v_uid, paid = p_expected_price, list_price = null, updated_at = now()
  where qk = p_qk
  returning * into v_tile;

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
  v_cost := round(v_class.price * 0.8 * power(v_tile.level + 1, 1.6));

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
  select coalesce(sum(amount) filter (where kind = 'sale'), 0),
         coalesce(sum((kind = 'sale')::int), 0),
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
       count(t.qk) as tile_count
from profiles p
left join tiles t on t.owner = p.user_id
group by p.user_id, p.username, p.balance
order by net_worth desc;
grant select on leaderboard to anon, authenticated;
