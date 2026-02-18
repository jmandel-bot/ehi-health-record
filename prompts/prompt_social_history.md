You are reviewing an Epic EHI data mapping for semantic correctness.

## Your Task

Analyze the mapping pipeline for **Social History: SOCIAL_HX → HistoryTimeline → HealthRecord.socialHistory** and identify every semantic error — places where a column is read successfully but the value means something different than the code assumes.

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

### SOCIAL_HX
**Table**: The SOCIAL_HX table contains social history data for each history encounter stored in your system. This table has one row per history encounter.
- **CONTACT_DATE**: The date of this contact in calendar format.
- **CIGARETTES_YN**: Y if the patient uses cigarettes. N if the patient does not.  NOTE: Uses the EPIC_IN_ITEM function to determine if a given value exists in a multiple response item.  If the category value for this selection exists in the multiple response item, then it returns "Y", otherwise it returns "N".
- **PIPES_YN**: Y if the patient smokes a pipe. N if the patient does not.  NOTE: Uses the EPIC_IN_ITEM function to determine if a given value exists in a multiple response item.  If the category value for this selection exists in the multiple response item, then it returns "Y", otherwise it returns "N".
- **CIGARS_YN**: Y if the patient uses cigars. N if the patient does not. NOTE: Uses the EPIC_IN_ITEM function to determine if a given value exists in a multiple response item.  If the category value for this selection exists in the multiple response item, then it returns "Y", otherwise it returns "N".
- **SNUFF_YN**: Y if the patient uses snuff. N if the patient does not. NOTE: Uses the EPIC_IN_ITEM function to determine if a given value exists in a multiple response item.  If the category value for this selection exists in the multiple response item, then it returns "Y", otherwise it returns "N".
- **CHEW_YN**: Y if the patient uses chewing tobacco. N if the patient does not. NOTE: Uses the EPIC_IN_ITEM function to determine if a given value exists in a multiple response item.  If the category value for this selection exists in the multiple response item, then it returns "Y", otherwise it returns "N".
- **ALCOHOL_OZ_PER_WK**: The fluid ounces of alcohol the patient consumes per week.
- **ALCOHOL_COMMENT**: Free-text comments regarding the patient�s use of alcohol.
- **IV_DRUG_USER_YN**: Y if the patient is an IV drug user. N if the patient is not.  NOTE: Uses the EPIC_IN_ITEM function to determine if a given value exists in a multiple response item.  If the category value for this selection exists in the multiple response item, then it returns "Y", otherwise it returns "N".
- **ILLICIT_DRUG_FREQ**: The times per week the patient uses or used illicit drugs.
- **ILLICIT_DRUG_CMT**: Free-text comments regarding the patient�s use of illicit drugs.
- **FEMALE_PARTNER_YN**: Y if the patient has a female sexual partner. N if the patient does not. NOTE: Uses the EPIC_IN_ITEM function to determine if a given value exists in a multiple response item.  If the category value for this selection exists in the multiple response item, then it returns "Y", otherwise it returns "N".
- **MALE_PARTNER_YN**: Y if the patient has a male sexual partner. N if the patient does not. NOTE: Uses the EPIC_IN_ITEM function to determine if a given value exists in a multiple response item.  If the category value for this selection exists in the multiple response item, then it returns "Y", otherwise it returns "N".
- **CONDOM_YN**: Y if the patient uses a condom during sexual activity. N if the patient does not. NOTE: Uses the EPIC_IN_ITEM function to determine if a given value exists in a multiple response item.  If the category value for this selection exists in the multiple response item, then it returns "Y", otherwise it returns "N".
- **PILL_YN**: Y if the patient uses birth control pills. N if the patient does not. NOTE: Uses the EPIC_IN_ITEM function to determine if a given value exists in a multiple response item.  If the category value for this selection exists in the multiple response item, then it returns "Y", otherwise it returns "N".
- **DIAPHRAGM_YN**: Y if the patient uses a diaphragm. N if the patient does not. NOTE: Uses the EPIC_IN_ITEM function to determine if a given value exists in a multiple response item.  If the category value for this selection exists in the multiple response item, then it returns "Y", otherwise it returns "N".
- **IUD_YN**: Y if the patient uses an IUD. N if the patient does not. NOTE: Uses the EPIC_IN_ITEM function to determine if a given value exists in a multiple response item.  If the category value for this selection exists in the multiple response item, then it returns "Y", otherwise it returns "N".
- **SURGICAL_YN**: Y if the patient uses a surgical method of birth control such as hysterectomy, vasectomy, or tubal-ligation. N if the patient does not. NOTE: Uses the EPIC_IN_ITEM function to determine if a given value exists in a multiple response item.  If the category value for this selection exists in the multiple response item, then it returns "Y", otherwise it returns "N".
- **SPERMICIDE_YN**: Y if the patient uses spermicide. N if the patient does not. NOTE: Uses the EPIC_IN_ITEM function to determine if a given value exists in a multiple response item.  If the category value for this selection exists in the multiple response item, then it returns "Y", otherwise it returns "N".
- **IMPLANT_YN**: Y if the patient uses an implant as a form of birth control. N if the patient does not. NOTE: Uses the EPIC_IN_ITEM function to determine if a given value exists in a multiple response item.  If the category value for this selection exists in the multiple response item, then it returns "Y", otherwise it returns "N".
- **RHYTHM_YN**: Y if the patient uses the rhythm method as a form of birth control. N if the patient does not. NOTE: Uses the EPIC_IN_ITEM function to determine if a given value exists in a multiple response item.  If the category value for this selection exists in the multiple response item, then it returns "Y", otherwise it returns "N".
- **INJECTION_YN**: Y if the patient uses an injection as a form of birth control. N if the patient does not. NOTE: Uses the EPIC_IN_ITEM function to determine if a given value exists in a multiple response item.  If the category value for this selection exists in the multiple response item, then it returns "Y", otherwise it returns "N".
- **SPONGE_YN**: Y if the patient uses a sponge as a form of birth control. N if the patient does not. NOTE: Uses the EPIC_IN_ITEM function to determine if a given value exists in a multiple response item.  If the category value for this selection exists in the multiple response item, then it returns "Y", otherwise it returns "N".
- **INSERTS_YN**: Y if the patient uses inserts as a form of birth control. N if the patient does not. NOTE: Uses the EPIC_IN_ITEM function to determine if a given value exists in a multiple response item.  If the category value for this selection exists in the multiple response item, then it returns "Y", otherwise it returns "N".
- **ABSTINENCE_YN**: Y if the patient practices abstinence. N if the patient does not. NOTE: Uses the EPIC_IN_ITEM function to determine if a given value exists in a multiple response item.  If the category value for this selection exists in the multiple response item, then it returns "Y", otherwise it returns "N".
- **SEX_COMMENT**: Free-text comments regarding the patient�s sexual activity.
- **YEARS_EDUCATION**: The number of years of education the patient has completed. Note: This is a free text field.
- **PAT_ENC_CSN_ID**: A unique serial number for this encounter. This number is unique across all patients and encounters in the system.
- **TOB_SRC_C_NAME**: Source for Tobacco History
- **ALCOHOL_SRC_C_NAME**: This columns stores the person (e.g. provider, patient, legal guardian) who provided alcohol use information for this encounter.
- **DRUG_SRC_C_NAME**: This columns stores the person (e.g. provider, patient, legal guardian) who provided illicit drug use information for this encounter.
- **SEX_SRC_C_NAME**: This columns stores the person (e.g. provider, patient, legal guardian) who provided sexual activity information for this encounter.
- **HX_LNK_ENC_CSN**: The Contact Serial Number of the encounter in which the history was created/edited. If the history was created/edited outside of the context of an encounter, then this column will be blank.
- **ALCOHOL_USE_C_NAME**: The category value associated with the patient's alcohol use. Data may include, Yes, No, or Not Asked.
- **ILL_DRUG_USER_C_NAME**: The category value associated with the patient's use of illicit drugs. Data may include, Yes, No, or Not Asked.
- **SEXUALLY_ACTIVE_C_NAME**: The category value associated with the patient's sexual activity. Data may include Yes, No, Not Asked, or Not Now
- **TOBACCO_USER_C_NAME**: The category value associated with the patient's tobacco use. Data may include, Yes, Never, Not Asked or Quit.
- **SMOKELESS_TOB_USE_C**: Stores the patient's usage of smokeless tobacco.  Data may include, Current User, Former User, Never Used or Unknown.
- **SMOKELESS_QUIT_DATE**: The date on which the patient quit using smokeless tobacco.
- **SMOKING_TOB_USE_C**: Stores the patient's usage of smoking tobacco.  Data may include, Current Everyday Smoker, Current Some Day Smoker, Former Smoker, Never Smoker, Unknown If Ever Smoked or Smoker, Current Status Unknown.
- **UNKNOWN_FAM_HX_YN**: Y if the patient's family history is unknown by the patient. N otherwise.
- **EDU_LEVEL_C_NAME**: This item stores responses to the social determinants of health question about level of education. Response is categorical, and corresponds to highest level of school attended.
- **FIN_RESOURCE_STRAIN_C_NAME**: This item stores responses to the social determinants of health question about financial resource strain.
- **IPV_EMOTIONAL_ABUSE_C_NAME**: This item stores responses to the social determinants of health question about emotional abuse from an intimate partner.
- **IPV_FEAR_C_NAME**: This item stores responses to the social determinants of health question about fear of an intimate partner.
- **IPV_SEXUAL_ABUSE_C_NAME**: This item stores responses to the social determinants of health question about sexual abuse from an intimate partner.
- **IPV_PHYSICAL_ABUSE_C_NAME**: This item stores responses to the social determinants of health question about physical abuse from an intimate partner.
- **ALCOHOL_FREQ_C_NAME**: This item stores responses for the social determinants of health question about frequency of drinking alcohol.
- **ALCOHOL_DRINKS_PER_DAY_C_NAME**: This item stores responses for the social determinants of health questions about number of standard drinks consumed in a typical day.
- **ALCOHOL_BINGE_C_NAME**: This item stores responses for the social determinants of health questions about binge drinking.
- **LIVING_W_SPOUSE_C_NAME**: This item stores the response to social determinants of health question about whether or not the patient is currently living with spouse or partner.
- **DAILY_STRESS_C_NAME**: This item stores responses to the social determinants of health question about daily stress.
- **PHONE_COMMUNICATION_C_NAME**: This item stores responses to the social determinants of health question about how often the patient socializes with friends or family over the phone.
- **SOCIALIZATION_FREQ_C_NAME**: This item stores responses to the social determinants of health question about how often the patient socializes with friends or family in person.
- **CHURCH_ATTENDANCE_C_NAME**: This item stores responses to the social determinants of health question about how often the patient attends religious services.
- **CLUBMTG_ATTENDANCE_C_NAME**: This item stores responses to the social determinants of health question about how often the patient attends club or other organization meetings in a year.
- **CLUB_MEMBER_C_NAME**: This item stores responses to the social determinants of health question about whether the patient is a member of any clubs or organizations.
- **PHYS_ACT_DAYS_PER_WEEK_C_NAME**: This item stores responses to the social determinants of health question about how many days a week the patient exercises.
- **PHYS_ACT_MIN_PER_SESS_C_NAME**: This item stores responses to the social determinants of health question about how many minutes the patient exercises on days that they exercise.
- **FOOD_INSECURITY_SCARCE_C_NAME**: This item stores responses to the social determinants of health question about whether or not the patient had run out of food and was not able to buy more.
- **FOOD_INSECURITY_WORRY_C_NAME**: This item stores responses to the social determinants of health question about whether the patient worried about food running out in the past year or not.
- **MED_TRANSPORT_NEEDS_C_NAME**: This item stores responses to the social determinants of health question about whether the patient had difficulty regarding transportation for medical appointments and medicine.
- **OTHER_TRANSPORT_NEEDS_C_NAME**: This item stores responses to the social determinants of health question about whether the patient had difficulty regarding transportation for things other than medical appointments and medicine.
- **SOC_PHONE_SRC_C_NAME**: Stores the source of entry for a patient's Social Connections Phone history.
- **SOC_TOGETHER_SRC_C_NAME**: Stores the source of entry for a patient's Social Connections Get Together history.
- **SOC_CHURCH_SRC_C_NAME**: Stores the source of entry for a patient's Social Connections Church history.
- **SOC_MEETINGS_SRC_C_NAME**: Stores the source of entry for a patient's Social Connections Meetings history.
- **SOC_MEMBER_SRC_C_NAME**: Stores the source of entry for a patient's Social Connections Membership history.
- **SOC_LIVING_SRC_C_NAME**: Stores the source of entry for a patient's Social Connections Living history.
- **PHYS_DPW_SRC_C_NAME**: Stores the source of entry for a patient's Physical Activity Days per Week history.
- **PHYS_MPS_SRC_C_NAME**: Stores the source of entry for a patient's Physical Activity Minutes Per Session history.
- **STRESS_SRC_C_NAME**: Stores the source of entry for a patient's Stress history.
- **EDUCATION_SRC_C_NAME**: Stores the source of entry for a patient's Education history.
- **FINANCIAL_SRC_C_NAME**: Stores the source of entry for a patient's Financial history.
- **IPV_EMOTIONAL_SRC_C_NAME**: Stores the source of entry for a patient's Intimate Partner Violence (IPV) emotional history.
- **IPV_FEAR_SRC_C_NAME**: Stores the source of entry for a patient's IPV Fear history.
- **IPV_SEXABUSE_SRC_C_NAME**: Stores the source of entry for a patient's IPV Sexual Abuse history.
- **IPV_PHYSABUSE_SRC_C_NAME**: Stores the source of entry for a patient's physical abuse history.
- **ALC_FREQ_SRC_C_NAME**: Stores the source of entry for a patient's Alcohol Frequency history.
- **ALC_STD_DRINK_SRC_C_NAME**: Stores the source of entry for a patient's Alcohol Standard Drinks history.
- **ALC_BINGE_SRC_C_NAME**: Stores the source of entry for a patient's Alcohol Binge history.
- **FOOD_WORRY_SRC_C_NAME**: Stores the source of entry for a patient's Food Worry history.
- **FOOD_SCARCITY_SRC_C_NAME**: Stores the source of entry for a patient's Food Scarcity history.
- **TRANS_MED_SRC_C_NAME**: Stores the source of entry for a patient's Transport Medical history.
- **TRANS_NONMED_SRC_C_NAME**: Stores the source of entry for a patient's Transport Non-medical history.
- **FAM_PAT_ADPT_PAR_1**: Stores the family history ID of the patient's adoptive parent. A patient can have two adoptive parents. The ID of the other parent is in FAM_PAT_ADPT_PAR_2.
- **FAM_PAT_ADPT_PAR_2**: Stores the family history ID of the patient's adoptive parent. A patient can have two adoptive parents. The ID of the other parent is in FAM_PAT_ADPT_PAR_1.
- **TOB_HX_ADDL_PACKYEARS**: Number to add to the total number of pack years calculated for the patient's tobacco history.
- **TOB_HX_SMOKE_EXPOSURE_CMT**: Store the comment for passive tobacco smoke exposure.
- **PASSIVE_SMOKE_EXPOSURE_C_NAME**: Document the patient's passive smoke exposure.
- **FAMHX_PAT_IS_ADOPTED_C_NAME**: The Adoption Status category ID for the patient.

