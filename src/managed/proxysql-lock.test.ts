import { assertEquals, assertRejects } from "@std/assert";
import {
  markProxySqlReconciled,
  proxySqlReconciledSinceStart,
  resetProxySqlLockForTests,
  withProxySqlLock,
} from "./proxysql-lock.ts";

Deno.test("proxysql lock: runs holders one at a time, in order", async () => {
  resetProxySqlLockForTests();
  const events: string[] = [];
  let release!: () => void;
  const first = withProxySqlLock(async () => {
    events.push("first:start");
    await new Promise<void>((resolve) => release = resolve);
    events.push("first:end");
  });
  const second = withProxySqlLock(() => {
    events.push("second");
    return Promise.resolve();
  });
  await new Promise((r) => setTimeout(r, 5));
  assertEquals(events, ["first:start"]);
  release();
  await Promise.all([first, second]);
  assertEquals(events, ["first:start", "first:end", "second"]);
});

Deno.test("proxysql lock: released after a rejection, error still surfaces", async () => {
  resetProxySqlLockForTests();
  await assertRejects(
    () => withProxySqlLock(() => Promise.reject(new Error("boom"))),
    Error,
    "boom",
  );
  assertEquals(await withProxySqlLock(() => Promise.resolve("next")), "next");
});

Deno.test("proxysql lock: reconciled flag starts false and sticks once set", () => {
  resetProxySqlLockForTests();
  assertEquals(proxySqlReconciledSinceStart(), false);
  markProxySqlReconciled();
  assertEquals(proxySqlReconciledSinceStart(), true);
});
