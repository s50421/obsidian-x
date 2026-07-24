-- Obsidian-X v1.5 (T3) — store outward-action references on the item.
-- e.g. {"clickup": {"id": "...", "url": "https://app.clickup.com/t/..."}}
alter table items add column if not exists external jsonb;
