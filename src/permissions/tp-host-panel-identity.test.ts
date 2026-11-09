import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { decodeBase64Url, encodeBase64Url } from "@std/encoding/base64url";
import { type Host, refused, withHost } from "../testing/tp-host-fixture.ts";
import { keysetVectors as vectors } from "../testing/keyset-vectors.ts";

/** Alias so Sonar sees real tests (see src/AGENTS.md). */
const test = Deno.test.bind(Deno);

const encoder = new TextEncoder();
const PIN_PATH = "opt/turbopanel/lib/panel-identity";
const ORIGIN_PATH = "opt/turbopanel/lib/update-origin";

type Panel = {
  kid: string;
  pub: string;
  document: (options?: DocOptions) => Promise<string>;
};
type DocOptions = {
  keyset?: number;
  expires?: string;
  urls?: string[];
  next?: string;
  tamper?: boolean;
  rotation?: unknown;
};

async function makePanel(): Promise<Panel> {
  const pair = await crypto.subtle.generateKey("Ed25519", true, [
    "sign",
    "verify",
  ]) as CryptoKeyPair;
  const raw = new Uint8Array(
    await crypto.subtle.exportKey("raw", pair.publicKey),
  );
  const kid = encodeBase64Url(
    new Uint8Array(await crypto.subtle.digest("SHA-256", raw)),
  );
  return {
    kid,
    pub: encodeBase64Url(raw),
    document: async (options = {}) => {
      const keys: unknown[] = [
        { kid, alg: "Ed25519", pub: encodeBase64Url(raw), role: "current" },
      ];
      if (options.next) {
        keys.push({ kid: options.next, alg: "Ed25519", pub: "", role: "next" });
      }
      const body = JSON.stringify({
        v: 1,
        keys,
        seal: { kid: "s".repeat(43), alg: "X25519", pub: "AAAA" },
        keyset: options.keyset ?? 2,
        ...(options.rotation === undefined
          ? {}
          : { rotation: options.rotation }),
        urls: options.urls ?? ["https://panel.example.test"],
        issued: "2026-11-01T00:00:00.000Z",
        expires: options.expires ?? "2999-01-01T00:00:00.000Z",
      });
      const signature = encodeBase64Url(
        new Uint8Array(
          await crypto.subtle.sign(
            "Ed25519",
            pair.privateKey,
            encoder.encode(
              `tp-http\n/api/daemon/v1/instance/identity\n${body}`,
            ),
          ),
        ),
      );
      const signed = options.tamper ? body.replace("panel.", "evil.") : body;
      return `${kid}:${signature}\n${signed}`;
    },
  };
}

async function writePin(
  host: Host,
  current: string,
  extra = "",
): Promise<void> {
  await Deno.writeTextFile(
    host.path(PIN_PATH),
    `current=${current}\nnext=\nkeyset=1\nurls=https://old.example\npinned_by=install\nupdated=x\n${extra}`,
  );
}

test("panel-identity-write follows the panel's signed document for urls, next and keyset", async () => {
  await withHost(async (host) => {
    const panel = await makePanel();
    await writePin(host, panel.kid);
    const next = "n".repeat(43);
    const result = await host.run(
      ["panel-identity-write"],
      await panel.document({
        next,
        keyset: 3,
        urls: ["https://panel.example.test", "https://alt.example.test:8443"],
      }),
    );
    assertEquals(result.code, 0, result.stderr);
    assertStringIncludes(result.stdout, "[root:tp]");
    const text = await Deno.readTextFile(host.path(PIN_PATH));
    assertStringIncludes(text, `current=${panel.kid}\n`);
    assertStringIncludes(text, `next=${next}\n`);
    assertStringIncludes(text, "keyset=3\n");
    assertStringIncludes(
      text,
      "urls=https://panel.example.test,https://alt.example.test:8443\n",
    );
    assertStringIncludes(text, "pinned_by=install\n");
  });
});

