You are reviewing an Epic EHI data mapping for semantic correctness.

## Your Task

Analyze the mapping pipeline for **Allergies: ALLERGY → Allergy → HealthRecord.allergies** and identify every semantic error — places where a column is read successfully but the value means something different than the code assumes.

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

### ALLERGY
**Table**: The ALLERGY table contains information about the allergies noted in your patients' clinical system records. You would use this table if you wanted to report on the number of patients who are allergic to sulfa drugs, for example. To determine the allergic reaction, link to the ALLERGY_REACTIONS table.
- **ALLERGY_ID**: The unique ID used to identify the allergy record.
- **ALLERGEN_ID**: The unique ID assigned to the allergen (Agent) record.
- **ALLERGEN_ID_ALLERGEN_NAME**: The name of the allergen record.
- **REACTION**: This column contains the free text reaction comments. The actual reaction category value responses are stored in the ALLERGY_REACTIONS table which is linked via the ALLERGY_ID columns in both tables.
- **DATE_NOTED**: The date the patient made it known that they had experienced an allergic reaction in calendar format.
- **ENTRY_USER_ID**: The unique ID of the clinical system user who entered this allergy into the patient�s record. This ID may be encrypted.  NOTE: If an allergy record is edited/updated, this will show the most recent change user ID.
- **ENTRY_USER_ID_NAME**: The name of the user record. This name may be hidden.
- **SEVERITY_C_NAME**: The allergy type category value, describing the nature or character of the allergy (i.e. systemic, topical, etc.). NOTE: This field refers to the field called "TYPE" in the Allergy module in clinical system.
- **ALLERGY_SEVERITY_C_NAME**: This item stores the severity of an allergy.
- **ALRGY_STATUS_C_NAME**: The status category number for this allergy record. The status can be active or deleted.
- **ALRGY_DLET_RSN_C_NAME**: Stores the reason for deleting an allergy.
- **ALRGY_DLT_CMT**: This item contains the comment about why an allergy was deleted from a patient's chart.
- **CONTRA_EXP_DT**: The date that the contraindication will expire.
- **ALRGY_ENTERED_DTTM**: The date and time the allergy was entered into the patient's record using a calendar format. NOTE: If an allergy record is edited/updated this will show the most recent change.
- **ALLERGY_CERTAINTY_C_NAME**: The certainty that this allergen is a risk to the patient.
- **ALLERGY_SOURCE_C_NAME**: The source of information for an allergy.
- **ALLERGY_PAT_CSN**: The patient contact corresponding to the patient encounter in which this allergy was edited.
- **ALLERGY_NOTED_DATE_ACCURACY_C_NAME**: The noted date accuracy of an allergy determines the accuracy of the noted date specified in DATE_NOTED.  A value of 1-Year indicates that the specific day in the DATE_NOTED column is accurate to the year and not to the specific day. Similarly a value of 2-Month indicates that it is accurate to the month. A value of 3-Exact Date or an empty value indicates that the corresponding value in DATE_NOTED column is accurate to that day.

### ALLERGY_REACTIONS
**Table**: The ALLERGY_REACTIONS table contains the category values of the reactions associated with a given allergy. There may be multiple reactions associated with a single allergy. In this case, there will be multiple records in this table with the same ALLERGY_ID, but with different LINE values.
- **ALLERGY_ID**: The unique ID used to identify the allergy record.
- **LINE**: The line number for the information associated with this record. Multiple pieces of information can be associated with this record.
- **REACTION_C_NAME**: The integer category value corresponding to the type of allergy reaction. To display names and/or abbreviations, link to the associated ZC lookup table.

### PAT_ALLERGIES
**Table**: The allergies that are associated with a patient are stored on this table. This table also provides a link from the Patient (EPT) based tables to the Problem List (LPL) based tables.
- **PAT_ID**: The unique ID of the patient record for this row. This column is frequently used to link to the PATIENT table.
- **LINE**: The line number for the information associated with this record. Multiple pieces of information can be associated with this record.
- **ALLERGY_RECORD_ID**: This column contains the allergies that are associated with the patient. The allergies are stored as unique identifiers so they can be networked to the problem (LPL) master file.

## Sample Data (one representative non-null value per column)

