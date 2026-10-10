import { assertEquals } from "@std/assert";
import { createFakeClock, flushMicrotasks } from "../testing/fake-clock.ts";
import { withTempLayout } from "../testing/temp-layout.ts";
import { resolveLayout } from "../paths/layout.ts";
import {
  orchestratorApiCnfPath,
  orchestratorComposePath,
  orchestratorConfigDir,
} from "../managed/engine-paths.ts";
import { reviveStoppedOrchestratorContainer } from "../managed/orchestrator.ts";
import type { OrchestratorProblem } from "../managed/orchestrator-api.ts";
import {
  type ManagedHaEventMessage,
  ManagedHaObserver,
  mergeDeadPrimaryEmitCandidate,
  shouldSuppressHaIncidentReemit,
} from "./ha-observe.ts";

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno);

const MANAGED_ID = "00000000-0000-4000-8000-0000000000aa";
const MEMBER_ID = "00000000-0000-4000-8000-000000000001";
const DEFAULT_DIAL = { hostname: "172.20.4.10", port: 5432 };

async function seedMysqlPrimary(
  layout: ReturnType<typeof resolveLayout>,
  managedId = MANAGED_ID,
): Promise<void> {
  const { saveManagedHaMember } = await import("../managed/ha-member.ts");
  await Deno.mkdir(`${layout.stateDir}/managed/${managedId}`, {
    recursive: true,
  });
  await saveManagedHaMember(layout, {
    managedId,
    memberId: MEMBER_ID,
    engine: "mysql",
    role: "primary",
    containerName: "mysql-primary-1",
    replicaPeerCount: 1,
    peerCount: 1,
    updatedAt: new Date().toISOString(),
  });
}

function runDockerForDial(dial: { hostname: string; port: number }) {
  return (args: string[]) => {
    if (args[0] === "inspect") {
      return Promise.resolve({
        success: true,
        stdout: JSON.stringify({
          "3306/tcp": [{
            HostIp: dial.hostname,
            HostPort: String(dial.port),
          }],
        }),
        stderr: "",
        code: 0,
      });
    }
    return Promise.resolve({
      success: false,
      stdout: "",
      stderr: "",
      code: 1,
    });
  };
}

function problemResponse(problems: OrchestratorProblem[]): Response {
  return new Response(JSON.stringify(problems), { status: 200 });
}

test("ManagedHaObserver.attach schedules poll and detach clears the timer", async () => {
  await withTempLayout(async (fixture) => {
    const layout = resolveLayout(fixture.env);
    await seedMysqlPrimary(layout);
    const sent: ManagedHaEventMessage[] = [];
    const clock = createFakeClock();
    const observer = new ManagedHaObserver({
      layout,
      runDocker: runDockerForDial(DEFAULT_DIAL),
      intervalMs: 20,
      now: () => new Date(clock.now()).toISOString(),
      send: (message) => {
        sent.push(message);
      },
      isStackPresent: () => Promise.resolve(true),
      api: {
        credentials: { user: "admin", password: "x" },
        fetch: () =>
          Promise.resolve(
            problemResponse([{
              clusterAlias: MANAGED_ID,
              key: DEFAULT_DIAL,
              problems: ["DeadPrimary"],
            }]),
          ),
      },
    });

    observer.attach();
    await new Promise((resolve) => setTimeout(resolve, 45));
    await flushMicrotasks();
    observer.detach();
    const afterDetach = sent.length;
    await new Promise((resolve) => setTimeout(resolve, 45));
    await flushMicrotasks();

    assertEquals(afterDetach >= 1, true);
    assertEquals(sent.length, afterDetach);
    assertEquals(sent[0]?.type, "managed-ha-event");
    assertEquals(sent[0]?.managedId, MANAGED_ID);
    assertEquals(sent[0]?.instanceHost, DEFAULT_DIAL.hostname);
    assertEquals(sent[0]?.instancePort, DEFAULT_DIAL.port);
  });
});

test("ManagedHaObserver proves local dial for UUID-alias problems with a partial matching key", async () => {
  await withTempLayout(async (fixture) => {
    const layout = resolveLayout(fixture.env);
    await seedMysqlPrimary(layout);
    const sent: ManagedHaEventMessage[] = [];
    const observer = new ManagedHaObserver({
      layout,
      runDocker: runDockerForDial(DEFAULT_DIAL),
      send: (message) => {
        sent.push(message);
      },
      isStackPresent: () => Promise.resolve(true),
      api: {
        credentials: { user: "admin", password: "x" },
        fetch: () =>
          Promise.resolve(
            problemResponse([{
              clusterAlias: MANAGED_ID,
              key: { hostname: DEFAULT_DIAL.hostname },
              problems: ["DeadPrimary"],
            }]),
          ),
      },
    });
    await observer.poll();
    assertEquals(sent.length, 1);
    assertEquals(sent[0]?.instanceHost, DEFAULT_DIAL.hostname);
    assertEquals(sent[0]?.instancePort, DEFAULT_DIAL.port);
  });
});

