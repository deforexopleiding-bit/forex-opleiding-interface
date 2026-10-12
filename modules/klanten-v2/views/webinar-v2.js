// modules/klanten-v2/views/webinar-v2.js
//
// Module Webinar (fase 1, 2026-10-09). Gratis webinar elke maandag 19:00.
// Eigen sidebar-item onder Events (was eerst de tab Events → Webinar);
// view en logica ongewijzigd, alleen de plek.
//   - Instellingen van de reeks: titel, Zoom-link (vaste terugkerende link),
//     starttijd, duur, actief.
//   - De weken: 4 terug + komende; per week het aantal aanmeldingen,
//     Overslaan (Karl afwezig → aanmelders schuiven door naar de volgende
//     actieve week en krijgen een nieuwe bevestiging) / Herstellen, en een
//     afwijkende Zoom-link voor die week.
//   - Aanmelders van een week, met per moment of mail/WhatsApp verstuurd is.
//   - Fase 3 (2026-10-12): kaart "Resultaten" — per funnel (v1/v2) en totaal:
//     aanmeldingen → calls → sales → commissie Karl (dry-run), plus calls via
//     de QR zonder aanmelding (GET /api/webinar-admin?dashboard=1).
//   - Fase 3 (2026-10-12): kolommen Nudge 1 / Nudge 2 per aanmelder (na-webinar
//     opvolging aan wie geen call boekte; api/_lib/webinar-opvolging.js).
//   - Fase 2 (2026-10-12): QR-code van de boekingslink /agenda/webinar (gratis
//     strategie-scan met Dave), groot te tonen en te downloaden als PNG. De
//     link staat in Leadsonderhoud → Bronnen op setter Karl → zijn 3%.
// Data: GET/POST /api/webinar-admin (events.event.view / events.event.edit).
(function () {
  'use strict';
  window.DFO = window.DFO || {};

  const esc = (s) => String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  const ZONE = 'Europe/Amsterdam';
  const fmtDag = (iso) => new Intl.DateTimeFormat('nl-NL', { timeZone: ZONE, weekday: 'short', day: 'numeric', month: 'short' }).format(new Date(iso));
  const fmtTijd = (iso) => new Intl.DateTimeFormat('nl-NL', { timeZone: ZONE, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date(iso));
  const fmtMoment = (iso) => (iso ? fmtDag(iso) + ' ' + fmtTijd(iso) : '—');

  const st = window.__wbState = window.__wbState || {
    loading: false, fetched: false, error: null, reeks: null, sessies: [], migratieNodig: false,
    open: null, aanm: { loading: false, error: null, rows: [] }, bezig: false, _seq: 0,
    qr: { loading: false, fout: null, data: null }, qrGroot: false,
    dash: { loading: false, fout: null, data: null },
  };

  function rerender() { if (window.DFO && typeof window.DFO.render === 'function') window.DFO.render(); }
  function toast(m) { if (window.KV && typeof window.KV.toast === 'function') window.KV.toast(m); }

  async function laad(force) {
    if (st.loading || (st.fetched && !force)) return;
    st.loading = true; st.error = null;
    const seq = ++st._seq;
    rerender();
    try {
      const j = await window.KV.authedJson('/api/webinar-admin');
      if (seq !== st._seq) return;
      st.reeks = j.reeks || null;
      st.sessies = Array.isArray(j.sessies) ? j.sessies : [];
      st.migratieNodig = !!j.migratie_nodig;
    } catch (e) {
      if (seq !== st._seq) return;
      st.error = e && e.status === 403 ? 'Geen rechten om het webinar te bekijken (events.event.view).'
        : 'Kon het webinar niet laden' + (e && e.status ? ' (HTTP ' + e.status + ')' : '');
      console.error('[webinar-v2] laden mislukt:', e && e.status, e && (e.body || e.message));
    }
    st.loading = false; st.fetched = true;
    rerender();
  }

  async function laadDashboard(force) {
    if (st.dash.loading || (st.dash.data && !force)) return;
    st.dash = { loading: true, fout: null, data: st.dash.data };
    rerender();
    try {
      const j = await window.KV.authedJson('/api/webinar-admin?dashboard=1');
      st.dash = { loading: false, fout: null, data: j };
    } catch (e) {
      console.error('[webinar-v2] dashboard laden mislukt:', e && e.status, e && (e.body || e.message));
      st.dash = { loading: false, fout: 'Kon de resultaten niet laden', data: null };
    }
    rerender();
  }
  window.__wbDashVernieuw = function () { laadDashboard(true); };

  async function laadQr() {
    if (st.qr.loading || st.qr.data) return;
    st.qr = { loading: true, fout: null, data: null };
    try {
      const j = await window.KV.authedJson('/api/webinar-admin?qr=1');
      st.qr = { loading: false, fout: null, data: j && j.png ? j : null };
      if (!st.qr.data) st.qr.fout = 'Geen QR ontvangen';
    } catch (e) {
      console.error('[webinar-v2] QR laden mislukt:', e && e.status, e && (e.body || e.message));
      st.qr = { loading: false, fout: 'Kon de QR-code niet maken', data: null };
    }
    rerender();
  }

  async function laadAanmelders(sessieId) {
    st.aanm = { loading: true, error: null, rows: [] };
    rerender();
    try {
      const j = await window.KV.authedJson('/api/webinar-admin?sessie_id=' + encodeURIComponent(sessieId));
      if (st.open !== sessieId) return;
      st.aanm = { loading: false, error: null, rows: Array.isArray(j.aanmeldingen) ? j.aanmeldingen : [] };
    } catch (e) {
      console.error('[webinar-v2] aanmelders laden mislukt:', e && e.status, e && (e.body || e.message));
      st.aanm = { loading: false, error: 'Kon de aanmelders niet laden', rows: [] };
    }
    rerender();
  }

  async function post(body, okTekst) {
    if (st.bezig) return null;
    st.bezig = true; rerender();
    try {
      const j = await window.KV.authedJson('/api/webinar-admin', { method: 'POST', body: JSON.stringify(body) });
      if (okTekst) toast(typeof okTekst === 'function' ? okTekst(j) : okTekst);
      return j;
    } catch (e) {
      console.error('[webinar-v2] actie mislukt:', body.actie, e && e.status, e && (e.body || e.message));
      toast((e && e.message) || 'Actie mislukt');
      return null;
    } finally {
      st.bezig = false;
      await laad(true);
      if (st.open) laadAanmelders(st.open);
    }
  }

  // ── Acties (globale handlers voor de inline onclick's) ──────────────────
  window.__wbOpslaan = async function () {
    const v = (id) => document.getElementById(id);
    const body = {
      actie: 'reeks_opslaan',
      titel: v('wb-titel').value,
      zoom_url: v('wb-zoom').value,
      starttijd: v('wb-tijd').value,
      duur_min: Number(v('wb-duur').value),
      actief: v('wb-actief').checked,
    };
    await post(body, (j) => 'Opgeslagen' + (j && j.sessies_bijgewerkt ? ` · ${j.sessies_bijgewerkt} komende weken aangepast` : ''));
  };
  window.__wbOverslaan = async function (id, datum, aantal) {
    const tekst = `Webinar van ${datum} overslaan?` + (aantal
      ? `\n\n${aantal} aanmelder(s) worden doorgeschoven naar de volgende actieve maandag en krijgen binnen een paar minuten een nieuwe bevestiging.`
      : '');
    if (!window.confirm(tekst)) return;
    const notitie = window.prompt('Reden (optioneel, bv. "Karl afwezig"):', '') || '';
    await post({ actie: 'overslaan', sessie_id: id, notitie }, (j) => {
      if (!j) return 'Overgeslagen';
      if (j.waarschuwing) return j.waarschuwing;
      return 'Overgeslagen' + (j.verplaatst ? ` · ${j.verplaatst} aanmelder(s) doorgeschoven naar ${fmtDag(j.doel.starts_at)}` : '')
        + (j.vervallen ? ` · ${j.vervallen} stonden er al` : '');
    });
  };
  window.__wbHerstellen = async function (id) {
    if (!window.confirm('Deze week weer laten doorgaan? Eerder doorgeschoven aanmelders blijven op hun nieuwe week.')) return;
    await post({ actie: 'herstellen', sessie_id: id }, 'Week staat weer gepland');
  };
  window.__wbZoomWeek = async function (id, huidig) {
    const nieuw = window.prompt('Afwijkende Zoom-link voor deze week (leeg = standaardlink):', huidig || '');
    if (nieuw === null) return;
    await post({ actie: 'sessie_zoom', sessie_id: id, zoom_url: nieuw }, nieuw.trim() ? 'Zoom-link voor deze week opgeslagen' : 'Standaard Zoom-link hersteld');
  };
  window.__wbQrGroot = function (aan) { st.qrGroot = !!aan; rerender(); };
  window.__wbOpen = function (id) {
    st.open = st.open === id ? null : id;
    if (st.open) laadAanmelders(st.open); else rerender();
  };

  // ── Render ──────────────────────────────────────────────────────────────
  function instellingenHtml(r) {
    const geenZoom = !r.zoom_url;
    return `<div class="card" style="margin-bottom:14px">
      <div class="card-head"><div class="card-title">Webinar-instellingen</div>
        <span class="pill ${r.actief ? 'pill-ok' : 'pill-neutral'} nodot">${r.actief ? 'Actief' : 'Uit'}</span></div>
      <div class="card-body">
        ${geenZoom ? `<div style="padding:10px 12px;margin-bottom:12px;border-radius:var(--r-sm);background:var(--amber-soft);color:var(--amber);border:1px solid var(--amber-line);font-size:12.5px">
          ⚠ Nog geen Zoom-link. Bevestiging en reminders zeggen dan "link volgt vóór de start". Vul hier de vaste terugkerende link in.</div>` : ''}
        <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:10px;align-items:end">
          <label style="font-size:12px;color:var(--text-3)">Titel<input id="wb-titel" class="ib-input" value="${esc(r.titel)}" maxlength="120" style="width:100%"></label>
          <label style="font-size:12px;color:var(--text-3);grid-column:span 2">Zoom-link (vast, elke week)<input id="wb-zoom" class="ib-input" value="${esc(r.zoom_url || '')}" placeholder="https://us02web.zoom.us/j/…" style="width:100%"></label>
          <label style="font-size:12px;color:var(--text-3)">Starttijd (NL)<input id="wb-tijd" class="ib-input" type="time" value="${esc(String(r.starttijd || '19:00').slice(0, 5))}"></label>
          <label style="font-size:12px;color:var(--text-3)">Duur (min)<input id="wb-duur" class="ib-input" type="number" min="15" max="300" step="5" value="${esc(r.duur_min)}"></label>
          <label style="font-size:12.5px;display:flex;gap:6px;align-items:center"><input id="wb-actief" type="checkbox" ${r.actief ? 'checked' : ''}> Actief (aanmelden mogelijk)</label>
        </div>
        <div style="margin-top:12px;display:flex;gap:8px;align-items:center">
          <button class="btn btn-primary btn-sm" ${st.bezig ? 'disabled' : ''} onclick="__wbOpslaan()">Opslaan</button>
          <span style="font-size:11.5px;color:var(--text-3)">Elke maandag. Aanmeldpagina's: /webinar-v1 en /webinar-v2 op de website.</span>
        </div>
      </div></div>`;
  }

  const euro = (n) => '€\u00a0' + Number(n || 0).toLocaleString('nl-NL', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const pct = (a, b) => (b ? Math.round((a / b) * 100) + '%' : '—');
  function dashboardHtml() {
    if (!st.dash.data && !st.dash.loading && !st.dash.fout) queueMicrotask(() => laadDashboard(false));
    const d = st.dash.data;
    const kop = `<div class="card-head"><div class="card-title">Resultaten per funnel</div>
      <button class="btn btn-ghost btn-sm" ${st.dash.loading ? 'disabled' : ''} onclick="__wbDashVernieuw()">Vernieuwen</button></div>`;
    if (!d) {
      return `<div class="card" style="margin-bottom:14px">${kop}<div class="card-body" style="font-size:12.5px;color:${st.dash.fout ? 'var(--rose)' : 'var(--text-3)'}">${esc(st.dash.fout || 'Resultaten laden…')}</div></div>`;
    }
    const naam = { 'webinar-v1': 'Funnel A (webinar-v1)', 'webinar-v2': 'Funnel B (webinar-v2)', overig: 'Overig' };
    const rij = (label, r, sterk) => `<tr${sterk ? ' style="font-weight:700;border-top:2px solid var(--border)"' : ''}>
      <td>${esc(label)}</td>
      <td class="r">${r.aanmeldingen}${r.personen !== r.aanmeldingen ? ` <span style="color:var(--text-3);font-weight:400" title="Unieke personen (e-mail)">(${r.personen} pers.)</span>` : ''}</td>
      <td class="r">${r.calls} <span style="color:var(--text-3);font-weight:400">${pct(r.calls, r.personen)}</span></td>
      <td class="r">${r.sales} <span style="color:var(--text-3);font-weight:400">${pct(r.sales, r.calls)}</span></td>
      <td class="r" title="Geboekt ${euro(r.commissie_geboekt)} · zou nu boeken ${euro(r.commissie_te_boeken)}">${euro(r.commissie)}</td></tr>`;
    const z = d.zonder_aanmelding;
    const setter = d.setter && d.setter.naam ? esc(d.setter.naam) : 'de setter van de webinar-link';
    return `<div class="card" style="margin-bottom:14px">${kop}
      <div class="tbl-wrap"><table style="width:100%;border-collapse:collapse;font-size:12.5px">
        <thead><tr><th>Funnel</th><th class="r">Aanmeldingen</th><th class="r" title="Personen met een call via /agenda/webinar (na de aanmelding, niet geannuleerd) · % van de personen">Calls</th><th class="r" title="Deals met ${setter} als setter · % van de calls">Sales</th><th class="r">Commissie ${setter}</th></tr></thead>
        <tbody>${d.funnels.map((r) => rij(naam[r.funnel] || r.funnel, r)).join('')}${rij('Totaal', d.totaal, true)}
          <tr style="color:var(--text-3)"><td>Calls via de QR zonder aanmelding</td><td class="r">—</td><td class="r">${z.calls}</td><td class="r">${z.sales}</td><td class="r">${euro(z.commissie)}</td></tr>
        </tbody></table></div>
      <div style="font-size:11px;color:var(--text-3);padding:6px 12px 10px">${d.dry_run ? '⚠ Commissie in <b>dry-run</b>: dit is wat de commissie-cron zou boeken; er is nog niets geboekt. ' : ''}Calls = boeking via /agenda/webinar ná de aanmelding (niet geannuleerd). Sales = deals met ${setter} als setter. Geen opkomst/show-rate.</div>
    </div>`;
  }

  function qrHtml() {
    if (!st.qr.data && !st.qr.loading && !st.qr.fout) queueMicrotask(laadQr);
    const q = st.qr.data;
    const beeld = q
      ? `<img src="${esc(q.png)}" alt="QR-code naar ${esc(q.url)}" width="220" height="220" style="display:block;width:220px;height:220px;border-radius:8px;border:1px solid var(--border);background:#fff">`
      : `<div style="width:220px;height:220px;display:grid;place-items:center;border:1px dashed var(--border);border-radius:8px;color:var(--text-3);font-size:12px">${st.qr.fout ? esc(st.qr.fout) : 'QR maken…'}</div>`;
    const groot = q && st.qrGroot ? `
      <div onclick="if(event.target===this)__wbQrGroot(false)" style="position:fixed;inset:0;z-index:9000;background:rgba(10,20,35,.82);display:flex;flex-direction:column;align-items:center;justify-content:center;gap:16px;padding:20px">
        <img src="${esc(q.png)}" alt="QR-code naar ${esc(q.url)}" style="width:min(80vh,90vw);height:auto;background:#fff;border-radius:12px">
        <div style="color:#fff;font-size:18px;font-weight:600">Plan je gratis strategie-scan (t.w.v. €99) · deforexopleiding.nl/agenda/webinar</div>
        <button class="btn btn-ghost btn-sm" style="background:#fff" onclick="__wbQrGroot(false)">Sluiten</button>
      </div>` : '';
    return `<div class="card" style="margin-bottom:14px">
      <div class="card-head"><div class="card-title">QR-code: gratis strategie-scan</div></div>
      <div class="card-body" style="display:flex;gap:18px;flex-wrap:wrap;align-items:center">
        ${beeld}
        <div style="flex:1;min-width:220px;font-size:12.5px;line-height:1.55">
          <div>Laat deze QR tijdens het webinar zien. Deelnemers plannen er een gratis strategie-scan (t.w.v. €99) mee bij Dave.</div>
          <div style="margin:6px 0"><a href="${esc(q ? q.url : 'https://deforexopleiding.nl/agenda/webinar')}" target="_blank" rel="noopener" class="mono">${esc(q ? q.url : 'https://deforexopleiding.nl/agenda/webinar')}</a></div>
          <div style="color:var(--text-3);font-size:11.5px">Boekingen via deze link krijgen bron "webinar" en de setter van die link (Leadsonderhoud → Bronnen) — die ontvangt de commissie.</div>
          <div style="display:flex;gap:8px;margin-top:10px;flex-wrap:wrap">
            <button class="btn btn-primary btn-sm" ${q ? '' : 'disabled'} onclick="__wbQrGroot(true)">Groot tonen</button>
            ${q ? `<a class="btn btn-ghost btn-sm" href="${esc(q.png)}" download="webinar-strategie-scan-qr.png">Download PNG</a>` : ''}
          </div>
        </div>
      </div>${groot}</div>`;
  }

  function vinkje(a, key) {
    const b = (a.berichten || {})[key];
    const kolom = { bevestiging: 'bevestiging_op', dag: 'reminder_dag_op', uur: 'reminder_uur_op', live: 'live_op', opvolging_1: 'opvolging_1_op', opvolging_2: 'opvolging_2_op' }[key];
    if (!a[kolom]) return '<span style="color:var(--text-3)">—</span>';
    if (!b) return '<span title="bezig">…</span>';
    if (b.overgeslagen) {
      const uitleg = { geboekt: 'heeft al een webinar-call geboekt', aankomende_afspraak: 'heeft al een aankomende afspraak' }[b.overgeslagen] || b.overgeslagen;
      return `<span title="Overgeslagen: ${esc(uitleg)}" style="font-size:11px;color:var(--text-3)">overgeslagen</span>`;
    }
    const m = b.mail && b.mail.ok ? '✉✓' : '✉✗';
    const w = b.wa && b.wa.ok ? 'WA✓' : (b.wa && b.wa.overgeslagen ? 'WA–' : 'WA✗');
    const titel = `mail: ${b.mail && b.mail.ok ? 'verstuurd' : (b.mail && b.mail.fout) || '?'} · WhatsApp: ${b.wa && b.wa.ok ? 'verstuurd' : (b.wa && (b.wa.overgeslagen || b.wa.fout)) || '?'}`;
    return `<span title="${esc(titel)}" style="font-size:11px;white-space:nowrap">${m} ${w}</span>`;
  }

  function aanmeldersHtml() {
    if (st.aanm.loading) return '<div style="padding:12px;color:var(--text-3);font-size:12px">Aanmelders laden…</div>';
    if (st.aanm.error) return `<div style="padding:12px;color:var(--rose);font-size:12px">${esc(st.aanm.error)}</div>`;
    if (!st.aanm.rows.length) return '<div style="padding:12px;color:var(--text-3);font-size:12px">Nog geen aanmelders voor deze week.</div>';
    return `<div class="tbl-wrap"><table style="width:100%;border-collapse:collapse;font-size:12.5px">
      <thead><tr><th>Naam</th><th>E-mail</th><th>Telefoon</th><th>Bron</th><th>Aangemeld</th><th>Bevestiging</th><th>Dag ervoor</th><th>Uur ervoor</th><th>Live</th><th title="Na-webinar opvolging, de webinar-avond (alleen wie geen call boekte)">Nudge 1</th><th title="Na-webinar opvolging, de dag erna">Nudge 2</th></tr></thead>
      <tbody>${st.aanm.rows.map((a) => `<tr${a.is_test ? ' style="opacity:.55"' : ''}>
        <td>${esc(a.voornaam || '—')}${a.verplaatst_van_sessie_id ? ' <span class="pill pill-neutral nodot" title="Doorgeschoven van een overgeslagen week">verplaatst</span>' : ''}${a.is_test ? ' <span class="pill pill-neutral nodot">test</span>' : ''}</td>
        <td class="mono">${esc(a.email)}</td><td class="mono">${esc(a.telefoon || '—')}</td><td>${esc(a.bron || '—')}</td>
        <td>${esc(fmtMoment(a.aangemeld_op))}</td>
        <td>${vinkje(a, 'bevestiging')}</td><td>${vinkje(a, 'dag')}</td><td>${vinkje(a, 'uur')}</td><td>${vinkje(a, 'live')}</td><td>${vinkje(a, 'opvolging_1')}</td><td>${vinkje(a, 'opvolging_2')}</td>
      </tr>`).join('')}</tbody></table></div>
      <div style="font-size:11px;color:var(--text-3);padding:6px 2px">✉ = mail · WA = WhatsApp · ✓ verstuurd · ✗ mislukt · – overgeslagen (bv. template nog niet goedgekeurd of geen telefoon). Nudge 1/2 = opvolging na het webinar voor wie geen call boekte ("overgeslagen" = al geboekt of al een afspraak). Hover voor details.</div>`;
  }

  function sessiesHtml(r) {
    const nu = Date.now();
    if (!st.sessies.length) return '<div class="card"><div class="card-body" style="color:var(--text-3);font-size:12.5px">Nog geen weken gepland. Zet het webinar op actief; de planning vult zich automatisch aan.</div></div>';
    return `<div class="card"><div class="card-head"><div class="card-title">Weken</div>
      <button class="btn btn-ghost btn-sm" onclick="window.__wbState.fetched=false;window.DFO.render()">Vernieuwen</button></div>
      <div class="tbl-wrap"><table style="width:100%;border-collapse:collapse;font-size:12.5px">
      <thead><tr><th>Datum</th><th>Tijd</th><th>Status</th><th class="r">Aanmeldingen</th><th>Zoom</th><th class="r">Acties</th></tr></thead>
      <tbody>${st.sessies.map((s) => {
        const voorbij = new Date(s.starts_at).getTime() <= nu;
        const over = s.status === 'overgeslagen';
        const pill = voorbij ? '<span class="pill pill-neutral nodot">Geweest</span>'
          : over ? `<span class="pill pill-warn nodot" title="${esc(s.notitie || '')}">Overgeslagen</span>`
          : '<span class="pill pill-ok nodot">Gepland</span>';
        const zoom = s.zoom_url ? '<span title="Afwijkende link voor deze week">eigen link</span>' : (r.zoom_url ? 'standaard' : '<span style="color:var(--amber)">ontbreekt</span>');
        const dag = fmtDag(s.starts_at);
        const acties = [
          `<button class="btn btn-ghost btn-sm" onclick="__wbOpen('${esc(s.id)}')">${st.open === s.id ? 'Sluiten' : 'Aanmelders'}</button>`,
          !voorbij && !over ? `<button class="btn btn-ghost btn-sm" ${st.bezig ? 'disabled' : ''} onclick="__wbZoomWeek('${esc(s.id)}', '${esc(s.zoom_url || '')}')">Zoom-link</button>` : '',
          !voorbij && !over ? `<button class="btn btn-ghost btn-sm" ${st.bezig ? 'disabled' : ''} onclick="__wbOverslaan('${esc(s.id)}', '${esc(dag)}', ${Number(s.aantal) || 0})">Overslaan</button>` : '',
          !voorbij && over ? `<button class="btn btn-ghost btn-sm" ${st.bezig ? 'disabled' : ''} onclick="__wbHerstellen('${esc(s.id)}')">Herstellen</button>` : '',
        ].join(' ');
        return `<tr${voorbij ? ' style="opacity:.6"' : ''}><td>${esc(dag)}</td><td>${esc(fmtTijd(s.starts_at))}</td><td>${pill}</td>
          <td class="r"><b>${Number(s.aantal) || 0}</b></td><td>${zoom}</td><td class="r" style="white-space:nowrap">${acties}</td></tr>
          ${st.open === s.id ? `<tr><td colspan="6" style="background:var(--surface-2,transparent);padding:8px">${aanmeldersHtml()}</td></tr>` : ''}`;
      }).join('')}</tbody></table></div></div>`;
  }

  function webinarView() {
    if (!st.fetched && !st.loading) queueMicrotask(() => laad(false));
    if (st.error) return `<div class="pad"><div class="card"><div class="card-body" style="color:var(--rose)">${esc(st.error)}</div></div></div>`;
    if (!st.fetched) return '<div class="pad" style="color:var(--text-3);font-size:12.5px">Webinar laden…</div>';
    if (st.migratieNodig || !st.reeks) {
      return '<div class="pad"><div class="card"><div class="card-body" style="font-size:12.5px">De webinar-tabellen ontbreken nog. Draai eerst de migratie <span class="mono">docs/sql-migrations/2026-10-09-webinar-fase1.sql</span>.</div></div></div>';
    }
    return `<div class="pad">${instellingenHtml(st.reeks)}${dashboardHtml()}${qrHtml()}${sessiesHtml(st.reeks)}</div>`;
  }

  window.DFO.VIEWS = window.DFO.VIEWS || {};
  // Module zonder tabs → de shell zoekt VIEWS['webinar/'].
  window.DFO.VIEWS['webinar/'] = webinarView;
  if (typeof window.KV_V2_ADD === 'function') window.KV_V2_ADD('webinar');
  else (window.KV_V2_PENDING = window.KV_V2_PENDING || []).push('webinar');
})();
