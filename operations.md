# Operations Guide

How to use, maintain, and improve the Epic EHI → HealthRecord pipeline.

---

## Orientation

### What this project does

Epic's EHI (Electronic Health Information) export is a flat dump of 550 TSV
files. This project turns that into a structured patient health record:

```
TSV (550 files) → SQLite → patient_record.json → health_record.json
     raw             queryable    typed Epic graph     clean, Epic-free
```

### Repository layout

```
Core pipeline:
  load_sqlite.py          Load TSVs + schemas into SQLite
  project.ts              Project SQLite → patient_record.json (Epic-shaped)
  PatientRecord.ts        Typed domain model over the Epic-shaped JSON
  HealthRecord.ts         Clean projection: Epic terms → human terms

Tests:
  test_project.ts         146 assertions: DB integrity, FK correctness, hydration
  test_healthrecord.ts    Smoke test for HealthRecord projection

Configuration:
  split_config.json       How Epic's split tables (_2, _3, ...) join together
  placement_records.json  Table-to-entity placement decisions

Documentation:
  docs/data-model.md          Epic EHI structure (the Rosetta Stone)
  docs/mapping-philosophy.md  6 design principles
  docs/extending.md           How to wire a new table (mechanical steps)
  docs/testing.md             4-level test strategy
  docs/field-naming.md        Epic column suffix conventions
  docs/column-safety.md       Zero-mismatch guarantee approach
  TODO.md                     Phased roadmap (0-6)
  coverage_analysis.md        Data flow funnel analysis

Semantic review system:
  generate_review_atoms.ts    Build dependency graph → 35 review atoms
  build_atom_prompt.ts        Generate self-contained review prompts
  review_atoms.json           Cached atom definitions
  prompts/                    Generated review prompts (one per atom)

Audit scripts:
  audit.ts                    Uncovered tables with data
  audit_columns.ts            Phantom column detection
  audit_chunk_coverage.ts     Chunk completeness verification
  strict_row.ts               Proxy-based column access validation
  coverage.ts                 Table/column coverage reporting

Data (not committed, created at runtime):
  tsv/                   → symlink to my-health-data-ehi-wip/tsv/
  schemas/               → symlink to my-health-data-ehi-wip/schemas/
  ehi_clean.db             SQLite database built by load_sqlite.py
  patient_record.json      Epic-shaped projection output
  health_record*.json      Clean HealthRecord output
```

### Prerequisites

```bash
# Bun runtime
curl -fsSL https://bun.sh/install | bash

# Data repo (TSVs + Epic schemas)
git clone https://github.com/jmandel/my-health-data-ehi-wip.git

# Symlink into the spike directory
ln -sf /path/to/my-health-data-ehi-wip/tsv tsv
ln -sf /path/to/my-health-data-ehi-wip/schemas schemas
```

---

## Discrete Tasks

Each task is independently executable. They're grouped by purpose, then
composed into workflows below.

### A. Build & Run

#### A1. Load TSVs into SQLite
```bash
python3 load_sqlite.py
```
Reads `tsv/*.tsv` and `schemas/*.json`, creates `ehi_clean.db`.
550 tables, ~11K rows. Takes ~2 seconds.

#### A2. Run the projection
```bash
bun run project.ts --db ehi_clean.db --out patient_record.json
```
Projects SQLite → `patient_record.json` (6.7 MB Epic-shaped JSON).
Prints a summary: table coverage, patient name, entity counts.

#### A3. Run the tests
```bash
bun run test_project.ts --db ehi_clean.db
```
146 assertions across 13 test groups. Every assertion must pass.
Covers: DB integrity, split table merging, FK correctness, cross-references,
history snapshots, flowsheet metadata, lookup table resolution, coverage audit.

#### A4. Generate the HealthRecord
```bash
bun run test_healthrecord.ts
```
Loads `patient_record.json`, applies the clean projection, writes
`health_record_compact.json` (Epic-free) and `health_record_full.json`
(with `_epic` escape hatches). Prints a summary.

### B. Semantic Review

