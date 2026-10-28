// modules/klanten-v2/views/checkin-mails-v2.js
//
// STUDENTENCHECK-IN › MAILS (Maxim, 28 okt 2026). De pop-up en de balk ziet
// alleen wie inlogt; daarom ook een mail met de code en een knop naar
// www.deforexopleiding.nl/checkin — bij de Run (de uitnodiging) en na 5 en 10
// dagen als de student nog niet verstuurde. Niet verstuurd 14 dagen na de Run
// = "Check-in genegeerd" (zichtbaar in het LMS-overzicht Betrokkenheid).
//
// Er gaat pas iets weg als: de campagne LIVE staat (de Run die Maxim zelf
// indrukt) · de schakelaar hier AAN staat · die tekst goedgekeurd is.
// Data + acties: /api/checkin-mails. Teksten: gedeeld (mail-teksten-v2.js).

(function () {
  'use strict';
  if (!window.DFO || !window.KVMailTeksten) return;
  window.DFO.VIEWS = window.DFO.VIEWS || {};
  const { esc, moment } = window.KVMailTeksten;
  const API = '/api/checkin-mails';
  const st = window.__cmState = window.__cmState || { laden: false, data: null, fout: null, seq: 0 };
  const rerender = () => { if (typeof window.DFO.render === 'function') window.DFO.render(); };
  const SOORT = { uitnodiging: 'Uitnodiging', herinnering_5: 'Herinnering 5 d', herinnering_10: 'Herinnering 10 d' };
  const WAAROM = {
    verstuurd: 'Check-in al verstuurd', wacht_5_dagen: 'Wacht op dag 5', wacht_10_dagen: 'Wacht op dag 10', alles_gehad: 'Alle mails gehad',
    genegeerd: 'Genegeerd (te laat voor de uitnodiging)', geen_email: 'Geen e-mailadres', campagne_niet_live: 'Campagne niet live',
  };

  async function laad() {
    if (st.laden) return;
    st.laden = true; st.fout = null;
    const seq = ++st.seq;
    rerender();
    try {
      const j = await window.KV.authedJson(API);
      if (seq === st.seq) st.data = j;
    } catch (e) {
      if (seq === st.seq) st.fout = e && e.status === 403 ? 'Geen toegang (recht checkin.view).' : ((e && e.body && e.body.error) || (e && e.message) || 'De mails konden niet geladen worden.');
    } finally {
      if (seq === st.seq) { st.laden = false; rerender(); }
    }
  }
  window.__cmLaad = () => laad();

  const mt = window.KVMailTeksten.maak({
    api: API, sleutel: 'cm',
    codeUitleg: 'Een regel <span class="mono">{{checkin.code}}</span> = de persoonlijke code groot in een kader; een regel <span class="mono">[knop: …]</span> = een knop naar www.deforexopleiding.nl/checkin. Ook: <span class="mono">{{student.voornaam}}</span>.',
    data: () => st.data,
    zetInstellingen: (i) => { st.data.instellingen = i; },
    opnieuw: () => laad(),
  });

  function stand(d) {
    const p = d.plan || {};
    const live = d.campagnes || [];
    let h = `<div class="card" style="margin-bottom:12px"><div class="card-body" style="font-size:12.5px;line-height:1.6">`;
    h += live.length
      ? `<div><b>Live:</b> ${live.map((c) => `${esc(c.naam || c.slug)} (sinds ${esc(moment(c.live_op))})`).join(', ')} · ${p.toewijzingen || 0} toewijzingen</div>`
      : `<div><b>Geen live campagne.</b> Er vertrekt niets tot Maxim in het Overzicht op Run drukt.</div>`;
    h += `<div><b>Nu aan de beurt:</b> ${Object.entries(p.per_soort || {}).map(([k, n]) => esc(SOORT[k] || k) + ': ' + n).join(' · ') || 'niemand'}${d.instellingen.aan ? '' : ' — de schakelaar staat uit'}</div>`;
    h += `<div><b>Al verstuurd:</b> ${Object.entries(p.verstuurd || {}).map(([k, n]) => esc(SOORT[k] || k) + ': ' + n).join(' · ') || 'nog niets'}</div>`;
    h += `<div style="color:var(--text-3)">${Object.entries(p.overgeslagen || {}).map(([k, n]) => esc(WAAROM[k] || k) + ': ' + n).join(' · ')}</div>`;
    h += `<div><b>Check-in genegeerd</b> (niet verstuurd ${esc(d.genegeerd_na_dagen)} dagen na de Run): ${esc(d.genegeerd || 0)}</div>`;
    return h + `</div></div>`;
  }

  function view() {
    if (!st.data && !st.laden && !st.fout) laad();
    if (st.fout) return `<div class="card"><div class="card-body" style="color:var(--rose)">${esc(st.fout)} <button class="btn btn-ghost btn-sm" onclick="window.__cmLaad()">Opnieuw</button></div></div>`;
    if (!st.data) return `<div class="card"><div class="card-body" style="color:var(--text-3)">Laden…</div></div>`;
    const d = st.data;
    const w = [];
    if (!d.logboek) w.push({ ernst: 'rood', html: 'Het logboek ontbreekt: draai eerst <span class="mono">docs/sql-migrations/2026-10-28-checkin-mails.sql</span>. Zonder logboek vertrekt er niets.' });
    return `<div data-testid="checkin-mails">${mt.schakelaar(d, {
      titel: 'Check-in per mail',
      uitleg: 'Bij de Run een uitnodiging met de code, na 5 en na 10 dagen een herinnering voor wie nog niet verstuurde. Alleen in een LIVE campagne. Elke 10 minuten, hoogstens 40 per keer, vanaf info@.',
      bevestig: 'Check-in-mails AANZETTEN? In een live campagne vertrekken de goedgekeurde mails dan automatisch naar de studenten.',
      waarschuwingen: w,
    })}${stand(d)}${mt.teksten(d)}</div>`;
  }

  window.DFO.VIEWS['checkin/Mails'] = view;
})();
