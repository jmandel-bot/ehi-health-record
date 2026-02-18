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

Analyze the mapping pipeline for **Documents: DOC_INFORMATION + children** and identify every semantic error — places where a column is read successfully but the value means something different than the code assumes.

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

### DOCS_RCVD_ALGS
**Table**: This table stores discrete allergies information received from outside sources.
- **DOCUMENT_ID**: This item stores the Received Document record ID.
- **CONTACT_DATE_REAL**: This is a numeric representation of the date of this encounter in your system. The integer portion of the number specifies the date of the encounter. The digits after the decimal point indicate multiple visits on one day.
- **LINE**: The line number for the information associated with this contact. Multiple pieces of information can be associated with this contact.
- **ALG_REF_ID**: This item stores a unique reference identifier to identify a specific instance of an allergy.
- **ALG_SEVERITY_C_NAME**: This item stores the overall allergy severity.
- **ALG_DATE_NOTED_DT**: This item stores the date when the allergy was noted by the external system.
- **ALG_DATE_RESOLVD_DT**: This item stores the date of when the allergy was resolved.
- **ALG_SRC_LPL_ID**: This item stores the source Problem List record identifier.
- **ALG_TYPE_OF_CHNG_C_NAME**: This item stores the type of change being performed on the allergy.
- **ALGN_NAME**: This item stores the display name of the allergen as sent by the external source.
- **ALGN_ID**: This item stores the Allergen record identifier that maps to the allergen from the external source.
- **ALGN_ID_ALLERGEN_NAME**: The name of the allergen record.
- **ALG_TYPE**: This item stores the textual allergy type sent by the external source.
- **ALG_TYPE_ID_C_NAME**: This item stores the category value which maps to the allergy type sent by  the external source.
- **ALG_SRC_DXR_CSN**: This item will store the contact serial (CSN) number of the Received Document record that owns the instance of this allergy.
- **ALG_DUP_OVRD_LPL_ID**: This item stores the record identifier of the local allergy that this external allergy should be grouped with.
- **ALG_LAST_UPD_DTTM**: This item stores the date and time when the allergy was last updated by the external system.
- **ALG_PT_SRC_APP_C_NAME**: If this allergy is a patient-entered allergy (i.e. DXR type = 25), this item stores the application which was used to edit the allergy for the contact (e.g. MyChart or Welcome). If blank, this is assumed to be MyChart.
- **ALGRX_TYPE**: This item stores the text value of the allergy reaction type sent by the external source.
- **ALGRX_TYPE_ID_C_NAME**: This item stores the category value which maps to the allergy reaction type sent by the external source.
- **ALG_DT_NOTED_NF_C_NAME**: This item stores the nullFlavor value from the effectiveTime low node in a received CDA document.
- **ALG_DT_RESOLV_NF_C_NAME**: This item stores the nullFlavor value from the effectiveTime high node in a received CDA document.
- **ALG_STATE_C_NAME**: This item stores the value from the statusCode node in a received CDA document. This item itself is not the status of the allergy.
- **ALG_STATUS_ENTRY_C_NAME**: This item stores the value from the status entryRelationship node in a received CDA document. This item itself is not the status of the allergy.
- **ALG_HIST_STATUS_C_NAME**: The item indicates whether the allergy is current or historical.
- **ALG_HIST_DATE**: This item stores the date that the historical status for this allergy is valid through. After this date, the historical status needs to be rechecked.
- **ALG_SRC_WPR_ID**: Stores the Patient Access Accounts ID of the MyChart user who edited the allergy for the contact.
- **ALG_CRITICALITY_C_NAME**: This item stores the category value for overall allergy criticality.
- **ALG_CRITICALITY_TXT**: This item stores the free text allergy criticality.
- **ALG_PAT_ENC_CSN_ID**: Stores the contact serial number (CSN) of the encounter that the allergy was added on.

