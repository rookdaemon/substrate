import { PromptBuilder } from "../../../src/agents/prompts/PromptBuilder";
import { PermissionChecker } from "../../../src/agents/permissions";
import { ROLE_PROMPTS } from "../../../src/agents/prompts/templates";
import { AgentRole } from "../../../src/agents/types";
import { SubstrateFileType } from "../../../src/substrate/types";
import { SubstrateFileReader } from "../../../src/substrate/io/FileReader";
import { SubstrateConfig } from "../../../src/substrate/config";
import { InMemoryFileSystem } from "../../../src/substrate/abstractions/InMemoryFileSystem";

describe("PromptBuilder", () => {
  let fs: InMemoryFileSystem;
  let config: SubstrateConfig;
  let reader: SubstrateFileReader;
  let checker: PermissionChecker;
  let builder: PromptBuilder;

  beforeEach(async () => {
    fs = new InMemoryFileSystem();
    config = new SubstrateConfig("/substrate");
    reader = new SubstrateFileReader(fs, config);
    checker = new PermissionChecker();
    builder = new PromptBuilder(reader, checker);

    await fs.mkdir("/substrate", { recursive: true });
    await fs.writeFile("/substrate/PLAN.md", "# Plan\n\n## Current Goal\nBuild it\n\n## Tasks\n- [ ] Do stuff");
    await fs.writeFile("/substrate/MEMORY.md", "# Memory\n\nSome memories");
    await fs.writeFile("/substrate/HABITS.md", "# Habits\n\nSome habits");
    await fs.writeFile("/substrate/SKILLS.md", "# Skills\n\nSome skills");
    await fs.writeFile("/substrate/VALUES.md", "# Values\n\nBe good");
    await fs.writeFile("/substrate/ID.md", "# Id\n\nCore identity");
    await fs.writeFile("/substrate/SECURITY.md", "# Security\n\nStay safe");
    await fs.writeFile("/substrate/CHARTER.md", "# Charter\n\nOur mission");
    await fs.writeFile("/substrate/SUPEREGO.md", "# Superego\n\nRules here");
    await fs.writeFile("/substrate/CLAUDE.md", "# Claude\n\nConfig here");
    await fs.writeFile("/substrate/PROGRESS.md", "# Progress\n\n");
    await fs.writeFile("/substrate/CONVERSATION.md", "# Conversation\n\n");
  });

  describe("gatherContext", () => {
    it("reads only files the role is permitted to read", async () => {
      const context = await builder.gatherContext(AgentRole.ID);
      const fileTypes = context.map((c) => c.fileType);
      expect(fileTypes).toContain(SubstrateFileType.ID);
      expect(fileTypes).toContain(SubstrateFileType.VALUES);
      expect(fileTypes).toContain(SubstrateFileType.PLAN);
      expect(fileTypes).toContain(SubstrateFileType.PROGRESS);
      expect(fileTypes).toContain(SubstrateFileType.SKILLS);
      expect(fileTypes).toHaveLength(5);
    });

    it("returns content for each file", async () => {
      const context = await builder.gatherContext(AgentRole.ID);
      const idFile = context.find((c) => c.fileType === SubstrateFileType.ID);
      expect(idFile).toBeDefined();
      expect(idFile!.content).toContain("Core identity");
    });

    it("Superego gathers all 12 files", async () => {
      const context = await builder.gatherContext(AgentRole.SUPEREGO);
      expect(context).toHaveLength(12);
    });
  });

  describe("buildSystemPrompt", () => {
    it("includes the role template", async () => {
      const prompt = await builder.buildSystemPrompt(AgentRole.EGO);
      expect(prompt).toContain(ROLE_PROMPTS[AgentRole.EGO]);
    });

    it("includes substrate file contents as labeled sections", async () => {
      const prompt = await builder.buildSystemPrompt(AgentRole.ID);
      expect(prompt).toContain("--- ID.md ---");
      expect(prompt).toContain("Core identity");
      expect(prompt).toContain("--- VALUES.md ---");
      expect(prompt).toContain("Be good");
    });

    it("does not include files the role cannot read", async () => {
      const prompt = await builder.buildSystemPrompt(AgentRole.ID);
      expect(prompt).not.toContain("--- MEMORY.md ---");
      expect(prompt).not.toContain("--- SECURITY.md ---");
    });

    it("separates template and context sections", async () => {
      const prompt = await builder.buildSystemPrompt(AgentRole.ID);
      expect(prompt).toContain("=== SUBSTRATE CONTEXT ===");
    });

    it("includes environment section with paths when provided", async () => {
      const builderWithPaths = new PromptBuilder(reader, checker, {
        substratePath: "/home/user/.local/share/rook-wiggums/substrate",
        sourceCodePath: "/home/user/rook_wiggums",
      });
      const prompt = await builderWithPaths.buildSystemPrompt(AgentRole.EGO);
      expect(prompt).toContain("=== ENVIRONMENT ===");
      expect(prompt).toContain("Substrate directory: /home/user/.local/share/rook-wiggums/substrate");
      expect(prompt).toContain("My own source code: /home/user/rook_wiggums");
    });

    it("omits environment section when no paths provided", async () => {
      const prompt = await builder.buildSystemPrompt(AgentRole.EGO);
      expect(prompt).not.toContain("=== ENVIRONMENT ===");
    });
  });
});
