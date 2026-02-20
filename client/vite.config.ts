import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

const CLIENT_PORT = parseInt(process.env.VITE_CLIENT_PORT ?? "18789", 10);
const API_PORT = parseInt(process.env.VITE_API_PORT ?? "3000", 10);

export default defineConfig({
  plugins: [react()],
  server: {
    port: CLIENT_PORT,
    strictPort: true,
    allowedHosts: true,
    proxy: {
      "/api": `http://localhost:${API_PORT}`,
      "/ws": {
        target: `ws://localhost:${API_PORT}`,
        ws: true,
      },
    },
  },
});
