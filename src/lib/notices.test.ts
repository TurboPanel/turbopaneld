import { assertEquals, assertStringIncludes } from "@std/assert";
import { describe, it } from "@std/testing/bdd";
import {
  attachLicensesFromMap,
  attachNoticeText,
  authorToCopyright,
  classifyLicense,
  defaultLicenseForPackageName,
  evaluateLicensePolicy,
  fillMissingLicenses,
  fingerprintCommentValue,
  formatPolicyFailures,
  mergeNoticePackages,
  type NoticePackage,
  noticesAreCurrent,
  packagesFromDenoLock,
  packagesFromNpmLockfile,
  packagesFromOrchestrationPins,
  packagesFromPnpmLicenses,
  packagesFromPodfileLock,
  pnpmLicenseKeys,
  pnpmPackagePaths,
  renderThirdPartyNotices,
  sortNoticePackages,
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
});

function noticeKey(row: NoticePackage): string {
  return `${row.name}@${row.version}`;
}
