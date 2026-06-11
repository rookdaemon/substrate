import { AgentRole } from "./types";
import { extractJson } from "./parsers/extractJson";
import { PromptBuilder, SubstrateSnapshot } from "./prompts/PromptBuilder";
import { ISessionLauncher, ProcessLogEntry } from "./claude/ISessionLauncher";
import { REASONING_EFFORT_VALUES, type ReasoningEffort } from "./reasoningEffort";
import type { ILogger } from "../logging";

export const ITERATION_MODEL_CLASSES = ["strategic", "everyday", "menial"] as const;
export type IterationModelClass = typeof ITERATION_MODEL_CLASSES[number];

export interface IterationModelClassConfig {
  model?: string;
  effort?: ReasoningEffort;
}

export interface IterationPlannerConfig {
  enabled: boolean;
  plannerModel?: string;
  plannerEffort?: ReasoningEffort;
  maxFanout?: number;
  modelClasses?: Partial<Record<IterationModelClass, IterationModelClassConfig>>;
}

export interface IterationDispatch {
  taskId: string;
  description: string;
}

export interface IterationAssignment {
  taskId: string;
  description: string;
  modelClass: IterationModelClass;
  model?: string;
  effort?: ReasoningEffort;
}

export interface IterationPlan {
  mode: "direct" | "fanout";
  reason: string;
  assignments: IterationAssignment[];
}

interface ParsedAssignment {
  id?: unknown;
  description?: unknown;
  modelClass?: unknown;
  effort?: unknown;
}

export const ITERATION_PLAN_SCHEMA = {
  type: "object",
  properties: {
    mode: { type: "string", enum: ["direct", "fanout"] },
    reason: { type: "string" },
    assignments: {
      type: "array",
      items: {
        type: "object",
        properties: {
          id: { type: "string" },
          description: { type: "string" },
          modelClass: { type: "string", enum: ITERATION_MODEL_CLASSES },
          effort: { type: "string", enum: REASONING_EFFORT_VALUES },
        },
        required: ["id", "description", "modelClass"],
      },
    },
  },
  required: ["mode", "reason", "assignments"],
} as const;

const DEFAULT_MAX_FANOUT = 3;

export class IterationPlanner {
  constructor(
    private readonly promptBuilder: PromptBuilder,
    private readonly sessionLauncher: ISessionLauncher,
    private readonly config: IterationPlannerConfig,
    private readonly logger: ILogger,
    private readonly workingDirectory?: string,
    private readonly sourceCodePath?: string,
  ) {}

  async plan(
    dispatch: IterationDispatch,
    onLogEntry?: (entry: ProcessLogEntry) => void,
    snapshot?: SubstrateSnapshot,
  ): Promise<IterationPlan> {
    if (!this.config.enabled) {
      return this.directPlan(dispatch, "dual-prompt planning disabled", "everyday");
    }

    try {
      const systemPrompt = this.promptBuilder.buildSystemPrompt(AgentRole.EGO);
      const eagerRefs = await this.promptBuilder.getEagerReferences(AgentRole.EGO, undefined, snapshot);
      const lazyRefs = this.promptBuilder.getLazyReferences(AgentRole.EGO);
      const instruction = this.buildInstruction(dispatch);
      const message = this.promptBuilder.buildAgentMessage(eagerRefs, lazyRefs, instruction);

      const result = await this.sessionLauncher.launch({
        systemPrompt,
        message,
      }, {
        model: this.config.plannerModel,
        effort: this.config.plannerEffort,
        onLogEntry,
        cwd: this.workingDirectory,
        continueSession: false,
        persistSession: false,
        outputSchema: ITERATION_PLAN_SCHEMA,
        usageContext: { role: AgentRole.EGO, operation: "planIteration" },
        ...(this.sourceCodePath ? { additionalDirs: [this.sourceCodePath] } : {}),
      });

      if (!result.success) {
        this.logger.warn(`iteration planner failed; falling back to direct execution: ${result.error ?? "unknown error"}`);
        return this.directPlan(dispatch, "planner session failed; direct fallback", "everyday");
      }

      return this.normalizePlan(dispatch, extractJson(result.rawOutput));
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.warn(`iteration planner errored; falling back to direct execution: ${message}`);
      return this.directPlan(dispatch, "planner error; direct fallback", "everyday");
    }
  }

