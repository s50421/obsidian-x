import type { SupabaseClient } from "@supabase/supabase-js";
import { getSettingValue, setSettingValue } from "@/lib/tz";
import { FEATURE_KEYS, FEATURE_LABEL, type LinkFeatures } from "@/lib/link-features";

// Obsidian-X — the learning loop for connections.
//
// Logistic regression over the eight features in link-features.ts, fitted from
// the owner's own Link / Not-related decisions. Deliberately NOT a neural model
// (owner decision 2026-08-02, reasoning in PROJECT-STATE): 23 items is 253
// possible pairs in total, which is orders of magnitude short of what a network
// needs, while this converges from ~50 labels.
//
// Two properties matter more than accuracy here:
//
//   EXPLAINABLE. Weights are per named feature, so a score decomposes into
//   "mostly because they mention the same people". A network gives a number and
//   the connection can no longer say why it exists — which is the one property
//   that fixed this feature in the first place.
//
//   HONEST WHEN UNTRAINED. Below the label threshold the priors are used and
//   the system SAYS it is using priors. A model quietly pretending to have
//   learned something is the no-half-baked law being broken.

export const MODEL_KEY = "link_model";

/**
 * Enough labels to fit eight weights without simply memorising the sample.
 *
 * Roughly 6 examples per feature. Below this the priors are better than
 * anything fitted, and pretending otherwise would be worse than both.
 */
export const MIN_LABELS = 40;

export type Weights = Record<keyof LinkFeatures, number> & { bias: number };

/**
 * Starting weights, set by hand from what the corpus already showed.
 *
 * Shared entities lead because those are the connections that survived the
 * owner's review; similarity is mid because it produced the right clusters only
 * after switching to mutual rank; capture proximity is near zero on purpose —
 * "arrived in the same braindump" was the provenance signal explicitly rejected
 * as a connection kind, and it starts out earning almost nothing.
 */
export const PRIOR_WEIGHTS: Weights = {
  similarity: 1.6,
  sharedEntities: 2.4,
  tagOverlap: 0.4,
  sameTask: 2.0,
  dueProximity: 0.6,
  lexicalOverlap: 1.2,
  captureProximity: 0.1,
  sameType: 0.3,
  bias: -1.8,
};

export type ModelState = {
  weights: Weights;
  /** True once fitted from real decisions rather than the priors. */
  trained: boolean;
  labels: number;
  positives: number;
  fittedAt: string | null;
  /** Share of labels the fitted model gets right, on the data it was fitted on. */
  accuracy: number | null;
};

export const UNTRAINED: ModelState = {
  weights: PRIOR_WEIGHTS,
  trained: false,
  labels: 0,
  positives: 0,
  fittedAt: null,
  accuracy: null,
};

const sigmoid = (z: number) => 1 / (1 + Math.exp(-z));

export function scoreLink(f: Partial<LinkFeatures>, w: Weights): number {
  let z = w.bias;
  for (const k of FEATURE_KEYS) z += (f[k] ?? 0) * w[k];
  return sigmoid(z);
}

/**
 * Why this pair scored the way it did, in plain words.
 *
 * Ranks features by their actual contribution (value x weight) rather than by
 * weight alone — a heavily-weighted feature that is zero for this pair explains
 * nothing about it.
 */
export function explainScore(f: Partial<LinkFeatures>, w: Weights, top = 2): string {
  const parts = FEATURE_KEYS.map((k) => ({ k, c: (f[k] ?? 0) * w[k] }))
    .filter((p) => p.c > 0.05)
    .sort((a, b) => b.c - a.c)
    .slice(0, top);
  if (!parts.length) return "no strong signal";
  return parts.map((p) => FEATURE_LABEL[p.k]).join(", and ");
}

export type Sample = { features: Partial<LinkFeatures>; label: 0 | 1 };

/**
 * Fit by gradient descent. Small, dependency-free, and deterministic.
 *
 * L2 regularisation is doing real work at this scale: with a few dozen samples
 * an unregularised fit will happily drive one weight to a huge value on the
 * strength of a handful of examples, and the resulting model swings wildly the
 * next time it is refitted.
 */
export function fitWeights(
  samples: Sample[],
  opts: { epochs?: number; lr?: number; l2?: number } = {}
): Weights {
  const { epochs = 600, lr = 0.35, l2 = 0.02 } = opts;
  const w: Weights = { ...PRIOR_WEIGHTS };
  if (!samples.length) return w;

  for (let e = 0; e < epochs; e++) {
    const grad: Record<string, number> = { bias: 0 };
    for (const k of FEATURE_KEYS) grad[k] = 0;

    for (const s of samples) {
      const p = scoreLink(s.features, w);
      const err = p - s.label;
      grad.bias += err;
      for (const k of FEATURE_KEYS) grad[k] += err * (s.features[k] ?? 0);
    }

    const n = samples.length;
    w.bias -= (lr * grad.bias) / n;
    for (const k of FEATURE_KEYS) {
      w[k] -= (lr * (grad[k] / n + l2 * w[k]));
    }
  }
  return w;
}

export function accuracyOf(samples: Sample[], w: Weights): number {
  if (!samples.length) return 0;
  let ok = 0;
  for (const s of samples) if ((scoreLink(s.features, w) >= 0.5 ? 1 : 0) === s.label) ok += 1;
  return ok / samples.length;
}

export async function loadModel(admin: SupabaseClient, userId: string): Promise<ModelState> {
  const v = await getSettingValue<ModelState>(admin, userId, MODEL_KEY);
  if (!v?.weights) return UNTRAINED;
  // Defend against a stored model from an older feature set — a missing weight
  // would silently read as undefined and poison every score.
  const weights = { ...PRIOR_WEIGHTS, ...v.weights };
  return { ...UNTRAINED, ...v, weights };
}

/**
 * Gather every decision the owner has made and refit.
 *
 * The dataset is simply `edges` rows that carry features and have been ruled on:
 * confirmed = 1, dismissed = 0. Suggestions still awaiting a verdict are not
 * labels and are excluded.
 */
export async function refitModel(
  admin: SupabaseClient,
  userId: string
): Promise<ModelState> {
  const { data } = await admin
    .from("edges")
    .select("features,status")
    .eq("user_id", userId)
    .in("status", ["confirmed", "dismissed"])
    .limit(10000);

  const samples: Sample[] = [];
  for (const r of data ?? []) {
    const f = (r.features ?? {}) as Partial<LinkFeatures>;
    if (!Object.keys(f).length) continue;
    samples.push({ features: f, label: r.status === "confirmed" ? 1 : 0 });
  }

  const positives = samples.filter((s) => s.label === 1).length;
  const negatives = samples.length - positives;

  // Both classes are required. Fitting on all-yes teaches "say yes to
  // everything", which is worse than the priors and looks like learning.
  if (samples.length < MIN_LABELS || positives < 5 || negatives < 5) {
    const state: ModelState = {
      ...UNTRAINED,
      labels: samples.length,
      positives,
    };
    await setSettingValue(admin, userId, MODEL_KEY, state);
    return state;
  }

  const weights = fitWeights(samples);
  const state: ModelState = {
    weights,
    trained: true,
    labels: samples.length,
    positives,
    fittedAt: new Date().toISOString(),
    accuracy: accuracyOf(samples, weights),
  };
  await setSettingValue(admin, userId, MODEL_KEY, state);
  return state;
}
