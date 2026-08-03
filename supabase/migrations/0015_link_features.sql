-- Obsidian-X — record WHY a connection was suggested, so the system can learn.
-- Additive + idempotent.
--
-- Owner decision (2026-08-02): don't train a model, but do build the learning
-- loop. The reasoning is in PROJECT-STATE — 23 items is 253 possible pairs in
-- total, which is orders of magnitude short of what a neural link-predictor
-- needs, while a weighted score over ~8 features works from ~50 labels and can
-- still explain itself in words. Explainability is a design law here, and a
-- network returns a score rather than a reason.
--
-- This column is the DATASET. Every suggestion stores the feature vector it was
-- scored on; the owner's Link/Not-related decision is already recorded in
-- `status`. Together those are (features, label) pairs — collected from now on,
-- at no cost, so the "should we fit weights?" question can be answered with real
-- data in a few months instead of guessed at today.
alter table edges
  add column if not exists features jsonb not null default '{}'::jsonb;

-- The training query is "every edge that has features and a verdict".
create index if not exists edges_features_idx
  on edges(user_id, status)
  where features <> '{}'::jsonb;

comment on column edges.features is
  'Feature vector this suggestion was scored on (see lib/link-features.ts). With status as the label, these are the training pairs for lib/link-model.ts.';
