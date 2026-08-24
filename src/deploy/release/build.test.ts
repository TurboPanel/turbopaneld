import { assertEquals } from "@std/assert";
import { join } from "@std/path";
import {
  NEXT_EXPORT_DIR,
  NEXT_STANDALONE_DIR,
  prepareNativeAppBuildOutput,
} from "./build.ts";

/**
 * Jest/Mocha-shaped alias for {@link Deno.test} — Sonar typescript:S2187 only
 * recognizes `test()` / `it()` / `describe()`.
 */
const test = Deno.test.bind(Deno);

async function withWorkingDir(
  fn: (workingDir: string) => Promise<void>,
): Promise<void> {
  const dir = await Deno.makeTempDir({ prefix: "tp-native-build-" });
  try {
    await fn(dir);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
}

/** The tree `next build` leaves behind for `output: 'export'`. */
async function seedStaticExport(workingDir: string): Promise<void> {
  const out = join(workingDir, NEXT_EXPORT_DIR);
  await Deno.mkdir(join(out, "_next"), { recursive: true });
  await Deno.writeTextFile(join(out, "index.html"), "<!doctype html>");
}

/** The tree `next build` leaves behind for `output: 'standalone'`. */
async function seedStandalone(workingDir: string): Promise<void> {
  await Deno.mkdir(join(workingDir, NEXT_STANDALONE_DIR), { recursive: true });
  await Deno.writeTextFile(
    join(workingDir, NEXT_STANDALONE_DIR, "server.js"),
    "// server",
  );
  await Deno.mkdir(join(workingDir, ".next", "static"), { recursive: true });
  await Deno.writeTextFile(
    join(workingDir, ".next", "static", "app.js"),
    "// static",
  );
}

test("a statically exported Next build publishes out/ and reports staticExport", async () => {
  await withWorkingDir(async (workingDir) => {
    await seedStaticExport(workingDir);
    const lines: string[] = [];
    const output = await prepareNativeAppBuildOutput({
      framework: "next",
      workingDir,
      onOutput: (_stream, line) => lines.push(line),
    });

    assertEquals(output.staticExport, true);
    assertEquals(output.standaloneOutput, false);
    // `out/` becomes the release root, so a vhost can serve `current` directly.
    assertEquals(output.outputDirectory, NEXT_EXPORT_DIR);
    assertEquals(
      lines.some((line) => line.includes("statically exported")),
      true,
    );
    // No "re-declare the service yourself" instruction survives.
    assertEquals(
      lines.some((line) => line.includes("declare the service as")),
      false,
    );
  });
});

test("framework auto also detects a static export", async () => {
  await withWorkingDir(async (workingDir) => {
    await seedStaticExport(workingDir);
    const output = await prepareNativeAppBuildOutput({
      framework: "auto",
      workingDir,
    });
    assertEquals(output.staticExport, true);
    assertEquals(output.outputDirectory, NEXT_EXPORT_DIR);
  });
});

test("a standalone build is a server build, never a static export", async () => {
  await withWorkingDir(async (workingDir) => {
    await seedStandalone(workingDir);
    // Even with an `out/` tree alongside it, a standalone server wins.
    await seedStaticExport(workingDir);
    const output = await prepareNativeAppBuildOutput({
      framework: "next",
      workingDir,
    });
    assertEquals(output.standaloneOutput, true);
    assertEquals(output.staticExport, false);
    assertEquals(output.outputDirectory, NEXT_STANDALONE_DIR);
    // `.next/static` is folded into the standalone tree, as Next documents.
    await Deno.stat(
      join(workingDir, NEXT_STANDALONE_DIR, ".next", "static", "app.js"),
    );
  });
});

test("a bare out/ directory with no index.html is not treated as an export", async () => {
  await withWorkingDir(async (workingDir) => {
    // A plain Node service whose build happens to emit `out/`.
    await Deno.mkdir(join(workingDir, "out"), { recursive: true });
    await Deno.writeTextFile(join(workingDir, "out", "main.js"), "// bundle");
    const output = await prepareNativeAppBuildOutput({
      framework: "auto",
      workingDir,
    });
    assertEquals(output.staticExport, false);
    assertEquals(output.outputDirectory, undefined);
  });
});

test("framework node never inspects the build tree", async () => {
  await withWorkingDir(async (workingDir) => {
    await seedStaticExport(workingDir);
    const output = await prepareNativeAppBuildOutput({
      framework: "node",
      workingDir,
    });
    assertEquals(output.staticExport, false);
    assertEquals(output.standaloneOutput, false);
    assertEquals(output.outputDirectory, undefined);
  });
});
