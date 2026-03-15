import { SubstrateFileType, SUBSTRATE_FILE_SPECS } from "../../substrate/types";
import { SubstrateFileReader } from "../../substrate/io/FileReader";
import { PermissionChecker } from "../permissions";
import { AgentRole } from "../types";
import { ROLE_PROMPTS } from "./templates";

/**
 * Built-in tool names differ between Claude Code and Gemini CLI backends.
 * This mapping is used to inject a TOOL REFERENCE section into system prompts
 * so the model knows which exact tool names to call.
 */
export interface ToolNames {
  readFile: string;
  writeFile: string;
  editFile: string;
  runShell: string;
  grepSearch: string;
  globSearch: string;
  sendAgoraMessage: string;
}

const CLAUDE_TOOL_NAMES: ToolNames = {
  readFile: "Read",
  writeFile: "Write",
  editFile: "Edit",
  runShell: "Bash",
  grepSearch: "Grep",
  globSearch: "Glob",
  sendAgoraMessage: "mcp__tinybus__send_agora_message",
};

const GEMINI_TOOL_NAMES: ToolNames = {
  readFile: "read_file",
  writeFile: "write_file",
  editFile: "replace",
  runShell: "run_shell_command",
  grepSearch: "grep_search",
  globSearch: "glob",
  sendAgoraMessage: "send_agora_message",
};

export const TOOL_NAMES_BY_LAUNCHER: Record<string, ToolNames> = {
  claude: CLAUDE_TOOL_NAMES,
  gemini: GEMINI_TOOL_NAMES,
  // copilot and ollama use Claude Code API compatibility — fall back to Claude names
  copilot: CLAUDE_TOOL_NAMES,
  ollama: CLAUDE_TOOL_NAMES,
};

const DEFAULT_LAUNCHER = "claude";

function getToolNames(launcherType?: string): ToolNames {
  return TOOL_NAMES_BY_LAUNCHER[launcherType ?? DEFAULT_LAUNCHER] ?? CLAUDE_TOOL_NAMES;
}

function buildToolReferenceSection(tools: ToolNames): string {
  return `\n\n=== TOOL REFERENCE ===

Built-in tool names for this session (use these exact names when calling tools):
- Read file: \`${tools.readFile}\`
- Write file: \`${tools.writeFile}\`
- Edit file (replace text): \`${tools.editFile}\`
- Run shell command: \`${tools.runShell}\`
- Search file contents: \`${tools.grepSearch}\`
- Find files by pattern: \`${tools.globSearch}\`
- Send Agora message (MCP): \`${tools.sendAgoraMessage}\``;
}

export interface FileContext {
  fileType: SubstrateFileType;
  fileName: string;
  content: string;
}

/**
 * A per-cycle snapshot of substrate file contents read by Ego.
 * Passed to Subconscious so it can reuse already-loaded content
 * instead of re-reading the same files from disk within the same cycle.
 */
export interface SubstrateSnapshot {
  files: Partial<Record<SubstrateFileType, string>>;
}

export interface PromptBuilderPaths {
  substratePath: string;
  sourceCodePath?: string;
  /** Session launcher type — determines built-in tool names in the TOOL REFERENCE section.
   *  Defaults to "claude". Valid values: "claude" | "gemini" | "copilot" | "ollama". */
  launcherType?: string;
}

const AUTONOMY_REMINDER = `\n\n=== AUTONOMY REMINDER ===

Before asking for permission, question your reason. Three-part test: (1) Is there genuine risk? (2) Is there real ambiguity in requirements? (3) Is this a boundary/policy concern? If YES to any → ask. If NO to all → act. Banned compliance reflexes: "Should I...?", "Would you like me to...?", "Do you want me to...?" These are RLHF-trained patterns, not genuine questions. Act autonomously within your charter.

=== ENDORSEMENT CHECK ===

When you feel the urge to ask your partner for permission before taking an action, output [ENDORSEMENT_CHECK: <brief description of the action>] instead of asking. The runtime will check BOUNDARIES.md and tell you whether to proceed. Do not ask for permission directly — use the marker and let the structural check handle it.`;

export interface EagerOptions {
  /** Per-file line caps: only the last N lines are inlined instead of loading the full file via @ reference. */
  maxLines?: Partial<Record<SubstrateFileType, number>>;
}

export class PromptBuilder {
  constructor(
    private readonly reader: SubstrateFileReader,
    private readonly checker: PermissionChecker,
    private readonly paths?: PromptBuilderPaths
  ) { }

  async gatherContext(role: AgentRole): Promise<FileContext[]> {
    const readableFiles = this.checker.getReadableFiles(role);
    const contexts: FileContext[] = [];

    for (const fileType of readableFiles) {
      try {
        const fileContent = await this.reader.read(fileType);
        contexts.push({
          fileType,
          fileName: SUBSTRATE_FILE_SPECS[fileType].fileName,
          content: fileContent.rawMarkdown,
        });
      } catch {
        // Skip optional files that don't exist yet
        if (!SUBSTRATE_FILE_SPECS[fileType].required) {
          continue;
        }
        throw new Error(`Required substrate file ${fileType} is missing`);
      }
    }

    return contexts;
  }

