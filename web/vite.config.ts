import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// The dev server proxies the BFF so the browser stays same-origin (no CORS,
// EventSource works cleanly). The BFF runs on :4100 by default.
const BFF = process.env.WEBUI_BFF_URL ?? "http://127.0.0.1:4100";

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      "/api": { target: BFF, changeOrigin: true },
      "/stream": { target: BFF, changeOrigin: true }
    }
  },
  build: {
    outDir: "dist",
    sourcemap: true
  }
});
