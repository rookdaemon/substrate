import { exec } from "child_process";
import { TriggerEvaluator } from "./PlanParser";

export class ShellTriggerEvaluator implements TriggerEvaluator {
  async evaluate(trigger: string): Promise<boolean> {
    return new Promise((resolve) => {
      exec(trigger, (error) => {
        resolve(!error);
      });
    });
  }
}
