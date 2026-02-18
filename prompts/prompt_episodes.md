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

Analyze the mapping pipeline for **Episodes: EPISODE + CAREPLAN_INFO** and identify every semantic error — places where a column is read successfully but the value means something different than the code assumes.

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

### CAREPLAN_ENROLLMENT_INFO
**Table**: This table cotains the enrollment information for a care plan.
- **CAREPLAN_ID**: The unique identifier (.1 item) for the care plan record.
- **CP_ENROLL_WORKFLOW_C_NAME**: This item store the Care Companion workflow from where this care plan was applied to the patient.
- **ALERT_CSN_ID**: BestPractice Advisory ALT CSN used to enroll the patient in the care plan.
- **SIGNUP_MYPT_ID**: MyChart user ID who enrolled the patient in the care plan.
- **PREG_SELF_EPISODE_ID**: Pregnancy episode ID (HSB) associated with the self-enrolled care plan.
- **ENROLLING_USER_ID**: User who enrolled the patient in the care plan.
- **ENROLLING_USER_ID_NAME**: The name of the user record. This name may be hidden.
- **SURGICAL_PAT_ENC_CSN_ID**: Patient CSN linked to the surgical encounter where the enrollment was done

### CAREPLAN_INFO
**Table**: Contains information about care plan template records.
- **CARE_INTG_ID**: The unique identifier for the care plan record.
- **CAREPLAN_TYPE_C_NAME**: The category ID of the type of the care plan record (Collaborative or Home Health).
- **PAT_ENC_CSN_ID**: The linked unique contact serial number for the patient. This number is unique across all patient encounters in your system. If you use IntraConnect, this is the Unique Contact Identifier (UCI). This column is frequently used to link to the PAT_ENC_HSP table.
- **PATIENT_ID**: Links OP care plan (patient-level and episodic) to the associated patient
- **LINKED_PAT_CAREPLAN_YN**: Indicates whether the outpatient care plan is linked at the patient level or the episode level. Yes means it is patient level, No means it is episode level.
- **RFL_INSTR_NOTE_ID**: Stores the ID of the HNO record that contains the referral instructions
- **READING_CAREPLAN_ID**: The link to the care plan reading Care Plan record.
- **LAST_EDITED_DTTM**: The date and time when the care plan was last edited. This does not include documentation-only changes.
- **RECORD_STATUS_2_C_NAME**: Record status flag. Used in conjunction with record archived flag for encounter archiving.
- **PAT_ENROLL_DEPARTMENT_ID**: This item stores the department which enrolled the patient in MyChart care plan.

