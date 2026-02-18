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

Analyze the mapping pipeline for **Medications: ORDER_MED (7 splits) → HealthRecord.medications** and identify every semantic error — places where a column is read successfully but the value means something different than the code assumes.

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

### ORDER_MED
**Table**: The ORDER_MED table enables you to report on medications ordered in EpicCare (prescriptions). We have also included patient and contact identification information for each record.
- **ORDER_MED_ID**: The unique ID of the order record associated with this medication order. This is an internal unique identifier for ORD master file records in this table and cannot be used to link to CLARITY_MEDICATION.
- **PAT_ID**: The unique ID of the patient record for this line. This column is frequently used to link to the PATIENT table.
- **PAT_ENC_DATE_REAL**: A unique, internal contact date in decimal format. The integer portion of the number indicates the date of the contact. The digits after the decimal distinguish different contacts on the same date and are unique for each contact on that date. For example, .00 is the first/only contact, .01 is the second contact, etc.
- **PAT_ENC_CSN_ID**: The unique contact serial number (CSN) for the patient contact associated with this medication order. This number is unique across patients and encounters in your system. If you use IntraConnect, this is the Unique Contact Identifier (UCI).
- **ORDERING_DATE**: The date when the medication order was placed.
- **ORDER_CLASS_C_NAME**: The category number for the order class. This value is used to define how clinical systems process the order.
- **PHARMACY_ID**: The unique ID of the pharmacy record that is associated with this medication order. This column is frequently used to link to the RX_PHR table. This field is only populated if the clinical system user selects a specific pharmacy from the  list, otherwise the field is null. This field is only populated by the ambulatory clinical system, not the pharmacy system.
- **PHARMACY_ID_PHARMACY_NAME**: The name of the pharmacy.
- **ORD_CREATR_USER_ID**: The EMP ID (.1) of the user who signed the order (for a non-signed and held order) or the last person who performed a sign and hold or release action for a signed and held order.
- **ORD_CREATR_USER_ID_NAME**: The name of the user record. This name may be hidden.
- **MEDICATION_ID**: The unique ID of the medication record that is associated with this order. In some circumstances, for example when Intelligent Medication Selection selects an IMS mixture, this column may contain template records that do not represent real medications. For this reason, it is recommended to use the Clarity column ORDER_MEDINFO.DISPENSABLE_MED_ID when reporting on medication orders.
- **DESCRIPTION**: The description of the order. This information is found in the Order field of clinical system�s Order Detail window.
- **DOSAGE**: The dispensation amount for the prescription entered by the user in the orders activity. This amount is stored as a string in the orders database.
- **QUANTITY**: The quantity of the prescription being dispensed as entered by the user.
- **REFILLS**: The number of refills allowed for this prescription as entered by the user.
- **START_DATE**: The date when the medication order started. The date appears in calendar format.
- **END_DATE**: The date when the medication order is to end.
- **DISP_AS_WRITTEN_YN**: Indicates whether or not the prescription should be dispensed as written for this medication.
- **RSN_FOR_DISCON_C_NAME**: The category number for the reason a prescription has been discontinued.  This column contains data only in prescription orders that have been discontinued.
- **MED_PRESC_PROV_ID**: The unique ID of the provider who has prescribed or authorized the medication order. The value in this column matches the value in the AUTHRZING_PROV_ID column.
- **NONFRM_XCPT_CD_C_NAME**: The category number for medication's exception code.  This code explains the reason a non-formulary medication was ordered.
- **PANEL_MED_ID**: The unique ID of the medication panel that is associated with this medication order. This column is only populated if the medication order was originally placed as part of a panel.
- **UPDATE_DATE**: The date and time when this row was created or last updated in Clarity.
- **ORDER_INST**: The date and time the order was placed. The date appears in calendar format.
- **DISPLAY_NAME**: The name of the medication as it appears on the medication record itself.
- **AS_MEDICATION_ID**: The unique ID of the brand name medication originally chosen by the ordering user. This column is blank if the user did not chose a brand name record.  It is recommended to use the Clarity column ORDER_MEDINFO.DISPENSABLE_MED_ID when reporting on medication orders. Use AS_MEDICATION_ID if specifically searching for orders that were originally selected from a preference list as a brand name medication.
- **HV_HOSPITALIST_YN**: Indicates whether  this is a hospitalist order. A Y indicates a hospitalist order.
- **ORDER_PRIORITY_C_NAME**: The category number for the priority assigned to an order.
- **MED_ROUTE_C_NAME**: The category number for the route of administration of a medication.
- **DISCON_USER_ID**: The unique ID of the user who discontinued the order.
- **DISCON_USER_ID_NAME**: The name of the user record. This name may be hidden.
- **DISCON_TIME**: The date and time when the medication order was discontinued. The date appears in calendar format.
- **CHNG_ORDER_MED_ID**: The unique ID of the changed or reordered medication order that this order replaced. This column is frequently used to link back to the ORDER_MED table.
- **PEND_APPR_USER_ID**: The unique ID of the user who approved a pended order.
- **PEND_APPR_USER_ID_NAME**: The name of the user record. This name may be hidden.
- **PEND_REF_REAS_C_NAME**: The category number for the reason a pended medication was refused.
- **HV_DISCR_FREQ_ID**: The unique ID of the discrete frequency record associated with this medication order. This column is frequently used to link to the IP_FREQUENCY table.
- **HV_DISCR_FREQ_ID_FREQ_NAME**: The name of the frequency record.
- **HV_DISCRETE_DOSE**: The discrete dose for a medication as entered by the user in the orders activity.
- **HV_DOSE_UNIT_C_NAME**: The category number for the dosage unit of a medication.
- **HV_IS_SELF_ADM_YN**: Indicates whether this medication was self-administered. A Y indicates that the order was self-administered.
- **ORDER_START_TIME**: The date and time when the medication order is to start. The date appears in calendar format.
- **ORDER_END_TIME**: The date and time when the medication order is scheduled to end. The date appears in calendar format.
- **NON_FORMULARY_YN**: Indicates whether this medication is not on the formulary. A Y indicates a non-formulary medication.
- **ORDER_STATUS_C_NAME**: The category number for the current status of an order.
- **AUTHRZING_PROV_ID**: The unique ID of the provider who has prescribed or authorized the medication order. The value in this column matches the value in the MED_PRESC_PROV_ID column.
- **ORD_PROV_ID**: The unique ID of the provider listed as the ordering provider.
- **MIN_DISCRETE_DOSE**: The minimum ordered dose amount for the medication as specified by the user in the orders activity.
- **MAX_DISCRETE_DOSE**: The maximum ordered dose amount for the medication as specified by the user in the orders activity.
- **DOSE_UNIT_C_NAME**: The category number for the dose unit of a medication.
- **IS_PENDING_ORD_YN**: Indicates whether the order has a pending status. A Y indicates that the order does have a pending status.
- **BULK_DISP_YN**: Indicates whether this is a bulk dispense order. A Y indicates this is a bulk dispense order.
- **PROVIDER_TYPE_C_NAME**: The medication provider type category number for the order.  This item distinguishes between authorizing and documenting provider types for historical and non-historical medications.  If the medication was ordered as historical, the provider is considered the documenting provider and is reflected as such in this item.  If the medication was not ordered as historical, the provider is considered the authorizing provider is reflected in this item as such.
- **MODIFY_TRACK_C_NAME**: The category number for the flag that both indicates and distinguishes whether an order was reordered or modified.
- **SPECIFIED_FIRST_TM**: If the order was placed with a Specified frequency (the frequency's Type (I EFQ 50) item has a value of 1) and the user specified a first occurrence time, the time specified is stored in this column.
- **SCHED_START_TM**: The date and time at which an order was scheduled to begin. The date appears in calendar format.
- **ACT_ORDER_C_NAME**: The category number indicating additional information about an order's status--Active, Completed, Discontinued, or Cancelled. An active order is any order that has not been completed, discontinued, cancelled, pended, or signed and held.
- **EXP_AFT_START_DATE**: The number of days after the start date that the medication order will expire based on the setting in the medication record. The date appears in calendar format.
- **EXP_BEF_END_DATE**: The number of days before the end date that the medication order will expire based on the setting in the medication record. The date appears in calendar format.
- **MED_COMMENTS**: Comments for a medication order, as entered by the ordering user when entering the order.
- **USER_SEL_MED_ID**: The unique ID of the orderable medication that is evaluated for Intelligent Medication Selection (IMS). This item is blank if the order is not evaluated for IMS.  It is recommended to use the Clarity column ORDER_MEDINFO.DISPENSABLE_MED_ID when reporting on medication orders. Use USER_SEL_MED_ID if searching for medication orders that were evaluated by IMS.
- **USER_SEL_ERX_DAT**: The date that the medication record was actually selected by the user.  This item is populated only if Intelligent Medication Selection (IMS) replaced the original user-selected medication with another medication record.
- **REQ_RNVERIFY_YN**: Indicates whether this medication order requires RN verification before it is administered. A Y indicates that it does require RN verification.
- **MDL_ID**: The unique ID of the medication problem list record that is associated with this medication order. This column is frequently used to link to the MDL_MD_PRBLM_LIST table.
- **LASTDOSE**: Comments for the last administered dose of a medication entered in the medication documentation navigator section.
- **INFORMANT_C_NAME**: The category number for the informant of a prior to admission (PTA) medication.  The informant is the person who reports a PTA medication being taken by the patient.
- **AMB_MED_DISP_NAME**: The name of the ambulatory medication.
- **WEIGHT_BASED_YN**: Indicates whether the dose for this medication order is based on the patient's weight.
- **WEIGHT_REVIEW_YN**: Indicates whether or not the patient's weight needs to be reviewed for this medication order due to the patient's weight change.
- **ORD_TM_WEIGHT**: The patient's last reviewed weight at the time the medication was ordered.
- **ORDER_TIME_WT_INST**: The date and time when a new weight is recorded for a patient for a weight based medication review.
- **REVIEW_WEIGHT**: The patient's last non-reviewed weight at the time the medication was ordered.
- **REVIEW_WEIGHT_INST**: The instant when the patient's last non-reviewed weight was entered prior to when the medication was ordered.
- **REFILLS_REMAINING**: The number of refills remaining in the medication.
- **MED_REFILL_PROV_ID**: The unique ID of the provider who authorized the medication refill order.
- **OLD_ORDER_ID**: The unique ID of the order record that points to the parent medication for refills.
- **OLD_ORDER_DAT**: The internal contact date of the parent medication in integer format.  Used to identify the parent medication and will only be populated for child orders.  This does not link to CONTACT_DATE_REAL.
- **RESUME_STATUS_C_NAME**: The category number that indicates an outpatient medication order's status before it was suspended as a result on inpatient admission.
- **USER_ID_OF_PROV**: The unique ID of the user record that is linked to the provider ID in the AUTHRZING_PROV_ID column.
- **ORDERING_MODE_C_NAME**: The category number for the ordering mode of the order (i.e. Outpatient, Inpatient).  Note that Outpatient orders can be placed from an Inpatient encounter as discharge orders / take-home prescriptions.  This column might be blank for Outpatient orders placed prior to the creation of the IP module.
- **PEND_APPROVE_FLAG_C_NAME**: The pending medication approval status category number for the order.
- **NF_POST_VERIF_YN**: Indicates whether a medication order has been verified by the pharmacist as non-formulary. A Y indicates that the pharmacist verified the medication order as non-formulary. An administrator can use this column to report on how many orders that were placed as non-formulary were also verified as such. To find which orders were placed as non-formulary, use the NON_FORMULARY_YN column.
- **EXT_ELG_SOURCE_ID**: External eligibility source ID
- **EXT_ELG_MEMBER_ID**: External eligibility member ID
- **EXT_FORMULARY_ID**: External formulary ID
- **EXT_COVERAGE_ID**: External coverage ID
- **EXT_COPAY_ID**: This column contains the external copay ID for an order.
- **EXT_PHARMACY_TYPE_C_NAME**: External pharmacy type
- **EXT_FORMULARY_STAT**: External Formulary Status
- **EXT_COV_AGE_LMT_YN**: External coverage age limits
- **EXT_COV_EXCLUS_YN**: External coverage product coverage exclusion
- **EXT_COV_SEX_LMT_YN**: External coverage gender limits
- **EXT_COV_MED_NCST_YN**: External coverage medical necessity
- **EXT_COV_PRI_AUTH_YN**: External coverage prior authorization
- **EXT_COV_QNTY_LMT_YN**: External coverage quantity limits
- **EXT_COV_LNK_DRUG_YN**: External coverage resource link drug
- **EXT_COV_LNK_SMRY_YN**: External coverage resource link summary
- **EXT_COV_STEP_MED_YN**: External coverage step medication
- **EXT_COV_STEP_THR_YN**: External coverage step therapy
- **USR_SEL_IMS_YN**: This item stores whether the product to use with IMS was selected by the user or chosen automatically.  Yes means the user chose the product, No means the product was selected automatically.
- **INDICATION_COMMENTS**: The comment entered for the indications of use for this order.
- **DOSE_ADJ_TYPE_C_NAME**: The type of dose adjustment that was triggered by the order (i.e. maximum or minimum dose).
- **DOSE_ADJ_OVERRID_YN**: This item indicates whether the dose adjustment (i.e. maximum or minimum dose) was overridden.
- **MAX_DOSE**: The maximum allowed dose for this medication order.
- **MAX_DOSE_UNIT_C_NAME**: The unit for the maximum allowed dose for this medication order.
- **PRN_COMMENT**: The user-entered comments for why the as needed (PRN) medication should be administered.
- **INST_OF_UPDATE_TM**: The day and time the order record was last updated.
- **PEND_ACTION_C_NAME**: The manner in which the medication was reordered, such as reorder from order review or reorder from the medications activity.
- **MED_DIS_DISP_QTY**: This item stores the discrete dispense quantity when discrete dispense is enabled.
- **MED_DIS_DISP_UNIT_C_NAME**: This item stores the discrete dispense unit when discrete dispense is enabled.
- **END_BEFORE_CMP_INST**: The default end date and time of a completed order.  When an order is completed, we will store the system calculated end date and time (which may differ from the actual completion time) in this column in the event the completion is reversed and the defaults need to be restored.
- **BSA_BASED_YN**: Indicates whether the dose for this medication order is based on the patient's body surface area (BSA).
- **BSA_REVIEW_YN**: Flags orders that need to be reviewed because of a BSA change.
- **ORD_TM_BSA**: The patient's last reviewed BSA at the time this order was placed.
- **REVIEW_BSA**: The patient's last non-reviewed body surface areas (BSA) at the time the medication was ordered.
- **LAST_DOSE_TIME**: Store the time that a PTA med was last taken.

### ORDER_MED_2
**Table**: This table enables you to report on medications ordered in EpicCare or Ambulatory Pharmacy (Prescriptions).





This table should be used with ORDER_MED.
- **ORDER_ID**: The unique ID of the order record associated with this medication order. This is an internal unique identifier for order records in this table and cannot be used to link to CLARITY_MEDICATION.
- **TXT_AUTHPROV_NAME**: In ambulatory pharmacy, a prescription order could be authorized by a non-EpicCare provider. There is no provider record for this provider. This is used to store the non-EpicCare provider's name.
- **TXT_AUTHPROV_DEA**: In ambulatory pharmacy, a prescription order could be authorized by a non-EpicCare provider. There is no provider record for this provider. This is used to store the non-EpicCare provider's Dynamic Epic Advisory Database (DEA) number.
- **TXT_AUTHPROV_PHONE**: In ambulatory pharmacy, a prescription order could be authorized by a non-EpicCare provider. There is no provider record for this provider. This is used to store the non-EpicCare provider's phone number.
- **TXT_AUTHPROV_FAX**: In ambulatory pharmacy, a prescription order could be authorized by a non-EpicCare provider. There is no provider record for this provider. This is used to store the non-EpicCare provider's fax number.
- **TXT_AUTHPROV_STREET**: In ambulatory pharmacy, a prescription order could be authorized by a non-EpicCare provider. There is no provider record for this provider. This is used to store the non-EpicCare provider's street address information.
- **TXT_AUTHPROV_CITY**: In ambulatory pharmacy, a prescription order could be authorized by a non-EpicCare provider. There is no provider record for this provider. This is used to store the non-EpicCare provider's city.
- **TXT_AUTHPROV_ZIP**: In ambulatory pharmacy, a prescription order could be authorized by a non-EpicCare provider. There is no provider record for this provider. This is used to store the non-EpicCare provider's zip code.
- **RX_NUM_FORMATTED**: The formatted prescription number for the order.
- **RX_COMMENTS**: In an ambulatory pharmacy, the person who enters the prescription into the system can add additional comments to the prescription. The comments are not part of the order and are used for pharmacy internal communication only. The comments do not affect the patient instructions, nor the dispense information.
- **RX_WRITTEN_DATE**: Store the prescription written date, which is the date the prescription was entered into the system through EpicCare, or the date the prescription was written to the paper prescription.
- **MED_DISCONT_ENC**: *** Deprecated *** The data in this column does not correctly link to PAT_ENC.PAT_ENC_DATE_REAL. ORDER_MED_5.DISCON_PAT_ENC_DATE_REAL should be used for this link instead. ******
- **EFQ_OVRD_DAY_TYPE**: Specifies what the numeric values in the frequency override days columns represent. If it is 1 then the listed days are relative days. If it is 2 then the listed days are weekdays. Any other value has no meaning.
- **EFQ_OVRD_CYCL_LEN**: If there is a frequency override specified, this item will contain the length of a relative specified type cycle. For all other specified types this value will be ignored (and should be empty).
- **CHART_CORRECTION_ID**: For chart corrections, links the order to a Chart Correction Audit (CCA) record.
- **PARENT_CE_ORDER_ID**: When a cross-encounter order is released, this item stores the ID of the parent order.
- **TPL_WT_SRC_C_NAME**: The weight source of the treatment plan for this order, as of the time the order is signed.
- **OVERRIDE_LINKED_C_NAME**: The linked override resolved category number for the medication order. The category indicates whether the admins in the override pull are all linked to pharmacy orders.
- **CONDITIONAL_C_NAME**: Identifies an inpatient order as "conditional".
- **COND_STATUS_C_NAME**: For a conditional order, indicates whether the conditions for the order have been satisfied yet.
- **PEND_REF_REAS_COMM**: Extracts the comment attached to the pend refusal reason (I ORD 7706)
- **PRIORITIZED_INST_TM**: The time and date that is used as the prioritized date.
- **ORDER_QUESN_LIST**: The order specific questions that are listed in the order composer for the order.
- **EXT_PHARM_MED_NAME**: Medication display name received from an external pharmacy.
- **PEND_MED_ACTIVE_YN**: A flag to determine if this is an active pending medication or not.
- **PEND_PREV_ORD_ID**: The previous order ID for the pending medication. This item is NOT networked to orders.
- **TXT_AUTHPROV_NPI**: If the authorizing provider for a medication is not currently an Epic provider (no SER record for this provider), free text provider items are used to save information about this provider. This item stores the National Provider ID (NPI) of the provider.
- **ORD_TRANS_METHOD_C_NAME**: This item holds the method of transmission for a given order. It should only be set from within an order transmittal rule using the transmission method property (LRC 161).
- **PROFILE_ONLY_RX_YN**: This item specifies whether the medication order is intended to be filled by the pharmacy immediately or should be filled later when requested by the patient. This flag can be set in order entry based on the order class or by selecting the 'profile only' checkbox in pharmacy order entry.
- **DISP_QTY_REM**: Stores the remaining authorized quantity (in Written Dispense Quantity unit) that the pharmacist can dispense. It is used in Ambulatory Pharmacy to calculate the Refills Remaining.
- **FREQ_UNSCHEDULED_C_NAME**: If the frequency is unscheduled, this column will store a 1. If the frequency is not unscheduled, this column will be blank.
- **DURATION**: Duration for this medication.
- **INTERVENTION**: Intervention for this medication.
- **LAST_SUSPEND_DTTM**: Instant this medication was last suspended.
- **SIGN_ACTION_PEND_C_NAME**: Sign action for pended order.
- **ORIG_MED_ID**: Original prescription column; contains the medication order medication ID.
- **ORIG_STRENGTH**: Original prescription column; contains the medication order strength.
- **ORIG_ROUTE_C_NAME**: Original prescription column; contains the medication order route.
- **ORIG_MED_SOURCE_C_NAME**: Original prescription column; contains the medication order source.
- **ORIG_DIS_DISP_QTY**: Original prescription column; contains the medication order discrete dispense quantity.
- **ORIG_DISP_UNIT_C_NAME**: Original prescription column; contains the medication order discrete dispense unit.
- **ORIG_START_DATE**: Original prescription column; contains the medication order start date.
- **ORIG_END_DATE**: Original prescription column; contains the medication order end date.
- **ORIG_DAW_YN**: Original prescription column; contains the medication order 'dispense as written?' flag and is either yes or no.
- **PENDDC_STATUS_C_NAME**: Status of an order with regard to pending discontinue.
- **MED_DISC_REFILLS**: Saves the discrete medication refills information for the order.
- **BACK_DATED_YN**: Indicates whether the order was back-dated at the time the start date was entered
- **RX_CLINICALLY_RV_YN**: This specifies whether the prescription has been clinically reviewed by a pharmacist. Clinical review can either be required to occur before a prescription is filled or after it is filled during fill verification.
- **PRIORITIZED_UTC_DTTM**: Stores the prioritized instant for the result in UTC

### ORDER_MED_3
**Table**: This table enables you to report on medications ordered. This table should be used with ORDER_MED.
- **ORDER_ID**: The unique identifier for the order record.
- **ORIG_RX_DOSAGE**: Original prescription column; contains the medication order dosage.
- **ORIG_RX_QUANTITY**: Original prescription column; contains the medication order quantity.
- **ORIG_RX_REFILLS**: Original prescription column; contains the medication refills.
- **ORIG_RX_DIRECTIONS**: Original prescription column; contains the medication directions.
- **ORIG_RX_PRE_PROV_ID**: Original prescription column; contains the medication order prescriber ID.
- **ORIG_RX_COMMENTS**: Original prescription column; contains the medication comments.
- **PRESCRIP_EXP_DATE**: Contains the expiration date for the prescription.
- **ORD_AUC**: Item to store the area under curve value for medications using this value in dose calculation.
- **ORD_SEL_TARGETAUC_C_NAME**: Selected type of the Target AUC in the order composer.
- **ORIG_RX_PHRM_ID**: Original prescription column; contains the pharmacy
- **ORIG_RX_PHRM_ID_PHARMACY_NAME**: The name of the pharmacy.
- **ORD_PHASE_OF_CARE_C_NAME**: This item will store the phase of care for which this order was created. Example: Pre-Op, Intra-Op, PACU.
- **ORIGINAL_MED_ID**: The unique ID of the medication that determines the formulary status of the order at order entry. The formulary status of this medication at the time of ordering is found in the column ORDER_MED.NON_FORMULARY_YN. For Intelligent Medication Selection (IMS) cases, it will be the medication picked by the user before IMS changes the medication. This is only set for inpatient medication orders.  It is recommended to use the Clarity column ORDER_MEDINFO.DISPENSABLE_MED_ID when reporting on medication orders. Use ORIGINAL_MED_ID for reporting on the formulary status of medications chosen by ordering users.
- **INTERACT_COMMENT**: Interaction override comment.
- **COPY_POINTER_ID**: This object tracks order (ORD) record links created when using the inpatient or ambulatory order mover utilities to move an ORD record. This item is populated on the source ORD record and points to the target ORD record(s) created.
- **CONDITION_FLAG**: This column contains the Condition Flag for an order.
- **PRINT_LOCAL_COPY_YN**: Indicates whether to print a copy of this order. 'Y' indicates to print a copy of this order.  'N' indicates not to print a copy of this order.
- **ORX_ID**: This column contains the record ID from the Order Lookup Index (ORX).  The ORX contains records for all active medication records and procedure records. This may be populated if an order originates from an Order Panel.
- **ORX_ID_ORDER_LOOKUP_NAME**: The name (.2 item) for the order panel record.
- **SELECTED_FOR_OPC_YN**: Indicates whether the order has been selected for resulting in the Orderable/Performable/Chargeable navigator.
- **MEDS_RESYME_REASO_C_NAME**: This item stores the reason to resume the medication.
- **MEDS_DC_REASON_C_NAME**: This item is populated in discharge navigator to save discontinue reason at the time of discharge. The value entered will be copied to I ORD 7074.
- **IP_INCLUDE_NOW_C_NAME**: This is when to start the medication administration.
- **IP_INCL_NOW_SCH_C_NAME**: Result of Scheduling Include Now Instant for Order
- **LAST_SCHED_DATE**: The last scheduled date of the order.
- **MEDS_ACTION_VERB_C_NAME**: Action verb which is used in patient sig of the order.
- **MED_SOURCE_C_NAME**: Source of externally ordered medication.
- **CRCL_FORMULA_ID**: The creatinine clearance  CrCl programming point that will be used for AUC calculations for order whose dose calculation programming point does not specify a CrCl programming point.
- **CRCL_FORMULA_ID_LPP_NAME**: The name of the extension.
- **AFTER_ORDER_ID**: This column contains the After Order ID for an order.
- **BEFORE_ORDER_ID**: This column contains the Before Order ID for an order.
- **DIET_COMMENTS**: This column contains the Diet Comments entered for an order.
- **END_DT_BEF_FILL_DT**: Stores the order's end date before it was changed due to the order being (re)filled. This is needed so that if the fills are ever cancelled, we know what to set the end date back to.
- **PREV_POC_C_NAME**: This column contains the previous phase of care (I ORD 61040). The phase of care for an order is stored in I ORD 61010.  If the phase of care is not needed when the sign and held order is released, the phase of care stored in I ORD 61010 is moved to I ORD 61040 for tracking purposes. The phase of care stored in I ORD 61040 can still be used in the MAR activity to allow for continued phase of care grouping.  The list of phases of care not needed when sign and held orders are released is stored in I LSD 61050.
- **ORDER_TIME**: The date and time when the medication order was placed.
- **IS_HELD_ORDER_C_NAME**: This item stores 1 if the order is signed and held and active
- **TXT_ORDPROV_NAME**: The name of the ordering provider, for providers that do not yet exist in the Provider (SER) master file.
- **TXT_ORDPROV_DEA**: The DEA number of the ordering provider, for providers that do not yet exist in the Provider (SER) master file. A DEA number is given to providers by the Drug Enforcement Administration and allows them to prescribe controlled substances.
- **TXT_ORDPROV_NPI**: The National Provider Identifier (NPI) of the ordering provider, for providers that do not yet exist in the Provider (SER) master file.
- **TXT_ORDPROV_PHONE**: The phone number of the ordering provider, for providers that do not yet exist in the Provider (SER) master file.
- **TXT_ORDPROV_FAX**: The fax number of the ordering provider, for providers that do not yet exist in the Provider (SER) master file.
- **TXT_ORDPROV_STREET**: The street address of the ordering provider, for providers that do not yet exist in the Provider (SER) master file.
- **TXT_ORDPROV_CITY**: The city of the ordering provider, for providers that do not yet exist in the Provider (SER) master file.
- **TXT_ORDPROV_STATE_C_NAME**: The state of the ordering provider, for providers that do not yet exist in the Provider (SER) master file.
- **TXT_ORDPROV_ZIP**: The zip code of the ordering provider, for providers that do not yet exist in the Provider (SER) master file.
- **RX_SERIAL_NUMBER**: Stores the prescription serial number commonly found on triplicate prescription forms. Triplicate prescription forms are used for controlled substances and require multiple copies of the prescription form.
- **NOCHRG_EXT_RSLT_YN**: This column returns whether the order is an external result that should not drop charges. A value of 1 returns Y. A value of 0 returns N. A null value will return null but is treated the same as 0 when dropping charges.
- **WT_MAX_DOSE**: This column returns the saved weight-based or body surface area (BSA)-based maximum dose for the order (ORD).
- **WT_MAX_DOSE_UNIT_C_NAME**: This column returns the saved unit for the weight-based or body surface area (BSA)-based maximum dose for the order (ORD).
- **MAX_DOSE_SOURCE_C_NAME**: This column returns the source of max dose information that was used in the order (ORD).
- **SRC_RX_MED_ID**: The ID of the originally prescribed medication as returned by the pharmacy in a refill request.
- **SRC_RX_QUANTITY**: The quantity of the originally prescribed medication as returned by the pharmacy in a refill request.
- **SRC_RX_DIS_DISP_QTY**: The discrete dispense quantity of the originally prescribed medication as returned by the pharmacy in a refill request.
- **SRC_RX_DISP_UNIT_C_NAME**: The discrete dispense unit of the originally prescribed medication as returned by the pharmacy in a refill request.
- **SRC_RX_REFILLS**: The number of refills of the originally prescribed medication as returned by the pharmacy in a refill request.
- **SRC_RX_DIRECTIONS**: The directions (patient sig) of the originally prescribed medication as returned by the pharmacy in a refill request.
- **SRC_RX_START_DATE**: The start date of the originally prescribed medication as returned by the pharmacy in a refill request.
- **SRC_RX_END_DATE**: The end date of the originally prescribed medication as returned by the pharmacy in a refill request.
- **SRC_RX_DAW_YN**: The Dispense as Written (DAW) flag of the originally prescribed medication as returned by the pharmacy in a refill request.
- **SRC_RX_PRES_PROV_ID**: The ID of the prescribing provider of the originally prescribed medication as returned by the pharmacy in a refill request.
- **SRC_RX_COMMENTS**: The comments associated with the originally prescribed medication as returned by the pharmacy in a refill request.
- **PAT_SIG_REPLY_C_NAME**: This column contains the user's response to the sig-related questions for previous sig reorder workflows. The sig is the description of how a medication is supposed to be administered which includes the dose and frequency.
- **SIG_REVIEW_USER_ID**: Holds the user ID of the user who reviewed the patient sig for accuracy. The sig is the description of how a medication is supposed to be administered which includes the dose and frequency.
- **SIG_REVIEW_USER_ID_NAME**: The name of the user record. This name may be hidden.
- **SIG_REVIEW_INS_DTTM**: Holds the instant that the user took action on the patient sig in previous sig workflows. The sig is the description of how a medication is supposed to be administered which includes the dose and frequency.
- **SRC_RX_WRITTEN_DATE**: The written date of the originally prescribed medication as returned by the pharmacy in a refill request.
- **DOSE_RND_ACK_RSN_C_NAME**: The category number for the acknowledgement reason given by the user to override a dose rounding warning on this order.
- **SRC_RX_DESC**: The description of the originally prescribed medication as returned by the pharmacy in a refill request.
- **EPRES_DEST_C_NAME**: Indicates the destination of e-prescribing order. It will be set by an interface or the ambulatory pharmacy system. The item may not be populated for the old order records.
- **CTRL_MED_YN**: Indicates whether the medication was controlled when the order was signed.

### ORDER_DX_MED
**Table**: The ORDER_DX_MED table enables you to report on the diagnoses associated with medications ordered in clinical system (prescriptions). Since one medication order may be associated with multiple diagnoses, each row in this table is one medication - diagnosis relation. We have also included patient and contact identification information for each record. Note that system settings may or may not require that medications be associated with diagnoses.  This table contains only information for those medications and diagnoses that have been explicitly associated.  Check with your clinical system Application Administrator to determine how your organization has this set up.
- **ORDER_MED_ID**: The unique ID of the medication order (prescription) record.
- **LINE**: The line number for the information associated with this contact. Multiple pieces of information can be associated with this contact.
- **PAT_ENC_DATE_REAL**: A unique, internal contact date in decimal format. The integer portion of the number indicates the date of the contact. The digits after the decimal distinguish different contacts on the same date and are unique for each contact on that date. For example, .00 is the first/only contact, .01 is the second contact, etc.
- **PAT_ENC_CSN_ID**: The unique contact serial number for this contact. This number is unique across all patient encounters in your system. If you use IntraConnect this is the Unique Contact Identifier (UCI).
- **DX_ID**: The unique ID of the diagnosis record associated with the medication order.
- **DX_QUALIFIER_C_NAME**: The category ID of the qualifier associated with the diagnosis.
- **DX_CHRONIC_YN**: Indicates whether the associated diagnosis is chronic.
- **COMMENTS**: Free text comments added when the prescription was ordered or discontinued.

### ORDER_MED_SIG
**Table**: The ORDER_MED_SIG table stores the patient instructions for a prescription as entered by the user. The table should be used in conjunction with the ORDER_MED table which contains related medication, patient, and contact identification information you can report on.
- **ORDER_ID**: The unique ID of the order record associated with this medication order. This is an internal unique identifier for ORD master file records in this table and cannot be used to link to CLARITY_MEDICATION.
- **SIG_TEXT**: Patient instructions for the prescription as entered by the user.

## Sample Data (one representative non-null value per column)

### ORDER_MED
- ORDER_MED_ID = `772179261`
- PAT_ID = `Z7004242`
- PAT_ENC_DATE_REAL = `66444`
- PAT_ENC_CSN_ID = `974614965`
- ORDERING_DATE = `12/1/2022 12:00:00 AM`
- ORDER_CLASS_C_NAME = `Normal`
- PHARMACY_ID = `64308`
- PHARMACY_ID_PHARMACY_NAME = `WALGREENS DRUG STORE #06130 - MADISON, WI - 3700 UNIVERSITY AVE AT NEC OF MIDVALE & UNIVERSITY`
- ORD_CREATR_USER_ID = `RAMMELZL`
- ORD_CREATR_USER_ID_NAME = `RAMMELKAMP, ZOE L`
- MEDICATION_ID = `5674`
- DESCRIPTION = `NORTRIPTYLINE HCL 10 MG PO CAPS`
- QUANTITY = `90 capsule`
- REFILLS = `1`
- START_DATE = `12/1/2022 12:00:00 AM`
- END_DATE = `2/20/2023 12:00:00 AM`
- DISP_AS_WRITTEN_YN = `N`
- RSN_FOR_DISCON_C_NAME = `*Reorder (sends cancel message to pharmacy)`
- MED_PRESC_PROV_ID = `144590`
- UPDATE_DATE = `4/4/2023 4:11:00 PM`
- ORDER_INST = `12/1/2022 10:15:00 AM`
- DISPLAY_NAME = `nortriptyline (PAMELOR) capsule`
- HV_HOSPITALIST_YN = `N`
- ORDER_PRIORITY_C_NAME = `Routine`
- MED_ROUTE_C_NAME = `Oral`
- DISCON_USER_ID = `RAMMELZL`
- DISCON_USER_ID_NAME = `RAMMELKAMP, ZOE L`
- DISCON_TIME = `2/20/2023 7:27:00 PM`
- CHNG_ORDER_MED_ID = `772179266`
- PEND_APPR_USER_ID = `RAMMELZL`
- PEND_APPR_USER_ID_NAME = `RAMMELKAMP, ZOE L`
- HV_DISCR_FREQ_ID = `200058`
- HV_DISCR_FREQ_ID_FREQ_NAME = `NIGHTLY`
- HV_DISCRETE_DOSE = `10`
- HV_DOSE_UNIT_C_NAME = `mg`
- ORDER_START_TIME = `12/1/2022 12:00:00 AM`
- ORDER_END_TIME = `2/20/2023 12:00:00 AM`
- ORDER_STATUS_C_NAME = `Sent`
- AUTHRZING_PROV_ID = `144590`
- ORD_PROV_ID = `144590`
- MIN_DISCRETE_DOSE = `10`
- DOSE_UNIT_C_NAME = `mg`
- PROVIDER_TYPE_C_NAME = `Authorizing`
- MODIFY_TRACK_C_NAME = `REORDERED`
- ACT_ORDER_C_NAME = `Active Medication`
- USER_SEL_MED_ID = `5674`
- USER_SEL_ERX_DAT = `9/6/2016 12:00:00 AM`
- MDL_ID = `73847702`
- LASTDOSE = `Taking`
- AMB_MED_DISP_NAME = `nortriptyline (PAMELOR) 10 MG capsule`
- WEIGHT_BASED_YN = `N`
- REFILLS_REMAINING = `1`
- MED_REFILL_PROV_ID = `144590`
- ORDERING_MODE_C_NAME = `Outpatient`
- PEND_APPROVE_FLAG_C_NAME = `Approved`
- EXT_ELG_SOURCE_ID = `P00000000001001`
- EXT_ELG_MEMBER_ID = `FA1000010XMWEJQ%602496879%001`
- EXT_FORMULARY_ID = `00935`
- EXT_COVERAGE_ID = `003171310000000000000000`
- EXT_PHARMACY_TYPE_C_NAME = `Retail+Mail`
- EXT_FORMULARY_STAT = `4`
- EXT_COV_AGE_LMT_YN = `N`
- EXT_COV_EXCLUS_YN = `N`
- EXT_COV_SEX_LMT_YN = `N`
- EXT_COV_MED_NCST_YN = `N`
- EXT_COV_PRI_AUTH_YN = `N`
- EXT_COV_QNTY_LMT_YN = `N`
- EXT_COV_LNK_DRUG_YN = `N`
- EXT_COV_LNK_SMRY_YN = `N`
- EXT_COV_STEP_MED_YN = `N`
- EXT_COV_STEP_THR_YN = `N`
- USR_SEL_IMS_YN = `Y`
- INST_OF_UPDATE_TM = `2/20/2023 1:27:00 PM`
- PEND_ACTION_C_NAME = `Reorder`
- MED_DIS_DISP_QTY = `90`
- MED_DIS_DISP_UNIT_C_NAME = `capsule`
- BSA_BASED_YN = `N`

### ORDER_MED_2
- ORDER_ID = `772179261`
- RX_WRITTEN_DATE = `8/29/2022 12:00:00 AM`
- MED_DISCONT_ENC = `54786`
- PRIORITIZED_INST_TM = `8/29/2022 2:23:00 PM`
- EXT_PHARM_MED_NAME = `NORTRIPTYLINE 10MG CAPSULES`
- PEND_MED_ACTIVE_YN = `N`
- PEND_PREV_ORD_ID = `772179269`
- ORD_TRANS_METHOD_C_NAME = `E-Prescribed`
- PROFILE_ONLY_RX_YN = `N`
- DISP_QTY_REM = `90`
- FREQ_UNSCHEDULED_C_NAME = `YES`
- SIGN_ACTION_PEND_C_NAME = `Sign`
- ORIG_MED_ID = `5674`
- ORIG_DIS_DISP_QTY = `90`
- ORIG_DISP_UNIT_C_NAME = `capsule`
- ORIG_DAW_YN = `N`
- MED_DISC_REFILLS = `1`
- PRIORITIZED_UTC_DTTM = `8/29/2022 7:23:00 PM`

### ORDER_MED_3
- ORDER_ID = `772179261`
- ORIG_RX_QUANTITY = `90 capsule`
- ORIG_RX_DIRECTIONS = `TAKE 1 CAPSULE BY MOUTH EVERY NIGHT. START WITH 1 CAPSULE AT NIGHT; CAN. INCREASE TO 2 CAPSULES AFTE`
- ORIG_RX_PRE_PROV_ID = `144590`
- PRESCRIP_EXP_DATE = `8/29/2023 12:00:00 AM`
- ORIG_RX_PHRM_ID = `64308`
- ORIG_RX_PHRM_ID_PHARMACY_NAME = `WALGREENS DRUG STORE #06130 - MADISON, WI - 3700 UNIVERSITY AVE AT NEC OF MIDVALE & UNIVERSITY`
- PRINT_LOCAL_COPY_YN = `N`
- ORDER_TIME = `8/29/2022 2:23:00 PM`
- PAT_SIG_REPLY_C_NAME = `Use discrete sig`
- SIG_REVIEW_USER_ID = `MBS403`
- SIG_REVIEW_USER_ID_NAME = `SMITH, MARY B`
- SIG_REVIEW_INS_DTTM = `12/22/2023 3:11:00 PM`
- EPRES_DEST_C_NAME = `Outgoing Interface`

### ORDER_DX_MED
- ORDER_MED_ID = `772179261`
- LINE = `1`
- PAT_ENC_DATE_REAL = `66350`
- PAT_ENC_CSN_ID = `948004323`
- DX_ID = `108212`
- DX_CHRONIC_YN = `N`

### ORDER_MED_SIG
- ORDER_ID = `772179261`
- SIG_TEXT = `Take 1 (one) tablet by mouth daily.`

## Pipeline Code

### Stage 1: SQL Projection (project.ts → raw JSON)
```typescript
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
```

### Stage 2: Domain Model Hydration (PatientRecord.ts)
```typescript
// Medications are raw EpicRow[] — no typed class
```

### Stage 3: Clean Projection (HealthRecord.ts → final output)
```typescript
function projectMedication(m: any): Medication {
  const dose = [str(m.HV_DISCRETE_DOSE), str(m.HV_DOSE_UNIT_C_NAME)].filter(Boolean).join(' ') || null;
  return {
    id: sid(m.ORDER_MED_ID),
    name: m.AMB_MED_DISP_NAME ?? m.DISPLAY_NAME ?? m.DESCRIPTION ?? 'Unknown',
    genericName: str(m.DESCRIPTION),
    dose, route: str(m.MED_ROUTE_C_NAME),
    frequency: str(m.HV_DISCR_FREQ_ID_FREQ_NAME),
    sig: str(m.SIG),
    startDate: toISODate(m.START_DATE), endDate: toISODate(m.END_DATE),
    status: str(m.ORDER_STATUS_C_NAME),
    prescriber: str(m.ORD_CREATR_USER_ID_NAME),
    pharmacy: str(m.PHARMACY_ID_PHARMACY_NAME),
    associatedDiagnoses: (m.associatedDiagnoses ?? []).map((d: any) => d.DX_NAME ?? String(d.DX_ID)),
    _epic: epic(m),
  };
}
```

## Actual Output (from health_record_full.json)

```json
[
  {
    "id": "772179266",
    "name": "nortriptyline (PAMELOR) 10 MG capsule",
    "genericName": "NORTRIPTYLINE HCL 10 MG PO CAPS",
    "dose": "10 mg",
    "route": "Oral",
    "frequency": "NIGHTLY",
    "startDate": "2022-12-01",
    "endDate": "2023-02-20",
    "status": "Sent",
    "prescriber": "RAMMELKAMP, ZOE L",
    "pharmacy": "WALGREENS DRUG STORE #06130 - MADISON, WI - 3700 UNIVERSITY AVE AT NEC OF MIDVALE & UNIVERSITY",
    "_epic": {
      "ORDER_MED_ID": 772179266,
      "PAT_ID": "Z7004242",
      "PAT_ENC_DATE_REAL": 66444,
      "PAT_ENC_CSN_ID": 974614965,
      "ORDERING_DATE": "12/1/2022 12:00:00 AM",
      "ORDER_CLASS_C_NAME": "Normal",
      "PHARMACY_ID": 64308,
      "PHARMACY_ID_PHARMACY_NAME": "WALGREENS DRUG STORE #06130 - MADISON, WI - 3700 UNIVERSITY AVE AT NEC OF MIDVALE & UNIVERSITY",
      "ORD_CREATR_USER_ID": "RAMMELZL",
      "ORD_CREATR_USER_ID_NAME": "RAMMELKAMP, ZOE L",
      "MEDICATION_ID": 5674,
      "DESCRIPTION": "NORTRIPTYLINE HCL 10 MG PO CAPS",
      "QUANTITY": "90 capsule",
      "REFILLS": "1",
      "START_DATE": "12/1/2022 12:00:00 AM",
      "END_DATE": "2/20/2023 12:00:00 AM",
      "MED_PRESC_PROV_ID": "144590",
      "UPDATE_DATE": "4/4/2023 4:11:00 PM",
      "ORDER_INST": "12/1/2022 10:15:00 AM",
      "DISPLAY_NAME": "nortriptyline (PAMELOR) capsule",
      "HV_HOSPITALIST_YN": "N",
      "ORDER_PRIORITY_C_NAME": "Routine",
      "MED_ROUTE_C_NAME": "Oral",
      "DISCON_USER_ID": "RAMMELZL",
      "DISCON_USER_ID_NAME": "RAMMELKAMP, ZOE L",
      "DISCON_TIME": "2/20/2023 7:27:00 PM",
      "HV_DISCR_FREQ_ID": "200058",
      "HV_DISCR_FREQ_ID_FREQ_NAME": "NIGHTLY",
      "HV_DISCRETE_DOSE": "10",
      "HV_DOSE_UNIT_C_NAME": "mg",
      "ORDER_START_TIME": "12/1/2022 12:00:00 AM",
      "ORDER_END_TIME": "2/20/2023 12:00:00 AM",
      "ORDER_STATUS_C_NAME": "Sent",
      "AUTHRZING_PROV_ID": "144590",
      "ORD_PROV_ID": "144590",
      "MIN_DISCRETE_DOSE": 10,
      "DOSE_UNIT_C_NAME": "mg",
      "PROVIDER_TYPE_C_NAME": "Authorizing",
      "ACT_ORDER_C_NAME": "Active Medication",
      "USER_SEL_MED_ID": 5674,
      "USER_SEL_ERX_DAT": "9/6/2016 12:00:00 AM",
      "MDL_ID": 73847702,
      "AMB_MED_DISP_NAME": "nortriptyline (PAMELOR) 10 MG capsule",
      "WEIGHT_BASED_YN": "N",
      "REFILLS_REMAINING": 1,
      "ORDERING_MODE_C_NAME": "Outpatient",
      "EXT_ELG_SOURCE_ID": "P00000000001001",
      "EXT_ELG_MEMBER_ID": "FA1000010XMWEJQ%602496879%001",
      "EXT_FORMULARY_ID": "00935",
      "EXT_COVERAGE_ID": "003171310000000000000000",
      "EXT_PHARMACY_TYPE_C_NAME": "Retail+Mail",
      "EXT_FORMULARY_STAT": "4",
      "EXT_COV_AGE_LMT_YN": "N",
      "EXT_COV_EXCLUS_YN": "N",
      "EXT_COV_SEX_LMT_YN": "N",
      "EXT_COV_MED_NCST_YN": "N",
      "EXT_COV_PRI_AUTH_YN": "N",
      "EXT_COV_QNTY_LMT_YN": "N",
      "EXT_COV_LNK_DRUG_YN": "N",
      "EXT_COV_LNK_SMRY_YN": "N",
      "EXT_COV_STEP_MED_YN": "N",
      "EXT_COV_STEP_THR_YN": "N",
      "USR_SEL_IMS_YN":
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