### DOCS_RCVD_ASMT
**Table**: Table to maintain information related to assessments and risk scores. The information stored in this table was received from outside sources.
- **DOCUMENT_ID**: This item stores the Received Document record ID.
- **CONTACT_DATE_REAL**: A unique contact date in decimal format. The integer portion of the number indicates the date of contact. The digits after the decimal distinguish different contacts on the same date and are unique for each contact on that date. For example, .00 is the first/only contact, .01 is the second contact, etc.
- **LINE**: The line number for the information associated with this contact. Multiple pieces of information can be associated with this contact.
- **CONTACT_DATE**: The date of this contact in calendar format.
- **ASMT_REF_ID**: This item stores the unique reference identifier associated with the assessment.
- **ASMT_SRC_DXR**: The Contact Serial Number (CSN) of the received document record from which the assessment for this row was sourced.
- **ASMT_VAL**: Value associated with this assessment.
- **ASMT_UNIT**: Unit associated with this assessment.
- **ASMT_DATETIME**: The clinically relevant date for this assessment. This could be the recorded date or the date of an update for a current assessment.
- **ASMT_LAST_UPD_INST_DTTM**: This item stores the last update instant of this assessment in UTC.
- **ASMT_NAME**: This item stores the assessment name sent by the external source.
- **ASMT_STATUS_C_NAME**: The ASMT_STATUS_C column contains the status of a received assessment. Under normal circumstances, only cancelled or removed statuses will be filled out.
- **ASMT_EXT_DATA_FILTER_REASON_C_NAME**: Stores the reason why an external assessment was filtered from the composite record (I DXR 14712)

### DOCS_RCVD_PROC
**Table**: This table stores procedure information received from outside sources.
- **DOCUMENT_ID**: The unique identifier for the document record.
- **CONTACT_DATE_REAL**: A unique contact date in decimal format. The integer portion of the number indicates the date of contact. The digits after the decimal distinguish different contacts on the same date and are unique for each contact on that date. For example, .00 is the first/only contact, .01 is the second contact, etc.
- **LINE**: The line number for the information associated with this contact. Multiple pieces of information can be associated with this contact.
- **CONTACT_DATE**: The date of this contact in calendar format.
- **PROC_REF_ID**: This item stores the unique reference ID.
- **PROC_TYPE_ID**: This item stores the mapped procedure record ID for the external procedure.
- **PROC_TYPE_TXT**: This item stores the free text name for the external procedure.
- **PROC_PERF_AT_ID**: This item stores the facility record mapped location where the external procedure was performed.
- **PROC_PERF_AT_TXT**: This item stores the free text location where the external procedure was performed.
- **PROC_START_DATE**: This item stores the start date of the external procedure.
- **PROC_END_DATE**: This item stores the end date of the external procedure.
- **PROC_EVENT_ID**: This item holds the event identifier of the event information for the procedure.
- **PROC_MASTER_REF_ID**: This item will be used to indicate duplicate procedure data.
- **PROC_LST_UPD_INST_DTTM**: Stores the last update instant of the procedure in Coordinated Universal Time (UTC).
- **PROC_UNSUCCESSFUL_FLG_C_NAME**: Indicates whether a procedure was an unsuccessful attempt
- **PROC_UNSUCCESS_INST_UTC_DTTM**: Instant the procedure unsuccessful flag was set
- **PROC_STATE_C_NAME**: This item contains the status code of a procedure when received from a document.
- **PROC_DUP_INT_PROC_ID**: Stores the ID of the Order record of an internal charge that is a duplicate of this row in an external document record.
- **PROC_DUP_INT_UCL_ID**: Stores the ID of the Universal Charge Lines record of an internal charge that is a duplicate of this row in an external document record.
- **PROC_DUP_INT_TX_ID**: Stores the ID of the Accounts Receivable Transaction record of an internal charge that is a duplicate of this row in an external document record.
- **PROC_DUP_INT_HOSP_TX_ID**: Stores the ID of the Hospital Permanent Transaction record of an internal charge that is a duplicate of this row in an external document record.
- **PROC_FILTER_RSN_C_NAME**: Stores the reason why an external procedure should be filtered from the composite record

### DOC_CSN_REFS
**Table**: This table contains references to the document from patient contacts, by contact serial number.  It is populated by the Consents navigator section.
- **DOCUMENT_ID**: The unique identifier for the document record.
- **LINE**: The line number for the information associated with this record. Multiple pieces of information can be associated with this record.
- **CSN_REFERENCE**: This item contains the patient contacts (by contact serial number) that reference this document.  A reference here does not imply the document was created during any of these contacts and is different from the encounter storage level for documents (provided by I DCS 280); it is simply an indicator of relevance.  If this item is populated, a document should not be allowed to move between patients.  The user must remove all of these references manually before a patient change can occur.

