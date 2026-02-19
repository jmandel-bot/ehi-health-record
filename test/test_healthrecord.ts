/**
 * test_healthrecord.ts — Comprehensive HealthRecord tests
 *
 * 1. Hydration round-trip: patient_record.json → loadPatientRecord → projectHealthRecord → validate
 * 2. Schema validation: no undefined, dates are ISO 8601, ids are strings, arrays are arrays
 *
 * Usage: bun run test_healthrecord.ts
 */
import { loadPatientRecord } from "../src/PatientRecord";
import { projectHealthRecord, serializeHealthRecord } from "../src/HealthRecord";
import type { HealthRecord } from "../src/HealthRecord";

let passed = 0;
let failed = 0;
const failures: string[] = [];

function assert(condition: boolean, msg: string) {
  if (condition) {
    passed++;
  } else {
    failed++;
    failures.push(msg);
    console.log(`  FAIL: ${msg}`);
  }
}

// ════════════════════════════════════════════════════════════════════════════
// Load & project
// ════════════════════════════════════════════════════════════════════════════

console.log("\n═══ Loading patient_record.json ═══");
const raw = await Bun.file("patient_record.json").json();
const record = loadPatientRecord(raw);
const hr = projectHealthRecord(record);

console.log(`  Demographics: ${hr.demographics.name} (${hr.demographics.mrn})`);
console.log(`  Visits: ${hr.visits.length}`);
console.log(`  Allergies: ${hr.allergies.length}`);
console.log(`  Medications: ${hr.medications.length}`);
console.log(`  Problems: ${hr.problems.length}`);
console.log(`  Lab results: ${hr.labResults.length}`);
console.log(`  Messages: ${hr.messages.length}`);

// ════════════════════════════════════════════════════════════════════════════
// 1. HYDRATION ROUND-TRIP TEST
// ════════════════════════════════════════════════════════════════════════════

console.log("\n═══ 1. Hydration round-trip ═══");

// Test JSON round-trip: serialize → parse → re-project
const serialized = serializeHealthRecord(hr, { includeEpic: true });
const reparsed = JSON.parse(serialized);
assert(reparsed._version === "0.1.0", "_version survives round-trip");
assert(reparsed._source === "epic-ehi", "_source survives round-trip");
assert(typeof reparsed._projected === "string" && reparsed._projected.length > 0,
  "_projected is non-empty string after round-trip");

// Demographics
assert(typeof hr.demographics.name === "string" && hr.demographics.name.length > 0,
  "demographics.name is a non-empty string");
assert(typeof hr.demographics.firstName === "string" && hr.demographics.firstName.length > 0,
  "demographics.firstName is a non-empty string");
assert(typeof hr.demographics.lastName === "string" && hr.demographics.lastName.length > 0,
  "demographics.lastName is a non-empty string");
assert(typeof hr.demographics.mrn === "string" && hr.demographics.mrn.length > 0,
  "demographics.mrn is a non-empty string");
assert(hr.demographics.dateOfBirth === null || /^\d{4}-\d{2}-\d{2}/.test(hr.demographics.dateOfBirth),
  "demographics.dateOfBirth is null or ISO date");

// Visits
assert(Array.isArray(hr.visits) && hr.visits.length > 0,
  "visits is a non-empty array");

// At least one visit has diagnoses
const visitsWithDx = hr.visits.filter(v => v.diagnoses.length > 0);
assert(visitsWithDx.length > 0,
  `at least one visit has diagnoses (found ${visitsWithDx.length})`);

// At least one visit has orders
const visitsWithOrders = hr.visits.filter(v => v.orders.length > 0);
assert(visitsWithOrders.length > 0,
  `at least one visit has orders (found ${visitsWithOrders.length})`);

// At least one visit has notes
const visitsWithNotes = hr.visits.filter(v => v.notes.length > 0);
assert(visitsWithNotes.length > 0,
  `at least one visit has notes (found ${visitsWithNotes.length})`);

// Allergies
assert(Array.isArray(hr.allergies) && hr.allergies.length > 0,
  "allergies is a non-empty array");
assert(hr.allergies.every(a => typeof a.allergen === "string" && a.allergen.length > 0),
  "every allergy has a non-empty allergen name");
assert(hr.allergies.every(a => typeof a.id === "string"),
  "every allergy has a string id");

// Medications
assert(Array.isArray(hr.medications) && hr.medications.length > 0,
  "medications is a non-empty array");
