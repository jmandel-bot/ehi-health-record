/**
 * HealthRecord.ts — Clean patient health record: types + Epic→clean projection
 *
 * This is the TARGET format. A developer or LLM reading the types below
 * should understand the data without any Epic knowledge. The projection
 * function at the bottom transforms the raw Epic PatientRecord into this
 * clean schema, absorbing all the CSN semantics, order parent chains,
 * bridge tables, and split table merges into a single boundary crossing.
 *
 * Principles:
 *   - Clinical terms (visit, allergen, diagnosis) not Epic terms (CSN, PAT_ENC, DX_ID)
 *   - Visits only — system-generated contacts are filtered out
 *   - Lab results flattened — no parent→child order chain to navigate
 *   - History as latest snapshot — not a versioned timeline
 *   - Billing as charges/payments — not ARPB_TRANSACTIONS
 *   - Every entity has a stable `id` for cross-referencing
 *   - Dates are ISO 8601 (nullable — Epic data is often incomplete)
 *   - `_epic` escape hatch preserves original Epic columns on every entity
 *
 * Usage:
 *   import { projectHealthRecord } from './HealthRecord';
 *   import { loadPatientRecord } from './PatientRecord';
 *
 *   const raw = loadPatientRecord(JSON.parse(epicJson));
 *   const record = projectHealthRecord(raw);
 *   // → clean HealthRecord, no Epic knowledge needed
 */

// ─── Primitives ────────────────────────────────────────────────────────────

export type ISODate = string | null;
export type ISODateTime = string | null;
export type Id = string;
export type EpicRaw = Record<string, unknown>;

// ─── The Record ────────────────────────────────────────────────────────────

export interface HealthRecord {
  _version: "0.1.0";
  _projected: string;
  _source: "epic-ehi";

  demographics: Demographics;
  allergies: Allergy[];
  problems: Problem[];
  medications: Medication[];
  immunizations: Immunization[];
  visits: Visit[];
  labResults: LabResult[];
  socialHistory: SocialHistoryTimeline | null;
  surgicalHistory: SurgicalHistoryEntry[];
  familyHistory: FamilyMember[];
  messages: Message[];
  billing: BillingSummary;
}

// ─── Demographics ──────────────────────────────────────────────────────────

export interface Demographics {
  name: string;
  firstName: string;
  lastName: string;
  dateOfBirth: ISODate;
  sex: string | null;
  race: string[];
  ethnicity: string | null;
  language: string | null;
  maritalStatus: string | null;
  address: {
    street: string | null;
    city: string | null;
    state: string | null;
    zip: string | null;
    country: string | null;
  } | null;
  phone: string | null;
  email: string | null;
  mrn: string;
  primaryCareProvider: string | null;
  _epic: EpicRaw;
}

// ─── Clinical ──────────────────────────────────────────────────────────────

export interface Allergy {
  id: Id;
  allergen: string;
  type: string | null;
  reactions: string[];
  severity: string | null;
  status: string | null;
  dateNoted: ISODate;
  _epic: EpicRaw;
}

export interface Problem {
  id: Id;
  name: string;
  icdCode: string | null;
  dateOfOnset: ISODate;
  dateResolved: ISODate;
  status: string;
  isChronic: boolean;
  _epic: EpicRaw;
}

export interface Medication {
  id: Id;
  name: string;
  genericName: string | null;
  dose: string | null;
  route: string | null;
  frequency: string | null;
  sig: string | null;
  startDate: ISODate;
  endDate: ISODate;
  status: string | null;
  prescriber: string | null;
  pharmacy: string | null;
  associatedDiagnoses: string[];
  _epic: EpicRaw;
}

export interface Immunization {
  id: Id;
  vaccine: string;
  date: ISODate;
  site: string | null;
  route: string | null;
  dose: string | null;
  lotNumber: string | null;
  manufacturer: string | null;
  administeredBy: string | null;
  status: string | null;
  _epic: EpicRaw;
}

// ─── Visits ────────────────────────────────────────────────────────────────

