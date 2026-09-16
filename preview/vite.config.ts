import { defineConfig } from "vite";
import path from "node:path";

const projectRoot = path.resolve(import.meta.dirname, "..");
const browserShim = path.resolve(import.meta.dirname, "browser-shim.ts");

export default defineConfig({
  root: import.meta.dirname,
  // github pages serves project sites under /<repo>/
  base: process.env.PREVIEW_BASE ?? "/",
  resolve: {
    alias: [
      { find: /^@\//, replacement: `${projectRoot}/` },
      { find: "@wxt-dev/browser", replacement: browserShim },
      { find: "wxt/browser", replacement: browserShim },
      { find: "wxt/utils/storage", replacement: "@wxt-dev/storage" },
    ],
  },
  css: {
    postcss: {
      plugins: [
        (await import("@tailwindcss/postcss")).default({ base: projectRoot }),
        (await import("autoprefixer")).default,
      ],
    },
  },
  build: {
    outDir: path.resolve(import.meta.dirname, "dist"),
    emptyOutDir: true,
    rollupOptions: {
      onwarn(warning, warn) {
        // framer-motion ships "use client" directives that mean nothing in a plain bundle
        if (warning.code === "MODULE_LEVEL_DIRECTIVE") return;
        warn(warning);
      },
    },
  },
});
