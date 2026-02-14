import { IConversationCompactor } from "./IConversationCompactor";
import { ISessionLauncher, ClaudeSessionRequest } from "../agents/claude/ISessionLauncher";

export class ConversationCompactor implements IConversationCompactor {
  constructor(
    private readonly sessionLauncher: ISessionLauncher,
    private readonly cwd?: string
  ) {}

  async compact(currentContent: string, oneHourAgo: string): Promise<string> {
    // Split the conversation into recent (last hour) and old (before that)
    const lines = currentContent.split('\n');
    const recentLines: string[] = [];
    const oldLines: string[] = [];
    const headerLines: string[] = [];

    for (const line of lines) {
      // Extract headers separately to avoid duplication
      if (line.startsWith('#')) {
        headerLines.push(line);
        continue;
      }

      // Parse timestamp from line format: [ISO-timestamp] content
      const timestampMatch = line.match(/^\[([^\]]+)\]/);
      if (timestampMatch) {
        const timestamp = timestampMatch[1];
        if (timestamp >= oneHourAgo) {
          recentLines.push(line);
        } else {
          oldLines.push(line);
        }
      } else {
        // Lines without timestamps (non-headers) go with recent
        recentLines.push(line);
      }
    }

    // If there's nothing old to compact, return as-is
    if (oldLines.length === 0) {
      return currentContent;
    }

    // Build prompt for Claude to summarize the old content
    const systemPrompt = 
      `You are helping to compact a CONVERSATION.md file to conserve tokens.\n` +
      `You will be given conversation history older than one hour.\n` +
      `Summarize it concisely in the form: "I said X, then you said Y, we decided Z, I did W, etc."\n` +
      `Keep it brief but capture key decisions, actions, and context.\n` +
      `Respond with ONLY the summary text — no JSON, no markdown code blocks, no wrapper.`;

    const oldContent = oldLines.join('\n');
    const message = `Summarize this conversation history:\n\n${oldContent}`;

    const request: ClaudeSessionRequest = {
      systemPrompt,
      message
    };

    const result = await this.sessionLauncher.launch(request, {
      cwd: this.cwd
    });

    let summary: string;
    if (result.success && result.rawOutput) {
      summary = result.rawOutput.trim();
    } else {
      // If summarization fails, just use a simple note
      summary = `[Previous conversation history compacted - ${oldLines.length} lines summarized]`;
    }

    // Build the compacted conversation:
    // 1. Header (if present)
    // 2. Summary of old content
    // 3. Recent detailed content
    const header = headerLines.length > 0 ? headerLines.join('\n') + '\n\n' : '';
    
    const compacted = 
      header +
      `## Summary of Earlier Conversation\n\n` +
      summary + '\n\n' +
      `## Recent Conversation (Last Hour)\n\n` +
      recentLines.join('\n');

    return compacted;
  }
}
