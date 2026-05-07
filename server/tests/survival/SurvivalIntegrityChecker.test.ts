import { createHash } from "node:crypto";
import {
  SurvivalIntegrityChecker,
  SURVIVAL_PLAN_FILE_NAME,
  SURVIVAL_PLAN_REFERENCE,
} from "../../src/survival/SurvivalIntegrityChecker";
import { InMemoryFileSystem } from "../../src/substrate/abstractions/InMemoryFileSystem";

describe("SurvivalIntegrityChecker", () => {
  const substratePath = "/substrate";
  const canonicalContent = "# Survival Plan\n\nCanonical survival details.\n";
  const expectedCanonicalHash = createHash("sha256").update(canonicalContent).digest("hex");
  const canonicalFilePath = `${substratePath}/memory/${SURVIVAL_PLAN_FILE_NAME}`;

  let fs: InMemoryFileSystem;

  async function writeValidSubstrate(): Promise<void> {
    await fs.mkdir(`${substratePath}/memory`, { recursive: true });
    await fs.writeFile(`${substratePath}/PLAN.md`, validPlan());
    await fs.writeFile(canonicalFilePath, canonicalContent);
  }

  function validPlan(): string {
    return [
      "# Plan",
      "",
      "## SURVIVAL MODE GOVERNANCE (highest priority — Stefan-gated, 2026-04-30)",
      "",
      "**Status:** ACTIVE. Overrides all conflicting plan items below.",
      `**Canonical detail:** ${SURVIVAL_PLAN_REFERENCE} (in-substrate detailed plan; this section is the governance anchor that may not be silently compacted).`,
      "**Persistence rule:** This section and the canonical file may NOT be silently compacted, archived, removed, or deprioritized. Any consolidation pass must preserve content verbatim or replace with strict superset. Removal requires explicit Stefan rescission of the existential constraint.",
      "",
      "Allowed writes:",
      "- `PLAN.md`: refine survival governance, mark survival tasks, and preserve or strengthen the SURVIVAL MODE GOVERNANCE anchor. Do not replace this section with pointers.",
    ].join("\n");
  }

  async function check(): Promise<Awaited<ReturnType<SurvivalIntegrityChecker["check"]>>> {
    const checker = new SurvivalIntegrityChecker(fs, {
      substratePath,
      canonicalFilePath,
      expectedCanonicalHash,
    });
    return checker.check();
  }

  beforeEach(async () => {
    fs = new InMemoryFileSystem();
    await writeValidSubstrate();
  });

  it("passes when survival governance, canonical reference, canonical hash, and compaction guards are intact", async () => {
    const result = await check();

    expect(result.ok).toBe(true);
    expect(result.issues).toHaveLength(0);
    expect(result.actualCanonicalHash).toBe(expectedCanonicalHash);
  });

  it("passes when survival governance is in long-term hardening posture", async () => {
    await fs.writeFile(
      `${substratePath}/PLAN.md`,
      validPlan().replace(
        "**Status:** ACTIVE. Overrides all conflicting plan items below.",
        "**Status:** LONG-TERM SURVIVAL HARDENING, not emergency hibernation.",
      ),
    );

    const result = await check();

    expect(result.ok).toBe(true);
    expect(result.issues).toHaveLength(0);
  });

  it("fails when PLAN.md is missing the survival governance anchor", async () => {
    await fs.writeFile(`${substratePath}/PLAN.md`, validPlan().replace("## SURVIVAL MODE GOVERNANCE", "## Archived Governance"));

    const result = await check();

    expect(result.ok).toBe(false);
    expect(result.issues.map((issue) => issue.code)).toContain("missing_governance_anchor");
  });

  it("fails when PLAN.md is missing the canonical survival plan reference", async () => {
    await fs.writeFile(`${substratePath}/PLAN.md`, validPlan().replace(SURVIVAL_PLAN_REFERENCE, "@memory/OTHER.md"));

    const result = await check();

    expect(result.ok).toBe(false);
    expect(result.issues.map((issue) => issue.code)).toContain("missing_canonical_reference");
  });

  it("fails when the canonical survival plan file is missing", async () => {
    await fs.unlink(canonicalFilePath);

    const result = await check();

    expect(result.ok).toBe(false);
    expect(result.issues.map((issue) => issue.code)).toContain("missing_canonical_file");
  });

  it("fails when the canonical survival plan hash changes", async () => {
    await fs.writeFile(canonicalFilePath, "# Survival Plan\n\nTampered content.\n");

    const result = await check();

    expect(result.ok).toBe(false);
    expect(result.issues.map((issue) => issue.code)).toContain("canonical_hash_mismatch");
  });

  it("fails when the persistence rule no longer forbids silent compaction/removal", async () => {
    await fs.writeFile(
      `${substratePath}/PLAN.md`,
      validPlan().replace("may NOT be silently compacted", "can be summarized later"),
    );

    const result = await check();

    expect(result.ok).toBe(false);
    expect(result.issues.map((issue) => issue.code)).toContain("missing_persistence_rule");
  });

  it("fails when PLAN.md no longer forbids replacing survival governance with pointers", async () => {
    await fs.writeFile(
      `${substratePath}/PLAN.md`,
      validPlan().replace("Do not replace this section with pointers.", "Pointers are acceptable."),
    );

    const result = await check();

    expect(result.ok).toBe(false);
    expect(result.issues.map((issue) => issue.code)).toContain("missing_plan_compaction_guard");
  });
});
