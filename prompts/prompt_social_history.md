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

Analyze the mapping pipeline for **Social History: SOCIAL_HX → HistoryTimeline → HealthRecord.socialHistory** and identify every semantic error — places where a column is read successfully but the value means something different than the code assumes.

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

### SOCIAL_HX
**Table**: The SOCIAL_HX table contains social history data for each history encounter stored in your system. This table has one row per history encounter.
- **CONTACT_DATE**: The date of this contact in calendar format.
- **CIGARETTES_YN**: Y if the patient uses cigarettes. N if the patient does not.  NOTE: Uses the EPIC_IN_ITEM function to determine if a given value exists in a multiple response item.  If the category value for this selection exists in the multiple response item, then it returns "Y", otherwise it returns "N".
- **PIPES_YN**: Y if the patient smokes a pipe. N if the patient does not.  NOTE: Uses the EPIC_IN_ITEM function to determine if a given value exists in a multiple response item.  If the category value for this selection exists in the multiple response item, then it returns "Y", otherwise it returns "N".
- **CIGARS_YN**: Y if the patient uses cigars. N if the patient does not. NOTE: Uses the EPIC_IN_ITEM function to determine if a given value exists in a multiple response item.  If the category value for this selection exists in the multiple response item, then it returns "Y", otherwise it returns "N".
- **SNUFF_YN**: Y if the patient uses snuff. N if the patient does not. NOTE: Uses the EPIC_IN_ITEM function to determine if a given value exists in a multiple response item.  If the category value for this selection exists in the multiple response item, then it returns "Y", otherwise it returns "N".
- **CHEW_YN**: Y if the patient uses chewing tobacco. N if the patient does not. NOTE: Uses the EPIC_IN_ITEM function to determine if a given value exists in a multiple response item.  If the category value for this selection exists in the multiple response item, then it returns "Y", otherwise it returns "N".
- **ALCOHOL_OZ_PER_WK**: The fluid ounces of alcohol the patient consumes per week.
- **ALCOHOL_COMMENT**: Free-text comments regarding the patient�s use of alcohol.
- **IV_DRUG_USER_YN**: Y if the patient is an IV drug user. N if the patient is not.  NOTE: Uses the EPIC_IN_ITEM function to determine if a given value exists in a multiple response item.  If the category value for this selection exists in the multiple response item, then it returns "Y", otherwise it returns "N".
- **ILLICIT_DRUG_FREQ**: The times per week the patient uses or used illicit drugs.
- **ILLICIT_DRUG_CMT**: Free-text comments regarding the patient�s use of illicit drugs.
- **FEMALE_PARTNER_YN**: Y if the patient has a female sexual partner. N if the patient does not. NOTE: Uses the EPIC_IN_ITEM function to determine if a given value exists in a multiple response item.  If the category value for this selection exists in the multiple response item, then it returns "Y", otherwise it returns "N".
- **MALE_PARTNER_YN**: Y if the patient has a male sexual partner. N if the patient does not. NOTE: Uses the EPIC_IN_ITEM function to determine if a given value exists in a multiple response item.  If the category value for this selection exists in the multiple response item, then it returns "Y", otherwise it returns "N".
- **CONDOM_YN**: Y if the patient uses a condom during sexual activity. N if the patient does not. NOTE: Uses the EPIC_IN_ITEM function to determine if a given value exists in a multiple response item.  If the category value for this selection exists in the multiple response item, then it returns "Y", otherwise it returns "N".
- **PILL_YN**: Y if the patient uses birth control pills. N if the patient does not. NOTE: Uses the EPIC_IN_ITEM function to determine if a given value exists in a multiple response item.  If the category value for this selection exists in the multiple response item, then it returns "Y", otherwise it returns "N".
- **DIAPHRAGM_YN**: Y if the patient uses a diaphragm. N if the patient does not. NOTE: Uses the EPIC_IN_ITEM function to determine if a given value exists in a multiple response item.  If the category value for this selection exists in the multiple response item, then it returns "Y", otherwise it returns "N".
- **IUD_YN**: Y if the patient uses an IUD. N if the patient does not. NOTE: Uses the EPIC_IN_ITEM function to determine if a given value exists in a multiple response item.  If the category value for this selection exists in the multiple response item, then it returns "Y", otherwise it returns "N".
- **SURGICAL_YN**: Y if the patient uses a surgical method of birth control such as hysterectomy, vasectomy, or tubal-ligation. N if the patient does not. NOTE: Uses the EPIC_IN_ITEM function to determine if a given value exists in a multiple response item.  If the category value for this selection exists in the multiple response item, then it returns "Y", otherwise it returns "N".
- **SPERMICIDE_YN**: Y if the patient uses spermicide. N if the patient does not. NOTE: Uses the EPIC_IN_ITEM function to determine if a given value exists in a multiple response item.  If the category value for this selection exists in the multiple response item, then it returns "Y", otherwise it returns "N".
- **IMPLANT_YN**: Y if the patient uses an implant as a form of birth control. N if the patient does not. NOTE: Uses the EPIC_IN_ITEM function to determine if a given value exists in a multiple response item.  If the category value for this selection exists in the multiple response item, then it returns "Y", otherwise it returns "N".
- **RHYTHM_YN**: Y if the patient uses the rhythm method as a form of birth control. N if the patient does not. NOTE: Uses the EPIC_IN_ITEM function to determine if a given value exists in a multiple response item.  If the category value for this selection exists in the multiple response item, then it returns "Y", otherwise it returns "N".
- **INJECTION_YN**: Y if the patient uses an injection as a form of birth control. N if the patient does not. NOTE: Uses the EPIC_IN_ITEM function to determine if a given value exists in a multiple response item.  If the category value for this selection exists in the multiple response item, then it returns "Y", otherwise it returns "N".
- **SPONGE_YN**: Y if the patient uses a sponge as a form of birth control. N if the patient does not. NOTE: Uses the EPIC_IN_ITEM function to determine if a given value exists in a multiple response item.  If the category value for this selection exists in the multiple response item, then it returns "Y", otherwise it returns "N".
- **INSERTS_YN**: Y if the patient uses inserts as a form of birth control. N if the patient does not. NOTE: Uses the EPIC_IN_ITEM function to determine if a given value exists in a multiple response item.  If the category value for this selection exists in the multiple response item, then it returns "Y", otherwise it returns "N".
- **ABSTINENCE_YN**: Y if the patient practices abstinence. N if the patient does not. NOTE: Uses the EPIC_IN_ITEM function to determine if a given value exists in a multiple response item.  If the category value for this selection exists in the multiple response item, then it returns "Y", otherwise it returns "N".
- **SEX_COMMENT**: Free-text comments regarding the patient�s sexual activity.
- **YEARS_EDUCATION**: The number of years of education the patient has completed. Note: This is a free text field.
- **PAT_ENC_CSN_ID**: A unique serial number for this encounter. This number is unique across all patients and encounters in the system.
- **TOB_SRC_C_NAME**: Source for Tobacco History
- **ALCOHOL_SRC_C_NAME**: This columns stores the person (e.g. provider, patient, legal guardian) who provided alcohol use information for this encounter.
- **DRUG_SRC_C_NAME**: This columns stores the person (e.g. provider, patient, legal guardian) who provided illicit drug use information for this encounter.
- **SEX_SRC_C_NAME**: This columns stores the person (e.g. provider, patient, legal guardian) who provided sexual activity information for this encounter.
- **HX_LNK_ENC_CSN**: The Contact Serial Number of the encounter in which the history was created/edited. If the history was created/edited outside of the context of an encounter, then this column will be blank.
- **ALCOHOL_USE_C_NAME**: The category value associated with the patient's alcohol use. Data may include, Yes, No, or Not Asked.
- **ILL_DRUG_USER_C_NAME**: The category value associated with the patient's use of illicit drugs. Data may include, Yes, No, or Not Asked.
- **SEXUALLY_ACTIVE_C_NAME**: The category value associated with the patient's sexual activity. Data may include Yes, No, Not Asked, or Not Now
- **TOBACCO_USER_C_NAME**: The category value associated with the patient's tobacco use. Data may include, Yes, Never, Not Asked or Quit.
- **SMOKELESS_TOB_USE_C**: Stores the patient's usage of smokeless tobacco.  Data may include, Current User, Former User, Never Used or Unknown.
- **SMOKELESS_QUIT_DATE**: The date on which the patient quit using smokeless tobacco.
- **SMOKING_TOB_USE_C**: Stores the patient's usage of smoking tobacco.  Data may include, Current Everyday Smoker, Current Some Day Smoker, Former Smoker, Never Smoker, Unknown If Ever Smoked or Smoker, Current Status Unknown.
- **UNKNOWN_FAM_HX_YN**: Y if the patient's family history is unknown by the patient. N otherwise.
- **EDU_LEVEL_C_NAME**: This item stores responses to the social determinants of health question about level of education. Response is categorical, and corresponds to highest level of school attended.
- **FIN_RESOURCE_STRAIN_C_NAME**: This item stores responses to the social determinants of health question about financial resource strain.
- **IPV_EMOTIONAL_ABUSE_C_NAME**: This item stores responses to the social determinants of health question about emotional abuse from an intimate partner.
- **IPV_FEAR_C_NAME**: This item stores responses to the social determinants of health question about fear of an intimate partner.
- **IPV_SEXUAL_ABUSE_C_NAME**: This item stores responses to the social determinants of health question about sexual abuse from an intimate partner.
- **IPV_PHYSICAL_ABUSE_C_NAME**: This item stores responses to the social determinants of health question about physical abuse from an intimate partner.
- **ALCOHOL_FREQ_C_NAME**: This item stores responses for the social determinants of health question about frequency of drinking alcohol.
- **ALCOHOL_DRINKS_PER_DAY_C_NAME**: This item stores responses for the social determinants of health questions about number of standard drinks consumed in a typical day.
- **ALCOHOL_BINGE_C_NAME**: This item stores responses for the social determinants of health questions about binge drinking.
- **LIVING_W_SPOUSE_C_NAME**: This item stores the response to social determinants of health question about whether or not the patient is currently living with spouse or partner.
- **DAILY_STRESS_C_NAME**: This item stores responses to the social determinants of health question about daily stress.
- **PHONE_COMMUNICATION_C_NAME**: This item stores responses to the social determinants of health question about how often the patient socializes with friends or family over the phone.
- **SOCIALIZATION_FREQ_C_NAME**: This item stores responses to the social determinants of health question about how often the patient socializes with friends or family in person.
- **CHURCH_ATTENDANCE_C_NAME**: This item stores responses to the social determinants of health question about how often the patient attends religious services.
- **CLUBMTG_ATTENDANCE_C_NAME**: This item stores responses to the social determinants of health question about how often the patient attends club or other organization meetings in a year.
- **CLUB_MEMBER_C_NAME**: This item stores responses to the social determinants of health question about whether the patient is a member of any clubs or organizations.
- **PHYS_ACT_DAYS_PER_WEEK_C_NAME**: This item stores responses to the social determinants of health question about how many days a week the patient exercises.
- **PHYS_ACT_MIN_PER_SESS_C_NAME**: This item stores responses to the social determinants of health question about how many minutes the patient exercises on days that they exercise.
- **FOOD_INSECURITY_SCARCE_C_NAME**: This item stores responses to the social determinants of health question about whether or not the patient had run out of food and was not able to buy more.
- **FOOD_INSECURITY_WORRY_C_NAME**: This item stores responses to the social determinants of health question about whether the patient worried about food running out in the past year or not.
- **MED_TRANSPORT_NEEDS_C_NAME**: This item stores responses to the social determinants of health question about whether the patient had difficulty regarding transportation for medical appointments and medicine.
- **OTHER_TRANSPORT_NEEDS_C_NAME**: This item stores responses to the social determinants of health question about whether the patient had difficulty regarding transportation for things other than medical appointments and medicine.
- **SOC_PHONE_SRC_C_NAME**: Stores the source of entry for a patient's Social Connections Phone history.
- **SOC_TOGETHER_SRC_C_NAME**: Stores the source of entry for a patient's Social Connections Get Together history.
- **SOC_CHURCH_SRC_C_NAME**: Stores the source of entry for a patient's Social Connections Church history.
- **SOC_MEETINGS_SRC_C_NAME**: Stores the source of entry for a patient's Social Connections Meetings history.
- **SOC_MEMBER_SRC_C_NAME**: Stores the source of entry for a patient's Social Connections Membership history.
- **SOC_LIVING_SRC_C_NAME**: Stores the source of entry for a patient's Social Connections Living history.
- **PHYS_DPW_SRC_C_NAME**: Stores the source of entry for a patient's Physical Activity Days per Week history.
- **PHYS_MPS_SRC_C_NAME**: Stores the source of entry for a patient's Physical Activity Minutes Per Session history.
- **STRESS_SRC_C_NAME**: Stores the source of entry for a patient's Stress history.
- **EDUCATION_SRC_C_NAME**: Stores the source of entry for a patient's Education history.
- **FINANCIAL_SRC_C_NAME**: Stores the source of entry for a patient's Financial history.
- **IPV_EMOTIONAL_SRC_C_NAME**: Stores the source of entry for a patient's Intimate Partner Violence (IPV) emotional history.
- **IPV_FEAR_SRC_C_NAME**: Stores the source of entry for a patient's IPV Fear history.
- **IPV_SEXABUSE_SRC_C_NAME**: Stores the source of entry for a patient's IPV Sexual Abuse history.
- **IPV_PHYSABUSE_SRC_C_NAME**: Stores the source of entry for a patient's physical abuse history.
- **ALC_FREQ_SRC_C_NAME**: Stores the source of entry for a patient's Alcohol Frequency history.
- **ALC_STD_DRINK_SRC_C_NAME**: Stores the source of entry for a patient's Alcohol Standard Drinks history.
- **ALC_BINGE_SRC_C_NAME**: Stores the source of entry for a patient's Alcohol Binge history.
- **FOOD_WORRY_SRC_C_NAME**: Stores the source of entry for a patient's Food Worry history.
- **FOOD_SCARCITY_SRC_C_NAME**: Stores the source of entry for a patient's Food Scarcity history.
- **TRANS_MED_SRC_C_NAME**: Stores the source of entry for a patient's Transport Medical history.
- **TRANS_NONMED_SRC_C_NAME**: Stores the source of entry for a patient's Transport Non-medical history.
- **FAM_PAT_ADPT_PAR_1**: Stores the family history ID of the patient's adoptive parent. A patient can have two adoptive parents. The ID of the other parent is in FAM_PAT_ADPT_PAR_2.
- **FAM_PAT_ADPT_PAR_2**: Stores the family history ID of the patient's adoptive parent. A patient can have two adoptive parents. The ID of the other parent is in FAM_PAT_ADPT_PAR_1.
- **TOB_HX_ADDL_PACKYEARS**: Number to add to the total number of pack years calculated for the patient's tobacco history.
- **TOB_HX_SMOKE_EXPOSURE_CMT**: Store the comment for passive tobacco smoke exposure.
- **PASSIVE_SMOKE_EXPOSURE_C_NAME**: Document the patient's passive smoke exposure.
- **FAMHX_PAT_IS_ADOPTED_C_NAME**: The Adoption Status category ID for the patient.

