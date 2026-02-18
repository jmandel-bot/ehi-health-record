#!/usr/bin/env python3
"""
load_sqlite.py - Load raw Epic EHI export into SQLite.

Sources:
  tsv/          One TSV file per Epic table (550 files, including PATIENT_2.tsv etc.)
  schemas/      One JSON schema per Epic table (from open.epic.com EHI docs)

Output:
  ehi_clean.db  One sqlite table per TSV. No merging, no heuristic FKs.
                Column descriptions + table descriptions embedded as SQL comments.

Every TSV becomes its own table. PATIENT_2 stays PATIENT_2. 
"""

import sqlite3
import csv
import json
import os
import sys

TSV_DIR = 'tsv'
SCHEMA_DIR = 'schemas'
DB_PATH = 'ehi_clean.db'

csv.field_size_limit(50 * 1024 * 1024)

TYPE_MAP = {
    'VARCHAR': 'TEXT',
    'NUMERIC': 'NUMERIC',
    'INTEGER': 'INTEGER',
    'FLOAT': 'REAL',
    'DATETIME': 'TEXT',
    'DATETIME (Local)': 'TEXT',
    'DATETIME (UTC)': 'TEXT',
    'DATETIME (Attached)': 'TEXT',
}


def esc(text):
    if not text:
        return ''
    return text.replace('--', '—').replace('\n', ' ').replace('\r', '')


def load_schema(name):
    path = os.path.join(SCHEMA_DIR, f'{name}.json')
    if not os.path.exists(path) or os.path.getsize(path) == 0:
        return None
    with open(path) as f:
        return json.load(f)


def create_table(conn, name, schema):
    desc = esc(schema.get('description', ''))
    pk_cols = [p['columnName'] for p in schema.get('primaryKey', [])]
    columns = schema.get('columns', [])

    col_defs = []
    col_names = []
    for i, col in enumerate(columns):
        cname = col['name']
        ctype = TYPE_MAP.get(col.get('type', '').strip(), 'TEXT')
        cdesc = esc(col.get('description', ''))
        is_last = (i == len(columns) - 1) and not pk_cols
        comma = '' if is_last else ','
        col_defs.append(f'  "{cname}" {ctype}{comma} -- {cdesc}')
        col_names.append(cname)

    body = '\n'.join(col_defs)
    pk = ''
    if pk_cols:
        pk = ',\n  PRIMARY KEY (' + ', '.join(f'"{c}"' for c in pk_cols) + ')'

    sql = f'CREATE TABLE "{name}" ( -- {desc}\n{body}{pk}\n);'
    conn.executescript(f'DROP TABLE IF EXISTS "{name}";\n{sql}')
    return col_names


def create_table_from_header(conn, name, header):
    col_defs = ', '.join(f'"{h}" TEXT' for h in header)
    conn.execute(f'DROP TABLE IF EXISTS "{name}"')
    conn.execute(f'CREATE TABLE "{name}" ({col_defs})')
    return list(header)


def load_tsv_rows(tsv_path):
    with open(tsv_path, 'r', encoding='utf-8', errors='replace') as f:
        reader = csv.DictReader(f, delimiter='\t')
        header = list(reader.fieldnames or [])
        if header and header[-1].endswith('\r'):
            header[-1] = header[-1].rstrip('\r')
        rows = []
        for row in reader:
            cleaned = {}
            for k, v in row.items():
                key = k.rstrip('\r') if k else k
                val = v.rstrip('\r') if v else v
                cleaned[key] = val
            rows.append(cleaned)
        return header, rows


def coerce(value, col_type):
    if value is None or value.strip() == '':
        return None
    value = value.strip()
    if col_type == 'INTEGER':
        try:
            return int(value)
        except (ValueError, OverflowError):
            try:
                return int(float(value))
            except:
                return value
    elif col_type in ('NUMERIC', 'REAL'):
        try:
            f = float(value)
            if f == int(f) and '.' not in value:
                return int(f)
            return f
        except (ValueError, OverflowError):
            return value
    return value


