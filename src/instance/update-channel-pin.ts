/**
 * Which update channel a control-plane `update` / `instance-update` message
 * may use.
 *
 * The host channel (`TURBOPANEL_UPDATE_CHANNEL` in daemon.env, written by the
 * installer as root) is the pin. A message may move the server to another
 * channel only when it arrived on a verified signed session: the server is
 * pinned to the control plane key and the frame verified. On an unsigned
 * session a different channel is refused, so a plain message (or whoever can
 * forge one) cannot move a server to another release rail. The host-side way
 * to change it is re-running the installer with `TURBOPANEL_UPDATE_CHANNEL`.
 */
import type { UpdateChannel } from "../update/types.ts";
import {
  isUpdateChannel,
  resolveUpdateChannelConfig,
} from "../update/config.ts";
import { UpdatePreflightError } from "./run-reconcile.ts";

/** `errorCode` on the update result when a message channel is refused. */
export const CHANNEL_PINNED_CODE = "channel_pinned";

/**
 * The host channel from daemon.env. An invalid value is refused as
 * `preflight_manifest` (the code missing-channel errors already use) instead
 * of a bare error, so the control plane shows why nothing ran.
 */
export function hostUpdateChannel(
  env: Record<string, string | undefined>,
): UpdateChannel {
  try {
    return resolveUpdateChannelConfig(env).channel;
  } catch (err) {
    throw new UpdatePreflightError(
      "preflight_manifest",
      `${
        err instanceof Error ? err.message : String(err)
      }; re-run the installer on the host with a valid TURBOPANEL_UPDATE_CHANNEL`,
    );
  }
}

export type UpdateChannelDecisionInput = {
  /** The host channel (`resolveUpdateChannelConfig(env).channel`). */
  hostChannel: UpdateChannel;
  /** The channel the message names; empty or absent means "keep the host's". */
  messageChannel?: string | null;
  /** The message arrived on a verified signed session. */
  signedSession: boolean;
};

/**
 * Decide the channel for one update message.
 *
 * - No message channel, or the host's own: the host channel.
 * - A message channel that is not a known channel: the host channel (as
 *   before; running the host's own channel changes nothing).
 * - A different valid channel on a signed session: the message channel.
 * - A different valid channel on an unsigned session: refused with
 *   {@link UpdatePreflightError} code `channel_pinned`.
 */
export function decideUpdateChannel(
  input: UpdateChannelDecisionInput,
): UpdateChannel {
  const requested = input.messageChannel?.trim();
  if (!requested || !isUpdateChannel(requested)) return input.hostChannel;
  if (requested === input.hostChannel) return input.hostChannel;
  if (input.signedSession) return requested;
  throw new UpdatePreflightError(
    CHANNEL_PINNED_CODE,
    `this server's update channel is ${input.hostChannel}; a change to ${requested} needs the control plane's signed session or re-running the installer on the host`,
  );
}
