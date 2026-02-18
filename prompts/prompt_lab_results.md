You are reviewing an Epic EHI data mapping for semantic correctness.

## Your Task

Analyze the mapping pipeline for **Lab Results: ORDER_PROC → ORDER_RESULTS → ORDER_PARENT_INFO chain → HealthRecord.labResults** and identify every semantic error — places where a column is read successfully but the value means something different than the code assumes.

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

### ORDER_PROC
**Table**: The ORDER_PROC table enables you to report on the procedures ordered in the clinical system. We have also included patient and contact identification information for each record.
- **ORDER_PROC_ID**: The unique ID of the order record associated with this procedure order.
- **PAT_ID**: The unique ID of the patient record for this order. This column is frequently used to link to the PATIENT table.
- **PAT_ENC_DATE_REAL**: A unique, internal contact date in decimal format. The integer portion of the number indicates the date of the contact. The digits after the decimal distinguish different contacts on the same date and are unique for each contact on that date. For example, .00 is the first/only contact, .01 is the second contact, etc.
- **PAT_ENC_CSN_ID**: The unique contact serial number for this contact. This number is unique across patients and encounters in your system. If you use IntraConnect this is the Unique Contact Identifier (UCI).
- **RESULT_LAB_ID**: The unique ID of the lab or other resulting agency, such as radiology, that provided the order results.
- **RESULT_LAB_ID_LLB_NAME**: Interface laboratory name.
- **ORDERING_DATE**: The date when the procedure order was placed.
- **ORDER_TYPE_C_NAME**: The order type category number for the procedure order.
- **PROC_ID**: The unique ID of the  procedure record corresponding to this order. This can be used to link to CLARITY_EAP.
- **DESCRIPTION**: A brief summary of the procedure order.
- **ORDER_CLASS_C_NAME**: The order class category number of the procedure order.
- **AUTHRZING_PROV_ID**: The unique ID of the provider prescribing or authorizing the order.
- **ABNORMAL_YN**: Indicates whether or not this order contains abnormal results. This column will contain a Y if there are abnormal results and an N or null if it does not. For orders with lab component results, if any one component of this order has an abnormal result value then this will hold a Y.
- **BILLING_PROV_ID**: The unique ID of the provider under whose name this order should be billed. This might be the same ID as the AUTHRZING_PROV_ID.
- **ORD_CREATR_USER_ID**: The unique identifier of the user who signed the order, or the last person who performed a sign and hold or release action for a signed and held order.
- **ORD_CREATR_USER_ID_NAME**: The name of the user record. This name may be hidden.
- **LAB_STATUS_C_NAME**: The category number for the status of results for an order, as of the date and time the record was extracted.
- **ORDER_STATUS_C_NAME**: The order status category number of the procedure order.
- **MODIFIER1_ID**: The unique ID of the modifier record.  This is the first modifier entered for the procedure and affects how the procedure is billed.
- **MODIFIER1_ID_MODIFIER_NAME**: The name of the modifier record.
- **MODIFIER2_ID**: The unique ID of the modifier record.  This is the second modifier entered for the procedure and affects how the procedure is billed.
- **MODIFIER2_ID_MODIFIER_NAME**: The name of the modifier record.
- **MODIFIER3_ID**: The unique ID of the modifier record.  This is the third modifier entered for the procedure and affects how the procedure is billed.
- **MODIFIER3_ID_MODIFIER_NAME**: The name of the modifier record.
- **MODIFIER4_ID**: The unique ID of the modifier record.  This is the fourth modifier entered for the procedure and affects how the procedure is billed.
- **MODIFIER4_ID_MODIFIER_NAME**: The name of the modifier record.
- **QUANTITY**: The number of procedures authorized for this order.
- **REASON_FOR_CANC_C_NAME**: The reason for cancellation category number for the procedure order.
- **FUTURE_OR_STAND**: This column indicates whether an order is a future (F) or standing (S) order.
- **STANDING_EXP_DATE**: The date when a recurring procedure order expires.
- **FUT_EXPECT_COMP_DT**: The date by which each future procedure order should be completed. Displayed in calendar format.
- **STANDING_OCCURS**: The number of individual occurrences remaining for this procedure order.
- **STAND_ORIG_OCCUR**: The total number of occurrences that a recurring order was authorized for.
- **REFERRING_PROV_ID**: The unique ID of the provider who has referred this order, i.e. the referring provider.
- **REFERRING_PROV_ID_REFERRING_PROV_NAM**: The name of the referral source.
- **REFD_TO_LOC_ID**: The unique ID of the location record to which this patient was referred.
- **REFD_TO_SPECLTY_C_NAME**: The category value for the medical specialty of the provider to which the patient is referred.  This field does not contain data for referral orders created within Epic.
- **REQUESTED_SPEC_C_NAME**: The medical specialty category number of the provider to which the patient was referred for the procedure order.
- **RFL_CLASS_C_NAME**: The referral class category number for the procedure order.
- **RFL_TYPE_C_NAME**: The referral type category number for the procedure order.
- **RSN_FOR_RFL_C_NAME**: The reason for referral category number for the procedure order.
- **RFL_NUM_VIS**: The number of visits this referral order is authorized for.
- **RFL_EXPIRE_DT**: The expiration date for this referral order.
- **ABN_NOTE_ID**: The unique ID of the notes record representing the Advanced Beneficiary Notice form associated with this order.
- **RADIOLOGY_STATUS_C_NAME**: The category ID for the imaging study status (e.g. technician ended the exam, reading physician finalized the exam) of the procedure order.
- **INT_STUDY_C_NAME**: The category ID for denoting the reason a study is worth being marked for later review, as in for an educational case or for group reading physician review.
- **INT_STUDY_USER_ID**: The unique ID of the employee record who denoted a study as worth being marked for later review, as in for an educational case or for group reading physician review.
- **INT_STUDY_USER_ID_NAME**: The name of the user record. This name may be hidden.
- **TECHNOLOGIST_ID**: The unique ID of the employee record of the technologist who performed this procedure.
- **TECHNOLOGIST_ID_NAME**: The name of the user record. This name may be hidden.
- **PROC_BGN_TIME**: The date and time when the procedure order (exam) is to begin.
- **RIS_TRANS_ID**: The unique ID of the user record of the transcriptionist for this order.
- **RIS_TRANS_ID_NAME**: The name of the user record. This name may be hidden.
- **ORDER_INST**: The instant when the order was created.
- **DISPLAY_NAME**: The name of the order as it appears in the patient's record.
- **HV_HOSPITALIST_YN**: Indicates whether or not this order was placed by a hospitalist. �Y�  indicates that this order was placed by a hospitalist. �N� or NULL indicate that this order was not placed by a hospitalist.
- **ORDER_PRIORITY_C_NAME**: The overall priority category number for the procedure order.
- **CHRG_DROPPED_TIME**: The date and time when the charge was generated for the procedure order.
- **PANEL_PROC_ID**: The unique ID of the panel procedure record associated with this order.
- **STAND_INTERVAL**: The time interval set for a recurring order, indicating the time between one instance of the order and the next instance.
- **DISCRETE_INTERVAL_NAME**: The discrete interval for the order.  This is extracted as the category title.
- **INSTANTIATED_TIME**: The date and time of instantiation when a child order is generated from a standing or future order.
- **INSTNTOR_USER_ID**: The unique ID of the user who instantiated the order.
- **INSTNTOR_USER_ID_NAME**: The name of the user record. This name may be hidden.
- **DEPT_REF_PROV_ID**: The unique ID of the department to which this order is referred.
- **SPECIALTY_DEP_C_NAME**: The category value for the requested medical specialty of the department to which the patient is referred.
- **SPECIMEN_TYPE_C_NAME**: The specimen type category number for the procedure order.
- **SPECIMEN_SOURCE_C_NAME**: The source category number for the procedure order.
- **ORDER_TIME**: The date and time when the procedure order was placed.
- **RESULT_TIME**: The most recent date and time when the procedure order was resulted.
- **IS_PENDING_ORD_YN**: Indicates whether or not the order has a pending status. 'Y' indicates that the order has a pending status. 'N' or NULL indicates that the order does not have a pending status.
- **PROC_START_TIME**: The date and time when the procedure order is to start.
- **PROBLEM_LIST_ID**: The unique ID of the problem list record that is associated with this order. This column is mainly used for immunization orders.
- **RSLTS_INTERPRETER**: The name of the principal results interpreter, the person who reviewed and interpreted the results.
- **PROC_ENDING_TIME**: The date and time when the procedure order is to end.
- **SPECIFIED_FIRST_TM**: The first occurrence time specified by a user, if the order was signed with a frequency record containing a schedule of specified dates and times.
- **SCHED_START_TM**: This column stores the scheduling start instant used when the order was last scheduled.
- **SESSION_KEY**: The unique key associated with the order at the time of signing.  Other orders will share this key if they were signed at the same time.
- **LABCORP_BILL_TYPE_C_NAME**: The reference lab bill type category ID for the order record, indicating how reference labs should bill for services performed.
- **LABCORP_CLIENT_ID**: The client ID or account ID assigned by the reference lab.
- **LABCORP_CONTROL_NUM**: Required information for LabCorp requisition and order messages.
- **CHNG_ORDER_PROC_ID**: The unique ID of the changed or reordered procedure order that this procedure replaced. This column is frequently used to link back to ORDER_PROC table.

