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
 * It also guards retired Analytics Engine dataset names
 * (`turbopanel_server_metrics`, `turbopanel_server_metrics_v4`,
 * `turbopanel_server_metrics_v5`, `turbopanel_server_telemetry`,
 * `turbopanel_server_host_metrics`). Those names must not appear outside
 * this guard and its tests — there is no historical-context allowlist for
 * docs or config (see RETIRED_DATASET_ALLOWED_PATHS). The current dataset is
 * `turbopanel_server_metrics_v6`.
 *
 * Scans this repo's `src/`, `scripts/`, and `orchestration/` trees, plus the
 * sibling `../turbopanel/src`, `../dev/src`, and `../ui/src` checkouts when
 * present (the co-located dev workspace layout), and the sibling contributor
 * tooling that used to provision the retired backend — `../dev/scripts`,
 * `../dev/orchestration`, and `../dev/Vagrantfile`. Also scans website docs,
 * UI design-system docs, and `../turbopanel/wrangler.jsonc` so retired
 * dataset names cannot return in public docs or Cloudflare config. Absent
 * siblings are skipped so a clean single-repo CI checkout still verifies
 * its own tree. Sibling repos run this guard from their own CI by checking
 * out this repo next to theirs (see their verify/build workflows).
 *
 * Companion guard to `scripts/check-vocabulary.ts` — same walk/report shape.
 * Run: `deno task check:metrics-legacy`.
 *
 * Also covers two metrics boundary invariants (`.ts` files only), mirroring
 * the control-plane's own `turbopanel/scripts/check-metrics-boundaries.mjs`
 * so the daemon's CI catches a regression even when that sibling script
 * doesn't run (e.g. a PR against this repo alone):
 *
 *  1. AE physical positional tokens (`double<N>`/`blob<N>`/the raw
 *     `-1e308` sentinel) stay confined to `backends/cloudflare/`.
 *  2. The paged-entity-series "page identity" symbols
 *     (`AE_BLOB_PAGE_INDEX`, `AE_BLOB_SOURCE_OR_IDENTITY_INDEX`,
 *     `entityIdInPageIdentityPredicate` — backend-private per
 *     `field-map.ts`'s doc comments) never appear as real code outside
 *     `backends/cloudflare/`, scanned across every `.ts` file (not just
 *     `/metrics/` paths) since these names are unique enough to carry no
 *     false-positive risk. turbopaneld has no equivalent of its own: it only
 *     collects/emits samples, it never writes AE rows, so these constants
 *     exist solely on the turbopanel side.
 *
 * Doc-comment prose is not flagged for either — only code lines are scanned.
 */
import { relative } from "@std/path";

const repoRoot = new URL("..", import.meta.url).pathname.replace(/\/$/, "");
const workspaceRoot = new URL("../..", import.meta.url).pathname.replace(
  /\/$/,
  "",
);

/** The retired ClickHouse backend / Tabix GUI — code or comment, case-insensitive. */
export const CLICKHOUSE_TABIX_PATTERN = /clickhouse|tabix/i;

/**
 * The retired dataset names are matched with a trailing negative lookahead
 * so this never flags the *current*, legitimately-similar
 * `TURBOPANEL_SERVER_METRICS_*` env var prefix (`_RETENTION_DAYS`,
 * `_DUCKDB_THREADS`, etc.) — those are a longer identifier, not the exact
 * retired dataset name.
 */
export const RETIRED_DATASET_PATTERN =
  /turbopanel_server_metrics(?![a-z0-9_])|turbopanel_server_metrics_v4(?![a-z0-9_])|turbopanel_server_metrics_v5(?![a-z0-9_])|turbopanel_server_telemetry(?![a-z0-9_])|turbopanel_server_host_metrics(?![a-z0-9_])/i;

/**
 * Managed-database-engine code paths where `clickhouse` names a catalog
 * engine, not the retired metrics backend. Keys are `<repo>/<path prefix>`.
 * Keep this list to actual managed-engine code — never re-allow metrics
 * plumbing more broadly. This allowlist governs `CLICKHOUSE_TABIX_PATTERN`
 * matches only; it does not exempt the retired AE dataset names (see
 * `RETIRED_DATASET_ALLOWED_PATHS` below, which is deliberately narrower).
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
  // turbopanel: fake-AE test harness — same ClickHouse-dialect rationale as
  // the cloudflare/ backend itself (documents the DuckDB macros it shims in
  // for ClickHouse-flavored SQL identifiers the real AE SQL API accepts).
  "turbopanel/src/daemon/metrics/testing/fake-analytics-engine.ts",
  // turbopanel: negative guard asserting ClickHouse grants stay gone.
  "turbopanel/src/deno-compile-permissions.test.ts",
  // ui: managed-engine catalog UI + release/binding metadata.
  "ui/src/components/org/managed/",
  "ui/src/components/org/project-create/setup-types.test.ts",
  "ui/src/lib/managed-services.ts",
  "ui/src/lib/managed-services.test.ts",
  "ui/src/lib/managed-releases.test.ts",
  "ui/src/lib/bindings.ts",
  // UI design-system: managed catalog copy (not the retired metrics backend).
  "ui/design-system/turbopanel/pages/project-create.md",
] as const;

/**
 * Exact files allowed to name a retired AE dataset. Only this guard and its
 * tests may mention those names — to define and assert the ban. Docs,
 * Wrangler config, and metrics module comments must describe the current
 * dataset only.
 */
export const RETIRED_DATASET_ALLOWED_PATHS = [
  "turbopaneld/scripts/check-metrics-legacy.ts",
  "turbopaneld/scripts/check-metrics-legacy.test.ts",
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
  /\.(ts|tsx|js|mjs|cjs|md|mdx|yml|yaml|sh|j2|json|jsonc|css|rb)$/;

/**
 * AE physical column literal or the raw sentinel value, as real code (not
 * doc prose). Deliberately does not match the exported
 * `AE_MISSING_METRIC_SENTINEL` *symbol* — importing that constant to
 * compare against (rather than inlining its `-1e308` value) is always fine
 * anywhere; this rule only confines the raw literal and hardcoded column
 * names, never the symbol.
 */
export const AE_TOKEN_PATTERN =
  /(["'`])(double|blob)\d{1,2}\1|\.(double|blob)\d{1,2}\b|-1e308/;

/**
 * turbopanel-side metrics-contract-facing files outside `src/daemon/metrics/`
 * that are also scanned for AE positional tokens. Mirrors
 * `turbopanel/scripts/check-metrics-boundaries.mjs`'s `EXTRA_SURFACE_DIRS` /
 * `EXTRA_SURFACE_FILES`. Exact `turbopanel/`-scoped paths — `turbopanel/src`
 * is not scanned wholesale for this the way `/metrics/` paths are.
 */
export const METRICS_CONTRACT_SURFACE_PATH_PREFIXES = [
  "turbopanel/src/daemon/openapi/",
] as const;
export const METRICS_CONTRACT_SURFACE_EXACT_PATHS = new Set([
  "turbopanel/src/client/openapi/metrics.ts",
  "turbopanel/src/client/openapi/metrics.test.ts",
  "turbopanel/src/client/servers/metrics-routes.ts",
  "turbopanel/src/client/servers/metrics-routes.test.ts",
  "turbopanel/src/client/servers/metrics-routes-helpers.ts",
  "turbopanel/src/client/servers/metrics-routes-helpers.hostfree.test.ts",
  // Topology/SlotMapping records: `field-map.ts` derives its
  // identity-addressed page ordering (`gpuPageOrder` / `blockPageOrder` /
  // `filesystemPageOrder` / `hardwareSignalPageOrder`) from these, so they
  // sit right next to the backend-private paging concept even though they
  // are themselves backend-neutral (`SlotMapping` is computed once by the
  // ingest route and handed to whichever backend is active). Mirrors
  // turbopanel/scripts/check-metrics-boundaries.mjs's EXTRA_SURFACE_FILES.
  "turbopanel/src/client/servers/server-topology-records.ts",
  "turbopanel/src/client/servers/server-topology-records.test.ts",
  "turbopanel/src/client/servers/topology-inventory.ts",
  "turbopanel/src/client/servers/topology-inventory.test.ts",
  "turbopanel/src/client/servers/topology-slot-mapping.ts",
  "turbopanel/src/client/servers/topology-slot-mapping.test.ts",
  "turbopanel/src/client/servers/topology-types.ts",
]);

function isMetricsContractSurface(scoped: string): boolean {
  return (
    METRICS_CONTRACT_SURFACE_EXACT_PATHS.has(scoped) ||
    METRICS_CONTRACT_SURFACE_PATH_PREFIXES.some((prefix) =>
      scoped.startsWith(prefix)
    )
  );
}

/**
 * Backend-private paged-entity-series "page identity" symbols — blob9's
 * page index and blob10's comma-joined page identity list
 * (`AE_BLOB_PAGE_INDEX`, `AE_BLOB_SOURCE_OR_IDENTITY_INDEX`) and the
 * SQL predicate built from them (`entityIdInPageIdentityPredicate`). Must
 * never appear as real code outside `backends/cloudflare/`.
 */
export const PAGE_IDENTIFIER_PATTERN =
  /\bAE_BLOB_PAGE_INDEX\b|\bAE_BLOB_SOURCE_OR_IDENTITY_INDEX\b|\bentityIdInPageIdentityPredicate\b|\bsplitPageIdentity\b/;

/**
 * Exact `turbopanel/`-scoped paths permitted to reference the page-identifier
 * symbols outside `backends/cloudflare/`.
 */
export const PAGE_IDENTIFIER_ALLOWED_PATHS = new Set([
  // Daemon end-to-end ingest-route test: asserts on the actual AE row shape
  // (`blobs[...]`) written by CloudflareAnalyticsEngineServerMetricsStore,
  // so it necessarily reaches into the backend-private blob layout directly
  // rather than through a query-side abstraction. Narrow, intentional.
  "turbopanel/src/daemon/api-routes.test.ts",
]);

function isCommentLine(line: string): boolean {
  const trimmed = line.trim();
  return (
    trimmed.startsWith("*") ||
    trimmed.startsWith("//") ||
    trimmed.startsWith("/*")
  );
}

function isUnderCloudflareBackend(scoped: string): boolean {
  return scoped.includes("backends/cloudflare/");
}

/**
 * AE-token boundary failures for one `.ts` file — invariant 1 in the
 * module doc comment. Never applied to non-`.ts` files (doc/config files may
 * legitimately discuss these tokens in prose). In scope for either of two
 * reasons: the path sits under a `/metrics/` directory — mirroring
 * `turbopanel/scripts/check-metrics-boundaries.mjs`'s own `src/daemon/metrics`
 * scan root, so a token match in unrelated UI/app code (this script also
 * scans `ui/src`, `dev/src`, etc.) is never a false positive here — or the
 * path is one of the explicit `METRICS_CONTRACT_SURFACE_*` surfaces outside
 * the metrics tree.
 */
export function collectBoundaryFailures(
  scoped: string,
  text: string,
): string[] {
  if (!scoped.endsWith(".ts")) return [];
  const inMetricsPath = scoped.includes("/metrics/");
  const isContractSurface = isMetricsContractSurface(scoped);
  if (!inMetricsPath && !isContractSurface) return [];
  if (isUnderCloudflareBackend(scoped)) return [];

  const failures: string[] = [];
  text.split("\n").forEach((line, i) => {
    if (isCommentLine(line)) return;
    const match = AE_TOKEN_PATTERN.exec(line);
    if (match) {
      failures.push(
        `${scoped}:${i + 1} references AE physical token "${
          match[0]
        }" outside backends/cloudflare/`,
      );
    }
  });
  return failures;
}

/**
 * Page-identifier boundary failures for one `.ts` file — invariant 2 in the
 * module doc comment. Scanned across every `.ts` file (not gated to
 * `/metrics/` paths, unlike {@link collectBoundaryFailures}) since
 * `PAGE_IDENTIFIER_PATTERN`'s symbol names are unique enough to carry no
 * false-positive risk, and the real leak this rule exists to catch
 * (`turbopanel/src/daemon/api-routes.test.ts`) lives outside every other
 * surface this guard scopes by path.
 */
export function collectPageIdentifierFailures(
  scoped: string,
  text: string,
): string[] {
  if (!scoped.endsWith(".ts")) return [];
  if (isUnderCloudflareBackend(scoped)) return [];
  if (PAGE_IDENTIFIER_ALLOWED_PATHS.has(scoped)) return [];
  const failures: string[] = [];
  text.split("\n").forEach((line, i) => {
    if (isCommentLine(line)) return;
    const match = PAGE_IDENTIFIER_PATTERN.exec(line);
    if (match) {
      failures.push(
        `${scoped}:${
          i + 1
        } references backend-private page-identifier symbol "${
          match[0]
        }" outside backends/cloudflare/`,
      );
    }
  });
  return failures;
}

export function isAllowedPath(scoped: string): boolean {
  return ALLOWED_PATH_PREFIXES.some((prefix) => scoped.startsWith(prefix));
}

/** Narrow check for `RETIRED_DATASET_PATTERN` matches — exact files only, no prefixes. */
export function isAllowedRetiredDatasetPath(scoped: string): boolean {
  return (RETIRED_DATASET_ALLOWED_PATHS as readonly string[]).includes(
    scoped,
  );
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
  const clickhouseTabixAllowed = isAllowedPath(scoped);
  const retiredDatasetAllowed = isAllowedRetiredDatasetPath(scoped);
  if (clickhouseTabixAllowed && retiredDatasetAllowed) return [];
  const failures: string[] = [];
  text.split("\n").forEach((line, i) => {
    if (!clickhouseTabixAllowed) {
      const match = CLICKHOUSE_TABIX_PATTERN.exec(line);
      if (match) {
        failures.push(
          `${scoped}:${i + 1} references retired metrics infrastructure ("${
            match[0]
          }")`,
        );
      }
    }
    if (!retiredDatasetAllowed) {
      const match = RETIRED_DATASET_PATTERN.exec(line);
      if (match) {
        failures.push(
          `${scoped}:${i + 1} references retired metrics infrastructure ("${
            match[0]
          }")`,
        );
      }
    }
  });
  failures.push(
    ...collectBoundaryFailures(scoped, text),
    ...collectPageIdentifierFailures(scoped, text),
  );
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
  // Public docs + console design-system docs (page overrides such as
  // server-metrics.md) and the instance Wrangler config — retired dataset
  // names must not return here as historical context.
  const websiteDocs = `${siblingsRoot}/website/docs`;
  if (await directoryExists(websiteDocs)) {
    roots.push({ scope: "website/docs", dir: websiteDocs });
  }
  const uiDesignSystem = `${siblingsRoot}/ui/design-system`;
  if (await directoryExists(uiDesignSystem)) {
    roots.push({ scope: "ui/design-system", dir: uiDesignSystem });
  }
  const wrangler = `${siblingsRoot}/turbopanel/wrangler.jsonc`;
  if (await fileExists(wrangler)) {
    roots.push({ scope: "turbopanel/wrangler.jsonc", file: wrangler });
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
        "Tabix GUI are retired. Only managed-database-engine code paths may name " +
        "the `clickhouse` catalog engine. Retired AE dataset names " +
        "(`turbopanel_server_metrics`, `turbopanel_server_telemetry`, " +
        "`turbopanel_server_host_metrics`) must not appear outside this guard " +
        "and its tests. AE positional tokens " +
        "(double<N>/blob<N>/-1e308) must stay confined to backends/cloudflare/ " +
        "— always derive columns through field-map.ts. The page-identifier " +
        "symbols (AE_BLOB_PAGE_INDEX, AE_BLOB_SOURCE_OR_IDENTITY_INDEX, " +
        "entityIdInPageIdentityPredicate, splitPageIdentity) are backend-private " +
        "and must stay confined to backends/cloudflare/ as well.",
    );
    exit(1);
    return;
  }
  log("Metrics-legacy check passed: no retired metrics references found.");
}

if (import.meta.main) {
  reportMetricsLegacyFailures(await runMetricsLegacyCheck());
}
