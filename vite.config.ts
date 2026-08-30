import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react()],
  build: {
    outDir: "dist/client",
    sourcemap: true
  },
  server: {
    port: 5173,
    proxy: {
      "/api": "http://localhost:3000",
      "/runtime-config.js": "http://localhost:3000",
      "/version.json": "http://localhost:3000"
    }
  }
});
