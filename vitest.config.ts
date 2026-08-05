import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

// Mirrors the `@/*` path alias from tsconfig.json so tests can import modules
// the same way the application does.
export default defineConfig({
  resolve: {
    alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) },
  },
  // tsconfig sets jsx: "preserve" because Next.js owns the transform in the app
  // build. Vitest has no such downstream step, so it needs to be told to compile
  // JSX itself — otherwise a .tsx module under test silently renders nothing.
  esbuild: { jsx: "automatic" },
});
