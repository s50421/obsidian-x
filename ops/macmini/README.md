# Mac mini setup — Obsidian-X

Two jobs for the always-on mini:

1. **Reliable cron host** — the primary trigger for the morning letter, evening deck nudge, and Gmail sync.
2. **Granola connector-agent host** — the daily meeting pull.

Security-first: **FileVault stays on**, the secret lives in the **Keychain** (never on disk), and remote access is **key-only and LAN-only**. Where that costs something, it says so.

Everything is copy-pasteable. Run it **on the Mac mini**, not your laptop.

---

## Why the cron host matters

Vercel's Hobby plan rejects sub-daily crons, so the letter has been relying on a GitHub Actions pinger. GitHub throttles free scheduled workflows hard: it asks for every 15 minutes and actually fires every **1h40m–3h25m**. On 2026-07-30 that gap swallowed the letter's entire send window and no letter arrived.

`launchd` on an always-on Mac doesn't drift. After this there are **three** independent triggers — Mac mini (primary), Vercel daily cron, GitHub Actions (backup). Every endpoint is gated on a once-per-local-date marker, so redundancy can never produce two letters.

---

## What this machine will hold, and why it matters

`CRON_SECRET` is **not just a trigger — it is a read credential.** `/api/cron/brief?preview=1` returns the rendered letter: email senders, subjects, your calendar. Anyone holding it can read a summary of your inbox.

That single fact drives every choice below: Keychain over a dotfile, header auth over query strings, no inbound ports, FileVault on.

If it's ever exposed, rotate it — and remember it's a **two-step** rotation (`.env.rotation` **and** Vercel env **and** redeploy), then update the Keychain here.

---

## Part 0 — foundation

### 0.1 Power behaviour

```bash
sudo pmset -a sleep 0 disksleep 0 displaysleep 10 womp 1 autorestart 1
```

- `sleep 0` / `disksleep 0` — never sleep (display still sleeps after 10 min, which is fine)
- `womp 1` — wake for network access
- `autorestart 1` — power back on after a power cut

Verify:

```bash
pmset -g | grep -E 'sleep|autorestart|womp'
```

Also tick **System Settings → Energy → Prevent automatic sleeping when the display is off**.

### 0.2 FileVault — keep it ON

```bash
fdesetup status    # expect: FileVault is On.
```

**Do not enable automatic login.** It's incompatible with FileVault and would leave the disk unlocked and a live session waiting for anyone with physical access — on a machine holding a credential that can read your inbox.

**The honest cost:** after a power cut the mini stops at the FileVault unlock screen and stays there until someone types the password. Crons don't run until then.

Two mitigations, in order of value:

1. **A small UPS.** Turns nearly every real-world power event into a non-event, and is the actual fix. ~£50–80.
2. **`sudo fdesetup authrestart`** for *planned* reboots — reboots once passing through the unlock screen, so you can update remotely without losing the machine. Doesn't help with unexpected cuts.

Day to day none of this bites: unlocking at boot logs you in, the session stays up, and the LaunchAgent runs normally.

> If you later decide availability matters more than at-rest encryption, that's a legitimate call — but make it deliberately, and rotate `CRON_SECRET` onto a machine you're happy leaving unlocked.

### 0.3 Remote access — LAN only, keys only

Enable **System Settings → General → Sharing → Remote Login**.

Restrict it to your user only (not "All users"). Then harden SSH:

```bash
sudo tee /etc/ssh/sshd_config.d/100-obsidianx.conf >/dev/null <<'EOF'
PasswordAuthentication no
KbdInteractiveAuthentication no
PermitRootLogin no
EOF
sudo launchctl kickstart -k system/com.openssh.sshd
```

Copy your key over **before** disabling passwords, or you'll lock yourself out:

```bash
# from your laptop, BEFORE running the above
ssh-copy-id davidmanhart@<mac-mini-name>.local
```

**Do not port-forward SSH or Screen Sharing to the internet.** If you need remote access from outside, use Tailscale or a VPN — not an open port. Leave Screen Sharing off unless you actively need it.

---

## Part 1 — the cron host

### 1.1 Copy the files over

From **your laptop**, in the repo root:

```bash
ssh davidmanhart@<mac-mini-name>.local 'mkdir -p ~/.obsidian-x && chmod 700 ~/.obsidian-x'
scp ops/macmini/obx-cron-ping.sh ops/macmini/com.manhartgroup.obsidianx.cron.plist \
    davidmanhart@<mac-mini-name>.local:~/.obsidian-x/
```

### 1.2 Store the secret in the Keychain

On the **mini**. Get the value from your laptop with `grep '^CRON_SECRET=' .env.rotation`.

```bash
read -rs -p "CRON_SECRET: " S && echo
security add-generic-password -s obsidian-x-cron -a "$USER" -w "$S" -U
unset S
```

`read -rs` keeps it off the screen **and out of your shell history** — which passing it as an argument would not. Verify:

```bash
security find-generic-password -s obsidian-x-cron -w >/dev/null && echo "stored ✓"
```

There is deliberately no `.env` file. Nothing on this disk contains the secret in plaintext.

### 1.3 Install the LaunchAgent

