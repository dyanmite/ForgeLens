// Dev tool: print the context ledger ForgeLens would build for a request.
// usage: node scripts/inspect-context.cjs <repo> "<request>" [budget]
const core = require("../dist/core.js");
const [repo, request, budget = "6000"] = process.argv.slice(2);
const t0 = Date.now();
const idx = new core.RepoIndex(repo).build();
console.log(`indexed ${idx.files.size} files, ${idx.chunks.length} chunks in ${Date.now() - t0}ms`);
const pack = core.buildContextPack(idx, request, Number(budget));
console.log(`budget ${pack.budget}, used ${pack.used}, map ${pack.mapTokens}`);
for (const l of pack.ledger) console.log(`${l.included ? "IN " : "PTR"} ${l.path}:${l.startLine}-${l.endLine} ~${l.tokens}t  ${l.reason}`);
