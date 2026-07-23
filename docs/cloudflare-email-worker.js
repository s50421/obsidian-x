// Cloudflare Email Worker for Obsidian-X "forward-to-brain".
// Deploy this to a Cloudflare Email Routing worker, then route your private
// capture address (e.g. brain@yourdomain.com) to it.
//
// Setup:
//   1. npm create cloudflare@latest obx-email -- --type=hello-world
//   2. npm i postal-mime
//   3. Replace src/index.js with this file.
//   4. Set a secret:  npx wrangler secret put OBX_WEBHOOK_URL
//        value: https://obsidian-x.vercel.app/api/inbound-email?token=YOUR_SECRET
//   5. npx wrangler deploy
//   6. Cloudflare dashboard → your domain → Email → Email Routing → route your
//      capture address to this worker.

import PostalMime from "postal-mime";

export default {
  async email(message, env) {
    const raw = await new Response(message.raw).arrayBuffer();
    const email = await new PostalMime().parse(raw);

    const payload = {
      from: message.from, // envelope sender
      subject: email.subject || "",
      text: email.text || "",
    };

    await fetch(env.OBX_WEBHOOK_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
  },
};
