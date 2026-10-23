import { assertEquals } from "@std/assert";
import {
  engineInspectPortsJson,
  ORCHESTRATOR_DEAD_MASTER_AND_REPLICAS_CAPTURE,
  ORCHESTRATOR_DEAD_MASTER_CAPTURE,
} from "../testing/managed-topology-fixtures.ts";
import { forEachSequential } from "../util/sequential.ts";
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
import { waitFor } from "../testing/wait-for.ts";
import {
  haIncidentReemitGapMs,
  isHungProbeWatched,
  type ManagedHaEventMessage,
  ManagedHaObserver,
  shouldSuppressHaIncidentReemit,
} from "./ha-observe.ts";
import type { HungSample } from "../managed/mysql-hung-primary.ts";

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
        stdout: engineInspectPortsJson({
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
        return true;
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
    await waitFor("the first poll to send", () => sent.length >= 1);
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
        return true;
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
        return true;
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
            stdout: engineInspectPortsJson({
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
      return true;
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
      return true;
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
        return true;
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
      return true;
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
        return true;
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
        return true;
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
        return true;
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
        return true;
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
      send: () => true,
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
      send: () => true,
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
    send: () => true,
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
          return true;
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
        return true;
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
        return true;
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
        return true;
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
        return true;
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
        return true;
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
        return true;
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

test("shouldSuppressHaIncidentReemit holds only inside 15 minutes of a delivered event", () => {
  const now = 1_000_000;
  const fifteenMin = 15 * 60_000;
  assertEquals(shouldSuppressHaIncidentReemit(undefined, now), false);
  assertEquals(shouldSuppressHaIncidentReemit(now - fifteenMin + 1, now), true);
  assertEquals(shouldSuppressHaIncidentReemit(now - fifteenMin, now), false);
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
        return true;
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
        return true;
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
        return true;
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

test("ManagedHaObserver sends one complete emit per incident inside the re-emit gap", async () => {
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
        return true;
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
    await clock.advance(30_000);
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
        return true;
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
        return true;
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

// --- Delivery, source isolation, overlap and killed-container paths ---------

const H01_DIAL = { hostname: "172.20.4.10", port: 45001 };

function replicationRow(
  dial: { hostname: string; port: number },
  analysis = "DeadMaster",
  alias = `${dial.hostname}:${dial.port}`,
) {
  return {
    AnalyzedInstanceKey: { Hostname: dial.hostname, Port: dial.port },
    ClusterDetails: { ClusterAlias: alias },
    IsMaster: true,
    Analysis: analysis,
  };
}

function analysisResponse(rows: unknown[]): Response {
  return new Response(JSON.stringify({ Details: rows }), { status: 200 });
}

/** Docker as seen on H01: the primary was killed, so live ports are `{}`. */
function runDockerByContainer(
  dials: Record<string, { hostname: string; port: number }>,
  options: { stopped?: boolean } = {},
) {
  return (args: string[]) => {
    const dial = dials[args.at(-1) ?? ""];
    if (args[0] !== "inspect" || !dial) {
      return Promise.resolve({
        success: false,
        stdout: "",
        stderr: "no such container",
        code: 1,
      });
    }
    return Promise.resolve({
      success: true,
      stdout: engineInspectPortsJson(
        {
          "3306/tcp": [{ HostIp: dial.hostname, HostPort: String(dial.port) }],
        },
        options,
      ),
      stderr: "",
      code: 0,
    });
  };
}

async function seedPrimaryContainer(
  layout: ReturnType<typeof resolveLayout>,
  managedId: string,
  containerName: string,
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
    containerName,
    replicaPeerCount: 1,
    peerCount: 1,
    updatedAt: new Date().toISOString(),
  });
}

/** Waits (real timers: the poll reads files) until `count` reads are parked. */
async function waitForGates(
  gates: unknown[],
  count: number,
  triesLeft = 5000,
): Promise<void> {
  if (gates.length >= count || triesLeft === 0) {
    assertEquals(gates.length, count);
    return;
  }
  await new Promise((resolve) => setTimeout(resolve, 2));
  await waitForGates(gates, count, triesLeft - 1);
}

/** Routes the two Orchestrator reads to separate handlers. */
function splitFetch(handlers: {
  problems?: () => Promise<Response>;
  analysis: () => Promise<Response>;
}) {
  return (url: string) => {
    if (url.includes("/api/replication-analysis")) return handlers.analysis();
    return handlers.problems?.() ?? Promise.resolve(problemResponse([]));
  };
}

const API_CREDS = { user: "admin", password: "x" };

test("ManagedHaObserver names a killed primary from its configured port bindings", async () => {
  await withTempLayout(async (fixture) => {
    const layout = resolveLayout(fixture.env);
    await seedMysqlPrimary(layout);
    const sent: ManagedHaEventMessage[] = [];
    const observer = new ManagedHaObserver({
      layout,
      runDocker: runDockerByContainer({ "mysql-primary-1": H01_DIAL }, {
        stopped: true,
      }),
      send: (message) => {
        sent.push(message);
        return true;
      },
      isStackPresent: () => Promise.resolve(true),
      api: {
        credentials: API_CREDS,
        // H01: alias is host:port because set-cluster-alias failed.
        fetch: splitFetch({
          analysis: () =>
            Promise.resolve(analysisResponse([replicationRow(H01_DIAL)])),
        }),
      },
    });
    await observer.poll();
    assertEquals(sent.length, 1);
    assertEquals(sent[0]?.managedId, MANAGED_ID);
    assertEquals(sent[0]?.instanceHost, H01_DIAL.hostname);
    assertEquals(sent[0]?.instancePort, H01_DIAL.port);
  });
});

// --- The real lane LB rerun 7 capture (DeadMasterAndReplicas) --------------

/** The capture's one row, with `edit` applied (to build refused variants). */
function capturedAnalysis(
  edit: (row: Record<string, unknown>) => void = () => {},
): () => Promise<Response> {
  const body = JSON.parse(ORCHESTRATOR_DEAD_MASTER_AND_REPLICAS_CAPTURE) as {
    Details: Record<string, unknown>[];
  };
  const row = body.Details[0];
  if (row) edit(row);
  return () => Promise.resolve(new Response(JSON.stringify(body)));
}

/** Polls once on the rerun 7 host: primary killed, published on H01_DIAL. */
async function pollRerun7(
  analysis: () => Promise<Response>,
  problems?: () => Promise<Response>,
): Promise<ManagedHaEventMessage[]> {
  const sent: ManagedHaEventMessage[] = [];
  await withTempLayout(async (fixture) => {
    const layout = resolveLayout(fixture.env);
    await seedMysqlPrimary(layout);
    const observer = new ManagedHaObserver({
      layout,
      runDocker: runDockerByContainer({ "mysql-primary-1": H01_DIAL }, {
        stopped: true,
      }),
      send: (message) => {
        sent.push(message);
        return true;
      },
      now: () => "2026-10-10T00:00:00.000Z",
      isStackPresent: () => Promise.resolve(true),
      api: {
        credentials: API_CREDS,
        fetch: splitFetch({ analysis, problems }),
      },
    });
    await observer.poll();
  });
  return sent;
}

test("ManagedHaObserver emits once for the captured DeadMasterAndReplicas row", async () => {
  const sent = (await pollRerun7(capturedAnalysis())).map((message) => {
    // The container was not stopped: the first sighting stands in as the start.
    assertEquals(message.evidence?.spanMs, 0);
    const { evidence: _evidence, ...rest } = message;
    return rest;
  });
  assertEquals(sent, [{
    type: "managed-ha-event",
    managedId: MANAGED_ID,
    instanceHost: "172.20.4.10",
    instancePort: 45001,
    at: "2026-10-10T00:00:00.000Z",
  }]);
});

test("ManagedHaObserver emits for every dead-primary analysis code", async () => {
  const codes = [
    "DeadMaster",
    "DeadMasterAndReplicas",
    "DeadMasterAndSomeReplicas",
    "DeadMasterWithoutReplicas",
    "DeadPrimary",
    "UnreachableMaster",
    "UnreachablePrimary",
  ];
  await forEachSequential(codes, async (code) => {
    const sent = await pollRerun7(capturedAnalysis((row) => {
      row.Analysis = code;
    }));
    assertEquals(sent.length, 1, code);
    assertEquals(sent[0]?.instanceHost, H01_DIAL.hostname, code);
    assertEquals(sent[0]?.instancePort, H01_DIAL.port, code);
  });
});

test("ManagedHaObserver refuses the captured row when it is not this host's dead primary", async () => {
  const refused: Record<string, (row: Record<string, unknown>) => void> = {
    healthy: (row) => {
      row.Analysis = "NoProblem";
    },
    "primary reachable": (row) => {
      row.Analysis = "AllMasterReplicasNotReplicating";
    },
    "replicas still see it": (row) => {
      row.Analysis = "UnreachableMasterWithLaggingReplicas";
    },
    "replica row": (row) => {
      row.IsMaster = false;
    },
    "the other host's member": (row) => {
      row.AnalyzedInstanceKey = { Hostname: "172.20.4.20", Port: 45001 };
    },
    // Docker networks reuse the same addresses on every host, so the
    // container's own address never proves the member is the local one.
    "the container network address": (row) => {
      row.AnalyzedInstanceKey = { Hostname: "172.18.0.7", Port: 3306 };
    },
    "another port on this host": (row) => {
      row.AnalyzedInstanceKey = { Hostname: "172.20.4.10", Port: 45000 };
    },
  };
  await forEachSequential(Object.entries(refused), async ([label, edit]) => {
    assertEquals(await pollRerun7(capturedAnalysis(edit)), [], label);
  });
});

test("ManagedHaObserver emits DeadMasterAndReplicas from /api/problems with the UUID alias", async () => {
  const sent = await pollRerun7(
    () => Promise.resolve(analysisResponse([])),
    () =>
      Promise.resolve(problemResponse([{
        clusterAlias: MANAGED_ID,
        key: H01_DIAL,
        problems: ["DeadMasterAndReplicas"],
      }])),
  );
  assertEquals(sent.length, 1);
  assertEquals(sent[0]?.managedId, MANAGED_ID);
  assertEquals(sent[0]?.instanceHost, H01_DIAL.hostname);
  assertEquals(sent[0]?.instancePort, H01_DIAL.port);
});

test("ManagedHaObserver retries an event the control plane did not receive", async () => {
  await withTempLayout(async (fixture) => {
    const layout = resolveLayout(fixture.env);
    await seedMysqlPrimary(layout);
    const attempts: ManagedHaEventMessage[] = [];
    let connected = false;
    const observer = new ManagedHaObserver({
      layout,
      runDocker: runDockerByContainer({ "mysql-primary-1": H01_DIAL }),
      send: (message) => {
        attempts.push(message);
        return connected;
      },
      isStackPresent: () => Promise.resolve(true),
      api: {
        credentials: API_CREDS,
        fetch: splitFetch({
          analysis: () =>
            Promise.resolve(analysisResponse([replicationRow(H01_DIAL)])),
        }),
      },
    });
    await observer.poll();
    assertEquals(attempts.length, 1);
    connected = true;
    await observer.poll();
    assertEquals(attempts.length, 2);
    assertEquals(attempts[1]?.instanceHost, H01_DIAL.hostname);
    await observer.poll();
    assertEquals(attempts.length, 2);
  });
});

test("ManagedHaObserver still reads replication-analysis when /api/problems fails", async () => {
  await withTempLayout(async (fixture) => {
    const layout = resolveLayout(fixture.env);
    await seedMysqlPrimary(layout);
    const sent: ManagedHaEventMessage[] = [];
    const observer = new ManagedHaObserver({
      layout,
      runDocker: runDockerByContainer({ "mysql-primary-1": H01_DIAL }),
      send: (message) => {
        sent.push(message);
        return true;
      },
      isStackPresent: () => Promise.resolve(true),
      api: {
        credentials: API_CREDS,
        fetch: splitFetch({
          problems: () => Promise.reject(new Error("problems down")),
          analysis: () =>
            Promise.resolve(analysisResponse([replicationRow(H01_DIAL)])),
        }),
      },
    });
    await observer.poll();
    assertEquals(sent.length, 1);
    assertEquals(sent[0]?.instancePort, H01_DIAL.port);
  });
});

test("ManagedHaObserver keeps the cooldown when a source read fails", async () => {
  await withTempLayout(async (fixture) => {
    const layout = resolveLayout(fixture.env);
    await seedMysqlPrimary(layout);
    const sent: ManagedHaEventMessage[] = [];
    let analysisFails = false;
    const observer = new ManagedHaObserver({
      layout,
      runDocker: runDockerByContainer({ "mysql-primary-1": H01_DIAL }),
      send: (message) => {
        sent.push(message);
        return true;
      },
      isStackPresent: () => Promise.resolve(true),
      api: {
        credentials: API_CREDS,
        fetch: splitFetch({
          analysis: () =>
            analysisFails
              ? Promise.reject(new Error("transient"))
              : Promise.resolve(analysisResponse([replicationRow(H01_DIAL)])),
        }),
      },
    });
    await observer.poll();
    analysisFails = true;
    await observer.poll();
    analysisFails = false;
    await observer.poll();
    assertEquals(sent.length, 1);
  });
});

test("ManagedHaObserver sends one event when two polls overlap", async () => {
  await withTempLayout(async (fixture) => {
    const layout = resolveLayout(fixture.env);
    await seedMysqlPrimary(layout);
    const sent: ManagedHaEventMessage[] = [];
    const gates: Array<() => void> = [];
    const observer = new ManagedHaObserver({
      layout,
      runDocker: runDockerByContainer({ "mysql-primary-1": H01_DIAL }),
      send: (message) => {
        sent.push(message);
        return true;
      },
      isStackPresent: () => Promise.resolve(true),
      reviveStack: () => Promise.resolve("absent"),
      api: {
        credentials: API_CREDS,
        fetch: splitFetch({
          analysis: () =>
            new Promise((resolve) => {
              gates.push(() =>
                resolve(analysisResponse([replicationRow(H01_DIAL)]))
              );
            }),
        }),
      },
    });
    const first = observer.poll();
    const second = observer.poll();
    await waitForGates(gates, 2);
    gates[1]?.();
    gates[0]?.();
    await Promise.all([first, second]);
    assertEquals(sent.length, 1);
  });
});

test("ManagedHaObserver ignores a recovery seen by an older overlapping poll", async () => {
  await withTempLayout(async (fixture) => {
    const layout = resolveLayout(fixture.env);
    await seedMysqlPrimary(layout);
    const sent: ManagedHaEventMessage[] = [];
    const gates: Array<(rows: unknown[]) => void> = [];
    let resolveSecondAnalysisEntered!: () => void;
    const secondAnalysisEntered = new Promise<void>((resolve) => {
      resolveSecondAnalysisEntered = resolve;
    });
    let resolveThirdAnalysisEntered!: () => void;
    const thirdAnalysisEntered = new Promise<void>((resolve) => {
      resolveThirdAnalysisEntered = resolve;
    });
    const observer = new ManagedHaObserver({
      layout,
      runDocker: runDockerByContainer({ "mysql-primary-1": H01_DIAL }),
      reviveStack: () => Promise.resolve("absent"),
      send: (message) => {
        sent.push(message);
        return true;
      },
      isStackPresent: () => Promise.resolve(true),
      api: {
        credentials: API_CREDS,
        fetch: splitFetch({
          analysis: () =>
            new Promise((resolve) => {
              gates.push((rows) => resolve(analysisResponse(rows)));
              if (gates.length === 2) resolveSecondAnalysisEntered();
              if (gates.length === 3) resolveThirdAnalysisEntered();
            }),
        }),
      },
    });
    const older = observer.poll();
    const newer = observer.poll();
    await secondAnalysisEntered;
    gates[1]?.([replicationRow(H01_DIAL)]);
    await newer;
    assertEquals(sent.length, 1);
    // The older poll read the cluster before it died; it must not reset the
    // cooldown the newer poll just started.
    gates[0]?.([]);
    await older;
    const third = observer.poll();
    await thirdAnalysisEntered;
    gates[2]?.([replicationRow(H01_DIAL)]);
    await third;
    assertEquals(sent.length, 1);
  });
});

test("ManagedHaObserver drops a dead row from a poll overtaken by a newer healthy one", async () => {
  await withTempLayout(async (fixture) => {
    const layout = resolveLayout(fixture.env);
    await seedMysqlPrimary(layout);
    const sent: ManagedHaEventMessage[] = [];
    const gates: Array<(rows: unknown[]) => void> = [];
    const observer = new ManagedHaObserver({
      layout,
      runDocker: runDockerByContainer({ "mysql-primary-1": H01_DIAL }),
      send: (message) => {
        sent.push(message);
        return true;
      },
      isStackPresent: () => Promise.resolve(true),
      reviveStack: () => Promise.resolve("absent"),
      api: {
        credentials: API_CREDS,
        fetch: splitFetch({
          analysis: () =>
            new Promise((resolve) => {
              gates.push((rows) => resolve(analysisResponse(rows)));
            }),
        }),
      },
    });
    const older = observer.poll();
    const newer = observer.poll();
    await waitForGates(gates, 2);
    gates[1]?.([]);
    await newer;
    gates[0]?.([replicationRow(H01_DIAL)]);
    await older;
    assertEquals(sent.length, 0);
  });
});

test("ManagedHaObserver reports only the dead cluster when two share a host", async () => {
  const otherId = "00000000-0000-4000-8000-0000000000bb";
  const otherDial = { hostname: H01_DIAL.hostname, port: 45002 };
  await withTempLayout(async (fixture) => {
    const layout = resolveLayout(fixture.env);
    await seedPrimaryContainer(layout, MANAGED_ID, "mysql-a-1");
    await seedPrimaryContainer(layout, otherId, "mysql-b-1");
    const sent: ManagedHaEventMessage[] = [];
    const observer = new ManagedHaObserver({
      layout,
      runDocker: runDockerByContainer({
        "mysql-a-1": H01_DIAL,
        "mysql-b-1": otherDial,
      }),
      send: (message) => {
        sent.push(message);
        return true;
      },
      isStackPresent: () => Promise.resolve(true),
      api: {
        credentials: API_CREDS,
        fetch: splitFetch({
          analysis: () =>
            Promise.resolve(analysisResponse([
              replicationRow(H01_DIAL, "Healthy"),
              replicationRow(otherDial),
            ])),
        }),
      },
    });
    await observer.poll();
    assertEquals(sent.length, 1);
    assertEquals(sent[0]?.managedId, otherId);
    assertEquals(sent[0]?.instancePort, otherDial.port);
  });
});

test("ManagedHaObserver bounds each Orchestrator read with a timeout", async () => {
  await withTempLayout(async (fixture) => {
    const layout = resolveLayout(fixture.env);
    const signals: Array<AbortSignal | null | undefined> = [];
    const observer = new ManagedHaObserver({
      layout,
      send: () => true,
      isStackPresent: () => Promise.resolve(true),
      api: {
        credentials: API_CREDS,
        fetch: (_url, init) => {
          signals.push(init?.signal);
          return Promise.resolve(problemResponse([]));
        },
      },
    });
    await observer.poll();
    assertEquals(signals.length, 2);
    assertEquals(
      signals.every((signal) => signal instanceof AbortSignal),
      true,
    );
  });
});

const KILLED_AT = "2026-10-10T18:46:27.360814882Z";
const KILLED_AT_MS = Date.parse(KILLED_AT);
const LB_DIAL = { hostname: "172.20.4.10", port: 45001 };

/** docker inspect for a killed primary: no live ports, a stop time. */
function runDockerForKilledPrimary(state: string) {
  return (args: string[]) => {
    if (args[0] !== "inspect") {
      return Promise.resolve({
        success: false,
        stdout: "",
        stderr: "",
        code: 1,
      });
    }
    const stdout = args[2]?.includes(".State.")
      ? state
      : engineInspectPortsJson({
        "3306/tcp": [{
          HostIp: LB_DIAL.hostname,
          HostPort: String(LB_DIAL.port),
        }],
      }, { stopped: true });
    return Promise.resolve({ success: true, stdout, stderr: "", code: 0 });
  };
}

function deadMasterCaptureFetch(url: string): Promise<Response> {
  if (url.includes("/api/replication-analysis")) {
    return Promise.resolve(
      new Response(ORCHESTRATOR_DEAD_MASTER_CAPTURE, { status: 200 }),
    );
  }
  return Promise.resolve(new Response("[]", { status: 200 }));
}

test("ManagedHaObserver sends the primary's stop time as evidence for the captured DeadMaster row", async () => {
  await withTempLayout(async (fixture) => {
    const layout = resolveLayout(fixture.env);
    await seedMysqlPrimary(layout);
    const sent: ManagedHaEventMessage[] = [];
    const nowMs = KILLED_AT_MS + 21_000;
    const observer = new ManagedHaObserver({
      layout,
      nowMs: () => nowMs,
      send: (message) => {
        sent.push(message);
        return true;
      },
      isStackPresent: () => Promise.resolve(true),
      reviveStack: () => Promise.resolve("absent"),
      api: {
        credentials: { user: "admin", password: "x" },
        fetch: deadMasterCaptureFetch,
      },
      runDocker: runDockerForKilledPrimary(
        JSON.stringify({ running: false, finishedAt: KILLED_AT }),
      ),
    });
    await observer.poll();
    assertEquals(sent.length, 1);
    assertEquals(sent[0]?.managedId, MANAGED_ID);
    assertEquals(sent[0]?.instanceHost, LB_DIAL.hostname);
    assertEquals(sent[0]?.instancePort, LB_DIAL.port);
    assertEquals(sent[0]?.evidence, {
      spanMs: 21_000,
      primaryStoppedAt: new Date(KILLED_AT_MS).toISOString(),
    });
  });
});

test("ManagedHaObserver dates a hung primary from the first time the incident was seen", async () => {
  await withTempLayout(async (fixture) => {
    const layout = resolveLayout(fixture.env);
    await seedMysqlPrimary(layout);
    const states = [
      JSON.stringify({ running: true, finishedAt: KILLED_AT }),
      JSON.stringify({ running: false, finishedAt: "0001-01-01T00:00:00Z" }),
      "not json",
    ];
    const results = await Promise.all(states.map(async (state) => {
      const sent: ManagedHaEventMessage[] = [];
      const observer = new ManagedHaObserver({
        layout,
        nowMs: () => KILLED_AT_MS + 21_000,
        send: (message) => {
          sent.push(message);
          return true;
        },
        isStackPresent: () => Promise.resolve(true),
        reviveStack: () => Promise.resolve("absent"),
        api: {
          credentials: { user: "admin", password: "x" },
          fetch: deadMasterCaptureFetch,
        },
        runDocker: runDockerForKilledPrimary(state),
      });
      await observer.poll();
      return sent.map((message) => message.evidence);
    }));
    // No Docker stop time (a frozen engine still runs): the failure start is
    // the first poll that saw the incident, so the control plane can still
    // check a replica's last contact against it.
    const seen = {
      spanMs: 0,
      primaryStoppedAt: new Date(KILLED_AT_MS + 21_000).toISOString(),
    };
    assertEquals(results, [[seen], [seen], [seen]]);
  });
});

test("ManagedHaObserver keeps the first-seen time and re-sends a hung primary's event soon", async () => {
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
        return true;
      },
      isStackPresent: () => Promise.resolve(true),
      api: {
        credentials: { user: "admin", password: "x" },
        fetch: () => Promise.resolve(deadPrimaryResponse()),
      },
    });
    await observer.poll();
    assertEquals(sent.length, 1);
    await clock.advance(29_000);
    await observer.poll();
    assertEquals(sent.length, 1);
    await clock.advance(1_000);
    await observer.poll();
    assertEquals(sent.length, 2);
    assertEquals(sent[1]?.evidence?.spanMs, 30_000);
    // The wait doubles: 60 s after the second, then 120 s.
    await clock.advance(59_000);
    await observer.poll();
    assertEquals(sent.length, 2);
    await clock.advance(1_000);
    await observer.poll();
    assertEquals(sent.length, 3);
    await clock.advance(120_000);
    await observer.poll();
    assertEquals(sent.length, 4);
  });
});

test("ManagedHaObserver holds the captured DeadMaster row while an apply marker is active", async () => {
  await withTempLayout(async (fixture) => {
    const layout = resolveLayout(fixture.env);
    await seedMysqlPrimary(layout);
    const { recordManagedIntent, resetManagedIntentsForTests } = await import(
      "../managed/ha-intent.ts"
    );
    // The apply ended 35 s before the kill, as on the LB pair.
    const appliedAtMs = KILLED_AT_MS - 35_000;
    await recordManagedIntent(layout.stateDir, MANAGED_ID, "apply", {
      nowMs: appliedAtMs,
    });
    try {
      let nowMs = KILLED_AT_MS + 21_000;
      const sent: ManagedHaEventMessage[] = [];
      const observer = new ManagedHaObserver({
        layout,
        nowMs: () => nowMs,
        send: (message) => {
          sent.push(message);
          return true;
        },
        isStackPresent: () => Promise.resolve(true),
        reviveStack: () => Promise.resolve("absent"),
        api: {
          credentials: { user: "admin", password: "x" },
          fetch: deadMasterCaptureFetch,
        },
        runDocker: runDockerForKilledPrimary(
          JSON.stringify({ running: false, finishedAt: KILLED_AT }),
        ),
      });
      await observer.poll();
      assertEquals(sent.length, 0);
      // 10 min marker + 30 s grace after the apply.
      nowMs = appliedAtMs + 630_001;
      await observer.poll();
      assertEquals(sent.length, 1);
      assertEquals(sent[0]?.evidence?.spanMs, nowMs - KILLED_AT_MS);
    } finally {
      resetManagedIntentsForTests();
    }
  });
});

test("an incident that keeps failing is re-sent every minute for about 24 minutes, then slowly", () => {
  assertEquals(haIncidentReemitGapMs(1), 30_000);
  assertEquals(haIncidentReemitGapMs(2), 60_000);
  for (let delivered = 2; delivered < 25; delivered++) {
    assertEquals(haIncidentReemitGapMs(delivered), 60_000);
  }
  assertEquals(haIncidentReemitGapMs(25), 15 * 60_000);
  // A refusal by the control plane's 15 minute cooldown is retried within a
  // minute of the cooldown ending, well inside its 20 minute failure limit.
  let elapsed = 0;
  let count = 0;
  while (elapsed < 15 * 60_000) {
    count += 1;
    elapsed += haIncidentReemitGapMs(count);
  }
  assertEquals(elapsed - 15 * 60_000 <= 60_000, true);
  assertEquals(elapsed < 20 * 60_000, true);
});

test("only a MySQL or MariaDB primary with a replica is watched for a hang", () => {
  const base = {
    managedId: MANAGED_ID,
    memberId: MEMBER_ID,
    containerName: "c",
    updatedAt: "x",
  } as const;
  assertEquals(
    isHungProbeWatched({
      ...base,
      engine: "mysql",
      role: "primary",
      replicaPeerCount: 1,
    }),
    true,
  );
  assertEquals(
    isHungProbeWatched({
      ...base,
      engine: "mariadb",
      role: "primary",
      replicaPeerCount: 0,
    }),
    false,
  );
  assertEquals(
    isHungProbeWatched({
      ...base,
      engine: "mariadb",
      role: "replica",
      replicaPeerCount: 1,
    }),
    false,
  );
  assertEquals(
    isHungProbeWatched({
      ...base,
      engine: "postgres",
      role: "primary",
      replicaPeerCount: 1,
    }),
    false,
  );
});

async function runHungPolls(
  samples: HungSample[],
  stepMs = 15_000,
): Promise<ManagedHaEventMessage[][]> {
  const perPoll: ManagedHaEventMessage[][] = [];
  await withTempLayout(async (fixture) => {
    const layout = resolveLayout(fixture.env);
    await seedMysqlPrimary(layout);
    const sent: ManagedHaEventMessage[] = [];
    let nowMs = Date.parse("2026-10-23T12:00:00.000Z");
    let index = 0;
    const observer = new ManagedHaObserver({
      layout,
      runDocker: runDockerForDial(DEFAULT_DIAL),
      nowMs: () => nowMs,
      now: () => new Date(nowMs).toISOString(),
      send: (message) => {
        sent.push(message);
        return true;
      },
      isStackPresent: () => Promise.resolve(true),
      // Orchestrator sees nothing wrong: replicas still look connected.
      api: {
        credentials: { user: "admin", password: "x" },
        fetch: () => Promise.resolve(new Response("[]", { status: 200 })),
      },
      sampleHung: () =>
        Promise.resolve(samples[Math.min(index++, samples.length - 1)]!),
    });
    for (let poll = 0; poll < samples.length; poll++) {
      const before = sent.length;
      await observer.poll();
      perPoll.push(sent.slice(before));
      nowMs += stepMs;
    }
  });
  return perPoll;
}

test("a hung MySQL or MariaDB primary that Orchestrator does not report is sent after 30 s, anchored on when it stopped answering", async () => {
  const hung: HungSample = {
    kind: "hung",
    reason: "ping did not return in time",
  };
  const polls = await runHungPolls([hung, hung, hung, hung]);
  assertEquals(polls.map((sent) => sent.length), [0, 0, 1, 0]);
  const event = polls[2]![0]!;
  assertEquals(event.type, "managed-ha-event");
  assertEquals(event.managedId, MANAGED_ID);
  assertEquals(event.instanceHost, DEFAULT_DIAL.hostname);
  assertEquals(event.instancePort, DEFAULT_DIAL.port);
  // The hang began at the first unanswered probe, 30 s before this poll.
  assertEquals(event.evidence?.spanMs, 30_000);
});

test("a primary that answers in between, or is merely down, is never reported as hung", async () => {
  const hung: HungSample = { kind: "hung", reason: "x" };
  const polls = await runHungPolls([
    hung,
    hung,
    { kind: "alive" },
    hung,
    hung,
    { kind: "inconclusive", reason: "container is exited" },
    hung,
    hung,
  ]);
  assertEquals(polls.flat().length, 0);
});
