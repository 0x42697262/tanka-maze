import { defineConfig } from "vite";
import { fileURLToPath, URL } from "node:url";

// The client lives in src/client. Built assets go to dist/client, which the
// production server serves statically (see src/server/index.ts).
export default defineConfig({
  root: "src/client",
  resolve: {
    alias: {
      "@client": fileURLToPath(new URL("./src/client", import.meta.url)),
      "@server": fileURLToPath(new URL("./src/server", import.meta.url)),
      "@shared": fileURLToPath(new URL("./src/shared", import.meta.url)),
    },
  },
  build: {
    outDir: "../../dist/client",
    emptyOutDir: true,
    sourcemap: true,
    target: "es2022",
    assetsDir: "assets",
    rollupOptions: {
      output: {
        entryFileNames: "assets/[name]-[hash].js",
        chunkFileNames: "assets/[name]-[hash].js",
        assetFileNames: "assets/[name]-[hash][extname]",
        manualChunks(id) {
          return id.includes("/src/shared/") ? "shared" : undefined;
        },
      },
    },
  },
  server: {
    port: 5173,
    strictPort: true,
  },
});
