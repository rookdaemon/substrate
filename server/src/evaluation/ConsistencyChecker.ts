import { SubstrateFileReader } from "../substrate/io/FileReader";
import { SubstrateFileType } from "../substrate/types";

export interface ConsistencyIssue {
  message: string;
}

export interface ConsistencyResult {
  score: number; // 0-1, percentage of checks passing (1 = all pass, 0 = all fail)
  inconsistencies: ConsistencyIssue[];
}

export class ConsistencyChecker {
  constructor(private readonly reader: SubstrateFileReader) {}

  async check(): Promise<ConsistencyResult> {
    const inconsistencies: ConsistencyIssue[] = [];
    let totalChecks = 0;
    let passedChecks = 0;

    // Check PLAN exists and has content
    totalChecks++;
    let planContent = "";
    try {
      const plan = await this.reader.read(SubstrateFileType.PLAN);
      planContent = plan.rawMarkdown;
      passedChecks++;
    } catch {
      inconsistencies.push({ message: "PLAN file is missing or unreadable" });
    }

    // Check if plan has tasks
    totalChecks++;
    const hasTaskLines = /- \[[ x]\]/.test(planContent);
    if (hasTaskLines) {
      passedChecks++;
    } else {
      inconsistencies.push({ message: "PLAN has empty task list" });
    }

    // Check SKILLS exists
    totalChecks++;
    try {
      await this.reader.read(SubstrateFileType.SKILLS);
      passedChecks++;
    } catch {
      inconsistencies.push({ message: "SKILLS file is missing or unreadable" });
    }

    // Check MEMORY exists
    totalChecks++;
    try {
      await this.reader.read(SubstrateFileType.MEMORY);
      passedChecks++;
    } catch {
      inconsistencies.push({ message: "MEMORY file is missing or unreadable" });
    }

    const score = totalChecks > 0 ? passedChecks / totalChecks : 0;
    return { score, inconsistencies };
  }
}
