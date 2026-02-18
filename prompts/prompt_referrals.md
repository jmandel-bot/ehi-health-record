You are reviewing an Epic EHI data mapping for semantic correctness. Before analyzing the specific mapping below, read the full data model documentation and mapping philosophy — it is essential context for understanding relationship types, CSN semantics, and structural decisions.

## Data Model & Mapping Philosophy

The following is extracted from the projector's documentation. It defines the three relationship types (structural child, cross-reference, provenance stamp), explains CSN semantics, the order parent→child chain, billing as a parallel hierarchy, and the mapping philosophy. **Use this to evaluate whether structural decisions in the code below are correct.**

<methodology>
# Epic EHI Data Model

500-600 TSV files, each representing one database table. There are no
foreign key constraints in the export — relationships are implicit.


## 1. TABLE SPLITTING
Epic splits wide tables across multiple files with _2, _3, ... suffixes.
PATIENT has 6 files (PATIENT, PATIENT_2..6), PAT_ENC has 7, ORDER_MED
has 7, etc. 27 base tables produce 62 additional split files.

CRITICAL GOTCHA: The primary key column name often changes across splits!
  - ACCOUNT.ACCOUNT_ID → ACCOUNT_2.ACCT_ID → ACCOUNT_3.ACCOUNT_ID
  - ORDER_MED.ORDER_MED_ID → ORDER_MED_2.ORDER_ID
  - COVERAGE.COVERAGE_ID → COVERAGE_2.CVG_ID
  - PAT_ENC base PK is PAT_ID (multi-row) but splits join on PAT_ENC_CSN_ID
    except PAT_ENC_3 which uses PAT_ENC_CSN (no _ID suffix)

The VALUES match, the NAMES don't. split_config.json documents every join
column for all 27 groups. Don't try to infer them — look them up.


## 2. THREE RELATIONSHIP TYPES
Every table in the export fits one of three roles:

a) STRUCTURAL CHILD — lives inside its parent, joined on parent PK.
   Examples: ORDER_RESULTS under ORDER_PROC (on ORDER_PROC_ID),
   ALLERGY_REACTIONS under ALLERGY (on ALLERGY_ID).
   These nest naturally: order.results = [...]

b) CROSS-REFERENCE — has its own identity, points to another entity.
   Example: ARPB_VISITS.PRIM_ENC_CSN_ID points to an encounter.
   The billing visit is NOT owned by the encounter — it's a separate
   entity in a parallel hierarchy. Model as typed ID + accessor method:
     encounter.billingVisit(record) / billingVisit.encounter(record)

c) PROVENANCE STAMP — a CSN on a patient-level record that means
   "this was edited during encounter X", NOT "this belongs to encounter X".
   Example: ALLERGY.ALLERGY_PAT_CSN records which encounter the allergy
   was noted in. Don't nest allergies under encounters — they belong to
   the patient. The CSN is metadata about when/where, not ownership.

