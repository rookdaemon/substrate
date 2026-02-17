import { getVersion, getVersionInfo } from "../src/index";

describe("server", () => {
  it("returns the application version", () => {
    const version = getVersion();
    // Version should be a valid semver string (from package.json or fallback)
    expect(typeof version).toBe("string");
    expect(version).toMatch(/^\d+\.\d+\.\d+/);
  });

  it("returns version info with git hash", () => {
    const info = getVersionInfo();
    expect(info).toHaveProperty("version");
    expect(info).toHaveProperty("gitHash");
    expect(info).toHaveProperty("gitBranch");
    expect(info).toHaveProperty("buildTime");
    expect(typeof info.version).toBe("string");
    expect(typeof info.gitHash).toBe("string");
    expect(typeof info.gitBranch).toBe("string");
    expect(typeof info.buildTime).toBe("string");
  });
});
