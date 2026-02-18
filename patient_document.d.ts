// ─── Epic EHI Patient Document: TypeScript Domain Model ────────────────────
//
// Design principles:
//   - Structural children nest directly (orders contain results)
//   - Cross-references are typed IDs with accessor methods on the entity that holds them
//   - History snapshots use HistoryTimeline<T> with .latest() and .asOf(csn)
//   - Billing is a parallel hierarchy, cross-referenced to encounters
//   - Methods live on the entity they're most natural to call from
//   - Epic column names preserved as raw data; friendly names on class accessors
//
// Conventions:
//   - Fields ending in _C_NAME are category values (Epic ZC_ table lookups)
//   - Fields ending in _YN are "Y"/"N" strings
//   - All datetimes are strings (Epic format: "9/28/2023 12:00:00 AM")
//   - LINE fields indicate multi-row child records
//   - `record` parameter = the root PatientRecord, for cross-entity lookups

// ─── Shared Types ──────────────────────────────────────────────────────────

/** Any Epic row stored as raw key-value pairs */
type EpicRow = Record<string, string | number | null>;

/** An Epic entity ID — numeric but sometimes stored as string */
type EpicID = string | number;

/** An encounter serial number (CSN) — Epic's universal encounter key */
type CSN = number;

// ─── History Snapshots ─────────────────────────────────────────────────────

/**
 * A point-in-time snapshot of patient history, taken during a clinical encounter.
 *
 * Epic creates a new row in SOCIAL_HX / SURGICAL_HX / FAMILY_HX_STATUS each time
 * a clinician reviews history. Each row has TWO CSNs:
 *   - snapshotCSN: the history record's own contact (it gets its own encounter entry)
 *   - reviewedDuringEncounterCSN: the clinical encounter where it was reviewed
 *
 * Not all snapshots have a reviewedDuringEncounterCSN — some are created by
 * system processes or data imports.
 */
export interface HistorySnapshot<T> {
  snapshotCSN: CSN;
  reviewedDuringEncounterCSN?: CSN;
  contactDate: string;
  data: T;
}

/**
 * A timeline of versioned history snapshots. Sorted chronologically.
 * Provides convenience accessors for current state and state-at-encounter.
 */
export class HistoryTimeline<T> {
  constructor(public readonly snapshots: HistorySnapshot<T>[]) {}

  /** Most recent snapshot = current state */
  latest(): T | undefined {
    return this.snapshots.at(-1)?.data;
  }

  /** The snapshot reviewed during a specific clinical encounter */
  asOfEncounter(csn: CSN): T | undefined {
    return this.snapshots.find(
      (s) => s.reviewedDuringEncounterCSN === csn
    )?.data;
  }

  /** The snapshot closest to (but not after) a given date */
  asOfDate(date: string): T | undefined {
    // snapshots are sorted chronologically
    return [...this.snapshots]
      .reverse()
      .find((s) => s.contactDate <= date)?.data;
  }
}

// ─── Patient Demographics ──────────────────────────────────────────────────

/**
 * Root patient record. Merged from PATIENT + PATIENT_2..6 + PATIENT_MYC at load time.
 * Contains 200+ demographic fields across the split tables.
 */
export class Patient {
  PAT_ID: string;
  PAT_NAME: string;
  PAT_FIRST_NAME?: string;
  PAT_LAST_NAME?: string;
  PAT_MRN_ID?: string;
  BIRTH_DATE?: string;
  SEX_C_NAME?: string;
  GENDER_IDENTITY_C_NAME?: string;
  SEX_ASGN_AT_BIRTH_C_NAME?: string;
  ETHNIC_GROUP_C_NAME?: string;
  PREFERRED_NAME?: string;
  DEATH_DATE?: string;
  HOME_PHONE?: string;
  EMAIL_ADDRESS?: string;
  ADD_LINE_1?: string;
  CITY?: string;
  STATE_C_NAME?: string;
  ZIP?: string;
  INTRP_NEEDED_YN?: string;
  LANGUAGE_C_NAME?: string;

  /** Additional demographic fields from PATIENT_2..6, PATIENT_MYC */
  [key: string]: unknown;
}

// ─── Allergies ─────────────────────────────────────────────────────────────

export interface AllergyReaction extends EpicRow {
  ALLERGY_ID: EpicID;
  LINE: number;
  REACTION_C_NAME: string;
}

/**
 * A patient allergy record.
 *
 * Allergies belong to the patient, not to an encounter. The ALLERGY_PAT_CSN
 * is a provenance stamp — the encounter where this allergy was noted/edited,
 * NOT structural ownership.
 */
