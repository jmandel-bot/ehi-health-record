/**
 * StrictRow: a Proxy wrapper around DB rows that throws on access
 * to any column that doesn't exist in the row.
 *
 * This is the single change that turns silent nulls into loud crashes.
 */

const STRICT_ROW_MARKER = Symbol('StrictRow');

/** Columns that are computed/injected by our code, not from DB */
const SYNTHETIC_COLUMNS = new Set([
  '_dx_name', '_procedure_name', '_visit_provider',
  // child attachment keys (from ChildSpec.key)
  'reactions', 'updates', 'body_systems', 'results', 'diagnoses',
  'comments', 'narrative', 'text', 'metadata', 'encounter_info',
  'actions', 'history', 'procedures', 'notes', 'reasons',
  // ... etc — this set would be populated from ChildSpec keys
]);

/** Known safe access patterns that aren't column reads */
const PASSTHROUGH = new Set([
  'constructor', 'toString', 'valueOf', 'toJSON',
  'then', // Promise check
  Symbol.toPrimitive, Symbol.iterator, Symbol.toStringTag,
  STRICT_ROW_MARKER,
]);

export type StrictEpicRow = Record<string, unknown> & { [STRICT_ROW_MARKER]: true };

export function strictRow(
  raw: Record<string, unknown>,
  tableName: string,
): StrictEpicRow {
  const keys = new Set(Object.keys(raw));

  return new Proxy(raw as StrictEpicRow, {
    get(target, prop, receiver) {
      // Allow symbol access, known safe patterns
      if (typeof prop === 'symbol' || PASSTHROUGH.has(prop)) {
        return Reflect.get(target, prop, receiver);
      }

      // Allow numeric index access (array-like)
      if (!isNaN(Number(prop))) {
        return Reflect.get(target, prop, receiver);
      }

      // Allow synthetic/computed columns
      if (SYNTHETIC_COLUMNS.has(prop as string)) {
        return Reflect.get(target, prop, receiver);
      }

      // THE CHECK: if the column doesn't exist in this row, crash.
      if (!keys.has(prop as string)) {
        throw new Error(
          `Column "${String(prop)}" does not exist in ${tableName}. ` +
          `Available: ${[...keys].sort().join(', ')}`
        );
      }

      return Reflect.get(target, prop, receiver);
    },

    set(target, prop, value) {
      // Allow setting synthetic columns (child attachments etc)
      keys.add(prop as string);
      return Reflect.set(target, prop, value);
    },
  });
}

// ─── Demo ──────────────────────────────────────────────────────────────────

const row = strictRow({
  TOBACCO_USER_C_NAME: "Never",
  ALCOHOL_USE_C_NAME: "Yes",
  ALCOHOL_COMMENT: "about 3-4 drinks per week",
}, "SOCIAL_HX");

// This works:
console.log("correct:", row.TOBACCO_USER_C_NAME);  // "Never"

// This CRASHES:
try {
  console.log("typo:", row.SMOKING_PACKS_PER_DAY);
} catch (e: any) {
  console.log("CAUGHT:", e.message);
}

// You can still set synthetic keys:
row._dx_name = "resolved name";
console.log("synthetic:", row._dx_name);  // "resolved name"

// Object.entries, JSON.stringify still work:
console.log("keys:", Object.keys(row).length);
console.log("json works:", JSON.stringify(row).length > 0);
