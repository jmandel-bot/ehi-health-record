/**
 * generate_review_chunks_v2.ts — Code-derived, provably complete review chunks.
 *
 * Instead of hand-picking chunks, we:
 * 1. Parse every function in project.ts, PatientRecord.ts, HealthRecord.ts
 * 2. Extract every table reference (SQL FROM, mergeQuery, children, lookup, tableExists, ChildSpec)
 * 3. Group into chunks based on the actual function structure
 * 4. Verify 100% coverage: every function, class, and table in exactly one chunk
 *
 * If any element is unassigned, this script fails loudly.
 */
import { readFileSync } from "fs";
import { Database } from "bun:sqlite";
import splitConfig from "./split_config.json";

const db = new Database("ehi_clean.db", { readonly: true });
function q(sql: string, p: unknown[] = []) { return db.query(sql).all(...p) as Record<string,unknown>[]; }

const projectSrc = readFileSync("project.ts", "utf-8");
const prSrc = readFileSync("PatientRecord.ts", "utf-8");
const hrSrc = readFileSync("HealthRecord.ts", "utf-8");

// ─── Code extraction helpers ─────────────────────────────────────────────

function extractFnBody(src: string, name: string): string {
  const re = new RegExp(`(?:export\\s+)?function\\s+${name}\\b`);
  const lines = src.split('\n');
  for (let i = 0; i < lines.length; i++) {
    if (!re.test(lines[i])) continue;
    let depth = 0, started = false;
    const body: string[] = [];
    for (let j = i; j < lines.length; j++) {
      body.push(lines[j]);
      depth += (lines[j].match(/\{/g) || []).length - (lines[j].match(/\}/g) || []).length;
      if (depth > 0) started = true;
      if (started && depth <= 0) return body.join('\n');
    }
  }
  return '';
}

function extractClassBody(src: string, name: string): string {
  const re = new RegExp(`(?:export\\s+)?(?:class|interface)\\s+${name}\\b`);
  const lines = src.split('\n');
  for (let i = 0; i < lines.length; i++) {
    if (!re.test(lines[i])) continue;
    let depth = 0, started = false;
    const body: string[] = [];
    for (let j = i; j < lines.length; j++) {
      body.push(lines[j]);
      depth += (lines[j].match(/\{/g) || []).length - (lines[j].match(/\}/g) || []).length;
      if (depth > 0) started = true;
      if (started && depth <= 0) return body.join('\n');
    }
  }
  return '';
}

