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

Analyze the mapping pipeline for **Billing: ARPB_TRANSACTIONS → BillingTransaction → HealthRecord.billing** and identify every semantic error — places where a column is read successfully but the value means something different than the code assumes.

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

### ARPB_TRANSACTIONS
**Table**: This table contains information about professional billing transactions.
- **TX_ID**: A transaction's unique internal identification number. A patient's record can include charges, payments, or adjustments and the patient's account balance will reflect these transactions.
- **POST_DATE**: The date when a transaction is entered into the billing system.  This differs from the service date, which is the date when the service was performed.
- **SERVICE_DATE**: The date a medical service is performed.
- **TX_TYPE_C_NAME**: The type of this transaction: Charge, payment or adjustment.
- **ACCOUNT_ID**: The internal ID of the record that maintains the patient's transactions. A patient may use more than one account and an account may contain more than one patient.
- **DEBIT_CREDIT_FLAG_NAME**: This column contains a 1 if the transaction is a debit and a -1 if the transaction is a credit. A charge is always a debit, a payment is always a credit, and an adjustment can be either a debit or a credit.
- **SERV_PROVIDER_ID**: The internal identifier of the provider who performed the medical services on the patient.
- **BILLING_PROV_ID**: The billing provider associated with the transaction.
- **DEPARTMENT_ID**: The department ID of the department associated with the transaction.
- **POS_ID**: The place of service ID of the place of service associated with the transaction
- **LOC_ID**: The location ID of the location associated with the transaction.
- **SERVICE_AREA_ID**: The service area ID of the service area associated with the transaction.
- **MODIFIER_ONE**: The first procedure modifier associated with this transaction. This is the external modifier, as it would be printed on the claim.
- **MODIFIER_TWO**: The second procedure modifier associated with this transaction. This is the external modifier, as it would be printed on the claim.
- **MODIFIER_THREE**: The third procedure modifier associated with this transaction. This is the external modifier, as it would be printed on the claim.
- **MODIFIER_FOUR**: The fourth procedure modifier associated with this transaction. This is the external modifier, as it would be printed on the claim.
- **PRIMARY_DX_ID**: The primary diagnosis ID associated with the transaction.
- **DX_TWO_ID**: The second diagnosis ID associated with the transaction.
- **DX_THREE_ID**: The third diagnosis ID associated with the transaction.
- **DX_FOUR_ID**: The fourth diagnosis ID associated with the transaction.
- **DX_FIVE_ID**: The fifth diagnosis ID associated with the transaction.
- **DX_SIX_ID**: The sixth diagnosis ID associated with the transaction.
- **PROCEDURE_QUANTITY**: The quantity as entered in Charge Entry for the procedure of this transaction (TX_ID). If the row has a DETAIL_TYPE value of 10-13, this column displays a negative value. If the row has a DETAIL_TYPE value of 20-33, 43-45, 50, or 51, this column displays a zero.
- **AMOUNT**: The original amount of this transaction.
- **OUTSTANDING_AMT**: The outstanding amount of the transaction.
- **INSURANCE_AMT**: The insurance portion of the transaction.
- **PATIENT_AMT**: The patient or self-pay portion of the transaction.
- **VOID_DATE**: If this transaction is voided, this column will have the date in which this transaction is voided.
- **LAST_ACTION_DATE**: This column contains the most recent date when an action is performed on this transaction.
- **PROV_SPECIALTY_C_NAME**: This column contains the provider specialty of the provider associated with the transaction. The procedure category of the charge on the transaction may affect what specialty is recorded here and in the "Encounter Specialty" displayed in Hyperspace.
- **PROC_ID**: The Procedure ID of the procedure associated with the transaction.
- **TOTAL_MATCH_AMT**: This column contains the total amount matched to the transaction, including adjustments.
- **TOTAL_MTCH_INS_AMT**: This column contains the total insurance amount matched to the transaction, including adjustments.
- **TOTAL_MTCH_ADJ**: This column contains the total adjustment amount matched to the transaction.
- **TOTAL_MTCH_INS_ADJ**: This column contains the total insurance adjustment amount matched to the transaction.
- **REPOST_ETR_ID**: This is the repost source transaction.
- **REPOST_TYPE_C_NAME**: The repost type category ID for the transaction.
- **DISCOUNT_TYPE_C_NAME**: The discount type category ID for the transaction.
- **PAT_ENC_CSN_ID**: The Contact Serial Number for the patient encounter with which this transaction is associated. This number is unique across all patients and encounters in your system.
- **ENC_FORM_NUM**: The encounter form number corresponding to the charge transaction. If you are not using encounter forms, a negative number is stored in this item.
- **BEN_SELF_PAY_AMT**: Stores the adjudicated self-pay amount calculated by the benefits engine
- **BEN_ADJ_COPAY_AMT**: Stores the copay part of the adjudicated self-pay amount calculated by the benefits engine
- **BEN_ADJ_COINS_AMT**: Stores the coinsurance part of the adjudicated self-pay amount calculated by the benefits engine
- **VISIT_NUMBER**: This item stores the visit number for this transaction.
- **REFERRAL_ID**: This item stores the Referral (RFL) ID for this transaction.
- **ORIGINAL_EPM_ID**: This item stores the original payor (EPM) ID for this transaction.
- **ORIGINAL_FC_C_NAME**: This item stores the original financial class for this transaction.
- **ORIGINAL_CVG_ID**: This item stores the original coverage (CVG) ID for this transaction.
- **PAYOR_ID**: This item stores the current payor (EPM) ID for this transaction.
- **COVERAGE_ID**: This item stores the current coverage (CVG) ID for this transaction.
- **ASGN_YN**: This item stores the assignment flag for a coverage.  This item is set to Yes if the charge is currently assigned to the payor in the PAYOR_ID column.
- **FACILITY_ID**: This item stores the facility (EAF) ID for this transaction.
- **PAYMENT_SOURCE_C_NAME**: This item stores the payment source for credit transactions. This is a list of possible sources including Cash, Check, Credit Card, etc.
- **USER_ID**: This item stores the user who posted the transaction.
- **USER_ID_NAME**: The name of the user record. This name may be hidden.
- **NOT_BILL_INS_YN**: Indicates whether the transaction is marked for do not bill insurance.
- **CHG_ROUTER_SRC_ID**: This item stores the universal charge line (UCL) ID for this transaction.
- **RECEIVE_DATE**: This item stores the charge entry batch receive date.
- **CE_CODED_DATE**: The date this�charge session was coded, from charge entry.
- **PANEL_ID**: The ID of the panel procedure that generated this transaction.
- **BILL_AREA_ID**: Networked to BIL: the Bill Area for this transaction.
- **BILL_AREA_ID_BILL_AREA_NAME**: The record name of this bill area, financial subdivision, or financial division.
- **CREDIT_SRC_MODULE_C_NAME**: The module that creates a payment or credit adjustment
- **UPDATE_DATE**: The date that this row was last updated.
- **CLAIM_DATE**: The most recent date that this transaction has been on an accepted claim run.
- **IPP_INV_NUMBER**: This item stores the original invoice number that user posts to in GUI payment posting or remittance.
- **IPP_INV_ID**: This item stores the original invoice ID that user posts to in�graphical user interface�(GUI) payment posting or remittance.

