// Obsidian-X v4.0 W2 — unit tests for the re-title / split / junk core.
//
//   node --test scripts/test-retitle-core.mjs        (or: node scripts/test-retitle-core.mjs)
//
// Everything under test is pure: model JSON in, item fields out. No network, no
// database, no keys. The model replies below are FABRICATED — including the
// broken ones, which are the point: the no-half-baked law says a bad reply must
// degrade to "kept + flagged", never to a confidently wrong title.
//
// The real failure modes in the vision docs are used as fixtures verbatim.

import test from "node:test";
import assert from "node:assert/strict";

import { classifyItem } from "./reprocess-lib.mjs";
import {
  parseEnrichPayload,
  parseReprocessReply,
  buildRetitlePayload,
  buildSplitPayload,
  cleanTitle,
  titleQualityIssues,
  normalizeTags,
  mergeTags,
  scoreJunk,
  structuralJunkScore,
  capSplitParts,
  TITLE_MAX,
  MAX_SPLIT_PARTS,
  CONFIDENCE_BAR,
  JUNK_ARCHIVE_SCORE,
  TAG_TAXONOMY,
} from "../lib/title-standard.mjs";

// A well-formed single-topic reply, used as the base for variations.
const good = (over = {}) => ({
  confidence: 0.9,
  items: [
    {
      title: "Best Buy case study — position and key issues",
      type: "reference",
      body: "Best Buy's competitive position, showrooming, and the key strategic issues.",
      tags: ["school", "business"],
      priority: "medium",
      due_date: null,
      entities: [{ name: "Best Buy", kind: "org" }],
      junk_score: 0,
      confidence: 0.9,
      ...over,
    },
  ],
});

const item = (over = {}) => ({ title: "Some note", body: "Some body text here.", ...over });

// ---------------------------------------------------------------------------
test("malformed JSON -> safe fallback: capture kept, flagged, never lost", async (t) => {
  await t.test("null reply", () => {
    const text = "Ask Marcus about the roof repair quote before Friday.";
    const r = parseEnrichPayload(null, text);
    assert.equal(r.items.length, 1);
    assert.equal(r.items[0].body, text, "the original text survives verbatim");
    assert.equal(r.items[0].needs_review, true);
    assert.equal(r.items[0].confidence, 0);
    assert.equal(r.split, false);
    assert.match(r.items[0].review_reason, /unreadable/);
  });

  await t.test("garbage shapes never throw", () => {
    for (const junkReply of ["", 42, [], "not json", { items: "nope" }, { items: [] }, undefined]) {
      const r = parseEnrichPayload(junkReply, "some capture text");
      assert.equal(r.items.length, 1);
      assert.equal(r.items[0].needs_review, true);
    }
  });

  await t.test("item with no usable title falls back and flags, never invents", () => {
    const r = parseEnrichPayload({ confidence: 0.9, items: [{ title: "**", body: "1,200,000 = 0.5 x sell" }] }, "x");
    assert.equal(r.items[0].title, "Untitled capture");
    assert.equal(r.items[0].needs_review, true);
    assert.ok(r.items[0].confidence <= 0.5, "a rescued title is never trusted");
  });

  await t.test("reprocess: an unreadable reply is a low-confidence non-verdict", () => {
    const v = parseReprocessReply(null, item({ title: "Old raw first line of the note" }));
    assert.equal(v.title, "");
    assert.ok(v.confidence < CONFIDENCE_BAR, "cannot pass the bar on no reading");
    assert.deepEqual(v.parts, []);
    assert.equal(v.oldTitle, "Old raw first line of the note", "the old title is preserved for the caller to keep");
  });
});