test("panel-identity-write refuses what the pin does not allow", async () => {
  await withHost(async (host) => {
    const panel = await makePanel();
    const stranger = await makePanel();

    // No pin yet: the first pin is the installer's job.
    await refused(host, ["panel-identity-write"], await panel.document());

    await writePin(host, panel.kid);
    const before = await Deno.readTextFile(host.path(PIN_PATH));
    const cases: Array<[string, string, string[]?]> = [
      ["another key", await stranger.document()],
      [
        "a lower key set",
        await (async () => {
          await Deno.writeTextFile(
            host.path(PIN_PATH),
            before.replace("keyset=1", "keyset=5"),
          );
          return panel.document({ keyset: 4 });
        })(),
      ],
      ["a tampered body", await panel.document({ tamper: true })],
      [
        "an expired document",
        await panel.document({ expires: "2000-01-01T00:00:00.000Z" }),
      ],
      [
        "a url with a path",
        await panel.document({ urls: ["https://p.example/x"] }),
      ],
      [
        "a url with template or shell characters",
        await panel.document({ urls: ["https://p{{x}}.example"] }),
      ],
      [
        "a url with a tab",
        await panel.document({ urls: ["https://p\t.example"] }),
      ],
      ["no header", "{}"],
    ];
    for (const [label, input] of cases) {
      const err = await refused(host, ["panel-identity-write"], input);
      assert(err.includes("panel-identity-write"), `${label}: ${err}`);
    }
    await refused(
      host,
      ["panel-identity-write", "extra"],
      await panel.document(),
    );
  });
});

test("panel-identity-write rewrites the update origin's addresses with the pin's", async () => {
  await withHost(async (host) => {
    const panel = await makePanel();
    await writePin(host, panel.kid);
    await Deno.writeTextFile(
      host.path(ORIGIN_PATH),
      `host=https://old.example\nhosts=https://old.example\npanel_key=${panel.kid}\ndl_base=\n`,
    );
    const urls = [
      "https://panel.example.test",
      "https://alt.example.test:8443",
    ];
    const result = await host.run(
      ["panel-identity-write"],
      await panel.document({ keyset: 1, urls }),
    );
    assertEquals(result.code, 0, result.stderr);
    const origin = await Deno.readTextFile(host.path(ORIGIN_PATH));
    assertEquals(
      origin.split("\n").filter((line) => line.startsWith("hosts=")),
      [`hosts=${urls.join(",")}`],
    );
    // The installer's host, the key and the rest stay as they were.
    assertStringIncludes(origin, "host=https://old.example\n");
    assertStringIncludes(origin, `panel_key=${panel.kid}\n`);
    assertStringIncludes(origin, "dl_base=\n");
    assertStringIncludes(
      await Deno.readTextFile(host.path(PIN_PATH)),
      `urls=${urls.join(",")}\n`,
    );
  });
});

test("panel-identity-write refuses an empty address list and leaves both files alone", async () => {
  await withHost(async (host) => {
    const panel = await makePanel();
    await writePin(host, panel.kid);
    await Deno.writeTextFile(
      host.path(ORIGIN_PATH),
      "host=https://old.example\nhosts=https://old.example\n",
    );
    const before = [
      await Deno.readTextFile(host.path(PIN_PATH)),
      await Deno.readTextFile(host.path(ORIGIN_PATH)),
    ];
    const err = await refused(
      host,
      ["panel-identity-write"],
      await panel.document({ urls: [] }),
    );
    assertStringIncludes(err, "panel-identity-write");
    assertEquals([
      await Deno.readTextFile(host.path(PIN_PATH)),
      await Deno.readTextFile(host.path(ORIGIN_PATH)),
    ], before);
  });
});

test("panel-identity-write refuses a host installed without a panel key", async () => {
  await withHost(async (host) => {
    const panel = await makePanel();
    await writePin(host, "");
    const err = await refused(
      host,
      ["panel-identity-write"],
      await panel.document(),
    );
    assertStringIncludes(err, "without a panel key");
  });
});

