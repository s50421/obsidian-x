"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { enqueue, queueSize, flushQueue } from "@/lib/offline-queue";
import { SectionLabel, TypeChip, PriorityChip } from "./ui";
import { downscaleImage, isImageFile } from "./downscaleImage";

function pickMimeType(): string | undefined {
  if (typeof MediaRecorder === "undefined") return undefined;
  const cands = ["audio/webm;codecs=opus", "audio/webm", "audio/mp4", "audio/aac"];
  for (const c of cands) {
    if (MediaRecorder.isTypeSupported?.(c)) return c;
  }
  return undefined;
}

function formatFromMime(m: string): string {
  if (m.includes("webm")) return "webm";
  if (m.includes("mp4")) return "mp4";
  if (m.includes("mpeg")) return "mp3";
  if (m.includes("ogg")) return "ogg";
  if (m.includes("wav")) return "wav";
  return "webm";
}

function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onload = () => resolve(String(fr.result).split(",")[1] ?? "");
    fr.onerror = reject;
    fr.readAsDataURL(blob);
  });
}

type Entity = { name: string; kind: string };
type LinkRef = { id: string; title: string };

type CreatedItem = {
  item: {
    id: string;
    type: string;
    title: string;
    tags: string[] | null;
    priority: string;
  };
  due_at: string | null;
  needs_review: boolean;
  review_reason: string | null;
  entities: Entity[];
  links: LinkRef[];
  vault_path: string | null;
  vault_url: string | null;
  vaultError: string | null;
};

type CaptureResult = {
  created: CreatedItem[];
  confidence: number;
  split: boolean;
};

