#!/usr/bin/env -S deno run --allow-read
/**
 * Metrics-legacy check (CI guard).
 *
 * The server-metrics store is DuckDB + Parquet (Deno) / Analytics Engine
 * (Workers). The retired ClickHouse metrics backend and its dev-only Tabix
 * GUI must not silently reappear: this guard fails on any `clickhouse` /
 * `tabix` reference — code or comment — outside the managed-database-engine
 * code paths, where `clickhouse` is a legitimate catalog engine name.
 *
 * Scans this repo's `src/`, `scripts/`, and `orchestration/` trees, plus the
 * sibling `../turbopanel/src`, `../dev/src`, and `../ui/src` checkouts when
 * present (the co-located dev workspace layout), and the sibling contributor
 * tooling that used to provision the retired backend — `../dev/scripts`,
 * `../dev/orchestration`, and `../dev/Vagrantfile`; absent siblings are
 * skipped so a clean single-repo CI checkout still verifies its own tree.
 * Sibling repos run this guard from their own CI by checking out this repo
 * next to theirs (see their verify/build workflows), so a PR in any repo is
 * gated without needing the full co-located workspace.
 *
 * Companion guard to `scripts/check-vocabulary.ts` — same walk/report shape.
 * Run: `deno task check:metrics-legacy`.
 */
import { relative } from "@std/path";

const repoRoot = new URL("..", import.meta.url).pathname.replace(/\/$/, "");
const workspaceRoot = new URL("../..", import.meta.url).pathname.replace(
  /\/$/,
  "",
);

export const FORBIDDEN_PATTERN = /clickhouse|tabix/i;

/**
 * Managed-database-engine code paths where `clickhouse` names a catalog
 * engine, not the retired metrics backend. Keys are `<repo>/<path prefix>`.
 * Keep this list to actual managed-engine code — never re-allow metrics
 * plumbing or historical-rationale comments.
 */
export const ALLOWED_PATH_PREFIXES = [
  // turbopaneld: managed-engine registry + command contracts (MANAGED_ENGINE_CODES).
  "turbopaneld/src/managed/",
  "turbopaneld/src/instance/commands/contracts.ts",
  // This guard's own pattern constants.
  "turbopaneld/scripts/check-metrics-legacy.ts",
  "turbopaneld/scripts/check-metrics-legacy.test.ts",
  // turbopanel: managed-engine catalog/openapi/principals surface and the
  // `provider` CHECK constraint (schema + its doc).
  "turbopanel/src/lib/managed/",
  "turbopanel/src/client/",
  "turbopanel/src/lib/db/schema.ts",
  "turbopanel/src/lib/db/resource-hierarchy.md",
  // turbopanel: Cloudflare Analytics Engine speaks a ClickHouse-compatible
  // SQL dialect / response format — these files describe Cloudflare's API.
  "turbopanel/src/daemon/metrics/backends/cloudflare/",
  // turbopanel: negative guard asserting ClickHouse grants stay gone.
  "turbopanel/src/deno-compile-permissions.test.ts",
  // ui: managed-engine catalog UI + release/binding metadata.
  "ui/src/components/org/managed/",
  "ui/src/components/org/project-create/setup-types.test.ts",
  "ui/src/lib/managed-services.ts",
  "ui/src/lib/managed-services.test.ts",
  "ui/src/lib/managed-releases.test.ts",
  "ui/src/lib/bindings.ts",
] as const;

const SKIP_DIRS = new Set([
  ".git",
  "node_modules",
  "dist",
  "publish",
  "state",
  "logs",
  "coverage",
  ".ansible",
]);

const SKIP_FILENAMES = new Set([
  "deno.lock",
  "package-lock.json",
  "pnpm-lock.yaml",
  "yarn.lock",
  "THIRD_PARTY_NOTICES.md",
]);

const SCAN_EXTENSIONS =
  /\.(ts|tsx|js|mjs|cjs|md|mdx|yml|yaml|sh|j2|json|css|rb)$/;

export function isAllowedPath(scoped: string): boolean {
  return ALLOWED_PATH_PREFIXES.some((prefix) => scoped.startsWith(prefix));
}

async function* walkFiles(dir: string, root: string): AsyncGenerator<string> {
  for await (const entry of Deno.readDir(dir)) {
    const abs = `${dir}/${entry.name}`;
    if (entry.isDirectory) {
      if (SKIP_DIRS.has(entry.name)) continue;
      yield* walkFiles(abs, root);
    } else if (entry.isFile) {
      if (SKIP_FILENAMES.has(entry.name)) continue;
      yield abs;
    }
  }
}

