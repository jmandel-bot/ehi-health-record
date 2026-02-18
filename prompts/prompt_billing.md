You are reviewing an Epic EHI data mapping for semantic correctness.

## Your Task

Analyze the mapping pipeline for **Billing: ARPB_TRANSACTIONS → BillingTransaction → HealthRecord.billing** and identify every semantic error — places where a column is read successfully but the value means something different than the code assumes.

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

### ARPB_TRANSACTIONS
**Table**: This table contains information about professional billing transactions.
- **TX_ID**: A transaction's unique internal identification number. A patient's record can include charges, payments, or adjustments and the patient's account balance will reflect these transactions.
- **POST_DATE**: The date when a transaction is entered into the billing system.  This differs from the service date, which is the date when the service was performed.
- **SERVICE_DATE**: The date a medical service is performed.
- **TX_TYPE_C_NAME**: The type of this transaction: Charge, payment or adjustment.
- **ACCOUNT_ID**: The internal ID of the record that maintains the patient's transactions. A patient may use more than one account and an account may contain more than one patient.
- **DEBIT_CREDIT_FLAG_NAME**: This column contains a 1 if the transaction is a debit and a -1 if the transaction is a credit. A charge is always a debit, a payment is always a credit, and an adjustment can be either a debit or a credit.
- **SERV_PROVIDER_ID**: The internal identifier of the provider who performed the medical services on the patient.
- **BILLING_PROV_ID**: The billing provider associated with the transaction.
- **DEPARTMENT_ID**: The department ID of the department associated with the transaction.
- **POS_ID**: The place of service ID of the place of service associated with the transaction
- **LOC_ID**: The location ID of the location associated with the transaction.
- **SERVICE_AREA_ID**: The service area ID of the service area associated with the transaction.
- **MODIFIER_ONE**: The first procedure modifier associated with this transaction. This is the external modifier, as it would be printed on the claim.
- **MODIFIER_TWO**: The second procedure modifier associated with this transaction. This is the external modifier, as it would be printed on the claim.
- **MODIFIER_THREE**: The third procedure modifier associated with this transaction. This is the external modifier, as it would be printed on the claim.
- **MODIFIER_FOUR**: The fourth procedure modifier associated with this transaction. This is the external modifier, as it would be printed on the claim.
- **PRIMARY_DX_ID**: The primary diagnosis ID associated with the transaction.
- **DX_TWO_ID**: The second diagnosis ID associated with the transaction.
- **DX_THREE_ID**: The third diagnosis ID associated with the transaction.
- **DX_FOUR_ID**: The fourth diagnosis ID associated with the transaction.
- **DX_FIVE_ID**: The fifth diagnosis ID associated with the transaction.
- **DX_SIX_ID**: The sixth diagnosis ID associated with the transaction.
- **PROCEDURE_QUANTITY**: The quantity as entered in Charge Entry for the procedure of this transaction (TX_ID). If the row has a DETAIL_TYPE value of 10-13, this column displays a negative value. If the row has a DETAIL_TYPE value of 20-33, 43-45, 50, or 51, this column displays a zero.
- **AMOUNT**: The original amount of this transaction.
- **OUTSTANDING_AMT**: The outstanding amount of the transaction.
- **INSURANCE_AMT**: The insurance portion of the transaction.
- **PATIENT_AMT**: The patient or self-pay portion of the transaction.
- **VOID_DATE**: If this transaction is voided, this column will have the date in which this transaction is voided.
- **LAST_ACTION_DATE**: This column contains the most recent date when an action is performed on this transaction.
- **PROV_SPECIALTY_C_NAME**: This column contains the provider specialty of the provider associated with the transaction. The procedure category of the charge on the transaction may affect what specialty is recorded here and in the "Encounter Specialty" displayed in Hyperspace.
- **PROC_ID**: The Procedure ID of the procedure associated with the transaction.
- **TOTAL_MATCH_AMT**: This column contains the total amount matched to the transaction, including adjustments.
- **TOTAL_MTCH_INS_AMT**: This column contains the total insurance amount matched to the transaction, including adjustments.
- **TOTAL_MTCH_ADJ**: This column contains the total adjustment amount matched to the transaction.
- **TOTAL_MTCH_INS_ADJ**: This column contains the total insurance adjustment amount matched to the transaction.
- **REPOST_ETR_ID**: This is the repost source transaction.
- **REPOST_TYPE_C_NAME**: The repost type category ID for the transaction.
- **DISCOUNT_TYPE_C_NAME**: The discount type category ID for the transaction.
- **PAT_ENC_CSN_ID**: The Contact Serial Number for the patient encounter with which this transaction is associated. This number is unique across all patients and encounters in your system.
- **ENC_FORM_NUM**: The encounter form number corresponding to the charge transaction. If you are not using encounter forms, a negative number is stored in this item.
- **BEN_SELF_PAY_AMT**: Stores the adjudicated self-pay amount calculated by the benefits engine
- **BEN_ADJ_COPAY_AMT**: Stores the copay part of the adjudicated self-pay amount calculated by the benefits engine
- **BEN_ADJ_COINS_AMT**: Stores the coinsurance part of the adjudicated self-pay amount calculated by the benefits engine
- **VISIT_NUMBER**: This item stores the visit number for this transaction.
- **REFERRAL_ID**: This item stores the Referral (RFL) ID for this transaction.
- **ORIGINAL_EPM_ID**: This item stores the original payor (EPM) ID for this transaction.
- **ORIGINAL_FC_C_NAME**: This item stores the original financial class for this transaction.
- **ORIGINAL_CVG_ID**: This item stores the original coverage (CVG) ID for this transaction.
- **PAYOR_ID**: This item stores the current payor (EPM) ID for this transaction.
- **COVERAGE_ID**: This item stores the current coverage (CVG) ID for this transaction.
- **ASGN_YN**: This item stores the assignment flag for a coverage.  This item is set to Yes if the charge is currently assigned to the payor in the PAYOR_ID column.
- **FACILITY_ID**: This item stores the facility (EAF) ID for this transaction.
- **PAYMENT_SOURCE_C_NAME**: This item stores the payment source for credit transactions. This is a list of possible sources including Cash, Check, Credit Card, etc.
- **USER_ID**: This item stores the user who posted the transaction.
- **USER_ID_NAME**: The name of the user record. This name may be hidden.
- **NOT_BILL_INS_YN**: Indicates whether the transaction is marked for do not bill insurance.
- **CHG_ROUTER_SRC_ID**: This item stores the universal charge line (UCL) ID for this transaction.
- **RECEIVE_DATE**: This item stores the charge entry batch receive date.
- **CE_CODED_DATE**: The date this�charge session was coded, from charge entry.
- **PANEL_ID**: The ID of the panel procedure that generated this transaction.
- **BILL_AREA_ID**: Networked to BIL: the Bill Area for this transaction.
- **BILL_AREA_ID_BILL_AREA_NAME**: The record name of this bill area, financial subdivision, or financial division.
- **CREDIT_SRC_MODULE_C_NAME**: The module that creates a payment or credit adjustment
- **UPDATE_DATE**: The date that this row was last updated.
- **CLAIM_DATE**: The most recent date that this transaction has been on an accepted claim run.
- **IPP_INV_NUMBER**: This item stores the original invoice number that user posts to in GUI payment posting or remittance.
- **IPP_INV_ID**: This item stores the original invoice ID that user posts to in�graphical user interface�(GUI) payment posting or remittance.

