/**
 * Ordering for the host's Docker-socket proxy relative to the shared Traefik.
 *
 * Pure: no Docker, no disk. `ingress.ts` observes the host, asks for a plan
 * and runs the steps in order.
 *
 * The proxy is its own compose project. A host installed before that split
 * still runs the proxy as a second service of the shared Traefik's project
 * (the "legacy" proxy). Both answer to the same network alias, so while both
 * exist a Traefik reaches either one and nothing is repointed.
 */

export type DockerProxyStep =
  /** `compose up` the proxy's own project. */
  | "start-proxy"
  /** `compose up` the shared Traefik (rendered without the proxy). */
  | "up-traefik"
  /** Remove the proxy container left in the shared Traefik's project. */
  | "retire-legacy"
  /** `compose down` the proxy's own project and forget its compose file. */
  | "remove-proxy";

export type DockerProxyObservation = {
  /**
   * Some Traefik on this host reaches Docker through the proxy: the shared one
   * in socket-proxy mode, or (in gate mode) a service Traefik whose compose
   * file still names it.
   */
  wanted: boolean;
  /** The old in-project proxy container exists (running or not). */
  legacyPresent: boolean;
  /** The proxy's own project has a container or an applied compose file. */
  ownPresent: boolean;
};

/**
 * The steps of one shared-ingress apply, in order.
 *
 * Wanted: the own proxy comes up FIRST, so the alias already answers when the
 * Traefik is recreated and when the legacy proxy goes. The legacy proxy is
 * retired LAST, after the Traefik is up: a Traefik that was still talking to
 * it reconnects to the alias, which the new proxy now holds.
 *
 * Not wanted (gate mode, nobody left on the proxy): the Traefik switches to
 * the gate first; only then do the proxies go, so no Traefik loses its Docker
 * source before it has another.
 */
export function planDockerProxy(
  observed: DockerProxyObservation,
): DockerProxyStep[] {
  const steps: DockerProxyStep[] = [];
  if (observed.wanted) steps.push("start-proxy");
  steps.push("up-traefik");
  if (observed.legacyPresent) steps.push("retire-legacy");
  if (!observed.wanted && observed.ownPresent) steps.push("remove-proxy");
  return steps;
}
