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

Analyze the mapping pipeline for **Immunizations: IMMUNE + children → immunizations** and identify every semantic error — places where a column is read successfully but the value means something different than the code assumes.

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

### IMMUNE
**Table**: The IMMUNE table contains data for immunizations ordered through clinical system. May also contain information on immunizations as reported by patient, but not ordered/administered via clinical system;  Fields in this table are noadd- single items in database. If an immunization record is edited/changed, that record will be re-extracted and reflect the updated values.
- **IMMUNE_ID**: The unique ID of the immunization record in your system production system.
- **IMMUNZATN_ID**: The ID of the immunization record that corresponds to the type of immunization given to this patient.
- **IMMUNZATN_ID_NAME**: The name of the immunization.
- **IMMUNE_DATE**: The date the immunization was administered in calendar format.
- **DOSE**: The immunization dosage.
- **ROUTE_C_NAME**: The category value associated with the route of the immunization, such as oral, intramuscular, or intradermal.
- **SITE_C_NAME**: The category value associated with the location of the injection, if appropriate. For example, left gluteus or right deltoid.
- **MFG_C_NAME**: The category value associated with the manufacturer of this vaccine.
- **LOT**: The lot number of the vaccine.
- **EXP_DATE**: The date the immunization is next due, if in a series. This is manually established by the user, and not automatically calculated like an HM or BPA.
- **GIVEN_BY_USER_ID**: The unique ID of the system user who administered the immunization. This ID may be encrypted.
- **GIVEN_BY_USER_ID_NAME**: The name of the user record. This name may be hidden.
- **ENTRY_USER_ID**: The unique ID of the system user who ordered the immunization. This ID may be encrypted.  NOTE: If an immunization record is edited/updated, this will show the most recent change user ID.
- **ENTRY_USER_ID_NAME**: The name of the user record. This name may be hidden.
- **ENTRY_DATE**: The date the immunization was recorded in the patient�s chart in calendar format. NOTE: If an immunization record is edited/updated, this will show the most recent change date.
- **EXPIRATION_DATE**: Date upon which this immunization expires
- **EXTERNAL_ADMIN_C_NAME**: Category value indicating the source of verification of external administration of immunization, e.g. patient reported, WIR reported, etc.
- **VIS_DATE_TEXT**: The date on the vaccine information statement. Note that this is a free text field in the application, so data will not be in standard datetime format.
- **DEFER_REASON_C_NAME**: Category value indicating the reason for deferring the immunization, e.g. patient refused, contraindication, etc.
- **MED_ADMIN_COMMENT**: Free text comment regarding the administration of this immunization
- **PHYSICAL_SITE**: Item that stores the physical location where the immunization was administered like some specific hospital
- **IMM_PRODUCT**: Item which stores the product of the immunization. Products are usually related to the lot number.
- **IMMUNIZATION_TIME**: Column that stores the time when a given immunization was administered.
- **NDC_NUM_ID**: Store the NDC number ID associated with the administration
- **NDC_NUM_ID_NDC_CODE**: The external code for the National Drug Code (NDC). An NDC represents packages of medications.
- **DOCUMENT_DCS_ID**: Document ID for the immunization. This is the information stored when the e-sign information is selected.
- **ORDER_ID**: Order ID for immunization ordered.
- **IMM_ANSWER_ID**: Stores answers for immunization questions.
- **IMMNZTN_STATUS_C_NAME**: The category value associated with "Given" if the immunization has been administered, "Deleted" if the immunization has been deleted from the administration history, "Incomplete" if the item has been ordered but not administered and a status of "Deferred" if the immunization has been deferred.
- **IMM_MAR_ADMIN_LINE**: The line number in the linked order record's immunization link item (I ORD 11270) which references this immunization record ID.
- **IMM_CHARGE_REC_ID**: This column contains the UCL (Universal Charge Line) record ID for the immunization charge.
- **IMM_CSN**: This column contains the CSN (contact serial number) for the immunization.
- **EXTERNAL_ID**: This column contains the immunization's external ID, which is populated by the interface.  The external ID is the external system's identifier for the immunization.
- **EXTERNAL_SYSTEM**: This column contains the name or ID of the third party system that the immunization data came from.  This item is only populated by custom import specifications.
- **INSTANT_OF_ENT_DTTM**: This column contains the last instant of update of the immunization problem list (LPL) record.
- **IMM_HISTORIC_ADM_YN**: Indicates whether the immunization administration is a historical administration.
- **IMMNZTN_DUALSIGN_ID**: The user who performed the second user verification on the immunization.
- **IMMNZTN_DUALSIGN_ID_NAME**: The name of the user record. This name may be hidden.
- **IMM_DUALSIGNINSTANT_DTTM**: The instant at which this immunization was verified by the second user.
- **IMMNZTN_DOSE_AMOUNT**: Immunization dose amount.
- **IMMNZTN_DOSE_UNIT_C_NAME**: Immunization dose unit.
- **IMM_DEL_REASON_C_NAME**: Category value indicating the reason for deleting or canceling the immunization.
- **IMM_SCANNED_BARCODE**: The raw data captured during immunization barcode scanning.
- **ENTRY_DTTM**: Contains the date and time that the immunization administration data was last updated. If the exact time is not known, a date may be contained in ENTRY_DATE instead.
- **IMM_PRODUCT_C_NAME**: The brand name associated with the vaccination administration, stored as a category value from a defined set of products.
- **IMM_DEFER_DUR_C_NAME**: Each category value represents a different time scale of deferral for a vaccine administration deferral (e.g. "brief", "permanent", etc...). This item does NOT store the specific length of time the vaccine was deferred.
- **IMM_REG_STATUS_C_NAME**: The current administration's overall status according to an external Immunization Registry.
- **IMM_LST_REGINST_UTC_DTTM**: Last instant in which the overall registry status from an Immunization Registry was updated for a vaccine administration problem list  (LPL)record.
- **IMM_MAR_ADM_INPATIENT_DATA_ID**: Link to the INP record that may hold the administrations data.
- **IMM_LOT_NUM_ID**: This item stores the record ID of the lot(LOT) used for immunization administration.

