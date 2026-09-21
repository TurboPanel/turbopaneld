/**
 * Production daemon entry. Used by `deno task compile` / `bundle:js` so the
 * managed binary never imports the checkout-sync unpack path.
 */
import { maybeRunDaemonCli } from "./entry/cli.ts";
import { runDaemon } from "./entry/run.ts";

await maybeRunDaemonCli();
await runDaemon();
