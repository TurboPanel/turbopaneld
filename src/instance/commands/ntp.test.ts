import { assertEquals, assertRejects, assertThrows } from "@std/assert";
import {
  assertValidNtpServer,
  isValidNtpServer,
  parseNtpSetPayload,
} from "./contracts.ts";

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno);

test("isValidNtpServer accepts hosts/IPs and rejects shell metachars", () => {
  const reject = [
    "a b",
    ";",
    "|",
    "$(reboot)",
    "`id`",
    "",
    "bad_host",
  ];
  for (const value of reject) {
    assertEquals(isValidNtpServer(value), false);
  }

  assertEquals(isValidNtpServer("0.debian.pool.ntp.org"), true);
  assertEquals(isValidNtpServer("time.cloudflare.com"), true);
  assertEquals(isValidNtpServer("203.0.113.10"), true);
  assertEquals(isValidNtpServer("2001:db8::1"), true);
});

test("isValidNtpServer rejects out-of-range IPv4 and malformed IPv6", () => {
  const reject = [
    "999.999.999.999",
    "203.0.113.256",
    "01.2.3.4",
    "::::",
    ":::",
    "2001:db8:::1",
    "gggg::1",
    "1:2:3:4:5:6:7",
    "1:2:3:4:5:6:7:8:9",
  ];
  for (const value of reject) {
    assertEquals(isValidNtpServer(value), false);
  }

  // RFC 5737 TEST-NET-3 / RFC 3849 documentation prefix.
  assertEquals(isValidNtpServer("203.0.113.10"), true);
  assertEquals(isValidNtpServer("2001:db8::1"), true);
  assertEquals(isValidNtpServer("2001:db8:85a3::8a2e:370:7334"), true);
  assertEquals(isValidNtpServer("::1"), true);
  assertEquals(isValidNtpServer("0.debian.pool.ntp.org"), true);
});

test("assertValidNtpServer and parseNtpSetPayload enforce payload safety", () => {
  assertThrows(
    () => assertValidNtpServer("a;rm -rf /"),
    Error,
    "Invalid NTP server",
  );
  assertEquals(
    parseNtpSetPayload({
      enabled: true,
      servers: ["0.debian.pool.ntp.org"],
      fallbackServers: ["time.cloudflare.com"],
    }),
    {
      enabled: true,
      servers: ["0.debian.pool.ntp.org"],
      fallbackServers: ["time.cloudflare.com"],
    },
  );
  assertThrows(
    () => parseNtpSetPayload(null),
    Error,
    "Invalid ntp payload",
  );
  assertThrows(
    () => parseNtpSetPayload({}),
    Error,
    "ntp payload must include enabled, servers, and/or fallbackServers",
  );
  assertThrows(
    () => parseNtpSetPayload({ servers: ["a;b"] }),
    Error,
    "Invalid NTP server",
  );
});

test({
  name: "handleNtp rejects when ansible runtime is missing",
  fn: async () => {
    const {
      handleNtp,
      setAnsibleAvailabilityCheckForTests,
      setTimeSyncApplyForTests,
      setTimeSyncReaderForTests,
    } = await import("./ntp.ts");

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
        () => handleNtp({ enabled: true }, nowIso),
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
  name: "handleNtp applies NTP via injectable runner and reader",
  fn: async () => {
    const {
      handleNtp,
      setAnsibleAvailabilityCheckForTests,
      setTimeSyncApplyForTests,
      setTimeSyncReaderForTests,
    } = await import("./ntp.ts");

    let applied: unknown;
    setAnsibleAvailabilityCheckForTests(() => Promise.resolve(true));
    setTimeSyncApplyForTests(async (opts) => {
      await Promise.resolve();
      applied = opts;
      return { summary: "ok" };
    });
    setTimeSyncReaderForTests(() => ({
      ntpEnabled: true,
      ntpSynced: true,
      ntpServers: ["0.debian.pool.ntp.org"],
      fallbackNtpServers: ["time.cloudflare.com"],
    }));
    try {
      const result = await handleNtp(
        {
          enabled: true,
          servers: ["0.debian.pool.ntp.org"],
          fallbackServers: ["time.cloudflare.com"],
        },
        new Date().toISOString(),
      );
      assertEquals(applied, {
        ntpEnabled: true,
        ntpServers: ["0.debian.pool.ntp.org"],
        ntpFallbackServers: ["time.cloudflare.com"],
      });
      assertEquals(result, {
        ntpEnabled: true,
        ntpSynced: true,
        ntpServers: ["0.debian.pool.ntp.org"],
        fallbackNtpServers: ["time.cloudflare.com"],
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
  name: "handleNtp applies enabled false and custom server arrays",
  fn: async () => {
    const {
      handleNtp,
      setAnsibleAvailabilityCheckForTests,
      setTimeSyncApplyForTests,
      setTimeSyncReaderForTests,
    } = await import("./ntp.ts");

    let applied: unknown;
    setAnsibleAvailabilityCheckForTests(() => Promise.resolve(true));
    setTimeSyncApplyForTests(async (opts) => {
      await Promise.resolve();
      applied = opts;
      return { summary: "disabled" };
    });
    setTimeSyncReaderForTests(() => ({
      ntpEnabled: false,
      ntpSynced: false,
      ntpServers: ["203.0.113.10", "2001:db8::1"],
      fallbackNtpServers: ["time.cloudflare.com"],
    }));
    try {
      const result = await handleNtp(
        {
          enabled: false,
          servers: ["203.0.113.10", "2001:db8::1"],
          fallbackServers: ["time.cloudflare.com"],
        },
        new Date().toISOString(),
      );
      assertEquals(applied, {
        ntpEnabled: false,
        ntpServers: ["203.0.113.10", "2001:db8::1"],
        ntpFallbackServers: ["time.cloudflare.com"],
      });
      assertEquals(result, {
        ntpEnabled: false,
        ntpSynced: false,
        ntpServers: ["203.0.113.10", "2001:db8::1"],
        fallbackNtpServers: ["time.cloudflare.com"],
        summary: "disabled",
      });
    } finally {
      setAnsibleAvailabilityCheckForTests(null);
      setTimeSyncApplyForTests(null);
      setTimeSyncReaderForTests(null);
    }
  },
});

test({
  name: "handleNtp with enabled only preserves existing server lists from host",
  fn: async () => {
    const {
      handleNtp,
      setAnsibleAvailabilityCheckForTests,
      setTimeSyncApplyForTests,
      setTimeSyncReaderForTests,
    } = await import("./ntp.ts");

    let applied: unknown;
    setAnsibleAvailabilityCheckForTests(() => Promise.resolve(true));
    setTimeSyncApplyForTests(async (opts) => {
      await Promise.resolve();
      applied = opts;
      return { summary: "ok" };
    });
    setTimeSyncReaderForTests(() => ({
      ntpEnabled: true,
      ntpSynced: true,
      ntpServers: ["203.0.113.10", "2001:db8::1"],
      fallbackNtpServers: ["time.cloudflare.com"],
    }));
    try {
      await handleNtp({ enabled: false }, new Date().toISOString());
      assertEquals(applied, {
        ntpEnabled: false,
        ntpServers: ["203.0.113.10", "2001:db8::1"],
        ntpFallbackServers: ["time.cloudflare.com"],
      });
    } finally {
      setAnsibleAvailabilityCheckForTests(null);
      setTimeSyncApplyForTests(null);
      setTimeSyncReaderForTests(null);
    }
  },
});