export interface Visit {
  id: Id;
  date: ISODate;
  provider: string | null;
  department: string | null;
  type: string | null;
  status: string | null;
  reasonsForVisit: string[];
  diagnoses: VisitDiagnosis[];
  orders: VisitOrder[];
  notes: VisitNote[];
  vitalSigns: VitalSign[];
  _epic: EpicRaw;
}

export interface VisitDiagnosis {
  name: string;
  icdCode: string | null;
  isPrimary: boolean;
  _epic: EpicRaw;
}

export interface VisitOrder {
  id: Id;
  name: string;
  type: string | null;
  status: string | null;
  orderedDate: ISODateTime;
  /** Results already flattened through the parent→child order chain */
  results: OrderResult[];
  _epic: EpicRaw;
}

export interface OrderResult {
  component: string;
  value: string;
  unit: string | null;
  referenceRange: string | null;
  flag: string | null;
  isAbnormal: boolean;
  resultDate: ISODateTime;
  _epic: EpicRaw;
}

export interface VisitNote {
  id: Id;
  type: string | null;
  author: string | null;
  date: ISODateTime;
  text: string;
  _epic: EpicRaw;
}

export interface VitalSign {
  name: string;
  value: string;
  unit: string | null;
  takenAt: ISODateTime;
  _epic: EpicRaw;
}

// ─── Lab Results (flattened convenience view) ──────────────────────────────

/**
 * Every individual lab component, flattened across all visits.
 * This duplicates what's inside visit.orders[].results[], but makes it
 * trivial to answer "show me all my cholesterol values over time".
 */
export interface LabResult {
  orderId: Id;
  orderName: string;
  visitId: Id | null;
  visitDate: ISODate;
  component: string;
  value: string;
  unit: string | null;
  referenceRange: string | null;
  flag: string | null;
  isAbnormal: boolean;
  resultDate: ISODateTime;
  _epic: EpicRaw;
}

// ─── History ───────────────────────────────────────────────────────────────

/** Latest snapshot of social history */
export interface SocialHistory {
  tobacco: { status: string | null; packsPerDay: number | null; quitDate: ISODate };
  alcohol: { status: string | null; drinksPerWeek: number | null; comment: string | null };
  drugs: { status: string | null; comment: string | null };
  sexualActivity: string | null;
  asOf: ISODate;
  _epic: EpicRaw;
}

/** Social history with full timeline — only includes snapshots where content changed */
export interface SocialHistoryTimeline {
  current: SocialHistory;
  /** Older snapshots, most recent first. Only included when values differ from previous. */
  prior: SocialHistory[];
}

export interface SurgicalHistoryEntry {
  procedure: string;
  date: ISODate;
  comment: string | null;
  _epic: EpicRaw;
}

/** A family member with their medical conditions */
export interface FamilyMember {
  relation: string;
  status: string | null;       // "Alive", "Deceased"
  causeOfDeath: string | null;
  conditions: FamilyCondition[];
  _epic: EpicRaw;
}

export interface FamilyCondition {
  name: string;
  ageOfOnset: number | null;
  comment: string | null;
  _epic: EpicRaw;
}

// ─── Messages ──────────────────────────────────────────────────────────────

export interface Message {
  id: Id;
  date: ISODateTime;
  from: string | null;
  to: string | null;
  subject: string | null;
  body: string | null;
  status: string | null;
  threadId: Id | null;
  _epic: EpicRaw;
}

// ─── Billing ───────────────────────────────────────────────────────────────

export interface BillingSummary {
  charges: Charge[];
  payments: Payment[];
  claims: Claim[];
  accounts: BillingAccount[];
}

export interface Charge {
  id: Id;
  date: ISODate;
  service: string | null;
  amount: number | null;
  provider: string | null;
  visitId: Id | null;
  diagnosisCodes: string[];
  _epic: EpicRaw;
}

export interface Payment {
  id: Id;
  date: ISODate;
  amount: number | null;
  method: string | null;
  payer: string | null;
  relatedChargeId: Id | null;
  _epic: EpicRaw;
}

export interface Claim {
  id: Id;
  submitDate: ISODate;
  status: string | null;
  totalCharged: number | null;
  totalPaid: number | null;
  payer: string | null;
  provider: string | null;
  invoiceNumber: string | null;
  _epic: EpicRaw;
}

