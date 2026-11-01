import { assert, assertEquals, assertRejects, assertThrows } from "@std/assert";
import { join } from "@std/path";
import {
  parseTunnelConnectorsPayload,
  parseTunnelConnectorsResult,
  type TunnelConnectorsPayload,
} from "../contracts/commands-contracts.ts";
import type { RunResult } from "../deploy/ensure-principal.ts";
import {
  type ConnectorIo,
  installConnector,
  updateConnector,
} from "../tunnels/connector-service.ts";
import { handleTunnelConnectors } from "./tunnel-connectors.ts";

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno);

const ID_A = "0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d";
const ID_B = "1b2c3d4e-5f6a-4b7c-9d8e-0f1a2b3c4d5e";
/** A made-up run token that passes the token check; not a real one. */
const TOKEN = "dGVzdA".repeat(8);
const ENVELOPE = "tpdaemon.AAAA";

async function withIo(
  fn: (io: ConnectorIo, calls: string[]) => Promise<void>,
): Promise<void> {
  const dir = await Deno.makeTempDir({ prefix: "tunnel-connectors-test-" });
  const calls: string[] = [];
  const io: ConnectorIo = {
    layout: { configDir: join(dir, "etc") },
    workDir: dir,
    version: "2026.10.7",
    ensureBinary: () =>
      Promise.resolve("/opt/turbopanel/vendor/cloudflared/x/cloudflared"),
    probe: () => Promise.resolve({ kind: "unreachable" }),
    run: (command, args): Promise<RunResult> => {
      calls.push([command, ...args].join(" "));
      return Promise.resolve({ success: true, stdout: "", stderr: "" });
    },
  };
  try {
    await fn(io, calls);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
}

function payload(
  overrides: Partial<TunnelConnectorsPayload> = {},
): TunnelConnectorsPayload {
  return {
    install: [{ tunnelId: ID_A, tokenEnvelope: ENVELOPE }],
    remove: [],
    ...overrides,
  };
}

const unseal = (seen: string[][] = []) => (envelopes: string[]) => {
  seen.push(envelopes);
  return Promise.resolve(envelopes.map(() => TOKEN as string | null));
};

test("a new tunnel gets its connector, and the token is on no command line", async () => {
  await withIo(async (io, calls) => {
    const seen: string[][] = [];
    const result = await handleTunnelConnectors(payload(), "now", {
      io,
      decryptSecrets: unseal(seen),
    });
    assertEquals(result, { installed: [ID_A], unchanged: [], removed: [] });
    assertEquals(seen, [[ENVELOPE]]);
    assert(calls.some((call) => call.includes(`turbopanel-tunnel-${ID_A}`)));
    assertEquals(calls.filter((call) => call.includes(TOKEN)), []);
  });
});

test("a connector that already runs is left alone and its token is not unsealed again", async () => {
  await withIo(async (io, calls) => {
    await handleTunnelConnectors(payload(), "now", {
      io,
      decryptSecrets: unseal(),
    });
    calls.length = 0;
    const seen: string[][] = [];
    const result = await handleTunnelConnectors(payload(), "now", {
      io,
      decryptSecrets: unseal(seen),
    });
    assertEquals(result, { installed: [], unchanged: [ID_A], removed: [] });
    assertEquals(seen, []);
    assertEquals(calls, []);
  });
});

test("a removed tunnel's connector is stopped and its token copy deleted", async () => {
  await withIo(async (io, calls) => {
    await handleTunnelConnectors(payload(), "now", {
      io,
      decryptSecrets: unseal(),
    });
    calls.length = 0;
    const result = await handleTunnelConnectors(
      payload({ install: [], remove: [ID_A] }),
      "now",
      { io },
    );
    assertEquals(result, { installed: [], unchanged: [], removed: [ID_A] });
    assert(calls.some((call) => call.includes("disable --now")));
    assert(calls.some((call) => call.includes(`tunnel-env-remove ${ID_A}`)));
  });
});

test("removing a connector that was never installed is not an error", async () => {
  await withIo(async (io) => {
    const result = await handleTunnelConnectors(
      payload({ install: [], remove: [ID_B] }),
      "now",
      { io },
    );
    assertEquals(result, { installed: [], unchanged: [], removed: [ID_B] });
  });
});

test("a removal the host refuses fails the command", async () => {
  await withIo(async (io) => {
    const refusing: ConnectorIo = {
      ...io,
      run: (_command, args) =>
        Promise.resolve(
          args.includes("tunnel-env-remove")
            ? { success: false, stdout: "", stderr: "refused" }
            : { success: true, stdout: "", stderr: "" },
        ),
    };
    const error = await assertRejects(() =>
      handleTunnelConnectors(payload({ install: [], remove: [ID_B] }), "now", {
        io: refusing,
      })
    );
    assert(String(error).includes(ID_B));
  });
});

test("a token that cannot be unsealed fails the command and names only the tunnel", async () => {
  await withIo(async (io) => {
    const error = await assertRejects(() =>
      handleTunnelConnectors(payload(), "now", {
        io,
        decryptSecrets: () => Promise.resolve([null]),
      })
    );
    assert(String(error).includes(ID_A));
    assert(!String(error).includes(ENVELOPE));
  });
});

test("one tunnel failing does not stop the others, and the command still fails", async () => {
  await withIo(async (io, calls) => {
    const error = await assertRejects(() =>
      handleTunnelConnectors(
        payload({
          install: [
            { tunnelId: ID_A, tokenEnvelope: ENVELOPE },
            { tunnelId: ID_B, tokenEnvelope: ENVELOPE },
          ],
        }),
        "now",
        {
          io,
          decryptSecrets: () => Promise.resolve([null, TOKEN]),
        },
      )
    );
    assert(String(error).includes(ID_A));
    assert(calls.some((call) => call.includes(`turbopanel-tunnel-${ID_B}`)));
  });
});

test("an install needs the secret decryptor", async () => {
  await withIo(async (io) => {
    await assertRejects(() => handleTunnelConnectors(payload(), "now", { io }));
  });
});

test("the payload parser refuses the instance tunnel, a bad envelope and a repeat", () => {
  const ok = payload({ remove: [ID_B] });
  assertEquals(parseTunnelConnectorsPayload(ok), ok);
  for (const tunnelId of ["instance", "default", ID_A.toUpperCase(), ""]) {
    assertThrows(() =>
      parseTunnelConnectorsPayload(
        payload({ install: [{ tunnelId, tokenEnvelope: ENVELOPE }] }),
      )
    );
  }
  for (const tokenEnvelope of ["plain", "tpdaemon.", "tpsecret.AAAA"]) {
    assertThrows(() =>
      parseTunnelConnectorsPayload(
        payload({ install: [{ tunnelId: ID_A, tokenEnvelope }] }),
      )
    );
  }
  assertThrows(() =>
    parseTunnelConnectorsPayload(payload({ install: [], remove: [] }))
  );
  assertThrows(() => parseTunnelConnectorsPayload(payload({ remove: [ID_A] })));
});

test("the result parser keeps the three lists", () => {
  const result = { installed: [ID_A], unchanged: [], removed: [ID_B] };
  assertEquals(parseTunnelConnectorsResult(result), result);
  assertThrows(() => parseTunnelConnectorsResult({ installed: [ID_A] }));
});

/** An io whose second connector reports connected at once, so an update can finish. */
function updatable(io: ConnectorIo, calls: string[]): ConnectorIo {
  return {
    ...io,
    probe: () => Promise.resolve({ kind: "ready", connections: 4 }),
    portFree: () => Promise.resolve(true),
    unitExists: () => Promise.resolve(false),
    sleep: () => Promise.resolve(),
    run: (command, args) => {
      calls.push([command, ...args].join(" "));
      return Promise.resolve({
        success: true,
        stdout: args.includes("is-active") ? "active" : "",
        stderr: "",
      });
    },
  };
}

test("a tunnel moved to its second unit by an update is still present, so a resend leaves it alone", async () => {
  await withIo(async (base, calls) => {
    const io = updatable(base, calls);
    await installConnector(io, ID_A, TOKEN);
    io.version = "2026.6.0";
    assertEquals((await updateConnector(io, ID_A)).kind, "updated");
    calls.length = 0;
    const seen: string[][] = [];
    const result = await handleTunnelConnectors(payload(), "now", {
      io,
      decryptSecrets: unseal(seen),
    });
    assertEquals(result, { installed: [], unchanged: [ID_A], removed: [] });
    assertEquals(seen, []);
    assertEquals(calls, []);
  });
});

test("removing a tunnel whose connector moved to its second unit stops both units", async () => {
  await withIo(async (base, calls) => {
    const io = updatable(base, calls);
    await installConnector(io, ID_A, TOKEN);
    io.version = "2026.6.0";
    await updateConnector(io, ID_A);
    calls.length = 0;
    const result = await handleTunnelConnectors(
      { install: [], remove: [ID_A] },
      "now",
      { io, decryptSecrets: unseal() },
    );
    assertEquals(result, { installed: [], unchanged: [], removed: [ID_A] });
    for (const unit of [`${ID_A}.service`, `${ID_A}-b.service`]) {
      assert(
        calls.some((c) =>
          c.includes(`disable --now turbopanel-tunnel-${unit}`)
        ),
        unit,
      );
      assert(calls.some((c) => c.includes(`rm -f`) && c.includes(unit)), unit);
    }
    assert(calls.some((c) => c.includes(`tunnel-env-remove ${ID_A}`)));
    // Nothing remembers the tunnel any more.
    assertEquals(
      (await handleTunnelConnectors(
        { install: [], remove: [ID_A] },
        "now",
        { io },
      )).removed,
      [ID_A],
    );
  });
});