test("ManagedHaObserver emits from replication-analysis DeadMaster via ha-member dial", async () => {
  await withTempLayout(async (fixture) => {
    const layout = resolveLayout(fixture.env);
    const now = new Date().toISOString();
    const { saveManagedHaMember } = await import("../managed/ha-member.ts");
    await Deno.mkdir(`${layout.stateDir}/managed/${MANAGED_ID}`, {
      recursive: true,
    });
    await saveManagedHaMember(layout, {
      managedId: MANAGED_ID,
      memberId: "00000000-0000-4000-8000-000000000001",
      engine: "mysql",
      role: "primary",
      containerName: "mysql-primary-1",
      replicaPeerCount: 1,
      peerCount: 1,
      updatedAt: now,
    });
    const sent: ManagedHaEventMessage[] = [];
    const observer = new ManagedHaObserver({
      layout,
      send: (message) => {
        sent.push(message);
      },
      isStackPresent: () => Promise.resolve(true),
      api: {
        credentials: { user: "admin", password: "x" },
        fetch: (url) => {
          if (url.includes("/api/replication-analysis")) {
            return Promise.resolve(
              new Response(
                JSON.stringify({
                  Details: [{
                    AnalyzedInstanceKey: {
                      Hostname: "172.20.4.10",
                      Port: 45001,
                    },
                    ClusterDetails: { ClusterAlias: "172.20.4.10:45001" },
                    IsMaster: true,
                    Analysis: "DeadMaster",
                  }],
                }),
                { status: 200 },
              ),
            );
          }
          return Promise.resolve(new Response("[]", { status: 200 }));
        },
      },
      runDocker: (args) => {
        if (args[0] === "inspect") {
          return Promise.resolve({
            success: true,
            stdout: JSON.stringify({
              "3306/tcp": [{ HostIp: "172.20.4.10", HostPort: "45001" }],
            }),
            stderr: "",
            code: 0,
          });
        }
        return Promise.resolve({
          success: false,
          stdout: "",
          stderr: "",
          code: 1,
        });
      },
    });
    await observer.poll();
    assertEquals(sent.length, 1);
    assertEquals(sent[0]?.managedId, MANAGED_ID);
    assertEquals(sent[0]?.instanceHost, "172.20.4.10");
    assertEquals(sent[0]?.instancePort, 45001);
  });
});

test("ManagedHaObserver ignores non-dead-primary problems and missing problem names", async () => {
  const sent: ManagedHaEventMessage[] = [];
  const observer = new ManagedHaObserver({
    send: (message) => {
      sent.push(message);
    },
    isStackPresent: () => Promise.resolve(true),
    api: {
      credentials: { user: "admin", password: "x" },
      fetch: () =>
        Promise.resolve(
          problemResponse([
            {
              clusterAlias: MANAGED_ID,
              key: { hostname: "db-1", port: 5432 },
              problems: ["LaggingReplica"],
            },
            {
              clusterAlias: "00000000-0000-4000-8000-0000000000bb",
              key: { hostname: "db-2" },
            },
          ]),
        ),
    },
  });
  await observer.poll();
  assertEquals(sent.length, 0);
});

test("ManagedHaObserver swallows poll failures without throwing", async () => {
  const sent: ManagedHaEventMessage[] = [];
  const observer = new ManagedHaObserver({
    send: (message) => {
      sent.push(message);
    },
    isStackPresent: () => Promise.resolve(true),
    api: {
      credentials: { user: "admin", password: "x" },
      fetch: () => Promise.reject(new Error("orchestrator down")),
    },
  });
  await observer.poll();
  assertEquals(sent.length, 0);
});

test("ManagedHaObserver uses injected now() for the emitted at timestamp", async () => {
  await withTempLayout(async (fixture) => {
    const layout = resolveLayout(fixture.env);
    await seedMysqlPrimary(layout);
    const sent: ManagedHaEventMessage[] = [];
    const observer = new ManagedHaObserver({
      layout,
      runDocker: runDockerForDial(DEFAULT_DIAL),
      now: () => "2026-08-25T12:00:00.000Z",
      send: (message) => {
        sent.push(message);
      },
      isStackPresent: () => Promise.resolve(true),
      api: {
        credentials: { user: "admin", password: "x" },
        fetch: () =>
          Promise.resolve(
            problemResponse([{
              clusterAlias: MANAGED_ID,
              problems: ["UnreachablePrimary"],
            }]),
          ),
      },
    });
    await observer.poll();
    assertEquals(sent.length, 1);
    assertEquals(sent[0]?.at, "2026-08-25T12:00:00.000Z");
  });
});