### ARPB_VISITS
**Table**: This table contains Professional Billing visit information stored in the Hospital Accounts Receivable (HAR) master file. It doesn�t include HAR records created for Hospital Billing and Single Billing Office.
- **PB_VISIT_ID**: The unique identifier for the Professional Billing visit.
- **PB_BILLING_STATUS_C_NAME**: This column stores the Professional Billing status category ID for the visit.
- **PB_FO_OVRRD_ST_C_NAME**: This column indicates whether the Professional Billing filing order has been overridden by a user.
- **PB_FO_MSPQ_STATE_C_NAME**: This column indicates whether the filing order for the Professional Billing visit has been verified by Medicare Secondary Payer Questionnaire logic.
- **PB_VISIT_NUM**: This column stores the PB visit number.
- **PRIM_ENC_CSN_ID**: The contact serial number associated with the primary patient contact on the Professional Billing visit.
- **GUARANTOR_ID**: Stores the guarantor ID associated with the Professional Billing visit.
- **COVERAGE_ID**: The primary coverage on the Professional Billing visit.
- **SELF_PAY_YN**: Indicates whether the Professional Billing visit is self-pay.
- **DO_NOT_BILL_INS_YN**: Indicates�whether the Professional Billing visit has the Do Not Bill Insurance flag set.
- **ACCT_FIN_CLASS_C_NAME**: The financial class category ID�for the Professional Billing visit.
- **SERV_AREA_ID**: The service area of the Professional Billing visit.
- **REVENUE_LOCATION_ID**: The revenue location of the Professional Billing visit.
- **DEPARTMENT_ID**: The department of the Professional Billing visit.
- **PB_TOTAL_BALANCE**: Contains the combined total balance of transactions on the PB visit.
- **PB_TOTAL_CHARGES**: The total charges on the PB visit.
- **PB_TOTAL_PAYMENTS**: The total payments on the PB visit.
- **PB_TOTAL_ADJ**: Contains total adjustments on the PB visit.
- **PB_INS_BALANCE**: Contains insurance balance on the PB visit.
- **PB_UND_BALANCE**: Contains undistributed balances on the PB visit.
- **PB_SELFPAY_BALANCE**: Contains the self-pay balance on the Professional Billing visit.
- **PB_BAD_DEBT_BALANCE**: Contains the bad debt balance on the Professional Billing visit.
- **REC_CREATE_USER_ID**: The user who created the Professional Billing visit record.
- **REC_CREATE_USER_ID_NAME**: The name of the user record. This name may be hidden.
- **FIRST_PB_CHG_TX_ID**: Contains the first valid Professional Billing charge on the Professional Billing visit.
- **BAL_FULL_SELF_PAY_YN**: This item shows whether the balances for this hospital account are in full self-pay.

