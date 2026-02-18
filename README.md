# Epic EHI → HealthRecord

Transform Epic's Electronic Health Information (EHI) export into a clean,
structured patient health record.

```
TSV (550 files) → SQLite → patient_record.json → health_record.json
     raw             queryable    typed Epic graph     clean, Epic-free
```

## Quick Start

```bash
git clone --recursive https://github.com/jmandel-bot/ehi-health-record.git
cd ehi-health-record
./setup.sh
```

This clones the repo with bundled sample data, installs dependencies,
loads the database, runs the projection, and generates the HealthRecord.

## Use Your Own EHI Data

If you have your own Epic EHI export:

```bash
./setup.sh /path/to/your-ehi-export
```

Your export directory must contain:
- `tsv/` — the TSV files from Epic's EHI export
- `schemas/` — the JSON schema files from open.epic.com

## What You Get

| File | Description |
|------|-------------|
| `patient_record.json` | Full Epic-shaped projection (6.7 MB) |
| `health_record_compact.json` | Clean, Epic-free health record |
| `health_record_full.json` | Clean + `_epic` escape hatches for raw data |

The compact health record uses clinical terms (visit, allergen, diagnosis)
not Epic terms (CSN, PAT_ENC, DX_ID). A developer or LLM can read it
without any Epic knowledge.

## Pipeline

```bash
make load          # TSV → SQLite (ehi_clean.db)
make project       # SQLite → patient_record.json
make test          # Run 241 assertions
make health-record # Generate health_record*.json
make all           # All of the above
```

## Project Structure

```
src/                          Core pipeline
  project.ts                    SQL queries, ChildSpec wiring (Epic tables → JSON)
  PatientRecord.ts              Typed domain model with index maps and accessors
  HealthRecord.ts               Clean projection (Epic terms → human terms)
  load_sqlite.py                TSV + schema → SQLite loader
  split_config.json             How Epic's split tables join together
  strict_row.ts                 Runtime column validation (future)

test/                         Tests
  test_project.ts               150 assertions: DB integrity, FK correctness
  test_healthrecord.ts          91 assertions: round-trip, schema validation

tools/                        Audit & review tooling
  audit.ts                      Uncovered tables report
  audit_columns.ts              Phantom column detection
  generate_review_atoms.ts      Build review units from code graph
  build_atom_prompt.ts          Generate review prompts per atom

docs/                         Documentation
  data-model.md                 Epic EHI structure (the Rosetta Stone)
  mapping-philosophy.md         Design principles
  extending.md                  How to wire a new table
  testing.md                    Test strategy
  field-naming.md               Epic column conventions
  column-safety.md              Zero-mismatch approach

data/sample/                  Bundled sample EHI export (git submodule)
prompts/                      Generated review prompts
```

See [operations.md](operations.md) for the full guide to tasks, workflows,
and the subagent review system.

## Coverage

- **550/550** tables covered (100%)
- **241** test assertions passing
- **63/63** messages with body text (including RTF extraction)
- Multi-patient safe (all queries filter by PAT_ID)

## Prerequisites

- [Bun](https://bun.sh/) (installed automatically by setup.sh)
- Python 3 (for TSV → SQLite loading)

## License

MIT
