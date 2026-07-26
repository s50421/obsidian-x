// v3.1 — extract plain text from an uploaded document so it can be classified
// into the knowledge base. PDF via unpdf (serverless-friendly pdf.js), DOCX via
// mammoth, and text-ish formats decoded directly. Returns cleaned UTF-8 text.

const TEXT_EXTS = new Set(["txt", "md", "markdown", "csv", "tsv", "json", "log", "text"]);

export type ExtractResult = { text: string; kind: string };

function extOf(name: string): string {
  const m = /\.([a-z0-9]+)$/i.exec(name.trim());
  return m ? m[1].toLowerCase() : "";
}

// Collapse the runs of whitespace/blank lines that extractors tend to emit,
// without destroying paragraph structure.
function tidy(text: string): string {
  return text
    .replace(/\r\n?/g, "\n")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/[ \t]{2,}/g, " ")
    .trim();
}

export async function extractDocument(
  buf: ArrayBuffer,
  filename: string,
  mimeType: string
): Promise<ExtractResult> {
  const ext = extOf(filename);
  const mime = (mimeType || "").toLowerCase();

  // PDF
  if (ext === "pdf" || mime.includes("pdf")) {
    const { extractText, getDocumentProxy } = await import("unpdf");
    const pdf = await getDocumentProxy(new Uint8Array(buf));
    const { text } = await extractText(pdf, { mergePages: true });
    const merged = Array.isArray(text) ? text.join("\n\n") : String(text ?? "");
    return { text: tidy(merged), kind: "pdf" };
  }

  // DOCX (only the modern zipped format; legacy .doc isn't supported)
  if (
    ext === "docx" ||
    mime.includes("officedocument.wordprocessingml") ||
    mime.includes("application/msword")
  ) {
    const mammoth = (await import("mammoth")).default;
    const { value } = await mammoth.extractRawText({ buffer: Buffer.from(buf) });
    return { text: tidy(value ?? ""), kind: "docx" };
  }

  // Text-ish formats
  if (TEXT_EXTS.has(ext) || mime.startsWith("text/") || mime.includes("json")) {
    const decoded = new TextDecoder("utf-8", { fatal: false }).decode(buf);
    return { text: tidy(decoded), kind: ext || "text" };
  }

  throw new Error(`Unsupported file type: ${ext || mime || "unknown"} — try PDF, DOCX, or a text file.`);
}