### ARPB_TX_ACTIONS
**Table**: This table contains information about actions performed on professional billing transactions.
- **TX_ID**: The unique key or identification number for a given transaction.
- **LINE**: This column contains the line count for the information in this table. Each action associated with this transaction is stored on a separate line, one line for each entry.
- **ACTION_TYPE_C_NAME**: The action type category ID taken on the transaction.
- **ACTION_DATE**: The date in which this action is performed.
- **ACTION_AMOUNT**: The amount associated with this action.
- **PAYOR_ID**: The Payor associated with this action.
- **DENIAL_CODE**: The denial code associated with this action.
- **DENIAL_CODE_REMIT_CODE_NAME**: The name of each remittance code.
- **POST_DATE**: The date this transaction was posted in calendar format.
- **STMT_DATE**: The statement date of this transaction.
- **OUT_AMOUNT_BEFORE**: Outstanding amount of associated transaction before the action is performed.
- **OUT_AMOUNT_AFTER**: Outstanding amount of the associated transaction after the action is performed.
- **INS_AMOUNT_BEFORE**: Insurance amount of the associated transaction before the action is performed.
- **INS_AMOUNT_AFTER**: Insurance amount of the associated transaction after the action is performed.
- **BEFORE_PAYOR_ID**: The Payor of the associated transaction before the action is performed.
- **AFTER_PAYOR_ID**: The Payor of the associated transaction after the action is performed.
- **BEFORE_CVG_ID**: The coverage of the associated transaction before the action is performed.
- **AFTER_CVG_ID**: The coverage of the associated transaction after the action is performed.
- **ACTION_USER_ID**: The unique ID of the user who performed this action.
- **ACTION_USER_ID_NAME**: The name of the user record. This name may be hidden.
- **ADJ_CODE_ID**: If an adjustment is associated with this action, this column contains the adjustment code of that adjustment.
- **RMC_ID**: The first reason code ID associated with this action.
- **RMC_ID_REMIT_CODE_NAME**: The name of each remittance code.
- **RMC_TWO_ID**: The second reason code�ID associated with this action.
- **RMC_TWO_ID_REMIT_CODE_NAME**: The name of each remittance code.
- **RMC_THREE_ID**: The third reason code ID associated with this action.
- **RMC_THREE_ID_REMIT_CODE_NAME**: The name of each remittance code.
- **RMC_FOUR_ID**: The fourth reason code ID associated with this action.
- **RMC_FOUR_ID_REMIT_CODE_NAME**: The name of each remittance code.
- **PMT_PAYOR_ID**: The Payor of the payment if this action is associated with a payment.
- **POS_ID**: Place of Service ID of the transaction.
- **DEPARTMENT_ID**: Department ID of this transaction.
- **PROC_ID**: The procedure ID for the transaction record.
- **LOCATION_ID**: Location Id for this transaction
- **SERVICE_AREA_ID**: Service Area ID for this transaction
- **ACCOUNT_ID**: The internal ID of the record that maintains the patient's transactions. A patient may use more than one account and an account may contain more than one patient.
- **PRIMARY_DX_ID**: Primary Diagnosis code for this charge.
- **MODIFIER_ONE**: The first procedure modifier of the associated transaction. This is the external modifier, as it would be printed on the claim.
- **MODIFIER_TWO**: The second procedure modifier of the associated transaction. This is the external modifier, as it would be printed on the claim.
- **MODIFIER_THREE**: The third modifier of the associated transaction. This is the external modifier, as it would be printed on the claim.
- **MODIFIER_FOUR**: The fourth modifier of the associated transaction. This is the external modifier, as it would be printed on the claim.
- **ASSIGNMENT_BEF_YN**: This item is a Yes/No flag to determine if the transaction was assigned to insurance before the action on this line for this transaction.
- **ASSIGNMENT_AFTER_YN**: This item is a Yes/No flag to determine if the transaction was assigned to insurance after the action on this line for this transaction.
- **ACTION_REMIT_CODES**: This field stores a comma delimited list of external remittance codes for this transaction.
- **ACTION_COMMENT**: This is the system generated comment for this transaction.
- **ACTION_DATETIME**: The UTC date and time the action was performed.

