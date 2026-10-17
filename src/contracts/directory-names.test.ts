import { assertEquals, assertThrows } from "@std/assert";
import {
  COLLISION_SUFFIX_MAX,
  COLLISION_SUFFIX_MIN,
  COMMON_SCOPE,
  DEFAULT_NAME_CUT_LENGTH,
  DEFAULT_NAME_HASH_LENGTH,
  defaultFolderNameFromDomain,
  domainToAscii,
  ENVIRONMENT_NAME_MAX_LENGTH,
  ENVIRONMENT_NAME_RE,
  firstFreeFolderName,
  FOLDER_NAME_MAX_LENGTH,
  FOLDER_NAME_RE,
  folderHostPath,
  folderJailPath,
  folderRefParts,
  isPathId,
  isReservedScopeName,
  isSingleWordTableName,
  isValidEnvironmentName,
  isValidFolderName,
  isValidOwnerName,
  isValidProjectSlug,
  isValidScope,
  OWNER_NAME_MAX_LENGTH,
  OWNER_NAME_RE,
  OWNER_RESERVED_PREFIXES,
  OWNER_RESERVED_SUFFIX,
  parseFolderRef,
  parseFolderRefParts,
  PATH_ID_RE,
  PROJECT_SLUG_MAX_LENGTH,
  PROJECT_SLUG_RE,
  RESERVED_SCOPE_NAMES,
  sha256Hex,
  TABLE_NAME_RE,
  withCollisionSuffix,
} from "./directory-names.ts";

// layout-vectors.json is byte-identical in the control plane and the daemon
// (check:contract-drift compares them), so both repos run the same table.
type Valid = { value: string; valid: boolean };
type Vectors = {
  rules: Record<string, unknown>;
  owner: Array<{ value: string; shape: boolean; valid: boolean }>;
  environment: Valid[];
  scope: Valid[];
  folderName: Valid[];
  projectSlug: Valid[];
  pathId: Valid[];
  tableName: Valid[];
  sha256: Array<{ input: string; hex: string }>;
  defaultNames: Array<
    { input: string; ascii: string | null; name: string | null }
  >;
  collisionSuffix: Array<{ base: string; n: number; name: string }>;
  badCollisionSuffix: Array<{ base: string; n: number }>;
  firstFree: Array<
    {
      base: string;
      taken: string[];
      takenThrough: number;
      result: string | null;
    }
  >;
  folderRefs: Array<{
    ref: {
      owner: string;
      scope: string;
      kind: "service" | "volume";
      slug: string;
    };
    jail: string;
    host: string;
  }>;
  badFolderRefs: Array<{ why: string; ref: unknown }>;
};

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}; Sonar only recognises `test()`.
 */
const test = Deno.test.bind(Deno);

const vectors = JSON.parse(
  Deno.readTextFileSync(new URL("./layout-vectors.json", import.meta.url)),
) as Vectors;

function table(rows: Valid[], check: (value: string) => boolean): void {
  assertEquals(rows.length > 5, true);
  for (const row of rows) {
    assertEquals(check(row.value), row.valid, JSON.stringify(row.value));
  }
}

test("keeps the rules in step with the shared data file", () => {
  assertEquals(
    {
      ownerNameRe: OWNER_NAME_RE.source,
      ownerNameMaxLength: OWNER_NAME_MAX_LENGTH,
      environmentNameRe: ENVIRONMENT_NAME_RE.source,
      environmentNameMaxLength: ENVIRONMENT_NAME_MAX_LENGTH,
      folderNameRe: FOLDER_NAME_RE.source,
      folderNameMaxLength: FOLDER_NAME_MAX_LENGTH,
      projectSlugRe: PROJECT_SLUG_RE.source,
      projectSlugMaxLength: PROJECT_SLUG_MAX_LENGTH,
      pathIdRe: PATH_ID_RE.source,
      tableNameRe: TABLE_NAME_RE.source,
      commonScope: COMMON_SCOPE,
      reservedScopeNames: [...RESERVED_SCOPE_NAMES],
      ownerReservedPrefixes: [...OWNER_RESERVED_PREFIXES],
      ownerReservedSuffix: OWNER_RESERVED_SUFFIX,
      defaultNameCutLength: DEFAULT_NAME_CUT_LENGTH,
      defaultNameHashLength: DEFAULT_NAME_HASH_LENGTH,
      collisionSuffixMin: COLLISION_SUFFIX_MIN,
      collisionSuffixMax: COLLISION_SUFFIX_MAX,
    },
    vectors.rules,
  );
});

