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

Analyze the mapping pipeline for **Notes: HNO_INFO + children → notes** and identify every semantic error — places where a column is read successfully but the value means something different than the code assumes.

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

### ABN_FOLLOW_UP
**Table**: This table stores the data related to the follow up done on an Advanced Beneficiary Notice (ABN).
- **NOTE_CSN_ID**: The contact serial number (CSN) of the contact.
- **NOTE_ID**: The unique ID of the note (HNO) record that contains the Advance Beneficiary Notice (ABN) information.
- **CONTACT_DATE_REAL**: A unique contact date in decimal format. The integer portion of the number indicates the date of contact. The digits after the decimal distinguish different contacts on the same date and are unique for each contact on that date. For example, .00 is the first/only contact, .01 is the second contact, etc.
- **CONTACT_DATE**: The date of this contact in calendar format.
- **CONTACT_NUM**: The number of this contact.
- **ABN_FLUP_USER_ID**: Stores the user who did the follow up on this ABN
- **ABN_FLUP_USER_ID_NAME**: The name of the user record. This name may be hidden.
- **ABN_FOLLOW_UP_INST_DTTM**: Stores the instant at which the follow up was done.
- **ABN_FLUP_STATUS_C_NAME**: Stores the status of the Advance Beneficiary Notice (ABN) follow-up.

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

### HNO_ORDERS
**Table**: Orders that are associated to the note.
- **NOTE_ID**: The unique identifier (.1 item) for the note record.
- **LINE**: The line number for the information associated with this record. Multiple pieces of information can be associated with this record.
- **ORDER_ID**: The order ID associated to the note.
- **ORDER_DAT**: The order DAT associated to the note.

### HNO_PLAIN_TEXT
**Table**: This table extracts notes that are stored only in plain text. This table does not contain any notes that are stored in rich text. HNO_NOTE_TEXT should still be used for reporting purposes.
- **NOTE_CSN_ID**: The contact serial number (CSN) of the contact.
- **LINE**: The line number for the information associated with this contact. Multiple pieces of information can be associated with this contact.
- **NOTE_ID**: The unique identifier (.1 item) for the note record.
- **NOTE_TEXT**: Content of the plain text note.

### NOTES_LINK_ORD_TXN
**Table**: Orders linked to/from the HNO (notes) master file by order based transcriptions.
- **NOTE_ID**: The unique ID associated with the note record for this row.
- **LINE**: The line number for the information associated with this record. Multiple pieces of information can be associated with this record.
- **LINKED_ORD_ID**: Orders linked to/from the note records by order based transcriptions.

### NOTE_CONTENT_INFO
**Table**: This table contains discrete information pertaining to the type of content contained within the note text of a clinical note.
- **NOTE_CSN_ID**: The contact serial number (CSN) of the contact.
- **LINE**: The line number for the information associated with this contact. Multiple pieces of information can be associated with this contact.
- **NOTE_ID**: The unique identifier for the note record.
- **CONTACT_DATE_REAL**: A unique contact date in decimal format. The integer portion of the number indicates the date of contact. The digits after the decimal distinguish different contacts on the same date and are unique for each contact on that date. For example, .00 is the first/only contact, .01 is the second contact, etc.
- **CONTACT_DATE**: The date of this contact in calendar format.

