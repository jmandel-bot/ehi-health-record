You are reviewing an Epic EHI data mapping for semantic correctness.

## Your Task

Analyze the mapping pipeline for **Family History: FAMILY_HX_STATUS + FAMILY_HX → HealthRecord.familyHistory** and identify every semantic error — places where a column is read successfully but the value means something different than the code assumes.

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

### FAMILY_HX_STATUS
**Table**: Family status relationship table.  Contains the relationship to the patient and the name of the family member, as well as the source of this information.
- **PAT_ENC_CSN_ID**: The unique contact serial number for this contact. This number is unique across all patient encounters in your system. If you use IntraConnect this is the Unique Contact Identifier (UCI).
- **LINE**: The line number for the information associated with this contact. Multiple pieces of information can be associated with this contact.
- **CONTACT_DATE**: The date of this contact in calendar format.
- **FAM_STAT_REL_C_NAME**: The family status relationship category number for the relationship between the patient and their family member.
- **FAM_STAT_STATUS_C_NAME**: The family status category number for the family member, such as 1 for "alive" and 2 for "deceased".
- **FAM_STAT_DEATH_AGE**: Age of family member at their death.
- **FAM_STAT_COMMENT**: This item contains the free text comments associated with a patient's family member status in medical history.
- **FAM_STAT_NAME**: The name of family member.
- **FAM_STAT_SRC_C_NAME**: The family status source category number for the source of corresponding family status information.
- **HX_LNK_ENC_CSN**: The Contact Serial Number of the encounter in which the history was created/edited. If the history was created/edited outside of the context of an encounter, then this column will be blank.
- **FAM_STAT_DOB_DT**: This is used to calculate the age of a relative. This is either the date of birth (approximate or exact) or part of a range. If it is a range, then this column will be the beginning date and FAM_STAT_DOB_END_DT will store the end date. This range of dates is used to define an age range.
- **FAM_STAT_ID**: The Unique ID for the family member.
- **FAM_STAT_FATHER_ID**: Unique ID for the Father
- **FAM_STAT_MOTHER_ID**: Unique ID for the mother.
- **FAM_STAT_DOB_END_DT**: If an age range is entered for a family member, then the range is stored as two dates. This column holds the end date and FAM_STAT_DOB_DT holds the beginning date.
- **FAM_STAT_TWIN**: This item tracks twin relationships among members of the patient's family.  Two family members who are twins (or three who are triplets, etc.) will have the same value on their lines of this item.  A value of 0 indicates that the family member is a twin of the patient.
- **FAM_STAT_IDENT_TWIN**: This item tracks identical twin relationships among members of the patient's family.  Two family members who are identical twins (or three who are identical triplets, etc.) will have the same value on their lines of this item.  A value of 0 indicates that the family member is an identical twin of the patient.
- **FAM_STAT_COD_C_NAME**: The cause of death of a family member of the patient.
- **FAM_STAT_SEX_C_NAME**: This item stores the sex of a family member of the patient.
- **FAM_STAT_GENDER_IDENTITY_C_NAME**: Gender identity for a family member.
- **FAM_STAT_REL_ID**: This item stores the unique ID of the patient relationship record. The patient relationship record contains information about how the person is related to the patient.
- **FAM_STAT_ADOPT_C_NAME**: Adoption status of a particular family member.
- **FAM_STAT_ADPT_PAR_1**: The ID of a relative's adoptive parent. We allow two adoptive parents. The other adoptive parent ID is stored in I EPT 20359.
- **FAM_STAT_ADPT_PAR_2**: The ID of a relative's adoptive parent. We allow two adoptive parents. The other adoptive parent ID is stored in I EPT 20358.
- **FAM_STAT_PREG_EPISODE_ID**: This item stores a link to the patient's pregnancy information in Obstetric history.
- **FAM_STAT_DELIV_EPISODE_ID**: This item stores a link to the patient's delivery information for Obstetric History.
- **FAM_HX_FERT_STAT_C_NAME**: This field contains the category value representing a patient's relative's fertility status.
- **FAM_HX_FERT_NOTE**: This field is a free text item holding notes pertaining to a particular relative's fertility status.

