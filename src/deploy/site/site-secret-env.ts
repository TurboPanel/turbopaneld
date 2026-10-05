/**
 * Secret runtime variables of a PHP site.
 *
 * The control plane never sends these as plaintext: each one rides
 * `sites[].webSecretEnv` as a `tpdaemon` envelope. They are decrypted here,
 * through the same `secrets/decrypt` seam every other secret uses (so the
 * plaintexts join the transcript redaction deny-set), and folded into
 * `webEnv`, which is what every engine renderer already reads.
 */

import type { EnvironmentDeploySite } from "../../contracts/commands-contracts.ts";
import { MAX_ENV_VALUE_LENGTH } from "../../contracts/config-values.ts";
import { logWarn } from "../../util/logger.ts";
import { forEachSequential } from "../../util/sequential.ts";
import type { DecryptSecretsFn } from "../materialize-tls.ts";
import { decryptEnvelopes } from "../secret-runtime.ts";

/**
 * One site with its secret variables decrypted into `webEnv`.
 *
 * A value that decrypts to nothing, or to more than the per-value cap, is
 * skipped and named (never printed), the same rule the control plane applied
 * to a plaintext `webEnv` before the secrets were sealed.
 */
async function decryptSiteSecretEnv(
  site: EnvironmentDeploySite,
  secrets: Readonly<Record<string, string>>,
  decryptSecrets: DecryptSecretsFn,
): Promise<EnvironmentDeploySite> {
  const names = Object.keys(secrets).sort((a, b) => a.localeCompare(b));
  const plaintexts = await decryptEnvelopes(
    decryptSecrets,
    names.map((name) => secrets[name] as string),
  );
  const env: Record<string, string> = { ...site.webEnv };
  for (const [index, name] of names.entries()) {
    const plaintext = plaintexts[index];
    if (plaintext === null || plaintext === undefined) {
      throw new Error(
        `Failed to decrypt secret variable ${name} of site ${site.composeServiceName}`,
      );
    }
    const value = plaintext.trim();
    if (value.length === 0 || value.length > MAX_ENV_VALUE_LENGTH) {
      logWarn(
        "site-secret-env",
        `site ${site.composeServiceName}: secret variable ${name} is empty or over ${MAX_ENV_VALUE_LENGTH} characters; skipped`,
      );
      continue;
    }
    env[name] = value;
  }
  const { webSecretEnv: _sealed, ...rest } = site;
  return Object.keys(env).length > 0 ? { ...rest, webEnv: env } : rest;
}

/**
 * Every site with `webSecretEnv` replaced by decrypted entries in `webEnv`.
 * Sites with no secret variables come back unchanged. One site at a time: the
 * daemon's decrypt endpoint is called in batches, never in parallel.
 */
export async function resolveSiteSecretEnv(
  sites: readonly EnvironmentDeploySite[],
  decryptSecrets: DecryptSecretsFn | undefined,
): Promise<EnvironmentDeploySite[]> {
  const out = [...sites];
  await forEachSequential(sites, async (site, index) => {
    const secrets = site.webSecretEnv;
    if (secrets === undefined || Object.keys(secrets).length === 0) return;
    if (!decryptSecrets) {
      throw new Error(
        `Site ${site.composeServiceName} has secret variables but secrets decrypt is unavailable`,
      );
    }
    out[index] = await decryptSiteSecretEnv(site, secrets, decryptSecrets);
  });
  return out;
}
