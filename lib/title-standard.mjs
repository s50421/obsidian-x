// Obsidian-X v4.0 W2 — the title & curation standard.
//
// SINGLE SOURCE OF TRUTH for the v4.0 title spec, the constrained tag taxonomy,
// the junk heuristics and the mechanical sanitisers. Deliberately written as
// plain ESM JavaScript (no TypeScript syntax) so that BOTH sides can import it
// without a build step:
//
//   • the app  — lib/enrich.ts, lib/ingest-document.ts, lib/proposals.ts
//                (types come from the sibling title-standard.d.mts)
//   • scripts  — scripts/reprocess-corpus.mjs, scripts/retitle-sample.mjs
//                (plain `node`, no bundler)
//
// If the prompt text and the sanitisers ever diverge between the live capture
// path and the corpus re-process, titles drift and KPI #4 ("0 unusable titles
// in a weekly 20-item sample") stops being measurable. Keep them here.

// ---------------------------------------------------------------------------
// Enumerations that must match the items_* CHECK constraints in the database.
// ---------------------------------------------------------------------------
// 'memory' (v4.0.1) — pure recall: a fact, a past event, or context worth
// keeping that implies NO future action. The owner's "things I just want to
// remember, not do" bucket, distinct from an actionable 'task' or lookup
// 'reference'. Kept last so existing type ordering is unchanged.
// The sentinel used when no usable title could be written. Exported so callers
// can DETECT that failure rather than shipping the placeholder onward — a task
// called "Untitled capture" on a real board is worse than no task at all.
export const UNTITLED_TITLE = "Untitled capture";

export const ALLOWED_TYPES = ["note", "task", "idea", "shopping", "reference", "person", "event", "memory"];
export const ALLOWED_PRIORITY = ["low", "medium", "high"];
export const ENTITY_KINDS = ["person", "place", "org", "other"];

// ---------------------------------------------------------------------------
// Title spec constants.
// ---------------------------------------------------------------------------
export const TITLE_MAX = 60;

// LLM self-reported confidence below this routes an item to human review
// (needs_review = true) instead of surfacing it. This is the no-half-baked law
// in numeric form; it is the same 0.55 bar lib/capture-core.ts has always used.
export const CONFIDENCE_BAR = 0.55;

// ---------------------------------------------------------------------------
// Junk scoring — ruthlessness 8 out of 10, expressed as a 0..10 score so the
// dial is a number the owner can turn rather than a prompt rewrite.
//
// v4.0.1 POLICY CHANGE (owner directive): junk is NEVER auto-archived. The
// pipeline decides nothing on the owner's behalf — it only SURFACES junk for a
// human call, with the full note for context.
//
//   score >= 8  ->  wouldArchive = true: KEPT, flagged, shown in the deck with a
//                   "would be junk" badge and the full note, so the owner can
//                   retitle it, reclassify it (e.g. as 'memory'), keep it, or
//                   archive it by hand.
//   score 5..7  ->  KEPT + flagged 'possible-junk'.
//   score <  5  ->  keep, nothing said.
//
// Nothing is ever archived or deleted automatically, at any score.
// ---------------------------------------------------------------------------
export const JUNK_ARCHIVE_SCORE = 8; // the "would be junk" bar (badge only — no auto-archive)
export const JUNK_REVIEW_SCORE = 5; // below the would-be-junk bar but worth a glance

// At or above this confidence, an 8+ score is shown as a firm "would be junk"
// (wouldArchive). Below it the high score is treated as uncertain — still
// surfaced, but as the softer 'possible-junk'. Never triggers an auto-archive.
export const JUNK_CONFIDENCE_BAR = 0.75;

// A capture never splits into more than this many items. A model that claims 14
// topics has misread the note; the first 6 are kept and the item is flagged.
export const MAX_SPLIT_PARTS = 6;

// ---------------------------------------------------------------------------
// The constrained tag taxonomy — 25 topical tags. A model may pick 1-3 of these
// plus AT MOST ONE free-form tag (a proper noun that is the point of the note).
// Anything else is dropped or aliased. Fixed vocabulary is what makes tags
// filterable; the old free-for-all produced 400 one-off tags and zero filters.
// ---------------------------------------------------------------------------
export const TAG_TAXONOMY = [
  // school / university
  "school",
  "university",
  "learning",
  // business / career / money
  "business",
  "marketing",
  "career",
  "finance",
  "investing",
  "legal",
  "admin",
  // life
  "health",
  "fitness",
  "food",
  "family",
  "people",
  "travel",
  "household",
  "real-estate",
  "vehicle",
  // making things
  "tech",
  "projects",
  "creative",
  "writing",
  "media",
  "events",
];

const TAXONOMY_SET = new Set(TAG_TAXONOMY);

// Tags the pipeline owns. They are never produced by the model, are never
// counted against the 1-3 taxonomy budget, and MUST survive a retitle — losing
// 'apple-notes' would break the import deck's source filter.
export const SYSTEM_TAGS = new Set([
  "junk",
  "private",
  "apple-notes",
  "chatgpt-profile",
  "readwise",
  "imported",
]);

