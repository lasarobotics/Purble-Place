/**
 * Validate a Firestore JSON export before any D1 cutover.
 * Usage: node scripts/migrate-validate.mjs path/to/export.json
 *
 * Does NOT write to production Firestore. Optionally loads into local D1
 * source_documents when --apply-local is passed (requires wrangler + local DB).
 */
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";

const path = process.argv[2];
if (!path) {
  console.error("Usage: node scripts/migrate-validate.mjs <firestore-export.json> [--write-manifest out.json]");
  process.exit(1);
}

const raw = await readFile(path, "utf8");
const data = JSON.parse(raw);
const collections = data.collections || data;
const required = ["scouters", "match_scouting", "scouting_audit", "events", "app_settings"];
const report = { imported_at: new Date().toISOString(), collections: {}, errors: [], warnings: [] };

for (const name of required) {
  if (!collections[name]) report.errors.push(`Missing collection: ${name}`);
}

let docs = 0;
for (const [name, rows] of Object.entries(collections)) {
  if (!rows || typeof rows !== "object") {
    report.errors.push(`Collection ${name} is not an object map`);
    continue;
  }
  const ids = Object.keys(rows);
  const hashes = [];
  for (const id of ids) {
    const payload = JSON.stringify(rows[id]);
    hashes.push(createHash("sha256").update(payload).digest("hex"));
    docs += 1;
  }
  report.collections[name] = { count: ids.length, sha256_of_ids: createHash("sha256").update(ids.sort().join("|")).digest("hex") };
  if (name === "match_scouting") {
    const missingUuid = ids.filter((id) => !rows[id]?.submission_id && id.length < 8);
    if (missingUuid.length) report.warnings.push(`${missingUuid.length} scouting docs lack submission_id field (id may still be UUID)`);
  }
}

if (!report.errors.length && docs === 0) report.errors.push("Export contained zero documents");

const manifestPath = process.argv.includes("--write-manifest") ? process.argv[process.argv.indexOf("--write-manifest") + 1] : null;
if (manifestPath) await writeFile(manifestPath, JSON.stringify(report, null, 2));

console.log(JSON.stringify({ ok: report.errors.length === 0, documents: docs, ...report }, null, 2));
process.exit(report.errors.length ? 1 : 0);