## Sample Data (one representative non-null value per column)

### SOCIAL_HX
- CONTACT_DATE = `9/28/2023 12:00:00 AM`
- CIGARETTES_YN = `N`
- PIPES_YN = `N`
- CIGARS_YN = `N`
- SNUFF_YN = `N`
- CHEW_YN = `N`
- ALCOHOL_COMMENT = `about 3-4 drinks per week`
- IV_DRUG_USER_YN = `N`
- ILLICIT_DRUG_CMT = `occasional cannabis`
- FEMALE_PARTNER_YN = `Y`
- MALE_PARTNER_YN = `N`
- CONDOM_YN = `N`
- PILL_YN = `N`
- DIAPHRAGM_YN = `N`
- IUD_YN = `N`
- SURGICAL_YN = `N`
- SPERMICIDE_YN = `N`
- IMPLANT_YN = `N`
- RHYTHM_YN = `N`
- INJECTION_YN = `N`
- SPONGE_YN = `N`
- INSERTS_YN = `N`
- ABSTINENCE_YN = `N`
- PAT_ENC_CSN_ID = `724623985`
- TOB_SRC_C_NAME = `Provider`
- ALCOHOL_SRC_C_NAME = `Provider`
- DRUG_SRC_C_NAME = `Provider`
- SEX_SRC_C_NAME = `Provider`
- HX_LNK_ENC_CSN = `991225117`
- ALCOHOL_USE_C_NAME = `Yes`
- ILL_DRUG_USER_C_NAME = `No`
- SEXUALLY_ACTIVE_C_NAME = `Yes`
- TOBACCO_USER_C_NAME = `Never`
- SMOKELESS_TOB_USE_C = `3`
- SMOKING_TOB_USE_C = `5`
- UNKNOWN_FAM_HX_YN = `N`

