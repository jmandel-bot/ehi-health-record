# Epic EHI → HealthRecord: Technical Debt + Complete Mapping Roadmap

## Current State

```
550 tables → 369 covered (67%) → 181 uncovered
9,479 columns → 3,871 with data → 3,035 in covered tables (78% of data columns)
10,974 rows total

Pipeline: TSV → SQLite → patient_record.json (6.7 MB) → health_record.json (70 KB / 534 KB)
146 tests pass, 0 failures
```

---

## Phase 0: Technical Debt (before extending coverage)

### 0.1 Project scaffolding
- [ ] Add `package.json` with bun types, `tsconfig.json`
- [ ] Add a `Makefile` or `justfile`: `load` → `project` → `test` → `health-record`
- [ ] Document setup: "clone data repo, symlink tsv/ and schemas/, run load, run project"
- [ ] Remove stale reference to `project_json.py` in PatientRecord.ts docstring

### 0.2 Multi-patient correctness
- [ ] `SOCIAL_HX`, `SURGICAL_HX`, `FAMILY_HX_STATUS`: add `WHERE PAT_ID = ?` via bridge or direct join (currently `SELECT *`)
- [ ] `COVERAGE`: join through bridge table (probably `PAT_ACCT_CVG` or encounter linkage)
- [ ] `CL_REMIT`: filter via billing chain (remittances → transactions → accounts → patient)
- [ ] `CLM_VALUES`: same billing chain filter
- [ ] `DOC_INFORMATION`: filter via `DOC_LINKED_PATS` bridge
- [ ] Audit every `SELECT *` without PAT_ID filter; add a lint/test that flags them

### 0.3 RTF text extraction
- [ ] `MYC_MESG_RTF_TEXT` has 337 rows across 37 messages (column is `RTF_TXT`, not `RTF_TEXT`)
- [ ] 37 messages have RTF only, no plain text — these are currently invisible
- [ ] Add RTF→plaintext stripping (strip `{\rtf1...}` control words, extract text runs)
- [ ] Wire into Message.plainText and HealthRecord message.body
- [ ] Consider: some notes may also have RTF-only content (check HNO tables)

### 0.4 Flowsheet / vitals gap
- [ ] **The actual measurement values are NOT in this export.** `IP_FLWSHT_MEAS` has metadata (who recorded, when, which template) but no `MEAS_VALUE` column. The schema confirms this — Epic's EHI export for this table only includes metadata columns, not the numeric values.
- [ ] The 88 flowsheet row names include clinically important items: BP, Pulse, Weight, Height, BMI, PHQ-2 scores — but all values are null/absent.
- [ ] Wire up what we can: encounter↔flowsheet linkage via `IP_DATA_STORE.EPT_CSN` for provenance ("vitals were recorded during this visit") even without values.
- [ ] Document this as a known EHI export limitation. Flag it in HealthRecord as `vitalSigns: []` with a comment.
- [ ] Investigate: do other EHI exports include values? This may be institution-specific redaction.

### 0.5 Test hardening
- [ ] Add hydration round-trip test: `project → JSON → loadPatientRecord → projectHealthRecord → validate fields`
- [ ] Add HealthRecord schema validation (check every field is correct type, no undefined where null expected)
- [ ] Add coverage regression test: assert minimum table/column coverage counts
- [ ] Move audit.ts into a proper coverage report that runs as part of the test suite

### 0.6 Type safety
- [ ] `src/HealthRecord.ts` uses `type R = any` for PatientRecord — replace with actual import
- [ ] `EpicRow = Record<string, unknown>` on untyped child arrays — add at least structural types for high-value children (diagnoses, results, medications)
- [ ] The `epic()` helper strips arrays/objects from _epic — intentional, but loses nested children; document or reconsider

---

## Phase 1: Low-Hanging Fruit (28 PAT_ID tables, ~48 rows)

These tables have `PAT_ID` as a direct FK. Adding them is mechanical:
read schema, decide parent, add ChildSpec or direct query.

