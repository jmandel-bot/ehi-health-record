You are reviewing an Epic EHI data mapping for semantic correctness.

## Your Task

Analyze the mapping pipeline for **Messages: MYC_MESG → MSG_TXT → Message → HealthRecord.messages** and identify every semantic error — places where a column is read successfully but the value means something different than the code assumes.

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

### MYC_MESG
**Table**: This table contains information on messages sent to and from web-based chart system patients.
- **MESSAGE_ID**: The unique ID used to identify a web-based chart system message record. A new record is created each time a patient sends a message from a web-based chart system to a system user and each time a system user sends a message to a web-based chart system patient.
- **CREATED_TIME**: The date and time the web-based chart system message record was created in local time.
- **PARENT_MESSAGE_ID**: The unique ID of the original message in a chain of web-based chart system messages between patients and system users.
- **INBASKET_MSG_ID**: The unique ID of the system message associated with the web-based chart system message. An example is when a patient sends a message to a system user.
- **PAT_ID**: The unique ID of the patient record for this row. This column is frequently used to link to the PATIENT table.
- **PAT_ENC_DATE_REAL**: A unique, internal contact date in decimal format. The integer portion of the number indicates the date of the contact. The digits after the decimal distinguish different contacts on the same date and are unique for each contact on that date. For example, .00 is the first/only contact, .01 is the second contact, etc.
- **FROM_USER_ID**: The unique ID of the system user who sent a web-based chart system message to a patient.
- **FROM_USER_ID_NAME**: The name of the user record. This name may be hidden.
- **TO_USER_ID**: The unique ID of the system user who was sent a web-based chart system message from a patient.
- **TO_USER_ID_NAME**: The name of the user record. This name may be hidden.
- **TOFROM_PAT_C_NAME**: The message direction category number for the web-based chart system message. 1 corresponds to "To patient". 2 corresponds to "From patient".
- **ORIGINAL_TO**: If a message sent from a web-based chart system patient is re-routed from its intended destination, then the ID of the original recipient is stored in the field. Most commonly this occurs when a system user does not accept messages directly from web-based chart system patients. In this case, the message will be re-routed to a pool, but the employee ID of the system user will be stored here. The ID of the final destination is stored in MODIFIED_TO.
- **RQSTD_PHARMACY_ID**: The unique ID of the pharmacy selected by the patient from the drop down list when sending a Medication Renewal Request message.
- **RQSTD_PHARMACY_ID_PHARMACY_NAME**: The name of the pharmacy.
- **UPDATE_DATE**: The date and time that this web-based chart system message record was pulled into enterprise reporting.
- **REQUEST_SUBJECT**: This field is only used for medical advice request messages and indicates the subject selected by the patient from the drop down list.
- **PROV_ID**: The provider that was used in routing the patient access message. The provider may vary depending on message type.
- **DEPARTMENT_ID**: The department used in routing the patient access message. The department may vary depending on message type.
- **RESP_INFO**: Some response types will include additional information, such as a phone number.  If such data exists for the chosen response method, it will be stored in this field.
- **SUBJECT**: The subject line of the web-based chart system message.
- **PAT_ENC_CSN_ID**: The unique contact serial number for this contact. This number is unique across all patient encounters in your system. If you use IntraConnect, this is the Unique Contact Identifier (UCI).
- **EOW_READ_STATUS_C_NAME**: The read status category number for the web-based chart system message.
- **BILL_ACCT_ID**: The unique ID of the guarantor account associated with this web-based chart system message.
- **BILL_ACCT_TYPE_C_NAME**: The billing account type category number for the web-based chart system message. Only billing-specific customer service messages have a value specified for this column.
- **BILL_ACCT_HAR_ID**: The unique ID of the hospital account associated with this web-based chart system message.
- **RELATED_MESSAGE_ID**: The unique ID of the parent message of the original message chain. This applies only when the system is configured to allow patients to reply to messages associated with closed encounters by creating a new message chain. This item is populated for the message that starts a new chain.
- **WPR_OWNER_WPR_ID**: The unique ID of the web-based chart system patient who owns this message.
- **CR_TX_CARD_ID**: The unique ID of the credit card used for this transaction.
- **CR_TX_MYPT_ID**: The unique ID of the web-based chart system patient associated with this transaction.
- **CR_TX_AMOUNT_AUTH**: The amount authorized for this transaction.
- **PAT_HX_QUESR_ID**: The unique ID of the history questionnaire associated with this message.
- **PAT_HX_QUESR_ID_RECORD_NAME**: The name of the Visit Navigator (VN) History Template Definition (LQH) record.
- **HX_QUESR_CONTEXT_C_NAME**: The history questionnaire context category number for the web-based chart system message.
- **HX_QUESR_PROV_ID**: The unique ID of the provider associated with the questionnaire.
- **HX_QUESR_ENCPROV_ID**: The unique ID of the provider associated with the appointment that the questionnaire is linked to.
- **HX_QUESR_APPT_DAT**: The appointment contact date (DAT) if the questionnaire is linked to an appointment.
- **HX_QUESR_FILED_YN**: Indicates whether the history questionnaire has been filed for this web-based chart system message. Y indicates that the history questionnaire has been filed. N or a null value indicates that the history questionnaire has not been filed.
- **DELIVERY_DTTM**: The instant that this message is scheduled for delivery to the patient. This item may not be populated. In the event that this item is not populated, then the instant the message is created is used to determine when the patient can view the message.
- **RECORD_STATUS_C_NAME**: The category title of the status of the message. If not populated, then the message is active; Soft deleted is set when a message is revoked.
- **CR_TX_TYPE_C_NAME**: Stores the type of transaction (E-Visit or Copay).
- **HX_QUESR_REVIEW_YN**: Indicates whether the history questionnaire has been viewed by a provider in edit mode for this web-based chart system message. Y indicates that the history questionnaire has been viewed, N or a null value indicates that the history questionnaire has not been viewed.
- **HX_QUESR_ENC_CSN_ID**: The unique contact serial number for the appt contact if questionnaire is linked to an appt. This number is unique across all patient encounters in your system. If you use IntraConnect, this is the Unique Contact Identifier (UCI).
- **OUTREACH_RUN_ID**: This is the campaign outreach configuration template associated with this message.
- **RENEWAL_REQ_SRC_C_NAME**: This item stores the request source of a medication renewal request. The  default is 2-Web.
- **REQ_PHARM_FREE_TEXT**: If the selected pharmacy was entered by the user as free-text, then it is stored here.
- **HX_QUESR_EDIT_MYPT_ID**: Stores the Patient Access Account (WPR) record for the user who last made changes to an in progress history questionnaire
- **HX_QUESR_EDIT_INST_DTTM**: Stores the time at which changes were last made to an in progress history questionnaire
- **REFERRAL_ID**: The unique ID of the referral this message is associated with.
- **COMM_ID**: The customer service record ID corresponding to the message
- **AUTH_REQUEST_ID**: The authorization request this message is associated with.
- **INFO_REQ_CSN_ID**: The Information Request this message is associated with.
- **NON_HX_QUESR_WITH_HX_DATA_YN**: 1 - If WMG stores history data even though the WMG type is not 22 - HISTORY Questionnaire.