### DOC_INFORMATION
**Table**: The DOC_INFORMATION table contains information about documents, including scanned and electronically signed documents.
- **DOC_INFO_ID**: The unique ID of the document information record.
- **DOC_INFO_TYPE_C_NAME**: The type of document described by this document information.
- **DOC_STAT_C_NAME**: The current status of the document described by this document information.
- **DOC_DESCR**: A short free text description of the document described by this document information.
- **DOC_RECV_TIME**: The date and time the document described by this document information was received.
- **RECV_BY_USER_ID**: The employee who received the document described by this document information. This ID may be encrypted.
- **RECV_BY_USER_ID_NAME**: The name of the user record. This name may be hidden.
- **PAT_REP**: The free text name of the person who legally represents the patient described by this document information.
- **DT_ON_DOC**: The date which appears on the document described by this document information.
- **DOC_EXPIR_TIME**: The date and time the document described by this document information expires.
- **DOC_LOC**: A short free text description of the location of the paper copy of the document described by this document information.
- **IS_SCANNED_YN**: Specifies whether there is a scanned image version of the document described by this document information.
- **SCAN_TIME**: The date and time the document described by this document information was scanned.
- **SCAN_BY_USER_ID**: The employee who scanned the document described by this document information. This ID may be encrypted.
- **SCAN_BY_USER_ID_NAME**: The name of the user record. This name may be hidden.
- **SCAN_DEP_ID**: The department where the document described by this document information was scanned.
- **SCAN_FILE**: The file name of the scanned image version of the document described by this document information.
- **IS_ESIGNED_YN**: Specifies whether the document described by this document information has been electronically signed.
- **ESIGN_TIME**: The date and time the document described by this document information was electronically signed.
- **WITNESS_BY_USER_ID**: The employee who witnessed the electronic signing of the document described by this document information. This ID may be encrypted.
- **WITNESS_BY_USER_ID_NAME**: The name of the user record. This name may be hidden.
- **ESIGN_DEP_ID**: The department where the document described by this document information was electronically signed.
- **ESIGN_HTML_FILE**: The file name of either the template HTML file of the document to be electronically signed prior to it being electronically signed or the unique file name of the HTML file of the electronically signed document described by this document information.
- **DOC_REQ_DT**: The date when a copy of the type of document described by this document information was requested.
- **IS_REQ_YN**: Specifies whether the type of document described by this document information was requested.
- **DOC_EFF_TIME**: The date and time the document described by this document information becomes effective.
- **IS_EFF_YN**: Specifies whether the document is in effect.
- **DOC_DISCL_DT**: The date when a copy of the document described by this document information was last disclosed.
- **DOC_REVOK_DT**: The date when the type of document described by this document information was revoked.
- **IS_REVOK_YN**: Specifies whether the document was revoked.
- **DOC_LOCATION_C**: The category entry for the location of the document.
- **DOC_PT_ID**: The unique ID of the patient associated with the document record.
- **DOC_CSN**: This stores the contact serial number of the encounter that this record is attached to, if applicable.
- **DOC_CLM_ID**: Stores Claim (CLM) ID for the claim that the document is associated with, used by Tapestry.
- **DOC_CVG_ID**: Stores Coverage (CVG) ID for the coverage that the document is associated with, used by Tapestry.
- **DOC_NCS_ID**: Stores customer service (NCS) ID for the customer relationship management (CRM) that the document is associated with, used by Tapestry.
- **DOC_NMM_ID**: Stores the case master (NMM) ID for the case that the document is associated with, used by Tapestry.
- **DOC_RFL_ID**: Stores Referral (RFL) ID for the Referral that the document is associated with, used by Tapestry.
- **DOC_SER_ID**: Stores Provider/Resource Directory ID (SER) for the provider that the document is associated with, used by Tapestry.
- **RECORD_STATE_C_NAME**: The record state category number for the document record.
- **SOURCE_ETX_ID**: Stores the SmartText (ETX) ID that this document (DCS) record was created from.
- **SOURCE_ETX_ID_SMARTTEXT_NAME**: The name of the SmartText record.
- **DOC_HNO_ID**: The unique ID of the note record associated with this document.
- **SCAN_LWS_ID**: This item stores the id of the workstation where the document was scanned.
- **ESIG_SIGNED_BY**: eSignature of person document was signed by.
- **ESIGNED_REL_C_NAME**: The relationship between the patient and the person who signed the form (self, parent, spouse, etc.).
- **DOC_SRVC_DTTM**: The service date and time of the document.
- **SCAN_INST_DTTM**: This item stores the most clinically relevant date for the document. From top to bottom, it looks to the service date/time (I DCS 246/247), the order prioritized instant (I ORD 24), the encounter date, and the import date/time (I DCS 310/315).
- **DOC_STORAGE_LVL_C_NAME**: The level at which the document is attached to the patient's record. For example, the document could be stored at the patient, encounter, or hospital account level.
- **SOURCE_DOC**: The identifier for the document (DCS) record's source document.  This column is only populated for DCS records of type Discharge Attachments. If the document was created from a SmartText (ETX) record, this column contains the ID of that ETX record. If the document was created from an HTML document in the References Activity, this column contains the unique identifier from the CRS.mdb file.
- **DOC_CREAT_DEPT_ID**: The department where this document was created.
- **PT_ENT_DRAW_STAT_C_NAME**: Holds the status of the documents (DCS) record - Is it ready to show?
- **PT_ENT_DRAWING_CMT**: Holds any associated comments from a patient-entered drawing question. Only present for documents (DCS) records of type 32010 used by MyChart and Welcome.
- **PHOTO_APPROVED_C_NAME**: Whether or not this document (DCS) record is in the history of the patient's photos.  If not, includes the reason the photo was rejected.
- **PHOTO_APRV_APPL_C_NAME**: The application that processed the approval/denial of the photo.
- **WEB_USER_ID**: This item holds the ID of the MyChart user who created this document record, for patient-generated document records.
- **NEED_ENC_YN**: This item is used to denote whether a document needs to be attached to an encounter or not. For Patient level documents this would always be No. For encounter level documents, depending on whether it is attached or detached from an encounter, this would say No or Yes respectively.
- **PERFORMING_PROV_ID**: Used to store the Provider's name who is performing the procedure mentioned in the e-signature consent form.
- **ESIG_TMPLT_USED**: Stores a link to the template used to sign the document
- **TMPLT_SF_CNTCT**: Contact of the SmartForm used to collect information for this document.
- **RESEARCH_STUDY_ID**: Stores the ID of the research study associated with this document.
- **FT_CONSENT_PROCS**: Stores free text procedures for consent documents
- **ORIGINAL_DOC_ID**: Stores the link to the original (unannotated) document.
- **DOC_SPECIALTY_C_NAME**: This item can be extended to hold possible values for the specialty that a document can be associated with.
- **DOC_SRVR_NAME_C_NAME**: This item stores the desktop integration (FDI) record that was used for scanning the document.
- **DOC_SOURCE_INFO_C_NAME**: Determines the source of the document rather than the document's type.
- **RX_CUST_ID_TYPE_C_NAME**: This item contains the categories for the types of customer ID documents used to pick up prescriptions from outpatient pharmacies.
- **RX_CUST_ID_NUM**: This item contains the customer ID number.
- **CE_SERVICE_START_DATE**: Service start date for a received Care Everywhere external authorization
- **CE_SERVICE_END_DATE**: Service end date for a received Care Everywhere external authorization
- **DOC_PND_APRV_STAT_C_NAME**: Holds status of document undergoing review
- **DOC_REJ_RSN_C_NAME**: Denial reason
- **DOC_REJ_RSN_TEXT**: Rejection reason freetext
- **COMM_ORIG_LRP_ID**: This item stores the original report (LRP) ID when a report is converted to a PDF.
- **COMM_ORIG_LRP_ID_REPORT_NAME**: The name of the report
- **CREATED_STUDY_AMENDMENT**: The ID of the research study amendment considered to be the consent version signed for Research Consent type document (DCS) records. Use the RESEARCH_STUDY_ID column to link to RESEARCH_VERSION_INFO table which has the user-entered version number (STUDY_VERSION) as well as other information.
- **EFF_STUDY_AMENDMENT**: The ID of the research study amendment considered to be the current effective version for Research Consent type document (DCS) records. Use the RESEARCH_STUDY_ID column to link to RESEARCH_VERSION_INFO table which has the user-entered version number (STUDY_VERSION) as well as other information.

