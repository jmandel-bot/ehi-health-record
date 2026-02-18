/**
 * project.ts — Bun + native SQLite projector for Epic EHI → PatientRecord
 *
 * Usage:
 *   bun run project.ts [--db path/to/ehi_clean.db] [--out patient.json]
 *
 * Architecture & methodology: see docs/
 *   docs/data-model.md        — Epic EHI structure, relationship types, CSN semantics
 *   docs/mapping-philosophy.md — Design principles (nesting, FKs, fallback)
 *   docs/extending.md          — How to wire new tables
 *   docs/testing.md            — 4-level test strategy
 *   docs/field-naming.md       — Epic column suffix conventions
 *   docs/column-safety.md      — Zero-mismatch guarantee approach
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * IMPLEMENTATION NOTES (see docs/ for full methodology)
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Epic's EHI export is a flat dump of the
 * Clarity/Caboodle reporting database. A single patient's export contains
 * 500-600 TSV files, each representing one database table. There are no
 * foreign key constraints in the export — relationships are implicit.
 *
 * Key concepts (details in docs/):
 * - Tables are split (_2, _3 suffixes) with inconsistent PK names → split_config.json
 * - Three relationship types: structural child, cross-reference, provenance stamp
 * - CSN = Contact Serial Number, the encounter identifier
 * - Orders have parent→child chains (e.g., lab panel → individual tests)
 * - Billing is a parallel hierarchy, not nested under clinical encounters
 * - History tables (SOCIAL_HX, FAMILY_HX) are versioned snapshots
 * - CLARITY_* tables are shared dimension/lookup tables
 *
 * Implementation approach:
 * - ChildSpec[] arrays declare structural children per entity
 * - Bridge tables (PAT_ALLERGIES, HAR_ALL, etc.) link patient to entities
 * - Every top-level query traces back to PAT_ID
 * - tableExists() guard on every query for graceful degradation
 */

import { Database } from "bun:sqlite";
import { loadPatientRecord, type EpicRow, type CSN, type EpicID } from "./PatientRecord";
import splitConfig from "./split_config.json";

// ─── Config ────────────────────────────────────────────────────────────────

const DB_PATH = process.argv.includes("--db")
  ? process.argv[process.argv.indexOf("--db") + 1]
  : "ehi_clean.db";

const OUT_PATH = process.argv.includes("--out")
  ? process.argv[process.argv.indexOf("--out") + 1]
  : "patient_record.json";

const db = new Database(DB_PATH, { readonly: true });

// ─── Helpers ───────────────────────────────────────────────────────────────

