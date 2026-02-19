# Follow the Money: Epic's Billing Data Model from the Inside Out

This document traces actual dollars through Epic's billing system using real transaction data from a single patient's record. Every number is queryable.

## 1. Follow the Money: A $330 Office Visit

On September 28, 2023, a patient sees their doctor. The visit is coded as CPT 99396:25 (preventive visit with modifier). Epic posts charge `355871699` on October 12:

```
ARPB_TRANSACTIONS (TX_ID = 355871699)
  TX_TYPE_C_NAME:  Charge
  AMOUNT:          $330.00      ← what the provider bills
  PROC_ID:         23870        ← internal procedure ID
  PAYOR_ID:        1302         ← Blue Cross
  COVERAGE_ID:     5934765
  OUTSTANDING_AMT: $0.00        ← fully resolved (we're looking at final state)
```

The claim goes out October 13 (invoice `L1008016200`). Ten days later, the 835 remittance arrives. Here's where the money splits:

```
Remittance (CL_REMIT, IMAGE_ID = 229308484)
 └─ Claim-level (CL_RMT_CLM_INFO):
      CLAIM_CHRG_AMT:  $330.00    ← what was billed
      CLAIM_PAID_AMT:  $223.42    ← what Blue Cross pays
      CLM_STAT_CD:     Processed as Primary
      ICN_NO:          2023286CD3233
 └─ Service line (CL_RMT_SVCE_LN_INF, LINE 1):
      LINE_ITEM_CHG_AMT:  $330.00
      PROV_PAYMENT_AMT:   $223.42
      PROC_IDENTIFIER:    HC:99396:25
 └─ Adjustment (CL_RMT_SVC_LVL_ADJ, LINE 1):
      SVC_CAS_GRP_CODE:   Contractual Obligation
      SVC_ADJ_REASON_CD:  45         ← "Charges exceed fee schedule"
      SVC_ADJ_AMT:        $106.58
```

**The accounting identity for every charge:**

```
Billed ($330) = Paid ($223.42) + Contractual Write-off ($106.58) + Patient Owes ($0)
```

Epic auto-posts two matching transactions from the remittance:

| TX_ID | Type | Amount | Source | PROC_ID |
|---|---|---|---|---|
| 357218465 | Payment | −$223.42 | Electronic Funds Transfer | 7080 |
| 357218470 | Adjustment | −$106.58 | Electronic Remittance | 10226 |

These are linked to the charge via `ARPB_TX_MATCH_HX`:

```sql
SELECT MTCH_TX_HX_ID, MTCH_TX_HX_AMT FROM ARPB_TX_MATCH_HX WHERE TX_ID = 355871699;
-- 357218465  →  $223.42  (payment)
-- 357218470  →  $106.58  (adjustment)
```

The charge's running totals confirm resolution:

```
AMOUNT:           $330.00
TOTAL_MATCH_AMT: −$330.00   (sum of all matched credits)
TOTAL_MTCH_ADJ:  −$106.58   (of which this much was adjustment)
OUTSTANDING_AMT:  $0.00     = AMOUNT + TOTAL_MATCH_AMT
```

**The fundamental equation**: `OUTSTANDING_AMT = AMOUNT + TOTAL_MATCH_AMT` (where TOTAL_MATCH_AMT is negative for credits). When this hits zero, the charge is resolved.

## 2. Two Parallel Worlds

Epic runs two completely separate billing engines. They share a patient but almost nothing else.

### Professional Billing (ARPB) — "The Office"

This patient has **18 charges across 7 encounters**, all on guarantor account `1810018166`. Every charge, payment, and adjustment is a row in `ARPB_TRANSACTIONS`. The `TX_TYPE_C_NAME` distinguishes them:

| TX_TYPE | Count | Net Amount | What it is |
|---|---|---|---|
| Charge | 18 | +$3,179.00 | Services rendered |
| Payment | 17 | −$1,589.53 | Insurance/patient payments |
| Adjustment | 17 | −$1,589.47 | Contractual write-offs |
| **Total** | **52** | **$0.00** | **All charges resolved** |

Charges are positive. Payments and adjustments are negative. Everything nets to zero.

Each charge belongs to an `ACCOUNT_ID` (the guarantor account) and a `PAT_ENC_CSN_ID` (the encounter). Claims are grouped into invoices (`INVOICE`, linked via `INV_TX_PIECES`), and invoices belong to a `BILL_AREA_ID`.

### Hospital Billing (HSP) — "The Facility"

This patient also has one **inpatient/therapy series** account (`HSP_ACCOUNT_ID = 376684810`), classified as "Therapies Series" with Blue Cross as financial class. It tracks 10 transactions:

