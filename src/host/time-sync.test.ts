import { assertEquals } from "@std/assert";
import {
  parseEtcTimezone,
  parseShowTimesyncLastSyncedAt,
  parseTimedatectlShow,
  parseTimedatectlStatus,
  parseTimesyncdConf,
  readTimeSync,
} from "./time-sync.ts";

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno);

test("parseTimedatectlShow maps Timezone / NTP / NTPSynchronized", () => {
  const parsed = parseTimedatectlShow(`
Timezone=America/Chicago
LocalRTC=no
CanNTP=yes
NTP=yes
NTPSynchronized=yes
TimeUSec=Fri 2026-07-24 12:00:00 CDT
`);
  assertEquals(parsed, {
    timezone: "America/Chicago",
    ntpEnabled: true,
    ntpSynced: true,
  });
});

test("parseTimedatectlShow treats no/false as disabled", () => {
  const parsed = parseTimedatectlShow(`
Timezone=UTC
NTP=no
NTPSynchronized=no
`);
  assertEquals(parsed, {
    timezone: "UTC",
    ntpEnabled: false,
    ntpSynced: false,
  });
});

test("parseTimedatectlStatus maps Time zone / NTP service / synchronized", () => {
  const parsed = parseTimedatectlStatus(`
               Local time: Fri 2026-07-24 14:52:00 CDT
           Universal time: Fri 2026-07-24 19:52:00 UTC
                 RTC time: Fri 2026-07-24 19:52:00
                Time zone: America/Chicago (CDT, -0500)
System clock synchronized: yes
              NTP service: active
          RTC in local TZ: no
`);
  assertEquals(parsed, {
    timezone: "America/Chicago",
    ntpEnabled: true,
    ntpSynced: true,
  });
});

test("parseTimedatectlStatus maps inactive NTP and legacy wording", () => {
  const modern = parseTimedatectlStatus(`
                Time zone: UTC
System clock synchronized: no
              NTP service: inactive
`);
  assertEquals(modern, {
    timezone: "UTC",
    ntpEnabled: false,
    ntpSynced: false,
  });

  const legacy = parseTimedatectlStatus(`
      NTP enabled: yes
 NTP synchronized: no
`);
  assertEquals(legacy, {
    ntpEnabled: true,
    ntpSynced: false,
  });
});

test("parseEtcTimezone reads the first non-comment IANA name", () => {
  assertEquals(parseEtcTimezone("America/Chicago\n"), "America/Chicago");
  assertEquals(
    parseEtcTimezone("# comment\nEurope/Berlin\n"),
    "Europe/Berlin",
  );
  assertEquals(parseEtcTimezone("# only comments\n\n"), undefined);
});

test("parseTimesyncdConf reads NTP and FallbackNTP server lists", () => {
  const parsed = parseTimesyncdConf(`
# Managed by TurboPanel
[Time]
NTP=0.debian.pool.ntp.org 1.debian.pool.ntp.org
FallbackNTP=time.cloudflare.com
`);
  assertEquals(parsed, {
    ntpServers: ["0.debian.pool.ntp.org", "1.debian.pool.ntp.org"],
    fallbackNtpServers: ["time.cloudflare.com"],
  });
});

test("parseTimesyncdConf returns empty servers when unset", () => {
  assertEquals(parseTimesyncdConf("[Time]\n"), { ntpServers: [] });
});

test("parseShowTimesyncLastSyncedAt reads LastSyncTimestamp", () => {
  assertEquals(
    parseShowTimesyncLastSyncedAt("LastSyncTimestamp=2026-08-17T20:00:00Z\n"),
    "2026-08-17T20:00:00.000Z",
  );
  assertEquals(
    parseShowTimesyncLastSyncedAt("LastSyncTimestamp=n/a\n"),
    undefined,
  );
  assertEquals(
    parseShowTimesyncLastSyncedAt(
      "LastMessageTimestamp=2026-08-17T21:00:00Z\n",
    ),
    "2026-08-17T21:00:00.000Z",
  );
});

