import { assertEquals } from "@std/assert";
import {
  beginUpdateDrain,
  bootConvergeSettled,
  endUpdateDrain,
  isUpdateDraining,
  resetBootConvergeForTests,
  runningCommandCount,
  trackBootConverge,
  waitForCommandsToDrain,
  withCommandRunning,
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

test("waitForCommandsToDrain returns at once when nothing runs, without sleeping", async () => {
  resetBootConvergeForTests();
  let slept = false;
  const left = await waitForCommandsToDrain(1_000, () => {
    slept = true;
    return new Promise<void>(() => {});
  });
  assertEquals(left, 0);
  assertEquals(slept, false);
});

test("waitForCommandsToDrain waits for a running command and ignores the cap while it runs", async () => {
  resetBootConvergeForTests();
  let finish!: () => void;
  const command = withCommandRunning(
    () => new Promise<void>((resolve) => (finish = resolve)),
  );
  const left = waitForCommandsToDrain(
    1_000,
    () => new Promise<void>(() => {}),
  );
  assertEquals(runningCommandCount(), 1);
  finish();
  await command;
  assertEquals(await left, 0);
});

test("waitForCommandsToDrain gives up at the cap and reports what still runs", async () => {
  resetBootConvergeForTests();
  let capReached!: () => void;
  let finish!: () => void;
  const command = withCommandRunning(
    () => new Promise<void>((resolve) => (finish = resolve)),
  );
  const left = waitForCommandsToDrain(
    1_000,
    () => new Promise<void>((resolve) => (capReached = resolve)),
  );
  capReached();
  assertEquals(await left, 1);
  finish();
  await command;
  assertEquals(runningCommandCount(), 0);
});

test("the update drain flag opens and closes, and a reset clears it", () => {
  resetBootConvergeForTests();
  assertEquals(isUpdateDraining(), false);
  beginUpdateDrain();
  assertEquals(isUpdateDraining(), true);
  endUpdateDrain();
  assertEquals(isUpdateDraining(), false);
  beginUpdateDrain();
  resetBootConvergeForTests();
  assertEquals(isUpdateDraining(), false);
});