### ORDER_RESULTS
**Table**: This table contains information on results from clinical system orders. This table extracts only the last Orders (ORD) contact for each ORD record.
- **ORDER_PROC_ID**: The unique ID of the procedure order record.
- **LINE**: The line number of each result component within each ordered procedure.
- **ORD_DATE_REAL**: This is a numeric representation of the date each order was placed in your system. The integer portion of the number specifies the date the order was placed. The digits after the decimal point indicate multiple orders on one day.
- **ORD_END_DATE_REAL**: This is a numeric representation of the end date for each order in your system. The integer portion of the number specifies the date the order was placed. The digits after the decimal point indicate multiple orders on one day.
- **RESULT_DATE**: The date the technician ran the tests for each order in calendar format.
- **COMPONENT_ID**: The unique ID of each result component for each result.
- **COMPONENT_ID_NAME**: The name of the component.
- **PAT_ENC_CSN_ID**: A unique serial number for the associated patient encounter. This number is unique across all patients and encounters in the system.
- **ORD_VALUE**: The value returned for each result component, in short free text format. NOTE:  This is how the data is stored in the database; as string format. Interface data may come in with alpha characters and this field is designed to store exactly what is stored in the database. This field stores numeric and structured numeric values in M internal format, using a period as the decimal separator irrespective of locale.
- **ORD_NUM_VALUE**: A numeric representation of the value returned for each component where applicable. If the value contains any non-numeric characters, the value will display as 9999999.
- **RESULT_FLAG_C_NAME**: The category value associated with a standard HL7 flag code to mark each component result as abnormal. Any value in this field not equal to 1 is considered abnormal.
- **REFERENCE_LOW**: The lowest acceptable value for each result component. If the value in this column is a number or structured numeric, the numbers will be stored in M internal format, using a period as the decimal separator.
- **REFERENCE_HIGH**: The highest acceptable value for each result component. If the value in this column is a number or structured numeric, the numbers will be stored in M internal format, using a period as the decimal separator.
- **REFERENCE_UNIT**: The units for each result component value.
- **RESULT_STATUS_C_NAME**: The category value corresponding to the status of each result record, such as 2-Preliminary, 3-Final, 4-Corrected, 5-Incomplete.
- **RESULT_SUB_IDN**: This item is populated with the unique organism identifier (OVR 700 or interface) when the component of an order result is an organism and can be joined to ORDER_SENSITIVITY.SENS_ORGANISM_SID to identify details about this organism.
- **LAB_STATUS_C_NAME**: The category value associated with the status of each result, such as 1-In Progress, 2-Preliminary, 3-Final, 4-Edited.
- **INTERFACE_YN**: This Yes/No flag identifies whether each order was resulted through an interface. The field will display "Y" if the result came through an interface, otherwise the field will display "N".
- **RESULTING_LAB_ID**: The Unique ID of the Lab running the test.
- **RESULTING_LAB_ID_LLB_NAME**: Interface laboratory name.
- **COMPONENT_COMMENT**: Contains the comments associated with a order COMPONENT_ID, i.e. this is the comments associated with a specific order component's results. If comment data is too long to fit in this item, then the comments will be found in the ORDER_RES_COMMENT table.
- **RESULT_IN_RANGE_YN**: A Yes/No category value to indicate whether a result has been verified to be within its reference range.  This item is set by the interface when the result is sent. A null value is equivalent to a "no"  value.
- **REF_NORMAL_VALS**: This is a free-text item which allows you to enter a reference range without tying it to a "low" or "high" value. For example, it could be a string ("negative"), a list of choices ("Yellow, orange"), or a descriptive range ("Less than 20"). The values entered in this range should always represent the "normal" values. This item will be displayed in Results Review as the reference range, superseding any values in the low or high items. It may also be displayed in reports, if the print groups are configured to use it. Multiple responses are permitted (one per line). If the value in this column is a number or structured numeric, the numbers will be stored in M internal format using a period as the decimal separator.
- **LRR_BASED_ORGAN_ID**: Used for storing discrete organisms. This item is used for storing isolated organisms at the component level. There may be cases where an isolated organism does not undergo sensitivity tests and therefore is only stored at the component level. Organisms with sensitivities are also stored in addition to this item.
- **LRR_BASED_ORGAN_ID_NAME**: The name of the organism.
- **COMP_RES_TECHNICIA**: ID of the Resulting Lab Technician.
- **VALUE_NORMALIZED**: Will contain the structured numeric result value in a delimited structured numeric format. Numbers will be in M internal format. The delimited structured numeric value is the user entered structured numeric value converted to a delimited format. Valid structured numeric formats are range, operator followed by number, and number followed by operator the value stored in this item is of the format:    operator1_$c(16)_number1_$c(16)_operator2_$c(16)_number2.
- **NUMERIC_PRECISION**: The number of decimal digits to the right of the decimal point.
- **COMP_OBS_INST_TM**: Timestamp to track per non-micro result component when it was collected/observed.
- **COMP_ANL_INST_TM**: Timestamp to track per non-micro result component when it was analyzed in lab.
- **RESULT_VAL_START_LN**: For multi-line results holds the starting line number of RESULTS_CMT column from ORDER_RES_COMMENT table, where the result values begin.  This column is simply an indicator of the line number(s) where a result is stored.
- **RESULT_VAL_END_LN**: For multi-line results holds the ending line number of RESULTS_CMT column from ORDER_RES_COMMENT table, where the result values begin.  This column is simply an indicator of the line number(s) where a result is stored.
- **RESULT_CMT_START_LN**: For multi-line results holds the starting line number of RESULTS_CMT column from ORDER_RES_COMMENT table, where the result values begin.  This column is simply an indicator of the line number(s) where a result is stored.
- **RESULT_CMT_END_LN**: For multi-line results holds the ending line number of RESULTS_CMT column from ORDER_RES_COMMENT table, where the result values begin.  This column is simply an indicator of the line number(s) where a result is stored.
- **ORD_RAW_VALUE**: Stores the raw value of a numeric result as entered by the user. The value stored here and in column ORD_VALUE will be different in international locales for numeric data if the decimal separator used in that locale is a comma instead of a period. This is because ORD_VALUE will store numeric values in the M internal format.
- **RAW_LOW**: Stores raw value of the minimum value of the result component mentioned in column REFERENCE_LOW. The value stored here and in REFERENCE_LOW will be different in international locales for numeric data if the decimal separator used in that locale is a comma instead of a period. This is because REFERENCE_LOW will store numeric data in M internal format.
- **RAW_HIGH**: Stores raw value of the maximum value of the result component mentioned in column REFERENCE_HIGH. The value stored here and in REFERENCE_HIGH will be different in international locales for numeric data if the decimal separator used in that locale is a comma instead of a period. This is because REFERENCE_HIGH will store numeric data in M internal format.
- **RAW_REF_VALS**: This column stores the raw value of REF_NORMAL_VALS (i.e. the reference normal values of the result component). Since REF_NORMAL_VALS will store numeric data in M internal format, the value stored here and in REF_NORMAL_VALS will be different in international locales if the decimal separator used in that locale is a comma instead of a period.
- **ORGANISM_QUANTITY**: This item is used for storing isolated organisms at the component level. It contains the numeric or qualitative quantity of the organism that was observed.
- **ORGANISM_QUANTITY_UNIT**: This item is used for storing isolated organisms at the component level. It contains the unit associated with the quantity of the organism that was observed.
- **COMPON_LNC_ID**: Logical Observation Identifiers Names and Codes (LOINC) ID of the component.
- **COMPON_LNC_SRC_C_NAME**: Source of the component Logical Observation Identifiers Names and Codes (LOINC) ID.
- **COMP_SNOMED_SRC_C_NAME**: Source of the Systemized Nomenclature of Medicine � Clinical Terms (SNOMED) code (reported vs inferred).
- **REF_UNIT_UOM_ID**: Pointer to the record that represents the component's units of measure.
- **REF_UNIT_UOM_ID_UNIT_NAME**: Record name
- **REF_RANGE_TYPE**: Displays the type of the reference range.
- **ORGANISM_SNOMED_CT**: The Systemized Nomenclature of Medicine � Clinical Terms (SNOMED) code for the component's organism.
- **ORGANISM_QUANTITY_SNOMED_CT**: The Systemized Nomenclature of Medicine � Clinical Terms (SNOMED) code for the component's organism quantity.
- **PERFORMING_ORG_INFO_LINE**: This is used to indicate the performing organization information for the component. This item stores the line number of the ORD related group which is used to save the performing organization information.
- **COMPON_EXCL_CDS_YN**: To cache if the component has a value or comment that matches a value in Excluded result text (I LSD 768).
- **RTF_VAL_START_LINE**: If the component result value is rich text, this column gives the first line of ORD_RTF_VAL_CMT that the value is stored in.
- **RTF_VAL_END_LINE**: If the component result value is rich text, this column gives the last line of ORD_RTF_VAL_CMT that the value is stored in.
- **RTF_CMT_START_LINE**: If the component comment is rich text, this column gives the first line of ORD_RTF_VAL_CMT that the component comment is stored in.
- **RTF_CMT_END_LINE**: If the component comment is rich text, this column gives the last line of ORD_RTF_VAL_CMT that the component comment is stored in.
- **RSLT_ACCR_FLAG_YN**: This item determines the accreditation status of the corresponding component. If set to Y-Yes, the corresponding component is accredited. If set to N-No, the corresponding component is not accredited. If null, no evaluation was performed on the component to determine if it is accredited or not.

