import ical, { type VEvent } from "node-ical";

export type CalEvent = {
  calendar: string;
  summary: string;
  start: Date;
  end: Date | null;
  location: string | null;
  allDay: boolean;
};

// Every configured calendar = any env var whose name contains CALENDAR_ICAL_URL
// (e.g. GOOGLE_CALENDAR_ICAL_URL_Meetings, ICLOUD_CALENDAR_ICAL_URL_Personal).
export function getCalendarUrls(): { name: string; url: string }[] {
  const out: { name: string; url: string }[] = [];
  // Individual named vars (used locally): GOOGLE_/ICLOUD_CALENDAR_ICAL_URL_<Name>.
  for (const [k, v] of Object.entries(process.env)) {
    if (k.includes("CALENDAR_ICAL_URL") && k !== "CALENDAR_ICAL_URLS" && v) {
      const name =
        k.replace(/^(?:GOOGLE|ICLOUD)_/i, "").replace(/^CALENDAR_ICAL_URL_?/i, "") || k;
      out.push({ name: name.replace(/_/g, " ").trim() || "Calendar", url: v });
    }
  }
  // Consolidated bundle (used in prod = one env var): lines of "name|url".
  const bundle = process.env.CALENDAR_ICAL_URLS;
  if (bundle) {
    for (const raw of bundle.split(/\n|;;/)) {
      const line = raw.trim();
      if (!line) continue;
      const sep = line.indexOf("|");
      const name = sep >= 0 ? line.slice(0, sep).trim() : "Calendar";
      const url = sep >= 0 ? line.slice(sep + 1).trim() : line;
      if (url) out.push({ name: name || "Calendar", url });
    }
  }
  // De-dupe by url (in case both forms are present).
  const seen = new Set<string>();
  return out.filter((c) => (seen.has(c.url) ? false : (seen.add(c.url), true)));
}

function toHttps(u: string): string {
  return u.replace(/^webcal:\/\//i, "https://");
}

// Events starting within the next `windowHours`, across all calendars.
// Recurring events are expanded (with exdate exceptions honoured).
export async function fetchUpcomingEvents(windowHours = 24): Promise<CalEvent[]> {
  const now = new Date();
  const end = new Date(now.getTime() + windowHours * 3600 * 1000);
  const cals = getCalendarUrls();

  const perCal = await Promise.allSettled(
    cals.map(async (c): Promise<CalEvent[]> => {
      const res = await fetch(toHttps(c.url), { signal: AbortSignal.timeout(8000) });
      if (!res.ok) return [];
      const parsed = ical.sync.parseICS(await res.text());
      const events: CalEvent[] = [];

      const nowMs = now.getTime();
      const endMs = end.getTime();
      const DAY = 24 * 3600 * 1000;

      for (const key of Object.keys(parsed)) {
        const comp = parsed[key];
        if (!comp || comp.type !== "VEVENT") continue;
        const ev = comp as VEvent;
        if (!ev.start) continue;

        const summary = ev.summary ? String(ev.summary) : "(no title)";
        const location = ev.location ? String(ev.location) : null;
        // All-day events have DATE (not DATE-TIME) values; node-ical sets datetype.
        const allDay = (ev as unknown as { datetype?: string }).datetype === "date";
        const startMs = new Date(ev.start).getTime();
        // Duration: explicit end, else a full day for all-day, else a point.
        const durMs = ev.end ? new Date(ev.end).getTime() - startMs : allDay ? DAY : 0;

        // Include an occurrence if it OVERLAPS the window [now, end] — this keeps
        // all-day events (which start at midnight, before "now") and in-progress
        // events, not just those whose start is still in the future.
        const consider = (st: Date) => {
          const s = st.getTime();
          const e = s + durMs;
          const overlaps = durMs > 0 ? s < endMs && e > nowMs : s >= nowMs && s <= endMs;
          if (!overlaps) return;
          events.push({
            calendar: c.name,
            summary,
            start: st,
            end: durMs ? new Date(s + durMs) : null,
            location,
            allDay,
          });
        };

        if (ev.rrule) {
          let occ: Date[] = [];
          try {
            // Look back a day so an all-day / in-progress occurrence isn't missed.
            occ = ev.rrule.between(new Date(nowMs - DAY), end, true);
          } catch {
            occ = [];
          }
          const exdates = ev.exdate
            ? Object.values(ev.exdate).map((d) => new Date(d as unknown as Date).getTime())
            : [];
          for (const o of occ) {
            if (exdates.includes(new Date(o).getTime())) continue;
            consider(new Date(o));
          }
        } else {
          consider(new Date(ev.start));
        }
      }
      return events;
    })
  );

  const all: CalEvent[] = [];
  for (const r of perCal) if (r.status === "fulfilled") all.push(...r.value);
  all.sort((a, b) => a.start.getTime() - b.start.getTime());
  return all;
}
