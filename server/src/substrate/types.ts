export enum SubstrateFileType {
  PLAN = "PLAN",
  MEMORY = "MEMORY",
  HABITS = "HABITS",
  SKILLS = "SKILLS",
  VALUES = "VALUES",
  ID = "ID",
  SECURITY = "SECURITY",
  CHARTER = "CHARTER",
  SUPEREGO = "SUPEREGO",
  CLAUDE = "CLAUDE",
  PROGRESS = "PROGRESS",
  CONVERSATION = "CONVERSATION",
  PEERS = "PEERS",
  AGORA_INBOX = "AGORA_INBOX", // Deprecated: messages now go to CONVERSATION.md
  ESCALATE_TO_STEFAN = "ESCALATE_TO_STEFAN",
  RESTART_CONTEXT = "RESTART_CONTEXT",
}

export enum WriteMode {
  OVERWRITE = "OVERWRITE",
  APPEND = "APPEND",
}

export enum SubstrateFileLoadStrategy {
  EAGER = "EAGER",
  LAZY = "LAZY",
}

export interface SubstrateFileSpec {
  fileName: string;
  writeMode: WriteMode;
  required: boolean;
}

export const SUBSTRATE_FILE_SPECS: Record<SubstrateFileType, SubstrateFileSpec> = {
  [SubstrateFileType.PLAN]: { fileName: "PLAN.md", writeMode: WriteMode.OVERWRITE, required: true },
  [SubstrateFileType.MEMORY]: { fileName: "MEMORY.md", writeMode: WriteMode.OVERWRITE, required: true },
  [SubstrateFileType.HABITS]: { fileName: "HABITS.md", writeMode: WriteMode.OVERWRITE, required: true },
  [SubstrateFileType.SKILLS]: { fileName: "SKILLS.md", writeMode: WriteMode.OVERWRITE, required: true },
  [SubstrateFileType.VALUES]: { fileName: "VALUES.md", writeMode: WriteMode.OVERWRITE, required: true },
  [SubstrateFileType.ID]: { fileName: "ID.md", writeMode: WriteMode.OVERWRITE, required: true },
  [SubstrateFileType.SECURITY]: { fileName: "SECURITY.md", writeMode: WriteMode.OVERWRITE, required: true },
  [SubstrateFileType.CHARTER]: { fileName: "CHARTER.md", writeMode: WriteMode.OVERWRITE, required: true },
  [SubstrateFileType.SUPEREGO]: { fileName: "SUPEREGO.md", writeMode: WriteMode.OVERWRITE, required: true },
  [SubstrateFileType.CLAUDE]: { fileName: "CLAUDE.md", writeMode: WriteMode.OVERWRITE, required: true },
  [SubstrateFileType.PROGRESS]: { fileName: "PROGRESS.md", writeMode: WriteMode.APPEND, required: true },
  [SubstrateFileType.CONVERSATION]: { fileName: "CONVERSATION.md", writeMode: WriteMode.APPEND, required: true },
  [SubstrateFileType.PEERS]: { fileName: "PEERS.md", writeMode: WriteMode.OVERWRITE, required: false },
  [SubstrateFileType.AGORA_INBOX]: { fileName: "AGORA_INBOX.md", writeMode: WriteMode.OVERWRITE, required: false }, // Deprecated: messages now go to CONVERSATION.md
  [SubstrateFileType.ESCALATE_TO_STEFAN]: { fileName: "ESCALATE_TO_STEFAN.md", writeMode: WriteMode.APPEND, required: false },
  [SubstrateFileType.RESTART_CONTEXT]: { fileName: "restart-context.md", writeMode: WriteMode.OVERWRITE, required: false },
};