### MSG_TXT
**Table**: This table contains the text of MyChart messages.
- **MESSAGE_ID**: The unique identifier for the message record.
- **LINE**: The line number for the information associated with this record. Multiple pieces of information can be associated with this record.
- **MSG_TXT**: Stores the body text in the message.

### MYC_MESG_RTF_TEXT
**Table**: Patient message content, in RTF format. Replaces item 100 (plain text message body). Further, this content contains only the current message, whereas the plain text item might have appended previous messages in addition to the current message.
- **MESSAGE_ID**: The unique identifier for the message record.
- **LINE**: The line number for the information associated with this record. Multiple pieces of information can be associated with this record.
- **RTF_TXT**: The text of a message, in RTF format.

## Sample Data (one representative non-null value per column)

### MYC_MESG
- MESSAGE_ID = `19025649`
- CREATED_TIME = `3/4/2022 4:09:00 PM`
- PARENT_MESSAGE_ID = `27919516`
- INBASKET_MSG_ID = `710695166`
- PAT_ID = `Z7004242`
- PAT_ENC_DATE_REAL = `66179`
- FROM_USER_ID = `MYCHARTG`
- FROM_USER_ID_NAME = `MYCHART, GENERIC`
- TO_USER_ID = `KLL403`
- TO_USER_ID_NAME = `LOUGH, KAREN L`
- TOFROM_PAT_C_NAME = `To Patient`
- ORIGINAL_TO = `KLL403`
- UPDATE_DATE = `3/4/2022 5:04:00 PM`
- REQUEST_SUBJECT = `5`
- PROV_ID = `E1011`
- DEPARTMENT_ID = `1`
- SUBJECT = `Appointment Reminder`
- PAT_ENC_CSN_ID = `922942674`
- EOW_READ_STATUS_C_NAME = `Read`
- WPR_OWNER_WPR_ID = `389635`
- RENEWAL_REQ_SRC_C_NAME = `Web`

