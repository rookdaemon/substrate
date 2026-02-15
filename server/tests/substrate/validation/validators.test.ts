import { validateSubstrateContent } from "../../../src/substrate/validation/validators";
import { SubstrateFileType } from "../../../src/substrate/types";

describe("validateSubstrateContent", () => {
  describe("common rules (all file types)", () => {
    it("rejects empty content", () => {
      const result = validateSubstrateContent("", SubstrateFileType.MEMORY);
      expect(result.valid).toBe(false);
      expect(result.errors).toContain("Content must not be empty");
    });

    it("rejects content without a heading", () => {
      const result = validateSubstrateContent(
        "No heading here",
        SubstrateFileType.MEMORY
      );
      expect(result.valid).toBe(false);
      expect(result.errors).toContain("Content must start with a # heading");
    });

    it("accepts content with a valid heading", () => {
      const result = validateSubstrateContent(
        "# Memory\n\nSome content",
        SubstrateFileType.MEMORY
      );
      expect(result.valid).toBe(true);
      expect(result.errors).toHaveLength(0);
    });
  });

  describe("PLAN has no special structure requirements", () => {
    it("accepts PLAN with just a heading and text", () => {
      const result = validateSubstrateContent(
        "# Plan\n\nJust text",
        SubstrateFileType.PLAN
      );
      expect(result.valid).toBe(true);
    });

    it("accepts PLAN with custom sections", () => {
      const result = validateSubstrateContent(
        "# Plan\n\n## Phase 1\n\n- Something",
        SubstrateFileType.PLAN
      );
      expect(result.valid).toBe(true);
    });
  });

  describe("secret detection integration", () => {
    it("passes validation but warns and redacts content with API keys", () => {
      const content = '# Plan\n\n## Tasks\n\napi_key: "abcdef1234567890abcdef1234567890abcdef12"';
      const result = validateSubstrateContent(content, SubstrateFileType.PLAN);

      expect(result.valid).toBe(true);
      expect(result.warnings.some(w => w.includes("Generic API Key"))).toBe(true);
      expect(result.redactedContent).toBeDefined();
      expect(result.redactedContent).toContain("[REDACTED]");
      expect(result.redactedContent).not.toContain("abcdef1234567890abcdef1234567890abcdef12");
    });

    it("passes validation but warns and redacts content with tokens", () => {
      const content = '# Memory\n\nauth_token: "my-secret-token-12345678901234567890"';
      const result = validateSubstrateContent(content, SubstrateFileType.MEMORY);

      expect(result.valid).toBe(true);
      expect(result.warnings.some(w => w.includes("Generic Token"))).toBe(true);
      expect(result.redactedContent).toContain("[REDACTED]");
    });

    it("passes validation but warns and redacts AWS credentials", () => {
      const content = "# Skills\n\nAWS_ACCESS_KEY_ID=AKIAIOSFODNN7EXAMPLE";
      const result = validateSubstrateContent(content, SubstrateFileType.SKILLS);

      expect(result.valid).toBe(true);
      expect(result.warnings.some(w => w.includes("AWS Access Key ID"))).toBe(true);
      expect(result.redactedContent).toContain("[REDACTED]");
    });

    it("passes validation but warns and redacts private keys", () => {
      const content = "# Security\n\n-----BEGIN PRIVATE KEY-----\nMIIEvQIBADANBg...";
      const result = validateSubstrateContent(content, SubstrateFileType.SECURITY);

      expect(result.valid).toBe(true);
      expect(result.warnings.some(w => w.includes("Private Key"))).toBe(true);
      expect(result.redactedContent).toContain("[REDACTED]");
    });

    it("passes validation but warns and redacts database connection strings", () => {
      const content = "# Memory\n\nDATABASE_URL=postgres://user:password@localhost:5432/mydb";
      const result = validateSubstrateContent(content, SubstrateFileType.MEMORY);

      expect(result.valid).toBe(true);
      expect(result.warnings.some(w => w.includes("Database Connection String"))).toBe(true);
      expect(result.redactedContent).toContain("[REDACTED]");
    });

    it("returns no warnings or redacted content for clean files", () => {
      const content = "# Memory\n\nI learned about API key security today. Always use environment variables!";
      const result = validateSubstrateContent(content, SubstrateFileType.MEMORY);

      expect(result.valid).toBe(true);
      expect(result.warnings).toHaveLength(0);
      expect(result.redactedContent).toBeUndefined();
    });

    it("provides detailed warning messages with line numbers", () => {
      const content = '# Plan\n\n## Tasks\n\napi_key: "abcdef1234567890abcdef1234567890abcdef12"';
      const result = validateSubstrateContent(content, SubstrateFileType.PLAN);

      expect(result.warnings.some(w => w.includes("line"))).toBe(true);
      expect(result.warnings.some(w => w.includes("column"))).toBe(true);
    });

    it("redacts secrets in warning messages", () => {
      const content = '# Memory\n\napi_key: "abcdef1234567890abcdef1234567890abcdef12"';
      const result = validateSubstrateContent(content, SubstrateFileType.MEMORY);

      expect(result.warnings[0]).toContain("*");
      expect(result.warnings[0]).not.toContain("abcdef1234567890abcdef1234567890abcdef12");
    });
  });
});