test("parseTimedatectlShow ignores unknown yes/no tokens", () => {
  assertEquals(
    parseTimedatectlShow("Timezone=UTC\nNTP=maybe\nNTPSynchronized=maybe\n"),
    { timezone: "UTC" },
  );
});

test("parseShowTimesyncLastSyncedAt skips unparseable timestamps", () => {
  assertEquals(
    parseShowTimesyncLastSyncedAt("LastSyncTimestamp=not-a-date\n"),
    undefined,
  );
  assertEquals(
    parseShowTimesyncLastSyncedAt("OtherKey=2026-08-17T20:00:00Z\n"),
    undefined,
  );
});

test("readTimeSync skips status when timedatectl show is complete", () => {
  const calls: string[] = [];
  const result = readTimeSync({
    spawnText(_cmd, args) {
      calls.push(args[0] ?? "");
      if (args[0] === "show") {
        return "Timezone=UTC\nNTP=yes\nNTPSynchronized=yes\n";
      }
      if (args[0] === "show-timesync") {
        // lastSyncedAt still probes show-timesync when the synchronized
        // mtime file is missing — that is not the status fallback.
        return undefined;
      }
      throw new TypeError(`unexpected timedatectl ${args[0]}`);
    },
    readTextFile: () => "[Time]\nNTP=pool.ntp.org\n",
    synchronizedFileMtime: () => undefined,
  });
  assertEquals(result.timezone, "UTC");
  assertEquals(result.ntpEnabled, true);
  assertEquals(result.ntpSynced, true);
  assertEquals(calls.includes("status"), false);
});

test("readTimeSync merges show + status + conf via injected I/O", () => {
  const calls: string[] = [];
  const result = readTimeSync({
    spawnText(cmd, args) {
      calls.push([cmd, ...args].join(" "));
      if (args[0] === "show") {
        return "Timezone=America/Chicago\nNTP=yes\n";
      }
      if (args[0] === "status") {
        return `
                Time zone: America/Chicago
System clock synchronized: yes
              NTP service: active
`;
      }
      return undefined;
    },
    readTextFile(path) {
      calls.push(`read:${path}`);
      if (path.endsWith("timesyncd.conf")) {
        return "[Time]\nNTP=0.pool.ntp.org\nFallbackNTP=time.cloudflare.com\n";
      }
      return undefined;
    },
    synchronizedFileMtime: () => "2026-08-17T20:00:00.000Z",
  });

  assertEquals(result, {
    timezone: "America/Chicago",
    ntpEnabled: true,
    ntpSynced: true,
    ntpServers: ["0.pool.ntp.org"],
    fallbackNtpServers: ["time.cloudflare.com"],
    lastSyncedAt: "2026-08-17T20:00:00.000Z",
  });
  assertEquals(calls.includes("timedatectl show"), true);
  assertEquals(calls.includes("timedatectl status"), true);
});

test("readTimeSync falls back to show-timesync servers and last sync", () => {
  const result = readTimeSync({
    spawnText(_cmd, args) {
      if (args[0] === "show") {
        return "Timezone=UTC\nNTP=no\nNTPSynchronized=yes\n";
      }
      if (args[0] === "show-timesync") {
        return [
          "SystemNTPServers=203.0.113.10 203.0.113.11",
          "FallbackNTPServers=203.0.113.20",
          "LastSyncTimestamp=2026-08-17T19:30:00Z",
        ].join("\n");
      }
      return undefined;
    },
    readTextFile: () => undefined,
    synchronizedFileMtime: () => undefined,
  });

  assertEquals(result.timezone, "UTC");
  assertEquals(result.ntpEnabled, false);
  assertEquals(result.ntpSynced, true);
  assertEquals(result.ntpServers, ["203.0.113.10", "203.0.113.11"]);
  assertEquals(result.fallbackNtpServers, ["203.0.113.20"]);
  assertEquals(result.lastSyncedAt, "2026-08-17T19:30:00.000Z");
});

