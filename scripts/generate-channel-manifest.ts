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
const AMD64_SHA256 = requireEnv("AMD64_SHA256");
const AMD64_SIZE = requireEnvNumber("AMD64_SIZE");
const ARM64_SHA256 = requireEnv("ARM64_SHA256");
const ARM64_SIZE = requireEnvNumber("ARM64_SIZE");

const manifest: ChannelManifest = {
  schemaVersion: 1,
  app: "daemon",
  channel: "trunk",
  version: "0.0.0-trunk",
  branch: "trunk",
  buildId: BUILD_ID,
  commit: SHORT_SHA,
  builtAt: BUILT_AT,
  artifacts: {
    "linux-amd64": {
      path: `/daemon/trunk/${BUILD_ID}/linux-amd64`,
      sha256: AMD64_SHA256,
      size: AMD64_SIZE,
    },
    "linux-arm64": {
      path: `/daemon/trunk/${BUILD_ID}/linux-arm64`,
      sha256: ARM64_SHA256,
      size: ARM64_SIZE,
    },
  },
};

const json = JSON.stringify(manifest, null, 2) + "\n";
const outputPath = Deno.args[0];

if (outputPath) {
  await Deno.writeTextFile(outputPath, json);
} else {
  await Deno.stdout.write(new TextEncoder().encode(json));
}
