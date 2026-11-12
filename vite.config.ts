import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    watch: { ignored: ["**/src-tauri/**"] },
  },
  test: {
    // Las pruebas parten en español; las que prueban el inglés lo piden explícitamente.
    setupFiles: ["./src/test-setup.ts"],
  },
});
