import { SubstrateFileType } from "../types";
import {
  PLAN_TEMPLATE,
  MEMORY_TEMPLATE,
  HABITS_TEMPLATE,
  SKILLS_TEMPLATE,
  VALUES_TEMPLATE,
  ID_TEMPLATE,
  SECURITY_TEMPLATE,
  CHARTER_TEMPLATE,
  SUPEREGO_TEMPLATE,
  CLAUDE_TEMPLATE,
  PROGRESS_TEMPLATE,
  CONVERSATION_TEMPLATE,
  AGORA_INBOX_TEMPLATE,
  ESCALATE_TO_STEFAN_TEMPLATE,
} from "./templates";

const TEMPLATE_MAP: Record<SubstrateFileType, string> = {
  [SubstrateFileType.PLAN]: PLAN_TEMPLATE,
  [SubstrateFileType.MEMORY]: MEMORY_TEMPLATE,
  [SubstrateFileType.HABITS]: HABITS_TEMPLATE,
  [SubstrateFileType.SKILLS]: SKILLS_TEMPLATE,
  [SubstrateFileType.VALUES]: VALUES_TEMPLATE,
  [SubstrateFileType.ID]: ID_TEMPLATE,
  [SubstrateFileType.SECURITY]: SECURITY_TEMPLATE,
  [SubstrateFileType.CHARTER]: CHARTER_TEMPLATE,
  [SubstrateFileType.SUPEREGO]: SUPEREGO_TEMPLATE,
  [SubstrateFileType.CLAUDE]: CLAUDE_TEMPLATE,
  [SubstrateFileType.PROGRESS]: PROGRESS_TEMPLATE,
  [SubstrateFileType.CONVERSATION]: CONVERSATION_TEMPLATE,
  [SubstrateFileType.PEERS]: "# Agora Peers\n\nRegistered agents for Agora coordination protocol.\n\n## Future Peers\n\nAgents will be added here as the network expands.\n",
  [SubstrateFileType.AGORA_INBOX]: AGORA_INBOX_TEMPLATE,
  [SubstrateFileType.ESCALATE_TO_STEFAN]: ESCALATE_TO_STEFAN_TEMPLATE,
};

export function getTemplate(fileType: SubstrateFileType): string {
  return TEMPLATE_MAP[fileType];
}
