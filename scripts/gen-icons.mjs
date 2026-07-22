// Generates PWA icons into public/icons/ from an inline SVG.
// Run: npm run icons
import sharp from "sharp";
import { mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const outDir = fileURLToPath(new URL("../public/icons/", import.meta.url));
await mkdir(outDir, { recursive: true });

function iconSvg(size, { maskable = false } = {}) {
  const rx = maskable ? 0 : Math.round(size * 0.2);
  // Node-graph motif to evoke a "second brain".
  const s = (f) => Math.round(size * f);
  const scale = maskable ? 0.78 : 1; // keep content in the maskable safe zone
  const c = size / 2;
  const pt = (fx, fy) => [c + (s(fx) - c) * scale, c + (s(fy) - c) * scale];
  const [cxr, cyr] = pt(0.5, 0.54);
  const nodes = [pt(0.3, 0.32), pt(0.72, 0.34), pt(0.52, 0.78)];
  const nr = size * 0.045 * scale;
  const cr = size * 0.06 * scale;
  const sw = size * 0.014 * scale;
  const lines = nodes
    .map(
      ([x, y]) =>
        `<line x1="${cxr}" y1="${cyr}" x2="${x}" y2="${y}" stroke="white" stroke-opacity="0.75" stroke-width="${sw}"/>`
    )
    .join("");
  const dots = nodes
    .map(([x, y]) => `<circle cx="${x}" cy="${y}" r="${nr}" fill="white"/>`)
    .join("");
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">
  <defs>
    <linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#7c3aed"/>
      <stop offset="1" stop-color="#0a0a0a"/>
    </linearGradient>
  </defs>
  <rect width="${size}" height="${size}" rx="${rx}" fill="url(#g)"/>
  ${lines}
  <circle cx="${cxr}" cy="${cyr}" r="${cr}" fill="white"/>
  ${dots}
</svg>`;
}

async function render(name, size, opts) {
  const svg = Buffer.from(iconSvg(size, opts));
  await sharp(svg).png().toFile(outDir + name);
  console.log("wrote", "public/icons/" + name);
}

await render("icon-192.png", 192);
await render("icon-512.png", 512);
await render("maskable-512.png", 512, { maskable: true });
await render("apple-touch-icon.png", 180);
console.log("done.");
