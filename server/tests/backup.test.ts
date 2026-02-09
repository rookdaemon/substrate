import { buildBackupArgs, createBackup } from "../src/backup";
import { InMemoryFileSystem } from "../src/substrate/abstractions/InMemoryFileSystem";
import { InMemoryProcessRunner } from "../src/agents/claude/InMemoryProcessRunner";
import { FixedClock } from "../src/substrate/abstractions/FixedClock";

describe("buildBackupArgs", () => {
  it("includes config and data dirs in tar args", () => {
    const args = buildBackupArgs({
      configDir: "/home/user/.config/rook-wiggums",
      dataDir: "/home/user/.local/share/rook-wiggums",
      outputPath: "/tmp/backup.tar.gz",
    });

    expect(args.command).toBe("tar");
    expect(args.args).toContain("-czf");
    expect(args.args).toContain("/tmp/backup.tar.gz");
    expect(args.args).toContain("/home/user/.config/rook-wiggums");
    expect(args.args).toContain("/home/user/.local/share/rook-wiggums");
  });
});

describe("createBackup", () => {
  it("runs tar and returns the output path", async () => {
    const fs = new InMemoryFileSystem();
    const runner = new InMemoryProcessRunner();
    const clock = new FixedClock(new Date("2025-06-15T10:00:00.000Z"));

    await fs.mkdir("/config", { recursive: true });
    await fs.mkdir("/data", { recursive: true });

    runner.enqueue({ stdout: "", stderr: "", exitCode: 0 });

    const result = await createBackup({
      fs,
      runner,
      clock,
      configDir: "/config",
      dataDir: "/data",
      outputDir: "/backups",
    });

    expect(result.success).toBe(true);
    expect(result.outputPath).toMatch(/rook-wiggums-backup-2025-06-15T.*\.tar\.gz$/);

    const calls = runner.getCalls();
    expect(calls).toHaveLength(1);
    expect(calls[0].command).toBe("tar");
    expect(calls[0].args).toContain("-czf");
    expect(calls[0].args).toContain("/config");
    expect(calls[0].args).toContain("/data");
  });

  it("creates output directory if it does not exist", async () => {
    const fs = new InMemoryFileSystem();
    const runner = new InMemoryProcessRunner();
    const clock = new FixedClock(new Date("2025-06-15T10:00:00.000Z"));

    await fs.mkdir("/config", { recursive: true });
    await fs.mkdir("/data", { recursive: true });

    runner.enqueue({ stdout: "", stderr: "", exitCode: 0 });

    await createBackup({
      fs,
      runner,
      clock,
      configDir: "/config",
      dataDir: "/data",
      outputDir: "/backups",
    });

    expect(await fs.exists("/backups")).toBe(true);
  });

  it("returns failure when tar exits non-zero", async () => {
    const fs = new InMemoryFileSystem();
    const runner = new InMemoryProcessRunner();
    const clock = new FixedClock(new Date("2025-06-15T10:00:00.000Z"));

    await fs.mkdir("/config", { recursive: true });
    await fs.mkdir("/data", { recursive: true });

    runner.enqueue({ stdout: "", stderr: "tar: error", exitCode: 1 });

    const result = await createBackup({
      fs,
      runner,
      clock,
      configDir: "/config",
      dataDir: "/data",
      outputDir: "/backups",
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain("tar: error");
  });

  it("uses clock timestamp in filename", async () => {
    const fs = new InMemoryFileSystem();
    const runner = new InMemoryProcessRunner();
    const clock = new FixedClock(new Date("2025-12-25T14:30:00.000Z"));

    await fs.mkdir("/config", { recursive: true });
    await fs.mkdir("/data", { recursive: true });

    runner.enqueue({ stdout: "", stderr: "", exitCode: 0 });

    const result = await createBackup({
      fs,
      runner,
      clock,
      configDir: "/config",
      dataDir: "/data",
      outputDir: "/backups",
    });

    expect(result.outputPath).toContain("2025-12-25T");
  });

  it("skips missing directories", async () => {
    const fs = new InMemoryFileSystem();
    const runner = new InMemoryProcessRunner();
    const clock = new FixedClock(new Date("2025-06-15T10:00:00.000Z"));

    // Only config exists, data dir missing
    await fs.mkdir("/config", { recursive: true });

    runner.enqueue({ stdout: "", stderr: "", exitCode: 0 });

    const result = await createBackup({
      fs,
      runner,
      clock,
      configDir: "/config",
      dataDir: "/nonexistent",
      outputDir: "/backups",
    });

    expect(result.success).toBe(true);
    const calls = runner.getCalls();
    expect(calls[0].args).toContain("/config");
    expect(calls[0].args).not.toContain("/nonexistent");
  });

  it("returns failure when no directories exist", async () => {
    const fs = new InMemoryFileSystem();
    const runner = new InMemoryProcessRunner();
    const clock = new FixedClock(new Date("2025-06-15T10:00:00.000Z"));

    const result = await createBackup({
      fs,
      runner,
      clock,
      configDir: "/nope1",
      dataDir: "/nope2",
      outputDir: "/backups",
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain("No directories");
    expect(runner.getCalls()).toHaveLength(0);
  });
});
