# Granola connector-agent (v4.1 workstream C)

Obsidian-X's first **connector-agent** inflow: instead of building a Granola
integration, a scheduled Claude task uses Claude's own Granola connector and
posts the results into the brain over the existing token-authed endpoint.

This is the pattern that later carries iMessage and Mac file indexing (phase 2),
so it's worth getting the shape right: **the agent is the connector.**

---

## 1. The endpoint it posts to

`POST https://obsidian.manhartgroup.com/api/capture-token`

Auth: `Authorization: Bearer <SHORTCUT_TOKEN>` (the value is in `.env.rotation`).

Body — one request per meeting:

```json
{
  "source": "granola",
  "externalId": "<granola meeting id>",
  "title": "<meeting title>",
  "date": "2026-07-29T15:00:00Z",
  "attendees": [{ "name": "Jane Doe", "email": "jane@acme.com" }],
  "text": "Meeting: <title>\nDate: <date>\nAttendees: <names>\n\n<summary + decisions + action items>"
}
```

`externalId` is the dedupe key. Re-running the task for the same day is a no-op:
the endpoint returns `{"ok":true,"duplicate":true}` and writes nothing.

Heartbeat — send this when there were no meetings, so a quiet day doesn't read
as a broken source in the coverage panel:

```json
{ "source": "granola", "heartbeat": true }
```

## 2. The scheduled task prompt

Create this as a **scheduled task in the Claude app** (not a Vercel cron), daily
at ~07:30 local, with the **Granola connector enabled**.

> Using the Granola connector, list every meeting from yesterday (my local
> date). For each meeting, gather: the meeting id, title, start time, attendee
> names and emails, and the notes/summary including any decisions and action
> items.
>
> Then POST each meeting individually to
> `https://obsidian.manhartgroup.com/api/capture-token` with header
> `Authorization: Bearer $SHORTCUT_TOKEN` and a JSON body shaped exactly like:
>
> ```json
> {
>   "source": "granola",
>   "externalId": "<meeting id>",
>   "title": "<title>",
>   "date": "<ISO start time>",
>   "attendees": [{"name": "...", "email": "..."}],
>   "text": "Meeting: <title>\nDate: <date>\nAttendees: <names>\n\n<full summary, decisions, action items>"
> }
> ```
>
> A response of `{"duplicate": true}` means it was already ingested — that is
> success, not an error; do not retry it.
>
> If there were no meetings yesterday, POST exactly once:
> `{"source": "granola", "heartbeat": true}`
>
> Report back: how many meetings you found, how many posted successfully, how
> many were duplicates, and any errors verbatim.

## 3. The headless question

⚠ The open risk (flagged in the brief): **Claude's Granola connector may not be
authenticated in scheduled/headless runs.** Interactive sessions carry the
user's connector auth; scheduled runs may not.

**Test it:** create the task, let one scheduled run fire, and check
`/ops → Coverage → Granola`. If it shows a recent sync, the hosted path works.

**If it doesn't:** run the identical prompt as a scheduled task from the Mac
mini's Claude instance instead — same endpoint, same body, same dedupe. Nothing
on the Obsidian-X side changes; only where the agent runs.

## 4. Verifying it

- `/ops → Coverage` shows **Granola** with a recent last-sync and a 24h count.
- The morning brief's coverage footer includes `Granola ✓ n`.
- The meeting appears as an item, and in that evening's swipe deck.
- Re-running the task the same day creates nothing new.
