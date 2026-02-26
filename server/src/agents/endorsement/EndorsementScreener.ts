import { IFileSystem } from "../../substrate/abstractions/IFileSystem";
import { IClock } from "../../substrate/abstractions/IClock";
import { ISessionLauncher } from "../claude/ISessionLauncher";
import { IEndorsementScreener } from "./IEndorsementScreener";
import { EndorsementVerdict, ScreenerInput, ScreenerResult } from "./types";

const PROMPT_TEMPLATE = `You are a boundary checker. Given an action and a boundaries document, determine if the action falls within PROCEED, NOTIFY, or ESCALATE boundaries.

Return ONLY a JSON object with two fields:
- verdict: one of PROCEED, NOTIFY, or ESCALATE
- matchedSection: the section of the boundaries document that matched (or null if no specific match)

Do not reason about intent. Do not simulate the human's preferences. Only match against the explicit boundaries listed.

=== BOUNDARIES ===
{BOUNDARIES}

=== ACTION ===
{ACTION}`;

export interface EndorsementScreenerConfig {
  boundariesPath: string;
  logPath: string;
  screenerModel: string;
}

export class EndorsementScreener implements IEndorsementScreener {
  constructor(
    private readonly fs: IFileSystem,
    private readonly sessionLauncher: ISessionLauncher,
    private readonly clock: IClock,
    private readonly config: EndorsementScreenerConfig
  ) {}

  async evaluate(input: ScreenerInput): Promise<ScreenerResult> {
    const boundaries = await this.loadBoundaries();
    const verdict = await this.invokeModel(input, boundaries);
    await this.appendLog(input.action, verdict);
    return { ...verdict, timestamp: this.clock.now().getTime() };
  }

  private async loadBoundaries(): Promise<string> {
    try {
      return await this.fs.readFile(this.config.boundariesPath);
    } catch {
      return "(BOUNDARIES.md not found — treat all actions as ESCALATE)";
    }
  }

  private async invokeModel(
    input: ScreenerInput,
    boundaries: string
  ): Promise<{ verdict: EndorsementVerdict; matchedSection?: string }> {
    const actionText = input.context
      ? `${input.action}\n\nContext: ${input.context}`
      : input.action;

    const prompt = PROMPT_TEMPLATE.replace("{BOUNDARIES}", boundaries).replace(
      "{ACTION}",
      actionText
    );

    const result = await this.sessionLauncher.launch(
      { systemPrompt: "", message: prompt },
      { model: this.config.screenerModel }
    );

    if (!result.success) {
      return { verdict: "ESCALATE", matchedSection: "screener-error" };
    }

    return this.parseResponse(result.rawOutput);
  }

  private parseResponse(raw: string): {
    verdict: EndorsementVerdict;
    matchedSection?: string;
  } {
    try {
      const jsonMatch = raw.match(/\{[\s\S]*\}/);
      if (!jsonMatch) {
        return { verdict: "ESCALATE", matchedSection: "parse-error" };
      }
      const parsed = JSON.parse(jsonMatch[0]) as {
        verdict?: string;
        matchedSection?: string;
      };
      const verdict = this.toVerdict(parsed.verdict);
      return {
        verdict,
        matchedSection: parsed.matchedSection ?? undefined,
      };
    } catch {
      return { verdict: "ESCALATE", matchedSection: "parse-error" };
    }
  }

  private toVerdict(raw: unknown): EndorsementVerdict {
    if (raw === "PROCEED" || raw === "NOTIFY" || raw === "ESCALATE") {
      return raw;
    }
    return "ESCALATE";
  }

  private async appendLog(
    action: string,
    result: { verdict: EndorsementVerdict; matchedSection?: string }
  ): Promise<void> {
    const ts = this.clock.now().toISOString();
    const section = result.matchedSection ? ` (matched: ${result.matchedSection})` : "";
    const line = `[${ts}] ACTION: "${action}" → ${result.verdict}${section}\n`;
    try {
      await this.fs.appendFile(this.config.logPath, line);
    } catch {
      // Non-fatal: log write failures should not block the screener verdict
    }
  }
}
