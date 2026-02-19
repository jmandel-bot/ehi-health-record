#!/usr/bin/env bun
/**
 * load_sqlite.ts - Load raw Epic EHI export into SQLite.
 *
 * Sources:
 *   tsv/          One TSV file per Epic table (550 files, including PATIENT_2.tsv etc.)
 *   schemas/      One JSON schema per Epic table (from open.epic.com EHI docs)
 *
 * Output:
 *   ehi_clean.db  One sqlite table per TSV. No merging, no heuristic FKs.
 *                 Column descriptions + table descriptions embedded as SQL comments.
 *
 * Every TSV becomes its own table. PATIENT_2 stays PATIENT_2.
 */

import { Database } from "bun:sqlite";
import { readdirSync, existsSync, statSync, unlinkSync } from "fs";
import { join } from "path";

const TSV_DIR = "tsv";
const SCHEMA_DIR = "schemas";
const DB_PATH = "ehi_clean.db";

const TYPE_MAP: Record<string, string> = {
  VARCHAR: "TEXT",
  NUMERIC: "NUMERIC",
  INTEGER: "INTEGER",
  FLOAT: "REAL",
  DATETIME: "TEXT",
  "DATETIME (Local)": "TEXT",
  "DATETIME (UTC)": "TEXT",
  "DATETIME (Attached)": "TEXT",
};

interface SchemaColumn {
  name: string;
  type?: string;
  description?: string;
}

interface SchemaPK {
  columnName: string;
}

interface Schema {
  name: string;
  description?: string;
  primaryKey?: SchemaPK[];
  columns?: SchemaColumn[];
}

function esc(text: string | undefined): string {
  if (!text) return "";
  return text.replace(/--/g, "\u2014").replace(/\n/g, " ").replace(/\r/g, "");
}

function loadSchema(name: string): Schema | null {
  const path = join(SCHEMA_DIR, `${name}.json`);
  if (!existsSync(path)) return null;
  const stat = statSync(path);
  if (stat.size === 0) return null;
  const text = require("fs").readFileSync(path, "utf-8");
  return JSON.parse(text) as Schema;
}

function createTable(db: Database, name: string, schema: Schema): string[] {
  const desc = esc(schema.description);
  const pkCols = (schema.primaryKey || []).map((p) => p.columnName);
  const columns = schema.columns || [];

  const colDefs: string[] = [];
  const colNames: string[] = [];

  for (let i = 0; i < columns.length; i++) {
    const col = columns[i];
    const cname = col.name;
    const ctype = TYPE_MAP[(col.type || "").trim()] || "TEXT";
    const cdesc = esc(col.description);
    const isLast = i === columns.length - 1 && pkCols.length === 0;
    const comma = isLast ? "" : ",";
    colDefs.push(`  "${cname}" ${ctype}${comma} -- ${cdesc}`);
    colNames.push(cname);
  }

  const body = colDefs.join("\n");
  let pk = "";
  if (pkCols.length > 0) {
    pk =
      ",\n  PRIMARY KEY (" + pkCols.map((c) => `"${c}"`).join(", ") + ")";
  }

  const sql = `CREATE TABLE "${name}" ( -- ${desc}\n${body}${pk}\n);`;
  db.exec(`DROP TABLE IF EXISTS "${name}";\n${sql}`);
  return colNames;
}

function createTableFromHeader(
  db: Database,
  name: string,
  header: string[]
): string[] {
  const colDefs = header.map((h) => `"${h}" TEXT`).join(", ");
  db.exec(`DROP TABLE IF EXISTS "${name}"`);
  db.exec(`CREATE TABLE "${name}" (${colDefs})`);
  return [...header];
}

function loadTsvRows(
  tsvPath: string
): { header: string[]; rows: Record<string, string>[] } {
  // Read file as buffer and decode with replacement for invalid UTF-8
  const buf = require("fs").readFileSync(tsvPath);
  const decoder = new TextDecoder("utf-8", { fatal: false });
  const text = decoder.decode(buf);

  const lines = text.split("\n");
  if (lines.length === 0 || (lines.length === 1 && lines[0].trim() === "")) {
    return { header: [], rows: [] };
  }

  // Parse header
  const headerLine = lines[0];
  const header = headerLine.split("\t").map((h) => h.replace(/\r$/, ""));

  // Parse data rows
  const rows: Record<string, string>[] = [];
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];
    if (line === "" || line === "\r") continue; // skip empty trailing lines
    const fields = line.split("\t").map((f) => f.replace(/\r$/, ""));
    const row: Record<string, string> = {};
    for (let j = 0; j < header.length; j++) {
      row[header[j]] = fields[j] ?? "";
    }
    rows.push(row);
  }

  return { header, rows };
}

function coerce(
  value: string | undefined,
  colType: string
): string | number | null {
  if (value === undefined || value === null || value.trim() === "") {
    return null;
  }
  const v = value.trim();

  if (colType === "INTEGER") {
    const i = parseInt(v, 10);
    if (!isNaN(i) && isFinite(i) && i.toString() === v) {
      return i;
    }
    // Try int(float(value)) like Python
    const f = parseFloat(v);
    if (!isNaN(f) && isFinite(f)) {
      return Math.trunc(f);
    }
    return v;
  }

  if (colType === "NUMERIC" || colType === "REAL") {
    const f = parseFloat(v);
    if (!isNaN(f) && isFinite(f)) {
      if (f === Math.trunc(f) && !v.includes(".")) {
        return Math.trunc(f);
      }
      return f;
    }
    return v;
  }

  return v;
}

