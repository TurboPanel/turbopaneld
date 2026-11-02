import { assertEquals, assertRejects } from "@std/assert";
import { openPrincipalPasswordEnvelopes } from "./principal-password-envelope.ts";

const test = Deno.test.bind(Deno);

type Entry = {
  username: string;
  passwordHash?: string;
  passwordHashEnvelope?: string;
};

const HASH = `$6$saltstring$${"a".repeat(86)}`;

test("envelopes are opened into passwordHash and entries without one pass through", async () => {
  const seen: string[][] = [];
  const opened = await openPrincipalPasswordEnvelopes(
    [
      { username: "alice", passwordHashEnvelope: "tpdaemon.v1.alice" },
      { username: "bob" },
      { username: "carol", passwordHash: HASH },
    ] as Entry[],
    (ciphertexts) => {
      seen.push(ciphertexts);
      return Promise.resolve(ciphertexts.map(() => HASH));
    },
  );
  assertEquals(seen, [["tpdaemon.v1.alice"]]);
  assertEquals(opened, [
    { username: "alice", passwordHash: HASH },
    { username: "bob" },
    { username: "carol", passwordHash: HASH },
  ]);
});

test("a failed or malformed opening fails the call instead of locking the account", async () => {
  const entries = [{
    username: "alice",
    passwordHashEnvelope: "tpdaemon.v1.a",
  }];
  await assertRejects(() =>
    openPrincipalPasswordEnvelopes(entries, () => Promise.resolve([null]))
  );
  await assertRejects(() =>
    openPrincipalPasswordEnvelopes(entries, () => Promise.resolve(["hunter2"]))
  );
  await assertRejects(() => openPrincipalPasswordEnvelopes(entries, undefined));
});

test("nothing is decrypted when no entry carries an envelope", async () => {
  let calls = 0;
  const result = await openPrincipalPasswordEnvelopes(
    [{ username: "bob" }] as Entry[],
    () => {
      calls += 1;
      return Promise.resolve([]);
    },
  );
  assertEquals(result, [{ username: "bob" }]);
  assertEquals(calls, 0);
});
