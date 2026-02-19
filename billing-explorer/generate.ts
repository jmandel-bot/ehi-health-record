#!/usr/bin/env bun
/**
 * generate.ts — Build billing-explorer/data.json from patient_record.json
 *
 * Usage: bun run billing-explorer/generate.ts
 *
 * Loads the raw patient record, projects it through HealthRecord,
 * and builds encounter-centric billing stories with timeline events.
 */
import { projectHealthRecord } from '../src/HealthRecord';
import { loadPatientRecord } from '../src/PatientRecord';
import type {
  HealthRecord, Charge, Payment, TransactionAction, EOBLineItem,
  CollectionEvent, RemittanceRecord, ClaimReconciliationRecord,
  InvoiceRecord, ServiceBenefitRecord, Visit,
} from '../src/HealthRecord';
import { join } from 'path';

// ─── Load and project ─────────────────────────────────────────
const raw = await Bun.file(join(import.meta.dir, '..', 'patient_record.json')).json();
const pr = loadPatientRecord(raw);
const hr = projectHealthRecord(pr);

// ─── Helpers ──────────────────────────────────────────────────
const str = (v: any): string | null => v == null ? null : String(v);

// ─── Build encounter-centric billing stories ──────────────────

// Map visit IDs to visits
const visitMap = new Map<string, Visit>();
for (const v of hr.visits) {
  visitMap.set(v.id, v);
}

// Build visit number → CSN mapping from billing visits (ARPB_VISITS)
// Charge.visitId is PB_VISIT_NUM (e.g., "10"), not the clinical CSN.
// ARPB_VISITS has PB_VISIT_NUM→PRIM_ENC_CSN_ID mapping.
const visitNumToCsn = new Map<string, string>();
for (const bv of (raw.billing?.visits ?? [])) {
  if (bv.PB_VISIT_NUM != null && bv.PRIM_ENC_CSN_ID != null) {
    visitNumToCsn.set(String(bv.PB_VISIT_NUM), String(bv.PRIM_ENC_CSN_ID));
  }
}

// Map charges by clinical visit CSN
const chargesByVisit = new Map<string, Charge[]>();
for (const c of hr.billing.charges) {
  const visitNum = c.visitId;
  if (!visitNum) continue;
  const csn = visitNumToCsn.get(visitNum) ?? visitNum;
  if (!chargesByVisit.has(csn)) chargesByVisit.set(csn, []);
  chargesByVisit.get(csn)!.push(c);
}

// Map actions by TX_ID
const actionsByTx = new Map<string, TransactionAction[]>();
for (const a of hr.billing.transactionActions) {
  const txId = a.transactionId;
  if (!txId) continue;
  if (!actionsByTx.has(txId)) actionsByTx.set(txId, []);
  actionsByTx.get(txId)!.push(a);
}

// Map invoices by charge ID
const invoicesByChargeId = new Map<string, InvoiceRecord[]>();
for (const inv of hr.billing.invoices) {
  for (const cid of (inv as any).chargeTransactionIds ?? (inv as any).chargeIds ?? []) {
    if (!invoicesByChargeId.has(cid)) invoicesByChargeId.set(cid, []);
    invoicesByChargeId.get(cid)!.push(inv);
  }
}

// Map recons by invoice number
const reconsByInvoice = new Map<string, ClaimReconciliationRecord[]>();
for (const rec of hr.billing.reconciliations) {
  const inv = (rec as any).invoiceNumber;
  if (!inv) continue;
  if (!reconsByInvoice.has(inv)) reconsByInvoice.set(inv, []);
  reconsByInvoice.get(inv)!.push(rec);
}

// Map remittances by invoice number
const remitsByInvoice = new Map<string, RemittanceRecord[]>();
for (const rem of hr.billing.remittances) {
  const inv = (rem.adjudication as any)?.invoiceNumber;
  if (!inv) continue;
  if (!remitsByInvoice.has(inv)) remitsByInvoice.set(inv, []);
  remitsByInvoice.get(inv)!.push(rem);
}

