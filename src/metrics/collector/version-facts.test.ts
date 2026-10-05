import { assertEquals } from "@std/assert";
import type { ContainerSummary } from "../../docker/client.ts";
import {
  caddyVersionFromDirectory,
  dbVersionsOf,
  imageVersion,
  traefikVersionOf,
  VersionFactsSampler,
} from "./version-facts.ts";

function container(
  image: string,
  labels: Record<string, string> = {},
): ContainerSummary {
  return {
    Id: image,
    Names: ["/x"],
    Image: image,
    State: "running",
    Status: "Up",
    Labels: labels,
    Ports: [],
  };
}

const TRAEFIK = container("traefik:v3.6.6", {
  "com.turbopanel.system.component": "hosting-ingress",
});

Deno.test("imageVersion reads the tag and rejects untagged, latest and digest-only references", () => {
  assertEquals(imageVersion("traefik:v3.6.6"), "3.6.6");
  assertEquals(imageVersion("postgres:18"), "18");
  assertEquals(imageVersion("registry.example:5000/lib/mysql:8.4.2"), "8.4.2");
  assertEquals(imageVersion("mariadb:11.4@sha256:abc"), "11.4");
  assertEquals(imageVersion("postgres"), undefined);
  assertEquals(imageVersion("postgres:latest"), undefined);
  assertEquals(imageVersion("postgres@sha256:abc"), undefined);
  assertEquals(imageVersion("registry.example:5000/postgres"), undefined);
  assertEquals(imageVersion(undefined), undefined);
});

Deno.test("traefikVersionOf only trusts the container labelled as the hosting ingress", () => {
  assertEquals(traefikVersionOf([TRAEFIK]), "3.6.6");
  // A tenant's own Traefik, or the right label on another image, is not it.
  assertEquals(traefikVersionOf([container("traefik:v2.0")]), undefined);
  assertEquals(
    traefikVersionOf([
      container("nginx:1.27", {
        "com.turbopanel.system.component": "hosting-ingress",
      }),
    ]),
    undefined,
  );
});

Deno.test("dbVersionsOf lists each managed engine once, sorted", () => {
  assertEquals(
    dbVersionsOf([
      container("postgres:18", { "tp.managed.engine": "postgres" }),
      container("postgres:18", { "tp.managed.engine": "postgres" }),
      container("mariadb:11.4", { "tp.managed.engine": "mariadb" }),
      container("postgres:16", { "tp.managed.engine": "postgres" }),
      container("redis:7"),
      container("mysql:latest", { "tp.managed.engine": "mysql" }),
      container("x:1", { "tp.managed.engine": "Bad Engine!" }),
    ]),
    "mariadb 11.4,postgres 16,postgres 18",
  );
  assertEquals(dbVersionsOf([container("redis:7")]), undefined);
});

Deno.test("caddyVersionFromDirectory takes the vendored directory's version name", () => {
  assertEquals(
    caddyVersionFromDirectory("/opt/turbopanel/vendor/caddy/2.11.4"),
    "2.11.4",
  );
  assertEquals(caddyVersionFromDirectory("/opt/x/caddy/current"), undefined);
  assertEquals(caddyVersionFromDirectory("/opt/x/caddy/2.11"), undefined);
});

function sampler(overrides: {
  docker?: () => Promise<string | undefined>;
  containers?: () => Promise<ContainerSummary[]>;
  caddy?: () => Promise<string | undefined>;
}) {
  return new VersionFactsSampler({
    dockerVersion: overrides.docker ?? (() => Promise.resolve("29.8.2")),
    listContainers: overrides.containers ??
      (() =>
        Promise.resolve([
          TRAEFIK,
          container("postgres:18", { "tp.managed.engine": "postgres" }),
        ])),
    caddyDirectory: overrides.caddy ??
      (() => Promise.resolve("/opt/turbopanel/vendor/caddy/2.11.4")),
  });
}

Deno.test("VersionFactsSampler gathers every version in one poll", async () => {
  const facts = sampler({});
  assertEquals(facts.latest(), null);
  await facts.refresh();
  assertEquals(facts.latest(), {
    dockerVersion: "29.8.2",
    caddyVersion: "2.11.4",
    traefikVersion: "3.6.6",
    dbVersions: "postgres 18",
  });
});

Deno.test("VersionFactsSampler keeps a failed source's last value and drops engines that are gone", async () => {
  let dockerUp = true;
  let engines = true;
  const facts = sampler({
    docker: () =>
      dockerUp ? Promise.resolve("29.8.2") : Promise.reject(new Error("down")),
    containers: () =>
      dockerUp
        ? Promise.resolve(
          engines
            ? [container("postgres:18", { "tp.managed.engine": "postgres" })]
            : [],
        )
        : Promise.reject(new Error("down")),
    caddy: () => Promise.reject(new Error("no vendor dir")),
  });
  await facts.refresh();
  assertEquals(facts.latest(), {
    dockerVersion: "29.8.2",
    dbVersions: "postgres 18",
  });
  // Docker unreachable: nothing is learned, nothing is forgotten.
  dockerUp = false;
  await facts.refresh();
  assertEquals(facts.latest()?.dockerVersion, "29.8.2");
  assertEquals(facts.latest()?.dbVersions, "postgres 18");
  // Docker answers with no managed engine left: that is reported as gone.
  dockerUp = true;
  engines = false;
  await facts.refresh();
  assertEquals(facts.latest(), { dockerVersion: "29.8.2" });
});

Deno.test("VersionFactsSampler stays null when nothing could be read", async () => {
  const facts = sampler({
    docker: () => Promise.reject(new Error("x")),
    containers: () => Promise.reject(new Error("x")),
    caddy: () => Promise.resolve(undefined),
  });
  await facts.refresh();
  assertEquals(facts.latest(), null);
});
