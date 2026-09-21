import { assertEquals, assertStringIncludes } from "@std/assert";
import { describe, it } from "@std/testing/bdd";
import {
  attachLicensesFromMap,
  attachNoticeText,
  authorToCopyright,
  classifyLicense,
  defaultLicenseForPackageName,
  enrichMissingPackageLicenses,
  evaluateLicensePolicy,
  fillMissingLicenses,
  fingerprintCommentValue,
  formatPolicyFailures,
  isDenoDevelopmentPackageName,
  mergeNoticePackages,
  nameFromJsrNpmSpec,
  type NoticePackage,
  noticesAreCurrent,
  packagesFromDenoLock,
  packagesFromNpmLockfile,
  packagesFromOrchestrationPins,
  packagesFromPnpmLicenses,
  packagesFromPnpmLockfile,
  packagesFromPodfileLock,
  parseDenoLockId,
  parsePnpmPackageId,
  pnpmLicenseKeys,
  pnpmPackagePaths,
  referencedDenoLockKeys,
  renderThirdPartyNotices,
  sortNoticePackages,
  walkDenoLockReachableKeys,
} from "./notices.ts";

const renderOpts = {
  repoLicense: "AGPL-3.0-only",
  productName: "TurboPanel Daemon",
  regenerateCommand: "deno task notices:generate",
  lockfileFingerprints: { "pnpm-lock.yaml": "sha256:abc" },
} as const;

function pkg(
  overrides: Partial<NoticePackage> & Pick<NoticePackage, "name" | "license">,
): NoticePackage {
  return {
    version: "1.0.0",
    role: "production",
    ...overrides,
  };
}

describe("packagesFromPnpmLicenses", () => {
  it("marks packages absent from the production listing as development-only", () => {
    const all = {
      MIT: [
        {
          name: "react",
          versions: ["19.2.3"],
          license: "MIT",
          author: "Meta",
          homepage: "https://react.dev",
        },
      ],
      "MPL-2.0": [
        {
          name: "@resvg/resvg-js",
          versions: ["2.6.2"],
          license: "MPL-2.0",
        },
      ],
    };
    const prod = pnpmLicenseKeys({
      MIT: [{ name: "react", versions: ["19.2.3"], license: "MIT" }],
    });
    const packages = packagesFromPnpmLicenses(all, prod);
    const resvg = packages.find((row) => row.name === "@resvg/resvg-js");
    const react = packages.find((row) => row.name === "react");
    if (!resvg || !react) {
      throw new TypeError("expected both packages");
    }
    assertEquals(resvg.role, "development");
    assertEquals(react.role, "production");
    assertEquals(react.copyright, "Meta");
  });
});

describe("packagesFromNpmLockfile", () => {
  it("treats lockfile dev:true as development-only", () => {
    const packages = packagesFromNpmLockfile({
      packages: {
        "": { name: "tool" },
        "node_modules/wrangler": {
          version: "4.124.0",
          license: "MIT",
          dev: true,
        },
        "node_modules/miniflare": {
          version: "4.0.0",
          license: "MIT",
          dev: true,
        },
      },
    });
    assertEquals(packages.every((row) => row.role === "development"), true);
    assertEquals(
      packages.map((row) => row.name).sort((a, b) => a.localeCompare(b)),
      [
        "miniflare",
        "wrangler",
      ],
    );
  });
});

