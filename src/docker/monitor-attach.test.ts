import { assertEquals } from "@std/assert";
import {
  decideDockerMonitorAttach,
  dockerBinaryPresent,
} from "./monitor-attach.ts";

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno);

test("attach monitor when Docker socket is already reachable", () => {
  const decision = decideDockerMonitorAttach({
    socketReachable: true,
    dockerBinaryPresent: false,
  });
  assertEquals(decision, { attach: true, warnSocketDown: false });
});

test("attach monitor with warn when binary exists but socket is down", () => {
  // Engine installed but not ready yet (group membership / service start).
  const decision = decideDockerMonitorAttach({
    socketReachable: false,
    dockerBinaryPresent: true,
  });
  assertEquals(decision, { attach: true, warnSocketDown: true });
});

test("skip monitor when Docker is not installed at all", () => {
  // Opted-in co-located dev before converge — do not look "stuck waiting".
  const decision = decideDockerMonitorAttach({
    socketReachable: false,
    dockerBinaryPresent: false,
  });
  assertEquals(decision, {
    attach: false,
    reason: "docker-not-installed",
  });
});

test("dockerBinaryPresent is true for an existing path", async () => {
  const dir = await Deno.makeTempDir();
  const bin = `${dir}/docker`;
  try {
    await Deno.writeTextFile(bin, "#!/bin/sh\n");
    assertEquals(await dockerBinaryPresent(bin), true);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

test("dockerBinaryPresent is false when the path is missing", async () => {
  assertEquals(
    await dockerBinaryPresent("/tmp/turbopanel-no-such-docker-binary"),
    false,
  );
});