The hardest part of mapping a new table is deciding which type it is.
When in doubt, read the Epic column description from schemas/*.json.


## 3. CONTACTS, SERIAL NUMBERS, AND THE CSN

TERMINOLOGY:
  "Contact"       = any recorded interaction with the health system.
                    A clinical visit is a contact. But so is a history
                    review, a phone call, a MyChart message, an admin
                    task, or a lab processing event.
  "Serial Number" = a unique integer Epic assigns to each contact.
  "CSN"           = Contact Serial Number. The unique ID of a contact.

CRITICAL MENTAL MODEL:

  PAT_ENC is the table of ALL contacts — not just clinical visits.
  Each row in PAT_ENC gets a unique CSN (PAT_ENC_CSN_ID). But the
  111 rows in our test patient's PAT_ENC break down as:

    ~30  Clinical visits (have diagnoses, orders, or reasons for visit)
      5  History review contacts (SOCIAL_HX, SURGICAL_HX records)
     76  Other contacts (phone calls, MyChart, admin, metadata-only)

  When a clinician reviews social history during a visit, Epic creates
  TWO contacts on the same date, same provider, same department:

    CSN 799951565  — the clinical visit (3 diagnoses, 1 order, 2 reasons)
    CSN 802802103  — the social history review (0 diagnoses, 0 orders)

  Both are rows in PAT_ENC. The history contact exists to record WHEN
  the history was reviewed. SOCIAL_HX links to both:
    - PAT_ENC_CSN_ID = 802802103 (the history's own contact)
    - HX_LNK_ENC_CSN = 799951565 (the clinical visit it was part of)

  This is why you cannot treat PAT_ENC as "the visits table." Many
  CSNs are system-generated contacts with no clinical content.

WHERE CSN COLUMNS APPEAR AND WHAT THEY MEAN:

  PAT_ENC_CSN_ID    Standard FK to a contact. On child tables
                    (PAT_ENC_DX, ORDER_PROC, HNO_INFO), it means
                    "this record belongs to contact X." On history
                    tables (SOCIAL_HX), it means "this IS contact X."
                    Found on 28+ tables.

  PRIM_ENC_CSN_ID   "Primary encounter CSN." Used in billing (ARPB_VISITS,
                    HAR_ALL). Points to the clinical visit contact,
                    not a system-generated one. This is how billing
                    connects to clinical data.

  HX_LNK_ENC_CSN    "History link encounter CSN." On SOCIAL_HX,
                    SURGICAL_HX, FAMILY_HX_STATUS. Points to the
                    clinical visit where the history was reviewed.
                    Different from PAT_ENC_CSN_ID on the same row.

  NOTE_CSN_ID        The note's OWN contact serial number. Different
                    from PAT_ENC_CSN_ID on HNO_INFO, which tells you
                    which clinical encounter the note belongs to.

  ALLERGY_PAT_CSN    Provenance stamp on ALLERGY: "this allergy was
                    noted during contact X." NOT structural ownership —
                    allergies belong to the patient, not the encounter.

  IMM_CSN            Immunization contact. The contact during which
                    the immunization was administered or recorded.

  MEDS_LAST_REV_CSN  On PATIENT: "encounter where meds were last
                    reviewed." A timestamp-style provenance stamp.

  ALRG_HX_REV_EPT_CSN  "Encounter where allergy history was reviewed."

THE KEY QUESTION WHEN YOU SEE A CSN COLUMN: does it mean
  (a) "this record BELONGS TO this contact"  → structural child
  (b) "this record IS this contact"           → the contact itself
  (c) "this record was TOUCHED during this contact" → provenance stamp
  (d) "this links to the CLINICAL VISIT contact"   → cross-reference
The column name alone doesn't tell you — read the schema description.


## 4. THE ORDER PARENT→CHILD CHAIN (LAB RESULTS)
When a provider orders labs, Epic creates a parent ORDER_PROC. When
the lab runs, Epic spawns a child ORDER_PROC with a different
ORDER_PROC_ID. Results attach to the CHILD order, not the parent.

  ORDER_PROC_ID 945468368  (parent, "LIPID PANEL")
    → ORDER_RESULTS: empty
  ORDER_PROC_ID 945468371  (child, same test)
    → ORDER_RESULTS: CHOLESTEROL=159, HDL=62, LDL=84, TRIG=67, VLDL=13

  ORDER_PARENT_INFO links them:
    PARENT_ORDER_ID=945468368  ORDER_ID=945468371

In our test data, parent and child orders share the same CSN (both
live on the same contact). In larger institutions, the child order
may land on a separate lab-processing contact with a different CSN.
Either way, the ORDER_PROC_ID is always different, and results always
attach to the child's ORDER_PROC_ID.

Without following ORDER_PARENT_INFO, lab results appear disconnected
from the ordering encounter. The Order.allResults(record) method
handles this automatically.


## 5. NOTE LINKING IS INDIRECT
HNO_INFO (notes) has both PAT_ENC_CSN_ID and its own contact CSN.
  - PAT_ENC_CSN_ID = the clinical encounter this note belongs to
  - NOTE_CSN_ID = the note's own contact serial number (internal)

Some notes have NULL PAT_ENC_CSN_ID — these are standalone MyChart
messages, system notifications, or notes not tied to a visit.
Only 57 of 152 notes in our test data link to encounters.
Only 21 of 152 have plain text — the rest may be in RTF format,
were redacted, or are system-generated stubs with metadata only.


## 6. HISTORY TABLES ARE VERSIONED SNAPSHOTS
SOCIAL_HX, SURGICAL_HX, FAMILY_HX_STATUS each have two CSN columns:
  - PAT_ENC_CSN_ID = the history record's own contact CSN (gets own encounter)
  - HX_LNK_ENC_CSN = the clinical encounter where history was reviewed

Each row is a point-in-time snapshot, not a child of any encounter.
They are patient-level versioned records. We model them as
HistoryTimeline<T> with .latest(), .asOfEncounter(csn), .asOfDate(date).


## 7. BRIDGE TABLES FOR PATIENT LINKAGE
Several entity tables store one record per entity (not per patient)
and link to patients through bridge tables:

  ALLERGY ←─── PAT_ALLERGIES ───→ PATIENT (via PAT_ID)
  PROBLEM_LIST ← PAT_PROBLEM_LIST → PATIENT
  IMMUNE ←──── PAT_IMMUNIZATIONS → PATIENT
  ACCOUNT ←─── ACCT_GUAR_PAT_INFO → PATIENT
  HSP_ACCOUNT ← HAR_ALL ──────────→ PATIENT (via PAT_ID + ACCT_ID)

In single-patient exports, you CAN SELECT * and get correct results,
but always join through the bridge for multi-patient correctness.


## 8. CLARITY_* TABLES ARE SHARED LOOKUPS
~23 tables starting with CLARITY_ are reference/dimension tables:
  CLARITY_EDG = diagnoses (DX_ID → DX_NAME)
  CLARITY_SER = providers (PROV_ID → PROV_NAME)
  CLARITY_DEP = departments (DEPARTMENT_ID → DEPARTMENT_NAME)
  CLARITY_EAP = procedures (PROC_ID → PROC_NAME)
  CLARITY_EMP = employees

They're shared across the whole graph — don't nest them anywhere.
Use lookupName() to resolve IDs to display names at projection time.


## 9. BILLING IS A PARALLEL HIERARCHY
Clinical data (PAT_ENC → orders → results) and billing data
(ARPB_TRANSACTIONS → actions → diagnoses → EOB) are parallel trees
connected by cross-references:

  Clinical tree:                    Billing tree:
  PAT_ENC                           ARPB_TRANSACTIONS
    ├── ORDER_PROC                    ├── ARPB_TX_ACTIONS
    │   └── ORDER_RESULTS             ├── ARPB_CHG_ENTRY_DX
    ├── HNO_INFO                      ├── TX_DIAG
    └── PAT_ENC_DX                   └── PMT_EOB_INFO_I/II
                                    ACCOUNT
                cross-ref:           ├── ACCOUNT_CONTACT
  ARPB_VISITS.PRIM_ENC_CSN_ID       └── ACCT_TX
       ↔ PAT_ENC_CSN_ID           HSP_ACCOUNT
                                     ├── HSP_TRANSACTIONS
                                     └── buckets → payments
                                   CLM_VALUES (claims)
                                     └── SVC_LN_INFO
                                   CL_REMIT (remittances)
                                     └── 14 child tables

Don't stuff billing under encounters — it's its own tree.


## 10. EPIC COLUMN DESCRIPTIONS ARE THE ROSETTA STONE
The schemas/*.json files (from open.epic.com) contain natural-language
descriptions for every column. These often include explicit relationship
hints: "frequently used to link to the PATIENT table", "The unique ID of
the immunization record", "The contact serial number associated with the
primary patient contact."

When extending to a new table, ALWAYS read the schema description first.
A human (or LLM) reading descriptions + one sample row can make correct
placement judgments where heuristic FK matching fails.


---

# Mapping Philosophy

## 1. NESTING EXPRESSES OWNERSHIP, NOT ALL RELATIONSHIPS
   Structural children (ORDER_RESULTS under ORDER_PROC) nest directly.
   Cross-references (billing ↔ encounters) use typed IDs + accessor methods.
   Provenance stamps (ALLERGY.ALLERGY_PAT_CSN) are metadata fields.

## 2. CONVENIENCE METHODS LIVE ON THE ENTITY THAT HOLDS THE FK
   encounter.billingVisit(record) — encounter has the CSN, billing visit
   points to it. billingVisit.encounter(record) — reverse direction.
   Both entities carry their own accessor for the relationship.

## 3. THE `record` PARAMETER IS THE INDEX
   Cross-reference accessors take PatientRecord as a parameter so they
   can use O(1) index lookups (encounterByCSN, orderByID). This keeps
   entities serializable and the dependency explicit.

## 4. EpicRow AS ESCAPE HATCH
   We can't type all 550 tables immediately. EpicRow = Record<string, unknown>
   lets child tables land somewhere even before they're fully typed.
   The ChildSpec[] arrays attach children systematically — typing comes later.

## 5. PAT_ID FILTERING FOR MULTI-PATIENT CORRECTNESS
   Every top-level query traces back to PAT_ID, even if the path goes
   through bridge tables (PAT_ALLERGIES, HAR_ALL, ACCT_GUAR_PAT_INFO).
   Single-patient exports happen to work without this, but multi-patient
   databases require it.

## 6. FALLBACK GRACEFULLY
   Every query checks tableExists() before running. If a bridge table is
   missing, fall back to SELECT * (correct for single-patient exports).
   If a child table is absent, skip it. The projection should work for
   partial exports and different Epic versions.


---

# Field Naming and Interpretation

Common Epic column suffixes and what they mean:

  _C_NAME     Category value. Epic stores categories as integers internally
              and provides the human-readable name in the _C_NAME column.
              Example: TX_TYPE_C_NAME = "Charge" (not the raw category ID)

  _YN         Yes/No flag. Values are "Y" or "N" (strings, not booleans).

  _ID         A foreign key or primary key. May point to another table
              (DX_ID → CLARITY_EDG) or be an internal Epic identifier.

  _ID_NAME    A denormalized name column. When Epic exports TABLE.FK_ID,
              it often includes TABLE.FK_ID_NAME with the resolved name.
              Example: ALLERGEN_ID + ALLERGEN_ID_ALLERGEN_NAME

  _DTTM       Datetime (format: "9/28/2023 9:38:00 AM")

  _DATE_REAL  Epic's internal date format (a float: days since epoch).
              Usually accompanied by a human-readable CONTACT_DATE.

  _CSN        Contact serial number. See "CSN Column Name Chaos" above.

  LINE        Multi-row child record line number. Tables like PAT_ENC_DX
              use LINE to number multiple diagnoses per encounter.
              The combination of (parent FK + LINE) is the composite key.

  PAT_ENC_DATE_REAL  Almost always in the first column of encounter child
                     tables. Not useful for joining — use PAT_ENC_CSN_ID.

═══════════════════════════════════════════════════════════════════════════


---

# Column Safety: Zero Silent Mismatches

## The Problem

`EpicRow = Record<string, unknown>` makes every column access an
unchecked string lookup. A typo returns `undefined`. The value flows
through `as string`, becomes `null` in the HealthRecord, and nobody
notices. The spike currently has **29 phantom column references** in
HealthRecord.ts alone — fields that are always null because the column
name is wrong.

No amount of testing the *output* catches this reliably, because null
is a valid value for most fields. You can't distinguish "null because
the patient has no marital status" from "null because you typed
MARITAL_STATUS_C_NAME and the column is actually MARITAL_STAT_C_NAME".

## The Solution: Three Layers

### Layer 1: StrictRow Proxy (runtime, catches everything)

Wrap every row returned from SQLite in a `Proxy` that throws if you
access a column that doesn't exist on that row:

```ts
function q(sql: string, table: string): StrictEpicRow[] {
  return db.query(sql).all().map(row => strictRow(row, table));
}
```

Now `row.SMOKING_PACKS_PER_DAY` on a SOCIAL_HX row throws:
```
Column "SMOKING_PACKS_PER_DAY" does not exist in SOCIAL_HX.
Available: TOBACCO_USER_C_NAME, ALCOHOL_USE_C_NAME, ...
```

**This is the kill switch.** If the full projection runs to completion
with StrictRow enabled, every column access in the codebase is valid.
One test — `bun run project.ts --strict` — proves zero mismatches.

Synthetic columns (child attachments like `row.reactions = [...]`,
computed fields like `row._dx_name`) are whitelisted via a set
populated from ChildSpec keys.

Cost: ~5% runtime overhead from Proxy. Use `--strict` in CI, skip in
production if needed.

### Layer 2: Column Manifest (static, catches drift)

For each entity type, declare what you read:

```ts
const SOCIAL_HX_MANIFEST = {
  mapped: [
    'TOBACCO_USER_C_NAME',    // → socialHistory.tobacco.status
    'ALCOHOL_USE_C_NAME',     // → socialHistory.alcohol.status
    'ALCOHOL_COMMENT',        // → socialHistory.alcohol.comment
    'IV_DRUG_USER_YN',        // → socialHistory.drugs.status
    'ILLICIT_DRUG_CMT',       // → socialHistory.drugs.comment
    'SEXUALLY_ACTIVE_C_NAME', // → socialHistory.sexualActivity
    'CONTACT_DATE',           // → socialHistory.asOf
    'PAT_ENC_CSN_ID',        // → timeline key
    'HX_LNK_ENC_CSN',        // → timeline key
  ],
  skipped: [
    'CIGARETTES_YN',          // redundant with TOBACCO_USER_C_NAME
    'PIPES_YN',               // not clinically actionable
    // ...
  ],
};
```

A test validates:
1. Every `mapped` column exists in the DB table
2. Every `skipped` column exists in the DB table
3. `mapped + skipped` = all columns with data in that table
4. No column with data is unaccounted for

When Epic adds a column in a new export, the test fails with
"SOCIAL_HX has unmanifested column NEW_COL_NAME with 5 values"
— forcing you to classify it as mapped or skipped.

### Layer 3: Codegen Types (compile-time, catches at edit time)

Generate TypeScript interfaces from `schemas/*.json`:

```ts
// generated/SOCIAL_HX.ts (auto-generated, do not edit)
export interface SOCIAL_HX_Row {
  CONTACT_DATE: string | null;
  CIGARETTES_YN: string | null;
  TOBACCO_USER_C_NAME: string | null;
  // ... every column from schema
}
```

Then:
```ts
function projectSocialHistory(row: SOCIAL_HX_Row) {
  row.SMOKING_PACKS_PER_DAY  // ← compile error: property does not exist
}
```

The data repo already has `04-codegen.ts` — this is the same idea,
applied to the projection code.

## Implementation Order

1. **StrictRow Proxy** — half day. Wrap `q()` and `mergeQuery()`.
   Run `project.ts --strict`. Fix every crash. Done: zero mismatches
   proven for this dataset.

2. **Column Manifest** — 1 day. Write manifests for the ~15 entity
   types. This catches drift when running against *different* EHI
   exports (different Epic versions, different institutions).

3. **Codegen Types** — 1 day. Auto-generate from schemas. This
   catches errors at edit time before you even run the code.

After all three: column mismatches are a **compile error** (layer 3),
a **test failure on any dataset** (layer 2), and a **runtime crash if
somehow both miss it** (layer 1).

</methodology>

## Your Task

Analyze the mapping pipeline for **Referrals: REFERRAL + children** and identify every semantic error — places where a column is read successfully but the value means something different than the code assumes.

You are looking for these specific error types:
1. **Wrong column for the concept** — the code reads a column that exists but contains a different kind of data than intended (e.g., reading a category code integer instead of a display name string)
2. **Conflated columns** — the code falls back from one column to another using ??, but they have different meanings
3. **Structural misclassification** — data is nested/grouped incorrectly (e.g., a patient-level record nested under encounters)
4. **Cross-layer pipeline mismatch** — the projection stores a value under one property name, but the downstream consumer reads a different property name
5. **Missing data that exists** — a column with real data in the sample that the code never reads, causing a null where it could have a value
6. **Wrong interpretation** — dates parsed as strings, IDs treated as names, category codes treated as display values
7. **Aggregation errors** — queries without ORDER BY feeding into .latest() or similar, nondeterministic tie-breaking

For each issue found, report:
- **Severity**: CRITICAL (output is wrong), MODERATE (output is incomplete), LOW (cosmetic or edge case)
- **Location**: which file and which line/field
- **What happens**: the concrete wrong behavior
- **Fix**: the specific code change needed

## Epic Schema Descriptions

These are Epic's official descriptions for each column. They are the ground truth for what a column means.

### EPA_INFO
**Table**: This table holds information about electronic prior authorization requests.
- **REFERRAL_ID**: The unique identifier for the referral record.
- **EPA_REF_ID**: This item holds the reference ID for electronic prior authorization. It is generated by the system and used for linking a referral record to an electronic prior authorization message.  This value will not change during an electronic prior authorization interaction.
- **PA_PAT_NOTIFIED_YN**: This item specifies whether the patient has been notified about the status of the prior authorization.
- **PA_APPROVAL_SRC_C_NAME**: This item records the entry source of the outpatient prescription prior authorization details. If an authorization was completed using both electronic and manual entry, this will be based on how the most recent data was entered.
- **MED_EPA_UPD_UTC_DTTM**: This holds the instant that ePA information was last updated on this referral.
- **EPA_RFL_ORD_ID**: This virtual item holds the order ID associated with an outpatient prescription medication prior authorization request.
- **PAT_EPA_ENC_CSN_ID**: This item holds the CSN of the encounter the prior authorization was requested in.
- **EPA_PHR_ID**: This item stores the pharmacy that initiated prior authorization.
- **EPA_PHR_ID_PHARMACY_NAME**: The name of the pharmacy.
- **EPA_REQ_TYPE_C_NAME**: This item records the type of the outpatient prescription prior authorization request.  1-Prospective is a request that was initiated at the time of signing the order. 2-Retrospective is a request that was initiated after the order was signed. 3-Retrospective-RxChange is a retrospective request that was initiated by an electronic RxChange message from the pharmacy. 4-Renewal is a request that was initiated on a signed order that already had a prior authorization request linked to it. 5-Renewal-RxChange is a renewal that was initiated by an electronic RxChange message from the pharmacy. 6-Retrospective-Willow Ambulatory is a retrospective request that was initiated from within the Willow Ambulatory application. 7-Renewal-Willow Ambulatory is a renewal that was initiated from within the Willow Ambulatory application.
- **CUR_EPA_STATUS_C_NAME**: This item holds the current status of the outpatient prescription prior authorization request.
- **EPA_HRS_FINAL_STAT**: This column holds the numbers of hours that the outpatient prescription prior authorization request was in progress.  For requests that were initiated, but no other actions have taken place, the count returned will be 0. For other requests, the count returned will be the hours between the initiation of the request and the last action performed on the request.

### EPA_INFO_2
**Table**: This table holds information about electronic prior authorization requests.
- **REFERRAL_ID**: The unique identifier for the referral record.
- **PREV_AUTH_EXP_DATE**: For prior authorization requests that were created because the existing authorization is about to expire, this item holds the date that the existing authorization will expire.
- **ELIG_PAT_ENC_CSN_ID**: This item holds the CSN of the encounter to use for pharmacy benefits for a prior authorization request.

### REFERRAL
**Table**: The REFERRAL table is the primary table for referral information stored in system.
- **REFERRAL_ID**: The unique ID of the referral in database. This is the primary key for the REFERRAL table.
- **EXTERNAL_ID_NUM**: The external identification number used on the referral.
- **PAT_ID**: The ID of the patient associated with the referral.
- **PCP_PROV_ID**: The unique ID of the patient's primary care provider at the time the referral was created.
- **ENTRY_DATE**: The date the referral was entered.
- **RFL_STATUS_C_NAME**: The category value representing the status of the referral (I.e. authorized, open, pending, etc.).
- **REFERRING_PROV_ID**: The unique ID of the referral source (REF) record of the provider who made the referral. This column is frequently used to link to the REFERRAL_SOURCE table. The actual provider (SER) ID can be found in column REF_PROVIDER_ID of table REFERRAL_SOURCE.
- **REFERRING_PROV_ID_REFERRING_PROV_NAM**: The name of the referral source.
- **VENDOR_ID**: The ID number of the vendor associated with the referral.
- **VENDOR_ID_VENDOR_NAME**: The name of the vendor.
- **REFERRAL_PROV_ID**: The unique ID of the provider (SER) being referred to. This column is frequently used to link to the CLARITY_SER table.
- **PROV_SPEC_C_NAME**: The category value indicating the provider specialty being referred to.
- **RFL_TYPE_C_NAME**: The category value indicating the type of referral.
- **RSN_FOR_RFL_C_NAME**: The category value indicating the main (first) reason for the referral.   Since multiple reasons can be listed, use table REFERRAL_REASONS to view all of them.
- **RFL_CLASS_C_NAME**: The category value indicating the class of the referral.
- **AUTH_VIS_PERIOD**: The number of authorized visits in each visit period.
- **AUTH_PERIOD_TYPE_C_NAME**: The category value indicating the type of period for authorized visits - i.e. hour, day, week, month, year.
- **AUTH_NUM_PERIODS**: The number of periods authorized for this referral.
- **AUTH_NUM_OF_VISITS**: The number of visits authorized for this referral.
- **ADMISSION_DATE**: The admission date associated with the referral.
- **DISCHARGE_DATE**: The discharge date associated with the referral.
- **ESTIMATED_DAYS**: The authorized length of stay if the patient is being admitted.
- **START_DATE**: The start date of the referral.
- **EXP_DATE**: The expiration date of the referral.
- **PEND_TO**: The person or pool to whom an In Basket message should be sent about this referral.
- **PEND_RSN_C_NAME**: For pended referrals, the category value indicating the reason for pending.
- **DENY_RSN_C_NAME**: For denied referrals, the category value indicating the reason for denial.
- **SERV_AREA_ID**: The ID number of the service area associated with the referral.
- **COVERAGE_ID**: The unique ID of the coverage associated with the referral.
- **NUM_PROC**: The number of procedures associated with the referral.
- **SVC_DATE_REAL**: If available, this column is populated by the authorized start date (I RFL 85). If not, it is populated by the expiration date on the referral (I RFL 90). If neither of these are available, the column will be empty. The date in this column is based on days since December 31, 1840.
- **CARRIER_ID**: The ID number of the carrier associated with the referral.
- **CARRIER_ID_CARRIER_NAME**: The name of the carrier record.
- **PAYOR_ID**: The ID number of the payor associated with the referral.
- **PLAN_ID**: The ID number of the plan associated with the referral.
- **SERV_DATE**: This column is populated by the authorized start date (I RFL 85) if available. If not, it is populated by the expiration date on the referral (I RFL 90). If neither of these are available, the column will be empty. The date in this column is in MM/DD/YYYY format.
- **RETRO_FLAG_YN**: The category value used to mark a referral as being "Retro" entered.
- **IBNR**: The "Incurred but not reported" amount associated with this referral.
- **AUTO_APPROVED_DATE**: The date on which the referral was approved automatically by the system.
- **AUTH_RSN_C_NAME**: The category value indicating the authorization reason associated with the referral.
- **REFD_BY_LOC_POS_ID**: The ID number of the place of service the referral was referred from.
- **REFD_TO_LOC_POS_ID**: The ID number of the place of service the referral was referred to.
- **REFD_TO_DEPT_ID**: The ID number of the department the referral was referred to.
- **REFD_TO_SPEC_C_NAME**: The category value indicating the specialty the department was referred to.
- **PRIORITY_C_NAME**: The category value indicating the priority of the referral.
- **TOTAL_PRICE**: The total cost of the procedures authorized under the referral.
- **TOTAL_PAYABLE**: The portion of the total price for which your facility is responsible.
- **PATIENT_AMOUNT**: The total patient liability, under the parameters of the primary coverage used, for the procedures authorized under the referral.
- **EXPECT_TO_PAY**: The total amount you expect your facility will pay for the procedures authorized under the referral. This amount entered by you overrides the total payable amount for the purpose of calculating IBNR.
- **IBNR_PAY_UNTIL_DT**: The date up to which your facility will pay claims for the procedures approved on this referral.
- **CASE_RATE_YN**: The category value indicating whether this referral involves services that are reimbursed at a specific case rate.
- **PRIM_LOC_ID**: The unique ID of the member's primary location at the time the referral was entered.
- **MED_TYPE_C_NAME**: The category value indicating what type of confirmation it is - acute, chronic or PAT.
- **ACUTE_AMOUNT**: The amount of the confirmation if the confirmation is acute.
- **CHRONIC_AMOUNT**: The amount of the confirmation if the confirmation is chronic.
- **PAT_AMOUNT**: The amount of the confirmation if the confirmation is an acute medication that was suggested by the pharmacist or over-the-counter medication.
- **RFL_LOB_ID**: ID of the Line of Business (LOB) assigned to the referral.
- **RFL_LOB_ID_LOB_NAME**: The name of the line of business record.
- **ACTUAL_NUM_VISITS**: The actual number of completed visits for this referral.
- **SCHED_NUM_VISITS**: The number of visits scheduled for this referral.
- **REQUEST_NUM_VISITS**: The number of visits requested for this referral.
- **GUIDELINE_DAYS**: Guideline days for this referral.
- **OVRD_ADMIT_DATE**: Override admit date for this referral.
- **OVRD_DISCHARGE_DT**: Override discharge date for this referral.
- **DISP_VAL_C_NAME**: Whether the referral was accepted ("appointed") or refused ("denied") by the referred-to provider, department or facility.
- **DISP_RSN_C_NAME**: The reason that a referral's disposition has a status of "denied."
- **DISP_EAF_ID**: The unique id of the facility to which the referral was forwarded.
- **REFD_BY_DEPT_ID**: The ID number of the department the referral was referred by.
- **CLOSE_RSN_C_NAME**: For closed referrals, the category value indicating the reason for closing.
- **SCHED_STATUS_C_NAME**: Scheduling status of the referral to keep track of internally schedulable referrals.  For category list use ZC_SCHED_STATUS.
- **SCHED_BY_DATE**: Indicates deadline to schedule a referral.
- **PREAUTH_REQ_C_NAME**: For referrals created from an order, indicates if a preauthorization number must be collected before scheduling.
- **NOT_COLLCTD_RSN_C_NAME**: Reason indicating why the preauth number will not be collected for this referral.
- **PROCESSED_RSN_C_NAME**: Reason indicating why the preauth number is marked as processed for this referral.
- **PREAUTH_CHG_EMP_ID**: The unique ID of the user who last changed the preauthorization data.
- **PREAUTH_CHG_EMP_ID_NAME**: The name of the user record. This name may be hidden.
- **PREAUTH_CHNGD_DTTM**: Date/time stamp for last time the preauthorization data was changed.
- **AUTH_NUM**: Authorization number.
- **PRE_CERT_NUM**: Pre-certification number.
- **NON_PREF_PROV_RSN_C_NAME**: Stores the reason why a non preferred level provider was chosen.
- **EXT_REF_DATE**: This is the external referring date.
- **EOW_ID**: The unique EOW ID associated with the referral.
- **REQ_VIS_PER_PERIOD**: The requested visits per period on the referral.
- **REQ_PERIOD_TYPE_C_NAME**: The requested period type on the referral.
- **REQ_NUM_OF_PERIODS**: The requested number of periods on the referral.
- **REF_TO_PROV_ADDR_ID**: This stores the address ID of the referred to provider. The format is as follows: ProvID-AddressID. AddressID is the line number of the multiple response address items in the SER masterfile. To use this column, join to CLARITY_SER_ADDR on REFERRAL.REF_TO_PROV_ADDR_ID = CLARITY_SER_ADDR.ADDR_UNIQUE_ID. If you use IntraConnect, also join on REFERRAL.REFERRAL_PROV_ID = CLARITY_SER_ADDR.PROV_ID.
- **DECISION_DATE**: Date on which the referral's current status was assigned.
- **NUM_CLMS_EXPECTED**: Number of claims expected to be filed on this referral.
- **RFL_STATCHG_RSN_C_NAME**: The reason category number describing why the referral status was changed.
- **TOTAL_EST_DAYS**: Total estimated days for the referral.
- **TOTAL_OVERRIDE_DAYS**: The total number of override days on the referral.
- **TOTAL_CONVTD_DAYS**: The total number of converted days on the referral.
- **AMT_CLMS_ADJUDICTD**: The amount of claims adjudicated.
- **AMT_CLMS_PAID**: The amount of claims paid.
- **ADJ_VENDOR_ID**: The adjudication vendor.
- **ADJ_VENDOR_ID_VENDOR_NAME**: The name of the vendor.
- **ADJ_MEMBER_GROUP_ID**: Adjudication member group.
- **ADJ_NET_STATUS_C_NAME**: Adjudication network status.
- **NO_CLAIMS_PAID**: The number of claims paid on the claim.
- **ADJUD_SERV_AREA_ID**: Service area used in referral pricing and adjudication.

### REFERRAL_2
**Table**: The REFERRAL_2 table is a continuation of the REFERRAL table. These tables are the primary tables for referral information stored in the system.
- **REFERRAL_ID**: The referral ID for the referral record.
- **CE_SENT_YN**: Indicates whether this referral was sent using Care Everywhere.
- **RFL_ATT_PROV_ID**: The unique ID of the supervising provider of the resident issuing the referral.
- **RFL_CONTACT_NAME**: Free text field that will be populated by the user who creates the referral.
- **RPT_RECEIVED_DATE**: Indicates the date that a PCP acknowledged receipt of an internal report regarding a referral.
- **RPT_SENT_DATE**: Indicates the date that an internal report regarding a referral is sent to the referring provider.
- **RFL_RECEIVED_DATE**: Indicates the date in which the referred to department acknowledged receipt of the referral.
- **AUDIT_REF_TO_NAME**: This item is used to audit data from incoming Care Everywhere referrals. It stores the name of the referred-to provider.
- **AUDIT_DATE**: This item is used to audit data from incoming Care Everywhere referrals. It stores the referred-on date.
- **AUDIT_RFL_TYPE**: This item is used to audit data from incoming Care Everywhere referrals. It stores the original text for the referral type.
- **AUDIT_REQ_VISITS**: This item is used to audit data from incoming Care Everywhere referrals. It stores the requested number of visits.
- **AUDIT_AUTH_VISITS**: This item is used to audit data from incoming Care Everywhere referrals. It stores the authorized number of visits.
- **AUDIT_START_DATE**: This item is used to audit data from incoming Care Everywhere referrals. It stores the starting date for the referral in HL7 format.
- **AUDIT_END_DATE**: This item is used to audit data from incoming Care Everywhere referrals. It stores the ending date for the referral in HL7 format.
- **AUDIT_RFTO_PROVSPEC**: This item is used to audit data from incoming Care Everywhere referrals. It stores the original text for the referred-to provider specialty.
- **AUDIT_RFNG_PROVSPEC**: This item is used to audit data from incoming Care Everywhere referrals. It stores the original text for the referring provider specialty.
- **AUDIT_RFTO_DEPTSPEC**: This item is used to audit data from incoming Care Everywhere referrals. It stores the original text for the referred-to department specialty.
- **AUDIT_RFNG_DEPTSPEC**: This item is used to audit data from incoming Care Everywhere referrals. It stores the original text for the referring department specialty.
- **OUTST_AMT**: Specifies the outstanding amount.
- **CASE_MGMT_CREATE_ID**: Specifies the case management creation message.
- **CASE_RATE_OVERRIDE**: Specifies the case rate override.
- **QNR_HQA_ID**: Questionnaire related data
- **ALT_PYR_SVC_DT**: The service date for the alternate payor information. This date is used as the contact date to look up the alternate billing table in the plan master file.
- **GEN_RFL_NUM_IT_1**: This contains information from generic referral numeric item 1.
- **GEN_RFL_NUM_IT_2**: This contains information from generic referral numeric item 2.
- **GEN_RFL_NUM_IT_3**: This contains information from generic referral numeric item 3.
- **GEN_RFL_NUM_IT_4**: This contains information from generic referral numeric item 4.
- **GEN_RFL_NUM_IT_5**: This contains information from generic referral numeric item 5.
- **GEN_RFL_NUM_IT_6**: This contains information from generic referral numeric item 6.
- **GEN_RFL_NUM_IT_7**: This contains information from generic referral numeric item 7.
- **GEN_RFL_NUM_IT_8**: This contains information from generic referral numeric item 8.
- **GEN_RFL_NUM_IT_9**: This contains information from generic referral numeric item 9.
- **GEN_RFL_NUM_IT_10**: This contains information from generic referral numeric item 10.
- **GEN_RFL_CAT_1_C_NAME**: This contains information from generic referral category item 1.
- **GEN_RFL_CAT_2_C_NAME**: This contains information from generic referral category item 2.
- **GEN_RFL_CAT_3_C_NAME**: This contains information from generic referral category item 3.
- **GEN_RFL_CAT_4_C_NAME**: This contains information from generic referral category item 4.
- **GEN_RFL_CAT_5_C_NAME**: This contains information from generic referral category item 5.
- **GEN_RFL_STR_1**: This contains information from generic referral string item 1.
- **GEN_RFL_STR_2**: This contains information from generic referral string item 2.
- **GEN_RFL_STR_3**: This contains information from generic referral string item 3.
- **GEN_RFL_STR_4**: This contains information from generic referral string item 4.
- **GEN_RFL_STR_5**: This contains information from generic referral string item 5.
- **GEN_RFL_DATE_1_DT**: This contains information from generic referral date item 1.
- **GEN_RFL_DATE_2_DT**: This contains information from generic referral date item 2.
- **GEN_RFL_DATE_3_DT**: This contains information from generic referral date item 3.
- **GEN_RFL_DATE_4_DT**: This contains information from generic referral date item 4.
- **GEN_RFL_DATE_5_DT**: This contains information from generic referral date item 5.
- **TRIAGE_DECISION_C_NAME**: The triage decision category ID for the referral.
- **REJECT_REASON_C_NAME**: UK referral triage information
- **TRIAGE_APPT_CHANGE**: The appointment change comments for the referral record.
- **OVRRD_REF_COUNTS**: The number of visits approved for this referral, overridden by the user.
- **CALC_SVC_LVL_CNTS**: The calculated number of service level authorizations counts, based on the service level authorizations collected.
- **TOC_STATUS_C_NAME**: Indicates the status of the last transfer of care transmission attempt. If the attempt was unsuccessful, the failure reason is stored.
- **GEN_RFL_STR_6**: This contains information from generic referral string item 6.
- **GEN_RFL_STR_7**: This contains information from generic referral string item 7.
- **GEN_RFL_STR_8**: This contains information from generic referral string item 8.
- **GEN_RFL_STR_9**: This contains information from generic referral string item 9.
- **AP_CLAIM_COUNT**: The actual AP claims count for the referral. This number is calculated from the counts table based the Counts Settings in the Referral System Definitions.
- **RFL_DX_ID**: Holds the primary coded diagnosis for the referral.
- **RFL_ENC_TYPE_C_NAME**: The expected encounter type for the referral (inpatient or outpatient).

### REFERRAL_3
**Table**: The REFERRAL_3 table is a continuation of the REFERRAL_2 which is continuation of the REFERRAL table. These tables are the primary tables for referral information stored in the system.
- **REFERRAL_ID**: The unique identifier for the referral record.
- **GEN_RFL_STR_10**: This contains information from generic referral string item 10.
- **GEN_RFL_CAT_11_C_NAME**: This contains information from generic referral category item 11.
- **GEN_RFL_CAT_12_C_NAME**: This contains information from generic referral category item 12.
- **GEN_RFL_CAT_13_C_NAME**: This contains information from generic referral category item 13.
- **GEN_RFL_CAT_14_C_NAME**: This contains information from generic referral category item 14.
- **GEN_RFL_CAT_15_C_NAME**: This contains information from generic referral category item 15.
- **REFERRING_DEP_SPC_C_NAME**: Indicates the specialty of the department where the referral is coming from.
- **CANCEL_RSN_C_NAME**: Status reason explaining why a referral was canceled.
- **PAT_COMM_DATE**: The date when the patient's scheduled encounter was communicated to the patient.
- **GEN_RFL_CAT_16_C_NAME**: This contains information from generic referral category item 16.
- **GEN_RFL_CAT_17_C_NAME**: This contains information from generic referral category item 17.
- **GEN_RFL_CAT_18_C_NAME**: This contains information from generic referral category item 18.
- **GEN_RFL_CAT_19_C_NAME**: This contains information from generic referral category item 19.
- **GEN_RFL_CAT_20_C_NAME**: This contains information from generic referral category item 20.
- **GEN_RFL_CAT_21_C_NAME**: This contains information from generic referral category item 21.
- **GEN_RFL_CAT_22_C_NAME**: This contains information from generic referral category item 22.
- **GEN_RFL_CAT_23_C_NAME**: This contains information from generic referral category item 23.
- **GEN_RFL_CAT_24_C_NAME**: This contains information from generic referral category item 24.
- **GEN_RFL_CAT_25_C_NAME**: This contains information from generic referral category item 25.
- **GEN_RFL_STR_11**: Referral-level generic string for general use.
- **GEN_RFL_STR_12**: Referral-level generic string for general use.
- **GEN_RFL_STR_13**: Referral-level generic string for general use.
- **GEN_RFL_STR_14**: Referral-level generic string for general use.
- **GEN_RFL_STR_16**: Referral-level generic string for general use.
- **GEN_RFL_STR_17**: Referral-level generic string for general use.
- **GEN_RFL_STR_18**: Referral-level generic string for general use.
- **GEN_RFL_STR_19**: Referral-level generic string for general use.
- **GEN_RFL_STR_20**: Referral-level generic string for general use.
- **GEN_RFL_STR_21**: Referral-level generic string for general use.
- **GEN_RFL_STR_22**: Referral-level generic string for general use.
- **GEN_RFL_STR_23**: Referral-level generic string for general use.
- **GEN_RFL_STR_24**: Referral-level generic string for general use.
- **GEN_RFL_STR_25**: Referral-level generic string for general use.
- **GEN_RFL_STR_26**: Referral-level generic string for general use.
- **GEN_RFL_STR_27**: Referral-level generic string for general use.
- **GEN_RFL_STR_28**: Referral-level generic string for general use.
- **GEN_RFL_STR_29**: Referral-level generic string for general use.
- **GEN_RFL_STR_30**: Referral-level generic string for general use.
- **GEN_RFL_STR_15**: Referral-level generic string for general use.

### REFERRAL_4
**Table**: The REFERRAL_4 table is a continuation of the REFERRAL_3 which is continuation of the REFERRAL_2 table. These tables are the primary tables for referral information stored in the system.
- **REFERRAL_ID**: The referral ID for the referral record.
- **ATTEND_PROV_ADDR_ID**: This item stores the address ID of the attending provider. The format is as follows: SerID-AddressID. AddressID is the line number of the multiple response address items in the Provider (SER) master file. It can be used to print the correct address in a report or letter, for example.
- **RFL_NET_LVL_C_NAME**: Store the referral's network status
- **GEOGRAPHIC_AREA_ID**: Geographic area from ZIP code mapping.
- **IN_OUT_OF_AREA_C_NAME**: In or out-of-area classification from ZIP code mapping.
- **GEN_RFL_SEC_SINCE_MIDNIGHT_1**: Referral-level generic time item for general use.
- **GEN_RFL_SEC_SINCE_MIDNIGHT_2**: Referral-level generic time item for general use.
- **GEN_RFL_SEC_SINCE_MIDNIGHT_3**: Referral-level generic time item for general use.
- **GEN_RFL_SEC_SINCE_MIDNIGHT_4**: Referral-level generic time item for general use.
- **GEN_RFL_SEC_SINCE_MIDNIGHT_5**: Referral-level generic time item for general use.
- **AUDIT_REF_TO_LOC_ID**: This item is used to audit data from incoming Care Everywhere referrals. It stores the original text for the referred-to location ID.
- **AUDIT_REF_TO_DEPARTMENT_ID**: This item is used to audit data from incoming Care Everywhere referrals. It stores the original text for the referred to department ID.
- **AUDIT_REFG_PROV_ID**: This item is used to audit data from incoming Care Everywhere referrals. It stores the original text for the referring provider ID.
- **AUDIT_REFG_PROV_ADDR**: This item is used to audit data from incoming Care Everywhere referrals. It stores the original text for the referring provider address ID.
- **AUDIT_REF_TO_PROV_ID**: This item is used to audit data from incoming Care Everywhere referrals. It stores the original text for the referred-to provider ID.
- **AUDIT_REF_TO_PROV_ADDR**: This item is used to audit data from incoming Care Everywhere referrals.  It stores the original text for the referred-to provider address ID.
- **AUDIT_RFL_SRC_LOC_ID**: This item is used to audit data from incoming Care Everywhere referrals.  It stores the original text for the source referral location.
- **RFL_DIRECTION_C_NAME**: The referral direction, as calculated by logic for transitions of care
- **REFD_TO_LINK_PROV_YN**: Is the referred to provider an EpicCare Link provider
- **REFD_TO_LINK_LOC_YN**: Is the referred to location an EpicCare Link location
- **IS_LEAKED_YN**: Holds whether the referral is considered leaked
- **TRIAGE_REMIND_DATE**: A date in the future when the user should be reminded of this referral.
- **TRIAGE_INFO_RECPNT_C_NAME**: The recipient of a request for more information. This item holds which item should be looked to for routing purposes.
- **CE_DISCONNECT_YN**: Indicates that this referral is disconnected from the sending organization for Care Everywhere referrals.
- **RECENT_AUTH_RSN_C_NAME**: This item holds the most recent non-empty authorization reason for the referral. If this item is null, it means the referral was never authorized. If value is added/updated to the authorization code (I RFL 73), same value is copied into this item. But if authorization code (I RFL 73) is cleared, then this item is not updated.
- **RECENT_DENY_RSN_C_NAME**: This item holds the most recent non-empty denial reason for the  referral. If this item is null, it means the referral was never denied. If value is added/updated to the reason for denial (I RFL 18007), same value is copied into this item. But if reason for denial (I RFL 18007) is cleared, then this item is not updated.
- **TRIAGE_UNACCEPT_REASON_C_NAME**: The unaccept reason that was specified when the triage decision changed from accept to no decision.
- **ADMITTING_PROV_ID**: The admitting provider related to an inpatient service. This item is only for Tapestry documentation purposes.
- **EXPECTED_DISCHARGE_DATE**: The expected discharge date documented on the referral bed days form of referral entry.
- **GEN_RFL_DATE_6_DT**: This contains information from generic referral date item 6.
- **GEN_RFL_DATE_7_DT**: This contains information from generic referral date item 7.
- **GEN_RFL_DATE_8_DT**: This contains information from generic referral date item 8.
- **GEN_RFL_DATE_9_DT**: This contains information from generic referral date item 9.
- **GEN_RFL_DATE_10_DT**: This contains information from generic referral date item 10.
- **GEN_RFL_SEC_SINCE_MIDNIGHT_6**: This contains information from generic referral time item 6.
- **RFL_SVC_TYPE_CODE_C_NAME**: Specifies the service type that applies to the entire referral.
- **INT_RFL_TYPE_C_NAME**: The internal referral type for the referral.

### REFERRAL_5
**Table**: The REFERRAL_5 table is a continuation of the REFERRAL_4 table. The REFERRAL_* tables are the primary tables for referral information stored in the system.
- **REFERRAL_ID**: The unique identifier for the referral record.
- **GEN_RFL_SEC_SINCE_MIDNIGHT_7**: This contains information from generic referral time item 7.
- **GEN_RFL_SEC_SINCE_MIDNIGHT_8**: This contains information from generic referral time item 8.
- **GEN_RFL_SEC_SINCE_MIDNIGHT_9**: This contains information from generic referral time item 9.
- **GEN_RFL_SEC_SINCE_MIDNIGHT_10**: This contains information from generic referral time item 10.
- **RPT_REF_TO_CNTRCT_YN**: Stores an override value that indicates the referred to provider/location/vendor/department should be considered contracted or not for Medicare Advantage ODAG reporting. If NULL, system defined logic will be used. If Y, a user marked the provider as contracted (CP in ODAG). If N, a user marked the provider as non-contracted (NCP in ODAG).
- **RPT_REF_BY_CNTRCT_YN**: Stores an override value that indicates the referred by provider/location/department should be considered contracted or not for Medicare Advantage ODAG reporting. If NULL, system defined logic will be used. If Y, a user marked the provider as contracted (CP in ODAG). If N, a user marked the provider as non-contracted (NCP in ODAG).
- **LIVING_SITUATION_C_NAME**: Describes who the patient or child lives with.
- **FIRST_APPOINTMENT_BY_DATE**: The date that the first appointment for the referral should occur by.
- **SENIORITY_DATE**: The Seniority Date for the referral which represents a 'start date' that might have been set before the referral was created.
- **CASE_WORKER_NAME**: The case manager of the child psychology case.
- **CHILD_SERVICE_C_NAME**: Indicates the child welfare service role in connection with child psychology services.
- **PARENTAL_RESP_C_NAME**: Indicates which entity has parental responsibility for the patient.
- **CONSENT_TO_TREAT_STAT_C_NAME**: Indicates the status of obtaining the patient's consent in connection with the referral's transfer of medical record information.
- **FORWARDED_EVALUATION_DATE**: This date represents the date an external organization evaluated or triaged the referral before forwarding it to an Epic instance. This date represents the internal concept of Triage History Instant, for the forwarding decision done at the external organization.
- **EMSG_COMM_PAT_ENC_CSN_ID**: This item is part of a link to a communication from which the referral was created. This item contains the CSN of the contact which contains the communication. EMSG_COMM_JOB_ID (I RFL 18961) contains the communication job ID.
- **EMSG_COMM_JOB_ID**: Part of a link to a communication from which the referral was created.
- **AUTHORIZED_MEDICATION_ID**: This item holds the ID of the medication being authorized in this referral.
- **INITIAL_REQUEST_TYPE_C_NAME**: The initial request type for the referral.
- **REF_BY_CNTRCT_AT_AUTH_YN**: The contracted status of referred-by entities on the referral as of the last decision or the current contracted status if the referral is pending.
- **REF_TO_CNTRCT_AT_AUTH_YN**: The contracted status of referred-to entities on the referral as of the last decision or the current contracted status if the referral is pending.
- **REF_BY_SER_CNTRCT_AT_AUTH_YN**: The contracted status of referred-by provider on the referral as of the last decision or the current contracted status if the referral is pending.
- **REF_TO_SER_CNTRCT_AT_AUTH_YN**: The contracted status of referred-to provider on the referral as of the last decision or the current contracted status if the referral is pending.
- **REF_BY_EAF_CNTRCT_AT_AUTH_YN**: The contracted status of referred-by location on the referral as of the last decision or the current contracted status if the referral is pending.
- **REF_TO_EAF_CNTRCT_AT_AUTH_YN**: The contracted status of referred-to location on the referral as of the last decision or the current contracted status if the referral is pending.
- **REF_TO_VEN_CNTRCT_AT_AUTH_YN**: The contracted status of referred-to vendor on the referral as of the last decision or the current contracted status if the referral is pending.
- **REF_BY_PROV_NET_LEVEL_C_NAME**: The network status of the referred-by provider on the referral.
- **REF_TO_LOCATION_NET_LEVEL_C_NAME**: The network status of the referred-to location on the referral.
- **REF_TO_VENDOR_NET_LEVEL_C_NAME**: The network status of the referred-to vendor on the referral.
- **REF_TO_PROV_NET_LEVEL_C_NAME**: The network status of the referred-to provider on the referral.
- **REF_BY_LOCATION_NET_LEVEL_C_NAME**: The network status of the referred-by location on the referral.
- **RPT_REF_BY_SER_CNTRCT_YN**: The user override for the contracted status of the referred-by provider on the referral.
- **RPT_REF_TO_SER_CNTRCT_YN**: The user override for the contracted status of the referred-to provider on the referral.
- **RPT_REF_BY_EAF_CNTRCT_YN**: The user override for the contracted status of the referred-by location on the referral.
- **RPT_REF_TO_EAF_CNTRCT_YN**: The user override for the contracted status of the referred-to location on the referral.
- **RPT_REF_TO_VEN_CNTRCT_YN**: The user override for the contracted status of the referred-to vendor on the referral.
- **RFL_AUTH_PROG_C_NAME**: Authorization Prognosis code associated with a referral
- **PRINCIPAL_DX_DATE**: Specifies the diagnois date used for Prinicpal Diagnosis
- **ADMISSION_SOURCE_C_NAME**: The source from which the paitent is being admitted or referred. Only available in UM referrals.
- **DISCHRG_DISP_C_NAME**: This disposition (location) of the patient after discharge. Only available in UM referrals.
- **FIRST_PAT_ENC_CSN_ID**: Ths CSN of the encounter linked to the referral or auth/cert with the earliest encounter instant.
- **LAST_PAT_ENC_CSN_ID**: Ths CSN of the encounter linked to the referral or auth/cert with the latest encounter instant.
- **REF_BY_CNTRCT_AT_DEC_YN**: The contracted status of referred-by entities on the referral as of the last decision.
- **REF_TO_CNTRCT_AT_DEC_YN**: The contracted status of referred-to entities on the referral as of the last decision.
- **REF_BY_SER_CNTRCT_AT_DEC_YN**: The contracted status of referred-by provider on the referral as of the last decision.
- **REF_TO_SER_CNTRCT_AT_DEC_YN**: The contracted status of referred-to provider on the referral as of the last decision.
- **REF_BY_LOC_CNTRCT_AT_DEC_YN**: The contracted status of referred-by location on the referral as of the last decision.
- **REF_TO_LOC_CNTRCT_AT_DEC_YN**: The contracted status of referred-to location on the referral as of the last decision.
- **REF_TO_VEN_CNTRCT_AT_DEC_YN**: The contracted status of referred-to vendor on the referral as of the last decision.
- **REGION_ID**: The facility profile ID of the region on the coverage used for this referral.
- **MEDICAL_GROUP_ID**: The facility profile ID of the medical group on the coverage used for this referral.
- **PRIMARY_CONDITION_GROUPER_ID**: Primary condition for which the patient is being referred as a Search Condition MAG record.
- **PRIMARY_TREATMENT_GROUPER_ID**: Primary treatment for which the patient is being referred as a Search Treatment MAG record.
- **PRIMARY_SPECIALTY_GROUPER_ID**: Primary specialty to which the patient is being referred as a Search Specialty MAG record.
- **PRIMARY_SUBSPEC_GROUPER_ID**: Primary subspecialty to which the patient is being referred as a Search Subspecialty MAG record.
- **CONC_UM_REV_TRANS_FROM_DELE_YN**: Indicates if the responsiblity for concurrent review of this authorization request has been transitioned from a delegate system to this UM system.

### REFERRAL_APT
**Table**: This table contains information about referral appointments.
- **REFERRAL_ID**: The referral ID for the referral record.
- **LINE_COUNT**: A line number that is used to group information about contacts that have counted towards the referral.
- **SERVICE_DATE**: The date of the service (date of the appointment, claim, charge, or admission date) that is associated with the referral
- **SERVICE_TYPE_C_NAME**: The type of service that has been counted as a contact toward the total of completed contacts for this referral.
- **CHARGE_ID**: The ID number of the charge, if the source is �Charge.�
- **CLAIM_ID**: The ID number of the AP Claim, if the source is �Claim�
- **SERIAL_NUMBER**: The ID number of the contact, if the source is either "Visit" or "Admission"
- **USER_ID**: The ID number of the user who performed an override of the counting/contact information, if the source of the contact is "User Override"
- **USER_ID_NAME**: The name of the user record. This name may be hidden.
- **REASON**: The reason for the user override, if the source of the contact was "User Override"
- **TABLE_COUNT**: The number of completed contacts that have been counted for this source.
- **EXT_SVC_PROV_ID**: The unique ID associated with the provider record for this row.
- **EXT_SVC_TIME**: The time associated with the external appointment that was added to the referral.
- **EXT_SVC_POS_ID**: The unique ID associated with the location or place of service record for this row.  This column is frequently used to link to the CLARITY_POS table.
- **EXT_APPT_STATUS_C_NAME**: This column contains the appointment status for external appointments.
- **EXT_APPT_UNIQ_ID**: This column contains the unique ID for external appointments.
- **EXT_SVC_UTC_DTTM**: This column contains the timestamp when the service is performed in UTC format.
- **EXT_SVC_DTTM**: This column contains the external service date and time as an instant in the local time zone.

### REFERRAL_CROSS_ORG
**Table**: This table contains cross-organization referral information.
- **REFERRAL_ID**: The unique identifier (.1 item) for the referral record.
- **LINE**: The line number for the information associated with this record. Multiple pieces of information can be associated with this record.
- **CROSS_ORG_RFL_STATUS_C_NAME**: Track the status of a cross-organization referral.
- **CROSS_ORG_RFL_ORGANIZATION_ID**: Store the organization for a cross-organization referral.
- **CROSS_ORG_RFL_ORGANIZATION_ID_EXTERNAL_NAME**: Organization's external name used as the display name on forms and user interfaces.
- **CROSS_ORG_RFL_UNIQUE_IDENT**: Store the unique ID of a cross-organization referral.
- **CROSS_ORG_RFL_ASGN_AUTH_OID**: Store the assigning authority OID of a cross-organization referral.
- **CROSS_ORG_RFL_RSN_CNCL_RQST**: The reason a cancellation was requested for this referral.
- **CROSS_ORG_RFL_INST_UPDATE_DTTM**: Instant the cross-organization status was last updated.
- **CROSS_ORG_RFL_INACTIVE_YN**: Indicates whether this line of cross organization referral information is inactive due to patient unlinking. 'Y' indicates that the information is not currently active. 'N' or NULL indicates that the information is active.
- **CROSS_ORG_RFL_REASON_DECLINE**: The reason the cross-organization referral was declined.

### REFERRAL_CVG
**Table**: The REFERRAL_CVG table contains coverage information for referrals.
- **REFERRAL_ID**: The unique ID of the referral in database.
- **LINE**: A line number that is used to identify a group of coverage-related information. For example, if a referral has 2 valid coverages, line 1 of the coverage items contains the information about the first coverage, line 2 contains the information about the second coverage.
- **CVG_ID**: The ID of a coverage that is valid for the referral.
- **CVG_USED_YN**: A yes/no flag that indicates whether or not the coverage should be considered available for the referral use in non-UM (utilization management) workflows. For UM workflows, consider using SUBMITTED_UM_AUTHS_YN.  The coverage may be valid on the dates, but still inappropriate to use. Setting the flag to Yes means that the coverage is all right to use.
- **AUTH_REQUIRED_YN**: A flag to indicate whether the coverage requires external authorization to be received (as from an insurance carrier) for the services.
- **CARRIER_AUTH_CMT**: The carrier authorization number or comment, indicating that authorization was received.
- **EFF_CVG_PRECERT_NUM**: Precertification number associated with a coverage on a referral.
- **EFF_CVG_AUTH_CMT**: Comments regarding authorization specific to a coverage used on a referral.
- **CVG_INVALID_FLAG**: Flag for invalid coverage for non-UM (utilization management) workflows.
- **CHARGE_COUNT_TYPE_C_NAME**: Type of charges that this service level authorization record counts for professional, technical or all charges.
- **USE_CHARGE_COUNT_YN**: Flag to specify if the referral & coverage are using charge counting.
- **CHARGE_COUNT_MTHD_C_NAME**: Charge counting method for this service level authorization.
- **CVG_SVC_TYPE_CODE_C_NAME**: Specifies the service type at the coverage level.
- **CVG_AUTH_STATUS_C_NAME**: The authorization status category ID  for the coverage.

### REFERRAL_CVG_AUTH
**Table**: The REFERRAL_CVG_AUTH contains coverage auth/cert information for referrals.
- **REFERRAL_ID**: The referral ID for the referral record.
- **LINE**: The line number for the information associated with this record. Multiple pieces of information can be associated with this record.
- **AUTH_CERT_CVG_ID**: Coverage ID for Auth/Cert information
- **PRE_CERT_REQ_YN**: Indicates whether pre-cert is required for this coverage
- **PRE_CERT_STATUS_C_NAME**: Pre-certification status for this coverage
- **PRE_CERT_AGENCY_ID**: ID of the agency used for precertification
- **PRE_CERT_AGENCY_ID_AGENCY_NAME**: The name of the agency.
- **PRE_CERT_AGENCY_PH**: Phone number of the agency used for precertification
- **PRE_CERT_CONTACT**: Contact individual for the pre-certification agency
- **PRE_CERT_CALLED_DT**: Date on which the payor was called for pre-certification information
- **PRE_CERT_RECV_DT**: Date on which pre-certification information was received
- **PRE_CERT_RCV_ID**: User who received pre-certification information
- **PRE_CERT_RCV_ID_NAME**: The name of the user record. This name may be hidden.
- **PRE_CERT_FAX**: Fax number for pre-certification information
- **PRE_CERT_BN_REQ_YN**: Indicates whether a pre-certification benefits check is required
- **PRE_CERT_BEN_STS_C_NAME**: Status of the pre-certification benefits
- **PRE_CERT_BEN_CHECK**: Individual from whom pre-cert benefits information was received
- **PRE_CERT_BEN_PHONE**: Phone number to use for pre-cert benefits checking
- **PRE_CERT_BEN_CNCT**: Contact person for pre-cert benefits checking
- **PRE_CERT_BEN_FAX**: Fax number for pre-cert benefits checking
- **PRE_CERT_BEN_CK_DT**: Date on which pre-cert benefits were checked
- **PRE_CERT_BN_USR_ID**: ID of user who checked pre-cert benefits information
- **PRE_CERT_BN_USR_ID_NAME**: The name of the user record. This name may be hidden.
- **PRE_CERT_CLIN_CNCT**: Contact individual for pre-cert clinical information
- **PRE_CERT_CLIN_PHON**: Phone number for pre-cert clinical information
- **AUTH_FROM_DT**: The beginning date of the period authorized by the payor
- **AUTH_TO_DT**: The end date of the period authorized by the payor.
- **MAX_OUT_POCKET**: Contains Maximum Out of Pocket Amount: The most you pay in coinsurance during a benefit plan year. After you reach your out-of-pocket maximum, your medical plan option pays 100% (unless balance billing applies) of eligible expenses for the remainder of the benefit plan year
- **LIFETIME_MAX**: Contains Lifetime Maximum Amount: The maximum amount that the insurance company will cover for this patient over the course of their lifetime.
- **TOT_PT_AMOUNT**: Contains Total Patient Amount: The total amount the patient owes for this visit
- **ADM_NOTIF_STAT_C_NAME**: Contains admission notification status: A field that can be used to track the status of the admission notification that needs to be faxed or sent electronically to the payor. This is a customer-owned category list.
- **CONC_REV_REQD_YN**: Contains Information on whether a concurrent review (clinical review) is required or not.
- **IN_NETWORK_YN**: This field is used to track whether or not the patient�s insurance is in Network.
- **DEDUCTIBLE_MET_YN**: A deductible is the amount you must pay before the Plan begins to pay benefits. This field tracks whether or not the patient has paid that amount.
- **DEDUCTIBLE_MET_AMT**: Contains Deductible Met Amount. A deductible is the amount you must pay before the Plan begins to pay benefits. This field tracks how much the patient has paid.
- **COINSUR_MET_YN**: Coinsurance is a percentage of an eligible expense that you are required to pay for a covered service.  This field tracks whether or not the patient has paid that amount.
- **COINSURANCE_MET_AMT**: Contains coinsurance met amount. Coinsurance is a percentage of an eligible expense that you are required to pay for a covered service.  This field tracks how much the patient has paid.
- **OUT_POCKET_MET_YN**: This fields tracks whether or not the patient has paid their out of pocket expenses.
- **OUT_POCKET_MET_AMT**: Contains Out of Pocket Met Amount. This fields tracks how much the patient has paid towards their out of pocket expenses.
- **PREEXIST_COND_YN**: Contains whether or not pre-existing conditions are present. It is used to track whether or not the patient has pre-existing conditions that may impact their benefits.
- **PREEXIST_COND_VAL**: Contains Pre-existing conditions value. If the patient has pre-existing conditions that may impact their benefits, this field is used to document the pre-existing conditions.
- **PRECERT_CMT_NOTE_ID**: The unique ID of the note containing pre-certification comments entered on the referral.
- **PRECERT_BEN_NOTE_ID**: The unique ID of the note containing benefits information entered on the referral.
- **GENERIC_CATEG_1_C_NAME**: Generic category for general use
- **GENERIC_CATEG_2_C_NAME**: Generic category for general use
- **GENERIC_CATEG_3_C_NAME**: Generic category for general use
- **GENERIC_CATEG_4_C_NAME**: Generic category for general use
- **GENERIC_CATEG_5_C_NAME**: Generic category for general use
- **GENERIC_CATEG_6_C_NAME**: Generic category for general use
- **GENERIC_CATEG_7_C_NAME**: Generic category for general use
- **GENERIC_CATEG_8_C_NAME**: Generic category for general use
- **GENERIC_CATEG_9_C_NAME**: Generic category for general use
- **GENERIC_CATG_10_C_NAME**: Generic category for general use
- **GENERIC_STR_1**: Generic string item for general use
- **GENERIC_STR_2**: Generic string item for general use
- **GENERIC_STR_3**: Generic string item for general use
- **GENERIC_STR_4**: Generic string item for general use
- **GENERIC_STR_5**: Generic string item for general use
- **GENERIC_NUM_IT_1**: Generic numeric item for general use
- **GENERIC_NUM_IT_2**: Generic numeric item for general use
- **GENERIC_NUM_IT_3**: Generic numeric item for general use
- **GENERIC_NUM_IT_4**: Generic numeric item for general use
- **GENERIC_NUM_IT_5**: Generic numeric item for general use
- **GENERIC_NUM_IT_6**: Generic numeric item for general use
- **GENERIC_NUM_IT_7**: Generic numeric item for general use
- **GENERIC_NUM_IT_8**: Generic numeric item for general use
- **GENERIC_NUM_IT_9**: Generic numeric item for general use
- **GENERIC_NUM_IT_10**: Generic numeric item for general use
- **GENERIC_DATE_1_DATE**: Generic date item for general use
- **GENERIC_DATE_2_DATE**: Generic date item for general use
- **GENERIC_DATE_3_DATE**: Generic date item for general use
- **GENERIC_DATE_4_DATE**: Generic date item for general use
- **GENERIC_DATE_5_DATE**: Generic date item for general use
- **GENERIC_SEC_SINCE_MIDNIGHT_1**: Generic time item for general use
- **GENERIC_SEC_SINCE_MIDNIGHT_2**: Generic time item for general use
- **GENERIC_SEC_SINCE_MIDNIGHT_3**: Generic time item for general use
- **GENERIC_SEC_SINCE_MIDNIGHT_4**: Generic time item for general use
- **GENERIC_SEC_SINCE_MIDNIGHT_5**: Generic time item for general use

### REFERRAL_DX
**Table**: The REFERRAL_DX table contains diagnosis information stored with referrals.
- **REFERRAL_ID**: The referral ID for the referral record.
- **LINE**: The line number of the diagnosis associated with the referral. For example, if a referral has two associated diagnoses, the first diagnosis will have a line value of 1, while the second diagnosis will have a line value of 2.
- **DX_ID**: The ID number of the diagnosis associated with the referral. This is not the diagnosis code.  NOTE: Link to CLARITY_EDG to get the diagnosis code.
- **DX_TEXT**: Free text associated with each additional diagnosis (I RFL 1000).
- **DX_CODE_TYPE_C_NAME**: Stores the code type of the additional diagnosis

### REFERRAL_HIST
**Table**: The REFERRAL_HIST table contains information on changes to referrals stored in system.
- **REFERRAL_ID**: The referral ID for the referral record.
- **LINE**: The line number of the change to the referral. For example, if the referral is changed twice, the first change will have a line value of 1, while the second change will have a line value of 2.
- **CHANGE_DATE**: The date of the change to the referral.
- **CHANGE_TYPE_C_NAME**: The category value indicating the type of referral change.
- **CHANGE_USER_ID**: The ID number of the user who made the change to the referral.
- **CHANGE_USER_ID_NAME**: The name of the user record. This name may be hidden.
- **PREVIOUS_VALUE**: Some of the information on the referral is tracked when it changes. This stores the previous value of an item if it is tracked when it changes.
- **CHANGE_DATETIME**: The date and time of the change to the referral.
- **AUTH_HX_EVENT_NO**: The event no of the authorization history
- **AUTH_HX_NOTE_ID**: Referral audit trail item to store note Id
- **CHANGE_LOCAL_DTTM**: The authorization date and time as an instant in the local time zone
- **NEW_RFL_STATUS_C_NAME**: If the item being changed is Referral Status (I RFL 50), this item stores the new value for that item.
- **NEW_PEND_RSN_C_NAME**: If the item being changed is Reason Pending (I RFL 18003), this item stores the new value for that item.
- **NEW_FIN_PROV_STATUS_C_NAME**: If the item being changed is Finland - Provision Status (I RFL 72124), this item stores the new value for that item.
- **NEW_FIN_VALID_END_DATE**: If the item being changed is Finland - Validity End Date (I RFL 72115), this item stores the new value for that item.

### REFERRAL_NOTES
**Table**: Notes attached to the referral record.
- **REFERRAL_ID**: The unique identifier for the referral record.
- **LINE**: The line number for the information associated with this record. Multiple pieces of information can be associated with this record.
- **NOTE_ID**: The unique identifier for the note record.
- **NOTE_USER_ID**: User who created the note.
- **NOTE_USER_ID_NAME**: The name of the user record. This name may be hidden.
- **NOTE_DATETIME**: The instant of creation of the note.

### REFERRAL_ORG_FILTER_SA
**Table**: This table holds a list of authorized service areas, business segments and the patient associated with each referral. This table is used with Organizational Filtering. An organization will have access to a referral if they are authorized for at least one of the referral's associated service areas/business segments or if they are authorized for the referral's associated patient.
- **REFERRAL_ID**: The unique identifier for the referral record.
- **LINE**: The line number for the information associated with this record. Multiple service areas and business segments can be associated with a referral.
- **AUTH_SA_OR_BUS_SEG_ID**: The authorized service areas and business segments. This is only populated when Tapestry business segmentation is on. When it is, this column is used to determine which organizations are authorized to view the referral.

### REFERRAL_PX
**Table**: This table contains information on procedures associated with referrals. This table is related to the REFERRAL_ORDER_ID table. The REFERRAL_ORDER_ID table contains the list of procedures for the referral. The REFERRAL_PX table contains information on each of those procedures.
- **REFERRAL_ID**: The unique ID of the referral in database.
- **LINE**: The line number of the procedure associated with the referral. For example, if a referral has two associated procedures, the first procedure will have a line value of 1, while the second procedure will have a line value of 2.
- **PX_ID**: The unique ID of the procedure associated with the referral. This is frequently used to join to the CLARITY_EAP table.
- **UNITS_REQUESTED**: The number of units of this procedure that were requested
- **UNITS_APPROVED**: The number of units of this procedure that were approved
- **TOTAL_PRICE**: The total price calculated for this procedure using fee schedules or vendor contracts (for outgoing referrals)
- **NET_PAYABLE**: The total net payable calculated for this procedure (the price - the patient portion).
- **PATIENT_PORTION**: The total patient responsibility calculated for this procedure using the benefits engine
- **PROV_ID**: The ID of the provider who will perform the service
- **AUTH_REQ_YN**: A flag that indicates whether the member's benefits require a referral for this service. Yes=> a referral is required, No=> a referral is not required.
- **COVERED**: A flag that indicates whether the procedure is not covered by the member's benefits or it is covered but by supplemental insurance
- **REVENUE_CODE_ID**: Stores the revenue billing code entered on the service.

### REFERRAL_REASONS
**Table**: Contains the reasons for each referral.
- **REFERRAL_ID**: The unique ID of the referral.
- **LINE**: The line number of the referral reason.
- **REFERRAL_REASON_C_NAME**: The reason category value.
- **REFERRAL_REASON_OTHER**: The comment entered when the user chooses "Other" as the reason for referral. If the comment surpasses 60 characters, it will be truncated to 60.

### RFL_REF_TO_REGIONS
**Table**: This table holds the list of geographical areas for referred to geographical steering in Referral and Order Entry. It will only be populated if the "Use Referred to Geographic Areas" Referral system definition is set to Yes.
- **REFERRAL_ID**: The unique ID of the referral.
- **LINE**: The line number for the information associated with this record. Multiple pieces of information can be associated with this record.
- **REF_TO_AREAS_ID**: The unique ID of the geographical area record that was used for referred to geographical steering for this referral. The stored value will be the first populated value from this list: 1) The referred to department's geographic area item  2) The referred to location/POS 3) The referred to vendor 4) The referred to provider

## Sample Data (one representative non-null value per column)

### EPA_INFO
- REFERRAL_ID = `9463136`

### EPA_INFO_2
- REFERRAL_ID = `9463136`

### REFERRAL
- REFERRAL_ID = `9463136`
- EXTERNAL_ID_NUM = `9463136`
- PAT_ID = `Z7004242`
- PCP_PROV_ID = `802011`
- ENTRY_DATE = `1/9/2020 12:00:00 AM`
- RFL_STATUS_C_NAME = `Closed`
- REFERRING_PROV_ID = `802011`
- REFERRING_PROV_ID_REFERRING_PROV_NAM = `DHILLON, PUNEET S`
- PROV_SPEC_C_NAME = `Gastroenterology`
- RFL_TYPE_C_NAME = `Referral`
- RSN_FOR_RFL_C_NAME = `Specialty Services Required`
- RFL_CLASS_C_NAME = `Outgoing`
- AUTH_NUM_OF_VISITS = `1`
- START_DATE = `1/9/2020 12:00:00 AM`
- EXP_DATE = `1/8/2021 12:00:00 AM`
- SERV_AREA_ID = `18`
- COVERAGE_ID = `5934765`
- NUM_PROC = `1`
- SVC_DATE_REAL = `65387`
- PAYOR_ID = `1302`
- PLAN_ID = `130204`
- SERV_DATE = `1/9/2020 12:00:00 AM`
- RETRO_FLAG_YN = `N`
- AUTO_APPROVED_DATE = `1/9/2020 12:00:00 AM`
- AUTH_RSN_C_NAME = `No Approval Necessary - Patient Tracking`
- REFD_BY_LOC_POS_ID = `1700801`
- REFD_TO_LOC_POS_ID = `36997`
- REFD_TO_DEPT_ID = `101401034`
- REFD_TO_SPEC_C_NAME = `Radiology`
- PRIORITY_C_NAME = `Routine`
- IBNR_PAY_UNTIL_DT = `4/8/2021 12:00:00 AM`
- PRIM_LOC_ID = `1700801`
- ACTUAL_NUM_VISITS = `2`
- SCHED_NUM_VISITS = `0`
- REQUEST_NUM_VISITS = `1`
- DISP_VAL_C_NAME = `Appointed`
- REFD_BY_DEPT_ID = `1700801002`
- CLOSE_RSN_C_NAME = `Expired-Auto Closed`
- SCHED_STATUS_C_NAME = `Do Not Schedule`
- SCHED_BY_DATE = `8/13/2020 12:00:00 AM`
- PREAUTH_REQ_C_NAME = `Prior Authorization Number Required`
- PREAUTH_CHG_EMP_ID = `PICONEMA`
- PREAUTH_CHG_EMP_ID_NAME = `PICONE, MARY A`
- PREAUTH_CHNGD_DTTM = `7/14/2020 2:40:00 PM`
- EXT_REF_DATE = `1/9/2020 12:00:00 AM`
- DECISION_DATE = `1/9/2021 12:00:00 AM`
- RFL_STATCHG_RSN_C_NAME = `Canceled Order`

### REFERRAL_2
- REFERRAL_ID = `9463136`
- CALC_SVC_LVL_CNTS = `1`

### REFERRAL_3
- REFERRAL_ID = `9463136`

### REFERRAL_4
- REFERRAL_ID = `9463136`
- RFL_DIRECTION_C_NAME = `Internal`
- REFD_TO_LINK_PROV_YN = `N`
- REFD_TO_LINK_LOC_YN = `N`
- IS_LEAKED_YN = `N`
- RECENT_AUTH_RSN_C_NAME = `Received Carrier Authorization`

### REFERRAL_5
- REFERRAL_ID = `9463136`
- INITIAL_REQUEST_TYPE_C_NAME = `Preservice`
- REF_BY_CNTRCT_AT_AUTH_YN = `N`
- REF_TO_CNTRCT_AT_AUTH_YN = `N`
- REF_BY_SER_CNTRCT_AT_AUTH_YN = `Y`
- REF_BY_EAF_CNTRCT_AT_AUTH_YN = `N`
- REF_TO_EAF_CNTRCT_AT_AUTH_YN = `N`
- REF_BY_CNTRCT_AT_DEC_YN = `N`
- REF_TO_CNTRCT_AT_DEC_YN = `N`
- REF_BY_SER_CNTRCT_AT_DEC_YN = `Y`
- REF_BY_LOC_CNTRCT_AT_DEC_YN = `N`
- REF_TO_LOC_CNTRCT_AT_DEC_YN = `N`

### REFERRAL_APT
- REFERRAL_ID = `13661714`
- LINE_COUNT = `1`
- SERVICE_DATE = `3/11/2022 12:00:00 AM`
- SERVICE_TYPE_C_NAME = `Visit`
- SERIAL_NUMBER = `922942674`
- TABLE_COUNT = `1`

### REFERRAL_CROSS_ORG
- REFERRAL_ID = `15963353`
- LINE = `1`
- CROSS_ORG_RFL_STATUS_C_NAME = `Created`
- CROSS_ORG_RFL_ORGANIZATION_ID = `3600`
- CROSS_ORG_RFL_ORGANIZATION_ID_EXTERNAL_NAME = `UW Health and Affiliates - Wisconsin and Illinois`
- CROSS_ORG_RFL_UNIQUE_IDENT = `15963353.1`
- CROSS_ORG_RFL_ASGN_AUTH_OID = `1.2.840.114350.1.13.283.2.7.2.827076`
- CROSS_ORG_RFL_INST_UPDATE_DTTM = `12/1/2022 4:15:09 PM`

### REFERRAL_CVG
- REFERRAL_ID = `9463136`
- LINE = `1`
- CVG_ID = `5934765`
- CVG_USED_YN = `Y`
- CARRIER_AUTH_CMT = `165183052`
- USE_CHARGE_COUNT_YN = `N`

### REFERRAL_CVG_AUTH
- REFERRAL_ID = `9463136`
- LINE = `1`
- AUTH_CERT_CVG_ID = `5934765`
- PRECERT_CMT_NOTE_ID = `2004601471`
- PRECERT_BEN_NOTE_ID = `3431975380`

### REFERRAL_DX
- REFERRAL_ID = `9463136`
- LINE = `1`
- DX_ID = `260690`

### REFERRAL_HIST
- REFERRAL_ID = `9463136`
- LINE = `1`
- CHANGE_DATE = `12/22/2022 12:00:00 AM`
- CHANGE_TYPE_C_NAME = `Create Referral`
- CHANGE_USER_ID = `KLL403`
- CHANGE_USER_ID_NAME = `LOUGH, KAREN L`
- PREVIOUS_VALUE = `Created from Order 772179267`
- CHANGE_DATETIME = `12/22/2022 5:29:30 PM`
- AUTH_HX_EVENT_NO = `1`
- AUTH_HX_NOTE_ID = `4072440226`
- CHANGE_LOCAL_DTTM = `12/22/2022 11:29:30 AM`
- NEW_RFL_STATUS_C_NAME = `Pending Review`
- NEW_PEND_RSN_C_NAME = `Potential Duplicate Referral`

### REFERRAL_NOTES
- REFERRAL_ID = `10321219`
- LINE = `1`
- NOTE_ID = `2302008978`
- NOTE_USER_ID = `BUDZBANL`
- NOTE_USER_ID_NAME = `BUDZBAN, NICOLE L`
- NOTE_DATETIME = `7/15/2020 11:44:14 AM`

### REFERRAL_ORG_FILTER_SA
- REFERRAL_ID = `9463136`
- LINE = `1`

### REFERRAL_PX
- REFERRAL_ID = `9463136`
- LINE = `1`
- PX_ID = `133`
- UNITS_REQUESTED = `1`
- UNITS_APPROVED = `1`

### REFERRAL_REASONS
- REFERRAL_ID = `9463136`
- LINE = `1`
- REFERRAL_REASON_C_NAME = `Specialty Services Required`

### RFL_REF_TO_REGIONS
- REFERRAL_ID = `9463136`
- LINE = `1`
- REF_TO_AREAS_ID = `6`

## Pipeline Code

### Stage 1: SQL Projection (project.ts → raw JSON)
```typescript
function projectReferrals(patId: unknown): EpicRow[] {
  const rows = mergeQuery("REFERRAL", `b."PAT_ID" = ?`, [patId]);
  for (const r of rows) {
    attachChildren(r, r.REFERRAL_ID, referralChildren);
  }
  return rows;
}

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
]
```

### Stage 2: Domain Model Hydration (PatientRecord.ts)
```typescript
// (raw EpicRow[], no typed class)
```

### Stage 3: Clean Projection (HealthRecord.ts → final output)
```typescript
// (no HealthRecord projection yet)
```

## Actual Output (from health_record_full.json)

```json
null
```

## Instructions

1. Read the Data Model & Mapping Philosophy section first. Understand the three relationship types (structural child, cross-reference, provenance stamp), what CSN columns mean on different tables, and the parallel clinical/billing hierarchy.
2. Read every column's Epic schema description carefully. The schema description is the ground truth for what a column means — column names are often misleading (e.g., SEVERITY_C_NAME is actually the allergy TYPE).
3. Trace each column from the SQL query through PatientRecord hydration to HealthRecord output.
4. For each field in the output, verify: is the source column correct for what this field claims to represent?
5. For each column in the sample data that has a value, verify: is it read by the code? If not, should it be?
6. Check property name continuity across the three stages — does stage 3 read the property that stage 2 wrote?
7. Evaluate structural decisions: is each table correctly classified as structural child, cross-reference, or provenance stamp? Are CSN columns interpreted correctly per the methodology?
8. Check for nondeterminism in queries (missing ORDER BY) and aggregations (tie-breaking).
9. Verify unit/type interpretations: are _C columns (raw category codes) distinguished from _C_NAME columns (display strings)? Are _YN flags correctly interpreted?

Report your findings as a structured list of issues. If you find zero issues, say so explicitly.