```sql
SELECT TX_TYPE_HA_C_NAME, COUNT(*), SUM(TX_AMOUNT)
FROM HSP_TRANSACTIONS WHERE HSP_ACCOUNT_ID = 376684810
GROUP BY TX_TYPE_HA_C_NAME;
```

| TX_TYPE | Count | Sum | Purpose |
|---|---|---|---|
| Charge | 3 | +$1,638.82 | Facility charges |
| Payment | 2 | −$676.00 | Ins $121.73 + patient $554.27 |
| Credit Adjustment | 3 | −$3,155.91 | Write-offs + bucket moves |
| Debit Adjustment | 2 | +$2,193.09 | Bucket moves (offsetting) |
| **Net** | **10** | **$0.00** | **Account zeroed** |

Hospital billing uses **buckets** (`BUCKET_ID`) to partition balances by financial class. When Blue Cross adjudicates, the money moves between buckets:

```
Original (bucket 464352999): $1,638.82 in charges → zeroed via system adjustment
Insurance (bucket 464353002): receives charges → pays $121.73, writes off $962.82
Self-Pay  (bucket 464353000): receives $554.27 patient responsibility → paid $554.27
```

The payment on bucket `464353002` carries the adjudication detail:

```
HSP_TRANSACTIONS (TX_ID = 681354876):
  TX_AMOUNT:         −$121.73
  ALLOWED_AMOUNT:     $676.00    ← contract rate
  BILLED_AMOUNT:      $1,638.82
  DEDUCTIBLE_AMOUNT:  $554.27    ← patient's deductible
  COINSURANCE_AMOUNT: $0
  COPAY_AMOUNT:       $0
```

**The hospital math**: Billed ($1,638.82) = Allowed ($676.00) + Contractual ($962.82). Of the allowed amount: Insurance pays $121.73, patient deductible = $554.27. Check: $121.73 + $554.27 = $676.00 ✓

## 3. When Things Go Wrong: The $315 Denial

Charge `315026147` — a $315 professional visit posted December 6, 2022 — gets denied.

**Step 1: Denial arrives** (December 20)

`ARPB_TX_ACTIONS` records two rows: Denied (CARC 16 — "Lacks information needed for adjudication") and Research (RARC MA63 — "Incomplete/invalid principal diagnosis").

Epic creates two `BDC_INFO` records to track follow-up. BDC_ID `43401924`: "DENIAL RECORD FOR CHARGE 315026147", remit code 16, group=Contractual Obligation, status=Completed, resolve reason="PB Charges Reposted".

**Step 2: Void and correct** (December 20, same day)

Billing staff HIRZY, HEIDI L voids the original via `ARPB_TX_VOID`: REPOST_TYPE=Correction. The charge gets `VOID_DATE = 12/20/2022` on `ARPB_TRANSACTIONS`.

**Step 3: Repost with corrected diagnosis** (December 20)

New charge `317236398` is posted for the same $315, same procedure (PROC_ID 23662). The linkage:

```
Original: TX_ID 315026147, VOID_DATE = 12/20/2022, REPOST_TYPE = 'Correction'
Replacement: TX_ID 317236398, REPOST_ETR_ID = 315026147  ← points back
```

**Step 4: Resubmit and adjudicate** (January 10, 2023)

The replacement claim processes. The action trail on `ARPB_TX_ACTIONS` shows 7 steps: resubmit → (second denial, CARC 16 again) → research (MA63) → not-allowed adjustment ($116.09, CARC 45) → next responsible party ($19.89, CARC 2 = coinsurance) → recalculate.

Final resolution: insurance pays $179.02, writes off $116.09, patient owes $19.89 coinsurance.

```
TX_ID 317236398:
  AMOUNT:          $315.00
  TOTAL_MATCH_AMT: −$315.00
  TOTAL_MTCH_ADJ:  −$116.09   (contractual)
  PATIENT_AMT:     $0.00      (patient paid the $19.89)
```

The patient's $19.89 was collected on January 24, 2023 (TX_ID `321705114`, payment type 7084 — patient payment).

## 4. The Ledger: How Epic Tracks Balances

Every `ARPB_TRANSACTIONS` charge row maintains a running ledger:

| Column | Meaning | Example (TX 355871699) |
|---|---|---|
| `AMOUNT` | Original charge amount | $330.00 |
| `OUTSTANDING_AMT` | Current unpaid balance | $0.00 |
| `INSURANCE_AMT` | Portion pending with insurance | $0.00 |
| `PATIENT_AMT` | Portion the patient owes | $0.00 |
| `TOTAL_MATCH_AMT` | Sum of all matched payments + adjustments | −$330.00 |
| `TOTAL_MTCH_ADJ` | Of TOTAL_MATCH_AMT, how much was adjustments | −$106.58 |
| `TOTAL_MTCH_INS_AMT` | Matched amounts from insurance specifically | −$330.00 |
| `TOTAL_MTCH_INS_ADJ` | Of that, insurance-side adjustments | −$106.58 |