### ORDER_PARENT_INFO
**Table**: This table will hold procedure order data where it is sometimes necessary to obtain the information from the parent (or possibly grandparent) order if it exists. Otherwise default to the child/normal order record's information in cases where there is no parent order.
- **ORDER_ID**: The unique identifier that consists of the order ID. Grandparent, parent and child orders will populate this table.
- **PARENT_ORDER_ID**: If the ID in the ORDER_ID column is a child order, then this column will hold the original order ID that instantiated the child (possibly a parent or possibly a grandparent order). If the ID in the ORDER_ID column is an order placed by an end user in the system (i.e. it was never instantiated- such as parent or grandparents), then this column will hold the same ID.
- **ORDERING_DTTM**: This is the original ordering date and time of the order record in the PARENT_ORDER_ID column.  For child orders, the date and time in ORDER_PROC.ORDER_INST is the date and time the order was released.
- **ORD_LOGIN_DEP_ID**: This is the original login department of the order record in the PARENT_ORDER_ID column.   For child orders, the department in ORDER_PROC_2.LOGIN_DEP_ID is the department in which the order was released.
- **PAT_ENC_CSN_ID**: The unique contact serial number for this contact. This number is unique across all patient encounters in your system. If you use IntraConnect, this is the Unique Contact Identifier (UCI). This will be the contact used to place the order record in the PARENT_ORDER_ID column.   For child orders, the contact serial number in ORDER_PROC.PAT_ENC_CSN_ID is the contact in which the order was released.
- **PAT_CONTACT_DEP_ID**: This is the patient contact department of the order record in the PARENT_ORDER_ID column.

