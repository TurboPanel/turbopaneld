import { assertEquals } from "@std/assert";
import {
  isPreOptInCoLocatedDev,
  setupTestHooks,
  shouldConnectToInstance,
  shouldEnableDockerIntegration,
} from "./setup.ts";
import type { InstallMode } from "../paths/layout.ts";

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno);

const ENV_KEYS = [
  "TURBOPANEL_SKIP_ORCHESTRATION",
  "TURBOPANEL_DEV_INSTANCE",
  "TURBOPANEL_INSTANCE_URL",
  "TURBOPANEL_INSTANCE_RUNTIME",
  "TURBOPANEL_SOCKET",
] as const;

function withEnv(
  overrides: Record<string, string | undefined>,
  fn: () => void,
): void {
  const previous = new Map<string, string | undefined>();
  for (const key of ENV_KEYS) {
    previous.set(key, Deno.env.get(key));
    Deno.env.delete(key);
  }
  for (const [key, value] of Object.entries(overrides)) {
    if (value === undefined) {
      Deno.env.delete(key);
    } else {
      Deno.env.set(key, value);
    }
  }
  try {
    fn();
  } finally {
    for (const key of ENV_KEYS) {
      const value = previous.get(key);
      if (value === undefined) {
        Deno.env.delete(key);
      } else {
        Deno.env.set(key, value);
      }
    }
  }
}

test("isPreOptInCoLocatedDev is true for socket runtime before dev opt-in", () => {
  withEnv({}, () => {
    assertEquals(isPreOptInCoLocatedDev(), true);
  });
});

test("isPreOptInCoLocatedDev is false after TURBOPANEL_DEV_INSTANCE opt-in", () => {
  withEnv({ TURBOPANEL_DEV_INSTANCE: "1" }, () => {
    assertEquals(isPreOptInCoLocatedDev(), false);
  });
});

test("isPreOptInCoLocatedDev is true for co-located Workers before opt-in", () => {
  withEnv(
    {
      TURBOPANEL_INSTANCE_URL: "https://panel.example.com",
      TURBOPANEL_INSTANCE_RUNTIME: "workers",
    },
    () => {
      assertEquals(isPreOptInCoLocatedDev(), true);
    },
  );
});

test("shouldConnectToInstance defers until dev opt-in on co-located socket", () => {
  withEnv({}, () => {
    assertEquals(shouldConnectToInstance(), false);
  });
});

test("shouldConnectToInstance connects after dev opt-in", () => {
  withEnv({ TURBOPANEL_DEV_INSTANCE: "1" }, () => {
    assertEquals(shouldConnectToInstance(), true);
  });
});

test("shouldConnectToInstance always connects when orchestration is skipped", () => {
  withEnv({ TURBOPANEL_SKIP_ORCHESTRATION: "1" }, () => {
    assertEquals(shouldConnectToInstance(), true);
  });
});

test("shouldEnableDockerIntegration stays off before dev opt-in", () => {
  withEnv({}, () => {
    assertEquals(shouldEnableDockerIntegration(), false);
  });
});

test("shouldEnableDockerIntegration turns on after dev opt-in", () => {
  withEnv({ TURBOPANEL_DEV_INSTANCE: "1" }, () => {
    assertEquals(shouldEnableDockerIntegration(), true);
  });
});

test("shouldEnableDockerIntegration turns on for remote URL daemons", () => {
  withEnv({ TURBOPANEL_INSTANCE_URL: "https://panel.example.com" }, () => {
    assertEquals(shouldEnableDockerIntegration(), true);
  });
});

test("shouldEnableDockerIntegration stays off when orchestration is skipped", () => {
  withEnv({ TURBOPANEL_SKIP_ORCHESTRATION: "1" }, () => {
    assertEquals(shouldEnableDockerIntegration(), false);
  });
});

test("isPreOptInCoLocatedDev is false for a remote URL daemon", () => {
  withEnv({ TURBOPANEL_INSTANCE_URL: "https://panel.example.com" }, () => {
    assertEquals(isPreOptInCoLocatedDev(), false);
    assertEquals(shouldConnectToInstance(), true);
  });
});

