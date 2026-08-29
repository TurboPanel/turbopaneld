/**
 * Content fingerprint of the daemon source checkout.
 *
 * `release:dev` stamps this into `dist/manifest.json` (`source`) so the dev
 * instance can tell whether the overlay artifacts were built from the checkout
 * as it stands now or whether a rebuild is required before upgrading daemons.
 * The dev instance recomputes the same value (turbopanel repo,
 * `src/developer/dev-update-overlay.ts`) — keep both algorithms in sync.
 *
 * Clean tree → the full lowercase HEAD sha.
 * Dirty tree → `<head>+dirty.<12 hex>` where the hash covers `git diff HEAD`
 * (staged + unstaged tracked changes) plus the path and blob hash of every
 * untracked, non-ignored file.
 */
import { encodeHex } from "@std/encoding/hex";

export type SourceFingerprintRunner = (
  args: string[],
) => Promise<{ success: boolean; stdout: Uint8Array; stderr: Uint8Array }>;

export function defaultSourceFingerprintRunner(
  cwd: string,
): SourceFingerprintRunner {
  return (args) =>
    new Deno.Command("git", {
      args: ["-C", cwd, ...args],
      stdout: "piped",
      stderr: "piped",
    }).output();
}

async function gitOutput(
  run: SourceFingerprintRunner,
  args: string[],
): Promise<string> {
  const result = await run(args);
  if (!result.success) {
    const stderr = new TextDecoder().decode(result.stderr).trim();
    throw new Error(`git ${args[0]} failed: ${stderr}`);
  }
  return new TextDecoder().decode(result.stdout);
}

export async function computeSourceFingerprint(
  cwd: string,
  run: SourceFingerprintRunner = defaultSourceFingerprintRunner(cwd),
): Promise<string> {
  const head = (await gitOutput(run, ["rev-parse", "HEAD"])).trim()
    .toLowerCase();
  const diff = await gitOutput(run, ["diff", "HEAD"]);
  const untrackedRaw = (await gitOutput(run, [
    "ls-files",
    "--others",
    "--exclude-standard",
  ])).trim();
  const untracked = untrackedRaw ? untrackedRaw.split("\n") : [];

  let untrackedSection = "";
  if (untracked.length > 0) {
    const hashes = (await gitOutput(run, ["hash-object", "--", ...untracked]))
      .trim()
      .split("\n");
    untrackedSection = untracked
      .map((path, i) => `${path}:${hashes[i] ?? ""}`)
      .join("\n");
  }

  if (diff.trim() === "" && untrackedSection === "") {
    return head;
  }

  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(`${diff}\0${untrackedSection}`),
  );
  const dirtyHash = encodeHex(new Uint8Array(digest)).slice(0, 12);
  return `${head}+dirty.${dirtyHash}`;
}
