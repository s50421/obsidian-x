import { timingSafeEqual } from "node:crypto";

// Constant-time secret comparison.
//
// Every shared-secret check in the app now goes through this. A plain `===` on
// a token leaks its contents through response timing: the comparison bails at
// the first differing byte, so an attacker can recover the secret one character
// at a time by measuring which guesses take marginally longer.
//
// Over the public internet the per-byte signal is small and noisy — this is not
// the most likely way in. But the fix costs nothing, the endpoints it guards can
// read personal data, and "an attacker would need many samples" is a weak thing
// to be relying on when the alternative is three lines. The ClickUp webhook has
// compared its HMAC this way since v2.2; this brings the rest in line.

/**
 * True when `a` and `b` are identical, taking the same time regardless of where
 * they first differ. Length is compared first (unavoidable — the lengths differ
 * observably anyway) and a mismatch short-circuits, which leaks only the length
 * of the secret, not its contents.
 */
export function secureEquals(a: string | null | undefined, b: string | null | undefined): boolean {
  if (!a || !b) return false;
  const ba = Buffer.from(a, "utf8");
  const bb = Buffer.from(b, "utf8");
  if (ba.length !== bb.length) return false;
  return timingSafeEqual(ba, bb);
}

/**
 * Extract a bearer token from an Authorization header and compare it in
 * constant time.
 */
export function bearerEquals(header: string | null | undefined, secret: string | undefined): boolean {
  if (!secret) return false;
  const h = header ?? "";
  if (!h.startsWith("Bearer ")) return false;
  return secureEquals(h.slice(7), secret);
}
