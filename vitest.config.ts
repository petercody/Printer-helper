import { defineConfig } from "vitest/config";

export default defineConfig({
  // The source uses NodeNext-style `./foo.js` specifiers that point at `.ts`
  // files. Teach Vite to resolve a `.js` import to its `.ts` sibling first.
  resolve: {
    extensionAlias: {
      ".js": [".ts", ".js"],
    },
  },
  test: {
    environment: "node",
    include: ["test/**/*.test.ts"],
    clearMocks: true,
  },
});
