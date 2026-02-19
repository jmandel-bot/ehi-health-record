/**
 * Epic EHI Patient Record — Runtime Domain Model
 *
 * Loads the flat JSON produced by project.ts and hydrates it into a typed
 * object graph with index maps and cross-reference accessor methods.
 *
 * Usage:
 *   import { loadPatientRecord } from './PatientRecord';
 *   const record = loadPatientRecord(jsonData);
 *   const enc = record.encounters[0];
 *   const billing = enc.billingVisit(record);
 *   const labs = enc.orders[1].allResults(record);
 *   const socialHx = record.socialHistory.latest();
 */

// ─── Shared Types ──────────────────────────────────────────────────────────

/** Any Epic row stored as raw key-value pairs */
export type EpicRow = Record<string, unknown>;

// ─── Structural types for high-value child arrays ──────────────────────────
// These describe the *expected* shape of commonly-accessed EpicRow children.
// They extend EpicRow so existing code doesn't break — the known fields are
// just surfaced for type-checking and autocomplete.
//
// NOTE: These are transitional. The real column-access safety net is StrictRow
// (runtime Proxy validation against actual DB schema). These interfaces give
// autocomplete but can't catch typos that tsc doesn't see. See strict_row.ts.

/** A diagnosis row (encounter diagnoses, problem diagnoses, charge diagnoses) */
export interface EpicDiagnosisRow extends EpicRow {
  DX_ID?: EpicID;
  DX_NAME?: string;
  _dx_name?: string;           // enriched name from dx_id lookup
  PRIMARY_DX_YN?: string;      // 'Y' | 'N'
  CURRENT_ICD10_LIST?: string;
  LINE?: number;
}

/** An allergy reaction row */
export interface EpicReactionRow extends EpicRow {
  REACTION_NAME?: string;
  REACTION_C_NAME?: string;
  REACTION_TYPE_C_NAME?: string;
}

/** A note text line row */
export interface EpicNoteTextRow extends EpicRow {
  NOTE_TEXT?: string;
  LINE?: number;
  CONTACT_DATE_REAL?: number;
}

/** A medication row (medications are still EpicRow[] on PatientRecord) */
export interface EpicMedicationRow extends EpicRow {
  ORDER_MED_ID?: EpicID;
  AMB_MED_DISP_NAME?: string;
  DISPLAY_NAME?: string;
  DESCRIPTION?: string;
  HV_DISCRETE_DOSE?: string;
  HV_DOSE_UNIT_C_NAME?: string;
  MED_ROUTE_C_NAME?: string;
  HV_DISCR_FREQ_ID_FREQ_NAME?: string;
  SIG?: string;
  START_DATE?: string;
  END_DATE?: string;
  ORDER_STATUS_C_NAME?: string;
  ORD_CREATR_USER_ID_NAME?: string;
  PHARMACY_ID_PHARMACY_NAME?: string;
  associatedDiagnoses?: EpicDiagnosisRow[];
}

/** An Epic entity ID */
export type EpicID = string | number;

/** An encounter serial number */
export type CSN = number;

// ─── History Snapshots ─────────────────────────────────────────────────────

export interface HistorySnapshot<T> {
  snapshotCSN?: CSN;
  reviewedDuringEncounterCSN?: CSN;
  contactDate?: string;
  data: T;
}

export class HistoryTimeline<T> {
  constructor(public readonly snapshots: HistorySnapshot<T>[]) {}

  latest(): T | undefined {
    return this.snapshots.at(-1)?.data;
  }

  /**
   * Get the history snapshot associated with a given encounter CSN.
   * Checks both the history's own contact CSN (snapshotCSN) and
   * the clinical visit CSN it was reviewed during (reviewedDuringEncounterCSN).
   */
  asOfEncounter(csn: CSN): T | undefined {
    return this.snapshots.find(
      s => s.reviewedDuringEncounterCSN === csn || s.snapshotCSN === csn
    )?.data;
  }

  asOfDate(date: string): T | undefined {
    return [...this.snapshots].reverse().find(s => (s.contactDate ?? '') <= date)?.data;
  }

  get length(): number {
    return this.snapshots.length;
  }
}

// ─── Forward reference for PatientRecord (used in accessor methods) ────────

// We define the class at the bottom. Entity classes reference it by parameter type.
export type PatientRecordRef = PatientRecord;

// ─── Allergies ─────────────────────────────────────────────────────────────

export class Allergy {
  ALLERGY_ID: EpicID;
  allergenName?: string;
  reaction?: string;
  dateNoted?: string;
  severity?: string;
  status?: string;
  certainty?: string;
  source?: string;
  reactions: EpicReactionRow[] = [];
  notedDuringEncounterCSN?: CSN;

  constructor(raw: EpicRow) {
    Object.assign(this, raw);
    this.ALLERGY_ID = raw.ALLERGY_ID as EpicID;
    this.allergenName = raw.ALLERGEN_ID_ALLERGEN_NAME as string;
    this.severity = (raw.ALLERGY_SEVERITY_C_NAME ?? raw.SEVERITY_C_NAME) as string;
    this.status = raw.ALRGY_STATUS_C_NAME as string;
    this.certainty = raw.ALLERGY_CERTAINTY_C_NAME as string;
    this.source = raw.ALLERGY_SOURCE_C_NAME as string;
    this.reaction = raw.REACTION as string;
    this.dateNoted = raw.DATE_NOTED as string;
    this.notedDuringEncounterCSN = raw.ALLERGY_PAT_CSN as CSN;
    this.reactions = (raw.reactions as EpicReactionRow[]) ?? [];
  }

  notedDuringEncounter(record: PatientRecordRef): Encounter | undefined {
    return this.notedDuringEncounterCSN
      ? record.encounterByCSN(this.notedDuringEncounterCSN)
      : undefined;
  }
}

// ─── Problems ──────────────────────────────────────────────────────────────

export class Problem {
  PROBLEM_LIST_ID: EpicID;
  diagnosisName?: string;
  dateOfEntry?: string;
  status?: string;
  chronicYN?: string;
  updates: EpicRow[] = [];
  bodySystems: EpicRow[] = [];

  constructor(raw: EpicRow) {
    Object.assign(this, raw);
    this.PROBLEM_LIST_ID = raw.PROBLEM_LIST_ID as EpicID;
    this.diagnosisName = raw._dx_name as string;
    this.dateOfEntry = raw.DATE_OF_ENTRY as string;
    this.status = raw.PROBLEM_STATUS_C_NAME as string;
    this.chronicYN = raw.CHRONIC_YN as string;
    this.updates = (raw.updates as EpicRow[]) ?? [];
    this.bodySystems = (raw.body_systems as EpicRow[]) ?? [];
  }
}

