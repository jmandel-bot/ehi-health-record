import { Database } from "bun:sqlite";
import splitConfig from "./split_config.json";

const db = new Database("ehi_clean.db", { readonly: true });

function q(sql: string, params: unknown[] = []): Record<string, unknown>[] {
  return db.query(sql).all(...params) as Record<string, unknown>[];
}
function cols(t: string): string[] {
  return q(`PRAGMA table_info("${t}")`).map(r => r.name as string);
}
function rowCount(t: string): number {
  return (db.query(`SELECT COUNT(*) as n FROM "${t}"`).get() as {n:number}).n;
}

const allTables = q("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").map(r => r.name as string);

// Gather tables referenced by the spike
const specTables = new Set<string>();

// From split_config
for (const [base, info] of Object.entries(splitConfig as Record<string, {base_pk: string; members: Array<{table: string; join_col: string}>}>)) {
  specTables.add(base);
  for (const m of info.members) specTables.add(m.table);
}

// Manually enumerated root/query tables from project.ts
const roots = [
  'PATIENT', 'PAT_ENC', 'ORDER_PROC', 'ORDER_MED', 'HNO_INFO',
  'ARPB_TRANSACTIONS', 'ACCOUNT', 'ARPB_VISITS', 'HAR_ALL', 'MYC_MESG',
  'REFERRAL', 'COVERAGE', 'CLM_VALUES', 'HSP_ACCOUNT', 'CL_REMIT',
  'ALLERGY', 'PROBLEM_LIST', 'IMMUNE', 'SOCIAL_HX', 'SURGICAL_HX',
  'FAMILY_HX_STATUS', 'DOC_INFORMATION', 'EPISODE', 'PAT_EPISODE',
  'PATIENT_MYC', 'MSG_TXT', 'MYC_CONVO', 'INVOICE', 'ORDER_PARENT_INFO',
  'IP_DATA_STORE', 'IP_FLWSHT_REC', 'PAT_ENC_HSP', 'PAT_ENC_APPT',
  'PAT_ENC_DISP', 'CLAIM_INFO', 'FAMILY_HX',
  'PAT_ALLERGIES', 'PAT_PROBLEM_LIST', 'PAT_IMMUNIZATIONS',
  'ACCT_GUAR_PAT_INFO',
  'PATIENT_RACE', 'PAT_ADDRESS', 'PAT_EMAILADDRESS', 'PAT_ADDR_CHNG_HX',
  'IDENTITY_ID', 'PATIENT_ALIAS', 'PAT_PCP', 'PAT_PREF_PHARMACY',
  'PAT_RCNT_USD_PHRMS', 'PAT_RELATIONSHIPS', 'PATIENT_GOALS', 'PATIENT_DOCS',
  'HM_HISTORICAL_STATUS', 'HM_HISTORY', 'PAT_HM_CUR_GUIDE',
  'PATIENT_HMT_STATUS', 'HM_FORECAST_INFO',
  'PATIENT_ALG_UPD_HX', 'MEDS_REV_HX', 'PROB_LIST_REV_HX',
  'MYC_MESG_RTF_TEXT', 'MYC_MESG_CHILD', 'MYC_MESG_QUESR_ANS',
  'MYC_CONVO_MSGS', 'MYC_CONVO_VIEWERS', 'MYC_CONVO_USERS',
  'MYC_CONVO_ENCS', 'MYC_CONVO_AUDIENCE', 'IB_MESSAGE_THREAD',
  'MYC_CONVO_ABT_MED_ADVICE', 'MYC_CONVO_ABT_CUST_SVC',
  'IP_FLOWSHEET_ROWS', 'IP_FLWSHT_MEAS',
];
for (const t of roots) specTables.add(t);