### CLARITY_EPM
**Table**: The CLARITY_EPM table contains information about payer records.
- **PAYOR_ID**: The unique ID assigned to the payor.
- **PAYOR_NAME**: The name of the payor.

## Sample Data (one representative non-null value per column)

### ARPB_TRANSACTIONS
- TX_ID = `129124216`
- POST_DATE = `10/12/2023 12:00:00 AM`
- SERVICE_DATE = `9/28/2023 12:00:00 AM`
- TX_TYPE_C_NAME = `Charge`
- ACCOUNT_ID = `1810018166`
- DEBIT_CREDIT_FLAG_NAME = `Debit`
- SERV_PROVIDER_ID = `144590`
- BILLING_PROV_ID = `144590`
- DEPARTMENT_ID = `1700801002`
- POS_ID = `1700801`
- LOC_ID = `1700801`
- SERVICE_AREA_ID = `18`
- MODIFIER_ONE = `25`
- PRIMARY_DX_ID = `514181`
- DX_TWO_ID = `462313`
- DX_THREE_ID = `463037`
- DX_FOUR_ID = `509172`
- PROCEDURE_QUANTITY = `1`
- AMOUNT = `330`
- OUTSTANDING_AMT = `0`
- INSURANCE_AMT = `0`
- PATIENT_AMT = `0`
- VOID_DATE = `12/20/2022 12:00:00 AM`
- LAST_ACTION_DATE = `10/23/2023 12:00:00 AM`
- PROV_SPECIALTY_C_NAME = `Internal Medicine`
- PROC_ID = `23870`
- TOTAL_MATCH_AMT = `-330`
- TOTAL_MTCH_INS_AMT = `-330`
- TOTAL_MTCH_ADJ = `-106.58`
- TOTAL_MTCH_INS_ADJ = `-106.58`
- REPOST_ETR_ID = `315026147`
- REPOST_TYPE_C_NAME = `Correction`
- ENC_FORM_NUM = `76294046`
- BEN_SELF_PAY_AMT = `0`
- BEN_ADJ_COPAY_AMT = `0`
- VISIT_NUMBER = `10`
- ORIGINAL_EPM_ID = `1302`
- ORIGINAL_FC_C_NAME = `Blue Cross`
- ORIGINAL_CVG_ID = `5934765`
- PAYOR_ID = `1302`
- COVERAGE_ID = `5934765`
- ASGN_YN = `Y`
- FACILITY_ID = `1`
- PAYMENT_SOURCE_C_NAME = `Electronic Funds Transfer`
- USER_ID = `RAMMELZL`
- USER_ID_NAME = `RAMMELKAMP, ZOE L`
- NOT_BILL_INS_YN = `N`
- CHG_ROUTER_SRC_ID = `774135624`
- BILL_AREA_ID = `9`
- BILL_AREA_ID_BILL_AREA_NAME = `Associated Physicians Madison Wisconsin`
- CREDIT_SRC_MODULE_C_NAME = `Electronic Remittance`
- UPDATE_DATE = `10/23/2023 3:06:00 PM`
- CLAIM_DATE = `10/13/2023 12:00:00 AM`
- IPP_INV_NUMBER = `L1007201490`
- IPP_INV_ID = `58319567`

### ARPB_VISITS
- PB_VISIT_ID = `4307315`
- PB_BILLING_STATUS_C_NAME = `Closed`
- PB_FO_OVRRD_ST_C_NAME = `Matches the default`
- PB_FO_MSPQ_STATE_C_NAME = `MSPQ does not apply`
- PB_VISIT_NUM = `7`
- PRIM_ENC_CSN_ID = `958147754`
- GUARANTOR_ID = `1810018166`
- COVERAGE_ID = `5934765`
- SELF_PAY_YN = `N`
- DO_NOT_BILL_INS_YN = `N`
- ACCT_FIN_CLASS_C_NAME = `Blue Cross`
- SERV_AREA_ID = `18`
- REVENUE_LOCATION_ID = `1700801`
- DEPARTMENT_ID = `1700801005`
- PB_TOTAL_BALANCE = `0`
- PB_TOTAL_CHARGES = `173`
- PB_TOTAL_PAYMENTS = `-8.4`
- PB_TOTAL_ADJ = `-164.6`
- PB_INS_BALANCE = `0`
- PB_SELFPAY_BALANCE = `0`
- REC_CREATE_USER_ID = `PAM400`
- REC_CREATE_USER_ID_NAME = `MANIX, PATRICIA A`
- FIRST_PB_CHG_TX_ID = `302968774`
- BAL_FULL_SELF_PAY_YN = `N`

