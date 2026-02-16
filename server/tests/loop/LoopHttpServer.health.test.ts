import { LoopHttpServer } from "../../src/loop/LoopHttpServer";
import { LoopOrchestrator } from "../../src/loop/LoopOrchestrator";
import { ConversationManager, ConversationArchiveConfig } from "../../src/conversation/ConversationManager";
import { IConversationCompactor } from "../../src/conversation/IConversationCompactor";
import { IConversationArchiver } from "../../src/conversation/IConversationArchiver";
import { InMemoryFileSystem } from "../../src/substrate/abstractions/InMemoryFileSystem";
import { FixedClock } from "../../src/substrate/abstractions/FixedClock";
import { SubstrateConfig } from "../../src/substrate/config";
import { FileLock } from "../../src/substrate/io/FileLock";
import { AppendOnlyWriter } from "../../src/substrate/io/AppendOnlyWriter";
import { SubstrateFileReader } from "../../src/substrate/io/FileReader";
import { PermissionChecker } from "../../src/agents/permissions";
import { AgentRole } from "../../src/agents/types";
import { TaskClassificationMetrics } from "../../src/evaluation/TaskClassificationMetrics";
import { SubstrateSizeTracker } from "../../src/evaluation/SubstrateSizeTracker";
import { DelegationTracker } from "../../src/evaluation/DelegationTracker";
import * as http from "http";

// Mock compactor
class MockCompactor implements IConversationCompactor {
  async compact(_currentContent: string, _oneHourAgo: string): Promise<string> {
    return "# Conversation\n\nCompacted content\n\n";
  }
}

// Mock archiver
class MockArchiver implements IConversationArchiver {
  async archive(currentContent: string, linesToKeep: number): Promise<{
    archivedPath?: string;
    remainingContent: string;
    linesArchived: number;
  }> {
    const lines = currentContent.split('\n');
    const contentLines = lines.filter(l => l.trim().length > 0 && !l.startsWith('#'));
    const remaining = contentLines.slice(-linesToKeep).join('\n');
    
    return {
      archivedPath: "/test/substrate/archive/conversation/test.md",
      remainingContent: remaining,
      linesArchived: contentLines.length - linesToKeep,
    };
  }
}