### FAMILY_HX
**Table**: The FAMILY_HX table contains data recorded in the family history contacts entered in the patient's chart during a clinical system encounter. Note: This table is designed to hold a patient's history over time; however, it is most typically implemented to only extract the latest patient history contact.
- **LINE**: The line number to identify the family history contact within the patient�s record.  NOTE: Each line of history is stored in enterprise reporting as its own record; a given patient may have multiple records (identified by line number) that reflect multiple lines of history.
- **MEDICAL_HX_C_NAME**: The category value associated with the Problem documented in the patient�s family history.
- **MEDICAL_OTHER**: The custom reason for visit or problem entered when the clinical system user chooses "Other" as a family history problem. NOTE: The comment is stored in the same item as MEDICAL_HX_C but is delimited from the response "Other" by the comment character, "[". The EPIC_GET_COMMENT function returns everything after the comment character.
- **COMMENTS**: Free-text comments entered with this problem. This column may be hidden in a public enterprise reporting view.
- **PAT_ENC_CSN_ID**: A unique serial number for this encounter. This number is unique across all patients and encounters in the system.
- **FAM_HX_SRC_C_NAME**: This item contains the source of information for a patient's family medical history.
- **RELATION_C_NAME**: This is the category value associated with the family member who has or had this problem. An example might be sister, brother, or mother.
- **FAM_RELATION_NAME**: This is the first and/or last name of the patient's family member. This column is free-text and is meant to be used together with the RELATION_C category to form a unique key for the family member. If no name is entered this column will display an abbreviation of the family relation type beginning with ##.
- **AGE_OF_ONSET**: This item contains the age of onset of the patient's family member that is documented with a history of a problem.
- **FAM_MED_REL_ID**: This item contains the unique ID of the patient's family member relationship for medical history.
- **FAM_MEDICAL_DX_ID**: The unique ID of the diagnosis associated with the family member condition.
- **AGE_OF_ONSET_END**: When the age of onset for a family member's history of a problem is documented as an age range, this item contains the age at the end of the range.

## Sample Data (one representative non-null value per column)

### FAMILY_HX_STATUS
- PAT_ENC_CSN_ID = `724623985`
- LINE = `1`
- CONTACT_DATE = `9/28/2023 12:00:00 AM`
- FAM_STAT_REL_C_NAME = `Mother`
- FAM_STAT_STATUS_C_NAME = `Alive`
- FAM_STAT_SRC_C_NAME = `Provider`
- HX_LNK_ENC_CSN = `991225117`
- FAM_STAT_ID = `2`
- FAM_STAT_FATHER_ID = `9`
- FAM_STAT_MOTHER_ID = `8`
- FAM_STAT_SEX_C_NAME = `Female`
- FAM_STAT_GENDER_IDENTITY_C_NAME = `Female`

### FAMILY_HX
- LINE = `1`
- MEDICAL_HX_C_NAME = `Ovarian cancer`
- COMMENTS = `s/p thyroidectomy`
- PAT_ENC_CSN_ID = `724623985`
- FAM_HX_SRC_C_NAME = `Provider`
- RELATION_C_NAME = `Mother`
- FAM_MED_REL_ID = `2`

## Pipeline Code

### Stage 1: SQL Projection (project.ts → raw JSON)
```typescript
// In main():
family_history: tableExists("FAMILY_HX_STATUS") ? q(`SELECT * FROM FAMILY_HX_STATUS`) : [],
family_hx: tableExists("FAMILY_HX") ? q(`SELECT * FROM FAMILY_HX`) : [],
```

### Stage 2: Domain Model Hydration (PatientRecord.ts)
```typescript
// family_history → HistoryTimeline via buildTimeline()
// family_hx → stored as _raw.family_hx
```

### Stage 3: Clean Projection (HealthRecord.ts → final output)
```typescript
    familyHistory: projectFamilyHistory(r),
    messages: r.messages.map(projectMessage),
    billing: projectBilling(r),
  };
}

function projectDemographics(r: R): Demographics {
  const p = r.patient;
  return {
    name: p.PAT_NAME?.replace(',', ', ') ?? '',
    firstName: p.PAT_FIRST_NAME ?? '', lastName: p.PAT_LAST_NAME ?? '',
    dateOfBirth: toISODate(p.BIRTH_DATE), sex: str(p.SEX_C_NAME),
    race: [], ethnicity: str(p.ETHNIC_GROUP_C_NAME),
    language: str(p.LANGUAGE_C_NAME), maritalStatus: str(p.MARITAL_STATUS_C_NAME),
    address: (p.CITY || p.STATE_C_NAME || p.ZIP) ? {
      street: str(p.ADD_LINE_1), city: str(p.CITY),
      state: str(p.STATE_C_NAME), zip: str(p.ZIP), country: str(p.COUNTRY_C_NAME),
    } : null,
```

## Actual Output (from health_record_full.json)

