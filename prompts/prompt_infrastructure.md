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

Analyze the mapping pipeline for **Infrastructure: split merging, child attachment, lookups, serialization** and identify every semantic error — places where a column is read successfully but the value means something different than the code assumes.

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



## Sample Data (one representative non-null value per column)



## Pipeline Code

### Stage 1: SQL Projection (project.ts → raw JSON)
```typescript
function tableExists(name: string): boolean {
  const r = db.query("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name);
  return r !== null;
}

function q(sql: string, params: unknown[] = []): EpicRow[] {
  return db.query(sql).all(...params) as EpicRow[];
}

function qOne(sql: string, params: unknown[] = []): EpicRow | null {
  return db.query(sql).get(...params) as EpicRow | null;
}

function mergeQuery(baseTable: string, where?: string, params: unknown[] = []): EpicRow[] {
  if (!tableExists(baseTable)) return [];

  const config = (splitConfig as Record<string, { base_pk: string; members: Array<{ table: string; join_col: string }> }>)[baseTable];
  if (!config) {
    const w = where ? ` WHERE ${where}` : "";
    return q(`SELECT * FROM "${baseTable}"${w}`, params);
  }

  const baseJoinCol = baseJoinOverrides[baseTable] ?? config.base_pk;
  const baseCols = new Set(
    q(`PRAGMA table_info("${baseTable}")`).map((r) => r.name as string)
  );

  let sql = `SELECT b.*`;
  const joins: string[] = [];

  for (const member of config.members) {
    if (!tableExists(member.table)) continue;
    const alias = member.table.replace(/[^a-zA-Z0-9]/g, "_");
    const splitCols = q(`PRAGMA table_info("${member.table}")`)
      .map((r) => r.name as string)
      .filter((c) => c !== member.join_col && !baseCols.has(c));

    for (const col of splitCols) {
      sql += `, "${alias}"."${col}"`;
    }

    // Find what column on the base side matches this split's join_col
    // Default: use baseJoinCol. But if the split uses a slightly different
    // name (e.g. PAT_ENC_CSN vs PAT_ENC_CSN_ID), find best match.
    let baseCol = baseJoinCol;
    if (!baseCols.has(baseCol)) {
      // Fallback to base PK
      baseCol = config.base_pk;
    }
    // Special case: PAT_ENC_3 joins on PAT_ENC_CSN (no _ID suffix)
    // The base table has PAT_ENC_CSN_ID, so join on that
    if (member.join_col === "PAT_ENC_CSN" && baseCols.has("PAT_ENC_CSN_ID")) {
      baseCol = "PAT_ENC_CSN_ID";
    }

    joins.push(
      `LEFT JOIN "${member.table}" "${alias}" ON b."${baseCol}" = "${alias}"."${member.join_col}"`
    );
    // Track all cols to avoid dups
    for (const col of splitCols) baseCols.add(col);
  }

  sql += ` FROM "${baseTable}" b ${joins.join(" ")}`;
  if (where) sql += ` WHERE ${where}`;
  return q(sql, params);
}

function children(table: string, fkCol: string, parentId: unknown): EpicRow[] {
  if (!tableExists(table)) return [];
  return q(`SELECT * FROM "${table}" WHERE "${fkCol}" = ?`, [parentId]);
}

function childrenMerged(table: string, fkCol: string, parentId: unknown): EpicRow[] {
  return mergeQuery(table, `b."${fkCol}" = ?`, [parentId]);
}

function lookup(table: string, pkCol: string, id: unknown): EpicRow | null {
  if (id == null) return null;
  if (!lookupCache.has(table)) {
    if (!tableExists(table)) {
      lookupCache.set(table, new Map());
    } else {
      const rows = q(`SELECT * FROM "${table}"`);
      const map = new Map<unknown, EpicRow>();
      for (const row of rows) map.set(row[pkCol], row);
      lookupCache.set(table, map);
    }
  }
  return lookupCache.get(table)!.get(id) ?? null;
}

function lookupName(table: string, pkCol: string, nameCol: string, id: unknown): string | null {
  return (lookup(table, pkCol, id)?.[nameCol] as string) ?? null;
}

function attachChildren(parent: EpicRow, parentId: unknown, specs: ChildSpec[]): void {
  for (const spec of specs) {
    if (!tableExists(spec.table)) continue;
    const rows = spec.merged
      ? childrenMerged(spec.table, spec.fkCol, parentId)
      : children(spec.table, spec.fkCol, parentId);
    if (rows.length > 0) parent[spec.key] = rows;
  }
}
```