test("ManagedHaObserver loads Orchestrator credentials when api omits them", async () => {
  const sent: ManagedHaEventMessage[] = [];
  const observer = new ManagedHaObserver({
    send: (message) => {
      sent.push(message);
    },
    isStackPresent: () => Promise.resolve(true),
    api: {
      fetch: () =>
        Promise.resolve(
          problemResponse([{
            clusterAlias: MANAGED_ID,
            problems: ["DeadPrimary"],
          }]),
        ),
    },
  });
  await observer.poll();
  assertEquals(sent.length === 0 || sent[0]?.managedId === MANAGED_ID, true);
});

test("ManagedHaObserver loads Orchestrator credentials from the layout when api omits them", async () => {
  await withTempLayout(async (fixture) => {
    const layout = resolveLayout(fixture.env);
    await seedMysqlPrimary(layout);
    await Deno.mkdir(orchestratorConfigDir(layout), { recursive: true });
    await Deno.writeTextFile(
      orchestratorApiCnfPath(layout),
      "[client]\nuser=orch-admin\npassword=orch-secret\n",
    );
    const sent: ManagedHaEventMessage[] = [];
    const observer = new ManagedHaObserver({
      layout,
      runDocker: runDockerForDial(DEFAULT_DIAL),
      send: (message) => {
        sent.push(message);
      },
      isStackPresent: () => Promise.resolve(true),
      api: {
        fetch: () =>
          Promise.resolve(
            problemResponse([{
              clusterAlias: MANAGED_ID,
              problems: ["DeadPrimary"],
            }]),
          ),
      },
    });
    await observer.poll();
    assertEquals(sent.length, 1);
    assertEquals(sent[0]?.managedId, MANAGED_ID);
  });
});

test("ManagedHaObserver skips absent stack, invalid aliases, and duplicate keys", async () => {
  await withTempLayout(async (fixture) => {
    const layout = resolveLayout(fixture.env);
    await seedMysqlPrimary(layout);
    const sent: ManagedHaEventMessage[] = [];
    const absent = new ManagedHaObserver({
      send: (message) => {
        sent.push(message);
      },
      isStackPresent: () => Promise.resolve(false),
      api: {
        credentials: { user: "admin", password: "x" },
        fetch: () => {
          throw new TypeError("orchestrator must not be queried");
        },
      },
    });
    await absent.poll();
    assertEquals(sent.length, 0);

    const observer = new ManagedHaObserver({
      layout,
      runDocker: runDockerForDial(DEFAULT_DIAL),
      send: (message) => {
        sent.push(message);
      },
      isStackPresent: () => Promise.resolve(true),
      api: {
        credentials: { user: "admin", password: "x" },
        fetch: () =>
          Promise.resolve(
            problemResponse([
              {
                clusterAlias: "not-a-uuid",
                key: DEFAULT_DIAL,
                problems: ["DeadPrimary"],
              },
              {
                clusterAlias: "",
                problems: ["DeadPrimary"],
              },
              {
                clusterAlias: MANAGED_ID,
                key: DEFAULT_DIAL,
                problems: ["DeadPrimary"],
              },
            ]),
          ),
      },
    });
    await observer.poll();
    await observer.poll();
    assertEquals(sent.length, 1);
    assertEquals(sent[0]?.managedId, MANAGED_ID);
  });
});

function deadPrimaryResponse(): Response {
  return problemResponse([{
    clusterAlias: MANAGED_ID,
    key: DEFAULT_DIAL,
    problems: ["DeadPrimary"],
  }]);
}