test("readTimeSync omits lastSyncedAt when NTP is not synchronized", () => {
  const result = readTimeSync({
    spawnText: () => "Timezone=UTC\nNTP=yes\nNTPSynchronized=no\n",
    readTextFile: () => "[Time]\n",
    synchronizedFileMtime: () => "2026-08-17T20:00:00.000Z",
  });
  assertEquals(result.lastSyncedAt, undefined);
  assertEquals(result.ntpSynced, false);
});

test("readTimeSync uses /etc/timezone when timedatectl omits timezone", () => {
  const result = readTimeSync({
    spawnText: () => "NTP=yes\nNTPSynchronized=yes\n",
    readTextFile(path) {
      if (path.endsWith("timezone")) return "Europe/Berlin\n";
      if (path.endsWith("timesyncd.conf")) return "[Time]\nNTP=pool.ntp.org\n";
      return undefined;
    },
    synchronizedFileMtime: () => undefined,
  });
  assertEquals(result.timezone, "Europe/Berlin");
  assertEquals(result.ntpServers, ["pool.ntp.org"]);
});

test("parse helpers skip lines without a key=value pair", () => {
  assertEquals(
    parseTimedatectlShow("=novalue\nbadline\nTimezone=UTC\n"),
    { timezone: "UTC" },
  );
  assertEquals(
    parseTimesyncdConf("[Time]\n=empty\nNTP=pool.ntp.org\n"),
    { ntpServers: ["pool.ntp.org"] },
  );
  assertEquals(
    parseShowTimesyncLastSyncedAt("=novalue\nbadline\n"),
    undefined,
  );
});

test("readTimeSync returns empty facts when spawn and file readers miss", () => {
  const result = readTimeSync({
    spawnText: () => undefined,
    readTextFile: () => undefined,
    synchronizedFileMtime: () => undefined,
  });
  assertEquals(result, { ntpServers: [] });
});

test("readTimeSync ignores empty SystemNTPServers from show-timesync", () => {
  const result = readTimeSync({
    spawnText(_cmd, args) {
      if (args[0] === "show") {
        return "Timezone=UTC\nNTP=yes\nNTPSynchronized=yes\n";
      }
      if (args[0] === "show-timesync") {
        return "SystemNTPServers=\nFallbackNTPServers=203.0.113.20\n";
      }
      return undefined;
    },
    readTextFile: () => undefined,
    synchronizedFileMtime: () => undefined,
  });
  assertEquals(result.ntpServers, []);
  assertEquals(result.fallbackNtpServers, ["203.0.113.20"]);
});

test("readTimeSync ignores empty FallbackNTPServers from show-timesync", () => {
  const result = readTimeSync({
    spawnText(_cmd, args) {
      if (args[0] === "show") {
        return "Timezone=UTC\nNTP=yes\nNTPSynchronized=yes\n";
      }
      if (args[0] === "show-timesync") {
        return [
          "SystemNTPServers=203.0.113.10",
          "FallbackNTPServers=",
          "=novalue",
          "badline",
        ].join("\n");
      }
      return undefined;
    },
    readTextFile: () => undefined,
    synchronizedFileMtime: () => undefined,
  });
  assertEquals(result.ntpServers, ["203.0.113.10"]);
  assertEquals(result.fallbackNtpServers, undefined);
});

test("readTimeSync omits lastSyncedAt when show-timesync is unavailable", () => {
  const result = readTimeSync({
    spawnText(_cmd, args) {
      if (args[0] === "show") {
        return "Timezone=UTC\nNTP=yes\nNTPSynchronized=yes\n";
      }
      return undefined;
    },
    readTextFile: () => "[Time]\nNTP=pool.ntp.org\n",
    // Default mtime probe against a missing override path.
    synchronizedPath: "/tmp/turbopanel-missing-timesync-synchronized",
  });
  assertEquals(result.lastSyncedAt, undefined);
  assertEquals(result.ntpSynced, true);
});

