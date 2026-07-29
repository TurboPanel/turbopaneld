import {
  ansiblePlaybookWorks,
  bootstrapOrchestrationRuntime,
  ensureAnsible,
  ensureGalaxyCollections,
  runLocalhostTest,
} from "./ansible.ts";
import type {
  AnsibleEventHandler,
  AnsibleRawLineStream,
} from "./ansible-events.ts";
import {
  computeBootstrapStamp,
  readBootstrapStamp,
  writeBootstrapStamp,
} from "./bootstrap-stamp.ts";
import { ensureOrchestrationTree } from "./bundle-extract.ts";
import {
  InstallerPresentedFailure,
  setActiveInstallPresenter,
} from "./install-presenter-context.ts";
import {
  createInstallPresenter,
  InstallEventPresenter,
} from "./installer-tui.ts";
import type { InstallPresenter } from "./install-presenter.ts";
import { sanitizeStatusLine } from "./presentation.ts";
import { ensurePython } from "./python.ts";
import { ensureUv } from "./uv.ts";
import { logInfo } from "../logger.ts";

export interface RunBootstrapOrchestrationOptions {
  /**
   * When true (default), show high-level installer steps instead of raw tool output.
   * Set false for programmatic/bootstrap callers that want full structured logs.
   */
  present?: boolean;
}

function resolveFailureMessage(err: unknown): string {
  let raw: string;
  if (err instanceof Error) {
    raw = err.message;
  } else if (typeof err === "string") {
    raw = err;
  } else {
    try {
      raw = JSON.stringify(err) ?? "orchestration failed";
    } catch {
      raw = "orchestration failed";
    }
  }
  return sanitizeStatusLine(raw) || "orchestration failed";
}

async function runPresentedStep(
  presenter: InstallPresenter | null,
  label: string,
  step: () => Promise<void>,
): Promise<void> {
  if (!presenter) {
    await step();
    return;
  }

  presenter.beginStep(label);
  try {
    await step();
    presenter.completeStep(true);
  } catch (err) {
    presenter.fail(resolveFailureMessage(err));
    throw new InstallerPresentedFailure();
  }
}

/** One-shot uv/Python/Ansible bootstrap used at install and from `turbopaneld bootstrap-orchestration`. */
export async function runBootstrapOrchestration(
  opts: RunBootstrapOrchestrationOptions = {},
): Promise<void> {
  const present = opts.present !== false;

  if (!present) {
    await ensureOrchestrationTree();
    await ensureUv();
    await ensurePython();
    await bootstrapOrchestrationRuntime();
    return;
  }

  const presenter = createInstallPresenter();
  const events = new InstallEventPresenter(presenter);
  setActiveInstallPresenter(presenter);

  const stamp = await computeBootstrapStamp();
  const previousStamp = await readBootstrapStamp();
  const bootstrapInputsChanged = previousStamp !== stamp;
  const ansibleWasReady = await ansiblePlaybookWorks();

  const onEvent: AnsibleEventHandler = (event) => {
    events.onEvent(event);
  };
  const onRawLine = (stream: AnsibleRawLineStream, line: string): void => {
    events.onRawLine(stream, line);
  };

  try {
    await runPresentedStep(
      presenter,
      "Preparing orchestration runtime",
      async () => {
        await ensureOrchestrationTree();
        await ensureUv();
        await ensurePython();
      },
    );

    await runPresentedStep(
      presenter,
      "Fetching orchestration components",
      async () => {
        await ensureAnsible();
      },
    );

    await runPresentedStep(
      presenter,
      "Installing orchestration components",
      async () => {
        await ensureGalaxyCollections();
      },
    );

    const ansibleReinstalled = !ansibleWasReady;
    if (bootstrapInputsChanged || ansibleReinstalled) {
      await runPresentedStep(
        presenter,
        "Verifying orchestration runtime",
        async () => {
          await runLocalhostTest(onEvent, { quiet: true, onRawLine });
        },
      );
    } else {
      logInfo(
        "orchestration",
        "bootstrap inputs unchanged, skipping localhost smoke-test",
      );
    }

    try {
      await writeBootstrapStamp(stamp);
    } catch (err) {
      presenter.fail(resolveFailureMessage(err));
      throw new InstallerPresentedFailure();
    }
  } finally {
    presenter.dispose();
    setActiveInstallPresenter(null);
  }
}