### 1.1 Patient-level extensions (trivial — just `children(table, "PAT_ID", patId)`)
- [ ] `PAT_RELATIONSHIP_LIST` (2 rows, 13 cols) — emergency contacts, guardians
- [ ] `PAT_ADDL_ADDR_INFO` (3 rows) — additional address fields
- [ ] `PAT_MEDS_HX` (4 rows) — medication history annotations
- [ ] `PAT_ACCT_CVG` (2 rows) — patient↔account↔coverage links
- [ ] `PAT_PRIM_LOC` (1 row) — primary location details
- [ ] `OTHER_COMMUNCTN` (4 rows) — other communication records
- [ ] `QUESR_LST_ANS_INFO` (3 rows), `QUESR_TEMP_ANSWERS` (2 rows) — questionnaire answers
- [ ] `MYC_PATIENT` (1 row) — MyChart patient settings
- [ ] `PROB_LIST_REVIEWED` (1 row) — problem list review timestamp
- [ ] `PT_GOALS_INFO` (1 row, 15 cols) — patient goals
- [ ] `EXT_DATA_LAST_DONE` (1 row, 13 cols) — external data timestamps
- [ ] Remaining 1-row PAT_ID tables: `ANTICOAG_SELF_REGULATING`, `CLAIMS_DERIVE_PAT_FLAGS`, `COMMUNITY_RESRC_REVIEWED`, `HM_ENC_DATE`, `IMMNZTN_LAST_REVIEW`, `LINES_DRAINS_LIST`, `MEDS_REV_LAST_LIST`, `PAT_CVG_FILE_ORDER`, `PAT_RES_CODE`, `TEETH_REVIEWED`, `V_EHI_CLM_FILTER_STATIC`

### 1.2 Encounter-level (CLARITY_ADT)
- [ ] `CLARITY_ADT` (4 rows, 21 cols) — ADT events (admit/discharge/transfer). Has PAT_ID + CSN. High clinical value.
- [ ] `IP_LDA_NOADDSINGLE` (1 row, 15 cols) — inpatient lines/drains/airways. Has PAT_ID + CSN.

### 1.3 Relationship detail tables
- [ ] `PAT_REL_PHONE_NUM` (6 rows), `PAT_RELATIONSHIP_ADDR` (2 rows), `PAT_REL_CONTEXT` (2 rows), `PAT_REL_EMAIL_ADDR` (2 rows), `PAT_REL_LANGUAGES` (2 rows), `PAT_REL_ADDR` (1 row), `PAT_REL_SPEC_NEEDS` (1 row), `PAT_RELATIONSHIP_LIST_HX` (2 rows) — all children of PAT_RELATIONSHIP_LIST

---

## Phase 2: Deepen Existing Entities (45 tables, ~280 rows)

These tables have recognized FKs pointing to entities we already model.

### 2.1 Order children (7 tables, 8 rows)
- [ ] `MEDICATION_COST_ESTIMATES` (2 rows) — cost info per order
- [ ] `FINALIZE_PHYSICIAN` (1 row) — finalizing physician
- [ ] `ORDER_MODALITY_TYPE` (1 row) — imaging modality
- [ ] `ORDER_RPTD_SIG_INSTR` (1 row) — reported signature instructions
- [ ] `ORD_RSLT_COMPON_ID` (1 row) — result component IDs
- [ ] `RIS_SGND_INFO` (1 row) — radiology signing info
- [ ] `SPEC_SOURCE_SNOMED` (1 row) — specimen SNOMED codes

### 2.2 Medication children (2 tables, 6 rows)
- [ ] `ORDER_RXVER_NOADSN` (4 rows) — Rx verification
- [ ] `ORD_MED_ADMININSTR` (2 rows) — admin instructions

### 2.3 Message children (3 tables, 54 rows)
- [ ] `UNIV_CHG_LN_MSG_HX` (47 rows) — charge line message history
- [ ] `MYC_MESG_CNCL_RSN` (6 rows) — message cancellation reasons
- [ ] `MYC_MESG_ORD_ITEMS` (1 row) — message order items