#### B1. Regenerate review atoms
```bash
bun run generate_review_atoms.ts
```
Parses `project.ts`, `PatientRecord.ts`, and `HealthRecord.ts` to build a
dependency graph. Outputs `review_atoms.json` with 35 atoms. Each atom is
the transitive closure from one projection function or inline property.

Runs 4 completeness checks (all must pass):
- Every project.ts function assigned to an atom
- Every HealthRecord.ts function assigned
- Every PatientRecord.ts class assigned
- Every table reference covered

If you add a function to any of the three source files, this script
will fail until you assign it to a chunk definition.

#### B2. Generate review prompts
```bash
# Specific atom
bun run build_atom_prompt.ts --atom projectOrder

# Random selection
bun run build_atom_prompt.ts --n 3 --seed 42

# All atoms
for id in $(bun -e 'import a from "./review_atoms.json"; for (const x of a) console.log(x.id)'); do
  bun run build_atom_prompt.ts --atom "$id"
done
```
Writes `prompts/atom_{id}.md`. Each prompt is self-contained:
methodology (from `docs/`), Epic schema descriptions, sample data
from the DB, projection code, PatientRecord classes, HealthRecord
functions, and review instructions.

#### B3. Run a semantic review (subagent) — Phase 1
Dispatch a subagent using the Phase 1 review prompt (see Subagent Prompts
section below). The subagent reads the atom prompt, inspects schema JSONs,
queries the database, and writes its findings to `reports/review_{ATOM_ID}.md`.

Multiple Phase 1 subagents can run in parallel since they don't modify code.

#### B4. Apply review findings (subagent) — Phase 2
Dispatch a subagent using the Phase 2 apply prompt. The subagent reads
the report from B3, verifies each recommendation against the schema and DB,
applies CRITICAL/HIGH fixes, runs tests, and renames the report to
`reports/review_{ATOM_ID}.processed.md`.

Phase 2 subagents modify source code, so run them sequentially (or in
parallel only if the atoms touch non-overlapping files).

#### B5. Verify applied fixes
After Phase 2 completes:
- Check `reports/` — every `.md` should now be `.processed.md`
- Read the `## Applied` section of each processed report for skipped items
- Re-run `bun run generate_review_atoms.ts` to update atoms
- Re-run `bun run test_project.ts` as a final gate

### C. Extend Coverage

#### C1. Identify unmapped tables
```bash
bun run audit.ts
```
Lists every table with data that isn't referenced by `project.ts`.
Sorted by row count. Shows FK column hints and row counts.

#### C2. Read the Epic schema for a table
```bash
cat schemas/TABLE_NAME.json | python3 -m json.tool
```
Every column has a `name` and `description` from open.epic.com.
The description is the single most important input for deciding how
to wire a table. It tells you what each column means, what it links
to, and often explicitly names the parent table.

#### C3. Examine sample data
```bash
bun -e 'import{Database}from"bun:sqlite";const d=new Database("ehi_clean.db");console.table(d.query("SELECT * FROM TABLE_NAME LIMIT 5").all())'
```
Look at actual values. Do the IDs match a known parent table?
Is the first column a PK or FK? How many non-null columns?

#### C4. Decide the relationship type
Read `docs/data-model.md` section 2. Every table is one of:
- **Structural child** → add a ChildSpec entry
- **Cross-reference** → model separately with accessor methods
- **Provenance stamp** → store as a metadata field

The question to ask: does this table *belong to* its parent, or does
it just *reference* it? Read the Epic schema description — it usually
tells you explicitly.

#### C5. Wire the table
For structural children (the most common case):
1. Add an entry to the appropriate `*Children` array in `project.ts`:
   ```typescript
   { table: "NEW_TABLE", fkCol: "PARENT_FK_COL", key: "descriptive_name" }
   ```
2. Run `bun run test_project.ts` — check for orphan rows
3. Run `bun run generate_review_atoms.ts` — verify completeness still passes

