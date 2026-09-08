import { assertEquals } from "@std/assert";
import {
  collectBoundaryFailures,
  collectMetricsLegacyFailures,
  collectPageIdentifierFailures,
  isAllowedPath,
  reportMetricsLegacyFailures,
  resolveScanRoots,
  runMetricsLegacyCheck,
} from "./check-metrics-legacy.ts";

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno);

test("isAllowedPath admits only managed-engine code paths", () => {
  assertEquals(isAllowedPath("turbopaneld/src/managed/engines/index.ts"), true);
  assertEquals(
    isAllowedPath("turbopaneld/src/instance/commands/contracts.ts"),
    true,
  );
  assertEquals(isAllowedPath("turbopanel/src/lib/managed/types.ts"), true);
  assertEquals(isAllowedPath("turbopanel/src/client/openapi/managed.ts"), true);
  assertEquals(isAllowedPath("turbopanel/src/lib/db/schema.ts"), true);
  assertEquals(
    isAllowedPath("ui/src/components/org/managed/managed-version-picker.tsx"),
    true,
  );
  assertEquals(isAllowedPath("ui/src/lib/managed-services.ts"), true);
  assertEquals(
    isAllowedPath("ui/design-system/turbopanel/pages/project-create.md"),
    true,
  );
  // Metrics plumbing is never allowed back.
  assertEquals(
    isAllowedPath("turbopanel/src/daemon/metrics/backends/duckdb/store.ts"),
    false,
  );
  assertEquals(
    isAllowedPath(
      "turbopaneld/orchestration/roles/system-compose/tasks/main.yml",
    ),
    false,
  );
  assertEquals(isAllowedPath("dev/src/lib/service-urls.ts"), false);
});

test("collectMetricsLegacyFailures flags code and comments, case-insensitively", () => {
  const failures = collectMetricsLegacyFailures(
    "dev/src/lib/example.ts",
    'const url = "http://127.0.0.1:8123";\n// talks to ClickHouse\nconst gui = "Tabix";\n',
  );
  assertEquals(failures.length, 2);
  assertEquals(
    failures[0],
    'dev/src/lib/example.ts:2 references retired metrics infrastructure ("ClickHouse")',
  );
  assertEquals(
    failures[1],
    'dev/src/lib/example.ts:3 references retired metrics infrastructure ("Tabix")',
  );
});

test("collectMetricsLegacyFailures skips allowlisted managed-engine paths", () => {
  const failures = collectMetricsLegacyFailures(
    "turbopanel/src/lib/managed/types.ts",
    "export type ManagedEngine = 'clickhouse';\n",
  );
  assertEquals(failures, []);
});

test("collectMetricsLegacyFailures flags a retired AE dataset name outside the allowed prefixes", () => {
  const failures = collectMetricsLegacyFailures(
    "dev/src/lib/example.ts",
    "const dataset = 'turbopanel_server_telemetry';\n",
  );
  assertEquals(failures.length, 1);
  assertEquals(
    failures[0],
    'dev/src/lib/example.ts:1 references retired metrics infrastructure ("turbopanel_server_telemetry")',
  );
});

test("collectMetricsLegacyFailures flags a retired AE dataset name in field-map.ts (no historical-context allowlist)", () => {
  const failures = collectMetricsLegacyFailures(
    "turbopanel/src/daemon/metrics/backends/cloudflare/field-map.ts",
    "// retired: turbopanel_server_telemetry\n",
  );
  assertEquals(failures.length, 1);
  assertEquals(
    failures[0],
    'turbopanel/src/daemon/metrics/backends/cloudflare/field-map.ts:1 references retired metrics infrastructure ("turbopanel_server_telemetry")',
  );
});

test("collectMetricsLegacyFailures flags retired dataset names in website docs, wrangler.jsonc, and design-system docs", () => {
  assertEquals(
    collectMetricsLegacyFailures(
      "website/docs/architecture/server-metrics.mdx",
      "The retired v3 `turbopanel_server_host_metrics` layout.\n",
    ).length,
    1,
  );
  assertEquals(
    collectMetricsLegacyFailures(
      "turbopanel/wrangler.jsonc",
      '// Retired: SERVER_METRICS bound "turbopanel_server_host_metrics"\n',
    ).length,
    1,
  );
  assertEquals(
    collectMetricsLegacyFailures(
      "ui/design-system/turbopanel/pages/server-metrics.md",
      "dataset turbopanel_server_telemetry\n",
    ).length,
    1,
  );
});

