-- Obsidian-X v4.0.1 — 'memory' item type + persisted junk_score.
-- Additive + idempotent. Safe to re-run.
--
-- Owner directives (2026-07-28):
--   1. A first-class 'memory' type for pure-recall notes that imply no future
--      action (distinct from actionable 'task' or lookup 'reference').
--   2. Junk is NEVER auto-archived; a would-be-junk item is surfaced in the deck
--      with a "would be junk" badge. Persisting the score is what the badge reads.

-- 1. Persist the 0..10 junk score on the item (nullable — pre-v4.0.1 rows have
--    none, and the deck simply shows no badge for them).
alter table items add column if not exists junk_score smallint;

-- 2. Extend the type CHECK to allow 'memory'. A CHECK cannot be altered in place;
--    drop + recreate is the standard move. The new list is a strict superset of
--    the old one, so no existing row can be invalidated by it.
alter table items drop constraint if exists items_type_check;
alter table items add constraint items_type_check
  check (type in ('note','task','idea','shopping','reference','person','event','memory'));
