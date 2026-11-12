// modules/klanten-v2/views/commissie-incasso-v2.js
//
// Finance › "Commissie & incasso" (12 nov 2026). Zelfde rechten als Mentoren ›
// Commissies (super_admin / admin / manager; server: mentor.admin.view).
//
// Data:
//   GET /api/commissie-incasso-overzicht → KPI's, Te checken (zelfde bron als
//       Commissies › Controle + de annulatie-signalen), Incasso, per soort.
//   GET /api/commissie-overzicht         → "Commissie per sale" (de bestaande
//       cockpit-bron; geen tweede rekenmotor).
// Acties (één knop per regel, de mens kiest): Sale toewijzen (bestaande
// wizard), Commissie annuleren (/api/commissie-annulering), Soort zetten
// (/api/subscription-soort), Open event / offerte. Niets massaal.
// De maandlijst Incasso-abonnementen wordt hier NIET getoond; enkel gelinkt.

(function () {
  if (!window.DFO) { console.error('[commissie-incasso-v2] DFO shell niet geladen.'); return; }
  if (!window.KV_V2 || !window.KV_V2.helpers) { console.error('[commissie-incasso-v2] KV_V2.helpers niet geladen.'); return; }
  const { I, S, render } = window.DFO;
  const H = window.KV_V2.helpers;
  const asArr = (v) => (Array.isArray(v) ? v : []);
  const esc = (v) => String(v == null ? '' : v).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const eur = (n) => (n == null ? '—' : new Intl.NumberFormat('nl-NL', { style: 'currency', currency: 'EUR', minimumFractionDigits: 2 }).format(Number(n) || 0));
  const MAAND = ['jan', 'feb', 'mrt', 'apr', 'mei', 'jun', 'jul', 'aug', 'sep', 'okt', 'nov', 'dec'];
  const dat = (iso) => { if (!iso) return '—'; const d = new Date(String(iso).length <= 10 ? iso + 'T00:00:00' : iso); return Number.isNaN(d.getTime()) ? String(iso) : `${d.getDate()} ${MAAND[d.getMonth()]} ${d.getFullYear()}`; };
  const ADMIN = new Set(['super_admin', 'admin', 'manager']);
  const isAdmin = () => { try { return ADMIN.has(String(S.role || '').toLowerCase()); } catch (_) { return false; } };

  async function api(url, opts, ms) {
    try {
      return await Promise.race([window.KV.authedJson(url, opts), new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), ms || 30000))]);
    } catch (e) { return { __error: e?.body?.error || e?.message || 'onbekende fout' }; }
  }
  const toast = (m) => { try { window.KV?.toast ? window.KV.toast(m) : console.info(m); } catch (_) { console.info(m); } };

  const _st = { data: null, laden: false, fout: null, tab: 'check', code: '', sales: null, salesLaden: false, salesFout: null, salesFilter: '', keuze: {}, bezig: {} };
  const CODES = {
    event_sale_niet_aanwezig: ['rose', 'Event-sale niet aanwezig'],
    vervangen_niet_gekoppeld: ['blue', 'Vervangen, niet gekoppeld'],
    verkoper_mentor_geen_commissie: ['amber', 'Verkoper is mentor'],
    commissie_zonder_abonnement: ['violet', 'Commissie zonder actief abonnement'],
    soort_ontbreekt: ['teal', 'Abonnement zonder soort'],
  };

  async function laad() {
    if (_st.laden) return;
    _st.laden = true; _st.fout = null;
    const j = await api('/api/commissie-incasso-overzicht', undefined, 120000);
    _st.laden = false;
    if (j?.__error) { _st.fout = j.__error; render(); return; }
    _st.data = j; render();
  }
  async function laadSales() {
    if (_st.salesLaden) return;
    _st.salesLaden = true; _st.salesFout = null;
    const j = await api('/api/commissie-overzicht?periode=alles', undefined, 60000);
    _st.salesLaden = false;
    if (j?.__error) { _st.salesFout = j.__error; render(); return; }
    _st.sales = asArr(j.sales); render();
  }

  window.__ciTab = (t) => { _st.tab = t; render(); };
  window.__ciCode = (c) => { _st.code = _st.code === c ? '' : c; render(); };
  window.__ciHerlaad = () => { _st.data = null; _st.sales = null; render(); };
  window.__ciSalesFilter = (v) => { _st.salesFilter = v; render(); };
  window.__ciNaarMaandlijst = () => { try { window.DFO.goMod('wanbetalers'); window.DFO.goTab('Incasso-abonnementen'); } catch (_) { /* fail-soft */ } };
  window.__ciNaarAbonnementen = (soort) => { try { window.DFO.setF('fin-sub-soort', soort || 'all'); window.DFO.setF('fin-sub-st', 'all'); window.DFO.goTab('Abonnementen'); } catch (_) { /* fail-soft */ } };
  window.__ciOpenEvent = (id) => { try { window.DFO.goMod('events'); window.DFO.goTab('Overzicht'); if (typeof window.__evGoDetail === 'function') window.__evGoDetail(id); } catch (_) { /* fail-soft */ } };
  window.__ciOpenOfferte = (id) => { if (typeof window.__odvOpen === 'function') window.__odvOpen(id); };
  window.__ciToewijzen = (i) => {
    const t = asArr(_st.data?.te_checken)[i];
    if (!t || !window.KV_COMM) return;
    if (t.code === 'vervangen_niet_gekoppeld' && t.vorige) {
      window.KV_COMM.openToewijzen(window.KV_COMM.prefillVoor({ deal_id: t.deal_id, vorige_vervangen: t.vorige }));
    } else if (t.code === 'verkoper_mentor_geen_commissie') {
      window.KV_COMM.openToewijzen(window.KV_COMM.prefillVoor({ deal_id: t.deal_id, verkoper: t.verkoper }));
    } else {
      window.KV_COMM.openToewijzen({ deal_id: t.deal_id });
    }
  };
  window.__ciAnnuleer = async (i) => {
    const t = asArr(_st.data?.te_checken)[i];
    if (!t || !window.KV_COMM || _st.bezig[i]) return;
    const keuze = await window.KV_COMM.keuze({
      titel: 'Commissie op ' + (t.klant || 'deze sale'),
      intro: `<p style="margin:0 0 6px">${esc(t.uitleg)}</p>`,
      opties: [
        { v: 'klant_annuleert', l: 'Klant annuleert', d: 'Commissie → Geannuleerd, reden "Klant geannuleerd".' },
        { v: 'vervangen', l: 'Vervangen door nieuwe offerte', d: 'Commissie → Geannuleerd; koppel daarna de nieuwe offerte via Sale toewijzen.' },
      ],
      okLabel: 'Commissie annuleren',
    });
    if (!keuze) return;
    _st.bezig[i] = true; render();
    const j = await api('/api/commissie-annulering', { method: 'POST', body: JSON.stringify({ actie: 'annuleren', deal_id: t.deal_id, soort: keuze }) }, 45000);
    _st.bezig[i] = false;
    if (j?.__error) { toast('Annuleren mislukt: ' + j.__error); render(); return; }
    toast(`Commissie geannuleerd (${j.reden}).`);
    _st.data = null; render();
  };
  window.__ciSoortKies = (i, v) => { _st.keuze[i] = v; };
  window.__ciSoortZet = async (i) => {
    const t = asArr(_st.data?.te_checken)[i];
    const v = _st.keuze[i] || '';
    if (!t || !v || _st.bezig[i]) { if (!v) toast('Kies eerst de soort.'); return; }
    const [soort, type] = v.split(':');
    const body = { subscription_id: t.subscription_id, soort, aanpassing_type: type || null, sale_deal_id: soort === 'nieuwe_offerte' ? null : t.deal_id };
    _st.bezig[i] = true; render();
    const j = await api('/api/subscription-soort', { method: 'POST', body: JSON.stringify(body) }, 45000);
    _st.bezig[i] = false;
    if (j?.__error) { toast('Opslaan mislukt: ' + j.__error); render(); return; }
    toast('Soort opgeslagen.');
    t._klaar = true; render();
  };

  // ── CSV ────────────────────────────────────────────────────────────────
  function csvVeld(v) { const s = String(v == null ? '' : v); return /[",;\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; }
  function download(naam, rijen) {
    const tekst = '﻿' + rijen.map((r) => r.map(csvVeld).join(';')).join('\n');
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([tekst], { type: 'text/csv;charset=utf-8' }));
    a.download = naam; document.body.appendChild(a); a.click(); a.remove();
  }
  window.__ciCsv = () => {
    const d = _st.data || {};
    const rijen = [['Soort', 'Klant', 'Offerte', 'Deal-id', 'Uitleg', 'Abonnement-id', 'Mentoren']];
    for (const t of asArr(d.te_checken)) rijen.push([(CODES[t.code] || [, t.code])[1], t.klant, t.offerte || '', t.deal_id || '', t.uitleg, t.subscription_id || '', asArr(t.mentoren).join(', ')]);
    rijen.push([]);
    rijen.push(['Incasso', 'Klant', 'Sinds', 'Status', 'Commissie', 'Regeling-abonnementen']);
    const inc = d.incasso || {};
    for (const [k, l] of [['bij_incasso', 'Bij incasso'], ['regeling', 'Regeling lopend'], ['afgesloten', 'Afgesloten']]) {
      for (const r of asArr(inc[k])) rijen.push([l, r.klant, r.sinds || '', r.label, r.commissie ? 'ja' : 'nee', r.regeling_abonnementen]);
    }
    if (_st.sales) {
      rijen.push([]);
      rijen.push(['Commissie per sale', 'Klant', 'Bron', 'Mentoren', 'Commissie', 'Vrijgegeven', 'Open', 'Status', 'Reden annulering']);
      for (const s of _st.sales) rijen.push(['', s.klant, s.bron_label, asArr(s.mentoren).map((m) => m.naam).join(', '), s.share, s.vrijgegeven, s.open, s.status, s.annulering?.reden || '']);
    }
    download(`commissie-incasso-${new Date().toISOString().slice(0, 10)}.csv`, rijen);
  };

  // ── Tabs ───────────────────────────────────────────────────────────────
  const SOORT_OPTIES = [['origineel', 'Origineel'], ['aanpassing:uitstel', 'Aanpassing · uitstel'], ['aanpassing:lager_bedrag', 'Aanpassing · lager bedrag'], ['aanpassing:regeling', 'Aanpassing · regeling'], ['nieuwe_offerte', 'Nieuwe offerte — telt niet mee']];
  function actieVoor(t, i) {
    const b = _st.bezig[i];
    if (t._klaar) return '<span style="color:var(--emerald);font-size:12px">✓ opgeslagen</span>';
    switch (t.code) {
      case 'event_sale_niet_aanwezig':
        return `<button class="btn btn-ghost btn-sm" onclick="__ciOpenEvent('${esc(t.event_id)}')">Open event</button> <button class="btn btn-ghost btn-sm" onclick="__ciToewijzen(${i})">Sale toewijzen</button>`;
      case 'vervangen_niet_gekoppeld':
      case 'verkoper_mentor_geen_commissie':
        return t.deal_id ? `<button class="btn btn-primary btn-sm" onclick="__ciToewijzen(${i})">Sale toewijzen</button>` : '<span style="font-size:12px;color:var(--text-3)">nog geen nieuwe offerte</span>';
      case 'commissie_zonder_abonnement':
        return `${t.deal_bestaat ? `<button class="btn btn-ghost btn-sm" onclick="__ciOpenOfferte('${esc(t.deal_id)}')">Open offerte</button> ` : ''}<button class="btn btn-ghost btn-sm" style="color:var(--rose)" ${b ? 'disabled' : ''} onclick="__ciAnnuleer(${i})">${b ? 'Bezig…' : 'Commissie annuleren…'}</button>`;
      case 'soort_ontbreekt':
        return `<div style="display:flex;gap:6px;align-items:center;flex-wrap:wrap"><span style="font-size:11.5px;color:var(--text-3)">Hoort bij sale ${esc(t.offerte || ('#' + String(t.deal_id || '').slice(0, 8)))}${asArr(t.mentoren).length ? ' (' + esc(t.mentoren.join(', ')) + ')' : ''} →</span>
          <select onchange="__ciSoortKies(${i}, this.value)" style="padding:5px 8px;border:1px solid var(--border);border-radius:6px;background:var(--surface);font-size:12px"><option value="">— kies —</option>${SOORT_OPTIES.map(([v, l]) => `<option value="${v}" ${_st.keuze[i] === v ? 'selected' : ''}>${l}</option>`).join('')}</select>
          <button class="btn btn-primary btn-sm" ${b ? 'disabled' : ''} onclick="__ciSoortZet(${i})">${b ? '…' : 'Opslaan'}</button></div>`;
      default: return '';
    }
  }
  function teCheckenTab() {
    const d = _st.data;
    const per = d.te_checken_per_code || {};
    const alle = asArr(d.te_checken).map((t, i) => ({ t, i }));
    const lijst = _st.code ? alle.filter((x) => x.t.code === _st.code) : alle;
    const chips = Object.entries(CODES).map(([k, [c, l]]) => `<button class="chip ${_st.code === k ? 'on' : ''}" onclick="__ciCode('${k}')">${l} <span style="opacity:.7">${per[k] || 0}</span></button>`).join('');
    if (!alle.length) return `<div style="padding:24px;text-align:center;color:var(--text-3);font-size:13px">Niets te checken. 🎉</div>`;
    return `<div style="display:flex;gap:6px;flex-wrap:wrap;margin-bottom:10px">${chips}</div>
      <div class="tbl-wrap"><table><thead><tr><th>Wat</th><th>Klant</th><th>Waarom</th><th>Rechtzetten</th></tr></thead><tbody>
      ${lijst.map(({ t, i }) => { const [c, l] = CODES[t.code] || ['neutral', t.code]; return `<tr>
        <td>${H.pill(c === 'rose' ? 'danger' : c === 'amber' ? 'warn' : c === 'blue' ? 'info' : 'neutral', l)}</td>
        <td><b>${esc(t.klant || '—')}</b>${t.offerte ? `<div style="font-size:11px;color:var(--text-3)">${esc(t.offerte)}</div>` : ''}${t.event ? `<div style="font-size:11px;color:var(--text-3)">${esc(t.event)}</div>` : ''}</td>
        <td style="font-size:12.5px;max-width:360px">${esc(t.uitleg || '')}${t.code === 'vervangen_niet_gekoppeld' && t.vorige ? `<div style="font-size:11.5px;color:var(--text-3)">${esc(asArr(t.vorige.mentoren).map((m) => m.naam).join(', '))} · ${esc(eur(t.vorige.bedrag))} · vervangen ${esc(dat(t.vorige.vervangen_op))}</div>` : ''}${t.sub ? `<div style="font-size:11.5px;color:var(--text-3)">${t.sub.term_count ? t.sub.term_count + ' termijnen · ' : ''}${t.sub.start_date ? 'vanaf ' + esc(dat(t.sub.start_date)) + ' · ' : ''}${esc(t.sub.status || '')}</div>` : ''}</td>
        <td>${actieVoor(t, i)}</td></tr>`; }).join('')}
      </tbody></table></div>`;
  }
  function incassoTab() {
    const inc = _st.data.incasso || {};
    const kol = (titel, kleur, rijen, leegTekst) => `<div style="flex:1;min-width:240px;border:1px solid var(--border);border-radius:10px;overflow:hidden">
      <div style="padding:9px 12px;background:var(--${kleur}-soft);color:var(--${kleur});font-weight:600;font-size:13px">${titel} <span style="opacity:.75">(${rijen.length})</span></div>
      <div style="max-height:420px;overflow-y:auto">${rijen.length ? rijen.map((r) => `<div style="padding:8px 12px;border-top:1px solid var(--border)">
        <div style="display:flex;justify-content:space-between;gap:8px"><b style="font-size:12.5px">${esc(r.klant)}</b>${r.commissie ? '<span style="font-size:11px;color:var(--violet)">commissie</span>' : ''}</div>
        <div style="font-size:11.5px;color:var(--text-3)">${esc(r.label)}${r.sinds ? ' · sinds ' + esc(dat(r.sinds)) : ''}${r.opgeheven_op ? ' · opgeheven ' + esc(dat(r.opgeheven_op)) : ''}${r.dossier ? ' · dossier ' + esc(r.dossier.status) : ''}${r.regeling_abonnementen ? ' · ' + r.regeling_abonnementen + ' regeling-abonnement(en)' : ''}</div>
        ${r.reden ? `<div style="font-size:11.5px;color:var(--text-2)">${esc(r.reden)}</div>` : ''}</div>`).join('') : `<div style="padding:12px;font-size:12px;color:var(--text-3)">${leegTekst}</div>`}</div></div>`;
    return `<div style="display:flex;justify-content:space-between;gap:8px;flex-wrap:wrap;margin-bottom:10px;align-items:center">
        <div style="font-size:12.5px;color:var(--text-2)">Eén status per klant (Klant › Incassostatus). Bij incasso staat de commissie stil; bij een regeling telt ze weer. ${inc.dossiers ? inc.dossiers + ' incassodossier(s) bij een bureau.' : ''}</div>
        <button class="btn btn-ghost btn-sm" onclick="__ciNaarMaandlijst()">Wanbetalers › Incasso-abonnementen ›</button></div>
      <div style="display:flex;gap:12px;flex-wrap:wrap">${kol('Bij incasso', 'rose', asArr(inc.bij_incasso), 'Geen klanten bij incasso.')}${kol('Regeling lopend', 'amber', asArr(inc.regeling), 'Geen lopende regelingen.')}${kol('Afgesloten', 'emerald', asArr(inc.afgesloten), 'Nog niets afgesloten.')}</div>`;
  }
  const SALE_ST = { wacht: ['neutral', 'Wacht op betaling'], deels: ['info', 'Deels vrijgegeven'], volledig: ['ok', 'Volledig'], achterstallig: ['danger', 'Achterstallig'], geannuleerd: ['neutral', 'Geannuleerd'], incasso: ['danger', 'Incasso'] };
  function salesTab() {
    if (!_st.sales && !_st.salesLaden && !_st.salesFout) queueMicrotask(laadSales);
    if (_st.salesFout) return `<div style="color:var(--rose);font-size:12.5px">${esc(_st.salesFout)}</div>`;
    if (!_st.sales) return '<div style="color:var(--text-3);font-size:12.5px;padding:12px">Laden…</div>';
    const f = _st.salesFilter;
    const lijst = f ? _st.sales.filter((s) => s.status === f) : _st.sales;
    const opt = [['', 'Alle statussen'], ...Object.entries(SALE_ST).map(([k, [, l]]) => [k, l])];
    return `<div style="display:flex;gap:8px;align-items:center;margin-bottom:10px;flex-wrap:wrap">
        <select onchange="__ciSalesFilter(this.value)" style="padding:6px 9px;border:1px solid var(--border);border-radius:6px;background:var(--surface);font-size:12.5px">${opt.map(([v, l]) => `<option value="${v}" ${f === v ? 'selected' : ''}>${l}</option>`).join('')}</select>
        <span style="font-size:12px;color:var(--text-3)">${lijst.length} sale${lijst.length === 1 ? '' : 's'} · bron: Mentoren › Commissies</span></div>
      <div class="tbl-wrap"><table><thead><tr><th>Klant</th><th>Bron</th><th>Mentoren</th><th class="num">Commissie</th><th class="num">Vrijgegeven</th><th>Status</th></tr></thead><tbody>
      ${lijst.map((s) => { const [c, l] = SALE_ST[s.status] || ['neutral', s.status]; const ann = s.annulering; return `<tr style="${s.status === 'geannuleerd' ? 'opacity:.7' : ''}">
        <td><b>${esc(s.klant)}</b></td>
        <td style="font-size:12.5px"><span style="display:inline-block;width:7px;height:7px;border-radius:50%;background:${s.bron === 'event' ? 'var(--rose)' : 'var(--blue)'};margin-right:5px"></span>${esc(s.bron_label || '')}${s.datum ? `<div style="font-size:11px;color:var(--text-3)">${esc(dat(s.datum))}</div>` : ''}</td>
        <td style="font-size:12.5px">${esc(asArr(s.mentoren).map((m) => m.naam).join(', '))}</td>
        <td class="num mono">${ann && s.status === 'geannuleerd' ? `<s style="color:var(--text-3)">${eur(ann.oorspronkelijk)}</s>` : eur(s.share)}</td>
        <td class="num mono" style="color:var(--emerald)">${eur(s.vrijgegeven)}</td>
        <td>${H.pill(c, l)}${ann ? `<div style="font-size:11px;color:var(--text-3)">${esc(ann.reden || '')}${ann.op ? ' · ' + esc(dat(ann.op)) : ''}</div>` : ''}</td></tr>`; }).join('')}
      </tbody></table></div>`;
  }
  function soortTab() {
    const p = _st.data.per_soort || {};
    const rij = [['origineel', 'Origineel'], ['aanpassing', 'Aanpassing'], ['incasso_regeling', 'Incasso-regeling'], ['nieuwe_offerte', 'Nieuwe offerte'], ['leeg', 'Niet aangeduid']];
    const tot = rij.reduce((t, [k]) => t + (p[k]?.totaal || 0), 0) || 1;
    return `<div class="tbl-wrap"><table><thead><tr><th>Soort</th><th class="num">Totaal</th><th class="num">Actief</th><th style="min-width:160px">Aandeel</th><th></th></tr></thead><tbody>
      ${rij.map(([k, l]) => { const v = p[k] || { totaal: 0, actief: 0 }; return `<tr><td>${esc(l)}</td><td class="num mono">${v.totaal}</td><td class="num mono">${v.actief}</td>
        <td><div style="height:6px;border-radius:3px;background:var(--surface-2);overflow:hidden"><div style="height:100%;width:${(v.totaal / tot * 100).toFixed(1)}%;background:var(--${k === 'leeg' ? 'amber' : 'blue'})"></div></div></td>
        <td style="text-align:right"><button class="btn btn-ghost btn-sm" onclick="__ciNaarAbonnementen('${k}')">Bekijk ›</button></td></tr>`; }).join('')}
      </tbody></table></div>
      <div style="font-size:11.5px;color:var(--text-3);margin-top:8px">Niet aangeduid bij een klant zónder commissie hoort niet bij Te checken: daar telt de soort niet mee voor commissie.</div>`;
  }

  function view() {
    if (!isAdmin()) {
      return `<div class="empty" style="padding:72px 20px"><div class="empty-t">Geen toegang</div><div class="empty-s">Zelfde rechten als Mentoren › Commissies (manager / admin / super_admin).</div></div>`;
    }
    if (!_st.data && !_st.laden && !_st.fout) queueMicrotask(laad);
    const kop = `<div class="pad" style="padding-top:14px;padding-bottom:0;display:flex;gap:10px;align-items:center;flex-wrap:wrap">
      <div style="font-size:12.5px;color:var(--text-2);flex:1;min-width:220px">Mentorcommissie en incasso per sale. Hier wordt niets automatisch gewijzigd: elke regel heeft één knop, jij kiest.</div>
      <button class="btn btn-ghost btn-sm" onclick="__ciHerlaad()">↻ Vernieuwen</button>
      <button class="btn btn-ghost btn-sm" ${_st.data ? '' : 'disabled'} onclick="__ciCsv()">Export CSV</button></div>`;
    if (_st.fout && !_st.data) return kop + `<div class="pad"><div style="padding:12px 14px;background:var(--rose-soft);color:var(--rose);border-radius:var(--r);font-size:13px">⚠ ${esc(_st.fout)} <button class="btn btn-ghost btn-sm" onclick="__ciHerlaad()">Opnieuw</button></div></div>`;
    if (!_st.data) return kop + `<div class="pad"><div style="padding:24px;color:var(--text-3);font-size:13px">Laden… (de controle rekent alle sales na, dit kan even duren)</div></div>`;
    const k = _st.data.kpis || {};
    const kpis = H.kpis([
      { c: 'violet', icon: I.euro, label: 'Sales met commissie', val: String(k.sales_met_commissie || 0), sub: 'niet geannuleerd' },
      { c: 'amber', icon: I.alert, label: 'Te checken', val: String(k.te_checken || 0), sub: 'één knop per regel', hi: (k.te_checken || 0) > 0 },
      { c: 'rose', icon: I.alert, label: 'Bij incasso', val: String(k.bij_incasso || 0), sub: 'commissie staat stil' },
      { c: 'blue', icon: I.clock, label: 'Incasso-regelingen', val: String(k.incasso_regelingen || 0), sub: 'betalingen tellen weer' },
      { c: 'teal', icon: I.repeat, label: 'Zonder soort (met commissie)', val: String(k.abonnementen_zonder_soort_met_commissie || 0), sub: 'zelfde als Commissies › Controle' },
    ]);
    const fouten = asArr(_st.data.fouten).length ? `<div style="padding:9px 12px;background:var(--rose-soft);color:var(--rose);border-radius:8px;font-size:12.5px;margin-bottom:10px">Niet alles geladen: ${esc(asArr(_st.data.fouten).map((f) => f.naam).join(', '))}.</div>` : '';
    const tabs = [['check', 'Te checken'], ['incasso', 'Incasso'], ['sales', 'Commissie per sale'], ['soort', 'Abonnementen per soort']]
      .map(([v, l]) => `<button class="chip ${_st.tab === v ? 'on' : ''}" onclick="__ciTab('${v}')">${l}</button>`).join('');
    const inhoud = _st.tab === 'incasso' ? incassoTab() : _st.tab === 'sales' ? salesTab() : _st.tab === 'soort' ? soortTab() : teCheckenTab();
    return `${kop}<div class="ci-kpis">${kpis}</div><div class="pad" style="padding-top:0">${fouten}
      <div class="card"><div class="card-head" style="border-bottom:none;display:flex;gap:6px;flex-wrap:wrap">${tabs}</div><div class="card-body" style="padding:8px 17px 17px">${inhoud}</div></div></div>`;
  }

  window.DFO.VIEWS['finance/Commissie & incasso'] = view;
  console.debug('[commissie-incasso-v2] Finance/Commissie & incasso geregistreerd.');
})();
