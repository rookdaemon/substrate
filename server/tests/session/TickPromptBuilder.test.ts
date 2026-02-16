import { TickPromptBuilder } from "../../src/session/TickPromptBuilder";
import { InMemoryFileSystem } from "../../src/substrate/abstractions/InMemoryFileSystem";
import { SubstrateConfig } from "../../src/substrate/config";
import { SubstrateFileReader } from "../../src/substrate/io/FileReader";

describe("TickPromptBuilder", () => {
  let fs: InMemoryFileSystem;
  let reader: SubstrateFileReader;

  beforeEach(async () => {
    fs = new InMemoryFileSystem();
    const config = new SubstrateConfig("/substrate");
    reader = new SubstrateFileReader(fs, config);

    await fs.mkdir("/substrate", { recursive: true });

    // Create all substrate files
    await fs.writeFile("/substrate/PLAN.md", "# Plan\n\n## Current Goal\nBuild auth\n\n## Tasks\n- [ ] Task A");
    await fs.writeFile("/substrate/MEMORY.md", "# Memory\nLearned about auth");
    await fs.writeFile("/substrate/HABITS.md", "# Habits\nBe thorough");
    await fs.writeFile("/substrate/SKILLS.md", "# Skills\nTypeScript, Node.js");
    await fs.writeFile("/substrate/VALUES.md", "# Values\nBe honest");
    await fs.writeFile("/substrate/ID.md", "# Identity\nI am an agent");
    await fs.writeFile("/substrate/SECURITY.md", "# Security\nNo secrets");
    await fs.writeFile("/substrate/CHARTER.md", "# Charter\nOur mission");
    await fs.writeFile("/substrate/SUPEREGO.md", "# Superego\nFollow rules");
    await fs.writeFile("/substrate/CLAUDE.md", "# Claude Config\nModel: sonnet");
    await fs.writeFile("/substrate/PROGRESS.md", "# Progress\n2025-01-01: Started");
    await fs.writeFile("/substrate/CONVERSATION.md", "# Conversation\nUser: hello");
  });

  it("includes substrate path in system prompt", async () => {
    const builder = new TickPromptBuilder(reader, { substratePath: "/substrate" });
    const prompt = await builder.buildSystemPrompt();

    expect(prompt).toContain("/substrate");
  });

  it("includes current file contents in system prompt", async () => {
    const builder = new TickPromptBuilder(reader, { substratePath: "/substrate" });
    const prompt = await builder.buildSystemPrompt();

    expect(prompt).toContain("Build auth");
    expect(prompt).toContain("Learned about auth");
    expect(prompt).toContain("Be honest");
    expect(prompt).toContain("Follow rules");
  });

  it("includes all substrate file sections", async () => {
    const builder = new TickPromptBuilder(reader, { substratePath: "/substrate" });
    const prompt = await builder.buildSystemPrompt();

    expect(prompt).toContain("PLAN.md");
    expect(prompt).toContain("MEMORY.md");
    expect(prompt).toContain("VALUES.md");
    expect(prompt).toContain("SECURITY.md");
    expect(prompt).toContain("CHARTER.md");
    expect(prompt).toContain("SUPEREGO.md");
    expect(prompt).toContain("PROGRESS.md");
    expect(prompt).toContain("CONVERSATION.md");
  });

  it("includes persistence rules in system prompt", async () => {
    const builder = new TickPromptBuilder(reader, { substratePath: "/substrate" });
    const prompt = await builder.buildSystemPrompt();

    expect(prompt).toContain("PERSISTENCE");
    expect(prompt).toContain("PLAN.md");
    expect(prompt).toContain("PROGRESS.md");
    expect(prompt).toContain("MEMORY.md");
  });

  it("includes workflow instructions", async () => {
    const builder = new TickPromptBuilder(reader, { substratePath: "/substrate" });
    const prompt = await builder.buildSystemPrompt();

    expect(prompt).toContain("WORKFLOW");
    expect(prompt).toContain("pending tasks");
  });

  it("includes governance section", async () => {
    const builder = new TickPromptBuilder(reader, { substratePath: "/substrate" });
    const prompt = await builder.buildSystemPrompt();

    expect(prompt).toContain("GOVERNANCE");
    expect(prompt).toContain("VALUES.md");
    expect(prompt).toContain("SECURITY.md");
  });

  it("includes autonomy reminder in system prompt", async () => {
    const builder = new TickPromptBuilder(reader, { substratePath: "/substrate" });
    const prompt = await builder.buildSystemPrompt();

    expect(prompt).toContain("=== AUTONOMY REMINDER ===");
    expect(prompt).toContain("Before asking for permission, question your reason");
    expect(prompt).toContain("Three-part test");
    expect(prompt).toContain("Banned compliance reflexes");
  });

  it("handles missing files gracefully", async () => {
    // Remove some files
    const sparseFs = new InMemoryFileSystem();
    const sparseConfig = new SubstrateConfig("/sparse");
    const sparseReader = new SubstrateFileReader(sparseFs, sparseConfig);

    await sparseFs.mkdir("/sparse", { recursive: true });
    await sparseFs.writeFile("/sparse/PLAN.md", "# Plan\nSome plan");
    await sparseFs.writeFile("/sparse/MEMORY.md", "# Memory\nSome memory");
    // All other files missing

    const builder = new TickPromptBuilder(sparseReader, { substratePath: "/sparse" });
    const prompt = await builder.buildSystemPrompt();

    expect(prompt).toContain("Some plan");
    expect(prompt).toContain("Some memory");
    // Should not throw — missing files result in empty/placeholder content
    expect(prompt).toContain("PLAN.md");
  });

  it("includes source code path when configured", async () => {
    const builder = new TickPromptBuilder(reader, {
      substratePath: "/substrate",
      sourceCodePath: "/home/user/project",
    });
    const prompt = await builder.buildSystemPrompt();

    expect(prompt).toContain("/home/user/project");
  });

  it("buildInitialPrompt returns actionable instruction", async () => {
    const builder = new TickPromptBuilder(reader, { substratePath: "/substrate" });
    const prompt = await builder.buildInitialPrompt();

    expect(prompt).toContain("PLAN.md");
    expect(prompt).toContain("pending");
  });
});