// ─── Order Results ─────────────────────────────────────────────────────────

export class OrderResult {
  ORDER_PROC_ID: EpicID;
  COMPONENT_ID?: EpicID;
  LINE?: number;
  REFERENCE_LOW?: string;
  REFERENCE_HIGH?: string;
  RESULT_FLAG_C_NAME?: string;
  RESULT_DATE?: string;
  componentName?: string;
  value?: string;
  referenceUnit?: string;
  referenceRange?: string;
  resultStatus?: string;
  resultFlag?: string;
  resultDate?: string;

  constructor(raw: EpicRow) {
    Object.assign(this, raw);
    this.ORDER_PROC_ID = raw.ORDER_PROC_ID as EpicID;
    this.COMPONENT_ID = raw.COMPONENT_ID as EpicID;
    this.LINE = raw.LINE as number;
    this.REFERENCE_LOW = raw.REFERENCE_LOW as string;
    this.REFERENCE_HIGH = raw.REFERENCE_HIGH as string;
    this.RESULT_FLAG_C_NAME = raw.RESULT_FLAG_C_NAME as string;
    this.RESULT_DATE = raw.RESULT_DATE as string;
    this.componentName = raw.COMPONENT_ID_NAME as string;
    this.value = raw.ORD_VALUE as string;
    this.referenceUnit = raw.REFERENCE_UNIT as string;
    this.referenceRange = raw.REF_NORMAL_VALS as string;
    this.resultStatus = raw.RESULT_STATUS_C_NAME as string;
    this.resultFlag = raw.RESULT_FLAG_C_NAME as string;
    this.resultDate = raw.RESULT_DATE as string;
  }

  /** Is this result flagged as abnormal? */
  get isAbnormal(): boolean {
    const flag = this.resultFlag?.toUpperCase();
    return flag === 'H' || flag === 'L' || flag === 'A' || flag === 'HH' || flag === 'LL';
  }

  toString(): string {
    const flag = this.isAbnormal ? ` [${this.resultFlag}]` : '';
    return `${this.componentName}: ${this.value} ${this.referenceUnit ?? ''}${flag}`.trim();
  }
}

// ─── Orders ────────────────────────────────────────────────────────────────

export class Order {
  ORDER_PROC_ID: EpicID;
  description?: string;
  procedureName?: string;
  orderType?: string;
  orderStatus?: string;
  orderClass?: string;
  orderDate?: string;
  results: OrderResult[] = [];
  diagnoses: EpicDiagnosisRow[] = [];
  comments: EpicRow[] = [];
  narrative: EpicRow[] = [];
  statusHistory: EpicRow[] = [];

  constructor(raw: EpicRow) {
    Object.assign(this, raw);
    this.ORDER_PROC_ID = raw.ORDER_PROC_ID as EpicID;
    this.description = raw.DESCRIPTION as string;
    this.procedureName = raw._procedure_name as string;
    this.orderType = raw.ORDER_TYPE_C_NAME as string;
    this.orderStatus = raw.ORDER_STATUS_C_NAME as string;
    this.orderClass = raw.ORDER_CLASS_C_NAME as string;
    this.orderDate = raw.ORDER_INST as string;
    this.results = ((raw.results as EpicRow[]) ?? []).map(r => new OrderResult(r));
    this.diagnoses = (raw.diagnoses as EpicDiagnosisRow[]) ?? [];
    this.comments = (raw.comments as EpicRow[]) ?? [];
  }

  /**
   * All results, following the parent→child order chain.
   * Lab orders placed during office visits spawn child orders on a separate
   * lab encounter. This follows ORDER_PARENT_INFO to find those results.
   */
  allResults(record: PatientRecordRef): OrderResult[] {
    if (this.results.length > 0) return this.results;
    return record.orderParentLinks
      .filter(link => link.PARENT_ORDER_ID === this.ORDER_PROC_ID
        && link.ORDER_ID !== this.ORDER_PROC_ID)
      .flatMap(link => {
        const child = record.orderByID(link.ORDER_ID);
        return child?.results ?? [];
      });
  }

  /** Does this order have any results (direct or via child orders)? */
  hasResults(record: PatientRecordRef): boolean {
    return this.allResults(record).length > 0;
  }

  toString(): string {
    return `${this.description ?? this.procedureName ?? 'Order'} [${this.orderType}]`;
  }
}

// ─── Notes ─────────────────────────────────────────────────────────────────

export class Note {
  NOTE_ID: EpicID;
  noteType?: string;
  noteStatus?: string;
  authorName?: string;
  createdDate?: string;
  encounterCSN?: CSN;
  text: EpicNoteTextRow[] = [];
  metadata: EpicRow[] = [];
  encounterInfo: EpicRow[] = [];

  constructor(raw: EpicRow) {
    Object.assign(this, raw);
    this.NOTE_ID = raw.NOTE_ID as EpicID;
    this.noteType = raw.IP_NOTE_TYPE_C_NAME as string;
    this.noteStatus = raw.NOTE_STATUS_C_NAME as string;
    this.encounterCSN = raw.PAT_ENC_CSN_ID as CSN;
    this.text = (raw.text as EpicNoteTextRow[]) ?? [];
    this.metadata = (raw.metadata as EpicRow[]) ?? [];
  }

  encounter(record: PatientRecordRef): Encounter | undefined {
    return this.encounterCSN ? record.encounterByCSN(this.encounterCSN) : undefined;
  }

  /** Concatenated plain text content */
  get plainText(): string {
    return this.text
      .map(t => t.NOTE_TEXT as string)
      .filter(Boolean)
      .join('\n');
  }
}

// ─── Encounters ────────────────────────────────────────────────────────────

export class Encounter {
  PAT_ENC_CSN_ID: CSN;
  PAT_ID?: string;
  contactDate?: string;
  encounterType?: string;
  visitProviderName?: string;
  departmentName?: string;
  diagnoses: EpicDiagnosisRow[] = [];
  reasonsForVisit: EpicRow[] = [];
  orders: Order[] = [];
  notes: Note[] = [];
  treatments: EpicRow[] = [];
  treatmentTeam: EpicRow[] = [];
  currentMedsSnapshot: EpicRow[] = [];
  discontinuedMeds: EpicRow[] = [];
  addenda: EpicRow[] = [];
  attachedDocuments: EpicRow[] = [];
  questionnaires: EpicRow[] = [];
  appointment?: EpicRow;
  disposition?: EpicRow;
  inpatientData?: EpicRow;