**Key equations:**

```
OUTSTANDING_AMT = AMOUNT + TOTAL_MATCH_AMT
INSURANCE_AMT + PATIENT_AMT ≈ OUTSTANDING_AMT  (when non-zero)
Insurance payment = TOTAL_MTCH_INS_AMT − TOTAL_MTCH_INS_ADJ
                  = (−330.00) − (−106.58) = −$223.42
```

The `ARPB_TX_ACTIONS` table records *every state transition*. Each row has `OUT_AMOUNT_BEFORE` and `OUT_AMOUNT_AFTER`, making it possible to reconstruct the balance at any point in time. For charge `355871699`, there's exactly one action:

```
ACTION_TYPE: Not Allowed Adjustment | AMOUNT: $106.58
BEFORE: $106.58 outstanding → AFTER: $0.00
```

The $223.42 payment was auto-matched (no separate action row needed — the match history covers it).

## 5. Claims and Remittances: The Electronic Exchange

The lifecycle of a claim uses four table families, mapped to X12 EDI transactions:

**Outbound (837):** `CLAIM_INFO` (header) → `INVOICE` → `INV_TX_PIECES` (charge linkage) → `RECONCILE_CLM` + `RECONCILE_CLAIM_STATUS` (status polling). For our $330 charge, RECONCILE_CLM `110539507` tracks invoice `L1008016200` through "Claim forwarded" → "Accepted for processing" on 10/13/2023.

**Inbound (835):** `CL_REMIT` (envelope) → `CL_RMT_CLM_INFO` (claim-level totals) → `CL_RMT_SVCE_LN_INF` (service lines, linked to charges via `SVC_LINE_CHG_PB_ID`) → `CL_RMT_SVC_LVL_ADJ` (CARC adjustments).

### The Posting Bridge: PMT_EOB_INFO

When Epic processes the remittance, it creates `PMT_EOB_INFO_I` and `_II` records on the *payment/adjustment* transactions (not the charge). For our $330 visit's payment (TX 357218465):

- **PMT_EOB_INFO_I**: CVD_AMT=$223.42, NONCVD_AMT=$106.58, PAID_AMT=$223.42, DED/COPAY/COINS=null
- **PMT_EOB_INFO_II**: AMOUNT=$106.58, EOB_CODES=45, WINNINGRMC="45-CHGS EXCD FEE SCH/MAX ALLOWABLE.", group=Contractual Obligation

## 6. The Patient's Bill

### Front Desk Collection

`FRONT_END_PMT_COLL_HX` records check-in/out collection events. On December 1, 2022, the system flagged $7.82 prior balance due (`PB_PREV_BAL_DUE`); the patient paid it at the desk (`PB_PREV_BAL_PAID = $7.82`), posting as TX_ID `314281735` (PROC_ID 7084 = patient payment).

### Statements

`GUAR_ACCT_STMT_HX` shows 4 paper statements sent to this guarantor. Each row captures new charges, running balance, and delivery method. Per-charge statement dates are in `ARPB_TX_STMT_DT`.

### Collections: The Hospital Side

When the $554.27 deductible goes unpaid on HSP account 376684810, `HSP_ACCT_CL_AG_HIS` shows: assigned to AVADYNE on 4/27/2022, withdrawn on 5/12/2022 after $554.27 collected. The payment posted as Self-Pay (TX `685171641`), zeroing the account (`ACCT_ZERO_BAL_DT = 5/11/2022`).

## 7. Table Reference

### Professional Billing (ARPB)

| Table | PK | Purpose |
|---|---|---|
| `ARPB_TRANSACTIONS` | TX_ID | Every charge (+), payment (−), adjustment (−). FKs: ACCOUNT_ID, PAT_ENC_CSN_ID, PAYOR_ID |
| `ARPB_TX_ACTIONS` | TX_ID+LINE | State changes: denials, adjustments, transfers. Has before/after balances |
| `ARPB_TX_MATCH_HX` | TX_ID+LINE | Links credits to charges. MTCH_TX_HX_ID → the payment/adj TX_ID |
| `ARPB_TX_VOID` | TX_ID | Void metadata: who, when, why. REPOSTED_ETR_ID links to replacement |
| `PMT_EOB_INFO_I` | TX_ID+LINE | On payment TXs: covered, non-covered, deductible, copay, coinsurance, paid |
| `PMT_EOB_INFO_II` | TX_ID+LINE | On payment TXs: per-adjustment CARC codes, group codes, amounts |
| `ARPB_TX_STMCLAIMHX` | TX_ID+LINE | Claim submit/pay dates per charge. Links to invoice number |
| `INVOICE` / `INV_TX_PIECES` | INVOICE_ID | Groups charges into billable invoices; TX_ID links to individual charges |
| `BDC_INFO` | BDC_ID | Denial follow-up records with remit codes and resolution reason |

