export interface FlashGateReason {
  id: number;
  reason: string;
  is_blocker: boolean;
  explanation: string;
}

export interface FlashGateVerdict {
  verdict: "PROCEED" | "BLOCK" | "ESCALATE";
  reasons: FlashGateReason[];
  auto_block?: boolean;
  auto_block_reason?: string;
}

export interface F2Context {
  sender_moniker: string;
  sender_verified: boolean;
  message_text: string;
  message_type: string;
  envelope_id: string;
  timestamp: string;
}

export interface F1Context {
  proposed_action: {
    type: string;
    content_summary: string;
    target: string;
    reversible: boolean;
  };
  triggering_request: string;
  sender_moniker: string;
}

export interface IFlashGate {
  evaluateInput(context: F2Context): Promise<FlashGateVerdict>;
  evaluateOutput(context: F1Context): Promise<FlashGateVerdict>;
}