### 2.4 Coverage children (6 tables, 7 rows)
- [ ] `CVG_ACCT_LIST` (2 rows) — coverage↔account links
- [ ] `COVERAGE_COPAY_ECD` (1 row) — copay details
- [ ] `COVERAGE_MEMBER_LIST` (1 row, 10 cols) — member enrollment
- [ ] `COVERAGE_SPONSOR` (1 row) — sponsor info
- [ ] `CVG_AP_CLAIMS` (1 row) — associated claims
- [ ] `CVG_SUBSCR_ADDR` (1 row) — subscriber address

### 2.5 Hospital account children (HSP_BKT_*, 8 tables, 48 rows)
- [ ] `HSP_BKT_ADDTL_REC` (13 rows) — bucket additional records
- [ ] `HSP_BKT_NAA_ADJ_HX` (9 rows) — NAA adjustment history
- [ ] `HSP_BKT_ADJ_TXS` (5 rows) — bucket adjustment transactions
- [ ] `HSP_BKT_PAYMENT` (2 rows) — bucket payments
- [ ] `HSP_BKT_INV_NUM`, `HSP_BKT_NAA_HX_HTR`, `HSP_BKT_NAA_TX_TYP` (1 row each)
- [ ] `RECONCILE_CLM` (16 rows) — claim reconciliation. FK: HSP_ACCOUNT_ID.

### 2.6 Episode children (5 tables, 6 rows)
- [ ] `ALL_EPISODE_CSN_LINKS` (2 rows) — episode↔encounter links
- [ ] `EPISODE_ALL` (1 row) — episode overview
- [ ] `PEF_NTFY_INSTR` (1 row) — notification instructions
- [ ] `RECURRING_BILLING_INFO` (1 row) — recurring billing
- [ ] `V_EHI_HSB_LINKED_PATS` (1 row) — linked patients

### 2.7 Problem children (1 table)
- [ ] `PROBLEM_LIST_HX` (2 rows, 15 cols) — problem list change history

### 2.8 Document / Immunization children (5 tables, 30 rows)
- [ ] `DOCS_RCVD_ALG_REAC` (10 rows) — received allergy reactions (DOCUMENT_ID FK)
- [ ] `MED_DISPENSE_SIG` (7 rows) — medication dispensing signatures
- [ ] `DOCS_RCVD_ALGS_CMT` (6 rows) — received allergy comments
- [ ] `IMM_ADMIN_GROUPS_FT` (4 rows) — immunization admin group free text
- [ ] `DOC_LINKED_PAT_CSNS` (3 rows) — document↔patient CSN links

### 2.9 Transaction children (2 tables, 3 rows)
- [ ] `BDC_PB_CHGS` (2 rows) — billing denial charges
- [ ] `ARPB_PMT_RELATED_DENIALS` (1 row) — payment-related denials

---

## Phase 3: Claim/Benefits Domain (9 tables, ~198 rows)

These tables have `RECORD_ID` or similar FKs pointing into the claims hierarchy.
They're children of `CLM_VALUES` or `COVERAGE_BENEFITS`.

- [ ] `SERVICE_BENEFITS` (126 rows, 13 cols) — the biggest uncovered table. Likely FK: RECORD_ID → CLM_VALUES or coverage benefit ID.
- [ ] `COVERAGE_BENEFITS` (18 rows, 20 cols) — coverage benefit details. FK: possibly COVERAGE_ID + RECORD_ID.
- [ ] `BENEFITS` (13 rows) — benefit records. Has PAT_ID.
- [ ] `LNC_DB_MAIN` (24 rows) — LOINC database for lab components? Or claim line detail.
- [ ] `CL_LQH` (13 rows) — claim line queue history
- [ ] `BENEFIT_SVC_TYPE` (14 rows) — benefit service types
- [ ] `EXT_CAUSE_INJ_DX` (1 row) — external cause of injury diagnosis
- [ ] `NAMES` (1 row) — claim-level name record
- [ ] `CLM_OTHER_DXS` (5 rows), `CLM_ALL` (2 rows), `CLM_INJURY_DESC` (2 rows) — claim detail children

