# Where the schema lives

`supabase.sql` is **not in this repo, and no longer on disk at this path.**

It lives in one place only:

```
plot-twist-world-server/supabase.sql
```

(private repo: https://github.com/Sevin47/plot-twist-world-server)

## Why it isn't here

Two reasons, in this order:

1. **It's the economy.** Covenant weights, the rare-deal gate, contract
   rolls, NPC landlord behaviour, repossession thresholds, the attack
   formula's server side. This repo is public; tracking the file published
   all of it. It was purged from this repo's history on 2026-07-29.

2. **A second copy is a live hazard, not a backup.** From the purge until
   2026-08-21 a copy also sat here, untracked. Because `.gitignore` hid it,
   git never showed it drifting, and it drifted twice:

   - **1.33.3** — the stipend paid ₲0 silently for a release. The energy fix
     was written against the server copy, which had branched before the
     stipend split, so re-running it `create or replace`d the split-aware
     `claim_daily()` back to the old one.
   - **2026-08-21** — the copy here was found 47 lines *behind*, still
     holding the pre-1.33.2 energy logic. Pasting it would have reverted
     "a pre-noon session got half a day's energy, every day."

   Both times the file that got pasted was chosen by which folder someone
   happened to be in. Deleting this copy is what makes that impossible.

## Applying it

No workflow applies it. Paste the whole file into the Supabase **SQL
Editor**; it is idempotent and meant to be re-pasted in full.

Leave `vault.create_secret('<CRON_SECRET>', ...)` as the placeholder unless
this is a first run or you're rotating the secret — and never commit it
filled in.

## Editing it

Edit `plot-twist-world-server/supabase.sql` directly and commit it there.
There is nothing to copy back here. A schema change and the client change
that depends on it are two commits in two repos; the CHANGELOG entry in
this repo is what ties them together, so say in it that a re-paste is
required (see 1.35.2, 1.35.1 and 1.33.3 for the wording).

If a `supabase.sql` ever reappears at this path, it is a stray copy —
delete it rather than editing it. `.gitignore` will hide it from you.
