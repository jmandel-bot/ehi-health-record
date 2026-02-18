/**
 * Errors that pass StrictRow silently — the column exists, the access
 * succeeds, but the result is wrong.
 */
import { Database } from "bun:sqlite";
const db = new Database("ehi_clean.db", { readonly: true });
function q(sql: string, p: unknown[] = []) { return db.query(sql).all(...p) as Record<string,unknown>[]; }
function tableCols(t: string) { return q(`PRAGMA table_info("${t}")`).map(r => r.name as string); }

console.log("════════════════════════════════════════════════════════════");
console.log("ERROR CLASS 1: Right column name, wrong table");
console.log("════════════════════════════════════════════════════════════\n");

// DESCRIPTION exists on ORDER_PROC, ORDER_MED, and others.
// If you read it from the wrong entity's row, you get a value — just the wrong one.
const descTables: string[] = [];
for (const t of q("SELECT name FROM sqlite_master WHERE type='table'").map(r => r.name as string)) {
  if (tableCols(t).includes('DESCRIPTION')) {
    const nn = (q(`SELECT COUNT(*) as n FROM "${t}" WHERE DESCRIPTION IS NOT NULL AND DESCRIPTION != ''`)[0].n as number);
    if (nn > 0) descTables.push(`${t} (${nn})`);
  }
}
console.log(`DESCRIPTION exists with data in: ${descTables.join(', ')}`);
console.log(`→ StrictRow says "fine" on any of them. Only manifest/codegen catches wrong-table reads.\n`);

// CONTACT_DATE is on 20+ tables with completely different meanings
const contactDateTables: string[] = [];
for (const t of q("SELECT name FROM sqlite_master WHERE type='table'").map(r => r.name as string)) {
  if (tableCols(t).includes('CONTACT_DATE')) {
    const nn = (q(`SELECT COUNT(*) as n FROM "${t}" WHERE CONTACT_DATE IS NOT NULL`)[0].n as number);
    if (nn > 0) contactDateTables.push(t);
  }
}
console.log(`CONTACT_DATE exists in ${contactDateTables.length} tables`);

console.log("\n════════════════════════════════════════════════════════════");
console.log("ERROR CLASS 2: Column exists, value is wrong type/semantics");
console.log("════════════════════════════════════════════════════════════\n");

// SMOKING_TOB_USE_C is a category INTEGER code, not a display name
const smoking = q(`SELECT SMOKING_TOB_USE_C, TOBACCO_USER_C_NAME FROM SOCIAL_HX LIMIT 1`)[0];
console.log(`SMOKING_TOB_USE_C = ${smoking.SMOKING_TOB_USE_C} (raw category code)`);
console.log(`TOBACCO_USER_C_NAME = ${smoking.TOBACCO_USER_C_NAME} (human-readable name)`);
console.log(`→ Both exist on the row. StrictRow passes. But treating the code as a display value is wrong.\n`);

// SEVERITY_C_NAME vs ALLERGY_SEVERITY_C_NAME — both exist, mean different things
const allergy = q(`SELECT SEVERITY_C_NAME, ALLERGY_SEVERITY_C_NAME FROM ALLERGY LIMIT 1`)[0];
console.log(`ALLERGY.SEVERITY_C_NAME = "${allergy.SEVERITY_C_NAME}" (severity category: Allergy vs Drug vs Food)`);
console.log(`ALLERGY.ALLERGY_SEVERITY_C_NAME = "${allergy.ALLERGY_SEVERITY_C_NAME}" (clinical severity: High/Medium/Low)`);
console.log(`→ Code uses (raw.ALLERGY_SEVERITY_C_NAME ?? raw.SEVERITY_C_NAME) — fallback conflates two different fields.\n`);

console.log("════════════════════════════════════════════════════════════");
console.log("ERROR CLASS 3: Wrong join — FK matches by coincidence");
console.log("════════════════════════════════════════════════════════════\n");

// ORDER_PROC_ID and ORDER_ID are usually equal but sometimes differ
const orderIdDiff = q(`
  SELECT COUNT(*) as n FROM ORDER_PROC 
  WHERE ORDER_PROC_ID != PROC_ID
`)[0].n;
console.log(`ORDER_PROC rows where ORDER_PROC_ID != PROC_ID: ${orderIdDiff}`);

// In this export ORDER_ID always equals ORDER_PROC_ID on ORDER_PROC children,
// but the ChildSpec for ORDER_COMMENT uses ORDER_PROC_ID which doesn't exist.
// Broader issue: any FK join that works on this 1-patient dataset might fail
// on a dataset where IDs diverge.
const orderCommentIds = q(`SELECT DISTINCT ORDER_ID FROM ORDER_COMMENT`).map(r => r.ORDER_ID);
const orderProcIds = new Set(q(`SELECT ORDER_PROC_ID FROM ORDER_PROC`).map(r => r.ORDER_PROC_ID));
const commentsMatchingOrders = orderCommentIds.filter(id => orderProcIds.has(id));
console.log(`ORDER_COMMENT.ORDER_ID values: ${orderCommentIds.length}, matching ORDER_PROC: ${commentsMatchingOrders.length}`);
console.log(`→ Join works here because ORDER_ID == ORDER_PROC_ID. In other datasets, may diverge.\n`);