// Child specs from project.ts (I'll extract table names)
const childTables = [
  // encounter children
  'PAT_ENC_DX','PAT_ENC_RSN_VISIT','TREATMENT','TREATMENT_TEAM','PAT_ENC_CURR_MEDS',
  'DISCONTINUED_MEDS','PAT_ADDENDUM_INFO','PAT_ENC_DOCS','ECHKIN_STEP_INFO',
  'PAT_ENC_LOS_DX','PAT_MYC_MESG','EXT_PHARM_TYPE_COVERED','PAT_ENC_ELIG_HISTORY',
  'KIOSK_QUESTIONNAIR','MYC_APPT_QNR_DATA','PAT_ENC_THREADS','FRONT_END_PMT_COLL_HX',
  'PAT_REVIEW_DATA','ASSOCIATED_REFERRALS','PAT_HX_REVIEW','PAT_HX_REV_TOPIC',
  'PAT_HX_REV_TYPE','PAT_REVIEW_ALLERGI','PAT_REVIEW_PROBLEM','PAT_ENC_BILLING_ENC',
  'PATIENT_ENC_VIDEO_VISIT','PAT_ENC_SEL_PHARMACIES','SOCIAL_ADL_HX','FAMILY_HX',
  'MEDICAL_HX','PAT_SOCIAL_HX_DOC','AN_RELINK_INFO','PAT_ENC_LETTERS',
  'APPT_LETTER_RECIPIENTS','MED_PEND_APRV_STAT','RESULT_FOLLOW_UP','PAT_UCN_CONVERT',
  'ED_PAT_STATUS','ADDITIONAL_EM_CODE','PAT_CANCEL_PROC','PAT_ENC_ADMIT_DX_AUDIT',
  'PAT_ENC_QNRS_ANS','PAT_HM_LETTER','HOMUNCULUS_PAT_DATA','OPH_EXAM_DATA',
  'PAT_CR_TX_SINGLE','PAT_ENC_CALL_DATA','PAT_ENC_CC_AUTO_CHG','PAT_ENC_PAS',
  'PAT_UTILIZATION_REVIEW','FAM_HX_PAT_ONLY','HSP_ATND_PROV','HSP_ADMIT_DIAG','HSP_ADMIT_PROC',
  // order children
  'ORDER_RESULTS','ORDER_DX_PROC','ORDER_COMMENT','ORDER_NARRATIVE','ORDER_IMPRESSION',
  'ORDER_SIGNED_PROC','ORDER_RAD_ACC_NUM','ORDER_RAD_READING','ORDER_MYC_INFO',
  'ORDER_MYC_RELEASE','HV_ORDER_PROC','ORDER_STATUS','ORDER_AUTH_INFO','ORDER_PENDING',
  'ORDER_REVIEW','ORDER_READ_ACK','ORD_SPEC_QUEST','ORD_PROC_INSTR','ORD_CLIN_IND',
  'ORD_INDICATIONS','EXTERNAL_ORDER_INFO','CL_ORD_FST_LST_SCH','OBS_MTHD_ID',
  'SPEC_TYPE_SNOMED','ORDER_INSTANTIATED','ORDER_SUMMARY','ORDER_ANATOMICAL_REGION',
  'ORDER_IMAGE_AVAIL_INFO','ORDER_DOCUMENTS','ORD_PRFLST_TRK','ORD_SECOND_SIGN',
  'RAD_THERAPY_ASSOC_COURSE','ADT_ORDER_INFORMATION','ORDER_RES_COMMENT','PERFORMING_ORG_INFO',
  // note children
  'HNO_PLAIN_TEXT','ABN_FOLLOW_UP','NOTE_ENC_INFO','NOTE_CONTENT_INFO',
  'V_EHI_HNO_LINKED_PATS','HNO_ORDERS','NOTES_LINK_ORD_TXN',
  // tx children
  'ARPB_TX_ACTIONS','ARPB_CHG_ENTRY_DX','TX_DIAG','PMT_EOB_INFO_II','ARPB_TX_MATCH_HX',
  'ARPB_TX_CHG_REV_HX','ARPB_TX_STMCLAIMHX','ARPB_TX_MODERATE','ARPB_TX_MODIFIERS',
  'ARPB_AUTH_INFO','ARPB_TX_VOID','ARPB_TX_STMT_DT',
  'HSP_TX_NAA_DETAIL','PMT_EOB_INFO_I','HSP_TX_LINE_INFO','HSP_PMT_LINE_REMIT',
  'HSP_PMT_REMIT_DETAIL','HSP_TX_RMT_CD_LST','HSP_TX_AUTH_INFO','HSP_TX_DIAG',
  'TX_NDC_INFORMATION','SVC_PMT_HISTORY',
  // referral children
  'REFERRAL_HIST','REFERRAL_DX','REFERRAL_PX','REFERRAL_NOTES','REFERRAL_REASONS',
  'REFERRAL_APT','REFERRAL_CVG','REFERRAL_CVG_AUTH','EPA_INFO','REFERRAL_ORG_FILTER_SA',
  'REFERRAL_CROSS_ORG','RFL_REF_TO_REGIONS',
  // problem children
  'PROB_UPDATES','PL_SYSTEMS','PROBLEM_LIST_ALL',
  // allergy children
  'ALLERGY_REACTIONS','ALLERGY_FLAG',
  // med children
  'ORDER_DX_MED','ORDER_MEDINFO','ORDER_MED_SIG','ORD_DOSING_PARAMS','ORDER_RPTD_SIG_HX',
  'ORDER_RPTD_SIG_TEXT','DUPMED_DISMISS_HH_INFO','ORDER_MED_MORPHINE_EQUIV',
  'ORDER_MED_VITALS','ORD_MED_USER_ADMIN','PRESC_ID',
  // immune children
  'IMMUNE_HISTORY','IMM_ADMIN','IMM_ADMIN_COMPONENTS','IMM_ADMIN_GROUPS','IMM_DUE',
  // remit children
  'CL_RMT_SVCE_LN_INF','CL_RMT_CLM_INFO','CL_RMT_CLM_ENTITY','CL_RMT_PRV_SUM_INF',
  'CL_RMT_PRV_SUP_INF','CL_RMT_INP_ADJ_INF','CL_RMT_OPT_ADJ_INF','CL_RMT_SVC_LVL_ADJ',
  'CL_RMT_SVC_LVL_REF','CL_RMT_SVC_AMT_INF','CL_RMT_SVC_DAT_INF','CL_RMT_DELIVER_MTD',
  'CL_RMT_HC_RMK_CODE','CL_RMT_CLM_DT_INFO',
  // har children
  'HSP_ACCT_CVG_LIST','HSP_ACCT_DX_LIST','HSP_ACCT_PRORATION','HSP_ACCT_OTHR_PROV',
  'HSP_ACCT_ADJ_LIST','HSP_ACCT_BILL_DRG','HSP_ACCT_CLAIM_HAR','HSP_ACCT_SBO',
  'HSP_ACCT_CHG_LIST','HSP_ACCT_PYMT_LIST','HSP_ACCT_ATND_PROV','HSP_ACCT_ADMIT_DX',
  'HSP_ACCT_LETTERS','HSP_CLAIM_PRINT','HSP_TRANSACTIONS','CODE_INT_COMB_LN',
  'HSP_ACCT_CL_AG_HIS','HSP_ACCT_EARSTADDR','HSP_ACCT_EXTINJ_CD','HSP_ACCT_OCUR_HAR',
  'DOCS_FOR_HOSP_ACCT',
  // account children
  'ACCOUNT_CONTACT','ACCT_COVERAGE','ACCT_TX','ACCT_ADDR','ACCOUNT_CREATION',
  'GUAR_ACCT_STMT_HX','GUAR_PMT_SCORE_PB_HX','GUAR_ADDR_HX','ACCT_HOME_PHONE_HX','NOTES_ACCT',
  // claim children
  'SVC_LN_INFO','CLM_DX','CLM_NOTE','CLM_VALUE_RECORD','OCC_CD','REL_CAUSE_CD',
  // claim print children
  'HSP_CLP_REV_CODE','HSP_CLP_CMS_LINE','HSP_CLP_DIAGNOSIS','HSP_CLAIM_DETAIL1',
  'HSP_CLAIM_DETAIL2','HSP_CLP_CMS_TX_PIECES','HSP_CLP_UB_TX_PIECES','CLP_NON_GRP_TX_IDS','CLP_OCCUR_DATA',
  // doc children
  'DOC_LINKED_PATS','DOC_INFO_DICOM','DOC_CSN_REFS','DOCS_RCVD_ALGS','DOCS_RCVD_ASMT','DOCS_RCVD_PROC',
  // invoice children
  'INV_BASIC_INFO','INV_TX_PIECES','INV_NUM_TX_PIECES','INV_CLM_LN_ADDL','INV_DX_INFO','INV_PMT_RECOUP',
  // other
  'CAREPLAN_INFO','CAREPLAN_ENROLLMENT_INFO',
  // lookups
  'CLARITY_EDG','CLARITY_SER','CLARITY_DEP','CLARITY_EAP','CLARITY_EMP','CLARITY_LOC',
  'IP_FLO_GP_DATA',
];
for (const t of childTables) specTables.add(t);