### ARPB_VISITS
**Table**: This table contains Professional Billing visit information stored in the Hospital Accounts Receivable (HAR) master file. It doesn�t include HAR records created for Hospital Billing and Single Billing Office.
- **PB_VISIT_ID**: The unique identifier for the Professional Billing visit.
- **PB_BILLING_STATUS_C_NAME**: This column stores the Professional Billing status category ID for the visit.
- **PB_FO_OVRRD_ST_C_NAME**: This column indicates whether the Professional Billing filing order has been overridden by a user.
- **PB_FO_MSPQ_STATE_C_NAME**: This column indicates whether the filing order for the Professional Billing visit has been verified by Medicare Secondary Payer Questionnaire logic.
- **PB_VISIT_NUM**: This column stores the PB visit number.
- **PRIM_ENC_CSN_ID**: The contact serial number associated with the primary patient contact on the Professional Billing visit.
- **GUARANTOR_ID**: Stores the guarantor ID associated with the Professional Billing visit.
- **COVERAGE_ID**: The primary coverage on the Professional Billing visit.
- **SELF_PAY_YN**: Indicates whether the Professional Billing visit is self-pay.
- **DO_NOT_BILL_INS_YN**: Indicates�whether the Professional Billing visit has the Do Not Bill Insurance flag set.
- **ACCT_FIN_CLASS_C_NAME**: The financial class category ID�for the Professional Billing visit.
- **SERV_AREA_ID**: The service area of the Professional Billing visit.
- **REVENUE_LOCATION_ID**: The revenue location of the Professional Billing visit.
- **DEPARTMENT_ID**: The department of the Professional Billing visit.
- **PB_TOTAL_BALANCE**: Contains the combined total balance of transactions on the PB visit.
- **PB_TOTAL_CHARGES**: The total charges on the PB visit.
- **PB_TOTAL_PAYMENTS**: The total payments on the PB visit.
- **PB_TOTAL_ADJ**: Contains total adjustments on the PB visit.
- **PB_INS_BALANCE**: Contains insurance balance on the PB visit.
- **PB_UND_BALANCE**: Contains undistributed balances on the PB visit.
- **PB_SELFPAY_BALANCE**: Contains the self-pay balance on the Professional Billing visit.
- **PB_BAD_DEBT_BALANCE**: Contains the bad debt balance on the Professional Billing visit.
- **REC_CREATE_USER_ID**: The user who created the Professional Billing visit record.
- **REC_CREATE_USER_ID_NAME**: The name of the user record. This name may be hidden.
- **FIRST_PB_CHG_TX_ID**: Contains the first valid Professional Billing charge on the Professional Billing visit.
- **BAL_FULL_SELF_PAY_YN**: This item shows whether the balances for this hospital account are in full self-pay.

