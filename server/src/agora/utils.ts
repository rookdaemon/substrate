import type { IAgoraService } from "./IAgoraService";
import type { SeenKeyStore } from "@rookdaemon/agora";
import { mergeDirectories } from "@rookdaemon/agora";
import * as Agora from "@rookdaemon/agora";

export interface PeerReferenceEntry {
  publicKey: string;
  name?: string;
}

export type PeerReferenceDirectory = Record<string, PeerReferenceEntry>;

const coreExpand = (Agora as unknown as Record<string, unknown>)["expand"] as
  | ((shortId: string, directory: PeerReferenceDirectory) => string | undefined)
  | undefined;
const coreShorten = (Agora as unknown as Record<string, unknown>)["shorten"] as
  | ((id: string, directory?: PeerReferenceDirectory) => string)
  | undefined;
const coreShortKey = (Agora as unknown as Record<string, unknown>)["shortKey"] as
  | ((publicKey: string) => string)
  | undefined;
const coreCompactKnownInlineReferences = (Agora as unknown as Record<string, unknown>)["compactKnownInlineReferences"] as
  | ((text: string, directory: PeerReferenceDirectory) => string)
  | undefined;

export function shortKey(publicKey: string): string {
  const fromCore = coreShortKey ? coreShortKey(publicKey) : undefined;
  if (fromCore && fromCore.startsWith("@")) {
    return fromCore;
  }
  return `@${publicKey.slice(-8)}`;
}

function expandLocal(shortId: string, directory: PeerReferenceDirectory): string | undefined {
  const entries = Object.values(directory);
  if (entries.length === 0) {
    return undefined;
  }

  const token = shortId.trim();
  const direct = entries.find((entry) => entry.publicKey === token);
  if (direct) {
    return direct.publicKey;
  }

  // name@suffix8 (current canonical form)
  const namedAtSuffix = token.match(/^(.+)@([0-9a-fA-F]{8})$/);
  if (namedAtSuffix) {
    const [, name, suffix] = namedAtSuffix;
    const matches = entries.filter(
      (entry) => entry.name === name && entry.publicKey.toLowerCase().endsWith(suffix.toLowerCase()),
    );
    return matches.length === 1 ? matches[0].publicKey : undefined;
  }

  // @suffix8 (current canonical form for unknown peers)
  const atSuffixOnly = token.match(/^@([0-9a-fA-F]{8})$/);
  if (atSuffixOnly) {
    const [, suffix] = atSuffixOnly;
    const matches = entries.filter((entry) => entry.publicKey.toLowerCase().endsWith(suffix.toLowerCase()));
    return matches.length === 1 ? matches[0].publicKey : undefined;
  }

  // Legacy: name...suffix8
  const namedWithSuffix = token.match(/^(.+)\.\.\.([0-9a-fA-F]{8})$/);
  if (namedWithSuffix) {
    const [, name, suffix] = namedWithSuffix;
    const matches = entries.filter(
      (entry) => entry.name === name && entry.publicKey.toLowerCase().endsWith(suffix.toLowerCase()),
    );
    return matches.length === 1 ? matches[0].publicKey : undefined;
  }

  // Legacy: ...suffix8
  const suffixOnly = token.match(/^\.\.\.([0-9a-fA-F]{8})$/);
  if (suffixOnly) {
    const [, suffix] = suffixOnly;
    const matches = entries.filter((entry) => entry.publicKey.toLowerCase().endsWith(suffix.toLowerCase()));
    return matches.length === 1 ? matches[0].publicKey : undefined;
  }

  const byName = entries.filter((entry) => entry.name === token);
  return byName.length === 1 ? byName[0].publicKey : undefined;
}

function shortenLocal(id: string, directory?: PeerReferenceDirectory): string {
  const suffix = id.slice(-8);
  const entry = directory?.[id];
  if (!entry?.name) {
    return `@${suffix}`;
  }
  return `${entry.name}@${suffix}`;
}

/**
 * Build a directory keyed by public key from the configured Agora peers.
 * Optionally merges seen keys so expand() can resolve @suffix8 for previously-seen unknown peers.
 */
export function buildPeerReferenceDirectory(
  agoraService: Pick<IAgoraService, "getPeers" | "getPeerConfig" | "getSelfIdentity"> | null,
  seenKeyStore?: SeenKeyStore,
): PeerReferenceDirectory {
  const directory: PeerReferenceDirectory = {};
  if (!agoraService) {
    return directory;
  }

  // Config peers from agoraService
  for (const peerRef of agoraService.getPeers()) {
    const peer = agoraService.getPeerConfig(peerRef);
    if (!peer?.publicKey) {
      continue;
    }
    directory[peer.publicKey] = {
      publicKey: peer.publicKey,
      name: peer.name,
    };
  }

  // Include self so own public key resolves to a name in TO fields
  const self = agoraService.getSelfIdentity();
  if (self?.publicKey) {
    directory[self.publicKey] = { publicKey: self.publicKey, name: self.name };
  }

  if (!seenKeyStore) {
    return directory;
  }

  const merged = mergeDirectories(directory, seenKeyStore.toReferenceEntries());
  const mergedDirectory: PeerReferenceDirectory = {};
  for (const entry of merged) {
    mergedDirectory[entry.publicKey] = entry;
  }
  return mergedDirectory;
}

/**
 * Expand a peer reference (name, ...suffix, name...suffix) to a full public key.
 * Falls back to the original token when expansion is not possible.
 */
export function resolvePeerReference(reference: string, directory: PeerReferenceDirectory): string {
  const token = reference.trim();
  if (!token) {
    return reference;
  }

  const expanded = coreExpand ? coreExpand(token, directory) : expandLocal(token, directory);
  return expanded ?? reference;
}

/**
 * Compact a public key for display using configured names/suffixes.
 */
export function compactPeerReference(publicKey: string, directory: PeerReferenceDirectory): string {
  return coreShorten ? coreShorten(publicKey, directory) : shortenLocal(publicKey, directory);
}

/**
 * Compact @<full-id> references only when the ID is present in config peers.
 */
export function compactKnownInlineReferences(text: string, directory: PeerReferenceDirectory): string {
  if (coreCompactKnownInlineReferences) {
    return coreCompactKnownInlineReferences(text, directory);
  }

  return text.replace(/@([0-9a-fA-F]{16,})/g, (_full, id: string) => {
    const normalized = id;
    if (!directory[normalized]) {
      return `@${id}`;
    }
    return `@${compactPeerReference(normalized, directory)}`;
  });
}