export interface BillingAccount {
  id: Id;
  type: string | null;
  name: string | null;
  accountClass: string | null;
  billingStatus: string | null;
  totalCharges: number | null;
  totalPayments: number | null;
  balance: number | null;
  _epic: EpicRaw;
}


/**
 * Serialize a HealthRecord to clean JSON, stripping noise.
 * Options:
 *   includeEpic: false (default) — omit _epic fields for a compact output
 *   includeEpic: true — keep _epic for full fidelity debugging
 */
export function serializeHealthRecord(hr: HealthRecord, opts?: { includeEpic?: boolean }): string {
  const includeEpic = opts?.includeEpic ?? false;
  return JSON.stringify(hr, (key, value) => {
    // Strip _epic unless opted in
    if (key === '_epic' && !includeEpic) return undefined;
    // Strip null values
    if (value === null) return undefined;
    // Strip empty strings
    if (value === '') return undefined;
    // Strip empty arrays
    if (Array.isArray(value) && value.length === 0) return undefined;
    return value;
  }, 2);
}

function toISODate(v: unknown): ISODate {
  if (!v || typeof v !== 'string') return null;
  try { const d = new Date(v.trim()); return isNaN(d.getTime()) ? null : d.toISOString().split('T')[0]; }
  catch { return null; }
}

function toISODateTime(v: unknown): ISODateTime {
  if (!v || typeof v !== 'string') return null;
  try {
    const d = new Date(v.trim());
    if (isNaN(d.getTime())) return null;
    return (d.getHours() === 0 && d.getMinutes() === 0) ? d.toISOString().split('T')[0] : d.toISOString();
  } catch { return null; }
}

function str(v: unknown): string | null { return (v == null || v === '') ? null : String(v); }
function num(v: unknown): number | null { const n = Number(v); return (v == null || v === '' || isNaN(n)) ? null : n; }
function sid(v: unknown): Id { return String(v ?? ''); }

function epic(obj: any): EpicRaw {
  const raw: EpicRaw = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v != null && !Array.isArray(v) && typeof v !== 'object') raw[k] = v;
  }
  return raw;
}

type R = any; // PatientRecord

export function projectHealthRecord(r: R): HealthRecord {
  return {
    _version: "0.1.0",
    _projected: new Date().toISOString(),
    _source: "epic-ehi",
    demographics: projectDemographics(r),
    allergies: r.allergies.map(projectAllergy),
    problems: r.problems.map(projectProblem),
    medications: r.medications.map(projectMedication),
    immunizations: r.immunizations.map(projectImmunization),
    visits: r.visits().map((v: any) => projectVisit(v, r)),
    labResults: projectAllLabResults(r),
    socialHistory: projectSocialHistory(r),
    surgicalHistory: projectSurgicalHistory(r),
    familyHistory: projectFamilyHistory(r),
    messages: r.messages.map(projectMessage),
    billing: projectBilling(r),
  };
}

function projectDemographics(r: R): Demographics {
  const p = r.patient;
  return {
    name: p.PAT_NAME?.replace(',', ', ') ?? '',
    firstName: p.PAT_FIRST_NAME ?? '', lastName: p.PAT_LAST_NAME ?? '',
    dateOfBirth: toISODate(p.BIRTH_DATE), sex: str(p.SEX_C_NAME),
    race: [], ethnicity: str(p.ETHNIC_GROUP_C_NAME),
    language: str(p.LANGUAGE_C_NAME), maritalStatus: str(p.MARITAL_STATUS_C_NAME),
    address: (p.CITY || p.STATE_C_NAME || p.ZIP) ? {
      street: str(p.ADD_LINE_1), city: str(p.CITY),
      state: str(p.STATE_C_NAME), zip: str(p.ZIP), country: str(p.COUNTRY_C_NAME),
    } : null,
    phone: str(p.HOME_PHONE), email: str(p.EMAIL_ADDRESS),
    mrn: String(p.PAT_MRN_ID ?? ''),
    primaryCareProvider: str(p.CUR_PCP_PROV_ID_NAME),
    _epic: epic(p),
  };
}

