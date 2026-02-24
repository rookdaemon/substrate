export enum TaskStatus {
  PENDING = "PENDING",
  COMPLETE = "COMPLETE",
  DEFERRED = "DEFERRED",
}

export interface PlanTask {
  id: string;
  title: string;
  status: TaskStatus;
  children: PlanTask[];
  triggerCondition?: string;
}

export interface TriggerEvaluator {
  evaluate(condition: string): boolean;
}

interface RawTaskLine {
  indent: number;
  checked: boolean;
  deferred: boolean;
  title: string;
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

  static findNextActionable(tasks: PlanTask[], evaluator?: TriggerEvaluator): PlanTask | null {
    for (const task of tasks) {
      if (task.status === TaskStatus.COMPLETE) continue;
      if (task.status === TaskStatus.DEFERRED) {
        if (!evaluator || !task.triggerCondition) continue;
        if (!evaluator.evaluate(task.triggerCondition)) continue;
      }
      if (task.children.length > 0) {
        const child = this.findNextActionable(task.children, evaluator);
        if (child) return child;
      } else {
        return task;
      }
    }
    return null;
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
        result.push({
          indent: match[1].length,
          checked: match[2] === "x",
          deferred: match[2] === "~",
          title: match[3],
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

      const triggerMatch = line.title.match(/WHEN\s+`([^`]+)`/);
      const triggerCondition = triggerMatch ? triggerMatch[1] : undefined;

      const status = line.checked
        ? TaskStatus.COMPLETE
        : line.deferred
          ? TaskStatus.DEFERRED
          : TaskStatus.PENDING;

      tasks.push({
        id,
        title: line.title,
        status,
        children,
        triggerCondition,
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

  private static flattenTasks(tasks: PlanTask[]): PlanTask[] {
    const result: PlanTask[] = [];
    for (const task of tasks) {
      result.push(task);
      result.push(...this.flattenTasks(task.children));
    }
    return result;
  }
}
