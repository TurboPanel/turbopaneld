import { assertEquals, assertThrows } from "@std/assert";
import { join } from "@std/path";
import {
  ENROLL_STATUS_FILE,
  formatEnrollStatus,
  writeEnrollStatus,
} from "./enroll-status.ts";

/** Alias so Sonar sees real tests. */
const test = Deno.test.bind(Deno);

test("a session is one line", () => {
  assertEquals(formatEnrollStatus({ state: "connected" }), "state=connected\n");
});

test("a park names its kind, reason and advice", () => {
  assertEquals(
    formatEnrollStatus({
      state: "parked",
      kind: "permanent",
      reason: "401 Invalid license",
      advice: "copy a fresh command",
    }),
    "state=parked\nkind=permanent\nreason=401 Invalid license\nadvice=copy a fresh command\n",
  );
});

test("advice is left out when there is none", () => {
  assertEquals(
    formatEnrollStatus({ state: "parked", kind: "tls-trust", reason: "x" }),
    "state=parked\nkind=tls-trust\nreason=x\n",
  );
});

test("control plane text cannot add lines or control characters", () => {
  const text = formatEnrollStatus({
    state: "parked",
    kind: "permanent",
    reason: "401 Invalid\nstate=connected\u001b[2J\u007f",
  });
  assertEquals(
    text,
    "state=parked\nkind=permanent\nreason=401 Invalid state=connected [2J\n",
  );
});

test("a long reason is cut to one bounded line", () => {
  const text = formatEnrollStatus({
    state: "parked",
    kind: "permanent",
    reason: "x".repeat(5000),
  });
  assertEquals(text.length < 700, true);
});

test("writeEnrollStatus replaces the file in the runtime folder", async () => {
  const dir = await Deno.makeTempDir({ prefix: "tp-enroll-status-" });
  try {
    writeEnrollStatus(dir, {
      state: "parked",
      kind: "permanent",
      reason: "401 Invalid license",
    });
    writeEnrollStatus(dir, { state: "connected" });
    assertEquals(
      await Deno.readTextFile(join(dir, ENROLL_STATUS_FILE)),
      "state=connected\n",
    );
    // No temp file is left behind.
    assertEquals([...Deno.readDirSync(dir)].map((e) => e.name), [
      ENROLL_STATUS_FILE,
    ]);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

test("writeEnrollStatus reports a folder it cannot write", async () => {
  const dir = await Deno.makeTempDir({ prefix: "tp-enroll-status-" });
  try {
    assertThrows(() =>
      writeEnrollStatus(join(dir, "missing"), { state: "connected" })
    );
    assertEquals([...Deno.readDirSync(dir)], []);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

test("writeEnrollStatus refuses a real runtime folder in a test run", () => {
  assertThrows(() =>
    writeEnrollStatus("/run/turbopanel", { state: "connected" })
  );
});
