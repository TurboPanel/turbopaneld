# Editor and Pre-Commit Hook — AGENTS.md

Daemon repo context: `../AGENTS.md`. Cross-repo `../<repo>/…` links are relative
to the repo root.

## Editor and Pre-Commit

**Editor:** this repo has no `tsconfig.json`. Folder `.vscode/settings.json`
sets `deno.enable`, Deno as the default formatter for TS/JS/JSON, and
format-on-save so `deno fmt` matches CI before a commit. It also turns off the
built-in TypeScript/JavaScript validators so Cursor/VS Code does not report
`Cannot find name 'Deno'` / missing `@std/*` on Deno sources. Install **Deno**
(`denoland.vscode-deno`); the sibling `dev` folder keeps `deno.enable: false`
(Node console). Typecheck with `deno task check` / `deno task test`, not `tsc`.

**Pre-commit** (`.githooks/pre-commit`): `scripts/scan-secrets.sh` is never
skippable. The hook then runs `deno fmt` and restages files already in the
commit so the index cannot stay unformatted, followed by the **offline static
gates from `verify.yml`, in CI order**: `deno lint`, `deno task check:layout`,
`deno task check:vocabulary`. Those three are whole-tree scans (not staged-diff
scans) and finish in ~1s together — they exist here because a new file that
hardcodes a layout path or uses retired phrasing is otherwise only caught
minutes into a PR run, which was the single most common cause of a red `verify`
on an otherwise-good change. Deno resolution is pin-aware and delegated to
`../dev/scripts/lib/hook-toolchain.sh` (`tp_hook_ensure_deno_toolchain`), so the
hook, `./console` and CI all run the one pinned release: the pinned
`/opt/turbopanel/vendor/deno/<DENO_VERSION>/deno` wins; `vendor/deno/current` is
used only once it resolves to that pin (the hook relinks it where it can write,
and otherwise runs the versioned binary directly); an absent pin is fetched from
`dl.deno.land` when `curl` + `python3` are present; a PATH Deno is a last
resort, never the default — `deno fmt` / `lint` output differs between releases,
so a stale host Deno reformats the tree the pinned CI runner then rejects. When
none of that yields a pinned Deno the hook falls back to
`vagrant ssh -c '… cd ~/turbopaneld && deno <args>'` from the sibling `dev`
checkout (same guest command as "Where to run tests" in
`src/testing/AGENTS.md`). Resolution is memoized across the four guards, and
`tp_precommit_deno_exec` propagates the exit status, so a failing guard aborts
the commit. Typecheck and the suites stay deferred to `deno task verify` / CI.
Set `TURBOPANEL_SKIP_HOOK_TESTS=1` to skip fmt **and** the guards (secret scan
still runs; CI still gates all of them). The dev console’s daemon install
(`cloneOrUpdateRepo` in `../dev/src/lib/platform-install.ts`) sets
`core.hooksPath=.githooks` after a successful clone or update when
`.githooks/pre-commit` exists. Production `scripts/run.sh` never wires hooks.
