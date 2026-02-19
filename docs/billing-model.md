# Epic Billing & Financial Data Model (Reverse-Engineered from EHI Export)

## 1. Overview

Epic's billing model tracks the full revenue cycle: from the moment a clinician's service
becomes a charge, through claim submission to insurance, payer adjudication, payment posting,
and patient collections. The data in this export covers one patient (Joshua C. Mandel, MRN
APL324672) across ~3 years of care at Associated Physicians LLP (NPI 1861412785) in Madison, WI,
with Blue Cross WI PPO/Federal (payer ID BCWI0, group 1000010) as primary coverage.

Epic splits billing into two parallel worlds: **Professional Billing (PB/ARPB)** for physician
services and **Hospital Billing (HB/HSP)** for facility/institutional charges. Each has its own
transaction tables, account structures, and claim pipelines, but they share a common guarantor
account (ACCOUNT), insurance coverage (COVERAGE), and encounter linkage (HAR_ALL). The 18
tables in this export capture $3,013 in professional charges across 11 visits and $1,638.82 in
hospital charges across 1 admission — enough to trace every stage of the revenue cycle.

The data also includes upstream eligibility verification (SERVICE_BENEFITS, 126 rows of copay/
deductible/coinsurance detail), the full claim pipeline (837 submission via CLM_VALUES, 276/277
status tracking via RECONCILE tables, 835 remittance via CL_REMIT), and downstream collections
(HSP_ACCT_CL_AG_HIS showing assignment to collection agency AVADYNE). This is far richer than
anything available through FHIR — it's the provider's complete financial ledger.

## 2. Entity Relationship Diagram

```
                    HAR_ALL (CSN ↔ accts)           COVERAGE ──► SERVICE_BENEFITS
                     │              │                (plan)     (126 rows: copay,
          ┌─────────┴────┐  ┌───────┴──────┐              deductible, OOP)
          │ ARPB_VISITS   │  │ HSP_ACCOUNT   │
          │ (PB visit/enc)│  │ (HB admission)│  ACCOUNT (guarantor)
          └─────┬────────┘  └────┬─────────┘  (balances, pmt plans)
   FIRST_PB_CHG_TX_ID│        HSP_ACCOUNT_ID│
          ┌─────▼────────┐  ┌────▼─────────┐
          │ARPB_TRANSACTIONS│  │HSP_TRANSACTIONS │  FRONT_END_PMT_COLL_HX
          │(52: chg/pmt/adj)│  │(10: chg/pmt/adj)│  (16 rows: copay collection)
          └┬────────┬───────┘  └─────────────────┘
           │ TX_ID  │                    HSP_ACCT_CL_AG_HIS
  ┌───────▼┐  ┌───▼─────┐              (collection agency)
  │ARPB_TX_│  │ARPB_TX_  │
  │ACTIONS │  │VOID     │  ┌─────────────────────────────────────┐
  │(36 rows)│  │(2 rows)  │  │ CLAIMS PIPELINE                        │
  └─────────┘  └──────────┘  │ CLM_VALUES (14) ──► 837P/837I          │
                              │ CLAIM_INFO (2)  ──► routing            │
                              │ RECONCILE_CLAIM_STATUS (91) 276/277  │
                              │ RECONCILE_CLM_OT (113)               │
                              │ CL_REMIT (14)   ◄── 835/ERA           │
                              │ PMT_EOB_INFO_I (19) EOB line items   │
                              └─────────────────────────────────────┘
```

## 3. Two Billing Worlds: Professional vs Hospital

| Aspect | Professional (ARPB) | Hospital (HSP) |
|---|---|---|
| **Core TX table** | `ARPB_TRANSACTIONS` (52 rows) | `HSP_TRANSACTIONS` (10 rows) |
| **Account level** | `ARPB_VISITS` (per-encounter) | `HSP_ACCOUNT` (per-admission) |
| **Guarantor** | `ACCOUNT.ACCOUNT_ID` = 1810018166 | `ACCOUNT.ACCOUNT_ID` = 4793998 |
| **Claim form** | CMS-1500 (BILL_TYP = "11") | UB-04 (institutional) |
| **TX types** | 18 charges, 17 payments, 17 adjustments | Mixed in 10 rows (charges, pmts, write-offs) |
| **Balance tracking** | Per-TX: `OUTSTANDING_AMT`, `TOTAL_MATCH_AMT` | Per-account: buckets (ins vs self-pay) |
| **Example** | $330 office visit → payer pays $223.42 | $1,638.82 OT series → payer pays $121.73 |
| **Void mechanism** | `ARPB_TX_VOID` (void + repost) | N/A in this dataset |
| **Collections** | `FRONT_END_PMT_COLL_HX` (copay at check-in) | `HSP_ACCT_CL_AG_HIS` (agency outsource) |