function tableExists(name: string): boolean {
  const r = db.query("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name);
  return r !== null;
}

function q(sql: string, params: unknown[] = []): EpicRow[] {
  return db.query(sql).all(...params) as EpicRow[];
}

function qOne(sql: string, params: unknown[] = []): EpicRow | null {
  return db.query(sql).get(...params) as EpicRow | null;
}

/**
 * Query a base table merged with its split tables.
 * E.g. mergeQuery("PATIENT") → SELECT * from PATIENT LEFT JOIN PATIENT_2..6
 */
/**
 * For split tables where the base PK differs from the split FK
 * (e.g. PAT_ENC base PK is PAT_ID but splits join on PAT_ENC_CSN_ID),
 * we need to find a common column. This map overrides the join column
 * used on the BASE side of the join.
 */
const baseJoinOverrides: Record<string, string> = {
  // PAT_ENC: base PK is PAT_ID (multi-row), splits key on CSN
  PAT_ENC: "PAT_ENC_CSN_ID",
  // PAT_ENC_3 uses PAT_ENC_CSN (without _ID) - handled per-member below
};

function mergeQuery(baseTable: string, where?: string, params: unknown[] = []): EpicRow[] {
  if (!tableExists(baseTable)) return [];

  const config = (splitConfig as Record<string, { base_pk: string; members: Array<{ table: string; join_col: string }> }>)[baseTable];
  if (!config) {
    const w = where ? ` WHERE ${where}` : "";
    return q(`SELECT * FROM "${baseTable}"${w}`, params);
  }

  const baseJoinCol = baseJoinOverrides[baseTable] ?? config.base_pk;
  const baseCols = new Set(
    q(`PRAGMA table_info("${baseTable}")`).map((r) => r.name as string)
  );

  let sql = `SELECT b.*`;
  const joins: string[] = [];

  for (const member of config.members) {
    if (!tableExists(member.table)) continue;
    const alias = member.table.replace(/[^a-zA-Z0-9]/g, "_");
    const splitCols = q(`PRAGMA table_info("${member.table}")`)
      .map((r) => r.name as string)
      .filter((c) => c !== member.join_col && !baseCols.has(c));

    for (const col of splitCols) {
      sql += `, "${alias}"."${col}"`;
    }

    // Find what column on the base side matches this split's join_col
    // Default: use baseJoinCol. But if the split uses a slightly different
    // name (e.g. PAT_ENC_CSN vs PAT_ENC_CSN_ID), find best match.
    let baseCol = baseJoinCol;
    if (!baseCols.has(baseCol)) {
      // Fallback to base PK
      baseCol = config.base_pk;
    }
    // Special case: PAT_ENC_3 joins on PAT_ENC_CSN (no _ID suffix)
    // The base table has PAT_ENC_CSN_ID, so join on that
    if (member.join_col === "PAT_ENC_CSN" && baseCols.has("PAT_ENC_CSN_ID")) {
      baseCol = "PAT_ENC_CSN_ID";
    }

    joins.push(
      `LEFT JOIN "${member.table}" "${alias}" ON b."${baseCol}" = "${alias}"."${member.join_col}"`
    );
    // Track all cols to avoid dups
    for (const col of splitCols) baseCols.add(col);
  }

  sql += ` FROM "${baseTable}" b ${joins.join(" ")}`;
  if (where) sql += ` WHERE ${where}`;
  return q(sql, params);
}

/**
 * Get structural children from a child table, keyed on parent FK.
 */
function children(table: string, fkCol: string, parentId: unknown): EpicRow[] {
  if (!tableExists(table)) return [];
  return q(`SELECT * FROM "${table}" WHERE "${fkCol}" = ?`, [parentId]);
}

/**
 * Get children with merged splits.
 */
function childrenMerged(table: string, fkCol: string, parentId: unknown): EpicRow[] {
  return mergeQuery(table, `b."${fkCol}" = ?`, [parentId]);
}

/**
 * Resolve a lookup value from a CLARITY_* table.
 */
const lookupCache = new Map<string, Map<unknown, EpicRow>>();
function lookup(table: string, pkCol: string, id: unknown): EpicRow | null {
  if (id == null) return null;
  if (!lookupCache.has(table)) {
    if (!tableExists(table)) {
      lookupCache.set(table, new Map());
    } else {
      const rows = q(`SELECT * FROM "${table}"`);
      const map = new Map<unknown, EpicRow>();
      for (const row of rows) map.set(row[pkCol], row);
      lookupCache.set(table, map);
    }
  }
  return lookupCache.get(table)!.get(id) ?? null;
}

function lookupName(table: string, pkCol: string, nameCol: string, id: unknown): string | null {
  return (lookup(table, pkCol, id)?.[nameCol] as string) ?? null;
}

// ─── Child table registry ──────────────────────────────────────────────────
// Systematic attachment: for each parent entity type, list all child tables
// with their FK column. This is how we go from 34 → 100+ tables.

interface ChildSpec {
  table: string;
  fkCol: string;
  key: string;        // property name on the parent
  merged?: boolean;   // whether to use mergeQuery
}

const encounterChildren: ChildSpec[] = [
  { table: "PAT_ENC_DX", fkCol: "PAT_ENC_CSN_ID", key: "diagnoses" },
  { table: "PAT_ENC_RSN_VISIT", fkCol: "PAT_ENC_CSN_ID", key: "reasons_for_visit" },
  { table: "TREATMENT", fkCol: "PAT_ENC_CSN_ID", key: "treatments" },
  { table: "TREATMENT_TEAM", fkCol: "PAT_ENC_CSN_ID", key: "treatment_team" },
  { table: "PAT_ENC_CURR_MEDS", fkCol: "PAT_ENC_CSN_ID", key: "current_meds_snapshot" },
  { table: "DISCONTINUED_MEDS", fkCol: "PAT_ENC_CSN_ID", key: "discontinued_meds" },
  { table: "PAT_ADDENDUM_INFO", fkCol: "PAT_ENC_CSN_ID", key: "addenda" },
  { table: "PAT_ENC_DOCS", fkCol: "PAT_ENC_CSN_ID", key: "attached_documents" },
  { table: "ECHKIN_STEP_INFO", fkCol: "PAT_ENC_CSN_ID", key: "echeckin" },
  { table: "PAT_ENC_LOS_DX", fkCol: "PAT_ENC_CSN_ID", key: "los_diagnoses" },
  { table: "PAT_MYC_MESG", fkCol: "PAT_ENC_CSN_ID", key: "mychart_message_links" },
  { table: "EXT_PHARM_TYPE_COVERED", fkCol: "PAT_ENC_CSN_ID", key: "pharmacy_coverage" },
  { table: "PAT_ENC_ELIG_HISTORY", fkCol: "PAT_ENC_CSN_ID", key: "eligibility_history" },
  // New: expand coverage
  { table: "KIOSK_QUESTIONNAIR", fkCol: "PAT_ENC_CSN_ID", key: "questionnaires" },
  { table: "MYC_APPT_QNR_DATA", fkCol: "PAT_ENC_CSN_ID", key: "mychart_questionnaires" },
  { table: "PAT_ENC_THREADS", fkCol: "PAT_ENC_CSN_ID", key: "threads" },
  { table: "FRONT_END_PMT_COLL_HX", fkCol: "PAT_ENC_CSN_ID", key: "copay_collection" },
  { table: "PAT_REVIEW_DATA", fkCol: "PAT_ENC_CSN_ID", key: "review_data" },
  { table: "ASSOCIATED_REFERRALS", fkCol: "PAT_ENC_CSN_ID", key: "associated_referrals" },
  { table: "PAT_HX_REVIEW", fkCol: "PAT_ENC_CSN_ID", key: "history_reviews" },
  { table: "PAT_HX_REV_TOPIC", fkCol: "PAT_ENC_CSN_ID", key: "history_review_topics" },
  { table: "PAT_HX_REV_TYPE", fkCol: "PAT_ENC_CSN_ID", key: "history_review_types" },
  { table: "PAT_REVIEW_ALLERGI", fkCol: "PAT_ENC_CSN_ID", key: "allergy_reviews" },
  { table: "PAT_REVIEW_PROBLEM", fkCol: "PAT_ENC_CSN_ID", key: "problem_reviews" },
  { table: "PAT_ENC_BILLING_ENC", fkCol: "PAT_ENC_CSN_ID", key: "billing_encounter" },
  { table: "PATIENT_ENC_VIDEO_VISIT", fkCol: "PAT_ENC_CSN_ID", key: "video_visit" },
  { table: "PAT_ENC_SEL_PHARMACIES", fkCol: "PAT_ENC_CSN_ID", key: "selected_pharmacies" },
  { table: "SOCIAL_ADL_HX", fkCol: "PAT_ENC_CSN_ID", key: "adl_history" },
  { table: "FAMILY_HX", fkCol: "PAT_ENC_CSN_ID", key: "family_history_detail" },
  { table: "MEDICAL_HX", fkCol: "PAT_ENC_CSN_ID", key: "medical_history" },
  { table: "PAT_SOCIAL_HX_DOC", fkCol: "PAT_ENC_CSN_ID", key: "social_history_docs" },
  { table: "AN_RELINK_INFO", fkCol: "PAT_ENC_CSN_ID", key: "relink_info" },
  { table: "PAT_ENC_LETTERS", fkCol: "PAT_ENC_CSN_ID", key: "letters" },
  { table: "APPT_LETTER_RECIPIENTS", fkCol: "PAT_ENC_CSN_ID", key: "letter_recipients" },
  { table: "MED_PEND_APRV_STAT", fkCol: "PAT_ENC_CSN_ID", key: "med_pending_approval" },
  { table: "RESULT_FOLLOW_UP", fkCol: "PAT_ENC_CSN_ID", key: "result_follow_up" },
  { table: "PAT_UCN_CONVERT", fkCol: "PAT_ENC_CSN_ID", key: "ucn_converts" },
  { table: "ED_PAT_STATUS", fkCol: "PAT_ENC_CSN_ID", key: "ed_status_history" },
  { table: "ADDITIONAL_EM_CODE", fkCol: "PAT_ENC_CSN_ID", key: "additional_em_codes" },
  { table: "PAT_CANCEL_PROC", fkCol: "PAT_ENC_CSN_ID", key: "cancelled_procedures" },
  { table: "PAT_ENC_ADMIT_DX_AUDIT", fkCol: "PAT_ENC_CSN_ID", key: "admit_dx_audit" },
  { table: "PAT_ENC_QNRS_ANS", fkCol: "PAT_ENC_CSN_ID", key: "questionnaire_answers" },
  { table: "PAT_HM_LETTER", fkCol: "PAT_ENC_CSN_ID", key: "health_maintenance_letters" },
  // Encounter metadata extensions (111-row tables, one per encounter)
  { table: "HOMUNCULUS_PAT_DATA", fkCol: "PAT_ENC_CSN_ID", key: "body_diagram_data" },
  { table: "OPH_EXAM_DATA", fkCol: "PAT_ENC_CSN_ID", key: "ophthalmology_exam" },
  { table: "PAT_CR_TX_SINGLE", fkCol: "PAT_ENC_CSN_ID", key: "credit_card_tx" },
  { table: "PAT_ENC_CALL_DATA", fkCol: "PAT_ENC_CSN_ID", key: "call_data" },
  { table: "PAT_ENC_CC_AUTO_CHG", fkCol: "PAT_ENC_CSN_ID", key: "auto_charge" },
  { table: "PAT_ENC_PAS", fkCol: "PAT_ENC_CSN_ID", key: "pre_anesthesia" },
  { table: "PAT_UTILIZATION_REVIEW", fkCol: "PAT_ENC_CSN_ID", key: "utilization_review" },
  // Encounter-level family/admission data
  { table: "FAM_HX_PAT_ONLY", fkCol: "PAT_ENC_CSN_ID", key: "family_hx_patient_only" },
  { table: "HSP_ATND_PROV", fkCol: "PAT_ENC_CSN_ID", key: "attending_providers" },
  { table: "HSP_ADMIT_DIAG", fkCol: "PAT_ENC_CSN_ID", key: "admit_diagnoses" },
  { table: "HSP_ADMIT_PROC", fkCol: "PAT_ENC_CSN_ID", key: "admit_procedures" },
  // ADT (admit/discharge/transfer) events
  { table: "CLARITY_ADT", fkCol: "PAT_ENC_CSN_ID", key: "adt_events" },
];

const orderChildren: ChildSpec[] = [
  { table: "ORDER_RESULTS", fkCol: "ORDER_PROC_ID", key: "results" },
  { table: "ORDER_DX_PROC", fkCol: "ORDER_PROC_ID", key: "diagnoses" },
  { table: "ORDER_COMMENT", fkCol: "ORDER_PROC_ID", key: "comments" },
  { table: "ORDER_NARRATIVE", fkCol: "ORDER_PROC_ID", key: "narrative" },
  { table: "ORDER_IMPRESSION", fkCol: "ORDER_PROC_ID", key: "impression" },
  { table: "ORDER_SIGNED_PROC", fkCol: "ORDER_PROC_ID", key: "signed_info" },
  { table: "ORDER_RAD_ACC_NUM", fkCol: "ORDER_PROC_ID", key: "accession_numbers" },
  { table: "ORDER_RAD_READING", fkCol: "ORDER_PROC_ID", key: "rad_readings" },
  { table: "ORDER_MYC_INFO", fkCol: "ORDER_PROC_ID", key: "mychart_info" },
  { table: "ORDER_MYC_RELEASE", fkCol: "ORDER_PROC_ID", key: "mychart_release" },
  { table: "HV_ORDER_PROC", fkCol: "ORDER_PROC_ID", key: "hv_order_info" },
  // ORDER_ID-keyed children (ORDER_ID = ORDER_PROC_ID in most cases)
  { table: "ORDER_STATUS", fkCol: "ORDER_ID", key: "status_history" },
  { table: "ORDER_AUTH_INFO", fkCol: "ORDER_ID", key: "auth_info" },
  { table: "ORDER_PENDING", fkCol: "ORDER_ID", key: "pending_info" },
  { table: "ORDER_REVIEW", fkCol: "ORDER_ID", key: "review_history" },
  { table: "ORDER_READ_ACK", fkCol: "ORDER_ID", key: "read_acknowledgments" },
  { table: "ORD_SPEC_QUEST", fkCol: "ORDER_ID", key: "specimen_questions" },
  { table: "ORD_PROC_INSTR", fkCol: "ORDER_ID", key: "instructions" },
  { table: "ORD_CLIN_IND", fkCol: "ORDER_ID", key: "clinical_indications" },
  { table: "ORD_INDICATIONS", fkCol: "ORDER_ID", key: "indications" },
  { table: "EXTERNAL_ORDER_INFO", fkCol: "ORDER_ID", key: "external_info" },
  { table: "CL_ORD_FST_LST_SCH", fkCol: "ORDER_ID", key: "schedule_history" },
  { table: "OBS_MTHD_ID", fkCol: "ORDER_ID", key: "observation_methods" },
  { table: "SPEC_TYPE_SNOMED", fkCol: "ORDER_ID", key: "specimen_snomed" },
  { table: "ORDER_INSTANTIATED", fkCol: "ORDER_ID", key: "instantiated_orders" },
  { table: "ORDER_SUMMARY", fkCol: "ORDER_ID", key: "summary" },
  { table: "ORDER_ANATOMICAL_REGION", fkCol: "ORDER_ID", key: "anatomical_regions" },
  { table: "ORDER_IMAGE_AVAIL_INFO", fkCol: "ORDER_ID", key: "image_availability" },
  { table: "ORDER_DOCUMENTS", fkCol: "ORDER_ID", key: "documents" },
  { table: "ORD_PRFLST_TRK", fkCol: "ORDER_ID", key: "preference_list" },
  { table: "ORD_SECOND_SIGN", fkCol: "ORDER_ID", key: "second_signature" },
  { table: "RAD_THERAPY_ASSOC_COURSE", fkCol: "ORDER_ID", key: "rad_therapy_course" },
  { table: "ADT_ORDER_INFORMATION", fkCol: "ORDER_ID", key: "adt_info" },
  { table: "ORDER_RES_COMMENT", fkCol: "ORDER_ID", key: "result_comments" },
  { table: "PERFORMING_ORG_INFO", fkCol: "ORDER_ID", key: "performing_org" },
  { table: "MEDICATION_COST_ESTIMATES", fkCol: "ORDER_ID", key: "cost_estimates" },
  { table: "FINALIZE_PHYSICIAN", fkCol: "ORDER_ID", key: "finalize_physician" },
  { table: "ORDER_MODALITY_TYPE", fkCol: "ORDER_ID", key: "modality_type" },
  { table: "ORDER_RPTD_SIG_INSTR", fkCol: "ORDER_ID", key: "reported_sig_instructions" },
  { table: "ORD_RSLT_COMPON_ID", fkCol: "ORDER_ID", key: "result_component_ids" },
  { table: "RIS_SGND_INFO", fkCol: "ORDER_PROC_ID", key: "ris_signed_info" },
  { table: "SPEC_SOURCE_SNOMED", fkCol: "ORDER_ID", key: "specimen_source_snomed" },
];

const noteChildren: ChildSpec[] = [
  { table: "HNO_PLAIN_TEXT", fkCol: "NOTE_ID", key: "text" },
  { table: "ABN_FOLLOW_UP", fkCol: "NOTE_ID", key: "metadata" },
  { table: "NOTE_ENC_INFO", fkCol: "NOTE_ID", key: "encounter_info", merged: true },
  { table: "NOTE_CONTENT_INFO", fkCol: "NOTE_ID", key: "content_info" },
  { table: "V_EHI_HNO_LINKED_PATS", fkCol: "NOTE_ID", key: "linked_patients" },
  { table: "HNO_ORDERS", fkCol: "NOTE_ID", key: "linked_orders" },
  { table: "NOTES_LINK_ORD_TXN", fkCol: "NOTE_ID", key: "linked_order_txns" },
];

const txChildren: ChildSpec[] = [
  { table: "ARPB_TX_ACTIONS", fkCol: "TX_ID", key: "actions" },
  { table: "ARPB_CHG_ENTRY_DX", fkCol: "TX_ID", key: "charge_diagnoses" },
  { table: "TX_DIAG", fkCol: "TX_ID", key: "diagnoses" },
  { table: "PMT_EOB_INFO_II", fkCol: "TX_ID", key: "eob_info" },
  { table: "ARPB_TX_MATCH_HX", fkCol: "TX_ID", key: "match_history" },
  { table: "ARPB_TX_CHG_REV_HX", fkCol: "TX_ID", key: "charge_revision_history" },
  { table: "ARPB_TX_STMCLAIMHX", fkCol: "TX_ID", key: "statement_claim_history" },
  { table: "ARPB_TX_MODERATE", fkCol: "TX_ID", key: "moderation" },
  { table: "ARPB_TX_MODIFIERS", fkCol: "ETR_ID", key: "modifiers" },
  { table: "ARPB_AUTH_INFO", fkCol: "TX_ID", key: "auth_info" },
  { table: "ARPB_TX_VOID", fkCol: "TX_ID", key: "void_info" },
  { table: "ARPB_TX_STMT_DT", fkCol: "TX_ID", key: "statement_dates" },
  // Hospital transaction children (HSP_TRANSACTIONS keyed on TX_ID)
  { table: "HSP_TX_NAA_DETAIL", fkCol: "TX_ID", key: "naa_detail" },
  { table: "PMT_EOB_INFO_I", fkCol: "TX_ID", key: "eob_info_i" },
  { table: "HSP_TX_LINE_INFO", fkCol: "TX_ID", key: "line_info" },
  { table: "HSP_PMT_LINE_REMIT", fkCol: "TX_ID", key: "line_remit" },
  { table: "HSP_PMT_REMIT_DETAIL", fkCol: "TX_ID", key: "remit_detail" },
  { table: "HSP_TX_RMT_CD_LST", fkCol: "TX_ID", key: "remit_code_list" },
  { table: "HSP_TX_AUTH_INFO", fkCol: "TX_ID", key: "hsp_auth_info" },
  { table: "HSP_TX_DIAG", fkCol: "TX_ID", key: "hsp_diagnoses" },
  { table: "TX_NDC_INFORMATION", fkCol: "TX_ID", key: "ndc_info" },
  { table: "SVC_PMT_HISTORY", fkCol: "TX_ID", key: "svc_payment_history" },
  { table: "BDC_PB_CHGS", fkCol: "TX_ID", key: "billing_denial_charges" },
  { table: "ARPB_PMT_RELATED_DENIALS", fkCol: "TX_ID", key: "payment_related_denials" },
];

const referralChildren: ChildSpec[] = [
  { table: "REFERRAL_HIST", fkCol: "REFERRAL_ID", key: "history" },
  { table: "REFERRAL_DX", fkCol: "REFERRAL_ID", key: "diagnoses" },
  { table: "REFERRAL_PX", fkCol: "REFERRAL_ID", key: "procedures" },
  { table: "REFERRAL_NOTES", fkCol: "REFERRAL_ID", key: "notes" },
  { table: "REFERRAL_REASONS", fkCol: "REFERRAL_ID", key: "reasons" },
  { table: "REFERRAL_APT", fkCol: "REFERRAL_ID", key: "appointments" },
  { table: "REFERRAL_CVG", fkCol: "REFERRAL_ID", key: "coverage" },
  { table: "REFERRAL_CVG_AUTH", fkCol: "REFERRAL_ID", key: "coverage_auth" },
  { table: "EPA_INFO", fkCol: "REFERRAL_ID", key: "prior_auth", merged: true },
  { table: "REFERRAL_ORG_FILTER_SA", fkCol: "REFERRAL_ID", key: "org_filter" },
  { table: "REFERRAL_CROSS_ORG", fkCol: "REFERRAL_ID", key: "cross_org" },
  { table: "RFL_REF_TO_REGIONS", fkCol: "REFERRAL_ID", key: "ref_to_regions" },
];

const problemChildren: ChildSpec[] = [
  { table: "PROB_UPDATES", fkCol: "PROBLEM_LIST_ID", key: "updates" },
  { table: "PL_SYSTEMS", fkCol: "PROBLEM_LIST_ID", key: "body_systems" },
  { table: "PROBLEM_LIST_ALL", fkCol: "PROBLEM_LIST_ID", key: "all_info" },
  { table: "PROBLEM_LIST_HX", fkCol: "PROBLEM_LIST_ID", key: "history" },
];

const allergyChildren: ChildSpec[] = [
  { table: "ALLERGY_REACTIONS", fkCol: "ALLERGY_ID", key: "reactions" },
];

const patRelChildren: ChildSpec[] = [
  { table: "PAT_REL_PHONE_NUM", fkCol: "PAT_RELATIONSHIP_ID", key: "phone_numbers" },
  { table: "PAT_RELATIONSHIP_ADDR", fkCol: "PAT_RELATIONSHIP_ID", key: "addresses" },
  { table: "PAT_REL_CONTEXT", fkCol: "PAT_RELATIONSHIP_ID", key: "contexts" },
  { table: "PAT_REL_EMAIL_ADDR", fkCol: "PAT_RELATIONSHIP_ID", key: "email_addresses" },
  { table: "PAT_REL_LANGUAGES", fkCol: "PAT_RELATIONSHIP_ID", key: "languages" },
  { table: "PAT_REL_SPEC_NEEDS", fkCol: "PAT_RELATIONSHIP_ID", key: "special_needs" },
  { table: "PAT_RELATIONSHIP_LIST_HX", fkCol: "RELATIONSHIP_ID", key: "history" },
];

const coverageChildren: ChildSpec[] = [
  { table: "CVG_ACCT_LIST", fkCol: "CVG_ID", key: "account_list" },
  { table: "COVERAGE_COPAY_ECD", fkCol: "COVERAGE_ID", key: "copay_details" },
  { table: "COVERAGE_MEMBER_LIST", fkCol: "COVERAGE_ID", key: "member_list" },
  { table: "COVERAGE_SPONSOR", fkCol: "CVG_ID", key: "sponsor" },
  { table: "CVG_AP_CLAIMS", fkCol: "COVERAGE_ID", key: "claims" },
  { table: "CVG_SUBSCR_ADDR", fkCol: "CVG_ID", key: "subscriber_address" },
];

const medChildren: ChildSpec[] = [
  { table: "ORDER_DX_MED", fkCol: "ORDER_MED_ID", key: "diagnoses" },
  { table: "ORDER_MEDINFO", fkCol: "ORDER_MED_ID", key: "med_info" },
  { table: "ORDER_MED_SIG", fkCol: "ORDER_ID", key: "signature" },
  { table: "ORD_DOSING_PARAMS", fkCol: "ORDER_ID", key: "dosing_params", merged: true },
  { table: "ORDER_RPTD_SIG_HX", fkCol: "ORDER_ID", key: "reported_sig_history" },
  { table: "ORDER_RPTD_SIG_TEXT", fkCol: "ORDER_ID", key: "reported_sig_text" },
  { table: "DUPMED_DISMISS_HH_INFO", fkCol: "ORDER_ID", key: "dup_dismiss" },
  { table: "ORDER_MED_MORPHINE_EQUIV", fkCol: "ORDER_ID", key: "morphine_equiv" },
  { table: "ORDER_MED_VITALS", fkCol: "ORDER_ID", key: "med_vitals" },
  { table: "ORD_MED_USER_ADMIN", fkCol: "ORDER_ID", key: "user_admin" },
  { table: "PRESC_ID", fkCol: "ORDER_ID", key: "prescription_ids" },
  { table: "ORDER_RXVER_NOADSN", fkCol: "ORDER_MED_ID", key: "rx_verification" },
  { table: "ORD_MED_ADMININSTR", fkCol: "ORDER_MED_ID", key: "admin_instructions" },
  { table: "ORDER_DISP_INFO", fkCol: "ORDER_MED_ID", key: "dispense_info" },
];

const immuneChildren: ChildSpec[] = [
  { table: "IMMUNE_HISTORY", fkCol: "IMMUNE_ID", key: "history" },
  { table: "IMM_ADMIN", fkCol: "DOCUMENT_ID", key: "administrations" },
  { table: "IMM_ADMIN_COMPONENTS", fkCol: "DOCUMENT_ID", key: "components" },
  { table: "IMM_ADMIN_GROUPS", fkCol: "DOCUMENT_ID", key: "groups" },
  { table: "IMM_DUE", fkCol: "DOCUMENT_ID", key: "due_forecast" },
  { table: "IMM_ADMIN_GROUPS_FT", fkCol: "DOCUMENT_ID", key: "admin_groups_free_text" },
  { table: "MED_DISPENSE_SIG", fkCol: "DOCUMENT_ID", key: "dispense_signatures" },
];

const remitChildren: ChildSpec[] = [
  { table: "CL_RMT_SVCE_LN_INF", fkCol: "IMAGE_ID", key: "service_lines" },
  { table: "CL_RMT_CLM_INFO", fkCol: "IMAGE_ID", key: "claim_info" },
  { table: "CL_RMT_CLM_ENTITY", fkCol: "IMAGE_ID", key: "claim_entities" },
  { table: "CL_RMT_PRV_SUM_INF", fkCol: "IMAGE_ID", key: "provider_summary" },
  { table: "CL_RMT_PRV_SUP_INF", fkCol: "IMAGE_ID", key: "provider_supplemental" },
  { table: "CL_RMT_INP_ADJ_INF", fkCol: "IMAGE_ID", key: "inpatient_adjustments" },
  { table: "CL_RMT_OPT_ADJ_INF", fkCol: "IMAGE_ID", key: "outpatient_adjustments" },
  { table: "CL_RMT_SVC_LVL_ADJ", fkCol: "IMAGE_ID", key: "service_level_adjustments" },
  { table: "CL_RMT_SVC_LVL_REF", fkCol: "IMAGE_ID", key: "service_level_refs" },
  { table: "CL_RMT_SVC_AMT_INF", fkCol: "IMAGE_ID", key: "service_amounts" },
  { table: "CL_RMT_SVC_DAT_INF", fkCol: "IMAGE_ID", key: "service_dates" },
  { table: "CL_RMT_DELIVER_MTD", fkCol: "IMAGE_ID", key: "delivery_methods" },
  { table: "CL_RMT_HC_RMK_CODE", fkCol: "IMAGE_ID", key: "remark_codes" },
  { table: "CL_RMT_CLM_DT_INFO", fkCol: "IMAGE_ID", key: "claim_date_info" },
];

const harChildren: ChildSpec[] = [
  { table: "HSP_ACCT_CVG_LIST", fkCol: "HSP_ACCOUNT_ID", key: "coverage_list" },
  { table: "HSP_ACCT_DX_LIST", fkCol: "HSP_ACCOUNT_ID", key: "diagnoses" },
  { table: "HSP_ACCT_PRORATION", fkCol: "HSP_ACCOUNT_ID", key: "proration" },
  { table: "HSP_ACCT_OTHR_PROV", fkCol: "HSP_ACCOUNT_ID", key: "other_providers" },
  { table: "HSP_ACCT_ADJ_LIST", fkCol: "HSP_ACCOUNT_ID", key: "adjustments" },
  { table: "HSP_ACCT_BILL_DRG", fkCol: "HSP_ACCOUNT_ID", key: "billing_drg" },
  { table: "HSP_ACCT_CLAIM_HAR", fkCol: "ACCT_ID", key: "claims" },
  { table: "HSP_ACCT_SBO", fkCol: "HSP_ACCOUNT_ID", key: "split_billing" },
  { table: "HSP_ACCT_CHG_LIST", fkCol: "HSP_ACCOUNT_ID", key: "charge_list" },
  { table: "HSP_ACCT_PYMT_LIST", fkCol: "HSP_ACCOUNT_ID", key: "payment_list" },
  { table: "HSP_ACCT_ATND_PROV", fkCol: "HSP_ACCOUNT_ID", key: "attending_providers" },
  { table: "HSP_ACCT_ADMIT_DX", fkCol: "HSP_ACCOUNT_ID", key: "admit_diagnoses" },
  { table: "HSP_ACCT_LETTERS", fkCol: "HSP_ACCOUNT_ID", key: "letters" },
  { table: "HSP_CLAIM_PRINT", fkCol: "HSP_ACCOUNT_ID", key: "claim_prints" },
  { table: "HSP_TRANSACTIONS", fkCol: "HSP_ACCOUNT_ID", key: "transactions", merged: true },
  { table: "CODE_INT_COMB_LN", fkCol: "HSP_ACCOUNT_ID", key: "code_int" },
  { table: "HSP_ACCT_CL_AG_HIS", fkCol: "HSP_ACCOUNT_ID", key: "collection_agency_history" },
  { table: "HSP_ACCT_EARSTADDR", fkCol: "ACCT_ID", key: "earliest_address" },
  { table: "HSP_ACCT_EXTINJ_CD", fkCol: "HSP_ACCOUNT_ID", key: "external_injury_codes" },
  { table: "HSP_ACCT_OCUR_HAR", fkCol: "ACCT_ID", key: "occurrence_codes" },
  { table: "DOCS_FOR_HOSP_ACCT", fkCol: "ACCT_ID", key: "linked_documents" },
  { table: "RECONCILE_CLM", fkCol: "HSP_ACCOUNT_ID", key: "reconcile_claims" },
  // HSP_BKT_* tables — children of HSP_BUCKET (no HSP_BUCKET table in export; wire via HSP_ACCOUNT_ID)
  { table: "HSP_BKT_ADDTL_REC", fkCol: "HSP_ACCOUNT_ID", key: "bucket_additional_records" },
  { table: "HSP_BKT_NAA_ADJ_HX", fkCol: "HSP_ACCOUNT_ID", key: "bucket_naa_adj_history" },
  { table: "HSP_BKT_ADJ_TXS", fkCol: "HSP_ACCOUNT_ID", key: "bucket_adj_transactions" },
  { table: "HSP_BKT_PAYMENT", fkCol: "HSP_ACCOUNT_ID", key: "bucket_payments" },
  { table: "HSP_BKT_INV_NUM", fkCol: "HSP_ACCOUNT_ID", key: "bucket_invoice_numbers" },
  { table: "HSP_BKT_NAA_HX_HTR", fkCol: "HSP_ACCOUNT_ID", key: "bucket_naa_history" },
  { table: "HSP_BKT_NAA_TX_TYP", fkCol: "HSP_ACCOUNT_ID", key: "bucket_naa_tx_types" },
];

const acctChildren: ChildSpec[] = [
  { table: "ACCOUNT_CONTACT", fkCol: "ACCOUNT_ID", key: "contacts", merged: true },
  { table: "ACCT_COVERAGE", fkCol: "ACCOUNT_ID", key: "coverage_links" },
  { table: "ACCT_TX", fkCol: "ACCOUNT_ID", key: "transaction_links" },
  { table: "ACCT_ADDR", fkCol: "ACCOUNT_ID", key: "addresses" },
  { table: "ACCOUNT_CREATION", fkCol: "ACCT_ID", key: "creation_info" },
  { table: "GUAR_ACCT_STMT_HX", fkCol: "ACCOUNT_ID", key: "statement_history" },
  { table: "GUAR_PMT_SCORE_PB_HX", fkCol: "ACCOUNT_ID", key: "payment_score" },
  { table: "GUAR_ADDR_HX", fkCol: "ACCOUNT_ID", key: "address_history" },
  { table: "ACCT_HOME_PHONE_HX", fkCol: "ACCOUNT_ID", key: "phone_history" },
  { table: "NOTES_ACCT", fkCol: "ACCOUNT_ID", key: "notes" },
];

const claimChildren: ChildSpec[] = [
  { table: "SVC_LN_INFO", fkCol: "RECORD_ID", key: "service_lines", merged: true },
  { table: "CLM_DX", fkCol: "RECORD_ID", key: "diagnoses" },
  { table: "CLM_NOTE", fkCol: "RECORD_ID", key: "notes" },
  { table: "CLM_VALUE_RECORD", fkCol: "RECORD_ID", key: "value_records" },
  { table: "OCC_CD", fkCol: "RECORD_ID", key: "occurrence_codes" },
  { table: "REL_CAUSE_CD", fkCol: "RECORD_ID", key: "related_causes" },
  // Additional claim children (FK: RECORD_ID = CLM_VALUES.RECORD_ID)
  { table: "EXT_CAUSE_INJ_DX", fkCol: "RECORD_ID", key: "external_cause_injury_dx" },
  { table: "PAT_RSN_VISIT_DX", fkCol: "RECORD_ID", key: "patient_reason_visit_dx" },
];

// ─── Attach children to a parent row ───────────────────────────────────────

function attachChildren(parent: EpicRow, parentId: unknown, specs: ChildSpec[]): void {
  for (const spec of specs) {
    if (!tableExists(spec.table)) continue;
    const rows = spec.merged
      ? childrenMerged(spec.table, spec.fkCol, parentId)
      : children(spec.table, spec.fkCol, parentId);
    if (rows.length > 0) parent[spec.key] = rows;
  }
}

// ─── Projection ────────────────────────────────────────────────────────────

function projectPatient(): EpicRow {
  const rows = mergeQuery("PATIENT");
  if (rows.length === 0) throw new Error("No patient found");
  const pat = rows[0];
  const patId = pat.PAT_ID;

  // Also merge PATIENT_MYC if present
  if (tableExists("PATIENT_MYC")) {
    const myc = qOne(`SELECT * FROM PATIENT_MYC WHERE PAT_ID = ?`, [patId]);
    if (myc) Object.assign(pat, myc);
  }

  return pat;
}

function projectAllergies(patId: unknown): EpicRow[] {
  // ALLERGY has no PAT_ID — linked via PAT_ALLERGIES bridge table
  let rows: EpicRow[];
  if (tableExists("PAT_ALLERGIES") && tableExists("ALLERGY")) {
    rows = q(`
      SELECT a.* FROM ALLERGY a
      JOIN PAT_ALLERGIES pa ON pa.ALLERGY_RECORD_ID = a.ALLERGY_ID
      WHERE pa.PAT_ID = ?
    `, [patId]);
  } else if (tableExists("ALLERGY")) {
    rows = q(`SELECT * FROM ALLERGY`);
  } else {
    return [];
  }
  for (const row of rows) {
    attachChildren(row, row.ALLERGY_ID, allergyChildren);
    row.allergenName = row.ALLERGEN_ID_ALLERGEN_NAME;
  }
  return rows;
}

function projectProblems(patId: unknown): EpicRow[] {
  let rows: EpicRow[];
  if (tableExists("PAT_PROBLEM_LIST") && tableExists("PROBLEM_LIST")) {
    rows = q(`
      SELECT p.* FROM PROBLEM_LIST p
      JOIN PAT_PROBLEM_LIST pp ON pp.PROBLEM_LIST_ID = p.PROBLEM_LIST_ID
      WHERE pp.PAT_ID = ?
    `, [patId]);
  } else if (tableExists("PROBLEM_LIST")) {
    rows = q(`SELECT * FROM PROBLEM_LIST`);
  } else {
    return [];
  }
  for (const row of rows) {
    attachChildren(row, row.PROBLEM_LIST_ID, problemChildren);
    row._dx_name = lookupName("CLARITY_EDG", "DX_ID", "DX_NAME", row.DX_ID);
  }
  return rows;
}

function projectImmunizations(patId: unknown): EpicRow[] {
  let rows: EpicRow[];
  if (tableExists("PAT_IMMUNIZATIONS") && tableExists("IMMUNE")) {
    rows = q(`
      SELECT i.* FROM IMMUNE i
      JOIN PAT_IMMUNIZATIONS pi ON pi.IMMUNE_ID = i.IMMUNE_ID
      WHERE pi.PAT_ID = ?
    `, [patId]);
  } else if (tableExists("IMMUNE")) {
    rows = q(`SELECT * FROM IMMUNE`);
  } else {
    return [];
  }
  for (const row of rows) {
    attachChildren(row, row.IMMUNE_ID, immuneChildren);
  }
  return rows;
}

function projectMedications(patId: unknown): EpicRow[] {
  const rows = mergeQuery("ORDER_MED", `b."PAT_ID" = ?`, [patId]);
  for (const row of rows) {
    const oid = row.ORDER_MED_ID;
    attachChildren(row, oid, medChildren);
    // Also attach ORDER_ID-keyed children
    for (const spec of medChildren) {
      if (spec.fkCol === "ORDER_ID" && !row[spec.key]) {
        const c = children(spec.table, "ORDER_ID", oid);
        if (c.length > 0) row[spec.key] = c;
      }
    }
  }
  return rows;
}

function projectOrder(oid: unknown): EpicRow {
  const rows = mergeQuery("ORDER_PROC", `b."ORDER_PROC_ID" = ?`, [oid]);
  const order = rows[0] ?? { ORDER_PROC_ID: oid };

  attachChildren(order, oid, orderChildren);

  // Resolve procedure name
  order._procedure_name = lookupName("CLARITY_EAP", "PROC_ID", "PROC_NAME", order.PROC_ID);

  return order;
}

function projectNote(noteId: unknown): EpicRow {
  const rows = mergeQuery("HNO_INFO", `b."NOTE_ID" = ?`, [noteId]);
  const note = rows[0] ?? { NOTE_ID: noteId };
  attachChildren(note, noteId, noteChildren);
  return note;
}

function projectEncounter(csn: CSN): EpicRow {
  const rows = mergeQuery("PAT_ENC", `b."PAT_ENC_CSN_ID" = ?`, [csn]);
  if (rows.length === 0) {
    // Try matching on the base table's join column (PAT_ENC uses PAT_ID as first col)
    const byCSN = q(`SELECT * FROM PAT_ENC WHERE PAT_ENC_CSN_ID = ?`, [csn]);
    if (byCSN.length === 0) return { PAT_ENC_CSN_ID: csn };
    // Got it from base, now merge manually
    return byCSN[0];
  }
  const enc = rows[0];

  // Resolve provider name
  enc._visit_provider = lookupName("CLARITY_SER", "PROV_ID", "PROV_NAME", enc.VISIT_PROV_ID);
  enc._pcp = lookupName("CLARITY_SER", "PROV_ID", "PROV_NAME", enc.PCP_PROV_ID);
  enc._department = lookupName("CLARITY_DEP", "DEPARTMENT_ID", "DEPARTMENT_NAME", enc.EFFECTIVE_DEPT_ID ?? enc.DEPARTMENT_ID);

  // Attach all children
  attachChildren(enc, csn, encounterChildren);

  // Resolve diagnosis names
  for (const dx of (enc.diagnoses as EpicRow[] ?? [])) {
    dx._dx_name = lookupName("CLARITY_EDG", "DX_ID", "DX_NAME", dx.DX_ID);
  }

  // Appointment & disposition (1:1 extensions)
  if (tableExists("PAT_ENC_APPT")) {
    enc.appointment = qOne(`SELECT * FROM PAT_ENC_APPT WHERE PAT_ENC_CSN_ID = ?`, [csn]);
  }
  if (tableExists("PAT_ENC_DISP")) {
    enc.disposition = qOne(`SELECT * FROM PAT_ENC_DISP WHERE PAT_ENC_CSN_ID = ?`, [csn]);
  }
  if (tableExists("IP_DATA_STORE") && tableExists("PAT_ENC_HSP")) {
    // IP_DATA_STORE keys on INPATIENT_DATA_ID, linked via PAT_ENC_HSP
    const hsp = qOne(`SELECT INPATIENT_DATA_ID FROM PAT_ENC_HSP WHERE PAT_ENC_CSN_ID = ?`, [csn]);
    if (hsp?.INPATIENT_DATA_ID) {
      enc.inpatient_data = qOne(`SELECT * FROM IP_DATA_STORE WHERE INPATIENT_DATA_ID = ?`, [hsp.INPATIENT_DATA_ID]);
    }
  } else if (tableExists("IP_DATA_STORE")) {
    // Fallback: try direct match if schema has changed
    const ipCols = q(`PRAGMA table_info("IP_DATA_STORE")`).map(r => r.name as string);
    if (ipCols.includes("PAT_ENC_CSN_ID")) {
      enc.inpatient_data = qOne(`SELECT * FROM IP_DATA_STORE WHERE PAT_ENC_CSN_ID = ?`, [csn]);
    }
  }
  if (tableExists("PAT_ENC_HSP")) {
    enc.hospital_encounter = qOne(`SELECT * FROM PAT_ENC_HSP WHERE PAT_ENC_CSN_ID = ?`, [csn]);
  }

  // Orders
  const orderRows = mergeQuery("ORDER_PROC", `b."PAT_ENC_CSN_ID" = ?`, [csn]);
  enc.orders = orderRows.map((o) => projectOrder(o.ORDER_PROC_ID));

  // Also get child orders via ORDER_PARENT_INFO and attach their results
  const parentLinks = q(`SELECT * FROM ORDER_PARENT_INFO WHERE PAT_ENC_CSN_ID = ?`, [csn]);
  for (const link of parentLinks) {
    if (link.ORDER_ID !== link.PARENT_ORDER_ID) {
      const parentOrder = (enc.orders as EpicRow[]).find(
        (o) => o.ORDER_PROC_ID === link.PARENT_ORDER_ID
      );
      if (parentOrder) {
        const childResults = children("ORDER_RESULTS", "ORDER_PROC_ID", link.ORDER_ID);
        if (childResults.length > 0) {
          const existing = (parentOrder.results as EpicRow[]) ?? [];
          parentOrder.results = [...existing, ...childResults];
        }
      }
    }
  }

  // Notes
  const noteRows = q(`SELECT NOTE_ID FROM HNO_INFO WHERE PAT_ENC_CSN_ID = ?`, [csn]);
  enc.notes = noteRows.map((n) => projectNote(n.NOTE_ID));

  // Flowsheets — need INPATIENT_DATA_ID, which comes from PAT_ENC_HSP
  // EHI limitation: IP_FLWSHT_MEAS has metadata (who, when, template) but
  // NO MEAS_VALUE column — actual vital sign values are not in the export.
  // We still wire the linkage for provenance: encounter → IP_DATA_STORE →
  // IP_FLWSHT_REC → IP_FLWSHT_MEAS.
  if (tableExists("PAT_ENC_HSP")) {
    const hspForFlow = qOne(`SELECT INPATIENT_DATA_ID FROM PAT_ENC_HSP WHERE PAT_ENC_CSN_ID = ?`, [csn]);
    if (hspForFlow?.INPATIENT_DATA_ID) {
      const ipid = hspForFlow.INPATIENT_DATA_ID;
      enc.flowsheet_rows = children("IP_FLOWSHEET_ROWS", "INPATIENT_DATA_ID", ipid);
      // Get measurement IDs and fetch measurements (metadata only — no values)
      const fsdIds = q(`SELECT FSD_ID FROM IP_FLWSHT_REC WHERE INPATIENT_DATA_ID = ?`, [ipid]);
      enc.flowsheet_measurements = fsdIds.flatMap((f) =>
        children("IP_FLWSHT_MEAS", "FSD_ID", f.FSD_ID)
      );
    }
  }

  return enc;
}

function projectBilling(patId: unknown): EpicRow {
  // Billing tables link to patient via various chains:
  // ARPB_TRANSACTIONS → ACCOUNT_ID → ACCT_GUAR_PAT_INFO.PAT_ID
  // ARPB_VISITS → PRIM_ENC_CSN_ID → PAT_ENC.PAT_ID
  // HSP_ACCOUNT → encounters
  // ACCOUNT → ACCT_GUAR_PAT_INFO.PAT_ID

  // Get patient's account IDs via bridge table
  const patAccountIds = tableExists("ACCT_GUAR_PAT_INFO")
    ? q(`SELECT ACCOUNT_ID FROM ACCT_GUAR_PAT_INFO WHERE PAT_ID = ?`, [patId]).map(r => r.ACCOUNT_ID)
    : [];

  // Get patient's encounter CSNs
  const patCSNs = q(`SELECT PAT_ENC_CSN_ID FROM PAT_ENC WHERE PAT_ID = ?`, [patId]).map(r => r.PAT_ENC_CSN_ID);

  // Transactions — via account chain
  let txRows: EpicRow[];
  if (patAccountIds.length > 0 && tableExists("ARPB_TRANSACTIONS")) {
    const placeholders = patAccountIds.map(() => "?").join(",");
    txRows = mergeQuery("ARPB_TRANSACTIONS", `b."ACCOUNT_ID" IN (${placeholders})`, patAccountIds);
  } else {
    txRows = mergeQuery("ARPB_TRANSACTIONS");
  }
  for (const tx of txRows) {
    attachChildren(tx, tx.TX_ID, txChildren);
    tx._procedure_name = lookupName("CLARITY_EAP", "PROC_ID", "PROC_NAME", tx.PROCEDURE_ID);
  }

  // Visits — via encounter CSN chain
  let visits: EpicRow[];
  if (patCSNs.length > 0 && tableExists("ARPB_VISITS")) {
    const csnPlaceholders = patCSNs.map(() => "?").join(",");
    visits = q(`SELECT * FROM ARPB_VISITS WHERE PRIM_ENC_CSN_ID IN (${csnPlaceholders})`, patCSNs);
  } else {
    visits = tableExists("ARPB_VISITS") ? q(`SELECT * FROM ARPB_VISITS`) : [];
  }

  // Hospital accounts — via HAR_ALL bridge (ACCT_ID → HSP_ACCOUNT_ID, PAT_ID for filter)
  let hars: EpicRow[];
  if (tableExists("HAR_ALL") && tableExists("HSP_ACCOUNT")) {
    const harAcctIds = q(`SELECT ACCT_ID FROM HAR_ALL WHERE PAT_ID = ?`, [patId]).map(r => r.ACCT_ID);
    if (harAcctIds.length > 0) {
      const placeholders = harAcctIds.map(() => "?").join(",");
      hars = mergeQuery("HSP_ACCOUNT", `b."HSP_ACCOUNT_ID" IN (${placeholders})`, harAcctIds);
    } else {
      hars = [];
    }
  } else {
    hars = mergeQuery("HSP_ACCOUNT");
  }
  for (const har of hars) {
    attachChildren(har, har.HSP_ACCOUNT_ID, harChildren);
    // Claim prints have their own children keyed on CLAIM_PRINT_ID
    for (const clp of (har.claim_prints as EpicRow[] ?? [])) {
      const clpId = clp.CLAIM_PRINT_ID;
      if (tableExists("HSP_CLP_REV_CODE")) clp.rev_codes = children("HSP_CLP_REV_CODE", "CLAIM_PRINT_ID", clpId);
      if (tableExists("HSP_CLP_CMS_LINE")) clp.cms_lines = children("HSP_CLP_CMS_LINE", "CLAIM_PRINT_ID", clpId);
      if (tableExists("HSP_CLP_DIAGNOSIS")) clp.diagnoses = children("HSP_CLP_DIAGNOSIS", "CLAIM_PRINT_ID", clpId);
      if (tableExists("HSP_CLAIM_DETAIL1")) clp.detail_1 = children("HSP_CLAIM_DETAIL1", "CLAIM_PRINT_ID", clpId);
      if (tableExists("HSP_CLAIM_DETAIL2")) clp.detail_2 = children("HSP_CLAIM_DETAIL2", "CLAIM_PRINT_ID", clpId);
      if (tableExists("HSP_CLP_CMS_TX_PIECES")) clp.cms_tx_pieces = children("HSP_CLP_CMS_TX_PIECES", "CLAIM_PRINT_ID", clpId);
      if (tableExists("HSP_CLP_UB_TX_PIECES")) clp.ub_tx_pieces = children("HSP_CLP_UB_TX_PIECES", "CLAIM_PRINT_ID", clpId);
      if (tableExists("CLP_NON_GRP_TX_IDS")) clp.non_group_tx = children("CLP_NON_GRP_TX_IDS", "CLAIM_PRINT_ID", clpId);
      if (tableExists("CLP_OCCUR_DATA")) clp.occurrence_data = children("CLP_OCCUR_DATA", "CLAIM_PRINT_ID", clpId);
    }
  }

  // Guarantor accounts — via ACCT_GUAR_PAT_INFO bridge
  let accts: EpicRow[];
  if (patAccountIds.length > 0) {
    const placeholders = patAccountIds.map(() => "?").join(",");
    accts = mergeQuery("ACCOUNT", `b."ACCOUNT_ID" IN (${placeholders})`, patAccountIds);
  } else {
    accts = mergeQuery("ACCOUNT");
  }
  for (const acct of accts) {
    attachChildren(acct, acct.ACCOUNT_ID, acctChildren);
  }

  // Remittances — CL_REMIT has PAT_ID directly
  const remits = tableExists("CL_REMIT")
    ? q(`SELECT * FROM CL_REMIT WHERE PAT_ID = ?`, [patId])
    : [];
  for (const r of remits) {
    attachChildren(r, r.IMAGE_ID, remitChildren);
  }

  // Claims — filter via invoice chain: CLM_VALUES.INV_NUM → INV_BASIC_INFO.INV_NUM → INVOICE.PAT_ID
  const claims = (tableExists("CLM_VALUES") && tableExists("INV_BASIC_INFO") && tableExists("INVOICE"))
    ? mergeQuery("CLM_VALUES",
        `b."INV_NUM" IN (SELECT ib."INV_NUM" FROM INV_BASIC_INFO ib JOIN INVOICE inv ON ib.INV_ID = inv.INVOICE_ID WHERE inv.PAT_ID = ?)`,
        [patId])
    : mergeQuery("CLM_VALUES");
  for (const c of claims) {
    attachChildren(c, c.RECORD_ID, claimChildren);
  }

  // Invoices
  const invoices = tableExists("INVOICE")
    ? q(`SELECT * FROM INVOICE WHERE PAT_ID = ?`, [patId])
    : [];
  for (const inv of invoices) {
    if (tableExists("INV_BASIC_INFO")) inv.basic_info = children("INV_BASIC_INFO", "INV_ID", inv.INVOICE_ID);
    if (tableExists("INV_TX_PIECES")) inv.tx_pieces = children("INV_TX_PIECES", "INV_ID", inv.INVOICE_ID);
    if (tableExists("INV_NUM_TX_PIECES")) inv.num_tx_pieces = children("INV_NUM_TX_PIECES", "INV_ID", inv.INVOICE_ID);
    if (tableExists("INV_CLM_LN_ADDL")) inv.claim_line_addl = children("INV_CLM_LN_ADDL", "INVOICE_ID", inv.INVOICE_ID);
    if (tableExists("INV_DX_INFO")) inv.diagnoses = children("INV_DX_INFO", "INVOICE_ID", inv.INVOICE_ID);
    if (tableExists("INV_PMT_RECOUP")) inv.payment_recoup = children("INV_PMT_RECOUP", "INVOICE_ID", inv.INVOICE_ID);
  }

  return {
    transactions: txRows,
    visits,
    hospital_accounts: hars,
    guarantor_accounts: accts,
    remittances: remits,
    claims,
    invoices,
  };
}

// ─── RTF text extraction ───────────────────────────────────────────────────

/** Strip RTF markup → plain text. Regex-based; sufficient for Epic EHI messages. */
function stripRtf(rtf: string): string {
  if (!rtf || !rtf.includes('\\rtf')) return rtf ?? '';
  let s = rtf;
  // Remove known brace-delimited groups
  for (const kw of ['\\fonttbl', '\\colortbl', '\\stylesheet', '\\*\\revtbl',
                     '\\info', '\\header', '\\footer']) {
    s = removeRtfGroup(s, kw);
  }
  s = s.replace(/\\par(?![a-zA-Z])\s?/g, '\n');    // \par → newline
  s = s.replace(/\\line(?![a-zA-Z])\s?/g, '\n');   // \line → newline
  s = s.replace(/\\tab(?![a-zA-Z])\s?/g, '\t');    // \tab → tab
  // \'XX hex escapes (Windows-1252)
  s = s.replace(/\\'([0-9a-fA-F]{2})/g, (_, hex) => {
    const c = parseInt(hex, 16);
    const w1252: Record<number,string> = {
      0x91:'\u2018',0x92:'\u2019',0x93:'\u201C',0x94:'\u201D',
      0x96:'\u2013',0x97:'\u2014',0x85:'\u2026',0x95:'\u2022',
      0x80:'\u20AC',0x99:'\u2122',
    };
    return w1252[c] ?? String.fromCharCode(c);
  });
  // \uN Unicode escapes
  s = s.replace(/\\u(-?\d+)[? ]?/g, (_, n) => {
    let code = parseInt(n, 10); if (code < 0) code += 65536;
    return String.fromCharCode(code);
  });
  s = s.replace(/\\\{/g, '{').replace(/\\\}/g, '}').replace(/\\\\/g, '\\');
  s = s.replace(/\\[a-zA-Z]+-?\d*\s?/g, '');   // remaining control words
  s = s.replace(/[{}]/g, '');                     // braces
  s = s.replace(/[ \t]+/g, ' ');
  s = s.split('\n').map(l => l.trim()).join('\n');
  s = s.replace(/\n{3,}/g, '\n\n');
  return s.trim();
}

