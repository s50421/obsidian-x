// Cloudflare Email Worker for Obsidian-X "forward-to-brain".
// DEPLOYED (2026-07-23) as worker `obx-email` on account 6c6f01e4… , with an
// Email Routing rule: vault@manhartgroup.com -> this worker.
//
// This is the resilient version actually running: it always POSTs a note even
// if MIME parsing hiccups (falls back to the Subject header), and logs the
// webhook status.
//
// Redeploy from a throwaway project dir:
//   package.json:  { "type":"module", "dependencies": { "postal-mime": "^2.4.4" } }
//   wrangler.toml: name="obx-email"; main="src/index.js";
//                  compatibility_date="2024-11-01"; account_id="…"; workers_dev=false
//   npm i && CLOUDFLARE_API_TOKEN=… npx wrangler deploy
//   printf '%s' "$OBX_WEBHOOK_URL" | CLOUDFLARE_API_TOKEN=… npx wrangler secret put OBX_WEBHOOK_URL
//   OBX_WEBHOOK_URL = https://obsidian-x.vercel.app/api/inbound-email?token=<INBOUND_EMAIL_SECRET>
// Routing rule (API): POST /zones/{zone}/email/routing/rules
//   { matchers:[{type:"literal",field:"to",value:"vault@manhartgroup.com"}],
//     actions:[{type:"worker",value:["obx-email"]}], enabled:true }

import PostalMime from "postal-mime";

export default {
  async email(message, env) {
    let subject = "", text = "", note = "";
    try {
      const raw = await new Response(message.raw).arrayBuffer();
      const parsed = await new PostalMime().parse(raw);
      subject = parsed.subject || "";
      text = parsed.text || "";
    } catch (e) {
      note = "parse:" + String((e && e.message) || e);
    }
    if (!subject) {
      try { subject = message.headers.get("subject") || ""; } catch {}
    }
    const payload = { from: message.from, subject, text: text || (note ? "(" + note + ")" : "") };
    try {
      const res = await fetch(env.OBX_WEBHOOK_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      console.log("obx status=", res.status, note ? "| " + note : "");
    } catch (e) {
      console.log("obx FETCH ERROR:", String(e));
    }
  },
};
