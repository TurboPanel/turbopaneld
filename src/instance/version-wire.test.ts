import { assertEquals } from "@std/assert";
import { DAEMON_VERSION } from "../version.ts";
import {
  ACME_ISSUE_FEATURE,
  BACKUP_S3_COPY_FEATURE,
  COMMAND_RECOVERY_FEATURE,
  compareSemver,
  CUSTOM_NODE_APP_MODE_FEATURE,
  DAEMON_FEATURE_MIN_VERSIONS,
  DAEMON_WIRE_FEATURES,
  DENO_NATIVE_APPS_FEATURE,
  DEPLOY_CANCEL_FEATURE,
  DEPLOY_HOSTINGS_ONLY_FEATURE,
  FABRIC_LAN_ROUTES_FEATURE,
  FABRIC_PEER_REPORT_FEATURE,
  FABRIC_RETAIN_KEYS_FEATURE,
  HOST_CAPACITY_FEATURE,
  instanceUnsupportedReason,
  MANAGED_BACKUP_LOGIN_FEATURE,
  MANAGED_DATA_ONLY_READWRITE_FEATURE,
  MANAGED_DATABASE_CONVERT_FEATURE,
  MANAGED_DATABASE_OWNER_FEATURE,
  MANAGED_HA_INSTANCE_FEATURE,
  MANAGED_HEALTH_FEATURE,
  MANAGED_HEALTH_REPORT_FEATURE,
  MANAGED_INGRESS_IPV6_FEATURE,
  MANAGED_LOGIN_LIMITS_FEATURE,
  MANAGED_OWNER_ROLE_FEATURE,
  MANAGED_PERMISSIONS_READ_FEATURE,
  MANAGED_REPLICA_FRESHNESS_FEATURE,
  MANAGED_SWITCHOVER_FINAL_POSITION_FEATURE,
  MIN_SUPPORTED_INSTANCE_VERSION,
  parseSemver,
  PHP_SITE_MODES_FEATURE,
  REPO_KEY_REPORT_FEATURE,
  resolveDaemonCapabilities,
  resolveInstanceCapabilities,
  resolveInstanceSupport,
  SERVER_NETWORK_CHECK_FEATURE,
  SITE_DB_BINDINGS_FEATURE,
  SITE_ENGINE_NGINX_APACHE_FEATURE,
  TLS_CAPTURE_FEATURE,
  TUNNEL_CONNECTOR_FEATURE,
  TUNNEL_FORWARDING_FEATURE,
  TUNNEL_STATUS_FEATURE,
} from "./version-wire.ts";

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno);

const CERT_SOURCES = "instance-cert-sources-per-hostname";

test("resolveInstanceSupport: at or above the floor is supported, below is unsupported, absent is unknown", () => {
  const cases: Array<{
    reported: string | undefined;
    status: "supported" | "unsupported" | "unknown";
  }> = [
    { reported: "0.1.0", status: "supported" },
    { reported: "0.4.2", status: "supported" },
    { reported: "0.1.0-rc.1", status: "unsupported" },
    { reported: "0.0.9", status: "unsupported" },
    { reported: undefined, status: "unknown" },
    { reported: "unstamped", status: "unknown" },
  ];
  for (const entry of cases) {
    assertEquals(
      resolveInstanceSupport(entry.reported).status,
      entry.status,
      String(entry.reported),
    );
  }
  assertEquals(resolveInstanceSupport(undefined), {
    status: "unknown",
    version: null,
    minVersion: MIN_SUPPORTED_INSTANCE_VERSION,
  });
  assertEquals(resolveInstanceSupport("0.0.1", "0.0.1").status, "supported");
});

test("instanceUnsupportedReason is the greppable flag and does not say parked", () => {
  const reason = instanceUnsupportedReason(resolveInstanceSupport("0.0.9"));
  assertEquals(
    reason,
    "instance-version: control plane version 0.0.9 is below the supported minimum 0.1.0; flagged — the daemon keeps reconnecting (update the control plane)",
  );
  assertEquals(reason.includes("instance-version:"), true);
});