describe("packagesFromPnpmLockfile", () => {
  it("marks a lockfile with only devDependencies as development-only", () => {
    const packages = packagesFromPnpmLockfile({
      importers: {
        ".": { devDependencies: { wrangler: { specifier: "^4.124.0" } } },
      },
      packages: {
        "wrangler@4.124.0": {},
        "@cloudflare/kv-asset-handler@0.5.0": {},
        "pnpm@12.3.4": {},
        "@pnpm/exe.linux-x64@12.3.4": {},
      },
    });
    assertEquals(packages.every((row) => row.role === "development"), true);
    assertEquals(
      packages.map((row) => `${row.name}@${row.version}`).sort((a, b) =>
        a.localeCompare(b)
      ),
      [
        "@cloudflare/kv-asset-handler@0.5.0",
        "wrangler@4.124.0",
      ],
    );
    assertEquals(
      packages.every((row) => row.source === "pnpm-lock.yaml"),
      true,
    );
  });

  it("skips lock ids that do not parse as name@version", () => {
    const packages = packagesFromPnpmLockfile({
      importers: { ".": { dependencies: { next: { specifier: "16.2.9" } } } },
      packages: {
        "not-an-id": {},
        "@scope/name": {},
        "next@16.2.9": {},
      },
    });
    assertEquals(packages.map((row) => `${row.name}@${row.version}`), [
      "next@16.2.9",
    ]);
  });

  it("parses scoped ids and peer-suffix keys", () => {
    const packages = packagesFromPnpmLockfile({
      importers: {
        ".": { dependencies: { next: { specifier: "16.2.9" } } },
      },
      packages: {
        "next@16.2.9(@babel/core@7.29.7)": {},
        "@babel/core@7.29.7": {},
      },
    });
    assertEquals(packages.every((row) => row.role === "production"), true);
    assertEquals(
      packages.map((row) => `${row.name}@${row.version}`).sort((a, b) =>
        a.localeCompare(b)
      ),
      [
        "@babel/core@7.29.7",
        "next@16.2.9",
      ],
    );
  });
});

describe("packagesFromDenoLock", () => {
  it("emits jsr and npm ids with caller-supplied licenses", () => {
    const packages = packagesFromDenoLock(
      {
        jsr: { "@std/assert@1.0.19": {} },
        npm: { "yaml@2.9.0": {} },
      },
      {
        "@std/assert@1.0.19": "MIT",
        "yaml@2.9.0": "ISC",
      },
    );
    assertEquals(packages, [
      {
        name: "@std/assert",
        version: "1.0.19",
        license: "MIT",
        role: "production",
        source: "deno.lock (jsr)",
      },
      {
        name: "yaml",
        version: "2.9.0",
        license: "ISC",
        role: "production",
        source: "deno.lock (npm)",
      },
    ]);
  });

  it("strips npm peer suffixes so scoped lock ids parse as name@version", () => {
    const packages = packagesFromDenoLock(
      {
        npm: {
          "@babel/helper-module-transforms@7.29.7_@babel+core@7.29.7": {},
          "semver@6.3.1": {},
        },
      },
      {
        "@babel/helper-module-transforms@7.29.7": "MIT",
        "semver@6.3.1": "ISC",
      },
    );
    assertEquals(packages, [
      {
        name: "@babel/helper-module-transforms",
        version: "7.29.7",
        license: "MIT",
        role: "production",
        source: "deno.lock (npm)",
      },
      {
        name: "semver",
        version: "6.3.1",
        license: "ISC",
        role: "production",
        source: "deno.lock (npm)",
      },
    ]);
  });

  it("keeps Deno-only npm entries when merging with a pnpm graph", () => {
    const pnpm = packagesFromPnpmLicenses(
      {
        ISC: [{ name: "yaml", versions: ["2.9.0"], license: "ISC" }],
      },
      new Set(["yaml@2.9.0"]),
    );
    const deno = packagesFromDenoLock(
      {
        npm: {
          "yaml@2.9.0": {},
          "only-in-deno@1.2.3": {},
        },
      },
      {
        "yaml@2.9.0": "ISC",
        "only-in-deno@1.2.3": "MIT",
      },
    );
    const pnpmKeys = new Set(pnpm.map((row) => `${row.name}@${row.version}`));
    const denoOnly = deno.filter((row) =>
      !pnpmKeys.has(`${row.name}@${row.version}`)
    );
    const merged = mergeNoticePackages([pnpm, denoOnly]);
    assertEquals(
      merged.map((row) => `${row.name}@${row.version}`).sort((a, b) =>
        a.localeCompare(b)
      ),
      ["only-in-deno@1.2.3", "yaml@2.9.0"],
    );
    const denoNpm = merged.find((row) => row.name === "only-in-deno");
    if (!denoNpm) throw new TypeError("expected Deno-only npm package");
    assertEquals(evaluateLicensePolicy([denoNpm]), []);
    assertEquals(
      evaluateLicensePolicy([
        { ...denoNpm, license: "GPL-3.0-only" },
      ]).map((row) => row.reason),
      ["copyleft-production"],
    );
  });

  it("classifies test tooling as development and drops stale lock keys", () => {
    const packages = packagesFromDenoLock(
      {
        specifiers: {
          "jsr:@hono/hono@^4": "4.12.23",
          "jsr:@std/testing@1": "1.0.19",
          "npm:vitest@^4": "4.1.10",
        },
        workspace: {
          dependencies: ["jsr:@hono/hono@^4", "jsr:@std/testing@1"],
          packageJson: { dependencies: ["npm:vitest@^4"] },
        },
        jsr: {
          "@hono/hono@4.12.23": {},
          "@std/testing@1.0.19": {},
        },
        npm: {
          "vitest@4.1.10": {},
          "wrangler@4.122.0": {},
          "stale-unreferenced@1.0.0": {},
        },
      },
      {
        "@hono/hono@4.12.23": "MIT",
        "@std/testing@1.0.19": "MIT",
        "vitest@4.1.10": "MIT",
        "wrangler@4.122.0": "MIT",
        "stale-unreferenced@1.0.0": "MIT",
      },
      { productionRoots: ["jsr:@hono/hono@^4"] },
    );
    assertEquals(
      packages.filter((row) => row.role === "production").map((row) =>
        row.name
      ),
      ["@hono/hono"],
    );
    assertEquals(
      packages.find((row) => row.name === "@std/testing")?.role,
      "development",
    );
    assertEquals(
      packages.find((row) => row.name === "vitest")?.role,
      "development",
    );
    assertEquals(packages.some((row) => row.name === "wrangler"), false);
    assertEquals(
      packages.some((row) => row.name === "stale-unreferenced"),
      false,
    );
  });
});