## Sample Data (one representative non-null value per column)

### SOCIAL_HX
- CONTACT_DATE = `9/28/2023 12:00:00 AM`
- CIGARETTES_YN = `N`
- PIPES_YN = `N`
- CIGARS_YN = `N`
- SNUFF_YN = `N`
- CHEW_YN = `N`
- ALCOHOL_COMMENT = `about 3-4 drinks per week`
- IV_DRUG_USER_YN = `N`
- ILLICIT_DRUG_CMT = `occasional cannabis`
- FEMALE_PARTNER_YN = `Y`
- MALE_PARTNER_YN = `N`
- CONDOM_YN = `N`
- PILL_YN = `N`
- DIAPHRAGM_YN = `N`
- IUD_YN = `N`
- SURGICAL_YN = `N`
- SPERMICIDE_YN = `N`
- IMPLANT_YN = `N`
- RHYTHM_YN = `N`
- INJECTION_YN = `N`
- SPONGE_YN = `N`
- INSERTS_YN = `N`
- ABSTINENCE_YN = `N`
- PAT_ENC_CSN_ID = `724623985`
- TOB_SRC_C_NAME = `Provider`
- ALCOHOL_SRC_C_NAME = `Provider`
- DRUG_SRC_C_NAME = `Provider`
- SEX_SRC_C_NAME = `Provider`
- HX_LNK_ENC_CSN = `991225117`
- ALCOHOL_USE_C_NAME = `Yes`
- ILL_DRUG_USER_C_NAME = `No`
- SEXUALLY_ACTIVE_C_NAME = `Yes`
- TOBACCO_USER_C_NAME = `Never`
- SMOKELESS_TOB_USE_C = `3`
- SMOKING_TOB_USE_C = `5`
- UNKNOWN_FAM_HX_YN = `N`

