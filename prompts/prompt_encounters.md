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

Analyze the mapping pipeline for **Encounters: PAT_ENC (splits) + children → visits** and identify every semantic error — places where a column is read successfully but the value means something different than the code assumes.

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

### ADDITIONAL_EM_CODE
**Table**: This table holds all information related to additional evaluation and management (E/M) codes.
- **PAT_ENC_CSN_ID**: A unique serial number for this encounter. This number is unique across all patients and encounters in the system.
- **LINE**: The line number for the information associated with this contact. Multiple pieces of information can be associated with this contact.
- **EM_CODE_ADDL_ID**: Procedure codes used in addition to the Level of Service (LOS).
- **EM_CODE_MOD_ID**: Modifiers associated with the additional E/M code. Stored in comma-delimited format with up to four modifiers.
- **EM_CODE_BILPROV_ID**: The billing provider for the additional Evaluation and Management (E/M) codes.
- **EM_CODE_UNIQUE_NUM**: Unique number associated with each additional E/M code. The number is only unique within the contact.
- **EM_NO_CHG_REASON_C_NAME**: The reason that a charge was not triggered for an E/M code. This item being populated does not imply any issues with system integrity or system build; it will be set both for legitimate reasons that a charge was not triggered as well as non-legitimate reasons.
- **AR_EM_CODE_DX**: The associated diagnosis information for additional E/M code data generated by an AR interface.

### AN_RELINK_INFO
**Table**: Anesthesia automatic relinking information.
- **PAT_ENC_CSN_ID**: The unique contact serial number (CSN) for this contact. The number is unique across all patient encounters in any given system. If the system uses IntraConnect, this is the Unique Contact Identifier (UCI).
- **PAT_ENC_DATE_REAL**: A unique contact date in decimal format. The integer portion of the number indicates the date of contact. The digits after the decimal distinguish different contacts on the same date and are unique for each contact on that date. For example, .00 is the first/only contact, .01 is the second contact, etc.
- **CONTACT_DATE**: The date of this contact in calendar format.
- **CM_CT_OWNER_ID**: The Community ID (CID) of the instance that owns this contact. This is only populated if you use IntraConnect.
- **AN_RELINKRESCHED_ID**: When this appointment is rescheduled, the anesthesia record listed here will automatically be relinked to the new appointment.
- **AN_RELINK_TYPE_C_NAME**: Type of relinking to perform when the appointment is rescheduled.

### APPT_LETTER_RECIPIENTS
**Table**: Information about the patient and their contacts selected to receive appointment letters.
- **PAT_ENC_CSN_ID**: The unique contact serial number for this contact. This number is unique across all patient encounters in your system. If you use IntraConnect, this is the Unique Contact Identifier (UCI).
- **LINE**: The line number for the information associated with this contact. Multiple pieces of information can be associated with this contact.
- **PAT_ENC_DATE_REAL**: A unique contact date in decimal format. The integer portion of the number indicates the date of contact. The digits after the decimal distinguish different contacts on the same date and are unique for each contact on that date. For example, .00 is the first/only contact, .01 is the second contact, etc.
- **CONTACT_DATE**: The date of this contact in calendar format.
- **CM_CT_OWNER_ID**: The Community ID (CID) of the instance that owns this contact. This is only populated if you use IntraConnect.
- **PAT_RELATIONSHIP_ID**: A unique ID of the patient contact to indicate if the patient contact should receive appointment letters for a given visit.
- **SHOULD_RECEIVE_LETTERS_YN**: Indicates whether a patient or a patient's contact should receive appointment letters for this visit. 'N' indicates they should not receive appointment letters.
- **SHOULD_ATTEND_VISIT_YN**: Indicates whether a patient or a patient's contact should attend this visit. 'N' indicates they should not attend this visit.
- **DID_ATTEND_VISIT_YN**: Indicates whether a patient or a patient's contact attended this visit. 'N' indicates they did not attend this visit.

### ASSOCIATED_REFERRALS
**Table**: This table contains information about referrals linked to an appointment.
- **PAT_ENC_CSN_ID**: The unique contact serial number for this contact. This number is unique across all patient encounters in your system. If you use IntraConnect, this is the Unique Contact Identifier (UCI).
- **LINE**: The line number for the information associated with this contact. Multiple pieces of information can be associated with this contact.
- **PAT_ENC_DATE_REAL**: A unique contact date in decimal format. The integer portion of the number indicates the date of contact. The digits after the decimal distinguish different contacts on the same date and are unique for each contact on that date. For example, .00 is the first/only contact, .01 is the second contact, etc.
- **CONTACT_DATE**: The date of this contact in calendar format.
- **ASSOCIATED_REFERRAL_ID**: Stores the IDs of referrals associated with a visit.
- **ASSOC_LNK_SRC_C_NAME**: The method used to link this appointment to the referral in the corresponding line of EPT-23025.
- **ASSOC_LNK_UTC_DTTM**: The instant (UTC) the appointment was linked to the referral in the corresponding line of EPT-23025.

### CLARITY_DEP
**Table**: The CLARITY_DEP table contains high-level information about departments.
- **DEPARTMENT_ID**: The unique ID number assigned to the department record.
- **DEPARTMENT_NAME**: The name of the department.
- **EXTERNAL_NAME**: The external name of the department record. This is often used in patient correspondence such as reminder letters.

### CLARITY_DEP_4
**Table**: This table extends CLARITY_DEP, which contains high-level information about departments from the Department master file.
- **DEPARTMENT_ID**: The unique ID of the Department record.
- **MED_REC_STYLE_C_NAME**: The medication reconciliation style category ID for the department.
- **DEP_TYPE_C_NAME**: The type of the department.

### CLARITY_EDG
**Table**: The CLARITY_EDG table contains basic information about diagnoses.
- **DX_ID**: The unique ID of the diagnosis record in your system.
- **DX_NAME**: The name of the diagnosis.
- **PAT_FRIENDLY_TEXT**: A description of the diagnosis that is easy for patients to understand.

### CLARITY_SER
**Table**: The CLARITY_SER table contains high-level information about your provider records. These records may be caregivers, resources, classes, devices, and modalities.
- **PROV_ID**: The unique ID assigned to the provider record. This ID can be encrypted.
- **PROV_NAME**: The name of the service provider. This item may be hidden in a public view of the CLARITY_SER table.
- **EXTERNAL_NAME**: The external name of the provider record.

### DISCONTINUED_MEDS
**Table**: This table contains a list of medications that have been discontinued for a patient during an encounter.
- **PAT_ENC_CSN_ID**: The unique identifier of the patient encounter. Contact serial number is unique across all patients and all contacts.
- **LINE**: The Line Count
- **PAT_ENC_DATE_REAL**: This is a numeric representation of the date of this encounter in your system. The integer portion of the number specifies the date of the encounter. The digits after the decimal point indicate multiple visits on one day.
- **CONTACT_DATE**: The date on which the patient encounter occurred.
- **MEDS_DISCONTINUED**: This column contains medications that were discontinued for the patient during the associated patient encounter.

### ECHKIN_STEP_INFO
**Table**: This table contains eCheck-In information for a specific appointment.
- **PAT_ENC_CSN_ID**: The unique contact serial number for this contact. This number is unique across all patient encounters in your system. If you use IntraConnect, this is the Unique Contact Identifier (UCI).
- **LINE**: The line number for the information associated with this contact. Multiple pieces of information can be associated with this contact.
- **PAT_ENC_DATE_REAL**: A unique contact date in decimal format. The integer portion of the number indicates the date of contact. The digits after the decimal distinguish different contacts on the same date and are unique for each contact on that date. For example, .00 is the first/only contact, .01 is the second contact, etc.
- **CONTACT_DATE**: The date of this contact in calendar format.
- **CM_CT_OWNER_ID**: The Community ID (CID) of the instance that owns this contact. This is only populated if you use IntraConnect.
- **INCLUDED_STEP_C_NAME**: The step of the eCheck-In workflow.
- **ECHKIN_STEP_STAT_C_NAME**: The status of the specific step mentioned in the eCheck-In workflow.
- **STEP_COMPLETED_UTC_DTTM**: Stores the instant (in UTC) the step was completed in the eCheck-In workflow
- **MYPT_ID**: Stores the MyChart user ID that did the eCheck-In step.
- **STEP_ACTION_C_NAME**: The category ID for the action taken on an eCheck-In step.

### ED_PAT_STATUS
**Table**: The ED_PAT_STATUS table contains information about ED patients' "patient" status. One row in this table corresponds to one ED "patient" status change. If a patient's ED "patient" status is changed five times in a single encounter, this table will contain five rows for that encounter.
- **INPATIENT_DATA_ID**: The unique ID associated with the Inpatient Data Store record for this row. This column is frequently used to link to PAT_ENC_HSP.INPATIENT_DATA_ID.
- **LINE**: The line number for the information associated with this patient status. Multiple pieces of information can be associated with this record.
- **ED_PAT_STATUS_C_NAME**: The category number of the ED patient status for the ED encounter.
- **PAT_STATUS_TIME**: The date and time when the ED patient status was set.
- **PAT_STATUS_USER_ID**: The unique ID of the user who is associated with this status change. This column is frequently used to link to the CLARITY_EMP table.
- **PAT_STATUS_USER_ID_NAME**: The name of the user record. This name may be hidden.
- **PAT_ENC_CSN_ID**: The unique contact serial number for this contact. This number is unique across all patient encounters in your system. If you use IntraConnect this is the Unique Contact Identifier (UCI). This column is frequently used to link to PAT_ENC_HSP.PAT_ENC_CSN_ID.

### EXT_PHARM_TYPE_COVERED
**Table**: The pharmacy coverage type returned from Surescripts eligibility response.
- **PAT_ENC_CSN_ID**: The unique contact serial number for this contact. This number is unique across all patient encounters in your system. If you use IntraConnect, this is the Unique Contact Identifier (UCI).
- **GROUP_LINE**: The line number for the information associated with this contact.
- **VALUE_LINE**: The line number of one of the multiple values associated with a specific group of data within this contact.
- **COVERED_EXTERNAL_PHARM_TYPE_C_NAME**: Stores pharmacy coverage type for SureScripts 5010

### FAMILY_HX
**Table**: The FAMILY_HX table contains data recorded in the family history contacts entered in the patient's chart during a clinical system encounter. Note: This table is designed to hold a patient's history over time; however, it is most typically implemented to only extract the latest patient history contact.
- **LINE**: The line number to identify the family history contact within the patient�s record.  NOTE: Each line of history is stored in enterprise reporting as its own record; a given patient may have multiple records (identified by line number) that reflect multiple lines of history.
- **MEDICAL_HX_C_NAME**: The category value associated with the Problem documented in the patient�s family history.
- **MEDICAL_OTHER**: The custom reason for visit or problem entered when the clinical system user chooses "Other" as a family history problem. NOTE: The comment is stored in the same item as MEDICAL_HX_C but is delimited from the response "Other" by the comment character, "[". The EPIC_GET_COMMENT function returns everything after the comment character.
- **COMMENTS**: Free-text comments entered with this problem. This column may be hidden in a public enterprise reporting view.
- **PAT_ENC_CSN_ID**: A unique serial number for this encounter. This number is unique across all patients and encounters in the system.
- **FAM_HX_SRC_C_NAME**: This item contains the source of information for a patient's family medical history.
- **RELATION_C_NAME**: This is the category value associated with the family member who has or had this problem. An example might be sister, brother, or mother.
- **FAM_RELATION_NAME**: This is the first and/or last name of the patient's family member. This column is free-text and is meant to be used together with the RELATION_C category to form a unique key for the family member. If no name is entered this column will display an abbreviation of the family relation type beginning with ##.
- **AGE_OF_ONSET**: This item contains the age of onset of the patient's family member that is documented with a history of a problem.
- **FAM_MED_REL_ID**: This item contains the unique ID of the patient's family member relationship for medical history.
- **FAM_MEDICAL_DX_ID**: The unique ID of the diagnosis associated with the family member condition.
- **AGE_OF_ONSET_END**: When the age of onset for a family member's history of a problem is documented as an age range, this item contains the age at the end of the range.

### FAM_HX_PAT_ONLY
**Table**: This table represents all family history specific patient information.
- **PAT_ENC_CSN_ID**: The unique contact serial number for this contact. This number is unique across all patient encounters in your system. If you use IntraConnect, this is the Unique Contact Identifier (UCI).
- **PAT_ENC_DATE_REAL**: A unique contact date in decimal format. The integer portion of the number indicates the date of contact. The digits after the decimal distinguish different contacts on the same date and are unique for each contact on that date. For example, .00 is the first/only contact, .01 is the second contact, etc.
- **CONTACT_DATE**: The date of this contact in calendar format.
- **FAM_HX_FERT_STAT_C_NAME**: Category for documenting the patient's fertility status.
- **FAM_HX_FERT_STAT_NOTES**: This item contains additional notes about the patient's fertility status.

### FRONT_END_PMT_COLL_HX
**Table**: This table stores information about front-end collection actions taken through point of sale (POS) payment posting or refund workflows.
- **PAT_ENC_CSN_ID**: The unique contact serial number for this contact. This number is unique across all patient encounters in your system. If you use IntraConnect, this is the Unique Contact Identifier (UCI).
- **LINE**: The line number for the information associated with this contact. Multiple pieces of information can be associated with this contact.
- **CONTACT_DATE**: The date of this contact in calendar format.
- **COLL_INSTANT_UTC_DTTM**: The instant that this event occurred.
- **COLL_WORKFLOW_TYPE_C_NAME**: The workflow in which this event took place.
- **LOGIN_DEPARTMENT_ID**: The unique ID of the department which a user was logged into at the time of this event.
- **ENC_DEPARTMENT_ID**: The unique ID of the encounter department associated with this event.
- **RSN_NON_COLL_AMT_C_NAME**: The non-collection reason category ID for this event.
- **RSN_NON_COLL_AMT_COMMENT**: The free text non-collection comment explaining why some portion of a due amount was not collected.
- **GUARANTOR_ACCOUNT_ID**: The unique ID of the guarantor who is associated with this event.
- **EVENT_TYPE_C_NAME**: The event type category ID that defines the type of payment event data that is stored in this row.
- **PB_COPAY_COLL**: The amount of professional billing copay that a user collected during this event.
- **PB_COPAY_PAID**: The amount of professional billing copay that had already been paid towards an encounter at the time of this event.
- **PB_COPAY_DUE**: The total amount of professional billing copay that is required for this visit at the time of this event.
- **HB_COPAY_COLL**: The amount of hospital billing copay that a user collected during this event.
- **HB_COPAY_PAID**: The amount of hospital billing copay that had already been paid towards an encounter at the time of this event.
- **HB_COPAY_DUE**: The total amount of hospital billing copay that is required for this visit at the time of this event.
- **PB_PREPAY_COLL**: The amount of professional billing prepayment that a user collected.
- **PB_PREPAY_PAID**: The amount of professional billing prepayment that had already been paid towards an encounter at the time of this event.
- **PB_PREPAY_DUE**: The total amount of professional billing prepayment that is required for this visit at the time of this event.
- **HB_PREPAY_COLL**: The amount of hospital billing prepayment that a user collected during this event.
- **HB_PREPAY_PAID**: The amount of hospital billing prepayment that had already been paid towards an encounter at the time of this event.
- **HB_PREPAY_DUE**: The total amount of hospital billing prepayment that is required for this visit at the time of this event.
- **PB_PREV_BAL_COLL**: The amount of professional billing previous balance that a user collected during this event.
- **PB_PREV_BAL_PAID**: The amount of professional billing previous balance that had already been paid towards this guarantor's outstanding balance during the day of this event.
- **PB_PREV_BAL_DUE**: The amount of self-pay professional billing outstanding balance that a guarantor owed at the time of this event.
- **HB_PREV_BAL_COLL**: The amount of hospital billing previous balance that a user collected during this event.
- **HB_PREV_BAL_PAID**: The amount of hospital billing previous balance that had already been paid towards this guarantor's outstanding balance during the day of this event.
- **HB_PREV_BAL_DUE**: The amount of self-pay hospital billing outstanding balance that a guarantor owed at the time of this event.
- **PREPAY_DISCOUNT_OFFERED**: The total amount of the prepay discount that was offered for this visit at the time of this event.
- **VIS_BAL_COLL**: The amount of visit balance that a user collected during this event.
- **VIS_BAL_PAID**: The amount of the visit balance that had already been paid towards an encounter at the time of this event.
- **VIS_BAL_DUE**: The total amount of the visit balance that is required for this visit at the time of this event.

### HNO_INFO
**Table**: This table contains common information from General Use Notes items. This table focuses on time-insensitive, once-per-record data while other HNO tables (e.g., NOTES_ACCT, CODING_CLA_NOTES) contain the data for different note types.
- **NOTE_ID**: The unique ID of the note record.
- **NOTE_TYPE_NOADD_C_NAME**: This virtual item is populated with a category value from Note - Type No-Add (I HNO 51) according to the following logic: * if Note - Type No-Add (I HNO 51) is populated, use the value directly * if Note - Type No-Add (I HNO 51) is null and the note is not ambulatory, return null * if Note - Type No-Add (I HNO 51) is null and the note has an ambulatory encounter context, obtain a category from the UCN note type (I HNO 34033) and map that value to an equivalent category from Note - Type No Add (I HNO 51), if possible
- **PAT_ENC_CSN_ID**: The unique contact serial number for the patient encounter to which the note is attached. This number is unique across all patient encounters in your system. If you use IntraConnect this is the Unique Contact Identifier (UCI).
- **ENTRY_USER_ID**: The unique ID of the user who created this note. This column is frequently used to link to the CLARITY_EMP table.
- **ENTRY_USER_ID_NAME**: The name of the user record. This name may be hidden.
- **NOTE_DESC**: This is a free text description of the note.
- **IP_NOTE_TYPE_C_NAME**: The note type associated with this note.
- **ORIGINAL_HP_ID**: For View-Only H&P notes only - original note record identifier
- **ORIG_HP_DATE_REAL**: For View-Only H&P notes only - original note record contact
- **SOURCE_HP_ID**: For Interval H&P only - ID of H&P Note being modified by interval note
- **SOURCE_HP_DATE_REAL**: For Interval H&P only - contact of H&P Note being modified by interval note
- **ECG_TECHNICIAN_ID**: The Electrocardiogram/Spirometry Technician
- **ADDENDUM_PARENT_CSN**: Contains the contact serial number (CSN) of the parent document.
- **PAT_LINK_ID**: Virtual item that will check all HNO items linked to EPT and return the first EPT ID it finds. The items are checked in the following order: 505, 38970, 21001, 600 (which gives us an order, then we look at ord 210), 1605, 1643, 1640.
- **LETTER_SUMMARY**: The summary of the letter.
- **TX_IB_FOLDER_C_NAME**: Stores the Type of Message (I EOW 30) In Basket folder to be used by the Transcription interface to generate In Basket messages
- **CREATE_INSTANT_DTTM**: The note's create instant.
- **UNSIGNED_YN**: A flag for if the note record is considered an unsigned note.
- **DELETE_INSTANT_DTTM**: The instant when the note is deleted.
- **DELETE_USER_ID**: User who deleted the note
- **DELETE_USER_ID_NAME**: The name of the user record. This name may be hidden.
- **COSIGNED_NOTE_LINK**: Contains a contact serial number (CSN) that points to the resident's note being cosigned. Cosigning Note Link (I HNO 34158) is a link for the opposite direction.
- **DATE_OF_SERVIC_DTTM**: The note's date of service.
- **SIGNED_NOTE_ID**: This item points to the ID of the signed note that this note is addending/editing/cosigning.
- **LST_FILED_INST_DTTM**: The instant the note was last edited.
- **UPDATE_DATE**: The date and time when this row was created or last updated in Clarity.
- **CURRENT_AUTHOR_ID**: This item stores the current author of the note for indexing purposes.
- **CURRENT_AUTHOR_ID_NAME**: The name of the user record. This name may be hidden.
- **LETTER_TYPE_C_NAME**: Type of professional billing letter.
- **VISIT_NUM**: Professional billing visit number attached to this note.
- **CRT_INST_LOCAL_DTTM**: This is a virtual item that gets the create instant (I HNO 17105), in local time format.
- **NOTE_PURPOSE_C_NAME**: This is a virtual item that displays the note purpose. It was previously stored in Note - Purpose (INP-5045).
- **PRIORITY_YN**: The priority of the note (Yes = High, No = Routine).
- **ACTIVE_FROM_DT**: The date on which the note becomes active.
- **ACTIVE_TO_DT**: The date after which the note becomes inactive.
- **TREAT_SUM_RLS_TO_MYC_YN**: Indicates whether a Treatment Summary is released to MyChart.
- **TREAT_SUM_RLS_TO_MYC_CSN**: Stores the CSN of the Treatment Summary (HNO) that is released to MyChart. If you use IntraConnect, this column stores the Unique Contact Identifier (UCI).
- **COMMENT_USER_ID**: The unique ID of the last user to edit the internal comment in either the Continued Care and Services Coordination or Payer Communication workflows.
- **COMMENT_USER_ID_NAME**: The name of the user record. This name may be hidden.
- **COMMENT_EDIT_INST_DTTM**: Instant the comment was last edited in either the Continued Care and Services Coordination or Payer Communication workflows. In UTC.
- **CONVERSATION_MSG_ID**: The record for the message that was also filed as a note. The text filed in the message and the quicknote will be the same and displaying one of these to the end user should be sufficient.

### HNO_INFO_2
**Table**: This table contains common information from General Use Notes items. This table focuses on one time only data while other HNO tables (e.g., NOTES_ACCT, CODING_CLA_NOTES) contain the data for different note types.
- **NOTE_ID**: The note ID for the note record.
- **RELEVANT_REC_EVENT_ID**: Holds the Events (IEV) record which contains records marked relevant to the Note such as problems, allergies, lab results, etc.
- **GROUP_NOTE_ID**: This item stores the group note ID for notes that are created in a group documentation context.
- **LETTER_DEST_C_NAME**: The letter destination category ID for the note. This column is only populated if this row is for a Customer Relationship Management letter.
- **LETTER_FINAL_UTC_DTTM**: The instant the letter was finalized. This column is only populated if this row is for a Customer Relationship Management letter.
- **HNO_RECORD_TYPE_C_NAME**: Record type.
- **RFL_LETTER_ENC_CSN**: Stores the encounter in which the referral communication letter was written
- **CONV_MSG_CID**: This item contains the Community ID (CID) of a related In Basket Message (EOW) record.
- **OUTREACH_TEMPLATE_ID**: This item stores the campaign outreach template that created the letter.
- **SOURCE_EDITS_CSN**: Stores a Contact Serial Number (CSN) pointer to the General Use Notes (HNO) record that holds edits to the parent note while an attestation is in progress.
- **EXT_DOC_EVNT_ID**: External autoreconciled note event identifier
- **EXT_NOTE_TYPE**: Autoreconciled external note type name
- **EXT_DUP_NOTE_ID**: Autoreconciled extneral note duplicate source note
- **EXT_DUP_NOTE_C_NAME**: Autoreconciled external note duplicate note type
- **PARENT_NOTE_ID**: The parent note ID of a soft-deleted transcription record.
- **ACTIVE_C_NAME**: Whether the note is active. This item is not populated for all notes.
- **EXT_AUTHOR**: Name of the external note's author. The name is stored as pieces delimited by character 127 and is ordered as follows: Last Name, Last Name from Spouse, First Name, Middle Name, Last Name Prefix, Spouse Last Name Prefix, Title, Suffix, Academic Initials.
- **NOTE_UPDATE_INST_UTC_DTTM**: The last time this note was received through Care Everywhere. The value of Received Assessment and Plan Existence Days (I DXC 17000) defines how long notes with this item set exist before they are deleted. Scheduled task Remove HNO Records (E1J 88032) deletes notes and all of their references that have not been received within the amount of days defined by Received Assessment and Plan Existence Days (I DXC 17000)  Received Assessment and Plan Existence Days (I DXC 17000) defaults to 30 days if not set.
- **ROUT_RECPNT_COMMUNICATION_ID**: This is a Communication Management (LCA) record that contains information about recipients that users selected for routing in the clinical note editor.
- **EXTERNAL_SOURCE_IDENT**: If this note is associated with information in an outside system, the ID of that information can be stored here.
- **EXTERNAL_PROBLEM_IDENT**: The reference ID for the external problem linked to the note.

