/**
 * Decrypt-seam capture: every plaintext the daemon decrypts has to land in the
 * process-wide deny-set used by execution-log transcripts.
 */

import { assert, assertEquals } from "@std/assert";
import { captureDecryptedSecrets } from "./capture.ts";
import type { CommandOutputSink } from "./contracts.ts";
import {
  resetSharedSecretRedactorForTests,
  sharedSecretRedactor,
} from "./redactor.ts";

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno);

function recordingSink(): CommandOutputSink & { secrets: string[] } {
  const secrets: string[] = [];
  return {
    secrets,
    addSecrets(values: readonly (string | null | undefined)[]) {
      for (const value of values) {
        if (typeof value === "string") secrets.push(value);
      }
    },
  } as unknown as CommandOutputSink & { secrets: string[] };
}

test("a decrypt still feeds the shared deny-set", async () => {
  resetSharedSecretRedactorForTests();
  try {
    // The value has to be remembered on the process-wide deny-set so later
    // execution-log transcripts redact it, not only this command's sink.
    const sink = recordingSink();
    const decrypt = captureDecryptedSecrets(
      (_ciphertexts: string[]) =>
        Promise.resolve(["p@ssw0rd-from-envelope", null]),
      sink,
    );
    assert(decrypt);
    await decrypt(["sealed-1", "sealed-2"]);

    assertEquals(sink.secrets, ["p@ssw0rd-from-envelope"]);
    assertEquals(
      sharedSecretRedactor().redact("DB_PASSWORD=p@ssw0rd-from-envelope"),
      "DB_PASSWORD=***",
    );
  } finally {
    resetSharedSecretRedactorForTests();
  }
});

test("captureDecryptedSecrets stays undefined when there is nothing to wrap", () => {
  assertEquals(captureDecryptedSecrets(undefined, recordingSink()), undefined);
});