export class Allergy {
  ALLERGY_ID: EpicID;
  ALLERGEN_ID?: EpicID;
  allergenName?: string; // from ALLERGEN_ID_ALLERGEN_NAME
  reaction?: string;
  dateNoted?: string;
  severity?: string;    // ALLERGY_SEVERITY_C_NAME
  status?: string;      // ALRGY_STATUS_C_NAME
  certainty?: string;   // ALLERGY_CERTAINTY_C_NAME
  source?: string;      // ALLERGY_SOURCE_C_NAME

  /** Structural children */
  reactions: AllergyReaction[];

  /** Provenance: which encounter was this allergy noted/edited in? */
  notedDuringEncounterCSN?: CSN;

  /** Navigate to the encounter where this allergy was noted */
  notedDuringEncounter(record: PatientRecord): Encounter | undefined {
    if (!this.notedDuringEncounterCSN) return undefined;
    return record.encounterByCSN(this.notedDuringEncounterCSN);
  }

  [key: string]: unknown;
}

// ─── Problems ──────────────────────────────────────────────────────────────

export interface ProblemUpdate extends EpicRow {
  PROBLEM_LIST_ID: EpicID;
  LINE: number;
  EDIT_USER_ID?: EpicID;
  UPDATE_DATE?: string;
  EPT_CSN?: CSN;
}

export class Problem {
  PROBLEM_LIST_ID: EpicID;
  DX_ID?: EpicID;
  diagnosisName?: string;       // resolved from CLARITY_EDG
  dateOfEntry?: string;
  status?: string;              // PROBLEM_STATUS_C_NAME
  priority?: string;            // PRIORITY_C_NAME
  principalProblemYN?: string;
  chronicYN?: string;

  /** Edit history */
  updates: ProblemUpdate[];

  /** Related body systems (PL_SYSTEMS) */
  bodySystems: EpicRow[];

  [key: string]: unknown;
}

// ─── Medications ───────────────────────────────────────────────────────────

export interface MedicationDispenseInfo extends EpicRow {
  ORDER_MED_ID: EpicID;
  FILL_PHR_ID?: EpicID;
  DISP_DATE?: string;
}

export interface MedicationSignature extends EpicRow {
  ORDER_ID: EpicID;
  SIG_TEXT?: string;
}

/**
 * A medication order. Merged from ORDER_MED + ORDER_MED_2..7 at load time.
 *
 * Medications can be ordered during an encounter (PAT_ENC_CSN_ID) or exist
 * as long-term standing orders.
 */
export class Medication {
  ORDER_MED_ID: EpicID;
  DESCRIPTION?: string;
  medicationName?: string;        // from MEDICATION_ID lookup
  HV_DISCR_FREQ_ID?: string;
  HV_DOSE_UNIT_C_NAME?: string;
  SIG?: string;
  QUANTITY?: number;
  REFILLS?: number;
  startDate?: string;
  endDate?: string;
  orderStatus?: string;           // ORDER_STATUS_C_NAME
  orderClass?: string;            // ORDER_CLASS_C_NAME

  /** Encounter where this was ordered */
  orderedDuringEncounterCSN?: CSN;

  /** Structural children */
  dispenseHistory: MedicationDispenseInfo[];
  diagnoses: EpicRow[];           // ORDER_DX_MED
  signatureHistory: MedicationSignature[];
  dosingParams: EpicRow[];        // ORD_DOSING_PARAMS
  statusHistory: EpicRow[];       // ORDER_STATUS

  orderedDuringEncounter(record: PatientRecord): Encounter | undefined {
    if (!this.orderedDuringEncounterCSN) return undefined;
    return record.encounterByCSN(this.orderedDuringEncounterCSN);
  }

  [key: string]: unknown;
}

// ─── Immunizations ─────────────────────────────────────────────────────────

export class Immunization {
  IMMUNE_ID: EpicID;
  immunizationName?: string;
  immunizationDate?: string;
  immunizationStatus?: string;

  /** Administration records (IMM_ADMIN, IMM_ADMIN_COMPONENTS, IMM_ADMIN_GROUPS) */
  administrations: EpicRow[];
  components: EpicRow[];
  groups: EpicRow[];

  /** Due/forecast data (IMM_DUE) */
  dueForecast: EpicRow[];

  /** History (IMMUNE_HISTORY) */
  history: EpicRow[];

  [key: string]: unknown;
}

// ─── History Data Types ────────────────────────────────────────────────────