/** Remove a brace-delimited RTF group (handles nesting). */
function removeRtfGroup(s: string, controlWord: string): string {
  let idx = 0;
  while (true) {
    const start = s.indexOf('{' + controlWord, idx);
    if (start === -1) break;
    let depth = 0, end = start;
    for (let i = start; i < s.length; i++) {
      if (s[i] === '{') depth++;
      else if (s[i] === '}') { depth--; if (depth === 0) { end = i; break; } }
    }
    s = s.slice(0, start) + s.slice(end + 1);
  }
  return s;
}

// ─── Message projection ────────────────────────────────────────────────────

function projectMessages(patId: unknown): EpicRow[] {
  const rows = q(`SELECT * FROM MYC_MESG WHERE PAT_ID = ?`, [patId]);
  for (const msg of rows) {
    msg.text = children("MSG_TXT", "MESSAGE_ID", msg.MESSAGE_ID);
    if (tableExists("MYC_MESG_CHILD")) {
      msg.child_messages = children("MYC_MESG_CHILD", "MESSAGE_ID", msg.MESSAGE_ID);
    }
    if (tableExists("MYC_MESG_RTF_TEXT")) {
      msg.rtf_text = children("MYC_MESG_RTF_TEXT", "MESSAGE_ID", msg.MESSAGE_ID);
    }
    if (tableExists("MYC_MESG_QUESR_ANS")) {
      msg.questionnaire_answers = children("MYC_MESG_QUESR_ANS", "MESSAGE_ID", msg.MESSAGE_ID);
    }
    if (tableExists("MYC_MESG_CNCL_RSN")) {
      msg.cancel_reasons = children("MYC_MESG_CNCL_RSN", "MESSAGE_ID", msg.MESSAGE_ID);
    }
    if (tableExists("MYC_MESG_ORD_ITEMS")) {
      msg.order_items = children("MYC_MESG_ORD_ITEMS", "MESSAGE_ID", msg.MESSAGE_ID);
    }
    // If no plain text but RTF exists, extract text from RTF
    const hasPlainText = (msg.text as EpicRow[]).some(t => t.MSG_TXT);
    if (!hasPlainText && Array.isArray(msg.rtf_text) && msg.rtf_text.length > 0) {
      const rtfParts = (msg.rtf_text as EpicRow[])
        .sort((a, b) => (a.LINE as number) - (b.LINE as number))
        .map(r => r.RTF_TXT as string)
        .filter(Boolean);
      msg.extracted_text = stripRtf(rtfParts.join('\n'));
    }
  }
  return rows;
}

