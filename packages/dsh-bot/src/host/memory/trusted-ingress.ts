/** No public rc.2/rc.3 native proof distinguishes composer gestures from owner RPC automation.
 * This gate has no nonce/Remote/isTrusted escape hatch. Only an upstream verified capability can replace it.
 */
export const nativeIngressCapability = Object.freeze({ verified: false as const, reason: 'unverifiable-user-input' as const });
export function classifyNativeIngress(_acceptedMessage: unknown) {
  return { trust: 'candidate' as const, receipt: undefined, effectiveAutoShare: false as const,
    reason: nativeIngressCapability.reason };
}
export function assertTrustedIngress(_claimedReceipt: unknown): never {
  throw new Error('Automatic sharing unavailable: native direct user input cannot be verified');
}