test("no generic verb can touch the pin file or the update origin", async () => {
  await withHost(async (host) => {
    const panel = await makePanel();
    await writePin(host, panel.kid);
    await Deno.writeTextFile(
      host.path(ORIGIN_PATH),
      "host=https://p.example\n",
    );
    const before = [
      await Deno.readTextFile(host.path(PIN_PATH)),
      await Deno.readTextFile(host.path(ORIGIN_PATH)),
    ];
    for (const rel of [PIN_PATH, ORIGIN_PATH]) {
      const target = host.path(rel);
      const attempts: string[][] = [
        ["install", "-m", "0644", host.path("tmp/staged"), target],
        ["cp", host.path("tmp/staged"), target],
        ["mv", host.path("tmp/staged"), target],
        ["rm", target],
        ["ln", "-s", host.path("outside/secret"), target],
        ["mkdir", target],
        ["tee", target],
        ["chmod", "0666", target],
        ["chown", "tp:tp", target],
      ];
      for (const args of attempts) {
        await refused(host, args, "x\n");
      }
    }
    assertEquals([
      await Deno.readTextFile(host.path(PIN_PATH)),
      await Deno.readTextFile(host.path(ORIGIN_PATH)),
    ], before);
  });
});

type Passkey = { id: string; alg: string; pub: string };
type Pin = {
  current: string;
  keyset: number;
  rpId: string;
  passkeys: Passkey[];
};

function passkeysLine(passkeys: Passkey[]): string {
  return passkeys.map((p) =>
    `${p.id}.${p.alg === "ES256" ? "es256" : "eddsa"}.${p.pub}`
  ).join(",");
}

async function writeRotationPin(host: Host, pin: Pin): Promise<void> {
  await Deno.writeTextFile(
    host.path(PIN_PATH),
    `current=${pin.current}\nnext=\nkeyset=${pin.keyset}\nurls=https://old.example\npinned_by=install\nupdated=x\nrp_id=${pin.rpId}\npasskeys=${
      passkeysLine(pin.passkeys)
    }\n`,
  );
  await Deno.writeTextFile(
    host.path(ORIGIN_PATH),
    `host=https://old.example\npanel_key=${pin.current}\n`,
  );
}

function applyStatement(
  host: Host,
  envelope: unknown,
  env?: Record<string, string>,
) {
  return host.run(
    ["panel-identity-write", "statement"],
    JSON.stringify(envelope),
    env,
  );
}

/**
 * What tp-host prints for each forged statement in the shared vectors (the
 * file is shared with the control plane, so the reasons live here). A vector
 * this table does not know fails the test: a new one needs its reason.
 */
const REFUSAL_REASONS: Record<string, string> = {
  "no approvals": "no pinned passkey approved",
  "approval by a passkey that is not pinned": "an approval does not verify",
  // A 64-byte signature under an id pinned as ES256 is not DER at all.
  "approval under a pinned id signed by another key":
    "signature is not strict DER",
  "assertion replayed onto another statement": "an approval does not verify",
  "applied statement replayed": "prev is not the pinned key",
  "keyset not above the pinned one": "keyset is not above the pinned one",
  "prev is not the pinned key": "prev is not the pinned key",
  "rpIdHash for another host": "an approval does not verify",
  "origin outside the rp id": "an approval does not verify",
  "user presence flag missing": "an approval does not verify",
  "user verification flag missing": "an approval does not verify",
  "type webauthn.create": "an approval does not verify",
  "cross-origin assertion": "an approval does not verify",
  "one flipped signature byte": "an approval signature is invalid",
  "removal approved only by the removed passkey":
    "a removal needs a passkey that stays",
  "addition without proof of possession":
    "an added passkey must prove possession",
  "passkeys kind that changes the key":
    "kind does not match whether the key changes",
};

// Fixed iat values in the shared vectors are in the past here, so the
// "iat in the future" vector is checked with a fresh statement below.
const CLOCK_VECTORS = new Set(["iat too far in the future"]);

