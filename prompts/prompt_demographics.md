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

Analyze the mapping pipeline for **Demographics: PATIENT (6 splits) + PATIENT_RACE + PAT_ADDRESS → HealthRecord.demographics** and identify every semantic error — places where a column is read successfully but the value means something different than the code assumes.

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

### PATIENT
**Table**: The PATIENT table contains one record for each patient in your system. The data contained in each record consists of demographics, PCP and primary location information, registration information, and other information.
- **PAT_ID**: The unique ID of the patient record for this row. This column is frequently used by other tables to link to PATIENT.
- **PAT_NAME**: The patient�s name in the format Lastname, Firstname MI.
- **CITY**: The city in which the patient lives.
- **STATE_C_NAME**: The category value corresponding to the state in which the patient lives.
- **COUNTY_C_NAME**: The category value corresponding to the county in which the patient lives.
- **COUNTRY_C_NAME**: The category value corresponding to the country in which the patient lives.
- **ZIP**: The ZIP Code area in which the patient lives.
- **HOME_PHONE**: The patient�s home phone number.
- **WORK_PHONE**: The patient�s work phone number.
- **EMAIL_ADDRESS**: The patient�s e-mail address.
- **BIRTH_DATE**: The date on which the patient was born.
- **ETHNIC_GROUP_C_NAME**: The category value associated with the patient�s ethnic background.
- **RELIGION_C_NAME**: The category value associated with the patient�s religion.
- **LANGUAGE_C_NAME**: The category value associated with the patient�s language.
- **SSN**: The patient�s Social Security Number. This number is formatted as 999-99-9999, and a single trailing alphabetic character is also allowed.
- **REG_DATE**: The date on which the last patient verification occurred.  If a patient was verified and then re-verified at a later date, this column will show the re-verified date.  This column will be null for patients that have never been verified.
- **REG_STATUS_C_NAME**: The category value associated with the patient�s status in terms of the patient registration process as of the enterprise reporting extract. This is a customizable list, examples may include: 1 � New, 2 � Verified, and so on.
- **MEDICARE_NUM**: The patient�s Medicare-assigned identification number, if applicable.
- **MEDICAID_NUM**: Patient's Medicaid ID.
- **ADV_DIRECTIVE_YN**: This column contains the value �Y� if the patient has a signed living will on file with your facility indicating how they want their health chare to be handled in the event of an incapacitating emergency. This information is entered in clinical system. If the patient has no signed living will on file this column contains the value �N�.
- **ADV_DIRECTIVE_DATE**: The date a living will was received from the patient.
- **CUR_PCP_PROV_ID**: The unique ID of the provider record for the patient�s current General Primary Care Provider as of the enterprise reporting extract. This ID may be encrypted.
- **CUR_PRIM_LOC_ID**: The unique ID of the location record for the patient�s Primary Location as of the time of the enterprise reporting extract. This column is retrieved from the item Primary Location.
- **LEGAL_STATUS_C_NAME**: The medical and/or legal status associated with the patient�s death. This item is populated through Admission/Discharge/Transfer (ADT) workflows.
- **BIRTH_STATUS_C_NAME**: The category value associated with the newborn�s status at birth as entered in ADT.
- **PED_MULT_BIRTH_ORD**: For multiple births, the place in the birth order of the current newborn patient.
- **PED_MULT_BIRTH_TOT**: The total number of births during the mother�s labor and delivery of this newborn patient.
- **CREATE_USER_ID**: The unique ID of the system user who entered this patient�s record. This ID may be encrypted.
- **CREATE_USER_ID_NAME**: The name of the user record. This name may be hidden.
- **PAT_MRN_ID**: The patient's medical record number (MRN), of the type associated with the patient's current primary location.
- **DEATH_DATE**: The date of death for the patient.
- **REC_CREATE_PAT_ID**: The unique ID of the system user who created this patient�s record. This ID may be encrypted.   NOTE: For historical reasons, the column name ends in PAT_ID and cannot be changed; despite its name, it does not link to patient ID. It instead links to CLARITY_EMP.USER_ID.
- **REC_CREATE_PAT_ID_NAME**: The name of the user record. This name may be hidden.
- **ORGAN_DONOR_YN**: Indicates if the patient is an organ donor.
- **TMP_CITY**: Contains the city in which the patient is temporarily residing.
- **TMP_STATE_C_NAME**: Contains the state in which the patient is temporarily residing.
- **TMP_COUNTRY_C_NAME**: Contains the country in which the patient is temporarily residing.
- **TMP_ZIP**: Contains the ZIP Code in which the patient is temporarily residing.
- **TMP_HOME_PHONE**: Contains the temporary phone number where the patient can be reached.
- **TMP_COUNTY_C_NAME**: Contains the county in which the patient is temporarily residing.
- **TMP_ADDR_START_DT**: Contains the starting effective date of the patients temporary address information.
- **TMP_ADDR_END_DT**: Contains the ending effective date of the patients temporary address information.
- **TMP_CARE_OF_PERSON**: Contains the name of the contact person for the patient at the temporary residence.
- **PAT_LAST_NAME**: The last name of the patient.
- **PAT_FIRST_NAME**: The first name of the patient.
- **PAT_MIDDLE_NAME**: The middle name of the patient.
- **PAT_TITLE_C_NAME**: The patient's title, e.g. Mr., Mrs., Miss, Dr., etc.
- **PAT_NAME_SUFFIX_C_NAME**: The suffix to the patient's name, e.g. Jr., Sr., III, etc.
- **SPECIAL_STATUS_C_NAME**: The special status of the patient, such as employee or VIP.
- **LANG_CARE_C_NAME**: The patient's preferred language to receive care.
- **LANG_WRIT_C_NAME**: The patient's preferred language to receive written material.
- **PROXY_PAT_YN**: Indicates if the patient has a proxy already.
- **PROXY_PACK_YN**: Indicates if the proxy packet was given to the patient.
- **EMPLOYER_ID**: This is the unique ID of the patient's employer if the item linking the patient to an employer (I EAF 6410) is set to 1.  This is free text if the item linking the patient to an employer (I EAF 6410) is set to 2.
- **EMPLOYER_ID_EMPLOYER_NAME**: The name of the employer.
- **EMPY_STATUS_C_NAME**: The employee's employment status (e.g. Full Time, Part time, Not Employed, etc.)
- **GUARDIAN_NAME**: The name of the patient's legal guardian, if any.
- **PREF_CLIN_ZIP**: The zip code of the patient's preferred clinic.
- **PREF_PCP_SEX_C_NAME**: The category value of the sex of the patient's preferred primary care physician.
- **PREF_PCP_SPEC_C_NAME**: The category value of the specialty of the patient's preferred physician.
- **PREF_PCP_LANG_C_NAME**: The category value of the language of the patient's preferred primary care physician.
- **COUNTRY_OF_ORIG_C_NAME**: Holds data on the country in which a patient was born
- **PED_CESAREAN_YN**: This column contains the value "Y" if the patient was delivered by Cesarean Section. If the patient was not delivered by Cesarean Section, this column contains the value "N".
- **PED_NOUR_METH_C_NAME**: Indicates the patient's pediatric nourishment method.
- **PED_DELIVR_METH_C_NAME**: Indicates the patient's delivery method at birth.
- **PED_MULTI_BIRTH_YN**: This column contains the value "Y" if the patient is one of a multiple birth.  This column contains the value "N" if the patient was a single birth.
- **EDD_DT**: The patient's Expected Date of Delivery.
- **EDD_ENTERED_DT**: Date the Expected Date of Delivery was entered.
- **EDD_CMT**: Expected Date of Delivery comment.
- **INTRPTR_NEEDED_YN**: Indicates whether the patient needs an interpreter.
- **PCP_DON_CHART_YN**: Indicates whether the primary care physician has finished moving all the information from the paper chart into the system.
- **PAT_HAS_IOL_YN**: This item is used as a data item to mark those patients having intraocular lenses.
- **PED_BIRTH_LABOR**: Stores the duration of labor related to a patient's birth history.
- **PED_HOSP_DAYS**: Stores the number of days spent in the hospital related to a patient's birth history.
- **MEDS_LAST_REV_TM**: Stores the last time the encounter medications list was reviewed.
- **MEDS_LST_REV_USR_ID**: Stores the last user to review the encounter medications list.
- **MEDS_LST_REV_USR_ID_NAME**: The name of the user record. This name may be hidden.
- **SELF_EC_VERIF_DATE**: Most recent date patient marked their emergency contact information as verified.
- **SELF_EC_VERIF_ST_YN**: The status of the patient's last verified emergency contact request (e.g. verified yes or no).
- **EMPR_ID_CMT**: A free text comment that can be entered when the value that is considered to be "Other" is selected as the employer. This option is available only if your organization has chosen to link the patient employer to the Employer (EEP) master file in the Facility Profile.
- **PAT_STATUS_C_NAME**: The category value of the patient status. Possible statuses include alive and deceased.  Note that there are many patient creation workflows that do not populate this item so many alive patients could have blank statuses.   If using this column to report on the Alive or Deceased status of a patient population use PATIENT_4.PAT_LIVING_STAT_C instead.
- **MEDS_LAST_REV_CSN**: Stores the contact serial number of the encounter in which the patient's current medications list was last reviewed.
- **SEX_C_NAME**: The category number corresponding to the patient's sex.

