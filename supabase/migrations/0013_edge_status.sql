-- Obsidian-X — connections become confirmed-or-suggested (the Obsidian model).
-- Additive + idempotent. Safe to re-run.
--
-- WHY. The owner, twice: "the connections seem very loose and random" and then
-- "it is linking topics that are uncorrelated and keeping others unlinked that
-- clearly should be clustered." Measuring the corpus showed why the second half
-- was true — SIMILAR_THRESHOLD was 0.662 while the highest similarity between
-- any two items in the whole brain is 0.503, so no similarity edge could ever
-- fire and shared-tag edges were left doing all the work alone. "Both tagged
-- tech" was joining a Crypto.com passkey alert to chip-AI research.
--
-- The owner then asked how Obsidian does it. Obsidian INFERS NOTHING: every
-- edge in its graph is an explicit [[wikilink]] a human wrote. What it does
-- instead is "Unlinked mentions" — text matching a note's name or ALIASES is
-- surfaced as a suggestion you convert into a real link in one click.
--
-- That maps onto two things this system already has: the canonical entity table
-- (names + aliases — "mum" is an alias of "Beate Manhart") and the
-- propose-then-approve law. So:
--
--   status='confirmed'  drawn in the graph, shown as a Connection. Earned by
--                       sharing a canonical entity, or by the owner accepting a
--                       suggestion. This is the [[wikilink]] equivalent.
--   status='suggested'  never drawn. Offered in the inspector as "possibly
--                       related", one tap to confirm or dismiss. This is the
--                       "Unlinked mentions" equivalent, and it is where
--                       embedding similarity now lives.
--
-- Similarity stops being a fact and becomes a suggestion, which is what it
-- always actually was.

alter table edges
  add column if not exists status text not null default 'confirmed'
    check (status in ('confirmed', 'suggested', 'dismissed'));

-- The graph and the inspector both filter on this, so it leads the index.
create index if not exists edges_status_idx on edges(user_id, status);

-- A dismissed suggestion must never come back. The derivation pass reads this
-- before proposing anything, so "no, these are unrelated" is remembered —
-- otherwise every nightly rebuild would re-offer the same rejected pair and the
-- feature would feel broken within a week.
create index if not exists edges_pair_status_idx on edges(user_id, src, dst, status);

comment on column edges.status is
  'confirmed = a real connection (shared entity, or owner-accepted). suggested = offered, not drawn. dismissed = owner said no; never re-offer.';
