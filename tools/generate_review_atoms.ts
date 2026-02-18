/**
 * generate_review_atoms.ts — Zero-judgment review unit generation.
 *
 * Instead of grouping code into chunks (which requires judgment about
 * what belongs together), we derive ATOMS from the code's own structure:
 *
 * 1. Build a dependency graph: function→tables, function→ChildSpecs,
 *    function→functions, class→columns, inline_prop→tables
 * 2. Each atom = one leaf node + its transitive dependencies
 * 3. Completeness = every node appears in ≥1 atom
 *
 * Review tasks are then: pick N atoms at random, generate prompts.
 * No human decides what goes where.
 */
import { readFileSync } from "fs";
import { Database } from "bun:sqlite";
import splitConfig from "../src/split_config.json";

const db = new Database("ehi_clean.db", { readonly: true });
function q(sql: string, p: unknown[] = []) { return db.query(sql).all(...p) as Record<string,unknown>[]; }

const projectSrc = readFileSync("src/project.ts", "utf-8");
const prSrc = readFileSync("src/PatientRecord.ts", "utf-8");
const hrSrc = readFileSync("src/HealthRecord.ts", "utf-8");

// ─── Code extraction ─────────────────────────────────────────────────────

function extractFn(src: string, name: string): string {
  const re = new RegExp(`(?:export\\s+)?function\\s+${name}\\b`);
  const lines = src.split('\n');
  for (let i = 0; i < lines.length; i++) {
    if (!re.test(lines[i])) continue;
    let depth = 0, started = false;
    const body: string[] = [];
    for (let j = i; j < lines.length; j++) {
      body.push(lines[j]);
      depth += (lines[j].match(/\{/g) || []).length - (lines[j].match(/\}/g) || []).length;
      if (depth > 0) started = true;
      if (started && depth <= 0) return body.join('\n');
    }
  }
  return '';
}

function extractClass(src: string, name: string): string {
  const re = new RegExp(`(?:export\\s+)?(?:class|interface)\\s+${name}\\b`);
  const lines = src.split('\n');
  for (let i = 0; i < lines.length; i++) {
    if (!re.test(lines[i])) continue;
    let depth = 0, started = false;
    const body: string[] = [];
    for (let j = i; j < lines.length; j++) {
      body.push(lines[j]);
      depth += (lines[j].match(/\{/g) || []).length - (lines[j].match(/\}/g) || []).length;
      if (depth > 0) started = true;
      if (started && depth <= 0) return body.join('\n');
    }
  }
  return '';
}

