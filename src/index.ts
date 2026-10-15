import path from "node:path";
import { TargetBrowser, type BrowserName } from "./browser.js";
import { buildExperience } from "./build.js";
import { watch } from "./watcher.js";

export interface TargetReloadOptions {
  /** Page to open and inject into. */
  url: string;
  /** Experience source file(s): .html, .js, .ts, or .css. */
  entry: string | string[];

  browser?: BrowserName; // default "chromium"
  /** Use an installed browser (e.g. "chrome", "msedge") instead of bundled Chromium. */
  channel?: string;
  headless?: boolean; // default false
  /** Path(s) to watch. Defaults to the directory of `entry`. */
  watch?: string | string[];
  injectTarget?: "head" | "body"; // default "head"
  /** "reload" = full navigation + re-inject (default). "hot" = re-inject only. */
  injectMode?: "reload" | "hot";
  /** Bundle .js through esbuild (imports/modern syntax). .ts always bundles. */
  bundle?: boolean;
  isolate?: boolean; // block Adobe edge/analytics
  isolateBlocklist?: string[];
  /** Log every failed request (default: aborted tracker beacons are suppressed). */
  verbose?: boolean;
  /** Start as a fresh visitor: clear cookies at launch (profile dir is kept). */
  freshSession?: boolean;
  /** Persistent profile dir so staging logins persist. */
  userDataDir?: string;
  /** Basic-auth for gated staging pages. */
  httpCredentials?: { username: string; password: string };
  debounce?: number;
}

export interface TargetReloadHandle {
  browser: TargetBrowser;
  /** Rebuild the experience and re-inject on demand. Defaults to the configured mode. */
  reinject: (mode?: "reload" | "hot") => Promise<void>;
  stop: () => Promise<void>;
}

export async function targetReload(
  options: TargetReloadOptions,
): Promise<TargetReloadHandle> {
  const entries = Array.isArray(options.entry) ? options.entry : [options.entry];
  const watchPaths =
    options.watch ?? entries.map((e) => path.dirname(path.resolve(e)));
  const mode = options.injectMode ?? "reload";

  const browser = new TargetBrowser({
    url: options.url,
    browser: options.browser,
    channel: options.channel,
    headless: options.headless,
    injectTarget: options.injectTarget,
    isolate: options.isolate,
    isolateBlocklist: options.isolateBlocklist,
    userDataDir: options.userDataDir,
    httpCredentials: options.httpCredentials,
    verbose: options.verbose,
    freshSession: options.freshSession,
  });

  await browser.start();

  const reinject = async (m: "reload" | "hot" = mode) => {
    const html = await buildExperience(entries, { bundle: options.bundle });
    if (m === "hot") await browser.inject(html);
    else await browser.reloadAndInject(html);
  };

  await reinject("hot"); // page just loaded via start(); no need to reload
  const rel = (p: string) => path.relative(process.cwd(), p) || ".";
  console.log(`[target-reload] injected ${entries.map(rel).join(", ")} into ${options.url}`);
  const watchList = (Array.isArray(watchPaths) ? watchPaths : [watchPaths]).map(rel);
  console.log(`[target-reload] watching ${watchList.join(", ")} (mode: ${mode})`);

  const watcher = watch(
    { paths: watchPaths, debounce: options.debounce },
    async (files) => {
      try {
        await reinject();
        console.log(`[target-reload] updated (${files.length} file(s))`);
      } catch (err) {
        console.error("[target-reload] build failed:", (err as Error).message);
      }
    },
  );

  const stop = async () => {
    await watcher.close();
    await browser.close();
  };

  const onSignal = () => stop().finally(() => process.exit(0));
  process.once("SIGINT", onSignal);
  process.once("SIGTERM", onSignal);

  return { browser, reinject, stop };
}

export { TargetBrowser } from "./browser.js";
export { buildExperience } from "./build.js";
export type { BrowserName } from "./browser.js";
