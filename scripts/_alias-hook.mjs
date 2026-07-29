// Module resolver hook for the W2 tests: maps the app's "@/..." import alias to
// the repo root so `node --experimental-strip-types` can load lib/*.ts directly.
// Test-only — Next.js resolves the alias itself at build time (tsconfig paths).
import { pathToFileURL } from "node:url";
import { existsSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

export async function resolve(specifier, context, next) {
  if (specifier.startsWith("@/")) {
    const base = `${ROOT}/${specifier.slice(2)}`;
    for (const candidate of [base, `${base}.ts`, `${base}.tsx`, `${base}/index.ts`]) {
      if (existsSync(candidate)) return next(pathToFileURL(candidate).href, context);
    }
  }
  return next(specifier, context);
}