### ALLERGY
- ALLERGY_ID = `30689238`
- ALLERGEN_ID = `48968`
- ALLERGEN_ID_ALLERGEN_NAME = `TREE NUT`
- DATE_NOTED = `8/9/2018 12:00:00 AM`
- ENTRY_USER_ID = `WENTZTC`
- ENTRY_USER_ID_NAME = `IRELAND, TRACY C`
- SEVERITY_C_NAME = `Allergy`
- ALLERGY_SEVERITY_C_NAME = `High`
- ALRGY_STATUS_C_NAME = `Active`
- ALRGY_ENTERED_DTTM = `8/9/2018 9:45:00 AM`
- ALLERGY_PAT_CSN = `829213099`
- ALLERGY_NOTED_DATE_ACCURACY_C_NAME = `Exact Date`

### ALLERGY_REACTIONS
- ALLERGY_ID = `30689238`
- LINE = `1`
- REACTION_C_NAME = `Hives`

### PAT_ALLERGIES
- PAT_ID = `Z7004242`
- LINE = `1`
- ALLERGY_RECORD_ID = `30689231`

## Pipeline Code

### Stage 1: SQL Projection (project.ts → raw JSON)
```typescript
function projectAllergies(patId: unknown): EpicRow[] {
  // ALLERGY has no PAT_ID — linked via PAT_ALLERGIES bridge table
  let rows: EpicRow[];
  if (tableExists("PAT_ALLERGIES") && tableExists("ALLERGY")) {
    rows = q(`
      SELECT a.* FROM ALLERGY a
      JOIN PAT_ALLERGIES pa ON pa.ALLERGY_RECORD_ID = a.ALLERGY_ID
      WHERE pa.PAT_ID = ?
    `, [patId]);
  } else if (tableExists("ALLERGY")) {
    rows = q(`SELECT * FROM ALLERGY`);
  } else {
    return [];
  }
  for (const row of rows) {
    attachChildren(row, row.ALLERGY_ID, allergyChildren);
    row.allergenName = row.ALLERGEN_ID_ALLERGEN_NAME;
  }
  return rows;
}
```

### Stage 2: Domain Model Hydration (PatientRecord.ts)
```typescript
export class Allergy {
  ALLERGY_ID: EpicID;
  allergenName?: string;
  reaction?: string;
  dateNoted?: string;
  severity?: string;
  status?: string;
  certainty?: string;
  source?: string;
  reactions: EpicRow[] = [];
  notedDuringEncounterCSN?: CSN;

  constructor(raw: EpicRow) {
    Object.assign(this, raw);
    this.ALLERGY_ID = raw.ALLERGY_ID as EpicID;
    this.allergenName = raw.ALLERGEN_ID_ALLERGEN_NAME as string;
    this.severity = (raw.ALLERGY_SEVERITY_C_NAME ?? raw.SEVERITY_C_NAME) as string;
    this.status = raw.ALRGY_STATUS_C_NAME as string;
    this.certainty = raw.ALLERGY_CERTAINTY_C_NAME as string;
    this.source = raw.ALLERGY_SOURCE_C_NAME as string;
    this.reaction = raw.REACTION as string;
    this.dateNoted = raw.DATE_NOTED as string;
    this.notedDuringEncounterCSN = raw.ALLERGY_PAT_CSN as CSN;
    this.reactions = (raw.reactions as EpicRow[]) ?? [];
  }

  notedDuringEncounter(record: PatientRecordRef): Encounter | undefined {
    return this.notedDuringEncounterCSN
      ? record.encounterByCSN(this.notedDuringEncounterCSN)
      : undefined;
  }
}
```

### Stage 3: Clean Projection (HealthRecord.ts → final output)
```typescript
function projectAllergy(a: any): Allergy {
  return {
    id: sid(a.ALLERGY_ID),
    allergen: a.allergenName ?? a.ALLERGEN_ID_ALLERGEN_NAME ?? 'Unknown',
    type: str(a.ALLERGY_TYPE_C_NAME),
    reactions: (a.reactions ?? []).map((r: any) => r.REACTION_NAME ?? r.REACTION_C_NAME ?? 'Unknown'),
    severity: str(a.SEVERITY_C_NAME ?? a.ALLERGY_SEVERITY_C_NAME),
    status: str(a.ALRGY_STATUS_C_NAME),
    dateNoted: toISODate(a.DATE_NOTED),
    _epic: epic(a),
  };
}
```

## Actual Output (from health_record_full.json)

