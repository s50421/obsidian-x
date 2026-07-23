import ical, { type VEvent } from "node-ical";

export type CalEvent = {
  calendar: string;
  summary: string;
  start: Date;
  end: Date | null;
  location: string | null;
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

      for (const key of Object.keys(parsed)) {
        const comp = parsed[key];
        if (!comp || comp.type !== "VEVENT") continue;
        const ev = comp as VEvent;
        if (!ev.start) continue;

        const summary = ev.summary ? String(ev.summary) : "(no title)";
        const location = ev.location ? String(ev.location) : null;
        const startMs = new Date(ev.start).getTime();
        const durMs = ev.end ? new Date(ev.end).getTime() - startMs : 0;

        if (ev.rrule) {
          let occ: Date[] = [];
          try {
            occ = ev.rrule.between(now, end, true);
          } catch {
            occ = [];
          }
          const exdates = ev.exdate
            ? Object.values(ev.exdate).map((d) => new Date(d as unknown as Date).getTime())
            : [];
          for (const o of occ) {
            const st = new Date(o);
            if (exdates.includes(st.getTime())) continue;
            events.push({
              calendar: c.name,
              summary,
              start: st,
              end: durMs ? new Date(st.getTime() + durMs) : null,
              location,
            });
          }
        } else {
          const st = new Date(ev.start);
          if (st >= now && st <= end) {
            events.push({
              calendar: c.name,
              summary,
              start: st,
              end: ev.end ? new Date(ev.end) : null,
              location,
            });
          }
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
