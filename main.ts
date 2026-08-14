/**
 * Source / checkout-sync entry (`deno run main.ts`). Registers the unpack path
 * before starting the daemon. Managed compile uses {@link ./src/prod-main.ts}.
 */
import { maybeRunDaemonCli } from "./src/daemon-cli.ts";
import { applyDevSyncTarball } from "./src/dev-sync-apply.ts";
import { enableCheckoutDevSync } from "./src/instance/dev-sync-runtime.ts";

await maybeRunDaemonCli();
enableCheckoutDevSync(applyDevSyncTarball);
await import("./src/daemon-run.ts");