export interface SocialHistoryData extends EpicRow {
  TOBACCO_USER_C_NAME?: string;
  SMOKING_TOB_USE_C_NAME?: string;
  SMOKELESS_TOB_USE_C_NAME?: string;
  ALCOHOL_USE_C_NAME?: string;
  ILL_DRUG_USER_C_NAME?: string;
  SEXUALLY_ACTIVE_C_NAME?: string;
  IV_DRUG_USER_C_NAME?: string;
}

export interface SurgicalHistoryItem extends EpicRow {
  PROC_ID?: EpicID;
  PROC_NAME?: string;
  SURGERY_DATE?: string;
}

export interface FamilyHistoryItem extends EpicRow {
  FAM_MED_REL_C_NAME?: string;   // relationship (mother, father, etc.)
  MEDICAL_HX_C_NAME?: string;    // condition
}

// ─── Coverage / Insurance ──────────────────────────────────────────────────

export class Coverage {
  COVERAGE_ID: EpicID;
  payorName?: string;
  planName?: string;
  subscriberNumber?: string;
  groupNumber?: string;
  effectiveDate?: string;
  terminationDate?: string;
  financialClass?: string;

  /** Structural children from COVERAGE_2, COVERAGE_3, COVERAGE_MEMBER_LIST, etc. */
  copayInfo: EpicRow[];       // COVERAGE_COPAY_ECD
  members: EpicRow[];         // COVERAGE_MEMBER_LIST
  sponsors: EpicRow[];        // COVERAGE_SPONSOR
  subscriberAddress: EpicRow[];

  /** Which guarantor accounts use this coverage */
  linkedAccounts(record: PatientRecord): GuarantorAccount[] {
    return record.billing.guarantorAccounts.filter((a) =>
      a.coverageIds?.includes(this.COVERAGE_ID)
    );
  }

  [key: string]: unknown;
}

// ─── Referrals ─────────────────────────────────────────────────────────────

export class Referral {
  REFERRAL_ID: EpicID;
  referralType?: string;         // RFL_TYPE_C_NAME
  referralStatus?: string;       // RFL_STATUS_C_NAME
  referralClass?: string;        // RFL_CLASS_C_NAME
  referralDate?: string;
  expirationDate?: string;
  referredToProvider?: string;   // resolved from CLARITY_SER
  referringProvider?: string;

  /** Structural children */
  history: EpicRow[];            // REFERRAL_HIST
  diagnoses: EpicRow[];          // REFERRAL_DX
  procedures: EpicRow[];         // REFERRAL_PX
  notes: EpicRow[];              // REFERRAL_NOTES
  reasons: EpicRow[];            // REFERRAL_REASONS
  appointments: EpicRow[];       // REFERRAL_APT
  coverageAuth: EpicRow[];       // REFERRAL_CVG_AUTH
  coverages: EpicRow[];          // REFERRAL_CVG
  epaInfo: EpicRow[];            // EPA_INFO (prior auth)

  /** The encounter this referral originated from */
  originatingEncounterCSN?: CSN;

  originatingEncounter(record: PatientRecord): Encounter | undefined {
    if (!this.originatingEncounterCSN) return undefined;
    return record.encounterByCSN(this.originatingEncounterCSN);
  }

  [key: string]: unknown;
}

// ─── Orders & Results ──────────────────────────────────────────────────────

export interface OrderResult {
  ORDER_PROC_ID: EpicID;
  LINE: number;
  componentName?: string;     // COMPONENT_ID_NAME
  value?: string;             // ORD_VALUE
  referenceUnit?: string;     // REFERENCE_UNIT
  referenceRange?: string;    // REFERENCE_RANGE (e.g. "0-200")
  resultStatus?: string;      // RESULT_STATUS_C_NAME
  resultFlag?: string;        // RESULT_FLAG_C_NAME (H, L, A, etc.)
  resultDate?: string;
  resultNote?: string;
  [key: string]: unknown;
}

export interface OrderComment extends EpicRow {
  ORDER_PROC_ID: EpicID;
  LINE: number;
  COMMENT_TEXT?: string;
}

/**
 * A procedure/lab/imaging order. Merged from ORDER_PROC + ORDER_PROC_2..6.
 *
 * Key subtlety: lab results may live on CHILD orders, not this order directly.
 * When a provider orders labs during a visit, Epic spawns child orders on a
 * separate lab encounter. ORDER_PARENT_INFO links parent → child.
 * Use allResults() to follow this chain.
 */