describe("LoopHttpServer health endpoint", () => {
  let httpServer: LoopHttpServer;
  let orchestrator: LoopOrchestrator;
  let conversationManager: ConversationManager;
  let fs: InMemoryFileSystem;
  let clock: FixedClock;
  let config: SubstrateConfig;
  let lock: FileLock;
  let reader: SubstrateFileReader;
  let appendWriter: AppendOnlyWriter;
  let checker: PermissionChecker;
  let compactor: MockCompactor;
  let archiver: MockArchiver;
  let taskMetrics: TaskClassificationMetrics;
  let sizeTracker: SubstrateSizeTracker;
  let delegationTracker: DelegationTracker;

  beforeEach(async () => {
    fs = new InMemoryFileSystem();
    clock = new FixedClock(new Date("2025-01-01T12:00:00.000Z"));
    config = new SubstrateConfig("/test/substrate");
    lock = new FileLock();
    reader = new SubstrateFileReader(fs, config);
    appendWriter = new AppendOnlyWriter(fs, config, lock, clock);
    checker = new PermissionChecker();
    compactor = new MockCompactor();
    archiver = new MockArchiver();

    // Initialize required substrate files
    await fs.writeFile("/test/substrate/CONVERSATION.md", "# Conversation\n\n");
    await fs.writeFile("/test/substrate/PLAN.md", "# Plan\n\n");
    await fs.writeFile("/test/substrate/MEMORY.md", "# Memory\n\n");

    // Create metrics components
    taskMetrics = new TaskClassificationMetrics(fs, "/test/substrate/.metrics");
    sizeTracker = new SubstrateSizeTracker(fs, clock, "/test/substrate");
    delegationTracker = new DelegationTracker(fs, "/test/substrate/.metrics");

    // Create conversation manager (without archiving for simpler tests)
    conversationManager = new ConversationManager(
      reader, fs, config, lock, appendWriter, checker, compactor, clock
    );

    // Create a minimal mock orchestrator
    orchestrator = {
      getState: () => "idle",
      getMetrics: () => ({}),
    } as unknown as LoopOrchestrator;

    httpServer = new LoopHttpServer(orchestrator);
    httpServer.setOrchestrator(orchestrator);
    httpServer.setEventSink(
      {
        emit: () => {
          /* no-op for testing */
        },
      },
      clock
    );
    httpServer.setConversationManager(conversationManager);
    httpServer.setMetricsComponents(taskMetrics, sizeTracker, delegationTracker);
  });

  afterEach(async () => {
    try {
      await httpServer.close();
    } catch {
      // Server may already be closed
    }
  });

  it("should include lastCompaction field in health response", async () => {
    const port = await httpServer.listen(0);

    const response = await makeRequest(port, "/api/substrate/health");
    expect(response.statusCode).toBe(200);
    
    const body = JSON.parse(response.body);
    expect(body).toHaveProperty("lastCompaction");
  });

  it("should return null for lastCompaction when no maintenance has occurred", async () => {
    const port = await httpServer.listen(0);

    const response = await makeRequest(port, "/api/substrate/health");
    expect(response.statusCode).toBe(200);
    
    const body = JSON.parse(response.body);
    expect(body.lastCompaction).toBeNull();
  });

  it("should return ISO timestamp after compaction", async () => {
    // Perform a compaction
    await conversationManager.append(AgentRole.EGO, "Test message");
    const compactionTime = new Date("2025-01-01T13:00:00.000Z");
    clock.setNow(compactionTime);
    await conversationManager.forceCompaction(AgentRole.EGO);

    const port = await httpServer.listen(0);

    const response = await makeRequest(port, "/api/substrate/health");
    expect(response.statusCode).toBe(200);
    
    const body = JSON.parse(response.body);
    expect(body.lastCompaction).toBe("2025-01-01T13:00:00.000Z");
  });

  it("should return ISO timestamp after archive", async () => {
    // Create conversation manager with archiving
    const archiveConfig: ConversationArchiveConfig = {
      enabled: true,
      linesToKeep: 5,
      sizeThreshold: 100,
    };

    conversationManager = new ConversationManager(
      reader, fs, config, lock, appendWriter, checker, compactor, clock,
      archiver, archiveConfig
    );
    httpServer.setConversationManager(conversationManager);

    // Perform an archive
    await conversationManager.append(AgentRole.EGO, "Test message");
    const archiveTime = new Date("2025-01-01T14:00:00.000Z");
    clock.setNow(archiveTime);
    await conversationManager.forceArchive();

    const port = await httpServer.listen(0);

    const response = await makeRequest(port, "/api/substrate/health");
    expect(response.statusCode).toBe(200);
    
    const body = JSON.parse(response.body);
    expect(body.lastCompaction).toBe("2025-01-01T14:00:00.000Z");
  });

  it("should return null when conversationManager is not configured", async () => {
    // Create a fresh server without conversation manager for this test
    const freshServer = new LoopHttpServer(orchestrator);
    freshServer.setOrchestrator(orchestrator);
    freshServer.setEventSink(
      {
        emit: () => {
          /* no-op */
        },
      },
      clock
    );
    freshServer.setMetricsComponents(taskMetrics, sizeTracker, delegationTracker);
    // Note: NOT calling setConversationManager

    const port = await freshServer.listen(0);

    const response = await makeRequest(port, "/api/substrate/health");
    expect(response.statusCode).toBe(200);
    
    const body = JSON.parse(response.body);
    expect(body.lastCompaction).toBeNull();

    await freshServer.close();
  });
});

// Helper function to make HTTP requests
function makeRequest(port: number, path: string): Promise<{ statusCode: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        hostname: "127.0.0.1",
        port,
        path,
        method: "GET",
      },
      (res) => {
        let body = "";
        res.on("data", (chunk) => {
          body += chunk;
        });
        res.on("end", () => {
          resolve({ statusCode: res.statusCode ?? 500, body });
        });
      }
    );
    req.on("error", reject);
    req.end();
  });
}
