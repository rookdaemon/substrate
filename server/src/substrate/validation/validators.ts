import { SubstrateFileType } from "../types";
import { detectSecrets, formatSecretErrors, redactSecrets } from "./SecretDetector";

export interface ValidationResult {
  valid: boolean;
  errors: string[];
  warnings: string[];
  /** Present only when secrets were detected and redacted */
  redactedContent?: string;
}

export function validateSubstrateContent(
  content: string,
  _fileType: SubstrateFileType
): ValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];
  let redactedContent: string | undefined;

  if (!content || content.trim().length === 0) {
    errors.push("Content must not be empty");
  }

  if (content && !content.trimStart().startsWith("# ")) {
    errors.push("Content must start with a # heading");
  }

  // Secret detection: warn and redact, don't block
  const secretResult = detectSecrets(content);
  if (secretResult.hasSecrets) {
    warnings.push(...formatSecretErrors(secretResult));
    redactedContent = redactSecrets(content, secretResult);
  }

  return { valid: errors.length === 0, errors, warnings, redactedContent };
}
