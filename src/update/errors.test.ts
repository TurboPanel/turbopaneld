import { assertEquals } from "@std/assert";
import {
  ChecksumMismatchError,
  MalformedManifestError,
  MissingArtifactError,
  MissingChannelError,
  UnsupportedAppError,
  UnsupportedPlatformError,
  UnsupportedSchemaVersionError,
} from "./errors.ts";

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno);

test("update error classes set name and message", () => {
  const cases = [
    [new UnsupportedAppError("app"), "UnsupportedAppError", "app"],
    [new MissingChannelError("channel"), "MissingChannelError", "channel"],
    [
      new UnsupportedSchemaVersionError("schema"),
      "UnsupportedSchemaVersionError",
      "schema",
    ],
    [
      new MalformedManifestError("manifest"),
      "MalformedManifestError",
      "manifest",
    ],
    [
      new UnsupportedPlatformError("platform"),
      "UnsupportedPlatformError",
      "platform",
    ],
    [new MissingArtifactError("artifact"), "MissingArtifactError", "artifact"],
    [
      new ChecksumMismatchError("checksum"),
      "ChecksumMismatchError",
      "checksum",
    ],
  ] as const;

  for (const [error, name, message] of cases) {
    assertEquals(error.name, name);
    assertEquals(error.message, message);
    assertEquals(error instanceof Error, true);
  }
});
