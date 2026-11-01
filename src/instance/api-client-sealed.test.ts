import { assert, assertEquals, assertRejects } from "@std/assert";
import { decodeBase64Url } from "@std/encoding/base64url";
import {
  type HpkeEnvelope,
  isHpkeEnvelope,
  openFromSender,
  sealingKid,
} from "../crypto/hpke.ts";
import { sharedSecretRedactor } from "../logs/redactor.ts";
import { createFakeInstanceApi } from "../testing/fake-instance-api.ts";
import {
  HPKE_VECTOR,
  HPKE_VECTOR_AAD,
  HPKE_VECTOR_PLAINTEXT,
  HPKE_VECTOR_RECIPIENT_SEED,
} from "../testing/hpke-vector.ts";
import {
  DaemonApiClient,
  DaemonApiError,
  type DaemonSealingContext,
} from "./api-client.ts";
import type { PanelSealKey } from "./panel-identity-cache.ts";
import { registerSealingKey } from "./sealing.ts";

const test = Deno.test.bind(Deno);

const DECRYPT_PATH = "/api/daemon/v1/secrets/decrypt";
const REGISTER_PATH = "/api/daemon/v1/servers/self/sealing-key";

function sealingContext(
  state: { sealed: boolean; marks: number },
): DaemonSealingContext {
  return {
    open: async (envelope) =>
      new TextDecoder().decode(
        await openFromSender(
          HPKE_VECTOR_RECIPIENT_SEED,
          HPKE_VECTOR_AAD,
          envelope,
        ),
      ),
    isTrustSealed: () => Promise.resolve(state.sealed),
    markTrustSealed: () => {
      state.sealed = true;
      state.marks += 1;
      return Promise.resolve();
    },
  };
}

function clientWith(sealing?: DaemonSealingContext): DaemonApiClient {
  return new DaemonApiClient({
    config: {
      kind: "url",
      baseUrl: "https://instance.test",
      wsBaseUrl: "wss://instance.test",
    },
    getToken: () => Promise.resolve("tok"),
    sleep: () => Promise.resolve(),
    ...(sealing ? { sealing } : {}),
  });
}

function answer(body: unknown): () => Response {
  return () => new Response(JSON.stringify(body), { status: 200 });
}

/** Run `fn` with Deno's stdout and stderr captured; returns everything written. */
async function captureOutput(fn: () => Promise<void>): Promise<string> {
  const lines: string[] = [];
  const originals = [
    [Deno.stdout, Deno.stdout.writeSync.bind(Deno.stdout)],
    [Deno.stderr, Deno.stderr.writeSync.bind(Deno.stderr)],
  ] as const;
  for (const [stream] of originals) {
    stream.writeSync = (data: Uint8Array) => {
      lines.push(new TextDecoder().decode(data));
      return data.length;
    };
  }
  try {
    await fn();
  } finally {
    for (const [stream, original] of originals) stream.writeSync = original;
  }
  return lines.join("");
}

test("a sealed answer is opened locally, remembered for redaction and marks the trust level", async () => {
  const api = createFakeInstanceApi();
  const restore = api.install();
  try {
    api.script(DECRYPT_PATH, answer({ sealed: [HPKE_VECTOR, null] }));
    const state = { sealed: false, marks: 0 };
    const plaintexts = await clientWith(sealingContext(state)).decryptSecrets([
      "tpdaemon.v1.a",
      "tpdaemon.v1.b",
    ]);
    assertEquals(plaintexts, [HPKE_VECTOR_PLAINTEXT, null]);
    assertEquals(state, { sealed: true, marks: 1 });
    assert(
      !sharedSecretRedactor().redact(`x ${HPKE_VECTOR_PLAINTEXT} y`).includes(
        HPKE_VECTOR_PLAINTEXT,
      ),
    );
  } finally {
    restore();
  }
});