### Stage 2: Domain Model Hydration (PatientRecord.ts)
```typescript
export class PatientRecord {
  patient: EpicRow;
  allergies: Allergy[];
  problems: Problem[];
  medications: EpicRow[];
  immunizations: EpicRow[];
  coverage: EpicRow[];
  referrals: EpicRow[];
  socialHistory: HistoryTimeline<EpicRow>;
  surgicalHistory: HistoryTimeline<EpicRow>;
  familyHistory: HistoryTimeline<EpicRow>;

  /** Raw projection data for fields not yet promoted to typed accessors */
  _raw: Record<string, unknown>;
  encounters: Encounter[];
  billing: BillingRecord;
  messages: Message[];

  encounterMessageLinks: Array<{ PAT_ENC_CSN_ID: CSN; MESSAGE_ID: EpicID }>;
  orderParentLinks: Array<{ ORDER_ID: EpicID; PARENT_ORDER_ID: EpicID; PAT_ENC_CSN_ID?: CSN }>;

  // Index maps
  private _encountersByCSN: Map<CSN, Encounter>;
  private _ordersByID: Map<EpicID, Order>;

  constructor(json: EpicRow) {
    // Patient demographics: everything that isn't a known collection key
    const collectionKeys = new Set([
      'allergies', 'problems', 'medications', 'immunizations', 'coverage',
      'referrals', 'social_history', 'surgical_history', 'family_history',
      'encounters', 'billing', 'messages',
    ]);
    this.patient = {};
    for (const [k, v] of Object.entries(json)) {
      if (!collectionKeys.has(k)) this.patient[k] = v;
    }

    // Hydrate typed collections
    this.allergies = ((json.allergies as EpicRow[]) ?? []).map(r => new Allergy(r));
    this.problems = ((json.problems as EpicRow[]) ?? []).map(r => new Problem(r));
    this.medications = (json.medications as EpicRow[]) ?? [];
    this.immunizations = (json.immunizations as EpicRow[]) ?? [];
    this.coverage = (json.coverage as EpicRow[]) ?? [];
    this.referrals = (json.referrals as EpicRow[]) ?? [];

    // History timelines
    this.socialHistory = buildTimeline((json.social_history as EpicRow[]) ?? []);
    this.surgicalHistory = buildTimeline((json.surgical_history as EpicRow[]) ?? []);
    this.familyHistory = buildTimeline((json.family_history as EpicRow[]) ?? []);

    // Preserve raw projection data for the clean HealthRecord projection
    this._raw = {
      family_hx: json.family_hx ?? [],
    };

    // Encounters
    this.encounters = ((json.encounters as EpicRow[]) ?? []).map(e => new Encounter(e));

    // Billing
    const billing = (json.billing as EpicRow) ?? {};
    this.billing = {
      transactions: ((billing.transactions as EpicRow[]) ?? []).map(t => new BillingTransaction(t)),
      visits: ((billing.visits as EpicRow[]) ?? []).map(v => new BillingVisit(v)),
      hospitalAccounts: (billing.hospital_accounts as EpicRow[]) ?? [],
      guarantorAccounts: (billing.guarantor_accounts as EpicRow[]) ?? [],
      claims: (billing.claims as EpicRow[]) ?? [],
      remittances: (billing.remittances as EpicRow[]) ?? [],
    };

    // Messages
    this.messages = ((json.messages as EpicRow[]) ?? []).map(m => new Message(m));

    // Bridge tables (extracted from encounter _billing_visit and mychart_message_links)
    this.encounterMessageLinks = this.encounters.flatMap(e =>
      ((e as unknown as EpicRow).mychart_message_links as EpicRow[] ?? []).map(l => ({
        PAT_ENC_CSN_ID: e.PAT_ENC_CSN_ID,
        MESSAGE_ID: l.MESSAGE_ID as EpicID,
      }))
    );

    // Order parent links (collected from all orders)
    this.orderParentLinks = [];

    // Build indexes
    this._encountersByCSN = new Map(this.encounters.map(e => [e.PAT_ENC_CSN_ID, e]));
    this._ordersByID = new Map(
      this.encounters.flatMap(e => e.orders.map(o => [o.ORDER_PROC_ID, o]))
    );
  }

  encounterByCSN(csn: CSN): Encounter | undefined {
    return this._encountersByCSN.get(csn);
  }

  orderByID(id: EpicID): Order | undefined {
    return this._ordersByID.get(id);
  }

  /** All encounters sorted by date */
  encountersChronological(): Encounter[] {
    return [...this.encounters].sort(
      (a, b) => (a.contactDate ?? '').localeCompare(b.contactDate ?? '')
    );
  }

  /**
   * Clinical visits only — filters out system-generated contacts.
   *
   * Epic's PAT_ENC contains ALL contacts: clinical visits, history review
   * contacts, monthly health-maintenance contacts, MyChart messages, etc.
   * This method returns only the ones with clinical content (diagnoses,
   * orders, reasons for visit, or notes with text), sorted chronologically.
   *
   * If you want raw unfiltered contacts, use .encounters directly.
   */
  visits(): Encounter[] {
    return this.encountersChronological().filter(e =>
      e.diagnoses.length > 0 ||
      e.orders.length > 0 ||
      e.reasonsForVisit.length > 0 ||
      e.notes.some(n => n.text.length > 0)
    );
  }

  activeProblems(): Problem[] {
    return this.problems.filter(p => p.status !== 'Deleted' && p.status !== 'Resolved');
  }

  /** Quick summary of the patient record */
  summary(): string {
    const v = this.visits();
    const lines = [
      `Patient: ${this.patient.PAT_NAME} (${this.patient.PAT_MRN_ID})`,
      `Allergies: ${this.allergies.length}`,
      `Problems: ${this.problems.length} (${this.activeProblems().length} active)`,
      `Medications: ${this.medications.length}`,
      `Immunizations: ${this.immunizations.length}`,
      `Visits: ${v.length} clinical visits (${this.encounters.length} total contacts)`,
      `Messages: ${this.messages.length}`,
      `Billing transactions: ${this.billing.transactions.length}`,
    ];
    return lines.join('\n');
  }
}
```

