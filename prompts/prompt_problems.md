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

Analyze the mapping pipeline for **Problems: PROBLEM_LIST → Problem → problems** and identify every semantic error — places where a column is read successfully but the value means something different than the code assumes.

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

### CLARITY_EDG
**Table**: The CLARITY_EDG table contains basic information about diagnoses.
- **DX_ID**: The unique ID of the diagnosis record in your system.
- **DX_NAME**: The name of the diagnosis.
- **PAT_FRIENDLY_TEXT**: A description of the diagnosis that is easy for patients to understand.

### PAT_PROBLEM_LIST
**Table**: This table contains information about the problem list of a patient. It is based off the KB_SQL table PROBLEM_LIST_ID, and its function is to list the Problem List (LPL) IDs of each patient.
- **PAT_ID**: The unique ID of the patient record for this row. This column is frequently used to link to the PATIENT table.
- **LINE**: The line number for the information associated with this record. Multiple pieces of information can be associated with this record.
- **PROBLEM_LIST_ID**: The unique ID of the problem(s) listed for the patient record of this row.

### PL_SYSTEMS
**Table**: The PL_SYSTEMS table contains body system data from patients' problem lists in the clinical system.
- **PROBLEM_LIST_ID**: The unique identifier for the problem record.
- **PROB_LIST_SYSTEM_C_NAME**: This item is a link to the System category associated with the Problem List System record.

