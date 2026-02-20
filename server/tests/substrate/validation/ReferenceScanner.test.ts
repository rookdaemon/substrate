import { ReferenceScanner } from "../../../src/substrate/validation/ReferenceScanner";

describe("ReferenceScanner", () => {
  let scanner: ReferenceScanner;

  beforeEach(() => {
    scanner = new ReferenceScanner();
  });

  describe("extractReferences", () => {
    it("returns empty array for content with no references", () => {
      const result = scanner.extractReferences("# Memory\n\nSome content without refs.");
      expect(result).toEqual([]);
    });

    it("extracts a single @-reference", () => {
      const result = scanner.extractReferences("# Memory\n\n@memory/foo.md");
      expect(result).toEqual(["memory/foo.md"]);
    });

    it("extracts multiple @-references", () => {
      const content = "# Memory\n\n@memory/foo.md\n@memory/bar.md\n@skills/coding.md";
      const result = scanner.extractReferences(content);
      expect(result).toEqual(["memory/foo.md", "memory/bar.md", "skills/coding.md"]);
    });

    it("extracts references with underscores and hyphens", () => {
      const result = scanner.extractReferences("@memory/self_improvement_review.md and @habits/daily-routine.md");
      expect(result).toEqual(["memory/self_improvement_review.md", "habits/daily-routine.md"]);
    });

    it("extracts references inline with other text", () => {
      const content = "See @memory/foo.md for details about the topic.";
      const result = scanner.extractReferences(content);
      expect(result).toEqual(["memory/foo.md"]);
    });

    it("does not extract plain filenames without @ prefix", () => {
      const result = scanner.extractReferences("memory/foo.md is a file");
      expect(result).toEqual([]);
    });

    it("does not extract @-tokens that are not .md files", () => {
      const result = scanner.extractReferences("@someone mention and @not-a-file");
      expect(result).toEqual([]);
    });

    it("handles deeply nested paths", () => {
      const result = scanner.extractReferences("@memory/subdir/deep/file.md");
      expect(result).toEqual(["memory/subdir/deep/file.md"]);
    });

    it("returns duplicate references when same ref appears multiple times", () => {
      const content = "@memory/foo.md and again @memory/foo.md";
      const result = scanner.extractReferences(content);
      expect(result).toEqual(["memory/foo.md", "memory/foo.md"]);
    });

    it("handles empty string", () => {
      const result = scanner.extractReferences("");
      expect(result).toEqual([]);
    });
  });
});