### IMMUNE_HISTORY
**Table**: The IMMUNE_HISTORY table contains the history data for immunizations ordered through the clinical system. It may also contain information on immunizations as reported by the patient, but not ordered/administered via clinical system. This table contains the history of changes made to the information that is found in the IMMUNE table. Fields in this table are no-add related group items in the LPL database.
- **IMMUNE_ID**: The unique ID of the immunization record in your system production system.
- **LINE**: The Line Count for the line in the table which in combination with the IMMUNE_ID forms the primary key for this table.
- **IMM_TYPE_HIST_ID**: Stores the unique ID of the immunizations (LIM) master file which is associated with this immunization record.  Corresponds to the type of immunization given to this patient.
- **IMM_TYPE_HIST_ID_NAME**: The name of the immunization.
- **IMM_HX_PRODUCT**: Stores the product information associated with this immunization. Products are usually related to the lot number.
- **IMM_HX_NDC_NUM_ID**: The unique ID of the Medication National Drug Codes (NDC) master file that is associated with this immunization and stores the NDC numbers associated with the administration of this immunization.
- **IMM_HX_NDC_NUM_ID_NDC_CODE**: The external code for the National Drug Code (NDC). An NDC represents packages of medications.
- **IMMNZTN_HX_DATE**: The  date when this immunization was administered.
- **IMM_HX_TIME**: The time when this immunization was administered.
- **IMMNZTN_HX_DOSE**: The dosage information for this immunization administered.
- **IMMNZTN_HX_ROUTE_C_NAME**: The category number for the route of the immunization, such as oral, intramuscular, or intradermal.
- **IMMNZTN_HX_SITE_C_NAME**: The location of the injection, if appropriate.
- **IMMNZTN_HX_MFG_C_NAME**: The category number for the manufacturer of this vaccine.
- **IMMNZTN_HX_LOT**: The LOT number for the immunization administered.
- **IMM_HX_NEXT_DUE_DT**: The date on which the administered immunization is due next.  , if in a series. This is manually established by the user, and not automatically calculated.
- **IMM_HX_EXP_DATE**: The date on which the immunization administered expires.
- **IMMNZTN_HX_GIVEN_ID**: The unique ID of the user in the EMP master file that is listed in the clinical system as actually administering the  immunization to the patient.
- **IMMNZTN_HX_GIVEN_ID_NAME**: The name of the user record. This name may be hidden.
- **IMMNZTN_HX_EXT_AD_C_NAME**: The category number for the source of verification of external administration of immunization.
- **IMM_HX_ANSWER_ID**: The unique ID in the questionnaire answers (HQA) master file that is associated with the immunization administered.
- **IMMNZTN_HX_VIS_DATE**: The free text date field associated with the immunization where VIS (Vaccine Information Statements) date is stored.
- **IMMNZTN_HX_DEFER_C_NAME**: The category number for the reason for deferring the immunization, e.g. patient refused, contraindication, etc.
- **IMMNZTN_HX_COMMENT**: The free text comments associated with the immunization administered.
- **IMMNZTN_HX_ENTRY_ID**: The unique ID of the user  in the EMP masterfile associated with the person who entered the immunization administration information into the clinical system.
- **IMMNZTN_HX_ENTRY_ID_NAME**: The name of the user record. This name may be hidden.
- **PHYSICAL_SITE_HX**: The physical site information for the immunization administered such as a specific hospital.
- **IMM_HX_HIST_ADMI_YN**: Indicates whether or not an immunization is historical or not.
- **IMMNZTN_HX_ENT_DATE**: The date on which the immunization was entered into the system.
- **IMMNZTN_HX_STATUS_C_NAME**: The category number for the immunization status. Examples are "Given" if the immunization has been administered, "Deleted" if the immunization has been deleted from the administration history, "Incomplete" if the item has been ordered but not administered and a status of "Deferred" if the immunization has been deferred.
- **IMM_HX_MAR_ADMIN_LI**: The immunization history MAR administration line.
- **IMM_CHRG_REC_HX_ID**: The unique ID in the Universal Charge Line (UCL) master file that is associated with the immunization administered.
- **IMMNZTN_HX_ENC_CSN**: This column stores the history information of immunization CSN whenever an edit was made on the Immunization.
- **IMMNZTN_HX_DOSE_AMT**: The history of dosage amount for the immunization administered.
- **IMMNZTN_HX_DOSE_UNIT_C_NAME**: The history of dosage unit for the immunization administered.
- **IMM_HX_DUALSIGN_ID**: History of the users who performed the second user verification on the immunization
- **IMM_HX_DUALSIGN_ID_NAME**: The name of the user record. This name may be hidden.
- **IMM_HX_DUALSIGNINST_DTTM**: History of instant at which the immunization was verified by the second user.
- **IMM_DEL_REASON_HX_C_NAME**: Historic reason for immunization deletion.
- **IMM_HX_SCAN_BARCODE**: The history of raw data captured during immunization barcode scanning.
- **IMMZTN_HX_ENTRY_DTTM**: Contains the date and time that the data in the row was entered. If the exact time is not known, a date may be contained in IMMNZTN_HX_ENT_DATE instead.
- **IMM_HX_PRODUCT_C_NAME**: The brand name associated with the vaccination administration in previous edits to the record, stored as a category value from a defined set of products. Historical version of IMM PRODUCT - CATEGORY (I LPL 4007).
- **IMM_HX_DEFER_DUR_C_NAME**: Each category value represents a different time scale of deferral for a vaccine administration deferral (e.g. "brief", "permanent", etc...) that was associated with the vaccine deferral at the time of a previous edit to the record. This item does NOT store the specific length of time the vaccine was deferred. This is the historical version of IMM DEFERRAL DURATION (I LPL 4077).
- **IMM_HX_MAR_AD_LK_ID**: Link to the INP record that may hold the administrations data - Historical.
- **IMM_HX_LOT_NUM_ID**: The history of lot(LOT) record Id for the immunization adminstered.

