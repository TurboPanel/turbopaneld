import type { UpdateApp, UpdateChannel } from "./types.ts";

export type UpdateChannelConfig = {
  app: UpdateApp;
  channel: UpdateChannel;
};

const VALID_CHANNELS: ReadonlySet<UpdateChannel> = new Set<UpdateChannel>([
  "trunk",
  "edge",
  "canary",
  "rc",
  "release",
]);

/** True when `value` names one of the update channels. */
export function isUpdateChannel(value: string): value is UpdateChannel {
  return VALID_CHANNELS.has(value as UpdateChannel);
}

/**
 * Resolve which update channel the daemon should follow.
 *
 * Reads `TURBOPANEL_UPDATE_CHANNEL` from the environment (default `release`:
 * a daemon installed with no channel follows the stable rail). Invalid values crash
 * at startup so misconfiguration is caught early.
 */
export function resolveUpdateChannelConfig(
  env: Record<string, string | undefined> = Deno.env.toObject(),
): UpdateChannelConfig {
  const raw = env.TURBOPANEL_UPDATE_CHANNEL?.trim();
  const value = raw || "release";

  if (!isUpdateChannel(value)) {
    const valid = [...VALID_CHANNELS].join(", ");
    throw new Error(
      `Invalid TURBOPANEL_UPDATE_CHANNEL: "${value}". Valid values: ${valid}`,
    );
  }

  return { app: "daemon", channel: value };
}