// Absorb the handful of near-misses models reliably produce, so a good tag is
// not thrown away for being one synonym off.
const TAG_ALIASES = {
  education: "school",
  classes: "school",
  homework: "school",
  uni: "university",
  college: "university",
  study: "learning",
  studying: "learning",
  course: "learning",
  courses: "learning",
  reading: "learning",
  research: "learning",
  work: "career",
  job: "career",
  jobs: "career",
  interview: "career",
  resume: "career",
  startup: "business",
  company: "business",
  sales: "business",
  clients: "business",
  client: "business",
  strategy: "business",
  ads: "marketing",
  advertising: "marketing",
  brand: "marketing",
  branding: "marketing",
  money: "finance",
  financial: "finance",
  banking: "finance",
  budget: "finance",
  tax: "finance",
  taxes: "finance",
  invest: "investing",
  investment: "investing",
  investments: "investing",
  stocks: "investing",
  trading: "investing",
  law: "legal",
  contract: "legal",
  contracts: "legal",
  visa: "admin",
  paperwork: "admin",
  insurance: "admin",
  healthcare: "health",
  "health-care": "health",
  wellness: "health",
  medical: "health",
  doctor: "health",
  gym: "fitness",
  workout: "fitness",
  training: "fitness",
  running: "fitness",
  cooking: "food",
  recipe: "food",
  recipes: "food",
  restaurant: "food",
  restaurants: "food",
  groceries: "food",
  kids: "family",
  parents: "family",
  friends: "people",
  person: "people",
  contact: "people",
  contacts: "people",
  networking: "people",
  trip: "travel",
  trips: "travel",
  vacation: "travel",
  flights: "travel",
  hotel: "travel",
  home: "household",
  house: "household",
  apartment: "household",
  chores: "household",
  property: "real-estate",
  realestate: "real-estate",
  mortgage: "real-estate",
  car: "vehicle",
  cars: "vehicle",
  auto: "vehicle",
  technology: "tech",
  software: "tech",
  code: "tech",
  coding: "tech",
  programming: "tech",
  ai: "tech",
  project: "projects",
  ideas: "projects",
  building: "projects",
  art: "creative",
  design: "creative",
  music: "creative",
  photography: "creative",
  writings: "writing",
  notes: "writing",
  blog: "writing",
  book: "media",
  books: "media",
  podcast: "media",
  video: "media",
  videos: "media",
  film: "media",
  movies: "media",
  event: "events",
  meeting: "events",
  meetings: "events",
  calendar: "events",
  party: "events",
};

// ---------------------------------------------------------------------------
// Prompt fragments. These are the words the models actually see. Every pipeline
// that writes a title must include TITLE_RULES + TITLE_EXAMPLES + TAG_RULES.
// ---------------------------------------------------------------------------

export const TITLE_RULES = `TITLE RULES — every one of these is a hard requirement:
1. TOPIC-FIRST. Open with WHAT THE CONTENT IS ABOUT. Name the subject (the
   company, the course, the deal, the trip, the person, the decision), then an
   optional " — qualifier" clause. Never open with how the note happens to start.
2. SPECIFIC BEATS GENERIC. "Meeting notes", "Ideas", "Update" are failures. If a
   proper noun or a concrete number is the point of the note, put it in the title.
3. NEVER THE RAW FIRST LINE. Never copy the note's opening sentence, an equation,
   a bullet, a numbered step, a greeting or a salutation into the title.
4. AT MOST ${TITLE_MAX} CHARACTERS, and it must read as a complete phrase — never
   a sentence cut off mid-thought, never trailing "...".
5. SENTENCE CASE. Capitalise the first word and proper nouns only. No ALL-CAPS,
   no Title Case On Every Word.
6. PLAIN TEXT ONLY. No markdown (#, *, backticks, links), no emoji, no hashtags,
   no @mentions (@everyone / @here are never part of a title), no surrounding
   quotes, no trailing period.
7. WRITE FOR A STRANGER scanning a list six months from now. If the title alone
   does not say what the note is about, it is wrong.`;

export const TITLE_EXAMPLES = `TITLE EXAMPLES — bad (what the old system produced) -> good (what you must produce):
  BAD:  "1,200,000 = 0.5 x sell + 0.5 x sell x 0.47"
  GOOD: "Deal payout math — 1.2M split scenario"
  BAD:  "@everyone I hope you're all doing well and enjoying the break"
  GOOD: "Club announcement — break greeting and next steps"
  BAD:  "1. After pressing F9, all of the summary statistics changed slightly"
  GOOD: "Excel recalculation — why F9 shifts the summary stats"
  BAD:  "Best Buy"
  GOOD: "Best Buy case study — position and key issues"
  BAD:  "Notes"
  GOOD: "Zurich apartment search — viewings and budget"
  BAD:  "Call her back about the thing tomorrow"
  GOOD: "Callback to Dr. Weber — reschedule the follow-up"`;

export const TAG_RULES = `TAG RULES:
- Pick 1-3 tags from this FIXED taxonomy, copied exactly, nothing else:
  ${JSON.stringify(TAG_TAXONOMY)}
- You MAY add AT MOST ONE extra free-form tag, and only when a specific proper
  noun IS the subject of the note (e.g. "best-buy", "v-bank", "lisbon").
  lowercase-kebab-case, 24 characters max. If nothing specific stands out, add none.
- Never invent a second free-form tag. Never reword a taxonomy tag.`;

export const TYPE_RULES = `TYPE — pick the single best fit:
- task: something to DO — it names or implies an action or outcome.
- event: something that happens at a specific time.
- shopping: something to buy.
- idea: a proposal or concept to develop later.
- reference: lookup material you will return to — a list, spec, resource, set of
  credentials, or how-to.
- person: the note's subject is a person or contact (who they are, how you know them).
- memory: PURE RECALL — a fact, a past event, or context worth keeping that does
  NOT imply any future action. This is the owner's "I just want to remember this,
  not do anything about it" bucket. Prefer 'memory' over 'note' whenever the note
  is something to remember rather than act on, and over 'task' when an old note
  records that something happened rather than that something must be done.
- note: anything that genuinely fits none of the above.`;

