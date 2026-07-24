"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { enqueue, queueSize, flushQueue } from "@/lib/offline-queue";

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

export default function Capture() {
  const [text, setText] = useState("");
  const [saving, setSaving] = useState(false);
  const [result, setResult] = useState<CaptureResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [pending, setPending] = useState(0);
  const [recording, setRecording] = useState(false);
  const [transcribing, setTranscribing] = useState(false);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);

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
      const mr = new MediaRecorder(stream);
      chunksRef.current = [];
      mr.ondataavailable = (e) => {
        if (e.data.size) chunksRef.current.push(e.data);
      };
      mr.onstop = async () => {
        stream.getTracks().forEach((t) => t.stop());
        const blob = new Blob(chunksRef.current, { type: mr.mimeType });
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

  return (
    <section>
      <div className="mb-2 flex items-center justify-between">
        <h2 className="text-sm font-medium uppercase tracking-wide opacity-60">
          Capture
        </h2>
        {pending > 0 && (
          <span className="rounded-full border border-amber-500/40 bg-amber-500/10 px-2 py-0.5 text-xs text-amber-700 dark:text-amber-400">
            {pending} queued offline
          </span>
        )}
      </div>
      <textarea
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if ((e.metaKey || e.ctrlKey) && e.key === "Enter") save();
        }}
        placeholder="Type a thought, note, task, idea…  (⌘/Ctrl + Enter to save)"
        rows={5}
        className="w-full resize-y rounded-lg border border-black/15 bg-transparent p-3 text-sm outline-none focus:border-black/40 dark:border-white/20 dark:focus:border-white/50"
      />
      <div className="mt-2 flex items-center gap-3">
        <button
          onClick={save}
          disabled={saving || !text.trim()}
          className="rounded-md bg-foreground px-4 py-2 text-sm font-medium text-background transition disabled:opacity-40"
        >
          {saving ? "Saving…" : "Save"}
        </button>
        <button
          onClick={recording ? stopRecording : startRecording}
          disabled={saving || transcribing}
          className={`rounded-md border px-3 py-2 text-sm font-medium transition disabled:opacity-40 ${
            recording
              ? "border-red-500/50 bg-red-500/10 text-red-600"
              : "border-black/15 hover:bg-black/5 dark:border-white/20 dark:hover:bg-white/10"
          }`}
          title="Record a voice note"
        >
          {recording ? "⏹ Stop" : transcribing ? "Transcribing…" : "🎤 Speak"}
        </button>
        {error && <span className="text-sm text-red-500">{error}</span>}
        {notice && <span className="text-sm opacity-70">{notice}</span>}
      </div>

      {result && (
        <div className="mt-3 space-y-2">
          {result.split && (
            <p className="text-xs opacity-60">
              Split into {result.created.length} notes.
            </p>
          )}
          {result.created.map((c) => (
            <div
              key={c.item.id}
              className="rounded-lg border border-black/10 p-3 text-sm dark:border-white/15"
            >
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-medium">{c.item.title}</span>
                <Badge>{c.item.type}</Badge>
                <Badge>priority: {c.item.priority}</Badge>
                {c.due_at && <Badge>due {formatDue(c.due_at)}</Badge>}
                {(c.item.tags ?? []).map((t) => (
                  <Badge key={t}>#{t}</Badge>
                ))}
              </div>

              {c.needs_review && (
                <div className="mt-2 rounded-md border border-amber-500/40 bg-amber-500/10 px-2 py-1 text-xs text-amber-700 dark:text-amber-400">
                  Needs review — {c.review_reason ?? "please confirm"} · see Review below
                </div>
              )}

              {c.entities.length > 0 && (
                <div className="mt-2 text-xs opacity-70">
                  People/places: {c.entities.map((e) => e.name).join(", ")}
                </div>
              )}

              {c.links.length > 0 && (
                <div className="mt-1 text-xs opacity-70">
                  Linked to: {c.links.map((l) => l.title).join(", ")}
                </div>
              )}

              <div className="mt-2 text-xs opacity-70">
                {c.vault_url ? (
                  <a href={c.vault_url} target="_blank" rel="noreferrer" className="underline">
                    Written to vault: {c.vault_path}
                  </a>
                ) : (
                  <span className="text-amber-600">
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

function Badge({ children }: { children: React.ReactNode }) {
  return (
    <span className="rounded-full border border-black/15 px-2 py-0.5 text-xs opacity-80 dark:border-white/20">
      {children}
    </span>
  );
}
