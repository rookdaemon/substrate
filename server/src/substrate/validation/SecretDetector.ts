/**
 * SecretDetector: Detects potential secrets (API keys, tokens, credentials) in content
 *
 * Implements Phase 1 security roadmap item: secret detection to prevent accidental
 * exposure of sensitive credentials in substrate files.
 *
 * Threat model reference: T-CONF-001 (API key exposure via substrate)
 */

export interface SecretMatch {
  type: string;
  pattern: string;
  match: string;
  line: number;
  column: number;
}

export interface SecretDetectionResult {
  hasSecrets: boolean;
  matches: SecretMatch[];
}

/**
 * Secret patterns with descriptions
 * Each pattern is designed to minimize false positives while catching real secrets
 */
const SECRET_PATTERNS: Array<{ type: string; pattern: RegExp; description: string }> = [
  // Generic API keys (long alphanumeric strings that look like keys)
  {
    type: "Generic API Key",
    pattern: /(?:api[_-]?key|apikey|key)["\s:=]+([a-zA-Z0-9_-]{32,})/gi,
    description: "Generic API key pattern"
  },

  // Generic tokens
  {
    type: "Generic Token",
    pattern: /(?:token|auth[_-]?token|access[_-]?token)["\s:=]+([a-zA-Z0-9_.-]{20,})/gi,
    description: "Generic authentication token"
  },

  // Generic secrets
  {
    type: "Generic Secret",
    pattern: /(?:secret|api[_-]?secret|client[_-]?secret)["\s:=]+([a-zA-Z0-9_-]{20,})/gi,
    description: "Generic secret pattern"
  },

  // AWS Access Key ID (20 characters, starts with AKIA)
  {
    type: "AWS Access Key ID",
    pattern: /AKIA[0-9A-Z]{16}/g,
    description: "AWS Access Key ID"
  },

  // AWS Secret Access Key (40 characters, base64-like)
  {
    type: "AWS Secret Access Key",
    pattern: /(?:aws[_-]?secret[_-]?access[_-]?key|aws[_-]?secret)["\s:=]+([a-zA-Z0-9/+=]{40})/gi,
    description: "AWS Secret Access Key"
  },

  // GitHub Personal Access Token (ghp_ prefix, 36+ chars)
  {
    type: "GitHub Token",
    pattern: /ghp_[a-zA-Z0-9]{36,}/g,
    description: "GitHub Personal Access Token"
  },

  // GitHub OAuth Token (gho_ prefix)
  {
    type: "GitHub OAuth Token",
    pattern: /gho_[a-zA-Z0-9]{36,}/g,
    description: "GitHub OAuth Token"
  },

  // Anthropic API Key (sk-ant- prefix)
  {
    type: "Anthropic API Key",
    pattern: /sk-ant-[a-zA-Z0-9-_]{95,}/g,
    description: "Anthropic Claude API Key"
  },

  // OpenAI API Key (sk- prefix, 48+ chars)
  {
    type: "OpenAI API Key",
    pattern: /sk-[a-zA-Z0-9]{48,}/g,
    description: "OpenAI API Key"
  },

  // Google Cloud API Key
  {
    type: "Google API Key",
    pattern: /AIza[0-9A-Za-z_-]{35}/g,
    description: "Google Cloud API Key"
  },

  // Slack tokens (xoxb-, xoxp-, xoxa-, xoxr- prefixes)
  {
    type: "Slack Token",
    pattern: /xox[bpars]-[0-9]{10,13}-[0-9]{10,13}-[a-zA-Z0-9]{24,}/g,
    description: "Slack API Token"
  },

  // JWT tokens (three base64 segments separated by dots)
  {
    type: "JWT Token",
    pattern: /eyJ[a-zA-Z0-9_-]{10,}\.[a-zA-Z0-9_-]{10,}\.[a-zA-Z0-9_-]{10,}/g,
    description: "JSON Web Token"
  },

  // Private keys (BEGIN PRIVATE KEY or BEGIN RSA PRIVATE KEY)
  {
    type: "Private Key",
    pattern: /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/g,
    description: "Private cryptographic key"
  },

  // Database connection strings
  {
    type: "Database Connection String",
    pattern: /(?:postgres|mysql|mongodb|redis):\/\/[^:]+:[^@]+@[^\s]+/gi,
    description: "Database connection string with credentials"
  },

  // Generic passwords in key-value format
  {
    type: "Password",
    pattern: /(?:password|passwd|pwd)\s*[:="']+\s*["']?([a-zA-Z0-9!@#$%^&*()_+-=]{8,})["']?/gi,
    description: "Password in configuration format"
  },

  // Bearer tokens in Authorization headers
  {
    type: "Bearer Token",
    pattern: /Bearer\s+[a-zA-Z0-9_.-]{20,}/g,
    description: "Bearer token in Authorization header"
  },

  // Basic auth credentials (base64 after 'Basic ')
  {
    type: "Basic Auth",
    pattern: /Basic\s+[a-zA-Z0-9+/=]{20,}/g,
    description: "Basic authentication credentials"
  }
];

/**
 * Detects potential secrets in the given content
 *
 * @param content - The content to scan for secrets
 * @returns SecretDetectionResult with hasSecrets flag and array of matches
 */
export function detectSecrets(content: string): SecretDetectionResult {
  const matches: SecretMatch[] = [];

  // Split content into lines for line number tracking
  const lines = content.split('\n');

  // Test each pattern against the content
  for (const { type, pattern } of SECRET_PATTERNS) {
    // Reset regex lastIndex to ensure we scan from the beginning
    pattern.lastIndex = 0;

    let match: RegExpExecArray | null;
    while ((match = pattern.exec(content)) !== null) {
      // Find which line this match is on
      let charCount = 0;
      let lineNumber = 0;
      let columnNumber = 0;

      for (let i = 0; i < lines.length; i++) {
        const lineLength = lines[i].length + 1; // +1 for newline
        if (charCount + lineLength > match.index) {
          lineNumber = i + 1; // 1-indexed
          columnNumber = match.index - charCount + 1; // 1-indexed
          break;
        }
        charCount += lineLength;
      }

      matches.push({
        type,
        pattern: pattern.source,
        match: match[0],
        line: lineNumber,
        column: columnNumber
      });
    }
  }

  return {
    hasSecrets: matches.length > 0,
    matches
  };
}

/**
 * Format secret detection results as human-readable error messages
 *
 * @param result - The secret detection result
 * @returns Array of error messages
 */
export function formatSecretErrors(result: SecretDetectionResult): string[] {
  if (!result.hasSecrets) {
    return [];
  }

  return result.matches.map(m =>
    `Potential ${m.type} detected at line ${m.line}, column ${m.column}: "${redactSecret(m.match)}"`
  );
}

/**
 * Redact a secret for safe display in error messages
 * Shows first 8 chars and last 4 chars, redacts the middle
 *
 * @param secret - The secret to redact
 * @returns Redacted version safe for logging
 */
function redactSecret(secret: string): string {
  if (secret.length <= 12) {
    return '***REDACTED***';
  }

  const prefix = secret.substring(0, 8);
  const suffix = secret.substring(secret.length - 4);
  const redactedLength = secret.length - 12;
  const redacted = '*'.repeat(Math.min(redactedLength, 20));

  return `${prefix}${redacted}${suffix}`;
}
