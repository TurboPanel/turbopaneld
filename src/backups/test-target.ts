/**
 * `server.backups.test-target`: write, read back and delete a small object in
 * the target's bucket, so a person learns at setup time that the endpoint, the
 * keys and the bucket work. Each step reports ok or a plain reason; no
 * response body is ever passed on.
 */

import type {
  BackupTargetTestPayload,
  BackupTargetTestResult,
  BackupTargetTestStep,
} from "../contracts/commands-contracts.ts";
import { type DecryptSecretsFn, openTargetClient } from "./copy-target.ts";
import { type S3Client, S3Error } from "./s3/client.ts";

export type TestTargetDeps = {
  decryptSecrets?: DecryptSecretsFn;
  openClient?: (target: BackupTargetTestPayload["target"]) => Promise<S3Client>;
};

function reason(err: unknown): string {
  if (err instanceof S3Error) return err.message;
  return "the check failed";
}

export async function handleBackupTargetTest(
  payload: BackupTargetTestPayload,
  _daemonReceivedAt: string,
  deps: TestTargetDeps = {},
): Promise<BackupTargetTestResult> {
  const steps: BackupTargetTestStep[] = [];
  let client: S3Client;
  try {
    client = deps.openClient
      ? await deps.openClient(payload.target)
      : await openTargetClient(payload.target, deps.decryptSecrets);
  } catch (err) {
    return { ok: false, steps, error: reason(err) };
  }
  const key = client.fullKey(
    `.turbopanel-test/${crypto.randomUUID().replaceAll("-", "")}`,
  );
  const sent = new TextEncoder().encode(
    `turbopanel test ${crypto.randomUUID()}`,
  );

  const write = await attempt(
    "write",
    steps,
    () => client.putObject(key, sent),
  );
  if (!write) return finish(steps);
  await attempt("read", steps, async () => {
    const got = await client.getObjectBytes(key);
    if (
      got.byteLength !== sent.byteLength || got.some((b, i) => b !== sent[i])
    ) {
      throw new S3Error(
        "the object read back is not what was written",
        200,
        "Mismatch",
        false,
      );
    }
  });
  // Clean up even when the read failed, so a test never leaves objects behind.
  await attempt("delete", steps, () => client.deleteObject(key));
  return finish(steps);
}

async function attempt(
  step: BackupTargetTestStep["step"],
  steps: BackupTargetTestStep[],
  run: () => Promise<void>,
): Promise<boolean> {
  try {
    await run();
    steps.push({ step, ok: true });
    return true;
  } catch (err) {
    steps.push({ step, ok: false, error: reason(err) });
    return false;
  }
}

function finish(steps: BackupTargetTestStep[]): BackupTargetTestResult {
  const failed = steps.find((s) => !s.ok);
  return failed
    ? { ok: false, steps, error: `${failed.step} failed: ${failed.error}` }
    : { ok: true, steps };
}