## Sample Data (one representative non-null value per column)

### ORDER_PROC
- ORDER_PROC_ID = `439060604`
- PAT_ID = `Z7004242`
- PAT_ENC_DATE_REAL = `65581`
- PAT_ENC_CSN_ID = `829995922`
- RESULT_LAB_ID = `347`
- RESULT_LAB_ID_LLB_NAME = `UPH MHM MERITER HOSPITAL  RADIANT RAD`
- ORDERING_DATE = `7/21/2020 12:00:00 AM`
- ORDER_TYPE_C_NAME = `Imaging`
- PROC_ID = `33946`
- DESCRIPTION = `MRI BRAIN WO CONTRAST`
- ORDER_CLASS_C_NAME = `Ancillary Performed`
- AUTHRZING_PROV_ID = `219711`
- ABNORMAL_YN = `N`
- BILLING_PROV_ID = `144590`
- ORD_CREATR_USER_ID = `PICONEMA`
- ORD_CREATR_USER_ID_NAME = `PICONE, MARY A`
- LAB_STATUS_C_NAME = `Final result`
- ORDER_STATUS_C_NAME = `Completed`
- QUANTITY = `1`
- REASON_FOR_CANC_C_NAME = `No Longer Indicated`
- FUTURE_OR_STAND = `F`
- STANDING_EXP_DATE = `10/19/2020 12:00:00 AM`
- FUT_EXPECT_COMP_DT = `7/21/2020 12:00:00 AM`
- STAND_ORIG_OCCUR = `1`
- REFERRING_PROV_ID = `144590`
- REFERRING_PROV_ID_REFERRING_PROV_NAM = `RAMMELKAMP, ZOE L`
- REFD_TO_LOC_ID = `36942`
- REQUESTED_SPEC_C_NAME = `Neurology`
- RFL_CLASS_C_NAME = `Internal`
- RFL_TYPE_C_NAME = `MRI/CAT Scan`
- RSN_FOR_RFL_C_NAME = `Specialty Services Required`
- RFL_NUM_VIS = `1`
- RADIOLOGY_STATUS_C_NAME = `Final`
- PROC_BGN_TIME = `2/8/2019 8:00:00 PM`
- ORDER_INST = `7/21/2020 12:38:00 PM`
- DISPLAY_NAME = `MRI Brain wo Contrast`
- HV_HOSPITALIST_YN = `N`
- ORDER_PRIORITY_C_NAME = `Routine`
- INSTANTIATED_TIME = `7/31/2020 9:16:00 AM`
- INSTNTOR_USER_ID = `CCT400`
- INSTNTOR_USER_ID_NAME = `KALSOW, COURTNEY C`
- DEPT_REF_PROV_ID = `101401034`
- SPECIALTY_DEP_C_NAME = `Radiology`
- SPECIMEN_TYPE_C_NAME = `Blood`
- ORDER_TIME = `7/21/2020 12:38:00 PM`
- RESULT_TIME = `9/28/2023 4:09:00 PM`
- IS_PENDING_ORD_YN = `N`
- PROC_START_TIME = `7/21/2020 12:00:00 AM`
- PROBLEM_LIST_ID = `104512005`
- PROC_ENDING_TIME = `9/28/2023 11:59:00 PM`
- SESSION_KEY = `5666243913`