test("collectMetricsLegacyFailures still allows a retired dataset name inside the guard script itself", () => {
  const failures = collectMetricsLegacyFailures(
    "turbopaneld/scripts/check-metrics-legacy.ts",
    "const name = 'turbopanel_server_telemetry';\n",
  );
  assertEquals(failures, []);
});

test("collectMetricsLegacyFailures flags a retired AE dataset name in another cloudflare-backend file even though clickhouse/tabix are allowed there", () => {
  const failures = collectMetricsLegacyFailures(
    "turbopanel/src/daemon/metrics/backends/cloudflare/sql-api.ts",
    "const legacyDataset = 'turbopanel_server_metrics';\n",
  );
  assertEquals(failures.length, 1);
  assertEquals(
    failures[0],
    'turbopanel/src/daemon/metrics/backends/cloudflare/sql-api.ts:1 references retired metrics infrastructure ("turbopanel_server_metrics")',
  );
});

test("collectMetricsLegacyFailures still allows a plain clickhouse reference in a cloudflare-backend file outside the narrow dataset-name allowlist", () => {
  const failures = collectMetricsLegacyFailures(
    "turbopanel/src/daemon/metrics/backends/cloudflare/store.ts",
    "// ClickHouse-compatible SQL dialect\n",
  );
  assertEquals(failures, []);
});

test("collectBoundaryFailures flags a positional AE literal outside backends/cloudflare/", () => {
  const failures = collectBoundaryFailures(
    "turbopanel/src/daemon/metrics/query/series-response.ts",
    "const value = row.double12;\n",
  );
  assertEquals(failures.length, 1);
  assertEquals(
    failures[0],
    'turbopanel/src/daemon/metrics/query/series-response.ts:1 references AE physical token ".double12" outside backends/cloudflare/',
  );
});

test("collectBoundaryFailures flags the raw sentinel literal outside backends/cloudflare/", () => {
  const failures = collectBoundaryFailures(
    "turbopanel/src/daemon/metrics/query/uptime.ts",
    "const SENTINEL = -1e308;\n",
  );
  assertEquals(failures.length, 1);
});

test("collectBoundaryFailures allows AE positional tokens inside backends/cloudflare/", () => {
  const failures = collectBoundaryFailures(
    "turbopanel/src/daemon/metrics/backends/cloudflare/field-map.ts",
    "doubles[embedBase] = nic0?.receiveBytesPerSecond ?? AE_MISSING_METRIC_SENTINEL;\n",
  );
  assertEquals(failures, []);
});

test("collectBoundaryFailures allows importing the sentinel constant by name anywhere (only the raw literal/column names are confined)", () => {
  const failures = collectBoundaryFailures(
    "turbopanel/src/daemon/metrics/backends/duckdb/store.test.ts",
    'import { AE_MISSING_METRIC_SENTINEL } from "../cloudflare/field-map.ts";\n',
  );
  assertEquals(failures, []);
});

test("collectBoundaryFailures ignores files outside a /metrics/ path", () => {
  const failures = collectBoundaryFailures(
    "ui/src/components/example.ts",
    "const value = row.double12;\n",
  );
  assertEquals(failures, []);
});

test("collectBoundaryFailures does not flag doc-comment prose mentioning a slot name", () => {
  const failures = collectBoundaryFailures(
    "turbopanel/src/daemon/metrics/query/uptime.ts",
    " * slot (`double20`-equivalent) for the sample's intervalSeconds.\n",
  );
  assertEquals(failures, []);
});

test("collectBoundaryFailures ignores non-.ts files", () => {
  const failures = collectBoundaryFailures(
    "turbopanel/src/daemon/metrics/AGENTS.md",
    "MetricPart double12 -1e308\n",
  );
  assertEquals(failures, []);
});