### DOC_INFORMATION_2
**Table**: The DOC_INFORMATION table contains information about documents, including scanned and electronically signed documents.
- **DOCUMENT_ID**: The unique identifier (.1 item) for the document record.
- **DOC_RDI_ID**: Stores the linked form (RDI) that contains key-value pairs.
- **COMM_ORIG_RDI_ID**: This item stores the original form (RDI) ID when a form is converted to a PDF.
- **RSH_LAST_UPDATE_USER_ID**: The last user who updated the research data capture form.
- **RSH_LAST_UPDATE_USER_ID_NAME**: The name of the user record. This name may be hidden.
- **RSH_LAST_UPDATE_UTC_DTTM**: The last instant this data capture form was updated.
- **RSH_FORM_STAT_C_NAME**: Used to indicate whether or not all of the required fields on an esignature document's smartform have been completed.
- **DOC_SPEC_TYPE_C_NAME**: The document specialty for a document (DCS) record.
- **DOC_SUBSPECIALTY_C_NAME**: This item stores the document subspecialty for a document (DCS) record
- **TMPLT_SF_FORM_ID**: The unique ID of the SmartForm used to collect information for this document. Should be used in conjunction with DOC_INFORMATION.TMPLT_SF_CNTCT to identify the SmartForm Record.
- **TMPLT_SF_FORM_ID_FORM_NAME**: The name of the form associated with the questionnaire.
- **RSH_FORM_NAME**: The instance name for the research data capture form.
- **DOCUMENT_USAGE_C_NAME**: The document usage category ID for the document record.
- **BLOB_CATEGORY_C_NAME**: The blob category for the document.
- **RX_CUST_ID_OWNER_NAM_RECORD_ID**: This item contains a pointer to the name record of the owner of the customer ID used to pick up the prescriptions for the patient from outpatient pharmacies.
- **ESIG_ACCESSIBLE_PDF_FILE**: Stores the file name for the accessible PDF of this document on the BLOB.
- **SERIES_SEQ_NUM**: The sequence number of the series in a DICOM study (attribute 0020,0011).
- **PS_SERIES_UID**: The instance UID of the series that has the presentation state for the image.
- **PS_UID**: The presentation state instance UID for the image.
- **IMAGE_SEQUENCE_NUM**: The image sequence number within the series (attribute 0020,0013).
- **IMG_SLCT_TYPE_C_NAME**: The category ID indicating how the DICOM image associated with the record was selected, including if it was computer selected or marked as a key image.
- **FILE_CREATION_TIME**: Stores the timestamp in HL7 format of when the file was created on the blob or DMS server.
- **FILE_LAST_UPD_TIME**: Timestamp in HL7 format of when the image was last updated.
- **FILE_TYPE**: Mime type of the image/document.
- **CLN_DOC_SRC_APT_PAT_ENC_CSN_ID**: The appointment that a Document Information (DCS) record was attached to before it was moved to a Clinical Documentation Only encounter.
- **ENROLL_ID**: The unique ID of the research study association that has been linked to this document.
- **FILE_CREATION_DTTM**: Stores the file creation time of the document on the Web Blob Server (WBS)
- **DEFERRED_GEN_STATUS_C_NAME**: The deferred generation status category ID for the document. This field is only used for deferred generation documents.
- **DOC_TX_ID**: Stores ETR ID for the service-line on a claim that the document is associated with, used by Tapestry
- **START_DOC_PERIOD_DATE**: Start date of document period.
- **END_DOC_PERIOD_DATE**: End date of document period.
- **CLM_ATTACH_CTL_NUM**: Attachment control number for electronic attachments. This is used to identify electronic attachments for a claim in an ANSI X12 275.
- **CLM_PROV_ACCT_NUM**: Provider submitted account number for electronic attachments. This is used to identify electronic attachments for a claim in an ANSI X12 275.
- **CLAIM_VENDOR_NPI**: NPI of the vendor sent in ANSI X12 275. This is used to identify electronic attachments for a claim in an ANSI X12 275.
- **COPIED_FROM_DOCUMENT_ID**: This item links to the original DCS record that this record was copied from.
- **DOCUMENT_IDENT_SOURCE_C_NAME**: Indicates whether the identifier for this document, which is stored in item 350, is a native Epic identifier, or an identifier assigned by external system. When this item is set to 1-Native, the identifier refers to binary data that was uploaded through the Blob service. If the identifier was generated by an external system, this item is set to 2-External. If this item is set to 0-Unknown or not set, then other items must be used to determine if item 350 is a Blob or external identifier.
- **EOB_MEMBER_SHARE_AMOUNT**: Total amount a member is responsible for, for all the claims included in an Explanation of Benefits document.
- **DOC_SOURCE_ROI_ID**: Stores the ROI ID used to generate a composite document (DCS). A composite document represents one or more contexts which is included in the ROI.
- **CREATED_BY_USER_ID**: The user who created the document.
- **CREATED_BY_USER_ID_NAME**: The name of the user record. This name may be hidden.
- **CREATED_INST_UTC_DTTM**: The date and time the document was created.
- **INDEXED_BY_USER_ID**: The user who indexed the document.
- **INDEXED_BY_USER_ID_NAME**: The name of the user record. This name may be hidden.
- **INDEXED_INST_UTC_DTTM**: The date and time the document was indexed.
- **DEPTH_CAPT_STATUS_C_NAME**: Whether depth information was captured on an image, or why depth was unable to be obtained. Only applies to images.
- **LINK_DEPTH_DCS_ID**: Stores the ID for the DCS record of the depth map taken with the image.
- **DEPTH_ACCURACY_C_NAME**: Depth map accuracy measured on mobile when taking a wound image.
- **DEPTH_QUALITY_C_NAME**: Depth map quality measured on mobile when taking a wound image.

