/**
 * Run `run.sh`'s own manifest verifier (the python3 canonicaliser + openssl
 * `pkeyutl -rawin` path) against a manifest, with the test release key pinned.
 * Shared by every suite that proves a signed manifest verifies on hosts.
 */
import { dirname, fromFileUrl, join } from "@std/path";
import { TEST_RELEASE_SIGNING_PUBLIC_KEY_HEX } from "./release-signing-fixture.ts";

const here = dirname(fromFileUrl(import.meta.url));
const runShPath = join(here, "../../scripts/run.sh");

/** The source of run.sh, for suites that assert on its structure. */
export const RUN_SH_PATH = runShPath;

export function extractShellFunction(source: string, name: string): string {
  const needle = `${name}() {`;
  const start = source.indexOf(needle);
  if (start < 0) {
    throw new TypeError(`missing ${name} in run.sh`);
  }
  const brace = source.indexOf("{", start);
  let depth = 0;
  for (let i = brace; i < source.length; i++) {
    const ch = source[i];
    if (ch === "{") depth += 1;
    else if (ch === "}") {
      depth -= 1;
      if (depth === 0) {
        return source.slice(start, i + 1);
      }
    }
  }
  throw new TypeError(`unclosed ${name} in run.sh`);
}

export async function hostCanVerify(): Promise<boolean> {
  for (const bin of ["python3", "openssl"]) {
    try {
      const out = await new Deno.Command(bin, {
        args: ["--version"],
        stdout: "null",
        stderr: "null",
      }).output();
      if (!out.success) return false;
    } catch {
      return false;
    }
  }
  return true;
}

/** Run run.sh's verifier against a manifest file with the test key pinned. */
export async function verifyWithRunSh(
  manifestJson: string,
): Promise<{ status: number; stderr: string }> {
  const source = await Deno.readTextFile(runShPath);
  const helpers = [
    "tp_manifest_canonical_python",
    "tp_manifest_signature_material_python",
    "tp_verify_manifest_signature",
  ].map((name) => extractShellFunction(source, name)).join("\n");
  const dir = await Deno.makeTempDir({ prefix: "tp-run-sh-sig-" });
  try {
    const manifestPath = join(dir, "manifest.json");
    await Deno.writeTextFile(manifestPath, manifestJson);
    const script = [
      `TP_RELEASE_SIGNING_PUBLIC_KEY="${TEST_RELEASE_SIGNING_PUBLIC_KEY_HEX}"`,
      helpers,
      `tp_verify_manifest_signature "$(cat "$1")"`,
    ].join("\n");
    const out = await new Deno.Command("sh", {
      args: ["-eu", "-c", script, "sh", manifestPath],
      stdout: "piped",
      stderr: "piped",
    }).output();
    return {
      status: out.code,
      stderr: new TextDecoder().decode(out.stderr),
    };
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
}
