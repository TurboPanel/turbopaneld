# AGENTS.md

TurboPanel **daemon** — Ansible-driven host daemon; connects to the instance over
HTTPS/WSS (or Unix socket when co-located).
Daemon source is Deno/TypeScript under `src/`; the Ansible layer is under `orchestration/`; shell and release tooling are under `scripts/`.

**How this guide works.** This root holds only what applies to every directory. The nearest `AGENTS.md` to the file you edit wins: read the matching guide in the index below before editing that area. Do not add `CLAUDE.md` files; this repo uses `AGENTS.md` only.

## Releases

How changes ship: squash-merge into `trunk`, then two bot-opened pull requests (`trunk` to `staging`, `staging` to `live`) that a maintainer merges with merge commits. Hotfixes land on `trunk` first, and the daemon ships before the control plane. See [How changes ship](https://github.com/TurboPanel/.github/blob/trunk/CONTRIBUTING.md#how-changes-ship) and [How to ship](https://turbopanel.io/docs/development/how-to-ship).

## Commands

Run from the repo root (in the guest VM when the host checkout has no usable Deno tree; see `src/testing/AGENTS.md`).

```sh
deno task verify:static        # fmt:check, lint, check, check:layout, check:vocabulary, check:contract-drift
deno task verify               # verify:static plus the test suite (no orchestration)
deno task verify:ci            # guest mirror of CI: verify:static, notices:check, check:orchestration, test:coverage
deno task test                 # tests only; test:coverage also writes the LCOV file
deno task check:orchestration  # ansible syntax check + ansible-lint (needs the Ansible toolchain on PATH)
deno fmt <files> && deno lint  # format and lint (Markdown and orchestration/ are excluded from fmt)
```

Guest setup, coverage rules, the pre-commit hook and CI guards: `src/testing/AGENTS.md`, `.githooks/AGENTS.md`, `.github/AGENTS.md`.

## Rules That Apply Everywhere

- Format every changed file with `deno fmt` and run `deno lint` before committing; CI fails an unformatted file. Style rules: `src/AGENTS.md`.
- Every `*.test.ts` uses the `const test = Deno.test.bind(Deno);` alias, never a bare `Deno.test(`, and tests must not be flaky. Rules: `src/AGENTS.md`.
- `src/testing/**` is test-only and is never imported from production code; new tests use its shared helpers. Rules: `src/testing/AGENTS.md`.
- The secret scan (`scripts/scan-secrets.sh`) is never skipped by the pre-commit hook. Rules: `.githooks/AGENTS.md`, `.github/AGENTS.md`.
- The daemon account `tp` is still root-equivalent on a managed host; every root host command goes through `tp-host` via `hostSudoArgs`. Read `src/permissions/AGENTS.md` before touching sudo, tp-host, tp-orchestrate or Deno permissions.
- Never raise a wire-version floor silently: bump both floors together and feature-gate every new wire message. Rules: `src/instance/AGENTS.md`.
- A signed manifest older than the running build is refused (no rollback by replay). The break-glass override is host-side only (`TURBOPANEL_ALLOW_DOWNGRADE=1`); nothing in a WebSocket message can lift it. Rules: `src/update/AGENTS.md`.
- Release promotion by hand (`promote.yml`) is the break-glass path; the normal path is the two bot-opened promotion pull requests. Rules: `.github/AGENTS.md`.
- Production runs as `tp:tp` under the FHS trees; development is a co-located checkout. Rules: `src/paths/AGENTS.md`.
- `scripts/purge.sh` removes everything TurboPanel put on a host and nothing else. Rules: `scripts/AGENTS.md`.
- Pinned runtimes (Deno, Node, Caddy) change in lockstep across role defaults, `run.sh` and the dev console, with digests. Rules: `orchestration/AGENTS.md`, `src/orchestration/AGENTS.md`.
- Cross-repo rules live in the sibling checkouts (`../turbopanel/AGENTS.md`); link there instead of duplicating.

## Guide Index

Read the matching file before editing that area. Paths are relative to the repo root; deeper guides sit under the guide listed.

| Directory | Guide | When it applies |
|---|---|---|
| `src/` | `src/AGENTS.md` | TypeScript style, Sonar rules, flaky-test rules |
| `src/paths/` | `src/paths/AGENTS.md` | Filesystem layout and path model, dev versus production, server folders |
| `src/testing/` | `src/testing/AGENTS.md` | Test commands, coverage, real-`git` suites, shared helpers, where to run tests |
| `src/permissions/` | `src/permissions/AGENTS.md` | Managed-host privilege boundary: Deno grants, scoped writes, install ownership |
| `src/update/` | `src/update/AGENTS.md` | Signed manifests, release-rail URLs, update TLS, manifest freshness |
| `src/instance/` | `src/instance/AGENTS.md` | WSS / Unix-socket client, presence, reconnect, JWT verification, versions on the wires |
| `src/commands/` | `src/commands/AGENTS.md` | Command handlers behind `command-router.ts` |
| `src/host/` | `src/host/AGENTS.md` | Host OS, time sync, docker, machine key, runtime inventory probes |
| `src/metrics/` | `src/metrics/AGENTS.md` | `/proc` collector, schema v3 contract, sensors, live-mode leases |
| `src/logs/` | `src/logs/AGENTS.md` | Streamed command transcripts, redaction, spool and upload |
| `src/deploy/` | `src/deploy/AGENTS.md` | Tenant deploy, Compose, Traefik, hosting Caddy, deploy hooks; nested `release/`, `native/`, `site/`, `cron/`, `ssh/` guides |
| `src/managed/` | `src/managed/AGENTS.md` | Managed engines, shared ProxySQL ingress, engine registry |
| `src/backups/` | `src/backups/AGENTS.md` | Scheduled backups |
| `src/firewall/` | `src/firewall/AGENTS.md` | Managed host firewall (daemon side) |
| `src/orchestration/` | `src/orchestration/AGENTS.md` | Installer presenter and sanitizer, runtime integrity digests |
| `orchestration/` | `orchestration/AGENTS.md` | Ansible style, vendored runtimes, Galaxy content, host-base prerequisites; role guides under `orchestration/roles/*/` |
| `orchestration/scripts/` | `orchestration/scripts/AGENTS.md` | `sudo`, `tp-host` and `tp-orchestrate` rules |
| `scripts/` | `scripts/AGENTS.md` | Purge script, installer script hosting |
| `.github/` | `.github/AGENTS.md` | CI guards, Sonar coverage, gate matrix, promotion |
| `.githooks/` | `.githooks/AGENTS.md` | Editor setup and the pre-commit hook |

## Project metadata

GitHub repository:
[TurboPanel/turbopaneld](https://github.com/TurboPanel/turbopaneld). Deno
package name: `turbopaneld` (`deno.json`), aligned with the repo slug and the
compiled `/opt/turbopanel/bin/turbopaneld` binary.

**Public naming:** **TurboPanel Daemon** → [TurboPanel/turbopaneld](https://github.com/TurboPanel/turbopaneld); internal term `daemon`. **License:** AGPL-3.0-only ([`LICENSE`](./LICENSE), `deno.json`). Trademarks are not granted by the software license ([`TRADEMARKS.md`](./TRADEMARKS.md)). Third-party components keep their own licenses ([`THIRD_PARTY_NOTICES.md`](./THIRD_PARTY_NOTICES.md)); release packaging stages that file at `opt/turbopanel/share/THIRD_PARTY_NOTICES.md`. Published story: `../website` `/open-source` and `docs/getting-started/licensing.mdx`. Contributions require the [CLA](https://github.com/TurboPanel/.github/blob/trunk/CLA.md). **Maturity:** **Private alpha**. README is product-facing; AGENTS.md is maintainer-facing.

## Documentation discipline

**Keep this file current.** When you learn something durable about daemon ↔
instance contracts — WS presence, reconnect behavior, command handlers,
orchestration — add or update a note here in the same PR/session as the code
change. Cross-repo cell/cost rules live in `../turbopanel/AGENTS.md` (Daemon Cell
section); link there instead of duplicating DO hibernation detail.
