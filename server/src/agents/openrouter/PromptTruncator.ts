const CHARS_PER_TOKEN = 4;
const RESPONSE_RESERVE_TOKENS = 4096;
const SAFETY_FACTOR = 0.9;
const HEAD_FRACTION = 0.7;
const TRUNCATION_MARKER = "\n...[content truncated to fit context window]...\n";

/**
 * Removes the middle of text, keeping the head and tail within maxChars.
 * Preserves the beginning (structure, headers) and end (most recent content,
 * instruction) while discarding the middle bulk.
 */
export function truncateMiddle(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  const markerLen = TRUNCATION_MARKER.length;
  const contentChars = maxChars - markerLen;
  const headChars = Math.floor(contentChars * HEAD_FRACTION);
  const tailChars = contentChars - headChars;
  return text.slice(0, headChars) + TRUNCATION_MARKER + text.slice(text.length - tailChars);
}

/**
 * Truncates system prompt and user message to fit within the model's context
 * window, leaving room for a response.
 *
 * System prompt typically contains short role instructions and passes through
 * unchanged. The user message (which carries all inlined substrate file content)
 * receives the bulk of the available budget.
 */
export function fitToContextWindow(
  systemPrompt: string,
  userMessage: string,
  contextWindowTokens: number,
): { systemPrompt: string; userMessage: string } {
  const budgetChars = Math.floor(
    (contextWindowTokens - RESPONSE_RESERVE_TOKENS) * CHARS_PER_TOKEN * SAFETY_FACTOR,
  );

  if (systemPrompt.length + userMessage.length <= budgetChars) {
    return { systemPrompt, userMessage };
  }

  // Give system up to 25% of the total budget; surplus flows to the user message.
  const systemBudget = Math.min(systemPrompt.length, Math.floor(budgetChars * 0.25));
  const userBudget = budgetChars - systemBudget;

  return {
    systemPrompt: truncateMiddle(systemPrompt, systemBudget),
    userMessage: truncateMiddle(userMessage, userBudget),
  };
}