### EPISODE
**Table**: This table contains high-level information on the episodes recorded in the clinical system for your patients. When a provider sees a patient several times for an ongoing condition, such as prenatal care, these encounters can be linked to a single Episode of Care. It does not contain episodes linked to an inpatient encounter.
- **EPISODE_ID**: The unique ID of the episode of care record.
- **NAME**: The name of the episode.
- **SUM_BLK_TYPE_ID**: The episode type.
- **START_DATE**: The date the episode was initiated.
- **END_DATE**: The date the episode was resolved in calendar format. This field is called "Resolved" on the clinical system screen.
- **COMMENTS**: Any free text comments about the episode.
- **PREGRAVID_WEIGHT**: This field contains the pre-pregnancy weight maintained before this episode.
- **NUMBER_OF_BABIES**: Prior to delivery, this column is expected to contain the number of fetuses that the patient is carrying. This can be manually documented, such as in the Prenatal Vitals section, or the value can be automatically set by creating or removing fetal result tabs in the ultrasound activity.  If your organization documents on the Delivery Summary then after the Delivery Summary is signed, this column is expected to contain the number of viable deliveries associated with the pregnancy. Specifically, this is the number of delivery records attached to the pregnancy. This expectation is based on Epic's recommendation that only viable deliveries should be documented on the Delivery Summary. Your organization may follow a different policy for when to create a delivery record. The behavior of this column containing the number of delivery records may be overridden at the profile level in system definitions, in which case it will continue to contain the number of fetuses that were being carried unless the number of deliveries is manually documented in its place.
- **PRIMARY_LPL_ID**: The primary problem linked to the episode.
- **STATUS_C_NAME**: The status category number for the episode.
- **L_UPDATE_USER_ID**: The ID of the last user that updated the episode of care record.
- **L_UPDATE_USER_ID_NAME**: The name of the user record. This name may be hidden.
- **PATERNITY_ACK_C_NAME**: Whether a paternity acknowledgement has been signed by the biological father of the baby if the parents are not married. This column may not be applicable depending on the identity of the second parent and the two parents' relationship.
- **SMOKE_3_MO_BEF**: The number of cigarettes/packs smoked per day 3 months before the pregnancy by the mother.
- **SMOKE_3_MO_BEF_C_NAME**: The unit of measurement for the quantity of cigarettes being smoked 3 months before the pregnancy by the mother.
- **SMOKE_1ST_3_MO**: The number of cigarettes/packs smoked per day in the first 3 months of the pregnancy by the mother.
- **SMOKE_1ST_3_MO_C_NAME**: The unit of measurement for the quantity of cigarettes being smoked the first three months of the pregnancy by the mother.
- **SMOKE_2ND_3_MO**: The number of cigarettes/packs smoked per day in the second 3 months of the pregnancy by the mother.
- **SMOKE_2ND_3_MO_C_NAME**: The unit of measurement for the quantity of cigarettes being smoked the second three months of the pregnancy by the mother.
- **SMOKE_3RD_TRI**: The number of cigarettes/packs smoked per day in the third trimester of the pregnancy by the mother.
- **SMOKE_3RD_TRI_C_NAME**: The unit of measurement for the quantity of cigarettes being smoked the third trimester of the pregnancy by the mother.
- **DRINK_3_MO_BEF**: The number of alcoholic drinks consumed per week 3 months before the pregnancy by the mother.
- **DRINK_1ST_3_MO**: The number of alcoholic drinks consumed per week in the first three months of the pregnancy by the mother.
- **DRINK_2ND_3_MO**: The number of alcoholic drinks consumed per week in the second three months of the pregnancy by the mother.
- **DRINK_3RD_TRI**: The number of alcoholic drinks consumed per week in the third trimester of the pregnancy by the mother.
- **IN_CITY_LIMITS_YN**: Whether the address of the mother is inside the city limits.
- **WIC_FOODS_YN**: Did the mother receive WIC foods during this pregnancy?
- **TOTAL_PNC**: Override value to be used in situations where not all prenatal care was given at the same Epic provider and so not all prenatal care visits are in the system.
- **MONTH_1ST_PNC**: Override value to be used in situations where not all prenatal care was given at the same Epic provider and so first date of prenatal care is not in the system and the month of the pregnancy when prenatal care began cannot be calculated.
- **LIVE_BIRTHS_LIVING**: Override value to be used in situations where not all prenatal care was given at the same Epic provider, and consequently, other pregnancy information is not available. The number of children born alive which are still living not including children born at this birth.
- **LIVE_BIRTHS_DEAD**: Override value to be used in situations where not all prenatal care was given at the same Epic provider, and consequently, other pregnancy information is not available. The number of other children born alive which are now deceased not including any born alive and deceased at this birth.
- **MOTHER_MARRIED_YN**: Whether the mother is married at birth, conception, or any time in between.
- **OB_PREGRAVID_BMI**: The patient's pre-pregnancy BMI for this pregnancy episode.
- **FIRST_PNT_LOC_C_NAME**: This item stores who the patient's first prenatal care was with.
- **SERV_AREA_ID**: The unique ID of the episode's service area. This column is used for DBC episodes, which are specific to a service area.
- **OB_WRK_EDD_DT**: The estimated date of delivery for a pregnancy episode.
- **EXPECTED_DEL_LOC_C_NAME**: Location where the woman plans to deliver her baby.
- **DEL_LOC_CHANGE_C_NAME**: Why the delivery location changed from the expected delivery location (EXPECTED_DEL_LOC_C) for a pregnancy episode.
- **OB_FEEDING_INTENTIONS_C_NAME**: Mother's intended feeding method for the baby.
- **INTENT_TREAT_C_NAME**: The intended treatment for an implanted Mechanical Circulatory Device.
- **INTENT_TREAT_OTHR**: The free text intended treatment for an implanted Mechanical Circulatory Device.
- **MCS_DISCHARGE_DT**: Date a Mechanical Circulatory Device patient is discharged.
- **MCS_EVAL_DT**: The start date of the Mechanical Circulatory Device evaluation.
- **MCS_REV_DT**: The date when the Mechanical Circulatory Device case was reviewed by the evaluation committee.
- **MCS_ADMISSION_DT**: Date of the admission for the Mechanical Circulatory Device procedure.
- **MCS_SURG_DT**: The date of the Mechanical Circulatory Device surgery.
- **MCS_IS_HISTORIC_YN**: Flag indicating a historic Mechanical Circulatory Device episode. This is intended to flag if the Device was implanted at another center than the Center that is currently following the patient.
- **MCS_EVAL_END_DT**: The date on which the Mechanical Circulatory Device evaluation was completed.
- **MCS_NEXT_REVIEW_DT**: The date on which both the Mechanical Circulatory Device episode and the patient chart should be reviewed.
- **MCS_REFERRAL_DT**: The date the patient was referred for the Mechanical Circulatory Device.
- **MCS_TXPORT_MTHD_C_NAME**: The method of transportation to the implantation center.

