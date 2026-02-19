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
  coverage: InsuranceCoverage[];
  referrals: Referral[];
  documents: ClinicalDocument[];
  episodes: Episode[];
  goals: PatientGoal[];
  questionnaireResponses: QuestionnaireResponse[];
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
  genderIdentity: string | null;
  sexAssignedAtBirth: string | null;
  preferredName: string | null;
  employer: string | null;
  contactMethods: ContactMethod[];
  emergencyContacts: EmergencyContact[];
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
  quantity: string | null;              // "90 capsule" — dispensed quantity
  refills: number | null;               // number of refills authorized
  refillsRemaining: number | null;      // refills still available
  dispenseAsWritten: boolean | null;     // brand-only dispensing flag
  orderClass: string | null;            // "Normal", "Controlled Substance"
  orderingMode: string | null;          // "Outpatient", "Inpatient"
  priority: string | null;              // "Routine", "Stat"
  discontinuedDate: ISODateTime;        // when discontinued
  discontinuedReason: string | null;    // why discontinued
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
  product: string | null;             // "Fluarix Quadrivalent" — brand/product name
  ndcCode: string | null;             // "58160-909-52" — National Drug Code
  expirationDate: ISODate;            // vaccine lot expiration
  givenBy: string | null;             // provider who administered (vs. who entered)
  source: string | null;              // "Confirmed", "MyChart Entered" — data source/verification
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
  admissionType: string | null;          // HOSP_ADMSN_TYPE_C_NAME — "Elective"
  admissionTime: ISODateTime;            // HOSP_ADMSN_TIME
  dischargeTime: ISODateTime;            // HOSP_DISCHRG_TIME
  encStatus: string | null;              // CALCULATED_ENC_STAT_C_NAME — "Complete" (vs appt status)
  copayDue: number | null;               // COPAY_DUE
  bmi: number | null;                    // BMI — body mass index at visit
  bsa: number | null;                    // BSA — body surface area at visit
  referralSource: string | null;         // REFERRAL_SOURCE_ID_REFERRING_PROV_NAM
  checkedInBy: string | null;            // CHECKIN_USER_ID_NAME
  closedDate: ISODate;                   // ENC_CLOSE_DATE
  closedBy: string | null;               // ENC_CLOSED_USER_ID_NAME
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
  orderClass: string | null;          // "Lab Collect", "Ancillary Performed"
  priority: string | null;            // "Routine", "Stat"
  orderTime: ISODateTime;             // when provider placed the order
  specimenType: string | null;        // "Blood", "Stool", "Serum"
  resultLab: string | null;           // performing lab name
  labStatus: string | null;           // "Final result", "Preliminary result"
  isAbnormal: boolean | null;         // true if any result flagged abnormal
  authorizingProvider: string | null; // authorizing provider name (denormalized) or ID
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
  noteStatus: string | null;             // NOTE_STATUS_C_NAME — "Signed"
  noteFormat: string | null;             // NOTE_FORMAT_C_NAME — "Rich Text"
  authorType: string | null;             // AUTHOR_PRVD_TYPE_C_NAME — "Physician", "Registered Nurse"
  sensitivity: string | null;            // SENSITIVE_STAT_C_NAME — "Not Sensitive"
  sharedWithPatient: boolean | null;     // NOTE_SHARED_W_PAT_HX_YN
  cosignRequired: string | null;         // COSIGN_REQUIRED_C_NAME
  noteType: string | null;               // NOTE_TYPE_C_NAME — "RTF Letter", "Progress Notes"
  _epic: EpicRaw;
}

/**
 * Known EHI limitation: Epic's EHI export includes flowsheet metadata
 * (who recorded, when, which template row) via IP_FLWSHT_MEAS, but does
 * NOT include the actual measurement values — there is no MEAS_VALUE column
 * in the export. Vital signs (BP, Pulse, Weight, SpO2, etc.) are recorded
 * but their numeric/text values are absent from the export.
 *
 * As a result, vitalSigns[] will always have value: '' for every entry.
 * The metadata (name, timestamp, recorder) is still useful for provenance.
 * See TODO.md Phase 0.4.
 */
export interface VitalSign {
  name: string;
  /** Always '' — MEAS_VALUE is not included in Epic EHI exports */
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
  specimenType: string | null;        // "Blood", "Serum" — from the parent order
  resultLab: string | null;           // performing lab name — from the parent order
  labStatus: string | null;           // "Final result" — from the parent order
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
  tobacco: {
    status: string | null;
    packsPerDay: number | null;
    quitDate: ISODate;
    cigarettes: boolean | null;         // uses cigarettes
    pipes: boolean | null;              // smokes pipe
    cigars: boolean | null;             // uses cigars
    snuff: boolean | null;              // uses snuff
    chew: boolean | null;               // uses chewing tobacco
  };
  alcohol: { status: string | null; drinksPerWeek: number | null; comment: string | null };
  drugs: { status: string | null; comment: string | null; illicitDrugUse: string | null };
  sexualActivity: string | null;
  sexualHealth: {
    femalePartner: boolean | null;
    malePartner: boolean | null;
    contraceptionMethods: string[];     // e.g. ["Condom", "Pill", "IUD"]
  } | null;
  dataSources: {
    tobacco: string | null;             // "Provider", "Patient", etc.
    alcohol: string | null;
    drug: string | null;
    sexual: string | null;
  } | null;
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
  transactionActions: TransactionAction[];
  eobLineItems: EOBLineItem[];
  collectionEvents: CollectionEvent[];
  remittances: RemittanceRecord[];
  reconciliations: ClaimReconciliationRecord[];
  invoices: InvoiceRecord[];
  serviceBenefits: ServiceBenefitRecord[];
}

export interface Charge {
  id: Id;
  date: ISODate;
  service: string | null;
  amount: number | null;
  provider: string | null;
  visitId: Id | null;
  diagnosisCodes: string[];
  /** Outstanding balance remaining on this charge */
  outstandingAmount: number | null;
  /** Insurance portion of the charge */
  insuranceAmount: number | null;
  /** Patient/self-pay portion of the charge */
  patientAmount: number | null;
  /** Total matched payment amount (including adjustments) */
  totalMatchAmount: number | null;
  /** Total matched insurance payment amount */
  totalMatchInsuranceAmount: number | null;
  /** Total matched adjustment amount */
  totalMatchAdjustment: number | null;
  /** Financial class at time of charge (e.g., "Blue Cross") */
  financialClass: string | null;
  /** Billing provider ID */
  billingProvider: string | null;
  /** Service/performing provider ID */
  serviceProvider: string | null;
  /** Provider specialty (e.g., "Internal Medicine") */
  providerSpecialty: string | null;
  /** Invoice number */
  invoiceNumber: string | null;
  /** Quantity billed */
  quantity: number | null;
  /** Procedure modifier codes */
  modifiers: string[];
  /** Date this charge was most recently claimed */
  claimDate: ISODate;
  /** Adjudicated copay amount from benefits engine */
  adjudicatedCopay: number | null;
  /** Adjudicated coinsurance amount from benefits engine */
  adjudicatedCoinsurance: number | null;
  /** Adjudicated self-pay amount from benefits engine */
  adjudicatedSelfPay: number | null;
  /** Whether this charge has been voided */
  isVoided: boolean;
  /** Date the charge was voided */
  voidDate: ISODate;
  /** For replacement charges: the original (voided) charge TX_ID this replaced */
  originalChargeId: Id | null;
  /** User who voided this charge */
  voidedBy: string | null;
  /** Void/repost type (e.g., "Correction") */
  voidType: string | null;
  /** Payment match history — who matched which payment to this charge, when */
  matchHistory: ChargeMatchHistory[];
  /** Statement/claim submission history for this charge */
  claimHistory: ChargeClaimHistory[];
  /** Dates when statements were sent for this charge */
  statementDates: ISODate[];
  _epic: EpicRaw;
}

