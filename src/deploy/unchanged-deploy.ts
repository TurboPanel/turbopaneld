/**
 * Deciding whether a redeploy can be skipped as unchanged.
 *
 * A matching hash only says the deploy would send the same inputs as last
 * time. It says nothing about the host: a container that crashed or was
 * stopped, a unit that is down, a `current` link or site config that went
 * missing all need the full deploy. So a skip also needs the things the last
 * deploy put in place to be verified up. Anything doubtful runs in full.
 */

import { join } from "node:path";
import { hostSudoArgs } from "../permissions/host-sudo.ts";
import type { LayoutPaths } from "../paths/layout.ts";
import { composeFileArgs } from "./compose-files.ts";
import { parseComposePsEntries } from "./compose-ps.ts";
import type { DockerCliResult } from "./docker-cli.ts";
import type { RunFn } from "./ensure-principal.ts";
import { siteCaddyConfigDir } from "./site/engine-driver.ts";
import { nativeAppUnitName } from "./native/unit.ts";

/** What the host can be asked; real implementations are built by the caller. */
export type HostProbe = {
  /** Compose services the project declares, and the state of every container (stopped ones too). */
  composeStates(
    projectName: string,
  ): Promise<
    {
      expected: string[];
      containers: Array<{ service: string; state: string; health?: string }>;
    } | null
  >;
  unitActive(unit: string): Promise<boolean>;
  pathExists(path: string): Promise<boolean>;
  /** File names in the site engines' config folders. */
  siteConfigNames(): Promise<string[]>;
};

export type DeployedThings = {
  environmentId: string;
  /** Compose projects to check; empty when the deploy has no containers. */
  projects: string[];
  nativeServiceIds: string[];
  siteNames: string[];
  /** `current` links of every release this deploy put live. */
  currentLinks: string[];
};

const UNHEALTHY = new Set(["unhealthy", "starting"]);

async function containersUp(
  projects: readonly string[],
  probe: HostProbe,
): Promise<boolean> {
  for (const project of projects) {
    const states = await probe.composeStates(project);
    if (states === null || states.expected.length === 0) return false;
    for (const service of states.expected) {
      const mine = states.containers.filter((c) => c.service === service);
      if (mine.length === 0) return false;
      if (
        !mine.every((c) =>
          c.state === "running" && !UNHEALTHY.has(c.health ?? "")
        )
      ) return false;
    }
  }
  return true;
}

async function allTrue<T>(
  items: readonly T[],
  check: (item: T) => Promise<boolean>,
): Promise<boolean> {
  for (const item of items) {
    if (!await check(item)) return false;
  }
  return true;
}

async function sitesServing(
  things: DeployedThings,
  probe: HostProbe,
): Promise<boolean> {
  if (things.siteNames.length === 0) return true;
  const names = await probe.siteConfigNames();
  return things.siteNames.every((site) => {
    const prefix = `tp-${things.environmentId}-${site}.`;
    return names.some((name) => name.startsWith(prefix));
  });
}

/** True only when everything the last deploy put in place is verified up. */
export async function hostStillRunsDeploy(
  things: DeployedThings,
  probe: HostProbe,
): Promise<boolean> {
  try {
    return await containersUp(things.projects, probe) &&
      await allTrue(
        things.nativeServiceIds,
        (id) => probe.unitActive(nativeAppUnitName(id)),
      ) &&
      await allTrue(things.currentLinks, (path) => probe.pathExists(path)) &&
      await sitesServing(things, probe);
  } catch {
    return false;
  }
}

const IMAGE_LINE_RE = /^\s*image:\s*["']?([^\s"'#]+)/gm;

/**
 * An image named without a tag, or by `latest` (or by a variable), can point
 * somewhere else tomorrow and the hash would not show it; such a deploy always
 * runs, so a redeploy picks up a newer image.
 */
export function usesMutableImageTag(
  composeContents: readonly string[],
): boolean {
  for (const content of composeContents) {
    for (const match of content.matchAll(IMAGE_LINE_RE)) {
      const image = match[1]!;
      if (image.includes("@sha256:")) continue;
      if (image.includes("$")) return true;
      const tag = image.slice(image.lastIndexOf("/") + 1).split(":")[1];
      if (tag === undefined || tag === "latest") return true;
    }
  }
  return false;
}

type ComposeStates = NonNullable<
  Awaited<ReturnType<HostProbe["composeStates"]>>
>;

function psContainers(stdout: string): ComposeStates["containers"] {
  return parseComposePsEntries(stdout).flatMap((entry) => {
    const service = entry.Service;
    const state = entry.State;
    if (typeof service !== "string" || typeof state !== "string") return [];
    const health = typeof entry.Health === "string" ? entry.Health : undefined;
    return [{ service, state, ...(health === undefined ? {} : { health }) }];
  });
}

/** The real probe: Docker Compose, systemd and the config folders of this host. */
export function createHostProbe(input: {
  layout: LayoutPaths;
  composePaths: readonly string[];
  runDocker: (args: string[]) => Promise<DockerCliResult>;
  run: RunFn;
}): HostProbe {
  return {
    composeStates: async (projectName) => {
      const base = composeFileArgs(projectName, input.composePaths);
      const config = await input.runDocker([...base, "config", "--services"]);
      const ps = await input.runDocker([
        ...base,
        "ps",
        "-a",
        "--format",
        "json",
      ]);
      if (!config.success || !ps.success) return null;
      return {
        expected: config.stdout.split("\n").map((l) => l.trim()).filter(
          (l) => l.length > 0,
        ),
        containers: psContainers(ps.stdout),
      };
    },
    unitActive: async (unit) =>
      (await input.run(
        "sudo",
        hostSudoArgs(["-n", "systemctl", "is-active", "--quiet", unit]),
      )).success,
    pathExists: async (path) =>
      (await input.run("sudo", hostSudoArgs(["-n", "test", "-e", path])))
        .success,
    siteConfigNames: async () => {
      const dirs = [
        join(siteCaddyConfigDir(input.layout), "sites"),
        join(input.layout.configDir, "nginx", "sites"),
        join(input.layout.configDir, "apache", "sites"),
        join(input.layout.configDir, "openlitespeed", "sites"),
      ];
      const names: string[] = [];
      for (const dir of dirs) {
        try {
          for await (const entry of Deno.readDir(dir)) names.push(entry.name);
        } catch {
          // A folder this host never made has no sites in it.
        }
      }
      return names;
    },
  };
}
