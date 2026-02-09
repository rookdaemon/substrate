export interface ProcessLogEntry {
  type: "thinking" | "text" | "tool_use" | "tool_result" | "status";
  content: string;
}

export class StreamJsonParser {
  private buffer = "";
  private accumulatedText = "";
  private resultText: string | null = null;

  constructor(private readonly onEntry: (entry: ProcessLogEntry) => void) {}

  push(chunk: string): void {
    this.buffer += chunk;

    let newlineIdx: number;
    while ((newlineIdx = this.buffer.indexOf("\n")) !== -1) {
      const line = this.buffer.slice(0, newlineIdx);
      this.buffer = this.buffer.slice(newlineIdx + 1);

      if (line.trim() === "") continue;
      this.parseLine(line);
    }
  }

  flush(): void {
    if (this.buffer.trim() !== "") {
      this.parseLine(this.buffer);
      this.buffer = "";
    }
  }

  getTextContent(): string {
    return this.resultText ?? this.accumulatedText;
  }

  private parseLine(line: string): void {
    let json: Record<string, unknown>;
    try {
      json = JSON.parse(line);
    } catch {
      this.onEntry({ type: "status", content: line });
      return;
    }

    const type = json.type as string;

    if (type === "system") {
      this.parseSystemEvent(json);
    } else if (type === "assistant") {
      this.parseAssistantMessage(json);
    } else if (type === "result") {
      this.parseResultEvent(json);
    } else {
      this.onEntry({ type: "status", content: type ?? "unknown" });
    }
  }

  private parseSystemEvent(json: Record<string, unknown>): void {
    const model = (json.model as string) ?? "unknown";
    const version = (json.claude_code_version as string) ?? "";
    this.onEntry({ type: "status", content: `init: model=${model} v${version}` });
  }

  private parseAssistantMessage(json: Record<string, unknown>): void {
    const message = json.message as Record<string, unknown> | undefined;
    if (!message) return;

    const content = message.content as Array<Record<string, unknown>> | undefined;
    if (!Array.isArray(content)) return;

    for (const block of content) {
      const entry = this.parseContentBlock(block);
      if (entry.type === "text") {
        this.accumulatedText += entry.content;
      }
      this.onEntry(entry);
    }
  }

  private parseResultEvent(json: Record<string, unknown>): void {
    if (typeof json.result === "string") {
      this.resultText = json.result;
    }
    const cost = json.total_cost_usd as number | undefined;
    const duration = json.duration_ms as number | undefined;
    const parts: string[] = [];
    if (json.subtype) parts.push(json.subtype as string);
    if (cost !== undefined) parts.push(`$${cost.toFixed(4)}`);
    if (duration !== undefined) parts.push(`${duration}ms`);
    this.onEntry({ type: "status", content: `result: ${parts.join(", ")}` });
  }

  private parseContentBlock(block: Record<string, unknown>): ProcessLogEntry {
    const blockType = block.type as string;

    switch (blockType) {
      case "thinking":
        return { type: "thinking", content: (block.thinking as string) ?? "" };
      case "text":
        return { type: "text", content: (block.text as string) ?? "" };
      case "tool_use": {
        const name = (block.name as string) ?? "unknown";
        const input = block.input ? JSON.stringify(block.input) : "{}";
        return { type: "tool_use", content: `${name}: ${input}` };
      }
      case "tool_result": {
        const content = typeof block.content === "string" ? block.content : JSON.stringify(block.content ?? "");
        return { type: "tool_result", content };
      }
      default:
        return { type: "status", content: blockType ?? "unknown_block" };
    }
  }
}
