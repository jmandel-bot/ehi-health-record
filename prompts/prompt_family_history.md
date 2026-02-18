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

Analyze the mapping pipeline for **Family History: FAMILY_HX_STATUS + FAMILY_HX → HealthRecord.familyHistory** and identify every semantic error — places where a column is read successfully but the value means something different than the code assumes.

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

### FAMILY_HX_STATUS
**Table**: Family status relationship table.  Contains the relationship to the patient and the name of the family member, as well as the source of this information.
- **PAT_ENC_CSN_ID**: The unique contact serial number for this contact. This number is unique across all patient encounters in your system. If you use IntraConnect this is the Unique Contact Identifier (UCI).
- **LINE**: The line number for the information associated with this contact. Multiple pieces of information can be associated with this contact.
- **CONTACT_DATE**: The date of this contact in calendar format.
- **FAM_STAT_REL_C_NAME**: The family status relationship category number for the relationship between the patient and their family member.
- **FAM_STAT_STATUS_C_NAME**: The family status category number for the family member, such as 1 for "alive" and 2 for "deceased".
- **FAM_STAT_DEATH_AGE**: Age of family member at their death.
- **FAM_STAT_COMMENT**: This item contains the free text comments associated with a patient's family member status in medical history.
- **FAM_STAT_NAME**: The name of family member.
- **FAM_STAT_SRC_C_NAME**: The family status source category number for the source of corresponding family status information.
- **HX_LNK_ENC_CSN**: The Contact Serial Number of the encounter in which the history was created/edited. If the history was created/edited outside of the context of an encounter, then this column will be blank.
- **FAM_STAT_DOB_DT**: This is used to calculate the age of a relative. This is either the date of birth (approximate or exact) or part of a range. If it is a range, then this column will be the beginning date and FAM_STAT_DOB_END_DT will store the end date. This range of dates is used to define an age range.
- **FAM_STAT_ID**: The Unique ID for the family member.
- **FAM_STAT_FATHER_ID**: Unique ID for the Father
- **FAM_STAT_MOTHER_ID**: Unique ID for the mother.
- **FAM_STAT_DOB_END_DT**: If an age range is entered for a family member, then the range is stored as two dates. This column holds the end date and FAM_STAT_DOB_DT holds the beginning date.
- **FAM_STAT_TWIN**: This item tracks twin relationships among members of the patient's family.  Two family members who are twins (or three who are triplets, etc.) will have the same value on their lines of this item.  A value of 0 indicates that the family member is a twin of the patient.
- **FAM_STAT_IDENT_TWIN**: This item tracks identical twin relationships among members of the patient's family.  Two family members who are identical twins (or three who are identical triplets, etc.) will have the same value on their lines of this item.  A value of 0 indicates that the family member is an identical twin of the patient.
- **FAM_STAT_COD_C_NAME**: The cause of death of a family member of the patient.
- **FAM_STAT_SEX_C_NAME**: This item stores the sex of a family member of the patient.
- **FAM_STAT_GENDER_IDENTITY_C_NAME**: Gender identity for a family member.
- **FAM_STAT_REL_ID**: This item stores the unique ID of the patient relationship record. The patient relationship record contains information about how the person is related to the patient.
- **FAM_STAT_ADOPT_C_NAME**: Adoption status of a particular family member.
- **FAM_STAT_ADPT_PAR_1**: The ID of a relative's adoptive parent. We allow two adoptive parents. The other adoptive parent ID is stored in I EPT 20359.
- **FAM_STAT_ADPT_PAR_2**: The ID of a relative's adoptive parent. We allow two adoptive parents. The other adoptive parent ID is stored in I EPT 20358.
- **FAM_STAT_PREG_EPISODE_ID**: This item stores a link to the patient's pregnancy information in Obstetric history.
- **FAM_STAT_DELIV_EPISODE_ID**: This item stores a link to the patient's delivery information for Obstetric History.
- **FAM_HX_FERT_STAT_C_NAME**: This field contains the category value representing a patient's relative's fertility status.
- **FAM_HX_FERT_NOTE**: This field is a free text item holding notes pertaining to a particular relative's fertility status.