### ORDER_RESULTS
- ORDER_PROC_ID = `439060606`
- LINE = `1`
- ORD_DATE_REAL = `64869.01`
- ORD_END_DATE_REAL = `66745.01`
- RESULT_DATE = `9/28/2023 12:00:00 AM`
- COMPONENT_ID = `1180011095`
- COMPONENT_ID_NAME = `HEPATITIS C AB`
- PAT_ENC_CSN_ID = `1028743701`
- ORD_VALUE = `NONREACTIVE`
- ORD_NUM_VALUE = `9999999`
- RESULT_FLAG_C_NAME = `(NONE)`
- REFERENCE_LOW = `0`
- REFERENCE_HIGH = `199`
- REFERENCE_UNIT = `mg/dL`
- RESULT_STATUS_C_NAME = `Final`
- RESULT_SUB_IDN = `1`
- LAB_STATUS_C_NAME = `Final result`
- INTERFACE_YN = `Y`
- RESULTING_LAB_ID = `359`
- RESULTING_LAB_ID_LLB_NAME = `UPH MADISON MERITER SUNQUEST LAB`
- COMPONENT_COMMENT = `PATIENT WAS NOT FASTING`
- RESULT_IN_RANGE_YN = `Y`
- REF_NORMAL_VALS = `NR`
- COMP_RES_TECHNICIA = `40000`
- VALUE_NORMALIZED = `>90`
- COMP_OBS_INST_TM = `9/28/2023 10:10:00 AM`
- COMP_ANL_INST_TM = `9/28/2023 4:09:00 PM`
- RESULT_CMT_START_LN = `1`
- RESULT_CMT_END_LN = `1`
- COMPON_LNC_ID = `6827`
- COMPON_LNC_SRC_C_NAME = `Reported`
- COMP_SNOMED_SRC_C_NAME = `Reported`
- PERFORMING_ORG_INFO_LINE = `1`

