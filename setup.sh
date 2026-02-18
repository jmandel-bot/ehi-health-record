#!/usr/bin/env bash
set -euo pipefail

# Epic EHI → HealthRecord: Setup Script
#
# Usage:
#   ./setup.sh                     # Use bundled sample data (git submodule)
#   ./setup.sh /path/to/my-export  # Use your own EHI export
#
# Your EHI export directory should contain:
#   tsv/       — the TSV files from Epic's EHI export
#   schemas/   — the JSON schema files from open.epic.com

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRIPT_DIR"

# ── Determine data source ───────────────────────────────────────────────────

if [[ $# -ge 1 ]]; then
  DATA_DIR="$(cd "$1" && pwd)"
  echo "Using custom EHI data: $DATA_DIR"
else
  DATA_DIR="$SCRIPT_DIR/data/sample"
  echo "Using bundled sample data: $DATA_DIR"

  # Initialize submodule if needed
  if [[ ! -f "$DATA_DIR/tsv/PATIENT.tsv" ]]; then
    echo "Initializing data submodule..."
    git submodule update --init --recursive
  fi
fi

# Verify data directory
if [[ ! -d "$DATA_DIR/tsv" ]]; then
  echo "ERROR: $DATA_DIR/tsv/ not found."
  echo "Your EHI export directory must contain a tsv/ subdirectory."
  exit 1
fi
if [[ ! -d "$DATA_DIR/schemas" ]]; then
  echo "ERROR: $DATA_DIR/schemas/ not found."
  echo "Your EHI export directory must contain a schemas/ subdirectory."
  exit 1
fi

# ── Create symlinks ─────────────────────────────────────────────────────────

ln -sfn "$DATA_DIR/tsv" tsv
ln -sfn "$DATA_DIR/schemas" schemas
echo "Linked tsv/ → $DATA_DIR/tsv/"
echo "Linked schemas/ → $DATA_DIR/schemas/"

# ── Install dependencies ────────────────────────────────────────────────────

if ! command -v bun &>/dev/null; then
  echo "Installing bun..."
  curl -fsSL https://bun.sh/install | bash
  export PATH="$HOME/.bun/bin:$PATH"
fi

bun install

# ── Run pipeline ────────────────────────────────────────────────────────────

echo ""
echo "═══ Loading TSVs into SQLite ═══"
python3 src/load_sqlite.py

echo ""
echo "═══ Projecting patient record ═══"
bun run src/project.ts --db ehi_clean.db --out patient_record.json

echo ""
echo "═══ Running tests ═══"
bun run test/test_project.ts --db ehi_clean.db

echo ""
echo "═══ Generating HealthRecord ═══"
bun run test/test_healthrecord.ts

echo ""
echo "════════════════════════════════════════════════════════════"
echo "Setup complete!"
echo ""
echo "Output files:"
echo "  patient_record.json         — Epic-shaped projection"
echo "  health_record_compact.json  — Clean, Epic-free"
echo "  health_record_full.json     — Clean + _epic escape hatches"
echo ""
echo "Next steps:"
echo "  make test          # Re-run tests"
echo "  make project       # Re-run projection"
echo "  make health-record # Re-generate HealthRecord"
echo "════════════════════════════════════════════════════════════"