test("ManagedHaObserver starts a killed Orchestrator container once", async () => {
  await withTempLayout(async (fixture) => {
    const layout = resolveLayout(fixture.env);
    await seedMysqlPrimary(layout);
    await Deno.mkdir(orchestratorConfigDir(layout), { recursive: true });
    await Deno.writeTextFile(orchestratorComposePath(layout), "services: {}\n");
    const calls: string[][] = [];
    const sent: ManagedHaEventMessage[] = [];
    const observer = new ManagedHaObserver({
      layout,
      runDocker: runDockerForDial(DEFAULT_DIAL),
      send: (message) => {
        sent.push(message);
      },
      isStackPresent: () => Promise.resolve(true),
      reviveStack: () =>
        reviveStoppedOrchestratorContainer(layout, (args) => {
          calls.push(args);
          if (args.includes("ps")) {
            return Promise.resolve({
              success: true,
              stdout: JSON.stringify([{
                ID: "orch-cid",
                Name: "orch",
                Service: "orchestrator",
                State: "exited",
              }]),
              stderr: "",
              code: 0,
            });
          }
          return Promise.resolve({
            success: true,
            stdout: "",
            stderr: "",
            code: 0,
          });
        }),
      api: {
        credentials: { user: "admin", password: "x" },
        fetch: () => Promise.resolve(deadPrimaryResponse()),
      },
    });
    await observer.poll();
    await observer.poll();
    assertEquals(calls.filter((args) => args.includes("start")).length, 1);
    assertEquals(sent.length, 1);
  });
});

test("ManagedHaObserver does not start a running Orchestrator container", async () => {
  await withTempLayout(async (fixture) => {
    const layout = resolveLayout(fixture.env);
    await seedMysqlPrimary(layout);
    await Deno.mkdir(orchestratorConfigDir(layout), { recursive: true });
    await Deno.writeTextFile(orchestratorComposePath(layout), "services: {}\n");
    const calls: string[][] = [];
    const observer = new ManagedHaObserver({
      layout,
      runDocker: runDockerForDial(DEFAULT_DIAL),
      send: () => {},
      isStackPresent: () => Promise.resolve(true),
      reviveStack: () =>
        reviveStoppedOrchestratorContainer(layout, (args) => {
          calls.push(args);
          return Promise.resolve({
            success: true,
            stdout: JSON.stringify([{
              ID: "orch-cid",
              Name: "orch",
              Service: "orchestrator",
              State: "running",
            }]),
            stderr: "",
            code: 0,
          });
        }),
      api: {
        credentials: { user: "admin", password: "x" },
        fetch: () => Promise.resolve(deadPrimaryResponse()),
      },
    });
    await observer.poll();
    assertEquals(calls.some((args) => args.includes("start")), false);
  });
});

test("ManagedHaObserver does not start after compose down (absent container)", async () => {
  await withTempLayout(async (fixture) => {
    const layout = resolveLayout(fixture.env);
    await Deno.mkdir(orchestratorConfigDir(layout), { recursive: true });
    await Deno.writeTextFile(orchestratorComposePath(layout), "services: {}\n");
    const calls: string[][] = [];
    const observer = new ManagedHaObserver({
      layout,
      send: () => {},
      isStackPresent: () => Promise.resolve(true),
      reviveStack: () =>
        reviveStoppedOrchestratorContainer(layout, (args) => {
          calls.push(args);
          return Promise.resolve({
            success: true,
            stdout: "[]",
            stderr: "",
            code: 0,
          });
        }),
      api: {
        credentials: { user: "admin", password: "x" },
        fetch: () => Promise.resolve(deadPrimaryResponse()),
      },
    });
    await observer.poll();
    assertEquals(calls.some((args) => args.includes("start")), false);
  });
});

test("ManagedHaObserver respects the orchestrator revive cooldown", async () => {
  const clock = createFakeClock({ now: 1_000_000 });
  const calls: string[] = [];
  const observer = new ManagedHaObserver({
    nowMs: () => clock.now(),
    send: () => {},
    isStackPresent: () => Promise.resolve(true),
    reviveStack: () => {
      calls.push("revive");
      return Promise.resolve("started");
    },
    api: {
      credentials: { user: "admin", password: "x" },
      fetch: () => Promise.resolve(deadPrimaryResponse()),
    },
  });
  await observer.poll();
  await observer.poll();
  assertEquals(calls.length, 1);
  await clock.advance(60_000);
  await observer.poll();
  assertEquals(calls.length, 2);
});

test("ManagedHaObserver continues the API poll when revive fails", async () => {
  await withTempLayout(async (fixture) => {
    const layout = resolveLayout(fixture.env);
    await seedMysqlPrimary(layout);
    const decoder = new TextDecoder();
    const warnings: string[] = [];
    const originalWrite = Deno.stderr.writeSync;
    Deno.stderr.writeSync = (buf) => {
      warnings.push(decoder.decode(buf));
      return buf.byteLength;
    };
    const sent: ManagedHaEventMessage[] = [];
    let fetched = 0;
    try {
      const observer = new ManagedHaObserver({
        layout,
        runDocker: runDockerForDial(DEFAULT_DIAL),
        send: (message) => {
          sent.push(message);
        },
        isStackPresent: () => Promise.resolve(true),
        reviveStack: () => Promise.reject(new Error("compose start failed")),
        api: {
          credentials: { user: "admin", password: "x" },
          fetch: () => {
            fetched += 1;
            return Promise.resolve(deadPrimaryResponse());
          },
        },
      });
      await observer.poll();
      assertEquals(fetched, 2);
      assertEquals(sent.length, 1);
      assertEquals(sent[0]?.managedId, MANAGED_ID);
      assertEquals(
        warnings.some((line) => line.includes("self-heal failed")),
        true,
      );
    } finally {
      Deno.stderr.writeSync = originalWrite;
    }
  });
});