### ARPB_TX_ACTIONS
**Table**: This table contains information about actions performed on professional billing transactions.
- **TX_ID**: The unique key or identification number for a given transaction.
- **LINE**: This column contains the line count for the information in this table. Each action associated with this transaction is stored on a separate line, one line for each entry.
- **ACTION_TYPE_C_NAME**: The action type category ID taken on the transaction.
- **ACTION_DATE**: The date in which this action is performed.
- **ACTION_AMOUNT**: The amount associated with this action.
- **PAYOR_ID**: The Payor associated with this action.
- **DENIAL_CODE**: The denial code associated with this action.
- **DENIAL_CODE_REMIT_CODE_NAME**: The name of each remittance code.
- **POST_DATE**: The date this transaction was posted in calendar format.
- **STMT_DATE**: The statement date of this transaction.
- **OUT_AMOUNT_BEFORE**: Outstanding amount of associated transaction before the action is performed.
- **OUT_AMOUNT_AFTER**: Outstanding amount of the associated transaction after the action is performed.
- **INS_AMOUNT_BEFORE**: Insurance amount of the associated transaction before the action is performed.
- **INS_AMOUNT_AFTER**: Insurance amount of the associated transaction after the action is performed.
- **BEFORE_PAYOR_ID**: The Payor of the associated transaction before the action is performed.
- **AFTER_PAYOR_ID**: The Payor of the associated transaction after the action is performed.
- **BEFORE_CVG_ID**: The coverage of the associated transaction before the action is performed.
- **AFTER_CVG_ID**: The coverage of the associated transaction after the action is performed.
- **ACTION_USER_ID**: The unique ID of the user who performed this action.
- **ACTION_USER_ID_NAME**: The name of the user record. This name may be hidden.
- **ADJ_CODE_ID**: If an adjustment is associated with this action, this column contains the adjustment code of that adjustment.
- **RMC_ID**: The first reason code ID associated with this action.
- **RMC_ID_REMIT_CODE_NAME**: The name of each remittance code.
- **RMC_TWO_ID**: The second reason code�ID associated with this action.
- **RMC_TWO_ID_REMIT_CODE_NAME**: The name of each remittance code.
- **RMC_THREE_ID**: The third reason code ID associated with this action.
- **RMC_THREE_ID_REMIT_CODE_NAME**: The name of each remittance code.
- **RMC_FOUR_ID**: The fourth reason code ID associated with this action.
- **RMC_FOUR_ID_REMIT_CODE_NAME**: The name of each remittance code.
- **PMT_PAYOR_ID**: The Payor of the payment if this action is associated with a payment.
- **POS_ID**: Place of Service ID of the transaction.
- **DEPARTMENT_ID**: Department ID of this transaction.
- **PROC_ID**: The procedure ID for the transaction record.
- **LOCATION_ID**: Location Id for this transaction
- **SERVICE_AREA_ID**: Service Area ID for this transaction
- **ACCOUNT_ID**: The internal ID of the record that maintains the patient's transactions. A patient may use more than one account and an account may contain more than one patient.
- **PRIMARY_DX_ID**: Primary Diagnosis code for this charge.
- **MODIFIER_ONE**: The first procedure modifier of the associated transaction. This is the external modifier, as it would be printed on the claim.
- **MODIFIER_TWO**: The second procedure modifier of the associated transaction. This is the external modifier, as it would be printed on the claim.
- **MODIFIER_THREE**: The third modifier of the associated transaction. This is the external modifier, as it would be printed on the claim.
- **MODIFIER_FOUR**: The fourth modifier of the associated transaction. This is the external modifier, as it would be printed on the claim.
- **ASSIGNMENT_BEF_YN**: This item is a Yes/No flag to determine if the transaction was assigned to insurance before the action on this line for this transaction.
- **ASSIGNMENT_AFTER_YN**: This item is a Yes/No flag to determine if the transaction was assigned to insurance after the action on this line for this transaction.
- **ACTION_REMIT_CODES**: This field stores a comma delimited list of external remittance codes for this transaction.
- **ACTION_COMMENT**: This is the system generated comment for this transaction.
- **ACTION_DATETIME**: The UTC date and time the action was performed.