function projectAllergy(a: any): Allergy {
  return {
    id: sid(a.ALLERGY_ID),
    allergen: a.allergenName ?? a.ALLERGEN_ID_ALLERGEN_NAME ?? 'Unknown',
    type: str(a.ALLERGY_TYPE_C_NAME),
    reactions: (a.reactions ?? []).map((r: any) => r.REACTION_NAME ?? r.REACTION_C_NAME ?? 'Unknown'),
    severity: str(a.SEVERITY_C_NAME ?? a.ALLERGY_SEVERITY_C_NAME),
    status: str(a.ALRGY_STATUS_C_NAME),
    dateNoted: toISODate(a.DATE_NOTED),
    _epic: epic(a),
  };
}

function projectProblem(p: any): Problem {
  return {
    id: sid(p.PROBLEM_LIST_ID),
    name: p.diagnosisName ?? p._dx_name ?? 'Unknown',
    icdCode: str(p.DX_ID),
    dateOfOnset: toISODate(p.NOTED_DATE ?? p.DATE_OF_ENTRY),
    dateResolved: toISODate(p.RESOLVED_DATE),
    status: str(p.PROBLEM_STATUS_C_NAME) ?? (p.RESOLVED_DATE ? 'Resolved' : 'Active'),
    isChronic: p.CHRONIC_YN === 'Y',
    _epic: epic(p),
  };
}

function projectMedication(m: any): Medication {
  const dose = [str(m.HV_DISCRETE_DOSE), str(m.HV_DOSE_UNIT_C_NAME)].filter(Boolean).join(' ') || null;
  return {
    id: sid(m.ORDER_MED_ID),
    name: m.AMB_MED_DISP_NAME ?? m.DISPLAY_NAME ?? m.DESCRIPTION ?? 'Unknown',
    genericName: str(m.DESCRIPTION),
    dose, route: str(m.MED_ROUTE_C_NAME),
    frequency: str(m.HV_DISCR_FREQ_ID_FREQ_NAME),
    sig: str(m.SIG),
    startDate: toISODate(m.START_DATE), endDate: toISODate(m.END_DATE),
    status: str(m.ORDER_STATUS_C_NAME),
    prescriber: str(m.ORD_CREATR_USER_ID_NAME),
    pharmacy: str(m.PHARMACY_ID_PHARMACY_NAME),
    associatedDiagnoses: (m.associatedDiagnoses ?? []).map((d: any) => d.DX_NAME ?? String(d.DX_ID)),
    _epic: epic(m),
  };
}

function projectImmunization(i: any): Immunization {
  return {
    id: sid(i.IMMUNE_ID),
    vaccine: i.IMMUNZATN_ID_NAME ?? 'Unknown',
    date: toISODate(i.IMMUNE_DATE),
    site: str(i.SITE_C_NAME), route: str(i.ROUTE_C_NAME),
    dose: str(i.DOSE), lotNumber: str(i.LOT_NUM),
    manufacturer: str(i.MANUFACTURER_C_NAME),
    administeredBy: str(i.ENTRY_USER_ID_NAME),
    status: str(i.IMMNZTN_STATUS_C_NAME),
    _epic: epic(i),
  };
}

function projectVisit(v: any, r: R): Visit {
  return {
    id: sid(v.PAT_ENC_CSN_ID),
    date: toISODate(v.contactDate ?? v.CONTACT_DATE),
    provider: str(v.visitProviderName),
    department: str(v.departmentName),
    type: str(v.encounterType),
    status: str(v.APPT_STATUS_C_NAME),
    reasonsForVisit: v.reasonsForVisit ?? [],
    diagnoses: (v.diagnoses ?? []).map((dx: any, i: number): VisitDiagnosis => ({
      name: dx._dx_name ?? dx.DX_NAME ?? `Diagnosis ${dx.DX_ID}`,
      icdCode: str(dx.DX_ID), isPrimary: dx.PRIMARY_DX_YN === 'Y' || i === 0,
      _epic: epic(dx),
    })),
    orders: (v.orders ?? []).map((o: any) => projectOrder(o, r)),
    notes: (v.notes ?? [])
      .map((n: any): VisitNote => ({
        id: sid(n.NOTE_ID),
        type: str(n.IP_NOTE_TYPE_C_NAME),
        author: str(n.AUTHOR_NAME ?? n.ENTRY_USER_ID_NAME),
        date: toISODateTime(n.ENTRY_INSTANT_DTTM),
        text: Array.isArray(n.text) ? n.text.map((t: any) => t.NOTE_TEXT ?? '').join('') : '',
        _epic: epic(n),
      }))
      .filter((n: VisitNote) => n.text.trim().length > 0), // drop empty notes
    vitalSigns: (v.flowsheets ?? []).map((f: any): VitalSign => ({
      name: f.FLO_MEAS_NAME ?? 'Unknown', value: String(f.MEAS_VALUE ?? ''),
      unit: str(f.UNITS), takenAt: toISODateTime(f.RECORDED_TIME),
      _epic: epic(f),
    })),
    _epic: epic(v),
  };
}