// ---------------------------------------------------------------------------
test("title > 60 chars truncates at a word boundary", async (t) => {
  await t.test("truncates on a space, no mid-word cut, no ellipsis", () => {
    const long =
      "Quarterly business review preparation notes covering revenue growth and the hiring plan";
    const r = parseEnrichPayload(good({ title: long }), "body");
    const out = r.items[0].title;
    assert.ok(out.length <= TITLE_MAX, `"${out}" is ${out.length} chars`);
    assert.ok(!out.endsWith("…") && !out.endsWith("..."), "a truncated thought must not advertise itself");
    assert.ok(long.startsWith(out), "truncation only removes from the end");
    // The cut landed on a word boundary: the next char in the source is a space.
    assert.equal(long[out.length], " ");
  });

  await t.test("a boundary-less title still gets cut to the cap", () => {
    const out = cleanTitle("A".repeat(120));
    assert.ok(out.length <= TITLE_MAX);
  });

  await t.test("exactly 60 chars is untouched", () => {
    const exact = "Zurich apartment search viewings budget and the move plan01".slice(0, 60);
    assert.equal(cleanTitle(exact).length, Math.min(exact.length, TITLE_MAX));
  });
});

// ---------------------------------------------------------------------------
test("split > 6 keeps the first 6 and flags the capture", async (t) => {
  const many = (n, conf = 0.9) => ({
    confidence: conf,
    items: Array.from({ length: n }, (_, i) => ({
      title: `Topic number ${i + 1} — the thing it is about`,
      body: `Body of topic ${i + 1}`,
      type: "note",
      tags: ["projects"],
      junk_score: 0,
      confidence: conf,
    })),
  });

  await t.test("9 topics -> 6 items", () => {
    const r = parseEnrichPayload(many(9), "raw");
    assert.equal(r.items.length, MAX_SPLIT_PARTS);
    assert.equal(r.items[0].title, "Topic number 1 — the thing it is about");
    assert.equal(r.items[5].title, "Topic number 6 — the thing it is about");
    assert.equal(r.split, true);
  });

  await t.test("the capped capture is flagged so the dropped topics are recoverable", () => {
    const r = parseEnrichPayload(many(9), "raw");
    assert.equal(r.items[0].needs_review, true);
    assert.match(r.items[0].review_reason, /more than 6 topics/);
  });

  await t.test("exactly 6 is not capped and not flagged", () => {
    const r = parseEnrichPayload(many(6), "raw");
    assert.equal(r.items.length, 6);
    assert.equal(r.items[0].needs_review, false);
  });

  await t.test("reprocess split is capped at 6 and reports it", () => {
    const parts = Array.from({ length: 8 }, (_, i) => ({
      title: `Part ${i + 1} — separate subject matter`,
      body: `part ${i + 1} body`,
      type: "note",
      tags: ["admin"],
    }));
    const v = parseReprocessReply({ confidence: 0.9, title: "X — y", split: parts }, item());
    assert.equal(v.parts.length, MAX_SPLIT_PARTS);
    assert.equal(v.splitCapped, true);
  });

  await t.test("capSplitParts is the single enforcement point", () => {
    assert.deepEqual(capSplitParts([1, 2, 3]), { parts: [1, 2, 3], capped: false });
    assert.equal(capSplitParts([1, 2, 3, 4, 5, 6, 7]).parts.length, 6);
    assert.equal(capSplitParts([1, 2, 3, 4, 5, 6, 7]).capped, true);
    assert.deepEqual(capSplitParts(null), { parts: [], capped: false });
  });

  await t.test("a 1-part 'split' is not a split", () => {
    const v = parseReprocessReply(
      { confidence: 0.9, title: "Something — else", split: [{ title: "Only one", body: "b" }] },
      item()
    );
    assert.deepEqual(v.parts, []);
  });
});

// ---------------------------------------------------------------------------
test("uncertain splits collapse back to one flagged item (no half-baked memories)", () => {
  const shaky = {
    confidence: 0.4,
    items: [
      { title: "Olive oil and pantry shopping list", body: "buy olive oil", type: "shopping", tags: ["food"], confidence: 0.4 },
      { title: "V-Bank term sheet — open questions", body: "v-bank questions", type: "task", tags: ["finance"], confidence: 0.5 },
    ],
  };
  const raw = "buy olive oil\nv-bank questions";
  const r = parseEnrichPayload(shaky, raw);
  assert.equal(r.items.length, 1, "below the bar, one honest item beats two guesses");
  assert.equal(r.split, false);
  assert.equal(r.items[0].body, raw, "nothing is dropped — the whole capture is kept");
  assert.equal(r.items[0].needs_review, true);
  assert.match(r.items[0].review_reason, /2 topics/);
  // Above the bar the same shape DOES split.
  const confident = { ...shaky, confidence: 0.9, items: shaky.items.map((i) => ({ ...i, confidence: 0.9 })) };
  assert.equal(parseEnrichPayload(confident, raw).items.length, 2);
});

