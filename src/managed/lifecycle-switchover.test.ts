import { assertEquals } from "@std/assert";
import { captureSwitchoverGtidBeforeStop } from "./lifecycle-switchover.ts";

const test = Deno.test.bind(Deno);

test("captureSwitchoverGtidBeforeStop is a no-op without captureSwitchoverGtid", async () => {
  const out = await captureSwitchoverGtidBeforeStop(
    { managedId: "abc", action: "stop" },
    async () => ({ success: true, stdout: "", stderr: "", code: 0 }),
  );
  assertEquals(out, undefined);
});
