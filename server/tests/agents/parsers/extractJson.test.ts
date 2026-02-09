import { extractJson } from "../../../src/agents/parsers/extractJson";

describe("extractJson", () => {
  it("parses clean JSON", () => {
    const result = extractJson('{"action":"idle"}');
    expect(result).toEqual({ action: "idle" });
  });

  it("extracts JSON from surrounding prose", () => {
    const result = extractJson('Now let me analyze this.\n{"action":"idle","reason":"nothing to do"}\nDone.');
    expect(result).toEqual({ action: "idle", reason: "nothing to do" });
  });

  it("extracts JSON from markdown code block", () => {
    const result = extractJson('Here is my response:\n```json\n{"result":"success"}\n```');
    expect(result).toEqual({ result: "success" });
  });

  it("extracts JSON with nested braces", () => {
    const result = extractJson('Response: {"data":{"nested":true},"list":[1,2]}');
    expect(result).toEqual({ data: { nested: true }, list: [1, 2] });
  });

  it("throws on no JSON found", () => {
    expect(() => extractJson("No JSON here at all")).toThrow(/No JSON object found/);
  });

  it("throws on empty input", () => {
    expect(() => extractJson("")).toThrow(/No JSON object found/);
  });

  it("handles JSON with string values containing braces", () => {
    const result = extractJson('{"summary":"used {curly} braces"}');
    expect(result).toEqual({ summary: "used {curly} braces" });
  });
});