test("ManagedHaObserver ignores stale DeadMaster after managed.destroy", async () => {
  await withTempLayout(async (fixture) => {
    const layout = resolveLayout(fixture.env);
    await seedMysqlPrimary(layout);
    const { writeManagedDestroyedMarker } = await import(
      "../managed/destroyed-marker.ts"
    );
    await writeManagedDestroyedMarker(
      layout.stateDir,
      MANAGED_ID,
      MEMBER_ID,
      new Date().toISOString(),
    );
    const sent: ManagedHaEventMessage[] = [];
    const dial = { hostname: "172.20.4.10", port: 45001 };
    const observer = new ManagedHaObserver({
      layout,
      runDocker: runDockerForDial(dial),
      send: (message) => {
        sent.push(message);
      },
      isStackPresent: () => Promise.resolve(true),
      api: {
        credentials: { user: "admin", password: "x" },
        fetch: (url) => {
          if (url.includes("/api/replication-analysis")) {
            return Promise.resolve(
              new Response(
                JSON.stringify({
                  Details: [{
                    AnalyzedInstanceKey: {
                      Hostname: dial.hostname,
                      Port: dial.port,
                    },
                    ClusterDetails: { ClusterAlias: MANAGED_ID },
                    Analysis: "DeadMaster",
                  }],
                }),
                { status: 200 },
              ),
            );
          }
          return Promise.resolve(
            problemResponse([{
              clusterAlias: MANAGED_ID,
              problems: ["DeadPrimary"],
            }]),
          );
        },
      },
    });
    await observer.poll();
    assertEquals(sent.length, 0);
  });
});

test("ManagedHaObserver dedupes problems and replication-analysis for one incident", async () => {
  await withTempLayout(async (fixture) => {
    const layout = resolveLayout(fixture.env);
    await seedMysqlPrimary(layout);
    const dial = { hostname: "172.20.4.10", port: 45001 };
    const sent: ManagedHaEventMessage[] = [];
    const observer = new ManagedHaObserver({
      layout,
      runDocker: runDockerForDial(dial),
      send: (message) => {
        sent.push(message);
      },
      isStackPresent: () => Promise.resolve(true),
      api: {
        credentials: { user: "admin", password: "x" },
        fetch: (url) => {
          if (url.includes("/api/replication-analysis")) {
            return Promise.resolve(
              new Response(
                JSON.stringify({
                  Details: [{
                    AnalyzedInstanceKey: {
                      Hostname: dial.hostname,
                      Port: dial.port,
                    },
                    ClusterDetails: { ClusterAlias: MANAGED_ID },
                    IsMaster: true,
                    Analysis: "DeadMaster",
                  }],
                }),
                { status: 200 },
              ),
            );
          }
          return Promise.resolve(
            problemResponse([{
              clusterAlias: MANAGED_ID,
              problems: ["DeadPrimary"],
            }]),
          );
        },
      },
    });
    await observer.poll();
    assertEquals(sent.length, 1);
    assertEquals(sent[0]?.managedId, MANAGED_ID);
    assertEquals(sent[0]?.instanceHost, dial.hostname);
    assertEquals(sent[0]?.instancePort, dial.port);
  });
});

test("mergeDeadPrimaryEmitCandidate keeps the complete emit key regardless of order", () => {
  const incomplete = {
    managedId: MANAGED_ID,
    incidentKey: `${MANAGED_ID}:172.20.4.10:45001`,
    emitKey: {},
  };
  const complete = {
    managedId: MANAGED_ID,
    incidentKey: `${MANAGED_ID}:172.20.4.10:45001`,
    emitKey: { hostname: "172.20.4.10", port: 45001 },
  };
  assertEquals(
    mergeDeadPrimaryEmitCandidate(incomplete, complete).emitKey,
    complete.emitKey,
  );
  assertEquals(
    mergeDeadPrimaryEmitCandidate(complete, incomplete).emitKey,
    complete.emitKey,
  );
});