function projectOrder(o: any, r: R): VisitOrder {
  const rawResults = o.allResults?.(r) ?? [];
  return {
    id: sid(o.ORDER_PROC_ID),
    name: o.description ?? o.DESCRIPTION ?? 'Unknown',
    type: str(o.orderType ?? o.ORDER_TYPE_C_NAME),
    status: str(o.orderStatus ?? o.ORDER_STATUS_C_NAME),
    orderedDate: toISODateTime(o.ORDER_INST ?? o.ORDERING_DATE),
    results: rawResults.map(projectResult),
    _epic: epic(o),
  };
}

function projectResult(res: any): OrderResult {
  return {
    component: res.componentName ?? res.COMPONENT_ID_COMPONENT_NAME ?? 'Unknown',
    value: String(res.ORD_VALUE ?? res.value ?? ''),
    unit: str(res.REFERENCE_UNIT),
    referenceRange: (res.REFERENCE_LOW != null && res.REFERENCE_HIGH != null)
      ? `${res.REFERENCE_LOW}-${res.REFERENCE_HIGH}` : null,
    flag: str(res.RESULT_FLAG_C_NAME),
    isAbnormal: res.isAbnormal ?? (res.RESULT_FLAG_C_NAME != null && res.RESULT_FLAG_C_NAME !== 'Normal'),
    resultDate: toISODateTime(res.RESULT_DATE),
    _epic: epic(res),
  };
}

/** Flattened lab results with deduplication across parent→child order chain */
function projectAllLabResults(r: R): LabResult[] {
  const results: LabResult[] = [];
  const seen = new Set<string>();
  for (const v of r.visits()) {
    for (const o of v.orders ?? []) {
      for (const res of o.allResults?.(r) ?? []) {
        const key = `${res.ORDER_PROC_ID ?? o.ORDER_PROC_ID}-${res.LINE ?? ''}-${res.COMPONENT_ID ?? res.componentName ?? ''}`;
        if (seen.has(key)) continue;
        seen.add(key);
        results.push({
          orderId: sid(o.ORDER_PROC_ID),
          orderName: o.description ?? o.DESCRIPTION ?? 'Unknown',
          visitId: sid(v.PAT_ENC_CSN_ID), visitDate: toISODate(v.contactDate),
          ...projectResult(res),
        });
      }
    }
  }
  return results;
}

function projectSocialHistory(r: R): SocialHistoryTimeline | null {
  const tl = r.socialHistory;
  if (!tl?.snapshots?.length) return null;

  // Build all snapshots, most recent first
  const all: SocialHistory[] = tl.snapshots.map((s: any) => projectOneSocialHistory(s.data));

  // Deduplicate: only keep a snapshot if its content differs from the next-newer one
  const deduped: SocialHistory[] = [all[0]];
  for (let i = 1; i < all.length; i++) {
    if (socialHistoryDiffers(all[i], all[i - 1])) {
      deduped.push(all[i]);
    }
  }

  return {
    current: deduped[0],
    prior: deduped.slice(1),
  };
}

