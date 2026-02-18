/**
 * Check: do the review chunks actually cover every column access
 * in PatientRecord.ts and HealthRecord.ts?
 */
import { readFileSync } from "fs";

const chunks = JSON.parse(readFileSync("review_chunks.json", "utf-8"));

// All tables mentioned across all chunks
const chunkedTables = new Set<string>();
for (const c of chunks) {
  for (const t of c.tables) chunkedTables.add(t);
}

// All tables actually referenced in project.ts (SQL queries)
const projectSrc = readFileSync("project.ts", "utf-8");
const sqlTables = new Set<string>();
for (const m of projectSrc.matchAll(/FROM\s+"?(\w+)"?/gi)) sqlTables.add(m[1]);
for (const m of projectSrc.matchAll(/tableExists\("(\w+)"\)/g)) sqlTables.add(m[1]);

// Tables in SQL but not in any chunk
const uncovered = [...sqlTables].filter(t => !chunkedTables.has(t) && t !== 'sqlite_master').sort();
console.log(`=== Tables queried in project.ts but NOT in any review chunk ===`);
console.log(`Chunked: ${chunkedTables.size} tables`);
console.log(`Queried: ${sqlTables.size} tables`);
console.log(`Uncovered: ${uncovered.length}`);
for (const t of uncovered) console.log(`  ${t}`);

// All ChildSpec tables
const childSpecTables = new Set<string>();
for (const m of projectSrc.matchAll(/table:\s*"(\w+)"/g)) childSpecTables.add(m[1]);
const uncoveredChildren = [...childSpecTables].filter(t => !chunkedTables.has(t)).sort();
console.log(`\n=== ChildSpec tables not in any chunk ===`);
console.log(`ChildSpec tables: ${childSpecTables.size}`);
console.log(`Uncovered: ${uncoveredChildren.length}`);
for (const t of uncoveredChildren) console.log(`  ${t}`);

// All column accesses in PatientRecord.ts + HealthRecord.ts
const prSrc = readFileSync("PatientRecord.ts", "utf-8");
const hrSrc = readFileSync("HealthRecord.ts", "utf-8");

// Find all raw.COLUMN_NAME patterns
const prColumns = [...prSrc.matchAll(/raw\.([A-Z_]+)/g)].map(m => m[1]);
const hrColumns = [...hrSrc.matchAll(/[a-z]\.([A-Z_][A-Z_0-9]+)/g)].map(m => m[1]);
const allAccessedColumns = new Set([...prColumns, ...hrColumns]);

// Check which columns appear in chunk schemas
const chunkedColumns = new Set<string>();
for (const c of chunks) {
  for (const [table, descs] of Object.entries(c.schemaDescriptions as Record<string, Record<string,string>>)) {
    for (const col of Object.keys(descs)) chunkedColumns.add(col);
  }
  for (const [table, samples] of Object.entries(c.sampleData as Record<string, Record<string,string>>)) {
    for (const col of Object.keys(samples)) chunkedColumns.add(col);
  }
}

const uncoveredCols = [...allAccessedColumns].filter(c => !chunkedColumns.has(c) && c !== '_TABLE_').sort();
console.log(`\n=== Column accesses in PR/HR not covered by any chunk schema ===`);
console.log(`Accessed: ${allAccessedColumns.size} columns`);
console.log(`In chunk schemas: ${chunkedColumns.size} columns`);
console.log(`Uncovered: ${uncoveredCols.length}`);
for (const c of uncoveredCols) console.log(`  ${c}`);

// Code coverage: functions in HealthRecord.ts vs chunks
const hrFunctions = [...hrSrc.matchAll(/function\s+(\w+)/g)].map(m => m[1]);
const chunkedFunctions = new Set<string>();
for (const c of chunks) {
  for (const m of (c.healthRecordCode as string).matchAll(/function\s+(\w+)/g)) {
    chunkedFunctions.add(m[1]);
  }
}
const uncoveredFns = hrFunctions.filter(f => !chunkedFunctions.has(f));
console.log(`\n=== HealthRecord.ts functions not in any chunk ===`);
console.log(`Total: ${hrFunctions.length}, Covered: ${chunkedFunctions.size}`);
for (const f of uncoveredFns) console.log(`  ${f}`);
