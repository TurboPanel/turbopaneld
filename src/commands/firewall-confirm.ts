/**
 * Confirm the host's pending firewall ruleset (`server.firewall.confirm`).
 *
 * Normally the daemon confirms itself (`../firewall/auto-confirm.ts`); this
 * command stays for a manual or retried confirm, naming the digest the
 * reconcile reported. All the
 * logic lives in `../firewall/confirm.ts`; this is the command wrapper, kept
 * beside `firewall-reconcile.ts` like the other command handlers.
 */

import {
  confirmPendingFirewall,
  type FirewallConfirmOptions,
} from "../firewall/confirm.ts";
import type {
  FirewallConfirmPayload,
  FirewallConfirmResult,
} from "../contracts/commands-contracts.ts";

export type FirewallConfirmDeps = FirewallConfirmOptions;

export async function handleFirewallConfirm(
  payload: FirewallConfirmPayload,
  _daemonReceivedAt: string,
  deps: FirewallConfirmDeps = {},
): Promise<FirewallConfirmResult> {
  return await confirmPendingFirewall(payload.digest, deps);
}