### ARPB_TX_ACTIONS
- TX_ID = `129124216`
- LINE = `1`
- ACTION_TYPE_C_NAME = `Recalculate Discount`
- ACTION_DATE = `10/4/2022 12:00:00 AM`
- ACTION_AMOUNT = `0`
- PAYOR_ID = `1302`
- DENIAL_CODE = `2`
- DENIAL_CODE_REMIT_CODE_NAME = `2-COINSURANCE AMOUNT`
- POST_DATE = `10/4/2022 12:00:00 AM`
- STMT_DATE = `1/29/2020 12:00:00 AM`
- OUT_AMOUNT_BEFORE = `0`
- OUT_AMOUNT_AFTER = `6.99`
- INS_AMOUNT_BEFORE = `0`
- INS_AMOUNT_AFTER = `0`
- BEFORE_PAYOR_ID = `0`
- AFTER_PAYOR_ID = `0`
- BEFORE_CVG_ID = `5934765`
- AFTER_CVG_ID = `5934765`
- ACTION_USER_ID = `1`
- ACTION_USER_ID_NAME = `EPIC, USER`
- ADJ_CODE_ID = `10226`
- RMC_ID = `6063`
- RMC_ID_REMIT_CODE_NAME = `MA63 INCMPL/INV PRINCIPAL DX.`
- PMT_PAYOR_ID = `1302`
- POS_ID = `1700801`
- DEPARTMENT_ID = `1700801002`
- PROC_ID = `23660`
- LOCATION_ID = `1700801`
- SERVICE_AREA_ID = `18`
- ACCOUNT_ID = `1810018166`
- PRIMARY_DX_ID = `462313`
- MODIFIER_ONE = `25`
- ASSIGNMENT_BEF_YN = `Y`
- ASSIGNMENT_AFTER_YN = `N`
- ACTION_REMIT_CODES = `2`
- ACTION_DATETIME = `10/4/2022 3:37:00 PM`

### CLARITY_EPM
- PAYOR_ID = `1302`
- PAYOR_NAME = `BLUE CROSS OF WISCONSIN`

## Pipeline Code

