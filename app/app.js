// Health Record Explorer
let HR = null;

const SECTIONS = [
  { key: 'demographics', icon: '👤', label: 'Demographics', count: r => r.demographics ? 1 : 0 },
  { key: 'allergies', icon: '⚠️', label: 'Allergies' },
  { key: 'problems', icon: '🩺', label: 'Problems' },
  { key: 'medications', icon: '💊', label: 'Medications' },
  { key: 'immunizations', icon: '💉', label: 'Immunizations' },
  { key: 'visits', icon: '🏥', label: 'Visits' },
  { key: 'labResults', icon: '🧪', label: 'Lab Results' },
  { key: 'messages', icon: '💬', label: 'Messages' },
  { key: 'documents', icon: '📄', label: 'Documents' },
  { key: 'referrals', icon: '🔗', label: 'Referrals' },
  { key: 'coverage', icon: '🛡️', label: 'Insurance' },
  { key: 'billing', icon: '💰', label: 'Billing', count: r => {
    const b = r.billing; return (b.charges?.length||0)+(b.payments?.length||0)+(b.claims?.length||0);
  }},
  { key: 'familyHistory', icon: '👨‍👩‍👧', label: 'Family History' },
  { key: 'socialHistory', icon: '🌍', label: 'Social History', count: r => r.socialHistory?.tobaccoUse ? 1 : 0 },
  { key: 'surgicalHistory', icon: '🔪', label: 'Surgical History' },
  { key: 'episodes', icon: '📅', label: 'Episodes' },
  { key: 'goals', icon: '🎯', label: 'Goals' },
  { key: 'questionnaireResponses', icon: '📋', label: 'Questionnaires' },
];

// Utility functions
const h = (tag, attrs, ...children) => {
  const el = document.createElement(tag);
  if (attrs) Object.entries(attrs).forEach(([k,v]) => {
    if (k === 'className') el.className = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2).toLowerCase(), v);
    else el.setAttribute(k, v);
  });
  children.flat(Infinity).forEach(c => {
    if (c == null) return;
    el.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
  });
  return el;
};

const fmtDate = d => d ? new Date(d).toLocaleDateString('en-US', {year:'numeric',month:'short',day:'numeric'}) : '—';
const fmtDateTime = d => d ? new Date(d).toLocaleString('en-US', {year:'numeric',month:'short',day:'numeric',hour:'numeric',minute:'2-digit'}) : '—';
const str = v => v ?? '—';
const tag = (text, cls='tag-gray') => h('span', {className: `tag ${cls}`}, text);

function epicToggle(data) {
  if (!data) return '';
  const id = 'epic-' + Math.random().toString(36).slice(2);
  return h('div', {className: 'epic-raw'},
    h('button', {className: 'epic-toggle', onClick: () => {
      document.getElementById(id).classList.toggle('open');
    }}, '🔍 Raw Epic Data'),
    h('div', {className: 'epic-detail', id},
      h('pre', {className: 'json'}, JSON.stringify(data, null, 2))
    )
  );
}

function field(label, value) {
  return h('div', {className: 'field'},
    h('span', {className: 'field-label'}, label),
    h('span', {className: 'field-value'}, typeof value === 'string' ? value : value ?? '—')
  );
}

function card(title, subtitle, body, epicData) {
  return h('div', {className: 'card'},
    h('div', {className: 'card-header'},
      h('span', null, title),
      subtitle ? tag(subtitle, 'tag-blue') : ''
    ),
    h('div', {className: 'card-body'}, body),
    epicData ? epicToggle(epicData) : ''
  );
}