  constructor(raw: EpicRow) {
    Object.assign(this, raw);
    this.PAT_ENC_CSN_ID = raw.PAT_ENC_CSN_ID as CSN;
    this.PAT_ID = raw.PAT_ID as string;
    this.contactDate = raw.CONTACT_DATE as string;
    this.encounterType = raw.ENC_TYPE_C_NAME as string; // audit:optional — not in every EHI export
    this.visitProviderName = raw._visit_provider as string;
    this.departmentName = (raw._department ?? raw.DEPARTMENT_NAME) as string;
    this.diagnoses = (raw.diagnoses as EpicDiagnosisRow[]) ?? [];
    this.reasonsForVisit = (raw.reasons_for_visit as EpicRow[]) ?? [];
    this.orders = ((raw.orders as EpicRow[]) ?? []).map(o => new Order(o));
    this.notes = ((raw.notes as EpicRow[]) ?? []).map(n => new Note(n));
    this.treatments = (raw.treatments as EpicRow[]) ?? [];
    this.treatmentTeam = (raw.treatment_team as EpicRow[]) ?? [];
    this.currentMedsSnapshot = (raw.current_meds_snapshot as EpicRow[]) ?? [];
    this.discontinuedMeds = (raw.discontinued_meds as EpicRow[]) ?? [];
    this.addenda = (raw.addenda as EpicRow[]) ?? [];
    this.attachedDocuments = (raw.attached_documents as EpicRow[]) ?? [];
    this.questionnaires = (raw.questionnaires as EpicRow[]) ?? [];
    this.appointment = raw.appointment as EpicRow;
    this.disposition = raw.disposition as EpicRow;
    this.inpatientData = raw.inpatient_data as EpicRow;
  }

  billingVisit(record: PatientRecordRef): BillingVisit | undefined {
    return record.billing.visits.find(v => v.PRIM_ENC_CSN_ID === this.PAT_ENC_CSN_ID);
  }

  /**
   * Social history reviewed during this encounter.
   *
   * Social history contacts have two CSNs: their own contact (PAT_ENC_CSN_ID)
   * and the clinical visit they were reviewed in (HX_LNK_ENC_CSN). This method
   * checks HX_LNK_ENC_CSN first (linking to the real visit) then falls back
   * to PAT_ENC_CSN_ID (if this IS the history contact itself).
   */
  socialHistory(record: PatientRecordRef) {
    return record.socialHistory.asOfEncounter(this.PAT_ENC_CSN_ID);
  }

  /**
   * All encounters that are linked to this visit as subsidiary contacts.
   * E.g., the social history review contact created alongside this clinical visit.
   */
  linkedContacts(record: PatientRecordRef): Encounter[] {
    // Find history contacts that link to this encounter
    return record.encounters.filter(e =>
      e.PAT_ENC_CSN_ID !== this.PAT_ENC_CSN_ID &&
      e.contactDate === this.contactDate &&
      (e as unknown as EpicRow).VISIT_PROV_ID === (this as unknown as EpicRow).VISIT_PROV_ID &&
      e.diagnoses.length === 0 && e.orders.length === 0 && e.reasonsForVisit.length === 0
    );
  }

  linkedMessages(record: PatientRecordRef): Message[] {
    const ids = record.encounterMessageLinks
      .filter(l => l.PAT_ENC_CSN_ID === this.PAT_ENC_CSN_ID)
      .map(l => l.MESSAGE_ID);
    return record.messages.filter(m => ids.includes(m.MESSAGE_ID));
  }

  /** Primary diagnosis for this encounter */
  get primaryDiagnosis(): EpicRow | undefined {
    return this.diagnoses.find(d => d.PRIMARY_DX_YN === 'Y');
  }

  /** All diagnosis names as strings */
  get diagnosisNames(): string[] {
    return this.diagnoses
      .map(d => (d._dx_name as string) ?? (d.DX_NAME as string))
      .filter(Boolean);
  }

  toString(): string {
    const parts = [this.contactDate?.substring(0, this.contactDate.indexOf(' ')) ?? 'unknown date'];
    if (this.visitProviderName) parts.push(this.visitProviderName);
    if (this.encounterType) parts.push(`(${this.encounterType})`);
    const dxNames = this.diagnosisNames;
    if (dxNames.length > 0) parts.push(`— ${dxNames[0]}${dxNames.length > 1 ? ` +${dxNames.length - 1}` : ''}`);
    return parts.join(' ');
  }

  /** Is this a clinical visit (has diagnoses, orders, reasons, or notes with text)? */
  get isClinicalVisit(): boolean {
    return this.diagnoses.length > 0 ||
      this.orders.length > 0 ||
      this.reasonsForVisit.length > 0 ||
      this.notes.some(n => n.text.length > 0);
  }
}

// ─── Billing entities ──────────────────────────────────────────────────────

export class BillingVisit {
  PRIM_ENC_CSN_ID?: CSN;
  totalCharges?: number;
  totalPayments?: number;
  totalAdjustments?: number;
  balance?: number;

  constructor(raw: EpicRow) {
    Object.assign(this, raw);
    this.PRIM_ENC_CSN_ID = raw.PRIM_ENC_CSN_ID as CSN;
    this.totalCharges = raw.PB_TOTAL_CHARGES as number;
    this.totalPayments = raw.PB_TOTAL_PAYMENTS as number;
    this.totalAdjustments = raw.PB_TOTAL_ADJ as number;
    this.balance = raw.PB_TOTAL_BALANCE as number;
  }

  encounter(record: PatientRecordRef): Encounter | undefined {
    return this.PRIM_ENC_CSN_ID ? record.encounterByCSN(this.PRIM_ENC_CSN_ID) : undefined;
  }

  transactions(record: PatientRecordRef): BillingTransaction[] {
    return record.billing.transactions.filter(
      tx => tx.VISIT_NUMBER === (this as EpicRow).PB_VISIT_ID
    );
  }
}

export class BillingTransaction {
  TX_ID: EpicID;
  txType?: string;
  amount?: number;
  postDate?: string;
  serviceDate?: string;
  ACCOUNT_ID?: EpicID;
  VISIT_NUMBER?: EpicID;
  actions: EpicRow[] = [];
  chargeDiagnoses: EpicDiagnosisRow[] = [];
  eobInfo: EpicRow[] = [];
  matchHistory: EpicRow[] = [];
  chargeRevisionHistory: EpicRow[] = [];
  statementClaimHistory: EpicRow[] = [];
  statementDates: EpicRow[] = [];
  voidInfo: EpicRow[] = [];
  eobInfoI: EpicRow[] = [];