// ---------------------------------------------------------------------------
test("junk paths (v4.0.1): surfaced, never auto-archived", async (t) => {
  const prose = "Marcus confirmed the roof repair quote at 4,200 CHF and will send the contract on Monday.";

  await t.test("score 9, confident -> review + wouldArchive (never 'archive')", () => {
    const j = scoreJunk({ modelScore: 9, modelConfidence: 0.9, title: "Scratch", body: prose });
    assert.equal(j.score, 9);
    assert.equal(j.verdict, "review");
    assert.equal(j.wouldArchive, true);
  });

  await t.test("score 8 is the would-be-junk bar; the verdict tops out at review", () => {
    const j8 = scoreJunk({ modelScore: 8, modelConfidence: 0.8, title: "t", body: prose });
    assert.equal(j8.verdict, "review");
    assert.equal(j8.wouldArchive, true);
    const j7 = scoreJunk({ modelScore: 7, modelConfidence: 0.9, title: "t", body: prose });
    assert.equal(j7.verdict, "review");
    assert.equal(j7.wouldArchive, false);
    assert.equal(JUNK_ARCHIVE_SCORE, 8);
  });

  await t.test("5-7 -> review (kept + flagged), not would-be-junk", () => {
    for (const s of [5, 6, 7]) {
      const j = scoreJunk({ modelScore: s, modelConfidence: 0.95, title: "t", body: prose });
      assert.equal(j.verdict, "review", `score ${s}`);
      assert.equal(j.wouldArchive, false, `score ${s}`);
    }
  });

  await t.test("< 5 -> keep, nothing said", () => {
    for (const s of [0, 2, 4]) {
      assert.equal(scoreJunk({ modelScore: s, modelConfidence: 0.95, title: "t", body: prose }).verdict, "keep");
    }
  });

  await t.test("8+ but UNSURE is a soft possible-junk — never discard on a guess", () => {
    const j = scoreJunk({ modelScore: 10, modelConfidence: 0.5, title: "t", body: prose });
    assert.equal(j.score, 10);
    assert.equal(j.verdict, "review");
    assert.equal(j.wouldArchive, false, "low confidence -> not a firm would-be-junk");
  });

  await t.test("no model at all -> CERTAIN structural junk is review + wouldArchive", () => {
    const empty = scoreJunk({ modelScore: null, title: "", body: "" });
    assert.equal(empty.verdict, "review");
    assert.equal(empty.wouldArchive, true); // empty
    const testStr = scoreJunk({ modelScore: null, title: "test", body: "test" });
    assert.equal(testStr.verdict, "review");
    assert.equal(testStr.wouldArchive, true); // test string
    assert.equal(scoreJunk({ modelScore: null, title: "Roof", body: prose }).verdict, "keep");
    // Structural-but-uncertain reaches 'review' but never a firm would-be-junk.
    const nn = scoreJunk({ modelScore: null, title: "", body: "1,200,000 = 0.5 x sell" });
    assert.equal(nn.verdict, "review");
    assert.equal(nn.wouldArchive, false);
  });

  await t.test("structure overrules a model that says an empty note is fine", () => {
    const j = scoreJunk({ modelScore: 0, modelConfidence: 1, title: "", body: "   " });
    assert.equal(j.score, 10, "a certain structural verdict wins outright");
    assert.equal(j.verdict, "review");
    assert.equal(j.wouldArchive, true);
    assert.equal(j.structuralReason, "empty");
  });

  await t.test("but the MODEL owns the semantic call: labelled deal math is not junk", () => {
    // The vision wants "1,200,000 = 0.5 x sell..." TITLED, not discarded — so a
    // confident low model score beats the structural no-prose reading.
    const j = scoreJunk({
      modelScore: 2,
      modelConfidence: 0.9,
      title: "Deal payout math — 1.2M split scenario",
      body: "1,200,000 = 0.5 x sell + 0.5 x sell x 0.47",
    });
    assert.equal(j.score, 2);
    assert.equal(j.verdict, "keep");
    assert.equal(j.structuralReason, "no-prose", "the structural reading is still reported");
  });

  await t.test("the real failure modes score as expected", () => {
    assert.equal(structuralJunkScore("", "1,200,000 = 0.5 x sell + 0.5 x sell x 0.47").score, 8);
    assert.equal(structuralJunkScore("", "0").reason, "numeric-scratch");
    assert.equal(structuralJunkScore("", "asdf").reason, "test-string");
    // A digits-only string is NOT auto-archivable — it may be a phone number.
    assert.equal(structuralJunkScore("", "0412345678").certain, false);
    // Short but meaningful is NOT junk.
    assert.equal(structuralJunkScore("Dr Weber", "Call Dr Weber back about the follow-up").reason, null);
  });

  await t.test("enrich: a would-be-junk item is KEPT and flagged, never decided", () => {
    const r = parseEnrichPayload(
      { confidence: 0.9, items: [{ title: "Scratch numbers — no context", body: "0.5 x 1.2 x 0.47", junk_score: 9, confidence: 0.9 }] },
      "0.5 x 1.2 x 0.47"
    );
    assert.equal(r.items[0].junk_verdict, "review");
    assert.equal(r.items[0].needs_review, true);
    assert.equal(r.items[0].review_reason, "would be junk — your call");
  });

  await t.test("enrich: a 5-7 item is kept and flagged 'possible-junk'", () => {
    const r = parseEnrichPayload(
      { confidence: 0.9, items: [{ title: "Half a thought about the pricing model", body: "pricing thoughts, unclear", junk_score: 6, confidence: 0.9 }] },
      "pricing thoughts, unclear"
    );
    assert.equal(r.items[0].junk_verdict, "review");
    assert.equal(r.items[0].needs_review, true);
    assert.equal(r.items[0].review_reason, "possible-junk");
  });

  await t.test("reprocess carries the junk score and verdict through", () => {
    const v = parseReprocessReply(
      { confidence: 0.9, junk_score: 9, junk_reason: "unlabelled arithmetic", title: "Deal payout math — 1.2M split scenario" },
      item({ body: "1,200,000 = 0.5 x sell + 0.5 x sell x 0.47" })
    );
    assert.equal(v.junkScore, 9);
    assert.equal(v.junkVerdict, "review");
    assert.equal(v.junkReason, "unlabelled arithmetic");
    assert.equal(v.title, "Deal payout math — 1.2M split scenario", "junk still gets a real title — flagged items are still browsed");
  });
});

