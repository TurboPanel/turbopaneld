import { assertEquals, assertInstanceOf, assertRejects } from "@std/assert";
import { join } from "@std/path";
import { createTestPanel } from "../testing/panel-signing.ts";
import { DaemonApiError } from "./api-client.ts";
import { classifyConnectFailure } from "./connect-failure.ts";
import {
  createPanelResponseVerifier,
  PanelIdentityError,
  pinnedSessionKey,
  readEnforcedPin,
  UNSIGNED_CONTROL_PLANE_ERROR,
  verifyPanelIdentityDocument,
} from "./panel-identity-trust.ts";

const test = Deno.test.bind(Deno);

const NOW_MS = Date.parse("2026-11-02T12:00:00.000Z");

function pinText(current: string, pinnedBy = "install"): string {
  return [
    `current=${current}`,
    "next=",
    "keyset=1",
    "urls=https://panel.example.test",
    `pinned_by=${pinnedBy}`,
    "updated=2026-11-01T00:00:00Z",
    "",
  ].join("\n");
}

async function withLibDir(
  write: ((lib: string) => Promise<void>) | null,
  fn: (env: Record<string, string>) => Promise<void>,
): Promise<void> {
  const root = await Deno.makeTempDir();
  try {
    const lib = join(root, "lib");
    await Deno.mkdir(lib, { recursive: true });
    if (write) await write(lib);
    await fn({ TURBOPANEL_LIB_DIR: lib });
  } finally {
    await Deno.remove(root, { recursive: true });
  }
}

test("no pin file, or an unsafe pin, means no enforcement; a broken pin file is a panel identity failure", async () => {
  await withLibDir(null, async (env) => {
    assertEquals(await readEnforcedPin(env), null);
  });
  await withLibDir(
    (lib) =>
      Deno.writeTextFile(join(lib, "panel-identity"), pinText("", "unsafe")),
    async (env) => {
      assertEquals(await readEnforcedPin(env), null);
    },
  );
  const kid = "k".repeat(43);
  await withLibDir(
    (lib) => Deno.writeTextFile(join(lib, "panel-identity"), pinText(kid)),
    async (env) => {
      assertEquals((await readEnforcedPin(env))?.current, kid);
    },
  );
  await withLibDir(
    (lib) => Deno.writeTextFile(join(lib, "panel-identity"), "garbage\n"),
    async (env) => {
      await assertRejects(() => readEnforcedPin(env), PanelIdentityError);
    },
  );
});

test("the identity document must be signed by a pinned key with a keyset not below the pin", async () => {
  const panel = await createTestPanel(2);
  const other = await createTestPanel(2);
  const fetched = await panel.identityFetch({ nowMs: NOW_MS });
  const key = await verifyPanelIdentityDocument(fetched, panel.pin(), NOW_MS);
  assertEquals(key.kid, panel.kid);
  await assertRejects(
    () => verifyPanelIdentityDocument(fetched, other.pin(), NOW_MS),
    PanelIdentityError,
  );
  await assertRejects(
    () =>
      verifyPanelIdentityDocument(
        { ...fetched, signature: null },
        panel.pin(),
        NOW_MS,
      ),
    PanelIdentityError,
  );
  const lowerKeyset = await panel.identityFetch({ nowMs: NOW_MS, keyset: 1 });
  await assertRejects(
    () => verifyPanelIdentityDocument(lowerKeyset, panel.pin(), NOW_MS),
    PanelIdentityError,
  );
});

test("signed answers pass; unsigned errors change nothing; forged or unsigned successes park", async () => {
  const panel = await createTestPanel();
  const signing = await panel.signing();
  const verifier = createPanelResponseVerifier(() => ({
    pinned: true,
    key: signing,
  }));
  const path = "/api/daemon/v1/auth/session";
  const body = '{"ok":false,"error":"Server key not found"}';
  assertEquals(verifier.covers(path), true);
  assertEquals(verifier.covers("/api/daemon/v1/metrics"), false);
  await verifier.verify(path, 404, await panel.httpHeader(path, body), body);

  const unsignedError = await verifier.verify(path, 404, null, body).catch(
    (err) => err,
  );
  assertInstanceOf(unsignedError, DaemonApiError);
  assertEquals(unsignedError.message, UNSIGNED_CONTROL_PLANE_ERROR);
  // Never read as "the panel forgot this server's key".
  assertEquals(classifyConnectFailure(unsignedError).kind, "transient");

  const forged = await verifier.verify(
    path,
    404,
    await panel.httpHeader(path, '{"other":1}'),
    body,
  ).catch((err) => err);
  assertInstanceOf(forged, PanelIdentityError);
  assertEquals(classifyConnectFailure(forged).kind, "panel-identity");

  await assertRejects(
    () => verifier.verify(path, 200, null, '{"token":"t"}'),
    PanelIdentityError,
  );
});

test("an unpinned server checks nothing", () => {
  const verifier = createPanelResponseVerifier(() => ({
    pinned: false,
    key: undefined,
  }));
  assertEquals(verifier.covers("/api/daemon/v1/auth/session"), false);
});

test("pinned with no verified key held refuses every covered answer, as a retryable error", async () => {
  const verifier = createPanelResponseVerifier(() => ({
    pinned: true,
    key: undefined,
  }));
  const path = "/api/daemon/v1/jwks.json";
  assertEquals(verifier.covers(path), true);
  const err = await verifier.verify(path, 200, null, "{}").catch((e) => e);
  assertEquals(err instanceof PanelIdentityError, false);
  assertEquals(classifyConnectFailure(err).kind, "transient");
});

test("a session key: none without a pin, the verified key when pinned, and never a pinned session without one", async () => {
  const panel = await createTestPanel();
  const other = await createTestPanel();
  const pin = panel.pin();
  const key = await panel.signing();
  // No pin: the plain session, whatever key is around.
  assertEquals(pinnedSessionKey(null, undefined), null);
  assertEquals(pinnedSessionKey(null, key), null);
  assertEquals(pinnedSessionKey(pin, key), { pin, signing: key });
  // Pinned with no verified key, or one the pin does not hold: no session at
  // all. Retried like a network failure (the next connect verifies afresh),
  // never parked as a wrong key.
  for (const missing of [undefined, await other.signing()]) {
    let thrown: unknown;
    try {
      pinnedSessionKey(pin, missing);
    } catch (err) {
      thrown = err;
    }
    assertInstanceOf(thrown, Error);
    assertEquals(thrown instanceof PanelIdentityError, false);
    assertEquals(thrown.message.includes("holds no verified key"), true);
    assertEquals(classifyConnectFailure(thrown).kind, "transient");
  }
});
