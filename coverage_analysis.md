# Epic EHI → HealthRecord Coverage Analysis

## Data Flow Funnel

```
Epic Database (550 tables, 9,479 columns, 10,974 rows)
  │
  │  522 data tables, 28 CLARITY lookup tables
  │  3,796 columns have actual data (rest are all-null)
  │
  ▼
Raw Projection — project.ts (366 tables mapped)
  │
  │  98.7% of rows flow through
  │  Column-name matching catches ~3,200 columns
  │
  ▼
Clean Output — HealthRecord.ts
  │
  │  782 Epic columns preserved in _epic fields
  │  128 clean named fields exposed
  │
  ▼
Serialized JSON (70 KB without _epic, 533 KB with _epic)
```

## What's Lost

### Not projected at all (571 columns, 15%)
These columns exist in the database with real data but aren't in any
table that project.ts queries. Mostly in:
- Claim reconciliation tables (RECONCILE_CLM, RECONCILE_CLM_OT)
- Immunization admin details (IMM_ADMIN, IMM_ADMIN_COMPONENTS)
- Coverage/benefit details (COVERAGE_BENEFITS, MED_CVG_*)
- Problem list history (PROBLEM_LIST_HX)

### In projection but not in _epic (1,413 columns)
These columns are queried by project.ts and available in the raw JSON,
but the HealthRecord projection doesn't touch the tables they're on.
They'd be accessible via `_epic` if those tables were wired up.

### In _epic but not clean fields (654 columns)
These columns survive to the output (in `_epic`) but don't have a named
clean field mapping. They're accessible but require Epic knowledge to
interpret. Examples: ORDER_STATUS_C_NAME, REFERRAL_SOURCE_ID,
AUTHRZING_PROV_ID, etc.

### Clean field coverage (128 fields from 782 _epic columns = 16%)
The HealthRecord maps 128 clinical fields from the Epic source. This is
intentionally selective — most Epic columns are administrative metadata,
internal IDs, or system fields that aren't clinically meaningful.


## Per-Section Detail

| Section | Clean Fields | Epic Cols in _epic | Coverage |
|---------|-------------|-------------------|----------|
| demographics | 15 | 66 | 23% |
| allergies | 6 | 17 | 35% |
| problems | 6 | 15 | 40% |
| medications | 11 | 124 | 9% |
| immunizations | 8 | 31 | 26% |
| visits | 28 | 268 | 10% |
| labResults | 11 | 39 | 28% |
| socialHistory | 9 | 36 | 25% |
| surgicalHistory | 1 | 8 | 13% |
| familyHistory | 5 | 17 | 29% |
| messages | 5 | 21 | 24% |
| billing | 21 | 240 | 9% |

