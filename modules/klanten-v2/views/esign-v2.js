// modules/klanten-v2/views/esign-v2.js
//
// Module E-handtekening — fase 1 (2026-11-09): overzicht van alle envelopes.
//   - KPI-strip die filtert (concept / lopend / voltooid / ingetrokken)
//   - per envelope: titel, ondertekenaars met voortgang, status, data
//   - acties: Bewerken (concept → editor), Opnieuw versturen, Intrekken,
//     Getekend downloaden, Origineel, Details (audit-tijdlijn), Afronden
//     opnieuw proberen (na een fout bij het afronden)
// Nieuwe envelope + velden plaatsen = de losse editor /modules/esign/editor.html
// (pdf.js + slepen past niet in deze innerHTML-render).
// Data: /api/esign (esign.view lezen, esign.send voor de knoppen).
(function () {
  'use strict';
  window.DFO = window.DFO || {};

  const esc = (s) => String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  const ZONE = 'Europe/Amsterdam';
  const fmt = (iso) => (iso ? new Intl.DateTimeFormat('nl-NL', { timeZone: ZONE, day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' }).format(new Date(iso)) : '—');
  const EDITOR = '/modules/esign/editor.html';

  const STATUS = {
    concept: ['Concept', 'neutral'], verzonden: ['Verzonden', 'warn'], deels_getekend: ['Deels getekend', 'warn'],
    voltooid: ['Voltooid', 'ok'], ingetrokken: ['Ingetrokken', 'danger'],
  };
  const ONTV = { wacht: ['wacht', '○'], uitgenodigd: ['uitgenodigd', '✉'], geopend: ['geopend', '👁'], getekend: ['getekend', '✓'] };
  const EVENT = {
    aangemaakt: 'Aangemaakt', verzonden: 'Verzonden', uitgenodigd: 'Uitnodiging gemaild', opnieuw_verzonden: 'Opnieuw verstuurd',
    geopend: 'Geopend', getekend: 'Ondertekend', voltooid: 'Voltooid', ingetrokken: 'Ingetrokken', mail_mislukt: 'Mail mislukt', afronden_mislukt: 'Afronden mislukt',
  };
  const KPI = [['', 'Alle'], ['concept', 'Concept'], ['lopend', 'Lopend'], ['voltooid', 'Voltooid'], ['ingetrokken', 'Ingetrokken']];

  const st = window.__esState = window.__esState || {
    loading: false, fetched: false, error: null, envelopes: [], filter: '', bezig: null,
    open: null, detail: null, detailLaden: false, migratieNodig: false, _seq: 0,
  };
  function rerender() { if (window.DFO && typeof window.DFO.render === 'function') window.DFO.render(); }
  function toast(m) { if (window.KV && typeof window.KV.toast === 'function') window.KV.toast(m); }
  const magVersturen = () => !!(window.RBAC && typeof window.RBAC.canSync === 'function' && window.RBAC.canSync('esign.send'));

  async function laad(force) {
    if (st.loading || (st.fetched && !force)) return;
    st.loading = true; st.error = null; const seq = ++st._seq; rerender();
    try {
      const j = await window.KV.authedJson('/api/esign?actie=lijst');
      if (seq !== st._seq) return;
      st.envelopes = Array.isArray(j.envelopes) ? j.envelopes : []; st.migratieNodig = false;
    } catch (e) {
      if (seq !== st._seq) return;
      if (e && e.status === 503) { st.migratieNodig = true; st.envelopes = []; }
      else st.error = e && e.status === 403 ? 'Geen toegang tot E-handtekening (recht esign.view).' : 'Kon de envelopes niet laden' + (e && e.status ? ' (HTTP ' + e.status + ')' : '');
      console.error('[esign-v2] laden mislukt:', e && e.status, e && (e.body || e.message));
    }
    st.loading = false; st.fetched = true; rerender();
  }

  async function laadDetail(id) {
    st.detailLaden = true; rerender();
    try { st.detail = await window.KV.authedJson('/api/esign?actie=detail&id=' + encodeURIComponent(id)); }
    catch (e) { st.detail = null; toast('Details laden mislukt: ' + ((e && (e.body && e.body.error)) || e.message)); }
    st.detailLaden = false; rerender();
  }

  async function actie(body, okTekst) {
    st.bezig = body.id; rerender();
    try {
      const j = await window.KV.authedJson('/api/esign', { method: 'POST', body: JSON.stringify(body) });
      const mislukt = (j.uitnodigingen || []).filter((u) => !u.mail_ok).length;
      toast(mislukt ? `${okTekst} — ${mislukt} mail(s) mislukt.` : okTekst);
      st.bezig = null; await laad(true);
      if (st.open === body.id) await laadDetail(body.id);
    } catch (e) {
      st.bezig = null; rerender();
      toast(((e && e.body && e.body.error) || (e && e.message) || 'Mislukt'));
    }
  }

  // ── Acties (globaal voor onclick) ─────────────────────────────────────────
  window.__esFilter = (f) => { st.filter = f; rerender(); };
  window.__esVernieuw = () => laad(true);
  window.__esDetail = (id) => { if (st.open === id) { st.open = null; st.detail = null; rerender(); return; } st.open = id; st.detail = null; laadDetail(id); };
  window.__esOpnieuw = (id) => { if (confirm('Een nieuwe link sturen naar wie nu aan de beurt is? De vorige link werkt dan niet meer.')) actie({ actie: 'opnieuw_versturen', id }, 'Opnieuw verstuurd.'); };
  window.__esIntrekken = (id) => {
    const reden = prompt('Envelope intrekken. De links werken daarna niet meer.\n\nReden (optioneel):', '');
    if (reden === null) return;
    actie({ actie: 'intrekken', id, reden }, 'Ingetrokken.');
  };
  window.__esAfronden = (id) => actie({ actie: 'afronden', id }, 'Afgerond en gemaild.');
  window.__esDownload = async (id, soort) => {
    try {
      const j = await window.KV.authedJson('/api/esign?actie=download&id=' + encodeURIComponent(id) + '&soort=' + soort);
      window.open(j.url, '_blank', 'noopener');
    } catch (e) { toast('Downloaden mislukt: ' + ((e && e.body && e.body.error) || e.message)); }
  };

  // ── Weergave ──────────────────────────────────────────────────────────────
  const pill = (c, t, titel) => `<span class="pill pill-${c} nodot"${titel ? ` title="${esc(titel)}"` : ''}>${esc(t)}</span>`;
  const lopend = (e) => e.status === 'verzonden' || e.status === 'deels_getekend';
  function gefilterd() {
    if (!st.filter) return st.envelopes;
    if (st.filter === 'lopend') return st.envelopes.filter(lopend);
    return st.envelopes.filter((e) => e.status === st.filter);
  }

  function ontvangersCel(e) {
    const o = e.ontvangers || [];
    const klaar = o.filter((x) => x.status === 'getekend').length;
    return `<div style="font-size:11.5px;color:var(--text-3);margin-bottom:3px">${klaar} van ${o.length} getekend · ${e.volgorde === 'parallel' ? 'tegelijk' : 'een voor een'}</div>
      ${o.map((x) => { const [l, i] = ONTV[x.status] || [x.status, '•']; return `<div title="${esc(x.email)} — ${esc(l)}" style="white-space:nowrap;font-size:12px">${i} ${esc(x.naam)}</div>`; }).join('')}`;
  }

  function knoppen(e) {
    const b = st.bezig === e.id; const dis = b ? 'disabled' : '';
    const k = [];
    const send = magVersturen();
    if (e.status === 'concept' && send) k.push(`<a class="btn btn-primary btn-sm" style="text-decoration:none" href="${EDITOR}?id=${encodeURIComponent(e.id)}">Bewerken</a>`);
    if (lopend(e) && send) k.push(`<button class="btn btn-ghost btn-sm" ${dis} onclick="__esOpnieuw('${esc(e.id)}')">Opnieuw versturen</button>`);
    if (lopend(e) && send && e.afronden_fout && (e.ontvangers || []).every((o) => o.status === 'getekend')) k.push(`<button class="btn btn-primary btn-sm" ${dis} onclick="__esAfronden('${esc(e.id)}')" title="${esc(e.afronden_fout)}">Afronden opnieuw proberen</button>`);
    if (e.status === 'voltooid') k.push(`<button class="btn btn-primary btn-sm" onclick="__esDownload('${esc(e.id)}','getekend')">Getekend PDF</button>`);
    k.push(`<button class="btn btn-ghost btn-sm" onclick="__esDetail('${esc(e.id)}')">${st.open === e.id ? 'Sluiten' : 'Details'}</button>`);
    if ((e.status === 'concept' || lopend(e)) && send) k.push(`<button class="btn btn-ghost btn-sm" style="color:var(--rose)" ${dis} onclick="__esIntrekken('${esc(e.id)}')">Intrekken</button>`);
    return k.join(' ');
  }

  function detailHtml(e) {
    if (st.open !== e.id) return '';
    if (st.detailLaden || !st.detail) return `<tr><td colspan="6" style="padding:12px;color:var(--text-3)">Details laden…</td></tr>`;
    const d = st.detail; const env = d.envelope;
    const naam = new Map((env.ontvangers || []).map((o) => [o.id, o.naam]));
    const doc = (env.documenten || [])[0];
    return `<tr><td colspan="6" style="background:var(--bg-2, #f7f8fb);padding:12px 14px">
      <div style="display:grid;grid-template-columns:minmax(220px,1fr) minmax(260px,2fr);gap:16px;font-size:12.5px">
        <div>
          <div style="font-weight:700;margin-bottom:6px">Document</div>
          <div>${doc ? '📄 ' + esc(doc.naam) + ' · ' + (doc.paginas || []).length + ' pagina(s)' : '—'}</div>
          ${doc ? `<div style="color:var(--text-3);word-break:break-all;font-size:11px;margin-top:2px">SHA-256 origineel: ${esc(doc.sha256)}</div>
          <div style="margin-top:6px"><button class="btn btn-ghost btn-sm" onclick="__esDownload('${esc(env.id)}','origineel')">Origineel bekijken</button></div>` : ''}
          ${env.eind_sha256 ? `<div style="color:var(--text-3);word-break:break-all;font-size:11px;margin-top:8px">SHA-256 getekend: ${esc(env.eind_sha256)}</div>` : ''}
          ${env.afronden_fout ? `<div style="color:var(--rose);margin-top:8px">Afronden mislukt: ${esc(env.afronden_fout)}</div>` : ''}
          ${env.ingetrokken_reden ? `<div style="margin-top:8px">Reden intrekken: ${esc(env.ingetrokken_reden)}</div>` : ''}
          <div style="font-weight:700;margin:12px 0 6px">Ondertekenaars</div>
          ${(env.ontvangers || []).map((o) => `<div style="margin-bottom:6px"><b>${o.volgnummer}. ${esc(o.naam)}</b> <span style="color:var(--text-3)">${esc(o.email)}</span><br>
            <span style="color:var(--text-3);font-size:11.5px">${esc((ONTV[o.status] || [o.status])[0])}${o.getekend_op ? ' · getekend ' + fmt(o.getekend_op) : ''}${o.token_verloopt_op && o.status !== 'getekend' ? ' · link geldig tot ' + fmt(o.token_verloopt_op) : ''}</span></div>`).join('')}
        </div>
        <div>
          <div style="font-weight:700;margin-bottom:6px">Audit-tijdlijn</div>
          <table style="width:100%;border-collapse:collapse;font-size:12px"><thead><tr><th style="text-align:left">Tijdstip</th><th style="text-align:left">Gebeurtenis</th><th style="text-align:left">Wie</th><th style="text-align:left">IP</th></tr></thead>
          <tbody>${(d.events || []).map((ev) => `<tr><td style="white-space:nowrap">${fmt(ev.tijdstip)}</td><td>${esc(EVENT[ev.type] || ev.type)}</td>
            <td>${esc(ev.ontvanger_id ? (naam.get(ev.ontvanger_id) || '—') : ((ev.details && ev.details.door_naam) || (ev.methode === 'systeem' ? 'Systeem' : 'CRM')))}</td>
            <td title="${esc(ev.user_agent || '')}">${esc(ev.ip || '—')}</td></tr>`).join('')}</tbody></table>
        </div>
      </div></td></tr>`;
  }

  function rij(e) {
    const [sl, sc] = STATUS[e.status] || [e.status, 'neutral'];
    return `<tr${st.bezig === e.id ? ' style="opacity:.55"' : ''}>
      <td><b>${esc(e.titel)}</b><div style="color:var(--text-3);font-size:11.5px">door ${esc(e.aangemaakt_door_naam || '—')}${e.entiteit_type ? ' · gekoppeld aan ' + esc(e.entiteit_type) : ''}</div></td>
      <td>${pill(sc, sl, e.afronden_fout ? 'Afronden mislukt: ' + e.afronden_fout : '')}${e.afronden_fout ? '<div style="color:var(--rose);font-size:11px">afronden mislukt</div>' : ''}</td>
      <td style="min-width:180px">${ontvangersCel(e)}</td>
      <td style="white-space:nowrap">${fmt(e.verzonden_op || e.created_at)}</td>
      <td style="white-space:nowrap">${e.status === 'voltooid' ? fmt(e.voltooid_op) : e.status === 'ingetrokken' ? fmt(e.ingetrokken_op) : '—'}</td>
      <td class="r" style="white-space:nowrap">${knoppen(e)}</td></tr>${detailHtml(e)}`;
  }

  function view() {
    if (!st.fetched && !st.loading) queueMicrotask(() => laad(false));
    if (st.error) return `<div class="pad"><div class="card"><div class="card-body" style="color:var(--rose)">${esc(st.error)}</div></div></div>`;
    if (!st.fetched) return '<div class="pad" style="color:var(--text-3);font-size:12.5px">Envelopes laden…</div>';
    const kop = `<div style="display:flex;align-items:center;justify-content:space-between;gap:10px;margin-bottom:12px;flex-wrap:wrap">
      <div><div style="font-size:18px;font-weight:700">E-handtekening</div><div style="color:var(--text-3);font-size:12.5px">Documenten laten ondertekenen door teamleden, met audit-certificaat.</div></div>
      <div style="display:flex;gap:8px"><button class="btn btn-ghost btn-sm" onclick="__esVernieuw()">${st.loading ? 'Laden…' : 'Vernieuwen'}</button>
      ${magVersturen() ? `<a class="btn btn-primary btn-sm" style="text-decoration:none" href="${EDITOR}">+ Nieuwe envelope</a>` : ''}</div></div>`;
    if (st.migratieNodig) {
      return `<div class="pad">${kop}<div class="card"><div class="card-body" style="font-size:12.5px">De module is nog niet geïnstalleerd. Draai <span class="mono">docs/sql-migrations/2026-11-09-e-handtekening-fase1-tabellen.sql</span> en <span class="mono">…-bucket.sql</span>.</div></div></div>`;
    }
    const tel = (f) => (f === '' ? st.envelopes.length : f === 'lopend' ? st.envelopes.filter(lopend).length : st.envelopes.filter((e) => e.status === f).length);
    const kpi = `<div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:10px;margin-bottom:12px">${KPI.map(([f, l]) => `
      <button class="card" style="padding:12px 14px;margin:0;text-align:left;cursor:pointer;${st.filter === f ? 'outline:2px solid var(--accent, #2D74D6)' : ''}" onclick="__esFilter('${f}')" aria-pressed="${st.filter === f}">
        <div style="color:var(--text-3);font-size:11px;text-transform:uppercase;letter-spacing:.06em">${l}</div>
        <div style="font-size:22px;font-weight:700;margin-top:2px">${tel(f)}</div></button>`).join('')}</div>`;
    const lijst = gefilterd();
    const tabel = lijst.length
      ? `<div class="card"><div class="tbl-wrap"><table style="width:100%;border-collapse:collapse;font-size:12.5px">
        <thead><tr><th>Envelope</th><th>Status</th><th>Ondertekenaars</th><th>Verzonden</th><th>Afgerond</th><th class="r">Acties</th></tr></thead>
        <tbody>${lijst.map(rij).join('')}</tbody></table></div></div>`
      : `<div class="card"><div class="card-body" style="color:var(--text-3);font-size:12.5px">${st.envelopes.length ? 'Geen envelopes met deze status.' : 'Nog geen envelopes. Maak er een via "+ Nieuwe envelope".'}</div></div>`;
    return `<div class="pad">${kop}${kpi}${tabel}</div>`;
  }

  window.DFO.VIEWS = window.DFO.VIEWS || {};
  window.DFO.VIEWS['esign/Overzicht'] = view;
})();
