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

  if (!VALID_CHANNELS.has(value as UpdateChannel)) {
    const valid = [...VALID_CHANNELS].join(", ");
    throw new Error(
      `Invalid TURBOPANEL_UPDATE_CHANNEL: "${value}". Valid values: ${valid}`,
    );
  }

  return { app: "daemon", channel: value as UpdateChannel };
}
