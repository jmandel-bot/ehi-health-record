/**
 * build_atom_prompt.ts — Generate a review prompt from a random atom seed.
 *
 * Usage:
 *   bun run build_atom_prompt.ts                    # random atom
 *   bun run build_atom_prompt.ts --atom projectOrder # specific atom
 *   bun run build_atom_prompt.ts --seed 42           # deterministic random
 *   bun run build_atom_prompt.ts --n 3               # pick 3 random atoms
 *
 * Each prompt is self-contained: methodology + schema + sample data + code + output.
 * The reviewer is told "here's a seed; expand your review to whatever you need."
 */
import { readFileSync } from "fs";
import { Database } from "bun:sqlite";

const db = new Database("ehi_clean.db", { readonly: true });
function q(sql: string) { return db.query(sql).all() as Record<string,unknown>[]; }

const atoms: any[] = JSON.parse(readFileSync("review_atoms.json", "utf-8"));

// Load methodology docs
const docs = [
  "docs/data-model.md",
  "docs/mapping-philosophy.md",
  "docs/field-naming.md",
  "docs/column-safety.md",
].map(f => readFileSync(f, "utf-8")).join("\n\n---\n\n");

// Load source files for the reviewer to reference
const projectSrc = readFileSync("project.ts", "utf-8");
const prSrc = readFileSync("PatientRecord.ts", "utf-8");
const hrSrc = readFileSync("HealthRecord.ts", "utf-8");

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

function schemaDescs(table: string): Record<string, string> {
  try {
    const schema = JSON.parse(readFileSync(`schemas/${table}.json`, 'utf-8'));
    const d: Record<string, string> = {};
    if (schema.description) d['_TABLE_'] = schema.description;
    for (const col of schema.columns ?? []) {
      if (col.description) d[col.name] = col.description;
    }
    return d;
  } catch { return {}; }
}

function nonNullSample(table: string): Record<string, string> {
  try {
    const cols = q(`PRAGMA table_info("${table}")`).map(r => r.name as string);
    const result: Record<string, string> = {};
    for (const col of cols) {
      const val = q(`SELECT "${col}" FROM "${table}" WHERE "${col}" IS NOT NULL AND "${col}" != '' LIMIT 1`);
      if (val.length > 0) result[col] = String(val[0][col]).slice(0, 100);
    }
    return result;
  } catch { return {}; }
}

