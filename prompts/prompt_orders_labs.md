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

Analyze the mapping pipeline for **Orders & Labs: ORDER_PROC + children → ORDER_RESULTS → labResults** and identify every semantic error — places where a column is read successfully but the value means something different than the code assumes.

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

### ADT_ORDER_INFORMATION
**Table**: This table contains information about ADT Orders.
- **ORDER_ID**: The unique identifier for the order record.
- **ACCOMMODATION_C_NAME**: Stores the accommodation code.
- **ACCOM_REASON_C_NAME**: Stores the accommodation code reason.
- **ADT_ADMT_PROV_ID**: Stores the admitting provider.
- **ADT_ATTEND_PROV_ID**: Stores the attending provider.
- **ADM_COND_C_NAME**: Stores the patient condition.
- **ADT_CONSULT_PROV_ID**: Stores the lead consultant.
- **ADT_DX_ID**: Stores the primary diagnosis.
- **ADT_EXPECT_ADMSN_DATE**: Stores the date the patient is expected to be admitted.
- **ADT_EXPECT_DISCHRG_DATE**: Stores the date the patient is expected to be discharged.
- **ADT_EXPECT_STAY_LEN**: Stores the number of days the patient is expected to stay.
- **PAS_HAR_CHNG_RSN_C_NAME**: Stores the reason why the patient's current hospital account is ending, and a new hospital account is beginning.
- **ADT_LOC_ID**: Stores the hospital area.
- **ADT_INTERN_PROV_ID**: Stores the intern provider.
- **LEVEL_OF_CARE_C_NAME**: Stores the level of care.
- **ADT_PAT_CLASS_C_NAME**: Stores the patient class.
- **REASON_C_NAME**: Stores the reason for inserting a patient update event.
- **ADT_RES_PROV_ID**: Stores the resident provider.
- **ADT_RESP_LOC_ID**: Stores the responsible department.
- **ADT_RESP_DEPARTMENT_ID**: Stores the responsible hospital unit.
- **HOSP_SERV_C_NAME**: Stores the service.
- **ADT_SERV_AREA_ID**: Stores the service area.
- **ADT_DEPARTMENT_ID**: Stores the hospital unit.

### CLARITY_EAP
**Table**: The CLARITY_EAP table contains basic information about the procedure records in your system. This does include both A/R and clinical procedures.
- **PROC_ID**: The unique ID of each procedure record in your system. This is not the CPT� code or other procedure code.
- **PROC_NAME**: The name of each procedure.

### CLARITY_EAP_3
**Table**: The CLARITY_EAP_3 table contains basic information about the procedure records in your system. This includes both A/R and clinical procedures. This is a continuation of Clarity table CLARITY_EAP.
- **PROC_ID**: The unique ID number for a procedure record.
- **PT_FRIENDLY_NAME**: The patient friendly procedure name for use in MyChart.

### CLARITY_EAP_5
**Table**: The CLARITY_EAP_5 table contains basic information about the procedure records in your system. This includes both A/R and clinical procedures. This is a continuation of Clarity table CLARITY_EAP.
- **PROC_ID**: The unique identifier (.1 item) for the procedure record.
- **MYC_TKT_OVR_RULE_ID**: Specify a rule to determine when to allow manually sending appointment requests to the patient for scheduling.
- **MYC_TKT_OVR_RULE_ID_RULE_NAME**: The name of the rule.

### CL_ORD_FST_LST_SCH
**Table**: This table stores an order's first and last scheduled date and time, along with the type of review notice for the expire items (i.e. let expire or review).
- **ORDER_ID**: The unique ID of the order record associated with this order.
- **DATE_FIRST_ORDEREN**: Date of the first schedule.
- **TIME_FIRST_ORDEREN**: Time of the first schedule.
- **DATE_LAST_ORDERENT**: Date of the last schedule.
- **TIME_LAST_ORDERENT**: Time of the last schedule.
- **LET_EXPIRE_TYPE_C_NAME**: Determines the type of review notice for the former "let expire" items

### EXTERNAL_ORDER_INFO
**Table**: This table contains data about medication orders in external encounters that was received but could not be stored discretely.
- **ORDER_ID**: The unique identifier (.1 item) for the order record for this row.
- **DISPLAY_NAME**: The display name for the external order.
- **FREQUENCY**: A description of the external order's frequency.
- **LINK_GROUP_IDENTIFIER**: If the external order was part of a linked group, this contains a unique identifier for that group. This is not the ID of any other record in the system.
- **LINK_TYPE_C_NAME**: If the external order was part of a linked group, this contains the link type of that group.

### HV_ORDER_PROC
**Table**: This table contains data on order procedures related to a hospital visit.
- **ORDER_PROC_ID**: The unique ID of the procedure order record.
- **PAT_ENC_DATE_REAL**: This is a numeric representation of the date of this encounter in your system. The integer portion of the number specifies the date of the encounter. The digits after the decimal point indicate multiple visits on one day.
- **PAT_ENC_CSN_ID**: A unique serial number for this encounter. This number is unique across all patients and encounters in the system.
- **DISCR_FREQ_ID**: The discrete frequency associated with the order.
- **DISCR_FREQ_ID_FREQ_NAME**: The name of the frequency record.
- **TRANSPORT_C_NAME**: Determines how the patient associated with this order is to be transported.
- **ORD_PROV_ID**: The provider ID of the ordering provider.
- **STAND_CNT**: The standing count for the order.
- **STND_TP_C_NAME**: The standing count type for the order (i.e. days, weeks, etc.)
- **ADM_DEPARTMENT_ID**: The admission department associated with the order.
- **ADMIT_SERVICE_C_NAME**: The admission service associated with the order.
- **ADM_LVL_OF_CARE_C_NAME**: The admission level of care associated with the order.
- **ADMIT_DX_ID**: The admission diagnosis associated with the order.
- **ADM_COND_C_NAME**: The admission condition associated with the order.
- **ADMIT_LEN_STAY**: The admission expected length of stay.
- **ADMIT_DISCHG_DATE**: The admission expected date of discharge.
- **ADMIT_RES_PROV_ID**: The provider ID of the senior admitting resident.
- **ADM_INTRN_PROV_ID**: The provider ID of the admitting intern.
- **EXP_ADMIT_DT**: The expected admission date.
- **TF_DEPARTMENT_ID**: The transfer department associated with the order.
- **TRANFER_SVC_C_NAME**: The service associated with the transfer department.
- **TF_LVL_OF_CARE_C_NAME**: The transfer level of care associated with the order.
- **TRANFER_DX_ID**: The diagnosis ID associated with the transfer order.
- **TRANFER_COND_C_NAME**: The condition specified with the transfer order.
- **TRANFER_LEN_STAY**: The expected length of stay associated with the transfer order.
- **TRANFER_DISCHR_DT**: The expected discharge date associated with the transfer order.
- **TRANFER_PROV_ID**: The provider ID of the admitting provider.
- **DCHRG_EXP_TIME**: The expected discharge date and time associated with the discharge order.
- **DISCH_DISP_C_NAME**: The discharge disposition associated with the discharge order.
- **DISCH_DEST_C_NAME**: The discharge destination associated with the discharge order.
- **ISOLATION_C_NAME**: The isolation status of the patient associated with the order.
- **CODESTATUS_C_NAME**: The code status of the patient associated with the order.
- **DIET_C_NAME**: The diet status of the patient associated with the order.
- **INST_OF_UPDATE_TM**: The day and time the order record was last updated.
- **PAT_UPD_DTTM**: The effective date and time of the patient update that should be generated from this order.
- **PAT_UPD_PAT_CLS_C_NAME**: The patient class of the patient update that should be generated from this order.
- **PAT_UPD_SVC_C_NAME**: The service of the patient update that should be generated from this order.
- **PAT_UPD_ACCOM_CD_C_NAME**: The accommodation code of the patient update that should be generated from this order.
- **PAT_UPD_ACCOM_RSN_C_NAME**: The accommodation reason of the patient update that should be generated from this order.
- **PAT_UPD_LOC_C_NAME**: The level of care of the patient update that should be generated from this order.
- **PAT_UPD_RSN_C_NAME**: The reason for change of the patient update that should be generated from this order.
- **CONSULTANT_ID**: Stores the Lead Consultant entered by the user during order entry for transfer and patient update orders.
- **LEAVE_OF_ABSENCE_REASON_C_NAME**: The category ID for the reason that the patient is to go on leave from the current admission. This column is only likely to be populated for Leave of Absence orders.
- **LEAVE_OF_ABSENCE_LEAVE_DTTM**: The date and time that the patient is expected to go out on leave. This column is only likely to be populated for Leave of Absence orders.
- **LEAVE_OF_ABSENCE_RETURN_DTTM**: The date and time that the patient is expected to return from leave. This column is only likely to be populated for Leave of Absence orders.
- **LEAVE_OF_ABSENCE_HOLD_BED_YN**: Whether or not the patient's current bed should be held during the upcoming leave. This column is only likely to be populated for Leave of Absence orders.
- **DCHRG_EXP_DATE**: The expected discharge date associated with the discharge order.
- **TRANSFER_REQUEST_TYPE_C_NAME**: The type of transfer request being ordered.
- **ADT_PATIENT_CLASS_C_NAME**: Patient class used for transfer request orders.
- **HOSP_AREA_ID**: Hospital area to request a patient transfer.
- **TRANSFER_CENTER_REGION_ID**: Stores the Transfer Center region.
- **TRANSFER_CENTER_REGION_ID_RECORD_NAME**: The name of this cleaning sector.
- **CODE_STATUS_COMMENTS**: The code status comments associated with the order.
- **EXP_DIS_APPROX_TM_C_NAME**: The approximate expected discharge time category ID for the order.

### OBS_MTHD_ID
**Table**: Methods used to perform component test in lab.
- **ORDER_ID**: The unique identifier for the order record.
- **CONTACT_DATE_REAL**: A unique contact date in decimal format. The integer portion of the number indicates the date of contact. The digits after the decimal distinguish different contacts on the same date and are unique for each contact on that date. For example, .00 is the first/only contact, .01 is the second contact, etc.
- **LINE**: The line number for the information associated with this contact. Multiple pieces of information can be associated with this contact.
- **CONTACT_DATE**: The date of this contact in calendar format.

### ORDER_ANATOMICAL_REGION
**Table**: This table stores the anatomical regions of this order.
- **ORDER_ID**: The unique identifier (.1 item) for the order record.
- **LINE**: The line number for the information associated with this record. Multiple pieces of information can be associated with this record.
- **ANATOMICAL_REGION_C_NAME**: Stores the Anatomical Region category IDs associated to this procedure.

### ORDER_AUTH_INFO
**Table**: This table holds information about prior authorization for medications in certain workflows. It is currently only used when communicating with eClaimLink for authorizations.
- **ORDER_ID**: The unique identifier for the order record.
- **MED_AUTH_RESULT_C_NAME**: Holds the medication authorization result.
- **MED_AUTH_NUM**: Holds the authorization ID returned by the payer.
- **AUTH_DENY_RSN_ID**: Holds the authorization denial reason.
- **AUTH_DENY_RSN_ID_EXT_CODE_LST_NAME**: The name of the list value.
- **AUTH_START_UTC_DTTM**: This item holds the instant the authorization is valid from.
- **AUTH_END_UTC_DTTM**: This item holds the instant the authorization is valid to.
- **AUTH_LIMIT**: Holds the medication authorization limit.

### ORDER_COMMENT
**Table**: The ORDER_COMMENT table allows you to report on comments for non-medication orders.
- **ORDER_ID**: The unique identifier for the non-medication order.
- **LINE**: The line number for the information associated with this contact. Multiple pieces of information can be associated with this contact.
- **ORDERING_COMMENT**: Free text comment for non-medication orders.

### ORDER_DOCUMENTS
**Table**: This table contains the DCS records attached to an order on a contact level such as scanned hard copy prescriptions, Lab Scans and Lab Reports.
- **ORDER_ID**: The unique identifier (.1 item) for the order record.
- **CONTACT_DATE_REAL**: A unique contact date in decimal format. The integer portion of the number indicates the date of contact. The digits after the decimal distinguish different contacts on the same date and are unique for each contact on that date. For example, .00 is the first/only contact, .01 is the second contact, etc.
- **LINE**: The line number for the information associated with this contact. Multiple pieces of information can be associated with this contact.
- **CONTACT_DATE**: The date of this contact in calendar format.

### ORDER_DX_PROC
**Table**: The ORDER_DX_PROC table enables you to report on the diagnoses associated with procedures ordered in clinical system. Since one procedure order may be associated with multiple diagnoses, each row in this table is one procedure - diagnosis relation. We have also included patient and contact identification information for each record. Note that system settings may or may not require that procedures be associated with diagnoses.  This table contains only information for those procedures and diagnoses that have been explicitly associated. Check with your clinical system Application Administrator to determine how your organization has this set up.
- **ORDER_PROC_ID**: The unique ID of the procedure order record.
- **LINE**: The line number for the information associated with this procedure record. Multiple pieces of information can be associated with this record.
- **PAT_ENC_DATE_REAL**: A unique contact date in decimal format. The integer portion of the number indicates the date of contact. The digits after the decimal distinguish different contacts on the same date and are unique for each contact on that date. For example, .00 is the first/only contact, .01 is the second contact, etc.
- **PAT_ENC_CSN_ID**: The unique contact serial number for this contact. This number is unique across all patient encounters in your system. If you use IntraConnect, this is the Unique Contact Identifier (UCI).
- **DX_ID**: The unique ID of the diagnosis record associated with the procedure order.
- **DX_QUALIFIER_C_NAME**: The diagnosis qualifier category ID, which indicates modifier information for the diagnosis associated with the order record.
- **COMMENTS**: Comments added when the procedure was ordered
- **DX_CHRONIC_YN**: Indicates whether the diagnosis associated with this order record was marked as chronic during the ordering process. 'Y' indicates that a the diagnosis was marked as chronic. 'N' or NULL indicate that a the diagnosis was not marked as chronic.
- **ASSOC_DX_DESC**: This column stores a free text diagnosis description entered by the end user.  Also referred to as the "display as" field.
- **ASSOC_REQ_DX_ID**: The unique ID of the original requisition diagnosis associated with the order. Diagnoses stored by this item might be entered for either clinical or billing purposes.

### ORDER_IMAGE_AVAIL_INFO
**Table**: This table has, for this imaging order, the image availability information for each of the image archives from which you receive Image Availability Notifications.
- **ORDER_ID**: The unique identifier (.1 item) for the order record.
- **LINE**: The line number for the information associated with this record. Multiple pieces of information can be associated with this record.
- **IMAGE_LOCATION_C_NAME**: The server name category ID that store images for the imaging order.
- **IMG_AVAIL_YN**: Indicates whether images are available at this location. 'Y' indicates that images are available. 'N' or NULL indicates that images are not available.
- **IMG_AVAIL_DTTM**: The updated date and time of the image availability information for the related image storage location.

### ORDER_IMPRESSION
**Table**: This table stores impression information for a procedure.
- **ORDER_PROC_ID**: The unique ID of the procedure order record.
- **LINE**: The line count for the reading physician's impression.
- **IMPRESSION**: The reading physician's impression for this procedure.
- **ORD_DATE_REAL**: This is a numeric representation of the date each order was placed in your system. The integer portion of the number specifies the date the order was placed. The digits after the decimal point indicate multiple orders on one day.
- **CONTACT_DATE**: The calendar date that the order was placed.

### ORDER_INSTANTIATED
**Table**: This table contains a list of orders that have been instantiated.
- **ORDER_ID**: The unique ID of the order record.
- **LINE**: The line count for this table as determined by the number of instantiated orders.
- **INSTNTD_ORDER_ID**: The ID for the instantiated order, the child.  Note: For the case of the grandparent/parent/child scenario (Outpatient Standing order released into an Inpatient/HOV setting), this column will store the child (i.e. �grandchild�) order and the ORDER_ID column will store the parent order.  For the grandparent/parent order relationship, refer to STAND_HOV_INST_ORD.ORDER_ID (�grandparent�) and STAND_HOV_INST_ORD.STAND_INS_IP_ORD_ID (�parent�).

### ORDER_MYC_INFO
**Table**: When sharing a lab result with a web-based chart system patient, the clinician may choose to attach a Result Comment. Data for the Result Comment patient note is stored in this table.
- **ORDER_PROC_ID**: The unique ID of the procedure order record that is being released/unreleased.
- **RELEASED_YN**: Whether a result is released to a patient on MyChart.

### ORDER_MYC_RELEASE
**Table**: When a clinician (or interface) releases/unreleases a lab result to/from a web based chart system patient, tracking data for that action is stored in this table.
- **ORDER_PROC_ID**: The unique ID of the procedure order record that is released/unreleased.
- **LINE**: Since an order can be released/unreleased multiple times, the line number identifies a particular release instance.
- **RELEASE_USER_ID**: The ID of the Hyperspace user who released/unreleased the lab result to the web based chart system patient.
- **RELEASE_USER_ID_NAME**: The name of the user record. This name may be hidden.
- **RELEASE_ACTION_C_NAME**: This item indicates the action taken on the lab result. The data stored is a category value. 1 corresponds to Released. 2 corresponds to Unreleased.   A null value also corresponds to Unreleased.
- **MYC_REL_UTC_DTTM**: Contains the instant when a result was released to MyChart in UTC.

