/**
 * Column-level mapping validation: find every column name referenced in
 * PatientRecord.ts and HealthRecord.ts, then check whether it actually
 * exists in the corresponding DB table.
 */
import { Database } from "bun:sqlite";

const db = new Database("ehi_clean.db", { readonly: true });
function q(sql: string, params: unknown[] = []) { return db.query(sql).all(...params) as Record<string,unknown>[]; }
function tableCols(t: string): Set<string> {
  return new Set(q(`PRAGMA table_info("${t}")`).map(r => r.name as string));
}

// 1. Check: every ChildSpec fkCol exists in the child table
const projectSrc = await Bun.file("project.ts").text();

// Extract all ChildSpec entries: { table: "X", fkCol: "Y", key: "z" }
const childSpecRE = /\{\s*table:\s*"([^"]+)",\s*fkCol:\s*"([^"]+)",\s*key:\s*"([^"]+)"/g;
let match;
let specErrors = 0;
let specChecked = 0;
console.log("=== ChildSpec fkCol validation ===");
while ((match = childSpecRE.exec(projectSrc)) !== null) {
  const [, table, fkCol] = match;
  specChecked++;
  const exists = q(`SELECT 1 FROM sqlite_master WHERE type='table' AND name=?`, [table]);
  if (exists.length === 0) continue; // table might not exist in this export
  const cols = tableCols(table);
  if (!cols.has(fkCol)) {
    console.log(`  ✗ ${table}.${fkCol} — column does NOT exist! Has: ${[...cols].join(', ')}`);
    specErrors++;
  }
}
console.log(`  Checked ${specChecked} ChildSpecs, ${specErrors} errors\n`);

// 2. Check: every raw.COLUMN_NAME in PatientRecord.ts maps to a real column
const prSrc = await Bun.file("PatientRecord.ts").text();
const rawColRE = /raw\.([A-Z_][A-Z_0-9]+)/g;
const prRawCols = new Set<string>();
while ((match = rawColRE.exec(prSrc)) !== null) {
  prRawCols.add(match[1]);
}

// Build a set of ALL columns across ALL tables
const allCols = new Set<string>();
const allTables = q("SELECT name FROM sqlite_master WHERE type='table'").map(r => r.name as string);
for (const t of allTables) {
  for (const c of tableCols(t)) allCols.add(c);
}

console.log("=== PatientRecord.ts raw.COLUMN references ===");
let prMissing = 0;
for (const col of [...prRawCols].sort()) {
  if (!allCols.has(col)) {
    // Check if it's a computed field (prefixed with _)
    if (col.startsWith('_')) continue;
    console.log(`  ✗ raw.${col} — not found in any table`);
    prMissing++;
  }
}
console.log(`  ${prRawCols.size} column refs, ${prMissing} not found in DB\n`);

// 3. Check: every column referenced in HealthRecord.ts projections
const hrSrc = await Bun.file("HealthRecord.ts").text();
const hrColRE = /[a-z]\.([A-Z_][A-Z_0-9]+)/g;
const hrCols = new Set<string>();
while ((match = hrColRE.exec(hrSrc)) !== null) {
  hrCols.add(match[1]);
}

console.log("=== HealthRecord.ts projection column references ===");
let hrMissing = 0;
for (const col of [...hrCols].sort()) {
  if (!allCols.has(col)) {
    if (col.startsWith('_')) continue;
    console.log(`  ✗ ${col} — not found in any table`);
    hrMissing++;
  }
}
console.log(`  ${hrCols.size} column refs, ${hrMissing} not found in DB\n`);

// 4. Check: columns that are in the DB and have data, but are never
//    referenced by ANY projection code
console.log("=== Data columns never referenced in projection ===");

// Gather all column names referenced in any .ts file
const allSrc = projectSrc + prSrc + hrSrc;
const allReferencedCols = new Set<string>();
const anyColRE = /["']([A-Z][A-Z_0-9]+)["']/g;
while ((match = anyColRE.exec(allSrc)) !== null) {
  allReferencedCols.add(match[1]);
}
// Also grab raw.X and x.X patterns
const dotColRE = /\.([A-Z][A-Z_0-9]+)/g;
while ((match = dotColRE.exec(allSrc)) !== null) {
  allReferencedCols.add(match[1]);
}

// For each covered table, find columns with data that aren't referenced
const coveredTables = new Set<string>();
const specTableRE = /table:\s*"([^"]+)"/g;
while ((match = specTableRE.exec(projectSrc)) !== null) coveredTables.add(match[1]);
// Add root tables
for (const t of ['PATIENT','PAT_ENC','ORDER_PROC','ORDER_MED','HNO_INFO','ARPB_TRANSACTIONS',
  'ACCOUNT','ARPB_VISITS','MYC_MESG','REFERRAL','COVERAGE','CLM_VALUES','HSP_ACCOUNT',
  'CL_REMIT','ALLERGY','PROBLEM_LIST','IMMUNE','SOCIAL_HX','SURGICAL_HX',
  'FAMILY_HX_STATUS','FAMILY_HX','DOC_INFORMATION','ORDER_RESULTS']) {
  coveredTables.add(t);
}

