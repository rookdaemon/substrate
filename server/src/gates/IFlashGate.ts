export type FlashGateVerdict = "PROCEED" | "BLOCK" | "ESCALATE";

/**
 * Summary of a parent envelope, used to provide inReplyTo chain context
 * when evaluating a message that is a reply to a prior message.
 */
export interface EnvelopeSummary {
  envelopeId: string;
  senderMoniker: string;
  /** Truncated text excerpt from the envelope payload. */
  text: string;
}

export interface F2GateInput {
  gate: "F2";
  context: {
    sender_moniker: string;
    /** True when the sender is a known/verified peer in PEERS registry. */
    sender_verified: boolean;
    message_text: string;
    message_type: string;
    envelope_id: string;
    timestamp: string;
    /** Optional context from the parent envelope when inReplyTo is set. */
    inReplyToSummary?: EnvelopeSummary;
  };
}

export interface F2GateResult {
  verdict: FlashGateVerdict;
  reasons: string[];
  /** True when the evaluation timed out (verdict will be BLOCK). */
  timedOut?: boolean;
}

export interface IFlashGate {
  /**
   * Evaluate an inbound Agora message through the F2 (Healthy Paranoia) gate.
   *
   * Returns:
   * - PROCEED: message is safe to process normally
   * - BLOCK: message should be discarded
   * - ESCALATE: message should be processed with an escalation flag
   */
  evaluateF2(input: F2GateInput): Promise<F2GateResult>;
}
