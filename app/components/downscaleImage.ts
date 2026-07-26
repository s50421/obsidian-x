// v3.1 hardening — shrink large images in the browser before upload so phone
// photos fit under the 4 MB request cap and cost less for the vision model to
// read. Best-effort: returns the original file if the browser can't decode the
// format (e.g. HEIC in some browsers) — the caller's size check still applies.

const IMG_EXTS = ["png", "jpg", "jpeg", "webp", "gif", "bmp", "heic", "heif"];

export function isImageFile(f: File): boolean {
  if ((f.type || "").toLowerCase().startsWith("image/")) return true;
  const ext = /\.([a-z0-9]+)$/i.exec(f.name)?.[1]?.toLowerCase() ?? "";
  return IMG_EXTS.includes(ext);
}

export async function downscaleImage(
  file: File,
  maxDim = 1600,
  maxBytes = 1_500_000
): Promise<File> {
  if (!isImageFile(file)) return file;

  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(file, { imageOrientation: "from-image" } as ImageBitmapOptions);
  } catch {
    return file; // undecodable here (e.g. HEIC) — let the caller/server handle size
  }

  const { width, height } = bitmap;
  const scale = Math.min(1, maxDim / Math.max(width, height));
  // Already small in both dimensions and under budget → send as-is.
  if (scale === 1 && file.size <= maxBytes) {
    bitmap.close?.();
    return file;
  }

  const w = Math.max(1, Math.round(width * scale));
  const h = Math.max(1, Math.round(height * scale));
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d");
  if (!ctx) {
    bitmap.close?.();
    return file;
  }
  ctx.drawImage(bitmap, 0, 0, w, h);
  bitmap.close?.();

  const toBlob = (type: string, q?: number) =>
    new Promise<Blob | null>((r) => canvas.toBlob(r, type, q));

  // Prefer PNG (crisp text for screenshots); fall back to JPEG if too large.
  let blob = await toBlob("image/png");
  let outType = "image/png";
  if (!blob || blob.size > maxBytes) {
    const jpg = await toBlob("image/jpeg", 0.85);
    if (jpg) {
      blob = jpg;
      outType = "image/jpeg";
    }
  }
  if (!blob) return file;

  const base = file.name.replace(/\.[a-z0-9]+$/i, "") || "image";
  const ext = outType === "image/png" ? "png" : "jpg";
  return new File([blob], `${base}.${ext}`, { type: outType });
}