### NOTE_ENC_INFO
**Table**: This table contains information from overtime single-response items about General Use Notes (HNO) records. Contact creation logic for clinical notes is as follows: 1. If a note doesn't exist, a new note is created. This represents the first contact on that note. 2. If a revision is filed by the incoming transcription interface, a new contact is created on the note being revised regardless of note status.
- **NOTE_ID**: The unique identifier for the note record.
- **CONTACT_SERIAL_NUM**: The contact serial number (CSN) of the contact.
- **CONTACT_DATE_REAL**: A unique, internal contact date in decimal format. The integer portion of the number indicates the date of the contact. The digits after the decimal distinguish different contacts on the same date and are unique for each contact on that date. For example, .00 is the first/only contact, .01 is the second contact, etc.
- **COSIGN_INSTANT_DTTM**: The instant when the note was cosigned.
- **COSIGNUSER_ID**: The user who cosigned the note.
- **COSIGNUSER_ID_NAME**: The name of the user record. This name may be hidden.
- **COSIGN_NOTE_LINK**: A note contact serial number (CSN) that points to the attending's note that cosigned this one.
- **COSIGN_REQUIRED_C_NAME**: The cosign requirement for the current note contact.
- **AUTH_LNKED_PROV_ID**: The author's linked provider record.
- **AUTHOR_SERVICE_C_NAME**: The author's clinical service.
- **ENTRY_INSTANT_DTTM**: UTC formatted instant of entry for a note.
- **UPD_AUTHOR_INS_DTTM**: UTC instant of update by a specific user.
- **SPEC_NOTE_TIME_DTTM**: The note's specified date paired with the specified time.
- **NOTE_FILE_TIME_DTTM**: UTC formatted instant of when a note is filed.
- **AUTHOR_PRVD_TYPE_C_NAME**: Author's provider type on a specific contact.
- **NOTE_STATUS_C_NAME**: The status of the note.
- **UPDATE_USER_ID**: The id of the user who updated this contact of the note.
- **UPDATE_USER_ID_NAME**: The name of the user record. This name may be hidden.
- **CONTACT_DATE**: The date of this contact in calendar format.
- **TRN_DOC_AVAIL_STA_C_NAME**: The availability status of the transcription.
- **TRN_DOC_TYPE_C_NAME**: The document type of the transcription.
- **SENSITIVE_STAT_C_NAME**: Sensitive status of a note.
- **AUTHOR_USER_ID**: The unique ID associated with the user who is the author of the note.
- **AUTHOR_USER_ID_NAME**: The name of the user record. This name may be hidden.
- **NOTE_FORMAT_C_NAME**: The format of the note text like Plain Text, Rich Text, HTML etc.
- **UPD_BY_AUTH_DTTM**: The instant when the note is updated by the author.
- **ACTIVITY_DTTM**: The activity date and time of the partial dictation/transcription.
- **AUTH_STAT_C_NAME**: The authentication status category number for this activity if this note is a transcription. This is also known as the completion status.
- **CONTACT_NUM**: Contact number for the record.
- **UPD_AUT_LOCAL_DTTM**: Update by author instant in local format.
- **ENT_INST_LOCAL_DTTM**: Note entry instant in local format.
- **SPEC_TIME_LOC_DTTM**: Note specified instant in local format.
- **NOT_FILETM_LOC_DTTM**: Note file time in local format.
- **EDIT_USER_ID**: The unique ID associated with the user record who edited the note for this particular contact. This is populated for notes with note type 76-Simple Med Note, 77-Medication History, etc. This column is frequently used to link to the CLARITY_EMP table.
- **EDIT_USER_ID_NAME**: The name of the user record. This name may be hidden.
- **DOCUMENT_NAME**: Contains the name of the multi-part document.
- **UMRG_SRC_MEDPROB_ID**: The unique ID of the Med Problem List record.
- **ECG_COMMENTS**: Comments about the Electrocardiogram (ECG/EKG).
- **ECG_EDITED_USER_ID**: The person who edited the Electrocardiogram (ECG/EKG).
- **ECG_DIASTOLIC_BP**: The diastolic blood pressure taken from the Electrocardiogram (ECG/EKG).
- **ECG_SYSTOLIC_BP**: The systolic blood pressure taken from the Electrocardiogram (ECG/EKG).
- **ECG_HEARTRATE**: The heartrate from the Electrocardiogram (ECG/EKG).
- **ECG_PR_INTERVAL**: The interval from the beginning of the P wave to the beginning of the QRS wave on the Electrocardiogram (ECG/EKG).
- **ECG_PWAVEAXIS**: The P wave axis on the Electrocardiogram (ECG/EKG).
- **ECG_QRS_DURATION**: The duration of the QRS complex/wave on the Electrocardiogram (ECG/EKG).
- **ECG_QRS_WAVEAXIS**: The QRS complex/wave axis on the Electrocardiogram (ECG/EKG).
- **ECG_QT_INTERVAL**: The interval from the start of the QRS complex/wave to the end of the T wave on the Electrocardiogram (ECG/EKG).
- **ECG_QTC_INTERVAL**: The corrected QT interval for the Electrocardiogram (ECG/EKG).
- **ECG_T_WAVEAXIS**: The T wave axis for the Electrocardiogram (ECG/EKG).
- **SPIRO_BRON**: Stores the type of bronchodilator given to the patient (ex: Albuterol).
- **CARE_PLAN_CSN_ID**: Link to care plan contact.  Used to recreate historic versions of care plan.
- **PROGRESS_NOTE_ID**: Progress note ID for the careplan goal note.
- **PRE_UCN_NOTE_TYPE_C_NAME**: This virtual item is populated with a category value from the note type (I HNO 50) according to the following logic:   * if the note type (I HNO 50) is populated, use the value directly * if the note type (I HNO 50) is null and the note is not ambulatory, return null   * if the note type (I HNO 50) is null and the note has an ambulatory encounter context, obtain a category from the UCN note type (I HNO 34033) and map that value to an equivalent category from the note type (I HNO 50), if possible
- **TRANSCRIPTION_DTTM**: The transcription date and time.
- **CSGN_RECPNT_USER_ID**: The unique ID associated with the user who is supposed to cosign the note.
- **CSGN_RECPNT_USER_ID_NAME**: The name of the user record. This name may be hidden.
- **TREAT_SUMM_PAT_DTTM**: This column stores the UTC instant that a treatment summary note is given to the patient.
- **TREAT_SUMM_PROV_DTTM**: This column stores the UTC instant that a treatment summary note is given to the follow-up provider.
- **TREAT_SUMM_CPLT_DTTM**: This column saves the UTC instant that a treatment summary note is marked as complete.
- **PAT_ENC_CSN_ID**: This column stores the patient encounter contact serial number (CSN) in which the note was edited. Used for persistent notes to determine in which encounter the note was edited.
- **END_OF_TREAT_DATE**: This column saves the end of treatment date for a treatment summary.
- **UNMERGE_SRC_NOTE_ID**: The source note ID before patient merge.
- **NOTE_SHARED_W_PAT_HX_YN**: Was this note contact marked as eligible for sharing with the patient when it was last saved?  Notes will only be displayed in MyChart if their most recent contact is marked for sharing. If you want to determine if a note is currently shared, use the NOTE_SHARED_W_PAT_YN column in the HNO_INFO table instead of this one.
- **NOTE_TYPE_C_NAME**: Identifies what type of note this record is.
- **POC_NOTE_DISC_C_NAME**: This item stores the hospice Plan of Care note discipline.
- **COSIGN_INST_LOCAL_DTTM**: The instant in local time when the note was cosigned.
- **IS_PRECHARTED_YN**: This indicates whether or not the note is currently a pre-charted note (in appointment encounter).
- **LINK_DXR_CSN_ID**: Link to the DXR contact that holds the NoteReader data for this note's contact.
- **CLINICAL_NOTE_SUMMARY**: This item stores a plain text summary of the note contents.
- **BLOCK_REASON_C_NAME**: Stores a discrete reason why a note was blocked from the patient.
- **BLOCK_REASON_TXT**: Stores a free text comment with additional information about why a note was blocked from the patient.