### PATIENT_2
**Table**: This table supplements the PATIENT table. It contains basic information about patients.
- **PAT_ID**: The unique ID of the patient record for this row. This column is frequently used to link to the PATIENT table.
- **RECORD_TYPE_6_C_NAME**: The type of patient (EPT) record that this row relates to.
- **BIRTH_TM**: The date and time of the patient's birth in 24 hour format.
- **DEATH_TM**: The date and time of the patient's death in 24 hour format.
- **FAX**: The patient's fax number.
- **CITIZENSHIP_C_NAME**: The patient's citizenship status information.
- **MED_HX_NOTE_ID**: This column contains a link to the General Use Notes (HNO) meds history note for this patient.
- **IS_ADOPTED_YN**: Capture if patient is adopted or not.
- **BIRTH_HOSPITAL**: Capture the name of the hospital where the patient was born or first seen after a non-hospital birth.
- **ALRGY_UPD_INST**: The PATIENT table extracts the last date on which the patient's allergy information was verified. For more granularity, this table extracts the instant (date and time) that this information was verified.
- **BIRTH_CITY**: The patient's city of birth.
- **BIRTH_ST_C_NAME**: The patient's state of birth.
- **SCHOOL_C_NAME**: School that the patient attends.
- **REFERRAL_SOURCE_ID**: The unique ID of the provider or other source that referred the patient to the facility. This is distinct from the encounter-specific referral source in PAT_ENC.
- **REFERRAL_SOURCE_ID_REFERRING_PROV_NAM**: The name of the referral source.
- **PAT_NAME_RECORD_ID**: The networked item that points to the patient's name record (EAN).
- **COMM_METHOD_C_ZC_COMM_METHOD_NAME**: Column to hold the category value of Preferred Communication Method (I EPT 89) for the Patient_2 table.
- **FOSTER_CHILD_YN**: Indicates whether the patient is a foster child.
- **CONF_PAT_REAL_NAME**: The real name of a confidential patient.
- **PAT_CONF_NM_REC_ID**: The networked item pointing to the name record for the patient's confidential name.
- **ACTIVE_IER_ID**: Link to active Identity History (IER) record for this patient.
- **OTH_CITY**: Contains the city for the patient's prescription address, which can be used by pharmacy to determine where to mail prescriptions.
- **OTH_ZIP**: Contains the zip code for the patient's prescription address, which can be used by pharmacy to determine where to mail prescriptions.
- **OTH_PHONE**: Contains the phone number for the patient's prescription address, which can be used by pharmacy to determine where to mail prescriptions.
- **OTH_EMAIL**: Contains the email for the patient's prescription address, which can be used by pharmacy to determine where to mail prescriptions.
- **OTH_CONTACT_PERSON**: Contains the contact person for the patient's prescription address, which can be used by pharmacy to determine where to mail prescriptions.
- **OTH_HOUSE_NUMBER**: Contains the house number for the patient's prescription address, which can be used by pharmacy to determine where to mail prescriptions.
- **OTH_DISTRICT_C_NAME**: Contains the district for the patient's prescription address, which can be used by pharmacy to determine where to mail prescriptions.
- **OTH_COUNTY_C_NAME**: Contains the county for the patient's prescription address, which can be used by pharmacy to determine where to mail prescriptions.
- **OTH_COUNTRY_C_NAME**: Contains the country for the patient's prescription address, which can be used by pharmacy to determine where to mail prescriptions.
- **OTH_START_DATE**: Contains the start date for the patient's prescription address, which can be used by pharmacy to determine where to mail prescriptions.
- **OTH_END_DATE**: Contains the end date for the patient's prescription address, which can be used by pharmacy to determine where to mail prescriptions.
- **DEF_ADDRESS_C_NAME**: Stores the address that will be used by default by the pharmacy when determining where to mail prescriptions. This can be home, temporary, or prescription.
- **OTH_STATE_C_NAME**: Contains the state for the patient's prescription address, which can be used by pharmacy to determine where to mail prescriptions.
- **MAIDEN_NAME**: The patient's maiden name.
- **EMPR_CITY**: The city of the patient's employer.
- **EMPR_STATE_C_NAME**: The category number for the state of the patient's employer.
- **EMPR_ZIP**: The ZIP code of the patient's employer.
- **EMPR_COUNTRY_C_NAME**: The category number for the country of the patient's employer.
- **EMPR_PHONE**: The phone number of the patient's employer.
- **BILL_INSTRUCT_C_NAME**: The category number for the Billing Instruction Code for the patient.
- **PAT_ASSIST_C_NAME**: The category number for the Patient Assistance Code.
- **BILL_COMMENT**: General comments regarding patient billing instruction
- **CHART_ABSTD_YN**: Indicates whether the chart was abstracted.
- **MOTHER_HEIGHT**: Height of the patient's mother.  This is used for calculations in the Growth Charts activity.
- **FATHER_HEIGHT**: Height of the patient's father.  This is used for calculations in the Growth Charts activity.
- **PAT_VERIFICATION_ID**: Verification record for this patient
- **ALRGY_REV_STAT_C_NAME**: This item stores the status of the review of allergies.
- **ALRGY_REV_CMT**: This item stores a comment associated with the review of allergies.
- **REVERSE_NATL_ID**: Used to store reverse National Identifier in an indexed item for patient search of partial National Identifier.
- **ADV_DIR_REV_DT**: The date on which a user last reviewed the patient's advanced directive.
- **ADV_DIR_REV_USER_ID**: The user who last reviewed the patient's advanced directive.
- **ADV_DIR_REV_USER_ID_NAME**: The name of the user record. This name may be hidden.
- **LIVING_ARRANGE_C_NAME**: The patient's living arrangement.
- **PED_COMMENT**: Free-text pediatric comments.