### Stage 3: Clean Projection (HealthRecord.ts → final output)
```typescript
export function serializeHealthRecord(hr: HealthRecord, opts?: { includeEpic?: boolean }): string {
  const includeEpic = opts?.includeEpic ?? false;
  return JSON.stringify(hr, (key, value) => {
    // Strip _epic unless opted in
    if (key === '_epic' && !includeEpic) return undefined;
    // Strip null values
    if (value === null) return undefined;
    // Strip empty strings
    if (value === '') return undefined;
    // Strip empty arrays
    if (Array.isArray(value) && value.length === 0) return undefined;
    return value;
  }, 2);
}

export function projectHealthRecord(r: R): HealthRecord {
  return {
    _version: "0.1.0",
    _projected: new Date().toISOString(),
    _source: "epic-ehi",
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

function toISODate(v: unknown): ISODate {
  if (!v || typeof v !== 'string') return null;
  try { const d = new Date(v.trim()); return isNaN(d.getTime()) ? null : d.toISOString().split('T')[0]; }
  catch { return null; }
}

function toISODateTime(v: unknown): ISODateTime {
  if (!v || typeof v !== 'string') return null;
  try {
    const d = new Date(v.trim());
    if (isNaN(d.getTime())) return null;
    return (d.getHours() === 0 && d.getMinutes() === 0) ? d.toISOString().split('T')[0] : d.toISOString();
  } catch { return null; }
}

function str(v: unknown): string | null { return (v == null || v === '') ? null : String(v); }
function num(v: unknown): number | null { const n = Number(v); return (v == null || v === '' || isNaN(n)) ? null : n; }
function sid(v: unknown): Id { return String(v ?? ''); }

function epic(obj: any): EpicRaw {
  const raw: EpicRaw = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v != null && !Array.isArray(v) && typeof v !== 'object') raw[k] = v;
  }
  return raw;
}

function num(v: unknown): number | null { const n = Number(v); return (v == null || v === '' || isNaN(n)) ? null : n; }
function sid(v: unknown): Id { return String(v ?? ''); }

function epic(obj: any): EpicRaw {
  const raw: EpicRaw = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v != null && !Array.isArray(v) && typeof v !== 'object') raw[k] = v;
  }
  return raw;
}

function sid(v: unknown): Id { return String(v ?? ''); }

function epic(obj: any): EpicRaw {
  const raw: EpicRaw = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v != null && !Array.isArray(v) && typeof v !== 'object') raw[k] = v;
  }
  return raw;
}

function epic(obj: any): EpicRaw {
  const raw: EpicRaw = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v != null && !Array.isArray(v) && typeof v !== 'object') raw[k] = v;
  }
  return raw;
}
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