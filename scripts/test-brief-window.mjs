// Obsidian-X — the morning letter's delivery window.
//
//   node --experimental-strip-types --no-warnings scripts/test-brief-window.mjs
//
// This exists because of a real miss. On 2026-07-30 no letter arrived at all.
// The window was 06:15-07:15 local — sixty minutes — chosen on the assumption
// that the GitHub Actions pinger fires every 15 minutes as its cron expression
// requests. It does not: GitHub deprioritises scheduled workflows on the free
// tier, and the gaps observed in production were 1h40m to 3h25m. That morning
// the ticks landed at 05:54 and 08:06 local and the entire window fell in the
// gap between them, so the send silently never happened.
//
// The fix is a FLOOR plus a late backstop rather than a narrow slot. These
// tests pin that down using the ACTUAL tick times from the failing day, so a
// future tightening of the window has to argue with the evidence.

import assert from "node:assert/strict";
import { register } from "node:module";
import test from "node:test";

register(new URL("./_alias-hook.mjs", import.meta.url), import.meta.url);

const { isWithinBriefWindow, BRIEF_WINDOW_START, BRIEF_WINDOW_END } = await import("../lib/tz.ts");

// Real pinger runs on 2026-07-30 (UTC), converted to America/Vancouver (UTC-7).
const REAL_TICKS_LOCAL = [
  "17:01", // 00:01Z (previous evening)
  "20:26", // 03:26Z
  "23:05", // 06:05Z
  "01:47", // 08:47Z
  "04:02", // 11:02Z
  "05:54", // 12:54Z  <- last tick BEFORE the old window
  "08:06", // 15:06Z  <- first tick AFTER it. The 60-min window fell in this gap.
  "09:47", // 16:47Z
];

test("the window is a floor plus a late backstop, not a narrow slot", () => {
  assert.equal(BRIEF_WINDOW_START, "06:15");
  const [h] = BRIEF_WINDOW_END.split(":").map(Number);
  assert.ok(
    h >= 10,
    `the backstop must outlast the pinger's ~3h gaps (got ${BRIEF_WINDOW_END})`
  );
});

test("REGRESSION: the 2026-07-30 tick pattern now delivers", () => {
  const hits = REAL_TICKS_LOCAL.filter((t) => isWithinBriefWindow(t));
  assert.ok(
    hits.length > 0,
    "at least one real tick must land in the window — this is exactly what failed"
  );
  assert.ok(hits.includes("08:06"), "the 08:06 tick is the one that should have carried it");
});

test("the OLD 60-minute window would still miss that day — the fix is load-bearing", () => {
  const hits = REAL_TICKS_LOCAL.filter((t) => isWithinBriefWindow(t, "06:15", "07:15"));
  assert.equal(hits.length, 0, "proves the miss was the window, not the cron");
});

test("nothing sends before the floor — no 3am letters", () => {
  for (const t of ["00:01", "04:02", "05:54", "06:14"]) {
    assert.equal(isWithinBriefWindow(t), false, `${t} must not send`);
  }
  assert.equal(isWithinBriefWindow("06:15"), true, "the floor itself is inclusive");
});

test("nothing sends after the backstop — a 'morning' letter at 9pm is worse than none", () => {
  for (const t of ["11:01", "14:00", "17:01", "20:26", "23:05"]) {
    assert.equal(isWithinBriefWindow(t), false, `${t} must not send`);
  }
  assert.equal(isWithinBriefWindow("11:00"), true, "the backstop itself is inclusive");
});

test("a 3h25m gap — the worst observed — still cannot straddle the window", () => {
  const WORST_GAP_MIN = 205;
  const toMin = (s) => {
    const [h, m] = s.split(":").map(Number);
    return h * 60 + m;
  };
  const width = toMin(BRIEF_WINDOW_END) - toMin(BRIEF_WINDOW_START);
  assert.ok(
    width > WORST_GAP_MIN,
    `window is ${width}min but gaps reach ${WORST_GAP_MIN}min — it can still be skipped`
  );
});

test("every possible tick minute of the day is classified without throwing", () => {
  let inCount = 0;
  for (let m = 0; m < 24 * 60; m++) {
    const hhmm = `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
    if (isWithinBriefWindow(hhmm)) inCount++;
  }
  assert.equal(inCount, 286, "06:15..11:00 inclusive");
});

// ---------------------------------------------------------------------------
// Timezone inference must not treat a serialisation artifact as a location.

const { isUtcLike } = await import("../lib/tz.ts");

test("UTC-like TZIDs are rejected as home-timezone signals", () => {
  for (const t of ["UTC", "utc", "Etc/UTC", "GMT", "Etc/GMT", "Z", "Zulu", "Etc/GMT+5", "Etc/GMT-11"]) {
    assert.equal(isUtcLike(t), true, `${t} must not count as where the owner lives`);
  }
});

test("real home timezones are still accepted", () => {
  for (const t of ["America/Vancouver", "Europe/Berlin", "Asia/Kolkata", "Australia/Sydney", "America/Sao_Paulo"]) {
    assert.equal(isUtcLike(t), false, `${t} is a real place and must count`);
  }
});
