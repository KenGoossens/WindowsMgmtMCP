import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["test/**/*.test.ts"]
  },
  // Resolve NodeNext-style ".js" import specifiers to their ".ts" sources.
  resolve: {
    extensionAlias: {
      ".js": [".ts", ".js"]
    }
  }
});