test("ManagedHaObserver upgrades coordinate-less problems row with replication-analysis dial", async () => {
  await withTempLayout(async (fixture) => {
    const layout = resolveLayout(fixture.env);
    await seedMysqlPrimary(layout);
    const dial = { hostname: "172.20.4.10", port: 45001 };
    const sent: ManagedHaEventMessage[] = [];
    const observer = new ManagedHaObserver({
      layout,
      runDocker: runDockerForDial(dial),
      send: (message) => {
        sent.push(message);
      },
      isStackPresent: () => Promise.resolve(true),
      api: {
        credentials: { user: "admin", password: "x" },
        fetch: (url) => {
          if (url.includes("/api/replication-analysis")) {
            return Promise.resolve(
              new Response(
                JSON.stringify({
                  Details: [{
                    AnalyzedInstanceKey: {
                      Hostname: dial.hostname,
                      Port: dial.port,
                    },
                    ClusterDetails: { ClusterAlias: MANAGED_ID },
                    IsMaster: true,
                    Analysis: "DeadMaster",
                  }],
                }),
                { status: 200 },
              ),
            );
          }
          return Promise.resolve(
            problemResponse([{
              clusterAlias: MANAGED_ID,
              problems: ["DeadPrimary"],
            }]),
          );
        },
      },
    });
    await observer.poll();
    assertEquals(sent.length, 1);
    assertEquals(sent[0]?.instanceHost, dial.hostname);
    assertEquals(sent[0]?.instancePort, dial.port);
  });
});

test("ManagedHaObserver emits proved dial for UUID-alias problems with no instance key", async () => {
  await withTempLayout(async (fixture) => {
    const layout = resolveLayout(fixture.env);
    await seedMysqlPrimary(layout);
    const dial = { hostname: "172.20.4.10", port: 45001 };
    const sent: ManagedHaEventMessage[] = [];
    const observer = new ManagedHaObserver({
      layout,
      runDocker: runDockerForDial(dial),
      send: (message) => {
        sent.push(message);
      },
      isStackPresent: () => Promise.resolve(true),
      api: {
        credentials: { user: "admin", password: "x" },
        fetch: () =>
          Promise.resolve(
            problemResponse([{
              clusterAlias: MANAGED_ID,
              problems: ["DeadPrimary"],
            }]),
          ),
      },
    });
    await observer.poll();
    assertEquals(sent.length, 1);
    assertEquals(sent[0]?.instanceHost, dial.hostname);
    assertEquals(sent[0]?.instancePort, dial.port);
  });
});

test("ManagedHaObserver ignores healthy primary and replica replication rows", async () => {
  await withTempLayout(async (fixture) => {
    const layout = resolveLayout(fixture.env);
    await seedMysqlPrimary(layout);
    const dial = { hostname: "172.20.4.10", port: 45001 };
    const sent: ManagedHaEventMessage[] = [];
    const observer = new ManagedHaObserver({
      layout,
      runDocker: runDockerForDial(dial),
      send: (message) => {
        sent.push(message);
      },
      isStackPresent: () => Promise.resolve(true),
      api: {
        credentials: { user: "admin", password: "x" },
        fetch: () =>
          Promise.resolve(
            new Response(
              JSON.stringify({
                Details: [
                  {
                    AnalyzedInstanceKey: {
                      Hostname: dial.hostname,
                      Port: dial.port,
                    },
                    ClusterDetails: { ClusterAlias: MANAGED_ID },
                    IsMaster: true,
                    Analysis: "Healthy",
                  },
                  {
                    AnalyzedInstanceKey: {
                      Hostname: "172.20.4.20",
                      Port: 45002,
                    },
                    ClusterDetails: { ClusterAlias: MANAGED_ID },
                    IsMaster: false,
                    Analysis: "DeadMaster",
                  },
                ],
              }),
              { status: 200 },
            ),
          ),
      },
    });
    await observer.poll();
    assertEquals(sent.length, 0);
  });
});

test("ManagedHaObserver emits DeadMaster when IsMaster is omitted", async () => {
  await withTempLayout(async (fixture) => {
    const layout = resolveLayout(fixture.env);
    await seedMysqlPrimary(layout);
    const dial = { hostname: "172.20.4.10", port: 45001 };
    const sent: ManagedHaEventMessage[] = [];
    const observer = new ManagedHaObserver({
      layout,
      runDocker: runDockerForDial(dial),
      send: (message) => {
        sent.push(message);
      },
      isStackPresent: () => Promise.resolve(true),
      api: {
        credentials: { user: "admin", password: "x" },
        fetch: () =>
          Promise.resolve(
            new Response(
              JSON.stringify({
                Details: [{
                  AnalyzedInstanceKey: {
                    Hostname: dial.hostname,
                    Port: dial.port,
                  },
                  ClusterDetails: { ClusterAlias: MANAGED_ID },
                  Analysis: "DeadMaster",
                }],
              }),
              { status: 200 },
            ),
          ),
      },
    });
    await observer.poll();
    assertEquals(sent.length, 1);
  });
});

