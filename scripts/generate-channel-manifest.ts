import type { ChannelManifest } from "../src/update/types.ts";

function requireEnv(name: string): string {
  const value = Deno.env.get(name);
  if (!value || value.trim() === "") {
    console.error(`Missing required environment variable: ${name}`);
    Deno.exit(1);
  }
  return value;
}

function requireEnvNumber(name: string): number {
  const value = requireEnv(name);
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) {
    console.error(`Invalid numeric environment variable: ${name}=${value}`);
    Deno.exit(1);
  }
  return parsed;
}

const BUILD_ID = requireEnv("BUILD_ID");
const SHORT_SHA = requireEnv("SHORT_SHA");
const BUILT_AT = requireEnv("BUILT_AT");
const SOURCE_SHA256 = requireEnv("SOURCE_SHA256");
const SOURCE_SIZE = requireEnvNumber("SOURCE_SIZE");

const DL_BASE_URL = Deno.env.get("DL_BASE_URL")?.trim() ||
  "https://dl.trbp.nl";
const DEFAULT_CONTROL_PLANE_URL =
  Deno.env.get("TURBOPANEL_DEFAULT_CONTROL_PLANE_URL")?.trim() ||
  "https://turbopanel.app";

const manifest: ChannelManifest = {
  schema: 1,
  channel: "trunk",
  commit: SHORT_SHA,
  buildId: BUILD_ID,
  builtAt: BUILT_AT,
  defaultControlPlaneUrl: DEFAULT_CONTROL_PLANE_URL,
  sourceArtifact: {
    url: `${DL_BASE_URL}/channels/trunk/daemon/source.tar.zst`,
    sha256: SOURCE_SHA256,
    size: SOURCE_SIZE,
  },
};

const json = JSON.stringify(manifest, null, 2) + "\n";
const outputPath = Deno.args[0];

if (outputPath) {
  await Deno.writeTextFile(outputPath, json);
} else {
  await Deno.stdout.write(new TextEncoder().encode(json));
}
