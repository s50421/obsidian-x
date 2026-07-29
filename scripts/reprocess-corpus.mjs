// Obsidian-X v4.0 W2 — the corpus re-process.
//
// Runs the new v4.0 classification (topic-first title + constrained tags +
// multi-topic split + junk score) over the EXISTING brain — the 669 archived
// apple-notes plus the active items — and writes the results as PROPOSALS for
// the W3 swipe deck to review. Titles are never silently overwritten: the only
// direct writes are review FLAGS and the junk archive, both audited and both
// reversible with a single UPDATE.
//
// Usage:
//   node --env-file=.env.local scripts/reprocess-corpus.mjs [flags]
//
//   (default) --dry     plan only. No model calls, no writes. Prints the scope,
//                       the deterministic junk pre-count and the cost estimate.
//   --dry --classify    classify for real, write NOTHING. Prints the aggregate
//                       outcome counts --run would produce. Costs money.
//   --run               classify + write (proposals, flags, junk archive).
//   --limit N           stop after N items (smoke batch).
//   --source apple-notes | all     (default: all)
//   --concurrency N     parallel classifications (default 4).
//
// RESUMABLE: an item is skipped when it already has a retitle/split proposal in
// any state (pending or decided), when a previous pass logged `reprocess_pass`
// for it, or when it is already tagged 'junk'. Re-running after an interruption
// only pays for what is left.
//
// OUTCOMES per item:
//   split           2+ distinct topics  -> 'split' proposal (deck creates the items)
//   retitle         a better title/type/tags -> 'retitle' proposal
//   unchanged       the current title already meets the standard -> nothing written
//   junk_archived   junk score >= 8 and confident -> archived + tag 'junk' + audit
//   flagged         junk 5-7, or no usable title could be written -> needs_review
//   error           classification failed -> nothing written, safe to re-run

import {
  env,
  parseArgs,
  eachCorpusItem,
  countCorpus,
  fetchDecidedItemIds,
  fetchReprocessedItemIds,
  classifyItem,
  estimateCostUsd,
  pool,
  truncate,
  pad,
  fail,
} from "./reprocess-lib.mjs";
import {
  buildRetitlePayload,
  buildSplitPayload,
  structuralJunkScore,
  CONFIDENCE_BAR,
  JUNK_ARCHIVE_SCORE,
  JUNK_REVIEW_SCORE,
  MAX_SPLIT_PARTS,
} from "../lib/title-standard.mjs";

const args = parseArgs(process.argv);
const RUN = args.has("run");
const CLASSIFY_ONLY = !RUN && args.has("classify"); // --dry --classify
const PLAN_ONLY = !RUN && !CLASSIFY_ONLY;
const LIMIT = args.num("limit", Infinity);
const SOURCE = args.get("source", "all");
const CONCURRENCY = Math.max(1, Math.min(8, args.num("concurrency", 4)));
const CHUNK = 40; // items fetched + resumability-checked at a time

if (SOURCE !== "all" && SOURCE !== "apple-notes") {
  fail(`--source must be 'apple-notes' or 'all' (got '${SOURCE}')`);
}

const { admin, apiKey, model } = env(!PLAN_ONLY);
const todayISO = new Date().toISOString().slice(0, 10);

// ---------------------------------------------------------------------------
// Tallies
// ---------------------------------------------------------------------------
const t = {
  scanned: 0,
  skippedDecided: 0,
  classified: 0,
  retitle: 0,
  split: 0,
  splitParts: 0,
  splitCapped: 0,
  unchanged: 0,
  junkArchived: 0,
  flaggedJunk: 0,
  flaggedTitle: 0,
  lowConfidence: 0,
  errors: 0,
  promptTokens: 0,
  completionTokens: 0,
  costUsd: 0,
  writeErrors: 0,
};
const samples = []; // a few before -> after lines for the summary
const errorSamples = [];
let ownerId = null;

