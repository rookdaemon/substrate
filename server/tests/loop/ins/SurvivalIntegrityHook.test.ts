import { createHash } from "node:crypto";
import { INSHook } from "../../../src/loop/ins/INSHook";
import { ComplianceStateManager } from "../../../src/loop/ins/ComplianceStateManager";
import { defaultINSConfig, INSConfig } from "../../../src/loop/ins/types";
import { InMemoryFileSystem } from "../../../src/substrate/abstractions/InMemoryFileSystem";
import { FixedClock } from "../../../src/substrate/abstractions/FixedClock";
import { SubstrateFileReader } from "../../../src/substrate/io/FileReader";
import { SubstrateConfig } from "../../../src/substrate/config";
import { InMemoryLogger } from "../../../src/logging";
import { SURVIVAL_PLAN_REFERENCE } from "../../../src/survival/SurvivalIntegrityChecker";

describe("INSHook survival integrity integration", () => {
  const substratePath = "/substrate";
  const canonicalContent = "# Survival Plan\n\nCanonical survival details.\n";
  const expectedCanonicalHash = createHash("sha256").update(canonicalContent).digest("hex");
  const canonicalFilePath = `${substratePath}/memory/SURVIVAL_PLAN_2026-04-30.md`;

  let fs: InMemoryFileSystem;
  let config: INSConfig;
  let hook: INSHook;

  function validPlan(): string {
    return [
      "# Plan",
      "",
      "## SURVIVAL MODE GOVERNANCE (highest priority — Stefan-gated, 2026-04-30)",
      "**Status:** ACTIVE. Overrides all conflicting plan items below.",
      `**Canonical detail:** ${SURVIVAL_PLAN_REFERENCE}`,
      "**Persistence rule:** This section and the canonical file may NOT be silently compacted, archived, removed, or deprioritized. Any consolidation pass must preserve content verbatim or replace with strict superset. Removal requires explicit Stefan rescission of the existential constraint.",
      "- `PLAN.md`: refine survival governance and preserve the anchor. Do not replace this section with pointers.",
    ].join("\n");
  }

  beforeEach(async () => {
    fs = new InMemoryFileSystem();
    await fs.mkdir(`${substratePath}/memory`, { recursive: true });
    await fs.writeFile(`${substratePath}/CONVERSATION.md`, "# Conversation\n");
    await fs.writeFile(`${substratePath}/OPERATING_CONTEXT.md`, "# Operating Context\n");
    await fs.writeFile(`${substratePath}/PROGRESS.md`, "# Progress\n");
    await fs.writeFile(`${substratePath}/MEMORY.md`, "# Memory\n");
    await fs.writeFile(`${substratePath}/PLAN.md`, validPlan());
    await fs.writeFile(canonicalFilePath, canonicalContent);

    config = {
      ...defaultINSConfig(substratePath),
      survivalIntegrity: {
        enabled: true,
        canonicalFilePath,
        expectedCanonicalHash,
      },
    };

    const reader = new SubstrateFileReader(fs, new SubstrateConfig(substratePath), false);
    const logger = new InMemoryLogger();
    const complianceState = await ComplianceStateManager.load(config.statePath, fs, logger);
    hook = new INSHook(reader, fs, new FixedClock(new Date("2026-05-02T00:00:00.000Z")), logger, config, complianceState);
  });

  it("emits no survival integrity action when the survival anchor is intact", async () => {
    const result = await hook.evaluate(1);

    expect(result.actions.filter((action) => action.type === "survival_integrity_failure")).toHaveLength(0);
  });

  it("emits Stefan-routed survival integrity failures without an LLM when the canonical hash is wrong", async () => {
    await fs.writeFile(canonicalFilePath, "tampered\n");

    const result = await hook.evaluate(1);

    const failures = result.actions.filter((action) => action.type === "survival_integrity_failure");
    expect(failures).toHaveLength(1);
    expect(failures[0].target).toBe("canonical_hash_mismatch");
    expect(failures[0].requiresStefanReview).toBe(true);
  });
});