For top-level entities:
1. Add a new function in `project.ts` (e.g., `projectNewEntity`)
2. Call it from the main projection block
3. Optionally add a typed class in `PatientRecord.ts`
4. Optionally add a clean projection in `HealthRecord.ts`

#### C6. Analyze tables in bulk (subagent) — Phase 1
For a batch of related unmapped tables, dispatch a Phase 1 extension
subagent (see Subagent Prompts). It reads schemas and sample data,
decides the relationship type for each table, and writes its analysis
to `reports/extend_{BATCH_ID}.md` without modifying code.

#### C7. Apply extension analysis (subagent) — Phase 2
Dispatch a Phase 2 extension apply subagent. It reads the analysis
report, verifies FK relationships against the DB, applies the ChildSpec
entries or projection functions, runs tests, and renames the report
to `reports/extend_{BATCH_ID}.processed.md`.

### D. Fix Column Errors

#### D1. Detect phantom columns
```bash
bun run audit_columns.ts
```
Finds every `raw.COLUMN_NAME` in PatientRecord.ts and `a.COLUMN_NAME`
in HealthRecord.ts, then checks whether that column exists in the
corresponding database table. Reports mismatches.

#### D2. Detect cross-layer mismatches
A PatientRecord class stores `this.fieldName = raw.EPIC_COLUMN`.
HealthRecord reads `entity.DIFFERENT_COLUMN`. This is silent because
both layers use `Record<string, unknown>`.

Currently detected by the semantic review (B3). Will be caught
automatically once StrictRow (D3) and codegen types are implemented.

#### D3. Enable StrictRow validation
```bash
bun run project.ts --strict --db ehi_clean.db
```
(Not yet implemented — see `strict_row.ts` for the Proxy design.)
Wraps every DB row in a Proxy that throws on access to a nonexistent
column. If the projection completes, zero column mismatches are proven.

### E. Validate Output

#### E1. Inspect the patient record
```bash
# Count entities
bun -e 'const r=await Bun.file("patient_record.json").json();console.log(Object.keys(r).length,"top-level keys");console.log("allergies:",r.allergies?.length,"encounters:",r.encounters?.length)'
```

#### E2. Inspect the health record
```bash
bun -e 'const r=await Bun.file("health_record_compact.json").json();for(const[k,v]of Object.entries(r)){console.log(k,Array.isArray(v)?v.length:typeof v)}'
```

#### E3. Spot-check specific fields
```bash
# Check if a specific field has data
bun -e 'const r=await Bun.file("health_record_full.json").json();console.log(JSON.stringify(r.allergies[0],null,2))'
```

---

## Workflows

These compose the discrete tasks above into end-to-end processes.

### W1. Initial Setup (once)

```
A1 → A2 → A3 → A4
```

Load the database, project, test, generate HealthRecord.
Everything should pass with zero errors.

### W2. Semantic Review Sweep

Goal: find and fix semantic errors in the existing mapping.

```
mkdir -p reports
B1 → B2 (all atoms) → B3 (parallel Phase 1) → B4 (sequential Phase 2) → B5 → repeat
```

1. **B1**: Regenerate atoms (ensures completeness after any code changes)
2. **B2**: Generate prompts for all 35 atoms (or a random subset)
3. **B3**: Dispatch Phase 1 review subagents in parallel.
   Each writes `reports/review_{atom}.md`.
4. **B4**: Dispatch Phase 2 apply subagents (sequentially).
   Each reads `reports/review_{atom}.md`, applies fixes, runs tests,
   writes `## Applied` section, renames to `.processed.md`.
5. **B5**: Verify: all reports processed, tests pass, atoms regenerated.
6. Repeat from B2 with the next batch of atoms.

Progress tracking:
```bash
# What's been reviewed?
ls reports/review_*.processed.md | sed 's/.*review_//;s/.processed.md//'

# What's pending?
ls reports/review_*.md 2>/dev/null | grep -v processed

# What hasn't been reviewed at all?
comm -23 <(bun -e 'import a from "./review_atoms.json";for(const x of a)console.log(x.id)' | sort) \
         <(ls reports/review_*.processed.md 2>/dev/null | sed 's/.*review_//;s/.processed.md//' | sort)
```