### CLARITY_EPM
**Table**: The CLARITY_EPM table contains information about payer records.
- **PAYOR_ID**: The unique ID assigned to the payor.
- **PAYOR_NAME**: The name of the payor.

## Sample Data (one representative non-null value per column)

### ARPB_TRANSACTIONS
- TX_ID = `129124216`
- POST_DATE = `10/12/2023 12:00:00 AM`
- SERVICE_DATE = `9/28/2023 12:00:00 AM`
- TX_TYPE_C_NAME = `Charge`
- ACCOUNT_ID = `1810018166`
- DEBIT_CREDIT_FLAG_NAME = `Debit`
- SERV_PROVIDER_ID = `144590`
- BILLING_PROV_ID = `144590`
- DEPARTMENT_ID = `1700801002`
- POS_ID = `1700801`
- LOC_ID = `1700801`
- SERVICE_AREA_ID = `18`
- MODIFIER_ONE = `25`
- PRIMARY_DX_ID = `514181`
- DX_TWO_ID = `462313`
- DX_THREE_ID = `463037`
- DX_FOUR_ID = `509172`
- PROCEDURE_QUANTITY = `1`
- AMOUNT = `330`
- OUTSTANDING_AMT = `0`
- INSURANCE_AMT = `0`
- PATIENT_AMT = `0`
- VOID_DATE = `12/20/2022 12:00:00 AM`
- LAST_ACTION_DATE = `10/23/2023 12:00:00 AM`
- PROV_SPECIALTY_C_NAME = `Internal Medicine`
- PROC_ID = `23870`
- TOTAL_MATCH_AMT = `-330`
- TOTAL_MTCH_INS_AMT = `-330`
- TOTAL_MTCH_ADJ = `-106.58`
- TOTAL_MTCH_INS_ADJ = `-106.58`
- REPOST_ETR_ID = `315026147`
- REPOST_TYPE_C_NAME = `Correction`
- ENC_FORM_NUM = `76294046`
- BEN_SELF_PAY_AMT = `0`
- BEN_ADJ_COPAY_AMT = `0`
- VISIT_NUMBER = `10`
- ORIGINAL_EPM_ID = `1302`
- ORIGINAL_FC_C_NAME = `Blue Cross`
- ORIGINAL_CVG_ID = `5934765`
- PAYOR_ID = `1302`
- COVERAGE_ID = `5934765`
- ASGN_YN = `Y`
- FACILITY_ID = `1`
- PAYMENT_SOURCE_C_NAME = `Electronic Funds Transfer`
- USER_ID = `RAMMELZL`
- USER_ID_NAME = `RAMMELKAMP, ZOE L`
- NOT_BILL_INS_YN = `N`
- CHG_ROUTER_SRC_ID = `774135624`
- BILL_AREA_ID = `9`
- BILL_AREA_ID_BILL_AREA_NAME = `Associated Physicians Madison Wisconsin`
- CREDIT_SRC_MODULE_C_NAME = `Electronic Remittance`
- UPDATE_DATE = `10/23/2023 3:06:00 PM`
- CLAIM_DATE = `10/13/2023 12:00:00 AM`
- IPP_INV_NUMBER = `L1007201490`
- IPP_INV_ID = `58319567`