### NOTE_ENC_INFO_2
**Table**: This table extends HNO_ENC_INFO.
- **NOTE_CSN_ID**: The contact serial number (CSN) of the contact.
- **NOTE_ID**: The unique identifier (.1 item) for the note record.
- **CONTACT_DATE_REAL**: A unique contact date in decimal format. The integer portion of the number indicates the date of contact. The digits after the decimal distinguish different contacts on the same date and are unique for each contact on that date. For example, .00 is the first/only contact, .01 is the second contact, etc.
- **CONTACT_DATE**: The date of this contact in calendar format.
- **CONTACT_NUM**: Contact number
- **CM_CT_OWNER_ID**: The Community ID (CID) of the instance that owns this contact. This is only populated if you use IntraConnect.
- **EXT_SHARED_W_PT_YN**: Autoreconciled external note share with patient status
- **EXT_AUTH_NAME**: Autoreconciled external note author free text name
- **EXT_AUTH_SPEC_C_NAME**: Autoreconciled external note author specialty
- **EXT_AUTH_TYPE**: Autoreconciled external note author type
- **EXT_AUTH_SERV**: Autoreconciled external note author service text
- **EXT_LAST_SIGNER**: Autoreconciled external note last signer name
- **EXT_LAST_SIGN_UTC_DTTM**: External note signer instant
- **NOTE_AUTHOR_TYPE_C_NAME**: The internal provider type of a note's author, mapped from the transmitted NUCC code.