describe("packagesFromPodfileLock", () => {
  it("parses resolved CocoaPods versions", () => {
    const text = `PODS:
  - Expo (57.0.14):
    - ExpoModulesCore
  - hermes-engine (0.86.2)
`;
    const pods = packagesFromPodfileLock(text);
    assertEquals(pods.map((row) => `${row.name}@${row.version}`), [
      "Expo@57.0.14",
      "hermes-engine@0.86.2",
    ]);
    assertEquals(pods.every((row) => row.role === "native"), true);
  });
});

describe("classifyLicense", () => {
  it("allows the reviewed production classes", () => {
    for (
      const license of [
        "MIT",
        "MIT-0",
        "ISC",
        "Apache-2.0",
        "BSD-2-Clause",
        "BSD-3-Clause",
        "0BSD",
        "Unlicense",
        "OFL-1.1",
        "BlueOak-1.0.0",
        "CC0-1.0",
        "CC-BY-4.0",
        "Python-2.0",
        "AGPL-3.0-only",
        "Apache-2.0 WITH LLVM-exception",
        "MIT OR Apache-2.0",
        "(BSD-3-Clause OR MIT)",
      ]
    ) {
      assertEquals(classifyLicense(license, "production"), null);
    }
  });

  it("allows MPL-2.0 as development-only and for reviewed lightningcss production", () => {
    assertEquals(classifyLicense("MPL-2.0", "development"), null);
    assertEquals(classifyLicense("MPL-2.0", "production"), "mpl-production");
    assertEquals(
      classifyLicense("MPL-2.0", "production", "lightningcss"),
      null,
    );
    assertEquals(
      classifyLicense("MPL-2.0", "production", "lightningcss-linux-x64-gnu"),
      null,
    );
  });

  it("allows copyleft only for development-only or orchestration roles", () => {
    assertEquals(classifyLicense("LGPL-3.0-or-later", "development"), null);
    assertEquals(
      classifyLicense("LGPL-3.0-or-later", "production"),
      "copyleft-production",
    );
  });

  it("defaults @std and @tamagui package names to MIT", () => {
    assertEquals(defaultLicenseForPackageName("@std/assert"), "MIT");
    assertEquals(defaultLicenseForPackageName("@tamagui/core"), "MIT");
    assertEquals(defaultLicenseForPackageName("org/khroma"), "MIT");
    assertEquals(defaultLicenseForPackageName("react"), undefined);
  });

  it("allows GPL-3.0-or-later only for orchestration tooling", () => {
    assertEquals(classifyLicense("GPL-3.0-or-later", "orchestration"), null);
    assertEquals(
      classifyLicense("GPL-3.0-or-later", "production"),
      "copyleft-production",
    );
  });

  it("rejects AGPL production dependencies when the repository is not AGPL", () => {
    assertEquals(
      classifyLicense("AGPL-3.0-only", "production", "third-party", {
        repoLicense: "Apache-2.0",
      }),
      "copyleft-production",
    );
  });

  it("rejects unreviewed classes", () => {
    assertEquals(classifyLicense("", "production"), "missing");
    assertEquals(classifyLicense("UNKNOWN", "production"), "missing");
    assertEquals(
      classifyLicense("SEE LICENSE IN LICENSE.md", "production"),
      "see-license-in",
    );
    assertEquals(
      classifyLicense("LicenseRef-Proprietary", "production"),
      "custom",
    );
    assertEquals(
      classifyLicense("CC-BY-NC-4.0", "production"),
      "noncommercial",
    );
    assertEquals(classifyLicense("BUSL-1.1", "production"), "source-available");
    assertEquals(
      classifyLicense("LGPL-3.0-or-later", "production"),
      "copyleft-production",
    );
    assertEquals(
      classifyLicense("AGPL-3.0-or-later", "production"),
      "copyleft-production",
    );
  });

  it("requires every AND operand to be allowed", () => {
    assertEquals(classifyLicense("MIT AND ISC", "production"), null);
    assertEquals(
      classifyLicense("MIT AND GPL-3.0-only", "production"),
      "copyleft-production",
    );
  });
});

