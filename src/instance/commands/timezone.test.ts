import { assertEquals, assertRejects, assertThrows } from "@std/assert";
import {
  assertValidTimezone,
  isValidTimezone,
  parseTimezoneSetPayload,
  TIMEZONE_MAX_LENGTH,
} from "./contracts.ts";

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno);

test("isValidTimezone accepts IANA zones and rejects shell metachars", () => {
  const reject = [
    "a b",
    ";",
    "|",
    "$(reboot)",
    "`id`",
    "../Etc",
    "",
    "a".repeat(TIMEZONE_MAX_LENGTH + 1),
    "/UTC",
    "America/",
  ];
  for (const value of reject) {
    assertEquals(isValidTimezone(value), false);
  }

  assertEquals(isValidTimezone("UTC"), true);
  assertEquals(isValidTimezone("America/Chicago"), true);
  assertEquals(isValidTimezone("America/Argentina/Buenos_Aires"), true);
  assertEquals(isValidTimezone("Etc/GMT+6"), true);
});

test("assertValidTimezone and parseTimezoneSetPayload enforce timezone safety", () => {
  assertThrows(
    () => assertValidTimezone("a;rm -rf /"),
    Error,
    "Invalid timezone",
  );
  assertEquals(parseTimezoneSetPayload({ timezone: "UTC" }), {
    timezone: "UTC",
  });
  assertThrows(
    () => parseTimezoneSetPayload(null),
    Error,
    "Invalid timezone payload",
  );
  assertThrows(
    () => parseTimezoneSetPayload({ timezone: "a b" }),
    Error,
    "Invalid timezone",
  );
});

test({
  name: "handleTimezone rejects when ansible runtime is missing",
  fn: async () => {
    const {
      handleTimezone,
      setAnsibleAvailabilityCheckForTests,
      setTimeSyncApplyForTests,
      setTimeSyncReaderForTests,
    } = await import("./timezone.ts");

    setAnsibleAvailabilityCheckForTests(() => Promise.resolve(false));
    setTimeSyncApplyForTests(async () => {
      await Promise.resolve();
      throw new Error("runner should not be called");
    });
    setTimeSyncReaderForTests(() => {
      throw new Error("reader should not be called");
    });
    try {
      const nowIso = new Date().toISOString();
      await assertRejects(
        () => handleTimezone({ timezone: "UTC" }, nowIso),
        Error,
        "Ansible/bootstrap runtime is missing",
      );
    } finally {
      setAnsibleAvailabilityCheckForTests(null);
      setTimeSyncApplyForTests(null);
      setTimeSyncReaderForTests(null);
    }
  },
});

test({
  name: "handleTimezone applies timezone via injectable runner and reader",
  fn: async () => {
    const {
      handleTimezone,
      setAnsibleAvailabilityCheckForTests,
      setTimeSyncApplyForTests,
      setTimeSyncReaderForTests,
    } = await import("./timezone.ts");

    let applied: unknown;
    setAnsibleAvailabilityCheckForTests(() => Promise.resolve(true));
    setTimeSyncApplyForTests(async (opts) => {
      await Promise.resolve();
      applied = opts;
      return { summary: "ok" };
    });
    setTimeSyncReaderForTests(() => ({
      timezone: "America/Chicago",
      ntpEnabled: false,
      ntpServers: ["203.0.113.10"],
      fallbackNtpServers: ["time.cloudflare.com"],
    }));
    try {
      const result = await handleTimezone(
        { timezone: "America/Chicago" },
        new Date().toISOString(),
      );
      assertEquals(applied, {
        timezone: "America/Chicago",
        ntpEnabled: false,
        ntpServers: ["203.0.113.10"],
        ntpFallbackServers: ["time.cloudflare.com"],
      });
      assertEquals(result, {
        timezone: "America/Chicago",
        summary: "ok",
      });
    } finally {
      setAnsibleAvailabilityCheckForTests(null);
      setTimeSyncApplyForTests(null);
      setTimeSyncReaderForTests(null);
    }
  },
});

test({
  name: "handleTimezone omits summary when ansible apply returns empty",
  fn: async () => {
    const {
      handleTimezone,
      setAnsibleAvailabilityCheckForTests,
      setTimeSyncApplyForTests,
      setTimeSyncReaderForTests,
    } = await import("./timezone.ts");

    setAnsibleAvailabilityCheckForTests(() => Promise.resolve(true));
    setTimeSyncApplyForTests(async () => {
      await Promise.resolve();
      return { summary: "" };
    });
    setTimeSyncReaderForTests(() => ({
      timezone: "America/Chicago",
      ntpEnabled: true,
      ntpServers: ["203.0.113.10"],
      fallbackNtpServers: [],
    }));
    try {
      const result = await handleTimezone(
        { timezone: "America/Chicago" },
        new Date().toISOString(),
      );
      assertEquals(result, { timezone: "America/Chicago" });
      assertEquals("summary" in result, false);
    } finally {
      setAnsibleAvailabilityCheckForTests(null);
      setTimeSyncApplyForTests(null);
      setTimeSyncReaderForTests(null);
    }
  },
});

test({
  name: "handleTimezone falls back to payload timezone when host omits it",
  fn: async () => {
    const {
      handleTimezone,
      setAnsibleAvailabilityCheckForTests,
      setTimeSyncApplyForTests,
      setTimeSyncReaderForTests,
    } = await import("./timezone.ts");

    setAnsibleAvailabilityCheckForTests(() => Promise.resolve(true));
    setTimeSyncApplyForTests(async () => {
      await Promise.resolve();
      return { summary: "applied" };
    });
    setTimeSyncReaderForTests(() => ({
      ntpEnabled: true,
      ntpServers: ["203.0.113.10"],
      fallbackNtpServers: [],
    }));
    try {
      const result = await handleTimezone(
        { timezone: "Europe/Berlin" },
        new Date().toISOString(),
      );
      assertEquals(result.timezone, "Europe/Berlin");
    } finally {
      setAnsibleAvailabilityCheckForTests(null);
      setTimeSyncApplyForTests(null);
      setTimeSyncReaderForTests(null);
    }
  },
});