function main() {
  if (existsSync(DB_PATH)) {
    unlinkSync(DB_PATH);
  }

  const db = new Database(DB_PATH);
  db.exec("PRAGMA journal_mode=WAL");
  db.exec("PRAGMA synchronous=OFF");

  const tsvFiles = readdirSync(TSV_DIR)
    .filter((f) => f.endsWith(".tsv"))
    .sort();
  console.log(`TSV files to load: ${tsvFiles.length}`);

  let tablesOk = 0;
  let totalRows = 0;
  const errors: string[] = [];

  for (const tsvFile of tsvFiles) {
    const name = tsvFile.replace(".tsv", "");
    const tsvPath = join(TSV_DIR, tsvFile);
    const schema = loadSchema(name);

    const { header, rows } = loadTsvRows(tsvPath);
    if (header.length === 0) {
      errors.push(`${name}: empty TSV`);
      continue;
    }

    const colTypes: Record<string, string> = {};
    if (schema) {
      for (const col of schema.columns || []) {
        colTypes[col.name] = TYPE_MAP[(col.type || "").trim()] || "TEXT";
      }
    }

    let schemaCols: string[];
    try {
      if (schema) {
        schemaCols = createTable(db, name, schema);
      } else {
        schemaCols = createTableFromHeader(db, name, header);
      }
    } catch (e: any) {
      errors.push(`${name}: CREATE failed: ${e.message || e}`);
      continue;
    }

    if (rows.length === 0) {
      tablesOk++;
      continue;
    }

    const placeholders = schemaCols.map(() => "?").join(", ");
    const colList = schemaCols.map((c) => `"${c}"`).join(", ");
    const insertSql = `INSERT OR REPLACE INTO "${name}" (${colList}) VALUES (${placeholders})`;

    // Build batch of coerced values
    const batch: (string | number | null)[][] = [];
    for (const row of rows) {
      const values: (string | number | null)[] = [];
      for (const col of schemaCols) {
        const raw = row[col] ?? "";
        const ctype = colTypes[col] || "TEXT";
        values.push(coerce(raw, ctype));
      }
      batch.push(values);
    }

    try {
      // Use a transaction with prepared statement for speed
      const stmt = db.prepare(insertSql);
      const insertAll = db.transaction(() => {
        for (const values of batch) {
          stmt.run(...values);
        }
      });
      insertAll();
      totalRows += batch.length;
      tablesOk++;
    } catch (e: any) {
      // Fall back to row-by-row insertion
      let inserted = 0;
      const stmt = db.prepare(insertSql);
      for (let i = 0; i < batch.length; i++) {
        try {
          stmt.run(...batch[i]);
          inserted++;
        } catch (e2: any) {
          if (inserted === 0 && i === 0) {
            errors.push(`${name}: INSERT row 0: ${e2.message || e2}`);
          }
        }
      }
      totalRows += inserted;
      if (inserted > 0) {
        tablesOk++;
      }
    }
  }

  // No explicit commit needed for bun:sqlite (auto-commit after transaction)

  const finalTables = db
    .query("SELECT name FROM sqlite_master WHERE type='table'")
    .all() as { name: string }[];

  console.log(`\nTables created: ${finalTables.length}`);
  console.log(`Tables OK: ${tablesOk}`);
  console.log(`Total rows: ${totalRows}`);

  console.log(`\n=== Spot checks ===`);
  const checks: [string, string][] = [
    ["HNO_INFO", "PAT_ENC_CSN_ID"],
    ["ARPB_VISITS", "PRIM_ENC_CSN_ID"],
    ["ARPB_TRANSACTIONS", "AMOUNT"],
    ["PATIENT", "PAT_NAME"],
    ["ALLERGY", "ALLERGEN_ID"],
    ["ORDER_RESULTS", "ORD_VALUE"],
    ["PATIENT_2", "PAT_ID"],
  ];

  for (const [table, col] of checks) {
    try {
      const total = (
        db.query(`SELECT COUNT(*) as n FROM "${table}"`).get() as { n: number }
      ).n;
      const nonnull = (
        db
          .query(
            `SELECT COUNT(*) as n FROM "${table}" WHERE "${col}" IS NOT NULL AND "${col}" != ""`
          )
          .get() as { n: number }
      ).n;
      const sample = db
        .query(
          `SELECT "${col}" as v FROM "${table}" WHERE "${col}" IS NOT NULL AND "${col}" != "" LIMIT 1`
        )
        .get() as { v: unknown } | null;
      const sv = sample ? String(sample.v).slice(0, 50) : "N/A";
      console.log(
        `  ${table}.${col}: ${nonnull}/${total} non-null (sample: ${sv})`
      );
    } catch (e: any) {
      console.log(`  ${table}.${col}: ERROR - ${e.message || e}`);
    }
  }

  if (errors.length > 0) {
    console.log(`\nErrors (${errors.length}):`);
    for (const e of errors.slice(0, 15)) {
      console.log(`  ${e}`);
    }
    if (errors.length > 15) {
      console.log(`  ... and ${errors.length - 15} more`);
    }
  }

  const dbSize = statSync(DB_PATH).size;
  console.log(`\nDatabase: ${DB_PATH} (${Math.round(dbSize / 1024)} KB)`);
  db.close();
}

main();
