import { assertEquals, assertRejects } from "@std/assert";
import { join } from "@std/path";
import { afterAll, beforeAll, describe, it } from "@std/testing/bdd";
import {
  applyOrchestrationEnv,
  buildCloudflaredFixtureBinary,
  createOrchestrationRuntimeFixture,
  type OrchestrationRuntimeFixture,
  restoreOrchestrationEnv,
  snapshotOrchestrationEnv,
} from "../testing/orchestration-fixtures.ts";

describe("ensureCloudflared", () => {
  let fixture: OrchestrationRuntimeFixture;
  let envSnapshot: Map<string, string | undefined>;
  let cloudflared: typeof import("./cloudflared.ts");
  let paths: typeof import("./paths.ts");

  beforeAll(async () => {
    envSnapshot = snapshotOrchestrationEnv();
    fixture = await createOrchestrationRuntimeFixture({
      withUvBinary: false,
      withAnsibleBinaries: false,
    });
    applyOrchestrationEnv(fixture.env);
    paths = await import("./paths.ts");
    cloudflared = await import("./cloudflared.ts");
  });

  afterAll(async () => {
    restoreOrchestrationEnv(envSnapshot);
    await fixture.layout.cleanup();
  });

  it("skips download when the pinned version is already installed", async () => {
    const bin = paths.cloudflaredBin();
    await Deno.mkdir(paths.cloudflaredDir(), { recursive: true });
    const bytes = await buildCloudflaredFixtureBinary(
      paths.CLOUDFLARED_VERSION,
    );
    await Deno.writeFile(bin, bytes);
    await Deno.chmod(bin, 0o755);

    const path = await cloudflared.ensureCloudflared();
    assertEquals(path, bin);
  });

  it("downloads and installs cloudflared when missing", async () => {
    const bin = paths.cloudflaredBin();
    await Deno.remove(bin).catch(() => {});

    const asset = paths.resolveCloudflaredAsset();
    const bytes = await buildCloudflaredFixtureBinary(
      paths.CLOUDFLARED_VERSION,
    );
    const url = paths.cloudflaredDownloadUrl(asset);
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (input) => {
      if (String(input) === url) {
        return Promise.resolve(
          new Response(new Uint8Array(bytes), { status: 200 }),
        );
      }
      return originalFetch(input);
    };

    try {
      const path = await cloudflared.ensureCloudflared();
      assertEquals(path, bin);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("throws when the download response is not ok", async () => {
    const bin = paths.cloudflaredBin();
    await Deno.remove(bin).catch(() => {});

    const asset = paths.resolveCloudflaredAsset();
    const url = paths.cloudflaredDownloadUrl(asset);
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (input) => {
      if (String(input) === url) {
        return Promise.resolve(new Response(null, { status: 503 }));
      }
      return originalFetch(input);
    };

    try {
      await assertRejects(
        () => cloudflared.ensureCloudflared(),
        Error,
        "Failed to download",
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("throws when post-install version verification fails", async () => {
    const bin = paths.cloudflaredBin();
    await Deno.mkdir(paths.cloudflaredDir(), { recursive: true });
    const bytes = await buildCloudflaredFixtureBinary("0.0.0-fixture");
    await Deno.writeFile(bin, bytes);
    await Deno.chmod(bin, 0o755);

    const asset = paths.resolveCloudflaredAsset();
    const url = paths.cloudflaredDownloadUrl(asset);
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (input) => {
      if (String(input) === url) {
        return Promise.resolve(
          new Response(new Uint8Array(bytes), { status: 200 }),
        );
      }
      return originalFetch(input);
    };

    try {
      await assertRejects(
        () => cloudflared.ensureCloudflared(),
        Error,
        "cloudflared install verification failed",
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("repoints current symlink after install", async () => {
    const bin = paths.cloudflaredBin();
    await Deno.mkdir(paths.cloudflaredDir(), { recursive: true });
    const bytes = await buildCloudflaredFixtureBinary(
      paths.CLOUDFLARED_VERSION,
    );
    await Deno.writeFile(bin, bytes);
    await Deno.chmod(bin, 0o755);
    await Deno.remove(paths.CLOUDFLARED_CURRENT_DIR).catch(() => {});

    const path = await cloudflared.ensureCloudflared();
    assertEquals(path, bin);
    const link = await Deno.readLink(paths.CLOUDFLARED_CURRENT_DIR);
    assertEquals(link.endsWith(paths.CLOUDFLARED_VERSION), true);
  });

  it("warns and continues when current is a non-empty directory", async () => {
    const bin = paths.cloudflaredBin();
    await Deno.mkdir(paths.cloudflaredDir(), { recursive: true });
    const bytes = await buildCloudflaredFixtureBinary(
      paths.CLOUDFLARED_VERSION,
    );
    await Deno.writeFile(bin, bytes);
    await Deno.chmod(bin, 0o755);

    await Deno.remove(paths.CLOUDFLARED_CURRENT_DIR).catch(() => {});
    await Deno.mkdir(paths.CLOUDFLARED_CURRENT_DIR, { recursive: true });
    await Deno.writeTextFile(
      join(paths.CLOUDFLARED_CURRENT_DIR, "blocker"),
      "keep",
    );

    const path = await cloudflared.ensureCloudflared();
    assertEquals(path, bin);
  });

  it("rethrows non-NotFound stat errors while probing the binary", async () => {
    const bin = paths.cloudflaredBin();
    const originalStat = Deno.stat;
    Deno.stat = (path) => {
      if (path === bin) {
        return Promise.reject(new Deno.errors.PermissionDenied("denied"));
      }
      return originalStat(path);
    };
    try {
      await assertRejects(
        () => cloudflared.ensureCloudflared(),
        Deno.errors.PermissionDenied,
      );
    } finally {
      Deno.stat = originalStat;
    }
  });

  it("treats a failing --version probe as missing and reinstalls", async () => {
    const bin = paths.cloudflaredBin();
    await Deno.mkdir(paths.cloudflaredDir(), { recursive: true });
    await Deno.writeTextFile(
      bin,
      `#!/bin/sh
echo "cloudflared boom"
exit 2
`,
    );
    await Deno.chmod(bin, 0o755);

    const good = await buildCloudflaredFixtureBinary(
      paths.CLOUDFLARED_VERSION,
    );
    const asset = paths.resolveCloudflaredAsset();
    const url = paths.cloudflaredDownloadUrl(asset);
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (input) => {
      if (String(input) === url) {
        return Promise.resolve(
          new Response(new Uint8Array(good), { status: 200 }),
        );
      }
      return originalFetch(input);
    };
    try {
      const path = await cloudflared.ensureCloudflared();
      assertEquals(path, bin);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("treats a version-less --version banner as missing", async () => {
    const bin = paths.cloudflaredBin();
    await Deno.mkdir(paths.cloudflaredDir(), { recursive: true });
    await Deno.writeTextFile(
      bin,
      `#!/bin/sh
echo "cloudflared (no version token)"
exit 0
`,
    );
    await Deno.chmod(bin, 0o755);

    const good = await buildCloudflaredFixtureBinary(
      paths.CLOUDFLARED_VERSION,
    );
    const asset = paths.resolveCloudflaredAsset();
    const url = paths.cloudflaredDownloadUrl(asset);
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (input) => {
      if (String(input) === url) {
        return Promise.resolve(
          new Response(new Uint8Array(good), { status: 200 }),
        );
      }
      return originalFetch(input);
    };
    try {
      const path = await cloudflared.ensureCloudflared();
      assertEquals(path, bin);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("treats a throwing --version probe as missing", async () => {
    const bin = paths.cloudflaredBin();
    await Deno.mkdir(paths.cloudflaredDir(), { recursive: true });
    await Deno.writeTextFile(bin, "#!/bin/sh\nexit 0\n");
    await Deno.chmod(bin, 0o755);
    const originalCommand = Deno.Command;
    let probes = 0;
    Deno.Command = class extends originalCommand {
      constructor(command: string | URL, options?: Deno.CommandOptions) {
        super(command, options);
        if (command === bin) {
          probes += 1;
          if (probes === 1) throw new TypeError("spawn failed");
        }
      }
    } as typeof Deno.Command;

    const good = await buildCloudflaredFixtureBinary(
      paths.CLOUDFLARED_VERSION,
    );
    const asset = paths.resolveCloudflaredAsset();
    const url = paths.cloudflaredDownloadUrl(asset);
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (input) => {
      if (String(input) === url) {
        return Promise.resolve(
          new Response(new Uint8Array(good), { status: 200 }),
        );
      }
      return originalFetch(input);
    };
    try {
      const path = await cloudflared.ensureCloudflared();
      assertEquals(path, bin);
    } finally {
      Deno.Command = originalCommand;
      globalThis.fetch = originalFetch;
    }
  });

  it("treats a throwing --version probe as missing after install", async () => {
    const bin = paths.cloudflaredBin();
    await Deno.remove(bin).catch(() => {});
    const asset = paths.resolveCloudflaredAsset();
    const url = paths.cloudflaredDownloadUrl(asset);
    const body = new TextEncoder().encode("#!/bin/sh\nexit 0\n");
    const originalFetch = globalThis.fetch;
    const originalCommand = Deno.Command;
    globalThis.fetch = (input) => {
      if (String(input) === url) {
        return Promise.resolve(new Response(body, { status: 200 }));
      }
      return originalFetch(input);
    };
    Deno.Command = class extends originalCommand {
      constructor(command: string | URL, options?: Deno.CommandOptions) {
        super(command, options);
      }
      override output(): Promise<Deno.CommandOutput> {
        return Promise.reject(new TypeError("version probe failed"));
      }
    } as typeof Deno.Command;
    try {
      await assertRejects(
        () => cloudflared.ensureCloudflared(),
        Error,
        "got none",
      );
    } finally {
      Deno.Command = originalCommand;
      globalThis.fetch = originalFetch;
    }
  });

  it("reports none when post-install --version cannot be parsed", async () => {
    const bin = paths.cloudflaredBin();
    await Deno.remove(bin).catch(() => {});
    const asset = paths.resolveCloudflaredAsset();
    const url = paths.cloudflaredDownloadUrl(asset);
    const body = new TextEncoder().encode("#!/bin/sh\nexit 2\n");
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (input) => {
      if (String(input) === url) {
        return Promise.resolve(new Response(body, { status: 200 }));
      }
      return originalFetch(input);
    };
    try {
      await assertRejects(
        () => cloudflared.ensureCloudflared(),
        Error,
        "got none",
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("warns when creating the current symlink fails", async () => {
    const bin = paths.cloudflaredBin();
    await Deno.mkdir(paths.cloudflaredDir(), { recursive: true });
    const bytes = await buildCloudflaredFixtureBinary(
      paths.CLOUDFLARED_VERSION,
    );
    await Deno.writeFile(bin, bytes);
    await Deno.chmod(bin, 0o755);
    await Deno.remove(paths.CLOUDFLARED_CURRENT_DIR, { recursive: true })
      .catch(() => {});

    const parent = join(paths.cloudflaredDir(), "..");
    const previousMode = (await Deno.stat(parent)).mode! & 0o777;
    await Deno.chmod(parent, 0o555);
    try {
      const path = await cloudflared.ensureCloudflared();
      assertEquals(path, bin);
    } finally {
      await Deno.chmod(parent, previousMode);
    }
  });
});
