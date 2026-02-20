/**
 * Scans markdown content for @-references to substrate subfiles.
 * e.g., "@memory/foo.md" → "memory/foo.md"
 */
export class ReferenceScanner {
  private static readonly REFERENCE_PATTERN = /@([a-zA-Z0-9_\-/]+\.md)/g;

  extractReferences(content: string): string[] {
    const matches = content.matchAll(ReferenceScanner.REFERENCE_PATTERN);
    return Array.from(matches, (m) => m[1]);
  }
}
