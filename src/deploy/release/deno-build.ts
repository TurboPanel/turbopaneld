/**
 * What a native Deno app's build and start are, worked out from the project's
 * own files, by the usual Deno convention.
 *
 * Pure of the build runner and the tree walker: the caller hands in how to read
 * a file and whether an entry file exists (`DenoProjectFiles`), so these rules
 * are testable on plain strings and `build.ts` keeps the one place that knows
 * how a build tree is checked (regular files only, no links on the way).
 */

import {
  type NativeAppStart,
  normalizeNativeAppStartPath,
} from "../native/start-entry.ts";

/** The files a Deno project's config can live in, in the order Deno looks. */
export const DENO_CONFIG_FILES = ["deno.json", "deno.jsonc"] as const;

/** Entry files a Deno app is started from when its config names none (in order). */
export const DENO_CONVENTIONAL_ENTRIES = [
  "main.ts",
  "mod.ts",
  "server.ts",
  "main.js",
  "index.ts",
] as const;

/** Task names whose `deno run <file>` command names the app's entry (in order). */
const DENO_ENTRY_TASKS = ["serve", "server", "run"] as const;

/** How the build reads the tree: regular files only, nothing followed. */
export type DenoProjectFiles = {
  /** The text of a regular file at the release root, or `undefined`. */
  read(name: string): Promise<string | undefined>;
  /** Whether a regular file exists at the release root. */
  exists(name: string): Promise<boolean>;
  /** Whether `path` is a regular file in a real directory of the tree. */
  entryExists(path: string): Promise<boolean>;
};

export type DenoConfig = {
  /** Which file it came from (`deno.json` or `deno.jsonc`). */
  file: string;
  tasks: Readonly<Record<string, string>>;
  main?: string;
  /** The `.` export when `exports` is a string or has a `.` entry. */
  exportsEntry?: string;
  /** `nodeModulesDir` is set to something other than "none". */
  nodeModulesDir: boolean;
};

type Scan = { out: string; i: number };

/**
 * JSON with `//` and `/* *\/` comments and trailing commas, the way
 * `deno.jsonc` is written, as plain JSON text. Strings are copied untouched, so
 * a `//` inside a URL survives.
 */
export function stripJsonc(text: string): string {
  const scan: Scan = { out: "", i: 0 };
  while (scan.i < text.length) {
    const char = text[scan.i];
    if (char === '"') copyString(text, scan);
    else if (text.startsWith("//", scan.i)) skipLineComment(text, scan);
    else if (text.startsWith("/*", scan.i)) skipBlockComment(text, scan);
    else {
      scan.out += char;
      scan.i += 1;
    }
  }
  return removeTrailingCommas(scan.out);
}

function copyString(text: string, scan: Scan): void {
  scan.out += text[scan.i];
  scan.i += 1;
  while (scan.i < text.length) {
    const char = text[scan.i];
    scan.out += char;
    scan.i += 1;
    if (char === "\\" && scan.i < text.length) {
      scan.out += text[scan.i];
      scan.i += 1;
    } else if (char === '"') return;
  }
}

function skipLineComment(text: string, scan: Scan): void {
  const end = text.indexOf("\n", scan.i);
  scan.i = end === -1 ? text.length : end;
}

function skipBlockComment(text: string, scan: Scan): void {
  const end = text.indexOf("*/", scan.i + 2);
  scan.i = end === -1 ? text.length : end + 2;
  // A comment separates tokens, like a space.
  scan.out += " ";
}

/** Drop a `,` whose next significant character closes the object or array. */
function removeTrailingCommas(json: string): string {
  let out = "";
  let i = 0;
  while (i < json.length) {
    const char = json[i];
    if (char === '"') {
      const scan: Scan = { out: "", i };
      copyString(json, scan);
      out += scan.out;
      i = scan.i;
    } else if (char === "," && closesNext(json, i + 1)) {
      i += 1;
    } else {
      out += char;
      i += 1;
    }
  }
  return out;
}

