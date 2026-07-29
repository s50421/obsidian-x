// v4.0 W3 — pure local-day boundary math for the swipe deck. No Next.js /
// Supabase imports here on purpose: this is the piece the daily-deck query
// (app/api/deck/route.ts) and the evening nudge cron both need "today, in the
// owner's timezone" for, and it's exactly the kind of date-math that's worth
// keeping isolated and node-testable (`npx tsx` against this file directly).
// lib/tz.ts (owned by W4) gives us `localDateStr`/`localHHMM` — a local date
// string and a wall-clock reading — but no date-string -> UTC-instant
// resolver, so that one small piece lives here.

function partsInTz(tz: string, at: Date) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).formatToParts(at);
  const g = (t: string) => Number(parts.find((p) => p.type === t)?.value ?? 0);
  return { y: g("year"), mo: g("month"), d: g("day"), h: g("hour"), mi: g("minute"), s: g("second") };
}

// UTC ms for the instant that reads as (y,mo,d,h,mi,s) in `tz`. Converges in
// at most 2 iterations for any real-world zone (including half-hour offsets
// and DST transitions that don't land exactly on the requested wall-clock time).
export function localWallClockToUtcMs(
  tz: string,
  y: number,
  mo: number,
  d: number,
  h = 0,
  mi = 0,
  s = 0
): number {
  let guess = Date.UTC(y, mo - 1, d, h, mi, s);
  for (let i = 0; i < 2; i++) {
    const p = partsInTz(tz, new Date(guess));
    const asUtc = Date.UTC(p.y, p.mo - 1, p.d, p.h, p.mi, p.s);
    const target = Date.UTC(y, mo - 1, d, h, mi, s);
    guess -= asUtc - target;
  }
  return guess;
}

export function addDaysToDateStr(dateStr: string, n: number): string {
  const [y, m, d] = dateStr.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d + n));
  return `${dt.getUTCFullYear()}-${String(dt.getUTCMonth() + 1).padStart(2, "0")}-${String(dt.getUTCDate()).padStart(2, "0")}`;
}

// [start, end) UTC-instant ISO strings spanning the owner-local calendar date
// `dateStr` (YYYY-MM-DD) in timezone `tz` — midnight-to-midnight local time,
// expressed as UTC so it drops straight into a `created_at >= start AND <
// end` query.
export function localDayBoundsUtc(tz: string, dateStr: string): { start: string; end: string } {
  const [y, m, d] = dateStr.split("-").map(Number);
  const startMs = localWallClockToUtcMs(tz, y, m, d, 0, 0, 0);
  const nextStr = addDaysToDateStr(dateStr, 1);
  const [ny, nm, nd] = nextStr.split("-").map(Number);
  const endMs = localWallClockToUtcMs(tz, ny, nm, nd, 0, 0, 0);
  return { start: new Date(startMs).toISOString(), end: new Date(endMs).toISOString() };
}
