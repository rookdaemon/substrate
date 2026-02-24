import { msgPreview } from "../../src/loop/utils";

describe("msgPreview", () => {
  it("returns the string unchanged when it is within the limit", () => {
    expect(msgPreview("hello")).toBe("hello");
  });

  it("returns the string unchanged when it equals the limit exactly", () => {
    const s = "a".repeat(80);
    expect(msgPreview(s)).toBe(s);
  });

  it("truncates and appends ellipsis when the string exceeds the limit", () => {
    const s = "a".repeat(81);
    expect(msgPreview(s)).toBe("a".repeat(80) + "...");
  });

  it("handles empty string gracefully", () => {
    expect(msgPreview("")).toBe("");
  });

  it("respects a custom maxChars parameter", () => {
    expect(msgPreview("hello world", 5)).toBe("hello...");
  });

  it("returns the string unchanged when length equals custom maxChars", () => {
    expect(msgPreview("hello", 5)).toBe("hello");
  });
});
