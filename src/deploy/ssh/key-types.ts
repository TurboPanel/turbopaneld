/**
 * Key types the platform accepts, mirroring `ALLOWED_SSH_KEY_TYPES` in the
 * instance's `src/lib/ssh-public-key.ts`.
 *
 * A leaf module with no imports so both the renderer and the wire validator can
 * use it without either pulling the other in. The instance holds the parser
 * (it is the side an operator pastes into); the daemon holds only the shape
 * gate, because by the time a key reaches here it has already been decoded,
 * checked against its own embedded algorithm name, and re-rendered.
 */
export const ALLOWED_SSH_KEY_TYPES: readonly string[] = Object.freeze([
  "ssh-ed25519",
  "sk-ssh-ed25519@openssh.com",
  "ecdsa-sha2-nistp256",
  "ecdsa-sha2-nistp384",
  "ecdsa-sha2-nistp521",
  "sk-ecdsa-sha2-nistp256@openssh.com",
  "ssh-rsa",
]);

/**
 * `<type> <base64>`, anchored, with no third field.
 *
 * Deliberately not a full blob decode: by the time a key reaches the daemon the
 * control plane has already decoded it, compared its embedded algorithm name
 * against its label, and re-rendered it from the decoded bytes. What is left to
 * enforce is that nothing *structural* — a second line, an options field, a
 * trailing comment — can reach a file `sshd` authenticates against.
 *
 * One definition, used by both the wire validator and the file renderer, so the
 * two gates cannot drift into disagreeing about what canonical means.
 */
const CANONICAL_SSH_KEY_RE = new RegExp(
  `^(?:${
    ALLOWED_SSH_KEY_TYPES.map((type) =>
      type.replaceAll(/[.*+?^${}()|[\]\\@]/g, "\\$&")
    ).join("|")
  }) [A-Za-z0-9+/]+={0,2}$`,
);

export function isCanonicalSshPublicKey(value: string): boolean {
  return CANONICAL_SSH_KEY_RE.test(value);
}
