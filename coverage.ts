/**
 * coverage.ts — Analyze data flow from Epic DB → HealthRecord
 *
 * Traces every column in the Epic database through the three-layer pipeline:
 *   1. Epic DB → Raw Projection (project.ts)
 *   2. Raw Projection → PatientRecord (PatientRecord.ts)
 *   3. PatientRecord → Clean HealthRecord (HealthRecord.ts)
 *
 * For each column, reports whether it:
 *   - Has data in the source DB
 *   - Makes it into the raw projection
 *   - Appears in _epic on the clean output
 *   - Has a named clean field mapping
 *
 * Usage:
 *   bun run spike/coverage.ts --db ehi_clean.db --projection test_output.json
 *
 * Outputs:
 *   - Console summary (data flow funnel)
 *   - coverage_report.json (per-table, per-column detail)
 */

import { Database } from 'bun:sqlite';
import { loadPatientRecord } from './PatientRecord';
import { projectHealthRecord, serializeHealthRecord } from './HealthRecord';
import { parseArgs } from 'util';

const { values } = parseArgs({
  args: Bun.argv.slice(2),
  options: {
    db: { type: 'string', default: 'ehi_clean.db' },
    projection: { type: 'string', default: 'test_output.json' },
    out: { type: 'string', default: 'spike/coverage_report.json' },
  },
});

const db = new Database(values.db!, { readonly: true });
const projJson = JSON.parse(await Bun.file(values.projection!).text());
const raw = loadPatientRecord(projJson);
const hr = projectHealthRecord(raw);
const full = JSON.parse(serializeHealthRecord(hr, { includeEpic: true }));

// ─── Step 1: Catalog the Epic database ─────────────────────────────────────

interface DBColumn {
  table: string;
  column: string;
  hasData: boolean;
  nonNullCount: number;
}

const dbColumns: DBColumn[] = [];
const tableRows = new Map<string, number>();

