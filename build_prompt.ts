/**
 * Build a self-contained review prompt for a given chunk.
 * Includes the full methodology preamble from project.ts so the reviewer
 * understands relationship types, CSN semantics, and mapping philosophy.
 */
import { readFileSync } from "fs";

const chunks = await Bun.file("review_chunks.json").json();

// Extract the methodology preamble (Parts 1-5) from project.ts
const projectFullSrc = readFileSync("project.ts", "utf-8");
const preambleMatch = projectFullSrc.match(/\/\*\*[\s\S]*?\*\//);
const methodology = preambleMatch ? preambleMatch[0] : '';

function buildPrompt(chunk: any): string {
  return `You are reviewing an Epic EHI data mapping for semantic correctness. Before analyzing the specific mapping below, read the full data model documentation and mapping philosophy — it is essential context for understanding relationship types, CSN semantics, and structural decisions.

## Data Model & Mapping Philosophy

The following is extracted from the projector's documentation. It defines the three relationship types (structural child, cross-reference, provenance stamp), explains CSN semantics, the order parent→child chain, billing as a parallel hierarchy, and the mapping philosophy. **Use this to evaluate whether structural decisions in the code below are correct.**

<methodology>
${methodology}
</methodology>

## Your Task

Analyze the mapping pipeline for **${chunk.title}** and identify every semantic error — places where a column is read successfully but the value means something different than the code assumes.

You are looking for these specific error types:
1. **Wrong column for the concept** — the code reads a column that exists but contains a different kind of data than intended (e.g., reading a category code integer instead of a display name string)
2. **Conflated columns** — the code falls back from one column to another using ??, but they have different meanings
3. **Structural misclassification** — data is nested/grouped incorrectly (e.g., a patient-level record nested under encounters)
4. **Cross-layer pipeline mismatch** — the projection stores a value under one property name, but the downstream consumer reads a different property name
5. **Missing data that exists** — a column with real data in the sample that the code never reads, causing a null where it could have a value
6. **Wrong interpretation** — dates parsed as strings, IDs treated as names, category codes treated as display values
7. **Aggregation errors** — queries without ORDER BY feeding into .latest() or similar, nondeterministic tie-breaking

For each issue found, report:
- **Severity**: CRITICAL (output is wrong), MODERATE (output is incomplete), LOW (cosmetic or edge case)
- **Location**: which file and which line/field
- **What happens**: the concrete wrong behavior
- **Fix**: the specific code change needed

## Epic Schema Descriptions

These are Epic's official descriptions for each column. They are the ground truth for what a column means.

${Object.entries(chunk.schemaDescriptions).map(([table, descs]: [string, any]) => {
  const entries = Object.entries(descs);
  if (entries.length === 0) return `### ${table}\n(no schema available)`;
  return `### ${table}\n${entries.map(([col, desc]) => col === '_TABLE_' ? `**Table**: ${desc}` : `- **${col}**: ${desc}`).join('\n')}`;
}).join('\n\n')}

## Sample Data (one representative non-null value per column)

${Object.entries(chunk.sampleData).map(([table, data]: [string, any]) => {
  const entries = Object.entries(data);
  if (entries.length === 0) return `### ${table}\n(empty)`;
  return `### ${table}\n${entries.map(([col, val]) => `- ${col} = \`${val}\``).join('\n')}`;
}).join('\n\n')}

## Pipeline Code

### Stage 1: SQL Projection (project.ts → raw JSON)
\`\`\`typescript
${chunk.projectionCode}
\`\`\`

### Stage 2: Domain Model Hydration (PatientRecord.ts)
\`\`\`typescript
${chunk.patientRecordCode}
\`\`\`

### Stage 3: Clean Projection (HealthRecord.ts → final output)
\`\`\`typescript
${chunk.healthRecordCode}
\`\`\`

## Actual Output (from health_record_full.json)

\`\`\`json
${JSON.stringify(chunk.healthRecordOutput, null, 2)?.slice(0, 3000)}
\`\`\`

## Instructions

1. Read the Data Model & Mapping Philosophy section first. Understand the three relationship types (structural child, cross-reference, provenance stamp), what CSN columns mean on different tables, and the parallel clinical/billing hierarchy.
2. Read every column's Epic schema description carefully. The schema description is the ground truth for what a column means — column names are often misleading (e.g., SEVERITY_C_NAME is actually the allergy TYPE).
3. Trace each column from the SQL query through PatientRecord hydration to HealthRecord output.
4. For each field in the output, verify: is the source column correct for what this field claims to represent?
5. For each column in the sample data that has a value, verify: is it read by the code? If not, should it be?
6. Check property name continuity across the three stages — does stage 3 read the property that stage 2 wrote?
7. Evaluate structural decisions: is each table correctly classified as structural child, cross-reference, or provenance stamp? Are CSN columns interpreted correctly per the methodology?
8. Check for nondeterminism in queries (missing ORDER BY) and aggregations (tie-breaking).
9. Verify unit/type interpretations: are _C columns (raw category codes) distinguished from _C_NAME columns (display strings)? Are _YN flags correctly interpreted?

Report your findings as a structured list of issues. If you find zero issues, say so explicitly.`;
}

// Build all prompts and write them
for (const chunk of chunks) {
  const prompt = buildPrompt(chunk);
  await Bun.write(`prompts/prompt_${chunk.id}.md`, prompt);
}

// Also output a summary
console.log(`Generated ${chunks.length} prompts in prompts/`);
for (const chunk of chunks) {
  const prompt = buildPrompt(chunk);
  console.log(`  prompt_${chunk.id}.md: ${Math.round(prompt.length / 1024)}KB, ${chunk.tables.length} tables`);
}