const medsWithName = hr.medications.filter(m => m.name.length > 0);
assert(medsWithName.length > 0,
  `at least one medication has a name (found ${medsWithName.length})`);

// Problems
assert(Array.isArray(hr.problems) && hr.problems.length > 0,
  "problems is a non-empty array");
assert(hr.problems.every(p => typeof p.name === "string" && p.name.length > 0),
  "every problem has a non-empty name");

// Lab results
assert(Array.isArray(hr.labResults) && hr.labResults.length > 0,
  "labResults is a non-empty array");
assert(hr.labResults.every(l => typeof l.orderId === "string"),
  "every lab result has a string orderId");

// Messages
assert(Array.isArray(hr.messages), "messages is an array");
if (hr.messages.length > 0) {
  assert(hr.messages.every(m => typeof m.id === "string"),
    "every message has a string id");
}

// Billing
assert(typeof hr.billing === "object" && hr.billing !== null,
  "billing is an object");
assert(Array.isArray(hr.billing.charges), "billing.charges is an array");
assert(Array.isArray(hr.billing.payments), "billing.payments is an array");
assert(Array.isArray(hr.billing.claims), "billing.claims is an array");

// Social history
if (hr.socialHistory !== null) {
  assert(typeof hr.socialHistory.current === "object" && hr.socialHistory.current !== null,
    "socialHistory.current is an object");
  assert(Array.isArray(hr.socialHistory.prior),
    "socialHistory.prior is an array");
}

// Surgical history
assert(Array.isArray(hr.surgicalHistory), "surgicalHistory is an array");

// Family history
assert(Array.isArray(hr.familyHistory), "familyHistory is an array");

// Immunizations
assert(Array.isArray(hr.immunizations), "immunizations is an array");

// ════════════════════════════════════════════════════════════════════════════
// 2. SCHEMA VALIDATION
// ════════════════════════════════════════════════════════════════════════════

console.log("\n═══ 2. Schema validation ═══");

// Walk the HealthRecord recursively, checking invariants
const schemaErrors: string[] = [];

function walkSchema(obj: unknown, path: string) {
  if (obj === undefined) {
    schemaErrors.push(`${path} is undefined (should be null or absent)`);
    return;
  }
  if (obj === null) return;
  if (Array.isArray(obj)) {
    for (let i = 0; i < obj.length; i++) {
      walkSchema(obj[i], `${path}[${i}]`);
    }
    return;
  }
  if (typeof obj === "object") {
    for (const [key, value] of Object.entries(obj as Record<string, unknown>)) {
      // Skip _epic — it's raw Epic data, not our schema
      if (key === "_epic") continue;

      // Check for undefined values (should be null, not undefined)
      if (value === undefined) {
        schemaErrors.push(`${path}.${key} is undefined (should be null or absent)`);
        continue;
      }

      // Check: id fields should be strings
      if (/^(id|orderId|visitId)$/.test(key) && value !== null && typeof value !== "string") {
        schemaErrors.push(`${path}.${key} should be string, got ${typeof value}`);
      }

      // Check: date fields should be ISO 8601 or null
      if (/^(date|Date|startDate|endDate|dateOfBirth|dateNoted|dateOfOnset|dateResolved|orderedDate|resultDate|sentDate|receivedDate|serviceDate|paymentDate|claimDate)$/.test(key)) {
        if (value !== null && typeof value === "string") {
          // ISO 8601: YYYY-MM-DD or YYYY-MM-DDTHH:MM:SS.sssZ
          if (!/^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}:\d{2}(\.\d+)?Z?)?$/.test(value)) {
            schemaErrors.push(`${path}.${key} = "${value}" doesn't match ISO 8601`);
          }
        } else if (value !== null) {
          schemaErrors.push(`${path}.${key} should be string|null, got ${typeof value}`);
        }
      }

      // Check: known array fields should actually be arrays
      const arrayFields = new Set([
        "allergies", "problems", "medications", "immunizations", "visits",
        "labResults", "messages", "surgicalHistory", "familyHistory",
        "diagnoses", "orders", "notes", "vitalSigns", "results",
        "reactions", "reasonsForVisit", "associatedDiagnoses", "race",
        "conditions", "charges", "payments", "claims", "accounts",
        "transactionActions", "eobLineItems", "collectionEvents",
        "snapshots", "modifiers", "diagnosisCodes",
      ]);
      if (arrayFields.has(key) && !Array.isArray(value)) {
        schemaErrors.push(`${path}.${key} should be array, got ${typeof value}`);
      }

      walkSchema(value, `${path}.${key}`);
    }
  }
}

