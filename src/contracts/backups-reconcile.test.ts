import { assertEquals, assertThrows } from "@std/assert";
import {
  type BackupPolicyWireEntry,
  parseBackupsReconcilePayload,
  parseBackupsReconcileResult,
  parseManagedRestorePayload,
} from "./commands-contracts.ts";

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno);

const POLICY_A = "0192f0a4-1c2b-7d3e-8f40-5a6b7c8d9e01";
const POLICY_B = "0192f0a4-1c2b-7d3e-8f40-5a6b7c8d9e02";
const MANAGED_ID = "0192f0a4-1c2b-7d3e-8f40-5a6b7c8d9e03";
const COPY_ID = "0192f0a4-1c2b-7d3e-8f40-5a6b7c8d9e04";

const managedEntry: BackupPolicyWireEntry = {
  policyId: POLICY_A,
  targetKind: "managed",
  managedId: MANAGED_ID,
  engine: "postgres",
  artifactExtension: "dump",
  onCalendar: "*-*-* 03:00:00 Europe/Berlin",
  retentionKeep: 7,
  enabled: true,
};

const copyEntry: BackupPolicyWireEntry = {
  policyId: POLICY_B,
  targetKind: "copy",
  copyId: COPY_ID,
  copyProvider: "docker",
  volumeName: "shop_uploads",
  onCalendar: "hourly",
  retentionKeep: 24,
  enabled: false,
};

test("server.backups.reconcile accepts managed and copy entries as the complete set", () => {
  assertEquals(
    parseBackupsReconcilePayload({ policies: [managedEntry, copyEntry] }),
    { policies: [managedEntry, copyEntry] },
  );
});

test("server.backups.reconcile refuses a set that names one policy twice", () => {
  assertThrows(
    () =>
      parseBackupsReconcilePayload({ policies: [managedEntry, managedEntry] }),
    Error,
    "more than once",
  );
});

test("server.backups.reconcile refuses ids a unit name could not carry", () => {
  for (const policyId of [POLICY_A.toUpperCase(), "not-a-uuid"]) {
    assertThrows(
      () =>
        parseBackupsReconcilePayload({
          policies: [{ ...managedEntry, policyId }],
        }),
      Error,
      "Invalid backup policy entry",
    );
  }
});

test("server.backups.reconcile refuses anything structural in onCalendar", () => {
  for (
    const onCalendar of [
      "daily\nExecStart=/bin/sh",
      'daily"',
      "",
      "x".repeat(201),
    ]
  ) {
    assertThrows(
      () =>
        parseBackupsReconcilePayload({
          policies: [{ ...managedEntry, onCalendar }],
        }),
      Error,
      "Invalid backup policy entry",
    );
  }
});

test("server.backups.reconcile bounds retentionKeep and needs a boolean enabled", () => {
  for (const retentionKeep of [0, 101, 1.5, "7"]) {
    assertThrows(
      () =>
        parseBackupsReconcilePayload({
          policies: [{ ...managedEntry, retentionKeep }],
        }),
      Error,
      "Invalid backup policy entry",
    );
  }
  assertThrows(
    () =>
      parseBackupsReconcilePayload({
        policies: [{ ...managedEntry, enabled: "yes" }],
      }),
    Error,
    "Invalid backup policy entry",
  );
});

test("server.backups.reconcile needs exactly the target its kind names", () => {
  assertThrows(
    () =>
      parseBackupsReconcilePayload({
        policies: [{ ...managedEntry, copyId: COPY_ID }],
      }),
    Error,
    "managed target",
  );
  const { engine: _engine, ...withoutEngine } = managedEntry;
  assertThrows(
    () => parseBackupsReconcilePayload({ policies: [withoutEngine] }),
    Error,
    "managed target",
  );
  assertThrows(
    () =>
      parseBackupsReconcilePayload({
        policies: [{ ...copyEntry, managedId: MANAGED_ID }],
      }),
    Error,
    "copy target",
  );
  assertThrows(
    () =>
      parseBackupsReconcilePayload({
        policies: [{ ...copyEntry, targetKind: "volume" }],
      }),
    Error,
    "Invalid backup policy entry",
  );
});

test("server.backups.reconcile copy entries name exactly one safe source", () => {
  const pathEntry: BackupPolicyWireEntry = {
    policyId: POLICY_B,
    targetKind: "copy",
    copyId: COPY_ID,
    copyProvider: "path",
    hostPath: "/srv/users/shop/volumes/uploads",
    onCalendar: "hourly",
    retentionKeep: 24,
    enabled: true,
  };
  assertEquals(
    parseBackupsReconcilePayload({ policies: [pathEntry] }),
    { policies: [pathEntry] },
  );
  const defaultPath: BackupPolicyWireEntry = {
    policyId: POLICY_B,
    targetKind: "copy",
    copyId: COPY_ID,
    copyProvider: "path",
    organizationId: MANAGED_ID,
    storageId: POLICY_A,
    onCalendar: "hourly",
    retentionKeep: 24,
    enabled: true,
  };
  assertEquals(
    parseBackupsReconcilePayload({ policies: [defaultPath] }).policies[0],
    defaultPath,
  );
  for (
    const bad of [
      { ...copyEntry, volumeName: undefined },
      { ...copyEntry, volumeName: "bad name" },
      { ...copyEntry, copyProvider: "nfs" },
      { ...copyEntry, hostPath: "/srv/users/x" },
      { ...pathEntry, hostPath: "/srv/users/../etc" },
      { ...pathEntry, hostPath: "srv/users/x" },
      { ...pathEntry, hostPath: undefined },
      { ...managedEntry, copyProvider: "docker" },
    ]
  ) {
    assertThrows(() => parseBackupsReconcilePayload({ policies: [bad] }));
  }
});

test("server.backups.reconcile refuses a malformed or oversized payload", () => {
  assertThrows(
    () => parseBackupsReconcilePayload(null),
    Error,
    "Invalid backups reconcile payload",
  );
  const tooMany = Array.from({ length: 501 }, () => copyEntry);
  assertThrows(
    () => parseBackupsReconcilePayload({ policies: tooMany }),
    TypeError,
    "at most 500",
  );
});

test("server.backups.reconcile result round-trips and refuses bad entries", () => {
  const result = {
    policiesApplied: 2,
    unitsChanged: [POLICY_A],
    unitsRemoved: [],
    nextRuns: [
      { policyId: POLICY_A, nextRunAt: "2026-10-01T01:00:00.000Z" },
      { policyId: POLICY_B },
    ],
    warnings: [],
  };
  assertEquals(parseBackupsReconcileResult(result), result);
  assertThrows(
    () => parseBackupsReconcileResult({ ...result, policiesApplied: -1 }),
    TypeError,
    "policiesApplied",
  );
  assertThrows(
    () =>
      parseBackupsReconcileResult({
        ...result,
        nextRuns: [{ policyId: POLICY_A, nextRunAt: "soon" }],
      }),
    Error,
    "nextRunAt",
  );
});

test("managed.restore carries an optional policy id for a scheduled artifact", () => {
  const restore = {
    managedId: MANAGED_ID,
    engine: "postgres",
    backupId: "bk_0123abcd",
    artifactExtension: "dump",
    checksum: "a".repeat(64),
  };
  assertEquals(parseManagedRestorePayload(restore).policyId, undefined);
  assertEquals(
    parseManagedRestorePayload({ ...restore, policyId: POLICY_A }).policyId,
    POLICY_A,
  );
  assertThrows(
    () => parseManagedRestorePayload({ ...restore, policyId: "not-a-uuid" }),
    Error,
    "policyId",
  );
});