## Pipeline Code

### Stage 1: SQL Projection (project.ts → raw JSON)
```typescript
// In main():
social_history: q(`SELECT * FROM SOCIAL_HX`),
```

### Stage 2: Domain Model Hydration (PatientRecord.ts)
```typescript
export class HistoryTimeline<T> {
  constructor(public readonly snapshots: HistorySnapshot<T>[]) {}

  latest(): T | undefined {
    return this.snapshots.at(-1)?.data;
  }

  /**
   * Get the history snapshot associated with a given encounter CSN.
   * Checks both the history's own contact CSN (snapshotCSN) and
   * the clinical visit CSN it was reviewed during (reviewedDuringEncounterCSN).
   */
  asOfEncounter(csn: CSN): T | undefined {
    return this.snapshots.find(
      s => s.reviewedDuringEncounterCSN === csn || s.snapshotCSN === csn
    )?.data;
  }

  asOfDate(date: string): T | undefined {
    return [...this.snapshots].reverse().find(s => (s.contactDate ?? '') <= date)?.data;
  }

  get length(): number {
    return this.snapshots.length;
  }
}

    this.socialHistory = buildTimeline((json.social_history as EpicRow[]) ?? []);
    this.surgicalHistory = buildTimeline((json.surgical_history as EpicRow[]) ?? []);
    this.familyHistory = buildTimeline((json.family_history as EpicRow[]) ?? []);

    // Preserve raw projection data for the clean HealthRecord projection
    this._raw = {
      family_hx: json.family_hx ?? [],
    };
```