// ---------------------------------------------------------------------------
// Per-item decision. Pure given a verdict — the writes below just execute it.
// ---------------------------------------------------------------------------
function decide(item, verdict) {
  if (verdict.junkVerdict === "archive") {
    return { outcome: "junk_archived", reason: verdict.junkReason ?? "no reusable content" };
  }
  // No usable title survived the spec. Proposing it would be exactly the
  // half-baked output the v4 laws forbid, so a human is asked instead.
  if (!verdict.title || verdict.titleIssues.length) {
    return { outcome: "flagged_title", reason: `unusable title (${verdict.titleIssues.join(", ")})` };
  }
  if (verdict.parts.length >= 2) return { outcome: "split" };

  // Nothing to approve if the item already says exactly this. Not spending a
  // swipe on a no-op is the difference between a 200-card deck and a 700-card one.
  const sameTitle = (item.title ?? "").trim() === verdict.title;
  const sameType = (item.type ?? "note") === verdict.type;
  const sameTags = JSON.stringify([...(item.tags ?? [])].sort()) === JSON.stringify([...verdict.tags].sort());
  if (sameTitle && sameType && sameTags) return { outcome: "unchanged" };
  return { outcome: "retitle" };
}

// ---------------------------------------------------------------------------
// Writes (only reached under --run)
// ---------------------------------------------------------------------------

async function insertProposal(item, kind, title, payload) {
  const { error } = await admin.from("proposals").insert({
    user_id: item.user_id,
    kind,
    status: "pending",
    title,
    payload,
    source: "reprocess",
    source_item_id: item.id,
  });
  if (error) {
    t.writeErrors++;
    if (errorSamples.length < 10) errorSamples.push(`${item.id} proposal: ${error.message}`);
  }
}

async function flagItem(item, reason) {
  // Never clobber a more specific flag the pipeline already set (e.g. a
  // duplicate warning) — only fill an empty one.
  const { error } = await admin
    .from("items")
    .update({ needs_review: true, review_reason: item.review_reason || reason })
    .eq("id", item.id)
    .eq("user_id", item.user_id);
  if (error) {
    t.writeErrors++;
    if (errorSamples.length < 10) errorSamples.push(`${item.id} flag: ${error.message}`);
  }
}

async function archiveAsJunk(item, verdict) {
  const tags = [...new Set([...(item.tags ?? []), "junk"])];
  const { error } = await admin
    .from("items")
    .update({ status: "archived", tags })
    .eq("id", item.id)
    .eq("user_id", item.user_id);
  if (error) {
    t.writeErrors++;
    if (errorSamples.length < 10) errorSamples.push(`${item.id} junk: ${error.message}`);
    return;
  }
  await admin.from("audit").insert({
    user_id: item.user_id,
    item_id: item.id,
    action: "junk_archived",
    actor: "system",
    detail: {
      junk_score: verdict.junkScore,
      junk_reason: verdict.junkReason,
      ruthlessness: JUNK_ARCHIVE_SCORE,
      previous_status: item.status,
      previous_tags: item.tags ?? [],
      pass: "reprocess",
    },
  });
}

// One row per item handled, so a re-run knows not to pay for it twice — and so
// "what did the pass do to this note?" is answerable from the audit trail alone.
async function auditPass(item, verdict, decision) {
  await admin.from("audit").insert({
    user_id: item.user_id,
    item_id: item.id,
    action: "reprocess_pass",
    actor: "system",
    detail: {
      outcome: decision.outcome,
      old_title: item.title,
      new_title: verdict.title || null,
      junk_score: verdict.junkScore,
      confidence: verdict.confidence,
      parts: verdict.parts.length,
      model,
    },
  });
}