Read schemas to determine exact FK relationships. Some may be children of `CLM_VALUES`,
others may be children of `COVERAGE` or `HSP_ACCOUNT`.

---

## Phase 4: Lookup / Reference Tables (16 uncovered CLARITY_* tables)

These resolve IDs to human-readable names. Add as needed when processing
tables that reference them.

- [ ] `CLARITY_COMPONENT` (23 rows) — lab component names. **High priority**: needed to resolve flowsheet component IDs and potentially ORDER_RESULTS component names.
- [ ] `CLARITY_HM_TOPIC` (23 rows) — health maintenance topic names
- [ ] `CLARITY_IMMUNZATN` (18 rows) — immunization names (may duplicate IMMUNZATN_ID_NAME already denormalized)
- [ ] `CLARITY_RMC` (7 rows) — remittance code names
- [ ] `CLARITY_ADT` — **already listed in Phase 1** (not just a lookup; has ADT events)
- [ ] `CLARITY_MOD` (4 rows) — modifier codes
- [ ] `CLARITY_SA` (4 rows) — service area names
- [ ] `CLARITY_LLB` (4 rows) — lab names
- [ ] `CLARITY_NRG` (3 rows) — imaging/procedure category
- [ ] `CLARITY_MEDICATION` (2 rows) — medication names
- [ ] Single-row lookups: `CLARITY_EEP`, `CLARITY_EPM`, `CLARITY_EPP`, `CLARITY_FSC`, `CLARITY_LOT`, `CLARITY_PRC`

---

## Phase 5: Miscellaneous / Specialty Tables (~105 UNKNOWN-FK tables)

These tables lack a recognized FK column. Most are small (1-4 rows) or are
reference/config tables. Strategy: read schema descriptions, identify FK,
wire up or explicitly skip.

### 5.1 Higher-value (>10 rows or clinically relevant)
- [ ] `RECONCILE_CLM_OT` (113 rows) — claim reconciliation detail. Likely child of RECONCILE_CLAIM_STATUS or HSP_ACCOUNT.
- [ ] `RECONCILE_CLAIM_STATUS` (91 rows) — claim reconciliation statuses
- [ ] `IP_FLWSHT_EDITED` (19 rows) — flowsheet edit history. Child of IP_FLWSHT_MEAS (has FSD_ID + EDITED_LINE).
- [ ] `IP_FLOW_DATERNG` (31 rows) — flowsheet date ranges
- [ ] `IP_ORD_UNACK_PLAC` (19 rows) — unacknowledged order placements
- [ ] `HM_PLAN_INFO` (23 rows) — health maintenance plan info
- [ ] `COMMUNICATION_PREFERENCES` (19 rows) + `COMM_PREFERENCES_APRV` (40 rows) — patient communication prefs
- [ ] `UNIV_CHG_LN_DX` (32 rows), `UNIV_CHG_LN_MOD` (10 rows) — universal charge line details
- [ ] `SDD_ENTRIES` (9 rows) — structured data entries
- [ ] `ED_IEV_EVENT_INFO` (6 rows) — ED event info

### 5.2 Reference/config (skip or wire opportunistically)
- [ ] `CL_RSN_FOR_VISIT` (15 rows) — reason-for-visit code lookup
- [ ] `CL_OTL` (15 rows) — order transmittal log
- [ ] `REPORT_SETTINGS` (19 rows) — report configuration
- [ ] `APPT_REQUEST` (16 rows) — appointment requests
- [ ] Questionnaire config: `CL_QANSWER` (7), `CL_QANSWER_OVTM` (7), `CL_QFORM1` (5), `CL_QQUEST_OVTM` (5)
- [ ] Med coverage response: `MED_CVG_DETAILS` (4), `MED_CVG_ESTIMATE_VALS` (4), `MED_CVG_RESPONSE_RSLT` (4), `MED_CVG_RESP_RSLT_DETAIL` (2), `MED_CVG_STATUS_DETAILS` (2), `MED_CVG_ALTERNATIVES` (1), `MED_CVG_DX_VALUE` (1), `MED_CVG_USERACTION` (1)
- [ ] Billing denial: `BDC_INFO` (2), `HSP_BDC_DENIAL_DATA` (2), `HSP_BDC_PAYOR` (2), `BDC_ASSOC_REMARK_CODES` (1), `HSP_BDC_RECV_TX` (1)
- [ ] Goals: `GOAL` (1), `GOAL_CONTACT` (1), `GOAL_TEMPLATES` (1)
- [ ] Careplan: `CAREPLAN_PT_TASK_INFO` (4), `CAREPLAN_CNCT_INFO` (2), `CARE_INTEGRATOR` (4), `CARE_PATH` (1)
- [ ] Invoice detail: `INV_CLM_ICN` (1), `INV_NDC_INFO` (1)
- [ ] ~40 more single-row config/metadata tables (individually low-value)

