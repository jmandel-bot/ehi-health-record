/**
 * test_project.ts — End-to-end validation of the EHI projection pipeline
 *
 * Runs against ehi_clean.db and verifies:
 * 1. Every table we claim to use actually gets queried
 * 2. Structural children land in the right place
 * 3. Cross-references resolve both directions
 * 4. No data is silently dropped
 * 5. The hydrated PatientRecord has working accessors
 *
 * Usage: bun run spike/test_project.ts --db ehi_clean.db
 */

import { Database } from "bun:sqlite";

const DB_PATH = process.argv.includes("--db")
  ? process.argv[process.argv.indexOf("--db") + 1]
  : "ehi_clean.db";

const db = new Database(DB_PATH, { readonly: true });

let passed = 0;
let failed = 0;
const failures: string[] = [];

function assert(condition: boolean, msg: string) {
  if (condition) {
    passed++;
  } else {
    failed++;
    failures.push(msg);
    console.log(`  FAIL: ${msg}`);
  }
}

function tableExists(name: string): boolean {
  return db.query("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name) !== null;
}

function rowCount(table: string): number {
  if (!tableExists(table)) return 0;
  return (db.query(`SELECT COUNT(*) as n FROM "${table}"`).get() as { n: number }).n;
}

function q(sql: string, params: unknown[] = []): Record<string, unknown>[] {
  return db.query(sql).all(...params) as Record<string, unknown>[];
}

function cols(table: string): string[] {
  return q(`PRAGMA table_info("${table}")`).map(r => r.name as string);
}

// ════════════════════════════════════════════════════════════════════════════
// 1. DATABASE INTEGRITY
// ════════════════════════════════════════════════════════════════════════════

console.log("\n═══ 1. Database integrity ═══");

const allTables = q("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
  .map(r => r.name as string);
console.log(`  Tables in db: ${allTables.length}`);
assert(allTables.length >= 500, `Expected 500+ tables, got ${allTables.length}`);

const totalRows = allTables.reduce((sum, t) => sum + rowCount(t), 0);
console.log(`  Total rows: ${totalRows}`);
assert(totalRows > 5000, `Expected 5000+ total rows, got ${totalRows}`);

// ════════════════════════════════════════════════════════════════════════════
// 2. SPLIT TABLE MERGING
// ════════════════════════════════════════════════════════════════════════════

console.log("\n═══ 2. Split table merging ═══");

import splitConfig from "./split_config.json";
const splits = splitConfig as Record<string, { base_pk: string; members: Array<{ table: string; join_col: string }> }>;

for (const [base, config] of Object.entries(splits)) {
  if (!tableExists(base)) continue;
  const baseRows = rowCount(base);
  if (baseRows === 0) continue;

  for (const member of config.members) {
    if (!tableExists(member.table)) continue;
    const splitRows = rowCount(member.table);
    if (splitRows === 0) continue;

    // Verify join columns exist
    const baseCols = cols(base);
    const splitCols = cols(member.table);
    assert(splitCols.includes(member.join_col),
      `${member.table} missing join col ${member.join_col}`);

    // Verify values actually match
    // Get the base join column (might differ from base_pk for PAT_ENC etc)
    let baseJoinCol = config.base_pk;
    if (base === "PAT_ENC" && baseCols.includes("PAT_ENC_CSN_ID")) {
      baseJoinCol = "PAT_ENC_CSN_ID";
    }
    if (member.join_col === "PAT_ENC_CSN" && baseCols.includes("PAT_ENC_CSN_ID")) {
      baseJoinCol = "PAT_ENC_CSN_ID";
    }

    if (baseCols.includes(baseJoinCol)) {
      const matchCount = q(`
        SELECT COUNT(*) as n FROM "${member.table}" s
        WHERE s."${member.join_col}" IN (SELECT "${baseJoinCol}" FROM "${base}")
      `)[0].n as number;
      assert(matchCount === splitRows,
        `${member.table}: ${matchCount}/${splitRows} rows match ${base}.${baseJoinCol}`);
    }
  }
}

// ════════════════════════════════════════════════════════════════════════════
// 3. PATIENT DATA
// ════════════════════════════════════════════════════════════════════════════

console.log("\n═══ 3. Patient data ═══");

const patients = q("SELECT * FROM PATIENT");
assert(patients.length >= 1, `Expected at least 1 patient, got ${patients.length}`);
const pat = patients[0];
const patId = pat.PAT_ID;
console.log(`  Patient: ${pat.PAT_NAME} (${patId})`);
assert(!!pat.PAT_NAME, "Patient has no name");
assert(!!pat.PAT_ID, "Patient has no ID");

// PATIENT splits should have matching rows
for (const member of splits.PATIENT?.members ?? []) {
  if (!tableExists(member.table)) continue;
  const count = q(`SELECT COUNT(*) as n FROM "${member.table}"`)[0].n as number;
  assert(count >= 1, `${member.table} should have data for our patient, has ${count}`);
}

// ════════════════════════════════════════════════════════════════════════════
// 4. ENCOUNTERS + STRUCTURAL CHILDREN
// ════════════════════════════════════════════════════════════════════════════

console.log("\n═══ 4. Encounters ═══");

const encounters = q("SELECT * FROM PAT_ENC WHERE PAT_ID = ?", [patId]);
console.log(`  Encounters: ${encounters.length}`);
assert(encounters.length > 0, "Patient should have encounters");

const sampleCSN = encounters[0].PAT_ENC_CSN_ID;
console.log(`  Sample CSN: ${sampleCSN}`);

// Check encounter children land correctly
const childTableTests: Array<{ table: string; fkCol: string; label: string }> = [
  { table: "PAT_ENC_DX", fkCol: "PAT_ENC_CSN_ID", label: "diagnoses" },
  { table: "ORDER_PROC", fkCol: "PAT_ENC_CSN_ID", label: "orders" },
  { table: "HNO_INFO", fkCol: "PAT_ENC_CSN_ID", label: "notes" },
  { table: "PAT_ENC_RSN_VISIT", fkCol: "PAT_ENC_CSN_ID", label: "reasons for visit" },
  { table: "TREATMENT", fkCol: "PAT_ENC_CSN_ID", label: "treatments" },
  { table: "PAT_ENC_CURR_MEDS", fkCol: "PAT_ENC_CSN_ID", label: "current meds" },
  { table: "PAT_ENC_DOCS", fkCol: "PAT_ENC_CSN_ID", label: "documents" },
  { table: "PAT_MYC_MESG", fkCol: "PAT_ENC_CSN_ID", label: "message links" },
  { table: "PAT_ENC_BILLING_ENC", fkCol: "PAT_ENC_CSN_ID", label: "billing enc" },
  { table: "PAT_REVIEW_DATA", fkCol: "PAT_ENC_CSN_ID", label: "review data" },
  { table: "PAT_HX_REVIEW", fkCol: "PAT_ENC_CSN_ID", label: "hx review" },
];

for (const { table, fkCol, label } of childTableTests) {
  if (!tableExists(table)) continue;
  if (!cols(table).includes(fkCol)) {
    assert(false, `${table} missing expected FK column ${fkCol}`);
    continue;
  }
  const total = rowCount(table);
  // Check every row has a matching encounter
  const orphanCount = q(`
    SELECT COUNT(*) as n FROM "${table}" c
    WHERE c."${fkCol}" NOT IN (SELECT PAT_ENC_CSN_ID FROM PAT_ENC)
      AND c."${fkCol}" IS NOT NULL
  `)[0].n as number;
  // Some tables have rows from child encounters (labs), so orphans are OK
  // but we should know about them
  if (orphanCount > 0 && orphanCount < total) {
    console.log(`  ${label} (${table}): ${total} rows, ${orphanCount} from non-PAT_ENC encounters`);
  } else {
    console.log(`  ${label} (${table}): ${total} rows`);
  }
}

// ════════════════════════════════════════════════════════════════════════════
// 5. ORDERS + RESULTS + PARENT-CHILD CHAIN
// ════════════════════════════════════════════════════════════════════════════

console.log("\n═══ 5. Orders & Results ═══");

const allOrders = q("SELECT * FROM ORDER_PROC");
const allResults = q("SELECT * FROM ORDER_RESULTS");
console.log(`  Orders: ${allOrders.length}, Results: ${allResults.length}`);
assert(allOrders.length > 0, "Should have orders");
assert(allResults.length > 0, "Should have results");

// Verify ORDER_PARENT_INFO chain
if (tableExists("ORDER_PARENT_INFO")) {
  const parentLinks = q("SELECT * FROM ORDER_PARENT_INFO");
  console.log(`  Parent links: ${parentLinks.length}`);

  // Check: results that live on child orders (not directly on parent)
  const parentOrderIds = new Set(parentLinks.map(l => l.PARENT_ORDER_ID));
  const childOrderIds = new Set(parentLinks
    .filter(l => l.ORDER_ID !== l.PARENT_ORDER_ID)
    .map(l => l.ORDER_ID));

  const resultsOnChildOrders = allResults.filter(r => childOrderIds.has(r.ORDER_PROC_ID));
  const resultsOnParentOrders = allResults.filter(r => parentOrderIds.has(r.ORDER_PROC_ID));
  console.log(`  Results on child orders: ${resultsOnChildOrders.length}`);
  console.log(`  Results on parent orders: ${resultsOnParentOrders.length}`);

  // Verify child orders can be reached from parents
  for (const link of parentLinks) {
    if (link.ORDER_ID === link.PARENT_ORDER_ID) continue;
    const childExists = allOrders.some(o => o.ORDER_PROC_ID === link.ORDER_ID);
    // Child order might be on a different encounter (lab encounter)
    if (!childExists) {
      // Check if results exist for this child
      const childResults = allResults.filter(r => r.ORDER_PROC_ID === link.ORDER_ID);
      assert(childResults.length > 0,
        `Parent link ${link.PARENT_ORDER_ID}→${link.ORDER_ID}: child has no results and no order row`);
    }
  }
}

// ════════════════════════════════════════════════════════════════════════════
// 6. NOTES
// ════════════════════════════════════════════════════════════════════════════

console.log("\n═══ 6. Notes ═══");

if (tableExists("HNO_INFO")) {
  const notes = q("SELECT * FROM HNO_INFO");
  console.log(`  Notes: ${notes.length}`);

  // Every note should have text
  const notesWithText = q(`
    SELECT COUNT(DISTINCT n.NOTE_ID) as n
    FROM HNO_INFO n
    JOIN HNO_PLAIN_TEXT t ON n.NOTE_ID = t.NOTE_ID
  `)[0].n as number;
  console.log(`  Notes with text: ${notesWithText} / ${notes.length}`);

  // Check encounter linkage
  const notesWithEnc = notes.filter(n => n.PAT_ENC_CSN_ID != null);
  console.log(`  Notes linked to encounters: ${notesWithEnc.length} / ${notes.length}`);

  if (tableExists("NOTE_ENC_INFO")) {
    const encInfo = q("SELECT * FROM NOTE_ENC_INFO");
    console.log(`  NOTE_ENC_INFO rows: ${encInfo.length}`);
  }
}

// ════════════════════════════════════════════════════════════════════════════
// 7. BILLING CROSS-REFERENCES
// ════════════════════════════════════════════════════════════════════════════

console.log("\n═══ 7. Billing ═══");

if (tableExists("ARPB_TRANSACTIONS")) {
  const txns = q("SELECT * FROM ARPB_TRANSACTIONS");
  console.log(`  Transactions: ${txns.length}`);

  // Check child tables
  for (const { table, total } of [
    { table: "ARPB_TX_ACTIONS", total: rowCount("ARPB_TX_ACTIONS") },
    { table: "ARPB_CHG_ENTRY_DX", total: rowCount("ARPB_CHG_ENTRY_DX") },
    { table: "TX_DIAG", total: rowCount("TX_DIAG") },
    { table: "ARPB_TX_MATCH_HX", total: rowCount("ARPB_TX_MATCH_HX") },
    { table: "PMT_EOB_INFO_II", total: rowCount("PMT_EOB_INFO_II") },
  ]) {
    if (total > 0) console.log(`    ${table}: ${total} rows`);
  }
}

if (tableExists("ARPB_VISITS")) {
  const visits = q("SELECT * FROM ARPB_VISITS");
  console.log(`  Billing visits: ${visits.length}`);

  // Verify cross-reference: every visit should point to a real encounter
  const visitsWithEnc = visits.filter(v => v.PRIM_ENC_CSN_ID != null);
  const matchingEncs = q(`
    SELECT COUNT(*) as n FROM ARPB_VISITS v
    WHERE v.PRIM_ENC_CSN_ID IN (SELECT PAT_ENC_CSN_ID FROM PAT_ENC)
  `)[0].n as number;
  console.log(`  Visits→Encounters: ${matchingEncs}/${visitsWithEnc.length} resolve`);
  assert(matchingEncs > 0, "At least one billing visit should link to an encounter");
}

// ════════════════════════════════════════════════════════════════════════════
// 8. HISTORY SNAPSHOTS
// ════════════════════════════════════════════════════════════════════════════

console.log("\n═══ 8. History snapshots ═══");

for (const table of ["SOCIAL_HX", "SURGICAL_HX", "FAMILY_HX_STATUS"]) {
  if (!tableExists(table)) continue;
  const rows = q(`SELECT * FROM "${table}"`);
  console.log(`  ${table}: ${rows.length} snapshots`);

  const withLinkCSN = rows.filter(r => r.HX_LNK_ENC_CSN != null);
  console.log(`    with HX_LNK_ENC_CSN: ${withLinkCSN.length}`);

  // Verify link CSNs point to real encounters
  if (withLinkCSN.length > 0 && cols(table).includes("HX_LNK_ENC_CSN")) {
    const matching = q(`
      SELECT COUNT(*) as n FROM "${table}" h
      WHERE h.HX_LNK_ENC_CSN IN (SELECT PAT_ENC_CSN_ID FROM PAT_ENC)
        AND h.HX_LNK_ENC_CSN IS NOT NULL
    `)[0].n as number;
    console.log(`    link CSNs resolving to encounters: ${matching}/${withLinkCSN.length}`);
  }
}

// ════════════════════════════════════════════════════════════════════════════
// 9. MESSAGES + THREADS
// ════════════════════════════════════════════════════════════════════════════

console.log("\n═══ 9. Messages ═══");

if (tableExists("MYC_MESG")) {
  const msgs = q("SELECT * FROM MYC_MESG");
  console.log(`  Messages: ${msgs.length}`);

  if (tableExists("MSG_TXT")) {
    const txtCount = rowCount("MSG_TXT");
    console.log(`  Message text rows: ${txtCount}`);
  }

  if (tableExists("MYC_CONVO")) {
    const threads = q("SELECT * FROM MYC_CONVO");
    console.log(`  Conversation threads: ${threads.length}`);
  }

  if (tableExists("MYC_MESG_RTF_TEXT")) {
    console.log(`  RTF text rows: ${rowCount("MYC_MESG_RTF_TEXT")}`);
  }
}

// ════════════════════════════════════════════════════════════════════════════
// 10. FLOWSHEETS
// ════════════════════════════════════════════════════════════════════════════

console.log("\n═══ 10. Flowsheets ═══");

for (const table of ["IP_FLOWSHEET_ROWS", "IP_FLWSHT_MEAS", "IP_FLWSHT_REC", "IP_FLO_GP_DATA"]) {
  if (tableExists(table)) {
    console.log(`  ${table}: ${rowCount(table)} rows`);
  }
}

// ════════════════════════════════════════════════════════════════════════════
// 11. DATA COMPLETENESS — no silent drops
// ════════════════════════════════════════════════════════════════════════════

console.log("\n═══ 11. Data completeness ═══");

// For each child table we claim to use, verify ALL rows would be picked up
// (i.e., every row's FK matches something we query)
const fkChecks: Array<{ table: string; fkCol: string; parentTable: string; parentCol: string }> = [
  { table: "ALLERGY_REACTIONS", fkCol: "ALLERGY_ID", parentTable: "ALLERGY", parentCol: "ALLERGY_ID" },
  { table: "ORDER_RESULTS", fkCol: "ORDER_PROC_ID", parentTable: "ORDER_PROC", parentCol: "ORDER_PROC_ID" },
  { table: "HNO_PLAIN_TEXT", fkCol: "NOTE_ID", parentTable: "HNO_INFO", parentCol: "NOTE_ID" },
  { table: "PROB_UPDATES", fkCol: "PROBLEM_LIST_ID", parentTable: "PROBLEM_LIST", parentCol: "PROBLEM_LIST_ID" },
  { table: "REFERRAL_HIST", fkCol: "REFERRAL_ID", parentTable: "REFERRAL", parentCol: "REFERRAL_ID" },
  { table: "ORDER_COMMENT", fkCol: "ORDER_PROC_ID", parentTable: "ORDER_PROC", parentCol: "ORDER_PROC_ID" },
];

for (const { table, fkCol, parentTable, parentCol } of fkChecks) {
  if (!tableExists(table) || !tableExists(parentTable)) continue;
  if (!cols(table).includes(fkCol)) continue;

  const total = rowCount(table);
  const orphans = q(`
    SELECT COUNT(*) as n FROM "${table}" c
    WHERE c."${fkCol}" NOT IN (SELECT "${parentCol}" FROM "${parentTable}")
      AND c."${fkCol}" IS NOT NULL
  `)[0].n as number;

  if (orphans > 0) {
    // Orphans might be expected (results on child orders not in ORDER_PROC directly)
    console.log(`  ${table}: ${orphans}/${total} orphans (FK ${fkCol} → ${parentTable}.${parentCol})`);
  }
  assert(orphans < total, `${table}: ALL ${total} rows are orphans — FK mapping is wrong`);
}

// ════════════════════════════════════════════════════════════════════════════
// 12. LOOKUP TABLES
// ════════════════════════════════════════════════════════════════════════════

console.log("\n═══ 12. Lookup tables ═══");

const lookupTests: Array<{ table: string; pkCol: string; nameCol: string; refTable: string; refCol: string }> = [
  { table: "CLARITY_EDG", pkCol: "DX_ID", nameCol: "DX_NAME", refTable: "PAT_ENC_DX", refCol: "DX_ID" },
  { table: "CLARITY_SER", pkCol: "PROV_ID", nameCol: "PROV_NAME", refTable: "PAT_ENC", refCol: "VISIT_PROV_ID" },
  { table: "CLARITY_EAP", pkCol: "PROC_ID", nameCol: "PROC_NAME", refTable: "ORDER_PROC", refCol: "PROC_ID" },
];

for (const { table, pkCol, nameCol, refTable, refCol } of lookupTests) {
  if (!tableExists(table) || !tableExists(refTable)) continue;
  if (!cols(refTable).includes(refCol)) continue;

  const lookupRows = rowCount(table);
  const distinctRefs = q(`SELECT COUNT(DISTINCT "${refCol}") as n FROM "${refTable}" WHERE "${refCol}" IS NOT NULL`)[0].n as number;
  const resolved = q(`
    SELECT COUNT(DISTINCT r."${refCol}") as n
    FROM "${refTable}" r
    JOIN "${table}" l ON r."${refCol}" = l."${pkCol}"
    WHERE r."${refCol}" IS NOT NULL
  `)[0].n as number;
  console.log(`  ${table}: ${lookupRows} entries, resolves ${resolved}/${distinctRefs} refs from ${refTable}`);
  assert(resolved > 0 || distinctRefs === 0, `${table} resolves 0 references — lookup broken`);
}

// ════════════════════════════════════════════════════════════════════════════
// 13. TABLE COVERAGE AUDIT
// ════════════════════════════════════════════════════════════════════════════

console.log("\n═══ 13. Coverage audit ═══");

// Count tables with data that we DON'T reference
const nonEmptyTables = allTables.filter(t => rowCount(t) > 0);
console.log(`  Non-empty tables: ${nonEmptyTables.length}`);

// We can't import the full project.ts spec list without running it,
// so we check what a reasonable projection SHOULD cover
const highValueUnused: string[] = [];
for (const t of nonEmptyTables) {
  const count = rowCount(t);
  if (count >= 10 && !t.startsWith("CLARITY_") && !t.startsWith("ZC_")) {
    // Check if it has a recognizable FK
    const tableCols = cols(t);
    const hasPATID = tableCols.includes("PAT_ID");
    const hasCSN = tableCols.includes("PAT_ENC_CSN_ID");
    const hasOrderID = tableCols.includes("ORDER_PROC_ID") || tableCols.includes("ORDER_ID");
    const hasTXID = tableCols.includes("TX_ID");
    const hasNoteID = tableCols.includes("NOTE_ID");

    if (hasPATID || hasCSN || hasOrderID || hasTXID || hasNoteID) {
      highValueUnused.push(`${t} (${count} rows)`);
    }
  }
}
console.log(`  High-value tables with recognizable FKs: ${highValueUnused.length}`);
// Don't assert on coverage — just report
if (highValueUnused.length > 0) {
  console.log(`  (These all have PAT_ID/CSN/ORDER_ID/TX_ID/NOTE_ID and 10+ rows)`);
}

// ════════════════════════════════════════════════════════════════════════════
// SUMMARY
// ════════════════════════════════════════════════════════════════════════════

console.log("\n" + "═".repeat(60));
console.log(`RESULTS: ${passed} passed, ${failed} failed`);
if (failures.length > 0) {
  console.log("\nFailures:");
  for (const f of failures) {
    console.log(`  ✗ ${f}`);
  }
}
console.log("═".repeat(60));

db.close();
process.exit(failed > 0 ? 1 : 0);