### IMM_ADMIN
**Table**: The IMM_ADMIN table contains information about the immunization administered. The rows included in this table are items from DXR (Document) masterfile which include information on type of immunization, administration date, administered dose, administration route, administration site, immunization manufacturer, immunization lot number, administered by, visit date, deferral reason, administration notes, administration location, administration status, administered amount, administered unit, contact serial number of the DXR record that owns the immunization instance and a unique reference identifier to identify a specific instance of an immunization.
- **DOCUMENT_ID**: The unique identifier for the document record.
- **CONTACT_DATE_REAL**: A unique contact date in decimal format. The integer portion of the number indicates the date of contact. The digits after the decimal distinguish different contacts on the same date and are unique for each contact on that date. For example, .00 is the first/only contact, .01 is the second contact, etc.
- **LINE**: The line number for the information associated with this contact. Multiple pieces of information can be associated with this contact.
- **CONTACT_DATE**: The date of this contact in calendar format.
- **IMM_TYPE_ID**: External immunization type ID.
- **IMM_TYPE_ID_NAME**: The name of the immunization.
- **IMM_TYPE_FREE_TEXT**: The immunization type information for the administered immunization as free text.
- **IMM_DATE**: The immunization administration date.
- **IMM_DOSE**: The dose of immunization administered.
- **IMM_ROUTE_C_NAME**: The immunization administration route category ID.
- **IMM_ROUTE_FREE_TXT**: The immunization route information for the administered immunization as free text.
- **IMM_SITE_C_NAME**: The immunization administration site category ID.
- **IMM_SITE_FREE_TXT**: The immunization site information for the administered immunization as free text.
- **IMM_MANUFACTURER_C_NAME**: The immunization administered manufacturer category ID.
- **IMM_MANUF_FREE_TEXT**: The immunization manufacturer information for the administered immunization as free text.
- **IMM_LOT_NUMBER**: The immunization administered lot number.
- **IMM_GIVEN_BY_ID**: The immunization administering user ID. This column is frequently used to link to the table CLARITY_EMP.
- **IMM_GIVEN_BY_ID_NAME**: The name of the user record. This name may be hidden.
- **IMM_GIVEN_BY_FT**: The immunization given by information for the administered immunization as free text.
- **IMM_VIS_PUB_DATE**: The immunization visit date presented to patient for the administered immunization.
- **IMM_VIS_DATE**: The immunization visit date for the administered immunization.
- **IMM_DEF_RSN_FREE_TX**: The immunization administration deferral reason as free text.
- **IMM_DEF_REASON_C_NAME**: The immunization administration deferral reason category ID.
- **IMM_NOTES_RAW_DATA**: Free text immunization notes from the immunization administration.
- **IMM_NOTES**: The immunization administration notes.
- **IMM_LOCATION**: The immunization administration location.
- **IMM_STATUS_C_NAME**: Status of the vaccination administration.
- **IMM_DOSE_AMOUNT**: Immunization dose amount.
- **IMM_DOSE_UNIT_C_NAME**: Immunization dose unit.
- **IMM_SRC_DXR_CSN**: The contact serial number of the received document record that owns the instance of this immunization.
- **IMM_REFERENCE_ID**: This item stores a unique reference identifier to identify a specific instance of an immunization.
- **IMM_SCHED_ID_FT**: Immunization schedule ID used for the administered vaccination.
- **IMM_SCHED_NAME_FT**: Immunization schedule name used for the administered vaccination.
- **IMM_SCHED_CODING_FT**: Immunization schedule coding system used for the administered vaccination.
- **IMM_SCHED_VALID_YN**: Whether or not the administered dose was valid for the given schedule.
- **IMM_VALID_RSN_C_NAME**: Description of why the given administration is valid or invalid based on its immunization schedule.
- **IMM_VALID_RSN_FT**: Description of why the given administration is valid or invalid based on its immunization schedule.
- **IMM_LST_UPD_INST_DTTM**: Stores the last update instant of the immunization in UTC.
- **IMMNZTN_SRC_APPL_C_NAME**: If this immunization is patient-entered, this item stores the application the patient used to edit the immunization for the contact (MyChart or Welcome). If this item is blank, it is assumed that the patient edited the immunization in MyChart.
- **IMMNZTN_SRC_WPR_ID**: Stores the WPR ID of the MyChart user who edited the immunization for the contact.
- **IMM_EVENT_IDENT**: This item stores the ID of the event that is associated with an immunization. In cases where there are multiple encounters that link to an immunization, the earliest encounter is represented here.
- **IMM_FUNDING_SOURCE_C_NAME**: The category ID for the funding source of the administered vaccine.
- **IMM_VFC_ELIGIBILITY_STATUS_C_NAME**: The category ID of the funding program that should pay for an administered vaccine.
- **IMM_DUP_INT_IMM_ID**: Link to an internal immunization
- **IMM_DEFER_DUR_C_NAME**: The vaccine administration deferral duration category ID for the vaccine administration in the received document.
- **IMM_PRODUCT_C_NAME**: The vaccine administration brand name category ID for the vaccine administration in the received document.
- **IMM_PRODUCT_FT**: The vaccine administration brand name for the vaccine administration in the received document.
- **IMM_EXT_ADMIN_C_NAME**: The source of information category ID for the vaccine administration in the received document.
- **IMM_FILTER_RSN_C_NAME**: Stores the reason why an external immunization should be filtered from the composite record
- **IMM_RSN_FOR_VAC_C_NAME**: Stores reason for vaccination values.
- **IMM_EXTERNAL_IDENTIFIER**: External ID of the immunization record.
- **IMM_GENERATED_SERIAL_NUM**: This item stores the serial number that is generated when receiving the document.

