# Mac mini setup — Obsidian-X

Two jobs for the always-on mini:

1. **Reliable cron host** — the primary trigger for the morning letter, evening deck nudge, and Gmail sync.
2. **Granola connector-agent host** — the daily meeting pull.

Everything here is copy-pasteable. Run it **on the Mac mini**, not your laptop.

---

## Why the cron host matters

Vercel's Hobby plan rejects sub-daily crons, so the letter has been relying on a GitHub Actions pinger. GitHub throttles free scheduled workflows hard: it asks for every 15 minutes and actually fires every **1h40m–3h25m**. On 2026-07-30 that gap swallowed the letter's entire send window and no letter arrived.

`launchd` on an always-on Mac doesn't drift. After this, there are **three** independent triggers — Mac mini (primary), Vercel daily cron, GitHub Actions (backup). Every endpoint is gated on a once-per-local-date marker, so redundancy can never produce two letters.

---

## Part 0 — make the mini genuinely always-on

### 0.1 Power behaviour

```bash
sudo pmset -a sleep 0 disksleep 0 displaysleep 10 womp 1 autorestart 1
```

- `sleep 0` / `disksleep 0` — never sleep (the display still sleeps after 10 min, which is fine)
- `womp 1` — wake for network access
- `autorestart 1` — **come back by itself after a power cut**

Verify:

```bash
pmset -g | grep -E 'sleep|autorestart|womp'
```

Also tick **System Settings → Energy → Prevent automatic sleeping when the display is off**.

### 0.2 Automatic login

**System Settings → Users & Groups → Automatically log in as → [your account]**

> ⚠ **FileVault blocks automatic login.** If FileVault is on, a reboot sits at the unlock screen until someone types the password — the mini won't recover from a power cut on its own, which defeats the point. Either turn FileVault off on this machine, or accept that reboots need you present. Your call; it's a real security-vs-availability trade and the mini will hold your `CRON_SECRET`.

Check FileVault:

```bash
fdesetup status
```

### 0.3 Remote access (so you never need a monitor)

**System Settings → General → Sharing** → enable **Screen Sharing** and **Remote Login**.

Test from your laptop:

```bash
ssh davidmanhart@<mac-mini-name>.local
```

---

## Part 1 — the cron host

### 1.1 Create the working directory

```bash
mkdir -p ~/.obsidian-x
```

### 1.2 Copy the two files over

From **your laptop**, in the repo root:

```bash
scp ops/macmini/obx-cron-ping.sh ops/macmini/com.manhartgroup.obsidianx.cron.plist davidmanhart@<mac-mini-name>.local:~/.obsidian-x/
```

### 1.3 Store the secret

On the **mini**. Get the value from `.env.rotation` on your laptop (`grep '^CRON_SECRET=' .env.rotation`):

```bash
printf 'CRON_SECRET=PASTE_THE_VALUE_HERE\n' > ~/.obsidian-x/env
chmod 600 ~/.obsidian-x/env
```

`chmod 600` matters — this token can trigger every cron endpoint.

### 1.4 Install the LaunchAgent

```bash
chmod +x ~/.obsidian-x/obx-cron-ping.sh
sed "s|REPLACE_WITH_HOME|$HOME|g" ~/.obsidian-x/com.manhartgroup.obsidianx.cron.plist \
  > ~/Library/LaunchAgents/com.manhartgroup.obsidianx.cron.plist
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.manhartgroup.obsidianx.cron.plist
```

If `bootstrap` errors with "service already loaded", replace it instead:

```bash
launchctl bootout gui/$(id -u)/com.manhartgroup.obsidianx.cron 2>/dev/null
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.manhartgroup.obsidianx.cron.plist
```

### 1.5 Verify

```bash
launchctl list | grep obsidianx          # should show the label, exit code 0
bash ~/.obsidian-x/obx-cron-ping.sh      # run it by hand once
cat ~/.obsidian-x/cron.log
```

**Reading the log:** it stays quiet on purpose. Out-of-window ticks return `{"skipped":true}` and are *not* logged — a skip every 15 minutes would bury the real events. You should see entries only for actual work (a Gmail sync that found mail, a letter that sent) and for anything non-200.

Sanity checks:

- Bad/missing secret → `HTTP 401` lines appear. Good: failures are loud.
- Missing env file → one `FATAL` line, exit 0 (so launchd doesn't back the job off).

### 1.6 Confirm it survives a reboot

```bash
sudo reboot
```

Wait, then from your laptop:

```bash
ssh davidmanhart@<mac-mini-name>.local 'launchctl list | grep obsidianx && tail -5 ~/.obsidian-x/cron.log'
```

If nothing is listed, automatic login didn't happen — revisit 0.2.

### 1.7 Leave GitHub Actions on

Don't disable it. It costs nothing, it's timezone-proof, and it covers the mini being offline. Three triggers, all idempotent.

---

## Part 2 — Granola

The ingestion path is already built and tested (`/api/capture-token`, dedupe on meeting id, heartbeat on meeting-free days). What's missing is something that runs daily and calls it.

### 2.1 Install Claude on the mini

Download from claude.ai, sign in as `davi.manhart@gmail.com`.

### 2.2 Connect Granola

In Claude's connector settings, add/enable **Granola** and complete its auth.

### 2.3 Create the scheduled task

Daily, ~07:30 local. Use the prompt in [`docs/granola-connector-agent.md`](../../docs/granola-connector-agent.md) — it's written to be pasted verbatim and includes the exact JSON body, the dedupe contract, and the heartbeat for days with no meetings.

You'll need `SHORTCUT_TOKEN` from `.env.rotation` in that prompt.

### 2.4 Verify

After the first run, on your laptop:

```bash
curl -s "https://obsidian.manhartgroup.com/api/cron/brief?preview=1" \
  -H "Authorization: Bearer $CRON_SECRET" | python3 -c "import json,sys;print(json.load(sys.stdin)['coverage'])"
```

`Granola ✗` should become `Granola ✓ n`. It'll also show on `/ops → Coverage` with a last-sync time.

> **The open question this answers.** The brief flagged that Claude's Granola connector may not authenticate in scheduled/headless runs. Running it on the mini in a logged-in GUI session is the documented fallback for exactly that — which is why automatic login (0.2) isn't optional if you want this to survive reboots.

---

## What to watch in the first week

| Check | Where | Expect |
|---|---|---|
| Letter arrives each morning | Telegram | by ~06:20 local |
| Delivery punctuality | `/ops` → Recent activity | `brief_sent` daily |
| Cron health | `~/.obsidian-x/cron.log` on the mini | quiet, no 401s |
| Coverage | `/ops` → Coverage | all declared sources ✓ |
| Granola | coverage footer | flips to ✓ after 2.4 |

If a morning is missed again, the first thing to check is whether the mini was awake:

```bash
ssh davidmanhart@<mac-mini-name>.local 'pmset -g log | grep -i "wake\|sleep" | tail -20'
```

---

## Uninstall

```bash
launchctl bootout gui/$(id -u)/com.manhartgroup.obsidianx.cron
rm ~/Library/LaunchAgents/com.manhartgroup.obsidianx.cron.plist
```