  constructor(raw: EpicRow) {
    Object.assign(this, raw);
    this.TX_ID = raw.TX_ID as EpicID;
    this.txType = raw.TX_TYPE_C_NAME as string;
    this.amount = raw.AMOUNT as number;
    this.postDate = raw.POST_DATE as string;
    this.serviceDate = raw.SERVICE_DATE as string;
    this.ACCOUNT_ID = raw.ACCOUNT_ID as EpicID;
    this.VISIT_NUMBER = raw.VISIT_NUMBER as EpicID;
    for (const key of ['arpb_tx_actions', 'arpb_chg_entry_dx', 'tx_diag',
      'pmt_eob_info_i', 'pmt_eob_info_ii']) {
      const arr = raw[key] as EpicRow[] | undefined;
      if (arr?.length) {
        if (key.includes('action')) this.actions = arr;
        else if (key.includes('dx') || key.includes('diag')) this.chargeDiagnoses.push(...arr);
        else if (key.includes('eob')) this.eobInfo.push(...arr);
      }
    }
    this.matchHistory = (raw.match_history as EpicRow[]) ?? [];
    this.chargeRevisionHistory = (raw.charge_revision_history as EpicRow[]) ?? [];
    this.statementClaimHistory = (raw.statement_claim_history as EpicRow[]) ?? [];
    this.statementDates = (raw.statement_dates as EpicRow[]) ?? [];
    this.voidInfo = (raw.void_info as EpicRow[]) ?? [];
    this.eobInfoI = (raw.eob_info_i as EpicRow[]) ?? [];
  }
}

// ─── Hospital Account (HSP_ACCOUNT) ────────────────────────────────────────

export class HospitalAccount {
  HSP_ACCOUNT_ID: EpicID;
  accountName?: string;
  accountClass?: string;
  financialClass?: string;
  billingStatus?: string;
  admissionDateTime?: string;
  dischargeDateTime?: string;
  totalCharges?: number;
  totalAdjustments?: number;
  totalInsurancePayments?: number;
  totalSelfPayPayments?: number;
  primaryPayorId?: string;
  primaryPlanId?: string;
  codingStatus?: string;
  firstBilledDate?: string;
  baseInvoiceNumber?: string;
  serviceAreaId?: EpicID;

  // Child arrays
  billingDrg: EpicRow[] = [];
  claims: EpicRow[] = [];
  splitBilling: EpicRow[] = [];
  bucketAdditionalRecords: EpicRow[] = [];

  constructor(raw: EpicRow) {
    Object.assign(this, raw);
    this.HSP_ACCOUNT_ID = raw.HSP_ACCOUNT_ID as EpicID;
    this.accountName = raw.HSP_ACCOUNT_NAME as string;
    this.accountClass = raw.ACCT_CLASS_HA_C_NAME as string;
    this.financialClass = raw.ACCT_FIN_CLASS_C_NAME as string;
    this.billingStatus = raw.ACCT_BILLSTS_HA_C_NAME as string;
    this.admissionDateTime = raw.ADM_DATE_TIME as string;
    this.dischargeDateTime = raw.DISCH_DATE_TIME as string;
    this.totalCharges = raw.TOT_CHGS as number;
    this.totalAdjustments = raw.TOT_ADJ as number;
    this.totalInsurancePayments = raw.TOT_INS_PMT as number;
    this.totalSelfPayPayments = raw.TOT_SP_PMT as number;
    this.primaryPayorId = raw.PRIMARY_PAYOR_ID as string;
    this.primaryPlanId = raw.PRIMARY_PLAN_ID as string;
    this.codingStatus = raw.CODING_STATUS_C_NAME as string;
    this.firstBilledDate = raw.FIRST_BILLED_DATE as string;
    this.baseInvoiceNumber = raw.BASE_INV_NUM as string;
    this.serviceAreaId = raw.SERV_AREA_ID as EpicID;

    this.billingDrg = (raw.billing_drg as EpicRow[]) ?? [];
    this.claims = (raw.claims as EpicRow[]) ?? [];
    this.splitBilling = (raw.split_billing as EpicRow[]) ?? [];
    this.bucketAdditionalRecords = (raw.bucket_additional_records as EpicRow[]) ?? [];
  }

  /** Find encounters linked to this hospital account via encounter HAR references */
  encounters(record: PatientRecordRef): Encounter[] {
    const harId = this.HSP_ACCOUNT_ID;
    return record.encounters.filter(e => {
      const har = (e as unknown as EpicRow).HSP_ACCOUNT_ID;
      return har === harId || String(har) === String(harId);
    });
  }
}

// ─── Guarantor Account (ACCOUNT) ───────────────────────────────────────────

export class GuarantorAccount {
  ACCOUNT_ID: EpicID;
  accountName?: string;
  accountType?: string;
  financialClass?: string;
  billingStatus?: string;
  isActive?: string;
  totalBalance?: number;
  insuranceBalance?: number;
  patientBalance?: number;
  hbBalance?: number;
  hbInsuranceBalance?: number;
  hbSelfPayBalance?: number;
  hbBadDebtBalance?: number;
  hbUndistributedBalance?: number;
  lastInsPaymentDate?: string;
  lastSelfPayPaymentDate?: string;
  lastPatPaymentAmount?: number;
  serviceAreaId?: EpicID;

  // Child arrays
  coverageLinks: EpicRow[] = [];
  addresses: EpicRow[] = [];
  creationInfo: EpicRow[] = [];
  addressHistory: EpicRow[] = [];
  phoneHistory: EpicRow[] = [];

