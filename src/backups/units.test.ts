import { assertEquals, assertStringIncludes, assertThrows } from "@std/assert";
import {
  BACKUP_UNIT_ACCOUNT,
  backupServiceContent,
  backupServicePath,
  backupTimerContent,
  backupTimerPath,
  backupTimerTiming,
  backupUnitName,
} from "./units.ts";

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno);

const ID = "0192f1de-7c3b-7e4a-9f10-3a5b6c7d8e9f";
const LAYOUT = { libDir: "/opt/turbopanel/lib", configDir: "/etc/turbopanel" };

function lines(text: string): string[] {
  return text.split("\n");
}

test("unit names carry the policy id and refuse anything but a lower-case uuid", () => {
  assertEquals(backupUnitName(ID), `turbopanel-backup-${ID}`);
  assertEquals(
    backupServicePath(ID, "/u"),
    `/u/turbopanel-backup-${ID}.service`,
  );
  assertEquals(backupTimerPath(ID, "/u"), `/u/turbopanel-backup-${ID}.timer`);
  for (
    const bad of [ID.toUpperCase(), "nightly", `${ID}x`, "../x", `${ID}\n`, ""]
  ) {
    assertThrows(() => backupUnitName(bad), Error, "lower-case UUID");
  }
});

test("the service runs exactly the wrapper for its own policy as the daemon account", () => {
  const service = lines(backupServiceContent(LAYOUT, ID));
  assertEquals(
    service.filter((line) => line.startsWith("ExecStart=")),
    [`ExecStart=/opt/turbopanel/lib/tp-backup-run ${ID}`],
  );
  assertEquals(service.includes(`User=${BACKUP_UNIT_ACCOUNT}`), true);
  assertEquals(service.includes(`Group=${BACKUP_UNIT_ACCOUNT}`), true);
  assertEquals(
    service.includes("EnvironmentFile=-/etc/turbopanel/daemon.env"),
    true,
  );
  assertEquals(service.includes("Type=oneshot"), true);
  assertEquals(service.includes("NoNewPrivileges=yes"), true);
  assertEquals(service.includes("CapabilityBoundingSet="), true);
  assertEquals(service.includes("AmbientCapabilities="), true);
  // Only its timer starts it, and tp-host refuses a slice or plain Environment=.
  assertEquals(service.includes("[Install]"), false);
  assertEquals(service.some((line) => line.startsWith("Slice=")), false);
  assertEquals(
    service.some((line) => line.startsWith("Environment=")),
    false,
  );
  // tp-host pins these two values exactly.
  assertEquals(service.includes("Nice=10"), true);
  assertEquals(service.includes("IOSchedulingClass=idle"), true);
  // tp-host refuses line continuations outright.
  assertEquals(service.some((line) => line.trimEnd().endsWith("\\")), false);
});

test("the timer starts only its own service and catches up once after downtime", () => {
  const timer = backupTimerContent(ID, "*-*-* 03:00:00");
  assertStringIncludes(timer, `Unit=turbopanel-backup-${ID}.service`);
  assertStringIncludes(timer, "OnCalendar=*-*-* 03:00:00");
  assertStringIncludes(timer, "Persistent=true");
  assertStringIncludes(timer, "RandomizedDelaySec=");
  assertStringIncludes(timer, "[Install]\nWantedBy=timers.target");
  assertEquals(timer.includes("[Service]"), false);
});

test("a timer that fires more than once an hour has no random delay and tight accuracy", () => {
  for (
    const calendar of [
      "*-*-* *:0/2:00",
      "*-*-* *:*:00",
      "*-*-* *:0,30:00",
      "Mon *-*-* *:0/15:00 Europe/Berlin",
    ]
  ) {
    const timer = backupTimerContent(ID, calendar);
    assertStringIncludes(timer, "RandomizedDelaySec=0\n");
    assertStringIncludes(timer, "AccuracySec=1s\n");
    assertStringIncludes(timer, "Persistent=true");
  }
});

test("an hourly timer may start at most thirty seconds late", () => {
  for (
    const calendar of [
      "*-*-* *:00:00",
      "*-*-* 0/6:15:00",
      "*-*-* 0,12:30:00 UTC",
    ]
  ) {
    const timer = backupTimerContent(ID, calendar);
    assertStringIncludes(timer, "RandomizedDelaySec=30\n");
    assertEquals(timer.includes("AccuracySec="), false);
  }
});

test("a daily or weekly timer keeps the full spread", () => {
  for (
    const calendar of [
      "*-*-* 03:07:00",
      "Sun *-*-* 03:00:00 America/Chicago",
      "*-1-* 04:30:00",
    ]
  ) {
    assertStringIncludes(
      backupTimerContent(ID, calendar),
      "RandomizedDelaySec=300\n",
    );
  }
});

test("a calendar value it cannot read is never made later than it asked", () => {
  assertEquals(backupTimerTiming("weekly").randomizedDelaySec, 0);
  assertEquals(backupTimerTiming("").randomizedDelaySec, 0);
  assertEquals(backupTimerTiming("*-*-* *:0/2:00").randomizedDelaySec, 0);
  assertEquals(backupTimerTiming("*-*-* 03:07:00").randomizedDelaySec, 300);
});