### HOMUNCULUS_PAT_DATA
**Table**: Patient-specific rheumatology data, related to the homunculus joint exam.
- **PAT_ENC_CSN_ID**: The unique contact serial number for this contact. This number is unique across all patient encounters in your system. If you use IntraConnect, this is the Unique Contact Identifier (UCI).
- **PAT_ENC_DATE_REAL**: A unique contact date in decimal format. The integer portion of the number indicates the date of contact. The digits after the decimal distinguish different contacts on the same date and are unique for each contact on that date. For example, .00 is the first/only contact, .01 is the second contact, etc.
- **CONTACT_DATE**: The date of this contact in calendar format.
- **CM_CT_OWNER_ID**: The Community ID (CID) of the instance that owns this contact. This is only populated if you use IntraConnect.

### HSP_ADMIT_DIAG
**Table**: The HSP_ADMIT_DIAG table contains information on admission diagnoses. This table is based on patient contact serial number.
- **LINE**: The line number of the admission diagnosis for the patient.
- **DX_ID**: Unique Identifier for diagnosis record used to document patient's admission diagnosis.
- **ADMIT_DIAG_TEXT**: Free text admission diagnosis for the patient.
- **PAT_ENC_CSN_ID**: A unique serial number for this encounter. This number is unique across all patients and encounters in the system.

### HSP_ADMIT_PROC
**Table**: The HSP_ADMIT_PROC table contains information on admission procedures. This table is based on PAT_ENC_CSN_ID.
- **LINE**: The line number of the admission procedure for this patient.
- **PROC_ID**: The coded admission procedure for the patient.
- **ADMIT_PROC_TEXT**: Free text admission procedure for the patient.
- **ADMIT_PROC_DATE**: The date that the admission procedure is scheduled for the patient.
- **PAT_ENC_CSN_ID**: A unique serial number for this encounter. This number is unique across all patients and encounters in the system.
- **ADM_PXDX_ASSOC**: Used for ABN checks.  A comma delimited list of  line numbers that associate this procedure to a diagnosis.
- **ADM_PX2ABN_LINK**: A comma-delimited list of line numbers that indicate which ABN's are associated with this procedure.

### HSP_ATND_PROV
**Table**: The HSP_ATND_PROV table contains information on inpatient or outpatient attending providers. This table is based on PAT_ENC_CSN_ID.
- **LINE**: The line number of the attending provider for the patient.
- **ATTEND_FROM_DATE**: The date and time the attending provider started for the patient. Can be assigned for both hospital encounters and outpatient visits.   Dates are not guaranteed to be filled in. If dates are empty, this range is assumed to be open-ended. Date/time range only applies to this encounter. Checking relevant encounter dates should be done in addition to these dates to get the whole picture for an encounter.
- **ATTEND_TO_DATE**: The date and time the attending provider ended for the patient. Can be assigned for both hospital encounters and outpatient visits.   Dates are not guaranteed to be filled in. If dates are empty, this range is assumed to be open-ended. Date/time range only applies to this encounter. Checking relevant encounter dates should be done in addition to these dates to get the whole picture for an encounter.
- **PROV_ID**: This column stores the unique identifier for the attending provider for the patient. Can be assigned for both hospital encounters and outpatient visits. From and to dates are not guaranteed to be filled in.
- **ED_ATTEND_YN**: Indicates whether or not this physician was an attending in the ED.
- **PAT_ENC_CSN_ID**: A unique serial number for this encounter. This number is unique across all patients and encounters in the system.

### IP_DATA_STORE
**Table**: This table contains generic information related to a patient's inpatient stay, including data on patient education, notes, and other topics.
- **INPATIENT_DATA_ID**: The unique ID of the inpatient data store record.
- **TEMPLATE_ID**: The unique ID of the flowsheet template.
- **TEMPLATE_ID_DISPLAY_NAME**: The display name associated with this template.
- **DISCH_INST_HNO_ID**: The HNO ID of the patient's discharge instructions, for discharge instructions created in version Epic Aug 2021 or prior. In version Epic Nov 2021 and later, the discharge instruction information that was previously stored in INP will now be stored in HNO for Note Type 18-Discharge Instructions, with information about instances where discharge instructions were reviewed, updated, or signed extracted in the Clarity table DISCH_INSTR_HISTORY.
- **RECORD_STATUS_C_NAME**: The current status of the Inpatient Data record: active or resolved.
- **EPT_CSN**: Link to Contact Serial Number in EPT for associated encounter.
- **BRST_STAT_INST_TM**: Stores the last instant that Breastfeeding Status was saved.
- **PAIN_EDU_INST_TM**: Stores the last instant the Pain Education was saved.
- **HC_INSTANT_TM**: Stores the last instant that the Head Circumference was saved.
- **PF_INSTANT_TM**: Stores the last instant that Peak Flow was saved.
- **EXINGC_INSTANT_TM**: Stores the last instant that Exclude in Growth Charts information was saved.
- **ALT_PRINT_INST_TM**: Stores the last instant BestPractice Advisory (BPA) alert information was saved.
- **IP_NOTE_MOD_INST_TM**: The time the Notes were last modified for this Inpatient Data record.
- **UPDATE_DATE**: The date and time this row was last updated (the last time it was extracted or this column was backfilled).

### IP_FLOWSHEET_ROWS
**Table**: This table contains flowsheet row (FLO) data for an encounter. This table is a key table in tying LDA assessment row lines in flowsheet data records to the LDAs, and the necessary joins are:


 


IP_FLOWSHEET_ROWS.IP_LDA_ID with IP_LDA_NOADDSINGLE.IP_LDA_ID


IP_FLOWSHEET_ROWS.INPATIENT_DATA_ID with IP_FLWSHT_REC.INPATIENT_DATA_ID


IP_FLOWSHEET_ROWS.LINE with IP_FLWSHT_MEAS.OCCURANCE


IP_FLWSHT_REC.FSD_ID with IP_FLWSHT_MEAS.FSD_ID.
- **INPATIENT_DATA_ID**: The unique ID of the inpatient data store record.
- **LINE**: The line count for the item.
- **FLO_MEAS_ID**: The unique ID of the flowsheet group/row.
- **FLO_MEAS_ID_DISP_NAME**: The display name given to the flowsheet group/row.
- **FLOWSHT_ROW_NAME**: The flowsheet row name. Especially comes into play when a custom name is given to a duplicable row/group, either by a user typing it upon manually adding a row/group or from the order that fired the task template which added the duplicable row/group.
- **IP_LDA_ID**: Stores the Lines/Drains/Airways (LDA) ID for the flowsheet group.
- **ROW_VARIANCE_C_NAME**: The flowsheet row variance.