test("checks the owner shape rule", () => {
  for (const row of vectors.owner) {
    assertEquals(
      isValidOwnerName(row.value),
      row.shape,
      JSON.stringify(row.value),
    );
  }
});

test("checks environment, scope, folder, project slug, id and table names", () => {
  table(vectors.environment, isValidEnvironmentName);
  table(vectors.scope, isValidScope);
  table(vectors.folderName, isValidFolderName);
  table(vectors.projectSlug, isValidProjectSlug);
  table(vectors.pathId, isPathId);
  table(vectors.tableName, isSingleWordTableName);
});

test("keeps common out of the environment names but in the scopes", () => {
  assertEquals(isValidEnvironmentName("common"), false);
  assertEquals(isValidScope("common"), true);
  assertEquals(isReservedScopeName("common"), true);
  for (const name of RESERVED_SCOPE_NAMES) {
    assertEquals(isValidEnvironmentName(name), false, name);
  }
});

test("rejects values that are not strings", () => {
  for (const value of [undefined, null, 1, {}, []]) {
    assertEquals(isValidOwnerName(value), false);
    assertEquals(isValidEnvironmentName(value), false);
    assertEquals(isValidScope(value), false);
    assertEquals(isValidFolderName(value), false);
    assertEquals(isValidProjectSlug(value), false);
    assertEquals(isPathId(value), false);
    assertEquals(isSingleWordTableName(value), false);
  }
});

test("hashes like SHA-256", () => {
  for (const row of vectors.sha256) assertEquals(sha256Hex(row.input), row.hex);
});

test("builds the default folder name from a domain", () => {
  for (const row of vectors.defaultNames) {
    assertEquals(
      domainToAscii(row.input),
      row.ascii,
      JSON.stringify(row.input),
    );
    assertEquals(
      defaultFolderNameFromDomain(row.input),
      row.name,
      JSON.stringify(row.input),
    );
    if (row.name !== null) {
      assertEquals(isValidFolderName(row.name), true, row.name);
      assertEquals(row.name.length <= FOLDER_NAME_MAX_LENGTH, true);
    }
  }
});

test("adds a collision suffix and finds the first free name", () => {
  for (const row of vectors.collisionSuffix) {
    assertEquals(withCollisionSuffix(row.base, row.n), row.name);
  }
  for (const row of vectors.badCollisionSuffix) {
    assertThrows(() => withCollisionSuffix(row.base, row.n), RangeError);
  }
  for (const row of vectors.firstFree) {
    const taken = new Set(row.taken);
    for (let n = 2; n <= row.takenThrough; n += 1) {
      taken.add(`${row.base}-${n}`);
    }
    assertEquals(
      firstFreeFolderName(row.base, (name) => taken.has(name)),
      row.result,
    );
  }
});

test("turns a folder reference into a jail path and a host path", () => {
  for (const row of vectors.folderRefs) {
    assertEquals(parseFolderRef(row.ref), row.ref);
    assertEquals(folderJailPath(row.ref), row.jail);
    assertEquals(folderHostPath("/srv/users", row.ref), row.host);
    const parts = folderRefParts(row.ref);
    assertEquals(parseFolderRefParts(parts, row.ref.kind), row.ref);
  }
  for (const root of ["", "srv/users", "/", "/srv/users/"]) {
    assertThrows(
      () => folderHostPath(root, vectors.folderRefs[0].ref),
      TypeError,
    );
  }
});

test("refuses a bad folder reference", () => {
  for (const row of vectors.badFolderRefs) {
    assertThrows(() => parseFolderRef(row.ref), TypeError, undefined, row.why);
  }
  const good = vectors.folderRefs[0].ref;
  assertThrows(() =>
    parseFolderRefParts({ ...folderRefParts(good), kind: "service" }, "service")
  );
  assertThrows(() => parseFolderRefParts({ owner: "alice" }, "volume"));
});