### DOC_INFO_DICOM
**Table**: Table contains information related to DICOM about a document.
- **DOCUMENT_ID**: The unique identifier (.1 item) for the document record.
- **ARCHV_ACCESSION_NUM**: The accession number of the imaging study, as pulled from the DICOM image archive (attribute 0008,0050).
- **STUDY_INST_UID**: DICOM Study Instance UID (attribute 0020,000D).
- **STUDY_DATE**: The date this imaging study was performed (attribute 0008,0020).
- **STUDY_DESCRIPTION**: The description of this imaging study (attribute 0008,1030).
- **SENDING_AE_TITLE**: The title of the sending DICOM Application Entity.
- **BELONGS_TO_STUDY_DOCUMENT_ID**: This column stores the ID of the study that this series belongs to.
- **MODALITY**: This is the DICOM modality type, as pulled from a DICOM image header (attribute 0008,0060).
- **REFERRING_PROV**: Referring physician as per DICOM attributes (attribute 0008,0090).
- **SERIES_TM**: The series time per the DICOM attributes (attribute 0008,0031).
- **SERIES_DESC**: The series description as per the DICOM attributes (attribute 0008,103E).
- **BODY_PART_EXAMINED**: This column stores the body part examined as per the DICOM attribute header (attribute 0018,0015).
- **ACQUISITION_TM**: This column stores the acquisition time of this series (attribute 0008,0032).
- **SERIES_LATERALITY**: The DICOM laterality for this series (attribute 0020,0060).
- **SERIES_INSTANCE_UID**: The series instance UID for this imaging series (attribute 0020,000E).
- **BELONGS_TO_SERIES_DOCUMENT_ID**: This column stores the ID of the series that this image belongs to.
- **PRIMARY_IMAGE_INST_UID**: This is the DICOM SOP instance UID (attribute 0008,0018). If this is a CT/MR, then it is the SOP instance UID of the first image in the series.
- **INST_SOP_CLASS_UID**: The instance SOP class UID specifies the exact type of this image or other DICOM document (attribute 0008,0016).
- **RESCALE_INTERCEPT**: Rescale intercept value from the DICOM header (attribute 0028,1052).
- **RESCALE_SLOPE**: Rescale slope value from the DICOM header (attribute 0028,1053).
- **RESCALE_TYPE**: Rescale type value from the DICOM header (attribute 0028,1054).
- **SAMPLES_PER_PIXEL**: Number of samples per pixel (attribute 0028,0002).
- **PIXELS_PER_ROW**: The number of pixels per row for this image (attribute 0028,0010).
- **IMAGE_COLUMNS**: The number of columns of this image (attribute 0028,0011).
- **BITS_ALLOCATED**: Number of bits allocated. This is bits per pixel (attribute 0028,0100).
- **BITS_STORED**: The number of bits stored in pixels (attribute 0028,0101).
- **PIXEL_SPACING_X_DIR**: Pixel spacing in X direction. This is the first piece of the DICOM attribute (attribute 0028,0030).
- **PIXEL_SPACING_Y_DIR**: Pixel spacing in Y direction. This is the second piece of the DICOM attribute (attribute 0028,0030).
- **PHOTOMETRIC_INTERPRT**: Photometric interpretation as per the DICOM header (attribute 0028,0004).
- **IMAGE_TYPE_C_NAME**: The image type. A multi-frame image is (usually) a movie type image.
- **NUM_OF_FRAMES**: The number of frames in this image (attribute 0028,0008).
- **MAX_PIX_VALUE**: This is the maximum pixel value in this image. This value is used to determine usable window width and level adjustment ranges.
- **FRAME_TM**: This column stores the frame time as time between image frames in milliseconds and it is used for setting initial display speeds.
- **IMAGE_ORIENTATION**: Image orientation defines the spatial position of the patient in relation to the image (derived from attribute 0020,0037).
- **PAT_ORIENTATION**: The patient orientation defines the patient position in relation to the image (attribute 0020, 0020).
- **SLICE_THICKNESS**: This column stores the slice thickness of the image. This is only relevant for cross-sectional images (attribute 0018,0050).
- **IMAGE_LOCATION**: This column stores a URL that can be used to retrieve this image through a WADO-RS web service call.