### FAMILY_HX
**Table**: The FAMILY_HX table contains data recorded in the family history contacts entered in the patient's chart during a clinical system encounter. Note: This table is designed to hold a patient's history over time; however, it is most typically implemented to only extract the latest patient history contact.
- **LINE**: The line number to identify the family history contact within the patient�s record.  NOTE: Each line of history is stored in enterprise reporting as its own record; a given patient may have multiple records (identified by line number) that reflect multiple lines of history.
- **MEDICAL_HX_C_NAME**: The category value associated with the Problem documented in the patient�s family history.
- **MEDICAL_OTHER**: The custom reason for visit or problem entered when the clinical system user chooses "Other" as a family history problem. NOTE: The comment is stored in the same item as MEDICAL_HX_C but is delimited from the response "Other" by the comment character, "[". The EPIC_GET_COMMENT function returns everything after the comment character.
- **COMMENTS**: Free-text comments entered with this problem. This column may be hidden in a public enterprise reporting view.
- **PAT_ENC_CSN_ID**: A unique serial number for this encounter. This number is unique across all patients and encounters in the system.
- **FAM_HX_SRC_C_NAME**: This item contains the source of information for a patient's family medical history.
- **RELATION_C_NAME**: This is the category value associated with the family member who has or had this problem. An example might be sister, brother, or mother.
- **FAM_RELATION_NAME**: This is the first and/or last name of the patient's family member. This column is free-text and is meant to be used together with the RELATION_C category to form a unique key for the family member. If no name is entered this column will display an abbreviation of the family relation type beginning with ##.
- **AGE_OF_ONSET**: This item contains the age of onset of the patient's family member that is documented with a history of a problem.
- **FAM_MED_REL_ID**: This item contains the unique ID of the patient's family member relationship for medical history.
- **FAM_MEDICAL_DX_ID**: The unique ID of the diagnosis associated with the family member condition.
- **AGE_OF_ONSET_END**: When the age of onset for a family member's history of a problem is documented as an age range, this item contains the age at the end of the range.

## Sample Data (one representative non-null value per column)

### FAMILY_HX_STATUS
- PAT_ENC_CSN_ID = `724623985`
- LINE = `1`
- CONTACT_DATE = `9/28/2023 12:00:00 AM`
- FAM_STAT_REL_C_NAME = `Mother`
- FAM_STAT_STATUS_C_NAME = `Alive`
- FAM_STAT_SRC_C_NAME = `Provider`
- HX_LNK_ENC_CSN = `991225117`
- FAM_STAT_ID = `2`
- FAM_STAT_FATHER_ID = `9`
- FAM_STAT_MOTHER_ID = `8`
- FAM_STAT_SEX_C_NAME = `Female`
- FAM_STAT_GENDER_IDENTITY_C_NAME = `Female`

### FAMILY_HX
- LINE = `1`
- MEDICAL_HX_C_NAME = `Ovarian cancer`
- COMMENTS = `s/p thyroidectomy`
- PAT_ENC_CSN_ID = `724623985`
- FAM_HX_SRC_C_NAME = `Provider`
- RELATION_C_NAME = `Mother`
- FAM_MED_REL_ID = `2`

## Pipeline Code

### Stage 1: SQL Projection (project.ts → raw JSON)
```typescript
// In main():
family_history: tableExists("FAMILY_HX_STATUS") ? q(`SELECT * FROM FAMILY_HX_STATUS`) : [],
family_hx: tableExists("FAMILY_HX") ? q(`SELECT * FROM FAMILY_HX`) : [],
```

### Stage 2: Domain Model Hydration (PatientRecord.ts)
```typescript
// family_history → HistoryTimeline via buildTimeline()
// family_hx → stored as _raw.family_hx
```