### ORDER_PARENT_INFO
- ORDER_ID = `439060604`
- PARENT_ORDER_ID = `439060612`
- ORDERING_DTTM = `7/21/2020 12:38:00 PM`
- ORD_LOGIN_DEP_ID = `1700801002`
- PAT_ENC_CSN_ID = `829995922`
- PAT_CONTACT_DEP_ID = `1700801002`

## Pipeline Code

### Stage 1: SQL Projection (project.ts → raw JSON)
```typescript
function projectOrder(oid: unknown): EpicRow {
  const rows = mergeQuery("ORDER_PROC", `b."ORDER_PROC_ID" = ?`, [oid]);
  const order = rows[0] ?? { ORDER_PROC_ID: oid };

  attachChildren(order, oid, orderChildren);

  // Resolve procedure name
  order._procedure_name = lookupName("CLARITY_EAP", "PROC_ID", "PROC_NAME", order.PROC_ID);

  return order;
}
```

### Stage 2: Domain Model Hydration (PatientRecord.ts)
```typescript
export class OrderResult {
  ORDER_PROC_ID: EpicID;
  componentName?: string;
  value?: string;
  referenceUnit?: string;
  referenceRange?: string;
  resultStatus?: string;
  resultFlag?: string;
  resultDate?: string;

  constructor(raw: EpicRow) {
    Object.assign(this, raw);
    this.ORDER_PROC_ID = raw.ORDER_PROC_ID as EpicID;
    this.componentName = raw.COMPONENT_ID_NAME as string;
    this.value = raw.ORD_VALUE as string;
    this.referenceUnit = raw.REFERENCE_UNIT as string;
    this.referenceRange = raw.REFERENCE_RANGE as string;
    this.resultStatus = raw.RESULT_STATUS_C_NAME as string;
    this.resultFlag = raw.RESULT_FLAG_C_NAME as string;
    this.resultDate = raw.RESULT_DATE as string;
  }

  /** Is this result flagged as abnormal? */
  get isAbnormal(): boolean {
    const flag = this.resultFlag?.toUpperCase();
    return flag === 'H' || flag === 'L' || flag === 'A' || flag === 'HH' || flag === 'LL';
  }

  toString(): string {
    const flag = this.isAbnormal ? ` [${this.resultFlag}]` : '';
    return `${this.componentName}: ${this.value} ${this.referenceUnit ?? ''}${flag}`.trim();
  }
}

export class OrderResult {
  ORDER_PROC_ID: EpicID;
  componentName?: string;
  value?: string;
  referenceUnit?: string;
  referenceRange?: string;
  resultStatus?: string;
  resultFlag?: string;
  resultDate?: string;

  constructor(raw: EpicRow) {
    Object.assign(this, raw);
    this.ORDER_PROC_ID = raw.ORDER_PROC_ID as EpicID;
    this.componentName = raw.COMPONENT_ID_NAME as string;
    this.value = raw.ORD_VALUE as string;
    this.referenceUnit = raw.REFERENCE_UNIT as string;
    this.referenceRange = raw.REFERENCE_RANGE as string;
    this.resultStatus = raw.RESULT_STATUS_C_NAME as string;
    this.resultFlag = raw.RESULT_FLAG_C_NAME as string;
    this.resultDate = raw.RESULT_DATE as string;
  }

  /** Is this result flagged as abnormal? */
  get isAbnormal(): boolean {
    const flag = this.resultFlag?.toUpperCase();
    return flag === 'H' || flag === 'L' || flag === 'A' || flag === 'HH' || flag === 'LL';
  }

  toString(): string {
    const flag = this.isAbnormal ? ` [${this.resultFlag}]` : '';
    return `${this.componentName}: ${this.value} ${this.referenceUnit ?? ''}${flag}`.trim();
  }
}
```

