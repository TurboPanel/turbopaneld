import { assert, assertEquals, assertRejects } from "@std/assert";
import { guardHostSetup, makeHost } from "./tp-host-fixture.ts";

const test = Deno.test.bind(Deno);

test("a host setup that throws restores the umask and removes its prefix", async () => {
  const before = Deno.umask(0o002);
  try {
    let seen = "";
    await assertRejects(
      () =>
        guardHostSetup("tp-host-guard-test-", async (prefix) => {
          seen = prefix;
          await Deno.mkdir(`${prefix}/etc`, { recursive: true });
          assertEquals(Deno.umask(0o022), 0o022);
          throw new Error("setup failed");
        }),
      Error,
      "setup failed",
    );
    assert(seen.length > 0);
    assertEquals(
      await Deno.stat(seen).then(() => true, () => false),
      false,
    );
    assertEquals(Deno.umask(0o002), 0o002);
  } finally {
    Deno.umask(before);
  }
});

test("a host pins umask 022 until its cleanup puts the old one back", async () => {
  const before = Deno.umask(0o002);
  try {
    const host = await makeHost();
    assertEquals(Deno.umask(0o022), 0o022);
    await host.cleanup();
    assertEquals(Deno.umask(0o002), 0o002);
  } finally {
    Deno.umask(before);
  }
});