  constructor(raw: EpicRow) {
    Object.assign(this, raw);
    this.ACCOUNT_ID = raw.ACCOUNT_ID as EpicID;
    this.accountName = raw.ACCOUNT_NAME as string;
    this.accountType = raw.ACCOUNT_TYPE_C_NAME as string;
    this.financialClass = raw.FIN_CLASS_C_NAME as string;
    this.billingStatus = raw.BILLING_STATUS_C_NAME as string;
    this.isActive = raw.IS_ACTIVE as string;
    this.totalBalance = raw.TOTAL_BALANCE as number;
    this.insuranceBalance = raw.INSURANCE_BALANCE as number;
    this.patientBalance = raw.PATIENT_BALANCE as number;
    this.hbBalance = raw.HB_BALANCE as number;
    this.hbInsuranceBalance = raw.HB_INSURANCE_BALAN as number;
    this.hbSelfPayBalance = raw.HB_SELFPAY_BALANCE as number;
    this.hbBadDebtBalance = raw.HB_BADDEBT_BALANCE as number;
    this.hbUndistributedBalance = raw.HB_UNDISTRIB_BAL as number;
    this.lastInsPaymentDate = raw.HB_LAST_INS_PMT_DT as string;
    this.lastSelfPayPaymentDate = raw.HB_LAST_SP_PMT_DT as string;
    this.lastPatPaymentAmount = raw.LAST_PAT_PMT_AMT as number;
    this.serviceAreaId = raw.SERV_AREA_ID as EpicID;

    this.coverageLinks = (raw.coverage_links as EpicRow[]) ?? [];
    this.addresses = (raw.addresses as EpicRow[]) ?? [];
    this.creationInfo = (raw.creation_info as EpicRow[]) ?? [];
    this.addressHistory = (raw.address_history as EpicRow[]) ?? [];
    this.phoneHistory = (raw.phone_history as EpicRow[]) ?? [];
  }
}

// ─── Claim Reconciliation (RECONCILE_CLAIM) ───────────────────────────────

export class ClaimReconciliation {
  CLAIM_REC_ID: EpicID;
  CLAIM_INVOICE_NUM?: string;
  CUR_EPIC_STATUS_C_NAME?: string;
  EPIC_CLM_STS_C_NAME?: string;
  TOTAL_BILLED?: number;
  PAYOR_ID?: EpicID;
  DEPARTMENT_ID?: EpicID;
  LOC_ID?: EpicID;
  SERVICE_AREA_ID?: EpicID;
  RECORD_TYPE_C_NAME?: string;
  CLAIM_CLOSED_DATE?: string;

  // Child arrays
  statusTimeline: EpicRow[] = [];
  statusDetail: EpicRow[] = [];

  constructor(raw: EpicRow) {
    Object.assign(this, raw);
    this.CLAIM_REC_ID = raw.CLAIM_REC_ID as EpicID;
    this.CLAIM_INVOICE_NUM = raw.CLAIM_INVOICE_NUM as string;
    this.CUR_EPIC_STATUS_C_NAME = raw.CUR_EPIC_STATUS_C_NAME as string;
    this.EPIC_CLM_STS_C_NAME = raw.EPIC_CLM_STS_C_NAME as string;
    this.TOTAL_BILLED = raw.TOTAL_BILLED as number;
    this.PAYOR_ID = raw.PAYOR_ID as EpicID;
    this.DEPARTMENT_ID = raw.DEPARTMENT_ID as EpicID;
    this.LOC_ID = raw.LOC_ID as EpicID;
    this.SERVICE_AREA_ID = raw.SERVICE_AREA_ID as EpicID;
    this.RECORD_TYPE_C_NAME = raw.RECORD_TYPE_C_NAME as string;
    this.CLAIM_CLOSED_DATE = raw.CLAIM_CLOSED_DATE as string;
    this.statusTimeline = (raw.status_timeline as EpicRow[]) ?? [];
    this.statusDetail = (raw.status_detail as EpicRow[]) ?? [];
  }

  /** Find the matching BillingClaim by invoice number */
  matchingClaim(record: PatientRecordRef): BillingClaim | undefined {
    if (!this.CLAIM_INVOICE_NUM) return undefined;
    return record.billing.claims.find(c => c.invoiceNumber === this.CLAIM_INVOICE_NUM);
  }
}

// ─── Service Benefit (CVG_SVC_BENEFITS) ────────────────────────────────────

export class ServiceBenefit {
  serviceTypeName?: string;
  copayAmount?: number;
  deductibleAmount?: number;
  deductibleMetAmount?: number;
  coinsPercent?: number;
  outOfPocketMax?: number;
  outOfPocketRemaining?: number;
  inNetworkYN?: string;

  constructor(raw: EpicRow) {
    Object.assign(this, raw);
    this.serviceTypeName = raw.CVG_SVC_TYPE_ID_SERVICE_TYPE_NAME as string;
    this.copayAmount = raw.COPAY_AMOUNT as number;
    this.deductibleAmount = raw.DEDUCTIBLE_AMOUNT as number;
    this.deductibleMetAmount = raw.DEDUCTIBLE_MET_AMT as number;
    this.coinsPercent = raw.COINS_PERCENT as number;
    this.outOfPocketMax = raw.OUT_OF_POCKET_MAX as number;
    this.outOfPocketRemaining = raw.OUT_OF_PCKT_REMAIN as number;
    this.inNetworkYN = raw.IN_NETWORK_YN as string;
  }
}

// ─── Billing Claim (CLM_VALUES) ────────────────────────────────────────────

export class BillingClaim {
  RECORD_ID: EpicID;
  invoiceNumber?: string;
  totalChargeAmount?: number;
  createDate?: string;
  claimCoverageAmountPaid?: number;
  claimCoverageSequence?: string;
  claimCoveragePayerName?: string;
  claimCoveragePayerId?: string;
  claimCoverageFilingIndicator?: string;
  claimCoverageGroupNumber?: string;
  billingType?: string;

  // Provider info
  billingProviderName?: string;
  billingProviderNPI?: string;
  billingProviderTaxonomy?: string;
  billingProviderTaxId?: string;
  renderingProviderName?: string;
  renderingProviderNPI?: string;
  referringProviderName?: string;
  referringProviderNPI?: string;
  serviceFacilityName?: string;

  // Child arrays
  serviceLines: EpicRow[] = [];
  diagnoses: EpicDiagnosisRow[] = [];
  notes: EpicRow[] = [];
  valueRecords: EpicRow[] = [];