### ARPB_VISITS
- PB_VISIT_ID = `4307315`
- PB_BILLING_STATUS_C_NAME = `Closed`
- PB_FO_OVRRD_ST_C_NAME = `Matches the default`
- PB_FO_MSPQ_STATE_C_NAME = `MSPQ does not apply`
- PB_VISIT_NUM = `7`
- PRIM_ENC_CSN_ID = `958147754`
- GUARANTOR_ID = `1810018166`
- COVERAGE_ID = `5934765`
- SELF_PAY_YN = `N`
- DO_NOT_BILL_INS_YN = `N`
- ACCT_FIN_CLASS_C_NAME = `Blue Cross`
- SERV_AREA_ID = `18`
- REVENUE_LOCATION_ID = `1700801`
- DEPARTMENT_ID = `1700801005`
- PB_TOTAL_BALANCE = `0`
- PB_TOTAL_CHARGES = `173`
- PB_TOTAL_PAYMENTS = `-8.4`
- PB_TOTAL_ADJ = `-164.6`
- PB_INS_BALANCE = `0`
- PB_SELFPAY_BALANCE = `0`
- REC_CREATE_USER_ID = `PAM400`
- REC_CREATE_USER_ID_NAME = `MANIX, PATRICIA A`
- FIRST_PB_CHG_TX_ID = `302968774`
- BAL_FULL_SELF_PAY_YN = `N`

### ARPB_TX_ACTIONS
- TX_ID = `129124216`
- LINE = `1`
- ACTION_TYPE_C_NAME = `Recalculate Discount`
- ACTION_DATE = `10/4/2022 12:00:00 AM`
- ACTION_AMOUNT = `0`
- PAYOR_ID = `1302`
- DENIAL_CODE = `2`
- DENIAL_CODE_REMIT_CODE_NAME = `2-COINSURANCE AMOUNT`
- POST_DATE = `10/4/2022 12:00:00 AM`
- STMT_DATE = `1/29/2020 12:00:00 AM`
- OUT_AMOUNT_BEFORE = `0`
- OUT_AMOUNT_AFTER = `6.99`
- INS_AMOUNT_BEFORE = `0`
- INS_AMOUNT_AFTER = `0`
- BEFORE_PAYOR_ID = `0`
- AFTER_PAYOR_ID = `0`
- BEFORE_CVG_ID = `5934765`
- AFTER_CVG_ID = `5934765`
- ACTION_USER_ID = `1`
- ACTION_USER_ID_NAME = `EPIC, USER`
- ADJ_CODE_ID = `10226`
- RMC_ID = `6063`
- RMC_ID_REMIT_CODE_NAME = `MA63 INCMPL/INV PRINCIPAL DX.`
- PMT_PAYOR_ID = `1302`
- POS_ID = `1700801`
- DEPARTMENT_ID = `1700801002`
- PROC_ID = `23660`
- LOCATION_ID = `1700801`
- SERVICE_AREA_ID = `18`
- ACCOUNT_ID = `1810018166`
- PRIMARY_DX_ID = `462313`
- MODIFIER_ONE = `25`
- ASSIGNMENT_BEF_YN = `Y`
- ASSIGNMENT_AFTER_YN = `N`
- ACTION_REMIT_CODES = `2`
- ACTION_DATETIME = `10/4/2022 3:37:00 PM`

### CLARITY_EPM
- PAYOR_ID = `1302`
- PAYOR_NAME = `BLUE CROSS OF WISCONSIN`

## Pipeline Code

