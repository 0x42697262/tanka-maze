import { defineConfig } from "vite";

// The client lives in src/client. Built assets go to dist/client, which the
// production server serves statically (see src/server/index.ts).
export default defineConfig({
  root: "src/client",
  build: {
    outDir: "../../dist/client",
    emptyOutDir: true,
  },
  server: {
    port: 5173,
  },
});