### Stage 3: Clean Projection (HealthRecord.ts → final output)
```typescript
    orders: (v.orders ?? []).map((o: any) => projectOrder(o, r)),
    notes: (v.notes ?? [])
      .map((n: any): VisitNote => ({
        id: sid(n.NOTE_ID),
        type: str(n.IP_NOTE_TYPE_C_NAME),
        author: str(n.AUTHOR_NAME ?? n.ENTRY_USER_ID_NAME),
        date: toISODateTime(n.ENTRY_INSTANT_DTTM),
        text: Array.isArray(n.text) ? n.text.map((t: any) => t.NOTE_TEXT ?? '').join('') : '',
        _epic: epic(n),
      }))

function projectResult(res: any): OrderResult {
  return {
    component: res.componentName ?? res.COMPONENT_ID_COMPONENT_NAME ?? 'Unknown',
    value: String(res.ORD_VALUE ?? res.value ?? ''),
    unit: str(res.REFERENCE_UNIT),
    referenceRange: (res.REFERENCE_LOW != null && res.REFERENCE_HIGH != null)
      ? `${res.REFERENCE_LOW}-${res.REFERENCE_HIGH}` : null,
    flag: str(res.RESULT_FLAG_C_NAME),
    isAbnormal: res.isAbnormal ?? (res.RESULT_FLAG_C_NAME != null && res.RESULT_FLAG_C_NAME !== 'Normal'),
    resultDate: toISODateTime(res.RESULT_DATE),
    _epic: epic(res),
  };
}

    labResults: projectAllLabResults(r),
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
```

## Actual Output (from health_record_full.json)

