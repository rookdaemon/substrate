import { shortKey } from "../../src/agora/utils";

describe("Agora utils", () => {
  describe("shortKey", () => {
    it("should return last 8 characters of a public key", () => {
      const publicKey = "302a300506032b6570032100abcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcd";
      expect(shortKey(publicKey)).toBe("cdefabcd...");
    });

    it("should handle different key endings", () => {
      const key1 = "302a300506032b65700321001234567890abcdef1234567890abcdef1234567890abcdef1234567890ab1b69";
      const key2 = "302a300506032b65700321009876543210fedcba9876543210fedcba9876543210fedcba9876543210fef6d0";
      const key3 = "302a300506032b6570032100aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa3eb4";
      
      expect(shortKey(key1)).toBe("90ab1b69...");
      expect(shortKey(key2)).toBe("10fef6d0...");
      expect(shortKey(key3)).toBe("aaaa3eb4...");
    });

    it("should work with short keys", () => {
      expect(shortKey("12345678")).toBe("12345678...");
      expect(shortKey("abc")).toBe("abc...");
    });

    it("should work with empty string", () => {
      expect(shortKey("")).toBe("...");
    });
  });
});
