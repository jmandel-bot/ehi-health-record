import { Database } from "bun:sqlite";
const db = new Database("ehi_clean.db", { readonly: true });
function q(sql: string, p: unknown[] = []) { return db.query(sql).all(...p) as Record<string,unknown>[]; }
function tableCols(t: string) { return q(`PRAGMA table_info("${t}")`).map(r => r.name as string); }

// Social HX - actual column names
console.log("SOCIAL_HX all cols with data:");
for (const c of tableCols("SOCIAL_HX")) {
  const nn = (q(`SELECT COUNT(*) as n FROM SOCIAL_HX WHERE "${c}" IS NOT NULL AND "${c}" != ''`)[0].n as number);
  if (nn > 0) console.log(`  ${c}: ${nn}/5`);
}

console.log("\nSOCIAL_HX sample row:");
const sh = q(`SELECT * FROM SOCIAL_HX LIMIT 1`)[0];
for (const [k,v] of Object.entries(sh)) {
  if (v != null && v !== '') console.log(`  ${k} = ${v}`);
}

// MSG_TXT
console.log("\nMSG_TXT cols:", tableCols("MSG_TXT"));
console.log("MSG_TXT sample:", q(`SELECT * FROM MSG_TXT LIMIT 1`));

// MYC_MESG message-level fields
console.log("\nMYC_MESG cols with data:");
for (const c of tableCols("MYC_MESG")) {
  const nn = (q(`SELECT COUNT(*) as n FROM MYC_MESG WHERE "${c}" IS NOT NULL AND "${c}" != ''`)[0].n as number);
  if (nn > 0) console.log(`  ${c}: ${nn}/63`);
}

// PATIENT split tables - where's marital status, address line 1?
for (const t of ['PATIENT','PATIENT_2','PATIENT_3','PATIENT_4','PATIENT_5','PATIENT_6']) {
  const cols = tableCols(t);
  const interesting = cols.filter(c => c.includes('MARIT') || c.includes('ADD_LINE') || c.includes('ADDRESS'));
  if (interesting.length) console.log(`\n${t} address/marital:`, interesting);
}

// Check PAT_ADDRESS table
console.log("\nPAT_ADDRESS cols:", tableCols("PAT_ADDRESS"));
console.log("PAT_ADDRESS sample:", q(`SELECT * FROM PAT_ADDRESS LIMIT 1`));

// ARPB_TRANSACTIONS - payor name
console.log("\nARPB_TRANSACTIONS payor cols:", tableCols("ARPB_TRANSACTIONS").filter(c => c.includes('PAYOR') || c.includes('NAME')));
const txSample = q(`SELECT PAYOR_ID FROM ARPB_TRANSACTIONS WHERE PAYOR_ID IS NOT NULL LIMIT 1`);
if (txSample.length) {
  console.log("PAYOR_ID:", txSample[0].PAYOR_ID);
  const epm = q(`SELECT * FROM CLARITY_EPM WHERE PAYOR_ID = ?`, [txSample[0].PAYOR_ID]);
  console.log("CLARITY_EPM lookup:", epm);
}

db.close();
