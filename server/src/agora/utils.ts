/**
 * Agora utility functions
 */

/**
 * Get a short display version of a public key using the last 8 characters.
 * Ed25519 public keys all share the same OID prefix (302a300506032b6570032100),
 * so the last 8 characters are much more distinguishable than the first 8.
 * 
 * @param publicKey - The full public key hex string
 * @returns The last 8 characters of the key followed by "..."
 * 
 * Note: For keys shorter than 8 characters, returns the entire key with "...".
 * This is an edge case since all Ed25519 public keys are 66 characters long.
 */
export function shortKey(publicKey: string): string {
  return publicKey.slice(-8) + "...";
}
