You are reviewing an Epic EHI data mapping for semantic correctness. Before analyzing the specific mapping below, read the full data model documentation and mapping philosophy — it is essential context for understanding relationship types, CSN semantics, and structural decisions.

## Data Model & Mapping Philosophy

The following is extracted from the projector's documentation. It defines the three relationship types (structural child, cross-reference, provenance stamp), explains CSN semantics, the order parent→child chain, billing as a parallel hierarchy, and the mapping philosophy. **Use this to evaluate whether structural decisions in the code below are correct.**

<methodology>
/**
 * project.ts — Bun + native SQLite projector for Epic EHI → PatientRecord
 *
 * Usage:
 *   bun run spike/project.ts [--db path/to/ehi_clean.db] [--out patient.json]
 *
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * PART 1: UNDERSTANDING THE EPIC EHI DATA MODEL
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Epic's EHI (Electronic Health Information) export is a flat dump of the
 * Clarity/Caboodle reporting database. A single patient's export contains
 * 500-600 TSV files, each representing one database table. There are no
 * foreign key constraints in the export — relationships are implicit.
 *
 *
 * 1. TABLE SPLITTING
 * ──────────────────
 * Epic splits wide tables across multiple files with _2, _3, ... suffixes.
 * PATIENT has 6 files (PATIENT, PATIENT_2..6), PAT_ENC has 7, ORDER_MED
 * has 7, etc. 27 base tables produce 62 additional split files.
 *
 * CRITICAL GOTCHA: The primary key column name often changes across splits!
 *   - ACCOUNT.ACCOUNT_ID → ACCOUNT_2.ACCT_ID → ACCOUNT_3.ACCOUNT_ID
 *   - ORDER_MED.ORDER_MED_ID → ORDER_MED_2.ORDER_ID
 *   - COVERAGE.COVERAGE_ID → COVERAGE_2.CVG_ID
 *   - PAT_ENC base PK is PAT_ID (multi-row) but splits join on PAT_ENC_CSN_ID
 *     except PAT_ENC_3 which uses PAT_ENC_CSN (no _ID suffix)
 *
 * The VALUES match, the NAMES don't. split_config.json documents every join
 * column for all 27 groups. Don't try to infer them — look them up.
 *
 *
 * 2. THREE RELATIONSHIP TYPES
 * ───────────────────────────
 * Every table in the export fits one of three roles:
 *
 * a) STRUCTURAL CHILD — lives inside its parent, joined on parent PK.
 *    Examples: ORDER_RESULTS under ORDER_PROC (on ORDER_PROC_ID),
 *    ALLERGY_REACTIONS under ALLERGY (on ALLERGY_ID).
 *    These nest naturally: order.results = [...]
 *
 * b) CROSS-REFERENCE — has its own identity, points to another entity.
 *    Example: ARPB_VISITS.PRIM_ENC_CSN_ID points to an encounter.
 *    The billing visit is NOT owned by the encounter — it's a separate
 *    entity in a parallel hierarchy. Model as typed ID + accessor method:
 *      encounter.billingVisit(record) / billingVisit.encounter(record)
 *
 * c) PROVENANCE STAMP — a CSN on a patient-level record that means
 *    "this was edited during encounter X", NOT "this belongs to encounter X".
 *    Example: ALLERGY.ALLERGY_PAT_CSN records which encounter the allergy
 *    was noted in. Don't nest allergies under encounters — they belong to
 *    the patient. The CSN is metadata about when/where, not ownership.
 *
 * The hardest part of mapping a new table is deciding which type it is.
 * When in doubt, read the Epic column description from schemas/*.json.
 *
 *
 * 3. CONTACTS, SERIAL NUMBERS, AND THE CSN
 * ─────────────────────────────────────────
 *
 * TERMINOLOGY:
 *   "Contact"       = any recorded interaction with the health system.
 *                     A clinical visit is a contact. But so is a history
 *                     review, a phone call, a MyChart message, an admin
 *                     task, or a lab processing event.
 *   "Serial Number" = a unique integer Epic assigns to each contact.
 *   "CSN"           = Contact Serial Number. The unique ID of a contact.
 *
 * CRITICAL MENTAL MODEL:
 *
 *   PAT_ENC is the table of ALL contacts — not just clinical visits.
 *   Each row in PAT_ENC gets a unique CSN (PAT_ENC_CSN_ID). But the
 *   111 rows in our test patient's PAT_ENC break down as:
 *
 *     ~30  Clinical visits (have diagnoses, orders, or reasons for visit)
 *       5  History review contacts (SOCIAL_HX, SURGICAL_HX records)
 *      76  Other contacts (phone calls, MyChart, admin, metadata-only)
 *
 *   When a clinician reviews social history during a visit, Epic creates
 *   TWO contacts on the same date, same provider, same department:
 *
 *     CSN 799951565  — the clinical visit (3 diagnoses, 1 order, 2 reasons)
 *     CSN 802802103  — the social history review (0 diagnoses, 0 orders)
 *
 *   Both are rows in PAT_ENC. The history contact exists to record WHEN
 *   the history was reviewed. SOCIAL_HX links to both:
 *     - PAT_ENC_CSN_ID = 802802103 (the history's own contact)
 *     - HX_LNK_ENC_CSN = 799951565 (the clinical visit it was part of)
 *
 *   This is why you cannot treat PAT_ENC as "the visits table." Many
 *   CSNs are system-generated contacts with no clinical content.
 *
 * WHERE CSN COLUMNS APPEAR AND WHAT THEY MEAN:
 *
 *   PAT_ENC_CSN_ID    Standard FK to a contact. On child tables
 *                     (PAT_ENC_DX, ORDER_PROC, HNO_INFO), it means
 *                     "this record belongs to contact X." On history
 *                     tables (SOCIAL_HX), it means "this IS contact X."
 *                     Found on 28+ tables.
 *
 *   PRIM_ENC_CSN_ID   "Primary encounter CSN." Used in billing (ARPB_VISITS,
 *                     HAR_ALL). Points to the clinical visit contact,
 *                     not a system-generated one. This is how billing
 *                     connects to clinical data.
 *
 *   HX_LNK_ENC_CSN    "History link encounter CSN." On SOCIAL_HX,
 *                     SURGICAL_HX, FAMILY_HX_STATUS. Points to the
 *                     clinical visit where the history was reviewed.
 *                     Different from PAT_ENC_CSN_ID on the same row.
 *
 *   NOTE_CSN_ID        The note's OWN contact serial number. Different
 *                     from PAT_ENC_CSN_ID on HNO_INFO, which tells you
 *                     which clinical encounter the note belongs to.
 *
 *   ALLERGY_PAT_CSN    Provenance stamp on ALLERGY: "this allergy was
 *                     noted during contact X." NOT structural ownership —
 *                     allergies belong to the patient, not the encounter.
 *
 *   IMM_CSN            Immunization contact. The contact during which
 *                     the immunization was administered or recorded.
 *
 *   MEDS_LAST_REV_CSN  On PATIENT: "encounter where meds were last
 *                     reviewed." A timestamp-style provenance stamp.
 *
 *   ALRG_HX_REV_EPT_CSN  "Encounter where allergy history was reviewed."
 *
 * THE KEY QUESTION WHEN YOU SEE A CSN COLUMN: does it mean
 *   (a) "this record BELONGS TO this contact"  → structural child
 *   (b) "this record IS this contact"           → the contact itself
 *   (c) "this record was TOUCHED during this contact" → provenance stamp
 *   (d) "this links to the CLINICAL VISIT contact"   → cross-reference
 * The column name alone doesn't tell you — read the schema description.
 *
 *
 * 4. THE ORDER PARENT→CHILD CHAIN (LAB RESULTS)
 * ──────────────────────────────────────────────
 * When a provider orders labs, Epic creates a parent ORDER_PROC. When
 * the lab runs, Epic spawns a child ORDER_PROC with a different
 * ORDER_PROC_ID. Results attach to the CHILD order, not the parent.
 *
 *   ORDER_PROC_ID 945468368  (parent, "LIPID PANEL")
 *     → ORDER_RESULTS: empty
 *   ORDER_PROC_ID 945468371  (child, same test)
 *     → ORDER_RESULTS: CHOLESTEROL=159, HDL=62, LDL=84, TRIG=67, VLDL=13
 *
 *   ORDER_PARENT_INFO links them:
 *     PARENT_ORDER_ID=945468368  ORDER_ID=945468371
 *
 * In our test data, parent and child orders share the same CSN (both
 * live on the same contact). In larger institutions, the child order
 * may land on a separate lab-processing contact with a different CSN.
 * Either way, the ORDER_PROC_ID is always different, and results always
 * attach to the child's ORDER_PROC_ID.
 *
 * Without following ORDER_PARENT_INFO, lab results appear disconnected
 * from the ordering encounter. The Order.allResults(record) method
 * handles this automatically.
 *
 *
 * 5. NOTE LINKING IS INDIRECT
 * ───────────────────────────
 * HNO_INFO (notes) has both PAT_ENC_CSN_ID and its own contact CSN.
 *   - PAT_ENC_CSN_ID = the clinical encounter this note belongs to
 *   - NOTE_CSN_ID = the note's own contact serial number (internal)
 *
 * Some notes have NULL PAT_ENC_CSN_ID — these are standalone MyChart
 * messages, system notifications, or notes not tied to a visit.
 * Only 57 of 152 notes in our test data link to encounters.
 * Only 21 of 152 have plain text — the rest may be in RTF format,
 * were redacted, or are system-generated stubs with metadata only.
 *
 *
 * 6. HISTORY TABLES ARE VERSIONED SNAPSHOTS
 * ─────────────────────────────────────────
 * SOCIAL_HX, SURGICAL_HX, FAMILY_HX_STATUS each have two CSN columns:
 *   - PAT_ENC_CSN_ID = the history record's own contact CSN (gets own encounter)
 *   - HX_LNK_ENC_CSN = the clinical encounter where history was reviewed
 *
 * Each row is a point-in-time snapshot, not a child of any encounter.
 * They are patient-level versioned records. We model them as
 * HistoryTimeline<T> with .latest(), .asOfEncounter(csn), .asOfDate(date).
 *
 *
 * 7. BRIDGE TABLES FOR PATIENT LINKAGE
 * ─────────────────────────────────────
 * Several entity tables store one record per entity (not per patient)
 * and link to patients through bridge tables:
 *
 *   ALLERGY ←─── PAT_ALLERGIES ───→ PATIENT (via PAT_ID)
 *   PROBLEM_LIST ← PAT_PROBLEM_LIST → PATIENT
 *   IMMUNE ←──── PAT_IMMUNIZATIONS → PATIENT
 *   ACCOUNT ←─── ACCT_GUAR_PAT_INFO → PATIENT
 *   HSP_ACCOUNT ← HAR_ALL ──────────→ PATIENT (via PAT_ID + ACCT_ID)
 *
 * In single-patient exports, you CAN SELECT * and get correct results,
 * but always join through the bridge for multi-patient correctness.
 *
 *
 * 8. CLARITY_* TABLES ARE SHARED LOOKUPS
 * ──────────────────────────────────────
 * ~23 tables starting with CLARITY_ are reference/dimension tables:
 *   CLARITY_EDG = diagnoses (DX_ID → DX_NAME)
 *   CLARITY_SER = providers (PROV_ID → PROV_NAME)
 *   CLARITY_DEP = departments (DEPARTMENT_ID → DEPARTMENT_NAME)
 *   CLARITY_EAP = procedures (PROC_ID → PROC_NAME)
 *   CLARITY_EMP = employees
 *
 * They're shared across the whole graph — don't nest them anywhere.
 * Use lookupName() to resolve IDs to display names at projection time.
 *
 *
 * 9. BILLING IS A PARALLEL HIERARCHY
 * ──────────────────────────────────
 * Clinical data (PAT_ENC → orders → results) and billing data
 * (ARPB_TRANSACTIONS → actions → diagnoses → EOB) are parallel trees
 * connected by cross-references:
 *
 *   Clinical tree:                    Billing tree:
 *   PAT_ENC                           ARPB_TRANSACTIONS
 *     ├── ORDER_PROC                    ├── ARPB_TX_ACTIONS
 *     │   └── ORDER_RESULTS             ├── ARPB_CHG_ENTRY_DX
 *     ├── HNO_INFO                      ├── TX_DIAG
 *     └── PAT_ENC_DX                   └── PMT_EOB_INFO_I/II
 *                                     ACCOUNT
 *                 cross-ref:           ├── ACCOUNT_CONTACT
 *   ARPB_VISITS.PRIM_ENC_CSN_ID       └── ACCT_TX
 *        ↔ PAT_ENC_CSN_ID           HSP_ACCOUNT
 *                                      ├── HSP_TRANSACTIONS
 *                                      └── buckets → payments
 *                                    CLM_VALUES (claims)
 *                                      └── SVC_LN_INFO
 *                                    CL_REMIT (remittances)
 *                                      └── 14 child tables
 *
 * Don't stuff billing under encounters — it's its own tree.
 *
 *
 * 10. EPIC COLUMN DESCRIPTIONS ARE THE ROSETTA STONE
 * ──────────────────────────────────────────────────
 * The schemas/*.json files (from open.epic.com) contain natural-language
 * descriptions for every column. These often include explicit relationship
 * hints: "frequently used to link to the PATIENT table", "The unique ID of
 * the immunization record", "The contact serial number associated with the
 * primary patient contact."
 *
 * When extending to a new table, ALWAYS read the schema description first.
 * A human (or LLM) reading descriptions + one sample row can make correct
 * placement judgments where heuristic FK matching fails.
 *
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * PART 2: OUR MAPPING PHILOSOPHY
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * 1. NESTING EXPRESSES OWNERSHIP, NOT ALL RELATIONSHIPS
 *    Structural children (ORDER_RESULTS under ORDER_PROC) nest directly.
 *    Cross-references (billing ↔ encounters) use typed IDs + accessor methods.
 *    Provenance stamps (ALLERGY.ALLERGY_PAT_CSN) are metadata fields.
 *
 * 2. CONVENIENCE METHODS LIVE ON THE ENTITY THAT HOLDS THE FK
 *    encounter.billingVisit(record) — encounter has the CSN, billing visit
 *    points to it. billingVisit.encounter(record) — reverse direction.
 *    Both entities carry their own accessor for the relationship.
 *
 * 3. THE `record` PARAMETER IS THE INDEX
 *    Cross-reference accessors take PatientRecord as a parameter so they
 *    can use O(1) index lookups (encounterByCSN, orderByID). This keeps
 *    entities serializable and the dependency explicit.
 *
 * 4. EpicRow AS ESCAPE HATCH
 *    We can't type all 550 tables immediately. EpicRow = Record<string, unknown>
 *    lets child tables land somewhere even before they're fully typed.
 *    The ChildSpec[] arrays attach children systematically — typing comes later.
 *
 * 5. PAT_ID FILTERING FOR MULTI-PATIENT CORRECTNESS
 *    Every top-level query traces back to PAT_ID, even if the path goes
 *    through bridge tables (PAT_ALLERGIES, HAR_ALL, ACCT_GUAR_PAT_INFO).
 *    Single-patient exports happen to work without this, but multi-patient
 *    databases require it.
 *
 * 6. FALLBACK GRACEFULLY
 *    Every query checks tableExists() before running. If a bridge table is
 *    missing, fall back to SELECT * (correct for single-patient exports).
 *    If a child table is absent, skip it. The projection should work for
 *    partial exports and different Epic versions.
 *
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * PART 3: HOW TO EXTEND TO MORE TABLES
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * We currently cover 294/550 tables (53%). Extending is mechanical:
 *
 * STEP 1: IDENTIFY THE TABLE
 *   Run: SELECT name, COUNT(*) FROM sqlite_master ... to find unplaced
 *   tables with data. Group by likely parent using FK column names.
 *
 * STEP 2: READ THE SCHEMA DESCRIPTION
 *   Open schemas/{TABLE_NAME}.json. Read the column descriptions.
 *   Pay attention to phrases like:
 *     "...link to the PATIENT table"  → patient-level entity
 *     "...contact serial number"      → CSN reference
 *     "...unique ID of the order"     → structural child of ORDER_PROC
 *     "...the encounter in which"     → provenance stamp, NOT structural parent
 *
 * STEP 3: EXAMINE SAMPLE DATA
 *   SELECT * FROM {TABLE} LIMIT 5
 *   Check: what does the first column look like? (Usually the PK or FK)
 *   Do the ID values match a known parent table?
 *
 * STEP 4: DECIDE THE RELATIONSHIP TYPE
 *   Ask yourself:
 *   a) Does this table "belong to" its parent? (ORDER_RESULTS belongs to ORDER_PROC)
 *      → Structural child. Add a ChildSpec.
 *   b) Does it have its own identity and just reference the parent?
 *      (ARPB_VISITS references encounters but is its own entity)
 *      → Cross-reference. Model separately with accessor methods.
 *   c) Is the CSN column a "when was this touched" stamp?
 *      (ALLERGY.ALLERGY_PAT_CSN = encounter where allergy was noted)
 *      → Provenance. Store as a field, not a nesting relationship.
 *
 * STEP 5: ADD THE CHILDSPEC
 *   For structural children, add an entry to the appropriate *Children array:
 *     { table: "NEW_TABLE", fkCol: "PARENT_FK_COL", key: "descriptive_name" }
 *   That's it — attachChildren() handles the rest.
 *
 * STEP 6: VERIFY JOIN INTEGRITY
 *   Run test_project.ts. Add a new fkChecks entry for the table:
 *     { table: "NEW_TABLE", fkCol: "FK_COL", parentTable: "PARENT", parentCol: "PK_COL" }
 *   Check: are there orphans? Some orphans are expected (results on child
 *   orders), but 100% orphans means your FK mapping is wrong.
 *
 * STEP 7: ADD TO PatientRecord.ts
 *   Add a typed field to the appropriate entity class. If you're adding a
 *   new entity type (not just a child of an existing one), create a new
 *   class in PatientRecord.ts with its own constructor and accessors.
 *
 *
 * COMMON PATTERNS WHEN EXTENDING:
 *
 *   111-row tables with PAT_ENC_CSN_ID
 *     These have exactly one row per encounter. They're encounter-level
 *     metadata extensions. Add them as encounter children.
 *     Examples: PAT_ENC_BILLING_ENC, PAT_REVIEW_DATA, AN_RELINK_INFO
 *
 *   Tables keyed on ORDER_ID (not ORDER_PROC_ID)
 *     ORDER_PROC_ID and ORDER_ID are usually the same value but from
 *     different column definitions. Some child tables use ORDER_ID,
 *     others use ORDER_PROC_ID. Check the actual column name.
 *
 *   Tables keyed on DOCUMENT_ID
 *     DOCUMENT_ID can mean different things: it's the immunization record
 *     ID in IMM_ADMIN, the document ID in DOC_INFORMATION, etc.
 *     Always check which parent it actually points to.
 *
 *   Tables with IMAGE_ID
 *     In the billing domain, IMAGE_ID = remittance record ID.
 *     All CL_RMT_* tables use IMAGE_ID as their FK to CL_REMIT.
 *
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * PART 4: TESTING AND DEBUGGING
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * test_project.ts validates the database and projection at multiple levels:
 *
 * 1. DATABASE INTEGRITY
 *    - All 550 tables loaded, 10,974 rows
 *    - Every split table's join values match the base table
 *
 * 2. STRUCTURAL CORRECTNESS
 *    - Every child table's FK column exists
 *    - FK values resolve to the parent (orphan count)
 *    - Lookup tables resolve references (CLARITY_EDG 13/13, etc.)
 *
 * 3. CROSS-REFERENCE INTEGRITY
 *    - Billing visits → encounters (12/12 resolve)
 *    - History snapshot CSNs → encounters (5/5, 5/5, 25/25)
 *
 * 4. HYDRATION + ACCESSOR TESTS
 *    - PatientRecord loads from JSON
 *    - encounter.billingVisit(record) returns correct data
 *    - order.allResults(record) follows parent→child chain
 *    - HistoryTimeline.latest() returns most recent snapshot
 *    - Index lookups (encounterByCSN, orderByID) work
 *
 * DEBUGGING STRATEGIES:
 *
 *   "Column not found" errors
 *     Check if the column exists in the base table vs. a split table.
 *     Check if you're querying the right table (IP_DATA_STORE doesn't
 *     have PAT_ENC_CSN_ID — you need PAT_ENC_HSP as a bridge).
 *
 *   Zero results for a known-populated table
 *     The PAT_ID filter may be wrong. Check if the table has PAT_ID
 *     directly or needs a bridge table (PAT_ALLERGIES, ACCT_GUAR_PAT_INFO).
 *
 *   Orphaned child rows
 *     Some orphans are expected: PROB_UPDATES has 46/50 orphans because
 *     PROBLEM_LIST only has active problems while PROB_UPDATES includes
 *     edits to deleted problems (they're in PROBLEM_LIST_ALL).
 *     ORDER_RESULTS on child orders won't match ORDER_PROC directly
 *     because the child order is on a different encounter.
 *
 *   Split table join mismatches
 *     The split_config.json may have the wrong join column. Run:
 *       SELECT s.{join_col} FROM {split} s LIMIT 5
 *       SELECT b.{base_pk} FROM {base} b LIMIT 5
 *     If values don't match, find the column that does match.
 *     NOTE_ENC_INFO_2 was originally mapped to NOTE_CSN_ID (wrong) —
 *     the correct join is on NOTE_ID.
 *
 *   "All my billing data is empty"
 *     Billing tables don't have PAT_ID. They link through:
 *     ARPB_TRANSACTIONS → ACCOUNT_ID → ACCT_GUAR_PAT_INFO.PAT_ID
 *     ARPB_VISITS → PRIM_ENC_CSN_ID → PAT_ENC.PAT_ID
 *     HSP_ACCOUNT → HAR_ALL.ACCT_ID where HAR_ALL.PAT_ID
 *
 * QUALITY CRITERIA:
 *
 *   ✓ test_project.ts passes: 146+ db tests, 0 failures
 *   ✓ Hydration test passes: 15+ accessor tests, 0 failures
 *   ✓ Row counts match: allergies, problems, immunizations, encounters,
 *     medications, messages, billing transactions all match expected values
 *   ✓ Cross-references resolve: billing visits → encounters, history → encounters
 *   ✓ Parent→child chain works: lab results reachable from ordering encounter
 *   ✓ No "SELECT * FROM table" without PAT_ID filtering (unless bridge is absent)
 *   ✓ New ChildSpecs have a corresponding fkChecks entry in test_project.ts
 *
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * PART 5: FIELD NAMING AND INTERPRETATION
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Common Epic column suffixes and what they mean:
 *
 *   _C_NAME     Category value. Epic stores categories as integers internally
 *               and provides the human-readable name in the _C_NAME column.
 *               Example: TX_TYPE_C_NAME = "Charge" (not the raw category ID)
 *
 *   _YN         Yes/No flag. Values are "Y" or "N" (strings, not booleans).
 *
 *   _ID         A foreign key or primary key. May point to another table
 *               (DX_ID → CLARITY_EDG) or be an internal Epic identifier.
 *
 *   _ID_NAME    A denormalized name column. When Epic exports TABLE.FK_ID,
 *               it often includes TABLE.FK_ID_NAME with the resolved name.
 *               Example: ALLERGEN_ID + ALLERGEN_ID_ALLERGEN_NAME
 *
 *   _DTTM       Datetime (format: "9/28/2023 9:38:00 AM")
 *
 *   _DATE_REAL  Epic's internal date format (a float: days since epoch).
 *               Usually accompanied by a human-readable CONTACT_DATE.
 *
 *   _CSN        Contact serial number. See "CSN Column Name Chaos" above.
 *
 *   LINE        Multi-row child record line number. Tables like PAT_ENC_DX
 *               use LINE to number multiple diagnoses per encounter.
 *               The combination of (parent FK + LINE) is the composite key.
 *
 *   PAT_ENC_DATE_REAL  Almost always in the first column of encounter child
 *                      tables. Not useful for joining — use PAT_ENC_CSN_ID.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 */
