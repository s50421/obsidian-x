// Obsidian-X v4.2.2 (letter refinement) — the Morning Brew Daily episode.
//
// Straight from the publisher's RSS rather than a scraper or a model: the feed
// is authoritative, free, and can't hallucinate an episode that doesn't exist.
// Feed id resolved via the iTunes lookup API and verified live (903 episodes).

const MORNING_BREW_FEED = "https://feeds.megaphone.fm/MOBI8777994188";
const SHOW_PAGE = "https://mbdailyshow.com";

export type Episode = {
  title: string;
  /** Direct audio URL — used behind a Telegram button so the ugly tracking URL never shows. */
  audioUrl: string | null;
  showUrl: string;
  published: Date | null;
  durationMin: number | null;
};

function tag(xml: string, name: string): string {
  const m = xml.match(new RegExp(`<${name}[^>]*>(?:<!\\[CDATA\\[)?([\\s\\S]*?)(?:\\]\\]>)?</${name}>`));
  return m ? m[1].trim() : "";
}

function decodeEntities(s: string): string {
  return s
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#8217;/g, "'")
    .replace(/&nbsp;/g, " ")
    .trim();
}

/** "1:02:33" | "23:10" | "1450" (seconds) -> whole minutes. */
function parseDuration(raw: string): number | null {
  if (!raw) return null;
  if (/^\d+$/.test(raw)) return Math.round(Number(raw) / 60) || null;
  const parts = raw.split(":").map(Number);
  if (parts.some((n) => !Number.isFinite(n))) return null;
  const secs = parts.reduce((acc, n) => acc * 60 + n, 0);
  return Math.round(secs / 60) || null;
}

/**
 * The most recent episode. Returns null on any failure — the letter then says
 * the podcast couldn't be fetched rather than silently dropping the line.
 */
export async function latestMorningBrew(): Promise<Episode | null> {
  try {
    const res = await fetch(MORNING_BREW_FEED, {
      signal: AbortSignal.timeout(12000),
      headers: { "User-Agent": "Obsidian-X/1.0" },
    });
    if (!res.ok) return null;
    const xml = await res.text();

    const first = xml.match(/<item>([\s\S]*?)<\/item>/);
    if (!first) return null;
    const item = first[1];

    const title = decodeEntities(tag(item, "title"));
    if (!title) return null;

    const enclosure = item.match(/<enclosure[^>]*url="([^"]+)"/);
    const pub = tag(item, "pubDate");
    const published = pub ? new Date(pub) : null;

    return {
      title,
      audioUrl: enclosure ? enclosure[1] : null,
      showUrl: SHOW_PAGE,
      published: published && !Number.isNaN(published.getTime()) ? published : null,
      durationMin: parseDuration(tag(item, "itunes:duration")),
    };
  } catch {
    return null;
  }
}
