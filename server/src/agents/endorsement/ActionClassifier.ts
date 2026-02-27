import { ProcessLogEntry } from "../claude/ISessionLauncher";

export interface ActionClassification {
  isExternal: boolean;
  actionType: string;
  description: string;
}

const EXTERNAL_TOOL_PATTERNS: Array<{ pattern: RegExp; actionType: string }> = [
  { pattern: /(?:mcp__tinybus__)?send_message/i, actionType: "agora_send" },
  { pattern: /send.?email|email.?send/i, actionType: "email" },
  { pattern: /blog.?post|social.?media|publish.?post/i, actionType: "blog_post" },
];

export class ActionClassifier {
  classifyFromLogEntries(entries: ProcessLogEntry[]): ActionClassification | null {
    const toolUseEntries = entries.filter((e) => e.type === "tool_use");
    for (const entry of toolUseEntries) {
      for (const { pattern, actionType } of EXTERNAL_TOOL_PATTERNS) {
        if (pattern.test(entry.content)) {
          return {
            isExternal: true,
            actionType,
            description: `External action detected: ${actionType} via tool_use`,
          };
        }
      }
    }
    return null;
  }
}