  constructor(raw: EpicRow) {
    Object.assign(this, raw);
    this.RECORD_ID = raw.RECORD_ID as EpicID;
    this.invoiceNumber = raw.INV_NUM as string;
    this.totalChargeAmount = raw.TTL_CHG_AMT as number;
    this.createDate = raw.CREATE_DT as string;
    this.claimCoverageAmountPaid = raw.CLM_CVG_AMT_PAID as number;
    this.claimCoverageSequence = raw.CLM_CVG_SEQ_CD as string;
    this.claimCoveragePayerName = raw.CLM_CVG_PYR_NAM as string;
    this.claimCoveragePayerId = raw.CLM_CVG_PYR_ID as string;
    this.claimCoverageFilingIndicator = raw.CLM_CVG_FILING_IND as string;
    this.claimCoverageGroupNumber = raw.CLM_CVG_GRP_NUM as string;

    const facCode = raw.BILL_TYP_FAC_CD as string;
    const freqCode = raw.BILL_TYP_FREQ_CD as string;
    this.billingType = (facCode || freqCode)
      ? [facCode, freqCode].filter(Boolean).join('') : undefined;

    // Provider info
    this.billingProviderName = raw.BIL_PROV_NAM_LAST
      ? [raw.BIL_PROV_NAM_LAST, raw.BIL_PROV_NAM_FIRST].filter(Boolean).join(', ') as string
      : undefined;
    this.billingProviderNPI = raw.BIL_PROV_NPI as string;
    this.billingProviderTaxonomy = raw.BIL_PROV_TAXONOMY as string;
    this.billingProviderTaxId = raw.BIL_PROV_TAXID as string;
    this.renderingProviderName = raw.REND_PROV_NAM_LAST
      ? [raw.REND_PROV_NAM_LAST, raw.REND_PROV_NAM_FIRST].filter(Boolean).join(', ') as string
      : undefined;
    this.renderingProviderNPI = raw.REND_PROV_NPI as string;
    this.referringProviderName = raw.REF_PROV_NAM_LAST
      ? [raw.REF_PROV_NAM_LAST, raw.REF_PROV_NAM_FIRST].filter(Boolean).join(', ') as string
      : undefined;
    this.referringProviderNPI = raw.REF_PROV_NPI as string;
    this.serviceFacilityName = raw.SVC_FAC_NAM as string;

    this.serviceLines = (raw.service_lines as EpicRow[]) ?? [];
    this.diagnoses = (raw.diagnoses as EpicDiagnosisRow[]) ?? [];
    this.notes = (raw.notes as EpicRow[]) ?? [];
    this.valueRecords = (raw.value_records as EpicRow[]) ?? [];
  }
}

// ─── Remittance (CL_REMIT) ────────────────────────────────────────────────

export class Remittance {
  IMAGE_ID: EpicID;
  creationDate?: string;
  paymentAmount?: number;
  paymentMethod?: string;
  paymentType?: string;
  creditDebit?: string;
  senderIdNumber?: string;
  issueDate?: string;
  patientId?: string;
  claimStartDate?: string;
  claimEndDate?: string;
  imdType?: string;

  // Child arrays
  serviceLines: EpicRow[] = [];
  claimInfo: EpicRow[] = [];
  claimEntities: EpicRow[] = [];
  providerSummary: EpicRow[] = [];
  providerSupplemental: EpicRow[] = [];
  inpatientAdjustments: EpicRow[] = [];
  outpatientAdjustments: EpicRow[] = [];
  serviceLevelAdjustments: EpicRow[] = [];
  serviceLevelRefs: EpicRow[] = [];
  serviceAmounts: EpicRow[] = [];
  serviceDates: EpicRow[] = [];
  deliveryMethods: EpicRow[] = [];
  claimDateInfo: EpicRow[] = [];

  constructor(raw: EpicRow) {
    Object.assign(this, raw);
    this.IMAGE_ID = raw.IMAGE_ID as EpicID;
    this.creationDate = raw.CREATION_DATE as string;
    this.paymentAmount = raw.PAYMENT_AMOUNT as number;
    this.paymentMethod = raw.PAYMENT_METHOD_C_NAME as string;
    this.paymentType = raw.PAYMENT_TYPE_C_NAME as string;
    this.creditDebit = raw.CREDIT_DEBIT_C_NAME as string;
    this.senderIdNumber = raw.SENDER_IDN_NUM as string;
    this.issueDate = raw.ISSUE_DATE as string;
    this.patientId = raw.PAT_ID as string;
    this.claimStartDate = raw.CLM_START_DATE as string;
    this.claimEndDate = raw.CLM_END_DATE as string;
    this.imdType = raw.IMD_TYPE_C_NAME as string;

    this.serviceLines = (raw.service_lines as EpicRow[]) ?? [];
    this.claimInfo = (raw.claim_info as EpicRow[]) ?? [];
    this.claimEntities = (raw.claim_entities as EpicRow[]) ?? [];
    this.providerSummary = (raw.provider_summary as EpicRow[]) ?? [];
    this.providerSupplemental = (raw.provider_supplemental as EpicRow[]) ?? [];
    this.inpatientAdjustments = (raw.inpatient_adjustments as EpicRow[]) ?? [];
    this.outpatientAdjustments = (raw.outpatient_adjustments as EpicRow[]) ?? [];
    this.serviceLevelAdjustments = (raw.service_level_adjustments as EpicRow[]) ?? [];
    this.serviceLevelRefs = (raw.service_level_refs as EpicRow[]) ?? [];
    this.serviceAmounts = (raw.service_amounts as EpicRow[]) ?? [];
    this.serviceDates = (raw.service_dates as EpicRow[]) ?? [];
    this.deliveryMethods = (raw.delivery_methods as EpicRow[]) ?? [];
    this.claimDateInfo = (raw.claim_date_info as EpicRow[]) ?? [];
  }

  /** Find billing transactions referenced by this remittance's service lines via SVC_LINE_CHG_PB_ID */
  matchedTransactions(record: PatientRecordRef): BillingTransaction[] {
    const txIds = new Set(
      this.serviceLines
        .map(sl => sl.SVC_LINE_CHG_PB_ID as EpicID)
        .filter(Boolean)
        .map(String)
    );
    return record.billing.transactions.filter(tx => txIds.has(String(tx.TX_ID)));
  }
}

// ─── Invoice (INVOICE) ─────────────────────────────────────────────────────

export class Invoice {
  INVOICE_ID: EpicID;
  patientId?: string;
  accountId?: EpicID;
  serviceAreaId?: EpicID;
  locationId?: EpicID;
  departmentId?: EpicID;
  providerId?: string;
  taxId?: string;
  insuranceAmount?: number;
  selfPayAmount?: number;
  initialInsuranceBalance?: number;
  initialSelfPayBalance?: number;
  billAreaId?: EpicID;
  billAreaName?: string;
  hospitalAccountId?: EpicID;

  // Child arrays
  basicInfo: EpicRow[] = [];
  txPieces: EpicRow[] = [];
  numTxPieces: EpicRow[] = [];
  claimLineAdditional: EpicRow[] = [];
  diagnoses: EpicDiagnosisRow[] = [];
  paymentRecoup: EpicRow[] = [];

