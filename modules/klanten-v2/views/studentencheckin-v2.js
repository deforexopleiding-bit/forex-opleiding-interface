// modules/klanten-v2/views/studentencheckin-v2.js
//
// SECTIE "STUDENTENCHECK-IN" (27 okt 2026, Maxim) — "Jouw DFO-check-in" voor
// BESTAANDE studenten: een LMS-pop-up + balk met een persoonlijke code →
// www.deforexopleiding.nl/checkin. Hier: de campagne, de knop Run, en wat de
// studenten antwoordden.
//
//   1. CAMPAGNEKAART: status, inhoudsversie, opties, en de knoppen Voorbeeld als
//      teststudent · Testtoewijzingen aanmaken · Run — activeer in het LMS ·
//      Pauzeren / Hervatten. Run blijft grijs zolang er in deze campagne geen
//      geslaagde testinzending is, en vraagt "ACTIVEER" te typen.
//   2. KPI-STRIP (elke tegel filtert de tabel). Testtoewijzingen tellen niet mee.
//   3. TABEL met filters, detailvenster en CSV-export.
//   4. Tab "Payouts": wie payout ja + delen ja koos (resultatenmuur).
//   5. Tab "Per mentor": gemiddelde NPS en mentorscore (mentor-audit).
//
// Data + acties: /api/checkin-beheer (recht checkin.view; Run en de andere
// knoppen checkin.run). Er gaat vanuit deze sectie NIETS naar studenten.

