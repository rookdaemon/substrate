import { IClock } from "../substrate/abstractions/IClock";
import { IFileSystem } from "../substrate/abstractions/IFileSystem";
import { SubstrateConfig } from "../substrate/config";
import { SubstrateFileType } from "../substrate/types";
import { FileLock } from "../substrate/io/FileLock";
import { AppendOnlyWriter } from "../substrate/io/AppendOnlyWriter";
import { SubstrateFileWriter } from "../substrate/io/FileWriter";
import { SubstrateFileReader } from "../substrate/io/FileReader";
import { PlanParser } from "../agents/parsers/PlanParser";

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

    // 2. Update PLAN.md with hibernation context and a pending [restart] task
    const updatedPlan = this.updatePlanWithHibernationContext(
      planContent.rawMarkdown,
      currentTaskId,
      resetTimestamp
    );
    
    await this.fileWriter.write(SubstrateFileType.PLAN, updatedPlan);

    // 3. Log to PROGRESS.md
    const progressEntry = `[SYSTEM] Rate limit hibernation starting. Reset expected at ${resetTimestamp} (in ~${sleepDurationMinutes} minutes).`;
    await this.progressWriter.append(SubstrateFileType.PROGRESS, progressEntry);
  }

  private updatePlanWithHibernationContext(
    planContent: string,
    currentTaskId: string | undefined,
    resetTimestamp: string
  ): string {
    const taskContext = currentTaskId ? ` Task "${currentTaskId}" was interrupted.` : '';
    const restartTask = `- [ ] [restart] Resume from rate-limit hibernation (resuming at ${resetTimestamp})${taskContext}`;

    // Find the "## Current Goal" section and add hibernation context
    const goalMatch = planContent.match(/^## Current Goal\s*\n([\s\S]*?)(?=\n##|$)/m);

    if (!goalMatch) {
      // If no Current Goal section found, just prepend a note and a restart task
      return `# Plan

## Current Goal

[RATE LIMITED - resuming at ${resetTimestamp}]

## Tasks

${restartTask}

${planContent.replace(/^# Plan\s*\n/, '')}`;
    }

    const currentGoal = goalMatch[1].trim();
    const hibernationNote = `[RATE LIMITED - resuming at ${resetTimestamp}]${taskContext}\n\n`;
    const updatedGoal = hibernationNote + currentGoal;

    // Insert the restart task into the Tasks section, or append one if absent
    let updated = planContent.replace(
      /^## Current Goal\s*\n[\s\S]*?(?=\n##|$)/m,
      `## Current Goal\n\n${updatedGoal}\n`
    );

    const tasksMatch = updated.match(/^## Tasks\s*\n/m);
    if (tasksMatch) {
      updated = updated.replace(
        /^## Tasks\s*\n/m,
        `## Tasks\n\n${restartTask}\n`
      );
    } else {
      updated = updated.trimEnd() + `\n\n## Tasks\n\n${restartTask}\n`;
    }

    return updated;
  }
}
