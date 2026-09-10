import { assertEquals, assertRejects, assertThrows } from "@std/assert";
import { dirname, fromFileUrl, join } from "@std/path";
import {
  collectDaemonNoticePackages,
  collectSpecifiersFromDenoInfoJson,
  lookupRegistryLicense,
  parseGalaxyRequirementsYaml,
  parseOrchestrationPins,
  parsePnpmLockYaml,
  runGenerateNotices,
  specifiersFromDenoInfo,
  workspaceProductionRoots,
} from "./generate-notices.ts";
import {
  type DenoLockfile,
  type NoticePackage,
  NOTICES_FILE_NAME,
} from "../src/lib/notices.ts";

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno);

const ROOT = dirname(dirname(fromFileUrl(import.meta.url)));

test("parseGalaxyRequirementsYaml reads quoted and unquoted name/version pins", () => {
  const pins = parseGalaxyRequirementsYaml(`
# header
collections:
  - name: ansible.posix
    version: "2.2.1"
roles:
  - name: 'geerlingguy.docker'
    version: '8.0.0'
  - name: unversioned.role
`);
  assertEquals(pins, [
    {
      name: "ansible.posix",
      version: "2.2.1",
      license: "GPL-3.0-or-later",
    },
    {
      name: "geerlingguy.docker",
      version: "8.0.0",
      license: "MIT",
    },
    {
      name: "unversioned.role",
      version: "*",
      license: "",
    },
  ]);
});

test("parseGalaxyRequirementsYaml skips blank names and non-list keys", () => {
  const pins = parseGalaxyRequirementsYaml(`
name: not-a-list-item
  - name:
    version: "1.0.0"
  - name: kept.role
    source: galaxy
`);
  assertEquals(pins, [
    { name: "kept.role", version: "*", license: "" },
  ]);
});

test({
  name: "parseOrchestrationPins reads checkout Galaxy files and pip pins",
  permissions: { read: true },
  fn() {
    const pins = parseOrchestrationPins(ROOT);
    const names = pins.map((pin) => pin.name).sort((a, b) =>
      a.localeCompare(b)
    );
    assertEquals(names.includes("ansible-core"), true);
    assertEquals(names.includes("ansible.posix"), true);
    assertEquals(names.includes("geerlingguy.docker"), true);
    const posix = pins.find((pin) => pin.name === "ansible.posix");
    const docker = pins.find((pin) => pin.name === "geerlingguy.docker");
    if (!posix || !docker) {
      throw new TypeError("expected Galaxy pins");
    }
    assertEquals(posix.version, "2.2.1");
    assertEquals(posix.license, "GPL-3.0-or-later");
    assertEquals(docker.version, "8.0.0");
    assertEquals(docker.license, "MIT");
  },
});

test({
  name: "parseOrchestrationPins treats a missing Galaxy file as no pins",
  permissions: { read: true, write: true },
  async fn() {
    const root = await Deno.makeTempDir({ prefix: "tp-galaxy-pins-" });
    try {
      await Deno.mkdir(join(root, "orchestration"));
      await Deno.writeTextFile(
        join(root, "orchestration", "requirements.txt"),
        "ansible-core==2.20.*\n",
      );
      await Deno.writeTextFile(
        join(root, "orchestration", "requirements.yml"),
        "- name: ansible.posix\n  version: 2.2.1\n",
      );
      const pins = parseOrchestrationPins(root);
      assertEquals(pins, [
        {
          name: "ansible-core",
          version: "==2.20.*",
          license: "GPL-3.0-or-later",
        },
        {
          name: "ansible.posix",
          version: "2.2.1",
          license: "GPL-3.0-or-later",
        },
      ]);
    } finally {
      await Deno.remove(root, { recursive: true });
    }
  },
});

test("parsePnpmLockYaml uses the last YAML document as the project lockfile", () => {
  const parsed = parsePnpmLockYaml(`---
lockfileVersion: '9.0'
importers:
  .:
    packageManagerDependencies:
      pnpm:
        specifier: 12.3.4
        version: 12.3.4
packages:
  pnpm@12.3.4: {}
---
lockfileVersion: '9.0'
importers:
  .:
    devDependencies:
      wrangler:
        specifier: ^4.124.0
        version: 4.124.0
packages:
  wrangler@4.124.0:
    resolution: {integrity: sha512-demo}
`);
  assertEquals(parsed.importers?.["."]?.devDependencies?.wrangler, {
    specifier: "^4.124.0",
    version: "4.124.0",
  });
  assertEquals(parsed.packages?.["wrangler@4.124.0"], {
    resolution: { integrity: "sha512-demo" },
  });
  assertEquals(parsed.packages?.["pnpm@12.3.4"], undefined);
});