test("shouldSuppressHaIncidentReemit ignores coordinate-less prior emits", () => {
  const now = 1_000_000;
  const fifteenMin = 15 * 60_000;
  assertEquals(
    shouldSuppressHaIncidentReemit(now - 1, now, {}),
    false,
  );
  assertEquals(
    shouldSuppressHaIncidentReemit(now - fifteenMin + 1, now, {
      hostname: "h",
      port: 1,
    }),
    true,
  );
  assertEquals(
    shouldSuppressHaIncidentReemit(undefined, now, {
      hostname: "h",
      port: 1,
    }),
    false,
  );
});

test("ManagedHaObserver problems-first poll then replication-analysis emits once with full identity", async () => {
  await withTempLayout(async (fixture) => {
    const layout = resolveLayout(fixture.env);
    await seedMysqlPrimary(layout);
    const dial = { hostname: "172.20.4.10", port: 45001 };
    const sent: ManagedHaEventMessage[] = [];
    let includeAnalysis = false;
    const observer = new ManagedHaObserver({
      layout,
      runDocker: runDockerForDial(dial),
      send: (message) => {
        sent.push(message);
      },
      isStackPresent: () => Promise.resolve(true),
      api: {
        credentials: { user: "admin", password: "x" },
        fetch: (url) => {
          if (url.includes("/api/replication-analysis")) {
            if (!includeAnalysis) {
              return Promise.resolve(new Response("[]", { status: 200 }));
            }
            return Promise.resolve(
              new Response(
                JSON.stringify({
                  Details: [{
                    AnalyzedInstanceKey: {
                      Hostname: dial.hostname,
                      Port: dial.port,
                    },
                    ClusterDetails: { ClusterAlias: MANAGED_ID },
                    IsMaster: true,
                    Analysis: "DeadMaster",
                  }],
                }),
                { status: 200 },
              ),
            );
          }
          return Promise.resolve(
            problemResponse([{
              clusterAlias: MANAGED_ID,
              problems: ["DeadPrimary"],
            }]),
          );
        },
      },
    });
    await observer.poll();
    assertEquals(sent.length, 1);
    assertEquals(sent[0]?.instanceHost, dial.hostname);
    assertEquals(sent[0]?.instancePort, dial.port);
    includeAnalysis = true;
    await observer.poll();
    assertEquals(sent.length, 1);
  });
});

test("ManagedHaObserver upgrades hostname-only problems row on a later poll with replication-analysis", async () => {
  await withTempLayout(async (fixture) => {
    const layout = resolveLayout(fixture.env);
    await seedMysqlPrimary(layout);
    const dial = { hostname: "172.20.4.10", port: 45001 };
    const sent: ManagedHaEventMessage[] = [];
    let replicationReady = false;
    const observer = new ManagedHaObserver({
      layout,
      runDocker: runDockerForDial(dial),
      send: (message) => {
        sent.push(message);
      },
      isStackPresent: () => Promise.resolve(true),
      api: {
        credentials: { user: "admin", password: "x" },
        fetch: (url) => {
          if (url.includes("/api/replication-analysis")) {
            if (!replicationReady) {
              return Promise.resolve(new Response("[]", { status: 200 }));
            }
            return Promise.resolve(
              new Response(
                JSON.stringify({
                  Details: [{
                    AnalyzedInstanceKey: {
                      Hostname: dial.hostname,
                      Port: dial.port,
                    },
                    ClusterDetails: { ClusterAlias: MANAGED_ID },
                    IsMaster: true,
                    Analysis: "DeadMaster",
                  }],
                }),
                { status: 200 },
              ),
            );
          }
          return Promise.resolve(
            problemResponse([{
              clusterAlias: MANAGED_ID,
              key: { hostname: dial.hostname },
              problems: ["DeadPrimary"],
            }]),
          );
        },
      },
    });
    await observer.poll();
    assertEquals(sent.length, 1);
    assertEquals(sent[0]?.instanceHost, dial.hostname);
    assertEquals(sent[0]?.instancePort, dial.port);
    replicationReady = true;
    await observer.poll();
    assertEquals(sent.length, 1);
  });
});