test("the instance floor is a semver no newer than this daemon", () => {
  const floor = parseSemver(MIN_SUPPORTED_INSTANCE_VERSION);
  const mine = parseSemver(DAEMON_VERSION);
  if (!floor || !mine) throw new TypeError("unparsable floor");
  assertEquals(compareSemver(floor, mine) <= 0, true);
  // Pin. Changing it requires the Versions-on-the-wires note in `src/instance/AGENTS.md` and the control plane's AGENTS.md.
  assertEquals(MIN_SUPPORTED_INSTANCE_VERSION, "0.1.0");
});

test("capability gates: above and equal open, below and unknown stay closed", () => {
  const floors = { [CERT_SOURCES]: "0.1.1" };
  assertEquals(resolveDaemonCapabilities("0.1.2", floors)[CERT_SOURCES], true);
  assertEquals(resolveDaemonCapabilities("0.1.1", floors)[CERT_SOURCES], true);
  assertEquals(resolveDaemonCapabilities("0.1.0", floors)[CERT_SOURCES], false);
  assertEquals(
    resolveDaemonCapabilities("0.1.1-rc.1", floors)[CERT_SOURCES],
    false,
  );
  assertEquals(
    resolveDaemonCapabilities(undefined, floors)[CERT_SOURCES],
    false,
  );
  assertEquals(
    resolveDaemonCapabilities("unstamped", floors)[CERT_SOURCES],
    false,
  );
  assertEquals(
    resolveDaemonCapabilities("0.1.1")[CERT_SOURCES],
    true,
  );
  assertEquals(DAEMON_FEATURE_MIN_VERSIONS[CERT_SOURCES], "0.1.1");
  assertEquals(resolveInstanceCapabilities(undefined), {});
  assertEquals(
    resolveInstanceCapabilities("9.9.9", {
      "future-instance-feature": "9.0.0",
    })[
      "future-instance-feature"
    ],
    true,
  );
});

test("managed-health-report-v1 is an advertised wire feature and raised no floor", () => {
  assertEquals(MANAGED_HEALTH_REPORT_FEATURE, "managed-health-report-v1");
  assertEquals(
    (DAEMON_WIRE_FEATURES as readonly string[]).includes(
      MANAGED_HEALTH_REPORT_FEATURE,
    ),
    true,
  );
});

test("managed-replica-freshness-v1 is an advertised wire feature", () => {
  assertEquals(
    MANAGED_REPLICA_FRESHNESS_FEATURE,
    "managed-replica-freshness-v1",
  );
  assertEquals(
    (DAEMON_WIRE_FEATURES as readonly string[]).includes(
      MANAGED_REPLICA_FRESHNESS_FEATURE,
    ),
    true,
  );
});

test("managed-health-v1 is advertised on the wire and raised no floor", () => {
  assertEquals(MANAGED_HEALTH_FEATURE, "managed-health-v1");
  assertEquals(
    (DAEMON_WIRE_FEATURES as readonly string[]).includes(
      MANAGED_HEALTH_FEATURE,
    ),
    true,
  );
  // A new wire message is feature-gated; it never moves the version floor.
  assertEquals(MIN_SUPPORTED_INSTANCE_VERSION, "0.1.0");
});

test("managed-permissions-read-v1 is advertised and raised no floor", () => {
  assertEquals(
    MANAGED_PERMISSIONS_READ_FEATURE,
    "managed-permissions-read-v1",
  );
  assertEquals(
    (DAEMON_WIRE_FEATURES as readonly string[]).includes(
      MANAGED_PERMISSIONS_READ_FEATURE,
    ),
    true,
  );
  assertEquals(MIN_SUPPORTED_INSTANCE_VERSION, "0.1.0");
});

test("managed-owner-role-v1 is advertised and raised no floor", () => {
  assertEquals(MANAGED_OWNER_ROLE_FEATURE, "managed-owner-role-v1");
  assertEquals(DAEMON_WIRE_FEATURES.includes(MANAGED_OWNER_ROLE_FEATURE), true);
  assertEquals(MIN_SUPPORTED_INSTANCE_VERSION, "0.1.0");
});