### IMM_ADMIN_COMPONENTS
**Table**: The IMM_ADMIN_COMPONENTS table contains information about the components of the immunization administered. The rows included in this table are items from DXR (Document) masterfile which include information on type of immunization, dose validity, immunization schedule, and a unique reference identifier to identify a specific instance of an immunization.
- **DOCUMENT_ID**: The unique identifier for the document record.
- **CONTACT_DATE_REAL**: A unique contact date in decimal format. The integer portion of the number indicates the date of contact. The digits after the decimal distinguish different contacts on the same date and are unique for each contact on that date. For example, .00 is the first/only contact, .01 is the second contact, etc.
- **LINE**: The line number for the information associated with this contact. Multiple pieces of information can be associated with this contact.
- **CONTACT_DATE**: The date of this contact in calendar format.
- **IMM_COMP_ID**: The unique identifier for the immunization component.
- **IMM_REFERENCE_ID**: The unique reference identifier for the specific instance of an immunization that the component is part of.
- **IMM_COMP_GROUP_ID**: The unique ID of the vaccine group for an immunization administration received from an external system. This can be either the component or the family of a vaccine.
- **IMM_COMP_GROUP_ID_NAME**: The name of the immunization.
- **IMM_COMP_GROUP_FT**: The free text value for a vaccine group for an immunization administration received from an external system. This can be either the component or the family of a vaccine.
- **IMM_COMP_SCHED_ID_FT**: The immunization schedule identifier used for the administered vaccination component.
- **IMM_COMP_SCHED_NAME_FT**: The immunization schedule name used for the administered vaccination component.
- **IMM_COMP_SCHED_CODING_FT**: The immunization schedule coding system used for the administered vaccination component.
- **IMM_COMP_SCHED_VALID_YN**: Whether or not the administered component dose was valid for the given schedule
- **IMM_COMP_VALID_RSN_C_NAME**: The description of why the given administration component is valid or invalid based on its immunization schedule.
- **IMM_COMP_VALID_RSN_FT**: The free text description of why the given administration component is valid or invalid based on its immunization schedule.
- **IMM_COMP_SCHED_DOSE_NUM**: Dose number for this component in the immunization series.