// Map EOB items by chargeTransactionId  
const eobsByCharge = new Map<string, EOBLineItem[]>();
for (const e of hr.billing.eobLineItems) {
  const cid = (e as any).chargeTransactionId;
  if (!cid) continue;
  if (!eobsByCharge.has(cid)) eobsByCharge.set(cid, []);
  eobsByCharge.get(cid)!.push(e);
}

// Map payments by relatedChargeId
const paymentsByCharge = new Map<string, Payment[]>();
for (const p of hr.billing.payments) {
  const cid = p.relatedChargeId;
  if (!cid) continue;
  if (!paymentsByCharge.has(cid)) paymentsByCharge.set(cid, []);
  paymentsByCharge.get(cid)!.push(p);
}

// Map collection events by visitId
const collectionsByVisit = new Map<string, CollectionEvent[]>();
for (const ce of hr.billing.collectionEvents) {
  const vid = (ce as any).visitId;
  if (!vid) continue;
  if (!collectionsByVisit.has(vid)) collectionsByVisit.set(vid, []);
  collectionsByVisit.get(vid)!.push(ce);
}

// Map claims by invoice number
const claimsByInvoice = new Map<string, any[]>();
for (const cl of hr.billing.claims) {
  const inv = (cl as any).invoiceNumber;
  if (!inv) continue;
  if (!claimsByInvoice.has(inv)) claimsByInvoice.set(inv, []);
  claimsByInvoice.get(inv)!.push(cl);
}

// Build set of voided charge IDs for context
const voidedChargeIds = new Set<string>();
for (const c of hr.billing.charges) {
  if (c.isVoided) voidedChargeIds.add(c.id);
}

interface TimelineEvent {
  date: string | null;
  type: string;
  label: string;
  sublabel: string | null;
  detail: string | null;
  amount: number | null;
  amountLabel: string | null;
  chargeId?: string | null;
  isVoidedCharge?: boolean;
}