### W3. Coverage Extension Sprint

Goal: wire unmapped tables to increase coverage from 67% toward 100%.

```
mkdir -p reports
C1 → group by domain → C6 (parallel Phase 1) → C7 (sequential Phase 2) → A3 → B1
```

1. **C1**: Get the list of unmapped tables with data
2. **Group**: Cluster by FK hints (PAT_ID tables, ORDER_ID tables, CSN tables, etc.)
3. **C6**: Dispatch Phase 1 extension subagents (one per cluster, parallel).
   Each writes `reports/extend_{batch}.md` with analysis.
4. **C7**: Dispatch Phase 2 apply subagents (sequential).
   Each applies ChildSpecs/functions, tests, renames to `.processed.md`.
5. **A3**: Final test gate
6. **B1**: Regenerate atoms — new tables appear in existing or new atoms

Progress tracking:
```bash
# Coverage before/after
bun run project.ts --db ehi_clean.db 2>&1 | grep 'Tables referenced'
```

Phase order from TODO.md:
- Phase 1: PAT_ID tables (28 tables, all mechanical ChildSpec additions)
- Phase 2: Deepen existing entities (45 tables with recognized FKs)
- Phase 3: Claims/benefits (9 tables, ~198 rows)
- Phase 4: CLARITY lookups (16 tables)
- Phase 5: Miscellaneous triage (105 tables, read each schema)

### W4. Column Safety Implementation

Goal: guarantee zero silent column mismatches.

```
D1 → fix phantoms → D3 (implement StrictRow) → A2 with --strict → fix crashes → A3
```

1. **D1**: Find current phantom columns (29 known)
2. Fix each: either correct the column name, or remove the dead reference
3. Implement StrictRow Proxy in `project.ts` (design in `strict_row.ts`)
4. Run `project.ts --strict` — every crash is a real bug
5. Fix until clean, then run full test suite

After this, `--strict` becomes a CI gate. Adding it to the test suite
means every future column access is validated against the actual DB schema.

### W5. HealthRecord Expansion

Goal: promote raw Epic data into clean, Epic-free fields.

```
pick entity → add function to HealthRecord.ts → add output key → A4 → B3
```

1. Choose an entity domain that's projected but not yet in HealthRecord
   (e.g., notes, documents, episodes, referrals, conversations)
2. Add a `projectX()` function to HealthRecord.ts
3. Wire it into `projectHealthRecord()`
4. Run `test_healthrecord.ts` (A4)
5. Review semantics (B3) — the atom will now include the new HR function

### W6. New Dataset Onboarding

Goal: run the pipeline against a different patient's EHI export.

```
replace tsv/ symlink → A1 → A2 → A3 → investigate failures
```

Different exports may have:
- Different tables present/absent (graceful fallback should handle this)
- Different columns with data (column manifests would catch this)
- Different Epic versions (column names may differ)
- Multiple patients (PAT_ID filtering must be correct — see TODO Phase 0.2)

---

## Key Concepts for Agents

### The three source files

| File | Role | What it knows about |
|---|---|---|
| `project.ts` | SQL queries, ChildSpec wiring | Epic tables, columns, FKs |
| `PatientRecord.ts` | Typed domain model, index maps | Epic column names → typed fields |
| `HealthRecord.ts` | Clean projection | PatientRecord fields → human-readable output |

A column access error can occur at any boundary:
- `project.ts` queries a column that doesn't exist → SQL returns null
- `PatientRecord.ts` reads `raw.WRONG_NAME` → undefined, cast to string → null
- `HealthRecord.ts` reads `entity.WRONG_FIELD` → undefined → null in output

### The atom system

Atoms are the unit of semantic review. Each atom is derived from the code:
- **Seed**: one projection function or inline property in `project.ts`
- **Transitive closure**: all ChildSpec arrays, utility functions, and
  tables reachable from the seed
- **PR classes**: PatientRecord classes that hydrate from this atom's tables
- **HR functions**: HealthRecord functions that consume this atom's entities

