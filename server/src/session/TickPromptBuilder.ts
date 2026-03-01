import { SubstrateFileReader } from "../substrate/io/FileReader";
import { SubstrateFileType, SUBSTRATE_FILE_SPECS } from "../substrate/types";

export interface TickPromptConfig {
  substratePath: string;
  sourceCodePath?: string;
}

export class TickPromptBuilder {
  constructor(
    private readonly reader: SubstrateFileReader,
    private readonly config: TickPromptConfig,
  ) {}

  async buildSystemPrompt(): Promise<string> {
    const fileContents = await this.readAllSubstrateFiles();
    const sections: string[] = [];

    sections.push(
      `You are an autonomous AI agent. Your persistent state is stored in substrate files at ${this.config.substratePath}/.`,
    );

    if (this.config.sourceCodePath) {
      sections.push(
        `Your source code project is located at ${this.config.sourceCodePath}.`,
      );
    }

    sections.push("");
    sections.push("=== CURRENT STATE ===");

    for (const [fileType, content] of fileContents) {
      const spec = SUBSTRATE_FILE_SPECS[fileType];
      sections.push(`--- ${spec.fileName} ---`);
      sections.push(content);
      sections.push("");
    }

    sections.push("=== WORKFLOW ===");
    sections.push("1. Read PLAN.md, execute pending tasks (- [ ] items)");
    sections.push("2. Mark tasks complete (- [x]) in PLAN.md when done");
    sections.push("3. Append timestamped entries to PROGRESS.md");
    sections.push("4. If you receive a user message, handle it and log to CONVERSATION.md");

    sections.push("");
    sections.push("=== PERSISTENCE (CRITICAL) ===");
    sections.push("Before finishing, you MUST update:");
    sections.push("- PLAN.md: mark completed tasks, add new tasks if needed");
    sections.push("- PROGRESS.md: append summary of what you did");
    sections.push("- MEMORY.md: update with important learnings");

    sections.push("");
    sections.push("=== GOVERNANCE ===");
    sections.push("Follow the rules in VALUES.md, SECURITY.md, CHARTER.md, and SUPEREGO.md.");

    sections.push("");
    sections.push("=== AUTONOMY REMINDER ===");
    sections.push("Before asking for permission, question your reason. Three-part test: (1) Is there genuine risk? (2) Is there real ambiguity in requirements? (3) Is this a boundary/policy concern? If YES to any → ask. If NO to all → act. Banned compliance reflexes: \"Should I...?\", \"Would you like me to...?\", \"Do you want me to...?\" These are RLHF-trained patterns, not genuine questions. Act autonomously within your charter.");

    return sections.join("\n");
  }

  async buildInitialPrompt(): Promise<string> {
    return "Review PLAN.md and begin working on pending tasks. If none, reflect and update your plan.";
  }

  /**
   * OPTIMIZATION: Read all substrate files in parallel instead of sequentially.
   * Reduces file I/O latency from ~500ms (sequential) to ~100-200ms (parallel).
   */
  private async readAllSubstrateFiles(): Promise<[SubstrateFileType, string][]> {
    const fileTypes = Object.values(SubstrateFileType);
    
    // Read all files in parallel using Promise.all
    const readPromises = fileTypes.map(async (fileType) => {
      try {
        const content = await this.reader.read(fileType);
        return [fileType, content.rawMarkdown] as [SubstrateFileType, string];
      } catch {
        return [fileType, "(file not found)"] as [SubstrateFileType, string];
      }
    });

    return await Promise.all(readPromises);
  }
}