// ---------------------------------------------------------------------------
test("taxonomy enforcement: unknown tags dropped, at most 1 free-form", async (t) => {
  await t.test("off-taxonomy words are aliased, not lost", () => {
    assert.deepEqual(normalizeTags(["education", "money"]), ["school", "finance"]);
    assert.deepEqual(normalizeTags(["Work", "  TRAVEL  "]), ["career", "travel"]);
  });

  await t.test("at most 3 taxonomy tags + at most 1 free-form", () => {
    const out = normalizeTags(["school", "business", "finance", "health", "best-buy", "v-bank", "lisbon"]);
    assert.equal(out.length, 4);
    assert.deepEqual(out.slice(0, 3), ["school", "business", "finance"]);
    assert.equal(out[3], "best-buy", "the first free-form tag wins; the rest are dropped");
    assert.ok(out.every((tag) => TAG_TAXONOMY.includes(tag) || tag === "best-buy"));
  });

  await t.test("free-form tags are normalised to kebab-case and capped", () => {
    assert.deepEqual(normalizeTags(["#Best Buy"]), ["best-buy"]);
    assert.deepEqual(normalizeTags(["a".repeat(40)]), [], "over-long free-form tags are dropped");
    assert.deepEqual(normalizeTags(["!!!", "", null, undefined, 7]), []);
  });

  await t.test("garbage input never throws", () => {
    assert.deepEqual(normalizeTags(null), []);
    assert.deepEqual(normalizeTags("school"), []);
  });

  await t.test("system tags survive a retitle — losing 'apple-notes' would break the import deck", () => {
    const merged = mergeTags(["apple-notes", "junk", "school"], ["business", "invented-tag"]);
    assert.ok(merged.includes("apple-notes"));
    assert.ok(merged.includes("junk"));
    assert.ok(merged.includes("business"));
    assert.ok(!merged.includes("school"), "old topical tags are replaced by the new reading");
  });

  await t.test("the model cannot mint a system tag as a free-form tag", () => {
    assert.deepEqual(normalizeTags(["apple-notes", "junk"]), []);
  });
});