### ORDER_NARRATIVE
**Table**: This table stores the narrative information resulting from a procedure.
- **ORDER_PROC_ID**: The unique ID of the procedure order record.
- **LINE**: The line number for the information associated with this record. Multiple pieces of information can be associated with this record
- **NARRATIVE**: Stores the narrative information for this order.
- **ORD_DATE_REAL**: This is a numeric representation of the date each order was placed in your system. The integer portion of the number specifies the date the order was placed. The digits after the decimal point indicate multiple orders on one day.
- **CONTACT_DATE**: The calendar date that the order was placed.
- **IS_ARCHIVED_YN**: Indicates whether the order narrative is archived. Y� indicates that the order narrative is archived. N� or NULL indicate that the order narrative is not archived.

### ORDER_PENDING
**Table**: This table contains information on pending orders.
- **ORDER_ID**: The unique identifier for the pended order record.
- **LINE**: The line number for the information associated with this record. Multiple pieces of information can be associated with this record
- **USER_ID**: The unique ID of the user pending the order.
- **USER_ID_NAME**: The name of the user record. This name may be hidden.
- **PENDED_TIME**: The time an order was pended.
- **PENDED_FOR**: The reason an order was pended.
- **RELEASED_USER_ID**: The unique ID of the user releasing a pended medication.
- **RELEASED_USER_ID_NAME**: The name of the user record. This name may be hidden.
- **PENDING_COMMENTS**: Order pending comments.
- **PEND_REASON_C_NAME**: Order pending reason.
- **SH_ORDR_PROV_ID**: The unique identifier of the ordering provider for a signed and held order.
- **SH_AUTH_PROV_ID**: The unique identifier of the authorizing provider for this signed and held order record. A signed and held order is an order record that has been authorized but is intended for future use and is not yet active.
- **SH_ORDER_MODE_C_NAME**: The verbal order mode category ID for the signed and held order, indicating the way the order was placed, e.g. telephone with readback.
- **SH_VERB_ORD_COMMENT**: The comment entered by a user when creating a signed and held order.
- **SH_VRB_COMM_PROV_ID**: The unique identifier of the provider who verbally received the order and entered the order record in the system.
- **SH_COSIGN_USER_ID**: The unique identifier of the user responsible for providing a cosignature for the order.
- **SH_COSIGN_USER_ID_NAME**: The name of the user record. This name may be hidden.
- **SH_COSIGN_REQ_YN**: Indicates whether this order required a cosignature. 'Y' indicates that the order required a cosignature. 'N' or NULL indicates that the order did not require a cosignature.
- **SH_VBL_CSN_NO_REQ_N**: Indicates whether a rule was used to prevent generating a verbal signature requirement for the order record.
- **SH_COS_REQ_RSN_C_NAME**: The signature requirement creation source category ID for the order, indicating the reason a cosignature is required for this signed and held order.

### ORDER_PROC
**Table**: The ORDER_PROC table enables you to report on the procedures ordered in the clinical system. We have also included patient and contact identification information for each record.
- **ORDER_PROC_ID**: The unique ID of the order record associated with this procedure order.
- **PAT_ID**: The unique ID of the patient record for this order. This column is frequently used to link to the PATIENT table.
- **PAT_ENC_DATE_REAL**: A unique, internal contact date in decimal format. The integer portion of the number indicates the date of the contact. The digits after the decimal distinguish different contacts on the same date and are unique for each contact on that date. For example, .00 is the first/only contact, .01 is the second contact, etc.
- **PAT_ENC_CSN_ID**: The unique contact serial number for this contact. This number is unique across patients and encounters in your system. If you use IntraConnect this is the Unique Contact Identifier (UCI).
- **RESULT_LAB_ID**: The unique ID of the lab or other resulting agency, such as radiology, that provided the order results.
- **RESULT_LAB_ID_LLB_NAME**: Interface laboratory name.
- **ORDERING_DATE**: The date when the procedure order was placed.
- **ORDER_TYPE_C_NAME**: The order type category number for the procedure order.
- **PROC_ID**: The unique ID of the  procedure record corresponding to this order. This can be used to link to CLARITY_EAP.
- **DESCRIPTION**: A brief summary of the procedure order.
- **ORDER_CLASS_C_NAME**: The order class category number of the procedure order.
- **AUTHRZING_PROV_ID**: The unique ID of the provider prescribing or authorizing the order.
- **ABNORMAL_YN**: Indicates whether or not this order contains abnormal results. This column will contain a Y if there are abnormal results and an N or null if it does not. For orders with lab component results, if any one component of this order has an abnormal result value then this will hold a Y.
- **BILLING_PROV_ID**: The unique ID of the provider under whose name this order should be billed. This might be the same ID as the AUTHRZING_PROV_ID.
- **ORD_CREATR_USER_ID**: The unique identifier of the user who signed the order, or the last person who performed a sign and hold or release action for a signed and held order.
- **ORD_CREATR_USER_ID_NAME**: The name of the user record. This name may be hidden.
- **LAB_STATUS_C_NAME**: The category number for the status of results for an order, as of the date and time the record was extracted.
- **ORDER_STATUS_C_NAME**: The order status category number of the procedure order.
- **MODIFIER1_ID**: The unique ID of the modifier record.  This is the first modifier entered for the procedure and affects how the procedure is billed.
- **MODIFIER1_ID_MODIFIER_NAME**: The name of the modifier record.
- **MODIFIER2_ID**: The unique ID of the modifier record.  This is the second modifier entered for the procedure and affects how the procedure is billed.
- **MODIFIER2_ID_MODIFIER_NAME**: The name of the modifier record.
- **MODIFIER3_ID**: The unique ID of the modifier record.  This is the third modifier entered for the procedure and affects how the procedure is billed.
- **MODIFIER3_ID_MODIFIER_NAME**: The name of the modifier record.
- **MODIFIER4_ID**: The unique ID of the modifier record.  This is the fourth modifier entered for the procedure and affects how the procedure is billed.
- **MODIFIER4_ID_MODIFIER_NAME**: The name of the modifier record.
- **QUANTITY**: The number of procedures authorized for this order.
- **REASON_FOR_CANC_C_NAME**: The reason for cancellation category number for the procedure order.
- **FUTURE_OR_STAND**: This column indicates whether an order is a future (F) or standing (S) order.
- **STANDING_EXP_DATE**: The date when a recurring procedure order expires.
- **FUT_EXPECT_COMP_DT**: The date by which each future procedure order should be completed. Displayed in calendar format.
- **STANDING_OCCURS**: The number of individual occurrences remaining for this procedure order.
- **STAND_ORIG_OCCUR**: The total number of occurrences that a recurring order was authorized for.
- **REFERRING_PROV_ID**: The unique ID of the provider who has referred this order, i.e. the referring provider.
- **REFERRING_PROV_ID_REFERRING_PROV_NAM**: The name of the referral source.
- **REFD_TO_LOC_ID**: The unique ID of the location record to which this patient was referred.
- **REFD_TO_SPECLTY_C_NAME**: The category value for the medical specialty of the provider to which the patient is referred.  This field does not contain data for referral orders created within Epic.
- **REQUESTED_SPEC_C_NAME**: The medical specialty category number of the provider to which the patient was referred for the procedure order.
- **RFL_CLASS_C_NAME**: The referral class category number for the procedure order.
- **RFL_TYPE_C_NAME**: The referral type category number for the procedure order.
- **RSN_FOR_RFL_C_NAME**: The reason for referral category number for the procedure order.
- **RFL_NUM_VIS**: The number of visits this referral order is authorized for.
- **RFL_EXPIRE_DT**: The expiration date for this referral order.
- **ABN_NOTE_ID**: The unique ID of the notes record representing the Advanced Beneficiary Notice form associated with this order.
- **RADIOLOGY_STATUS_C_NAME**: The category ID for the imaging study status (e.g. technician ended the exam, reading physician finalized the exam) of the procedure order.
- **INT_STUDY_C_NAME**: The category ID for denoting the reason a study is worth being marked for later review, as in for an educational case or for group reading physician review.
- **INT_STUDY_USER_ID**: The unique ID of the employee record who denoted a study as worth being marked for later review, as in for an educational case or for group reading physician review.
- **INT_STUDY_USER_ID_NAME**: The name of the user record. This name may be hidden.
- **TECHNOLOGIST_ID**: The unique ID of the employee record of the technologist who performed this procedure.
- **TECHNOLOGIST_ID_NAME**: The name of the user record. This name may be hidden.
- **PROC_BGN_TIME**: The date and time when the procedure order (exam) is to begin.
- **RIS_TRANS_ID**: The unique ID of the user record of the transcriptionist for this order.
- **RIS_TRANS_ID_NAME**: The name of the user record. This name may be hidden.
- **ORDER_INST**: The instant when the order was created.
- **DISPLAY_NAME**: The name of the order as it appears in the patient's record.
- **HV_HOSPITALIST_YN**: Indicates whether or not this order was placed by a hospitalist. �Y�  indicates that this order was placed by a hospitalist. �N� or NULL indicate that this order was not placed by a hospitalist.
- **ORDER_PRIORITY_C_NAME**: The overall priority category number for the procedure order.
- **CHRG_DROPPED_TIME**: The date and time when the charge was generated for the procedure order.
- **PANEL_PROC_ID**: The unique ID of the panel procedure record associated with this order.
- **STAND_INTERVAL**: The time interval set for a recurring order, indicating the time between one instance of the order and the next instance.
- **DISCRETE_INTERVAL_NAME**: The discrete interval for the order.  This is extracted as the category title.
- **INSTANTIATED_TIME**: The date and time of instantiation when a child order is generated from a standing or future order.
- **INSTNTOR_USER_ID**: The unique ID of the user who instantiated the order.
- **INSTNTOR_USER_ID_NAME**: The name of the user record. This name may be hidden.
- **DEPT_REF_PROV_ID**: The unique ID of the department to which this order is referred.
- **SPECIALTY_DEP_C_NAME**: The category value for the requested medical specialty of the department to which the patient is referred.
- **SPECIMEN_TYPE_C_NAME**: The specimen type category number for the procedure order.
- **SPECIMEN_SOURCE_C_NAME**: The source category number for the procedure order.
- **ORDER_TIME**: The date and time when the procedure order was placed.
- **RESULT_TIME**: The most recent date and time when the procedure order was resulted.
- **IS_PENDING_ORD_YN**: Indicates whether or not the order has a pending status. 'Y' indicates that the order has a pending status. 'N' or NULL indicates that the order does not have a pending status.
- **PROC_START_TIME**: The date and time when the procedure order is to start.
- **PROBLEM_LIST_ID**: The unique ID of the problem list record that is associated with this order. This column is mainly used for immunization orders.
- **RSLTS_INTERPRETER**: The name of the principal results interpreter, the person who reviewed and interpreted the results.
- **PROC_ENDING_TIME**: The date and time when the procedure order is to end.
- **SPECIFIED_FIRST_TM**: The first occurrence time specified by a user, if the order was signed with a frequency record containing a schedule of specified dates and times.
- **SCHED_START_TM**: This column stores the scheduling start instant used when the order was last scheduled.
- **SESSION_KEY**: The unique key associated with the order at the time of signing.  Other orders will share this key if they were signed at the same time.
- **LABCORP_BILL_TYPE_C_NAME**: The reference lab bill type category ID for the order record, indicating how reference labs should bill for services performed.
- **LABCORP_CLIENT_ID**: The client ID or account ID assigned by the reference lab.
- **LABCORP_CONTROL_NUM**: Required information for LabCorp requisition and order messages.
- **CHNG_ORDER_PROC_ID**: The unique ID of the changed or reordered procedure order that this procedure replaced. This column is frequently used to link back to ORDER_PROC table.