for (const { name } of db.query("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all() as any[]) {
  const rows = (db.query(`SELECT COUNT(*) as c FROM "${name}"`).get() as any).c;
  tableRows.set(name, rows);
  for (const { name: col } of db.query(`PRAGMA table_info("${name}")`).all() as any[]) {
    let nonNullCount = 0;
    if (rows > 0) {
      nonNullCount = (db.query(`SELECT COUNT(*) as c FROM "${name}" WHERE "${col}" IS NOT NULL AND "${col}" != ""`).get() as any).c;
    }
    dbColumns.push({ table: name, column: col, hasData: nonNullCount > 0, nonNullCount });
  }
}

// ─── Step 2: What's in the raw projection? ──────────────────────────────────

const inProjection = new Set<string>();
function collectProjKeys(obj: any) {
  if (Array.isArray(obj)) { obj.forEach(collectProjKeys); return; }
  if (obj && typeof obj === 'object') {
    Object.keys(obj).forEach(k => inProjection.add(k));
    Object.values(obj).forEach(collectProjKeys);
  }
}
collectProjKeys(projJson);

// ─── Step 3: What's in the clean output _epic fields? ───────────────────────

const inEpic = new Set<string>();
const epicBySection = new Map<string, Set<string>>();

function collectEpic(obj: any, section: string) {
  if (Array.isArray(obj)) { obj.forEach(x => collectEpic(x, section)); return; }
  if (!obj || typeof obj !== 'object') return;
  if (obj._epic) {
    Object.keys(obj._epic).forEach(k => {
      inEpic.add(k);
      if (!epicBySection.has(section)) epicBySection.set(section, new Set());
      epicBySection.get(section)!.add(k);
    });
  }
  for (const [k, v] of Object.entries(obj)) {
    if (k === '_epic' || k.startsWith('_')) continue;
    if (Array.isArray(v) && v.length > 0 && typeof v[0] === 'object') {
      collectEpic(v, section ? `${section}.${k}` : k);
    }
  }
}

for (const [k, v] of Object.entries(full)) {
  if (k.startsWith('_')) continue;
  collectEpic(v, k);
}

// ─── Step 4: Count clean fields per section ─────────────────────────────────

const cleanBySection = new Map<string, Set<string>>();

function collectClean(obj: any, section: string) {
  if (Array.isArray(obj)) { obj.forEach(x => collectClean(x, section)); return; }
  if (!obj || typeof obj !== 'object') return;
  for (const [k, v] of Object.entries(obj)) {
    if (k.startsWith('_')) continue;
    if (!cleanBySection.has(section)) cleanBySection.set(section, new Set());
    cleanBySection.get(section)!.add(k);
    if (Array.isArray(v) && v.length > 0 && typeof v[0] === 'object') {
      collectClean(v, `${section}.${k}`);
    }
  }
}

const cleanOnly = JSON.parse(serializeHealthRecord(hr));
for (const [k, v] of Object.entries(cleanOnly)) {
  if (k.startsWith('_')) continue;
  collectClean(v, k);
}

// ─── Step 5: Classify every column ──────────────────────────────────────────

type Status = 'clean_mapped' | 'in_epic' | 'in_projection' | 'not_projected' | 'no_data';

interface ColumnReport {
  table: string;
  column: string;
  rows: number;
  nonNullCount: number;
  status: Status;
}

const columnReports: ColumnReport[] = [];
const statusCounts: Record<Status, number> = {
  clean_mapped: 0, in_epic: 0, in_projection: 0, not_projected: 0, no_data: 0,
};

for (const col of dbColumns) {
  let status: Status;
  if (!col.hasData) {
    status = 'no_data';
  } else if (inEpic.has(col.column)) {
    status = 'in_epic'; // TODO: distinguish clean_mapped vs in_epic_only
  } else if (inProjection.has(col.column)) {
    status = 'in_projection';
  } else {
    status = 'not_projected';
  }
  statusCounts[status]++;
  columnReports.push({
    table: col.table, column: col.column,
    rows: tableRows.get(col.table) ?? 0,
    nonNullCount: col.nonNullCount, status,
  });
}

// ─── Step 6: Build table-level summaries ────────────────────────────────────

interface TableSummary {
  table: string;
  rows: number;
  isClarity: boolean;
  totalCols: number;
  withData: number;
  inEpic: number;
  inProjection: number;
  notProjected: number;
  noData: number;
  lostColumns: string[];  // columns with data that aren't projected
}

const tableSummaries: TableSummary[] = [];
const tableGroups = new Map<string, ColumnReport[]>();
for (const cr of columnReports) {
  if (!tableGroups.has(cr.table)) tableGroups.set(cr.table, []);
  tableGroups.get(cr.table)!.push(cr);
}

for (const [table, cols] of tableGroups) {
  tableSummaries.push({
    table,
    rows: tableRows.get(table) ?? 0,
    isClarity: table.startsWith('CLARITY_'),
    totalCols: cols.length,
    withData: cols.filter(c => c.status !== 'no_data').length,
    inEpic: cols.filter(c => c.status === 'in_epic').length,
    inProjection: cols.filter(c => c.status === 'in_projection').length,
    notProjected: cols.filter(c => c.status === 'not_projected').length,
    noData: cols.filter(c => c.status === 'no_data').length,
    lostColumns: cols.filter(c => c.status === 'not_projected').map(c => c.column),
  });
}

// ─── Output ─────────────────────────────────────────────────────────────────

// Console summary
const dataTables = tableSummaries.filter(t => !t.isClarity && t.rows > 0);
const totalWithData = dataTables.reduce((s, t) => s + t.withData, 0);
const totalInEpic = dataTables.reduce((s, t) => s + t.inEpic, 0);
const totalInProj = dataTables.reduce((s, t) => s + t.inProjection, 0);
const totalLost = dataTables.reduce((s, t) => s + t.notProjected, 0);

console.log('=== Epic EHI → HealthRecord Coverage ===\n');
console.log('Epic Database');
console.log(`  Tables: ${tableSummaries.length} (${dataTables.length} data, ${tableSummaries.length - dataTables.length} CLARITY/empty)`);
console.log(`  Columns: ${dbColumns.length} total, ${dbColumns.filter(c => c.hasData).length} with data`);
console.log();
console.log('Data Flow Funnel (columns with data in non-CLARITY tables):');
console.log(`  Total with data:       ${totalWithData}`);
console.log(`  → In clean _epic:      ${totalInEpic} (${pct(totalInEpic, totalWithData)})`);
console.log(`  → In projection only:  ${totalInProj} (${pct(totalInProj, totalWithData)})`);
console.log(`  → Not projected:       ${totalLost} (${pct(totalLost, totalWithData)})`);
console.log();

// Per-section coverage
console.log('Per-Section Coverage:');
console.log('Section'.padEnd(30) + 'Epic _epic'.padStart(10) + 'Clean'.padStart(8) + 'Ratio'.padStart(8));
console.log('-'.repeat(56));
const sections = [...epicBySection.entries()].sort((a, b) => a[0].localeCompare(b[0]));
for (const [sec, cols] of sections) {
  const cleanCount = cleanBySection.get(sec)?.size ?? 0;
  console.log(sec.padEnd(30) + String(cols.size).padStart(10) + String(cleanCount).padStart(8) + pct(cleanCount, cols.size).padStart(8));
}
console.log();

// Tables with most data loss
console.log('Tables with most columns lost (not projected):');
dataTables.sort((a, b) => b.notProjected - a.notProjected);
for (const t of dataTables.filter(t => t.notProjected > 0).slice(0, 20)) {
  console.log(`  ${t.table}: ${t.notProjected}/${t.withData} lost`);
  if (t.lostColumns.length <= 5) {
    console.log(`    ${t.lostColumns.join(', ')}`);
  }
}

// Write JSON report
const report = {
  generated: new Date().toISOString(),
  summary: {
    totalTables: tableSummaries.length,
    dataTables: dataTables.length,
    totalColumns: dbColumns.length,
    columnsWithData: totalWithData,
    inEpic: totalInEpic,
    inProjectionOnly: totalInProj,
    notProjected: totalLost,
  },
  perSection: sections.map(([sec, cols]) => ({
    section: sec,
    epicColumns: cols.size,
    cleanFields: cleanBySection.get(sec)?.size ?? 0,
  })),
  tables: tableSummaries.sort((a, b) => b.notProjected - a.notProjected),
  columns: columnReports,
};

await Bun.write(values.out!, JSON.stringify(report, null, 2));
console.log(`\nReport written to ${values.out}`);

function pct(n: number, total: number): string {
  return total > 0 ? `${Math.round(100 * n / total)}%` : '-';
}