### Stage 3: Clean Projection (HealthRecord.ts → final output)
```typescript
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

  const all: SocialHistory[] = tl.snapshots.map((s: any) => projectOneSocialHistory(s.data));

  // Deduplicate: only keep a snapshot if its content differs from the next-newer one
  const deduped: SocialHistory[] = [all[0]];
  for (let i = 1; i < all.length; i++) {
    if (socialHistoryDiffers(all[i], all[i - 1])) {
      deduped.push(all[i]);
    }
  }
```

## Actual Output (from health_record_full.json)

```json
{
  "current": {
    "tobacco": {
      "status": "Never"
    },
    "alcohol": {
      "status": "Yes",
      "comment": "about 3-4 drinks per week"
    },
    "drugs": {
      "status": "No",
      "comment": "occasional cannabis"
    },
    "sexualActivity": "Yes",
    "asOf": "2023-09-28",
    "_epic": {
      "CONTACT_DATE": "9/28/2023 12:00:00 AM",
      "CIGARETTES_YN": "N",
      "PIPES_YN": "N",
      "CIGARS_YN": "N",
      "SNUFF_YN": "N",
      "CHEW_YN": "N",
      "ALCOHOL_COMMENT": "about 3-4 drinks per week",
      "IV_DRUG_USER_YN": "N",
      "ILLICIT_DRUG_CMT": "occasional cannabis",
      "FEMALE_PARTNER_YN": "Y",
      "MALE_PARTNER_YN": "N",
      "CONDOM_YN": "N",
      "PILL_YN": "N",
      "DIAPHRAGM_YN": "N",
      "IUD_YN": "N",
      "SURGICAL_YN": "N",
      "SPERMICIDE_YN": "N",
      "IMPLANT_YN": "N",
      "RHYTHM_YN": "N",
      "INJECTION_YN": "N",
      "SPONGE_YN": "N",
      "INSERTS_YN": "N",
      "ABSTINENCE_YN": "N",
      "PAT_ENC_CSN_ID": 1028739468,
      "TOB_SRC_C_NAME": "Provider",
      "ALCOHOL_SRC_C_NAME": "Provider",
      "DRUG_SRC_C_NAME": "Provider",
      "SEX_SRC_C_NAME": "Provider",
      "HX_LNK_ENC_CSN": 991225117,
      "ALCOHOL_USE_C_NAME": "Yes",
      "ILL_DRUG_USER_C_NAME": "No",
      "SEXUALLY_ACTIVE_C_NAME": "Yes",
      "TOBACCO_USER_C_NAME": "Never",
      "SMOKELESS_TOB_USE_C": 3,
      "SMOKING_TOB_USE_C": 5,
      "UNKNOWN_FAM_HX_YN": "N"
    }
  },
  "prior": [
    {
      "tobacco": {
        "status": "Never"
      },
      "alcohol": {
        "status": "Yes",
        "comment": "drinks 3-4 days /week"
      },
      "drugs": {
        "status": "No"
      },
      "sexualActivity": "Yes",
      "asOf": "2020-01-09",
      "_epic": {
        "CONTACT_DATE": "1/9/2020 12:00:00 AM",
        "CIGARETTES_YN": "N",
        "PIPES_YN": "N",
        "CIGARS_YN": "N",
        "SNUFF_YN": "N",
        "CHEW_YN": "N",
        "ALCOHOL_COMMENT": "drinks 3-4 days /week",
        "IV_DRUG_USER_YN": "N",
        "FEMALE_PARTNER_YN": "Y",
        "MALE_PARTNER_YN": "N",
        "CONDOM_YN": "N",
        "PILL_YN": "N",
        "DIAPHRAGM_YN": "N",
        "IUD_YN": "N",
        "SURGICAL_YN": "N",
        "SPERMICIDE_YN": "N",
        "IMPLANT_YN": "N",
        "RHYTHM_YN": "N",
        "INJECTION_YN": "N",
        "SPONGE_YN": "N",
        "INSERTS_YN": "N",
        "ABSTINENCE_YN": "N",
        "PAT_ENC_CSN_ID": 802802103,
        "TOB_SRC_C_NAME": "Provider",
        "ALCOHOL_SRC_C_NAME": "Provider",
        "DRUG_SRC_C_NAME": "Provider",
        "SEX_SRC_C_NAME": "Provider",
        "HX_LNK_ENC_CSN": 799951565,
        "ALCOHOL_USE_C_NAME": "Yes",
        "ILL_DRUG_USER_C_NAME": "No",
        "SEXUALLY_ACTIVE_C_NAME": "Yes",
        "TOBACCO_USER_C_NAME": "Never",
        "SMOKELESS_TOB_USE_C": 3,
        "SMOKING_TOB_USE_C": 5,
        "UNKNOWN_FAM_HX_YN": "N"
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