function projectConversationThreads(patId: unknown): EpicRow[] {
  if (!tableExists("MYC_CONVO")) return [];
  const threads = q(`SELECT * FROM MYC_CONVO WHERE PAT_ID = ?`, [patId]);
  for (const t of threads) {
    const tid = t.THREAD_ID;
    if (tableExists("MYC_CONVO_MSGS")) t.messages = children("MYC_CONVO_MSGS", "THREAD_ID", tid);
    if (tableExists("MYC_CONVO_VIEWERS")) t.viewers = children("MYC_CONVO_VIEWERS", "THREAD_ID", tid);
    if (tableExists("MYC_CONVO_USERS")) t.users = children("MYC_CONVO_USERS", "THREAD_ID", tid);
    if (tableExists("MYC_CONVO_ENCS")) t.encounter_links = children("MYC_CONVO_ENCS", "THREAD_ID", tid);
    if (tableExists("MYC_CONVO_AUDIENCE")) t.audience = children("MYC_CONVO_AUDIENCE", "THREAD_ID", tid);
    if (tableExists("IB_MESSAGE_THREAD")) t.ib_thread = children("IB_MESSAGE_THREAD", "THREAD_ID", tid);
    if (tableExists("MYC_CONVO_ABT_MED_ADVICE")) t.med_advice = children("MYC_CONVO_ABT_MED_ADVICE", "THREAD_ID", tid);
    if (tableExists("MYC_CONVO_ABT_CUST_SVC")) t.customer_service = children("MYC_CONVO_ABT_CUST_SVC", "THREAD_ID", tid);
  }
  return threads;
}

