import type { SupabaseClient } from "@supabase/supabase-js";
import { chat, extractJson, type Usage } from "@/lib/openrouter";

// Obsidian-X — the canonical entity layer (brain-quality brief, Phase 2).
//
// Before this, an "entity" was a raw string on `items.entities`. The live audit
// on 2026-08-02 found 20 such strings across 25 items, of which 9 needed a
// human decision: "mum" and "Beate Manhart" are the same person, "V-bank" and
// "V-Bank" are the same bank, "David Michael Manhart" is the owner himself.
// Strings can't be merged, so every one of those was a separate node.
//
// Owner decisions this file implements (workshop, 2026-08-02):
//   * AUTO-MERGE THE OBVIOUS — exact, alias, and case-insensitive matches
//     resolve silently. There is no judgement in "V-bank" == "V-Bank".
//   * PROPOSE THE REST — anything needing judgement ("mum" -> Beate Manhart)
//     becomes a proposal the owner approves. Never silent: a wrong silent merge
//     is close to invisible afterwards, because the evidence is gone.
//   * SELF AND SYSTEM ARE NOT EDGE MATERIAL — the owner appears in nearly
//     everything he writes, so "shared person: David" would connect his whole
//     brain to itself. Recorded, `edge_eligible = false`.

export type EntityKind = "person" | "org" | "place" | "other";

export type Entity = {
  id: string;
  name: string;
  kind: EntityKind;
  aliases: string[];
  edge_eligible: boolean;
  needs_review: boolean;
};

export type RawEntity = { name: string; kind?: string };

/**
 * Strings that are the OWNER or the SYSTEM rather than someone he knows.
 *
 * Matched loosely on purpose — the classifier writes his name several ways
 * ("David", "David Manhart", "David Michael Manhart") and any of them would
 * otherwise become a hub node joining unrelated items.
 */
const SELF_PATTERNS = [/\bdavid\b.*\bmanhart\b/i, /^david$/i, /^obsidian-?x$/i];

export function isSelfOrSystem(name: string): boolean {
  const n = (name ?? "").trim();
  return !!n && SELF_PATTERNS.some((re) => re.test(n));
}

export function normKind(kind: string | undefined): EntityKind {
  const k = (kind ?? "").toLowerCase();
  return k === "person" || k === "org" || k === "place" ? k : "other";
}