export const CONFIDENCE_RULES = `CONFIDENCE:
- "confidence" is your honest certainty in the WHOLE reading (title + type + tags
  + any split), 0..1.
- Score below ${CONFIDENCE_BAR} whenever the content is ambiguous, fragmentary, or
  you had to guess what it is about. A low score routes the item to human review,
  which is the CORRECT outcome. A confidently wrong title is the worst outcome
  this system can produce.`;

export const SPLIT_RULES = `SPLITTING (multi-topic detection):
- Return ONE item when the note is about one thing, however long or rambling.
- Return SEPARATE items only when the note clearly holds 2 or more DISTINCT
  topics that a person would file in different places — e.g. "buy olive oil" +
  "V-Bank term sheet questions" + "book flights to Lisbon" is 3 items.
- Related sub-points of one subject are NOT separate topics: one meeting's agenda
  bullets are ONE item; a grocery list is ONE item; pros and cons of one decision
  are ONE item.
- BUT FOR TO-DOS THE UNIT IS THE ACTION, NOT THE TOPIC. A task is one thing the
  owner can tick off. Two actions are two tasks even when the REASON is shared —
  sharing a motive does not make them one job.
    "call Jamie and also call Nate Massi, both about my job plans"
      -> TWO tasks: "Call Jamie about job plans" + "Call Nate Massi about job plans".
      NOT one "Call Jamie and Nate" task. He cannot half-tick that, and when he
      has called Jamie the remaining work must still be visible.
    A different PERSON, a different PLACE, or a different DELIVERABLE each make a
    separate action. Same person, same action, several details -> still ONE task
    ("call the bank about the transfer and the statement" is one call).
- Worked example, from a real voice note:
    "I want to call Jamie... also call Nate Massi... both re my job plans... and
     book a rental car for end of August"
  -> THREE items: call Jamie (task), call Nate Massi (task), book rental car
     (task, due end of August). Three actions, three people/things, three ticks.
- Every part gets its OWN topic-first title, type and tags under the rules above.
- Content is conserved: each sentence of the note lands in EXACTLY ONE part.
  Never duplicate a sentence across parts and never drop one.
- NEVER return more than ${MAX_SPLIT_PARTS} parts. If a note seems to have more, you have
  over-split: group the related ones back together.
- Splitting is a claim. If you are not sure the topics are really distinct,
  return ONE item and lower "confidence" — the owner will split it by hand.`;

export const JUNK_RULES = `JUNK SCORE — "junk_score", an integer 0..10, how worthless this note is to its
owner from here on. The owner's ruthlessness setting is ${JUNK_ARCHIVE_SCORE}/10, so
${JUNK_ARCHIVE_SCORE}+ marks it "would be junk" and surfaces it to the owner to decide —
NOTHING is auto-archived. Score honestly; do not round up to tidy up.
  9-10  nothing is there: empty or whitespace, a test string ("test", "asdf"),
        a single stray character or digit, an illegible fragment.
  8     no-prose scratch: unlabelled numbers or half-finished arithmetic, a
        duplicated boilerplate block, an auto-saved draft with no content, a
        bare URL with nothing said about it.
  5-7   you genuinely cannot tell whether this ever mattered. This is the
        HONEST answer whenever you are torn — it keeps the note and asks the
        owner, which is always better than discarding on a guess.
  0-4   there is a fact, a decision, a name, a meaningful number, a reference,
        an instruction or a memory in it. Short is NOT junk. Badly written is
        NOT junk. A one-line phone number is a 0.
- Always write a proper title, even at 10 — a junk-flagged item is still browsed.
- If you score ${JUNK_ARCHIVE_SCORE}+ but are not sure, keep "confidence" below
  ${JUNK_CONFIDENCE_BAR}: that surfaces it as a softer "possible junk" rather than a
  firm "would be junk". Either way the owner, not the pipeline, makes the call.`;

// ---------------------------------------------------------------------------
// Mechanical sanitisers. The prompt asks; these enforce. A model that ignores
// rule 6 still cannot get markdown or an @mention past this function.
// ---------------------------------------------------------------------------

// Pictographs, dingbats, arrows, flags, variation selectors, keycaps. The
// em/en dash block (U+2013..U+2015) is deliberately NOT in range — "Topic —
// qualifier" is the house title style.
const EMOJI_RE =
  /[\u{1F000}-\u{1FAFF}\u{1F1E6}-\u{1F1FF}\u{2190}-\u{21FF}\u{2300}-\u{27BF}\u{2B00}-\u{2BFF}\u{FE00}-\u{FE0F}\u{20E3}\u{200D}]/gu;

const GENERIC_TITLES = new Set([
  "note",
  "notes",
  "new note",
  "untitled",
  "untitled note",
  "no title",
  "idea",
  "ideas",
  "misc",
  "miscellaneous",
  "stuff",
  "things",
  "todo",
  "to do",
  "to-do",
  "list",
  "thoughts",
  "random",
  "document",
  "doc",
  "update",
  "info",
  "draft",
  "test",
  "meeting",
  "meeting notes",
  "summary",
  "reminder",
]);

function str(v) {
  return typeof v === "string" ? v.trim() : "";
}