### PATIENT_3
**Table**: This table supplements the information contained in the PATIENT table. It contains basic information about patients, such as the patient's ID, occupation, English fluency, etc.
- **PAT_ID**: The unique ID of the patient record for this row. This column is frequently used to link to the PATIENT table.
- **LACT_STAT_CUR_C_NAME**: The category number for the patient's current lactation status.
- **LACT_STAT_INST_DTTM**: The instant when the patient's lactation status was updated.
- **LACT_STAT_CSN**: The contact serial number of the encounter in which the lactation status updated. The contact serial number is the unique identifier for the encounter.
- **LACT_STAT_USER_ID**: The unique ID of the user who last updated the patient's lactation status.
- **LACT_STAT_USER_ID_NAME**: The name of the user record. This name may be hidden.
- **AMBULATORY_STATUS_C_NAME**: Information regarding a patient's ambulatory status.
- **OCCUPATION**: A patient's occupation.
- **ADVANCED_DIR_YN**: Indicates whether the patient has any advanced directives.
- **ABST_DT**: The date of abstraction of the patient record.
- **ALRGY_REV_REAS_C_NAME**: Reason for the review status of allergy assessment.
- **ALLOW_HALF_PILLS_YN**: Indicates whether the patient uses half pills
- **L_GROWTH_CHART_USED**: Contains the last growth chart accessed by a user for a particular patient.  This allows the activity to display that same growth chart for that patient the next time the activity is accessed.
- **ALRG_LAST_UPDA_DTTM**: The latest instant in which allergies were updated.
- **PED_BIRTH_LEN_NUM**: Newborn birth length stored in inches.
- **PED_BIRTH_WT_NUM**: Newborn birth weight stored in ounces.
- **PED_DISCHRG_WGT_NUM**: Newborn discharge weight stored in ounces.
- **PED_APGAR_ONE_C_NAME**: Newborn 1 minute Apgar.
- **PED_APGAR_FIVE_C_NAME**: Newborn 5 minute Apgar.
- **PED_APGAR_TEN_C_NAME**: Newborn 10 minute Apgar.
- **UNOS_PRIM_COD_C_NAME**: The transplant patient's primary cause of death, as defined by UNOS (United Network for Organ Sharing).
- **UNOS_PRIM_COD_SP**: Free text description of the transplant patient's primary cause of death.
- **UNOS_CTRB_COD1_C_NAME**: The transplant patient's first contributory cause of death, as defined by UNOS (United Network for Organ Sharing).
- **UNOS_CNTB_COD1_SP**: Free text description of the transplant patient's first contributory cause of death.
- **UNOS_CTRB_COD2_C_NAME**: The transplant patient's second contributory cause of death, as defined by UNOS (United Network for Organ Sharing).
- **UNOS_CNTB_COD2_SP**: Free text description of the transplant patient's second contributory cause of death.
- **PREFERRED_NAME**: The preferred name for the patient.
- **LAST_VERIFIED_BY_ID**: The last user who verified the patient.
- **LAST_VERIFIED_BY_ID_NAME**: The name of the user record. This name may be hidden.
- **LEARN_ASSMT_ID**: Learning assessment ID. This can be used to check that the learning assessments are being given to the appropriate patients at the appropriate times.
- **CURR_LOC_ID**: The unique ID of the most recent confirmed patient location that is associated with the patient.
- **PCOD_CAUSE_DX_ID**: Stores the preliminary cause of death for the patient
- **PCOD_REC_USER_ID**: Stores the user that filed the preliminary cause of death
- **PCOD_REC_USER_ID_NAME**: The name of the user record. This name may be hidden.
- **PCOD_INST_REC_DTTM**: Stores the instant that the preliminary cause of death was recorded
- **EMPL_ID_NUM**: The patient's employee identification number.
- **SCHOOL_PHONE**: The patient's school phone number.
- **CONTRACT_ID**: The unique ID of the pricing contract that is associated with the patient.
- **SPOT_UPD_USER_ID**: This item saves the user ID of the person who most recently updated the patient's Spotlight folder in the Synopsis activity by adding a row that previously had not been tracked by any other user.
- **SPOT_UPD_USER_ID_NAME**: The name of the user record. This name may be hidden.
- **GYN_HX_CMT_NOTE_ID**: ID of HNO (note) record for free-text gynecological information
- **GYN_HX_MENARCHE_AGE**: The patient's age at menarche
- **GYN_HX_FST_PREG_AGE**: The patient's age at first pregnancy
- **GYN_HX_MO_BRSTFDG**: The number of months the patient spent breastfeeding
- **GYN_HX_MENOPAUS_AGE**: The patient's age at menopause
- **FAMILY_GROUPER**: A family identifier that may be used to group family members together. Note that this is not guaranteed to be unique across deployments in IntraConnect.
- **FETUS_YN**: Indicates whether this row is a fetus record or a patient record. YES indicates that the row is a fetus record. NO indicates that the row is a patient record.
- **DENT_CLASS_C_NAME**: This item identifies the dental classification of the patient.
- **DENT_LAST_USER_ID**: This item stores the last user who edited the dental classification of the patient.
- **DENT_LAST_USER_ID_NAME**: The name of the user record. This name may be hidden.
- **DENT_INST_DTTM**: This item stores the instant when the dental classification of the patient was last edited.
- **ENGLISH_FLUENCY_C_NAME**: Record the patient's fluency in English.
- **FORM_CONFIDENCE_C_NAME**: Record the patient's confidence level in filling out medical forms.
- **BRANCH_OF_SERVICE_C_NAME**: This column stores the branch of service in which the patient serves.
- **MILITARY_RANK_C_NAME**: This column stores the patient's military rank.
- **FMP_C_NAME**: This column stores the relationship between the patient and the patient's sponsor.
- **PAT_CAT_C_NAME**: This column, patient category, combines the branch of service and eligibility type into a three-character code, such as A14. This code affects billing and other downstream systems.
- **MIL_COMPONENT_C_NAME**: This column stores the patient's military component, which is used to distinguish between patients who are on regular active duty and those who are members of one of the augmenting support groups.
- **ASGN_MIL_UNIT_ID**: This column stores the military unit ID to which the patient is assigned.
- **ASGN_MIL_UNIT_ID_RECORD_NAME**: This column stores the name of the military unit's record.
- **MIL_PAY_GRADE_C_NAME**: This column stores the patient's military pay grade.
- **TEMP_MIL_UNIT_ID**: This column stores the patient's temporary military unit ID.
- **TEMP_MIL_UNIT_ID_RECORD_NAME**: This column stores the name of the military unit's record.
- **PED_GEST_AGE_DAYS**: Newborn gestational age at birth in total number of days
- **PED_BIRTH_HD_CIRCUM**: Newborn birth head circumference stored in inches.