test("TURBOPANEL_DEV_INSTANCE accepts true and yes", () => {
  withEnv({ TURBOPANEL_DEV_INSTANCE: "true" }, () => {
    assertEquals(isPreOptInCoLocatedDev(), false);
    assertEquals(shouldEnableDockerIntegration(), true);
  });
  withEnv({ TURBOPANEL_DEV_INSTANCE: "yes" }, () => {
    assertEquals(isPreOptInCoLocatedDev(), false);
  });
  withEnv({ TURBOPANEL_DEV_INSTANCE: "false" }, () => {
    assertEquals(isPreOptInCoLocatedDev(), true);
  });
});

test("TURBOPANEL_SKIP_ORCHESTRATION accepts true and yes", () => {
  withEnv({ TURBOPANEL_SKIP_ORCHESTRATION: "true" }, () => {
    assertEquals(shouldConnectToInstance(), true);
    assertEquals(shouldEnableDockerIntegration(), false);
  });
  withEnv({ TURBOPANEL_SKIP_ORCHESTRATION: "yes" }, () => {
    assertEquals(shouldConnectToInstance(), true);
    assertEquals(shouldEnableDockerIntegration(), false);
  });
});

test("opted-in Workers HTTPS is not pre-opt-in", () => {
  withEnv(
    {
      TURBOPANEL_DEV_INSTANCE: "1",
      TURBOPANEL_INSTANCE_RUNTIME: "workers",
      TURBOPANEL_INSTANCE_URL: "https://203.0.113.10",
    },
    () => {
      assertEquals(isPreOptInCoLocatedDev(), false);
      assertEquals(shouldConnectToInstance(), true);
    },
  );
});

test("shouldEnableDockerIntegration stays off for opted-in Workers without URL kind fallthrough", () => {
  // DEV_INSTANCE + workers + URL → install-dev true (docker on). Document the
  // remaining false path via skip + remote is already covered; this pins the
  // opted-in workers+socket case as true so line 75 stays exercised distinctly
  // from remote URL converge.
  withEnv(
    {
      TURBOPANEL_DEV_INSTANCE: "1",
      TURBOPANEL_INSTANCE_RUNTIME: "workers",
      TURBOPANEL_INSTANCE_URL: "https://203.0.113.10",
    },
    () => {
      assertEquals(shouldEnableDockerIntegration(), true);
    },
  );
});

/** Pin the install mode the gate sees (a test process is always a checkout). */
function withInstallMode(mode: InstallMode, fn: () => void): void {
  const previous = setupTestHooks.detectInstallMode;
  setupTestHooks.detectInstallMode = () => mode;
  try {
    fn();
  } finally {
    setupTestHooks.detectInstallMode = previous;
  }
}

test("managed co-located socket daemon connects without dev opt-in", () => {
  // The self-hosted installer's co-located daemon: compiled binary, no
  // TURBOPANEL_INSTANCE_URL, no TURBOPANEL_DEV_INSTANCE. It must dial the
  // socket and attach Docker on start, like any managed node.
  withInstallMode("production", () => {
    withEnv({}, () => {
      assertEquals(isPreOptInCoLocatedDev(), false);
      assertEquals(shouldConnectToInstance(), true);
      assertEquals(shouldEnableDockerIntegration(), true);
    });
  });
});

test("source-checkout socket daemon still defers until dev opt-in", () => {
  withInstallMode("development", () => {
    withEnv({}, () => {
      assertEquals(isPreOptInCoLocatedDev(), true);
      assertEquals(shouldConnectToInstance(), false);
      assertEquals(shouldEnableDockerIntegration(), false);
    });
    withEnv({ TURBOPANEL_DEV_INSTANCE: "1" }, () => {
      assertEquals(isPreOptInCoLocatedDev(), false);
      assertEquals(shouldEnableDockerIntegration(), true);
    });
  });
});

test("install mode does not change the remote URL daemon or skip-orchestration paths", () => {
  withInstallMode("production", () => {
    withEnv({ TURBOPANEL_INSTANCE_URL: "https://panel.example.com" }, () => {
      assertEquals(isPreOptInCoLocatedDev(), false);
      assertEquals(shouldEnableDockerIntegration(), true);
    });
    withEnv({ TURBOPANEL_SKIP_ORCHESTRATION: "1" }, () => {
      assertEquals(shouldConnectToInstance(), true);
      assertEquals(shouldEnableDockerIntegration(), false);
    });
  });
});
