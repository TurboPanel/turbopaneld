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
 * Names a site variable may never take: PHP-FPM reads `PHP_VALUE` and
 * `PHP_ADMIN_VALUE` from the FastCGI request as ini overrides, and every engine
 * hands a site variable to PHP as a FastCGI parameter, so a variable of either
 * name would let a project member change PHP's own settings (the limits and
 * `disable_functions` the platform pins). Compared without regard to case.
 * The control plane drops them too (`SITE_RESERVED_VARIABLE_NAMES`).
 */
const RESERVED_SITE_VARIABLE_NAMES: ReadonlySet<string> = new Set([
  "PHP_VALUE",
  "PHP_ADMIN_VALUE",
]);

/** True when `name` is one of {@link RESERVED_SITE_VARIABLE_NAMES}. */
function isReservedSiteVariableName(name: string): boolean {
  return RESERVED_SITE_VARIABLE_NAMES.has(name.toUpperCase());
}

/** `record` without its reserved names; `undefined` when nothing is left. */
function withoutReservedNames(
  site: EnvironmentDeploySite,
  field: "webEnv" | "webSecretEnv",
): Record<string, string> | undefined {
  const record = site[field];
  if (record === undefined) return undefined;
  const kept: Record<string, string> = {};
  for (const [name, value] of Object.entries(record)) {
    if (!isReservedSiteVariableName(name)) {
      kept[name] = value;
      continue;
    }
    logWarn(
      "site-secret-env",
      `site ${site.composeServiceName}: variable ${name} is reserved for PHP itself; not passed`,
    );
  }
  return Object.keys(kept).length > 0 ? kept : undefined;
}

/**
 * The site without any reserved variable name, in the plain and the sealed map
 * alike (a sealed one is dropped before it is decrypted). Unchanged sites come
 * back as the same object.
 */
function dropReservedSiteVariables(
  site: EnvironmentDeploySite,
): EnvironmentDeploySite {
  const hasReserved = [site.webEnv, site.webSecretEnv].some((record) =>
    Object.keys(record ?? {}).some(isReservedSiteVariableName)
  );
  if (!hasReserved) return site;
  const { webEnv: _plain, webSecretEnv: _sealed, ...rest } = site;
  const webEnv = withoutReservedNames(site, "webEnv");
  const webSecretEnv = withoutReservedNames(site, "webSecretEnv");
  return {
    ...rest,
    ...(webEnv === undefined ? {} : { webEnv }),
    ...(webSecretEnv === undefined ? {} : { webSecretEnv }),
  };
}

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
 * Every site with `webSecretEnv` replaced by decrypted entries in `webEnv`,
 * and without any variable named like a PHP ini override
 * ({@link isReservedSiteVariableName}). Sites with neither come back
 * unchanged. One site at a time: the daemon's decrypt endpoint is called in
 * batches, never in parallel.
 */
export async function resolveSiteSecretEnv(
  sites: readonly EnvironmentDeploySite[],
  decryptSecrets: DecryptSecretsFn | undefined,
): Promise<EnvironmentDeploySite[]> {
  const checked = sites.map(dropReservedSiteVariables);
  const out = [...checked];
  await forEachSequential(checked, async (site, index) => {
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