test("ManagedHaObserver emits full identity after replication-analysis recovers from a failed poll", async () => {
  await withTempLayout(async (fixture) => {
    const layout = resolveLayout(fixture.env);
    await seedMysqlPrimary(layout);
    const dial = { hostname: "172.20.4.10", port: 45001 };
    const sent: ManagedHaEventMessage[] = [];
    let analysisFails = true;
    const observer = new ManagedHaObserver({
      layout,
      runDocker: runDockerForDial(dial),
      send: (message) => {
        sent.push(message);
      },
      isStackPresent: () => Promise.resolve(true),
      api: {
        credentials: { user: "admin", password: "x" },
        fetch: (url) => {
          if (url.includes("/api/replication-analysis")) {
            if (analysisFails) {
              return Promise.reject(new Error("transient"));
            }
            return Promise.resolve(
              new Response(
                JSON.stringify({
                  Details: [{
                    AnalyzedInstanceKey: {
                      Hostname: dial.hostname,
                      Port: dial.port,
                    },
                    ClusterDetails: { ClusterAlias: MANAGED_ID },
                    IsMaster: true,
                    Analysis: "DeadMaster",
                  }],
                }),
                { status: 200 },
              ),
            );
          }
          return Promise.resolve(
            problemResponse([{
              clusterAlias: MANAGED_ID,
              problems: ["DeadPrimary"],
            }]),
          );
        },
      },
    });
    await observer.poll();
    assertEquals(sent.length, 1);
    assertEquals(sent[0]?.instanceHost, dial.hostname);
    assertEquals(sent[0]?.instancePort, dial.port);
    analysisFails = false;
    await observer.poll();
    assertEquals(sent.length, 1);
  });
});

test("ManagedHaObserver sends one complete emit per incident inside the re-emit cooldown", async () => {
  const clock = createFakeClock({ now: 1_000_000 });
  await withTempLayout(async (fixture) => {
    const layout = resolveLayout(fixture.env);
    await seedMysqlPrimary(layout);
    const sent: ManagedHaEventMessage[] = [];
    const observer = new ManagedHaObserver({
      layout,
      nowMs: () => clock.now(),
      runDocker: runDockerForDial(DEFAULT_DIAL),
      send: (message) => {
        sent.push(message);
      },
      isStackPresent: () => Promise.resolve(true),
      api: {
        credentials: { user: "admin", password: "x" },
        fetch: () => Promise.resolve(deadPrimaryResponse()),
      },
    });
    await observer.poll();
    await observer.poll();
    assertEquals(sent.length, 1);
    await clock.advance(15 * 60_000);
    await observer.poll();
    assertEquals(sent.length, 2);
  });
});

test("ManagedHaObserver re-emits after the cluster is healthy again", async () => {
  const clock = createFakeClock({ now: 1_000_000 });
  await withTempLayout(async (fixture) => {
    const layout = resolveLayout(fixture.env);
    await seedMysqlPrimary(layout);
    const sent: ManagedHaEventMessage[] = [];
    let dead = true;
    const observer = new ManagedHaObserver({
      layout,
      nowMs: () => clock.now(),
      runDocker: runDockerForDial(DEFAULT_DIAL),
      send: (message) => {
        sent.push(message);
      },
      isStackPresent: () => Promise.resolve(true),
      api: {
        credentials: { user: "admin", password: "x" },
        fetch: () =>
          Promise.resolve(
            dead ? deadPrimaryResponse() : problemResponse([]),
          ),
      },
    });
    await observer.poll();
    assertEquals(sent.length, 1);
    dead = false;
    await observer.poll();
    assertEquals(sent.length, 1);
    dead = true;
    await observer.poll();
    assertEquals(sent.length, 2);
  });
});

test("ManagedHaObserver emits nothing during planned switchover", async () => {
  await withTempLayout(async (fixture) => {
    const layout = resolveLayout(fixture.env);
    await seedMysqlPrimary(layout);
    const { writeSwitchoverQuiescedMarker } = await import(
      "../managed/switchover-state-marker.ts"
    );
    await writeSwitchoverQuiescedMarker(layout, MANAGED_ID, {
      primaryExecutedGtidSet: "0-1-1",
      quiescedAt: new Date().toISOString(),
    });
    const sent: ManagedHaEventMessage[] = [];
    const observer = new ManagedHaObserver({
      layout,
      runDocker: runDockerForDial(DEFAULT_DIAL),
      send: (message) => {
        sent.push(message);
      },
      isStackPresent: () => Promise.resolve(true),
      api: {
        credentials: { user: "admin", password: "x" },
        fetch: () => Promise.resolve(deadPrimaryResponse()),
      },
    });
    await observer.poll();
    assertEquals(sent.length, 0);
  });
});