### MSG_TXT
- MESSAGE_ID = `19025649`
- LINE = `1`
- MSG_TXT = `Appointment Information:`

### MYC_MESG_RTF_TEXT
- MESSAGE_ID = `33704267`
- LINE = `1`
- RTF_TXT = `{\rtf1\epic10403\ansi\spltpgpar\jexpand\noxlattoyen\deff0{\fonttbl{\f0 Segoe UI;}}{\colortbl ;}\pape`

## Pipeline Code

### Stage 1: SQL Projection (project.ts → raw JSON)
```typescript
function projectMessages(patId: unknown): EpicRow[] {
  const rows = q(`SELECT * FROM MYC_MESG WHERE PAT_ID = ?`, [patId]);
  for (const msg of rows) {
    msg.text = children("MSG_TXT", "MESSAGE_ID", msg.MESSAGE_ID);
    if (tableExists("MYC_MESG_CHILD")) {
      msg.child_messages = children("MYC_MESG_CHILD", "MESSAGE_ID", msg.MESSAGE_ID);
    }
    if (tableExists("MYC_MESG_RTF_TEXT")) {
      msg.rtf_text = children("MYC_MESG_RTF_TEXT", "MESSAGE_ID", msg.MESSAGE_ID);
    }
    if (tableExists("MYC_MESG_QUESR_ANS")) {
      msg.questionnaire_answers = children("MYC_MESG_QUESR_ANS", "MESSAGE_ID", msg.MESSAGE_ID);
    }
  }
  return rows;
}
```

### Stage 2: Domain Model Hydration (PatientRecord.ts)
```typescript
export class Message {
  MESSAGE_ID: EpicID;
  messageType?: string;
  senderName?: string;
  createdDate?: string;
  text: EpicRow[] = [];
  threadId?: EpicID;

  constructor(raw: EpicRow) {
    Object.assign(this, raw);
    this.MESSAGE_ID = raw.MESSAGE_ID as EpicID;
    this.messageType = raw.MSG_TYPE_C_NAME as string;
    this.text = (raw.text as EpicRow[]) ?? [];
  }

  linkedEncounters(record: PatientRecordRef): Encounter[] {
    return record.encounterMessageLinks
      .filter(l => l.MESSAGE_ID === this.MESSAGE_ID)
      .map(l => record.encounterByCSN(l.PAT_ENC_CSN_ID))
      .filter((e): e is Encounter => e !== undefined);
  }

  get plainText(): string {
    return this.text.map(t => t.MSG_TEXT as string).filter(Boolean).join('\n');
  }
}
```

