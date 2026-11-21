import { assertEquals, assertRejects } from "@std/assert";
import { decodeBase64Url } from "@std/encoding/base64url";
import vectors from "./frames.vectors.json" with { type: "json" };
import {
  bytesToSid,
  decodePlain,
  type Direction,
  encodeAck,
  encodeClose,
  encodeData,
  encodeExit,
  encodeNotice,
  encodeResize,
  FrameError,
  type FrameErrorCode,
  FrameOpener,
  FrameSealer,
  HEADER_BYTES,
  importSessionKey,
  MAX_PLAINTEXT_BYTES,
  peekSid,
  sidToBytes,
} from "./frames.ts";
import { openShellKey, shellKeyInfo } from "./key.ts";

const test = Deno.test.bind(Deno);
const CODES = new Set([
  "malformed",
  "version",
  "sid",
  "direction",
  "counter",
  "tag",
  "oversize",
  "plaintext",
]);

function fromHex(hex: string): Uint8Array {
  return Uint8Array.from(
    hex.match(/../g) ?? [],
    (pair) => Number.parseInt(pair, 16),
  );
}
function toHex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

const key = () => importSessionKey(fromHex(vectors.keyHex));

test("every vector frame is what the sealer produces and what the opener reads", async () => {
  for (const dir of [0, 1] as Direction[]) {
    const sealer = new FrameSealer(await key(), vectors.sid, dir);
    const opener = new FrameOpener(await key(), vectors.sid, dir);
    for (const v of vectors.frames.filter((f) => f.dir === dir)) {
      const frame = await sealer.seal(fromHex(v.plaintextHex));
      assertEquals(toHex(frame), v.frameHex);
      assertEquals(
        toHex(await opener.open(fromHex(v.frameHex))),
        v.plaintextHex,
      );
    }
  }
});

test("the shared sequences give the same outcome for each frame", async () => {
  for (const seq of vectors.sequences) {
    const opener = new FrameOpener(
      await key(),
      vectors.sid,
      seq.dir as Direction,
    );
    for (const [i, hex] of seq.frames.entries()) {
      const want = seq.expect[i];
      if (!CODES.has(want)) {
        assertEquals(toHex(await opener.open(fromHex(hex))), want, seq.name);
      } else {
        const err = await assertRejects(
          () => opener.open(fromHex(hex)),
          FrameError,
        );
        assertEquals((err as FrameError).code, want as FrameErrorCode);
      }
    }
  }
});

test("a frame longer than the cap is refused as oversize before decrypting", async () => {
  const opener = new FrameOpener(await key(), vectors.sid, 0);
  const frame = new Uint8Array(HEADER_BYTES + MAX_PLAINTEXT_BYTES + 16 + 1);
  frame[0] = 1;
  await assertRejects(() => opener.open(frame), FrameError, "too long");
});

test("a plaintext over the cap, or an empty one, is not sealed", async () => {
  const sealer = new FrameSealer(await key(), vectors.sid, 1);
  await assertRejects(
    () => sealer.seal(new Uint8Array(MAX_PLAINTEXT_BYTES + 1)),
    FrameError,
  );
  await assertRejects(() => sealer.seal(new Uint8Array(0)), FrameError);
  assertEquals(sealer.nextCounter, 0n);
  const frame = await sealer.seal(new Uint8Array(MAX_PLAINTEXT_BYTES));
  assertEquals(frame.length, HEADER_BYTES + MAX_PLAINTEXT_BYTES + 16);
});

test("a frame sealed with another key does not authenticate", async () => {
  const other = await importSessionKey(new Uint8Array(32).fill(9));
  const frame = await new FrameSealer(other, vectors.sid, 0).seal(
    encodeData(new Uint8Array([1])),
  );
  const opener = new FrameOpener(await key(), vectors.sid, 0);
  const err = await assertRejects(() => opener.open(frame), FrameError);
  assertEquals((err as FrameError).code, "tag");
});

test("a changed ciphertext byte fails the tag", async () => {
  const sealer = new FrameSealer(await key(), vectors.sid, 0);
  const frame = await sealer.seal(encodeData(new Uint8Array([1, 2])));
  frame[HEADER_BYTES] ^= 0x80;
  const opener = new FrameOpener(await key(), vectors.sid, 0);
  const err = await assertRejects(() => opener.open(frame), FrameError);
  assertEquals((err as FrameError).code, "tag");
});

test("plaintext codecs round-trip every type", () => {
  assertEquals(decodePlain(encodeData(new Uint8Array([7, 8]))), {
    type: "data",
    data: new Uint8Array([7, 8]),
  });
  assertEquals(decodePlain(encodeResize(80, 24)), {
    type: "resize",
    cols: 80,
    rows: 24,
  });
  assertEquals(decodePlain(encodeAck(4_000_000_000)), {
    type: "ack",
    bytes: 4_000_000_000,
  });
  assertEquals(decodePlain(encodeClose(3)), { type: "close", reason: 3 });
  assertEquals(decodePlain(encodeExit(-2)), { type: "exit", code: -2 });
  assertEquals(decodePlain(encodeNotice("é")), { type: "notice", text: "é" });
});

test("plaintexts of the wrong shape are refused", () => {
  for (
    const bad of [[], [0x09], [0x02, 1, 2], [0x03], [0x04], [0x05, 1], [
      0x06,
      0xff,
    ]]
  ) {
    let code = "";
    try {
      decodePlain(Uint8Array.from(bad));
    } catch (err) {
      code = (err as FrameError).code;
    }
    assertEquals(code, "plaintext", JSON.stringify(bad));
  }
});

test("sid bytes round-trip and peekSid reads a frame's sid", async () => {
  assertEquals(bytesToSid(sidToBytes(vectors.sid)), vectors.sid);
  const frame = await new FrameSealer(await key(), vectors.sid, 0).seal(
    encodeData(new Uint8Array([1])),
  );
  assertEquals(peekSid(frame), vectors.sid);
  assertEquals(peekSid(frame.subarray(0, 20)), null);
  const wrongVersion = Uint8Array.from(frame);
  wrongVersion[0] = 9;
  assertEquals(peekSid(wrongVersion), null);
});

test("the shared HPKE vector opens to the session key, bound to the sid and server", async () => {
  const h = vectors.hpke;
  const priv = decodeBase64Url(h.recipientPrivateB64u);
  const opened = await openShellKey(priv, h.serverId, vectors.sid, h.keySealed);
  assertEquals(toHex(opened), vectors.keyHex);
  assertEquals(
    shellKeyInfo(vectors.sid.toUpperCase()),
    shellKeyInfo(vectors.sid),
  );
  await assertRejects(() =>
    openShellKey(
      priv,
      h.serverId,
      "00000000-0000-4000-8000-000000000000",
      h.keySealed,
    )
  );
  await assertRejects(() =>
    openShellKey(priv, "another-server", vectors.sid, h.keySealed)
  );
  await assertRejects(() =>
    openShellKey(priv, h.serverId, vectors.sid, "AAAA")
  );
});