### Stage 1: SQL Projection (project.ts → raw JSON)
```typescript
function projectBilling(patId: unknown): EpicRow {
  // Billing tables link to patient via various chains:
  // ARPB_TRANSACTIONS → ACCOUNT_ID → ACCT_GUAR_PAT_INFO.PAT_ID
  // ARPB_VISITS → PRIM_ENC_CSN_ID → PAT_ENC.PAT_ID
  // HSP_ACCOUNT → encounters
  // ACCOUNT → ACCT_GUAR_PAT_INFO.PAT_ID

  // Get patient's account IDs via bridge table
  const patAccountIds = tableExists("ACCT_GUAR_PAT_INFO")
    ? q(`SELECT ACCOUNT_ID FROM ACCT_GUAR_PAT_INFO WHERE PAT_ID = ?`, [patId]).map(r => r.ACCOUNT_ID)
    : [];

  // Get patient's encounter CSNs
  const patCSNs = q(`SELECT PAT_ENC_CSN_ID FROM PAT_ENC WHERE PAT_ID = ?`, [patId]).map(r => r.PAT_ENC_CSN_ID);

  // Transactions — via account chain
  let txRows: EpicRow[];
  if (patAccountIds.length > 0 && tableExists("ARPB_TRANSACTIONS")) {
    const placeholders = patAccountIds.map(() => "?").join(",");
    txRows = mergeQuery("ARPB_TRANSACTIONS", `b."ACCOUNT_ID" IN (${placeholders})`, patAccountIds);
  } else {
    txRows = mergeQuery("ARPB_TRANSACTIONS");
  }
  for (const tx of txRows) {
    attachChildren(tx, tx.TX_ID, txChildren);
    tx._procedure_name = lookupName("CLARITY_EAP", "PROC_ID", "PROC_NAME", tx.PROCEDURE_ID);
  }

  // Visits — via encounter CSN chain
  let visits: EpicRow[];
  if (patCSNs.length > 0 && tableExists("ARPB_VISITS")) {
    const csnPlaceholders = patCSNs.map(() => "?").join(",");
    visits = q(`SELECT * FROM ARPB_VISITS WHERE PRIM_ENC_CSN_ID IN (${csnPlaceholders})`, patCSNs);
  } else {
    visits = tableExists("ARPB_VISITS") ? q(`SELECT * FROM ARPB_VISITS`) : [];
  }

  // Hospital accounts — via HAR_ALL bridge (ACCT_ID → HSP_ACCOUNT_ID, PAT_ID for filter)
  let hars: EpicRow[];
  if (tableExists("HAR_ALL") && tableExists("HSP_ACCOUNT")) {
    const harAcctIds = q(`SELECT ACCT_ID FROM HAR_ALL WHERE PAT_ID = ?`, [patId]).map(r => r.ACCT_ID);
    if (harAcctIds.length > 0) {
      const placeholders = harAcctIds.map(() => "?").join(",");
      hars = mergeQuery("HSP_ACCOUNT", `b."HSP_ACCOUNT_ID" IN (${placeholders})`, harAcctIds);
    } else {
      hars = [];
    }
  } else {
    hars = mergeQuery("HSP_ACCOUNT");
  }
  for (const har of hars) {
    attachChildren(har, har.HSP_ACCOUNT_ID, harChildren);
    // Claim prints have their own children keyed on CLAIM_PRINT_ID
    for (const clp of (har.claim_prints as EpicRow[] ?? [])) {
      const clpId = clp.CLAIM_PRINT_ID;
      if (tableExists("HSP_CLP_REV_CODE")) clp.rev_codes = children("HSP_CLP_REV_CODE", "CLAIM_PRINT_ID", clpId);
      if (tableExists("HSP_CLP_CMS_LINE")) clp.cms_lines = children("HSP_CLP_CMS_LINE", "CLAIM_PRINT_ID", clpId);
      if (tableExists("HSP_CLP_DIAGNOSIS")) clp.diagnoses = children("HSP_CLP_DIAGNOSIS", "CLAIM_PRINT_ID", clpId);
      if (tableExists("HSP_CLAIM_DETAIL1")) clp.detail_1 = children("HSP_CLAIM_DETAIL1", "CLAIM_PRINT_ID", clpId);
      if (tableExists("HSP_CLAIM_DETAIL2")) clp.detail_2 = children("HSP_CLAIM_DETAIL2", "CLAIM_PRINT_ID", clpId);
      if (tableExists("HSP_CLP_CMS_TX_PIECES")) clp.cms_tx_pieces = children("HSP_CLP_CMS_TX_PIECES", "CLAIM_PRINT_ID", clpId);
      if (tableExists("HSP_CLP_UB_TX_PIECES")) clp.ub_tx_pieces = children("HSP_CLP_UB_TX_PIECES", "CLAIM_PRINT_ID", clpId);
      if (tableExists("CLP_NON_GRP_TX_IDS")) clp.non_group_tx = children("CLP_NON_GRP_TX_IDS", "CLAIM_PRINT_ID", clpId);
      if (tableExists("CLP_OCCUR_DATA")) clp.occurrence_data = children("CLP_OCCUR_DATA", "CLAIM_PRINT_ID", clpId);
    }
  }

  // Guarantor accounts — via ACCT_GUAR_PAT_INFO bridge
  let accts: EpicRow[];
  if (patAccountIds.length > 0) {
    const placeholders = patAccountIds.map(() => "?").join(",");
    accts = mergeQuery("ACCOUNT", `b."ACCOUNT_ID" IN (${placeholders})`, patAccountIds);
  } else {
    accts = mergeQuery("ACCOUNT");
  }
  for (const acct of accts) {
    attachChildren(acct, acct.ACCOUNT_ID, acctChildren);
  }

  // Remittances
  const remits = q(`SELECT * FROM CL_REMIT`).concat(
    tableExists("CL_REMIT") ? [] : []
  );
  for (const r of remits) {
    attachChildren(r, r.IMAGE_ID, remitChildren);
  }

  // Claims
  const claims = mergeQuery("CLM_VALUES");
  for (const c of claims) {
    attachChildren(c, c.RECORD_ID, claimChildren);
  }

  // Invoices
  const invoices = tableExists("INVOICE")
    ? q(`SELECT * FROM INVOICE WHERE PAT_ID = ?`, [patId])
    : [];
  for (const inv of invoices) {
    if (tableExists("INV_BASIC_INFO")) inv.basic_info = children("INV_BASIC_INFO", "INV_ID", inv.INVOICE_ID);
    if (tableExists("INV_TX_PIECES")) inv.tx_pieces = children("INV_TX_PIECES", "INV_ID", inv.INVOICE_ID);
    if (tableExists("INV_NUM_TX_PIECES")) inv.num_tx_pieces = children("INV_NUM_TX_PIECES", "INV_ID", inv.INVOICE_ID);
    if (tableExists("INV_CLM_LN_ADDL")) inv.claim_line_addl = children("INV_CLM_LN_ADDL", "INVOICE_ID", inv.INVOICE_ID);
    if (tableExists("INV_DX_INFO")) inv.diagnoses = children("INV_DX_INFO", "INVOICE_ID", inv.INVOICE_ID);
    if (tableExists("INV_PMT_RECOUP")) inv.payment_recoup = children("INV_PMT_RECOUP", "INVOICE_ID", inv.INVOICE_ID);
  }

  return {
    transactions: txRows,
    visits,
    hospital_accounts: hars,
    guarantor_accounts: accts,
    remittances: remits,
    claims,
    invoices,
  };
}
```