**PB** transactions are fine-grained: each charge, each payment, each adjustment is a separate
row with its own TX_ID. **HB** transactions pack more into each row — a single payment TX
includes allowed amount, deductible, coinsurance, and action codes ("1,2,4" = not-allowed +
next-responsible-party + specific action) as a comma-delimited string.

## 4. Transaction Lifecycle

### Clean Case: $330 Office Visit (TX 355871699)

```
1. CHARGE CREATED (ARPB_TRANSACTIONS)
   TX_ID: 355871699 | POST_DATE: 10/12/2023 | SERVICE_DATE: 9/28/2023
   PROC_ID: 23870 | AMOUNT: $330 | OUTSTANDING_AMT: $330
   Provider: 144590 | Dept: 1700801002 | Modifier: 25
   Entered by: RAMMELKAMP, ZOE L

2. CLAIM SUBMITTED (CLM_VALUES)
   837P filed to BCWI0 (Blue Cross WI PPO/Federal)
   Billing provider: ASSOCIATED PHYSICIANS LLP (NPI 1861412785, TIN 391837462)
   Invoice: L1008016200 | Total charge: $330 | Bill type: 11 (professional)

3. CLAIM STATUS TRACKED (RECONCILE_CLAIM_STATUS / RECONCILE_CLM_OT)
   276 inquiry → 277 response cycle monitors claim progress

4. ERA/835 RECEIVED (CL_REMIT + PMT_EOB_INFO_I)
   ICN: 2023286CD3233 (payer's claim control number)
   CVD_AMT: $223.42 | NONCVD_AMT: $106.58 | PAID_AMT: $223.42
   → Payer allowed $223.42 of $330; $106.58 exceeds fee schedule

5. PAYMENT POSTED (ARPB_TRANSACTIONS)
   TX_ID: 357218465 | TX_TYPE: Payment | AMOUNT: -$223.42
   Matched to charge 355871699 on 10/23/2023

6. ADJUSTMENT POSTED (ARPB_TRANSACTIONS + ARPB_TX_ACTIONS)
   TX_ID: 357218470 | TX_TYPE: Adjustment | AMOUNT: -$106.58
   Action: "Not Allowed Adjustment" | CARC 45: charges exceed fee schedule
   → This is the contractual write-off (provider can't bill patient for it)

7. CHARGE ZEROED OUT
   OUTSTANDING_AMT: $0 | TOTAL_MATCH_AMT: -$330
   ($223.42 payment + $106.58 adjustment = $330 original charge)
```

### Messy Case: Denied → Voided → Reposted (TX 315026147)

```
1. CHARGE CREATED: TX 315026147, $315, PROC_ID 23662, service date 12/1/2022

2. CLAIM DENIED (ARPB_TX_ACTIONS)
   Action: "Denied" | CARC 16: "Lacks information needed for adjudication"
   Research reason: MA63 "Incomplete/invalid principal diagnosis"
   EOB shows: PAID_AMT=$0, NONCVD_AMT=$315, ICN=2022341BT5497

3. CHARGE VOIDED (ARPB_TX_VOID)
   Voided by: HIRZY, HEIDI L on 12/20/2022
   REPOST_TYPE: "Correction" — not a true deletion, but a rebill

4. REPLACEMENT CHARGE CREATED
   TX 317236398 | Same $315, same PROC_ID 23662
   ARPB_TX_VOID links them: OLD_ETR_ID=315026147, REPOSTED_ETR_ID=315026147
   The voided charge stays in the ledger (OUTSTANDING_AMT=0, TOTAL_MATCH_AMT=0)

5. REPLACEMENT CLAIM SUBMITTED & PAID
   TX 317236398 eventually: OUTSTANDING_AMT=$0, TOTAL_MATCH_AMT=-$315
```

### Hospital Case: $1,638.82 Inpatient OT (HSP_ACCOUNT 376684810)

```
1. CHARGES FILED: $1,638.82 across OT service lines (Therapies Series)

2. INSURANCE PAYMENT (HSP_TRANSACTIONS TX 681354876)
   Method: Electronic Funds Transfer | ERA file: BCWI0_20220426_ERA07732296_ACH_ORIGINAL.835
   ALLOWED_AMOUNT: $676 | PAID: -$121.73
   DEDUCTIBLE: $554.27 | Remittance Run: 7526348

3. CONTRACTUAL WRITE-OFF (TX 681354878)
   AMOUNT: -$962.82 | Type: "Contractual Write-Off (Insurance)"
   = $1,638.82 billed - $676 allowed = $962.82 written off

4. BALANCE TRANSFER TO SELF-PAY (TX 681354880)
   Debit adjustment: $554.27 (patient owes the deductible)
   Credit adjustment: -$554.27 moves balance from insurance to self-pay bucket

5. SENT TO COLLECTIONS (HSP_ACCT_CL_AG_HIS)
   4/27/2022: Assigned to AVADYNE, balance $554.27, action "Outsource Account"

6. AGENCY PAYMENT (TX 685171641)
   5/11/2022: AVADYNE payment of -$554.27
   ACCT_ZERO_BAL_DT: 5/11/2022 — account fully resolved

7. AGENCY WITHDRAWN (HSP_ACCT_CL_AG_HIS)
   5/12/2022: AVADYNE withdrawn, balance $0, "Return from Outsource Agency"
```

