/**
 * Generate self-contained review chunks for semantic analysis.
 * Each chunk includes: schema descriptions, projection code, sample data,
 * and the HealthRecord output — everything an LLM needs to spot semantic errors.
 */
import { Database } from "bun:sqlite";
import { readFileSync } from "fs";

const db = new Database("ehi_clean.db", { readonly: true });
function q(sql: string, p: unknown[] = []) { return db.query(sql).all(...p) as Record<string,unknown>[]; }
function tableCols(t: string) { return q(`PRAGMA table_info("${t}")`).map(r => r.name as string); }

function loadSchema(table: string): any {
  try { return JSON.parse(readFileSync(`schemas/${table}.json`, 'utf-8')); }
  catch { return null; }
}

function schemaDescriptions(table: string): Record<string, string> {
  const schema = loadSchema(table);
  if (!schema) return {};
  const descs: Record<string, string> = {};
  if (schema.description) descs['_TABLE_'] = schema.description;
  for (const col of schema.columns ?? []) {
    if (col.description) descs[col.name] = col.description;
  }
  return descs;
}

function sampleRows(table: string, limit = 3): Record<string, unknown>[] {
  try { return q(`SELECT * FROM "${table}" LIMIT ${limit}`); }
  catch { return []; }
}

function nonNullSample(table: string): Record<string, string> {
  const cols = tableCols(table);
  const result: Record<string, string> = {};
  for (const col of cols) {
    const val = q(`SELECT "${col}" FROM "${table}" WHERE "${col}" IS NOT NULL AND "${col}" != '' LIMIT 1`);
    if (val.length > 0) result[col] = String(val[0][col]).slice(0, 100);
  }
  return result;
}

// Extract code sections from project.ts, PatientRecord.ts, HealthRecord.ts
const projectSrc = readFileSync("project.ts", "utf-8");
const prSrc = readFileSync("PatientRecord.ts", "utf-8");
const hrSrc = readFileSync("HealthRecord.ts", "utf-8");

interface ReviewChunk {
  id: string;
  title: string;
  tables: string[];
  schemaDescriptions: Record<string, Record<string, string>>;
  sampleData: Record<string, Record<string, string>>;
  projectionCode: string;
  patientRecordCode: string;
  healthRecordCode: string;
  healthRecordOutput: any;
}

// Load the health record output for reference
const hrOutput = JSON.parse(readFileSync("health_record_full.json", "utf-8"));

function extractCodeBlock(src: string, startPattern: RegExp, endPatterns: RegExp[]): string {
  const lines = src.split('\n');
  let capturing = false;
  let depth = 0;
  const result: string[] = [];
  for (const line of lines) {
    if (!capturing && startPattern.test(line)) {
      capturing = true;
      depth = 0;
    }
    if (capturing) {
      result.push(line);
      depth += (line.match(/\{/g) || []).length - (line.match(/\}/g) || []).length;
      for (const ep of endPatterns) {
        if (ep.test(line) && depth <= 0 && result.length > 2) {
          return result.join('\n');
        }
      }
      if (depth <= 0 && result.length > 5) break;
    }
  }
  return result.join('\n');
}

function extractFunction(src: string, name: string): string {
  const lines = src.split('\n');
  let start = -1;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].includes(`function ${name}`) || lines[i].includes(`${name}(`)) {
      start = i;
      break;
    }
  }
  if (start === -1) return '';
  let depth = 0;
  let started = false;
  const result: string[] = [];
  for (let i = start; i < lines.length; i++) {
    result.push(lines[i]);
    depth += (lines[i].match(/\{/g) || []).length - (lines[i].match(/\}/g) || []).length;
    if (depth > 0) started = true;
    if (started && depth <= 0) break;
  }
  return result.join('\n');
}

function extractClass(src: string, name: string): string {
  const lines = src.split('\n');
  let start = -1;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].includes(`class ${name}`) || lines[i].includes(`interface ${name}`)) {
      start = i;
      break;
    }
  }
  if (start === -1) return '';
  let depth = 0;
  let started = false;
  const result: string[] = [];
  for (let i = start; i < lines.length; i++) {
    result.push(lines[i]);
    depth += (lines[i].match(/\{/g) || []).length - (lines[i].match(/\}/g) || []).length;
    if (depth > 0) started = true;
    if (started && depth <= 0) break;
  }
  return result.join('\n');
}