(function () {
  'use strict';
  if (!window.DFO) return;
  window.DFO.VIEWS = window.DFO.VIEWS || {};

  const esc = (s) => String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  const ZONE = 'Europe/Brussels';
  const API = '/api/checkin-beheer';
  const moment = (iso) => {
    if (!iso) return '—';
    try { return new Date(iso).toLocaleString('nl-BE', { timeZone: ZONE, day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }); } catch (_) { return '—'; }
  };
  const getal = (n) => (n == null ? '—' : String(n).replace('.', ','));

  const STATUS = { niet_gestart: ['Niet gestart', 'neutral'], bezig: ['Bezig', 'warn'], verstuurd: ['Verstuurd', 'ok'] };
  const CAMPAGNE_STATUS = {
    concept: ['Concept', 'neutral', 'Niemand ziet iets.'],
    test: ['Test', 'warn', 'Alleen de testaccounts zien de check-in.'],
    live: ['Live', 'ok', 'Studenten in de doelgroep krijgen het verplichte check-in-scherm tot ze verstuurd hebben.'],
    gepauzeerd: ['Gepauzeerd', 'warn', 'Pop-up en balk zijn weg; de antwoorden blijven.'],
    gesloten: ['Gesloten', 'neutral', 'Afgesloten.'],
  };
  const PRODUCT = { mentorship: '1-op-1 Mentorship', membership: 'Membership' };
  const ZWAARTE = { geel: 'warn', oranje: 'warn', rood: 'danger' };
  const NPS_BAND = { promotor: ['Promotor (9-10)', 'ok'], passief: ['Passief (7-8)', 'neutral'], criticaster: ['Criticaster (0-6)', 'danger'] };
  const OPTIES = [
    ['payout_vraag', 'Payout-vraag', 'Vraag of de student al een payout kreeg (+ mag het gedeeld worden).'],
    ['trustpilot_vraag', 'Trustpilot-kaart', 'Toont bij NPS 9-10 een Trustpilot-kaart op het bedankscherm. Standaard uit.'],
    ['autopilot_stap', 'Autopilot-stap', 'De automation-vraag van de onboarding (bij "Ja, bel mij" een kaart voor Dave).'],
  ];

  const st = window.__ckState = window.__ckState || {
    laden: false, data: null, fout: null, seq: 0, toonTest: false, bezig: null,
    f: { mentor: '', status: '', nps: '', contact: '', automation: '', fase: '', kpi: '' },
    detail: null,
    run: null, // { laden, samenvatting, lms_tekst, fout, getypt, bezig }
  };

  const rerender = () => { if (typeof window.DFO.render === 'function') window.DFO.render(); };
  const toast = (m) => { if (window.KV && typeof window.KV.toast === 'function') window.KV.toast(m); else alert(m); };
  const foutTekst = (e, standaard) => (e && e.body && e.body.error) || (e && e.message) || standaard;

  async function laad() {
    if (st.laden) return;
    st.laden = true; st.fout = null;
    const seq = ++st.seq;
    rerender();
    try {
      const j = await window.KV.authedJson(API);
      if (seq !== st.seq) return;
      st.data = j;
    } catch (e) {
      if (seq !== st.seq) return;
      st.fout = e && e.status === 403 ? 'Geen toegang tot de studentencheck-in (recht checkin.view).' : foutTekst(e, 'Het overzicht kon niet geladen worden.');
    } finally {
      if (seq === st.seq) { st.laden = false; rerender(); }
    }
  }

  async function actie(body, bezigLabel) {
    st.bezig = bezigLabel; rerender();
    try {
      const j = await window.KV.authedJson(API, { method: 'POST', body: JSON.stringify({ campagne_id: st.data.campagne.id, ...body }) });
      st.bezig = null;
      return j;
    } catch (e) {
      st.bezig = null; rerender();
      throw e;
    }
  }

  // ── Filters ───────────────────────────────────────────────────────────────
  function rijen() {
    const d = st.data || {};
    const f = st.f;
    return (d.rijen || []).filter((r) => {
      if (!st.toonTest && r.is_test) return false;
      if (f.mentor && (r.mentor_id || '—') !== f.mentor) return false;
      if (f.status && r.status !== f.status) return false;
      if (f.nps === 'geen' ? r.nps != null : (f.nps && r.nps_band !== f.nps)) return false;
      if (f.contact && r.contact !== f.contact) return false;
      if (f.automation === 'ja' && r.automation !== 'ja_interesse') return false;
      if (f.automation === 'nee' && r.automation === 'ja_interesse') return false;
      if (f.fase && r.fase !== f.fase) return false;
      if (f.kpi === 'popup' && !r.popup_gezien_op) return false;
      if (f.kpi === 'gestart' && r.status === 'niet_gestart') return false;
      if (f.kpi === 'verstuurd' && r.status !== 'verstuurd') return false;
      if (f.kpi === 'nps' && r.nps == null) return false;
      if (f.kpi === 'signaal' && !r.signaal) return false;
      if (f.kpi === 'automation' && r.automation !== 'ja_interesse') return false;
      return true;
    });
  }

  // ── Opmaak ────────────────────────────────────────────────────────────────
  const pill = (c, t, titel) => `<span class="pill pill-${c} nodot"${titel ? ` title="${esc(titel)}"` : ''}>${esc(t)}</span>`;
  const knop = (label, onclick, o = {}) => `<button type="button" class="btn ${o.p ? 'btn-primary' : 'btn-ghost'} btn-sm"${o.uit ? ' disabled' : ''}${o.titel ? ` title="${esc(o.titel)}"` : ''} onclick="${onclick}">${label}</button>`;

  function stijl() {
    if (document.getElementById('ck-stijl')) return;
    const el = document.createElement('style');
    el.id = 'ck-stijl';
    el.textContent = `
.ck .ck-kpi{display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:10px;margin:0 0 12px}
.ck .ck-tegel{border:1px solid var(--border);border-radius:10px;padding:10px 12px;background:var(--surface);text-align:left;cursor:pointer;font:inherit;color:inherit}
.ck .ck-tegel:hover{border-color:var(--text-3)}
.ck .ck-tegel.aan{border-color:var(--accent,#6D3FD4);box-shadow:0 0 0 1px var(--accent,#6D3FD4) inset}
.ck .ck-tegel span{display:block;font-size:11px;letter-spacing:.06em;text-transform:uppercase;color:var(--text-3)}
.ck .ck-tegel b{display:block;font-size:21px;line-height:1.15;margin-top:2px}
.ck .ck-tegel i{display:block;font-style:normal;font-size:11.5px;color:var(--text-3)}
.ck .ck-camp{display:grid;grid-template-columns:1fr auto;gap:12px;align-items:start}
.ck .ck-knoppen{display:flex;flex-wrap:wrap;gap:6px;justify-content:flex-end}
.ck .ck-opties{display:flex;flex-wrap:wrap;gap:14px;margin-top:10px;font-size:12.5px}
.ck .ck-opties label{display:inline-flex;gap:6px;align-items:center}
.ck .ck-sub{color:var(--text-3);font-size:12.5px;line-height:1.5}
.ck table.ck-tbl{width:100%;border-collapse:collapse;font-size:12.5px}
.ck table.ck-tbl th,.ck table.ck-tbl td{padding:7px 8px;border-bottom:1px solid var(--border);text-align:left;vertical-align:top}
.ck table.ck-tbl td.r,.ck table.ck-tbl th.r{text-align:right;font-variant-numeric:tabular-nums}
.ck table.ck-tbl tbody tr{cursor:pointer}
.ck table.ck-tbl tbody tr:hover{background:var(--surface-2,#F6F7F9)}
.ck-modal{background:var(--surface);border-radius:12px;border:1px solid var(--border);max-width:640px;width:100%;max-height:90vh;overflow-y:auto;box-shadow:0 20px 60px rgba(0,0,0,.3)}
.ck-modal .kop{padding:14px 18px;border-bottom:1px solid var(--border);display:flex;align-items:flex-start;gap:10px}
.ck-modal .kop .t{flex:1;font-size:14.5px;font-weight:650}
.ck-modal .body{padding:16px 18px;font-size:12.5px;line-height:1.5}
.ck-modal dl{display:grid;grid-template-columns:minmax(150px,40%) 1fr;gap:6px 12px;margin:0}
.ck-modal dt{color:var(--text-3)}
.ck-modal dd{margin:0;font-weight:550}
.ck-modal .blok{border:1px solid var(--border);border-radius:10px;padding:10px 12px;margin:12px 0;background:var(--surface-2,#F6F7F9);white-space:pre-wrap}
.ck-modal .waarschuw{padding:10px 12px;background:var(--rose-soft,#fdecee);border:1px solid var(--rose-line,#f5c2c7);border-radius:8px;color:var(--rose,#b42318);margin:0 0 12px}
.ck-modal input.typ{width:100%;padding:9px 11px;font-size:14px;font-family:var(--mono,monospace);letter-spacing:.1em;border:1px solid var(--border);border-radius:8px;background:var(--surface);color:inherit}
@media (max-width:760px){.ck .ck-camp{grid-template-columns:1fr}.ck .ck-knoppen{justify-content:flex-start}}
`;
    document.head.appendChild(el);
  }

  function campagneKaart(d) {
    const c = d.campagne;
    const magRun = !!(d.rechten && d.rechten.run);
    const [sl, sc, uitleg] = CAMPAGNE_STATUS[c.status] || [c.status, 'neutral', ''];
    const test = d.test || [];
    const testOk = test.find((t) => t.verstuurd_op);
    const voorbeeld = test[0];
    const kanTest = magRun && (c.status === 'concept' || c.status === 'test');
    const run = d.run || {};
    let h = `<div class="card" style="margin-bottom:12px"><div class="card-body"><div class="ck-camp"><div>`;
    h += `<div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap"><div style="font-size:16px;font-weight:700">${esc(c.naam)}</div>${pill(sc, sl)}<span class="mono" style="color:var(--text-3);font-size:11.5px">${esc(c.slug)} · inhoudsversie ${esc(c.inhoud_versie)}</span></div>`;
    h += `<div class="ck-sub" style="margin-top:4px">${esc(uitleg)}`;
    if (c.live_op) h += ` Geactiveerd op ${esc(moment(c.live_op))}${c.live_door ? ' door ' + esc(c.live_door) : ''}.`;
    h += `</div>`;
    h += `<div class="ck-sub" style="margin-top:6px">Testinzending: ${testOk ? '<b style="color:var(--emerald)">verstuurd</b> op ' + esc(moment(testOk.verstuurd_op)) + ' (' + esc(testOk.email) + ')' : (test.length ? 'nog niet verstuurd (' + test.map((t) => esc(t.email)).join(', ') + ')' : 'nog geen testtoewijzing')}.</div>`;
    if (c.doelgroep_regel && c.doelgroep_regel.ontvangers != null) {
      h += `<div class="ck-sub" style="margin-top:6px">Doelgroep vastgelegd op ${esc(c.doelgroep_regel.peildatum || '')}: <b>${esc(c.doelgroep_regel.ontvangers)}</b> studenten (${esc(c.doelgroep_regel.regel || '')}).</div>`;
    }
    h += `<div class="ck-opties">` + OPTIES.map(([k, l, t]) => `<label title="${esc(t)}"><input type="checkbox" ${c.opties[k] ? 'checked' : ''} ${magRun && c.status !== 'gesloten' && !st.bezig ? '' : 'disabled'} onchange="window.__ckOptie('${k}', this.checked)"> ${esc(l)}</label>`).join('') + `</div>`;
    h += `</div><div class="ck-knoppen">`;
    h += voorbeeld
      ? `<a class="btn btn-ghost btn-sm" style="text-decoration:none" href="${esc(voorbeeld.link)}" target="_blank" rel="noopener" title="Opent /checkin met de testcode van ${esc(voorbeeld.email)}">Voorbeeld als teststudent ↗</a>`
      : knop('Voorbeeld als teststudent', '', { uit: true, titel: 'Maak eerst testtoewijzingen aan.' });
    h += knop(st.bezig === 'test' ? 'Bezig…' : 'Testtoewijzingen aanmaken', 'window.__ckTest()', { uit: !kanTest || !!st.bezig, titel: kanTest ? 'Zet de campagne op test en maakt een toewijzing voor de testaccounts (Maxims eigen studentlogin).' : 'Alleen in concept of test, met het recht checkin.run.' });
    if (c.status === 'live') h += knop(st.bezig === 'pauzeer' ? 'Bezig…' : 'Pauzeren', 'window.__ckPauzeer()', { uit: !magRun || !!st.bezig, titel: 'Pop-up en balk weg; de antwoorden blijven.' });
    if (c.status === 'gepauzeerd') h += knop(st.bezig === 'hervat' ? 'Bezig…' : 'Hervatten', 'window.__ckHervat()', { uit: !magRun || !!st.bezig });
    if (c.status !== 'live' && c.status !== 'gepauzeerd') {
      h += knop('Run — activeer in het LMS', 'window.__ckRunOpen()', { p: true, uit: !magRun || !run.mag || !!st.bezig, titel: !magRun ? 'Alleen met het recht checkin.run.' : (run.reden || 'Toont eerst de doelgroep en de exacte teksten.') });
    }
    h += `</div></div></div></div>`;
    return h;
  }

  function kpiStrip(k) {
    const tegel = (code, label, waarde, sub) => `<button type="button" class="ck-tegel${st.f.kpi === code ? ' aan' : ''}" onclick="window.__ckKpi('${code}')"><span>${esc(label)}</span><b>${esc(waarde)}</b>${sub ? `<i>${esc(sub)}</i>` : ''}</button>`;
    return `<div class="ck-kpi">
      ${tegel('', 'Toegewezen', k.toegewezen, 'studenten in de campagne')}
      ${tegel('popup', 'Pop-up gezien', k.popup_gezien, k.toegewezen ? Math.round(k.popup_gezien / k.toegewezen * 100) + '%' : '')}
      ${tegel('gestart', 'Gestart', k.gestart, '')}
      ${tegel('verstuurd', 'Verstuurd', k.verstuurd, k.verstuurd_pct == null ? '' : getal(k.verstuurd_pct) + '%')}
      ${tegel('nps', 'NPS-score', k.nps_score == null ? '—' : k.nps_score, k.nps_gemiddeld == null ? 'nog geen antwoorden' : 'gemiddeld ' + getal(k.nps_gemiddeld) + ' (' + k.nps_aantal + ')')}
      ${tegel('signaal', 'Begeleidingssignalen', k.begeleidingssignalen, 'naar de hoofdmentor')}
      ${tegel('automation', 'Automation-interesse', k.automation_interesse, 'kaart voor Dave')}
    </div>`;
  }

  function filters(d) {
    const sel = (k, opties, leeg) => `<select class="filter-sel" onchange="window.__ckF('${k}', this.value)"><option value="">${esc(leeg)}</option>${opties.map(([v, l]) => `<option value="${esc(v)}"${st.f[k] === v ? ' selected' : ''}>${esc(l)}</option>`).join('')}</select>`;
    const mentoren = (d.per_mentor || []).map((m) => [m.mentor_id || '—', m.mentor]);
    const fasen = Object.entries((d.labels && d.labels.fase) || {});
    return `<div class="toolbar" style="display:flex;flex-wrap:wrap;gap:8px;align-items:center;margin-bottom:10px">
      ${sel('mentor', mentoren, 'Alle mentoren')}
      ${sel('status', [['niet_gestart', 'Niet gestart'], ['bezig', 'Bezig'], ['verstuurd', 'Verstuurd']], 'Alle statussen')}
      ${sel('nps', [['promotor', 'NPS 9-10'], ['passief', 'NPS 7-8'], ['criticaster', 'NPS 0-6'], ['geen', 'Geen NPS']], 'Alle NPS')}
      ${sel('contact', [['ja', 'Contact: ja'], ['nee', 'Contact: nee']], 'Contact: alle')}
      ${sel('automation', [['ja', 'Automation: ja'], ['nee', 'Automation: nee']], 'Automation: alle')}
      ${sel('fase', fasen, 'Alle fasen')}
      <label style="font-size:12.5px;color:var(--text-3);display:inline-flex;gap:6px;align-items:center"><input type="checkbox" ${st.toonTest ? 'checked' : ''} onchange="window.__ckTestRijen(this.checked)"> testtoewijzingen</label>
      ${knop('Wis filters', 'window.__ckWis()')}
      ${knop('Export CSV', 'window.__ckCsv()')}
    </div>`;
  }

  function tabel(lijst) {
    if (!lijst.length) return `<div class="card"><div class="card-body ck-sub">${(st.data.rijen || []).length ? 'Geen studenten die aan de filters voldoen.' : 'Nog geen toewijzingen. Die ontstaan pas bij "Testtoewijzingen aanmaken" en bij Run.'}</div></div>`;
    const ster = (n) => (n == null ? '—' : '★'.repeat(n) + `<span style="color:var(--text-3)">${'★'.repeat(5 - n)}</span>`);
    return `<div class="card"><div class="tbl-wrap"><table class="ck-tbl"><thead><tr>
      <th>Naam</th><th>Product</th><th>Mentor</th><th>Status</th><th class="r">NPS</th><th>Mentor</th><th>Fase</th><th>Contact traject</th><th>Automation</th><th>Verstuurd op</th>
      </tr></thead><tbody>${lijst.map((r) => {
        const [sl, sc] = STATUS[r.status] || [r.status, 'neutral'];
        return `<tr onclick="window.__ckDetail('${esc(r.id)}')">
          <td><b>${esc(r.naam)}</b>${r.is_test ? ' ' + pill('warn', 'test') : ''}${r.signaal ? ' ' + pill(ZWAARTE[r.signaal.zwaarte] || 'warn', 'signaal', 'Begeleidingssignaal ' + (r.signaal.zwaarte || '')) : ''}</td>
          <td>${esc(PRODUCT[r.product] || r.product || '—')}</td>
          <td>${esc(r.mentor || '—')}</td>
          <td>${pill(sc, sl)}</td>
          <td class="r">${r.nps == null ? '—' : `<b style="color:${r.nps <= 6 ? 'var(--rose)' : r.nps <= 8 ? 'var(--amber)' : 'var(--emerald)'}">${r.nps}</b>`}</td>
          <td style="white-space:nowrap;color:var(--amber)">${r.product === 'mentorship' ? ster(r.mentor_score) : '<span style="color:var(--text-3)">n.v.t.</span>'}</td>
          <td>${esc(r.fase_label || '—')}</td>
          <td>${r.contact === 'ja' ? pill('warn', 'Ja') : r.contact === 'nee' ? 'Nee' : '—'}</td>
          <td>${r.automation === 'ja_interesse' ? pill('accent', 'Ja, bel mij') : r.automation === 'nee' ? 'Nee' : '—'}</td>
          <td style="white-space:nowrap">${esc(moment(r.verstuurd_op))}</td></tr>`;
      }).join('')}</tbody></table></div></div>`;
  }

  // ── Vensters ──────────────────────────────────────────────────────────────
  function venster(titel, sub, inhoud, sluit) {
    return `<div class="scrim on" style="z-index:1000;display:flex;align-items:center;justify-content:center;padding:20px" onclick="if(event.target===this)${sluit}">
      <div class="ck-modal" role="dialog" aria-modal="true" aria-label="${esc(titel)}">
        <div class="kop"><div class="t">${esc(titel)}${sub ? `<div style="font-size:11.5px;color:var(--text-3);font-weight:400;margin-top:2px">${sub}</div>` : ''}</div>
          <button type="button" class="btn btn-ghost btn-sm" onclick="${sluit}" aria-label="Sluiten">✕</button></div>
        <div class="body">${inhoud}</div></div></div>`;
  }

  function detailVenster() {
    if (!st.detail || !st.data) return '';
    const r = (st.data.rijen || []).find((x) => x.id === st.detail);
    if (!r) return '';
    const links = st.data.links || {};
    const sub = esc([PRODUCT[r.product] || r.product, r.mentor ? 'mentor ' + r.mentor : null, r.email].filter(Boolean).join(' · '));
    let h = `<dl>
      <dt>Status</dt><dd>${esc((STATUS[r.status] || [r.status])[0])}${r.inhoud_versie ? ' · inhoudsversie ' + esc(r.inhoud_versie) : ''}</dd>
      <dt>Pop-up gezien</dt><dd>${esc(moment(r.popup_gezien_op))}</dd>
      <dt>Gestart</dt><dd>${esc(moment(r.gestart_op))}</dd>
      <dt>Verstuurd</dt><dd>${esc(moment(r.verstuurd_op))}</dd>
      <dt>Code</dt><dd class="mono">${esc(r.code.slice(0, 4) + '-' + r.code.slice(4))}</dd>
    </dl>`;
    const antw = (r.antwoorden || []).filter((a) => a.sleutel !== 'verbeter');
    h += antw.length
      ? `<h4 style="margin:16px 0 6px;font-size:13px">Antwoorden</h4><dl>${antw.map((a) => `<dt>${esc(a.vraag)}</dt><dd>${esc(Array.isArray(a.antwoord) ? a.antwoord.join(', ') : a.antwoord)}</dd>`).join('')}</dl>`
      : '<p class="ck-sub" style="margin-top:14px">Nog geen antwoorden.</p>';
    if (r.verbeter) h += `<h4 style="margin:16px 0 6px;font-size:13px">Wat kunnen we beter doen?</h4><div class="blok">${esc(r.verbeter)}</div>`;
    h += `<div style="display:flex;flex-wrap:wrap;gap:8px;margin-top:14px">`;
    if (r.signaal) {
      h += `<a class="btn btn-ghost btn-sm" style="text-decoration:none" href="${esc(links.lms || '')}/dossier/${encodeURIComponent(r.student_id)}/" target="_blank" rel="noopener" title="Begeleidingssignaal (${esc(r.signaal.zwaarte || '')}, ${esc(r.signaal.status || '')}) — bij de hoofdmentor">Signaal: ${esc(r.signaal.zwaarte || '')} · dossier in het LMS ↗</a>`;
    }
    if (r.kaart) h += knop('Daves kaart in Automation →', `window.__ckNaarAutomation()`, { titel: 'Kaart ' + (r.kaart.status || '') });
    if (!r.signaal && !r.kaart && r.status === 'verstuurd') h += '<span class="ck-sub">Geen begeleidingssignaal en geen automation-kaart.</span>';
    h += `</div>`;
    if (r.signaal_redenen && r.signaal_redenen.length) h += `<p class="ck-sub" style="margin-top:8px">Waarom een signaal: ${esc(r.signaal_redenen.join(' · '))}.</p>`;
    return venster(r.naam, sub, h, 'window.__ckDetailSluit()');
  }

  function runVenster() {
    const r = st.run;
    if (!r) return '';
    const sluit = 'window.__ckRunSluit()';
    if (r.laden) return venster('Run — activeer in het LMS', '', '<p class="ck-sub">De doelgroep wordt nu uitgerekend…</p>', sluit);
    if (r.fout && !r.samenvatting) return venster('Run — activeer in het LMS', '', `<div class="waarschuw">${esc(r.fout)}</div>`, sluit);
    const s = r.samenvatting;
    const t = r.lms_tekst || {};
    const ok = r.getypt === 'ACTIVEER';
    let h = `<div class="waarschuw"><b>Dit zet de check-in live voor ${esc(s.totaal)} studenten.</b> Zij krijgen bij hun volgende bezoek aan het LMS het VERPLICHTE check-in-scherm: niet weg te klikken, het leerplatform blijft dicht tot de check-in verstuurd is (uitloggen kan). Er gaat GEEN mail of WhatsApp uit. Nieuwe studenten worden later niet stil toegevoegd.</div>`;
    h += `<h4 style="margin:0 0 6px;font-size:13px">Doelgroep</h4><p class="ck-sub" style="margin:0 0 8px">Studenten met een login, einddatum vandaag of later, product mentorship of membership. Uitgesloten: wie een onboarding in het CRM heeft die nog loopt, in de laatste 30 dagen gestart is of de nieuwe onboarding in de laatste 30 dagen invulde, en de testaccounts. Een oud dossier dat nu met de hand afgerond wordt, krijgt de check-in wél.</p>`;
    if (s.waarschuwing) h += `<div class="waarschuw">${esc(s.waarschuwing)}</div>`;
    h += `<dl><dt>Ontvangers</dt><dd>${esc(s.totaal)}</dd><dt>Mentorship</dt><dd>${esc(s.per_product.mentorship || 0)}</dd><dt>Membership</dt><dd>${esc(s.per_product.membership || 0)}</dd></dl>`;
    h += `<details style="margin-top:8px"><summary style="cursor:pointer">Per mentor (${s.per_mentor.length})</summary><dl style="margin-top:6px">${s.per_mentor.map((m) => `<dt>${esc(m.naam)}</dt><dd>${esc(m.aantal)}</dd>`).join('')}</dl></details>`;
    // De uitsluitredenen apart geteld (28 okt 2026) — o.a. "Nieuwe onboarding in de laatste 30 dagen ingevuld".
    const perReden = Object.entries(s.uitgesloten_per_reden || {});
    if (perReden.length) {
      const label = (k) => (s.uitgesloten.find((u) => u.reden === k) || {}).reden_label || k;
      h += `<dl style="margin-top:6px" data-ck-redenen>${perReden.map(([k, n]) => `<dt>${esc(label(k))}</dt><dd>${esc(n)}</dd>`).join('')}</dl>`;
    }
    h += `<details style="margin-top:6px"><summary style="cursor:pointer">Uitgesloten (${s.uitgesloten.length})</summary><dl style="margin-top:6px">${s.uitgesloten.map((u) => `<dt>${esc(u.naam)}</dt><dd>${esc(u.reden_label)}</dd>`).join('') || '<dt>—</dt><dd></dd>'}</dl></details>`;
    if (t.popup) {
      h += `<h4 style="margin:16px 0 6px;font-size:13px">Wat de student ziet — verplicht scherm (tot verstuurd)</h4><div class="blok"><span class="ck-sub">${esc(t.popup.eyebrow)}</span>\n<b>${esc(t.popup.titel)}</b>\n${esc(t.popup.tekst)}\n${esc(t.popup.code || '')}\n[${esc(t.popup.knoppen.join('] [ '))}]\n${esc(t.popup.hulp || '')}</div>`;
      if (t.popup.verplicht) h += `<p class="ck-sub" style="margin:6px 0 0">${esc(t.popup.verplicht)}</p>`;
    }
    if (r.fout) h += `<div class="waarschuw">${esc(r.fout)}</div>`;
    h += `<label for="ckTyp" style="display:block;margin:14px 0 6px;font-weight:600">Typ ACTIVEER om te bevestigen</label>
      <input id="ckTyp" class="typ" autocomplete="off" spellcheck="false" value="${esc(r.getypt || '')}" oninput="window.__ckTyp(this.value)">
      <div style="display:flex;justify-content:flex-end;gap:8px;margin-top:12px">${knop('Annuleren', sluit)}
      <button type="button" id="ckActiveer" class="btn btn-primary btn-sm" ${ok && !r.bezig ? '' : 'disabled'} onclick="window.__ckRunBevestig()">${r.bezig ? 'Bezig…' : 'Activeer in het LMS'}</button></div>`;
    return venster('Run — activeer in het LMS', esc(st.data.campagne.naam), h, sluit);
  }

  // ── Views ─────────────────────────────────────────────────────────────────
  function geraamte(inhoud) {
    stijl();
    if (!st.data && !st.laden && !st.fout) queueMicrotask(laad);
    let h = `<div class="pad ck"><div style="display:flex;align-items:center;justify-content:space-between;gap:10px;margin-bottom:12px;flex-wrap:wrap">
      <div><div style="font-size:18px;font-weight:700">Studentencheck-in</div><div class="ck-sub">Jouw DFO-check-in voor bestaande studenten: LMS-pop-up + balk met een persoonlijke code → deforexopleiding.nl/checkin.</div></div>
      ${knop(st.laden ? 'Laden…' : 'Vernieuwen', 'window.__ckVernieuw()')}</div>`;
    if (st.fout) return h + `<div class="card"><div class="card-body" style="color:var(--rose)">${esc(st.fout)} ${knop('Opnieuw', 'window.__ckVernieuw()')}</div></div></div>`;
    if (!st.data) return h + '<div class="ck-sub">Laden…</div></div>';
    if (!st.data.campagne) return h + '<div class="card"><div class="card-body ck-sub">Er is nog geen campagne. Draai de migratie hlms_checkin.sql in dfo-lms.</div></div></div>';
    for (const m of st.data.meldingen || []) h += `<div class="card" style="margin-bottom:10px"><div class="card-body" style="color:var(--amber)">${esc(m)}</div></div>`;
    h += campagneKaart(st.data);
    h += inhoud();
    return h + '</div>' + detailVenster() + runVenster();
  }

  function overzicht() {
    return geraamte(() => kpiStrip(st.data.kpi || {}) + filters(st.data) + tabel(rijen()) + lijnKaart());
  }

  // ── DE LIJN ONBOARDING ↔ CHECK-IN (28 okt 2026) ───────────────────────────
  // Elke actieve student zit in de onboarding OF in de check-in, nooit in
  // beide. Op vraag gemeten op de echte data (GET ?lijn=1); "geen van beide"
  // staat er met naam en reden.
  function lijnKaart() {
    const l = st.lijn;
    let h = `<div class="card" style="margin-top:12px" data-testid="ck-lijn"><div class="card-head"><div class="card-title">De lijn onboarding ↔ check-in</div>`
      + `<button type="button" class="btn btn-ghost btn-sm" onclick="window.__ckLijn()" ${l && l.laden ? 'disabled' : ''}>${l && l.laden ? 'Bezig…' : (l && l.data ? 'Opnieuw meten' : 'Meten')}</button></div>`;
    if (!l || (!l.data && !l.fout)) return h + `<div class="card-body ck-sub">Elke actieve student (einddatum vandaag of later) hoort in precies één van beide: de onboarding (loopt nog, of begon / werd ingevuld in de laatste 30 dagen) of de check-in.</div></div>`;
    if (l.fout) return h + `<div class="card-body" style="color:var(--rose)">${esc(l.fout)}</div></div>`;
    const d = l.data;
    const per = (o) => Object.entries(o || {}).map(([k, n]) => `${esc(k.replace(/_/g, ' '))}: ${n}`).join(' · ');
    h += `<div class="card-body"><div class="ck-kpi" style="margin-bottom:10px">
      <div class="ck-tegel"><span>Onboarding</span><b>${d.onboarding}</b><i>${per(d.onboarding_per_reden)}</i></div>
      <div class="ck-tegel"><span>Check-in</span><b>${d.checkin}</b><i>krijgen de check-in bij Run</i></div>
      <div class="ck-tegel"><span>Geen van beide</span><b>${d.geen}</b><i>${per(d.geen_per_reden) || 'niemand'}</i></div>
      <div class="ck-tegel"><span>In beide</span><b style="color:${d.dubbel ? 'var(--rose)' : 'var(--emerald)'}">${d.dubbel}</b><i>hoort altijd 0 te zijn</i></div></div>`;
    if (d.geen_lijst && d.geen_lijst.length) {
      h += `<table class="ck-tbl"><thead><tr><th>Geen van beide</th><th>E-mail</th><th>Product</th><th>Waarom</th></tr></thead><tbody>`
        + d.geen_lijst.map((g) => `<tr><td><b>${esc(g.naam)}</b></td><td>${esc(g.email || '—')}</td><td>${esc(g.product || '—')}</td><td>${esc(g.reden_label)}</td></tr>`).join('') + `</tbody></table>`;
    }
    if (!d.portal_gelezen) h += `<div class="ck-sub" style="margin-top:6px">Let op: portal_gestart_op bestaat nog niet (migratie 2026-10-28-onboarding-portal-gestart.sql).</div>`;
    return h + `</div></div>`;
  }
  window.__ckLijn = async () => {
    st.lijn = { laden: true, data: st.lijn && st.lijn.data, fout: null }; rerender();
    try {
      const j = await window.KV.authedJson(API + '?lijn=1');
      st.lijn = { laden: false, data: j.lijn, fout: null };
    } catch (e) {
      st.lijn = { laden: false, data: null, fout: foutTekst(e, 'De lijn kon niet gemeten worden.') };
    }
    rerender();
  };

  function payoutsView() {
    return geraamte(() => {
      const lijst = st.data.payouts || [];
      if (!lijst.length) return '<div class="card"><div class="card-body ck-sub">Nog niemand die een payout kreeg én hem (zonder naam) wil laten delen.</div></div>';
      return `<div class="card"><div class="card-head"><div class="card-title">Payouts om te delen (${lijst.length})</div></div><div class="tbl-wrap"><table class="ck-tbl"><thead><tr><th>Naam</th><th>E-mail</th><th>Product</th><th>Mentor</th><th>Payout</th><th>Verstuurd op</th></tr></thead>
        <tbody>${lijst.map((p) => `<tr onclick="window.__ckDetail('${esc(p.id)}')"><td><b>${esc(p.naam)}</b></td><td>${esc(p.email || '—')}</td><td>${esc(PRODUCT[p.product] || p.product || '—')}</td><td>${esc(p.mentor || '—')}</td><td>${esc(p.payout_label)}</td><td>${esc(moment(p.verstuurd_op))}</td></tr>`).join('')}</tbody></table></div>
        <div class="card-body ck-sub">Toestemming = delen zonder naam (voor de resultatenmuur). Vraag het bedrag en het bewijs zelf op.</div></div>`;
    });
  }

  function perMentorView() {
    return geraamte(() => {
      const lijst = st.data.per_mentor || [];
      if (!lijst.length) return '<div class="card"><div class="card-body ck-sub">Nog geen toewijzingen.</div></div>';
      return `<div class="card"><div class="card-head"><div class="card-title">Per mentor</div></div><div class="tbl-wrap"><table class="ck-tbl"><thead><tr><th>Mentor</th><th class="r">Toegewezen</th><th class="r">Verstuurd</th><th class="r">Gem. NPS</th><th class="r">Gem. mentorscore</th></tr></thead>
        <tbody>${lijst.map((m) => `<tr onclick="window.__ckMentor('${esc(m.mentor_id || '—')}')"><td><b>${esc(m.mentor)}</b></td><td class="r">${m.toegewezen}</td><td class="r">${m.verstuurd}</td><td class="r">${getal(m.nps_gemiddeld)}</td><td class="r">${m.mentor_score_gemiddeld == null ? '—' : getal(m.mentor_score_gemiddeld) + ' / 5'}</td></tr>`).join('')}</tbody></table></div>
        <div class="card-body ck-sub">Alleen verstuurde check-ins tellen mee; testtoewijzingen niet. Klik een mentor om zijn studenten te filteren.</div></div>`;
    });
  }

  // ── Handlers ──────────────────────────────────────────────────────────────
  window.__ckVernieuw = () => { st.fout = null; laad(); };
  window.__ckF = (k, v) => { st.f[k] = v; rerender(); };
  window.__ckKpi = (code) => { st.f.kpi = st.f.kpi === code ? '' : code; rerender(); };
  window.__ckWis = () => { st.f = { mentor: '', status: '', nps: '', contact: '', automation: '', fase: '', kpi: '' }; rerender(); };
  window.__ckTestRijen = (aan) => { st.toonTest = !!aan; rerender(); };
  window.__ckDetail = (id) => { st.detail = id; rerender(); };
  window.__ckDetailSluit = () => { st.detail = null; rerender(); };
  window.__ckMentor = (id) => { st.f = { mentor: id, status: '', nps: '', contact: '', automation: '', fase: '', kpi: '' }; if (window.DFO.goTab) window.DFO.goTab('Overzicht'); else rerender(); };
  window.__ckNaarAutomation = () => { st.detail = null; if (window.DFO.goMod) window.DFO.goMod('automation'); else rerender(); };

  window.__ckCsv = async () => {
    try {
      const r = await window.KV.authedFetch(API + '?csv=1');
      if (!r.ok) throw new Error('HTTP ' + r.status);
      const url = URL.createObjectURL(await r.blob());
      const a = document.createElement('a');
      a.href = url; a.download = 'checkin-' + ((st.data && st.data.campagne && st.data.campagne.slug) || 'export') + '.csv';
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 2000);
    } catch (e) { toast('Export mislukt.'); }
  };

  window.__ckOptie = async (k, waarde) => {
    try {
      const j = await actie({ actie: 'opties', opties: { [k]: !!waarde } }, 'opties');
      toast(st.data.campagne.status === 'live' || st.data.campagne.status === 'gepauzeerd'
        ? 'Opgeslagen — nieuwe inhoudsversie ' + j.inhoud_versie + '. Wie al begon, houdt zijn versie.' : 'Opgeslagen.');
    } catch (e) { toast(foutTekst(e, 'Opslaan mislukt.')); }
    laad();
  };

  window.__ckTest = async () => {
    if (!window.confirm('Testtoewijzingen aanmaken voor de testaccounts (Maxims eigen studentlogin)?\n\nDe campagne gaat naar "test": ALLEEN die accounts zien het verplichte check-in-scherm.')) return;
    try {
      const j = await actie({ actie: 'test' }, 'test');
      toast('Testtoewijzing klaar voor ' + (j.testaccounts || []).join(', ') + (j.zonder_studentrij && j.zonder_studentrij.length ? ' (zonder studentrij: ' + j.zonder_studentrij.join(', ') + ')' : '') + '.');
    } catch (e) { toast(foutTekst(e, 'Testtoewijzingen mislukt.')); }
    laad();
  };

  window.__ckPauzeer = async () => {
    if (!window.confirm('Pauzeren? Pop-up en balk verdwijnen meteen voor iedereen; de antwoorden blijven bewaard.')) return;
    try { await actie({ actie: 'pauzeer' }, 'pauzeer'); toast('Gepauzeerd.'); } catch (e) { toast(foutTekst(e, 'Pauzeren mislukt.')); }
    laad();
  };
  window.__ckHervat = async () => {
    try { await actie({ actie: 'hervat' }, 'hervat'); toast('Hervat.'); } catch (e) { toast(foutTekst(e, 'Hervatten mislukt.')); }
    laad();
  };

  window.__ckRunOpen = async () => {
    st.run = { laden: true, getypt: '' };
    rerender();
    try {
      const j = await window.KV.authedJson(API, { method: 'POST', body: JSON.stringify({ campagne_id: st.data.campagne.id, actie: 'doelgroep' }) });
      if (!st.run) return;
      st.run = { laden: false, samenvatting: j.samenvatting, lms_tekst: j.lms_tekst, getypt: '' };
    } catch (e) {
      if (!st.run) return;
      st.run = { laden: false, fout: foutTekst(e, 'De doelgroep kon niet berekend worden.'), getypt: '' };
    }
    rerender();
  };
  window.__ckRunSluit = () => { if (st.run && st.run.bezig) return; st.run = null; rerender(); };
  // Alleen de knop bijwerken: het tekstveld houdt zijn focus.
  window.__ckTyp = (v) => {
    if (!st.run) return;
    st.run.getypt = v;
    const b = document.getElementById('ckActiveer');
    if (b) b.disabled = v !== 'ACTIVEER' || !!st.run.bezig;
  };
  window.__ckRunBevestig = async () => {
    const r = st.run;
    if (!r || r.getypt !== 'ACTIVEER' || r.bezig) return;
    r.bezig = true; r.fout = null; rerender();
    try {
      const j = await window.KV.authedJson(API, { method: 'POST', body: JSON.stringify({ campagne_id: st.data.campagne.id, actie: 'run', bevestiging: 'ACTIVEER' }) });
      st.run = null;
      toast(j.al_live ? 'Was al geactiveerd — er is niets veranderd.' : 'Live: ' + j.aangemaakt + ' toewijzingen aangemaakt. Er is geen mail of WhatsApp verstuurd.');
    } catch (e) {
      if (st.run) { st.run.bezig = false; st.run.fout = foutTekst(e, 'Run mislukt. Er is niets geactiveerd.'); }
    }
    rerender();
    laad();
  };

  window.DFO.VIEWS['checkin/Overzicht'] = overzicht;
  window.DFO.VIEWS['checkin/Payouts'] = payoutsView;
  window.DFO.VIEWS['checkin/Per mentor'] = perMentorView;
  if (typeof window.KV_V2_ADD === 'function') window.KV_V2_ADD('checkin');
  else (window.KV_V2_PENDING = window.KV_V2_PENDING || []).push('checkin');
})();
