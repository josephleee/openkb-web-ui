import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      "/api": {
        target: "http://localhost:8000",
        changeOrigin: true,
        // SSE streams (job progress, chat) stay open for minutes; make sure
        // http-proxy never times the sockets out. Responses are piped
        // unbuffered, so `data:` frames flush through as they arrive.
        timeout: 0,
        proxyTimeout: 0,
      },
    },
  },
  build: {
    outDir: "dist",
  },
  test: {
    environment: "jsdom",
    // Globals are required for @testing-library/react's afterEach auto-cleanup.
    globals: true,
    setupFiles: "./src/test/setup.ts",
    css: false,
  },
});
