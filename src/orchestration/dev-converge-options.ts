/**
 * Structured dev-converge options — the one payload the dev console sends to
 * `scripts/run-orchestration-action.ts` for `instance-dev-install`.
 *
 * The console's `src/lib/optional-dev-services.ts` is the only optional-service
 * catalog: it serialises the picker as `{ optionalServices: { <stem>: bool } }`
 * keyed by Ansible stem (`dbstudio`, `mailpit`, `ui`, `website`,
 * `redis_insight`, `stripe_listen`, …). This module has no table of its own —
 * it validates the shape, emits `turbopanel_optional_<stem>` extra-vars as one
 * JSON `-e` object, and folds the same normalised payload into the converge
 * stamp. A missing or malformed payload contributes nothing so the playbook
 * `vars:` / role `| default()` filters decide.
 */

/** Env key carrying the JSON payload (set by the dev console). */
export const DEV_CONVERGE_OPTIONS_ENV = "TURBOPANEL_DEV_CONVERGE_OPTIONS";

export type DevConvergeOptions = {
  /** Ansible stem → enabled. Empty when the console sent nothing. */
  optionalServices: Readonly<Record<string, boolean>>;
};

const STEM_PATTERN = /^[a-z][a-z0-9_]*$/;

function normalizeOptionalServices(raw: unknown): Record<string, boolean> {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return {};
  }
  const out: Record<string, boolean> = {};
  const keys = Object.keys(raw as Record<string, unknown>)
    .filter((key) => STEM_PATTERN.test(key))
    .sort((a, b) => a.localeCompare(b));
  for (const key of keys) {
    const value = (raw as Record<string, unknown>)[key];
    if (typeof value === "boolean") {
      out[key] = value;
    }
  }
  return out;
}

/**
 * Parse the JSON payload once. Unknown keys and non-boolean values are dropped;
 * anything unparsable yields an empty selection (never throws).
 */
export function parseDevConvergeOptions(
  raw: string | undefined,
): DevConvergeOptions {
  const text = raw?.trim();
  if (!text) {
    return { optionalServices: {} };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { optionalServices: {} };
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return { optionalServices: {} };
  }
  return {
    optionalServices: normalizeOptionalServices(
      (parsed as Record<string, unknown>).optionalServices,
    ),
  };
}

/** Read + parse the payload from an env bag (defaults to the process env). */
export function resolveDevConvergeOptions(
  env: { get(key: string): string | undefined } = Deno.env,
): DevConvergeOptions {
  return parseDevConvergeOptions(env.get(DEV_CONVERGE_OPTIONS_ENV));
}

/** Ansible extra-vars object (`turbopanel_optional_<stem>` → bool). */
export function devConvergeExtraVars(
  options: DevConvergeOptions,
): Record<string, boolean> {
  const vars: Record<string, boolean> = {};
  for (
    const [stem, enabled] of Object.entries(options.optionalServices)
  ) {
    vars[`turbopanel_optional_${stem}`] = enabled;
  }
  return vars;
}

/**
 * `-e '<json>'` argv for `ansible-playbook` — one extra-vars object, or nothing
 * when the payload carried no services.
 */
export function devConvergeOptionsExtraArgs(
  options: DevConvergeOptions,
): string[] {
  const vars = devConvergeExtraVars(options);
  if (Object.keys(vars).length === 0) {
    return [];
  }
  return ["-e", JSON.stringify(vars)];
}

/** Canonical stamp material for the normalised payload (sorted, one line per stem). */
export function devConvergeOptionsMaterial(
  options: DevConvergeOptions,
): string {
  const lines = Object.entries(options.optionalServices)
    .map(([stem, enabled]) => `optional_${stem}=${enabled ? "true" : "false"}`);
  lines.sort((a, b) => a.localeCompare(b));
  return lines.join("\n");
}