test("collectPageIdentifierFailures allows the allowlisted daemon end-to-end ingest-route test", () => {
  const failures = collectPageIdentifierFailures(
    "turbopanel/src/daemon/api-routes.test.ts",
    "  const ids = blobs[AE_BLOB_SOURCE_OR_IDENTITY_INDEX];\n",
  );
  assertEquals(failures, []);
});

test("collectPageIdentifierFailures flags a page-identifier symbol outside backends/cloudflare/ and outside the allowlist", () => {
  const failures = collectPageIdentifierFailures(
    "turbopanel/src/client/servers/metrics-routes.ts",
    "  const ids = blobs[AE_BLOB_SOURCE_OR_IDENTITY_INDEX];\n",
  );
  assertEquals(failures.length, 1);
  assertEquals(
    failures[0],
    'turbopanel/src/client/servers/metrics-routes.ts:1 references backend-private page-identifier symbol "AE_BLOB_SOURCE_OR_IDENTITY_INDEX" outside backends/cloudflare/',
  );
});

test("collectPageIdentifierFailures allows page-identifier symbols inside backends/cloudflare/", () => {
  const failures = collectPageIdentifierFailures(
    "turbopanel/src/daemon/metrics/backends/cloudflare/sql-api.ts",
    "export function entityIdInPageIdentityPredicate(entityId: string): string {\n",
  );
  assertEquals(failures, []);
});

test("collectMetricsLegacyFailures composes boundary failures with the legacy scan", () => {
  const failures = collectMetricsLegacyFailures(
    "turbopanel/src/daemon/metrics/query/series-response.ts",
    "const value = row.double12;\n",
  );
  assertEquals(failures.length, 1);
  assertEquals(
    failures[0],
    'turbopanel/src/daemon/metrics/query/series-response.ts:1 references AE physical token ".double12" outside backends/cloudflare/',
  );
});

test("runMetricsLegacyCheck passes on the current workspace", async () => {
  assertEquals(await runMetricsLegacyCheck(), []);
});

test("resolveScanRoots includes website docs, UI design-system, and wrangler.jsonc when those siblings exist", async () => {
  const daemonRoot = await Deno.makeTempDir({ prefix: "tp-legacy-daemon-" });
  const siblings = await Deno.makeTempDir({ prefix: "tp-legacy-siblings-" });
  try {
    await Deno.mkdir(`${daemonRoot}/src`, { recursive: true });
    await Deno.mkdir(`${siblings}/website/docs`, { recursive: true });
    await Deno.mkdir(`${siblings}/ui/design-system`, { recursive: true });
    await Deno.mkdir(`${siblings}/turbopanel`, { recursive: true });
    await Deno.writeTextFile(`${siblings}/turbopanel/wrangler.jsonc`, "{}\n");

    const roots = await resolveScanRoots(daemonRoot, siblings);
    const scopes = roots.map((root) => root.scope).sort((a, b) =>
      a.localeCompare(b)
    );
    assertEquals(scopes.includes("website/docs"), true);
    assertEquals(scopes.includes("ui/design-system"), true);
    assertEquals(scopes.includes("turbopanel/wrangler.jsonc"), true);
    assertEquals(scopes.includes("turbopaneld/src"), true);
  } finally {
    await Deno.remove(daemonRoot, { recursive: true });
    await Deno.remove(siblings, { recursive: true });
  }
});

test("reportMetricsLegacyFailures exits non-zero only on failures", () => {
  const errors: string[] = [];
  const logs: string[] = [];
  let exitCode: number | null = null;
  reportMetricsLegacyFailures(["dev/src/x.ts:1 references ..."], {
    error: (message) => errors.push(message),
    log: (message) => logs.push(message),
    exit: (code) => {
      exitCode = code;
    },
  });
  assertEquals(exitCode, 1);
  assertEquals(logs, []);

  exitCode = null;
  reportMetricsLegacyFailures([], {
    error: (message) => errors.push(message),
    log: (message) => logs.push(message),
    exit: (code) => {
      exitCode = code;
    },
  });
  assertEquals(exitCode, null);
  assertEquals(logs.length, 1);
});