### PATIENT_4
**Table**: This table supplements the PATIENT table. It contains basic information about patients.
- **PAT_ID**: The unique ID of the patient record for this row. This column is frequently used to link to the PATIENT table.
- **INTERPRT_NEEDED_CMT**: Comments regarding the patient's interpreter needs
- **DENT_COMMENT**: This item stores the comment of the current dental classification
- **ESRD_G_START_DT**: The first date that the acute comorbidity of gastrointestinal bleeding was present during maintenance dialysis treatments for End Stage Renal Disease (ESRD).
- **ESRD_B_START_DT**: The first date that the acute comorbidity of bacterial pneumonia was present during maintenance dialysis treatments for End Stage Renal Disease (ESRD).
- **ESRD_P_START_DT**: The first date that the acute comorbidity of pericarditis was present during maintenance dialysis treatments for End Stage Renal Disease (ESRD).
- **CMS_OP_ESRD_TRAIN_H**: The number of training session that have been performed for a patient's hemodialysis treatment through his/her life time.
- **CMS_OP_ESRD_TRAIN_P**: The number of training session that have been performed for a patient's peritoneal dialysis treatment through his/her life time.
- **FOH_ID**: This item stores the filing order history ID for the member.
- **TXP_PAT_YN**: Indicates if the patient is a transplant patient.
- **BLIND_YN**: Indicates the patient is blind.
- **DEAF_YN**: Indicates the patient is deaf.
- **EMPR_COUNTY_C_NAME**: The category value corresponding to the county in which the patient's employer is located.
- **ALRGY_REV_EPT_CSN**: This column contains the source encounter where allergies were most recently reviewed. If allergies were most recently reviewed outside the context of an encounter, the value is blank.
- **OCCUPATION_C_NAME**: Category list for the patient's occupation.
- **INDUSTRY_C_NAME**: Category list for the industry in which the patient works.
- **EDUCATION_LEVEL_C_NAME**: The patient's highest level of education achieved.
- **LOC_EDUCATION_C_NAME**: Location of the patient's highest level of education.
- **PARENT_EDU_LEVEL_C_NAME**: Parent/guardian's highest level of education achieved.
- **PARENT_LOC_EDU_C_NAME**: Location of parent/guardian's highest level of education.
- **RES_OF_STATE_C_NAME**: The state of residence category ID for the patient.
- **US_CITIZEN_YN**: Indicates whether the patient is a citizen of the USA.
- **PERMANENT_RESIDENT_YN**: Indicates whether the patient is a permanent resident of the USA.
- **CNTRY_SUBDIV_CODE_C_NAME**: Capture the patient's country subdivision code.
- **RACE_COLL_MTHD_C_NAME**: The race and ethnicity collection method category ID for the patient.
- **PAT_NO_COMM_PREF_C_NAME**: This column stores why the patient doesn't have a preference for receiving communication related to reminders and follow-up care.
- **FST_LIVE_BIRTH_AGE**: The patient's age at first live birth.
- **RSH_PREF_C_NAME**: Indicates the patient's explicit research recruitment preference.
- **RSH_PREF_UTC_DTTM**: Indicates the instant that the patient last indicated an explicit research recruitment preference.
- **RSH_PREF_USER_ID**: Indicates the user who last recorded the patient's explicit research recruitment preference.
- **RSH_PREF_USER_ID_NAME**: The name of the user record. This name may be hidden.
- **EXTERNAL_DEATH_DATE**: The patient's date of death as reported by an external organization. This column is typically populated by importing data through the Patient Load utility.
- **DEATH_DATA_IMPORT_DATE**: The date the Patient Load utility populated EXTERNAL_DEATH_DATE for this patient.
- **DEATH_LOC_C_NAME**: Describes the location where the patient died.
- **INDIGENOUS_STAT_C_NAME**: Indicates whether a patient is considered indigenous.
- **PAT_LIVING_STAT_C_NAME**: This column uses information from the chart to determine if the patient represents a real patient. If considered a patient the column returns whether or not the patient is Alive or Deceased. If the record does not represent a real patient then Not A Patient is returned. Patients with blank and custom statuses in the patient status item EPT 102 are assumed Alive. The logic for Not A Patient is identical to EPT 109 - Valid Patient except that test patients can be considered Alive or Deceased.
- **IS_FETAL_DEMISE_YN**: This column is used to indicate the state of patient's chart due to fetal demise.
- **ERROR_NEWBORN_YN**: This column is used to indicate that the newborn chart was created in error.
- **MEDSYNC_IS_PARTICIPANT_YN**: Indicates whether the patient is a participant in the outpatient pharmacy medication synchronization program.
- **MEDSYNC_RECURRENCE**: Stores the number of days that are to be between a patient's medication synchronization refills.
- **MEDSYNC_REFILLDATE_DATE**: Stores a medication synchronization dispense date for the patient.
- **REFILLMGMT_NOTE_ID**: Stores the ID for a General Use Notes (HNO) record for comments regarding the patient's refill management.
- **IHS_ENROLLMENT_NUM**: This is the American Indian tribal enrollment ID number for the patient.
- **IHS_BENEFICIARY_CLASS_C_NAME**: Classification of the type of patient, indicating a category under which an individual can become eligible for Indian Health Services (IHS) benefits.
- **IHS_PRIMARY_TRIBE_C_NAME**: The patient's primary tribe.
- **IHS_PRIM_TRIBE_BLOOD_QUANTUM_C_NAME**: This item designates the blood quantum for the patient's primary tribe.
- **IHS_COMMUNITY_OF_RESIDENCE_C_NAME**: The patient's community of residence is a subdivision of the state and county in which the patient resides.
- **IHS_RESIDENCE_SINCE_DATE**: Date when the patient first moved to this community of residence (I EPT 4104).
- **IHS_SERVICE_ELIGIBILITY_C_NAME**: Specifies the types of services for which this patient is eligible.
- **GENDER_IDENTITY_C_NAME**: The patient's gender identity.
- **CURRENT_JOB_START_DATE**: The date a patient started in her current job.
- **SEX_ASGN_AT_BIRTH_C_NAME**: Stores the patient's sex assigned at birth.
- **PREFERENCES_ID**: The ID number of the communication preferences record for the patient.
- **DEATH_INFO_SOURCE_C_NAME**: Stores the source that provided the information on the patient's death outside of the organization. This item will allow for more tracking on the patients who died outside of the organization, and allow for more accurate data on deceased patients.
- **BLOOD_REQTS_UTC_DTTM**: Instant the blood special requirements were last edited
- **BLOOD_REQTS_USER_ID**: Stores the user that set the current special requirements for a patient
- **BLOOD_REQTS_USER_ID_NAME**: The name of the user record. This name may be hidden.
- **ADDR_CHG_USER_ID**: The user who initiated the linked address changes.
- **ADDR_CHG_USER_ID_NAME**: The name of the user record. This name may be hidden.
- **ADDR_CHG_INSTANT_DTTM**: The instant that the linked address changes were initiated.
- **ADDR_CHG_SOURCE**: The source record that initiated the linked address changes.
- **EDD_BASIS_OB_DT_EVENT_C_NAME**: Basis for the patient's expected date of delivery (EDD). Used to track the dating basis for the patient's EDD when the patient does not have a pregnancy episode.
- **VETERAN_DENTAL_CVG_LEVEL_C_NAME**: Each patient can have up to one dental coverage. The dental coverage denotes how much dental services a veteran can receive prior to being billed. This column is frequently used to link to the ZC_VETERAN_DENTAL_CVG table.
- **VETERAN_IS_COMBAT_COVERED_YN**: This column stores a Yes/No value that indicates whether or not a patient is covered for their service in combat.
- **VETERAN_COMBAT_EXP_DATE**: This column stores the expiration date of a patient's combat-level coverage.
- **VETERAN_PRIORITY_GROUP_C_NAME**: Each patient can have up to one priority group. The priority group is a list of veteran coverage priorities that is maintained by the Department of Veteran Affairs. This column is frequently used to link to the ZC_VETERAN_PRIORITY_GROUP table.
- **VETERAN_ENROLLMENT_STATUS_C_NAME**: Each patient can have up to one enrollment status. This denotes whether or not a patient's coverage levels are active or otherwise. This column is frequently used to link to the ZC_VETERAN_ENROLL_STATUS table.
- **LEGACY_HICN**: Stores the patient's Health Insurance Claim Number (HICN) if one was previously available and we've received their Medicare Beneficiary Number (MBI) (stored in PATIENT.MEDICARE_NUM). This value may be needed to look up members during the transition to MBI.
- **RSH_PREF_MYPT_ID**: Indicates the MyChart user who last recorded the patient's explicit research recruitment preference.
- **NEPH_ESRD_START_DT**: This item is used to store the date of the patient's first regular chronic dialysis treatment.
- **NEPH_PCRF_LPL_ID**: This item is used to store the dialysis patient's primary cause of renal failure.
- **NEPH_2728_VERIFY_YN**: This item stores whether the dialysis patient's form-2728 was verified.

