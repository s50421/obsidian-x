// Vercel Cron sends `Authorization: Bearer $CRON_SECRET` when CRON_SECRET is set.
// Manual triggers (e.g. testing) use the same header.
export function isCronAuthorized(req: Request): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) return false;
  return req.headers.get("authorization") === `Bearer ${secret}`;
}
