import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  test: {
    environment: "jsdom",
    include: ["src/**/*.test.tsx"],
    setupFiles: ["./src/test/setup.ts"],
    clearMocks: true,
    coverage: {
      provider: "v8",
      include: ["src/**/*.tsx"],
      exclude: ["src/**/*.test.tsx"],
      reporter: ["text", "html"],
      reportsDirectory: "coverage/ui",
    },
  },
});