export interface Payment {
  id: Id;
  date: ISODate;
  amount: number | null;
  method: string | null;
  payer: string | null;
  relatedChargeId: Id | null;
  /** Payment source (e.g., "Electronic Funds Transfer", "Check") */
  paymentSource: string | null;
  /** Outstanding balance after this payment */
  outstandingAmount: number | null;
  /** Insurance amount on this transaction */
  insuranceAmount: number | null;
  /** Patient/self-pay portion */
  patientAmount: number | null;
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
  /** Payer's internal control number (ICN) — unique claim ID in payer's system */
  claimControlNumber: string | null;
  /** Payer identifier code */
  payerIdentifier: string | null;
  /** Claim filing sequence (e.g., "P" = primary) */
  filingSequence: string | null;
  /** Insurance type code */
  filingIndicator: string | null;
  /** Coverage group number */
  groupNumber: string | null;
  /** Coverage group name */
  groupName: string | null;
  /** Bill type: facility + frequency code (e.g., "11" + "1") */
  billingType: string | null;
  /** Billing provider details */
  billingProviderDetail: {
    name: string | null;
    npi: string | null;
    taxonomy: string | null;
    taxId: string | null;
    address: string | null;
  } | null;
  /** Payer address */
  payerAddress: string | null;
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
  // Guarantor account (ACCOUNT) fields
  accountType: string | null;            // ACCOUNT_TYPE_C_NAME — "Personal/Family"
  financialClass: string | null;         // FIN_CLASS_C_NAME — "Blue Cross"
  insuranceBalance: number | null;       // HB_INSURANCE_BALAN
  selfPayBalance: number | null;         // HB_SELFPAY_BALANCE
  lastInsPaymentDate: ISODate;           // HB_LAST_INS_PMT_DT
  lastPatPaymentDate: ISODate;           // HB_LAST_SP_PMT_DT (self-pay)
  lastPatPaymentAmount: number | null;   // LAST_PAT_PMT_AMT
  // Hospital account (HSP_ACCOUNT) fields
  admissionSource: string | null;        // ADMISSION_SOURCE_C_NAME
  admissionType: string | null;          // ADMISSION_TYPE_C_NAME
  patientDischargeStatus: string | null; // PATIENT_STATUS_C_NAME
  codingStatus: string | null;           // CODING_STATUS_C_NAME
  primaryPayorId: string | null;         // PRIMARY_PAYOR_ID (numeric — no _NAME join)
  firstBilledDate: ISODate;              // FIRST_BILLED_DATE
  invoiceNumber: string | null;          // BASE_INV_NUM
  _epic: EpicRaw;
}

/** EOB/remittance action trail — denials, adjustments, transfers per transaction */
export interface TransactionAction {
  /** Parent transaction ID */
  transactionId: Id;
  /** Line number within the transaction's action list */
  line: number | null;
  /** Action type (e.g., "Not Allowed Adjustment", "Denial", "Transfer") */
  actionType: string | null;
  /** Date the action was performed */
  actionDate: ISODate;
  /** Monetary amount of this action */
  actionAmount: number | null;
  /** Denial code number */
  denialCode: string | null;
  /** Human-readable denial code description (e.g., "45-CHGS EXCD FEE SCH/MAX ALLOWABLE.") */
  denialCodeName: string | null;
  /** Primary CARC/RARC remittance reason code description */
  remittanceCode: string | null;
  /** Second remittance reason code description */
  remittanceCodeTwo: string | null;
  /** Third remittance reason code description */
  remittanceCodeThree: string | null;
  /** Fourth remittance reason code description */
  remittanceCodeFour: string | null;
  /** Outstanding amount before the action */
  outstandingBefore: number | null;
  /** Outstanding amount after the action */
  outstandingAfter: number | null;
  /** Insurance amount before the action */
  insuranceBefore: number | null;
  /** Insurance amount after the action */
  insuranceAfter: number | null;
  /** Payor on this action */
  payorId: string | null;
  /** Payment payor (if action is associated with a payment) */
  paymentPayorId: string | null;
  /** Coverage before the action */
  coverageBefore: string | null;
  /** Coverage after the action */
  coverageAfter: string | null;
  /** Comma-delimited external remittance codes */
  actionRemitCodes: string | null;
  /** System-generated comment */
  actionComment: string | null;
  _epic: EpicRaw;
}

/** Payment/EOB line item — per-charge breakdown on a payment */
export interface EOBLineItem {
  /** Payment transaction ID */
  paymentTransactionId: Id;
  /** Matched charge transaction ID */
  chargeTransactionId: Id | null;
  /** Line number */
  line: number | null;
  /** Covered amount */
  coveredAmount: number | null;
  /** Non-covered amount */
  nonCoveredAmount: number | null;
  /** Deductible amount applied */
  deductibleAmount: number | null;
  /** Copay amount applied */
  copayAmount: number | null;
  /** Coinsurance amount applied */
  coinsuranceAmount: number | null;
  /** Coordination of benefits amount */
  cobAmount: number | null;
  /** Amount actually paid */
  paidAmount: number | null;
  /** Payer's internal control number */
  claimControlNumber: string | null;
  /** Denial codes on this line */
  denialCodes: string | null;
  /** Winning denial description */
  winningDenialName: string | null;
  /** EOB action type (e.g., next responsible party, resubmit) */
  actionType: string | null;
  /** Action amount */
  actionAmount: number | null;
  /** Invoice number */
  invoiceNumber: string | null;
  /** Date charge was matched to payment */
  matchDate: ISODate;
  _epic: EpicRaw;
}

/** Front-desk collection event — copay/prepay/balance collection at check-in */
export interface CollectionEvent {
  /** Encounter this collection event is associated with */
  visitId: Id;
  /** Line number */
  line: number | null;
  /** Date of the encounter */
  date: ISODate;
  /** Instant the collection event occurred */
  collectionInstant: ISODateTime;
  /** Workflow type (e.g., "Check-In") */
  workflowType: string | null;
  /** Event type (e.g., "Collection Event") */
  eventType: string | null;
  /** Professional billing copay: due, paid (prior), collected (this event) */
  pbCopay: { due: number | null; paid: number | null; collected: number | null } | null;
  /** Hospital billing copay: due, paid (prior), collected (this event) */
  hbCopay: { due: number | null; paid: number | null; collected: number | null } | null;
  /** Professional billing prepayment: due, paid (prior), collected (this event) */
  pbPrepay: { due: number | null; paid: number | null; collected: number | null } | null;
  /** Hospital billing prepayment: due, paid (prior), collected (this event) */
  hbPrepay: { due: number | null; paid: number | null; collected: number | null } | null;
  /** Professional billing previous balance: due, paid (prior), collected (this event) */
  pbPreviousBalance: { due: number | null; paid: number | null; collected: number | null } | null;
  /** Hospital billing previous balance: due, paid (prior), collected (this event) */
  hbPreviousBalance: { due: number | null; paid: number | null; collected: number | null } | null;
  /** Visit balance: due, paid, collected */
  visitBalance: { due: number | null; paid: number | null; collected: number | null } | null;
  /** Prepay discount offered */
  prepayDiscountOffered: number | null;
  /** Reason amount was not collected */
  nonCollectionReason: string | null;
  /** Free text comment for non-collection */
  nonCollectionComment: string | null;
  _epic: EpicRaw;
}

// ─── Remittances ───────────────────────────────────────────────────────────

/** ERA/835 remittance — payer explanation of payment with adjudication and service-level detail */
export interface RemittanceRecord {
  id: Id;
  creationDate: ISODate;
  paymentAmount: number | null;
  paymentMethod: string | null;
  adjudication: RemittanceAdjudication | null;   // from claim_info[0]
  serviceLines: RemittanceServiceLine[];          // from service_lines
  adjustments: RemittanceAdjustment[];            // from service_level_adjustments
  _epic: EpicRaw;
}

export interface RemittanceAdjudication {
  invoiceNumber: string | null;
  claimStatus: string | null;             // "Processed as Primary"
  chargedAmount: number | null;
  paidAmount: number | null;
  patientResponsibility: number | null;
  claimControlNumber: string | null;      // ICN
  filingCode: string | null;              // "Preferred provider organization (PPO)"
}

export interface RemittanceServiceLine {
  line: number | null;
  procedureCode: string | null;           // "HC:99213:95"
  chargedAmount: number | null;
  paidAmount: number | null;
  unitsPaid: number | null;
  revenueCode: string | null;             // NUBC revenue code
  chargeTransactionId: Id | null;         // SVC_LINE_CHG_PB_ID or HB_ID — links to Charge
  _epic: EpicRaw;
}

export interface RemittanceAdjustment {
  line: number | null;
  serviceLine: string | null;             // which service line this adjustment applies to
  adjustmentGroup: string | null;         // "Contractual Obligation", "Patient Responsibility"
  reasonCode: string | null;              // CARC code e.g. "45"
  amount: number | null;
  quantity: number | null;
  _epic: EpicRaw;
}

// ─── Claim Reconciliation ──────────────────────────────────────────────────

/** Claim lifecycle tracking — status changes from submission through payment/rejection */
export interface ClaimReconciliationRecord {
  id: Id;
  invoiceNumber: string | null;
  currentStatus: string | null;           // "Open", "Closed"
  claimStatus: string | null;             // "Accepted from Run", "Rejected"
  totalBilled: number | null;
  closedDate: ISODate;
  timeline: ClaimStatusEvent[];           // from status_timeline + status_detail
  _epic: EpicRaw;
}

export interface ClaimStatusEvent {
  date: ISODate;
  sortKey: number;                        // CONTACT_DATE_REAL — preserves sub-day ordering
  statusCode: string | null;              // "Accepted in H.IP – Electronic Claim Sent"
  action: string | null;                  // "Accept Claim", "No Action"
  message: string | null;                 // detailed status message
  description: string | null;             // LINE 2 description (collapsed from pair)
  payerAmountSubmitted: number | null;
  payerAmountPaid: number | null;
  payerCheckDate: ISODate;
  payerCheckNumber: string | null;
  fileName: string | null;                // e.g. "/epic/xfer/.../file.02067910.277"
  errorMessage: string | null;
  _epic: EpicRaw;
}