### PATIENT_5
**Table**: This table supplements the PATIENT table. It contains basic information about patients.
- **PAT_ID**: The unique ID of the patient record for this row. This column is frequently used to link to the PATIENT table.
- **PHYSICAL_IMPAIRED_C_NAME**: The Physically Impaired? category ID for the patient.
- **MEMORY_IMPAIRED_C_NAME**: The Memory Impaired? category ID for the patient.
- **SPEECH_IMPAIRED_C_NAME**: The Speech Impaired? category ID for the patient.
- **DISABLED_VETERAN_C_NAME**: The Disabled Veteran? category ID for the patient.
- **VA_RECOGNIZED_C_NAME**: The VA Recognized? category ID for the patient.
- **HEARING_IMPAIRED_C_NAME**: The Hard of Hearing? category ID for the patient.
- **VISUALLY_IMPAIRED_C_NAME**: The Low Vision? category ID for the patient.
- **DIFFICULTY_DRESS_BATHE_C_NAME**: The Difficulty Dressing or Bathing? category ID for the patient.
- **DIFFICULTY_WITH_ERRAND_C_NAME**: The Difficulty with Errands? category ID for the patient.
- **SC_PERM_FORM_OF_RES_C_NAME**: The social care client's permanent form of residence.
- **SC_GROUNDS_FOR_RES_PERM_C_NAME**: Reason why the social care client is able to hold a residence permit.
- **SC_RES_PERMIT_VALID_TO_DATE**: Date the social care client's residence permit is valid to.
- **SC_TYPE_OF_RELATIONSHIP_C_NAME**: Further specify marriage details for the social care client.
- **SOCIAL_CARE_PASSPORT_TYPE_C_NAME**: The passport type.
- **SOCIAL_CARE_PASSPORT_EXP_DATE**: Date passport expires.
- **RSH_PREFS_ANSWER_ID**: The unique ID of the questionnaire answers of the patient's most recent research preference questionnaire submission.
- **RX_AUTO_REFILL_DELIV_MTHD_C_NAME**: The delivery method to use for refills initiated via auto refill. If not set, the default delivery method is used.
- **PAT_PHOTO**: This stores the file name of the current patient photo.
- **PEND_PAT_PHOTO**: This stores the file name of a photo pending approval to be added to the chart.  It has most likely been submitted by the patient via Welcome or MyChart.
- **TYPE_AND_SCR_ELIG_YN**: This stores whether or not the patient is eligible for a type and screen.
- **NEPH_PCRF_DX_ID**: Stores a dialysis patient's primary cause of renal failure diagnosis.
- **CONSENT_ABILITY_YN**: If the patient is able to consent or not. Leaving this item blank will be treated as an answer of "Unknown."
- **SCHOOL_DISTRICT_NUM**: School district number.
- **MIGRATION_TYPE_C_NAME**: The migrant type: either emigrant or immigrant.
- **MIGRANT_COUNTRY_C_NAME**: If the patient is a migrant, this is the country which the patient is immigrating from or emigrating to.
- **CONGREGATE_CARE_RESIDENT_YN**: Denotes whether a patient is a resident of a congregate care setting such as a group home, residential treatment facility, or maternity home.
- **SEEN_DOMESTIC_TRAVEL_ALERT_YN**: Indicates whether the patient has seen the alert in MyChart or Welcome warning them that they can now enter trips that they've taken inside of the United States.
- **KI_SELF_GUAR_ACCT_VERIF_DATE**: This item indicates the most recent date the patient verified whether the self-guarantor billing information is correct in Welcome.
- **KI_SELF_GUAR_ACCT_VERIF_STS_C_NAME**: This item indicates the most recent answer a patient selected when prompted to verify whether the self-guarantor billing information is correct in Welcome.
- **PAT_PHONETIC_NAME**: Stores the phonetic spelling of the patient's name.
- **PAT_RETIREMENT_DATE**: The date of a patient's retirement for MSPQ purposes.
- **SPOUSE_RETIREMENT_DATE**: The date of a patient's spouse's retirement for MSPQ purposes.
- **DRIVERS_LICENSE_NUM**: The patient's driver's license number.
- **DRIVERS_LICENSE_STATE_C_NAME**: The state category ID for the patient's driver's license.
- **EMPLOYMENT_HIRE_DATE**: The date that a patient was hired at their employer.
- **EMPLOYER_FAX**: the fax number of the patient's employer.
- **WORK_PHONE**: The patient's work phone number.
- **H1B_WORK_VISA_YN**: Indicates whether the patient has an H1B work visa.
- **STUDENT_VISA_YN**: Indicates whether the patient has a student visa.
- **BIRTH_COUNTY_C_NAME**: The county category ID for where the patient was born.
- **CORRESP_CONTACT**: This name of the contact person associated with a patient's correspondence address.
- **CUR_INP_SUMMARY_BLOCK_ID**: The current Inpatient summary block ID.
- **PREFERRED_FORM_ADDRESS**: How the patient prefers to be addressed.
- **PAT_ACADEMIC_DEGREE_C_NAME**: Stores the academic degree of the patient as it would appear with the patient's name. For example, James Smith, PhD.
- **PREFERRED_NAME_TYPE_C_NAME**: Stores the type for the patient's preferred name.
- **AHCIC_NUM**: The patient's AHCIC number.