### Stage 1: SQL Projection (project.ts → raw JSON)
```typescript
function projectBilling(patId: unknown): EpicRow {
  // Billing tables link to patient via various chains:
  // ARPB_TRANSACTIONS → ACCOUNT_ID → ACCT_GUAR_PAT_INFO.PAT_ID
  // ARPB_VISITS → PRIM_ENC_CSN_ID → PAT_ENC.PAT_ID
  // HSP_ACCOUNT → encounters
  // ACCOUNT → ACCT_GUAR_PAT_INFO.PAT_ID

  // Get patient's account IDs via bridge table
  const patAccountIds = tableExists("ACCT_GUAR_PAT_INFO")
    ? q(`SELECT ACCOUNT_ID FROM ACCT_GUAR_PAT_INFO WHERE PAT_ID = ?`, [patId]).map(r => r.ACCOUNT_ID)
    : [];

  // Get patient's encounter CSNs
  const patCSNs = q(`SELECT PAT_ENC_CSN_ID FROM PAT_ENC WHERE PAT_ID = ?`, [patId]).map(r => r.PAT_ENC_CSN_ID);

  // Transactions — via account chain
  let txRows: EpicRow[];
  if (patAccountIds.length > 0 && tableExists("ARPB_TRANSACTIONS")) {
    const placeholders = patAccountIds.map(() => "?").join(",");
    txRows = mergeQuery("ARPB_TRANSACTIONS", `b."ACCOUNT_ID" IN (${placeholders})`, patAccountIds);
  } else {
    txRows = mergeQuery("ARPB_TRANSACTIONS");
  }
  for (const tx of txRows) {
    attachChildren(tx, tx.TX_ID, txChildren);
    tx._procedure_name = lookupName("CLARITY_EAP", "PROC_ID", "PROC_NAME", tx.PROCEDURE_ID);
  }

  // Visits — via encounter CSN chain
  let visits: EpicRow[];
  if (patCSNs.length > 0 && tableExists("ARPB_VISITS")) {
    const csnPlaceholders = patCSNs.map(() => "?").join(",");
    visits = q(`SELECT * FROM ARPB_VISITS WHERE PRIM_ENC_CSN_ID IN (${csnPlaceholders})`, patCSNs);
  } else {
    visits = tableExists("ARPB_VISITS") ? q(`SELECT * FROM ARPB_VISITS`) : [];
  }

  // Hospital accounts — via HAR_ALL bridge (ACCT_ID → HSP_ACCOUNT_ID, PAT_ID for filter)
  let hars: EpicRow[];
  if (tableExists("HAR_ALL") && tableExists("HSP_ACCOUNT")) {
    const harAcctIds = q(`SELECT ACCT_ID FROM HAR_ALL WHERE PAT_ID = ?`, [patId]).map(r => r.ACCT_ID);
    if (harAcctIds.length > 0) {
      const placeholders = harAcctIds.map(() => "?").join(",");
      hars = mergeQuery("HSP_ACCOUNT", `b."HSP_ACCOUNT_ID" IN (${placeholders})`, harAcctIds);
    } else {
      hars = [];
    }
  } else {
    hars = mergeQuery("HSP_ACCOUNT");
  }
  for (const har of hars) {
    attachChildren(har, har.HSP_ACCOUNT_ID, harChildren);
    // Claim prints have their own children keyed on CLAIM_PRINT_ID
    for (const clp of (har.claim_prints as EpicRow[] ?? [])) {
      const clpId = clp.CLAIM_PRINT_ID;
      if (tableExists("HSP_CLP_REV_CODE")) clp.rev_codes = children("HSP_CLP_REV_CODE", "CLAIM_PRINT_ID", clpId);
      if (tableExists("HSP_CLP_CMS_LINE")) clp.cms_lines = children("HSP_CLP_CMS_LINE", "CLAIM_PRINT_ID", clpId);
      if (tableExists("HSP_CLP_DIAGNOSIS")) clp.diagnoses = children("HSP_CLP_DIAGNOSIS", "CLAIM_PRINT_ID", clpId);
      if (tableExists("HSP_CLAIM_DETAIL1")) clp.detail_1 = children("HSP_CLAIM_DETAIL1", "CLAIM_PRINT_ID", clpId);
      if (tableExists("HSP_CLAIM_DETAIL2")) clp.detail_2 = children("HSP_CLAIM_DETAIL2", "CLAIM_PRINT_ID", clpId);
      if (tableExists("HSP_CLP_CMS_TX_PIECES")) clp.cms_tx_pieces = children("HSP_CLP_CMS_TX_PIECES", "CLAIM_PRINT_ID", clpId);
      if (tableExists("HSP_CLP_UB_TX_PIECES")) clp.ub_tx_pieces = children("HSP_CLP_UB_TX_PIECES", "CLAIM_PRINT_ID", clpId);
      if (tableExists("CLP_NON_GRP_TX_IDS")) clp.non_group_tx = children("CLP_NON_GRP_TX_IDS", "CLAIM_PRINT_ID", clpId);
      if (tableExists("CLP_OCCUR_DATA")) clp.occurrence_data = children("CLP_OCCUR_DATA", "CLAIM_PRINT_ID", clpId);
    }
  }

  // Guarantor accounts — via ACCT_GUAR_PAT_INFO bridge
  let accts: EpicRow[];
  if (patAccountIds.length > 0) {
    const placeholders = patAccountIds.map(() => "?").join(",");
    accts = mergeQuery("ACCOUNT", `b."ACCOUNT_ID" IN (${placeholders})`, patAccountIds);
  } else {
    accts = mergeQuery("ACCOUNT");
  }
  for (const acct of accts) {
    attachChildren(acct, acct.ACCOUNT_ID, acctChildren);
  }

  // Remittances
  const remits = q(`SELECT * FROM CL_REMIT`).concat(
    tableExists("CL_REMIT") ? [] : []
  );
  for (const r of remits) {
    attachChildren(r, r.IMAGE_ID, remitChildren);
  }

  // Claims
  const claims = mergeQuery("CLM_VALUES");
  for (const c of claims) {
    attachChildren(c, c.RECORD_ID, claimChildren);
  }

  // Invoices
  const invoices = tableExists("INVOICE")
    ? q(`SELECT * FROM INVOICE WHERE PAT_ID = ?`, [patId])
    : [];
  for (const inv of invoices) {
    if (tableExists("INV_BASIC_INFO")) inv.basic_info = children("INV_BASIC_INFO", "INV_ID", inv.INVOICE_ID);
    if (tableExists("INV_TX_PIECES")) inv.tx_pieces = children("INV_TX_PIECES", "INV_ID", inv.INVOICE_ID);
    if (tableExists("INV_NUM_TX_PIECES")) inv.num_tx_pieces = children("INV_NUM_TX_PIECES", "INV_ID", inv.INVOICE_ID);
    if (tableExists("INV_CLM_LN_ADDL")) inv.claim_line_addl = children("INV_CLM_LN_ADDL", "INVOICE_ID", inv.INVOICE_ID);
    if (tableExists("INV_DX_INFO")) inv.diagnoses = children("INV_DX_INFO", "INVOICE_ID", inv.INVOICE_ID);
    if (tableExists("INV_PMT_RECOUP")) inv.payment_recoup = children("INV_PMT_RECOUP", "INVOICE_ID", inv.INVOICE_ID);
  }

  return {
    transactions: txRows,
    visits,
    hospital_accounts: hars,
    guarantor_accounts: accts,
    remittances: remits,
    claims,
    invoices,
  };
}
```