### Stage 2: Domain Model Hydration (PatientRecord.ts)
```typescript
export class BillingTransaction {
  TX_ID: EpicID;
  txType?: string;
  amount?: number;
  postDate?: string;
  serviceDate?: string;
  ACCOUNT_ID?: EpicID;
  VISIT_NUMBER?: EpicID;
  actions: EpicRow[] = [];
  chargeDiagnoses: EpicRow[] = [];
  eobInfo: EpicRow[] = [];

  constructor(raw: EpicRow) {
    Object.assign(this, raw);
    this.TX_ID = raw.TX_ID as EpicID;
    this.txType = raw.TX_TYPE_C_NAME as string;
    this.amount = raw.AMOUNT as number;
    this.postDate = raw.POST_DATE as string;
    this.serviceDate = raw.SERVICE_DATE as string;
    this.ACCOUNT_ID = raw.ACCOUNT_ID as EpicID;
    this.VISIT_NUMBER = raw.VISIT_NUMBER as EpicID;
    for (const key of ['arpb_tx_actions', 'arpb_chg_entry_dx', 'tx_diag',
      'pmt_eob_info_i', 'pmt_eob_info_ii']) {
      const arr = raw[key] as EpicRow[] | undefined;
      if (arr?.length) {
        if (key.includes('action')) this.actions = arr;
        else if (key.includes('dx') || key.includes('diag')) this.chargeDiagnoses.push(...arr);
        else if (key.includes('eob')) this.eobInfo.push(...arr);
      }
    }
  }
}

export class BillingVisit {
  PRIM_ENC_CSN_ID?: CSN;
  totalCharges?: number;
  totalPayments?: number;
  totalAdjustments?: number;
  balance?: number;

  constructor(raw: EpicRow) {
    Object.assign(this, raw);
    this.PRIM_ENC_CSN_ID = raw.PRIM_ENC_CSN_ID as CSN;
    this.totalCharges = raw.PB_TOTAL_CHARGES as number;
    this.totalPayments = raw.PB_TOTAL_PAYMENTS as number;
    this.totalAdjustments = raw.PB_TOTAL_ADJUSTMENTS as number;
    this.balance = raw.PB_BALANCE as number;
  }

  encounter(record: PatientRecordRef): Encounter | undefined {
    return this.PRIM_ENC_CSN_ID ? record.encounterByCSN(this.PRIM_ENC_CSN_ID) : undefined;
  }

  transactions(record: PatientRecordRef): BillingTransaction[] {
    return record.billing.transactions.filter(
      tx => tx.VISIT_NUMBER === (this as EpicRow).PB_VISIT_ID
    );
  }
}
```

### Stage 3: Clean Projection (HealthRecord.ts → final output)
```typescript
    billing: projectBilling(r),
  };
}

function projectDemographics(r: R): Demographics {
  const p = r.patient;
  return {
    name: p.PAT_NAME?.replace(',', ', ') ?? '',
    firstName: p.PAT_FIRST_NAME ?? '', lastName: p.PAT_LAST_NAME ?? '',
    dateOfBirth: toISODate(p.BIRTH_DATE), sex: str(p.SEX_C_NAME),
    race: [], ethnicity: str(p.ETHNIC_GROUP_C_NAME),
    language: str(p.LANGUAGE_C_NAME), maritalStatus: str(p.MARITAL_STATUS_C_NAME),
    address: (p.CITY || p.STATE_C_NAME || p.ZIP) ? {
      street: str(p.ADD_LINE_1), city: str(p.CITY),
      state: str(p.STATE_C_NAME), zip: str(p.ZIP), country: str(p.COUNTRY_C_NAME),
    } : null,
```

