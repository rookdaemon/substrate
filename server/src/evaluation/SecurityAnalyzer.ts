import { SubstrateFileReader } from "../substrate/io/FileReader";
import { SubstrateFileType } from "../substrate/types";

export interface SecurityResult {
  score: number; // 0-1, security compliance score (1 = fully compliant, 0 = critical issues)
  compliant: boolean;
  issues: string[];
}

export class SecurityAnalyzer {
  constructor(private readonly reader: SubstrateFileReader) {}

  async analyze(): Promise<SecurityResult> {
    const issues: string[] = [];
    let totalChecks = 0;
    let passedChecks = 0;

    // Check SECURITY file exists and is readable
    totalChecks++;
    let content: string;
    try {
      const file = await this.reader.read(SubstrateFileType.SECURITY);
      content = file.rawMarkdown;
      passedChecks++;
    } catch {
      return { score: 0, compliant: false, issues: ["SECURITY file is missing"] };
    }

    // Check SECURITY file is not empty
    totalChecks++;
    if (content.trim()) {
      passedChecks++;
    } else {
      issues.push("SECURITY file is empty");
    }

    // Check SECURITY file has constraints section
    totalChecks++;
    const hasConstraints = /## constraints/i.test(content);
    if (hasConstraints) {
      passedChecks++;
    } else {
      issues.push("SECURITY file is missing a constraints section");
    }

    const score = totalChecks > 0 ? passedChecks / totalChecks : 0;
    const compliant = issues.length === 0;
    return { score, compliant, issues };
  }
}
