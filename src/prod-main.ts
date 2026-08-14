/**
 * Production daemon entry. Used by `deno task compile` / `bundle:js` so the
 * managed binary never imports the checkout-sync unpack path.
 */
import { maybeRunDaemonCli } from "./daemon-cli.ts";

await maybeRunDaemonCli();
await import("./daemon-run.ts");