### Stage 2: Domain Model Hydration (PatientRecord.ts)
```typescript
export class BillingTransaction {
  TX_ID: EpicID;
  txType?: string;
  amount?: number;
  postDate?: string;
  serviceDate?: string;
  ACCOUNT_ID?: EpicID;
  VISIT_NUMBER?: EpicID;
  actions: EpicRow[] = [];
  chargeDiagnoses: EpicRow[] = [];
  eobInfo: EpicRow[] = [];

  constructor(raw: EpicRow) {
    Object.assign(this, raw);
    this.TX_ID = raw.TX_ID as EpicID;
    this.txType = raw.TX_TYPE_C_NAME as string;
    this.amount = raw.AMOUNT as number;
    this.postDate = raw.POST_DATE as string;
    this.serviceDate = raw.SERVICE_DATE as string;
    this.ACCOUNT_ID = raw.ACCOUNT_ID as EpicID;
    this.VISIT_NUMBER = raw.VISIT_NUMBER as EpicID;
    for (const key of ['arpb_tx_actions', 'arpb_chg_entry_dx', 'tx_diag',
      'pmt_eob_info_i', 'pmt_eob_info_ii']) {
      const arr = raw[key] as EpicRow[] | undefined;
      if (arr?.length) {
        if (key.includes('action')) this.actions = arr;
        else if (key.includes('dx') || key.includes('diag')) this.chargeDiagnoses.push(...arr);
        else if (key.includes('eob')) this.eobInfo.push(...arr);
      }
    }
  }
}

export class BillingVisit {
  PRIM_ENC_CSN_ID?: CSN;
  totalCharges?: number;
  totalPayments?: number;
  totalAdjustments?: number;
  balance?: number;

  constructor(raw: EpicRow) {
    Object.assign(this, raw);
    this.PRIM_ENC_CSN_ID = raw.PRIM_ENC_CSN_ID as CSN;
    this.totalCharges = raw.PB_TOTAL_CHARGES as number;
    this.totalPayments = raw.PB_TOTAL_PAYMENTS as number;
    this.totalAdjustments = raw.PB_TOTAL_ADJUSTMENTS as number;
    this.balance = raw.PB_BALANCE as number;
  }

  encounter(record: PatientRecordRef): Encounter | undefined {
    return this.PRIM_ENC_CSN_ID ? record.encounterByCSN(this.PRIM_ENC_CSN_ID) : undefined;
  }

  transactions(record: PatientRecordRef): BillingTransaction[] {
    return record.billing.transactions.filter(
      tx => tx.VISIT_NUMBER === (this as EpicRow).PB_VISIT_ID
    );
  }
}
```