function buildEncounterData(visit: Visit) {
  // Find charges for this visit
  // Visit number may be in the Epic data
  const visitEpic = (visit as any)._epic ?? {};
  const csnId = String(visitEpic.PAT_ENC_CSN_ID ?? visit.id);
  
  // Try matching charges by visit number
  let charges = chargesByVisit.get(csnId) ?? [];
  
  // If no charges found, try matching by the visit ID
  if (charges.length === 0) {
    charges = chargesByVisit.get(visit.id) ?? [];
  }
  
  if (charges.length === 0) {
    return { encounter: buildEncounterSummary(visit), billing: null };
  }
  
  // Gather all related entities
  const allInvoiceNums = new Set<string>();
  const allInvoices: InvoiceRecord[] = [];
  const allClaims: any[] = [];
  const allRecons: ClaimReconciliationRecord[] = [];
  const allRemits: RemittanceRecord[] = [];
  const allActions: TransactionAction[] = [];
  const allEobs: EOBLineItem[] = [];
  const allPayments: Payment[] = [];
  const seenInvoices = new Set<string>();
  const seenRecons = new Set<string>();
  const seenRemits = new Set<string>();
  const seenClaims = new Set<string>();
  
  for (const c of charges) {
    // Actions
    const acts = actionsByTx.get(c.id) ?? [];
    allActions.push(...acts);
    
    // EOBs  
    const eobs = eobsByCharge.get(c.id) ?? [];
    allEobs.push(...eobs);
    
    // Payments
    const pmts = paymentsByCharge.get(c.id) ?? [];
    allPayments.push(...pmts);
    
    // Invoices for this charge
    const invs = invoicesByChargeId.get(c.id) ?? [];
    for (const inv of invs) {
      if (!seenInvoices.has(inv.id)) {
        seenInvoices.add(inv.id);
        allInvoices.push(inv);
        allInvoiceNums.add((inv as any).invoiceNumber ?? (inv as any).number ?? inv.id);
      }
    }
    
    // Also add invoice from the charge's own invoiceNumber
    if (c.invoiceNumber) allInvoiceNums.add(c.invoiceNumber);
  }
  
  // Gather recons, remits, claims by invoice number
  for (const invNum of allInvoiceNums) {
    const recs = reconsByInvoice.get(invNum) ?? [];
    for (const rec of recs) {
      if (!seenRecons.has(rec.id)) {
        seenRecons.add(rec.id);
        allRecons.push(rec);
      }
    }
    
    const rems = remitsByInvoice.get(invNum) ?? [];
    for (const rem of rems) {
      if (!seenRemits.has(rem.id)) {
        seenRemits.add(rem.id);
        allRemits.push(rem);
      }
    }
    
    const cls = claimsByInvoice.get(invNum) ?? [];
    for (const cl of cls) {
      if (!seenClaims.has(cl.id)) {
        seenClaims.add(cl.id);
        allClaims.push(cl);
      }
    }
  }
  
  // Collection events for this visit
  const collections = collectionsByVisit.get(csnId) ?? [];
  
  // ─── Build timeline ─────────────────────────────────────
  const timeline: TimelineEvent[] = [];
  
  // 1. Visit event
  timeline.push({
    date: visit.date,
    type: 'visit',
    label: 'Clinical Visit',
    sublabel: (visit as any).type ?? 'Visit',
    detail: `${visit.provider ?? 'Unknown'} at ${(visit as any).department ?? 'dept'}`,
    amount: null,
    amountLabel: null,
  });
  
  // 2. Collection events (Bug 8: number duplicates)
  const collectionGroups = new Map<string, CollectionEvent[]>();
  for (const ce of collections) {
    const key = `${(ce as any).workflowType ?? 'Event'}`;
    if (!collectionGroups.has(key)) collectionGroups.set(key, []);
    collectionGroups.get(key)!.push(ce);
  }
  for (const [wfType, group] of collectionGroups) {
    for (let i = 0; i < group.length; i++) {
      const ce = group[i];
      const countLabel = group.length > 1 ? ` (${i + 1} of ${group.length})` : '';
      timeline.push({
        date: (ce as any).date,
        type: 'collection',
        label: `Front Desk ${wfType}${countLabel}`,
        sublabel: wfType,
        detail: `PB Copay Due: $${(ce as any).pbCopay?.due ?? 0}, HB Copay Due: $${(ce as any).hbCopay?.due ?? 0}`,
        amount: null,
        amountLabel: null,
      });
    }
  }
  
  // 3. Charge events (Bug 5: mark voided charges)
  for (const c of charges) {
    const isVoided = c.isVoided;
    const isReplacement = !!c.originalChargeId;
    let label = 'Charge Posted';
    if (isVoided) {
      label = 'Charge Posted (VOIDED → reposted)';
    } else if (isReplacement) {
      label = 'Replacement Charge Posted';
    }
    
    timeline.push({
      date: c.date,
      type: 'charge',
      label,
      sublabel: `Proc ${c.service}`,
      detail: [c.providerSpecialty, c.modifiers?.length ? `Mod: ${c.modifiers.join(', ')}` : null].filter(Boolean).join(' '),
      amount: c.amount,
      amountLabel: 'Billed',
      chargeId: c.id,
      isVoidedCharge: isVoided,
    });
  }
  
  // 4. Invoice events (Bug 4: no amount for invoices)
  for (const inv of allInvoices) {
    timeline.push({
      date: (inv as any).serviceFromDate ?? (inv as any).fromDate ?? null,
      type: 'invoice',
      label: 'Claim Filed (837)',
      sublabel: (inv as any).invoiceNumber ?? (inv as any).number ?? inv.id,
      detail: `→ ${(inv as any).payerName ?? (inv as any).payer ?? 'Unknown'} • Status: ${(inv as any).status ?? 'Unknown'}`,
      amount: null,  // Bug 4: invoice amount is just the claim total, not new money
      amountLabel: null,
    });
  }
  
  // 5. Recon events (Bug 3: no dollar amounts for status polling)
  for (const rec of allRecons) {
    for (const t of ((rec as any).timeline ?? [])) {
      const desc = t.description ? ` — ${t.description}` : '';
      timeline.push({
        date: t.date,
        sortKey: t.sortKey ?? 0,  // CONTACT_DATE_REAL for sub-day ordering
        type: 'recon',
        label: 'Claim Status (276/277)',
        sublabel: t.action,
        detail: `${t.statusCode ?? ''}${desc}`,
        amount: null,
        amountLabel: null,
      });
    }
  }
  
  // 6. Remittance events (Bug 6: handle reversals)
  for (const rem of allRemits) {
    const adj = rem.adjudication as any;
    const isReversal = adj?.chargedAmount != null && adj.chargedAmount < 0;
    
    timeline.push({
      date: (rem as any).creationDate,
      type: 'remittance',
      label: isReversal ? 'ERA Reversal (835)' : 'ERA Received (835)',
      sublabel: adj?.claimStatus ?? null,
      detail: isReversal
        ? `Reversal of $${Math.abs(adj.chargedAmount)} charge`
        : `Charged: $${adj?.chargedAmount ?? '?'} → Paid: $${adj?.paidAmount ?? '?'}`,
      amount: isReversal ? null : (adj?.paidAmount ?? null),
      amountLabel: isReversal ? null : 'Paid',
    });
    
    // ERA adjustments
    for (const adjItem of ((rem as any).adjustments ?? [])) {
      const isReversalAdj = adjItem.amount != null && adjItem.amount < 0 && isReversal;
      timeline.push({
        date: (rem as any).creationDate,
        type: 'adjustment',
        label: isReversalAdj ? 'ERA Reversal Adjustment' : 'ERA Adjustment',
        sublabel: adjItem.adjustmentGroup,
        detail: isReversalAdj
          ? `CARC ${adjItem.reasonCode}: reversal of $${Math.abs(adjItem.amount)}`
          : `CARC ${adjItem.reasonCode}: -$${Math.abs(adjItem.amount)}`,
        amount: isReversalAdj ? null : -Math.abs(adjItem.amount),
        amountLabel: isReversalAdj ? null : 'Adjusted',
      });
    }
  }
  
  // 7. Action events (Bug 7: include chargeId for context)
  for (const act of allActions) {
    const amt = act.actionAmount;
    const isOnVoidedCharge = act.transactionId ? voidedChargeIds.has(act.transactionId) : false;
    const contextSuffix = isOnVoidedCharge ? ' (on voided charge)' : '';
    
    // Determine amount label based on action type
    let amountLabel: string | null = null;
    const actionType = act.actionType ?? '';
    if (actionType.includes('Adjustment') || actionType.includes('Not Allowed')) {
      amountLabel = 'Adjustment';
    } else if (actionType === 'Denied') {
      amountLabel = 'Denied';
    } else if (actionType === 'Next Responsible Party') {
      amountLabel = 'Transferred';
    } else if (amt != null && amt !== 0) {
      amountLabel = actionType;
    }
    
    timeline.push({
      date: act.actionDate,
      type: 'action',
      label: `${act.actionType ?? 'Action'}${contextSuffix}`,
      sublabel: act.denialCode ? `Code ${act.denialCode}` : null,
      detail: [
        act.denialCodeName,
        `• Balance: $${act.outstandingBefore ?? '?'} → $${act.outstandingAfter ?? '?'}`,
      ].filter(Boolean).join(' '),
      amount: amt != null && amt !== 0 ? -amt : null,
      amountLabel: amt != null && amt !== 0 ? amountLabel : null,
      chargeId: act.transactionId,
      isVoidedCharge: isOnVoidedCharge,
    });
  }
  
  // 8. EOB events
  for (const eob of allEobs) {
    timeline.push({
      date: (eob as any).checkDate ?? (eob as any).date,
      type: 'eob',
      label: 'EOB Line',
      sublabel: (eob as any).procedureCode,
      detail: `Payer: ${(eob as any).payerName ?? '?'}`,
      amount: (eob as any).paidAmount ?? null,
      amountLabel: (eob as any).paidAmount != null ? 'Paid' : null,
    });
  }
  
  // Sort timeline by date
  timeline.sort((a, b) => {
    if (!a.date && !b.date) return 0;
    if (!a.date) return -1;
    if (!b.date) return 1;
    const dc = a.date.localeCompare(b.date);
    if (dc !== 0) return dc;
    // Sub-day ordering via sortKey (CONTACT_DATE_REAL for recon events)
    return (a.sortKey ?? 0) - (b.sortKey ?? 0);
  });
  
  // ─── Summary ────────────────────────────────────────────
  const activeCharges = charges.filter(c => !c.isVoided);
  const totalCharged = activeCharges.reduce((s, c) => s + (c.amount ?? 0), 0);
  const totalPaid = allRemits
    .filter(r => (r.adjudication as any)?.chargedAmount >= 0)  // exclude reversals
    .reduce((s, r) => s + ((r.adjudication as any)?.paidAmount ?? 0), 0);
  const totalAdjusted = allActions
    .filter(a => (a.actionType ?? '').includes('Adjustment') || (a.actionType ?? '').includes('Not Allowed'))
    .reduce((s, a) => s + Math.abs(a.actionAmount ?? 0), 0);
  const outstandingFinal = activeCharges.reduce((s, c) => s + (c.outstandingAmount ?? 0), 0);
  
  const summary = {
    totalCharged,
    totalPaid,
    totalAdjusted,
    outstandingFinal,
    chargeCount: charges.length,
    hasRejection: allInvoices.some(inv => (inv as any).status === 'Rejected'),
    hasVoid: charges.some(c => c.isVoided),
  };
  
  // ─── Charge table data ──────────────────────────────────
  const chargeTableData = charges.map(c => ({
    id: c.id,
    amount: c.amount,
    service: c.service,
    outstanding: c.outstandingAmount,
    financialClass: c.financialClass,
    specialty: c.providerSpecialty,
    modifiers: c.modifiers,
    quantity: c.quantity,
    matchHistory: c.matchHistory.map(mh => ({
      matchDate: mh.matchDate,
      matchDateTime: mh.matchDateTime,
      matchedTransactionId: mh.matchedTransactionId,
      amount: mh.amount,
      insuranceAmount: mh.insuranceAmount,
      patientAmount: mh.patientAmount,
      invoiceNumber: mh.invoiceNumber,
      matchedBy: mh.matchedBy,
      unmatchDate: mh.unmatchDate,
      unmatchComment: mh.unmatchComment,
      _epic: mh._epic,
    })),
    statementDates: c.statementDates,
    isVoided: c.isVoided,
    voidDate: c.voidDate,
    originalChargeId: c.originalChargeId,
    voidedBy: c.voidedBy,
    voidType: c.voidType,
  }));
  
  // ─── Invoice data ───────────────────────────────────────
  const invoiceData = allInvoices.map(inv => ({
    id: inv.id,
    number: (inv as any).invoiceNumber ?? (inv as any).number,
    status: (inv as any).status,
    type: (inv as any).type,
    insAmount: (inv as any).insuranceAmount ?? (inv as any).insAmount,
    selfPay: (inv as any).selfPayAmount ?? (inv as any).selfPay,
    payer: (inv as any).payerName ?? (inv as any).payer,
    fromDate: (inv as any).serviceFromDate ?? (inv as any).fromDate,
    toDate: (inv as any).serviceToDate ?? (inv as any).toDate,
    chargeIds: (inv as any).chargeTransactionIds ?? (inv as any).chargeIds,
  }));
  
  // ─── Claim data ─────────────────────────────────────────
  const claimData = allClaims.map((cl: any) => ({
    id: cl.id,
    submitDate: cl.submitDate,
    status: cl.status,
    totalCharged: cl.totalCharged,
    totalPaid: cl.totalPaid,
    payer: cl.payer,
    provider: cl.provider,
    invoiceNumber: cl.invoiceNumber,
    billingProvider: cl.billingProviderDetail ?? cl.billingProvider,
  }));
  
  // ─── Recon data ─────────────────────────────────────────
  const reconData = allRecons.map(rec => ({
    id: rec.id,
    invoiceNumber: (rec as any).invoiceNumber,
    currentStatus: (rec as any).currentStatus,
    claimStatus: (rec as any).claimStatus,
    totalBilled: (rec as any).totalBilled,
    closedDate: (rec as any).closedDate,
    timeline: ((rec as any).timeline ?? []).map((t: any) => ({
      date: t.date,
      statusCode: t.statusCode,
      action: t.action,
      message: t.message,
      payerAmountSubmitted: t.payerAmountSubmitted,
      payerAmountPaid: t.payerAmountPaid,
      payerCheckDate: t.payerCheckDate,
      payerCheckNumber: t.payerCheckNumber,
      fileName: t.fileName,
      errorMessage: t.errorMessage,
      _epic: t._epic,
    })),
  }));
  
  // ─── Remit data ─────────────────────────────────────────
  const remitData = allRemits.map(rem => ({
    id: rem.id,
    creationDate: (rem as any).creationDate,
    paymentAmount: (rem as any).paymentAmount,
    paymentMethod: (rem as any).paymentMethod,
    adjudication: rem.adjudication,
    serviceLines: (rem as any).serviceLines,
    adjustments: (rem as any).adjustments,
  }));
  
  // ─── Action data ────────────────────────────────────────
  const actionData = allActions.map(act => ({
    transactionId: act.transactionId,
    line: (act as any).line,
    actionType: act.actionType,
    actionDate: act.actionDate,
    actionAmount: act.actionAmount,
    denialCode: act.denialCode,
    denialCodeName: act.denialCodeName,
    remittanceCode: act.remittanceCode,
    remittanceCodeTwo: act.remittanceCodeTwo,
    remittanceCodeThree: act.remittanceCodeThree,
    remittanceCodeFour: act.remittanceCodeFour,
    outstandingBefore: act.outstandingBefore,
    outstandingAfter: act.outstandingAfter,
    insuranceBefore: act.insuranceBefore,
    insuranceAfter: act.insuranceAfter,
    payorId: act.payorId,
    paymentPayorId: act.paymentPayorId,
    coverageBefore: act.coverageBefore,
    coverageAfter: act.coverageAfter,
    actionRemitCodes: act.actionRemitCodes,
    actionComment: act.actionComment,
    _epic: act._epic,
  }));
  
  // ─── EOB data ───────────────────────────────────────────
  const eobData = allEobs.map(e => ({
    paymentTransactionId: (e as any).paymentTransactionId,
    chargeTransactionId: (e as any).chargeTransactionId,
    checkDate: (e as any).checkDate,
    paidAmount: (e as any).paidAmount,
    procedureCode: (e as any).procedureCode,
    payerName: (e as any).payerName,
    _epic: (e as any)._epic,
  }));
  
  // ─── Collection data ────────────────────────────────────
  const collectionData = collections.map(ce => ({
    visitId: (ce as any).visitId,
    line: (ce as any).line,
    date: (ce as any).date,
    collectionInstant: (ce as any).collectionInstant,
    workflowType: (ce as any).workflowType,
    eventType: (ce as any).eventType,
    pbCopay: (ce as any).pbCopay,
    hbCopay: (ce as any).hbCopay,
    pbPrepay: (ce as any).pbPrepay,
    hbPrepay: (ce as any).hbPrepay,
    pbPreviousBalance: (ce as any).pbPreviousBalance,
    hbPreviousBalance: (ce as any).hbPreviousBalance,
    visitBalance: (ce as any).visitBalance,
    prepayDiscountOffered: (ce as any).prepayDiscountOffered,
    nonCollectionReason: (ce as any).nonCollectionReason,
    nonCollectionComment: (ce as any).nonCollectionComment,
    _epic: (ce as any)._epic,
  }));
  
  return {
    encounter: buildEncounterSummary(visit),
    billing: {
      summary,
      timeline,
      charges: chargeTableData,
      invoices: invoiceData,
      claims: claimData,
      recons: reconData,
      remits: remitData,
      actions: actionData,
      eobs: eobData,
      payments: allPayments,
      collections: collectionData,
    },
  };
}