  constructor(raw: EpicRow) {
    Object.assign(this, raw);
    this.INVOICE_ID = raw.INVOICE_ID as EpicID;
    this.patientId = raw.PAT_ID as string;
    this.accountId = raw.ACCOUNT_ID as EpicID;
    this.serviceAreaId = raw.SERV_AREA_ID as EpicID;
    this.locationId = raw.LOC_ID as EpicID;
    this.departmentId = raw.DEPARTMENT_ID as EpicID;
    this.providerId = raw.PROV_ID as string;
    this.taxId = raw.TAX_ID as string;
    this.insuranceAmount = raw.INSURANCE_AMT as number;
    this.selfPayAmount = raw.SELF_PAY_AMT as number;
    this.initialInsuranceBalance = raw.INIT_INSURANCE_BAL as number;
    this.initialSelfPayBalance = raw.INIT_SELF_PAY_BAL as number;
    this.billAreaId = raw.BILL_AREA_ID as EpicID;
    this.billAreaName = raw.BILL_AREA_ID_BILL_AREA_NAME as string;
    this.hospitalAccountId = raw.PB_HOSP_ACT_ID as EpicID;

    this.basicInfo = (raw.basic_info as EpicRow[]) ?? [];
    this.txPieces = (raw.tx_pieces as EpicRow[]) ?? [];
    this.numTxPieces = (raw.num_tx_pieces as EpicRow[]) ?? [];
    this.claimLineAdditional = (raw.claim_line_addl as EpicRow[]) ?? [];
    this.diagnoses = (raw.diagnoses as EpicDiagnosisRow[]) ?? [];
    this.paymentRecoup = (raw.payment_recoup as EpicRow[]) ?? [];
  }
}

// ─── Cross-reference accessors on existing billing classes ─────────────────
// (Augmented after class definitions to avoid forward-reference issues)

// BillingTransaction: find remittance service lines referencing this TX_ID
const _btRemittanceLines = function(this: BillingTransaction, record: PatientRecordRef): EpicRow[] {
  const txId = String(this.TX_ID);
  const lines: EpicRow[] = [];
  for (const rem of record.billing.remittances) {
    for (const sl of rem.serviceLines) {
      if (String(sl.SVC_LINE_CHG_PB_ID) === txId) {
        lines.push(sl);
      }
    }
  }
  return lines;
};
BillingTransaction.prototype.remittanceLines = _btRemittanceLines;

// BillingTransaction: find claim by matching invoice number
const _btClaim = function(this: BillingTransaction, record: PatientRecordRef): BillingClaim | undefined {
  // TX rows have IPP_INV_NUMBER which matches CLM_VALUES.INV_NUM
  const txInvNum = (this as EpicRow).IPP_INV_NUMBER as string;
  if (txInvNum) {
    const claim = record.billing.claims.find(c => c.invoiceNumber === txInvNum);
    if (claim) return claim;
  }
  // Fallback: look up via Invoice.txPieces → Invoice.basicInfo.INV_NUM → Claim.INV_NUM
  const txId = String(this.TX_ID);
  for (const inv of record.billing.invoices) {
    const hasTx = inv.txPieces.some(p => String(p.TX_ID) === txId);
    if (hasTx) {
      for (const info of inv.basicInfo) {
        const invNum = info.INV_NUM as string;
        if (invNum) {
          const claim = record.billing.claims.find(c => c.invoiceNumber === invNum);
          if (claim) return claim;
        }
      }
    }
  }
  return undefined;
};
BillingTransaction.prototype.claim = _btClaim;

// Augment the BillingTransaction type to include the new methods
declare module './PatientRecord' {
  interface BillingTransaction {
    remittanceLines(record: PatientRecordRef): EpicRow[];
    claim(record: PatientRecordRef): BillingClaim | undefined;
  }
}

export class Message {
  MESSAGE_ID: EpicID;
  messageType?: string;
  senderName?: string;
  createdDate?: string;
  text: EpicRow[] = [];
  rtf_text: EpicRow[] = [];
  extracted_text?: string;
  threadId?: EpicID;

  constructor(raw: EpicRow) {
    Object.assign(this, raw);
    this.MESSAGE_ID = raw.MESSAGE_ID as EpicID;
    this.messageType = raw.MSG_TYPE_C_NAME as string; // audit:optional — not in every EHI export
    this.text = (raw.text as EpicRow[]) ?? [];
    this.rtf_text = (raw.rtf_text as EpicRow[]) ?? [];
    if (typeof raw.extracted_text === 'string') this.extracted_text = raw.extracted_text;
  }

  linkedEncounters(record: PatientRecordRef): Encounter[] {
    return record.encounterMessageLinks
      .filter(l => l.MESSAGE_ID === this.MESSAGE_ID)
      .map(l => record.encounterByCSN(l.PAT_ENC_CSN_ID))
      .filter((e): e is Encounter => e !== undefined);
  }

  /** Concatenated plain text — falls back to extracted RTF text if no MSG_TXT rows */
  get plainText(): string {
    const txt = this.text.map(t => t.MSG_TXT as string).filter(Boolean).join('\n');
    if (txt) return txt;
    return this.extracted_text ?? '';
  }
}

// ─── Billing aggregate ─────────────────────────────────────────────────────

export interface BillingRecord {
  transactions: BillingTransaction[];
  visits: BillingVisit[];
  hospitalAccounts: HospitalAccount[];
  guarantorAccounts: GuarantorAccount[];
  claims: BillingClaim[];
  remittances: Remittance[];
  invoices: Invoice[];
  reconciliations: ClaimReconciliation[];
}

// ─── Patient Record ────────────────────────────────────────────────────────

export class PatientRecord {
  patient: EpicRow;
  allergies: Allergy[];
  problems: Problem[];
  medications: EpicMedicationRow[];
  immunizations: EpicRow[];
  coverage: EpicRow[];
  referrals: EpicRow[];
  documents: EpicRow[];
  episodes: EpicRow[];
  socialHistory: HistoryTimeline<EpicRow>;
  surgicalHistory: HistoryTimeline<EpicRow>;
  familyHistory: HistoryTimeline<EpicRow>;

  /** Raw projection data for fields not yet promoted to typed accessors */
  _raw: Record<string, unknown>;
  encounters: Encounter[];
  billing: BillingRecord;
  messages: Message[];

  encounterMessageLinks: Array<{ PAT_ENC_CSN_ID: CSN; MESSAGE_ID: EpicID }>;
  orderParentLinks: Array<{ ORDER_ID: EpicID; PARENT_ORDER_ID: EpicID; PAT_ENC_CSN_ID?: CSN }>;

  // Index maps
  private _encountersByCSN: Map<CSN, Encounter>;
  private _ordersByID: Map<EpicID, Order>;