### Stage 3: Clean Projection (HealthRecord.ts → final output)
```typescript
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
{
  "charges": [
    {
      "id": "355871699",
      "date": "2023-09-28",
      "service": "23870",
      "amount": 330,
      "visitId": "10",
      "_epic": {
        "TX_ID": 355871699,
        "txType": "Charge",
        "amount": 330,
        "postDate": "10/12/2023 12:00:00 AM",
        "serviceDate": "9/28/2023 12:00:00 AM",
        "ACCOUNT_ID": 1810018166,
        "VISIT_NUMBER": "10",
        "POST_DATE": "10/12/2023 12:00:00 AM",
        "SERVICE_DATE": "9/28/2023 12:00:00 AM",
        "TX_TYPE_C_NAME": "Charge",
        "DEBIT_CREDIT_FLAG_NAME": "Debit",
        "SERV_PROVIDER_ID": "144590",
        "BILLING_PROV_ID": "144590",
        "DEPARTMENT_ID": 1700801002,
        "POS_ID": 1700801,
        "LOC_ID": 1700801,
        "SERVICE_AREA_ID": 18,
        "MODIFIER_ONE": "25",
        "PRIMARY_DX_ID": 514181,
        "DX_TWO_ID": 462313,
        "PROCEDURE_QUANTITY": 1,
        "AMOUNT": 330,
        "OUTSTANDING_AMT": 0,
        "INSURANCE_AMT": 0,
        "PATIENT_AMT": 0,
        "LAST_ACTION_DATE": "10/23/2023 12:00:00 AM",
        "PROV_SPECIALTY_C_NAME": "Internal Medicine",
        "PROC_ID": 23870,
        "TOTAL_MATCH_AMT": -330,
        "TOTAL_MTCH_INS_AMT": -330,
        "TOTAL_MTCH_ADJ": -106.58,
        "TOTAL_MTCH_INS_ADJ": -106.58,
        "ENC_FORM_NUM": "76294046",
        "BEN_SELF_PAY_AMT": 0,
        "BEN_ADJ_COPAY_AMT": 0,
        "ORIGINAL_EPM_ID": 1302,
        "ORIGINAL_FC_C_NAME": "Blue Cross",
        "ORIGINAL_CVG_ID": 5934765,
        "PAYOR_ID": 1302,
        "COVERAGE_ID": 5934765,
        "ASGN_YN": "Y",
        "FACILITY_ID": 1,
        "USER_ID": "RAMMELZL",
        "USER_ID_NAME": "RAMMELKAMP, ZOE L",
        "NOT_BILL_INS_YN": "N",
        "CHG_ROUTER_SRC_ID": "774135624",
        "BILL_AREA_ID": 9,
        "BILL_AREA_ID_BILL_AREA_NAME": "Associated Physicians Madison Wisconsin",
        "UPDATE_DATE": "10/23/2023 3:06:00 PM",
        "CLAIM_DATE": "10/13/2023 12:00:00 AM",
        "VST_DO_NOT_BIL_I_YN": "N",
        "OUTST_CLM_STAT_C_NAME": "Not Outstanding",
        "PROV_NETWORK_STAT_C_NAME": "In Network",
        "NETWORK_LEVEL_C_NAME": "Blue",
        "MANUAL_PRICE_OVRIDE_YN": "N",
        "FIRST_ETR_TX_ID": 355871699,
        "POSTING_DEPARTMENT_ID": 1700801002,
        "EXP_REIMB_SRC_C_NAME": "System Calculated",
        "PRIM_TIMELY_FILE_DEADLINE_DATE": "3/26/2024 12:00:00 AM"
      }
    },
    {
      "id": "302543307",
      "date": "2022-08-29",
      "service": "23660",
      "amount": 222,
      "visitId": "6",
      "_epic": {
        "TX_ID": 302543307,
        "txType": "Charge",
        "amount": 222,
        "postDate": "9/20/2022 12:00:00 AM",
        "serviceDate": "8/29/2022 12:00:00 AM",
        "ACCOUNT_ID": 1810018166,
        "VISIT_NUMBER": "6",
        "POST_DATE": "9/20/2022 12:00:00 AM",
        "SERVICE_DATE": "8/29/2022 12:00:00 AM",
        "TX_TYPE_C_NAME": "Charge",
        "DEBIT_CREDIT_FLAG_NAME": "Debit",
        "SERV_PROVIDER_ID": "144590",
        "BILLING_P
```

## Instructions

1. Read every column's Epic schema description carefully.
2. Trace each column from the SQL query through PatientRecord hydration to HealthRecord output.
3. For each field in the output, verify: is the source column correct for what this field claims to represent?
4. For each column in the sample data that has a value, verify: is it read by the code? If not, should it be?
5. Check property name continuity across the three stages — does stage 3 read the property that stage 2 wrote?
6. Check for nondeterminism in queries and aggregations.

Report your findings as a structured list of issues. If you find zero issues, say so explicitly.