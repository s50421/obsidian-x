// v4.0 W3 — pure gesture + spring math for the swipe deck. No external
// animation library (per the brief): CSS transforms drive the visuals, this
// module is the tiny bit of physics/threshold logic behind them. Pure
// functions, no DOM/React — testable directly with `npx tsx` or plain node
// after a quick transpile, and reused identically by touch drag + the
// desktop button fallback (buttons just call decideSwipe-equivalent logic
// with a synthetic "full commit" delta).

export type SwipeDir = "left" | "right";

export type Spring1D = { x: number; v: number };

// --- swipe commit thresholds ------------------------------------------------

// Drag past 32% of the card's width commits the swipe even at zero velocity
// (a slow deliberate drag). A fast flick — over COMMIT_VELOCITY px/s in the
// direction of travel — commits regardless of how far the finger has moved,
// which is what makes a quick flick feel instant instead of laggy.
export const COMMIT_DISTANCE_RATIO = 0.32;
export const COMMIT_VELOCITY = 700; // px/s
export const MAX_ROTATION_DEG = 14;
export const MAX_ROTATION_DIVISOR = 6; // full rotation reached at cardWidth/this px of drag

function clamp(n: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, n));
}

// Card tilt while dragging — proportional to horizontal offset, capped at
// MAX_ROTATION_DEG, sign matches drag direction. Reaches max rotation at a
// smaller offset than the commit distance so the card visibly "leans in"
// well before it would actually leave the stack.
export function rotationForDrag(dx: number, cardWidth: number): number {
  if (cardWidth <= 0) return 0;
  const ratio = clamp(dx / (cardWidth / MAX_ROTATION_DIVISOR), -1, 1);
  return ratio * MAX_ROTATION_DEG;
}

// Should this release commit a swipe, and which way? `dx` = total horizontal
// drag in px (signed, right positive); `vx` = instantaneous release velocity
// in px/s (signed); `cardWidth` = the dragged card's rendered width.
// Returns null when the card should spring back to center instead.
export function decideSwipe(dx: number, vx: number, cardWidth: number): SwipeDir | null {
  if (cardWidth <= 0) return null;
  const distanceCommits = Math.abs(dx) > cardWidth * COMMIT_DISTANCE_RATIO;
  // A flick only counts if it's actually moving the same way the card is
  // already leaning (or the drag is ~stationary and the flick alone decides)
  // — guards against a hard tap-and-release micro-jitter reading as a commit.
  const velocityCommits = Math.abs(vx) > COMMIT_VELOCITY && (dx === 0 || Math.sign(vx) === Math.sign(dx));
  if (!distanceCommits && !velocityCommits) return null;
  const dir = dx !== 0 ? dx : vx;
  return dir > 0 ? "right" : "left";
}

// Velocity (px/s) from a short trailing window of {t(ms), x(px)} samples —
// robust to the last-millisecond jitter a single two-point diff would catch.
// Uses the oldest sample still within `windowMs` of the most recent one.
export function velocityFromSamples(samples: { t: number; x: number }[], windowMs = 80): number {
  if (samples.length < 2) return 0;
  const last = samples[samples.length - 1];
  let base = samples[0];
  for (let i = samples.length - 2; i >= 0; i--) {
    base = samples[i];
    if (last.t - samples[i].t >= windowMs) break;
  }
  const dt = last.t - base.t;
  if (dt <= 0) return 0;
  return ((last.x - base.x) / dt) * 1000; // px/s
}

// --- tiny spring (cancel / spring-back only; commits use a CSS fly-off) ---
//
// Critically-damped-ish spring: a = k*(target-x) - c*v. Stepped in an RAF
// loop by the caller; this module owns none of the timing, only the math, so
// it stays pure and cheap to test. Tuned (k=340, c=28) to settle a ~120px
// cancelled drag back to 0 in ~5-6 frames at 60fps — snappy, one soft
// overshoot, no visible bounce-forever.

const STIFFNESS = 340; // 1/s^2-ish
const DAMPING = 28; // 1/s-ish
const REST_DISTANCE = 0.5; // px
const REST_VELOCITY = 20; // px/s
const MAX_STEP_MS = 32; // clamp so a throttled/backgrounded tab can't blow up the integration

export function stepSpring(s: Spring1D, target: number, dtMs: number): Spring1D {
  const dt = Math.min(Math.max(dtMs, 0), MAX_STEP_MS) / 1000;
  const accel = STIFFNESS * (target - s.x) - DAMPING * s.v;
  const v = s.v + accel * dt;
  const x = s.x + v * dt;
  return { x, v };
}

export function springSettled(s: Spring1D, target: number): boolean {
  return Math.abs(target - s.x) < REST_DISTANCE && Math.abs(s.v) < REST_VELOCITY;
}