export class Order {
  ORDER_PROC_ID: EpicID;
  DESCRIPTION?: string;
  procedureName?: string;       // resolved from CLARITY_EAP
  orderType?: string;           // ORDER_TYPE_C_NAME
  orderStatus?: string;         // ORDER_STATUS_C_NAME
  orderClass?: string;          // ORDER_CLASS_C_NAME
  orderDate?: string;           // ORDER_INST
  resultDate?: string;          // RESULT_DATE
  abnormalYN?: string;

  /** Direct results on this order */
  results: OrderResult[];

  /** Diagnoses linked to this order */
  diagnoses: EpicRow[];

  /** Narrative/impression text */
  narrative: EpicRow[];         // ORDER_NARRATIVE
  impression: EpicRow[];        // ORDER_IMPRESSION

  /** Comments */
  comments: OrderComment[];

  /** Status history */
  statusHistory: EpicRow[];     // ORDER_STATUS

  /** Signed/cosigned info */
  signedInfo: EpicRow[];        // ORDER_SIGNED_PROC

  /** Additional order metadata */
  authInfo: EpicRow[];          // ORDER_AUTH_INFO
  parentInfo: EpicRow[];        // ORDER_PARENT_INFO
  pendingInfo: EpicRow[];       // ORDER_PENDING

  /**
   * All results, following the parent→child order chain.
   *
   * When a lab is ordered during an office visit, the results often land on
   * a child order under a separate lab encounter. This method follows
   * ORDER_PARENT_INFO to find those child results.
   */
  allResults(record: PatientRecord): OrderResult[] {
    if (this.results.length > 0) return this.results;

    // Follow parent → child chain
    return record.orderParentLinks
      .filter((link) => link.PARENT_ORDER_ID === this.ORDER_PROC_ID
        && link.ORDER_ID !== this.ORDER_PROC_ID)
      .flatMap((link) => {
        const childOrder = record.orderByID(link.ORDER_ID);
        return childOrder?.results ?? [];
      });
  }

  [key: string]: unknown;
}

// ─── Notes ─────────────────────────────────────────────────────────────────

export class Note {
  NOTE_ID: EpicID;
  noteType?: string;              // IP_NOTE_TYPE_C_NAME
  noteStatus?: string;            // NOTE_STATUS_C_NAME
  authorName?: string;
  createdDate?: string;           // NOTE_FILE_TIME_DTTM
  contactDate?: string;

  /** Note text (HNO_PLAIN_TEXT) */
  text: EpicRow[];

  /** Encounter link (NOTE_ENC_INFO) — rich metadata about note context */
  encounterInfo: EpicRow[];

  /** Metadata (ABN_FOLLOW_UP) */
  metadata: EpicRow[];

  /** Orders linked to this note */
  linkedOrders: EpicRow[];        // HNO_ORDERS

  /** The encounter this note belongs to (may be null for standalone notes) */
  encounterCSN?: CSN;

  encounter(record: PatientRecord): Encounter | undefined {
    if (!this.encounterCSN) return undefined;
    return record.encounterByCSN(this.encounterCSN);
  }

  [key: string]: unknown;
}

// ─── Encounters ────────────────────────────────────────────────────────────

/**
 * A clinical encounter. Merged from PAT_ENC + PAT_ENC_2..7 at load time.
 *
 * This is the central clinical entity. Orders, notes, diagnoses, and treatments
 * nest structurally inside it. Billing, history snapshots, and messages
 * cross-reference it.
 */
export class Encounter {
  PAT_ENC_CSN_ID: CSN;
  PAT_ID: string;
  contactDate?: string;
  encounterType?: string;           // ENC_TYPE_C_NAME
  visitType?: string;               // APPT_PRC_ID lookup
  visitProviderName?: string;       // resolved from CLARITY_SER
  departmentName?: string;          // resolved from CLARITY_DEP
  closedYN?: string;
  encStatus?: string;

  // ── Structural children ──────────────────────────────────────

  diagnoses: EpicRow[];             // PAT_ENC_DX
  reasonsForVisit: EpicRow[];       // PAT_ENC_RSN_VISIT
  orders: Order[];                  // ORDER_PROC (with nested results)
  notes: Note[];                    // HNO_INFO (with nested text)
  treatments: EpicRow[];            // TREATMENT
  treatmentTeam: EpicRow[];         // TREATMENT_TEAM
  currentMedsSnapshot: EpicRow[];   // PAT_ENC_CURR_MEDS
  discontinuedMeds: EpicRow[];      // DISCONTINUED_MEDS
  addenda: EpicRow[];               // PAT_ADDENDUM_INFO
  attachedDocuments: EpicRow[];     // PAT_ENC_DOCS
  questionnaires: EpicRow[];        // KIOSK_QUESTIONNAIR
  eligibilityHistory: EpicRow[];    // PAT_ENC_ELIG_HISTORY
  pharmacyCoverage: EpicRow[];      // EXT_PHARM_TYPE_COVERED

