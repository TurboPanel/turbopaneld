/**
 * The TurboFabric mesh interface name. Lives on its own so both the fabric
 * command (`src/commands/fabric.ts`, which creates it) and the address
 * collector (`src/host/server-addresses.ts`, which skips it) can import it:
 * the fabric command already imports the collector, so the collector cannot
 * import the fabric command back.
 */
export const FABRIC_INTERFACE_NAME = "tp0";
