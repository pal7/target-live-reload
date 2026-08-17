# @pal7/target-live-reload

Build and QA **Adobe Target experiences** locally. Point it at a real (staging or
prod) page, hand it your experience code, and it injects that code into the page's
`<head>` — the same way a Target custom-code offer would — and re-injects on every
save. Iterate on the UI with instant feedback; only touch Target QA links at the end.

Powered by [Playwright](https://playwright.dev/).

## Why not just use Target QA links

The QA-link loop is: edit in Target → save the activity → generate a QA link →
load it → check → repeat. This collapses that to: edit a local file → see it live.
It also handles the things that make injecting into a real corporate site actually
work:

- **Bypasses CSP** — a corporate site's Content-Security-Policy would otherwise
  silently block your injected `<script>`. This is the whole reason a naive approach fails.
- **Re-executes injected scripts** — `innerHTML` won't run `<script>` tags; the
  injector re-creates them so your code actually fires.
- **Persistent login** — log into staging once in the launched window; the session
  survives reloads and restarts. Basic-auth gates are handled via env vars.
- **Isolate mode** — optionally block the live page's own Target/Analytics so only
  your experience runs.

## Install

```bash
npm install @pal7/target-live-reload playwright
```

`playwright` is a peer dependency, so install it alongside — npm won't pull it in
automatically. `esbuild` is optional, only needed if you author in TypeScript or use
`import`s (`--bundle`).

You also need a browser for Playwright to drive. Two options:

- **Use your installed Google Chrome (recommended, most portable):** pass
  `--channel chrome` at runtime. Required on macOS 13 (Ventura), where Playwright's
  bundled Chromium is unsupported.
- **Use Playwright's bundled Chromium:** `npx playwright install chromium`, then omit
  `--channel`. Works on newer macOS, Linux, and Windows.

## Authoring an experience

Write it exactly like a Target custom-code offer — an HTML blob with `<style>` and
`<script>`:

```html
<style> .promo { background:#0b5cff; color:#fff; } </style>
<script>
  window.__targetReload.waitForElement(".product-hero").then((el) => {
    el.classList.add("promo");
  });
</script>
```

`window.__targetReload.waitForElement(selector, timeoutMs?)` is injected for you, so
your code can safely target elements that render after page load.

You can also author in `.js`, `.ts`, or `.css` (they get wrapped into
`<script>`/`<style>` for you), and pass multiple entries that concatenate in order.

## Run

```bash
# using your installed Chrome
target-reload --url https://www.example.com/ --entry experiences/example/experience.html --channel chrome

# or via a config file
target-reload --config target-reload.config.json --channel chrome
```

### Staging behind basic-auth

```bash
TARGET_USER=qa TARGET_PASS=secret target-reload --config target-reload.config.json --channel chrome
```

Never commit credentials — use env vars.

### Options

| Flag         | Default                  | Notes                                        |
| ------------ | ------------------------ | -------------------------------------------- |
| `--url`      | (required)               | Page to inject into                          |
| `--entry`    | (required)               | `.html` / `.js` / `.ts` / `.css`             |
| `--config`   | —                        | JSON config; CLI flags override it           |
| `--channel`  | —                        | Use an installed browser, e.g. `chrome`      |
| `--watch`    | entry dir                | Dir/glob to watch                            |
| `--browser`  | `chromium`               | `chromium` \| `firefox` \| `webkit`          |
| `--headless` | off                      | —                                            |
| `--target`   | `head`                   | `head` \| `body`                             |
| `--mode`     | `reload`                 | `reload` = nav + inject; `hot` = inject only |
| `--bundle`   | off                      | esbuild-bundle `.js`/`.ts`                   |
| `--isolate`  | off                      | block Adobe edge/analytics                   |
| `--profile`  | `.target-reload-profile` | persistent login profile                     |
| `--debounce` | `100`                    | batch window (ms)                            |

**reload vs hot:** `reload` re-navigates then injects — a clean slate that mirrors a
real page load (recommended). `hot` re-injects without navigating (faster, but your
code should be idempotent since prior DOM/listeners persist).

## Programmatic API

```ts
import { targetReload } from "@pal7/target-live-reload";

const { browser, stop } = await targetReload({
  url: "https://www.example.com/",
  entry: "experiences/example/experience.html",
  channel: "chrome",     // use installed Chrome
  isolate: true,
});

// later:
await stop();
```

`targetReload(options)` resolves to `{ browser, stop }`. Full options: `url`,
`entry` (string or string[]), `channel`, `browser`, `headless`, `watch`,
`injectTarget` (`"head"|"body"`), `injectMode` (`"reload"|"hot"`), `bundle`,
`isolate`, `isolateBlocklist`, `userDataDir`, `httpCredentials`, `debounce`.

Also exported: `TargetBrowser`, `buildExperience`, and the types `BrowserName`,
`TargetReloadOptions`, `TargetReloadHandle`.

## License

MIT