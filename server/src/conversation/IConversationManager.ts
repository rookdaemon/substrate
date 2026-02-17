import { AgentRole } from "../agents/types";

/**
 * Interface for managing conversation entries.
 * Allows mocking conversation writes in tests.
 */
export interface IConversationManager {
  append(role: AgentRole, entry: string): Promise<void>;
}