  /** Appointment details (PAT_ENC_APPT) */
  appointment?: EpicRow;

  /** Disposition (PAT_ENC_DISP) */
  disposition?: EpicRow;

  /** Inpatient data (IP_DATA_STORE) */
  inpatientData?: EpicRow;

  /** Hospital encounter data (PAT_ENC_HSP) */
  hospitalEncounter?: EpicRow;

  // ── Flowsheets (vital signs, nursing assessments) ──────────

  flowsheetRows: EpicRow[];         // IP_FLOWSHEET_ROWS
  flowsheetMeasurements: EpicRow[]; // IP_FLWSHT_MEAS

  // ── History reviews done during this encounter ─────────────

  historyReviews: EpicRow[];        // PAT_HX_REVIEW

  // ── Cross-references ─────────────────────────────────────────

  /**
   * Find the billing visit for this encounter.
   * ARPB_VISITS.PRIM_ENC_CSN_ID → this encounter.
   */
  billingVisit(record: PatientRecord): BillingVisit | undefined {
    return record.billing.visits.find(
      (v) => v.PRIM_ENC_CSN_ID === this.PAT_ENC_CSN_ID
    );
  }

  /**
   * Find hospital account(s) for this encounter.
   * HAR_ALL.PRIM_ENC_CSN_ID → this encounter.
   */
  hospitalAccounts(record: PatientRecord): HospitalAccount[] {
    return record.billing.hospitalAccounts.filter(
      (h) => h.PRIM_ENC_CSN_ID === this.PAT_ENC_CSN_ID
    );
  }

  /**
   * Social history snapshot taken during this encounter.
   */
  socialHistory(record: PatientRecord): SocialHistoryData | undefined {
    return record.socialHistory.asOfEncounter(this.PAT_ENC_CSN_ID);
  }

  /**
   * Messages linked to this encounter via PAT_MYC_MESG bridge.
   */
  linkedMessages(record: PatientRecord): Message[] {
    const linkedMessageIds = record.encounterMessageLinks
      .filter((link) => link.PAT_ENC_CSN_ID === this.PAT_ENC_CSN_ID)
      .map((link) => link.MESSAGE_ID);
    return record.messages.filter((m) =>
      linkedMessageIds.includes(m.MESSAGE_ID)
    );
  }

  /**
   * Referrals originating from this encounter.
   */
  referrals(record: PatientRecord): Referral[] {
    return record.referrals.filter(
      (r) => r.originatingEncounterCSN === this.PAT_ENC_CSN_ID
    );
  }

  [key: string]: unknown;
}

// ─── Billing ───────────────────────────────────────────────────────────────

/**
 * A professional billing transaction. Merged from ARPB_TRANSACTIONS + 2 + 3.
 *
 * This is a charge, payment, adjustment, or other financial event on a
 * guarantor account. Links to encounters via the visit, not directly.
 */
export class BillingTransaction {
  TX_ID: EpicID;
  TX_TYPE_C_NAME?: string;
  AMOUNT?: number;
  PROCEDURE_ID?: EpicID;
  procedureName?: string;          // resolved from CLARITY_EAP
  POST_DATE?: string;
  SERVICE_DATE?: string;
  PATIENT_ID?: string;
  VISIT_NUMBER?: EpicID;
  ACCOUNT_ID?: EpicID;

  /** Structural children */
  actions: EpicRow[];              // ARPB_TX_ACTIONS
  chargeDiagnoses: EpicRow[];      // ARPB_CHG_ENTRY_DX + TX_DIAG
  matchHistory: EpicRow[];         // ARPB_TX_MATCH_HX
  chargeRevisionHistory: EpicRow[]; // ARPB_TX_CHG_REV_HX
  statementClaimHistory: EpicRow[]; // ARPB_TX_STMCLAIMHX
  eobInfo: EpicRow[];              // PMT_EOB_INFO_I + PMT_EOB_INFO_II
  modifiers: EpicRow[];            // ARPB_TX_MODIFIERS
  authInfo: EpicRow[];             // ARPB_AUTH_INFO
  moderate: EpicRow[];             // ARPB_TX_MODERATE

  /** Navigate to the guarantor account */
  guarantorAccount(record: PatientRecord): GuarantorAccount | undefined {
    if (!this.ACCOUNT_ID) return undefined;
    return record.billing.guarantorAccounts.find(
      (a) => a.ACCOUNT_ID === this.ACCOUNT_ID
    );
  }