### IMM_ADMIN_GROUPS
**Table**: This table extracts the related multiple response Vaccine Group (I DXR 4220) item.
- **DOCUMENT_ID**: The unique identifier (.1 item) for the document record.
- **CONTACT_DATE_REAL**: A unique contact date in decimal format. The integer portion of the number indicates the date of contact. The digits after the decimal distinguish different contacts on the same date and are unique for each contact on that date. For example, .00 is the first/only contact, .01 is the second contact, etc.
- **GROUP_LINE**: The line number for the information associated with this contact.
- **VALUE_LINE**: The line number of one of the multiple values associated with a specific group of data within this contact.
- **CONTACT_DATE**: The date of this contact in calendar format.
- **IMM_GROUPS_ID**: Stores the discrete value for a vaccine group for an immunization administration received from an external system. This can be either the component or the family of a vaccine. The corresponding free-text value received from registry is stored in DXR 4221.
- **IMM_GROUPS_ID_NAME**: The name of the immunization.

### IMM_DUE
**Table**: The IMM_DUE table contains information about when an immunization is due. The rows included in this table are items from DXR (Document) masterfile which include information on type of immunization, due date, earliest date and next dose number for the due immunization.
- **DOCUMENT_ID**: The unique identifier for the document record.
- **CONTACT_DATE_REAL**: A unique contact date in decimal format. The integer portion of the number indicates the date of contact. The digits after the decimal distinguish different contacts on the same date and are unique for each contact on that date. For example, .00 is the first/only contact, .01 is the second contact, etc.
- **LINE**: The line number for the information associated with this contact. Multiple pieces of information can be associated with this contact.
- **CONTACT_DATE**: The date of this contact in calendar format.
- **IMM_DUE_TYPE_ID**: The type ID of immunization that is due. This column is frequently used to link to the table CLARITY_IMMUNZATN.
- **IMM_DUE_TYPE_ID_NAME**: The name of the immunization.
- **IMM_DUE_TYPE_FT**: The free text description of the type of immunization that is due.
- **IMM_DUE_DUE_DATE**: The due date for immunization that is due.
- **IMM_DUE_EARLIEST_DT**: The earliest date of immunization that is due.
- **IMM_DUE_NEXT_DOSE**: The next dose number of immunization that is due.
- **IMM_DUE_SCHED_ID_FT**: Immunization schedule ID used for the recommended vaccination.
- **IMM_DUE_SCHED_NM_FT**: Immunization schedule name used for the recommended vaccination.
- **IMM_DUE_SCHED_CD_FT**: Immunization schedule coding system used for the recommended vaccination.