// Now categorize every table
interface TableInfo {
  name: string;
  rows: number;
  dataRows: number; // rows with at least one non-null non-PK column
  colCount: number;
  nonNullCols: number; // columns with at least one non-null value
  isCovered: boolean;
  isSplit: boolean;
  isLookup: boolean;
  hasData: boolean;
  fkHints: string[]; // recognized FK columns
}

const tables: TableInfo[] = [];
for (const name of allTables) {
  const rows = rowCount(name);
  const tableCols = cols(name);
  
  // Count non-null columns
  let nonNullCols = 0;
  for (const c of tableCols) {
    const nn = (db.query(`SELECT COUNT(*) as n FROM "${name}" WHERE "${c}" IS NOT NULL AND "${c}" != ''`).get() as {n:number}).n;
    if (nn > 0) nonNullCols++;
  }

  const fkHints: string[] = [];
  for (const c of tableCols) {
    if (c === 'PAT_ID') fkHints.push('PAT_ID');
    if (c === 'PAT_ENC_CSN_ID') fkHints.push('CSN');
    if (c === 'ORDER_PROC_ID' || c === 'ORDER_ID') fkHints.push('ORDER');
    if (c === 'ORDER_MED_ID') fkHints.push('MED');
    if (c === 'TX_ID') fkHints.push('TX');
    if (c === 'NOTE_ID') fkHints.push('NOTE');
    if (c === 'ALLERGY_ID') fkHints.push('ALLERGY');
    if (c === 'PROBLEM_LIST_ID') fkHints.push('PROBLEM');
    if (c === 'IMMUNE_ID' || c === 'DOCUMENT_ID') fkHints.push('IMMUNE/DOC');
    if (c === 'REFERRAL_ID') fkHints.push('REFERRAL');
    if (c === 'ACCOUNT_ID' || c === 'ACCT_ID') fkHints.push('ACCOUNT');
    if (c === 'HSP_ACCOUNT_ID') fkHints.push('HSP_ACCT');
    if (c === 'COVERAGE_ID' || c === 'CVG_ID') fkHints.push('COVERAGE');
    if (c === 'IMAGE_ID') fkHints.push('REMIT');
    if (c === 'RECORD_ID') fkHints.push('CLAIM');
    if (c === 'THREAD_ID') fkHints.push('THREAD');
    if (c === 'MESSAGE_ID') fkHints.push('MESSAGE');
    if (c === 'EPISODE_ID') fkHints.push('EPISODE');
  }

  tables.push({
    name, rows,
    dataRows: rows, // simplified
    colCount: tableCols.length,
    nonNullCols,
    isCovered: specTables.has(name),
    isSplit: Object.values(splitConfig as any).some((c: any) => c.members?.some((m: any) => m.table === name)),
    isLookup: name.startsWith('CLARITY_') || name.startsWith('ZC_'),
    hasData: rows > 0,
    fkHints: [...new Set(fkHints)],
  });
}

