import chokidar, { type FSWatcher } from "chokidar";

export interface WatchOptions {
  paths: string | string[];
  ignore?: RegExp | string;
  /** Coalesce write bursts (e.g. a bundler flush) into one reload. Default 100ms. */
  debounce?: number;
}

export function watch(
  opts: WatchOptions,
  onChange: (files: string[]) => void,
): FSWatcher {
  const watcher = chokidar.watch(opts.paths, {
    ignored: opts.ignore ?? /(^|[/\\])\../,
    ignoreInitial: true,
    persistent: true,
  });

  let pending = new Set<string>();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const debounce = opts.debounce ?? 100;

  const flush = () => {
    const files = [...pending];
    pending = new Set();
    if (files.length) onChange(files);
  };

  const schedule = (file: string) => {
    pending.add(file);
    if (timer) clearTimeout(timer);
    timer = setTimeout(flush, debounce);
  };

  watcher
    .on("change", schedule)
    .on("add", schedule)
    .on("unlink", schedule)
    .on("error", (err) => console.error("[target-reload] watcher error:", err));

  return watcher;
}