### DOC_LINKED_PATS
**Table**: Linked patients for EHI Export.
- **DOCUMENT_ID**: The unique identifier (.1 item) for the document record.
- **LINE**: The line number for the information associated with this record. Multiple pieces of information can be associated with this record.
- **LINKED_PAT_ID**: The list of patients (EPT) that this DCS is associated with for Electronic Health Information (EHI) Export

## Sample Data (one representative non-null value per column)

### DOCS_RCVD_ALGS
- DOCUMENT_ID = `51497394`
- CONTACT_DATE_REAL = `65387`
- LINE = `1`
- ALG_REF_ID = `8B0F86C8C60411EAAE2F4503B6AA49BB`
- ALG_SEVERITY_C_NAME = `High`
- ALG_DATE_NOTED_DT = `8/9/2018 12:00:00 AM`
- ALG_SRC_LPL_ID = `30689231`
- ALG_TYPE_OF_CHNG_C_NAME = `Delete`
- ALGN_NAME = `Peanut Oil`
- ALGN_ID = `49007`
- ALGN_ID_ALLERGEN_NAME = `PEANUT (DIAGNOSTIC)`
- ALG_LAST_UPD_DTTM = `2/8/2019 6:00:00 AM`
- ALG_PT_SRC_APP_C_NAME = `MyChart`
- ALGRX_TYPE = `Propensity to adverse reactions to drug`
- ALG_STATE_C_NAME = `Active`
- ALG_STATUS_ENTRY_C_NAME = `Active`
- ALG_SRC_WPR_ID = `389635`
- ALG_CRITICALITY_C_NAME = `High`
- ALG_CRITICALITY_TXT = `High`