describe("evaluateLicensePolicy", () => {
  it("formats production MPL as a policy failure", () => {
    const failures = evaluateLicensePolicy([
      pkg({ name: "@resvg/resvg-js", license: "MPL-2.0", role: "production" }),
    ]);
    assertEquals(failures.length, 1);
    assertStringIncludes(formatPolicyFailures(failures), "mpl-production");
  });
});

describe("renderThirdPartyNotices", () => {
  it("states that third-party code is not relicensed and fingerprints lockfiles", () => {
    const markdown = renderThirdPartyNotices(
      [
        pkg({
          name: "react",
          license: "MIT",
          copyright: "Meta",
          homepage: "https://react.dev",
        }),
        pkg({
          name: "@resvg/resvg-js",
          version: "2.6.2",
          license: "MPL-2.0",
          role: "development",
        }),
      ],
      renderOpts,
    );
    assertStringIncludes(markdown, "are not relicensed by TurboPanel Daemon");
    assertStringIncludes(markdown, "AGPL-3.0-only");
    assertStringIncludes(markdown, "pnpm-lock.yaml sha256:abc");
    assertStringIncludes(markdown, "### react@1.0.0");
    assertStringIncludes(markdown, "Development-only dependencies");
    assertStringIncludes(markdown, "### @resvg/resvg-js@2.6.2");
    assertEquals(markdown.startsWith("# Third-party notices\n"), true);
  });

  it("complements an existing first-party NOTICE rather than replacing it", () => {
    const markdown = renderThirdPartyNotices([], {
      ...renderOpts,
      repoLicense: "Apache-2.0",
      productName: "TurboPanel Website",
      complementNoticePath: "NOTICE",
    });
    assertStringIncludes(markdown, "complements `NOTICE`");
    assertStringIncludes(markdown, "does not replace that file");
  });

  it("includes upstream NOTICE file excerpts", () => {
    const markdown = renderThirdPartyNotices(
      [
        pkg({
          name: "foo",
          license: "Apache-2.0",
          noticeText: "Copyright 2020 Example\nThis product includes...",
        }),
      ],
      renderOpts,
    );
    assertStringIncludes(markdown, "## Upstream NOTICE files");
    assertStringIncludes(markdown, "Copyright 2020 Example");
  });
});