### PAT_IMMUNIZATIONS
**Table**: This table stores a list of patients' immunizations that can be linked to the immunizations (LPL) table, IMMUNE.
- **PAT_ID**: The unique system identifier of the patient record.
- **LINE**: The line number for the information associated with this record. Multiple pieces of information can be associated with this record.
- **IMMUNE_ID**: The unique ID of the immunization record.

## Sample Data (one representative non-null value per column)

### IMMUNE
- IMMUNE_ID = `30666377`
- IMMUNZATN_ID = `91301`
- IMMUNZATN_ID_NAME = `COVID-19 (MODERNA) MRNA`
- IMMUNE_DATE = `4/18/2021 12:00:00 AM`
- DOSE = `0.5 mL`
- ROUTE_C_NAME = `Intramuscular`
- SITE_C_NAME = `Right Arm`
- MFG_C_NAME = `GLAXO SMITH KLINE`
- LOT = `5ME77`
- GIVEN_BY_USER_ID = `MBS403`
- GIVEN_BY_USER_ID_NAME = `SMITH, MARY B`
- ENTRY_USER_ID = `1001`
- ENTRY_USER_ID_NAME = `INTERCONNECT, USER NATIVE`
- ENTRY_DATE = `1/24/2022 12:00:00 AM`
- EXPIRATION_DATE = `6/30/2024 12:00:00 AM`
- EXTERNAL_ADMIN_C_NAME = `MyChart Entered`
- VIS_DATE_TEXT = `8/6/2021`
- MED_ADMIN_COMMENT = `via WIR`
- IMM_PRODUCT = `Fluarix Quadrivalent`
- NDC_NUM_ID = `368186`
- NDC_NUM_ID_NDC_CODE = `58160-909-52`
- ORDER_ID = `945468367`
- IMM_ANSWER_ID = `61095289`
- IMMNZTN_STATUS_C_NAME = `Given`
- IMM_CHARGE_REC_ID = `774126992`
- IMM_CSN = `991225117`
- IMM_HISTORIC_ADM_YN = `Y`
- IMMNZTN_DOSE_AMOUNT = `0.5`
- IMMNZTN_DOSE_UNIT_C_NAME = `mL`
- ENTRY_DTTM = `1/24/2022 12:40:49 PM`
- IMM_LOT_NUM_ID = `298403`

### IMMUNE_HISTORY
- IMMUNE_ID = `30666377`
- LINE = `1`
- IMM_TYPE_HIST_ID = `91301`
- IMM_TYPE_HIST_ID_NAME = `COVID-19 (MODERNA) MRNA`
- IMM_HX_PRODUCT = `Fluarix Quadrivalent`
- IMM_HX_NDC_NUM_ID = `368186`
- IMM_HX_NDC_NUM_ID_NDC_CODE = `58160-909-52`
- IMMNZTN_HX_DATE = `4/18/2021 12:00:00 AM`
- IMMNZTN_HX_DOSE = `0.5 mL`
- IMMNZTN_HX_ROUTE_C_NAME = `Intramuscular`
- IMMNZTN_HX_SITE_C_NAME = `Right Arm`
- IMMNZTN_HX_MFG_C_NAME = `GLAXO SMITH KLINE`
- IMMNZTN_HX_LOT = `5ME77`
- IMM_HX_EXP_DATE = `6/30/2024 12:00:00 AM`
- IMMNZTN_HX_GIVEN_ID = `MBS403`
- IMMNZTN_HX_GIVEN_ID_NAME = `SMITH, MARY B`
- IMMNZTN_HX_EXT_AD_C_NAME = `MyChart Entered`
- IMM_HX_ANSWER_ID = `61095289`
- IMMNZTN_HX_VIS_DATE = `8/6/2021`
- IMMNZTN_HX_COMMENT = `via WIR`
- IMMNZTN_HX_ENTRY_ID = `1001`
- IMMNZTN_HX_ENTRY_ID_NAME = `INTERCONNECT, USER NATIVE`
- IMM_HX_HIST_ADMI_YN = `Y`
- IMMNZTN_HX_ENT_DATE = `1/24/2022 12:00:00 AM`
- IMMNZTN_HX_STATUS_C_NAME = `Given`
- IMM_CHRG_REC_HX_ID = `774126992`
- IMMNZTN_HX_ENC_CSN = `832464108`
- IMMNZTN_HX_DOSE_AMT = `0.5`
- IMMNZTN_HX_DOSE_UNIT_C_NAME = `mL`
- IMMZTN_HX_ENTRY_DTTM = `1/24/2022 12:40:49 PM`
- IMM_HX_LOT_NUM_ID = `298403`

