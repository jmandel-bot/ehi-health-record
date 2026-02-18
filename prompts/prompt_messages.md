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

Analyze the mapping pipeline for **Messages: MYC_MESG → MSG_TXT → Message → HealthRecord.messages** and identify every semantic error — places where a column is read successfully but the value means something different than the code assumes.

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

### MYC_MESG
**Table**: This table contains information on messages sent to and from web-based chart system patients.
- **MESSAGE_ID**: The unique ID used to identify a web-based chart system message record. A new record is created each time a patient sends a message from a web-based chart system to a system user and each time a system user sends a message to a web-based chart system patient.
- **CREATED_TIME**: The date and time the web-based chart system message record was created in local time.
- **PARENT_MESSAGE_ID**: The unique ID of the original message in a chain of web-based chart system messages between patients and system users.
- **INBASKET_MSG_ID**: The unique ID of the system message associated with the web-based chart system message. An example is when a patient sends a message to a system user.
- **PAT_ID**: The unique ID of the patient record for this row. This column is frequently used to link to the PATIENT table.
- **PAT_ENC_DATE_REAL**: A unique, internal contact date in decimal format. The integer portion of the number indicates the date of the contact. The digits after the decimal distinguish different contacts on the same date and are unique for each contact on that date. For example, .00 is the first/only contact, .01 is the second contact, etc.
- **FROM_USER_ID**: The unique ID of the system user who sent a web-based chart system message to a patient.
- **FROM_USER_ID_NAME**: The name of the user record. This name may be hidden.
- **TO_USER_ID**: The unique ID of the system user who was sent a web-based chart system message from a patient.
- **TO_USER_ID_NAME**: The name of the user record. This name may be hidden.
- **TOFROM_PAT_C_NAME**: The message direction category number for the web-based chart system message. 1 corresponds to "To patient". 2 corresponds to "From patient".
- **ORIGINAL_TO**: If a message sent from a web-based chart system patient is re-routed from its intended destination, then the ID of the original recipient is stored in the field. Most commonly this occurs when a system user does not accept messages directly from web-based chart system patients. In this case, the message will be re-routed to a pool, but the employee ID of the system user will be stored here. The ID of the final destination is stored in MODIFIED_TO.
- **RQSTD_PHARMACY_ID**: The unique ID of the pharmacy selected by the patient from the drop down list when sending a Medication Renewal Request message.
- **RQSTD_PHARMACY_ID_PHARMACY_NAME**: The name of the pharmacy.
- **UPDATE_DATE**: The date and time that this web-based chart system message record was pulled into enterprise reporting.
- **REQUEST_SUBJECT**: This field is only used for medical advice request messages and indicates the subject selected by the patient from the drop down list.
- **PROV_ID**: The provider that was used in routing the patient access message. The provider may vary depending on message type.
- **DEPARTMENT_ID**: The department used in routing the patient access message. The department may vary depending on message type.
- **RESP_INFO**: Some response types will include additional information, such as a phone number.  If such data exists for the chosen response method, it will be stored in this field.
- **SUBJECT**: The subject line of the web-based chart system message.
- **PAT_ENC_CSN_ID**: The unique contact serial number for this contact. This number is unique across all patient encounters in your system. If you use IntraConnect, this is the Unique Contact Identifier (UCI).
- **EOW_READ_STATUS_C_NAME**: The read status category number for the web-based chart system message.
- **BILL_ACCT_ID**: The unique ID of the guarantor account associated with this web-based chart system message.
- **BILL_ACCT_TYPE_C_NAME**: The billing account type category number for the web-based chart system message. Only billing-specific customer service messages have a value specified for this column.
- **BILL_ACCT_HAR_ID**: The unique ID of the hospital account associated with this web-based chart system message.
- **RELATED_MESSAGE_ID**: The unique ID of the parent message of the original message chain. This applies only when the system is configured to allow patients to reply to messages associated with closed encounters by creating a new message chain. This item is populated for the message that starts a new chain.
- **WPR_OWNER_WPR_ID**: The unique ID of the web-based chart system patient who owns this message.
- **CR_TX_CARD_ID**: The unique ID of the credit card used for this transaction.
- **CR_TX_MYPT_ID**: The unique ID of the web-based chart system patient associated with this transaction.
- **CR_TX_AMOUNT_AUTH**: The amount authorized for this transaction.
- **PAT_HX_QUESR_ID**: The unique ID of the history questionnaire associated with this message.
- **PAT_HX_QUESR_ID_RECORD_NAME**: The name of the Visit Navigator (VN) History Template Definition (LQH) record.
- **HX_QUESR_CONTEXT_C_NAME**: The history questionnaire context category number for the web-based chart system message.
- **HX_QUESR_PROV_ID**: The unique ID of the provider associated with the questionnaire.
- **HX_QUESR_ENCPROV_ID**: The unique ID of the provider associated with the appointment that the questionnaire is linked to.
- **HX_QUESR_APPT_DAT**: The appointment contact date (DAT) if the questionnaire is linked to an appointment.
- **HX_QUESR_FILED_YN**: Indicates whether the history questionnaire has been filed for this web-based chart system message. Y indicates that the history questionnaire has been filed. N or a null value indicates that the history questionnaire has not been filed.
- **DELIVERY_DTTM**: The instant that this message is scheduled for delivery to the patient. This item may not be populated. In the event that this item is not populated, then the instant the message is created is used to determine when the patient can view the message.
- **RECORD_STATUS_C_NAME**: The category title of the status of the message. If not populated, then the message is active; Soft deleted is set when a message is revoked.
- **CR_TX_TYPE_C_NAME**: Stores the type of transaction (E-Visit or Copay).
- **HX_QUESR_REVIEW_YN**: Indicates whether the history questionnaire has been viewed by a provider in edit mode for this web-based chart system message. Y indicates that the history questionnaire has been viewed, N or a null value indicates that the history questionnaire has not been viewed.
- **HX_QUESR_ENC_CSN_ID**: The unique contact serial number for the appt contact if questionnaire is linked to an appt. This number is unique across all patient encounters in your system. If you use IntraConnect, this is the Unique Contact Identifier (UCI).
- **OUTREACH_RUN_ID**: This is the campaign outreach configuration template associated with this message.
- **RENEWAL_REQ_SRC_C_NAME**: This item stores the request source of a medication renewal request. The  default is 2-Web.
- **REQ_PHARM_FREE_TEXT**: If the selected pharmacy was entered by the user as free-text, then it is stored here.
- **HX_QUESR_EDIT_MYPT_ID**: Stores the Patient Access Account (WPR) record for the user who last made changes to an in progress history questionnaire
- **HX_QUESR_EDIT_INST_DTTM**: Stores the time at which changes were last made to an in progress history questionnaire
- **REFERRAL_ID**: The unique ID of the referral this message is associated with.
- **COMM_ID**: The customer service record ID corresponding to the message
- **AUTH_REQUEST_ID**: The authorization request this message is associated with.
- **INFO_REQ_CSN_ID**: The Information Request this message is associated with.
- **NON_HX_QUESR_WITH_HX_DATA_YN**: 1 - If WMG stores history data even though the WMG type is not 22 - HISTORY Questionnaire.