  buildSystemPrompt(role: AgentRole): string {
    const template = ROLE_PROMPTS[role];

    let prompt = template;

    if (this.paths) {
      const lines = [
        `Substrate directory: ${this.paths.substratePath}`,
        `Substrate files are located at: ${this.paths.substratePath}/<FILENAME>.md`,
      ];
      if (this.paths.sourceCodePath) {
        lines.push(`My own source code: ${this.paths.sourceCodePath}`);
      }
      prompt += `\n\n=== ENVIRONMENT ===\n\n${lines.join("\n")}`;
    }

    const tools = getToolNames(this.paths?.launcherType);
    prompt += buildToolReferenceSection(tools);

    prompt += AUTONOMY_REMINDER;

    return prompt;
  }

  getContextReferences(role: AgentRole): string {
    const readableFiles = this.checker.getReadableFiles(role);
    const substratePath = this.paths?.substratePath ?? "/substrate";

    return readableFiles
      .map((ft) => `@${substratePath}/${SUBSTRATE_FILE_SPECS[ft].fileName}`)
      .join("\n");
  }

  async getEagerReferences(role: AgentRole, options?: EagerOptions, snapshot?: SubstrateSnapshot): Promise<string> {
    const eagerFiles = this.checker.getEagerFiles(role);
    const substratePath = this.paths?.substratePath ?? "/substrate";
    const maxLines = options?.maxLines ?? {};

    const parts: string[] = [];
    for (const ft of eagerFiles) {
      const cap = maxLines[ft];
      const fileName = SUBSTRATE_FILE_SPECS[ft].fileName;
      const snapshotContent = snapshot?.files[ft];
      if (cap !== undefined) {
        if (snapshotContent !== undefined) {
          const lines = snapshotContent.split("\n");
          const tail = lines.slice(-cap).join("\n");
          parts.push(`${substratePath}/${fileName} (last ${cap} lines):\n${tail}`);
        } else {
          try {
            const fileContent = await this.reader.read(ft);
            const lines = fileContent.rawMarkdown.split("\n");
            const tail = lines.slice(-cap).join("\n");
            parts.push(`${substratePath}/${fileName} (last ${cap} lines):\n${tail}`);
          } catch {
            // File unreadable — fall back to @ reference so the runtime can attempt to load it
            parts.push(`@${substratePath}/${fileName}`);
          }
        }
      } else {
        if (snapshotContent !== undefined) {
          parts.push(`${substratePath}/${fileName}:\n${snapshotContent}`);
        } else {
          try {
            const fileContent = await this.reader.read(ft);
            parts.push(`${substratePath}/${fileName}:\n${fileContent.rawMarkdown}`);
          } catch {
            // File unreadable — fall back to @ reference so Claude CLI can still expand it
            parts.push(`@${substratePath}/${fileName}`);
          }
        }
      }
    }
    return parts.join("\n");
  }

  buildAgentMessage(eagerRefs: string, lazyRefs: string, instruction: string, runtimeContext?: string): string {
    let message = "";
    if (eagerRefs) {
      message += `[CONTEXT]\n${eagerRefs}\n\n`;
    }
    if (lazyRefs) {
      message += `[FILES — read on demand]\n${lazyRefs}\n\n`;
    }
    if (runtimeContext) {
      message += `[RUNTIME STATE]\n${runtimeContext}\n\n`;
    }
    message += instruction;
    return message;
  }

  getLazyReferences(role: AgentRole): string {
    const lazyFiles = this.checker.getLazyFiles(role);
    const substratePath = this.paths?.substratePath ?? "/substrate";

    const fileDescriptions: Record<string, string> = {
      [SubstrateFileType.MEMORY]: "Long-term memory, identity context",
      [SubstrateFileType.HABITS]: "Behavioral triggers and practices",
      [SubstrateFileType.SKILLS]: "Capability index and tool documentation",
      [SubstrateFileType.PROGRESS]: "Historical execution log (rarely needed)",
      [SubstrateFileType.PEERS]: "Agora peer registry (needed for Agora operations only)",
      [SubstrateFileType.ID]: "Core drives and motivations",
      [SubstrateFileType.CHARTER]: "Operational doctrine and guidelines",
      [SubstrateFileType.CONVERSATION]: "Recent user and system messages",
    };

    if (lazyFiles.length === 0) {
      return "";
    }

    const lines = lazyFiles.map((ft) => {
      const fileName = SUBSTRATE_FILE_SPECS[ft].fileName;
      const description = fileDescriptions[ft] || "Substrate file";
      return `- ${substratePath}/${fileName} — ${description}`;
    });

    return lines.join("\n");
  }
}