// ─── Section Renderers ────────────────────────────────
const renderers = {
  demographics(r) {
    const d = r.demographics;
    return h('div', null,
      card('Patient Information', null, h('div', null,
        field('Name', d.name),
        field('Preferred Name', str(d.preferredName)),
        field('Date of Birth', fmtDate(d.dateOfBirth)),
        field('Sex', str(d.sex)),
        field('Gender Identity', str(d.genderIdentity)),
        field('Sexual Orientation', str(d.sexualOrientation)),
        field('Race', (d.race||[]).join(', ') || '\u2014'),
        field('Ethnicity', str(d.ethnicity)),
        field('Language', str(d.language)),
        field('Marital Status', str(d.maritalStatus)),
      ), d._epic),
      card('Contact', null, h('div', null,
        field('Address', d.address ? `${d.address.street}, ${d.address.city}, ${d.address.state} ${d.address.zip}` : '\u2014'),
        field('Phone', str(d.phone)),
        field('Email', str(d.email)),
        field('Employer', str(d.employer)),
        field('PCP', str(d.primaryCareProvider)),
      )),
      d.emergencyContacts?.length ? card('Emergency Contacts', null, h('div', null,
        ...d.emergencyContacts.map(c => h('div', {className: 'card', style: 'margin: 8px 0'},
          field('Name', str(c.name)),
          field('Relationship', str(c.relationship)),
          field('Phone', str(c.phone)),
        ))
      )) : '',
    );
  },

  allergies(r) {
    if (!r.allergies?.length) return empty('No allergies recorded');
    return h('div', null, ...r.allergies.map(a =>
      card(str(a.allergen), a.severity, h('div', null,
        field('Type', str(a.type)),
        field('Reactions', (a.reactions||[]).join(', ') || '\u2014'),
        field('Onset', fmtDate(a.onsetDate)),
        field('Status', str(a.status)),
      ), a._epic)
    ));
  },

  problems(r) {
    if (!r.problems?.length) return empty('No active problems');
    return h('div', null, ...r.problems.map(p =>
      card(str(p.description), p.status, h('div', null,
        field('Noted Date', fmtDate(p.notedDate)),
        field('Resolved Date', fmtDate(p.resolvedDate)),
        field('ICD-10', str(p.icd10)),
      ), p._epic)
    ));
  },

  medications(r) {
    if (!r.medications?.length) return empty('No medications');
    return h('div', null, ...r.medications.map(m =>
      card(str(m.name), m.status, h('div', null,
        field('Generic', str(m.generic)),
        field('Sig', str(m.sig)),
        field('Quantity', str(m.quantity)),
        field('Refills', str(m.refills)),
        field('Start Date', fmtDate(m.startDate)),
        field('End Date', fmtDate(m.endDate)),
        field('Prescriber', str(m.prescriber)),
      ), m._epic)
    ));
  },

  immunizations(r) {
    if (!r.immunizations?.length) return empty('No immunizations');
    return tableView(r.immunizations, [
      { key: 'name', label: 'Vaccine' },
      { key: 'date', label: 'Date', fmt: fmtDate },
      { key: 'status', label: 'Status' },
      { key: 'route', label: 'Route' },
      { key: 'site', label: 'Site' },
    ]);
  },

  visits(r) {
    if (!r.visits?.length) return empty('No visits');
    const sorted = [...r.visits].sort((a,b) => (b.date||'').localeCompare(a.date||''));
    return h('div', {className: 'timeline'}, ...sorted.map(v => {
      const dxList = (v.diagnoses||[]).map(d => tag(str(d.name || d.description), 'tag-yellow'));
      const orderList = (v.orders||[]).map(o => h('div', {style:'margin:2px 0'},
        h('span', null, str(o.name || o.description)), ' ',
        o.type ? tag(o.type, 'tag-gray') : '',
        o.status ? tag(o.status, 'tag-green') : '',
      ));
      const noteList = (v.notes||[]).map(n => h('div', {style:'margin:4px 0; padding:8px; background:#f8f9fa; border-radius:4px; font-size:0.85rem'},
        h('strong', null, str(n.type)), ' \u2014 ', str(n.author), h('br'),
        h('span', {style:'white-space:pre-wrap'}, (str(n.text)).slice(0, 500)),
        n.text?.length > 500 ? h('em', null, '...') : '',
      ));
      const title = [v.type, v.department].filter(Boolean).join(' — ') || v.provider || 'Visit';
      return card(
        title,
        fmtDate(v.date),
        h('div', null,
          field('Provider', str(v.provider)),
          field('Status', str(v.status)),
          v.reasonsForVisit?.length ? field('Reason', v.reasonsForVisit.map(r => typeof r === 'string' ? r : r.COMMENTS || r.ENC_REASON_ID || JSON.stringify(r)).join(', ')) : '',
          dxList.length ? h('div', {style:'margin:8px 0'}, h('strong',null,'Diagnoses: '), ...dxList) : '',
          orderList.length ? h('div', {style:'margin:8px 0'}, h('strong',null,'Orders:'), h('div',{style:'padding-left:12px'}, ...orderList)) : '',
          noteList.length ? h('div', {style:'margin:8px 0'}, h('strong',null,'Notes:'), ...noteList) : '',
        ),
        v._epic
      );
    }));
  },

  labResults(r) {
    if (!r.labResults?.length) return empty('No lab results');
    // Group by order
    const byOrder = new Map();
    r.labResults.forEach(l => {
      const k = l.orderName || 'Other';
      if (!byOrder.has(k)) byOrder.set(k, []);
      byOrder.get(k).push(l);
    });
    return h('div', null, ...Array.from(byOrder.entries()).map(([name, labs]) =>
      card(name, `${labs.length} results`, tableView(labs, [
        { key: 'component', label: 'Component' },
        { key: 'value', label: 'Value' },
        { key: 'unit', label: 'Units' },
        { key: 'referenceRange', label: 'Ref Range' },
        { key: 'flag', label: 'Flag', render: v => v ? tag(v, 'tag-red') : '\u2014' },
        { key: 'resultDate', label: 'Date', fmt: fmtDate },
      ]))
    ));
  },

  messages(r) {
    if (!r.messages?.length) return empty('No messages');
    const sorted = [...r.messages].sort((a,b) => (b.date||'').localeCompare(a.date||''));
    return h('div', null, ...sorted.map(m =>
      card(
        str(m.subject),
        fmtDateTime(m.date),
        h('div', null,
          field('From', str(m.from)),
          field('To', str(m.to)),
          field('Status', str(m.status)),
          m.body ? h('div', {style:'margin-top:8px; padding:12px; background:#f8f9fa; border-radius:4px; white-space:pre-wrap; font-size:0.85rem; max-height:200px; overflow:auto'}, m.body) : '',
        ),
        m._epic
      )
    ));
  },

  documents(r) {
    if (!r.documents?.length) return empty('No documents');
    return h('div', null, ...r.documents.map(d =>
      card(str(d.type), fmtDate(d.date), h('div', null,
        field('Status', str(d.status)),
        field('Author', str(d.author)),
        field('Department', str(d.department)),
      ), d._epic)
    ));
  },

  referrals(r) {
    if (!r.referrals?.length) return empty('No referrals');
    return h('div', null, ...r.referrals.map(ref =>
      card(str(ref.reason), ref.status, h('div', null,
        field('Referring', str(ref.referringProvider)),
        field('Referred To', str(ref.referredToProvider)),
        field('Entry Date', fmtDate(ref.entryDate)),
        field('Expiration', fmtDate(ref.expirationDate)),
        field('Class', str(ref.referralClass)),
      ), ref._epic)
    ));
  },

  coverage(r) {
    if (!r.coverage?.length) return empty('No insurance coverage');
    return h('div', null, ...r.coverage.map(c =>
      card(str(c.planName), c.status, h('div', null,
        field('Payor', str(c.payor)),
        field('Type', str(c.type)),
        field('Group', str(c.groupName) + (c.groupNumber ? ` (#${c.groupNumber})` : '')),
        field('Member ID', str(c.memberId)),
        field('Effective', `${fmtDate(c.effectiveDate)} \u2014 ${fmtDate(c.terminationDate)}`),
      ), c._epic)
    ));
  },

  billing(r) {
    const b = r.billing;
    if (!b) return empty('No billing data');
    const sections = [];
    if (b.charges?.length) {
      sections.push(h('h3', {style:'margin:16px 0 8px'}, `Charges (${b.charges.length})`));
      sections.push(tableView(b.charges, [
        { key: 'description', label: 'Description' },
        { key: 'amount', label: 'Amount', render: v => v != null ? `$${Number(v).toFixed(2)}` : '\u2014' },
        { key: 'serviceDate', label: 'Date', fmt: fmtDate },
        { key: 'status', label: 'Status' },
      ]));
    }
    if (b.payments?.length) {
      sections.push(h('h3', {style:'margin:16px 0 8px'}, `Payments (${b.payments.length})`));
      sections.push(tableView(b.payments, [
        { key: 'amount', label: 'Amount', render: v => v != null ? `$${Number(v).toFixed(2)}` : '\u2014' },
        { key: 'date', label: 'Date', fmt: fmtDate },
        { key: 'type', label: 'Type' },
      ]));
    }
    if (b.claims?.length) {
      sections.push(h('h3', {style:'margin:16px 0 8px'}, `Claims (${b.claims.length})`));
      sections.push(tableView(b.claims, [
        { key: 'claimNumber', label: 'Claim #' },
        { key: 'totalCharge', label: 'Total', render: v => v != null ? `$${Number(v).toFixed(2)}` : '\u2014' },
        { key: 'status', label: 'Status' },
        { key: 'serviceDate', label: 'Date', fmt: fmtDate },
      ]));
    }
    return h('div', null, ...sections.length ? sections : [empty('No billing entries')]);
  },

  familyHistory(r) {
    if (!r.familyHistory?.length) return empty('No family history');
    return h('div', null, ...r.familyHistory.map(f =>
      card(str(f.relation), null, h('div', null,
        field('Condition', str(f.condition)),
        field('ICD-10', str(f.icd10)),
        field('Age at Onset', str(f.ageAtOnset)),
      ), f._epic)
    ));
  },

  socialHistory(r) {
    const s = r.socialHistory;
    if (!s) return empty('No social history');
    return card('Social History', null, h('div', null,
      field('Tobacco Use', str(s.tobaccoUse)),
      field('Alcohol Use', str(s.alcoholUse)),
    ), s._epic);
  },

  surgicalHistory(r) {
    if (!r.surgicalHistory?.length) return empty('No surgical history');
    return h('div', null, ...r.surgicalHistory.map(s =>
      card(str(s.procedure), null, h('div', null,
        field('Date', fmtDate(s.date)),
      ), s._epic)
    ));
  },

  episodes(r) {
    if (!r.episodes?.length) return empty('No episodes');
    return h('div', null, ...r.episodes.map(e =>
      card(str(e.name), e.status, h('div', null,
        field('Start', fmtDate(e.startDate)),
        field('End', fmtDate(e.endDate)),
      ), e._epic)
    ));
  },

  goals(r) {
    if (!r.goals?.length) return empty('No goals');
    return h('div', null, ...r.goals.map(g =>
      card(str(g.name), g.status, h('div', null,
        field('Start', fmtDate(g.startDate)),
        field('Target', fmtDate(g.targetDate)),
        field('Category', str(g.category)),
      ), g._epic)
    ));
  },

  questionnaireResponses(r) {
    if (!r.questionnaireResponses?.length) return empty('No questionnaires');
    return h('div', null, ...r.questionnaireResponses.map(q =>
      card(str(q.name), fmtDate(q.date), h('div', null,
        field('Status', str(q.status)),
        field('Score', str(q.score)),
        q.answers?.length ? h('div', {style:'margin-top:8px'},
          h('strong', null, 'Responses:'),
          h('div', {style:'padding-left:12px; margin-top:4px'},
            ...q.answers.map(a => h('div', {style:'margin:2px 0'},
              h('span', {style:'color:var(--muted)'}, str(a.question) + ': '),
              h('span', null, str(a.answer)),
            ))
          )
        ) : '',
      ), q._epic)
    ));
  },
};

