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
 *
 * The same holds for the build inside the channel. A message may carry a
 * manifest URL; on an unsigned session it may only name what the host channel
 * publishes right now ({@link decideMessageManifest},
 * {@link assertMessageManifestIsChannelHead}), so a plain message cannot pick
 * another build or reach another channel through the URL.
 */
import type { UpdateChannel } from "../update/types.ts";
import {
  isUpdateChannel,
  resolveUpdateChannelConfig,
} from "../update/config.ts";
import {
  builtinChannelManifestUrl,
  isExactBuildManifestUrl,
  pinnedChannelManifestUrl,
  type ReleaseArtifactKind,
} from "../update/urls.ts";
import { UpdatePreflightError } from "./run-reconcile.ts";

/** `errorCode` on the update result when a message channel is refused. */
export const CHANNEL_PINNED_CODE = "channel_pinned";

/** `errorCode` when a message names a channel this daemon does not know. */
export const CHANNEL_UNKNOWN_CODE = "channel_unknown";

/** `errorCode` when an unsigned message names a build the channel does not publish now. */
export const MANIFEST_PINNED_CODE = "manifest_pinned";

/** How much of a refused, message-supplied value an error repeats. */
const QUOTED_VALUE_MAX = 120;

function quoted(value: string): string {
  return JSON.stringify(
    value.length > QUOTED_VALUE_MAX
      ? `${value.slice(0, QUOTED_VALUE_MAX)}…`
      : value,
  );
}

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
 * - A message channel that is not a known channel: refused with code
 *   `channel_unknown`, signed session or not. Running the host channel in its
 *   place would leave the control plane believing the named channel ran.
 * - A different valid channel on a signed session: the message channel.
 * - A different valid channel on an unsigned session: refused with
 *   {@link UpdatePreflightError} code `channel_pinned`.
 */
export function decideUpdateChannel(
  input: UpdateChannelDecisionInput,
): UpdateChannel {
  const requested = input.messageChannel?.trim();
  if (!requested) return input.hostChannel;
  if (!isUpdateChannel(requested)) {
    throw new UpdatePreflightError(
      CHANNEL_UNKNOWN_CODE,
      `the control plane named update channel ${
        quoted(requested)
      }, which this daemon does not know; nothing was installed (this server's update channel is ${input.hostChannel})`,
    );
  }
  if (requested === input.hostChannel) return input.hostChannel;
  if (input.signedSession) return requested;
  throw new UpdatePreflightError(
    CHANNEL_PINNED_CODE,
    `this server's update channel is ${input.hostChannel}; a change to ${requested} needs the control plane's signed session or re-running the installer on the host`,
  );
}

export type MessageManifestDecisionInput = {
  /** The package the URL belongs to: its release rail is checked. */
  kind: ReleaseArtifactKind;
  /** The channel decided for the message ({@link decideUpdateChannel}). */
  channel: UpdateChannel;
  /** The manifest URL the message names; empty or absent means none. */
  messageUrl?: string | null;
  /** The message arrived on a verified signed session. */
  signedSession: boolean;
  /**
   * A development overlay host (`TURBOPANEL_DL_BASE` set on the host). Its
   * builds do not come from the built-in rail, so there is no channel
   * manifest to hold a message to.
   */
  overlay?: boolean;
};

/**
 * What the caller still has to do before a message manifest URL may be used.
 *
 * - `none`: use the URL as before (or there is none).
 * - `head`: resolve and verify the signed manifest at `headUrl` (the
 *   channel's own pointer), then pass its `version` to
 *   {@link assertMessageManifestIsChannelHead}.
 */
export type MessageManifestDecision =
  | { check: "none" }
  | { check: "head"; headUrl: string };

/**
 * Decide whether a message's manifest URL needs holding to the channel.
 *
 * A signed session, no URL, or a development overlay host: nothing to check,
 * as before. On an unsigned session:
 *
 * - The channel's own manifest URL is the same as naming none.
 * - A URL that names one exact build must be compared with what the channel
 *   publishes now (`head`).
 * - Anything else (another channel's manifest, any other floating URL) is
 *   refused with code `manifest_pinned`, and so is every URL when the
 *   channel has no built-in manifest location to compare with.
 *
 * The control plane targets the channel's current build, so an honest
 * unsigned run passes; a message that names an older or a different build
 * does not. The host-side way to hold a build is the installer's
 * `--manifest-url`.
 */
export function decideMessageManifest(
  input: MessageManifestDecisionInput,
): MessageManifestDecision {
  const url = input.messageUrl?.trim();
  if (!url || input.signedSession || input.overlay) return { check: "none" };
  const headUrl = builtinChannelManifestUrl(input.channel, input.kind);
  if (headUrl === null) {
    throw new UpdatePreflightError(
      MANIFEST_PINNED_CODE,
      `this server's update channel ${input.channel} has no published manifest to compare with, so an unsigned message cannot name a build; this needs the control plane's signed session or the installer on the host`,
    );
  }
  if (url === headUrl) return { check: "none" };
  if (!isExactBuildManifestUrl(input.kind, url)) {
    throw new UpdatePreflightError(
      MANIFEST_PINNED_CODE,
      `an unsigned message may only name the ${input.channel} channel's own ${input.kind} manifest; it named ${
        quoted(url)
      }`,
    );
  }
  return { check: "head", headUrl };
}

/**
 * Hold an exact-build message URL to the build the channel publishes now.
 *
 * `headVersion` is the `version` of the verified manifest at the `headUrl`
 * {@link decideMessageManifest} returned. The message URL passes only when
 * it is that build's own manifest URL; a missing version proves nothing and
 * is refused. Code `manifest_pinned`.
 */
export function assertMessageManifestIsChannelHead(input: {
  kind: ReleaseArtifactKind;
  channel: UpdateChannel;
  messageUrl: string;
  headVersion?: string | null;
}): void {
  const url = input.messageUrl.trim();
  const headVersion = input.headVersion?.trim();
  const expected = headVersion
    ? pinnedChannelManifestUrl(input.kind, input.channel, headVersion)
    : null;
  if (expected !== null && url === expected) return;
  throw new UpdatePreflightError(
    MANIFEST_PINNED_CODE,
    `an unsigned message may only name the ${input.kind} build the ${input.channel} channel publishes now (${
      headVersion ? quoted(headVersion) : "version unknown"
    }); it named ${
      quoted(url)
    }. Another build needs the control plane's signed session or the installer on the host with --manifest-url`,
  );
}
