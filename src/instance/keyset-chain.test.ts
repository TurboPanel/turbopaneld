import { assertEquals } from "@std/assert";
import { keysetVectors as vectors } from "../testing/keyset-vectors.ts";
import {
  createKeysetChainGate,
  followKeysetChain,
  type KeysetEnvelope,
  parseKeysetStatements,
  rotationPasskeysHash,
  statementHead,
} from "./keyset-chain.ts";
import {
  type PanelIdentityPin,
  rotationPasskeysLine,
} from "./panel-identity-pin.ts";

/** Alias so Sonar sees real tests (see src/AGENTS.md). */
const test = Deno.test.bind(Deno);

function pinOf(p: typeof vectors.pin): PanelIdentityPin {
  return {
    current: p.current,
    next: null,
    keyset: p.keyset,
    urls: ["https://cp.example.test"],
    pinnedBy: "install",
    updated: "x",
    rpId: p.rpId,
    passkeys: p.passkeys.map((k) => ({
      id: k.id,
      alg: k.alg === "ES256" ? "ES256" : "EdDSA",
      pub: k.pub,
    })),
  };
}

/** A root stand-in: applies a statement by moving the pin to its head (tp-host is tested on its own). */
function fakeRoot(start: PanelIdentityPin, refuseKeyset?: number) {
  let pin = start;
  const applied: number[] = [];
  return {
    applied,
    pin: () => pin,
    apply: (envelope: KeysetEnvelope) => {
      const head = statementHead(envelope)!;
      if (head.keyset === refuseKeyset) {
        return Promise.reject(new Error("refusing the statement"));
      }
      const doc = JSON.parse(atob(
        envelope.statement.replaceAll("-", "+").replaceAll("_", "/"),
      ));
      applied.push(head.keyset);
      pin = { ...pin, current: doc.current.kid, keyset: doc.keyset };
      return Promise.resolve();
    },
    readPin: () => Promise.resolve(pin),
  };
}

test("an offline server applies every statement that follows its pin, in order", async () => {
  const start = pinOf(vectors.pin);
  const root = fakeRoot(start);
  const asked: number[] = [];
  const applied = await followKeysetChain(start, {
    fetchStatements: (after) => {
      asked.push(after);
      return Promise.resolve(vectors.chain);
    },
    apply: root.apply,
    readPin: root.readPin,
  });
  assertEquals(applied, 3);
  assertEquals(asked, [start.keyset]);
  assertEquals(root.applied, [3, 4, 5]);
  assertEquals(root.pin().current, vectors.pinAfterChain.current);
});

test("statements that do not follow the pin are skipped; a refusal stops the walk", async () => {
  const start = pinOf(vectors.pin);
  // Out of order: only the first follows the pin, the others then follow it.
  const shuffled = [vectors.chain[2]!, vectors.chain[0]!, vectors.chain[1]!];
  const root = fakeRoot(start);
  assertEquals(
    await followKeysetChain(start, {
      fetchStatements: () => Promise.resolve(shuffled),
      apply: root.apply,
      readPin: root.readPin,
    }),
    2,
  );
  const refusing = fakeRoot(start, 4);
  const lines: string[] = [];
  assertEquals(
    await followKeysetChain(start, {
      fetchStatements: () => Promise.resolve(vectors.chain),
      apply: refusing.apply,
      readPin: refusing.readPin,
      log: (line) => lines.push(line),
    }),
    1,
  );
  assertEquals(lines.some((line) => line.includes("key set 4 refused")), true);
});

test("a pin without rotation passkeys never asks for the chain", async () => {
  const start = { ...pinOf(vectors.pin), rpId: "", passkeys: [] };
  let fetched = false;
  assertEquals(
    await followKeysetChain(start, {
      fetchStatements: () => {
        fetched = true;
        return Promise.resolve([]);
      },
      apply: () => Promise.resolve(),
      readPin: () => Promise.resolve(start),
    }),
    0,
  );
  assertEquals(fetched, false);
});

test("the chain answer is parsed strictly and the gate allows one fetch a minute per address", () => {
  assertEquals(
    parseKeysetStatements(
      JSON.stringify({
        statements: [vectors.chain[0], { statement: 1 }, null],
      }),
    ).length,
    1,
  );
  assertEquals(parseKeysetStatements("nope"), []);
  assertEquals(statementHead({ statement: "!!", approvals: [] }), null);
  let now = 0;
  const gate = createKeysetChainGate(() => now);
  assertEquals(gate.tryEnter("https://a"), true);
  assertEquals(gate.tryEnter("https://a"), false);
  assertEquals(gate.tryEnter("https://b"), true);
  now = 60_000;
  assertEquals(gate.tryEnter("https://a"), true);
  // After a fetch that applied a statement the address may be asked again at once.
  assertEquals(gate.tryEnter("https://a"), false);
  gate.release("https://a");
  assertEquals(gate.tryEnter("https://a"), true);
  assertEquals(gate.tryEnter("https://a"), false);
});

test("the passkeys hash is empty with none and order independent otherwise", async () => {
  const pin = pinOf(vectors.pin);
  assertEquals(await rotationPasskeysHash([]), "");
  assertEquals(
    await rotationPasskeysHash(pin.passkeys),
    await rotationPasskeysHash([...pin.passkeys].reverse()),
  );
  assertEquals((await rotationPasskeysHash(pin.passkeys)).length, 43);
});

test("the shared passkeys line vector: sorted by id in code-unit order, then hashed", async () => {
  const { passkeys, line, hash } = vectors.passkeysLine;
  const set = passkeys.map((p) => ({
    id: p.id,
    alg: p.alg as "ES256" | "EdDSA",
    pub: p.pub,
  }));
  assertEquals(rotationPasskeysLine(set), line);
  assertEquals(await rotationPasskeysHash(set), hash);
});
