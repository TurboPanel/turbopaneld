/**
 * Run tp-orchestrate's real extra-var validator from a test.
 *
 * The functions and the JSON key list are lifted verbatim out of
 * `orchestration/scripts/tp-orchestrate` — never restated here — so a test
 * that passes proves the shipped helper accepts (or refuses) the value. Only
 * the two paths the helper derives from its own location are supplied:
 * `INSTALL_ROOT` (what `turbopanel_install_root` must equal) and
 * `VENDOR_DIR` (where it finds the Ansible venv's python3 for JSON checks).
 */
import { dirname, fromFileUrl, join } from "@std/path";

const here = dirname(fromFileUrl(import.meta.url));
export const TP_ORCHESTRATE_PATH = join(
  here,
  "../../orchestration/scripts/tp-orchestrate",
);

const VALIDATOR_FUNCTIONS = [
  "tp_extra_var_value_ok",
  "tp_hostname_ok",
  "tp_host_token_ok",
  "tp_host_list_ok",
  "tp_email_ok",
  "tp_backup_dir_ok",
  "tp_json_extra_var_ok",
  "tp_valid_extra_var",
] as const;

/** `name() { … }` up to the first line that is exactly `}`. */
export function extractShellFunction(source: string, name: string): string {
  const needle = `${name}() {`;
  const start = source.indexOf(needle);
  if (start < 0) throw new TypeError(`missing ${name} in tp-orchestrate`);
  const end = source.indexOf("\n}\n", start);
  if (end < 0) throw new TypeError(`unclosed ${name} in tp-orchestrate`);
  return source.slice(start, end + 2);
}

function extractAssignment(source: string, name: string): string {
  const line = source.split("\n").find((l) => l.startsWith(`${name}=`));
  if (!line) throw new TypeError(`missing ${name}= in tp-orchestrate`);
  return line;
}

/** The validator functions plus `TP_JSON_EXTRA_VAR_KEYS`, as sh source. */
export async function tpOrchestrateValidatorSource(): Promise<string> {
  const source = await Deno.readTextFile(TP_ORCHESTRATE_PATH);
  return [
    extractAssignment(source, "TP_JSON_EXTRA_VAR_KEYS"),
    ...VALIDATOR_FUNCTIONS.map((name) => extractShellFunction(source, name)),
  ].join("\n");
}

async function hostPython3(): Promise<string> {
  const out = await new Deno.Command("sh", {
    args: ["-c", "command -v python3"],
    stdout: "piped",
  }).output();
  const path = new TextDecoder().decode(out.stdout).trim();
  if (!out.success || !path) throw new TypeError("python3 not found");
  return path;
}

/**
 * A throwaway `<vendor>/ansible/current/bin/python3` that runs the host
 * interpreter, standing in for the Ansible venv the helper uses.
 */
export async function makeFakeVendorDir(): Promise<string> {
  const vendor = await Deno.makeTempDir({ prefix: "tp-orch-vendor-" });
  const bin = join(vendor, "ansible", "current", "bin");
  await Deno.mkdir(bin, { recursive: true });
  // A tiny exec shim, not a symlink: src/ stays free of Deno.symlink (see
  // scoped-writes.test.ts), and the helper only ever runs this path.
  const shim = join(bin, "python3");
  await Deno.writeTextFile(
    shim,
    `#!/bin/sh\nexec '${await hostPython3()}' "$@"\n`,
  );
  await Deno.chmod(shim, 0o755);
  return vendor;
}

export type ExtraVarVerdict = { value: string; accepted: boolean };

/**
 * Run each `-e` value through the real `tp_valid_extra_var`, in one shell.
 * `installRoot` defaults to the production install root.
 */
export async function checkExtraVars(
  values: readonly string[],
  opts: { installRoot?: string; vendorDir: string },
): Promise<ExtraVarVerdict[]> {
  const script = [
    "set -u",
    `INSTALL_ROOT='${opts.installRoot ?? "/opt/turbopanel"}'`,
    `VENDOR_DIR='${opts.vendorDir}'`,
    await tpOrchestrateValidatorSource(),
    'for v in "$@"; do',
    '  if tp_valid_extra_var "$v"; then echo OK; else echo NO; fi',
    "done",
  ].join("\n");
  const out = await new Deno.Command("sh", {
    args: ["-c", script, "sh", ...values],
    stdout: "piped",
    stderr: "piped",
    clearEnv: true,
    env: { PATH: "/usr/bin:/bin" },
  }).output();
  const lines = new TextDecoder().decode(out.stdout).trim().split("\n");
  if (lines.length !== values.length) {
    throw new TypeError(
      `validator printed ${lines.length} verdicts for ${values.length} values: ${
        new TextDecoder().decode(out.stderr)
      }`,
    );
  }
  return values.map((value, i) => ({ value, accepted: lines[i] === "OK" }));
}

/** The values that follow each `-e` in an argv. */
export function extraVarValues(args: readonly string[]): string[] {
  const values: string[] = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "-e") {
      const value = args[i + 1];
      if (value === undefined) throw new TypeError("dangling -e");
      values.push(value);
      i += 1;
    }
  }
  return values;
}