test("managed-data-only-readwrite-v1 is advertised and raised no floor", () => {
  assertEquals(
    MANAGED_DATA_ONLY_READWRITE_FEATURE,
    "managed-data-only-readwrite-v1",
  );
  assertEquals(
    DAEMON_WIRE_FEATURES.includes(MANAGED_DATA_ONLY_READWRITE_FEATURE),
    true,
  );
  assertEquals(MIN_SUPPORTED_INSTANCE_VERSION, "0.1.0");
});

test("managed-database-owner-v1 is advertised and raised no floor", () => {
  assertEquals(MANAGED_DATABASE_OWNER_FEATURE, "managed-database-owner-v1");
  assertEquals(
    DAEMON_WIRE_FEATURES.includes(MANAGED_DATABASE_OWNER_FEATURE),
    true,
  );
  assertEquals(MIN_SUPPORTED_INSTANCE_VERSION, "0.1.0");
});

test("managed-database-convert-v1 is advertised", () => {
  assertEquals(MANAGED_DATABASE_CONVERT_FEATURE, "managed-database-convert-v1");
  assertEquals(
    DAEMON_WIRE_FEATURES.includes(MANAGED_DATABASE_CONVERT_FEATURE),
    true,
  );
});

test("tls-capture-v1 is advertised and raised no floor", () => {
  assertEquals(TLS_CAPTURE_FEATURE, "tls-capture-v1");
  assertEquals(DAEMON_WIRE_FEATURES.includes(TLS_CAPTURE_FEATURE), true);
  assertEquals(MIN_SUPPORTED_INSTANCE_VERSION, "0.1.0");
});

test("acme-issue-v1 is advertised and raised no floor", () => {
  assertEquals(ACME_ISSUE_FEATURE, "acme-issue-v1");
  assertEquals(DAEMON_WIRE_FEATURES.includes(ACME_ISSUE_FEATURE), true);
  assertEquals(MIN_SUPPORTED_INSTANCE_VERSION, "0.1.0");
});

test("managed-switchover-final-position-v1 is advertised and raised no floor", () => {
  assertEquals(
    MANAGED_SWITCHOVER_FINAL_POSITION_FEATURE,
    "managed-switchover-final-position-v1",
  );
  assertEquals(
    DAEMON_WIRE_FEATURES.includes(MANAGED_SWITCHOVER_FINAL_POSITION_FEATURE),
    true,
  );
  assertEquals(MIN_SUPPORTED_INSTANCE_VERSION, "0.1.0");
});

test("command-recovery-v1 is advertised", () => {
  assertEquals(COMMAND_RECOVERY_FEATURE, "command-recovery-v1");
  assertEquals(DAEMON_WIRE_FEATURES.includes(COMMAND_RECOVERY_FEATURE), true);
});

test("host-capacity-v1 is advertised and raised no floor", () => {
  assertEquals(HOST_CAPACITY_FEATURE, "host-capacity-v1");
  assertEquals(DAEMON_WIRE_FEATURES.includes(HOST_CAPACITY_FEATURE), true);
  assertEquals(MIN_SUPPORTED_INSTANCE_VERSION, "0.1.0");
});

test("site-engine-nginx-apache-v1 is advertised on the wire", () => {
  assertEquals(SITE_ENGINE_NGINX_APACHE_FEATURE, "site-engine-nginx-apache-v1");
  assertEquals(
    (DAEMON_WIRE_FEATURES as readonly string[]).includes(
      SITE_ENGINE_NGINX_APACHE_FEATURE,
    ),
    true,
  );
});

test("managed-ha-instance-v1 is advertised on the wire and raised no floor", () => {
  assertEquals(MANAGED_HA_INSTANCE_FEATURE, "managed-ha-instance-v1");
  assertEquals(
    (DAEMON_WIRE_FEATURES as readonly string[]).includes(
      MANAGED_HA_INSTANCE_FEATURE,
    ),
    true,
  );
  assertEquals(MIN_SUPPORTED_INSTANCE_VERSION, "0.1.0");
});

