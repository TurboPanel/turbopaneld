/**
 * Per-login grant mode on the daemon.
 *
 * - A login with no `grantMode` (or `preset`, or `recipe` which acts like
 *   `preset` until recipes exist) must produce exactly the SQL trunk produced
 *   before the field existed. The hashes below were captured from trunk code
 *   that had no grant-mode branch.
 * - A `self` login keeps its account, password and (Postgres) CONNECT, and the
 *   statements that reset or revoke grants are never generated.
 */
import { assertEquals } from "@std/assert";
import type { ManagedApplyCredential } from "../../contracts/commands-contracts.ts";
import { mariadbManagedEngineRuntime } from "./mariadb.ts";
import { mysqlManagedEngineRuntime } from "./mysql.ts";
import { postgresManagedEngineRuntime } from "./postgres.ts";
import type {
  ManagedEngineContext,
  ManagedEngineExec,
  ManagedEngineRuntime,
} from "./types.ts";

const test = Deno.test.bind(Deno);

/** Captured from trunk before the grant-mode branches existed. */
const GOLDEN: Record<string, string> = {
  __MARIADB__:
    "498db4d8853bb0937bc69ad74d1291b3eb964a08601de0493a5a08e8ebe48bfd",
  __MYSQL__: "1d243b0a225ac07be7b7920eb78b10d9dd2071e1ee3fc37e248da88cc674ae1c",
  __POSTGRES__:
    "de1a650c527498acb43a09781cd6c770e85db40072ab3cc44c0a45f33fa7aad9",
};

const engines: Array<[string, ManagedEngineRuntime, string]> = [
  ["mariadb", mariadbManagedEngineRuntime, "__MARIADB__"],
  ["mysql", mysqlManagedEngineRuntime, "__MYSQL__"],
  ["postgres", postgresManagedEngineRuntime, "__POSTGRES__"],
];

async function sqlFor(
  engine: ManagedEngineRuntime,
  credentials: ManagedApplyCredential[],
): Promise<string[]> {
  const inputs: string[] = [];
  const exec: ManagedEngineExec = (_argv, input) => {
    inputs.push(input ?? "");
    return Promise.resolve({ success: true, stdout: "", stderr: "" });
  };
  const ctx: ManagedEngineContext = {
    containerId: "c1",
    composeServiceName: "svc",
    rootUsername: "root",
    defaultDatabase: "appdb",
    exec,
  };
  await engine.applyCredentials(ctx, credentials);
  return inputs;
}

function credentials(
  mode?: ManagedApplyCredential["grantMode"],
): ManagedApplyCredential[] {
  const withMode = mode === undefined ? {} : { grantMode: mode };
  return [
    {
      principalId: "p-root",
      username: "rootlogin",
      role: "root",
      databases: ["appdb"],
      password: "root-pass",
    },
    {
      principalId: "p-rw",
      username: "rw_user",
      role: "user",
      databases: ["appdb", "other"],
      privileges: ["read-write"],
      password: "rw-pass",
    },
    {
      principalId: "p-ro",
      username: "ro_user",
      role: "user",
      databases: ["appdb"],
      privileges: ["read-only"],
      password: "ro-pass",
    },
    {
      principalId: "p-hand",
      username: "hand_user",
      role: "user",
      databases: ["appdb"],
      privileges: ["read-write"],
      password: "hand-pass",
      ...withMode,
    },
  ];
}

async function sha256(text: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(text),
  );
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

for (const [name, engine, goldenKey] of engines) {
  test(`${name}: no grantMode, preset and recipe give the SQL trunk gave`, async () => {
    const baseline = await sqlFor(engine, credentials());
    const hash = await sha256(JSON.stringify(baseline));
    if (Deno.env.get("CAPTURE_GRANT_MODE_GOLDEN")) {
      console.log(`GOLDEN ${goldenKey} ${hash}`);
    }
    assertEquals(hash, GOLDEN[goldenKey]);
    for (const mode of ["preset", "recipe"] as const) {
      assertEquals(await sqlFor(engine, credentials(mode)), baseline);
    }
  });
}

test("postgres self login: connect kept; no revoke, grant reset, object ACL or default privileges for it", async () => {
  const sql = (await sqlFor(
    postgresManagedEngineRuntime,
    credentials("self").filter((c) =>
      c.role !== "user" || c.username === "hand_user"
    ),
  )).join("\n");
  const own = sql.split("\n").filter((line) => line.includes(`"hand_user"`));
  assertEquals(
    own.includes(`GRANT CONNECT ON DATABASE "appdb" TO "hand_user";`),
    true,
  );
  assertEquals(sql.includes("NOSUPERUSER"), true);
  // revokeUnlistedDatabasesSql, the grantDatabaseSql pair, exactObjectAclSql
  // and the default privileges all name the login; only CONNECT may remain.
  assertEquals(
    own.filter((l) =>
      l.includes("CONNECT") === false && /REVOKE|GRANT|ALTER DEFAULT/.test(l)
    ),
    [],
  );
  assertEquals(sql.includes("pg_catalog.aclexplode(datacl) a"), true); // public revoke stays
  assertEquals(sql.includes("CREATE SCHEMA"), false);
  assertEquals(sql.includes("default_transaction_read_only"), false);
  assertEquals(sql.includes("ALTER DEFAULT PRIVILEGES"), false);
});

test("postgres: a self login beside preset logins leaves the preset logins' SQL in place", async () => {
  const mixed =
    (await sqlFor(postgresManagedEngineRuntime, credentials("self")))
      .join("\n");
  assertEquals(
    mixed.includes(`REVOKE ALL ON DATABASE "appdb" FROM "rw_user"`),
    true,
  );
  assertEquals(
    mixed.includes(`ALTER DEFAULT PRIVILEGES FOR ROLE "rw_user"`),
    true,
  );
  assertEquals(mixed.includes(`TO "hand_user"`), true);
  assertEquals(mixed.includes(`FROM "hand_user"`), false);
  assertEquals(mixed.includes(`FOR ROLE "hand_user"`), false);
  assertEquals(
    mixed.replace(`GRANT CONNECT ON DATABASE "appdb" TO "hand_user";`, "")
      .includes(`"hand_user"`.concat("") + ";"),
    false,
  );
});

for (const [name, engine] of engines.filter(([n]) => n !== "postgres")) {
  test(`${name} self login: account and password kept, no grants written`, async () => {
    const sql = (await sqlFor(engine, credentials("self"))).join("\n");
    assertEquals(sql.includes("hand_user"), true);
    assertEquals(/GRANT [^\n]* ON `appdb`\.\* TO `hand_user`/.test(sql), false);
    assertEquals(/GRANT [^\n]*TO `hand_user`/.test(sql), false);
    // Still granted for the preset login in the same payload.
    assertEquals(/GRANT [^\n]* ON `appdb`\.\* TO `rw_user`/.test(sql), true);
  });
}
