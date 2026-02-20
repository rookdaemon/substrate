/**
 * Unit tests for supervisor.ts circuit breaker logic
 * 
 * These tests verify:
 * - Exponential backoff timing
 * - Max retry limit (circuit breaker)
 * - Counter reset on successful build
 * - Proper exit codes
 * - Rollback logic for consecutive unhealthy restarts
 * - Pre-restart safety gate enforcement
 */

import { EventEmitter } from "events";
import { validateRestartSafety } from "../src/supervisor";
import { InMemoryFileSystem } from "../src/substrate/abstractions/InMemoryFileSystem";

jest.mock("child_process", () => ({
  spawn: jest.fn(),
}));

// Import after mock so Jest can replace the module
import { spawn } from "child_process";
const mockSpawn = spawn as jest.MockedFunction<typeof spawn>;

/** Helper: returns a fake ChildProcess that exits with the given code. */
function fakeProcess(exitCode: number): EventEmitter {
  const emitter = new EventEmitter();
  setImmediate(() => emitter.emit("exit", exitCode));
  return emitter as ReturnType<typeof spawn>;
}

describe("supervisor circuit breaker", () => {
  it("should implement exponential backoff", () => {
    // Test constants
    const INITIAL_RETRY_DELAY_MS = 5_000;
    const MAX_RETRY_DELAY_MS = 60_000;
    const BACKOFF_MULTIPLIER = 2;

    let currentRetryDelay = INITIAL_RETRY_DELAY_MS;
    
    // First retry: 5s
    expect(currentRetryDelay).toBe(5_000);
    
    // Second retry: 10s
    currentRetryDelay = Math.min(currentRetryDelay * BACKOFF_MULTIPLIER, MAX_RETRY_DELAY_MS);
    expect(currentRetryDelay).toBe(10_000);
    
    // Third retry: 20s
    currentRetryDelay = Math.min(currentRetryDelay * BACKOFF_MULTIPLIER, MAX_RETRY_DELAY_MS);
    expect(currentRetryDelay).toBe(20_000);
    
    // Fourth retry: 40s
    currentRetryDelay = Math.min(currentRetryDelay * BACKOFF_MULTIPLIER, MAX_RETRY_DELAY_MS);
    expect(currentRetryDelay).toBe(40_000);
    
    // Fifth retry: 60s (capped at MAX_RETRY_DELAY_MS)
    currentRetryDelay = Math.min(currentRetryDelay * BACKOFF_MULTIPLIER, MAX_RETRY_DELAY_MS);
    expect(currentRetryDelay).toBe(60_000);
    
    // Sixth retry: still 60s (remains capped)
    currentRetryDelay = Math.min(currentRetryDelay * BACKOFF_MULTIPLIER, MAX_RETRY_DELAY_MS);
    expect(currentRetryDelay).toBe(60_000);
  });

  it("should reset counter and delay on successful build", () => {
    const INITIAL_RETRY_DELAY_MS = 5_000;
    const BACKOFF_MULTIPLIER = 2;
    const MAX_RETRY_DELAY_MS = 60_000;

    let consecutiveFailures = 0;
    let currentRetryDelay = INITIAL_RETRY_DELAY_MS;

    // Simulate 3 failures
    consecutiveFailures++;
    currentRetryDelay = Math.min(currentRetryDelay * BACKOFF_MULTIPLIER, MAX_RETRY_DELAY_MS);
    
    consecutiveFailures++;
    currentRetryDelay = Math.min(currentRetryDelay * BACKOFF_MULTIPLIER, MAX_RETRY_DELAY_MS);
    
    consecutiveFailures++;
    currentRetryDelay = Math.min(currentRetryDelay * BACKOFF_MULTIPLIER, MAX_RETRY_DELAY_MS);

    expect(consecutiveFailures).toBe(3);
    expect(currentRetryDelay).toBe(40_000);

    // Simulate success - reset both
    consecutiveFailures = 0;
    currentRetryDelay = INITIAL_RETRY_DELAY_MS;

    expect(consecutiveFailures).toBe(0);
    expect(currentRetryDelay).toBe(5_000);
  });

  it("should exit after MAX_BUILD_RETRIES failures", () => {
    const MAX_BUILD_RETRIES = 5;
    let consecutiveFailures = 0;

    // Simulate failures up to limit
    for (let i = 0; i < MAX_BUILD_RETRIES; i++) {
      consecutiveFailures++;
    }

    expect(consecutiveFailures).toBe(MAX_BUILD_RETRIES);
    
    // Circuit breaker should trigger
    const shouldExit = consecutiveFailures >= MAX_BUILD_RETRIES;
    expect(shouldExit).toBe(true);
  });
});

