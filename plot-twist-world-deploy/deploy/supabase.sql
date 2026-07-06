-- Run this once in Supabase: SQL Editor -> New query -> paste -> Run.
-- One tiny key-value table backs the whole shared world.
create table if not exists kv (
  scope text not null default 'shared',
  key text not null,
  value text,
  updated_at timestamptz default now(),
  primary key (scope, key)
);
alter table kv enable row level security;
create policy "anon read"   on kv for select using (true);
create policy "anon insert" on kv for insert with check (true);
create policy "anon update" on kv for update using (true);
create policy "anon delete" on kv for delete using (true);