### IP_FLWSHT_MEAS
**Table**: This table contains the patient-specific measurements from flowsheets.
- **FSD_ID**: The unique ID for the flowsheet data record.
- **LINE**: The line count for the item.
- **OCCURANCE**: If the flowsheet group/row appears multiple times, this will distinguish the occurrence.
- **RECORDED_TIME**: The instant the reading was taken.
- **ENTRY_TIME**: The instant the reading was entered.
- **TAKEN_USER_ID**: The unique ID of the user taking the flowsheet readings.
- **TAKEN_USER_ID_NAME**: The name of the user record. This name may be hidden.
- **ENTRY_USER_ID**: The unique ID of the user entering the readings.
- **ENTRY_USER_ID_NAME**: The name of the user record. This name may be hidden.
- **MEAS_COMMENT**: The free text comments associated with the reading.
- **EDITED_LINE**: The line number of the previous value of an edited record.
- **ISACCEPTED_YN**: Determines if this flowsheet record has been accepted.
- **IP_SIGNIFICANT_YN**: This stores whether the flowsheet data is marked as significant. If a value is not marked as significant, this column returns NULL.
- **CAPTURE_DEVICE_ID**: This item stores information of the Device ID for the device from which data is captured from.
- **CAPTURE_DEVICE_ID_DEVICE_NAME**: The name for this device.
- **RECEIVED_INSTANT**: Instant at which value was received at the interface
- **NEEDS_COSIGN_C_NAME**: If this item is blank or 0 (No), then this flowsheet data does not need a cosign.  If this item is 1 (Required Yes), then a cosign is required for this data and can only be pended.  If this item is 2 (Chosen Yes), then a cosign has been requested for this data but it is not required.  If this item is 3 (Required Yes Can File), then a cosign is required for the data and the data can be filed.
- **FLT_ID**: The unique ID of the flowsheet template (FLT) which was used to enter the data in this cell.
- **FLT_ID_DISPLAY_NAME**: The display name associated with this template.
- **FLO_DAT_USED**: This column stores the contact date (DAT) of the flowsheet row or group that is used to define the data.
- **FLO_CNCT_DATE_REAL**: This column converts the contact date (DAT) of the flowsheet group or row to DTE, based on the value in column FLO_DAT_USED.
- **USER_PENDED_BY_ID**: User ID of the user who pended this flowsheet value.
- **USER_PENDED_BY_ID_NAME**: The name of the user record. This name may be hidden.
- **INSTANT_PENDED_DTTM**: Date/time at which a flowsheet value is pended.
- **ABNORMAL_C_NAME**: Stores whether or not the value is abnormal
- **THRDPRTY_SRC_C_NAME**: Identifies the third-party framework that a Flowsheets value originally came from, if applicable. Intended to be used to track values that are sourced from health/fitness frameworks (e.g. Apple's HealthKit) to provide additional context when examining attached metadata.
- **PAT_REPORTED_STATUS_C_NAME**: Indicates if the data was directly entered by the patient or a patient proxy and whether the data has been validated by a clinician
- **MYPT_ID**: The MyChart account from which the data was entered.
- **IS_FROM_SPEECH_YN**: Indicates whether a filed flowsheet value was entered using speech entry.
- **ABNORMAL_TYPE_C_NAME**: This column stores metadata for abnormal flowsheet values. It is only populated for data where ABNORMAL_C - Abnormal is set to 1-Yes. It is set to 1-Low for data that is below the minimum warning level and it is set to 2-High for data that is above the maximum warning level for flowsheet data of types: numeric, blood pressure, temperature, height, patient height, weight and patient weight. It is set to 0-Unspecified for data that is abnormal for other reasons. This is the only value that can be set for flowsheet data of type: custom list.
- **FLO_NETWORKED_INI**: The INI to which the value for this row is associated.
- **FLO_CATEGORY_INI**: The INI of a category flowsheet value
- **FLO_CATEGORY_ITEM**: The item number of a category flowsheet value
- **FLO_CATEGORY_VALUE**: The category value of a flowsheet row
- **DOC_METHOD_C_NAME**: Indicates the method the user used to enter the line of flowsheet data.
- **MACRO_RECORD_ID**: When the documentation method in FSD-1360 is 1-Value From Macro this is the macro HGM record ID.
- **MACRO_RECORD_ID_RECORD_NAME**: The name of the Scripting Template.

### IP_FLWSHT_REC
**Table**: This table contains linking information associated with flowsheet records.
- **FSD_ID**: The unique ID for the flowsheet data record.
- **INPATIENT_DATA_ID**: The unique ID of the inpatient record associated with this flowsheet reading.
- **RECORD_DATE**: The date these flowsheet readings were taken.
- **DAILY_NET**: The daily net Intake/Output total for this date.
- **PAT_ID**: The unique ID of the patient.

### KIOSK_QUESTIONNAIR
**Table**: List of questionnaires assigned to a patient appointment to be asked in the Welcome kiosk application.
- **PAT_ENC_CSN_ID**: The unique contact serial number for this contact. This number is unique across all patient encounters in your system. If you use IntraConnect, this is the Unique Contact Identifier (UCI).
- **LINE**: The line number for the information associated with this contact. Multiple pieces of information can be associated with this contact.
- **PAT_ID**: The unique ID of the patient record for this row. This column is frequently used to link to the PATIENT table.
- **PAT_ENC_DATE_REAL**: A unique contact date in decimal format. The integer portion of the number indicates the date of contact. The digits after the decimal distinguish different contacts on the same date and are unique for each contact on that date. For example, .00 is the first/only contact, .01 is the second contact, etc.
- **CONTACT_DATE**: The date of this contact in calendar format.
- **KIOSK_QUEST_ID**: The unique ID of the questionnaire assigned to the encounter, which will be presented to the patient at the Welcome kiosk.
- **KIOSK_QUEST_ID_FORM_NAME**: The name of the form associated with the questionnaire.

### MEDICAL_HX
**Table**: The MEDICAL_HX table contains data from medical history contacts entered in clinical system patient encounters. Since one patient encounter may contain multiple medical history contacts, each contact is uniquely identified by a patient encounter serial number and a line number.
- **LINE**: The line number of the medical history contact within the encounter. Each line of history is stored in enterprise reporting as its own record; a given patient may have multiple records (identified by line number) that reflect multiple lines of history.
- **DX_ID**: The unique ID of the diagnosis record associated with the medical history contact. Note: This is NOT the ICD9 diagnosis code. It is an internal identifier that is typically not visible to a user.
- **MEDICAL_HX_DATE**: The free-text date entered in clinical system�s Medical History window for the diagnosis. This field is free-text due to the imprecise nature of patient-provided historical information.
- **PAT_ENC_CSN_ID**: A unique serial number for this encounter. This number is unique across all patients and encounters in the system.
- **MED_HX_ANNOTATION**: This column contains the medical history annotation.

### MED_PEND_APRV_STAT
**Table**: Information on the approval status of medication orders pended in a telephone encounter.
- **PAT_ENC_CSN_ID**: The unique contact serial number for this contact. This number is unique across all patient encounters in your system. If you use IntraConnect, this is the Unique Contact Identifier (UCI).
- **LINE**: The line number for the information associated with this contact. Multiple pieces of information can be associated with this contact.
- **PAT_ENC_DATE_REAL**: A unique contact date in decimal format. The integer portion of the number indicates the date of contact. The digits after the decimal distinguish different contacts on the same date and are unique for each contact on that date. For example, .00 is the first/only contact, .01 is the second contact, etc.
- **CONTACT_DATE**: The date of this contact in calendar format.
- **MED_PEND_APRV_FLG_C_NAME**: A flag indicating the status of medications pended for approval in a telephone encounter.
- **MED_REFUSE_RSN_C_NAME**: Indicates the reason a medication pended for approval was refused.

### MYC_APPT_QNR_DATA
**Table**: Table to store the general questionnaire attached to upcoming appointment.
- **PAT_ENC_CSN_ID**: The unique contact serial number for this contact. This number is unique across all patient encounters in your system. If you use IntraConnect, this is the Unique Contact Identifier (UCI).
- **LINE**: The line number for the information associated with this contact. Multiple pieces of information can be associated with this contact.
- **PAT_ENC_DATE_REAL**: A unique contact date in decimal format. The integer portion of the number indicates the date of contact. The digits after the decimal distinguish different contacts on the same date and are unique for each contact on that date. For example, .00 is the first/only contact, .01 is the second contact, etc.
- **CONTACT_DATE**: The date of this contact in calendar format.
- **CM_CT_OWNER_ID**: The Community ID (CID) of the instance that owns this contact. This is only populated if you use IntraConnect.
- **MYC_APPT_QUESR_ID**: Stores the ID of a questionnaire assigned to an upcoming appointment.
- **MYC_APPT_QUESR_ID_FORM_NAME**: The name of the form associated with the questionnaire.
- **MYC_QUESR_START_DT**: Stores the start date of when a questionnaire can be shown for an upcoming appointment,
- **PAT_APPT_QNR_STAT_C_NAME**: The status of the patient-entered appointment questionnaire.

### OPH_EXAM_DATA
**Table**: Stores ophthalmology exam information documented in the visit.
- **PAT_ENC_CSN_ID**: The unique contact serial number for this contact. This number is unique across all patient encounters in your system. If you use IntraConnect, this is the Unique Contact Identifier (UCI).
- **PAT_ENC_DATE_REAL**: A unique contact date in decimal format. The integer portion of the number indicates the date of contact. The digits after the decimal distinguish different contacts on the same date and are unique for each contact on that date. For example, .00 is the first/only contact, .01 is the second contact, etc.
- **OPHTH_BUVA_OD**: Stores the best uncorrected visual acuity in logMAR notation for the right eye within the visit.
- **OPHTH_BCVA_OD**: Stores the best corrected visual acuity in logMAR notation for the right eye within the visit.
- **OPHTH_BUVA_OS**: Stores the best uncorrected visual acuity in logMAR notation for the left eye within the visit.
- **OPHTH_BCVA_OS**: Stores the best corrected visual acuity in logMAR notation for the left eye within the visit.
- **OPHTH_BUVA_DISP_OD**: Stores the entered display format for the best visual acuity at distance uncorrected for the right eye.
- **OPHTH_BCVA_DISP_OD**: Stores the entered display format for the best visual acuity at distance corrected for the right eye.
- **OPHTH_BUVA_DISP_OS**: Stores the entered display format for the best visual acuity at distance uncorrected for the left eye.
- **OPHTH_BCVA_DISP_OS**: Stores the entered display format for the best visual acuity at distance corrected for the left eye.

### ORDER_PARENT_INFO
**Table**: This table will hold procedure order data where it is sometimes necessary to obtain the information from the parent (or possibly grandparent) order if it exists. Otherwise default to the child/normal order record's information in cases where there is no parent order.
- **ORDER_ID**: The unique identifier that consists of the order ID. Grandparent, parent and child orders will populate this table.
- **PARENT_ORDER_ID**: If the ID in the ORDER_ID column is a child order, then this column will hold the original order ID that instantiated the child (possibly a parent or possibly a grandparent order). If the ID in the ORDER_ID column is an order placed by an end user in the system (i.e. it was never instantiated- such as parent or grandparents), then this column will hold the same ID.
- **ORDERING_DTTM**: This is the original ordering date and time of the order record in the PARENT_ORDER_ID column.  For child orders, the date and time in ORDER_PROC.ORDER_INST is the date and time the order was released.
- **ORD_LOGIN_DEP_ID**: This is the original login department of the order record in the PARENT_ORDER_ID column.   For child orders, the department in ORDER_PROC_2.LOGIN_DEP_ID is the department in which the order was released.
- **PAT_ENC_CSN_ID**: The unique contact serial number for this contact. This number is unique across all patient encounters in your system. If you use IntraConnect, this is the Unique Contact Identifier (UCI). This will be the contact used to place the order record in the PARENT_ORDER_ID column.   For child orders, the contact serial number in ORDER_PROC.PAT_ENC_CSN_ID is the contact in which the order was released.
- **PAT_CONTACT_DEP_ID**: This is the patient contact department of the order record in the PARENT_ORDER_ID column.

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

### PATIENT_ENC_VIDEO_VISIT
**Table**: This table contains the video visit related data for a patient that is stored at the patient contact level.
- **PAT_ENC_CSN_ID**: The unique contact serial number for this contact. This number is unique across all patient encounters in your system. If you use IntraConnect, this is the Unique Contact Identifier (UCI).
- **PAT_ENC_DATE_REAL**: A unique contact date in decimal format. The integer portion of the number indicates the date of contact. The digits after the decimal distinguish different contacts on the same date and are unique for each contact on that date. For example, .00 is the first/only contact, .01 is the second contact, etc.
- **CONTACT_DATE**: The date of this contact in calendar format.
- **PAT_ENC_LVL_VIDEO_VISIT_ID**: Contains any patient encounter level video visit that is associated with a given patient encounter.
- **TH_MODE_VV_CHG_USER_ID**: Stores the user who switched the telehealth mode of a visit away from a video visit.
- **TH_MODE_VV_CHG_USER_ID_NAME**: The name of the user record. This name may be hidden.

### PAT_ADDENDUM_INFO
**Table**: This table contains the encounter addendum information from the Addendum Added Date (I EPT 18123) and Addendum Added User (I EPT 18129) items.
- **PAT_ENC_DATE_REAL**: A unique contact date in decimal format. The integer portion of the number indicates the date of contact. The digits after the decimal distinguish different contacts on the same date and are unique for each contact on that date. For example, .00 is the first/only contact, .01 is the second contact, etc.
- **PAT_ENC_CSN_ID**: A unique serial number for this encounter. This number is unique across all patients and encounters in the system.
- **CONTACT_DATE**: The date of this contact in calendar format.
- **LINE**: The line count for the items.
- **ADDENDUM_DATE_TIME**: The date and time when the addendum of the patient encounter is created.
- **ADDENDUM_USER_ID**: The unique ID of the system user who has created the addendum for the patient encounter.
- **ADDENDUM_USER_ID_NAME**: The name of the user record. This name may be hidden.
- **ADDENDUM_STARTED_UTC_DTTM**: This is the UTC instant when an addendum was started. If blank, then the Addendum Finished Date and Addendum Finished Time (ADDENDUM_DATE_TIME) is the started instant as well as the signed instant.
- **ADDENDUM_STARTED_USER_ID**: The unique user identifier that started the addendum. If blank, then the Addendum Finished User (ADDENDUM_USER_ID) was the user that started the addendum as well as signed it.
- **ADDENDUM_STARTED_USER_ID_NAME**: The name of the user record. This name may be hidden.
- **SOURCE_WORKFLOW_C_NAME**: This is the current platform that is allowed to edit the open addendum. This is only set for open addenda started on Rover.
- **ADDENDUM_OPEN_YN**: Stores whether the addendum is open and has not yet been signed.

### PAT_CANCEL_PROC
**Table**: Table contains the information about cancel procedures in the generic patient database.
- **PAT_ENC_CSN_ID**: The unique contact serial number for this contact. This number is unique across all patient encounters in your system. If you use IntraConnect, this is the Unique Contact Identifier (UCI).
- **LINE**: The line number for the information associated with this contact. Multiple pieces of information can be associated with this contact.
- **CONTACT_DATE**: The date of this contact in calendar format.
- **CAN_PRCD_C_ID**: ID of the cancelled procedure.

### PAT_CR_TX_SINGLE
**Table**: This table contains single response information about the credit card transaction associated with an e-visit encounter that is stored in the patient record when the encounter is created.
- **PAT_ENC_CSN_ID**: The contact serial number is unique across all patients and all contacts.
- **PAT_ENC_DATE_REAL**: This is a numeric representation of the date of this encounter in your system. The integer portion of the number specifies the date of the encounter. The digits after the decimal point indicate multiple visits on one day.
- **CONTACT_DATE**: The date of this contact in calendar format.
- **CM_CT_OWNER_ID**: The ID of the contact owner.

### PAT_ENC
**Table**: The patient encounter table contains one record for each patient encounter in your system. By default, this table does not contain Registration or PCP/Clinic Change contacts (encounter types 1 and 31). It does contain all appointments, office visits, telephone encounters, and other types of encounters. The primary key for the patient encounter table is PAT_ENC_CSN_ID.


Note that there is an index named EIX_FILT_PAT_ENC_RFL on the REFERRAL_ID column in Oracle that does not appear in the index list. The index is created by EFN_FAUX_RFL_FILT_INX.
- **PAT_ID**: The unique ID assigned to the patient record. This ID may be encrypted if you have elected to use enterprise reporting�s encryption utility.
- **PAT_ENC_DATE_REAL**: A unique contact date in decimal format. The integer portion of the number indicates the date of contact. The digits after the decimal distinguish different contacts on the same date and are unique for each contact on that date. For example, .00 is the first/only contact, .01 is the second contact, etc.
- **PAT_ENC_CSN_ID**: A unique serial number for this encounter. This number is unique across all patients and encounters in the system.
- **CONTACT_DATE**: The date of this contact in calendar format.
- **PCP_PROV_ID**: The unique ID of the provider record for the patient�s General Primary Care Provider as of the date of the encounter. This ID may be encrypted if you have elected to use enterprise reporting�s security utility.
- **FIN_CLASS_C_NAME**: The category value associated with the Financial Class of the encounter. Note: This item is only populated through an interface. It is not populated if you have billing system installed.
- **VISIT_PROV_ID**: The unique ID for the visit provider associated with this encounter. In cases where there are multiple providers for one encounter, this is the ID of the first provider in the list. This item may be NULL if there is no provider for this encounter. This ID may be encrypted.
- **VISIT_PROV_TITLE_NAME**: The visit provider�s provider title (SER 5). See VISIT_PROV_ID above for the definition of visit provider.
- **DEPARTMENT_ID**: The ID of the department for the encounter. If there are multiple departments for the encounter, this is the ID of the first department in the list.
- **LMP_DATE**: The date of the patient�s Last Menstrual Period. Only contains data for encounters with female patients.
- **ENC_CLOSED_YN**: A flag that signifies if this encounter is closed as of the time of the enterprise reporting extract. This column will have the value Y, N or null. Null indicates that closing the encounter does not apply, such as a future appointment.
- **ENC_CLOSED_USER_ID**: The unique ID of the system user who closed the patient encounter. This ID may be encrypted.
- **ENC_CLOSED_USER_ID_NAME**: The name of the user record. This name may be hidden.
- **ENC_CLOSE_DATE**: The date on which the patient encounter was closed.
- **LOS_MODIFIER1_ID**: The first Level of Service modifier applied to the encounter. This item will appear empty if no modifier is present.
- **LOS_MODIFIER1_ID_MODIFIER_NAME**: The name of the modifier record.
- **LOS_MODIFIER2_ID**: The second Level of Service modifier applied to the encounter. This item will appear empty if no modifier is present.
- **LOS_MODIFIER2_ID_MODIFIER_NAME**: The name of the modifier record.
- **LOS_MODIFIER3_ID**: The third Level of Service modifier applied to the encounter. This item will appear empty if no modifier is present.
- **LOS_MODIFIER3_ID_MODIFIER_NAME**: The name of the modifier record.
- **LOS_MODIFIER4_ID**: The fourth Level of Service modifier applied to the encounter. This item will appear empty if no modifier is present.
- **LOS_MODIFIER4_ID_MODIFIER_NAME**: The name of the modifier record.
- **APPT_STATUS_C_NAME**: The category value associated with the appointment status of the encounter as of the most recent enterprise reporting extract, such as 1 � Scheduled, 2 � Completed, 3 � Canceled, etc.
- **APPT_CANC_USER_ID**: The unique ID of the user who canceled the appointment.
- **APPT_CANC_USER_ID_NAME**: The name of the user record. This name may be hidden.
- **CHECKIN_USER_ID**: The unique ID of the system user who checked in the patient for this encounter. If the encounter has not been through the Check In process this field will be NULL. This ID may be encrypted.
- **CHECKIN_USER_ID_NAME**: The name of the user record. This name may be hidden.
- **HOSP_ADMSN_TIME**: The date and time that the patient was first admitted to the facility, bedded in the ED, or confirmed for an HOV for this contact, regardless of patient's base patient class.
- **HOSP_DISCHRG_TIME**: The hospital discharge date and time for this patient contact.
- **HOSP_ADMSN_TYPE_C_NAME**: The category value for the type of admission for this encounter.
- **NONCVRED_SERVICE_YN**: A flag used to indicate whether the appointment is scheduled in a service not covered by the patient's coverage benefits. The flag is set to "Y" when the service is not covered and an "N" when it is covered.
- **REFERRAL_REQ_YN**: A flag used to indicate whether an appointment requires a referral as determined by the visit coverage. This flag is set to �Y� when the appointment requires a referral. If the appointment does not require a referral, it is set to �N."
- **REFERRAL_ID**: The unique ID of the referral record linked to this appointment.
- **ACCOUNT_ID**: The ID number of the guarantor account assigned to the visit at the time it is scheduled or when it is checked in. This ID may be encrypted.
- **COVERAGE_ID**: The ID number of the coverage record assigned to the visit at the time it is scheduled or when it is checked in. This ID may be encrypted.
- **CLAIM_ID**: The unique ID of the billing system Claim record (CLM record) linked to charges associated with this visit.
- **PRIMARY_LOC_ID**: The unique ID of the patient�s primary location as of the contact date of the encounter. Note: This may not be the same as the patient�s current primary location.
- **CHARGE_SLIP_NUMBER**: The encounter form number or charge slip number assigned to this encounter. Note: The charge slip number is also stored in the financial table CLARITY_TDL. You can use this field to link to CLARITY_TDL to identify financial transactions associated with the encounter.
- **COPAY_DUE**: The dollar amount shown in the Copay Due field of the scheduling system's Check In Patient activity. This amount may be calculated by the system using the patient's coverage benefit information or be manually entered by a user. This field may also be empty if no copay amount was entered when the patient's appointment was checked in.
- **UPDATE_DATE**: The time this patient encounter was pulled into enterprise reporting.
- **HSP_ACCOUNT_ID**: The ID number of the hospital billing account assigned to the encounter.
- **ADM_FOR_SURG_YN**: Indicates whether the patient is being admitted for surgery.
- **SURGICAL_SVC_C_NAME**: The category value corresponding to the surgical service for this patient contact.
- **INPATIENT_DATA_ID**: The ID number of the record used to determine how inpatient data is stored for the encounter.
- **IP_EPISODE_ID**: The ID number of the inpatient episode of care. This includes discharges from the ED.
- **EXTERNAL_VISIT_ID**: The ID for the contact as assigned by a non-system. Usually populated by an interface.
- **CONTACT_COMMENT**: Comments entered by the provider for the contact.
- **OUTGOING_CALL_YN**: Indicates whether a call associated with a telephone encounter was initiated by the patient or by the clinic / hospital. A "Y" indicates an outgoing call placed by the clinic / hospital while an "N" indicates and incoming call from the patient.
- **DATA_ENTRY_PERSON**: This is the name of the user who created the encounter.
- **REFERRAL_SOURCE_ID**: The referral ID number of the referring physician. This physician may be from an external organization.
- **REFERRAL_SOURCE_ID_REFERRING_PROV_NAM**: The name of the referral source.
- **WC_TPL_VISIT_C_NAME**: A field used to indicate whether the patient's contact is related to workers compensation or third party liability situation.
- **CONSENT_TYPE_C_NAME**: This item describes the type of consent that was filed for a given encounter. It is a single-response customer-defined category.
- **BMI**: This is the patient's Body Mass Index, which is calculated based on the recorded height and weight.
- **BSA**: This is the patient's Body Surface Area, which is calculated based on the recorded height and weight.
- **AVS_PRINT_TM**: The instant that the After Visit Summary (AVS) was printed for this encounter.
- **AVS_FIRST_USER_ID**: Unique ID of the user who first prints out the After Visit Summary (AVS) for the encounter.
- **AVS_FIRST_USER_ID_NAME**: The name of the user record. This name may be hidden.
- **ENC_MED_FRZ_RSN_C_NAME**: The encounter medication freeze reason's category value.
- **EFFECTIVE_DATE_DT**: The date of the encounter. The returned date is handled differently depending on the contact type of the encounter: If it is a surgery encounter, the date of the surgery will be returned. If it is a Hospital encounter, Admission/Discharge/Transfer (ADT) info will be used to return an appropriate date. If ADT info cannot be found, then the  Hospital Admission date (I EPT 18850) will be returned. If the Hospital Admission Date cannot be found, the temporary admission date (I EPT 18846) will be returned..
- **DISCHARGE_DATE_DT**: The discharge date for the encounter.
- **COPAY_PD_THRU_NAME**: The method by which the copay for an appointment was paid (e.g., via MyChart, a kiosk).
- **INTERPRETER_NEED_YN**: A flag used to indicate whether a patient requires an interpreter for an encounter.
- **VST_SPECIAL_NEEDS_C_NAME**: This field captures any special needs for a visit.
- **BEN_ENG_SP_AMT**: Stores the adjudicated self-pay amount (the amount required to be paid by the patient) when determining the copay amount for the visit.
- **BEN_ADJ_COPAY_AMT**: Stores the adjudicated copy amount for the visit according to the patient's coverage benefits.
- **BEN_ADJ_METHOD_C_NAME**: Flag to indicate if and how the adjudicated copay was overridden
- **ENC_CREATE_USER_ID**: The ID number of the user who create the patient or encounter record.
- **ENC_CREATE_USER_ID_NAME**: The name of the user record. This name may be hidden.
- **ENC_INSTANT**: The instant an encounter was created
- **EFFECTIVE_DATE_DTTM**: The start date and time of an encounter. The start date is pulled from the date stored in the EFFECTIVE_DATE_DT column. The time references the first populated time in the following fields: hospital admission time (EPT 18851), hospital temporary admission time (EPT 18847), ADT arrival time (EPT 10815), and expected admission time (EPT 10300).  The SlicerDicer reporting application uses this column to determine the EffectiveStartDate of encounters.
- **CALCULATED_ENC_STAT_C_NAME**: A status flag used to  determine whether to include data from the encounter in the SlicerDicer reporting application. Statuses includes 1-Possible (e.g., the encounter is a scheduled outpatient appointment or the admission is pending) or 2-Complete (e.g., the appointment is complete, the admission is discharged).

### PAT_ENC_2
**Table**: This table supplements the PAT_ENC table. It contains additional information related to patient encounters or appointments.
- **PAT_ENC_CSN_ID**: The unique system identifier of the patient encounter. Contact serial number is unique across all patients and all contacts.
- **CONTACT_DATE**: The date on which this patient encounter took place.
- **COPAY_COINS_FLAG**: Set to 1 if copay is coinsurance.
- **CAN_LET_C_NAME**: This column links to the type of canceled appointment letter sent for this patient encounter. Some examples are "No Letter", "No Show","Cancelation Letter", etc. This category column is linked to ZC_LET.LET_C.
- **SUP_PROV_ID**: This column contains the provider ID of the supervising provider for this patient encounter.
- **SUP_PROV_C_NAME**: This column links to information about the Type of Supervising provider.
- **SUP_PROV_REV_TM**: This column contains the date and time when the supervising provider submitted his or her review
- **MEDS_REQUEST_PHR_ID**: The pharmacy identifier from which the medications were requested.
- **MEDS_REQUEST_PHR_ID_PHARMACY_NAME**: The name of the pharmacy.
- **MEDS_REQUEST_OP_C_NAME**: This column contains information about the fill option for the medication request.
- **PHYS_BP**: This contains the patient's blood pressure that was entered during the patient encounter.
- **VITALS_TAKEN_TM**: Holds the time the vitals were taken
- **PHYS_TEMP_SRC_C_NAME**: The source of the patient's temperature measurement.
- **PAT_PAIN_SCORE_C_NAME**: This column indicates how much pain the patient was in via pain score.
- **PAT_PAIN_LOC_C_NAME**: This column contains information about which body part is experiencing discomfort.
- **PAT_PAIN_EDU_YN**: This column contains information as to whether pain education questions were asked.
- **PAT_PAIN_CMT**: This column contains comments that were entered pertaining to the patient's pain
- **PAT_PAIN_SCALE_CAT**: This item stores the pain scale category under which the pain score is collected.
- **SMOKING_STATUS_C_NAME**: This simply stores information about whether the patient smokes, is quitting, etc.
- **PHYS_SPO2**: Contains the blood oxygen saturation value for this encounter.
- **SYS_GEN_LOS_ID**: This column contains the system generated Level of Service information to link to the procedures tables.
- **DOC_HX_SOURCE_C_NAME**: Stores the source of entry for the history documentation.  This category column is linked to ZC_HISTORY_SOURCE.HISTORY_SOURCE_C.
- **APPT_LET_C_NAME**: This column links to the type of appointment letter that was sent to this patient for this patient encounter. Some examples are "No Letter", "Appt Letter", etc.  This category column is linked to ZC_LET.LET_C.
- **PARENT_ENC_CSN_ID**: This item is a link to an encounter's parent encounter through the parent's contact serial number.  The contact serial number is the unique identifier for the encounter.
- **SYNC_IP_DATA_C_NAME**: This is a contact-specific flag to tell Chart Sync whether inpatient clinical data for this visit (such as medication administration or documentation flowsheet data) should be synchronized between deployments. A value of 1 (or Yes) means that inpatient clinical data has been, and will continue to be, synchronized for this visit. Note that this item can only be set for a contact whose type is (or was at some point) an inpatient admission.
- **APPTMT_LET_INST**: If an appointment letter has been printed for this patient encounter, this column will list the date and time it was printed. If multiple letters were printed, we'll list the date and time of the most recent one.
- **RESULT_LET_INST**: If a result letter has been printed for this patient encounter, this column will list the date and time it was printed. If multiple letters were printed, we'll list the date and time of the most recent one.
- **RESCHED_LET_INST**: If a reschedule letter has been printed for this patient encounter, this column will list the date and time it was printed. If multiple letters were printed, we'll list the date and time of the most recent one.
- **FOLLOW_LET_INST**: If a follow-up letter has been printed for this patient encounter, this column will list the date and time it was printed. If multiple letters were printed, we'll list the date and time of the most recent one.
- **PHYS_PEAK_FLOW**: This column contains a measurement of the flow of air from the lungs: Peak Flow. If this column contains data, the measurement was taken during the associated encounter.
- **ENC_SPEC_C_NAME**: The encounter specialty item holds which of the encounter provider's specialties should be used for billing and reporting purposes for this encounter.
- **LD_STATUS_YN**: Flag to denote if the encounter is for a mother who will deliver
- **ADT_PAT_CLASS_C_NAME**: The category value corresponding to the Admission/Discharge/Transfer (ADT) patient classification for this patient contact.
- **OTHER_BLOCK_ID**: Stores "Other" Summary Blocks (non-IP, ED, OpTime)
- **OTHER_BLOCK_TYPE_C_NAME**: Indicates the specific type of the episode summary, whose ID is stored in I EPT 1970.
- **BILL_NUM**: Billing number, often used as an identifier in downstream systems.
- **IP_DOC_CONTACT_CSN**: For Hospital Outpatient Visit (HOV) encounters, this column stores the unique contact serial number for the patient contact which is used for clinical documentation.  This can be set for appointment contacts if they are not converted to HOVs.
- **TEMP_PT_HIS_C**: This item shows the temporary patient history.
- **PRIMARY_PROCONT_ID**: The unique ID of the provider that is the primary contact for this patient encounter.
- **PRIMARY_TEAM_ID**: The unique ID of the primary Provider Care Team for this patient encounter.
- **PRIMARY_TEAM_ID_RECORD_NAME**: The name of the record.
- **MCIR_VACCINE_CODE_C_NAME**: The patient's eligibility code for Michigan's vaccination registry. This item only applies for the state of Michigan.
- **VISIT_POS_ID**: The unique ID of the facility that was the place of service for this encounter.
- **NO_INTERP_RSN_C_NAME**: This column holds the reason an interpreter is not needed for the visit (in the case of a patient who would normally require one). It is meant to be populated when the corresponding EPT 495-INTERPRETER NEEDED? value is "no".
- **CVG_ADD_DT**: The add date returned in the response message by the payor for the encounter. The add date is defined as the date that the payor added the patient as being covered.
- **FARM_WORKER_C_NAME**: The category number of the patient's farm worker status for the encounter or appointment.
- **KIOSK_HH_QUEST_ID**: The unique ID of the health history template that is assigned to the patient encounter.
- **KIOSK_HH_QUEST_ID_RECORD_NAME**: The name of the Visit Navigator (VN) History Template Definition (LQH) record.
- **HSP_ACCT_ADV_DTTM**: If the Hospital Account Advisor is turned on, this item records the date and time that the advisor's recommendation was accepted or rejected.
- **VISIT_VERIFIED_YN**: Indicates whether the visit is verified.
- **VERIF_VISIT_DT**: The current date the visit contact was verified.
- **VERIF_DATE_INIT_DT**: The initial date the visit contact was verified.
- **VERIF_USER_ID**: This collects the user ID of the user who verified the visit.
- **ENC_LACT_STAT_C_NAME**: The lactation status category ID for the patient.
- **PAT_LACT_CMNT**: The comments entered when the patient's lactation status has been edited.
- **COSIGNER_USER_ID**: The unique ID of the user who cosigned the patient's chart.
- **COSIGNER_USER_ID_NAME**: The name of the user record. This name may be hidden.
- **COSIGN_REV_INS_DTTM**: The date and time the chart was cosigned.
- **PAR_DICT_COUNTER**: The counter for partial dictation.
- **IS_LOS_UPDATE_C_NAME**: Stores the status of any Level of Service updates.
- **FORM_ID_COUNTER**: Stores the counter of form IDs.
- **CONSNT_REV_USER_ID**: The unique ID of the user who reviewed patient consent.
- **CONSNT_REV_USER_ID_NAME**: The name of the user record. This name may be hidden.
- **VISIT_PAYOR_ID**: The unique ID of the payor that is associated with this encounter.
- **VISIT_PLAN_ID**: The unique ID of the plan that is associated with this encounter.
- **SOCIO_SRC_C_NAME**: Stores the source of entry for the sociological history.
- **TEL_ENC_MSG_RGRDING**: Free-text field containing user entered information regarding a telephone encounter message.
- **MSG_PRIORITY_C_NAME**: Indicates the priority of the routed message.
- **RESEARCH_ENC_FLG_C_NAME**: Category ID of the research encounter flag used to mark the patient encounter as having all charges billed to a research study, the patient, or a mixture.  This is used for charge routing.
- **FAM_SPOUSE_NAME**: The name of the patient's spouse
- **MSG_CALLER_NAME**: The name of the caller who left this message
- **CONSENT_EXP_DATE**: This is the expiration date of any consent forms that are attached to the patient.
- **CV_ACC4_PAT_RESP_YN**: Indicates whether a patient wants identifying information to be excluded from submission to the American College of Cardiology-National Cardiovascular Data Registry's (ACC-NCDR) Catheterization and/or Percutaneous Coronary Intervention (CathPCI) registry.
- **FAMILY_MEM_PREFIX_C_NAME**: This column stores the relationship between the patient and the patient's guarantor.
- **AVS_REFUSED_DTTM**: The date and time when an end user documented that the patient declined the After Visit Summary.
- **AVS_LAST_PRINT_DTTM**: Records the instant the After Visit Summary was last printed
- **MED_LIST_UPDATE_DTTM**: If a patient's prescriptions or Facility-Administered Medications (FAMs) are updated (signed, modified, or discontinued; or other med reconciliation actions are changed) after the After Visit Summary (AVS) has been printed, this item is updated to hold a timestamp indicating the last time that such updates were made. It is left blank if no AVS has been printed yet.

### PAT_ENC_3
**Table**: This table supplements the PAT_ENC and PAT_ENC_2 tables. It contains additional information related to patient encounters or appointments.
- **PAT_ENC_CSN**: The unique contact serial number for this contact. This number is unique across all patient encounters in your system. If you use IntraConnect, this is the Unique Contact Identifier (UCI).
- **PAT_ENC_DATE_REAL**: A unique contact date in decimal format. The integer portion of the number indicates the date of contact. The digits after the decimal distinguish different contacts on the same date and are unique for each contact on that date. For example, .00 is the first/only contact, .01 is the second contact, etc.
- **CHKOUT_USER_ID**: The unique ID number of the user who completed the check out process for the patient for this encounter. If the encounter has not been checked out, this field will appear as "null." This ID may be encrypted.
- **CHKOUT_USER_ID_NAME**: The name of the user record. This name may be hidden.
- **ENC_BILL_AREA_ID**: The bill area which should be assigned to charges created from this encounter. The available bill areas to choose from will be determined based on lists in the provider and department records.
- **ENC_BILL_AREA_ID_BILL_AREA_NAME**: The record name of this bill area, financial subdivision, or financial division.
- **RX_CHG_ADMIT_FLG_C_NAME**: This item contains the status of charge suppression for the patient. 1 indicates all charges are being suppressed. 2 indicates suppressed charges are now dropped. 3 indicates some or all charges are currently being suppressed.
- **DX_UNIQUE_COUNTER**: The number of unique diagnoses associated with this patient encounter. Unique diagnoses are stored in item EPT 18425, which is extracted by the DX_UNIQUE column in the PAT_ENC_DX table.
- **HP_DEFAULTED_YN**: Whether the hospital problem was automatically populated from the list of admission diagnoses.  This column will have a Y if the problem was populated from an admission diagnosis and an N otherwise.
- **IP_CP_LAST_VAR_DTTM**: The date and time the last care plan variance was documented.
- **READY_QUT_SMOKING_C_NAME**: This column is used to indicate whether patient is ready to quit smoking.
- **COUNSELING_GIVEN_C_NAME**: This column is used to indicate whether smoking counseling is given.
- **COMMAUTO_SENDER_ID**: The unique user ID of the sender of the automatically generated communications.
- **COMMAUTO_SENDER_ID_NAME**: The name of the user record. This name may be hidden.
- **BENEFIT_ID**: The benefit record used to store discrete information about the patient's insurance benefits for this encounter.
- **PREPAY_DUE_AMT**: The amount of pre-payment that is due for this visit.
- **PREPAY_AMT_FROM_C_NAME**: The activity that set the pre-payment due amount.
- **PREPAY_PAID_AMT**: The pre-payment amount that has been collected for this visit.
- **PREADMSN_TESTING_DT**: The preadmission testing date.
- **SMK_CESS_USER_ID**: The last user to modify the Smoking Cessation items for the encounter.
- **SMK_CESS_USER_ID_NAME**: The name of the user record. This name may be hidden.
- **SMK_CESS_DTTM**: Indicates whether Instant Smoking Cessation items were modified for an encounter.
- **DO_NOT_BILL_INS_YN**: Indicates if a visit is marked as Do Not Bill Insurance.
- **SELF_PAY_VISIT_YN**: Indicates whether a visit is self-pay.
- **REFERRAL_TYPE_C_NAME**: The means by which the patient learned about the organization.
- **SCHOOL**: The patient's school.
- **COPAY_NUM_UNITS**: The number of units used to calculate the copay for this encounter.
- **COPAY_AMT_PER_UNIT**: The copay per each copay unit for this encounter.
- **COPAY_LASTCALC_DT**: The date the copay was last calculated for this encounter.
- **COPAY_OVERRIDDEN_YN**: Indicates whether the user has overridden the copay amount for this encounter.
- **OB_TOTAL_WT_GAIN**: This column contains the patient's total weight gain in ounces as of the encounter if the patient had a weight documented on the encounter and a pregnancy episode with a pregravid weight linked to the encounter.
- **MEDICAID_GROUP_NAME**: Item to store the name of a group defined by a Medicaid program.
- **STUDENT_STATUS_C_NAME**: Tracks a patient's student status for a given encounter.
- **MEDICAID_GROUP_ID**: Item to store the identifier of a group defined by a Medicaid program.
- **EXTERNAL_REF_ID**: The reference ID from an external organization for the patient visit.
- **OUTCOME_C_NAME**: The clinical outcome of an encounter.  The value of this item will then be used to determine the appropriate RTT/waiting status for the encounter. It is primarily applicable to the UK and Denmark.
- **HSPC_NO_ADM_C_NAME**: The Hospice Reason for Non-Admit category ID for the hospice episode.

### PAT_ENC_4
**Table**: This table supplements the PAT_ENC, PAT_ENC_2, and PAT_ENC_3 tables. It contains additional information related to patient encounters or appointments.
- **PAT_ENC_CSN_ID**: The unique contact serial number for this contact. This number is unique across all patient encounters in your system. If you use IntraConnect, this is the Unique Contact Identifier (UCI).
- **FAMILY_SIZE**: The number of members in the patient's family.
- **VISIT_NUMBER**: The visit number for the given contact.
- **PAT_CNCT_IND_C_NAME**: The patient contact indicator category number for the patient encounter.
- **DENTAL_STUDENT_ID**: The unique ID of the provider who is the dental student associated with the patient.
- **LOC_VISIT_ID**: The unique ID of the location that is associated with the visit.
- **COPAY_NOT_COVERED_C_NAME**: The copay not covered category number for the patient encounter.
- **COPAY_COLL_FLAG_YN**: The copay collected flag that indicates whether a copay was collected from the patient encounter.
- **COPAY_COLL_PERSON**: The unique ID number of the person who collected the patient's copay for the encounter.
- **COPAY_WAIVE_RSN_C_NAME**: The copay waive reason category number for the patient encounter.
- **COPAY_MIN_VALUE**: The value of the minimum copay.
- **COPAY_RECEIPT_NUM**: The receipt number of the copay collected.
- **BEN_ADJ_COINS_AMT**: The adjudicated coinsurance amount for the visit calculated by the benefits engine.
- **BEN_ADJ_DEDUCT_AMT**: The portion of the self-pay amount applied to the deductible for the visit.
- **PAT_HOMELESS_YN**: Indicates if a patient is homeless.
- **PAT_HOMELESS_TYP_C_NAME**: Characterizes the patients homelessness (for example chronic or sporadic)
- **PERCENTAGE_OF_FPL**: Indicates where the patient falls on the federal poverty level as a percentage.
- **MSG_RECEIVED_DTTM**: The date and time the encounter creation In Basket message was received.
- **TOBACCO_USE_VRFY_YN**: This column indicates whether the patient's tobacco usage has been verified. A Y indicates the usage was verified. An N or null indicates the tobacco usage was not verified. It extracts a virtual item, which is calculated using EPT-19202.
- **CR_TX_TYPE_C_NAME**: The transaction type category number for the encounter(E-Visit or Copay).
- **ORIG_ENC_CSN**: Holds the CSN of the encounter this Remote Consult encounter is responding to.
- **PHYS_BP_COMMENTS**: This column contains the comments entered for the last recorded blood pressure for this visit.
- **PHYS_TEMP_COMMENTS**: This column contains the comments entered for the last recorded temperature for this visit.
- **PHYS_TEMPSRC_COMNTS**: This column contains the comments entered for the last recorded temperature source for this visit.
- **PHYS_PULSE_COMMENTS**: This column contains the comments entered for the last recorded pulse for this visit.
- **PHYS_WEIGHT_COMNTS**: This column contains the comments entered for the last recorded weight for this visit.
- **PHYS_HEIGHT_COMNTS**: This column contains the comments entered for the last recorded height for this visit.
- **PHYS_RESP_COMMENTS**: This column contains the comments entered for the last recorded respirations for this visit.
- **PHYS_SPO2_COMMENTS**: This column contains the comments entered for the last recorded oxygen saturation level (SpO2) for this visit.
- **PHYS_PF_COMMENTS**: This column contains the comments entered for the last recorded peak flow for this visit.
- **INTERPRT_ASGN_CMT**: Comments regarding the interpreter assigned to the patient's contact.
- **PAT_HOUSING_STAT_C_NAME**: This item stores the patient's current housing status. This is a category list item that may contain values such as Stable/Permanent, Temporary, Unstable, or Unknown.
- **BCRA_AGE**: The patient's age at the time of the risk assessment.
- **BCRA_MENARCHE_AGE_C_NAME**: The patient's risk factor category number for the Age at Menarche breast cancer risk factor.
- **BCRA_FST_LIVBIRTH_C_NAME**: The patient's risk factor category number for the Age at First Live Birth breast cancer risk factor.
- **BCRA_FST_DEG_REL_C_NAME**: The patient's risk factor category number for the Number of Affected First Degree Relatives breast cancer risk factor. Only first degree relatives are considered.
- **BCRA_NUM_BIOPSY_C_NAME**: The patient's risk factor category number for the Number of Breast Biopsies breast cancer risk factor.
- **BCRA_ATYP_HYPLSA_C_NAME**: The patient's risk factor category number for the Presence of Atypical Hyperplasia in Breast Biopsies breast cancer risk factor.
- **BCRA_RACE_C_NAME**: The patient's risk factor category number for the Race breast cancer risk factor.
- **LB_ENC_START_DT**: This identifies the start date of a Lab Requisition encounter.
- **LB_ENC_END_DT**: This identifies the end date of a Lab Requisition encounter.
- **WAITING_LIST_ID**: The unique ID of the Waiting List record associated with this encounter. This column can be used to link to the WAITING_LIST_INFO table.
- **SUBMITTER_ID**: The submitting organization that the results for the lab orders on this encounter should be sent to.
- **SUBMITTER_ID_RECORD_NAME**: The name of the submitter record.
- **BILL_TO_SUBMITTER_C_NAME**: Flag indicating whether the submitter should be billed for any lab procedures performed.
- **SUBMITTER_ACCT_ID**: The submitter account to be used when billing laboratory procedures.
- **LB_BLNG_ENC_SRVC_DT**: This identifies the service date of the Billing encounter used for Lab Billing. The date is in the time zone of the lab department that created the encounter.
- **ECHKIN_STATUS_C_NAME**: The status of the eCheck-In for this appointment.
- **PB_VISIT_HAR_ID**: The hospital account record used by the Professional Billing system for a given contact.
- **TECHNICAL_REFERRAL_ID**: The MassHealth technical referral associated with the encounter.
- **CR_CLIENT_REF_IDNT**: Used to store the client ID returned by the copay reduction web service
- **CR_BENEFIT_REF_IDNT**: The benefit reference ID number of the patient for the current encounter.
- **CR_MESSAGE_ENGLISH**: The copay message returned by the web service in English.
- **CR_MESSAGE_SPANISH**: The copay message returned by the web service in Spanish.
- **CR_QUERY_SENT_UTC_DTTM**: Instant the copay reduction web service query was sent to the server
- **CR_RESP_RECVD_UTC_DTTM**: Specifies the instant when the response to the copay reduction web service query was received
- **CR_QUERY_ERROR**: Specifies the error received in the response to the query sent out to get the copay reduction for the current patient encounter.
- **COPAY_REDUCTION_AMT**: The amount by which the copay should be reduced for the current visit

### PAT_ENC_5
**Table**: This table supplements the PAT_ENC, PAT_ENC_2, PAT_ENC_3, and PAT_ENC_4 tables. It contains additional information related to patient encounters or appointments.
- **PAT_ENC_CSN_ID**: The unique contact serial number for this contact. This number is unique across all patient encounters in your system. If you use IntraConnect, this is the Unique Contact Identifier (UCI).
- **CONTACT_DATE**: The date of this contact in calendar format.
- **PUBLIC_HOUSING_YN**: This item tracks whether or not a patient lived in public housing at the time of a given encounter.
- **PVT_HOSP_ENC_C_NAME**: The category value corresponding to the private encounter setting for this patient contact.
- **LINK_INS_TYPE_C_NAME**: The lab insurance type category ID for the insurance type used with the ordering encounter in EpicCare Link.
- **PAT_VER_HCA_C_NAME**: Contains the patient's response on the Health Care Agent Verification screen in Welcome; either "Patient indicated data was correct" or "Patient indicated they want to discuss care decisions with a clinician."
- **EXT_GRP_IDNT**: This column holds appointment group identifiers assigned by external systems. If two appointments have the same external group identifier, they were checked in as a group, and they will be treated as a group in Epic.
- **EXT_GRP_SRC_C_NAME**: Holds the source of an external group identifier in EXT_GRP_IDNT. If two rows have the same value for their external group source, the same external system grouped the appointments.
- **PREPAY_SET_BY_USER_YN**: This item will be set to Yes if the prepay due for this visit was manually set by a user.
- **PREPAY_UPDATE_USER_ID**: User who last updated the prepay due amount.
- **PREPAY_UPDATE_USER_ID_NAME**: The name of the user record. This name may be hidden.
- **PREPAY_UPDATE_INST_DTTM**: The last instant the prepay due for the visit was updated.
- **PREPAY_CALC_SCENARIO**: Stores the scenario/reason why the corresponding payment needs to be collected upfront from the patient.
- **AUTHCERT_ID**: The unique ID of the auth/cert associated with the patient contact.
- **ED_REF_CALLBAK_YN**: Whether a referring provider requests a call back from the ED physician at the end their visit
- **ED_REF_CALLBAK_P_ID**: Provider that is referring the patient to the ED
- **ED_REF_CALLBAK_C_ID**: Location the provider is being referred to the ED from
- **ED_REF_CALLBAK_NUM**: Phone number to contact the referring provider at after ED visit
- **IS_ON_DEMAND_VV_YN**: Denotes whether this contact is an on-demand video visit.
- **ATTR_DEPARTMENT_ID**: The unique ID of the department that is associated with the encounter.
- **PAT_DTREE_ANSWER_ID**: Stores the decision tree that was completed by the patient which resulted in this encounter being created.
- **PREPAY_DISCNT_AMT**: Stores the total amount that was discounted because a patient paid early.
- **PREPAY_DISCNT_PCT**: Stores the percent that was used to calculate the prepay discounted amount.
- **PREPAY_PROPOSED_DISCNT_AMT**: Stores what the prepay discount would be if it applied.
- **PREPAY_DISCNT_CALC_RULE_ID**: Stores the rule that was used to determine the prepay discount percent.
- **PREPAY_DISCNT_CALC_RULE_ID_RULE_NAME**: The name of the rule.
- **PREPAY_DISCNT_CALC_PCT**: Stores the system calculated percent for a prepay discount.
- **PREPAY_DISCNT_OVRIDE_AMT**: If a user overrides the prepay discount amount, the override will be stored here and we will no longer use rules to determine the prepay discount.
- **PREPAY_DISCNT_OVRIDE_PCT**: If a user overrides the prepay discount percent, the override will be stored here and we will no longer use rules to determine the prepay discount.
- **PREPAY_DISCNT_OVRIDE_USER_ID**: If a user overrides the prepay discount, this will store the user who made the override.
- **PREPAY_DISCNT_OVRIDE_USER_ID_NAME**: The name of the user record. This name may be hidden.
- **PREPAY_DISCNT_OVRIDE_CMT**: If a user overrides the prepay discount and adds a comment about why they did so, the comment will be stored here.
- **PREPAY_DISCNT_OVRIDE_DTTM**: If a user overrides the prepay discount, this will store the instant it was overridden. This item is mainly used for reference purposes.
- **EVISIT_STATUS_C_NAME**: The current status of the e-visit encounter.

### PAT_ENC_6
**Table**: This table supplements the PAT_ENC, PAT_ENC_2, PAT_ENC_3, PAT_ENC_4, and PAT_ENC_5  tables. It contains additional information related to patient encounters or appointments.
- **PAT_ENC_CSN_ID**: The unique contact serial number for this contact. This number is unique across all patient encounters in your system. If you use IntraConnect, this is the Unique Contact Identifier (UCI).
- **PAT_ENC_DATE_REAL**: A unique contact date in decimal format. The integer portion of the number indicates the date of contact. The digits after the decimal distinguish different contacts on the same date and are unique for each contact on that date. For example, .00 is the first/only contact, .01 is the second contact, etc.
- **CONTACT_DATE**: The date of this contact in calendar format.
- **LINKED_ENC_CSN**: The unique contact serial number of the visit that represents the official visit. Intended for (FINLAND) ad hoc encounters that need to be associated with an official visit.
- **LMP_PRECISION_C_NAME**: The uncertainty of the last menstrual period date stored in the PAT_ENC.LMP_DATE column.
- **PLANNED_BILL_AREA_ID**: Used to track what the bill area was for an appointment at the time of check in.
- **PLANNED_BILL_AREA_ID_BILL_AREA_NAME**: The record name of this bill area, financial subdivision, or financial division.
- **BCRA_BRCA_GENE_MUT_C_NAME**: The patient's risk factor category number for the Presence of BRCA 1/2 Mutation breast cancer risk factor.
- **SVC_TARGET_EFFORT_YN**: Flag to indicate that additional effort was needed on behalf of staff to work this encounter in order to meet service targets.
- **OUTPAT_VISIT_GRP_C_NAME**: Used to indicate additional visit type information for reporting purposes.
- **PSYCH_ARRIVAL_C_NAME**: Indicates the method of arrival for the patient for psychiatric care.
- **PLAN_RECUR_TREAT_YN**: Indicates whether the visit is part of a planned recurring treatment period.
- **HUS_VISIT_TYPE_C_NAME**: Additional visit type information required for HUS visits for reporting purposes.
- **SOCIAL_SRVC_AREA_C_NAME**: Indicates the social care service area for the visit.
- **EXT_LTC_PAT_YN**: Indicates whether a patient is a long term care patient at an external organization.
- **VETERAN_ENC_MED_CVG_C_NAME**: This holds the medical coverage level for a given patient encounter. The medical coverage denotes the level of coverage a patient is using for a given encounter. The coverage level determines how much the patient will be billed. This column is frequently used to link to the ZC_VETERAN_MED_CVG table.
- **VETERAN_BILLING_CODE_C_NAME**: This holds the veteran billing code for a given patient encounter. The billing code denotes the type of appointment that was given which in turns determines how much the patient should be billed. This column is frequently used to link to the ZC_VETERAN_BILLING_CODE table.
- **ED_REF_CALLBAK_D_ID**: The ID number of the department from which the patient is being referred to the ED.
- **RFV_USED_TO_SCHED_C_NAME**: Stores the reason for visit the user selected to schedule an appointment through MyChart.
- **BMI_PERCENTILE**: This item stores the patient's BMI percentile. This item will be null for ages greater than 20, and is calculated based on the patient's height, weight, and sex.
- **CREATION_ORD_ID**: The ID number of the order which created the patient contact.
- **EXT_TX_STATUS_C_NAME**: An optional item used to document the encounter's External Transportation Status/Needs. There is no standard functionality that is driven by this item. This item can be used to drive reporting, confirmation errors, or WQ activities.
- **EXT_TX_STATUS_CMT**: An optional item used to document the encounter's External Transportation Comments. There is no standard functionality that is driven by this item. This item can be used to driver reporting, confirmation errors, or WQ activities.
- **EXT_ACCM_STATUS_C_NAME**: An optional item used to document the encounter's External Accommodation Status/Needs. There is no standard functionality that is driven by this item. This item can be used to driver reporting, confirmation errors, or workqueue activities.
- **EXT_ACCM_STATUS_CMT**: An optional item used to document the encounter's External Accommodation Comments. There is no standard functionality that is driven by this item. This item can be used to driver reporting, confirmation errors, or workqueue activities.
- **GAIL_LIFETIME_RISK**: This item stores the patient's most recent Gail lifetime risk score from either I EPT 29088 or I EPT 29095.
- **GAIL_5_YR_RISK**: This item stores the patient's most recent Gail 5-year risk score from either I EPT 29088 or I EPT 29095.
- **SG_AT_RISK_IND_C_NAME**: Stores the at risk indicator for a specific visit.
- **SG_FC_STATUS_C_NAME**: Stores the financial counselling status for a specific visit.
- **ELIG_PLAN_SELECT_YN**: This item indicates if an eligibility plan is currently selected for this encounter.
- **SG_MOH_URGENCY_C_NAME**: Used to indicate whether an appointment is urgent or non-urgent for Ministry of Health regulatory reporting.
- **SG_NAMED_REFERRAL_YN**: Used for validation of the patient class and regulatory reporting for whether a patient was referred to a particular provider.
- **SG_PAT_REQUEST_YN**: Used to indicate whether a patient requested to see a particular doctor and thus should be a private patient.
- **SG_TREATMENT_PROG_C_NAME**: Used to indicate the type of service programme that the appointment is assigned to.
- **SG_APPT_RATIONALE_C_NAME**: Used to indicate whether an appointment was the earliest possible, at a patient request, at a doctor request, or force booked. This drives regulatory reporting functionality.
- **EVISIT_RFV_C_NAME**: The category value of the reason for the e-visit. This number links to the value stored in the ON_DEMAND_VIDEO_VISIT_C of the ZC_ON_DEMAND_VIDEO_VISIT table.
- **EVISIT_YN**: Indicates whether this encounter is an E-Visit. This will be set only for appointment-based E-Visits.
- **EVISIT_TLH_ALLOWED_SUBLOC_C_NAME**: The sublocation where the patient indicated they were currently located for a video visit or an e-visit. This information comes from a category value stored in I SER 32510.
- **EVISIT_TLH_ALLOWED_LOC_C_NAME**: The country where the patient indicated they were currently located for a video visit or an e-visit. This information comes from a category value stored in I ECT 70150.
- **APPT_AUTH_STATUS_C_NAME**: The authorization status of an appointment based on the information stored in any authorization records linked to an appointment (EPT-23025).
- **EVISIT_NEW_STATUS_C_NAME**: The current workflow status of an e-visit encounter. Values include 1-In Progress, 2-Submitted, 3-Under Review, 4-Complete, 5-Expired, 6-Returned to Patient, and 7-Cancelled
- **LAB_RESP_USER_ID**: The unique ID of the phlebotomist (EMP) currently responsible for the patient's lab draws for this encounter.
- **LAB_RESP_USER_ID_NAME**: The name of the user record. This name may be hidden.
- **EXT_MEDS_UPD_INST_UTC_DTTM**: Contains the most recent instant of update for external medications in external orders encounters.
- **INTF_PRIMARY_PAT_ENC_CSN_ID**: Contains the CSN of the primary interface contact for this encounter.
- **OVERRIDE_BCRA_NUM_BIOPSY_C_NAME**: The override value for the number of biopsies. The override value is used in the calculation of the Gail model risk score.
- **OVERRIDE_BCRA_RACE_C_NAME**: The override value for patient race. The override value is used in the calculation of the Gail model risk score.
- **OVERRIDE_GAIL_FACTOR_USER_ID**: The user who overrode the factors for the Gail model.
- **OVERRIDE_GAIL_FACTOR_USER_ID_NAME**: The name of the user record. This name may be hidden.
- **OVERRIDE_GAIL_FACTOR_DTTM**: The instant when the Gail factors were overridden.
- **VETERAN_COVERAGE_ENC_YN**: Indicates whether the patient's encounter is expected to be covered by their VA coverage
- **ADJUD_TO_PHARMACY_COVERAGE_YN**: Indicates whether we are adjudicating one or more of the medications administered to the patient to a pharmacy coverage. 'Y' indicates that medications will be adjudicated. 'N' or NULL indicate that no medications will be adjudicated to a pharmacy coverage.

### PAT_ENC_7
**Table**: This table supplements the PAT_ENC, PAT_ENC_2, PAT_ENC_3, PAT_ENC_4, PAT_ENC_5, and PAT_ENC_6 tables. It contains additional information related to patient encounters or appointments.
- **PAT_ENC_CSN_ID**: The unique contact serial number for this contact. This number is unique across all patient encounters in your system. If you use IntraConnect, this is the Unique Contact Identifier (UCI).
- **PAT_ENC_DATE_REAL**: A unique contact date in decimal format. The integer portion of the number indicates the date of contact. The digits after the decimal distinguish different contacts on the same date and are unique for each contact on that date. For example, .00 is the first/only contact, .01 is the second contact, etc.
- **CONTACT_DATE**: The date of this contact in calendar format.
- **NOTIFY_REP_ADMSN_C_NAME**: Indicates whether a patient wants to have a family member or representative notified of their admission.
- **REP_NOTIFIED_C_NAME**: Indicates whether a patient's family or representative is notified of their admission.
- **NOTIFY_REP_COMMENTS**: Information about notifying a patient's family or representative of their admission.
- **NOTIFY_PCP_ADMSN_C_NAME**: Indicates whether a patient wants to have their PCP notified of their admission.
- **PCP_NOTIFIED_C_NAME**: Indicates whether a patient's PCP is notified of their admission.
- **NOTIFY_PCP_COMMENTS**: Information about notifying a patient's PCP of their admission.
- **ROC_PLANNING_PAT_ENC_CSN_ID**: Stores the unique contact serial number of the resumption of care planning contact linked to this contact
- **NUM_PREV_EPSD_C_NAME**: Stores the number of previous consecutive episodes category ID for the patient
- **SPEC_ORD_RSLT_NOT_AUTO_RLS_YN**: It stores whether the order results of all the specimen orders created in the Specimens navigator section are automatically released to MyChart.
- **RECENTLY_AT_SCHOOL_C_NAME**: Whether the patient has recently been physically present at the school they work at or attend
- **LMP_COMMENT**: Free-text comments about the last menstrual period
- **CONTACT_NUM**: The system-assigned number used to uniquely identify each of a given patient's encounters.
- **ABN_REQUIRED_YN**: Indicates whether an ABN required for this patient encounter.
- **IS_ABN_SIGNED_C_NAME**: Indicates whether the ABN has been signed for this encounter.
- **MSP_IS_MEDICARE_HMO_C_NAME**: Indicates whether the patient is covered by a Medicare HMO for this encounter. Used for MSPQ.
- **REG_COMMENTS_DATE**: The date corresponding to the comment in PAT_ENC_REG_CMT table for this encounter.
- **AUTO_MSG_DISABLED_YN**: Whether messages that are automatically sent to a patient's companions should be disabled.
- **DONT_AUTO_LINK_YN**: Whether auto-linking should be disabled for a given encounter.
- **RSN_FOR_NO_INC_MSG_C_NAME**: The reason for no inc. message Category ID for the patient encounter. Indicates the reason there is no incomplete message to send for the encounter.
- **HAS_HORMONE_DATA_YN**: Whether the hormone history information is present on the given encounter.
- **MEDS_REQUEST_LWS_ID**: This is the destination to use with the encounter primary pharmacy stored in EPT 17162.
- **EVISIT_SUBMITTED_DTTM**: The instant in system local time at which the patient submitted the E-Visit.  If conversion 888449 has not completed, this column might not have data for some submitted E-Visits. Consider using V_PAT_ENC_EVISIT.EVISIT_SUBMITTED_DTTM instead, which will always have a submission time for all submitted E-Visits. Talk to your operational database administrator or Epic representative to determine whether the conversion has finished.
- **EVISIT_TURNAROUND_IN_MINUTES**: The amount of time, in minutes, between when a patient submitted the E-Visit and when a provider signed the encounter. If the encounter is not an E-Visit, or if the E-Visit was not both submitted and signed, then this column will be NULL.
- **PREGNANCY_INTENTION_C_NAME**: The patient's stated willingness to initiate a pregnancy within the subsequent year
- **PREGNANCY_COUNSELED_YN**: Whether the patient received counselling on how to achieve pregnancy
- **BIRTH_CONTROL_COUNSELED_YN**: Whether the patient wanted to discuss pregnancy prevention
- **RSN_NO_BCM_COUNSELING_C_NAME**: The reason why the patient did not want to discuss pregnancy prevention
- **INTAKE_RSN_NO_CONTRACEPTIVE_C_NAME**: The reason the patient has not been using contraceptives as of the start of the encounter
- **CONTRACEPTIVE_DELIVERY_C_NAME**: The method used to deliver or implement agreed contraceptives
- **EXIT_RSN_NO_CONTRACEPTIVE_C_NAME**: The reason for not agreeing during the encounter to implement contraceptives
- **IS_VAP_DECLINED_YN**: Indicates whether this Visit Auto Pay proposal has been declined or not.  This is when a hyperspace user indicates that the patient has declined Visit Auto Pay.
- **EPISODE_UPDATE_EFF_DATE**: The date when the information in this episode update encounter will start being used.
- **EPISODE_UPD_CREAT_RSN_C_NAME**: The category ID for the reason the episode update encounter was created.
- **VISIT_MSG_DECLINE_YN**: Whether the patient has declined visit messaging for this encounter.
- **BILL_FOR_DENIAL_YN**: The category ID for the decision on if Medicare should be billed for denial for this encounter.

### PAT_ENC_ADMIT_DX_AUDIT
**Table**: This tables stores previous instances in which the admission diagnosis was populated or deleted for an encounter.
- **PAT_ENC_CSN_ID**: The unique contact serial number for this contact. This number is unique across all patient encounters in your system. If you use IntraConnect, this is the Unique Contact Identifier (UCI).
- **LINE**: The line number for the information associated with this contact. Multiple pieces of information can be associated with this contact.
- **ADMISSION_DX_EDIT_UTC_DTTM**: Stores the instant that a change to the Inpatient Admission Diagnosis (I EPT 10150/10151) was made.

### PAT_ENC_APPT
**Table**: The PAT_ENC_APPT table contains basic information about the appointment records in your system. Since one patient encounter can be an appointment with multiple providers and resources (joint appointment), the primary key of this table comprises PAT_ENC_CSN_ID, and LINE in which LINE is used to identify each provider within the appointment.
- **PAT_ENC_CSN_ID**: The unique serial number for this encounter. This number is unique across all patients and encounters in the system.
- **LINE**: Used to identify the provider within one appointment.
- **CONTACT_DATE**: The date on which the encounter took place.
- **DEPARTMENT_ID**: The unique ID of the department in which the appointment will take place.
- **PROV_START_TIME**: The date and time that the appointment is scheduled to begin with this provider, such as 01/10/2000 14:45.

### PAT_ENC_BILLING_ENC
**Table**: This table contains encounter-specific data related to Billing Encounters.
- **PAT_ENC_CSN_ID**: The unique contact serial number for this contact. This number is unique across all patient encounters in your system. If you use IntraConnect, this is the Unique Contact Identifier (UCI).
- **CONTACT_DATE**: The date of this contact in calendar format.
- **CM_CT_OWNER_ID**: The Community ID (CID) of the instance that owns this contact. This is only populated if you use IntraConnect.
- **POS_TYPE_OVRIDE_C_NAME**: Place of service type override for Billing Encounters. If empty, the place of service type is determined by the type set in the facility record (EAF) contained in the Visit Place of Service (I EPT 5617).
- **BILL_ENC_IS_VOID_YN**: Indicates whether a Billing Encounter has been marked as voided. For example, if a user creates a Billing Encounter for a patient in error, the user can correct that error by marking the Billing Encounter as voided.
- **BILLING_ENC_TYPE_C_NAME**: The type of billing encounter this represents for an encounter of type 99-Billing Encounter. Among other things, this informs how the encounter date is determined.
- **BILLING_ENC_START_DATE**: The start date of a multi-day billing encounter.
- **BILLING_ENC_END_DATE**: The end date of a multi-day billing encounter.

### PAT_ENC_CALL_DATA
**Table**: This table contains miscellaneous data about clinical calls, such as the patient following the Care Advice.
- **CONTACT_DATE**: The date for the encounter in standard date format.
- **PAT_ENC_CSN_ID**: A unique serial number for this encounter. This number is unique across all patients and encounters in the system.

### PAT_ENC_CC_AUTO_CHG
**Table**: This table contains data related to a patient's encounter, specifically the patient giving consent for the charges linked to this encounter to be automatically paid by the patient's credit card.
- **PAT_ENC_CSN_ID**: The unique contact serial number for this contact. This number is unique across all patient encounters in your system. If you use IntraConnect, this is the Unique Contact Identifier (UCI).
- **CONTACT_DATE**: The date of this contact in calendar format.
- **CONSENT_YN**: Indicates if the patient gave consent to have a credit card charged for self-pay portion of visit.

### PAT_ENC_CURR_MEDS
**Table**: The PAT_ENC_CURR_MEDS table enables you to report on current (as well as active) medications per encounter as listed in clinical system.
- **PAT_ENC_DATE_REAL**: This is a numeric representation of the date of this encounter in your system. The integer portion of the number specifies the date of the encounter. The digits after the decimal point indicate multiple visits on one day.
- **LINE**: The line number for the information associated with this contact. Multiple pieces of information can be associated with this contact.
- **PAT_ENC_CSN_ID**: The unique contact serial number for this contact. This number is unique across all patient encounters in your system. If you use IntraConnect, this is the Unique Contact Identifier (UCI).
- **CONTACT_DATE**: The date of this contact in calendar format.
- **CURRENT_MED_ID**: The current medication order ID for the encounter.
- **IS_ACTIVE_YN**: A Yes/No flag indicating patient is taking the medication or not.

### PAT_ENC_DISP
**Table**: The PAT_ENC_DISP table contains information from the Follow-up action on the Visit Navigator tab for the ambulatory clinical system. This information specifies how and when a patient and provider should follow up with each other after an encounter. This table also contains information about the level of service (LOS) associated with the encounter.
- **PAT_ENC_DATE_REAL**: A unique, internal contact date in decimal format. The integer portion of the number indicates the date of the contact. The digits after the decimal distinguish different contacts on the same date and are unique for each contact on that date. For example, .00 is the first/only contact, .01 is the second contact, etc.
- **CONTACT_DATE**: The date of this contact in calendar format.
- **PAT_ENC_CSN_ID**: The unique contact serial number for this contact. This number is unique across all patient encounters in your system. If you use IntraConnect, this is the Unique Contact Identifier (UCI).
- **DX_FOLLOWUP_C_NAME**: This column typically stores special instructions that the lab should follow when processing this patient's lab orders. However, some organizations choose to store other information in this column.
- **ORDER_INSTR_C_NAME**: This column typically stores the method of follow-up used to communicate order results with the patient. However, some organizations choose to store other information in this column.
- **LOS_DROPPED_C_NAME**: The category number that indicates whether the Level of Service was dropped for this encounter. The category value will be equal to "pending" only while it is in the orders queue.
- **LOS_AUTH_PROV_ID**: The authorizing provider as entered from the Level of Service option in the Visit Navigator
- **LOS_TRIG_ERR_YN**: Whether or not there was an LOS trigger error when dropping the charge.
- **LOS_NEW_OR_EST_C_NAME**: The category number that indicates whether the patient is a new (first time being seen) or established patient.
- **LOS_HX_LEVEL_C_NAME**: The category number for how extensively the patient's history was discussed as entered in the Level of Service calculator.
- **LOS_EXAM_LEVEL_C_NAME**: The category number for the extent of the exam as entered in the Level of Service calculator.
- **LOS_MDM_LEVEL_C_NAME**: The category number for the complexity of the medical decision-making in this encounter as entered in the Level of Service calculator.
- **LOS_NO_CHG_RSN_C_NAME**: The reason that a charge was not triggered for a level of service. This item being populated does not imply any issues with system integrity or system build; it will be set both for legitimate reasons that a charge was not triggered as well as non-legitimate reasons.
- **LOS_SERV_PROV_ID**: Servicing Provider for Physician LOS Charge

### PAT_ENC_DOCS
**Table**: The PAT_ENC_DOCS table contains information about each document that is attached to a patient encounter, including scanned and electronically signed documents.
- **PAT_ID**: The unique ID of the patient record for this row. This column is frequently used to link to the PATIENT table.
- **PAT_ENC_DATE_REAL**: A unique, internal contact date in decimal format. The integer portion of the number indicates the date of the contact. The digits after the decimal distinguish different contacts on the same date and are unique for each contact on that date. For example, .00 is the first/only contact, .01 is the second contact, etc.
- **LINE**: The line number for the information associated with this contact. Multiple pieces of information can be associated with this contact.
- **DOC_INFO_ID**: The ID of the document for this patient encounter.
- **PAT_ENC_CSN_ID**: The unique contact serial number for this contact. This number is unique across all patient encounters in your system. If you use IntraConnect, this is the Unique Contact Identifier (UCI).
- **ADT_CONTACT_YN**: States whether or not the document is attached to an Admission, Discharge, Transfer, or Leave of Absence (ADT) Contact.

### PAT_ENC_DX
**Table**: The patient encounter diagnosis table contains one record for each diagnosis associated with each encounter level of service. This table will contain all diagnoses specified on the Order Summary screen.
- **PAT_ENC_DATE_REAL**: This is a numeric representation of the date of this encounter in your system. The integer portion of the number specifies the date of the encounter. The digits after the decimal point indicate multiple visits on one day.
- **LINE**: The line number of the diagnosis within the encounter. This is the second column in the primary key and uniquely identifies this diagnosis on the encounter.
- **CONTACT_DATE**: The contact date of the encounter associated with this diagnosis. Note: There may be multiple encounters on the same calendar date.
- **PAT_ENC_CSN_ID**: A unique serial number for this encounter. This number is unique across all patients and encounters in the system.
- **DX_ID**: The unique ID of the diagnosis record associated with the patient encounter. Note: This is NOT the ICD9 diagnosis code. It is an internal identifier that is typically not visible to a user.
- **ANNOTATION**: The annotation (description) text entered for this diagnosis by the clinical system user. This field is NULL if no annotation was entered during the encounter.  Order entry in clinical system limits this field to 160 characters.
- **DX_QUALIFIER_C_NAME**: The category value for the diagnosis qualifier. This field is null if no qualifier was entered.
- **PRIMARY_DX_YN**: This is a one character field that indicates whether this diagnosis was the primary diagnosis for the encounter. If the diagnosis was the primary this field will have a value of 'Y' otherwise it will have a value of 'N'.
- **COMMENTS**: Any text comment associated with the encounter diagnosis. This field is NULL if no comment was provided.
- **DX_CHRONIC_YN**: Stores the chronic flag for a diagnosis.
- **DX_STAGE_ID**: The stage for the diagnosis.
- **DX_UNIQUE**: Unique identifier given when a diagnosis is added to the encounter diagnosis list.
- **DX_ED_YN**: Definitively identifies an encounter diagnosis (I EDG 18400) as being an ED clinical impression. This is important to differentiate ED diagnoses from diagnoses filed to the same item as in the IP setting.
- **DX_LINK_PROB_ID**: Stores the problem ID of the linked problem.

### PAT_ENC_ELIG_HISTORY
**Table**: This table holds information about actions taken on a patient's pharmacy benefit eligibility information.
- **PAT_ENC_CSN_ID**: The unique contact serial number for this contact. This number is unique across all patient encounters in your system. If you use IntraConnect, this is the Unique Contact Identifier (UCI).
- **LINE**: The line number for the information associated with this contact. Multiple pieces of information can be associated with this contact.
- **PAT_ID**: The unique ID of the patient record for this row. This column is frequently used to link to the PATIENT table.
- **PAT_ENC_DATE_REAL**: A unique contact date in decimal format. The integer portion of the number indicates the date of contact. The digits after the decimal distinguish different contacts on the same date and are unique for each contact on that date. For example, .00 is the first/only contact, .01 is the second contact, etc.
- **CONTACT_DATE**: The date of this contact in calendar format.
- **CM_CT_OWNER_ID**: The Community ID (CID) of the instance that owns this contact. This is only populated if you use IntraConnect.
- **ELIG_ACTION_C_NAME**: This item holds the action performed on the patient's eligibility.
- **ELIG_PLAN_INDEX**: This item indicates which eligibility plan the action was taken on. It is an index into the patient (EPT) 42010 group.
- **ELIG_HX_USER_ID**: This item holds the user who performed the action on the patient's eligibility information.
- **ELIG_HX_USER_ID_NAME**: The name of the user record. This name may be hidden.
- **ELIG_HX_INST_UTC_DTTM**: This item holds the instant that the eligibility action was performed.

### PAT_ENC_HSP
**Table**: This table is the primary table for hospital encounter information. A hospital encounter is a contact in the patient record created through an ADT workflow such as preadmission, admission, ED Arrival, discharge, and hospital outpatient visit (HOV) contacts. These contact types have the ADT flag (I EPT 10101) set to 1. This table excludes all other contacts.
- **PAT_ENC_CSN_ID**: The unique contact serial number for this contact. This number is unique across all patient encounters in your system. If you use IntraConnect, this is the Unique Contact Identifier (UCI).
- **ADT_PAT_CLASS_C_NAME**: The category value corresponding to the patient classification for this patient contact.
- **ADT_PATIENT_STAT_C_NAME**: The category value corresponding to the patient status for this patient contact.
- **LEVEL_OF_CARE_C_NAME**: The category value corresponding to the level of care for this patient contact.
- **PENDING_DISCH_TIME**: The date and time of the pending discharge for this patient contact.
- **DISCH_CODE_C_NAME**: The category value corresponding to the discharge code for this patient contact.
- **ADT_ATHCRT_STAT_C_NAME**: The category value corresponding to the authorization/certification status for this patient contact.
- **PREADM_UNDO_RSN_C_NAME**: The category value corresponding to the preadmission undo reason for this patient contact.
- **EXP_ADMISSION_TIME**: The date and time of the expected admission for this patient contact.
- **EXP_LEN_OF_STAY**: The expected length of stay in days of the admission for this patient contact.
- **EXP_DISCHARGE_DATE**: The date of expected discharge of the admission for this patient contact.
- **ADMIT_CATEGORY_C_NAME**: The category value corresponding to the admission category for this patient contact.
- **ADMIT_SOURCE_C_NAME**: The category value corresponding to the admission source for this patient contact.
- **TYPE_OF_ROOM_C_NAME**: The category value corresponding to the type of room requested for this patient contact.
- **TYPE_OF_BED_C_NAME**: The category value corresponding to the type of bed requested for this patient contact.
- **RSN_FOR_BED_C_NAME**: The category value corresponding to the reason for the type of bed requested for this patient contact.
- **DELIVERY_TYPE_C_NAME**: The category value corresponding to the delivery type of the child for this patient contact.
- **LABOR_STATUS_C_NAME**: The category value corresponding to the labor status for this patient contact.
- **ER_INJURY**: Free text description of injury for this patient contact.
- **ADT_ARRIVAL_TIME**: The date and time of arrival for this patient contact.
- **ADT_ARRIVAL_STS_C_NAME**: The category value corresponding to the arrival status for this patient contact.
- **HOSP_ADMSN_TIME**: The date and time that the patient was first admitted to the facility, bedded in the ED, or confirmed for an HOV for this contact, regardless of patient's base patient class.
- **ADMIT_CONF_STAT_C_NAME**: The category value corresponding to the (admission) confirmation status for this patient contact.
- **HOSP_DISCH_TIME**: The hospital discharge date and time for this patient contact.
- **HOSP_ADMSN_TYPE_C_NAME**: The category value corresponding to the admission type for the patient contact.
- **ROOM_ID**: The ID number of the room for the most recent location of the patient for this patient contact.
- **HOSP_SERV_C_NAME**: The category value corresponding to the hospital service for this patient contact.
- **MEANS_OF_DEPART_C_NAME**: The category value corresponding to the means of departure of the patient for this patient contact.
- **DISCH_DISP_C_NAME**: The category value corresponding to the discharge disposition for this patient contact.
- **DISCH_DEST_C_NAME**: The category value corresponding to the discharge destination for this patient contact.
- **TRANSFER_FROM_C_NAME**: The category value corresponding to the transfer from location for this patient contact.
- **MEANS_OF_ARRV_C_NAME**: The category value corresponding to the means of arrival of the patient for this patient contact.
- **ACUITY_LEVEL_C_NAME**: The category value corresponding to the acuity level for this patient contact.
- **HOSPIST_NEEDED_YN**: Indicates whether a hospitalist needs to be assigned to the patient for this contact.
- **ACCOMMODATION_C_NAME**: The category value corresponding to the room accommodation for this patient contact.
- **ACCOM_REASON_C_NAME**: The category value corresponding to the reason for the room accommodation for this patient contact.
- **INPATIENT_DATA_ID**: The unique ID of the Inpatient Data Store record.
- **PVT_HSP_ENC_C_NAME**: The category value corresponding to private encounter setting for this patient contact.
- **ED_EPISODE_ID**: The unique ID of the Inpatient episode record for the ED visit.
- **ED_DISPOSITION_C_NAME**: The disposition of the patient when discharged from the ED.
- **ED_DISP_TIME**: The date and time that the disposition was entered.
- **FOLLOWUP_PROV_ID**: The follow-up provider for the patient.
- **PROV_CONT_INFO**: The contact information for the patient's follow-up provider.
- **OSHPD_ADMSN_SRC_C_NAME**: Office of Statewide Health Planning and Development (OSHPD) Source of Admission
- **OSHPD_LICENSURE_C_NAME**: Office of Statewide Health Planning and Development (OSHPD) Licensure of Site
- **OSHPD_ROUTE_C_NAME**: Office of Statewide Health Planning and Development (OSHPD) Route of Admission
- **INP_ADM_DATE**: Date-time of the inpatient admission. This is the date/time during the hospital encounter when the patient first received a base patient class of inpatient. This can be different than the value for the admission date if the patient was assigned an emergency or outpatient base patient class.
- **COPY_TO_PCP_YN**: This item will indicate whether the PCP effective for the patient should be notified upon a pre-determined system event.
- **ADOPTION_CASE_YN**: Item to store whether the current contact is related to an adoption case.
- **PREOP_TEACHING_C_NAME**: This item describes whether a patient has been offered or given any pre-operative teaching.
- **PREOP_PRN_EVAL_C_NAME**: This is a category item that describes whether a patient has been offered or given a pre-operative nurse practitioner evaluation.
- **PREOP_PH_SCREEN_C_NAME**: This is a category list that describes whether a patient has been offered or given a pre-operative phone screening.
- **LABOR_ACT_BIRTH_C_NAME**: The category value corresponding to the actual birth status of the delivery.
- **LABOR_FEED_TYPE_C_NAME**: The category value corresponding to the infant feeding type during the delivery process
- **PROC_SERV_C_NAME**: Procedure Based Service Category
- **ED_DEPARTURE_TIME**: Date and time the patient left the ED.
- **TRIAGE_DATETIME**: The date and the time the patient was triaged.
- **TRIAGE_STATUS_C_NAME**: The triage status.
- **INP_ADM_EVENT_ID**: The event record for the hospital encounter where the patient first received a base patient class of inpatient, making them an inpatient.
- **INP_ADM_EVENT_DATE**: Instant of the event creation of the event which caused a patient to become an inpatient patient class.
- **INP_DWNGRD_EVNT_ID**: Column to return the event ID of the event that last downgrades the patient from an inpatient patient class to a non-inpatient patient class.
- **INP_DWNGRD_DATE**: Column that returns the effective date and time of a patients latest downgrade from an inpatient patient class.
- **INP_DWNGRD_EVNT_DT**: Column to return the event date and time of the last event that downgrades a patient from an inpatient patient class to a non-inpatient patient class.
- **OP_ADM_DATE**: The date and time during the hospital encounter when the patient first received a base patient class of outpatient.
- **EMER_ADM_DATE**: The date and time during the hospital encounter when the patient first received a base patient class of emergency.
- **OP_ADM_EVENT_ID**: The event record for the hospital encounter where the patient first received a base patient class of outpatient.
- **EMER_ADM_EVENT_ID**: The event record for the hospital encounter where the patient first received a base patient class of emergency.
- **PREREG_SOURCE_C_NAME**: Preregistration source value.
- **HOV_CONF_STATUS_C_NAME**: This item stores a flag to prevent HOVs from being closed by the end of day batch.
- **RELIG_NEEDS_VISIT_C_NAME**: Used to track a patient's visit-specific religious needs.
- **DISCHARGE_CAT_C_NAME**: General Category Item for Discharges
- **EXP_DISCHARGE_TIME**: The time of expected discharge of the admission for this patient contact.
- **BILL_ATTEND_PROV_ID**: Billing Attending Provider - The attending provider that is or will be specified on the hospital account and claim when billed.
- **OB_LD_LABORING_YN**: Indicates whether the patient was in labor upon arrival at the hospital.
- **OB_LD_LABOR_TM**: The date and time at which labor began.
- **TRIAGE_ID_TAG**: The trauma identifier assigned to patient. This number is frequently associated with a pre-printed trauma packet that is used when an accident or other incident results in many patients arriving at the hospital in a short time period.
- **TRIAGE_ID_TAG_CMT**: A free-text comment that can be entered along with the trauma identifier or triage ID assigned to the patient.
- **TPLNT_BILL_STAT_C_NAME**: The category number for the Transplant Billing Status for a visit.
- **ACTL_DELIVRY_METH_C_NAME**: Indicates the delivery method of the last baby delivered on this encounter by this patient. For example, Spontaneous Vaginal Delivery, C-Section - Unspecified, etc.
- **PRENATAL_CARE_C_NAME**: Item used to indicate what type of prenatal care the patient has received.
- **AMBULANCE_CODE_C_NAME**: The category number for the ambulance code.
- **MSE_DATE**: Indicates the date and time of the patient's medical screening exam (MSE).
- **ADMIT_PROV_TEXT**: The free text admitting provider for the encounter.
- **ATTEND_PROV_TEXT**: The free text attending provider for the encounter.
- **PROV_PRIM_TEXT**: The free text primary care provider for the encounter
- **PROV_PRIM_TEXT_PHON**: The free text phone number for the primary care provider.
- **HOSPITAL_AREA_ID**: This field identifies the hospital area associated with the hospital unit in this patient contact.
- **CHIEF_COMPLAINT_C_NAME**: This holds the category number for the chief complaint if the free text chief complaint item is not being used.

### PAT_ENC_HSP_2
**Table**: The PAT_ENC_HSP_2 table is the subsequent table for the PAT_ENC_HSP table, which is the primary table for hospital encounter information. Each record in this table is based on a patient contact serial number.
- **PAT_ENC_CSN_ID**: The unique contact serial number for this contact. This number is unique across all patient encounters in your system. If you use IntraConnect, this is the Unique Contact Identifier (UCI).
- **PAT_ENC_DATE_REAL**: A unique contact date in decimal format. The integer portion of the number indicates the date of contact. The digits after the decimal distinguish different contacts on the same date and are unique for each contact on that date. For example, .00 is the first/only contact, .01 is the second contact, etc.
- **CONTACT_DATE**: The date of this contact in calendar format.
- **EX_DIS_DT_ENTR_DTTM**: The instant of entry of expected discharge date.
- **EX_DIS_TM_ENTR_DTTM**: The instant of entry of expected discharge time.
- **CONTRACT_REG_FLAG**: Indicates whether an HOV contact was registered using the Contract Registration workflow. If this workflow was not used, this column is null.
- **CONTRACT_CODE_C_NAME**: The contract code category for the encounter.
- **ACCEPTS_BLOOD_C_NAME**: The category ID that indicates whether this patient accepts blood.
- **ED_ARRIVAL_DETAILS**: Free text information holding any details regarding the ED Arrival.
- **CONS_SEDATION_C_NAME**: The category ID of the conscious sedation status for the patient encounter.
- **RESTRAINT_SECLUS_C_NAME**: The restraint or seclusion status category ID for this patient encounter.
- **MULTI_PREG_YN**: Indicates whether the mother has a multiple pregnancy for this L&D encounter.
- **DISASTER_NUM**: This column stores the disaster number, which is a number given by the ambulance company to patients during catastrophes that cause massive patient influxes to the hospital.
- **SRC_PATTERN_CSN_ID**: The Contact Serial Number (CSN) of the Admission Pattern record associated with the projected bed usage for this patient encounter. If this projection is manually modified an end user, the column stores null.
- **ENC_CLOSED_OR_COMPLETED_DATE**: The date that the encounter was closed or completed.
- **ED_DISPO_PAT_COND_C_NAME**: The category ID of the patient condition at time of disposition in the ED.
- **ADOPTION_TYPE_C_NAME**: Item to store what type of adoption is related to the current L&D contact.
- **PRI_PROBLEM_ID**: The unique ID of the principal problem for a patient's hospitalization.
- **EXPECTED_DISCHRG_APPROX_TIME_C_NAME**: Current approximate expected discharge time.  Each value represents a time range (e.g. Morning, Midday, Afternoon, Evening).
- **DISCH_MILEST_KICKOFF_UTC_DTTM**: Displays the date and time that discharge milestones were initiated.
- **DISCH_MILEST_AUTO_MANAGED_YN**: Determines if discharge milestones have had any manual intervention.  Discharge Milestones are considered auto-managed if the discharge order is the sole driver for kicking off and discontinuing milestones.
- **PREDICTED_LOS**: The Length of Stay value determined by the Predictive Model run.
- **EXP_LOS_UPD_SRC_C_NAME**: The source (e.g. Predictive Model, User Entered) from which the Expected Length of Stay was updated.
- **ED_ENC_SRC_C_NAME**: This column stores how an ED encounter was created (e.g. via interface, user workflows)
- **ED_DEPART_UTC_DTTM**: The ED Departure date and time in UTC.
- **ADT_ARRIVAL_UTC_DTTM**: The arrival date and time in UTC.
- **HOSP_DISCH_UTC_DTTM**: The hospital discharge date and time in UTC.
- **HOSP_ADMSN_UTC_DTTM**: The hospital admission date and time in UTC.
- **INP_ADMSN_UTC_DTTM**: The date and time that the patient first reached a patient class of Inpatient in UTC.
- **ED_HISTORICAL_YN**: ED Historical Encounter is set by cutover and historical encounter interfaces when patient encounters are created for emergency patients.
- **PATIENT_TASK_COMPLETION_RATE**: Aggregated task progression rates across all active tasks currently assigned to the patient.
- **START_MED_REM_DISCHG_YN**: If set to 1-Yes, medication reminders will start automatically after discharge. If set to 0-No or empty, medication reminders will not start automatically after discharge.
- **EXPECTED_DISCHARGE_UNKNOWN_YN**: Indicates whether the expected discharge date is unknown for this patient. 'Y' indicates that the expected discharge date is unknown and documented. 'N' indicates that the expected discharge date is known and documented. NULL indicates that no expected discharge info has been saved for this contact.
- **DUAL_ADMISSION_CSN**: In a dual admission scenario this will point from the encounter on leave to the admitted encounter.
- **LOA_PAT_ENC_CSN_ID**: This column is only populated when the encounter for this row is admitted and the patient currently has an encounter on a leave of absence. This column displays the unique contact serial number of the patient encounter that is on a leave of absence.
- **INITIAL_ADT_PAT_STAT_C_NAME**: The ADT type of encounter category ID initially assigned for the encounter.
- **NOTIFICATION_SENT_FIRST_IP_YN**: Indicates whether the Event Notification message was sent when the patient was upgraded to an IP class. 'Y' indicates that the message was sent. 'N' or NULL indicate that the message was not sent. Note that this message is only sent once, even though the date and time the patient became IP can be changed.
- **NOTIFICATION_SENT_OBS_ADMSN_YN**: Indicates whether the Event Notification message was sent when the patient was upgraded to an observation patient class. 'Y' indicates that the message was sent. 'N' or NULL indicate that the message was not sent. Note that this message is only sent once, even though the date and time the patient became observation can be changed.
- **IB_ALERT_LENGTH_OF_STAY_MSG_ID**: The unique ID of the In Basket Message that was sent to alert that a patient has gone past the approved length of stay.
- **INITIAL_ADMIT_CONF_STAT_C_NAME**: The encounter status category ID initially assigned to this encounter.
- **TRANSFER_COMMENTS**: The transfer comments entered by the user during the most recent transfer.
- **MED_READINESS_DTTM**: The medical readiness date and time for this patient encounter. This date and time may be expected or confirmed, depending on whether the patient is medically ready or not.
- **MED_READINESS_TIMEFRAM_C_NAME**: The medical readiness timeframe category ID for the patient encounter
- **MED_READINESS_YN**: Indicates whether this patient encounter is medically ready for discharge. 'Y' indicates that this encounter has been marked medically ready for discharge. 'N' or NULL indicates that it has not been marked medically ready for discharge.
- **MED_READINESS_INST_ENTRY_DTTM**: The instant at which this patient's medical readiness information was last updated
- **MED_READINESS_USER_ID**: The unique ID of the user who last updated medical readiness information for this patient encounter
- **MED_READINESS_USER_ID_NAME**: The name of the user record. This name may be hidden.
- **MED_READINESS_SOURCE_C_NAME**: The medical readiness source category ID for this patient encounter
- **EXPECTED_DISCH_DISP_C_NAME**: The patient's expected discharge disposition.
- **EXP_DISCH_DISP_USER_ID**: This item logs the last user that changed the expected discharge disposition.
- **EXP_DISCH_DISP_USER_ID_NAME**: The name of the user record. This name may be hidden.
- **EXP_DISCH_DISP_ENTRY_UTC_DTTM**: The instant of entry of expected discharge disposition.

### PAT_ENC_LETTERS
**Table**: The patient encounter letters table contains information about letters associated with encounters.
- **PAT_ENC_CSN_ID**: The unique contact serial number for this contact. This number is unique across all patient encounters in your system. If you use IntraConnect, this is the Unique Contact Identifier (UCI).
- **LINE**: The line count used to identify different letters associated with an encounter.
- **CONTACT_DATE**: The date of this contact in calendar format.
- **LTR_STATUS_C_NAME**: The category value associated with the status of each letter,  such as 1- Open, 2- Deleted, 3- Sent, 4- Voided, 5-Sent by batch.
- **LETTER_CREAT_DT**: The date that the letter was created.
- **LETTER_HNO_ID**: The note (HNO) record that hold the letter text.
- **LETTER_FROM_ID**: The user ID of the user entered as the "from" user in the letter activity.
- **LETTER_FROM_ID_NAME**: The name of the user record. This name may be hidden.
- **LETTER_ROUT_CMT_ID**: The note (HNO) ID that holds the letter routing comments.
- **LETTER_REASON_C_NAME**: The category value associated with the reason for the letter.
- **LETTER_REASON_CMT**: The comment for the letter reason.
- **LTR_STATUS_CHG_TM**: The instant (date and time) the status of the letter was created or changed.
- **LTR_STAT_CH_USR_ID**: The user that changed or created the letter status.
- **LTR_STAT_CH_USR_ID_NAME**: The name of the user record. This name may be hidden.
- **LETTER_DELVRY_ADDR**: The address the letter was sent to.
- **LETTER_RETURN_ADDR**: The return address for the letter
- **LETTER_WORKINGDAYS**: The number of work days (excluding weekends and holidays) from the date of the letter's encounter to the date the letter was sent.

### PAT_ENC_LOS_DX
**Table**: The PAT_ENC_LOS_DX table enables you to report on the diagnoses associated with the level of service (LOS) entered for a patient encounter. This table contains only information for those diagnoses that have been explicitly associated with the LOS.
- **PAT_ENC_CSN_ID**: The unique contact serial number for this contact. This number is unique across all patient encounters in your system. If you use IntraConnect, this is the Unique Contact Identifier (UCI).
- **LINE**: The line number for the information associated with this contact. Multiple pieces of information can be associated with this contact.
- **CONTACT_DATE**: The date of this contact in calendar format.
- **DX_UNIQUE**: The unique identifier of the diagnosis associated with the Level of Service (LOS). This value corresponds to the DX_UNIQUE column in the PAT_ENC_DX table. Together with PAT_ENC_CSN_ID, this forms the foreign key to the PAT_ENC_DX table.

### PAT_ENC_PAS
**Table**: PAS items for a patient encounter.
- **PAT_ENC_CSN_ID**: The unique contact serial number for this contact. This number is unique across all patient encounters in your system. If you use IntraConnect, this is the Unique Contact Identifier (UCI).
- **AMBULANCE_INCIDENT_NUM**: The unique identifier of a patient's journey, via ambulance, to a place where the patient received care.
- **AMBULANCE_ORG_POS_ID**: The unique identifier of the place of service that provided ambulance service for the patient.

### PAT_ENC_QNRS_ANS
**Table**: The PAT_ENC_QNRS_ANS table contains the Answer ID numbers for the Answers to all Appointment Questionnaires. An Appointment can have multiple Questionnaires that are used in conjunction with it, and each Questionnaire will have one Answer record associated with it.
- **PAT_ENC_CSN_ID**: This is the Contact Serial Number. It uniquely identifies this contact across all patients and all contacts.
- **LINE**: This item stores the line number of each Questionnaire Answer record that exists for this record.
- **CONTACT_DATE**: The date of this contact in calendar format.

### PAT_ENC_RSN_VISIT
**Table**: The PAT_ENC_RSN_VISIT contains the data entered as the Reason for Visit for a clinical system encounter. Each row in this table is one reason for visit associated with a patient encounter. One patient encounter may have multiple reasons for visit; therefore, the item LINE is used to identify each reason for visit within an encounter.
- **PAT_ENC_CSN_ID**: A unique serial number for this encounter. This number is unique across all patients and encounters in the system.
- **LINE**: The line number of the reason for visit within the encounter.
- **ENC_REASON_ID**: The ID of the record associated with the Reason for Visit entered in an encounter.
- **COMMENTS**: The comments associated with the reason for visit entered in a clinical system exam encounter.
- **RFV_ONSET_DT**: The onset date for reason for call/visit stored on this line.  Typically this value will only be collected during call workflows such as a telephone encounter.
- **BODY_LOC_ID**: The body location associated with the reason for visit for this patient encounter. This column is frequently used to link to the VESSEL_DOC table.
- **BODY_LOC_ID_RECORD_NAME**: Stores record name (.2)

### PAT_ENC_SEL_PHARMACIES
**Table**: Contains the list of selected pharmacies for an encounter.
- **PAT_ENC_CSN_ID**: The unique contact serial number (CSN) for this contact. This number is unique across all patient encounters in your system. If you use IntraConnect, this is the Unique Contact Identifier (UCI).
- **LINE**: The line number for the information associated with this contact. Multiple pieces of information can be associated with this contact.
- **PAT_ENC_DATE_REAL**: A unique contact date in decimal format. The integer portion of the number indicates the date of contact. The digits after the decimal distinguish different contacts on the same date and are unique for each contact on that date. For example, .00 is the first/only contact, .01 is the second contact, etc.
- **CONTACT_DATE**: The date of this contact in calendar format.
- **CM_CT_OWNER_ID**: The Community ID (CID) of the instance that owns this contact. This is only populated if you use IntraConnect.
- **PAT_ENC_PHARM_ID**: Contains the pharmacies that have been selected for the encounter. The pharmacies will display in the pharmacy association grid for the encounter.
- **PAT_ENC_PHARM_ID_PHARMACY_NAME**: The name of the pharmacy.
- **PAT_ENC_PHR_DEST_ID**: Contains the list of destinations for each selected pharmacy listed in PAT_ENC_PHARM_ID.

### PAT_ENC_THREADS
**Table**: This table contains information regarding a telephone encounter and any related messages.
- **PAT_ENC_CSN_ID**: The unique contact serial number for this contact. This number is unique across all patient encounters in your system. If you use IntraConnect, this is the Unique Contact Identifier (UCI).
- **CONTACT_DATE**: The date of this contact in calendar format.
- **THREAD_ID**: The unique ID of the thread for a telephone encounter that was sent to another user.

### PAT_HM_LETTER
**Table**: List of Health Maintenance letters with corresponding topic, type and due date.
- **PAT_ENC_CSN_ID**: The unique contact serial number for this contact. This number is unique across all patient encounters in your system. If you use IntraConnect, this is the Unique Contact Identifier (UCI).
- **LINE**: The line number for the information associated with this contact. Multiple pieces of information can be associated with this contact.
- **CONTACT_DATE**: The date of this contact in calendar format.
- **HM_LET_TOPIC_LST_ID**: The Health Maintenance Topic corresponding with the letter.
- **HM_LET_TOPIC_LST_ID_NAME**: The name of the health maintenance topic.

### PAT_HX_REVIEW
**Table**: This table contains information about when a patient's history was reviewed and by whom.





More detailed information on what kinds of history were reviewed is in the PAT_HX_REV_TYPE and PAT_HX_REV_TOPIC tables.
- **PAT_ENC_CSN_ID**: The unique contact serial number for this contact. This number is unique across all patient encounters in your system. If you use IntraConnect this is the Unique Contact Identifier (UCI).
- **LINE_COUNT**: The line number for the information associated with this record. Multiple pieces of information can be associated with this record.
- **CONTACT_DATE**: The date of this contact in calendar format.
- **HX_REVIEWED_USER_ID**: The unique ID of the user who reviewed history for the patient.
- **HX_REVIEWED_USER_ID_NAME**: The name of the user record. This name may be hidden.
- **HX_REVIEWED_DATE**: The date history was reviewed for this patient.
- **HX_REVIEWED_INSTANT**: The date and time history was reviewed for this patient.

### PAT_HX_REV_TOPIC
**Table**: This table contains information about where in the application the history was reviewed for a patient.





The history types (the kind of history reviewed) associated with a header (where the history was reviewed) are in PAT_HX_REV_TYPE.





Additional information about when a patient's history was reviewed and by whom is found in the PAT_HX_REVIEW table.
- **PAT_ENC_CSN_ID**: The unique contact serial number for this contact. This number is unique across all patient encounters in your system. If you use IntraConnect this is the Unique Contact Identifier (UCI).
- **GROUP_LINE**: The line number of the associated instance of history review in this encounter. Together with PAT_ENC_CSN_ID, this forms the foreign key to the PAT_HX_REVIEW table.
- **VALUE_LINE**: The line number of one of the multiple history topics that were reviewed for the associated instance of review and encounter from the PAT_HX_REVIEW table.
- **HX_REVIEWED_HEADER**: The header (a short title or description) and possibly, depending where in the application the history was reviewed, a unique record ID that describe where the history was reviewed.

### PAT_HX_REV_TYPE
**Table**: This table contains information types of history that were reviewed for a patient, such as Medical, Surgical, Socioeconomic, Alcohol, Tobacco, etc.





Where in the application a type of history was reviewed is in the PAT_HX_REV_TOPIC table.





Additional information about when a patient's history was reviewed and by whom is found in the PAT_HX_REVIEW table.
- **PAT_ENC_CSN_ID**: The unique contact serial number for this contact. This number is unique across all patient encounters in your system. If you use IntraConnect this is the Unique Contact Identifier (UCI).
- **GROUP_LINE**: The line number of the associated instance of history review in this encounter. Together with PAT_ENC_CSN_ID, this forms the foreign key to the PAT_HX_REVIEW table.
- **VALUE_LINE**: The line number of one of the multiple history types that were reviewed for the associated instance of review and encounter from the PAT_HX_REVIEW table.
- **CONTACT_DATE**: The date of this contact in calendar format.
- **HX_REVIEWED_TYPE_C_NAME**: The category value associated with the type of History Visit Navigator topic that was reviewed, such as Medical, Surgical, Socioeconomic, etc.

### PAT_MYC_MESG
**Table**: This table contains a link to the MyChart message for a patient encounter.
- **PAT_ENC_CSN_ID**: The unique contact serial number for this contact. This number is unique across all patient encounters in your system. If you use IntraConnect this is the Unique Contact Identifier (UCI).
- **LINE**: The line number for the information associated with this record. Multiple pieces of information can be associated with this record.
- **PAT_ENC_DATE_REAL**: This is a numeric representation of the date of this encounter in your system. The integer portion of the number specifies the date of the encounter. The digits after the decimal point indicate multiple visits on one day.
- **CONTACT_DATE**: The date of this contact in calendar format.
- **CM_CT_OWNER_ID**: ID of the deployment owner for this contact.
- **MYCHART_MESSAGE_ID**: The unique ID of the MyChart message for an encounter.

### PAT_REVIEW_ALLERGI
**Table**: Table contains patient entered clinical allergy data review from Welcome Kiosk and MyChart.
- **PAT_ENC_CSN_ID**: The unique contact serial number for this contact. This number is unique across all patient encounters in your system. If you use IntraConnect this is the Unique Contact Identifier (UCI).
- **LINE**: The line number for the information associated with this contact. Multiple pieces of information can be associated with this contact.
- **PAT_ID**: The unique ID of the patient record for this row. This column is frequently used to link to the PATIENT table.
- **PAT_ENC_DATE_REAL**: A unique, internal contact date in decimal format. The integer portion of the number indicates the date of the contact. The digits after the decimal distinguish different contacts on the same date and are unique for each contact on that date. For example, .00 is the first/only contact, .01 is the second contact, etc.
- **CONTACT_DATE**: The date of this contact in calendar format.
- **PAT_REVIEW_ELG_ID**: Patient allergies reviewed by patient.
- **PAT_REVIEW_ELG_ID_ALLERGEN_NAME**: The name of the allergen record.
- **PAT_REVIEW_ELG_R_YN**: Patient allergies reviewed by patient response.
- **PAT_REVIEW_EXTERNAL**: Patient allergies reviewed by the patient, entered in a free text format.

### PAT_REVIEW_DATA
**Table**: Table contains patient entered clinical data review from Welcome Kiosk and MyChart.
- **PAT_ENC_CSN_ID**: The unique contact serial number for this contact. This number is unique across all patient encounters in your system. If you use IntraConnect this is the Unique Contact Identifier (UCI).
- **PAT_ID**: The unique ID of the patient record for this row. This column is frequently used to link to the PATIENT table.
- **PAT_ENC_DATE_REAL**: A unique, internal contact date in decimal format. The integer portion of the number indicates the date of the contact. The digits after the decimal distinguish different contacts on the same date and are unique for each contact on that date. For example, .00 is the first/only contact, .01 is the second contact, etc.
- **CONTACT_DATE**: The date of this contact in calendar format.
- **PAT_REVIEW_ELG_C_YN**: Patient allergies reviewed by the patient. The response to the prompt, "do you have any additional allergies?"
- **PAT_REVIEW_ELG_CMT**: Additional comments, entered in a free text format by the patient in response to the prompt, "Do you have any additional allergies?"
- **PAT_REVIEW_ORD_C_YN**: Patient medications reviewed by the patient. The response to the prompt, "do you have any additional medications?"
- **PAT_REVIEW_ORD_CMT**: Additional comments, entered in a free text format, by the patient in response to the prompt, "Do you have any additional medications?"
- **PAT_REVIEW_LPL_C_YN**: Patient problems reviewed by the patient. The response to the prompt, "do you have any additional problems?"
- **PAT_REVIEW_LPL_CMT**: Additional comments, entered in a freetext format by the patient in response to the prompt, "Do you have any additional problems?"
- **PAT_ALG_RVW_INFO_C_NAME**: The patient's response to the "are these allergies correct?" question in Welcome.
- **PAT_MED_RVW_INFO_C_NAME**: The patient's response to the "are these medications correct?" question in Welcome.
- **PAT_PROB_RVW_INFO_C_NAME**: The patient's response to the "are these problems correct?" question in Welcome.

### PAT_REVIEW_PROBLEM
**Table**: Table contains patient entered clinical problem data review from Welcome Kiosk and MyChart.
- **PAT_ENC_CSN_ID**: The unique contact serial number for this contact. This number is unique across all patient encounters in your system. If you use IntraConnect this is the Unique Contact Identifier (UCI).
- **LINE**: The line number for the information associated with this contact. Multiple pieces of information can be associated with this contact.
- **PAT_ID**: The unique ID of the patient record for this row. This column is frequently used to link to the PATIENT table.
- **PAT_ENC_DATE_REAL**: A unique, internal contact date in decimal format. The integer portion of the number indicates the date of the contact. The digits after the decimal distinguish different contacts on the same date and are unique for each contact on that date. For example, .00 is the first/only contact, .01 is the second contact, etc.
- **CONTACT_DATE**: The date of this contact in calendar format.
- **PAT_REVIEW_LPL_ID**: Patient problem reviewed by patient.
- **PAT_REVIEW_LPL_R_YN**: Patient problem reviewed by patient response.
- **PAT_REV_LPL_EXTERN**: Patient problems reviewed by the patient, entered in a free text format.

### PAT_SOCIAL_HX_DOC
**Table**: This table contains the history documentation related to your patients for an encounter.  Each row represents one line of history documentation text for a given encounter.
- **PAT_ENC_CSN_ID**: The unique identifier of the patient encounter. Contact serial number is unique across all patients and all contacts.
- **LINE**: The line number for the information associated with this record. Multiple pieces of information can be associated with this record.
- **HX_SOCIAL_DOC**: Contents of the Social Documentation section of  the patient's History activity.

### PAT_UCN_CONVERT
**Table**: Contain if the patient's notes are converted for UCN.
- **PAT_ENC_CSN_ID**: The contact serial number (CSN) for this contact. This number is unique across all patient encounters in your system. If you use IntraConnect, this is the Unique Contact Identifier (UCI).
- **LINE**: The line number for the information associated with this contact. Multiple pieces of information can be associated with this contact.
- **PAT_ENC_DATE_REAL**: A unique contact date in decimal format. The integer portion of the number indicates the date of contact. The digits after the decimal distinguish different contacts on the same date and are unique for each contact on that date. For example, .00 is the first/only contact, .01 is the second contact, etc.
- **CONTACT_DATE**: The date of this contact in calendar format.
- **LINKED_UCN_NOTES_ID**: Contains the IDs of the notes linked to this patient encounter.

### PAT_UTILIZATION_REVIEW
**Table**: This table contains information related to the patient utilization reviews entered during an admission.
- **PAT_ENC_CSN_ID**: The unique contact serial number for this contact. This number is unique across all patient encounters in your system. If you use IntraConnect, this is the Unique Contact Identifier (UCI).
- **PAT_ENC_DATE_REAL**: A unique contact date in decimal format. The integer portion of the number indicates the date of contact. The digits after the decimal distinguish different contacts on the same date and are unique for each contact on that date. For example, .00 is the first/only contact, .01 is the second contact, etc.
- **CONTACT_DATE**: The date of this contact in calendar format.
- **CM_CT_OWNER_ID**: The Community ID (CID) of the instance that owns this contact. This is only populated if you use IntraConnect.
- **UR_NEXT_REVIEW_INST_DTTM**: Stores the instant that the next utilization review is due by a case manager or UR specialist.
- **NO_UTL_REV_NEEDED_YN**: A yes or no flag determining whether a patient no longer requires utilization reviews during the admission (yes indicates no further reviews are needed).
- **LAST_UTL_REV_USR_ID**: The last user who updated patient level information related to utilization reviews.
- **LAST_UTL_REV_USR_ID_NAME**: The name of the user record. This name may be hidden.

### RESULT_FOLLOW_UP
**Table**: This table contains the list of results that were followed up during this particular encounter, such as a telephone encounter.
- **PAT_ENC_CSN_ID**: The unique contact serial number for this contact. This number is unique across all patient encounters in your system. If you use IntraConnect, this is the Unique Contact Identifier (UCI).
- **LINE**: The line number for the information associated with this contact. Multiple pieces of information can be associated with this contact.
- **CONTACT_DATE**: The date of this contact in calendar format.
- **RESULT_ID**: The unique identifier of the result (ORD) that was followed up on during this encounter.

### SOCIAL_ADL_HX
**Table**: This table contains data recorded in the activities of daily living section of social history contacts entered in the patient's chart during a clinical system encounter. Note: This table is designed to hold a patient's history over time; however, it is most typically implemented to only extract the latest patient history contact.
- **PAT_ENC_CSN_ID**: A unique serial number for this encounter. This number is unique across all patients and encounters in the system.
- **LINE**: The line number for the information associated with this contact. Multiple pieces of information can be associated with this contact.
- **HX_ADL_QUESTION_ID**: Stores the link to the unique ID of the ADL question.
- **HX_ADL_QUESTION_ID_RECORD_NAME**: The name of the Visit Navigator (VN) History Template Definition (LQH) record.
- **HX_ADL_RESPONSE_C_NAME**: This column stores the category value (1, 2 or 3) of the response to ADL questions.
- **HX_ADL_COMMENTS**: Holds comments for Activities of Daily Living (ADL) questions.

### TREATMENT
**Table**: This table contains all orders for each patient encounter.
- **PAT_ENC_CSN_ID**: The unique contact serial number for this contact. This number is unique across all patient encounters in your system. If you use IntraConnect, this is the Unique Contact Identifier (UCI).
- **LINE**: The line number for the information associated with this contact. Multiple pieces of information can be associated with this contact.
- **PAT_ENC_DATE_REAL**: A unique contact date in decimal format. The integer portion of the number indicates the date of contact. The digits after the decimal distinguish different contacts on the same date and are unique for each contact on that date. For example, .00 is the first/only contact, .01 is the second contact, etc.
- **CONTACT_DATE**: The date of this contact in calendar format.
- **TREATMENTS_ID**: The unique ID of the order record.
- **TREAT_ORD_SENT_DTTM**: The date/time when the order was sent.

### TREATMENT_TEAM
**Table**: This table stores information about patient treatment teams such as relationship, specialty, department, and start/end time. Each row represents a member of a patient's treatment team.
- **PAT_ENC_CSN_ID**: The unique contact serial number for this contact. This number is unique across all patient encounters in your system. If you use IntraConnect, this is the Unique Contact Identifier (UCI).
- **LINE**: The line number for the information associated with this contact. Multiple pieces of information can be associated with this contact.
- **PAT_ID**: The unique ID of the patient record for this row. This column is frequently used to link to the PATIENT table.
- **CONTACT_DATE**: The date of this contact in calendar format.
- **TR_TEAM_BILL_PR_ID**: The unique ID of the billing provider record.
- **TR_TEAM_EM_CODE_ID**: The evaluation and management code for billing within the treatment team.
- **TR_TEAM_EM_REQ_C_NAME**: Used to determine if the evaluation and management code is required or not for use in the treatment team.
- **TR_TEAM_SPEC_C_NAME**: The category value corresponding to the specialty of the treatment team member to the patient.
- **TR_TEAM_COMMENT**: The comment for the treatment team.
- **TR_TEAM_ISDE_YN**: Indicates whether or not this provider was deleted.
- **TR_TEAM_ID**: The unique ID of the treatment team provider record.
- **TR_TEAM_REL_C_NAME**: The category value corresponding to the relationship of the treatment team member to the patient.
- **TR_TEAM_COMM_C_NAME**: Relates to communication being sent to the treatment team members.
- **TR_TEAM_INFO_C_NAME**: Additional information related to the treatment team members.
- **TR_TEAM_BEG_DTTM**: The date and time the treatment team member started for the patient.
- **TR_TEAM_END_DTTM**: The date and time the treatment team member ended for the patient.
- **TR_TEAM_ED_YN**: Indicates whether or not this provider was on the treatment team in the ED.
- **TR_TEAM_TEAM_ADD_YN**: Indicates whether the assignment was added by the team.
- **TR_TEAM_SRC_CSN_ID**: This item stores the contact serial number corresponding to the encounter responsible for assigning a specific member of the treatment team. If you use IntraConnect, this is the Unique Contact Identifier (UCI).

## Sample Data (one representative non-null value per column)

### ADDITIONAL_EM_CODE
- PAT_ENC_CSN_ID = `948004323`
- LINE = `1`
- EM_CODE_ADDL_ID = `23660`
- EM_CODE_BILPROV_ID = `144590`
- EM_CODE_UNIQUE_NUM = `1`

### AN_RELINK_INFO
- PAT_ENC_CSN_ID = `720803470`
- PAT_ENC_DATE_REAL = `67151`
- CONTACT_DATE = `11/7/2024 12:00:00 AM`

### APPT_LETTER_RECIPIENTS
- PAT_ENC_CSN_ID = `799951565`
- LINE = `1`
- PAT_ENC_DATE_REAL = `67151`
- CONTACT_DATE = `11/7/2024 12:00:00 AM`
- PAT_RELATIONSHIP_ID = `31533870`
- SHOULD_RECEIVE_LETTERS_YN = `Y`
- SHOULD_ATTEND_VISIT_YN = `Y`

### ASSOCIATED_REFERRALS
- PAT_ENC_CSN_ID = `922942674`
- LINE = `1`
- PAT_ENC_DATE_REAL = `66190`
- CONTACT_DATE = `3/22/2022 12:00:00 AM`
- ASSOCIATED_REFERRAL_ID = `13661714`

### CLARITY_DEP
- DEPARTMENT_ID = `1`
- DEPARTMENT_NAME = `INITIAL DEPT`
- EXTERNAL_NAME = `Initial Department`

### CLARITY_DEP_4
- DEPARTMENT_ID = `1`

### CLARITY_EDG
- DX_ID = `15362`
- DX_NAME = `Screening for hyperlipidemia`

### CLARITY_SER
- PROV_ID = `132946`
- PROV_NAME = `CAHILL, KATHRYN A`
- EXTERNAL_NAME = `Kathryn A Cahill`

### DISCONTINUED_MEDS
- PAT_ENC_CSN_ID = `988126821`
- LINE = `1`
- PAT_ENC_DATE_REAL = `66745`
- CONTACT_DATE = `9/28/2023 12:00:00 AM`
- MEDS_DISCONTINUED = `772179261`

### ECHKIN_STEP_INFO
- PAT_ENC_CSN_ID = `829213099`
- LINE = `1`
- PAT_ENC_DATE_REAL = `66745`
- CONTACT_DATE = `9/28/2023 12:00:00 AM`
- INCLUDED_STEP_C_NAME = `Personal Information`
- ECHKIN_STEP_STAT_C_NAME = `Completed`
- STEP_COMPLETED_UTC_DTTM = `9/27/2023 5:06:06 PM`
- MYPT_ID = `389635`
- STEP_ACTION_C_NAME = `Completed`

### ED_PAT_STATUS
- INPATIENT_DATA_ID = `123583502`
- LINE = `1`
- ED_PAT_STATUS_C_NAME = `Arrived`
- PAT_STATUS_TIME = `1/9/2020 12:21:00 PM`
- PAT_STATUS_USER_ID = `DTB400`
- PAT_STATUS_USER_ID_NAME = `BURNS, MALAYSIA`
- PAT_ENC_CSN_ID = `799951565`

### EXT_PHARM_TYPE_COVERED
- PAT_ENC_CSN_ID = `720803470`
- GROUP_LINE = `1`
- VALUE_LINE = `1`
- COVERED_EXTERNAL_PHARM_TYPE_C_NAME = `Retail`

### FAMILY_HX
- LINE = `1`
- MEDICAL_HX_C_NAME = `Ovarian cancer`
- COMMENTS = `s/p thyroidectomy`
- PAT_ENC_CSN_ID = `724623985`
- FAM_HX_SRC_C_NAME = `Provider`
- RELATION_C_NAME = `Mother`
- FAM_MED_REL_ID = `2`

### FAM_HX_PAT_ONLY
- PAT_ENC_CSN_ID = `724623985`
- PAT_ENC_DATE_REAL = `64869.02`
- CONTACT_DATE = `8/9/2018 12:00:00 AM`

### FRONT_END_PMT_COLL_HX
- PAT_ENC_CSN_ID = `720803470`
- LINE = `1`
- CONTACT_DATE = `12/1/2022 12:00:00 AM`
- COLL_INSTANT_UTC_DTTM = `12/1/2022 3:28:38 PM`
- COLL_WORKFLOW_TYPE_C_NAME = `Check-In`
- LOGIN_DEPARTMENT_ID = `1700801002`
- ENC_DEPARTMENT_ID = `1700801002`
- RSN_NON_COLL_AMT_C_NAME = `Other (Requires Comment)`
- RSN_NON_COLL_AMT_COMMENT = `covid/pandemic`
- GUARANTOR_ACCOUNT_ID = `1810018166`
- EVENT_TYPE_C_NAME = `Collection Event`
- PB_COPAY_COLL = `0`
- PB_COPAY_PAID = `0`
- PB_COPAY_DUE = `0`
- HB_COPAY_COLL = `0`
- HB_COPAY_PAID = `0`
- HB_COPAY_DUE = `0`
- PB_PREPAY_COLL = `0`
- PB_PREPAY_PAID = `0`
- PB_PREPAY_DUE = `0`
- HB_PREPAY_COLL = `0`
- HB_PREPAY_PAID = `0`
- HB_PREPAY_DUE = `0`
- PB_PREV_BAL_COLL = `7.82`
- PB_PREV_BAL_PAID = `0`
- PB_PREV_BAL_DUE = `7.82`
- HB_PREV_BAL_COLL = `0`
- HB_PREV_BAL_PAID = `0`
- HB_PREV_BAL_DUE = `0`
- PREPAY_DISCOUNT_OFFERED = `0`

### HNO_INFO
- NOTE_ID = `1473622964`
- NOTE_TYPE_NOADD_C_NAME = `Letter`
- PAT_ENC_CSN_ID = `724619887`
- ENTRY_USER_ID = `JMS402`
- ENTRY_USER_ID_NAME = `SUTTER, JULIE M`
- IP_NOTE_TYPE_C_NAME = `Letter`
- TX_IB_FOLDER_C_NAME = `Inpatient Transcriptions`
- CREATE_INSTANT_DTTM = `8/28/2018 1:40:00 PM`
- DATE_OF_SERVIC_DTTM = `8/28/2018 1:40:00 PM`
- LST_FILED_INST_DTTM = `8/28/2018 1:40:00 PM`
- UPDATE_DATE = `8/20/2018 1:06:00 PM`
- CURRENT_AUTHOR_ID = `DMW400`
- CURRENT_AUTHOR_ID_NAME = `WILD, DAWN M`
- VISIT_NUM = `8`
- CRT_INST_LOCAL_DTTM = `8/28/2018 8:40:00 AM`
- NOTE_PURPOSE_C_NAME = `NORMAL`
- PRIORITY_YN = `N`
- CONVERSATION_MSG_ID = `358825337`

### HNO_INFO_2
- NOTE_ID = `1473622964`
- HNO_RECORD_TYPE_C_NAME = `HB Hospital Account Note`
- ACTIVE_C_NAME = `Active`

### HOMUNCULUS_PAT_DATA
- PAT_ENC_CSN_ID = `720803470`
- PAT_ENC_DATE_REAL = `65981`
- CONTACT_DATE = `8/25/2021 12:00:00 AM`

### HSP_ADMIT_DIAG
- LINE = `1`
- DX_ID = `284018`
- PAT_ENC_CSN_ID = `922943112`

### HSP_ADMIT_PROC
- LINE = `1`
- PROC_ID = `147`
- PAT_ENC_CSN_ID = `922943112`
- ADM_PXDX_ASSOC = `1`

### HSP_ATND_PROV
- LINE = `1`
- ATTEND_FROM_DATE = `2/17/2022 1:59:00 PM`
- ATTEND_TO_DATE = `3/22/2022 11:59:00 PM`
- PROV_ID = `805364`
- PAT_ENC_CSN_ID = `922942674`

### IP_DATA_STORE
- INPATIENT_DATA_ID = `100502738`
- RECORD_STATUS_C_NAME = `Active`
- EPT_CSN = `720803470`
- UPDATE_DATE = `10/14/2021 9:30:00 PM`

### IP_FLOWSHEET_ROWS
- INPATIENT_DATA_ID = `100502738`
- LINE = `1`
- FLO_MEAS_ID = `1020100005`
- FLO_MEAS_ID_DISP_NAME = `Date of Last Solid Food`
- IP_LDA_ID = `9343309`
- ROW_VARIANCE_C_NAME = `Add`

### IP_FLWSHT_MEAS
- FSD_ID = `103663529`
- LINE = `1`
- OCCURANCE = `5`
- RECORDED_TIME = `3/22/2022 4:42:00 PM`
- ENTRY_TIME = `3/22/2022 4:42:00 PM`
- TAKEN_USER_ID = `KLF403`
- TAKEN_USER_ID_NAME = `FALDUTO, KAITLYN L`
- ENTRY_USER_ID = `KLF403`
- ENTRY_USER_ID_NAME = `FALDUTO, KAITLYN L`
- EDITED_LINE = `1`
- ISACCEPTED_YN = `Y`
- NEEDS_COSIGN_C_NAME = `No`
- FLT_ID = `90`
- FLT_ID_DISPLAY_NAME = `Travel`
- FLO_DAT_USED = `55398`
- FLO_CNCT_DATE_REAL = `66133`
- USER_PENDED_BY_ID = `MYCHARTG`
- USER_PENDED_BY_ID_NAME = `MYCHART, GENERIC`
- INSTANT_PENDED_DTTM = `2/27/2023 3:56:00 PM`
- ABNORMAL_C_NAME = `Yes`
- PAT_REPORTED_STATUS_C_NAME = `Patient reported, not clinician validated`
- MYPT_ID = `389635`
- ABNORMAL_TYPE_C_NAME = `High`
- FLO_NETWORKED_INI = `EGW`

### IP_FLWSHT_REC
- FSD_ID = `103663529`
- INPATIENT_DATA_ID = `192169229`
- RECORD_DATE = `3/12/2022 12:00:00 AM`
- PAT_ID = `Z7004242`

### KIOSK_QUESTIONNAIR
- PAT_ENC_CSN_ID = `829213099`
- LINE = `1`
- PAT_ID = `Z7004242`
- PAT_ENC_DATE_REAL = `67151`
- CONTACT_DATE = `11/7/2024 12:00:00 AM`
- KIOSK_QUEST_ID = `21004670`
- KIOSK_QUEST_ID_FORM_NAME = `UPH AMB PHQ2`

### MEDICAL_HX
- LINE = `1`
- DX_ID = `260690`
- PAT_ENC_CSN_ID = `958134730`

### MED_PEND_APRV_STAT
- PAT_ENC_CSN_ID = `988126821`
- LINE = `1`
- PAT_ENC_DATE_REAL = `66524`
- CONTACT_DATE = `2/19/2023 12:00:00 AM`
- MED_PEND_APRV_FLG_C_NAME = `Approved`

### MYC_APPT_QNR_DATA
- PAT_ENC_CSN_ID = `829213099`
- LINE = `1`
- PAT_ENC_DATE_REAL = `67151`
- CONTACT_DATE = `11/7/2024 12:00:00 AM`
- MYC_APPT_QUESR_ID = `21004670`
- MYC_APPT_QUESR_ID_FORM_NAME = `UPH AMB PHQ2`
- MYC_QUESR_START_DT = `10/24/2024 12:00:00 AM`
- PAT_APPT_QNR_STAT_C_NAME = `Assigned`

### OPH_EXAM_DATA
- PAT_ENC_CSN_ID = `720803470`
- PAT_ENC_DATE_REAL = `66803`

### ORDER_PARENT_INFO
- ORDER_ID = `439060604`
- PARENT_ORDER_ID = `439060612`
- ORDERING_DTTM = `7/21/2020 12:38:00 PM`
- ORD_LOGIN_DEP_ID = `1700801002`
- PAT_ENC_CSN_ID = `829995922`
- PAT_CONTACT_DEP_ID = `1700801002`

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

### PATIENT_ENC_VIDEO_VISIT
- PAT_ENC_CSN_ID = `720803470`
- PAT_ENC_DATE_REAL = `66895`
- CONTACT_DATE = `2/25/2024 12:00:00 AM`

### PAT_ADDENDUM_INFO
- PAT_ENC_DATE_REAL = `66745`
- PAT_ENC_CSN_ID = `829213099`
- CONTACT_DATE = `9/28/2023 12:00:00 AM`
- LINE = `1`
- ADDENDUM_DATE_TIME = `9/28/2023 11:29:00 AM`
- ADDENDUM_USER_ID = `MSF400`
- ADDENDUM_USER_ID_NAME = `FARGEN, MEGAN`

### PAT_CANCEL_PROC
- PAT_ENC_CSN_ID = `829213099`
- LINE = `1`
- CONTACT_DATE = `7/14/2020 12:00:00 AM`
- CAN_PRCD_C_ID = `570827036`

### PAT_CR_TX_SINGLE
- PAT_ENC_CSN_ID = `720803470`
- PAT_ENC_DATE_REAL = `66407`
- CONTACT_DATE = `10/25/2022 12:00:00 AM`

### PAT_ENC
- PAT_ID = `Z7004242`
- PAT_ENC_DATE_REAL = `64869`
- PAT_ENC_CSN_ID = `720803470`
- CONTACT_DATE = `8/9/2018 12:00:00 AM`
- PCP_PROV_ID = `802011`
- VISIT_PROV_ID = `802011`
- VISIT_PROV_TITLE_NAME = `MD`
- DEPARTMENT_ID = `1700801002`
- ENC_CLOSED_YN = `Y`
- ENC_CLOSED_USER_ID = `DHILLOPS`
- ENC_CLOSED_USER_ID_NAME = `DHILLON, PUNEET S`
- ENC_CLOSE_DATE = `8/9/2018 12:00:00 AM`
- APPT_STATUS_C_NAME = `Completed`
- APPT_CANC_USER_ID = `PAM400`
- APPT_CANC_USER_ID_NAME = `MANIX, PATRICIA A`
- CHECKIN_USER_ID = `JMS402`
- CHECKIN_USER_ID_NAME = `SUTTER, JULIE M`
- HOSP_ADMSN_TIME = `3/11/2022 2:41:00 PM`
- HOSP_DISCHRG_TIME = `3/11/2022 11:59:00 PM`
- HOSP_ADMSN_TYPE_C_NAME = `Elective`
- NONCVRED_SERVICE_YN = `N`
- REFERRAL_REQ_YN = `N`
- REFERRAL_ID = `13661714`
- ACCOUNT_ID = `1810018166`
- COVERAGE_ID = `5934765`
- PRIMARY_LOC_ID = `1700801`
- CHARGE_SLIP_NUMBER = `24238811`
- COPAY_DUE = `0`
- UPDATE_DATE = `6/25/2023 11:05:00 AM`
- HSP_ACCOUNT_ID = `376684810`
- INPATIENT_DATA_ID = `100502738`
- IP_EPISODE_ID = `198399030`
- CONTACT_COMMENT = `Contact created via interface. (750691,10549419688)`
- OUTGOING_CALL_YN = `N`
- REFERRAL_SOURCE_ID = `802011`
- REFERRAL_SOURCE_ID_REFERRING_PROV_NAM = `DHILLON, PUNEET S`
- BMI = `24.27`
- BSA = `1.99`
- AVS_PRINT_TM = `8/9/2018 10:16:00 AM`
- AVS_FIRST_USER_ID = `PAM400`
- AVS_FIRST_USER_ID_NAME = `MANIX, PATRICIA A`
- ENC_MED_FRZ_RSN_C_NAME = `Patient Arrival`
- EFFECTIVE_DATE_DT = `8/9/2018 12:00:00 AM`
- DISCHARGE_DATE_DT = `3/11/2022 12:00:00 AM`
- BEN_ENG_SP_AMT = `0`
- BEN_ADJ_COPAY_AMT = `0`
- BEN_ADJ_METHOD_C_NAME = `Benefit Package Adjudication Formula`
- ENC_CREATE_USER_ID = `JMS402`
- ENC_CREATE_USER_ID_NAME = `SUTTER, JULIE M`
- ENC_INSTANT = `8/9/2018 9:29:00 AM`
- EFFECTIVE_DATE_DTTM = `8/9/2018 12:00:00 AM`
- CALCULATED_ENC_STAT_C_NAME = `Complete`

### PAT_ENC_2
- PAT_ENC_CSN_ID = `720803470`
- CONTACT_DATE = `1/25/2024 12:00:00 AM`
- CAN_LET_C_NAME = `No Letter`
- SUP_PROV_C_NAME = `No Supervision`
- SUP_PROV_REV_TM = `7/21/2020 12:38:00 PM`
- MEDS_REQUEST_PHR_ID = `64981`
- MEDS_REQUEST_PHR_ID_PHARMACY_NAME = `COSTCO PHARMACY # 1020 - MIDDLETON, WI - 2150 DEMING WAY`
- PHYS_BP = `142/74`
- VITALS_TAKEN_TM = `12/1/2022 9:38:00 AM`
- DOC_HX_SOURCE_C_NAME = `Provider`
- APPT_LET_C_NAME = `Appt Letter`
- APPTMT_LET_INST = `2/25/2022 3:11:00 AM`
- ADT_PAT_CLASS_C_NAME = `Therapies Series`
- OTHER_BLOCK_ID = `265615343`
- OTHER_BLOCK_TYPE_C_NAME = `Ambulatory`
- HSP_ACCT_ADV_DTTM = `2/17/2022 2:04:00 PM`
- TEL_ENC_MSG_RGRDING = `FW: Appointment Request`
- MSG_PRIORITY_C_NAME = `Normal`
- MSG_CALLER_NAME = `REDACTED`
- AVS_LAST_PRINT_DTTM = `12/1/2022 4:18:00 PM`
- MED_LIST_UPDATE_DTTM = `9/28/2023 3:02:00 PM`

### PAT_ENC_3
- PAT_ENC_CSN = `720803470`
- PAT_ENC_DATE_REAL = `64869`
- CHKOUT_USER_ID = `PAM400`
- CHKOUT_USER_ID_NAME = `MANIX, PATRICIA A`
- ENC_BILL_AREA_ID = `9`
- ENC_BILL_AREA_ID_BILL_AREA_NAME = `Associated Physicians Madison Wisconsin`
- DX_UNIQUE_COUNTER = `3`
- COMMAUTO_SENDER_ID = `RAMMELZL`
- COMMAUTO_SENDER_ID_NAME = `RAMMELKAMP, ZOE L`
- BENEFIT_ID = `9963531`
- DO_NOT_BILL_INS_YN = `N`
- SELF_PAY_VISIT_YN = `N`
- COPAY_OVERRIDDEN_YN = `N`

### PAT_ENC_4
- PAT_ENC_CSN_ID = `720803470`
- VISIT_NUMBER = `11`
- COPAY_RECEIPT_NUM = `8141265`
- BEN_ADJ_COINS_AMT = `0`
- TOBACCO_USE_VRFY_YN = `Y`
- ECHKIN_STATUS_C_NAME = `Not Yet Available`
- PB_VISIT_HAR_ID = `11825607`

### PAT_ENC_5
- PAT_ENC_CSN_ID = `720803470`
- CONTACT_DATE = `8/9/2018 12:00:00 AM`
- ATTR_DEPARTMENT_ID = `1700801002`

### PAT_ENC_6
- PAT_ENC_CSN_ID = `720803470`
- PAT_ENC_DATE_REAL = `65981`
- CONTACT_DATE = `8/25/2021 12:00:00 AM`
- ELIG_PLAN_SELECT_YN = `N`
- APPT_AUTH_STATUS_C_NAME = `Authorization Not Needed`
- INTF_PRIMARY_PAT_ENC_CSN_ID = `832464108`

### PAT_ENC_7
- PAT_ENC_CSN_ID = `720803470`
- PAT_ENC_DATE_REAL = `66745.03`
- CONTACT_DATE = `9/28/2023 12:00:00 AM`
- CONTACT_NUM = `104`
- RSN_FOR_NO_INC_MSG_C_NAME = `Not a type to check`

### PAT_ENC_ADMIT_DX_AUDIT
- PAT_ENC_CSN_ID = `922943112`
- LINE = `1`
- ADMISSION_DX_EDIT_UTC_DTTM = `2/17/2022 8:01:26 PM`

### PAT_ENC_APPT
- PAT_ENC_CSN_ID = `720803470`
- LINE = `1`
- CONTACT_DATE = `12/22/2023 12:00:00 AM`
- DEPARTMENT_ID = `1700801002`
- PROV_START_TIME = `3/2/2023 2:45:00 PM`

### PAT_ENC_BILLING_ENC
- PAT_ENC_CSN_ID = `720803470`
- CONTACT_DATE = `7/14/2020 12:00:00 AM`

### PAT_ENC_CALL_DATA
- CONTACT_DATE = `2/25/2024 12:00:00 AM`
- PAT_ENC_CSN_ID = `720803470`

### PAT_ENC_CC_AUTO_CHG
- PAT_ENC_CSN_ID = `720803470`
- CONTACT_DATE = `2/25/2024 12:00:00 AM`

### PAT_ENC_CURR_MEDS
- PAT_ENC_DATE_REAL = `66767`
- LINE = `1`
- PAT_ENC_CSN_ID = `948004323`
- CONTACT_DATE = `10/20/2023 12:00:00 AM`
- CURRENT_MED_ID = `772179269`
- IS_ACTIVE_YN = `Y`

### PAT_ENC_DISP
- PAT_ENC_DATE_REAL = `65574`
- CONTACT_DATE = `7/14/2020 12:00:00 AM`
- PAT_ENC_CSN_ID = `720803470`
- LOS_DROPPED_C_NAME = `Yes`
- LOS_NEW_OR_EST_C_NAME = `Established`
- LOS_NO_CHG_RSN_C_NAME = `Orders in transmittal`

### PAT_ENC_DOCS
- PAT_ID = `Z7004242`
- PAT_ENC_DATE_REAL = `66745`
- LINE = `1`
- DOC_INFO_ID = `372803361`
- PAT_ENC_CSN_ID = `720803470`
- ADT_CONTACT_YN = `Y`

### PAT_ENC_DX
- PAT_ENC_DATE_REAL = `66524`
- LINE = `1`
- CONTACT_DATE = `2/19/2023 12:00:00 AM`
- PAT_ENC_CSN_ID = `720803470`
- DX_ID = `260690`
- PRIMARY_DX_YN = `N`
- DX_CHRONIC_YN = `N`
- DX_UNIQUE = `1`
- DX_ED_YN = `N`
- DX_LINK_PROB_ID = `90574164`

### PAT_ENC_ELIG_HISTORY
- PAT_ENC_CSN_ID = `921952141`
- LINE = `1`
- PAT_ID = `Z7004242`
- PAT_ENC_DATE_REAL = `66830`
- CONTACT_DATE = `12/22/2023 12:00:00 AM`
- ELIG_ACTION_C_NAME = `Auto Verified`
- ELIG_PLAN_INDEX = `1`
- ELIG_HX_USER_ID = `RTEUSER`
- ELIG_HX_USER_ID_NAME = `RTE, USER`
- ELIG_HX_INST_UTC_DTTM = `12/22/2023 8:05:51 PM`

### PAT_ENC_HSP
- PAT_ENC_CSN_ID = `922942674`
- ADT_PAT_CLASS_C_NAME = `Therapies Series`
- ADT_PATIENT_STAT_C_NAME = `Hospital Outpatient Visit`
- EXP_ADMISSION_TIME = `3/11/2022 2:50:00 PM`
- ADMIT_SOURCE_C_NAME = `Self`
- HOSP_ADMSN_TIME = `3/11/2022 2:41:00 PM`
- ADMIT_CONF_STAT_C_NAME = `Completed`
- HOSP_DISCH_TIME = `3/11/2022 11:59:00 PM`
- HOSP_ADMSN_TYPE_C_NAME = `Elective`
- DISCH_DISP_C_NAME = `Home - Discharge to Home or Self Care`
- INPATIENT_DATA_ID = `192169229`
- OP_ADM_DATE = `3/11/2022 2:41:00 PM`
- OP_ADM_EVENT_ID = `133758524`
- HOSPITAL_AREA_ID = `101401`

### PAT_ENC_HSP_2
- PAT_ENC_CSN_ID = `922942674`
- PAT_ENC_DATE_REAL = `66179`
- CONTACT_DATE = `3/11/2022 12:00:00 AM`
- ENC_CLOSED_OR_COMPLETED_DATE = `3/12/2022 12:00:00 AM`
- HOSP_DISCH_UTC_DTTM = `3/12/2022 5:59:00 AM`
- HOSP_ADMSN_UTC_DTTM = `3/11/2022 8:41:09 PM`

### PAT_ENC_LETTERS
- PAT_ENC_CSN_ID = `724619887`
- LINE = `1`
- CONTACT_DATE = `8/9/2018 12:00:00 AM`
- LTR_STATUS_C_NAME = `Sent`
- LETTER_CREAT_DT = `8/9/2018 12:00:00 AM`
- LETTER_HNO_ID = `1473625808`
- LETTER_FROM_ID = `DHILLOPS`
- LETTER_FROM_ID_NAME = `DHILLON, PUNEET S`
- LETTER_REASON_C_NAME = `MyChart Account Administration`
- LTR_STATUS_CHG_TM = `8/9/2018 9:29:00 AM`
- LTR_STAT_CH_USR_ID = `JMS402`
- LTR_STAT_CH_USR_ID_NAME = `SUTTER, JULIE M`
- LETTER_WORKINGDAYS = `0`

### PAT_ENC_LOS_DX
- PAT_ENC_CSN_ID = `720803470`
- LINE = `1`
- CONTACT_DATE = `9/28/2023 12:00:00 AM`
- DX_UNIQUE = `1`

### PAT_ENC_PAS
- PAT_ENC_CSN_ID = `720803470`

### PAT_ENC_QNRS_ANS
- PAT_ENC_CSN_ID = `922942674`
- LINE = `1`
- CONTACT_DATE = `3/11/2022 12:00:00 AM`

### PAT_ENC_RSN_VISIT
- PAT_ENC_CSN_ID = `720803470`
- LINE = `1`
- ENC_REASON_ID = `160383`
- COMMENTS = `Neurology`
- RFV_ONSET_DT = `12/22/2023 12:00:00 AM`

### PAT_ENC_SEL_PHARMACIES
- PAT_ENC_CSN_ID = `720803470`
- LINE = `1`
- PAT_ENC_DATE_REAL = `66830`
- CONTACT_DATE = `12/22/2023 12:00:00 AM`
- PAT_ENC_PHARM_ID = `64981`
- PAT_ENC_PHARM_ID_PHARMACY_NAME = `COSTCO PHARMACY # 1020 - MIDDLETON, WI - 2150 DEMING WAY`

### PAT_ENC_THREADS
- PAT_ENC_CSN_ID = `720803470`
- CONTACT_DATE = `9/28/2023 12:00:00 AM`
- THREAD_ID = `290240544`

### PAT_HM_LETTER
- PAT_ENC_CSN_ID = `1018439080`
- LINE = `1`
- CONTACT_DATE = `8/3/2023 12:00:00 AM`
- HM_LET_TOPIC_LST_ID = `50`
- HM_LET_TOPIC_LST_ID_NAME = `Annual Wellness Visit`

### PAT_HX_REVIEW
- PAT_ENC_CSN_ID = `724623985`
- LINE_COUNT = `1`
- CONTACT_DATE = `9/28/2023 12:00:00 AM`
- HX_REVIEWED_USER_ID = `RAMMELZL`
- HX_REVIEWED_USER_ID_NAME = `RAMMELKAMP, ZOE L`
- HX_REVIEWED_DATE = `9/28/2023 12:00:00 AM`
- HX_REVIEWED_INSTANT = `9/28/2023 9:57:00 AM`

### PAT_HX_REV_TOPIC
- PAT_ENC_CSN_ID = `724623985`
- GROUP_LINE = `1`
- VALUE_LINE = `1`
- HX_REVIEWED_HEADER = `Medical History (History Navigator Section - LQH 23401)`

### PAT_HX_REV_TYPE
- PAT_ENC_CSN_ID = `724623985`
- GROUP_LINE = `1`
- VALUE_LINE = `1`
- CONTACT_DATE = `9/28/2023 12:00:00 AM`
- HX_REVIEWED_TYPE_C_NAME = `Medical`

### PAT_MYC_MESG
- PAT_ENC_CSN_ID = `727947624`
- LINE = `1`
- PAT_ENC_DATE_REAL = `66745.03`
- CONTACT_DATE = `9/28/2023 12:00:00 AM`
- MYCHART_MESSAGE_ID = `68052804`

### PAT_REVIEW_ALLERGI
- PAT_ENC_CSN_ID = `829213099`
- LINE = `1`
- PAT_ID = `Z7004242`
- PAT_ENC_DATE_REAL = `65574`
- CONTACT_DATE = `7/14/2020 12:00:00 AM`
- PAT_REVIEW_ELG_ID = `25`
- PAT_REVIEW_ELG_ID_ALLERGEN_NAME = `PENICILLINS`
- PAT_REVIEW_ELG_R_YN = `Y`
- PAT_REVIEW_EXTERNAL = `Peanut (diagnostic)`

### PAT_REVIEW_DATA
- PAT_ENC_CSN_ID = `720803470`
- PAT_ID = `Z7004242`
- PAT_ENC_DATE_REAL = `66499`
- CONTACT_DATE = `1/25/2023 12:00:00 AM`
- PAT_ALG_RVW_INFO_C_NAME = `Patient indicated correct`
- PAT_PROB_RVW_INFO_C_NAME = `Patient indicated correct`

### PAT_REVIEW_PROBLEM
- PAT_ENC_CSN_ID = `948004323`
- LINE = `1`
- PAT_ID = `Z7004242`
- PAT_ENC_DATE_REAL = `66350`
- CONTACT_DATE = `8/29/2022 12:00:00 AM`
- PAT_REVIEW_LPL_ID = `30694847`
- PAT_REVIEW_LPL_R_YN = `Y`
- PAT_REV_LPL_EXTERN = `Post concussion syndrome`

### PAT_SOCIAL_HX_DOC
- PAT_ENC_CSN_ID = `958134730`
- LINE = `1`
- HX_SOCIAL_DOC = `Works for Microsoft. Works from home. Does software development. Originally from Massachusetts. Move`

### PAT_UCN_CONVERT
- PAT_ENC_CSN_ID = `720803470`
- LINE = `1`
- PAT_ENC_DATE_REAL = `66830`
- CONTACT_DATE = `12/22/2023 12:00:00 AM`
- LINKED_UCN_NOTES_ID = `4849759260`

### PAT_UTILIZATION_REVIEW
- PAT_ENC_CSN_ID = `720803470`
- PAT_ENC_DATE_REAL = `66535`
- CONTACT_DATE = `3/2/2023 12:00:00 AM`

### RESULT_FOLLOW_UP
- PAT_ENC_CSN_ID = `727947624`
- LINE = `1`
- CONTACT_DATE = `8/28/2018 12:00:00 AM`
- RESULT_ID = `439060607`

### SOCIAL_ADL_HX
- PAT_ENC_CSN_ID = `724623985`
- LINE = `1`
- HX_ADL_QUESTION_ID = `100211`
- HX_ADL_QUESTION_ID_RECORD_NAME = `ADOPTED`
- HX_ADL_RESPONSE_C_NAME = `Not Asked`

### TREATMENT
- PAT_ENC_CSN_ID = `720803470`
- LINE = `1`
- PAT_ENC_DATE_REAL = `66745.02`
- CONTACT_DATE = `9/28/2023 12:00:00 AM`
- TREATMENTS_ID = `945468370`

### TREATMENT_TEAM
- PAT_ENC_CSN_ID = `720803470`
- LINE = `1`
- PAT_ID = `Z7004242`
- CONTACT_DATE = `8/9/2018 12:00:00 AM`
- TR_TEAM_SPEC_C_NAME = `Internal Medicine`
- TR_TEAM_ID = `802011`
- TR_TEAM_REL_C_NAME = `Consulting Physician`
- TR_TEAM_BEG_DTTM = `8/9/2018 9:44:00 AM`
- TR_TEAM_END_DTTM = `8/9/2018 4:35:00 PM`

## Pipeline Code

### Stage 1: SQL Projection (project.ts → raw JSON)
```typescript
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
  if (tableExists("PAT_ENC_HSP")) {
    const hspForFlow = qOne(`SELECT INPATIENT_DATA_ID FROM PAT_ENC_HSP WHERE PAT_ENC_CSN_ID = ?`, [csn]);
    if (hspForFlow?.INPATIENT_DATA_ID) {
      const ipid = hspForFlow.INPATIENT_DATA_ID;
      enc.flowsheet_rows = children("IP_FLOWSHEET_ROWS", "INPATIENT_DATA_ID", ipid);
      // Get measurement IDs and fetch measurements
      const fsdIds = q(`SELECT FSD_ID FROM IP_FLWSHT_REC WHERE INPATIENT_DATA_ID = ?`, [ipid]);
      enc.flowsheet_measurements = fsdIds.flatMap((f) =>
        children("IP_FLWSHT_MEAS", "FSD_ID", f.FSD_ID)
      );
    }
  }

  return enc;
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
]
```

### Stage 2: Domain Model Hydration (PatientRecord.ts)
```typescript
export class Encounter {
  PAT_ENC_CSN_ID: CSN;
  PAT_ID?: string;
  contactDate?: string;
  encounterType?: string;
  visitProviderName?: string;
  departmentName?: string;
  diagnoses: EpicRow[] = [];
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
    this.encounterType = raw.ENC_TYPE_C_NAME as string;
    this.visitProviderName = raw._visit_provider as string;
    this.diagnoses = (raw.diagnoses as EpicRow[]) ?? [];
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
```

### Stage 3: Clean Projection (HealthRecord.ts → final output)
```typescript
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
```

## Actual Output (from health_record_full.json)

```json
{
  "visits": [
    {
      "id": "799951565",
      "date": "2020-01-09",
      "provider": "DHILLON, PUNEET S",
      "status": "Completed",
      "reasonsForVisit": [
        {
          "PAT_ENC_CSN_ID": 799951565,
          "LINE": 1,
          "ENC_REASON_ID": 520
        },
        {
          "PAT_ENC_CSN_ID": 799951565,
          "LINE": 2,
          "ENC_REASON_ID": 160690
        }
      ],
      "diagnoses": [
        {
          "name": "Gastroesophageal reflux disease, esophagitis presence not specified",
          "icdCode": "1181154",
          "isPrimary": true,
          "_epic": {
            "PAT_ENC_DATE_REAL": 65387,
            "LINE": 1,
            "CONTACT_DATE": "1/9/2020 12:00:00 AM",
            "PAT_ENC_CSN_ID": 799951565,
            "DX_ID": 1181154,
            "PRIMARY_DX_YN": "Y",
            "DX_CHRONIC_YN": "N",
            "DX_UNIQUE": "1",
            "DX_ED_YN": "N",
            "DX_LINK_PROB_ID": 30694847,
            "_dx_name": "Gastroesophageal reflux disease, esophagitis presence not specified"
          }
        },
        {
          "name": "Lipoma of head",
          "icdCode": "1236545",
          "isPrimary": false,
          "_epic": {
            "PAT_ENC_DATE_REAL": 65387,
            "LINE": 2,
            "CONTACT_DATE": "1/9/2020 12:00:00 AM",
            "PAT_ENC_CSN_ID": 799951565,
            "DX_ID": 1236545,
            "PRIMARY_DX_YN": "N",
            "DX_CHRONIC_YN": "N",
            "DX_UNIQUE": "2",
            "DX_ED_YN": "N",
            "_dx_name": "Lipoma of head"
          }
        },
        {
          "name": "Nevus",
          "icdCode": "212474",
          "isPrimary": false,
          "_epic": {
            "PAT_ENC_DATE_REAL": 65387,
            "LINE": 3,
            "CONTACT_DATE": "1/9/2020 12:00:00 AM",
            "PAT_ENC_CSN_ID": 799951565,
            "DX_ID": 212474,
            "PRIMARY_DX_YN": "N",
            "DX_CHRONIC_YN": "N",
            "DX_UNIQUE": "3",
            "DX_ED_YN": "N",
            "_dx_name": "Nevus"
          }
        }
      ],
      "orders": [
        {
          "id": "439060608",
          "name": "AMB REFERRAL TO GASTROENTEROLOGY",
          "type": "Outpatient Referral",
          "status": "Sent",
          "orderedDate": "2020-01-09T12:53:00.000Z",
          "_epic": {
            "ORDER_PROC_ID": 439060608,
            "description": "AMB REFERRAL TO GASTROENTEROLOGY",
            "procedureName": "AMB REFERRAL TO GASTROENTEROLOGY",
            "orderType": "Outpatient Referral",
            "orderStatus": "Sent",
            "orderClass": "External Referral",
            "orderDate": "1/9/2020 12:53:00 PM",
            "PAT_ID": "Z7004242",
            "PAT_ENC_DATE_REAL": 65387,
            "PAT_ENC_CSN_ID": 799951565,
            "ORDERING_DATE": "1/9/2020 12:00:00 AM",
            "ORDER_TYPE_C_NAME": "Outpatient Referral",
            "PROC_ID": 91,
            "DESCRIPTION": "AMB REFERRAL TO GASTROENTEROLOGY",
       
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