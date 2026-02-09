export { createApplication } from "./loop/createApplication";
export type { ApplicationConfig, Application } from "./loop/createApplication";
export { startServer } from "./startup";
export type { RookConfig } from "./config";
export { resolveConfig } from "./config";
export { getAppPaths } from "./paths";
export type { AppPaths } from "./paths";

export function getVersion(): string {
  return "0.1.0";
}