/** Case/punctuation-insensitive comparison key. */
export function entityKey(name: string): string {
  return (name ?? "")
    .toLowerCase()
    .replace(/[.,'"`]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Canonical display form. Fixes the casing the classifier is inconsistent about
 * ("v-bank" / "V-bank" / "V-Bank") without touching names that are already
 * deliberately cased.
 */
export function canonicalName(name: string): string {
  const n = (name ?? "").trim().replace(/\s+/g, " ");
  if (!n) return n;
  // All-lower or all-upper single words get title-cased; anything with existing
  // mixed case is left exactly as the model wrote it.
  const hasMixedCase = /[a-z]/.test(n) && /[A-Z]/.test(n);
  if (hasMixedCase) return n;
  return n
    .split(" ")
    .map((w) =>
      w
        .split("-")
        .map((part) => (part ? part[0].toUpperCase() + part.slice(1).toLowerCase() : part))
        .join("-")
    )
    .join(" ");
}

export async function loadEntities(admin: SupabaseClient, userId: string): Promise<Entity[]> {
  const { data } = await admin
    .from("entities")
    .select("id,name,kind,aliases,edge_eligible,needs_review")
    .eq("user_id", userId)
    .limit(2000);
  return (data ?? []) as Entity[];
}

/** Find an existing canon row for a raw string: exact name, then alias. */
export function matchEntity(raw: string, kind: EntityKind, canon: Entity[]): Entity | null {
  const key = entityKey(raw);
  if (!key) return null;
  for (const e of canon) {
    if (e.kind !== kind) continue;
    if (entityKey(e.name) === key) return e;
    if (e.aliases.some((a) => entityKey(a) === key)) return e;
  }
  // A person may be recorded under a different kind by a sloppy classify pass
  // ("Sandrine French pastry" came back as an org). Fall back to a name match
  // across kinds rather than creating a second node for the same thing.
  for (const e of canon) {
    if (entityKey(e.name) === key || e.aliases.some((a) => entityKey(a) === key)) return e;
  }
  return null;
}

/**
 * Resolve a raw entity string to a canonical row, creating one if needed.
 *
 * "Resolve or create" races with itself the moment two captures name the same
 * person in the same second, so creation leans on the unique index rather than
 * a read-then-write check: on conflict we re-read and use the winner.
 */
export async function resolveEntity(
  admin: SupabaseClient,
  userId: string,
  raw: RawEntity,
  canon: Entity[]
): Promise<Entity | null> {
  const name = (raw.name ?? "").trim();
  if (!name) return null;
  const kind = normKind(raw.kind);

  const hit = matchEntity(name, kind, canon);
  if (hit) return hit;

  const display = canonicalName(name);
  const { data, error } = await admin
    .from("entities")
    .insert({
      user_id: userId,
      name: display,
      kind,
      aliases: entityKey(display) === entityKey(name) ? [] : [name],
      // Self/system entities are recorded but never derive edges (owner
      // decision) — set at creation so no derivation pass can miss it.
      edge_eligible: !isSelfOrSystem(name),
    })
    .select("id,name,kind,aliases,edge_eligible,needs_review")
    .maybeSingle();

  if (data) {
    canon.push(data as Entity);
    return data as Entity;
  }
  if (error) {
    // Unique violation — someone else created it. Re-read and take theirs.
    const { data: existing } = await admin
      .from("entities")
      .select("id,name,kind,aliases,edge_eligible,needs_review")
      .eq("user_id", userId)
      .eq("kind", kind)
      .ilike("name", display)
      .maybeSingle();
    if (existing) {
      canon.push(existing as Entity);
      return existing as Entity;
    }
  }
  return null;
}

/**
 * Attach an item's entity strings to the canon.
 *
 * `raw_name` keeps the string as the item actually wrote it, which is what lets
 * an edge say "both mention Beate Manhart (as 'mum')" instead of quoting words
 * the item never contained.
 */
export async function linkItemEntities(
  admin: SupabaseClient,
  userId: string,
  itemId: string,
  raws: RawEntity[],
  canon: Entity[]
): Promise<number> {
  let n = 0;
  for (const raw of raws) {
    const ent = await resolveEntity(admin, userId, raw, canon);
    if (!ent) continue;
    const { error } = await admin
      .from("item_entities")
      .upsert(
        { item_id: itemId, entity_id: ent.id, user_id: userId, raw_name: (raw.name ?? "").trim() },
        { onConflict: "item_id,entity_id" }
      );
    if (!error) n += 1;
  }
  return n;
}

// ---- merge proposals ---------------------------------------------------------

/**
 * Below this, a suggested merge is discarded rather than shown.
 *
 * Measured, not guessed: the first run over the real corpus proposed
 * "Dani" -> "Beate Manhart" at 0.6, reasoning that Beate was "the only Manhart
 * in the list". Dani is a consultant who works with V-Bank *through* Manhart
 * Consulting Group — a shared surname in the surrounding text, not a person.
 * Applying it would have merged two unrelated people irreversibly.
 */
export const MIN_MERGE_CONFIDENCE = 0.75;

export type MergeSuggestion = {
  /** The entity that should disappear, by canonical name. */
  from: string;
  /** The entity it should become. */
  into: string;
  reason: string;
  confidence: number;
};

/**
 * Ask the model which canon rows are the same thing.
 *
 * Deliberately only run over names the deterministic matcher could NOT already
 * resolve — the model is for judgement ("is 'mum' Beate Manhart?"), not for
 * case-folding, which code does correctly and for free.
 */
export async function suggestMerges(
  entities: Entity[],
  /** One example item title per entity, so the model can judge from context. */
  context: Map<string, string[]>
): Promise<{ merges: MergeSuggestion[]; usage: Usage | null }> {
  if (entities.length < 2) return { merges: [], usage: null };
  const model = process.env.OPENROUTER_CLASSIFY_MODEL!;

  const lines = entities.map((e) => {
    const seen = (context.get(e.id) ?? []).slice(0, 3).join(" | ");
    return `- ${e.name} (${e.kind})${seen ? ` — appears in: ${seen}` : ""}`;
  });

  const system =
    `You are de-duplicating a personal knowledge base's entity list. Some entries ` +
    `are the SAME real person, organisation or place written differently.\n` +
    `Return ONLY JSON: {"merges":[{"from":"…","into":"…","reason":"…","confidence":0..1}]}\n\n` +
    `MERGE when one name is plainly another way of saying the same thing:\n` +
    `- a RELATIONSHIP WORD and a name used for the same role — "mum"/"mom"/"dad"/` +
    `"my sister" alongside a named person who appears in the same situations. This ` +
    `is the most common real duplicate in a personal brain, so look for it first.\n` +
    `- a short form of the same given name ("Dani" / "Daniela", "Mike" / "Michael").\n` +
    `- the same organisation cased or punctuated differently.\n\n` +
    `DO NOT MERGE:\n` +
    `- two people who merely SHARE A SURNAME, or who both appear near the same ` +
    `company. A surname appearing in another entry's description is NOT evidence ` +
    `— a consultant working "via Manhart Consulting" is not a member of the ` +
    `Manhart family.\n` +
    `- two people sharing only a first name.\n` +
    `- a person and an organisation, ever.\n\n` +
    `Rules:\n` +
    `- "from" and "into" must be EXACT names from the list.\n` +
    `- "into" is the fuller, more formal, more identifying name — the relationship ` +
    `word is always the "from".\n` +
    `- reason: one short clause a human can check, naming the shared situation.\n` +
    `- confidence: only go above ${MIN_MERGE_CONFIDENCE} when the items themselves ` +
    `show the two names in the same role. Anything you inferred from name shape ` +
    `alone belongs BELOW that.\n` +
    `- Return an empty list rather than guessing. A wrong merge destroys ` +
    `information that cannot be recovered; a missed merge costs one duplicate row.`;

  try {
    const { content, usage } = await chat(
      model,
      [
        { role: "system", content: system },
        { role: "user", content: lines.join("\n") },
      ],
      { json: true, temperature: 0 }
    );
    const parsed = extractJson<{ merges?: MergeSuggestion[] }>(content);
    const names = new Set(entities.map((e) => e.name));
    const byName = new Map(entities.map((e) => [e.name, e]));
    const merges = (parsed.merges ?? []).filter((m) => {
      if (!m || !names.has(m.from) || !names.has(m.into) || m.from === m.into) return false;
      // The floor is enforced HERE, not in the prompt alone — a model asked to
      // self-report confidence will still hand back a 0.6 it wants you to act on.
      if (Number(m.confidence) < MIN_MERGE_CONFIDENCE) return false;
      // Structural guard the model got wrong on the very first real run: a
      // person and an organisation are never the same entity, whatever the
      // names look like.
      const a = byName.get(m.from);
      const b = byName.get(m.into);
      if (a && b && a.kind !== b.kind && (a.kind === "org" || b.kind === "org")) return false;
      return true;
    });
    return { merges, usage };
  } catch {
    return { merges: [], usage: null };
  }
}

/**
 * Apply a merge: `from` becomes an alias of `into`, its item links move across,
 * and the row disappears.
 *
 * Order matters. Links are re-pointed BEFORE the row is deleted, because the
 * foreign key cascades — deleting first would silently take the item links with
 * it and the merge would quietly lose data instead of preserving it.
 */
export async function applyEntityMerge(
  admin: SupabaseClient,
  userId: string,
  fromId: string,
  intoId: string
): Promise<{ ok: boolean; moved: number }> {
  if (fromId === intoId) return { ok: false, moved: 0 };

  const [{ data: from }, { data: into }] = await Promise.all([
    admin.from("entities").select("id,name,aliases").eq("id", fromId).eq("user_id", userId).maybeSingle(),
    admin.from("entities").select("id,name,aliases").eq("id", intoId).eq("user_id", userId).maybeSingle(),
  ]);
  if (!from || !into) return { ok: false, moved: 0 };

  const { data: links } = await admin
    .from("item_entities")
    .select("item_id,raw_name")
    .eq("entity_id", fromId)
    .eq("user_id", userId);

  let moved = 0;
  for (const l of links ?? []) {
    const { error } = await admin.from("item_entities").upsert(
      {
        item_id: l.item_id as string,
        entity_id: intoId,
        user_id: userId,
        // Keep the ORIGINAL wording. This is what makes the merge explainable
        // afterwards and reversible by a human reading the row.
        raw_name: (l.raw_name as string) ?? (from.name as string),
      },
      { onConflict: "item_id,entity_id" }
    );
    if (!error) moved += 1;
  }

  const aliases = [
    ...new Set([
      ...((into.aliases as string[]) ?? []),
      ...((from.aliases as string[]) ?? []),
      from.name as string,
    ]),
  ];
  await admin.from("entities").update({ aliases, updated_at: new Date().toISOString() }).eq("id", intoId);
  await admin.from("entities").delete().eq("id", fromId).eq("user_id", userId);

  return { ok: true, moved };
}