// ─── Invoices ──────────────────────────────────────────────────────────────

/** Invoice — links charges to claims, bridges billing transactions to claim submissions */
export interface InvoiceRecord {
  id: Id;
  invoiceNumber: string | null;
  status: string | null;                  // "Rejected", "Accepted"
  type: string | null;                    // "Claim"
  insuranceAmount: number | null;
  selfPayAmount: number | null;
  serviceFromDate: ISODate;
  serviceToDate: ISODate;
  payerName: string | null;               // MAILING_NAME
  coverageId: Id | null;
  chargeTransactionIds: Id[];             // from tx_pieces — the charges on this invoice
  _epic: EpicRaw;
}

// ─── Service Benefits ──────────────────────────────────────────────────────

/** Per-service-type benefit detail from insurance coverage verification */
export interface ServiceBenefitRecord {
  coverageId: Id;
  serviceType: string | null;             // "PSYCH-IP", "Office Visit", "Lab"
  copayAmount: number | null;
  deductibleAmount: number | null;
  deductibleMet: number | null;
  deductibleRemaining: number | null;
  coinsurancePercent: number | null;
  outOfPocketMax: number | null;
  outOfPocketRemaining: number | null;
  outOfPocketMet: boolean | null;
  inNetwork: boolean | null;
  networkLevel: string | null;            // "N/A", "In Network"
  familyTier: string | null;              // "Individual", "Family"
  maxVisits: number | null;
  remainingVisits: number | null;
  annualBenefitMax: number | null;
  annualBenefitRemaining: number | null;
  lifetimeBenefitMax: number | null;
  lifetimeBenefitRemaining: number | null;
  _epic: EpicRaw;
}

// ─── Charge enrichment sub-types ───────────────────────────────────────────

/** Record of a payment being matched to a charge */
export interface ChargeMatchHistory {
  matchDate: ISODate;
  matchDateTime: ISODateTime;
  matchedTransactionId: Id | null;        // the payment TX that was matched
  amount: number | null;
  insuranceAmount: number | null;
  patientAmount: number | null;
  invoiceNumber: string | null;
  matchedBy: string | null;               // user who performed the match
  unmatchDate: ISODate;                   // if later unmatched
  unmatchComment: string | null;
  _epic: EpicRaw;
}

/** Claim/statement history entry for a charge */
export interface ChargeClaimHistory {
  type: string | null;                    // "Claim" or "Statement"
  date: ISODate;
  amount: number | null;
  invoiceNumber: string | null;
  paymentAmount: number | null;
  paymentDate: ISODate;
  acceptDate: ISODate;
  _epic: EpicRaw;
}

// ─── Coverage (Insurance) ──────────────────────────────────────────────────

export interface InsuranceCoverage {
  id: Id;
  type: string | null;        // COVERAGE_TYPE_C_NAME (e.g. "Indemnity")
  payorName: string | null;    // PAYOR_NAME
  planName: string | null;     // FREE_TXT_PLAN_NAME (often null in EHI)
  groupName: string | null;    // GROUP_NAME
  groupNumber: string | null;  // GROUP_NUM
  subscriberId: string | null; // MEM_NUMBER from member_list (SUBSCR_NUM absent in EHI)
  effectiveDate: ISODate;      // MEM_EFF_FROM_DATE from member_list, or CVG_EFF_DT
  terminationDate: ISODate;    // MEM_EFF_TO_DATE from member_list, or CVG_TERM_DT
  _epic: EpicRaw;
}

// ─── Referrals ─────────────────────────────────────────────────────────────

export interface Referral {
  id: Id;
  status: string | null;             // RFL_STATUS_C_NAME
  type: string | null;               // RFL_TYPE_C_NAME
  specialty: string | null;          // PROV_SPEC_C_NAME
  referringProvider: string | null;  // REFERRING_PROV_ID_REFERRING_PROV_NAM
  referredToProvider: string | null; // REFERRAL_PROV_ID (often null)
  entryDate: ISODate;                // ENTRY_DATE
  expirationDate: ISODate;           // EXP_DATE
  reason: string | null;             // first reason from reasons children, or RSN_FOR_RFL_C_NAME
  referralClass: string | null;      // RFL_CLASS_C_NAME — "Outgoing"
  authorizedVisits: number | null;   // AUTH_NUM_OF_VISITS
  actualVisits: number | null;       // ACTUAL_NUM_VISITS
  priority: string | null;           // PRIORITY_C_NAME — "Routine"
  schedulingStatus: string | null;   // SCHED_STATUS_C_NAME — "Do Not Schedule"
  preAuthRequired: string | null;    // PREAUTH_REQ_C_NAME
  closeReason: string | null;        // CLOSE_RSN_C_NAME — "Expired-Auto Closed"
  referredToSpecialty: string | null; // REFD_TO_SPEC_C_NAME — "Radiology"
  referredToLocation: string | null; // REFD_TO_LOC_POS_ID (numeric ID — no _NAME join available)
  serviceDate: ISODate;              // SERV_DATE
  _epic: EpicRaw;
}

// ─── Documents ─────────────────────────────────────────────────────────────

export interface ClinicalDocument {
  id: Id;
  type: string | null;          // DOC_INFO_TYPE_C_NAME
  description: string | null;   // DOC_DESCR
  status: string | null;        // DOC_STAT_C_NAME
  receivedDate: ISODateTime;    // SCAN_INST_DTTM or SCAN_TIME
  receivedBy: string | null;    // RECV_BY_USER_ID_NAME
  _epic: EpicRaw;
}

// ─── Episodes of Care ──────────────────────────────────────────────────────

export interface Episode {
  id: Id;
  name: string | null;          // NAME
  status: string | null;        // STATUS_C_NAME
  startDate: ISODate;           // START_DATE
  endDate: ISODate;             // END_DATE
  _epic: EpicRaw;
}

// ─── Emergency Contacts ────────────────────────────────────────────────────

export interface EmergencyContact {
  name: string;
  relationship: string | null;
  phone: string | null;
  address: string | null;
  isEmergencyContact: boolean;
  _epic: EpicRaw;
}

// ─── Patient Goals ─────────────────────────────────────────────────────────

export interface PatientGoal {
  id: Id;
  name: string | null;
  status: string | null;
  type: string | null;
  createdDate: ISODateTime;
  createdBy: string | null;
  _epic: EpicRaw;
}

// ─── Contact Methods ───────────────────────────────────────────────────────

export interface ContactMethod {
  type: string;
  value: string;
  _epic: EpicRaw;
}

// ─── Questionnaire Responses ───────────────────────────────────────────────

export interface QuestionnaireResponse {
  formId: Id;
  formName: string | null;
  encounterId: Id | null;
  completedDate: ISODateTime;
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
function ynBool(v: unknown): boolean | null { return v === 'Y' ? true : v === 'N' ? false : null; }

/**
 * Extract flat scalar fields from an Epic object for the `_epic` escape hatch.
 *
 * **Design choice**: Arrays and nested objects are intentionally stripped.
 * The `_epic` record is meant to be a flat key→scalar snapshot of the original
 * Epic row (strings, numbers, booleans) — useful for debugging, display, and
 * ad-hoc access to unmapped columns without duplicating the full object graph.
 *
 * Nested children (e.g., order.results, encounter.diagnoses) are already
 * accessible as typed arrays on the parent entity; including them in `_epic`
 * would double memory usage and create confusing circular-ish structures.
 *
 * If you need the full raw object with children, access the source
 * PatientRecord directly rather than going through `_epic`.
 */
function epic(obj: any): EpicRaw {
  const raw: EpicRaw = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v != null && !Array.isArray(v) && typeof v !== 'object') raw[k] = v;
  }
  return raw;
}

import { PatientRecord } from './PatientRecord';
type R = PatientRecord;

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
    coverage: r.coverage.map(projectCoverage),
    referrals: r.referrals.map(projectReferral),
    documents: r.documents.map(projectDocument),
    episodes: r.episodes.map(projectEpisode),
    goals: projectGoals(r),
    questionnaireResponses: projectQuestionnaires(r),
  };
}