  private buildInstruction(dispatch: IterationDispatch): string {
    const maxFanout = this.maxFanout();
    return `Plan how to execute the next PLAN.md task.

Task ID: ${dispatch.taskId}
Task description: ${dispatch.description}

Return ONLY a JSON object matching this shape:
{
  "mode": "direct" | "fanout",
  "reason": "brief reason",
  "assignments": [
    {
      "id": "short stable id",
      "description": "self-contained action for the worker",
      "modelClass": "strategic" | "everyday" | "menial",
      "effort": "minimal"
    }
  ]
}

Omit "effort" when the model class default is sufficient. When included, it must be one of: minimal, low, medium, high, xhigh, max.

Default to "direct". The normal worker can read files, edit code, run tests, and carry out several obvious steps in one session.

Use "menial" for trivial, routine, or deterministic work: tiny edits, formatting, simple docs/config updates, one obvious command, a direct test run, mechanical cleanup, or anything where the next action is already clear. For these tasks, return mode "direct" with one "menial" assignment and let the worker just do it.

Use "everyday" for normal coding or investigation that benefits from the standard worker model but does not need architectural reasoning.

Use "strategic" only for genuinely ambiguous design, security, data-loss risk, architecture, or high-stakes analysis.

Fan out only when the task contains independent workstreams that can be executed without waiting for each other's intermediate results. Each fanout assignment must be action-oriented, self-contained, and able to finish useful work on its own. Do not fan out merely because a task has multiple sequential steps. If you are uncertain, choose "direct".

Do not create a reconciling, summarizing, integrating, or reviewing assignment. There is no second LLM reconciliation pass here; the orchestrator deterministically combines worker results. If reconciliation is actually required, choose "direct" so one worker owns the full context.

Maximum fanout assignments: ${maxFanout}.`;
  }

  private normalizePlan(dispatch: IterationDispatch, parsed: Record<string, unknown>): IterationPlan {
    const mode = parsed.mode === "fanout" ? "fanout" : "direct";
    const reason = typeof parsed.reason === "string" && parsed.reason.trim()
      ? parsed.reason.trim()
      : mode === "fanout" ? "planner selected fanout" : "planner selected direct execution";

    const rawAssignments = Array.isArray(parsed.assignments) ? parsed.assignments as ParsedAssignment[] : [];
    const assignments = rawAssignments
      .map((assignment, index) => this.normalizeAssignment(dispatch, assignment, index))
      .filter((assignment): assignment is IterationAssignment => assignment !== null)
      .slice(0, this.maxFanout());

    if (mode === "fanout" && assignments.length > 1) {
      return { mode, reason, assignments };
    }

    const direct = assignments[0] ?? this.makeAssignment(
      dispatch.taskId,
      dispatch.description,
      this.inferDirectModelClass(parsed),
    );
    return {
      mode: "direct",
      reason: assignments.length > 1 ? "fanout collapsed to direct" : reason,
      assignments: [{
        ...direct,
        taskId: dispatch.taskId,
        description: direct.description || dispatch.description,
      }],
    };
  }

  private normalizeAssignment(
    dispatch: IterationDispatch,
    assignment: ParsedAssignment,
    index: number,
  ): IterationAssignment | null {
    const description = typeof assignment.description === "string" ? assignment.description.trim() : "";
    if (!description) return null;

    const id = typeof assignment.id === "string" && assignment.id.trim()
      ? assignment.id.trim()
      : `${dispatch.taskId}.${index + 1}`;

    const modelClass = this.isModelClass(assignment.modelClass) ? assignment.modelClass : "everyday";
    const effort = this.isReasoningEffort(assignment.effort) ? assignment.effort : undefined;
    return this.makeAssignment(id, description, modelClass, effort);
  }

  private makeAssignment(
    taskId: string,
    description: string,
    modelClass: IterationModelClass,
    effort?: ReasoningEffort,
  ): IterationAssignment {
    const classConfig = this.config.modelClasses?.[modelClass];
    const resolvedEffort = effort ?? classConfig?.effort;
    return {
      taskId,
      description,
      modelClass,
      ...(classConfig?.model ? { model: classConfig.model } : {}),
      ...(resolvedEffort ? { effort: resolvedEffort } : {}),
    };
  }

  private directPlan(
    dispatch: IterationDispatch,
    reason: string,
    modelClass: IterationModelClass,
  ): IterationPlan {
    return {
      mode: "direct",
      reason,
      assignments: [this.makeAssignment(dispatch.taskId, dispatch.description, modelClass)],
    };
  }

  private inferDirectModelClass(parsed: Record<string, unknown>): IterationModelClass {
    const assignments = Array.isArray(parsed.assignments) ? parsed.assignments as ParsedAssignment[] : [];
    const first = assignments[0];
    return first && this.isModelClass(first.modelClass) ? first.modelClass : "everyday";
  }

  private maxFanout(): number {
    return Math.max(1, Math.min(this.config.maxFanout ?? DEFAULT_MAX_FANOUT, 8));
  }

  private isModelClass(value: unknown): value is IterationModelClass {
    return typeof value === "string" && (ITERATION_MODEL_CLASSES as readonly string[]).includes(value);
  }

  private isReasoningEffort(value: unknown): value is ReasoningEffort {
    return typeof value === "string" && (REASONING_EFFORT_VALUES as readonly string[]).includes(value);
  }
}