function projectReferrals(patId: unknown): EpicRow[] {
  const rows = mergeQuery("REFERRAL", `b."PAT_ID" = ?`, [patId]);
  for (const r of rows) {
    attachChildren(r, r.REFERRAL_ID, referralChildren);
  }
  return rows;
}

function projectDocuments(patId: unknown): EpicRow[] {
  if (!tableExists("DOC_INFORMATION")) return [];
  // Filter via DOC_LINKED_PATS bridge for multi-patient correctness
  const docs = tableExists("DOC_LINKED_PATS")
    ? mergeQuery("DOC_INFORMATION",
        `b."DOC_INFO_ID" IN (SELECT "DOCUMENT_ID" FROM DOC_LINKED_PATS WHERE "LINKED_PAT_ID" = ?)`,
        [patId])
    : mergeQuery("DOC_INFORMATION");
  for (const d of docs) {
    const did = d.DOC_INFO_ID ?? d.DOCUMENT_ID;
    if (tableExists("DOC_LINKED_PATS")) d.linked_patients = children("DOC_LINKED_PATS", "DOCUMENT_ID", did);
    if (tableExists("DOC_INFO_DICOM")) d.dicom = children("DOC_INFO_DICOM", "DOCUMENT_ID", did);
    if (tableExists("DOC_CSN_REFS")) d.csn_refs = children("DOC_CSN_REFS", "DOCUMENT_ID", did);
    if (tableExists("DOCS_RCVD_ALGS")) d.received_allergies = children("DOCS_RCVD_ALGS", "DOCUMENT_ID", did);
    if (tableExists("DOCS_RCVD_ASMT")) d.received_assessments = children("DOCS_RCVD_ASMT", "DOCUMENT_ID", did);
    if (tableExists("DOCS_RCVD_PROC")) d.received_procedures = children("DOCS_RCVD_PROC", "DOCUMENT_ID", did);
    if (tableExists("DOCS_RCVD_ALG_REAC")) d.received_allergy_reactions = children("DOCS_RCVD_ALG_REAC", "DOCUMENT_ID", did);
    if (tableExists("DOCS_RCVD_ALGS_CMT")) d.received_allergy_comments = children("DOCS_RCVD_ALGS_CMT", "DOCUMENT_ID", did);
    if (tableExists("DOC_LINKED_PAT_CSNS")) d.linked_patient_csns = children("DOC_LINKED_PAT_CSNS", "DOCUMENT_ID", did);
  }
  return docs;
}