## Actual Output (from health_record_full.json)

```json
{
  "charges": [
    {
      "id": "355871699",
      "date": "2023-09-28",
      "service": "23870",
      "amount": 330,
      "visitId": "10",
      "_epic": {
        "TX_ID": 355871699,
        "txType": "Charge",
        "amount": 330,
        "postDate": "10/12/2023 12:00:00 AM",
        "serviceDate": "9/28/2023 12:00:00 AM",
        "ACCOUNT_ID": 1810018166,
        "VISIT_NUMBER": "10",
        "POST_DATE": "10/12/2023 12:00:00 AM",
        "SERVICE_DATE": "9/28/2023 12:00:00 AM",
        "TX_TYPE_C_NAME": "Charge",
        "DEBIT_CREDIT_FLAG_NAME": "Debit",
        "SERV_PROVIDER_ID": "144590",
        "BILLING_PROV_ID": "144590",
        "DEPARTMENT_ID": 1700801002,
        "POS_ID": 1700801,
        "LOC_ID": 1700801,
        "SERVICE_AREA_ID": 18,
        "MODIFIER_ONE": "25",
        "PRIMARY_DX_ID": 514181,
        "DX_TWO_ID": 462313,
        "PROCEDURE_QUANTITY": 1,
        "AMOUNT": 330,
        "OUTSTANDING_AMT": 0,
        "INSURANCE_AMT": 0,
        "PATIENT_AMT": 0,
        "LAST_ACTION_DATE": "10/23/2023 12:00:00 AM",
        "PROV_SPECIALTY_C_NAME": "Internal Medicine",
        "PROC_ID": 23870,
        "TOTAL_MATCH_AMT": -330,
        "TOTAL_MTCH_INS_AMT": -330,
        "TOTAL_MTCH_ADJ": -106.58,
        "TOTAL_MTCH_INS_ADJ": -106.58,
        "ENC_FORM_NUM": "76294046",
        "BEN_SELF_PAY_AMT": 0,
        "BEN_ADJ_COPAY_AMT": 0,
        "ORIGINAL_EPM_ID": 1302,
        "ORIGINAL_FC_C_NAME": "Blue Cross",
        "ORIGINAL_CVG_ID": 5934765,
        "PAYOR_ID": 1302,
        "COVERAGE_ID": 5934765,
        "ASGN_YN": "Y",
        "FACILITY_ID": 1,
        "USER_ID": "RAMMELZL",
        "USER_ID_NAME": "RAMMELKAMP, ZOE L",
        "NOT_BILL_INS_YN": "N",
        "CHG_ROUTER_SRC_ID": "774135624",
        "BILL_AREA_ID": 9,
        "BILL_AREA_ID_BILL_AREA_NAME": "Associated Physicians Madison Wisconsin",
        "UPDATE_DATE": "10/23/2023 3:06:00 PM",
        "CLAIM_DATE": "10/13/2023 12:00:00 AM",
        "VST_DO_NOT_BIL_I_YN": "N",
        "OUTST_CLM_STAT_C_NAME": "Not Outstanding",
        "PROV_NETWORK_STAT_C_NAME": "In Network",
        "NETWORK_LEVEL_C_NAME": "Blue",
        "MANUAL_PRICE_OVRIDE_YN": "N",
        "FIRST_ETR_TX_ID": 355871699,
        "POSTING_DEPARTMENT_ID": 1700801002,
        "EXP_REIMB_SRC_C_NAME": "System Calculated",
        "PRIM_TIMELY_FILE_DEADLINE_DATE": "3/26/2024 12:00:00 AM"
      }
    },
    {
      "id": "302543307",
      "date": "2022-08-29",
      "service": "23660",
      "amount": 222,
      "visitId": "6",
      "_epic": {
        "TX_ID": 302543307,
        "txType": "Charge",
        "amount": 222,
        "postDate": "9/20/2022 12:00:00 AM",
        "serviceDate": "8/29/2022 12:00:00 AM",
        "ACCOUNT_ID": 1810018166,
        "VISIT_NUMBER": "6",
        "POST_DATE": "9/20/2022 12:00:00 AM",
        "SERVICE_DATE": "8/29/2022 12:00:00 AM",
        "TX_TYPE_C_NAME": "Charge",
        "DEBIT_CREDIT_FLAG_NAME": "Debit",
        "SERV_PROVIDER_ID": "144590",
        "BILLING_P
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