### MSG_TXT
**Table**: This table contains the text of MyChart messages.
- **MESSAGE_ID**: The unique identifier for the message record.
- **LINE**: The line number for the information associated with this record. Multiple pieces of information can be associated with this record.
- **MSG_TXT**: Stores the body text in the message.

### MYC_MESG_RTF_TEXT
**Table**: Patient message content, in RTF format. Replaces item 100 (plain text message body). Further, this content contains only the current message, whereas the plain text item might have appended previous messages in addition to the current message.
- **MESSAGE_ID**: The unique identifier for the message record.
- **LINE**: The line number for the information associated with this record. Multiple pieces of information can be associated with this record.
- **RTF_TXT**: The text of a message, in RTF format.

## Sample Data (one representative non-null value per column)

### MYC_MESG
- MESSAGE_ID = `19025649`
- CREATED_TIME = `3/4/2022 4:09:00 PM`
- PARENT_MESSAGE_ID = `27919516`
- INBASKET_MSG_ID = `710695166`
- PAT_ID = `Z7004242`
- PAT_ENC_DATE_REAL = `66179`
- FROM_USER_ID = `MYCHARTG`
- FROM_USER_ID_NAME = `MYCHART, GENERIC`
- TO_USER_ID = `KLL403`
- TO_USER_ID_NAME = `LOUGH, KAREN L`
- TOFROM_PAT_C_NAME = `To Patient`
- ORIGINAL_TO = `KLL403`
- UPDATE_DATE = `3/4/2022 5:04:00 PM`
- REQUEST_SUBJECT = `5`
- PROV_ID = `E1011`
- DEPARTMENT_ID = `1`
- SUBJECT = `Appointment Reminder`
- PAT_ENC_CSN_ID = `922942674`
- EOW_READ_STATUS_C_NAME = `Read`
- WPR_OWNER_WPR_ID = `389635`
- RENEWAL_REQ_SRC_C_NAME = `Web`

### MSG_TXT
- MESSAGE_ID = `19025649`
- LINE = `1`
- MSG_TXT = `Appointment Information:`

### MYC_MESG_RTF_TEXT
- MESSAGE_ID = `33704267`
- LINE = `1`
- RTF_TXT = `{\rtf1\epic10403\ansi\spltpgpar\jexpand\noxlattoyen\deff0{\fonttbl{\f0 Segoe UI;}}{\colortbl ;}\pape`

## Pipeline Code

