"use client";

import { useRef, useState } from "react";
import { BTN_PRIMARY } from "../components/ui";

// The whole point of this screen is the copy button. The system drafts replies
// but is forbidden from sending them (AGENTS.md hard rule — draft-only
// communications), so the last step is always the owner pasting it somewhere
// himself. That step should cost one tap, not a manual text selection on a
// phone.

export default function DraftCard({
  subject,
  sender,
  draft,
  generatedAt,
}: {
  subject: string | null;
  sender: string | null;
  draft: string;
  generatedAt: string | null;
}) {
  const [copied, setCopied] = useState(false);
  const [open, setOpen] = useState(false);
  const bodyRef = useRef<HTMLPreElement>(null);

  async function copy() {
    try {
      await navigator.clipboard.writeText(draft);
    } catch {
      // Clipboard API needs a secure context and can be refused outright. A
      // silent failure would look identical to success, so fall back to
      // selecting the text and let the owner copy it the usual way.
      const el = bodyRef.current;
      if (el) {
        const range = document.createRange();
        range.selectNodeContents(el);
        const sel = window.getSelection();
        sel?.removeAllRanges();
        sel?.addRange(range);
      }
      setOpen(true);
      return;
    }
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }

  const preview = draft.length > 260 && !open ? `${draft.slice(0, 260).trimEnd()}…` : draft;

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <div className="text-[16px] font-semibold leading-snug">{subject ?? "(no subject)"}</div>
          <div className="mt-0.5 text-[13px] text-ink-2">
            reply to {sender ?? "unknown"}
            {generatedAt ? ` · drafted ${new Date(generatedAt).toLocaleDateString()}` : ""}
          </div>
        </div>
        <button type="button" onClick={copy} className={BTN_PRIMARY}>
          {copied ? "Copied ✓" : "Copy"}
        </button>
      </div>

      <pre
        ref={bodyRef}
        className="whitespace-pre-wrap break-words rounded-xl bg-white/[0.04] p-3.5 font-sans text-[14px] leading-relaxed text-ink-2"
      >
        {preview}
      </pre>

      {draft.length > 260 && (
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          className="self-start text-[13px] text-accent-text hover:underline"
        >
          {open ? "Show less" : "Show full draft"}
        </button>
      )}
    </div>
  );
}
