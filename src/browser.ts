import fs from "node:fs/promises";
import path from "node:path";
import {
  chromium,
  firefox,
  webkit,
  type BrowserContext,
  type Page,
  type BrowserType,
} from "playwright";

export type BrowserName = "chromium" | "firefox" | "webkit";

const engines: Record<BrowserName, BrowserType> = { chromium, firefox, webkit };

/** Adobe edge / analytics hosts blocked in isolate mode so only your code runs. */
const DEFAULT_BLOCKLIST = [
  "tt.omtrdc.net", // Target delivery
  "sc.omtrdc.net", // Analytics collection
  "demdex.net", // Audience Manager / ECID
  "adobedc.net", // Edge Network / Web SDK
  ".2o7.net", // legacy Analytics
];

export interface TargetBrowserOptions {
  url: string;
  browser?: BrowserName;
  /** Use an installed browser (e.g. "chrome", "msedge") instead of bundled Chromium. */
  channel?: string;
  headless?: boolean;
  /** Persistent profile dir so staging logins survive reloads/restarts. */
  userDataDir?: string;
  /** Basic-auth gate on staging (username/password). */
  httpCredentials?: { username: string; password: string };
  isolate?: boolean;
  isolateBlocklist?: string[];
  injectTarget?: "head" | "body";
  /** Log every failed request. Off by default (aborted tracker beacons are noise). */
  verbose?: boolean;
  /** Start logged-out with no cookies (profile dir is kept). Default: resume session. */
  freshSession?: boolean;
}

export class TargetBrowser {
  private context?: BrowserContext;
  private page?: Page;
  private lastHtml?: string;
  private readonly opts: Required<
    Pick<TargetBrowserOptions, "url" | "browser" | "headless" | "injectTarget">
  > &
    TargetBrowserOptions;

  constructor(opts: TargetBrowserOptions) {
    this.opts = {
      ...opts,
      browser: opts.browser ?? "chromium",
      headless: opts.headless ?? false,
      injectTarget: opts.injectTarget ?? "head",
    };
  }

  async start(): Promise<void> {
    const engine = engines[this.opts.browser];
    const userDataDir =
      this.opts.userDataDir ?? path.resolve(process.cwd(), ".target-reload-profile");

    await this.prepareProfile(userDataDir);

    // Persistent context: keeps you logged into staging between runs.
    this.context = await engine.launchPersistentContext(userDataDir, {
      channel: this.opts.channel,
      headless: this.opts.headless,
      bypassCSP: true, // <-- without this, injected <script> is killed by CSP
      httpCredentials: this.opts.httpCredentials,
      viewport: null,
    });

    // Fresh visitor: drop all cookies (login, ECID, Target membership) but keep the profile.
    if (this.opts.freshSession) await this.context.clearCookies();

    if (this.opts.isolate) await this.applyIsolation();

    // Make a waitForElement helper available to your experience code,
    // before any page script runs, on every navigation.
    await this.context.addInitScript(() => {
      (window as any).__targetReload = {
        waitForElement(selector: string, timeout = 10000) {
          return new Promise((resolve, reject) => {
            const existing = document.querySelector(selector);
            if (existing) return resolve(existing);
            const obs = new MutationObserver(() => {
              const el = document.querySelector(selector);
              if (el) {
                obs.disconnect();
                resolve(el);
              }
            });
            obs.observe(document.documentElement, { childList: true, subtree: true });
            setTimeout(() => {
              obs.disconnect();
              reject(new Error("waitForElement timeout: " + selector));
            }, timeout);
          });
        },
      };
    });

    this.page = this.context.pages()[0] ?? (await this.context.newPage());

    // Surface page-level problems (auth gates, bot protection). Subresource
    // noise (the site's own 404s / cancelled beacons) only with verbose.
    this.page.on("response", (res) => {
      if (res.status() < 400) return;
      const isDocument = res.request().resourceType() === "document";
      if (!this.opts.verbose && !isDocument) return;
      console.warn(`[target-reload] ${res.status()} ${res.url()}`);
    });
    this.page.on("requestfailed", (req) => {
      const errorText = req.failure()?.errorText ?? "?";
      const isDocument = req.resourceType() === "document";
      if (!this.opts.verbose && !isDocument) return;
      console.warn(`[target-reload] FAILED ${errorText} ${req.url()}`);
    });

    // Keep the experience injected across user-driven navigations
    // (login redirects, clicked links). inject() is idempotent, so the
    // extra fire on tool-driven reloads is harmless.
    this.page.on("load", () => {
      if (!this.lastHtml) return;
      this.inject(this.lastHtml).catch(() => {
        // Navigation raced the injection; the next load will retry.
      });
    });

    await this.page.goto(this.opts.url, { waitUntil: "load" });
  }

  /**
   * Chrome purges session cookies (SSO logins) on startup unless "continue where
   * you left off" is set. Write that pref into the profile so logins survive
   * CLI restarts, and mark the last exit clean to suppress the restore bubble.
   */
  private async prepareProfile(userDataDir: string): Promise<void> {
    if (this.opts.browser !== "chromium") return;
    try {
      const prefsPath = path.join(userDataDir, "Default", "Preferences");
      let prefs: Record<string, any> = {};
      try {
        prefs = JSON.parse(await fs.readFile(prefsPath, "utf8"));
      } catch {
        await fs.mkdir(path.dirname(prefsPath), { recursive: true });
      }
      prefs.session = {
        ...prefs.session,
        // Fresh session: let Chrome purge session cookies on startup as usual.
        restore_on_startup: this.opts.freshSession ? 5 : 1,
      };
      prefs.profile = { ...prefs.profile, exit_type: "Normal" };
      await fs.writeFile(prefsPath, JSON.stringify(prefs));
    } catch {
      // Non-fatal: worst case, session cookies don't survive a restart.
    }
  }

  private async applyIsolation(): Promise<void> {
    if (!this.context) return;
    const blocklist = this.opts.isolateBlocklist ?? DEFAULT_BLOCKLIST;
    await this.context.route("**/*", (route) => {
      const url = route.request().url();
      if (blocklist.some((host) => url.includes(host))) return route.abort();
      return route.continue();
    });
  }

  /** Reload the page, then re-inject (clean slate — mirrors a real page load). */
  async reloadAndInject(html: string): Promise<void> {
    if (!this.page) return;
    await this.page.reload({ waitUntil: "load" });
    await this.inject(html);
  }

  /**
   * Inject an HTML fragment into <head> (or <body>). Removes any previously
   * injected nodes first, and re-creates <script> elements so they execute —
   * innerHTML-parsed scripts do not run on their own.
   */
  async inject(html: string): Promise<void> {
    if (!this.page) return;
    this.lastHtml = html;
    await this.page.evaluate(
      ({ html, target }) => {
        document.querySelectorAll("[data-target-reload]").forEach((n) => n.remove());
        const parent = target === "body" ? document.body : document.head;
        const tpl = document.createElement("template");
        tpl.innerHTML = html;

        Array.from(tpl.content.childNodes).forEach((node) => {
          let out: Node = node;
          if (node.nodeName === "SCRIPT") {
            const original = node as HTMLScriptElement;
            const script = document.createElement("script");
            for (const attr of Array.from(original.attributes)) {
              script.setAttribute(attr.name, attr.value);
            }
            script.textContent = original.textContent;
            out = script;
          }
          if (out.nodeType === 1) {
            (out as Element).setAttribute("data-target-reload", "");
          }
          parent.appendChild(out);
        });
      },
      { html, target: this.opts.injectTarget },
    );
  }

  async close(): Promise<void> {
    await this.context?.close();
  }
}
