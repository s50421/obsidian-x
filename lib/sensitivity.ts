// Local, no-cloud detection of sensitive captures. An explicit marker
// (!private / #private / !sensitive / #sensitive) or an obvious secret-bearing
// keyword flags a capture so it skips the third-party LLM (OpenRouter).

const MARKER = /[!#](?:private|sensitive)\b/i;
const MARKER_GLOBAL = /[!#](?:private|sensitive)\b/gi;
const KEYWORDS =
  /\b(?:password|passphrase|ssn|social security(?: number)?|credit card|cvv|bank account|routing number|api key|secret key|private key|seed phrase)\b/i;

export function detectSensitive(input: string): { sensitive: boolean; text: string } {
  const hasMarker = MARKER.test(input);
  const hasKeyword = KEYWORDS.test(input);
  // Strip every marker occurrence (subject + body can each carry one) and tidy whitespace.
  const stripped = input.replace(MARKER_GLOBAL, "").replace(/[ \t]{2,}/g, " ").trim();
  const text = (hasMarker ? stripped : input) || input;
  return { sensitive: hasMarker || hasKeyword, text };
}