```bash
chmod 700 ~/.obsidian-x/obx-cron-ping.sh
sed "s|REPLACE_WITH_HOME|$HOME|g" ~/.obsidian-x/com.manhartgroup.obsidianx.cron.plist \
  > ~/Library/LaunchAgents/com.manhartgroup.obsidianx.cron.plist
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.manhartgroup.obsidianx.cron.plist
```

If it says the service is already loaded:

```bash
launchctl bootout gui/$(id -u)/com.manhartgroup.obsidianx.cron 2>/dev/null
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.manhartgroup.obsidianx.cron.plist
```

The first run will prompt for **Keychain access** — click **Always Allow** so it can run unattended.

### 1.4 Verify

```bash
launchctl list | grep obsidianx          # label present, exit code 0
bash ~/.obsidian-x/obx-cron-ping.sh      # run once by hand
cat ~/.obsidian-x/cron.log
```

**The log stays quiet on purpose.** Out-of-window ticks return `{"skipped":true}` and are *not* logged — a skip every 15 minutes would bury the real events. You should see entries only for actual work and for anything non-200.

Behaviour worth knowing:

| Situation | What happens |
|---|---|
| Keychain entry missing | one `FATAL` line, exit 0 (launchd doesn't back the job off) |
| Wrong secret | `HTTP 401` lines — failures are loud, never silent |
| Network down | `HTTP 000`, retried next tick |
| Log grows past 20k lines | self-truncates to the last 5k |

The log is `chmod 600` and the secret is never written to it (verified).

### 1.5 Confirm it survives a reboot

```bash
sudo fdesetup authrestart      # reboots THROUGH the FileVault prompt, once
```

Then from your laptop:

```bash
ssh davidmanhart@<mac-mini-name>.local 'launchctl list | grep obsidianx && tail -5 ~/.obsidian-x/cron.log'
```

If the agent isn't listed, the session didn't come back — check 0.2.

### 1.6 Leave GitHub Actions on

Don't disable it. It costs nothing, it's timezone-proof, and it covers the mini being offline or locked. Three triggers, all idempotent.

---

## Part 2 — Granola

The ingestion path is already built and tested (`/api/capture-token`, dedupe on meeting id, heartbeat on meeting-free days). What's missing is something that runs daily and calls it.

### 2.1 Install Claude and connect Granola

Download Claude, sign in as `davi.manhart@gmail.com`, then enable the **Granola** connector and complete its auth.

### 2.2 Create the scheduled task

Daily, ~07:30 local. Use the prompt in [`docs/granola-connector-agent.md`](../../docs/granola-connector-agent.md) — written to paste verbatim, with the exact JSON body, the dedupe contract and the heartbeat.

It needs `SHORTCUT_TOKEN` from `.env.rotation`. **Send it as an `Authorization: Bearer` header, not `?token=`** — the endpoint accepts both, but a query-string secret ends up in access and proxy logs. The prompt already does this correctly.

> ⚠ That token is a **write** credential: it can capture anything into your brain. It's a second secret living on this machine, which is another reason for 0.2 and 0.3.

### 2.3 Verify

From your laptop, after the first run:

```bash
curl -s "https://obsidian.manhartgroup.com/api/cron/brief?preview=1" \
  -H "Authorization: Bearer $CRON_SECRET" | python3 -c "import json,sys;print(json.load(sys.stdin)['coverage'])"
```

`Granola ✗` should become `Granola ✓ n`, and `/ops → Coverage` will show a last-sync time.

> **The open question this answers.** The brief flagged that Claude's Granola connector may not authenticate in scheduled/headless runs. Running it on the mini in a logged-in GUI session is the documented fallback for exactly that.

---

## What to watch in the first week

| Check | Where | Expect |
|---|---|---|
| Letter arrives each morning | Telegram | by ~06:20 local |
| Delivery punctuality | `/ops` → Recent activity | `brief_sent` daily |
| Cron health | `~/.obsidian-x/cron.log` | quiet, no 401s |
| Coverage | `/ops` → Coverage | all declared sources ✓ |
| Granola | coverage footer | flips to ✓ after 2.3 |

If a morning is missed again, first check whether the mini was awake and unlocked:

```bash
ssh davidmanhart@<mac-mini-name>.local 'pmset -g log | grep -iE "wake|sleep" | tail -20'
```

---

## Security checklist

- [ ] FileVault **on** (`fdesetup status`)
- [ ] Automatic login **off**
- [ ] `CRON_SECRET` in Keychain, **no plaintext file on disk**
- [ ] SSH: keys only, password auth disabled, your user only
- [ ] **No** inbound ports forwarded from the router
- [ ] Screen Sharing off unless actively needed
- [ ] `~/.obsidian-x` is `700`, `cron.log` is `600`
- [ ] Firewall on (**System Settings → Network → Firewall**)
- [ ] Automatic security updates enabled
- [ ] If either secret leaks: rotate in `.env.rotation` **and** Vercel **and** redeploy **and** update the Keychain

---

## Uninstall

```bash
launchctl bootout gui/$(id -u)/com.manhartgroup.obsidianx.cron
rm ~/Library/LaunchAgents/com.manhartgroup.obsidianx.cron.plist
rm -rf ~/.obsidian-x
security delete-generic-password -s obsidian-x-cron
```