function projectDemographics(r: R): Demographics {
  const p = r.patient as Record<string, any>;  // raw Epic bag — untyped columns
  return {
    name: p.PAT_NAME?.replace(',', ', ') ?? '',
    firstName: p.PAT_FIRST_NAME ?? '', lastName: p.PAT_LAST_NAME ?? '',
    dateOfBirth: toISODate(p.BIRTH_DATE), sex: str(p.SEX_C_NAME),
    race: Array.isArray(p.race) ? p.race.map((row: any) => row.PATIENT_RACE_C_NAME).filter(Boolean) : [],
    ethnicity: str(p.ETHNIC_GROUP_C_NAME),
    language: str(p.LANGUAGE_C_NAME), maritalStatus: str(p.MARITAL_STATUS_C_NAME), // audit:optional
    address: (p.CITY || p.STATE_C_NAME || p.ZIP) ? {
      street: str(p.ADD_LINE_1), city: str(p.CITY), // ADD_LINE_1 audit:optional
      state: str(p.STATE_C_NAME), zip: str(p.ZIP), country: str(p.COUNTRY_C_NAME),
    } : null,
    phone: str(p.HOME_PHONE), email: str(p.EMAIL_ADDRESS),
    mrn: String(p.PAT_MRN_ID ?? ''),
    primaryCareProvider: str(p._pcp_name ?? p.CUR_PCP_PROV_ID_NAME), // CUR_PCP_PROV_ID_NAME audit:optional; _pcp_name resolved via CLARITY_SER
    genderIdentity: str(p.GENDER_IDENTITY_C_NAME),
    sexAssignedAtBirth: str(p.SEX_ASGN_AT_BIRTH_C_NAME),
    preferredName: str(p.PREFERRED_NAME),
    employer: str(p.EMPR_ID_CMT) ?? str(p.EMPLOYER_ID_EMPLOYER_NAME),
    contactMethods: Array.isArray(p.other_communications)
      ? p.other_communications
          .filter((c: any) => c.OTHER_COMMUNIC_NUM)
          .map((c: any): ContactMethod => ({
            type: c.OTHER_COMMUNIC_C_NAME ?? 'Unknown',
            value: c.OTHER_COMMUNIC_NUM,
            _epic: epic(c),
          }))
      : [],
    emergencyContacts: Array.isArray(p.relationship_list)
      ? p.relationship_list.map((row: any): EmergencyContact => {
          const parts = [row.CITY, row.STATE_C_NAME, row.ZIP_CODE].filter(Boolean);
          return {
            name: row.NAME ?? 'Unknown',
            relationship: str(row.LEGAL_RELATION_C_NAME) ?? str(row.SOCIAL_CLOSENESS_C_NAME),
            phone: str(row.PRIMARY_OR_FIRST_PHONE),
            address: parts.length > 0 ? parts.join(', ') : null,
            isEmergencyContact: row.EMERG_CONTACT_YN === 'Y',
            _epic: epic(row),
          };
        })
      : [],
    _epic: epic(p),
  };
}

function projectAllergy(a: any): Allergy {
  return {
    id: sid(a.ALLERGY_ID),
    allergen: a.allergenName ?? a.ALLERGEN_ID_ALLERGEN_NAME ?? 'Unknown',
    type: str(a.ALLERGY_TYPE_C_NAME), // audit:optional
    reactions: (a.reactions ?? []).map((r: any) => r.REACTION_NAME ?? r.REACTION_C_NAME ?? 'Unknown'), // REACTION_NAME audit:optional
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
    sig: str(m.SIG), // audit:optional — some exports inline SIG on ORDER_MED
    startDate: toISODate(m.START_DATE), endDate: toISODate(m.END_DATE),
    status: str(m.ORDER_STATUS_C_NAME),
    prescriber: str(m.ORD_CREATR_USER_ID_NAME),
    pharmacy: str(m.PHARMACY_ID_PHARMACY_NAME),
    associatedDiagnoses: (m.associatedDiagnoses ?? []).map((d: any) => d.DX_NAME ?? String(d.DX_ID)),
    quantity: str(m.QUANTITY),
    refills: num(m.REFILLS),
    refillsRemaining: num(m.REFILLS_REMAINING),
    dispenseAsWritten: m.DISP_AS_WRITTEN_YN === 'Y' ? true : m.DISP_AS_WRITTEN_YN === 'N' ? false : null,
    orderClass: str(m.ORDER_CLASS_C_NAME),
    orderingMode: str(m.ORDERING_MODE_C_NAME),
    priority: str(m.ORDER_PRIORITY_C_NAME),
    discontinuedDate: toISODateTime(m.DISCON_TIME),
    discontinuedReason: str(m.RSN_FOR_DISCON_C_NAME),
    _epic: epic(m),
  };
}