/**
 * Enforce the mechanical half of the title spec on whatever the model returned.
 * Returns "" when nothing usable survives, so the caller can fall back and flag.
 */
export function cleanTitle(raw) {
  let t = str(raw);
  if (!t) return "";

  // Only ever title from the first line.
  t = t.split(/[\r\n]/)[0];

  // Leading markdown / quoting / list scaffolding, possibly stacked ("> ## 1. ").
  for (let i = 0; i < 4; i++) {
    const before = t;
    t = t
      .replace(/^\s*[>#]+\s*/, "")
      .replace(/^\s*[-*+•·]\s+/, "")
      .replace(/^\s*\(?\d{1,3}[.)]\s+/, "")
      .replace(/^\s*\[[ xX]?\]\s*/, "");
    if (t === before) break;
  }

  t = t
    // markdown links / images -> their text
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
    // emphasis + code fences
    .replace(/[*_~`]+/g, "")
    // @everyone / @here / @channel / @anyone-else — never part of a title
    .replace(/(^|\s)@[A-Za-z0-9._-]+/g, "$1")
    // leading hashtags
    .replace(/(^|\s)#([A-Za-z0-9_-]+)/g, "$1$2")
    .replace(EMOJI_RE, " ")
    // ellipsis of any flavour: a truncated thought is not a title
    .replace(/\.{3,}|…/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  // Surrounding quotes (straight or curly), possibly doubled.
  for (let i = 0; i < 2; i++) {
    const m = t.match(/^["'“”‘’«»](.*)["'“”‘’«»]$/);
    if (!m) break;
    t = m[1].trim();
  }

  // Shouty input -> sentence case (keep short acronyms like "IRS", "Q3").
  const letters = t.replace(/[^A-Za-z]/g, "");
  if (letters.length > 8 && letters === letters.toUpperCase()) {
    t = t
      .toLowerCase()
      .replace(/^([a-z])/, (c) => c.toUpperCase());
  }

  t = truncateAtWord(t, TITLE_MAX);

  // Trailing junk left by any of the above (including a dangling dash).
  t = t.replace(/[\s\-–—,;:.]+$/g, "").trim();

  if (!t) return "";

  // Capitalise the first letter unless it is an intentional lowercase brand
  // ("iPhone", "eBay") — detected by an uppercase later in the same word.
  if (/^[a-z]/.test(t) && !/^[a-z]+[A-Z]/.test(t)) {
    t = t[0].toUpperCase() + t.slice(1);
  }
  return t;
}

function truncateAtWord(s, max) {
  if (s.length <= max) return s;
  const cut = s.slice(0, max);
  const lastSpace = cut.lastIndexOf(" ");
  // Only fall back to a hard cut if there is no sensible word boundary.
  return (lastSpace > max * 0.5 ? cut.slice(0, lastSpace) : cut).trim();
}

function normalizeForCompare(s) {
  return String(s ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9 ]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Which parts of the title spec a candidate still violates AFTER cleanTitle().
 * A non-empty result means the title is not trustworthy: flag needs_review
 * rather than surfacing it (the no-half-baked law).
 */
export function titleQualityIssues(title, body = "") {
  const issues = [];
  const t = str(title);
  if (!t) return ["empty"];
  if (t.length > TITLE_MAX) issues.push("too-long");

  const words = t.match(/[A-Za-z][A-Za-z'’-]*/g) || [];
  const alpha = (t.match(/[A-Za-z]/g) || []).length;
  const nonSpace = t.replace(/\s/g, "").length;

  // "1,200,000 = 0.5 x sell + 0.5 x sell x 0.47" — mostly not language.
  if (words.length < 2 || (nonSpace > 0 && alpha / nonSpace < 0.5)) issues.push("not-prose");
  if (GENERIC_TITLES.has(t.toLowerCase())) issues.push("generic");
  if (/[*_`#]|\]\(/.test(t)) issues.push("markdown");
  if (/(^|\s)@\w/.test(t)) issues.push("mention");
  if (EMOJI_RE.test(t)) issues.push("emoji");

  // Raw-first-line detector: the title is a prefix of how the note opens.
  //
  // Only meaningful when there is substantially MORE note than title. The rule
  // exists to catch a long note lazily titled with its opening fragment — but
  // applied to a one-line capture it rejects the only sensible title there is.
  // Observed in production: "Call Mateo on Sunday." and "Add bananas to the
  // shopping list." both failed here, fell through to the "Untitled capture"
  // placeholder, and were flagged needs-review. A short note IS its own title;
  // titling it that way is correct, not lazy.
  const nt = normalizeForCompare(t);
  const nb = normalizeForCompare(String(body ?? "").split(/[\r\n]/)[0]);
  const bodyIsLongerThanTitle = nb.length >= nt.length * 1.5 && nb.length >= 60;
  if (nt.length >= 18 && bodyIsLongerThanTitle && nb.startsWith(nt)) issues.push("raw-first-line");

  return issues;
}

/** Normalise tags to the constrained taxonomy + at most one free-form tag. */
export function normalizeTags(tags) {
  if (!Array.isArray(tags)) return [];
  const canonical = [];
  const freeform = [];
  for (const raw of tags) {
    const t = String(raw ?? "")
      .toLowerCase()
      .trim()
      .replace(/^#/, "")
      .replace(/[\s_/]+/g, "-")
      .replace(/[^a-z0-9-]/g, "")
      .replace(/-{2,}/g, "-")
      .replace(/^-+|-+$/g, "");
    if (!t) continue;
    const canon = TAXONOMY_SET.has(t) ? t : TAG_ALIASES[t];
    if (canon) {
      if (!canonical.includes(canon)) canonical.push(canon);
    } else if (
      !SYSTEM_TAGS.has(t) &&
      t.length <= 24 &&
      // A free-form tag has to be a NAME. "7" or "2026" is not a filter anyone
      // will ever click, and it is usually a number the model grabbed by mistake.
      /[a-z]/.test(t) &&
      !freeform.includes(t)
    ) {
      freeform.push(t);
    }
  }
  return [...canonical.slice(0, 3), ...freeform.slice(0, 1)];
}

/**
 * Re-tagging must not destroy the tags the pipeline owns (source provenance,
 * 'junk', 'private'). Model tags first, system tags preserved after.
 */
export function mergeTags(existingTags, nextTags) {
  const keep = (Array.isArray(existingTags) ? existingTags : [])
    .map((t) => String(t ?? "").toLowerCase().trim())
    .filter((t) => SYSTEM_TAGS.has(t));
  return [...new Set([...normalizeTags(nextTags), ...keep])].slice(0, 8);
}

// ---------------------------------------------------------------------------
// Junk heuristics — the deterministic half. These are STRUCTURAL only: they
// answer "is there any language in here at all", never "is this interesting".
// The semantic call (ruthlessness 8) belongs to the model; anything this
// function returns null for goes to the model, and anything the model is unsure
// about goes to the human. Nothing is ever deleted — junk is tagged + archived.
// ---------------------------------------------------------------------------

// Strings that are certainly not memories. Digits-only is deliberately NOT in
// here: "0412345678" is a phone number as often as it is a stray keypress, so it
// is scored as numeric-scratch (uncertain) and left to the model or the owner.
const TEST_STRINGS =
  /^(test+|testing|test note|asdf+|qwerty|hello world|lorem ipsum|foo|bar|foobar|x+|\.+|-+)$/i;

const DIGITS_ONLY = /^[\d\s.,:;+\-*/=()]+$/;

export function structuralJunkReason(title, body) {
  const rawTitle = str(title);
  const rawBody = str(body);
  const text = rawBody
    .replace(/[#*_>`~|[\]()-]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  const combined = `${rawTitle} ${text}`.trim();
  const compact = combined.replace(/\s/g, "");

  if (!compact) return "empty";
  // Checked on the body and the title separately as well as together: an
  // imported note usually repeats its first line as its title, so "test" /
  // "test" arrives here as the combined string "test test".
  if (
    [combined, rawBody].some((s) => {
      const n = normalizeForCompare(s);
      return n && TEST_STRINGS.test(n);
    })
  ) {
    return "test-string";
  }
  if (DIGITS_ONLY.test(combined)) return "numeric-scratch";
  if (compact.length < 15) return "too-short";

  const words = text.match(/[A-Za-z][A-Za-z'’]{1,}/g) || [];
  if (words.length < 3) return "no-prose";

  const nonSpace = text.replace(/\s/g, "").length;
  const alpha = (text.match(/[A-Za-z]/g) || []).length;
  if (nonSpace > 0 && alpha / nonSpace < 0.35 && words.length < 12) return "numeric-scratch";

  // A bare link with nothing said about it is not a memory.
  if (/^https?:\/\/\S+$/i.test(rawBody.trim()) && rawTitle.length < 25) return "bare-url";

  return null;
}

// How much each structural verdict is worth on the 0..10 junk scale, and how
// certain we are of it. Only the three verdicts that are TRUE BY INSPECTION
// ("there is no language in here") are certain enough to archive on their own;
// the rest raise the score to the review band and let the model or the owner
// decide.
const STRUCTURAL_JUNK = {
  // Certain: there is provably no language here. Safe to act on with no model.
  empty: { score: 10, certain: true },
  "test-string": { score: 9, certain: true },
  // Not certain: "no prose" is not the same as "no value". An unlabelled
  // formula may be the Best Buy deal math — the vision explicitly wants that
  // titled ("Deal payout math — 1.2M split scenario"), not thrown away. So the
  // structural score only carries these to the review band; the MODEL makes the
  // semantic call and can overrule downwards.
  "no-prose": { score: 8, certain: false },
  "numeric-scratch": { score: 8, certain: false },
  "too-short": { score: 6, certain: false },
  "bare-url": { score: 6, certain: false },
};

/**
 * The deterministic half of the junk score. Runs with no model and no network,
 * so an empty/test/no-prose item can be scored even when the classifier is
 * unavailable. Returns { score, reason, certain }.
 */
export function structuralJunkScore(title, body) {
  const reason = structuralJunkReason(title, body);
  if (!reason) return { score: 0, reason: null, certain: false };
  const s = STRUCTURAL_JUNK[reason] ?? { score: 5, certain: false };
  return { score: s.score, reason, certain: s.certain };
}

function clampScore(n) {
  const v = numOrNaN(n);
  if (Number.isNaN(v)) return NaN;
  return Math.min(10, Math.max(0, Math.round(v)));
}

/**
 * Combine the model's junk call with the structural one into the signal the
 * pipelines surface. v4.0.1: nothing is auto-archived, so this NEVER returns an
 * "archive" verdict.
 *
 *   verdict 'review' + wouldArchive true  -> KEPT + flagged, badged "would be
 *                                            junk", full note shown; owner decides.
 *   verdict 'review' (wouldArchive false) -> KEPT + flagged 'possible-junk'.
 *   verdict 'keep'                         -> nothing said.
 *
 * `wouldArchive` is display-only (the old archive trigger: 8+ AND confident). It
 * changes how the item is badged, never whether it is archived.
 *
 * Who the score comes from:
 *   • a CERTAIN structural verdict (empty / test string) wins outright;
 *   • otherwise the MODEL decides, at its own confidence — the only thing that
 *     can tell a meaningless formula from the deal math;
 *   • with no model (sensitive captures never see one) the structural score
 *     stands but at zero confidence, so it can only ever reach 'review'.
 */
export function scoreJunk({ modelScore = null, modelConfidence = null, title = "", body = "" } = {}) {
  const structural = structuralJunkScore(title, body);
  const model = clampScore(modelScore);
  const hasModel = Number.isFinite(model);

  let score;
  let confidence;
  if (structural.certain) {
    score = Math.max(hasModel ? model : 0, structural.score);
    confidence = 1;
  } else if (hasModel) {
    score = model;
    const c = clamp01(modelConfidence);
    confidence = Number.isFinite(c) ? c : 0;
  } else {
    score = structural.score;
    confidence = 0;
  }

  // Junk is never auto-archived. `wouldArchive` is the firm "would be junk"
  // display signal (the old archive trigger); the acted-on verdict tops out at
  // "review", so the item is always kept and surfaced for the owner to decide.
  const wouldArchive = score >= JUNK_ARCHIVE_SCORE && confidence >= JUNK_CONFIDENCE_BAR;
  const verdict = score >= JUNK_REVIEW_SCORE ? "review" : "keep";

  return { score, confidence, verdict, wouldArchive, structuralReason: structural.reason };
}

/**
 * Enforce the split cap. Returns { parts, capped } — `capped` is true when the
 * model asked for more than MAX_SPLIT_PARTS, which flags the item for review
 * (a 14-topic claim means the note was misread, not that it has 14 topics).
 */
export function capSplitParts(parts) {
  const list = Array.isArray(parts) ? parts : [];
  return { parts: list.slice(0, MAX_SPLIT_PARTS), capped: list.length > MAX_SPLIT_PARTS };
}

// ---------------------------------------------------------------------------
// Shared small helpers (kept here so scripts and app agree byte-for-byte).
// ---------------------------------------------------------------------------

// NaN means "the model said nothing", which is different from "the model said
// zero" — Number(null) and Number("") are both 0, so they are rejected first.
function numOrNaN(n) {
  if (n === null || n === undefined || n === "" || typeof n === "boolean") return NaN;
  const v = Number(n);
  return Number.isFinite(v) ? v : NaN;
}

export function clamp01(n) {
  const v = numOrNaN(n);
  if (Number.isNaN(v)) return NaN;
  return Math.min(1, Math.max(0, v));
}

export function isValidISODate(v) {
  if (typeof v !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(v)) return false;
  const d = new Date(`${v}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return false;
  // Round-trip, or JS silently rolls "2026-02-31" forward to March 3 and the
  // item lands with a due date the note never mentioned.
  return d.toISOString().slice(0, 10) === v;
}

export function sanitizeEntities(v) {
  if (!Array.isArray(v)) return [];
  return v
    .map((e) => {
      const rec = e ?? {};
      const kind = ENTITY_KINDS.includes(String(rec.kind)) ? String(rec.kind) : "other";
      return { name: String(rec.name ?? "").trim().slice(0, 80), kind };
    })
    .filter((e) => e.name)
    .slice(0, 12);
}

export function coerceType(v, fallback = "note") {
  return ALLOWED_TYPES.includes(String(v)) ? String(v) : fallback;
}

export function coercePriority(v, fallback = "medium") {
  return ALLOWED_PRIORITY.includes(String(v)) ? String(v) : fallback;
}

// ---------------------------------------------------------------------------
// LIVE CAPTURE: model reply -> item fields. Pure, so `node` can test it against
// fabricated model output with no network and no database. lib/enrich.ts owns
// the prompt and the HTTP call and delegates the whole mapping to this.
// ---------------------------------------------------------------------------

/**
 * @param parsed         whatever came back from JSON.parse, or null/garbage
 * @param originalText   the raw capture, used as the last-resort body
 * @returns {{items: object[], confidence: number, split: boolean}}
 * NEVER throws. A capture is never lost and a route never 500s because of this.
 */
export function parseEnrichPayload(parsed, originalText) {
  if (!parsed || typeof parsed !== "object") {
    return {
      items: [unreadableItem(originalText, "classifier returned unreadable output")],
      confidence: 0,
      split: false,
    };
  }

  const overall = clamp01(parsed.confidence);
  const rawItems =
    Array.isArray(parsed.items) && parsed.items.length ? parsed.items : [parsed];

  const fallbackConfidence = Number.isFinite(overall) ? overall : 0.6;

  // Split cap: 6 items, hard. A model claiming more topics than that has
  // misread the note, so the overflow is dropped and the capture flagged.
  const { parts: cappedRaw, capped } = capSplitParts(rawItems);

  const items = cappedRaw
    .map((it) => sanitizeEnrichItem(it, originalText, fallbackConfidence))
    .filter((it) => it.body.trim().length > 0);

  let finalItems = items.length
    ? items
    : [unreadableItem(originalText, "classifier returned no usable item")];

  // The capture-level confidence is the WEAKEST part's confidence: if one topic
  // of a split is a guess, the capture as a whole is not trustworthy.
  const confidence = finalItems.reduce(
    (min, it) => Math.min(min, it.confidence ?? fallbackConfidence),
    1
  );

  // SPLIT GATE. A live capture splits DIRECTLY when the reading is confident —
  // the evening swipe deck is the approval gate, so capture stays
  // zero-decision. When it is not confident, splitting would manufacture N
  // half-right memories out of one honest note, so the capture collapses back
  // to a single flagged item and the owner splits it in the deck. (The corpus
  // re-process never lands here: it proposes splits rather than writing them.)
  if (finalItems.length > 1 && confidence < CONFIDENCE_BAR) {
    finalItems = [collapsedSplit(finalItems, originalText, confidence)];
  } else if (capped) {
    finalItems = finalItems.map((it, i) =>
      i === 0
        ? {
            ...it,
            needs_review: true,
            review_reason:
              it.review_reason ??
              `capture split into more than ${MAX_SPLIT_PARTS} topics — extra topics were dropped, check the original`,
          }
        : it
    );
  }

  return { items: finalItems, confidence, split: finalItems.length > 1 };
}

// The last-resort item: keep the capture verbatim, title it as well as the
// mechanical rules allow, and flag it. Never silently surfaced.
function unreadableItem(originalText, reason) {
  const body = String(originalText ?? "").trim();
  const derived = cleanTitle(body.split("\n")[0]);
  const usable = derived && !titleQualityIssues(derived, body).length;
  // No model reading survived, so only the structural (deterministic) half of
  // the junk score applies — an empty or test-string capture is still junk.
  const junk = scoreJunk({ modelScore: null, title: usable ? derived : "", body });
  return {
    title: usable ? derived : UNTITLED_TITLE,
    type: "note",
    body,
    tags: [],
    priority: "medium",
    due_date: null,
    entities: [],
    confidence: 0,
    needs_review: true,
    review_reason: reason,
    junk_score: junk.score,
    junk_verdict: junk.verdict,
    junk_reason: junk.structuralReason,
  };
}

/**
 * An uncertain multi-topic reading, folded back into one item. The whole
 * original text is kept (nothing is lost), the most confident part's title is
 * reused as a starting point, and the item is flagged so the deck offers a
 * manual split.
 */
function collapsedSplit(items, originalText, confidence) {
  const best = items.reduce((a, b) => ((b.confidence ?? 0) > (a.confidence ?? 0) ? b : a));
  const tags = [...new Set(items.flatMap((i) => i.tags))].slice(0, 4);
  const entities = items.flatMap((i) => i.entities).slice(0, 12);
  const body = String(originalText ?? "").trim();
  const junk = scoreJunk({ modelScore: null, title: best.title, body });
  return {
    title: best.title,
    type: best.type,
    body,
    tags,
    priority: best.priority,
    due_date: items.find((i) => i.due_date)?.due_date ?? null,
    entities,
    confidence,
    needs_review: true,
    review_reason: `looks like ${items.length} topics but the reading is uncertain — kept whole, split it here if it is`,
    junk_score: junk.score,
    junk_verdict: junk.verdict, // never 'archive' since v4.0.1 — junk is surfaced, not acted on
    junk_reason: junk.structuralReason,
  };
}

function sanitizeEnrichItem(it, fallbackText, fallbackConfidence) {
  const rec = it ?? {};
  const body = str(rec.body) || String(fallbackText ?? "").trim();

  const perItem = clamp01(rec.confidence);
  let confidence = Number.isFinite(perItem) ? perItem : fallbackConfidence;

  // Title: the model's, mechanically enforced. If nothing usable survives, fall
  // back to the note's own opening line — but ONLY flagged, and only when even
  // that passes the spec. Otherwise it is honestly labelled untitled.
  let title = cleanTitle(rec.title);
  let reviewReason = null;

  let issues = title ? titleQualityIssues(title, body) : ["empty"];
  if (issues.length) {
    const derived = cleanTitle(body.split("\n")[0]);
    const derivedIssues = derived ? titleQualityIssues(derived, body) : ["empty"];
    if (!derivedIssues.length) {
      title = derived;
      issues = [];
      reviewReason = "auto-title fell back to the note's own wording — confirm it";
    } else {
      title = UNTITLED_TITLE;
      reviewReason = "no usable title could be written — please retitle";
    }
    // A title we had to rescue is not a title we trust.
    confidence = Math.min(confidence, 0.5);
  }

  const belowBar = confidence < CONFIDENCE_BAR;
  if (belowBar && !reviewReason) reviewReason = "low classification confidence — please confirm";

  // Junk pass (v4.0.1: surfaced, never auto-archived). A would-be-junk item is
  // flagged with a clear reason and its full note; the owner decides in the deck.
  const junk = scoreJunk({
    modelScore: rec.junk_score,
    modelConfidence: confidence,
    title,
    body,
  });
  if (junk.verdict === "review" && !reviewReason) {
    reviewReason = junk.wouldArchive ? "would be junk — your call" : "possible-junk";
  }

  return {
    title,
    type: coerceType(rec.type),
    body,
    tags: normalizeTags(rec.tags),
    priority: coercePriority(rec.priority),
    due_date: isValidISODate(rec.due_date) ? String(rec.due_date) : null,
    entities: sanitizeEntities(rec.entities),
    confidence,
    needs_review: belowBar || !!reviewReason,
    review_reason: reviewReason,
    junk_score: junk.score,
    junk_verdict: junk.verdict,
    junk_reason: str(rec.junk_reason) || junk.structuralReason,
  };
}

// ---------------------------------------------------------------------------
// The corpus re-process prompt (scripts/reprocess-corpus.mjs and
// scripts/retitle-sample.mjs share it, so the sample harness David approves is
// literally the prompt the full run uses).
// ---------------------------------------------------------------------------

export function buildReprocessSystem(todayISO) {
  return [
    `You are re-processing an ALREADY CAPTURED note in a personal knowledge base.`,
    `Today is ${todayISO}. These notes are a historical archive: do NOT invent due`,
    `dates, and only report one if the note itself names an explicit calendar date.`,
    ``,
    `Return ONLY a JSON object:`,
    `{`,
    `  "junk_score": integer 0..10 (see JUNK SCORE),`,
    `  "junk_reason": short string when junk_score >= ${JUNK_REVIEW_SCORE}, else null,`,
    `  "confidence": number 0..1,`,
    `  "title": the new topic-first title (still required at any junk score),`,
    `  "type": one of ${JSON.stringify(ALLOWED_TYPES)},`,
    `  "tags": array of tags per the TAG RULES,`,
    `  "due_date": "YYYY-MM-DD" or null,`,
    `  "entities": [ {"name": string, "kind": one of ${JSON.stringify(ENTITY_KINDS)}} ],`,
    `  "reason": one short sentence explaining your reading, shown to the owner,`,
    `  "split": null, OR an array of 2..${MAX_SPLIT_PARTS} parts when the note holds distinct topics:`,
    `           [ {"title": string, "body": string, "type": string, "tags": [string]} ]`,
    `}`,
    ``,
    TITLE_RULES,
    ``,
    TITLE_EXAMPLES,
    ``,
    TYPE_RULES,
    ``,
    TAG_RULES,
    ``,
    SPLIT_RULES,
    ``,
    JUNK_RULES,
    ``,
    CONFIDENCE_RULES,
  ].join("\n");
}

// ---------------------------------------------------------------------------
// Proposal payloads. The W3 swipe deck reads these EXACT keys (the contract is
// typed as RetitlePayload / SplitPayload in lib/proposals.ts, which is also
// where applyProposal consumes them). Built here so the script that writes them
// and the tests that check them cannot drift from each other.
// ---------------------------------------------------------------------------

export function buildRetitlePayload(item, verdict) {
  return {
    itemId: item.id,
    oldTitle: item.title ?? null,
    newTitle: verdict.title,
    newType: verdict.type,
    newTags: verdict.tags,
    dueAt: verdict.dueDate,
    entities: verdict.entities,
    confidence: verdict.confidence,
    reason: verdict.reason ?? "Re-titled to the v4.0 standard",
    junkScore: verdict.junkScore,
    junkReason: verdict.junkReason ?? null,
  };
}

export function buildSplitPayload(item, verdict) {
  return {
    itemId: item.id,
    oldTitle: item.title ?? null,
    parts: verdict.parts,
    confidence: verdict.confidence,
    reason: verdict.reason ?? `Holds ${verdict.parts.length} distinct topics`,
    junkScore: verdict.junkScore,
    junkReason: verdict.junkReason ?? null,
  };
}

/**
 * Parse + sanitise a re-process model reply into the shape both scripts use.
 * NEVER throws: a malformed reply degrades to a low-confidence "needs a human"
 * verdict rather than failing the run.
 */
export function parseReprocessReply(parsed, item) {
  const p = parsed && typeof parsed === "object" ? parsed : {};
  const body = String(item?.body ?? "");
  const oldTitle = String(item?.title ?? "");

  let confidence = clamp01(p.confidence);
  if (!Number.isFinite(confidence)) confidence = 0.4; // unscored == unsure

  const title = cleanTitle(p.title);
  const issues = title ? titleQualityIssues(title, body) : ["empty"];
  // A title that still breaks the spec after cleaning cannot be trusted, no
  // matter how confident the model claims to be.
  if (issues.length) confidence = Math.min(confidence, 0.5);

  const rawParts = Array.isArray(p.split) ? p.split : [];
  const usableParts = rawParts
    .map((raw) => {
      const r = raw ?? {};
      const partBody = str(r.body);
      const partTitle = cleanTitle(r.title);
      if (!partBody || !partTitle) return null;
      return {
        title: partTitle,
        body: partBody,
        type: coerceType(r.type),
        tags: normalizeTags(r.tags),
      };
    })
    .filter(Boolean);

  // A "split" of fewer than 2 usable parts is not a split. More than the cap is
  // a misreading: keep the first MAX_SPLIT_PARTS and say so.
  const { parts: capped, capped: wasCapped } = capSplitParts(usableParts);
  const parts = usableParts.length >= 2 ? capped : [];

  const junk = scoreJunk({
    modelScore: p.junk_score,
    modelConfidence: confidence,
    title: oldTitle,
    body,
  });

  return {
    junkScore: junk.score,
    junkVerdict: junk.verdict,
    junkReason: str(p.junk_reason) || junk.structuralReason || null,
    confidence,
    title,
    titleIssues: issues,
    type: coerceType(p.type),
    tags: normalizeTags(p.tags),
    dueDate: isValidISODate(p.due_date) ? p.due_date : null,
    entities: sanitizeEntities(p.entities),
    reason: str(p.reason) || null,
    parts,
    splitCapped: wasCapped,
    oldTitle,
  };
}