### PATIENT_6
**Table**: This table supplements the PATIENT table. It contains basic information about patients.
- **PAT_ID**: The unique ID of the patient record for this row. This column is frequently used to link to the PATIENT table.
- **IMAGING_WILL_CALL_YN**: Holds a "Will Call" status for the patient. This is a status toggled by a Radiology user (eg. Technologist) to flag the availability of the patient for further processing.
- **SEX_FOR_MELD_C_NAME**: The patient's sex for adult Model for End-Stage Liver Disease (MELD) calculation.

### PATIENT_RACE
**Table**: This table contains information on a patient's race.
- **PAT_ID**: The unique ID of the patient record for this row. This column is frequently used to link to the PATIENT table.
- **LINE**: The line number for the information associated with this record. Multiple pieces of information can be associated with this record.
- **PATIENT_RACE_C_NAME**: The race of the patient.

### PAT_ADDRESS
**Table**: This table contains each patient's permanent address (I EPT 50). The primary key for this table is the combination of PAT_ID and LINE. Each different PAT_ID value represents a different patient, and each LINE value represents a different line of that patient's address.
- **PAT_ID**: The unique ID of the patient record for this row. This column is frequently used to link to the PATIENT table.
- **LINE**: The line number for the information associated with this record. Multiple pieces of information can be associated with this record.
- **ADDRESS**: This column contains the patient's permanent address. Each PAT_ID value represents a different patient, and each LINE value represents a different line of that patient's address.

