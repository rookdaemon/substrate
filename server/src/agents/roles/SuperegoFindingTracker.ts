import * as crypto from "crypto";

export interface Finding {
  severity: "info" | "warning" | "critical";
  message: string;
}

export interface EscalationInfo {
  findingId: string;
  severity: string;
  message: string;
  cycles: number[];
  firstDetectedCycle: number;
  lastOccurrenceCycle: number;
}

export class SuperegoFindingTracker {
  private findingHistory: Map<string, number[]> = new Map();
  private readonly CONSECUTIVE_THRESHOLD = 3;

  /**
   * Generate a stable signature for a finding based on severity and message content.
   * Uses first 200 chars of message to balance uniqueness with minor wording variations.
   */
  generateSignature(finding: Finding): string {
    const content = finding.severity + finding.message.substring(0, 200);
    return crypto.createHash("sha256").update(content).digest("hex").substring(0, 16);
  }

  /**
   * Track a finding occurrence at the given cycle number.
   * Returns true if this finding should be escalated (3+ consecutive occurrences).
   */
  track(finding: Finding, cycleNumber: number): boolean {
    const signature = this.generateSignature(finding);
    const history = this.findingHistory.get(signature) || [];
    
    // Add current cycle to history
    history.push(cycleNumber);
    this.findingHistory.set(signature, history);

    // Check if should escalate
    return this.shouldEscalate(signature);
  }

  /**
   * Check if a finding has occurred in 3+ consecutive audit cycles.
   * Consecutive means the cycles form an unbroken sequence when sorted.
   */
  shouldEscalate(findingId: string): boolean {
    const history = this.findingHistory.get(findingId);
    if (!history || history.length < this.CONSECUTIVE_THRESHOLD) {
      return false;
    }

    // Check if last 3 occurrences are consecutive
    const sorted = [...history].sort((a, b) => a - b);
    const last3 = sorted.slice(-this.CONSECUTIVE_THRESHOLD);
    
    // Check if they form a consecutive sequence
    for (let i = 1; i < last3.length; i++) {
      // Allow for the audit interval - findings should appear every N cycles
      // We consider them consecutive if they're reasonably close (within 2x normal interval)
      const gap = last3[i] - last3[i - 1];
      if (gap > 50) { // Max reasonable gap between audits (even with interval of 20-40)
        return false;
      }
    }

    return true;
  }

  /**
   * Get escalation information for a finding that should be escalated.
   */
  getEscalationInfo(finding: Finding): EscalationInfo | null {
    const signature = this.generateSignature(finding);
    const history = this.findingHistory.get(signature);
    
    if (!history || history.length < this.CONSECUTIVE_THRESHOLD) {
      return null;
    }

    const sorted = [...history].sort((a, b) => a - b);
    
    return {
      findingId: signature,
      severity: finding.severity,
      message: finding.message,
      cycles: sorted,
      firstDetectedCycle: sorted[0],
      lastOccurrenceCycle: sorted[sorted.length - 1],
    };
  }

  /**
   * Remove a finding from tracking after escalation to avoid repeated escalations.
   */
  clearFinding(findingId: string): void {
    this.findingHistory.delete(findingId);
  }

  /**
   * Get all tracked finding signatures (for testing/debugging).
   */
  getTrackedFindings(): string[] {
    return Array.from(this.findingHistory.keys());
  }

  /**
   * Get history for a specific finding (for testing/debugging).
   */
  getFindingHistory(findingId: string): number[] | undefined {
    return this.findingHistory.get(findingId);
  }
}
