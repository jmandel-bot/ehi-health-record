import { Database } from "bun:sqlite";
const db = new Database("ehi_clean.db", { readonly: true });
function q(sql: string, params: unknown[] = []) { return db.query(sql).all(...params) as Record<string,unknown>[]; }
function cols(t: string) { return q(`PRAGMA table_info("${t}")`).map(r => r.name as string); }

// RTF columns
console.log("=== MYC_MESG_RTF_TEXT columns ===");
console.log(cols("MYC_MESG_RTF_TEXT"));
const rtfSample = q(`SELECT * FROM MYC_MESG_RTF_TEXT LIMIT 1`);
for (const [k,v] of Object.entries(rtfSample[0])) {
  console.log(`  ${k}: ${String(v).slice(0,150)}`);
}

// Where are flowsheet VALUES stored?
// Check IP_FLT_DATA (flowsheet template data)
console.log("\n=== IP_FLT_DATA ===");
console.log(cols("IP_FLT_DATA"));
const fltSample = q(`SELECT * FROM IP_FLT_DATA LIMIT 3`);
for (const r of fltSample) {
  const vals = Object.entries(r).filter(([,v]) => v != null && v !== '').map(([k,v]) => `${k}=${String(v).slice(0,50)}`);
  console.log(`  ${vals.join(', ')}`);
}

// Check FLWSHT_SINGL_COL
console.log("\n=== FLWSHT_SINGL_COL ===");
console.log(cols("FLWSHT_SINGL_COL"));
for (const r of q(`SELECT * FROM FLWSHT_SINGL_COL LIMIT 3`)) {
  const vals = Object.entries(r).filter(([,v]) => v != null && v !== '').map(([k,v]) => `${k}=${String(v).slice(0,50)}`);
  console.log(`  ${vals.join(', ')}`);
}

// The actual values - check if they're in a column called MEAS_VALUE
console.log("\n=== IP_FLWSHT_MEAS value search ===");
for (const col of cols("IP_FLWSHT_MEAS")) {
  if (col.includes('VALUE') || col.includes('MEAS') || col.includes('RESULT')) {
    const nn = (q(`SELECT COUNT(*) as n FROM IP_FLWSHT_MEAS WHERE "${col}" IS NOT NULL AND "${col}" != ''`)[0].n as number);
    console.log(`  ${col}: ${nn}/192 non-null`);
  }
}

// Wait - the actual values might be in IP_FLO_GP_DATA or IP_FLOWSHEET_ROWS
// Or maybe the measurement value is MEAS_COMMENT which was null...
// Let me check if there's a "MEAS_VALUE" table or something
const tables = q("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE '%MEAS%'").map(r => r.name as string);
console.log("\nTables with MEAS in name:", tables);

// Check if flowsheet values are truly missing from this export
// (EHI redaction sometimes strips values but keeps metadata)
const allFlowCols = cols("IP_FLWSHT_MEAS");
console.log("\nALL IP_FLWSHT_MEAS columns:", allFlowCols);

// Check the EHI standard - does IP_FLWSHT_MEAS have MEAS_VALUE?
// Looking at schema
const fs = await Bun.file("schemas/IP_FLWSHT_MEAS.json").json();
const schemaCols = fs.columns.map((c: any) => c.name);
const schemaOnly = schemaCols.filter((c: string) => !allFlowCols.includes(c));
const dbOnly = allFlowCols.filter((c: string) => !schemaCols.includes(c));
console.log("\nSchema cols not in DB:", schemaOnly);
console.log("DB cols not in schema:", dbOnly);

// MEAS_VALUE should be there per schema
const measValCol = fs.columns.find((c: any) => c.name === 'MEAS_VALUE');
console.log("\nMEAS_VALUE description:", measValCol?.description);

// It IS in the DB schema but all null — redacted!
const measValCount = (q(`SELECT COUNT(*) as n FROM IP_FLWSHT_MEAS WHERE MEAS_VALUE IS NOT NULL AND MEAS_VALUE != ''`)[0].n as number);
console.log(`MEAS_VALUE non-null count: ${measValCount}`);

db.close();