  constructor(json: EpicRow) {
    // Patient demographics: everything that isn't a known collection key
    const collectionKeys = new Set([
      'allergies', 'problems', 'medications', 'immunizations', 'coverage',
      'referrals', 'documents', 'episodes',
      'social_history', 'surgical_history', 'family_history',
      'encounters', 'billing', 'messages',
    ]);
    this.patient = {};
    for (const [k, v] of Object.entries(json)) {
      if (!collectionKeys.has(k)) this.patient[k] = v;
    }

    // Hydrate typed collections
    this.allergies = ((json.allergies as EpicRow[]) ?? []).map(r => new Allergy(r));
    this.problems = ((json.problems as EpicRow[]) ?? []).map(r => new Problem(r));
    this.medications = (json.medications as EpicMedicationRow[]) ?? [];
    this.immunizations = (json.immunizations as EpicRow[]) ?? [];
    this.coverage = ((json.coverage as EpicRow[]) ?? []).map(c => {
      if (Array.isArray(c.service_benefits)) {
        c.service_benefits = (c.service_benefits as EpicRow[]).map(sb => new ServiceBenefit(sb));
      }
      return c;
    });
    this.referrals = (json.referrals as EpicRow[]) ?? [];
    this.documents = (json.documents as EpicRow[]) ?? [];
    this.episodes = (json.episodes as EpicRow[]) ?? [];

    // History timelines
    this.socialHistory = buildTimeline((json.social_history as EpicRow[]) ?? []);
    this.surgicalHistory = buildTimeline((json.surgical_history as EpicRow[]) ?? []);
    this.familyHistory = buildTimeline((json.family_history as EpicRow[]) ?? []);

    // Preserve raw projection data for the clean HealthRecord projection
    this._raw = {
      family_hx: json.family_hx ?? [],
    };

    // Encounters
    this.encounters = ((json.encounters as EpicRow[]) ?? []).map(e => new Encounter(e));

    // Billing
    const billing = (json.billing as EpicRow) ?? {};
    this.billing = {
      transactions: ((billing.transactions as EpicRow[]) ?? []).map(t => new BillingTransaction(t)),
      visits: ((billing.visits as EpicRow[]) ?? []).map(v => new BillingVisit(v)),
      hospitalAccounts: ((billing.hospital_accounts as EpicRow[]) ?? []).map(h => new HospitalAccount(h)),
      guarantorAccounts: ((billing.guarantor_accounts as EpicRow[]) ?? []).map(g => new GuarantorAccount(g)),
      claims: ((billing.claims as EpicRow[]) ?? []).map(c => new BillingClaim(c)),
      remittances: ((billing.remittances as EpicRow[]) ?? []).map(r => new Remittance(r)),
      invoices: ((billing.invoices as EpicRow[]) ?? []).map(i => new Invoice(i)),
      reconciliations: ((billing.reconciliations as EpicRow[]) ?? []).map(r => new ClaimReconciliation(r)),
    };

    // Messages
    this.messages = ((json.messages as EpicRow[]) ?? []).map(m => new Message(m));

    // Bridge tables (extracted from encounter _billing_visit and mychart_message_links)
    this.encounterMessageLinks = this.encounters.flatMap(e =>
      ((e as unknown as EpicRow).mychart_message_links as EpicRow[] ?? []).map(l => ({
        PAT_ENC_CSN_ID: e.PAT_ENC_CSN_ID,
        MESSAGE_ID: l.MESSAGE_ID as EpicID,
      }))
    );

    // Order parent links (collected from all orders)
    this.orderParentLinks = [];

    // Build indexes
    this._encountersByCSN = new Map(this.encounters.map(e => [e.PAT_ENC_CSN_ID, e]));
    this._ordersByID = new Map(
      this.encounters.flatMap(e => e.orders.map(o => [o.ORDER_PROC_ID, o]))
    );
  }

  encounterByCSN(csn: CSN): Encounter | undefined {
    return this._encountersByCSN.get(csn);
  }

  orderByID(id: EpicID): Order | undefined {
    return this._ordersByID.get(id);
  }

  /** All encounters sorted by date */
  encountersChronological(): Encounter[] {
    return [...this.encounters].sort(
      (a, b) => (a.contactDate ?? '').localeCompare(b.contactDate ?? '')
    );
  }

  /**
   * Clinical visits only — filters out system-generated contacts.
   *
   * Epic's PAT_ENC contains ALL contacts: clinical visits, history review
   * contacts, monthly health-maintenance contacts, MyChart messages, etc.
   * This method returns only the ones with clinical content (diagnoses,
   * orders, reasons for visit, or notes with text), sorted chronologically.
   *
   * If you want raw unfiltered contacts, use .encounters directly.
   */
  visits(): Encounter[] {
    return this.encountersChronological().filter(e =>
      e.diagnoses.length > 0 ||
      e.orders.length > 0 ||
      e.reasonsForVisit.length > 0 ||
      e.notes.some(n => n.text.length > 0)
    );
  }

  activeProblems(): Problem[] {
    return this.problems.filter(p => p.status !== 'Deleted' && p.status !== 'Resolved');
  }

  /** Quick summary of the patient record */
  summary(): string {
    const v = this.visits();
    const lines = [
      `Patient: ${this.patient.PAT_NAME} (${this.patient.PAT_MRN_ID})`,
      `Allergies: ${this.allergies.length}`,
      `Problems: ${this.problems.length} (${this.activeProblems().length} active)`,
      `Medications: ${this.medications.length}`,
      `Immunizations: ${this.immunizations.length}`,
      `Visits: ${v.length} clinical visits (${this.encounters.length} total contacts)`,
      `Messages: ${this.messages.length}`,
      `Billing transactions: ${this.billing.transactions.length}`,
    ];
    return lines.join('\n');
  }
}

// ─── Helpers ───────────────────────────────────────────────────────────────

function buildTimeline(rows: EpicRow[]): HistoryTimeline<EpicRow> {
  const snapshots: HistorySnapshot<EpicRow>[] = rows.map(row => ({
    snapshotCSN: row.PAT_ENC_CSN_ID as CSN,
    reviewedDuringEncounterCSN: row.HX_LNK_ENC_CSN as CSN,
    contactDate: row.CONTACT_DATE as string,
    data: row,
  }));
  return new HistoryTimeline(snapshots);
}

// ─── Load function ─────────────────────────────────────────────────────────

/**
 * Load a patient record from the JSON produced by project.ts.
 *
 * Usage:
 *   const json = await fetch('/patient_document.json').then(r => r.json());
 *   const record = loadPatientRecord(json);
 */
export function loadPatientRecord(json: EpicRow): PatientRecord {
  return new PatientRecord(json);
}
