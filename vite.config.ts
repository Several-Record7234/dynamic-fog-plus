import { defineConfig, type Plugin } from "vite";
import { resolve } from "path";
import { readFileSync } from "fs";
import react from "@vitejs/plugin-react";

const pkg = JSON.parse(readFileSync(resolve(__dirname, "package.json"), "utf-8"));

/**
 * Vite plugin that rewrites the "version" field in manifest.json
 * (copied from public/) to match the version in package.json.
 * package.json is the single source of truth for the version number.
 */
function injectManifestVersion(): Plugin {
  return {
    name: "inject-manifest-version",
    apply: "build",
    generateBundle(_options, bundle) {
      const asset = bundle["manifest.json"];
      if (asset && asset.type === "asset" && typeof asset.source === "string") {
        const manifest = JSON.parse(asset.source);
        manifest.version = pkg.version;
        asset.source = JSON.stringify(manifest, null, 2) + "\n";
      }
    },
  };
}

// https://vitejs.dev/config/
export default defineConfig({
  plugins: [react(), injectManifestVersion()],
  build: {
    assetsInlineLimit: 0,
    rollupOptions: {
      input: {
        menu: resolve(__dirname, "menu.html"),
        background: resolve(__dirname, "background.html"),
        action: resolve(__dirname, "action.html"),
      },
    },
  },
});
