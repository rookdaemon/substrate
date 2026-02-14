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
  let reader: SubstrateFileReader;
  let checker: PermissionChecker;
  let builder: PromptBuilder;

  beforeEach(async () => {
    fs = new InMemoryFileSystem();
    const config = new SubstrateConfig("/substrate");
    reader = new SubstrateFileReader(fs, config);
    checker = new PermissionChecker();
    builder = new PromptBuilder(reader, checker, {
      substratePath: "/substrate",
      sourceCodePath: "/home/user/substrate",
    });

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
      expect(fileTypes).toContain(SubstrateFileType.MEMORY);
      expect(fileTypes).toHaveLength(6);
    });

    it("returns content for each file", async () => {
      const context = await builder.gatherContext(AgentRole.ID);
      const idFile = context.find((c) => c.fileType === SubstrateFileType.ID);
      expect(idFile).toBeDefined();
      expect(idFile!.content).toContain("Core identity");
    });

    it("Superego gathers all required files (skips missing optional)", async () => {
      const context = await builder.gatherContext(AgentRole.SUPEREGO);
      // 12 required files exist in test setup; PEERS is optional and missing
      expect(context).toHaveLength(12);
    });
  });

  describe("buildSystemPrompt", () => {
    it("includes the role template", () => {
      const prompt = builder.buildSystemPrompt(AgentRole.EGO);
      expect(prompt).toContain(ROLE_PROMPTS[AgentRole.EGO]);
    });

    it("does NOT embed file contents", () => {
      const prompt = builder.buildSystemPrompt(AgentRole.ID);
      expect(prompt).not.toContain("Core identity");
      expect(prompt).not.toContain("Be good");
    });

    it("includes environment section with paths", () => {
      const prompt = builder.buildSystemPrompt(AgentRole.EGO);
      expect(prompt).toContain("=== ENVIRONMENT ===");
      expect(prompt).toContain("Substrate directory: /substrate");
      expect(prompt).toContain("My own source code: /home/user/substrate");
    });
  });

  describe("getContextReferences", () => {
    it("returns @ references for all readable files", () => {
      const refs = builder.getContextReferences(AgentRole.ID);
      expect(refs).toContain("@/substrate/ID.md");
      expect(refs).toContain("@/substrate/VALUES.md");
      expect(refs).toContain("@/substrate/PLAN.md");
      expect(refs).toContain("@/substrate/PROGRESS.md");
      expect(refs).toContain("@/substrate/SKILLS.md");
      expect(refs).toContain("@/substrate/MEMORY.md");
    });

    it("does not include files the role cannot read", () => {
      const refs = builder.getContextReferences(AgentRole.ID);
      expect(refs).not.toContain("@/substrate/SECURITY.md");
      expect(refs).not.toContain("@/substrate/CHARTER.md");
    });

    it("Superego references all files", () => {
      const refs = builder.getContextReferences(AgentRole.SUPEREGO);
      const atRefs = refs.split("\n").filter((l) => l.startsWith("@"));
      const totalFileTypes = Object.values(SubstrateFileType).length;
      expect(atRefs).toHaveLength(totalFileTypes);
    });
  });
});