test("parsePnpmLockYaml rejects a non-object project document", () => {
  assertThrows(
    () => parsePnpmLockYaml("[]"),
    TypeError,
    "generate-notices: unexpected pnpm-lock.yaml",
  );
  assertThrows(
    () => parsePnpmLockYaml("null"),
    TypeError,
    "generate-notices: unexpected pnpm-lock.yaml",
  );
});

test("parseOrchestrationPins skips comments and unmatched pip lines", () => {
  const root = Deno.makeTempDirSync({ prefix: "tp-orch-pins-skip-" });
  try {
    Deno.mkdirSync(join(root, "orchestration"));
    Deno.writeTextFileSync(
      join(root, "orchestration", "requirements.txt"),
      [
        "# comment",
        "",
        "ansible-core==2.20.*",
        "===not-a-pin",
        "ansible-compat>=1.0",
        "ansible-lint~=25.0",
      ].join("\n"),
    );
    const pins = parseOrchestrationPins(root);
    assertEquals(
      pins.map((pin) => pin.name),
      ["ansible-core", "ansible-compat", "ansible-lint"],
    );
    assertEquals(pins[1]?.license, "GPL-3.0-or-later");
    assertEquals(pins[1]?.version, ">=1.0");
  } finally {
    Deno.removeSync(root, { recursive: true });
  }
});

test("parseOrchestrationPins rethrows non-missing Galaxy file errors", () => {
  const root = Deno.makeTempDirSync({ prefix: "tp-orch-pins-dir-" });
  try {
    Deno.mkdirSync(join(root, "orchestration", "requirements.yml"), {
      recursive: true,
    });
    Deno.writeTextFileSync(
      join(root, "orchestration", "requirements.txt"),
      "ansible-core==2.20.*\n",
    );
    assertThrows(
      () => parseOrchestrationPins(root),
      Error,
    );
  } finally {
    Deno.removeSync(root, { recursive: true });
  }
});

test("workspaceProductionRoots drops empty and development package names", () => {
  const lock: DenoLockfile = {
    workspace: {
      dependencies: [
        "jsr:@std/path@1.0.0",
        "jsr:@std/testing@1.0.0",
        "npm:wrangler@4.0.0",
        "npm:",
      ],
    },
  };
  assertEquals(workspaceProductionRoots(lock), ["jsr:@std/path@1.0.0"]);
});

test("collectSpecifiersFromDenoInfoJson collects remote modules and npm packages", () => {
  const specs = collectSpecifiersFromDenoInfoJson(JSON.stringify({
    modules: [
      {
        specifier: "jsr:@std/path@1.0.0",
        dependencies: [
          { specifier: "npm:yaml@2.0.0" },
          { specifier: "./local.ts" },
        ],
      },
      { specifier: "file:///tmp/entry.ts" },
    ],
    npmPackages: {
      "yaml@2.0.0": {},
      "npm:hono@4.0.0": {},
    },
  }));
  assertEquals([...specs].sort((a, b) => a.localeCompare(b)), [
    "jsr:@std/path@1.0.0",
    "npm:hono@4.0.0",
    "npm:yaml@2.0.0",
  ]);
});

test("collectSpecifiersFromDenoInfoJson ignores malformed JSON", () => {
  const specs = collectSpecifiersFromDenoInfoJson("{not-json");
  assertEquals(specs.size, 0);
});

test("specifiersFromDenoInfo skips failed deno info and sorts successes", async () => {
  const calls: string[][] = [];
  const specs = await specifiersFromDenoInfo(
    "/unused",
    ["missing.ts", "src/prod-main.ts"],
    (args) => {
      calls.push(args);
      if (args.at(-1) === "missing.ts") {
        return Promise.resolve({ success: false, stdout: "" });
      }
      return Promise.resolve({
        success: true,
        stdout: JSON.stringify({
          modules: [{ specifier: "jsr:@std/path@1.0.0" }],
        }),
      });
    },
  );
  assertEquals(specs, ["jsr:@std/path@1.0.0"]);
  assertEquals(calls.length, 2);
});