function projectOneSocialHistory(d: any): SocialHistory {
  return {
    tobacco: {
      status: str(d.TOBACCO_USER_C_NAME),
      packsPerDay: num(d.SMOKING_PACKS_PER_DAY),
      quitDate: toISODate(d.SMOKING_QUIT_DATE),
    },
    alcohol: {
      status: str(d.ALCOHOL_USE_C_NAME),
      drinksPerWeek: num(d.ALCOHOL_OZ_PER_WK),
      comment: str(d.ALCOHOL_COMMENT),
    },
    drugs: {
      status: str(d.IV_DRUG_USER_YN === 'Y' ? 'Yes' : d.IV_DRUG_USER_YN === 'N' ? 'No' : null),
      comment: str(d.ILLICIT_DRUG_CMT),
    },
    sexualActivity: str(d.SEXUALLY_ACTIVE_C_NAME),
    asOf: toISODate(d.CONTACT_DATE),
    _epic: epic(d),
  };
}

function socialHistoryDiffers(a: SocialHistory, b: SocialHistory): boolean {
  return a.tobacco.status !== b.tobacco.status ||
    a.alcohol.status !== b.alcohol.status ||
    a.alcohol.comment !== b.alcohol.comment ||
    a.drugs.status !== b.drugs.status ||
    a.sexualActivity !== b.sexualActivity;
}

function projectSurgicalHistory(r: R): SurgicalHistoryEntry[] {
  const tl = r.surgicalHistory;
  if (!tl?.snapshots?.length) return [];
  // Latest review snapshot, deduplicated by LINE
  const latestCSN = tl.snapshots[0].snapshotCSN;
  const byLine = new Map<number, any>();
  for (const s of tl.snapshots) {
    if (s.snapshotCSN === latestCSN) byLine.set(s.data.LINE, s.data);
  }
  return [...byLine.values()].map((p: any): SurgicalHistoryEntry => ({
    procedure: p._proc_name ?? p.PROC_NAME ?? p.COMMENTS ?? `Procedure #${p.PROC_ID}`,
    date: toISODate(p.SURGICAL_HX_DATE),
    comment: str(p.COMMENTS ?? p.PROC_COMMENTS),
    _epic: epic(p),
  }));
}

function projectFamilyHistory(r: R): FamilyMember[] {
  const memberMap = new Map<string, FamilyMember>();

  // Roster from FAMILY_HX_STATUS (latest snapshot: alive/deceased per member)
  const tl = r.familyHistory;
  if (tl?.snapshots?.length) {
    const latestCSN = tl.snapshots[0].snapshotCSN;
    for (const s of tl.snapshots) {
      if (s.snapshotCSN !== latestCSN) continue;
      const d = s.data;
      const rel = d.FAM_STAT_REL_C_NAME ?? 'Unknown';
      if (!memberMap.has(rel)) {
        memberMap.set(rel, {
          relation: rel, status: str(d.FAM_STAT_STATUS_C_NAME),
          causeOfDeath: str(d.FAM_STAT_COD_C_NAME), conditions: [], _epic: epic(d),
        });
      }
    }
  }

  // Conditions from FAMILY_HX (latest snapshot: medical conditions per member)
  const fhRaw: any[] = r._raw?.family_hx ?? [];
  if (fhRaw.length > 0) {
    const byCSN = new Map<string, any[]>();
    for (const f of fhRaw) {
      const csn = String(f.PAT_ENC_CSN_ID ?? '');
      if (!byCSN.has(csn)) byCSN.set(csn, []);
      byCSN.get(csn)!.push(f);
    }
    let bestCSN = '', bestCount = 0;
    for (const [csn, rows] of byCSN) {
      if (rows.length > bestCount) { bestCSN = csn; bestCount = rows.length; }
    }
    for (const f of byCSN.get(bestCSN) ?? []) {
      const rel = f.RELATION_C_NAME ?? 'Unknown';
      if (!memberMap.has(rel)) {
        memberMap.set(rel, { relation: rel, status: null, causeOfDeath: null, conditions: [], _epic: {} });
      }
      memberMap.get(rel)!.conditions.push({
        name: f.MEDICAL_HX_C_NAME ?? f.MEDICAL_OTHER ?? 'Unknown',
        ageOfOnset: num(f.AGE_OF_ONSET), comment: str(f.COMMENTS), _epic: epic(f),
      });
    }
  }

  return [...memberMap.values()];
}

