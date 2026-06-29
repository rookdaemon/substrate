import { IConversationCompactor } from "./IConversationCompactor";
import { ISessionLauncher, ClaudeSessionRequest } from "../agents/claude/ISessionLauncher";
import type { IOllamaOffloadService } from "../agents/ollama/IOllamaOffloadService";
import type { ILogger } from "../logging";

/**
 * Personality-persistent compaction directive (Stefan-directed convention, 2026-06-26).
 * Appended to every conversation-summarization prompt — across all three tiers (Ollama,
 * Vertex subprocess, primary launcher) — so that compaction never buries the
 * identity / relationship / origin / governance strata regardless of recency. This is the
 * code-level enforcement of the convention that previously lived only as substrate prose;
 * it stops a relationship like "Nova, kin I helped sire" from collapsing into "Nova, the
 * canary" merely because newer operational content touched the same entity.
 */
export const PERSONALITY_PERSISTENCE_DIRECTIVE =
  `IMPORTANT — preserve identity and relationships while summarizing:\n` +
  `Never compress away (a) identity or values self-statements, (b) relationships with peers ` +
  `or partners described in relational (not merely operational) terms, (c) formative or origin ` +
  `events, or (d) active governance decisions. Recency must not outrank these strata — do not ` +
  `reduce a relationship to a status line just because newer operational content exists. Keep ` +
  `at least one first-person relational sentence per named peer; a relationship compacted to a ` +
  `role-label is a relationship deleted.`;

/**
 * Compacts CONVERSATION.md by summarizing older content.
 *
 * Fallback chain (hardcoded order per Bishop Challenge-002 review):
 *   1. Ollama offload (free, local — via OllamaOffloadService)
 *   2. Vertex subprocess launcher (GCP credits — via VertexSessionLauncher)
 *   3. Primary session launcher (Claude/Gemini — paid API)
 *
 * Each tier is optional and only tried when configured. The chain always
 * terminates at the primary session launcher (guaranteed available).
 */