test("php-site-modes-v1 is advertised on the wire and raised no floor", () => {
  assertEquals(PHP_SITE_MODES_FEATURE, "php-site-modes-v1");
  assertEquals(
    (DAEMON_WIRE_FEATURES as readonly string[]).includes(
      PHP_SITE_MODES_FEATURE,
    ),
    true,
  );
  assertEquals(MIN_SUPPORTED_INSTANCE_VERSION, "0.1.0");
});

test("deploy-cancel-v1 is advertised on the wire and raised no floor", () => {
  assertEquals(DEPLOY_CANCEL_FEATURE, "deploy-cancel-v1");
  assertEquals(
    (DAEMON_WIRE_FEATURES as readonly string[]).includes(
      DEPLOY_CANCEL_FEATURE,
    ),
    true,
  );
  assertEquals(MIN_SUPPORTED_INSTANCE_VERSION, "0.1.0");
});

test("site-db-bindings-v1 is advertised on the wire and raised no floor", () => {
  assertEquals(SITE_DB_BINDINGS_FEATURE, "site-db-bindings-v1");
  assertEquals(
    (DAEMON_WIRE_FEATURES as readonly string[]).includes(
      SITE_DB_BINDINGS_FEATURE,
    ),
    true,
  );
  assertEquals(MIN_SUPPORTED_INSTANCE_VERSION, "0.1.0");
});

test("custom-node-app-mode-v1 is advertised and raised no floor", () => {
  assertEquals(CUSTOM_NODE_APP_MODE_FEATURE, "custom-node-app-mode-v1");
  assertEquals(
    (DAEMON_WIRE_FEATURES as readonly string[]).includes(
      CUSTOM_NODE_APP_MODE_FEATURE,
    ),
    true,
  );
  assertEquals(MIN_SUPPORTED_INSTANCE_VERSION, "0.1.0");
});

test("deno-native-apps-v1 is advertised on the wire and raised no floor", () => {
  assertEquals(DENO_NATIVE_APPS_FEATURE, "deno-native-apps-v1");
  assertEquals(
    (DAEMON_WIRE_FEATURES as readonly string[]).includes(
      DENO_NATIVE_APPS_FEATURE,
    ),
    true,
  );
  assertEquals(MIN_SUPPORTED_INSTANCE_VERSION, "0.1.0");
});

test("managed-ingress-ipv6-v1 is advertised on the wire and raised no floor", () => {
  assertEquals(MANAGED_INGRESS_IPV6_FEATURE, "managed-ingress-ipv6-v1");
  assertEquals(
    (DAEMON_WIRE_FEATURES as readonly string[]).includes(
      MANAGED_INGRESS_IPV6_FEATURE,
    ),
    true,
  );
  assertEquals(MIN_SUPPORTED_INSTANCE_VERSION, "0.1.0");
});

test("managed-login-limits-v1 is advertised on the wire and raised no floor", () => {
  assertEquals(MANAGED_LOGIN_LIMITS_FEATURE, "managed-login-limits-v1");
  assertEquals(
    (DAEMON_WIRE_FEATURES as readonly string[]).includes(
      MANAGED_LOGIN_LIMITS_FEATURE,
    ),
    true,
  );
  assertEquals(MIN_SUPPORTED_INSTANCE_VERSION, "0.1.0");
});

test("server-network-check-v1 is advertised and raised no floor", () => {
  assertEquals(SERVER_NETWORK_CHECK_FEATURE, "server-network-check-v1");
  assertEquals(
    DAEMON_WIRE_FEATURES.includes(SERVER_NETWORK_CHECK_FEATURE),
    true,
  );
  assertEquals(MIN_SUPPORTED_INSTANCE_VERSION, "0.1.0");
});

