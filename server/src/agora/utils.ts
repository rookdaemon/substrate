/**
 * Get a short display version of a public key using the last 8 characters.
 * Matches the implementation from @rookdaemon/agora/utils.ts
 */
export function shortKey(publicKey: string): string {
  return "..." + publicKey.slice(-8);
}
