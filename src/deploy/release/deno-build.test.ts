/**
 * How a native Deno app's install, build and start are worked out
 * (`deno-build.ts`), on plain strings and on the real fixture project in
 * `testdata/deno-app/`.
 */
import { assertEquals, assertRejects } from "@std/assert";
import { fromFileUrl, join } from "@std/path";
import {
  denoConfigFrom,
  denoEntryCandidates,
  type DenoProjectFiles,
  denoRunTaskFile,
  deriveDenoBuildCommand,
  deriveDenoCacheCommand,
  deriveDenoInstallCommand,
  detectDenoStart,
  readDenoConfig,
  stripJsonc,
} from "./deno-build.ts";

/**
 * Jest/Mocha-shaped alias for {@link Deno.test} — Sonar typescript:S2187 only
 * recognizes `test()` / `it()` / `describe()`.
 */
const test = Deno.test.bind(Deno);

/** A tree held in memory: file name to text. */
function memoryFiles(tree: Record<string, string>): DenoProjectFiles {
  return {
    read: (name) => Promise.resolve(tree[name]),
    exists: (name) => Promise.resolve(name in tree),
    entryExists: (path) => Promise.resolve(path in tree),
  };
}

test("stripJsonc removes comments and trailing commas but not string contents", () => {
  const text = `{
    // line comment
    "url": "https://example.com/a//b", /* block */
    "note": "a \\" quote // still text",
    "list": [1, 2,],
    "nested": { "k": "v", },
  }`;
  assertEquals(JSON.parse(stripJsonc(text)), {
    url: "https://example.com/a//b",
    note: 'a " quote // still text',
    list: [1, 2],
    nested: { k: "v" },
  });
  // An unterminated block comment ends the input instead of looping.
  assertEquals(stripJsonc('{"a":1} /* open'), '{"a":1}  ');
});

test("readDenoConfig reads deno.json, then deno.jsonc, and names a broken file", async () => {
  assertEquals(await readDenoConfig(memoryFiles({})), undefined);
  const json = await readDenoConfig(
    memoryFiles({ "deno.json": '{"tasks":{"start":"deno run main.ts"}}' }),
  );
  assertEquals(json?.file, "deno.json");
  assertEquals(json?.tasks.start, "deno run main.ts");
  const jsonc = await readDenoConfig(
    memoryFiles({ "deno.jsonc": '{ // c\n "main": "app.ts", }' }),
  );
  assertEquals(jsonc?.file, "deno.jsonc");
  assertEquals(jsonc?.main, "app.ts");
  // deno.json wins when both exist, as in Deno.
  const both = await readDenoConfig(
    memoryFiles({ "deno.json": "{}", "deno.jsonc": '{"main":"x.ts"}' }),
  );
  assertEquals(both?.file, "deno.json");
  const error = await assertRejects(() =>
    readDenoConfig(memoryFiles({ "deno.json": "{ nope" }))
  );
  assertEquals(
    (error as Error).message.startsWith("deno.json is not valid JSON"),
    true,
  );
});

test("denoConfigFrom reads task objects, the . export and nodeModulesDir", () => {
  const config = denoConfigFrom(
    "deno.json",
    {
      tasks: {
        start: { command: "deno run a.ts", dependencies: ["build"] },
        n: 3,
      },
      exports: { ".": "./mod.ts" },
      nodeModulesDir: "auto",
    },
  );
  assertEquals(config.tasks, { start: "deno run a.ts" });
  assertEquals(config.exportsEntry, "./mod.ts");
  assertEquals(config.nodeModulesDir, true);
  assertEquals(
    denoConfigFrom("deno.json", { exports: "./x.ts" }).exportsEntry,
    "./x.ts",
  );
  assertEquals(
    denoConfigFrom("deno.json", { nodeModulesDir: "none" }).nodeModulesDir,
    false,
  );
  assertEquals(denoConfigFrom("deno.json", []).tasks, {});
});

test("install: deno install only when a lockfile, package.json or nodeModulesDir needs it", async () => {
  const config = (tree: Record<string, string>) =>
    readDenoConfig(memoryFiles(tree));
  const trees: Array<Record<string, string>> = [
    { "deno.json": "{}", "deno.lock": "{}" },
    { "deno.json": "{}", "package.json": "{}" },
    { "deno.json": '{"nodeModulesDir":"auto"}' },
  ];
  for (const tree of trees) {
    assertEquals(
      await deriveDenoInstallCommand(memoryFiles(tree), await config(tree)),
      "deno install",
      JSON.stringify(tree),
    );
  }
  const plain = { "deno.json": "{}" };
  assertEquals(
    await deriveDenoInstallCommand(memoryFiles(plain), await config(plain)),
    undefined,
  );
});

test("build: deno task build only when the config defines a build task", () => {
  assertEquals(deriveDenoBuildCommand(undefined), undefined);
  assertEquals(
    deriveDenoBuildCommand(denoConfigFrom("deno.json", { tasks: {} })),
    undefined,
  );
  assertEquals(
    deriveDenoBuildCommand(
      denoConfigFrom("deno.json", { tasks: { build: "deno task x" } }),
    ),
    "deno task build",
  );
});

