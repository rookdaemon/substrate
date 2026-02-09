import { parseArgs } from "../src/cli";

describe("parseArgs", () => {
  it("defaults to start command with no config", () => {
    const result = parseArgs(["node", "cli.ts"]);

    expect(result.command).toBe("start");
    expect(result.configPath).toBeUndefined();
  });

  it("parses init command", () => {
    const result = parseArgs(["node", "cli.ts", "init"]);

    expect(result.command).toBe("init");
    expect(result.configPath).toBeUndefined();
  });

  it("parses start command with --config flag", () => {
    const result = parseArgs(["node", "cli.ts", "start", "--config", "/my/config.json"]);

    expect(result.command).toBe("start");
    expect(result.configPath).toBe("/my/config.json");
  });

  it("parses --config flag without explicit command", () => {
    const result = parseArgs(["node", "cli.ts", "--config", "/my/config.json"]);

    expect(result.command).toBe("start");
    expect(result.configPath).toBe("/my/config.json");
  });

  it("parses init command with --config flag", () => {
    const result = parseArgs(["node", "cli.ts", "init", "--config", "/my/config.json"]);

    expect(result.command).toBe("init");
    expect(result.configPath).toBe("/my/config.json");
  });

  it("parses backup command", () => {
    const result = parseArgs(["node", "cli.ts", "backup"]);

    expect(result.command).toBe("backup");
    expect(result.configPath).toBeUndefined();
  });

  it("defaults model to undefined (uses config/default)", () => {
    const result = parseArgs(["node", "cli.ts"]);

    expect(result.model).toBeUndefined();
  });

  it("parses --model flag", () => {
    const result = parseArgs(["node", "cli.ts", "start", "--model", "opus"]);

    expect(result.command).toBe("start");
    expect(result.model).toBe("opus");
  });

  it("parses --model with other flags", () => {
    const result = parseArgs(["node", "cli.ts", "--config", "/my/config.json", "--model", "haiku"]);

    expect(result.configPath).toBe("/my/config.json");
    expect(result.model).toBe("haiku");
  });
});
