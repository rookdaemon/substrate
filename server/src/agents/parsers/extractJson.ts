/**
 * Extract and parse a JSON object from text that may contain surrounding prose.
 * Tries JSON.parse first (fast path), then scans for the outermost { ... } block.
 */
export function extractJson(text: string): Record<string, unknown> {
  const trimmed = text.trim();

  // Fast path: entire text is valid JSON
  try {
    const parsed = JSON.parse(trimmed);
    if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // Fall through to extraction
  }

  // Find the first '{' and match to its closing '}'
  const start = trimmed.indexOf("{");
  if (start === -1) {
    throw new Error("No JSON object found in response");
  }

  // Walk forward counting braces, respecting strings
  let depth = 0;
  let inString = false;
  let escape = false;

  for (let i = start; i < trimmed.length; i++) {
    const ch = trimmed[i];

    if (escape) {
      escape = false;
      continue;
    }

    if (ch === "\\") {
      escape = true;
      continue;
    }

    if (ch === '"') {
      inString = !inString;
      continue;
    }

    if (inString) continue;

    if (ch === "{") depth++;
    if (ch === "}") {
      depth--;
      if (depth === 0) {
        const candidate = trimmed.slice(start, i + 1);
        return JSON.parse(candidate) as Record<string, unknown>;
      }
    }
  }

  throw new Error("No JSON object found in response");
}