### Stage 3: Clean Projection (HealthRecord.ts → final output)
```typescript
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
    "relation": "Mother",
    "status": "Alive",
    "conditions": [
      {
        "name": "Ovarian cancer",
        "_epic": {
          "LINE": 1,
          "MEDICAL_HX_C_NAME": "Ovarian cancer",
          "PAT_ENC_CSN_ID": 991221485,
          "FAM_HX_SRC_C_NAME": "Provider",
          "RELATION_C_NAME": "Mother",
          "FAM_MED_REL_ID": 2
        }
      },
      {
        "name": "Hypertension",
        "_epic": {
          "LINE": 2,
          "MEDICAL_HX_C_NAME": "Hypertension",
          "PAT_ENC_CSN_ID": 991221485,
          "FAM_HX_SRC_C_NAME": "Provider",
          "RELATION_C_NAME": "Mother",
          "FAM_MED_REL_ID": 2
        }
      },
      {
        "name": "Thyroid disease",
        "comment": "s/p thyroidectomy",
        "_epic": {
          "LINE": 3,
          "MEDICAL_HX_C_NAME": "Thyroid disease",
          "COMMENTS": "s/p thyroidectomy",
          "PAT_ENC_CSN_ID": 991221485,
          "FAM_HX_SRC_C_NAME": "Provider",
          "RELATION_C_NAME": "Mother",
          "FAM_MED_REL_ID": 2
        }
      }
    ],
    "_epic": {
      "PAT_ENC_CSN_ID": 1028739468,
      "LINE": 1,
      "CONTACT_DATE": "9/28/2023 12:00:00 AM",
      "FAM_STAT_REL_C_NAME": "Mother",
      "FAM_STAT_STATUS_C_NAME": "Alive",
      "FAM_STAT_SRC_C_NAME": "Provider",
      "HX_LNK_ENC_CSN": 991225117,
      "FAM_STAT_ID": 2,
      "FAM_STAT_FATHER_ID": 9,
      "FAM_STAT_MOTHER_ID": 8,
      "FAM_STAT_SEX_C_NAME": "Female",
      "FAM_STAT_GENDER_IDENTITY_C_NAME": "Female"
    }
  },
  {
    "relation": "Father",
    "status": "Alive",
    "conditions": [
      {
        "name": "Hyperlipidemia",
        "_epic": {
          "LINE": 4,
          "MEDICAL_HX_C_NAME": "Hyperlipidemia",
          "PAT_ENC_CSN_ID": 991221485,
          "FAM_HX_SRC_C_NAME": "Provider",
          "RELATION_C_NAME": "Father",
          "FAM_MED_REL_ID": 6
        }
      }
    ],
    "_epic": {
      "PAT_ENC_CSN_ID": 1028739468,
      "LINE": 2,
      "CONTACT_DATE": "9/28/2023 12:00:00 AM",
      "FAM_STAT_REL_C_NAME": "Father",
      "FAM_STAT_STATUS_C_NAME": "Alive",
      "HX_LNK_ENC_CSN": 991225117,
      "FAM_STAT_ID": 6,
      "FAM_STAT_FATHER_ID": 11,
      "FAM_STAT_MOTHER_ID": 10,
      "FAM_STAT_SEX_C_NAME": "Male",
      "FAM_STAT_GENDER_IDENTITY_C_NAME": "Male"
    }
  },
  {
    "relation": "Brother",
    "status": "Alive",
    "conditions": [
      {
        "name": "Hypertension",
        "_epic": {
          "LINE": 5,
          "MEDICAL_HX_C_NAME": "Hypertension",
          "PAT_ENC_CSN_ID": 991221485,
          "FAM_HX_SRC_C_NAME": "Provider",
          "RELATION_C_NAME": "Brother",
          "FAM_MED_REL_ID": 5
        }
      },
      {
        "name": "Hyperlipidemia",
        "_epic": {
          "LINE": 6,
          "MEDICAL_HX_C_NAME": "Hyperlipidemia",
          "PAT_ENC_CSN_ID": 991221485,
          "FAM_HX_SRC_C_NAME": "Provider",
          "RELATION_C_NAME": "Brother",
          "FAM_MED_REL_ID": 5
        }
      }
    ],
    
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