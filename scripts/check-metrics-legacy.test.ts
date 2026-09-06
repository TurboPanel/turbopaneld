import { assertEquals } from "@std/assert";
import {
  collectMetricsLegacyFailures,
  collectV4BoundaryFailures,
  collectV4PageIdentifierFailures,
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

test("collectV4BoundaryFailures flags a positional AE literal outside backends/cloudflare/", () => {
  const failures = collectV4BoundaryFailures(
    "turbopanel/src/daemon/metrics/query/series-response-v4.ts",
    "const value = row.double12;\n",
  );
  assertEquals(failures.length, 1);
  assertEquals(
    failures[0],
    'turbopanel/src/daemon/metrics/query/series-response-v4.ts:1 references AE v4 physical token ".double12" outside backends/cloudflare/',
  );
});

test("collectV4BoundaryFailures flags the raw sentinel literal outside backends/cloudflare/", () => {
  const failures = collectV4BoundaryFailures(
    "turbopanel/src/daemon/metrics/query/uptime.ts",
    "const SENTINEL = -1e308;\n",
  );
  assertEquals(failures.length, 1);
});

test("collectV4BoundaryFailures allows AE positional tokens inside backends/cloudflare/", () => {
  const failures = collectV4BoundaryFailures(
    "turbopanel/src/daemon/metrics/backends/cloudflare/field-map-v4.ts",
    "doubles[embedBase] = nic0?.receiveBytesPerSecond ?? AE_V4_MISSING_METRIC_SENTINEL;\n",
  );
  assertEquals(failures, []);
});

test("collectV4BoundaryFailures allows importing the sentinel constant by name anywhere (only the raw literal/column names are confined)", () => {
  const failures = collectV4BoundaryFailures(
    "turbopanel/src/daemon/metrics/backends/duckdb/store.test.ts",
    'import { AE_V4_MISSING_METRIC_SENTINEL } from "../cloudflare/field-map-v4.ts";\n',
  );
  assertEquals(failures, []);
});

test("collectV4BoundaryFailures ignores files outside a /metrics/ path", () => {
  const failures = collectV4BoundaryFailures(
    "ui/src/components/example.ts",
    "const value = row.double12;\n",
  );
  assertEquals(failures, []);
});

test("collectV4BoundaryFailures does not flag doc-comment prose mentioning a slot name", () => {
  const failures = collectV4BoundaryFailures(
    "turbopanel/src/daemon/metrics/query/uptime.ts",
    " * slot (`double20`-equivalent) for the sample's intervalSeconds.\n",
  );
  assertEquals(failures, []);
});

test("collectV4BoundaryFailures flags a v3 symbol as real code in a v4-suffixed file", () => {
  const failures = collectV4BoundaryFailures(
    "turbopanel/src/daemon/metrics/contract-v4.ts",
    "import type { MetricPart } from './contract.ts';\n",
  );
  assertEquals(failures.length, 1);
  assertEquals(
    failures[0],
    'turbopanel/src/daemon/metrics/contract-v4.ts:1 references v3 symbol "MetricPart" in a v4-only file',
  );
});

test("collectV4BoundaryFailures does not flag doc-comment prose contrasting v4 with v3's MetricPart", () => {
  const failures = collectV4BoundaryFailures(
    "turbopanel/src/daemon/metrics/contract-v4.ts",
    " * v4 drops the v3 `MetricPart`/19-slot-per-part allowlist coupling entirely.\n",
  );
  assertEquals(failures, []);
});

test("collectV4BoundaryFailures ignores non-.ts files", () => {
  const failures = collectV4BoundaryFailures(
    "turbopanel/src/daemon/metrics/AGENTS.md",
    "MetricPart double12 -1e308\n",
  );
  assertEquals(failures, []);
});

test("collectV4BoundaryFailures flags the v3 `parts` field as real code in a v4-suffixed file", () => {
  const failures = collectV4BoundaryFailures(
    "turbopanel/src/daemon/metrics/contract-v4.ts",
    "const declared = sample.parts;\n",
  );
  assertEquals(failures.length, 1);
  assertEquals(
    failures[0],
    'turbopanel/src/daemon/metrics/contract-v4.ts:1 references v3 symbol ".parts" in a v4-only file',
  );
});

test('collectV4BoundaryFailures does not flag the bare English word "parts" elsewhere in a v4-suffixed file', () => {
  const failures = collectV4BoundaryFailures(
    "turbopanel/src/daemon/metrics/contract-v4.ts",
    "const parts = raw.split(',');\nconsole.log(parts[0]);\n",
  );
  assertEquals(failures, []);
});

test("collectV4BoundaryFailures allows the v3 `parts` fixture in the allowlisted validation-v4 legacy-rejection tests", () => {
  const failures = collectV4BoundaryFailures(
    "turbopanel/src/daemon/metrics/validation-v4.test.ts",
    '  parts: ["core", "extended"],\n',
  );
  assertEquals(failures, []);
});

test("collectV4BoundaryFailures flags a v3 symbol in a metrics-contract surface regardless of filename suffix", () => {
  const failures = collectV4BoundaryFailures(
    "turbopanel/src/daemon/openapi/metrics.ts",
    "import type { MetricPart } from '../metrics/contract.ts';\n",
  );
  assertEquals(failures.length, 1);
  assertEquals(
    failures[0],
    'turbopanel/src/daemon/openapi/metrics.ts:1 references v3 symbol "MetricPart" in a metrics-contract surface that must stay backend-agnostic',
  );
});

test("collectV4BoundaryFailures flags a v3 symbol in an exact-listed metrics-contract file", () => {
  const failures = collectV4BoundaryFailures(
    "turbopanel/src/client/servers/metrics-routes.ts",
    "const keys = HOST_METRIC_KEYS;\n",
  );
  assertEquals(failures.length, 1);
});

test("collectV4BoundaryFailures does not flag a negative-assertion string literal for `parts`", () => {
  const failures = collectV4BoundaryFailures(
    "turbopanel/src/daemon/openapi/metrics.ts",
    "  assertEquals('parts' in sample.properties, false);\n",
  );
  assertEquals(failures, []);
});

test("collectV4PageIdentifierFailures allows the allowlisted daemon end-to-end ingest-route test", () => {
  const failures = collectV4PageIdentifierFailures(
    "turbopanel/src/daemon/api-routes.test.ts",
    "  const ids = blobs[AE_V4_BLOB_SOURCE_OR_IDENTITY_INDEX];\n",
  );
  assertEquals(failures, []);
});

test("collectV4PageIdentifierFailures flags a page-identifier symbol outside backends/cloudflare/ and outside the allowlist", () => {
  const failures = collectV4PageIdentifierFailures(
    "turbopanel/src/client/servers/metrics-routes.ts",
    "  const ids = blobs[AE_V4_BLOB_SOURCE_OR_IDENTITY_INDEX];\n",
  );
  assertEquals(failures.length, 1);
  assertEquals(
    failures[0],
    'turbopanel/src/client/servers/metrics-routes.ts:1 references backend-private v4 page-identifier symbol "AE_V4_BLOB_SOURCE_OR_IDENTITY_INDEX" outside backends/cloudflare/',
  );
});

test("collectV4PageIdentifierFailures allows page-identifier symbols inside backends/cloudflare/", () => {
  const failures = collectV4PageIdentifierFailures(
    "turbopanel/src/daemon/metrics/backends/cloudflare/sql-api-v4.ts",
    "export function entityIdInPageIdentityPredicateV4(entityId: string): string {\n",
  );
  assertEquals(failures, []);
});

test("collectMetricsLegacyFailures composes v4 boundary failures with the legacy scan", () => {
  const failures = collectMetricsLegacyFailures(
    "turbopanel/src/daemon/metrics/query/series-response-v4.ts",
    "const value = row.double12;\n",
  );
  assertEquals(failures.length, 1);
  assertEquals(
    failures[0],
    'turbopanel/src/daemon/metrics/query/series-response-v4.ts:1 references AE v4 physical token ".double12" outside backends/cloudflare/',
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
