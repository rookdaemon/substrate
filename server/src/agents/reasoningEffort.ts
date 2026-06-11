export const REASONING_EFFORT_VALUES = ["minimal", "low", "medium", "high", "xhigh", "max"] as const;

export type ReasoningEffort = typeof REASONING_EFFORT_VALUES[number];
