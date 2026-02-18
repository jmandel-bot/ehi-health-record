# How to Extend to More Tables

We currently cover 294/550 tables (53%). Extending is mechanical:

STEP 1: IDENTIFY THE TABLE
  Run: SELECT name, COUNT(*) FROM sqlite_master ... to find unplaced
  tables with data. Group by likely parent using FK column names.

STEP 2: READ THE SCHEMA DESCRIPTION
  Open schemas/{TABLE_NAME}.json. Read the column descriptions.
  Pay attention to phrases like:
    "...link to the PATIENT table"  → patient-level entity
    "...contact serial number"      → CSN reference
    "...unique ID of the order"     → structural child of ORDER_PROC
    "...the encounter in which"     → provenance stamp, NOT structural parent

STEP 3: EXAMINE SAMPLE DATA
  SELECT * FROM {TABLE} LIMIT 5
  Check: what does the first column look like? (Usually the PK or FK)
  Do the ID values match a known parent table?

STEP 4: DECIDE THE RELATIONSHIP TYPE
  Ask yourself:
  a) Does this table "belong to" its parent? (ORDER_RESULTS belongs to ORDER_PROC)
     → Structural child. Add a ChildSpec.
  b) Does it have its own identity and just reference the parent?
     (ARPB_VISITS references encounters but is its own entity)
     → Cross-reference. Model separately with accessor methods.
  c) Is the CSN column a "when was this touched" stamp?
     (ALLERGY.ALLERGY_PAT_CSN = encounter where allergy was noted)
     → Provenance. Store as a field, not a nesting relationship.

STEP 5: ADD THE CHILDSPEC
  For structural children, add an entry to the appropriate *Children array:
    { table: "NEW_TABLE", fkCol: "PARENT_FK_COL", key: "descriptive_name" }
  That's it — attachChildren() handles the rest.

STEP 6: VERIFY JOIN INTEGRITY
  Run test_project.ts. Add a new fkChecks entry for the table:
    { table: "NEW_TABLE", fkCol: "FK_COL", parentTable: "PARENT", parentCol: "PK_COL" }
  Check: are there orphans? Some orphans are expected (results on child
  orders), but 100% orphans means your FK mapping is wrong.

STEP 7: ADD TO PatientRecord.ts
  Add a typed field to the appropriate entity class. If you're adding a
  new entity type (not just a child of an existing one), create a new
  class in PatientRecord.ts with its own constructor and accessors.


COMMON PATTERNS WHEN EXTENDING:

  111-row tables with PAT_ENC_CSN_ID
    These have exactly one row per encounter. They're encounter-level
    metadata extensions. Add them as encounter children.
    Examples: PAT_ENC_BILLING_ENC, PAT_REVIEW_DATA, AN_RELINK_INFO

  Tables keyed on ORDER_ID (not ORDER_PROC_ID)
    ORDER_PROC_ID and ORDER_ID are usually the same value but from
    different column definitions. Some child tables use ORDER_ID,
    others use ORDER_PROC_ID. Check the actual column name.

  Tables keyed on DOCUMENT_ID
    DOCUMENT_ID can mean different things: it's the immunization record
    ID in IMM_ADMIN, the document ID in DOC_INFORMATION, etc.
    Always check which parent it actually points to.

  Tables with IMAGE_ID
    In the billing domain, IMAGE_ID = remittance record ID.
    All CL_RMT_* tables use IMAGE_ID as their FK to CL_REMIT.