### EPISODE_2
**Table**: This table supplements the EPISODE table. It contains additional information about episodes. When a provider sees a patient several times for an ongoing condition, such as prenatal care, these encounters can be linked to a single Episode of Care.
- **EPISODE_ID**: The unique ID of the episode of care record. NOTE: This table is filtered to include only non-inpatient episodes. Inpatient episode data can be found in the table IP_EPISODE_LINK (first released with system 2002).
- **DEPT_ID**: The unique identifier for the department primarily responsible for managing the episode.
- **RXENROLL_LAST_EDIT_USER_ID**: The user ID for whoever last updated the pharmacy enrollment.
- **RXENROLL_LAST_EDIT_USER_ID_NAME**: The name of the user record. This name may be hidden.
- **RXENROLL_LAST_EDIT_DTTM**: The date and time the pharmacy enrollment was last updated.
- **ENROLL_PROG_C_NAME**: The current enrollment program for the pharmacy.
- **RXENROLL_NOTE_ID**: Summary note documented on this episode
- **RXENROLL_ENROLLMENT_DATE**: The date the patient was enrolled in the program
- **RXENROLL_DISENROLL_DATE**: The date the patient was unenrolled from the program.
- **RXENROLL_DECLINE_DATE**: The date the patient was declined enrollment (or declined to enroll) in the program
- **RXENROLL_STATUS_C_NAME**: The current enrollment status
- **CRT_PAT_ENC_CSN_ID**: The patient contact serial number that auto created this episode.
- **CMGMT_STATUS_C_NAME**: Stores the status of the case episode.  Enrolling - The manager is working to enroll the patient in a case management program. Open - The manager is performing ongoing outreach with the patient. Closed - The patient is no longer enrolled in case management, or they opted out of case management.
- **CMGMT_SENSITIVITY_C_NAME**: Store the sensitivity flag for security restricted case episodes. If your organization has implemented break-the-glass, this sensitivity flag can be used to restrict access to the case episode.
- **CMGMT_ENROLLMENT_RSN_C_NAME**: Stores the reason the patient was enrolled in case management.
- **CMGMT_ENROLLING_STEP_C_NAME**: Stores the enrolling step that specifies the current step of enrollment for the case episode.
- **CMGMT_CLOSED_REASON_C_NAME**: Stores the reason the case episode is closed.
- **ENROLL_ID**: The research study-patient association (LAR) record ID for this episode.
- **PREG_CHORIONIC_C_NAME**: For a pregnancy with multiple fetuses, indicates if the fetuses have individual or a shared chorionic and amniotic sacs.
- **PLAN_ADOPT_TYPE_C_NAME**: This item indicates if the mother plans to give the baby up for adoption and if so, what type of adoption or arrangement is planned.
- **SUSPECTED_FD_YN**: This item indicates whether a suspected fetal demise has occurred in the pregnancy.
- **PLAN_CIRCUMCISION_C_NAME**: This item is used to indicate whether the parents have requested a circumcision after the baby is born.
- **PLAN_DELIVER_BY_GA**: This item represents the gestational age (in weeks of pregnancy) at when the patient and provider expect the delivery to occur.
- **PLAN_DEL_METHOD_C_NAME**: This item captures the planned method of delivery as documented prior to labor.
- **CMGMT_DECLINE_REASON_C_NAME**: Documents the reason a patient/client refused coordinated case management services.
- **HSPC_ADD_DISCUSSED_WITH_PAT_YN**: This item indicates whether or not a hospice election addendum was discussed with the patient for this episode.
- **HSPC_ADD_REQUESTED_WITH_PAT_YN**: This item indicates whether or not a hospice election addendum was requested for this episode.
- **HSPC_ADD_DISCUSSED_USER_ID**: The unique user record ID that is frequently used to link to the CLARITY_EMP table.
- **HSPC_ADD_DISCUSSED_USER_ID_NAME**: The name of the user record. This name may be hidden.
- **HSPC_ADD_DISCUSSED_DATE**: The date the addendum was discussed with the patient.
- **CMGMT_ENROLL_DATE**: Documents the enrollment date, which is the date on which a patient or client's status becomes active and the patient or client starts receiving Coordinated Care Management services. Refer to CMGMT_CALC_ENROLL_DATE for more robust reporting.
- **CMGMT_ENROLL_CALC_DATE**: This virtual item contains a calculated enrollment date determined from the user- documented enrollment date (CMGMT_ENROLL_DATE, HSB-18030) or the Case Management History related group (I HSB 18400).  If the overall episode status (CMGMT_STATUS_C, I HSB 18010) is 1-Enrolling, the value will be blank.  If the overall status is anything besides 1-Enrolling, the value will be set to the user- documented Enrollment Date, if it exists. Otherwise, the value will be set to the date (ACTION_UTC_DTTM) the status (ASSOC_CMGMT_STATUS_C) originally changed to 2-Active, unless the status was changed to 1-Enrolling more recently.
- **CMGMT_TRIGGERING_CLASSIFIER_ID**: The classifier (CFR record) that triggered the creation of this case.
- **CMGMT_TRIGGERING_CLASSIFIER_ID_CLASSIFIER_NAME**: The title of the classifier record.
- **CMGMT_TRIGGERING_CLAIM_ID**: The claim that caused the creation of this case.
- **PREG_CORD_BLOOD_PLANS_C_NAME**: This item indicates the patient's plans for umbilical cord blood.
- **LINKED_SERVICE_PLAN_ID**: The service plan associated with this episode.
- **MC_TG_RSLV_DATE**: Stores the resolve date for this Tapestry bundle.
- **BPC_ID**: Stores the bundled episode terms id.
- **BPC_ID_BPC_NAME**: The name of the bundled episode terms record.
- **BPC_CSN_ID**: Stores the bundled episode terms contact serial number.