## Sample Data (one representative non-null value per column)

### PATIENT
- PAT_ID = `Z7004242`
- PAT_NAME = `MANDEL,JOSHUA C`
- CITY = `MADISON`
- STATE_C_NAME = `Wisconsin`
- COUNTY_C_NAME = `DANE`
- COUNTRY_C_NAME = `United States of America`
- ZIP = `REDACTED`
- HOME_PHONE = `617-894-1015`
- EMAIL_ADDRESS = `jmandel@alum.mit.edu`
- BIRTH_DATE = `10/26/1982 12:00:00 AM`
- ETHNIC_GROUP_C_NAME = `Not Hispanic or Latino`
- RELIGION_C_NAME = `None`
- LANGUAGE_C_NAME = `English`
- SSN = `REDACTED`
- ADV_DIRECTIVE_YN = `N`
- CUR_PCP_PROV_ID = `144590`
- CUR_PRIM_LOC_ID = `1700801`
- CREATE_USER_ID = `BETTSMR`
- CREATE_USER_ID_NAME = `BETTS, MINDY R`
- PAT_MRN_ID = `APL324672`
- REC_CREATE_PAT_ID = `BETTSMR`
- REC_CREATE_PAT_ID_NAME = `BETTS, MINDY R`
- PAT_LAST_NAME = `Mandel`
- PAT_FIRST_NAME = `Joshua`
- PAT_MIDDLE_NAME = `C`
- EMPLOYER_ID = `1000`
- EMPLOYER_ID_EMPLOYER_NAME = `OTHER`
- EMPY_STATUS_C_NAME = `Full Time`
- INTRPTR_NEEDED_YN = `N`
- MEDS_LAST_REV_TM = `9/28/2023 9:38:00 AM`
- MEDS_LST_REV_USR_ID = `MBS403`
- MEDS_LST_REV_USR_ID_NAME = `SMITH, MARY B`
- SELF_EC_VERIF_DATE = `2/15/2024 12:00:00 AM`
- EMPR_ID_CMT = `Microsoft`
- PAT_STATUS_C_NAME = `Alive`
- MEDS_LAST_REV_CSN = `991225117`
- SEX_C_NAME = `Male`

### PATIENT_2
- PAT_ID = `Z7004242`
- IS_ADOPTED_YN = `N`
- ALRGY_UPD_INST = `9/28/2023 9:39:00 AM`
- PAT_NAME_RECORD_ID = `7745095`
- COMM_METHOD_C_ZC_COMM_METHOD_NAME = `Mail Service`
- DEF_ADDRESS_C_NAME = `Home Address`
- EMPR_COUNTRY_C_NAME = `United States of America`
- PAT_VERIFICATION_ID = `67506213`
- ALRGY_REV_STAT_C_NAME = `Review Complete`
- REVERSE_NATL_ID = `4499-26-330`

### PATIENT_3
- PAT_ID = `Z7004242`
- ALRG_LAST_UPDA_DTTM = `8/29/2022 1:32:00 PM`
- PREFERRED_NAME = `Josh`

### PATIENT_4
- PAT_ID = `Z7004242`
- TXP_PAT_YN = `N`
- ALRGY_REV_EPT_CSN = `991225117`
- PAT_LIVING_STAT_C_NAME = `Alive`
- GENDER_IDENTITY_C_NAME = `Male`
- PREFERENCES_ID = `1079221`
- ADDR_CHG_USER_ID = `MYCHARTG`
- ADDR_CHG_USER_ID_NAME = `MYCHART, GENERIC`
- ADDR_CHG_INSTANT_DTTM = `7/14/2020 2:01:43 PM`
- ADDR_CHG_SOURCE = `(EPT) MANDEL,JOSHUA C [  Z7004242]`

### PATIENT_5
- PAT_ID = `Z7004242`
- CONGREGATE_CARE_RESIDENT_YN = `N`
- SEEN_DOMESTIC_TRAVEL_ALERT_YN = `Y`
- PREFERRED_NAME_TYPE_C_NAME = `First Name, Preferred`

### PATIENT_6
- PAT_ID = `Z7004242`

### PATIENT_RACE
- PAT_ID = `Z7004242`
- LINE = `1`
- PATIENT_RACE_C_NAME = `White`

### PAT_ADDRESS
- PAT_ID = `Z7004242`
- LINE = `1`
- ADDRESS = `REDACTED`

## Pipeline Code