### IMM_ADMIN
- DOCUMENT_ID = `37596260`
- CONTACT_DATE_REAL = `65387`
- LINE = `1`
- CONTACT_DATE = `1/9/2020 12:00:00 AM`
- IMM_TYPE_ID = `85`
- IMM_TYPE_ID_NAME = `HEPATITIS A (HAVRIX) HEPA ADULT`
- IMM_TYPE_FREE_TEXT = `HAVRIX 1,440 UNITS/ML VIAL`
- IMM_DATE = `2/5/2019 12:00:00 AM`
- IMM_ROUTE_C_NAME = `Intramuscular`
- IMM_SITE_C_NAME = `Right Arm`
- IMM_MANUFACTURER_C_NAME = `Moderna`
- IMM_LOT_NUMBER = `UNKNOWN`
- IMM_GIVEN_BY_FT = `C VAR Form`
- IMM_NOTES_RAW_DATA = `01^Historical information - source unspecified^NIP001`
- IMM_NOTES = `Historical - Not administered in Epic`
- IMM_LOCATION = `WALGREENS #06130`
- IMM_STATUS_C_NAME = `Given`
- IMM_REFERENCE_ID = `887599236990001`

### IMM_ADMIN_COMPONENTS
- DOCUMENT_ID = `37763216`
- CONTACT_DATE_REAL = `65387`
- LINE = `1`
- CONTACT_DATE = `1/9/2020 12:00:00 AM`
- IMM_COMP_ID = `1338541131000071.1`
- IMM_REFERENCE_ID = `1338541131000071`
- IMM_COMP_GROUP_ID = `40821`
- IMM_COMP_GROUP_ID_NAME = `INFLUENZA, UNSPECIFIED FORMULATION`
- IMM_COMP_GROUP_FT = `Influenza`
- IMM_COMP_SCHED_ID_FT = `VXC16`
- IMM_COMP_SCHED_NAME_FT = `ACIP Schedule`
- IMM_COMP_SCHED_CODING_FT = `CDCPHINVS`
- IMM_COMP_SCHED_VALID_YN = `Y`
- IMM_COMP_VALID_RSN_FT = `The client's age and vaccination history allowed for certain doses in the series to be skipped.`

### IMM_ADMIN_GROUPS
- DOCUMENT_ID = `37763216`
- CONTACT_DATE_REAL = `64868`
- GROUP_LINE = `1`
- VALUE_LINE = `1`
- CONTACT_DATE = `8/8/2018 12:00:00 AM`
- IMM_GROUPS_ID = `40821`
- IMM_GROUPS_ID_NAME = `INFLUENZA, UNSPECIFIED FORMULATION`

### IMM_DUE
- DOCUMENT_ID = `37763216`
- CONTACT_DATE_REAL = `64868`
- LINE = `1`
- CONTACT_DATE = `8/8/2018 12:00:00 AM`
- IMM_DUE_TYPE_ID = `9`
- IMM_DUE_TYPE_ID_NAME = `VARICELLA (VARIVAX) VAR`
- IMM_DUE_TYPE_FT = `Varicella`
- IMM_DUE_DUE_DATE = `10/26/1995 12:00:00 AM`
- IMM_DUE_EARLIEST_DT = `10/26/1995 12:00:00 AM`
- IMM_DUE_NEXT_DOSE = `1`
- IMM_DUE_SCHED_ID_FT = `VXC16`
- IMM_DUE_SCHED_NM_FT = `ACIP Schedule`
- IMM_DUE_SCHED_CD_FT = `CDCPHINVS`

### PAT_IMMUNIZATIONS
- PAT_ID = `Z7004242`
- LINE = `1`
- IMMUNE_ID = `30666377`

## Pipeline Code

### Stage 1: SQL Projection (project.ts → raw JSON)
```typescript
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

const immuneChildren: ChildSpec[] = [
  { table: "IMMUNE_HISTORY", fkCol: "IMMUNE_ID", key: "history" },
  { table: "IMM_ADMIN", fkCol: "DOCUMENT_ID", key: "administrations" },
  { table: "IMM_ADMIN_COMPONENTS", fkCol: "DOCUMENT_ID", key: "components" },
  { table: "IMM_ADMIN_GROUPS", fkCol: "DOCUMENT_ID", key: "groups" },
  { table: "IMM_DUE", fkCol: "DOCUMENT_ID", key: "due_forecast" },
]
```