```json
[
  {
    "relation": "Mother",
    "status": "Alive",
    "conditions": [
      {
        "name": "Ovarian cancer",
        "_epic": {
          "LINE": 1,
          "MEDICAL_HX_C_NAME": "Ovarian cancer",
          "PAT_ENC_CSN_ID": 991221485,
          "FAM_HX_SRC_C_NAME": "Provider",
          "RELATION_C_NAME": "Mother",
          "FAM_MED_REL_ID": 2
        }
      },
      {
        "name": "Hypertension",
        "_epic": {
          "LINE": 2,
          "MEDICAL_HX_C_NAME": "Hypertension",
          "PAT_ENC_CSN_ID": 991221485,
          "FAM_HX_SRC_C_NAME": "Provider",
          "RELATION_C_NAME": "Mother",
          "FAM_MED_REL_ID": 2
        }
      },
      {
        "name": "Thyroid disease",
        "comment": "s/p thyroidectomy",
        "_epic": {
          "LINE": 3,
          "MEDICAL_HX_C_NAME": "Thyroid disease",
          "COMMENTS": "s/p thyroidectomy",
          "PAT_ENC_CSN_ID": 991221485,
          "FAM_HX_SRC_C_NAME": "Provider",
          "RELATION_C_NAME": "Mother",
          "FAM_MED_REL_ID": 2
        }
      }
    ],
    "_epic": {
      "PAT_ENC_CSN_ID": 1028739468,
      "LINE": 1,
      "CONTACT_DATE": "9/28/2023 12:00:00 AM",
      "FAM_STAT_REL_C_NAME": "Mother",
      "FAM_STAT_STATUS_C_NAME": "Alive",
      "FAM_STAT_SRC_C_NAME": "Provider",
      "HX_LNK_ENC_CSN": 991225117,
      "FAM_STAT_ID": 2,
      "FAM_STAT_FATHER_ID": 9,
      "FAM_STAT_MOTHER_ID": 8,
      "FAM_STAT_SEX_C_NAME": "Female",
      "FAM_STAT_GENDER_IDENTITY_C_NAME": "Female"
    }
  },
  {
    "relation": "Father",
    "status": "Alive",
    "conditions": [
      {
        "name": "Hyperlipidemia",
        "_epic": {
          "LINE": 4,
          "MEDICAL_HX_C_NAME": "Hyperlipidemia",
          "PAT_ENC_CSN_ID": 991221485,
          "FAM_HX_SRC_C_NAME": "Provider",
          "RELATION_C_NAME": "Father",
          "FAM_MED_REL_ID": 6
        }
      }
    ],
    "_epic": {
      "PAT_ENC_CSN_ID": 1028739468,
      "LINE": 2,
      "CONTACT_DATE": "9/28/2023 12:00:00 AM",
      "FAM_STAT_REL_C_NAME": "Father",
      "FAM_STAT_STATUS_C_NAME": "Alive",
      "HX_LNK_ENC_CSN": 991225117,
      "FAM_STAT_ID": 6,
      "FAM_STAT_FATHER_ID": 11,
      "FAM_STAT_MOTHER_ID": 10,
      "FAM_STAT_SEX_C_NAME": "Male",
      "FAM_STAT_GENDER_IDENTITY_C_NAME": "Male"
    }
  },
  {
    "relation": "Brother",
    "status": "Alive",
    "conditions": [
      {
        "name": "Hypertension",
        "_epic": {
          "LINE": 5,
          "MEDICAL_HX_C_NAME": "Hypertension",
          "PAT_ENC_CSN_ID": 991221485,
          "FAM_HX_SRC_C_NAME": "Provider",
          "RELATION_C_NAME": "Brother",
          "FAM_MED_REL_ID": 5
        }
      },
      {
        "name": "Hyperlipidemia",
        "_epic": {
          "LINE": 6,
          "MEDICAL_HX_C_NAME": "Hyperlipidemia",
          "PAT_ENC_CSN_ID": 991221485,
          "FAM_HX_SRC_C_NAME": "Provider",
          "RELATION_C_NAME": "Brother",
          "FAM_MED_REL_ID": 5
        }
      }
    ],
    
```

## Instructions

1. Read every column's Epic schema description carefully.
2. Trace each column from the SQL query through PatientRecord hydration to HealthRecord output.
3. For each field in the output, verify: is the source column correct for what this field claims to represent?
4. For each column in the sample data that has a value, verify: is it read by the code? If not, should it be?
5. Check property name continuity across the three stages — does stage 3 read the property that stage 2 wrote?
6. Check for nondeterminism in queries and aggregations.

Report your findings as a structured list of issues. If you find zero issues, say so explicitly.