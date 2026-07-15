import {
  buildAuthPayload,
  buildEnrollmentPayload,
  computePublicKeyFingerprint,
  generateDaemonKeypair,
  loadDaemonKeyFile,
  saveDaemonKeyFile,
  signChallenge,
  verifyChallenge,
} from "./keys.ts";

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno);

test("generateDaemonKeypair produces valid Ed25519 JWKs", async () => {
  const result = await generateDaemonKeypair();

  if (result.algorithm !== "Ed25519") {
    throw new Error("algorithm must be Ed25519");
  }
  if (result.publicJwk.kty !== "OKP" || result.publicJwk.crv !== "Ed25519") {
    throw new Error("publicJwk must be an Ed25519 OKP key");
  }
  if (result.privateJwk.kty !== "OKP" || result.privateJwk.crv !== "Ed25519") {
    throw new Error("privateJwk must be an Ed25519 OKP key");
  }
  if (typeof result.keyId !== "string" || result.keyId.length === 0) {
    throw new Error("keyId must be a non-empty string");
  }
  if (Number.isNaN(Date.parse(result.createdAt))) {
    throw new TypeError("createdAt must be a valid ISO date string");
  }
  if (!result.privateJwk.d) {
    throw new Error("privateJwk.d must be present");
  }
});

test("computePublicKeyFingerprint is deterministic", async () => {
  const keypair = await generateDaemonKeypair();

  const fingerprintOne = await computePublicKeyFingerprint(keypair.publicJwk);
  const fingerprintTwo = await computePublicKeyFingerprint(keypair.publicJwk);

  if (fingerprintOne !== fingerprintTwo) {
    throw new Error("fingerprints must be deterministic");
  }
  if (!/^[0-9a-f]{64}$/.test(fingerprintOne)) {
    throw new Error("fingerprint must be a 64-character hex string");
  }
});

test("buildEnrollmentPayload produces the exact expected string", () => {
  const payload = buildEnrollmentPayload({
    challengeId: "cid",
    nonce: "nonce",
    licenseId: "lid",
    machineId: "mid",
    hostname: "host",
    publicKeyFingerprint: "fp",
  });
  if (
    payload !==
      "turbopanel-daemon-enroll-v1\ncid\nnonce\nlid\nmid\nhost\nfp"
  ) {
    throw new Error("enrollment payload did not match expected shape");
  }
});

test("buildAuthPayload produces the exact expected string", () => {
  const payload = buildAuthPayload({
    challengeId: "cid",
    nonce: "nonce",
    serverId: "sid",
    keyId: "kid",
    machineId: "mid",
    hostname: "host",
  });
  if (
    payload !==
      "turbopanel-daemon-auth-v1\ncid\nnonce\nsid\nkid\nmid\nhost"
  ) {
    throw new Error("auth payload did not match expected shape");
  }
});

test("signChallenge and verifyChallenge round-trip for enrollment payload", async () => {
  const keypair = await generateDaemonKeypair();
  const payload = buildEnrollmentPayload({
    challengeId: "cid",
    nonce: "nonce",
    licenseId: "lid",
    machineId: "mid",
    hostname: "host",
    publicKeyFingerprint: "fp",
  });

  const signature = await signChallenge(keypair.privateJwk, payload);
  const isValid = await verifyChallenge(keypair.publicJwk, payload, signature);

  if (!isValid) {
    throw new Error("signature should verify");
  }
});

test("signChallenge and verifyChallenge round-trip for auth payload", async () => {
  const keypair = await generateDaemonKeypair();
  const payload = buildAuthPayload({
    challengeId: "cid",
    nonce: "nonce",
    serverId: "sid",
    keyId: "kid",
    machineId: "mid",
    hostname: "host",
  });

  const signature = await signChallenge(keypair.privateJwk, payload);
  const isValid = await verifyChallenge(keypair.publicJwk, payload, signature);

  if (!isValid) {
    throw new Error("signature should verify");
  }
});

test("verifyChallenge returns false for tampered payload", async () => {
  const keypair = await generateDaemonKeypair();
  const payload = buildAuthPayload({
    challengeId: "cid",
    nonce: "nonce",
    serverId: "sid",
    keyId: "kid",
    machineId: "mid",
    hostname: "host",
  });

  const signature = await signChallenge(keypair.privateJwk, payload);
  const isValid = await verifyChallenge(
    keypair.publicJwk,
    `${payload}tampered`,
    signature,
  );

  if (isValid) {
    throw new Error("tampered payload should fail verification");
  }
});

test("loadDaemonKeyFile returns null for missing file", async () => {
  const result = await loadDaemonKeyFile("/nonexistent/path/server-key.json");
  if (result !== null) {
    throw new Error("missing key file should return null");
  }
});

test("loadDaemonKeyFile returns null for structurally invalid JSON", async () => {
  const tempDir = await Deno.makeTempDir();
  const keyFilePath = `${tempDir}/server-key.json`;

  try {
    const malformedKeyFile = {
      algorithm: "Ed25519",
      keyId: "key-123",
      createdAt: "2026-01-01T00:00:00.000Z",
      publicJwk: "not-an-object",
      privateJwk: {},
    };
    await Deno.writeTextFile(keyFilePath, JSON.stringify(malformedKeyFile));

    const result = await loadDaemonKeyFile(keyFilePath);
    if (result !== null) {
      throw new Error("invalid daemon key file should return null");
    }
  } finally {
    await Deno.remove(tempDir, { recursive: true });
  }
});

test("saveDaemonKeyFile and loadDaemonKeyFile round-trip", async () => {
  const tempDir = await Deno.makeTempDir();
  const keyFilePath = `${tempDir}/server-key.json`;

  try {
    const keyFile = await generateDaemonKeypair();
    await saveDaemonKeyFile(keyFilePath, keyFile);
    const loaded = await loadDaemonKeyFile(keyFilePath);

    if (loaded === null) {
      throw new Error("expected key file to load");
    }
    if (loaded.keyId !== keyFile.keyId) {
      throw new Error("keyId mismatch after round-trip");
    }
    if (loaded.algorithm !== keyFile.algorithm) {
      throw new Error("algorithm mismatch after round-trip");
    }
    if (loaded.createdAt !== keyFile.createdAt) {
      throw new Error("createdAt mismatch after round-trip");
    }
    if (loaded.publicJwk.x !== keyFile.publicJwk.x) {
      throw new Error("publicJwk.x mismatch after round-trip");
    }

    const stats = await Deno.stat(keyFilePath);
    const mode = (stats.mode ?? 0) & 0o777;
    if (mode !== 0o600) {
      throw new Error(`expected file mode 600, got ${mode.toString(8)}`);
    }
  } finally {
    await Deno.remove(tempDir, { recursive: true });
  }
});