```json
[
  {
    "id": "30689238",
    "allergen": "TREE NUT",
    "reactions": [
      "Hives"
    ],
    "severity": "Allergy",
    "status": "Active",
    "dateNoted": "2018-08-09",
    "_epic": {
      "ALLERGY_ID": 30689238,
      "allergenName": "TREE NUT",
      "dateNoted": "8/9/2018 12:00:00 AM",
      "severity": "High",
      "status": "Active",
      "ALLERGEN_ID": 48968,
      "ALLERGEN_ID_ALLERGEN_NAME": "TREE NUT",
      "DATE_NOTED": "8/9/2018 12:00:00 AM",
      "ENTRY_USER_ID": "WENTZTC",
      "ENTRY_USER_ID_NAME": "IRELAND, TRACY C",
      "SEVERITY_C_NAME": "Allergy",
      "ALLERGY_SEVERITY_C_NAME": "High",
      "ALRGY_STATUS_C_NAME": "Active",
      "ALRGY_ENTERED_DTTM": "8/9/2018 9:45:00 AM"
    }
  },
  {
    "id": "30689295",
    "allergen": "SULFA ANTIBIOTICS",
    "reactions": [
      "Hives"
    ],
    "severity": "Allergy",
    "status": "Active",
    "dateNoted": "2018-08-09",
    "_epic": {
      "ALLERGY_ID": 30689295,
      "allergenName": "SULFA ANTIBIOTICS",
      "dateNoted": "8/9/2018 12:00:00 AM",
      "severity": "High",
      "status": "Active",
      "ALLERGEN_ID": 33,
      "ALLERGEN_ID_ALLERGEN_NAME": "SULFA ANTIBIOTICS",
      "DATE_NOTED": "8/9/2018 12:00:00 AM",
      "ENTRY_USER_ID": "WENTZTC",
      "ENTRY_USER_ID_NAME": "IRELAND, TRACY C",
      "SEVERITY_C_NAME": "Allergy",
      "ALLERGY_SEVERITY_C_NAME": "High",
      "ALRGY_STATUS_C_NAME": "Active",
      "ALRGY_ENTERED_DTTM": "8/9/2018 9:45:00 AM"
    }
  },
  {
    "id": "30689317",
    "allergen": "PENICILLINS",
    "reactions": [
      "Hives"
    ],
    "severity": "Allergy",
    "status": "Active",
    "dateNoted": "2018-08-09",
    "_epic": {
      "ALLERGY_ID": 30689317,
      "allergenName": "PENICILLINS",
      "dateNoted": "8/9/2018 12:00:00 AM",
      "severity": "High",
      "status": "Active",
      "ALLERGEN_ID": 25,
      "ALLERGEN_ID_ALLERGEN_NAME": "PENICILLINS",
      "DATE_NOTED": "8/9/2018 12:00:00 AM",
      "ENTRY_USER_ID": "WENTZTC",
      "ENTRY_USER_ID_NAME": "IRELAND, TRACY C",
      "SEVERITY_C_NAME": "Allergy",
      "ALLERGY_SEVERITY_C_NAME": "High",
      "ALRGY_STATUS_C_NAME": "Active",
      "ALRGY_ENTERED_DTTM": "8/9/2018 9:46:00 AM"
    }
  },
  {
    "id": "58599837",
    "allergen": "PEANUT (DIAGNOSTIC)",
    "reactions": [
      "Hives"
    ],
    "severity": "Allergy",
    "status": "Active",
    "dateNoted": "2020-07-14",
    "_epic": {
      "ALLERGY_ID": 58599837,
      "allergenName": "PEANUT (DIAGNOSTIC)",
      "dateNoted": "7/14/2020 12:00:00 AM",
      "severity": "High",
      "status": "Active",
      "notedDuringEncounterCSN": 829213099,
      "ALLERGEN_ID": 49007,
      "ALLERGEN_ID_ALLERGEN_NAME": "PEANUT (DIAGNOSTIC)",
      "DATE_NOTED": "7/14/2020 12:00:00 AM",
      "ENTRY_USER_ID": "PICONEMA",
      "ENTRY_USER_ID_NAME": "PICONE, MARY A",
      "SEVERITY_C_NAME": "Allergy",
      "ALLERGY_SEVERITY_C_NAME": "High",
      "ALRGY_STATUS_C_NAME": "Active",
      "ALRGY_ENTERED_DTTM": "7/14/2020 
```

## Instructions

1. Read every column's Epic schema description carefully.
2. Trace each column from the SQL query through PatientRecord hydration to HealthRecord output.
3. For each field in the output, verify: is the source column correct for what this field claims to represent?
4. For each column in the sample data that has a value, verify: is it read by the code? If not, should it be?
5. Check property name continuity across the three stages — does stage 3 read the property that stage 2 wrote?
6. Check for nondeterminism in queries and aggregations.

Report your findings as a structured list of issues. If you find zero issues, say so explicitly.