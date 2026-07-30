import type { SupabaseClient } from "@supabase/supabase-js";
import ical, { type VEvent } from "node-ical";
import { getCalendarUrls } from "@/lib/calendar";

// v4.0 W4 — timezone-aware letter delivery. David is PST-based but often in
// CET or elsewhere; the morning letter fires at 6:30am wherever he wakes.
//
// Resolution order (resolveOwnerTz):
//   1. settings.tz_override, if set and not 'auto' (Telegram /tz command)
//   2. inferred from the dominant TZID seen on calendar events in the next
//      24-48h (lib/calendar.ts's iCal sources)
//   3. hard fallback: America/Vancouver (David's home base)
// This function is designed to never throw — every step degrades gracefully.

export const FALLBACK_TZ = "America/Vancouver";
export const SETTINGS_KEY_TZ_OVERRIDE = "tz_override";

// The morning letter's delivery window (inclusive).
//
// This is a FLOOR plus a late backstop, not a narrow slot, and that is a
// correction born from a real miss (2026-07-30: no letter arrived at all).
// The window was 06:15-07:15 — sixty minutes — on the assumption that the
// pinger fires every 15 minutes as its schedule requests. It does not:
// GitHub deprioritises scheduled workflows on the free tier and the observed
// gaps are 1h40m to 3h25m. That morning the ticks landed at 05:54 and 08:06
// local, straddling the entire window, so the letter silently never sent.
// A 60-minute target against ~150-minute gaps lands maybe 40% of mornings.
//
// So: send on the FIRST tick at or after 06:15 local, and keep accepting until
// late morning. Delivery drifts (06:15-08:30 in practice) but it arrives —
// and a letter at 8am is worth incomparably more than no letter at 6:30.
// Idempotency is unaffected: the `brief_sent` marker keyed on the owner's
// local date still guarantees exactly one send per day.
export const BRIEF_WINDOW_START = "06:15";
export const BRIEF_WINDOW_END = "11:00";

// ---- IANA validation ---------------------------------------------------------

// Validate a candidate string as a real IANA timezone name. Uses
// Intl.supportedValuesOf when available (canonical list) and always falls back
// to constructing an Intl.DateTimeFormat with it (accepts aliases too, e.g.
// "Asia/Calcutta" for "Asia/Kolkata") — either success is sufficient.
export function isValidIanaTimeZone(tz: unknown): tz is string {
  if (typeof tz !== "string" || !tz.trim()) return false;
  try {
    if (
      typeof Intl.supportedValuesOf === "function" &&
      Intl.supportedValuesOf("timeZone").includes(tz)
    ) {
      return true;
    }
  } catch {
    // Intl.supportedValuesOf unsupported in this runtime — fall through.
  }
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

// ---- settings (generic key/value, owner-scoped) ------------------------------
// Backing table: `settings` (migration 0008). One row per (user_id, key).

export async function getSettingValue<T = unknown>(
  admin: SupabaseClient,
  userId: string,
  key: string
): Promise<T | null> {
  const { data, error } = await admin
    .from("settings")
    .select("value")
    .eq("user_id", userId)
    .eq("key", key)
    .maybeSingle();
  if (error || !data) return null;
  return (data.value as T | undefined) ?? null;
}

export async function setSettingValue(
  admin: SupabaseClient,
  userId: string,
  key: string,
  value: unknown
): Promise<void> {
  await admin
    .from("settings")
    .upsert({ user_id: userId, key, value }, { onConflict: "user_id,key" });
}

// ---- calendar-based inference --------------------------------------------------

function toHttps(u: string): string {
  return u.replace(/^webcal:\/\//i, "https://");
}

// Zones that mean "normalised", not "where the owner is". A calendar feed that
// emits TZID=Etc/UTC is telling us about its own serialisation, not about a
// human being in Greenwich — treating it as a location signal makes the
// inferred timezone flip as events roll in and out of the lookahead window.
const UTC_LIKE = new Set(["utc", "gmt", "z", "etc/utc", "etc/gmt", "etc/greenwich", "etc/zulu", "universal", "zulu"]);

export function isUtcLike(tzid: string): boolean {
  const t = tzid.trim().toLowerCase();
  // Etc/GMT+5 and friends are fixed offsets — equally useless as a home-zone
  // signal, and equally a serialisation artifact.
  return UTC_LIKE.has(t) || /^etc\/gmt[+-]\d+$/.test(t);
}

// Look at the owner's configured calendars and find the dominant TZID among
// events in the next `windowHours` (default 48h, per the brief's 24-48h ask).
// Returns null if nothing usable is found (no calendars, fetch failures, no
// TZID-bearing events) — the caller falls back from there.
async function inferTzFromCalendar(windowHours = 48): Promise<string | null> {
  const cals = getCalendarUrls();
  if (!cals.length) return null;

  const now = Date.now();
  const end = now + windowHours * 3600 * 1000;
  const DAY = 24 * 3600 * 1000;
  const counts = new Map<string, number>();

  await Promise.allSettled(
    cals.map(async (c) => {
      let text: string;
      try {
        const res = await fetch(toHttps(c.url), { signal: AbortSignal.timeout(8000) });
        if (!res.ok) return;
        text = await res.text();
      } catch {
        return; // one calendar's network failure never sinks the others
      }

      let parsed: ReturnType<typeof ical.sync.parseICS>;
      try {
        parsed = ical.sync.parseICS(text);
      } catch {
        return;
      }

      const bump = (tzid: string, startMs: number, durMs: number) => {
        const s = startMs;
        const e = s + durMs;
        const overlaps = durMs > 0 ? s < end && e > now : s >= now && s <= end;
        if (overlaps) counts.set(tzid, (counts.get(tzid) ?? 0) + 1);
      };

      for (const key of Object.keys(parsed)) {
        const comp = parsed[key];
        if (!comp || comp.type !== "VEVENT") continue;
        const ev = comp as VEvent;
        if (!ev.start) continue;

        // node-ical attaches the raw TZID (when the ICS DTSTART carried one) as
        // a `.tz` property on the Date. Untimed / UTC ("Z") values have none —
        // they don't tell us anything about the owner's local zone, so skip.
        const tzid = (ev.start as unknown as { tz?: string }).tz;
        if (!tzid || !isValidIanaTimeZone(tzid)) continue;
        // …and some feeds DO carry an explicit `TZID=Etc/UTC` (or UTC/GMT/Z),
        // which passes the IANA check and would otherwise be counted as if the
        // owner lived there. Nobody's home timezone is Etc/UTC — it's an
        // artifact of calendar normalisation. Observed live on 2026-07-30: the
        // deck nudge resolved Etc/UTC while the letter, minutes earlier,
        // resolved America/Vancouver, purely because the rolling 48h window had
        // moved past the zoned events. Left in, that drifts the delivery time
        // of both by whole hours depending on what's in the diary.
        if (isUtcLike(tzid)) continue;

        const startMs = new Date(ev.start).getTime();
        const durMs = ev.end ? new Date(ev.end).getTime() - startMs : 0;

        if (ev.rrule) {
          let occ: Date[] = [];
          try {
            occ = ev.rrule.between(new Date(now - DAY), new Date(end), true);
          } catch {
            occ = [];
          }
          for (const o of occ) bump(tzid, new Date(o).getTime(), durMs);
        } else {
          bump(tzid, startMs, durMs);
        }
      }
    })
  );

  let best: string | null = null;
  let bestCount = 0;
  for (const [tz, n] of counts) {
    if (n > bestCount) {
      best = tz;
      bestCount = n;
    }
  }
  return best;
}

// ---- the resolver --------------------------------------------------------------

export async function resolveOwnerTz(admin: SupabaseClient, ownerId: string): Promise<string> {
  try {
    const override = await getSettingValue<string>(admin, ownerId, SETTINGS_KEY_TZ_OVERRIDE);
    if (override && override !== "auto" && isValidIanaTimeZone(override)) {
      return override;
    }
  } catch {
    // settings lookup failed — fall through to calendar inference
  }

  try {
    const inferred = await inferTzFromCalendar();
    if (inferred) return inferred;
  } catch {
    // calendar fetch/parse failed — fall through to the hard fallback
  }

  return FALLBACK_TZ;
}

// ---- local-time helpers (used by the brief cron's hourly gate) -----------------

// "HH:MM" (24h, zero-padded) for `at` (default now) in `tz`.
export function localHHMM(tz: string, at: Date = new Date()): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(at);
  const h = parts.find((p) => p.type === "hour")?.value ?? "00";
  const m = parts.find((p) => p.type === "minute")?.value ?? "00";
  return `${h.padStart(2, "0")}:${m.padStart(2, "0")}`;
}

// "YYYY-MM-DD" (the owner's local calendar date) for `at` (default now) in `tz`.
export function localDateStr(tz: string, at: Date = new Date()): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(at);
  const y = parts.find((p) => p.type === "year")?.value ?? "1970";
  const m = parts.find((p) => p.type === "month")?.value ?? "01";
  const d = parts.find((p) => p.type === "day")?.value ?? "01";
  return `${y}-${m}-${d}`;
}

