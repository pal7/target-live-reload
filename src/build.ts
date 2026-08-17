import fs from "node:fs/promises";
import path from "node:path";

/**
 * Turn your experience source into the HTML fragment that gets injected.
 *
 * - `.html` / `.htm`  → injected verbatim (paste-what-you'd-put-in-Target)
 * - `.css`            → wrapped in <style>
 * - `.js` / `.mjs`    → wrapped in <script> (optionally esbuild-bundled)
 * - `.ts`             → esbuild-bundled, then wrapped in <script>
 *
 * Multiple entries are concatenated in order, so `["experience.css", "experience.js"]`
 * yields <style>…</style> then <script>…</script>.
 */
export async function buildExperience(
  entries: string | string[],
  opts: { bundle?: boolean } = {},
): Promise<string> {
  const list = Array.isArray(entries) ? entries : [entries];
  const parts = await Promise.all(list.map((file) => buildOne(file, opts)));
  return parts.join("\n");
}

async function buildOne(file: string, opts: { bundle?: boolean }): Promise<string> {
  const ext = path.extname(file).toLowerCase();

  if (ext === ".html" || ext === ".htm") {
    return fs.readFile(file, "utf8");
  }
  if (ext === ".css") {
    const css = await fs.readFile(file, "utf8");
    return `<style>\n${css}\n</style>`;
  }
  if (ext === ".js" || ext === ".mjs") {
    const code = opts.bundle ? await bundle(file) : await fs.readFile(file, "utf8");
    return `<script>\n${code}\n</script>`;
  }
  if (ext === ".ts") {
    // TS always needs transpiling.
    const code = await bundle(file);
    return `<script>\n${code}\n</script>`;
  }
  // Unknown: inject raw.
  return fs.readFile(file, "utf8");
}

async function bundle(file: string): Promise<string> {
  let esbuild: typeof import("esbuild");
  try {
    esbuild = await import("esbuild");
  } catch {
    throw new Error(
      `Bundling "${file}" needs esbuild. Install it:  npm i -D esbuild`,
    );
  }
  const result = await esbuild.build({
    entryPoints: [file],
    bundle: true,
    write: false,
    format: "iife",
    target: "es2018",
    platform: "browser",
    legalComments: "none",
  });
  return result.outputFiles[0].text;
}
