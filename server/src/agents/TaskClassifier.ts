import { AgentRole } from "./types";

export type TaskType = "strategic" | "tactical";

export interface TaskClassifierConfig {
  strategicModel: string;
  tacticalModel: string;
}

export interface OperationContext {
  role: AgentRole;
  operation: string;
}

/**
 * TaskClassifier determines which model to use for a given operation.
 * 
 * Strategic operations (Opus):
 * - Complex reasoning and decision-making
 * - Architectural decisions
 * - Novel problem-solving
 * - Deep code review and analysis
 * 
 * Tactical operations (Sonnet):
 * - File I/O operations
 * - Git operations
 * - Progress logging
 * - Routine updates
 * - Simple code edits
 * - Test execution
 */
export class TaskClassifier {
  constructor(private readonly config: TaskClassifierConfig) {}

  /**
   * Classify an operation as strategic or tactical based on agent role and operation type.
   */
  classify(context: OperationContext): TaskType {
    const { operation } = context;

    // Strategic operations that require deep reasoning
    const strategicOperations = [
      "decide",           // Ego's executive decision-making
      "respondToMessage", // Ego's context-aware conversation
      "generateDrives",   // Id's novel goal generation
      "audit",            // Superego's full substrate analysis
      "evaluateOutcome",  // Subconscious's complex reconsideration
    ];

    // Tactical operations that are more routine
    const tacticalOperations = [
      "execute",           // Subconscious task execution
      "evaluateProposals", // Superego's binary accept/reject
      "detectIdle",        // Id's deterministic status check
      "dispatchNext",      // Ego's task extraction
    ];

    if (strategicOperations.includes(operation)) {
      return "strategic";
    }

    if (tacticalOperations.includes(operation)) {
      return "tactical";
    }

    // Default to strategic for unknown operations (safer choice)
    return "strategic";
  }

  /**
   * Get the model name for a given operation.
   */
  getModel(context: OperationContext): string {
    const taskType = this.classify(context);
    return taskType === "strategic" 
      ? this.config.strategicModel 
      : this.config.tacticalModel;
  }

  /**
   * Get a human-readable explanation of why a particular model was selected.
   */
  getClassificationReason(context: OperationContext): string {
    const taskType = this.classify(context);
    const model = this.getModel(context);
    
    if (taskType === "strategic") {
      return `Using ${model} for strategic operation '${context.operation}' by ${context.role} (requires deep reasoning)`;
    } else {
      return `Using ${model} for tactical operation '${context.operation}' by ${context.role} (routine task)`;
    }
  }
}
