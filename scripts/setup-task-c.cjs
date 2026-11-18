// Task C helper: register a deliberately unreachable model provider in TrueForge.
// It points at 127.0.0.1:59999 (nothing listens there), so every
// request fails with ECONNREFUSED - a realistic "endpoint is down" scenario.
//
// Demo: set "forgelens.models" to ["unreachable/broken-model", "<a working model>"]
// and repeat Task A. ForgeLens retries with backoff, then falls back automatically.
// usage: node scripts/setup-task-c.cjs [trueforgeUrl]
const path = require("path");
const { ForgeClient } = require("../dist/core.js"); // bundled SDK (run `npm run build` first)
const url = process.argv[2] || "http://localhost:8790";
(async () => {
  const c = new ForgeClient(url, path.join(__dirname, "..", "agents")).client;
  await c.settings.modelProviders.createOrUpdate({
    manifest: {
      type: "custom",
      name: "unreachable",
      baseUrl: "http://127.0.0.1:59999/v1",
      models: [{ modelId: "broken-model", name: "broken-model", properties: { contextLength: 128000, maxOutputTokens: 4096 } }],
    },
  });
  console.log('Registered provider "unreachable" with model "unreachable/broken-model" (http://127.0.0.1:59999/v1).');
})().catch((e) => {
  console.error(e.message, e.body ?? "");
  process.exit(1);
});