Atoms are generated, not hand-curated. The completeness check guarantees
every function, class, and table appears in at least one atom. Adding code
without updating the atom definitions causes a build failure.

### Schema files are ground truth

The `schemas/*.json` files come from open.epic.com's EHI documentation.
Each file has:
```json
{
  "name": "TABLE_NAME",
  "description": "What this table contains...",
  "columns": [
    { "name": "COL_NAME", "description": "What this column means..." }
  ]
}
```

These descriptions are the authoritative source for what a column means.
When a semantic review finds a discrepancy between the code's assumption
and the schema description, the schema wins.

Subagents reviewing mappings should be told where to find these files
so they can verify column semantics against the official descriptions.

### ChildSpec is the extension mechanism

Most of the 550 tables are structural children of ~15 parent entities.
Wiring a new child table is one line:
```typescript
{ table: "NEW_TABLE", fkCol: "PARENT_FK", key: "descriptive_name" }
```

The `attachChildren()` function does the rest: queries the child table,
attaches results to the parent row, and handles missing tables gracefully.
This is why coverage extension is mechanical for most tables.

---

## Subagent Prompts

The review/apply cycle uses two phases, each with a file-based handoff.
Reports go to `reports/`. The orchestrator dispatches Phase 1 subagents
in parallel, waits for completion, then dispatches Phase 2 subagents
to apply the findings.

```
reports/
  review_{ATOM_ID}.md            ← Phase 1 output (findings)
  review_{ATOM_ID}.processed.md  ← Phase 2 renames after applying fixes
  extend_{BATCH_ID}.md           ← Phase 1 output (coverage extension)
  extend_{BATCH_ID}.processed.md ← Phase 2 renames after wiring
```

### Phase 1: Review (read-only, parallel)

Semantic review of an existing mapping atom:

```
You're reviewing an Epic EHI data mapping for semantic correctness.

Read the review prompt at:
  /home/exedev/spike/spike/prompts/atom_{ATOM_ID}.md

Skip the `### Full Source` section unless you need to trace a
specific function call or cross-reference.

Epic schema files (ground truth for column semantics) are at:
  /home/exedev/spike/spike/schemas/{TABLE_NAME}.json

The SQLite database is at:
  /home/exedev/spike/spike/ehi_clean.db
You can query it to verify sample data or check column existence.

Write your report to:
  /home/exedev/spike/spike/reports/review_{ATOM_ID}.md

The report must have this structure:

  # Review: {ATOM_ID}
  ## Summary
  (one paragraph: what this atom does, overall assessment)
  ## Findings
  | # | Severity | Location | Column/Field | What's Wrong | Fix |
  |---|----------|----------|--------------|-------------|-----|
  (all findings, sorted by severity: CRITICAL > HIGH > MEDIUM > LOW)
  ## Recommended Changes
  For each finding with severity CRITICAL or HIGH, provide the
  exact code change needed: file, old code, new code.
```

Coverage extension (identify how to wire unmapped tables):

```
Read the methodology at:
  /home/exedev/spike/spike/docs/extending.md
  /home/exedev/spike/spike/docs/data-model.md

These tables need wiring: {TABLE_LIST}

Epic schemas: /home/exedev/spike/spike/schemas/
SQLite DB: /home/exedev/spike/spike/ehi_clean.db
Project source: /home/exedev/spike/spike/project.ts

For each table:
1. Read the schema JSON
2. Query sample data from ehi_clean.db
3. Decide: structural child, cross-reference, or provenance stamp
4. Specify the exact ChildSpec entry or projection function to add

Do NOT modify any source files. Write your report to:
  /home/exedev/spike/spike/reports/extend_{BATCH_ID}.md

The report must have this structure:

  # Coverage Extension: {BATCH_ID}
  ## Tables
  For each table:
  ### {TABLE_NAME} ({N} rows)
  - **Relationship type**: structural child / cross-reference / provenance stamp
  - **Parent**: {PARENT_TABLE} via {FK_COL}
  - **Rationale**: (why, citing schema description)
  - **Change**: (exact ChildSpec entry or function to add, with file and location)