test("plaintext is accepted until a sealed answer has been seen, then refused", async () => {
  const api = createFakeInstanceApi();
  const restore = api.install();
  try {
    api.script(DECRYPT_PATH, answer({ plaintexts: ["plain"] }));
    const state = { sealed: false, marks: 0 };
    const client = clientWith(sealingContext(state));
    assertEquals(await client.decryptSecrets(["tpdaemon.v1.a"]), ["plain"]);

    state.sealed = true;
    const err = await assertRejects(
      () => client.decryptSecrets(["tpdaemon.v1.a"]),
      DaemonApiError,
    );
    assertEquals(err.status, 400);
    assertEquals(err.message, "plaintext secrets refused");
  } finally {
    restore();
  }
});

test("a malformed sealed answer is refused without marking the trust level", async () => {
  const api = createFakeInstanceApi();
  const restore = api.install();
  try {
    const state = { sealed: false, marks: 0 };
    const client = clientWith(sealingContext(state));
    const cases: unknown[] = [
      { sealed: [HPKE_VECTOR], plaintexts: ["plain"] },
      { sealed: [HPKE_VECTOR, HPKE_VECTOR] },
      { sealed: ["tpdaemon.v1.x"] },
      { sealed: [{ ...HPKE_VECTOR, ct: HPKE_VECTOR.ct.slice(1) }] },
    ];
    let current: unknown;
    api.script(DECRYPT_PATH, () => answer(current)());
    for (const body of cases) {
      current = body;
      await assertRejects(
        () => client.decryptSecrets(["tpdaemon.v1.a"]),
        DaemonApiError,
      );
    }
    assertEquals(state, { sealed: false, marks: 0 });
  } finally {
    restore();
  }
});

test("a client without a sealing context cannot take a sealed answer", async () => {
  const api = createFakeInstanceApi();
  const restore = api.install();
  try {
    api.script(DECRYPT_PATH, answer({ sealed: [HPKE_VECTOR] }));
    await assertRejects(
      () => clientWith().decryptSecrets(["tpdaemon.v1.a"]),
      DaemonApiError,
    );
  } finally {
    restore();
  }
});

test("registerSealingKey posts kid, pub and sig", async () => {
  const api = createFakeInstanceApi();
  const restore = api.install();
  try {
    let received: unknown;
    api.script(REGISTER_PATH, (init) => {
      received = JSON.parse(String(init?.body));
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    });
    await clientWith().registerSealingKey({ kid: "k", pub: "p", sig: "s" });
    assertEquals(received, { kid: "k", pub: "p", sig: "s" });
  } finally {
    restore();
  }
});

test("a 404 from an older control plane is tolerated and registration is retried later", async () => {
  const api = createFakeInstanceApi();
  const restore = api.install();
  try {
    // Nothing is scripted for the path, so the fake answers 404.
    const client = clientWith();
    const signing = await crypto.subtle.generateKey({ name: "Ed25519" }, true, [
      "sign",
      "verify",
    ]) as CryptoKeyPair;
    const registered = await registerSealingKey({
      sealing: {
        key: () =>
          Promise.resolve({
            kid: "k".repeat(43),
            pub: "p".repeat(43),
            privateRaw: new Uint8Array(32),
          }),
      },
      privateJwk: await crypto.subtle.exportKey("jwk", signing.privateKey),
      register: (body) => client.registerSealingKey(body),
    });
    assertEquals(registered, false);
  } finally {
    restore();
  }
});