function formatDue(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

function NeutralChip({ children }: { children: React.ReactNode }) {
  return (
    <span className="inline-flex items-center rounded-full bg-white/[0.06] px-2.5 py-0.5 text-xs font-semibold text-ink-2">
      {children}
    </span>
  );
}

export default function Capture() {
  const [text, setText] = useState("");
  const [saving, setSaving] = useState(false);
  const [result, setResult] = useState<CaptureResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [pending, setPending] = useState(0);
  const [recording, setRecording] = useState(false);
  const [transcribing, setTranscribing] = useState(false);
  const [uploading, setUploading] = useState(false);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const fileRef = useRef<HTMLInputElement>(null);

  // Keep the pending badge in sync and flush the queue when possible.
  useEffect(() => {
    const sync = () => setPending(queueSize());
    sync();
    window.addEventListener("obx:queue", sync);
    const tryFlush = async () => {
      const n = await flushQueue();
      if (n > 0) setNotice(`Synced ${n} offline ${n === 1 ? "note" : "notes"}.`);
    };
    window.addEventListener("online", tryFlush);
    tryFlush();
    return () => {
      window.removeEventListener("obx:queue", sync);
      window.removeEventListener("online", tryFlush);
    };
  }, []);

  const save = useCallback(async () => {
    const body = text.trim();
    if (!body || saving) return;
    setSaving(true);
    setError(null);
    setResult(null);
    setNotice(null);

    // Offline: queue immediately, don't even try the network.
    if (typeof navigator !== "undefined" && !navigator.onLine) {
      enqueue(body);
      setText("");
      setNotice("You're offline — saved locally, will sync when you're back online.");
      setSaving(false);
      return;
    }

    try {
      const res = await fetch("/api/capture", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: body }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || `save failed (${res.status})`);
      setResult(data);
      setText("");
      window.dispatchEvent(new Event("obx:captured"));
    } catch (e) {
      // Network failure — queue it rather than lose it.
      if (typeof navigator !== "undefined" && !navigator.onLine) {
        enqueue(body);
        setText("");
        setNotice("Connection dropped — saved locally, will sync later.");
      } else {
        setError(e instanceof Error ? e.message : String(e));
      }
    } finally {
      setSaving(false);
    }
  }, [text, saving]);

  // Voice capture: record → transcribe (OpenRouter) → drop text into the box to
  // review/edit, then Save through the normal pipeline.
  const startRecording = useCallback(async () => {
    setError(null);
    setNotice(null);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const mime = pickMimeType();
      const mr = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined);
      chunksRef.current = [];
      mr.ondataavailable = (e) => {
        if (e.data.size) chunksRef.current.push(e.data);
      };
      mr.onstop = async () => {
        stream.getTracks().forEach((t) => t.stop());
        const blob = new Blob(chunksRef.current, { type: mr.mimeType });
        // A broken/empty recording (common on iOS if the tab lost focus) yields a
        // tiny blob; sending it just makes the model invent — so bail out.
        if (blob.size < 1200) {
          setNotice("Didn't catch any audio — try holding Speak a moment longer.");
          return;
        }
        setTranscribing(true);
        try {
          const audio = await blobToBase64(blob);
          const res = await fetch("/api/voice", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ audio, format: formatFromMime(mr.mimeType || "") }),
          });
          const data = await res.json();
          if (!res.ok) throw new Error(data.error || "transcription failed");
          const heard = (data.text || "").trim();
          if (heard) setText((prev) => (prev ? `${prev} ${heard}` : heard));
          else setNotice("Didn't catch any speech — try again.");
        } catch (e) {
          setError(e instanceof Error ? e.message : String(e));
        } finally {
          setTranscribing(false);
        }
      };
      mr.start();
      recorderRef.current = mr;
      setRecording(true);
    } catch {
      setError("Microphone unavailable or permission denied.");
    }
  }, []);

  const stopRecording = useCallback(() => {
    recorderRef.current?.stop();
    setRecording(false);
  }, []);

  // Document upload: extract text server-side, classify, store — shows the same
  // result card as a typed capture.
  const onUploadFile = useCallback(async (e: React.ChangeEvent<HTMLInputElement>) => {
    const picked = e.target.files?.[0];
    e.target.value = ""; // allow re-picking the same file
    if (!picked) return;
    setUploading(true);
    setError(null);
    setResult(null);
    setNotice(`Reading ${picked.name}…`);
    try {
      // Shrink big images client-side so photos fit under the 4 MB cap.
      const f = isImageFile(picked) ? await downscaleImage(picked) : picked;
      if (f.size > 4 * 1024 * 1024) {
        setError(
          isImageFile(picked)
            ? "Image too large (max 4 MB) even after shrinking — try a screenshot or JPEG."
            : "File too large (max 4 MB)."
        );
        setNotice(null);
        setUploading(false);
        return;
      }
      const fd = new FormData();
      fd.append("file", f);
      const res = await fetch("/api/upload", { method: "POST", body: fd });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || `upload failed (${res.status})`);
      setResult(data);
      setNotice(null);
      window.dispatchEvent(new Event("obx:captured"));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setNotice(null);
    } finally {
      setUploading(false);
    }
  }, []);

  return (
    <section>
      <div className="mb-2.5 flex items-center justify-between px-1">
        <SectionLabel>Capture</SectionLabel>
        {pending > 0 && (
          <span
            className="inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-semibold"
            style={{ background: "rgba(240,194,106,0.14)", color: "#f0c26a" }}
          >
            {pending} queued offline
          </span>
        )}
      </div>

      <div className="flex flex-col gap-3 rounded-card border border-hairline bg-surface-1 p-4">
        <textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if ((e.metaKey || e.ctrlKey) && e.key === "Enter") save();
          }}
          placeholder="Jot anything — a task, an idea, a name…  (⌘/Ctrl + Enter)"
          rows={3}
          className="min-h-16 w-full resize-y bg-transparent text-[16px] leading-relaxed text-ink outline-none placeholder:text-ink-3"
        />
        <div className="flex gap-2.5 md:justify-end">
          <button
            onClick={save}
            disabled={saving || uploading || !text.trim()}
            className="h-11 flex-1 rounded-control bg-accent text-[15px] font-semibold text-white transition disabled:opacity-40 md:flex-none md:px-7"
          >
            {saving ? "Saving…" : "Save"}
          </button>
          <button
            onClick={recording ? stopRecording : startRecording}
            disabled={saving || transcribing || uploading}
            className={`flex h-11 flex-1 items-center justify-center gap-2 rounded-control text-[15px] font-semibold transition disabled:opacity-40 md:flex-none md:px-5 ${
              recording ? "bg-accent-soft text-accent-text" : "bg-white/[0.08] text-ink"
            }`}
            title="Record a voice note"
          >
            {recording ? (
              <>
                <span
                  className="h-2 w-2 rounded-full"
                  style={{ background: "#f49a91", animation: "obx-pulse 1.1s infinite" }}
                />
                Stop
              </>
            ) : transcribing ? (
              "Transcribing…"
            ) : (
              "🎤 Speak"
            )}
          </button>
          <input
            ref={fileRef}
            type="file"
            accept=".pdf,.docx,.txt,.md,.markdown,.csv,.tsv,.json,.log,.png,.jpg,.jpeg,.webp,.gif,application/pdf,text/plain,image/*"
            onChange={onUploadFile}
            className="hidden"
          />
          <button
            onClick={() => fileRef.current?.click()}
            disabled={saving || transcribing || uploading}
            className="flex h-11 items-center justify-center rounded-control bg-white/[0.08] px-4 text-[15px] font-semibold text-ink transition disabled:opacity-40"
            title="Upload a document or screenshot (PDF, DOCX, text, image)"
          >
            {uploading ? "…" : "📎"}
          </button>
        </div>
      </div>

      {(error || notice) && (
        <p className={`mt-2 px-1 text-sm ${error ? "text-danger" : "text-ink-2"}`}>{error ?? notice}</p>
      )}

      {result && (
        <div className="mt-3 space-y-2.5">
          {result.split && (
            <p className="px-1 text-xs text-ink-3">Split into {result.created.length} notes.</p>
          )}
          {result.created.map((c) => (
            <div key={c.item.id} className="rounded-card border border-hairline bg-surface-1 p-4 text-[15px]">
              <div className="flex flex-wrap items-center gap-2">
                <TypeChip type={c.item.type} />
                <PriorityChip priority={c.item.priority} />
                {c.due_at && <NeutralChip>due {formatDue(c.due_at)}</NeutralChip>}
                {(c.item.tags ?? []).map((t) => (
                  <NeutralChip key={t}>#{t}</NeutralChip>
                ))}
              </div>

              <div className="mt-2 leading-snug">{c.item.title}</div>

              {c.needs_review && (
                <div
                  className="mt-2 rounded-control px-3 py-1.5 text-xs font-medium"
                  style={{ background: "rgba(240,194,106,0.14)", color: "#f0c26a" }}
                >
                  Needs review — {c.review_reason ?? "please confirm"} · see Review
                </div>
              )}

              {c.entities.length > 0 && (
                <div className="mt-2 text-xs text-ink-2">
                  People/places: {c.entities.map((e) => e.name).join(", ")}
                </div>
              )}

              {c.links.length > 0 && (
                <div className="mt-1 text-xs text-ink-2">
                  Linked to: {c.links.map((l) => l.title).join(", ")}
                </div>
              )}

              <div className="mt-2 text-xs">
                {c.vault_url ? (
                  <a href={c.vault_url} target="_blank" rel="noreferrer" className="text-accent-text hover:underline">
                    ↗ Written to vault: {c.vault_path}
                  </a>
                ) : (
                  <span className="text-warn">
                    Saved to database, but vault write failed
                    {c.vaultError ? `: ${c.vaultError}` : ""}
                  </span>
                )}
              </div>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}
