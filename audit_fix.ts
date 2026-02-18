import { Database } from "bun:sqlite";
const db = new Database("ehi_clean.db", { readonly: true });
function q(sql: string, p: unknown[] = []) { return db.query(sql).all(...p) as Record<string,unknown>[]; }
function tableCols(t: string) { return q(`PRAGMA table_info("${t}")`).map(r => r.name as string); }

// For each phantom, find the RIGHT column name
console.log("=== FIXABLE COLUMN NAME MISMATCHES ===\n");

// demographics.address.street: code uses ADD_LINE_1, but PATIENT has...
const patCols = tableCols("PATIENT");
console.log("PATIENT address cols:", patCols.filter(c => c.includes('ADD') || c.includes('ADDR') || c.includes('LINE')));

// demographics.maritalStatus: code uses MARITAL_STATUS_C_NAME
console.log("PATIENT marital cols:", patCols.filter(c => c.includes('MARIT')));
// It's in a split table
for (const t of ['PATIENT_2','PATIENT_3','PATIENT_4','PATIENT_5','PATIENT_6']) {
  const cols = tableCols(t);
  const match = cols.filter(c => c.includes('MARIT'));
  if (match.length) console.log(`  ${t}:`, match);
}

// demographics.primaryCareProvider: code uses CUR_PCP_PROV_ID_NAME
console.log("\nPATIENT PCP cols:", patCols.filter(c => c.includes('PCP') || c.includes('PROV')));
// It's a provider ID - needs lookup
const pcpId = q(`SELECT CUR_PCP_PROV_ID FROM PATIENT LIMIT 1`)[0]?.CUR_PCP_PROV_ID;
console.log("CUR_PCP_PROV_ID value:", pcpId);
if (pcpId) {
  const prov = q(`SELECT PROV_NAME FROM CLARITY_SER WHERE PROV_ID = ?`, [pcpId]);
  console.log("Resolved via CLARITY_SER:", prov[0]?.PROV_NAME);
}

// demographics.race: code uses race:[] but PATIENT_RACE has data
console.log("\nPATIENT_RACE sample:", q(`SELECT * FROM PATIENT_RACE LIMIT 3`));

// allergies[0].type: ALLERGY_TYPE_C_NAME
console.log("\nALLERGY cols with TYPE:", tableCols("ALLERGY").filter(c => c.includes('TYPE')));
console.log("ALLERGY sample:", q(`SELECT * FROM ALLERGY LIMIT 1`));

// ORDER_RESULTS - reference range + unit
console.log("\nORDER_RESULTS range/unit cols:", tableCols("ORDER_RESULTS").filter(c => 
  c.includes('REFER') || c.includes('UNIT') || c.includes('RANGE') || c.includes('COMP')));
console.log("ORDER_RESULTS sample:", q(`SELECT COMPONENT_ID, COMPONENT_ID_NAME, ORD_VALUE, REFERENCE_UNIT, REFERENCE_LOW, REFERENCE_HIGH FROM ORDER_RESULTS LIMIT 3`));

// ORDER_COMMENT - the FK issue
console.log("\nORDER_COMMENT cols:", tableCols("ORDER_COMMENT"));
console.log("ORDER_COMMENT sample:", q(`SELECT * FROM ORDER_COMMENT LIMIT 2`));

// Social history - smoking fields
console.log("\nSOCIAL_HX smoking cols:", tableCols("SOCIAL_HX").filter(c => c.includes('SMOK') || c.includes('TOBACCO') || c.includes('PACK') || c.includes('QUIT')));
console.log("SOCIAL_HX sample:", q(`SELECT TOBACCO_USER_C_NAME, SMOKING_TOB_USE_C_NAME, CIGARETTES_YN FROM SOCIAL_HX LIMIT 1`));

// Messages - body text
console.log("\nMSG_TXT cols:", tableCols("MSG_TXT"));
console.log("MSG_TXT sample:", q(`SELECT * FROM MSG_TXT LIMIT 2`));

// MYC_MESG status/text
console.log("\nMYC_MESG cols with STATUS:", tableCols("MYC_MESG").filter(c => c.includes('STATUS') || c.includes('TEXT') || c.includes('MSG')));

db.close();
