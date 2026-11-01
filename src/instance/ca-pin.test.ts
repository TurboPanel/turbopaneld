import { assertEquals, assertStringIncludes } from "@std/assert";
import { ACME_LEAF_CERT_BY_TAG } from "../testing/acme-leaf-fixtures.ts";
import {
  CA_PIN_ENV,
  caPinMismatch,
  CaPinMismatchError,
  parseCaPin,
  pemFingerprints,
  reconcileCaPinPath,
  repinAfterReconcile,
} from "./ca-pin.ts";
import { classifyConnectFailure } from "./connect-failure.ts";

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno);

const PERMS = { read: true, write: true, env: true } as const;

const [CURRENT, NEXT, ROGUE] = Object.values(ACME_LEAF_CERT_BY_TAG).map((
  pem,
) => `${pem}\n`);

async function fp(pem: string | undefined): Promise<string> {
  const [first] = await pemFingerprints(pem ?? "");
  return first ?? "";
}

async function withCaFiles(
  files: { ca?: string; uploaded?: string },
  fn: (env: Record<string, string>, dir: string) => Promise<void>,
): Promise<void> {
  const dir = await Deno.makeTempDir({ prefix: "tp-ca-pin-" });
  try {
    const env: Record<string, string> = {
      TURBOPANEL_INSTANCE_CA: `${dir}/instance-ca.pem`,
      TURBOPANEL_INSTANCE_UPLOADED_TRUST: `${dir}/instance-uploaded-trust.pem`,
      TURBOPANEL_DAEMON_STATE_DIR: `${dir}/state`,
    };
    if (files.ca) {
      await Deno.writeTextFile(env.TURBOPANEL_INSTANCE_CA, files.ca);
    }
    if (files.uploaded) {
      await Deno.writeTextFile(
        env.TURBOPANEL_INSTANCE_UPLOADED_TRUST,
        files.uploaded,
      );
    }
    await fn(env, dir);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
}

test("parseCaPin accepts openssl's colon form and drops empty entries", () => {
  assertEquals(parseCaPin(undefined), []);
  assertEquals(parseCaPin("AB:CD, ef ,,"), ["abcd", "ef"]);
});

test({
  name: "every certificate in every trust file must be pinned",
  permissions: PERMS,
  fn: async () => {
    const current = await fp(CURRENT);
    const next = await fp(NEXT);
    const issuer = await fp(ROGUE);
    await withCaFiles(
      { ca: `${CURRENT}${NEXT}`, uploaded: ROGUE },
      async (env) => {
        assertEquals(await caPinMismatch(env), null);
        assertEquals(
          await caPinMismatch({
            ...env,
            [CA_PIN_ENV]: `${current},${next},${issuer}`,
          }),
          null,
        );
        const missingRotation = await caPinMismatch({
          ...env,
          [CA_PIN_ENV]: `${current},${issuer}`,
        });
        assertStringIncludes(missingRotation ?? "", next);
        assertStringIncludes(missingRotation ?? "", "instance-ca.pem");
        const missingIssuer = await caPinMismatch({
          ...env,
          [CA_PIN_ENV]: `${current},${next}`,
        });
        assertStringIncludes(missingIssuer ?? "", "instance-uploaded-trust");
      },
    );
  },
});

test("a pin mismatch parks the connection as a trust failure", () => {
  const classified = classifyConnectFailure(
    new CaPinMismatchError("instance-ca.pem holds CA certificate ab"),
  );
  assertEquals(classified.kind, "tls-trust");
  assertStringIncludes(classified.reason, "instance-ca.pem");
});

test({
  name:
    "an authenticated reconcile records the new bundle plus the issuer, and the check accepts it",
  permissions: PERMS,
  fn: async () => {
    await withCaFiles({ ca: CURRENT, uploaded: ROGUE }, async (env) => {
      const pinned = {
        ...env,
        [CA_PIN_ENV]: `${await fp(CURRENT)},${await fp(ROGUE)}`,
      };
      const rotated = `${NEXT}${CURRENT}`;
      await Deno.writeTextFile(env.TURBOPANEL_INSTANCE_CA, rotated);
      assertStringIncludes(
        (await caPinMismatch(pinned)) ?? "",
        await fp(NEXT),
      );

      await Deno.mkdir(`${env.TURBOPANEL_DAEMON_STATE_DIR}/tls`, {
        recursive: true,
      });
      const modes: number[] = [];
      const next = await repinAfterReconcile(rotated, {
        env: pinned,
        writeFile: async (path, text, mode) => {
          modes.push(mode);
          await Deno.writeTextFile(path, text);
        },
      });
      const expected = [await fp(NEXT), await fp(CURRENT), await fp(ROGUE)];
      assertEquals(next, expected);
      assertEquals(modes, [0o640]);
      assertEquals(
        await Deno.readTextFile(reconcileCaPinPath(pinned)),
        `${expected.join(",")}\n`,
      );
      assertEquals(await caPinMismatch(pinned), null);
    });
  },
});

test({
  name: "a host without a pinned list never gets one from a reconcile",
  permissions: PERMS,
  fn: async () => {
    let wrote = false;
    const result = await repinAfterReconcile(NEXT ?? "", {
      env: {},
      writeFile: () => {
        wrote = true;
        return Promise.resolve();
      },
    });
    assertEquals(result, null);
    assertEquals(wrote, false);
  },
});

test({
  name:
    "a trust file with an undecodable certificate is a mismatch, not skipped",
  permissions: PERMS,
  fn: async () => {
    const broken =
      "-----BEGIN CERTIFICATE-----\n!!not base64!!\n-----END CERTIFICATE-----\n";
    await withCaFiles({ ca: `${CURRENT}${broken}` }, async (env) => {
      const mismatch = await caPinMismatch({
        ...env,
        [CA_PIN_ENV]: await fp(CURRENT),
      });
      assertStringIncludes(mismatch ?? "", "cannot be read");
    });
  },
});