test("readTimeSync default reader uses runCat after Deno.readTextFileSync fails", () => {
  const root = Deno.makeTempDirSync({ prefix: "tp-timesync-cat-" });
  const enc = new TextEncoder();
  try {
    const result = readTimeSync({
      etcTimezonePath: `${root}/missing-timezone`,
      timesyncdConfPath: `${root}/missing-timesyncd.conf`,
      synchronizedPath: `${root}/missing-synchronized`,
      spawnText(_cmd, args) {
        if (args[0] === "show") {
          return "NTP=yes\nNTPSynchronized=no\n";
        }
        if (args[0] === "status") {
          return "Time zone: UTC\nNTP service: active\nSystem clock synchronized: no\n";
        }
        return undefined;
      },
      runCat(path) {
        if (path.endsWith("missing-timezone")) {
          return { code: 0, stdout: enc.encode("UTC\n") };
        }
        if (path.endsWith("missing-timesyncd.conf")) {
          return {
            code: 0,
            stdout: enc.encode("[Time]\nNTP=203.0.113.10\n"),
          };
        }
        return { code: 1, stdout: new Uint8Array() };
      },
    });
    assertEquals(result.timezone, "UTC");
    assertEquals(result.ntpServers, ["203.0.113.10"]);
    assertEquals(result.ntpSynced, false);
  } finally {
    Deno.removeSync(root, { recursive: true });
  }
});

test("readTimeSync default reader covers Deno.readTextFileSync and real cat miss", () => {
  const root = Deno.makeTempDirSync({ prefix: "tp-timesync-read-" });
  try {
    Deno.writeTextFileSync(`${root}/timezone`, "Europe/Paris\n");
    Deno.writeTextFileSync(
      `${root}/timesyncd.conf`,
      "[Time]\nNTP=203.0.113.50\n",
    );
    const withFiles = readTimeSync({
      etcTimezonePath: `${root}/timezone`,
      timesyncdConfPath: `${root}/timesyncd.conf`,
      synchronizedPath: `${root}/synchronized`,
      spawnText: () => "NTP=yes\nNTPSynchronized=yes\n",
    });
    assertEquals(withFiles.timezone, "Europe/Paris");
    assertEquals(withFiles.ntpServers, ["203.0.113.50"]);

    const missing = readTimeSync({
      etcTimezonePath: `${root}/no-timezone`,
      timesyncdConfPath: `${root}/no-conf`,
      synchronizedPath: `${root}/no-sync`,
      spawnText: () => undefined,
    });
    assertEquals(missing, { ntpServers: [] });
  } finally {
    Deno.removeSync(root, { recursive: true });
  }
});

test("readTimeSync default spawnText uses PATH timedatectl stub", () => {
  const root = Deno.makeTempDirSync({ prefix: "tp-timesync-spawn-" });
  const binDir = `${root}/bin`;
  Deno.mkdirSync(binDir);
  Deno.writeTextFileSync(
    `${binDir}/timedatectl`,
    `#!/bin/sh
case "$1" in
  show) printf '%s\\n' 'Timezone=UTC' 'NTP=yes' 'NTPSynchronized=yes'; exit 0 ;;
  status) exit 1 ;;
  show-timesync) exit 1 ;;
esac
exit 1
`,
  );
  Deno.chmodSync(`${binDir}/timedatectl`, 0o755);
  const prevPath = Deno.env.get("PATH");
  Deno.env.set("PATH", `${binDir}:${prevPath ?? ""}`);
  try {
    const result = readTimeSync({
      etcTimezonePath: `${root}/missing-tz`,
      timesyncdConfPath: `${root}/missing-conf`,
      synchronizedPath: `${root}/missing-sync`,
      runCat: () => ({ code: 1, stdout: new Uint8Array() }),
    });
    assertEquals(result.timezone, "UTC");
    assertEquals(result.ntpEnabled, true);
    assertEquals(result.ntpSynced, true);
    assertEquals(result.ntpServers, []);
  } finally {
    if (prevPath === undefined) Deno.env.delete("PATH");
    else Deno.env.set("PATH", prevPath);
    Deno.removeSync(root, { recursive: true });
  }
});