describe("noticesAreCurrent", () => {
  it("ignores trailing whitespace and CRLF", () => {
    const generated = renderThirdPartyNotices([], renderOpts);
    assertEquals(
      noticesAreCurrent(`${generated.replaceAll("\n", "\r\n")}\n\n`, generated),
      true,
    );
    assertEquals(noticesAreCurrent(`${generated}stale`, generated), false);
  });
});

describe("helpers", () => {
  it("sorts packages by name then version", () => {
    const sorted = sortNoticePackages([
      pkg({ name: "b", version: "2.0.0", license: "MIT" }),
      pkg({ name: "a", version: "2.0.0", license: "MIT" }),
      pkg({ name: "a", version: "1.0.0", license: "MIT" }),
    ]);
    assertEquals(sorted.map((row) => noticeKey(row)), [
      "a@1.0.0",
      "a@2.0.0",
      "b@2.0.0",
    ]);
  });

  it("prefers production when merging the same coordinate", () => {
    const merged = mergeNoticePackages([
      [pkg({ name: "yaml", license: "ISC", role: "development" })],
      [pkg({ name: "yaml", license: "ISC", role: "production" })],
    ]);
    assertEquals(merged.length, 1);
    assertEquals(merged[0]?.role, "production");
  });

  it("attaches licenses from a lookup map", () => {
    const attached = attachLicensesFromMap(
      [pkg({ name: "Expo", version: "57.0.14", license: "", role: "native" })],
      { "Expo@57.0.14": "MIT" },
    );
    assertEquals(attached[0]?.license, "MIT");
  });

  it("reads author objects and fingerprints", () => {
    assertEquals(authorToCopyright({ name: "Ada" }), "Ada");
    assertEquals(authorToCopyright("  "), undefined);
    assertEquals(fingerprintCommentValue("deadbeef"), "sha256:deadbeef");
  });

  it("maps pnpm license paths and attaches NOTICE text", () => {
    const paths = pnpmPackagePaths({
      "Apache-2.0": [
        {
          name: "next",
          versions: ["16.2.9"],
          paths: ["node_modules/next"],
        },
      ],
    });
    assertEquals(paths.get("next@16.2.9"), "node_modules/next");
    const withNotice = attachNoticeText(
      pkg({ name: "next", version: "16.2.9", license: "Apache-2.0" }),
      "  Apache Next NOTICE  ",
    );
    assertEquals(withNotice.noticeText, "Apache Next NOTICE");
  });

  it("classifies orchestration pins as the reviewed GPL role", () => {
    const pins = packagesFromOrchestrationPins([
      { name: "ansible-core", version: "2.20.*", license: "GPL-3.0-or-later" },
    ]);
    assertEquals(pins[0]?.role, "orchestration");
    assertEquals(evaluateLicensePolicy(pins), []);
  });
});

describe("fillMissingLicenses", () => {
  it("looks up only empty license strings", async () => {
    const filled = await fillMissingLicenses(
      [
        pkg({ name: "yaml", license: "ISC" }),
        pkg({ name: "@std/assert", license: "" }),
      ],
      (row) =>
        Promise.resolve(row.name === "@std/assert" ? "MIT" : "SHOULD_NOT_RUN"),
    );
    assertEquals(filled[0]?.license, "ISC");
    assertEquals(filled[1]?.license, "MIT");
  });

  it("keeps the package when lookup and default both miss", async () => {
    const filled = await fillMissingLicenses(
      [pkg({ name: "unknown-pkg", license: "" })],
      () => Promise.resolve("   "),
    );
    assertEquals(filled[0]?.license, "");
  });
});

