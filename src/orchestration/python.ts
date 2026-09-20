import { join } from "@std/path";
import { runLogged, symlinkPointsAt } from "./exec.ts";
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
  if (await symlinkPointsAt(PYTHON_CURRENT_DIR, PYTHON_RUNTIME_DIR)) return;
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
 * True when a uv-managed interpreter already lives under the pinned version
 * dir (`cpython-<ver>-<triple>/bin/python3`). Checked before invoking uv so
 * the daemon never needs write access to the root-owned Python tree once the
 * installer has populated it.
 */
async function managedPythonPresent(): Promise<boolean> {
  try {
    for await (const entry of Deno.readDir(PYTHON_RUNTIME_DIR)) {
      if (!entry.isDirectory || !entry.name.startsWith("cpython-")) continue;
      try {
        await Deno.stat(join(PYTHON_RUNTIME_DIR, entry.name, "bin", "python3"));
        return true;
      } catch {
        // keep looking
      }
    }
  } catch {
    return false;
  }
  return false;
}

/**
 * Ensure the pinned Python version is installed into the runtime.
 *
 * Uses `uv python install`, which downloads a managed (relocatable) Python into
 * `UV_PYTHON_INSTALL_DIR`. `--no-bin` skips ~/.local/bin shims; `uv venv --python`
 * resolves managed installs directly.
 */
export async function ensurePython(): Promise<void> {
  if (await managedPythonPresent()) {
    logInfo(
      "orchestration",
      `Python ${PYTHON_VERSION} already installed at ${PYTHON_RUNTIME_DIR}`,
    );
    await repointPythonCurrent();
    return;
  }
  // Ensure the target dir exists and is writable by the calling user (root
  // at install time; the tree is root-owned afterwards, so a missing
  // interpreter on a managed host is a repair for the installer, not the
  // daemon) before invoking uv, which will populate it and the cache.
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
