import { getAppPaths } from "../src/paths";
import type { IEnvironment } from "../src/substrate/abstractions/IEnvironment";

function mockEnv(overrides: {
  getPlatform: () => string;
  getHomedir: () => string;
  getEnv: (key: string) => string | undefined;
}): IEnvironment {
  return {
    get fs() {
      throw new Error("not used in getAppPaths");
    },
    get clock() {
      throw new Error("not used in getAppPaths");
    },
    getEnv: overrides.getEnv,
    getPlatform: overrides.getPlatform,
    getHomedir: overrides.getHomedir,
  };
}

describe("getAppPaths", () => {
  it("returns XDG-based paths when given IEnvironment (linux)", () => {
    const env = mockEnv({
      getPlatform: () => "linux",
      getHomedir: () => "/home/testuser",
      getEnv: (k) => (k === "XDG_CONFIG_HOME" ? "/custom/config" : undefined),
    });
    const paths = getAppPaths({ env });
    expect(paths.config).toBe("/custom/config/substrate");
    expect(paths.data).toBe("/home/testuser/.local/share/substrate");
  });

  it("returns XDG-based paths on linux", () => {
    const paths = getAppPaths({
      platform: "linux",
      homedir: "/home/testuser",
      env: { XDG_CONFIG_HOME: undefined, XDG_DATA_HOME: undefined },
    });

    expect(paths.config).toBe("/home/testuser/.config/substrate");
    expect(paths.data).toBe("/home/testuser/.local/share/substrate");
  });

  it("respects XDG env var overrides", () => {
    const paths = getAppPaths({
      platform: "linux",
      homedir: "/home/testuser",
      env: {
        XDG_CONFIG_HOME: "/custom/config",
        XDG_DATA_HOME: "/custom/data",
      },
    });

    expect(paths.config).toBe("/custom/config/substrate");
    expect(paths.data).toBe("/custom/data/substrate");
  });

  it("returns Library-based paths on darwin", () => {
    const paths = getAppPaths({
      platform: "darwin",
      homedir: "/Users/testuser",
      env: {},
    });

    expect(paths.config).toBe("/Users/testuser/Library/Preferences/substrate");
    expect(paths.data).toBe("/Users/testuser/Library/Application Support/substrate");
  });

  it("uses APPDATA and LOCALAPPDATA on win32", () => {
    const paths = getAppPaths({
      platform: "win32",
      homedir: "/home/testuser",
      env: {
        APPDATA: "/appdata/roaming",
        LOCALAPPDATA: "/appdata/local",
      },
    });

    expect(paths.config).toBe("/appdata/roaming/substrate");
    expect(paths.data).toBe("/appdata/local/substrate");
  });
});
