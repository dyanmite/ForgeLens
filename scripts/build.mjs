// Bundles the extension (and the standalone core for tests) with esbuild.
import * as esbuild from "esbuild";

const watch = process.argv.includes("--watch");

const common = {
  bundle: true,
  platform: "node",
  target: "node20",
  format: "cjs",
  sourcemap: true,
  logLevel: "info",
};

const configs = [
  { ...common, entryPoints: ["src/extension.ts"], outfile: "dist/extension.js", external: ["vscode"] },
  // Core logic without any VS Code dependency: used by tests and scripts/dev-mcp.mjs.
  { ...common, entryPoints: ["src/core/standalone.ts"], outfile: "dist/core.js" },
];

if (watch) {
  for (const c of configs) (await esbuild.context(c)).watch();
} else {
  await Promise.all(configs.map((c) => esbuild.build(c)));
}