### 5.3 Explicitly excluded (document why)
- [ ] Create `EXCLUDED_TABLES.md` documenting tables intentionally skipped and why:
  - System config tables with no patient data
  - Tables whose entire data column set is null (metadata-only rows)
  - Tables duplicating data available elsewhere

---

## Phase 6: HealthRecord Clean Projection Expansion

After wiring up raw projection coverage, promote new data into clean HealthRecord fields.

### 6.1 Existing sections to enrich
- [ ] `demographics.emergencyContacts` — from PAT_RELATIONSHIP_LIST + detail tables
- [ ] `demographics.race` — already projected in _epic but not parsed into the clean `race: []` array
- [ ] `visits[].vitalSigns` — document as empty due to EHI limitation; wire provenance
- [ ] `medications[].costEstimate` — from MEDICATION_COST_ESTIMATES
- [ ] `immunizations[].administration` — from IMM_ADMIN detail

### 6.2 New sections
- [ ] `coverage` — insurance/coverage details (currently raw EpicRow[], not in HealthRecord)
- [ ] `referrals` — currently raw EpicRow[], not in HealthRecord
- [ ] `documents` — clinical documents (DOC_INFORMATION)
- [ ] `episodes` — episodes of care
- [ ] `communicationPreferences` — patient communication preferences
- [ ] `goals` — patient goals from PT_GOALS_INFO
- [ ] `questionnaires` — questionnaire responses

### 6.3 Cross-reference enrichment
- [ ] Link billing charges to specific visit diagnoses (ARPB_CHG_ENTRY_DX → DX_ID → name)
- [ ] Link claims to service lines with procedure names
- [ ] Add `visit.billingCharges` convenience accessor

---

## Execution Order

```
 Phase 0  ─── Technical debt cleanup ──────────── 1-2 days
    ↓
 Phase 1  ─── PAT_ID tables (mechanical)  ─────── half day
    ↓
 Phase 2  ─── Deepen existing entities ───────── 1 day
    ↓
 Phase 3  ─── Claims/benefits domain ─────────── half day (schema reading)
    ↓
 Phase 4  ─── Lookup tables (as needed) ──────── ongoing
    ↓
 Phase 5  ─── Miscellaneous (schema triage) ──── 1 day
    ↓
 Phase 6  ─── HealthRecord expansion ─────────── 1-2 days
```

After all phases:
- 550/550 tables either covered or explicitly excluded
- HealthRecord exposes all clinically meaningful data
- Every `SELECT *` has a PAT_ID filter
- RTF text extracted
- Flowsheet limitation documented
- Test suite covers every new table/relationship

---

## Key Numbers

| Metric | Now | After Phase 2 | After Phase 5 |
|--------|-----|---------------|----------------|
| Tables covered | 369/550 (67%) | ~440/550 (80%) | 550/550 (100%) |
| Data columns reached | 3,035/3,871 (78%) | ~3,500 (90%) | 3,871 (100%) |
| HealthRecord clean fields | 128 | ~150 | ~180 |
| Message text coverage | 26/63 (41%) | 63/63 (100%) | 63/63 (100%) |
| Multi-patient safe | No | Yes | Yes |