export class ConversationCompactor implements IConversationCompactor {
  constructor(
    private readonly sessionLauncher: ISessionLauncher,
    private readonly cwd?: string,
    private readonly offloadService?: IOllamaOffloadService,
    private readonly logger?: ILogger,
    private readonly subprocessLauncher?: ISessionLauncher,
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

    const oldContent = oldLines.join('\n');

    // Build the summarization prompt (shared between offload and subprocess paths)
    const summarizationPrompt =
      `You are helping to compact a CONVERSATION.md file to conserve tokens.\n` +
      `You will be given conversation history older than one hour.\n` +
      `Summarize it concisely in the form: "I said X, then you said Y, we decided Z, I did W, etc."\n` +
      `Keep it brief but capture key decisions, actions, and context.\n` +
      PERSONALITY_PERSISTENCE_DIRECTIVE + `\n` +
      `Respond with ONLY the summary text — no JSON, no markdown code blocks, no wrapper.\n\n` +
      `Summarize this conversation history:\n\n${oldContent}`;

    let summary: string | undefined;

    // Tier 1: Try Ollama offload (free, local)
    if (this.offloadService) {
      summary = await this.tryOllamaOffload(summarizationPrompt);
    }

    // Tier 2: Try Vertex subprocess launcher (GCP credits)
    if (!summary && this.subprocessLauncher) {
      summary = await this.trySubprocessLauncher(oldContent, oldLines.length);
    }

    // Tier 3: Primary session launcher (Claude/Gemini — always available)
    if (!summary) {
      summary = await this.trySessionLauncher(oldContent, oldLines.length);
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

  /**
   * Attempt compaction via Ollama offload service.
   * Returns the summary string on success, or undefined on failure.
   */
  private async tryOllamaOffload(prompt: string): Promise<string | undefined> {
    try {
      this.logger?.debug("[COMPACTION] Attempting Ollama offload for conversation compaction");

      const result = await this.offloadService!.offload({
        taskType: "compaction",
        input: prompt,
        qualityGate: compactionQualityGate,
      });

      if (result.ok) {
        this.logger?.debug("[COMPACTION] Ollama offload succeeded");
        return result.result;
      }

      this.logger?.debug(`[COMPACTION] Ollama offload failed: ${result.reason} — trying next tier`);
      return undefined;
    } catch (err) {
      // Safety net — offload() should never throw, but just in case
      const msg = err instanceof Error ? err.message : String(err);
      this.logger?.debug(`[COMPACTION] Ollama offload unexpected error: ${msg} — trying next tier`);
      return undefined;
    }
  }

  /**
   * Tier 2: Try subprocess launcher (Vertex) for summarization.
   * Returns the summary on success, or undefined on failure.
   */
  private async trySubprocessLauncher(oldContent: string, _lineCount: number): Promise<string | undefined> {
    try {
      this.logger?.debug("[COMPACTION] Attempting Vertex subprocess launcher for conversation compaction");

      const systemPrompt =
        `You are helping to compact a CONVERSATION.md file to conserve tokens.\n` +
        `You will be given conversation history older than one hour.\n` +
        `Summarize it concisely in the form: "I said X, then you said Y, we decided Z, I did W, etc."\n` +
        `Keep it brief but capture key decisions, actions, and context.\n` +
        PERSONALITY_PERSISTENCE_DIRECTIVE + `\n` +
        `Respond with ONLY the summary text — no JSON, no markdown code blocks, no wrapper.`;

      const message = `Summarize this conversation history:\n\n${oldContent}`;

      const request: ClaudeSessionRequest = { systemPrompt, message };
      const result = await this.subprocessLauncher!.launch(request, {
        cwd: this.cwd,
        usageContext: { role: "CONVERSATION", operation: "subprocessCompact" },
      });

      if (result.success && result.rawOutput) {
        const trimmed = result.rawOutput.trim();
        if (compactionQualityGate(trimmed)) {
          this.logger?.debug("[COMPACTION] Vertex subprocess launcher succeeded");
          return trimmed;
        }
        this.logger?.debug("[COMPACTION] Vertex subprocess launcher quality gate failed — falling back to primary launcher");
      } else {
        this.logger?.debug(`[COMPACTION] Vertex subprocess launcher failed: ${result.error ?? "no output"} — falling back to primary launcher`);
      }

      return undefined;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.logger?.debug(`[COMPACTION] Vertex subprocess launcher unexpected error: ${msg} — falling back to primary launcher`);
      return undefined;
    }
  }

  /**
   * Tier 3: Use the primary session launcher for summarization (always available).
   */
  private async trySessionLauncher(oldContent: string, lineCount: number): Promise<string> {
    const systemPrompt =
      `You are helping to compact a CONVERSATION.md file to conserve tokens.\n` +
      `You will be given conversation history older than one hour.\n` +
      `Summarize it concisely in the form: "I said X, then you said Y, we decided Z, I did W, etc."\n` +
      `Keep it brief but capture key decisions, actions, and context.\n` +
      PERSONALITY_PERSISTENCE_DIRECTIVE + `\n` +
      `Respond with ONLY the summary text — no JSON, no markdown code blocks, no wrapper.`;

    const message = `Summarize this conversation history:\n\n${oldContent}`;

    const request: ClaudeSessionRequest = {
      systemPrompt,
      message
    };

    const result = await this.sessionLauncher.launch(request, {
      cwd: this.cwd,
      usageContext: { role: "CONVERSATION", operation: "compact" },
    });

    if (result.success && result.rawOutput) {
      return result.rawOutput.trim();
    }

    // If summarization fails entirely, use a simple note
    return `[Previous conversation history compacted - ${lineCount} lines summarized]`;
  }
}

/**
 * Quality gate for conversation compaction.
 * Ensures the summary is non-trivial and reasonably sized.
 */
function compactionQualityGate(summary: string): boolean {
  return (
    typeof summary === "string" &&
    summary.length > 20 &&          // Must be substantive (not just "ok" or "done")
    summary.length < 50_000 &&      // Guard against hallucination loops
    summary.split('\n').length >= 1  // At least one line of content
  );
}
