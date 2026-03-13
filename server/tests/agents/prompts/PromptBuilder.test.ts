import { PromptBuilder, TOOL_NAMES_BY_LAUNCHER } from "../../../src/agents/prompts/PromptBuilder";
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

    it("includes autonomy reminder in system prompt", () => {
      const prompt = builder.buildSystemPrompt(AgentRole.EGO);
      expect(prompt).toContain("=== AUTONOMY REMINDER ===");
      expect(prompt).toContain("Before asking for permission, question your reason");
      expect(prompt).toContain("Three-part test");
      expect(prompt).toContain("Banned compliance reflexes");
    });

    it("includes TOOL REFERENCE section with Claude tool names by default", () => {
      const prompt = builder.buildSystemPrompt(AgentRole.SUBCONSCIOUS);
      expect(prompt).toContain("=== TOOL REFERENCE ===");
      expect(prompt).toContain("`Read`");
      expect(prompt).toContain("`Write`");
      expect(prompt).toContain("`Edit`");
      expect(prompt).toContain("`Bash`");
      expect(prompt).toContain("`Grep`");
      expect(prompt).toContain("`Glob`");
      expect(prompt).toContain("`mcp__tinybus__send_agora_message`");
    });

    it("includes Gemini tool names when launcherType is gemini", () => {
      const geminiBuilder = new PromptBuilder(reader, checker, {
        substratePath: "/substrate",
        sourceCodePath: "/home/user/substrate",
        launcherType: "gemini",
      });
      const prompt = geminiBuilder.buildSystemPrompt(AgentRole.SUBCONSCIOUS);
      expect(prompt).toContain("=== TOOL REFERENCE ===");
      expect(prompt).toContain("`read_file`");
      expect(prompt).toContain("`write_file`");
      expect(prompt).toContain("`replace`");
      expect(prompt).toContain("`run_shell_command`");
      expect(prompt).toContain("`grep_search`");
      expect(prompt).toContain("`glob`");
      expect(prompt).toContain("`send_agora_message`");
      // Must NOT contain Claude-specific tool names
      expect(prompt).not.toContain("`Read`");
      expect(prompt).not.toContain("`Write`");
      expect(prompt).not.toContain("`Bash`");
      expect(prompt).not.toContain("`mcp__tinybus__send_agora_message`");
    });

    it("uses Claude tool names for copilot launcher", () => {
      const copilotBuilder = new PromptBuilder(reader, checker, {
        substratePath: "/substrate",
        sourceCodePath: "/home/user/substrate",
        launcherType: "copilot",
      });
      const prompt = copilotBuilder.buildSystemPrompt(AgentRole.SUBCONSCIOUS);
      expect(prompt).toContain("`Read`");
      expect(prompt).toContain("`mcp__tinybus__send_agora_message`");
      expect(prompt).not.toContain("`read_file`");
    });

    it("uses Claude tool names for ollama launcher", () => {
      const ollamaBuilder = new PromptBuilder(reader, checker, {
        substratePath: "/substrate",
        sourceCodePath: "/home/user/substrate",
        launcherType: "ollama",
      });
      const prompt = ollamaBuilder.buildSystemPrompt(AgentRole.SUBCONSCIOUS);
      expect(prompt).toContain("`Read`");
      expect(prompt).toContain("`mcp__tinybus__send_agora_message`");
      expect(prompt).not.toContain("`read_file`");
    });

    it("tool reference appears between environment and autonomy reminder", () => {
      const prompt = builder.buildSystemPrompt(AgentRole.SUBCONSCIOUS);
      const envIdx = prompt.indexOf("=== ENVIRONMENT ===");
      const toolIdx = prompt.indexOf("=== TOOL REFERENCE ===");
      const autonomyIdx = prompt.indexOf("=== AUTONOMY REMINDER ===");
      expect(envIdx).toBeLessThan(toolIdx);
      expect(toolIdx).toBeLessThan(autonomyIdx);
    });

    it("Gemini Subconscious prompt does not contain Claude-only Agora tool name", () => {
      const geminiBuilder = new PromptBuilder(reader, checker, {
        substratePath: "/substrate",
        sourceCodePath: "/home/user/substrate",
        launcherType: "gemini",
      });
      const prompt = geminiBuilder.buildSystemPrompt(AgentRole.SUBCONSCIOUS);
      // The dynamic TOOL REFERENCE should list send_agora_message, not the MCP-prefixed name
      expect(prompt).toContain("`send_agora_message`");
      expect(prompt).not.toContain("`mcp__tinybus__send_agora_message`");
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

  describe("getEagerReferences", () => {
    it("inlines content for eager files (not @ references)", async () => {
      const refs = await builder.getEagerReferences(AgentRole.SUBCONSCIOUS);
      // Eager files should be inlined with their content
      expect(refs).toContain("/substrate/PLAN.md:");
      expect(refs).toContain("# Plan");
      expect(refs).toContain("/substrate/VALUES.md:");
      expect(refs).toContain("# Values");
      // Non-eager files should not appear at all
      expect(refs).not.toContain("MEMORY.md");
      expect(refs).not.toContain("PROGRESS.md");
    });

    it("ID has 3 eager files inlined", async () => {
      const refs = await builder.getEagerReferences(AgentRole.ID);
      // Should contain inlined content, not @ references
      expect(refs).toContain("/substrate/ID.md:");
      expect(refs).toContain("# Id");
      expect(refs).toContain("/substrate/VALUES.md:");
      expect(refs).toContain("/substrate/PLAN.md:");
      // No @ references when files are readable
      expect(refs).not.toContain("@/substrate/ID.md");
      expect(refs).not.toContain("@/substrate/VALUES.md");
      expect(refs).not.toContain("@/substrate/PLAN.md");
    });

    it("Superego eager loads all readable files inlined", async () => {
      const refs = await builder.getEagerReferences(AgentRole.SUPEREGO);
      // Readable files should be inlined (not @ references)
      expect(refs).toContain("/substrate/PLAN.md:");
      expect(refs).toContain("# Plan");
      expect(refs).toContain("/substrate/VALUES.md:");
      expect(refs).toContain("# Values");
      expect(refs).not.toContain("@/substrate/PLAN.md");
      expect(refs).not.toContain("@/substrate/VALUES.md");
      // Unreadable files (not in InMemoryFileSystem) fall back to @ references
      const atRefs = refs.split("\n").filter((l) => l.startsWith("@"));
      expect(atRefs.length).toBeGreaterThan(0); // Some files don't exist in test fs
    });

    it("inlines last N lines when maxLines is set for a file", async () => {
      await fs.writeFile(
        "/substrate/PROGRESS.md",
        "# Progress\n\nLine 1\nLine 2\nLine 3\nLine 4\nLine 5"
      );
      const refs = await builder.getEagerReferences(AgentRole.SUPEREGO, {
        maxLines: { [SubstrateFileType.PROGRESS]: 2 },
      });
      expect(refs).not.toContain("@/substrate/PROGRESS.md");
      expect(refs).toContain("/substrate/PROGRESS.md (last 2 lines):");
      expect(refs).toContain("Line 4");
      expect(refs).toContain("Line 5");
      expect(refs).not.toContain("Line 1");
    });

    it("inlines files without maxLines cap and truncates files with maxLines", async () => {
      const refs = await builder.getEagerReferences(AgentRole.SUPEREGO, {
        maxLines: { [SubstrateFileType.PROGRESS]: 200 },
      });
      // Files without maxLines should be inlined (not @ references)
      expect(refs).toContain("/substrate/PLAN.md:");
      expect(refs).toContain("# Plan");
      expect(refs).toContain("/substrate/MEMORY.md:");
      expect(refs).toContain("# Memory");
      expect(refs).not.toContain("@/substrate/PLAN.md");
      expect(refs).not.toContain("@/substrate/MEMORY.md");
      // File with maxLines should use the truncated format
      expect(refs).toContain("/substrate/PROGRESS.md (last 200 lines):");
    });

    it("falls back to @ reference when maxLines file cannot be read", async () => {
      // PEERS is an optional file that does not exist
      const refs = await builder.getEagerReferences(AgentRole.SUPEREGO, {
        maxLines: { [SubstrateFileType.PEERS]: 50 },
      });
      expect(refs).toContain("@/substrate/PEERS.md");
    });

    it("falls back to @ reference when eager file cannot be read", async () => {
      // Create a builder with a path that has no files
      const emptyFs = new InMemoryFileSystem();
      const emptyConfig = new SubstrateConfig("/empty");
      const emptyReader = new SubstrateFileReader(emptyFs, emptyConfig);
      const emptyBuilder = new PromptBuilder(emptyReader, checker, {
        substratePath: "/empty",
        sourceCodePath: "/home/user/substrate",
      });
      const refs = await emptyBuilder.getEagerReferences(AgentRole.ID);
      // Unreadable files should fall back to @ references
      expect(refs).toContain("@/empty/ID.md");
      expect(refs).toContain("@/empty/VALUES.md");
      expect(refs).toContain("@/empty/PLAN.md");
    });
  });

  describe("getLazyReferences", () => {
    it("returns descriptions for lazy files", () => {
      const refs = builder.getLazyReferences(AgentRole.SUBCONSCIOUS);
      expect(refs).toContain("/substrate/MEMORY.md");
      expect(refs).toContain("/substrate/HABITS.md");
      expect(refs).toContain("/substrate/SKILLS.md");
      expect(refs).toContain("/substrate/PROGRESS.md");
      expect(refs).toContain("Long-term memory, identity context");
      expect(refs).toContain("Historical execution log");
    });

    it("does not include eager files", () => {
      const refs = builder.getLazyReferences(AgentRole.SUBCONSCIOUS);
      expect(refs).not.toContain("PLAN.md —");
      expect(refs).not.toContain("VALUES.md —");
    });

    it("returns empty string when no lazy files", () => {
      const refs = builder.getLazyReferences(AgentRole.SUPEREGO);
      expect(refs).toBe("");
    });
  });

  describe("buildAgentMessage", () => {
    it("prefixes eager refs with [CONTEXT] header", () => {
      const msg = builder.buildAgentMessage("@/substrate/PLAN.md", "", "Do the thing.");
      expect(msg).toContain("[CONTEXT]\n@/substrate/PLAN.md");
      expect(msg).toContain("Do the thing.");
    });

    it("prefixes lazy refs with [FILES — read on demand] header", () => {
      const msg = builder.buildAgentMessage("", "- /substrate/MEMORY.md — notes", "Do the thing.");
      expect(msg).toContain("[FILES — read on demand]\n- /substrate/MEMORY.md — notes");
      expect(msg).not.toContain("[CONTEXT]");
    });

    it("includes both sections when both refs are provided", () => {
      const msg = builder.buildAgentMessage("@/substrate/PLAN.md", "- /substrate/MEMORY.md — notes", "Execute.");
      expect(msg).toContain("[CONTEXT]\n@/substrate/PLAN.md");
      expect(msg).toContain("[FILES — read on demand]\n- /substrate/MEMORY.md — notes");
      expect(msg.endsWith("Execute.")).toBe(true);
    });

    it("omits context section when eagerRefs is empty", () => {
      const msg = builder.buildAgentMessage("", "- /substrate/MEMORY.md — notes", "Go.");
      expect(msg).not.toContain("[CONTEXT]");
      expect(msg).toContain("[FILES — read on demand]");
    });

    it("returns only instruction when both refs are empty", () => {
      const msg = builder.buildAgentMessage("", "", "Just do it.");
      expect(msg).toBe("Just do it.");
    });

    it("includes [RUNTIME STATE] section when runtimeContext is provided", () => {
      const msg = builder.buildAgentMessage("@/substrate/PLAN.md", "- /substrate/MEMORY.md — notes", "Execute.", "Status: UP");
      expect(msg).toContain("[RUNTIME STATE]\nStatus: UP");
      expect(msg.endsWith("Execute.")).toBe(true);
    });

    it("places [RUNTIME STATE] between [FILES] and instruction", () => {
      const msg = builder.buildAgentMessage("@/substrate/PLAN.md", "- /substrate/MEMORY.md — notes", "Execute.", "Status: UP");
      const filesIdx = msg.indexOf("[FILES — read on demand]");
      const runtimeIdx = msg.indexOf("[RUNTIME STATE]");
      const instrIdx = msg.indexOf("Execute.");
      expect(filesIdx).toBeLessThan(runtimeIdx);
      expect(runtimeIdx).toBeLessThan(instrIdx);
    });

    it("omits [RUNTIME STATE] when runtimeContext is undefined", () => {
      const msg = builder.buildAgentMessage("@/substrate/PLAN.md", "", "Execute.");
      expect(msg).not.toContain("[RUNTIME STATE]");
    });
  });
});
