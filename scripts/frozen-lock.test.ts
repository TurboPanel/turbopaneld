/**
 * Release builds and installs must run against the lockfile as committed, so
 * the shipped dependencies (and the SBOM built from the lock) are the reviewed
 * ones (audit L3/L4). Without `--frozen`, `deno compile` silently adds a
 * missing lock entry during the release build.
 */
import { assert, assertEquals } from "@std/assert";
import { fromFileUrl, join } from "@std/path";

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno);

const ROOT = join(fromFileUrl(new URL(".", import.meta.url)), "..");

async function workflowLines(): Promise<{ file: string; line: string }[]> {
  const dir = join(ROOT, ".github", "workflows");
  const out: { file: string; line: string }[] = [];
  for await (const entry of Deno.readDir(dir)) {
    if (!entry.name.endsWith(".yml")) continue;
    const text = await Deno.readTextFile(join(dir, entry.name));
    for (const line of text.split("\n")) {
      if (!line.trim().startsWith("#")) out.push({ file: entry.name, line });
    }
  }
  return out;
}

test("every deno compile task in deno.json is --frozen", async () => {
  const config = JSON.parse(
    await Deno.readTextFile(join(ROOT, "deno.json")),
  ) as {
    tasks: Record<string, string>;
  };
  const compiles = Object.entries(config.tasks).filter(([, command]) =>
    command.startsWith("deno compile")
  );
  assert(compiles.length >= 3, "expected the compile tasks to exist");
  assertEquals(
    compiles.filter(([, command]) => !command.includes("--frozen")).map((
      [name],
    ) => name),
    [],
  );
});

test("no workflow installs or compiles without the frozen lockfile", async () => {
  const unfrozen = (await workflowLines()).filter(({ line }) =>
    (/\bdeno (install|cache)\b/.test(line) && !/--frozen/.test(line)) ||
    (/\bdeno compile\b/.test(line) && !/--frozen/.test(line)) ||
    (/\bpnpm (install|i)\b/.test(line) && !/--frozen-lockfile/.test(line))
  );
  assertEquals(unfrozen, []);
});

test("the release workflow generates the SBOM after the frozen compile", async () => {
  const text = await Deno.readTextFile(
    join(ROOT, ".github", "workflows", "release.yml"),
  );
  const compile = text.indexOf("deno task compile:linux-arm64");
  const sbom = text.indexOf("deno task sbom");
  assert(
    compile > 0 && sbom > compile,
    "release.yml must run deno task sbom after compiling",
  );
});