```json
[
  {
    "orderId": "439060607",
    "orderName": "H. PYLORI ANTIGEN, STOOL",
    "visitId": "725327197",
    "visitDate": "2018-08-18",
    "component": "H PYLORI ANTIGEN STOOL",
    "value": "NEGATIVE FOR H PYLORI STOOL ANTIGEN",
    "isAbnormal": false,
    "resultDate": "2018-08-18",
    "_epic": {
      "ORDER_PROC_ID": 439060607,
      "componentName": "H PYLORI ANTIGEN STOOL",
      "value": "NEGATIVE FOR H PYLORI STOOL ANTIGEN",
      "resultStatus": "Final",
      "resultDate": "8/18/2018 12:00:00 AM",
      "LINE": 1,
      "ORD_DATE_REAL": 64878.01,
      "ORD_END_DATE_REAL": 64878.01,
      "RESULT_DATE": "8/18/2018 12:00:00 AM",
      "COMPONENT_ID": 1805459,
      "COMPONENT_ID_NAME": "H PYLORI ANTIGEN STOOL",
      "PAT_ENC_CSN_ID": 725327197,
      "ORD_VALUE": "NEGATIVE FOR H PYLORI STOOL ANTIGEN",
      "ORD_NUM_VALUE": 9999999,
      "RESULT_STATUS_C_NAME": "Final",
      "RESULT_SUB_IDN": "1",
      "LAB_STATUS_C_NAME": "Final result",
      "INTERFACE_YN": "Y",
      "COMPONENT_COMMENT": "Testing performed at Meriter Laboratories, 36 S Brooks St Madison, WI 53715, unless otherwise stated in result.",
      "REF_NORMAL_VALS": "NEGATIVE FOR H PYLORI STOOL ANTIGEN",
      "COMP_RES_TECHNICIA": "041518-ALEESA L SHAW",
      "COMP_OBS_INST_TM": "8/18/2018 2:25:00 PM"
    }
  },
  {
    "orderId": "772179260",
    "orderName": "BASIC METABOLIC PANEL",
    "visitId": "948004323",
    "visitDate": "2022-08-29",
    "component": "SODIUM",
    "value": "142",
    "unit": "mmol/L",
    "referenceRange": "136-145",
    "isAbnormal": false,
    "resultDate": "2022-08-29",
    "_epic": {
      "ORDER_PROC_ID": 772179262,
      "componentName": "SODIUM",
      "value": "142",
      "referenceUnit": "mmol/L",
      "resultStatus": "Final",
      "resultDate": "8/29/2022 12:00:00 AM",
      "LINE": 1,
      "ORD_DATE_REAL": 66350.01,
      "ORD_END_DATE_REAL": 66350.01,
      "RESULT_DATE": "8/29/2022 12:00:00 AM",
      "COMPONENT_ID": 1534098,
      "COMPONENT_ID_NAME": "SODIUM",
      "PAT_ENC_CSN_ID": 958147754,
      "ORD_VALUE": "142",
      "ORD_NUM_VALUE": 142,
      "REFERENCE_LOW": "136",
      "REFERENCE_HIGH": "145",
      "REFERENCE_UNIT": "mmol/L",
      "RESULT_STATUS_C_NAME": "Final",
      "RESULT_SUB_IDN": "1",
      "LAB_STATUS_C_NAME": "Final result",
      "INTERFACE_YN": "Y",
      "RESULTING_LAB_ID": 422,
      "RESULTING_LAB_ID_LLB_NAME": "ASSOCIATED PHYSICIANS LLP",
      "RESULT_IN_RANGE_YN": "Y",
      "COMP_RES_TECHNICIA": "100315",
      "COMP_OBS_INST_TM": "8/29/2022 2:32:00 PM",
      "COMP_ANL_INST_TM": "8/29/2022 3:41:00 PM",
      "COMPON_LNC_ID": 21291,
      "COMPON_LNC_SRC_C_NAME": "Reported",
      "PERFORMING_ORG_INFO_LINE": 1
    }
  },
  {
    "orderId": "772179260",
    "orderName": "BASIC METABOLIC PANEL",
    "visitId": "948004323",
    "visitDate": "2022-08-29",
    "component": "POTASSIUM",
    "value": "5.0",
    "unit": "mmol/L",
    "referenceRange": "3.5-5.1",
    "isAbnormal": false,
    "re
```

## Instructions

1. Read every column's Epic schema description carefully.
2. Trace each column from the SQL query through PatientRecord hydration to HealthRecord output.
3. For each field in the output, verify: is the source column correct for what this field claims to represent?
4. For each column in the sample data that has a value, verify: is it read by the code? If not, should it be?
5. Check property name continuity across the three stages — does stage 3 read the property that stage 2 wrote?
6. Check for nondeterminism in queries and aggregations.

Report your findings as a structured list of issues. If you find zero issues, say so explicitly.