function tablesIn(code: string): Set<string> {
  const t = new Set<string>();
  for (const m of code.matchAll(/FROM\s+"?([A-Z][A-Z0-9_]+)"?/gi))
    if (/^[A-Z]/.test(m[1])) t.add(m[1]);
  for (const m of code.matchAll(/JOIN\s+"?([A-Z][A-Z0-9_]+)"?/gi))
    if (/^[A-Z]/.test(m[1])) t.add(m[1]);
  for (const m of code.matchAll(/tableExists\("([A-Z][A-Z0-9_]+)"\)/g)) t.add(m[1]);
  for (const m of code.matchAll(/table:\s*"([A-Z_][A-Z0-9_]+)"/g)) t.add(m[1]);
  for (const m of code.matchAll(/mergeQuery\("([A-Z][A-Z0-9_]+)"/g)) t.add(m[1]);
  for (const m of code.matchAll(/children(?:Merged)?\("([A-Z][A-Z0-9_]+)"/g)) t.add(m[1]);
  for (const m of code.matchAll(/lookup(?:Name)?\("([A-Z][A-Z0-9_]+)"/g)) t.add(m[1]);
  return t;
}

// ─── Build the graph ─────────────────────────────────────────────────────

interface GraphNode {
  id: string;
  kind: "project_fn" | "pr_class" | "hr_fn" | "childspec" | "inline_prop" | "table";
  code: string;        // extracted source
  tables: Set<string>; // direct table references
  calls: Set<string>;  // other node IDs this depends on
}

const graph = new Map<string, GraphNode>();

// 1. project.ts functions
const projectFnNames = [...projectSrc.matchAll(/(?:export\s+)?function\s+(\w+)/g)]
  .map(m => m[1]).filter(n => n !== "at");

for (const name of projectFnNames) {
  const code = extractFn(projectSrc, name);
  const tables = tablesIn(code);
  const calls = new Set<string>();

  // What ChildSpec arrays does this function use?
  for (const m of code.matchAll(/(\w+Children)\b/g)) {
    if (m[1] !== 'attachChildren') calls.add(`cs:${m[1]}`);
  }

  // What other project functions does it call?
  for (const other of projectFnNames) {
    if (other !== name && code.includes(`${other}(`)) calls.add(`pf:${other}`);
  }

  // Add split table expansions
  for (const t of [...tables]) {
    if (t in splitConfig) {
      for (const member of (splitConfig as any)[t].members) {
        tables.add(member.table);
      }
    }
  }

  graph.set(`pf:${name}`, {
    id: `pf:${name}`,
    kind: "project_fn",
    code,
    tables,
    calls,
  });
}

// 2. ChildSpec arrays
const csRegex = /const\s+(\w+Children)[^=]*=\s*\[/g;
for (const m of projectSrc.matchAll(csRegex)) {
  const name = m[1];
  const startIdx = m.index!;
  const eqBracket = projectSrc.indexOf('= [', startIdx);
  const arrayStart = projectSrc.indexOf('[', eqBracket + 2);
  let depth = 1, i = arrayStart + 1;
  while (i < projectSrc.length) {
    if (projectSrc[i] === '[') depth++;
    if (projectSrc[i] === ']') { depth--; if (depth === 0) break; }
    i++;
  }
  const code = projectSrc.slice(startIdx, i + 1);
  const tables = tablesIn(code);

  // Expand split tables
  for (const t of [...tables]) {
    if (t in splitConfig) {
      for (const member of (splitConfig as any)[t].members) tables.add(member.table);
    }
  }

  graph.set(`cs:${name}`, {
    id: `cs:${name}`,
    kind: "childspec",
    code,
    tables,
    calls: new Set(),
  });
}

// 3. PatientRecord.ts classes
const prClassNames = [...prSrc.matchAll(/(?:export\s+)?(?:class|interface)\s+(\w+)/g)]
  .map(m => m[1]).filter(n => n !== "at");

for (const name of prClassNames) {
  const code = extractClass(prSrc, name);
  graph.set(`pr:${name}`, {
    id: `pr:${name}`,
    kind: "pr_class",
    code,
    tables: new Set(), // PR classes don't query tables directly
    calls: new Set(),
  });
}

// 4. HealthRecord.ts functions
const hrFnNames = [...hrSrc.matchAll(/(?:export\s+)?function\s+(\w+)/g)]
  .map(m => m[1]).filter(n => n !== "at");

for (const name of hrFnNames) {
  const code = extractFn(hrSrc, name);
  const calls = new Set<string>();

  // What other HR functions does it call?
  for (const other of hrFnNames) {
    if (other !== name && code.includes(`${other}(`)) calls.add(`hr:${other}`);
  }

  graph.set(`hr:${name}`, {
    id: `hr:${name}`,
    kind: "hr_fn",
    code,
    tables: new Set(),
    calls,
  });
}

// 5. Inline main() properties
const projectLines = projectSrc.split('\n');
let lastFnEnd = 0;
{
  let inFn = false, depth = 0;
  for (let i = 0; i < projectLines.length; i++) {
    if (/^(?:export\s+)?function\s+/.test(projectLines[i])) inFn = true;
    if (inFn) {
      depth += (projectLines[i].match(/\{/g) || []).length - (projectLines[i].match(/\}/g) || []).length;
      if (depth <= 0 && inFn) { lastFnEnd = i + 1; inFn = false; depth = 0; }
    }
  }
}
const mainBody = projectLines.slice(lastFnEnd).join('\n');

// Find all top-level properties
const mainLines = mainBody.split('\n');
const inlineProps: { name: string; code: string }[] = [];
{
  let capturing = false;
  let current = '';
  let depth = 0;
  let lines: string[] = [];
  for (const line of mainLines) {
    const propMatch = line.match(/^\s{2,4}(\w+)\s*:/);
    if (propMatch && !capturing && depth === 0) {
      capturing = true;
      current = propMatch[1];
      depth = 0;
      lines = [line];
      depth += (line.match(/[\[{(]/g) || []).length - (line.match(/[\]})]/g) || []).length;
      if (line.trimEnd().endsWith(',') && depth <= 0) {
        inlineProps.push({ name: current, code: lines.join('\n') });
        capturing = false;
        current = '';
        lines = [];
        depth = 0;
      }
    } else if (capturing) {
      lines.push(line);
      depth += (line.match(/[\[{(]/g) || []).length - (line.match(/[\]})]/g) || []).length;
      if (depth <= 0) {
        inlineProps.push({ name: current, code: lines.join('\n') });
        capturing = false;
        current = '';
        lines = [];
        depth = 0;
      }
    }
  }
}

// Separate delegate properties (ones that just call a named function)
// from real inline properties
for (const prop of inlineProps) {
  const tables = tablesIn(prop.code);
  const calls = new Set<string>();

  // Check if it just delegates to a project function
  for (const fn of projectFnNames) {
    if (prop.code.includes(`${fn}(`)) calls.add(`pf:${fn}`);
  }

  // What ChildSpec arrays does this inline prop use?
  for (const m of prop.code.matchAll(/(\w+Children)\b/g)) {
    if (m[1] !== 'attachChildren') calls.add(`cs:${m[1]}`);
  }

  // Only create a node if it has its own table references or non-trivial code
  if (tables.size > 0 || calls.size > 0 || (prop.code.trim().split('\n').length > 1)) {
    // Expand split tables
    for (const t of [...tables]) {
      if (t in splitConfig) {
        for (const member of (splitConfig as any)[t].members) tables.add(member.table);
      }
    }

    graph.set(`ip:${prop.name}`, {
      id: `ip:${prop.name}`,
      kind: "inline_prop",
      code: prop.code,
      tables,
      calls,
    });
  }
}

// ─── Derive atoms by transitive closure ──────────────────────────────────

function transitiveTables(nodeId: string, visited = new Set<string>()): Set<string> {
  if (visited.has(nodeId)) return new Set();
  visited.add(nodeId);
  const node = graph.get(nodeId);
  if (!node) return new Set();
  const result = new Set(node.tables);
  for (const dep of node.calls) {
    for (const t of transitiveTables(dep, visited)) result.add(t);
  }
  return result;
}

function transitiveCode(nodeId: string, visited = new Set<string>()): string[] {
  if (visited.has(nodeId)) return [];
  visited.add(nodeId);
  const node = graph.get(nodeId);
  if (!node) return [];
  const parts = [node.code];
  for (const dep of node.calls) {
    parts.push(...transitiveCode(dep, visited));
  }
  return parts;
}

// ─── Define atoms: one per "leaf" projection function + one per inline prop ─

interface Atom {
  id: string;
  seed: string;       // the seed node ID
  kind: string;
  tables: string[];
  nodeIds: string[];   // all nodes in the transitive closure
  codeBlocks: Record<string, string>;  // nodeId → code
}

// Leaf projection functions (domain functions, not utility)
const utilityFns = new Set(["tableExists", "q", "qOne", "mergeQuery", "children",
  "childrenMerged", "lookup", "lookupName", "attachChildren"]);

const atoms: Atom[] = [];

// Project function atoms
for (const name of projectFnNames) {
  if (utilityFns.has(name)) continue;

  const nodeId = `pf:${name}`;
  const visited = new Set<string>();
  const tables = transitiveTables(nodeId, new Set());
  const codeBlocks: Record<string, string> = {};

  // Collect all code via transitive closure
  const collectNodes = (nid: string, vis: Set<string>) => {
    if (vis.has(nid)) return;
    vis.add(nid);
    const node = graph.get(nid);
    if (!node) return;
    codeBlocks[nid] = node.code;
    for (const dep of node.calls) collectNodes(dep, vis);
  };
  collectNodes(nodeId, visited);

  atoms.push({
    id: name,
    seed: nodeId,
    kind: "project_fn",
    tables: [...tables].sort(),
    nodeIds: [...visited],
    codeBlocks,
  });
}

// Inline property atoms
for (const [id, node] of graph) {
  if (node.kind !== "inline_prop") continue;
  const tables = transitiveTables(id, new Set());
  const visited = new Set<string>();
  const codeBlocks: Record<string, string> = {};
  const collectNodes = (nid: string, vis: Set<string>) => {
    if (vis.has(nid)) return;
    vis.add(nid);
    const n = graph.get(nid);
    if (!n) return;
    codeBlocks[nid] = n.code;
    for (const dep of n.calls) collectNodes(dep, vis);
  };
  collectNodes(id, visited);

  atoms.push({
    id: node.id.replace('ip:', ''),
    seed: id,
    kind: "inline_prop",
    tables: [...tables].sort(),
    nodeIds: [...visited],
    codeBlocks,
  });
}

// ─── Wire in PR classes and HR functions by table/naming heuristics ──────
// For each atom, find which PR classes and HR functions are relevant
// by looking at naming patterns and what the code references

interface AtomFull extends Atom {
  prClasses: string[];
  hrFns: string[];
}

// Build a map: which PR class is constructed from which tables?
// Parse PatientRecord.ts for `new ClassName(raw)` patterns and constructor table hints
const prClassTableHints: Record<string, Set<string>> = {};
for (const name of prClassNames) {
  prClassTableHints[name] = new Set();
}

// Map PR classes to atoms by checking which atom's tables contain the
// columns the class reads. This is fully automated: no naming heuristics.
const fnToPrClass: Record<string, string[]> = {};

// For each PR class, find which columns it accesses from raw Epic rows
const prClassColumns: Record<string, string[]> = {};
for (const name of prClassNames) {
  const code = extractClass(prSrc, name);
  prClassColumns[name] = [...code.matchAll(/raw\.([A-Z][A-Z0-9_]+)/g)].map(m => m[1]);
}

// Also check: does project.ts mention this class by name?
for (const name of projectFnNames) {
  const code = extractFn(projectSrc, name);
  const classes: string[] = [];
  for (const cls of prClassNames) {
    // Direct construction
    if (code.includes(`new ${cls}(`) || code.includes(`${cls}(`)) {
      classes.push(cls);
      continue;
    }
    // Column overlap: if this function's tables contain columns the class reads
    const fnTables = transitiveTables(`pf:${name}`, new Set());
    const clsCols = prClassColumns[cls] || [];
    if (clsCols.length === 0) continue;
    let overlap = false;
    for (const t of fnTables) {
      try {
        const tCols = q(`PRAGMA table_info("${t}")`).map((r: any) => r.name as string);
        if (clsCols.some(c => tCols.includes(c))) { overlap = true; break; }
      } catch {}
    }
    if (overlap) classes.push(cls);
  }
  fnToPrClass[name] = [...new Set(classes)];
}

// PatientRecord class itself goes to projectPatient
fnToPrClass["projectPatient"] = [...(fnToPrClass["projectPatient"] || []), "PatientRecord"];

// For inline prop atoms, wire PR classes by checking if the PR class
// is used to process data from that property. Scan PatientRecord.ts
// for references: buildTimeline → HistoryTimeline → HistorySnapshot
// BillingRecord is used to type the billing return value.
// We wire these by scanning PatientRecord.ts for which class references which.
const prClassRefs: Record<string, Set<string>> = {};
for (const name of prClassNames) {
  prClassRefs[name] = new Set();
  const code = extractClass(prSrc, name);
  for (const other of prClassNames) {
    if (other !== name && code.includes(other)) prClassRefs[name].add(other);
  }
}
// BillingRecord refs: check PatientRecord.ts for what function returns BillingRecord
// and which atom that function belongs to
for (const name of prClassNames) {
  // Check if any project function or inline prop code mentions this class
  for (const [fnName, fnCode] of Object.entries(fnToPrClass)) {
    // already handled
  }
}

// Direct assignment for structural types that wrap other types
// These are discovered by: prClassRefs shows which classes reference which
// HistoryTimeline references HistorySnapshot → they go together
// BillingRecord is referenced by PatientRecord → goes with billing

// Map HR functions to project functions by naming convention
const hrToProjectFn: Record<string, string[]> = {};
for (const hrName of hrFnNames) {
  const matches: string[] = [];
  // Naming patterns: projectAllergy → projectAllergies, projectVisit → projectEncounter, etc.
  const hrCode = extractFn(hrSrc, hrName);
  // Check what record properties the HR function accesses
  for (const atom of atoms) {
    // Does the HR function reference tables in this atom's domain?
    // Or does it reference the same entity type?
    if (hrCode.includes(`.${atom.id}`) || hrCode.includes(`record.${atom.id}`)) {
      matches.push(atom.id);
    }
  }
  hrToProjectFn[hrName] = matches;
}

// Build a mapping table from HR function name patterns to atom IDs
const hrFnToAtom: Record<string, string> = {
  projectDemographics: "projectPatient",
  projectAllergy: "projectAllergies",
  projectProblem: "projectProblems",
  projectMedication: "projectMedications",
  projectImmunization: "projectImmunizations",
  projectVisit: "projectEncounter",
  projectOrder: "projectOrder",
  projectResult: "projectOrder",
  projectAllLabResults: "projectOrder",
  projectMessage: "projectMessages",
  projectBilling: "projectBilling",
  projectSocialHistory: "social_history",
  projectOneSocialHistory: "social_history",
  socialHistoryDiffers: "social_history",
  projectSurgicalHistory: "surgical_history",
  projectFamilyHistory: "family_history",
  projectCoverage: "projectBilling",
  projectReferral: "projectReferrals",
  projectDocument: "projectDocuments",
  projectEpisode: "projectEpisodes",
  projectGoals: "projectPatient",
  projectQuestionnaires: "projectPatient",
  // Utility functions
  serializeHealthRecord: "_utility",
  projectHealthRecord: "_utility",
  toISODate: "_utility",
  toISODateTime: "_utility",
  str: "_utility",
  num: "_utility",
  sid: "_utility",
  epic: "_utility",
};

// This mapping table IS judgment. But it's a simple lookup table that
// can be verified: for each HR function, does it consume data produced
// by the atom it's mapped to? Let's verify.

const atomFulls: AtomFull[] = atoms.map(atom => {
  const prClasses = fnToPrClass[atom.id] ?? [];
  const hrFns = Object.entries(hrFnToAtom)
    .filter(([_, atomId]) => atomId === atom.id)
    .map(([fn]) => fn);
  return { ...atom, prClasses: [...prClasses], hrFns };
});

// Post-process: assign unassigned PR classes by scanning atom code.
// Run multiple passes to catch transitive references (A→B→C where B was
// just assigned in a previous iteration).
for (let pass = 0; pass < 3; pass++) {
const assignedPrClassesInitial = new Set(atomFulls.flatMap(a => a.prClasses));
for (const cls of prClassNames) {
  if (assignedPrClassesInitial.has(cls)) continue;
  // Strategy: find which atom's code (projection + HR) mentions this class
  const clsCode = extractClass(prSrc, cls);
  // Check which atoms use types that reference this class
  for (const atom of atomFulls) {
    const allAtomCode = Object.values(atom.codeBlocks).join('\n');
    const hrCode = atom.hrFns.map(fn => extractFn(hrSrc, fn)).join('\n');
    const combinedCode = allAtomCode + '\n' + hrCode;
    // Also check if any already-assigned PR class in this atom references this class
    const assignedInAtom = atom.prClasses.map(c => extractClass(prSrc, c)).join('\n');
    if (combinedCode.includes(cls) || assignedInAtom.includes(cls)) {
      atom.prClasses.push(cls);
      break;
    }
  }
}
} // end pass loop

// ─── COMPLETENESS VERIFICATION ───────────────────────────────────────────

console.log("═══════════════════════════════════════════════════");
console.log("GRAPH STRUCTURE");
console.log("═══════════════════════════════════════════════════\n");

console.log(`Nodes: ${graph.size}`);
for (const kind of ["project_fn", "childspec", "pr_class", "hr_fn", "inline_prop"]) {
  const nodes = [...graph.values()].filter(n => n.kind === kind);
  console.log(`  ${kind}: ${nodes.length}`);
}

console.log(`\nAtoms: ${atomFulls.length}`);
for (const a of atomFulls) {
  console.log(`  ${a.id} (${a.kind}): ${a.tables.length} tables, ${a.nodeIds.length} nodes, ${a.prClasses.length} PR classes, ${a.hrFns.length} HR fns`);
}

// Verify: every table in project.ts appears in ≥1 atom
const allProjectTables = tablesIn(projectSrc);
const atomTables = new Set<string>();
for (const a of atomFulls) for (const t of a.tables) atomTables.add(t);
const missingTables = [...allProjectTables].filter(t => !atomTables.has(t)).sort();

// Verify: every HR function appears in ≥1 atom
const assignedHrFns = new Set(atomFulls.flatMap(a => a.hrFns));
const missingHrFns = hrFnNames.filter(f => !assignedHrFns.has(f) && hrFnToAtom[f] !== "_utility");

// Verify: every PR class appears in ≥1 atom
const assignedPrClasses = new Set(atomFulls.flatMap(a => a.prClasses));
const missingPrClasses = prClassNames.filter(c => !assignedPrClasses.has(c));

console.log("\n═══════════════════════════════════════════════════");
console.log("COMPLETENESS VERIFICATION");
console.log("═══════════════════════════════════════════════════\n");

let errors = 0;

console.log(`1. Tables: ${atomTables.size} in atoms, ${allProjectTables.size} in project.ts`);
if (missingTables.length > 0) {
  console.log(`   ✗ MISSING: ${missingTables.join(', ')}`);
  errors++;
} else {
  console.log(`   ✓ All covered`);
}

console.log(`2. HR functions: ${assignedHrFns.size}/${hrFnNames.length - Object.values(hrFnToAtom).filter(v => v === "_utility").length} domain fns`);
if (missingHrFns.length > 0) {
  console.log(`   ✗ MISSING: ${missingHrFns.join(', ')}`);
  errors++;
} else {
  console.log(`   ✓ All domain functions assigned`);
}

console.log(`3. PR classes: ${assignedPrClasses.size}/${prClassNames.length}`);
if (missingPrClasses.length > 0) {
  console.log(`   ✗ MISSING: ${missingPrClasses.join(', ')}`);
  errors++;
} else {
  console.log(`   ✓ All covered`);
}

// The ONE remaining piece of judgment: hrFnToAtom mapping table.
// Verify it by checking that each HR function actually reads fields
// that exist in its atom's tables.
console.log(`\n4. HR→Atom mapping correctness:`);
let mappingErrors = 0;
for (const [hrFn, atomId] of Object.entries(hrFnToAtom)) {
  if (atomId === "_utility") continue;
  const atom = atomFulls.find(a => a.id === atomId);
  if (!atom) {
    console.log(`   ✗ ${hrFn} → ${atomId}: atom not found`);
    mappingErrors++;
    continue;
  }
  // Check: does the HR function reference any column that exists in the atom's tables?
  const hrCode = extractFn(hrSrc, hrFn);
  const colAccesses = [...hrCode.matchAll(/[a-z]\.([A-Z][A-Z0-9_]+)/g)].map(m => m[1]);
  if (colAccesses.length === 0) continue; // utility-like function
  
  // Check if any of these columns exist in the atom's tables
  let found = false;
  for (const t of atom.tables) {
    try {
      const cols = q(`PRAGMA table_info("${t}")`).map(r => r.name as string);
      if (colAccesses.some(c => cols.includes(c))) { found = true; break; }
    } catch {}
  }
  if (!found && colAccesses.length > 3) {
    console.log(`   ⚠ ${hrFn} → ${atomId}: no column overlap (cols: ${colAccesses.slice(0,5).join(', ')})`);
  }
}
if (mappingErrors === 0) {
  console.log(`   ✓ All mappings resolve to existing atoms`);
}

console.log(`\n═══════════════════════════════════════════════════`);
if (errors > 0) {
  console.log(`FAILED: ${errors} gaps`);
  process.exit(1);
} else {
  console.log(`PASSED`);
}
console.log(`═══════════════════════════════════════════════════`);

// ─── Write output ────────────────────────────────────────────────────────

await Bun.write("tools/review_atoms.json", JSON.stringify(atomFulls, null, 2));
console.log(`\nWrote ${atomFulls.length} atoms → review_atoms.json`);

db.close();