function projectImmunization(i: any): Immunization {
  // Dose: prefer structured amount+unit ("0.5 mL"), fall back to free-text DOSE
  const structuredDose = (i.IMMNZTN_DOSE_AMOUNT != null && i.IMMNZTN_DOSE_UNIT_C_NAME)
    ? `${i.IMMNZTN_DOSE_AMOUNT} ${i.IMMNZTN_DOSE_UNIT_C_NAME}` : null;
  return {
    id: sid(i.IMMUNE_ID),
    vaccine: i.IMMUNZATN_ID_NAME ?? 'Unknown',
    date: toISODate(i.IMMUNE_DATE),
    site: str(i.SITE_C_NAME), route: str(i.ROUTE_C_NAME),
    dose: structuredDose ?? str(i.DOSE),
    lotNumber: str(i.LOT),
    manufacturer: str(i.MFG_C_NAME),
    administeredBy: str(i.ENTRY_USER_ID_NAME),
    status: str(i.IMMNZTN_STATUS_C_NAME),
    product: str(i.IMM_PRODUCT),
    ndcCode: str(i.NDC_NUM_ID_NDC_CODE),
    expirationDate: toISODate(i.EXPIRATION_DATE),
    givenBy: str(i.GIVEN_BY_USER_ID_NAME),
    source: str(i.EXTERNAL_ADMIN_C_NAME),
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
    admissionType: str(v.HOSP_ADMSN_TYPE_C_NAME),
    admissionTime: toISODateTime(v.HOSP_ADMSN_TIME),
    dischargeTime: toISODateTime(v.HOSP_DISCHRG_TIME),
    encStatus: str(v.CALCULATED_ENC_STAT_C_NAME),
    copayDue: num(v.COPAY_DUE),
    bmi: num(v.BMI),
    bsa: num(v.BSA),
    referralSource: str(v.REFERRAL_SOURCE_ID_REFERRING_PROV_NAM),
    checkedInBy: str(v.CHECKIN_USER_ID_NAME),
    closedDate: toISODate(v.ENC_CLOSE_DATE),
    closedBy: str(v.ENC_CLOSED_USER_ID_NAME),
    reasonsForVisit: v.reasonsForVisit ?? [],
    diagnoses: (v.diagnoses ?? []).map((dx: any, i: number): VisitDiagnosis => ({
      name: dx._dx_name ?? dx.DX_NAME ?? `Diagnosis ${dx.DX_ID}`,
      icdCode: str(dx.DX_ID), isPrimary: dx.PRIMARY_DX_YN === 'Y' || i === 0,
      _epic: epic(dx),
    })),
    orders: (v.orders ?? []).map((o: any) => projectOrder(o, r)),
    notes: (v.notes ?? [])
      .map((n: any): VisitNote => {
        // NOTE_ENC_INFO columns live in encounter_info[0] (joined child array)
        const ei = (n.encounter_info ?? n.encounterInfo ?? [])[0] as Record<string, unknown> | undefined;
        return {
          id: sid(n.NOTE_ID),
          type: str(n.IP_NOTE_TYPE_C_NAME),
          author: str(n.AUTHOR_NAME ?? ei?.AUTHOR_USER_ID_NAME ?? n.CURRENT_AUTHOR_ID_NAME ?? n.ENTRY_USER_ID_NAME), // AUTHOR_NAME audit:optional
          date: toISODateTime(ei?.ENTRY_INSTANT_DTTM ?? n.ENTRY_INSTANT_DTTM ?? n.CREATE_INSTANT_DTTM),
          text: Array.isArray(n.text) ? n.text.map((t: any) => t.NOTE_TEXT ?? '').join('') : '',
          noteStatus: str(ei?.NOTE_STATUS_C_NAME),
          noteFormat: str(ei?.NOTE_FORMAT_C_NAME),
          authorType: str(ei?.AUTHOR_PRVD_TYPE_C_NAME),
          sensitivity: str(ei?.SENSITIVE_STAT_C_NAME),
          sharedWithPatient: ei?.NOTE_SHARED_W_PAT_HX_YN != null ? ei.NOTE_SHARED_W_PAT_HX_YN === 'Y' : null,
          cosignRequired: str(ei?.COSIGN_REQUIRED_C_NAME),
          noteType: str(ei?.NOTE_TYPE_C_NAME),
          _epic: epic(n),
        };
      })
      .filter((n: VisitNote) => n.text.trim().length > 0), // drop empty notes
    // EHI limitation: flowsheet measurements have metadata but NO actual values.
    // MEAS_VALUE is not exported by Epic. We wire the metadata for provenance.
    vitalSigns: (v.flowsheet_measurements ?? []).map((f: any): VitalSign => ({
      name: f.FLT_ID_DISPLAY_NAME ?? 'Unknown',
      value: '', // MEAS_VALUE absent from EHI export — see VitalSign interface
      unit: null, // no UNITS column in export
      takenAt: toISODateTime(f.RECORDED_TIME),
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
    orderClass: str(o.ORDER_CLASS_C_NAME),
    priority: str(o.ORDER_PRIORITY_C_NAME),
    orderTime: toISODateTime(o.ORDER_TIME),
    specimenType: str(o.SPECIMEN_TYPE_C_NAME),
    resultLab: str(o.RESULT_LAB_ID_LLB_NAME),
    labStatus: str(o.LAB_STATUS_C_NAME),
    isAbnormal: o.ABNORMAL_YN === 'Y' ? true : o.ABNORMAL_YN === 'N' ? false : null,
    authorizingProvider: str(o.AUTHRZING_PROV_ID),
    results: rawResults.map(projectResult),
    _epic: epic(o),
  };
}

function projectResult(res: any): OrderResult {
  return {
    component: res.componentName ?? res.COMPONENT_ID_NAME ?? res.COMPONENT_ID_COMPONENT_NAME ?? 'Unknown', // COMPONENT_ID_COMPONENT_NAME audit:optional
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
          orderName: o.description ?? 'Unknown',
          visitId: sid(v.PAT_ENC_CSN_ID), visitDate: toISODate(v.contactDate),
          specimenType: str(o.SPECIMEN_TYPE_C_NAME),
          resultLab: str(o.RESULT_LAB_ID_LLB_NAME),
          labStatus: str(o.LAB_STATUS_C_NAME),
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
  // Collect active contraception methods from the YN flag columns
  const contraceptionMap: Array<[string, string]> = [
    ['CONDOM_YN', 'Condom'], ['PILL_YN', 'Pill'], ['DIAPHRAGM_YN', 'Diaphragm'],
    ['IUD_YN', 'IUD'], ['SURGICAL_YN', 'Surgical'], ['SPERMICIDE_YN', 'Spermicide'],
    ['IMPLANT_YN', 'Implant'], ['RHYTHM_YN', 'Rhythm'], ['INJECTION_YN', 'Injection'],
    ['SPONGE_YN', 'Sponge'], ['INSERTS_YN', 'Inserts'], ['ABSTINENCE_YN', 'Abstinence'],
  ];
  const contraceptionMethods = contraceptionMap
    .filter(([col]) => d[col] === 'Y')
    .map(([, label]) => label);

  const hasSexualData = d.FEMALE_PARTNER_YN != null || d.MALE_PARTNER_YN != null || contraceptionMethods.length > 0;
  const hasSourceData = d.TOB_SRC_C_NAME != null || d.ALCOHOL_SRC_C_NAME != null ||
    d.DRUG_SRC_C_NAME != null || d.SEX_SRC_C_NAME != null;

  return {
    tobacco: {
      status: str(d.TOBACCO_USER_C_NAME),
      packsPerDay: num(d.SMOKING_PACKS_PER_DAY), // audit:optional
      quitDate: toISODate(d.SMOKING_QUIT_DATE), // audit:optional
      cigarettes: ynBool(d.CIGARETTES_YN),
      pipes: ynBool(d.PIPES_YN),
      cigars: ynBool(d.CIGARS_YN),
      snuff: ynBool(d.SNUFF_YN),
      chew: ynBool(d.CHEW_YN),
    },
    alcohol: {
      status: str(d.ALCOHOL_USE_C_NAME),
      drinksPerWeek: num(d.ALCOHOL_OZ_PER_WK),
      comment: str(d.ALCOHOL_COMMENT),
    },
    drugs: {
      status: str(d.IV_DRUG_USER_YN === 'Y' ? 'Yes' : d.IV_DRUG_USER_YN === 'N' ? 'No' : null),
      comment: str(d.ILLICIT_DRUG_CMT),
      illicitDrugUse: str(d.ILL_DRUG_USER_C_NAME),
    },
    sexualActivity: str(d.SEXUALLY_ACTIVE_C_NAME),
    sexualHealth: hasSexualData ? {
      femalePartner: ynBool(d.FEMALE_PARTNER_YN),
      malePartner: ynBool(d.MALE_PARTNER_YN),
      contraceptionMethods,
    } : null,
    dataSources: hasSourceData ? {
      tobacco: str(d.TOB_SRC_C_NAME),
      alcohol: str(d.ALCOHOL_SRC_C_NAME),
      drug: str(d.DRUG_SRC_C_NAME),
      sexual: str(d.SEX_SRC_C_NAME),
    } : null,
    asOf: toISODate(d.CONTACT_DATE),
    _epic: epic(d),
  };
}

function socialHistoryDiffers(a: SocialHistory, b: SocialHistory): boolean {
  return a.tobacco.status !== b.tobacco.status ||
    a.tobacco.cigarettes !== b.tobacco.cigarettes ||
    a.tobacco.pipes !== b.tobacco.pipes ||
    a.alcohol.status !== b.alcohol.status ||
    a.alcohol.comment !== b.alcohol.comment ||
    a.drugs.status !== b.drugs.status ||
    a.drugs.illicitDrugUse !== b.drugs.illicitDrugUse ||
    a.sexualActivity !== b.sexualActivity;
}

function projectSurgicalHistory(r: R): SurgicalHistoryEntry[] {
  const tl = r.surgicalHistory;
  if (!tl?.snapshots?.length) return [];
  // Latest review snapshot, deduplicated by LINE
  const latestCSN = tl.snapshots[0].snapshotCSN;
  const byLine = new Map<number, any>();
  for (const s of tl.snapshots) {
    const d = s.data as Record<string, any>; // raw Epic bag
    if (s.snapshotCSN === latestCSN) byLine.set(d.LINE, d);
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
      const d = s.data as Record<string, any>; // raw Epic bag
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
  const fhRaw: any[] = (r._raw?.family_hx as any[]) ?? [];
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
    subject: str(m.SUBJECT), body: m.plainText || null,
    status: str(m.MSG_STATUS_C_NAME ?? m.RECORD_STATUS_C_NAME), // MSG_STATUS_C_NAME audit:optional
    threadId: str(m.THREAD_ID),
    _epic: epic(m),
  };
}

function projectCoverage(c: any): InsuranceCoverage {
  // Subscriber info is in member_list children; use first self-member
  const selfMember = (c.member_list ?? []).find((m: any) => m.MEM_REL_TO_SUB_C_NAME === 'Self') ?? (c.member_list ?? [])[0];
  return {
    id: sid(c.COVERAGE_ID),
    type: str(c.COVERAGE_TYPE_C_NAME),
    payorName: str(c.PAYOR_NAME),
    planName: str(c.FREE_TXT_PLAN_NAME),
    groupName: str(c.GROUP_NAME),
    groupNumber: str(c.GROUP_NUM),
    subscriberId: str(selfMember?.MEM_NUMBER),
    effectiveDate: toISODate(selfMember?.MEM_EFF_FROM_DATE ?? c.CVG_EFF_DT),
    terminationDate: toISODate(selfMember?.MEM_EFF_TO_DATE ?? c.CVG_TERM_DT),
    _epic: epic(c),
  };
}

function projectReferral(ref: any): Referral {
  const firstReason = (ref.reasons ?? [])[0];
  return {
    id: sid(ref.REFERRAL_ID),
    status: str(ref.RFL_STATUS_C_NAME),
    type: str(ref.RFL_TYPE_C_NAME),
    specialty: str(ref.PROV_SPEC_C_NAME),
    referringProvider: str(ref.REFERRING_PROV_ID_REFERRING_PROV_NAM),
    referredToProvider: str(ref.REFERRAL_PROV_ID),
    entryDate: toISODate(ref.ENTRY_DATE),
    expirationDate: toISODate(ref.EXP_DATE),
    reason: str(firstReason?.REFERRAL_REASON_C_NAME ?? ref.RSN_FOR_RFL_C_NAME),
    referralClass: str(ref.RFL_CLASS_C_NAME),
    authorizedVisits: num(ref.AUTH_NUM_OF_VISITS),
    actualVisits: num(ref.ACTUAL_NUM_VISITS),
    priority: str(ref.PRIORITY_C_NAME),
    schedulingStatus: str(ref.SCHED_STATUS_C_NAME),
    preAuthRequired: str(ref.PREAUTH_REQ_C_NAME),
    closeReason: str(ref.CLOSE_RSN_C_NAME),
    referredToSpecialty: str(ref.REFD_TO_SPEC_C_NAME),
    referredToLocation: str(ref.REFD_TO_LOC_POS_ID),
    serviceDate: toISODate(ref.SERV_DATE),
    _epic: epic(ref),
  };
}

function projectDocument(d: any): ClinicalDocument {
  return {
    id: sid(d.DOC_INFO_ID),
    type: str(d.DOC_INFO_TYPE_C_NAME),
    description: str(d.DOC_DESCR),
    status: str(d.DOC_STAT_C_NAME),
    receivedDate: toISODateTime(d.SCAN_INST_DTTM ?? d.SCAN_TIME),
    receivedBy: str(d.RECV_BY_USER_ID_NAME),
    _epic: epic(d),
  };
}

function projectEpisode(e: any): Episode {
  return {
    id: sid(e.EPISODE_ID),
    name: str(e.NAME),
    status: str(e.STATUS_C_NAME),
    startDate: toISODate(e.START_DATE),
    endDate: toISODate(e.END_DATE),
    _epic: epic(e),
  };
}

function projectBilling(r: R): BillingSummary {
  const txs = r.billing?.transactions ?? [];
  const charges: Charge[] = [];
  const payments: Payment[] = [];
  const transactionActions: TransactionAction[] = [];
  const eobLineItems: EOBLineItem[] = [];

  for (const _tx of txs) {
    const tx = _tx as any; // BillingTransaction uses Object.assign — raw columns exist at runtime
    const t = str(tx.TX_TYPE_C_NAME) ?? str(tx.txType);

    // Collect diagnosis codes from charge_diagnoses or diagnoses children, or inline DX fields
    const dxCodes: string[] = [];
    for (const d of (tx.charge_diagnoses ?? tx.chargeDiagnoses ?? tx.diagnoses ?? [])) {
      if (d.DX_ID != null) dxCodes.push(String(d.DX_ID));
    }
    // Also grab inline PRIMARY_DX_ID + DX_TWO..SIX if no children produced codes
    if (dxCodes.length === 0) {
      for (const col of ['PRIMARY_DX_ID', 'DX_TWO_ID', 'DX_THREE_ID', 'DX_FOUR_ID', 'DX_FIVE_ID', 'DX_SIX_ID']) {
        if (tx[col] != null) dxCodes.push(String(tx[col]));
      }
    }

    // Collect modifiers
    const mods: string[] = [];
    for (const col of ['MODIFIER_ONE', 'MODIFIER_TWO', 'MODIFIER_THREE', 'MODIFIER_FOUR']) {
      const v = str(tx[col]);
      if (v) mods.push(v);
    }

    if (t === 'Charge') {
      charges.push({
        id: sid(tx.TX_ID), date: toISODate(tx.SERVICE_DATE ?? tx.serviceDate),
        service: str(tx._procedure_name ?? tx.PROC_NAME ?? tx.PROCEDURE_DESC ?? tx.DFLT_PROC_DESC ?? tx.PROC_ID),
        amount: num(tx.AMOUNT ?? tx.TX_AMOUNT ?? tx.amount),
        provider: str(tx.SERV_PROVIDER_ID_NAME),
        visitId: str(tx.VISIT_NUMBER),
        diagnosisCodes: dxCodes,
        // ARPB_TRANSACTIONS enrichment
        outstandingAmount: num(tx.OUTSTANDING_AMT),
        insuranceAmount: num(tx.INSURANCE_AMT),
        patientAmount: num(tx.PATIENT_AMT),
        totalMatchAmount: num(tx.TOTAL_MATCH_AMT),
        totalMatchInsuranceAmount: num(tx.TOTAL_MTCH_INS_AMT),
        totalMatchAdjustment: num(tx.TOTAL_MTCH_ADJ),
        financialClass: str(tx.ORIGINAL_FC_C_NAME ?? tx.FIN_CLASS_C_NAME),
        billingProvider: str(tx.BILLING_PROV_ID),
        serviceProvider: str(tx.SERV_PROVIDER_ID ?? tx.PERFORMING_PROV_ID),
        providerSpecialty: str(tx.PROV_SPECIALTY_C_NAME),
        invoiceNumber: str(tx.IPP_INV_NUMBER ?? tx.INVOICE_NUM),
        quantity: num(tx.PROCEDURE_QUANTITY ?? tx.QUANTITY),
        modifiers: mods,
        claimDate: toISODate(tx.CLAIM_DATE),
        adjudicatedCopay: num(tx.BEN_ADJ_COPAY_AMT),
        adjudicatedCoinsurance: num(tx.BEN_ADJ_COINS_AMT),
        adjudicatedSelfPay: num(tx.BEN_SELF_PAY_AMT),
        // Void tracking
        isVoided: tx.VOID_DATE != null || tx.INACTIVE_TYPE_C_NAME === 'Voided',
        voidDate: toISODate(tx.VOID_DATE),
        originalChargeId: str(tx.void_info?.[0]?.OLD_ETR_ID),
        voidedBy: str(tx.void_info?.[0]?.DEL_CHARGE_USER_ID_NAME),
        voidType: str(tx.void_info?.[0]?.REPOST_TYPE_C_NAME),
        // Match history — who matched which payment to this charge, when
        matchHistory: (tx.match_history ?? []).map((mh: any): ChargeMatchHistory => ({
          matchDate: toISODate(mh.MTCH_TX_HX_DT),
          matchDateTime: toISODateTime(mh.MTCH_TX_HX_DTTM),
          matchedTransactionId: str(mh.MTCH_TX_HX_ID),
          amount: num(mh.MTCH_TX_HX_AMT),
          insuranceAmount: num(mh.MTCH_TX_HX_INS_AMT),
          patientAmount: num(mh.MTCH_TX_HX_PAT_AMT),
          invoiceNumber: str(mh.MTCH_TX_HX_INV_NUM),
          matchedBy: str(mh.MTCH_TX_HX_DSUSR_ID_NAME),
          unmatchDate: toISODate(mh.MTCH_TX_HX_UN_DT),
          unmatchComment: str(mh.MTCH_TX_HX_UN_COM),
          _epic: epic(mh),
        })),
        // Statement/claim history
        claimHistory: (tx.statement_claim_history ?? []).map((sc: any): ChargeClaimHistory => ({
          type: str(sc.BC_HX_TYPE_C_NAME),
          date: toISODate(sc.BC_HX_DATE),
          amount: num(sc.BC_HX_AMOUNT),
          invoiceNumber: str(sc.BC_HX_INVOICE_NUM),
          paymentAmount: num(sc.BC_HX_PAYMENT_AMT),
          paymentDate: toISODate(sc.BC_HX_PAYMENT_DATE),
          acceptDate: toISODate(sc.BC_HX_ACCEPT_DATE),
          _epic: epic(sc),
        })),
        // Statement dates from ARPB_TX_STMT_DT (when patient was billed)
        statementDates: (tx.statement_dates ?? tx.statementDates ?? [])
          .map((sd: any) => toISODate(sd.STATEMENT_DATE))
          .filter((d: ISODate) => d != null),
        _epic: epic(tx),
      });
    } else if (t === 'Payment' || t === 'Adjustment') {
      payments.push({
        id: sid(tx.TX_ID), date: toISODate(tx.POST_DATE ?? tx.postDate),
        amount: num(tx.AMOUNT ?? tx.TX_AMOUNT ?? tx.amount), method: t,
        payer: str(tx.PAYOR_ID_NAME),
        relatedChargeId: str(tx.MATCH_CHARGE_TX_ID),
        paymentSource: str(tx.PAYMENT_SOURCE_C_NAME ?? tx.PAYMENT_SRC_HA_C_NAME),
        outstandingAmount: num(tx.OUTSTANDING_AMT),
        insuranceAmount: num(tx.INSURANCE_AMT),
        patientAmount: num(tx.PATIENT_AMT),
        _epic: epic(tx),
      });
    }

    // --- Transaction actions (ARPB_TX_ACTIONS) ---
    // Available via Object.assign as tx.actions
    for (const a of (tx.actions ?? [])) {
      transactionActions.push({
        transactionId: sid(tx.TX_ID),
        line: num(a.LINE),
        actionType: str(a.ACTION_TYPE_C_NAME),
        actionDate: toISODate(a.ACTION_DATE),
        actionAmount: num(a.ACTION_AMOUNT),
        denialCode: str(a.DENIAL_CODE),
        denialCodeName: str(a.DENIAL_CODE_REMIT_CODE_NAME),
        remittanceCode: str(a.RMC_ID_REMIT_CODE_NAME),
        remittanceCodeTwo: str(a.RMC_TWO_ID_REMIT_CODE_NAME),
        remittanceCodeThree: str(a.RMC_THREE_ID_REMIT_CODE_NAME),
        remittanceCodeFour: str(a.RMC_FOUR_ID_REMIT_CODE_NAME),
        outstandingBefore: num(a.OUT_AMOUNT_BEFORE),
        outstandingAfter: num(a.OUT_AMOUNT_AFTER),
        insuranceBefore: num(a.INS_AMOUNT_BEFORE),
        insuranceAfter: num(a.INS_AMOUNT_AFTER),
        payorId: str(a.PAYOR_ID),
        paymentPayorId: str(a.PMT_PAYOR_ID),
        coverageBefore: str(a.BEFORE_CVG_ID),
        coverageAfter: str(a.AFTER_CVG_ID),
        actionRemitCodes: str(a.ACTION_REMIT_CODES),
        actionComment: str(a.ACTION_COMMENT),
        _epic: epic(a),
      });
    }

    // --- EOB line items (PMT_EOB_INFO_I) ---
    // Available via Object.assign as tx.eob_info_i
    for (const e of (tx.eob_info_i ?? [])) {
      eobLineItems.push({
        paymentTransactionId: sid(tx.TX_ID),
        chargeTransactionId: str(e.PEOB_TX_ID),
        line: num(e.LINE),
        coveredAmount: num(e.CVD_AMT),
        nonCoveredAmount: num(e.NONCVD_AMT),
        deductibleAmount: num(e.DED_AMT),
        copayAmount: num(e.COPAY_AMT),
        coinsuranceAmount: num(e.COINS_AMT),
        cobAmount: num(e.COB_AMT),
        paidAmount: num(e.PAID_AMT),
        claimControlNumber: str(e.ICN),
        denialCodes: str(e.DENIAL_CODES),
        winningDenialName: str(e.WIN_DENIAL_ID_REMIT_CODE_NAME),
        actionType: str(e.PEOB_ACTION_NAME_C_NAME ?? e.PEOB_ACTION_C_NAME),
        actionAmount: num(e.ACTION_AMT),
        invoiceNumber: str(e.INVOICE_NUM),
        matchDate: toISODate(e.TX_MATCH_DATE),
        _epic: epic(e),
      });
    }
  }

  // --- Claims (CLM_VALUES) ---
  const claims = (r.billing?.claims ?? []).map((c: any): Claim => {
    // Build billing provider detail if NPI or name present
    const hasBilProv = c.BIL_PROV_NPI || c.BIL_PROV_NAM_LAST;
    const bilProvAddr = [c.BIL_PROV_ADDR_1, c.BIL_PROV_ADDR_2, c.BIL_PROV_CITY,
      c.BIL_PROV_STATE, c.BIL_PROV_ZIP].filter(Boolean).join(', ');
    const pyrAddr = [c.PYR_ADDR_1, c.PYR_ADDR_2, c.PYR_CITY,
      c.PYR_STATE, c.PYR_ZIP].filter(Boolean).join(', ');
    // Billing type = facility code + frequency code
    const billingType = (c.BILL_TYP_FAC_CD || c.BILL_TYP_FREQ_CD)
      ? [c.BILL_TYP_FAC_CD, c.BILL_TYP_FREQ_CD].filter(Boolean).join('')
      : null;

    return {
      id: sid(c.RECORD_ID ?? c.CLAIM_ID ?? c.CLM_VALUES_ID),
      submitDate: toISODate(c.CREATE_DT ?? c.SUBMIT_DATE),
      status: str(c.CLAIM_STATUS_C_NAME ?? c.CLM_CVG_SEQ_CD),
      totalCharged: num(c.TTL_CHG_AMT ?? c.TOTAL_CHARGES),
      totalPaid: num(c.CLM_CVG_AMT_PAID ?? c.TOTAL_PAID),
      payer: str(c.CLM_CVG_PYR_NAM ?? c.PAYOR_ID_NAME),
      provider: str(c.REND_PROV_NAM_LAST ?
        [c.REND_PROV_NAM_LAST, c.REND_PROV_NAM_FIRST].filter(Boolean).join(', ') : null),
      invoiceNumber: str(c.INV_NUM),
      claimControlNumber: str(c.ICN),
      payerIdentifier: str(c.CLM_CVG_PYR_ID),
      filingSequence: str(c.CLM_CVG_SEQ_CD),
      filingIndicator: str(c.CLM_CVG_FILING_IND),
      groupNumber: str(c.CLM_CVG_GRP_NUM),
      groupName: str(c.CLM_CVG_GRP_NAM),
      billingType,
      billingProviderDetail: hasBilProv ? {
        name: str(c.BIL_PROV_NAM_LAST
          ? [c.BIL_PROV_NAM_LAST, c.BIL_PROV_NAM_FIRST].filter(Boolean).join(', ')
          : null),
        npi: str(c.BIL_PROV_NPI),
        taxonomy: str(c.BIL_PROV_TAXONOMY),
        taxId: str(c.BIL_PROV_TAXID),
        address: bilProvAddr || null,
      } : null,
      payerAddress: pyrAddr || null,
      _epic: epic(c),
    };
  });

  // --- Accounts ---
  const accounts: BillingAccount[] = [
    ...(r.billing?.guarantorAccounts ?? []).map((a: any): BillingAccount => ({
      id: sid(a.ACCOUNT_ID), type: 'Professional',
      name: str(a.ACCOUNT_NAME), accountClass: str(a.ACCT_FIN_CLASS_C_NAME),
      billingStatus: str(a.BILLING_STATUS_C_NAME),
      totalCharges: num(a.TOTAL_CHARGES), totalPayments: num(a.TOTAL_PAYMENTS),
      balance: num(a.TOTAL_BALANCE),
      accountType: str(a.ACCOUNT_TYPE_C_NAME),
      financialClass: str(a.FIN_CLASS_C_NAME),
      insuranceBalance: num(a.HB_INSURANCE_BALAN),
      selfPayBalance: num(a.HB_SELFPAY_BALANCE),
      lastInsPaymentDate: toISODate(a.HB_LAST_INS_PMT_DT),
      lastPatPaymentDate: toISODate(a.HB_LAST_SP_PMT_DT),
      lastPatPaymentAmount: num(a.LAST_PAT_PMT_AMT),
      admissionSource: null, admissionType: null, patientDischargeStatus: null,
      codingStatus: null, primaryPayorId: null, firstBilledDate: null, invoiceNumber: null,
      _epic: epic(a),
    })),
    ...(r.billing?.hospitalAccounts ?? []).map((h: any): BillingAccount => ({
      id: sid(h.HSP_ACCOUNT_ID), type: 'Hospital',
      name: str(h.HSP_ACCOUNT_NAME),
      accountClass: str(h.ACCT_CLASS_HA_C_NAME),
      billingStatus: str(h.ACCT_BILLSTS_HA_C_NAME),
      totalCharges: num(h.TOT_CHGS ?? h.TOT_CHARGES),
      totalPayments: num(h.TOT_PAYMENTS),
      balance: num(h.ACCT_BALANCE),
      accountType: null, financialClass: str(h.ACCT_FIN_CLASS_C_NAME),
      insuranceBalance: null, selfPayBalance: null,
      lastInsPaymentDate: null, lastPatPaymentDate: null, lastPatPaymentAmount: null,
      admissionSource: str(h.ADMISSION_SOURCE_C_NAME),
      admissionType: str(h.ADMISSION_TYPE_C_NAME),
      patientDischargeStatus: str(h.PATIENT_STATUS_C_NAME),
      codingStatus: str(h.CODING_STATUS_C_NAME),
      primaryPayorId: str(h.PRIMARY_PAYOR_ID),
      firstBilledDate: toISODate(h.FIRST_BILLED_DATE),
      invoiceNumber: str(h.BASE_INV_NUM),
      _epic: epic(h),
    })),
  ];

  // --- Collection events (FRONT_END_PMT_COLL_HX) ---
  // Stored as copay_collection children on encounters
  const collectionEvents: CollectionEvent[] = [];
  for (const enc of r.encounters) {
    const coll = (enc as any).copay_collection as any[] | undefined;
    if (!coll?.length) continue;
    for (const c of coll) {
      const mkGroup = (due: unknown, paid: unknown, collected: unknown) => {
        const d = num(due), p = num(paid), co = num(collected);
        return (d != null || p != null || co != null) ? { due: d, paid: p, collected: co } : null;
      };
      collectionEvents.push({
        visitId: sid(c.PAT_ENC_CSN_ID ?? (enc as any).PAT_ENC_CSN_ID),
        line: num(c.LINE),
        date: toISODate(c.CONTACT_DATE),
        collectionInstant: toISODateTime(c.COLL_INSTANT_UTC_DTTM),
        workflowType: str(c.COLL_WORKFLOW_TYPE_C_NAME),
        eventType: str(c.EVENT_TYPE_C_NAME),
        pbCopay: mkGroup(c.PB_COPAY_DUE, c.PB_COPAY_PAID, c.PB_COPAY_COLL),
        hbCopay: mkGroup(c.HB_COPAY_DUE, c.HB_COPAY_PAID, c.HB_COPAY_COLL),
        pbPrepay: mkGroup(c.PB_PREPAY_DUE, c.PB_PREPAY_PAID, c.PB_PREPAY_COLL),
        hbPrepay: mkGroup(c.HB_PREPAY_DUE, c.HB_PREPAY_PAID, c.HB_PREPAY_COLL),
        pbPreviousBalance: mkGroup(c.PB_PREV_BAL_DUE, c.PB_PREV_BAL_PAID, c.PB_PREV_BAL_COLL),
        hbPreviousBalance: mkGroup(c.HB_PREV_BAL_DUE, c.HB_PREV_BAL_PAID, c.HB_PREV_BAL_COLL),
        visitBalance: mkGroup(c.VIS_BAL_DUE, c.VIS_BAL_PAID, c.VIS_BAL_COLL),
        prepayDiscountOffered: num(c.PREPAY_DISCOUNT_OFFERED),
        nonCollectionReason: str(c.RSN_NON_COLL_AMT_C_NAME),
        nonCollectionComment: str(c.RSN_NON_COLL_AMT_COMMENT),
        _epic: epic(c),
      });
    }
  }

  // --- Remittances (ERA/835) ---
  const billing = r.billing as any;
  const remittances: RemittanceRecord[] = (billing?.remittances ?? []).map((rem: any): RemittanceRecord => {
    const ci = (rem.claim_info ?? [])[0];
    return {
      id: sid(rem.IMAGE_ID),
      creationDate: toISODate(rem.CREATION_DATE),
      paymentAmount: num(rem.PAYMENT_AMOUNT),
      paymentMethod: str(rem.PAYMENT_METHOD_C_NAME),
      adjudication: ci ? {
        invoiceNumber: str(ci.INV_NO ?? ci.FILE_INV_NUM),
        claimStatus: str(ci.CLM_STAT_CD_C_NAME),
        chargedAmount: num(ci.CLAIM_CHRG_AMT),
        paidAmount: num(ci.CLAIM_PAID_AMT),
        patientResponsibility: num(ci.PAT_RESP_AMT),
        claimControlNumber: str(ci.ICN_NO),
        filingCode: str(ci.CLM_FILING_CODE_C_NAME),
      } : null,
      serviceLines: (rem.service_lines ?? []).map((sl: any): RemittanceServiceLine => ({
        line: num(sl.LINE),
        procedureCode: str(sl.PROC_IDENTIFIER),
        chargedAmount: num(sl.LINE_ITEM_CHG_AMT),
        paidAmount: num(sl.PROV_PAYMENT_AMT),
        unitsPaid: num(sl.UNITS_PAID_CNT),
        revenueCode: str(sl.NUBC_REV_CD),
        chargeTransactionId: str(sl.SVC_LINE_CHG_PB_ID ?? sl.SVC_LINE_CHG_HB_ID),
        _epic: epic(sl),
      })),
      adjustments: (rem.service_level_adjustments ?? []).map((adj: any): RemittanceAdjustment => ({
        line: num(adj.LINE),
        serviceLine: str(adj.CAS_SERVICE_LINE),
        adjustmentGroup: str(adj.SVC_CAS_GRP_CODE_C_NAME),
        reasonCode: str(adj.SVC_ADJ_REASON_CD),
        amount: num(adj.SVC_ADJ_AMT),
        quantity: num(adj.SVC_ADJ_QTY),
        _epic: epic(adj),
      })),
      _epic: epic(rem),
    };
  });

  // --- Claim Reconciliations ---
  const reconciliations: ClaimReconciliationRecord[] = (billing?.reconciliations ?? []).map((rec: any): ClaimReconciliationRecord => {
    // Merge timeline and detail by CONTACT_DATE_REAL for richer events
    const detailByContact = new Map<number, any>();
    for (const d of (rec.status_detail ?? [])) {
      detailByContact.set(d.CONTACT_DATE_REAL, d);
    }

    // Collapse LINE pairs: LINE 1 = status event, LINE 2 = description echo
    // Group by CONTACT_DATE_REAL, take LINE 1 as primary, LINE 2 as description
    const timelineRows = rec.status_timeline ?? [];
    const byContact = new Map<number, any[]>();
    for (const tl of timelineRows) {
      const key = tl.CONTACT_DATE_REAL;
      if (!byContact.has(key)) byContact.set(key, []);
      byContact.get(key)!.push(tl);
    }

    const timeline: ClaimStatusEvent[] = [];
    for (const [contactReal, lines] of byContact) {
      const primary = lines.find((l: any) => l.LINE === 1) ?? lines[0];
      const secondary = lines.find((l: any) => l.LINE === 2);
      const detail = detailByContact.get(contactReal);
      timeline.push({
        date: toISODate(primary.CONTACT_DATE),
        sortKey: contactReal,
        statusCode: str(primary.CLM_STAT_CODE_C_NAME),
        action: str(primary.CLM_MAPPED_ACT_C_NAME),
        message: str(primary.CLM_STATUS_MSG),
        description: secondary ? str(secondary.CLM_STAT_CODE_C_NAME) : null,
        payerAmountSubmitted: num(detail?.PAYR_CLM_AMT_SUBMT ?? primary.CLM_STAT_DATA),
        payerAmountPaid: num(detail?.PAYOR_CLM_AMT_PAID),
        payerCheckDate: toISODate(detail?.PAYER_CHECK_DATE),
        payerCheckNumber: str(detail?.PAYER_CHECK_NUM),
        fileName: str(detail?.FILE_NAME),
        errorMessage: str(detail?.ERR_MSG),
        _epic: epic(primary),
      });
    }
    timeline.sort((a, b) => a.sortKey - b.sortKey);

    return {
      id: sid(rec.CLAIM_REC_ID),
      invoiceNumber: str(rec.CLAIM_INVOICE_NUM),
      currentStatus: str(rec.CUR_EPIC_STATUS_C_NAME),
      claimStatus: str(rec.EPIC_CLM_STS_C_NAME),
      totalBilled: num(rec.TOTAL_BILLED),
      closedDate: toISODate(rec.CLAIM_CLOSED_DATE),
      timeline,
      _epic: epic(rec),
    };
  });

  // --- Invoices ---
  const invoices: InvoiceRecord[] = (billing?.invoices ?? []).map((inv: any): InvoiceRecord => {
    const bi = (inv.basic_info ?? [])[0];  // first basic_info line has the invoice detail
    return {
      id: sid(inv.INVOICE_ID),
      invoiceNumber: str(bi?.INV_NUM),
      status: str(bi?.INV_STATUS_C_NAME),
      type: str(bi?.INV_TYPE_C_NAME),
      insuranceAmount: num(inv.INSURANCE_AMT),
      selfPayAmount: num(inv.SELF_PAY_AMT),
      serviceFromDate: toISODate(bi?.FROM_SVC_DATE),
      serviceToDate: toISODate(bi?.TO_SVC_DATE),
      payerName: str(bi?.MAILING_NAME),
      coverageId: bi?.CVG_ID ? sid(bi.CVG_ID) : null,
      chargeTransactionIds: (inv.tx_pieces ?? []).map((tp: any) => sid(tp.TX_ID)),
      _epic: epic(inv),
    };
  });

  // --- Service Benefits (from coverage) ---
  const serviceBenefits: ServiceBenefitRecord[] = [];
  const coverageArr = (r as any).coverage ?? [];
  for (const cvg of coverageArr) {
    const cvgId = sid(cvg.COVERAGE_ID);
    for (const sb of (cvg.service_benefits ?? [])) {
      serviceBenefits.push({
        coverageId: cvgId,
        serviceType: str(sb.CVG_SVC_TYPE_ID_SERVICE_TYPE_NAME),
        copayAmount: num(sb.COPAY_AMOUNT),
        deductibleAmount: num(sb.DEDUCTIBLE_AMOUNT),
        deductibleMet: num(sb.DEDUCTIBLE_MET_AMT),
        deductibleRemaining: num(sb.DEDUCT_REMAIN_AMT),
        coinsurancePercent: num(sb.COINS_PERCENT),
        outOfPocketMax: num(sb.OUT_OF_POCKET_MAX),
        outOfPocketRemaining: num(sb.OUT_OF_PCKT_REMAIN),
        outOfPocketMet: ynBool(sb.OUT_OF_PCKET_MET_YN),
        inNetwork: ynBool(sb.IN_NETWORK_YN),
        networkLevel: str(sb.NET_LVL_SVC_C_NAME),
        familyTier: str(sb.FAMILY_TIER_SVC_C_NAME),
        maxVisits: num(sb.MAX_VISITS),
        remainingVisits: num(sb.REMAINING_VISITS),
        annualBenefitMax: num(sb.ANNUAL_BEN_MAX_AMT),
        annualBenefitRemaining: num(sb.ANNUAL_BEN_REMAIN),
        lifetimeBenefitMax: num(sb.LIFETIME_BEN_MAX),
        lifetimeBenefitRemaining: num(sb.LIFETIME_BEN_REMAIN),
        _epic: epic(sb),
      });
    }
  }

  return {
    charges, payments, claims, accounts, transactionActions, eobLineItems, collectionEvents,
    remittances, reconciliations, invoices, serviceBenefits,
  };
}

// ─── Goals ─────────────────────────────────────────────────────────────────

function projectGoals(r: R): PatientGoal[] {
  const goals = (r.patient as any).patient_goals_info;
  if (!Array.isArray(goals)) return [];
  return goals.map((g: any): PatientGoal => ({
    id: sid(g.GOAL_ID),
    name: str(g.GOAL_TEMPLATE_ID_GOAL_TEMPLATE_NAME),
    status: str(g.GOAL_STATUS_C_NAME),
    type: str(g.AMB_GOAL_TYPE_C_NAME),
    createdDate: toISODateTime(g.CREATE_INST_DTTM),
    createdBy: str(g.USER_ID_NAME),
    _epic: epic(g),
  }));
}

// ─── Questionnaire Responses ───────────────────────────────────────────────

function projectQuestionnaires(r: R): QuestionnaireResponse[] {
  const answers = (r.patient as any).questionnaire_answers;
  if (!Array.isArray(answers)) return [];
  return answers.map((a: any): QuestionnaireResponse => ({
    formId: sid(a.QUESR_ANS_FORM_ID),
    formName: str(a.QUESR_ANS_FORM_ID_FORM_NAME),
    encounterId: a.QUESR_ANS_CSN_ID ? sid(a.QUESR_ANS_CSN_ID) : null,
    completedDate: toISODateTime(a.QUESR_ANS_DATETIME),
    _epic: epic(a),
  }));
}
