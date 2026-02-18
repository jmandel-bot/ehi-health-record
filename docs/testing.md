# Testing and Debugging

test_project.ts validates the database and projection at multiple levels:

## 1. DATABASE INTEGRITY
   - All 550 tables loaded, 10,974 rows
   - Every split table's join values match the base table

## 2. STRUCTURAL CORRECTNESS
   - Every child table's FK column exists
   - FK values resolve to the parent (orphan count)
   - Lookup tables resolve references (CLARITY_EDG 13/13, etc.)

## 3. CROSS-REFERENCE INTEGRITY
   - Billing visits → encounters (12/12 resolve)
   - History snapshot CSNs → encounters (5/5, 5/5, 25/25)

## 4. HYDRATION + ACCESSOR TESTS
   - PatientRecord loads from JSON
   - encounter.billingVisit(record) returns correct data
   - order.allResults(record) follows parent→child chain
   - HistoryTimeline.latest() returns most recent snapshot
   - Index lookups (encounterByCSN, orderByID) work

DEBUGGING STRATEGIES:

  "Column not found" errors
    Check if the column exists in the base table vs. a split table.
    Check if you're querying the right table (IP_DATA_STORE doesn't
    have PAT_ENC_CSN_ID — you need PAT_ENC_HSP as a bridge).

  Zero results for a known-populated table
    The PAT_ID filter may be wrong. Check if the table has PAT_ID
    directly or needs a bridge table (PAT_ALLERGIES, ACCT_GUAR_PAT_INFO).

  Orphaned child rows
    Some orphans are expected: PROB_UPDATES has 46/50 orphans because
    PROBLEM_LIST only has active problems while PROB_UPDATES includes
    edits to deleted problems (they're in PROBLEM_LIST_ALL).
    ORDER_RESULTS on child orders won't match ORDER_PROC directly
    because the child order is on a different encounter.

  Split table join mismatches
    The split_config.json may have the wrong join column. Run:
      SELECT s.{join_col} FROM {split} s LIMIT 5
      SELECT b.{base_pk} FROM {base} b LIMIT 5
    If values don't match, find the column that does match.
    NOTE_ENC_INFO_2 was originally mapped to NOTE_CSN_ID (wrong) —
    the correct join is on NOTE_ID.

  "All my billing data is empty"
    Billing tables don't have PAT_ID. They link through:
    ARPB_TRANSACTIONS → ACCOUNT_ID → ACCT_GUAR_PAT_INFO.PAT_ID
    ARPB_VISITS → PRIM_ENC_CSN_ID → PAT_ENC.PAT_ID
    HSP_ACCOUNT → HAR_ALL.ACCT_ID where HAR_ALL.PAT_ID

QUALITY CRITERIA:

  ✓ test_project.ts passes: 146+ db tests, 0 failures
  ✓ Hydration test passes: 15+ accessor tests, 0 failures
  ✓ Row counts match: allergies, problems, immunizations, encounters,
    medications, messages, billing transactions all match expected values
  ✓ Cross-references resolve: billing visits → encounters, history → encounters
  ✓ Parent→child chain works: lab results reachable from ordering encounter
  ✓ No "SELECT * FROM table" without PAT_ID filtering (unless bridge is absent)
  ✓ New ChildSpecs have a corresponding fkChecks entry in test_project.ts
