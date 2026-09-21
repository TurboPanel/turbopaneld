/**
 * Source / checkout-sync entry (`deno run main.ts`). Registers the unpack path
 * before starting the daemon. Managed compile uses {@link ./src/prod-main.ts}.
 */
import { maybeRunDaemonCli } from "./src/entry/cli.ts";
import { runDaemon } from "./src/entry/run.ts";
import { applyDevSyncTarball } from "./src/dev-sync/apply.ts";
import { enableCheckoutDevSync } from "./src/dev-sync/runtime.ts";

await maybeRunDaemonCli();
enableCheckoutDevSync(applyDevSyncTarball);
await runDaemon();
