/**
 * Test-only helpers — do not import from production code.
 *
 * Temp-dir fixtures whose env bag matches the override keys resolveLayout reads
 * in src/paths/layout.ts. Pass fixture.env straight into resolveLayout(...) or
 * spread into Deno.env when a test needs process-level env.
 */

export type TempLayoutDirs = {
  configDir: string;
  stateDir: string;
  logDir: string;
  runDir: string;
};

export type TempLayoutFixture = {
  dirs: TempLayoutDirs;
  env: Record<string, string>;
  cleanup: () => Promise<void>;
};

export async function createTempLayout(): Promise<TempLayoutFixture> {
  const root = await Deno.makeTempDir({ prefix: "turbopaneld-test-" });
  const configDir = `${root}/config`;
  const stateDir = `${root}/state`;
  const logDir = `${root}/log`;
  const runDir = `${root}/run`;

  await Deno.mkdir(configDir);
  await Deno.mkdir(stateDir);
  await Deno.mkdir(logDir);
  await Deno.mkdir(runDir);

  let cleaned = false;
  const cleanup = async (): Promise<void> => {
    if (cleaned) return;
    cleaned = true;
    try {
      await Deno.remove(root, { recursive: true });
    } catch (error) {
      if (error instanceof Deno.errors.NotFound) return;
      throw error;
    }
  };

  return {
    dirs: { configDir, stateDir, logDir, runDir },
    env: {
      TURBOPANEL_CONFIG_DIR: configDir,
      TURBOPANEL_STATE_DIR: stateDir,
      TURBOPANEL_LOG_DIR: logDir,
      TURBOPANEL_RUN_DIR: runDir,
      TURBOPANEL_DAEMON_STATE_DIR: stateDir,
    },
    cleanup,
  };
}

export async function withTempLayout<T>(
  fn: (fixture: TempLayoutFixture) => Promise<T> | T,
): Promise<T> {
  const fixture = await createTempLayout();
  try {
    return await fn(fixture);
  } finally {
    await fixture.cleanup();
  }
}
