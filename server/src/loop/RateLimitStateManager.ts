import { IClock } from "../substrate/abstractions/IClock";
import { IFileSystem } from "../substrate/abstractions/IFileSystem";
import { SubstrateConfig } from "../substrate/config";
import { SubstrateFileType } from "../substrate/types";
import { FileLock } from "../substrate/io/FileLock";
import { AppendOnlyWriter } from "../substrate/io/AppendOnlyWriter";
import { SubstrateFileWriter } from "../substrate/io/FileWriter";
import { SubstrateFileReader } from "../substrate/io/FileReader";
import { PlanParser, TaskStatus } from "../agents/parsers/PlanParser";

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
    const taskContext = this.getInterruptionTaskContext(planContent, currentTaskId);
    const restartTask = `- [ ] [restart] Resume from rate-limit hibernation (resuming at ${resetTimestamp})${taskContext}`;

    // Find the "## Current Goal" section and add hibernation context
    const goalMatch = planContent.match(/^## Current Goal\s*\n([\s\S]*?)(?=\n##|$)/m);

    let planBase: string;
    if (!goalMatch) {
      // No Current Goal section — add a minimal one with the rate-limited note
      const rateNote = `[RATE LIMITED - resuming at ${resetTimestamp}]${taskContext}`;
      planBase = planContent.replace(
        /^(# Plan[^\n]*\n)/m,
        `$1\n## Current Goal\n\n${rateNote}\n\n`
      );
    } else {
      const currentGoal = goalMatch[1].trim();
      const hibernationNote = `[RATE LIMITED - resuming at ${resetTimestamp}]${taskContext}\n\n`;
      const updatedGoal = hibernationNote + currentGoal;

      planBase = planContent.replace(
        /^## Current Goal\s*\n[\s\S]*?(?=\n##|$)/m,
        `## Current Goal\n\n${updatedGoal}\n`
      );
    }

    // Use PlanParser for consistent task injection into the ## Tasks section
    return PlanParser.appendTasksToExistingPlan(planBase, [restartTask]);
  }

  private getInterruptionTaskContext(planContent: string, currentTaskId: string | undefined): string {
    if (!currentTaskId) return "";

    const tasks = PlanParser.parseTasks(planContent);
    if (this.isTaskComplete(tasks, currentTaskId)) {
      return "";
    }

    return ` Task "${currentTaskId}" was interrupted.`;
  }

  private isTaskComplete(tasks: ReturnType<typeof PlanParser.parseTasks>, taskId: string): boolean {
    for (const task of tasks) {
      if (task.id === taskId) {
        return task.status === TaskStatus.COMPLETE;
      }
      if (task.children.length > 0 && this.isTaskComplete(task.children, taskId)) {
        return true;
      }
    }
    // If the task is not present in PLAN.md, treat it as interrupted to preserve prior behavior.
    return false;
  }
}
