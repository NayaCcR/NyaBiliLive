import fs from "node:fs";
import path from "node:path";

const DEFAULT_MAX_BYTES = 10 * 1024 * 1024;
const NOOP = () => {};

/**
 * Console logger that also appends to a rotating file.
 *
 * Managed panel supervisors (e.g. BaoTa's Node project manager) truncate the
 * per-project stdout/stderr file on every restart, so the previous run's
 * evidence is gone exactly when it is needed — that is how the 2026-10-15
 * danmaku outage left no trace in NyaBiliLive.log. Keeping our own file under
 * data/logs/ survives supervisor restarts and lets the next incident be
 * diagnosed from disk instead of from memory.
 *
 * Writes are synchronous appends: a low-volume application log does not need
 * buffering, and holding no long-lived handle means the file can be rotated,
 * tailed or removed while the process runs (a rename over an open handle fails
 * on Windows).
 */
export function createFileLogger({
  directory,
  prefix = "nyabililive",
  maxBytes = DEFAULT_MAX_BYTES,
  console: consoleLike = globalThis.console,
} = {}) {
  if (!directory) throw new Error("createFileLogger 需要 directory");
  fs.mkdirSync(directory, { recursive: true });

  const currentPath = () => path.join(directory, `${prefix}.log`);
  const rotatedPath = () => path.join(directory, `${prefix}.log.1`);
  let closed = false;

  const rotate = () => {
    try {
      fs.rmSync(rotatedPath(), { force: true });
      fs.renameSync(currentPath(), rotatedPath());
    } catch {}
  };

  const write = (level, args) => {
    const call = consoleLike?.[level];
    if (typeof call === "function") call.apply(consoleLike, args);
    if (closed) return;
    const line = `${new Date().toISOString()} [${level}] ${args
      .map((value) => {
        if (value instanceof Error) return value.stack || value.message;
        if (typeof value === "string") return value;
        try { return JSON.stringify(value); } catch { return String(value); }
      })
      .join(" ")}\n`;
    try {
      const target = currentPath();
      let size = 0;
      try { size = fs.statSync(target).size; } catch {}
      if (size > 0 && size + Buffer.byteLength(line) > maxBytes) rotate();
      fs.appendFileSync(currentPath(), line, { encoding: "utf8", mode: 0o600 });
    } catch {}
  };

  return {
    get path() { return currentPath(); },
    info: (...args) => write("info", args),
    warn: (...args) => write("warn", args),
    error: (...args) => write("error", args),
    log: (...args) => write("info", args),
    debug: (...args) => write("debug", args),
    close() { closed = true; },
  };
}

export function createNoopLogger() {
  return {
    path: "",
    info: NOOP,
    warn: NOOP,
    error: NOOP,
    log: NOOP,
    debug: NOOP,
    close: NOOP,
  };
}
