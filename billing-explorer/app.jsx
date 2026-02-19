const { useState, useEffect, useMemo } = React;

// ─── Model Insight annotations ──────────────────────────────────
const INSIGHTS = {
  overview: {
    icon: '🔍',
    text: `<strong>What you're seeing:</strong> Every clinical encounter that triggered billing, traced through the full revenue cycle. This data comes from Epic's EHI export — the raw database tables that power the billing system. <code>ARPB_TRANSACTIONS</code> (professional billing), <code>HSP_TRANSACTIONS</code> (hospital billing), <code>RECONCILE_CLM</code> (claim lifecycle), <code>CL_REMIT</code> (ERA/835 adjudication). None of this is available in standard FHIR US Core or CCDA exports.`
  },
  timeline: {
    icon: '📋',
    text: `<strong>Billing lifecycle:</strong> Each event below maps to a real database operation. <span style="color:var(--accent)">●</span> Visit triggers <span style="color:var(--amber)">●</span> Charge posting → <span style="color:var(--purple)">●</span> 837 Claim filed → <span style="color:var(--cyan)">●</span> 276/277 Status polling → <span style="color:var(--green)">●</span> 835 ERA adjudication → <span style="color:var(--red)">●</span> Adjustments (CARC/RARC codes) → <span style="color:var(--green2)">●</span> Payment posting. The entire chain is reconstructed from <code>ARPB_TX_ACTIONS</code>, <code>RECONCILE_CLAIM_STATUS</code>, and <code>PMT_EOB_INFO_I</code>.`
  },
  rejection: {
    icon: '⚠️',
    text: `<strong>Claim rejected:</strong> This claim was denied by the payer. In Epic, rejected claims create a new <code>RECONCILE_CLM</code> record and the original invoice is marked "Rejected" in <code>INV_CLM_STATUS</code>. The provider must fix the issue and resubmit, generating a new invoice number. The link between original and resubmission lives in <code>ARPB_TX_STMCLAIMHX</code>.`
  },
  adjustment: {
    icon: '💡',
    text: `<strong>Adjustments explained:</strong> When a payer pays less than billed, the difference is posted as adjustments. CARC (Claim Adjustment Reason Code) like <code>45</code> = "Charges exceed fee schedule" means the payer's contracted rate is lower than what was billed. This is stored in <code>ARPB_TX_ACTIONS</code> with the denial code, and the balance shifts from insurance-responsible to $0.`
  },
  era: {
    icon: '📄',
    text: `<strong>ERA (835) Remittance:</strong> This is the electronic explanation of benefits from the payer. It contains per-service-line adjudication from <code>CL_RMT_SVC_LINES</code>, CARC/RARC adjustment reason codes from <code>CL_RMT_SVC_ADJ</code>, and the actual payment amount. The <code>CL_REMIT</code> table is the master record; children contain the line-level detail.`
  },
  benefits: {
    icon: '🏥',
    text: `<strong>Benefit verification (270/271):</strong> Epic queries the payer's eligibility system before visits. The response populates <code>SERVICE_BENEFITS</code>. However, payers return <em>only what they choose to</em> — in this export, copay and coinsurance % are populated for most service types, but deductible, OOP max, network status, and visit limits are almost entirely blank. The dashes below aren't missing data — they're what the payer's system actually returned (or didn't).`
  },
  matchHistory: {
    icon: '🔗',
    text: `<strong>Payment matching:</strong> When an ERA payment arrives, Epic's posting process "matches" payment transactions to the original charge via <code>ARPB_TX_MATCH_HX</code>. Each match records who posted it, the amount, and which coverage was applied. This is how a single remittance payment gets allocated across multiple charges.`
  },
  claimStatus: {
    icon: '📡',
    text: `<strong>276/277 Claim Status:</strong> After filing, Epic polls the payer/clearinghouse for status updates. Each response creates a row in <code>RECONCILE_CLAIM_STATUS</code> with the payer's status code and message. "Claim Forwarded" means the clearinghouse accepted it; "Accepted for Processing" means the payer received it. This is the real-time claim tracking pipeline.`
  },
  claims: {
    icon: '📨',
    text: `<strong>837 Claims:</strong> Each card is one electronic claim (837P/837I) filed with the payer. Claims are ordered by submission date (newest first). The invoice number (e.g. L1008016200) is Epic's internal claim ID. <strong>Service Lines</strong> are the individual CPT/HCPCS line items on the claim — these map to the 837 SV1 segment. Descriptions come from <code>CLARITY_EAP</code> (Epic's procedure master), matched to <code>SVC_LN_INFO</code> line items. <strong>Dx codes</strong> are from <code>CLM_DX</code>. A single encounter can produce multiple claims (e.g., one for the office visit CPT, another for labs, another for immunizations).`
  },
};