function projectEpisodes(patId: unknown): EpicRow[] {
  if (!tableExists("EPISODE")) return [];
  // Episodes link via PAT_EPISODE bridge
  const epIds = tableExists("PAT_EPISODE")
    ? q(`SELECT EPISODE_ID FROM PAT_EPISODE WHERE PAT_ID = ?`, [patId])
    : [];
  return epIds.map((e) => {
    const ep = mergeQuery("EPISODE", `b."EPISODE_ID" = ?`, [e.EPISODE_ID])[0] ?? e;
    if (tableExists("CAREPLAN_INFO")) ep.care_plans = children("CAREPLAN_INFO", "PAT_ENC_CSN_ID", ep.EPISODE_ID);
    if (tableExists("CAREPLAN_ENROLLMENT_INFO")) ep.enrollments = children("CAREPLAN_ENROLLMENT_INFO", "CAREPLAN_ID", ep.EPISODE_ID);
    if (tableExists("ALL_EPISODE_CSN_LINKS")) ep.csn_links = children("ALL_EPISODE_CSN_LINKS", "EPISODE_ID", ep.EPISODE_ID);
    if (tableExists("EPISODE_ALL")) ep.episode_all = children("EPISODE_ALL", "EPISODE_ID", ep.EPISODE_ID);
    if (tableExists("PEF_NTFY_INSTR")) ep.notify_instructions = children("PEF_NTFY_INSTR", "EPISODE_ID", ep.EPISODE_ID);
    if (tableExists("RECURRING_BILLING_INFO")) ep.recurring_billing = children("RECURRING_BILLING_INFO", "EPISODE_ID", ep.EPISODE_ID);
    if (tableExists("V_EHI_HSB_LINKED_PATS")) ep.linked_patients = children("V_EHI_HSB_LINKED_PATS", "EPISODE_ID", ep.EPISODE_ID);
    return ep;
  });
}

// ─── Main ──────────────────────────────────────────────────────────────────

console.time("projection");

const patient = projectPatient();
const patId = patient.PAT_ID;

// Get all encounter CSNs for this patient
const allCSNs: CSN[] = q(
  `SELECT DISTINCT PAT_ENC_CSN_ID FROM PAT_ENC WHERE PAT_ID = ?`,
  [patId]
).map((r) => r.PAT_ENC_CSN_ID as CSN);

