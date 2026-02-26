export type EndorsementVerdict = "PROCEED" | "NOTIFY" | "ESCALATE";

export interface ScreenerInput {
  action: string;
  context?: string;
}

export interface ScreenerResult {
  verdict: EndorsementVerdict;
  matchedSection?: string;
  timestamp: number;
}
