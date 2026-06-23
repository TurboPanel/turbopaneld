import { runLogged } from "./exec.ts";
import { logInfo } from "../logger.ts";
import { PYTHON_VERSION, UV_BIN } from "./paths.ts";

/**
 * Ensure the pinned Python version is installed into the runtime.
 *
 * Uses `uv python install`, which downloads a managed (relocatable) Python into
 * `UV_PYTHON_INSTALL_DIR`. `--no-bin` skips ~/.local/bin shims; `uv venv --python`
 * resolves managed installs directly.
 */
export async function ensurePython(): Promise<void> {
  logInfo("orchestration", `ensuring Python ${PYTHON_VERSION} is installed`);
  // Capture uv output — informational "already installed" lines belong in stdout, not err.log.
  await runLogged(UV_BIN, ["python", "install", "--no-bin", PYTHON_VERSION], {
    level: "DEBUG",
    component: "python",
  });
  logInfo("orchestration", `Python ${PYTHON_VERSION} ready`);
}
