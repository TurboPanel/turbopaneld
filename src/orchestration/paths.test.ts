import {
  DEFAULT_DAEMON_ROOT,
  resolveDaemonRoot,
} from "./paths.ts";

Deno.test("resolveDaemonRoot prefers TURBOPANEL_DAEMON_ROOT", () => {
  const root = resolveDaemonRoot({
    TURBOPANEL_DAEMON_ROOT: "/custom/daemon",
  });
  if (root !== "/custom/daemon") {
    throw new Error(`expected /custom/daemon, got ${root}`);
  }
});

Deno.test("resolveDaemonRoot uses default install path for compiled stub roots", () => {
  const root = resolveDaemonRoot({
    TURBOPANEL_DAEMON_ROOT: "",
  });
  const fromMeta = new URL("../../..", import.meta.url).pathname;
  if (fromMeta.includes("deno-compile") || fromMeta.startsWith("/tmp/")) {
    if (root !== DEFAULT_DAEMON_ROOT) {
      throw new Error(
        `expected ${DEFAULT_DAEMON_ROOT} for compiled stub, got ${root}`,
      );
    }
  }
});