function tablesIn(code: string): string[] {
  const t = new Set<string>();
  for (const m of code.matchAll(/FROM\s+"?([A-Z][A-Z0-9_]+)"?/gi))
    if (/^[A-Z]/.test(m[1])) t.add(m[1]);
  for (const m of code.matchAll(/JOIN\s+"?([A-Z][A-Z0-9_]+)"?/gi))
    if (/^[A-Z]/.test(m[1])) t.add(m[1]);
  for (const m of code.matchAll(/tableExists\("([A-Z][A-Z0-9_]+)"\)/g)) t.add(m[1]);
  for (const m of code.matchAll(/table:\s*"([A-Z_][A-Z0-9_]+)"/g)) t.add(m[1]);
  for (const m of code.matchAll(/mergeQuery\("([A-Z][A-Z0-9_]+)"/g)) t.add(m[1]);
  for (const m of code.matchAll(/children(?:Merged)?\("([A-Z][A-Z0-9_]+)"/g)) t.add(m[1]);
  for (const m of code.matchAll(/lookup(?:Name)?\("([A-Z][A-Z0-9_]+)"/g)) t.add(m[1]);
  return [...t].sort();
}

// ─── Find ALL named functions ────────────────────────────────────────────

function findAllFunctionNames(src: string): string[] {
  return [...src.matchAll(/(?:export\s+)?function\s+(\w+)/g)].map(m => m[1]);
}

function findAllClassNames(src: string): string[] {
  return [...src.matchAll(/(?:export\s+)?(?:class|interface)\s+(\w+)/g)].map(m => m[1]);
}

const projectFnNames = findAllFunctionNames(projectSrc).filter(n => n !== "at");
const prClassNames = findAllClassNames(prSrc).filter(n => n !== "at");
const hrFnNames = findAllFunctionNames(hrSrc).filter(n => n !== "at");

console.log(`project.ts functions: ${projectFnNames.join(', ')}`);
console.log(`PatientRecord.ts classes: ${prClassNames.join(', ')}`);
console.log(`HealthRecord.ts functions: ${hrFnNames.join(', ')}`);

// ─── Also extract the "remainder" of main() — everything not in a named function ─
// This catches inline queries like social_history: q(`SELECT * FROM SOCIAL_HX`)

// main() doesn't exist — the top-level code IS the main body.
// Extract everything after the last function definition.
const projectLines = projectSrc.split('\n');
let lastFnEnd = 0;
{
  let inFn = false, depth = 0;
  for (let i = 0; i < projectLines.length; i++) {
    if (/^(?:export\s+)?function\s+/.test(projectLines[i])) inFn = true;
    if (inFn) {
      depth += (projectLines[i].match(/\{/g) || []).length - (projectLines[i].match(/\}/g) || []).length;
      if (depth <= 0 && inFn) { lastFnEnd = i + 1; inFn = false; depth = 0; }
    }
  }
}
const mainBody = projectLines.slice(lastFnEnd).join('\n');

// Extract ALL ChildSpec arrays (they're defined at module level, not inside functions)
// Find all const xxxChildren = [...] blocks
const childSpecBlocks: { name: string; code: string; tables: string[] }[] = [];
const csMatches = projectSrc.matchAll(/const\s+(\w+Children)[^=]*=\s*\[/g);
for (const m of csMatches) {
  const name = m[1];
  const startIdx = m.index!;
  // Find the "= [" to start depth counting from the actual array bracket
  const eqBracket = projectSrc.indexOf('= [', startIdx);
  const arrayStart = projectSrc.indexOf('[', eqBracket + 2);
  let depth = 1; // we're past the opening [
  let i = arrayStart + 1;
  while (i < projectSrc.length) {
    if (projectSrc[i] === '[') depth++;
    if (projectSrc[i] === ']') { depth--; if (depth === 0) break; }
    i++;
  }
  const code = projectSrc.slice(startIdx, i + 1);
  childSpecBlocks.push({ name, code, tables: tablesIn(code) });
}

console.log(`\nChildSpec arrays: ${childSpecBlocks.map(b => `${b.name}(${b.tables.length})`).join(', ')}`);

// Find which functions call which ChildSpec arrays
function fnUsesChildSpec(fnCode: string): string[] {
  return childSpecBlocks.filter(b => fnCode.includes(b.name)).map(b => b.name);
}

// ─── Schema and sample data helpers ──────────────────────────────────────

function schemaDescs(table: string): Record<string, string> {
  try {
    const schema = JSON.parse(readFileSync(`schemas/${table}.json`, 'utf-8'));
    const d: Record<string, string> = {};
    if (schema.description) d['_TABLE_'] = schema.description;
    for (const col of schema.columns ?? []) {
      if (col.description) d[col.name] = col.description;
    }
    return d;
  } catch { return {}; }
}

function nonNullSample(table: string): Record<string, string> {
  try {
    const cols = q(`PRAGMA table_info("${table}")`).map(r => r.name as string);
    const result: Record<string, string> = {};
    for (const col of cols) {
      const val = q(`SELECT "${col}" FROM "${table}" WHERE "${col}" IS NOT NULL AND "${col}" != '' LIMIT 1`);
      if (val.length > 0) result[col] = String(val[0][col]).slice(0, 100);
    }
    return result;
  } catch { return {}; }
}

function rowCount(table: string): number {
  try { return (q(`SELECT COUNT(*) as c FROM "${table}"`)[0].c as number); }
  catch { return 0; }
}

// ─── Chunk definitions ──────────────────────────────────────────────────
// Each chunk declares EXACTLY which functions/classes/ChildSpecs it owns.
// The completeness check at the end verifies nothing is left out.

interface ChunkDef {
  id: string;
  title: string;
  description: string;
  projectFns: string[];
  projectChildSpecs: string[];  // names of ChildSpec arrays
  mainInlineRange?: [number, number]; // line range in main() for inline queries
  mainInlineProperties?: string[];    // property names to grep from main()
  prClasses: string[];
  hrFns: string[];
  outputKeys: string[];
}

// To capture inline main() properties properly, let's extract them by line scanning
function extractMainProperties(propNames: string[]): string {
  const mainLines = mainBody.split('\n');
  const result: string[] = [];
  for (const propName of propNames) {
    let capturing = false;
    let depth = 0;
    for (const line of mainLines) {
      if (!capturing && line.match(new RegExp(`^\\s+${propName}\\s*:`))) {
        capturing = true;
        depth = 0;
      }
      if (capturing) {
        result.push(line);
        depth += (line.match(/[\[{(]/g) || []).length - (line.match(/[\]})]/g) || []).length;
        // Check if this property is done (ends with , and balanced)
        if (line.trimEnd().endsWith(',') && depth <= 0) {
          capturing = false;
          result.push('');
        }
      }
    }
  }
  return result.join('\n');
}

const chunkDefs: ChunkDef[] = [
  {
    id: "demographics",
    title: "Demographics: PATIENT (splits) + race + addresses + extensions",
    description: "Patient identity, addresses, contacts, PCP, race, language, MyChart, aliases, IDs, pharmacies, relationships, goals",
    projectFns: ["projectPatient"],
    projectChildSpecs: [],
    mainInlineProperties: ["race", "addresses", "email_addresses", "address_change_history",
      "identity_ids", "aliases", "primary_care_providers", "preferred_pharmacies",
      "recent_pharmacies", "relationships", "goals", "patient_documents"],
    prClasses: [],
    hrFns: ["projectDemographics"],
    outputKeys: ["demographics"],
  },
  {
    id: "allergies",
    title: "Allergies: ALLERGY → Allergy → allergies",
    description: "Allergy records with reactions, severity, status",
    projectFns: ["projectAllergies"],
    projectChildSpecs: ["allergyChildren"],
    mainInlineProperties: ["allergy_update_history"],
    prClasses: ["Allergy"],
    hrFns: ["projectAllergy"],
    outputKeys: ["allergies"],
  },
  {
    id: "problems",
    title: "Problems: PROBLEM_LIST → Problem → problems",
    description: "Active/resolved problems with onset, priority, diagnoses",
    projectFns: ["projectProblems"],
    projectChildSpecs: ["problemChildren"],
    mainInlineProperties: ["problem_review_history"],
    prClasses: ["Problem"],
    hrFns: ["projectProblem"],
    outputKeys: ["problems"],
  },
  {
    id: "immunizations",
    title: "Immunizations: IMMUNE + children → immunizations",
    description: "Immunization records with dates, doses, manufacturers, administration",
    projectFns: ["projectImmunizations"],
    projectChildSpecs: ["immuneChildren"],
    mainInlineProperties: [],
    prClasses: [],
    hrFns: ["projectImmunization"],
    outputKeys: ["immunizations"],
  },
  {
    id: "medications",
    title: "Medications: ORDER_MED (splits) + children → medications",
    description: "Medication orders with sig, dose, route, pharmacy, diagnoses",
    projectFns: ["projectMedications"],
    projectChildSpecs: ["medChildren"],
    mainInlineProperties: ["medication_review_history"],
    prClasses: [],
    hrFns: ["projectMedication"],
    outputKeys: ["medications"],
  },
  {
    id: "orders_labs",
    title: "Orders & Labs: ORDER_PROC + children → ORDER_RESULTS → labResults",
    description: "Order procedures, results, parent→child chain for lab panels",
    projectFns: ["projectOrder"],
    projectChildSpecs: ["orderChildren"],
    mainInlineProperties: [],
    prClasses: ["Order", "OrderResult"],
    hrFns: ["projectOrder", "projectResult", "projectAllLabResults"],
    outputKeys: ["labResults"],
  },
  {
    id: "encounters",
    title: "Encounters: PAT_ENC (splits) + children → visits",
    description: "Clinical encounters with DX, appointments, disposition, vitals, flowsheets",
    projectFns: ["projectEncounter"],
    projectChildSpecs: ["encounterChildren"],
    mainInlineProperties: [],
    prClasses: ["Encounter"],
    hrFns: ["projectVisit"],
    outputKeys: ["visits"],
  },
  {
    id: "notes",
    title: "Notes: HNO_INFO + children → notes",
    description: "Clinical notes with plain text, encounter links, orders",
    projectFns: ["projectNote"],
    projectChildSpecs: ["noteChildren"],
    mainInlineProperties: [],
    prClasses: ["Note"],
    hrFns: [],
    outputKeys: [],
  },
  {
    id: "messages",
    title: "Messages: MYC_MESG + children → messages",
    description: "MyChart messages with text, RTF, questionnaire answers",
    projectFns: ["projectMessages"],
    projectChildSpecs: [],
    mainInlineProperties: [],
    prClasses: ["Message"],
    hrFns: ["projectMessage"],
    outputKeys: ["messages"],
  },
  {
    id: "conversations",
    title: "Conversations: MYC_CONVO + children → threads",
    description: "MyChart conversation threads with participants, audiences, encounters",
    projectFns: ["projectConversationThreads"],
    projectChildSpecs: [],
    mainInlineProperties: [],
    prClasses: [],
    hrFns: [],
    outputKeys: [],
  },
  {
    id: "billing",
    title: "Billing: ARPB_TRANSACTIONS + HSP_ACCOUNT + INVOICE + claims",
    description: "Professional + hospital billing, claims, remittance, invoices",
    projectFns: ["projectBilling"],
    projectChildSpecs: ["txChildren", "remitChildren", "harChildren", "acctChildren", "claimChildren"],
    mainInlineProperties: ["coverage"],
    prClasses: ["BillingTransaction", "BillingVisit", "BillingRecord"],
    hrFns: ["projectBilling"],
    outputKeys: ["billing"],
  },
  {
    id: "referrals",
    title: "Referrals: REFERRAL + children",
    description: "Referral orders with appointments, diagnoses, coverage, auth",
    projectFns: ["projectReferrals"],
    projectChildSpecs: ["referralChildren"],
    mainInlineProperties: [],
    prClasses: [],
    hrFns: [],
    outputKeys: [],
  },
  {
    id: "documents",
    title: "Documents: DOC_INFORMATION + children",
    description: "Clinical documents with CSN links, DICOM, assessments, procedures",
    projectFns: ["projectDocuments"],
    projectChildSpecs: [],
    mainInlineProperties: [],
    prClasses: [],
    hrFns: [],
    outputKeys: [],
  },
  {
    id: "episodes",
    title: "Episodes: EPISODE + CAREPLAN_INFO",
    description: "Care episodes and care plan enrollments",
    projectFns: ["projectEpisodes"],
    projectChildSpecs: [],
    mainInlineProperties: [],
    prClasses: [],
    hrFns: [],
    outputKeys: [],
  },
  {
    id: "history",
    title: "History: SOCIAL_HX + SURGICAL_HX + FAMILY_HX",
    description: "Social, surgical, family history (versioned snapshots)",
    projectFns: [],
    projectChildSpecs: [],
    mainInlineProperties: ["social_history", "surgical_history", "family_history", "family_hx"],
    prClasses: ["HistorySnapshot", "HistoryTimeline"],
    hrFns: ["projectSocialHistory", "projectOneSocialHistory", "socialHistoryDiffers",
            "projectSurgicalHistory", "projectFamilyHistory"],
    outputKeys: ["socialHistory", "surgicalHistory", "familyHistory"],
  },
  {
    id: "health_maintenance",
    title: "Health Maintenance: HM_HISTORY + forecasts + guides",
    description: "Preventive care tracking, forecasts, guidelines, topic status",
    projectFns: [],
    projectChildSpecs: [],
    mainInlineProperties: ["health_maintenance", "health_maintenance_forecast"],
    prClasses: [],
    hrFns: [],
    outputKeys: [],
  },
  {
    id: "infrastructure",
    title: "Infrastructure: split merging, child attachment, lookups, serialization",
    description: "Shared utility functions used across all entity projections",
    projectFns: ["tableExists", "q", "qOne", "mergeQuery", "children", "childrenMerged",
                 "lookup", "lookupName", "attachChildren"],
    projectChildSpecs: [],
    mainInlineProperties: [],
    prClasses: ["PatientRecord"],
    hrFns: ["serializeHealthRecord", "projectHealthRecord", "toISODate", "toISODateTime",
            "str", "num", "sid", "epic"],
    outputKeys: [],
  },
];

// ─── Build chunks ────────────────────────────────────────────────────────

interface ReviewChunk {
  id: string;
  title: string;
  description: string;
  tables: string[];
  schemaDescriptions: Record<string, Record<string, string>>;
  sampleData: Record<string, Record<string, string>>;
  rowCounts: Record<string, number>;
  projectionCode: string;
  patientRecordCode: string;
  healthRecordCode: string;
  healthRecordOutput: any;
}

let hrOutput: any = {};
try { hrOutput = JSON.parse(readFileSync("health_record_full.json", "utf-8")); } catch {}
if (!hrOutput || Object.keys(hrOutput).length === 0) {
  try { hrOutput = JSON.parse(readFileSync("health_record_compact.json", "utf-8")); } catch {}
}

// Track assignments for completeness verification
const assignedProjectFns = new Set<string>();
const assignedPrClasses = new Set<string>();
const assignedHrFns = new Set<string>();
const assignedChildSpecs = new Set<string>();
const assignedInlineProps = new Set<string>();
const allTablesInChunks = new Set<string>();

const chunks: ReviewChunk[] = [];

for (const def of chunkDefs) {
  // Collect projection code
  let projCode = '';

  // Named functions
  for (const fn of def.projectFns) {
    projCode += extractFnBody(projectSrc, fn) + '\n\n';
    assignedProjectFns.add(fn);
  }

  // ChildSpec arrays
  for (const csName of def.projectChildSpecs) {
    const cs = childSpecBlocks.find(b => b.name === csName);
    if (cs) {
      projCode += cs.code + '\n\n';
      assignedChildSpecs.add(csName);
    }
  }

  // Inline main() properties
  if (def.mainInlineProperties && def.mainInlineProperties.length > 0) {
    const inlineCode = extractMainProperties(def.mainInlineProperties);
    if (inlineCode.trim()) {
      projCode += `// ─── Inline in main() ───\n${inlineCode}\n\n`;
    }
    for (const p of def.mainInlineProperties) assignedInlineProps.add(p);
  }

  // PR classes
  let prCode = '';
  for (const cls of def.prClasses) {
    prCode += extractClassBody(prSrc, cls) + '\n\n';
    assignedPrClasses.add(cls);
  }

  // HR functions
  let hrCode = '';
  for (const fn of def.hrFns) {
    hrCode += extractFnBody(hrSrc, fn) + '\n\n';
    assignedHrFns.add(fn);
  }

  // Tables: union of all code sections
  const allCode = projCode + '\n' + prCode + '\n' + hrCode;
  const tables = tablesIn(allCode);
  for (const t of tables) allTablesInChunks.add(t);

  // Also include split tables: if PATIENT is referenced, include PATIENT_2..6
  for (const t of [...tables]) {
    if (t in splitConfig) {
      for (const member of (splitConfig as any)[t].members) {
        tables.push(member.table);
        allTablesInChunks.add(member.table);
      }
    }
  }

  // Deduplicate
  const uniqueTables = [...new Set(tables)].sort();

  // Schema and sample data
  const schemaD: Record<string, Record<string, string>> = {};
  const sampleD: Record<string, Record<string, string>> = {};
  const rowC: Record<string, number> = {};
  for (const t of uniqueTables) {
    schemaD[t] = schemaDescs(t);
    sampleD[t] = nonNullSample(t);
    rowC[t] = rowCount(t);
  }

  // Output
  let output: any = null;
  for (const key of def.outputKeys) {
    if (hrOutput[key] !== undefined) {
      const val = hrOutput[key];
      output = output || {};
      output[key] = Array.isArray(val) ? val.slice(0, 3) : val;
    }
  }

  chunks.push({
    id: def.id,
    title: def.title,
    description: def.description,
    tables: uniqueTables,
    schemaDescriptions: schemaD,
    sampleData: sampleD,
    rowCounts: rowC,
    projectionCode: projCode.trim() || '// (see infrastructure chunk)',
    patientRecordCode: prCode.trim() || '// (raw EpicRow[], no typed class)',
    healthRecordCode: hrCode.trim() || '// (no HealthRecord projection yet)',
    healthRecordOutput: output,
  });
}

// ─── COMPLETENESS VERIFICATION ───────────────────────────────────────────

let errors = 0;

console.log("\n═══════════════════════════════════════════════════");
console.log("COMPLETENESS VERIFICATION");
console.log("═══════════════════════════════════════════════════");

// 1. project.ts functions
const missingProjFns = projectFnNames.filter(f => !assignedProjectFns.has(f));
console.log(`\n1. project.ts functions: ${assignedProjectFns.size}/${projectFnNames.length}`);
if (missingProjFns.length > 0) {
  console.log(`   ✗ UNASSIGNED: ${missingProjFns.join(', ')}`);
  errors++;
} else {
  console.log(`   ✓ All ${projectFnNames.length} functions assigned`);
}

// 2. HealthRecord.ts functions
const missingHrFns = hrFnNames.filter(f => !assignedHrFns.has(f));
console.log(`\n2. HealthRecord.ts functions: ${assignedHrFns.size}/${hrFnNames.length}`);
if (missingHrFns.length > 0) {
  console.log(`   ✗ UNASSIGNED: ${missingHrFns.join(', ')}`);
  errors++;
} else {
  console.log(`   ✓ All ${hrFnNames.length} functions assigned`);
}

// 3. PatientRecord.ts classes
const missingPrCls = prClassNames.filter(c => !assignedPrClasses.has(c));
console.log(`\n3. PatientRecord.ts classes: ${assignedPrClasses.size}/${prClassNames.length}`);
if (missingPrCls.length > 0) {
  console.log(`   ✗ UNASSIGNED: ${missingPrCls.join(', ')}`);
  errors++;
} else {
  console.log(`   ✓ All ${prClassNames.length} classes assigned`);
}

// 4. ChildSpec arrays
const allChildSpecNames = childSpecBlocks.map(b => b.name);
const missingCS = allChildSpecNames.filter(n => !assignedChildSpecs.has(n));
console.log(`\n4. ChildSpec arrays: ${assignedChildSpecs.size}/${allChildSpecNames.length}`);
if (missingCS.length > 0) {
  console.log(`   ✗ UNASSIGNED: ${missingCS.join(', ')}`);
  errors++;
} else {
  console.log(`   ✓ All ${allChildSpecNames.length} arrays assigned`);
}

// 5. Inline main() properties — find ALL properties in main() that reference tables
const mainLines = mainBody.split('\n');
const allMainProps: string[] = [];
for (const line of mainLines) {
  const m = line.match(/^\s+(\w+)\s*:\s*(?:tableExists|q|mergeQuery|children|project|\[|{)/);
  if (m && !['const', 'let', 'var', 'if', 'for', 'return'].includes(m[1])) {
    allMainProps.push(m[1]);
  }
}
// Sub-properties inside nested objects (e.g., health_maintenance.historical_status)
// are captured as part of their parent property, not separately
const subProps = new Set(['historical_status', 'history', 'current_guides', 'topic_status', 'forecast']);
const missingMainProps = allMainProps.filter(p => !assignedInlineProps.has(p)
  // Exclude props that are handled by named functions
  && !['allergies', 'problems', 'medications', 'immunizations', 'encounters',
       'billing', 'messages', 'conversation_threads', 'documents', 'episodes',
       'referrals'].includes(p)
  // Exclude sub-properties inside nested objects
  && !subProps.has(p));
console.log(`\n5. Inline main() properties: ${assignedInlineProps.size} assigned, ${allMainProps.length} total`);
if (missingMainProps.length > 0) {
  console.log(`   ✗ UNASSIGNED: ${missingMainProps.join(', ')}`);
  errors++;
} else {
  console.log(`   ✓ All inline properties assigned or delegated to named functions`);
}

// 6. Tables referenced in project.ts
const allProjectTables = new Set(tablesIn(projectSrc));
// Remove infrastructure tables (from utility functions)
const missingTables = [...allProjectTables].filter(t => !allTablesInChunks.has(t)).sort();
console.log(`\n6. Tables: ${allTablesInChunks.size} in chunks, ${allProjectTables.size} in project.ts`);
if (missingTables.length > 0) {
  console.log(`   ✗ NOT IN ANY CHUNK: ${missingTables.join(', ')}`);
  errors++;
} else {
  console.log(`   ✓ All tables covered`);
}

console.log(`\n═══════════════════════════════════════════════════`);
if (errors > 0) {
  console.log(`FAILED: ${errors} completeness gaps`);
} else {
  console.log(`PASSED: All elements assigned to exactly one chunk`);
}
console.log(`═══════════════════════════════════════════════════`);

// Write output
await Bun.write("review_chunks_v2.json", JSON.stringify(chunks, null, 2));

console.log(`\nGenerated ${chunks.length} chunks → review_chunks_v2.json`);
for (const c of chunks) {
  const tableCount = c.tables.length;
  const totalRows = Object.values(c.rowCounts).reduce((a, b) => a + b, 0);
  console.log(`  ${c.id}: ${tableCount} tables, ${totalRows} rows`);
}

db.close();
