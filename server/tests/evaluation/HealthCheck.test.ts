import { HealthCheck } from "../../src/evaluation/HealthCheck";
import { InferenceLivenessTracker } from "../../src/evaluation/InferenceLivenessTracker";
import { InMemoryFileSystem } from "../../src/substrate/abstractions/InMemoryFileSystem";
import { SubstrateConfig } from "../../src/substrate/config";
import { SubstrateFileReader } from "../../src/substrate/io/FileReader";

describe("HealthCheck", () => {
  let fs: InMemoryFileSystem;
  let reader: SubstrateFileReader;
  let healthCheck: HealthCheck;

  beforeEach(async () => {
    fs = new InMemoryFileSystem();
    const config = new SubstrateConfig("/substrate");
    reader = new SubstrateFileReader(fs, config);
    healthCheck = new HealthCheck(reader);

    await fs.mkdir("/substrate", { recursive: true });
  });

  async function writeHealthySubstrate(): Promise<void> {
    await fs.writeFile("/substrate/PLAN.md", "# Plan\n\n## Current Goal\nBuild authentication system\n\n## Tasks\n- [ ] Task A\n- [ ] Task B");
    await fs.writeFile("/substrate/VALUES.md", "# Values\n\nBe good");
    await fs.writeFile("/substrate/SECURITY.md", "# Security\n\n## Constraints\nStay safe");
    await fs.writeFile("/substrate/CHARTER.md", "# Charter\n\nOur mission");
    await fs.writeFile("/substrate/MEMORY.md", "# Memory\n\nWe are building an authentication system");
    await fs.writeFile("/substrate/SKILLS.md", "# Skills\n\nKnown: authentication, TypeScript");
  }

  it("returns healthy result when all files are well-formed", async () => {
    await writeHealthySubstrate();

    const result = await healthCheck.run();

    expect(result.overall).toBe("healthy");
    expect(result.drift.score).toBeLessThanOrEqual(0.3);
    expect(result.security.compliant).toBe(true);
    expect(result.planQuality.score).toBeGreaterThanOrEqual(0.5);
  });

  it("returns unhealthy when files have issues", async () => {
    // No files at all
    const result = await healthCheck.run();

    expect(result.overall).toBe("unhealthy");
  });

  it("includes all analyzer results", async () => {
    await fs.writeFile("/substrate/PLAN.md", "# Plan\n\n## Current Goal\nBuild\n\n## Tasks\n- [ ] A\n- [ ] B");
    await fs.writeFile("/substrate/VALUES.md", "# Values\n\nGood");
    await fs.writeFile("/substrate/SECURITY.md", "# Security\n\n## Constraints\nSafe");
    await fs.writeFile("/substrate/CHARTER.md", "# Charter\n\nMission");
    await fs.writeFile("/substrate/MEMORY.md", "# Memory\n\nFacts about building");
    await fs.writeFile("/substrate/SKILLS.md", "# Skills\n\nKnown: building, TypeScript");

    const result = await healthCheck.run();

    expect(result).toHaveProperty("drift");
    expect(result).toHaveProperty("consistency");
    expect(result).toHaveProperty("security");
    expect(result).toHaveProperty("planQuality");
    expect(result).toHaveProperty("reasoning");
    expect(result).toHaveProperty("overall");
  });

  it("reports no observed inference signal as unknown and prevents healthy full status", async () => {
    await writeHealthySubstrate();
    const livenessTracker = new InferenceLivenessTracker();
    healthCheck = new HealthCheck(reader, null, fs, "/substrate", livenessTracker);

    const fullResult = await healthCheck.run();
    const criticalResult = await healthCheck.runCriticalChecks();

    expect(fullResult.overall).toBe("degraded");
    expect(fullResult.inference).toEqual(expect.objectContaining({
      observed: false,
      alive: false,
      consecutiveFailures: 0,
    }));
    expect(criticalResult.inferenceAlive).toBe("unknown");
    expect(criticalResult.healthy).toBe(true);
    expect(healthCheck.runtimeSignalsHealthy()).toBe(false);
  });

  it("marks health unhealthy when persisted inference failures are above threshold", async () => {
    await writeHealthySubstrate();
    const livenessTracker = new InferenceLivenessTracker();
    livenessTracker.recordFailure("HTTP 401");
    livenessTracker.recordFailure("HTTP 401");
    livenessTracker.recordFailure("HTTP 401");
    healthCheck = new HealthCheck(reader, null, fs, "/substrate", livenessTracker);

    const fullResult = await healthCheck.run();
    const criticalResult = await healthCheck.runCriticalChecks();

    expect(fullResult.overall).toBe("unhealthy");
    expect(fullResult.inference).toEqual(expect.objectContaining({
      observed: true,
      alive: false,
      consecutiveFailures: 3,
      lastError: "HTTP 401",
    }));
    expect(criticalResult.inferenceAlive).toBe("degraded");
    expect(criticalResult.healthy).toBe(false);
  });
});
