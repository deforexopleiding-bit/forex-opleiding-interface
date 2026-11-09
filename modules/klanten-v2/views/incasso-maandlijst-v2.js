// modules/klanten-v2/views/incasso-maandlijst-v2.js
//
// Wanbetalers › Incasso-abonnementen (PR 4 mentorcommissie, 3 nov 2026).
// Per klant met een incasso-regeling: per maand verwacht, ontvangen en
// achterstand. Deze termijnfacturen gaan NIET naar de klant en NIET naar het
// bureau (geen aanmaning, geen pipeline, geen automatische mail). Komt er
// geld binnen, dan zet "Betaling ontvangen" de factuur op betaald via de
// bestaande betaalflow (/api/finance-invoice-register-payment: Teamleader +
// payments + invoices); de factuurmotor geeft daarna de mentorcommissie vrij
// op wat effectief binnenkwam.
// Data: GET /api/incasso-maandlijst (finance.dunning.view).
(function () {
  'use strict';
  window.DFO = window.DFO || {};
  const esc = (s) => String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  const eur = (n) => new Intl.NumberFormat('nl-NL', { style: 'currency', currency: 'EUR', minimumFractionDigits: 2 }).format(Number(n) || 0);
  const MND = ['jan', 'feb', 'mrt', 'apr', 'mei', 'jun', 'jul', 'aug', 'sep', 'okt', 'nov', 'dec'];
  const maandLabel = (k) => { const [y, m] = String(k).split('-'); return `${MND[Number(m) - 1] || m} ${y}`; };
  const vandaag = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Amsterdam' }).format(new Date());

  const st = window.__imState = window.__imState || { loading: false, fetched: false, error: null, klanten: [], open: {}, betaal: null };
  const rerender = () => { if (window.DFO && typeof window.DFO.render === 'function') window.DFO.render(); };
  const toast = (m) => { if (window.KV && typeof window.KV.toast === 'function') window.KV.toast(m); };

  async function laad(force) {
    if (st.loading || (st.fetched && !force)) return;
    st.loading = true; st.error = null; rerender();
    try {
      const j = await window.KV.authedJson('/api/incasso-maandlijst');
      st.klanten = Array.isArray(j?.klanten) ? j.klanten : [];
    } catch (e) {
      st.error = e && e.status === 403 ? 'Geen toegang (recht finance.dunning.view).' : 'Kon de maandlijst niet laden' + (e?.message ? ': ' + e.message : '');
    }
    st.loading = false; st.fetched = true; rerender();
  }

  window.__imToggle = (cid) => { st.open[cid] = !st.open[cid]; rerender(); };
  window.__imVernieuw = () => laad(true);
  window.__imBetaal = (cid, invId) => {
    const k = st.klanten.find((x) => x.customer_id === cid);
    const f = k && k.maanden.flatMap((m) => m.facturen).find((x) => x.id === invId);
    if (!f) return;
    st.betaal = { customer_id: cid, klant: k.klant, invoice_id: invId, nummer: f.nummer, open: f.open, bedrag: String(f.open.toFixed(2)), datum: vandaag(), bezig: false, fout: null };
    rerender();
  };
  window.__imBetaalVeld = (k, v) => { if (st.betaal) st.betaal[k] = v; };
  window.__imBetaalSluit = () => { st.betaal = null; rerender(); };
  window.__imBetaalOk = async () => {
    const b = st.betaal; if (!b || b.bezig) return;
    const bedrag = Number(String(b.bedrag).replace(',', '.'));
    if (!(bedrag > 0)) { b.fout = 'Vul een bedrag groter dan 0 in.'; rerender(); return; }
    if (bedrag > b.open + 0.005) { b.fout = `Meer dan het openstaande bedrag (${eur(b.open)}).`; rerender(); return; }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(b.datum || '')) { b.fout = 'Kies de datum van ontvangst.'; rerender(); return; }
    b.bezig = true; b.fout = null; rerender();
    try {
      await window.KV.authedJson('/api/finance-invoice-register-payment', {
        method: 'POST',
        body: JSON.stringify({ invoice_id: b.invoice_id, amount: Math.round(bedrag * 100) / 100, paid_at: b.datum }),
      });
      toast(`Betaling van ${eur(bedrag)} geregistreerd op ${b.nummer || 'de factuur'} — de commissie volgt op de betaalde factuur`);
      st.betaal = null;
      await laad(true);
    } catch (e) {
      b.bezig = false; b.fout = e?.message || 'Registreren mislukt'; rerender();
    }
  };

  function betaalVenster() {
    const b = st.betaal; if (!b) return '';
    return `<div class="sw-modal-back is-open" onclick="if(event.target===this)__imBetaalSluit()">
      <div class="sw-modal" style="max-width:460px">
        <div class="sw-modal-head"><div class="sw-modal-title">Betaling ontvangen</div><button class="ds-icon-btn" onclick="__imBetaalSluit()">×</button></div>
        <div class="sw-modal-body" style="padding:16px 20px">
          <div style="font-size:12.5px;color:var(--text-2);margin-bottom:10px">${esc(b.klant)} · factuur ${esc(b.nummer || '')} · open ${eur(b.open)}. De factuur wordt via de gewone betaalflow (Teamleader) op betaald gezet; daarna geeft de factuurmotor de commissie vrij.</div>
          <label class="sw-field"><span>Bedrag ontvangen</span><input class="ib-input" type="number" step="0.01" min="0" value="${esc(b.bedrag)}" oninput="__imBetaalVeld('bedrag', this.value)"></label>
          <label class="sw-field" style="margin-top:8px"><span>Datum van ontvangst</span><input class="ib-input" type="date" value="${esc(b.datum)}" onchange="__imBetaalVeld('datum', this.value)"></label>
          ${b.fout ? `<div class="kv-edit-banner" style="margin-top:10px">${esc(b.fout)}</div>` : ''}
        </div>
        <div class="sw-modal-foot" style="display:flex;justify-content:flex-end;gap:8px;padding:12px 20px">
          <button class="ds-btn ds-btn-ghost" onclick="__imBetaalSluit()" ${b.bezig ? 'disabled' : ''}>Annuleren</button>
          <button class="ds-btn ds-btn-primary" onclick="__imBetaalOk()" ${b.bezig ? 'disabled' : ''}>${b.bezig ? 'Bezig…' : 'Registreren'}</button>
        </div>
      </div></div>`;
  }

  function klantBlok(k) {
    const open = !!st.open[k.customer_id];
    const t = k.totaal || {};
    const kop = `<tr style="cursor:pointer;${open ? 'background:var(--surface-2)' : ''}" onclick="__imToggle('${esc(k.customer_id)}')">
      <td><b>${esc(k.klant)}</b>${k.zonder_abonnement ? ' <span style="font-size:11px;color:var(--amber)" title="Geen abonnement van soort incasso-regeling: de facturen vanaf de regeling tellen">zonder abonnement</span>' : ''}</td>
      <td>${esc(k.status?.label || '—')}${k.status?.sinds ? `<div style="font-size:11px;color:var(--text-3)">sinds ${esc(k.status.sinds)}</div>` : ''}</td>
      <td class="r mono">${eur(t.verwacht)}</td><td class="r mono">${eur(t.ontvangen)}</td>
      <td class="r mono" style="${t.achterstand > 0 ? 'color:var(--rose);font-weight:700' : ''}">${eur(t.achterstand)}</td>
      <td class="r">${open ? '▾' : '▸'}</td></tr>`;
    if (!open) return kop;
    const huidig = vandaag().slice(0, 7);
    const rijen = (k.maanden || []).map((m) => `<tr style="${m.maand === huidig ? 'background:var(--accent-soft, rgba(59,130,246,.06))' : ''}">
      <td style="padding-left:24px">${esc(maandLabel(m.maand))}</td>
      <td>${(m.facturen || []).map((f) => `<div style="font-size:12px">${esc(f.nummer || 'factuur')} · ${eur(f.bedrag)}${!f.gecrediteerd && f.betaald > 0.005 && f.betaalmethode ? ` · betaald ${eur(f.betaald)} (${esc(f.betaalmethode)})` : ''}${f.gecrediteerd ? ' · gecrediteerd' : (f.open > 0.005 ? ` · open ${eur(f.open)} <button class="ds-btn ds-btn-ghost ds-btn-sm" style="margin-left:4px" onclick="event.stopPropagation();__imBetaal('${esc(k.customer_id)}','${esc(f.id)}')">Betaling ontvangen</button>` : ' · betaald')}</div>`).join('') || (m.gepland > 0 ? '<span style="font-size:12px;color:var(--text-3)">nog geen factuur</span>' : '')}</td>
      <td class="r mono">${eur(m.verwacht)}</td><td class="r mono">${eur(m.ontvangen)}</td>
      <td class="r mono" style="${m.achterstand > 0 ? 'color:var(--rose)' : ''}">${eur(m.achterstand)}</td><td></td></tr>`).join('');
    return kop + rijen;
  }

  function maandlijstView() {
    if (!st.fetched && !st.loading) queueMicrotask(() => laad(false));
    const body = st.loading && !st.fetched ? '<div style="padding:24px;color:var(--text-3)">Laden…</div>'
      : st.error ? `<div class="kv-edit-banner">${esc(st.error)}</div>`
      : !st.klanten.length ? `<div class="ds-empty" style="padding:32px 20px"><div class="ds-empty-t">Geen incasso-abonnementen</div><div class="ds-empty-s">Een klant verschijnt hier met de incassostatus "Incasso-regeling" (klant › Incassostatus) of met een abonnement van soort "incasso-regeling".</div></div>`
      : `<div class="ds-tbl-wrap"><table class="ds-tbl">
          <thead><tr><th>Klant / maand</th><th>Status / facturen</th><th class="r">Verwacht</th><th class="r">Ontvangen</th><th class="r">Achterstand</th><th></th></tr></thead>
          <tbody>${st.klanten.map(klantBlok).join('')}</tbody></table></div>`;
    return `<div style="padding:16px 22px;max-width:1150px">
      <div style="display:flex;justify-content:space-between;align-items:flex-start;gap:12px;margin-bottom:10px">
        <div><div style="font-size:16px;font-weight:700">Incasso-abonnementen</div>
          <div style="font-size:12px;color:var(--text-3);max-width:760px">Termijnfacturen van een incasso-regeling gaan niet naar de klant en niet naar het bureau: geen aanmaning, geen wanbetalers-pipeline, geen automatische mail. Registreer hier wat binnenkomt; de mentorcommissie volgt op de betaalde factuur.</div></div>
        <button class="ds-btn ds-btn-ghost ds-btn-sm" onclick="__imVernieuw()">↻ Vernieuwen</button>
      </div>
      ${body}
      ${betaalVenster()}
    </div>`;
  }

  window.DFO.VIEWS = window.DFO.VIEWS || {};
  window.DFO.VIEWS['wanbetalers/Incasso-abonnementen'] = maandlijstView;
})();