// PAT_ENC_2..7 split tables key on CSN, not PAT_ID — allCSNs already
// covers every CSN for this patient, so no need to union in unfiltered splits.
const encounterCSNs = allCSNs;

const doc: EpicRow = {
  ...patient,
  allergies: projectAllergies(patId),
  problems: projectProblems(patId),
  medications: projectMedications(patId),
  immunizations: projectImmunizations(patId),
  coverage: (() => {
    const cvgs = mergeQuery("COVERAGE", `b."SUBSCR_OR_SELF_MEM_PAT_ID" = ?`, [patId]);
    for (const cvg of cvgs) attachChildren(cvg, cvg.COVERAGE_ID, coverageChildren);
    return cvgs;
  })(),
  referrals: projectReferrals(patId),
  social_history: q(`SELECT * FROM SOCIAL_HX WHERE PAT_ENC_CSN_ID IN (SELECT PAT_ENC_CSN_ID FROM PAT_ENC WHERE PAT_ID = ?)`, [patId]),
  surgical_history: q(`SELECT * FROM SURGICAL_HX WHERE PAT_ENC_CSN_ID IN (SELECT PAT_ENC_CSN_ID FROM PAT_ENC WHERE PAT_ID = ?)`, [patId]).map((row: EpicRow) => {
    if (row.PROC_ID) row._proc_name = lookupName("CLARITY_EAP", "PROC_ID", "PROC_NAME", row.PROC_ID);
    return row;
  }),
  family_history: tableExists("FAMILY_HX_STATUS") ? q(`SELECT * FROM FAMILY_HX_STATUS WHERE PAT_ENC_CSN_ID IN (SELECT PAT_ENC_CSN_ID FROM PAT_ENC WHERE PAT_ID = ?)`, [patId]) : [],
  family_hx: tableExists("FAMILY_HX") ? q(`SELECT * FROM FAMILY_HX WHERE PAT_ENC_CSN_ID IN (SELECT PAT_ENC_CSN_ID FROM PAT_ENC WHERE PAT_ID = ?)`, [patId]) : [],
  // Patient-level clinical data
  health_maintenance: {
    historical_status: tableExists("HM_HISTORICAL_STATUS") ? children("HM_HISTORICAL_STATUS", "PAT_ID", patId) : [],
    history: tableExists("HM_HISTORY") ? children("HM_HISTORY", "PAT_ID", patId) : [],
    current_guides: tableExists("PAT_HM_CUR_GUIDE") ? children("PAT_HM_CUR_GUIDE", "PAT_ID", patId) : [],
    topic_status: tableExists("PATIENT_HMT_STATUS") ? children("PATIENT_HMT_STATUS", "PAT_ID", patId) : [],
    forecast: tableExists("HM_FORECAST_INFO") ? children("HM_FORECAST_INFO", "PAT_ID", patId) : [],
  },
  // Review histories
  allergy_update_history: tableExists("PATIENT_ALG_UPD_HX") ? children("PATIENT_ALG_UPD_HX", "PAT_ID", patId) : [],
  medication_review_history: tableExists("MEDS_REV_HX") ? children("MEDS_REV_HX", "PAT_ID", patId) : [],
  problem_review_history: tableExists("PROB_LIST_REV_HX") ? children("PROB_LIST_REV_HX", "PAT_ID", patId) : [],
  // Patient demographics extensions
  race: tableExists("PATIENT_RACE") ? children("PATIENT_RACE", "PAT_ID", patId) : [],
  addresses: tableExists("PAT_ADDRESS") ? children("PAT_ADDRESS", "PAT_ID", patId) : [],
  email_addresses: tableExists("PAT_EMAILADDRESS") ? children("PAT_EMAILADDRESS", "PAT_ID", patId) : [],
  address_change_history: tableExists("PAT_ADDR_CHNG_HX") ? children("PAT_ADDR_CHNG_HX", "PAT_ID", patId) : [],
  identity_ids: tableExists("IDENTITY_ID") ? children("IDENTITY_ID", "PAT_ID", patId) : [],
  aliases: tableExists("PATIENT_ALIAS") ? children("PATIENT_ALIAS", "PAT_ID", patId) : [],
  primary_care_providers: tableExists("PAT_PCP") ? children("PAT_PCP", "PAT_ID", patId) : [],
  preferred_pharmacies: tableExists("PAT_PREF_PHARMACY") ? children("PAT_PREF_PHARMACY", "PAT_ID", patId) : [],
  recent_pharmacies: tableExists("PAT_RCNT_USD_PHRMS") ? children("PAT_RCNT_USD_PHRMS", "PAT_ID", patId) : [],
  relationships: tableExists("PAT_RELATIONSHIPS") ? children("PAT_RELATIONSHIPS", "PAT_ID", patId) : [],
  goals: tableExists("PATIENT_GOALS") ? children("PATIENT_GOALS", "PAT_ID", patId) : [],
  patient_documents: tableExists("PATIENT_DOCS") ? children("PATIENT_DOCS", "PAT_ID", patId) : [],
  // Patient-level children (Batch 1)
  relationship_list: (() => {
    const rels = tableExists("PAT_RELATIONSHIP_LIST") ? children("PAT_RELATIONSHIP_LIST", "PAT_ID", patId) : [];
    for (const rel of rels) attachChildren(rel, rel.PAT_RELATIONSHIP_ID, patRelChildren);
    return rels;
  })(),
  additional_addresses: tableExists("PAT_ADDL_ADDR_INFO") ? children("PAT_ADDL_ADDR_INFO", "PAT_ID", patId) : [],
  medication_history: tableExists("PAT_MEDS_HX") ? children("PAT_MEDS_HX", "PAT_ID", patId) : [],
  account_coverage: tableExists("PAT_ACCT_CVG") ? children("PAT_ACCT_CVG", "PAT_ID", patId) : [],
  primary_location: tableExists("PAT_PRIM_LOC") ? children("PAT_PRIM_LOC", "PAT_ID", patId) : [],
  other_communications: tableExists("OTHER_COMMUNCTN") ? children("OTHER_COMMUNCTN", "PAT_ID", patId) : [],
  questionnaire_answers: tableExists("QUESR_LST_ANS_INFO") ? children("QUESR_LST_ANS_INFO", "PAT_ID", patId) : [],
  questionnaire_temp_answers: tableExists("QUESR_TEMP_ANSWERS") ? children("QUESR_TEMP_ANSWERS", "PAT_ID", patId) : [],
  mychart_patient: tableExists("MYC_PATIENT") ? children("MYC_PATIENT", "PAT_ID", patId) : [],
  problem_list_reviewed: tableExists("PROB_LIST_REVIEWED") ? children("PROB_LIST_REVIEWED", "PAT_ID", patId) : [],
  patient_goals_info: tableExists("PT_GOALS_INFO") ? children("PT_GOALS_INFO", "PAT_ID", patId) : [],
  external_data_last_done: tableExists("EXT_DATA_LAST_DONE") ? children("EXT_DATA_LAST_DONE", "PAT_ID", patId) : [],
  anticoag_self_regulating: tableExists("ANTICOAG_SELF_REGULATING") ? children("ANTICOAG_SELF_REGULATING", "PAT_ID", patId) : [],
  claims_derive_pat_flags: tableExists("CLAIMS_DERIVE_PAT_FLAGS") ? children("CLAIMS_DERIVE_PAT_FLAGS", "PAT_ID", patId) : [],
  community_resource_reviewed: tableExists("COMMUNITY_RESRC_REVIEWED") ? children("COMMUNITY_RESRC_REVIEWED", "PAT_ID", patId) : [],
  hm_enc_date: tableExists("HM_ENC_DATE") ? children("HM_ENC_DATE", "PAT_ID", patId) : [],
  immunization_last_review: tableExists("IMMNZTN_LAST_REVIEW") ? children("IMMNZTN_LAST_REVIEW", "PAT_ID", patId) : [],
  lines_drains_list: tableExists("LINES_DRAINS_LIST") ? children("LINES_DRAINS_LIST", "PAT_ID", patId) : [],
  meds_review_last_list: tableExists("MEDS_REV_LAST_LIST") ? children("MEDS_REV_LAST_LIST", "PAT_ID", patId) : [],
  coverage_file_order: tableExists("PAT_CVG_FILE_ORDER") ? children("PAT_CVG_FILE_ORDER", "PAT_ID", patId) : [],
  residence_code: tableExists("PAT_RES_CODE") ? children("PAT_RES_CODE", "PAT_ID", patId) : [],
  teeth_reviewed: tableExists("TEETH_REVIEWED") ? children("TEETH_REVIEWED", "PAT_ID", patId) : [],
  claim_filter_static: tableExists("V_EHI_CLM_FILTER_STATIC") ? children("V_EHI_CLM_FILTER_STATIC", "PAT_ID", patId) : [],
  encounters: encounterCSNs.map(projectEncounter),
  billing: projectBilling(patId),
  messages: projectMessages(patId),
  conversation_threads: projectConversationThreads(patId),
  documents: projectDocuments(patId),
  episodes: projectEpisodes(patId),
};

console.timeEnd("projection");

// Count tables touched
const tablesUsed = new Set<string>();
const allTables = q("SELECT name FROM sqlite_master WHERE type='table'").map(r => r.name as string);
for (const t of allTables) {
  // Check if we reference this table anywhere in our specs or direct queries
  const count = (db.query(`SELECT COUNT(*) as n FROM "${t}"`).get() as {n: number}).n;
  if (count > 0) tablesUsed.add(t);
}