  [key: string]: unknown;
}

/**
 * A billing visit — the financial view of a clinical encounter.
 * One billing visit maps to one clinical encounter via PRIM_ENC_CSN_ID.
 */
export class BillingVisit {
  PB_VISIT_ID?: EpicID;
  PRIM_ENC_CSN_ID?: CSN;
  PB_TOTAL_CHARGES?: number;
  PB_TOTAL_PAYMENTS?: number;
  PB_TOTAL_ADJUSTMENTS?: number;
  PB_BALANCE?: number;

  /** Navigate to the clinical encounter */
  encounter(record: PatientRecord): Encounter | undefined {
    if (!this.PRIM_ENC_CSN_ID) return undefined;
    return record.encounterByCSN(this.PRIM_ENC_CSN_ID);
  }

  /** Transactions associated with this visit */
  transactions(record: PatientRecord): BillingTransaction[] {
    return record.billing.transactions.filter(
      (tx) => tx.VISIT_NUMBER === this.PB_VISIT_ID
    );
  }

  [key: string]: unknown;
}

/** Guarantor account. Merged from ACCOUNT + ACCOUNT_2 + ACCOUNT_3. */
export class GuarantorAccount {
  ACCOUNT_ID: EpicID;
  guarantorName?: string;
  balanceDue?: number;
  lastStatementDate?: string;
  coverageIds?: EpicID[];

  /** Structural children */
  contacts: EpicRow[];            // ACCOUNT_CONTACT
  coverageLinks: EpicRow[];       // ACCT_COVERAGE
  transactionLinks: EpicRow[];    // ACCT_TX
  addressHistory: EpicRow[];      // ACCT_ADDR, GUAR_ADDR_HX
  creationInfo: EpicRow[];        // ACCOUNT_CREATION
  statementHistory: EpicRow[];    // GUAR_ACCT_STMT_HX
  paymentScore: EpicRow[];        // GUAR_PMT_SCORE_PB_HX

  [key: string]: unknown;
}

/** Hospital account. Merged from HSP_ACCOUNT + HSP_ACCOUNT_2..4. */
export class HospitalAccount {
  HSP_ACCOUNT_ID: EpicID;
  PRIM_ENC_CSN_ID?: CSN;
  admissionDate?: string;
  dischargeDate?: string;
  totalCharges?: number;
  totalPayments?: number;

  /** Structural children */
  coverageList: EpicRow[];         // HSP_ACCT_CVG_LIST
  diagnoses: EpicRow[];            // HSP_ACCT_DX_LIST
  procedures: EpicRow[];           // HSP_ADMIT_PROC
  transactions: EpicRow[];         // HSP_TRANSACTIONS (with HSP_TRANSACTIONS_2..3)
  buckets: HospitalBucket[];
  claimPrints: EpicRow[];          // HSP_CLAIM_PRINT
  proration: EpicRow[];            // HSP_ACCT_PRORATION
  otherProviders: EpicRow[];       // HSP_ACCT_OTHR_PROV

  encounter(record: PatientRecord): Encounter | undefined {
    if (!this.PRIM_ENC_CSN_ID) return undefined;
    return record.encounterByCSN(this.PRIM_ENC_CSN_ID);
  }

  [key: string]: unknown;
}

/** A billing bucket within a hospital account */
export interface HospitalBucket {
  BUCKET_ID: EpicID;
  HSP_ACCOUNT_ID: EpicID;
  payments: EpicRow[];             // HSP_BKT_PAYMENT
  adjustments: EpicRow[];          // HSP_BKT_ADJ_TXS
  adjustmentHistory: EpicRow[];    // HSP_BKT_NAA_ADJ_HX
  additionalInfo: EpicRow[];       // HSP_BKT_ADDTL_REC
  invoiceNumbers: EpicRow[];       // HSP_BKT_INV_NUM
}

/** A remittance advice. */
export class Remittance {
  IMAGE_ID: EpicID;
  remitDate?: string;
  payorName?: string;

  /** Structural children */
  serviceLines: EpicRow[];         // CL_RMT_SVCE_LN_INF
  claimInfo: EpicRow[];            // CL_RMT_CLM_INFO
  claimEntities: EpicRow[];        // CL_RMT_CLM_ENTITY
  providerSummary: EpicRow[];      // CL_RMT_PRV_SUM_INF
  providerSupplemental: EpicRow[]; // CL_RMT_PRV_SUP_INF
  adjustments: EpicRow[];          // CL_RMT_INP_ADJ_INF + CL_RMT_OPT_ADJ_INF
  serviceLevelAdjustments: EpicRow[]; // CL_RMT_SVC_LVL_ADJ
  serviceLevelRefs: EpicRow[];     // CL_RMT_SVC_LVL_REF
  serviceAmounts: EpicRow[];       // CL_RMT_SVC_AMT_INF
  serviceDates: EpicRow[];         // CL_RMT_SVC_DAT_INF
  deliveryMethods: EpicRow[];      // CL_RMT_DELIVER_MTD
  remarkCodes: EpicRow[];          // CL_RMT_HC_RMK_CODE