## 5. The Claim Pipeline

```
  Provider System                  Clearinghouse            Payer
  ─────────────                    ─────────────            ─────
  ARPB_TRANSACTIONS ──┐
  (charge created)    │
                      ▼
                CLM_VALUES ──────► 837P/837I ──────────►  Adjudication
                (14 rows:                                      │
                 NPI, TIN,                                     │
                 dx, proc,         RECONCILE_CLM_OT            │
                 member ID)        (113 rows: file paths, ◄────┤ 276/277
                                    status messages)           │
                CLAIM_INFO                                     │
                (2 rows: injury                                │
                 date, accident     CL_REMIT ◄─────────────────┤ 835/ERA
                 type, routing)     (14 rows: remit files,     │
                                    ICN, service dates)        │
                                         │                     │
                                         ▼                     │
                                   PMT_EOB_INFO_I             │
                                   (19 rows: per-line          │
                                    CVD/NONCVD/DED/            │
                                    COPAY/COINS/PAID,          │
                                    CARC denial codes)         │
                                         │                     │
                                         ▼
                                   ARPB_TRANSACTIONS / HSP_TRANSACTIONS
                                   (payment + adjustment posted)
```

**Key identifiers through the pipeline:**
- **Invoice Number** (e.g., `L1008016200`): Epic's internal claim ID, appears in CLM_VALUES and PMT_EOB_INFO_I
- **ICN** (e.g., `2023286CD3233`): Payer's claim control number, returned on ERA, used for appeals
- **Claim Recon ID** (e.g., `42972138`): Links RECONCILE_CLAIM_STATUS to RECONCILE_CLM_OT
- **835 filename** (e.g., `BCWI0_20220426_ERA07732296_ACH_ORIGINAL.835`): Actual ERA file reference

## 6. Accounting Model

### Professional Billing (ARPB)

Every dollar must be accounted for. For a charge of $330:

| Column | Meaning | Example Value |
|---|---|---|
| `AMOUNT` | Original transaction amount (+ for charges, - for pmts/adjs) | 330.00 |
| `OUTSTANDING_AMT` | Unpaid remainder (0 when fully resolved) | 0.00 |
| `TOTAL_MATCH_AMT` | Sum of all payments+adjustments matched to this charge | -330.00 |
| `TOTAL_MTCH_INS_AMT` | Insurance portion of matches | -330.00 |
| `TOTAL_MTCH_ADJ` | Adjustment-only portion of matches | -106.58 |
| `TOTAL_MTCH_INS_ADJ` | Insurance adjustment portion | -106.58 |

**The equation**: `AMOUNT + TOTAL_MATCH_AMT = OUTSTANDING_AMT`
- Charge: $330 + (-$330) = $0 ✓ (fully resolved)
- Voided TX 315026147: $315 + $0 = $0 (voided, matches zeroed out, not in AR)

### Visit-Level Rollup (ARPB_VISITS)

Visit 10 (encounter 991225117) aggregates 3 charges:
- `PB_TOTAL_CHARGES`: $444 ($54 + $60 + $330? — actually $54+$60+$330=$444)
- `PB_TOTAL_BALANCE`: $0
- `PB_INS_BALANCE`: $0
- `PB_SELFPAY_BALANCE`: $0 (empty = never had patient responsibility)

### Hospital Billing (HSP)

HB uses **buckets** instead of per-TX matching. Each bucket represents a liability
party (insurance plan, self-pay). HSP_TRANSACTIONS reference `BUCKET_ID` and
`FIN_CLASS_C_NAME` ("Blue Cross", "Self-Pay") to track which bucket is debited/credited.

The account lifecycle: charges → insurance bucket → contractual write-off →
remaining balance transfers to self-pay bucket → collections → agency payment → zero.

### Guarantor Accounts (ACCOUNT)

Two guarantor accounts exist (both named MANDEL, JOSHUA C):
- **1810018166**: PB guarantor (service area 18). `TOTAL_BALANCE`=0, `LAST_INS_PMT_DATE`=10/23/2023
- **4793998**: HB guarantor (service area 10). `HB_LAST_SP_PMT_DT`=5/11/2022 (the AVADYNE payment)