// Is "HH:MM" within [start, end] (inclusive)? Plain minute-of-day comparison —
// correct for half-hour-offset zones too (e.g. Asia/Kolkata UTC+5:30) since
// Intl (via localHHMM) already resolves the real local clock time; no manual
// offset math happens here.
export function isWithinBriefWindow(
  hhmm: string,
  start: string = BRIEF_WINDOW_START,
  end: string = BRIEF_WINDOW_END
): boolean {
  const toMin = (s: string) => {
    const [h, m] = s.split(":").map(Number);
    return h * 60 + m;
  };
  const t = toMin(hhmm);
  return t >= toMin(start) && t <= toMin(end);
}

// ---- confirmation copy (Telegram /tz) -------------------------------------------

// Approximate UTC offset (minutes, east-positive) for `tz` at `at`. "Approximate"
// because it reads today's offset, which is exact except across a DST
// transition between now and the moment being described — fine for a
// human-readable confirmation message (the cron gate itself never uses this;
// it always asks Intl for the real local time directly).
function utcOffsetMinutes(tz: string, at: Date = new Date()): number {
  const part = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    timeZoneName: "shortOffset",
  })
    .formatToParts(at)
    .find((p) => p.type === "timeZoneName")?.value;
  const m = (part ?? "GMT+0").match(/GMT([+-])(\d{1,2})(?::(\d{2}))?/);
  if (!m) return 0;
  const sign = m[1] === "-" ? -1 : 1;
  const h = Number(m[2]);
  const mi = m[3] ? Number(m[3]) : 0;
  return sign * (h * 60 + mi);
}

// "6:30am Europe/Berlin ≈ 04:30 UTC (it's 21:47 there right now)." — used to
// confirm a /tz change so the owner can eyeball that it lines up.
export function describeSixThirty(tz: string, at: Date = new Date()): string {
  const offset = utcOffsetMinutes(tz, at);
  const utcMin = (((6 * 60 + 30 - offset) % 1440) + 1440) % 1440;
  const uh = String(Math.floor(utcMin / 60)).padStart(2, "0");
  const um = String(utcMin % 60).padStart(2, "0");
  return `6:30am ${tz} ≈ ${uh}:${um} UTC (it's ${localHHMM(tz, at)} there right now).`;
}