### V_EHI_HNO_LINKED_PATS
**Table**: Placeholder view for HNO EHI data that needs to be marked as both static and dynamic.
- **NOTE_ID**: The unique identifier (.1 item) for the note record.
- **LINE**: The line number for the information associated with this record. Multiple pieces of information can be associated with this record.
- **LINKED_PAT_ID**: The list of patients (EPT) that this HNO is associated with for Electronic Health Information (EHI) Export
- **CM_LOG_OWNER_ID**: The Community ID (CID) of the instance from which this record or line was extracted. This is only populated if you use IntraConnect.

## Sample Data (one representative non-null value per column)

### ABN_FOLLOW_UP
- NOTE_CSN_ID = `1335232077`
- NOTE_ID = `3432308299`
- CONTACT_DATE_REAL = `66157`
- CONTACT_DATE = `2/17/2022 12:00:00 AM`
- CONTACT_NUM = `1`

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

### HNO_ORDERS
- NOTE_ID = `1473734099`
- LINE = `1`
- ORDER_ID = `439060606`
- ORDER_DAT = `56661.99`

### HNO_PLAIN_TEXT
- NOTE_CSN_ID = `1335234994`
- LINE = `1`
- NOTE_ID = `1483895113`
- NOTE_TEXT = `Please call the patient with normal result.`

### NOTES_LINK_ORD_TXN
- NOTE_ID = `1483895113`
- LINE = `1`
- LINKED_ORD_ID = `439060607`

### NOTE_CONTENT_INFO
- NOTE_CSN_ID = `1335248961`
- LINE = `1`
- NOTE_ID = `1576929392`
- CONTACT_DATE_REAL = `65056`
- CONTACT_DATE = `2/12/2019 12:00:00 AM`

