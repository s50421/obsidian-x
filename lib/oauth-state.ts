// Obsidian-X v4.1 — OAuth `state` handling for the Google connect flow.
//
// Extracted and tested because this failed silently in production once: the
// state carries which OAuth client started the flow ("workspace" | "personal"),
// and once a ":" separator went into a COOKIE value it came back percent-
// encoded ("workspace%3A<uuid>"). Compared raw against Google's already-decoded
// `state` query param it could never match, so every connection attempt died
// with "state mismatch" and the owner just saw a button that did nothing.
//
// Two defences now:
//   1. the separator is "." — encodeURIComponent leaves it alone
//   2. the comparison is tolerant of one side still being encoded

export type StateApp = "workspace" | "personal";

const SEP = ".";

export function makeState(app: StateApp, nonce: string): string {
  return `${app}${SEP}${nonce}`;
}

/** Which OAuth client began this flow? Defaults to workspace on anything odd. */
export function appFromState(state: string | null | undefined): StateApp {
  const head = (state ?? "").split(SEP)[0];
  return head === "personal" ? "personal" : "workspace";
}

function normalize(v: string): string {
  // A value may arrive percent-encoded (cookie layer) or not (query param).
  // decodeURIComponent throws on malformed input — fall back to the raw value.
  try {
    return decodeURIComponent(v);
  } catch {
    return v;
  }
}

/**
 * Constant-format CSRF comparison. Both sides are normalized so an encoding
 * difference introduced by any layer can't produce a false mismatch, while a
 * genuinely different value still fails.
 */
export function statesMatch(
  fromQuery: string | null | undefined,
  fromCookie: string | null | undefined
): boolean {
  if (!fromQuery || !fromCookie) return false;
  return normalize(fromQuery) === normalize(fromCookie);
}