// Define chunks
const chunks: ReviewChunk[] = [
  {
    id: "allergies",
    title: "Allergies: ALLERGY → Allergy → HealthRecord.allergies",
    tables: ["ALLERGY", "ALLERGY_REACTIONS", "PAT_ALLERGIES"],
    schemaDescriptions: {},
    sampleData: {},
    projectionCode: extractFunction(projectSrc, "projectAllergies"),
    patientRecordCode: extractClass(prSrc, "Allergy"),
    healthRecordCode: extractFunction(hrSrc, "projectAllergy"),
    healthRecordOutput: hrOutput.allergies,
  },
  {
    id: "social_history",
    title: "Social History: SOCIAL_HX → HistoryTimeline → HealthRecord.socialHistory",
    tables: ["SOCIAL_HX"],
    schemaDescriptions: {},
    sampleData: {},
    projectionCode: `// In main():\nsocial_history: q(\`SELECT * FROM SOCIAL_HX\`),`,
    patientRecordCode: extractClass(prSrc, "HistoryTimeline") + "\n\n" + extractFunction(prSrc, "buildTimeline"),
    healthRecordCode: extractFunction(hrSrc, "projectSocialHistory") + "\n\n" + extractFunction(hrSrc, "projectOneSocialHistory"),
    healthRecordOutput: hrOutput.socialHistory,
  },
  {
    id: "lab_results",
    title: "Lab Results: ORDER_PROC → ORDER_RESULTS → ORDER_PARENT_INFO chain → HealthRecord.labResults",
    tables: ["ORDER_PROC", "ORDER_RESULTS", "ORDER_PARENT_INFO"],
    schemaDescriptions: {},
    sampleData: {},
    projectionCode: extractFunction(projectSrc, "projectOrder"),
    patientRecordCode: extractClass(prSrc, "Order") + "\n\n" + extractClass(prSrc, "OrderResult"),
    healthRecordCode: extractFunction(hrSrc, "projectOrder") + "\n\n" + extractFunction(hrSrc, "projectResult") + "\n\n" + extractFunction(hrSrc, "projectAllLabResults"),
    healthRecordOutput: hrOutput.labResults,
  },
  {
    id: "medications",
    title: "Medications: ORDER_MED (7 splits) → HealthRecord.medications",
    tables: ["ORDER_MED", "ORDER_MED_2", "ORDER_MED_3", "ORDER_DX_MED", "ORDER_MED_SIG"],
    schemaDescriptions: {},
    sampleData: {},
    projectionCode: extractFunction(projectSrc, "projectMedications"),
    patientRecordCode: `// Medications are raw EpicRow[] — no typed class`,
    healthRecordCode: extractFunction(hrSrc, "projectMedication"),
    healthRecordOutput: hrOutput.medications,
  },
  {
    id: "encounters",
    title: "Encounters: PAT_ENC (7 splits) → Encounter → HealthRecord.visits",
    tables: ["PAT_ENC", "PAT_ENC_2", "PAT_ENC_DX", "PAT_ENC_RSN_VISIT"],
    schemaDescriptions: {},
    sampleData: {},
    projectionCode: extractFunction(projectSrc, "projectEncounter"),
    patientRecordCode: extractClass(prSrc, "Encounter"),
    healthRecordCode: extractFunction(hrSrc, "projectVisit"),
    healthRecordOutput: hrOutput.visits?.slice(0, 2),
  },
  {
    id: "messages",
    title: "Messages: MYC_MESG → MSG_TXT → Message → HealthRecord.messages",
    tables: ["MYC_MESG", "MSG_TXT", "MYC_MESG_RTF_TEXT"],
    schemaDescriptions: {},
    sampleData: {},
    projectionCode: extractFunction(projectSrc, "projectMessages"),
    patientRecordCode: extractClass(prSrc, "Message"),
    healthRecordCode: extractFunction(hrSrc, "projectMessage"),
    healthRecordOutput: hrOutput.messages?.slice(0, 3),
  },
  {
    id: "billing",
    title: "Billing: ARPB_TRANSACTIONS → BillingTransaction → HealthRecord.billing",
    tables: ["ARPB_TRANSACTIONS", "ARPB_VISITS", "ARPB_TX_ACTIONS", "CLARITY_EPM"],
    schemaDescriptions: {},
    sampleData: {},
    projectionCode: extractFunction(projectSrc, "projectBilling"),
    patientRecordCode: extractClass(prSrc, "BillingTransaction") + "\n\n" + extractClass(prSrc, "BillingVisit"),
    healthRecordCode: extractFunction(hrSrc, "projectBilling"),
    healthRecordOutput: hrOutput.billing,
  },
  {
    id: "family_history",
    title: "Family History: FAMILY_HX_STATUS + FAMILY_HX → HealthRecord.familyHistory",
    tables: ["FAMILY_HX_STATUS", "FAMILY_HX"],
    schemaDescriptions: {},
    sampleData: {},
    projectionCode: `// In main():\nfamily_history: tableExists("FAMILY_HX_STATUS") ? q(\`SELECT * FROM FAMILY_HX_STATUS\`) : [],\nfamily_hx: tableExists("FAMILY_HX") ? q(\`SELECT * FROM FAMILY_HX\`) : [],`,
    patientRecordCode: `// family_history → HistoryTimeline via buildTimeline()\n// family_hx → stored as _raw.family_hx`,
    healthRecordCode: extractFunction(hrSrc, "projectFamilyHistory"),
    healthRecordOutput: hrOutput.familyHistory,
  },
  {
    id: "demographics",
    title: "Demographics: PATIENT (6 splits) + PATIENT_RACE + PAT_ADDRESS → HealthRecord.demographics",
    tables: ["PATIENT", "PATIENT_2", "PATIENT_3", "PATIENT_4", "PATIENT_5", "PATIENT_6", "PATIENT_RACE", "PAT_ADDRESS"],
    schemaDescriptions: {},
    sampleData: {},
    projectionCode: extractFunction(projectSrc, "projectPatient"),
    patientRecordCode: `// Patient is stored as raw EpicRow on PatientRecord.patient`,
    healthRecordCode: extractFunction(hrSrc, "projectDemographics"),
    healthRecordOutput: hrOutput.demographics,
  },
];

// Fill in schema descriptions and sample data
for (const chunk of chunks) {
  for (const table of chunk.tables) {
    chunk.schemaDescriptions[table] = schemaDescriptions(table);
    chunk.sampleData[table] = nonNullSample(table);
  }
}

await Bun.write("review_chunks.json", JSON.stringify(chunks, null, 2));
console.log(`Generated ${chunks.length} review chunks → review_chunks.json`);
for (const c of chunks) {
  console.log(`  ${c.id}: ${c.tables.length} tables`);
}

db.close();