### DOCS_RCVD_ASMT
- DOCUMENT_ID = `51497394`
- CONTACT_DATE_REAL = `66708`
- LINE = `1`
- CONTACT_DATE = `9/28/2023 12:00:00 AM`
- ASMT_REF_ID = `B2; ¯k&¬ 5753772379-100004-Z6602162`
- ASMT_LAST_UPD_INST_DTTM = `9/28/2023 2:55:56 PM`
- ASMT_NAME = `Education`

### DOCS_RCVD_PROC
- DOCUMENT_ID = `60004171`
- CONTACT_DATE_REAL = `65643`
- LINE = `1`
- CONTACT_DATE = `9/21/2020 12:00:00 AM`
- PROC_REF_ID = `1.2.840.114350.1.13.558.2.7.1.1988.1;12325931^`
- PROC_TYPE_TXT = `COVID-19`
- PROC_START_DATE = `9/15/2020 12:00:00 AM`
- PROC_END_DATE = `9/15/2020 12:00:00 AM`
- PROC_LST_UPD_INST_DTTM = `9/21/2020 2:50:18 PM`

### DOC_CSN_REFS
- DOCUMENT_ID = `271960348`
- LINE = `1`
- CSN_REFERENCE = `921952141`

### DOC_INFORMATION
- DOC_INFO_ID = `251026646`
- DOC_INFO_TYPE_C_NAME = `MyChart COVID-19 Vaccination Record Document`
- DOC_STAT_C_NAME = `Received`
- DOC_DESCR = `MyChart COVID-19 Vaccination Record PDF`
- DOC_RECV_TIME = `2/9/2022 4:03:00 PM`
- RECV_BY_USER_ID = `MYCHARTBGUSER`
- RECV_BY_USER_ID_NAME = `MYCHARTBGUSER`
- IS_SCANNED_YN = `Y`
- SCAN_TIME = `9/29/2021 7:47:00 PM`
- SCAN_BY_USER_ID = `MYCHARTG`
- SCAN_BY_USER_ID_NAME = `MYCHART, GENERIC`
- SCAN_DEP_ID = `101401031`
- SCAN_FILE = `D-prd-1814208031.PDF`
- DOC_PT_ID = `Z7004242`
- DOC_CSN = `921952141`
- DOC_HNO_ID = `3416456777`
- SCAN_LWS_ID = `4466432`
- DOC_SRVC_DTTM = `2/9/2022 4:03:00 PM`
- SCAN_INST_DTTM = `9/29/2021 7:47:00 PM`
- DOC_STORAGE_LVL_C_NAME = `Patient`
- DOC_CREAT_DEPT_ID = `101401031`
- DOC_SRVR_NAME_C_NAME = `Onbase Scanning`
- DOC_SOURCE_INFO_C_NAME = `MyChart COVID-19 Vaccination Record Download`