test("every forged statement in the shared vectors is refused and changes nothing", async () => {
  await withHost(async (host) => {
    for (const vector of vectors.refused) {
      if (CLOCK_VECTORS.has(vector.name)) continue;
      await writeRotationPin(host, vector.pin);
      const before = await Deno.readTextFile(host.path(PIN_PATH));
      const result = await applyStatement(host, vector.envelope);
      assert(result.code !== 0, vector.name);
      assertStringIncludes(result.stderr, "panel-identity-write", vector.name);
      const reason = REFUSAL_REASONS[vector.name];
      assert(reason, `no refusal reason listed for "${vector.name}"`);
      assertStringIncludes(result.stderr, reason, vector.name);
      assertEquals(
        await Deno.readTextFile(host.path(PIN_PATH)),
        before,
        vector.name,
      );
    }
  });
});

test("an offline server applies the whole chain in order, then refuses a replay", async () => {
  await withHost(async (host) => {
    await writeRotationPin(host, vectors.pin);
    for (const envelope of vectors.chain) {
      const result = await applyStatement(host, envelope);
      assertEquals(result.code, 0, result.stderr);
    }
    const pin = await Deno.readTextFile(host.path(PIN_PATH));
    const after = vectors.pinAfterChain;
    assertStringIncludes(pin, `current=${after.current}\n`);
    assertStringIncludes(pin, `keyset=${after.keyset}\n`);
    assertStringIncludes(pin, `rp_id=${after.rpId}\n`);
    assertStringIncludes(pin, `passkeys=${passkeysLine(after.passkeys)}\n`);
    assertStringIncludes(pin, "next=\n");
    assertStringIncludes(pin, "urls=https://old.example\n");
    assertStringIncludes(
      await Deno.readTextFile(host.path(ORIGIN_PATH)),
      `panel_key=${after.current}\n`,
    );
    const replay = await applyStatement(host, vectors.chain[0]);
    assert(replay.code !== 0);
    assertEquals(await Deno.readTextFile(host.path(PIN_PATH)), pin);
  });
});

test("a statement out of order, oversized or without pinned passkeys is refused", async () => {
  await withHost(async (host) => {
    await writeRotationPin(host, vectors.pin);
    // The second statement names a key the pin does not hold yet.
    assert((await applyStatement(host, vectors.chain[1])).code !== 0);
    const big = { statement: "A".repeat(17000), approvals: [] };
    assertStringIncludes(
      await refused(
        host,
        ["panel-identity-write", "statement"],
        JSON.stringify(big),
      ),
      "too large",
    );
    await writePin(host, vectors.pin.current);
    assertStringIncludes(
      await refused(
        host,
        ["panel-identity-write", "statement"],
        JSON.stringify(vectors.chain[0]),
      ),
      "refusing the statement",
    );
  });
});

/** A fresh EdDSA rotation passkey and a statement it approves (for clock-relative checks). */
async function freshRotation(iat: number) {
  const pair = await crypto.subtle.generateKey("Ed25519", true, [
    "sign",
    "verify",
  ]) as CryptoKeyPair;
  const pub = encodeBase64Url(
    new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey)),
  );
  const id = "p".repeat(43);
  const panel = await makePanel();
  const next = await makePanel();
  const rpId = "cp.example.test";
  const passkeys = [{ id, alg: "EdDSA", pub }];
  const statement = JSON.stringify({
    type: "tp-keyset",
    v: 1,
    keyset: 3,
    prev: panel.kid,
    kind: "rotate",
    rpId,
    current: { kid: next.kid, pub: next.pub },
    passkeys,
    iat,
  });
  const sha = async (bytes: Uint8Array) =>
    new Uint8Array(
      await crypto.subtle.digest("SHA-256", bytes as BufferSource),
    );
  const challenge = encodeBase64Url(await sha(encoder.encode(statement)));
  const authData = new Uint8Array(37);
  authData.set(await sha(encoder.encode(rpId)), 0);
  authData[32] = 0x05;
  const clientData = encoder.encode(
    JSON.stringify({
      type: "webauthn.get",
      challenge,
      origin: `https://${rpId}`,
    }),
  );
  const signed = new Uint8Array([...authData, ...(await sha(clientData))]);
  const signature = new Uint8Array(
    await crypto.subtle.sign("Ed25519", pair.privateKey, signed),
  );
  return {
    pin: { current: panel.kid, keyset: 2, rpId, passkeys },
    envelope: {
      statement: encodeBase64Url(encoder.encode(statement)),
      approvals: [{
        id,
        authenticatorData: encodeBase64Url(authData),
        clientDataJSON: encodeBase64Url(clientData),
        signature: encodeBase64Url(signature),
      }],
    },
    next: next.kid,
  };
}

