import { assert, assertEquals, assertFalse } from "@std/assert";
import { isPermissionDeniedText } from "./run.ts";
import { readSshdEffectivePorts } from "./sshd-port.ts";

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno);

const ok = { success: true, code: 0, stdout: "", stderr: "" };

test("the sudo retry fires on the kernel spellings and on sshd's own 'no hostkeys available'", () => {
  assert(isPermissionDeniedText({ ...ok, stderr: "Permission denied" }));
  assert(isPermissionDeniedText({ ...ok, stderr: "Operation not permitted" }));
  // Unprivileged `sshd -T` on Debian 13: exit 0, this line, no config — it
  // could not read the host keys, which is a permission failure in disguise.
  assert(isPermissionDeniedText({
    ...ok,
    stderr: "sshd: no hostkeys available -- exiting.",
  }));
  assertFalse(isPermissionDeniedText({ ...ok, stderr: "no such chain" }));
});

test("sshd -T that reached the caller still saying 'no hostkeys' is a detection failure, not an empty port set", async () => {
  const result = await readSshdEffectivePorts(() =>
    Promise.resolve({
      ...ok,
      stderr: "sshd: no hostkeys available -- exiting.",
    })
  );
  assertEquals(result.ports, []);
  assert(result.warning?.includes("could not be detected"));
});
