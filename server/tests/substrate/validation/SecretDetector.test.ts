import {
  detectSecrets,
  formatSecretErrors,
  SecretDetectionResult
} from "../../../src/substrate/validation/SecretDetector";

describe("SecretDetector", () => {
  describe("detectSecrets", () => {
    it("returns no matches for clean content", () => {
      const content = "# Memory\n\nThis is just normal content with no secrets.";
      const result = detectSecrets(content);

      expect(result.hasSecrets).toBe(false);
      expect(result.matches).toHaveLength(0);
    });

    it("detects generic API key pattern", () => {
      const content = 'api_key: "abcdef1234567890abcdef1234567890abcdef12"';
      const result = detectSecrets(content);

      expect(result.hasSecrets).toBe(true);
      expect(result.matches).toHaveLength(1);
      expect(result.matches[0].type).toBe("Generic API Key");
      expect(result.matches[0].line).toBe(1);
    });

    it("detects generic token pattern", () => {
      const content = 'auth_token: "my-secret-token-12345678901234567890"';
      const result = detectSecrets(content);

      expect(result.hasSecrets).toBe(true);
      expect(result.matches).toHaveLength(1);
      expect(result.matches[0].type).toBe("Generic Token");
    });

    it("detects generic secret pattern", () => {
      const content = 'client_secret: "super-secret-value-1234567890123"';
      const result = detectSecrets(content);

      expect(result.hasSecrets).toBe(true);
      expect(result.matches).toHaveLength(1);
      expect(result.matches[0].type).toBe("Generic Secret");
    });

    it("detects AWS Access Key ID", () => {
      const content = "AWS_ACCESS_KEY_ID=AKIAIOSFODNN7EXAMPLE";
      const result = detectSecrets(content);

      expect(result.hasSecrets).toBe(true);
      expect(result.matches.some(m => m.type === "AWS Access Key ID")).toBe(true);
    });

    it("detects AWS Secret Access Key", () => {
      const content = 'aws_secret_access_key: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY"';
      const result = detectSecrets(content);

      expect(result.hasSecrets).toBe(true);
      expect(result.matches.some(m => m.type === "AWS Secret Access Key")).toBe(true);
    });

    it("detects GitHub Personal Access Token", () => {
      const content = "GITHUB_TOKEN=ghp_1234567890abcdefghijklmnopqrstuvwxyz1234";
      const result = detectSecrets(content);

      expect(result.hasSecrets).toBe(true);
      expect(result.matches.some(m => m.type === "GitHub Token")).toBe(true);
    });

    it("detects GitHub OAuth Token", () => {
      const content = "token: gho_abcdefghijklmnopqrstuvwxyz0123456789";
      const result = detectSecrets(content);

      expect(result.hasSecrets).toBe(true);
      expect(result.matches.some(m => m.type === "GitHub OAuth Token")).toBe(true);
    });

    it("detects Anthropic API Key", () => {
      const content = "ANTHROPIC_API_KEY=sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789abcdefghijklmnopqrs";
      const result = detectSecrets(content);

      expect(result.hasSecrets).toBe(true);
      expect(result.matches.some(m => m.type === "Anthropic API Key")).toBe(true);
    });

    it("detects OpenAI API Key", () => {
      const content = "OPENAI_API_KEY=sk-abcdefghijklmnopqrstuvwxyz0123456789ABCDEFGHIJ";
      const result = detectSecrets(content);

      expect(result.hasSecrets).toBe(true);
      // May be detected as "OpenAI API Key" or "Generic API Key" - both are correct
      expect(result.matches.length).toBeGreaterThan(0);
      expect(result.matches[0].match).toContain("sk-");
    });

    it("detects Google API Key", () => {
      const content = "GOOGLE_API_KEY=AIzaSyD1234567890abcdefghijklmnopqr";
      const result = detectSecrets(content);

      expect(result.hasSecrets).toBe(true);
      // May be detected as "Google API Key" or "Generic API Key" - both are correct
      expect(result.matches.length).toBeGreaterThan(0);
      expect(result.matches[0].match).toContain("AIza");
    });

    it("detects Slack Token", () => {
      // Build token dynamically to avoid triggering GitHub secret scanning
      const token = `xoxb-${"9".repeat(10)}-${"9".repeat(13)}-${"X".repeat(20)}9999`;
      const content = `SLACK_TOKEN=${token}`;
      const result = detectSecrets(content);

      expect(result.hasSecrets).toBe(true);
      expect(result.matches.some(m => m.type === "Slack Token")).toBe(true);
    });

    it("detects JWT Token", () => {
      const content = "Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U";
      const result = detectSecrets(content);

      expect(result.hasSecrets).toBe(true);
      expect(result.matches.some(m => m.type === "JWT Token")).toBe(true);
    });

    it("detects Private Key header", () => {
      const content = "-----BEGIN PRIVATE KEY-----\nMIIEvQIBADANBg...";
      const result = detectSecrets(content);

      expect(result.hasSecrets).toBe(true);
      expect(result.matches.some(m => m.type === "Private Key")).toBe(true);
    });

    it("detects RSA Private Key header", () => {
      const content = "-----BEGIN RSA PRIVATE KEY-----\nMIIEpAIBAAKCAQ...";
      const result = detectSecrets(content);

      expect(result.hasSecrets).toBe(true);
      expect(result.matches.some(m => m.type === "Private Key")).toBe(true);
    });

    it("detects database connection string with credentials", () => {
      const content = "DATABASE_URL=postgres://user:password@localhost:5432/mydb";
      const result = detectSecrets(content);

      expect(result.hasSecrets).toBe(true);
      expect(result.matches.some(m => m.type === "Database Connection String")).toBe(true);
    });

    it("detects password in key-value format", () => {
      const content = 'password: "mySecretPass123!"';
      const result = detectSecrets(content);

      expect(result.hasSecrets).toBe(true);
      expect(result.matches.some(m => m.type === "Password")).toBe(true);
    });

    it("detects Bearer token", () => {
      const content = "Authorization: Bearer abc123def456ghi789jkl012mno345";
      const result = detectSecrets(content);

      expect(result.hasSecrets).toBe(true);
      expect(result.matches.some(m => m.type === "Bearer Token")).toBe(true);
    });

    it("detects Basic auth credentials", () => {
      const content = "Authorization: Basic dXNlcm5hbWU6cGFzc3dvcmQ=";
      const result = detectSecrets(content);

      expect(result.hasSecrets).toBe(true);
      expect(result.matches.some(m => m.type === "Basic Auth")).toBe(true);
    });

    it("detects multiple secrets in same content", () => {
      const content = `
        # Configuration
        OPENAI_API_KEY=sk-abcdefghijklmnopqrstuvwxyz0123456789ABCDEFGHIJ
        ANTHROPIC_API_KEY=sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789abcdefghijklmnopqrs
        DATABASE_URL=postgres://user:pass@localhost/db
      `;
      const result = detectSecrets(content);

      expect(result.hasSecrets).toBe(true);
      expect(result.matches.length).toBeGreaterThanOrEqual(3);
    });

    it("tracks correct line numbers for secrets", () => {
      const content = `# Header
Line 2 is clean
api_key: "abcdef1234567890abcdef1234567890abcdef12"
Line 4 is also clean`;

      const result = detectSecrets(content);

      expect(result.hasSecrets).toBe(true);
      expect(result.matches[0].line).toBe(3);
    });

    it("tracks correct column numbers for secrets", () => {
      const content = 'Prefix text api_key: "abcdef1234567890abcdef1234567890abcdef12"';
      const result = detectSecrets(content);

      expect(result.hasSecrets).toBe(true);
      expect(result.matches[0].column).toBeGreaterThan(1);
    });

    it("does not flag prose mentioning 'password' without assignment", () => {
      const content = '- **Bluesky posting**: App password configured in ~/.config/bluesky/credentials.json';
      const result = detectSecrets(content);

      expect(result.matches.filter(m => m.type === "Password")).toHaveLength(0);
    });

    it("still detects password with assignment operator", () => {
      const content = "password=mySecretPass1234";
      const result = detectSecrets(content);

      expect(result.hasSecrets).toBe(true);
      expect(result.matches.some(m => m.type === "Password")).toBe(true);
    });

    it("still detects password with colon separator", () => {
      const content = "password: mySecretPass1234";
      const result = detectSecrets(content);

      expect(result.hasSecrets).toBe(true);
      expect(result.matches.some(m => m.type === "Password")).toBe(true);
    });

    it("does not detect short strings that happen to match keywords", () => {
      const content = "The word 'token' appears but token=short is not a secret";
      const result = detectSecrets(content);

      // Should not match because "short" is < 20 chars
      expect(result.hasSecrets).toBe(false);
    });

    it("handles multiline content correctly", () => {
      const content = `# Memory

## API Keys

I learned about API key security today.

## Not Actual Secrets

api_key_placeholder: "example"
password_field: "demo"`;

      const result = detectSecrets(content);

      // Should not match placeholders/examples (too short)
      expect(result.hasSecrets).toBe(false);
    });
  });

  describe("formatSecretErrors", () => {
    it("returns empty array when no secrets detected", () => {
      const result: SecretDetectionResult = {
        hasSecrets: false,
        matches: []
      };

      const errors = formatSecretErrors(result);
      expect(errors).toHaveLength(0);
    });

    it("formats single secret error with redaction", () => {
      const result: SecretDetectionResult = {
        hasSecrets: true,
        matches: [
          {
            type: "Generic API Key",
            pattern: "test",
            match: "abcdef1234567890abcdef1234567890abcdef12",
            line: 5,
            column: 10
          }
        ]
      };

      const errors = formatSecretErrors(result);
      expect(errors).toHaveLength(1);
      expect(errors[0]).toContain("Generic API Key");
      expect(errors[0]).toContain("line 5");
      expect(errors[0]).toContain("column 10");
      // Should show partial secret (first 8 + last 4)
      expect(errors[0]).toContain("abcdef12");
      expect(errors[0]).toContain("f12");
      // Should contain redaction asterisks
      expect(errors[0]).toContain("*");
    });

    it("formats multiple secret errors", () => {
      const result: SecretDetectionResult = {
        hasSecrets: true,
        matches: [
          {
            type: "Generic API Key",
            pattern: "test",
            match: "abcdef1234567890abcdef1234567890abcdef12",
            line: 5,
            column: 10
          },
          {
            type: "Generic Token",
            pattern: "test",
            match: "token-1234567890abcdefghij",
            line: 8,
            column: 15
          }
        ]
      };

      const errors = formatSecretErrors(result);
      expect(errors).toHaveLength(2);
      expect(errors[0]).toContain("Generic API Key");
      expect(errors[1]).toContain("Generic Token");
    });

    it("redacts short secrets completely", () => {
      const result: SecretDetectionResult = {
        hasSecrets: true,
        matches: [
          {
            type: "Short Secret",
            pattern: "test",
            match: "short",
            line: 1,
            column: 1
          }
        ]
      };

      const errors = formatSecretErrors(result);
      expect(errors[0]).toContain("***REDACTED***");
      expect(errors[0]).not.toContain("short");
    });
  });
});