function empty(msg) {
  return h('div', {className: 'empty-state'}, h('div', {className: 'icon'}, '\ud83d\udcad'), h('p', null, msg));
}

function tableView(items, cols) {
  return h('table', {className: 'data-table'},
    h('thead', null, h('tr', null, ...cols.map(c => h('th', null, c.label)))),
    h('tbody', null, ...items.map(item =>
      h('tr', null, ...cols.map(c => {
        const val = item[c.key];
        let display;
        if (c.render) display = c.render(val);
        else if (c.fmt) display = c.fmt(val);
        else display = str(val);
        return h('td', null, typeof display === 'string' ? display : display);
      }))
    ))
  );
}

// ─── Navigation & Init ───────────────────────
function renderSidebar() {
  const nav = document.getElementById('sidebar');
  nav.innerHTML = '';
  SECTIONS.forEach(s => {
    const countFn = s.count || (r => Array.isArray(r[s.key]) ? r[s.key].length : 0);
    const count = countFn(HR);
    const btn = h('button', { onClick: () => showSection(s.key) },
      h('span', null, s.icon),
      h('span', null, s.label),
      count > 0 ? h('span', {className: 'badge'}, String(count)) : '',
    );
    btn.dataset.key = s.key;
    nav.appendChild(btn);
  });
}

