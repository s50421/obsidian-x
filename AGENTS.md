<!-- BEGIN:nextjs-agent-rules -->
# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` before writing any code. Heed deprecation notices.
<!-- END:nextjs-agent-rules -->

# HARD RULES — non-negotiable, owner-set (2026-08-02)

1. **DRAFT-ONLY COMMUNICATIONS. This system NEVER sends emails, messages, or any communication to anyone other than the owner.** No Gmail send scope (`gmail.readonly` only — never `gmail.send`, `gmail.modify`, or `gmail.compose`), no SMTP credentials, no third-party send APIs, no "reply" endpoints. Every outbound reply — email, message, anything addressed to another person — is produced as a DRAFT the owner copies and sends himself. Telegram messages TO THE OWNER (briefs, nudges, confirmations) are fine; they are the product's own channel to him. If a task seems to require sending on the owner's behalf: stop, build the draft path instead, and flag it. Do not add a send capability, a send scope, or a send dependency "for later" — the owner will lift this rule explicitly in writing when and if he ever does.
2. **Propose, then approve.** Destructive or outward-facing actions (task creation, item mutation by agents, anything external) go through the proposals/approval flow. See `instructions/v4-vision.md` design laws.
