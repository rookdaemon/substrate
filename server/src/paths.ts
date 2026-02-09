import * as os from "node:os";
import * as path from "node:path";

const APP_NAME = "rook-wiggums";

export interface AppPaths {
  config: string;
  data: string;
}

export interface PathOptions {
  platform?: string;
  homedir?: string;
  env?: Record<string, string | undefined>;
}

export function getAppPaths(options?: PathOptions): AppPaths {
  const platform = options?.platform ?? process.platform;
  const home = options?.homedir ?? os.homedir();
  const env = options?.env ?? process.env;

  if (platform === "darwin") {
    return {
      config: path.join(home, "Library", "Preferences", APP_NAME),
      data: path.join(home, "Library", "Application Support", APP_NAME),
    };
  }

  if (platform === "win32") {
    const appData = env["APPDATA"] ?? path.join(home, "AppData", "Roaming");
    const localAppData = env["LOCALAPPDATA"] ?? path.join(home, "AppData", "Local");
    return {
      config: path.join(appData, APP_NAME),
      data: path.join(localAppData, APP_NAME),
    };
  }

  // Linux / other Unix
  const xdgConfig = env["XDG_CONFIG_HOME"] ?? path.join(home, ".config");
  const xdgData = env["XDG_DATA_HOME"] ?? path.join(home, ".local", "share");
  return {
    config: path.join(xdgConfig, APP_NAME),
    data: path.join(xdgData, APP_NAME),
  };
}
