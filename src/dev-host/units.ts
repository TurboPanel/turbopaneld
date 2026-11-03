/**
 * systemd facts for the development host's units: one `systemctl show` for
 * all four per status tick, and the control plane unit's database URL for a
 * migration (read the way `tp-orchestrate migrate` reads it, plus the unit's
 * environment files, where the development install keeps it).
 */
import type { RunCommand } from "./commands.ts";

export type UnitState = {
  activeState: string;
  active: boolean;
  /** Main process start (ms since the epoch), or null when it is not running. */
  startedAtMs: number | null;
};

function stripService(id: string): string {
  return id.endsWith(".service") ? id.slice(0, -".service".length) : id;
}

/** Parse `systemctl show --timestamp=unix` blocks (blank-line separated). */
export function parseSystemctlShow(text: string): Map<string, UnitState> {
  const out = new Map<string, UnitState>();
  for (const block of text.split(/\n\s*\n/)) {
    const props = new Map<string, string>();
    for (const line of block.split("\n")) {
      const eq = line.indexOf("=");
      if (eq > 0) {
        props.set(line.slice(0, eq).trim(), line.slice(eq + 1).trim());
      }
    }
    const id = props.get("Id");
    if (!id) continue;
    const activeState = props.get("ActiveState") ?? "unknown";
    const stamp = props.get("ExecMainStartTimestamp") ?? "";
    const seconds = stamp.startsWith("@") ? Number(stamp.slice(1)) : Number.NaN;
    out.set(stripService(id), {
      activeState,
      active: activeState === "active",
      startedAtMs: Number.isFinite(seconds) && seconds > 0
        ? seconds * 1000
        : null,
    });
  }
  return out;
}

/** One `systemctl show` for every unit; an empty map when systemctl failed. */
export async function readUnits(
  run: RunCommand,
  units: readonly string[],
): Promise<Map<string, UnitState>> {
  const result = await run("systemctl", [
    "show",
    "--timestamp=unix",
    "--property=Id,ActiveState,ExecMainStartTimestamp",
    ...units.map((unit) => `${unit}.service`),
  ], { timeoutMs: 15_000 });
  if (result.code !== 0) return new Map();
  return parseSystemctlShow(result.stdout);
}

/**
 * Split a systemd `Environment=` value into its assignments. Values with
 * spaces are double-quoted by systemctl; backslash escapes the next character.
 */
export function splitEnvironment(value: string): string[] {
  const out: string[] = [];
  let current = "";
  let quoted = false;
  let started = false;
  for (let i = 0; i < value.length; i += 1) {
    const ch = value[i];
    if (ch === "\\" && i + 1 < value.length) {
      current += value[i + 1];
      started = true;
      i += 1;
    } else if (ch === '"') {
      quoted = !quoted;
      started = true;
    } else if (ch === " " && !quoted) {
      if (started) out.push(current);
      current = "";
      started = false;
    } else {
      current += ch;
      started = true;
    }
  }
  if (started) out.push(current);
  return out;
}

/** The value of `name` in an env file's text (`KEY=value`, optional quotes, `export`). */
export function readEnvFileValue(text: string, name: string): string | null {
  let found: string | null = null;
  for (const raw of text.split("\n")) {
    let line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    if (line.startsWith("export ")) line = line.slice("export ".length).trim();
    if (!line.startsWith(`${name}=`)) continue;
    let value = line.slice(name.length + 1).trim();
    const quote = value[0];
    if ((quote === '"' || quote === "'") && value.endsWith(quote)) {
      value = value.slice(1, -1);
    }
    // systemd: a later assignment wins.
    found = value;
  }
  return found;
}

const DATABASE_URL = "TURBOPANEL_DATABASE_URL";

/**
 * `TURBOPANEL_DATABASE_URL` as the control plane unit sees it: its
 * `Environment=` line first, then its environment files in order (a later
 * file wins, as in systemd). Null when it is set nowhere.
 */
export async function readInstanceDatabaseUrl(
  run: RunCommand,
  unit: string,
  readFile: (path: string) => Promise<string | null> = readTextOrNull,
): Promise<string | null> {
  const result = await run("systemctl", [
    "show",
    "--property=Environment",
    "--property=EnvironmentFiles",
    `${unit}.service`,
  ], { timeoutMs: 15_000 });
  if (result.code !== 0) return null;
  let url: string | null = null;
  const files: string[] = [];
  for (const line of result.stdout.split("\n")) {
    if (line.startsWith("Environment=")) {
      for (const pair of splitEnvironment(line.slice("Environment=".length))) {
        if (pair.startsWith(`${DATABASE_URL}=`)) {
          url = pair.slice(DATABASE_URL.length + 1);
        }
      }
    } else if (line.startsWith("EnvironmentFiles=")) {
      // `EnvironmentFiles=/path (ignore_errors=yes)`
      const path = line.slice("EnvironmentFiles=".length).split(" (")[0].trim();
      if (path.startsWith("/")) files.push(path);
    }
  }
  const texts = await Promise.all(files.map((path) => readFile(path)));
  for (const text of texts) {
    const value = text === null ? null : readEnvFileValue(text, DATABASE_URL);
    if (value) url = value;
  }
  return url?.trim() || null;
}

async function readTextOrNull(path: string): Promise<string | null> {
  try {
    return await Deno.readTextFile(path);
  } catch {
    return null;
  }
}
