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
 * It also guards the retired Analytics Engine dataset names
 * `turbopanel_server_metrics` (the original single-datapoint layout) and
 * `turbopanel_server_telemetry` (the two-part core/extended layout schema v3
 * replaced) — AE datasets can't be deleted, so nothing should ever reference
 * either name again outside the handful of files that document them as
 * retired history (see RETIRED_DATASET_ALLOWED_PATHS below — its own narrow
 * list, separate from the broader ALLOWED_PATH_PREFIXES clickhouse/tabix
 * exemptions).
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
 *
 * Also covers three v4 metrics boundary invariants (`.ts` files only),
 * mirroring the control-plane's own `turbopanel/scripts/check-v4-boundaries.mjs`
 * so the daemon's CI catches a regression even when that sibling script
 * doesn't run (e.g. a PR against this repo alone):
 *
 *  1. AE v4 physical positional tokens (`double<N>`/`blob<N>`/the raw
 *     `-1e308` sentinel) stay confined to `backends/cloudflare/`.
 *  2. v3-only symbols (`MetricPart`, `HOST_METRIC_KEYS`, and the v3 wire
 *     field `parts` — anchored to property-access/field-declaration shapes,
 *     see `V3_SYMBOL_PATTERN`) never appear as real code in a `*-v4.ts` file
 *     under a `/metrics/` path, nor in the metrics-contract-facing surfaces
 *     outside the metrics tree that must stay backend-agnostic regardless of
 *     filename suffix (`METRICS_CONTRACT_SURFACE_PATHS` below — the
 *     turbopanel-side mirror of that sibling script's `EXTRA_SURFACE_*`).
 *  3. The v4 paged-entity-series "page identity" symbols
 *     (`AE_V4_BLOB_PAGE_INDEX`, `AE_V4_BLOB_SOURCE_OR_IDENTITY_INDEX`,
 *     `entityIdInPageIdentityPredicateV4` — backend-private per
 *     `field-map-v4.ts`'s doc comments) never appear as real code outside
 *     `backends/cloudflare/`, scanned across every `.ts` file (not just
 *     `/metrics/` paths) since these names are unique enough to carry no
 *     false-positive risk. turbopaneld has no equivalent of its own: it only
 *     collects/emits samples, it never writes AE rows, so these constants
 *     exist solely on the turbopanel side.
 *
 * Doc-comment prose is not flagged for any of the three — only code lines
 * are scanned.
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
  /turbopanel_server_metrics(?![a-z0-9_])|turbopanel_server_telemetry(?![a-z0-9_])/i;

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
  "turbopanel/src/daemon/metrics/testing/fake-analytics-engine-v4.ts",
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

/**
 * Exact files allowed to name a retired AE dataset (`turbopanel_server_metrics`
 * / `turbopanel_server_telemetry`) as historical rationale for why the
 * current dataset got a new name. Deliberately its own narrow list — the
 * broad `turbopanel/src/daemon/metrics/backends/cloudflare/` prefix above
 * exists only for the ClickHouse-dialect call-outs and must not also
 * blanket-allow retired dataset names across every file in that directory
 * (e.g. `sql-api.ts`, `store.ts`). Extend this list only for genuine
 * historical-rationale call-outs, never for metrics plumbing.
 */
export const RETIRED_DATASET_ALLOWED_PATHS = [
  "turbopaneld/scripts/check-metrics-legacy.ts",
  "turbopaneld/scripts/check-metrics-legacy.test.ts",
  "turbopanel/src/daemon/metrics/backends/cloudflare/field-map.ts",
  "turbopanel/src/daemon/metrics/AGENTS.md",
  "website/docs/architecture/server-metrics.mdx",
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

/**
 * AE v4 physical column literal or the raw sentinel value, as real code (not
 * doc prose). Deliberately does not match the exported
 * `AE_V4_MISSING_METRIC_SENTINEL` *symbol* — importing that constant to
 * compare against (rather than inlining its `-1e308` value) is always fine
 * anywhere; this rule only confines the raw literal and hardcoded column
 * names, never the symbol.
 */
export const AE_V4_TOKEN_PATTERN =
  /(["'`])(double|blob)\d{1,2}\1|\.(double|blob)\d{1,2}\b|-1e308/;

/**
 * v3-only symbols that must never appear as real code: `MetricPart` /
 * `HOST_METRIC_KEYS`, plus the v3 wire field `parts` anchored to
 * property-access (`sample.parts`) or field-declaration (`parts:` /
 * `parts?:`) shapes so the bare English word "parts" elsewhere never
 * false-positives.
 */
export const V3_SYMBOL_PATTERN =
  /\bMetricPart\b|\bHOST_METRIC_KEYS\b|\.parts\b|\bparts\??\s*:/;

/** Matches a `*-v4.ts` / `*-v4.test.ts` / `*-v4.deno.test.ts` file (basename only). */
export const V4_SUFFIXED_FILE_PATTERN = /-v4(\.deno)?\.test\.ts$|-v4\.ts$/;

/**
 * turbopanel-side metrics-contract-facing files outside `src/daemon/metrics/`
 * that must stay just as backend-agnostic as a v4-suffixed file inside it —
 * `V3_SYMBOL_PATTERN` applies to these regardless of filename suffix. Mirrors
 * `turbopanel/scripts/check-v4-boundaries.mjs`'s `EXTRA_SURFACE_DIRS` /
 * `EXTRA_SURFACE_FILES`. Exact `turbopanel/`-scoped paths — `turbopanel/src`
 * is not scanned wholesale for this the way `/metrics/` paths are, since
 * `parts` is too common a word/property name elsewhere in that tree.
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
  // Topology/SlotMapping records: `field-map-v4.ts` derives its
  // identity-addressed page ordering (`gpuPageOrder` / `blockPageOrder` /
  // `filesystemPageOrder` / `hardwareSignalPageOrder`) from these, so they
  // sit right next to the backend-private paging concept even though they
  // are themselves backend-neutral (`SlotMapping` is computed once by the
  // ingest route and handed to whichever backend is active). Mirrors
  // turbopanel/scripts/check-v4-boundaries.mjs's EXTRA_SURFACE_FILES.
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
 * Backend-private v4 paged-entity-series "page identity" symbols — blob9's
 * page index and blob10's comma-joined page identity list
 * (`AE_V4_BLOB_PAGE_INDEX`, `AE_V4_BLOB_SOURCE_OR_IDENTITY_INDEX`) and the
 * SQL predicate built from them (`entityIdInPageIdentityPredicateV4`). Must
 * never appear as real code outside `backends/cloudflare/`.
 */
export const PAGE_IDENTIFIER_PATTERN =
  /\bAE_V4_BLOB_PAGE_INDEX\b|\bAE_V4_BLOB_SOURCE_OR_IDENTITY_INDEX\b|\bentityIdInPageIdentityPredicateV4\b|\bsplitPageIdentityV4\b/;

/**
 * Exact `turbopanel/`-scoped paths permitted to reference the page-identifier
 * symbols outside `backends/cloudflare/`.
 */
export const PAGE_IDENTIFIER_ALLOWED_PATHS = new Set([
  // Daemon end-to-end ingest-route test: asserts on the actual AE row shape
  // (`blobs[...]`) written by CloudflareAnalyticsEngineServerMetricsStoreV4,
  // so it necessarily reaches into the backend-private blob layout directly
  // rather than through a query-side abstraction. Narrow, intentional.
  "turbopanel/src/daemon/api-routes.test.ts",
]);

/**
 * Exact `turbopanel/`-scoped paths permitted to reference v3 symbols
 * (`V3_SYMBOL_PATTERN`) inside a v4-suffixed file.
 */
export const V3_SYMBOL_IN_V4_FILE_ALLOWED_PATHS = new Set([
  // Both construct a `legacyV3Raw()` fixture (a retired v3 wire shape,
  // `parts: [...]` included) specifically to assert that the v4 validator
  // *rejects* it — the v3 shape is the fixture under test, not a real v4
  // dependency on v3's `parts` model.
  "turbopanel/src/daemon/metrics/validation-v4.test.ts",
  "turbopanel/src/daemon/metrics/validation-v4.deno.test.ts",
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
 * v4 boundary failures for one `.ts` file — invariants 1 and 2 in the
 * module doc comment. Never applied to non-`.ts` files (doc/config files may
 * legitimately discuss these tokens in prose). In scope for either of two
 * reasons: the path sits under a `/metrics/` directory — mirroring
 * `turbopanel/scripts/check-v4-boundaries.mjs`'s own `src/daemon/metrics`
 * scan root, so a token match in unrelated UI/app code (this script also
 * scans `ui/src`, `dev/src`, etc.) is never a false positive here — or the
 * path is one of the explicit `METRICS_CONTRACT_SURFACE_*` surfaces outside
 * the metrics tree, where the v3-symbol ban applies regardless of filename
 * suffix (those surfaces must stay backend-agnostic in general, not merely
 * v4-agnostic).
 */
export function collectV4BoundaryFailures(
  scoped: string,
  text: string,
): string[] {
  if (!scoped.endsWith(".ts")) return [];
  const inMetricsPath = scoped.includes("/metrics/");
  const isContractSurface = isMetricsContractSurface(scoped);
  if (!inMetricsPath && !isContractSurface) return [];

  const scanForAeTokens = isContractSurface ||
    (inMetricsPath && !isUnderCloudflareBackend(scoped));
  const isV4SuffixedInMetrics = inMetricsPath &&
    V4_SUFFIXED_FILE_PATTERN.test(scoped.split("/").pop() ?? scoped) &&
    !V3_SYMBOL_IN_V4_FILE_ALLOWED_PATHS.has(scoped);
  const scanForV3Symbols = isV4SuffixedInMetrics || isContractSurface;
  if (!scanForAeTokens && !scanForV3Symbols) return [];

  const failures: string[] = [];
  text.split("\n").forEach((line, i) => {
    if (isCommentLine(line)) return;
    if (scanForAeTokens) {
      const match = AE_V4_TOKEN_PATTERN.exec(line);
      if (match) {
        failures.push(
          `${scoped}:${i + 1} references AE v4 physical token "${
            match[0]
          }" outside backends/cloudflare/`,
        );
      }
    }
    if (scanForV3Symbols) {
      const match = V3_SYMBOL_PATTERN.exec(line);
      if (match) {
        failures.push(
          `${scoped}:${i + 1} references v3 symbol "${match[0]}" in ${
            isContractSurface
              ? "a metrics-contract surface that must stay backend-agnostic"
              : "a v4-only file"
          }`,
        );
      }
    }
  });
  return failures;
}

/**
 * Page-identifier boundary failures for one `.ts` file — invariant 3 in the
 * module doc comment. Scanned across every `.ts` file (not gated to
 * `/metrics/` paths, unlike {@link collectV4BoundaryFailures}) since
 * `PAGE_IDENTIFIER_PATTERN`'s symbol names are unique enough to carry no
 * false-positive risk, and the real leak this rule exists to catch
 * (`turbopanel/src/daemon/api-routes.test.ts`) lives outside every other
 * surface this guard scopes by path.
 */
export function collectV4PageIdentifierFailures(
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
        } references backend-private v4 page-identifier symbol "${
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
    ...collectV4BoundaryFailures(scoped, text),
    ...collectV4PageIdentifierFailures(scoped, text),
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
        "Tabix GUI are retired, and so are the `turbopanel_server_metrics` / " +
        "`turbopanel_server_telemetry` AE dataset names. Only managed-database-" +
        "engine code paths may name the `clickhouse` catalog engine, and only " +
        "the files already listed in RETIRED_DATASET_ALLOWED_PATHS may name a " +
        "retired dataset as history; extend that list in this script only for " +
        "such cases, never for metrics plumbing. AE v4 positional tokens " +
        "(double<N>/blob<N>/-1e308) must stay confined to backends/cloudflare/ " +
        "— always derive columns through field-map-v4.ts. v4-suffixed files and " +
        "metrics-contract surfaces outside the metrics tree must never reference " +
        "v3-only symbols (MetricPart, HOST_METRIC_KEYS, the v3 `parts` field) as " +
        "real code. The v4 page-identifier symbols (AE_V4_BLOB_PAGE_INDEX, " +
        "AE_V4_BLOB_SOURCE_OR_IDENTITY_INDEX, entityIdInPageIdentityPredicateV4, " +
        "splitPageIdentityV4) are backend-private and must stay confined to " +
        "backends/cloudflare/ as well.",
    );
    exit(1);
    return;
  }
  log("Metrics-legacy check passed: no retired metrics references found.");
}

if (import.meta.main) {
  reportMetricsLegacyFailures(await runMetricsLegacyCheck());
}
