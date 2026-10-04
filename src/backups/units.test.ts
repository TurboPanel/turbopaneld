import { assertEquals, assertStringIncludes, assertThrows } from "@std/assert";
import {
  BACKUP_UNIT_ACCOUNT,
  backupServiceContent,
  backupServicePath,
  backupTimerContent,
  backupTimerPath,
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
