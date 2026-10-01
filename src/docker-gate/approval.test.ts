import { assert, assertEquals, assertRejects } from "@std/assert";
import {
  APPROVABLE_RULES,
  APPROVAL_CLOCK_SKEW_SEC,
  importApprovalKeys,
  MAX_APPROVAL_TTL_SEC,
  splitApproved,
  verifyApproval,
} from "../../orchestration/roles/docker-gate/files/approval.ts";
import {
  generateKeys,
  payloadFor,
  signToken,
} from "../testing/docker-gate-approval.ts";

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno);

const NOW = 1_800_000_000;
const PROJECT = "tenantapp";

async function setup() {
  const keys = await generateKeys();
  const trusted = await importApprovalKeys(`# control plane\n${keys.rawB64}\n`);
  return { keys, trusted };
}

function reason(result: Awaited<ReturnType<typeof verifyApproval>>): string {
  return result.ok ? "ok" : result.reason;
}

test("a token signed by the trusted key verifies and carries its claims", async () => {
  const { keys, trusted } = await setup();
  const token = await signToken(keys, payloadFor(NOW));
  const result = await verifyApproval(token, trusted, PROJECT, NOW);
  assert(result.ok);
  assertEquals(result.payload.deployId, "deploy-1");
  assertEquals(result.payload.features, ["privileged"]);
});

test("a key the gate does not trust, a tampered payload and a stripped signature are refused", async () => {
  const { keys, trusted } = await setup();
  const other = await generateKeys();
  const forged = await signToken(other, payloadFor(NOW));
  assertEquals(
    reason(await verifyApproval(forged, trusted, PROJECT, NOW)),
    "bad-signature",
  );
  const good = await signToken(keys, payloadFor(NOW));
  const [version, , signature] = good.split(".");
  const widened = await signToken(
    keys,
    payloadFor(NOW, { features: ["docker-socket"] }),
  );
  const swapped = `${version}.${widened.split(".")[1]}.${signature}`;
  assertEquals(
    reason(await verifyApproval(swapped, trusted, PROJECT, NOW)),
    "bad-signature",
  );
  assertEquals(
    reason(
      await verifyApproval(
        `${version}.${good.split(".")[1]}.`,
        trusted,
        PROJECT,
        NOW,
      ),
    ),
    "bad-signature",
  );
});

test("a signature made for another purpose does not verify (domain separation)", async () => {
  const { keys, trusted } = await setup();
  const token = await signToken(keys, payloadFor(NOW), {
    domain: "something-else\n",
  });
  assertEquals(
    reason(await verifyApproval(token, trusted, PROJECT, NOW)),
    "bad-signature",
  );
});

test("expiry, clock skew, lifetime cap and project binding are enforced", async () => {
  const { keys, trusted } = await setup();
  const check = async (
    patch: Parameters<typeof payloadFor>[1],
    now = NOW,
    project = PROJECT,
  ) =>
    reason(
      await verifyApproval(
        await signToken(keys, payloadFor(NOW, patch)),
        trusted,
        project,
        now,
      ),
    );
  assertEquals(await check({}, NOW + 300), "expired");
  assertEquals(await check({}, NOW + 299), "ok");
  assertEquals(await check({ iat: NOW + APPROVAL_CLOCK_SKEW_SEC }), "ok");
  assertEquals(
    await check({ iat: NOW + APPROVAL_CLOCK_SKEW_SEC + 1, exp: NOW + 600 }),
    "not-yet-valid",
  );
  assertEquals(await check({ exp: NOW + MAX_APPROVAL_TTL_SEC }), "ok");
  assertEquals(
    await check({ exp: NOW + MAX_APPROVAL_TTL_SEC + 1 }),
    "ttl-too-long",
  );
  assertEquals(await check({}, NOW, "someone-else"), "wrong-project");
  assertEquals(await check({ features: [] }), "no-features");
});

test("malformed tokens and payloads are refused without throwing", async () => {
  const { keys, trusted } = await setup();
  const check = async (token: string) =>
    reason(await verifyApproval(token, trusted, PROJECT, NOW));
  assertEquals(await check(""), "malformed");
  assertEquals(await check("v1.only-two"), "malformed");
  assertEquals(await check("v1.a.b.c"), "malformed");
  assertEquals(await check("v2.AAAA.AAAA"), "unsupported-version");
  assertEquals(await check("v1.not base64!.AAAA"), "malformed");
  assertEquals(await check(`v1.${"A".repeat(5000)}.AAAA`), "malformed");
  assertEquals(await check(await signToken(keys, "not json")), "malformed");
  assertEquals(await check(await signToken(keys, "[1,2]")), "malformed");
  assertEquals(
    await check(
      await signToken(
        keys,
        JSON.stringify({ ...payloadFor(NOW), exp: "soon" }),
      ),
    ),
    "malformed",
  );
  assertEquals(
    await check(
      await signToken(
        keys,
        JSON.stringify({ ...payloadFor(NOW), features: [1] }),
      ),
    ),
    "malformed",
  );
});

test("with no trusted keys every token is refused", async () => {
  const keys = await generateKeys();
  const token = await signToken(keys, payloadFor(NOW));
  assertEquals(
    reason(await verifyApproval(token, [], PROJECT, NOW)),
    "approvals-off",
  );
});

test("a rotation overlap trusts both keys", async () => {
  const [a, b] = [await generateKeys(), await generateKeys()];
  const trusted = await importApprovalKeys(`${a.rawB64}\n\n${b.rawB64}\n`);
  assertEquals(trusted.length, 2);
  for (const keys of [a, b]) {
    const token = await signToken(keys, payloadFor(NOW));
    assert((await verifyApproval(token, trusted, PROJECT, NOW)).ok);
  }
});

test("importApprovalKeys rejects anything that is not a raw Ed25519 key", async () => {
  await assertRejects(() => importApprovalKeys("not a key"));
  await assertRejects(() => importApprovalKeys("AAAA"));
  assertEquals((await importApprovalKeys("# only a comment\n\n")).length, 0);
});

test("an approval relaxes only the rules its features name", async () => {
  const keys = await generateKeys();
  const trusted = await importApprovalKeys(keys.rawB64);
  const result = await verifyApproval(
    await signToken(
      keys,
      payloadFor(NOW, { features: ["privileged", "docker-socket"] }),
    ),
    trusted,
    PROJECT,
    NOW,
  );
  assert(result.ok);
  const found = [
    { rule: "privileged" },
    { rule: "bind-docker-socket", detail: "/var/run/docker.sock" },
    { rule: "bind-outside-roots", detail: "/mnt/x" },
    { rule: "bind-host-root", detail: "/" },
    { rule: "userns-mode-host" },
  ];
  const { remaining, approved } = splitApproved(found, result.payload);
  assertEquals(approved.map((v) => v.rule), [
    "privileged",
    "bind-docker-socket",
  ]);
  assertEquals(remaining.map((v) => v.rule), [
    "bind-outside-roots",
    "bind-host-root",
    "userns-mode-host",
  ]);
});

test("the approvable set never includes the unconditional rules", () => {
  for (
    const rule of [
      "bind-host-root",
      "bind-forbidden-path",
      "bind-noncanonical-path",
      "userns-mode-host",
      "volumes-from",
      "masked-paths",
      "archive-put",
      "platform-config-writable",
    ]
  ) {
    assertEquals(APPROVABLE_RULES[rule], undefined, rule);
  }
});