// ---------------------------------------------------------------------------
test("the title spec, against the real failure modes from the vision docs", async (t) => {
  await t.test("markdown, mentions, emoji and quotes are stripped", () => {
    assert.equal(cleanTitle("## **Best Buy** case study"), "Best Buy case study");
    assert.equal(cleanTitle("@everyone Club announcement about the break"), "Club announcement about the break");
    assert.equal(cleanTitle('"Zurich apartment search"'), "Zurich apartment search");
    assert.equal(cleanTitle("1. Position and Key Issues"), "Position and Key Issues");
    assert.equal(cleanTitle("- [ ] Book the flights to Lisbon"), "Book the flights to Lisbon");
    assert.equal(cleanTitle("Excel recalculation notes…"), "Excel recalculation notes");
  });

  await t.test("a formula is not a title", () => {
    assert.ok(titleQualityIssues("1,200,000 = 0.5 x sell + 0.5 x sell x 0.47").includes("not-prose"));
    assert.ok(titleQualityIssues("Deal payout math — 1.2M split scenario").length === 0);
  });

  await t.test("generic titles are rejected", () => {
    for (const g of ["Notes", "notes", "Meeting notes", "Untitled", "TODO"]) {
      assert.ok(titleQualityIssues(g).includes("generic"), g);
    }
  });

  await t.test("a raw first line is detected as such", () => {
    const body = "After pressing F9 all of the summary statistics changed slightly and I could not tell why";
    assert.ok(titleQualityIssues("After pressing F9 all of the summary statistics", body).includes("raw-first-line"));
    assert.equal(titleQualityIssues("Excel recalculation — why F9 shifts the summary stats", body).length, 0);
  });

  await t.test("a good title from a real reply survives untouched", () => {
    const r = parseEnrichPayload(good(), "Best Buy notes");
    assert.equal(r.items[0].title, "Best Buy case study — position and key issues");
    assert.equal(r.items[0].needs_review, false);
    assert.deepEqual(r.items[0].tags, ["school", "business"]);
    assert.equal(r.items[0].type, "reference");
    assert.equal(r.items[0].junk_verdict, "keep");
  });
});

// ---------------------------------------------------------------------------
test("field coercion: the DB CHECK constraints can never be violated", () => {
  const r = parseEnrichPayload(
    good({ type: "banana", priority: "URGENT", due_date: "next tuesday", entities: "nope" }),
    "body"
  );
  assert.equal(r.items[0].type, "note");
  assert.equal(r.items[0].priority, "medium");
  assert.equal(r.items[0].due_date, null);
  assert.deepEqual(r.items[0].entities, []);

  const ok = parseEnrichPayload(good({ due_date: "2026-08-14" }), "body");
  assert.equal(ok.items[0].due_date, "2026-08-14");
  assert.equal(parseEnrichPayload(good({ due_date: "2026-02-31" }), "b").items[0].due_date, null);
});

