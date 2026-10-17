import { assertEquals, assertRejects } from "@std/assert";
import type { RunFn } from "../ensure-principal.ts";
import { publishInFolder, publishOpenInFolder } from "./folder-publish.ts";

const test = Deno.test.bind(Deno);

const layout = { principalHomeRoot: "/srv/users" };
const parts = { owner: "alice", scope: "production", slug: "example.com" };
const ids = {
  serviceId: "019e0a1b-7c3d-7a52-9b4e-3f1a2c5d6e70",
  releaseId: "019e0a1b-7c3d-7a52-9b4e-3f1a2c5d6e71",
  publishId: "019e0a1b-7c3d-7a52-9b4e-3f1a2c5d6e72",
};

function recorder(success = true): { runFn: RunFn; calls: string[][] } {
  const calls: string[][] = [];
  const runFn: RunFn = (_command, args) => {
    calls.push(args);
    return Promise.resolve({
      success,
      stdout: "",
      stderr: success ? "" : "no",
    });
  };
  return { runFn, calls };
}

test("publish-open sends components and ids, and returns the staging leaf", async () => {
  const { runFn, calls } = recorder();
  const leaf = await publishOpenInFolder(layout, parts, ids, runFn);
  assertEquals(leaf, `/srv/users/.tp-staging/${ids.publishId}`);
  assertEquals(calls, [[
    "-n",
    "publish-open",
    "alice",
    "production",
    "example.com",
    ids.serviceId,
    ids.releaseId,
    ids.publishId,
  ]]);
});

test("publish sends the same six words", async () => {
  const { runFn, calls } = recorder();
  await publishInFolder(parts, ids, runFn);
  assertEquals(calls[0].slice(1), [
    "publish",
    "alice",
    "production",
    "example.com",
    ids.serviceId,
    ids.releaseId,
    ids.publishId,
  ]);
});

test("a name or id outside the shared rules is refused before sudo", async () => {
  const { runFn, calls } = recorder();
  await assertRejects(
    () => publishInFolder({ ...parts, slug: "../x" }, ids, runFn),
    TypeError,
  );
  for (const key of Object.keys(ids) as Array<keyof typeof ids>) {
    await assertRejects(
      () => publishInFolder(parts, { ...ids, [key]: "r1" }, runFn),
      TypeError,
      key,
    );
  }
  assertEquals(calls, []);
});

test("a refusal from the root helper is an error", async () => {
  const { runFn } = recorder(false);
  await assertRejects(
    () => publishInFolder(parts, ids, runFn),
    Error,
    "no",
  );
});
