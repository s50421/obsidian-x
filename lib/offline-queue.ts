// Client-side offline capture queue (localStorage-backed). Captures made while
// offline (or when a request fails) are queued and flushed when back online.

const KEY = "obx.capture.queue.v1";

export type QueuedCapture = { id: string; text: string; createdAt: string };

function read(): QueuedCapture[] {
  if (typeof window === "undefined") return [];
  try {
    return JSON.parse(localStorage.getItem(KEY) || "[]") as QueuedCapture[];
  } catch {
    return [];
  }
}

function write(q: QueuedCapture[]): void {
  localStorage.setItem(KEY, JSON.stringify(q));
  window.dispatchEvent(new Event("obx:queue"));
}

export function enqueue(text: string): QueuedCapture {
  const item: QueuedCapture = {
    id: crypto.randomUUID(),
    text,
    createdAt: new Date().toISOString(),
  };
  write([...read(), item]);
  return item;
}

export function queueSize(): number {
  return read().length;
}

function removeFromQueue(id: string): void {
  write(read().filter((i) => i.id !== id));
}

let flushing = false;

// Flush queued captures by POSTing each to /api/capture. Returns how many synced.
export async function flushQueue(): Promise<number> {
  if (flushing) return 0;
  if (typeof navigator !== "undefined" && !navigator.onLine) return 0;
  flushing = true;
  let synced = 0;
  try {
    for (const item of read()) {
      try {
        const res = await fetch("/api/capture", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ text: item.text }),
        });
        if (res.ok) {
          removeFromQueue(item.id);
          synced++;
        } else {
          // 401 (logged out) or server error — leave queued and retry later.
          break;
        }
      } catch {
        // network error — stop; we're offline again.
        break;
      }
    }
  } finally {
    flushing = false;
  }
  if (synced > 0) window.dispatchEvent(new Event("obx:captured"));
  return synced;
}