// ---------------------------------------------------------------------------
test("proposal payloads match the contract the swipe deck reads", async (t) => {
  const src = item({ id: "11111111-2222-3333-4444-555555555555", title: "Old raw first line" });

  await t.test("retitle payload", () => {
    const v = parseReprocessReply(
      {
        confidence: 0.88,
        junk_score: 1,
        title: "Best Buy case study — position and key issues",
        type: "reference",
        tags: ["school", "business"],
        due_date: "2026-09-01",
        entities: [{ name: "Best Buy", kind: "org" }],
        reason: "A course case study on Best Buy's competitive position.",
      },
      src
    );
    const p = buildRetitlePayload(src, v);
    assert.deepEqual(Object.keys(p).sort(), [
      "confidence", "dueAt", "entities", "itemId", "junkReason", "junkScore",
      "newTags", "newTitle", "newType", "oldTitle", "reason",
    ]);
    assert.equal(p.itemId, src.id);
    assert.equal(p.oldTitle, "Old raw first line");
    assert.equal(p.newTitle, "Best Buy case study — position and key issues");
    assert.equal(p.newType, "reference");
    assert.deepEqual(p.newTags, ["school", "business"]);
    assert.equal(p.dueAt, "2026-09-01");
    assert.equal(p.junkScore, 1);
  });

  await t.test("split payload", () => {
    const v = parseReprocessReply(
      {
        confidence: 0.9,
        junk_score: 0,
        title: "Braindump — errands, bank and travel",
        split: [
          { title: "Olive oil and pantry restock", body: "buy olive oil", type: "shopping", tags: ["food"] },
          { title: "V-Bank term sheet — open questions", body: "ask about the term sheet", type: "task", tags: ["finance"] },
        ],
      },
      src
    );
    const p = buildSplitPayload(src, v);
    assert.deepEqual(Object.keys(p).sort(), ["confidence", "itemId", "junkReason", "junkScore", "oldTitle", "parts", "reason"]);
    assert.equal(p.parts.length, 2);
    assert.deepEqual(Object.keys(p.parts[0]).sort(), ["body", "tags", "title", "type"]);
    assert.equal(p.parts[1].type, "task");
  });
});

// ---------------------------------------------------------------------------
test("classifyItem: the corpus script's model path, with a mocked model", async (t) => {
  const reply = (obj, extra = {}) => ({
    ok: true,
    json: async () => ({
      choices: [{ message: { content: JSON.stringify(obj) } }],
      usage: { prompt_tokens: 1200, completion_tokens: 150, cost: 0.0021 },
      ...extra,
    }),
  });
  const base = { apiKey: "k", model: "test-model", todayISO: "2026-07-29" };

  await t.test("a good reply maps to a verdict + usage", async () => {
    let sentBody = null;
    const r = await classifyItem({
      ...base,
      item: item({ id: "a", title: "1. Position and Key Issues", body: "Best Buy is losing share to Amazon." }),
      fetchImpl: async (_url, opts) => {
        sentBody = JSON.parse(opts.body);
        return reply({ confidence: 0.9, junk_score: 0, title: "Best Buy case study — position and key issues", type: "reference", tags: ["school"] });
      },
    });
    assert.equal(r.error, null);
    assert.equal(r.verdict.title, "Best Buy case study — position and key issues");
    assert.equal(r.verdict.junkVerdict, "keep");
    assert.equal(r.usage.prompt_tokens, 1200);
    assert.equal(r.usage.cost_usd, 0.0021);
    // The prompt actually shipped carries the title spec and the examples.
    const system = sentBody.messages[0].content;
    assert.match(system, /TITLE RULES/);
    assert.match(system, /1,200,000 = 0\.5 x sell/);
    assert.match(system, /JUNK SCORE/);
    assert.equal(sentBody.temperature, 0);
  });

  await t.test("an unreadable reply is reported, never guessed at", async () => {
    const r = await classifyItem({
      ...base,
      item: item({ id: "b" }),
      fetchImpl: async () => ({ ok: true, json: async () => ({ choices: [{ message: { content: "I'm sorry, I can't." } }] }) }),
    });
    assert.equal(r.error, "unreadable model reply");
    assert.equal(r.verdict.title, "");
    assert.ok(r.verdict.confidence < CONFIDENCE_BAR);
  });

  await t.test("a 500 is retried, a 400 is not", async () => {
    let calls = 0;
    const ok = await classifyItem({
      ...base,
      item: item({ id: "c" }),
      fetchImpl: async () => {
        calls++;
        return calls === 1
          ? { ok: false, status: 500, text: async () => "boom" }
          : reply({ confidence: 0.8, junk_score: 0, title: "Recovered after a retry — still fine" });
      },
    });
    assert.equal(calls, 2);
    assert.equal(ok.error, null);

    let bad = 0;
    const r = await classifyItem({
      ...base,
      item: item({ id: "d" }),
      fetchImpl: async () => {
        bad++;
        return { ok: false, status: 400, text: async () => "bad request" };
      },
    });
    assert.equal(bad, 1, "a 400 is a bug, not a blip — do not retry it 669 times");
    assert.equal(r.verdict, null);
    assert.match(r.error, /400/);
  });
});