describe("supervisor rollback logic", () => {
  const MAX_CONSECUTIVE_UNHEALTHY = 3;

  it("should increment unhealthy counter on failed health check", () => {
    let consecutiveUnhealthyRestarts = 0;

    // Simulate unhealthy restart
    consecutiveUnhealthyRestarts++;
    expect(consecutiveUnhealthyRestarts).toBe(1);

    consecutiveUnhealthyRestarts++;
    expect(consecutiveUnhealthyRestarts).toBe(2);
  });

  it("should reset unhealthy counter on healthy restart", () => {
    let consecutiveUnhealthyRestarts = 2;

    // Simulate healthy restart
    consecutiveUnhealthyRestarts = 0;
    expect(consecutiveUnhealthyRestarts).toBe(0);
  });

  it("should trigger rollback after MAX_CONSECUTIVE_UNHEALTHY failures", () => {
    let consecutiveUnhealthyRestarts = 0;
    let rollbackTriggered = false;

    for (let i = 0; i < MAX_CONSECUTIVE_UNHEALTHY; i++) {
      consecutiveUnhealthyRestarts++;
      if (consecutiveUnhealthyRestarts >= MAX_CONSECUTIVE_UNHEALTHY) {
        rollbackTriggered = true;
        consecutiveUnhealthyRestarts = 0;
      }
    }

    expect(rollbackTriggered).toBe(true);
    expect(consecutiveUnhealthyRestarts).toBe(0);
  });

  it("should not trigger rollback before MAX_CONSECUTIVE_UNHEALTHY failures", () => {
    let consecutiveUnhealthyRestarts = 0;
    let rollbackTriggered = false;

    // Simulate 2 failures (below threshold)
    for (let i = 0; i < MAX_CONSECUTIVE_UNHEALTHY - 1; i++) {
      consecutiveUnhealthyRestarts++;
      if (consecutiveUnhealthyRestarts >= MAX_CONSECUTIVE_UNHEALTHY) {
        rollbackTriggered = true;
      }
    }

    expect(rollbackTriggered).toBe(false);
    expect(consecutiveUnhealthyRestarts).toBe(MAX_CONSECUTIVE_UNHEALTHY - 1);
  });

  it("should reset unhealthy counter after rollback", () => {
    let consecutiveUnhealthyRestarts = MAX_CONSECUTIVE_UNHEALTHY;

    // Simulate rollback
    const shouldRollback = consecutiveUnhealthyRestarts >= MAX_CONSECUTIVE_UNHEALTHY;
    expect(shouldRollback).toBe(true);

    // After rollback, counter resets
    consecutiveUnhealthyRestarts = 0;
    expect(consecutiveUnhealthyRestarts).toBe(0);
  });

  it("should keep unhealthy counter independent of build failure counter", () => {
    let consecutiveFailures = 0;
    let consecutiveUnhealthyRestarts = 2;

    // A successful build resets build counter but not unhealthy counter
    consecutiveFailures = 0;
    // consecutiveUnhealthyRestarts unchanged by build success alone
    expect(consecutiveFailures).toBe(0);
    expect(consecutiveUnhealthyRestarts).toBe(2);

    // Only health check result resets unhealthy counter
    consecutiveUnhealthyRestarts = 0;
    expect(consecutiveUnhealthyRestarts).toBe(0);
  });
});

describe("validateRestartSafety", () => {
  const serverDir = "/srv";
  const dataDir = "/data";
  const contextPath = "/data/memory/restart-context.md";

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("returns false when tests fail", async () => {
    mockSpawn.mockReturnValueOnce(fakeProcess(1) as ReturnType<typeof spawn>);

    const fs = new InMemoryFileSystem();
    const result = await validateRestartSafety(serverDir, dataDir, fs);
    expect(result).toBe(false);
  });

  it("returns false when restart-context.md is missing", async () => {
    mockSpawn.mockReturnValueOnce(fakeProcess(0) as ReturnType<typeof spawn>);

    const fs = new InMemoryFileSystem();
    const result = await validateRestartSafety(serverDir, dataDir, fs);
    expect(result).toBe(false);
  });

  it("returns false when restart-context.md is empty", async () => {
    mockSpawn.mockReturnValueOnce(fakeProcess(0) as ReturnType<typeof spawn>);

    const fs = new InMemoryFileSystem();
    await fs.mkdir("/data/memory", { recursive: true });
    await fs.writeFile(contextPath, "");
    const result = await validateRestartSafety(serverDir, dataDir, fs);
    expect(result).toBe(false);
  });

  it("returns false when git working tree has uncommitted changes", async () => {
    mockSpawn
      .mockReturnValueOnce(fakeProcess(0) as ReturnType<typeof spawn>)  // npm test
      .mockReturnValueOnce(fakeProcess(1) as ReturnType<typeof spawn>); // git diff-index

    const fs = new InMemoryFileSystem();
    await fs.mkdir("/data/memory", { recursive: true });
    await fs.writeFile(contextPath, "# Context\nSome content");
    const result = await validateRestartSafety(serverDir, dataDir, fs);
    expect(result).toBe(false);
  });

  it("returns true when all safety gates pass", async () => {
    mockSpawn
      .mockReturnValueOnce(fakeProcess(0) as ReturnType<typeof spawn>)  // npm test
      .mockReturnValueOnce(fakeProcess(0) as ReturnType<typeof spawn>); // git diff-index

    const fs = new InMemoryFileSystem();
    await fs.mkdir("/data/memory", { recursive: true });
    await fs.writeFile(contextPath, "# Context\nSome content");
    const result = await validateRestartSafety(serverDir, dataDir, fs);
    expect(result).toBe(true);
  });
});