### PROBLEM_LIST
**Table**: The PROBLEM_LIST table contains data from patients' problem lists in the clinical system. The data in this table reflects the current status of all problems on the patient's problem list. In the clinical system, each problem is marked as active until it becomes (and is marked) Resolved or Deleted. At that point, by default, it will not be displayed in the application. However, any problem ever entered on this list is stored in the database and will exist in this table. Deleted and resolved problems can be viewed in the application by simply marking a checkbox to show them. Note that deleted and resolved problems can be restored by undeleting them (an option in the application). When a deleted problem is restored, its status is changed to active and the deleted date is returned to null.
- **PROBLEM_LIST_ID**: The unique ID of this Problem List entry.
- **DX_ID**: The unique ID of the diagnosis record associated with the entry in the patient�s Problem List. Note: This is NOT the ICD9 diagnosis code. It is an internal identifier that is typically not visible to a user.
- **DESCRIPTION**: The display name of the problem. Only contains data if the default display name is changed.
- **NOTED_DATE**: Represents the first possible date that a problem could have been noted/onset on. By default, this is the problem's date of entry into the problem list. The intent of this field is to allow users to change this date to the date the problem was first diagnosed if that is different than the entry date.  A problem's noted date is documented as a fuzzy date, meaning that it can capture approximate date data ("2012", "1/2012") or exact data ("3/5/2012"). This column captures the earliest date of the effective range. See NOTED_END_DATE for the latest counterpart. For example, if 2012 is documented in hyperspace, then NOTED_DATE will be 1/1/2012 and NOTED_END_DATE will be 12/31/2012.
- **RESOLVED_DATE**: The date the problem was resolved in calendar format.
- **DATE_OF_ENTRY**: This is the date the specific problem was last edited (i.e., a change was made, either in status, priority, etc.).
- **ENTRY_USER_ID**: The unique ID of the system user who last edited the problem in the patient�s Problem List. This ID may be encrypted.
- **ENTRY_USER_ID_NAME**: The name of the user record. This name may be hidden.
- **PROBLEM_CMT**: The preview text (first characters) of the Overview note entered for a Problem List entry.
- **CHRONIC_YN**: This column indicates whether or not this problem is flagged as chronic.
- **SHOW_IN_MYC_YN**: Indicates whether this problem will be displayed in Epic's Patient Portal, MyChart.
- **PROBLEM_STATUS_C_NAME**: The category value associated with the problem�s current state: Active, Resolved, or Deleted.  NOTE: Historical information regarding status changes can be viewed from within the application.
- **CLASS_OF_PROBLEM_C_NAME**: The category value associated with additional information for the problem, such as Acute, chronic, minor, and so on.
- **PRIORITY_C_NAME**: The category value associated with the relative severity of the problem. Problems can be given a priority (e.g., high, medium, or low).  This field shows the category value associated with the current priority level assigned to a problem.
- **OVERVIEW_NOTE_ID**: This item is a link to the note record that contains the overview note pertaining to this problem record.
- **STAGE_ID**: The unique ID of the cancer stage record associated with the entry in the patient�s Problem List.
- **PROBLEM_TYPE_C_NAME**: The problem type for this problem.
- **CREATING_ORDER_ID**: The order ID of the order that created the problem.
- **NO_STAGE_REASON_C_NAME**: For a problem that could be staged, stores the reason why it was not staged.
- **NO_STAGE_COMMENT**: For a problem that could be staged, stores a free-text comment explaining why the problem was not staged.
- **NO_STAGE_USER_ID**: For a problem that could be staged, stores the user who chose not to stage it.
- **NO_STAGE_USER_ID_NAME**: The name of the user record. This name may be hidden.
- **NO_STAGE_DTTM**: For a problem that could be staged, stores the instant when a user flagged it to not be staged.
- **TREAT_SUMM_STATUS_C_NAME**: Stores the treatment summary status for this problem.
- **NOTED_END_DATE**: Represents the last possible date that a problem could have been noted/onset on.   A problem's noted date is documented as a fuzzy date, meaning that it can capture approximate date data ("2012", "1/2012") or exact data ("3/5/2012"). This column captures the latest date of the effective range. See NOTED_DATE for the earliest counterpart. For example, if 2012 is documented in hyperspace, then NOTED_DATE will be 1/1/2012 and NOTED_END_DATE will be 12/31/2012.  Note that the value may be empty, even if NOTED_DATE is populated
- **REL_GOALS_PROBLEM_LIST_CSN_ID**: Stores the CSN (contact serial number I.E. unique contact identifier) of the last related goals contact that was edited.
- **REL_GOALS_INST_DTTM**: Stores the instant of the last related goals contact that was edited.
- **PROB_STAGE_STATUS_C_NAME**: Flag to indicate whether this problem has been staged or marked as no stage required.
- **DIAG_START_DATE**: Represents the earliest possible date that a problem could have been diagnosed on. The latest possible date is stored in DIAG_END_DATE. If these values are the same, then the date is exact rather than fuzzy. For a problem or condition affecting a patient, the diagnosis date is defined as the date when a qualified professional first recognized the presence of that condition with sufficient certainty, regardless of whether it was fully characterized at that time. For diseases such as cancer, this may be the earliest date of a clinical diagnosis from before it was histologically confirmed, not the date of confirmation if that occurred later.
- **DIAG_END_DATE**: Represents the last possible date that a problem could have been diagnosed on. The earliest possible date is stored in DIAG_START_DATE. If these values are the same, then the date is exact rather than fuzzy. For a problem or condition affecting a patient, the diagnosis date is defined as the date when a qualified professional first recognized the presence of that condition with sufficient certainty, regardless of whether it was fully characterized at that time. For diseases such as cancer, this may be the earliest date of a clinical diagnosis from before it was histologically confirmed, not the date of confirmation if that occurred later.

### PROBLEM_LIST_ALL
**Table**: This is a generic table that contains every Problem List (LPL) record regardless of its type. It also contains a link to the patient record that is associated with the LPL record, a column indicating the type of LPL record, and an optional link from a Problem History record (type 7) to the corresponding Problem record (type 1) that it describes.
- **PROBLEM_LIST_ID**: The unique identifier for the problem record.
- **PAT_ID**: The unique ID of the patient record associated with this problem list.
- **HX_SOURCE_ID**: Stores the ID of the problem record that this history record describes.
- **RECORD_TYPE_C_NAME**: Indicates the type of information stored in this record, such as Problem List, Allergy, Immunization, etc.