function closesNext(json: string, from: number): boolean {
  let i = from;
  while (i < json.length && " \t\r\n".includes(json[i])) i += 1;
  return json[i] === "}" || json[i] === "]";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringTasks(value: unknown): Record<string, string> {
  if (!isRecord(value)) return {};
  const tasks: Record<string, string> = {};
  for (const [name, command] of Object.entries(value)) {
    // A task is a command string, or `{ command }` with dependencies.
    if (typeof command === "string") tasks[name] = command;
    else if (isRecord(command) && typeof command.command === "string") {
      tasks[name] = command.command;
    }
  }
  return tasks;
}

function exportsEntryOf(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (isRecord(value) && typeof value["."] === "string") return value["."];
  return undefined;
}

/** A config's fields this module reads, from its parsed JSON. */
export function denoConfigFrom(file: string, parsed: unknown): DenoConfig {
  const config = isRecord(parsed) ? parsed : {};
  const dir = config.nodeModulesDir;
  return {
    file,
    tasks: stringTasks(config.tasks),
    ...(typeof config.main === "string" ? { main: config.main } : {}),
    ...(exportsEntryOf(config.exports) === undefined
      ? {}
      : { exportsEntry: exportsEntryOf(config.exports) as string }),
    nodeModulesDir: dir !== undefined && dir !== false && dir !== "none",
  };
}

/**
 * The project's `deno.json` (else `deno.jsonc`), or `undefined` when it has
 * neither. A config that is not valid JSON(C) throws, naming the file: a build
 * that carried on without it would run with other settings than the author's.
 */
export async function readDenoConfig(
  files: DenoProjectFiles,
): Promise<DenoConfig | undefined> {
  const texts = await Promise.all(
    DENO_CONFIG_FILES.map((file) => files.read(file)),
  );
  const index = texts.findIndex((text) => text !== undefined);
  if (index === -1) return undefined;
  const file = DENO_CONFIG_FILES[index];
  try {
    return denoConfigFrom(file, JSON.parse(stripJsonc(texts[index] as string)));
  } catch {
    throw new Error(
      `${file} is not valid JSON, so the app's tasks and entry cannot be read. Fix ${file} and deploy again.`,
    );
  }
}

/**
 * The install step: `deno install` when the project needs its dependencies
 * fetched ahead of the run: a lockfile, a `package.json` (npm packages) or a
 * `nodeModulesDir` setting. Otherwise `undefined`.
 */
export async function deriveDenoInstallCommand(
  files: DenoProjectFiles,
  config: DenoConfig | undefined,
): Promise<string | undefined> {
  const [lock, pkg] = await Promise.all([
    files.exists("deno.lock"),
    files.exists("package.json"),
  ]);
  return lock || pkg || config?.nodeModulesDir === true
    ? "deno install"
    : undefined;
}

/** `deno task build` when the config defines a `build` task. */
export function deriveDenoBuildCommand(
  config: DenoConfig | undefined,
): string | undefined {
  return config?.tasks.build !== undefined ? "deno task build" : undefined;
}

/** Extensions Deno runs directly: what a task's last word must end in to be an entry. */
const DENO_ENTRY_EXTENSIONS = [
  ".ts",
  ".tsx",
  ".js",
  ".jsx",
  ".mts",
  ".mjs",
  ".cts",
  ".cjs",
] as const;

/**
 * The file a task like `deno run -A --port=8000 main.ts` runs, if it is one: a
 * plain `deno run`, flags, and a script path as the last word. `--watch` is a
 * development loop and not a start we can name.
 */
export function denoRunTaskFile(command: string): string | undefined {
  const words = command.trim().split(/\s+/);
  if (words[0] !== "deno" || words[1] !== "run" || words.length < 3) {
    return undefined;
  }
  if (words.some((word) => word.startsWith("--watch"))) return undefined;
  const file = words.at(-1) as string;
  if (file.startsWith("-")) return undefined;
  if (!DENO_ENTRY_EXTENSIONS.some((extension) => file.endsWith(extension))) {
    return undefined;
  }
  return normalizeNativeAppStartPath(file);
}

/** Entry candidates in the order they are tried, as safe relative paths. */
export function denoEntryCandidates(config: DenoConfig | undefined): string[] {
  const named = [config?.main, config?.exportsEntry].flatMap((value) => {
    const path = value === undefined
      ? undefined
      : normalizeNativeAppStartPath(value);
    return path === undefined ? [] : [path];
  });
  const fromTasks = DENO_ENTRY_TASKS.flatMap((name) => {
    const command = config?.tasks[name];
    const file = command === undefined ? undefined : denoRunTaskFile(command);
    return file === undefined ? [] : [file];
  });
  return [...new Set([...named, ...fromTasks, ...DENO_CONVENTIONAL_ENTRIES])];
}

/**
 * How a Deno release starts when its author typed nothing:
 *
 * 1. the config's `start` task → `deno task start`;
 * 2. the entry file, first that exists among `main`, the `.` export, the entry
 *    of a `serve` / `server` / `run` task, then `main.ts`, `mod.ts`,
 *    `server.ts`, `main.js`, `index.ts` → `deno run --allow-all <file>`.
 *
 * `undefined` when neither applies.
 */
export async function detectDenoStart(
  files: DenoProjectFiles,
  config: DenoConfig | undefined,
): Promise<NativeAppStart | undefined> {
  if (config?.tasks.start !== undefined) return { kind: "deno-task" };
  const candidates = denoEntryCandidates(config);
  const present = await Promise.all(
    candidates.map((candidate) => files.entryExists(candidate)),
  );
  const index = present.indexOf(true);
  return index === -1
    ? undefined
    : { kind: "deno-file", path: candidates[index] };
}

/**
 * `deno cache <entry>`: fetch the entry's imports with the build's network, and
 * write `deno.lock` into the tree. The lock matters at run time: the release is
 * read-only, and `deno run` with remote imports and no lockfile dies trying to
 * write one. The entry is the file the `start` task runs when that is a plain
 * `deno run`, else the entry file the start detection would pick; nothing when
 * neither is a file that exists.
 */
export async function deriveDenoCacheCommand(
  files: DenoProjectFiles,
  config: DenoConfig | undefined,
): Promise<string | undefined> {
  const task = config?.tasks.start;
  const fromTask = task === undefined ? undefined : denoRunTaskFile(task);
  if (fromTask !== undefined && await files.entryExists(fromTask)) {
    return `deno cache ${fromTask}`;
  }
  const candidates = denoEntryCandidates(config);
  const present = await Promise.all(
    candidates.map((candidate) => files.entryExists(candidate)),
  );
  const index = present.indexOf(true);
  return index === -1 ? undefined : `deno cache ${candidates[index]}`;
}
