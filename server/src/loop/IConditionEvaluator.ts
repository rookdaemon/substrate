/**
 * Interface for HEARTBEAT.md condition evaluators.
 *
 * Each evaluator is responsible for a specific condition type (e.g. `peer:X.available`).
 * Evaluators are called by HeartbeatScheduler on every cycle for entries that have a
 * `when:` clause. The scheduler handles edge-trigger logic (fires once per false→true
 * transition) so evaluators may return raw current state.
 */
export interface IConditionEvaluator {
  /**
   * Evaluate the given condition expression and return whether it is currently satisfied.
   * @param condition The condition string as parsed from the `when:` clause.
   */
  evaluate(condition: string): Promise<boolean>;
}