describe("enrichMissingPackageLicenses", () => {
  it("fills from resolve, then the package-name default, then leaves empty", () => {
    const rows = enrichMissingPackageLicenses(
      [
        pkg({ name: "yaml", license: "ISC" }),
        pkg({ name: "looked-up", license: "" }),
        pkg({ name: "@std/path", license: "" }),
        pkg({ name: "still-empty", license: "" }),
      ],
      (row) => row.name === "looked-up" ? " MIT " : undefined,
    );
    assertEquals(rows[0]?.license, "ISC");
    assertEquals(rows[1]?.license, "MIT");
    assertEquals(rows[2]?.license, "MIT");
    assertEquals(rows[3]?.license, "");
  });
});

describe("packagesFromPnpmLicenses edge rows", () => {
  it("skips nameless entries and blank versions", () => {
    const packages = packagesFromPnpmLicenses({
      MIT: [
        { versions: ["1.0.0"], license: "MIT" },
        { name: "keep", versions: ["", "2.0.0"], license: "MIT" },
        { name: "via-group", versions: ["3.0.0"] },
      ],
    }, new Set(["keep@2.0.0"]));
    assertEquals(
      packages.map((row) => `${row.name}@${row.version}`).sort((a, b) =>
        a.localeCompare(b)
      ),
      ["keep@2.0.0", "via-group@3.0.0"],
    );
    assertEquals(
      packages.find((row) => row.name === "keep")?.role,
      "production",
    );
    assertEquals(
      packages.find((row) => row.name === "via-group")?.license,
      "MIT",
    );
  });
});

describe("packagesFromNpmLockfile name and license fallbacks", () => {
  it("derives names from install paths and treats missing versions as skip", () => {
    const packages = packagesFromNpmLockfile({
      packages: {
        "": { name: "root" },
        "node_modules/left-pad": { version: "1.3.0" },
        "not-a-modules-path": { version: "1.0.0", license: "MIT" },
        "node_modules/": { version: "1.0.0", license: "MIT" },
        "node_modules/no-version": { license: "MIT" },
        "node_modules/explicit": {
          name: "  renamed  ",
          version: "9.0.0",
          license: 12 as unknown as string,
        },
      },
    });
    assertEquals(
      packages.map((row) => `${row.name}@${row.version}:${row.license}`).sort(
        (a, b) => a.localeCompare(b),
      ),
      ["left-pad@1.3.0:", "renamed@9.0.0:"],
    );
    assertEquals(packagesFromNpmLockfile({}), []);
  });
});

describe("parsePnpmPackageId", () => {
  it("rejects scoped ids without a version separator and empty slices", () => {
    assertEquals(parsePnpmPackageId("@noslash"), undefined);
    assertEquals(parsePnpmPackageId("@scope/name"), undefined);
    assertEquals(parsePnpmPackageId("@scope/@"), undefined);
    assertEquals(parsePnpmPackageId("name"), undefined);
    assertEquals(parsePnpmPackageId("@1.0.0"), undefined);
    assertEquals(parsePnpmPackageId("left@"), undefined);
    assertEquals(parsePnpmPackageId("next@16.2.9(peer@1)"), {
      name: "next",
      version: "16.2.9",
    });
  });
});

