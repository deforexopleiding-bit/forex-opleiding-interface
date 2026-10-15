// modules/klanten-v2/views/scans-v2.js
//
// Module Strategie-scans — fase 3 (2026-10-15): Dave's werkplek.
//   - Lijst van alle scans/rapporten: deelnemer, datum, assessor, status
//     (concept / afgerond / rapport verstuurd), readiness-score, categorie,
//     aanbevolen aanpak, aanbevolen traject en KLANT-STATUS.
//   - Klant-status (api/_lib/scan-klant.js): automatisch uit de deals (gewonnen
//     deal → "Klant" + traject), of handmatig gezet (klant / in gesprek / geen
//     klant). Handmatig heeft voorrang; de bron staat er zichtbaar bij.
//   - Filters: status, categorie, traject, aanpak, klant ja/nee, periode,
//     assessor. Zoeken: naam/e-mail. Sorteren: datum, score, naam, status.
//   - Acties: nieuwe scan (lead zoeken of zonder lead), rapport bekijken,
//     openen/bewerken (de scan-pagina /scan?id=…), klant-status zetten,
//     verwijderen (met bevestiging).
// Data: /api/scans-overzicht (recht scan.use). Rapport: /api/scan-rapport.
(function () {
  'use strict';
  window.DFO = window.DFO || {};
  const H = (window.KV_V2 && window.KV_V2.helpers) || {};

  const esc = (s) => String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  const ZONE = 'Europe/Amsterdam';
  const fmtDag = (iso) => (iso ? new Intl.DateTimeFormat('nl-NL', { timeZone: ZONE, day: 'numeric', month: 'short', year: 'numeric' }).format(new Date(iso)) : '—');
  const ZOEK = 'scan-q';
  const TRASH = '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 6h18"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"/><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>';

  const STATUS = { concept: ['Concept', 'neutral'], afgerond: ['Afgerond', 'accent'], verstuurd: ['Rapport verstuurd', 'ok'] };
  const CATEGORIE = { 'Zeer geschikt': 'ok', 'Geschikt met de juiste begeleiding': 'warn', 'Nu nog niet': 'danger' };
  const KLANT = { klant: ['Klant', 'ok'], in_gesprek: ['In gesprek', 'warn'], geen_klant: ['Geen klant', 'neutral'] };
  const PERIODES = [['alles', 'Alle periodes'], ['30', 'Laatste 30 dagen'], ['90', 'Laatste 90 dagen'], ['jaar', 'Dit jaar'], ['eigen', 'Eigen periode…']];

  const st = window.__scState = window.__scState || {
    loading: false, fetched: false, error: null, migratieNodig: false, scans: [], assessoren: [], _seq: 0,
    f: { status: '', categorie: '', traject: '', aanpak: '', klant: '', assessor: '', periode: 'alles', van: '', tot: '' },
    sort: 'datum_af', bezig: null,
    nieuw: { open: false, zoek: '', leads: [], zoeken: false },
  };

  function rerender() { if (window.DFO && typeof window.DFO.render === 'function') window.DFO.render(); }
  function toast(m) { if (window.KV && typeof window.KV.toast === 'function') window.KV.toast(m); }
  if (H.onSearch) H.onSearch(ZOEK, () => rerender(), { debounceMs: 200 });

  async function laad(force) {
    if (st.loading || (st.fetched && !force)) return;
    st.loading = true; st.error = null;
    const seq = ++st._seq;
    rerender();
    try {
      const j = await window.KV.authedJson('/api/scans-overzicht');
      if (seq !== st._seq) return;
      st.scans = Array.isArray(j.scans) ? j.scans : [];
      st.assessoren = Array.isArray(j.assessoren) ? j.assessoren : [];
      st.migratieNodig = !!j.migratie_nodig;
    } catch (e) {
      if (seq !== st._seq) return;
      st.error = e && e.status === 403 ? 'Geen toegang tot de strategie-scans (recht scan.use).'
        : 'Kon de scans niet laden' + (e && e.status ? ' (HTTP ' + e.status + ')' : '');
      console.error('[scans-v2] laden mislukt:', e && e.status, e && (e.body || e.message));
    }
    st.loading = false; st.fetched = true;
    rerender();
  }

  // ── Filteren + sorteren (in de browser; een paar honderd rijen) ───────────
  function periodeGrens() {
    const f = st.f; const nu = new Date();
    if (f.periode === '30' || f.periode === '90') return { van: new Date(nu.getTime() - Number(f.periode) * 86400000), tot: null };
    if (f.periode === 'jaar') return { van: new Date(nu.getFullYear(), 0, 1), tot: null };
    if (f.periode === 'eigen') {
      return { van: f.van ? new Date(f.van + 'T00:00:00') : null, tot: f.tot ? new Date(new Date(f.tot + 'T00:00:00').getTime() + 86400000) : null };
    }
    return { van: null, tot: null };
  }
  function gefilterd() {
    const f = st.f; const zoek = (H.getSearchValue ? H.getSearchValue(ZOEK) : '').trim().toLowerCase();
    const { van, tot } = periodeGrens();
    const lijst = st.scans.filter((s) => {
      if (f.status && s.status !== f.status) return false;
      if (f.categorie && s.categorie !== f.categorie) return false;
      if (f.traject && s.aanbevolen_traject !== f.traject) return false;
      if (f.aanpak && s.aanbevolen_aanpak !== f.aanpak) return false;
      if (f.assessor && s.assessor_id !== f.assessor) return false;
      if (f.klant === 'ja' && !(s.klant && s.klant.klant)) return false;
      if (f.klant === 'nee' && s.klant && s.klant.klant) return false;
      const d = new Date(s.aangemaakt);
      if (van && d < van) return false;
      if (tot && d >= tot) return false;
      if (zoek && !((s.deelnemer_naam || '').toLowerCase().includes(zoek) || (s.deelnemer_email || '').toLowerCase().includes(zoek))) return false;
      return true;
    });
    const volg = { concept: 0, afgerond: 1, verstuurd: 2 };
    const cmp = {
      datum_af: (a, b) => String(b.aangemaakt).localeCompare(String(a.aangemaakt)),
      datum_op: (a, b) => String(a.aangemaakt).localeCompare(String(b.aangemaakt)),
      score_af: (a, b) => (b.readiness_score ?? -1) - (a.readiness_score ?? -1),
      score_op: (a, b) => (a.readiness_score ?? 999) - (b.readiness_score ?? 999),
      naam: (a, b) => String(a.deelnemer_naam || '').localeCompare(String(b.deelnemer_naam || ''), 'nl'),
      status: (a, b) => (volg[a.status] ?? 9) - (volg[b.status] ?? 9) || String(b.aangemaakt).localeCompare(String(a.aangemaakt)),
    }[st.sort] || (() => 0);
    return lijst.sort(cmp);
  }

  // ── Acties ────────────────────────────────────────────────────────────────
  window.__scF = function (k, v) { st.f[k] = v; rerender(); };
  window.__scSort = function (v) { st.sort = v; rerender(); };
  window.__scWis = function () {
    st.f = { status: '', categorie: '', traject: '', aanpak: '', klant: '', assessor: '', periode: 'alles', van: '', tot: '' };
    if (H.setSearchValue) H.setSearchValue(ZOEK, '');
    rerender();
  };
  window.__scVernieuw = function () { laad(true); };

  window.__scKlant = async function (id, waarde) {
    st.bezig = id; rerender();
    try {
      await window.KV.authedJson('/api/scans-overzicht', { method: 'POST', body: JSON.stringify({ actie: 'klant_status', id, klant_status: waarde || null }) });
      toast(waarde ? 'Klant-status bijgewerkt.' : 'Klant-status weer automatisch.');
      st.bezig = null;
      await laad(true);
    } catch (e) {
      st.bezig = null; rerender();
      toast((e && e.body && e.body.error) || 'Klant-status opslaan mislukt.');
    }
  };

  window.__scVerwijder = async function (id) {
    const s = st.scans.find((x) => x.id === id);
    if (!s) return;
    const vraag = 'Scan van ' + (s.deelnemer_naam || 'deze deelnemer') + ' definitief verwijderen?'
      + (s.status === 'verstuurd' ? '\n\nHet rapport is al verstuurd; de deelnemer houdt de mail, maar de opgeslagen PDF\'s verdwijnen.' : '')
      + '\n\nDit kan niet ongedaan worden gemaakt.';
    if (!window.confirm(vraag)) return;
    st.bezig = id; rerender();
    try {
      await window.KV.authedJson('/api/scans-overzicht?id=' + encodeURIComponent(id), { method: 'DELETE' });
      st.scans = st.scans.filter((x) => x.id !== id);
      toast('Scan verwijderd.');
    } catch (e) {
      toast((e && e.body && e.body.error) || 'Verwijderen mislukt.');
    }
    st.bezig = null; rerender();
  };

  /** Rapport bekijken: verstuurd → de opgeslagen PDF; anders een voorbeeld van nu. */
  window.__scRapport = async function (id) {
    const s = st.scans.find((x) => x.id === id);
    const w = window.open('', '_blank'); // in de klik openen, anders blokkeert de browser
    if (w) w.document.write('<p style="font-family:system-ui;padding:24px;color:#555">Rapport laden…</p>');
    try {
      let url;
      if (s && s.rapport_pdf_ref) {
        const j = await window.KV.authedJson('/api/scan-rapport?id=' + encodeURIComponent(id) + '&soort=rapport&opgeslagen=1');
        url = j.url;
      } else {
        const r = await window.KV.authedFetch('/api/scan-rapport?id=' + encodeURIComponent(id) + '&soort=rapport');
        if (!r.ok) throw new Error('HTTP ' + r.status);
        url = URL.createObjectURL(await r.blob());
      }
      if (w) w.location.href = url; else window.open(url, '_blank');
    } catch (e) {
      if (w) w.close();
      toast('Rapport openen mislukt.');
      console.error('[scans-v2] rapport:', e && (e.body || e.message));
    }
  };

  window.__scNieuw = function () { st.nieuw = { open: !st.nieuw.open, zoek: '', leads: [], zoeken: false }; rerender(); };
  let zoekTimer = null;
  window.__scLeadZoek = function (v) {
    st.nieuw.zoek = v;
    clearTimeout(zoekTimer);
    zoekTimer = setTimeout(async () => {
      if (v.trim().length < 2) { st.nieuw.leads = []; tekenLeads(); return; }
      st.nieuw.zoeken = true; tekenLeads();
      try {
        const j = await window.KV.authedJson('/api/scans-overzicht?leads=' + encodeURIComponent(v.trim()));
        if (st.nieuw.zoek !== v) return;
        st.nieuw.leads = j.leads || [];
      } catch (e) { st.nieuw.leads = []; }
      st.nieuw.zoeken = false; tekenLeads();
    }, 250);
  };
  // Alleen de resultaten herschrijven (het zoekveld behoudt zijn focus).
  function tekenLeads() {
    const el = document.getElementById('scLeadRes');
    if (el) el.innerHTML = leadsHtml();
  }
  function leadsHtml() {
    const n = st.nieuw;
    if (n.zoeken) return '<div style="color:var(--text-3);font-size:12.5px;padding:6px 0">Zoeken…</div>';
    if (n.zoek.trim().length < 2) return '<div style="color:var(--text-3);font-size:12.5px;padding:6px 0">Typ minstens 2 tekens van de naam of het e-mailadres.</div>';
    if (!n.leads.length) return '<div style="color:var(--text-3);font-size:12.5px;padding:6px 0">Geen lead gevonden — begin dan zonder lead en vul de gegevens zelf in.</div>';
    return n.leads.map((l) => `<div style="display:flex;align-items:center;justify-content:space-between;gap:10px;padding:8px 0;border-top:1px solid var(--border)">
      <div><b>${esc(l.naam || 'Naamloos')}</b><div style="color:var(--text-3);font-size:12px">${esc(l.email)}${l.telefoon ? ' · ' + esc(l.telefoon) : ''}</div></div>
      <a class="btn btn-primary btn-sm" style="text-decoration:none" href="/scan?lead=${encodeURIComponent(l.id)}" target="_blank" rel="noopener">Start scan →</a></div>`).join('');
  }

  // ── Weergave ──────────────────────────────────────────────────────────────
  const pill = (c, t, titel) => `<span class="pill pill-${c} nodot"${titel ? ` title="${esc(titel)}"` : ''}>${esc(t)}</span>`;
  const sel = (k, opties, leeg) => `<select class="filter-sel" onchange="__scF('${k}', this.value)">
    <option value="">${esc(leeg)}</option>${opties.map((o) => {
      const [v, l] = Array.isArray(o) ? o : [o, o];
      return `<option value="${esc(v)}"${st.f[k] === v ? ' selected' : ''}>${esc(l)}</option>`;
    }).join('')}</select>`;

  function klantCel(s) {
    const k = s.klant || {};
    const huidig = k.bron === 'handmatig' ? k.status : '';
    let toon;
    if (k.status) {
      const [l, c] = KLANT[k.status];
      const sub = k.bron === 'automatisch'
        ? 'automatisch' + (k.auto && k.auto.traject ? ' · ' + k.auto.traject : '') + (k.auto && k.auto.datum ? ' · ' + fmtDag(k.auto.datum) : '')
        : 'handmatig' + (k.auto ? ' (deal: klant)' : '');
      toon = pill(c, l) + `<div style="color:var(--text-3);font-size:11px;margin-top:3px">${esc(sub)}</div>`;
    } else {
      toon = '<span style="color:var(--text-3)">Nog geen klant</span><div style="color:var(--text-3);font-size:11px;margin-top:3px">automatisch</div>';
    }
    const opties = [['', 'Automatisch'], ['klant', 'Klant'], ['in_gesprek', 'In gesprek'], ['geen_klant', 'Geen klant']]
      .map(([v, l]) => `<option value="${v}"${huidig === v ? ' selected' : ''}>${l}</option>`).join('');
    return `${toon}<select class="filter-sel" style="margin-top:5px;font-size:11.5px;padding:3px 6px" ${st.bezig === s.id || st.migratieNodig ? 'disabled' : ''}
      title="${st.migratieNodig ? 'Draai eerst de migratie 2026-10-15-scan-fase3.sql' : 'Klant-status handmatig zetten (heeft voorrang)'}"
      onchange="__scKlant('${esc(s.id)}', this.value)" aria-label="Klant-status">${opties}</select>`;
  }

  function rij(s) {
    const [sl, sc] = STATUS[s.status] || [s.status, 'neutral'];
    const bezig = st.bezig === s.id;
    return `<tr${bezig ? ' style="opacity:.55"' : ''}>
      <td><b>${esc(s.deelnemer_naam || 'Naamloos')}</b><div style="color:var(--text-3);font-size:11.5px">${esc(s.deelnemer_email || '—')}</div></td>
      <td style="white-space:nowrap">${fmtDag(s.aangemaakt)}</td>
      <td>${esc(s.assessor_naam || '—')}</td>
      <td>${pill(sc, sl, s.verstuurd_op ? 'Verstuurd op ' + fmtDag(s.verstuurd_op) : '')}</td>
      <td class="r"><b>${s.readiness_score != null ? s.readiness_score : '—'}</b></td>
      <td>${s.categorie ? pill(CATEGORIE[s.categorie] || 'neutral', s.categorie) : '—'}</td>
      <td>${esc(s.aanbevolen_aanpak || '—')}</td>
      <td style="white-space:nowrap">${esc(s.aanbevolen_traject || '—')}</td>
      <td style="min-width:150px">${klantCel(s)}</td>
      <td class="r" style="white-space:nowrap">
        <button class="btn btn-ghost btn-sm" onclick="__scRapport('${esc(s.id)}')" ${s.status === 'concept' ? 'title="Voorbeeld (nog niet afgerond)"' : ''}>Rapport</button>
        <a class="btn btn-ghost btn-sm" style="text-decoration:none" href="/scan?id=${encodeURIComponent(s.id)}" target="_blank" rel="noopener" title="Openen / bewerken (opnieuw genereren en versturen)">Openen</a>
        <button class="btn btn-ghost btn-sm" style="color:var(--rose);padding-left:7px;padding-right:7px" ${bezig ? 'disabled' : ''} onclick="__scVerwijder('${esc(s.id)}')" title="Verwijderen" aria-label="Verwijderen">${TRASH}</button>
      </td></tr>`;
  }

  function kpiHtml(lijst) {
    const n = lijst.length;
    const scores = lijst.map((s) => s.readiness_score).filter((x) => x != null);
    const gem = scores.length ? Math.round(scores.reduce((a, b) => a + b, 0) / scores.length) : null;
    const klanten = lijst.filter((s) => s.klant && s.klant.klant).length;
    const verstuurd = lijst.filter((s) => s.status === 'verstuurd').length;
    const tegel = (label, val, sub) => `<div class="card" style="padding:12px 14px;margin:0"><div style="color:var(--text-3);font-size:11px;text-transform:uppercase;letter-spacing:.06em">${label}</div>
      <div style="font-size:22px;font-weight:700;margin-top:2px">${val}</div><div style="color:var(--text-3);font-size:11.5px">${sub}</div></div>`;
    return `<div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(170px,1fr));gap:10px;margin-bottom:12px">
      ${tegel('Scans', n, 'in deze selectie')}
      ${tegel('Gem. readiness', gem != null ? gem : '—', 'van de 100')}
      ${tegel('Rapport verstuurd', verstuurd, n ? Math.round(verstuurd / n * 100) + '% van de scans' : '—')}
      ${tegel('Klant geworden', klanten, n ? Math.round(klanten / n * 100) + '% conversie' : '—')}
    </div>`;
  }

  function nieuwHtml() {
    if (!st.nieuw.open) return '';
    return `<div class="card" style="margin-bottom:12px"><div class="card-head"><div class="card-title">Nieuwe scan</div>
      <button class="btn btn-ghost btn-sm" onclick="__scNieuw()">Sluiten</button></div>
      <div class="card-body" style="font-size:12.5px">
        <p style="margin:0 0 8px;color:var(--text-2)">Zoek de lead (naam of e-mail) — de gegevens staan dan al ingevuld en de scan wordt aan de lead gekoppeld. De scan opent in een nieuwe tab zonder CRM-menu (geschikt om te delen).</p>
        <input class="input" id="scLeadZoek" placeholder="Naam of e-mailadres…" style="width:100%;max-width:420px;padding:9px 11px;font-size:13.5px" oninput="__scLeadZoek(this.value)" value="${esc(st.nieuw.zoek)}">
        <div id="scLeadRes" style="max-width:620px;margin-top:6px">${leadsHtml()}</div>
        <div style="margin-top:10px"><a class="btn btn-ghost btn-sm" style="text-decoration:none" href="/scan" target="_blank" rel="noopener">Zonder lead beginnen →</a></div>
      </div></div>`;
  }

  function scansView() {
    if (!st.fetched && !st.loading) queueMicrotask(() => laad(false));
    if (st.error) return `<div class="pad"><div class="card"><div class="card-body" style="color:var(--rose)">${esc(st.error)}</div></div></div>`;
    if (!st.fetched) return '<div class="pad" style="color:var(--text-3);font-size:12.5px">Scans laden…</div>';

    const trajecten = [...new Set(st.scans.map((s) => s.aanbevolen_traject).filter(Boolean))].sort();
    const lijst = gefilterd();
    const filters = `<div class="toolbar" style="display:flex;flex-wrap:wrap;gap:8px;align-items:center;margin-bottom:12px">
      ${H.stableSearch ? H.stableSearch(ZOEK, 'Zoek op naam of e-mail') : ''}
      ${sel('status', [['concept', 'Concept'], ['afgerond', 'Afgerond'], ['verstuurd', 'Rapport verstuurd']], 'Alle statussen')}
      ${sel('categorie', ['Zeer geschikt', 'Geschikt met de juiste begeleiding', 'Nu nog niet'], 'Alle categorieën')}
      ${sel('traject', trajecten, 'Alle trajecten')}
      ${sel('aanpak', ['Daytrading', 'Swingtrading'], 'Day + swing')}
      ${sel('klant', [['ja', 'Klant: ja'], ['nee', 'Klant: nee']], 'Klant: alle')}
      ${sel('assessor', st.assessoren.map((a) => [a.id, a.naam]), 'Alle assessoren')}
      <select class="filter-sel" onchange="__scF('periode', this.value)">${PERIODES.map(([v, l]) => `<option value="${v}"${st.f.periode === v ? ' selected' : ''}>${l}</option>`).join('')}</select>
      ${st.f.periode === 'eigen' ? `<input type="date" class="filter-sel" value="${esc(st.f.van)}" onchange="__scF('van', this.value)" aria-label="Vanaf">
        <input type="date" class="filter-sel" value="${esc(st.f.tot)}" onchange="__scF('tot', this.value)" aria-label="Tot en met">` : ''}
      <select class="filter-sel" onchange="__scSort(this.value)" aria-label="Sorteren">${[['datum_af', 'Nieuwste eerst'], ['datum_op', 'Oudste eerst'], ['score_af', 'Score hoog → laag'], ['score_op', 'Score laag → hoog'], ['naam', 'Naam A–Z'], ['status', 'Status']]
        .map(([v, l]) => `<option value="${v}"${st.sort === v ? ' selected' : ''}>${l}</option>`).join('')}</select>
      <button class="btn btn-ghost btn-sm" onclick="__scWis()">Wis filters</button>
    </div>`;

    const kop = `<div style="display:flex;align-items:center;justify-content:space-between;gap:10px;margin-bottom:12px;flex-wrap:wrap">
      <div><div style="font-size:18px;font-weight:700">Strategie-scans</div><div style="color:var(--text-3);font-size:12.5px">Alle scans en rapporten, met of de deelnemer klant is geworden.</div></div>
      <div style="display:flex;gap:8px"><button class="btn btn-ghost btn-sm" onclick="__scVernieuw()">${st.loading ? 'Laden…' : 'Vernieuwen'}</button>
      <button class="btn btn-primary btn-sm" onclick="__scNieuw()">+ Nieuwe scan</button></div></div>`;

    const migratie = st.migratieNodig
      ? '<div class="card" style="margin-bottom:12px"><div class="card-body" style="font-size:12.5px">Klant-status handmatig zetten kan pas na de migratie <span class="mono">docs/sql-migrations/2026-10-15-scan-fase3.sql</span>. De automatische klant-status (uit de deals) werkt al wel.</div></div>' : '';

    const tabel = lijst.length
      ? `<div class="card"><div class="tbl-wrap"><table style="width:100%;border-collapse:collapse;font-size:12.5px">
        <thead><tr><th>Deelnemer</th><th>Datum</th><th>Assessor</th><th>Status</th><th class="r">Score</th><th>Categorie</th><th>Aanpak</th><th>Traject</th><th>Klant</th><th class="r">Acties</th></tr></thead>
        <tbody>${lijst.map(rij).join('')}</tbody></table></div></div>`
      : `<div class="card"><div class="card-body" style="color:var(--text-3);font-size:12.5px">${st.scans.length ? 'Geen scans die aan de filters voldoen.' : 'Nog geen scans. Start er een via "+ Nieuwe scan" of vanaf een webinar-call in het call-rapport.'}</div></div>`;

    return `<div class="pad">${kop}${nieuwHtml()}${migratie}${kpiHtml(lijst)}${filters}${tabel}</div>`;
  }

  window.DFO.VIEWS = window.DFO.VIEWS || {};
  window.DFO.VIEWS['scans/Overzicht'] = scansView;
  if (typeof window.KV_V2_ADD === 'function') window.KV_V2_ADD('scans');
  else (window.KV_V2_PENDING = window.KV_V2_PENDING || []).push('scans');
})();
