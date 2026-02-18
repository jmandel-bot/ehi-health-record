import { Database } from "bun:sqlite";
const db = new Database("ehi_clean.db", { readonly: true });
function q(sql: string, p: unknown[] = []) { return db.query(sql).all(...p) as Record<string,unknown>[]; }
function tableCols(t: string) { return q(`PRAGMA table_info("${t}")`).map(r => r.name as string); }

// The 29 HealthRecord.ts phantom columns — where should they come from?
const phantoms = [
  'ACCT_BALANCE', 'ACCT_BILLING_STATUS_C_NAME', 'ADD_LINE_1',
  'ALLERGY_TYPE_C_NAME', 'AUTHOR_NAME', 'BALANCE',
  'CLM_VALUES_ID', 'COMPONENT_ID_COMPONENT_NAME', 'CUR_PCP_PROV_ID_NAME',
  'FLO_MEAS_NAME', 'MANUFACTURER_C_NAME', 'MARITAL_STATUS_C_NAME',
  'MATCH_CHARGE_TX_ID', 'MEAS_VALUE', 'MESSAGE_TEXT',
  'MSG_STATUS_C_NAME', 'PAYOR_ID_NAME', 'REACTION_NAME',
  'SERV_PROVIDER_ID_NAME', 'SIG', 'SMOKING_PACKS_PER_DAY',
  'SMOKING_QUIT_DATE', 'SUBMIT_DATE', 'TOTAL_CHARGES',
  'TOTAL_PAID', 'TOTAL_PAYMENTS', 'TOT_CHARGES',
  'TOT_PAYMENTS', 'UNITS',
];

console.log("=== PHANTOM COLUMNS: where they should come from ===\n");
const allTables = q("SELECT name FROM sqlite_master WHERE type='table'").map(r => r.name as string);

for (const col of phantoms) {
  // Search for close matches across all tables
  const exactMatches: string[] = [];
  const fuzzyMatches: string[] = [];
  
  for (const t of allTables) {
    const cols = tableCols(t);
    if (cols.includes(col)) {
      exactMatches.push(t);
    }
    // Fuzzy: check for partial match
    for (const c of cols) {
      if (c !== col && (c.includes(col) || col.includes(c)) && c.length > 5) {
        const nn = (q(`SELECT COUNT(*) as n FROM "${t}" WHERE "${c}" IS NOT NULL AND "${c}" != ''`)[0].n as number);
        if (nn > 0) fuzzyMatches.push(`${t}.${c} (${nn} vals)`);
      }
    }
  }
  
  if (exactMatches.length > 0) {
    console.log(`  ${col}: EXISTS in ${exactMatches.join(', ')}`);
  } else if (fuzzyMatches.length > 0) {
    console.log(`  ${col}: NOT FOUND. Near matches: ${fuzzyMatches.slice(0,3).join(', ')}`);
  } else {
    console.log(`  ${col}: NOT FOUND anywhere`);
  }
}

// Now: the real question — which projected fields silently get null
// because the column name is wrong?
console.log("\n=== IMPACT: which HealthRecord fields are silently null? ===\n");

// Load the health record and check
const hrJson = await Bun.file("health_record_full.json").json();

function countNulls(obj: any, path: string = ''): string[] {
  const nulls: string[] = [];
  if (obj == null) return [path];
  if (Array.isArray(obj)) {
    // Just check first element as representative
    if (obj.length > 0) nulls.push(...countNulls(obj[0], `${path}[0]`));
    return nulls;
  }
  if (typeof obj === 'object') {
    for (const [k, v] of Object.entries(obj)) {
      if (k === '_epic' || k === '_version' || k === '_projected' || k === '_source') continue;
      if (v === null || v === undefined) {
        nulls.push(`${path}.${k}`);
      } else if (typeof v === 'object') {
        nulls.push(...countNulls(v, `${path}.${k}`));
      }
    }
  }
  return nulls;
}

// Check specific fields we know might be broken
const checks = [
  { path: 'demographics.address.street', val: hrJson.demographics?.address?.street },
  { path: 'demographics.maritalStatus', val: hrJson.demographics?.maritalStatus },
  { path: 'demographics.primaryCareProvider', val: hrJson.demographics?.primaryCareProvider },
  { path: 'demographics.race', val: hrJson.demographics?.race },
  { path: 'allergies[0].type', val: hrJson.allergies?.[0]?.type },
  { path: 'allergies[0].reactions', val: hrJson.allergies?.[0]?.reactions },
  { path: 'medications[0].sig', val: hrJson.medications?.[0]?.sig },
  { path: 'visits[0].vitalSigns', val: hrJson.visits?.[0]?.vitalSigns },
  { path: 'visits[0].notes', val: hrJson.visits?.[0]?.notes },
  { path: 'socialHistory.current.tobacco.packsPerDay', val: hrJson.socialHistory?.current?.tobacco?.packsPerDay },
  { path: 'socialHistory.current.alcohol.drinksPerWeek', val: hrJson.socialHistory?.current?.alcohol?.drinksPerWeek },
  { path: 'socialHistory.current.drugs.status', val: hrJson.socialHistory?.current?.drugs?.status },
  { path: 'messages[0].body', val: hrJson.messages?.[0]?.body },
  { path: 'messages[0].subject', val: hrJson.messages?.[0]?.subject },
  { path: 'labResults[0].referenceRange', val: hrJson.labResults?.[0]?.referenceRange },
  { path: 'labResults[0].unit', val: hrJson.labResults?.[0]?.unit },
  { path: 'billing.charges[0].service', val: hrJson.billing?.charges?.[0]?.service },
  { path: 'billing.payments[0].payer', val: hrJson.billing?.payments?.[0]?.payer },
  { path: 'billing.claims[0].payer', val: hrJson.billing?.claims?.[0]?.payer },
];

for (const { path, val } of checks) {
  const status = val == null ? '✗ NULL' : Array.isArray(val) && val.length === 0 ? '✗ EMPTY' : `✓ ${JSON.stringify(val).slice(0,60)}`;
  console.log(`  ${path}: ${status}`);
}

db.close();
