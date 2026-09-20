/**
 * Filesystem writes the compiled daemon's scoped Deno grants cannot perform.
 *
 * `deno compile` bakes one permission set into the production binary, and two
 * of Deno's rules make paths inside `--allow-write` unwritable anyway:
 *
 * - **A path on the `--allow-run` allowlist is never writable.** `writeFile`,
 *   `copyFile`, `chmod`, `rename`, and `remove` are all refused, because a
 *   process allowed to execute a file must not be able to rewrite it. The
 *   compiled binary is also the installer, so uv, uvx, and cloudflared sit on
 *   both lists.
 * - **`Deno.symlink()` requires *unscoped* read and write.** A link's target
 *   is only resolved when the link is traversed, so Deno refuses path-scoped
 *   grants outright — every `current` symlink under the vendor tree, and the
 *   release/`current` links on the deploy path, are affected.
 *
 * Neither is reported at compile time. The first canary install after the
 * 2026-09-19 hardening died on the first rule (`Requires write access to` the
 * pinned uv binary, whose parent is squarely inside the write grant) and
 * silently skipped every `current` symlink on the second.
 *
 * `cp`, `chmod`, and `ln` are ordinary subprocesses: the kernel allows them
 * (these paths run as root, or as an owner of the tree) and Deno does not
 * inspect what a child writes. All three are on the daemon and installer run
 * allowlists in `src/daemon-permissions.ts`, which also pins the set of paths
 * that must come through {@link installVendorExecutable}.
 */
/**
 * A `cp` / `chmod` / `ln` helper below exited non-zero.
 *
 * Callers that keep an unprivileged → `sudo` ladder need to tell "the
 * unprivileged attempt could not do it" apart from a real fault. Deno's own
 * APIs signal that with `PermissionDenied`; a subprocess signals it with a
 * non-zero exit, so this type is the subprocess half of that pair.
 */
export class ScopedWriteError extends Error {
  override readonly name = "ScopedWriteError";
}

/** Vendored CLIs must be executable by service users (owner rwx, group/other rx). */
export const VENDOR_BINARY_MODE = "0755"; // NOSONAR typescript:S2612 — service users execute these

/**
 * Put `source` in place at `dest` with mode {@link VENDOR_BINARY_MODE}.
 *
 * `cp -f` unlinks a destination it cannot open for writing, so replacing a
 * pinned version that is currently executing does not fail with `ETXTBSY`.
 */
export async function installVendorExecutable(
  source: string,
  dest: string,
): Promise<void> {
  await runOrThrow("cp", ["-f", source, dest], dest);
  await runOrThrow("chmod", [VENDOR_BINARY_MODE, dest], dest);
}

/**
 * Point `link` at `target`, replacing whatever is there.
 *
 * `-n` keeps an existing symlink-to-directory from being followed, so a
 * `current` link is repointed rather than nested inside its own target.
 */
export async function createSymlink(
  target: string,
  link: string,
): Promise<void> {
  await runOrThrow("ln", ["-sfn", target, link], link);
}

/**
 * Spawned directly rather than through `orchestration/exec.ts`.
 *
 * These are coreutils, not vendored tooling: they need none of that module's
 * runtime PATH or `ANSIBLE_*` environment, and building it reads `PATH`,
 * which would make this helper require `--allow-env` from every caller. A
 * fixed environment also keeps `LD_*` out of the child, which Deno 2.9
 * refuses to inherit into a scoped `--allow-run` spawn.
 */
async function runOrThrow(
  cmd: string,
  args: string[],
  dest: string,
): Promise<void> {
  const { code, success, stderr } = await new Deno.Command(cmd, {
    args,
    stdout: "null",
    stderr: "piped",
    clearEnv: true,
    env: { PATH: "/usr/bin:/bin" },
  }).output();
  if (success) return;
  const detail = new TextDecoder().decode(stderr).trim();
  throw new ScopedWriteError(
    `Failed to install ${dest}: ${cmd} exited ${code}${
      detail ? ` — ${detail}` : ""
    }`,
  );
}
