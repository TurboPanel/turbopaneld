import { assertEquals, assertRejects, assertThrows } from "@std/assert";
import {
  assertValidHostname,
  HOSTNAME_MAX_LENGTH,
  isValidHostname,
  parseHostnamePayload,
} from "./contracts.ts";

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno);

test("isValidHostname mirrors instance rejection cases", () => {
  const reject = [
    "a b",
    "Web01",
    ";",
    "|",
    "$(reboot)",
    "`id`",
    "-a",
    "a-",
    ".a",
    "a.",
    "",
    "a".repeat(254),
  ];
  for (const value of reject) {
    assertEquals(isValidHostname(value), false);
  }

  assertEquals(isValidHostname("web-01"), true);
  assertEquals(isValidHostname("host.example.com"), true);
  assertEquals(isValidHostname(`a${"b".repeat(61)}c`), true);
  const labels = Array.from({ length: 40 }, (_, i) => `n${i}`).join(".");
  assertEquals(labels.length <= HOSTNAME_MAX_LENGTH, true);
  assertEquals(isValidHostname(labels), true);
});

test("assertValidHostname and parseHostnamePayload enforce hostname safety", () => {
  assertThrows(
    () => assertValidHostname("a;rm -rf /"),
    Error,
    "Invalid hostname",
  );
  assertEquals(parseHostnamePayload({ hostname: "web-01" }), {
    hostname: "web-01",
  });
  assertThrows(
    () => parseHostnamePayload(null),
    Error,
    "Invalid hostname payload",
  );
  assertThrows(
    () => parseHostnamePayload({ hostname: "a b" }),
    Error,
    "Invalid hostname",
  );
});

test({
  name: "handleHostname rejects when ansible runtime is missing",
  fn: async () => {
    const { handleHostname, setAnsibleAvailabilityCheckForTests } =
      await import(
        "./hostname.ts"
      );

    setAnsibleAvailabilityCheckForTests(() => Promise.resolve(false));
    try {
      const nowIso = new Date().toISOString();
      await assertRejects(
        () => handleHostname({ hostname: "web-01" }, nowIso),
        Error,
        "Ansible/bootstrap runtime is missing",
      );
    } finally {
      setAnsibleAvailabilityCheckForTests(null);
    }
  },
});

test({
  name: "handleHostname applies hostname and returns observed hostname",
  fn: async () => {
    const {
      handleHostname,
      setAnsibleAvailabilityCheckForTests,
      setRunSetHostnameForTests,
    } = await import("./hostname.ts");

    setAnsibleAvailabilityCheckForTests(() => Promise.resolve(true));
    setRunSetHostnameForTests(() =>
      Promise.resolve({ summary: "hostname-ok" })
    );
    try {
      const result = await handleHostname(
        { hostname: "web-01" },
        new Date().toISOString(),
      );
      assertEquals(typeof result.observedHostname, "string");
      assertEquals(result.observedHostname.length > 0, true);
      assertEquals(result.summary, "hostname-ok");
    } finally {
      setAnsibleAvailabilityCheckForTests(null);
      setRunSetHostnameForTests(null);
    }
  },
});

test({
  name: "handleHostname omits summary when ansible apply returns empty",
  fn: async () => {
    const {
      handleHostname,
      setAnsibleAvailabilityCheckForTests,
      setRunSetHostnameForTests,
    } = await import("./hostname.ts");

    setAnsibleAvailabilityCheckForTests(() => Promise.resolve(true));
    setRunSetHostnameForTests(() => Promise.resolve({ summary: "" }));
    try {
      const result = await handleHostname(
        { hostname: "web-01" },
        new Date().toISOString(),
      );
      assertEquals(typeof result.observedHostname, "string");
      assertEquals(result.observedHostname.length > 0, true);
      assertEquals("summary" in result, false);
    } finally {
      setAnsibleAvailabilityCheckForTests(null);
      setRunSetHostnameForTests(null);
    }
  },
});
