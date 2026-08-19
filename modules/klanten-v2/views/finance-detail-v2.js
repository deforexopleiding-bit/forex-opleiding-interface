// modules/klanten-v2/views/finance-detail-v2.js
//
// V2 finance-detail als NATIVE in-shell view — factuur EN abonnement.
// Analoog aan modules/klanten-v2/views/offerte-detail-v2.js: renders in
// de shell-content-area (geen iframe/modal), erft .content{overflow-y:auto}
// scroll gratis. Sidebar+topbar+tabs blijven zichtbaar.
//
// URL-contract:
//   ?v2preview=finance&invoice_id=<uuid>      → factuur-detail
//   ?v2preview=finance&subscription_id=<uuid> → abonnement-detail
//
// Data-bronnen (allen bestaand):
//   /api/finance-invoices?invoice_id=X&page_size=1     — factuur-basis
//   /api/finance-invoice-lines?invoice_id=X            — line-items
//   /api/finance-invoice-creditnotes?invoice_id=X      — creditnota's
//   /api/finance-invoice-pdf?invoice_id=X              — signed PDF-URL
//   /api/sales-customer-subscriptions?customer_id=X    — abo-basis
//     (voor abo: customer_id komt uit finance-v2 state _sub.data waar
//      subscription al gefetch't is; fallback GET met customer_id)
//
// Acties (finance-mutaties ronde):
//   FACTUUR — status-conditional buttons:
//     · concept              → Verzenden + Aanpassen + Crediteren
//     · sent/open/overdue    → Betaling registreren + Verzenden + Crediteren
//     · partially_paid       → Betaling registreren + Betalingen terugdraaien + Crediteren
//     · paid                 → Betalingen terugdraaien + Crediteren
//     · credited             → (geen mutaties)
//     Endpoints: POST /api/finance-invoice-register-payment | -remove-payment |
//                -send | -update | -credit
//     RBAC (server-side): finance.invoice.{payment.register|payment.remove|
//                          send|update|credit}
//   ABONNEMENT — 3 buttons:
//     · Aanpassen  (verborgen als has_any_invoice) → /api/sales-subscription-update
//     · Uitstellen                                  → /api/sales-subscription-postpone
//     · Deactiveren                                 → /api/sales-subscription-delete
//   Modals: dynamic import uit views/modals/{invoice-*,subscription-actions,
//           invoice-remove-payment}.js. Na success: _invLoad(id) of _subLoad(id).
//   Fail-soft: server-403 → toast met server-message (geen client-crash).
//
// Dormant (deel van finance-v2, bereikbaar via ?v2preview=finance).