### Stage 2: Domain Model Hydration (PatientRecord.ts)
```typescript
// (raw EpicRow[], no typed class)
```

### Stage 3: Clean Projection (HealthRecord.ts → final output)
```typescript
function projectImmunization(i: any): Immunization {
  return {
    id: sid(i.IMMUNE_ID),
    vaccine: i.IMMUNZATN_ID_NAME ?? 'Unknown',
    date: toISODate(i.IMMUNE_DATE),
    site: str(i.SITE_C_NAME), route: str(i.ROUTE_C_NAME),
    dose: str(i.DOSE), lotNumber: str(i.LOT_NUM),
    manufacturer: str(i.MANUFACTURER_C_NAME),
    administeredBy: str(i.ENTRY_USER_ID_NAME),
    status: str(i.IMMNZTN_STATUS_C_NAME),
    _epic: epic(i),
  };
}
```

## Actual Output (from health_record_full.json)

```json
{
  "immunizations": [
    {
      "id": "30666377",
      "vaccine": "INFLUENZA (FLUCELVAX) CCIIV4, PREFILLED SYRINGE",
      "date": "2017-10-25",
      "site": "Left Arm",
      "route": "Intramuscular",
      "administeredBy": "KALSOW, COURTNEY C",
      "status": "Given",
      "_epic": {
        "IMMUNE_ID": 30666377,
        "IMMUNZATN_ID": 90674,
        "IMMUNZATN_ID_NAME": "INFLUENZA (FLUCELVAX) CCIIV4, PREFILLED SYRINGE",
        "IMMUNE_DATE": "10/25/2017 12:00:00 AM",
        "ROUTE_C_NAME": "Intramuscular",
        "SITE_C_NAME": "Left Arm",
        "ENTRY_USER_ID": "CCT400",
        "ENTRY_USER_ID_NAME": "KALSOW, COURTNEY C",
        "ENTRY_DATE": "8/8/2018 12:00:00 AM",
        "EXTERNAL_ADMIN_C_NAME": "Confirmed",
        "MED_ADMIN_COMMENT": "via WIR",
        "IMMNZTN_STATUS_C_NAME": "Given",
        "IMM_HISTORIC_ADM_YN": "Y",
        "ENTRY_DTTM": "8/8/2018 1:43:33 PM"
      }
    },
    {
      "id": "59265744",
      "vaccine": "TYPHOID INACTIVATED (TYPHIM VI)",
      "date": "2019-02-05",
      "site": "Left Arm",
      "route": "Intramuscular",
      "administeredBy": "KALSOW, COURTNEY C",
      "status": "Given",
      "_epic": {
        "IMMUNE_ID": 59265744,
        "IMMUNZATN_ID": 64,
        "IMMUNZATN_ID_NAME": "TYPHOID INACTIVATED (TYPHIM VI)",
        "IMMUNE_DATE": "2/5/2019 12:00:00 AM",
        "ROUTE_C_NAME": "Intramuscular",
        "SITE_C_NAME": "Left Arm",
        "ENTRY_USER_ID": "CCT400",
        "ENTRY_USER_ID_NAME": "KALSOW, COURTNEY C",
        "ENTRY_DATE": "7/31/2020 12:00:00 AM",
        "IMMNZTN_STATUS_C_NAME": "Given",
        "IMM_CSN": 832464108,
        "IMM_HISTORIC_ADM_YN": "Y",
        "ENTRY_DTTM": "7/31/2020 9:22:05 AM"
      }
    },
    {
      "id": "59265745",
      "vaccine": "TDAP",
      "date": "2019-02-05",
      "site": "Left Arm",
      "route": "Intramuscular",
      "administeredBy": "KALSOW, COURTNEY C",
      "status": "Given",
      "_epic": {
        "IMMUNE_ID": 59265745,
        "IMMUNZATN_ID": 61,
        "IMMUNZATN_ID_NAME": "TDAP",
        "IMMUNE_DATE": "2/5/2019 12:00:00 AM",
        "ROUTE_C_NAME": "Intramuscular",
        "SITE_C_NAME": "Left Arm",
        "ENTRY_USER_ID": "CCT400",
        "ENTRY_USER_ID_NAME": "KALSOW, COURTNEY C",
        "ENTRY_DATE": "7/31/2020 12:00:00 AM",
        "IMMNZTN_STATUS_C_NAME": "Given",
        "IMM_CSN": 832464108,
        "IMM_HISTORIC_ADM_YN": "Y",
        "ENTRY_DTTM": "7/31/2020 9:22:05 AM"
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