### Hospital Billing (HSP)

| Table | PK | Purpose |
|---|---|---|
| `HSP_ACCOUNT` | HSP_ACCOUNT_ID | Account header: admit/discharge, DRG, billing status, collection agency |
| `HSP_TRANSACTIONS` | TX_ID | Charges/payments/adjustments with inline ALLOWED_AMOUNT, DEDUCTIBLE, COPAY |
| `HSP_BKT_*` | BUCKET_ID+LINE | Links payments/adjustments to their financial-class bucket |
| `HSP_ACCT_CL_AG_HIS` | HSP_ACCOUNT_ID+LINE | Collection agency assign/withdraw history |

### Remittance & Claims

| Table | PK | Purpose |
|---|---|---|
| `CL_REMIT` | IMAGE_ID | 835 envelope: payment method, trace, dates |
| `CL_RMT_CLM_INFO` | IMAGE_ID | Claim-level: billed, paid, patient resp, ICN, filing code |
| `CL_RMT_SVCE_LN_INF` | IMAGE_ID+LINE | Service lines: CPT, charged, paid. SVC_LINE_CHG_PB_ID → ARPB_TX |
| `CL_RMT_SVC_LVL_ADJ` | IMAGE_ID+LINE | Per-line CARC/RARC adjustments with CAS group codes |
| `RECONCILE_CLM` / `_STATUS` | CLAIM_REC_ID | Claim tracking + 276/277 status polling history |

### Benefits, Statements & Collection

| Table | PK | Purpose |
|---|---|---|
| `BENEFITS` / `SERVICE_BENEFITS` | RECORD_ID(+LINE) | Verification sessions: per-service-type copay, deductible, OOP details |
| `COVERAGE_BENEFITS` | RECORD_ID+LINE | Per-coverage verification (same financial fields) |
| `FRONT_END_PMT_COLL_HX` | CSN_ID+LINE | Check-in/out copay collection: due vs. paid |
| `GUAR_ACCT_STMT_HX` | ACCOUNT_ID+LINE | Statement history: dates, balances, delivery method |

## 8. What's Here That's Not in FHIR

FHIR's `ExplanationOfBenefit` resource covers the *what* of adjudication. Epic's data model covers the *how*, *when*, and *what happened next*. Specific gaps:

| Data Point | Epic Tables | FHIR Gap |
|---|---|---|
| **Line-item CARC/RARC codes** | `CL_RMT_SVC_LVL_ADJ`, `PMT_EOB_INFO_II` | No raw CARC/RARC with CAS group codes |
| **Contractual write-offs as transactions** | `ARPB_TX_ACTIONS`, `TOTAL_MTCH_ADJ` | Shows allowed amount but not the explicit write-off TX |
| **Denial→void→repost chain** | `ARPB_TX_VOID`, `REPOST_ETR_ID` | No charge correction lineage |
| **Collection agency records** | `HSP_ACCT_CL_AG_HIS`, `CL_COL_AGNCY` | No collections model |
| **Bucket-level hospital accounting** | `HSP_TRANSACTIONS.BUCKET_ID`, `HSP_BKT_*` | No insurance→self-pay balance transfer |
| **Benefit verification (126 rows)** | `SERVICE_BENEFITS` | No per-service-type deductible remaining/OOP met |
| **Claim status polling (91 rows)** | `RECONCILE_CLAIM_STATUS` | No claim lifecycle tracking |
| **Front desk collection workflow** | `FRONT_END_PMT_COLL_HX` | No point-of-service collection model |
| **Statement history** | `GUAR_ACCT_STMT_HX` | No patient billing statement model |
| **Payment→charge matching** | `ARPB_TX_MATCH_HX` | No visibility into which payment resolved which charge |

For a **patient financial transparency tool**, the critical path is: `ARPB_TRANSACTIONS` (what was charged) → `PMT_EOB_INFO_I` (what insurance allowed/paid) → `ARPB_TX_ACTIONS` (what was denied and why) → `GUAR_ACCT_STMT_HX` (what the patient was billed). The hospital equivalent runs through `HSP_TRANSACTIONS` (with inline allowed/deductible/copay fields) → `HSP_ACCT_CL_AG_HIS` (if it went to collections).