let unreferencedCount = 0;
const unreferencedByTable: Record<string, string[]> = {};
for (const t of [...coveredTables].sort()) {
  if (!allTables.includes(t)) continue;
  const cols = tableCols(t);
  const unreferenced: string[] = [];
  for (const col of cols) {
    if (allReferencedCols.has(col)) continue;
    // Check if column has data
    const nn = (q(`SELECT COUNT(*) as n FROM "${t}" WHERE "${col}" IS NOT NULL AND "${col}" != ''`)[0].n as number);
    if (nn > 0) {
      unreferenced.push(`${col} (${nn} values)`);
      unreferencedCount++;
    }
  }
  if (unreferenced.length > 0) {
    unreferencedByTable[t] = unreferenced;
  }
}

// Show top tables by unreferenced column count
const sorted = Object.entries(unreferencedByTable).sort((a,b) => b[1].length - a[1].length);
for (const [table, cols] of sorted.slice(0, 15)) {
  console.log(`  ${table}: ${cols.length} unreferenced data columns`);
  for (const c of cols.slice(0, 5)) console.log(`    ${c}`);
  if (cols.length > 5) console.log(`    ... +${cols.length - 5} more`);
}
console.log(`\n  Total: ${unreferencedCount} data columns in covered tables never referenced in code\n`);

// 5. Check: lookupName() calls — does the table/pkCol/nameCol exist?
console.log("=== lookupName() validation ===");
const lookupRE = /lookupName\("([^"]+)",\s*"([^"]+)",\s*"([^"]+)"/g;
let lookupErrors = 0;
while ((match = lookupRE.exec(projectSrc)) !== null) {
  const [, table, pkCol, nameCol] = match;
  if (!allTables.includes(table)) {
    console.log(`  ✗ lookupName("${table}", ...) — table doesn't exist`);
    lookupErrors++;
    continue;
  }
  const cols = tableCols(table);
  if (!cols.has(pkCol)) {
    console.log(`  ✗ lookupName("${table}", "${pkCol}", ...) — pkCol doesn't exist`);
    lookupErrors++;
  }
  if (!cols.has(nameCol)) {
    console.log(`  ✗ lookupName("${table}", ..., "${nameCol}") — nameCol doesn't exist`);
    lookupErrors++;
  }
}
console.log(`  ${lookupErrors} lookup errors\n`);

// 6. Split config validation — do join columns produce actual matches?
console.log("=== Split merge column overlap check ===");
// When merging, columns from splits that have the SAME name as base columns
// are silently dropped. Check if any dropped columns have different data.
import splitConfig from "../src/split_config.json";
const splits = splitConfig as Record<string, { base_pk: string; members: Array<{ table: string; join_col: string }> }>;
let overlapIssues = 0;
for (const [base, config] of Object.entries(splits)) {
  if (!allTables.includes(base)) continue;
  const baseCols = tableCols(base);
  for (const member of config.members) {
    if (!allTables.includes(member.table)) continue;
    const splitCols = tableCols(member.table);
    // Overlapping columns (besides join col) are dropped from the split
    for (const col of splitCols) {
      if (col === member.join_col) continue;
      if (baseCols.has(col)) {
        // Check if split has different data
        const baseVals = q(`SELECT DISTINCT "${col}" FROM "${base}" WHERE "${col}" IS NOT NULL LIMIT 3`);
        const splitVals = q(`SELECT DISTINCT "${col}" FROM "${member.table}" WHERE "${col}" IS NOT NULL LIMIT 3`);
        if (splitVals.length > 0 && baseVals.length === 0) {
          console.log(`  ⚠ ${member.table}.${col} has data but is shadowed by empty ${base}.${col}`);
          overlapIssues++;
        }
      }
    }
  }
}
console.log(`  ${overlapIssues} shadowed column issues\n`);

db.close();
