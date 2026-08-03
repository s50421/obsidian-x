-- Obsidian-X — more ways for two memories to be connected.
-- Additive + idempotent.
--
-- Owner ask (2026-08-02): "give me more ways to show connections e.g. same task".
--
--   same_task      both items are projected onto the same ClickUp task. The
--                  strongest connection the system can assert without a model.
--   same_due_date  both fall due on the same day. Weak alone, but "what else is
--                  landing on Sunday?" is a question the owner actually asks and
--                  nothing else in the graph could answer it.
--   manual         the owner drew it by hand in the connection editor. Never
--                  derived, so the rebuild re-adds these verbatim rather than
--                  deleting them.
alter table edges drop constraint if exists edges_kind_check;
alter table edges add constraint edges_kind_check
  check (kind in ('shared_person','shared_org','shared_place','shared_topic',
                  'reference','thread','similar','same_task','same_due_date','manual'));
