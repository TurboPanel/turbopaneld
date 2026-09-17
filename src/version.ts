import denoConfig from "../deno.json" with { type: "json" };

/**
 * The daemon's semver, read from deno.json at compile time — the one place
 * the number is typed for this repo. Everything that puts a version on a
 * wire (the hello's `daemonBuild.version`, `--version`, the channel
 * manifest's `version`) reads it from here; the release workflow asserts
 * the tag it is building matches it, so a tag and a binary can never
 * disagree.
 */
export const DAEMON_VERSION: string = denoConfig.version;
