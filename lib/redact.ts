// Obsidian-X v4.2.2 (letter refinement) — keep one-time secrets out of Telegram.
//
// Owner directive (2026-08-02): "verification codes should never be sent
// through telegram." A digest had echoed a live Crypto.com code (763264) into
// the chat, where it sits in scroll history and notification previews.
//
// This is applied at the SEND choke point rather than at each call site, so a
// future feature can't forget it. There is exactly one way text reaches the
// owner's phone, and it goes through here.
//
// THE HARD PART IS NOT OVER-REDACTING. The same letter legitimately carried a
// proxy-voting control number (515881901124) the owner needed, and there are
// order numbers, invoice references, amounts and dates everywhere. So this is
// deliberately KEYWORD-ANCHORED: a bare number is never touched. A number is
// only redacted when the surrounding words say it is a credential.

const PLACEHOLDER = "[code hidden]";

/** Words that mean "the number next to me is a one-time secret". */
const CODE_WORDS =
  "verification|security|authentication|authorisation|authorization|confirmation|one[- ]?time|login|log[- ]?in|access|sign[- ]?in|passcode|pass[- ]?code|otp|2fa|mfa";

const PATTERNS: RegExp[] = [
  // "verification code (763264)", "security code: 123456", "OTP 4821", and —
  // the case that slipped through first time — "your code WAS 763264". A
  // linking verb or a short parenthetical can sit between the keyword and the
  // number, so allow a bounded gap rather than enumerating verbs. 30 characters
  // is wide enough for "code was"/"code is currently" and far too narrow to
  // reach an unrelated number later in the sentence.
  new RegExp(`\\b(?:${CODE_WORDS})\\b(?:\\s+(?:code|pin|number|password))?[^\\d]{0,30}?(\\d{4,10})\\b`, "gi"),
  // "code is 763264", "code was 763264", "code: 763264", "code 763264"
  /\b(?:code|pin)\b[^\d]{0,20}?(\d{4,10})\b/gi,
  // "763264 is your verification code" — the number leads.
  new RegExp(`\\b(\\d{4,10})\\b(?=[^.\\n]{0,24}\\b(?:${CODE_WORDS})\\b)`, "gi"),
  // "G-123456" (Google's format) and similar prefixed one-time codes.
  /\b([A-Z]-\d{5,8})\b/g,
];

/**
 * Replace one-time codes with a placeholder. Returns the text and whether
 * anything was removed, so the caller can log that a redaction happened
 * without logging what was redacted.
 */
export function redactCodes(text: string): { text: string; redacted: boolean } {
  if (!text) return { text, redacted: false };
  let out = text;
  let hit = false;

  for (const re of PATTERNS) {
    out = out.replace(re, (match, captured: string) => {
      // Don't touch a year, and don't touch something that's clearly a
      // 4-digit ordinal in prose. 4-digit codes are the risky class; require
      // the keyword anchor to have matched (it did, to reach here).
      if (/^(19|20)\d{2}$/.test(captured)) return match;
      hit = true;
      return match.replace(captured, PLACEHOLDER);
    });
  }
  return { text: out, redacted: hit };
}

/** True when the text looks like it carries a one-time credential. */
export function containsCode(text: string): boolean {
  return redactCodes(text).redacted;
}

/**
 * Is this message ABOUT delivering a one-time code?
 *
 * Deliberately narrower than `containsCode`, and the distinction is not
 * academic: Crypto.com stamps "Anti-phishing Code: 81925" into the footer of
 * every marketing email it sends. Treating "contains a code" as "is a code
 * message" therefore capped an entire sender's mail — including, on the same
 * day, a genuine "[NOTICE] You Added a Passkey" security alert that only
 * escaped because the snippet happened to be truncated before the footer.
 * Suppressing a security alert is a far worse failure than ranking a dead code
 * too highly, so this reads the SUBJECT only: what a message is about is stated
 * there, not in whatever boilerplate trails the body.
 *
 * Redaction is unaffected and stays maximally eager — an anti-phishing code
 * should still never be echoed into Telegram.
 */
const CODE_SUBJECT = new RegExp(`\\b(?:${CODE_WORDS})\\b[\\s-]*\\b(?:code|pin|passcode)\\b|\\b(?:otp|2fa|mfa|passcode)\\b`, "i");

export function isCodeDelivery(subject: string): boolean {
  const s = subject ?? "";
  if (!s.trim()) return false;
  return CODE_SUBJECT.test(s) || containsCode(s);
}