### Stage 1: SQL Projection (project.ts → raw JSON)
```typescript
function projectPatient(): EpicRow {
  const rows = mergeQuery("PATIENT");
  if (rows.length === 0) throw new Error("No patient found");
  const pat = rows[0];
  const patId = pat.PAT_ID;

  // Also merge PATIENT_MYC if present
  if (tableExists("PATIENT_MYC")) {
    const myc = qOne(`SELECT * FROM PATIENT_MYC WHERE PAT_ID = ?`, [patId]);
    if (myc) Object.assign(pat, myc);
  }

  return pat;
}
```

### Stage 2: Domain Model Hydration (PatientRecord.ts)
```typescript
// Patient is stored as raw EpicRow on PatientRecord.patient
```

### Stage 3: Clean Projection (HealthRecord.ts → final output)
```typescript
    demographics: projectDemographics(r),
    allergies: r.allergies.map(projectAllergy),
    problems: r.problems.map(projectProblem),
    medications: r.medications.map(projectMedication),
    immunizations: r.immunizations.map(projectImmunization),
    visits: r.visits().map((v: any) => projectVisit(v, r)),
    labResults: projectAllLabResults(r),
    socialHistory: projectSocialHistory(r),
    surgicalHistory: projectSurgicalHistory(r),
    familyHistory: projectFamilyHistory(r),
    messages: r.messages.map(projectMessage),
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
  "name": "MANDEL, JOSHUA C",
  "firstName": "Joshua",
  "lastName": "Mandel",
  "dateOfBirth": "1982-10-26",
  "sex": "Male",
  "ethnicity": "Not Hispanic or Latino",
  "language": "English",
  "address": {
    "city": "MADISON",
    "state": "Wisconsin",
    "zip": "REDACTED",
    "country": "United States of America"
  },
  "phone": "617-894-1015",
  "email": "jmandel@alum.mit.edu",
  "mrn": "APL324672",
  "_epic": {
    "PAT_ID": "Z7004242",
    "PAT_NAME": "MANDEL,JOSHUA C",
    "CITY": "MADISON",
    "STATE_C_NAME": "Wisconsin",
    "COUNTY_C_NAME": "DANE",
    "COUNTRY_C_NAME": "United States of America",
    "ZIP": "REDACTED",
    "HOME_PHONE": "617-894-1015",
    "EMAIL_ADDRESS": "jmandel@alum.mit.edu",
    "BIRTH_DATE": "10/26/1982 12:00:00 AM",
    "ETHNIC_GROUP_C_NAME": "Not Hispanic or Latino",
    "RELIGION_C_NAME": "None",
    "LANGUAGE_C_NAME": "English",
    "SSN": "REDACTED",
    "ADV_DIRECTIVE_YN": "N",
    "CUR_PCP_PROV_ID": "144590",
    "CUR_PRIM_LOC_ID": 1700801,
    "CREATE_USER_ID": "BETTSMR",
    "CREATE_USER_ID_NAME": "BETTS, MINDY R",
    "PAT_MRN_ID": "APL324672",
    "REC_CREATE_PAT_ID": "BETTSMR",
    "REC_CREATE_PAT_ID_NAME": "BETTS, MINDY R",
    "PAT_LAST_NAME": "Mandel",
    "PAT_FIRST_NAME": "Joshua",
    "PAT_MIDDLE_NAME": "C",
    "EMPLOYER_ID": "1000",
    "EMPLOYER_ID_EMPLOYER_NAME": "OTHER",
    "EMPY_STATUS_C_NAME": "Full Time",
    "INTRPTR_NEEDED_YN": "N",
    "MEDS_LAST_REV_TM": "9/28/2023 9:38:00 AM",
    "MEDS_LST_REV_USR_ID": "MBS403",
    "MEDS_LST_REV_USR_ID_NAME": "SMITH, MARY B",
    "SELF_EC_VERIF_DATE": "2/15/2024 12:00:00 AM",
    "EMPR_ID_CMT": "Microsoft",
    "PAT_STATUS_C_NAME": "Alive",
    "MEDS_LAST_REV_CSN": 991225117,
    "SEX_C_NAME": "Male",
    "IS_ADOPTED_YN": "N",
    "ALRGY_UPD_INST": "9/28/2023 9:39:00 AM",
    "PAT_NAME_RECORD_ID": "7745095",
    "COMM_METHOD_C_ZC_COMM_METHOD_NAME": "Mail Service",
    "DEF_ADDRESS_C_NAME": "Home Address",
    "EMPR_COUNTRY_C_NAME": "United States of America",
    "PAT_VERIFICATION_ID": 67506213,
    "ALRGY_REV_STAT_C_NAME": "Review Complete",
    "REVERSE_NATL_ID": "4499-26-330",
    "ALRG_LAST_UPDA_DTTM": "8/29/2022 1:32:00 PM",
    "PREFERRED_NAME": "Josh",
    "TXP_PAT_YN": "N",
    "ALRGY_REV_EPT_CSN": 991225117,
    "PAT_LIVING_STAT_C_NAME": "Alive",
    "GENDER_IDENTITY_C_NAME": "Male",
    "PREFERENCES_ID": 1079221,
    "ADDR_CHG_USER_ID": "MYCHARTG",
    "ADDR_CHG_USER_ID_NAME": "MYCHART, GENERIC",
    "ADDR_CHG_INSTANT_DTTM": "7/14/2020 2:01:43 PM",
    "ADDR_CHG_SOURCE": "(EPT) MANDEL,JOSHUA C [  Z7004242]",
    "CONGREGATE_CARE_RESIDENT_YN": "N",
    "SEEN_DOMESTIC_TRAVEL_ALERT_YN": "Y",
    "PREFERRED_NAME_TYPE_C_NAME": "First Name, Preferred",
    "PAT_ACCESS_STAT_C_NAME": "Used",
    "MYCHART_STATUS_C_NAME": "Activated",
    "MYPT_ID": "389635",
    "DEM_VERIF_DT": "9/27/2023 12:00:00 AM",
    "INS_VERIF_DT": "9/27/2023 12:00:00 AM",
    "R_E_L_PAT_VERIF_DT": "9/27/2023 12:00:00 AM"
  }
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