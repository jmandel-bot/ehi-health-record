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

Analyze the mapping pipeline for **Billing: ARPB_TRANSACTIONS + HSP_ACCOUNT + INVOICE + claims** and identify every semantic error — places where a column is read successfully but the value means something different than the code assumes.

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

### ACCOUNT
**Table**: Accounts contain information about billing for services, while coverages contain information about insurance payors, benefits, subscribers, and members. This table contains one row for each account record in your system.
- **ACCOUNT_ID**: This column stores the unique identifier for the guarantor record. This ID number may be encrypted if you have elected to use enterprise reporting�s security utility.
- **ACCOUNT_NAME**: This column stores the name for the guarantor record. The name could be hidden if you have elected to use enterprise reporting�s security utility.
- **CONTACT_PERSON**: The name of the person to contact for questions regarding the guarantor. This item could be hidden.
- **BIRTHDATE**: The guarantor's date of birth.
- **SEX**: The sex of the guarantor. This is extracted as the category abbreviation.
- **IS_ACTIVE**: This column indicates whether the guarantor was active at the time of the extract.
- **CITY**: The city in which the guarantor lives.
- **STATE_C_NAME**: The category value of the state in which the guarantor lives.
- **ZIP**: The ZIP Code area in which the guarantor lives.
- **HOME_PHONE**: The guarantor�s home phone number (may contain dashes).
- **WORK_PHONE**: The guarantor�s work phone number (may contain dashes).
- **ACCOUNT_TYPE_C_NAME**: Category value associated with the type of account, such as Personal/Family, Worker�s Comp, etc.
- **REFERRING_PROV_ID**: This column stores the unique identifier for the referral source for this guarantor.
- **REFERRING_PROV_ID_REFERRING_PROV_NAM**: The name of the referral source.
- **SERV_AREA_ID**: The ID of the service area (EAF .1) to which this account belongs.
- **FIN_CLASS_C_NAME**: The category value of the primary financial class of the guarantor (i.e. commercial, Medicare, self-pay, etc.)
- **TOTAL_BALANCE**: The total outstanding balance on the account as of the time of the extract.
- **INSURANCE_BALANCE**: The amount of the insurance balance on the guarantor as of the time of the extract.
- **PATIENT_BALANCE**: The amount of the self-pay balance on the account as of the time of the extract.
- **BILLING_CYCLE_C**: The category value associated with the billing cycle to which the guarantor belongs.
- **BILLING_STATUS_C_NAME**: The category value for the billing status used for handling statements for this guarantor, such as Age and Hold Statements, Age and Send Statements, Don�t Age and Hold Statements, and so on.
- **PMT_PLAN_AMOUNT**: The dollar amount to be paid per period if a payment plan has been established for this account.
- **PMT_PLAN_STRT_DATE**: This column stores the date when the payment plan becomes effective. This column will only be populated if the guarantor is on a payment plan.
- **PMT_PLAN_DUE_DATE**: The day of the month when the payment plan amount is due if the account is on a payment plan.
- **LAST_INS_PMT_DATE**: The date the most recent insurance payment was received for this account before the enterprise reporting extract.
- **LAST_PAT_PMT_DATE**: The date the most recent patient payment was received for this account before the enterprise reporting extract.
- **LAST_PAT_PMT_AMT**: The amount of the most recent patient payment received for this account before the enterprise reporting extract.
- **LAST_STMT_DATE**: The date the most recent patient statement was sent for the account.
- **CONTRACT_ID**: This column stores the unique identifier for the pricing contract that was set up with the guarantor.
- **CONTRACT_EXP_DATE**: The date on which the contract attached to this guarantor expires.
- **COLLECTOR_USER_ID**: This column stores the unique identifier for the system user who is the collector assigned to this guarantor. This ID may be encrypted if you have elected to use enterprise reporting�s security utility.
- **COLLECTOR_USER_ID_NAME**: The name of the user record. This name may be hidden.
- **EPIC_ACCT_ID**: This column stores the unique identifier for the guarantor record. This field will be hidden in a public view of the ACCOUNT table.
- **RESEARCH_ID**: This column stores the unique identifier for the research study or client record for this guarantor.
- **OCCUPATION**: The occupation of the guarantor.
- **UNDIST_PMT_YN**: Indicates whether the account has any undistributed payments.  Y indicates the account has some undistributed payments.  A null value indicates the account has no undistributed payments.  An N will not be populated for this column.
- **CREDIT_BALANCE_YN**: Indicates whether the guarantor has credit balance.  Y indicates the guarantor has credit balance.  A null value indicates the guarantor has no credit balance.  An N will not be populated for this column.
- **PP_AMOUNT_DUE**: The Hospital Billing Payment Plan current amount due.
- **PP_CUR_BALANCE**: The Hospital Billing Payment Plan current balance.
- **EB_LAST_ND_STMT_DT**: Last non-demand enterprise statement date.
- **EB_LAST_D_STMT_DT**: Last demand enterprise statement date.
- **HOM_CLARITY_FLG_YN**: This column indicates whether the guarantor should be extracted. If the guarantor is homed it will be extracted, otherwise not: 1-extract, 0-do not extract.
- **HB_BALANCE**: This value is the Hospital Billing balance on the guarantor.
- **HB_PREBILL_BALANCE**: This value is the Hospital Billing prebilled balance on the account.
- **HB_INSURANCE_BALAN**: This value is the Hospital Billing insurance balance on the guarantor, but excludes hospital accounts in external AR or bad debt.
- **HB_SELFPAY_BALANCE**: This value is the Hospital Billing self-pay balance on the account, but excludes hospital accounts in external AR, bad debt or that have not yet been billed to self-pay.
- **HB_BADDEBT_BALANCE**: This value is the Hospital Billing bad debt balance on the guarantor.
- **HB_UNDISTRIB_BAL**: This value is the Hospital Billing undistributed balance on the account, but excludes hospital accounts in external AR or bad debt.
- **HB_SP_AGING_DATE**: Oldest Self-pay aging date.
- **HB_INS_AGING_DATE**: This column stores the hospital billing insurance aging date.
- **HB_LAST_INS_PMT_DT**: This column stores the last hospital billing insurance payment date.
- **HB_LAST_SP_PMT_DT**: This column stores the last hospital billing self-pay payment date.
- **SBO_HSP_ACCOUNT_ID**: This column stores the unique identifier for the default hospital account of the guarantor. The item is only used in single billing office mode.
- **EB_LAST_INFO_ST_DT**: This column stores the date the last enterprise non-demand informational statement was generated. Informational statements are those with no self-pay balance for the guarantor.
- **EB_LAST_D_INFO_DT**: This column stores the date the last enterprise demand informational statement was generated. Informational statements are those with no self-pay balance for the guarantor.
- **GUAR_REHOMED_YN**: Indicates whether a new guarantor was created as a result of running the rehoming report and performing the rehome account action.  Y indicates a new guarantor was created as a result of running the rehoming report and performing the rehome account action.  An N will not be populated for this column.  This item will only be populated if the guarantor is rehomed.
- **OLD_REHOMED_ID**: Holds a pointer from the new guarantor to the old guarantor
- **EMPR_ID_CMT**: A free text comment that can be entered when the value that is considered to be "Other" is selected as the employer. This option is available only if your organization has chosen to link the account employer to the Employer (EEP) master file in the Facility Profile.
- **PAT_REC_OF_GUAR_ID**: If the guarantor is the same person as a patient, this item contains the patient ID.
- **HOUSE_NUM**: This column stores the house number for the guarantor's address.
- **NXT_STM_DATE**: Specifies the next statement date on the client account
- **CLNT_BILL_FRQNCY_C_NAME**: Specifies the statement frequency for this guarantor.  Available options are weekly, monthly, bi-weekly, or weekly and end-of-month.
- **CLNT_BILL_DAY_C_NAME**: Specifies the day of the week to generate the client bill on provided that CLNT_BILL_FRQNCY_C is set to weekly or biweekly.
- **CLNT_BILL_DT_MNTH**: Specifies the day of the month to bill the client on provided that CLNT_BILL_FRQNCY_C is set to monthly.
- **CLIENT_ACCOUNT_YN**: Indicates whether or not this is a client guarantor.
- **PMT_PLAN_DURATION**: The payment plan duration in months.
- **PMT_PLAN_TOTAL_AMT**: The payment plan total amount.
- **PMT_PLAN_ON_TIME_YN**: Whether payment plan is on time, "Y" for on time, "N" for not on time.
- **PMT_PLAN_BAL_PD_YN**: This column indicates whether the payment plan will be effective until the balance is paid off that is, the payment plan remains effective if new charges occur. This column will only be populated if there is a payment plan.
- **PMT_PLAN_LNKSTMT_YN**: Indicates whether the payment plan due day is linked to the statement day.  Y indicates the payment plan due day is linked to the statement day.  This column will only be populated if there is a payment plan.
- **RQG_RELATIONSHIP_C_NAME**: This column stores the unique identifier for the guarantor's relationship to the�requisition grouper patient record.
- **HB_BD_SELFPAY_BAL**: Self-pay balance of accounts in bad debt that have been billed to self-pay.
- **HB_BD_INSURANCE_BAL**: This column stores the total of all insurance buckets for this guarantor's hospital accounts that are in bad debt when using account-based bad debt.
- **HB_BD_UNDISTRIB_BAL**: This column stores the total of all undistributed buckets for this guarantor's hospital accounts that are in bad debt when using account-based bad debt.
- **COUNTY_C_NAME**: The category number for the county of the guarantor's billing address.
- **COUNTRY_C_NAME**: The category number for the country of the guarantor's billing address.
- **EMPY_STAT_C_NAME**: The category number for the guarantor's employment status.
- **GUAR_EMPR_CITY**: The city of the guarantor's employer.
- **GUAR_EMPR_STATE_C_NAME**: The category number for the state of the guarantor's employer.
- **GUAR_EMPR_ZIP**: The ZIP code of the guarantor's employer.
- **GUAR_EMP_CNTRY_C_NAME**: The category number for the country of the guarantor's employer.
- **INCOME_SOURCE_C_NAME**: Income source.
- **LANGUAGE_C_NAME**: The category value for the preferred language of the guarantor.
- **HB_LAST_STMT_DATE**: This column contains the date of the last statement sent to the guarantor.
- **HB_NEXT_STMT_DATE**: This column contains the date of the next statement to be sent to the guarantor.
- **HB_LAST_DEMAND_DATE**: This column contains the date of the last demand statement to be sent to the guarantor.
- **HB_BILL_NOTE_EXP_DT**: This column contains the expiration date of the billing note on this guarantor.
- **HB_PP_MONTHLY_DUE**: This column contains the monthly payment due on a hospital account for a payment plan.
- **HB_PP_CUR_HAR_DUE**: Current amount due on a hospital account for a payment plan.
- **HB_PP_INIT_HAR_BAL**: The initial balance on the hospital account when the payment plan starts.
- **GUAR_VERIF_STAT_C_NAME**: The category number of the guarantor verification status.
- **LAST_VERIF_DT**: This column contains the date of the last verification of the associated guarantor.
- **NEXT_REVIEW_DT**: Next date this guarantor's verification should be reviewed.
- **LAST_VERIF_USER_ID**: This column stores the unique identifier of the last user to verify the guarantor.
- **LAST_VERIF_USER_ID_NAME**: The name of the user record. This name may be hidden.
- **GUAR_EMP_HOUSE_NUM**: The house number of the guarantor's employer.
- **GUAR_EMPR_DISTR_C_NAME**: The category number for the district of the guarantor's employer.
- **GUAR_VERIF_ID**: The verification record of the guarantor.
- **CONF_NAM_OF_ASSC_PT**: This item contains the confidential name of the associated patient, if it exists. This name is used to determine the confidential nature of the guarantor.
- **EXT_BD_SP_BAL**: This value is the Professional Billing external AR bad debt self-pay balance.
- **EXT_BD_INS_BAL**: This value is the Professional Billing external AR bad debt insurance balance.
- **PB_EXT_SP_BAL**: This value is the Professional Billing external AR self-pay balance for the account.
- **PB_EXT_INS_BAL**: This value is the Professional Billing external AR insurance balance for the account.

### ACCOUNT_2
**Table**: Accounts contain information about billing for services, while coverages contain information about insurance payors, benefits, subscribers, and members. This table contains one row for each account record in your system. This table is the continuation of the ACCOUNT table.
- **ACCT_ID**: The unique identifier for the account record.
- **FOL_UP_LEVEL_CUR**: Current follow up level.
- **EMPL_ID_NUM**: Employee ID number of the guarantor.
- **BILLING_NOTE_EXP_DT**: Billing note expiration date.
- **ALT_BILL_ADDR_YN**: Indicates whether the Alternate Billing Address is used. "Y" indicates that the Alternate Billing Address is used. "N" indicates that the Alternate Billing Address is not used.
- **ALT_BILL_CITY**: This is the city on the Alternate Billing Address.
- **ALT_BILL_STATE_C_NAME**: The category value of the state on the Alternate Billing Address.
- **ALT_BILL_ZIP**: This is the zip code on the Alternate Billing Address.
- **RQG_ACCT_YN**: Indicates whether this is a requisition grouper account.
- **GUAR_SYNC_OWNER_ID**: When using guarantor account syncing, this item is the record pointer to the owning guarantor account, if one exists.
- **EAR_ISOLATED_YN**: This flag is set if the guarantor is considered "isolated" for patient data restrictions.  Isolated guarantors are guarantors created from isolated patients.
- **CVG_LAST_VERIF_DT**: Contains the date that the corresponding coverage was last verified.
- **USER_CVG_LST_VER_ID**: Contains the date that the corresponding coverage was last verified.
- **USER_CVG_LST_VER_ID_NAME**: The name of the user record. This name may be hidden.
- **EMPLOYMENT_DATE**: The date the guarantor was employed.
- **EMPLOYER_FAX**: The guarantor's employer's fax number.
- **FAX**: The fax number associated with this guarantor account.
- **LAST_BILLED_AMT**: Last statement's billed amount
- **LAST_INS_BAL**: Last statement's insurance amount
- **LAST_CLAIM_DATE**: Last date the claim was produced
- **BILL_STATUS_EXP_DT**: Billing status expiration date
- **PMT_PLAN_FREQ_C_NAME**: Payment plan frequency
- **ACCT_VIP_STAT_YN**: Indicates whether there is VIP status for this account. Y indicates the account has VIP status. N indicates the account does not have VIP status.
- **HBMYC_LST_ST_V_DTTM**: The date and time when a Hospital Billing statement was last viewed in MyChart by this guarantor. This field will be updated when either a guarantor-level or hospital account-level statement is viewed in MyChart for this guarantor.  The date and time for this column is stored in Universal Coordinated Time (UTC) and can be converted to local time by using the EFN_UTC_TO_LOCAL Clarity database function.
- **HBMYC_LST_DB_V_DTTM**: The date and time when a Hospital Billing detail bill was last viewed in MyChart by this guarantor.  The date and time for this column is stored in Universal Coordinated Time (UTC) and can be converted to local time by using the EFN_UTC_TO_LOCAL Clarity database function.
- **HBMYC_LST_LT_V_DTTM**: The date and time when a Hospital Billing letter was last viewed in MyChart by this guarantor. This field will be updated when either a guarantor-level or hospital account-level letter is viewed in MyChart for this guarantor.  The date and time for this column is stored in Universal Coordinated Time (UTC) and can be converted to local time by using the EFN_UTC_TO_LOCAL Clarity database function.
- **CREDIT_SCORE**: The guarantor's credit score.
- **PROPENSITY_TO_PAY_C_NAME**: Category describing the likelihood for this guarantor to pay.
- **FOL_UP_LAST_LET_DT**: Date the last follow-up letter was sent.
- **UNDIST_CREDIT_BAL**: Total account undistributed credit balance
- **UNDIST_INS_CR_BAL**: Account undistributed credit balance - insurance credits only.
- **UNDIST_SP_CR_BAL**: Account undistributed credit balance - self-pay credits only.
- **DELIVERY_POINT**: The billing delivery point is a two digit extension to the nine digit US zip code, with values from 00 to 99.
- **MILITARY_RANK_C_NAME**: This column stores the military rank to which the patient's guarantor belongs.
- **BRANCH_OF_SERVICE_C_NAME**: This column stores the military branch of service to which the guarantor belongs.
- **MIL_COMPONENT_C_NAME**: This column stores the guarantor's military component, which is used to distinguish between guarantors who are on regular active duty and those who are members of one of the augmenting support groups.
- **MIL_PAY_GRADE_C_NAME**: This column stores the military pay grade to which the patient's guarantor belongs.
- **DIST_LATER_COUNT**: Number of undistributed credits that are marked as for later distribution in this account.
- **GUAR_EMPR_COUNTY_C_NAME**: The category value corresponding to the county in which the guarantor's employer is located.
- **ALT_BILL_COUNTY_C_NAME**: The category number for the alternate county of the guarantor's billing address.
- **ALT_BILL_COUNTRY_C_NAME**: The category number for the alternate country of the guarantor's billing address.
- **ALT_BILL_HOUSE_NUM**: The alternate billing house number for the guarantor.
- **ALT_BILL_DISTRICT_C_NAME**: The category number for the alternate district of the guarantor's billing address.
- **STMT_HOLD_DT**: The most recent date on which the account was held from the Professional Billing (PB) statement processing.
- **STMT_HOLD_REASON_C_NAME**: The reason why the account was held in Professional Billing statement processing.
- **MYPT_ID**: The unique ID of the MyChart account that is linked to this guarantor record. This is used when the guarantor is not a patient in the system but needs to have access to the billing information in MyChart.
- **GUAR_SUBDIV_CODE_C_NAME**: Capture the guarantor's country subdivision code.
- **MOBILE_PHONE**: Mobile phone for guarantor accounts.
- **FOL_UP_LAST_LEVEL**: This retains the value of the current follow up level (I EAR 3007) when a letter was last generated.
- **PMT_PLAN_DLQ_AMT**: This is the sum of delinquent payment plan payments.
- **PMT_PLAN_DUE_AMT**: This includes both the delinquent amount and the amount due for the current month.
- **PMT_PLAN_PAID_AMT**: This is the total amount of the payment plan payments.
- **PMT_PLAN_REMAIN_AMT**: This is the remaining amount of the payment plan.
- **HB_EXT_AR_SELF_PAY_BAL**: This item stores the Hospital Billing (HB) external Accounts Receivable (AR) self-pay balance for the account.
- **HB_EXT_AR_INS_BAL**: This item stores the Hospital Billing (HB) external Accounts Receivable (AR) insurance balance for the account.
- **HB_EXT_AR_UNDIST_BAL**: This item stores the Hospital Billing (HB) external Accounts Receivable (AR) undistributed balance for the account.
- **HB_LAST_AUTOPAY_DATE**: The most recent Auto Pay date for guarantor set up with a payment plan on Auto Pay.
- **EMAIL_ADDRESS**: Email address documented on the guarantor.   Any clarity report looking for the guarantor's email address must search in the following sequence, and use the first found one: - The primary email address from the associated patient of the guarantor.  - The email address from the MyChart account associated with the guarantor. - The email address returned by this clarity column.
- **ADDR_CHG_USER_ID**: The user who initiated the linked address changes.
- **ADDR_CHG_USER_ID_NAME**: The name of the user record. This name may be hidden.
- **ADDR_CHG_INSTANT_DTTM**: The instant that the linked address change was initiated.
- **ADDR_CHG_SOURCE**: The source record that initiated the linked address changes.
- **PREFERENCE_ID**: The ID number of the communication preferences record for the guarantor.
- **PMT_PLAN_CURRENT_MISS_CNT**: This item will store the number of payments that are currently late on the payment plan
- **PMT_PLAN_TOTAL_MISS_CNT**: This item will store the total number of missed payments on the account's payment plan.
- **PMT_PLAN_AUTOPAY_CARD_ID**: Credit card associated with the payment plan. This credit card will be charged automatically when an installment is due for the payment plan.  This column will be deprecated in the future release as the payment plan is being transitioned to use the scheduled payment framework.  Once the transition is complete, reference the scheduled payment record for the current credit card.
- **PB_PP_AUTOPAY_SCHED_PMT_ID**: The scheduled payment record (BSP) associated with the guarantor's payment plan. Scheduled payment record is used to define the auto pay payment plan terms, including the payment method, day to trigger payment, and monthly amount.
- **PMT_PLAN_CURR_AMT**: If Guarantor is on autopayment plan using Scheduled Payment architecture, this item stores the monthly amount to be used for this payment plan cycle if the value is different than the updated payment plan monthly amount in payment plan amount.
- **KI_GUAR_ACCT_VERIF_DATE**: This item indicates the most recent date the patient verified the self-guarantor billing information is correct in Welcome.
- **KI_GUAR_ACCT_VERIF_STS_C_NAME**: This item indicates the most recent patient-selected status of whether the self-guarantor billing information is correct in Welcome.
- **LAST_PB_BAL_NOTIF_DATE**: The date on which the last balance notification was sent to the guarantor for their Professional Billing (PB) balances.
- **LAST_HB_BAL_NOTIF_DATE**: The date on which the last balance notification was sent to the guarantor for their Hospital Billing (HB) / Single Billing Office (SBO) balances.
- **PB_SELF_PAY_BAL_UPDATE_DATE**: This is updated based on changes to patient balance.
- **HB_SELF_PAY_BAL_UPDATE_DATE**: This is updated based on changes to Hospital Billing (HB) self-pay balance (I EAR 20003).

### ACCOUNT_3
**Table**: Accounts contain information about billing for services, while coverages contain information about insurance payors, benefits, subscribers, and members. This table contains one row for each account record in your system.
- **ACCOUNT_ID**: The unique identifier (.1 item) for the account record.
- **PNB_TYPE_C_NAME**: The Posted Not Billed rule type category ID for the guarantor account.
- **ALWAYS_SELF_PAY_YN**: Indicates whether this account should always be self-pay.
- **REFERRAL_SOURCE_COMMENT**: The comment associated with the referral source in ACCOUNT.REFERRAL_SOURCE.
- **BILLING_TITLE_C_NAME**: The category ID of the title used to address the person associated with the guarantor account.
- **HB_NEXT_BAL_NOTIF_DT**: The date on which the next balance notification will be sent to the guarantor for their HB/SBO balances.
- **HB_NEXT_AUTOPAY_DT**: The next Auto Pay date for guarantor set up with a payment plan on Auto Pay.
- **PB_NEXT_BAL_NOTIF_DT**: Stores the date on which the next balance notification will be sent to the guarantor for their PB balances.
- **FAMILY_INCOME**: The annual family income for this account.
- **CLEAR_FOLLOWUP_FLAG**: Stores whether the account should be considered for a new follow-up cycle by nightly processing.
- **FOL_UP_LETTER**: The follow-up letter associated with the account.
- **FOL_UP_TEMPLATE**: The comma-delimited string of SmartText records associated with the account.
- **FAMILY_SIZE**: The number of family members associated with the account.
- **OUTSTANDING_ACCT_C_NAME**: This column specifies if the account is outstanding or not.
- **PMT_PLAN_SECOND_DUE_DT**: Contains the day of the month that the second bi-monthly payment is due.
- **PMT_PLAN_EXP_AMT**: The expected paid amount of the payment plan. This amount is updated by nightly processing. The amount is incremented by the monthly amount when the closed batch date equals the current due date.
- **PMT_PLAN_NEXT_DUE_DT**: Next due date of the payment plan. The date is updated by nightly processing when the closed batch date is the current due date.
- **PMT_PLAN_AUTOPAY_DUE_DT**: The date when the card will be charged for the auto-pay payment plan.
- **PMT_PLAN_AUTOPAY_DAY**: The day of the month when card will be automatically charged.
- **STMT_HOLD_REASON_TEXT**: The free text information related to the reason why the account was held in PB statement processing.
- **HB_IN_PROG_SP_BAL**: This item stores the HB self-pay balance of in progress accounts for the guarantor, excluding hospital accounts in external AR or bad debt. In progress accounts are those that have not yet been billed to self-pay.
- **HB_IN_PROG_BAD_DEBT_SP_BAL**: This item stores the HB self-pay balance of in progress bad debt accounts for the guarantor. In progress accounts are those that have not yet been billed to self-pay.
- **HB_IN_PROG_EXTERNAL_AR_SP_BAL**: This item stores the HB self-pay balance of in progress external AR accounts for the guarantor. In progress accounts are those that have not yet been billed to self-pay.
- **HB_CONTEST_SP_BAL**: This item stores the HB self-pay balance of contested accounts for the guarantor, excluding hospital accounts in external AR or bad debt.
- **HB_CONTEST_BAD_DEBT_SP_BAL**: This item stores the HB bad debt self-pay balance of contested accounts for the guarantor.
- **HB_CONTEST_EXTERNAL_AR_SP_BAL**: This item stores the HB External AR self-pay balance of contested accounts for the guarantor.
- **DECLINED_FA_UTC_DTTM**: The most recent time a guarantor declined financial assistance.
- **PB_CONTEST_SP_BAL**: The total contested PB HAR balance for the guarantor
- **PB_CONTEST_EXTERNAL_AR_SP_BAL**: The total contested external A/R PB HAR balance for the guarantor
- **EB_PMT_PLAN_SCHED_PMT_ID**: The unique ID of the HB/SBO payment plan agreement record for this guarantor.

### ACCOUNT_CONTACT
**Table**: This table contains the information recorded in billing system account contact for each account. Each row in this table contains information about one contact and is uniquely identified by the Account ID and line number combination.
- **ACCOUNT_ID**: The unique ID for the account record. This ID number could be encrypted if you have elected to implement enterprise reporting�s encryption security function.
- **LINE**: Line number to identify the account contact information within the account.
- **CONTACT_DATE**: The date the contact was recorded.
- **USER_ID**: The ID of the system user who recorded the contact. This ID may be encrypted if you have elected to use enterprise reporting�s security utility.
- **USER_ID_NAME**: The name of the user record. This name may be hidden.
- **CONTACT_STATUS_C_NAME**: The category value associated with the activity performed by collections staff on the account, such as No Contact, Check Mailed, Promised Payment, etc.
- **TICKLER_DATE**: The date the account should be contacted again.
- **LETTER_NUMBER**: The letter number of the letter associated with this guarantor.
- **REFUND_REQ_ID**: Stores payment transaction numbers of a refund request for the Account Contact activity.
- **REFUND_REQ_STATUS_C_NAME**: Stores the refund request status associated with the Account Contact activity.
- **REFUND_REQ_AMT**: Stores the amount of the refund request associated with the activity.
- **PAYMENT_TXS**: A comma-delimited list of follow-up transactions.
- **FOL_UP_CUR_INS_BAL**: Follow-up current insurance balance.
- **FOL_UP_CUR_PAT_BAL**: Follow-up current patient balance.
- **FOL_UP_ACT_INFO**: This item stores the activity info to be displayed in account contact.
- **LETTER_SUMMARY**: A short summary of the letter that was sent to the patient. This can be customized by your organization, and may include information like the patient's name, address and balance.
- **LETTER_STATUS_C_NAME**: The letter status category ID for the guarantor, for example "queued" or "sent".
- **NOTE_ID**: The ID of the note associated with this contact.
- **FOL_UP_HX_CRM_ID**: Stores the ID for an customer service record that is related to the guarantor.
- **FOL_UP_NOTE**: Each guarantor account may have a follow-up note posted to it per contact. This column holds either a system generated or custom note that further describes the contact, if a note was produced.
- **LETTER_NAME**: The name of the letter.
- **PAPERLESS_UPD_WHY_C_NAME**: Reason for updating the guarantor's MyChart paperless billing status.

### ACCOUNT_CONTACT_2
**Table**: This table contains the information recorded in billing system account contact for each account. Each row in this table contains information about one contact and is uniquely identified by the Account ID and line number combination.
- **ACCT_ID**: The unique ID for the account record. This ID number could be encrypted if you have elected to implement enterprise reporting�s encryption security function.
- **LINE**: Line number to identify the account contact information within the account.
- **FOL_UP_MYC_USER_ID**: The ID of the MyChart user who created the contact. This ID may be encrypted if you have elected to use enterprise reporting�s security utility.
- **PAY_PLAN_SOURCE_C_NAME**: The source workflow category ID that set up the payment plan for the guarantor.

### ACCOUNT_CREATION
**Table**: The items populated at the time a guarantor account is created.
- **ACCT_ID**: The unique identifier for the guarantor record.
- **CONTACT_DATE_REAL**: A unique contact date in decimal format. The integer portion of the number indicates the date of contact. The digits after the decimal distinguish different contacts on the same date and are unique for each contact on that date. For example, .00 is the first/only contact, .01 is the second contact, etc.
- **CONTACT_DATE**: The date of this contact in calendar format.
- **CONTACT_NUM**: The account creation contact number.
- **ACCOUNT_CREATOR**: Name of user who created a guarantor account

### ACCT_ADDR
**Table**: This table contains one row for each line of the billing address of a guarantor account.
- **ACCOUNT_ID**: The unique identifier for the guarantor record. This column is frequently used to link to the ACCOUNT table
- **ADDRESS_LINE**: The line number for the guarantor billing address. This line number represents a single line of a guarantor's billing address.
- **ADDRESS**: This represents the guarantor's street address. Each ACCOUNT_ID value represents a different guarantor account and each ADDRESS_LINE value represents a different line of that guarantor's address.

### ACCT_COVERAGE
**Table**: This table contains coverage lists for every accounts receivable (EAR) record.
- **ACCOUNT_ID**: The unique account record ID. This ID number may be encrypted if you have elected to use enterprise reporting�s security utility.
- **LINE**: Line number to identify the status information within the account.
- **COVERAGE_ID**: The coverage ID for the guarantor record.

### ACCT_GUAR_PAT_INFO
**Table**: This table contains information about the account guarantor - patient relationship.
- **ACCOUNT_ID**: The unique ID for the account. This ID number could by encrypted if you have elected to implement enterprise reporting�s encryption security function.
- **LINE**: Line number to uniquely identify the patient within the guarantor account.
- **PAT_ID**: The unique ID for the patient related to the guarantor of the account.
- **GUAR_REL_TO_PAT_C_NAME**: The relationship of the patient to the guarantor of the account (e.g. Mother, Brother, Legal Guardian, etc.)
- **PATIENT_ADDR_LINKED_YN**: Indicates whether the patient address and the guarantor address are linked.

### ACCT_HOME_PHONE_HX
**Table**: This table contains the guarantor's home phone history.
- **ACCOUNT_ID**: The unique identifier for the account record.
- **LINE**: The line number for the information associated with this record. Multiple pieces of information can be associated with this record.
- **CHANGE_DATE**: The date the home phone number was changed.
- **PHONE_NUMBER**: The home phone number on the account.
- **CHANGE_SOURCE_C_NAME**: The source of the change of the home phone number.

### ACCT_TX
**Table**: This tables stores the unique IDs of the transaction (ETR) records  for account records.
- **ACCOUNT_ID**: The unique identifier for the guarantor record.
- **LINE**: The line number for the information associated with this record. Multiple pieces of information can be associated with this record.
- **TX_ID**: The unique ID associated with the transaction record for this row.  This column is frequently used to link to the ARPB_TRANSACTIONS table.

### ARPB_AUTH_INFO
**Table**: Stores authorization information for a charge transaction.
- **TX_ID**: The unique identifier for the transaction record.
- **LINE**: The line number for the information associated with this record. Multiple pieces of information can be associated with this record.
- **OVRD_AUTH_CVG_ID**: Lists all the coverages on the guarantor account for this transaction.
- **OVRD_AUTH_NUM**: Stores the authorization number received from payor. This item is never automatically populated by the system. Users have to manually enter.
- **AUTH_SOURCE_C_NAME**: The authorization source type category ID of the authorization source for the transaction.
- **AUTH_ID**: List of linked Authorization records based on coverages.
- **AUTH_OVRIDE_USER_ID**: This stores the user that was responsible for the last authorization assignment.
- **AUTH_OVRIDE_USER_ID_NAME**: The name of the user record. This name may be hidden.
- **AUTH_UPDATE_DTTM**: This stores the last time an authorization was assigned.
- **INCL_IN_AUTH_CHG_CNT_YN**: This column indicates whether the charge contributes to the used count of the authorization linked to it.

### ARPB_CHG_ENTRY_DX
**Table**: The table lists all diagnoses on a charge entry session in which the charge was posted.
- **TX_ID**: The unique internal ID of the transaction record representing this charge.
- **LINE**: The line number for the information associated with this record. Multiple pieces of information can be associated with this record.
- **DX_ID**: The diagnosis internal ID (EDG .1) associated with the charge entry session.  This diagnosis is from the primary codeset.
- **DX_QUALIFIER_C_NAME**: Qualifier for the diagnosis on this line.  Indicates if diagnosis is:  1 - Active 2 - Acute 3 - Chronic 4 - Inactive 5 - Temporary

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

### ARPB_TRANSACTIONS2
**Table**: This table contains information about professional billing transactions.
- **TX_ID**: The unique identifier for the transaction record.
- **EB_PMT_TOTAL_AMT**: Displays the enterprise payment total amount.
- **FIN_DIV_ID**: The Financial Division for this transaction.  Taken from the ETR listed or from the associated Bill Area, as found in ARPB_TRANSACTIONS
- **FIN_DIV_ID_BILL_AREA_NAME**: The record name of this bill area, financial subdivision, or financial division.
- **FIN_SUBDIV_ID**: The Financial Subdivision for this transaction.  Taken from the ETR listed or from the associated Bill Area, as found in ARPB_TRANSACTIONS
- **FIN_SUBDIV_ID_BILL_AREA_NAME**: The record name of this bill area, financial subdivision, or financial division.
- **RESEARCH_STUDY_ID**: The record ID for the research study or client associated with the charge.
- **RSH_MOD_TYPE_C_NAME**: The research billing modifier type for a research study related charge.
- **RSH_ORIG_ACCOUNT_ID**: Stores the original patient account for charges billed to the guarantor account related to a research study.
- **OUTSTANDING_FLAG_C_NAME**: The type of balance category ID for the transaction
- **VST_DO_NOT_BIL_I_YN**: This item indicates whether the visit has been marked as do not bill insurance.
- **TREATMENT_PLAN_CSN**: The contact serial number of the treatment plan that generated the order, which generated this charge.
- **TX_ENTERED_INSTANT_DTTM**: The transaction entered instant (date and time in UTC) for manually posted payments. The transaction filing instant (date and time in UTC) for electronically posted payments.
- **CVG_PLAN_ON_PMT_ID**: This column contains the coverage plan associated with the invoice number stamped on an insurance payment or credit adjustment.
- **REVERSED_PMT_TX_ID**: For the negation payment generated during a payment reversal, this item stores the transaction ID of the original payment.
- **PMT_REVERSAL_TX_ID**: This virtual item returns the reversal transaction ID for a reversed payment.
- **STMT_HOLD_DT**: The most recent date on which the transaction was held from the Professional Billing statement processing.
- **STMT_HOLD_REASON_C_NAME**: The reason why the transaction was held in PB statement processing.
- **REPOST_REASON_C_NAME**: If this transaction was reposted from another, this contains the category value of the reason the transaction was reposted.
- **SUSP_NRP_INDICATOR_YN**: This item indicates whether NRP is currently suspended.
- **SUSP_NRP_INST_DTTM**: This item stores the instant (date and time) when the next responsible party action was suspended.
- **SUSP_NRP_USER_ID**: This item stores the suspended next responsible party user for the transaction.
- **SUSP_NRP_USER_ID_NAME**: The name of the user record. This name may be hidden.
- **OUTST_CLM_STAT_C_NAME**: The status of an outstanding claim that is attached to a transaction.
- **POS_TYPE_C_NAME**: Place of service type for a charge transaction.
- **INACTIVE_TYPE_C_NAME**: This column returns the type of an inactive transaction.  Inactive transactions are those involved in a void or reversal. This item subcategorizes the transaction's role in the void or reversal. This will be for both the actual voided/reversed credit and the associated negation payment or debit adjustment.
- **VOIDED_INS_AMT**: The total amount owed from insurance at the time a charge was voided. This includes previously applied payments and adjustments.
- **PROV_NETWORK_STAT_C_NAME**: Basic indicator of whether a provider was in or out of network on the service date of a transaction
- **NETWORK_LEVEL_C_NAME**: The provider's level of network involvement category ID for the transaction.
- **SPEC_CHG_TYPE_C_NAME**: The special type category ID for the charge.
- **ORIG_BUNDPMT_ETR_ID**: The original bundled payment transaction ID.
- **ORIG_BUNDPMT_HTR_ID**: The original bundled payment hospital transaction ID.
- **REFERENCE_AMT**: Holds the reference amount that is calculated based on the financial class for the charge. This is set by the system and is applicable only to charges.
- **REFERENCE_AMT_SRC_C_NAME**: Holds the source of the reference amount that is used in the calculation of the reference amount. This is set by the system and is applicable only to charges.
- **CLM_RMV_RSN_C_NAME**: Stores the reason charge was removed from the claim queue.
- **ADJUSTMENT_CAT_C_NAME**: Stores the adjustment category of the associated adjustment code when the credit adjustment is posted.
- **WRITE_OFF_RSN_C_NAME**: The reason a credit adjustment was posted. This is determined programmatically when possible (e.g. contractual adjustments, self-pay discounts). Otherwise, this is the write-off reason associated with the adjustment category for this adjustment.
- **SCHED_PMT_ID**: Stores the scheduled payment record that resulted in this payment.
- **TAX_CHARGE_TX_ID**: Stores the source transaction for a tax charge
- **PATIENT_ESTIMATE_ID**: This column contains the Patient Estimate (PES) record ID for a dental estimate that is finalized and is linked to this charge.  If the charge was triggered from dental and if there is a dental estimate associated with the encounter (in a status of "Finalized"), that estimate's record ID will be stored in ETR item 1801 and extracted in this column. The item and column are not updated if and when the original finalized estimate is replaced.
- **PATIENT_WISDOM_PROC_ID**: Patient dental procedure that was respected by the temporary transaction that filed into this transaction.
- **RFL_OVRIDE_SRC_C_NAME**: This item stores the referral override source. The options are 1-User or 2-System.
- **RFL_OVRIDE_USER_ID**: This item stores the user who overrode the referral associated with this charge.
- **RFL_OVRIDE_USER_ID_NAME**: The name of the user record. This name may be hidden.
- **PARENT_SCHED_PMT_ID**: Stores the parent scheduled payment record that resulted in this payment.
- **MANUAL_PRICE_OVRIDE_YN**: Permanent transaction indicator used during repost/correct/retro to determine if the charge's price was originally overridden.
- **IS_PRE_SERVICE_PMT_YN**: Indicates whether or not this is a pre-service payment, such as a co-pay. This item is only populated for self-pay payments. A payment is considered pre-service if it is a visit pre-pay or co-pay payment (such as during check-in).
- **FIRST_HTR_TX_ID**: Stores the hospital transaction ID of the first transaction in a chain of transactions. Note that this chain will include transactions from both Hospital Billing and Professional Billing, so this item will return the very first transaction. For a given transaction, either column ARPB_TRANSACTIONS2.FIRST_HTR_ID, or column ARPB_TRANSACTIONS2.FIRST_ETR_ID will be populated. This is different from column ARPB_TRANSACTIONS2.FIRST_TX_ID, which only chains back to the point that the transaction was transferred from Hospital Billing.
- **FIRST_ETR_TX_ID**: Stores the transaction ID of the first transaction in a chain of transactions. Note that this chain will include transactions from both Hospital Billing and Professional Billing, so this item will return the very first transaction. For a given transaction, either column ARPB_TRANSACTIONS2.FIRST_HTR_ID, or column ARPB_TRANSACTIONS2.FIRST_ETR_ID will be populated. This is different from column ARPB_TRANSACTIONS2.FIRST_TX_ID, which only chains back to the point that the transaction was transferred from Hospital Billing.
- **POSTING_DEPARTMENT_ID**: The department where the transaction was posted.
- **EXP_REIMB_SYS_AMT**: The item stores the original reimbursement amount calculated by contract if the original reimbursement amount is overridden.
- **EXP_REIMB_SRC_C_NAME**: The item stores how the reimbursement amount was calculated for the charge.
- **RECORD_STATUS_C_NAME**: This column displays the transaction record status.
- **RESEARCH_ENROLL_ID**: The unique ID of the research study association linked to this charge.
- **STMT_HOLD_RSN_TEXT**: The free text information related to the reason why the transaction was held in Professional Billing statement processing.
- **E_PMT_RECEIPT_MSG**: Saves the receipt message received from the gateway for an electronic payment transaction.
- **PARENT_TX_ID**: This column contains the charge ID that created this transaction during transaction filing. This is used for anesthesia supplemental charges, charge quantity splitting, and charge shadowing.

### ARPB_TRANSACTIONS3
**Table**: This table contains information about professional billing transactions.
- **TX_ID**: The unique identifier for the transaction record.
- **IS_SCANNED_CHECK_YN**: Indicates if a transaction was made using a scanned check.
- **SUSP_NRP_SRC_COVERAGE_ID**: This column stores the coverage when the next responsible party (NRP) action was suspended.
- **SUSP_NRP_DST_COVERAGE_ID**: This column stores the coverage for the suspended NRP action.
- **SUSP_NRP_AMT**: This column stores the amount of the suspended NRP action.
- **SUSP_NRP_ASSIGN_C_NAME**: This column stores the assignment value for the suspended NRP action.
- **SUSP_NRP_SOURCE_MODULE_C_NAME**: This column stores the module for the suspended NRP action.
- **SUSP_NRP_COMMENT**: This column stores the comment for the suspended NRP action.
- **EB_PMT_HTT_ID**: The Enterprise payment hospital temporary transaction ID.
- **IS_CSA_PAYMENT_YN**: Indicates that a payment was identified as coming from a consumer spending account during professional billing remittance processing.
- **BFD_COVERAGE_ID**: This item stores the coverage used to compute reimbursement and pricing contracts for charge lines that qualify for bill for denial workflows.
- **ADV_PRICING_DESCRIPTION**: Description of the advanced pricing line in ECP used for this charge.
- **ADV_PRICING_INDEX_ID**: Component or component group used in advanced pricing.
- **ADV_PRICING_INDEX_ID_COMPONENT_INDEX_NAME**: The name of the component index record
- **ADV_PRICING_RULE_ID**: Rule used for advanced pricing.
- **ADV_PRICING_RULE_ID_RULE_NAME**: The name of the rule.
- **ADV_PRICING_MECHANISM_C_NAME**: Advanced pricing mechanism used.
- **ADV_PRICING_FSC1_ID**: Fee schedule 1 used in advanced pricing.
- **ADV_PRICING_FSC1_ID_FEE_SCHEDULE_NAME**: The name of each fee schedule.
- **ADV_PRICING_FSC2_ID**: Fee schedule 2 used in advanced pricing.
- **ADV_PRICING_FSC2_ID_FEE_SCHEDULE_NAME**: The name of each fee schedule.
- **ADV_PRICING_FSC_PERC_1**: Percent of specified fee schedule 1 used in advanced pricing.
- **ADV_PRICING_FSC_PERC_2**: Percent of specified fee schedule 2 used in advanced pricing.
- **ADV_PRICING_PERC_BASE**: Percent of base price used in advanced pricing.
- **ADV_PRICING_LPP_ID**: Pricing extension used in advanced pricing.
- **ADV_PRICING_LPP_ID_LPP_NAME**: The name of the extension.
- **PRIM_TIMELY_FILE_DEADLINE_DATE**: The primary timely filing deadline date.
- **PAT_PMT_COLL_WKFL_C_NAME**: This column contains the workflow category ID performed to collect a patient payment from the point of view of the user. For example, MyChart eCheck-in vs. MyChart One-Touch.
- **MYC_SIGNIN_METHOD_C_NAME**: This column denotes how the patient or guarantor logged in to MyChart to either post the payment or create an agreement that will post a payment via Auto Pay. Only populated for agreements made via MyChart.
- **POSTING_MYPT_ID**: This column contains either the MyChart account that created the agreement that resulted in the self-pay payment (if applicable) or the MyChart account that posted the self-pay payment.
- **POSTING_MYC_STATUS_C_NAME**: This item contains either the status of the MyChart account that created the agreement that resulted in the self-pay payment (if applicable) or the status of the MyChart account that posted the self-pay payment.   An active MyChart account status is defined as whether a MyChart user could log into the account with a user name and password. Accounts that are not yet active, deactivated, or are proxy accounts are considered inactive.
- **EB_TX_SOURCE_C_NAME**: This column stores the enterprise posting module for the transaction. This is calculated based on the professional billing transaction source for the transaction.
- **IMPLIED_QTY**: The implied quantity for a charge.
- **IMPLIED_QTY_UNIT_C_NAME**: The implied quantity's unit.
- **IMPLIED_UNIT_TYPE_C_NAME**: The unit type of the implied quantity.
- **OVR_REIMB_CONTRACT_ID**: The override reimbursement contract that was entered.
- **OVR_REIMB_CONTRACT_ID_CONTRACT_NAME**: The name of the Vendor-Network contract.
- **OVR_REIMB_CONTRACT_DATE**: The contact that should be used of the override reimbursement contract that was entered.
- **OVR_EXPECTED_REIMB_AMOUNT**: Stores the expected reimbursement override amount for the charge. This override amount was entered by a user.
- **PMT_PLAN_AGRMT_SCHED_PMT_ID**: The unique ID of the transaction's target guarantor's active payment plan agreement record at the time of filing.
- **IS_EST_PRE_SERVICE_PLAN_PMT_YN**: Indicates whether this payment was made on an estimated balance on a payment plan at time of filing ('Y'). 'N' or NULL indicates that the transaction is not a payment, the payment is not on a balance on a payment plan, or the balance was not estimated at the time of filing.
- **IS_PRE_SERVICE_PLAN_PMT_YN**: Indicates whether this payment was made toward a hospital account on a payment plan that was added by an estimate ('Y'). 'N' or NULL indicates that the transaction is not a payment or the payment was not made toward a hospital account on a payment plan that was added by an estimate.

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

### ARPB_TX_CHG_REV_HX
**Table**: Charge Review History Related Information.  This information is copied from the TAR (temporary transaction) record when a charge in charge review is filed to ETR (permanent transaction).
- **TX_ID**: The unique identifier for the transaction record.
- **LINE**: The line number for the information associated with this record. Multiple pieces of information can be associated with this record.
- **CR_HX_USER_ID**: Charge Review History User ID.  This is the user that performs the activity reflected in this line in the charge review history.
- **CR_HX_USER_ID_NAME**: The name of the user record. This name may be hidden.
- **CR_HX_DATE**: The charge review history date.
- **CR_HX_TIME**: Displays the date the recall must be made by.
- **CR_HX_ACTIVITY_C_NAME**: The charge review history activity category ID for the transaction. Examples include Entry, Review, Resubmit, etc.
- **CR_HX_CONT_LINE_YN**: Charge Review History Continuation Flag.  This flag is set to yes if this line is a continuation of the previous line
- **CR_HX_USER_COMMENT**: The comment associated to a Charge Review history action.

### ARPB_TX_MATCH_HX
**Table**: Matching History Transaction Related Items.  A line is added to this related group whenever two transactions are matched together.
- **TX_ID**: The unique identifier for the transaction record.
- **LINE**: The line number for the information associated with this record. Multiple pieces of information can be associated with this record.
- **MTCH_TX_HX_DT**: This item stores the date that a transaction was matched to this transaction.
- **MTCH_TX_HX_ID**: This item stores the transaction that this transaction was matched to.  If the MTCH_TX_HX_UN_DT is null, then the transaction is still currently matched to this transaction.
- **MTCH_TX_HX_AMT**: This item stores the (insurance+self-pay) amount for which this transaction is matched to the transaction in column MTCH_TX_HX_ID.
- **MTCH_TX_HX_INS_AMT**: This item stores the insurance amount for which this transaction is matched to the transaction in column MTCH_TX_HX_ID.
- **MTCH_TX_HX_PAT_AMT**: This item stores the self-pay amount for which this transaction is matched to the transaction in column MTCH_TX_HX_ID.
- **MTCH_TX_HX_COMMENT**: This item holds the comment for the matching of this transaction to the transaction in column MTCH_TX_HX_ID.  This item is typically only populated by the system and not user entered comments.
- **MTCH_TX_HX_UN_DT**: This item holds the date that the transaction was unmatched from the transaction in column MTCH_TX_HX_ID.
- **MTCH_TX_HX_D_CVG_ID**: This item stores the coverage ID at the time that the transaction was matched to the transaction in column MTCH_TX_HX_ID.
- **MTCH_TX_HX_DSUSR_ID**: This item stores the users who matched this transaction to the transaction from column MTCH_TX_HX_ID.
- **MTCH_TX_HX_DSUSR_ID_NAME**: The name of the user record. This name may be hidden.
- **MTCH_TX_HX_UDUSR_ID**: This item stores the user that unmatched this transaction from the transaction in the MTCH_TX_HX_ID column.
- **MTCH_TX_HX_UDUSR_ID_NAME**: The name of the user record. This name may be hidden.
- **MTCH_TX_HX_INV_NUM**: This item stores the invoice associated with the debit transaction in the matching group.
- **MTCH_TX_HX_UN_COM**: This item stores the comment entered when the transaction is undistributed.
- **MTCH_TX_HX_UN_CV_ID**: This is the coverage of the debit transaction at the time of unmatch.
- **MTCH_TX_HX_LINE**: This item stores the corresponding line from the matched transaction.
- **MTCH_TX_HX_DTTM**: The UTC date and time the transaction was matched.
- **MTCH_TX_HX_UN_DTTM**: The UTC date and time the transaction was unmatched.

### ARPB_TX_MODERATE
**Table**: Transaction Information that is used moderately often.
- **TX_ID**: The unique identifier for the transaction record.
- **ORIGINATING_TAR_ID**: This item holds the originating temporary transaction�ID for this transaction. If the transaction is a charge, then the originating temporary transaction�ID will be the temporary transaction ID of the charge. If transaction is a payment, then the originating temporary transaction ID will be the payment temporary transaction ID unless the payment is from fast payment. In the fast payment case, the originating temporary transaction ID will be the charge temporary transaction ID.
- **SOURCE_TAR_ID**: This item holds the source temporary transaction ID for this transaction.  The source temporary transaction ID will always be equal to the temporary transaction ID that generates the transaction.
- **SRC_TAR_CHG_LINE**: Indicates the temporary transaction charge line this transaction originated from.
- **PAT_AGING_DATE**: Aging date used for self-pay aged A/R
- **INS_AGING_DATE**: Aging date used for insurance aged A/R
- **HOSP_ACCT_ID**: This item stores the hospital account record ID for the transaction.
- **ORDER_ID**: The unique ID of the order record that triggered this transaction. This item is not always populated if you use the Charge Router.
- **EXT_REF_NUM**: External reference number.  This is a customer item that can be populated as they see fit.  Typically, this item is populated with data from an external system via an interface or transaction import.
- **REFERENCE_NUM**: This item stores the reference number (check number) for a payment transaction.
- **PMT_RECEIPT_NUM**: This item stores the receipt number for a payment transaction.
- **PAT_TYPE_C_NAME**: This item stores the patient type for the patient on this transaction.
- **REFERRAL_PROV_ID**: This stores this transaction's referral provider.  Note that this field is linked to the referral source master file and not the provider master file.
- **REFERRAL_PROV_ID_REFERRING_PROV_NAM**: The name of the referral source.
- **INSURANCE_AMT_PAID**: This item stores the insurance amount that has been paid on a charge transaction.
- **WRITEOFF_EXCEPT_C_NAME**: The Yes-No write-off category number for a charge transaction. The value indicates whether the charge transaction was adjudicated as a write-off in charge entry and thus the insurance portion write-off is suppressed.
- **PAT_LOCATION_ID**: The unique ID of the location associated with the patient for this transaction.
- **ORIG_PRICE**: This item stores the original price of the transaction if the price was changed during charge entry.
- **EXP_REIMB_DYNAMIC**: The expected reimbursement will be updated whenever reimbursement is calculated. This amount cannot exceed the charge amount.
- **EXPECTED_REIMB**: The expected reimbursement calculated at charge entry. This item is not updated by any change during claims. Also, this amount cannot exceed the charge amount.
- **COVERAGE_PLAN_ID**: The Plan (EPP) ID that is associated with this transaction.
- **CVG_PLAN_GROUP_ID**: This item stores the employer group (PPG) ID that is associated with this transaction.
- **CVG_PLAN_GROUP_ID_PLAN_GRP_NAME**: The name of the employer group record
- **MED_NEC_YN**: This is the flag that is set in charge entry if medical necessity is needed for a transaction.
- **TECHNICAL_CHG_FL_YN**: This flag is set to yes if the transaction is a technical charge.  This is only populated if using the split billing functionality.
- **CNTR_DISCOUNT_AMT**: This item stores the pricing contract discount amount for a transaction.
- **UNDIST_TX_DATE**: This items stores the date that a transaction was undistributed (unmatched).
- **UNDIST_CHG_USER_ID**: This item stores the user that unmatched a transaction.
- **UNDIST_CHG_USER_ID_NAME**: The name of the user record. This name may be hidden.
- **UNDIST_INSTANT**: This item stores the instant that a transaction was undistributed (unmatched).
- **ORIGINAL_AMT_COPAY**: This item stores the original copay amount for the transaction.
- **BAD_DEBT_CHG_YN**: Indicates whether the charges is written off to bad debt.
- **AUTO_PAT_WO_C_NAME**: This item stores if a transaction had its self-pay portion automatically written off.
- **TX_USER_COMMENT**: The comments entered by users when they perform an action like transfer, retro, void, and undistribute on a transaction in Transaction Inquiry are stored in this item.
- **CONTESTED_YN**: This item stores a flag to determine if a transaction is contested.
- **CONTEST_REASON_C_NAME**: This item stores the reason that a transaction is contested if the transaction is contested.
- **MEA_IDENTIFIER_C_NAME**: This item stores the measurement (MEA) identifiers that are entered in charge entry.
- **CRC_CODE_C_NAME**: This item stores the CRC code entered in charge entry.
- **REIMB_CONTRACT_AMT**: Stores the allowed amount as calculated by the reimbursement contract. This amount can exceed the charge amount.
- **EXT_CUR_AGENCY_ID**: The current collections agency.
- **EXT_CUR_AGENCY_ID_COLL_AGENCY_NAME**: The name of the collection agency.
- **EXT_CURAGNCY_STAT_C_NAME**: The current agency status category ID for the transaction.
- **EXTERNAL_ID**: This item stores the external transaction ID
- **SURGICAL_LOG_ID**: The unique ID associated with the surgical log record for this row. This column is frequently used to link to the OR_LOG table. This item is populated if charge is entered from OpTime.
- **SUPPLY_ID**: The unique ID associated with the supply record for this row. This column is frequently used to link to the OR_SPLY table.
- **SUPPLY_ID_SUPPLY_NAME**: The name of the inventory item.
- **IMPLANT_ID**: The unique ID associated with the implant record for this row. This column is frequently used to link to the OR_IMP table.
- **EXT_AGNCY_SENT_DTTM**: The instant the charge was sent to its current agency.
- **FIRST_SELFPAY_DATE**: This items stores the date when a charge first goes to self-pay.
- **PROV_TYPE_C_NAME**: The provider type for the transaction.
- **CLAIM_ID**: The claim record for the transaction.
- **IS_WK_COMP**: Indicates whether the transaction is for worker's comp.
- **EOB_UPDATED_DT**: Date in which the Explanation of�Benefits for this transaction was last updated.
- **RAD_THER_COMP_TX_ID**: This item stores the ID for radiation therapy component transactions and rollup charges.
- **RAD_THER_END_YN**: Indicates whether Radiation Therapy is at the end of treatment for this transaction.
- **START_TIME**: Start time of a timed procedure.
- **STOP_TIME**: Stop time of a timed procedure.
- **SERVICE_TIME**: Time when service is performed.
- **PURCHASESERVICE_AMT**: This is the amount paid for or to be paid to a third party for performing a service. This field is used to report this amount on claims and statements along with price being charged to the payor or guarantor for the service.  This item should only be used if it is desired this purchased service information be reported on claims and statements.
- **THIRD_PARTY_POS_ID**: The third party or reference lab where an individual purchased service was performed. This item is used to reference a Place of Service in order to report the address and National Provider Identifier of the third party on claims and statements. This item should only be used if it is desired this purchased service information be reported on claims and statements.
- **MNL_RETRO_REASON_C_NAME**: The retroadjudication reason category ID for the transaction
- **TYPE_OF_SERVICE_C_NAME**: The type of service category number associated with the transaction.
- **DX_PRIM_CODESET_C_NAME**: This item stores the primary diagnosis codeset for the transaction.
- **DX_ALT_CODESET_C_NAME**: This item stores the alternate diagnosis codeset for the transaction.
- **START_DATE**: The date on which a service is started.
- **STOP_DATE**: The date on which a service was stopped.
- **PROC_MINUTES**: The length of time in minutes that this procedure took.
- **CRD_CHARGE_SLIP_NO**: The encounter form number associated with copay payments entered during scheduling.

### ARPB_TX_MODIFIERS
**Table**: This table contains multiple response information for modifiers associated with A/R (ETR) transactions.
- **ETR_ID**: The unique ID of the transaction (ETR) record for this row.
- **LINE**: The line number for the information associated with this record. Multiple pieces of information can be associated with this record.
- **EXT_MODIFIER**: The external ID of the modifier record.

### ARPB_TX_STMCLAIMHX
**Table**: This table contains information about the statement and claim history for professional billing transactions.
- **TX_ID**: The unique ID of the transaction record
- **LINE**: The line number for the information associated with this contact. Multiple pieces of information can be associated with this contact.
- **BC_HX_TYPE_C_NAME**: This item stores whether the current line is a bill or claim entry.  A category value of 1 means claim and 2 means bill.
- **BC_HX_DATE**: The date the statement or claim was processed. This can be NULL when an insurance payment posts and it can�t find a matching claim with that payer in the history.
- **BC_HX_COVERAGE_ID**: The unique ID of the coverage that is associated with the bill or claim run
- **BC_HX_ASSIGNED_YN**: Indicates whether or not the coverage is assigned to insurance for this transaction. Y indicates the coverage is assigned.
- **BC_HX_AMOUNT**: The amount of the transaction on the bill or claim.
- **BC_HX_INVOICE_NUM**: The invoice number for the bill or claim.
- **BC_HX_PAYMENT_AMT**: Payment amount for payment associated with this invoice.  This field applies to claims only.
- **BC_HX_PAYMENT_DATE**: Payment date for payment associated with this invoice.  This field applies to claims only.
- **BC_HX_PAYOR_ID**: The unique ID of the payor for this claim. This field applies to claims only.
- **BC_HX_RESUBMIT_DATE**: Resubmit date for this claim.  This field applies to claims only.
- **BC_HX_CLM_DB_ID**: The unique ID of the claim information record for this claim. This field applies to claims only.
- **BC_HX_HELD_AMOUNT**: Amount held (not shown) on a bill.  This item applies to bills only.
- **BC_HX_BO_PROC_ID**: The internal record ID for the procedure billed out on the claim. This item only applies to claims.
- **BC_HX_AUX_PROC**: Claim Auxiliary Procedure.  This item is only used by claims.  This is populated when claim bundling grouping rules are used and there are procedures that are left over from the claim. This item is a semicolon delimited list of extra procedures.  For example, if the bundling rule is set up to bundle and 99212 and a 99213 and there are two 99212s and one 99213, then the 99212 procedure identifier would appear in this column.
- **BC_HX_ACCEPT_DATE**: Accept date for bill or claim
- **BC_HX_FIRST_CLM_FLG**: This item is set to 0 for accepted claims where all previous lines in the statement-claim history are claims. This item is set to 1 for accepted claims where there is at least one previous line in the statement-claim history that was a statement.  This item is only populated for claims.
- **BC_HX_AR_CLASS_C_NAME**: AR classification at the time of claim/statement run acceptance.
- **BC_HX_ACCEPT_DTTM**: The UTC date and time the statement or claim was accepted.

### ARPB_TX_STMT_DT
**Table**: This table stores the statement dates for transactions.
- **TX_ID**: The unique identifier for the transaction record.
- **LINE**: The line number for the information associated with this record. Multiple pieces of information can be associated with this record.
- **STATEMENT_DATE**: The statement dates for the transaction.

### ARPB_TX_VOID
**Table**: This table contains information on transactions that were either: * Transferred * Voided * Reversed * Retroadjudicated
- **TX_ID**: The unique identifier for the transaction record.
- **OLD_ETR_ID**: This item holds a pointer for a transaction that was reposted retroactively to the original transaction.
- **REPOSTED_ETR_ID**: This item stores a pointer to the old transaction in the case of charge correction or repost.
- **REPOST_TYPE_C_NAME**: This indicates the type of repost on the source transaction.  This is either set to repost or correction.
- **IS_RETRO_TX**: This item serves as a flag to determine if this transaction was voided as a result of retroadjudication.
- **TRANS_TX_ID**: This item stores a pointer to the transaction ID that this transaction was transferred from. This item is only populated if a transaction was transferred from another transaction.
- **TRANS_FROM_C_NAME**: This item stores the void status of the transferred from transaction for this transaction.  This item is only populated if this transaction was transferred from a different account.
- **RETRO_CHARGE_ID**: This item stores the transaction ID for the reposted transaction caused by the retroadjudication of this transaction.
- **DEL_REVERSE_DATE**: This is the date that the transaction was voided or reversed.
- **DEL_CHARGE_USER_ID**: This item stores the user who voided this transaction.
- **DEL_CHARGE_USER_ID_NAME**: The name of the user record. This name may be hidden.
- **DEL_CHARGE_INSTANT**: This item stores the instant that a transaction was voided.
- **IS_REVERSED_C_NAME**: This flag determines if a transaction has been reversed.
- **VOIDED_BY_MSG_YN**: This flag is set if the charge was voided as a result of a Charge Router message.
- **VOID_REASON_C_NAME**: The reason for voiding/reversing category ID for the transaction
- **VOIDED_BY_CGR_C_NAME**: Indicates that a charge is voided by charge router.

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

### CLM_DX
**Table**: All values associated with a claim are stored in the Claim External Value record. The CLM_DX table holds the diagnoses for the claim.
- **RECORD_ID**: The unique identifier for the Claim Info record.
- **LINE**: The line number for the information associated with this contact. Multiple pieces of information can be associated with this contact.
- **CLM_DX_QUAL**: This item holds the qualifier identifying the code set for the claim diagnoses.
- **CLM_DX**: This item holds the diagnoses for the claim. The principal diagnosis is stored on the first line and the other diagnoses are on subsequent lines.
- **CLM_DX_POA**: This item identifies if the diagnosis was present when the patient was admitted.
- **CLM_DX_CODE_SET_OID**: The object ID (OID) for the diagnosis code set.
- **CLM_DX_RANK**: This item holds the explicit rank of the diagnoses when it is present in the raw claims data.
- **CLM_DX_FROM_HEADER_YN**: Indicates whether the diagnosis was received at the header level.
- **RX_DX_QUAL**: This item holds the qualifier identifying the code set for the claim diagnoses on a pharmacy claim.

### CLM_NOTE
**Table**: All values associated with a claim are stored in the Claim External Value record. The CLM_NOTE table holds claim level notes or remarks.
- **RECORD_ID**: The unique identifier for the Claim Info record.
- **LINE**: The line number for the information associated with this contact. Multiple pieces of information can be associated with this contact.
- **CLM_NOTE**: This item holds claim level notes.

### CLM_VALUES
**Table**: All values associated with a claim are stored in the Claim External Value record. The CLM_VALUES table holds claim-level values set by the system during claims processing or by user edits.
- **RECORD_ID**: This column stores the unique identifier for the claim record.
- **BIL_PROV_TYP_QUAL**: The value indicating whether the billing provider on the claim is a person or a non-person.
- **BIL_PROV_NAM_LAST**: The billing provider's last name (if a person) or the organization name (if a non-person).
- **BIL_PROV_NAM_FIRST**: The billing provider's first name. It is only populated when the billing provider is a person.
- **BIL_PROV_NAM_MID**: The billing provider's middle name. It is only populated when the billing provider is a person.
- **BIL_PROV_NAM_SUF**: The suffix to the billing provider's name (e.g., Jr, III). It is only populated when the billing provider is a person.
- **BIL_PROV_NPI**: The billing provider's National Provider Identifier (NPI).
- **BIL_PROV_TAXONOMY**: The billing provider's taxonomy code.
- **BIL_PROV_TAXID_QUAL**: The qualifier for the billing provider's tax ID defining the type of ID reported as the tax ID.
- **BIL_PROV_TAXID**: The billing provider's tax ID. For individuals, this ID could be the SSN or tax ID.
- **BIL_PROV_UPIN**: The billing provider's unique physician identification number (UPIN). It is only populated when the provider is a person.
- **BIL_PROV_LIC_NUM**: The billing provider's license number. It is only populated when the billing provider is a person.
- **BIL_PROV_ADDR_1**: The first line of the billing provider's street address.
- **BIL_PROV_ADDR_2**: The second line of the billing provider's street address.
- **BIL_PROV_CITY**: The billing provider's city.
- **BIL_PROV_STATE**: The billing provider's state.
- **BIL_PROV_ZIP**: The billing provider's ZIP Code.
- **BIL_PROV_CNTRY**: The billing provider's country. It is only populated if the address is outside the United States.
- **BIL_PROV_CNTRY_SUB**: The billing provider's country subdivision (e.g., state, province). It is only populated if the address is outside the United States.
- **CLM_CVG_SEQ_CD**: The code identifying the filing order for the claim (e.g., primary, secondary, tertiary).
- **CLM_CVG_PYR_NAM**: The payer name.
- **CLM_CVG_GRP_NUM**: The group number entered in the coverage record.
- **CLM_CVG_GRP_NAM**: The group name entered in the coverage record.
- **CLM_CVG_INS_TYP**: The insurance type code for the claim.
- **CLM_CVG_FILING_IND**: The indicator identifying the type of claim.
- **CLM_CVG_PYR_ID_TYP**: The qualifier that describes the type of ID used to identify the payer.
- **CLM_CVG_PYR_ID**: The primary ID for the payer.
- **CLM_CVG_ACPT_ASGN**: The indicator that the provider accepts assignment from the payer.
- **CLM_CVG_AUTH_PMT**: The indicator that the insured assigns benefits to the provider.
- **CLM_CVG_REL_INFO**: The indicator that the insured has authorized the release of information to the payer.
- **PYR_ADDR_1**: The first line of the payer's street address.
- **PYR_ADDR_2**: The second line of the payer's street address.
- **PYR_CITY**: The payer's city.
- **PYR_STATE**: The payer's state.
- **PYR_ZIP**: The payer's ZIP Code.
- **PYR_CNTRY**: The payer's country. It is only populated if the address is outside the United States.
- **PYR_CNTRY_SUB**: The payer's country subdivision (e.g., state, province). It is only populated if the address is outside the United States.
- **PAT_NAM_LAST**: The patient's last name.
- **PAT_NAM_FIRST**: The patient's first name.
- **PAT_NAM_MID**: The patient's middle name.
- **PAT_NAM_SUF**: The suffix to the patient's name (e.g., Jr, III).
- **PAT_MRN**: The patient's medical record number.
- **PAT_CVG_MEM_ID**: The coverage member ID for the patient.
- **PAT_REL_TO_INS**: The patient's relationship to the coverage subscriber.
- **PAT_BIRTH_DATE**: The patient's birthdate.
- **PAT_SEX**: The patient's gender.
- **PAT_SIG_ON_FILE**: The indicator that the patient has signed the necessary release forms and the forms are on file at the provider.
- **PAT_SIG_SRC**: The indicator that the release forms were signed on the patient's behalf.
- **PAT_DEATH_DATE**: The date of the patient's death.
- **PAT_WT**: The patient's weight (in pounds) when needed for the claim.
- **PAT_PREG_IND**: The indicator that the patient is pregnant.
- **PAT_WK_COMP_NUM**: The identification number used for workers' comp claims.
- **PAT_MAR_STAT**: The patient's marital status.
- **PAT_EMPY_STAT**: The patient's employment status.
- **PAT_PH**: The patient's phone number.
- **PAT_ADDR_1**: The first line of the patient's street address.
- **PAT_ADDR_2**: The second line of the patient's street address.
- **PAT_CITY**: The patient's city.
- **PAT_STATE**: The patient's state.
- **PAT_ZIP**: The patient's ZIP Code.
- **PAT_CNTRY**: The patient's country. It is only populated if the address is outside the United States.
- **PAT_CNTRY_SUB**: The patient's country subdivision (e.g., state, province). It is only populated if the address is outside the United States.
- **INV_NUM**: The invoice number that uniquely identifies the claim in the billing system.
- **ICN**: The payer's internal control number (ICN) that uniquely identifies the claim in the payer's system.
- **TTL_CHG_AMT**: The total charge amount for the claim.
- **BILL_TYP_FAC_CD**: The facility code portion of the bill type (first and second digits).
- **BILL_TYP_FREQ_CD**: The frequency code portion of the bill type (third digit).
- **MOMS_MRN**: The mother's medical record number when the patient is a newborn.
- **PAYTO_ADDR_TYP_QUAL**: The indicator that the pay-to address entity on the claim is a person or a non-person.

### CLM_VALUES_2
**Table**: All values associated with a claim are stored in the Claim External Value record.  The CLM_VALUES_2 table holds claim-level values set by the system during claims processing or by user edits.
- **RECORD_ID**: The unique identifier for the claim values record.
- **ADMSN_TYP**: The admission type for the claim.
- **ADMSN_SRC**: The admission source for the claim.
- **DISCHRG_DISP**: The patient's discharge status, also referred to as the discharge disposition.
- **RFL_NUM**: The referral number for the claim.
- **AUTH_NUM**: The prior authorization number for the claim.
- **SPEC_PROG_IND**: The indicator that the services on the claim were rendered under one of a list of special programs.
- **CLM_DELAY_RSN**: The reason code explaining why the claim was submitted after the payer's normal filing deadline.
- **AUTH_EXCEPT_CD**: The code explaining why services that normally need authorization were performed without the necessary authorization.
- **PAT_AMT_PAID**: The amount already paid by the patient.
- **PAT_AMT_DUE**: The amount estimated to be the patient's responsibility.
- **AUTO_ACDNT_STATE**: The state in which an automobile accident occurred.
- **AUTO_ACDNT_CNTRY**: The country in which an automobile accident occurred. It is only populated when the accident occurred outside the United States.
- **MAMM_CERT_NUM**: The provider's certification number when the claim contains mammography services.
- **CLIA_NUM**: The Clinical Laboratory Improvement Amendment (CLIA) number when the claim contains lab services.
- **DEMO_PRJ_ID**: The identifier for claims billed under atypical rules (e.g., pilot programs, clinical trials).
- **SPINAL_MAN_COND_CD**: The patient's condition when the claim contains chiropractic services.
- **EPSDT_CERT_APPLIES**: The indicator that identifies whether an Early and Periodic Screening, Diagnostic, and Treatment (EPSDT) referral was given to the patient.
- **ORTHO_TOT_MO**: The total number of months of orthodontic treatment.
- **ORTHO_MO_REMAIN**: The number of months of orthodontic treatment remaining for a transfer patient.
- **ADMSN_DX_QUAL**: The qualifier that identifies the code set for the admission diagnosis for the claim.
- **ADMSN_DX**: The admission diagnosis for the claim.
- **DRG**: The Diagnosis Related Group (DRG) determined for the claim.
- **ANES_SURG_PROC**: The HCPCS code of the surgical procedure performed under anesthesia when the code needs to be reported on the anesthesia claim.
- **OUTSIDE_LAB**: The indicator that the claim includes purchased services rendered by an independent provider.
- **OUTSIDE_LAB_CHG**: The price of the purchased services.
- **CLM_FROM_DT**: The earliest date represented on the claim. This date could be the minimum service date for an outpatient or professional claim or the admission date for an inpatient claim.
- **CLM_TO_DT**: The latest date represented on the claim. This date could be the maximum service date for an outpatient or professional claim or the discharge date for an inpatient claim.
- **ADMSN_DT**: The admission date on the claim. For outpatient claims, this date represents the visit or start of care date.
- **ADMSN_TM**: The time at which the patient was admitted to the facility. This time is only available for institutional claims.  Note that the value is the exact time, including both the hour and minutes.
- **DISCHG_DT**: The discharge date on the claim.
- **DISCHG_TM**: The time at which the patient was discharged. This time is only available for institutional claims.  Note that the value is the exact time, including both the hour and minutes.
- **ILL_INJ_DT**: The date in which the patient was injured or when the current illness was first noticed.
- **INIT_TREAT_DT**: The initial treatment date when the claim represents a series of visits (e.g., physical therapy, spinal manipulation, dialysis, pregnancy).
- **LST_SEEN_DT**: The date the patient was last seen by the attending or supervising provider.
- **ACUTE_MANIF_DT**: The date acute symptoms first manifested.
- **ACDNT_DT**: The date the automobile accident occurred.
- **LMP_DT**: The date of the last menstrual period.
- **LST_XRAY_DT**: The date of the last X-Ray.
- **HEAR_VIS_RX_DT**: The date on which the prescription was written for hearing devices or vision frames and lenses.
- **DISAB_START_DT**: The earliest date on which the patient was disabled and could not work.
- **DISAB_END_DT**: The latest date on which the patient was disabled and could not work.
- **LST_WK_DT**: The last date on which the patient was able to perform his or her duties at work.
- **AUTH_RETURN_WK_DT**: The date on which the patient can return to work.
- **ASSUM_CARE_DT**: The date on which care was assumed by another provider during post-operative care.
- **RELINQ_CARE_DT**: The date on which the provider of the claim ceased post-operative care.
- **ORTHO_BAND_DT**: The date orthodontic appliances were placed.
- **DENT_SRV_DT**: The date on which dental services were performed.
- **SIMILAR_ILL_DT**: The earliest date on which symptoms of the same or similar illness were noticed.
- **AMB_PAT_WT**: The patient's weight (in pounds) when the patient is transported by an ambulance.
- **AMB_TRANS_RSN_CD**: The code explaining why the patient was transported by ambulance.
- **AMB_TRANS_DIST**: The distance (in miles) the patient was transported.
- **AMB_RND_TRIP_DESC**: The note explaining the need for round trip transportation.
- **AMB_STRETCHER_DESC**: The note explaining the need for a stretcher.
- **CNTRCT_TYP**: The code representing the type of contract between the provider and the payer.
- **CNTRCT_AMT**: The amount assigned by the contract between the provider and the payer.
- **CNTRCT_PCT**: The contract percentage for the claim assigned by the contract between the provider and the payer.
- **CNTRCT_CD**: The code representing the claim type under the contract between the provider and the payer.
- **CNTRCT_DISCNT_PCT**: The discount percentage assigned by the contract between the provider and the payer.
- **CNTRCT_VERS_ID**: The version of the contract used on the claim.
- **ATT_PROV_NAM_LAST**: The attending provider's last name.
- **ATT_PROV_NAM_FIRST**: The attending provider's first name.
- **ATT_PROV_NAM_MID**: The attending provider's middle name.
- **ATT_PROV_NAM_SUF**: The suffix to the attending provider's name (e.g., Jr, III).
- **ATT_PROV_NPI**: The attending provider's National Provider Identifier (NPI).
- **ATT_PROV_TAXONOMY**: The attending provider's taxonomy code.
- **OPER_PROV_NAM_LAST**: The operating provider's last name.
- **OPER_PROV_NAM_FIRST**: The operating provider's first name.
- **OPER_PROV_NAM_MID**: The operating provider's middle name.
- **OPER_PROV_NAM_SUF**: The suffix to the operating provider's name (e.g., Jr, III).
- **OPER_PROV_NPI**: The operating provider's National Provider Identifier (NPI).
- **OTH_PROV_NAM_LAST**: The other operating provider's last name.
- **OTH_PROV_NAM_FIRST**: The other operating provider's first name.
- **OTH_PROV_NAM_MID**: The other operating provider's middle name.
- **OTH_PROV_NAM_SUF**: The suffix to the other operating provider's name (e.g., Jr, III).
- **OTH_PROV_NPI**: The other operating provider's National Provider Identifier (NPI).
- **REND_PROV_TYP**: The rendering provider on the claim is a person or a non-person.
- **REND_PROV_NAM_LAST**: The rendering provider's last name (if a person) or the organization name (if a non-person).
- **REND_PROV_NAM_FIRST**: The rendering provider's first name. It is only populated when the provider is a person.
- **REND_PROV_NAM_MID**: The rendering provider's middle name. It is only populated when the provider is a person.
- **REND_PROV_NAM_SUF**: The suffix to the rendering provider's name (e.g., Jr, III). It is only populated when the provider is a person.
- **REND_PROV_NPI**: The rendering provider's National Provider Identifier (NPI).
- **REND_PROV_TAXONOMY**: The rendering provider's taxonomy code.
- **REF_PROV_NAM_LAST**: The referring provider's last name.
- **REF_PROV_NAM_FIRST**: The referring provider's first name.
- **REF_PROV_NAM_MID**: The referring provider's middle name.
- **REF_PROV_NAM_SUF**: The suffix to the referring provider's name (e.g., Jr, III).
- **REF_PROV_NPI**: The referring provider's National Provider Identifier (NPI).
- **REF_PROV_TAXONOMY**: The referring provider's taxonomy code.
- **SUP_PROV_NAM_LAST**: The supervising provider's last name.
- **SUP_PROV_NAM_FIRST**: The supervising provider's first name.
- **SUP_PROV_NAM_MID**: The supervising provider's middle name.
- **SUP_PROV_NAM_SUF**: The suffix to the supervising provider's name (e.g., Jr, III).
- **SUP_PROV_NPI**: The supervising provider's National Provider Identifier (NPI).
- **ASST_SURG_NAM_LAST**: The assistant dental surgeon's last name.
- **ASST_SURG_NAM_FIRST**: The assistant dental surgeon's first name.
- **ASST_SURG_NAM_MID**: The assistant dental surgeon's middle name.

### CLM_VALUES_3
**Table**: All values associated with a claim are stored in the Claim External Value record. The CLM_VALUES_3 table holds claim level values set by the system during claims processing or by user edits.
- **RECORD_ID**: The unique identifier for the claim values record.
- **ASST_SURG_NAM_SUF**: The suffix to the assistant dental surgeon's name.
- **ASST_SURG_NPI**: The assistant dental surgeon's National Provider Identifier (NPI).
- **ASST_SURG_TAXONOMY**: The assistant dental surgeon's taxonomy code.
- **SVC_FAC_NAM**: The name of the external location where the services were performed.
- **SVC_FAC_NPI**: The NPI of the external location where the services were performed.
- **SVC_FAC_CNCT_NAM**: The contact name for the external location.
- **SVC_FAC_CNCT_PH**: The contact phone number for the external location.
- **SVC_FAC_CNCT_EXT**: The contact phone extension for the external location.
- **SVC_FAC_ADDR_1**: The first line of the external location street address.
- **SVC_FAC_ADDR_2**: The second line of the external location street address.
- **SVC_FAC_CITY**: The external location's city.
- **SVC_FAC_STATE**: The external location's state.
- **SVC_FAC_ZIP**: The external location's ZIP code.
- **SVC_FAC_CNTRY**: The external location's country. It is only populated if the address is outside the United States.
- **SVC_FAC_CNTRY_SUB**: The external location's country subdivision (state, province, etc). It is only populated if the address is outside the United States.
- **PICK_UP_ADDR_1**: The first line of the ambulance pick-up location street address.
- **PICK_UP_ADDR_2**: The second line of the ambulance pick-up location street address.
- **PICK_UP_CITY**: The ambulance pick-up location's city.
- **PICK_UP_STATE**: The ambulance pick-up location's state.
- **PICK_UP_ZIP**: The ambulance pick-up location's ZIP code.
- **PICK_UP_CNTRY**: The ambulance pick-up location's country. It is only populated if the address is outside the United States.
- **PICK_UP_CNTRY_SUB**: The ambulance pick-up location's country subdivision (e.g., state, province). It is only populated if the address is outside the United States.
- **DROP_OFF_NAM**: The name of the ambulance drop-off location.
- **DROP_OFF_ADDR_1**: The first line of the ambulance drop-off location street address.
- **DROP_OFF_ADDR_2**: The second line of the ambulance drop-off location street address.
- **DROP_OFF_CITY**: The ambulance drop-off location's city.
- **DROP_OFF_STATE**: The ambulance drop-off location's state.
- **DROP_OFF_ZIP**: The ambulance drop-off location's ZIP code.
- **DROP_OFF_CNTRY**: The ambulance drop-off location's country. It is only populated if the address is outside the United States.
- **DROP_OFF_CNTRY_SUB**: The ambulance drop-off location's country subdivision (e.g., state, province). It is only populated if the address is outside the United States.
- **CREATE_DT**: The date the claim was created. It is used for paper institutional claims.
- **CLM_CVG_AMT_PAID**: The amount already paid by the payer of the current coverage.
- **PAT_PROP_CAS_ID_TYP**: The qualifier for the Property and Casualty Patient ID used on American National Standards Institute (ANSI) version 5010 claims.
- **PAT_PROP_CAS_ID**: This column stores the patient identifier for property and casualty claims used on American National Standards Institute (ANSI) version 5010 claims.
- **ADMSN_QUAL**: The qualifier to identify when the admission hour is reported along with the admission date.
- **REMARK**: The claim remark printed on institutional claims as the billing note.
- **CLM_CVG_AMT_DUE**: The amount due by the payer of the current coverage.
- **CLM_CVG_COMPLMT_ID**: The complementary payer ID for the payer of the current coverage.
- **CLM_CVG_REL_INFO_DT**: The date on which the insured authorized the release of information to the payer.
- **LOCAL_USE_CMS**: The value to print in Reserved for Local Use Box 10d on the paper 1500 version 08/05 Centers for Medicare and Medicaid Services (CMS) claim form. On the 1500 version 02/12 form, this field was removed and no longer used.
- **DISABILITY_QUAL**: The qualifier for the disability date and time.
- **DISABILITY_TM_QUAL**: The disability time format qualifier.
- **CAS_SRC_CEV_ID**: The source claim values record to which this reason code claim values record is attached.
- **CAS_LVL_C_NAME**: The indicator that the claim values record includes claim-level or line-level explanation of benefits data.
- **CAS_CVG_LN_NUM**: The coverage line number in the source claim values record for claim-level explanation of benefits.
- **CAS_SVC_LN_NUM**: The service line number in the source claim values record.
- **NCPDP_RECORD_TYPE**: The National Council for Prescription Drug Programs (NCPDP) transaction type being submitted.
- **TXST_TRANSMISSION_ACTION**: The indicator that the file being loaded is a replacement file, update file, or delete file.
- **TXST_SUBMISSION_NUMBER**: The number of times data set has been re-sent.

### CLM_VALUES_4
**Table**: All values associated with a claim are stored in the Claim External Value record. The CLM_VALUES_4 table holds claim-level values set by the system during claims processing or by user edits.
- **RECORD_ID**: The unique identifier for the claim value record.
- **REP_CLM_NUM**: The repriced claim reference number.
- **ADJ_REP_CLM_NUM**: The adjusted repriced claim number.
- **CLM_TRANS_INTMD**: The identifier for claim transmission intermediaries.
- **CLM_PRO_APP_NUM**: The Peer Review Organization (PRO) Approval Number for the claim.
- **CLM_PRICING_METHDLG**: The claim pricing methodology.
- **CLM_REP_ALWD_AMT**: The claim re-pricing allowed amount.
- **CLM_REP_SVNG_AMT**: The claim Repriced Saving Amount.
- **CLM_REP_ORGID**: The Repricing Organization Identifier for the claim.
- **REP_PDIEM_FLTRT_AMT**: The Repricing Per Diem or Flat Rate Amount for the claim.
- **REP_APRVD_DRG_CODE**: The Repriced Approved Diagnosis Related Group Code for the claim.
- **REP_APPRVD_AMT**: The Repriced Approved Amount for the claim.
- **REP_APRVD_REV_CODE**: The Repriced Approved Revenue Code for the claim.
- **REP_ASU_MSRMNT_CODE**: The basis of measurement (e.g., Days, Units) for Repriced Approved Service Unit Count.
- **REP_APR_SERV_CNT**: The Repriced Approved Service Unit Count for the claim.
- **PAYTO_PLAN_TAXID**: The Pay-To Plan Tax Identification Number.
- **FIRST_CNCT_DT**: The Property and Casualty Date of First Contact.
- **REPRICER_RECVD_DT**: The Repricer Received Date.
- **MCARE_XOVER_IND**: The Mandatory Medicare Crossover Indicator.
- **CARE_PLN_NUM**: The Care Plan Oversight Number.
- **HOMEBOUND_COND_QUAL**: The Homebound Condition Qualifier.
- **HOMEBOUND_COND_CD**: The Homebound Condition Code.
- **DENTAL_SVC_FROM_DT**: The Dental Service From Date. It will only be populated when using a dental form.
- **DENTAL_SVC_TO_DT**: The Dental Service To Date. It will only be populated when using a dental form.
- **DENTAL_SVC_DT_QUAL**: The dental date range qualifier. It will only be populated on a dental form.
- **ORTHO_TREAT_IND**: The Orthodontic Treatment Indicator. This column will only have data when a dental claim has orthodontic services without any months of orthodontic treatment being reported.
- **DENT_PREDET_CODE**: The code identifying whether a claim is a pre-authorization dental claim. If the claim is a predetermination of benefits claim (pre-auth), this column will be populated with "PB".  If the claim is a statement of actual services, this column will be null.
- **OTH_ACC_EMER_YN**: The indicator that the claim includes emergency services.
- **STER_ABOR_YN**: The indicator that a visit was related to a sterilization or abortion.
- **PAYEE_NUM**: The payee number for Medicaid.
- **CLM_LVL_TOS**: The claim-level type of service code.
- **CLM_LVL_EPSDT_YN**: The indicator that the claim was related to an Early and Periodic Screening, Diagnostic, and Treatment (EPSDT) visit.
- **CLM_LVL_FAM_PLAN_YN**: The indicator that the claim was related to family planning.
- **CLM_LVL_EMER_YN**: The indicator that the claim was related to emergency services.
- **PAT_LOCATION_IDENT**: The county code corresponding to the patient address.
- **PAT_PERSONAL_IDENT**: The combination of patient name characters and digits from their SSN used by the Statewide Planning and Research Cooperative System (SPARCS) to identify the patient.
- **DRG_SOI**: The Severity Of Illness (SOI) of Diagnosis Related Group (DRG) determined for the claim.
- **DRG_ROM**: The Risk Of Mortality (ROM) of Diagnosis Related Group (DRG) determined for the claim.
- **CAS_SVC_POS_NUM**: The position number within the service line in the source claim CEV.
- **CLM_RECORD_INDICATOR**: The action to be taken on the claim.
- **LINE_OF_BUSINESS_CODE**: The line of business (LOB) code under which claim was paid.
- **BENEFIT_ID**: The identifier for a set of parameters, benefits, or coverage criteria used to adjudicate a claim.
- **PLAN_TYPE**: The type of plan identifier.
- **PRESC_PROV_TAXONOMY**: The prescribing provider taxonomy code.
- **ADJUD_DATE**: The date the claim was processed.
- **ADJUD_TM**: The time the claim was processed.
- **REJECT_OVERRIDE_CODE**: The reason for paying a claim when override is used.
- **CROSS_REF_ICN**: The ID associated with the original claim for adjustment claims.
- **PAYMENT_CLARIFICATION_CODE**: The additional information on the status of the payment of the claim.
- **ADJUSTMENT_TYPE**: The type of adjustment whether debit or credit.
- **STER_ABOR_CODE**: The single-letter sterilization/abortion code appearing in field 22D on the eMedNY 150003 claim form
- **POSSIBLE_DISABILITY_YN**: The indicator that the service was for treatment of a condition which appeared to be of a disabling nature for field 22F on the eMedNY 150003.
- **PMT_SRC_MCR_INVOLVE**: The single-digit source code indicator that indicates Medicare's involvement in paying for these charges for field 23B box M on the eMedNY 150003 claim form.
- **PMT_SRC_OTHR_INVOLV**: The single-digit code indicating whether the patient has a coverage besides Medicare and Medicaid for field 23B box O on the eMedNY 150003 claim form.
- **PMT_SRC_INS_CODE**: The two-digit insurance code for the commercial coverage, if any, for field 23B box O on the eMedNY 150003 claim form.
- **LOCATOR_CODE**: The locator code assigned by Medicaid for the address where the service was performed for field 25C on the eMedNY 150003 paper claim form.
- **MEM_SUBMIT_PMT_RELEASE_DATE**: The date the member submitted claim became payable, which could differ from the check date.
- **CHECK_DATE**: The claim check date.
- **PAT_DEM_CODE_QUAL**: The patient demographic code qualifier.
- **PAT_DEM_CODE**: The patient demographic code.
- **DRG_CODE_SET**: The code set of the Diagnosis Related Group (e.g., APR-DRG, MS-DRG).
- **CLM_STATUS**: The submitter's claim status (e.g., clean, denied).
- **DRG_CODE_VERSION**: The version of the code set that the Diagnosis Related Group (DRG) code on the claim is associated with (e.g., Version 31, Version 32)
- **IS_CLINICALLY_INVALID_IDENT**: The external identifier representing if the claim is clinically invalid or not.
- **DRG_CODE_SET_IDENT**: The external identifier representing the Diagnosis Related Group (DRG) code set.
- **DRG_CODE_VER_IDENT**: The external identifier representing the Diagnosis Related Group (DRG) version.

### CLM_VALUES_5
**Table**: All values associated with a claim are stored in the Claim External Value record. The CLM_VALUES_5 table holds claim-level values set by the system during claims processing or by user edits.
- **RECORD_ID**: The unique identifier for the claim value record
- **FHIR_GROUP_IDENTIFIER**: The bulk FHIR group ID for which the claim was received.
- **DEPT_ALT_CODE**: This item stores the alternate code for the department. The alternate code comes from MPI.   For Norway, this item stores the IK44 code.
- **PAYER_ENTERPRISE_IDENTIFIER**: Patient's enterprise ID assigned by the payer.
- **ATT_PROV_SPECIALTY**: The specialty of the attending provider.
- **NON_PAYMENT_RSN_DESC**: Claim level denial reason code description.
- **CARRIER_PAYMENT_DNL_CD**: Carrier claim payment denial code.
- **NON_PAYMENT_RSN_CD**: Claim level denial reason code.
- **CARRIER_PAYMENT_DNL_DESC**: Carrier claim payment denial code description.
- **BCDA_GROUP_IDENT**: Claim Group Identifier provided by Beneficiary Claims Data API
- **PRIMARY_PAYER_CD**: Code used to determine if Medicare was the primary payer of this claim.
- **BIL_PROV_SPEC_CODE_SET**: Stores the code set for the Billing Provider Specialty Code.
- **OPER_PROV_TAXONOMY**: Holds the Operating Provider Taxonomy Code for a claim.
- **PREDETERMIN_IDENT**: This is the predetermination of benefits identifier for the claim.
- **ADJ_TO_CLAIM_ID**: Holds the adjustment to claim ID for the claim received from raw data
- **REV_TO_CLAIM_ID**: Holds the reversal to claim ID for the claim received from raw data
- **ADJ_SEQUENCE**: Holds the adjustment sequence for the claim received from raw data
- **PLAN_NAME**: The plan name from raw claims data.
- **CORPORATION_NAME**: Corporation name from raw claims data.
- **NETWORK_LEVEL**: Specifies the network level of the claim.
- **REGION_NAME**: The name of the region associated with the claim.
- **LINE_OF_BUSINESS_NAME**: The name of the line of business associated with the claim.
- **SVC_PROV_IN_NETWORK**: This value indicates if the service provider / pharmacy is in-network.
- **MEDICARE_DRUG_CVG_CODE**: Identifies if a claim was processed under the Medicare Part B benefit or Part D benefit.
- **SVC_FAC_CCN**: Centers for Medicare and Medicaid Services Certification Number (CCN) for the service facility location.
- **PCP_REF_PROV_NAM_LAST**: This item holds the PCP referring provider's last name (NM1*P3).
- **PCP_REF_PROV_NAM_FIRST**: This item holds the PCP referring provider's first name (NM1*P3).
- **PCP_REF_PROV_NAM_MID**: This item holds the PCP referring provider's middle name (NM1*P3).
- **PCP_REF_PROV_NAM_SUF**: This item holds the PCP referring provider's suffix (NM1*P3).
- **PCP_REF_PROV_NPI**: This item holds the PCP referring provider's NPI (NM1*P3).
- **PCP_REF_PROV_TAXONOMY**: This item holds the referring provider's taxonomy code.
- **REF_PROV_FROM_LINE_YN**: Identifies whether the referring provider was received at the header level, or rolled up from the line level.
- **REN_PROV_FROM_LINE_YN**: Identifies whether the rendering provider was received at the header level, or rolled up from the line level.
- **OPER_PROV_FROM_LINE_YN**: Identifies whether the operating provider was received at the header level, or rolled up from the line level.
- **OTHOP_PROV_FROM_LINE_YN**: Identifies whether the other operating provider was received at the header level, or rolled up from the line level.
- **PAT_RESIDENCE_CODE**: The code identifying the patient's place of residence. This data is only populated for Pharmacy claims.
- **SVC_FAC_CMS_PARTD_FLAG**: Indicates whether the patient resides in a facility that qualifies for the CMS Part D benefit. This data is only populated for Pharmacy claims.
- **BANK_IDENT_NUM**: The card issuer ID or bank ID number used for network routing. This data is only populated for Pharmacy claims.
- **PROCESSOR_CTL_NUM**: The number assigned by the processor. This data is only populated for Pharmacy claims.
- **RX_PRIOR_AUTH_TYPE**: The code clarifying the prior authorization number submitted or benefit/plan exemption.
- **PRESCRIBER_LAST_NAME**: The last name of the prescribing provider. This data is only populated for Pharmacy claims.

### CLM_VALUE_RECORD
**Table**: This table holds basic identification and processing information for the claim value record.
- **RECORD_ID**: The unique identifier for the claim values record.
- **RECORD_CREATION_DT**: The date the record was created.
- **CLM_TYP_C_NAME**: The type of claim values stored in the record. CMS is used for professional and dental claims. UB is used for institutional claims.
- **FORM_TYP_C_NAME**: The type of form used during processing.
- **CONTEXT_C_NAME**: The direction of the claim file, either incoming or outgoing. This value is only set for Accounts Payable claims.
- **AP_CLAIM_ID**: The claim information record associated with the invoice. This value is only set for Accounts Payable claims.
- **SERV_AREA_ID**: The service area for the claim values record.
- **HEALTH_SYS_IDENT**: This item holds the Health System Identifier (HSI) of the source for the claim.
- **SOURCE_ORGANIZATION_ID**: The source organization of the external record. This value is only set for external claims.
- **SOURCE_ORGANIZATION_ID_EXTERNAL_NAME**: Organization's external name used as the display name on forms and user interfaces.
- **CLAIM_RECON_ID**: The claim reconciliation record ID (CRD) associated with the claim data.
- **CRD_CONTACT_DATE_REAL**: The contact date of the claim reconciliation record, in internal format.

### CLP_NON_GRP_TX_IDS
**Table**: This table stores claim print transaction IDs for Hospital Billing.
- **CLAIM_PRINT_ID**: The unique identifier for the claim record.
- **LINE**: The line number of one of the multiple values associated with a specific group of data within this record.
- **NON_GROUP_HTR_ID**: Stores charges that are active on the current claim.

### CLP_OCCUR_DATA
**Table**: This table extracts the occurrence codes and occurrence dates for each claim.
- **CLAIM_PRINT_ID**: The ID of the claim print record.
- **LINE**: The Line Count
- **OCCURRENCE_CODE_C_NAME**: The occurrence code category list for an institutional claim.
- **OCCURRENCE_DT**: Stores Occurrence Date to print on institutional claims

### CL_REMIT
**Table**: This table stores information for each Image Database (IMD) record. This can be check-level or claim-level, and is indicated in column IMD_TYPE_C.
- **IMAGE_ID**: This is the ID for the remittance image record. A separate remittance image record is created for each invoice payment.
- **CREATION_DATE**: The date when the remittance image record was created (i.e., when the electronic file was loaded and created).
- **SERVICE_AREA_ID**: The service area of the invoice to which this remittance payment was posted.
- **PAYMENT_METHOD_C_NAME**: The posting method by which this remittance record was created (manual or through electronic remittance).
- **PAYMENT_TYPE_C_NAME**: The payment type for this remittance record (self-pay or insurance).
- **PAYMENT_AMOUNT**: Total amount paid by the payer in the remittance file.
- **CREDIT_DEBIT_C_NAME**: Code indicating whether payment amount is a credit or debit.
- **PAYMENT_MTD_CODE_C_NAME**: Code identifying the method for the movement of payment instructions.
- **PAYMENT_FMT_CD_C_NAME**: Code identifying the payment format used.
- **SENDER_ID_QUAL_C_NAME**: Sender ID qualifier. Code identifying the type of identification number of Depository Financial Institution (DFI).
- **SENDER_IDN_NUM**: Sender Depository Financial Institution (DFI) identification number from the remittance file.
- **ISSUE_DATE**: Check issue date or Effective Entry Date for electronic fund transfers.
- **TRACE_TYP_CD_C_NAME**: Code identifying which transaction is being referenced.
- **REF_IMG_ID**: Reference remittance record for general remittance file information.  A separate remittance image record is created for each invoice payment in the remittance file. The general check level information is stored in the first remittance image record and subsequent image records hold the image ID of that record in this item.
- **GRP_REF_ID**: Reference remittance image record for Provider Summary Information and Provider Supplemental Summary Information.  A separate remittance image record is created for each invoice payment in the remittance file.  Multiple invoice payments can share the same Provider Summary Information and Provider Supplemental Summary Information. This information is stored in the first remittance image record. Subsequent image records hold the image ID of the original remittance image in this item.
- **PAT_ID**: The patient from the invoice to which the payment in the remittance image record is posted.
- **CLM_START_DATE**: The starting date of the claim that was sent out to the payer.
- **CLM_END_DATE**: The ending date of the claim that was sent out to the payer.
- **CLP_ID**: Internal ID of the claim record (for Hospital Billing only).
- **IMD_TYPE_C_NAME**: Specifies the type of Remittance Image. 1 is Check Level and 2 is File Level.
- **INTER_CTRL_NUM**: Holds the Interchange Control Number from the electronic remittance file.
- **GROUP_CTRL_NUM**: Holds the Group Control Number from the electronic remittance file.

### CL_RMT_CLM_DT_INFO
**Table**: Contains claim level date information from the electronic remittance payment. This information is sent in the DTM segment in Loop 2100 of an ANSI 835 Health Care Claim Payment/Advice file. This segment is used to send specific dates associated with the claim being paid. This information is stored in the remittance image record.
- **IMAGE_ID**: This is the ID for the remittance image record with related claim date information.
- **LINE**: The line number for the information associated with this record. Multiple pieces of information can be associated with this record.
- **CLAIM_DATE_QUAL_C_NAME**: The date qualifier code for the claim date information. This is a standard code that indicates what the date represents.
- **CLAIM_DT**: Claim related date sent in the remittance file. The specific meaning of this date is indicated by the associated date qualifier code.

### CL_RMT_CLM_ENTITY
**Table**: Contains identifying information for entities (persons or organizations) from an electronic remittance payment. This information is sent in the NM1 segment of an ANSI 835 Health Care Claim Payment/Advice file. This information is stored in the remittance image record.
- **IMAGE_ID**: ID for the remittance image record containing the claim related entity information.
- **LINE**: The line number for the information associated with this record. Multiple pieces of information can be associated with this record.
- **ID_CODE_C_NAME**: The entity identifier code for the claim related entity. This is a standard code that indicates what type of individual or organization is being identified.
- **ENT_QUAL_C_NAME**: Code indicating whether this information is for a person or a non-person entity.
- **LAST_NAME_ORG_NAME**: This is the individual last name or organization name.
- **FIRST_NAME**: The individual first name.
- **MIDDLE_NAME**: The individual middle name or initial.
- **NAME_SUFFIX**: The suffix to individual name.
- **IDEN_CODE_QUALF_C_NAME**: The identification code qualifier. This is a standard code that indicates what type of ID is used to identify the specific individual or organization.
- **IDEN_CODE**: The ID associated with the specific individual or organization.

### CL_RMT_CLM_INFO
**Table**: This table contains the invoice level information to which the payment in the remittance record is posted.
- **IMAGE_ID**: This is the ID for the remittance image record.
- **INV_NO**: The invoice number for the remittance image.
- **CLM_STAT_CD_C_NAME**: This is the code identifying the status of an entire claim.
- **CLAIM_CHRG_AMT**: This is the amount for submitted charges on this claim.
- **CLAIM_PAID_AMT**: This is the amount paid on the claim.
- **PAT_RESP_AMT**: This is the patient responsibility amount for the claim.
- **CLM_FILING_CODE_C_NAME**: This is a code identifying the type of claim.
- **ICN_NO**: This is the payer's internal control number for the claim.
- **FAC_CODE_VAL**: This is the facility code used when the submitted code has been modified through adjudication.
- **CLAIM_FREQ_C_NAME**: This is the frequency code of the claim.
- **DRG_CODE**: This is the Diagnosis Related Group (DRG) code indicating a patient's diagnosis group based on a patient's illnesses, diseases, and medical problems.
- **DRG_WGT**: The diagnosis related group weight.
- **DISCHRG_FRAC**: The discharge fraction expressed as a decimal.
- **FILE_INV_NUM**: Contains the actual invoice number that came in the file.

### CL_RMT_DELIVER_MTD
**Table**: This table contains information on the remittance delivery method when the funds are transferred independently from the remittance.
- **IMAGE_ID**: The unique identifier for the image record.
- **RPT_XMISSION_CODE_C_NAME**: Information about how the report and related funds were transmitted
- **THIRD_PARTY_NAME**: Holds the name of the third party processing entity
- **COMM_NUM**: The communication number of the third party processing entity.

### CL_RMT_HC_RMK_CODE
**Table**: Contains health care remark code information from the service line level of an electronic remittance file. This information is sent in the LQ segment of an ANSI 835 Health Care Claim Payment/Advice file. This information is stored in the remittance image record.
- **IMAGE_ID**: ID for the remittance image record containing the health care remark code information.
- **LINE**: The line number for the information associated with this record. Multiple pieces of information can be associated with this record.
- **LQ_SERVICE_LINE**: The service line associated with the health care remark code.
- **CODE_LST_QUAL_C_NAME**: The code list qualifier code. This is a standard code which indicates which code set the remark code belongs to.
- **INDUSTRY_CODE**: The specific health care remark code.

### CL_RMT_INP_ADJ_INF
**Table**: This table contains inpatient adjudication information from the Remittance Image.
- **IMAGE_ID**: This is the ID for the remittance image record with inpatient adjudication information.
- **COVERED_DAYS**: Covered days or visit count for the claim for inpatient adjudication information.
- **PPS_OPER_OUTL_AMT**: Prospective payment system operating outlier amount for inpatient adjudication information.
- **LIFETIME_PSYC_DAYS**: Lifetime psychiatric days count for inpatient adjudication information.
- **CLAIM_DRG_AMT**: Monetary amount for the diagnosis related group for inpatient adjudication information.
- **REMARK_CODE_1**: Remark code 1 for inpatient adjudication info.
- **CLM_DISP_SHAR_AMT**: Monetary amount for the claim disproportionate share for inpatient adjudication information.
- **CLAIM_MSP_PASS_AMT**: Monetary amount for the claim Medicare secondary payor pass through for inpatient adjudication information.
- **CLAIM_PPS_CAP_AMT**: Monetary amount for the prospective payment system capital for inpatient adjudication information.
- **PPSCAP_FSP_DRG_AMT**: Monetary amount for the prospective payment system's capital federal-specific portion for the diagnosis-related group for inpatient adjudication information.
- **PPSCAP_HSP_DRG_AMT**: Monetary amount for the prospective payment system's capital hospital-specific portion for the diagnosis-related group for inpatient adjudication information.
- **PPS_DSH_DRG_AMT**: Monetary amount for the prospective payment system's capital disproportionate share diagnosis related group for inpatient adjudication information.
- **OLD_CAPITAL_AMT**: Monetary amount of old capital for inpatient adjudication information.
- **PPS_CAPTL_IME_AMT**: Monetary amount for the prospective payment system capital's indirect medical education for inpatient adjudication information.
- **PPS_OP_HSP_DRG_AMT**: Monetary amount for the prospective payment system's operating hospital's specific diagnosis related group for inpatient adjudication information.
- **COST_REPORT_DAYS**: The number of days that may be claimed as Medicare patient days on a cost report for inpatient adjudication information.
- **PPS_FED_DRG_AMT**: Monetary amount for the prospective payment system's operating federal specific diagnosis related group for inpatient adjudication information.
- **CLAIM_PPS_CAPT_AMT**: Monetary amount for the prospective payment system's capital outlier for inpatient adjudication information.
- **CLAIM_INDR_TCH_AMT**: The monetary amount for the claim indirect teaching amount for inpatient adjudication information.
- **NONPY_PROF_COM_AMT**: The monetary amount for the nonpayable professional component for inpatient adjudication information.
- **REMARK_CODE_2**: Remark code 2 for inpatient adjudication info.
- **REMARK_CODE_3**: Remark code 3 for inpatient adjudication info.
- **REMARK_CODE_4**: Remark code 4 for inpatient adjudication info.
- **REMARK_CODE_5**: Remark code 5 for inpatient adjudication info.
- **PPS_EXCEPTION_AMT**: Monetary amount for the prospective payment system's capital exception for inpatient adjudication information.

### CL_RMT_OPT_ADJ_INF
**Table**: This table contains outpatient adjudication information from the Image Database (IMD) master file.
- **IMAGE_ID**: This is the ID for the remittance image record with outpatient adjudication information.
- **REIMBURSEMENT_RATE**: The reimbursement rate percentage expressed as a decimal for outpatient adjudication info.
- **HCPCS_PAYABLE_AMT**: Monetary amount for the claim Healthcare Common Procedure Coding System (HCPCS) payable amount for outpatient adjudication info.
- **OUTPAT_REMARK_1**: Outpatient adjudication remark code 1.
- **OUTPAT_REMARK_2**: Outpatient adjudication remark code 2.
- **OUTPAT_REMARK_3**: Outpatient adjudication remark code 3.
- **OUTPAT_REMARK_4**: Outpatient adjudication remark code 4.
- **OUTPAT_REMARK_5**: Outpatient adjudication remark code 5.
- **CLAIM_ESRD_PAY_AMT**: End stage renal disease (ESRD) payment amount for outpatient adjudication info.
- **OUT_NONPAY_PRF_AMT**: Monetary amount for outpatient adjudication nonpayable professional component.

### CL_RMT_PRV_SUM_INF
**Table**: This table stores the provider summary information for a remittance image record.
- **IMAGE_ID**: This is the ID for the remittance image record with related remit claim references.
- **PROV_IDENTIFIER**: This is the provider number for the remittance record.
- **FACILITY_TYPE**: This is the code identifying the type of facility where services were provided for the claim reimbursed by the remittance record.
- **FP_DATE**: This is the last day of the provider�s fiscal year.
- **TOT_CLAIM_COUNT**: This is total number of claims.
- **TOT_CLAIM_AMT**: This is the total reported charges for all claims.
- **TOT_COV_AMT**: This is the monetary amount for the total covered charges. This is submitted charges less the non-covered charges.
- **TOT_NONCOV_AMT**: This is the amount for the total of non-covered charges.
- **TOT_DEN_AMT**: This is the monetary amount for the total of denied charges.
- **TOT_PROV_AMT**: This is the monetary amount for the total provider payment. The total provider payment amount includes the total of all interest paid. The amount can be less than zero.
- **TOT_INT_AMT**: This is the total amount of interest paid.
- **TOT_CONT_AMT**: This is the amount for the total contractual adjustment.
- **TOT_GRAM_AMT**: This is the amount for the total Gramm-Rudman adjustment.
- **TOT_MSP_AMT**: This is the total Medicare Secondary Payer (MSP) primary payor amount.
- **TOT_BLOOD_AMT**: This is the total blood deductible amount in dollars.
- **TOT_NONLAB_AMT**: This is the summary of non-lab charges.
- **TOT_COINS_AMT**: This is the total coinsurance amount.
- **HCPCS_AMT**: This is the Health Care Financing Administration Common Procedural Coding System (HCPCS) reported charges.
- **HCPCS_PAYABLE**: This is the total Health Care Financing Administration Common Procedural Coding System (HCPCS) payable amount.
- **TOTAL_DEDUCT_AMT**: This is the total deductible amount.
- **TOT_PROF_AMT**: This is the total professional component amount.
- **PAT_MSP_LIABILITY**: This is the total Medicare Secondary Payer (MSP) patient liability met.
- **PAT_REIMB_AMT**: This is the total patient reimbursement amount.
- **PIP_CLAIM_CNT**: This is the total periodic interim payment (PIP) number of claims.
- **PIP_ADJ_AMT**: This is the total periodic interim payment (PIP) adjustment.

### CL_RMT_PRV_SUP_INF
**Table**: This table contains the provider supplemental summary information for the remittance record.
- **IMAGE_ID**: This is the ID for the remittance image record with related remit claim references.
- **TOT_DRG_AMT**: This is the total diagnosis related group amount for the remittance record.
- **FED_AMT**: This is the total federal-specific amount for the remittance record.
- **HOSP_AMT**: This is the total hospital-specific amount for the remittance record.
- **DISP_SHARE_AMT**: This is the total disproportionate share amount for the remittance record.
- **TOT_CAP_AMT**: This is the total capital amount for the remittance record.
- **MED_EDU_AMT**: This is the total indirect medical education amount for the remittance record.
- **TOT_OUT_DAY_CNT**: This is the total number of outlier days for the remittance record.
- **DAY_OUT_AMT**: This is the total day outlier amount for the remittance record.
- **COST_OUT_AMT**: This is the total cost outlier amount for the remittance record.
- **AVG_DRG_LEN_STAY**: This is the diagnosis related group (DRG) average length of stay for the remittance record.
- **TOT_DISCHARGE_CNT**: This is the total number of discharges for the remittance record.
- **COST_REP_DAY_CNT**: This is the total number of cost report days for the remittance record.
- **CVRD_DAY_CNT**: This is the total number of covered days for the remittance record.
- **NONCVRD_DAY_CNT**: This is the total number of non-covered days for the remittance record.
- **MSP_PASS_THRU_AMT**: This is the total Medicare Secondary Payer (MSP) pass- through amount calculated for a non-Medicare payer for the remittance record.
- **AVG_DRG_WEIGHT**: This is the average diagnosis-related group (DRG) weight for the remittance record.
- **PPS_CAP_FSP_DRG_AM**: This is the total prospective payment system (PPS) capital, federal-specific portion, diagnosis-related group (DRG) amount for the remittance record.
- **PPS_CAP_HSP_DRG**: This is the total prospective payment system (PPS) capital, hospital-specific portion, diagnosis-related group (DRG) amount for the remittance record.
- **TOT_PPS_DSH_DRG_AM**: This is the total prospective payment system (PPS) disproportionate share, hospital diagnosis-related group (DRG) amount for the remittance record.

### CL_RMT_SVCE_LN_INF
**Table**: This table contains service line information from the remittance image.
- **IMAGE_ID**: This is the ID for the remittance image record with remittance service line information.
- **LINE**: The line number in the results of a query.  Each instance of service line information will have its own line.
- **SERVICE_LINE**: Service line information for claim remittance.
- **PROC_IDENTIFIER**: The composite medical procedure identifier to identify a medical procedure by its standardized codes for service line information.
- **LINE_ITEM_CHG_AMT**: Monetary amount for submitted service line item charge.
- **PROV_PAYMENT_AMT**: Monetary amount for the service line item provider payment amount.
- **NUBC_REV_CD**: National uniform billing committee revenue code for service line information.
- **UNITS_PAID_CNT**: Count of the Units of Service Paid for service line information.
- **SUBM_PROC_IDENT**: Submitted composite medical procedure identifier information if that was different from adjudicated procedure for service line information.
- **ORIG_UNITS_CNT**: Original units of service count for service line information.
- **SVC_LINE_CHG_PB_ID**: ID for professional billing service line charge.
- **SVC_LINE_CHG_HB_ID**: ID for hospital billing service line charge.

### CL_RMT_SVC_AMT_INF
**Table**: This table contains service line amount information for a remittance record.
- **IMAGE_ID**: This is the ID for the remittance image record with related remit claim references.
- **LINE**: The line number for the information associated with this record. Multiple pieces of information can be associated with this record. (Standard for this column type)
- **AMT_SVC_LN**: The service line which this amount information refers to.
- **SVC_AMT_QUAL_C_NAME**: The amount qualifier code for the claim supplemental information. This is a standard code that indicates what the monetary amount represents.
- **SVC_SUPPL_AMT**: Monetary amount for the supplemental claim information. The specific meaning of this amount is indicated by the associated amount qualifier code.

### CL_RMT_SVC_DAT_INF
**Table**: This table contains service date information for a service line in a remittance record.
- **IMAGE_ID**: This is the ID for the remittance image record.
- **LINE**: The line number in the results of a query.
- **SVC_DATE_QUAL_C_NAME**: This is the Code specifying type of service date.
- **SERVICE_DATE**: This is the service date.
- **SERVICE_LN**: This is the service line for which service date is specified

### CL_RMT_SVC_LVL_ADJ
**Table**: This table contains the claim adjustment (CAS) level information for a service line of a remittance record.
- **IMAGE_ID**: This is the ID for the remittance image record.
- **LINE**: The line number in the results of a query.
- **CAS_SERVICE_LINE**: This is the service line which this adjustment information refers.
- **SVC_CAS_GRP_CODE_C_NAME**: This is the Code identifying the general category of payment adjustment.
- **SVC_ADJ_REASON_CD**: This is the Code identifying the detailed reason the adjustment was made.
- **SVC_ADJ_AMT**: This is the amount of the adjustment.
- **SVC_ADJ_QTY**: This is the units of service being adjusted.

### CL_RMT_SVC_LVL_REF
**Table**: This table contains information relating to the Administrative Reference Number (REF) segment on the service line level.
- **IMAGE_ID**: This is the ID for the remittance image record with related remit claim references.
- **LINE**: The line number in the results of a query.  Each instance of claim remit information will have its own line.
- **REF_SVC_LN**: This is the service line for reference segment.
- **SVC_REF_ID_QUAL_C_NAME**: This is the service line level reference segment ID qualifier.
- **SVC_REF_IDENTIFIER**: This is the service line level reference segment Identifier.

### CODE_INT_COMB_LN
**Table**: This table holds the combined service lines created by code integration.
- **HSP_ACCOUNT_ID**: The unique identifier (.1 item) for the hosp acct record.
- **LINE**: The line number for the information associated with this record. Multiple pieces of information can be associated with this record.
- **CODE_INT_REV_CODE_ID**: This column stores the unique identifier for the revenue code for the combined service line.
- **CODE_INT_REV_CODE_ID_REVENUE_CODE_NAME**: The name of the revenue code.
- **CODE_INT_CPT**: This item holds the CPT(R)/HCPCS code for the combined service line.
- **CODE_INT_MOD_1_ID**: This column stores the unique identifier for the first modifier for the combined service line.
- **CODE_INT_MOD_1_ID_MODIFIER_NAME**: The name of the modifier record.
- **CODE_INT_MOD_2_ID**: This column stores the unique identifier for the second modifier for the combined service line.
- **CODE_INT_MOD_2_ID_MODIFIER_NAME**: The name of the modifier record.
- **CODE_INT_MOD_3_ID**: This column stores the unique identifier for the third modifier for the combined service line.
- **CODE_INT_MOD_3_ID_MODIFIER_NAME**: The name of the modifier record.
- **CODE_INT_MOD_4_ID**: This column stores the unique identifier for the fourth modifier for the combined service line.
- **CODE_INT_MOD_4_ID_MODIFIER_NAME**: The name of the modifier record.
- **CODE_INT_RATE**: This item holds the daily rate for the combined service line. The rate is only set for accommodation (room charge) revenue codes.
- **CODE_INT_DATE**: This item holds the service date for the combined service line.
- **CODE_INT_QTY**: This item holds the quantity (number of units) for the combined service line.
- **CODE_INT_AMT**: This item holds the full charge amount for the combined service line. The value includes any non-covered amount for the line.
- **CODE_INT_NONCVRD**: This item holds the non-covered amount for the combined service line.
- **CODE_INT_LN_SRC_C_NAME**: This item holds the source for the CPT(R)/HCPCS code and modifiers for the combined service line.
- **CODE_INT_UNUSED_YN**: This item identifies lines that are not true service lines but represent coded CPT(R)/HCPCS codes that cannot be used to create actual service lines.
- **CODE_INT_CHRG_CNT**: This item holds the number of charges associated with the combined service line.
- **CODE_INT_RSN_C_NAME**: This item identifies the reason the coded CPT(R)/HCPCS code could not be used in an actual service line.  This item is only set when the unused coded CPT(R)/HCPCS flag (CODE_INT_UNUSED_YN) is Yes.

### COVERAGE
**Table**: The COVERAGE table contains high-level information on both managed care and indemnity coverage records in your system.
- **COVERAGE_ID**: The unique ID assigned to the coverage record. This ID may be encrypted if you have elected to use enterprise reporting�s encryption utility.
- **COVERAGE_TYPE_C_NAME**: The category value that indicates whether a coverage is managed care or indemnity; 1 � Indemnity, 2 � Managed Care.
- **PAYOR_ID**: This column is only populated for indemnity coverages (COVERAGE_TYPE_C equal to 1). This column stores the unique identifier of the payor associated with the coverage record.  To look up the payor for managed care coverages (COVERAGE_TYPE_C equal to 2), join COVERAGE.COVERAGE_ID on V_COVERAGE_PAYOR_PLAN.COVERAGE_ID and filter on V_COVERAGE_PAYOR_PLAN.EFF_DATE and V_COVERAGE_PAYOR_PLAN.TERM_DATE to find the relevant PAYOR_ID.
- **PLAN_ID**: This column is only populated for indemnity coverages (COVERAGE_TYPE_C equal to 1). This column stores the unique identifier of the benefit plan associated with the coverage record.  To look up the benefit plan for managed care coverages (COVERAGE_TYPE_C equal to 2), join COVERAGE.COVERAGE_ID on V_COVERAGE_PAYOR_PLAN.COVERAGE_ID and filter on V_COVERAGE_PAYOR_PLAN.EFF_DATE and V_COVERAGE_PAYOR_PLAN.TERM_DATE to find the relevant BENEFIT_PLAN_ID.
- **PLAN_GRP_ID**: The ID of the employer group that determines the benefits in a managed care coverage. This item is NULL for indemnity coverages.
- **PLAN_GRP_ID_PLAN_GRP_NAME**: The name of the employer group record
- **COBRA_STATUS_YN**: This yes/no flag is set to �Y� if the coverage has been extended beyond termination of the subscriber�s employment according to a COBRA arrangement. If the coverage has not been extended under such an arrangement, this value is �N� or null.
- **COBRA_DATE**: The termination date for any COBRA arrangement.
- **LATE_ENROLL_YN**: Y if the subscriber applied for coverage outside of the open enrollment period. N or NULL if not specified as a late enrollment coverage.
- **STUDENT_REVIEW_DT**: The date on which you should review the status of any members on this coverage who are students.
- **EPIC_CVG_ID**: The unique ID of the coverage record. This column may be hidden if you have elected to use enterprise reporting�s security utility.
- **PB_ACCT_ID**: The unique ID of premium billing account associated with the coverage.
- **CVG_EFF_DT**: The effective date of the coverage.
- **CVG_TERM_DT**: The termination date of the coverage.
- **CASEHEAD_NUMBER**: The Medicaid ID number on the case head.
- **CASEHEAD_NAME**: The Medicaid name on the case head.
- **TNSFRD_COVERAGE_ID**: The ID of the coverage from which this coverage is transferred from.
- **CVG_REG_STATUS_C_NAME**: The verification status of the coverage, such as verified, changed, elapsed, etc.
- **VERIFY_USER_ID**: The ID of the user who performed the verification.
- **VERIFY_USER_ID_NAME**: The name of the user record. This name may be hidden.
- **GROUP_NAME**: The name of the coverage group.
- **CVG_ADDR1**: The first line of the address of the coverage (administrative offices).
- **CVG_ADDR2**: The second line of the address of the coverage (administrative offices).
- **CVG_CITY**: The city of the mailing address of the coverage (administrative offices).
- **CVG_ZIP**: The zip code of the mailing address of the coverage (administrative offices).
- **CVG_PHONE1**: The primary phone number of the coverage (administrative offices).
- **GROUP_NUM**: The identification number assigned to this subscriber's employer/plan group by the payor.  This number will appear in box 11 of the HCFA claim form.
- **CLAIM_MAIL_CODE_C_NAME**: The category value associated with where to send the claim on a coverage (i.e. send claim to payor, send claim to account, etc.)
- **WC_EMPLOYER_ID**: Workers' compensation employer at the time of injury.
- **WC_EMPLOYER_ID_EMPLOYER_NAME**: The name of the employer.
- **WC_DATE_OF_INJURY**: Workers Comp date of injury. This is the date the injury occurred on the job. This field is populated as the user sets up the WC account.
- **IS_SIG_ON_FILE_YN**: Appears in Box 12 of HCFA claims. This is a Yes/No field that denotes whether authorization has been obtained to send bill or other documentation to payor for services relating to the claim.
- **ENROLL_REASON_C_NAME**: This category value stores the enrollment reason of the coverage.
- **CVG_TERM_REASON_C_NAME**: This category value stores the termination reason of the coverage.
- **PAT_REC_OF_SUBS_ID**: If the subscriber is the same person as a patient, this item contains the patient ID.
- **ECD_TABLE_DEF_COPAY**: Numeric default copay value.
- **COINSURANCE_OVR**: Numeric Value for the coverage level coinsurance override.
- **MEDC_COVERED_LEFT**: This is the number of Medicare Covered Days Remaining
- **MEDC_COINS_LEFT**: This is the number of Medicare Coinsurance Days Remaining
- **MEDC_RESERVE_LEFT**: This is the number of Medicare Reserved Days Remaining
- **CCS_PAT_ID**: The patient's Comprehensive Community Services (CCS) ID.
- **CCS_DX**: Stores the diagnosis that makes the patient eligible for Comprehensive Community Services (CCS) coverage.
- **CCS_CC_NAME**: Stores the name of the Comprehensive Community Services (CCS) Case Coordinator.
- **CCS_COOR_PHONE**: Stores the phone number for the Comprehensive Community Services (CCS) Case Coordinator.
- **CCS_COUNTY_PHONE**: Stores the phone number for the Comprehensive Community Services (CCS) County Office.
- **CVG_COUNTY_C_NAME**: The county of the mailing address of the coverage (administrative offices).
- **CVG_COUNTRY_C_NAME**: The country of the mailing address of the coverage (administrative offices).
- **CVG_HOUSE_NUM**: The house number of the mailing address of the coverage (administrative offices).
- **CVG_DISTRICT_C_NAME**: The district of the mailing address of the coverage (administrative offices).
- **EFF_HOSP_CVG_DT**: The effective date of Medicare Part A.
- **EFF_PROV_CVG_DT**: The effective date of Medicare Part B.
- **MEDICARE_CVG_TYPE_C_NAME**: The category number for the type of Medicare coverage the patient has.
- **Q4CO_BUCKETS_EXC_YN**: Flag to indicate if bucket limits exceeded during carryover
- **MED_SEC_TYPE_C_NAME**: Medicare Secondary Insurance Type Code.
- **CHDP_COUNTY_C_NAME**: The Child Health and Disability Prevention County Code.
- **CHDP_AID_CODE**: The Child Health and Disability Prevention Aid Code.
- **CVG_CARD_ISSUE_DT**: Stores the card issue date.
- **CVG_DEDUCTIBLE_YN**: This item will serve as a flag to let the end user know if the response has any deductible information
- **FIRST_SPEC_AID_CODE**: First special aid code for the Treatment Authorization Request (TAR) for Medi-Cal.
- **SEC_SPEC_AID_CODE**: Second special aid code for the Treatment Authorization Request (TAR) for Medi-Cal.
- **THRD_SPEC_AID_CODE**: Third special aid code for the Treatment Authorization Request (TAR) for Medi-Cal.
- **EVC_NUM**: Eligibility Verification Confirmation (EVC) that is used on the Treatment Authorization Request (TAR) for Medi-Cal.
- **COUNTY_CODE_C_NAME**: This item will store the county code that is returned from the 271 message.
- **EXT_ROUTING_NUM_C_NAME**: The external routing number for the coverage
- **SUBSCR_OR_SELF_MEM_PAT_ID**: This item contains the subscriber patient Id of a coverage and will be used to associate patients with linked premium billing accounts for EHI.

### COVERAGE_2
**Table**: The COVERAGE_2 table contains high-level information on both managed care and indemnity coverage records in your system.
- **CVG_ID**: The unique identifier for the coverage record.
- **STATUS_C_NAME**: The category number of the status for this coverage record.
- **IS_DEDUCT_MET_C_NAME**: Indicates whether the deductible has been met for this coverage. The deductible can be established on the guarantor account or patient level.
- **IS_ASGN_CVG_C_NAME**: Indicated whether the provider's assignment status is set to Coverage Assignment for this coverage's payor.
- **SIG_ON_FILE_DATE**: The date when the signature was filed.
- **SIG_ON_FILE_LOC**: The location at which the signature was filed.
- **MEDIGAP_AUTH_YN**: Indicates whether the payor for this coverage has Medigap authorization.
- **TPL_RESOURCE_CODE**: This column lists the Third Party Liability resource code for a specific plan. This code is either returned in the real-time eligibility response or found on the patient's insurance card.
- **THIRD_PARTY_LIAB_YN**: Indicates if there is third-party liability for this coverage.
- **BENEFIT_CODE**: The benefit code for this coverage. This can contain any facility-specific benefit code.
- **SCHEDULED_DISCON_DT**: The date when the coverage is scheduled to be discontinued.
- **SCHEDULED_ACTV_DT**: The date when the coverage is scheduled to be activated.
- **YR_ALLOW_DOL_TOT**: The yearly dollar limit for payments against this coverage's payor.
- **YR_ALLOW_DOL_USE**: The year-to-date payments made against the coverage's payor.
- **ORG_FOR_CLM_SUBMIT**: The title or name of the organization to which submitted claims under this coverage will be sent.
- **FINANCIAL_CLASS_C_NAME**: The financial class for this coverage. This is only used for CMS claims forms and may not be reliably populated for reporting.  Reporting should done using the financial class of the payor specified in this coverage.
- **COVERAGE_FAX**: The fax number for this coverage.
- **FREE_TXT_PLAN_NAME**: The free-text plan name for this coverage.
- **FREE_TXT_PAYOR_NAME**: The free-text payor name for this coverage.
- **PLAN_FREE_TEXT**: The format of the coverage's free-text plan.
- **TEFRA_PAT_YN**: Indicates whether the patient is TEFRA. A patient is TEFRA if an eligible Medicare beneficiary is covered by a group health plan.
- **ADMISSION_SRC_C_NAME**: The category number of the admission source.
- **ENROLL_CODE_FBC**: The Federal Employment Program enrollment code.
- **GRP_NUMBER**: The group number for the coverage.
- **HMO_SITE_NUM**: The site number for the coverage's HMO.
- **HMO_SITE_PHONE**: The phone number for the coverage's HMO.
- **COPAY_AMOUNT**: The copay amount for the coverage.
- **CHAMP_SPON_STATUS_C_NAME**: The CHAMPUS/Tricare sponsor's military status, obtained from the military identification card.
- **SERVICE_BRANCH**: The military service branch for a CHAMPUS/Tricare coverage subscriber.
- **CHAMP_SPON_BRANCH_C_NAME**: A CHAMPUS/Tricare coverage sponsor's military service branch.
- **CHAMP_SPON_GRADE_C_NAME**: A CHAMPUS/Tricare coverage sponsor's military pay grade.
- **MCARE_OTHER_INS_CO**: An additional insurance company providing coverage for a Medicare patient.
- **MCARE_REC_DIS_YN**: Indicates if a Medicare patient is receiving disability benefit.
- **DIS_CVD_BY_EMP_YN**: Indicates if a Medicare patient is receiving disability coverage from their employer.
- **MCARE_100_EMP_YN**: Indicates if a Medicare employer has over 100 employees.
- **MCARE_AUTO_YN**: Indicates if the illness or injury for this visit is due to an automobile accident.
- **MCARE_LIAB_YN**: Indicates if the illness or injury for this visit is due to a liability accident.
- **MCARE_WK_COMP_YN**: Indicates if a Medicare visit is covered by Workman's Compensation.
- **MCARE_NON_AUTO_YN**: Indicates if the patient's visit is due to an accident not involving automobiles.
- **MCARE_BLACK_LUNG_YN**: Indicates whether the illness is covered by the Black Lung program.
- **MCARE_VA_YN**: Indicates if the illness is covered by a Veterans' Administration program.
- **MCARE_PARENT_EMP_YN**: Indicates whether the patient's parents or guardians are employed.
- **MCARE_CVD_GD_YN**: For large group health plans, indicates if the patient is covered by their parent or guardian.
- **MCARE_GD_EMP_100_YN**: Indicates whether the employer of this patient's parent or guardian employs over 100 people.
- **IS_MCARE_VET_ADMN_C_NAME**: Indicates whether this coverage is for a Veterans' Administration program.
- **MCARE_EMPLOYED_YN**: Indicates whether the Medicare patient is employed.
- **MCARE_ENRL_HMO_YN**: Indicates if the Medicare patient is enrolled in an HMO.
- **MCARE_CVD_EGHP_YN**: Indicates whether the patient is covered by an employer group health plan.
- **MCARE_EMP_20_YN**: Indicates whether the Medicare patient is employed by an employer with over 20 employees.
- **MCARE_REN_DIAL_YN**: Indicates whether the patient is a renal dialysis patient in the first 12 months of entitlement.
- **IS_MCARE_RENAL_DI_C_NAME**: Indicates whether the patient is a renal dialysis patient.
- **MCARE_1ST_18MO_YN**: Indicates whether the patient is in the first 18 months of entitlement for renal dialysis.
- **MCARE_HOME_DIAL_YN**: Indicates whether the patient is a home dialysis patient.
- **MCARE_SELF_EPO_YN**: Indicates whether this patient self-administers EPO.
- **MCARE_DISABLE_YN**: Indicates whether a patient's Medicare coverage is due to disability.
- **MCARE_SPSE_RET_YN**: Indicates whether a Medicare patient's spouse is retired.
- **MCARE_SPOUSE_RET_DT**: The date when a Medicare patient's spouse retired.
- **MCARE_EMPR_INS_YN**: Indicates whether a Medicare patient is insured by their employer.
- **MCARE_RETIRE_YN**: Indicates whether a Medicare patient is retired.
- **MCARE_RETIRE_DATE**: The date when a Medicare patient retired.
- **MCARE_FAM_EMPY_YN**: Indicates whether a Medicare patient's spouse or another family member is employed.
- **MCARE_OTHR_CVG_YN**: Indicates whether a Medicare patient is covered because of their spouse or other family member.
- **MCARE_SPC_EMP_YN**: Indicates whether a Medicare patient's spouse is employed.
- **MCARE_CVG_FRM_SP_YN**: Indicates whether a Medicare patient is covered through their spouse's employer group health plan.
- **VERIF_EVS_YN**: Indicates if verification is done through Eligibility Verification Systems (EVS).
- **EVS_VERIF_DATE**: The date when eligibility was verified with Eligibility Verification Systems (EVS).
- **PAYOR_NAME**: The coverage payor's name.
- **PAYOR_CITY**: The coverage payor's city.
- **EXT_CVG_SRC_ORGANIZATION_ID**: The Organization (DXO) that provided the information for this coverage.
- **EXT_CVG_SRC_ORGANIZATION_ID_EXTERNAL_NAME**: Organization's external name used as the display name on forms and user interfaces.
- **EXT_CVG_FHIR_IDENT**: The FHIR Id of a coverage record on an external system that was used to  create this coverage.
- **EXT_CVG_OID**: The OID of a coverage record on an external system that was used to create  this coverage.
- **EXT_PAYER_NAME**: Payer name received for a coverage from an external payer system.
- **EXT_PLAN_NAME**: Plan name received for a coverage from an external payer system.

### COVERAGE_3
**Table**: The COVERAGE_3 table contains high-level information on both managed care and indemnity coverage records in your system.
- **CVG_ID**: The unique identifier for the coverage record.
- **PAYOR_STATE_C_NAME**: The state of the coverage payer.
- **PAYOR_ZIP**: The ZIP code of the coverage payer.
- **PAYOR_PHONE**: The phone number of the coverage payer.
- **PAYOR_CLAIM_OFC_NUM**: The claim office number of the coverage payer.
- **REF_PROV_NAME_ID**: The name of the Health Maintenance Organization's referring physician.
- **REF_PROV_NAME_ID_REFERRING_PROV_NAM**: The name of the referral source.
- **REF_PROV_CITY**: The city of the Health Maintenance Organization's referring physician.
- **REF_PROV_ZIP**: The ZIP code of the Health Maintenance Organization's referring physician.
- **AUTH_NUM**: The authorization number for this coverage.
- **AUTHORIZATION_DTTM**: The authorization date and time for this coverage.
- **AUTH_PERSON**: The name of the person who authorized services for this coverage.
- **VERIF_DATETIME**: The date and time when authorization was obtained.
- **MED_ASSIST_CARD**: The medical assistance card number.
- **MED_ASSIST_CODE_C_NAME**: The medical assistance code.
- **MED_ASSIST_STATUS**: The medical assistance status.
- **MED_ASSIST_COV_CODE**: The medical assistance coverage code.
- **IS_CVG_VA_PROG_YN_NAME**: Indicates if the coverage is for a Veterans' Administration program.
- **IS_MC_PROGRAM_YN**: Indicates whether the coverage is for a managed care program.
- **MC_PRIM_PROV**: The primary provider for a managed care coverage.
- **MC_AUTH_NUM**: The authorization number for a managed care coverage.
- **MC_AUTH_PHONE_NUM**: The authorization phone number for a managed care coverage.
- **TYPE_OF_COVERAGE_C_NAME**: The type of coverage.
- **ALSO_HAS_MCARE_YN**: Indicates whether the coverage subscriber also has Medicare.
- **MAJOR_MEDICAL_C_NAME**: Indicates whether the patient has Major Medical coverage.
- **MCAID_GRP_NO_SUF_C_NAME**: The two letters at the end of the recipient number on the Medicaid card.
- **CHAMPUS_RANK**: The CHAMPUS/Tricare rank.
- **CHAMPUS_GRADE**: The CHAMPUS/Tricare grade.
- **BC_BS_CNTRCT_ACCT_C_NAME**: The contract account name on a Blue Cross/Blue Shield insurance card.
- **MAC_PROV_PHONE_NUM**: The phone number for the primary provider.
- **MAC_AUTH_CNCT_PRSN**: The person who provided authorization information for this visit.
- **MAC_COMMENT**: Comments regarding authorization or denial.
- **MAC_PMP_AUTH_C_NAME**: The authorization for this visit.
- **MCARE_RR_SUB_NO_P_C_NAME**: The subscriber number for this managed care coverage.
- **RECIPROCITY_NO**: The reciprocity number for this coverage.
- **MAC_AUTH_ENT_PRSN**: The person who entered the authorization number for this managed care coverage.
- **THERAPY_TYPE_C_NAME**: The therapy type for this coverage.
- **THERAPY_PLAN_DATE**: The date when the therapy plan was established.
- **THERAPY_START_DT**: The date when the therapy started.
- **LAST_MENSTRUAL_DATE**: The patient's last menstrual date.
- **AUTH_VALID_FROM_DT**: The date when the authorization became valid.
- **AUTH_VALID_TO_DATE**: The date when the authorization became invalid.
- **COMMERCIAL_AUTH_NUM**: The commercial authorization number.
- **COMM_AUTH_PRSN**: The person who authorized the commercial coverage.
- **MC_COBRA_STATUS_YN**: Indicated whether a managed care coverage has Consolidated Omnibus Budget Reconciliation Act status.
- **MC_COBRA_DATE**: The date when a managed care coverage received Consolidated Omnibus Budget Reconciliation Act status.
- **PB_ACCT_CREATED_YN**: Indicates whether a premium billing account was created for this coverage.
- **ALTR_CVG_ATTN**: The alternate name of the organization to which claims submitted under this coverage can be sent.
- **ALTR_CITY**: The alternate city to which claims under this coverage can be sent.
- **ALTR_STATE_C_NAME**: The alternate state to which claims submitted under this coverage can be sent.
- **ENROLL_REASON_REG_C_NAME**: The enrollment reason category number for this subscriber with this particular payer or plan.
- **EXT_UPD_TYPE_C_NAME**: This item stores what kind of change was requested by the external user.
- **EXT_UPDATE_COMMENT**: This item stores the comment that accompanies the external update request.
- **ENROLL_RECV_DATE**: The enrollment received date for this coverage.
- **PRIOR_LIS_DATE**: The most recent LIS period date.
- **ALT_TRANSPLANT_PAYER_OPT_C_NAME**: Use this item in conjunction with Alternate Payer configuration in the Plan record to help automate claims processing to alternate transplant payers when the relationship between Primary Plan and Alternate Payer/Plan is not 1:1.
- **PB_PAID_THROUGH_DATE**: The date at which the coverage's premium has been fully paid through.

### DOCS_FOR_HOSP_ACCT
**Table**: This table links the hospital account to the document (DCS) records relevant to the encounters associated with the hospital account.
- **ACCT_ID**: The unique ID of the hospital account (HAR) record for this row.
- **LINE**: The line number for the information associated with this record. Multiple pieces of information can be associated with this record.
- **LINKED_DCS_ID**: Document (DCS) record ID of the document(s) attached to the hospital account.

### GUAR_ACCT_STMT_HX
**Table**: This table contains statement history information for the guarantor account.
- **ACCOUNT_ID**: The unique identifier for the account record.
- **LINE**: The line number for the information associated with this record. Multiple pieces of information can be associated with this record.
- **STMT_HX_STMT_DATE**: The date on which statement was generated.
- **STMT_HX_INVOICE_NUM**: The invoice number of the invoice that was sent to the guarantor on this date.
- **STMT_HX_NEW_CHARGE**: The original amount of all new charges on this invoice. New charges are those that were not on the last invoice sent.
- **STMT_HX_NEW_BALANCE**: The new balance on the statement.
- **STMT_HX_TTL_PMT**: Total payment amount on the statement.
- **STMT_HX_TTL_DB_ADJ**: Total debit adjustment amount on the statement.
- **STMT_HX_TTL_CR_ADJ**: Total credit adjustment amount on the statement.
- **STMT_HX_TTL_AMT_HLD**: Total amount held on the statement.
- **STMT_HX_TTL_AMT_VD**: Total amount voided since last statement.
- **STMT_HX_DVRY_MTHD_C_NAME**: The statement delivery method category ID for the guarantor.
- **STMT_HX_LST_VW_DTTM**: Last date/time when the statement was most recently access from MyChart.
- **STMT_HX_1ST_VW_DTTM**: The date/time when the statement was first accessed from MyChart.
- **STMT_HX_WHY_2_PR_C_NAME**: Reason type why the paperless statement is forced to paper statement.

### GUAR_ADDR_HX
**Table**: This table holds the Accounts Receivable (EAR) related group 5000 pertaining to Guarantor Address Change History.
- **ACCOUNT_ID**: The unique identifier for the account record.
- **LINE**: The line number for the information associated with this record. Multiple pieces of information can be associated with this record.
- **ADDR_CHANGE_DATE**: This column specifies the date on which the address change described on the rest of the row was performed.
- **ADDR_HX_1**: This column contains the first line of a previous guarantor address.
- **ADDR_HX_2**: This column contains the second line of a previous guarantor address.
- **ADDR_HX_EXTRA**: This contains any additional lines for a previous guarantor address.
- **CITY_HX**: This column contains the city for a previous address for this guarantor.
- **STATE_HX_C_NAME**: This column contains the state for a previous address for this guarantor.
- **ZIP_HX**: This column contains the ZIP code for a previous address for this guarantor.
- **ADDR_CHANGE_SRC_C_NAME**: This column contains the context from which the address change was performed.

### GUAR_PMT_SCORE_PB_HX
**Table**: This table stores PB Guarantor Payment Score history items.
- **ACCOUNT_ID**: The unique identifier for the account record.
- **LINE**: The line number for the information associated with this record. Multiple pieces of information can be associated with this record.
- **SCORE_DATE**: This history item will store the date that the score was calculated.
- **SCORE**: This history item will store self-pay score.

### HAR_ALL
**Table**: Generic table that contains every hospital account record regardless of its type. It also contains the patient record that is associated with the hospital account.
- **ACCT_ID**: This column stores the unique identifier for the hospital account.
- **PAT_ID**: This column stores the unique identifier for the patient associated with this hospital account.
- **PRIM_ENC_CSN_ID**: The contact serial number associated with the primary patient contact.

### HSP_ACCOUNT
**Table**: This table contains hospital account information from the Hospital Account (HAR) and Claim (CLM) master files. It will exclude professional billing hospital accounts created by visit filing order in non-single billing office service areas.
- **HSP_ACCOUNT_ID**: This column stores the unique identifier for the hospital account.
- **HSP_ACCOUNT_NAME**: The name of the patient associated with the hospital account.
- **ACCT_CLASS_HA_C_NAME**: The hospital account's account class.
- **ACCT_FIN_CLASS_C_NAME**: The hospital account's financial class.
- **ACCT_SLFPYST_HA_C_NAME**: The hospital account's self-pay status.
- **ACCT_BILLSTS_HA_C_NAME**: This column stores the status of the hospital account. If this is a professional billing default hospital account, this column always returns 4 (Billed).
- **ACCT_ZERO_BAL_DT**: This column stores the date the hospital account went to a zero balance. This may be empty for older accounts, as Zero Balance Date (I HAR 244) had not always been available.
- **ADM_DATE_TIME**: This column stores the admission date and time associated with the hospital account. The admission date and time (I HAR 400/405) are first pulled from the coding information on the hospital account. If this data is not stored on the hospital account yet, then this will pull the data from the primary patient encounter for the hospital account. Depending on a hospital billing system definition setting, this will pull either the admission date and time (I EPT 18850/18851) or the arrival date and time (I EPT 10820/10815). If the arrival date and time is not available than the admission date and time will be used.
- **ADM_DEPARMENT_ID**: The department of the account's admission event.
- **ADM_LOC_ID**: The location of the account's admission event.
- **ADM_PRIORITY**: The admission priority stored in the hospital account.
- **ADM_PROV_ID**: This column stores the unique identifier for the admitting provider stored on the hospital account.
- **ATTENDING_PROV_ID**: This column stores the unique identifier for the attending provider stored on the hospital account. See column PROV_ID in table HSP_ATND_PROV if coding has not been performed on this hospital account. Alternatively, see V_ARHB_HSP_ACCOUNT_ADDL_INFO for the calculated value for this column based on both hospital account and encounter data. This view should be used to maintain backwards compatibility with reports created before upgrading to the Summer 2009 release.
- **AUTOPSY_DONE_YN**: Denotes whether an autopsy was performed.
- **BAD_DEBT_AGENCY_ID**: This column stores the unique identifier for the collection agency that was selected when the hospital account was sent to bad debt, sent to external agency A/R, outsourced, or pre-collected. This is cleared when the account returns from bad debt, returns from external agency A/R, or is no longer outsourced.
- **BAD_DEBT_AGENCY_ID_COLL_AGENCY_NAME**: The name of the collection agency.
- **BAD_DEBT_BUCKET_ID**: This column stores the unique identifier for the bad debt bucket that was created when the hospital account was sent to bad debt.
- **CODE_BLUE_YNU**: Denotes whether the patient associated with the hospital account was code blue.
- **COMBINE_ACCT_ID**: This column stores the unique identifier for the target hospital account into which this hospital account was combined.
- **COMBINE_DATE_TIME**: The date and time that this hospital account was combined with another one.
- **COMBINE_USER_ID**: This column stores the unique identifier for the user who combined this hospital account with another one.
- **COMBINE_USER_ID_NAME**: The name of the user record. This name may be hidden.
- **COMPLETION_DT_TM**: The date and time when abstracting was completed for the hospital account.
- **CVG_LIST_SELECT_YN**: Denotes whether coverages have been put on the hospital account.
- **DISCH_DATE_TIME**: This column stores the discharge date and time associated with the hospital account. The discharge date and time (I HAR 425/430) are first pulled from the coding information on the hospital account. If this data is not stored on the hospital account yet, then this will pull the discharge date and time (I EPT 18855/18856) that is stored on the primary patient encounter for the hospital account.
- **DISCH_DEPT_ID**: This column stores the unique identifier for the discharge department on the hospital account.
- **DISCH_DESTIN_HA_C_NAME**: This column stores the discharge destination stored in the hospital account. This item is copied from the patient's ADT event record.
- **DISCH_LOC_ID**: The discharge location stored in the hospital account.
- **DISCH_TO**: A discharge destination stored in the hospital account for coding and/or abstracting purposes. This is manually entered into the hospital account.
- **DRG_EXPECTED_REIMB**: This column stores the diagnosis-related group (DRG)-based expected reimbursement amount stored in the hospital account.
- **ER_ADMIT_DATE_TIME**: The emergency room admission date and time stored in the hospital account.
- **ER_DSCHG_DATE_TIME**: The emergency room discharge date and time stored in the hospital account.
- **ER_PAT_STS_HA_C_NAME**: The emergency room patient status stored in the hospital account.
- **EXPIRATION_UNIT_ID**: The expiration unit stored in the hospital account.
- **FINAL_DRG_ID**: The final coded DRG stored in the hospital account.
- **FINAL_DRG_ID_DRG_NAME**: The name of the Diagnoses Related Group name.
- **FRST_DMND_STMT_DT**: The date that the first demand statement was sent for the hospital account.
- **FRST_STMT_DATE**: The date that the first statement (non-demand) was sent for the hospital account.  If you are sending informational or prorated statements this date will store the date the first informational, prorated, or full statement was sent.
- **GUAR_ADDR_1**: The first line of the street address of the guarantor for the hospital account at time of discharge.
- **GUAR_ADDR_2**: The second line of the street address of the guarantor for the hospital account at time of discharge.
- **GUAR_NAME**: The name of the guarantor for the hospital account at time of discharge.
- **GUAR_WK_PHONE**: The work phone number of the guarantor for the hospital account at time of discharge.
- **GUAR_ZIP**: The ZIP Code of the guarantor for the hospital account at time of discharge.
- **IS_CALLED_911_YNU**: Denotes whether 911 was called.
- **IS_INSTI_YN**: Denotes whether the hospital account is designated as an institutional account. A hospital account is considered institutional if its guarantor is of a type designated as institutional in the system definition profile.
- **LAST_DMND_STMT_DT**: The last date that a demand statement was sent for the hospital account.
- **LAST_INTRM_BILL_DT**: The last date that interim billing was performed for the hospital account.
- **MEANS_OF_ARRV_C_NAME**: The patient's means of arrival stored in the hospital account.
- **NUM_OF_DET_BILLS**: The number of detail bills that have been sent for the hospital account.
- **NUM_OF_DMND_STMTS**: The number of demand statements that have been sent for the hospital account.
- **NUM_OF_STMTS_SENT**: The number of statements (non-demand) that have been sent for the hospital account.
- **PAT_CITY**: The city portion of the address of the patient for the hospital account at time of discharge.
- **PAT_DOB**: The date of birth of the patient for the hospital account at time of discharge.
- **PAT_HOME_PHONE**: The home phone number of the patient for the hospital account at time of discharge.
- **PAT_SSN**: The social security number of the patient for the hospital account at time of discharge.
- **PAT_WRK_PHN**: The work phone number of the patient for the hospital account at time of discharge.
- **PAT_ZIP**: The ZIP Code of the patient for the hospital account at time of discharge.
- **POLICE_INVOLVD_YNU**: Denotes whether the police were involved in the circumstances of the patient's hospital stay.
- **POST_ADM_EXP_HA_C_NAME**: Denotes whether the patient expired after admission.
- **POST_OP_EXP_HA_C_NAME**: Denotes whether the patient expired after an operation.
- **PREBILL_BUCKET_ID**: This column stores the unique identifier for the hospital account's prebilled bucket.
- **PRIM_SVC_HA_C_NAME**: The primary service stored in the hospital account for the patient's hospital stay.
- **PSYCH_CASE_YNU**: Denotes whether the patient is classified as a psychiatric case.
- **REHAB_INDICATOR**: Denotes whether the patient was undergoing rehab.
- **SCNDRY_SVC_HA_C_NAME**: The secondary service stored in the hospital account for the patient's hospital stay.
- **SELF_PAY_BUCKET_ID**: This column stores the unique identifier for the hospital account's self-pay bucket.
- **SERV_AREA_ID**: This column stores the unique identifier for the service area stored on the hospital account.
- **TOT_ADJ**: The total of all adjustments on the hospital account.
- **TOT_CHGS**: The total of all charges on the hospital account.
- **TRANSFER_FROM**: Denotes where the patient was transferred from.
- **TREATMENT_AUTH_NUM**: Note: This column will be deprecated in a future release. Please start referring to the column HSP_ACCT_CLAIM_HAR.AUTHORIZATION_NUM in your reports. Authorization Number: Used on claims for identifying patient referrals and affected reimbursements. Refer to CLAIM_INFO2 table if not set on the hospital account.
- **UB92_COINS_DAYS**: The number of coinsurance days that were listed on a UB92 claim for the hospital account. This is a user-entered value that overrides the value calculated by the system. Refer to AP_CLAIM table if not set on the hospital account.
- **UB92_COVERED_DAYS**: The number of covered days that were listed on a UB92 claim for the hospital account. This is a user-entered value that overrides the value calculated by the system. Refer to AP_CLAIM table if not set on the hospital account.
- **UB92_LIFETIME_DAYS**: The number of lifetime reserve days that were listed on a UB92 claim for the hospital account. Refer to AP_CLAIM table if not set on the hospital account.
- **UB92_NONCOVRD_DAYS**: The number of noncovered days that were listed on a UB92 claim for the hospital account. This is a user-entered value that overrides the value calculated by the system. Refer to AP_CLAIM table if not set on the hospital account.
- **UB92_TOB_OVERRIDE**: Note: This column will be deprecated in a future release. Please start referring to the column HSP_ACCT_CLAIM_HAR.UB92_TOB_OVERRIDE in your reports. Type of Bill (TOB) override: TOB is a numeric code printed on claims that provide encounter information to a payer. Values entered here will override system settings that normally determine the Type of Bill. Refer to CLAIM_INFO2 table if not set on the hospital account.
- **UNDISTRB_BUCKET_ID**: This column stores the unique identifier for a hospital account's undistributed bucket.
- **PATIENT_STATUS_C_NAME**: The patient status (discharge disposition) category ID for the hospital account.
- **ADMISSION_SOURCE_C_NAME**: The point of origin category ID (admission source) for the hospital account.
- **ADMISSION_TYPE_C_NAME**: The admission type category ID for the hospital account.
- **PRIMARY_PAYOR_ID**: This column stores the unique identifier for the primary payer associated with the hospital account.
- **PRIMARY_PLAN_ID**: This column stores the unique identifier for the primary benefit plan associated with the hospital account.
- **NUM_OF_CHARGES**: The total number of charge transactions posted to the hospital account. This number may include inactive charges, such as reversals and reversed charges.
- **SIGN_ON_FILE_C_NAME**: The category ID indicating whether a hospital account signature is on file. This is an abstracting item.
- **SIGN_ON_FILE_DATE**: The date the signature on file was entered for the hospital account. This is an abstracting item.
- **PRIM_CONTACT_OVRD**: The value for the primary contact override associated with the hospital account.
- **CODING_STATUS_C_NAME**: The coding status category ID for the hospital account.
- **CODING_STS_USER_ID**: This column stores the unique identifier for the user when the coding status for the hospital account last changed.
- **CODING_STS_USER_ID_NAME**: The name of the user record. This name may be hidden.
- **CODING_DATETIME**: The date and time that the coding status for the hospital account was last changed.
- **ABSTRACT_USER_ID**: This column stores the unique identifier for the user who last changed the abstracting status of the hospital account.
- **ABSTRACT_USER_ID_NAME**: The name of the user record. This name may be hidden.
- **OLD_RECUR_PRNT_ID**: This column stores the unique identifier for the parent recurring account before combine.
- **CASE_MIX_GRP_CODE**: The case-mix group code associated with the hospital account.
- **LAST_CMG_CODE**: The CMG code from the last CPT merge.
- **LAST_INT_CVG_ID**: This column stores the unique identifier for the last interim coverage associated with the hospital account.
- **BIRTH_WEIGHT**: The birth weight of the newborn associated with the hospital account. This is an abstracting item.
- **GESTATIONAL_AGE**: On the mother's hospital account, the gestational age of the baby. This is an abstracting item.
- **DISCHARGE_WEIGHT**: The discharge weight of the newborn associated with the hospital account. This is an abstracting item.
- **ORGAN_DONOR_YN**: Indicates whether the patient associated with hospital account is an organ donor. This is an abstracting item.
- **PREMATURE_BABY_YN**: Indicates whether the baby associated with the hospital account is premature. This is an abstracting item.
- **CODER_INITIALS**: The initials of the user to last change the coding status on the hospital account.
- **ADMIT_CATEGORY_C_NAME**: This column stores the admission category ID for this hospital account. See column ADMIT_CATEGORY_C in table PAT_ENC_HSP if coding has not been performed on this hospital account. Alternatively, see V_ARHB_HSP_ACCOUNT_ADDL_INFO for the calculated value for this column based on both hospital account and encounter data. This view should be used to maintain backwards compatibility with reports created before upgrading to the Summer 2009 release.
- **FIRST_BILLED_DATE**: This column stores the date when the account moved to the billed state for the first time.
- **LAST_CODING_DATE**: The date of the last coding status change for the hospital account. This is an abstracting item.
- **EXP_TOTAL_CHG_AMT**: The expected total charge amount for the hospital account.
- **EXP_TOTAL_CHG_CMT**: The expected total charge user comment for the hospital account.
- **EXP_PAT_LIAB_CMT**: The expected patient liability user comment for the hospital account.
- **BILL_DRG_IDTYPE_ID**: This column stores the unique identifier for the billing DRG code set on the hospital account.
- **BILL_DRG_IDTYPE_ID_ID_TYPE_NAME**: The name of the ID Type.
- **BILL_DRG_MDC_VAL**: The Major Diagnostic Category value for the billing DRG on the hospital account.
- **BILL_DRG_WEIGHT**: The weight for the billing DRG on the hospital account.
- **BILL_DRG_PS_NAME**: The severity of illness (SOI) category ID associated with the billing DRG on the hospital account.
- **BILL_DRG_ROM_NAME**: The risk of mortality category ID associated with the billing DRG on the hospital account.
- **BILL_DRG_SHORT_LOS**: The short length of stay for the billing DRG on the hospital account.
- **BILL_DRG_LONG_LOS**: The long length of stay for the billing DRG on the hospital account.
- **BILL_DRG_AMLOS**: The arithmetic mean length of stay for the billing DRG on the hospital account.
- **BILL_DRG_GMLOS**: The geometric mean length of stay for the billing DRG on the hospital account.
- **BASE_INV_NUM**: The base invoice number for this row.
- **INV_NUM_SEQ_CTR**: The invoice number sequence counter for the hospital account.
- **RESEARCH_ID**: This column stores the unique identifier for the research study or client record.
- **SPECIALTY_SVC_C_NAME**: The specialty service category ID associated with the hospital account. This is an abstracting item.
- **XFER_TO_NURSE_C_NAME**: The category value of the transfer to nursing home item for the hospital account. This is an abstracting item.
- **XFER_TO_ACUTE_C_NAME**: The category value of the transfer to acute care facility item for the hospital account. This is an abstracting item.
- **DEATH_TYPE_C_NAME**: The type of death category ID for the hospital account. This is an abstracting item.
- **APGAR_1_MIN**: The Apgar score at one minute for the newborn associated with the hospital account. This is an abstracting item.
- **APGAR_5_MIN**: The Apgar score at five minutes for the newborn associated with the hospital account. This is an abstracting item.
- **GRAVIDA**: The total number of pregnancies the patient on the hospital account has had, regardless of whether they were carried to term. This is an abstracting item.
- **PARA**: The number of pregnancies that the patient on the hospital account has carried until the point where the fetus is viable. This is an abstracting item.
- **BIRTH_CERT_SENT_YN**: Indicates whether a birth certificate has been sent for this account. A null value for this column indicates that a birth certificate has not been sent. This is an abstracting item.
- **FAILED_VBAC_YN**: Indicates whether a vaginal birth after caesarian failed. This is an abstracting item.
- **DELIVERY_DATE_TIME**: The date and time of the delivery associated with the hospital account. This is an abstracting item.
- **PRENATAL_PROV_ID**: This column stores the unique identifier for the prenatal physician. This is an abstracting item.
- **DELIVER_PROV_ID**: This column stores the unique identifier for the delivering physician associated with the hospital account. This is an abstracting item.
- **HOLD_STATUS_C_NAME**: The coding hold status category ID for the hospital account. This is an abstracting item.
- **GEST_AGE_BABY**: The gestational age of the baby associated with the hospital account. This is an abstracting item.
- **ACCT_FOLLOWUP_DT**: This column stores the self-pay follow-up date associated with this hospital account.

### HSP_ACCOUNT_2
**Table**: This table contains hospital account information from the Hospital Accounts Receivable (HAR) master file. This second hospital account table has the same basic structure as HSP_ACCOUNT, but was created as a second table to prevent HSP_ACCOUNT from getting any larger. This table will exclude professional billing HARs created by visit filing order in non-single billing office service areas.
- **HSP_ACCOUNT_ID**: This column stores the unique identifier for the hospital account.
- **HH_AGENCY_C_NAME**: The home health agency associated with the hospital account.
- **EXPIRATION_REASON**: The reason for expiration (anesthesia, operation, etc.).  If the discharge disposition is not "expired," this field will not be populated.
- **DECEASED_DT**: Date of patient's death.
- **DECEASED_TIME**: The date and time for the death of the patient that is associated with this hospital account.
- **DURATIONS_HYPERAL**: This column stores the number of days patient is on Hyperal. Hyperal is the same as Total Parenteral Nutrition (TPN) regarding diet and nutrition management.
- **OPEN_DENIAL_BDC_YN**: This column stores whether the hospital account has an open denial record.
- **OPEN_RMK_BDC_YN**: This column stores whether the hospital account has an open remark record.
- **OPEN_COR_BDC_YN**: This column stores whether the hospital account has an open correspondence record.
- **ECMO**: This column stores the number of days the patient has been using the ECMO (extracorporeal membrane oxygenation) equipment.
- **MECHANICAL_VENT**: The number of days the patient has been using the mechanical ventilator.
- **ARCHIVE_ID**: This column stores the unique identifier for the archive record of the hospital account.
- **ARCHIVE_DT**: The date the hospital account was archived.
- **REC_CREATE_USER_ID**: This column stores the unique identifier for the user who created the hospital account.
- **REC_CREATE_USER_ID_NAME**: The name of the user record. This name may be hidden.
- **REGIONAL_STUDY_1**: This column stores the Regional study 1, which is one of the coding info items.
- **REGIONAL_STUDY_2**: This column stores the Regional study 2, which is one of the coding info items.
- **FACILITY_STUDY_A**: Facility study A is one of the coding info items. The abstract info tab in account maintenance can be configured to display these items.
- **FACILITY_STUDY_B**: Facility study B is one of the coding info items. The abstract info tab in account maintenance can be configured to display these items.
- **DECUBITIS_C_NAME**: Decubitis is one of the coding info items. The abstract info tab in account maintenance can be configured to display these items.
- **TRAUMA_C_NAME**: Trauma is one of the coding info items. The abstract info tab in account maintenance can be configured to display these items.
- **GEST_AGE_DAYS**: Gestational age days is one of the coding info items. The abstract info tab in account maintenance can be configured to display these items.
- **GEST_AGE_BABY_DAYS**: Gestational (baby) age days is one of the coding info items. The abstract info tab in account maintenance can be configured to display these items.
- **ESOP_PAYOR_C_NAME**: This column stores the expected source of payment payer, which is a coding info item that stores the payer that is expected to pay for the services. This item is necessary for regulatory reporting in some states. The abstract info tab in account maintenance can be configured to display this item.
- **ESOP_PLAN_NAME_C_NAME**: Expected source of payment plan name is one of the coding info items. It stores the plan that is expected to pay for the services. This item is necessary for regulatory reporting in some states. The abstract info tab in account maintenance can be configured to display coding items.
- **ESOP_PLAN_TYPE_C_NAME**: Expected source of payment plan type is one of the coding info items. It stores the type of plan that is expected to pay for the services. This item is necessary for regulatory reporting in some states. The abstract info tab in account maintenance can be configured to display coding items.
- **CODING_USER**: This column stores the unique identifier for the user who last changed the coding status of the hospital account. This is frequently used to join to the CLARITY_EMP table.
- **CODING_USER_NAME**: The name of the user record. This name may be hidden.
- **APGAR_10_MIN**: The Apgar score at ten minutes for the newborn associated with the hospital account. This is an abstracting item.
- **FRST_PRO_STMT_DT**: This field contains the date of the first non-demand enterprise statement to be sent with a self-pay proration balance.
- **LST_PRO_STMT_DT**: This field contains the date of the most recent non-demand enterprise statement to be sent with a self-pay proration balance.
- **NUM_PRO_STMTS**: This field contains the total number of non-demand enterprise statements sent with a self-pay proration balance.
- **FRST_PRO_D_STMT_DT**: This field contains the date of the first demand enterprise statement to be sent with a self-pay proration balance.
- **LST_PRO_D_STMT_DT**: This field contains the date of the most recent demand enterprise statement to be sent with a self-pay proration balance.
- **NUM_PRO_D_STMTS**: This field contains the total number of demand enterprise statements sent with a self-pay proration balance.
- **FRST_FULL_STMT_DT**: This field contains the date of the first non-demand enterprise statement to be sent where the remaining account balance is completely self-pay.
- **LST_FULL_STMT_DT**: This field contains the date of the most recent non-demand enterprise statement to be sent where the remaining account balance is completely self-pay.
- **NUM_FULL_STMTS**: This field contains the total number of non-demand enterprise statements sent where the remaining account balance is completely self-pay.
- **FST_FULL_D_STMT_DT**: This field contains the date of the first demand enterprise statement to be sent where the remaining account balance is completely self-pay.
- **LST_FULL_D_STMT_DT**: This field contains the date of the most recent demand enterprise statement to be sent where the remaining account balance is completely self-pay.
- **NUM_FULL_D_STMTS**: This field contains the total number of demand enterprise statements sent where the remaining account balance is completely self-pay.
- **FIRST_SELF_PAY_DT**: This field contains the date of the first self-pay balance for this account.
- **FIRST_FULL_SP_DT**: This field contains the first date when the self-pay balance equaled the full account balance for this account.
- **STILLBORN_YN**: Indicates whether a pregnancy resulted in a stillbirth. This is an abstracting item.
- **NUM_LIVE_BIRTHS**: This column contains the abstracted number of children that were born alive for the hospital account encounter.
- **FIRST_INFO_STMT_DT**: This field contains the date of the first non-demand enterprise statement to be sent with no self-pay balance (only insurance balance).
- **LAST_INFO_STMT_DT**: This field contains the date of the most recent non-demand enterprise statement to be sent with no self-pay balance (only insurance balance).
- **LAST_D_INFO_STM_DT**: This field contains the date of the most recent demand enterprise statement to be sent with no self-pay balance (only insurance balance).
- **NUM_D_INFO_STMTS**: This field contains the total number of demand enterprise statements sent with no self-pay balance (only insurance balance).
- **FARM_ACCIDENT_YN**: This column stores whether or not the hospital account was abstracted as a farm accident. 0-No or 1-Yes.
- **EXTERN_AR_FLAG_YN**: External A/R Flag. This flag determines if an account's A/R is to be counted as belonging to an external agency (i.e., as bad debt). This flag is set by a collections action and can be unset by another action. This flag is only used if external agency A/R has been enabled.
- **PRIMARY_CONTACT**: This column stores the primary contact date (DAT) of the hospital account. It's used in many places, such as in determining the admission/discharge date of the account.
- **NUM_STILLBORNS**: This column contains the abstracted number of stillborns for the hospital account.
- **HOSP_INFECTION_YN**: Indicates whether the patient developed a hospital infection during the hospital account encounter.
- **RAPID_RESP_TEAM_YN**: Indicates whether a rapid response team was needed during the hospital account encounter.
- **RETURN_TO_OR_YN**: Indicates whether the patient was returned to operating room. This is an abstracting item.
- **NONCVRD_SNF_STAY_YN**: This column stores whether the Skilled Nursing Facility (SNF) stay billed on this account is non-covered due to not having a prior qualifying inpatient stay.

### HSP_ACCOUNT_3
**Table**: This table contains hospital account information from the Hospital Accounts Receivable (HAR) master file. This third hospital account table has the same basic structure as HSP_ACCOUNT and HSP_ACCOUNT_2, but was created as a third table to prevent the other tables from getting any larger. This table will exclude professional billing hospital account records created by visit filing order in non-single billing office service areas.
- **HSP_ACCOUNT_ID**: This column stores the unique identifier for the hospital account.
- **ISS_TRAUMA**: The trauma "Injury Severity Score" (1-75)
- **ADMIT_TYPE_EPT_C_NAME**: Admit type as stored on patient record.
- **PAT_STS_EPT_C_NAME**: Patient Status as stored on patient record.
- **PMTPLN_EST_INIT_BAL**: This column stores the initial estimated payment plan balance for the hospital account.
- **IP_ADMIT_DATE_TIME**: This column indicates the inpatient admission date and time that has been stored in the hospital account.  This may differ from the admission date and represents the date a patient was admitted with an IP base class.
- **NEW_CANCER_YNU**: This column stores a yes/no/unknown record of whether or not a patient's cancer is new.
- **HYPERALIMENT_DAYS**: This column stores the number of days that a patient received hyperalimentation therapy.
- **BAD_DEBT_FLAG_YN**: Bad Debt Flag. This flag determines if an account's non-prebilled balance is in bad debt. This is only used if account-based bad debt is used.
- **PAT_HOUSE_NUM**: House number in the address in patient demographic information on a hospital account. Added to support international address formats.
- **FAC_TRANS_FROM_C_NAME**: The facility the patient was transferred from prior to their stay.
- **FAC_TRANS_TO_C_NAME**: The facility the patient was transferred to after their stay.
- **TISSUE_REMOVED_YN**: This item represents if tissue was removed during surgery.
- **READMIT_RLTD_YN**: This item represents if the patient was readmitted for a related reason.
- **WNDCARE_PRVD_YN**: This item represents if wound care was provided during this visit.
- **OSHPD_ADM_SITE_C_NAME**: The OSHPD admission site category number for this hospital account.  This data is populated by coders in the abstracting activity.  The abstracting activity must be configured to include this field to use this.
- **OSHPD_LIC_SITE_C_NAME**: The OSHPD licensure of site category number for this hospital account.  This data is populated by coders in the abstracting activity.  The abstracting activity must be configured to include this field to use this.
- **OSHPD_RTE_ADM_C_NAME**: The OSHPD route of admission category number for this hospital account.  This data is populated by coders in the abstracting activity.  The abstracting activity must be configured to include this field to use this.
- **OSHPD_TYP_CARE_C_NAME**: The OSHPD patient's type of care category number for this hospital account.  This data is populated by coders in the abstracting activity.  The abstracting activity must be configured to include this field to use this.
- **HAS_OPEN_OVRP_BD_YN**: Indicates whether the hospital account has open overpayment records.
- **EBC_BIRTH_DT_TM**: The date and time of birth on the electronic birth certificate for the child that is associated with this hospital account.
- **HH_HSB_ID**: This column stores the unique identifier for the home health summary block that is associated with this hospital account.
- **SELF_PAY_YN**: Indicates whether this hospital account is self-pay.
- **EBC_LAST_MENSES_FT**: The date of the mother's last normal menses prior to the birth.
- **SBO_SPLIT_HAR_ID**: This column stores the unique identifier for a mixed hospital account used with splits in shared-mode single billing office. This will be populated on professional billing-only hospital accounts that were created as the result of splitting a mixed hospital account.
- **BILL_DRG_QLFR_C_NAME**: This column stores the additional diagnosis-related group (DRG) qualifier for the billing DRG type and code.
- **ACTUAL_COPAY_AMT**: For all insurance buckets of the last coverage in the filing order, the total copay specified by insurance on payments.
- **ACTUAL_COINS_AMT**: For all insurance buckets of the last coverage in the filing order, the total coinsurance specified by insurance on payments.
- **ACTUAL_DED_AMT**: For all insurance buckets of the last coverage in the filing order, the total deductible specified by insurance on payments.
- **SBO_BILL_AREA_ID**: Save the bill area associated with HAR. Currently it is only set when the one PB HAR per bill area logic is used.
- **SBO_BILL_AREA_ID_BILL_AREA_NAME**: The record name of this bill area, financial subdivision, or financial division.
- **MYC_LST_ST_VW_DTTM**: This column stores the date and time when this Hospital Billing statement was last viewed in MyChart for this hospital account. If you are using hospital account-level statements, this field will be updated when that specific hospital account statement is viewed in MyChart. If you are using guarantor-level statements, then this field will be updated when a guarantor statement that includes this hospital account is viewed in MyChart. The date and time for this column is stored in Coordinated Universal Time (UTC) and can be converted to local time by using the EFN_UTC_TO_LOCAL Clarity database function.
- **MYC_LST_DB_VW_DTTM**: This column stores the date and time when a Hospital Billing detail bill was last viewed in MyChart for this hospital account. The date and time for this column is stored in Coordinated Universal Time (UTC) and can be converted to local time by using the EFN_UTC_TO_LOCAL Clarity database function.
- **MYC_LST_LTR_VW_DTTM**: This column stores the date and time when a Hospital Billing letter was last viewed in MyChart for this hospital account. The date and time for this column is stored in Coordinated Universal Time (UTC) and can be converted to local time by using the EFN_UTC_TO_LOCAL Clarity database function.
- **CDI_SPECIALIST_ID**: Stores the person responsible for the CDI process.
- **CDI_SPECIALIST_ID_NAME**: The name of the user record. This name may be hidden.
- **CDI_START_DATE**: Stores the date the CDI review started.
- **CDI_LAST_RVW_DATE**: Stores the last date the CDI review was done.
- **CDI_DRG_CHANGED_YN**: This column indicates whether the clinical documentation improvement (CDI) queries resulted in a DRG change.
- **CDI_INITIAL_DRG_ID**: Stores the initial DRG before the CDI review is complete.
- **CDI_INITIAL_DRG_ID_DRG_NAME**: The name of the Diagnoses Related Group name.
- **CDI_INITIAL_REIMB**: Stores the expected reimbursement based on the initial DRG.
- **CDI_INITIAL_DRG_WT**: Stores the initial DRG weight.
- **CDI_WORKING_DRG_ID**: Stores the working DRG assigned by the CDI specialist.
- **CDI_WORKING_DRG_ID_DRG_NAME**: The name of the Diagnoses Related Group name.
- **CDI_WORKING_REIMB**: Stores the expected reimbursement based on the working DRG.
- **CDI_WORKING_DRG_WT**: Stores the working DRG weight.
- **CDI_PRIMARY_DX_ID**: Stores the primary diagnosis identified by the CDI specialist.
- **CDI_DRG_MATCH_YN**: Indicates whether the final DRG selected by the coder matches the working DRG specified by the CDI specialist.
- **BP_DIASTOLIC**: Diastolic Blood Pressure
- **PULSE**: The pulse for the patient on the hospital account. This is an abstracting item. The data can be configured to copy from the first pulse taken on the primary contact.
- **BP_SYSTOLIC**: Systolic Blood Pressure
- **PRELIM_COD_DX_ID**: This item contains the Preliminary Cause of Death as entered by a coder.
- **COD_RECORD_ID**: This column stores the unique identifier for the coding record for CDI that is associated with the hospital account.
- **CMS_OP_ESRD_STRT_DT**: This column stores the date the patient started to receive maintenance dialysis treatments for end-stage renal disease (ESRD).
- **CMS_OP_ESRD_DX_G_DT**: The first date that the acute comorbidity of gastrointestinal bleeding was present during maintenance dialysis treatments for ESRD.
- **CMS_OP_ESRD_DX_B_DT**: This column stores the first date the acute comorbidity of bacterial pneumonia was present during maintenance dialysis treatments for end-stage renal disease (ESRD).
- **CMS_OP_ESRD_DX_P_DT**: The first date that the acute comorbidity of pericarditis was present during maintenance dialysis treatments for ESRD.
- **BILLING_DRG_SRC_C_NAME**: This virtual item displays the source code set of the billing DRG.
- **NYS_PROC_STRT_DTTM**: The start date and time that the ambulatory surgery patient entered the operating room exclusive of pre-op (preparation) and post-op (recovery) time.  This is used for New York SPARCS reporting.
- **NYS_PROC_END_DTTM**: The end date and time that the ambulatory surgery patient left the operating room exclusive of pre-op (preparation) and post-op (recovery) time.  This is used for New York SPARCS reporting.

### HSP_ACCOUNT_4
**Table**: This table contains hospital account information from the Hospital Accounts Receivable (HAR) master file. It excludes Professional Billing HARs created by visit filing order in non-single billing office service areas. This fourth hospital account table has the same basic structure as HSP_ACCOUNT, HSP_ACCOUNT_2 and HSP_ACCOUNT_3.
- **HSP_ACCOUNT_ID**: This column stores the unique identifier for the hospital account.
- **EPISODE_ID**: This column stores the unique identifier for the bundled episode record for this row. This column will only be populated for hospital accounts that have been linked to a bundled episode and is frequently used to link to the BND_EPSD_INFO table. This column is being transitioned to the HSP_ACCT_BND_EPSD_INFO__BND_EPSD_EPISODE_ID column. This column will continue to work in the following manner: 1. Data in Bundled Episode (I HAR 10001) will continue to be extracted by this column.
- **SRCHG_POSTED**: Stores the surcharge amount posted on the hospital account.
- **SRCHG_PAID**: Stores the surcharge amount paid on the hospital account.
- **SRCHG_PAID_SELFPAY**: Stores the surcharge amount paid by patient on the hospital account.
- **SRCHG_PAID_INS**: Stores the surcharge amount paid by insurance on the hospital account.
- **TRAUMA_ADMISSION_C_NAME**: Whether the admission is a trauma case.
- **PSYCH_ADMISSION_C_NAME**: The nature of psychiatric admission.
- **REHAB_ADMISSION_C_NAME**: The code for rehabilitation admission class from the Guide for the Uniform Data Set for Medical Rehabilitation.
- **REHAB_IMPAIRMENT_C_NAME**: The group code for rehabilitation impairment from the Guide for the Uniform Data Set for Medical Rehabilitation.
- **RANCHO_LEVEL_C_NAME**: This column stores the Rancho level used to determine diagnosis-related groups (DRG) for rehabilitation services.
- **SVC_SUCCESS_C_NAME**: Holds whether the account was successfully marked "Coding Complete" by Simple Visit Coding.
- **HH_COVCHG_DT**: The home health coverage change date for the hospital account.
- **HH_COVCHG_DC_DISP_C_NAME**: This is the discharge disposition value that should be used in the case of a home health coverage change.
- **HAR_EXTRACT_TRIGGER_DATE**: Stores the date that hospital account information was changed that will cause the extraction of a closed hospital account.
- **IRF_PAI_REGISTRY_DATA_ID**: This column stores the unique identifier for the Inpatient Rehabilitation Facility Patient Assessment Instrument (IRF-PAI) record associated with the hospital account. The IRF-PAI record stores the assessment data collected for rehabilitation services.
- **PB_SPLIT_REF_DATE**: This column stores the beginning service date of the date range used to split professional billing hospital accounts. Calculated based on the inpatient stay's admission date.
- **BILLING_LENGTH_OF_STAY**: This column stores the billing length of stay (LOS) for the inpatient portion of the hospital account. The billing LOS is calculated as the number of days between admission and discharge.
- **INST_INJURY_UTC_DTTM**: This column stores the Coordinated Universal Time (UTC) instant when the injury happened. Used along with the Injury Codes in Denmark.
- **TOT_INS_PMT**: The total amount of insurance payments posted to this account, not including refunds.
- **TOT_INS_RFND**: The total amount of insurance refunds posted to this account. Includes refunds posted as either payments or adjustments.
- **TOT_INS_ADJ**: The total amount of insurance adjustments posted to this account, not including refunds.
- **TOT_SP_PMT**: The total amount of self-pay payments posted to this account, not including refunds.
- **TOT_AR_INS_PMT**: The total amount of active AR insurance payments posted to this account, not including refunds.
- **TOT_AR_INS_RFND**: The total amount of active AR insurance refunds posted to this account. Includes refunds posted as either payments or adjustments.
- **TOT_AR_INS_ALLOWANCES**: The total amount of active AR insurance allowance adjustments posted to this account.
- **TOT_AR_SP_PMT**: The total amount of active AR self-pay payments posted to this account, not including refunds.
- **TOT_AR_SP_RFND**: The total amount of active AR self-pay refunds posted to this account. Includes refunds posted as either payments or adjustments.
- **TOT_AR_SP_ALLOWANCES**: The total amount of active AR self-pay allowance adjustments posted to this account.
- **HH_IS_REV_REC_YN_NAME**: Indicates whether the hospital account was evaluated by Revenue Recognition based on the Revenue Recognition active dates and the admission date of the hospital account.
- **ESTIMATE_ID**: Stores the estimate created directly from this account for advance billing. Estimates provided prior to service are only linked to encounters and are not stored here.
- **QUALIFIED_CDI_REVIEW_YN**: This item indicates whether the account qualified for clinical documentation improvement (CDI) review, regardless of whether a review actually occurred.
- **TOT_INS_PMTS_AND_RFNDS**: The total insurance payment amount posted to the account, less any refunded amount.
- **TOT_SP_PMTS_AND_RFNDS**: The total self-pay payment amount posted to the account, less any refunded amount.
- **TOT_PMTS_AND_RFNDS**: The total payment amount posted to the account, less any refunded amount.
- **TOT_ADJ_EXCL_RFNDS**: The total adjustment amount posted to the account, not including refund adjustments.
- **ANCHOR_HSP_ACCOUNT_ID**: For an encounter series of accounts, if the system automatically splits a cycle such that it has multiple accounts to span the cycle, one account is maintained to be the anchor for that cycle. The anchor account is intended to always exist for the cycle, so if the split is no longer needed, the other accounts in the cycle will be combined in to the anchor.
- **ANCHOR_START_DATE**: When establishing an anchor account, this is the start date that encapsulates all the accounts in the anchor group. If it's just the anchor account, then it should be that account's start date. If there are multiple accounts anchored to the same account, then it's the earlier date of the group.
- **ANCHOR_END_DATE**: When establishing an anchor account, this is the end date that encapsulates all the accounts in the anchor group. If it's just the anchor account, then it should be that account's end date. If there are multiple accounts anchored to the same account, then it's the latest date of the group.
- **COCM_EPISODE_ID**: This column stores the unique identifier for the coordinated care management service episode linked to the hospital account.
- **MECH_VENT_HOURS**: The number of hours used by the mechanical ventilator.
- **SP_RESP_AFTER_INS**: The balance transferred to self-pay after insurance is taken into account. This does not include any self-pay discount, financial assistance, or pre-payments.
- **SP_RESP_LESS_DISCOUNT**: The self-pay responsibility after any self-pay or financial assistance discounts are posted on the self-pay bucket.
- **TOT_PRESERVICE_PMT**: This column stores the total pre-service payments made by the guarantor for the hospital account.
- **BAL_IN_FULL_SELF_PAY_YN**: This column indicates whether the balances for this hospital account are entirely in self-pay. 'Y' indicates that all balances are in self-pay. 'N' or NULL indicates that there are some balances not in self-pay or the account has not been billed.
- **FIRST_TX_POST_DATE**: This column is the original post date for the very first transaction that filed to this hospital account, even if that transaction has been reposted, transferred, or reversed.
- **SELF_PAY_EXEMPT_RSN_C_NAME**: The self-pay charge exemption reason category ID for why self-pay only charges on the hospital account should be billed to insurance.

### HSP_ACCT_ADJ_LIST
**Table**: This table contains adjustment lists for hospital accounts.
- **HSP_ACCOUNT_ID**: This column stores the unique identifier for the hospital account.
- **LINE**: The line number for the information associated with this record. Multiple pieces of information can be associated with this record.
- **ADJ_ID**: This column stores the unique identifier for the adjustment associated with this hospital account.

### HSP_ACCT_ADMIT_DX
**Table**: This table contains hospital account admit diagnoses from the Hospital Accounts Receivable (HAR) master file.
- **HSP_ACCOUNT_ID**: This column stores the unique identifier for the hospital account.
- **LINE**: This column stores the line number in the results of a query. As multiple admission diagnoses can be stored in one hospital account, each diagnosis will have a unique line number.
- **ADMIT_DX_ID**: This column stores the unique identifier for admission diagnosis stored in the hospital account.
- **ADMIT_DX_TEXT**: A text description of an admission diagnosis stored in the hospital account.

### HSP_ACCT_ATND_PROV
**Table**: This table contains hospital account attending provider information from the Hospital Accounts Receivable (HAR) master file.
- **HSP_ACCOUNT_ID**: This column stores the unique identifier for the hospital account.
- **LINE**: This column stores the line number of the attending provider for the patient associated with the hospital account. Multiple attending providers can be stored in one hospital account, and each will have a unique line number.
- **ATTENDING_PROV_ID**: This column stores the unique identifier for the attending provider stored in the hospital account.
- **ATTEND_DATE_FROM**: The date on which a provider began to be an attending provider for the patient associated with the hospital account.
- **ATTEND_DATE_TO**: The date on which a provider ceased to be an attending provider for the patient associated with the hospital account.

### HSP_ACCT_BILL_DRG
**Table**: This table contains billing diagnosis related group (DRG) information from the Hospital Accounts Receivable (HAR) master file.
- **HSP_ACCOUNT_ID**: The hospital account ID with associated billing DRG information.
- **BL_DRG_COND_CODE**: This column stores the billing diagnosis-related group (DRG) condition code on the hospital account.
- **BL_DRG_LOS**: This column stores the billing DRG length of service in days for the hospital account.
- **BL_DRG_PAT_STATUS**: The patient status for the billing DRG on the hospital account.
- **BL_DRG_ECCS**: The ECCS (episode clinical complexity score) associated with the billing DRG.

### HSP_ACCT_CHG_LIST
**Table**: This table contains the hospital account charge list, which is the transaction list associated with the account.
- **HSP_ACCOUNT_ID**: This column stores the unique identifier for the hospital account.
- **LINE**: The line count for the hospital account charge list related group.
- **TX_ID**: This column stores the unique identifier for the charge in the charge list on this hospital account.

### HSP_ACCT_CLAIM_HAR
**Table**: This table contains hospital account claims information extracted from hospital account records.
- **ACCT_ID**: This column stores the unique identifier for the hospital account.
- **UB92_COVEREDDAYS**: This column stores the UB92 Covered days (inpatient only): the number of days covered by the primary payer, as qualified by the payer organization.
- **UB92_NONCOVEREDDAY**: This column stores the UB92 Non Covered days (inpatient only): the number of days not covered by the primary payer, as qualified by the payer organization.
- **UB92_COINSDAYS**: This column stores the UB92 Coinsurance days: Days covered by secondary coverage in addition to primary coverage.
- **UB92_RESERVEDAYS**: UB92 Lifetime Reserve Days (INPATIENT ONLY):  Each beneficiary has a lifetime reserve of 60 additional days after using 90 days of inpatient hospital services during a spell of illness.  Lifetime reserve days are not renewable.
- **ADMISSION_TYPE_C_NAME**: The admission type category ID for the hospital account.
- **ADMISSION_SOURCE_C_NAME**: The admission source (e.g., Physician Referral, Transfer from a Hospital, Information Not Available) for the patient encounter associated with this hospital account.
- **UB92_TOB_OVERRIDE**: This column stores the Type of Bill (TOB) override: TOB is a numeric code printed on claims that provide encounter information to a payer. Values entered here will override system settings that normally determine the TOB.
- **AUTHORIZATION_NUM**: Authorization Number: Used on claims for identifying patient referrals and affected reimbursements.
- **PARTA_EXHAUST_DT**: The date on which the patient's Part A benefits are exhausted for this inpatient stay.  Part A benefits cover up to 90 inpatient days per stay (plus any lifetime reserve days the patient may opt to use after the 90th day).  After these days have been used, Part A claims will be denied.  Inpatient Part B claims may be submitted for appropriate services.
- **PATIENT_STATUS_C_NAME**: The patient status for the patient associated with this hospital account (e.g., Alive, Dead, Unknown, Discharged to Home or Self Care, Admitted as an Inpatient to this Hospital).
- **SHAREABLE_CLAIM_ID**: This column stores the unique identifier for a shareable claim associated with the hospital account.
- **NONCVRD_SNF_STAY_YN**: This item indicates whether the Skilled Nursing Facility (SNF) stay billed on this account is non-covered due to not having a prior qualifying inpatient stay.

### HSP_ACCT_CL_AG_HIS
**Table**: This table contains collection agency history information from the Hospital Accounts Receivable (HAR) master file.
- **HSP_ACCOUNT_ID**: This column stores the unique identifier for the hospital account with associated collection agency information.
- **LINE**: The line number in the results of a query. Each collection agency history will have its own line number.
- **AGNCY_HST_DT_OF_CH**: Date hospital account was either assigned to or withdrawn from the collection agency.
- **AGNC_HST_CHG_TP_C_NAME**: Change in the collection agency status.  1-Assign to agency 2-Withdraw from agency
- **AGNCY_HST_AGNCY_ID**: ID of collection agency hospital account has been assigned to.
- **AGNCY_HST_AGNCY_ID_COLL_AGENCY_NAME**: The name of the collection agency.
- **AGN_HST_COL_ACT_C_NAME**: This column stores the type of collection action done on the hospital account: 1-Send Letter, 2-Pre-Collect, 3-Bad Debt, 4-Return to Self-Pay, 5-Write Off, 6-Create Billing Note, 7-Change Notification Date, 8-Add to Queue, 10- Outsource Account, 11- Return from Outsource, 12-Change Agency, 13-Set Billing Indicator, or 14-Send SmartText Letter.
- **AGNCY_HST_ACCT_BAL**: Account balance on the hospital account that was sent to collections.
- **AGNCY_HST_CHG_RSN_C_NAME**: This column contains the reason why the account was placed or withdrawn from the agency. Refer to the AGNC_HST_CHG_TP_C to know whether this was related to an assign or withdraw.

### HSP_ACCT_CVG_LIST
**Table**: This table contains hospital account and PB visit coverage list information from the Hospital Accounts Receivable (HAR) master file.
- **HSP_ACCOUNT_ID**: This column stores the unique identifier for the hospital account.
- **LINE**: This column stores the line number in the results of a query. As multiple coverages can be associated with one hospital account, each coverage will have a unique line number.
- **COVERAGE_ID**: This column stores the unique identifier for the coverage associated with the hospital account.
- **CVG_IGNR_PRIM_PAY_YN**: This item stores whether the coverage was ignored for being assigned as primary payer. Typically the first coverage in the coverage list is used for primary payer, but a subsequent coverage may be assigned in some cases instead.
- **CVG_IGNR_RSN_C_NAME**: This item stores the reason why the coverage was ignored for primary payer. Typically the first coverage in the coverage list is used to determine primary payer, but a subsequent coverage may be assigned in some cases instead.
- **CVG_TIMELY_FILING_DATE**: This item stores the timely filing date for the coverage. The date is updated as the HAR changes and remains populated after the HAR is closed for reporting purposes. The date stamped is the earliest timely filing date from any active, non-closed buckets for this coverage. If no buckets are active, for primary coverages the prebilled bucket is used to calculate the expected timely filing. For secondary coverages with non active buckets, the NRP deadline is used from the previous coverage.

### HSP_ACCT_DX_LIST
**Table**: This table contains hospital account final diagnosis list information from the Hospital Accounts Receivable (HAR) master file.
- **HSP_ACCOUNT_ID**: The ID number of a hospital account.
- **LINE**: The line number in the results of a query. Since multiple final ICD diagnoses can be stored in one hospital account, each diagnosis will have a unique line number. The record associated with line 1 represents the principal final coded  diagnosis.
- **DX_ID**: The system ID number of a final diagnosis code stored in the hospital account.
- **DX_AFFECTS_DRG_YN**: Specifies if the diagnosis affects the diagnosis-related group (DRG) associated with the hospital account.  1-yes, 2-no
- **DX_COMORBIDITY_YN**: Specifies if the diagnosis is a non-complication/comorbidity ("N"),  complication/comorbidity ("Y"), or major complication/comorbidity ("Y").   Note that this column is extracted as an explicit "N" or "Y", where "Y" is used for both CC and MCC.  The updated column DX_COMORBIDITY_C can be used to distinguish between CC and MCC diagnoses.
- **FINAL_DX_SOI_C_NAME**: Stores the final diagnosis severity of illness
- **FINAL_DX_ROM_C_NAME**: Stores the final diagnosis risk of mortality
- **FINAL_DX_EXCLD_YN**: Stores whether the final diagnosis should be excluded from clinical reporting
- **FNL_DX_AFCT_SOI_YN**: Stores whether the diagnosis affects severity of illness.
- **FNL_DX_AFCT_ROM_YN**: Stores whether the diagnosis affects risk of mortality.
- **FINAL_DX_POA_C_NAME**: Specifies whether each diagnosis was present on admission.
- **DX_COMORBIDITY_C_NAME**: Specifies if complication / comorbidity exists for each diagnosis on the hospital account.
- **DX_HAC_YN**: Specifies if the diagnosis contributed to a Hospital Acquired Condition.
- **DX_COF_C_NAME**: The COF (Condition Onset Flag) for the diagnosis. This item describes whether the diagnosis is onset during the episode (on) or outside of the timeframe of the episode (not).
- **DX_COMPLEXITY_LVL**: The diagnosis complexity level - the complexity weight assigned to the diagnosis in relation to the DRG.
- **COMPLEX_DX_C_NAME**: The complex diagnosis indicator for the diagnosis code.

### HSP_ACCT_EARSTADDR
**Table**: Table containing guarantor street address in guarantor demographics of the hospital account for what was the guarantor address at the time of discharge.
- **ACCT_ID**: This column stores the unique identifier for the hospital account.
- **LINE**: The line number for the information associated with this record. Multiple pieces of information can be associated with this record.
- **GUAR_ADDRESS**: This column stores the multiple lines of the guarantor street address at time of discharge for a hospital account.

### HSP_ACCT_EXTINJ_CD
**Table**: This table contains hospital account external injury codes information from the Hospital Accounts Receivable (HAR) master file.
- **HSP_ACCOUNT_ID**: This column stores the unique identifier for the hospital account.
- **LINE**: This column stores the line number in the results of a query. Because multiple external injury codes can be stored in one hospital account, each code will have a unique line number.
- **EXT_INJURY_DX_ID**: This column stores the system identifier of a external injury code stored in the hospital account.
- **EXT_INJURY_POA_YNU**: This column specifies whether each External Cause of Injury Code diagnosis was present on admission. ** Note: this column was deprecated in the Spring 2008 release.
- **EXT_COMORBIDITY_YN**: This column specifies whether the External Cause of Injury Code diagnosis is a non-complication/comorbidity ("N"), complication/comorbidity ("Y") or major complication/comorbidity ("Y"). Note that this column is extracted as an explicit "N" or "Y", where "Y" is used for both complication or comorbidity (CC) and major complication or comorbidity (MCC). The updated column EXT_COMORBIDITY_C can be used to distinguish between CC and MCC diagnoses.
- **EXT_DX_AFF_DRG_YN**: This column specifies whether the External Cause of Injury Code diagnosis affects the diagnosis-related group (DRG) associated with the hospital account. A null value for this column indicates no.
- **ECODE_DX_SOI_C_NAME**: External Cause of Injury Code diagnosis severity of illness
- **ECODE_DX_ROM_C_NAME**: External Cause of Injury Code diagnosis risk of mortality
- **ECODE_DX_EXCLD_YN**: External Cause of Injury Code diagnosis exclude from clinical reporting
- **ECD_DX_AFCT_SOI_YN**: External Cause of Injury Code diagnosis affects severity of illness
- **ECD_DX_AFCT_ROM_YN**: External Cause of Injury Code diagnosis affects risk of mortality
- **ECODE_DX_POA_C_NAME**: This column stores whether each External Cause of Injury Code diagnosis was present on admission. This column links to category table ZC_DX_POA.
- **EXT_COMORBIDITY_C_NAME**: Specifies if complication/comorbidity exists for each External Cause of Injury Code diagnosis on the hospital account.
- **ECD_HAC_YN**: Specifies if the External Cause of Injury Code diagnosis contributed to a Hospital Acquired Condition.

### HSP_ACCT_LETTERS
**Table**: This table contains hospital billing letters information from the Notes (HNO) master file.
- **NOTE_ID**: This column stores the unique identifier for the note record.
- **LETTER_SENT_DATE**: The date the letter was sent.
- **LET_CREATE_USER_ID**: This column stores the unique identifier for the user who created the letter.
- **LET_CREATE_USER_ID_NAME**: The name of the user record. This name may be hidden.
- **ACCOUNT_ID**: This column stores the unique identifier for the guarantor account that is associated with this letter. This is only populated for letters sent at the guarantor account level.
- **HSP_ACCOUNT_ID**: This column stores the unique identifier for the hospital account that is associated with this letter. This is only populated for letters sent at the hospital account level.
- **BUCKET_ID**: This column stores the unique identifier for the liability bucket that is associated with this letter. This is only populated for letters sent at the liability bucket level.

### HSP_ACCT_OCUR_HAR
**Table**: This table contains the Occurrence Codes and Occurrence Dates for a Hospital Accounts Receivable (HAR) record.
- **ACCT_ID**: This column stores the unique identifier for the hospital account.
- **LINE**: This column stores the line number in the results of a query. Because multiple occurrence codes can be stored in one hospital account, each code will have a unique line number.
- **OCCURRENCE_CODE_C_NAME**: An occurrence code stored in the hospital account.
- **OCCURRENCE_DATE**: The date associated with an occurrence code stored in the hospital account.

### HSP_ACCT_OTHR_PROV
**Table**: This table contains hospital account other providers information from the Hospital Accounts Receivable (HAR) master file.
- **HSP_ACCOUNT_ID**: This column stores the unique identifier for the hospital account.
- **LINE**: This column stores the line number in the results of a query. As multiple "other providers" can be stored in one hospital account, each provider will have a unique line number.
- **OTHER_PROV_ID**: This column stores the unique identifier for an "other provider" stored in the hospital account. The hospital account can store an attending, admitting, and referring provider, plus any number of other providers. For each other provider, the user can specify a role the provider played in treatment.
- **OTH_PRV_ROLE_C_NAME**: This column stores the role associated with an "other provider" stored in the hospital account.

### HSP_ACCT_PRORATION
**Table**: This table contains the Proration related information from the Hospital Accounts Receivable (HAR) master file.
- **HSP_ACCOUNT_ID**: This column stores the unique identifier for the hospital account.
- **LINE**: The line number for the information associated with this record. Multiple pieces of information can be associated with this record.
- **COVERAGE_ID**: This column stores the unique identifier for the coverage record on the hospital account.
- **CVG_AUTH_NUM**: The coverage authorization number.
- **EXP_COPAY_AMT**: The expected copay amount.
- **EXP_COINS_PC**: This column stores the expected coinsurance percentage.
- **EXP_COINS_AMT**: This column stores the expected coinsurance amount.
- **EXP_DED_AMT**: This column stores the expected deductible amount.
- **SYS_EXP_COPAY_AMT**: This column stores the copay amount expected by the system.

### HSP_ACCT_PYMT_LIST
**Table**: This table contains payment lists for hospital accounts.
- **HSP_ACCOUNT_ID**: This column stores the unique identifier for the hospital account.
- **LINE**: The line number for the information associated with this record. Multiple pieces of information can be associated with this record.
- **PMT_ID**: This column stores the unique identifier for the payment that is associated with this hospital account.

### HSP_ACCT_SBO
**Table**: This table contains the single billing office (SBO) balances on the hospital account (HAR). The information is only populated in Enterprise SBO mode. SBO balances are the combined Hospital Billing and Professional Billing transaction balances on each HAR.
- **HSP_ACCOUNT_ID**: The hospital account ID with associated single billing office information.
- **SBO_TOT_BALANCE**: Contains the combined total balance of Hospital Billing (HB)�and Professional Billing (PB) transactions on the hospital account, including charges, payments and adjustments in all statuses (single billing office (SBO)�mode only).
- **SBO_TOTAL_CHARGES**: Combined Hospital Billing (HB)�and Professional Billing (PB) charges on the hospital account in all statuses (single billing office (SBO)�mode only).
- **SBO_TOTAL_PAYMENTS**: Combined Hospital Billing (HB)�and Professional Billing (PB) payments on the hospital account in all statuses (single billing office (SBO)�mode only).
- **SBO_TOTAL_ADJ**: Contains combined Hospital Billing (HB)�and Professional Billing (PB) adjustments on the hospital account in all statuses (single billing office (SBO)�mode only).
- **SBO_PREBILL_BALANC**: Contains combined Hospital Billing (HB)�and Professional Billing (PB) prebilled balances including charges, payments and adjustments (single billing office (SBO)�mode only).
- **SBO_INS_BALANCE**: Contains combined Hospital Billing (HB)�and Professional Billing (PB) insurance balances including charges, payments and adjustments (single billing office (SBO)�mode only).
- **SBO_UND_BALANCE**: Contains combined Hospital Billing (HB)�and Professional Billing (PB) undistributed balances. (single billing office (SBO)�mode only).
- **SBO_SP_BAL**: Contains combined Hospital Billing (HB)�and Professional Billing (PB) self pay balances including charges, payments and adjustments (single billing office (SBO)�mode only).
- **SBO_BAD_DEBT_BAL**: Contains combined Hospital Billing (HB)�and Professional Billing (PB)�bad debt balances including charges, payments and adjustments (single billing office mode only).

### HSP_CLAIM_DETAIL1
**Table**: This table contains claim print record information for claims associated with a given hospital account or liability bucket.
- **CLAIM_PRINT_ID**: Stores the claim record ID associated with a single hospital account.
- **CLAIM_CAT_C_NAME**: The claim category.
- **MAIL_NAME**: The mailing name for this claim.
- **MAIL_CITY_STATE_ZIP**: The mailing city, state, and ZIP code for this claim.
- **MAIL_PHONE**: The mailing phone number for this claim.
- **SRC_OF_ADDR_C_NAME**: The source of the mailing address for this claim.
- **LINE_SOURCE_CLP_ID**: The source claim record for resubmit and demand claims.
- **PARTIAL_CLAIM_YN**: Indicates whether the claim is a partial resubmit.
- **ORIG_HAR_RES_ACT_ID**: Stores the original hospital account when research charges have been added to the account.
- **EXPECTED_PYMT**: Claim level expected reimbursement.
- **DRG_ID**: Diagnosis related group for this claim.
- **DRG_ID_DRG_NAME**: The name of the Diagnoses Related Group name.
- **CLAIM_BILLED_AMOUNT**: Billed amount determined from reimbursement information for Diagnosis Related Group priced claims.
- **CLM_CONTRACTUAL**: Contractual amount determined from reimbursement information for Diagnosis Related Group priced claims.
- **CLM_EXPECTED_PRICE**: Expected amount determined from reimbursement information for Diagnosis Related Group priced claims.
- **CLAIM_PMT_METHOD_C_NAME**: Payment method determined from reimbursement information for Diagnosis Related Group priced claims.
- **CLAIM_PRIM_PMT_RATE**: Primary payment rate determined from reimbursement information for Diagnosis Related Group priced claims.
- **CLM_PRIMARY_CVD_QTY**: Quantity covered by primary method. Determined from reimbursement information for Diagnosis Related Group priced claims.
- **CLM_ADDL_PMT_MTHDS**: Additional payment methods. Determined from reimbursement information for Diagnosis Related Group priced claims.
- **CLM_ADDL_PMT_RATES**: Additional payment rates. Determined from reimbursement information for Diagnosis Related Group priced claims.
- **CLM_ADDL_CVD_QTY**: Additional payment quantity. Determined from reimbursement information for Diagnosis Related Group priced claims.
- **CLM_LINE_PNLTY_PER**: Line/Service level penalties imposed on the claim. Determined from reimbursement information for Diagnosis Related Group priced claims.
- **CLAIM_LATE_DAYS**: Late submission days. Determined from reimbursement information for Diagnosis Related Group priced claims.
- **CLM_SUB_PNLTY_PER**: Late submission penalty percent applied. Determined from reimbursement information for Diagnosis Related Group priced claims.
- **CLM_U_AND_C_AMT**: Usual and customary amount for the claim. Determined from reimbursement information for Diagnosis Related Group priced claims.
- **CLAIM_INS_PORTION**: Insurance portion of the expected amount. Determined from reimbursement information for Diagnosis Related Group priced claims.
- **CLM_PATIENT_PORTION**: Portion of the expected amount the patient is responsible for. Determined from reimbursement information for Diagnosis Related Group priced claims.
- **CLAIM_MTHD_DESC**: A text description of the method used to price the claim.  Determined from reimbursement information for Diagnosis Related Group priced claims.
- **CLAIM_TERM_DESC**: This item stores the term description from the matching contract line.
- **OPERATING_PROV_ID**: Stores the operating provider to go onto the uniform billing claim.
- **CONTRACT_ID**: The unique ID of the contract that was used for this claim. Zero means that the contract is from an external system.
- **CONTRACT_ID_CONTRACT_NAME**: The name of the Vendor-Network contract.
- **CONTRACT_DATE_REAL**: A numerical representation of the contact date for the contract used in this claim. Used to help link to the VEN_NET_CONT_SVC table.
- **CONTRACT_USED_DT**: The date that the contract was used for this claim.
- **CONTRACT_NOT_USED**: Indicates whether the contract was used for this claim. Y indicates that the contract was not used.
- **EDITED_TOB**: Indicates the claim type of bill was edited.
- **EDITED_EOB**: Indicates the claim explanation of benefits was edited.
- **MAIL_ADDR1**: First line of the mailing address for a given claim record.
- **MAIL_ADDR2**: Second line of the mailing address for a given claim record.
- **REIMB_COST_THRESH**: The cost threshold of this claim's outlier data. Determined from reimbursement information for Diagnosis Related Group priced claims.
- **REIMB_COST_OUT**: The cost outlier of this claim's outlier data. Determined from reimbursement information for Diagnosis Related Group priced claims.
- **REIMB_DAY_THRESH**: The day threshold of this claim's outlier data. Determined from reimbursement information for Diagnosis Related Group priced claims.
- **REIMB_DAY_OUT**: The day outlier of this claim's outlier data. Determined from reimbursement information for Diagnosis Related Group priced claims.
- **REIMB_OTH_THRESH**: The other threshold of this claim's outlier data. Determined from reimbursement information for Diagnosis Related Group priced claims.
- **REIMB_OTH_OUT**: The other outlier of this claim's outlier data. Determined from reimbursement information for Diagnosis Related Group priced claims.
- **MAIL_COUNTRY_C_NAME**: Stores the mailing address country.
- **EXPECT_PAT_RESP_AMT**: Stores the total expected patient responsibility for the claim.

### HSP_CLAIM_DETAIL2
**Table**: This table contains detailed claim print record information for claims associated with the hospital liability bucket.
- **CLAIM_PRINT_ID**: The ID of the claim record associated with a single hospital liability bucket.
- **SA_ID**: This column holds the service area for the claim.
- **INACTV_CLP_YN**: This column has a value of yes when the claim is inactive.
- **CLAIM_ACCEPT_DTTM**: This column holds the instant the claim was accepted.
- **SG_PAYOR_ID**: The payer ID for this claim.
- **SG_PLAN_ID**: The plan ID for this claim.
- **SG_CVG_ID**: The coverage ID for this claim.
- **INVOICE_NUM**: The invoice number for this claim.
- **SG_PAT_ID**: The patient ID for this claim.
- **SG_GR_ACCT_ID**: The guarantor account ID for this claim.
- **HOSPITAL_ACCT_ID**: The hospital account ID for this claim.
- **HLB_ID**: The liability bucket ID for this claim.
- **SG_PROV_ID**: The billing provider ID for this claim.
- **SG_REF_SRC_ID**: The referring source ID for this claim.
- **SG_REF_SRC_ID_REFERRING_PROV_NAM**: The name of the referral source.
- **SG_LOC_ID**: The location for this claim.
- **SG_DEP_ID**: The department ID for this claim.
- **SG_POS_ID**: The place of service ID for this claim.
- **SG_CLM_ID**: The claim information ID used by this claim.
- **SG_RQG_ID**: The requisition grouper ID for this claim.
- **CLAIM_CLASS_C_NAME**: The account class used to evaluate this claim.
- **CLAIM_BASE_CLASS_C_NAME**: The base account class used to evaluate this claim.
- **MIN_SERVICE_DT**: The minimum service date for this claim.
- **MAX_SERVICE_DT**: The maximum service date for this claim.
- **UB_FROM_DT**: The uniform billing claim from date.
- **UB_THROUGH_DT**: The uniform billing claim through date.
- **CLAIM_TYPE_C_NAME**: The claim type.
- **CLAIM_FRM_TYPE_C_NAME**: The form type. This is either paper or electronic.
- **TTL_CHRGS_AMT**: Total charges amount.
- **TTL_DUE_AMT**: Total due amount.
- **TTL_NONCVD_AMT**: Total non-covered amount.
- **TTL_PMT_AMT**: Total payment amount.
- **TTL_ADJ_AMT**: Total adjustment amount.
- **UB_BILL_TYPE**: Type of bill.
- **HM_HLTH_BILL_TYP_C_NAME**: Home Health bill type.
- **UB_SG_GRP_NUM**: Group number.
- **CNCL_CLAIM**: Indicates whether this is a cancel claim.
- **REPL_CLAIM**: Indicates whether this is a replacement claim.
- **UB_CVD_DAYS**: Covered days.
- **UB_COINS_DAYS**: Coinsurance days.
- **UB_NON_CVD_DAYS**: Non-covered days.
- **UB_PRINC_DX_ID**: Principal diagnosis.
- **CNCL_CLAIM_CODE**: The value code associated with this claim if it is a cancel claim.
- **REPL_CLAIM_CODE**: The value code associated with this claim if it is a replacement claim.
- **SG_ALTPYR_CLM_YN**: Flag used to indicate that claim is for alternate payer.
- **FILING_ORDER_C_NAME**: This column holds the filing order position of the claim coverage at the time claims were processed.
- **CLM_EXT_VAL_ID**: The ID of the claim record.
- **SG_TREAT_PLAN_ID**: The unique ID of the treatment plan that is associated with the claim.
- **UB_COMB_CLM_TYP_C_NAME**: If this column is set to 1, the claim is a combined claim.
- **REND_PROV_ID**: This column holds the claim level rendering provider.
- **RESEARCH_ID**: This column holds the research study for the claim.
- **SRC_INV_NUM**: In PB, this column holds the original invoice number during refresh and resubmit. In HB, this column holds the invoice number associated with the primary claim in a crossover scenario.
- **CLAIM_TAX_AMOUNT**: Gross tax amount at a claim level, this is the sum of all the tax amounts sent on a claim.
- **DRG_XR_AMOUNT**: The Diagnosis Related Group expected reimbursement amount. This will be stored for accounts billed with Diagnosis Related Group that need tax calculated specifically for the Diagnosis Related Group without any outliers or add-ons, as compared to the total expected reimbursement on the claim.
- **DRG_TAX_AMOUNT**: The Diagnosis Related Group tax amount. This will be stored for accounts billed with Diagnosis Related Group that have tax calculated based on expected reimbursement values.
- **CLAIM_APEC_OUTLIER**: This item stores the Adjudicated Payment per Episode of Care Outlier amount for a claim.
- **SNF_CLAIM_TYPE_C_NAME**: This item identifies the type of Skilled Nursing Facility claim produced.
- **DEPT_TYPE_C_NAME**: The type of department. For Norway claims, this identifies the department as a GP Office, Trust, or Municipality.
- **CLM_REBILL_REASON_C_NAME**: This column stores the reason why we sent the claim again to payer. It holds onto the rebill reason with the highest precedence from the category list.
- **CLM_REBILL_USER_ID**: This column stores the user who resubmitted the claim.
- **CLM_REBILL_USER_ID_NAME**: The name of the user record. This name may be hidden.
- **FAC_ACTOR_TYPE_C_NAME**: This item stores the type of facility. For Norway claims, this identifies the facility as a GP Office, Trust, or Municipality.
- **BENEFIT_RECORD_ID**: Stores the ID of the benefit (BEN) record used to calculate the patient responsibility.
- **PREDICTED_PAY_DATE**: The predicted payment response date for a claim based on historical trends for the payer.
- **SUGGESTED_FOL_UP_DATE**: The suggested initial follow-up date for a claim based on historical trends for the payer.
- **CLM_CLOSED_TIMELY_YN**: Denotes if the claim closed prior to its Suggested Initial Follow-up Date, whereby it was no longer outstanding to insurance.

### HSP_CLAIM_PRINT
**Table**: This table contains claim print record information for claims associated with a given hospital account or liability bucket.
- **CLAIM_PRINT_ID**: Stores the claim record ID associated with a single hospital account or liability bucket.
- **CONTACT_DATE_REAL**: The contact date for the creation of the record in internal format. (There is only one contact date per CLP record.)
- **HSP_ACCOUNT_ID**: The ID of the hospital account with which this claim record is associated.
- **CM_PHY_OWN_ID**: ID of the physical deployment owner for this record. Physical owners will be where the data is hosted, either on the cross-over server or the owner deployment.

### HSP_CLP_CMS_LINE
**Table**: This table contains claim line information for claims associated with the hospital account/liability bucket. For uniform medical billing (UB) claims, this table contains pre-processing charge information, which is used in the creation of UB claim lines. Post-processing claim line data for UB claims is stored in the HSP_CLP_REV_CODE table. For CMS claims, this table contains the post-processing claim line data.
- **CLAIM_PRINT_ID**: The ID of the claim record associated with a single hospital account or liability bucket.
- **LINE**: The line number of one of the multiple values associated with a specific group of data within this record.
- **REIMB_AMT**: Stores the reimbursement amount for claim line.
- **REIMB_METHOD_C_NAME**: Stores the reimbursement method.
- **FROM_SERV_DT**: Stores the from date for a claim line. For services that do not span multiple days, the service date will be held here.
- **TO_SERV_DT**: Stores the through date for a claim line.
- **POS_TYPE_PER_TX**: Stores the place of service type per transaction.
- **TOS_C_NAME**: Stores the type of service for the claim line.
- **PROC_ID**: Stores the internal procedure ID.
- **PROC_DESC**: Stores the procedure description.
- **HCPCS_CODES**: Stores the Healthcare Common Procedure Coding System code for the claim line.
- **PROF_CLM_MODIFIERS**: Stores modifiers on the claim line.
- **DX_MAP**: Comma-delimited list of diagnosis pointers for the claim line.
- **QUANTITY**: Stores the quantity associated with the claim line.
- **OVRD_REV_CODE_ID**: Stores the override revenue code.
- **OVRD_REV_CODE_ID_REVENUE_CODE_NAME**: The name of the revenue code.
- **CHARGE_AMT**: Stores the charge amount for the claim line.
- **INS_DUE_AMT**: Stores the insurance amount due for the claim line.
- **PAT_DUE_AMT**: Stores the patient amount due for the claim line.
- **NON_CVD_AMT**: Stores the non-covered amount for the claim line.
- **PAYMENT_AMT**: Stores the payment amount for the claim line.
- **INSURANCE_PAID_AMT**: Stores the insurance amount paid for the claim line.
- **PAT_PAID_AMT**: Stores the patient amount paid for the claim line.
- **ADJUSTMENT_AMT**: Stores the adjustment amount for the claim line.
- **PRINT_DESCRIPTIO_YN**: This controls procedure description printing for professional claims.
- **REV_LOCATION_ID**: Revenue location for the line.
- **DEPT_ID**: Department of service for the line.
- **PX_START_DT**: Start date for timed procedures.
- **PX_STOP_DT**: Stop date for timed procedures.
- **PX_START_TM**: Start time for timed procedures.
- **PX_STOP_TM**: Stop time for timed procedures.
- **LINE_COMMENT**: Comment for the line.
- **LINE_POS_ID**: Place of service ID.
- **CMS_CODE_TYPE_C_NAME**: Stores the code type for the transaction level Healthcare Common Procedure Coding System code override. If a procedure has been assigned to the line without setting the override, this column will be left blank.
- **CMS_REND_PROV_ID**: This item holds the line level rendering provider for American National Standards Institute claims. Professional claims will use this value to print the claim and line rendering provider loops.
- **CMS_MOLDX_TEST_CODE**: Holds the auxiliary procedure code for a CMS line.
- **CMS_AUXPX_CD_TYPE_C_NAME**: Holds the type of auxiliary procedure code when one is applicable to a CMS line.
- **CMS_PRIOR_AUTH**: Stores the prior-authorization number for a service line.
- **CMS_REF_NUM**: Stores the referral number for a service line.
- **CMS_LINKED_AUTH_ID**: Stores the professional billing charge level linked authorization ID.
- **CMS_MEDICARE_PAID_AMT**: For eMedNY 150003 claims, this is the amount that Medicare paid for this service line. This appears in field 24K (SVC_LN_INFO_2.LN_MCR_PAID_AMT). The EMEDNY_MEDICARE_PLANS profile variable can be used to control which coverages count as Medicare coverages.
- **INVOICE_GRP_LN**: The group line number on the invoice record that corresponds to the data in INVOICE_CLM_LN.

### HSP_CLP_CMS_TX_PIECES
**Table**: This table contains the hospital transactions that were used in the creation of CMS claim lines in Hospital Billing.
- **CLAIM_PRINT_ID**: The unique identifier for the claim record.
- **LINE**: The line number of the claim line in the claim record.
- **TX_PIECE**: The index of the transaction for the claim line.
- **TX_ID**: ID of the hospital transaction used in the creation of this claim line.

### HSP_CLP_DIAGNOSIS
**Table**: This table contains diagnosis related information for claim print records associated with the hospital account/liability bucket.
- **CLAIM_PRINT_ID**: The unique identifier for the claim record.
- **LINE**: The line number of one of the multiple values associated with a specific group of data within this record.
- **DX_ID**: The diagnoses to print on both institutional and professional claim forms.
- **DX_POA_C_NAME**: Diagnosis present on admission indicator. Will only print on institutional claim forms.

### HSP_CLP_REV_CODE
**Table**: This table contains the revenue code list for the claim print records associated with the hospital account/liability bucket.
- **CLAIM_PRINT_ID**: The unique identifier for the claim record associated with a single hospital account or liability bucket.
- **CONTACT_DATE_REAL**: The contact date for the creation of the record in internal format. (There is only one contact date per claim print record.)
- **LINE**: The line number for the information associated with this record. Multiple pieces of information can be associated with this record.
- **UB_MIN_SERVICE**: The minimum service date for the claim print record.
- **UB_MAX_SERVICE**: The maximum service date for the claim print record.
- **UB_CHARGES**: The uniform billing charges on the claim
- **UB_MODIFIER**: The modifier for the claim print record.
- **UB_CPT_CODE**: The uniform billing current procedural terminology code on the claim print record.
- **HSP_ACCOUNT_ID**: The unique ID of the hospital account associated with this claim print record.
- **CM_PHY_OWN_ID**: ID of the physical deployment owner for this record. Physical owners will be where the data is hosted, either on the cross-over server or the owner deployment.
- **REV_CODE_EXT**: The external uniform billing revenue code.
- **UB_REV_CD_DESC**: The description of the uniform billing line.
- **UB_HIPPS_CD**: The uniform billing line health insurance prospective payment system code.
- **UB_QTY**: The uniform billing line quality.
- **UB_NON_CVD_AMT**: The non-covered amount for the uniform billing line.
- **UB_LMRP_CD**: The uniform billing local coverage determination code.
- **UB_HCPCS_RATE**: The uniform billing healthcare common procedure coding system code and modifier or rate.
- **UB_CODE_TYPE_C_NAME**: The code type for the uniform billing claim line. If there is no code type this field will be blank.
- **UB_PRIOR_AUTH**: The prior authorization number for the uniform billing line.
- **UB_RFL_NUM**: The uniform billing line referral number.
- **UB_REND_PROV_ID**: The line level rendering provider for an American National Standards Institute institutional claim. This will only be populated for a combined claim.
- **UB_LINE_SRC_C_NAME**: The category of the line source for the uniform billing line.
- **UB_REIMB_AMT**: The reimbursement amount for the uniform billing line.
- **UB_REIMB_CNTRCT_AMT**: The reimbursement contract amount for the uniform billing line.
- **UB_SVC_DATE**: The service date of the uniform billing service line.
- **UB_MOLDX_TEST_CODE**: The auxiliary procedure code for a uniform billing line.
- **UB_AUXPX_CD_TYPE_C_NAME**: The type of auxiliary procedure code when one is applicable to a uniform billing line.
- **UB_AUTH_ID**: Stores the hospital billing charge level linked authorization ID.
- **UB_REF_PROV_ID**: The ID of the line level referring provider. It is only populated under special circumstances.

### HSP_CLP_UB_TX_PIECES
**Table**: This table contains the hospital transactions that were used in the creation of UB claim lines in Hospital Billing.
- **CLAIM_PRINT_ID**: The unique identifier for the claim print record.
- **LINE**: The line number of the claim line in the claim print record.
- **TX_PIECE**: The hospital transaction IDs used for the claim line.
- **TX_ID**: ID of the hospital transaction used in the creation of this claim line.
- **CLAIM_LINE_NUM**: The ordinal position of the claim line. This can be different than the line number in the claim print record for claim print records that include summary lines.

### HSP_PMT_LINE_REMIT
**Table**: This is a type of summary level of the remittance actions associated with a payment transaction. This table will summarize remittance information from Electronic Remittance and manual payment posting as stored on the transaction. This table is meant to hold a high level summary of line-level reason code information. Data will not be populated if a payment was posted at the invoice-level.
- **TX_ID**: The unique identifier for the transaction record.
- **LINE**: The line number for the information associated with this record. Multiple pieces of information can be associated with this record.
- **LINE_SVCLINE**: Stores the service line number for line level payments.
- **LINE_GRP_CODE_C_NAME**: Stores the group code corresponding to the reason code at the line level.
- **LINE_REMIT_CODE_ID**: Stores the reason code or remark code from the service line.
- **LINE_REMIT_CODE_ID_REMIT_CODE_NAME**: The name of each remittance code.
- **LINE_RSN_CODE_EXTL**: Stores the external claim level reason code or remark code from the service line.
- **LINE_RMT_AMT**: Stores the amount associated with the reason code at the line level.
- **LINE_RMK_CODES**: Stores information about the remark codes that are associated with specific reason codes at the line level. This is a comma delimited list of remark codes. The system will associate all remark codes present at any particular service line to every reason code on the same line.

### HSP_PMT_REMIT_DETAIL
**Table**: This is a type of summary level of the remittance actions associated with a payment transaction. This table will summarize remittance information from Electronic Remittance and manual payment posting as stored on the transaction. This table extracts the information that displays in the remittance grid in payment posting as the end user sees it.
- **TX_ID**: The unique identifier for the transaction record.
- **LINE**: The line number for the information associated with this record. Multiple pieces of information can be associated with this record.
- **DTL_GRP_CODE_C_NAME**: This column stores the group code for the reason code that is entered in the remittance grid when this batch is opened in payment posting.
- **DTL_REMIT_CODE_ID**: This column stores the remit code that is entered in the remittance grid when this batch is opened in payment posting.
- **DTL_REMIT_CODE_ID_REMIT_CODE_NAME**: The name of each remittance code.
- **DTL_RSN_CODE_EXTL**: This column stores the external reason code that is entered in the remittance grid when this batch is opened in payment posting.
- **DTL_REMIT_AMT**: This column stores the amount associated with the reason code that is entered in the remittance grid when this batch is opened in payment posting.
- **DTL_ACTION_STRING**: This column stores the actions associated with the reason code that is entered in the remittance grid when this batch is opened in payment posting. This is a comma delimited string of actions for reason codes with multiple actions associated with them.
- **DTL_CREATE_BDC_YN**: This column stores whether a denial or remark record should be created with the reason code. If any action on the reason code creates a denial or remark, this column will be set to Yes, otherwise this column will be set to No.
- **DTL_SERVICE_LINE**: This column stores the service line this reason code was entered in on the remittance grid when this batch was opened in payment posting. If any reason code was entered at the claim level this row will be set to -1.
- **DTL_DFLTCD_MAPCOL_C_NAME**: This column contains the mapped column of the defaulted remit code.

### HSP_TRANSACTIONS
**Table**: This table contains hospital account transaction detail from the Hospital Permanent Transactions (HTR) master file.
- **TX_ID**: This column stores the unique identifier for the hospital billing transaction.
- **HSP_ACCOUNT_ID**: This column stores the unique identifier for the hospital account associated with the hospital billing transaction.
- **ACCT_CLASS_HA_C_NAME**: Holds the account class of the account when the transaction filed. This is set for all transaction types.
- **ACTION_STRING**: A comma-delimited list of one or more numbers stored in a payment transaction that correspond to actions entered in payment posting. Actions are 1 -- Not Allowed Adjustment, 2 -- Next Responsible Party, 3 -- Claim Denied.
- **ALLOWED_AMOUNT**: An allowed amount stored in a payment transaction.
- **BILLED_AMOUNT**: A billed amount stored in a payment transaction.
- **BILLING_PROV_ID**: This column stores the unique identifier for the billing provider stored in the hospital billing transaction.
- **BUCKET_ID**: This column stores the unique identifier for the liability bucket on which the transaction is currently active. This field is only populated for payment and adjustment transactions, not charges.
- **COINSURANCE_AMOUNT**: A coinsurance amount stored in a payment transaction. Coinsurance amounts are informational only.
- **COPAY_AMOUNT**: A copay amount stored in a payment transaction. Coinsurance amounts are informational only.
- **DEDUCTIBLE_AMOUNT**: A deductible amount stored in a payment transaction. Coinsurance amounts are informational only.
- **DEPARTMENT**: This column stores the unique identifier for the department associated with the hospital billing transaction.
- **DFLT_FEE_SCHED_ID**: This column stores the unique identifier for the default fee schedule for the service area with which a charge transaction is associated.
- **DFLT_FEE_SCHED_ID_FEE_SCHEDULE_NAME**: The name of each fee schedule.
- **DFLT_PROC_DESC**: This column stores the original description of the procedure stored in the procedure record's Name History (I EAP 6), which appears in Procedure Editor as Name. This item is only populated if the description for the procedure was overridden in charge entry.
- **DFLT_UB_REV_CD_ID**: The default revenue code from the procedure master file for a charge transaction.
- **DFLT_UB_REV_CD_ID_REVENUE_CODE_NAME**: The name of the revenue code.
- **FACILITY_ID**: This column stores the unique identifier for the facility associated with the hospital billing transaction.
- **FIN_CLASS_C_NAME**: This column stores the category ID of the financial class stored in a hospital billing transaction. For charges, the financial class comes from the hospital account that the charge is associated with. For payments, the financial class comes from the payer specified during payment posting. If no payer is specified during payment posting, the financial class is self-pay. If the adjustment is entered in adjustment posting, the financial class is from the payer specified in adjustment posting. If the adjustment is created from a bucket action, the financial class comes from the financial class on the bucket. If no payer is specified during adjustment posting or the adjustment bucket action is made on an undistributed bucket, the financial class is self-pay. Adjustment refund bucket actions can specify the payer, in which case the specified payer's financial class is used.
- **INST_BILL_COMMENT**: A comment stored in a charge transaction. If a hospital account's guarantor is of a type that is considered institutional, then certain pieces of institutional billing-related information can be stored in charges filed on that hospital account.
- **INST_BILL_DOB**: A date of birth stored in a charge transaction. If a hospital account's guarantor is of a type that is considered institutional, then certain pieces of institutional billing-related information can be stored in charges filed on that hospital account. A date of birth is one such piece of information.
- **INST_BILL_EMP_NUM**: An employee number stored in a charge transaction. If a hospital account's guarantor is of a type that is considered institutional, then certain pieces of institutional billing-related information can be stored in charges filed on that hospital account. An employee number is one such piece of information.
- **INST_BILL_PAT_NAME**: A patient name stored in a charge transaction. If a hospital account's guarantor is of a type that is considered institutional, then certain pieces of institutional billing-related information can be stored in charges filed on that hospital account. A patient name is one such piece of information.
- **INST_BILL_SEX_C_NAME**: A patient sex stored in a charge transaction. If a hospital account's guarantor is of a type that is considered institutional, then certain pieces of institutional billing-related information can be stored in charges filed on that hospital account. A patient sex is one such piece of information.
- **INT_CONTROL_NUMBER**: The internal control number stored in a payment transaction.
- **IS_SYSTEM_ADJ_YN**: Denotes whether an adjustment was the result of moving balances between liability buckets or between collection statuses.
- **IS_HOSPITALIST_YN**: Denotes whether a charge has a billing provider who is designated in ADT as a hospitalist.
- **IS_LATE_CHARGE_YN**: Denotes whether a charge is a late charge.
- **IS_RECOUPMENT_YN**: Denotes whether a payment is a recoupment.
- **MODIFIERS**: A comma-delimited list of one or more modifiers associated with a charge transaction.
- **OLD_HSP_ACCOUNT_ID**: This column stores the unique identifier for the hospital account associated with the old hospital billing transaction that was transferred to a different hospital account, causing this new transaction to be created.
- **ORDER_ID**: This column stores the unique identifier for the clinical system order that triggered a hospital billing transaction.
- **ORIG_PRICE**: Denotes the price that was determined for a charge based on fee schedules.
- **ORIG_REPOST_TX_ID**: This column stores the unique identifier for the original transaction of a hospital billing transaction automatically reposted due to a change in financial class, account class, or primary payer.
- **ORIG_REV_TX_ID**: In a reversal transaction, this column denotes the ID number of the original transaction that was reversed.
- **PAT_ENC_CSN_ID**: For a charge dropped via ADT's bed charge billing function or a payment collected at the point-of-service, the contact serial number of the patient contact that triggered the bed charge or led to the collection of the payment.
- **PAYMENT_FROM**: For self pay payments, a text string indicating from whom the payment was received.
- **PAYMENT_SRC_HA_C_NAME**: The payment source stored in a payment transaction, i.e. cash, check, or credit card.
- **PAYOR_ID**: This column stores the unique identifier for the payer associated with each payment or adjustment. This is not populated for charge transactions or when the payment or adjustment is posted to the self-pay bucket. Payments are assigned to the payer specified in payment posting. Adjustments made using adjustment posting are assigned to the payer specified in adjustment posting. Adjustments made using bucket actions are assigned to the payer on the liability bucket to which the adjustment was posted. Refund bucket actions can override the bucket payer with a user entered payer. Users can override any adjustment's payer in adjustment workqueues. Adjustments posted to the undistributed bucket have no payer unless overridden.
- **PERFORMING_PROV_ID**: This column stores the unique identifier for the performing provider associated with a charge transaction.
- **PREV_CREDITS_ACT**: For adjustment transactions that move liability from one bucket to another, the total monetary amount of previous credits on the former bucket.
- **PRIM_FEE_SCHED_ID**: This column stores the unique identifier for the primary fee schedule used to price a charge transaction.
- **PRIM_FEE_SCHED_ID_FEE_SCHEDULE_NAME**: The name of each fee schedule.
- **PROCEDURE_DESC**: This column stores the value manually entered for the procedure description at the time of charge entry. If no value was manually entered, then the procedure record's Name History (I EAP 6) is populated here.
- **PROC_ID**: This column stores the unique identifier for the procedure associated with the hospital billing transaction.
- **QUANTITY**: For charge transactions, the quantity.
- **REFERENCE_NUM**: The payment posting reference number associated with a transaction.
- **UB_REV_CODE_ID**: The revenue code associated with a charge transaction. This could come from the procedure master file or from a user-entered override.
- **UB_REV_CODE_ID_REVENUE_CODE_NAME**: The name of the revenue code.
- **REVENUE_LOC_ID**: This column stores the unique identifier for the revenue location stored in the hospital billing transaction. It is only set when hospital account identifiers are assigned by location instead of service area.
- **SERV_AREA_ID**: This column stores the unique identifier for the service area associated with the hospital billing transaction.
- **SERVICE_DATE**: The service date of a charge, the deposit date of a payment, or the creation date of an adjustment.
- **START_DATE_TIME**: For charge transactions that result from timed procedures, the start date and time stored in the transaction.
- **STOP_DATE_TIME**: For charge transactions that result from timed procedures, the end date and time stored in the transaction.
- **TEMP_TX_ID**: The ID number of the temporary transaction (HTT record) associated with the transaction in question.
- **TOTAL_CHARGES_ACT**: For adjustment transactions that move liability from one bucket to another, the total monetary amount of charges on the latter bucket.
- **TX_AMOUNT**: The monetary amount of a transaction.
- **TX_COMMENT**: A comment associated with a transaction.
- **TX_FILED_TIME**: The date and time when a transaction was filed on a hospital account.
- **TX_NUM_IN_HOSPACCT**: A number denoting in what order the transaction filed on the hospital account. For example, if the transaction in question was the third transaction to file on the account, this column would contain the number 3.
- **TX_POST_DATE**: The date on which the transaction was posted.
- **TX_SOURCE_HA_C_NAME**: The source of the transaction, i.e. unit charge entry, payment posting, electronic remittance,
- **TX_TYPE_HA_C_NAME**: The transaction type, i.e. charge, payment, debit adjustment, or credit adjustment.
- **TYPE_OF_SVC_HA_C_NAME**: The type of service associated with a transaction.
- **USER_ID**: This column stores the unique identifier for the user who posted the hospital billing transaction.
- **USER_ID_NAME**: The name of the user record. This name may be hidden.
- **XFER_LIAB_ADJ_YN**: Y/N flag denoting if the transaction transfers the liability adjustment.
- **CHG_CRED_ORIG_ID**: This column stores the unique identifier for the transaction of a late charge credit.
- **LATE_CRCTN_ORIG_ID**: This column stores the unique identifier for the original charge for a late charge correction transaction.
- **ALLOWANCE_ADJ_YN**: Y/N flag indicating if there is an allowance adjustment.
- **PLACE_OF_SVC_ID**: This column stores the unique identifier for the place of service associated with the hospital billing transaction.
- **NON_COVERED_YN**: Indicates whether the transaction is expected to be a non-covered charge.
- **BEN_BKT_CVG_ID**: This column stores the unique identifier for the benefit bucket associated with the hospital billing transaction.
- **BEN_BKT_INC_STR**: The increment string for the benefit bucket associated with the transaction.
- **QUICK_PMT_TYPE_C_NAME**: The quick payment type category ID for the transaction.
- **NON_COVERED_AMT**: The non-covered amount associated with the transaction.
- **IS_REFUND_ADJ_YN**: Denotes whether this is a Refund Adjustment.
- **INVOICE_NUM**: The invoice number for the transaction.
- **COLLECTION_AGENCY**: This column stores the unique identifier for the collection agency that the hospital billing transaction has been sent to for collections.
- **COLLECTION_AGENCY_COLL_AGENCY_NAME**: The name of the collection agency.
- **PRIMARY_PLAN_ID**: Holds the primary plan of the account when the transaction filed. This is set for all transaction types.
- **HCPCS_CODE**: The override CPT� or HCPCS code either entered manually during charge entry or coming from the clinical application.  Often, pharmacy and supply charges will have a code sent from the clinical system to override the code stored on the procedure. When reporting, you will often want to display this column if it is populated, otherwise display CPT_CODE.
- **NDC_ID**: This column stores the unique identifier for the historical National Drug Code for the corresponding charge. This column will only be set for certain charges posted prior to being on the Epic Summer 2009 release. For current NDC code information, use NDC_CODE_RG_ID column in the HSP_TX_NDC_CODES table.
- **NDC_ID_NDC_CODE**: The external code for the National Drug Code (NDC). An NDC represents packages of medications.
- **HIPPS_CODE**: HIPPS Code for this transaction.
- **HIPPS_CODE_TYPE_C_NAME**: HIPPS Code type for this transaction. i.e. 1-Skilled Nursing Facility 2-Home Health PPS 99-other
- **HIPPS_CODE_DESC**: HIPPS Code description for this transaction.
- **RFND_SND_TO_C_NAME**: This column specifies where to send the refund should there be a credit balance on the hospital billing transaction: 1-Coverage, 2-Guarantor, 3-Patient, 4-Custom Payee, 5-Address Override, 6-Payor, or 7-Plan.
- **RFND_GUAR_ID**: This column stores the unique identifier for the guarantor associated with the refund code on the hospital billing transaction.
- **RFND_COVERAGE_ID**: This column stores the unique identifier for the coverage associated with the refund code on the hospital billing transaction.
- **REFUND_PLAN_ID**: This column stores the unique identifier for the benefit plan associated with the refund code on the hospital billing transaction.
- **RECONCILIATION_NUM**: Reconciliation number from a remittance run.
- **RFND_CUST_PAYEE_C_NAME**: The custom payee for the refund (no system-released values).
- **CE_SRC_DEP_ID**: This column stores the unique identifier for the source deployment of the transaction. This identifies the location where the hospital billing transaction originated. This will have a value of null unless the transaction's deployment of origination and the home deployment are different.
- **CE_POST_DT**: The post date for the transaction.  This will have a value of null unless the transaction's deployment of origination and the home deployment are different.
- **CE_FILED_TIME**: The date and time that the transaction was filed.  This will have a value of null unless the transaction's deployment of origination and the home deployment are different.
- **CE_HM_OFF_TXTYP_C_NAME**: The type of transaction that took place.  This will have a value of null unless the transaction's deployment of origination and the home deployment are different.  Some example values for this field are as follows: 1 - charge, 2 - payment, 3 - debit adjustment, 4 - credit adjustment.
- **POS_SESSIONID**: This column stores the unique identifier for the Point of Sale session.
- **POS_TXID**: This column stores the unique identifier for the Point of Sale transaction.
- **POS_TX_LINE**: The Point of Sale transaction line number.
- **ORIG_ETR_ID**: This column stores the unique identifier for the Professional Billing transaction that was the transfer source for this Hospital Billing transaction.
- **EXTERN_AR_FLAG_YN**: External A/R Flag. This flag determines if an transaction's A/R is to be counted as belonging to an external agency (i.e., as bad debt). This flag is copied from the hospital account level flag. This flag is only used if external agency A/R has been enabled.
- **ERX_ID**: This column stores the unique identifier for the medication record on the hospital billing transaction. This column will have relevant data for any pharmacy charges. It can be used to link to CLARITY_MEDICATION and other pharmacy tables.
- **SUP_ID**: This column stores the unique identifier for the hospital billing transaction.
- **SUP_ID_SUPPLY_NAME**: The name of the inventory item.
- **BAD_DEBT_FLAG_YN**: Bad Debt Flag. This flag determines if a transaction's amount is to be counted as belonging to a bad debt agency. This flag is copied from the hospital account level flag. This flag is only used if account-based bad debt is used. This flag will be set to 'Y' if the account is in bad debt, 'N' otherwise.
- **PMT_RECEIPT_NO**: Stores the receipt number for a receipt printed during payment posting.
- **RFND_AP_DATE**: Stores the date on which the A/P system approved and processed the transaction.
- **RFND_AP_STATUS_C_NAME**: Stores the action taken by the A/P system when it processed the transaction.
- **OPTIME_LOG_ID**: This column stores the unique identifier for the OpTime log associated with the hospital billing transaction.
- **INI_FILE_ATTEMPT_DT**: Item to represent the date when the first attempt to file the transaction was made.
- **RELATED_HTR_ID**: This column stores the unique identifier of the related hospital billing (HB) transaction for this HB transaction. This will map to a HB transaction that is associated with the related hospital account.
- **IMD_ID**: This column stores the unique identifier for the image associated with this hospital billing transaction.
- **DURATION_MINUTES**: This column contains the duration of service in minutes.
- **EB_PMT_HAR_RES_YN**: Indicates whether hospital account restrictions are used.
- **PMT_HAR_DIS_FROM_DT**: The hospital account restriction discharge from date.
- **PMT_HAR_DIS_TO_DT**: The hospital account restriction discharge to date.
- **OVERRIDE_XOVER_YN**: Indicates whether this payment contained override crossover information.
- **RESEARCH_STUDY_ID**: This column stores the unique identifier for the research study or client associated with this hospital billing transaction.
- **RSH_CHG_ORIG_HAR_ID**: This column stores the unique identifier for the original hospital account for a research charge.
- **PAYMENT_NOT_ALLOWED**: This column contains the not-allowed amount on the payment transaction.
- **EB_PMT_TOTAL_AMOUNT**: This column contains the original payment amount. Original payment amount is the amount of the payment prior to getting split in split cases and if the payment is not split, then the original payment amount is the full payment of the transaction.
- **EB_PMT_POST_TYPE_C_NAME**: The type category number of the post type used to post the enterprise payment.
- **EB_PREPMT_POST_TP_C_NAME**: The type category number for the pre-payment post type associated with this transaction.
- **PANEL_DT**: The contact date of the panel procedure that is associated with this transaction.
- **MEA_ID_C_NAME**: Measurement reference ID code.
- **PANEL_DAT**: The contact date of the panel procedure that is associated with this transaction, in decimal format. Used to link with the CLARITY_EAP_OT table.
- **ELEC_PMT_APRVL_CODE**: This column stores the unique identifier for the hospital billing transaction sent back by the merchant.
- **ELEC_PMT_INST_TIME**: Instant of when the payment was approved
- **IMPLANT_ID**: This column stores the unique identifier for the implant record associated with this procedure.
- **LINKED_HTR_ID**: This item links two hospital billing transactions in the system. These transactions will be reversed and transferred at the same time.

### HSP_TRANSACTIONS_2
**Table**: This table contains hospital account transaction details from the Hospital Permanent Transactions (HTR) master file.
- **TX_ID**: This column stores the unique identifier for the hospital billing transaction.
- **REL_ACCL_INS_BKT_ID**: This column stores the unique identifier for the insurance bucket on the accelerated self-pay adjustment transaction in the self-pay bucket.
- **IMPLIED_QTY**: The implied quantity for the order at the time this charge was dropped.  This represents the quantity used to calculate the billing quantity on a pharmacy charge.
- **IMPLIED_QTY_UNIT_C_NAME**: This column stores the implied unit for the order at the time a charge was dropped. This represents the unit of the quantity used to calculate the billing quantity on a pharmacy charge.
- **IMPLIED_UNIT_TYPE_C_NAME**: The implied unit type for the order at the time a charge was dropped. This is where the unit was taken from (i.e. dispense unit, package unit, entire package).
- **LATEST_MED_ORD_DAT**: This column stores the most recent Order contact date (DAT) for the medication Order.
- **SYS_RECLASS_RSN_C_NAME**: Stores the reclassification reason for a transaction reposted for system reasons.
- **CHRG_AMT_SRC_FLG_C_NAME**: The charge amount source flag category number for the charge transaction.
- **ORIG_ACCT_COMB_ID**: This column stores the first account that a hospital billing transaction attempted to post to prior to combine accounts or combined account redirection. Resets upon transfer.
- **PLB_PROV_ID**: Stores PLB (Provider Level Adjustment) provider ID
- **PLB_FP_DATE**: Stores PLB (Provider Level Adjustment) fiscal period date.
- **PLB_REASON_CODE_C_NAME**: Stores PLB (Provider Level Adjustment) reason code.
- **PLB_REFERENCE_NUM**: Stores PLB (Provider Level Adjustment) reference code.
- **PLAN_ID**: This column stores the unique identifier for the benefit plan entered in Hospital Insurance Payment Posting. The payment poster can manually enter this item as a configurable column (configured in HSD settings) in Insurance Payment Posting. In this case, the payment poster can select only from the plans associated with the payer on the bucket that the payment is being posted onto. Adjustments posted during payment posting also are populated with the plan selected by the payment poster.
- **RSH_MOD_TYPE_C_NAME**: This column stores the charge's research billing modifier type. Having a value set here should mean that the charge should file to the patient account in order to bill to insurance, instead of filing to the study account. Thus, in most cases, the presence of data in this column should mean that RSH_CHG_ROUTE_C is also set to Yes, because the RSH_CHG_ROUTE_C column actually controls whether the study-related charge files to the patient or to the study budget.
- **RSH_CHG_ROUTE_C_NAME**: This column indicates whether a research-related charge should route to the patient account or the study account. In most cases, if the charge has a research billing modifier type, it will also file to the patient in order to be billed to insurance. However, the flag that actually determines when a charge will file to the patient account is its charge route value; the value in this column indicates the final determination whether the charge will file to the patient or to the study budget.
- **ELEC_PMT_AUTH_CODE**: Authorization code sent back by the merchant
- **TREATMENT_PLAN_CSN**: The contact serial number of the treatment plan that generated this charge and order.
- **SUP_INV_LOC_ID**: Supply inventory location
- **SUP_WASTED_QTY**: Wasted quantity
- **TREATMENT_DAY_CSN**: This column stores the contact serial number of the treatment day that generated this charge's order. This contact serial number can be linked to TRG_UPDATE_INFO.CONTACT_SERIAL_NUM for additional information on the treatment day. This treatment day is contained within the treatment plan specified in HSP_TRANSACTIONS_2.TREATMENT_PLAN_contact serial number (CSN).
- **OTHER_ADJ_AMOUNT**: Stores the other adjustment amount associated with this payment.
- **OTHER_ADJ_REF_NUM**: Stores the other adjustment reference number associated with this payment.
- **OTHER_ADJ_COMMENT**: Stores the other adjustment comment associated with this payment.
- **PMT_DRG_CODE**: This column stores the diagnosis-related group (DRG) code received on the remittance image.
- **RATE_CNTR_ID**: The rate center stored in a charge transaction. If a user has chosen to override the default rate center in the procedure master file, the user-entered override rate center will display here.
- **RATE_CNTR_ID_COST_CENTER_NAME**: The name of the cost center.
- **DFLT_RATE_CNTR_ID**: This column stores the unique identifier for the default rate center from the procedure master file for a charge transaction.
- **DFLT_RATE_CNTR_ID_COST_CENTER_NAME**: The name of the cost center.
- **DX_PRIM_CODE_SET_C_NAME**: The primary diagnosis code set configured in the facility for the service date of the transaction.
- **DX_ALT_CODE_SET_C_NAME**: The alternate diagnosis code set configured in the facility for the service date of the transaction.
- **COMPOUND_DRUG_LINK_NUM**: The link number for compound medication. The link number is used to group charge lines for components from the same compound drug on claim.
- **LATEST_MED_ORD_DTE**: This column stores the most recent order date (DTE) for the medication order. This column can be used to link to the CONTACT_DATE_REAL column in many order tables to find the correct contact.
- **FIRST_TX_POST_DATE**: This column stores the post date of the first transaction across hospital billing and professional billing in a chain of transfers, reposts, and reversals.
- **ELEC_PMT_RESP_STS_C_NAME**: Response message status from the gateway. This item is only stored for non-accepted responses.
- **ELEC_PMT_RESP_MSG**: Response message from gateway if transaction was not successful. We don't store a message (if any is sent) for accepted transactions.
- **ACCT_FIN_CLASS_C_NAME**: Holds the financial class of the account when the transaction filed. This is set for all transaction types.
- **PRIMARY_PAYOR_ID**: This column stores the primary payer of the account when the transaction filed. This is set for all transaction types.
- **DISCOUNT_PERCENT**: Stores the discount percentage applied to the self-pay balance.
- **DISCOUNT_PROGRAM_ID**: Stores the financial assistance program that the hospital account qualified for which caused the financial assistance adjustment to be applied.
- **DISCOUNT_PROGRAM_ID_PROGRAM_NAME**: The name of the financial assistance program record.
- **DISCOUNT_COMMENT**: Stores the additional details on why the discount is posted on the hospital account.
- **PRIMARY_COVERAGE_ID**: Holds the primary coverage of the account when the transaction filed. This is set for all transaction types.
- **HAR_FIRST_POST_DATE**: This column stores the post date of the first hospital billing transaction on the hospital account in a chain of reposts and reversals.
- **POST_SOURCE_C_NAME**: This column stores the source from which the payment is posted in the system. This is calculated based on the transaction source on the hospital billing transaction.
- **SERVICE_SPEC_C_NAME**: The service specialty of the transaction. This may be different from the service provider's specialty for providers working outside their specialty. If this field has no value, the transaction specialty is the same as the service provider's first-listed specialty.
- **BILLING_SPEC_C_NAME**: The billing specialty of the transaction. This may be different from the billing provider's specialty for providers working outside their specialty. If this field has no value, the transaction specialty is the same as the billing provider's first-listed specialty.
- **ORIG_BUNDPMT_ETR_ID**: This column stores the unique identifier for the professional billing transaction for the original bundled payment.
- **ORIG_BUNDPMT_HTR_ID**: This column stores the unique identifier for the hospital billing transaction for the original bundled payment.
- **REFERENCE_AMT**: Holds the reference amount that is calculated based on the financial class for the charge. This is set by the system and is applicable only to charges.
- **REFERENCE_AMT_SRC_C_NAME**: Holds the source of the reference amount that is used in the calculation of the reference amount. This is set by the system and is applicable only to charges.
- **SRCHG_CLP_ID**: This column stores the unique identifier for the claim print record containing the values contributing to the surcharge adjustment.
- **ADJUSTMENT_CAT_C_NAME**: The adjustment category of the adjustment procedure at the time of posting.
- **WRITE_OFF_RSN_C_NAME**: The mapped write-off reason for the adjustment.
- **SCHED_PMT_ID**: Stores the scheduled payment record that resulted in this payment.
- **PARENT_SCHED_PMT_ID**: Stores the parent scheduled payment record that resulted in this payment.

### HSP_TRANSACTIONS_3
**Table**: This table contains hospital account transaction details from the Hospital Permanent Transactions (HTR) master file.
- **TX_ID**: This column stores the unique identifier for the hospital billing transaction.
- **CONTEST_RSN_C_NAME**: Stores the contested reason. This is set only for charges.
- **CONTEST_RESOLUTION_RSN_C_NAME**: Stores the contested resolution reason. This is set only for charges.
- **REVERSAL_RSN_C_NAME**: Holds the reversal reason. This is set for all transaction types.
- **TAX_RATE_DEF_CSN**: This column stores the tax rate definition contact serial number (CSN) used in the tax calculation.
- **IS_PRE_SERVICE_PMT_YN**: Indicates whether or not this is a pre-service payment, such as a co-pay. This item is only populated for self-pay payments A payment is considered pre-service if it is a visit pre-pay or co-pay payment (such as during check-in).
- **FIRST_HTR_TX_ID**: This column stores the unique identifier for the first hospital billing transaction in a chain of transactions. Note that this chain will include transactions from both hospital billing and professional billing, so this item will return the very first transaction. For a given transaction, either column HSP_TRANSACTIONS_3.FIRST_HTR_ID, or column HSP_TRANSACTIONS_3.FIRST_ETR_ID will be populated. This is different from column HSP_TRANSACTIONS_2.FIRST_TX_ID, which only chains back to the point that the transaction was transferred from professional billing.
- **FIRST_ETR_TX_ID**: This column stores the unique identifier for the first professional billing transaction (ETR record) in a chain of transactions. Note that this chain will include transactions from both hospital billing and professional billing, so this item will return the very first transaction. For a given transaction, either column HSP_TRANSACTIONS_3.FIRST_HTR_ID, or column HSP_TRANSACTIONS_3.FIRST_ETR_ID will be populated. This is different from column HSP_TRANSACTIONS_2.FIRST_TX_ID, which only chains back to the point that the transaction was transferred from professional billing.
- **NO_PAY_CLAIM_TYPE_C_NAME**: If this charge was posted to drive no-pay claims to be generated, this charge is intended to file and bill immediately. These claims will have different types/purposes. This item defines the type of claim that should be generated for the bucket that hold this charge.
- **ORIG_PMT_SPLIT_TX_ID**: This column stores the original unique identifier for the hospital billing transaction when payments are distributed or split.
- **SVC_AUTH_ID**: This item stores the social care service decision level authorization record associated with this charge.
- **POSTING_DEPARTMENT_ID**: The department where the transaction was posted.
- **TAX_EFFECTIVE_DATE**: This column stores the date used in the hospital billing system definitions that determine when this tax line went into effect.
- **TAXABLE_AMOUNT**: This item stores the amount that the tax is applied to
- **TAX_PERCENT**: Percent used to calculate the tax amount
- **TAX_AMOUNT**: This item stores the amount used for the tax
- **DIGITAL_WALLET_C_NAME**: Holds the digital wallet used for an electronic payment. Stored on payments made from a digital wallet and on reversals. This item is not stored on refund transactions.
- **ADV_BILL_DB_TX_ID**: This column stores the unique identifier for the hospital billing transaction for this advance bill debit transfer adjustment.
- **ADV_BILL_ESTIMATE_ID**: This column stores the unique identifier for the estimate used in posting this advance bill adjustment.
- **IS_ADV_BILL_TRANS_YN**: Indicates if this transaction an advance bill transfer system adjustment. Includes both credit and debit adjustments.
- **SAVED_PMT_DIGITAL_WALLET_C_NAME**: Holds the digital wallet of the saved payment method used to make the payment
- **RESEARCH_ENROLL_ID**: The unique ID of the research study association linked to this transaction.
- **CLAIM_PRINT_ID**: The payment's claim print ID with a matching invoice number.
- **INS_WRITE_OFF_AMT**: This item stores the insurance write off amount from the payment based on remittance codes that are mapped to an insurance write-off action.
- **IS_SCANNED_CHECK_YN**: Indicates if a transaction was made using a scanned check.
- **E_PMT_RECEIPT_MSG**: Saves the receipt message received from the gateway for an electronic payment transaction.
- **PAT_PMT_COLL_WKFL_C_NAME**: This column contains the workflow category ID performed to collect a patient payment from the point of view of the user. For example, MyChart eCheck-in vs. MyChart One-Touch.
- **MYC_SIGNIN_METHOD_C_NAME**: This column denotes how the patient or guarantor logged in to MyChart to either post the payment or create an agreement that will post a payment via Auto Pay. Only populated for agreements made via MyChart.
- **POSTING_MYPT_ID**: This column contains either the MyChart account that created the agreement that resulted in the self-pay payment (if applicable) or the MyChart account that posted the self-pay payment.
- **POSTING_MYC_STATUS_C_NAME**: This column contains either the status of the MyChart account that created the agreement that resulted in the self-pay payment (if applicable) or the status of the MyChart account that posted the self-pay payment.  An active MyChart account status is defined as whether a MyChart user could log into the account with a user name and password. Accounts that are not yet active, deactivated, or are proxy accounts are considered inactive.
- **EB_TX_SOURCE_C_NAME**: This column stores the enterprise posting module for the transaction. This is calculated based on the hospital billing transaction source for the transaction. For reversals, the module will always match the module of the reversed parent transaction.
- **LINKED_PARENT_TX_ID**: Stores the parent HTR ID in a linked child HTR.
- **RELATED_ETR_TX_ID**: Applies only if you have enabled Consolidated Self-Pay Balances functionality. Stores the professional transaction ID of the related transaction. This will only be populated on transactions that were mirrored from professional billing.
- **PMT_PLAN_AGRMT_SCHED_PMT_ID**: The unique ID of the transaction's target guarantor's active payment plan agreement record at the time of filing.
- **IS_EST_PRE_SERVICE_PLAN_PMT_YN**: Indicates whether this payment was made on an estimated balance on a payment plan at time of filing ('Y'). 'N' or NULL indicates that the transaction is not a payment, the payment is not on a balance on a payment plan, or the balance was not estimated at the time of filing.
- **IS_PRE_SERVICE_PLAN_PMT_YN**: Indicates whether this payment was made toward a hospital account on a payment plan that was added by an estimate ('Y'). 'N' or NULL indicates that the transaction is not a payment or the payment was not made toward a hospital account on a payment plan that was added by an estimate.

### HSP_TX_AUTH_INFO
**Table**: This table contains the authorization information for each hospital transaction.
- **TX_ID**: This column stores the unique identifier for the hospital billing transaction.
- **LINE**: The line number for the information associated with this record. Multiple pieces of information can be associated with this record.
- **AUTH_COVERAGE_ID**: This item is the list of coverages the associated Authorization values are being applied to.
- **AUTH_NUM**: This item stores the list of authorization number overrides for a charge. This item cannot be set at the same time as Authorization ID (I HTR 833).
- **AUTH_ID**: This item is the list of authorization records linked to a charge
- **AUTH_SOURCE_C_NAME**: This stores the source of the authorization link.
- **AUTH_OVRIDE_USER_ID**: This item stores the user who was responsible for the last authorization assignment.
- **AUTH_OVRIDE_USER_ID_NAME**: The name of the user record. This name may be hidden.
- **AUTH_UPDATE_DTTM**: This item stores the last time the authorization was updated either by the system or a user.
- **INCL_IN_AUTH_CHG_CNT_YN**: This column indicates whether the charge contributes to the used count of the authorization linked to it.

### HSP_TX_DIAG
**Table**: This table contains hospital account transaction diagnoses from the Hospital Permanent Transactions (HTR) master file.
- **TX_ID**: This column stores the unique identifier for the hospital billing transaction.
- **LINE**: The line number in the results of a query. Because multiple diagnosis codes can be associated with one charge, each diagnosis will have a unique line number.
- **HSP_ACCOUNT_ID**: This column stores the unique identifier for the hospital account associated with the hospital billing transaction.
- **POST_DATE**: The post date of a transaction.
- **SERV_AREA_ID**: The service area with which a transaction is associated.
- **DX_ID**: This column stores the unique identifier for the diagnosis code.
- **DX_QUAL_HA_C_NAME**: A qualifier entered with a diagnosis code in charge entry.

### HSP_TX_LINE_INFO
**Table**: This table contains Line level transactions information from Hospital Permanent Transactions (HTR).
- **TX_ID**: This column stores the unique identifier for the hospital billing transaction.
- **LINE**: The line number for the information associated with this record. Multiple pieces of information can be associated with this record.
- **HSP_ACCOUNT_ID**: This column stores the unique identifier for the hospital account.
- **POST_DATE**: The post date for the transaction on the hospital account.
- **SERV_AREA_ID**: This column stores the unique identifier for the service area associated with the hospital billing transaction on the hospital account.
- **LL_REV_CODE_ID**: This column stores the line-level revenue code for the hospital billing transaction on the hospital account.
- **LL_REV_CODE_ID_REVENUE_CODE_NAME**: The name of the revenue code.
- **LL_CPT_CODE**: This column stores the line-level CPT code for the hospital billing transaction on the hospital account.
- **LL_MODIFIER**: This column stores the line-level modifier info for the hospital billing transaction on the hospital account.
- **LL_SERVICE_DATE**: This column stores the line-level service date for the hospital billing transaction on the hospital account.
- **LL_BILLED_AMT**: This column stores the line-level billed amount for the hospital billing transaction on the hospital account.
- **LL_ALLOWED_AMT**: This column stores the line-level allowed amount for the hospital billing transaction on the hospital account.
- **LL_NOT_ALLOWED_AMT**: This column stores the line-level not-allowed amount for the hospital billing transaction on the hospital account.
- **LL_DED_AMT**: This column stores the line-level deductible amount for the hospital billing transaction on the hospital account.
- **LL_COINS_AMT**: This column stores the line-level coinsurance amount for the hospital billing transaction on the hospital account.
- **LL_COPAY_AMT**: This column stores the line-level copay amount for the hospital billing transaction on the hospital account.
- **LL_NON_COVERED_AMT**: This column stores the line-level non-covered amount for the hospital billing transaction on the hospital account.
- **LL_POSTED_AMT**: This column stores the line-level posted amount for the hospital billing transaction on the hospital account.
- **LL_ADJ_AMT**: This column stores the line-level adjustment amount for the hospital billing transaction on the hospital account.
- **LL_REASON_CODES**: This column stores the line-level reason codes for the hospital billing transaction on the hospital account.
- **LL_ACTIONS**: This column stores the line-level action string for the hospital billing transaction on the hospital account.
- **LL_CONTROL_NUMBER**: This column stores the line-level control number for the hospital billing transaction on the hospital account.
- **LL_QUANTITY**: This column stores the line-level quantity from remittance payments.

### HSP_TX_NAA_DETAIL
**Table**: This table contains the not allowed amount (NAA) calculation details for an insurance payment transaction.
- **TX_ID**: This column stores the unique identifier for the hospital billing transaction.
- **LINE**: The line number for the information associated with this record. Multiple pieces of information can be associated with this record.
- **NAA_DTL_STEP**: This column stores the calculation step to be shown in the not allowed amount calculation detail on the transaction detail form. It may include other characters for aid in display formatting.
- **NAA_DTL_DESC**: This column stores the description of a calculation step to be shown in the not allowed amount calculation detail on the transaction detail form.
- **NAA_DTL_VAL**: This column stores the value calculated or used in a calculation step to be shown in the not allowed amount calculation detail on the transaction detail form.

### HSP_TX_RMT_CD_LST
**Table**: This table contains remit code lists from the Hospital Permanent Transactions (HTR) master file.
- **TX_ID**: This column stores the unique identifier for the hospital billing transaction with associated remit code lists.
- **LINE**: The line number in the results of a query. Each remittance code list will have its own line.
- **RMT_CODE_LIST_ID**: This column stores the unique identifier for the remittance code used for the hospital billing transaction.
- **RMT_CODE_LIST_ID_REMIT_CODE_NAME**: The name of each remittance code.
- **RMT_AMT_LIST**: This column stores the remittance code amount associated with transaction.
- **RMT_CODE_EXT**: This column stores the external identifier for the remittance code associated with the hospital billing transaction.
- **GRP_CODE_LIST_C_NAME**: This item holds the reason group code associated with the reason code.

### INVOICE
**Table**: This table includes the basic data for the invoice (INV) record. It contains one row for each used INV record (excluding unused pre-allocated invoices). Note that a row in this table can correspond to multiple claims sent.
- **INVOICE_ID**: The Invoice ID.
- **PAT_ID**: The patient ID associated with this invoice.
- **ACCOUNT_ID**: The account ID that is associated with this invoice.
- **SERV_AREA_ID**: The ID of the service area associated with this invoice.
- **LOC_ID**: The ID of the revenue location associated with this invoice.
- **POS_ID**: The ID of the place of service associated with this invoice.
- **DEPARTMENT_ID**: The ID of the department associated with this invoice.
- **UB_COVERED_DAYS**: The number of covered days for a uniform billing claim.
- **UB_NON_COVERED_DAYS**: The number of non-covered days for a uniform billing claim.
- **UB_COINSURANCE_DAYS**: The number of coinsurance days for the uniform billing claim.
- **UB_PRINCIPA_DIAG_ID**: The principal diagnosis for the uniform billing claim.
- **UB_TYPE_OF_BILL_STR**: Stores the type of bill that was sent out on the claim.
- **PROV_ID**: Stores the ID of the billing provider associated with the invoice.
- **ACCT_SERIAL_NUM**: Stores the account serial number associated with the invoice.
- **PAT_SERIAL_NUM**: Stores the patient serial number associated with the invoice.
- **RQG_ID**: Stores the requisition grouper ID associated with the invoice when there is no patient record.
- **TAX_ID**: Stores the tax ID associated with the invoice.
- **TAX_ID_TYPE**: Stores the type of tax ID associated with the invoice.
- **TREATMENT_PLAN_ID**: Stores the treatment plan ID associated with the invoice.
- **INSURANCE_AMT**: Stores the insurance amount for the invoice.
- **SELF_PAY_AMT**: Stores the initial self-pay amount for the invoice.
- **INIT_INSURANCE_BAL**: Stores the initial insurance amount for the invoice.
- **INIT_SELF_PAY_BAL**: Stores the initial self-pay amount for the invoice.
- **BILL_AREA_ID**: Stores the bill area associated with the invoice.
- **BILL_AREA_ID_BILL_AREA_NAME**: The record name of this bill area, financial subdivision, or financial division.
- **PB_HOSP_ACT_ID**: The Professional Billing Hospital Account ID.
- **RECORD_STATUS_C_NAME**: This column shows the status of the invoice record.

### INV_BASIC_INFO
**Table**: This table contains basic invoice information. Each column in this table is from the INV 100 related group, and each line in the table corresponds to a claim that was sent for this invoice (INV) record.
- **INV_ID**: The invoice ID.
- **LINE**: The line number for the invoice number associated with the invoice record. Multiple invoice numbers can be associated with a single invoice record.
- **INV_NUM**: The specific invoice number for the bill or claim. Subsequent invoice numbers may be secondary claims or primary claims that were resubmitted to the same payer.
- **INV_STATUS_C_NAME**: The status for the invoice number.
- **CVG_ID**: The coverage record ID.
- **EPM_ID**: The payer ID.
- **EPP_ID**: The benefit plan ID.
- **FROM_SVC_DATE**: The from (minimum) service date for the invoice number. This date is determined from the transaction on the invoice with the service date furthest in the past.
- **TO_SVC_DATE**: The to (maximum) service date for the invoice number. This date is determined from the transaction on the invoice with the most recent service date.
- **INV_TYPE_C_NAME**: The claim type for the invoice number. This column identifies whether the invoice number is a bill/statement or a claim.
- **DEMAND_CLM_IND_C_NAME**: This column identifies the invoice number as being a demand claim.
- **CROSS_OVER_YN**: Indicates whether the invoice number is a crossover claim. This usually only applies to secondary claims and indicates that although the claim associated with the invoice was created, it was suppressed from a claim run.
- **MAILING_NAME**: The bill/statement or claim mailing name for the invoice number.
- **MAILING_ADDR**: The bill/statement or claim mailing street address for the invoice number.
- **CITY_STATE_ZIP**: The bill/statement or claim mailing city, state, and ZIP Code for the invoice number.
- **CLM_ID**: The claim information record ID.
- **CEP_ID**: The Episode ID.
- **REF_ID**: The referral ID.
- **REF_ID_REFERRING_PROV_NAM**: The name of the referral source.
- **VIS_NUM**: The visit number for the invoice number.
- **EAF_POS_ID**: The place of service ID.
- **TAX_ID_NUM**: The tax ID/IRS number for the invoice number.
- **TAX_ID_TYPE**: The tax ID/IRS number type for the invoice number.
- **DTP_ID**: The dental treatment plan ID.
- **CANCELED_INV**: Contains a list of all the canceled invoice numbers associated with the invoice record.
- **REPLACED_INV**: Contains a list of all the replaced invoice numbers associated with the invoice record.
- **CLM_CHANGE_RSN_COD**: Contains a list of all the claim change reason codes associated with the invoice record.
- **CLM_CHANGE_COMMENT**: Contains a list of all the claim change comments associated with the invoice record.
- **UB_OPER_PROV_ID**: The operating provider ID
- **MAIL_PHONE**: The mailing phone number for the invoice number.
- **ALTPAYR_INV_YN**: Identifies if the invoice is for an alternate payer.
- **LATE_REPLACEMENT_C_NAME**: Flag to indicate the late replacement claim status of the invoice.
- **CRD_ID**: The claim reconciliation record ID.
- **CLM_EXT_VAL_ID**: The unique ID associated with the claim external value record for this row. Values derived from the claim print record or edited by the user will be stored in the claim external value. Form output will be based on the claim external value.
- **MAIL_COUNTRY_C_NAME**: Stores the mailing address country.
- **CLM_ACCEPT_DT**: The invoice accept date.
- **CLM_DX_CODE_SET_C_NAME**: The code set of the diagnoses on the invoice.
- **FILING_ORDER_C_NAME**: This column holds the filing order position of the claim coverage at the time claims were processed.
- **CLAIM_RUN_NUM**: The claim run number.
- **DEMAND_CLAIM_YN**: This column indicates whether the invoice was created in a demand claim run.
- **SRC_INV_NUM**: This column stores the invoice number that generated the current invoice number.
- **PREDETERMINATION_YN**: Stores a Yes/No indicator that the associated record represents a request for a predetermination of benefits.
- **PREDICTED_PAY_DATE**: The predicted payment response date for a claim based on historical trends for the payer.
- **SUGGESTED_FOL_UP_DATE**: The suggested initial follow-up date for a claim based on historical trends for the payer.
- **FINAL_FOL_UP_DATE**: This item shows the final date all the follow-up records were completed and is based on the last Completed Date (I FOL 122). It will only have a value if all of the follow-up records are currently completed. Should one reopen, this value will also be cleared.
- **CLM_CLOSED_TIMELY_YN**: Denotes if the claim closed prior to its Suggested Initial Follow-up Date, whereby it was no longer outstanding to insurance. The claim closed date is based on the CRD item of the same name (I CRD 86) if set, else the Final Follow-up Completed Date (I INV 133).

### INV_CLM_LN_ADDL
**Table**: This table holds additional line-level information about the invoice (INV) specific to a given invoice including any line-level overrides.
- **INVOICE_ID**: The invoice record ID.
- **LINE**: The line number.
- **INVOICE_NUM**: The invoice number related to this claim line.
- **CLM_LN**: The invoice claim line number.
- **PROC_OR_REV_CODE**: This is the procedure revenue code
- **REV_CODE_DESCRIPT**: This is the revenue code description
- **POS_CODE**: The place of service type for this claim line
- **CLAIM_STATUS_C_NAME**: The claim line status.
- **CLAIM_PAID_AMT**: The claim line paid amount.
- **UB_CPT_CODE**: This is the Common Procedure Terminology (CPT) code for this institutional claim line.
- **EOB_ALLOWED_AMOUNT**: The service line's explanation of benefits adjustment amount.
- **EOB_ADJUSTMENT_AMT**: The service line's explanation of benefits allowed amount.
- **EOB_NON_COVRD_AMT**: The service line's explanation of benefits non-covered amount.
- **EOB_COINSURANCE**: The service line's explanation of benefits coinsurance amount.
- **EOB_DEDUCTIBLE**: The service line's explanation of benefits deductible.
- **EOB_ICN**: The explanation of benefits internal control number for the claim line.
- **EOB_INV_LVL_YN**: Identifies if this explanation of benefits is for the invoice level.
- **EOB_COPAY**: The service line's explanation of benefits copay amount.
- **EOB_COB**: The explanation of benefits coordination of benefits amount.
- **CLAIM_DENIED_CODE**: Claim denied code for this claim line on this invoice.
- **REMIT_CODE_ID**: Remittance code for this claim line on this invoice.
- **TEXT_MESSAGE**: Message associated with the remittance code for this line on this invoice.
- **TRANSACTION_LIST**: The charges associated with the invoice. May hold a comma delimited list of professional transactions if the charges were bundled.
- **FROM_SVC_DATE**: The date when the service was first performed.
- **TO_SVC_DATE**: The date when the service was last performed.
- **PROC_ID**: The unique ID of the procedure associated with the invoice.
- **MODIFIER_ONE**: The first modifier associated with the invoice. This is the external modifier, as it was printed on the claim.
- **MODIFIER_TWO**: The second modifier associated with the invoice. This is the external modifier, as it was printed on the claim.
- **MODIFIER_THREE**: The third modifier associated with the invoice. This is the external modifier, as it was printed on the claim.
- **MODIFIER_FOUR**: The fourth modifier associated with the invoice. This is the external modifier, as it was printed on the claim.
- **QUANTITY**: The number of units associated with the invoice.
- **CHARGE_AMOUNT**: The charge amount associated with the claim line.
- **NONCVD_AMOUNT**: The non-covered amount associated with the invoice.
- **TYPE_OF_SERVICE_C_NAME**: The type of service category value for the claim.
- **DIAGNOSIS_MAP**: Holds a comma-delimited list of pointers to the claim level diagnosis. The first number listed represents the primary diagnosis for the charge.
- **SPECIAL_GRP_TYPE_C_NAME**: The claim grouping type category value for the associated claim grouping rule. Only populated if a claim grouping rule was applied to the invoice.
- **GROUP_TX_LIST**: This holds a list of transaction IDs for bundled charges.
- **UB_MIN_SVC_DATE**: The earliest date any charges were performed for an institutional claim.
- **UB_MAX_SVC_DATE**: The latest date any charges were performed for an institutional claim.
- **OT_REIMB_AMT**: Stores reimbursement amount.
- **CONTRACT_ID**: Stores reimbursement contract.
- **CONTRACT_ID_CONTRACT_NAME**: The name of the Vendor-Network contract.
- **CALC_METHOD_C_NAME**: The reimbursement contract method.
- **PROC_CODE_RATE**: Procedure code rate.
- **PROC_CODE_RATE_DESC**: The procedure code rate.
- **REMITTANCE_RMC1_ID**: First remittance code ID.
- **REMITTANCE_RMC1_ID_REMIT_CODE_NAME**: The name of each remittance code.
- **REMITTANCE_RMC2_ID**: Second remittance code ID.
- **REMITTANCE_RMC2_ID_REMIT_CODE_NAME**: The name of each remittance code.
- **REMITTANCE_RMC3_ID**: Third remittance code ID.
- **REMITTANCE_RMC3_ID_REMIT_CODE_NAME**: The name of each remittance code.
- **REMITTANCE_RMC4_ID**: Fourth remittance code ID.
- **REMITTANCE_RMC4_ID_REMIT_CODE_NAME**: The name of each remittance code.
- **CLM_LN_CREAT_DATE**: Stores the date the claim line is created.
- **INV_NUM_GRP100LN**: The invoice line number.
- **CLM_LN_PAID_DATE**: Stores the most recent date the invoice line is paid.
- **IS_CODE_ONLY**: Identifies show only lines.
- **LN_AUTH_NUM**: This item stores the line level authorization number.
- **LN_REF_NUM**: This item stores the line level referral number.
- **FQHC_BILLOUT_MOD_ID**: The modifier added to a bill out line for grouped claim lines.
- **FQHC_BILLOUT_MOD_ID_MODIFIER_NAME**: The name of the modifier record.
- **CALCULATED_REIMB_AMOUNT**: Stores the system calculated reimbursement amount. This may differ from items 395 and 398 if the expected reimbursement amount was manually overridden.

### INV_DX_INFO
**Table**: Stores claim-level diagnosis information sent on Resolute Professional Billing claims. Diagnosis information is coming from the INV 350 related group. The Group 100 column corresponds to claims that were sent.
- **INVOICE_ID**: The unique ID of the invoice.
- **LINE**: The line count value of the invoice related group.
- **DX_ID**: The unique ID of the diagnosis that is associated with the claim.
- **INV_NUM**: The external ID of the invoice that is associated with the claim.
- **INV_NUM_100_GRP_LN**: Claim line number that the diagnosis entry applies to. This is the line number that links the INV_DX_INFO table with the LINE column in the INV_BASIC_INFO table.

### INV_NUM_TX_PIECES
**Table**: Each line in this table corresponds to a transaction (ETR) composing a line on an invoice from item INV 381. Each line can contain a comma-delimited list of transactions composing a claim line. When a transaction is bundled, data will be split out to its own line via the TX_PIECE column.


 


This table is used as a bridge between transaction- and invoice- based tables.
- **INV_ID**: This column contains the internal invoice ID.
- **LINE**: This column contains the line number for any multiple-response item.
- **TX_PIECE**: This column contains the position of the transaction ID in the comma-delimited list of ETR ID's for a given line of INV-381. For example, if a certain line of INV-381 has three transactions, then TX_PIECE will contain 1, 2, and 3 for that line.
- **TX_ID**: This column contains each individual transaction ID from the list of ETR ID's stored on each line of INV-381. So, if a given line of INV-381 has more than one transaction (separated by a comma-delimited list), then each ETR ID will appear on a separate row of the extract table. In other words, one and only one ETR ID will appear in each row of the TX_ID column.

### INV_PMT_RECOUP
**Table**: This table holds information on payment recoup adjustments associated with an invoice.
- **INVOICE_ID**: The invoice record ID.
- **LINE**: The line number for the information associated with this record. Multiple pieces of information can be associated with this record.
- **TX_ID**: Transactions associated with payments, recoups, or adjustments.

### INV_TX_PIECES
**Table**: This table contains Professional Billing charge transactions associated with invoice service lines.
- **INV_ID**: The unique identifier for the invoice record.
- **LINE**: The line number for the information associated with this contact. Multiple pieces of information can be associated with this contact.
- **TX_PIECE**: The position of the transaction ID in the comma-delimited list of transaction IDs for a given line.
- **TX_ID**: The ID of the transaction associated with the claim line.

### NOTES_ACCT
**Table**: This table contains summary information for billing system account notepad notes attached to accounts.
- **NOTE_ID**: The unique ID of the Account Notepad note record.
- **ACCOUNT_ID**: This column stores the unique identifier for the guarantor associated with the note. It is only populated for guarantor-level notes.
- **ACTIVE_STATUS**: The status of the note: active or inactive.
- **ENTRY_USER_ID**: The ID of the user who manually created the note. If the note was automatically created by billing system, this is the person who executed the activity that triggered the note creation. This ID may be encrypted
- **ENTRY_USER_ID_NAME**: The name of the user record. This name may be hidden.
- **INVOICE_NUMBER**: The invoice number associated with this note.
- **NOTE_ENTRY_DTTM**: The date and time the account note was created.

### OCC_CD
**Table**: All values associated with a claim are stored in the Claim External Value record.  The OCC_CD table holds the occurrence codes that apply to the claim.
- **RECORD_ID**: The unique identifier for the claim record.
- **LINE**: The line number for the information associated with this contact. Multiple pieces of information can be associated with this contact.
- **OCC_CD**: This item holds the occurrence codes that apply to the claim.
- **OCC_DT**: This item holds the date corresponding to the occurrence code.

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

### PMT_EOB_INFO_I
**Table**: The PMT_EOB_INFO_I table contains the Explanation of Benefits information given a transaction ID. It contains data that is not multiple response given a transaction ID.
- **TX_ID**: The unique identifier associated with the transaction for this row.
- **LINE**: The line number for the information associated with this record. Multiple pieces of information can be associated with this record.
- **PEOB_TX_ID**: The transaction ID of the matching charge.
- **CVD_AMT**: The covered amount for that transaction.
- **NONCVD_AMT**: The non-covered amount for that transaction.
- **DED_AMT**: The deducted amount for that transaction.
- **COPAY_AMT**: The copay amount for that transaction.
- **COINS_AMT**: The coinsurance amount for that transaction.
- **COB_AMT**: The Coordination of�Benefits amount for that transaction.
- **PAID_AMT**: The paid amount for that transaction.
- **ICN**: The internal control number for that transaction.
- **DENIAL_CODES**: The denial code for the transaction.
- **PEOB_ACTION_NAME_C_NAME**: The Explanation Of Benefits action category ID for�the transaction.
- **ACTION_AMT**: The action amount for this transaction.
- **ACCOUNT_ID**: The Account Id of the transfer to self-pay action or next responsible party to self-pay action performed in insurance payment posting.
- **COVERAGE_ID**: The Action Coverage of the next responsible party action or resubmit insurance action performed in insurance payment posting.
- **ACTION_ASN_NAME_C_NAME**: The action assignment category ID for the transaction.
- **COMMENTS**: The comments associated the Explanation of Benefits for a transaction.
- **INFO_LINES**: The info lines in PMT_EOB_INFO_II.
- **WIN_DENIAL_ID**: The winning denial remittance code.
- **WIN_DENIAL_ID_REMIT_CODE_NAME**: The name of each remittance code.
- **ACTION_EOB**: The Explanation of Benefits code for actions (next responsible party or resubmit) in payment posting associated with the transaction.
- **INVOICE_NUM**: The invoice number for the transaction.
- **SUMMARY**: Contains any paid, adjustment, copay, coinsurance, or allowed amount for a transaction.
- **TX_MATCH_DATE**: The date when the charge was matched to the payment.
- **CROSSOVER_C_NAME**: Indicates the crossover scenario of this payment transaction at the time of payment posting. The crossover scenario value describes whether this payment transaction is a regular payment, a primary payment (and whether or not the crossover payor has paid), or a crossover payment (and whether or not the primary payor has paid).
- **NON_PRIMARY_SYS_YN**: Indicates whether the system determines this payment transaction as a non-primary payment at the time of payment posting based on crossover information, invoice information, and previous payments information.�Y indicates the system determines this payment transaction as a non-primary payment at the time of payment posting based on crossover information, invoice information, and previous payments information.�A null value indicates the system does not determine this payment transaction as a non-primary payment at the time of payment posting based on crossover information, invoice information, and previous payments information.
- **NON_PRIMARY_USR_YN**: Indicates whether the user determines this payment transaction as a non-primary payment at the time of payment posting. The value of the Non-primary posting (user) is usually the same as the system determined non-primary posting value. However, users can override the system determined non-primary posting value based on the EOB information.  Y indicates the user determines this payment transaction as a non-primary payment at the time of payment posting.
- **PEOB_ACTION_C_NAME**: Indicates the Next Responsible Party, Resubmit Insurance or Transfer to Self-Pay action taken on the charge.
- **INV_ID**: Invoice ID that is associated with one payment Explanation  of Benefits line. Use this field along with INV_LINE to link to the proper record in the INV_CLM_LN_ADDL table.
- **INV_LINE**: Line count of one invoice record for internal calculation use. It is different from claim form line. Use this field along with INV_ID to link to the associated record in the INV_CLM_LN_ADDL table.
- **NO_MATCHED_CHGS_YN**: This column is set to Y when all charges associated with this EOB line have been unmatched from the payment.
- **PEOB_ACCOUNT_ID**: The ID of the guarantor on the invoice associated with the payment. If there is no associated invoice, this column stores the ID of the guarantor from the charge.
- **PEOB_LOC_ID**: The ID of the revenue location on the invoice associated with the payment. If there is no associated invoice, this column stores the ID of the revenue location from the charge transaction.
- **PEOB_POS_ID**: The ID of the Place of Service on the invoice associated with the payment. If there is no associated invoice, this column stores the ID of the Place of Service from the charge.
- **PEOB_DEPT_ID**: The ID of the department on the invoice associated with the payment. If there is no associated invoice, this column stores the ID of the department from the charge.
- **PEOB_BILL_PROV_ID**: The ID of the billing provider on the invoice associated with the payment. If there is no associated invoice, this column stores the ID of the billing provider from the charge.
- **PEOB_PLAN_ID**: The ID of the benefit plan on the invoice associated with the payment. If there is no associated invoice, this column will be blank.
- **PEOB_PROC_ID**: The ID of the procedure on the invoice associated with the payment. If there is no associated invoice, this column stores the ID of the procedure from the charge transaction.
- **PEOB_MTCH_CHG_TX_ID**: The ID of the first matching charge transaction on the invoice associated with the payment. If there is no associated invoice, this column stores the ID of the charge from the Explanation of Benefits master file.

### PMT_EOB_INFO_II
**Table**: The PMT_EOB_INFO_II table contains the Explanation of Benefits information given a transaction ID. This table contains multiple response items pertaining to PMT_EOB_INFO_I table.
- **TX_ID**: The transaction ID.
- **LINE**: The line number of one EOB code which is different from EOB line number in PMT_EOB_INFO_I.
- **AMOUNT**: The Explanation of Benefits amount for a transaction.
- **EOB_CODES**: The EOB Code for this transaction.
- **ADJ_PROC_ID**: The write-off adjustment code associated with the remittance code.
- **ACTIONS**: The action category ID for the payment Explanation of Benefits (EOB)�action in this table. This column is frequently used to link to the ZC_TX_ACTION_TYPE table.
- **SYSTEM_COMMENT**: The comment put into the systems for this transaction.
- **WINNINGRMC_ID**: The winning remittance code ID from the remittance code.
- **WINNINGRMC_ID_REMIT_CODE_NAME**: The name of each remittance code.
- **TX_MATCH_DATE**: The date when the charge was matched to the payment.
- **PEOB_EOB_RMC_IDS**: The remittance code specified by the payer in its Explanation of Benefits (EOB). If this contains a comma delimited list, we will only show the first remittance code.
- **PEOB_EOB_AMOUNT**: The not allowed amount associated with the Remittance Codes that the payor specifies in its Explanation of Benefit (EOB).
- **PEOB_EOB_GRPCODE_C_NAME**: The Explanation Of Benefits group code category ID for the transaction�from insurance payment posting.
- **PEOB_DUP_DENIAL_C_NAME**: This item contains the duplicate denial reason calculated at the time the  payment is distributed to the invoice. It is populated only when a duplicate denial (Remittance code external ID=18) is present.

### REL_CAUSE_CD
**Table**: All values associated with a claim are stored in the Claim External Value record.  The REL_CAUSE_CD table holds codes indicating whether the claim is related to employment or an accident.
- **RECORD_ID**: The unique identifier for the claim record.
- **LINE**: The line number for the information associated with this contact. Multiple pieces of information can be associated with this contact.
- **REL_CAUSE_CD**: This item holds the codes to identify if the claim is related to employment or to an accident.

### SVC_LN_INFO
**Table**: All values associated with a claim are stored in the Claim External Value record.  The SVC_LN_INFO table holds information about the service lines on the claim.
- **RECORD_ID**: The unique identifier for the claim record.
- **LINE**: The line number for the information associated with this contact. Multiple pieces of information can be associated with this contact.
- **LN_FROM_DT**: This item holds the earliest service date represented on the line.
- **LN_TO_DT**: This item holds the latest service date represented on the line. It will not be populated if the line only represents a single date.
- **LN_PROC_QUAL**: This item holds a code identifying the type of procedure code reported on the line.
- **LN_PROC_CD**: This item holds the procedure code for the line.
- **LN_PROC_DESC**: This item holds a procedure specific description for the line.
- **LN_PROC_MOD**: This item holds a comma delimited list of modifiers for the procedure on the line.
- **LN_QTY_QUAL**: This item holds a code identifying the unit in which the quantity is reported.
- **LN_QTY**: This item holds the quantity for the service line.
- **LN_AMT**: This item holds the billed amount for the line.  For Uniform Billing (UB) claims, this amount will include both covered and non-covered amounts.
- **LN_REV_CD**: This item holds the revenue code for the service line.
- **LN_REV_CD_DESC**: This item holds a revenue code specific description for the line.
- **LN_RATE**: This item holds the daily rate for accommodation revenue code lines.
- **LN_NON_CVD_AMT**: This item holds the non-covered amount for the line.
- **LN_POS_CD**: This item holds the place of service code identifying where the service on the line was performed.
- **LN_DX_PTR**: This item holds a comma delimited list of diagnosis pointers. Each piece of the string is a line number from the claim diagnosis table.
- **LN_EMERG_IND**: This item identifies the service on the line as an emergency service.
- **LN_EPSDT_IND**: This item identifies the service on the line as an Early & Periodic Screening, Diagnosis, and Treatment (EPSDT) service.
- **LN_FAM_PLAN_IND**: This item identifies the service on the line as a family planning service.
- **LN_COPAY_STAT_CD**: This item identifies when the patient was exempt from a copay for the service on the line.
- **LN_AMB_PAT_CNT**: This item holds the number of patients transported in the ambulance when the line represents an ambulance service.
- **LN_MAMM_CERT_NUM**: This item holds the mammography certification number for the line.
- **LN_CLIA_NUM**: This item holds the Clinical Laboratory Improvement Amendment (CLIA) number for the line.
- **LN_ORAL_CAV_CD**: This item holds a comma delimited list of oral cavity codes for the line.
- **LN_DENT_PROSTHESIS**: This item holds a code to indicate the initial placement or replacement of a dental prosthesis, crown, or inlay.
- **LN_DME_CMN_CD**: This item holds a code describing how the certificate of medical necessity (CMN) for the line was transmitted to the DMERC.
- **LN_DME_CERT_TYP**: This item identifies the type of certification (initial, renewal, or revised) applies to the line.
- **LN_DME_DURATION**: This item holds the number of months the durable medical equipment (DME) supplies will be needed.
- **LN_DME_RECERT_DT**: This item holds the new durable medical equipment (DME) certification date when the certification type is renewed or revised.
- **LN_CME_BEG_THRPY_DT**: This item holds the date that therapy requiring the durable medical equipment (DME) began.
- **LN_DME_COND_IND**: This item holds a comma delimited list of durable medical equipment (DME) condition codes for the service line.
- **LN_CNTRCT_TYP**: This item holds a code representing the type of contract between the provider and the payer used for the service line.
- **LN_CNTRCT_AMT**: This item holds the contract amount for the line.
- **LN_CNTRCT_PCT**: This item holds the contract percentage for the line.
- **LN_CNTRCT_CD**: This item holds a code representing the line.
- **LN_CNTRCT_DISCNT_P**: This item holds the discount percentage for the line.
- **LN_CNTRCT_VERS_ID**: This item identifies the version of the contract used for the line.
- **LN_NDC**: This item holds the National Drug Code (NDC) for the service line.
- **LN_NDC_UNIT_QTY**: This item holds the quantity associated with the National Drug Code (NDC), in terms of the units reported with the NDC.
- **LN_NDC_UNIT**: This item holds the units associated with the National Drug Code (NDC).
- **LN_RX_NUM_QUAL**: This item holds a code distinguishing prescription numbers from sequence numbers used to represent compound drugs.
- **LN_RX_NUM**: This item holds the prescription number for the line.
- **LN_NOTE**: This item holds a line level note.
- **LN_REND_PROV_TYP**: This item indicates whether the rendering provider on the line is a person or a non-person.
- **LN_REND_NAM_LAST**: This item holds the rendering provider's last name (if a person) or the organization name (if a non-person).
- **LN_REND_NAM_FIRST**: This item holds the rendering provider's first name. It is only populated when the provider is a person.
- **LN_REND_NAM_MID**: This item holds the rendering provider's middle name. It is only populated when the provider is a person.
- **LN_REND_NAM_SUF**: This item holds the suffix to the rendering provider's name (Jr, III, etc). It is only populated when the provider is a person.
- **LN_REND_NPI**: This item holds the rendering provider's National Provider Identifier (NPI).
- **LN_REND_TAXONOMY**: This item holds the rendering provider's taxonomy code.
- **LN_SVC_FAC_NAM**: This item holds the name of the external location where the services were performed.
- **LN_SVC_FAC_NPI**: This item holds the National Provider Identifier (NPI) of the external location where the services were performed.
- **LN_SVC_FAC_ADDR_1**: This item holds the first line of the external location street address.
- **LN_SVC_FAC_ADDR_2**: This item holds the second line of the external location street address.
- **LN_SVC_FAC_CITY**: This item holds the external location's city.
- **LN_SVC_FAC_STATE**: This item holds the external location's state.
- **LN_SVC_FAC_ZIP**: This item holds the external location's ZIP code.
- **LN_SVC_FAC_CNTRY**: This item holds the external location's country. It is only populated if the address is outside the United States.
- **LN_SVC_FAC_CNTRY_SU**: This item holds the external location's country subdivision (state, province, etc). It is only populated if the address is outside the United States.
- **LN_SUP_NAM_LAST**: This item holds the supervising provider's last name.
- **LN_SUP_NAM_FIRST**: This item holds the supervising provider's first name.
- **LN_SUP_NAM_MID**: This item holds the supervising provider's middle name.
- **LN_SUP_NAM_SUF**: This item holds the suffix to the supervising provider's name (Jr, III, etc).
- **LN_SUP_NPI**: This item holds the supervising provider's National Provider Identifier (NPI).
- **LN_ORD_NAM_LAST**: This item holds the ordering provider's last name.
- **LN_ORD_NAM_FIRST**: This item holds the ordering provider's first name.
- **LN_ORD_NAM_MID**: This item holds the ordering provider's middle name.
- **LN_ORD_NAM_SUF**: This item holds the suffix to the ordering provider's name (Jr, III, etc).
- **LN_ORD_NPI**: This item holds the ordering provider's National Provider Identifier (NPI).
- **LN_ORD_ADDR_1**: This item holds the first line of the ordering provider's street address.
- **LN_ORD_ADDR_2**: This item holds the second line of the ordering provider's street address.
- **LN_ORD_CITY**: This item holds the ordering provider's city.
- **LN_ORD_STATE**: This item holds the ordering provider's state.
- **LN_ORD_ZIP**: This item holds the ordering provider's ZIP code.
- **LN_ORD_CNTRY**: This item holds the ordering provider's country. It is only populated if the address is outside the United States.
- **LN_ORD_CNTRY_SUB**: This item holds the ordering provider's country subdivision (state, province, etc). It is only populated if the address is outside the United States.
- **LN_PURCH_PROV_TYP**: This item indicates whether the purchased service provider on the line is a person or a non-person.
- **LN_PURCH_NPI**: This item holds the purchased service provider's National Provider Identifier (NPI).
- **LN_ASST_TYP**: This item indicates whether the assistant dental surgeon on the line is a person or a non-person.
- **LN_ASST_NAM_LAST**: This item holds the assistant dental surgeon's last name (if a person) or the organization name (if a non-person).
- **LN_ASST_NAM_FIRST**: This item holds the assistant dental surgeon's first name. It is only populated when the provider is a person.
- **LN_ASST_NAM_MID**: This item holds the assistant dental surgeon's middle name. It is only populated when the provider is a person.
- **LN_ASST_NAM_SUF**: This item holds the suffix to the assistant dental surgeon's name (Jr, III, etc). It is only populated when the provider is a person.
- **LN_ASST_NPI**: This item holds the assistant dental surgeon's National Provider Identifier (NPI).
- **LN_ASST_TAXONOMY**: This item holds the assistant dental surgeon's taxonomy code.
- **LN_DOC_TYP**: This item holds a code indicating the type of supporting document included with the service line.
- **LN_DOC_FORM_ID**: This item identifies the specific document. For example, this can identify the version number of a questionnaire so that the payer can correctly interpret the responses.

### SVC_LN_INFO_2
**Table**: All values associated with a claim are stored in the Claim External Value record. The SVC_LN_INFO_2 table holds information about the service lines on the claim.
- **RECORD_ID**: The unique identifier for the claim record.
- **LINE**: The line number for the information associated with this contact. Multiple pieces of information can be associated with this contact.
- **LN_TOS**: This item holds the type of service for the procedure on the service line.
- **LN_DATE_QUAL**: This item holds a qualifier to distinguish between a single date (when the from and to dates are the same) and a date range (when the from and to dates are different).
- **LN_PURCH_SERV_AMT**: This item holds the purchased service charge amount for the line.
- **LN_REFERRING_CLIA**: This item holds the Clinical Laboratory Improvement Amendment (CLIA) number of the referring lab for the line.
- **LN_HOSPICE_EMP_IND**: This item holds the Hospice Employee Indicator.
- **LN_HOSPICE_COND_IND**: This item holds the Hospice Condition Indicator.
- **LN_TTL_AMT_PAID**: This item holds the total amount paid for the line by all payers. This item is populated for both paper and electronic Professional Billing Centers for Medicare and Medicaid Services (CMS) claims but is only used when printing paper claims.
- **LN_ADJR_ITM_REF_NUM**: This item stores the Adjusted Repriced Line Item Reference Number.
- **LN_SERV_TAX_AMT**: This item stores the line's Service Tax Amount.
- **LN_FAC_TAX_AMT**: This item stores the line's Facility Tax Amount.
- **LN_REP_ITM_REF_NUM**: This item stores the Repriced Line Item Reference Number.
- **LN_PRC_METHOD**: This item stores the Line Pricing Methodology.
- **LN_ALLOWED_AMT**: This item stores the Line Allowed Amount.
- **LN_SAVINGS_AMT**: This item stores the Line Savings Amount.
- **LN_REP_ORG_ID**: This item stores the Line Repricing Organization Identification Number.
- **LN_PRICING_RATE**: This item stores the Line Pricing Rate.
- **LN_APPRVED_DRG_CODE**: This item stores the Line's Approved diagnosis related group (DRG) Code.
- **LN_APP_DRG_AMT**: This item stores the Line Approved diagnosis related group (DRG) Code.
- **LN_APP_REV_CODE**: This item stores the Line Approved Revenue Code.
- **LN_REPAPR_HCPCS_QL**: This item stores the Line Repriced Approved Healthcare common Procedure Coding System (HCPS).
- **LN_REPAPP_HCPCS**: This item stores the Line Repriced Approved (Healthcare Common Procedure Coding System (HCPCS) Code.
- **LN_UNIT_MSRMNT_CODE**: This item stores the Line Unit or Basis for Measurement Code.
- **LN_APR_SVC_UNT**: This item stores the Line Approved Service Units or Inpatient Days.
- **LN_OPR_SER_ETQ**: This item stores the Entity Type Qualifier for line's Operating Physician ID.
- **LN_OPR_LAST_NAME**: This item stores the line's Operating Physician's Last Name.
- **LN_OPR_FIRST_NAME**: This item stores the line's Operating Physician's First Name.
- **LN_OPR_MID_NAME**: This item stores the line's Operating Physician's Middle Name.
- **LN_OPR_NAME_SUFFIX**: This item stores the line's Operating Physician's Name Suffix.
- **LN_OPR_NPI**: This item stores the line's Operating Physician's ID.
- **LN_OTH_OPR_ETQ**: This item stores the qualifier for line's Other Operating Physician.
- **LN_OTH_OPR_LAST_NM**: This item stores the line's Other Operating Physician's Last Name.
- **LN_OTH_OPR_FIRST_NM**: This items stores the line's Other Operating Physician's First Name.
- **LN_OTH_OPR_MID_NM**: This item stores the line's Other Operating Physician's Middle Name.
- **LN_OTH_OPR_SUF_NM**: This item stores the line's Other Operating Physician's Name Suffix.
- **LN_OTH_OPR_NPI**: This item stores the line's Other Operating Physician ID.
- **LN_REF_ETQ**: This item stores the line's Referring Provider's Entity Type Qualifier.
- **LN_REF_LAST_NM**: This item stores the line's Referring Provider's Last Name.
- **LN_REF_FIRST_NM**: This item stores line's Referring Provider's First Name.
- **LN_REF_MID_NM**: This item stores the line's Referring Provider's Middle Name.
- **LN_REF_SUFFIX_NM**: This item stores the line's Referring Provider's Name Suffix.
- **LN_REF_NPI**: This item stores the line's Referring Provider's National Provider Identifier (NPI).
- **LN_DME_PROC_CD**: Stores Line durable medical equipment (DME) Procedure Code
- **LN_DME_QTY**: Stores Line durable medical equipment (DME) Length of Medical Necessity
- **LN_DME_RENTAL_PRICE**: Stores Line durable medical equipment (DME) Rental Unit Price Indicator
- **LN_DME_PUR_PRICE**: Stores Line durable medical equipment (DME) Purchase Price
- **LN_DME_RUP_IND**: Stores Line DME Rental Unit Price Indicator
- **LN_AMB_PAT_WT**: Stores Line Ambulance Patient Weight
- **LN_AMB_TRANS_RSN_CD**: Stores Line Ambulance Transport Reason Code
- **LN_AMB_TRANS_DIST**: Stores Line Ambulance Transport Distance
- **LN_AMB_RND_TRIP_DES**: Stores Line Ambulance Round Trip Purpose Description
- **LN_AMB_STRETCH_DESC**: Stores Line Ambulance Stretcher Purpose Description
- **LN_RX_DT**: Stores Line Prescription Date
- **LN_LST_CERT_DT**: Stores Line Last Certification Date
- **LN_LST_SEEN_DT**: Stores Line Last Seen Date
- **LN_SHIPPED_DT**: Stores Line Shipped Date
- **LN_LST_XRAY_DT**: Stores Line Last X-Ray Date
- **LN_INIT_TREAT_DT**: Stores Line Initial Treatment Date
- **LN_OBS_ADDL_UNTS**: Stores Line Obstetric Additional Units
- **LN_IMMNZTN_BAT_NUM**: Stores Line Immunization Batch Number
- **LN_SALES_TAX_AMT**: Stores Line Sales Tax Amount
- **LN_POST_CLM_AMT**: Stores Line Postage Claimed Amount
- **LN_ORD_CNCT_NAM**: Stores Line Ordering Provider Contact Name
- **LN_PICK_UP_ADDR_1**: Stores Line Ambulance Pick-Up Location Street Address Line 1
- **LN_PICK_UP_ADDR_2**: Stores Line Ambulance Pick-Up Location Street Address Line 2
- **LN_PICK_UP_CITY**: Stores Line Ambulance Pick-Up Location City
- **LN_PICK_UP_STATE**: Stores Line Ambulance Pick-Up Location State
- **LN_PICK_UP_ZIP**: Stores Line Ambulance Pick-Up Location Zip Code
- **LN_PICK_UP_CNTRY**: Stores Line Ambulance Pick-Up Location Country Code
- **LN_PICK_UP_CNTRY_S**: Stores Line Ambulance Pick-Up Location Country Subdivision Code
- **LN_DROP_OFF_NAME**: Stores Line Ambulance Drop-Off Location Name
- **LN_DROP_OFF_ADDR_1**: Stores Line Ambulance Drop-Off Location Address Line 1
- **LN_DROP_OFF_ADDR_2**: Stores Line Ambulance Drop-Off Location Street Address Line 2
- **LN_DROP_OFF_CITY**: Stores Line Ambulance Drop-Off Location City
- **LN_DROP_OFF_STATE**: Stores Line Ambulance Drop-Off Location State
- **LN_DROP_OFF_ZIP**: Stores Line Ambulance Drop-Off Location Zip
- **LN_DROP_OFF_CNTRY**: Stores Line Ambulance Drop-Off Location Country Code
- **LN_DROP_OFF_CNTRY_S**: Stores Line Ambulance Drop-Off Location Country Subdivision Code
- **LN_SVC_FAC_IDEN**: Stores line service facility location's entity identifier
- **LN_RECERT_DT**: Store line recertification date
- **LN_QTY_TXT**: This item holds the units of quantity string for a service line.
- **LN_NOTE_TPO**: This item holds a line level third party organization note.
- **LN_PURCH_SERV_REF**: This item holds the purchased service reference identifier for the line.
- **LN_DME_LAST_CERT_DT**: The last certification date for a durable medical equipment (DME) to be printed on the claim.
- **LN_REF_ENTITY_IDENTIFIER_CODE**: This item stores the line's referring provider's entity identifier code.
- **LN_FILL_NUMBER**: The code indicating whether the prescription is an original or a refill.
- **LN_DAYS_SUPPLY**: Estimated number if days the prescription will last.
- **LN_DAW_CODE**: Code indicating whether or not the prescriber's instructions regarding generic substitution were followed.
- **LN_NDC_COST**: This item holds the unit cost associated with the National Drug Code (NDC) for the service line, which is expected to be the charge amount divided by the NDC quantity.
- **LN_MCR_PAID_AMT**: This is the amount that Medicare paid for the service line for field.
- **LN_OTHR_PAID_AMT**: This is the amount that the commercial coverage, if any, paid for this service line.

### SVC_LN_INFO_3
**Table**: All values associated with a claim are stored in the Claim External Value record. The SVC_LN_INFO_3 table holds information about the service lines on the claim.
- **RECORD_ID**: The unique identifier for the claim value record
- **LINE**: The line number for the information associated with this record. Multiple pieces of information can be associated with this record.
- **LN_INGRED_COST_PAID**: Drug ingredient cost paid.
- **LN_DISP_FEE_PAID**: Dispensing fee paid.
- **LN_PAT_PAY_AMT**: Patient pay amount.
- **LN_COPAY_AMT**: Amount of patient copay.
- **LN_COINS_AMT**: Amount of patient coinsurance.
- **LN_DEDUCT_AMT**: Amount of patient deductible.
- **LN_REGLTRY_FEE_AMT**: Flat sales tax amount paid.
- **LN_PCT_TAX_AMT**: Percentage tax amount paid.
- **LN_INCENTIVE_AMT**: Incentive amount paid.
- **LN_OTHR_AMT_RECOGZ**: Total amount recognized by the processor of any payment from another source.
- **LN_NET_AMT_DUE**: Net amount paid to provider by the payer.
- **LN_DENT_PROS_QUAL**: This item holds a code indicating if the date for a prior crown/prosthesis is estimated or exact.
- **LN_DENT_PROS_DATE**: The date a prior crown/prosthesis was previously placed.
- **SVC_DENIED_STATUS_IDENT**: This stores the external identifier for the denial status of this line.
- **PRCS_IND_CD**: Claim line level processing indicator code.
- **PRCS_IND_CD_DESC**: Claim line level processing indicator code description.
- **LN_OPR_TAXONOMY**: Stores the Line Operating Provider Taxonomy Code.
- **LN_APPLIANCE_REPLACEMENT_DATE**: The date when an orthodontic appliance was replaced.
- **LN_TREATMENT_START_DATE**: The date of the initial treatment for a dental service.
- **LN_TREATMENT_COMPLETION_DATE**: The date of the completed treatment for a dental service.
- **LN_FILL_STATUS**: Stores information on whether the prescription was completely or partially filled.
- **LN_ORD_TAXONOMY**: Stores the National Uniform Claim Committee (NUCC) taxonomy code associated with the line-level operating provider
- **LN_APPLIANCE_PLACEMENT_DATE**: The date when the orthodontic appliance was placed.
- **LN_LIN_QUALIFIER**: Qualifier code to identify drug code set or the type/source of the descriptive number used in Product/Service ID.
- **LN_PRESC_PROV_NPI**: This column holds the National Provider Identifier (NPI) of the provider that prescribed the medication on this service.
- **LN_PRESC_PROV_TAXONOMY**: This column holds the NUCC Taxonomy Code of the provider that prescribed the medication on this service.
- **LN_SERV_PROV_NPI**: This item holds the National Provider Identifier (NPI) of the pharmacy that filled the prescription.
- **LN_SERV_PROV_TAXONOMY**: This column holds the NUCC Taxonomy Code of the pharmacy that filled the prescription.
- **LN_DX_PTR_RANK**: The comma-delimited list of diagnoses ranks for each diagnosis on a service. Each position here corresponds to the same comma-delimited position of the column LN_DX_PTR from the SVC_LN_INFO table.  The rank here specifies the ranking of diagnoses for the specific service. This can be different than the rank of the same diagnoses at the header-level or even the same diagnoses for a different service.
- **LN_PCP_REF_LAST_NM**: This item stores the line's PCP referring provider's last name.
- **LN_PCP_REF_FIRST_NM**: This item stores the line's PCP referring provider's first name.
- **LN_PCP_REF_MID_NM**: This item stores the line's PCP referring provider's middle name.
- **LN_PCP_REF_SUFFIX_NM**: This item stores the line's PCP referring provider's suffix.
- **LN_PCP_REF_NPI**: This item stores the line's PCP referring provider's NPI.
- **RX_DATE**: The date when the prescription was written.
- **SUB_CLAR_CODE**: The code indicating that the pharmacist is clarifying the submission.
- **RX_ORIGIN_CODE**: The code indicating the origin of the prescription.
- **RX_PHARM_SRV_TYPE**: The type of service being performed by a pharmacy when different contractual terms exist between a payer and the pharmacy, or when benefits are based upon the type of service performed.
- **RX_PROD_DESC**: The description of the product being submitted on the prescription claim.
- **OTHER_CVG_CODE**: The code indicating whether or not the patient has other insurance coverage.
- **RX_SERVICE_LEVEL**: The code indicating the type of service the provider rendered.
- **QTY_PRESCRIBED**: The quantity of prescription drug expressed in metric decimal units.
- **REASON_SVC_CODE**: The code identifying the type of utilization conflict detected or the reason for the pharmacist's professional service.
- **PROF_SRVC_CODE**: The code identifying pharmacist intervention when a conflict code has been identified or service has been rendered.
- **RES_SVC_CODE**: The code describing a pharmacist's action in response to a professional conflict.
- **LEVEL_OF_EFFORT**: The code indicating the level of effort as determined by the complexity of decision-making or resources utilized by a pharmacist to perform a professional service.
- **DOSAGE_FORM_DESC_CD**: The dosage form of the complete compound mixture.
- **DISP_UNIT_FORM_INDICATOR**: The NCPDP standard product billing codes.
- **ADMIN_ROUTE**: An override to the "default" route referenced for the product. For a multi-ingredient compound, it is the route of the complete compound mixture.
- **INGREDIENT_COMPOUND_CNT**: The count of compound product IDs (both active and inactive) in the compound mixture submitted.
- **USUAL_CUSTOMARY_CHG**: The amount charged to cash customers for the prescription exclusive of sales tax or other amounts claimed.
- **COST_BASIS**: The code indicating the method used to calculate the ingredient cost.
- **INGREDIENT_COST_SUBMITTED**: The product component cost of the dispensed prescription.
- **DISP_FEE_SUBMITTED**: The dispensing fee submitted by the pharmacy.
- **PROF_FEE_SUBMITTED**: The amount submitted by the provider for professional services rendered.
- **INGREDIENT_AMT_SUBMITTED**: The amount representing the fee that is submitted by the pharmacy for contractually agreed upon services.
- **OTHER_AMT_SUBMITTED**: The amount representing the additional incurred costs for a dispensed prescription or service.
- **GROSS_AMOUNT_DUE**: The total gross amount submitted on the claim.

### SVC_PMT_HISTORY
**Table**: The SVC_PMT_HISTORY table contains line level history for how a payment was processed.
- **TX_ID**: The unique identifier for the transaction Record.
- **GROUP_LINE**: The line number for the information associated with this record.
- **VALUE_LINE**: The line number of one of the multiple values associated with a specific group of data within this record.
- **SVC_PMT_HISTORY_C_NAME**: Contains a line level action that was taken for the payment.

### TX_DIAG
**Table**: This table contains information about the diagnoses associated with transactions. Since one transaction may be associated with multiple diagnoses, each row in this table represents one diagnosis and is identified by the transaction ID and line number. The first six diagnosis IDs associated with a transaction are recorded in the CLARITY_TDL table in the columns DX_ ONE_ID through DX_ SIX_ID. This table allows you to easily identify transactions with a specific diagnosis code or range of diagnosis codes. The data for this table is extracted using a KB_SQL query.
- **TX_ID**: The unique accounts receivable transaction record ID.
- **LINE**: Line number to identify each row of diagnosis data associated with an individual transaction. Line 1 identifies the primary diagnosis of the charge.
- **POST_DATE**: The post date of the charge transaction
- **SERV_AREA_ID**: The ID of the service area associated with the transaction identified by TX_ID.
- **DX_ID**: The diagnosis associated with the charge transaction.  This diagnosis is from the primary codeset.
- **DX_QUALIFIER_C_NAME**: Diagnosis Qualifier for the diagnosis associated with this charge

### TX_NDC_INFORMATION
**Table**: This table contains Medical National Drug Code (NDC) information. Since one transaction may be associated with multiple NDC codes, each row in this table represents one NDC code and is identified by the transaction ID and line number. The data for this table is extracted using a KB_SQL query.
- **TX_ID**: The unique accounts receivable transaction record ID.
- **LINE**: Line number to identify each row of�Medical National Drug Code (NDC) data associated with an individual transaction.
- **NDC_CODES_ID**: The ID of the Medical National Drug Code (NDC) associated with a transaction.
- **NDC_CODES_ID_NDC_CODE**: The external code for the National Drug Code (NDC). An NDC represents packages of medications.
- **NDC_CODES_ADMIN_AMT**: The NDC amount associated with this charge.
- **NDC_CODES_UNIT_C_NAME**: The Medical National Drug Code (NDC) unit associated with the charge.

## Sample Data (one representative non-null value per column)

### ACCOUNT
- ACCOUNT_ID = `4793998`
- ACCOUNT_NAME = `MANDEL,JOSHUA C`
- CONTACT_PERSON = `MANDEL,JOSHUA C`
- BIRTHDATE = `10/26/1982 12:00:00 AM`
- SEX = `M`
- IS_ACTIVE = `Y`
- CITY = `MADISON`
- STATE_C_NAME = `Wisconsin`
- ZIP = `REDACTED`
- HOME_PHONE = `617-894-1015`
- ACCOUNT_TYPE_C_NAME = `Personal/Family`
- SERV_AREA_ID = `18`
- FIN_CLASS_C_NAME = `Blue Cross`
- TOTAL_BALANCE = `0`
- INSURANCE_BALANCE = `0`
- PATIENT_BALANCE = `0`
- LAST_INS_PMT_DATE = `10/23/2023 12:00:00 AM`
- LAST_PAT_PMT_DATE = `5/17/2023 12:00:00 AM`
- LAST_PAT_PMT_AMT = `139.97`
- LAST_STMT_DATE = `4/26/2023 12:00:00 AM`
- EPIC_ACCT_ID = `1810018166`
- HOM_CLARITY_FLG_YN = `Y`
- HB_BALANCE = `0`
- HB_PREBILL_BALANCE = `0`
- HB_INSURANCE_BALAN = `0`
- HB_SELFPAY_BALANCE = `0`
- HB_BADDEBT_BALANCE = `0`
- HB_UNDISTRIB_BAL = `0`
- HB_LAST_INS_PMT_DT = `4/26/2022 12:00:00 AM`
- HB_LAST_SP_PMT_DT = `5/11/2022 12:00:00 AM`
- SBO_HSP_ACCOUNT_ID = `4307315`
- EMPR_ID_CMT = `Microsoft`
- PAT_REC_OF_GUAR_ID = `Z7004242`
- HB_BD_SELFPAY_BAL = `0`
- HB_BD_INSURANCE_BAL = `0`
- HB_BD_UNDISTRIB_BAL = `0`
- COUNTY_C_NAME = `DANE`
- COUNTRY_C_NAME = `United States of America`
- EMPY_STAT_C_NAME = `Full Time`
- GUAR_EMP_CNTRY_C_NAME = `United States of America`
- GUAR_VERIF_ID = `68534786`

### ACCOUNT_2
- ACCT_ID = `4793998`
- LAST_BILLED_AMT = `139.97`
- LAST_INS_BAL = `0`
- LAST_CLAIM_DATE = `10/13/2023 12:00:00 AM`
- FOL_UP_LAST_LET_DT = `5/17/2023 12:00:00 AM`
- UNDIST_CREDIT_BAL = `0`
- UNDIST_INS_CR_BAL = `0`
- UNDIST_SP_CR_BAL = `0`
- DIST_LATER_COUNT = `0`
- STMT_HOLD_DT = `1/11/2023 12:00:00 AM`
- MOBILE_PHONE = `REDACTED`
- PMT_PLAN_DLQ_AMT = `0`
- PMT_PLAN_DUE_AMT = `0`
- PMT_PLAN_PAID_AMT = `0`
- PMT_PLAN_REMAIN_AMT = `0`
- HB_EXT_AR_SELF_PAY_BAL = `0`
- HB_EXT_AR_INS_BAL = `0`
- HB_EXT_AR_UNDIST_BAL = `0`
- ADDR_CHG_USER_ID = `MYCHARTG`
- ADDR_CHG_USER_ID_NAME = `MYCHART, GENERIC`
- ADDR_CHG_INSTANT_DTTM = `11/14/2022 4:57:24 PM`
- ADDR_CHG_SOURCE = `(EPT) MANDEL,JOSHUA C [  Z7004242]`
- PB_SELF_PAY_BAL_UPDATE_DATE = `5/17/2023 12:00:00 AM`
- HB_SELF_PAY_BAL_UPDATE_DATE = `5/11/2022 12:00:00 AM`

### ACCOUNT_3
- ACCOUNT_ID = `4793998`

### ACCOUNT_CONTACT
- ACCOUNT_ID = `1810018166`
- LINE = `1`
- CONTACT_DATE = `8/13/2018 12:00:00 AM`
- USER_ID = `BLB403`
- USER_ID_NAME = `BRIGGS, BECKY`
- CONTACT_STATUS_C_NAME = `Inquiry`
- FOL_UP_CUR_INS_BAL = `151`
- FOL_UP_CUR_PAT_BAL = `0`
- LETTER_STATUS_C_NAME = `Printed`
- NOTE_ID = `3899651265`
- FOL_UP_NOTE = `Account status: Refer to Financial Services`
- LETTER_NAME = `ZAPL SMALL BALANCE LETTER ; EAR: 1810018166`

### ACCOUNT_CONTACT_2
- ACCT_ID = `1810018166`
- LINE = `1`
- PAY_PLAN_SOURCE_C_NAME = `Hyperspace`

### ACCOUNT_CREATION
- ACCT_ID = `4793998`
- CONTACT_DATE_REAL = `66157`
- CONTACT_DATE = `8/9/2018 12:00:00 AM`
- CONTACT_NUM = `1`
- ACCOUNT_CREATOR = `JULIE M SUTTER`

### ACCT_ADDR
- ACCOUNT_ID = `4793998`
- ADDRESS_LINE = `1`
- ADDRESS = `REDACTED`

### ACCT_COVERAGE
- ACCOUNT_ID = `4793998`
- LINE = `1`
- COVERAGE_ID = `5934765`

### ACCT_GUAR_PAT_INFO
- ACCOUNT_ID = `4793998`
- LINE = `1`
- PAT_ID = `Z7004242`
- GUAR_REL_TO_PAT_C_NAME = `Self`
- PATIENT_ADDR_LINKED_YN = `Y`

### ACCT_HOME_PHONE_HX
- ACCOUNT_ID = `4793998`
- LINE = `1`
- CHANGE_DATE = `11/14/2022 12:00:00 AM`
- PHONE_NUMBER = `617-894-1015`
- CHANGE_SOURCE_C_NAME = `Chronicles`

### ACCT_TX
- ACCOUNT_ID = `1810018166`
- LINE = `1`
- TX_ID = `129124216`

### ARPB_AUTH_INFO
- TX_ID = `302543307`
- LINE = `1`
- OVRD_AUTH_CVG_ID = `5934765`
- AUTH_UPDATE_DTTM = `12/20/2022 8:37:45 PM`

### ARPB_CHG_ENTRY_DX
- TX_ID = `129124216`
- LINE = `1`
- DX_ID = `513616`
- DX_QUALIFIER_C_NAME = `Active`

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

### ARPB_TRANSACTIONS2
- TX_ID = `129124216`
- EB_PMT_TOTAL_AMT = `7.82`
- VST_DO_NOT_BIL_I_YN = `N`
- TX_ENTERED_INSTANT_DTTM = `12/20/2022 4:11:35 PM`
- CVG_PLAN_ON_PMT_ID = `130204`
- STMT_HOLD_DT = `1/11/2023 12:00:00 AM`
- STMT_HOLD_REASON_C_NAME = `Transaction skip function`
- REPOST_REASON_C_NAME = `Charge Correct`
- OUTST_CLM_STAT_C_NAME = `Not Outstanding`
- POS_TYPE_C_NAME = `Telehealth - Provided Other than in Patient's Home`
- INACTIVE_TYPE_C_NAME = `Voided`
- VOIDED_INS_AMT = `315`
- PROV_NETWORK_STAT_C_NAME = `In Network`
- NETWORK_LEVEL_C_NAME = `Blue`
- ADJUSTMENT_CAT_C_NAME = `Contractual`
- WRITE_OFF_RSN_C_NAME = `Contractual`
- MANUAL_PRICE_OVRIDE_YN = `N`
- IS_PRE_SERVICE_PMT_YN = `N`
- FIRST_ETR_TX_ID = `355871699`
- POSTING_DEPARTMENT_ID = `1700801002`
- EXP_REIMB_SRC_C_NAME = `System Calculated`
- STMT_HOLD_RSN_TEXT = `83550000||s result=$$skip^KPZMTSTAPL(etrId)||1`

### ARPB_TRANSACTIONS3
- TX_ID = `129124216`
- EB_PMT_HTT_ID = `772942581`
- PRIM_TIMELY_FILE_DEADLINE_DATE = `3/26/2024 12:00:00 AM`
- PAT_PMT_COLL_WKFL_C_NAME = `Payment Posting`
- EB_TX_SOURCE_C_NAME = `Electronic Remittance`

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

### ARPB_TX_CHG_REV_HX
- TX_ID = `129124216`
- LINE = `1`
- CR_HX_USER_ID = `PICONEMA`
- CR_HX_USER_ID_NAME = `PICONE, MARY A`
- CR_HX_DATE = `7/14/2020 12:00:00 AM`
- CR_HX_TIME = `1/1/1900 2:48:00 PM`
- CR_HX_ACTIVITY_C_NAME = `Entry`
- CR_HX_CONT_LINE_YN = `N`

### ARPB_TX_MATCH_HX
- TX_ID = `129124216`
- LINE = `1`
- MTCH_TX_HX_DT = `9/17/2020 12:00:00 AM`
- MTCH_TX_HX_ID = `213432121`
- MTCH_TX_HX_AMT = `113.3`
- MTCH_TX_HX_INS_AMT = `113.3`
- MTCH_TX_HX_PAT_AMT = `19.89`
- MTCH_TX_HX_COMMENT = `Takeback matched to ETR 317165897`
- MTCH_TX_HX_UN_DT = `12/20/2022 12:00:00 AM`
- MTCH_TX_HX_D_CVG_ID = `5934765`
- MTCH_TX_HX_DSUSR_ID = `KJG400`
- MTCH_TX_HX_DSUSR_ID_NAME = `GILBECK, KAYLA J`
- MTCH_TX_HX_UDUSR_ID = `HIRZYHL`
- MTCH_TX_HX_UDUSR_ID_NAME = `HIRZY, HEIDI L`
- MTCH_TX_HX_INV_NUM = `L1004718920`
- MTCH_TX_HX_UN_CV_ID = `5934765`
- MTCH_TX_HX_LINE = `1`
- MTCH_TX_HX_DTTM = `9/17/2020 1:19:00 PM`
- MTCH_TX_HX_UN_DTTM = `12/20/2022 8:37:00 PM`

### ARPB_TX_MODERATE
- TX_ID = `129124216`
- ORIGINATING_TAR_ID = `743463928`
- SOURCE_TAR_ID = `743463928`
- SRC_TAR_CHG_LINE = `1`
- PAT_AGING_DATE = `1/11/2023 12:00:00 AM`
- INS_AGING_DATE = `10/12/2023 12:00:00 AM`
- HOSP_ACCT_ID = `10686227`
- ORDER_ID = `945468367`
- REFERENCE_NUM = `3197481824`
- PMT_RECEIPT_NUM = `8141265`
- REFERRAL_PROV_ID = `144590`
- REFERRAL_PROV_ID_REFERRING_PROV_NAM = `RAMMELKAMP, ZOE L`
- INSURANCE_AMT_PAID = `330`
- WRITEOFF_EXCEPT_C_NAME = `Yes`
- ORIG_PRICE = `330`
- COVERAGE_PLAN_ID = `130204`
- ORIGINAL_AMT_COPAY = `0`
- BAD_DEBT_CHG_YN = `N`
- FIRST_SELFPAY_DATE = `10/23/2023 12:00:00 AM`
- CLAIM_ID = `4128938`
- EOB_UPDATED_DT = `10/23/2023 12:00:00 AM`
- START_TIME = `1/1/1900 2:32:00 PM`
- SERVICE_TIME = `1/1/1900 2:32:00 PM`
- TYPE_OF_SERVICE_C_NAME = `Medical Care`
- DX_PRIM_CODESET_C_NAME = `ICD-10-CM`
- DX_ALT_CODESET_C_NAME = `ICD-9-CM`
- START_DATE = `8/29/2022 12:00:00 AM`

### ARPB_TX_MODIFIERS
- ETR_ID = `129124216`
- LINE = `1`
- EXT_MODIFIER = `MCP`

### ARPB_TX_STMCLAIMHX
- TX_ID = `129124216`
- LINE = `1`
- BC_HX_TYPE_C_NAME = `Claim`
- BC_HX_DATE = `10/13/2023 12:00:00 AM`
- BC_HX_COVERAGE_ID = `5934765`
- BC_HX_ASSIGNED_YN = `Y`
- BC_HX_AMOUNT = `330`
- BC_HX_INVOICE_NUM = `L1008016200`
- BC_HX_PAYMENT_AMT = `330`
- BC_HX_PAYMENT_DATE = `10/23/2023 12:00:00 AM`
- BC_HX_PAYOR_ID = `1302`
- BC_HX_RESUBMIT_DATE = `12/20/2022 12:00:00 AM`
- BC_HX_CLM_DB_ID = `4128938`
- BC_HX_BO_PROC_ID = `23870`
- BC_HX_ACCEPT_DATE = `10/13/2023 12:00:00 AM`
- BC_HX_FIRST_CLM_FLG = `0`
- BC_HX_ACCEPT_DTTM = `10/13/2023 1:06:00 PM`

### ARPB_TX_STMT_DT
- TX_ID = `190635377`
- LINE = `1`
- STATEMENT_DATE = `1/29/2020 12:00:00 AM`

### ARPB_TX_VOID
- TX_ID = `315026147`
- OLD_ETR_ID = `315026147`
- REPOSTED_ETR_ID = `315026147`
- REPOST_TYPE_C_NAME = `Correction`
- DEL_REVERSE_DATE = `12/20/2022 12:00:00 AM`
- DEL_CHARGE_USER_ID = `HIRZYHL`
- DEL_CHARGE_USER_ID_NAME = `HIRZY, HEIDI L`
- DEL_CHARGE_INSTANT = `12/20/2022 2:37:00 PM`

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

### CLARITY_EAP
- PROC_ID = `91`
- PROC_NAME = `AMB REFERRAL TO GASTROENTEROLOGY`

### CLARITY_EAP_3
- PROC_ID = `91`
- PT_FRIENDLY_NAME = `Insertion of needle into vein for collection of blood sample`

### CLARITY_EAP_5
- PROC_ID = `91`

### CLM_DX
- RECORD_ID = `54875409`
- LINE = `1`
- CLM_DX_QUAL = `ABK`
- CLM_DX = `F07.81`

### CLM_NOTE
- RECORD_ID = `81666215`
- LINE = `1`
- CLM_NOTE = `CORRECTED CLAIM`

### CLM_VALUES
- RECORD_ID = `54875409`
- BIL_PROV_TYP_QUAL = `2`
- BIL_PROV_NAM_LAST = `ASSOCIATED PHYSICIANS LLP`
- BIL_PROV_NPI = `1861412785`
- BIL_PROV_TAXONOMY = `193200000X`
- BIL_PROV_TAXID_QUAL = `EI`
- BIL_PROV_TAXID = `391837462`
- BIL_PROV_ADDR_1 = `4410 REGENT ST`
- BIL_PROV_CITY = `MADISON`
- BIL_PROV_STATE = `WI`
- BIL_PROV_ZIP = `53705-4901`
- CLM_CVG_SEQ_CD = `P`
- CLM_CVG_PYR_NAM = `BLUE CROSS WI PPO/FEDERAL`
- CLM_CVG_GRP_NUM = `1000010`
- CLM_CVG_GRP_NAM = `BLUE CROSS OF-BLUE CROSS WI`
- CLM_CVG_FILING_IND = `BL`
- CLM_CVG_PYR_ID_TYP = `PI`
- CLM_CVG_PYR_ID = `BCWI0`
- CLM_CVG_ACPT_ASGN = `A`
- CLM_CVG_AUTH_PMT = `Y`
- CLM_CVG_REL_INFO = `Y`
- PYR_ADDR_1 = `PO BOX 105187`
- PYR_CITY = `ATLANTA`
- PYR_STATE = `GA`
- PYR_ZIP = `30348-5187`
- PAT_NAM_LAST = `MANDEL`
- PAT_NAM_FIRST = `JOSHUA`
- PAT_NAM_MID = `C`
- PAT_MRN = `APL324672`
- PAT_REL_TO_INS = `18`
- PAT_BIRTH_DATE = `10/26/1982 12:00:00 AM`
- PAT_SEX = `M`
- PAT_SIG_ON_FILE = `Y`
- PAT_MAR_STAT = `1`
- PAT_EMPY_STAT = `1`
- PAT_PH = `617-894-1015`
- PAT_ADDR_1 = `REDACTED`
- PAT_CITY = `MADISON`
- PAT_STATE = `WI`
- PAT_ZIP = `REDACTED`
- INV_NUM = `L1007449820`
- ICN = `2022341BT5497`
- TTL_CHG_AMT = `226`
- BILL_TYP_FAC_CD = `11`
- BILL_TYP_FREQ_CD = `1`

### CLM_VALUES_2
- RECORD_ID = `54875409`
- ADMSN_TYP = `3`
- ADMSN_SRC = `1`
- DISCHRG_DISP = `30`
- CLIA_NUM = `52D0393469`
- OUTSIDE_LAB = `N`
- OUTSIDE_LAB_CHG = `0`
- CLM_FROM_DT = `3/11/2022 12:00:00 AM`
- CLM_TO_DT = `3/22/2022 12:00:00 AM`
- ACDNT_DT = `7/12/2020 12:00:00 AM`
- ATT_PROV_NAM_LAST = `GILLESPIE`
- ATT_PROV_NAM_FIRST = `BENJAMIN`
- ATT_PROV_NAM_MID = `T`
- ATT_PROV_NPI = `1841421872`
- ATT_PROV_TAXONOMY = `208100000X`
- REND_PROV_TYP = `1`
- REND_PROV_NAM_LAST = `RAMMELKAMP`
- REND_PROV_NAM_FIRST = `ZOE`
- REND_PROV_NAM_MID = `L`
- REND_PROV_NAM_SUF = `MD`
- REND_PROV_NPI = `1205323193`
- REND_PROV_TAXONOMY = `207R00000X`
- REF_PROV_NAM_LAST = `RAMMELKAMP`
- REF_PROV_NAM_FIRST = `ZOE`
- REF_PROV_NAM_MID = `L`
- REF_PROV_NPI = `1205323193`
- REF_PROV_TAXONOMY = `207R00000X`

### CLM_VALUES_3
- RECORD_ID = `54875409`
- SVC_FAC_NAM = `CLN MAC ASSOCIATED PHYSICIANS LLP`
- SVC_FAC_NPI = `1861412785`
- SVC_FAC_CNCT_PH = `608-233-9746`
- SVC_FAC_ADDR_1 = `4410 REGENT ST`
- SVC_FAC_CITY = `MADISON`
- SVC_FAC_STATE = `WI`
- SVC_FAC_ZIP = `53705-4901`
- CREATE_DT = `3/13/2023 12:00:00 AM`
- CLM_CVG_AMT_PAID = `0`
- CLM_CVG_AMT_DUE = `1638.82`
- CLM_CVG_REL_INFO_DT = `3/2/2023 12:00:00 AM`

### CLM_VALUES_4
- RECORD_ID = `54875409`

### CLM_VALUES_5
- RECORD_ID = `54875409`

### CLM_VALUE_RECORD
- RECORD_ID = `54875409`
- RECORD_CREATION_DT = `3/13/2023 12:00:00 AM`
- CLM_TYP_C_NAME = `CMS Claim`
- FORM_TYP_C_NAME = `Electronic Form`
- SERV_AREA_ID = `18`

### CLP_NON_GRP_TX_IDS
- CLAIM_PRINT_ID = `121445416`
- LINE = `1`
- NON_GROUP_HTR_ID = `670514271`

### CLP_OCCUR_DATA
- CLAIM_PRINT_ID = `121445416`
- LINE = `1`
- OCCURRENCE_CODE_C_NAME = `Onset of Symptoms/Illness`
- OCCURRENCE_DT = `2/17/2022 12:00:00 AM`

### CL_REMIT
- IMAGE_ID = `103811458`
- CREATION_DATE = `9/17/2020 12:00:00 AM`
- SERVICE_AREA_ID = `18`
- PAYMENT_METHOD_C_NAME = `Remittance`
- PAYMENT_TYPE_C_NAME = `Insurance payment`
- REF_IMG_ID = `103811433`
- PAT_ID = `Z7004242`
- CLM_START_DATE = `7/14/2020 12:00:00 AM`
- CLM_END_DATE = `7/14/2020 12:00:00 AM`
- CLP_ID = `123337005`
- IMD_TYPE_C_NAME = `Invoice IMD`

### CL_RMT_CLM_DT_INFO
- IMAGE_ID = `103811458`
- LINE = `1`
- CLAIM_DATE_QUAL_C_NAME = `Received`
- CLAIM_DT = `8/14/2020 12:00:00 AM`

### CL_RMT_CLM_ENTITY
- IMAGE_ID = `103811458`
- LINE = `1`
- ID_CODE_C_NAME = `Patient`
- ENT_QUAL_C_NAME = `Person`
- LAST_NAME_ORG_NAME = `MANDEL`
- FIRST_NAME = `JOSHUA`
- MIDDLE_NAME = `C`
- IDEN_CODE_QUALF_C_NAME = `Member identification number`
- IDEN_CODE = `MSJ602496879`

### CL_RMT_CLM_INFO
- IMAGE_ID = `103811458`
- INV_NO = `L1004718920`
- CLM_STAT_CD_C_NAME = `Processed as Primary`
- CLAIM_CHRG_AMT = `170`
- CLAIM_PAID_AMT = `113.3`
- PAT_RESP_AMT = `554.27`
- CLM_FILING_CODE_C_NAME = `Preferred provider organization (PPO)`
- ICN_NO = `2020228BN6036`
- FAC_CODE_VAL = `13`
- CLAIM_FREQ_C_NAME = `Interim - First Claim`
- DRG_WGT = `0`
- FILE_INV_NUM = `L1004718920`

### CL_RMT_DELIVER_MTD
- IMAGE_ID = `103811458`

### CL_RMT_HC_RMK_CODE
- IMAGE_ID = `192950267`
- LINE = `1`
- LQ_SERVICE_LINE = `1`
- CODE_LST_QUAL_C_NAME = `Claim payment remark codes`
- INDUSTRY_CODE = `MA63`

### CL_RMT_INP_ADJ_INF
- IMAGE_ID = `103811458`

### CL_RMT_OPT_ADJ_INF
- IMAGE_ID = `103811458`

### CL_RMT_PRV_SUM_INF
- IMAGE_ID = `103811458`

### CL_RMT_PRV_SUP_INF
- IMAGE_ID = `103811458`

### CL_RMT_SVCE_LN_INF
- IMAGE_ID = `103811458`
- LINE = `1`
- SERVICE_LINE = `1`
- PROC_IDENTIFIER = `HC:99213:95`
- LINE_ITEM_CHG_AMT = `170`
- PROV_PAYMENT_AMT = `113.3`
- NUBC_REV_CD = `0430`
- UNITS_PAID_CNT = `1`
- ORIG_UNITS_CNT = `0`
- SVC_LINE_CHG_PB_ID = `213432121`

### CL_RMT_SVC_AMT_INF
- IMAGE_ID = `103811458`
- LINE = `1`
- AMT_SVC_LN = `1`
- SVC_AMT_QUAL_C_NAME = `Allowed - Actual`
- SVC_SUPPL_AMT = `113.3`

### CL_RMT_SVC_DAT_INF
- IMAGE_ID = `103811458`
- LINE = `1`
- SVC_DATE_QUAL_C_NAME = `Service`
- SERVICE_DATE = `7/14/2020 12:00:00 AM`
- SERVICE_LN = `1`

### CL_RMT_SVC_LVL_ADJ
- IMAGE_ID = `103811458`
- LINE = `1`
- CAS_SERVICE_LINE = `1`
- SVC_CAS_GRP_CODE_C_NAME = `Patient Responsibility`
- SVC_ADJ_REASON_CD = `1`
- SVC_ADJ_AMT = `216.27`
- SVC_ADJ_QTY = `1`

### CL_RMT_SVC_LVL_REF
- IMAGE_ID = `103811458`
- LINE = `1`
- REF_SVC_LN = `1`
- SVC_REF_ID_QUAL_C_NAME = `Provider control number`
- SVC_REF_IDENTIFIER = `L1004718920-1`

### CODE_INT_COMB_LN
- HSP_ACCOUNT_ID = `376684810`
- LINE = `1`
- CODE_INT_REV_CODE_ID = `430`
- CODE_INT_REV_CODE_ID_REVENUE_CODE_NAME = `OCCUPATIONAL THERAPY - GENERAL CLASSIFICATION`
- CODE_INT_CPT = `97535`
- CODE_INT_MOD_1_ID = `155`
- CODE_INT_MOD_1_ID_MODIFIER_NAME = `OP OCCUPATIONAL THERAPY SERV`
- CODE_INT_DATE = `3/11/2022 12:00:00 AM`
- CODE_INT_QTY = `1`
- CODE_INT_AMT = `216.27`
- CODE_INT_NONCVRD = `0`
- CODE_INT_LN_SRC_C_NAME = `Charge`
- CODE_INT_UNUSED_YN = `N`
- CODE_INT_CHRG_CNT = `1`

### COVERAGE
- COVERAGE_ID = `5934765`
- COVERAGE_TYPE_C_NAME = `Indemnity`
- PAYOR_ID = `1302`
- PLAN_ID = `130204`
- EPIC_CVG_ID = `5934765`
- GROUP_NAME = `Microsoft`
- GROUP_NUM = `1000010`
- CLAIM_MAIL_CODE_C_NAME = `Payer Plan`
- PAT_REC_OF_SUBS_ID = `Z7004242`
- SUBSCR_OR_SELF_MEM_PAT_ID = `Z7004242`

### COVERAGE_2
- CVG_ID = `5934765`
- PAYOR_NAME = `BLUE CROSS OF WISCONSIN`

### COVERAGE_3
- CVG_ID = `5934765`

### DOCS_FOR_HOSP_ACCT
- ACCT_ID = `376684810`
- LINE = `1`
- LINKED_DCS_ID = `278383205`

### GUAR_ACCT_STMT_HX
- ACCOUNT_ID = `1810018166`
- LINE = `1`
- STMT_HX_STMT_DATE = `1/29/2020 12:00:00 AM`
- STMT_HX_INVOICE_NUM = `107147`
- STMT_HX_NEW_CHARGE = `165`
- STMT_HX_NEW_BALANCE = `133.29`
- STMT_HX_TTL_AMT_HLD = `0`
- STMT_HX_TTL_AMT_VD = `-31.71`
- STMT_HX_DVRY_MTHD_C_NAME = `Paper, No Electronic Notification`

### GUAR_ADDR_HX
- ACCOUNT_ID = `4793998`
- LINE = `1`
- ADDR_CHANGE_DATE = `11/14/2022 12:00:00 AM`
- ADDR_HX_1 = `REDACTED`
- CITY_HX = `MADISON`
- STATE_HX_C_NAME = `Wisconsin`
- ZIP_HX = `REDACTED`
- ADDR_CHANGE_SRC_C_NAME = `Chronicles`

### GUAR_PMT_SCORE_PB_HX
- ACCOUNT_ID = `1810018166`
- LINE = `1`
- SCORE_DATE = `1/30/2020 12:00:00 AM`
- SCORE = `4`

### HAR_ALL
- ACCT_ID = `4307315`
- PAT_ID = `Z7004242`
- PRIM_ENC_CSN_ID = `922943112`

### HSP_ACCOUNT
- HSP_ACCOUNT_ID = `376684703`
- HSP_ACCOUNT_NAME = `MANDEL,JOSHUA C`
- ACCT_CLASS_HA_C_NAME = `Therapies Series`
- ACCT_FIN_CLASS_C_NAME = `Blue Cross`
- ACCT_SLFPYST_HA_C_NAME = `Full Self-Pay Due`
- ACCT_BILLSTS_HA_C_NAME = `Closed`
- ACCT_ZERO_BAL_DT = `5/11/2022 12:00:00 AM`
- ADM_DATE_TIME = `3/22/2022 4:42:00 PM`
- ADM_DEPARMENT_ID = `101401044`
- ADM_LOC_ID = `101401`
- ATTENDING_PROV_ID = `805364`
- COMPLETION_DT_TM = `4/14/2022 11:48:00 AM`
- CVG_LIST_SELECT_YN = `Y`
- DISCH_DATE_TIME = `3/22/2022 11:59:00 PM`
- DISCH_DEPT_ID = `101401044`
- DISCH_LOC_ID = `101401`
- GUAR_ADDR_1 = `REDACTED`
- GUAR_NAME = `MANDEL,JOSHUA C`
- GUAR_ZIP = `REDACTED`
- PAT_CITY = `MADISON`
- PAT_DOB = `10/26/1982 12:00:00 AM`
- PAT_HOME_PHONE = `REDACTED`
- PAT_SSN = `REDACTED`
- PAT_ZIP = `REDACTED`
- PREBILL_BUCKET_ID = `471869181`
- SELF_PAY_BUCKET_ID = `471869182`
- SERV_AREA_ID = `10`
- TOT_ADJ = `-962.82`
- TOT_CHGS = `1638.82`
- UNDISTRB_BUCKET_ID = `471869183`
- PATIENT_STATUS_C_NAME = `Discharged to Home or Self Care (Routine Discharge)`
- ADMISSION_SOURCE_C_NAME = `Non-Health Care Facility Point of Origin`
- ADMISSION_TYPE_C_NAME = `Elective`
- PRIMARY_PAYOR_ID = `1302`
- PRIMARY_PLAN_ID = `130204`
- NUM_OF_CHARGES = `3`
- CODING_STATUS_C_NAME = `Completed`
- CODING_STS_USER_ID = `WESTBRKK`
- CODING_STS_USER_ID_NAME = `WESTBROOK, KARLA K`
- CODING_DATETIME = `4/14/2022 11:48:00 AM`
- ABSTRACT_USER_ID = `WESTBRKK`
- ABSTRACT_USER_ID_NAME = `WESTBROOK, KARLA K`
- FIRST_BILLED_DATE = `4/15/2022 12:00:00 AM`
- BASE_INV_NUM = `376684810`
- INV_NUM_SEQ_CTR = `4`

### HSP_ACCOUNT_2
- HSP_ACCOUNT_ID = `376684703`
- OPEN_DENIAL_BDC_YN = `N`
- OPEN_RMK_BDC_YN = `N`
- OPEN_COR_BDC_YN = `N`
- REC_CREATE_USER_ID = `PBNIGHTP`
- REC_CREATE_USER_ID_NAME = `PB, SYSTEM NIGHTLY PROCESSOR`
- CODING_USER = `WESTBRKK`
- CODING_USER_NAME = `WESTBROOK, KARLA K`
- FIRST_SELF_PAY_DT = `4/26/2022 12:00:00 AM`
- FIRST_FULL_SP_DT = `4/26/2022 12:00:00 AM`
- PRIMARY_CONTACT = `55341`

### HSP_ACCOUNT_3
- HSP_ACCOUNT_ID = `376684703`
- ADMIT_TYPE_EPT_C_NAME = `Elective`
- PAT_STS_EPT_C_NAME = `Home - Discharge to Home or Self Care`
- HAS_OPEN_OVRP_BD_YN = `N`
- SELF_PAY_YN = `N`
- ACTUAL_COPAY_AMT = `0`
- ACTUAL_COINS_AMT = `0`
- ACTUAL_DED_AMT = `554.27`

### HSP_ACCOUNT_4
- HSP_ACCOUNT_ID = `376684703`
- TOT_INS_PMT = `-121.73`
- TOT_INS_ADJ = `-962.82`
- TOT_SP_PMT = `-554.27`
- TOT_AR_INS_PMT = `-121.73`
- TOT_AR_INS_ALLOWANCES = `-962.82`
- TOT_AR_SP_PMT = `-554.27`
- TOT_INS_PMTS_AND_RFNDS = `-121.73`
- TOT_SP_PMTS_AND_RFNDS = `-554.27`
- TOT_PMTS_AND_RFNDS = `-676`
- TOT_ADJ_EXCL_RFNDS = `-962.82`
- SP_RESP_AFTER_INS = `554.27`
- SP_RESP_LESS_DISCOUNT = `554.27`
- BAL_IN_FULL_SELF_PAY_YN = `Y`
- FIRST_TX_POST_DATE = `3/11/2022 12:00:00 AM`

### HSP_ACCT_ADJ_LIST
- HSP_ACCOUNT_ID = `376684810`
- LINE = `1`
- ADJ_ID = `678816450`

### HSP_ACCT_ADMIT_DX
- HSP_ACCOUNT_ID = `376684810`
- LINE = `1`
- ADMIT_DX_ID = `468251`

### HSP_ACCT_ATND_PROV
- HSP_ACCOUNT_ID = `376684810`
- LINE = `1`
- ATTENDING_PROV_ID = `805364`
- ATTEND_DATE_FROM = `2/17/2022 12:00:00 AM`
- ATTEND_DATE_TO = `3/11/2022 12:00:00 AM`

### HSP_ACCT_BILL_DRG
- HSP_ACCOUNT_ID = `376684703`

### HSP_ACCT_CHG_LIST
- HSP_ACCOUNT_ID = `376684810`
- LINE = `1`
- TX_ID = `670514271`

### HSP_ACCT_CLAIM_HAR
- ACCT_ID = `376684703`
- ADMISSION_TYPE_C_NAME = `Elective`
- ADMISSION_SOURCE_C_NAME = `Non-Health Care Facility Point of Origin`
- PATIENT_STATUS_C_NAME = `Discharged to Home or Self Care (Routine Discharge)`

### HSP_ACCT_CL_AG_HIS
- HSP_ACCOUNT_ID = `376684810`
- LINE = `1`
- AGNCY_HST_DT_OF_CH = `4/27/2022 12:00:00 AM`
- AGNC_HST_CHG_TP_C_NAME = `Assign`
- AGNCY_HST_AGNCY_ID = `32`
- AGNCY_HST_AGNCY_ID_COLL_AGENCY_NAME = `AVADYNE`
- AGN_HST_COL_ACT_C_NAME = `Outsource Account`
- AGNCY_HST_ACCT_BAL = `554.27`

### HSP_ACCT_CVG_LIST
- HSP_ACCOUNT_ID = `4307370`
- LINE = `1`
- COVERAGE_ID = `5934765`
- CVG_IGNR_PRIM_PAY_YN = `N`

### HSP_ACCT_DX_LIST
- HSP_ACCOUNT_ID = `376684810`
- LINE = `1`
- DX_ID = `462273`

### HSP_ACCT_EARSTADDR
- ACCT_ID = `376684810`
- LINE = `1`
- GUAR_ADDRESS = `REDACTED`

### HSP_ACCT_EXTINJ_CD
- HSP_ACCOUNT_ID = `376684810`
- LINE = `1`
- EXT_INJURY_DX_ID = `508452`

### HSP_ACCT_LETTERS
- NOTE_ID = `3899651265`
- LETTER_SENT_DATE = `10/6/2022 12:00:00 AM`
- LET_CREATE_USER_ID = `LSM400`
- LET_CREATE_USER_ID_NAME = `MCALLISTER, LINDA S`
- ACCOUNT_ID = `1810018166`

### HSP_ACCT_OCUR_HAR
- ACCT_ID = `376684810`
- LINE = `1`
- OCCURRENCE_CODE_C_NAME = `Onset of Symptoms/Illness`
- OCCURRENCE_DATE = `2/17/2022 12:00:00 AM`

### HSP_ACCT_OTHR_PROV
- HSP_ACCOUNT_ID = `4307370`
- LINE = `1`
- OTHER_PROV_ID = `144590`

### HSP_ACCT_PRORATION
- HSP_ACCOUNT_ID = `4307370`
- LINE = `1`
- COVERAGE_ID = `5934765`

### HSP_ACCT_PYMT_LIST
- HSP_ACCOUNT_ID = `376684810`
- LINE = `1`
- PMT_ID = `681354876`

### HSP_ACCT_SBO
- HSP_ACCOUNT_ID = `376684703`
- SBO_TOT_BALANCE = `0`
- SBO_TOTAL_CHARGES = `1638.82`
- SBO_TOTAL_PAYMENTS = `-676`
- SBO_TOTAL_ADJ = `-962.82`
- SBO_PREBILL_BALANC = `0`
- SBO_INS_BALANCE = `0`
- SBO_SP_BAL = `0`

### HSP_CLAIM_DETAIL1
- CLAIM_PRINT_ID = `121445416`
- MAIL_NAME = `BLUE CROSS WI PPO/FEDERAL`
- MAIL_CITY_STATE_ZIP = `ATLANTA, GA 30348-5187`
- MAIL_PHONE = `800-676-2583`
- SRC_OF_ADDR_C_NAME = `Plan`
- LINE_SOURCE_CLP_ID = `124482006`
- PARTIAL_CLAIM_YN = `N`
- EXPECTED_PYMT = `1638.82`
- CLAIM_BILLED_AMOUNT = `1638.82`
- CLM_CONTRACTUAL = `0`
- CLM_EXPECTED_PRICE = `0`
- CLAIM_INS_PORTION = `0`
- CLM_PATIENT_PORTION = `0`
- CLAIM_MTHD_DESC = `Calculated by External System`
- CONTRACT_DATE_REAL = `55321`
- MAIL_ADDR1 = `PO BOX 105187`
- REIMB_COST_THRESH = `0`
- REIMB_COST_OUT = `0`

### HSP_CLAIM_DETAIL2
- CLAIM_PRINT_ID = `121445416`
- SA_ID = `10`
- INACTV_CLP_YN = `Y`
- CLAIM_ACCEPT_DTTM = `4/15/2022 7:23:00 AM`
- SG_PAYOR_ID = `1302`
- SG_PLAN_ID = `130204`
- SG_CVG_ID = `5934765`
- INVOICE_NUM = `37668481003`
- SG_GR_ACCT_ID = `4793998`
- HOSPITAL_ACCT_ID = `376684810`
- HLB_ID = `-2446`
- SG_PROV_ID = `805364`
- SG_LOC_ID = `101401`
- SG_POS_ID = `101401`
- CLAIM_CLASS_C_NAME = `Therapies Series`
- CLAIM_BASE_CLASS_C_NAME = `Outpatient`
- MIN_SERVICE_DT = `3/11/2022 12:00:00 AM`
- MAX_SERVICE_DT = `3/22/2022 12:00:00 AM`
- UB_FROM_DT = `3/11/2022 12:00:00 AM`
- UB_THROUGH_DT = `3/22/2022 12:00:00 AM`
- CLAIM_TYPE_C_NAME = `UB Claim`
- CLAIM_FRM_TYPE_C_NAME = `Electronic Form`
- TTL_CHRGS_AMT = `1638.82`
- TTL_DUE_AMT = `1638.82`
- TTL_NONCVD_AMT = `0`
- TTL_PMT_AMT = `0`
- UB_BILL_TYPE = `132`
- UB_CVD_DAYS = `20`
- UB_COINS_DAYS = `0`
- UB_NON_CVD_DAYS = `0`
- UB_PRINC_DX_ID = `462273`
- SG_ALTPYR_CLM_YN = `N`
- FILING_ORDER_C_NAME = `Primary`
- CLM_EXT_VAL_ID = `128901356`
- CLM_REBILL_REASON_C_NAME = `New claim`

### HSP_CLAIM_PRINT
- CLAIM_PRINT_ID = `121445416`
- CONTACT_DATE_REAL = `66180`
- HSP_ACCOUNT_ID = `376684810`

### HSP_CLP_CMS_LINE
- CLAIM_PRINT_ID = `121445416`
- LINE = `1`
- FROM_SERV_DT = `3/11/2022 12:00:00 AM`
- POS_TYPE_PER_TX = `22`
- PROC_ID = `79022`
- PROC_DESC = `HC ADL/SELF CARE TRN EA 15M`
- HCPCS_CODES = `97535`
- DX_MAP = `1,2`
- QUANTITY = `1`
- OVRD_REV_CODE_ID = `430`
- OVRD_REV_CODE_ID_REVENUE_CODE_NAME = `OCCUPATIONAL THERAPY - GENERAL CLASSIFICATION`
- CHARGE_AMT = `216.27`
- PAYMENT_AMT = `0`
- PRINT_DESCRIPTIO_YN = `N`
- REV_LOCATION_ID = `101401`
- DEPT_ID = `101401044`
- LINE_POS_ID = `101401`
- CMS_CODE_TYPE_C_NAME = `CPT(R)`
- INVOICE_GRP_LN = `1`

### HSP_CLP_CMS_TX_PIECES
- CLAIM_PRINT_ID = `121445416`
- LINE = `1`
- TX_PIECE = `1`
- TX_ID = `670514271`

### HSP_CLP_DIAGNOSIS
- CLAIM_PRINT_ID = `121445416`
- LINE = `1`
- DX_ID = `462273`

### HSP_CLP_REV_CODE
- CLAIM_PRINT_ID = `121445416`
- CONTACT_DATE_REAL = `66180`
- LINE = `1`
- UB_MIN_SERVICE = `3/11/2022 12:00:00 AM`
- UB_MAX_SERVICE = `3/11/2022 12:00:00 AM`
- UB_CHARGES = `1638.82`
- UB_MODIFIER = `GO`
- UB_CPT_CODE = `97535`
- HSP_ACCOUNT_ID = `376684810`
- REV_CODE_EXT = `001`
- UB_REV_CD_DESC = `OCCUPATIONAL THERAPY - GENERAL CLASSIFICATION`
- UB_QTY = `6`
- UB_NON_CVD_AMT = `0`
- UB_LMRP_CD = `97535`
- UB_HCPCS_RATE = `97535GO`
- UB_CODE_TYPE_C_NAME = `CPT(R)`
- UB_LINE_SRC_C_NAME = `Charge`
- UB_SVC_DATE = `3/11/2022 12:00:00 AM`

### HSP_CLP_UB_TX_PIECES
- CLAIM_PRINT_ID = `121445416`
- LINE = `1`
- TX_PIECE = `1`
- TX_ID = `670514271`
- CLAIM_LINE_NUM = `1`

### HSP_PMT_LINE_REMIT
- TX_ID = `681354876`
- LINE = `1`
- LINE_SVCLINE = `1`
- LINE_GRP_CODE_C_NAME = `Other Adjustment`
- LINE_REMIT_CODE_ID = `94`
- LINE_REMIT_CODE_ID_REMIT_CODE_NAME = `94-PROCESSED IN EXCESS OF CHARGES.`
- LINE_RSN_CODE_EXTL = `94`
- LINE_RMT_AMT = `-121.73`

### HSP_PMT_REMIT_DETAIL
- TX_ID = `681354876`
- LINE = `1`
- DTL_GRP_CODE_C_NAME = `Other Adjustment`
- DTL_REMIT_CODE_ID = `94`
- DTL_REMIT_CODE_ID_REMIT_CODE_NAME = `94-PROCESSED IN EXCESS OF CHARGES.`
- DTL_RSN_CODE_EXTL = `94`
- DTL_REMIT_AMT = `-121.73`
- DTL_ACTION_STRING = `1`
- DTL_CREATE_BDC_YN = `N`
- DTL_SERVICE_LINE = `1`

### HSP_TRANSACTIONS
- TX_ID = `670514271`
- HSP_ACCOUNT_ID = `376684810`
- ACCT_CLASS_HA_C_NAME = `Therapies Series`
- ACTION_STRING = `4`
- ALLOWED_AMOUNT = `676`
- BILLED_AMOUNT = `1638.82`
- BILLING_PROV_ID = `599471`
- BUCKET_ID = `464353000`
- COINSURANCE_AMOUNT = `0`
- COPAY_AMOUNT = `0`
- DEDUCTIBLE_AMOUNT = `554.27`
- DEPARTMENT = `101061`
- DFLT_UB_REV_CD_ID = `430`
- DFLT_UB_REV_CD_ID_REVENUE_CODE_NAME = `OCCUPATIONAL THERAPY - GENERAL CLASSIFICATION`
- FIN_CLASS_C_NAME = `Self-Pay`
- INT_CONTROL_NUMBER = `2022105BL4618`
- IS_SYSTEM_ADJ_YN = `Y`
- IS_LATE_CHARGE_YN = `N`
- ORIG_PRICE = `865.08`
- PAT_ENC_CSN_ID = `922943112`
- PAYMENT_SRC_HA_C_NAME = `Check`
- PAYOR_ID = `1302`
- PERFORMING_PROV_ID = `599471`
- PREV_CREDITS_ACT = `-1084.55`
- PRIM_FEE_SCHED_ID = `426`
- PRIM_FEE_SCHED_ID_FEE_SCHEDULE_NAME = `IHS MHM DEFAULT FEE SCHEDULE`
- PROCEDURE_DESC = `AVADYNE PAYMENT`
- PROC_ID = `99974`
- QUANTITY = `1`
- REFERENCE_NUM = `0000000000`
- UB_REV_CODE_ID = `430`
- UB_REV_CODE_ID_REVENUE_CODE_NAME = `OCCUPATIONAL THERAPY - GENERAL CLASSIFICATION`
- REVENUE_LOC_ID = `101401`
- SERV_AREA_ID = `10`
- SERVICE_DATE = `5/11/2022 12:00:00 AM`
- TEMP_TX_ID = `715471300`
- TOTAL_CHARGES_ACT = `1638.82`
- TX_AMOUNT = `-554.27`
- TX_COMMENT = `Enterprise Electronic Remittance Run 7559881`
- TX_FILED_TIME = `5/11/2022 8:35:00 AM`
- TX_NUM_IN_HOSPACCT = `2`
- TX_POST_DATE = `5/11/2022 12:00:00 AM`
- TX_SOURCE_HA_C_NAME = `Electronic Remittance`
- TX_TYPE_HA_C_NAME = `Payment`
- USER_ID = `GARLANAR`
- USER_ID_NAME = `GARLAND, ALICIA R`
- ALLOWANCE_ADJ_YN = `Y`
- PLACE_OF_SVC_ID = `101401`
- NON_COVERED_YN = `N`
- NON_COVERED_AMT = `0`
- IS_REFUND_ADJ_YN = `N`
- INVOICE_NUM = `376684810***`
- COLLECTION_AGENCY = `32`
- COLLECTION_AGENCY_COLL_AGENCY_NAME = `AVADYNE`
- PRIMARY_PLAN_ID = `130204`
- RECONCILIATION_NUM = `BCWI0_20220426_ERA07732296_ACH_ORIGINAL.835`
- INI_FILE_ATTEMPT_DT = `5/11/2022 12:00:00 AM`
- IMD_ID = `163701585`
- EB_PMT_HAR_RES_YN = `Y`
- PMT_HAR_DIS_TO_DT = `5/10/2022 12:00:00 AM`
- PAYMENT_NOT_ALLOWED = `962.82`
- EB_PMT_TOTAL_AMOUNT = `554.27`
- EB_PMT_POST_TYPE_C_NAME = `AGENCY PAYMENT`

### HSP_TRANSACTIONS_2
- TX_ID = `670514271`
- CHRG_AMT_SRC_FLG_C_NAME = `HB Default`
- ORIG_ACCT_COMB_ID = `376684810`
- DX_PRIM_CODE_SET_C_NAME = `ICD-10-CM`
- DX_ALT_CODE_SET_C_NAME = `ICD-9-CM`
- FIRST_TX_POST_DATE = `5/11/2022 12:00:00 AM`
- ACCT_FIN_CLASS_C_NAME = `Blue Cross`
- PRIMARY_PAYOR_ID = `1302`
- PRIMARY_COVERAGE_ID = `5934765`
- HAR_FIRST_POST_DATE = `5/11/2022 12:00:00 AM`
- POST_SOURCE_C_NAME = `E-Remit`
- ADJUSTMENT_CAT_C_NAME = `Contractual`
- WRITE_OFF_RSN_C_NAME = `Contractual`

### HSP_TRANSACTIONS_3
- TX_ID = `670514271`
- IS_PRE_SERVICE_PMT_YN = `N`
- FIRST_HTR_TX_ID = `685171641`
- POSTING_DEPARTMENT_ID = `101061`
- IS_ADV_BILL_TRANS_YN = `N`
- CLAIM_PRINT_ID = `123337005`
- PAT_PMT_COLL_WKFL_C_NAME = `Lockbox`
- EB_TX_SOURCE_C_NAME = `Electronic Remittance`

### HSP_TX_AUTH_INFO
- TX_ID = `670514271`
- LINE = `1`
- AUTH_COVERAGE_ID = `5934765`

### HSP_TX_DIAG
- TX_ID = `670514271`
- LINE = `1`
- HSP_ACCOUNT_ID = `376684810`
- POST_DATE = `3/11/2022 12:00:00 AM`
- SERV_AREA_ID = `10`
- DX_ID = `468251`
- DX_QUAL_HA_C_NAME = `Active`

### HSP_TX_LINE_INFO
- TX_ID = `681354876`
- LINE = `1`
- HSP_ACCOUNT_ID = `376684810`
- POST_DATE = `4/26/2022 12:00:00 AM`
- SERV_AREA_ID = `10`
- LL_REV_CODE_ID = `430`
- LL_REV_CODE_ID_REVENUE_CODE_NAME = `OCCUPATIONAL THERAPY - GENERAL CLASSIFICATION`
- LL_CPT_CODE = `97535`
- LL_MODIFIER = `GO`
- LL_SERVICE_DATE = `3/11/2022 12:00:00 AM`
- LL_BILLED_AMT = `216.27`
- LL_ALLOWED_AMT = `338`
- LL_NOT_ALLOWED_AMT = `-121.73`
- LL_DED_AMT = `216.27`
- LL_POSTED_AMT = `121.73`
- LL_REASON_CODES = `94*-121.73*94*5,1*216.27*1*1`
- LL_ACTIONS = `1,2`
- LL_QUANTITY = `1`

### HSP_TX_NAA_DETAIL
- TX_ID = `681354876`
- LINE = `1`
- NAA_DTL_STEP = `-1`
- NAA_DTL_DESC = `Current Payment`
- NAA_DTL_VAL = `1,638.82`

### HSP_TX_RMT_CD_LST
- TX_ID = `681354876`
- LINE = `1`
- RMT_CODE_LIST_ID = `1`
- RMT_CODE_LIST_ID_REMIT_CODE_NAME = `1-DEDUCTIBLE AMOUNT`
- RMT_AMT_LIST = `554.27`
- RMT_CODE_EXT = `1`
- GRP_CODE_LIST_C_NAME = `Patient Responsibility`

### INVOICE
- INVOICE_ID = `24584313`
- PAT_ID = `Z7004242`
- ACCOUNT_ID = `1810018166`
- SERV_AREA_ID = `18`
- LOC_ID = `1700801`
- POS_ID = `1700801`
- DEPARTMENT_ID = `1700801002`
- PROV_ID = `802011`
- TAX_ID = `391837462`
- TAX_ID_TYPE = `E`
- INSURANCE_AMT = `335`
- SELF_PAY_AMT = `0`
- INIT_INSURANCE_BAL = `335`
- INIT_SELF_PAY_BAL = `0`
- BILL_AREA_ID = `9`
- BILL_AREA_ID_BILL_AREA_NAME = `Associated Physicians Madison Wisconsin`
- PB_HOSP_ACT_ID = `4307370`

### INV_BASIC_INFO
- INV_ID = `24584313`
- LINE = `1`
- INV_NUM = `L1002792520`
- INV_STATUS_C_NAME = `Rejected`
- CVG_ID = `5934765`
- EPM_ID = `1302`
- EPP_ID = `130204`
- FROM_SVC_DATE = `8/9/2018 12:00:00 AM`
- TO_SVC_DATE = `8/9/2018 12:00:00 AM`
- INV_TYPE_C_NAME = `Claim`
- CROSS_OVER_YN = `N`
- MAILING_NAME = `BLUE CROSS WI PPO/FEDERAL`
- MAILING_ADDR = `PO BOX 105187`
- CITY_STATE_ZIP = `ATLANTA, GA 30348-5187`
- CLM_ID = `2985948`
- REF_ID = `802011`
- REF_ID_REFERRING_PROV_NAM = `DHILLON, PUNEET S`
- EAF_POS_ID = `1700801`
- TAX_ID_NUM = `391837462`
- TAX_ID_TYPE = `E`
- REPLACED_INV = `L1007233830`
- CLM_CHANGE_RSN_COD = `D4`
- CLM_CHANGE_COMMENT = `DX corrected`
- MAIL_PHONE = `800-676-2583`
- ALTPAYR_INV_YN = `N`
- LATE_REPLACEMENT_C_NAME = `Replacement`
- CRD_ID = `42972138`
- CLM_EXT_VAL_ID = `54875409`
- CLM_ACCEPT_DT = `8/30/2018 12:00:00 AM`
- FILING_ORDER_C_NAME = `Primary`
- CLAIM_RUN_NUM = `1323670`
- DEMAND_CLAIM_YN = `N`
- PREDETERMINATION_YN = `N`
- PREDICTED_PAY_DATE = `10/16/2023 12:00:00 AM`
- SUGGESTED_FOL_UP_DATE = `10/22/2023 12:00:00 AM`
- FINAL_FOL_UP_DATE = `9/10/2018 12:00:00 AM`
- CLM_CLOSED_TIMELY_YN = `Y`

### INV_CLM_LN_ADDL
- INVOICE_ID = `24584313`
- LINE = `1`
- INVOICE_NUM = `L1002792520`
- CLM_LN = `1`
- PROC_OR_REV_CODE = `99395`
- POS_CODE = `11`
- CLAIM_STATUS_C_NAME = `Closed`
- CLAIM_PAID_AMT = `0`
- EOB_ALLOWED_AMOUNT = `230.73`
- EOB_NON_COVRD_AMT = `104.27`
- EOB_COINSURANCE = `6.99`
- EOB_DEDUCTIBLE = `133.29`
- EOB_ICN = `2018241CN0502`
- CLAIM_DENIED_CODE = `45`
- REMIT_CODE_ID = `45`
- TRANSACTION_LIST = `129124339`
- FROM_SVC_DATE = `8/9/2018 12:00:00 AM`
- PROC_ID = `23868`
- MODIFIER_ONE = `95`
- QUANTITY = `1`
- CHARGE_AMOUNT = `335`
- NONCVD_AMOUNT = `0`
- TYPE_OF_SERVICE_C_NAME = `Medical Care`
- DIAGNOSIS_MAP = `1,2,3`
- REMITTANCE_RMC1_ID = `45`
- REMITTANCE_RMC1_ID_REMIT_CODE_NAME = `45-CHGS EXCD FEE SCH/MAX ALLOWABLE.`
- REMITTANCE_RMC2_ID = `1`
- REMITTANCE_RMC2_ID_REMIT_CODE_NAME = `1-DEDUCTIBLE AMOUNT`
- CLM_LN_CREAT_DATE = `8/14/2018 12:00:00 AM`
- INV_NUM_GRP100LN = `1`
- CLM_LN_PAID_DATE = `9/10/2018 12:00:00 AM`
- IS_CODE_ONLY = `0`

### INV_DX_INFO
- INVOICE_ID = `24584313`
- LINE = `1`
- DX_ID = `514181`
- INV_NUM = `L1002792520`
- INV_NUM_100_GRP_LN = `1`

### INV_NUM_TX_PIECES
- INV_ID = `24584313`
- LINE = `1`
- TX_PIECE = `1`
- TX_ID = `129124339`

### INV_PMT_RECOUP
- INVOICE_ID = `24873734`
- LINE = `1`
- TX_ID = `132295844`

### INV_TX_PIECES
- INV_ID = `24584313`
- LINE = `1`
- TX_PIECE = `1`
- TX_ID = `129124339`

### NOTES_ACCT
- NOTE_ID = `2035952474`
- ACCOUNT_ID = `1810018166`
- ACTIVE_STATUS = `Active`
- ENTRY_USER_ID = `LSM400`
- ENTRY_USER_ID_NAME = `MCALLISTER, LINDA S`
- INVOICE_NUMBER = `L1007233830`
- NOTE_ENTRY_DTTM = `10/6/2022 9:36:06 AM`

### OCC_CD
- RECORD_ID = `127795413`
- LINE = `1`
- OCC_CD = `11`
- OCC_DT = `2/17/2022 12:00:00 AM`

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

### PMT_EOB_INFO_I
- TX_ID = `132295742`
- LINE = `1`
- CVD_AMT = `0`
- NONCVD_AMT = `315`
- DED_AMT = `139.97`
- COINS_AMT = `6.99`
- PAID_AMT = `0`
- ICN = `2022341BT5497`
- DENIAL_CODES = `16`
- PEOB_ACTION_NAME_C_NAME = `Next Responsible Party`
- ACTION_AMT = `139.97`
- ACCOUNT_ID = `1810018166`
- ACTION_ASN_NAME_C_NAME = `No`
- COMMENTS = `Takeback matched to ETR 317165897`
- INFO_LINES = `1,2`
- ACTION_EOB = `1`
- INVOICE_NUM = `L1007201490`
- TX_MATCH_DATE = `12/20/2022 12:00:00 AM`
- NON_PRIMARY_SYS_YN = `N`
- NON_PRIMARY_USR_YN = `N`
- PEOB_ACTION_C_NAME = `Next Responsible Party`
- INV_ID = `58319567`
- INV_LINE = `1`
- NO_MATCHED_CHGS_YN = `N`
- PEOB_ACCOUNT_ID = `1810018166`
- PEOB_LOC_ID = `1700801`
- PEOB_POS_ID = `1700801`
- PEOB_DEPT_ID = `1700801002`
- PEOB_BILL_PROV_ID = `144590`
- PEOB_PLAN_ID = `130204`
- PEOB_PROC_ID = `23662`
- PEOB_MTCH_CHG_TX_ID = `315026147`

### PMT_EOB_INFO_II
- TX_ID = `132295742`
- LINE = `1`
- AMOUNT = `116.09`
- EOB_CODES = `45`
- ADJ_PROC_ID = `10226`
- ACTIONS = `1`
- SYSTEM_COMMENT = `NAA`
- WINNINGRMC_ID = `45`
- WINNINGRMC_ID_REMIT_CODE_NAME = `45-CHGS EXCD FEE SCH/MAX ALLOWABLE.`
- TX_MATCH_DATE = `1/10/2023 12:00:00 AM`
- PEOB_EOB_RMC_IDS = `45`
- PEOB_EOB_AMOUNT = `116.09`
- PEOB_EOB_GRPCODE_C_NAME = `Contractual Obligation`

### REL_CAUSE_CD
- RECORD_ID = `92489134`
- LINE = `1`
- REL_CAUSE_CD = `OA`

### SVC_LN_INFO
- RECORD_ID = `54875409`
- LINE = `1`
- LN_FROM_DT = `3/2/2023 12:00:00 AM`
- LN_PROC_QUAL = `HC`
- LN_PROC_CD = `99213`
- LN_PROC_MOD = `25`
- LN_QTY_QUAL = `UN`
- LN_QTY = `1`
- LN_AMT = `226`
- LN_REV_CD = `0430`
- LN_REV_CD_DESC = `OCCUPATIONAL THERAPY - GENERAL CLASSIFICATION`
- LN_NON_CVD_AMT = `0`
- LN_POS_CD = `11`
- LN_DX_PTR = `1`
- LN_NDC = `58160090952`
- LN_NDC_UNIT_QTY = `0.5`
- LN_NDC_UNIT = `ML`
- LN_REND_PROV_TYP = `1`
- LN_REND_NAM_LAST = `RAMMELKAMP`
- LN_REND_NAM_FIRST = `ZOE`
- LN_REND_NAM_MID = `L`
- LN_REND_NPI = `1205323193`
- LN_REND_TAXONOMY = `207R00000X`

### SVC_LN_INFO_2
- RECORD_ID = `54875409`
- LINE = `1`
- LN_DATE_QUAL = `D8`
- LN_TTL_AMT_PAID = `0`

### SVC_LN_INFO_3
- RECORD_ID = `54875409`
- LINE = `1`

### SVC_PMT_HISTORY
- TX_ID = `319922979`
- GROUP_LINE = `1`
- VALUE_LINE = `1`
- SVC_PMT_HISTORY_C_NAME = `Retro/Transfer/Charge Correction to the invoice has suppressed Next Responsible Party.`

### TX_DIAG
- TX_ID = `129124216`
- LINE = `1`
- POST_DATE = `8/13/2018 12:00:00 AM`
- SERV_AREA_ID = `18`
- DX_ID = `513616`
- DX_QUALIFIER_C_NAME = `Active`

### TX_NDC_INFORMATION
- TX_ID = `354520699`
- LINE = `1`
- NDC_CODES_ID = `368186`
- NDC_CODES_ID_NDC_CODE = `58160-909-52`
- NDC_CODES_ADMIN_AMT = `0.5`
- NDC_CODES_UNIT_C_NAME = `Milliliters`

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

const txChildren: ChildSpec[] = [
  { table: "ARPB_TX_ACTIONS", fkCol: "TX_ID", key: "actions" },
  { table: "ARPB_CHG_ENTRY_DX", fkCol: "TX_ID", key: "charge_diagnoses" },
  { table: "TX_DIAG", fkCol: "TX_ID", key: "diagnoses" },
  { table: "PMT_EOB_INFO_II", fkCol: "TX_ID", key: "eob_info" },
  { table: "ARPB_TX_MATCH_HX", fkCol: "TX_ID", key: "match_history" },
  { table: "ARPB_TX_CHG_REV_HX", fkCol: "TX_ID", key: "charge_revision_history" },
  { table: "ARPB_TX_STMCLAIMHX", fkCol: "TX_ID", key: "statement_claim_history" },
  { table: "ARPB_TX_MODERATE", fkCol: "TX_ID", key: "moderation" },
  { table: "ARPB_TX_MODIFIERS", fkCol: "ETR_ID", key: "modifiers" },
  { table: "ARPB_AUTH_INFO", fkCol: "TX_ID", key: "auth_info" },
  { table: "ARPB_TX_VOID", fkCol: "TX_ID", key: "void_info" },
  { table: "ARPB_TX_STMT_DT", fkCol: "TX_ID", key: "statement_dates" },
  // Hospital transaction children (HSP_TRANSACTIONS keyed on TX_ID)
  { table: "HSP_TX_NAA_DETAIL", fkCol: "TX_ID", key: "naa_detail" },
  { table: "PMT_EOB_INFO_I", fkCol: "TX_ID", key: "eob_info_i" },
  { table: "HSP_TX_LINE_INFO", fkCol: "TX_ID", key: "line_info" },
  { table: "HSP_PMT_LINE_REMIT", fkCol: "TX_ID", key: "line_remit" },
  { table: "HSP_PMT_REMIT_DETAIL", fkCol: "TX_ID", key: "remit_detail" },
  { table: "HSP_TX_RMT_CD_LST", fkCol: "TX_ID", key: "remit_code_list" },
  { table: "HSP_TX_AUTH_INFO", fkCol: "TX_ID", key: "hsp_auth_info" },
  { table: "HSP_TX_DIAG", fkCol: "TX_ID", key: "hsp_diagnoses" },
  { table: "TX_NDC_INFORMATION", fkCol: "TX_ID", key: "ndc_info" },
  { table: "SVC_PMT_HISTORY", fkCol: "TX_ID", key: "svc_payment_history" },
]

const remitChildren: ChildSpec[] = [
  { table: "CL_RMT_SVCE_LN_INF", fkCol: "IMAGE_ID", key: "service_lines" },
  { table: "CL_RMT_CLM_INFO", fkCol: "IMAGE_ID", key: "claim_info" },
  { table: "CL_RMT_CLM_ENTITY", fkCol: "IMAGE_ID", key: "claim_entities" },
  { table: "CL_RMT_PRV_SUM_INF", fkCol: "IMAGE_ID", key: "provider_summary" },
  { table: "CL_RMT_PRV_SUP_INF", fkCol: "IMAGE_ID", key: "provider_supplemental" },
  { table: "CL_RMT_INP_ADJ_INF", fkCol: "IMAGE_ID", key: "inpatient_adjustments" },
  { table: "CL_RMT_OPT_ADJ_INF", fkCol: "IMAGE_ID", key: "outpatient_adjustments" },
  { table: "CL_RMT_SVC_LVL_ADJ", fkCol: "IMAGE_ID", key: "service_level_adjustments" },
  { table: "CL_RMT_SVC_LVL_REF", fkCol: "IMAGE_ID", key: "service_level_refs" },
  { table: "CL_RMT_SVC_AMT_INF", fkCol: "IMAGE_ID", key: "service_amounts" },
  { table: "CL_RMT_SVC_DAT_INF", fkCol: "IMAGE_ID", key: "service_dates" },
  { table: "CL_RMT_DELIVER_MTD", fkCol: "IMAGE_ID", key: "delivery_methods" },
  { table: "CL_RMT_HC_RMK_CODE", fkCol: "IMAGE_ID", key: "remark_codes" },
  { table: "CL_RMT_CLM_DT_INFO", fkCol: "IMAGE_ID", key: "claim_date_info" },
]

const harChildren: ChildSpec[] = [
  { table: "HSP_ACCT_CVG_LIST", fkCol: "HSP_ACCOUNT_ID", key: "coverage_list" },
  { table: "HSP_ACCT_DX_LIST", fkCol: "HSP_ACCOUNT_ID", key: "diagnoses" },
  { table: "HSP_ACCT_PRORATION", fkCol: "HSP_ACCOUNT_ID", key: "proration" },
  { table: "HSP_ACCT_OTHR_PROV", fkCol: "HSP_ACCOUNT_ID", key: "other_providers" },
  { table: "HSP_ACCT_ADJ_LIST", fkCol: "HSP_ACCOUNT_ID", key: "adjustments" },
  { table: "HSP_ACCT_BILL_DRG", fkCol: "HSP_ACCOUNT_ID", key: "billing_drg" },
  { table: "HSP_ACCT_CLAIM_HAR", fkCol: "ACCT_ID", key: "claims" },
  { table: "HSP_ACCT_SBO", fkCol: "HSP_ACCOUNT_ID", key: "split_billing" },
  { table: "HSP_ACCT_CHG_LIST", fkCol: "HSP_ACCOUNT_ID", key: "charge_list" },
  { table: "HSP_ACCT_PYMT_LIST", fkCol: "HSP_ACCOUNT_ID", key: "payment_list" },
  { table: "HSP_ACCT_ATND_PROV", fkCol: "HSP_ACCOUNT_ID", key: "attending_providers" },
  { table: "HSP_ACCT_ADMIT_DX", fkCol: "HSP_ACCOUNT_ID", key: "admit_diagnoses" },
  { table: "HSP_ACCT_LETTERS", fkCol: "HSP_ACCOUNT_ID", key: "letters" },
  { table: "HSP_CLAIM_PRINT", fkCol: "HSP_ACCOUNT_ID", key: "claim_prints" },
  { table: "HSP_TRANSACTIONS", fkCol: "HSP_ACCOUNT_ID", key: "transactions", merged: true },
  { table: "CODE_INT_COMB_LN", fkCol: "HSP_ACCOUNT_ID", key: "code_int" },
  { table: "HSP_ACCT_CL_AG_HIS", fkCol: "HSP_ACCOUNT_ID", key: "collection_agency_history" },
  { table: "HSP_ACCT_EARSTADDR", fkCol: "ACCT_ID", key: "earliest_address" },
  { table: "HSP_ACCT_EXTINJ_CD", fkCol: "HSP_ACCOUNT_ID", key: "external_injury_codes" },
  { table: "HSP_ACCT_OCUR_HAR", fkCol: "ACCT_ID", key: "occurrence_codes" },
  { table: "DOCS_FOR_HOSP_ACCT", fkCol: "ACCT_ID", key: "linked_documents" },
]

const acctChildren: ChildSpec[] = [
  { table: "ACCOUNT_CONTACT", fkCol: "ACCOUNT_ID", key: "contacts", merged: true },
  { table: "ACCT_COVERAGE", fkCol: "ACCOUNT_ID", key: "coverage_links" },
  { table: "ACCT_TX", fkCol: "ACCOUNT_ID", key: "transaction_links" },
  { table: "ACCT_ADDR", fkCol: "ACCOUNT_ID", key: "addresses" },
  { table: "ACCOUNT_CREATION", fkCol: "ACCT_ID", key: "creation_info" },
  { table: "GUAR_ACCT_STMT_HX", fkCol: "ACCOUNT_ID", key: "statement_history" },
  { table: "GUAR_PMT_SCORE_PB_HX", fkCol: "ACCOUNT_ID", key: "payment_score" },
  { table: "GUAR_ADDR_HX", fkCol: "ACCOUNT_ID", key: "address_history" },
  { table: "ACCT_HOME_PHONE_HX", fkCol: "ACCOUNT_ID", key: "phone_history" },
  { table: "NOTES_ACCT", fkCol: "ACCOUNT_ID", key: "notes" },
]

const claimChildren: ChildSpec[] = [
  { table: "SVC_LN_INFO", fkCol: "RECORD_ID", key: "service_lines", merged: true },
  { table: "CLM_DX", fkCol: "RECORD_ID", key: "diagnoses" },
  { table: "CLM_NOTE", fkCol: "RECORD_ID", key: "notes" },
  { table: "CLM_VALUE_RECORD", fkCol: "RECORD_ID", key: "value_records" },
  { table: "OCC_CD", fkCol: "RECORD_ID", key: "occurrence_codes" },
  { table: "REL_CAUSE_CD", fkCol: "RECORD_ID", key: "related_causes" },
]

// ─── Inline in main() ───
  coverage: mergeQuery("COVERAGE"),
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

export interface BillingRecord {
  transactions: BillingTransaction[];
  visits: BillingVisit[];
  hospitalAccounts: EpicRow[];
  guarantorAccounts: EpicRow[];
  claims: EpicRow[];
  remittances: EpicRow[];
}
```

### Stage 3: Clean Projection (HealthRecord.ts → final output)
```typescript
function projectBilling(r: R): BillingSummary {
  const txs = r.billing?.transactions ?? [];
  const charges: Charge[] = [];
  const payments: Payment[] = [];

  for (const tx of txs) {
    const t = str(tx.TX_TYPE_C_NAME) ?? str(tx.txType);
    if (t === 'Charge') {
      charges.push({
        id: sid(tx.TX_ID), date: toISODate(tx.SERVICE_DATE ?? tx.serviceDate),
        service: str(tx.PROC_NAME ?? tx.PROC_ID),
        amount: num(tx.AMOUNT ?? tx.amount),
        provider: str(tx.SERV_PROVIDER_ID_NAME),
        visitId: str(tx.VISIT_NUMBER),
        diagnosisCodes: (tx.chargeDiagnoses ?? []).map((d: any) => String(d.DX_ID ?? '')),
        _epic: epic(tx),
      });
    } else if (t === 'Payment' || t === 'Adjustment') {
      payments.push({
        id: sid(tx.TX_ID), date: toISODate(tx.POST_DATE ?? tx.postDate),
        amount: num(tx.AMOUNT ?? tx.amount), method: t,
        payer: str(tx.PAYOR_ID_NAME),
        relatedChargeId: str(tx.MATCH_CHARGE_TX_ID),
        _epic: epic(tx),
      });
    }
  }

  const claims = (r.billing?.claims ?? []).map((c: any): Claim => ({
    id: sid(c.RECORD_ID ?? c.CLAIM_ID ?? c.CLM_VALUES_ID),
    submitDate: toISODate(c.CREATE_DT ?? c.SUBMIT_DATE),
    status: str(c.CLAIM_STATUS_C_NAME ?? c.CLM_CVG_SEQ_CD),
    totalCharged: num(c.TTL_CHG_AMT ?? c.TOTAL_CHARGES),
    totalPaid: num(c.CLM_CVG_AMT_PAID ?? c.TOTAL_PAID),
    payer: str(c.CLM_CVG_PYR_NAM ?? c.PAYOR_ID_NAME),
    provider: str(c.REND_PROV_NAM_LAST ? 
      [c.REND_PROV_NAM_LAST, c.REND_PROV_NAM_FIRST].filter(Boolean).join(', ') : null),
    invoiceNumber: str(c.INV_NUM),
    _epic: epic(c),
  }));

  const accounts: BillingAccount[] = [
    ...(r.billing?.accounts ?? []).map((a: any): BillingAccount => ({
      id: sid(a.ACCOUNT_ID), type: 'Professional',
      name: str(a.ACCOUNT_NAME), accountClass: str(a.ACCT_FIN_CLASS_C_NAME),
      billingStatus: str(a.ACCT_BILLING_STATUS_C_NAME),
      totalCharges: num(a.TOTAL_CHARGES), totalPayments: num(a.TOTAL_PAYMENTS),
      balance: num(a.BALANCE), _epic: epic(a),
    })),
    ...(r.billing?.hospitalAccounts ?? []).map((h: any): BillingAccount => ({
      id: sid(h.HSP_ACCOUNT_ID), type: 'Hospital',
      name: str(h.HSP_ACCOUNT_NAME),
      accountClass: str(h.ACCT_CLASS_HA_C_NAME),
      billingStatus: str(h.ACCT_BILLSTS_HA_C_NAME),
      totalCharges: num(h.TOT_CHARGES ?? h.TTL_CHG_AMT),
      totalPayments: num(h.TOT_PAYMENTS),
      balance: num(h.ACCT_BALANCE),
      _epic: epic(h),
    })),
  ];

  return { charges, payments, claims, accounts };
}
```

## Actual Output (from health_record_full.json)

```json
{
  "billing": {
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