  [key: string]: unknown;
}

/** A claim. Merged from CLM_VALUES + CLM_VALUES_2..5. */
export class Claim {
  CLAIM_ID?: EpicID;
  RECORD_ID: EpicID;
  claimStatus?: string;
  claimFromDate?: string;
  claimToDate?: string;

  /** Structural children */
  serviceLines: EpicRow[];         // SVC_LN_INFO (+ SVC_LN_INFO_2..3)
  diagnoses: EpicRow[];            // CLM_DX
  otherDiagnoses: EpicRow[];       // CLM_OTHER_DXS
  notes: EpicRow[];                // CLM_NOTE
  valueRecord: EpicRow[];          // CLM_VALUE_RECORD
  reconciliation: EpicRow[];       // RECONCILE_CLAIM_STATUS

  [key: string]: unknown;
}

/** An invoice. */
export class Invoice {
  INVOICE_ID: EpicID;
  PAT_ID?: string;
  ACCOUNT_ID?: EpicID;
  invoiceDate?: string;

  /** Structural children */
  basicInfo: EpicRow[];            // INV_BASIC_INFO
  transactionPieces: EpicRow[];    // INV_TX_PIECES + INV_NUM_TX_PIECES
  claimLineInfo: EpicRow[];        // INV_CLM_LN_ADDL
  diagnoses: EpicRow[];            // INV_DX_INFO
  paymentRecoup: EpicRow[];        // INV_PMT_RECOUP

  [key: string]: unknown;
}

/** The complete billing tree */
export interface BillingRecord {
  transactions: BillingTransaction[];
  visits: BillingVisit[];
  hospitalAccounts: HospitalAccount[];
  guarantorAccounts: GuarantorAccount[];
  claims: Claim[];
  remittances: Remittance[];
  invoices: Invoice[];
}

// ─── Messages ──────────────────────────────────────────────────────────────

/**
 * A MyChart message. Messages live in conversation threads (MYC_CONVO).
 * They cross-reference encounters via PAT_MYC_MESG bridge table.
 */
export class Message {
  MESSAGE_ID: EpicID;
  messageType?: string;           // MSG_TYPE_C_NAME
  senderName?: string;
  createdDate?: string;
  status?: string;

  /** Message text (MSG_TXT) */
  text: EpicRow[];

  /** Conversation thread info */
  threadId?: EpicID;

  /** Child messages in this thread */
  childMessageIds: EpicID[];      // MYC_MESG_CHILD

  /** Navigate to encounters this message is linked to */
  linkedEncounters(record: PatientRecord): Encounter[] {
    return record.encounterMessageLinks
      .filter((link) => link.MESSAGE_ID === this.MESSAGE_ID)
      .map((link) => record.encounterByCSN(link.PAT_ENC_CSN_ID))
      .filter((e): e is Encounter => e !== undefined);
  }

  [key: string]: unknown;
}

/** A conversation thread (MYC_CONVO) grouping multiple messages */
export class ConversationThread {
  THREAD_ID: EpicID;
  PAT_ID?: string;
  status?: string;

  /** Messages in this thread */
  messages: EpicRow[];            // MYC_CONVO_MSGS
  viewers: EpicRow[];             // MYC_CONVO_VIEWERS
  users: EpicRow[];               // MYC_CONVO_USERS
  encounterLinks: EpicRow[];      // MYC_CONVO_ENCS
  audience: EpicRow[];            // MYC_CONVO_AUDIENCE

  [key: string]: unknown;
}

// ─── Documents ─────────────────────────────────────────────────────────────

export class Document {
  DOC_INFO_ID: EpicID;
  documentType?: string;
  documentStatus?: string;
  createdDate?: string;
  documentName?: string;

  /** Structural children */
  linkedPatients: EpicRow[];       // DOC_LINKED_PATS
  dicomInfo: EpicRow[];            // DOC_INFO_DICOM
  csnRefs: EpicRow[];              // DOC_CSN_REFS
  receivedAllergies: EpicRow[];    // DOCS_RCVD_ALGS
  receivedAssessments: EpicRow[];  // DOCS_RCVD_ASMT
  receivedProcedures: EpicRow[];   // DOCS_RCVD_PROC