function Insight({ type }) {
  const ins = INSIGHTS[type];
  if (!ins) return null;
  return (
    <div className="insight">
      <span className="icon">{ins.icon}</span>
      <span dangerouslySetInnerHTML={{ __html: ins.text }} />
    </div>
  );
}

// ─── Formatters ──────────────────────────────────
const fmt = (n) => n == null ? '—' : `$${Number(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const fmtDate = (d) => d ? new Date(d + 'T00:00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) : '—';
const fmtDateShort = (d) => d ? new Date(d + 'T00:00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) : '';

// ─── Summary Cards ──────────────────────────────
function SummaryCards({ totals }) {
  return (
    <div className="summary-grid">
      <div className="summary-card">
        <div className="label">Total Billed</div>
        <div className="value blue">{fmt(totals.totalCharges)}</div>
        <div className="note">{totals.chargeCount ?? 0} charges across {totals.encountersWithBilling} visits</div>
      </div>
      <div className="summary-card">
        <div className="label">Insurance Paid</div>
        <div className="value green">{fmt(totals.totalPaid)}</div>
        <div className="note">From ERA/835 remittances</div>
      </div>
      <div className="summary-card">
        <div className="label">Write-Offs</div>
        <div className="value amber">{fmt(totals.totalCharges - totals.totalPaid)}</div>
        <div className="note">Contractual adjustments + denials</div>
      </div>
      <div className="summary-card">
        <div className="label">Claims Filed</div>
        <div className="value blue">{totals.claimCount}</div>
        <div className="note">{totals.rejectedClaims} rejected → resubmitted</div>
      </div>
      <div className="summary-card">
        <div className="label">Collection Rate</div>
        <div className="value green">{totals.totalCharges > 0 ? Math.round(totals.totalPaid / totals.totalCharges * 100) : 0}%</div>
        <div className="note">Paid / Billed</div>
      </div>
      <div className="summary-card">
        <div className="label">Encounters</div>
        <div className="value">{totals.totalEncounters}</div>
        <div className="note">{totals.encountersWithBilling} generated billing</div>
      </div>
    </div>
  );
}

// ─── Money Flow Diagram ──────────────────────────
function MoneyFlow({ story }) {
  const { summary, remits, actions } = story;
  const contractualAdj = actions
    .filter(a => a.actionType?.includes('Adjustment'))
    .reduce((s, a) => s + (a.actionAmount ?? 0), 0);
  const patientResp = summary.outstandingFinal;

  return (
    <div className="money-flow">
      <div className="flow-node">
        <div className="flow-amount" style={{color: 'var(--accent2)'}}>{fmt(summary.totalCharged)}</div>
        <div className="flow-label">Billed</div>
      </div>
      <div className="flow-arrow">→</div>
      <div className="flow-node">
        <div className="flow-amount" style={{color: 'var(--green2)'}}>{fmt(summary.totalPaid)}</div>
        <div className="flow-label">Ins Paid</div>
      </div>
      <div className="flow-arrow">+</div>
      <div className="flow-node">
        <div className="flow-amount" style={{color: 'var(--amber2)'}}>{fmt(contractualAdj)}</div>
        <div className="flow-label">Adjustments</div>
      </div>
      {patientResp > 0 && <>
        <div className="flow-arrow">+</div>
        <div className="flow-node">
          <div className="flow-amount" style={{color: 'var(--red2)'}}>{fmt(patientResp)}</div>
          <div className="flow-label">Pt Owes</div>
        </div>
      </>}
      <div className="flow-arrow">=</div>
      <div className="flow-node">
        <div className="flow-amount" style={{color: 'var(--text3)'}}>{fmt(summary.outstandingFinal)}</div>
        <div className="flow-label">Outstanding</div>
      </div>
    </div>
  );
}

// ─── Timeline ──────────────────────────────────
function Timeline({ events }) {
  return (
    <div className="timeline">
      {events.map((ev, i) => (
        <div key={i} className={`tl-event ${ev.type}${ev.isVoidedCharge ? ' voided-event' : ''}`}
             style={ev.isVoidedCharge ? {opacity: 0.5} : undefined}>
          <div className="tl-dot" />
          <div>
            <span className="tl-date">{fmtDateShort(ev.date)}{ev.sortKey ? <span style={{opacity:0.5}}>{' #'}{Math.round((ev.sortKey % 1) * 100)}</span> : ''}</span>
            {ev.amount != null && (
              <span className={`tl-amount ${ev.amount >= 0 ? 'positive' : 'negative'}`}>
                {ev.amountLabel ? <span className="tl-amount-label">{ev.amountLabel}: </span> : null}
                {ev.amount >= 0 ? '+' : ''}{fmt(ev.amount)}
              </span>
            )}
            <span className="tl-label"> {ev.label}</span>
            {ev.sublabel && <span className="tl-sublabel">{ev.sublabel}</span>}
            {ev.performedBy && <span className="tl-staff"> — {ev.performedBy}</span>}
            {ev.detail && <div className="tl-detail">{ev.detail}</div>}
          </div>
        </div>
      ))}
    </div>
  );
}

// ─── Charge Detail Table ──────────────────────────
function ChargeTable({ charges }) {
  return (
    <table className="charge-table">
      <thead>
        <tr>
          <th>Status</th>
          <th>Procedure</th>
          <th>Specialty</th>
          <th className="amt">Billed</th>
          <th className="amt">Paid</th>
          <th className="amt">Adjusted</th>
          <th className="amt">Outstanding</th>
          <th>Modifiers</th>
        </tr>
      </thead>
      <tbody>
        {charges.map((c, i) => {
          const status = c.isVoided ? 'voided' : (c.outstanding === 0 ? 'resolved' : 'outstanding');
          const rowStyle = c.isVoided ? {opacity: 0.45, textDecoration: 'line-through'} : {};
          return (
            <tr key={i} style={rowStyle}>
              <td>
                <span className={`status-dot ${status}`} />{status}
                {c.isVoided && c.voidType && <span style={{fontSize:11, color:'var(--red2)', marginLeft:4}}>({c.voidType})</span>}
                {c.originalChargeId && <span style={{fontSize:11, color:'var(--cyan)', marginLeft:4}}>(replaces #{c.originalChargeId})</span>}
              </td>
              <td>{c.service}</td>
              <td style={{color: 'var(--text2)'}}>{c.specialty ?? '—'}</td>
              <td className="amt">{fmt(c.amount)}</td>
              <td className="amt" style={{color: 'var(--green2)'}}>
                {fmt((c.matchHistory ?? []).reduce((s, m) => s + (m.amount ?? 0), 0) || null)}
              </td>
              <td className="amt" style={{color: 'var(--amber2)'}}>
                {fmt((c.matchHistory ?? []).reduce((s, m) => s + (m.adjustmentAmount ?? 0), 0) || null)}
              </td>
              <td className="amt">{fmt(c.outstanding)}</td>
              <td style={{color: 'var(--text3)'}}>{(c.modifiers ?? []).join(', ') || '—'}</td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

// ─── Encounter Story Card ──────────────────────────
function StoryCard({ story, defaultOpen }) {
  const [open, setOpen] = useState(defaultOpen ?? false);
  const [tab, setTab] = useState('timeline');
  const { visit, summary, timeline, charges, invoices, claims, recons, remits, actions, eobs } = story;

  const hasRejection = summary.hasRejection;

  return (
    <div className={`story-card ${open ? 'open' : ''}`}>
      <div className="story-header" onClick={() => setOpen(!open)}>
        <span className="story-date">{fmtDate(visit.date)}</span>
        <span className="story-provider">
          {visit.provider ?? 'Unknown Provider'}
          <span className="story-dept"> — {visit.department ?? ''} ({visit.type ?? 'Visit'})</span>
        </span>
        <div className="story-badges">
          <span className="badge charge">{summary.chargeCount} charge{summary.chargeCount !== 1 ? 's' : ''} · {fmt(summary.totalCharged)}</span>
          <span className="badge paid">Paid {fmt(summary.totalPaid)}</span>
          {hasRejection && <span className="badge rejected">REJECTED</span>}
          {summary.hasVoid && <span className="badge voided">VOIDED</span>}
        </div>
        <span className="story-chevron">›</span>
      </div>

      {open && (
        <div className="story-detail">
          {/* Clinical Context */}
          <div className="clinical-context">
            <div className="col">
              <div className="col-label">Diagnoses</div>
              <ul>{(visit.diagnoses ?? []).map((d, i) => <li key={i}>{d}</li>)}</ul>
              {(!visit.diagnoses || visit.diagnoses.length === 0) && <ul><li style={{color:'var(--text3)'}}>No diagnoses recorded</li></ul>}
            </div>
            <div className="col">
              <div className="col-label">Orders / Procedures</div>
              <ul>{(visit.orders ?? []).map((o, i) => <li key={i}>{o}</li>)}</ul>
              {(!visit.orders || visit.orders.length === 0) && <ul><li style={{color:'var(--text3)'}}>No orders recorded</li></ul>}
            </div>
          </div>

          {/* Money Flow */}
          <MoneyFlow story={story} />

          {/* Insights */}
          {hasRejection && <Insight type="rejection" />}
          {actions.some(a => a.denialCode) && <Insight type="adjustment" />}
          {recons.some(r => r.timeline?.length > 0) && <Insight type="claimStatus" />}

          {/* Tabs */}
          <div className="tabs">
            <div className={`tab ${tab === 'timeline' ? 'active' : ''}`} onClick={() => setTab('timeline')}>Timeline ({timeline.length})</div>
            <div className={`tab ${tab === 'charges' ? 'active' : ''}`} onClick={() => setTab('charges')}>Charges ({charges.length})</div>
            <div className={`tab ${tab === 'claims' ? 'active' : ''}`} onClick={() => setTab('claims')}>Claims ({invoices.length})</div>
            {remits.length > 0 && <div className={`tab ${tab === 'remittances' ? 'active' : ''}`} onClick={() => setTab('remittances')}>Remittances ({remits.length})</div>}
          </div>

          {tab === 'timeline' && (
            <div className="story-section">
              <Insight type="timeline" />
              <Timeline events={timeline} />
            </div>
          )}

          {tab === 'charges' && (
            <div className="story-section">
              <Insight type="matchHistory" />
              <ChargeTable charges={charges} />
            </div>
          )}

          {tab === 'claims' && (
            <div className="story-section">
              <Insight type="claims" />
              {invoices.map((inv, i) => (
                <div key={i} style={{marginBottom: 12, padding: '10px 14px', background: 'var(--bg3)', borderRadius: 6}}>
                  <div style={{display:'flex', justifyContent:'space-between', alignItems:'center'}}>
                    <div>
                      <strong>{inv.number}</strong>
                      <span style={{marginLeft: 8, fontSize: 12, color: inv.status === 'Rejected' ? 'var(--red2)' : inv.status === 'Closed' ? 'var(--green2)' : 'var(--amber2)'}}>
                        {inv.status}
                      </span>
                    </div>
                    <div style={{fontSize: 13, color: 'var(--text2)'}}>{fmt(inv.insAmount)} → {inv.payer}</div>
                  </div>
                  <div style={{fontSize: 12, color: 'var(--text3)', marginTop: 4}}>
                    Service: {fmtDate(inv.fromDate)} — {fmtDate(inv.toDate)} · {inv.chargeIds?.length ?? 0} charge(s)
                  </div>
                  {/* Claim detail if available */}
                  {claims.filter(c => c.invoiceNumber === inv.number).map((cl, j) => (
                    <div key={j} style={{marginTop: 8, fontSize: 12, color: 'var(--text2)', borderTop: '1px solid var(--border)', paddingTop: 8}}>
                      <div>Provider: {cl.provider} · Submitted: {fmtDate(cl.submitDate)}</div>
                      {cl.billingProvider && (
                        <div style={{marginTop: 4, color: 'var(--text3)'}}>
                          Billing: {cl.billingProvider.name} · NPI: <code style={{background:'var(--bg4)', padding:'1px 4px', borderRadius:3, color:'var(--cyan)'}}>{cl.billingProvider.npi}</code> · Tax: {cl.billingProvider.taxonomy}
                        </div>
                      )}
                      {/* Service Lines */}
                      {cl.serviceLines?.length > 0 && (
                        <div style={{marginTop: 8}}>
                          <div style={{fontWeight: 600, color: 'var(--text1)', marginBottom: 4}}>Service Lines (837 SV1)</div>
                          <table style={{width: '100%', fontSize: 11, borderCollapse: 'collapse'}}>
                            <thead>
                              <tr style={{borderBottom: '1px solid var(--border)', color: 'var(--text3)'}}>
                                <th style={{textAlign:'left', padding:'2px 8px 2px 0'}}>Line</th>
                                <th style={{textAlign:'left', padding:'2px 8px'}}>CPT/HCPCS</th>
                                <th style={{textAlign:'left', padding:'2px 8px'}}>Description</th>
                                <th style={{textAlign:'left', padding:'2px 8px'}}>Mod</th>
                                <th style={{textAlign:'right', padding:'2px 8px'}}>Qty</th>
                                <th style={{textAlign:'right', padding:'2px 0 2px 8px'}}>Amount</th>
                              </tr>
                            </thead>
                            <tbody>
                              {cl.serviceLines.map((sl, k) => (
                                <tr key={k} style={{borderBottom: '1px solid var(--bg4)'}}>
                                  <td style={{padding:'3px 8px 3px 0', color:'var(--text3)'}}>{sl.line}</td>
                                  <td style={{padding:'3px 8px'}}><code style={{color:'var(--yellow)'}}>{sl.procedureCode}</code></td>
                                  <td style={{padding:'3px 8px', color:'var(--text2)'}}>{sl.procedureDescription || '—'}</td>
                                  <td style={{padding:'3px 8px', color:'var(--text3)'}}>{sl.modifier || '—'}</td>
                                  <td style={{padding:'3px 8px', textAlign:'right'}}>{sl.quantity}</td>
                                  <td style={{padding:'3px 0 3px 8px', textAlign:'right', color:'var(--green)'}}>{fmt(sl.chargedAmount)}</td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        </div>
                      )}
                      {/* Diagnoses */}
                      {cl.diagnoses?.length > 0 && (
                        <div style={{marginTop: 6}}>
                          <span style={{fontWeight: 600, color: 'var(--text1)'}}>Dx: </span>
                          {cl.diagnoses.map((dx, k) => (
                            <span key={k} style={{marginRight: 8}}>
                              <code style={{color:'var(--purple)', background:'var(--bg4)', padding:'1px 4px', borderRadius:3}}>{dx.code}</code>
                              {dx.rank === 1 && <span style={{fontSize:10, color:'var(--text3)'}}> (principal)</span>}
                            </span>
                          ))}
                        </div>
                      )}
                      {/* Notes */}
                      {cl.notes?.length > 0 && cl.notes.map((note, k) => (
                        <div key={k} style={{marginTop: 4, fontStyle: 'italic', color: 'var(--yellow)'}}>📝 {note}</div>
                      ))}
                    </div>
                  ))}
                </div>
              ))}
            </div>
          )}

          {tab === 'remittances' && (
            <div className="story-section">
              <Insight type="era" />
              {remits.map((r, i) => (
                <div key={i} style={{marginBottom: 12, padding: '10px 14px', background: 'var(--bg3)', borderRadius: 6}}>
                  <div style={{display:'flex', justifyContent:'space-between'}}>
                    <div>
                      <strong>ERA {r.id}</strong>
                      <span style={{marginLeft: 8, fontSize: 12, color: 'var(--text2)'}}>{fmtDate(r.creationDate)}</span>
                    </div>
                    <div style={{fontWeight: 600, color: 'var(--green2)'}}>{fmt(r.adjudication?.paidAmount)}</div>
                  </div>
                  <div style={{fontSize: 12, color: 'var(--text2)', marginTop: 4}}>
                    Charged: {fmt(r.adjudication?.chargedAmount)} · Status: {r.adjudication?.claimStatus}
                    {r.adjudication?.claimControlNumber && <> · ICN: <code style={{background:'var(--bg4)', padding:'1px 4px', borderRadius:3, color:'var(--cyan)'}}>{r.adjudication.claimControlNumber}</code></>}
                  </div>
                  {r.serviceLines?.length > 0 && (
                    <div style={{marginTop: 8, fontSize: 12}}>
                      <div style={{color: 'var(--text3)', fontWeight: 600, marginBottom: 4}}>Service Lines:</div>
                      {r.serviceLines.map((sl, j) => (
                        <div key={j} style={{display:'flex', justifyContent:'space-between', padding: '2px 0'}}>
                          <span style={{color:'var(--text2)'}}>{sl.procedureCode}</span>
                          <span>Charged: {fmt(sl.chargedAmount)} → Paid: <span style={{color:'var(--green2)'}}>{fmt(sl.paidAmount)}</span></span>
                        </div>
                      ))}
                    </div>
                  )}
                  {r.adjustments?.length > 0 && (
                    <div style={{marginTop: 8, fontSize: 12}}>
                      <div style={{color: 'var(--text3)', fontWeight: 600, marginBottom: 4}}>Adjustments (CARC):</div>
                      {r.adjustments.map((adj, j) => (
                        <div key={j} style={{display:'flex', justifyContent:'space-between', padding: '2px 0'}}>
                          <span style={{color:'var(--amber2)'}}>{adj.adjustmentGroup} — Code {adj.reasonCode}</span>
                          <span style={{color:'var(--red2)'}}>-{fmt(adj.amount)}</span>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ─── No Billing Card (encounter without charges) ───
function NoBillingCard({ encounter }) {
  return (
    <div className="story-card" style={{opacity: 0.6}}>
      <div className="story-header" style={{cursor: 'default'}}>
        <span className="story-date">{fmtDate(encounter.date)}</span>
        <span className="story-provider">
          {encounter.provider ?? 'Unknown Provider'}
          <span className="story-dept"> — {encounter.department ?? ''} ({encounter.type ?? 'Visit'})</span>
        </span>
        <div className="story-badges">
          <span className="badge" style={{background: 'rgba(100,116,139,0.15)', color: 'var(--text3)'}}>No charges generated</span>
        </div>
      </div>
    </div>
  );
}

// ─── Benefits Section ──────────────────────────────
function BenefitsSection({ categories }) {
  const [expanded, setExpanded] = useState(false);
  const shown = expanded ? categories : categories.slice(0, 8);

  return (
    <div className="benefits-section">
      <h3 style={{fontSize: 16, fontWeight: 700, marginBottom: 8}}>Insurance Benefit Verification</h3>
      <Insight type="benefits" />
      <div className="benefits-grid">
        {shown.map((cat, i) => {
          const s = cat.sample;
          return (
            <div key={i} className="benefit-card">
              <div className="svc-type">{cat.type}</div>
              <div className="detail-row"><span className="dlabel">Copay</span><span className="dvalue">{s.copayAmount != null ? fmt(s.copayAmount) : '—'}</span></div>
              <div className="detail-row"><span className="dlabel">Coinsurance</span><span className="dvalue">{s.coinsurancePercent != null ? s.coinsurancePercent + '%' : '—'}</span></div>
              <div className="detail-row"><span className="dlabel">Deductible</span><span className="dvalue">{s.deductibleAmount != null ? fmt(s.deductibleAmount) : '—'}</span></div>
              <div className="detail-row"><span className="dlabel">OOP Max</span><span className="dvalue">{s.outOfPocketMax != null ? fmt(s.outOfPocketMax) : '—'}</span></div>
              <div className="detail-row"><span className="dlabel">Network</span><span className="dvalue">{s.networkLevel ?? '—'}</span></div>
              <div className="detail-row"><span className="dlabel">Tier</span><span className="dvalue">{s.familyTier ?? '—'}</span></div>
            </div>
          );
        })}
      </div>
      {categories.length > 8 && (
        <div style={{marginTop: 10, textAlign: 'center'}}>
          <span style={{cursor: 'pointer', color: 'var(--accent2)', fontSize: 13}} onClick={() => setExpanded(!expanded)}>
            {expanded ? 'Show less' : `Show all ${categories.length} service types`}
          </span>
        </div>
      )}
    </div>
  );
}

// ─── App ──────────────────────────────────
function App() {
  const [data, setData] = useState(null);
  const [filter, setFilter] = useState('billed');

  useEffect(() => {
    fetch('data.json').then(r => r.json()).then(setData);
  }, []);

  const filtered = useMemo(() => {
    if (!data) return [];
    if (filter === 'all') return data.encounters;
    if (filter === 'billed') return data.encounters.filter(e => e.billing);
    if (filter === 'nobilling') return data.encounters.filter(e => !e.billing);
    if (filter === 'rejected') return data.encounters.filter(e => e.billing?.summary?.hasRejection);
    if (filter === 'highvalue') return data.encounters.filter(e => (e.billing?.summary?.totalCharged ?? 0) >= 300);
    return data.encounters;
  }, [data, filter]);

  if (!data) return <div style={{padding: 40, textAlign: 'center', color: 'var(--text2)'}}>Loading billing data...</div>;

  return (
    <div className="app">
      <div className="header">
        <h1><span>⚡</span> EHI Billing Explorer</h1>
        <div className="subtitle">
          Reverse-engineered revenue cycle from Epic EHI export — every step from clinical encounter to payment posting
        </div>
        <div className="patient-bar">
          <span className="name">{data.patient.name}</span>
          <span className="meta">DOB: {fmtDate(data.patient.dob)}</span>
          {data.patient.insurance && (
            <span className="insurance">
              ⛊ {data.patient.insurance.payorName ?? 'Insurance'} — {data.patient.insurance.planName ?? ''}
              {data.patient.insurance.groupNumber && <> · Group: {data.patient.insurance.groupNumber}</>}
            </span>
          )}
        </div>
      </div>

      <Insight type="overview" />

      <SummaryCards totals={data.totals} />

      <div style={{display:'flex', alignItems:'center', justifyContent:'space-between', marginBottom: 16}}>
        <h2 style={{fontSize: 18, fontWeight: 700}}>Encounters → Billing</h2>
        <div style={{display:'flex', gap: 8}}>
          {[
            ['all', `All Encounters (${data.totals.totalEncounters})`],
            ['billed', `With Billing (${data.totals.encountersWithBilling})`],
            ['nobilling', `No Billing (${data.totals.totalEncounters - data.totals.encountersWithBilling})`],
            ['rejected', `Rejected (${data.totals.rejectedClaims})`],
            ['highvalue', 'High Value (≥$300)'],
          ].map(([f, label]) => (
            <span key={f} className={`badge ${filter === f ? 'charge' : ''}`}
              style={{cursor: 'pointer', padding: '4px 10px'}}
              onClick={() => setFilter(f)}>
              {label}
            </span>
          ))}
        </div>
      </div>

      <div className="legend">
        <div className="legend-item"><div className="legend-dot" style={{background:'var(--accent)'}} /> Visit</div>
        <div className="legend-item"><div className="legend-dot" style={{background:'var(--amber)'}} /> Charge</div>
        <div className="legend-item"><div className="legend-dot" style={{background:'var(--purple)'}} /> 837 Claim</div>
        <div className="legend-item"><div className="legend-dot" style={{background:'var(--cyan)'}} /> 276/277 Status</div>
        <div className="legend-item"><div className="legend-dot" style={{background:'var(--green)'}} /> 835 ERA</div>
        <div className="legend-item"><div className="legend-dot" style={{background:'var(--red)'}} /> Adjustment</div>
        <div className="legend-item"><div className="legend-dot" style={{background:'var(--green2)'}} /> Payment</div>
        <div className="legend-item"><div className="legend-dot" style={{background:'var(--pink)'}} /> EOB</div>
      </div>

      <div className="story-list">
        {filtered.map((enc, i) => (
          enc.billing
            ? <StoryCard key={enc.encounter.id} story={{visit: enc.encounter, ...enc.billing}} defaultOpen={i === 0 && filter === 'billed'} />
            : <NoBillingCard key={enc.encounter.id} encounter={enc.encounter} />
        ))}
      </div>

      <BenefitsSection categories={data.benefitCategories} />

      <div style={{marginTop: 40, padding: '16px 20px', background: 'var(--bg2)', borderRadius: 8, border: '1px solid var(--border)', fontSize: 12, color: 'var(--text3)'}}>
        <strong style={{color: 'var(--text)'}}>About this data</strong> — Generated from a real Epic EHI export (Electronic Health Information, your legal right under HIPAA §164.524). The raw data spans {data.totals.encountersWithBilling} billed encounters across {data.totals.totalEncounters} total visits. Tables used: ARPB_TRANSACTIONS, ARPB_TX_ACTIONS, ARPB_TX_MATCH_HX, ARPB_TX_STMT_DT, ARPB_VISITS, CLM_VALUES, CLAIM_INFO, CL_REMIT, CL_RMT_SVC_LINES, CL_RMT_SVC_ADJ, RECONCILE_CLM, RECONCILE_CLAIM_STATUS, RECONCILE_CLM_OT, PMT_EOB_INFO_I, SERVICE_BENEFITS, INV_CLM_STATUS, and more.
      </div>
    </div>
  );
}

ReactDOM.createRoot(document.getElementById('root')).render(<App />);
