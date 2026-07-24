/**
 * Host time-sync facts (timezone + systemd-timesyncd NTP state).
 *
 * Cache-light: re-read on every call — NTP sync state changes at runtime.
 * Defensive native-read-then-spawn style matches {@link ./os-release.ts}.
 */

export type HostTimeSync = {
  timezone?: string;
  ntpEnabled?: boolean;
  ntpSynced?: boolean;
  ntpServers: string[];
  fallbackNtpServers?: string[];
};

const TIMESYNCD_CONF_PATH = "/etc/systemd/timesyncd.conf";
const ETC_TIMEZONE_PATH = "/etc/timezone";

function readTextFile(path: string): string | undefined {
  try {
    return Deno.readTextFileSync(path);
  } catch {
    // Deno 2 may block some paths under scoped --allow-read; fall back to cat.
  }

  try {
    const { code, stdout } = new Deno.Command("cat", {
      args: [path],
      stdout: "piped",
      stderr: "null",
    }).outputSync();
    if (code !== 0) return undefined;
    return new TextDecoder().decode(stdout);
  } catch {
    return undefined;
  }
}

function spawnText(cmd: string, args: string[]): string | undefined {
  try {
    const { code, stdout } = new Deno.Command(cmd, {
      args,
      stdout: "piped",
      stderr: "null",
    }).outputSync();
    if (code !== 0) return undefined;
    return new TextDecoder().decode(stdout);
  } catch {
    return undefined;
  }
}

function parseYesNo(value: string | undefined): boolean | undefined {
  if (value === undefined) return undefined;
  const lower = value.trim().toLowerCase();
  if (lower === "yes" || lower === "true" || lower === "1") return true;
  if (lower === "no" || lower === "false" || lower === "0") return false;
  return undefined;
}

/**
 * Parse `timedatectl show` KEY=VALUE output into timezone / NTP flags.
 * Exported for fixture tests.
 */
export function parseTimedatectlShow(text: string): {
  timezone?: string;
  ntpEnabled?: boolean;
  ntpSynced?: boolean;
} {
  const fields: Record<string, string> = {};
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq <= 0) continue;
    const key = trimmed.slice(0, eq).trim();
    const value = trimmed.slice(eq + 1).trim();
    if (key) fields[key] = value;
  }

  const result: {
    timezone?: string;
    ntpEnabled?: boolean;
    ntpSynced?: boolean;
  } = {};
  const timezone = fields.Timezone?.trim();
  if (timezone) result.timezone = timezone;
  const ntpEnabled = parseYesNo(fields.NTP);
  if (ntpEnabled !== undefined) result.ntpEnabled = ntpEnabled;
  const ntpSynced = parseYesNo(fields.NTPSynchronized);
  if (ntpSynced !== undefined) result.ntpSynced = ntpSynced;
  return result;
}

type TimedatectlStatusFields = {
  timezone?: string;
  ntpEnabled?: boolean;
  ntpSynced?: boolean;
};

function tryParseTimezoneLine(
  result: TimedatectlStatusFields,
  line: string,
): boolean {
  const match = /^Time zone:\s*(\S+)/i.exec(line);
  if (!match?.[1]) return false;
  result.timezone = match[1];
  return true;
}

function tryParseYesNoStatusLine(
  result: TimedatectlStatusFields,
  line: string,
  pattern: RegExp,
  field: "ntpEnabled" | "ntpSynced",
): boolean {
  const match = pattern.exec(line);
  if (!match?.[1]) return false;
  const parsed = parseYesNo(match[1]);
  if (parsed !== undefined) result[field] = parsed;
  return true;
}

function tryParseNtpServiceLine(
  result: TimedatectlStatusFields,
  line: string,
): boolean {
  const match = /^NTP service:\s*(\S+)/i.exec(line);
  if (!match?.[1]) return false;
  const service = match[1].toLowerCase();
  if (service === "active") result.ntpEnabled = true;
  else if (service === "inactive") result.ntpEnabled = false;
  return true;
}

/**
 * Parse `timedatectl status` human-readable lines into timezone / NTP flags.
 * Exported for fixture tests.
 */
export function parseTimedatectlStatus(text: string): TimedatectlStatusFields {
  const result: TimedatectlStatusFields = {};

  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    if (tryParseTimezoneLine(result, trimmed)) continue;
    if (
      tryParseYesNoStatusLine(
        result,
        trimmed,
        /^System clock synchronized:\s*(\S+)/i,
        "ntpSynced",
      )
    ) {
      continue;
    }
    if (tryParseNtpServiceLine(result, trimmed)) continue;
    // Older timedatectl status wording.
    if (
      tryParseYesNoStatusLine(
        result,
        trimmed,
        /^NTP enabled:\s*(\S+)/i,
        "ntpEnabled",
      )
    ) {
      continue;
    }
    tryParseYesNoStatusLine(
      result,
      trimmed,
      /^NTP synchronized:\s*(\S+)/i,
      "ntpSynced",
    );
  }

  return result;
}