## Pipeline Code

### Stage 1: SQL Projection (project.ts → raw JSON)
```typescript
// In main():
social_history: q(`SELECT * FROM SOCIAL_HX`),
```

### Stage 2: Domain Model Hydration (PatientRecord.ts)
```typescript
export class HistoryTimeline<T> {
  constructor(public readonly snapshots: HistorySnapshot<T>[]) {}

  latest(): T | undefined {
    return this.snapshots.at(-1)?.data;
  }

  /**
   * Get the history snapshot associated with a given encounter CSN.
   * Checks both the history's own contact CSN (snapshotCSN) and
   * the clinical visit CSN it was reviewed during (reviewedDuringEncounterCSN).
   */
  asOfEncounter(csn: CSN): T | undefined {
    return this.snapshots.find(
      s => s.reviewedDuringEncounterCSN === csn || s.snapshotCSN === csn
    )?.data;
  }

  asOfDate(date: string): T | undefined {
    return [...this.snapshots].reverse().find(s => (s.contactDate ?? '') <= date)?.data;
  }

  get length(): number {
    return this.snapshots.length;
  }
}

    this.socialHistory = buildTimeline((json.social_history as EpicRow[]) ?? []);
    this.surgicalHistory = buildTimeline((json.surgical_history as EpicRow[]) ?? []);
    this.familyHistory = buildTimeline((json.family_history as EpicRow[]) ?? []);

    // Preserve raw projection data for the clean HealthRecord projection
    this._raw = {
      family_hx: json.family_hx ?? [],
    };
```