### Stage 3: Clean Projection (HealthRecord.ts → final output)
```typescript
function projectMessage(m: any): Message {
  return {
    id: sid(m.MESSAGE_ID),
    date: toISODateTime(m.CREATED_TIME ?? m.CONTACT_DATE),
    from: str(m.FROM_USER_ID_NAME),
    to: str(m.TO_USER_ID_NAME),
    subject: str(m.SUBJECT), body: str(m.MESSAGE_TEXT),
    status: str(m.MSG_STATUS_C_NAME),
    threadId: str(m.THREAD_ID),
    _epic: epic(m),
  };
}
```

## Actual Output (from health_record_full.json)

```json
[
  {
    "id": "53360694",
    "date": "2022-03-04T16:09:00.000Z",
    "from": "MYCHART, GENERIC",
    "subject": "Appointment Reminder",
    "_epic": {
      "MESSAGE_ID": "53360694",
      "CREATED_TIME": "3/4/2022 4:09:00 PM",
      "INBASKET_MSG_ID": "710695166",
      "PAT_ID": "Z7004242",
      "PAT_ENC_DATE_REAL": 66179,
      "FROM_USER_ID": "MYCHARTG",
      "FROM_USER_ID_NAME": "MYCHART, GENERIC",
      "TOFROM_PAT_C_NAME": "To Patient",
      "UPDATE_DATE": "3/4/2022 5:04:00 PM",
      "PROV_ID": "E1011",
      "DEPARTMENT_ID": 1,
      "SUBJECT": "Appointment Reminder",
      "PAT_ENC_CSN_ID": 922942674
    }
  },
  {
    "id": "25505522",
    "date": "2020-07-14T09:54:00.000Z",
    "from": "MYCHART, GENERIC",
    "subject": "Appointment Rescheduled",
    "_epic": {
      "MESSAGE_ID": "25505522",
      "CREATED_TIME": "7/14/2020 9:54:00 AM",
      "INBASKET_MSG_ID": "530638879",
      "PAT_ID": "Z7004242",
      "PAT_ENC_DATE_REAL": 65574,
      "FROM_USER_ID": "MYCHARTG",
      "FROM_USER_ID_NAME": "MYCHART, GENERIC",
      "TOFROM_PAT_C_NAME": "To Patient",
      "UPDATE_DATE": "7/15/2020 11:07:00 AM",
      "PROV_ID": "E1011",
      "DEPARTMENT_ID": 1700801002,
      "SUBJECT": "Appointment Rescheduled",
      "PAT_ENC_CSN_ID": 829213099
    }
  },
  {
    "id": "19034115",
    "date": "2019-12-23T08:45:00.000Z",
    "from": "MYCHART, GENERIC",
    "subject": "Appointment Scheduled",
    "_epic": {
      "MESSAGE_ID": "19034115",
      "CREATED_TIME": "12/23/2019 8:45:00 AM",
      "INBASKET_MSG_ID": "480451771",
      "PAT_ID": "Z7004242",
      "PAT_ENC_DATE_REAL": 65387,
      "FROM_USER_ID": "MYCHARTG",
      "FROM_USER_ID_NAME": "MYCHART, GENERIC",
      "TOFROM_PAT_C_NAME": "To Patient",
      "UPDATE_DATE": "3/11/2020 10:42:00 AM",
      "PROV_ID": "E1011",
      "DEPARTMENT_ID": 1700801002,
      "SUBJECT": "Appointment Scheduled",
      "PAT_ENC_CSN_ID": 799951565
    }
  }
]
```

## Instructions

1. Read every column's Epic schema description carefully.
2. Trace each column from the SQL query through PatientRecord hydration to HealthRecord output.
3. For each field in the output, verify: is the source column correct for what this field claims to represent?
4. For each column in the sample data that has a value, verify: is it read by the code? If not, should it be?
5. Check property name continuity across the three stages — does stage 3 read the property that stage 2 wrote?
6. Check for nondeterminism in queries and aggregations.

Report your findings as a structured list of issues. If you find zero issues, say so explicitly.