function buildPrompt(atom: any): string {
  let prompt = `You are reviewing a semantic mapping from Epic EHI database tables to a clean patient health record.

## Seed

Your review starts from **${atom.id}** (${atom.kind}), which touches ${atom.tables.length} tables.
You should focus your review on this atom's code, but you may follow references
to other functions, classes, or tables if needed to evaluate correctness. The full
source files are provided below.

## Data Model & Mapping Philosophy

Read this FIRST. It defines the three relationship types, CSN semantics, and mapping principles.

<methodology>
${docs}
</methodology>

## Atom: ${atom.id}

### Tables (${atom.tables.length})

`;

  // Add schema descriptions and sample data for each table
  for (const table of atom.tables) {
    const descs = schemaDescs(table);
    const sample = nonNullSample(table);
    let rowCount = 0;
    try { rowCount = (q(`SELECT COUNT(*) as c FROM "${table}"`)[0].c as number); } catch {}

    prompt += `#### ${table} (${rowCount} rows)\n\n`;
    if (descs['_TABLE_']) prompt += `> ${descs['_TABLE_']}\n\n`;
    if (Object.keys(descs).length > 1 || Object.keys(sample).length > 0) {
      prompt += `| Column | Schema Description | Sample Value |\n|---|---|---|\n`;
      const allCols = new Set([...Object.keys(descs), ...Object.keys(sample)]);
      allCols.delete('_TABLE_');
      for (const col of allCols) {
        const desc = (descs[col] || '').slice(0, 120).replace(/\|/g, '\\|');
        const val = (sample[col] || '').replace(/\|/g, '\\|');
        prompt += `| ${col} | ${desc} | ${val} |\n`;
      }
      prompt += '\n';
    }
  }

  // Add projection code
  prompt += `### Projection Code (project.ts)\n\n\`\`\`typescript\n`;
  for (const [nodeId, code] of Object.entries(atom.codeBlocks as Record<string, string>)) {
    prompt += `// ── ${nodeId} ──\n${code}\n\n`;
  }
  prompt += `\`\`\`\n\n`;

  // Add PR classes
  if (atom.prClasses.length > 0) {
    prompt += `### PatientRecord Classes\n\n\`\`\`typescript\n`;
    for (const cls of atom.prClasses) {
      prompt += extractClass(prSrc, cls) + '\n\n';
    }
    prompt += `\`\`\`\n\n`;
  }

  // Add HR functions
  if (atom.hrFns.length > 0) {
    prompt += `### HealthRecord Functions\n\n\`\`\`typescript\n`;
    for (const fn of atom.hrFns) {
      prompt += extractFn(hrSrc, fn) + '\n\n';
    }
    prompt += `\`\`\`\n\n`;
  }

  // Full source files for context
  prompt += `### Full Source (for following references)\n\n`;
  prompt += `<details><summary>project.ts</summary>\n\n\`\`\`typescript\n${projectSrc}\n\`\`\`\n</details>\n\n`;
  prompt += `<details><summary>PatientRecord.ts</summary>\n\n\`\`\`typescript\n${prSrc}\n\`\`\`\n</details>\n\n`;
  prompt += `<details><summary>HealthRecord.ts</summary>\n\n\`\`\`typescript\n${hrSrc}\n\`\`\`\n</details>\n\n`;

  prompt += `## Instructions

1. Read the methodology section FIRST.
2. Review the seed atom's code: projection SQL, PatientRecord hydration, HealthRecord output.
3. For each column access, verify against the schema description and sample data.
4. Follow references to other functions/classes as needed.
5. Report findings as:

| # | Severity | Location | Column/Field | What's Wrong | Fix |
|---|---|---|---|---|---|

Severity levels: CRITICAL (wrong data in output), MODERATE (data loss or misinterpretation), LOW (style, missing ORDER BY, etc.)

Focus on:
- Column name typos (accessing a column that doesn't exist → silent null)
- Semantic mismatches (column exists but means something different than assumed)
- Structural errors (entity nested wrong, CSN interpreted as ownership vs provenance)
- Cross-layer pipeline breaks (PatientRecord stores a value, HealthRecord reads a different field name)
- Missing columns with data (schema has it, sample shows data, but code ignores it)
- Nondeterminism (missing ORDER BY, tie-breaking)
`;

  return prompt;
}

// ─── CLI ─────────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
let selectedAtoms: any[];

if (args.includes('--atom')) {
  const name = args[args.indexOf('--atom') + 1];
  const atom = atoms.find(a => a.id === name);
  if (!atom) {
    console.error(`Atom "${name}" not found. Available: ${atoms.map((a: any) => a.id).join(', ')}`);
    process.exit(1);
  }
  selectedAtoms = [atom];
} else {
  // Random selection
  const n = args.includes('--n') ? parseInt(args[args.indexOf('--n') + 1]) : 1;
  const seed = args.includes('--seed') ? parseInt(args[args.indexOf('--seed') + 1]) : Date.now();

  // Simple seeded random
  let rng = seed;
  function random() {
    rng = (rng * 1664525 + 1013904223) & 0x7fffffff;
    return rng / 0x7fffffff;
  }

  // Shuffle and pick n
  const shuffled = [...atoms].sort(() => random() - 0.5);
  selectedAtoms = shuffled.slice(0, n);

  console.log(`Seed: ${seed}, picking ${n} of ${atoms.length} atoms`);
}

const { mkdirSync } = await import("fs");
mkdirSync("prompts", { recursive: true });

for (const atom of selectedAtoms) {
  const prompt = buildPrompt(atom);
  const path = `prompts/atom_${atom.id}.md`;
  await Bun.write(path, prompt);
  console.log(`  ${path}: ${Math.round(prompt.length / 1024)}KB, ${atom.tables.length} tables`);
}

db.close();
