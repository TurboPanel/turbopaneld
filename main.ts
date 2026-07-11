import { getBuildInfo } from "./src/build-info.ts";
import { sanitizeForLog } from "./src/logger.ts";
import { runBootstrapOrchestration } from "./src/orchestration/bootstrap-once.ts";
import { InstallerPresentedFailure } from "./src/orchestration/install-presenter-context.ts";
import {
  runInstaller,
} from "./src/orchestration/setup.ts";

if (Deno.args[0] === "--version" || Deno.args[0] === "version") {
  const info = getBuildInfo();
  console.log(
    `turbopaneld ${info.commit} (${info.channel}, ${info.buildId}, ${info.builtAt})`,
  );
  Deno.exit(0);
}

if (Deno.args[0] === "bootstrap-orchestration") {
  try {
    await runBootstrapOrchestration();
  } catch (err) {
    if (!(err instanceof InstallerPresentedFailure)) {
      console.error(`[bootstrap] ${sanitizeForLog(err)}`);
    }
    Deno.exit(1);
  }
  Deno.exit(0);
}

if (Deno.args[0] === "run-installer") {
  let instanceUrl: string | undefined;
  let start = true;
  let instanceCa: string | undefined;
  let tunnelToken: string | undefined;
  let varsFile: string | undefined;

  for (let i = 1; i < Deno.args.length; i++) {
    const arg = Deno.args[i];
    switch (arg) {
      case "--instance-url": {
        const value = Deno.args[++i];
        if (!value) {
          console.error("[installer] --instance-url requires a value");
          Deno.exit(1);
        }
        instanceUrl = value;
        break;
      }
      case "--start": {
        const value = Deno.args[++i];
        if (value !== "true" && value !== "false") {
          console.error("[installer] --start requires true or false");
          Deno.exit(1);
        }
        start = value === "true";
        break;
      }
      case "--instance-ca": {
        const value = Deno.args[++i];
        if (!value) {
          console.error("[installer] --instance-ca requires a value");
          Deno.exit(1);
        }
        instanceCa = value;
        break;
      }
      case "--tunnel-token": {
        const value = Deno.args[++i];
        if (!value) {
          console.error("[installer] --tunnel-token requires a value");
          Deno.exit(1);
        }
        tunnelToken = value;
        break;
      }
      case "--vars-file": {
        const value = Deno.args[++i];
        if (!value) {
          console.error("[installer] --vars-file requires a value");
          Deno.exit(1);
        }
        varsFile = value;
        break;
      }
      default:
        console.error(`[installer] unknown flag: ${sanitizeForLog(arg)}`);
        Deno.exit(1);
    }
  }

  if (!instanceUrl && !varsFile) {
    console.error("[installer] --instance-url or --vars-file is required");
    Deno.exit(1);
  }

  try {
    await runInstaller({ instanceUrl, start, instanceCa, tunnelToken, varsFile });
  } catch (err) {
    if (!(err instanceof InstallerPresentedFailure)) {
      console.error(`[installer] ${sanitizeForLog(err)}`);
    }
    Deno.exit(1);
  }
  Deno.exit(0);
}

await import("./src/daemon-run.ts");
