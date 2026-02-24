import { execSync } from "child_process";
import { TriggerEvaluator } from "./PlanParser";

export class ShellTriggerEvaluator implements TriggerEvaluator {
  evaluate(condition: string): boolean {
    try {
      execSync(condition, { stdio: "ignore" });
      return true;
    } catch {
      return false;
    }
  }
}