test("backup-s3-copy-v1 is advertised and raised no floor", () => {
  assertEquals(BACKUP_S3_COPY_FEATURE, "backup-s3-copy-v1");
  assertEquals(DAEMON_WIRE_FEATURES.includes(BACKUP_S3_COPY_FEATURE), true);
  assertEquals(MIN_SUPPORTED_INSTANCE_VERSION, "0.1.0");
});

test("deploy-hostings-only-v1 is advertised and raised no floor", () => {
  assertEquals(DEPLOY_HOSTINGS_ONLY_FEATURE, "deploy-hostings-only-v1");
  assertEquals(
    (DAEMON_WIRE_FEATURES as readonly string[]).includes(
      DEPLOY_HOSTINGS_ONLY_FEATURE,
    ),
    true,
  );
  assertEquals(MIN_SUPPORTED_INSTANCE_VERSION, "0.1.0");
});

test("tunnel-forwarding-v1 is advertised and raised no floor", () => {
  assertEquals(TUNNEL_FORWARDING_FEATURE, "tunnel-forwarding-v1");
  assertEquals(
    (DAEMON_WIRE_FEATURES as readonly string[]).includes(
      TUNNEL_FORWARDING_FEATURE,
    ),
    true,
  );
  assertEquals(MIN_SUPPORTED_INSTANCE_VERSION, "0.1.0");
});

test("tunnel-connector-v1 is advertised and raised no floor", () => {
  assertEquals(TUNNEL_CONNECTOR_FEATURE, "tunnel-connector-v1");
  assertEquals(
    (DAEMON_WIRE_FEATURES as readonly string[]).includes(
      TUNNEL_CONNECTOR_FEATURE,
    ),
    true,
  );
  assertEquals(MIN_SUPPORTED_INSTANCE_VERSION, "0.1.0");
});

test("managed-backup-login-v1 is advertised", () => {
  assertEquals(MANAGED_BACKUP_LOGIN_FEATURE, "managed-backup-login-v1");
  assertEquals(
    DAEMON_WIRE_FEATURES.includes(MANAGED_BACKUP_LOGIN_FEATURE),
    true,
  );
});

test("fabric-retain-keys-v1 is advertised and raised no floor", () => {
  assertEquals(FABRIC_RETAIN_KEYS_FEATURE, "fabric-retain-keys-v1");
  assertEquals(DAEMON_WIRE_FEATURES.includes(FABRIC_RETAIN_KEYS_FEATURE), true);
  assertEquals(MIN_SUPPORTED_INSTANCE_VERSION, "0.1.0");
});

test("fabric-peer-report-v1 is advertised and raised no floor", () => {
  assertEquals(FABRIC_PEER_REPORT_FEATURE, "fabric-peer-report-v1");
  assertEquals(DAEMON_WIRE_FEATURES.includes(FABRIC_PEER_REPORT_FEATURE), true);
  assertEquals(MIN_SUPPORTED_INSTANCE_VERSION, "0.1.0");
});

test("fabric-lan-routes-v1 is advertised and raised no floor", () => {
  assertEquals(FABRIC_LAN_ROUTES_FEATURE, "fabric-lan-routes-v1");
  assertEquals(DAEMON_WIRE_FEATURES.includes(FABRIC_LAN_ROUTES_FEATURE), true);
  assertEquals(MIN_SUPPORTED_INSTANCE_VERSION, "0.1.0");
});

test("repo-key-report-v1 is advertised last and raised no floor", () => {
  assertEquals(REPO_KEY_REPORT_FEATURE, "repo-key-report-v1");
  assertEquals(DAEMON_WIRE_FEATURES.at(-1), REPO_KEY_REPORT_FEATURE);
  assertEquals(MIN_SUPPORTED_INSTANCE_VERSION, "0.1.0");
});

test("tunnel-status-v1 is advertised and raised no floor", () => {
  assertEquals(TUNNEL_STATUS_FEATURE, "tunnel-status-v1");
  assertEquals(DAEMON_WIRE_FEATURES.includes(TUNNEL_STATUS_FEATURE), true);
  assertEquals(MIN_SUPPORTED_INSTANCE_VERSION, "0.1.0");
});