### PROB_LIST_REV_HX
**Table**: This table contains all the historical entries (dates/times/users/related contacts) for when the patient's problem list was marked as reviewed.
- **PAT_ID**: The unique ID assigned to the patient record. This ID may be encrypted if you have elected to use enterprise reporting's encryption utility.
- **LINE**: The line number for the information associated with this record. Multiple pieces of information can be associated with this record.
- **PROB_LIST_REV_HX_DT**: All the historical dates the patient's problem list was reviewed
- **PROB_LIST_REV_HX_TM**: All the historical times the patient's problem list was reviewed
- **PRBLST_REVUSRHX_ID**: All the users that have reviewed the patient's Problem List.
- **PRBLST_REVUSRHX_ID_NAME**: The name of the user record. This name may be hidden.
- **PROB_LIST_REV_CSNHX**: The unique contact serial number for the patient encounter in which the problem list was reviewed within an encounter context. This number is unique across all patient encounters in your system. If you use IntraConnect, this is the Unique Contact Identifier (UCI).

### PROB_UPDATES
**Table**: This table includes over-time single-response items from the Problem List (LPL) master file, such as the contact serial number (CSN), contact time, and contact user.
- **PROBLEM_LIST_ID**: The unique identifier for the problem record.
- **CONTACT_DATE_REAL**: A unique contact date in decimal format. The integer portion of the number indicates the date of contact. The digits after the decimal distinguish different contacts on the same date and are unique for each contact on that date. For example, .00 is the first/only contact, .01 is the second contact, etc.
- **CONTACT_DATE**: The date and time of this contact.
- **CONTACT_SERIAL_NUM**: The contact serial number (CSN) of the contact, which is a unique contact identifier.
- **EDIT_USER_ID**: The user ID of the user who made the change.
- **EDIT_USER_ID_NAME**: The name of the user record. This name may be hidden.
- **CONTACT_STATUS_C_NAME**: Stores the status of this contact - used by records of type "Problem History".
- **EPT_CSN**: Holds the patient CSN (contact serial number I.E. unique contact identifier) corresponding to the patient encounter in which related information was added to or removed from this problem, if the edit was made during a patient encounter.
- **RECONCILED_YN**: This item contains information about whether a problem has been reconciled in a given encounter.

## Sample Data (one representative non-null value per column)

### CLARITY_EDG
- DX_ID = `15362`
- DX_NAME = `Screening for hyperlipidemia`

### PAT_PROBLEM_LIST
- PAT_ID = `Z7004242`
- LINE = `1`
- PROBLEM_LIST_ID = `30694847`

### PL_SYSTEMS
- PROBLEM_LIST_ID = `30681923`
- PROB_LIST_SYSTEM_C_NAME = `Genitourinary`

### PROBLEM_LIST
- PROBLEM_LIST_ID = `30694847`
- DX_ID = `260690`
- NOTED_DATE = `9/1/2020 12:00:00 AM`
- DATE_OF_ENTRY = `8/29/2022 12:00:00 AM`
- ENTRY_USER_ID = `RAMMELZL`
- ENTRY_USER_ID_NAME = `RAMMELKAMP, ZOE L`
- CHRONIC_YN = `N`
- SHOW_IN_MYC_YN = `Y`
- PROBLEM_STATUS_C_NAME = `Active`
- NOTED_END_DATE = `9/1/2020 12:00:00 AM`

### PROBLEM_LIST_ALL
- PROBLEM_LIST_ID = `30666377`
- PAT_ID = `Z7004242`
- RECORD_TYPE_C_NAME = `System`