test("a statement more than five minutes ahead is refused; one from now applies", async () => {
  await withHost(async (host) => {
    const now = Math.floor(Date.now() / 1000);
    const ahead = await freshRotation(now + 3600);
    await writeRotationPin(host, ahead.pin);
    assertStringIncludes(
      await refused(
        host,
        ["panel-identity-write", "statement"],
        JSON.stringify(ahead.envelope),
      ),
      "refusing the statement",
    );
    const fresh = await freshRotation(now);
    await writeRotationPin(host, fresh.pin);
    const result = await applyStatement(host, fresh.envelope);
    assertEquals(result.code, 0, result.stderr);
    assertStringIncludes(
      await Deno.readTextFile(host.path(PIN_PATH)),
      `current=${fresh.next}\n`,
    );
  });
});

test("a document fills the rotation passkeys once, then only statements move the key set", async () => {
  await withHost(async (host) => {
    const panel = await makePanel();
    await writePin(host, panel.kid);
    const rotation = {
      rpId: vectors.pin.rpId,
      passkeys: [...vectors.pin.passkeys].reverse(),
    };
    const filled = await host.run(
      ["panel-identity-write"],
      await panel.document({ keyset: 4, rotation }),
    );
    assertEquals(filled.code, 0, filled.stderr);
    const pin = await Deno.readTextFile(host.path(PIN_PATH));
    assertStringIncludes(pin, "keyset=4\n");
    assertStringIncludes(pin, `rp_id=${vectors.pin.rpId}\n`);
    assertStringIncludes(
      pin,
      `passkeys=${passkeysLine(vectors.pin.passkeys)}\n`,
    );
    // Another set in a later document is ignored; the pinned one stays.
    const other = {
      rpId: "evil.example.test",
      passkeys: [rotation.passkeys[0]],
    };
    const again = await host.run(
      ["panel-identity-write"],
      await panel.document({
        keyset: 4,
        rotation: other,
        urls: ["https://new.example.test"],
      }),
    );
    assertEquals(again.code, 0, again.stderr);
    const kept = await Deno.readTextFile(host.path(PIN_PATH));
    assertStringIncludes(kept, `rp_id=${vectors.pin.rpId}\n`);
    assertStringIncludes(kept, "urls=https://new.example.test\n");
    // A higher key set never comes from a document once passkeys are pinned.
    assertStringIncludes(
      await refused(
        host,
        ["panel-identity-write"],
        await panel.document({ keyset: 5, rotation }),
      ),
      "refusing the identity document",
    );
    assertEquals(await Deno.readTextFile(host.path(PIN_PATH)), kept);
  });
});

test("a malformed rotation block is refused before anything is pinned", async () => {
  await withHost(async (host) => {
    const panel = await makePanel();
    await writePin(host, panel.kid);
    const before = await Deno.readTextFile(host.path(PIN_PATH));
    const good = vectors.pin.passkeys[0]!;
    for (
      const rotation of [
        { rpId: "CP.example", passkeys: [good] },
        { rpId: "cp.example.test", passkeys: [] },
        { rpId: "cp.example.test", passkeys: [{ ...good, alg: "RS256" }] },
        { rpId: "cp.example.test", passkeys: [{ ...good, pub: "AA" }] },
        { rpId: "cp.example.test", passkeys: [good, good] },
      ]
    ) {
      await refused(
        host,
        ["panel-identity-write"],
        await panel.document({ rotation }),
      );
    }
    assertEquals(await Deno.readTextFile(host.path(PIN_PATH)), before);
  });
});

