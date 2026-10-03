/** How long a closing socket may take to finish its close handshake. */
export const SOCKET_CLOSE_GRACE_MS = 5_000;

/**
 * Close a socket and make sure its close event fires.
 *
 * A half-open connection never answers the close handshake, so `close()` alone
 * can leave the socket in CLOSING with no `close` event, and the reconnect
 * loop (which awaits that event) would wait forever. After the grace period we
 * give up on the handshake and dispatch the close event ourselves.
 */
export function closeAndAbandon(
  ws: WebSocket,
  graceMs = SOCKET_CLOSE_GRACE_MS,
): void {
  try {
    ws.close();
  } catch {
    // Socket may already be gone.
  }
  const timer = setTimeout(() => {
    if (ws.readyState === WebSocket.CLOSED) return;
    ws.dispatchEvent(
      new CloseEvent("close", { code: 1006, reason: "stale socket abandoned" }),
    );
  }, graceMs);
  ws.addEventListener("close", () => clearTimeout(timer), { once: true });
}