test("opening and registering log no plaintext or private key material", async () => {
  const api = createFakeInstanceApi();
  const restore = api.install();
  try {
    api.script(DECRYPT_PATH, answer({ sealed: [HPKE_VECTOR] }));
    api.script(
      REGISTER_PATH,
      () => new Response(JSON.stringify({ ok: false }), { status: 500 }),
    );
    const client = clientWith(sealingContext({ sealed: false, marks: 0 }));
    const privateText = btoa(
      String.fromCharCode(...HPKE_VECTOR_RECIPIENT_SEED),
    );
    const signing = await crypto.subtle.generateKey({ name: "Ed25519" }, true, [
      "sign",
      "verify",
    ]) as CryptoKeyPair;
    const output = await captureOutput(async () => {
      await client.decryptSecrets(["tpdaemon.v1.a"]);
      await registerSealingKey({
        sealing: {
          key: () =>
            Promise.resolve({
              kid: "k".repeat(43),
              pub: "p".repeat(43),
              privateRaw: HPKE_VECTOR_RECIPIENT_SEED,
            }),
        },
        privateJwk: await crypto.subtle.exportKey("jwk", signing.privateKey),
        register: (body) => client.registerSealingKey(body),
      });
    });
    assert(output.length > 0, "the failed registration should log a warning");
    assert(!output.includes(HPKE_VECTOR_PLAINTEXT));
    assert(!output.includes(privateText));
    assert(!output.includes(HPKE_VECTOR.ct));
  } finally {
    restore();
  }
});

const ISSUED_PATH = "/api/daemon/v1/tls/issued";
const KEY_PEM =
  "-----BEGIN PRIVATE KEY-----\nAAAA\n-----END PRIVATE KEY-----\n";

async function panelKey(): Promise<
  { seal: PanelSealKey; privateRaw: Uint8Array }
> {
  const pair = await crypto.subtle.generateKey({ name: "X25519" }, true, [
    "deriveBits",
  ]) as CryptoKeyPair;
  const pub = decodeBase64Url(
    (await crypto.subtle.exportKey("jwk", pair.publicKey)).x as string,
  );
  const privateRaw = decodeBase64Url(
    (await crypto.subtle.exportKey("jwk", pair.privateKey)).d as string,
  );
  return {
    seal: { kid: await sealingKid(pub), pub, panelFingerprint: "P".repeat(43) },
    privateRaw,
  };
}

function reportClient(
  options: { seal: PanelSealKey | null; trustSealed?: boolean },
): DaemonApiClient {
  return new DaemonApiClient({
    config: {
      kind: "url",
      baseUrl: "https://instance.test",
      wsBaseUrl: "wss://instance.test",
    },
    getToken: () => Promise.resolve("tok"),
    sleep: () => Promise.resolve(),
    panelSealKey: () => Promise.resolve(options.seal),
    sealing: sealingContext({ sealed: options.trustSealed === true, marks: 0 }),
  });
}

async function reportAndCapture(client: DaemonApiClient): Promise<unknown> {
  const api = createFakeInstanceApi();
  const restore = api.install();
  try {
    let sent: unknown;
    api.script(ISSUED_PATH, (init) => {
      sent = JSON.parse(String(init?.body));
      return new Response(JSON.stringify({ ok: true, stored: true }), {
        status: 200,
      });
    });
    await client.reportIssuedCertificate({
      hostname: "shop.example.com",
      certificatePem: "CERT",
      privateKeyPem: KEY_PEM,
    });
    return sent;
  } finally {
    restore();
  }
}

test("an issued key is sent as an envelope the panel can open, never as PEM", async () => {
  const { seal, privateRaw } = await panelKey();
  const sent = await reportAndCapture(reportClient({ seal })) as Record<
    string,
    unknown
  >;
  assertEquals("privateKeyPem" in sent, false);
  assert(isHpkeEnvelope(sent.privateKeyEnvelope));
  const opened = await openFromSender(
    privateRaw,
    seal.panelFingerprint,
    sent.privateKeyEnvelope as HpkeEnvelope,
  );
  assertEquals(new TextDecoder().decode(opened), KEY_PEM);
  assert(!JSON.stringify(sent).includes("PRIVATE KEY"));
});

test("without a panel sealing key the key goes as PEM, unless a sealed answer was ever received", async () => {
  const sent = await reportAndCapture(reportClient({ seal: null })) as Record<
    string,
    unknown
  >;
  assertEquals(sent.privateKeyPem, KEY_PEM);
  assertEquals("privateKeyEnvelope" in sent, false);

  const err = await assertRejects(
    () => reportAndCapture(reportClient({ seal: null, trustSealed: true })),
    DaemonApiError,
  );
  assertEquals(err.status, 503);
});