(function () {
  if (!window.DFO) { console.error('[fnd] DFO shell niet geladen.'); return; }

  // ── Utilities ────────────────────────────────────────────────────────────
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[c]));
  const eur = (v) => v == null ? '—' : Number(v).toLocaleString('nl-NL', { style: 'currency', currency: 'EUR', minimumFractionDigits: 2 });
  const eurC = (c) => c == null ? '—' : eur(Number(c) / 100);
  const fmtDate = (iso) => iso ? new Date(iso).toLocaleDateString('nl-NL', { day: 'numeric', month: 'long', year: 'numeric' }) : '—';

  const INV_STATUS = {
    open:                { l: 'Open',              cls: 'fnd-pill-info' },
    overdue:             { l: 'Verlopen',          cls: 'fnd-pill-danger' },
    paid:                { l: 'Betaald',           cls: 'fnd-pill-ok' },
    partially_paid:      { l: 'Deels betaald',     cls: 'fnd-pill-warn' },
    credited:            { l: 'Gecrediteerd',      cls: 'fnd-pill-neutral' },
    partially_credited:  { l: 'Deels gecrediteerd',cls: 'fnd-pill-neutral' },
    concept:             { l: 'Concept',           cls: 'fnd-pill-neutral' },
    draft:               { l: 'Concept',           cls: 'fnd-pill-neutral' },
  };
  const SUB_STATUS = {
    actief:      { l: 'Actief',      cls: 'fnd-pill-ok' },
    gepauzeerd:  { l: 'Gepauzeerd',  cls: 'fnd-pill-warn' },
    achterstand: { l: 'Achterstand', cls: 'fnd-pill-danger' },
    beeindigd:   { l: 'Beëindigd',   cls: 'fnd-pill-neutral' },
    afgelopen:   { l: 'Afgelopen',   cls: 'fnd-pill-neutral' },
  };
  function pill(map, key) {
    const m = map[String(key || '').toLowerCase()] || { l: key || '—', cls: 'fnd-pill-neutral' };
    return `<span class="fnd-pill ${m.cls}">${esc(m.l)}</span>`;
  }

  // ── State ────────────────────────────────────────────────────────────────
  const _inv = { id: null, loading: false, error: null, data: null, lines: [], creditNotes: [], seq: 0 };
  const _sub = { id: null, loading: false, error: null, data: null, seq: 0 };

  function _ensureCss() {
    if (document.getElementById('fnd-native-css')) return;
    const st = document.createElement('style');
    st.id = 'fnd-native-css';
    st.textContent = `
      .fnd-app { padding: 4px 4px 40px; }
      .fnd-back-row { padding: 0 20px 8px; }
      .fnd-head {
        display: flex; flex-wrap: wrap; align-items: flex-start; justify-content: space-between;
        gap: 16px; margin: 4px 20px 20px;
        padding-bottom: 16px; border-bottom: 1px solid var(--border, #E2E7EE);
      }
      .fnd-head-l { flex: 1; min-width: 260px; }
      .fnd-title { font-size: 22px; font-weight: 700; margin: 4px 0 6px; color: var(--text, #111721); }
      .fnd-meta { font-size: 12.5px; color: var(--text-2, #586374); display: flex; flex-wrap: wrap; align-items: center; gap: 8px; }
      .fnd-actions { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; }
      .fnd-pill { display: inline-flex; align-items: center; gap: 5px; padding: 2px 10px; border-radius: 12px; font-size: 11px; font-weight: 600; border: 1px solid; }
      .fnd-pill-info    { background: var(--blue-soft,   #E8F0FC); color: var(--blue,   #1B5FBF); border-color: var(--blue-line,   #B7D0F2); }
      .fnd-pill-ok      { background: var(--emerald-soft,#E4F5EE); color: var(--emerald,#07835A); border-color: var(--emerald-line,#A9DFC9); }
      .fnd-pill-warn    { background: var(--amber-soft,  #FFF4E5); color: var(--amber,  #C2700A); border-color: var(--amber-line,  #F4D8A1); }
      .fnd-pill-danger  { background: var(--rose-soft,   #FDECEE); color: var(--rose,   #C22B3E); border-color: var(--rose-line,   #F5C2C9); }
      .fnd-pill-neutral { background: var(--surface-2,   #F2F4F7); color: var(--text-2, #586374); border-color: var(--border,      #E2E7EE); }

      .fnd-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 14px; margin: 0 20px 14px; }
      @media (max-width: 720px) { .fnd-grid { grid-template-columns: 1fr; } }
      .fnd-card {
        background: var(--surface, #FFFFFF);
        border: 1px solid var(--border-strong, #C9D2DE);
        border-radius: 10px; padding: 0; overflow: hidden;
      }
      .fnd-card-wide { margin: 0 20px 14px; }
      .fnd-card-h {
        padding: 10px 14px;
        background: var(--surface-2, #F2F4F7);
        border-bottom: 1px solid var(--border, #E2E7EE);
        font-size: 12px; font-weight: 700; color: var(--text, #111721);
        text-transform: uppercase; letter-spacing: .04em;
      }
      .fnd-card-b { padding: 12px 14px; font-size: 13px; line-height: 1.55; color: var(--text, #111721); }
      .fnd-row { display: flex; justify-content: space-between; align-items: center; padding: 3px 0; gap: 12px; }
      .fnd-row .lbl { color: var(--text-2, #586374); }
      .fnd-row a { color: var(--m, #6D3FD4); text-decoration: none; }
      .fnd-row a:hover { text-decoration: underline; }

      .fnd-tbl-wrap { overflow-x: auto; }
      .fnd-tbl { width: 100%; border-collapse: collapse; font-size: 12.5px; font-variant-numeric: tabular-nums; }
      .fnd-tbl th, .fnd-tbl td { padding: 8px 12px; text-align: left; }
      .fnd-tbl thead th {
        background: var(--surface-2, #F2F4F7); font-size: 11px; text-transform: uppercase; letter-spacing: .04em;
        color: var(--text-2, #586374); border-bottom: 1px solid var(--border, #E2E7EE);
      }
      .fnd-tbl tbody tr + tr td { border-top: 1px solid var(--border, #E2E7EE); }
      .fnd-tbl .num    { text-align: right; }
      .fnd-tbl .center { text-align: center; }
      .fnd-total-big {
        display: flex; justify-content: space-between; align-items: center;
        background: var(--surface-2, #F2F4F7); padding: 10px 12px; border-radius: 8px; margin-top: 8px;
        font-weight: 700; font-size: 15px; color: var(--text, #111721);
      }

      .fnd-timeline { list-style: none; padding: 0; margin: 0; }
      .fnd-timeline li {
        position: relative; padding: 6px 0 6px 20px; font-size: 12.5px; color: var(--text-2, #586374);
        border-left: 2px solid var(--border, #E2E7EE); margin-left: 6px;
      }
      .fnd-timeline li::before {
        content: ''; position: absolute; left: -5px; top: 12px; width: 8px; height: 8px;
        background: var(--m, #6D3FD4); border-radius: 50%;
      }
      .fnd-timeline li b { color: var(--text, #111721); font-weight: 500; }
      .fnd-empty { color: var(--text-3, #8B95A5); font-style: italic; padding: 8px 0; }
    `;
    document.head.appendChild(st);
  }

  // ── FACTUUR ────────────────────────────────────────────────────────────
  async function _invLoad(id) {
    if (_inv.loading) return;
    const seq = ++_inv.seq;
    _inv.loading = true; _inv.error = null;
    try {
      // Basis-fetch
      const j = await window.KV.authedJson('/api/finance-invoices?invoice_id=' + encodeURIComponent(id) + '&page_size=1');
      if (seq !== _inv.seq) return;
      _inv.data = (j?.items && j.items[0]) || null;
      // Parallel: lines + creditnotes (fail-tolerant)
      const [linesRes, cnRes] = await Promise.allSettled([
        window.KV.authedJson('/api/finance-invoice-lines?invoice_id=' + encodeURIComponent(id)),
        window.KV.authedJson('/api/finance-invoice-creditnotes?invoice_id=' + encodeURIComponent(id)),
      ]);
      if (seq !== _inv.seq) return;
      _inv.lines = (linesRes.status === 'fulfilled' && Array.isArray(linesRes.value?.lines)) ? linesRes.value.lines : [];
      _inv.creditNotes = (cnRes.status === 'fulfilled' && Array.isArray(cnRes.value?.credit_notes)) ? cnRes.value.credit_notes : [];
    } catch (e) {
      if (seq !== _inv.seq) return;
      _inv.error = e?.message || 'load failed';
      console.warn('[fnd] invoice load fail:', _inv.error);
    } finally {
      if (seq === _inv.seq) _inv.loading = false;
      try { window.DFO.render(); } catch (_) {}
    }
  }

  window.__fnRenderInv = function (id) {
    const trimmed = String(id || '').trim();
    if (!trimmed) return `<div style="padding:24px;color:var(--rose)">Geen invoice-id in URL.</div>`;
    _ensureCss();
    if (_inv.id !== trimmed) {
      _inv.id = trimmed; _inv.data = null; _inv.lines = []; _inv.creditNotes = []; _inv.error = null;
      queueMicrotask(() => _invLoad(trimmed));
    } else if (!_inv.loading && !_inv.data && !_inv.error) {
      queueMicrotask(() => _invLoad(trimmed));
    }

    if (!_inv.data && !_inv.error) {
      return `<div class="fnd-app">
        <div class="fnd-back-row"><button class="btn btn-ghost btn-sm" onclick="__fnBack('invoices')">← Terug naar Facturen</button></div>
        <div class="fnd-card fnd-card-wide"><div class="fnd-card-b" style="color:var(--text-2)">Laden…</div></div>
      </div>`;
    }
    if (_inv.error) {
      return `<div class="fnd-app">
        <div class="fnd-back-row"><button class="btn btn-ghost btn-sm" onclick="__fnBack('invoices')">← Terug naar Facturen</button></div>
        <div class="fnd-card fnd-card-wide"><div class="fnd-card-b" style="color:var(--rose)">Kon factuur niet laden: ${esc(_inv.error)}</div></div>
      </div>`;
    }
    return _invRenderBody(_inv.data);
  };

  function _invRenderBody(inv) {
    const st = inv.status || 'concept';
    const tlHref = inv.tl_invoice_id ? `https://focus.teamleader.eu/invoice_detail.php?id=${encodeURIComponent(inv.tl_invoice_id)}` : null;
    const custHref = inv.customer_id ? `/modules/klanten.html?id=${encodeURIComponent(inv.customer_id)}` : null;
    // Status-driven action-buttons: waar mag welke mutatie draaien?
    const paidNum = Number(inv.paid || inv.amount_paid || 0);
    const totNum  = Number(inv.amount_total || inv.total || 0);
    const isConcept   = st === 'concept' || st === 'draft';
    const isCredited  = st === 'credited' || st === 'partially_credited';
    const isPaid      = st === 'paid';
    const canRegister = !isConcept && !isCredited && paidNum + 0.005 < totNum;  // open bedrag
    const canRemove   = !isConcept && paidNum > 0;                              // heeft payments
    const canCredit   = !isConcept;                                             // conceptless
    const canSend     = true;                                                   // ook resend na send
    const canUpdate   = isConcept;                                              // enkel concept

    // Timeline (v1-parity: aangemaakt / vervalt / (deels)betaald / creditnota's)
    const events = [];
    if (inv.issue_date) events.push(`Aangemaakt op <b>${esc(fmtDate(inv.issue_date))}</b>`);
    if (inv.due_date)   events.push(`Vervalt op <b>${esc(fmtDate(inv.due_date))}</b>`);
    if (inv.paid_date)  events.push(`Betaald op <b>${esc(fmtDate(inv.paid_date))}</b>`);
    if (Number(inv.paid) > 0 && !inv.paid_date) events.push(`Deels betaald: <b>${eur(inv.paid)}</b>`);
    for (const cn of _inv.creditNotes) {
      events.push(`Creditnota <b>${esc(cn.number || '—')}</b> op ${esc(fmtDate(cn.date))} · ${eur(cn.amount_total)}`);
    }

    // Line-items — v1 hangt line_total_excl in aparte field. Fallback zelf berekenen.
    // Aggregate voor totalen-blok (subtotaal excl + BTW per tarief + totaal incl).
    let totalExcl = 0;
    const btwByRate = {};
    const linesHtml = _inv.lines.length ? _inv.lines.map(l => {
      const q = Number(l.quantity) || 0;
      const p = Number(l.unit_price_excl) || 0;
      const rate = Number(l.tax_rate) || 0;
      const subExcl = Number(l.line_total_excl) || (q * p);
      const btwAmt = subExcl * rate / 100;
      const incl = subExcl + btwAmt;
      totalExcl += subExcl;
      if (rate > 0) btwByRate[rate] = (btwByRate[rate] || 0) + btwAmt;
      // BROK FINANCE-INVOICE-DETAIL: BTW €-kolom naast BTW% zodat medewerker
      // per regel direct ziet welk bedrag onder welk tarief valt (was tot
      // dusver alleen aggregate in totalen-blok).
      return `<tr>
        <td>${esc(l.description || '—')}</td>
        <td class="center">${q}×</td>
        <td class="num">${eur(p)}</td>
        <td class="center">${rate}%</td>
        <td class="num">${eur(btwAmt)}</td>
        <td class="num">${eur(subExcl)}</td>
        <td class="num"><b>${eur(incl)}</b></td>
      </tr>`;
    }).join('') : '<tr><td colspan="7" style="text-align:center;color:var(--text-3);padding:20px">Geen regels</td></tr>';
    const totalBtw = Object.values(btwByRate).reduce((a, b) => a + b, 0);
    const totalIncl = totalExcl + totalBtw;
    // Totalen-blok (1-op-1 met offerte-detail-v2 patroon: subtotaal excl + BTW
    // per tarief in oplopende volgorde + totaal incl).
    const totalsHtml = _inv.lines.length ? `
      <div style="padding: 8px 12px 12px;">
        <div class="fnd-row"><span class="lbl">Subtotaal excl. BTW</span><span class="num mono">${eur(totalExcl)}</span></div>
        ${Object.keys(btwByRate).sort((a, b) => Number(a) - Number(b)).map(r =>
          `<div class="fnd-row"><span class="lbl">BTW ${r}%</span><span class="num mono">${eur(btwByRate[r])}</span></div>`
        ).join('')}
        <div class="fnd-total-big"><span>Totaal incl. BTW</span><span>${eur(totalIncl)}</span></div>
      </div>` : '';

    return `<div class="fnd-app">
      <div class="fnd-back-row"><button class="btn btn-ghost btn-sm" onclick="__fnBack('invoices')">← Terug naar Facturen</button></div>
      <div class="fnd-head">
        <div class="fnd-head-l">
          <h1 class="fnd-title">Factuur ${esc(inv.invoice_number || ('#' + String(inv.id).slice(0, 8)))}</h1>
          <div class="fnd-meta">
            ${pill(INV_STATUS, st)}
            <span>${esc(inv.customer_name || '—')}</span>
            <span>· ${esc(fmtDate(inv.issue_date))}</span>
            ${inv.tl_invoice_id ? `<span class="fnd-pill fnd-pill-info">TL-gekoppeld</span>` : ''}
          </div>
        </div>
        <div class="fnd-actions">
          ${inv.tl_invoice_id
            ? `<button class="btn btn-ghost" onclick="__fnInvPdf('${esc(inv.tl_invoice_id)}')" title="PDF downloaden">📄 PDF</button>`
            : `<button class="btn btn-ghost" disabled title="Factuur is nog niet naar TeamLeader gepusht — geen PDF beschikbaar" style="opacity:.5;cursor:not-allowed">📄 PDF (n.v.t.)</button>`}
          ${tlHref ? `<a class="btn btn-ghost" href="${tlHref}" target="_blank" rel="noopener">↗ Open in TL</a>` : ''}
          ${canRegister ? `<button class="btn btn-primary" onclick="__fnInvPay()" title="Handmatige betaling registreren + naar TL synchroniseren">💶 Betaling registreren</button>` : ''}
          ${canRemove ? `<button class="btn" onclick="__fnInvRemovePay()" title="ALLE geregistreerde betalingen terugdraaien in TeamLeader (destructief)" style="background:var(--rose-soft, #FDECEE); border-color:var(--rose-line, #F5C2C9); color:var(--rose, #C22B3E)">↩ Betaling(en) terugdraaien</button>` : ''}
          ${canSend ? `<button class="btn" onclick="__fnInvSend()" title="Factuur per e-mail versturen (mail-template kiezen in modal)">✉ ${isPaid || isCredited ? 'Opnieuw versturen' : 'Verzenden'}</button>` : ''}
          ${canUpdate ? `<button class="btn" onclick="__fnInvUpdate()" title="Concept-factuur aanpassen (regels, PO-nummer, taal)">✎ Aanpassen</button>` : ''}
          ${canCredit ? `<button class="btn" onclick="__fnInvCredit()" title="Creditnota aanmaken op deze factuur (destructief in TL-audit)" style="background:var(--amber-soft, #FFF4E5); border-color:var(--amber-line, #F4D8A1); color:var(--amber, #C2700A)">↺ Crediteren</button>` : ''}
        </div>
      </div>

      <div class="fnd-grid">
        <div class="fnd-card">
          <div class="fnd-card-h">Klant</div>
          <div class="fnd-card-b">
            <div style="font-weight:700;font-size:14px;margin-bottom:4px">${esc(inv.customer_name || '—')}</div>
            <div class="fnd-row"><span class="lbl">Entiteit</span><span>${esc(inv.tl_department_name || inv.tl_department_id || '—')}</span></div>
            <div class="fnd-row"><span class="lbl">E-mail</span><span>${inv.customer_email ? `<a href="mailto:${encodeURIComponent(inv.customer_email)}">${esc(inv.customer_email)}</a>` : '—'}</span></div>
            <div class="fnd-row"><span class="lbl">Telefoon</span><span>${inv.customer_phone ? `<a href="tel:${encodeURIComponent(inv.customer_phone)}">${esc(inv.customer_phone)}</a>` : '—'}</span></div>
            ${custHref ? `<div style="margin-top:10px"><a class="btn btn-ghost btn-sm" href="${custHref}" target="_blank" rel="noopener">Klant-detail →</a></div>` : ''}
          </div>
        </div>
        <div class="fnd-card">
          <div class="fnd-card-h">Factuur-info</div>
          <div class="fnd-card-b">
            <div class="fnd-row"><span class="lbl">Factuurdatum</span><span>${esc(fmtDate(inv.issue_date))}</span></div>
            <div class="fnd-row"><span class="lbl">Vervaldatum</span><span>${esc(fmtDate(inv.due_date))}</span></div>
            <div class="fnd-row"><span class="lbl">Totaal</span><span><b>${eur(inv.amount_total || inv.total)}</b></span></div>
            <div class="fnd-row"><span class="lbl">Betaald</span><span>${eur(inv.paid || 0)}</span></div>
            <div class="fnd-row"><span class="lbl">Open</span><span><b style="color:${(inv.open || 0) > 0 ? 'var(--rose)' : 'var(--emerald)'}">${eur(inv.open || 0)}</b></span></div>
          </div>
        </div>
      </div>

      <div class="fnd-card fnd-card-wide">
        <div class="fnd-card-h">Inhoud (${_inv.lines.length} regel${_inv.lines.length === 1 ? '' : 's'})</div>
        <div class="fnd-tbl-wrap">
          <table class="fnd-tbl">
            <thead><tr>
              <th>Regel</th><th class="center">Aantal</th><th class="num">Prijs excl.</th>
              <th class="center">BTW %</th><th class="num">BTW €</th><th class="num">Subtotaal excl.</th><th class="num">Incl. BTW</th>
            </tr></thead>
            <tbody>${linesHtml}</tbody>
          </table>
          ${totalsHtml}
        </div>
      </div>

      <div class="fnd-grid">
        <div class="fnd-card">
          <div class="fnd-card-h">Creditnota's (${_inv.creditNotes.length})</div>
          <div class="fnd-card-b">
            ${_inv.creditNotes.length ? _inv.creditNotes.map(cn => `
              <div class="fnd-row">
                <span>${esc(cn.number || '—')} · ${esc(fmtDate(cn.date))}</span>
                <span class="num"><b>${eur(cn.amount_total)}</b></span>
              </div>`).join('') : '<div class="fnd-empty">Geen creditnota\'s</div>'}
          </div>
        </div>
        <div class="fnd-card">
          <div class="fnd-card-h">Activiteit</div>
          <div class="fnd-card-b">
            ${events.length ? `<ul class="fnd-timeline">${events.map(e => `<li>${e}</li>`).join('')}</ul>` : '<div class="fnd-empty">Geen activiteit</div>'}
          </div>
        </div>
      </div>
    </div>`;
  }

  // ── ABONNEMENT ─────────────────────────────────────────────────────────
  // Data-strategie: sales-customer-subscriptions retourneert ALLE abo's van
  // een klant. We hebben op de abonnementen-lijst geen aparte per-sub detail-
  // endpoint. Werkt zo: eerst probeer we het uit finance-v2 _sub.data state
  // (waar de lijst-fetch al draaide). Als de sub niet in de state zit
  // (URL-share/refresh scenario), fallback: haal alle subs van klant op via
  // customer_id (die zit als kolom op elke sub-rij in de lijst).
  async function _subLoad(id) {
    if (_sub.loading) return;
    const seq = ++_sub.seq;
    _sub.loading = true; _sub.error = null;
    try {
      // Poging 1: check of finance-v2 module-state al de sub heeft
      // (finance-v2 exposeert window.__finGetSubById via lookup in _sub.data)
      const fv2Sub = (typeof window.__finGetSubById === 'function' ? window.__finGetSubById(id) : null)
        || _findInLocalSubList(id);
      if (fv2Sub) {
        if (seq !== _sub.seq) return;
        _sub.data = fv2Sub;
        return;
      }
      // Fallback: geen basis-endpoint per sub-id. Rapporteer.
      _sub.error = 'Abonnement niet in de huidige lijst. Ga eerst naar de Abonnementen-tab (hele lijst laadt) en klik dan de rij.';
    } catch (e) {
      if (seq !== _sub.seq) return;
      _sub.error = e?.message || 'load failed';
      console.warn('[fnd] sub load fail:', _sub.error);
    } finally {
      if (seq === _sub.seq) _sub.loading = false;
      try { window.DFO.render(); } catch (_) {}
    }
  }
  // Fallback: zoek in finance-v2 _sub.data (private state, exposed via
  // window.__finGetSubById als toegevoegd; anders scan via DOM-less shortcut).
  function _findInLocalSubList(id) {
    try {
      // finance-v2 IIFE exposeert geen state direct; we vertrouwen op de
      // dev-shim __finGetSubById die daar wordt gedefineerd.
      return null;
    } catch (_) { return null; }
  }

  window.__fnRenderSub = function (id) {
    const trimmed = String(id || '').trim();
    if (!trimmed) return `<div style="padding:24px;color:var(--rose)">Geen subscription-id in URL.</div>`;
    _ensureCss();
    if (_sub.id !== trimmed) {
      _sub.id = trimmed; _sub.data = null; _sub.error = null;
      queueMicrotask(() => _subLoad(trimmed));
    } else if (!_sub.loading && !_sub.data && !_sub.error) {
      queueMicrotask(() => _subLoad(trimmed));
    }

    if (!_sub.data && !_sub.error) {
      return `<div class="fnd-app">
        <div class="fnd-back-row"><button class="btn btn-ghost btn-sm" onclick="__fnBack('subscriptions')">← Terug naar Abonnementen</button></div>
        <div class="fnd-card fnd-card-wide"><div class="fnd-card-b" style="color:var(--text-2)">Laden…</div></div>
      </div>`;
    }
    if (_sub.error) {
      return `<div class="fnd-app">
        <div class="fnd-back-row"><button class="btn btn-ghost btn-sm" onclick="__fnBack('subscriptions')">← Terug naar Abonnementen</button></div>
        <div class="fnd-card fnd-card-wide"><div class="fnd-card-b" style="color:var(--rose)">${esc(_sub.error)}</div></div>
      </div>`;
    }
    return _subRenderBody(_sub.data);
  };

  function _subRenderBody(sub) {
    const st = sub.status || '—';
    const tlHref = sub.teamleader_subscription_id
      ? `https://focus.teamleader.eu/subscriptions/${encodeURIComponent(sub.teamleader_subscription_id)}`
      : null;
    const custHref = sub.customer_id
      ? `/modules/klanten.html?id=${encodeURIComponent(sub.customer_id)}&tab=abonnementen`
      : null;

    // Line-items veld-namen (bron: api/sales-subscriptions-list.js:143 +
    // api/sales-customer-subscriptions.js:99). Per-regel:
    //   description (label)
    //   amount           (bedrag EXCL. BTW, 1 stuks/termijn)
    //   vat_percentage   (BTW-tarief)
    // Er is GEEN quantity / unit_price_excl in line_items — elke regel telt
    // 1x per termijn.
    const lines = Array.isArray(sub.line_items) ? sub.line_items : [];
    let totalExcl = 0;
    const btwByRate = {};
    const linesHtml = lines.length ? lines.map(l => {
      const excl = Number(l.amount) || 0;
      const rate = Number(l.vat_percentage) || 0;
      const btwAmt = excl * rate / 100;
      const incl = excl + btwAmt;
      totalExcl += excl;
      if (rate > 0) btwByRate[rate] = (btwByRate[rate] || 0) + btwAmt;
      return `<tr>
        <td>${esc(l.description || l.product_name || '—')}</td>
        <td class="num">${eur(excl)}</td>
        <td class="center">${rate}%</td>
        <td class="num"><b>${eur(incl)}</b></td>
      </tr>`;
    }).join('') : '<tr><td colspan="4" style="text-align:center;color:var(--text-3);padding:20px">Geen regels</td></tr>';
    const totalBtw = Object.values(btwByRate).reduce((a, b) => a + b, 0);
    const totalInclCalc = totalExcl + totalBtw;

    // Termijnbedrag: prefereer sub.amount_incl (aggregate uit endpoint,
    // regel 144 sales-subscriptions-list). Fallback op eigen berekening.
    const perTermIncl = sub.amount_incl != null ? Number(sub.amount_incl) : totalInclCalc;
    // Termijn-count: term_count (bron-veld op subscriptions-tabel).
    const termCount = sub.term_count || '—';

    // MRR-bijdrage berekening: v1 heeft geen billing_cycle op deze endpoint.
    // sales-mrr-report is de canonical source, maar hier hebben we alleen
    // 1 sub. Simpelste aanname: per_month = amount_incl (MRR = termijnbedrag
    // als billing_cycle='per_month'). Voor jaar/kwartaal wijkt af — daar
    // is de list-KPI accurater.
    const mrrIncl = perTermIncl;

    return `<div class="fnd-app">
      <div class="fnd-back-row"><button class="btn btn-ghost btn-sm" onclick="__fnBack('subscriptions')">← Terug naar Abonnementen</button></div>
      <div class="fnd-head">
        <div class="fnd-head-l">
          <h1 class="fnd-title">${esc(sub.description || 'Abonnement')}</h1>
          <div class="fnd-meta">
            ${pill(SUB_STATUS, st === 'active' ? 'actief' : (st === 'cancelled' ? 'beeindigd' : (st === 'paused' ? 'gepauzeerd' : st)))}
            <span>${esc(sub.customer_name || '—')}</span>
            <span>· ${esc(fmtDate(sub.start_date))} → ${esc(fmtDate(sub.end_date))}</span>
            ${sub.entity ? `<span>· ${esc(sub.entity)}</span>` : ''}
            ${sub.teamleader_subscription_id ? `<span class="fnd-pill fnd-pill-info">TL-gekoppeld</span>` : ''}
          </div>
        </div>
        <div class="fnd-actions">
          ${tlHref ? `<a class="btn btn-ghost" href="${tlHref}" target="_blank" rel="noopener">↗ Open in TL</a>` : ''}
          ${sub.has_any_invoice
            ? `<button class="btn" disabled title="Abonnement is al gefactureerd — aanpassen niet toegestaan. Gebruik crediteren + nieuw abo." style="opacity:.5;cursor:not-allowed">✎ Aanpassen (niet mogelijk)</button>`
            : `<button class="btn" onclick="__fnSubUpdate()" title="Abonnement aanpassen (omschrijving/bedrag/termijnen/data)">✎ Aanpassen</button>`}
          <button class="btn" onclick="__fnSubPostpone()" title="Uitstellen of verlengen (1-12 maanden). Push naar TeamLeader.">⏱ Uitstellen / verlengen</button>
          ${['cancelled', 'deactivated', 'completed'].includes(String(st || '').toLowerCase())
            ? ''
            : `<button class="btn" onclick="__fnSubDelete()" title="Abonnement deactiveren (lokaal + TL). Blijft in historie staan." style="background:var(--rose-soft, #FDECEE); border-color:var(--rose-line, #F5C2C9); color:var(--rose, #C22B3E)">⊘ Deactiveren</button>`}
        </div>
      </div>

      <div class="fnd-grid">
        <div class="fnd-card">
          <div class="fnd-card-h">Overzicht</div>
          <div class="fnd-card-b">
            <div class="fnd-row"><span class="lbl">Klant</span><span>${esc(sub.customer_name || '—')}</span></div>
            <div class="fnd-row"><span class="lbl">Entiteit</span><span>${esc(sub.entity || '—')}</span></div>
            <div class="fnd-row"><span class="lbl">Startdatum</span><span>${esc(fmtDate(sub.start_date))}</span></div>
            <div class="fnd-row"><span class="lbl">Einddatum</span><span>${esc(fmtDate(sub.end_date))}</span></div>
            <div class="fnd-row"><span class="lbl">Aantal termijnen</span><span>${termCount}</span></div>
          </div>
        </div>
        <div class="fnd-card">
          <div class="fnd-card-h">Bedragen</div>
          <div class="fnd-card-b">
            <div class="fnd-row"><span class="lbl">Per termijn (incl. BTW)</span><span><b>${eur(perTermIncl)}</b></span></div>
            <div class="fnd-row"><span class="lbl">Per termijn (excl. BTW)</span><span>${eur(totalExcl)}</span></div>
            <div class="fnd-row"><span class="lbl">BTW-som</span><span>${eur(totalBtw)}</span></div>
            <div class="fnd-row"><span class="lbl">Totaal contract (${termCount}× incl.)</span><span>${eur(typeof termCount === 'number' ? termCount * perTermIncl : perTermIncl * (Number(sub.term_count) || 1))}</span></div>
            <div class="fnd-row"><span class="lbl">MRR (indicatief)</span><span>${eur(mrrIncl)}</span></div>
          </div>
        </div>
      </div>

      <div class="fnd-card fnd-card-wide">
        <div class="fnd-card-h">Line-items (${lines.length}) — per termijn</div>
        <div class="fnd-tbl-wrap">
          <table class="fnd-tbl">
            <thead><tr>
              <th>Regel</th><th class="num">Excl. BTW</th><th class="center">BTW</th><th class="num">Incl. BTW</th>
            </tr></thead>
            <tbody>${linesHtml}</tbody>
          </table>
          ${lines.length ? `
          <div style="padding: 8px 12px 12px;">
            <div class="fnd-row"><span class="lbl">Subtotaal excl. BTW</span><span class="num mono">${eur(totalExcl)}</span></div>
            ${Object.keys(btwByRate).sort((a, b) => Number(a) - Number(b)).map(r =>
              `<div class="fnd-row"><span class="lbl">BTW ${r}%</span><span class="num mono">${eur(btwByRate[r])}</span></div>`
            ).join('')}
            <div class="fnd-total-big"><span>Totaal incl. BTW / termijn</span><span>${eur(perTermIncl)}</span></div>
          </div>` : ''}
        </div>
      </div>
    </div>`;
  }

  // ── Actions ─────────────────────────────────────────────────────────────
  // PDF-download: endpoint accepteert sinds BROK FINANCE-INVOICE-PDF (2026-08-19)
  // ook `invoice_id=` — dan lookup DB, self-heal via TL /invoices.list op
  // invoice_number bij ontbrekende tl_invoice_id, en 404 NOT_IN_TL als de
  // factuur echt niet in TL bestaat. We geven bij voorkeur invoice_id door
  // (via _inv.data.id) zodat de server kan zelf-helen; fallback op de
  // meegegeven tl_invoice_id-arg voor legacy callers.
  window.__fnInvPdf = async function (tlInvoiceId) {
    const localId = _inv?.data?.id || null;
    let qs;
    if (localId)          qs = 'invoice_id=' + encodeURIComponent(localId);
    else if (tlInvoiceId) qs = 'tl_invoice_id=' + encodeURIComponent(tlInvoiceId);
    else { window.KV.toast('Geen factuur-id beschikbaar'); return; }
    try {
      const j = await window.KV.authedJson('/api/finance-invoice-pdf?' + qs);
      if (j?.url) window.open(j.url, '_blank', 'noopener');
      else window.KV.toast('Geen PDF-URL beschikbaar');
    } catch (e) {
      const msg = String(e?.message || e || '');
      if (/PDF niet beschikbaar|NOT_IN_TL/i.test(msg)) {
        window.KV.toast('Geen TeamLeader-factuur — PDF niet beschikbaar.');
      } else {
        window.KV.toast('PDF ophalen mislukt: ' + (msg || 'onbekend'));
      }
    }
  };

  // ── Factuur-mutaties: dynamic imports naar v2-modals ────────────────────
  // De v2-modals (views/modals/invoice-*.js) zijn ES-modules; finance-
  // detail-v2 is een IIFE. Dynamic import() werkt cross-boundary. Na een
  // geslaagde mutatie: _invLoad(id) opnieuw voor verse detail-data.
  async function _refreshInv() { if (_inv.id) _invLoad(_inv.id); }
  function _invOrToast() {
    if (!_inv.data) { window.KV.toast('Factuur nog niet geladen'); return null; }
    return _inv.data;
  }
  window.__fnInvPay = async function () {
    const inv = _invOrToast(); if (!inv) return;
    try {
      const mod = await import('./modals/invoice-payment.js?v=2');
      mod.openInvoicePaymentModal({ invoice: inv, onSuccess: _refreshInv });
    } catch (e) { console.error('[fnd] invoice-payment import fail:', e); window.KV.toast('Kon betaling-modal niet laden'); }
  };
  window.__fnInvRemovePay = async function () {
    const inv = _invOrToast(); if (!inv) return;
    try {
      const mod = await import('./modals/invoice-remove-payment.js');
      mod.openInvoiceRemovePaymentModal({ invoice: inv, onSuccess: _refreshInv });
    } catch (e) { console.error('[fnd] invoice-remove-payment import fail:', e); window.KV.toast('Kon terugdraai-modal niet laden'); }
  };
  window.__fnInvSend = async function () {
    const inv = _invOrToast(); if (!inv) return;
    try {
      const mod = await import('./modals/invoice-send.js?v=2');
      mod.openInvoiceSendModal({ invoice: inv, onSuccess: _refreshInv });
    } catch (e) { console.error('[fnd] invoice-send import fail:', e); window.KV.toast('Kon verzend-modal niet laden'); }
  };
  window.__fnInvUpdate = async function () {
    const inv = _invOrToast(); if (!inv) return;
    try {
      const mod = await import('./modals/invoice-update.js?v=2');
      mod.openInvoiceUpdateModal({ invoice: inv, onSuccess: _refreshInv });
    } catch (e) { console.error('[fnd] invoice-update import fail:', e); window.KV.toast('Kon aanpas-modal niet laden'); }
  };
  window.__fnInvCredit = async function () {
    const inv = _invOrToast(); if (!inv) return;
    try {
      const mod = await import('./modals/invoice-credit.js?v=2');
      mod.openInvoiceCreditModal({ invoice: inv, onSuccess: _refreshInv });
    } catch (e) { console.error('[fnd] invoice-credit import fail:', e); window.KV.toast('Kon credit-modal niet laden'); }
  };

  // ── Abonnement-mutaties: dynamic imports naar subscription-actions ──────
  async function _refreshSub() { if (_sub.id) _subLoad(_sub.id); }
  function _subOrToast() {
    if (!_sub.data) { window.KV.toast('Abonnement nog niet geladen'); return null; }
    return _sub.data;
  }
  window.__fnSubUpdate = async function () {
    const sub = _subOrToast(); if (!sub) return;
    try {
      const mod = await import('./modals/subscription-actions.js');
      mod.openSubscriptionUpdateModal({ sub, onSuccess: _refreshSub });
    } catch (e) { console.error('[fnd] sub-update import fail:', e); window.KV.toast('Kon aanpas-modal niet laden'); }
  };
  window.__fnSubPostpone = async function () {
    const sub = _subOrToast(); if (!sub) return;
    try {
      const mod = await import('./modals/subscription-actions.js');
      mod.openSubscriptionPostponeModal({ sub, onSuccess: _refreshSub });
    } catch (e) { console.error('[fnd] sub-postpone import fail:', e); window.KV.toast('Kon uitstel-modal niet laden'); }
  };
  window.__fnSubDelete = async function () {
    const sub = _subOrToast(); if (!sub) return;
    try {
      const mod = await import('./modals/subscription-actions.js');
      mod.openSubscriptionDeleteModal({ sub, onSuccess: _refreshSub });
    } catch (e) { console.error('[fnd] sub-delete import fail:', e); window.KV.toast('Kon deactiveer-modal niet laden'); }
  };

  // ── Navigatie ───────────────────────────────────────────────────────────
  window.__fnInvOpen = function (id) {
    if (!id) return;
    const url = new URL(location.href);
    url.searchParams.set('invoice_id', String(id));
    url.searchParams.delete('subscription_id');
    if (!url.searchParams.has('v2preview')) url.searchParams.set('v2preview', 'finance');
    history.pushState({}, '', url.toString());
    try { window.DFO.goMod && window.DFO.goMod('finance'); } catch (_) {}
    try { window.DFO.goTab && window.DFO.goTab('Facturen'); } catch (_) {}
    window.DFO.render();
  };
  window.__fnSubOpen = function (id) {
    if (!id) return;
    const url = new URL(location.href);
    url.searchParams.set('subscription_id', String(id));
    url.searchParams.delete('invoice_id');
    if (!url.searchParams.has('v2preview')) url.searchParams.set('v2preview', 'finance');
    history.pushState({}, '', url.toString());
    try { window.DFO.goMod && window.DFO.goMod('finance'); } catch (_) {}
    try { window.DFO.goTab && window.DFO.goTab('Abonnementen'); } catch (_) {}
    window.DFO.render();
  };
  window.__fnBack = function (which) {
    const url = new URL(location.href);
    url.searchParams.delete('invoice_id');
    url.searchParams.delete('subscription_id');
    history.pushState({}, '', url.toString());
    // Reset state
    if (which === 'invoices') { _inv.id = null; _inv.data = null; _inv.error = null; }
    if (which === 'subscriptions') { _sub.id = null; _sub.data = null; _sub.error = null; }
    window.DFO.render();
  };

  // Popstate: browser back → re-render + reset detail-state.
  window.addEventListener('popstate', () => {
    try {
      const iid = new URLSearchParams(location.search).get('invoice_id');
      const sid = new URLSearchParams(location.search).get('subscription_id');
      if (!iid && _inv.id) { _inv.id = null; _inv.data = null; _inv.error = null; }
      if (!sid && _sub.id) { _sub.id = null; _sub.data = null; _sub.error = null; }
      window.DFO.render();
    } catch (_) {}
  });

  console.debug('[fnd] loaded — window.__fnRenderInv / __fnRenderSub / __fnInvOpen / __fnSubOpen / __fnBack beschikbaar');
})();
