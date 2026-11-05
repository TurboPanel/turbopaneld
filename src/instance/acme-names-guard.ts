/**
 * Certificate orders and proof forwards only for names this server hosts.
 *
 * `acme-issue-request` and `acme-proof-forward` name the hostnames to order
 * for or to pass the proof path on for. A name no tenant site on this server
 * answers on is refused before anything is written or ordered, so a control
 * plane message alone can never make this server order a certificate for, or
 * take over the proof path of, a name it does not serve. The hosted list is the
 * live site snippets (`readHostedSiteNames`), not the Let's Encrypt manifests:
 * a name whose certificate the control plane pins is hosted all the same.
 */

import { foldHostname, withoutTrailingDots } from "../deploy/hostname-fold.ts";

export type HostedNamesSplit = { hosted: string[]; foreign: string[] };

/** How many names a reason spells out before it says how many more. */
const LISTED_NAMES = 5;

function compared(name: string): string {
  return withoutTrailingDots(foldHostname(name));
}

/** Split the requested names into those this server hosts and those it does not. */
export function partitionHostedNames(
  requested: readonly string[],
  hosted: ReadonlySet<string>,
): HostedNamesSplit {
  const split: HostedNamesSplit = { hosted: [], foreign: [] };
  for (const name of requested) {
    (hosted.has(compared(name)) ? split.hosted : split.foreign).push(name);
  }
  return split;
}

function listNames(names: readonly string[]): string {
  const shown = names.slice(0, LISTED_NAMES).join(", ");
  const more = names.length - LISTED_NAMES;
  return more > 0 ? `${shown} and ${more} more` : shown;
}

/** The plain reason for a refused request, or `null` when every name is hosted. */
export function namesNotHostedReason(
  requested: readonly string[],
  hosted: ReadonlySet<string>,
  refused: string,
): string | null {
  const { foreign } = partitionHostedNames(requested, hosted);
  if (foreign.length === 0) return null;
  const verb = foreign.length === 1 ? "is" : "are";
  return `${
    listNames(foreign)
  } ${verb} not served by this server, so ${refused}`;
}

/** Read the hosted names and answer the reason, failing closed when they cannot be read. */
export async function checkNamesHosted(
  requested: readonly string[],
  readHosted: () => Promise<ReadonlySet<string>>,
  refused: string,
): Promise<string | null> {
  let hosted: ReadonlySet<string>;
  try {
    hosted = await readHosted();
  } catch {
    return `this server could not read its own sites, so ${refused}`;
  }
  return namesNotHostedReason(requested, hosted, refused);
}