// ---------------------------------------------------------------------------
// Handle one item end to end
// ---------------------------------------------------------------------------
async function handle(item) {
  if (!ownerId) ownerId = item.user_id;

  const { verdict, usage, error } = await classifyItem({ apiKey, model, item, todayISO });
  if (usage) {
    t.promptTokens += usage.prompt_tokens ?? 0;
    t.completionTokens += usage.completion_tokens ?? 0;
    if (typeof usage.cost_usd === "number") t.costUsd += usage.cost_usd;
  }
  if (!verdict) {
    t.errors++;
    if (errorSamples.length < 10) errorSamples.push(`${item.id}: ${error}`);
    return;
  }
  t.classified++;
  if (error) {
    // Unreadable reply -> parseReprocessReply already degraded it to a
    // low-confidence verdict, which decide() turns into a flag, not a title.
    t.errors++;
    if (errorSamples.length < 10) errorSamples.push(`${item.id}: ${error}`);
  }

  const decision = decide(item, verdict);
  if (verdict.confidence < CONFIDENCE_BAR) t.lowConfidence++;
  if (verdict.splitCapped) t.splitCapped++;

  // Junk 5-7 (or 8+ with doubt): the item is KEPT and flagged. This is a flag,
  // never a content change, so it is written directly rather than proposed.
  const possibleJunk = verdict.junkVerdict === "review";

  switch (decision.outcome) {
    case "junk_archived": {
      t.junkArchived++;
      if (samples.length < 8) samples.push(["JUNK", item, verdict]);
      if (RUN) {
        await archiveAsJunk(item, verdict);
        await auditPass(item, verdict, decision);
      }
      return;
    }
    case "flagged_title": {
      t.flaggedTitle++;
      if (RUN) {
        await flagItem(item, possibleJunk ? "possible-junk" : "needs a human title — the classifier could not write one");
        await auditPass(item, verdict, decision);
      }
      return;
    }
    case "split": {
      t.split++;
      t.splitParts += verdict.parts.length;
      if (samples.length < 8) samples.push(["SPLIT", item, verdict]);
      if (RUN) {
        await insertProposal(item, "split", item.title ?? null, buildSplitPayload(item, verdict));
        if (possibleJunk) {
          t.flaggedJunk++;
          await flagItem(item, "possible-junk");
        }
        await auditPass(item, verdict, decision);
      } else if (possibleJunk) t.flaggedJunk++;
      return;
    }
    case "retitle": {
      t.retitle++;
      if (samples.length < 8) samples.push(["RETITLE", item, verdict]);
      if (RUN) {
        await insertProposal(item, "retitle", verdict.title, buildRetitlePayload(item, verdict));
        if (possibleJunk) {
          t.flaggedJunk++;
          await flagItem(item, "possible-junk");
        }
        await auditPass(item, verdict, decision);
      } else if (possibleJunk) t.flaggedJunk++;
      return;
    }
    default: {
      t.unchanged++;
      if (RUN) {
        if (possibleJunk) {
          t.flaggedJunk++;
          await flagItem(item, "possible-junk");
        }
        await auditPass(item, verdict, decision);
      } else if (possibleJunk) t.flaggedJunk++;
    }
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
const total = await countCorpus(admin, SOURCE);
console.log(`Obsidian-X v4.0 W2 — corpus re-process`);
console.log(`mode:        ${RUN ? "RUN (writes)" : CLASSIFY_ONLY ? "DRY + classify (no writes)" : "DRY (plan only)"}`);
console.log(`source:      ${SOURCE}`);
console.log(`in scope:    ${total} items (excludes source=system, superseded rows and existing 'junk')`);
if (LIMIT !== Infinity) console.log(`limit:       ${LIMIT}`);
if (!PLAN_ONLY) console.log(`model:       ${model} · concurrency ${CONCURRENCY}`);
console.log("");

const started = Date.now();
let buffer = [];
let stop = false;

// Structural (free, no model) junk pre-count, so --dry still says something
// true about the corpus.
let structuralJunk = 0;

async function drain() {
  const ids = buffer.map((i) => i.id);
  const [decided, reprocessed] = await Promise.all([
    fetchDecidedItemIds(admin, ids),
    fetchReprocessedItemIds(admin, ids),
  ]);
  const todo = buffer.filter((i) => {
    if (decided.has(i.id) || reprocessed.has(i.id)) {
      t.skippedDecided++;
      return false;
    }
    return true;
  });
  buffer = [];

  // --limit counts items actually HANDLED, so a partly-processed corpus still
  // gives a meaningful smoke batch.
  const remaining = LIMIT === Infinity ? todo.length : Math.max(0, LIMIT - t.scanned);
  if (todo.length > remaining) todo.length = remaining;

  for (const item of todo) {
    if (structuralJunkScore(item.title, item.raw || item.body).score >= JUNK_ARCHIVE_SCORE) structuralJunk++;
  }

  if (PLAN_ONLY) {
    t.scanned += todo.length;
    return;
  }
  await pool(todo, CONCURRENCY, handle);
  t.scanned += todo.length;
  const secs = ((Date.now() - started) / 1000).toFixed(0);
  console.log(
    `  … ${t.scanned} handled  (retitle ${t.retitle}, split ${t.split}, junk ${t.junkArchived}, unchanged ${t.unchanged}, err ${t.errors})  ${secs}s`
  );
}

for await (const item of eachCorpusItem(admin, { source: SOURCE })) {
  buffer.push(item);
  if (buffer.length >= CHUNK) {
    await drain();
    if (t.scanned >= LIMIT) {
      stop = true;
      break;
    }
  }
}
if (!stop && buffer.length) await drain();

// Record the spend next to the app's other model costs.
if (RUN && ownerId && t.promptTokens) {
  await admin
    .from("llm_usage")
    .insert({
      user_id: ownerId,
      operation: "reprocess_corpus",
      model,
      prompt_tokens: t.promptTokens,
      completion_tokens: t.completionTokens,
      total_tokens: t.promptTokens + t.completionTokens,
      cost_usd: t.costUsd || null,
    })
    .then(
      () => {},
      () => {}
    );
}

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------
const elapsed = ((Date.now() - started) / 1000).toFixed(1);
console.log("\n--- reprocess summary ---");
console.log(`items in scope:      ${total}`);
console.log(`already decided:     ${t.skippedDecided} (skipped — proposal or previous pass exists)`);
console.log(`handled this run:    ${t.scanned}`);

if (PLAN_ONLY) {
  console.log(`structural junk:     ${structuralJunk} (deterministic, no model — would score >= ${JUNK_ARCHIVE_SCORE})`);
  console.log(`\nestimated cost:      $${estimateCostUsd(t.scanned).toFixed(2)}  (${model ?? "haiku-class"}, ~1.5k in / 200 out per item)`);
  console.log(`elapsed:             ${elapsed}s`);
  console.log(`\nNothing was called and nothing was written.`);
  console.log(`Next: node --env-file=.env.local scripts/retitle-sample.mjs   (20-item quality check)`);
  console.log(`Then: node --env-file=.env.local scripts/reprocess-corpus.mjs --run`);
  process.exit(0);
}

console.log(`classified:          ${t.classified}`);
console.log("");
console.log(`proposals — retitle: ${t.retitle}`);
console.log(`proposals — split:   ${t.split}  (${t.splitParts} parts total${t.splitCapped ? `, ${t.splitCapped} capped at ${MAX_SPLIT_PARTS}` : ""})`);
console.log(`unchanged:           ${t.unchanged} (title already met the standard)`);
console.log("");
console.log(`junk archived:       ${t.junkArchived}  (score >= ${JUNK_ARCHIVE_SCORE}, confident — tagged 'junk', reversible)`);
console.log(`flagged possible-junk:${String(t.flaggedJunk).padStart(4)}  (score ${JUNK_REVIEW_SCORE}-${JUNK_ARCHIVE_SCORE - 1} or unsure — kept)`);
console.log(`flagged no-title:    ${t.flaggedTitle}  (classifier could not meet the spec)`);
console.log(`low confidence:      ${t.lowConfidence} (< ${CONFIDENCE_BAR})`);
console.log(`errors:              ${t.errors}`);
if (RUN) console.log(`write errors:        ${t.writeErrors}`);
console.log("");
console.log(`tokens:              ${t.promptTokens} in / ${t.completionTokens} out`);
console.log(`cost (reported):     $${t.costUsd.toFixed(4)}`);
console.log(`cost (estimate):     $${estimateCostUsd(t.classified).toFixed(2)}`);
console.log(`elapsed:             ${elapsed}s`);

if (samples.length) {
  console.log("\nsample decisions:");
  for (const [kind, item, v] of samples) {
    console.log(`  [${pad(kind, 7)}] ${truncate(item.title, 44)}`);
    if (kind === "SPLIT") for (const p of v.parts) console.log(`             -> ${truncate(p.title, 60)}`);
    else console.log(`             -> ${truncate(v.title, 60)}  (junk ${v.junkScore}, conf ${v.confidence.toFixed(2)})`);
  }
}
if (errorSamples.length) {
  console.log("\nfirst errors:");
  for (const e of errorSamples) console.log("  " + e);
}

if (!RUN) {
  console.log(`\n--dry: NOTHING was written. Re-run with --run to create the proposals.`);
} else {
  console.log(`\nProposals are pending in the swipe deck: /deck?mode=import`);
}
if (t.writeErrors) process.exit(1);
