import { defineConfig } from "vitest/config";
import appConfig from "./vite.config";

export default defineConfig({
  resolve: appConfig.resolve,
  test: {
    environment: "node",
    include: ["src/**/*.test.ts", "src/**/*.test.tsx"],
    passWithNoTests: false,
  },
});