test({
  name: "specifiersFromDenoInfo default runner invokes deno info",
  permissions: { run: true, read: true },
  async fn() {
    const specs = await specifiersFromDenoInfo(ROOT, [
      "this-entrypoint-does-not-exist.ts",
    ]);
    assertEquals(Array.isArray(specs), true);
    for (const spec of specs) {
      if (!spec.startsWith("jsr:") && !spec.startsWith("npm:")) {
        throw new TypeError(`unexpected specifier ${spec}`);
      }
    }
  },
});

async function withNoticesRoot(
  files: Record<string, string>,
  fn: (root: string) => Promise<void>,
): Promise<void> {
  const root = await Deno.makeTempDir({ prefix: "tp-notices-root-" });
  try {
    for (const [rel, text] of Object.entries(files)) {
      const path = join(root, rel);
      await Deno.mkdir(dirname(path), { recursive: true });
      await Deno.writeTextFile(path, text);
    }
    await fn(root);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
}

const MINIMAL_DENO_LOCK = JSON.stringify({
  workspace: { dependencies: ["jsr:@std/path@1.0.0"] },
  jsr: { "@std/path@1.0.0": {} },
});

const MINIMAL_REQ_TXT = "ansible-core==2.20.*\n";

const MINIMAL_PNPM_LOCK = `lockfileVersion: '9.0'
importers:
  .:
    devDependencies:
      wrangler:
        specifier: ^4.124.0
        version: 4.124.0
packages:
  wrangler@4.124.0: {}
`;

function mitLookup(): (pkg: NoticePackage) => Promise<string> {
  return () => Promise.resolve("MIT");
}

test("collectDaemonNoticePackages merges deno, pnpm, and orchestration pins", async () => {
  await withNoticesRoot({
    "deno.lock": MINIMAL_DENO_LOCK,
    "orchestration/requirements.txt": MINIMAL_REQ_TXT,
    "workers/turbopanel-sh/pnpm-lock.yaml": MINIMAL_PNPM_LOCK,
  }, async (root) => {
    const packages = await collectDaemonNoticePackages(root, mitLookup(), {
      denoProductionRoots: ["jsr:@std/path@1.0.0"],
    });
    const names = packages.map((pkg) => pkg.name).sort((a, b) =>
      a.localeCompare(b)
    );
    assertEquals(names.includes("@std/path"), true);
    assertEquals(names.includes("ansible-core"), true);
    assertEquals(names.includes("wrangler"), true);
  });
});

test("collectDaemonNoticePackages treats a missing pnpm lock as empty npm", async () => {
  await withNoticesRoot({
    "deno.lock": MINIMAL_DENO_LOCK,
    "orchestration/requirements.txt": MINIMAL_REQ_TXT,
  }, async (root) => {
    const packages = await collectDaemonNoticePackages(root, mitLookup(), {
      denoProductionRoots: ["jsr:@std/path@1.0.0"],
    });
    assertEquals(
      packages.some((pkg) => pkg.source === "pnpm-lock.yaml"),
      false,
    );
  });
});

test("collectDaemonNoticePackages rethrows a malformed pnpm lock", async () => {
  await withNoticesRoot({
    "deno.lock": MINIMAL_DENO_LOCK,
    "orchestration/requirements.txt": MINIMAL_REQ_TXT,
    "workers/turbopanel-sh/pnpm-lock.yaml": "[]",
  }, async (root) => {
    await assertRejects(
      () =>
        collectDaemonNoticePackages(root, mitLookup(), {
          denoProductionRoots: ["jsr:@std/path@1.0.0"],
        }),
      TypeError,
      "generate-notices: unexpected pnpm-lock.yaml",
    );
  });
});

test("collectDaemonNoticePackages falls back to workspace roots when the graph is empty", async () => {
  await withNoticesRoot({
    "deno.lock": MINIMAL_DENO_LOCK,
    "orchestration/requirements.txt": MINIMAL_REQ_TXT,
  }, async (root) => {
    const packages = await collectDaemonNoticePackages(root, mitLookup(), {
      denoProductionRoots: [],
    });
    assertEquals(packages.some((pkg) => pkg.name === "@std/path"), true);
  });
});

test("collectDaemonNoticePackages uses the injected deno-info resolver", async () => {
  await withNoticesRoot({
    "deno.lock": MINIMAL_DENO_LOCK,
    "orchestration/requirements.txt": MINIMAL_REQ_TXT,
  }, async (root) => {
    const seen: string[][] = [];
    const packages = await collectDaemonNoticePackages(root, mitLookup(), {
      resolveDenoInfoSpecifiers: (entrypoints) => {
        seen.push([...entrypoints]);
        return Promise.resolve(["jsr:@std/path@1.0.0"]);
      },
    });
    assertEquals(seen[0]?.[0], "src/prod-main.ts");
    assertEquals(packages.some((pkg) => pkg.name === "@std/path"), true);
  });
});

test("runGenerateNotices writes notices and then reports them current", async () => {
  await withNoticesRoot({
    "deno.lock": MINIMAL_DENO_LOCK,
    "orchestration/requirements.txt": MINIMAL_REQ_TXT,
    "orchestration/requirements.lock.txt": "ansible-core==2.20.*\n",
    "orchestration/requirements.yml":
      "- name: ansible.posix\n  version: 2.2.1\n",
    "workers/turbopanel-sh/pnpm-lock.yaml": MINIMAL_PNPM_LOCK,
  }, async (root) => {
    const logs: string[] = [];
    const exits: number[] = [];
    const written = await runGenerateNotices({
      root,
      argv: [],
      io: {
        log: (...args) => {
          logs.push(args.map(String).join(" "));
        },
      },
      exit: (code) => {
        exits.push(code);
      },
      lookupLicense: mitLookup(),
      denoProductionRoots: ["jsr:@std/path@1.0.0"],
    });
    assertEquals(written, 0);
    assertEquals(exits, []);
    assertEquals(logs[0]?.includes(NOTICES_FILE_NAME), true);

    const check = await runGenerateNotices({
      root,
      argv: ["--check"],
      io: {
        log: (...args) => {
          logs.push(args.map(String).join(" "));
        },
      },
      exit: (code) => {
        exits.push(code);
      },
      lookupLicense: mitLookup(),
      denoProductionRoots: ["jsr:@std/path@1.0.0"],
    });
    assertEquals(check, 0);
    assertEquals(exits, []);
    assertEquals(logs.at(-1)?.includes("is current"), true);
  });
});

test("runGenerateNotices --check fails when the notices file is missing or stale", async () => {
  await withNoticesRoot({
    "deno.lock": MINIMAL_DENO_LOCK,
    "orchestration/requirements.txt": MINIMAL_REQ_TXT,
  }, async (root) => {
    const errors: string[] = [];
    const exits: number[] = [];
    const missing = await runGenerateNotices({
      root,
      argv: ["--check"],
      io: {
        error: (...args) => {
          errors.push(args.map(String).join(" "));
        },
      },
      exit: (code) => {
        exits.push(code);
      },
      lookupLicense: mitLookup(),
      denoProductionRoots: ["jsr:@std/path@1.0.0"],
    });
    assertEquals(missing, 1);
    assertEquals(exits, [1]);
    assertEquals(errors[0]?.includes("missing"), true);

    await Deno.writeTextFile(join(root, NOTICES_FILE_NAME), "stale\n");
    const stale = await runGenerateNotices({
      root,
      argv: ["--check"],
      io: {
        error: (...args) => {
          errors.push(args.map(String).join(" "));
        },
      },
      exit: (code) => {
        exits.push(code);
      },
      lookupLicense: mitLookup(),
      denoProductionRoots: ["jsr:@std/path@1.0.0"],
    });
    assertEquals(stale, 1);
    assertEquals(exits, [1, 1]);
    assertEquals(errors.at(-1)?.includes("stale"), true);
  });
});

test("runGenerateNotices exits on an unreviewed license class", async () => {
  await withNoticesRoot({
    "deno.lock": MINIMAL_DENO_LOCK,
    "orchestration/requirements.txt": MINIMAL_REQ_TXT,
    "workers/turbopanel-sh/pnpm-lock.yaml": MINIMAL_PNPM_LOCK,
  }, async (root) => {
    const errors: string[] = [];
    const exits: number[] = [];
    const code = await runGenerateNotices({
      root,
      argv: [],
      io: {
        error: (...args) => {
          errors.push(args.map(String).join(" "));
        },
      },
      exit: (code) => {
        exits.push(code);
      },
      lookupLicense: () => Promise.resolve(""),
      denoProductionRoots: ["jsr:@std/path@1.0.0"],
    });
    assertEquals(code, 1);
    assertEquals(exits, [1]);
    assertEquals(errors[0]?.includes("unreviewed license class"), true);
  });
});

test("runGenerateNotices skips optional lock fingerprints that are absent", async () => {
  await withNoticesRoot({
    "deno.lock": MINIMAL_DENO_LOCK,
    "orchestration/requirements.txt": MINIMAL_REQ_TXT,
  }, async (root) => {
    const code = await runGenerateNotices({
      root,
      argv: [],
      io: { log: () => {} },
      exit: () => {
        throw new TypeError("should not exit");
      },
      lookupLicense: mitLookup(),
      denoProductionRoots: ["jsr:@std/path@1.0.0"],
    });
    assertEquals(code, 0);
  });
});

function npmPkg(source: NoticePackage["source"]): NoticePackage {
  return {
    name: "yaml",
    version: "2.0.0",
    license: "",
    role: "production",
    source,
  };
}

function jsrPkg(): NoticePackage {
  return {
    name: "@std/path",
    version: "1.0.0",
    license: "",
    role: "production",
    source: "deno.lock (jsr)",
  };
}

async function withDenoDir(
  fn: (denoDir: string) => Promise<void>,
): Promise<void> {
  const denoDir = await Deno.makeTempDir({ prefix: "tp-deno-dir-" });
  const previous = Deno.env.get("DENO_DIR");
  Deno.env.set("DENO_DIR", denoDir);
  try {
    await fn(denoDir);
  } finally {
    if (previous === undefined) Deno.env.delete("DENO_DIR");
    else Deno.env.set("DENO_DIR", previous);
    await Deno.remove(denoDir, { recursive: true });
  }
}

test("lookupRegistryLicense reads npm cache then falls back to the registry", async () => {
  await withDenoDir(async (denoDir) => {
    const pkgJson = join(
      denoDir,
      "npm",
      "registry.npmjs.org",
      "yaml",
      "2.0.0",
      "package.json",
    );
    await Deno.mkdir(dirname(pkgJson), { recursive: true });
    await Deno.writeTextFile(pkgJson, JSON.stringify({ license: "MIT" }));
    assertEquals(await lookupRegistryLicense(npmPkg("deno.lock (npm)")), "MIT");

    await Deno.writeTextFile(
      pkgJson,
      JSON.stringify({ license: { type: "MIT" } }),
    );
    const originalFetch = globalThis.fetch;
    globalThis.fetch = ((input) => {
      const url = String(input);
      if (url.includes("registry.npmjs.org/yaml/2.0.0")) {
        return Promise.resolve(
          new Response(JSON.stringify({ license: "ISC" })),
        );
      }
      return Promise.reject(new TypeError(`unexpected ${url}`));
    }) as typeof fetch;
    try {
      assertEquals(
        await lookupRegistryLicense(npmPkg("pnpm-lock.yaml")),
        "ISC",
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

test("lookupRegistryLicense returns empty when the npm registry is unavailable", async () => {
  await withDenoDir(async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = ((input) => {
      const url = String(input);
      if (url.includes("registry.npmjs.org/yaml/2.0.0")) {
        return Promise.resolve(new Response("nope", { status: 404 }));
      }
      return Promise.reject(new TypeError(`unexpected ${url}`));
    }) as typeof fetch;
    try {
      assertEquals(
        await lookupRegistryLicense(npmPkg("package-lock.json")),
        "",
      );
    } finally {
      globalThis.fetch = originalFetch;
    }

    globalThis.fetch = () =>
      Promise.resolve(new Response(JSON.stringify({ license: 12 })));
    try {
      assertEquals(await lookupRegistryLicense(npmPkg("deno.lock (npm)")), "");
    } finally {
      globalThis.fetch = originalFetch;
    }

    globalThis.fetch = () => Promise.reject(new TypeError("offline"));
    try {
      assertEquals(await lookupRegistryLicense(npmPkg("deno.lock (npm)")), "");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

test("lookupRegistryLicense reads jsr cache candidates then fetches deno.json", async () => {
  await withDenoDir(async (denoDir) => {
    const encoded = "@std$path";
    const first = join(
      denoDir,
      "gen",
      "https",
      "jsr.io",
      encoded,
      "1.0.0_meta.json",
    );
    await Deno.mkdir(dirname(first), { recursive: true });
    await Deno.writeTextFile(first, JSON.stringify({ license: "MIT" }));
    assertEquals(await lookupRegistryLicense(jsrPkg()), "MIT");

    await Deno.writeTextFile(first, JSON.stringify({ license: "  " }));
    const second = join(
      denoDir,
      "deps",
      "https",
      "jsr.io",
      "@std/path@1.0.0.json",
    );
    await Deno.mkdir(dirname(second), { recursive: true });
    await Deno.writeTextFile(second, JSON.stringify({ license: "Apache-2.0" }));
    assertEquals(await lookupRegistryLicense(jsrPkg()), "Apache-2.0");

    await Deno.remove(first);
    await Deno.remove(second);
    const originalFetch = globalThis.fetch;
    globalThis.fetch = ((input) => {
      const url = String(input);
      if (url.endsWith("/deno.json")) {
        return Promise.resolve(
          new Response(JSON.stringify({ license: "BSD-2-Clause" })),
        );
      }
      return Promise.reject(new TypeError(`unexpected ${url}`));
    }) as typeof fetch;
    try {
      assertEquals(await lookupRegistryLicense(jsrPkg()), "BSD-2-Clause");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

test("lookupRegistryLicense falls back to jsr LICENSE text and defaults", async () => {
  await withDenoDir(async () => {
    const originalFetch = globalThis.fetch;
    const cases: Array<{ license: string; want: string }> = [
      {
        license: "Permission is hereby granted, free of charge, to any person",
        want: "MIT",
      },
      {
        license: "Apache License Version 2.0, January 2004",
        want: "Apache-2.0",
      },
      { license: "ISC License", want: "ISC" },
      { license: "Proprietary blob", want: "MIT" },
    ];
    try {
      for (const row of cases) {
        globalThis.fetch = ((input) => {
          const url = String(input);
          if (url.endsWith("/deno.json")) {
            return Promise.resolve(new Response("nope", { status: 404 }));
          }
          if (url.endsWith("/LICENSE")) {
            return Promise.resolve(new Response(row.license));
          }
          return Promise.reject(new TypeError(`unexpected ${url}`));
        }) as typeof fetch;
        assertEquals(await lookupRegistryLicense(jsrPkg()), row.want);
      }

      globalThis.fetch = ((input) => {
        const url = String(input);
        if (url.endsWith("/deno.json")) {
          return Promise.resolve(
            new Response(JSON.stringify({ license: "  " })),
          );
        }
        if (url.endsWith("/LICENSE")) {
          return Promise.resolve(new Response("nope", { status: 404 }));
        }
        return Promise.reject(new TypeError(`unexpected ${url}`));
      }) as typeof fetch;
      assertEquals(await lookupRegistryLicense(jsrPkg()), "MIT");

      globalThis.fetch = () => Promise.reject(new TypeError("offline"));
      assertEquals(await lookupRegistryLicense(jsrPkg()), "MIT");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

test("lookupRegistryLicense returns empty for non-registry sources", async () => {
  assertEquals(
    await lookupRegistryLicense({
      name: "ansible-core",
      version: "2.20.*",
      license: "GPL-3.0-or-later",
      role: "orchestration",
      source: "orchestration",
    }),
    "",
  );
});

test("lookupRegistryLicense uses HOME/.cache/deno when DENO_DIR is unset", async () => {
  const home = await Deno.makeTempDir({ prefix: "tp-home-cache-" });
  const previousDeno = Deno.env.get("DENO_DIR");
  const previousHome = Deno.env.get("HOME");
  Deno.env.delete("DENO_DIR");
  Deno.env.set("HOME", home);
  try {
    const pkgJson = join(
      home,
      ".cache",
      "deno",
      "npm",
      "registry.npmjs.org",
      "yaml",
      "2.0.0",
      "package.json",
    );
    await Deno.mkdir(dirname(pkgJson), { recursive: true });
    await Deno.writeTextFile(pkgJson, JSON.stringify({ license: "MIT" }));
    assertEquals(await lookupRegistryLicense(npmPkg("deno.lock (npm)")), "MIT");
  } finally {
    if (previousDeno === undefined) Deno.env.delete("DENO_DIR");
    else Deno.env.set("DENO_DIR", previousDeno);
    if (previousHome === undefined) Deno.env.delete("HOME");
    else Deno.env.set("HOME", previousHome);
    await Deno.remove(home, { recursive: true });
  }
});
