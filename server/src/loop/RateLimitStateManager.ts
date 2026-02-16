import { IClock } from "../substrate/abstractions/IClock";
import { IFileSystem } from "../substrate/abstractions/IFileSystem";
import { SubstrateConfig } from "../substrate/config";
import { SubstrateFileType } from "../substrate/types";
import { FileLock } from "../substrate/io/FileLock";
import { AppendOnlyWriter } from "../substrate/io/AppendOnlyWriter";
import { SubstrateFileWriter } from "../substrate/io/FileWriter";
import { SubstrateFileReader } from "../substrate/io/FileReader";
import { PlanParser } from "../agents/parsers/PlanParser";
import { getTemplate } from "../substrate/templates";

/**
 * Manages state preservation when entering rate-limited hibernation.
 * Ensures the agent can resume seamlessly after rate limit reset.
 */
export class RateLimitStateManager {
  constructor(
    private readonly fs: IFileSystem,
    private readonly config: SubstrateConfig,
    private readonly lock: FileLock,
    private readonly clock: IClock,
    private readonly progressWriter: AppendOnlyWriter,
    private readonly fileWriter: SubstrateFileWriter,
    private readonly fileReader: SubstrateFileReader
  ) {}

  /**
   * Save state before entering rate-limited sleep.
   * 
   * @param rateLimitReset - The Date when the rate limit will reset
   * @param currentTaskId - The task that was being executed when rate limit hit (optional)
   */
  async saveStateBeforeSleep(
    rateLimitReset: Date,
    currentTaskId?: string
  ): Promise<void> {
    const now = this.clock.now();
    const resetTimestamp = rateLimitReset.toISOString();
    const sleepDurationMs = rateLimitReset.getTime() - now.getTime();
    const sleepDurationMinutes = Math.round(sleepDurationMs / 60000);

    // 1. Read current PLAN.md to get context
    const planContent = await this.fileReader.read(SubstrateFileType.PLAN);
    const currentGoal = PlanParser.parseCurrentGoal(planContent.rawMarkdown);
    
    // 2. Write restart-context.md with current state
    const restartContext = this.buildRestartContext(
      now,
      rateLimitReset,
      currentTaskId,
      currentGoal,
      planContent.rawMarkdown
    );
    
    await this.fileWriter.write(SubstrateFileType.RESTART_CONTEXT, restartContext);

    // 3. Update PLAN.md current goal with hibernation context
    const updatedPlan = this.updatePlanWithHibernationContext(
      planContent.rawMarkdown,
      currentTaskId,
      resetTimestamp
    );
    
    await this.fileWriter.write(SubstrateFileType.PLAN, updatedPlan);

    // 4. Log to PROGRESS.md
    const progressEntry = `[SYSTEM] Rate limit hibernation starting. Reset expected at ${resetTimestamp} (in ~${sleepDurationMinutes} minutes). State saved to restart-context.md.`;
    await this.progressWriter.append(SubstrateFileType.PROGRESS, progressEntry);
  }

  /**
   * Clear restart-context.md and restore it to neutral state.
   * Should be called after successful resumption from rate limit hibernation
   * to prevent double-application of hibernation state.
   */
  async clearRestartContext(): Promise<void> {
    const neutralState = getTemplate(SubstrateFileType.RESTART_CONTEXT);
    await this.fileWriter.write(SubstrateFileType.RESTART_CONTEXT, neutralState);
  }

  private buildRestartContext(
    hibernationStart: Date,
    rateLimitReset: Date,
    currentTaskId: string | undefined,
    currentGoal: string,
    fullPlanContent: string
  ): string {
    const taskSection = currentTaskId 
      ? `## Interrupted Task\n\nTask ID: ${currentTaskId}\n\n`
      : `## Interrupted Task\n\nNo specific task was in progress (idle or between tasks).\n\n`;

    return `# Restart Context

This file captures the agent's state when entering rate-limited hibernation at ${hibernationStart.toISOString()}.

## Hibernation Details

- **Hibernation Start**: ${hibernationStart.toISOString()}
- **Expected Reset**: ${rateLimitReset.toISOString()}
- **Duration**: ~${Math.round((rateLimitReset.getTime() - hibernationStart.getTime()) / 60000)} minutes

${taskSection}## Current Goal

${currentGoal}

## Full Plan Snapshot

\`\`\`markdown
${fullPlanContent}
\`\`\`

## Resumption Strategy

Upon waking:
1. Check restart-context.md for hibernation details
2. Review PLAN.md for any updates made before sleep
3. Continue with interrupted task (if any) or proceed with next task from PLAN.md
4. Clear restart-context.md after successful resumption
`;
  }

  private updatePlanWithHibernationContext(
    planContent: string,
    currentTaskId: string | undefined,
    resetTimestamp: string
  ): string {
    // Find the "## Current Goal" section and add hibernation context
    const goalMatch = planContent.match(/^## Current Goal\s*\n([\s\S]*?)(?=\n##|$)/m);
    
    if (!goalMatch) {
      // If no Current Goal section found, just prepend a note
      return `# Plan

## Current Goal

[RATE LIMITED - resuming at ${resetTimestamp}]

${planContent.replace(/^# Plan\s*\n/, '')}`;
    }

    const currentGoal = goalMatch[1].trim();
    const taskContext = currentTaskId ? ` Task "${currentTaskId}" was interrupted.` : '';
    const hibernationNote = `[RATE LIMITED - resuming at ${resetTimestamp}]${taskContext}\n\n`;
    
    const updatedGoal = hibernationNote + currentGoal;
    
    return planContent.replace(
      /^## Current Goal\s*\n[\s\S]*?(?=\n##|$)/m,
      `## Current Goal\n\n${updatedGoal}\n`
    );
  }
}