// Actually count what we used by tracking
const specTables = new Set<string>();
for (const specs of [encounterChildren, orderChildren, noteChildren, txChildren,
  referralChildren, problemChildren, allergyChildren, coverageChildren, medChildren, immuneChildren,
  remitChildren, harChildren, acctChildren, claimChildren]) {
  for (const s of specs) specTables.add(s.table);
}
// Add root tables
for (const t of ['PATIENT', 'PAT_ENC', 'ORDER_PROC', 'ORDER_MED', 'HNO_INFO',
  'ARPB_TRANSACTIONS', 'ACCOUNT', 'ARPB_VISITS', 'HAR_ALL', 'MYC_MESG',
  'REFERRAL', 'COVERAGE', 'CLM_VALUES', 'HSP_ACCOUNT', 'CL_REMIT',
  'ALLERGY', 'PROBLEM_LIST', 'IMMUNE', 'SOCIAL_HX', 'SURGICAL_HX',
  'FAMILY_HX_STATUS', 'DOC_INFORMATION', 'EPISODE', 'PAT_EPISODE',
  'PATIENT_MYC', 'MSG_TXT', 'MYC_CONVO', 'INVOICE', 'ORDER_PARENT_INFO',
  'IP_DATA_STORE', 'IP_FLWSHT_REC', 'PAT_ENC_HSP', 'PAT_ENC_APPT',
  'PAT_ENC_DISP', 'CLAIM_INFO', 'MYC_MESG_RTF_TEXT', 'MYC_MESG_CHILD',
  'MYC_MESG_QUESR_ANS', 'MYC_CONVO_MSGS', 'MYC_CONVO_VIEWERS',
  'MYC_CONVO_USERS', 'MYC_CONVO_ENCS', 'MYC_CONVO_AUDIENCE',
  'IB_MESSAGE_THREAD', 'IP_FLOWSHEET_ROWS', 'IP_FLWSHT_MEAS',
  'DOCS_RCVD_ALGS_CMT',
  // Batch 1: Patient-level tables
  'PAT_RELATIONSHIP_LIST', 'PAT_ADDL_ADDR_INFO', 'PAT_MEDS_HX', 'PAT_ACCT_CVG',
  'PAT_PRIM_LOC', 'OTHER_COMMUNCTN', 'QUESR_LST_ANS_INFO', 'QUESR_TEMP_ANSWERS',
  'MYC_PATIENT', 'PROB_LIST_REVIEWED', 'PT_GOALS_INFO', 'EXT_DATA_LAST_DONE',
  'ANTICOAG_SELF_REGULATING', 'CLAIMS_DERIVE_PAT_FLAGS', 'COMMUNITY_RESRC_REVIEWED',
  'HM_ENC_DATE', 'IMMNZTN_LAST_REVIEW', 'LINES_DRAINS_LIST', 'MEDS_REV_LAST_LIST',
  'PAT_CVG_FILE_ORDER', 'PAT_RES_CODE', 'TEETH_REVIEWED', 'V_EHI_CLM_FILTER_STATIC',
  // Batch 1: Message children
  'MYC_MESG_CNCL_RSN', 'MYC_MESG_ORD_ITEMS',
  // Batch 1: Episode children
  'ALL_EPISODE_CSN_LINKS', 'EPISODE_ALL', 'PEF_NTFY_INSTR', 'RECURRING_BILLING_INFO', 'V_EHI_HSB_LINKED_PATS',
]) specTables.add(t);
// Add split tables
for (const [, info] of Object.entries(splitConfig as Record<string, {members: Array<{table: string}>}>)) {
  for (const m of info.members) specTables.add(m.table);
}
// Add lookups
for (const t of ['CLARITY_EDG', 'CLARITY_SER', 'CLARITY_DEP', 'CLARITY_EAP',
  'CLARITY_EMP', 'CLARITY_LOC',
  // Batch 3 lookup tables
  'CLARITY_COMPONENT', 'CLARITY_HM_TOPIC', 'CLARITY_IMMUNZATN',
  'CLARITY_RMC', 'CLARITY_MOD', 'CLARITY_SA', 'CLARITY_LLB',
  'CLARITY_NRG', 'CLARITY_MEDICATION',
  'CLARITY_EEP', 'CLARITY_EPM', 'CLARITY_EPP', 'CLARITY_FSC',
  'CLARITY_LOT', 'CLARITY_PRC',
]) specTables.add(t);
// PAT_RELATIONSHIP detail tables (children of PAT_RELATIONSHIP_LIST, keyed on PAT_RELATIONSHIP_ID + LINE)
// These will be wired as sub-children once PAT_RELATIONSHIP_LIST is attached.
// PAT_REL_ADDR is the exception: keyed on PAT_ID + GROUP_LINE + VALUE_LINE
for (const t of [
  'PAT_REL_PHONE_NUM', 'PAT_RELATIONSHIP_ADDR', 'PAT_REL_CONTEXT',
  'PAT_REL_EMAIL_ADDR', 'PAT_REL_LANGUAGES', 'PAT_REL_ADDR',
  'PAT_REL_SPEC_NEEDS', 'PAT_RELATIONSHIP_LIST_HX',
]) specTables.add(t);

// Batch 4: Remaining uncovered tables — organized by domain
for (const t of [
  // Claims/billing children (CLAIM_ID → CLAIM_INFO, or RECORD_ID → CLM_VALUES)
  'CLM_ALL', 'CLM_INJURY_DESC', 'CLM_OTHER_DXS',
  'RECONCILE_CLM_OT', 'RECONCILE_CLAIM_STATUS',
  // Benefits cluster (RECORD_ID → BENEFITS)
  'BENEFITS', 'SERVICE_BENEFITS', 'COVERAGE_BENEFITS', 'BENEFIT_SVC_TYPE',
  // HSP claim print children (CLAIM_PRINT_ID → HSP_CLAIM_PRINT)
  'CLP_VALUE_DATA', 'CLP_NY_MEDICAID_INFO',
  // Billing denial (BDC) cluster
  'BDC_INFO', 'BDC_ASSOC_REMARK_CODES', 'HSP_BDC_DENIAL_DATA', 'HSP_BDC_PAYOR', 'HSP_BDC_RECV_TX',
  // Flowsheet children (FSD_ID → IP_FLWSHT_MEAS, INPATIENT_DATA_ID → IP_DATA_STORE)
  'IP_FLO_GP_DATA', 'IP_FLOW_DATERNG', 'IP_FLWSHT_EDITED', 'IP_FLT_DATA',
  'IP_ORDER_REC', 'IP_ORD_UNACK_PLAC', 'IP_FREQUENCY', 'IP_LDA_INPS_USED',
  'IP_LDA_NOADDSINGLE', 'FLWSHT_SINGL_COL',
  // Communication preferences cluster (PREFERENCES_ID)
  'COMMUNICATION_PREFERENCES', 'COMM_PREFERENCES_APRV', 'COMM_PREF_ADDL_ITEMS',
  // Medication coverage cluster (MED_ESTIMATE_ID)
  'MED_CVG_INFO', 'MED_CVG_DETAILS', 'MED_CVG_ESTIMATE_VALS', 'MED_CVG_RESPONSE_RSLT',
  'MED_CVG_RESP_RSLT_DETAIL', 'MED_CVG_STATUS_DETAILS', 'MED_CVG_ALTERNATIVES',
  'MED_CVG_DX_VALUE', 'MED_CVG_USERACTION',
  // Care plan / goals / episodes
  'CAREPLAN_PT_TASK_INFO', 'CAREPLAN_CNCT_INFO', 'CARE_INTEGRATOR', 'CARE_PATH',
  'GOAL', 'GOAL_CONTACT', 'GOAL_TEMPLATES', 'PT_GOALS_UPDATES',
  'EPISODE_DEF', 'EPISODE_OT', 'RAD_THERAPY_EPISODE_INFO',
  'CATARACT_PLANNING_GOALS', 'CATARACT_PLANNING_INFO', 'OCCURRENCE_CODES',
  // Timeout / screening
  'TIMEOUT', 'TIMEOUT_ANSWERS', 'FRM_STATUS',
  // MDL (medication decision list)
  'MDL_HISTORY', 'MDL_MD_PRBLM_LIST',
  // SDD (SDOH data)
  'SDD_ENTRIES', 'SDOH_DOM_CONFIG_INFO',
  // Universal charge line children (UCL_ID)
  'UNIV_CHG_LN_MSG_HX', 'UNIV_CHG_LN_DX', 'UNIV_CHG_LN_MOD', 'UCL_NDC_CODES',
  // Miscellaneous patient/encounter-related
  'ALLERGY_FLAG', 'APPT_REQUEST', 'ED_IEV_EVENT_INFO', 'HM_PLAN_INFO',
  'IDENTITY_ID_TYPE', 'MEDICAL_COND_INFO', 'NOTES_TRANS_AUTH',
  'PERSON_PREFERENCES', 'REPORT_SETTINGS',
  // Invoice children
  'INV_CLM_ICN', 'INV_NDC_INFO',
  // Lookup / reference tables
  'CLARITY_LWS', 'CL_COL_AGNCY', 'CL_ELG', 'CL_LQH', 'CL_OTL',
  'CL_QANSWER', 'CL_QANSWER_OVTM', 'CL_QFORM1', 'CL_QQUEST_OVTM',
  'CL_RSN_FOR_VISIT', 'CL_UB_REV_CODE',
  'REFERRAL_SOURCE', 'RX_PHR', 'RX_MED_TWO', 'RX_NDC',
  'LNC_DB_MAIN', 'GEO_REGION', 'ORG_DETAILS', 'MEDICATION_LOT',
  'SMARTTEXT', 'TASK_INFO', 'NAMES', 'V_BIL_ALL',
  // Remaining small/config tables
  'ALT_BPA_ACT_TASK',
  // Batch 5: Tables queried directly or used in joins but not yet in specTables
  // Account/guarantor
  'ACCT_GUAR_PAT_INFO',
  // Care plan enrollment
  'CAREPLAN_ENROLLMENT_INFO', 'CAREPLAN_INFO',
  // Claim print children (CLP/HSP_CLP)
  'CLP_NON_GRP_TX_IDS', 'CLP_OCCUR_DATA',
  'HSP_CLAIM_DETAIL1', 'HSP_CLAIM_DETAIL2',
  'HSP_CLP_CMS_LINE', 'HSP_CLP_CMS_TX_PIECES', 'HSP_CLP_DIAGNOSIS',
  'HSP_CLP_REV_CODE', 'HSP_CLP_UB_TX_PIECES',
  // Documents received/linked
  'DOCS_RCVD_ALGS', 'DOCS_RCVD_ALG_REAC', 'DOCS_RCVD_ASMT', 'DOCS_RCVD_PROC',
  'DOC_CSN_REFS', 'DOC_INFO_DICOM', 'DOC_LINKED_PATS', 'DOC_LINKED_PAT_CSNS',
  // Health maintenance
  'HM_FORECAST_INFO', 'HM_HISTORICAL_STATUS', 'HM_HISTORY',
  // Identity
  'IDENTITY_ID',
  // Invoice children
  'INV_BASIC_INFO', 'INV_CLM_LN_ADDL', 'INV_DX_INFO',
  'INV_NUM_TX_PIECES', 'INV_PMT_RECOUP', 'INV_TX_PIECES',
  // Medication review
  'MEDS_REV_HX',
  // MyChart conversation about
  'MYC_CONVO_ABT_CUST_SVC', 'MYC_CONVO_ABT_MED_ADVICE',
  // Patient-level detail tables
  'PATIENT_ALG_UPD_HX', 'PATIENT_ALIAS', 'PATIENT_DOCS', 'PATIENT_GOALS',
  'PATIENT_HMT_STATUS', 'PATIENT_RACE',
  'PAT_ADDRESS', 'PAT_ADDR_CHNG_HX', 'PAT_ALLERGIES', 'PAT_EMAILADDRESS',
  'PAT_HM_CUR_GUIDE', 'PAT_IMMUNIZATIONS', 'PAT_PCP', 'PAT_PREF_PHARMACY',
  'PAT_PROBLEM_LIST', 'PAT_RCNT_USD_PHRMS', 'PAT_RELATIONSHIPS',
  // Problem list review
  'PROB_LIST_REV_HX',
]) specTables.add(t);

const existingSpecTables = [...specTables].filter(t => allTables.includes(t));
console.log(`Tables referenced: ${existingSpecTables.length} / ${allTables.length} (${Math.round(100*existingSpecTables.length/allTables.length)}%)`);

// Write output
await Bun.write(OUT_PATH, JSON.stringify(doc, null, 2));
const stat = Bun.file(OUT_PATH);
console.log(`Written: ${OUT_PATH} (${Math.round((await stat.size) / 1024)} KB)`);

// Also hydrate and print summary
const record = loadPatientRecord(doc);
console.log("\n" + record.summary());

db.close();