walkSchema(hr, "hr");

if (schemaErrors.length > 0) {
  console.log(`  Schema errors found: ${schemaErrors.length}`);
  // Show first 20
  for (const e of schemaErrors.slice(0, 20)) {
    console.log(`    ${e}`);
  }
  if (schemaErrors.length > 20) {
    console.log(`    ... and ${schemaErrors.length - 20} more`);
  }
}
assert(schemaErrors.length === 0,
  `schema has ${schemaErrors.length} errors (expected 0)`);

// Additional: check no field in serialized JSON has undefined
// (JSON.stringify naturally strips undefined, but let's verify the raw object)
console.log("\n  Checking no undefined values in raw HR object...");
let undefinedCount = 0;
function countUndefined(obj: unknown, path: string) {
  if (obj === undefined) { undefinedCount++; return; }
  if (obj === null || typeof obj !== "object") return;
  if (Array.isArray(obj)) {
    obj.forEach((v, i) => countUndefined(v, `${path}[${i}]`));
  } else {
    for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
      if (v === undefined) undefinedCount++;
      else countUndefined(v, `${path}.${k}`);
    }
  }
}
countUndefined(hr, "hr");
assert(undefinedCount === 0, `found ${undefinedCount} undefined values (expected 0)`);

// Verify round-trip through JSON doesn't lose data
console.log("  Checking JSON round-trip preserves structure...");
const fullJson = JSON.parse(JSON.stringify(hr));
assert(fullJson.visits.length === hr.visits.length,
  "JSON round-trip preserves visits count");
assert(fullJson.allergies.length === hr.allergies.length,
  "JSON round-trip preserves allergies count");
assert(fullJson.medications.length === hr.medications.length,
  "JSON round-trip preserves medications count");
assert(fullJson.problems.length === hr.problems.length,
  "JSON round-trip preserves problems count");
assert(fullJson.labResults.length === hr.labResults.length,
  "JSON round-trip preserves labResults count");

// ════════════════════════════════════════════════════════════════════════════
// 3. FIELD CONTENT SPOT CHECKS
// ════════════════════════════════════════════════════════════════════════════

console.log("\n═══ 3. Field content spot checks ═══");

// Every visit should have an id and a date (or null)
for (let i = 0; i < Math.min(hr.visits.length, 5); i++) {
  const v = hr.visits[i];
  assert(typeof v.id === "string" && v.id.length > 0, `visit[${i}].id is non-empty string`);
  assert(v.date === null || /^\d{4}-\d{2}-\d{2}/.test(v.date), `visit[${i}].date is null or ISO`);
}

// Every allergy reaction should be a string
for (const a of hr.allergies) {
  assert(Array.isArray(a.reactions), `allergy ${a.id} reactions is array`);
  for (const r of a.reactions) {
    assert(typeof r === "string", `allergy ${a.id} reaction is string, got ${typeof r}`);
  }
}

// Every diagnosis has a name
for (const v of hr.visits) {
  for (const dx of v.diagnoses) {
    assert(typeof dx.name === "string" && dx.name.length > 0,
      `visit ${v.id} diagnosis has non-empty name`);
  }
}

// Lab results have component names
const labsWithComponent = hr.labResults.filter(l => l.component.length > 0);
assert(labsWithComponent.length > 0,
  `at least some lab results have component names (${labsWithComponent.length}/${hr.labResults.length})`);

// Billing charges have amounts
if (hr.billing.charges.length > 0) {
  const chargesWithAmount = hr.billing.charges.filter(c => c.amount !== null && c.amount !== undefined);
  assert(chargesWithAmount.length > 0,
    `at least some charges have amounts (${chargesWithAmount.length}/${hr.billing.charges.length})`);
}

// ════════════════════════════════════════════════════════════════════════════
// SUMMARY
// ════════════════════════════════════════════════════════════════════════════

console.log("\n" + "═".repeat(60));
console.log(`RESULTS: ${passed} passed, ${failed} failed`);
if (failures.length > 0) {
  console.log("\nFailures:");
  for (const f of failures) {
    console.log(`  ✗ ${f}`);
  }
}
console.log("═".repeat(60));

process.exit(failed > 0 ? 1 : 0);
