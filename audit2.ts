import { Database } from "bun:sqlite";
const db = new Database("ehi_clean.db", { readonly: true });
function q(sql: string, params: unknown[] = []) { return db.query(sql).all(...params) as Record<string,unknown>[]; }

// Flowsheet chain: IP_DATA_STORE.EPT_CSN → PAT_ENC_CSN_ID
// IP_FLWSHT_REC.INPATIENT_DATA_ID → IP_DATA_STORE.INPATIENT_DATA_ID  
// IP_FLWSHT_MEAS.FSD_ID → IP_FLWSHT_REC.FSD_ID
// IP_FLOWSHEET_ROWS.INPATIENT_DATA_ID → IP_DATA_STORE.INPATIENT_DATA_ID
console.log("=== FLOWSHEET CHAIN ===");
const idsFromRec = q(`SELECT DISTINCT r.FSD_ID, r.INPATIENT_DATA_ID, d.EPT_CSN 
  FROM IP_FLWSHT_REC r 
  LEFT JOIN IP_DATA_STORE d ON r.INPATIENT_DATA_ID = d.INPATIENT_DATA_ID`);
console.log(`IP_FLWSHT_REC → IP_DATA_STORE: ${idsFromRec.length} records`);
for (const r of idsFromRec.slice(0,5)) console.log(`  FSD_ID=${r.FSD_ID}, INPATIENT_DATA_ID=${r.INPATIENT_DATA_ID}, EPT_CSN=${r.EPT_CSN}`);

// Check which FSD_IDs have measurements
const measByFSD = q(`SELECT FSD_ID, COUNT(*) as n FROM IP_FLWSHT_MEAS GROUP BY FSD_ID ORDER BY n DESC`);
console.log(`\nFSD_IDs with measurements: ${measByFSD.length}`);
for (const r of measByFSD.slice(0,5)) console.log(`  FSD_ID=${r.FSD_ID}: ${r.n} measurements`);

// What kind of flowsheet data? (names)
const flowNames = q(`SELECT DISTINCT r.FLO_MEAS_ID_DISP_NAME FROM IP_FLOWSHEET_ROWS r WHERE r.FLO_MEAS_ID_DISP_NAME IS NOT NULL ORDER BY r.FLO_MEAS_ID_DISP_NAME`);
console.log(`\n=== FLOWSHEET MEASURE NAMES (${flowNames.length}) ===`);
for (const r of flowNames) console.log(`  ${r.FLO_MEAS_ID_DISP_NAME}`);

// Value check on measurements  
const measValues = q(`SELECT m.FSD_ID, m.LINE, m.RECORDED_TIME, r.FLO_MEAS_ID_DISP_NAME, g.DISP_NAME, m.MEAS_COMMENT
  FROM IP_FLWSHT_MEAS m
  LEFT JOIN IP_FLWSHT_REC rec ON m.FSD_ID = rec.FSD_ID
  LEFT JOIN IP_FLOWSHEET_ROWS r ON rec.INPATIENT_DATA_ID = r.INPATIENT_DATA_ID AND m.LINE = r.LINE
  LEFT JOIN IP_FLO_GP_DATA g ON r.FLO_MEAS_ID = g.FLO_MEAS_ID
  WHERE r.FLO_MEAS_ID_DISP_NAME IS NOT NULL
  LIMIT 20`);
console.log(`\n=== SAMPLE MEASUREMENTS ===`);
for (const m of measValues) {
  console.log(`  ${m.RECORDED_TIME}: ${m.FLO_MEAS_ID_DISP_NAME ?? m.DISP_NAME} = ${m.MEAS_COMMENT ?? '(no value)'}`);
}

// Check: do measures have actual values somewhere? 
console.log("\n=== MEASUREMENT VALUE COLUMNS ===");
const measCols = q(`PRAGMA table_info("IP_FLWSHT_MEAS")`).map(r => r.name as string);
for (const col of measCols) {
  const nn = (q(`SELECT COUNT(*) as n FROM IP_FLWSHT_MEAS WHERE "${col}" IS NOT NULL AND "${col}" != ''`)[0].n as number);
  if (nn > 0) console.log(`  ${col}: ${nn}/192 non-null`);
}

// RTF text sample
console.log("\n=== RTF TEXT SAMPLE ===");
const rtfSample = q(`SELECT MESSAGE_ID, RTF_TEXT FROM MYC_MESG_RTF_TEXT LIMIT 2`);
for (const r of rtfSample) {
  const text = String(r.RTF_TEXT).slice(0, 200);
  console.log(`  MSG ${r.MESSAGE_ID}: ${text}...`);
}

// Messages without plain text but with RTF
const msgsOnlyRTF = q(`SELECT COUNT(*) as n FROM MYC_MESG m 
  WHERE m.MESSAGE_ID NOT IN (SELECT MESSAGE_ID FROM MSG_TXT) 
  AND m.MESSAGE_ID IN (SELECT MESSAGE_ID FROM MYC_MESG_RTF_TEXT)`)[0].n;
console.log(`\nMessages with RTF only (no plain text): ${msgsOnlyRTF}`);

// Coverage children detail
console.log("\n=== COVERAGE TABLE DETAIL ===");
const covCols = q(`PRAGMA table_info("COVERAGE")`).map(r => r.name as string);
for (const col of covCols) {
  const nn = (q(`SELECT COUNT(*) as n FROM COVERAGE WHERE "${col}" IS NOT NULL AND "${col}" != ''`)[0].n as number);
  if (nn > 0) console.log(`  COVERAGE.${col}: ${nn} non-null`);
}

db.close();
