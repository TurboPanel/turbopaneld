import { decodeBase64Url } from "@std/encoding/base64url";
import { join } from "@std/path";
import { sealToRecipient } from "../crypto/hpke.ts";

/**
 * A `/secrets/decrypt` answer for tests that run the real client: each
 * plaintext is sealed to the client's own sealing key and server id, read from
 * `TURBOPANEL_DAEMON_STATE_DIR`, as the control plane does. The key exists
 * once the client has connected and registered it.
 */
export async function sealedDecryptResponse(
  plaintexts: ReadonlyArray<string | null>,
): Promise<Response> {
  const stateDir = Deno.env.get("TURBOPANEL_DAEMON_STATE_DIR") ?? "";
  const keyFile = JSON.parse(
    await Deno.readTextFile(join(stateDir, "sealing-key.json")),
  ) as { kid: string; publicJwk: { x: string } };
  const serverId = (await Deno.readTextFile(join(stateDir, "server.id")))
    .trim();
  const pub = decodeBase64Url(keyFile.publicJwk.x);
  const encoder = new TextEncoder();
  const sealed = await Promise.all(
    plaintexts.map((value) =>
      value === null ? null : sealToRecipient(
        pub,
        keyFile.kid,
        serverId,
        encoder.encode(value),
      )
    ),
  );
  return new Response(JSON.stringify({ ok: true, sealed }), { status: 200 });
}