The ACCOUNT table tracks combined balances across all visits/admissions, last payment
dates, and even payment plan info (`PMT_PLAN_AMOUNT`, `PMT_PLAN_STRT_DATE`).

## 7. Key Concepts Glossary

| Epic Term | Standard Revenue Cycle Term | Notes |
|---|---|---|
| **TX_ID** | Transaction ID | Unique per charge, payment, or adjustment |
| **VISIT_NUMBER** | Encounter billing group | Groups charges for one encounter |
| **OUTSTANDING_AMT** | Accounts Receivable balance | Per-transaction AR |
| **TOTAL_MATCH_AMT** | Applied amount | Sum of payments + adjustments matched to a charge |
| **CARC** | Claim Adjustment Reason Code | e.g., 45 = exceeds fee schedule, 16 = lacks info |
| **ICN** | Internal Control Number | Payer's claim tracking number (e.g., 2023286CD3233) |
| **CVD_AMT / NONCVD_AMT** | Covered / Non-covered amount | From EOB; CVD = what plan recognizes |
| **ALLOWED_AMOUNT** | Allowed amount | Contracted rate (e.g., $676 of $1,638.82 billed) |
| **Contractual write-off** | Provider adjustment | Difference between billed and allowed; can't bill patient |
| **Bucket** | Liability party | HB concept: insurance bucket, self-pay bucket |
| **Financial class** | Payer category | "Blue Cross", "Self-Pay", "Other" |
| **Repost** | Corrected claim | Void original → create replacement charge |
| **ETR** | Electronic Transaction Record | Legacy term; ETR_ID ≈ TX_ID in void context |
| **HAR** | Hospital Account Record | HSP_ACCOUNT; also used in HAR_ALL bridge table |
| **PB Visit** | Professional billing encounter | ARPB_VISITS; aggregates charges per CSN |
| **Service Area** | Billing entity/region | 18 = professional, 10 = hospital in this dataset |
| **835/ERA** | Electronic Remittance Advice | Payer's explanation of payment |
| **837P/837I** | Electronic claim (Prof/Inst) | Outbound claim submission |
| **276/277** | Claim status inquiry/response | "Where's my claim?" workflow |
| **EOB** | Explanation of Benefits | Per-line adjudication detail |
| **Fee schedule** | Contracted rate table | Payer's maximum allowable per procedure |

## 8. What EHI Has That FHIR Doesn't

| Data Point | In EHI? | In FHIR? | Why It Matters |
|---|---|---|---|
| **Contractual adjustments** ($106.58 write-off, CARC 45) | ✅ ARPB_TX_ACTIONS | ❌ | Reveals negotiated rates between provider and payer |
| **Claim denial details** (CARC 16, MA63 invalid dx) | ✅ PMT_EOB_INFO_I | ❌ | Shows why claims fail and how they're resolved |
| **Void/repost chain** (315026147 → 317236398) | ✅ ARPB_TX_VOID | ❌ | Full audit trail of billing corrections |
| **Collection agency workflow** (AVADYNE assign/withdraw) | ✅ HSP_ACCT_CL_AG_HIS | ❌ | Tracks when debt goes to collections |
| **Check-in copay collection** ($7.82 previous balance) | ✅ FRONT_END_PMT_COLL_HX | ❌ | Point-of-service financial interactions |
| **Payer-specific allowed amounts** ($676 of $1,638.82) | ✅ HSP_TRANSACTIONS | ❌ | Actual contracted rates (competitive intelligence) |
| **835 ERA file references** (BCWI0_...ORIGINAL.835) | ✅ HSP_TRANSACTIONS | ❌ | Links to raw remittance files |
| **Claim routing/submission path** (file paths, clearinghouse) | ✅ RECONCILE_CLM_OT | ❌ | Infrastructure-level claim tracking |
| **Benefit verification** (copay $0, coins 10%, OOP max) | ✅ SERVICE_BENEFITS | Partial | 126 rows of granular eligibility vs FHIR's Coverage |
| **Multi-bucket balance tracking** (ins → self-pay → agency) | ✅ HSP_TRANSACTIONS | ❌ | Full liability waterfall per party |
| **Transaction-level matching** (TOTAL_MATCH_AMT=-$330) | ✅ ARPB_TRANSACTIONS | ❌ | Exact payment application per charge |
| **Claim status history** (Hold → Rejected → Accepted) | ✅ RECONCILE_CLAIM_STATUS | ❌ | 91 status records showing claim lifecycle |

FHIR's `ExplanationOfBenefit` resource provides adjudication results, but it's a **snapshot** —
you get the final answer. EHI gives you the **full movie**: the original charge, every status
change, the denial, the research, the void, the repost, the corrected claim, and the eventual
payment. For anyone building revenue cycle analytics, denial management, or payer contract
analysis, EHI data is irreplaceable.
