// modules/klanten-v2/views/trainingdrops-v2.js
//
// Module Trainingdrops (2026-10-23) — de wekelijkse training-funnel van
// dfo-website (training.deforexopleiding.nl/<dd-mm-jj>, bron/variant
// 'training-<dd-mm-jj>'). Menu: Groei → Trainingdrops.
//   - Overzicht: per drop datum, bezoekers, formulier gestart, leads,
//     conversie % en leads per kanaal (src, anders utm_source). Nieuwste bovenaan.
//   - Cadeau (gratis strategiesessie met Dave, dfo-website #132): per drop en
//     per kanaal cadeau-klikken, calls ingepland, gehouden / no-show /
//     geannuleerd en lead → call %.
//   - Klik op een drop: de leads van die drop (met kolom Call) en doorklik naar
//     het leaddossier (Leads → detail), plus links naar de live pagina.
// Data: GET /api/trainingdrops (recht leads.view). Alleen lezen.
(function () {
  'use strict';
  window.DFO = window.DFO || {};

  const esc = (s) => String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  const ZONE = 'Europe/Amsterdam';
  const num = (n) => (n == null ? '—' : new Intl.NumberFormat('nl-NL').format(n));
  const pctTxt = (p) => (p == null ? '—' : String(p).replace('.', ',') + '%');
  const fmtDag = (ymd) => {
    if (!ymd) return '—';
    try { return new Intl.DateTimeFormat('nl-NL', { timeZone: 'UTC', weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' }).format(new Date(ymd + 'T12:00:00Z')); } catch { return ymd; }
  };
  const fmtTijd = (iso) => {
    if (!iso) return '—';
    try { return new Date(iso).toLocaleString('nl-NL', { timeZone: ZONE, day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' }); } catch { return '—'; }
  };
  const pill = (c, t, titel) => `<span class="pill pill-${c} nodot"${titel ? ` title="${esc(titel)}"` : ''}>${esc(t)}</span>`;
  const CALL_PILL = { gepland: 'accent', gehouden: 'ok', no_show: 'danger', geannuleerd: 'neutral' };
  const fmtCall = (iso) => {
    if (!iso) return '—';
    try { return new Date(iso).toLocaleString('nl-NL', { timeZone: ZONE, weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }); } catch { return '—'; }
  };
  // "12 calls · 5 gehouden · 2 no-show · 1 geannuleerd" (alleen wat er is).
  const callUitsplitsing = (x) => [
    [x.calls_gepland, 'gepland'], [x.calls_gehouden, 'gehouden'], [x.calls_no_show, 'no-show'], [x.calls_geannuleerd, 'geannuleerd'],
  ].filter(([n]) => n).map(([n, l]) => num(n) + ' ' + l).join(' · ');

  const st = window.__tdState = window.__tdState || {
    loading: false, fetched: false, error: null, data: null, _seq: 0,
    open: null,        // variant van de geopende drop
    toonTest: false,   // testleads in de leadlijst tonen
  };

  function rerender() { if (window.DFO && typeof window.DFO.render === 'function') window.DFO.render(); }

  async function laad(force) {
    if (st.loading || (st.fetched && !force)) return;
    st.loading = true; st.error = null;
    const seq = ++st._seq;
    rerender();
    try {
      const j = await window.KV.authedJson('/api/trainingdrops');
      if (seq !== st._seq) return;
      st.data = j;
    } catch (e) {
      if (seq !== st._seq) return;
      st.error = e && e.status === 403 ? 'Geen toegang tot de trainingdrops (recht leads.view).'
        : 'Kon de trainingdrops niet laden' + (e && e.status ? ' (HTTP ' + e.status + ')' : '');
      console.error('[trainingdrops-v2] laden mislukt:', e && e.status, e && (e.body || e.message));
    }
    st.loading = false; st.fetched = true;
    rerender();
  }

  window.__tdVernieuw = () => laad(true);
  window.__tdOpen = (variant) => { st.open = variant || null; rerender(); try { window.scrollTo(0, 0); } catch (_) {} };
  window.__tdOpenToets = (e, variant) => { if (e && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); window.__tdOpen(variant); } };
  window.__tdTest = (aan) => { st.toonTest = !!aan; rerender(); };
  // Doorklik naar het bestaande leaddossier: module Leads → ?lead=<id>.
  window.__tdLead = (id) => {
    if (!id || !window.DFO || typeof window.DFO.goMod !== 'function') return;
    window.DFO.goMod('leads');
    requestAnimationFrame(() => requestAnimationFrame(() => {
      if (typeof window.__leadOpen === 'function') window.__leadOpen(id);
    }));
  };

  // Kanaal-chips: alleen kanalen met minstens één lead (anders wordt het een muur van nullen).
  function kanaalChips(lijst, leeg) {
    const met = (lijst || []).filter((k) => k.n > 0);
    if (!met.length) return `<span style="color:var(--text-3);font-size:11.5px">${esc(leeg || '—')}</span>`;
    return met.map((k) => `<span class="pill pill-neutral nodot" style="font-size:11px;margin:1px 4px 1px 0" title="${esc(k.kanaal)}">${esc(k.label)} <b>${num(k.n)}</b></span>`).join('');
  }

  const tegel = (label, val, sub) => `<div class="card" style="padding:12px 14px;margin:0"><div style="color:var(--text-3);font-size:11px;text-transform:uppercase;letter-spacing:.06em">${esc(label)}</div>
    <div style="font-size:22px;font-weight:700;margin-top:2px;font-variant-numeric:tabular-nums">${val}</div><div style="color:var(--text-3);font-size:11.5px">${sub}</div></div>`;
  const tegels = (html) => `<div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:10px;margin-bottom:12px">${html}</div>`;

  function linksHtml(d) {
    if (!d.links) return '';
    return `<a href="${esc(d.links.live)}" target="_blank" rel="noopener" onclick="event.stopPropagation()" style="color:var(--brand,#0A7490);font-size:12px;white-space:nowrap">Live pagina ↗</a>`;
  }

  function trackingBanner(meta) {
    if (!meta) return '';
    if (meta.leesfout) return `<div class="card" style="margin-bottom:12px"><div class="card-body" style="font-size:12.5px;color:var(--amber)">De tracking (funnel_events) kon niet gelezen worden: ${esc(meta.leesfout)}. Bezoekers en kanalen ontbreken; de leads komen uit de leadlijst.</div></div>`;
    if (!meta.tracking_actief) return '<div class="card" style="margin-bottom:12px"><div class="card-body" style="font-size:12.5px;color:var(--amber)">Tracking niet beschikbaar (funnel_events): bezoekers en kanalen ontbreken; de leads komen uit de leadlijst.</div></div>';
    if (meta.afgekapt) return '<div class="card" style="margin-bottom:12px"><div class="card-body" style="font-size:12.5px;color:var(--amber)">Meer tracking-events dan het maximum of de tijdslimiet — bezoekersaantallen zijn mogelijk te laag.</div></div>';
    return '';
  }

  // ── Overzicht ─────────────────────────────────────────────────────────────
  function overzichtHtml() {
    const d = st.data || {};
    const drops = Array.isArray(d.drops) ? d.drops : [];
    const t = d.totaal || {};
    const kop = `<div style="display:flex;align-items:center;justify-content:space-between;gap:10px;margin-bottom:12px;flex-wrap:wrap">
      <div><div style="font-size:18px;font-weight:700">Trainingdrops</div>
      <div style="color:var(--text-3);font-size:12.5px">De wekelijkse opname van de live training op training.deforexopleiding.nl — bezoekers, aanmeldingen en kanalen per drop.</div></div>
      <button class="btn btn-ghost btn-sm" onclick="__tdVernieuw()">${st.loading ? 'Laden…' : 'Vernieuwen'}</button></div>`;

    if (!drops.length) {
      return `${kop}${trackingBanner(d.meta)}<div class="card"><div class="card-body" style="text-align:center;padding:28px 18px">
        <div style="font-size:14px;font-weight:600;margin-bottom:4px">Nog geen trainingdrops</div>
        <div style="color:var(--text-3);font-size:12.5px;max-width:460px;margin:0 auto">Zodra er een training live staat (training.deforexopleiding.nl/dd-mm-jj) en de eerste bezoekers of aanmeldingen binnenkomen, verschijnt die hier — elke week een nieuwe regel, de nieuwste bovenaan.</div>
      </div></div>`;
    }

    const kpi = tegels(
      tegel('Drops', num(t.drops), 'trainingen met bezoek of leads')
      + tegel('Bezoekers', num(t.bezoekers), 'landing-sessies, alle drops')
      + tegel('Leads', num(t.leads), 'aanmeldingen, zonder testleads')
      + tegel('Conversie', pctTxt(t.conversie_pct), 'leads ÷ bezoekers')
      + tegel('Calls ingepland', num(t.calls), num(t.calls_gehouden) + ' gehouden · ' + num(t.cadeau_klik) + ' cadeau-klikken')
      + tegel('Lead → call', pctTxt(t.lead_call_pct), 'leads met een strategiesessie'));

    const th = 'padding:10px 12px;font-size:10.5px;text-transform:uppercase;letter-spacing:.06em;color:var(--text-3);font-weight:600;border-bottom:1px solid var(--border);white-space:nowrap;text-align:left';
    const td = 'padding:10px 12px;border-bottom:1px solid var(--border);vertical-align:middle';
    const rijen = drops.map((x) => `<tr class="td-rij" data-variant="${esc(x.variant)}" role="button" tabindex="0" style="cursor:pointer"
        onclick="__tdOpen('${esc(x.variant)}')" onkeydown="__tdOpenToets(event,'${esc(x.variant)}')">
      <td style="${td};white-space:nowrap"><b>${esc(x.label)}</b><div style="color:var(--text-3);font-size:11.5px">${esc(fmtDag(x.datum))}</div></td>
      <td style="${td};text-align:right;font-variant-numeric:tabular-nums">${num(x.bezoekers)}</td>
      <td class="td-col-mob-weg" style="${td};text-align:right;font-variant-numeric:tabular-nums">${num(x.formulier_gestart)}</td>
      <td style="${td};text-align:right;font-variant-numeric:tabular-nums"><b>${num(x.leads)}</b>${x.test_leads ? `<div style="color:var(--text-3);font-size:10.5px">+${num(x.test_leads)} test</div>` : ''}</td>
      <td style="${td};text-align:right;font-variant-numeric:tabular-nums">${pctTxt(x.conversie_pct)}</td>
      <td class="td-col-mob-weg" style="${td};text-align:right;font-variant-numeric:tabular-nums">${num(x.cadeau_klik)}</td>
      <td style="${td};text-align:right;font-variant-numeric:tabular-nums" title="${esc(callUitsplitsing(x))}"><b>${num(x.calls)}</b>${x.calls ? `<div style="color:var(--text-3);font-size:10.5px">${num(x.calls_gehouden)} gehouden</div>` : ''}</td>
      <td class="td-col-mob-weg" style="${td};text-align:right;font-variant-numeric:tabular-nums">${pctTxt(x.lead_call_pct)}</td>
      <td class="td-col-kanaal" style="${td};min-width:180px">${kanaalChips(x.leads_per_kanaal, 'nog geen leads')}</td>
      <td class="td-col-mob-weg" style="${td};text-align:right">${linksHtml(x)}</td>
    </tr>`).join('');

    return `${kop}${trackingBanner(d.meta)}${kpi}
      <div class="card td-tabel" style="overflow:hidden"><div style="overflow-x:auto"><table style="width:100%;border-collapse:collapse;font-size:12.5px;min-width:960px">
        <thead><tr><th style="${th}">Training</th><th style="${th};text-align:right">Bezoekers</th><th class="td-col-mob-weg" style="${th};text-align:right">Formulier gestart</th>
          <th style="${th};text-align:right">Leads</th><th style="${th};text-align:right">Conversie</th>
          <th class="td-col-mob-weg" style="${th};text-align:right">Cadeau-klik</th><th style="${th};text-align:right">Calls</th><th class="td-col-mob-weg" style="${th};text-align:right">Lead → call</th>
          <th class="td-col-kanaal" style="${th}">Leads per kanaal</th><th class="td-col-mob-weg" style="${th}"></th></tr></thead>
        <tbody>${rijen}</tbody></table></div></div>
      <div style="font-size:11.5px;color:var(--text-3);margin-top:8px">Klik op een drop voor de leads. Bezoekers = unieke sessies op de pagina; conversie = leads ÷ bezoekers. Calls = ingeplande strategiesessies met Dave (cadeau); lead → call = leads met een call ÷ leads. Testleads (e-mail met "test") tellen niet mee. ${esc((d.meta && d.meta.kanaal_uitleg) || '')}</div>`;
  }

  // ── Detail van één drop ───────────────────────────────────────────────────
  function kanaalTabel(x) {
    const VAST = ['ig-story', 'ig-bio', 'nieuwsbrief', 'whatsapp', 'meta-ad', 'direct'];
    const rijen = (x.kanalen || []).filter((k) => VAST.includes(k.kanaal) || k.bezoekers || k.leads || k.cadeau_klik || k.calls);
    const td = 'padding:6px 10px;border-bottom:1px solid var(--border);text-align:right;font-variant-numeric:tabular-nums';
    const th = 'padding:8px 10px;text-align:right;white-space:nowrap';
    const rij = (k) => `<tr><td style="padding:6px 10px;border-bottom:1px solid var(--border)" title="${esc(k.kanaal)}">${esc(k.label)}</td>
        <td style="${td}">${num(k.bezoekers)}</td>
        <td style="${td}"><b>${num(k.leads)}</b></td>
        <td class="td-col-mob-weg" style="${td}">${k.bezoekers ? pctTxt(Math.round((k.leads / k.bezoekers) * 1000) / 10) : '—'}</td>
        <td class="td-col-mob-weg" style="${td}">${num(k.cadeau_klik)}</td>
        <td style="${td}"><b>${num(k.calls)}</b></td>
        <td class="td-col-mob-weg" style="${td}">${num(k.gehouden)}</td>
        <td class="td-col-mob-weg" style="${td}">${num(k.no_show)}</td>
        <td class="td-col-mob-weg" style="${td}">${num(k.geannuleerd)}</td>
        <td style="${td}">${pctTxt(k.lead_call_pct)}</td></tr>`;
    return `<div class="card td-kanaal" style="margin-bottom:12px"><div class="card-head"><div class="card-title">Per kanaal</div></div>
      <div style="overflow-x:auto"><table style="width:100%;border-collapse:collapse;font-size:12.5px">
      <thead><tr style="text-align:left;color:var(--text-3);font-size:10.5px;text-transform:uppercase;letter-spacing:.06em">
        <th style="padding:8px 10px">Kanaal</th><th style="${th}">Bezoekers</th><th style="${th}">Leads</th><th class="td-col-mob-weg" style="${th}">Conversie</th>
        <th class="td-col-mob-weg" style="${th}">Cadeau-klik</th><th style="${th}">Calls</th><th class="td-col-mob-weg" style="${th}">Gehouden</th>
        <th class="td-col-mob-weg" style="${th}">No-show</th><th class="td-col-mob-weg" style="${th}">Geannuleerd</th><th style="${th}">Lead → call</th></tr></thead>
      <tbody>${rijen.map(rij).join('')}</tbody></table></div></div>`;
  }

  function leadTabel(x) {
    const alle = Array.isArray(x.lead_lijst) ? x.lead_lijst : [];
    const lijst = st.toonTest ? alle : alle.filter((l) => !l.test);
    const nTest = alle.length - alle.filter((l) => !l.test).length;
    const testKnop = nTest ? `<label style="font-size:12px;color:var(--text-2);display:inline-flex;gap:6px;align-items:center;cursor:pointer">
      <input type="checkbox" ${st.toonTest ? 'checked' : ''} onchange="__tdTest(this.checked)"> Toon testleads (${num(nTest)})</label>` : '';
    const kop = `<div class="card-head" style="flex-wrap:wrap;gap:8px"><div class="card-title">Leads (${num(x.leads)})</div>${testKnop}</div>`;
    if (!lijst.length) {
      return `<div class="card">${kop}<div class="card-body" style="color:var(--text-3);font-size:12.5px">${alle.length ? 'Alleen testleads bij deze drop.' : 'Nog geen aanmeldingen voor deze training.'}</div></div>`;
    }
    const td = 'padding:9px 12px;border-bottom:1px solid var(--border);vertical-align:top';
    const rijen = lijst.map((l) => `<tr>
      <td style="${td}"><a href="javascript:void(0)" onclick="__tdLead('${esc(l.id)}')" style="font-weight:600;color:var(--brand,#0A7490)">${esc(l.naam || l.email || 'Naamloos')}</a>
        ${l.test ? ' ' + pill('warn', 'test') : ''}
        <div style="color:var(--text-3);font-size:11.5px">${esc(l.email || '—')}</div></td>
      <td class="td-col-mob-weg" style="${td};white-space:nowrap">${esc(l.telefoon || '—')}</td>
      <td style="${td}">${esc(l.kanaal_label || '—')}${l.campagne ? `<div style="color:var(--text-3);font-size:11px" title="utm_campaign">${esc(l.campagne)}</div>` : ''}</td>
      <td style="${td};white-space:nowrap">${l.call ? `${esc(fmtCall(l.call.scheduled_at))}<div style="margin-top:2px">${pill(CALL_PILL[l.call.categorie] || 'neutral', l.call.label || l.call.status || '—', l.call.status || '')}</div>` : '<span style="color:var(--text-3)">geen</span>'}</td>
      <td class="td-col-mob-weg" style="${td};white-space:nowrap">${esc(fmtTijd(l.aangemeld_op))}${l.bron_elders ? `<div style="color:var(--text-3);font-size:11px" title="Huidige bron in de leadlijst">nu: ${esc(l.huidige_bron || '—')}</div>` : ''}</td>
      <td class="td-col-mob-weg" style="${td}">${l.status ? pill('neutral', l.status) : '—'}</td>
    </tr>`).join('');
    return `<div class="card td-leads">${kop}<div style="overflow-x:auto"><table style="width:100%;border-collapse:collapse;font-size:12.5px;min-width:760px">
      <thead><tr style="text-align:left;color:var(--text-3);font-size:10.5px;text-transform:uppercase;letter-spacing:.06em">
        <th style="padding:8px 12px">Lead</th><th class="td-col-mob-weg" style="padding:8px 12px">Telefoon</th><th style="padding:8px 12px">Kanaal</th><th style="padding:8px 12px">Call</th><th class="td-col-mob-weg" style="padding:8px 12px">Aangemeld</th><th class="td-col-mob-weg" style="padding:8px 12px">Status</th></tr></thead>
      <tbody>${rijen}</tbody></table></div>
      <div style="padding:8px 12px;font-size:11.5px;color:var(--text-3)">Klik op een naam voor het leaddossier.</div></div>`;
  }

  function detailHtml(x) {
    const links = x.links ? `<div style="display:flex;gap:12px;flex-wrap:wrap;font-size:12.5px;margin-top:4px">
      <a href="${esc(x.links.live)}" target="_blank" rel="noopener" style="color:var(--brand,#0A7490)">${esc(x.links.live.replace('https://', ''))} ↗</a>
      <a href="${esc(x.links.site)}" target="_blank" rel="noopener" style="color:var(--brand,#0A7490)">${esc(x.links.site.replace('https://', ''))} ↗</a></div>` : '';
    const kop = `<div style="display:flex;align-items:flex-start;gap:12px;margin-bottom:12px;flex-wrap:wrap">
      <button class="btn btn-sm" onclick="__tdOpen(null)">← Alle drops</button>
      <div style="min-width:0"><div style="font-size:18px;font-weight:700">${esc(x.label)}</div>
        <div style="color:var(--text-3);font-size:12.5px">${esc(fmtDag(x.datum))} · <span style="font-family:var(--mono,monospace)">${esc(x.variant)}</span></div>${links}</div>
      <button class="btn btn-ghost btn-sm" style="margin-left:auto" onclick="__tdVernieuw()">${st.loading ? 'Laden…' : 'Vernieuwen'}</button></div>`;
    const kpi = tegels(
      tegel('Bezoekers', num(x.bezoekers), 'unieke sessies')
      + tegel('Formulier gestart', num(x.formulier_gestart), x.bezoekers ? pctTxt(x.formulier_pct) + ' van de bezoekers' : '—')
      + tegel('Leads', num(x.leads), x.test_leads ? '+' + num(x.test_leads) + ' test niet meegeteld' : 'aanmeldingen')
      + tegel('Conversie', pctTxt(x.conversie_pct), 'leads ÷ bezoekers')
      + tegel('Cadeau-klikken', num(x.cadeau_klik), num(x.cadeau_getoond) + ' keer getoond')
      + tegel('Calls ingepland', num(x.calls), callUitsplitsing(x) || 'nog geen strategiesessies')
      + tegel('Lead → call', pctTxt(x.lead_call_pct), num(x.leads_met_call) + ' van ' + num(x.leads) + ' leads'));
    const d = st.data || {};
    const callsFout = d.meta && d.meta.calls_fout
      ? `<div class="card" style="margin-bottom:12px"><div class="card-body" style="font-size:12.5px;color:var(--amber)">De calls konden niet gelezen worden: ${esc(d.meta.calls_fout)}.</div></div>` : '';
    return `${kop}${trackingBanner(d.meta)}${callsFout}${kpi}${kanaalTabel(x)}${leadTabel(x)}
      <div style="font-size:11.5px;color:var(--text-3);margin-top:8px">${esc((d.meta && d.meta.kanaal_uitleg) || '')} Een lead die later een andere training of funnel deed, staat er nog bij (via de sessie); "nu:" toont zijn huidige bron.</div>`;
  }

  // Telefoon: kolommen die niet passen verdwijnen (geen horizontaal scrollen).
  const CSS = `<style>@media (max-width:640px){.td-tabel .td-col-kanaal,.td-tabel .td-col-mob-weg,.td-kanaal .td-col-mob-weg{display:none}.td-tabel table{min-width:0!important}.td-tabel td,.td-tabel th{padding-left:8px!important;padding-right:8px!important}.td-tabel td:first-child{white-space:normal!important}.td-leads .td-col-mob-weg{display:none}.td-leads table{min-width:0!important}}</style>`;

  function trainingdropsView() {
    if (!st.fetched && !st.loading) queueMicrotask(() => laad(false));
    if (st.error) return `<div class="pad"><div class="card"><div class="card-body" style="color:var(--rose)">${esc(st.error)}
      <div style="margin-top:8px"><button class="btn btn-sm" onclick="__tdVernieuw()">Opnieuw proberen</button></div></div></div></div>`;
    if (!st.fetched) return '<div class="pad" style="color:var(--text-3);font-size:12.5px">Trainingdrops laden…</div>';
    const drops = (st.data && Array.isArray(st.data.drops)) ? st.data.drops : [];
    const open = st.open ? drops.find((x) => x.variant === st.open) : null;
    if (st.open && !open) st.open = null;
    return `<div class="pad">${CSS}${open ? detailHtml(open) : overzichtHtml()}</div>`;
  }

  window.DFO.VIEWS = window.DFO.VIEWS || {};
  window.DFO.VIEWS['trainingdrops/'] = trainingdropsView;
  if (typeof window.KV_V2_ADD === 'function') window.KV_V2_ADD('trainingdrops');
  else (window.KV_V2_PENDING = window.KV_V2_PENDING || []).push('trainingdrops');
})();
