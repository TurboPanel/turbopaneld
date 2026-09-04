import { assertEquals } from "@std/assert";
import {
  normalizeNodePackageManagerCommand,
  resolveNativeAppRuntimeStartCommand,
} from "./node-package-manager.ts";

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno);

test("resolveNativeAppRuntimeStartCommand uses node --run for bare start scripts", () => {
  assertEquals(
    resolveNativeAppRuntimeStartCommand("pnpm start", "/opt/node/bin/node"),
    "/opt/node/bin/node --run start",
  );
  assertEquals(
    resolveNativeAppRuntimeStartCommand("yarn start", "/opt/node/bin/node"),
    "/opt/node/bin/node --run start",
  );
  assertEquals(
    resolveNativeAppRuntimeStartCommand("npm start", "/opt/node/bin/node"),
    "/opt/node/bin/node --run start",
  );
  assertEquals(
    resolveNativeAppRuntimeStartCommand(
      "corepack pnpm start",
      "/opt/node/bin/node",
    ),
    "/opt/node/bin/node --run start",
  );
});

test("resolveNativeAppRuntimeStartCommand still prefixes corepack for non-start commands", () => {
  assertEquals(
    resolveNativeAppRuntimeStartCommand(
      "pnpm run custom",
      "/opt/node/bin/node",
    ),
    "corepack pnpm run custom",
  );
});

test("normalizeNodePackageManagerCommand prefixes bare pnpm and yarn with corepack", () => {
  assertEquals(
    normalizeNodePackageManagerCommand("pnpm run build"),
    "corepack pnpm run build",
  );
  assertEquals(
    normalizeNodePackageManagerCommand("pnpm start"),
    "corepack pnpm start",
  );
  assertEquals(
    normalizeNodePackageManagerCommand("yarn run build"),
    "corepack yarn run build",
  );
  assertEquals(
    normalizeNodePackageManagerCommand("corepack pnpm run build"),
    "corepack pnpm run build",
  );
  assertEquals(
    normalizeNodePackageManagerCommand("npm run build"),
    "npm run build",
  );
});