function buildEncounterSummary(visit: Visit) {
  return {
    id: visit.id,
    date: visit.date,
    provider: visit.provider,
    department: (visit as any).department,
    type: (visit as any).type,
    status: (visit as any).status,
    diagnoses: (visit as any).diagnoses?.map((d: any) => typeof d === 'string' ? d : d.name).filter(Boolean) ?? [],
    orders: (visit as any).orders?.map((o: any) => typeof o === 'string' ? o : o.description).filter(Boolean) ?? [],
    hasBilling: false, // will be set later
    billingStatus: null as string | null,
    financialClass: null as string | null,
  };
}

// ─── Build all encounters ─────────────────────────────────────
const encounters = [];
for (const visit of hr.visits) {
  const enc = buildEncounterData(visit);
  if (enc.billing) {
    enc.encounter.hasBilling = true;
    enc.encounter.billingStatus = enc.billing.invoices[0]?.status ?? null;
    enc.encounter.financialClass = enc.billing.charges[0]?.financialClass ?? null;
  }
  encounters.push(enc);
}

// Sort by date descending
encounters.sort((a, b) => {
  const da = a.encounter.date ?? '';
  const db = b.encounter.date ?? '';
  return db.localeCompare(da);
});

// ─── Totals ───────────────────────────────────────────────────
const billedEncs = encounters.filter(e => e.billing);
const allChargesActive = hr.billing.charges.filter(c => !c.isVoided);
const totalCharges = allChargesActive.reduce((s, c) => s + (c.amount ?? 0), 0);
const totalPaid = hr.billing.remittances
  .filter(r => (r.adjudication as any)?.chargedAmount >= 0)
  .reduce((s, r) => s + ((r.adjudication as any)?.paidAmount ?? 0), 0);

