import {
  StreamJsonParser,
  ProcessLogEntry,
} from "../../../src/agents/claude/StreamJsonParser";

function systemLine(model = "claude-opus-4-6", version = "2.1.37"): string {
  return JSON.stringify({
    type: "system",
    subtype: "init",
    model,
    claude_code_version: version,
    tools: [],
  });
}

function assistantLine(content: Array<Record<string, unknown>>): string {
  return JSON.stringify({
    type: "assistant",
    message: { content },
  });
}

function resultLine(result: string, cost = 0.01, duration = 1000): string {
  return JSON.stringify({
    type: "result",
    subtype: "success",
    result,
    total_cost_usd: cost,
    duration_ms: duration,
  });
}

describe("StreamJsonParser", () => {
  let parser: StreamJsonParser;
  let entries: ProcessLogEntry[];

  beforeEach(() => {
    entries = [];
    parser = new StreamJsonParser((entry) => entries.push(entry));
  });

  describe("line buffering", () => {
    it("handles a complete line ending with newline", () => {
      parser.push(assistantLine([{ type: "text", text: "hello" }]) + "\n");
      expect(entries).toHaveLength(1);
      expect(entries[0].type).toBe("text");
    });

    it("buffers partial lines until newline arrives", () => {
      const full = assistantLine([{ type: "text", text: "hello" }]);
      const mid = Math.floor(full.length / 2);
      parser.push(full.slice(0, mid));
      expect(entries).toHaveLength(0);

      parser.push(full.slice(mid) + "\n");
      expect(entries).toHaveLength(1);
      expect(entries[0].type).toBe("text");
      expect(entries[0].content).toBe("hello");
    });

    it("handles multiple lines in a single chunk", () => {
      parser.push(
        assistantLine([{ type: "thinking", thinking: "a" }]) + "\n" +
        assistantLine([{ type: "text", text: "b" }]) + "\n"
      );
      expect(entries).toHaveLength(2);
      expect(entries[0].type).toBe("thinking");
      expect(entries[1].type).toBe("text");
    });

    it("handles chunk ending mid-line followed by rest", () => {
      const line = assistantLine([{ type: "text", text: "split" }]);
      parser.push(line.slice(0, 10));
      parser.push(line.slice(10) + "\n");
      expect(entries).toHaveLength(1);
      expect(entries[0].content).toBe("split");
    });
  });

  describe("system events", () => {
    it("parses system init as status with model and version", () => {
      parser.push(systemLine("claude-opus-4-6", "2.1.37") + "\n");
      expect(entries[0]).toEqual({
        type: "status",
        content: "init: model=claude-opus-4-6 v2.1.37",
      });
    });
  });

  describe("assistant message content blocks", () => {
    it("parses text blocks", () => {
      parser.push(assistantLine([{ type: "text", text: "result here" }]) + "\n");
      expect(entries[0]).toEqual({ type: "text", content: "result here" });
    });

    it("parses thinking blocks", () => {
      parser.push(assistantLine([{ type: "thinking", thinking: "analyzing" }]) + "\n");
      expect(entries[0]).toEqual({ type: "thinking", content: "analyzing" });
    });

    it("parses tool_use blocks", () => {
      parser.push(
        assistantLine([{ type: "tool_use", name: "bash", input: { cmd: "ls" } }]) + "\n"
      );
      expect(entries[0]).toEqual({ type: "tool_use", content: 'bash: {"cmd":"ls"}' });
    });

    it("parses tool_result blocks", () => {
      parser.push(
        assistantLine([{ type: "tool_result", content: "files.txt" }]) + "\n"
      );
      expect(entries[0]).toEqual({ type: "tool_result", content: "files.txt" });
    });

    it("emits multiple entries from a single assistant message", () => {
      parser.push(
        assistantLine([
          { type: "thinking", thinking: "hmm" },
          { type: "text", text: "answer" },
          { type: "tool_use", name: "read", input: { path: "/a" } },
        ]) + "\n"
      );
      expect(entries).toHaveLength(3);
      expect(entries[0].type).toBe("thinking");
      expect(entries[1].type).toBe("text");
      expect(entries[2].type).toBe("tool_use");
    });
  });

  describe("result events", () => {
    it("parses result as status with cost and duration", () => {
      parser.push(resultLine("hello", 0.0116, 2187) + "\n");
      expect(entries[0]).toEqual({
        type: "status",
        content: "result: success, $0.0116, 2187ms",
      });
    });

    it("stores result text for getTextContent()", () => {
      parser.push(resultLine("final answer") + "\n");
      expect(parser.getTextContent()).toBe("final answer");
    });
  });

  describe("graceful handling of unknown/malformed data", () => {
    it("treats unknown JSON types as status", () => {
      parser.push('{"type":"unknown_event","data":"foo"}\n');
      expect(entries[0]).toEqual({ type: "status", content: "unknown_event" });
    });

    it("treats malformed JSON as raw log entry", () => {
      parser.push("this is not json\n");
      expect(entries[0]).toEqual({ type: "status", content: "this is not json" });
    });

    it("ignores empty lines", () => {
      parser.push("\n\n");
      expect(entries).toHaveLength(0);
    });
  });

  describe("text accumulation", () => {
    it("accumulates text from assistant content blocks", () => {
      parser.push(assistantLine([{ type: "text", text: "hello " }]) + "\n");
      parser.push(assistantLine([{ type: "text", text: "world" }]) + "\n");
      expect(parser.getTextContent()).toBe("hello world");
    });

    it("returns empty string when no text blocks received", () => {
      parser.push(assistantLine([{ type: "thinking", thinking: "hmm" }]) + "\n");
      expect(parser.getTextContent()).toBe("");
    });

    it("only accumulates text blocks, not thinking or tool_use", () => {
      parser.push(
        assistantLine([
          { type: "thinking", thinking: "hmm" },
          { type: "text", text: "answer" },
          { type: "tool_use", name: "bash", input: {} },
        ]) + "\n"
      );
      expect(parser.getTextContent()).toBe("answer");
    });

    it("result text overrides accumulated text for getTextContent()", () => {
      parser.push(assistantLine([{ type: "text", text: "streamed" }]) + "\n");
      parser.push(resultLine("final") + "\n");
      expect(parser.getTextContent()).toBe("final");
    });
  });

  describe("flush", () => {
    it("flushes remaining buffer content", () => {
      parser.push(assistantLine([{ type: "text", text: "no newline" }]));
      expect(entries).toHaveLength(0);
      parser.flush();
      expect(entries).toHaveLength(1);
      expect(entries[0].content).toBe("no newline");
    });

    it("does nothing when buffer is empty", () => {
      parser.flush();
      expect(entries).toHaveLength(0);
    });
  });

  describe("full stream simulation", () => {
    it("handles a complete 3-line stream", () => {
      parser.push(systemLine() + "\n");
      parser.push(assistantLine([{ type: "text", text: "hello" }]) + "\n");
      parser.push(resultLine("hello", 0.0116, 2187) + "\n");

      expect(entries).toHaveLength(3);
      expect(entries[0].type).toBe("status"); // system init
      expect(entries[1]).toEqual({ type: "text", content: "hello" });
      expect(entries[2].type).toBe("status"); // result
      expect(parser.getTextContent()).toBe("hello");
    });
  });
});
