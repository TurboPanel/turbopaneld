import { join } from "@std/path";
import { runLogged } from "./exec.ts";
import { logInfo, logWarn } from "../logger.ts";
import { logComponent } from "./presentation.ts";
import {
  PYTHON_CURRENT_DIR,
  PYTHON_RUNTIME_DIR,
  PYTHON_VERSION,
  RUNTIMES_DIR,
  UV_BIN,
} from "./paths.ts";

async function repointPythonCurrent(): Promise<void> {
  try {
    await Deno.remove(PYTHON_CURRENT_DIR);
  } catch (err) {
    if (!(err instanceof Deno.errors.NotFound)) {
      logWarn(
        "orchestration",
        "could not replace python current symlink:",
        err,
      );
      return;
    }
  }
  try {
    await Deno.mkdir(join(RUNTIMES_DIR, "python"), { recursive: true });
    await Deno.symlink(PYTHON_RUNTIME_DIR, PYTHON_CURRENT_DIR, { type: "dir" });
  } catch (err) {
    logWarn("orchestration", "could not create python current symlink:", err);
  }
}

/**
 * Ensure the pinned Python version is installed into the runtime.
 *
 * Uses `uv python install`, which downloads a managed (relocatable) Python into
 * `UV_PYTHON_INSTALL_DIR`. `--no-bin` skips ~/.local/bin shims; `uv venv --python`
 * resolves managed installs directly.
 */
export async function ensurePython(): Promise<void> {
  // Ensure the target dir exists and is writable by the calling user (turbopanel
  // on managed installs) before invoking uv, which will populate it and the cache.
  await Deno.mkdir(PYTHON_RUNTIME_DIR, { recursive: true });
  logInfo("orchestration", `ensuring Python ${PYTHON_VERSION} is installed`);
  // Capture uv output — informational "already installed" lines belong in stdout, not err.log.
  await runLogged(UV_BIN, ["python", "install", "--no-bin", PYTHON_VERSION], {
    level: "DEBUG",
    component: logComponent("python"),
  });
  await repointPythonCurrent();
  logInfo(
    "orchestration",
    `Python ${PYTHON_VERSION} ready at ${PYTHON_RUNTIME_DIR}`,
  );
}