describe("packagesFromDenoLock remaining graph branches", () => {
  it("marks unreferenced-table development names as development without entrypoints", () => {
    const packages = packagesFromDenoLock(
      {
        npm: {
          "yaml@2.9.0": {},
          "vitest@4.1.10": {},
          "not-a-lock-id": {},
        },
      },
      { "yaml@2.9.0": "ISC", "vitest@4.1.10": "MIT" },
    );
    assertEquals(
      packages.find((row) => row.name === "yaml")?.role,
      "production",
    );
    assertEquals(
      packages.find((row) => row.name === "vitest")?.role,
      "development",
    );
    assertEquals(packages.some((row) => row.name === "not-a-lock-id"), false);
    assertEquals(isDenoDevelopmentPackageName("vitest"), true);
    assertEquals(isDenoDevelopmentPackageName("@vitest/coverage"), true);
  });

  it("resolves bare name@version specs and version-only specifier maps", () => {
    const keys = walkDenoLockReachableKeys(
      {
        specifiers: {
          "jsr:@std/path@1": "1.0.0",
          "npm:yaml@2": "2.9.0",
        },
        jsr: {
          "@std/path@1.0.0": { dependencies: ["@std/assert@1.0.19"] },
          "@std/assert@1.0.19": {},
        },
        npm: {
          "yaml@2.9.0_peer@1": { dependencies: ["semver"] },
          "semver@6.3.1": {},
        },
      },
      ["jsr:@std/path@1", "@std/assert@1.0.19", "npm:yaml@2"],
    );
    assertEquals(keys.has("@std/path@1.0.0"), true);
    assertEquals(keys.has("@std/assert@1.0.19"), true);
    assertEquals(keys.has("yaml@2.9.0"), true);
    assertEquals(keys.has("semver@6.3.1"), true);
  });

  it("finds lock rows by name when the specifier map misses", () => {
    const keys = walkDenoLockReachableKeys(
      {
        jsr: { "@std/fmt@1.0.0": {} },
        npm: { "left-pad@1.3.0": {} },
      },
      ["jsr:@std/fmt", "left-pad"],
    );
    assertEquals(keys.has("@std/fmt@1.0.0"), true);
    assertEquals(keys.has("left-pad@1.3.0"), true);
  });
});

describe("parseDenoLockId npm peer suffix that empties the version", () => {
  it("rejects a peer-only version remnant", () => {
    assertEquals(parseDenoLockId("npm", "semver@_peer@1"), undefined);
  });
});

describe("parseDenoLockId and nameFromJsrNpmSpec", () => {
  it("rejects ids without a version separator", () => {
    assertEquals(parseDenoLockId("npm", "no-version"), undefined);
    assertEquals(parseDenoLockId("jsr", "@scopeonly"), undefined);
    assertEquals(parseDenoLockId("npm", "@scope@"), undefined);
  });

  it("strips npm peer suffixes and scoped names", () => {
    assertEquals(parseDenoLockId("npm", "semver@6.3.1_peer@1"), {
      name: "semver",
      version: "6.3.1",
    });
    assertEquals(nameFromJsrNpmSpec("jsr:@std/assert@1.0.19"), "@std/assert");
    assertEquals(nameFromJsrNpmSpec("npm:yaml@2.9.0"), "yaml");
    assertEquals(nameFromJsrNpmSpec("jsr:@std/assert"), "@std/assert");
  });
});

describe("walkDenoLockReachableKeys", () => {
  it("follows unprefixed, https, and scoped jsr dependencies", () => {
    const keys = walkDenoLockReachableKeys(
      {
        specifiers: {
          "jsr:@std/assert@1": "1.0.19",
        },
        jsr: {
          "@std/assert@1.0.19": {
            dependencies: ["@std/path", "https://example.com/mod.ts", "yaml"],
          },
          "@std/path@1.0.0": {},
        },
        npm: {
          "yaml@2.9.0": {},
        },
      },
      ["jsr:@std/assert@1", "npm:missing@1", "bare"],
    );
    assertEquals(keys.has("@std/assert@1.0.19"), true);
    assertEquals(keys.has("@std/path@1.0.0"), true);
    assertEquals(keys.has("yaml@2.9.0"), true);
  });

  it("referencedDenoLockKeys falls back to every table id without workspace roots", () => {
    const keys = referencedDenoLockKeys({
      jsr: { "not-a-lock-id": {}, "@std/assert@1.0.19": {} },
      npm: { "yaml@2.9.0": {} },
    });
    assertEquals(keys.has("@std/assert@1.0.19"), true);
    assertEquals(keys.has("yaml@2.9.0"), true);
    assertEquals(keys.has("not-a-lock-id"), false);
  });
});

