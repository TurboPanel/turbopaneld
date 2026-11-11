import { assertEquals, assertRejects } from "@std/assert";
import {
  syncAccountWallOrThrow,
  syncAccountWallQuietly,
} from "./account-wall.ts";

const test = Deno.test.bind(Deno);

function fakeRun(success: boolean, stderr = "") {
  const calls: string[][] = [];
  return {
    calls,
    run: (_command: string, args: string[]) => {
      calls.push(args);
      return Promise.resolve({ success, stdout: "", stderr });
    },
  };
}

test("syncAccountWallOrThrow asks tp-host for php-loopback-sync", async () => {
  const fake = fakeRun(true);
  await syncAccountWallOrThrow(fake.run);
  assertEquals(fake.calls.length, 1);
  assertEquals(fake.calls[0].includes("php-loopback-sync"), true);
});

test("syncAccountWallOrThrow fails with the helper's message", async () => {
  const fake = fakeRun(false, "nft refused the ruleset");
  await assertRejects(
    () => syncAccountWallOrThrow(fake.run),
    Error,
    "nft refused the ruleset",
  );
});

test("syncAccountWallQuietly warns instead of throwing", async () => {
  const fake = fakeRun(false, "ip failed");
  const warnings: string[] = [];
  await syncAccountWallQuietly(fake.run, (message) => warnings.push(message));
  assertEquals(warnings.length, 1);
  assertEquals(warnings[0].includes("ip failed"), true);
});
