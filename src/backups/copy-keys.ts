/** Where a backup's copy lives inside a target's bucket (relative to its prefix). */

export type CopyKeyParts = {
  managedId: string;
  backupId: string;
  policyId?: string;
  artifactExtension: string;
};

/** `managed/<managedId>/<policy-<policyId> | manual>` */
export function copyFolder(
  parts: Pick<CopyKeyParts, "managedId" | "policyId">,
) {
  return `managed/${parts.managedId}/${
    parts.policyId ? `policy-${parts.policyId}` : "manual"
  }`;
}

export function copyKey(parts: CopyKeyParts): string {
  return `${copyFolder(parts)}/${parts.backupId}.${parts.artifactExtension}`;
}
