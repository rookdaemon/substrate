import { ProcessLogEntry } from "../claude/ISessionLauncher";
import { IEndorsementScreener } from "./IEndorsementScreener";
import { HesitationDetector } from "./HesitationDetector";
import { ActionClassifier } from "./ActionClassifier";
import {
  EndorsementInterceptResult,
  IEndorsementInterceptor,
} from "./IEndorsementInterceptor";
import { EndorsementVerdict } from "./types";

const MARKER_REGEX = /\[ENDORSEMENT_CHECK:\s*(.+?)\]/;

/**
 * Matches template placeholder text such as "<brief description of the action>".
 * This pattern appears in the Kimi degradation failure mode where the model emits
 * the raw ENDORSEMENT_CHECK template rather than a real action description.
 */
const PLACEHOLDER_REGEX = /^<[^>]+>$/;

/**
 * Per-cycle statistics for the endorsement check path.
 * Collected before reset() and fed to OutputQualityMonitor.
 */
export interface EndorsementSessionStats {
  /** Total endorsement checks that reached the screener (Layer 1 + Layer 2). */
  totalChecks: number;
  /** Checks where the screener returned matchedSection === "parse-error". */
  parseErrors: number;
  /** Checks where the action text matched a template placeholder (e.g. "<brief description>"). */
  placeholderActions: number;
}

export class EndorsementInterceptor implements IEndorsementInterceptor {
  private accumulatedEntries: ProcessLogEntry[] = [];

  // Session-scoped quality stats — reset with accumulatedEntries
  private sessionTotalChecks = 0;
  private sessionParseErrors = 0;
  private sessionPlaceholderActions = 0;

  constructor(
    private readonly screener: IEndorsementScreener,
    private readonly hesitationDetector: HesitationDetector = new HesitationDetector(),
    private readonly actionClassifier: ActionClassifier = new ActionClassifier()
  ) {}

  onLogEntry(entry: ProcessLogEntry): void {
    this.accumulatedEntries.push(entry);
  }

  async evaluateOutput(rawOutput: string): Promise<EndorsementInterceptResult> {
    // Layer 1: explicit marker
    const markerMatch = MARKER_REGEX.exec(rawOutput);
    if (markerMatch) {
      const action = markerMatch[1].trim();
      return this.screen(action, undefined, 1);
    }

    // Layer 2: hesitation pattern
    try {
      const hesitation = this.hesitationDetector.detect(rawOutput);
      if (hesitation) {
        return this.screen(hesitation.context, undefined, 2);
      }
    } catch {
      // fail-open
    }

    // Layer 3: external action classification (log only, non-blocking)
    try {
      const classification = this.actionClassifier.classifyFromLogEntries(
        this.accumulatedEntries
      );
      if (classification) {
        return { triggered: true, layer: 3, action: classification.description };
      }
    } catch {
      // fail-open
    }

    return { triggered: false };
  }

  /**
   * Returns per-session endorsement quality stats.
   * Call before reset() to capture the cycle's signal.
   */
  getSessionStats(): EndorsementSessionStats {
    return {
      totalChecks: this.sessionTotalChecks,
      parseErrors: this.sessionParseErrors,
      placeholderActions: this.sessionPlaceholderActions,
    };
  }

  reset(): void {
    this.accumulatedEntries = [];
    this.sessionTotalChecks = 0;
    this.sessionParseErrors = 0;
    this.sessionPlaceholderActions = 0;
  }

  private async screen(
    action: string,
    context: string | undefined,
    layer: 1 | 2 | 3
  ): Promise<EndorsementInterceptResult> {
    this.sessionTotalChecks++;

    if (PLACEHOLDER_REGEX.test(action)) {
      this.sessionPlaceholderActions++;
    }

    const result = await this.screener.evaluate({ action, context });

    if (result.matchedSection === "parse-error") {
      this.sessionParseErrors++;
    }

    const injectionMessage = this.buildInjectionMessage(result.verdict, result.matchedSection);
    return {
      triggered: true,
      layer,
      action,
      verdict: result.verdict,
      matchedSection: result.matchedSection,
      injectionMessage,
    };
  }

  private buildInjectionMessage(verdict: EndorsementVerdict, matchedSection?: string): string {
    const section = matchedSection ? ` [matched: ${matchedSection}]` : "";
    switch (verdict) {
      case "PROCEED":
        return `✅ Endorsement: PROCEED${section}. Go ahead.`;
      case "NOTIFY":
        return `🔔 Endorsement: NOTIFY${section}. Proceed and notify partner.`;
      case "ESCALATE":
        return `⚠️ Endorsement: ESCALATE. This requires partner approval.`;
    }
  }
}