  [key: string]: unknown;
}

// ─── Episodes ──────────────────────────────────────────────────────────────

/**
 * An episode of care (pregnancy, care management enrollment, etc.).
 * Merged from EPISODE + EPISODE_2.
 */
export class Episode {
  EPISODE_ID: EpicID;
  episodeType?: string;
  episodeStatus?: string;
  startDate?: string;
  endDate?: string;

  /** Structural children */
  carePlans: EpicRow[];            // CAREPLAN_INFO
  enrollments: EpicRow[];          // CAREPLAN_ENROLLMENT_INFO
  contacts: EpicRow[];             // CAREPLAN_CNCT_INFO
  tasks: EpicRow[];                // CAREPLAN_PT_TASK_INFO

  [key: string]: unknown;
}

// ─── Root Patient Record ───────────────────────────────────────────────────

/**
 * The complete patient record. This is the root of the object graph.
 *
 * Design: entities that are structurally owned nest directly. Entities that
 * cross-reference other entities provide accessor methods that take `this`
 * as the record parameter. Index maps are built once for O(1) lookups.
 */
export class PatientRecord {
  patient: Patient;

  // ── Patient-level collections (structurally owned) ───────────
  allergies: Allergy[];
  problems: Problem[];
  medications: Medication[];
  immunizations: Immunization[];
  coverage: Coverage[];
  referrals: Referral[];

  // ── Versioned history timelines ──────────────────────────────
  socialHistory: HistoryTimeline<SocialHistoryData>;
  surgicalHistory: HistoryTimeline<SurgicalHistoryItem[]>;
  familyHistory: HistoryTimeline<FamilyHistoryItem[]>;

  // ── Clinical encounters ──────────────────────────────────────
  encounters: Encounter[];

  // ── Parallel billing hierarchy ───────────────────────────────
  billing: BillingRecord;

  // ── Messaging ────────────────────────────────────────────────
  messages: Message[];
  conversationThreads: ConversationThread[];

  // ── Documents ────────────────────────────────────────────────
  documents: Document[];

  // ── Episodes ─────────────────────────────────────────────────
  episodes: Episode[];

  // ── Bridge tables (for cross-reference navigation) ───────────

  /** PAT_MYC_MESG: encounter ↔ message bridge */
  encounterMessageLinks: Array<{
    PAT_ENC_CSN_ID: CSN;
    MESSAGE_ID: EpicID;
  }>;

  /** ORDER_PARENT_INFO: parent order → child order links */
  orderParentLinks: Array<{
    ORDER_ID: EpicID;
    PARENT_ORDER_ID: EpicID;
    PAT_ENC_CSN_ID?: CSN;
  }>;

  // ── Index maps (built once at construction) ──────────────────

  private _encountersByCSN: Map<CSN, Encounter>;
  private _ordersByID: Map<EpicID, Order>;
  private _notesByID: Map<EpicID, Note>;

  constructor(data: Partial<PatientRecord>) {
    Object.assign(this, data);
    this._encountersByCSN = new Map(
      this.encounters?.map((e) => [e.PAT_ENC_CSN_ID, e])
    );
    this._ordersByID = new Map(
      this.encounters?.flatMap((e) =>
        e.orders.map((o) => [o.ORDER_PROC_ID, o])
      )
    );
    this._notesByID = new Map(
      this.encounters?.flatMap((e) =>
        e.notes.map((n) => [n.NOTE_ID, n])
      )
    );
  }

  // ── Lookup methods (used by entity accessor methods) ─────────

  encounterByCSN(csn: CSN): Encounter | undefined {
    return this._encountersByCSN.get(csn);
  }

  orderByID(id: EpicID): Order | undefined {
    return this._ordersByID.get(id);
  }

  noteByID(id: EpicID): Note | undefined {
    return this._notesByID.get(id);
  }

  // ── Convenience: all encounters sorted by date ───────────────

  encountersChronological(): Encounter[] {
    return [...this.encounters].sort((a, b) =>
      (a.contactDate ?? "").localeCompare(b.contactDate ?? "")
    );
  }

  // ── Convenience: all active medications ──────────────────────

  activeMedications(): Medication[] {
    return this.medications.filter(
      (m) => m.orderStatus !== "Discontinued" && m.orderStatus !== "Completed"
    );
  }

  // ── Convenience: all active problems ─────────────────────────

  activeProblems(): Problem[] {
    return this.problems.filter((p) => p.status !== "Deleted" && p.status !== "Resolved");
  }
}