def main():
    if os.path.exists(DB_PATH):
        os.remove(DB_PATH)

    conn = sqlite3.connect(DB_PATH)
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA synchronous=OFF")

    tsv_files = sorted(f for f in os.listdir(TSV_DIR) if f.endswith('.tsv'))
    print(f"TSV files to load: {len(tsv_files)}")

    tables_ok = 0
    total_rows = 0
    errors = []

    for tsv_file in tsv_files:
        name = tsv_file.replace('.tsv', '')
        tsv_path = os.path.join(TSV_DIR, tsv_file)
        schema = load_schema(name)

        header, rows = load_tsv_rows(tsv_path)
        if not header:
            errors.append(f"{name}: empty TSV")
            continue

        col_types = {}
        if schema:
            for col in schema.get('columns', []):
                col_types[col['name']] = TYPE_MAP.get(col.get('type', '').strip(), 'TEXT')

        try:
            if schema:
                schema_cols = create_table(conn, name, schema)
            else:
                schema_cols = create_table_from_header(conn, name, header)
        except Exception as e:
            errors.append(f"{name}: CREATE failed: {e}")
            continue

        if not rows:
            tables_ok += 1
            continue

        placeholders = ', '.join(['?'] * len(schema_cols))
        col_list = ', '.join(f'"{c}"' for c in schema_cols)
        insert_sql = f'INSERT OR REPLACE INTO "{name}" ({col_list}) VALUES ({placeholders})'

        batch = []
        for row in rows:
            values = []
            for col in schema_cols:
                raw = row.get(col, '')
                ctype = col_types.get(col, 'TEXT')
                values.append(coerce(raw, ctype))
            batch.append(values)

        try:
            conn.executemany(insert_sql, batch)
            total_rows += len(batch)
            tables_ok += 1
        except Exception as e:
            inserted = 0
            for i, values in enumerate(batch):
                try:
                    conn.execute(insert_sql, values)
                    inserted += 1
                except Exception as e2:
                    if inserted == 0 and i == 0:
                        errors.append(f"{name}: INSERT row 0: {e2}")
            total_rows += inserted
            if inserted > 0:
                tables_ok += 1

    conn.commit()

    final_tables = conn.execute(
        "SELECT name FROM sqlite_master WHERE type='table'"
    ).fetchall()

    print(f"\nTables created: {len(final_tables)}")
    print(f"Tables OK: {tables_ok}")
    print(f"Total rows: {total_rows}")

    print(f"\n=== Spot checks ===")
    checks = [
        ('HNO_INFO', 'PAT_ENC_CSN_ID'),
        ('ARPB_VISITS', 'PRIM_ENC_CSN_ID'),
        ('ARPB_TRANSACTIONS', 'AMOUNT'),
        ('PATIENT', 'PAT_NAME'),
        ('ALLERGY', 'ALLERGEN_ID'),
        ('ORDER_RESULTS', 'ORD_VALUE'),
        ('PATIENT_2', 'PAT_ID'),
    ]
    for table, col in checks:
        try:
            total = conn.execute(f'SELECT COUNT(*) FROM "{table}"').fetchone()[0]
            nonnull = conn.execute(
                f'SELECT COUNT(*) FROM "{table}" WHERE "{col}" IS NOT NULL AND "{col}" != ""'
            ).fetchone()[0]
            sample = conn.execute(
                f'SELECT "{col}" FROM "{table}" WHERE "{col}" IS NOT NULL AND "{col}" != "" LIMIT 1'
            ).fetchone()
            sv = str(sample[0])[:50] if sample else 'N/A'
            print(f"  {table}.{col}: {nonnull}/{total} non-null (sample: {sv})")
        except Exception as e:
            print(f"  {table}.{col}: ERROR - {e}")

    if errors:
        print(f"\nErrors ({len(errors)}):")
        for e in errors[:15]:
            print(f"  {e}")
        if len(errors) > 15:
            print(f"  ... and {len(errors)-15} more")

    db_size = os.path.getsize(DB_PATH)
    print(f"\nDatabase: {DB_PATH} ({db_size/1024:.0f} KB)")
    conn.close()


if __name__ == '__main__':
    main()
