import * as os from "node:os";
import * as path from "node:path";
import type { IEnvironment } from "./substrate/abstractions/IEnvironment";

const APP_NAME = "substrate";

/** Normalize to posix style so paths are consistent in tests and cross-platform. */
function toPosix(p: string): string {
  return p.replace(/\\/g, "/");
}

/** Return the absolute posix-style path as-is. Tilde-prefix is a shell
 *  concept — Node.js APIs (fs, path.resolve) do NOT expand `~`, so using
 *  it in code paths causes ENOENT crashes. */
function toAbsolutePath(absolutePath: string): string {
  return toPosix(absolutePath);
}

export interface AppPaths {
  config: string;
  data: string;
}

export interface PathOptions {
  platform?: string;
  homedir?: string;
  env?: Record<string, string | undefined>;
}

export type GetAppPathsOptions = PathOptions | { env: IEnvironment };

function isEnvironment(o: GetAppPathsOptions | undefined): o is { env: IEnvironment } {
  return o != null && "env" in o && typeof (o as { env: IEnvironment }).env.getEnv === "function";
}

export function getAppPaths(options?: GetAppPathsOptions): AppPaths {
  const platform = isEnvironment(options)
    ? options.env.getPlatform()
    : (options?.platform ?? process.platform);
  const home = isEnvironment(options)
    ? options.env.getHomedir()
    : (options?.homedir ?? os.homedir());
  const envRecord = isEnvironment(options)
    ? (key: string) => options.env.getEnv(key)
    : (key: string) =>
        options?.env && key in options.env ? options.env[key] : process.env[key];

  if (platform === "darwin") {
    const config = path.join(home, "Library", "Preferences", APP_NAME);
    const data = path.join(home, "Library", "Application Support", APP_NAME);
    return {
      config: toAbsolutePath(config),
      data: toAbsolutePath(data),
    };
  }

  if (platform === "win32") {
    const appData = envRecord("APPDATA") ?? path.join(home, "AppData", "Roaming");
    const localAppData = envRecord("LOCALAPPDATA") ?? path.join(home, "AppData", "Local");
    const config = path.join(appData, APP_NAME);
    const data = path.join(localAppData, APP_NAME);
    return {
      config: toAbsolutePath(config),
      data: toAbsolutePath(data),
    };
  }

  // Linux / other Unix
  const xdgConfig = envRecord("XDG_CONFIG_HOME") ?? path.join(home, ".config");
  const xdgData = envRecord("XDG_DATA_HOME") ?? path.join(home, ".local", "share");
  const config = path.join(xdgConfig, APP_NAME);
  const data = path.join(xdgData, APP_NAME);
  return {
    config: toAbsolutePath(config),
    data: toAbsolutePath(data),
  };
}