// Report
const covered = tables.filter(t => t.isCovered);
const uncoveredWithData = tables.filter(t => !t.isCovered && t.hasData);
const uncoveredEmpty = tables.filter(t => !t.isCovered && !t.hasData);
const lookups = tables.filter(t => t.isLookup && !t.isCovered);

console.log("=== COVERAGE SUMMARY ===");
console.log(`Total tables: ${tables.length}`);
console.log(`Covered: ${covered.length} (${covered.filter(t=>t.hasData).length} with data)`);
console.log(`Uncovered with data: ${uncoveredWithData.length}`);
console.log(`Uncovered empty: ${uncoveredEmpty.length}`);

console.log("\n=== UNCOVERED TABLES WITH DATA (sorted by row count) ===");
uncoveredWithData.sort((a,b) => b.rows - a.rows);
for (const t of uncoveredWithData) {
  console.log(`  ${t.name}: ${t.rows} rows, ${t.nonNullCols}/${t.colCount} cols with data, FK hints: [${t.fkHints.join(',')}]`);
}

// Categorize uncovered by likely parent
console.log("\n=== UNCOVERED BY FK PATTERN ===");
const byFK: Record<string, TableInfo[]> = {};
for (const t of uncoveredWithData) {
  const key = t.fkHints.length > 0 ? t.fkHints[0] : 'UNKNOWN';
  if (!byFK[key]) byFK[key] = [];
  byFK[key].push(t);
}
for (const [fk, tbls] of Object.entries(byFK).sort((a,b) => b[1].length - a[1].length)) {
  const totalRows = tbls.reduce((s,t) => s+t.rows, 0);
  console.log(`\n  ${fk} (${tbls.length} tables, ${totalRows} rows):`);
  for (const t of tbls.sort((a,b) => b.rows - a.rows)) {
    console.log(`    ${t.name}: ${t.rows} rows, ${t.nonNullCols} cols`);
  }
}