describe("packagesFromPodfileLock duplicates", () => {
  it("keeps the first occurrence of a name@version pair", () => {
    const pods = packagesFromPodfileLock(`PODS:
  - Expo (57.0.14)
  - Expo (57.0.14)
  - hermes-engine (0.86.2)
`);
    assertEquals(pods.map((row) => `${row.name}@${row.version}`), [
      "Expo@57.0.14",
      "hermes-engine@0.86.2",
    ]);
  });
});

describe("license policy remaining tokens", () => {
  it("allows reviewed sharp LGPL and rejects remaining copyleft families", () => {
    assertEquals(
      classifyLicense(
        "LGPL-3.0-or-later",
        "production",
        "@img/sharp-linux-x64",
      ),
      null,
    );
    assertEquals(
      classifyLicense("EUPL-1.2", "production"),
      "copyleft-production",
    );
    assertEquals(
      classifyLicense("OSL-3.0", "production"),
      "copyleft-production",
    );
    assertEquals(
      classifyLicense("CPL-1.0", "production"),
      "copyleft-production",
    );
    assertEquals(
      classifyLicense("Sleepycat", "production"),
      "copyleft-production",
    );
    assertEquals(
      classifyLicense("CDDL-1.0", "production"),
      "copyleft-production",
    );
    assertEquals(
      classifyLicense("GPL-3.0-only OR GPL-2.0-only", "production"),
      "copyleft-production",
    );
    assertEquals(classifyLicense("(MIT", "production"), "custom");
    assertEquals(classifyLicense("MIT) leftover", "production"), "custom");
  });
});

describe("render and attach remaining notice fields", () => {
  it("renders extra preamble, source, and name-keyed license maps", () => {
    const markdown = renderThirdPartyNotices(
      [
        pkg({
          name: "left-pad",
          license: "MIT",
          source: "package-lock.json",
          copyright: "Ben",
        }),
      ],
      { ...renderOpts, extraPreamble: "Bundled fonts stay under OFL." },
    );
    assertStringIncludes(markdown, "Bundled fonts stay under OFL.");
    assertStringIncludes(markdown, "- Source: package-lock.json");
    assertStringIncludes(markdown, "- Copyright: Ben");

    const attached = attachLicensesFromMap(
      [pkg({ name: "Expo", version: "1.0.0", license: "", role: "native" })],
      { Expo: "MIT" },
    );
    assertEquals(attached[0]?.license, "MIT");
    assertEquals(
      attachNoticeText(pkg({ name: "x", license: "MIT" }), "   ")
        .noticeText,
      undefined,
    );
  });

  it("keeps prior notice metadata when promoting a development row", () => {
    const merged = mergeNoticePackages([
      [pkg({
        name: "yaml",
        license: "ISC",
        role: "development",
        noticeText: "dev NOTICE",
        copyright: "Dev",
        homepage: "https://example.com",
      })],
      [pkg({ name: "yaml", license: "ISC", role: "production" })],
    ]);
    assertEquals(merged[0]?.role, "production");
    assertEquals(merged[0]?.noticeText, "dev NOTICE");
    assertEquals(merged[0]?.copyright, "Dev");
    assertEquals(merged[0]?.homepage, "https://example.com");
  });

  it("skips pnpm path rows without a name, path, or version", () => {
    const paths = pnpmPackagePaths({
      MIT: [
        { versions: ["1.0.0"], paths: ["node_modules/missing-name"] },
        { name: "no-path", versions: ["1.0.0"] },
        {
          name: "keep",
          versions: ["", "2.0.0"],
          paths: ["node_modules/keep"],
        },
      ],
    });
    assertEquals(paths.size, 1);
    assertEquals(paths.get("keep@2.0.0"), "node_modules/keep");
  });
});

function noticeKey(row: NoticePackage): string {
  return `${row.name}@${row.version}`;
}
