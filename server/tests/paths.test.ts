import { getAppPaths } from "../src/paths";

describe("getAppPaths", () => {
  it("returns XDG-based paths on linux", () => {
    const paths = getAppPaths({
      platform: "linux",
      homedir: "/home/testuser",
      env: {},
    });

    expect(paths.config).toBe("/home/testuser/.config/rook-wiggums");
    expect(paths.data).toBe("/home/testuser/.local/share/rook-wiggums");
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

    expect(paths.config).toBe("/custom/config/rook-wiggums");
    expect(paths.data).toBe("/custom/data/rook-wiggums");
  });

  it("returns Library-based paths on darwin", () => {
    const paths = getAppPaths({
      platform: "darwin",
      homedir: "/Users/testuser",
      env: {},
    });

    expect(paths.config).toBe("/Users/testuser/Library/Preferences/rook-wiggums");
    expect(paths.data).toBe("/Users/testuser/Library/Application Support/rook-wiggums");
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

    expect(paths.config).toBe("/appdata/roaming/rook-wiggums");
    expect(paths.data).toBe("/appdata/local/rook-wiggums");
  });
});