test("readTimeSync default readers catch Command failures", () => {
  const root = Deno.makeTempDirSync({ prefix: "tp-timesync-cmd-fail-" });
  const binDir = `${root}/bin`;
  Deno.mkdirSync(binDir);
  // Non-executable "timedatectl" forces Deno.Command to throw.
  Deno.writeTextFileSync(`${binDir}/timedatectl`, "not-executable");
  const prevPath = Deno.env.get("PATH");
  Deno.env.set("PATH", `${binDir}:/nonexistent`);
  try {
    const result = readTimeSync({
      etcTimezonePath: `${root}/missing-tz`,
      timesyncdConfPath: `${root}/missing-conf`,
      synchronizedPath: `${root}/missing-sync`,
      runCat: () => {
        throw new Error("cat unavailable");
      },
    });
    assertEquals(result, { ntpServers: [] });
  } finally {
    if (prevPath === undefined) Deno.env.delete("PATH");
    else Deno.env.set("PATH", prevPath);
    Deno.removeSync(root, { recursive: true });
  }
});

test("readTimeSync default synchronized mtime uses file timestamp", () => {
  const root = Deno.makeTempDirSync({ prefix: "tp-timesync-mtime-" });
  const syncPath = `${root}/synchronized`;
  Deno.writeTextFileSync(syncPath, "");
  try {
    const result = readTimeSync({
      spawnText: () => "Timezone=UTC\nNTP=yes\nNTPSynchronized=yes\n",
      readTextFile: () => "[Time]\nNTP=203.0.113.10\n",
      synchronizedPath: syncPath,
    });
    assertEquals(typeof result.lastSyncedAt, "string");
    if (!result.lastSyncedAt) {
      throw new TypeError("expected lastSyncedAt from synchronized mtime");
    }
  } finally {
    Deno.removeSync(root, { recursive: true });
  }
});

test("parseTimedatectlShow maps true/1 and false/0 tokens", () => {
  assertEquals(
    parseTimedatectlShow("Timezone=UTC\nNTP=true\nNTPSynchronized=1\n"),
    { timezone: "UTC", ntpEnabled: true, ntpSynced: true },
  );
  assertEquals(
    parseTimedatectlShow("Timezone=UTC\nNTP=false\nNTPSynchronized=0\n"),
    { timezone: "UTC", ntpEnabled: false, ntpSynced: false },
  );
});

test("parseTimedatectlShow skips comments and empty last-sync stamps", () => {
  assertEquals(
    parseTimedatectlShow("# comment\nTimezone=UTC\n=novalue\n"),
    { timezone: "UTC" },
  );
  assertEquals(
    parseShowTimesyncLastSyncedAt(
      "LastSyncTimestamp=0\nLastMessageTimestamp=n/a\n",
    ),
    undefined,
  );
});

test("parseTimesyncdConf ignores empty FallbackNTP", () => {
  assertEquals(
    parseTimesyncdConf("[Time]\nNTP=pool.ntp.org\nFallbackNTP=\nOther=1\n"),
    { ntpServers: ["pool.ntp.org"] },
  );
});

test("readTimeSync default reader uses runCat code 1 as a miss", () => {
  const root = Deno.makeTempDirSync({ prefix: "tp-timesync-cat-miss-" });
  try {
    const result = readTimeSync({
      etcTimezonePath: `${root}/missing-timezone`,
      timesyncdConfPath: `${root}/missing-timesyncd.conf`,
      synchronizedPath: `${root}/missing-synchronized`,
      spawnText: () => "Timezone=UTC\nNTP=yes\nNTPSynchronized=yes\n",
      runCat: () => ({ code: 1, stdout: new Uint8Array() }),
    });
    assertEquals(result.timezone, "UTC");
    assertEquals(result.ntpServers, []);
  } finally {
    Deno.removeSync(root, { recursive: true });
  }
});