// Uncovered lookups
const uncoveredLookups = lookups.filter(t => t.hasData);
console.log(`\n=== UNCOVERED LOOKUPS WITH DATA (${uncoveredLookups.length}) ===`);
for (const t of uncoveredLookups.sort((a,b) => b.rows - a.rows)) {
  console.log(`  ${t.name}: ${t.rows} rows`);
}

// Data that's in _epic but not clean fields
console.log("\n=== COLUMN COVERAGE IN HEALTHRECORD ===");
// Count columns flowing through at each stage
let totalDataCols = 0;
let totalCols = 0;
for (const t of tables.filter(t => t.hasData)) {
  totalCols += t.colCount;
  totalDataCols += t.nonNullCols;
}
console.log(`Total columns (all tables): ${totalCols}`);
console.log(`Columns with data: ${totalDataCols}`);
console.log(`Covered tables' columns with data: ${covered.filter(t=>t.hasData).reduce((s,t)=>s+t.nonNullCols,0)}`);

// Flowsheet detail
console.log("\n=== FLOWSHEET DETAIL ===");
for (const t of ['IP_FLOWSHEET_ROWS', 'IP_FLWSHT_MEAS', 'IP_FLWSHT_REC', 'IP_FLO_GP_DATA', 'IP_DATA_STORE']) {
  if (tables.find(x => x.name === t)?.hasData) {
    const r = rowCount(t);
    console.log(`  ${t}: ${r} rows, cols: ${cols(t).join(', ')}`);
    const sample = q(`SELECT * FROM "${t}" LIMIT 2`);
    for (const row of sample) {
      const vals = Object.entries(row).filter(([,v]) => v != null && v !== '').map(([k,v]) => `${k}=${String(v).slice(0,30)}`);
      console.log(`    ${vals.join(', ')}`);
    }
  }
}

// RTF/note gap
console.log("\n=== NOTE/MESSAGE TEXT GAP ===");
const totalNotes = rowCount('HNO_INFO');
const notesWithPlain = (q(`SELECT COUNT(DISTINCT NOTE_ID) as n FROM HNO_PLAIN_TEXT`)[0].n as number);
const notesLinked = (q(`SELECT COUNT(*) as n FROM HNO_INFO WHERE PAT_ENC_CSN_ID IS NOT NULL`)[0].n as number);
console.log(`Notes: ${totalNotes} total, ${notesWithPlain} with plain text, ${notesLinked} linked to encounters`);

const totalMsgs = rowCount('MYC_MESG');
const msgsWithText = (q(`SELECT COUNT(DISTINCT MESSAGE_ID) as n FROM MSG_TXT`)[0].n as number);
const msgsWithRTF = (q(`SELECT COUNT(DISTINCT MESSAGE_ID) as n FROM MYC_MESG_RTF_TEXT`)[0].n as number);
console.log(`Messages: ${totalMsgs} total, ${msgsWithText} with plain text, ${msgsWithRTF} with RTF`);

db.close();
