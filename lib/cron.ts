import { bearerEquals } from "@/lib/secure-compare";

// Vercel Cron sends `Authorization: Bearer $CRON_SECRET` when CRON_SECRET is set.
// The GitHub Actions pinger and the Mac mini launchd job use the same header.
//
// NOTE ON BLAST RADIUS: this one secret unlocks every cron endpoint, and some of
// them RETURN personal data — `/api/cron/brief?preview=1` renders the full
// letter, including email senders and subjects. Treat CRON_SECRET as a read
// credential for the owner's inbox, not merely a trigger.
export function isCronAuthorized(req: Request): boolean {
  return bearerEquals(req.headers.get("authorization"), process.env.CRON_SECRET);
}