### Stage 1: SQL Projection (project.ts → raw JSON)
```typescript
function projectMessages(patId: unknown): EpicRow[] {
  const rows = q(`SELECT * FROM MYC_MESG WHERE PAT_ID = ?`, [patId]);
  for (const msg of rows) {
    msg.text = children("MSG_TXT", "MESSAGE_ID", msg.MESSAGE_ID);
    if (tableExists("MYC_MESG_CHILD")) {
      msg.child_messages = children("MYC_MESG_CHILD", "MESSAGE_ID", msg.MESSAGE_ID);
    }
    if (tableExists("MYC_MESG_RTF_TEXT")) {
      msg.rtf_text = children("MYC_MESG_RTF_TEXT", "MESSAGE_ID", msg.MESSAGE_ID);
    }
    if (tableExists("MYC_MESG_QUESR_ANS")) {
      msg.questionnaire_answers = children("MYC_MESG_QUESR_ANS", "MESSAGE_ID", msg.MESSAGE_ID);
    }
  }
  return rows;
}
```

### Stage 2: Domain Model Hydration (PatientRecord.ts)
```typescript
export class Message {
  MESSAGE_ID: EpicID;
  messageType?: string;
  senderName?: string;
  createdDate?: string;
  text: EpicRow[] = [];
  threadId?: EpicID;

  constructor(raw: EpicRow) {
    Object.assign(this, raw);
    this.MESSAGE_ID = raw.MESSAGE_ID as EpicID;
    this.messageType = raw.MSG_TYPE_C_NAME as string;
    this.text = (raw.text as EpicRow[]) ?? [];
  }

  linkedEncounters(record: PatientRecordRef): Encounter[] {
    return record.encounterMessageLinks
      .filter(l => l.MESSAGE_ID === this.MESSAGE_ID)
      .map(l => record.encounterByCSN(l.PAT_ENC_CSN_ID))
      .filter((e): e is Encounter => e !== undefined);
  }

  get plainText(): string {
    return this.text.map(t => t.MSG_TEXT as string).filter(Boolean).join('\n');
  }
}
```

### Stage 3: Clean Projection (HealthRecord.ts → final output)
```typescript
function projectMessage(m: any): Message {
  return {
    id: sid(m.MESSAGE_ID),
    date: toISODateTime(m.CREATED_TIME ?? m.CONTACT_DATE),
    from: str(m.FROM_USER_ID_NAME),
    to: str(m.TO_USER_ID_NAME),
    subject: str(m.SUBJECT), body: str(m.MESSAGE_TEXT),
    status: str(m.MSG_STATUS_C_NAME),
    threadId: str(m.THREAD_ID),
    _epic: epic(m),
  };
}
```

## Actual Output (from health_record_full.json)

```json
[
  {
    "id": "53360694",
    "date": "2022-03-04T16:09:00.000Z",
    "from": "MYCHART, GENERIC",
    "subject": "Appointment Reminder",
    "_epic": {
      "MESSAGE_ID": "53360694",
      "CREATED_TIME": "3/4/2022 4:09:00 PM",
      "INBASKET_MSG_ID": "710695166",
      "PAT_ID": "Z7004242",
      "PAT_ENC_DATE_REAL": 66179,
      "FROM_USER_ID": "MYCHARTG",
      "FROM_USER_ID_NAME": "MYCHART, GENERIC",
      "TOFROM_PAT_C_NAME": "To Patient",
      "UPDATE_DATE": "3/4/2022 5:04:00 PM",
      "PROV_ID": "E1011",
      "DEPARTMENT_ID": 1,
      "SUBJECT": "Appointment Reminder",
      "PAT_ENC_CSN_ID": 922942674
    }
  },
  {
    "id": "25505522",
    "date": "2020-07-14T09:54:00.000Z",
    "from": "MYCHART, GENERIC",
    "subject": "Appointment Rescheduled",
    "_epic": {
      "MESSAGE_ID": "25505522",
      "CREATED_TIME": "7/14/2020 9:54:00 AM",
      "INBASKET_MSG_ID": "530638879",
      "PAT_ID": "Z7004242",
      "PAT_ENC_DATE_REAL": 65574,
      "FROM_USER_ID": "MYCHARTG",
      "FROM_USER_ID_NAME": "MYCHART, GENERIC",
      "TOFROM_PAT_C_NAME": "To Patient",
      "UPDATE_DATE": "7/15/2020 11:07:00 AM",
      "PROV_ID": "E1011",
      "DEPARTMENT_ID": 1700801002,
      "SUBJECT": "Appointment Rescheduled",
      "PAT_ENC_CSN_ID": 829213099
    }
  },
  {
    "id": "19034115",
    "date": "2019-12-23T08:45:00.000Z",
    "from": "MYCHART, GENERIC",
    "subject": "Appointment Scheduled",
    "_epic": {
      "MESSAGE_ID": "19034115",
      "CREATED_TIME": "12/23/2019 8:45:00 AM",
      "INBASKET_MSG_ID": "480451771",
      "PAT_ID": "Z7004242",
      "PAT_ENC_DATE_REAL": 65387,
      "FROM_USER_ID": "MYCHARTG",
      "FROM_USER_ID_NAME": "MYCHART, GENERIC",
      "TOFROM_PAT_C_NAME": "To Patient",
      "UPDATE_DATE": "3/11/2020 10:42:00 AM",
      "PROV_ID": "E1011",
      "DEPARTMENT_ID": 1700801002,
      "SUBJECT": "Appointment Scheduled",
      "PAT_ENC_CSN_ID": 799951565
    }
  }
]
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