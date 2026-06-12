import type { SubstrateSlice } from "./ICodeBackend";

/**
 * Compose the prompt for a code backend from CODING_CONTEXT.md content,
 * source file snapshots, and the task specification.
 *
 * **Token-budget risk:** The prompt grows proportionally with the number and
 * size of files in `context.fileContents`. There is no cap enforced here.
 * Callers (CodeDispatcher) are responsible for limiting which files they
 * include — reading many large files or an entire repo into a SubstrateSlice
 * will silently produce an oversized prompt that may hit provider context
 * limits or inflate token costs.
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
