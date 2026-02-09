/**
 * Wraps a text string as stream-json stdout output (as produced by `claude --print --verbose --output-format stream-json`).
 * Produces an assistant message line + result line matching the real CLI format.
 */
export function asStreamJson(textContent: string): string {
  const assistantLine = JSON.stringify({
    type: "assistant",
    message: {
      content: [{ type: "text", text: textContent }],
    },
  });
  const resultLine = JSON.stringify({
    type: "result",
    subtype: "success",
    result: textContent,
    total_cost_usd: 0,
    duration_ms: 0,
  });
  return `${assistantLine}\n${resultLine}\n`;
}