### Stage 3: Clean Projection (HealthRecord.ts → final output)
```typescript
    socialHistory: projectSocialHistory(r),
    surgicalHistory: projectSurgicalHistory(r),
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

  const all: SocialHistory[] = tl.snapshots.map((s: any) => projectOneSocialHistory(s.data));

  // Deduplicate: only keep a snapshot if its content differs from the next-newer one
  const deduped: SocialHistory[] = [all[0]];
  for (let i = 1; i < all.length; i++) {
    if (socialHistoryDiffers(all[i], all[i - 1])) {
      deduped.push(all[i]);
    }
  }
```

## Actual Output (from health_record_full.json)

```json
{
  "current": {
    "tobacco": {
      "status": "Never"
    },
    "alcohol": {
      "status": "Yes",
      "comment": "about 3-4 drinks per week"
    },
    "drugs": {
      "status": "No",
      "comment": "occasional cannabis"
    },
    "sexualActivity": "Yes",
    "asOf": "2023-09-28",
    "_epic": {
      "CONTACT_DATE": "9/28/2023 12:00:00 AM",
      "CIGARETTES_YN": "N",
      "PIPES_YN": "N",
      "CIGARS_YN": "N",
      "SNUFF_YN": "N",
      "CHEW_YN": "N",
      "ALCOHOL_COMMENT": "about 3-4 drinks per week",
      "IV_DRUG_USER_YN": "N",
      "ILLICIT_DRUG_CMT": "occasional cannabis",
      "FEMALE_PARTNER_YN": "Y",
      "MALE_PARTNER_YN": "N",
      "CONDOM_YN": "N",
      "PILL_YN": "N",
      "DIAPHRAGM_YN": "N",
      "IUD_YN": "N",
      "SURGICAL_YN": "N",
      "SPERMICIDE_YN": "N",
      "IMPLANT_YN": "N",
      "RHYTHM_YN": "N",
      "INJECTION_YN": "N",
      "SPONGE_YN": "N",
      "INSERTS_YN": "N",
      "ABSTINENCE_YN": "N",
      "PAT_ENC_CSN_ID": 1028739468,
      "TOB_SRC_C_NAME": "Provider",
      "ALCOHOL_SRC_C_NAME": "Provider",
      "DRUG_SRC_C_NAME": "Provider",
      "SEX_SRC_C_NAME": "Provider",
      "HX_LNK_ENC_CSN": 991225117,
      "ALCOHOL_USE_C_NAME": "Yes",
      "ILL_DRUG_USER_C_NAME": "No",
      "SEXUALLY_ACTIVE_C_NAME": "Yes",
      "TOBACCO_USER_C_NAME": "Never",
      "SMOKELESS_TOB_USE_C": 3,
      "SMOKING_TOB_USE_C": 5,
      "UNKNOWN_FAM_HX_YN": "N"
    }
  },
  "prior": [
    {
      "tobacco": {
        "status": "Never"
      },
      "alcohol": {
        "status": "Yes",
        "comment": "drinks 3-4 days /week"
      },
      "drugs": {
        "status": "No"
      },
      "sexualActivity": "Yes",
      "asOf": "2020-01-09",
      "_epic": {
        "CONTACT_DATE": "1/9/2020 12:00:00 AM",
        "CIGARETTES_YN": "N",
        "PIPES_YN": "N",
        "CIGARS_YN": "N",
        "SNUFF_YN": "N",
        "CHEW_YN": "N",
        "ALCOHOL_COMMENT": "drinks 3-4 days /week",
        "IV_DRUG_USER_YN": "N",
        "FEMALE_PARTNER_YN": "Y",
        "MALE_PARTNER_YN": "N",
        "CONDOM_YN": "N",
        "PILL_YN": "N",
        "DIAPHRAGM_YN": "N",
        "IUD_YN": "N",
        "SURGICAL_YN": "N",
        "SPERMICIDE_YN": "N",
        "IMPLANT_YN": "N",
        "RHYTHM_YN": "N",
        "INJECTION_YN": "N",
        "SPONGE_YN": "N",
        "INSERTS_YN": "N",
        "ABSTINENCE_YN": "N",
        "PAT_ENC_CSN_ID": 802802103,
        "TOB_SRC_C_NAME": "Provider",
        "ALCOHOL_SRC_C_NAME": "Provider",
        "DRUG_SRC_C_NAME": "Provider",
        "SEX_SRC_C_NAME": "Provider",
        "HX_LNK_ENC_CSN": 799951565,
        "ALCOHOL_USE_C_NAME": "Yes",
        "ILL_DRUG_USER_C_NAME": "No",
        "SEXUALLY_ACTIVE_C_NAME": "Yes",
        "TOBACCO_USER_C_NAME": "Never",
        "SMOKELESS_TOB_USE_C": 3,
        "SMOKING_TOB_USE_C": 5,
        "UNKNOWN_FAM_HX_YN": "N"
      }
    }
  ]
}
```

## Instructions

1. Read every column's Epic schema description carefully.
2. Trace each column from the SQL query through PatientRecord hydration to HealthRecord output.
3. For each field in the output, verify: is the source column correct for what this field claims to represent?
4. For each column in the sample data that has a value, verify: is it read by the code? If not, should it be?
5. Check property name continuity across the three stages — does stage 3 read the property that stage 2 wrote?
6. Check for nondeterminism in queries and aggregations.

Report your findings as a structured list of issues. If you find zero issues, say so explicitly.