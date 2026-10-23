import { assertEquals } from "@std/assert";
import {
  bootConvergeSettled,
  resetBootConvergeForTests,
  trackBootConverge,
} from "./boot-converge-gate.ts";

const test = Deno.test.bind(Deno);

test("bootConvergeSettled resolves at once when no boot converge is running", async () => {
  resetBootConvergeForTests();
  await bootConvergeSettled();
});

test("bootConvergeSettled waits for the running boot converge", async () => {
  resetBootConvergeForTests();
  let finish!: (ok: boolean) => void;
  const run = new Promise<boolean>((resolve) => {
    finish = resolve;
  });
  trackBootConverge(run);
  let settled = false;
  const waiting = bootConvergeSettled().then(() => {
    settled = true;
  });
  await Promise.resolve();
  assertEquals(settled, false);
  finish(true);
  await waiting;
  assertEquals(settled, true);
});

test("bootConvergeSettled also resolves when the boot converge fails or throws", async () => {
  resetBootConvergeForTests();
  trackBootConverge(Promise.reject(new Error("playbook failed")));
  await bootConvergeSettled();
  resetBootConvergeForTests();
  trackBootConverge(Promise.resolve(false));
  await bootConvergeSettled();
});