function projectMessage(m: any): Message {
  return {
    id: sid(m.MESSAGE_ID),
    date: toISODateTime(m.CREATED_TIME ?? m.CONTACT_DATE),
    from: str(m.FROM_USER_ID_NAME),
    to: str(m.TO_USER_ID_NAME),
    subject: str(m.SUBJECT), body: str(m.MESSAGE_TEXT),
    status: str(m.MSG_STATUS_C_NAME),
    threadId: str(m.THREAD_ID),
    _epic: epic(m),
  };
}

function projectBilling(r: R): BillingSummary {
  const txs = r.billing?.transactions ?? [];
  const charges: Charge[] = [];
  const payments: Payment[] = [];

  for (const tx of txs) {
    const t = str(tx.TX_TYPE_C_NAME) ?? str(tx.txType);
    if (t === 'Charge') {
      charges.push({
        id: sid(tx.TX_ID), date: toISODate(tx.SERVICE_DATE ?? tx.serviceDate),
        service: str(tx.PROC_NAME ?? tx.PROC_ID),
        amount: num(tx.AMOUNT ?? tx.amount),
        provider: str(tx.SERV_PROVIDER_ID_NAME),
        visitId: str(tx.VISIT_NUMBER),
        diagnosisCodes: (tx.chargeDiagnoses ?? []).map((d: any) => String(d.DX_ID ?? '')),
        _epic: epic(tx),
      });
    } else if (t === 'Payment' || t === 'Adjustment') {
      payments.push({
        id: sid(tx.TX_ID), date: toISODate(tx.POST_DATE ?? tx.postDate),
        amount: num(tx.AMOUNT ?? tx.amount), method: t,
        payer: str(tx.PAYOR_ID_NAME),
        relatedChargeId: str(tx.MATCH_CHARGE_TX_ID),
        _epic: epic(tx),
      });
    }
  }

  const claims = (r.billing?.claims ?? []).map((c: any): Claim => ({
    id: sid(c.RECORD_ID ?? c.CLAIM_ID ?? c.CLM_VALUES_ID),
    submitDate: toISODate(c.CREATE_DT ?? c.SUBMIT_DATE),
    status: str(c.CLAIM_STATUS_C_NAME ?? c.CLM_CVG_SEQ_CD),
    totalCharged: num(c.TTL_CHG_AMT ?? c.TOTAL_CHARGES),
    totalPaid: num(c.CLM_CVG_AMT_PAID ?? c.TOTAL_PAID),
    payer: str(c.CLM_CVG_PYR_NAM ?? c.PAYOR_ID_NAME),
    provider: str(c.REND_PROV_NAM_LAST ? 
      [c.REND_PROV_NAM_LAST, c.REND_PROV_NAM_FIRST].filter(Boolean).join(', ') : null),
    invoiceNumber: str(c.INV_NUM),
    _epic: epic(c),
  }));

  const accounts: BillingAccount[] = [
    ...(r.billing?.accounts ?? []).map((a: any): BillingAccount => ({
      id: sid(a.ACCOUNT_ID), type: 'Professional',
      name: str(a.ACCOUNT_NAME), accountClass: str(a.ACCT_FIN_CLASS_C_NAME),
      billingStatus: str(a.ACCT_BILLING_STATUS_C_NAME),
      totalCharges: num(a.TOTAL_CHARGES), totalPayments: num(a.TOTAL_PAYMENTS),
      balance: num(a.BALANCE), _epic: epic(a),
    })),
    ...(r.billing?.hospitalAccounts ?? []).map((h: any): BillingAccount => ({
      id: sid(h.HSP_ACCOUNT_ID), type: 'Hospital',
      name: str(h.HSP_ACCOUNT_NAME),
      accountClass: str(h.ACCT_CLASS_HA_C_NAME),
      billingStatus: str(h.ACCT_BILLSTS_HA_C_NAME),
      totalCharges: num(h.TOT_CHARGES ?? h.TTL_CHG_AMT),
      totalPayments: num(h.TOT_PAYMENTS),
      balance: num(h.ACCT_BALANCE),
      _epic: epic(h),
    })),
  ];

  return { charges, payments, claims, accounts };
}
