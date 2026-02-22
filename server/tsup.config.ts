import { defineConfig } from "tsup";

export default defineConfig({
  entry: [
    "src/index.ts",
    "src/cli.ts",
    "src/supervisor.ts",
    "src/agora-relay/server.ts",
  ],
  format: ["esm"],
  target: "node20",
  outDir: "dist",
  dts: false,
  sourcemap: true,
  clean: true,
  // Preserve directory structure so dist/agora-relay/server.js exists
  outExtension() {
    return { js: ".js" };
  },
});