### PROB_LIST_REV_HX
- PAT_ID = `Z7004242`
- LINE = `1`
- PROB_LIST_REV_HX_DT = `8/9/2018 12:00:00 AM`
- PROB_LIST_REV_HX_TM = `8/9/2018 9:55:00 AM`
- PRBLST_REVUSRHX_ID = `DHILLOPS`
- PRBLST_REVUSRHX_ID_NAME = `DHILLON, PUNEET S`
- PROB_LIST_REV_CSNHX = `720803470`

### PROB_UPDATES
- PROBLEM_LIST_ID = `30666377`
- CONTACT_DATE_REAL = `64868`
- CONTACT_DATE = `8/9/2018 11:10:00 AM`
- CONTACT_SERIAL_NUM = `43855016`
- EDIT_USER_ID = `DHILLOPS`
- EDIT_USER_ID_NAME = `DHILLON, PUNEET S`

## Pipeline Code

### Stage 1: SQL Projection (project.ts → raw JSON)
```typescript
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

const problemChildren: ChildSpec[] = [
  { table: "PROB_UPDATES", fkCol: "PROBLEM_LIST_ID", key: "updates" },
  { table: "PL_SYSTEMS", fkCol: "PROBLEM_LIST_ID", key: "body_systems" },
  { table: "PROBLEM_LIST_ALL", fkCol: "PROBLEM_LIST_ID", key: "all_info" },
]

// ─── Inline in main() ───
  problem_review_history: tableExists("PROB_LIST_REV_HX") ? children("PROB_LIST_REV_HX", "PAT_ID", patId) : [],
```

### Stage 2: Domain Model Hydration (PatientRecord.ts)
```typescript
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
```

### Stage 3: Clean Projection (HealthRecord.ts → final output)
```typescript
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
```

## Actual Output (from health_record_full.json)

```json
{
  "problems": [
    {
      "id": "30694847",
      "name": "Gastroesophageal reflux disease",
      "icdCode": "70859",
      "dateOfOnset": "2018-08-09",
      "status": "Active",
      "isChronic": false,
      "_epic": {
        "PROBLEM_LIST_ID": 30694847,
        "diagnosisName": "Gastroesophageal reflux disease",
        "dateOfEntry": "8/9/2018 12:00:00 AM",
        "status": "Active",
        "chronicYN": "N",
        "DX_ID": 70859,
        "NOTED_DATE": "8/9/2018 12:00:00 AM",
        "DATE_OF_ENTRY": "8/9/2018 12:00:00 AM",
        "ENTRY_USER_ID": "DHILLOPS",
        "ENTRY_USER_ID_NAME": "DHILLON, PUNEET S",
        "CHRONIC_YN": "N",
        "SHOW_IN_MYC_YN": "Y",
        "PROBLEM_STATUS_C_NAME": "Active",
        "_dx_name": "Gastroesophageal reflux disease"
      }
    },
    {
      "id": "90574164",
      "name": "Post concussion syndrome",
      "icdCode": "260690",
      "dateOfOnset": "2020-09-01",
      "status": "Active",
      "isChronic": false,
      "_epic": {
        "PROBLEM_LIST_ID": 90574164,
        "diagnosisName": "Post concussion syndrome",
        "dateOfEntry": "8/29/2022 12:00:00 AM",
        "status": "Active",
        "chronicYN": "N",
        "DX_ID": 260690,
        "NOTED_DATE": "9/1/2020 12:00:00 AM",
        "DATE_OF_ENTRY": "8/29/2022 12:00:00 AM",
        "ENTRY_USER_ID": "RAMMELZL",
        "ENTRY_USER_ID_NAME": "RAMMELKAMP, ZOE L",
        "CHRONIC_YN": "N",
        "SHOW_IN_MYC_YN": "Y",
        "PROBLEM_STATUS_C_NAME": "Active",
        "NOTED_END_DATE": "9/1/2020 12:00:00 AM",
        "_dx_name": "Post concussion syndrome"
      }
    }
  ]
}
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