### ORDER_PROC_2
**Table**: The ORDER_PROC_2 table enables you to report on the procedures ordered in the clinical system. This procedure table has the same basic structure as ORDER_PROC, but was created as a second table to prevent ORDER_PROC from getting any larger.
- **ORDER_PROC_ID**: The unique ID of the procedure order record.
- **PROV_ID**: The unique ID of the reading physician of the exam.
- **MOD_BEGIN_TM**: For procedures performed on modalities using Digital Imaging and Communications in Medicine (DICOM), this stores the start date & time of the performed procedure sent from the modality to system.
- **MOD_END_TM**: For procedures performed on modalities using Digital Imaging and Communications in Medicine (DICOM), this stores the end date & time of the performed procedure sent from the modality to system.
- **OVERRIDE_TM**: Stores the most recent time a hard stop was overridden at begin or end exam in radiology
- **RVSN_RSN_C_NAME**: The revision reason category number for the order. This depicts the reason that a radiology transcriptionist marked a study as needing revision.
- **CHANGE_REASON_C_NAME**: The change status reason category ID for the order, which indicates the reason given for reverting an order to a previous radiology status.
- **CHANGE_CMT**: Stores the comment given for reverting an order to a previous radiology status.
- **STUDY_INSTANCE**: This column stores the unique identifier for an instance of a DICOM imaging study.
- **CHARGE_TM**: The date and time a charge was generated by ending a radiology exam.
- **GRP_ORDER_PROC_ID**: The unique identifier of the master procedure record used for grouped imaging orders.
- **ORDER_PRIORITY_C_NAME**: Stores the radiology result priority.
- **BALANCE_ADJ_YN**: Stores whether the balance for supplies/drugs is already adjusted.
- **IMAGE_LOCATION_C_NAME**: Stores the category ID of the PACS (picture archiving and communication) system has the images for a radiology order.
- **IMAGES_AVAIL_YN**: Stores whether images are available via PACS (picture archiving and communication system) for a radiology order. 'Y' indicates that the images are available, 'N' and NULL indicate that the images are not available.
- **PAT_LOC_ID**: The unique identifier of the department where the patient is located at the time this order was signed,
- **ACT_ORDER_C_NAME**: The active order category ID, which indicates information about the order status.
- **PAT_ENC_CSN_ID**: The unique contact serial number for this contact. This number is unique across all patient encounters in your system. If you use IntraConnect, this is the Unique Contact Identifier (UCI).
- **LET_EOD_PRNT_DATE**: The date a letter will be created and printed for this order. This is cleared after the letter has been created and printed.
- **ORDER_SOURCE_C_NAME**: The order source category ID of the order, indicating where in the EHR the order was entered.
- **SPECIMN_TAKEN_DATE**: The date the specimen was taken.
- **SPECIMN_TAKEN_TIME**: The time the specimen was taken.
- **LET_EXPIRE_USER_ID**: The ID of the user who marked order as Let Expire.
- **LET_EXPIRE_USER_ID_NAME**: The name of the user record. This name may be hidden.
- **TIME_LET_EXPIRE**: The time when the physician marked the order as Let Expire.
- **EXP_AFT_START_TIME**: The date and time an order will be marked as needing review by a physician, based on a defined period of time after the order starts.
- **EXP_BEF_END_TIME**: The date and time an order will be labeled as expiring, based on a defined period of time before the order's end time.
- **ORD_COPIED_C_NAME**: The order copy status category ID, indicating whether the order was copied to another visit.
- **REV_ORD_GRANU_YN**: Determines if an order is reviewed by day or by instant.
- **EXP_DAYS_YN**: Indicates whether the amount of time determining when an order will expire is in measured in days or instants. '0' indicates that the expiration time is in a number of hours. '1' indicates the expiration time is in a number of days or weeks.
- **CHRG_METHOD_ID**: The unique identifier of the charge trigger method associated with the order.
- **CHRG_METHOD_ID_CHRG_METHOD_NAME**: The name of the charge trigger method.
- **SPECIMEN_COMMENTS**: This free text item is used to store comments about the specimen source.
- **SPECIMEN_RECV_DATE**: This item stores the date that the specimen was received. It is in the same logical group as the SPECIMEN_RECV_TIME column.
- **SPECIMEN_RECV_TIME**: This item stores the time the specimen was received. It is in the same logical group as the SPECIMEN_RECV_DATE column.
- **COLLECTOR_IDN**: The name of the user who collected the specimen for the order.
- **COLLECTOR_USER_ID**: The unique identifier of the user who collected the specimen for the order.
- **COLLECTOR_USER_ID_NAME**: The name of the user record. This name may be hidden.
- **FUTURE_APPROX_DT_YN**: Indicates whether there is an approximate future expected date for this order. 'Y' indicates there is an approximate future expected date. 'N' or NULL indicates that there is not an approximate future expected date.
- **LAST_STAND_PERF_DT**: The date on which a standing order was last performed.
- **LAST_STAND_PERF_TM**: The time at which a standing order was last performed.
- **PERFORMING_DEPT_ID**: The unique identifier of the department where the order was performed.
- **ORIGINAL_ORD_ID**: When an order record is created as the result of a procedure change workflow, it stores a pointer to the previous order. To reliably find the original order record, refer to ORDER_PROC_5.ORIGINATING_ORD_ID
- **EXTERNAL_ORD_ID**: Stores the external order ID for the order.
- **REMARKS_HNO_ID**: Stores the link to the general notes record containing the result remarks. It is networked to General Use Notes record.
- **SER_ADDRESSID**: Stores the referring provider address ID for referral orders. The format is provider external ID - Address line number. For example, if provider external ID = 123 and Address line = 4, the value would be 123-4. If the referring provider has no address, this will store the provider external ID only.  Other columns in the same logical group are: REFG_FACILITY_ID (ORD 3010), REFD_TO_PROV_ID(ORD 3100) and REFERRAL_ID (ORD 3300)
- **REFG_FACILITY_ID**: Stores the referring facility for referral orders. This is networked to the facility record. Other columns in the same logical group are: SER_ADDRESSID (ORD 3001), REFD_TO_PROV_ID(ORD 3100) and REFERRAL_ID (ORD 3300)
- **REFD_TO_PROV_ID**: The unique ID of the provider referred to for a referral order. Other columns in the same logical group are: SER_ADDRESSID (ORD 3001), REFG_FACILITY_ID (ORD 3010) and REFERRAL_ID (ORD 3300)
- **REFERRAL_ID**: Stores the associated referral ID for referral orders. Other columns in the same logical group are: SER_ADDRESSID (ORD 3001), REFG_FACILITY_ID (ORD 3010) and REFD_TO_PROV_ID(ORD 3100)
- **LAST_RESULT_UPD_TM**: The date and time of the last result date. This item is set based on a time stamp received in the interface. It is also set when results are manually entered or when an order is cancelled.
- **COLLECTION_DEPT_ID**: The unique identifier of the department where the specimen was collected.
- **USER_ID_OF_PROV**: The unique identifier for the authorizing provider of the order record.
- **LOGIN_DEP_ID**: The unique identifier for the login department used by the user signing the order.
- **PERFS_FILED_INST**: The date and time the order was performed.
- **CHGS_FILED_INST**: The date and time that charges were filed.
- **NOCHG_REASON_C_NAME**: Contains the reason that no charges were linked to the order.
- **ORD_PRV_ROUT_MTHD_C_NAME**: This item stores the routing method for the ordering provider
- **ORD_PRV_ROUT_ADDR**: The address of the ordering provider which will be used to receive the results of this order.
- **RIS_SIGN_AGAIN_R_YN**: Indicates whether multi-discipline studies will be sent back to previous signers for review if the result text has been changed for this order. Yes indicates that studies will be sent back. No or Null will indicate that studies will not be sent back. The data is automatically populated when an imaging study reaches Exam Ended or Exam Begun from the value in field "Sign Again if Result Text Changed" in the Radiology/Cardiology Options 3 screen of the linked procedure. If that is null then we look at the same field in the procedure category or the Study review node of the Imaging System Definitions. Users can change the original value by changing the same field in the advanced mode of the Assign Activity.
- **ABN_WAIVER_SIGN_YN**: Indicates whether an Advanced Beneficiary Notice waiver form was signed by the patient in the event that the service to be performed was denied by Medicare.
- **CHECK_OUT_COMMENT**: The check-out comments entered on the order.
- **RQG_ID**: The unique ID of patient and coverage information for non-participatory lab referrals attached to this order.  If this is filled in, then PAT_ID and related columns in the ORDER_PROC table will not be filled in for this order.  This column is frequently used to link to the RQG_DB_MAIN table.
- **SITE_OF_COLLECT_C_NAME**: The site of collection category number for the location on patient in which the specimen was drawn.
- **LAB_CANCEL_REQ_ID**: The unique ID of the user who requested to cancel the order.
- **LAB_CANCEL_REQ_ID_NAME**: The name of the user record. This name may be hidden.
- **PROTCL_STAT_DT**: The date an unscheduled order was placed, or the appointment date for a scheduled order which requires a protocol.
- **PROTCL_STATE_C_NAME**: The scheduling status for an order which requires a protocol.  This column links to the ZC_PROTCL_STATE table.
- **LAB_CHG_TRG_YN**: Indicates whether a charge was triggered in lab.
- **LAB_ACCOUNT_ID**: The unique ID of the order level account record override associated with this order.
- **LAB_COVERAGE_ID**: The unique ID of the order level coverage record associated with this order.
- **LAB_DONT_BIL_INS_YN**: Indicates whether insurance should be billed for this order. 'Y' indicates that insurance should not be billed. 'N' or NULL indicates that insurance should be billed.
- **USER_CONTEXT_C_NAME**: Assigns an order a category ID with a user's context. The order can be used for or created for procedure orders.
- **EFQ_OVRD_DAY_TYPE**: The items indicate the override values for cycle length and day type (relative vs weekdays). Specifies what the numeric values in the frequency override days columns represent. If it is 1 then the listed days are relative days. If it is 2 then the listed days are weekdays. Any other value has no meaning.
- **EFQ_OVRD_CYCL_LEN**: If there is a frequency override specified, this item will contain the length of the relative specified frequency cycle (e.g. hours, days)
- **CHART_CORRECTION_ID**: The unique identifier of the chart correction audit record for the order.
- **PARENT_CE_ORDER_ID**: When a cross-encounter order is released, this item stores the ID of the parent order.
- **CONDITIONAL_C_NAME**: The inpatient conditional order category ID for the order, indicating whether this order should be conditionally initiated.
- **COND_STATUS_C_NAME**: The inpatient conditional status category ID for the order, indicating whether the conditions for the order to be initiated have been satisfied yet.
- **INTERFACE_YN**: Indicates whether this order was resulted through an interface or not. Y indicates that the result came through an interface, N indicates it was not resulted through an interface but rather some other result mechanism or not resulted at all.
- **CASE_PANEL_NUM**: The surgical panel that this order is associated with.
- **IS_SAVED_ORDER_YN**: Indicates whether an order has a status of saved. A "Yes" value indicates that the order is in a status of saved. A null value indicates that the order is not in a status of saved. A "No" value will not be populated for this column.
- **OVRD_TASK_TEMP_ID**: Contains the override task template ID for overriddem anchored orders, orders attached to a time (for example, a pregnant woman's delivery date).
- **OVRD_TASK_TEMP_ID_RECORD_NAME**: This column displays the name of the task template record.
- **SOURCE_OF_PRI_INS_C_NAME**: The source of prioritized date category ID for the order record. Prioritized date is determined by the following hierarchy: collection date and time, result date and time, release date and time (for future and standing orders), order date and time, and encounter date.
- **PRIORITIZED_INST_TM**: The time and date that is used as the prioritized date.
- **ORDER_QUESN_LIST**: The list of question records associated with this order.
- **HOME_CARE_TYPE_C_NAME**: This item stores the type of home care episode the order should create if it is a home care referral order.
- **SPECIMEN_BARCODE**: Stores the barcode data scanned during specimen collection.

### ORDER_PROC_3
**Table**: The ORDER_PROC_3 table enables you to report on the procedures ordered in the clinical system. This procedure table has the same basic structure as ORDER_PROC, but was created as a third table to prevent ORDER_PROC_2 from getting any larger.
- **ORDER_ID**: The unique identifier for the order record.
- **MAMMO_OUTCOME_C_NAME**: This column stores the outcome (e.g. FP/FN/TP/FN/etc) for a mammography study. This column is used to link to the ZC_MAMMO_OUTCOME table.
- **OLD_RAD_STAT_C_NAME**: This stores the category ID for the imaging study status (e.g. technician ended the exam, reading physician finalized the exam) before the order was canceled. This will only be populated for canceled imaging orders. This column is used to link to the ZC_RADIOLOGY_STS table.
- **TRANSCRIPTIONIST**: The transcriptionist of an external order result coming through the transcription interface.
- **ORDERING_MODE_C_NAME**: This indicates whether an order is an inpatient or outpatient order. Note that Outpatient orders can be placed from an Inpatient encounter as discharge orders. This column might be blank for Outpatient orders placed prior to the creation of the IP module. This column is used to link to the ZC_ORDERING_MODE table.
- **PROV_STATUS_C_NAME**: The provider status category number for the order at the time of the extract. This item reflects the providers' viewed status of the order result message.  The amount, frequency and type of data stored in this item depends on the programming point records entered into the results message type definition in use at each facility. This column is used to link to the ZC_PROV_STATUS table.
- **RESULT_TYPE_C_NAME**: The result type category number for the order, if noted. A null value indicates that it is normal order results. This column is used to link to the ZC_ORD_RESULT_TYPE table.
- **RFL_PRIORITY_C_NAME**: The priority level category number of a referral order, which is used to specify whether a referral order is routine, urgent, emergency or elective. This column is used to link to the ZC_RFL_PRIORITY table.
- **REFLEX_ORDER_ID**: The order ID from which this reflex order was created.
- **ORD_TRANS_METHOD_C_NAME**: This item holds the method of transmission for a given order.  It should only be set from a property within an order transmittal rule.
- **NUM_SIG_REQ**: The number of physician signatures required to move the study status to final within the procedural applications.
- **DURATION**: Duration for this procedure.
- **INTERVENTION**: Intervention for this procedure.
- **SIGN_ACTION_PEND_C_NAME**: Sign action for pended order.
- **STAT_COMP_USER_ID**: The ID of the user who marked an inpatient procedure as 'Complete'
- **STAT_COMP_USER_ID_NAME**: The name of the user record. This name may be hidden.
- **STAT_COMP_DTTM**: The time and date that an inpatient procedure was marked as 'Complete'
- **IS_EXT_READ_YN**: This item indicates whether this order is for an external read of an imaging study. A null value should be assumed to be No.
- **PENDDC_STATUS_C_NAME**: Status of an order if the order is pending discontinue.
- **AUTOINTK_COMPL_YN**: This item contains whether an auto-intake has been completed for the order.
- **RESULT_LOCATION_C_NAME**: This item indicates which order item the result is stored.
- **STAND_EOW_ID**: Holds the ID number of the Standing Status In Basket message associated with this Order.  The In Basket message informs the user that a standing order exists.
- **INPAT_DISC_INTER_ID**: This item stores the interval at which a standing order should be released for inpatient orders.
- **INPAT_DISC_INTER_ID_FREQ_NAME**: The name of the frequency record.
- **INPAT_AUTO_RLSE_YN**: This item indicates whether child instances of a standing order should be automatically released for inpatient orders.
- **LAB_CRT_CNCT_CSN_ID**: The unique contact serial number for the contact that was created from this order. This number is unique across all patient encounters in your system. If you use IntraConnect, this is the Unique Contact Identifier (UCI).
- **LAST_OVERALL_ASMT_C_NAME**: The most recent overall mammography assessment for the order. This should be the same as the most recent value for ORDER_RAD_ASMT.ASSESSMENT_C. This column is used to link to the ZC_ASSESSMENT table.
- **REVENUE_CODE_ID**: The revenue code associated with the service.
- **REVENUE_CODE_ID_REVENUE_CODE_NAME**: The name of the revenue code.
- **UNITS_REQUESTED**: The number of units requested for the service.
- **UNITS_APPROVED**: The number of units approved for the service.
- **TOTAL_PRICE**: The total price of the service.
- **PATIENT_PORTION**: The amount or portion the patient will have to pay for the service they are being referred for.
- **AUTH_REQUIRED**: This column stores whether or not authorization is required for the service.
- **NET_PAYABLE**: The net payable of the service.
- **NOT_COVERED**: This item indicates whether or not the service is covered.
- **PROVIDING_PROV_ID**: The provider on the service.
- **COMMENT_WITH_CANCEL**: Comment entered while cancelling an order.
- **SOFT_DEL_FLAG**: Soft deletion flag for order records associated with order-based transcriptions, which were deleted by the transcription soft-deletion utility.
- **RESULT_TRACK_STS_C_NAME**: This stores whether follow-up with recipients is required, in progress, or completed. This status is the per-order, see RESULT_TRACK_RECIP for individual recipient result tracking statuses.
- **ORD_PHASE_OF_CARE_C_NAME**: This item will store the phase of care for which this order was created. Example: Pre-Op, Intra-Op, PACU.
- **REQUESTED_DATETIME**: The requested date and time. The items extracted to this column are populated by the Cadence Orders Interface.
- **ORX_ID**: Contains an ID from Order Lookup Index. This may be populated if an order originates from an Order Panel.
- **ORX_ID_ORDER_LOOKUP_NAME**: The name (.2 item) for the order panel record.
- **RELEASED_INSTA_DTTM**: Stores the scheduled instant of the child order.
- **LAST_SCHE_INST_DTTM**: This item stores the inpatient order's last scheduled instant.
- **INTERACT_COMMENT**: Interaction override comment.
- **COPY_POINTER_ID**: This object tracks order record links created when using the inpatient or ambulatory order mover utilities to move an order record. This item is populated on the source order record and points to the target order record(s) created.
- **AFTER_ORDER_ID**: This column contains the After Order ID for an order after Order Transmittal.
- **BEFORE_ORDER_ID**: This column contains the Before Order ID for an order before Order Transmittal.
- **DIET_COMMENTS**: This column contains the Diet Comments entered for an order.
- **ORD_CONDITION_FLAG**: This column contains the a Condition Flag if this is an order created from certain condition.
- **COR_AFTR_FINAL_DTTM**: The date and time when the study was corrected and finalized.
- **IS_HELD_ORDER_C_NAME**: This item stores 1 if the order is signed and held and active
- **NOCHRG_EXT_RSLT_YN**: This column returns whether the order is an external result that should not drop charges. A value of 1 returns Y. A value of 0 returns N. A null value will return null but is treated the same as 0 when dropping charges.
- **PROTOCOL_STATUS_C_NAME**: Contains the current status of the order's protocols. Will be used to determine how to populate the protocol work list.
- **PROTCL_ASGN_POOL_ID**: If an order's protocol has been assigned to a pool, this item contains the pool ID of the assigned pool.
- **PROTCL_ASGN_POOL_ID_POOL_NAME**: The name of the scheduling pool used when searching for available providers for an appointment.
- **PROTCL_ASGN_PROV_ID**: If an order's protocol has been assigned to a provider, this item contains the provider ID of the assigned provider.

### ORDER_PROC_4
**Table**: The ORDER_PROC_4 table enables you to report on the procedures ordered in the clinical system. This procedure table has the same basic structure as ORDER_PROC, but was created as a fourth table to prevent ORDER_PROC_3 from getting any larger.
- **ORDER_ID**: The unique ID of the order record for this row.
- **LAST_MAMMO_ORD_ID**: The last breast procedure that was performed on this patient prior to this order.
- **LAST_MAMMO_LOC_ID**: Where the last breast procedure was performed. If it was performed by the current organization, this field will be empty
- **LAST_MAMMO_PROC_NAM**: The last breast procedure that was performed. This field allows you to freely specify a procedure name in case it was performed outside the organization.
- **LAST_MAMMO_DATE**: The date when the last breast procedure was performed.
- **LAST_MAMMO_WEIGHT**: The patient's weight (oz.) at the last breast procedure.
- **EXAM_MAMMO_WEIGHT**: The patient's weight (oz.) at the time of this procedure.
- **LAST_MAM_WT_RECD_DT**: The date when the weight at last breast procedure was recorded.
- **EXAM_MAM_WT_RECD_DT**: The date when patient's current weight was recorded.
- **MAM_HX_REVD_USER_ID**: The last person to review the last breast procedure information.
- **MAM_HX_REVD_USER_ID_NAME**: The name of the user record. This name may be hidden.
- **MAMMO_BASELINE_YN**: Whether or not this is the patient's first breast procedure.
- **LAST_MAMMO_EXT_YN**: Whether the last breast procedure was done externally.
- **MAMMO_WEIGHT_CHANGE**: The patient's weight change (oz.).
- **MAM_WT_CHNG_RECD_DT**: The date the patient's weight change was recorded.
- **MAM_HORMONE_NONE_YN**: Whether the patient has no mammography-relevant hormone history, documented by the tech in the visit navigator.
- **MAMMO_HX_REVD_DTTM**: The instant the last breast procedure information was reviewed.
- **MAM_HORMNE_REV_U_ID**: The last user to review the hormone history.
- **MAM_HORMNE_REV_U_ID_NAME**: The name of the user record. This name may be hidden.
- **MAM_HORMNE_REV_DTTM**: The instant the hormone history was last reviewed.
- **BREAST_SELF_EXAM_C_NAME**: The category ID that indicates whether or not a patient performs breast self-exams, which map to Yes, No, or N/A.
- **RIS_LTR_NOT_NEED_YN**: Indicates whether a study is marked as not needing a mammography result letter. 'Y' indicates a study has been marked as not needing a result letter.
- **REQ_PER_PERIOD**: Requested units/visits per period.  This along with the Requested periods (REQ_PERIODS) determines the total 'requested units'.
- **REQ_FREQ_C_NAME**: The category ID for the frequency of visits/units requested for the procedure (e.g. day, week, month, year).
- **REQ_PERIODS**: Requested periods. Requested units per period (REQ_PER_PERIOD) along with the requested periods determines the total 'requested units'.
- **APPR_PER_PERIOD**: Approved units/visits per period. This along with the approved periods (APPR_PERIODS) determines the total 'approved units'.
- **APPR_FREQ_C_NAME**: The category ID for the frequency of visits/units approved for the procedure (e.g. day, week, month, year).
- **APPR_PERIODS**: Approved periods.  Also known as duration. Approved units per period (APPR_PER_PERIOD) along with the approved periods determines the total 'approved units'.
- **PROC_LNC_ID**: LOINC ID associated with the procedure.
- **ABNORMAL_NOADD_YN**: Indicates whether the most recent result is abnormal. 'Y' indicates that the most recent update of the result was marked abnormal. 'N' indicates that the abnormal flag is not set, or marked as normal. This is set to 'N' when a result is in progress, and will be updated as result updates are filed.
- **NUM_IMGS_PERFORMED**: The number of images performed by a tech during the imaging exam linked to this order. This number is a total for the exam and includes images done on other procedures linked to the same appointment.
- **IPROC_STATUS_C_NAME**: The imaging and procedure status category ID of an order.
- **SPEC_DRAW_TYPE_C_NAME**: The specimen draw type category ID for the order.
- **ANTICOAG_INR_GOAL_C_NAME**: The International Normalized Ratio (INR) goal category ID for a patient on anticoagulation therapy.
- **ANTICOAG_RESP_POOL_ID**: Pool of providers responsible for a patient on anticoagulation therapy.
- **ANTICOAG_RESP_POOL_ID_REGISTRY_NAME**: The name of the In Basket registry in the HIP master file.
- **ANTICOAG_NEXT_INR_DT**: The date of the next International Normalized Ratio (INR) check for a patient on anticoagulation therapy.
- **ANTICOAG_WEEKLY_MAX_DOSE**: Weekly maximum dose of anticoagulant for a patient on anticoagulation therapy.
- **ANTICOAG_TARGET_END_DT**: Targeted end date for the patient's anticoagulation therapy.
- **ANTICOAG_INDEFINITE_YN**: Indicates whether a patient is indefinitely on anticoagulation. 'Y' indicates anticoagulation is indefinite (no end date set for anticoagulation).
- **IPROC_STATUS_INST_DTTM**: The instant of the last Imaging and Procedure (IProc) status update of an order.
- **SCREENING_FORM_ID**: The unique ID of the screening form linked to the order.
- **SUBMITTER_ID**: The unique ID of the external site (submitter) associated with the order. The submitter will typically be copied on results, and could also be billed (depending on configuration).
- **SUBMITTER_ID_RECORD_NAME**: The name of the submitter record.
- **INDICATION_COMMENTS**: The comment entered for the indications of use for this order.
- **COLL_END_DT**: This is the end date for an observation. This typically equates to the end date of a specimen collection or the end date of a procedure.
- **COLL_END_TM**: This is the end time for an observation. This typically equates to the end time of a specimen collection or the end time of a procedure.
- **COLL_AMT**: The amount of specimen that was collected. The identifier for the units for this amount are in COLL_AMT_UNIT_ID.
- **COLL_AMT_UNIT_ID**: The unique identifier for unit of the specimen collection amount (COLL_AMT) for this order.
- **COLL_AMT_UNIT_ID_UNIT_NAME**: Record name
- **DEST_ANCILLARY_C_NAME**: The ancillary category ID for the destination ancillary that is responsible for this order.
- **REF_TO_PROV_ADDR_ID**: Address selected for the referred-to provider. Format: {External provider ID}-{Address Line #}
- **REFLEX_SOURCE_C_NAME**: The reflex source category ID for the order.
- **BREAST_IMG_TYPE_C_NAME**: The imaging type category ID used to indicate whether standard imaging only, or standard plus additional imaging, was performed. Category values used for the NMD 3.0 extract.
- **SCHED_DUR**: The amount of time (in minutes) the order will contribute to an appointment
- **SCHED_DUR_IS_CALC_YN**: Indicates whether the scheduling duration was calculated by the system. 'Y' indicates it was calculated by the system. 'N' or NULL indicate it was not.
- **SCHED_DUR_BUFFER**: The amount of time (in minutes) that should be added to system calculated scheduling duration as a buffer.
- **SCHED_TOL_BEF**: How far before the expected date for the order the appointment can still be safely made.
- **SCHED_TOL_AFTR**: How long after the expected date for the order the appointment can still be safely made.
- **SCHED_TOL_NO_RESTR_BEF_YN**: Indicates if the No restriction checkbox is checked for scheduling tolerance before the expected treatment date for a schedulable procedure. 'Y' indicates there are no restrictions.
- **SCHED_TOL_NO_RESTR_AFTR_YN**: Indicates if the No restriction checkbox is checked for scheduling tolerance after the expected treatment date for a schedulable procedure. 'Y' indicates there are no restrictions.
- **PROTOCOLLED_ORD_ID**: For an order that was placed from an imaging protocol, this item contains the protocolled imaging procedure order from which the order was placed. This item can be used to help associate contrast, medication, and point-of-care lab test orders with the protocolled procedure orders for which they were placed.
- **PROTOCOL_SOURCE_ID**: This item stores a pointer to the last order record that had its protocol edited by a user. When a protocol is edited this item should be populated on the order record that was edited. When a protocol is copied forward to another order record, this item should be populated on the destination order.
- **FINAL_APPROVAL_YN**: Whether final approval has been received for a procedure. If Yes, more approval does not need to be obtained. This item is used primarily for reporting purposes.

### ORDER_PROC_5
**Table**: The ORDER_PROC_5 table enables you to report on the procedures ordered in the clinical system. This procedure table has the same basic structure as ORDER_PROC, but was created as a fifth table to prevent ORDER_PROC_4 from getting any larger.
- **ORDER_ID**: The unique identifier for the order record.
- **FUTURE_RELATIVE_EXPECTED_DT_C_NAME**: Holds a category value for the expected completion date. This may be subtly different from the expected date (ORDER_PROC.FUT_EXPECT_COMP_DT) for things like "in 3 months", which could be Start Date+90 days (S+90), Start date+91 days (S+91), or Start date + 92 days (S+92) depending on the current date.
- **FUTURE_EXPECTED_DATE_COMMENT_C_NAME**: Holds a category value for the comment part of expected date. This will include categories based on scheduling comments like "Before Surgery", "After Consult", etc.
- **FUTURE_EXPECTED_DATE_DETAILS**: This item holds the free-text details entered if the future expected date comment (FUTURE_EXPECTED_DATE_COMMENT_C) is "Other (Specify)".
- **MODIFY_TRACK_C_NAME**: Flag used to denote if the order was modified or reordered.
- **INCOMPLETE_CHILD_ORDERS**: Store the number of child orders which have not yet reached completed/canceled status. meaning they are either not yet released or are currently active.
- **ORDER_INST_UTC_DTTM**: The instant when the order was created in UTC.
- **MINUTES_BTWN_SCHED_AND_COLL**: The number of minutes between the scheduled and collected instants for a lab. Negative values indicate early collection.
- **APPT_WINDOW_START_TIME**: This is the start of the appointment window for the preferred appointment window.
- **OVERREAD_SRC_ORD_ID**: Stores the order record ID that is marked for imaging overread.
- **APPT_WINDOW_END_TIME**: This is the end of the appointment window for the preferred appointment window.
- **PROC_ESTIMATE_ID**: A link to a patient estimate record that contains patient cost estimate information for procedure orders.
- **SHOULD_GENERATE_PAT_EST_YN**: A flag used for pended orders that indicates that the order should generate a patient estimate record when it is fully signed.
- **FINANCIAL_CLEARANCE_STATUS_C_NAME**: Records the financial clearance status of an order
- **FINANCIAL_CLEARANCE_UTC_DTTM**: Records the UTC instant an order was financially cleared
- **FNDAVTR_DOC_INFO_ID**: Stores the Document ID of the image for the findings avatar
- **IMG_PUBLIC_RSLT_DTTM**: The instant in local time at which the imaging result was made public, as defined by the order's study status (e.g. physician finalized the exam) as configured by the imaging analyst team (I RDF 192).
- **ORDER_RECEIVED_DTTM**: The date and time the order was received.
- **ACTV_EXCLUDE_FROM_CDS_REASON_C_NAME**: The Exclude From Decision Support reason for the order. It will be either 1 - Unsuccessful Attempt represents an order that was not successfully completed. or 2 - Documented on Wrong Patient represents the order's result information was documented on the incorrect patient.
- **ACTV_EXCLUDE_FROM_CDS_UTC_DTTM**: The instance in UTC when the "Exclude From Decision Support" was updated on the order record.
- **ACTV_EXCLUDE_FROM_CDS_DTTM**: The instance when the "Exclude From Decision Support" was updated on the order record.
- **LEAVE_TYPE_C_NAME**: The type of medical leave being ordered.
- **LEAVE_START_DATE**: Start date of the medical leave.
- **LEAVE_END_DATE**: End date of the medical leave.
- **LEAVE_DURATION**: Duration of the medical leave in days.
- **LEAVE_LIGHTDUTY_YN**: Whether the medical leave also has a light duty period.
- **LEAVE_LIGHTDUTY_START_DATE**: Start date of the light duty period.
- **LEAVE_LIGHTDUTY_END_DATE**: End date of the light duty period.
- **LEAVE_LIGHTDUTY_DURATION**: Duration of the light duty period in days.
- **LEAVE_EXCUSED_ACTIVITIES_YN**: Whether the patient should be excused from doing specific activities during the leave.
- **LEAVE_EXCUSED_START_DATE**: Start date of the excused activities period.
- **LEAVE_EXCUSED_END_DATE**: End date of the excuse period.
- **LEAVE_EXCUSED_DURATION**: Duration of the excuse period in days.
- **LEAVE_EXCUSED_COMMENTS**: Comments about the excused activities for the excuse period.
- **DELIVERY_REQUEST_ORDER_ID**: The order ID of the blood component order this order record is requesting a delivery from.
- **DELIVERY_REQUEST_AMOUNT**: The number of units being requested from the blood component order record.
- **ORIGINATING_ORD_ID**: This column contains the originating order ID. It is related conceptually to ORDER_PROC_2.ORIGINAL_ORDER_ID, but rather than pointing back to the previous order ID at the same level in the order tree hierarchy, this column will point back to the initial order created by the ordering end user. Use this column to find out information about the initial order, or to determine if an order went through a change procedure workflow which generated new order records.
- **PROC_CHANGED_YN**: This column determines whether the orderable procedure was changed as part of a change procedure workflow that generated new order records. The column will be set to 1 - Yes if a new procedure was selected during the change procedure workflow step. If the procedure was kept and other details were changed, this column will be populated with 0 - No. If the order did not go through a change procedure workflow which generated new order records, this column will be null.
- **ACTIVE_PROC_TYPE_C_NAME**: This item holds the category type of the active procedure order. Only active procedure type orders will be contained in this item. Medications are excluded. The categories separate order type in parent/child/normal and IP/OP order type.
- **DELIVERY_REQUEST_UNIT_C_NAME**: The unit category of the blood component order record being requested.
- **BILL_AREA_ID**: The bill area this order is associated with.
- **BILL_AREA_ID_BILL_AREA_NAME**: The record name of this bill area, financial subdivision, or financial division.
- **ADT_ORDER_TYPE_C_NAME**: The ADT (admission, discharge, transfer) order type category ID for the order, indicating what type of patient movement this order is intended for.
- **BI_PRELIM_OUTCOME_C_NAME**: Stores preliminary FP/FN/TP/FN/etc info for a breast imaging study. May not contain the most current data until the MQSA report has been run.
- **RAD_EXAM_END_UTC_DTTM**: The date and time an order's exam is ended in the Universal Time Coordinated (UTC) format.
- **LUNG_CANCER_HX_YN**: Returns whether the patient had a history of lung cancer at the time of the order.
- **PAT_AGE_AT_EXAM**: The age of the patient (in years) as of the date of the exam. If the exam has ended, this will be the age as of end exam. If not, this will be the age as of the scheduled appointment date. If an appointment has not been scheduled for this exam, this value will be null.
- **PRIORITIZED_UTC_DTTM**: Stores the prioritized instant for the result in UTC
- **RESULT_UPDATE_UTC_DTTM**: Stores the last update instant for a result in UTC
- **PROC_SVC_TYPE_CODE_C_NAME**: This item contains a procedure service type (surgery, imaging, dental, etc.) that overrides the service type from a referral or coverage source.
- **PERFORMED_IN_ISO_YN**: Stores whether the imaging exam was performed in isolation.
- **RFL_FIRST_APPOINTMENT_BY_DATE**: The date that the first appointment for the referral should occur by.
- **RFL_LIVING_SITUATION_C_NAME**: Describes who the patient or child lives with for this psychology referral order.
- **RFL_CHILD_SERVICE_C_NAME**: Indicates the child welfare service role in connection with child psychology services for the psychology referral order.
- **RFL_PARENTAL_RESP_C_NAME**: Indicates which entity has parental responsibility for the patient for the psychology referral order.
- **RFL_CONSENT_TO_TREAT_STAT_C_NAME**: Indicates the status of obtaining the patient's consent in connection with the referral's transfer of medical record information for the psychology referral order.
- **RFL_CASE_WORKER_NAME**: The case manager of the child psychology case for this psychology referral order.
- **LUNG_OUTCOME_C_NAME**: The positive/negative outcome for a lung imaging study.
- **MAM_INDICATION_C_NAME**: Indication for mammography exam specific to NMD version 2. Category values that can be mapped to BI-RADS indication for exam.
- **HAS_LAB_SPEC_YN**: Indicates whether the order or any of the linked performable orders have a lab specimen. 'Y' indicates that the order or one of the linked performable orders has a lab specimen. 'N' indicates that the order does not have a linked lab specimen and no linked performable order has a lab specimen.
- **HAS_RSLT_CNCT_YN**: Indicates whether the order has a resulted contact.  'Y' indicates that the order has at least one contact of type 2-Resulted.  'N' indicates that the order does not have any contacts of type 2-Resulted.
- **HAS_CORR_YN**: Indicates whether the order has a correction. 'Y' indicates that the order has at least one contact with procedure result status equal to 4-Edited or 5-Edited Result - FINAL.  'N' indicates that the order does not have any contacts with procedure result status equal to 4-Edited or 5-Edited Result - FINAL.
- **LAB_REDRAW_REASON_C_NAME**: The last redraw reason category ID for the order.
- **PANEL_RELEASE_DTTM**: If this order is a performable order on a test panel, this item stores the local date and time when the associated orderable was released. This column will only be populated for performable orders on test panels. It will not be populated for the orderable order on test panels.
- **PANEL_RELEASE_UTC_DTTM**: If this order is a performable order on a test panel, this item contains the UTC date and time when the associated orderable was released. This column will only be populated for performable orders on test panels. It will not be populated for the orderable order on test panels.
- **LAST_RSLT_LAB_ID**: The unique ID of the resulting lab from the last contact where the procedure result status is not null.
- **LAST_RSLT_LAB_ID_LLB_NAME**: Interface laboratory name.
- **MAM_TECH_IMG_DOC_REV_DTTM**: Stores the instant when the last technologist image documentation was reviewed.
- **MAM_TECH_IMG_DOC_REV_USER_ID**: Stores the user ID of the last person to review the technologist imaging documentation.
- **MAM_TECH_IMG_DOC_REV_USER_ID_NAME**: The name of the user record. This name may be hidden.
- **NMD_3_MAM_INDICATION_C_NAME**: Indication for mammography exam specific to NMD version 3. Category values that can be mapped to BI-RADS indication for exam. .

### ORDER_PROC_6
**Table**: The ORDER_PROC_6 table enables you to report on the procedures ordered in the clinical system. This procedure table has the same basic structure as ORDER_PROC, but was created as a sixth table to prevent ORDER_PROC_5 from getting any larger.
- **ORDER_ID**: The unique identifier for the order record.
- **FIRST_CHART_USER_ID**: The unique ID of the user who first made results available on the chart.
- **FIRST_CHART_USER_ID_NAME**: The name of the user record. This name may be hidden.
- **FIRST_CHART_UTC_DTTM**: The date and time results were first made available on the chart.
- **LAST_CHART_USER_ID**: The unique ID of the user who last made results available on the chart.
- **LAST_CHART_USER_ID_NAME**: The name of the user record. This name may be hidden.
- **LAST_CHART_UTC_DTTM**: The date and time results were last made available on the chart.
- **FIRST_FINAL_USER_ID**: The unique ID of the user who first made final results available on the chart.
- **FIRST_FINAL_USER_ID_NAME**: The name of the user record. This name may be hidden.
- **FIRST_FINAL_UTC_DTTM**: The date and time final results were first made available on the chart.
- **LAST_FINAL_USER_ID**: The unique ID of the user who last made final results available on the chart.
- **LAST_FINAL_USER_ID_NAME**: The name of the user record. This name may be hidden.
- **LAST_FINAL_UTC_DTTM**: The date and time final results were last made available on the chart.
- **FIRST_CORR_USER_ID**: The unique ID of the user who first authorized a correction to the result on this order.
- **FIRST_CORR_USER_ID_NAME**: The name of the user record. This name may be hidden.
- **FIRST_CORR_UTC_DTTM**: The date and time the results of this order were first corrected.
- **LAST_CORR_USER_ID**: The unique ID of the user who last authorized a correction to the results of this order.
- **LAST_CORR_USER_ID_NAME**: The name of the user record. This name may be hidden.
- **LAST_CORR_UTC_DTTM**: The date and time the results of this order were last corrected.
- **IMG_EXAM_PAT_WT**: Most recent patient weight (grams) preceding the end exam instant, within the system's age-based weight lookback range. Exams missing an end exam instant, as well as exams taking place too long after the last recorded patient weight, will not populate this item.
- **IMG_EXAM_PAT_HT**: Most recent patient height (centimeters) preceding the end exam instant, within the system's age-based height lookback range. Exams missing an end exam instant, as well as exams taking place too long after the last recorded patient height, will not populate this item.
- **IMG_EXAM_PAT_BMI**: Most recent patient BMI preceding the end exam instant, within the system's�age-based height and weight lookback ranges. Exams missing an end exam instant, as well as exams taking place too long after the last recorded patient height or weight, will not populate this item.
- **FOLLICLE_STDY_MIN_THRSHLD_NUM**: The minimum threshold from I LSD 53002 at the time of the study. This value is stored in millimeters.
- **UNIQUE_IDENT**: The unique ID generated by the organization that originally created this order.
- **ACCT_SERIAL_NUM**: The account serial number associated with the order.
- **RSLT_TRANSMTL_DTTM**: The date and time the order was placed on the result transmittal queue.
- **RSLT_TRANSMTL_ENTRY_IDENT**: The unique ID used for the result transmittal queue entry associated with the order.
- **ADD_ON_SPECIMEN_ID**: The unique ID of the specimen that the order was added onto.
- **NO_PAT_CLASS_REASON_C_NAME**: This holds a reason that the patient class was stripped from the order. If this value is blank, it can mean either that the procedure didn't have a patient class or that the reason the patient class was stripped isn't a reason that's audited.
- **PRIORITIZED_INST_DTTM**: This item stores the prioritized instant (date and time) for an order in local time zone. It represents the most relevant date and time an action was taken on an order.
- **INTENDED_SMOKE_QUIT_DATE**: The date a patient plans to quit smoking. This value is populated by filing an order-specific question.
- **PRIORITIZED_INST_UTC_DTTM**: This item stores the prioritized instant (date and time) for an order in UTC time zone. It represents the most relevant date and time an action was taken on an order.
- **RSLT_UPD_UTC_DTTM**: Stores the last update instant for a result in UTC
- **RECEIVED_EXT_AUTH_PROV**: This item holds the free-text for the received authorizing provider's name. It is free text and not linked to a provider record because we do not want to generate provider records for all received external result orders.
- **DICOM_LAST_UPD_DTTM**: The instant of the last time the UIDs were updated.
- **STUDY_LAST_OPENED_DTTM**: The column contains the time the study was last opened in edit mode.
- **PATH_NARRATIVE_NOTE_ID**: This column contains the pathology result narrative ID and only supports historical data.
- **IMG_CHGEAP_LOADED_YN**: Indicates whether default chargeable Associated Procedures have been added to the Imaging Charge Capture Navigator. 'Y' indicates that default chargeable Associated Procedures have been added, 'N' or NULL indicate they have not.
- **DEF_BNDL_CODE_YN**: Indicates historical data about whether the default bundle codes are used for charges. 'Y' indicates that default bundle codes were used for charges, 'N' or NULL indicate that default bundle codes were not used.
- **REF_PRV_ROUT_MTHD_C_NAME**: The 'Encounter Communication Sent - Method' category ID for the routing method that will be used for automated results routing. The method is determined when placing an order in Ancillary Order Entry.
- **BATCH_PRINTED_UTC_DTTM**: This column holds the instant the results report was printed through batch printing routine RISBSREP or through results routing.
- **STUDY_READ_DATE**: Stores the last time an imaging order had a status change of "SAVED" or higher.
- **IMG_ADDEND_IN_EPIC_DATE**: This column stores when the addendum is updated in Epic (addendum sign date if using an Epic workflow, otherwise whenever received over the interface)
- **IMG_LAST_UPDATE_IN_EPIC_DATE**: This column stores when the result is updated in Epic (sign date if using an Epic workflow, otherwise whenever received over the interface)
- **REI_FOLLICLE_ROUNDING_C_NAME**: The measurement rounding method for ovarian follicle averages. This indicates whether follicle measurement averages are rounded to the nearest whole-millimeter or half-millimeter. This is only set for studies that contain ovarian follicle measurements. Also only used for averages, not follicle diameters which always round to the nearest tenth.
- **MYC_BATCH_RELEASE_DTTM**: Server time instant after which a result will be released to MyChart by the batch job
- **ORDER_DOMAIN_C_NAME**: Used to semantically group types of procedure orders
- **PERFORM_BY_DATE**: Unbuffered perform-by date used in automatic order cancellation batch job.
- **SEQ_DOC_LAST_UPD_UTC_DTTM**: The instant when the linked sequencing documents were last updated, represented in UTC.
- **SEQ_DOC_LAST_UPD_DTTM**: The instant when the linked sequencing documents were last updated, represented in the local time of the system that made the change.
- **DISCON_LOC_DTTM**: The instant the order was discontinued or canceled in the local timezone.
- **FIRST_FINAL_LOC_DTTM**: The instant final results were first made available on the chart. This is the result contact instant (ORD-1970) from the first contact where the procedure result status (ORD-115) is 3-Final result.
- **SND_ORG_PAT_MRN**: This item stores the patient's MRN ID from the organization that sent this order.
- **REFD_TO_PROV_CARE_TEAM_ID**: This item tracks the IP provider team associated with a consult/referral order.
- **REFD_TO_PROV_CARE_TEAM_ID_RECORD_NAME**: The name of the record.
- **ORD_GRP_RULE_ID**: The unique identifier (.1 item) for the rule that identifies this order group
- **ORD_GRP_RULE_ID_RULE_NAME**: The name of the rule.
- **ORD_GRP_SESS_UTC_DTTM**: The date and time that identifies this order group, in UTC.
- **RFL_PRIM_CONDITION_GROUPER_ID**: Primary condition for which the patient is being referred as a Search Condition MAG record.
- **RFL_PRIM_TREATMENT_GROUPER_ID**: Primary treatment for which the patient is being referred as a Search Treatment MAG record.
- **RFL_PRIM_SPECIALTY_GROUPER_ID**: Primary specialty to which the patient is being referred as a Search Specialty MAG record.
- **RFL_PRIM_SUBSPEC_GROUPER_ID**: Primary subspecialty to which the patient is being referred as a Search Subspecialty MAG record.
- **INFUSION_DURATION_AT_SCHED**: This item stores the calculated infusion duration in minutes for infusion visit orders at the time of scheduling.
- **UPD_ASMT_RECOM_TIME**: Stores the total number of seconds spent by clinicians updating discrete data in the Update Assessment/Recommendations activity.
- **NO_RFL_PROV_TEAM_YN**: This item stores whether the "No Group" checkbox to allow placing a referral without an associated provider team has been checked.
- **NLP_AFM_LINK_OUTCOME_C_NAME**: The outcome of links between AFM findings and AFM recommendations created using NLP. This is only calculated when both the AFM Findings Model and the AFM Recommendations Model reach a verified status and is blank otherwise. This can be used to measure the accuracy of NLP links.

### ORDER_RAD_ACC_NUM
**Table**: This stores the accession numbers associated with the order.
- **ORDER_PROC_ID**: The unique ID of the procedure order record.
- **LINE**: The line count for this table as determined by the number of accession numbers associated with an order.
- **ACC_NUM**: The accession number associated with an order.
- **SPECIMEN_APP_IDN**: The specimen application ID number associated with an order.

### ORDER_RAD_READING
**Table**: This table stores reading physician information for imaging procedures.
- **ORDER_PROC_ID**: The unique ID of the procedure order record.
- **LINE**: The line count for this table as determined by the number of reading radiologists for an order.
- **PROV_ID**: The reading radiologist for the order.
- **READING_DT**: The date that the study was read by the reading radiologist (PROV_ID) -- i.e., the date that the radiologist performed any action on the study.
- **READ_PHYS_SPEC_C_NAME**: The reading physician roles category ID for the order.
- **READING_RESIDENT_ID**: The unique ID of the resident being supervised by the reading radiologist, if one exists.
- **READ_UTC_DTTM**: The date and time in UTC format when the reading physician made a change to the study.

### ORDER_READ_ACK
**Table**: This table is used to store information from the overtime-related Orders items used for the result read/acknowledgment tracking feature. Namely, this is the Read or Acknowledge by User (I ORD 1910) and Read or Acknowledged On (I ORD 1915) items.
- **ORDER_ID**: The unique identifier for the order record.
- **CONTACT_DATE_REAL**: A unique contact date in decimal format. The integer portion of the number indicates the date of contact. The digits after the decimal distinguish different contacts on the same date and are unique for each contact on that date. For example, .00 is the first/only contact, .01 is the second contact, etc.
- **LINE**: The line number for when and who viewed the results associated with this contact. Multiple pieces of information can be associated with this contact.
- **CONTACT_DATE**: The date of this contact in calendar format.
- **READ_ACK_ACTUAL_UTC_DTTM**: This item stores when the result was actually viewed by an end user.
- **WHO_READ_ACK_EMP_ID**: This item stores which user viewed this result.
- **WHO_READ_ACK_EMP_ID_NAME**: The name of the user record. This name may be hidden.

### ORDER_RESULTS
**Table**: This table contains information on results from clinical system orders. This table extracts only the last Orders (ORD) contact for each ORD record.
- **ORDER_PROC_ID**: The unique ID of the procedure order record.
- **LINE**: The line number of each result component within each ordered procedure.
- **ORD_DATE_REAL**: This is a numeric representation of the date each order was placed in your system. The integer portion of the number specifies the date the order was placed. The digits after the decimal point indicate multiple orders on one day.
- **ORD_END_DATE_REAL**: This is a numeric representation of the end date for each order in your system. The integer portion of the number specifies the date the order was placed. The digits after the decimal point indicate multiple orders on one day.
- **RESULT_DATE**: The date the technician ran the tests for each order in calendar format.
- **COMPONENT_ID**: The unique ID of each result component for each result.
- **COMPONENT_ID_NAME**: The name of the component.
- **PAT_ENC_CSN_ID**: A unique serial number for the associated patient encounter. This number is unique across all patients and encounters in the system.
- **ORD_VALUE**: The value returned for each result component, in short free text format. NOTE:  This is how the data is stored in the database; as string format. Interface data may come in with alpha characters and this field is designed to store exactly what is stored in the database. This field stores numeric and structured numeric values in M internal format, using a period as the decimal separator irrespective of locale.
- **ORD_NUM_VALUE**: A numeric representation of the value returned for each component where applicable. If the value contains any non-numeric characters, the value will display as 9999999.
- **RESULT_FLAG_C_NAME**: The category value associated with a standard HL7 flag code to mark each component result as abnormal. Any value in this field not equal to 1 is considered abnormal.
- **REFERENCE_LOW**: The lowest acceptable value for each result component. If the value in this column is a number or structured numeric, the numbers will be stored in M internal format, using a period as the decimal separator.
- **REFERENCE_HIGH**: The highest acceptable value for each result component. If the value in this column is a number or structured numeric, the numbers will be stored in M internal format, using a period as the decimal separator.
- **REFERENCE_UNIT**: The units for each result component value.
- **RESULT_STATUS_C_NAME**: The category value corresponding to the status of each result record, such as 2-Preliminary, 3-Final, 4-Corrected, 5-Incomplete.
- **RESULT_SUB_IDN**: This item is populated with the unique organism identifier (OVR 700 or interface) when the component of an order result is an organism and can be joined to ORDER_SENSITIVITY.SENS_ORGANISM_SID to identify details about this organism.
- **LAB_STATUS_C_NAME**: The category value associated with the status of each result, such as 1-In Progress, 2-Preliminary, 3-Final, 4-Edited.
- **INTERFACE_YN**: This Yes/No flag identifies whether each order was resulted through an interface. The field will display "Y" if the result came through an interface, otherwise the field will display "N".
- **RESULTING_LAB_ID**: The Unique ID of the Lab running the test.
- **RESULTING_LAB_ID_LLB_NAME**: Interface laboratory name.
- **COMPONENT_COMMENT**: Contains the comments associated with a order COMPONENT_ID, i.e. this is the comments associated with a specific order component's results. If comment data is too long to fit in this item, then the comments will be found in the ORDER_RES_COMMENT table.
- **RESULT_IN_RANGE_YN**: A Yes/No category value to indicate whether a result has been verified to be within its reference range.  This item is set by the interface when the result is sent. A null value is equivalent to a "no"  value.
- **REF_NORMAL_VALS**: This is a free-text item which allows you to enter a reference range without tying it to a "low" or "high" value. For example, it could be a string ("negative"), a list of choices ("Yellow, orange"), or a descriptive range ("Less than 20"). The values entered in this range should always represent the "normal" values. This item will be displayed in Results Review as the reference range, superseding any values in the low or high items. It may also be displayed in reports, if the print groups are configured to use it. Multiple responses are permitted (one per line). If the value in this column is a number or structured numeric, the numbers will be stored in M internal format using a period as the decimal separator.
- **LRR_BASED_ORGAN_ID**: Used for storing discrete organisms. This item is used for storing isolated organisms at the component level. There may be cases where an isolated organism does not undergo sensitivity tests and therefore is only stored at the component level. Organisms with sensitivities are also stored in addition to this item.
- **LRR_BASED_ORGAN_ID_NAME**: The name of the organism.
- **COMP_RES_TECHNICIA**: ID of the Resulting Lab Technician.
- **VALUE_NORMALIZED**: Will contain the structured numeric result value in a delimited structured numeric format. Numbers will be in M internal format. The delimited structured numeric value is the user entered structured numeric value converted to a delimited format. Valid structured numeric formats are range, operator followed by number, and number followed by operator the value stored in this item is of the format:    operator1_$c(16)_number1_$c(16)_operator2_$c(16)_number2.
- **NUMERIC_PRECISION**: The number of decimal digits to the right of the decimal point.
- **COMP_OBS_INST_TM**: Timestamp to track per non-micro result component when it was collected/observed.
- **COMP_ANL_INST_TM**: Timestamp to track per non-micro result component when it was analyzed in lab.
- **RESULT_VAL_START_LN**: For multi-line results holds the starting line number of RESULTS_CMT column from ORDER_RES_COMMENT table, where the result values begin.  This column is simply an indicator of the line number(s) where a result is stored.
- **RESULT_VAL_END_LN**: For multi-line results holds the ending line number of RESULTS_CMT column from ORDER_RES_COMMENT table, where the result values begin.  This column is simply an indicator of the line number(s) where a result is stored.
- **RESULT_CMT_START_LN**: For multi-line results holds the starting line number of RESULTS_CMT column from ORDER_RES_COMMENT table, where the result values begin.  This column is simply an indicator of the line number(s) where a result is stored.
- **RESULT_CMT_END_LN**: For multi-line results holds the ending line number of RESULTS_CMT column from ORDER_RES_COMMENT table, where the result values begin.  This column is simply an indicator of the line number(s) where a result is stored.
- **ORD_RAW_VALUE**: Stores the raw value of a numeric result as entered by the user. The value stored here and in column ORD_VALUE will be different in international locales for numeric data if the decimal separator used in that locale is a comma instead of a period. This is because ORD_VALUE will store numeric values in the M internal format.
- **RAW_LOW**: Stores raw value of the minimum value of the result component mentioned in column REFERENCE_LOW. The value stored here and in REFERENCE_LOW will be different in international locales for numeric data if the decimal separator used in that locale is a comma instead of a period. This is because REFERENCE_LOW will store numeric data in M internal format.
- **RAW_HIGH**: Stores raw value of the maximum value of the result component mentioned in column REFERENCE_HIGH. The value stored here and in REFERENCE_HIGH will be different in international locales for numeric data if the decimal separator used in that locale is a comma instead of a period. This is because REFERENCE_HIGH will store numeric data in M internal format.
- **RAW_REF_VALS**: This column stores the raw value of REF_NORMAL_VALS (i.e. the reference normal values of the result component). Since REF_NORMAL_VALS will store numeric data in M internal format, the value stored here and in REF_NORMAL_VALS will be different in international locales if the decimal separator used in that locale is a comma instead of a period.
- **ORGANISM_QUANTITY**: This item is used for storing isolated organisms at the component level. It contains the numeric or qualitative quantity of the organism that was observed.
- **ORGANISM_QUANTITY_UNIT**: This item is used for storing isolated organisms at the component level. It contains the unit associated with the quantity of the organism that was observed.
- **COMPON_LNC_ID**: Logical Observation Identifiers Names and Codes (LOINC) ID of the component.
- **COMPON_LNC_SRC_C_NAME**: Source of the component Logical Observation Identifiers Names and Codes (LOINC) ID.
- **COMP_SNOMED_SRC_C_NAME**: Source of the Systemized Nomenclature of Medicine � Clinical Terms (SNOMED) code (reported vs inferred).
- **REF_UNIT_UOM_ID**: Pointer to the record that represents the component's units of measure.
- **REF_UNIT_UOM_ID_UNIT_NAME**: Record name
- **REF_RANGE_TYPE**: Displays the type of the reference range.
- **ORGANISM_SNOMED_CT**: The Systemized Nomenclature of Medicine � Clinical Terms (SNOMED) code for the component's organism.
- **ORGANISM_QUANTITY_SNOMED_CT**: The Systemized Nomenclature of Medicine � Clinical Terms (SNOMED) code for the component's organism quantity.
- **PERFORMING_ORG_INFO_LINE**: This is used to indicate the performing organization information for the component. This item stores the line number of the ORD related group which is used to save the performing organization information.
- **COMPON_EXCL_CDS_YN**: To cache if the component has a value or comment that matches a value in Excluded result text (I LSD 768).
- **RTF_VAL_START_LINE**: If the component result value is rich text, this column gives the first line of ORD_RTF_VAL_CMT that the value is stored in.
- **RTF_VAL_END_LINE**: If the component result value is rich text, this column gives the last line of ORD_RTF_VAL_CMT that the value is stored in.
- **RTF_CMT_START_LINE**: If the component comment is rich text, this column gives the first line of ORD_RTF_VAL_CMT that the component comment is stored in.
- **RTF_CMT_END_LINE**: If the component comment is rich text, this column gives the last line of ORD_RTF_VAL_CMT that the component comment is stored in.
- **RSLT_ACCR_FLAG_YN**: This item determines the accreditation status of the corresponding component. If set to Y-Yes, the corresponding component is accredited. If set to N-No, the corresponding component is not accredited. If null, no evaluation was performed on the component to determine if it is accredited or not.

### ORDER_RES_COMMENT
**Table**: This table contains result component comments for orders that are populated by the Incoming Results Interface. These result component comments are not populated through Enter/Edit Results. The data in this table is populated only if the result component comments normally stored in the Component Comment (I ORD 2070) field is too long to be stored in that field.
- **ORDER_ID**: The internal order ID for this procedure.
- **CONTACT_DATE_REAL**: This is a numeric representation of the date of this encounter in your system. The integer portion of the number specifies the date of the encounter. The digits after the decimal point indicate multiple visits on one day.
- **LINE**: The line count associated with the result component. This line number will match with the LINE column in the ORDER_RESULTS table. It is probable that this table will not have all the lines from the ORDER_RESULTS table since this table only contains data for the components that do not have data in the Component Comment item in the Order record (ORDER_RESULTS.COMPONENT_COMMENT).
- **CONTACT_DATE**: The date of this contact in calendar format.
- **CM_CT_OWNER_ID**: ID of the deployment owner for this contact. This relates to record sharing and who owns the deployment of the record.
- **RESULTS_CMT**: The result component comments for this order record which are populated by the Incoming Results Interface.  These result comments are not populated by Enter/Edit Results. This column is populated when the result component comments that are normally stored in the Component Comment item in the Order record (ORDER_RESULTS.COMPONENT_COMMENT) are too long to be stored in the Component Comment item in the Order record.
- **COMPONENT_ID**: The unique ID of each result component for each result.  Additional data about result components can be found in the CLARITY_COMPONENT table.
- **COMPONENT_ID_NAME**: The name of the component.
- **LINE_COMMENT**: The line count associated with each line of the result component comments. There can be multiple lines of comments, therefore each line has a line number.

### ORDER_REVIEW
**Table**: This table contains a list of all the users that have reviewed the order and whether that review was accepted or not.
- **ORDER_ID**: The unique identifier for the order record.
- **LINE**: The line count for this table is determined by the number of users who reviewed this order.
- **REVIEW_USER_ID**: The user that reviewed the order.
- **REVIEW_USER_ID_NAME**: The name of the user record. This name may be hidden.
- **REVIEWED_TIME**: The date and time when the order was reviewed.
- **REVIEW_ACCEPTED_YN**: This column contains Y/N to determine if the reviewer accepted the order.

### ORDER_SIGNED_PROC
**Table**: This table contains the users, providers, and messages related to procedure verbal orders and cosign orders.
- **ORDER_PROC_ID**: The unique ID for the procedure order record.
- **LINE**: The line count for the table.
- **SIGNED_TYPE_C_NAME**: Indicates the type of order signing the row represents. Note: Any type can have cosigner data.
- **VERB_COMM_PROV_ID**: The unique provider record ID for the provider communicating the verbal order.
- **VERB_SGNER_USER_ID**: The unique user record ID for the user signing the verbal order.
- **VERB_SGNER_USER_ID_NAME**: The name of the user record. This name may be hidden.
- **VERB_MSGRC_USER_ID**: The unique user record ID for the recipient of the In Basket message for the verbal order.
- **VERB_MSGRC_USER_ID_NAME**: The name of the user record. This name may be hidden.
- **VERB_MSG_ID**: The unique In Basket message record ID of the In Basket message created by the verbal order.
- **VERB_SIGNED_TIME**: The date and time the verbal order was signed.
- **VERBAL_MODE_C_NAME**: The mode associated with the verbal order.
- **ORDER_PROV_ID**: The unique provider record ID for the ordering provider.
- **AUTH_PROV_ID**: The unique provider record ID for the authorizing provider.
- **CSGN_MSGRC_USER_ID**: The unique user record ID for the recipient of the cosigned In Basket message.
- **CSGN_MSGRC_USER_ID_NAME**: The name of the user record. This name may be hidden.
- **CSGN_MSG_ID**: The unique In Basket message record ID of the cosigned In Basket message.
- **CSGN_SIGNED_TIME**: The date and time the order was cosigned.
- **COSIGNER_ID**: The unique user record ID for the order cosigner.
- **COSIGNER_ID_NAME**: The name of the user record. This name may be hidden.
- **IS_HOSPITALIST_YN**: Indicates if the order was by a hospitalist.
- **VERB_ORD_CMT**: Verbal order comment.
- **CSGN_CREATE_DTTM**: When the cosign requirement was created (UTC Time).
- **CSGN_RQRD_C_NAME**: This item stores whether or not an order requires a cosign based on when a new line is added to the verbal order category type (I ORD 34800).
- **SIG_REQ_CRT_USER_ID**: If the order signature requirement was manually created, this item stores the ID of the user who created the requirement.
- **SIG_REQ_CRT_USER_ID_NAME**: The name of the user record. This name may be hidden.
- **SIG_REQ_CRT_SRC_C_NAME**: This column is the creation source for order signature requirements.

### ORDER_STATUS
**Table**: The ORDER_STATUS table contains overtime single response orders information.
- **ORDER_ID**: Unique ID for this order record
- **ORD_DATE_REAL**: This is a numeric representation of the date of this encounter in your system. The integer portion of the number specifies the date of the encounter. The digits after the decimal point indicate multiple visits on one day.
- **CONTACT_DATE**: The date of this contact in calendar format.
- **CONTACT_NUMBER**: The contact number of the orders record.
- **CONTACT_TYPE_C_NAME**: The category value for the contact type, such as "1" for "Ordered" or "2" for "Resulted"
- **ABNORMAL_YN**: This Y/N flag reports Y if a result component in the order is reported as abnormal or N if the order is normal.
- **ORDER_CREATOR_ID**: The unique ID of the person creating the order.
- **ORDER_CREATOR_ID_NAME**: The name of the user record. This name may be hidden.
- **RESULTING_PROV**: The name of the provider signing off on the results.
- **LAB_TECHNICIAN**: The technician responsible for the order tests.
- **RESULTING_LAB_ID**: The unique ID of the lab running the test.
- **RESULTING_LAB_ID_LLB_NAME**: Interface laboratory name.
- **INSTANT_OF_ENTRY**: The instant the record was last entered.
- **INSTANT_OF_EDIT**: The instant the record was last edited.
- **RX_DISPENSE_CODE_C_NAME**: The pharmacy dispense code used for this order.
- **RX_PAR_DOSES**: PRN par level number of doses
- **CSN_FOR_ADD_REFILL**: This item only applies to refill orders. It stores the contact serial numbers of the patient visits where the refill order was modified.
- **SCHEDULED_DATE**: The date a standard ambulatory order is scheduled for.
- **SCHEDULED_TIME**: The time a standard ambulatory order is scheduled for.
- **PROCEDURE_NOTE_ID**: This column contains the unique notes record identifier of the note that resulted the narrative for the order.
- **PROCEDURE_NOTE_DT**: This is the date for the procedure note that resulted the order.
- **ERFLL_REQ_RFL_PRN_C_NAME**: This item stores the time period for refills requested in the erefill.
- **ERFLL_APP_RFL_PRN_C_NAME**: This item stores the time period for refills approved in the erefill.
- **EREFILL_TO_PHM_ID**: Stores the link to the general use notes record containing the action message to the pharmacy.
- **WET_READS_C_NAME**: Indicates whether this contact is created by Wet Reads. Used in ED Wet Reads pop-up form.
- **ROUTING_OUTCOME_C_NAME**: The category value of the outcome of results routing for each resulting contact of order associated with this row.
- **ROUTING_RULE_LEVEL**: The level at which the results routing rule used to determine recipients was specified. The possible levels are: Auth Prov, Auth Prov Primary Dept, Enc Dept, or System
- **ROUTING_SCHEME_LINE**: The line of the results routing scheme that was executed to determine recipients for this result. If no line was executed, the value of the column will be the string "DEFAULT".
- **ROUTING_INST_TM**: The date and time the order was resulted and routed.
- **ROUTING_USER_ID**: The unique ID of the user the result was routed to for this row.
- **ROUTING_USER_ID_NAME**: The name of the user record. This name may be hidden.
- **RIS_LET_TEMPLT_ID**: The unique ID of the SmartText record for a mammography result letter associated with this order.
- **RIS_LET_TEMPLT_ID_SMARTTEXT_NAME**: The name of the SmartText record.
- **ROUTING_CURSTATUS_C_NAME**: This item stores the current routing status for a resulting contact.
- **MAM_LIFETIME_RISK**: Patient's probability of getting breast cancer in a lifetime. Calculated using external formula.
- **LAB_STATUS_C_NAME**: Indicates the lab status value associated with each order contact.
- **OVRL_BREAST_DENS_C_NAME**: Overall breast density. Entered when reading a mammography study.
- **RIGHT_BREAST_DENS_C_NAME**: Right breast density. Entered when reading a mammography study.
- **LEFT_BREAST_DENS_C_NAME**: Left breast density. Entered when reading a mammography study.
- **MOST_SIG_MAM_FIND_C_NAME**: This stores the most significant mammography finding as documented by a radiologist.
- **IMG_DOUBLE_READ_C_NAME**: This tracks if a double read was performed while resulting an imaging study, and if so, what type of double read was it.
- **CAD_USAGE_C_NAME**: This stores whether CAD (Computer Aided Detection) was used while interpreting an imaging study.
- **LAB_PATHOLOGIST_ID**: The unique user ID of the pathologist that has responsibility for the current Anatomic Pathology order.
- **LAB_PATHOLOGIST_ID_NAME**: The name of the user record. This name may be hidden.
- **RSLT_CNCT_INSTANT_DTTM**: The instant in which a result contact is modified/filed to the system. Not to be confused with Result Date/Time, which is when the result was actually generated.
- **RSLT_CNCT_USER_ID**: The user filing the result contact. For interfaces or Beaker Result Filing background job, this might be a generic user.
- **RSLT_CNCT_USER_ID_NAME**: The name of the user record. This name may be hidden.
- **RSLT_CNCT_SOURCE_C_NAME**: Stores which entry point modified the result contact.
- **IPROC_NOTE_ID**: Stores the ID to the general use notes record of the Imaging and Procedures Resulting Note.
- **IPROC_NOTE_CSN**: Stores the contact serial number to the general use notes record of the Imaging and Procedures Resulting Note.
- **RES_INTERPRETER_ID**: The unique ID of the user who is the interpreter of the results for this order.
- **RES_INTERPRETER_ID_NAME**: The name of the user record. This name may be hidden.
- **RESPONS_AP_USER_ID**: The unique ID of the lab user that has responsibility for the current anatomic pathology order.
- **RESPONS_AP_USER_ID_NAME**: The name of the user record. This name may be hidden.
- **OVRL_TISSUE_COMP_C_NAME**: Patient level tissue composition. Entered when reading a breast US.
- **RIGHT_TISSUE_COMP_C_NAME**: Right breast tissue composition. Entered when reading a breast US.
- **LEFT_TISSUE_COMP_C_NAME**: Left breast tissue composition. Entered when reading a breast US.
- **OVRL_FGT_C_NAME**: Patient level amount of fibroglandular tissue. Entered when reading a breast MR.
- **RIGHT_FGT_C_NAME**: Right breast amount of fibroglandular tissue. Entered when reading a breast MR.
- **LEFT_FGT_C_NAME**: Left breast amount of fibroglandular tissue. Entered when reading a breast MR.
- **OVRL_BPE_C_NAME**: Patient level background parenchymal enhancement. Entered when reading a breast MR.
- **RIGHT_BPE_C_NAME**: Right breast background parenchymal enhancement. Entered when reading a breast MR.
- **LEFT_BPE_C_NAME**: Left breast background parenchymal enhancement. Entered when reading a breast MR.
- **SYMMETRIC_BPE_C_NAME**: Symmetric flag for background parenchymal enhancement. Entered when reading a bilateral breast magnetic resonance (MR).
- **LAB_CORR_TYPE_C_NAME**: Stores the type of correction that was made to an anatomic pathology report.
- **RESULT_DTTM**: The date and time the technician ran the tests for each order in calendar format. NOTE: Concatenates the result date (ORD 26) and result time (ORD 28) into a datetime format. If the time value is null, the query will return 12:00 AM for a time.
- **LEFT_OVARY_SMALL_FOLLICLE_CNT**: The number of follicles in the left ovary at or below the minimum threshold as defined in system definitions (I LSD 53002).
- **RIGHT_OVARY_SMALL_FOLLICLE_CNT**: The number of follicles in the right ovary at or below the minimum threshold as defined in system definitions (I LSD 53002).
- **ENDOMETRIAL_STRIPE**: The measurement of the endometrial stripe.
- **OV_CYST_PRESENCE_C_NAME**: Whether ovarian cysts are present in this ultrasound study.
- **UTERINE_FIBROID_PRESENCE_C_NAME**: Whether uterine fibroids are present in this ultrasound study.
- **UTERINE_POLYP_PRESENCE_C_NAME**: Whether uterine polyps are present in this ultrasound study.
- **NARRATIVE_PERF_ORG_INFO**: This item stores the line number of the performing organization related group (ORD 1220) and acts as a pointer to the performing organization information of narrative of the result.
- **IMPRESSION_PERF_ORG_INFO**: This item stores the line number of the preforming organization related group (ORD 1220) and acts as a pointer to the performing organization information of impression of the result.
- **EXT_DISP_FILL_IDENT**: Holds the unique identifier for a given fill used to identify the external dispense
- **SR_VALID_STATUS_C_NAME**: Indicates whether the study has been properly updated and validated for a particular order, and is ready for enhanced validation from outside of Study Review. Validated [1] means that the study is ready for enhanced validation. Not Validated [0] or blank means that it is not ready, usually because the study was modified from outside of Study Review, or has never been opened in Study Review.
- **RESULT_PERF_ORG**: This item stores the line number of related group 1220 and acts as a pointer to the performing organization information of the result.
- **LAB_RESULTING_METHOD**: The main resulting method (either manual or a specific interface) that was used to result the order
- **NLP_RESULT_ACTION_C_NAME**: Flags which result contact was used to send the impression to Nebula for natural language processing. Used to determine if the impression changed since natural language processing ran.
- **ROUTING_MOPS_ORDER_ID**: The ID of the MOPS grouper order this order was routed with.
- **ROUTING_MOPS_ORDER_DAT**: The DAT of the MOPS grouper order this order was routed with.
- **NLP_UNVERIFIED_IB_ONLY_YN**: Flag to restrict sending unverified NLP data to only In Basket.

### ORDER_SUMMARY
**Table**: Contains the summary for an order that has been signed.
- **ORDER_ID**: The unique identifier for the order record.
- **LINE**: Line number of each line in multiple responses in a signed order summary.
- **ORD_SUMMARY**: The summary sentence for the order.

### ORD_CLIN_IND
**Table**: The Clinical Indications (reason for exam) and associated comments.
- **ORDER_ID**: The unique ID of the order record.
- **LINE**: The line count for this table as determined by the number of users who reviewed this order.
- **CLIN_IND_TEXT**: Clinical indications (reason for exam) free text answer to an order-specific question for this order.
- **CLIN_IND_CMT_TEXT**: Clinical indications (reason for exam) free text comment to an order-specific question for this order.

### ORD_INDICATIONS
**Table**: This table stores the indications of use selected for a medication record.
- **ORDER_ID**: The unique ID of the order record.
- **LINE**: The line count of associated changes in Indication(s) of Use for the order record.
- **INDICATIONS_ID**: The indications of use selected for a medication order.
- **INDICATIONS_ID_MEDICAL_COND_NAME**: This contains the name of the medical condition.

### ORD_PRFLST_TRK
**Table**: Tracking info for orders coming from a preference list or order template.  For Beacon, the column ORDER_TEMPLATE_ID is used, which is the unique ID of the order template in the patient's treatment plan used to create the order.
- **ORDER_ID**: The unique identifier for the order record.
- **ORDER_TEMPLATE_ID**: The unique ID of the order template (OTP) in the patient's treatment plan that was used to create the order.
- **ORDER_TMPLTE_OTL_I**: OTL ID (order template)
- **MOD_FROM_OTL_YN**: Flag whether this order is modified from its order template.

### ORD_PROC_INSTR
**Table**: This table contains information about order-specific procedure process instructions clinicians see in Order Composer when they sign the order. This item is essentially a SmartText block, which might contain SmartLinks, that is pulled in from the networked Proces Info (I EAP 10650) item at signing.
- **ORDER_ID**: The unique identifier for the order record.
- **LINE**: The line number for the information associated with this record. Multiple pieces of information can be associated with this record.
- **ORDER_PROC_INSTR**: Process Instructions displayed to end user in the order editing window when signing the order.

### ORD_SECOND_SIGN
**Table**: This table stores the information about second sign for orders.
- **ORDER_ID**: The unique identifier for the order record.
- **SEC_SIGN_STATUS_C_NAME**: This item stores the status of the second sign.
- **SEC_SIGN_FIRS_DTTM**: This column contains the instant at which the first sign occurred.
- **SEC_SIGN_MESSAGE**: This is the message shown to the user.
- **SEC_SIGN_REQUIRE_C_NAME**: This is the second sign requirement that this order was signed with.
- **SEC_SIGN_SIGNER_ID**: The ID of the secondary signing user.
- **SEC_SIGN_SIGNER_ID_NAME**: The name of the user record. This name may be hidden.
- **SEC_SIGN_SEC_DTTM**: This column contains the instant at which the second sign occurred.
- **SEC_SIGN_REJECT_C_NAME**: The reason that this order was rejected.
- **SEC_SIGN_COMMENT**: This stores the comment for the rejection.
- **SEC_SIGN_MESSAG_ID**: The second sign message ID.
- **SEC_SIGN_REJECT_ID**: This is the ID of the rejection message that is sent.
- **SEC_SIGN_INDIV_YN**: Whether individual review was required for this order when second signing the order.

### ORD_SPEC_QUEST
**Table**: This table contains order specific questions and their responses.
- **ORDER_ID**: The unique identifier for the order record.
- **LINE**: The line item for this record determined by the order specific question ID
- **ORD_QUEST_ID**: The identification number of the question for this order.
- **ORD_QUEST_DATE**: The date of the question for this order.
- **IS_ANSWR_BYPROC_YN**: Indicates whether or not this question was answered by the procedure. 'Y' indicates that the question was answered. 'N' indicates that the question was not answered.
- **ORD_QUEST_COMP**: The line number of the medication in the mixture that triggers this specific question for an IV or total parenteral nutrition (TPN) order.
- **ORD_QUEST_RESP**: The response to the question for this order.
- **ORD_QUEST_CMT**: The comments on the question of the order.

### PERFORMING_ORG_INFO
**Table**: Stores the performing organization information.
- **ORDER_ID**: The unique identifier for the order record.
- **LINE**: The line number for the information associated with this record. Multiple pieces of information can be associated with this record.
- **PERFORMING_ORG_NAME**: The name of the performing organization. The phone number might be a part of the organizations name as labs might send it as a part of the name.
- **PERFORMING_ORG_DIRECTOR**: The name of the medical director of the performing organization.
- **PERFORMING_ORG_CITY**: The city where the performing organization is located.
- **PERFORMING_ORG_STATE_C_NAME**: The state where the performing organization is located.
- **PERFORMING_ORG_ZIP_CODE**: The zip code of the performing organization.
- **PERFORMING_ORG_PHONE_NUM**: Phone number of the performing organization.
- **PERFORMING_ORG_CLIA_NUM**: The Clinical Laboratory Improvement Amendment (CLIA) number of the performing organization. Any laboratory that is included in the CLIA legislation must obtain a CLIA certificate from the U.S. Department of Health and Human Services. The certificate will include a 10-digit number which is the CLIA number of that laboratory.
- **PERFORMING_ORG_FORMAT_C_NAME**: This item represents the format in which the performing organization medical director name is stored.
- **PERFORMING_ORG_HOUSE_NUM**: The housing number of the performing organization address.

### RAD_THERAPY_ASSOC_COURSE
**Table**: Lists external radiation courses linked to orders.
- **ORDER_ID**: The unique identifier for the order record.
- **RAD_THERAPY_COURSE_SRC_SYS_C_NAME**: This item is for orders representing treatments from courses of radiation documented in third-party software systems. The source system is specified in this item, and the ID of the course is specified in the counterpart Radiation Therapy Course ID (I ORD 77805).
- **RAD_THERAPY_COURSE_IDENT**: This item is for orders representing treatments from courses of radiation documented in third-party software systems. The ID of the course is specified in this item, and the source system is specified in counterpart Radiation Therapy Course Source System (I ORD 77800).

### SPEC_TYPE_SNOMED
**Table**: This table contains the SNOMED codes for the specimen type.
- **ORDER_ID**: The unique identifier for the order record.
- **LINE**: The line number for the information associated with this record. Multiple pieces of information can be associated with this record.
- **TYPE_SNOMED_CT**: SNOMED code associated w/ the specimen type

## Sample Data (one representative non-null value per column)

### ADT_ORDER_INFORMATION
- ORDER_ID = `439060604`

### CLARITY_EAP
- PROC_ID = `91`
- PROC_NAME = `AMB REFERRAL TO GASTROENTEROLOGY`

### CLARITY_EAP_3
- PROC_ID = `91`
- PT_FRIENDLY_NAME = `Insertion of needle into vein for collection of blood sample`

### CLARITY_EAP_5
- PROC_ID = `91`

### CL_ORD_FST_LST_SCH
- ORDER_ID = `439060604`

### EXTERNAL_ORDER_INFO
- ORDER_ID = `439060604`

### HV_ORDER_PROC
- ORDER_PROC_ID = `439060604`
- PAT_ENC_DATE_REAL = `66745`
- PAT_ENC_CSN_ID = `991225117`
- TRANSPORT_C_NAME = `Wheelchair`
- ORD_PROV_ID = `144590`
- INST_OF_UPDATE_TM = `9/28/2023 10:47:00 AM`

### OBS_MTHD_ID
- ORDER_ID = `439060606`
- CONTACT_DATE_REAL = `64869.01`
- LINE = `1`
- CONTACT_DATE = `8/9/2018 12:00:00 AM`

### ORDER_ANATOMICAL_REGION
- ORDER_ID = `772179259`
- LINE = `1`
- ANATOMICAL_REGION_C_NAME = `Leg`

### ORDER_AUTH_INFO
- ORDER_ID = `439060604`

### ORDER_COMMENT
- ORDER_ID = `763403909`
- LINE = `1`
- ORDERING_COMMENT = `Meriter location is defaulted for this order. Scheduling staff will assist patient in scheduling at `

### ORDER_DOCUMENTS
- ORDER_ID = `439060613`
- CONTACT_DATE_REAL = `65591.01`
- LINE = `1`
- CONTACT_DATE = `7/31/2020 12:00:00 AM`

### ORDER_DX_PROC
- ORDER_PROC_ID = `439060604`
- LINE = `1`
- PAT_ENC_DATE_REAL = `66149`
- PAT_ENC_CSN_ID = `921952141`
- DX_ID = `284018`
- DX_CHRONIC_YN = `N`

### ORDER_IMAGE_AVAIL_INFO
- ORDER_ID = `772179261`
- LINE = `1`
- IMG_AVAIL_YN = `Y`
- IMG_AVAIL_DTTM = `8/29/2022 2:23:05 PM`

### ORDER_IMPRESSION
- ORDER_PROC_ID = `772179259`
- LINE = `1`
- IMPRESSION = `IMPRESSION:`
- ORD_DATE_REAL = `66350`
- CONTACT_DATE = `8/29/2022 12:00:00 AM`

### ORDER_INSTANTIATED
- ORDER_ID = `439060604`
- LINE = `1`
- INSTNTD_ORDER_ID = `945468370`

### ORDER_MYC_INFO
- ORDER_PROC_ID = `439060606`
- RELEASED_YN = `Y`

### ORDER_MYC_RELEASE
- ORDER_PROC_ID = `439060606`
- LINE = `1`
- RELEASE_USER_ID = `DHILLOPS`
- RELEASE_USER_ID_NAME = `DHILLON, PUNEET S`
- RELEASE_ACTION_C_NAME = `Release`
- MYC_REL_UTC_DTTM = `8/2/2020 3:03:32 PM`

### ORDER_NARRATIVE
- ORDER_PROC_ID = `439060613`
- LINE = `1`
- NARRATIVE = `X-RAY ANKLE >= 3 VIEWS LEFT 2/8/2019`
- ORD_DATE_REAL = `65591.01`
- CONTACT_DATE = `8/29/2022 12:00:00 AM`
- IS_ARCHIVED_YN = `N`

### ORDER_PENDING
- ORDER_ID = `439060609`
- LINE = `1`
- USER_ID = `EDISUREI`
- USER_ID_NAME = `EDI, SURESCRIPTS IN`
- PENDED_TIME = `2/19/2023 11:36:00 AM`
- RELEASED_USER_ID = `MBS403`
- RELEASED_USER_ID_NAME = `SMITH, MARY B`
- SH_ORDR_PROV_ID = `219711`
- SH_AUTH_PROV_ID = `144590`

### ORDER_PROC
- ORDER_PROC_ID = `439060604`
- PAT_ID = `Z7004242`
- PAT_ENC_DATE_REAL = `65581`
- PAT_ENC_CSN_ID = `829995922`
- RESULT_LAB_ID = `347`
- RESULT_LAB_ID_LLB_NAME = `UPH MHM MERITER HOSPITAL  RADIANT RAD`
- ORDERING_DATE = `7/21/2020 12:00:00 AM`
- ORDER_TYPE_C_NAME = `Imaging`
- PROC_ID = `33946`
- DESCRIPTION = `MRI BRAIN WO CONTRAST`
- ORDER_CLASS_C_NAME = `Ancillary Performed`
- AUTHRZING_PROV_ID = `219711`
- ABNORMAL_YN = `N`
- BILLING_PROV_ID = `144590`
- ORD_CREATR_USER_ID = `PICONEMA`
- ORD_CREATR_USER_ID_NAME = `PICONE, MARY A`
- LAB_STATUS_C_NAME = `Final result`
- ORDER_STATUS_C_NAME = `Completed`
- QUANTITY = `1`
- REASON_FOR_CANC_C_NAME = `No Longer Indicated`
- FUTURE_OR_STAND = `F`
- STANDING_EXP_DATE = `10/19/2020 12:00:00 AM`
- FUT_EXPECT_COMP_DT = `7/21/2020 12:00:00 AM`
- STAND_ORIG_OCCUR = `1`
- REFERRING_PROV_ID = `144590`
- REFERRING_PROV_ID_REFERRING_PROV_NAM = `RAMMELKAMP, ZOE L`
- REFD_TO_LOC_ID = `36942`
- REQUESTED_SPEC_C_NAME = `Neurology`
- RFL_CLASS_C_NAME = `Internal`
- RFL_TYPE_C_NAME = `MRI/CAT Scan`
- RSN_FOR_RFL_C_NAME = `Specialty Services Required`
- RFL_NUM_VIS = `1`
- RADIOLOGY_STATUS_C_NAME = `Final`
- PROC_BGN_TIME = `2/8/2019 8:00:00 PM`
- ORDER_INST = `7/21/2020 12:38:00 PM`
- DISPLAY_NAME = `MRI Brain wo Contrast`
- HV_HOSPITALIST_YN = `N`
- ORDER_PRIORITY_C_NAME = `Routine`
- INSTANTIATED_TIME = `7/31/2020 9:16:00 AM`
- INSTNTOR_USER_ID = `CCT400`
- INSTNTOR_USER_ID_NAME = `KALSOW, COURTNEY C`
- DEPT_REF_PROV_ID = `101401034`
- SPECIALTY_DEP_C_NAME = `Radiology`
- SPECIMEN_TYPE_C_NAME = `Blood`
- ORDER_TIME = `7/21/2020 12:38:00 PM`
- RESULT_TIME = `9/28/2023 4:09:00 PM`
- IS_PENDING_ORD_YN = `N`
- PROC_START_TIME = `7/21/2020 12:00:00 AM`
- PROBLEM_LIST_ID = `104512005`
- PROC_ENDING_TIME = `9/28/2023 11:59:00 PM`
- SESSION_KEY = `5666243913`

### ORDER_PROC_2
- ORDER_PROC_ID = `439060604`
- STUDY_INSTANCE = `1.2.840.114350.2.92.2.798268.2.355955032.1`
- PAT_LOC_ID = `1700801002`
- ACT_ORDER_C_NAME = `Completed Procedure`
- PAT_ENC_CSN_ID = `829995922`
- ORDER_SOURCE_C_NAME = `OP Visit Taskbar`
- SPECIMN_TAKEN_DATE = `9/28/2023 12:00:00 AM`
- SPECIMN_TAKEN_TIME = `9/28/2023 10:10:00 AM`
- SPECIMEN_COMMENTS = `Specimen type and source: Swab, Nasal (qualifier value)`
- SPECIMEN_RECV_DATE = `9/28/2023 12:00:00 AM`
- SPECIMEN_RECV_TIME = `9/28/2023 10:17:00 AM`
- COLLECTOR_IDN = `BRECHT, SAMANTHA L`
- FUTURE_APPROX_DT_YN = `Y`
- LAST_STAND_PERF_DT = `7/31/2020 12:00:00 AM`
- LAST_STAND_PERF_TM = `7/31/2020 9:16:00 AM`
- EXTERNAL_ORD_ID = `S141309`
- REMARKS_HNO_ID = `1483895113`
- SER_ADDRESSID = `144590-5000002`
- REFG_FACILITY_ID = `1700801`
- REFERRAL_ID = `10358290`
- LAST_RESULT_UPD_TM = `8/14/2020 10:44:00 AM`
- LOGIN_DEP_ID = `1700801002`
- PROTCL_STAT_DT = `7/21/2020 12:00:00 AM`
- PROTCL_STATE_C_NAME = `Scheduled`
- INTERFACE_YN = `Y`
- SOURCE_OF_PRI_INS_C_NAME = `Instant of Instantiation`
- PRIORITIZED_INST_TM = `7/31/2020 9:16:00 AM`
- ORDER_QUESN_LIST = `125988|57721,1055203401|57176,100238|59324,100972|58384,`

### ORDER_PROC_3
- ORDER_ID = `439060604`
- ORDERING_MODE_C_NAME = `Outpatient`
- PROV_STATUS_C_NAME = `Reviewed`
- RESULT_TYPE_C_NAME = `Table`
- RFL_PRIORITY_C_NAME = `Less than 1 month`
- SIGN_ACTION_PEND_C_NAME = `Sign`
- STAND_EOW_ID = `876445812`
- INPAT_AUTO_RLSE_YN = `N`
- UNITS_REQUESTED = `1`
- UNITS_APPROVED = `1`
- ORD_CONDITION_FLAG = `0`
- NOCHRG_EXT_RSLT_YN = `Y`
- PROTOCOL_STATUS_C_NAME = `Protocol Needed`

### ORDER_PROC_4
- ORDER_ID = `439060604`
- PROC_LNC_ID = `28842`
- ABNORMAL_NOADD_YN = `N`
- SCREENING_FORM_ID = `4153852`
- SCHED_TOL_NO_RESTR_BEF_YN = `Y`
- SCHED_TOL_NO_RESTR_AFTR_YN = `Y`

### ORDER_PROC_5
- ORDER_ID = `439060604`
- FUTURE_RELATIVE_EXPECTED_DT_C_NAME = `Today`
- ORDER_INST_UTC_DTTM = `9/28/2023 3:02:03 PM`
- IMG_PUBLIC_RSLT_DTTM = `2/8/2019 8:16:03 PM`
- ACTIVE_PROC_TYPE_C_NAME = `Active OP Normal Order`
- RAD_EXAM_END_UTC_DTTM = `2/9/2019 2:05:25 AM`
- PAT_AGE_AT_EXAM = `39`
- PRIORITIZED_UTC_DTTM = `9/28/2023 3:10:00 PM`
- RESULT_UPDATE_UTC_DTTM = `9/28/2023 3:47:00 PM`
- PERFORMED_IN_ISO_YN = `N`
- HAS_LAB_SPEC_YN = `N`
- HAS_RSLT_CNCT_YN = `N`
- HAS_CORR_YN = `N`
- LAST_RSLT_LAB_ID = `359`
- LAST_RSLT_LAB_ID_LLB_NAME = `UPH MADISON MERITER SUNQUEST LAB`

### ORDER_PROC_6
- ORDER_ID = `439060604`
- FIRST_CHART_USER_ID = `1`
- FIRST_CHART_USER_ID_NAME = `EPIC, USER`
- FIRST_CHART_UTC_DTTM = `3/11/2022 2:12:54 PM`
- LAST_CHART_USER_ID = `1`
- LAST_CHART_USER_ID_NAME = `EPIC, USER`
- LAST_CHART_UTC_DTTM = `8/29/2022 6:23:17 PM`
- FIRST_FINAL_USER_ID = `1`
- FIRST_FINAL_USER_ID_NAME = `EPIC, USER`
- FIRST_FINAL_UTC_DTTM = `3/11/2022 2:12:54 PM`
- LAST_FINAL_USER_ID = `1`
- LAST_FINAL_USER_ID_NAME = `EPIC, USER`
- LAST_FINAL_UTC_DTTM = `8/29/2022 6:23:17 PM`
- PRIORITIZED_INST_DTTM = `2/9/2022 3:26:05 PM`
- PRIORITIZED_INST_UTC_DTTM = `2/9/2022 9:26:05 PM`
- RSLT_UPD_UTC_DTTM = `8/29/2022 6:23:17 PM`
- RECEIVED_EXT_AUTH_PROV = `Joong Eun Shin  MD`
- STUDY_READ_DATE = `3/11/2022 12:00:00 AM`
- IMG_ADDEND_IN_EPIC_DATE = `8/29/2022 12:00:00 AM`
- PERFORM_BY_DATE = `10/13/2023 12:00:00 AM`
- DISCON_LOC_DTTM = `9/28/2023 10:02:20 AM`
- FIRST_FINAL_LOC_DTTM = `3/11/2022 8:12:54 AM`

### ORDER_RAD_ACC_NUM
- ORDER_PROC_ID = `439060606`
- LINE = `1`
- ACC_NUM = `H237948`
- SPECIMEN_APP_IDN = `MSDTRA`

### ORDER_RAD_READING
- ORDER_PROC_ID = `772179259`
- LINE = `1`
- PROV_ID = `8800099`
- READ_UTC_DTTM = `2/9/2019 2:16:03 AM`

### ORDER_READ_ACK
- ORDER_ID = `439060606`
- CONTACT_DATE_REAL = `64869.01`
- LINE = `1`
- CONTACT_DATE = `8/9/2018 12:00:00 AM`
- READ_ACK_ACTUAL_UTC_DTTM = `8/9/2018 5:00:08 PM`
- WHO_READ_ACK_EMP_ID = `DHILLOPS`
- WHO_READ_ACK_EMP_ID_NAME = `DHILLON, PUNEET S`

### ORDER_RESULTS
- ORDER_PROC_ID = `439060606`
- LINE = `1`
- ORD_DATE_REAL = `64869.01`
- ORD_END_DATE_REAL = `66745.01`
- RESULT_DATE = `9/28/2023 12:00:00 AM`
- COMPONENT_ID = `1180011095`
- COMPONENT_ID_NAME = `HEPATITIS C AB`
- PAT_ENC_CSN_ID = `1028743701`
- ORD_VALUE = `NONREACTIVE`
- ORD_NUM_VALUE = `9999999`
- RESULT_FLAG_C_NAME = `(NONE)`
- REFERENCE_LOW = `0`
- REFERENCE_HIGH = `199`
- REFERENCE_UNIT = `mg/dL`
- RESULT_STATUS_C_NAME = `Final`
- RESULT_SUB_IDN = `1`
- LAB_STATUS_C_NAME = `Final result`
- INTERFACE_YN = `Y`
- RESULTING_LAB_ID = `359`
- RESULTING_LAB_ID_LLB_NAME = `UPH MADISON MERITER SUNQUEST LAB`
- COMPONENT_COMMENT = `PATIENT WAS NOT FASTING`
- RESULT_IN_RANGE_YN = `Y`
- REF_NORMAL_VALS = `NR`
- COMP_RES_TECHNICIA = `40000`
- VALUE_NORMALIZED = `>90`
- COMP_OBS_INST_TM = `9/28/2023 10:10:00 AM`
- COMP_ANL_INST_TM = `9/28/2023 4:09:00 PM`
- RESULT_CMT_START_LN = `1`
- RESULT_CMT_END_LN = `1`
- COMPON_LNC_ID = `6827`
- COMPON_LNC_SRC_C_NAME = `Reported`
- COMP_SNOMED_SRC_C_NAME = `Reported`
- PERFORMING_ORG_INFO_LINE = `1`

### ORDER_RES_COMMENT
- ORDER_ID = `439060606`
- CONTACT_DATE_REAL = `64869.01`
- LINE = `4`
- CONTACT_DATE = `9/28/2023 12:00:00 AM`
- RESULTS_CMT = `The eAG (Estimated Average Glucose) in 80% of patients should be within 15% of this calculated value`
- COMPONENT_ID = `1180010806`
- COMPONENT_ID_NAME = `ESTIMATED AVG GLUC`
- LINE_COMMENT = `1`

### ORDER_REVIEW
- ORDER_ID = `439060606`
- LINE = `1`
- REVIEW_USER_ID = `DHILLOPS`
- REVIEW_USER_ID_NAME = `DHILLON, PUNEET S`
- REVIEWED_TIME = `8/27/2018 9:58:00 PM`
- REVIEW_ACCEPTED_YN = `Y`

### ORDER_SIGNED_PROC
- ORDER_PROC_ID = `763403909`
- LINE = `1`
- SIGNED_TYPE_C_NAME = `Ordering`
- VERB_COMM_PROV_ID = `621755`
- VERB_SGNER_USER_ID = `RAMMELZL`
- VERB_SGNER_USER_ID_NAME = `RAMMELKAMP, ZOE L`
- VERB_SIGNED_TIME = `9/28/2023 10:00:00 AM`
- VERBAL_MODE_C_NAME = `Per Protocol - Cosign Required`
- ORDER_PROV_ID = `144590`
- AUTH_PROV_ID = `144590`
- IS_HOSPITALIST_YN = `N`
- CSGN_CREATE_DTTM = `9/28/2023 2:47:00 PM`
- CSGN_RQRD_C_NAME = `Yes`
- SIG_REQ_CRT_USER_ID = `MBS403`
- SIG_REQ_CRT_USER_ID_NAME = `SMITH, MARY B`
- SIG_REQ_CRT_SRC_C_NAME = `Automatically Created`

### ORDER_STATUS
- ORDER_ID = `439060604`
- ORD_DATE_REAL = `64867`
- CONTACT_DATE = `7/31/2020 12:00:00 AM`
- CONTACT_NUMBER = `2`
- CONTACT_TYPE_C_NAME = `Resulted`
- ABNORMAL_YN = `N`
- ORDER_CREATOR_ID = `CCT400`
- ORDER_CREATOR_ID_NAME = `KALSOW, COURTNEY C`
- RESULTING_LAB_ID = `21030`
- RESULTING_LAB_ID_LLB_NAME = `MISC REFERENCE LAB`
- INSTANT_OF_ENTRY = `7/31/2020 9:17:00 AM`
- ROUTING_OUTCOME_C_NAME = `Result not sent`
- ROUTING_SCHEME_LINE = `Default`
- ROUTING_INST_TM = `7/31/2020 9:19:00 AM`
- ROUTING_USER_ID = `CCT400`
- ROUTING_USER_ID_NAME = `KALSOW, COURTNEY C`
- ROUTING_CURSTATUS_C_NAME = `Routing Complete`
- LAB_STATUS_C_NAME = `Final result`
- RSLT_CNCT_INSTANT_DTTM = `7/31/2020 2:19:20 PM`
- RSLT_CNCT_USER_ID = `CCT400`
- RSLT_CNCT_USER_ID_NAME = `KALSOW, COURTNEY C`
- RSLT_CNCT_SOURCE_C_NAME = `Enter/Edit Results`
- RESULT_DTTM = `7/29/2020 11:34:00 AM`
- NARRATIVE_PERF_ORG_INFO = `1`
- IMPRESSION_PERF_ORG_INFO = `1`

### ORDER_SUMMARY
- ORDER_ID = `439060604`
- LINE = `1`
- ORD_SUMMARY = `Routine, Occupational Therapy, Referral to facility - UPH MERITER HOSPITAL, Specialty Services Requi`

### ORD_CLIN_IND
- ORDER_ID = `439060606`
- LINE = `1`
- CLIN_IND_TEXT = `Essential (primary) hypertension`
- CLIN_IND_CMT_TEXT = `Received over interface (750303,197967350)`

### ORD_INDICATIONS
- ORDER_ID = `439060609`
- LINE = `1`
- INDICATIONS_ID = `1051798`
- INDICATIONS_ID_MEDICAL_COND_NAME = `Head trauma, minor, normal mental status (Age 19-64y)`

### ORD_PRFLST_TRK
- ORDER_ID = `439060604`
- ORDER_TMPLTE_OTL_I = `7834271`
- MOD_FROM_OTL_YN = `N`

### ORD_PROC_INSTR
- ORDER_ID = `439060610`
- LINE = `1`
- ORDER_PROC_INSTR = `<!--EPICS-->`

### ORD_SECOND_SIGN
- ORDER_ID = `439060604`

### ORD_SPEC_QUEST
- ORDER_ID = `439060609`
- LINE = `1`
- ORD_QUEST_ID = `123739`
- ORD_QUEST_DATE = `10/19/2020 12:00:00 AM`
- IS_ANSWR_BYPROC_YN = `Y`
- ORD_QUEST_RESP = `Immediate`

### PERFORMING_ORG_INFO
- ORDER_ID = `439060614`
- LINE = `1`
- PERFORMING_ORG_NAME = `UWHC RADIOLOGY`
- PERFORMING_ORG_DIRECTOR = `GOLDROSEN,MICHAEL,MDSQ2.16.840.1.113883.3.697ISOLDN`
- PERFORMING_ORG_CITY = `Madison`
- PERFORMING_ORG_STATE_C_NAME = `Wisconsin`
- PERFORMING_ORG_ZIP_CODE = `53705`
- PERFORMING_ORG_PHONE_NUM = `+1-844-870-8870`
- PERFORMING_ORG_CLIA_NUM = `52D2072838`
- PERFORMING_ORG_FORMAT_C_NAME = `Care Everywhere`

### RAD_THERAPY_ASSOC_COURSE
- ORDER_ID = `439060604`

### SPEC_TYPE_SNOMED
- ORDER_ID = `439060614`
- LINE = `1`
- TYPE_SNOMED_CT = `119297000`

## Pipeline Code

### Stage 1: SQL Projection (project.ts → raw JSON)
```typescript
function projectOrder(oid: unknown): EpicRow {
  const rows = mergeQuery("ORDER_PROC", `b."ORDER_PROC_ID" = ?`, [oid]);
  const order = rows[0] ?? { ORDER_PROC_ID: oid };

  attachChildren(order, oid, orderChildren);

  // Resolve procedure name
  order._procedure_name = lookupName("CLARITY_EAP", "PROC_ID", "PROC_NAME", order.PROC_ID);

  return order;
}

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
]
```

### Stage 2: Domain Model Hydration (PatientRecord.ts)
```typescript
export class Order {
  ORDER_PROC_ID: EpicID;
  description?: string;
  procedureName?: string;
  orderType?: string;
  orderStatus?: string;
  orderClass?: string;
  orderDate?: string;
  results: OrderResult[] = [];
  diagnoses: EpicRow[] = [];
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
    this.diagnoses = (raw.diagnoses as EpicRow[]) ?? [];
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

export class OrderResult {
  ORDER_PROC_ID: EpicID;
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
    this.componentName = raw.COMPONENT_ID_NAME as string;
    this.value = raw.ORD_VALUE as string;
    this.referenceUnit = raw.REFERENCE_UNIT as string;
    this.referenceRange = raw.REFERENCE_RANGE as string;
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
```

### Stage 3: Clean Projection (HealthRecord.ts → final output)
```typescript
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
```

## Actual Output (from health_record_full.json)

```json
{
  "labResults": [
    {
      "orderId": "439060607",
      "orderName": "H. PYLORI ANTIGEN, STOOL",
      "visitId": "725327197",
      "visitDate": "2018-08-18",
      "component": "H PYLORI ANTIGEN STOOL",
      "value": "NEGATIVE FOR H PYLORI STOOL ANTIGEN",
      "isAbnormal": false,
      "resultDate": "2018-08-18",
      "_epic": {
        "ORDER_PROC_ID": 439060607,
        "componentName": "H PYLORI ANTIGEN STOOL",
        "value": "NEGATIVE FOR H PYLORI STOOL ANTIGEN",
        "resultStatus": "Final",
        "resultDate": "8/18/2018 12:00:00 AM",
        "LINE": 1,
        "ORD_DATE_REAL": 64878.01,
        "ORD_END_DATE_REAL": 64878.01,
        "RESULT_DATE": "8/18/2018 12:00:00 AM",
        "COMPONENT_ID": 1805459,
        "COMPONENT_ID_NAME": "H PYLORI ANTIGEN STOOL",
        "PAT_ENC_CSN_ID": 725327197,
        "ORD_VALUE": "NEGATIVE FOR H PYLORI STOOL ANTIGEN",
        "ORD_NUM_VALUE": 9999999,
        "RESULT_STATUS_C_NAME": "Final",
        "RESULT_SUB_IDN": "1",
        "LAB_STATUS_C_NAME": "Final result",
        "INTERFACE_YN": "Y",
        "COMPONENT_COMMENT": "Testing performed at Meriter Laboratories, 36 S Brooks St Madison, WI 53715, unless otherwise stated in result.",
        "REF_NORMAL_VALS": "NEGATIVE FOR H PYLORI STOOL ANTIGEN",
        "COMP_RES_TECHNICIA": "041518-ALEESA L SHAW",
        "COMP_OBS_INST_TM": "8/18/2018 2:25:00 PM"
      }
    },
    {
      "orderId": "772179260",
      "orderName": "BASIC METABOLIC PANEL",
      "visitId": "948004323",
      "visitDate": "2022-08-29",
      "component": "SODIUM",
      "value": "142",
      "unit": "mmol/L",
      "referenceRange": "136-145",
      "isAbnormal": false,
      "resultDate": "2022-08-29",
      "_epic": {
        "ORDER_PROC_ID": 772179262,
        "componentName": "SODIUM",
        "value": "142",
        "referenceUnit": "mmol/L",
        "resultStatus": "Final",
        "resultDate": "8/29/2022 12:00:00 AM",
        "LINE": 1,
        "ORD_DATE_REAL": 66350.01,
        "ORD_END_DATE_REAL": 66350.01,
        "RESULT_DATE": "8/29/2022 12:00:00 AM",
        "COMPONENT_ID": 1534098,
        "COMPONENT_ID_NAME": "SODIUM",
        "PAT_ENC_CSN_ID": 958147754,
        "ORD_VALUE": "142",
        "ORD_NUM_VALUE": 142,
        "REFERENCE_LOW": "136",
        "REFERENCE_HIGH": "145",
        "REFERENCE_UNIT": "mmol/L",
        "RESULT_STATUS_C_NAME": "Final",
        "RESULT_SUB_IDN": "1",
        "LAB_STATUS_C_NAME": "Final result",
        "INTERFACE_YN": "Y",
        "RESULTING_LAB_ID": 422,
        "RESULTING_LAB_ID_LLB_NAME": "ASSOCIATED PHYSICIANS LLP",
        "RESULT_IN_RANGE_YN": "Y",
        "COMP_RES_TECHNICIA": "100315",
        "COMP_OBS_INST_TM": "8/29/2022 2:32:00 PM",
        "COMP_ANL_INST_TM": "8/29/2022 3:41:00 PM",
        "COMPON_LNC_ID": 21291,
        "COMPON_LNC_SRC_C_NAME": "Reported",
        "PERFORMING_ORG_INFO_LINE": 1
      }
    },
    {
      "orderId": "772179260",
      "orderName": "BASIC METABOLIC PANEL",
      "visitId
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