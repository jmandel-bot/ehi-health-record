import { Database } from "bun:sqlite";
import { readFileSync } from "fs";
import splitConfig from "../src/split_config.json";

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

// ── Dynamically extract all referenced tables from project.ts ──────────────
const specTables = new Set<string>();

// From split_config
for (const [base, info] of Object.entries(splitConfig as Record<string, {base_pk: string; members: Array<{table: string; join_col: string}>}>)) {
  specTables.add(base);
  for (const m of info.members) specTables.add(m.table);
}

// Parse project.ts for all table references
const projectSrc = readFileSync("src/project.ts", "utf-8");
// ChildSpec table entries: table: "TABLE_NAME"
for (const m of projectSrc.matchAll(/table:\s*"([A-Z_][A-Z_0-9]*)"/g)) specTables.add(m[1]);
// SQL FROM clauses: FROM "TABLE_NAME"
for (const m of projectSrc.matchAll(/FROM\s+"([A-Z_][A-Z_0-9]*)"/g)) specTables.add(m[1]);
// tableExists("TABLE_NAME")
for (const m of projectSrc.matchAll(/tableExists\("([A-Z_][A-Z_0-9]*)"\)/g)) specTables.add(m[1]);
// Single-quoted table names in specTables set
for (const m of projectSrc.matchAll(/'([A-Z_][A-Z_0-9]*)'/g)) specTables.add(m[1]);

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
