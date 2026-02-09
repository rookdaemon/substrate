import { getTemplate } from "../../../src/substrate/templates/index";
import { SubstrateFileType } from "../../../src/substrate/types";
import { validateSubstrateContent } from "../../../src/substrate/validation/validators";

describe("templates", () => {
  it("has a template for every SubstrateFileType", () => {
    for (const type of Object.values(SubstrateFileType)) {
      const template = getTemplate(type);
      expect(template).toBeTruthy();
      expect(typeof template).toBe("string");
    }
  });

  it("every template passes its own validator", () => {
    for (const type of Object.values(SubstrateFileType)) {
      const template = getTemplate(type);
      const result = validateSubstrateContent(template, type);
      expect(result.valid).toBe(true);
      if (!result.valid) {
        // Extra debug info if test fails
        console.log(`Template ${type} failed validation:`, result.errors);
      }
    }
  });

  it("each template starts with a # heading", () => {
    for (const type of Object.values(SubstrateFileType)) {
      const template = getTemplate(type);
      expect(template.trimStart().startsWith("# ")).toBe(true);
    }
  });

  it("PLAN template has bootstrapping tasks", () => {
    const plan = getTemplate(SubstrateFileType.PLAN);
    expect(plan).toContain("## Tasks");
    expect(plan).toContain("- [ ]");
  });

  it("CLAUDE template has operational instructions", () => {
    const claude = getTemplate(SubstrateFileType.CLAUDE);
    expect(claude).toMatch(/substrate|PLAN|PROGRESS/i);
  });
});
