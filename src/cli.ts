#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { targetReload, type TargetReloadOptions } from "./index.js";
import type { BrowserName } from "./browser.js";

function parseArgs(argv: string[]): Record<string, string | boolean> {
  const args: Record<string, string | boolean> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) continue;
    const key = a.slice(2);
    const next = argv[i + 1];
    if (!next || next.startsWith("--")) args[key] = true;
    else {
      args[key] = next;
      i++;
    }
  }
  return args;
}

const args = parseArgs(process.argv.slice(2));

if (args.help) {
  console.log(`
target-reload — build & QA Adobe Target experiences locally

Usage:
  target-reload --url <url> --entry <file> [options]

Options:
  --url        <url>                     Page to open and inject into   (required)
  --entry      <file>                    Experience source: .html/.js/.ts/.css
  --config     <file>                    Load options from a JSON config
  --watch      <path>                    Dir/glob to watch    (default: entry's dir)
  --browser    chromium|firefox|webkit   Engine               (default: chromium)
  --channel    <name>                    Installed browser, e.g. chrome|msedge
  --headless                             Run headless
  --target     head|body                 Injection point      (default: head)
  --mode       reload|hot                Reload+inject, or inject-only (default: reload)
  --bundle                               esbuild-bundle .js/.ts
  --isolate                              Block Adobe edge/analytics
  --profile    <dir>                     Persistent profile dir for logins
  --fresh-session                        Start logged-out: clear cookies at launch
  --verbose                              Log aborted requests too (off: tracker noise)
  --debounce   <ms>                      Batch window         (default: 100)

Keys (while running):  r = reload+inject   i = inject only   q = quit

Auth: set staging basic-auth via env  TARGET_USER  /  TARGET_PASS
`);
  process.exit(0);
}

// Config file merges under CLI flags (flags win).
let fileConfig: Partial<TargetReloadOptions> = {};
if (args.config) {
  const p = path.resolve(String(args.config));
  fileConfig = JSON.parse(fs.readFileSync(p, "utf8"));
}

const url = (args.url as string) ?? fileConfig.url;
const entry = (args.entry as string) ?? fileConfig.entry;

if (!url || !entry) {
  console.error("Missing --url and/or --entry (or provide them via --config). Try --help.");
  process.exit(1);
}

const httpCredentials =
  process.env.TARGET_USER && process.env.TARGET_PASS
    ? { username: process.env.TARGET_USER, password: process.env.TARGET_PASS }
    : fileConfig.httpCredentials;

targetReload({
  ...fileConfig,
  url,
  entry,
  watch: args.watch ? String(args.watch) : fileConfig.watch,
  browser: (args.browser as BrowserName) ?? fileConfig.browser,
  channel: args.channel ? String(args.channel) : fileConfig.channel,
  headless: args.headless ? true : fileConfig.headless,
  injectTarget: (args.target as "head" | "body") ?? fileConfig.injectTarget,
  injectMode: (args.mode as "reload" | "hot") ?? fileConfig.injectMode,
  bundle: args.bundle ? true : fileConfig.bundle,
  isolate: args.isolate ? true : fileConfig.isolate,
  verbose: args.verbose ? true : fileConfig.verbose,
  freshSession: args["fresh-session"] ? true : fileConfig.freshSession,
  userDataDir: args.profile ? String(args.profile) : fileConfig.userDataDir,
  httpCredentials,
  debounce: args.debounce ? Number(args.debounce) : fileConfig.debounce,
}).then(({ reinject, stop }) => {
  if (!process.stdin.isTTY) return;
  // Raw mode: single keypresses without Enter. Ctrl-C no longer raises SIGINT,
  // so handle \u0003 explicitly.
  process.stdin.setRawMode(true);
  process.stdin.resume();
  process.stdin.setEncoding("utf8");
  console.log("[target-reload] keys: r = reload+inject, i = inject only, q = quit");
  process.stdin.on("data", (key: string) => {
    if (key === "r") {
      console.log("[target-reload] manual reload+inject");
      reinject("reload").catch((err) => console.error("[target-reload]", err.message));
    } else if (key === "i") {
      console.log("[target-reload] manual inject");
      reinject("hot").catch((err) => console.error("[target-reload]", err.message));
    } else if (key === "q" || key === "\u0003") {
      stop().finally(() => process.exit(0));
    }
  });
}).catch((err) => {
  console.error(err);
  process.exit(1);
});
