/**
 * Quick test: load patient_record.json → PatientRecord → HealthRecord
 */
import { loadPatientRecord } from "./PatientRecord";
import { projectHealthRecord, serializeHealthRecord } from "./HealthRecord";

const raw = await Bun.file("patient_record.json").json();
const record = loadPatientRecord(raw);

console.log("=== PatientRecord summary ===");
console.log(record.summary());

// Test some accessors
const visits = record.visits();
console.log(`\nClinical visits: ${visits.length}`);
for (const v of visits.slice(0, 3)) {
  console.log(`  ${v.toString()}`);
  const bv = v.billingVisit(record);
  if (bv) console.log(`    → Billing: charges=${bv.totalCharges}, payments=${bv.totalPayments}`);
  for (const o of v.orders.slice(0, 2)) {
    const results = o.allResults(record);
    if (results.length > 0) {
      console.log(`    → Order: ${o.description} (${results.length} results)`);
      for (const r of results.slice(0, 3)) {
        console.log(`      ${r.toString()}`);
      }
    }
  }
}

// Social history
const sh = record.socialHistory.latest();
if (sh) {
  console.log(`\nSocial History (latest):`);
  console.log(`  Tobacco: ${sh.TOBACCO_USER_C_NAME}`);
  console.log(`  Alcohol: ${sh.ALCOHOL_USE_C_NAME}`);
}

// Project to HealthRecord
console.log("\n=== HealthRecord projection ===");
const hr = projectHealthRecord(record);

console.log(`Demographics: ${hr.demographics.name} (${hr.demographics.mrn})`);
console.log(`Allergies: ${hr.allergies.length}`);
console.log(`Problems: ${hr.problems.length}`);
console.log(`Medications: ${hr.medications.length}`);
console.log(`Immunizations: ${hr.immunizations.length}`);
console.log(`Visits: ${hr.visits.length}`);
console.log(`Lab results: ${hr.labResults.length}`);
console.log(`Messages: ${hr.messages.length}`);
console.log(`Billing charges: ${hr.billing.charges.length}`);
console.log(`Billing payments: ${hr.billing.payments.length}`);
console.log(`Billing claims: ${hr.billing.claims.length}`);

// Serialize both ways
const compact = serializeHealthRecord(hr, { includeEpic: false });
const full = serializeHealthRecord(hr, { includeEpic: true });
console.log(`\nSerialized: ${Math.round(compact.length/1024)} KB (compact), ${Math.round(full.length/1024)} KB (with _epic)`);

// Write both
await Bun.write("health_record_compact.json", compact);
await Bun.write("health_record_full.json", full);
console.log("Written: health_record_compact.json, health_record_full.json");
