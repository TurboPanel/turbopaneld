/**
 * scripts/set-version.mjs: sets every committed version field, and `--check`
 * refuses (exit 1, one line per file) while any field disagrees. The CLI
 * tests run the real script from a copy inside a throwaway repo root, and the
 * in-process ones point `run` at one, so the checkout's own files are never
 * touched.
 */
import { assertEquals, assertStringIncludes } from "@std/assert";
import { dirname, fromFileUrl, join } from "@std/path";
import { parseArgs, run as setVersion } from "./set-version.mjs";

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno);

const ROOT = dirname(dirname(fromFileUrl(import.meta.url)));
const SCRIPT = join(ROOT, "scripts", "set-version.mjs");

const DENO_JSON = `{
  "name": "turbopaneld",
  "version": "0.1.6",
  "imports": {
    "yaml": "npm:yaml@^2.8.0"
  },
  "nested": { "version": "9.9.9" }
}
`;
const SONAR =
  "sonar.projectKey=x\nsonar.projectVersion=0.1.6\nsonar.sources=src\n";

function fixture(): string {
  const dir = Deno.makeTempDirSync({ prefix: "set-version-" });
  Deno.mkdirSync(join(dir, "scripts"));
  Deno.copyFileSync(SCRIPT, join(dir, "scripts", "set-version.mjs"));
  Deno.writeTextFileSync(join(dir, "deno.json"), DENO_JSON);
  Deno.writeTextFileSync(join(dir, "sonar-project.properties"), SONAR);
  return dir;
}

function run(dir: string, ...args: string[]) {
  const out = new Deno.Command(Deno.execPath(), {
    args: [
      "run",
      "--no-config",
      "--allow-read",
      "--allow-write",
      join(dir, "scripts", "set-version.mjs"),
      ...args,
    ],
    stdout: "piped",
    stderr: "piped",
  }).outputSync();
  const decode = (b: Uint8Array) => new TextDecoder().decode(b);
  return {
    code: out.code,
    stdout: decode(out.stdout),
    stderr: decode(out.stderr),
  };
}

function read(dir: string, file: string): string {
  return Deno.readTextFileSync(join(dir, file));
}

test("set-version rewrites only the version values and keeps the formatting", () => {
  const dir = fixture();
  try {
    assertEquals(run(dir, "0.1.9").code, 0);
    assertEquals(
      read(dir, "deno.json"),
      DENO_JSON.replace('"version": "0.1.6"', '"version": "0.1.9"'),
    );
    assertEquals(
      read(dir, "sonar-project.properties"),
      SONAR.replace("0.1.6", "0.1.9"),
    );
    assertEquals(run(dir, "--check", "0.1.9").code, 0);
  } finally {
    Deno.removeSync(dir, { recursive: true });
  }
});

test("--check changes nothing and names every file that disagrees", () => {
  const dir = fixture();
  try {
    const result = run(dir, "--check", "0.1.9");
    assertEquals(result.code, 1);
    const lines = result.stdout.trim().split("\n");
    assertEquals(lines, [
      'deno.json says 0.1.6, the next version is 0.1.9: merge the "chore: start 0.1.9" PR (or run node scripts/set-version.mjs 0.1.9 in a PR)',
      'sonar-project.properties says 0.1.6, the next version is 0.1.9: merge the "chore: start 0.1.9" PR (or run node scripts/set-version.mjs 0.1.9 in a PR)',
    ]);
    assertEquals(read(dir, "deno.json"), DENO_JSON);
    assertEquals(read(dir, "sonar-project.properties"), SONAR);
  } finally {
    Deno.removeSync(dir, { recursive: true });
  }
});

test("anything but a plain X.Y.Z is refused", () => {
  const dir = fixture();
  try {
    for (
      const args of [
        [],
        ["v0.1.9"],
        ["0.1.9-rc.1"],
        ["0.1"],
        ["--check"],
        ["--check", "0.1.9-canary.3"],
        ["0.1.9", "0.2.0"],
      ]
    ) {
      const result = run(dir, ...args);
      assertEquals(result.code, 2, `args: ${args.join(" ")}`);
      assertStringIncludes(result.stderr, "usage:");
    }
    assertEquals(read(dir, "deno.json"), DENO_JSON);
  } finally {
    Deno.removeSync(dir, { recursive: true });
  }
});

test("the checkout's own version fields agree with each other", () => {
  const denoJson = JSON.parse(Deno.readTextFileSync(join(ROOT, "deno.json")));
  const result = new Deno.Command(Deno.execPath(), {
    args: [
      "run",
      "--no-config",
      "--allow-read",
      SCRIPT,
      "--check",
      denoJson.version,
    ],
    stdout: "piped",
  }).outputSync();
  assertEquals(result.code, 0);
});

test("parseArgs takes a plain X.Y.Z, with or without --check", () => {
  assertEquals(parseArgs(["0.1.9"]), { check: false, version: "0.1.9" });
  assertEquals(parseArgs(["--check", "1.0.0"]), {
    check: true,
    version: "1.0.0",
  });
  for (
    const args of [[], ["v0.1.9"], ["0.1.9-rc.1"], ["--check"], ["1", "2"]]
  ) {
    assertEquals(parseArgs(args), null, `args: ${args.join(" ")}`);
  }
});

test("run checks, then sets, every field in place", () => {
  const dir = fixture();
  try {
    const before = setVersion(dir, { check: true, version: "0.2.0" });
    assertEquals(before.code, 1);
    assertEquals(before.out.length, 2);
    assertStringIncludes(before.out[0], "deno.json says 0.1.6");
    assertEquals(read(dir, "deno.json"), DENO_JSON);

    const set = setVersion(dir, { check: false, version: "0.2.0" });
    assertEquals(set, {
      code: 0,
      out: [
        "deno.json: 0.1.6 -> 0.2.0",
        "sonar-project.properties: 0.1.6 -> 0.2.0",
      ],
    });
    assertStringIncludes(
      read(dir, "deno.json"),
      '"nested": { "version": "9.9.9" }',
    );

    assertEquals(setVersion(dir, { check: true, version: "0.2.0" }), {
      code: 0,
      out: ["every version field says 0.2.0"],
    });
    assertEquals(setVersion(dir, { check: false, version: "0.2.0" }), {
      code: 0,
      out: [],
    });
  } finally {
    Deno.removeSync(dir, { recursive: true });
  }
});

test("run refuses a file with no version field", () => {
  const dir = fixture();
  try {
    Deno.writeTextFileSync(
      join(dir, "sonar-project.properties"),
      "sonar.projectKey=x\n",
    );
    assertEquals(setVersion(dir, { check: true, version: "0.1.6" }), {
      code: 2,
      out: ["sonar-project.properties has no version field"],
    });
  } finally {
    Deno.removeSync(dir, { recursive: true });
  }
});

test("a symlinked script still runs and still fails a wrong version", () => {
  const dir = Deno.makeTempDirSync({ prefix: "set-version-link-" });
  try {
    const link = join(dir, "set-version.mjs");
    Deno.symlinkSync(SCRIPT, link);
    const result = new Deno.Command(Deno.execPath(), {
      args: ["run", "--no-config", "--allow-read", link, "--check", "0.0.0"],
      stdout: "piped",
      stderr: "piped",
    }).outputSync();
    assertEquals(result.code, 1);
  } finally {
    Deno.removeSync(dir, { recursive: true });
  }
});
