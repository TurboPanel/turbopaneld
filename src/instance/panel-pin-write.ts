/**
 * Follow the control plane's own signed identity document into the pin file.
 *
 * The daemon cannot write `lib/panel-identity` (root:tp 0640). It hands the
 * exact document it fetched, the `X-TurboPanel-Signature` header value on the
 * first line and the body after it, to `tp-host panel-identity-write`, which
 * checks the signature against the pinned key itself before it rewrites the
 * address list (`urls=` in the pin, `hosts=` in `lib/update-origin`). Nothing
 * the daemon decided is believed by root.
 */
import { hostSudoArgs } from "../permissions/host-sudo.ts";
import { writeChildStdin } from "../util/write-child-stdin.ts";
import type { PanelIdentityFetch } from "./panel-identity-cache.ts";

export type PinWriteRun = (
  args: string[],
  stdin: string,
) => Promise<{ success: boolean; stderr: string }>;

async function runSudo(
  args: string[],
  stdin: string,
): Promise<{ success: boolean; stderr: string }> {
  const child = new Deno.Command("sudo", {
    args,
    stdin: "piped",
    stdout: "null",
    stderr: "piped",
  }).spawn();
  await writeChildStdin(child.stdin, stdin);
  const result = await child.output();
  return {
    success: result.success,
    stderr: new TextDecoder().decode(result.stderr).trim(),
  };
}

/** Rewrite the pin from a verified document; throws with tp-host's refusal. */
export async function writePanelPinFromDocument(
  fetched: PanelIdentityFetch,
  run: PinWriteRun = runSudo,
): Promise<void> {
  if (!fetched.signature) throw new Error("the document is not signed");
  const result = await run(
    hostSudoArgs(["-n", "panel-identity-write"]),
    `${fetched.signature}\n${fetched.body}`,
  );
  if (!result.success) {
    throw new Error(result.stderr || "tp-host refused the identity document");
  }
}
