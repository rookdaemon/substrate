import { createBackup, createRemoteBackup, restoreBackup, findLatestBackup } from "../src/backup";
import { InMemoryFileSystem } from "../src/substrate/abstractions/InMemoryFileSystem";
import { InMemoryProcessRunner } from "../src/agents/claude/InMemoryProcessRunner";
import { FixedClock } from "../src/substrate/abstractions/FixedClock";

describe("createBackup", () => {
  it("runs tar with relative paths from substrate dir", async () => {
    const fs = new InMemoryFileSystem();
    const runner = new InMemoryProcessRunner();
    const clock = new FixedClock(new Date("2025-06-15T10:00:00.000Z"));

    await fs.mkdir("/data/substrate", { recursive: true });

    runner.enqueue({ stdout: "", stderr: "", exitCode: 0 });

    const result = await createBackup({
      fs,
      runner,
      clock,
      substratePath: "/data/substrate",
      outputDir: "/backups",
    });

    expect(result.success).toBe(true);
    expect(result.outputPath).toMatch(/substrate-backup-2025-06-15T.*\.tar\.gz$/);

    const calls = runner.getCalls();
    expect(calls).toHaveLength(1);
    expect(calls[0].command).toBe("tar");
    expect(calls[0].args).toContain("-czf");
    // Uses -C for relative paths (portable)
    expect(calls[0].args).toContain("-C");
    expect(calls[0].args).toContain("/data/substrate");
    expect(calls[0].args).toContain(".");
  });

  it("creates output directory if it does not exist", async () => {
    const fs = new InMemoryFileSystem();
    const runner = new InMemoryProcessRunner();
    const clock = new FixedClock(new Date("2025-06-15T10:00:00.000Z"));

    await fs.mkdir("/data/substrate", { recursive: true });

    runner.enqueue({ stdout: "", stderr: "", exitCode: 0 });

    await createBackup({
      fs,
      runner,
      clock,
      substratePath: "/data/substrate",
      outputDir: "/backups",
    });

    expect(await fs.exists("/backups")).toBe(true);
  });

  it("returns failure when tar exits non-zero", async () => {
    const fs = new InMemoryFileSystem();
    const runner = new InMemoryProcessRunner();
    const clock = new FixedClock(new Date("2025-06-15T10:00:00.000Z"));

    await fs.mkdir("/data/substrate", { recursive: true });

    runner.enqueue({ stdout: "", stderr: "tar: error", exitCode: 1 });

    const result = await createBackup({
      fs,
      runner,
      clock,
      substratePath: "/data/substrate",
      outputDir: "/backups",
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain("tar: error");
  });

  it("uses clock timestamp in filename", async () => {
    const fs = new InMemoryFileSystem();
    const runner = new InMemoryProcessRunner();
    const clock = new FixedClock(new Date("2025-12-25T14:30:00.000Z"));

    await fs.mkdir("/data/substrate", { recursive: true });

    runner.enqueue({ stdout: "", stderr: "", exitCode: 0 });

    const result = await createBackup({
      fs,
      runner,
      clock,
      substratePath: "/data/substrate",
      outputDir: "/backups",
    });

    expect(result.outputPath).toContain("2025-12-25T");
  });

  it("returns failure when substrate directory does not exist", async () => {
    const fs = new InMemoryFileSystem();
    const runner = new InMemoryProcessRunner();
    const clock = new FixedClock(new Date("2025-06-15T10:00:00.000Z"));

    const result = await createBackup({
      fs,
      runner,
      clock,
      substratePath: "/nonexistent/substrate",
      outputDir: "/backups",
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain("Substrate directory not found");
    expect(runner.getCalls()).toHaveLength(0);
  });
});

describe("createRemoteBackup", () => {
  it("rsyncs remote substrate then tars locally", async () => {
    const fs = new InMemoryFileSystem();
    const runner = new InMemoryProcessRunner();
    const clock = new FixedClock(new Date("2025-06-15T10:00:00.000Z"));

    // rsync succeeds, tar succeeds, cleanup succeeds
    runner.enqueue({ stdout: "", stderr: "", exitCode: 0 });
    runner.enqueue({ stdout: "", stderr: "", exitCode: 0 });
    runner.enqueue({ stdout: "", stderr: "", exitCode: 0 });

    const result = await createRemoteBackup({
      fs,
      runner,
      clock,
      remoteSource: "user@host:.local/share/substrate",
      outputDir: "/backups",
    });

    expect(result.success).toBe(true);
    expect(result.outputPath).toMatch(/substrate-backup-.*\.tar\.gz$/);

    const calls = runner.getCalls();
    // 1: rsync, 2: tar, 3: rm cleanup
    expect(calls).toHaveLength(3);
    expect(calls[0].command).toBe("rsync");
    expect(calls[0].args).toContain("user@host:.local/share/substrate/");
    expect(calls[1].command).toBe("tar");
    expect(calls[1].args).toContain("-czf");
    expect(calls[2].command).toBe("rm");
  });

  it("passes SSH identity to rsync", async () => {
    const fs = new InMemoryFileSystem();
    const runner = new InMemoryProcessRunner();
    const clock = new FixedClock(new Date("2025-06-15T10:00:00.000Z"));

    runner.enqueue({ stdout: "", stderr: "", exitCode: 0 });
    runner.enqueue({ stdout: "", stderr: "", exitCode: 0 });
    runner.enqueue({ stdout: "", stderr: "", exitCode: 0 });

    await createRemoteBackup({
      fs,
      runner,
      clock,
      remoteSource: "user@host:.local/share/substrate",
      outputDir: "/backups",
      identity: "~/.ssh/my_key",
    });

    const calls = runner.getCalls();
    expect(calls[0].args).toContain("-e");
    expect(calls[0].args).toContain("ssh -i ~/.ssh/my_key");
  });

  it("returns failure when rsync fails", async () => {
    const fs = new InMemoryFileSystem();
    const runner = new InMemoryProcessRunner();
    const clock = new FixedClock(new Date("2025-06-15T10:00:00.000Z"));

    runner.enqueue({ stdout: "", stderr: "rsync: connection refused", exitCode: 1 });
    runner.enqueue({ stdout: "", stderr: "", exitCode: 0 }); // cleanup

    const result = await createRemoteBackup({
      fs,
      runner,
      clock,
      remoteSource: "user@host:substrate",
      outputDir: "/backups",
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain("rsync: connection refused");
  });

  it("returns failure when tar fails", async () => {
    const fs = new InMemoryFileSystem();
    const runner = new InMemoryProcessRunner();
    const clock = new FixedClock(new Date("2025-06-15T10:00:00.000Z"));

    runner.enqueue({ stdout: "", stderr: "", exitCode: 0 }); // rsync OK
    runner.enqueue({ stdout: "", stderr: "tar: error", exitCode: 1 }); // tar fails
    runner.enqueue({ stdout: "", stderr: "", exitCode: 0 }); // cleanup

    const result = await createRemoteBackup({
      fs,
      runner,
      clock,
      remoteSource: "user@host:substrate",
      outputDir: "/backups",
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain("tar: error");
  });

  it("cleans up temp dir even on failure", async () => {
    const fs = new InMemoryFileSystem();
    const runner = new InMemoryProcessRunner();
    const clock = new FixedClock(new Date("2025-06-15T10:00:00.000Z"));

    runner.enqueue({ stdout: "", stderr: "fail", exitCode: 1 }); // rsync fails
    runner.enqueue({ stdout: "", stderr: "", exitCode: 0 }); // cleanup still runs

    await createRemoteBackup({
      fs,
      runner,
      clock,
      remoteSource: "user@host:substrate",
      outputDir: "/backups",
    });

    const calls = runner.getCalls();
    const rmCall = calls.find((c) => c.command === "rm");
    expect(rmCall).toBeDefined();
    expect(rmCall!.args).toContain("-rf");
  });
});

describe("restoreBackup", () => {
  it("extracts archive to target substrate directory", async () => {
    const fs = new InMemoryFileSystem();
    const runner = new InMemoryProcessRunner();

    await fs.mkdir("/backups", { recursive: true });
    await fs.writeFile("/backups/backup.tar.gz", "fake-archive");

    runner.enqueue({ stdout: "", stderr: "", exitCode: 0 });

    const result = await restoreBackup({
      fs,
      runner,
      substratePath: "/target/substrate",
      inputPath: "/backups/backup.tar.gz",
    });

    expect(result.success).toBe(true);
    expect(result.restoredFrom).toBe("/backups/backup.tar.gz");

    const calls = runner.getCalls();
    expect(calls).toHaveLength(1);
    expect(calls[0].command).toBe("tar");
    expect(calls[0].args).toContain("-xzf");
    expect(calls[0].args).toContain("-C");
    expect(calls[0].args).toContain("/target/substrate");
  });

  it("creates target substrate directory if missing", async () => {
    const fs = new InMemoryFileSystem();
    const runner = new InMemoryProcessRunner();

    await fs.mkdir("/backups", { recursive: true });
    await fs.writeFile("/backups/backup.tar.gz", "fake-archive");

    runner.enqueue({ stdout: "", stderr: "", exitCode: 0 });

    await restoreBackup({
      fs,
      runner,
      substratePath: "/new/substrate",
      inputPath: "/backups/backup.tar.gz",
    });

    expect(await fs.exists("/new/substrate")).toBe(true);
  });

  it("returns failure when archive does not exist", async () => {
    const fs = new InMemoryFileSystem();
    const runner = new InMemoryProcessRunner();

    const result = await restoreBackup({
      fs,
      runner,
      substratePath: "/target/substrate",
      inputPath: "/missing/backup.tar.gz",
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain("Backup file not found");
  });

  it("returns failure when no backup specified and none found", async () => {
    const fs = new InMemoryFileSystem();
    const runner = new InMemoryProcessRunner();

    const result = await restoreBackup({
      fs,
      runner,
      substratePath: "/target/substrate",
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain("No backup file specified");
  });

  it("returns failure when tar exits non-zero", async () => {
    const fs = new InMemoryFileSystem();
    const runner = new InMemoryProcessRunner();

    await fs.mkdir("/backups", { recursive: true });
    await fs.writeFile("/backups/backup.tar.gz", "fake-archive");

    runner.enqueue({ stdout: "", stderr: "tar: corrupt archive", exitCode: 1 });

    const result = await restoreBackup({
      fs,
      runner,
      substratePath: "/target/substrate",
      inputPath: "/backups/backup.tar.gz",
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain("tar: corrupt archive");
    expect(result.restoredFrom).toBe("/backups/backup.tar.gz");
  });

  it("auto-finds latest backup when no inputPath given", async () => {
    const fs = new InMemoryFileSystem();
    const runner = new InMemoryProcessRunner();

    await fs.mkdir("/backups", { recursive: true });
    await fs.writeFile("/backups/substrate-backup-2025-01-01T00-00-00.000Z.tar.gz", "old");
    await fs.writeFile("/backups/substrate-backup-2025-06-15T10-00-00.000Z.tar.gz", "new");

    runner.enqueue({ stdout: "", stderr: "", exitCode: 0 });

    const result = await restoreBackup({
      fs,
      runner,
      substratePath: "/target/substrate",
      backupDir: "/backups",
    });

    expect(result.success).toBe(true);
    expect(result.restoredFrom).toContain("2025-06-15");
  });
});

describe("findLatestBackup", () => {
  it("returns null when backup dir does not exist", async () => {
    const fs = new InMemoryFileSystem();

    const result = await findLatestBackup(fs, "/nonexistent");

    expect(result).toBeNull();
  });

  it("returns null when no backup files exist", async () => {
    const fs = new InMemoryFileSystem();
    await fs.mkdir("/backups", { recursive: true });
    await fs.writeFile("/backups/random.txt", "not a backup");

    const result = await findLatestBackup(fs, "/backups");

    expect(result).toBeNull();
  });

  it("returns the latest backup by sorted name", async () => {
    const fs = new InMemoryFileSystem();
    await fs.mkdir("/backups", { recursive: true });
    await fs.writeFile("/backups/substrate-backup-2025-01-01T00-00-00.000Z.tar.gz", "old");
    await fs.writeFile("/backups/substrate-backup-2025-06-15T10-00-00.000Z.tar.gz", "new");
    await fs.writeFile("/backups/substrate-backup-2025-03-10T05-30-00.000Z.tar.gz", "mid");

    const result = await findLatestBackup(fs, "/backups");

    expect(result).toContain("2025-06-15");
  });
});
