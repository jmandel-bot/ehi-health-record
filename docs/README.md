# Epic EHI → HealthRecord Documentation

Architecture and methodology for projecting Epic EHI exports into a clean health record.

| Document | What it covers |
|---|---|
| [data-model.md](data-model.md) | Epic EHI structure: table splitting, 3 relationship types, CSN semantics, order chains, note linking, history snapshots, bridge tables, CLARITY lookups, billing hierarchy |
| [mapping-philosophy.md](mapping-philosophy.md) | 6 design principles: nesting = ownership, FK-holder owns the accessor, `record` as index, EpicRow escape hatch, PAT_ID filtering, graceful fallback |
| [extending.md](extending.md) | Mechanical steps to wire new tables (identify FK → add ChildSpec/top-level → test) |
| [testing.md](testing.md) | 4-level test strategy: DB integrity, structural correctness, cross-references, hydration |
| [field-naming.md](field-naming.md) | Epic column suffix conventions: `_C_NAME`, `_ID_NAME`, `_YN`, `_REAL`, `_CSN_ID`, etc. |
| [column-safety.md](column-safety.md) | Zero-mismatch guarantee: StrictRow proxy, column manifests, codegen types, 6 error classes |

## For AI reviewers

When reviewing a mapping chunk, read **data-model.md**, **mapping-philosophy.md**, and **field-naming.md** first. These provide the conceptual framework for evaluating whether columns are used correctly and entities are structured properly.
