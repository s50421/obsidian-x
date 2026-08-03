// Obsidian-X — the connection learning loop.
//
//   node --experimental-strip-types --no-warnings scripts/test-link-model.mjs
//
// The owner decided against training a model and for building the loop that
// would justify one later. These pin the two properties that make that
// defensible: it must actually LEARN from decisions, and it must be HONEST
// when it hasn't learned anything yet.

import assert from "node:assert/strict";
import { register } from "node:module";
import test from "node:test";

register(new URL("./_alias-hook.mjs", import.meta.url), import.meta.url);

const { fitWeights, scoreLink, explainScore, accuracyOf, PRIOR_WEIGHTS, MIN_LABELS } =
  await import("../lib/link-model.ts");
const { extractFeatures, contentWords, FEATURE_KEYS } = await import("../lib/link-features.ts");

const item = (o) => ({
  id: o.id,
  title: o.title ?? "",
  body: o.body ?? "",
  type: o.type ?? "task",
  tags: o.tags ?? [],
  due_at: o.due_at ?? null,
  created_at: o.created_at ?? "2026-08-01T12:00:00Z",
  external: o.external ?? null,
  entityIds: new Set(o.entityIds ?? []),
});

test("features are all present and in 0..1", () => {
  const f = extractFeatures(
    item({ id: "a", title: "Send mum court docs", tags: ["legal"], entityIds: ["e1"] }),
    item({ id: "b", title: "Beate Manhart lawsuit", tags: ["legal"], entityIds: ["e1"] }),
    0.45
  );
  for (const k of FEATURE_KEYS) {
    assert.ok(typeof f[k] === "number" && f[k] >= 0 && f[k] <= 1, `${k} out of range: ${f[k]}`);
  }
  assert.ok(f.sharedEntities > 0, "a shared entity must register");
  assert.ok(f.tagOverlap > 0, "a shared tag must register");
});

test("stopwords don't manufacture lexical overlap", () => {
  // Without this, every pair shares "the/and/to" and the feature is noise.
  const w = contentWords("Send the docs to the office and then to her");
  for (const s of ["the", "to", "and", "then"]) assert.ok(!w.has(s), `${s} should be dropped`);
  assert.ok(w.has("docs") && w.has("office"));
});

test("two shopping lists overlap lexically even when embeddings are lukewarm", () => {
  // The whole reason this feature exists: the corpus tops out at 0.503 cosine,
  // but two shopping lists share literal words long before that.
  const f = extractFeatures(
    item({ id: "a", title: "Add bananas to shopping list", body: "Bananas" }),
    item({ id: "b", title: "Remove parsley from shopping list", body: "Parsley" }),
    0.5
  );
  assert.ok(f.lexicalOverlap > 0.2, `expected real overlap, got ${f.lexicalOverlap}`);
});

test("it LEARNS: a feature the owner keeps rejecting loses weight", () => {
  // Say the owner consistently rejects "captured close together" and accepts
  // "shares a person". The fit must move both weights the right way.
  const samples = [];
  for (let i = 0; i < 30; i++) {
    samples.push({ features: { sharedEntities: 1, captureProximity: 0 }, label: 1 });
    samples.push({ features: { sharedEntities: 0, captureProximity: 1 }, label: 0 });
  }
  const w = fitWeights(samples);

  // NOT "the accepted feature's weight goes up". The priors already agree with
  // this data, so there is barely any gradient on it and L2 correctly shrinks
  // it a touch — asserting otherwise tests regularisation being absent, which
  // is the thing that keeps a 40-sample fit stable. What must hold is the
  // SEPARATION: the rejected signal has to end up clearly below the accepted
  // one, and the model has to agree with the owner.
  assert.ok(
    w.captureProximity < PRIOR_WEIGHTS.captureProximity,
    `the rejected signal must lose weight (${w.captureProximity})`
  );
  assert.ok(
    w.sharedEntities > w.captureProximity + 1.5,
    `accepted must dominate rejected (${w.sharedEntities} vs ${w.captureProximity})`
  );
  assert.ok(accuracyOf(samples, w) > 0.9, "and it should fit its own data");
  assert.ok(
    scoreLink({ sharedEntities: 1 }, w) > scoreLink({ captureProximity: 1 }, w),
    "a shared person must outscore a shared capture moment"
  );
});

test("a rejected pair scores below a confirmed one after fitting", () => {
  const samples = [];
  for (let i = 0; i < 30; i++) {
    samples.push({ features: { sameTask: 1, similarity: 0.3 }, label: 1 });
    samples.push({ features: { sameTask: 0, similarity: 0.9 }, label: 0 });
  }
  const w = fitWeights(samples);
  const good = scoreLink({ sameTask: 1, similarity: 0.3 }, w);
  const bad = scoreLink({ sameTask: 0, similarity: 0.9 }, w);
  assert.ok(good > bad, `learned signal must beat the raw one (${good} vs ${bad})`);
});

test("regularisation keeps weights sane on a tiny sample", () => {
  // Two examples must not produce a weight of 40. An unregularised fit will.
  const w = fitWeights([
    { features: { similarity: 1 }, label: 1 },
    { features: { similarity: 0 }, label: 0 },
  ]);
  for (const k of FEATURE_KEYS) assert.ok(Math.abs(w[k]) < 10, `${k} exploded to ${w[k]}`);
});

test("it explains itself in words, ranked by actual contribution", () => {
  // A heavily-weighted feature that is ZERO for this pair explains nothing
  // about this pair.
  const why = explainScore({ sharedEntities: 1, captureProximity: 0 }, PRIOR_WEIGHTS);
  assert.match(why, /same people or places/);
  assert.ok(!/captured them close together/.test(why));
});

test("no signal is admitted rather than dressed up", () => {
  assert.equal(explainScore({}, PRIOR_WEIGHTS), "no strong signal");
});

test("the honesty threshold is real", () => {
  assert.ok(MIN_LABELS >= 30, "fitting 8 weights from a handful of labels is memorising");
});
