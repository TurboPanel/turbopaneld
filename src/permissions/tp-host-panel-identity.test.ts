import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { encodeBase64Url } from "@std/encoding/base64url";
import { type Host, refused, withHost } from "../testing/tp-host-fixture.ts";

/** Alias so Sonar sees real tests (see src/AGENTS.md). */
const test = Deno.test.bind(Deno);

const encoder = new TextEncoder();
const PIN_PATH = "opt/turbopanel/lib/panel-identity";
const ORIGIN_PATH = "opt/turbopanel/lib/update-origin";

type Panel = {
  kid: string;
  document: (options?: DocOptions) => Promise<string>;
};
type DocOptions = {
  keyset?: number;
  expires?: string;
  urls?: string[];
  next?: string;
  tamper?: boolean;
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

type KeyPair = {
  kid: string;
  pub: string;
  sign: (text: string) => Promise<string>;
};

async function makeKey(): Promise<KeyPair> {
  const pair = await crypto.subtle.generateKey("Ed25519", true, [
    "sign",
    "verify",
  ]) as CryptoKeyPair;
  const raw = new Uint8Array(
    await crypto.subtle.exportKey("raw", pair.publicKey),
  );
  return {
    kid: encodeBase64Url(
      new Uint8Array(await crypto.subtle.digest("SHA-256", raw)),
    ),
    pub: encodeBase64Url(raw),
    sign: async (text) =>
      encodeBase64Url(
        new Uint8Array(
          await crypto.subtle.sign(
            "Ed25519",
            pair.privateKey,
            encoder.encode(`tp-rotation\n${text}`),
          ),
        ),
      ),
  };
}

async function statement(
  kind: "rotation" | "revoke",
  keys: { current: KeyPair; next: KeyPair },
  overrides: {
    keyset?: number;
    signers?: Record<string, string>;
    signNext?: KeyPair;
  } = {},
  after = "z".repeat(43),
): Promise<string> {
  const signers = overrides.signers ??
    { [keys.current.kid]: keys.current.pub, [keys.next.kid]: keys.next.pub };
  const body = JSON.stringify({
    type: kind,
    keyset: overrides.keyset ?? 2,
    ...(kind === "revoke" ? { revoked: keys.current.kid } : {}),
    current: keys.next.kid,
    next: after,
    signers,
    iat: 1793000000,
  });
  const sigNext = await (overrides.signNext ?? keys.next).sign(body);
  if (kind === "revoke") return `${body.slice(0, -1)},"sigNext":"${sigNext}"}`;
  const sigCurrent = await keys.current.sign(body);
  return `${
    body.slice(0, -1)
  },"sigCurrent":"${sigCurrent}","sigNext":"${sigNext}"}`;
}

async function pinWithNext(
  host: Host,
  keys: { current: KeyPair; next: KeyPair },
) {
  await Deno.writeTextFile(
    host.path(PIN_PATH),
    `current=${keys.current.kid}\nnext=${keys.next.kid}\nkeyset=1\nurls=https://old.example\npinned_by=install\nupdated=x\n`,
  );
  await Deno.writeTextFile(
    host.path(ORIGIN_PATH),
    `host=https://old.example\npanel_key=${keys.current.kid}\n`,
  );
}

test("a valid rotation moves the pin and the update origin to the next key", async () => {
  await withHost(async (host) => {
    const keys = { current: await makeKey(), next: await makeKey() };
    await pinWithNext(host, keys);
    const after = "z".repeat(43);
    const result = await host.run(
      ["panel-identity-write", "statement"],
      await statement("rotation", keys, {}, after),
    );
    assertEquals(result.code, 0, result.stderr);
    const pin = await Deno.readTextFile(host.path(PIN_PATH));
    assertStringIncludes(pin, `current=${keys.next.kid}\n`);
    assertStringIncludes(pin, `next=${after}\n`);
    assertStringIncludes(pin, "keyset=2\n");
    assertStringIncludes(
      await Deno.readTextFile(host.path(ORIGIN_PATH)),
      `panel_key=${keys.next.kid}\n`,
    );
  });
});

test("a valid revoke needs only the next key's signature", async () => {
  await withHost(async (host) => {
    const keys = { current: await makeKey(), next: await makeKey() };
    await pinWithNext(host, keys);
    const result = await host.run(
      ["panel-identity-write", "statement"],
      await statement("revoke", keys, {
        signers: { [keys.next.kid]: keys.next.pub },
      }),
    );
    assertEquals(result.code, 0, result.stderr);
    assertStringIncludes(
      await Deno.readTextFile(host.path(PIN_PATH)),
      `current=${keys.next.kid}\n`,
    );
  });
});

test("a forged rotation, a mismatched signer key and a stale key set are refused", async () => {
  await withHost(async (host) => {
    const keys = { current: await makeKey(), next: await makeKey() };
    const attacker = await makeKey();
    await pinWithNext(host, keys);
    const before = await Deno.readTextFile(host.path(PIN_PATH));

    // Signed by the current key only: the next signature is the attacker's.
    const forged = await statement("rotation", keys, { signNext: attacker });
    // A signer pub that does not hash to the pinned fingerprint.
    const wrongPub = await statement("rotation", keys, {
      signers: {
        [keys.current.kid]: keys.current.pub,
        [keys.next.kid]: attacker.pub,
      },
    });
    const stale = await statement("rotation", keys, { keyset: 1 });
    for (const input of [forged, wrongPub, stale, "{}"]) {
      const err = await refused(
        host,
        ["panel-identity-write", "statement"],
        input,
      );
      assertStringIncludes(err, "panel-identity-write");
    }
    assertEquals(await Deno.readTextFile(host.path(PIN_PATH)), before);
  });
});