function renderBanner() {
  const d = HR.demographics;
  const banner = document.getElementById('patient-banner');
  banner.innerHTML = '';
  [d.name, `DOB: ${fmtDate(d.dateOfBirth)}`, d.sex, d.phone, d.email].filter(Boolean).forEach(v => {
    banner.appendChild(h('span', null, v));
  });
}

function showSection(key) {
  const main = document.getElementById('content');
  main.innerHTML = '';
  const section = SECTIONS.find(s => s.key === key);
  if (!section) return;

  // Update active nav
  document.querySelectorAll('nav button').forEach(b => b.classList.toggle('active', b.dataset.key === key));

  const title = h('div', {className: 'section-title'}, h('span', null, section.icon), ` ${section.label}`);
  main.appendChild(title);

  const renderer = renderers[key];
  if (renderer) {
    const content = renderer(HR);
    if (content) main.appendChild(typeof content === 'string' ? h('p', null, content) : content);
  } else {
    main.appendChild(h('pre', {className: 'json'}, JSON.stringify(HR[key], null, 2)));
  }

  // Update URL hash
  history.replaceState(null, '', '#' + key);
}

// Load data and boot
fetch('data.json')
  .then(r => r.json())
  .then(data => {
    HR = data;
    renderSidebar();
    renderBanner();
    const hash = location.hash.slice(1);
    showSection(hash && SECTIONS.find(s => s.key === hash) ? hash : 'demographics');
  })
  .catch(err => {
    document.getElementById('content').innerHTML = `<div class="empty-state"><p>Failed to load data: ${err.message}</p></div>`;
  });