export function collectMetricsLegacyFailures(
  scoped: string,
  text: string,
): string[] {
  if (isAllowedPath(scoped)) return [];
  const failures: string[] = [];
  text.split("\n").forEach((line, i) => {
    const match = FORBIDDEN_PATTERN.exec(line);
    if (match) {
      failures.push(
        `${scoped}:${i + 1} references retired metrics infrastructure ("${
          match[0]
        }")`,
      );
    }
  });
  return failures;
}

type ScanRoot =
  | {
    /** Repo-scoped prefix for reporting + allowlisting (e.g. `turbopanel/src`). */
    scope: string;
    /** Absolute directory to walk. */
    dir: string;
  }
  | {
    /** Repo-scoped path for reporting + allowlisting (e.g. `dev/Vagrantfile`). */
    scope: string;
    /** Single absolute file to scan (extension gate does not apply). */
    file: string;
  };

async function directoryExists(path: string): Promise<boolean> {
  try {
    return (await Deno.stat(path)).isDirectory;
  } catch {
    return false;
  }
}

async function fileExists(path: string): Promise<boolean> {
  try {
    return (await Deno.stat(path)).isFile;
  } catch {
    return false;
  }
}

export async function resolveScanRoots(
  daemonRoot = repoRoot,
  siblingsRoot = workspaceRoot,
): Promise<ScanRoot[]> {
  const roots: ScanRoot[] = [];
  for (const tree of ["src", "scripts", "orchestration"]) {
    const dir = `${daemonRoot}/${tree}`;
    if (await directoryExists(dir)) {
      roots.push({ scope: `turbopaneld/${tree}`, dir });
    }
  }
  for (const repo of ["turbopanel", "dev", "ui"]) {
    const dir = `${siblingsRoot}/${repo}/src`;
    if (await directoryExists(dir)) {
      roots.push({ scope: `${repo}/src`, dir });
    }
  }
  // Contributor-tooling surfaces beyond `src/`: the dev repo's Vagrant guest
  // and its orchestration overlay are exactly where the retired ClickHouse
  // container / Tabix GUI provisioning used to live.
  for (const tree of ["scripts", "orchestration"]) {
    const dir = `${siblingsRoot}/dev/${tree}`;
    if (await directoryExists(dir)) {
      roots.push({ scope: `dev/${tree}`, dir });
    }
  }
  const devVagrantfile = `${siblingsRoot}/dev/Vagrantfile`;
  if (await fileExists(devVagrantfile)) {
    roots.push({ scope: "dev/Vagrantfile", file: devVagrantfile });
  }
  return roots;
}

export async function runMetricsLegacyCheck(
  roots?: ScanRoot[],
): Promise<string[]> {
  const scanRoots = roots ?? await resolveScanRoots();
  const failures: string[] = [];
  for (const root of scanRoots) {
    if ("file" in root) {
      const text = await Deno.readTextFile(root.file);
      failures.push(...collectMetricsLegacyFailures(root.scope, text));
      continue;
    }
    const { scope, dir } = root;
    for await (const file of walkFiles(dir, dir)) {
      if (!SCAN_EXTENSIONS.test(file)) continue;
      const scoped = `${scope}/${relative(dir, file)}`;
      const text = await Deno.readTextFile(file);
      failures.push(...collectMetricsLegacyFailures(scoped, text));
    }
  }
  return failures;
}

export function reportMetricsLegacyFailures(
  failures: string[],
  io: {
    error?: (message: string) => void;
    log?: (message: string) => void;
    exit?: (code: number) => void;
  } = {},
): void {
  const error = io.error ?? ((message: string) => console.error(message));
  const log = io.log ?? ((message: string) => console.log(message));
  const exit = io.exit ?? ((code: number) => Deno.exit(code));
  if (failures.length > 0) {
    error("Metrics-legacy check failed:\n");
    for (const failure of failures) {
      error(`  ✗ ${failure}`);
    }
    error(
      `\n${failures.length} problem(s) found. Server metrics use DuckDB + Parquet ` +
        "(Deno) / Analytics Engine (Workers) — the ClickHouse backend and the " +
        "Tabix GUI are retired. Only managed-database-engine code paths may " +
        "name the `clickhouse` catalog engine; extend ALLOWED_PATH_PREFIXES " +
        "in this script only for such code, never for metrics plumbing.",
    );
    exit(1);
    return;
  }
  log("Metrics-legacy check passed: no retired metrics references found.");
}

if (import.meta.main) {
  reportMetricsLegacyFailures(await runMetricsLegacyCheck());
}