</methodology>

## Your Task

Analyze the mapping pipeline for **Encounters: PAT_ENC (7 splits) → Encounter → HealthRecord.visits** and identify every semantic error — places where a column is read successfully but the value means something different than the code assumes.

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

### PAT_ENC_RSN_VISIT
**Table**: The PAT_ENC_RSN_VISIT contains the data entered as the Reason for Visit for a clinical system encounter. Each row in this table is one reason for visit associated with a patient encounter. One patient encounter may have multiple reasons for visit; therefore, the item LINE is used to identify each reason for visit within an encounter.
- **PAT_ENC_CSN_ID**: A unique serial number for this encounter. This number is unique across all patients and encounters in the system.
- **LINE**: The line number of the reason for visit within the encounter.
- **ENC_REASON_ID**: The ID of the record associated with the Reason for Visit entered in an encounter.
- **COMMENTS**: The comments associated with the reason for visit entered in a clinical system exam encounter.
- **RFV_ONSET_DT**: The onset date for reason for call/visit stored on this line.  Typically this value will only be collected during call workflows such as a telephone encounter.
- **BODY_LOC_ID**: The body location associated with the reason for visit for this patient encounter. This column is frequently used to link to the VESSEL_DOC table.
- **BODY_LOC_ID_RECORD_NAME**: Stores record name (.2)

## Sample Data (one representative non-null value per column)

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

### PAT_ENC_RSN_VISIT
- PAT_ENC_CSN_ID = `720803470`
- LINE = `1`
- ENC_REASON_ID = `160383`
- COMMENTS = `Neurology`
- RFV_ONSET_DT = `12/22/2023 12:00:00 AM`

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
[
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
          "ORDER_CLASS_C_NAME": "External Referral",
          "AUTHRZING_PROV_ID": "802011",
          "ORD_CREATR_USER_ID": "DHILLOPS",
          "ORD_CREATR_USER_ID_NAME": "DHILLON, PUNEET S",
          "
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