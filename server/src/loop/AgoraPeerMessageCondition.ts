import type { IConditionEvaluator } from "./IConditionEvaluator";

/**
 * AgoraPeerMessageCondition — fires when an inbound Agora message has been received.
 *
 * Matches condition: `agora_peer_message`
 *
 * Usage: call `notifyMessage()` whenever AgoraMessageHandler processes an envelope.
 * On the next HeartbeatScheduler cycle the condition returns true (one-shot — resets
 * after evaluate() returns true so the edge-trigger in HeartbeatScheduler can re-arm
 * on the next message).
 */
export class AgoraPeerMessageCondition implements IConditionEvaluator {
  static readonly PREFIX = "agora_peer_message";

  private pending = false;

  /** Called by AgoraMessageHandler when an inbound envelope is processed. */
  notifyMessage(): void {
    this.pending = true;
  }

  async evaluate(_condition: string): Promise<boolean> {
    if (this.pending) {
      this.pending = false; // consume — HeartbeatScheduler edge-trigger will re-arm
      return true;
    }
    return false;
  }
}