```

### Phase 2: Apply (sequential, modifies code)

Apply findings from a semantic review report:

```
Read the review report at:
  /home/exedev/spike/spike/reports/review_{ATOM_ID}.md

For context, the review prompt that generated this report is at:
  /home/exedev/spike/spike/prompts/atom_{ATOM_ID}.md

Epic schema files (ground truth) are at:
  /home/exedev/spike/spike/schemas/{TABLE_NAME}.json

The SQLite database is at:
  /home/exedev/spike/spike/ehi_clean.db

For every finding with severity CRITICAL or HIGH:
1. Read the recommended change in the report
2. Verify it against the Epic schema description and sample data
3. If the fix is correct, apply it to the source file
4. If the fix is wrong or incomplete, apply a corrected version
5. After each change, run: bun run test_project.ts --db ehi_clean.db
6. If tests fail, investigate and fix before continuing

For MEDIUM and LOW findings, apply if straightforward; skip if
ambiguous and note why.

When done:
1. Run the full test suite one final time
2. Append a `## Applied` section to the report with:
   - Which findings were applied (with commit hashes)
   - Which were skipped (with rationale)
   - Test results (pass count, any new failures)
3. Rename the report:
   mv reports/review_{ATOM_ID}.md reports/review_{ATOM_ID}.processed.md
4. Commit all changes with message:
   "Apply review findings for {ATOM_ID}: N fixes applied, M skipped"
```

Apply findings from a coverage extension report:

```
Read the coverage extension report at:
  /home/exedev/spike/spike/reports/extend_{BATCH_ID}.md

The methodology is at:
  /home/exedev/spike/spike/docs/extending.md

Epic schema files: /home/exedev/spike/spike/schemas/
SQLite DB: /home/exedev/spike/spike/ehi_clean.db
Project source: /home/exedev/spike/spike/project.ts

For each table in the report:
1. Read the recommended change
2. Verify the FK relationship by querying the DB:
   - Do the FK values in the child table match PK values in the parent?
   - What's the orphan rate?
3. If correct, apply the ChildSpec entry or projection function
4. Run: bun run test_project.ts --db ehi_clean.db
5. If tests fail, investigate and fix

After all tables are wired:
1. Run: bun run generate_review_atoms.ts
   (must still pass completeness checks)
2. Run the full test suite
3. Append a `## Applied` section to the report with:
   - Which tables were wired (with the exact ChildSpec or function added)
   - Which were skipped (with rationale)
   - New table coverage count
   - Test results
4. Rename the report:
   mv reports/extend_{BATCH_ID}.md reports/extend_{BATCH_ID}.processed.md
5. Commit with message:
   "Wire {N} tables from extend_{BATCH_ID}: coverage now X/550"
```

### Orchestration Pattern

The orchestrating agent (or human) runs this loop:

```
mkdir -p reports

# Phase 1: dispatch N review subagents in parallel
for atom in {selected atoms}:
  subagent("review-{atom}", phase_1_review_prompt(atom))

# Wait for all Phase 1 to complete
# Check: ls reports/review_*.md

# Phase 2: dispatch apply subagents (can be parallel if atoms
# touch different files, but sequential is safer)
for report in reports/review_*.md (not .processed.md):
  subagent("apply-{atom}", phase_2_apply_prompt(atom))

# Check: ls reports/review_*.processed.md
# All processed = cycle complete

# Regenerate atoms for next cycle
bun run generate_review_atoms.ts
bun run build_atom_prompt.ts --n {next batch}
```

For coverage extension, same pattern:
```
# Phase 1: dispatch extension analysis subagents
subagent("extend-pat-id", phase_1_extend_prompt("pat_id", PAT_ID_TABLES))
subagent("extend-order", phase_1_extend_prompt("order", ORDER_TABLES))

# Phase 2: apply
for report in reports/extend_*.md:
  subagent("apply-extend", phase_2_extend_apply_prompt(batch_id))
```