console.log("════════════════════════════════════════════════════════════");
console.log("ERROR CLASS 4: Structural misclassification");  
console.log("════════════════════════════════════════════════════════════\n");

// Is FAMILY_HX a child of PAT_ENC (structural) or patient-level (provenance)?
// Code nests it under encounters as encounterChildren. But FAMILY_HX rows
// are patient-level versioned snapshots — the CSN is provenance, not ownership.
const fhx = q(`SELECT PAT_ENC_CSN_ID, COUNT(*) as n FROM FAMILY_HX GROUP BY PAT_ENC_CSN_ID`);
console.log(`FAMILY_HX: ${fhx.length} distinct CSNs, rows per CSN: ${fhx.map(r => r.n).join(', ')}`);
console.log(`→ These are history snapshots grouped by review contact, not encounter children.`);
console.log(`   Nesting under encounters means the same family history appears on multiple visits.`);
console.log(`   It's also projected separately as family_history (HistoryTimeline).`);
console.log(`   The encounter attachment is intentional metadata, but a reader might misinterpret.\n`);

console.log("════════════════════════════════════════════════════════════");
console.log("ERROR CLASS 5: Lossy transformation pipeline");
console.log("════════════════════════════════════════════════════════════\n");

// PatientRecord.OrderResult reads raw.COMPONENT_ID_NAME
// HealthRecord.projectResult reads res.COMPONENT_ID_COMPONENT_NAME
// These are two DIFFERENT column names for the same concept.
// PatientRecord is correct (column exists), HealthRecord is wrong (phantom).
console.log(`ORDER_RESULTS has: COMPONENT_ID_NAME (${tableCols("ORDER_RESULTS").includes("COMPONENT_ID_NAME")})`);
console.log(`PatientRecord reads: raw.COMPONENT_ID_NAME (correct)`);
console.log(`PatientRecord stores as: this.componentName`);
console.log(`HealthRecord reads: res.COMPONENT_ID_COMPONENT_NAME (phantom!)`);
console.log(`→ The value is there in PatientRecord but HealthRecord reads the wrong property.`);
console.log(`   StrictRow can't help because HealthRecord reads from hydrated TS objects, not DB rows.\n`);

// Message body: project.ts correctly attaches MSG_TXT as msg.text = [...]
// PatientRecord.Message correctly reads raw.text
// HealthRecord.projectMessage reads m.MESSAGE_TEXT (phantom column)
// instead of joining the text array
console.log(`Message pipeline:`);
console.log(`  project.ts: msg.text = children("MSG_TXT", "MESSAGE_ID", msg.MESSAGE_ID) ✓`);
console.log(`  PatientRecord: this.text = raw.text as EpicRow[] ✓`);
console.log(`  HealthRecord: body = str(m.MESSAGE_TEXT) ✗ — should be m.text.map(t => t.MSG_TXT).join('')`);

console.log("\n════════════════════════════════════════════════════════════");
console.log("ERROR CLASS 6: Aggregation / dedup errors");
console.log("════════════════════════════════════════════════════════════\n");

// projectFamilyHistory picks "best CSN" by row count. If two snapshots
// have equal row counts, it picks arbitrarily.
const fhxByCSN = q(`SELECT PAT_ENC_CSN_ID, COUNT(*) as n FROM FAMILY_HX GROUP BY PAT_ENC_CSN_ID ORDER BY n DESC`);
console.log("FAMILY_HX rows per CSN:", fhxByCSN.map(r => `CSN ${r.PAT_ENC_CSN_ID}: ${r.n}`).join(', '));
const topCount = fhxByCSN[0]?.n;
const ties = fhxByCSN.filter(r => r.n === topCount);
console.log(`Top count: ${topCount}, CSNs with that count: ${ties.length}`);
if (ties.length > 1) console.log(`→ TIE: family history snapshot selection is non-deterministic.`);

// HistoryTimeline sorts by array order (insertion order from SQL).
// If SQL doesn't ORDER BY, snapshot order is undefined.
console.log(`\nSOCIAL_HX query: SELECT * FROM SOCIAL_HX (no ORDER BY)`);
console.log(`→ .latest() returns last element. Without ORDER BY, "latest" is whatever SQLite gives.\n`);

console.log("════════════════════════════════════════════════════════════");
console.log("SUMMARY: Error classes and what catches them");
console.log("════════════════════════════════════════════════════════════\n");

console.log("Class 1: Right column, wrong table     → Codegen types (Layer 3)");
console.log("Class 2: Column exists, wrong semantics → Schema descriptions + human review");
console.log("Class 3: FK matches by coincidence      → Multi-dataset FK integrity tests");
console.log("Class 4: Structural misclassification   → Schema description review + domain knowledge");
console.log("Class 5: Cross-layer pipeline mismatch  → End-to-end output assertions");
console.log("Class 6: Aggregation nondeterminism     → ORDER BY in all queries + deterministic tie-breaking");

db.close();
