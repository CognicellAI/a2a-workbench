import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
  },
  resolve: {
    alias: [
      {
        find: "@a2a-workbench/client/compat",
        replacement: fileURLToPath(
          new URL("./packages/client/src/compat/index.ts", import.meta.url),
        ),
      },
      {
        find: "@a2a-workbench/client",
        replacement: fileURLToPath(
          new URL("./packages/client/src/index.ts", import.meta.url),
        ),
      },
      {
        find: "@",
        replacement: fileURLToPath(new URL("./src", import.meta.url)),
      },
    ],
  },
});
