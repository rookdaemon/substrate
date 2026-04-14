export enum TaskStatus {
  PENDING = "PENDING",
  COMPLETE = "COMPLETE",
  DEFERRED = "DEFERRED",
  BLOCKED = "BLOCKED",
}

export interface TriggerEvaluator {
  evaluate(trigger: string): Promise<boolean>;
}

export interface PlanTask {
  id: string;
  title: string;
  status: TaskStatus;
  children: PlanTask[];
  trigger?: string;
  correlationId?: string;
  blockedUntil?: Date;
  confidence?: number;
}

interface RawTaskLine {
  indent: number;
  checked: boolean;
  deferred: boolean;
  title: string;
  correlationId?: string;
  blockedUntil?: Date;
  confidence?: number;
}

export class PlanParser {
  static parseCurrentGoal(markdown: string): string {
    const match = markdown.match(/## Current Goal\s*\n([^\n#]*)/);
    if (!match) return "";
    return match[1].trim();
  }

  static parseTasks(markdown: string): PlanTask[] {
    const taskLines = this.extractTaskLines(markdown);
    if (taskLines.length === 0) return [];
    return this.buildTree(taskLines, null, 0, taskLines.length, -1);
  }

  static async findNextActionable(tasks: PlanTask[], evaluator?: TriggerEvaluator, now?: Date): Promise<PlanTask | null> {
    const candidates: PlanTask[] = [];
    await this.collectActionable(tasks, evaluator, now, candidates);
    if (candidates.length === 0) return null;
    candidates.sort((a, b) => (b.confidence ?? 0.5) - (a.confidence ?? 0.5));
    return candidates[0];
  }

  private static async collectActionable(
    tasks: PlanTask[],
    evaluator: TriggerEvaluator | undefined,
    now: Date | undefined,
    result: PlanTask[],
  ): Promise<void> {
    for (const task of tasks) {
      if (task.status === TaskStatus.COMPLETE) continue;
      if (task.status === TaskStatus.BLOCKED) continue;
      if (now && task.blockedUntil && now < task.blockedUntil) continue;
      if (task.status === TaskStatus.DEFERRED) {
        if (!evaluator || !task.trigger) continue;
        const triggered = await evaluator.evaluate(task.trigger);
        if (!triggered) continue;
      }
      if (task.children.length > 0) {
        await this.collectActionable(task.children, evaluator, now, result);
      } else {
        result.push(task);
      }
    }
  }

  static markComplete(markdown: string, taskId: string): string {
    const tasks = this.parseTasks(markdown);
    const task = this.findTaskById(tasks, taskId);
    if (!task) {
      throw new Error(`Task ${taskId} not found`);
    }
    if (task.status === TaskStatus.COMPLETE) return markdown;

    const taskLines = this.extractTaskLines(markdown);
    const flatTasks = this.flattenTasks(tasks);
    const taskIndex = flatTasks.findIndex((t) => t.id === taskId);
    if (taskIndex < 0 || taskIndex >= taskLines.length) {
      throw new Error(`Task ${taskId} not found`);
    }

    const lines = markdown.split("\n");
    const tasksSection = this.findTasksSectionStart(markdown);
    if (tasksSection < 0) {
      throw new Error(`Task ${taskId} not found`);
    }

    let taskLineCount = 0;
    for (let i = tasksSection; i < lines.length; i++) {
      if (/^\s*- \[[ x~]\] /.test(lines[i])) {
        if (taskLineCount === taskIndex) {
          lines[i] = lines[i].replace(/- \[[ ~]\] /, "- [x] ");
          break;
        }
        taskLineCount++;
      }
    }

    return lines.join("\n");
  }

  static isComplete(tasks: PlanTask[]): boolean {
    return tasks.every(
      (t) =>
        t.status === TaskStatus.COMPLETE &&
        (t.children.length === 0 || this.isComplete(t.children))
    );
  }

  static isEmpty(tasks: PlanTask[]): boolean {
    return tasks.length === 0;
  }

  static findBlockedTasks(tasks: PlanTask[]): PlanTask[] {
    const result: PlanTask[] = [];
    for (const task of tasks) {
      if (task.status === TaskStatus.BLOCKED) result.push(task);
      result.push(...this.findBlockedTasks(task.children));
    }
    return result;
  }

  static findTimeBlockedTasks(tasks: PlanTask[], now: Date): PlanTask[] {
    const result: PlanTask[] = [];
    for (const task of tasks) {
      if (task.blockedUntil && now < task.blockedUntil) result.push(task);
      result.push(...this.findTimeBlockedTasks(task.children, now));
    }
    return result;
  }

  private static extractTaskLines(markdown: string): RawTaskLine[] {
    const lines = markdown.split("\n");
    const tasksStart = this.findTasksSectionStart(markdown);
    if (tasksStart < 0) return [];

    const result: RawTaskLine[] = [];
    for (let i = tasksStart; i < lines.length; i++) {
      const line = lines[i];
      if (line.startsWith("#")) break;
      const match = line.match(/^(\s*)- \[([ x~])\] (.+)$/);
      if (match) {
        // Scan ahead through comment lines for embedded metadata
        let correlationId: string | undefined;
        let confidence: number | undefined;
        let commentIdx = i + 1;
        while (commentIdx < lines.length && /^\s*<!--.*-->\s*$/.test(lines[commentIdx])) {
          const corrMatch = lines[commentIdx].match(/<!--\s*correlationId:\s*(\S+)\s*-->/);
          if (corrMatch) correlationId = corrMatch[1];
          const confMatch = lines[commentIdx].match(/<!--\s*confidence:\s*([\d.]+)/);
          if (confMatch) confidence = parseFloat(confMatch[1]);
          commentIdx++;
        }
        // Parse inline blockedUntil annotation from the task line itself
        const blockedUntilMatch = match[3].match(/<!--\s*blockedUntil:\s*(\S+)\s*-->/);
        let blockedUntil: Date | undefined;
        if (blockedUntilMatch) {
          const parsed = new Date(blockedUntilMatch[1]);
          if (!isNaN(parsed.getTime())) blockedUntil = parsed;
        }
        result.push({
          indent: match[1].length,
          checked: match[2] === "x",
          deferred: match[2] === "~",
          title: match[3],
          ...(correlationId !== undefined ? { correlationId } : {}),
          ...(blockedUntil !== undefined ? { blockedUntil } : {}),
          ...(confidence !== undefined ? { confidence } : {}),
        });
      }
    }
    return result;
  }

  private static findTasksSectionStart(markdown: string): number {
    const lines = markdown.split("\n");
    let inTasks = false;
    for (let i = 0; i < lines.length; i++) {
      if (lines[i].match(/^## Tasks/)) {
        inTasks = true;
        continue;
      }
      if (inTasks && /^\s*- \[[ x~]\] /.test(lines[i])) {
        return i;
      }
      if (inTasks && lines[i].startsWith("#")) break;
    }
    return -1;
  }

  private static buildTree(
    lines: RawTaskLine[],
    parentId: string | null,
    start: number,
    end: number,
    parentIndent: number
  ): PlanTask[] {
    const tasks: PlanTask[] = [];
    let counter = 1;
    let i = start;

    while (i < end) {
      const line = lines[i];
      if (line.indent <= parentIndent) break;

      const isTopLevel =
        parentIndent < 0 ? this.isMinIndent(line, lines, start, end) : line.indent === parentIndent + 2;

      if (!isTopLevel) {
        i++;
        continue;
      }

      const id = parentId === null ? `task-${counter}` : `${parentId}.${counter}`;
      const childStart = i + 1;
      let childEnd = childStart;
      while (childEnd < end) {
        if (lines[childEnd].indent <= line.indent) break;
        childEnd++;
      }

      const children = this.buildTree(lines, id, childStart, childEnd, line.indent);

      const title = line.title;
      const triggerMatch = title.match(/WHEN\s+`([^`]+)`/);
      const trigger = triggerMatch ? triggerMatch[1] : undefined;
      const isBlocked = /\*\*BLOCKED\*\*|blocked-until:/i.test(title);

      tasks.push({
        id,
        title,
        status: line.checked
          ? TaskStatus.COMPLETE
          : line.deferred
            ? TaskStatus.DEFERRED
            : isBlocked
              ? TaskStatus.BLOCKED
              : TaskStatus.PENDING,
        children,
        ...(trigger !== undefined ? { trigger } : {}),
        ...(line.correlationId !== undefined ? { correlationId: line.correlationId } : {}),
        ...(line.blockedUntil !== undefined ? { blockedUntil: line.blockedUntil } : {}),
        ...(line.confidence !== undefined ? { confidence: line.confidence } : {}),
      });

      counter++;
      i = childEnd;
    }

    return tasks;
  }

  private static isMinIndent(
    line: RawTaskLine,
    lines: RawTaskLine[],
    start: number,
    end: number
  ): boolean {
    let minIndent = Infinity;
    for (let i = start; i < end; i++) {
      if (lines[i].indent < minIndent) minIndent = lines[i].indent;
    }
    return line.indent === minIndent;
  }

  private static findTaskById(
    tasks: PlanTask[],
    id: string
  ): PlanTask | null {
    for (const task of tasks) {
      if (task.id === id) return task;
      const found = this.findTaskById(task.children, id);
      if (found) return found;
    }
    return null;
  }

  /**
   * Append new task lines to an existing PLAN.md, preserving all content
   * outside the ## Tasks section. Does not modify any other section.
   */
  static appendTasksToExistingPlan(
    existing: string,
    newTaskLines: string[],
  ): string {
    if (existing.trim() === "") {
      return `# Plan\n\n## Tasks\n${newTaskLines.join("\n")}\n`;
    }

    const lines = existing.split("\n");

    // Find ## Tasks section
    const tasksHeaderIdx = lines.findIndex((l) => /^## Tasks\s*$/.test(l));

    if (tasksHeaderIdx === -1) {
      // No ## Tasks section — append one at the end
      return [...lines, "", "## Tasks", ...newTaskLines].join("\n");
    }

    // Find end of ## Tasks section (next heading or EOF)
    let tasksEndIdx = lines.length;
    for (let i = tasksHeaderIdx + 1; i < lines.length; i++) {
      if (/^## /.test(lines[i])) {
        tasksEndIdx = i;
        break;
      }
    }

    // Insert new tasks at the end of the ## Tasks section
    const before = lines.slice(0, tasksEndIdx);
    const after = lines.slice(tasksEndIdx);
    return [...before, ...newTaskLines, ...after].join("\n");
  }

  private static flattenTasks(tasks: PlanTask[]): PlanTask[] {
    const result: PlanTask[] = [];
    for (const task of tasks) {
      result.push(task);
      result.push(...this.flattenTasks(task.children));
    }
    return result;
  }
}
