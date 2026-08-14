/**
 * Checkout-sync apply hook. Production compile of `src/prod-main.ts` never
 * calls {@link enableCheckoutDevSync}, so `src/dev-sync-apply.ts` stays out of
 * the managed binary graph. Source `main.ts` registers the unpack path.
 */
export type DevSyncApplyFn = (bytes: Uint8Array) => Promise<void>;

let checkoutDevSyncApply: DevSyncApplyFn | undefined;

export function enableCheckoutDevSync(apply: DevSyncApplyFn): void {
  checkoutDevSyncApply = apply;
}

export function getCheckoutDevSyncApply(): DevSyncApplyFn | undefined {
  return checkoutDevSyncApply;
}
