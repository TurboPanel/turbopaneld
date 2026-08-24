import { assertEquals, assertThrows } from "@std/assert";
import {
  railpackCacheDir,
  railpackFrontendDigestPath,
  railpackFrontendLayoutDir,
  railpackImageTag,
} from "./railpack-build.ts";

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno);

test("railpackImageTag namespaces the service and tags the release", () => {
  assertEquals(
    railpackImageTag("11111111-2222-3333-4444-555555555555", "rel-42"),
    "turbopanel-app/11111111-2222-3333-4444-555555555555:rel-42",
  );
});

test("railpackImageTag folds a compose service name into a docker repository", () => {
  // The release engine's service segment may be a compose service name, which
  // docker repository names cannot carry verbatim: they are lowercase-only, and
  // `_` `.` `-` are the only separators allowed between alphanumerics.
  assertEquals(
    railpackImageTag("Web_API", "rel-1"),
    "turbopanel-app/web_api:rel-1",
  );
  assertEquals(
    railpackImageTag("web:api+v2", "rel-1"),
    "turbopanel-app/web-api-v2:rel-1",
  );
});

test("railpackImageTag refuses a serviceId with no usable repository", () => {
  assertThrows(() => railpackImageTag("___", "rel-1"));
});

test("railpackCacheDir isolates one project's layers from another's", () => {
  const layout = { daemonStateDir: "/var/lib/turbopanel" };
  const a = railpackCacheDir(layout, "project-a");
  const b = railpackCacheDir(layout, "project-b");
  assertEquals(
    a,
    "/var/lib/turbopanel/release-build/buildkit-cache/project-a",
  );
  assertEquals(a === b, false);
});

test("railpackCacheDir refuses a traversal in the project segment", () => {
  assertThrows(() =>
    railpackCacheDir({ daemonStateDir: "/var/lib/turbopanel" }, "../../etc")
  );
});

test("the gateway frontend resolves inside the vendored runtime tree", () => {
  // The build lane may never name a registry: `--opt source=` addresses this
  // directory by the digest recorded next to it, so a repointed upstream tag
  // cannot change what a host builds.
  assertEquals(
    railpackFrontendLayoutDir("/opt/turbopanel/vendor"),
    "/opt/turbopanel/vendor/railpack-frontend/current/image",
  );
  assertEquals(
    railpackFrontendDigestPath("/opt/turbopanel/vendor"),
    "/opt/turbopanel/vendor/railpack-frontend/current/digest",
  );
});
