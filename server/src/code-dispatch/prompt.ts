import type { SubstrateSlice } from "./ICodeBackend";

/**
 * Compose the prompt for a code backend from CODING_CONTEXT.md content,
 * source file snapshots, and the task specification.
 *
 * @param spec - The task specification or instruction.
 * @param context - Substrate slice containing optional coding context, file
 *   contents, and working directory. The `fileContents` map is injected inline:
 *   large maps (many files or files with large content) will produce
 *   proportionally large prompts and significant token cost. Callers should
 *   limit `fileContents` to directly relevant files. A typical source file is
 *   ~200–500 tokens; injecting 20+ files can push a single code-dispatch call
 *   past 10k tokens before the task spec is even appended.
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