/**
 * Parse `/etc/timezone` (single IANA name, optional trailing newline/comments).
 * Exported for fixture tests.
 */
export function parseEtcTimezone(text: string): string | undefined {
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    return trimmed;
  }
  return undefined;
}

function splitServerList(value: string): string[] {
  return value
    .trim()
    .split(/\s+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/**
 * Parse systemd `timesyncd.conf` `[Time]` NTP / FallbackNTP lines.
 * Exported for fixture tests.
 */
export function parseTimesyncdConf(text: string): {
  ntpServers: string[];
  fallbackNtpServers?: string[];
} {
  const ntpServers: string[] = [];
  let fallbackNtpServers: string[] | undefined;

  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#") || trimmed.startsWith("[")) {
      continue;
    }
    const eq = trimmed.indexOf("=");
    if (eq <= 0) continue;
    const key = trimmed.slice(0, eq).trim().toLowerCase();
    const value = trimmed.slice(eq + 1);
    if (key === "ntp") {
      ntpServers.push(...splitServerList(value));
    } else if (key === "fallbackntp") {
      const servers = splitServerList(value);
      if (servers.length > 0) fallbackNtpServers = servers;
    }
  }

  return {
    ntpServers,
    ...(fallbackNtpServers ? { fallbackNtpServers } : {}),
  };
}

function readTimedatectlShow(): ReturnType<typeof parseTimedatectlShow> {
  const text = spawnText("timedatectl", ["show"]);
  if (!text) return {};
  return parseTimedatectlShow(text);
}

function readTimedatectlStatus(): ReturnType<typeof parseTimedatectlStatus> {
  const text = spawnText("timedatectl", ["status"]);
  if (!text) return {};
  return parseTimedatectlStatus(text);
}

function readEtcTimezone(): string | undefined {
  const text = readTextFile(ETC_TIMEZONE_PATH);
  if (!text) return undefined;
  return parseEtcTimezone(text);
}

function readConfiguredServers(): {
  ntpServers: string[];
  fallbackNtpServers?: string[];
} {
  const confText = readTextFile(TIMESYNCD_CONF_PATH);
  if (confText) {
    return parseTimesyncdConf(confText);
  }

  // Fall back to timedatectl show-timesync when the conf file is unreadable.
  const showTimesync = spawnText("timedatectl", ["show-timesync"]);
  if (!showTimesync) return { ntpServers: [] };
  const fields: Record<string, string> = {};
  for (const line of showTimesync.split("\n")) {
    const trimmed = line.trim();
    const eq = trimmed.indexOf("=");
    if (eq <= 0) continue;
    fields[trimmed.slice(0, eq).trim()] = trimmed.slice(eq + 1).trim();
  }
  const ntpServers = fields.SystemNTPServers
    ? splitServerList(fields.SystemNTPServers)
    : [];
  const fallback = fields.FallbackNTPServers
    ? splitServerList(fields.FallbackNTPServers)
    : undefined;
  return {
    ntpServers,
    ...(fallback && fallback.length > 0 ? { fallbackNtpServers: fallback } : {}),
  };
}

/** Read current host timezone + NTP state (no process-lifetime cache). */
export function readTimeSync(): HostTimeSync {
  const show = readTimedatectlShow();
  let timezone = show.timezone;
  let ntpEnabled = show.ntpEnabled;
  let ntpSynced = show.ntpSynced;

  const showIncomplete = timezone === undefined ||
    ntpEnabled === undefined ||
    ntpSynced === undefined;
  if (showIncomplete) {
    const status = readTimedatectlStatus();
    timezone ??= status.timezone;
    ntpEnabled ??= status.ntpEnabled;
    ntpSynced ??= status.ntpSynced;
  }

  timezone ??= readEtcTimezone();

  const servers = readConfiguredServers();
  return {
    ...(timezone ? { timezone } : {}),
    ...(ntpEnabled !== undefined ? { ntpEnabled } : {}),
    ...(ntpSynced !== undefined ? { ntpSynced } : {}),
    ntpServers: servers.ntpServers,
    ...(servers.fallbackNtpServers
      ? { fallbackNtpServers: servers.fallbackNtpServers }
      : {}),
  };
}