/** The first chain statement with its exact text edited (the approvals no longer match it). */
function editedStatement(edit: (text: string) => string) {
  const first = vectors.chain[0]!;
  const text = new TextDecoder().decode(decodeBase64Url(first.statement));
  const edited = edit(text);
  assert(edited !== text, "the edit changed nothing");
  return {
    statement: encodeBase64Url(encoder.encode(edited)),
    approvals: first.approvals,
  };
}

test("a statement whose version or numbers are not plain whole numbers is malformed", async () => {
  await withHost(async (host) => {
    await writeRotationPin(host, vectors.pin);
    const before = await Deno.readTextFile(host.path(PIN_PATH));
    const tooBig = "9007199254740992"; // 2^53
    const edits: Array<[string, (text: string) => string]> = [
      ["v true", (t) => t.replace('"v":1,', '"v":true,')],
      ["v 1.0", (t) => t.replace('"v":1,', '"v":1.0,')],
      ["v 2", (t) => t.replace('"v":1,', '"v":2,')],
      ["keyset true", (t) => t.replace(/"keyset":\d+/, '"keyset":true')],
      ["keyset 2.0", (t) => t.replace(/"keyset":\d+/, '"keyset":2.0')],
      [
        "keyset 2^53",
        (t) => t.replace(/"keyset":\d+/, `"keyset":${tooBig}`),
      ],
      ["iat true", (t) => t.replace(/"iat":\d+/, '"iat":true')],
      ["iat 2^53", (t) => t.replace(/"iat":\d+/, `"iat":${tooBig}`)],
    ];
    for (const [name, edit] of edits) {
      const result = await applyStatement(host, editedStatement(edit));
      assert(result.code !== 0, name);
      // Refused for its shape, before any approval is looked at.
      assertStringIncludes(result.stderr, "statement is malformed", name);
      assertEquals(await Deno.readTextFile(host.path(PIN_PATH)), before, name);
    }
    // The largest whole number still reads as one: refused later, for its date.
    const largest = await applyStatement(
      host,
      editedStatement((t) => t.replace(/"iat":\d+/, '"iat":9007199254740991')),
    );
    assertStringIncludes(largest.stderr, "iat is in the future");
  });
});

test("both pin writers ignore Python modules on PYTHONPATH and in the caller's directory", async () => {
  await withHost(async (host) => {
    // sudo keeps the caller's directory and root runs python3 there: a module
    // planted next to it or on PYTHONPATH must never be imported.
    const planted = host.path("outside/planted");
    const marker = host.path("outside/imported");
    await Deno.mkdir(planted, { recursive: true });
    for (const name of ["base64", "json", "re", "hashlib", "sitecustomize"]) {
      await Deno.writeTextFile(
        `${planted}/${name}.py`,
        `open(${JSON.stringify(marker)}, "w").write("${name}")\n` +
          'raise SystemExit("planted module imported")\n',
      );
    }
    const env = { PYTHONPATH: planted };

    await writeRotationPin(host, vectors.pin);
    const statement = await host.run(
      ["panel-identity-write", "statement"],
      JSON.stringify(vectors.chain[0]),
      env,
      planted,
    );
    assertEquals(statement.code, 0, statement.stderr);

    const panel = await makePanel();
    await writePin(host, panel.kid);
    const document = await host.run(
      ["panel-identity-write"],
      await panel.document(),
      env,
      planted,
    );
    assertEquals(document.code, 0, document.stderr);

    const imported = await Deno.stat(marker).then(() => true, () => false);
    assertEquals(imported, false);
  });
});
