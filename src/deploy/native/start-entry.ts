/**
 * How a native app starts when its author typed no start command.
 *
 * Decided once, at build time, from the built tree (`detectNativeAppStart` in
 * `../release/build.ts`), and recorded with the release. The
 * unit renderer cannot look for itself: a published release is root-owned and
 * readable only by the site owner's Linux user and its group, which the daemon
 * is not in. Recording it also means a rollback restarts the old release the
 * way it was started when it was live, not the way the newest build would be.
 */

/**
 * Next's own CLI, relative to the release root. Stable from Next 9 through 16.
 * Run with the vendored Node directly, never through `node_modules/.bin/next`,
 * whose `#!/usr/bin/env node` shebang depends on `PATH`.
 */
export const NEXT_CLI_PATH = "node_modules/next/dist/bin/next";

/**
 * Address every native app binds. The unit also exports it as `HOST` and
 * `HOSTNAME`, but `next start` reads neither (only its `--hostname` flag), so
 * the Next entry passes it on the command line too.
 */
export const NATIVE_APP_BIND_ADDRESS = "127.0.0.1";

export type NativeAppStart =
  /** `<node> <path>` — a Next standalone `server.js`, `main`, `index.js`, … */
  | { kind: "file"; path: string }
  /**
   * `<node> --run start` — the package's own `start` script. `node --run`
   * runs no `pre`/`post` hooks, so with `prestart: true` (the package has a
   * `prestart` script, often migrations) the unit runs
   * `/bin/sh -c '<node> --run prestart && exec <node> --run start'`, the order
   * a package manager would use.
   */
  | { kind: "start-script"; prestart?: true }
  /** `<node> node_modules/next/dist/bin/next start --hostname 127.0.0.1 --port <port>`. */
  | { kind: "next-start" }
  /**
   * `<deno> task start` — the project's own `start` task in `deno.json` /
   * `deno.jsonc`. A Deno app only.
   */
  | { kind: "deno-task" }
  /**
   * `<deno> run --allow-all <path>` — the entry file from `deno.json` `main` /
   * `exports` / `tasks`, or a conventional file. A Deno app only.
   */
  | { kind: "deno-file"; path: string };

/**
 * Flags a Deno app runs with when the platform picks the command. The
 * permission model is left wide open on purpose: the unit's sandbox (read-only
 * system, one writable folder, no capabilities, no new privileges) is the fence,
 * and Deno's own flags could only repeat it for the same user.
 */
export const DENO_RUN_FLAGS = "--allow-all";

const SAFE_START_PATH_RE = /^[A-Za-z0-9._/-]+$/;

/**
 * A relative path that can sit in an `ExecStart` line as one argument: no
 * spaces, quotes, `%` (systemd specifiers) or `$`, no leading `/` or `-` (a
 * leading dash would be read as a Node option), and no `..` segment. Leading
 * `./` is dropped, so `"main": "./dist/index.js"` renders as `dist/index.js`.
 */
export function normalizeNativeAppStartPath(
  value: string,
): string | undefined {
  let path = value.trim();
  while (path.startsWith("./")) path = path.slice(2);
  if (path.length === 0 || path.length > 200) return undefined;
  if (!SAFE_START_PATH_RE.test(path)) return undefined;
  if (path.startsWith("/") || path.startsWith("-")) return undefined;
  if (path.endsWith("/")) return undefined;
  const segments = path.split("/");
  if (segments.some((segment) => segment === "" || segment === "..")) {
    return undefined;
  }
  return path;
}

/** Shape check for a value read back from a release record. */
export function isNativeAppStart(value: unknown): value is NativeAppStart {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const record = value as Record<string, unknown>;
  if (record.kind === "start-script") {
    return record.prestart === undefined || record.prestart === true;
  }
  if (record.kind === "next-start" || record.kind === "deno-task") return true;
  return (record.kind === "file" || record.kind === "deno-file") &&
    typeof record.path === "string" &&
    normalizeNativeAppStartPath(record.path) === record.path;
}

/**
 * The `ExecStart` argv (no shell) for one recorded start. `nodeBinary` is the
 * runtime's own binary: the vendored Node, or for a `deno-*` start the vendored
 * Deno.
 */
export function nativeAppStartExec(
  start: NativeAppStart,
  nodeBinary: string,
  listenPort: number,
): string {
  switch (start.kind) {
    case "start-script":
      return start.prestart
        ? startWithPrestart(nodeBinary)
        : `${nodeBinary} --run start`;
    case "next-start":
      return `${nodeBinary} ${NEXT_CLI_PATH} start --hostname ${NATIVE_APP_BIND_ADDRESS} --port ${listenPort}`;
    case "deno-task":
      return `${nodeBinary} task start`;
    case "deno-file": {
      const path = normalizeNativeAppStartPath(start.path);
      if (path === undefined) {
        throw new TypeError(`unsafe native app start file: ${start.path}`);
      }
      return `${nodeBinary} run ${DENO_RUN_FLAGS} ${path}`;
    }
    case "file": {
      const path = normalizeNativeAppStartPath(start.path);
      if (path === undefined) {
        throw new TypeError(`unsafe native app start file: ${start.path}`);
      }
      return `${nodeBinary} ${path}`;
    }
  }
}

/**
 * `prestart`, then `start` in its place (`exec`, so systemd supervises the app
 * and not the shell). The Node path comes from the daemon's layout and the
 * rest is fixed text, so the single-quoted shell argument needs no escaping;
 * a path that would need it is refused.
 */
function startWithPrestart(nodeBinary: string): string {
  if (!SAFE_START_PATH_RE.test(nodeBinary)) {
    throw new TypeError(`unexpected Node path: ${nodeBinary}`);
  }
  return `/bin/sh -c '${nodeBinary} --run prestart && exec ${nodeBinary} --run start'`;
}

/** Plain words for the build transcript. */
export function describeNativeAppStart(start: NativeAppStart): string {
  switch (start.kind) {
    case "start-script":
      return start.prestart
        ? "the package.json prestart then start scripts (node --run)"
        : "the package.json start script (node --run start)";
    case "next-start":
      return `next start on ${NATIVE_APP_BIND_ADDRESS}`;
    case "deno-task":
      return "the deno.json start task (deno task start)";
    case "deno-file":
      return `deno run ${DENO_RUN_FLAGS} ${start.path}`;
    case "file":
      return `node ${start.path}`;
  }
}