test("denoRunTaskFile understands a plain deno run and nothing cleverer", () => {
  assertEquals(denoRunTaskFile("deno run -A server.ts"), "server.ts");
  assertEquals(
    denoRunTaskFile("deno run --allow-net=0.0.0.0:8000 ./src/app.ts"),
    "src/app.ts",
  );
  assertEquals(denoRunTaskFile("deno run --watch main.ts"), undefined);
  assertEquals(denoRunTaskFile("deno run -A main.ts --port 80"), undefined);
  assertEquals(denoRunTaskFile("deno run -A --port 8000 main.ts"), "main.ts");
  assertEquals(denoRunTaskFile("deno run"), undefined);
  assertEquals(denoRunTaskFile("deno run -A"), undefined);
  assertEquals(denoRunTaskFile("deno task other"), undefined);
  assertEquals(denoRunTaskFile("node main.js"), undefined);
  assertEquals(denoRunTaskFile("deno run -A ../escape.ts"), undefined);
});

test("start: the start task, then main, the . export, a serve task, then conventional files", async () => {
  const start = async (tree: Record<string, string>) =>
    await detectDenoStart(
      memoryFiles(tree),
      await readDenoConfig(memoryFiles(tree)),
    );
  assertEquals(
    await start({ "deno.json": '{"tasks":{"start":"deno run -A x.ts"}}' }),
    { kind: "deno-task" },
  );
  assertEquals(
    await start({ "deno.json": '{"main":"./src/app.ts"}', "src/app.ts": "" }),
    { kind: "deno-file", path: "src/app.ts" },
  );
  assertEquals(
    await start({ "deno.json": '{"exports":"./lib.ts"}', "lib.ts": "" }),
    { kind: "deno-file", path: "lib.ts" },
  );
  assertEquals(
    await start({
      "deno.json": '{"tasks":{"serve":"deno run -A web/serve.ts"}}',
      "web/serve.ts": "",
      "main.ts": "",
    }),
    { kind: "deno-file", path: "web/serve.ts" },
  );
  // Conventional order: main.ts, mod.ts, server.ts, main.js, index.ts.
  assertEquals(await start({ "index.ts": "", "server.ts": "" }), {
    kind: "deno-file",
    path: "server.ts",
  });
  assertEquals(await start({ "mod.ts": "", "main.ts": "" }), {
    kind: "deno-file",
    path: "main.ts",
  });
  // A named entry that does not exist falls through to a conventional one.
  assertEquals(
    await start({ "deno.json": '{"main":"gone.ts"}', "main.js": "" }),
    { kind: "deno-file", path: "main.js" },
  );
  assertEquals(await start({ "deno.json": "{}" }), undefined);
  assertEquals(await start({}), undefined);
});

test("denoEntryCandidates drops unsafe names and repeats", () => {
  assertEquals(
    denoEntryCandidates(
      denoConfigFrom("deno.json", { main: "../x.ts", exports: "./main.ts" }),
    ),
    ["main.ts", "mod.ts", "server.ts", "main.js", "index.ts"],
  );
});

test("cache: deno cache <entry> writes the lock the read-only release needs", async () => {
  const cache = async (tree: Record<string, string>) =>
    await deriveDenoCacheCommand(
      memoryFiles(tree),
      await readDenoConfig(memoryFiles(tree)),
    );
  assertEquals(await cache({ "main.ts": "" }), "deno cache main.ts");
  // A start task that is a plain deno run names the file to cache.
  assertEquals(
    await cache({
      "deno.json": '{"tasks":{"start":"deno run -A src/app.ts"}}',
      "src/app.ts": "",
      "main.ts": "",
    }),
    "deno cache src/app.ts",
  );
  // A start task that is something else falls back to the usual entry files.
  assertEquals(
    await cache({
      "deno.json": '{"tasks":{"start":"deno task serve"}}',
      "mod.ts": "",
    }),
    "deno cache mod.ts",
  );
  assertEquals(
    await cache({ "deno.json": '{"tasks":{"start":"deno run x.ts"}}' }),
    undefined,
  );
  assertEquals(await cache({}), undefined);
});

/** The fixture project on disk, read as plain files. */
function fixtureFiles(): DenoProjectFiles {
  const dir = fromFileUrl(new URL("./testdata/deno-app", import.meta.url));
  const regular = async (name: string) => {
    try {
      return (await Deno.lstat(join(dir, name))).isFile;
    } catch {
      return false;
    }
  };
  return {
    read: async (name) =>
      await regular(name)
        ? await Deno.readTextFile(join(dir, name))
        : undefined,
    exists: regular,
    entryExists: regular,
  };
}

test("the fixture Deno project: jsonc config, a build task, a start task, nothing to install", async () => {
  const files = fixtureFiles();
  const config = await readDenoConfig(files);
  assertEquals(config?.file, "deno.jsonc");
  assertEquals(await deriveDenoInstallCommand(files, config), undefined);
  assertEquals(deriveDenoBuildCommand(config), "deno task build");
  assertEquals(await detectDenoStart(files, config), { kind: "deno-task" });
});