const totals = {
  totalCharges,
  totalPaid,
  chargeCount: allChargesActive.length,
  encountersWithBilling: billedEncs.length,
  totalEncounters: encounters.length,
  claimCount: hr.billing.invoices.length,
  rejectedClaims: hr.billing.invoices.filter(inv => (inv as any).status === 'Rejected').length,
};

// ─── Patient info ─────────────────────────────────────────────
const demo = hr.demographics;
const primaryCoverage = hr.coverage[0];
const patient = {
  name: demo.name,
  dob: demo.dateOfBirth,
  insurance: primaryCoverage ? {
    id: primaryCoverage.id,
    type: (primaryCoverage as any).type,
    payorName: (primaryCoverage as any).payorName,
    planName: (primaryCoverage as any).planName,
    groupName: (primaryCoverage as any).groupName,
    groupNumber: (primaryCoverage as any).groupNumber,
    subscriberId: (primaryCoverage as any).subscriberId,
    effectiveDate: (primaryCoverage as any).effectiveDate,
    terminationDate: (primaryCoverage as any).terminationDate,
    _epic: (primaryCoverage as any)._epic,
  } : null,
};

// ─── Benefit categories ───────────────────────────────────────
const benefitMap = new Map<string, { count: number; sample: any }>();
for (const ben of hr.billing.serviceBenefits) {
  const type = (ben as any).serviceType ?? 'Unknown';
  if (!benefitMap.has(type)) {
    benefitMap.set(type, { count: 0, sample: ben });
  }
  benefitMap.get(type)!.count++;
}
const benefitCategories = Array.from(benefitMap.entries()).map(([type, data]) => ({
  type,
  count: data.count,
  sample: data.sample,
}));

// ─── Write output ─────────────────────────────────────────────
const output = {
  patient,
  encounters,
  benefitCategories,
  totals,
};

const outPath = join(import.meta.dir, 'data.json');
await Bun.write(outPath, JSON.stringify(output, null, 2));
console.log(`Written: ${outPath} (${Math.round(new Blob([JSON.stringify(output)]).size / 1024)} KB)`);
console.log(`Encounters: ${encounters.length} total, ${billedEncs.length} with billing`);
console.log(`Charges: ${allChargesActive.length} active, ${hr.billing.charges.filter(c => c.isVoided).length} voided`);
console.log(`Totals: $${totalCharges} billed, $${totalPaid.toFixed(2)} paid`);