### DOC_INFORMATION_2
- DOCUMENT_ID = `251026646`
- BLOB_CATEGORY_C_NAME = `DOCUMENT`
- FILE_CREATION_TIME = `20220209220332`
- FILE_LAST_UPD_TIME = `20220209220332`
- FILE_TYPE = `image/tiff`

### DOC_INFO_DICOM
- DOCUMENT_ID = `251026646`

### DOC_LINKED_PATS
- DOCUMENT_ID = `251026646`
- LINE = `1`
- LINKED_PAT_ID = `Z7004242`

## Pipeline Code

### Stage 1: SQL Projection (project.ts → raw JSON)
```typescript
function projectDocuments(patId: unknown): EpicRow[] {
  if (!tableExists("DOC_INFORMATION")) return [];
  const docs = mergeQuery("DOC_INFORMATION");
  for (const d of docs) {
    const did = d.DOC_INFO_ID ?? d.DOCUMENT_ID;
    if (tableExists("DOC_LINKED_PATS")) d.linked_patients = children("DOC_LINKED_PATS", "DOCUMENT_ID", did);
    if (tableExists("DOC_INFO_DICOM")) d.dicom = children("DOC_INFO_DICOM", "DOCUMENT_ID", did);
    if (tableExists("DOC_CSN_REFS")) d.csn_refs = children("DOC_CSN_REFS", "DOCUMENT_ID", did);
    if (tableExists("DOCS_RCVD_ALGS")) d.received_allergies = children("DOCS_RCVD_ALGS", "DOCUMENT_ID", did);
    if (tableExists("DOCS_RCVD_ASMT")) d.received_assessments = children("DOCS_RCVD_ASMT", "DOCUMENT_ID", did);
    if (tableExists("DOCS_RCVD_PROC")) d.received_procedures = children("DOCS_RCVD_PROC", "DOCUMENT_ID", did);
  }
  return docs;
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