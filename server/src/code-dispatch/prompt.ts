import type { SubstrateSlice } from "./ICodeBackend";

/**
 * Compose the prompt for a code backend from CODING_CONTEXT.md content,
 * source file snapshots, and the task specification.
 */
export function buildPrompt(spec: string, context: SubstrateSlice): string {
  const parts: string[] = [];

  if (context.codingContext) {
    parts.push("=== CODING CONTEXT ===\n" + context.codingContext);
  }

  if (context.fileContents.size > 0) {
    parts.push("=== SOURCE FILES ===");
    for (const [filename, content] of context.fileContents) {
      parts.push(`--- ${filename} ---\n${content}`);
    }
  }

  parts.push("=== TASK ===\n" + spec);

  return parts.join("\n\n");
}
