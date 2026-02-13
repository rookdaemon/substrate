import { transfer, resolveRemotePath, resolveRemoteConfigPath, extractHost } from "../src/transfer";
import { InMemoryProcessRunner } from "../src/agents/claude/InMemoryProcessRunner";

describe("transfer", () => {
  it("rsyncs substrate from source to destination", async () => {
    const runner = new InMemoryProcessRunner();
    runner.enqueue({ stdout: "", stderr: "", exitCode: 0 });

    const result = await transfer({
      runner,
      sourceSubstrate: "/space-a/substrate",
      destSubstrate: "/space-b/substrate",
    });

    expect(result.success).toBe(true);

    const calls = runner.getCalls();
    expect(calls).toHaveLength(1);
    expect(calls[0].command).toBe("rsync");
    expect(calls[0].args).toContain("-a");
    // Trailing slash on source = "contents of", not "the dir itself"
    expect(calls[0].args).toContain("/space-a/substrate/");
    expect(calls[0].args).toContain("/space-b/substrate/");
  });

  it("also rsyncs config when both config paths provided", async () => {
    const runner = new InMemoryProcessRunner();
    runner.enqueue({ stdout: "", stderr: "", exitCode: 0 });
    runner.enqueue({ stdout: "", stderr: "", exitCode: 0 });

    const result = await transfer({
      runner,
      sourceSubstrate: "/space-a/substrate",
      destSubstrate: "/space-b/substrate",
      sourceConfig: "/space-a/config",
      destConfig: "/space-b/config",
    });

    expect(result.success).toBe(true);

    const calls = runner.getCalls();
    expect(calls).toHaveLength(2);
    // First call: substrate
    expect(calls[0].args).toContain("/space-a/substrate/");
    expect(calls[0].args).toContain("/space-b/substrate/");
    // Second call: config
    expect(calls[1].args).toContain("/space-a/config/");
    expect(calls[1].args).toContain("/space-b/config/");
  });

  it("skips config rsync when config paths not provided", async () => {
    const runner = new InMemoryProcessRunner();
    runner.enqueue({ stdout: "", stderr: "", exitCode: 0 });

    await transfer({
      runner,
      sourceSubstrate: "/space-a/substrate",
      destSubstrate: "/space-b/substrate",
    });

    expect(runner.getCalls()).toHaveLength(1);
  });

  it("returns failure when substrate rsync fails", async () => {
    const runner = new InMemoryProcessRunner();
    runner.enqueue({ stdout: "", stderr: "rsync: connection refused", exitCode: 1 });

    const result = await transfer({
      runner,
      sourceSubstrate: "/space-a/substrate",
      destSubstrate: "/space-b/substrate",
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain("rsync: connection refused");
  });

  it("returns failure when config rsync fails", async () => {
    const runner = new InMemoryProcessRunner();
    runner.enqueue({ stdout: "", stderr: "", exitCode: 0 }); // substrate OK
    runner.enqueue({ stdout: "", stderr: "rsync: permission denied", exitCode: 1 }); // config fails

    const result = await transfer({
      runner,
      sourceSubstrate: "/space-a/substrate",
      destSubstrate: "/space-b/substrate",
      sourceConfig: "/space-a/config",
      destConfig: "/space-b/config",
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain("rsync: permission denied");
  });

  it("does not use --delete flag (additive sync)", async () => {
    const runner = new InMemoryProcessRunner();
    runner.enqueue({ stdout: "", stderr: "", exitCode: 0 });

    await transfer({
      runner,
      sourceSubstrate: "/space-a/substrate",
      destSubstrate: "/space-b/substrate",
    });

    const calls = runner.getCalls();
    expect(calls[0].args).not.toContain("--delete");
  });

  it("includes --mkpath to create destination directories", async () => {
    const runner = new InMemoryProcessRunner();
    runner.enqueue({ stdout: "", stderr: "", exitCode: 0 });

    await transfer({
      runner,
      sourceSubstrate: "/space-a/substrate",
      destSubstrate: "/space-b/substrate",
    });

    const calls = runner.getCalls();
    expect(calls[0].args).toContain("--mkpath");
  });

  it("passes SSH identity via -e flag when provided", async () => {
    const runner = new InMemoryProcessRunner();
    runner.enqueue({ stdout: "", stderr: "", exitCode: 0 });

    await transfer({
      runner,
      sourceSubstrate: "/local/substrate",
      destSubstrate: "user@34.63.182.98:.local/share/substrate",
      identity: "~/.ssh/google_compute_engine",
    });

    const calls = runner.getCalls();
    expect(calls[0].args).toContain("-e");
    expect(calls[0].args).toContain("ssh -i ~/.ssh/google_compute_engine");
  });

  it("omits -e flag when no identity provided", async () => {
    const runner = new InMemoryProcessRunner();
    runner.enqueue({ stdout: "", stderr: "", exitCode: 0 });

    await transfer({
      runner,
      sourceSubstrate: "/space-a/substrate",
      destSubstrate: "/space-b/substrate",
    });

    const calls = runner.getCalls();
    expect(calls[0].args).not.toContain("-e");
  });

  it("passes identity to config rsync too", async () => {
    const runner = new InMemoryProcessRunner();
    runner.enqueue({ stdout: "", stderr: "", exitCode: 0 });
    runner.enqueue({ stdout: "", stderr: "", exitCode: 0 });

    await transfer({
      runner,
      sourceSubstrate: "/local/substrate",
      destSubstrate: "user@host:.local/share/substrate",
      sourceConfig: "/local/config",
      destConfig: "user@host:.config/substrate",
      identity: "/keys/id_rsa",
    });

    const calls = runner.getCalls();
    expect(calls[0].args).toContain("ssh -i /keys/id_rsa");
    expect(calls[1].args).toContain("ssh -i /keys/id_rsa");
  });
});

describe("resolveRemotePath", () => {
  it("returns local path unchanged", () => {
    expect(resolveRemotePath("/local/path")).toBe("/local/path");
  });

  it("returns user@host:path unchanged", () => {
    expect(resolveRemotePath("user@host:/custom/substrate")).toBe("user@host:/custom/substrate");
  });

  it("appends default substrate path when user@host has no path", () => {
    expect(resolveRemotePath("user@34.63.182.98")).toBe(
      "user@34.63.182.98:.local/share/substrate"
    );
  });

  it("handles hostnames with dots", () => {
    expect(resolveRemotePath("user@my.server.com")).toBe(
      "user@my.server.com:.local/share/substrate"
    );
  });
});

describe("resolveRemoteConfigPath", () => {
  it("returns null for local path", () => {
    expect(resolveRemoteConfigPath("/local/path")).toBeNull();
  });

  it("appends default config path for user@host", () => {
    expect(resolveRemoteConfigPath("user@34.63.182.98")).toBe(
      "user@34.63.182.98:.config/substrate"
    );
  });

  it("appends default config path even when dest has explicit substrate path", () => {
    expect(resolveRemoteConfigPath("user@host:/custom/substrate")).toBe(
      "user@host:.config/substrate"
    );
  });
});

describe("extractHost", () => {
  it("returns null for local path", () => {
    expect(extractHost("/local/path")).toBeNull();
  });

  it("extracts user@host from user@host", () => {
    expect(extractHost("user@34.63.182.98")).toBe("user@34.63.182.98");
  });

  it("extracts user@host from user@host:path", () => {
    expect(extractHost("user@host:/custom/path")).toBe("user@host");
  });
});