### NOTE_ENC_INFO
- NOTE_ID = `1473625808`
- CONTACT_SERIAL_NUM = `1335232077`
- CONTACT_DATE_REAL = `64869`
- COSIGN_REQUIRED_C_NAME = `Cosign Not Required`
- AUTH_LNKED_PROV_ID = `554383`
- ENTRY_INSTANT_DTTM = `8/28/2018 1:40:00 PM`
- UPD_AUTHOR_INS_DTTM = `8/28/2018 1:40:00 PM`
- SPEC_NOTE_TIME_DTTM = `8/28/2018 1:40:00 PM`
- NOTE_FILE_TIME_DTTM = `8/28/2018 1:40:00 PM`
- AUTHOR_PRVD_TYPE_C_NAME = `Registered Nurse`
- NOTE_STATUS_C_NAME = `Signed`
- UPDATE_USER_ID = `DMW400`
- UPDATE_USER_ID_NAME = `WILD, DAWN M`
- CONTACT_DATE = `8/9/2018 12:00:00 AM`
- TRN_DOC_AVAIL_STA_C_NAME = `Available`
- TRN_DOC_TYPE_C_NAME = `Physician Orders`
- SENSITIVE_STAT_C_NAME = `Not Sensitive`
- AUTHOR_USER_ID = `DHILLOPS`
- AUTHOR_USER_ID_NAME = `DHILLON, PUNEET S`
- NOTE_FORMAT_C_NAME = `Rich Text`
- UPD_BY_AUTH_DTTM = `7/15/2020 1:39:00 PM`
- AUTH_STAT_C_NAME = `Authenticated`
- CONTACT_NUM = `1`
- UPD_AUT_LOCAL_DTTM = `8/28/2018 8:40:00 AM`
- ENT_INST_LOCAL_DTTM = `8/28/2018 8:40:00 AM`
- SPEC_TIME_LOC_DTTM = `8/28/2018 8:40:00 AM`
- NOT_FILETM_LOC_DTTM = `8/28/2018 8:40:00 AM`
- DOCUMENT_NAME = `ZAPL SMALL BALANCE LETTER`
- PRE_UCN_NOTE_TYPE_C_NAME = `RTF Letter`
- NOTE_SHARED_W_PAT_HX_YN = `Y`
- NOTE_TYPE_C_NAME = `RTF Letter`
- IS_PRECHARTED_YN = `N`

### NOTE_ENC_INFO_2
- NOTE_CSN_ID = `1335232077`
- NOTE_ID = `4072443549`
- CONTACT_DATE_REAL = `66465`
- CONTACT_DATE = `12/22/2022 12:00:00 AM`
- CONTACT_NUM = `1`

### V_EHI_HNO_LINKED_PATS
- NOTE_ID = `1473622964`
- LINE = `1`
- LINKED_PAT_ID = `Z7004242`

## Pipeline Code

### Stage 1: SQL Projection (project.ts → raw JSON)
```typescript
function projectNote(noteId: unknown): EpicRow {
  const rows = mergeQuery("HNO_INFO", `b."NOTE_ID" = ?`, [noteId]);
  const note = rows[0] ?? { NOTE_ID: noteId };
  attachChildren(note, noteId, noteChildren);
  return note;
}

const noteChildren: ChildSpec[] = [
  { table: "HNO_PLAIN_TEXT", fkCol: "NOTE_ID", key: "text" },
  { table: "ABN_FOLLOW_UP", fkCol: "NOTE_ID", key: "metadata" },
  { table: "NOTE_ENC_INFO", fkCol: "NOTE_ID", key: "encounter_info", merged: true },
  { table: "NOTE_CONTENT_INFO", fkCol: "NOTE_ID", key: "content_info" },
  { table: "V_EHI_HNO_LINKED_PATS", fkCol: "NOTE_ID", key: "linked_patients" },
  { table: "HNO_ORDERS", fkCol: "NOTE_ID", key: "linked_orders" },
  { table: "NOTES_LINK_ORD_TXN", fkCol: "NOTE_ID", key: "linked_order_txns" },
]
```

### Stage 2: Domain Model Hydration (PatientRecord.ts)
```typescript
export class Note {
  NOTE_ID: EpicID;
  noteType?: string;
  noteStatus?: string;
  authorName?: string;
  createdDate?: string;
  encounterCSN?: CSN;
  text: EpicRow[] = [];
  metadata: EpicRow[] = [];
  encounterInfo: EpicRow[] = [];

  constructor(raw: EpicRow) {
    Object.assign(this, raw);
    this.NOTE_ID = raw.NOTE_ID as EpicID;
    this.noteType = raw.IP_NOTE_TYPE_C_NAME as string;
    this.noteStatus = raw.NOTE_STATUS_C_NAME as string;
    this.encounterCSN = raw.PAT_ENC_CSN_ID as CSN;
    this.text = (raw.text as EpicRow[]) ?? [];
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