### PAT_EPISODE
**Table**: The PAT_EPISODE table links patient ID numbers to Episodes of Care records. This is especially helpful for connecting patients to episodes of care when there are no linked encounters on an episode record. When this is the case, the PAT_ID column in the EPISODE table may be null.
- **PAT_ID**: The unique ID assigned to the patient record. This ID may be encrypted if you have elected to use enterprise reporting�s encryption utility.
- **LINE**: The line number for the information associated with this record. Multiple pieces of information can be associated with this record.
- **EPISODE_ID**: The unique ID number associated with an Episode of Care.

## Sample Data (one representative non-null value per column)

### CAREPLAN_ENROLLMENT_INFO
- CAREPLAN_ID = `7498035`

### CAREPLAN_INFO
- CARE_INTG_ID = `7498035`
- CAREPLAN_TYPE_C_NAME = `Collaborative`
- PAT_ENC_CSN_ID = `922942674`
- PATIENT_ID = `Z7004242`
- LINKED_PAT_CAREPLAN_YN = `N`
- READING_CAREPLAN_ID = `7498036`
- LAST_EDITED_DTTM = `3/11/2022 8:11:27 AM`

### EPISODE
- EPISODE_ID = `200498750`
- NAME = `OT Neuro TBI`
- SUM_BLK_TYPE_ID = `151`
- START_DATE = `3/11/2022 12:00:00 AM`
- END_DATE = `4/21/2022 12:00:00 AM`
- STATUS_C_NAME = `Resolved`
- L_UPDATE_USER_ID = `ALG006`
- L_UPDATE_USER_ID_NAME = `GILMOUR, AARON K`
- SERV_AREA_ID = `10`

### EPISODE_2
- EPISODE_ID = `200498750`

### PAT_EPISODE
- PAT_ID = `Z7004242`
- LINE = `1`
- EPISODE_ID = `200498750`

## Pipeline Code

### Stage 1: SQL Projection (project.ts → raw JSON)
```typescript
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
    return ep;
  });
}
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